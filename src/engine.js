// CarGPT Intent Engine: users, sessions and one buyer turn.
//
//   message → extract (OpenAI, rules fallback) → merge into the user's profile (shared across
//   sessions) → rule answers (RC transfer, on-road) → fallback-ladder search → promise guard →
//   escalation gate → grounded reply → persist everything.
import { Store, newId, newToken, serial } from "./store.js";
import { extract } from "./extract.js";
import { newProfile, merge, describe, lakh } from "./profile.js";
import { search } from "./search.js";
import { transferAnswer, onRoadAnswer } from "./rules.js";
import { commitmentsFor, escalationDecision, contextPacket } from "./policy.js";
import { writeReply } from "./reply.js";
import { inventory, findCity } from "./inventory.js";
import { config } from "./config.js";

export class AppError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const clean = (s, max) => String(s ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max);
const now = () => new Date().toISOString();

export class Engine {
  constructor({ store = new Store(), fetchImpl } = {}) {
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.hits = new Map(); // userId → timestamps, for the per-user rate limit
  }

  // ---------- users ----------
  createUser({ name, homeCity, phone }) {
    name = clean(name, 60);
    if (!name) throw new AppError(400, "name_required", "Name is required");
    const city = findCity(homeCity);
    if (!city) throw new AppError(400, "unknown_city", `Unknown city. Cities with listings: ${inventory().cities.map((c) => c.name).join(", ")}`);
    const user = { id: newId("usr"), name, phone: phone ? clean(phone, 15).replace(/\d(?=\d{4})/g, "•") : null, token: newToken(), createdAt: now(), profile: newProfile(city.name) };
    this.store.put("users", user.id, user);
    this.store.append("events", user.id, { at: now(), type: "signup", detail: `Signed up in ${city.name}` });
    return user;
  }

  user(userId) {
    const u = this.store.get("users", userId);
    if (!u) throw new AppError(404, "user_not_found", "User not found");
    return u;
  }

  publicUser(u) {
    const { token, ...rest } = u;
    void token;
    return { ...rest, summary: describe(u.profile), sessions: this.sessionsOf(u.id).length };
  }

  // ---------- sessions ----------
  sessionsOf(userId) {
    return this.store.list("sessions", (s) => s.userId === userId).sort((a, b) => (b.lastAt || b.createdAt).localeCompare(a.lastAt || a.createdAt));
  }

  createSession(userId, { channel = "app" } = {}) {
    const u = this.user(userId);
    const prior = this.sessionsOf(userId).length;
    const s = { id: newId("ses"), userId, channel: clean(channel, 20), createdAt: now(), lastAt: now(), title: "New chat", turns: 0 };
    this.store.put("sessions", s.id, s);
    // A returning buyer is greeted with what CarGPT remembers, not a blank "how can I help".
    const p = u.profile;
    const greeting = prior && (p.brands.length || p.budgetMax || p.excludeBodies.length)
      ? `Welcome back, ${u.name.split(" ")[0]}. Still looking for ${describe(p)}? I can pick up from there, or say “start over”.`
      : `Hi ${u.name.split(" ")[0]}. Tell me what you're looking for: brand, budget, body type. I search every seller on Cars24 in ${p.homeCity} and nearby.`;
    this.store.append("messages", s.id, { id: newId("msg"), role: "assistant", text: greeting, at: now(), meta: { greeting: true } });
    return { session: s, greeting };
  }

  session(userId, sessionId) {
    const s = this.store.get("sessions", sessionId);
    if (!s || s.userId !== userId) throw new AppError(404, "session_not_found", "Session not found");
    return s;
  }

  messages(sessionId) { return this.store.items("messages", sessionId); }

  // ---------- one turn ----------
  rateLimit(userId) {
    const t = Date.now(), win = (this.hits.get(userId) || []).filter((x) => t - x < 60000);
    if (win.length >= config.rateLimitPerMinute) throw new AppError(429, "rate_limited", "Too many messages; wait a few seconds");
    win.push(t);
    this.hits.set(userId, win);
  }

