import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

process.env.OPENAI_API_KEY = "";
const { config } = await import("../src/config.js");
const { loadInventory } = await import("../src/inventory.js");
const { Store } = await import("../src/store.js");
const { Engine } = await import("../src/engine.js");
const { parse } = await import("../src/parse.js");
const { normalise } = await import("../src/intent.js");
const { feedFor, dialerCheck } = await import("../src/policy.js");
const { guard } = await import("../src/reply.js");
const { forget } = await import("../src/profile.js");
const { REPLAY } = await import("../src/replay.js");
const { createApp } = await import("../server.js");

loadInventory(new URL("./fixtures/", import.meta.url));

const memEngine = (opts = {}) => new Engine({ store: new Store(null, { persist: false }), ...opts });
async function chat(msgs, { engine = memEngine(), city = "kanpur" } = {}) {
  const u = engine.createUser({ name: "Test Buyer", homeCity: city });
  const { session } = engine.createSession(u.id);
  const outs = [];
  for (const m of msgs) outs.push(await engine.handleMessage(u.id, session.id, m));
  return { engine, user: engine.user(u.id), session, outs, last: outs.at(-1) };
}
const shown = (o) => o.search.steps.flatMap((s) => s.cars);
const withLLM = async (fetchImpl, fn) => { const k = config.openaiKey; config.openaiKey = "test-key"; try { return await fn(memEngine({ fetchImpl })); } finally { config.openaiKey = k; } };
const okLLM = (content) => async () => ({ ok: true, status: 200, json: async () => ({ model: "test", usage: {}, choices: [{ message: { content: JSON.stringify(content) } }] }) });

// ---------- understanding ----------
test("a complaint about Baleno rejects Maruti and keeps Mercedes as intent", () => {
  const d = normalise(parse("I searched for a Mercedes-Benz. Why am I seeing Maruti Baleno as a recommendation?"));
  assert.deepEqual(d.brands, ["Mercedes-Benz"]);
  assert.ok(d.rejectBrands.includes("Maruti"));
});

test("Hinglish budget, model and transmission", () => {
  const d = normalise(parse("Creta chahiye 12 lakh tak, automatic"));
  assert.deepEqual(d.models, ["Creta"]);
  assert.equal(d.budgetMax, 12);
  assert.equal(d.transmission, "Automatic");
});

test("normalise drops unknown brands, impossible budgets and unknown cities from any extractor", () => {
  const d = normalise({ brands: ["Tesla Roadster", "bmw"], budgetMax: -5, cities: ["atlantis", "lucknow"], excludeBodies: ["Spaceship", "Hatchback"] });
  assert.deepEqual(d.brands, ["BMW"]);
  assert.equal(d.budgetMax, null);
  assert.deepEqual(d.cities, ["lucknow"]);
  assert.deepEqual(d.excludeBodies, ["Hatchback"]);
});

// ---------- search ----------
test("Mercedes search returns the 3 Kanpur Mercedes first and no mass-market car", async () => {
  const { last } = await chat(["Show me Mercedes-Benz"]);
  assert.deepEqual(last.search.steps[0].cars.map((c) => c.model).sort(), ["CLA", "GLC", "GLS"]);
  assert.ok(shown(last).every((c) => ["Mercedes-Benz", "BMW", "Audi", "Jaguar", "Volvo"].includes(c.make)));
});

test("intent accumulates across messages: brand + budget + no hatchbacks", async () => {
  const { last } = await chat(["Mercedes please", "Show me BMW under 20 lakhs near Kanpur", "No hatchback pls"]);
  assert.deepEqual(last.profile.brands, ["Mercedes-Benz", "BMW"]);
  assert.equal(last.profile.budgetMax, 20);
  assert.ok(shown(last).every((c) => c.priceLakh <= 20 && c.body !== "Hatchback"));
  assert.ok(shown(last).some((c) => c.model === "X5"));
  assert.ok(!shown(last).some((c) => c.model === "X1" && c.city === "Kanpur"), "₹31.88L X1 is over budget");
});

