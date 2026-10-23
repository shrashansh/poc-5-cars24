// CarGPT Intent Engine: users, sessions, tickets, and one buyer turn run by a team of agents.
//
//   message → [intent] → [memory: ledger + recency] → [answers ∥ search] → [promises: audit]
//           → [escalation] → [reply] → persist
//
// The agents live in src/agents/ and share one blackboard per turn; the coordinator schedules them
// by dependency and traces every run. This file owns identity, sessions and persistence.
import { validPoint, locate } from "./location.js";
import { Store, newId, newToken, serial } from "./store.js";
import { newProfile, describe, forget, lakh } from "./profile.js";
import { feedFor } from "./policy.js";
import { inventory, findCity } from "./inventory.js";
import { config } from "./config.js";
import { createCoordinator, IntentLedger, recencyWeights } from "./agents/index.js";

export class AppError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const clean = (s, max) => String(s ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max);
const now = () => new Date().toISOString();
const SIGNALS = ["view", "shortlist", "dismiss"];
// Old preferences the buyer hasn't repeated still count, but rank last; say so instead of guessing.
const dormantNote = (pr) => {
  const d = pr.filter((x) => x.status === "dormant").map((x) => x.label);
  return d.length ? ` (${d.join(", ")} ${d.length === 1 ? "is" : "are"} from a while back, so I'll rank ${d.length === 1 ? "it" : "them"} lower unless you bring ${d.length === 1 ? "it" : "them"} up.)` : "";
};

export class Engine {
  constructor({ store = new Store(), fetchImpl, coordinator = createCoordinator() } = {}) {
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.hits = new Map(); // userId → timestamps, for the per-user rate limit
    this.ledger = new IntentLedger(store);
    this.coordinator = coordinator;
    // What agents may touch outside the blackboard.
    this.services = { store, fetchImpl, ledger: this.ledger, sessionCount: (userId) => this.sessionsOf(userId).length };
  }

  // ---------- users ----------
  // A buyer signs up with a city, a GPS fix, or both. With only a fix, the nearest Cars24 city
  // becomes their home city (used for RTO rules); the fix itself is the search origin.
  createUser({ name, homeCity, phone, location }) {
    name = clean(name, 60);
    if (!name) throw new AppError(400, "name_required", "Name is required");
    if (location !== undefined && location !== null && !validPoint(location)) throw new AppError(400, "bad_location", "location needs numeric lat and lon");
    const fix = location ? locate(location) : null;
    const city = findCity(homeCity) || (!homeCity && fix ? findCity(fix.city) : null);
    if (!city) throw new AppError(400, "unknown_city", `Unknown city. Share your location or pick one of: ${inventory().cities.map((c) => c.name).join(", ")}`);
    const profile = newProfile(city.name);
    profile.location = fix;
    const user = { id: newId("usr"), name, phone: phone ? clean(phone, 15).replace(/\d(?=\d{4})/g, "•") : null, token: newToken(), createdAt: now(), profile };
    this.store.put("users", user.id, user);
    this.store.append("events", user.id, { at: now(), type: "signup", detail: `Signed up in ${city.name}${fix ? ` (GPS: near ${fix.city}, ~${fix.cityKm} km)` : ""}` });
    return user;
  }