  async handleMessage(userId, sessionId, rawText, { clientMsgId } = {}) {
    const u = this.user(userId);
    this.session(userId, sessionId);
    const text = clean(rawText, config.maxMessageChars);
    if (!text) throw new AppError(400, "empty_message", "Message is empty");
    // Retried request (double tap, flaky network): return the stored turn instead of running it twice.
    // Checked again inside the per-session queue so two identical requests in flight run once.
    const replay = () => {
      if (!clientMsgId) return null;
      const msgs = this.messages(sessionId);
      const i = msgs.findIndex((m) => m.role === "user" && m.clientMsgId === clientMsgId);
      return i >= 0 && msgs[i + 1] ? { ...msgs[i + 1].meta.turn, replayed: true } : null;
    };
    const done = replay();
    if (done) return done;
    this.rateLimit(userId);
    return serial(sessionId, () => replay() || this.#turn(u, sessionId, text, clientMsgId));
  }

  async #turn(u, sessionId, text, clientMsgId) {
    const started = Date.now();
    const p = u.profile;
    const recent = this.messages(sessionId).slice(-6);
    const ex = await extract(text, { profile: p, recent, store: this.store, fetchImpl: this.fetchImpl });
    const d = ex.delta;
    // A car named in a question ("on-road cost of the GLC") is not a new search filter.
    if (d.intent === "question" && (d.onRoad || d.transfer)) { d.models = []; d.brands = d.brands.filter((b) => p.brands.includes(b)); }
    const changes = merge(p, d);
    const commitments = commitmentsFor(changes);
    // Repeating a preference gets a confirmation that it is already enforced, not silence.
    if (d.callConsent === false && !changes.some((c) => c.field === "callConsent")) commitments.push({ promise: "No calls from Cars24 (already on file)", enforcedBy: "Dialer suppression flag stays on", check: "dialer" });
    for (const b of d.excludeBodies) if (!changes.some((c) => c.field === "excludeBodies" && c.value === b)) commitments.push({ promise: `No ${b}s (already on file)`, enforcedBy: "Shared intent profile filter stays on", check: "feed" });

    // Rule answers
    const answers = [];
    let unresolved = null;
    if (d.transfer) {
      const a = transferAnswer(d.transfer, p.homeCity);
      answers.push({ type: "transfer", ...a });
      if (!a.resolved) unresolved = text;
    }
    if (d.onRoad) {
      const car = this.#resolveCar(p, d.onRoad);
      const a = car ? onRoadAnswer(car, p.homeCity) : { resolved: false, text: `I couldn't find ${d.onRoad.model ? `a ${d.onRoad.model}` : "that car"} in current listings near ${p.homeCity}. Which car do you mean?` };
      answers.push({ type: "onroad", ...a });
      if (!a.resolved) unresolved = text;
    }

    // Search when the message is about finding cars, or changed what they're looking for.
    const filterChanged = changes.some((c) => !["callConsent", "homeCity"].includes(c.field));
    const pureQuestion = (d.transfer || d.onRoad) && !d.brands.length && !d.budgetMax && !d.models.length;
    const wantsCars = ["search", "preference", "complaint", "reset"].includes(d.intent) || filterChanged || d.useCurrentLocation;
    const result = wantsCars && !pureQuestion && (p.brands.length || p.budgetMax || p.includeBodies.length || p.models.length || d.intent === "search") ? search(p) : null;
    if (result) p.lastShown = result.shown.slice(0, 10).map((c) => ({ id: c.id, title: `${c.year} ${c.make} ${c.model}`, model: c.model }));
    let needs = null;
    if (d.useCurrentLocation) needs = `Using your city on file: ${p.homeCity}.`;

    // Escalation
    const tickets = this.store.list("tickets", (t) => t.userId === u.id && t.status === "open");
    if (d.callConsent === false) for (const t of tickets.filter((t) => t.callRequested)) this.store.update("tickets", t.id, (x) => { x.callRequested = false; x.updates.push({ at: now(), text: "Call cancelled: buyer said no calls" }); });
    const esc = escalationDecision(p, { unresolved, openTicket: tickets[0], askedNow: d.callConsent === true });
    let ticket = null;
    if (esc.escalate) ticket = this.#raiseTicket(u, sessionId, { call: esc.call, question: unresolved || (d.callConsent ? text : null) });
    else if (unresolved && tickets[0]) this.store.update("tickets", tickets[0].id, (x) => { x.questions.push(unresolved); x.updates.push({ at: now(), text: `Added question: ${unresolved}` }); });

    const turn = {
      text, profile: p, profileSummary: describe(p), changes, commitments, answers, search: result, needs,
      escalation: { ...esc, ticketId: ticket?.id || null }, extraction: { source: ex.source, error: ex.error || null, ms: ex.ms || null, delta: d },
    };
    const reply = await writeReply(turn, { store: this.store, fetchImpl: this.fetchImpl });

    const out = {
      reply: reply.text, replySource: reply.source, replyRejected: reply.rejected || null,
      extraction: turn.extraction, changes, commitments, answers,
      search: result && { citiesSearched: result.citiesSearched, steps: result.steps.map((s) => ({ key: s.key, label: s.label, total: s.total, cars: s.cars.map(slim) })), beyond: result.beyond, withheld: result.withheld, matched: result.matched, home: result.home },
      escalation: turn.escalation, packet: ticket?.packet || null,
      profile: structuredClone(p), summary: describe(p), ms: Date.now() - started,
    };

    this.store.update("users", u.id, (x) => { x.profile = p; });
    this.store.append("messages", sessionId, { id: newId("msg"), role: "user", text, at: now(), clientMsgId: clientMsgId || null });
    this.store.append("messages", sessionId, { id: newId("msg"), role: "assistant", text: reply.text, at: now(), meta: { turn: out } });
    this.store.update("sessions", sessionId, (s) => { s.lastAt = now(); s.turns += 1; if (s.title === "New chat") s.title = text.slice(0, 60); });
    if (changes.length) this.store.append("events", u.id, { at: now(), type: "profile", sessionId, text, changes: changes.map((c) => c.label), source: ex.source });
    return out;
  }