test("without a stated radius the search widens on its own until it finds the cars (Kanpur → Lucknow)", async () => {
  const { last } = await chat(["Show me BMW under 20 lakhs"]);
  assert.equal(last.search.radiusMode, "auto");
  const near = last.search.steps.find((s) => s.key === "nearby");
  assert.ok(near.cars.some((c) => c.city === "Lucknow" && c.make === "BMW"), "Lucknow BMW found without asking for a radius");
});

test("a radius the buyer states is used exactly; stock beyond it is named, not hidden", async () => {
  const { last } = await chat(["Show me BMW under 20 lakhs within 30 km"]);
  assert.equal(last.search.radiusMode, "stated");
  assert.equal(last.search.radiusKm, 30);
  assert.ok(!last.search.steps.flatMap((s) => s.cars).some((c) => c.city === "Lucknow"));
  assert.ok(last.search.beyond.some((b) => b.city === "Lucknow"));
});

const LUCKNOW_GPS = { lat: 26.85, lon: 80.95, accuracy: 30 };

test("GPS sets where the search starts: a Kanpur buyer standing in Lucknow sees Lucknow first", async () => {
  const engine = memEngine();
  const u = engine.createUser({ name: "Traveller", homeCity: "kanpur" });
  const { session } = engine.createSession(u.id);
  const r = await engine.handleMessage(u.id, session.id, "any Audi near me?", { location: LUCKNOW_GPS });
  assert.equal(r.search.origin.source, "gps");
  assert.equal(r.search.home.name, "Lucknow");
  assert.ok(r.search.steps[0].cars.every((c) => c.city === "Lucknow" && c.make === "Audi"));
  assert.equal(r.profile.homeCity, "Kanpur", "home city (for RTO rules) does not move with GPS");
});

test("signing up with only a GPS fix picks the nearest Cars24 city as home", () => {
  const engine = memEngine();
  const u = engine.createUser({ name: "Gps Only", location: LUCKNOW_GPS });
  assert.equal(u.profile.homeCity, "Lucknow");
  assert.equal(u.profile.location.city, "Lucknow");
  assert.throws(() => engine.createUser({ name: "Bad", location: { lat: "x", lon: 1 } }), /lat and lon/);
});

test("a city named in the message anchors that turn's search", async () => {
  const { last } = await chat(["Do we have any audi in lucknow?"]);
  assert.equal(last.search.home.name, "Lucknow");
  assert.ok(last.search.steps[0].cars.some((c) => c.make === "Audi" && c.city === "Lucknow"));
});

test("a stale GPS fix (over 6 hours) falls back to the home city", async () => {
  const engine = memEngine();
  const u = engine.createUser({ name: "Old Fix", homeCity: "kanpur", location: LUCKNOW_GPS });
  u.profile.location.at = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
  const { session } = engine.createSession(u.id);
  const r = await engine.handleMessage(u.id, session.id, "Show me Audi");
  assert.equal(r.search.origin.source, "city");
  assert.equal(r.search.home.name, "Kanpur");
});

// ---------- rule answers ----------
test("same-state transfer is answered in chat, not escalated", async () => {
  const { last } = await chat(["Aren't there any Mercedes available in UP which can be transferred to Kanpur?"]);
  assert.equal(last.answers[0].kind, "same-state");
  assert.equal(last.escalation.escalate, false);
});

test("UP78 → Delhi is interstate with NOC, and does not move the buyer's home city", async () => {
  const { last } = await chat(["I am planning to buy a UP78 registered car, I live in Delhi, what's the transfer process?"]);
  assert.equal(last.answers[0].kind, "interstate");
  assert.ok(last.answers[0].steps.some((s) => s.includes("NOC")));
  assert.equal(last.profile.homeCity, "Kanpur");
});

test("on-road question finds the listed GLC and does not become a search filter", async () => {
  const { last } = await chat(["What's the onroad cost of the GLC including transfer"]);
  assert.equal(last.answers[0].resolved, true);
  assert.equal(last.answers[0].car.priceLakh, 15.5);
  assert.deepEqual(last.profile.models, []);
});