  setLocation(userId, location) {
    if (!validPoint(location)) throw new AppError(400, "bad_location", "location needs numeric lat and lon");
    const u = this.user(userId);
    const fix = locate(location);
    const moved = !u.profile.location || u.profile.location.city !== fix.city;
    this.store.update("users", userId, (x) => { x.profile.location = fix; });
    if (moved) this.store.append("events", userId, { at: now(), type: "location", changes: [`Location: near ${fix.city} (~${fix.cityKm} km)`], source: "gps" });
    return { location: fix, summary: describe(u.profile) };
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
      ? `Welcome back, ${u.name.split(" ")[0]}. Still looking for ${describe(p)}? I can pick up from there, or say “start over”.${dormantNote(this.ledger.priorities(u.id, p))}`
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

  async handleMessage(userId, sessionId, rawText, { clientMsgId, location } = {}) {
    const u = this.user(userId);
    this.session(userId, sessionId);
    if (location) this.setLocation(userId, location); // the app sends its latest GPS fix with each message
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
    const ctx = this.coordinator.context({
      user: u, profile: p, sessionId, text, recent: this.messages(sessionId).slice(-6),
      prioritiesBefore: this.ledger.priorities(u.id, p),
      services: this.services,
      // Blackboard slots the agents fill in.
      delta: null, extraction: null, changes: [], priorities: [], shownBefore: [], answers: [], unresolved: null,
      search: null, needs: null, commitments: [], violations: [], cancelledCalls: [], escalation: null, ticket: null, reply: null,
    });
    await this.coordinator.run(ctx);
    const { changes, commitments, answers, extraction, reply } = ctx;
    const result = ctx.search;
    const escalation = ctx.escalation || { escalate: false, reason: "Escalation agent did not run" };

    const out = {
      reply: reply.text, replySource: reply.source, replyRejected: reply.rejected || null,
      extraction, changes, commitments, answers,
      search: result && { citiesSearched: result.citiesSearched, steps: result.steps.map((s) => ({ key: s.key, label: s.label, total: s.total, cars: s.cars.map(slim) })), beyond: result.beyond, withheld: result.withheld, matched: result.matched, home: result.home, origin: result.origin, radiusKm: result.radiusKm, radiusMode: result.radiusMode },
      escalation, packet: ctx.ticket?.packet || null,
      priorities: ctx.priorities, violations: ctx.violations,
      agents: ctx.trace, events: ctx.events.map(({ topic, from }) => ({ topic, from })),
      profile: structuredClone(p), summary: describe(p), ms: Date.now() - started,
    };

    this.store.update("users", u.id, (x) => { x.profile = p; });
    this.store.append("messages", sessionId, { id: newId("msg"), role: "user", text, at: now(), clientMsgId: clientMsgId || null });
    this.store.append("messages", sessionId, { id: newId("msg"), role: "assistant", text: reply.text, at: now(), meta: { turn: out } });
    this.store.update("sessions", sessionId, (s) => { s.lastAt = now(); s.turns += 1; if (s.title === "New chat") s.title = text.slice(0, 60); });
    if (changes.length) this.store.append("events", u.id, { at: now(), type: "profile", sessionId, text, changes: changes.map((c) => c.label), source: extraction.source });
    if (ctx.violations.length) this.store.append("events", u.id, { at: now(), type: "promise", sessionId, changes: ctx.violations.map((v) => `Pulled ${v.title}: ${v.problems.join(", ")}`), source: "promises agent" });
    return out;
  }

  // ---------- intent outside chat ----------
  // Every remembered intent, ranked newest-and-strongest first.
  priorities(userId) { const u = this.user(userId); return this.ledger.priorities(u.id, u.profile); }

  // The app's "Recommended for you" feed, ranked with the same recency weights as chat.
  feed(userId) { const u = this.user(userId); return feedFor(u.profile, 12, { weights: recencyWeights(this.ledger.priorities(u.id, u.profile)) }); }

  // App signals keep intent current between chats. "dismiss" hides a listing everywhere (a promise);
  // "view" / "shortlist" is interest in that model, recorded and ranked but never made a filter.
  recordSignal(userId, { type, carId } = {}) {
    const u = this.user(userId);
    if (!SIGNALS.includes(type)) throw new AppError(400, "bad_signal", `type must be one of ${SIGNALS.join(", ")}`);
    const car = inventory().cars.find((c) => c.id === carId);
    if (!car) throw new AppError(404, "car_not_found", "Listing not found");
    const p = u.profile;
    let label;
    if (type === "dismiss") {
      if (!p.rejectedIds.includes(car.id)) p.rejectedIds.push(car.id);
      p.lastShown = (p.lastShown || []).filter((s) => s.id !== car.id);
      this.ledger.record(u.id, [{ key: `rejectedIds:${car.id}`, field: "rejectedIds", value: car.id, op: "state" }], { source: "app" });
      label = `Hid ${car.year} ${car.make} ${car.model} (${car.city})`;
    } else {
      this.ledger.record(u.id, [{ key: `interest:${car.model}`, field: "interest", value: car.model, op: "interest" }], { source: "app" });
      label = `${type === "view" ? "Viewed" : "Shortlisted"} ${car.year} ${car.make} ${car.model}`;
    }
    p.updatedAt = now();
    this.store.update("users", u.id, (x) => { x.profile = p; });
    this.store.append("events", u.id, { at: now(), type: "signal", changes: [label], source: "app" });
    return { ok: true, label, priorities: this.ledger.priorities(u.id, p) };
  }

  // The buyer removes one remembered item from the "What CarGPT remembers" panel.
  forget(userId, field, value) {
    const u = this.user(userId);
    if (!forget(u.profile, field, value)) throw new AppError(400, "nothing_to_forget", "Nothing to remove");
    this.ledger.record(u.id, [{ key: `forget:${field}:${value ?? ""}`, field: "forget", value: `${field}${value ? `:${value}` : ""}`, op: "clear" }], { source: "buyer" });
    this.store.update("users", u.id, (x) => { x.profile = u.profile; });
    this.store.append("events", u.id, { at: now(), type: "forget", changes: [`Removed ${field}${value ? `: ${value}` : ""}`], source: "buyer" });
    return { profile: u.profile, summary: describe(u.profile), priorities: this.ledger.priorities(u.id, u.profile) };
  }

  closeTicket(ticketId, note) {
    const t = this.store.update("tickets", ticketId, (x) => { x.status = "closed"; x.updates.push({ at: now(), text: clean(note, 300) || "Closed" }); });
    if (!t) throw new AppError(404, "ticket_not_found", "Ticket not found");
    return t;
  }
}

const slim = (c) => ({ id: c.id, title: c.title, make: c.make, model: c.model, variant: c.variant, year: c.year, priceLakh: c.priceLakh, price: lakh(c.priceLakh), km: c.km, fuel: c.fuel, transmission: c.transmission, body: c.body, city: c.city, distanceKm: c.distanceKm, reg: c.reg, owners: c.owners, seller: c.sellerLabel, url: c.url, image: c.image });