  #resolveCar(p, q) {
    const shown = p.lastShown || [];
    let id = null;
    if (q.listingRef && shown[q.listingRef - 1]) id = shown[q.listingRef - 1].id;
    if (!id && q.model) id = shown.find((c) => c.model?.toLowerCase() === q.model.toLowerCase())?.id;
    if (!id && !q.model && shown[0]) id = shown[0].id;
    if (id) return inventory().cars.find((c) => c.id === id) || null;
    if (!q.model) return null;
    const home = findCity(p.homeCity);
    const matches = inventory().cars.filter((c) => c.model?.toLowerCase() === q.model.toLowerCase());
    return matches.find((c) => home && c.citySlug === home.slug) || matches[0] || null;
  }

  #raiseTicket(u, sessionId, { call, question }) {
    const open = this.store.list("tickets", (t) => t.userId === u.id && t.status === "open")[0];
    const questions = [...new Set([...(open?.questions || []), ...(question ? [question] : [])])];
    const shortlist = (u.profile.lastShown || []).map((s) => inventory().cars.find((c) => c.id === s.id)).filter(Boolean);
    const packet = contextPacket(u, { openQuestions: questions, shortlist, sessionCount: this.sessionsOf(u.id).length });
    if (open) return this.store.update("tickets", open.id, (t) => { t.callRequested = t.callRequested || call; t.questions = questions; t.packet = packet; t.updates.push({ at: now(), text: call ? "Buyer asked for a call" : `Question: ${question}` }); });
    const t = { id: newId("tkt"), userId: u.id, sessionId, status: "open", callRequested: call, questions, packet, createdAt: now(), updates: [{ at: now(), text: call ? "Buyer asked for a call" : `Async review: ${question}` }] };
    return this.store.put("tickets", t.id, t);
  }

  closeTicket(ticketId, note) {
    const t = this.store.update("tickets", ticketId, (x) => { x.status = "closed"; x.updates.push({ at: now(), text: clean(note, 300) || "Closed" }); });
    if (!t) throw new AppError(404, "ticket_not_found", "Ticket not found");
    return t;
  }
}

const slim = (c) => ({ id: c.id, title: c.title, make: c.make, model: c.model, variant: c.variant, year: c.year, priceLakh: c.priceLakh, price: lakh(c.priceLakh), km: c.km, fuel: c.fuel, transmission: c.transmission, body: c.body, city: c.city, distanceKm: c.distanceKm, reg: c.reg, owners: c.owners, seller: c.sellerLabel, url: c.url, image: c.image });