test("“the first one” resolves to the first car shown", async () => {
  const { last, outs } = await chat(["Show me Mercedes-Benz", "What's the on-road cost of the first one?"]);
  assert.equal(last.answers[0].car.id, shown(outs[0])[0].id);
});

// ---------- promises, consent, escalation ----------
test("promises are enforced on the app feed: rejected brands and excluded bodies never appear", async () => {
  const { user } = await chat(["Show me cars under 10 lakh", "Why am I seeing Maruti? I don't want Maruti", "No hatchbacks"]);
  const feed = feedFor(user.profile);
  assert.ok(feed.cars.length > 0);
  assert.ok(feed.cars.every((c) => c.make !== "Maruti" && c.body !== "Hatchback"));
});

test("‘don't call’ blocks the dialer; asking for a call later allows it with a context packet", async () => {
  const { engine, user, session } = await chat(["Show me Mercedes-Benz", "Don't call me, just answer here."]);
  assert.equal(dialerCheck(user, engine.store.list("tickets")).allowed, false);
  const r = await engine.handleMessage(user.id, session.id, "OK, have an advisor call me about the GLC");
  assert.equal(r.escalation.call, true);
  assert.ok(r.packet.shortlist.length > 0);
  assert.equal(dialerCheck(engine.user(user.id), engine.store.list("tickets")).allowed, true);
});

test("the full real transcript: zero unrequested calls, one call when the buyer asks, packet carries the intent", async () => {
  const { outs } = await chat(REPLAY.map((r) => r.user));
  assert.equal(outs.filter((o) => o.escalation.call).length, 1);
  assert.equal(outs.at(-1).escalation.call, true);
  const pk = outs.at(-1).packet;
  assert.match(pk.intent, /≤ ₹20L/);
  assert.match(pk.intent, /no hatchbacks/);
  assert.ok(pk.blocked.includes("Maruti"));
  assert.ok(pk.shortlist.length > 0);
});

// ---------- users and sessions ----------
test("intent survives sessions; a new session greets with what is remembered", async () => {
  const engine = memEngine();
  const u = engine.createUser({ name: "Asha Rao", homeCity: "kanpur" });
  const s1 = engine.createSession(u.id).session;
  await engine.handleMessage(u.id, s1.id, "BMW under 20 lakh, no hatchbacks");
  const { session: s2, greeting } = engine.createSession(u.id);
  assert.match(greeting, /BMW/);
  const r = await engine.handleMessage(u.id, s2.id, "show me what you have");
  assert.equal(r.profile.budgetMax, 20);
  assert.ok(r.profile.excludeBodies.includes("Hatchback"));
  assert.equal(engine.sessionsOf(u.id).length, 2);
});

test("users are isolated: one buyer's preferences never leak into another's", async () => {
  const engine = memEngine();
  await chat(["Don't show Hyundai", "Audi under 15 lakh"], { engine });
  const { last } = await chat(["Show me Hyundai Creta within 200 km"], { engine });
  assert.deepEqual(last.profile.rejectBrands, []);
  assert.ok(shown(last).some((c) => c.model === "Creta"));
});

test("a retried message (same clientMsgId) is answered once", async () => {
  const engine = memEngine();
  const u = engine.createUser({ name: "Dev", homeCity: "kanpur" });
  const { session } = engine.createSession(u.id);
  const a = await engine.handleMessage(u.id, session.id, "Show me BMW", { clientMsgId: "m1" });
  const b = await engine.handleMessage(u.id, session.id, "Show me BMW", { clientMsgId: "m1" });
  assert.equal(b.replayed, true);
  assert.equal(b.reply, a.reply);
  assert.equal(engine.messages(session.id).filter((m) => m.role === "user").length, 1);
});

test("concurrent messages in one session are processed in order", async () => {
  const engine = memEngine();
  const u = engine.createUser({ name: "Dev", homeCity: "kanpur" });
  const { session } = engine.createSession(u.id);
  await Promise.all(["BMW please", "under 20 lakh", "no hatchbacks"].map((m) => engine.handleMessage(u.id, session.id, m)));
  const texts = engine.messages(session.id).filter((m) => m.role === "user").map((m) => m.text);
  assert.deepEqual(texts, ["BMW please", "under 20 lakh", "no hatchbacks"]);
  assert.equal(engine.user(u.id).profile.budgetMax, 20);
});

test("rate limit, empty messages and unknown cities are rejected cleanly", async () => {
  const engine = memEngine();
  assert.throws(() => engine.createUser({ name: "X", homeCity: "atlantis" }), /Unknown city/);
  const u = engine.createUser({ name: "Spam", homeCity: "kanpur" });
  const { session } = engine.createSession(u.id);
  await assert.rejects(engine.handleMessage(u.id, session.id, "   "), /empty/i);
  for (let i = 0; i < config.rateLimitPerMinute; i++) await engine.handleMessage(u.id, session.id, `hi ${i}`);
  await assert.rejects(engine.handleMessage(u.id, session.id, "one more"), /Too many/);
});

test("‘start over’ clears the search but keeps the city and the no-call flag", async () => {
  const { last } = await chat(["BMW under 20 lakh", "don't call me", "start over"]);
  assert.deepEqual(last.profile.brands, []);
  assert.equal(last.profile.budgetMax, null);
  assert.equal(last.profile.callConsent, false);
  assert.equal(last.profile.homeCity, "Kanpur");
});

test("the buyer can forget a remembered item", async () => {
  const { user } = await chat(["BMW under 20 lakh, no hatchbacks"]);
  assert.ok(forget(user.profile, "excludeBodies", "Hatchback"));
  assert.ok(forget(user.profile, "budgetMax"));
  assert.deepEqual(user.profile.excludeBodies, []);
  assert.equal(user.profile.budgetMax, null);
});

// ---------- LLM path ----------
test("LLM extraction is used when available and cleaned by normalise()", async () => {
  await withLLM(okLLM({ ...normalise({}), intent: "search", brands: ["mercedes", "Lamborghini Imaginary"], budgetMax: 20 }), async (engine) => {
    const { last } = await chat(["merc under 20"], { engine });
    assert.equal(last.extraction.source, "llm");
    assert.deepEqual(last.profile.brands, ["Mercedes-Benz"]);
  });
});

test("LLM outage falls back to rules and the buyer still gets an answer", async () => {
  await withLLM(async () => ({ ok: false, status: 500, json: async () => ({}) }), async (engine) => {
    const { last } = await chat(["Show me BMW under 20 lakhs"], { engine });
    assert.equal(last.extraction.source, "rules");
    assert.match(last.extraction.error, /500/);
    assert.ok(shown(last).some((c) => c.make === "BMW"));
    assert.ok(last.reply.length > 0);
  });
});

test("reply guard blocks invented prices, unlisted models and unbooked call promises", () => {
  const facts = { buyerMessage: "bmw", profile: "BMW", answers: [], cars: [{ title: "2016 BMW X5", price: "₹16L" }], escalation: { call: false } };
  assert.deepEqual(guard("The 2016 BMW X5 is ₹16L.", facts), []);
  assert.ok(guard("A BMW X5 at ₹12L", facts).length);
  assert.ok(guard("Try the Fortuner at ₹16L", facts).some((p) => /Fortuner/.test(p)));
  assert.ok(guard("An advisor will call you shortly.", facts).length);
  assert.ok(guard("Kanpur isn't serviceable right now.", facts).length);
});

// ---------- persistence ----------
test("the store survives a restart and writes atomically", () => {
  const dir = pathToFileURL(mkdtempSync(join(tmpdir(), "cargpt-")) + "/");
  const a = new Store(dir);
  a.put("users", "u1", { id: "u1", name: "Persisted" });
  a.append("messages", "s1", { text: "hello" });
  a.flush();
  const b = new Store(dir);
  assert.equal(b.get("users", "u1").name, "Persisted");
  assert.equal(b.items("messages", "s1")[0].text, "hello");
  writeFileSync(new URL("users.json", dir), "{ not json");
  const c = new Store(dir);
  assert.deepEqual(c.list("users"), [], "a corrupt file is set aside, not crashed on");
  assert.ok(readFileSync(new URL("messages.json", dir), "utf8").includes("hello"));
});

// ---------- HTTP API ----------
let server, base;
before(async () => { server = createApp({ engine: memEngine() }); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());

test("HTTP: signup → session → message, with token checks", async () => {
  const j = async (path, opts = {}) => { const r = await fetch(base + path, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } }); return { status: r.status, body: await r.json() }; };
  const signup = await j("/api/users", { method: "POST", body: JSON.stringify({ name: "Api Buyer", homeCity: "kanpur" }) });
  assert.equal(signup.status, 200);
  const { user, token } = signup.body;
  const auth = { "X-User-Token": token };
  assert.equal((await j(`/api/users/${user.id}/sessions`)).status, 401);
  const ses = await j(`/api/users/${user.id}/sessions`, { method: "POST", headers: auth, body: "{}" });
  const msg = await j(`/api/users/${user.id}/sessions/${ses.body.session.id}/messages`, { method: "POST", headers: auth, body: JSON.stringify({ text: "Show me Mercedes-Benz" }) });
  assert.equal(msg.status, 200);
  assert.equal(msg.body.search.steps[0].cars.length, 3);
  assert.equal((await j(`/api/users/${user.id}/sessions/${ses.body.session.id}/messages`, { method: "POST", headers: auth, body: "not json" })).status, 400);
  assert.equal((await j("/api/advisor/tickets")).status, 401);
  assert.equal((await j("/api/advisor/tickets", { headers: { "X-Advisor-Key": config.advisorKey } })).status, 200);
});

test("two identical requests in flight run once", async () => {
  const engine = memEngine();
  const u = engine.createUser({ name: "Dev", homeCity: "kanpur" });
  const { session } = engine.createSession(u.id);
  const [a, b] = await Promise.all([1, 2].map(() => engine.handleMessage(u.id, session.id, "Show me BMW", { clientMsgId: "same" })));
  assert.equal(a.reply, b.reply);
  assert.equal(engine.messages(session.id).filter((m) => m.role === "user").length, 1);
});

test("asking for a new brand never blocks the old one, and a bigger radius is not ‘open to other brands’", async () => {
  const content = { ...normalise({}), intent: "search", brands: ["BMW"], rejectBrands: ["Mercedes-Benz"], radiusKm: 200, widen: true };
  await withLLM(okLLM(content), async (engine) => {
    const { last } = await chat(["Show me BMW within 200 km"], { engine });
    assert.deepEqual(last.profile.rejectBrands, []);
    assert.equal(last.profile.widened, false);
  });
});

test("reply guard blocks ‘no cars available’ when no search ran this turn", () => {
  const facts = { buyerMessage: "transfer?", profile: "", answers: [], cars: [], searchRan: false, escalation: { call: false } };
  assert.ok(guard("There are no Mercedes cars available within 50 km.", facts).length);
  assert.deepEqual(guard("Same-state transfer: no NOC needed.", facts), []);
});

test("on-road question names a model by its first word (“the GLC” for “GLC Class”)", async () => {
  const { setInventory, inventory } = await import("../src/inventory.js");
  const saved = inventory();
  setInventory({ cars: saved.cars.map((c) => (c.model === "GLC" ? { ...c, model: "GLC Class" } : c)), cities: saved.cities });
  try {
    const { last } = await chat(["Show me Audi within 200 km", "What's the onroad cost of the GLC including transfer"]);
    assert.equal(last.answers[0].car.make, "Mercedes-Benz");
    assert.equal(last.answers[0].car.priceLakh, 15.5);
  } finally { setInventory({ cars: saved.cars, cities: saved.cities }); }
});

test("the LLM can't move the buyer's home city unless the message names it", async () => {
  await withLLM(okLLM({ ...normalise({}), intent: "question", homeCity: "new delhi", onRoad: { model: "GLC", listingRef: null } }), async (engine) => {
    const { last } = await chat(["What's the onroad cost of the GLC including transfer"], { engine });
    assert.equal(last.profile.homeCity, "Kanpur");
  });
  await withLLM(okLLM({ ...normalise({}), intent: "preference", homeCity: "lucknow" }), async (engine) => {
    const { last } = await chat(["I've moved to Lucknow now"], { engine });
    assert.equal(last.profile.homeCity, "Lucknow");
  });
});

test("a brand the LLM carries over from context can't unblock a blocked brand", async () => {
  let call = 0;
  const llm = async () => {
    call++;
    const d = call === 1
      ? { ...normalise({}), intent: "search", brands: ["Mercedes-Benz"], rejectBrands: ["Maruti"] }
      : { ...normalise({}), intent: "preference", brands: ["Maruti", "Mercedes-Benz"], excludeBodies: ["Hatchback"] };
    return { ok: true, status: 200, json: async () => ({ model: "t", usage: {}, choices: [{ message: { content: JSON.stringify(d) } }] }) };
  };
  await withLLM(llm, async (engine) => {
    const { last } = await chat(["I searched Mercedes, why am I seeing Maruti Baleno?", "please don't show me any hatchback in recommendations"], { engine });
    assert.deepEqual(last.profile.rejectBrands, ["Maruti"]);
    assert.ok(!last.profile.brands.includes("Maruti"));
    assert.ok(last.search.steps.flatMap((s) => s.cars).every((c) => c.make !== "Maruti"));
  });
});

test("“near me” keeps the radius automatic even if the LLM invents one", async () => {
  await withLLM(okLLM({ ...normalise({}), intent: "search", includeBodies: ["SUV"], radiusKm: 50, useCurrentLocation: true }), async (engine) => {
    const { last } = await chat(["any SUV near me?"], { engine });
    assert.equal(last.profile.radiusSource, "auto");
    assert.equal(last.search.radiusMode, "auto");
  });
});

test("real cars24 model names: 'GLC' finds a 'GLC CLASS' listing and on-road never answers for a different car", async () => {
  const { setInventory, inventory } = await import("../src/inventory.js");
  const original = inventory();
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/inventory.json", import.meta.url), "utf8"));
  const cities = JSON.parse(readFileSync(new URL("./fixtures/cities.json", import.meta.url), "utf8")).cities;
  // cars24 cards say "GLC CLASS", "C CLASS", "XC 60"; the fixture uses the short forms.
  const cars = fixture.cars.map((c) => ({ ...c, model: c.model === "GLC" ? "GLC CLASS" : c.model === "C-Class" ? "C CLASS" : c.model }));
  setInventory({ cars, cities });
  try {
    assert.ok(parse("what's the onroad cost of the GLC including transfer").onRoad?.model, "GLC is recognised as a model");
    const { last } = await chat(["Audi please", "What's the onroad cost of the GLC including transfer"]);
    const a = last.answers.find((x) => x.type === "onroad");
    assert.ok(a?.resolved, "on-road question is answered");
    assert.match(a.text, /GLC/, "answer is about the GLC, not the first car on screen");
  } finally {
    setInventory({ cars: original.cars, cities: original.cities, capturedAt: original.capturedAt });
  }
});

test("“the second one” is the second car shown; a vague on-road question asks which car", async () => {
  const { last, outs } = await chat(["Show me Mercedes-Benz", "What's the on-road cost of the second one?"]);
  const shownCars = shown(outs[0]);
  assert.ok(shownCars.length >= 2);
  assert.equal(last.answers[0].car.id, shownCars[1].id);
  const vague = await chat(["Show me Mercedes-Benz", "what is the on-road cost?"]);
  assert.equal(vague.last.answers[0].resolved, false, "asks which car instead of picking one");
});
