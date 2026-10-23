import { test } from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY = "";
const { loadInventory, inventory } = await import("../src/inventory.js");
const { Store } = await import("../src/store.js");
const { Engine } = await import("../src/engine.js");
const { dialerCheck } = await import("../src/policy.js");
const { AGENTS, Coordinator, createCoordinator } = await import("../src/agents/index.js");
const { createApp } = await import("../server.js");

loadInventory(new URL("./fixtures/", import.meta.url));

const DAY = 24 * 3600 * 1000;
const memEngine = (opts = {}) => new Engine({ store: new Store(null, { persist: false }), ...opts });
async function chat(msgs, { engine = memEngine() } = {}) {
  const u = engine.createUser({ name: "Agent Tester", homeCity: "kanpur" });
  const { session } = engine.createSession(u.id);
  const outs = [];
  for (const m of msgs) outs.push(await engine.handleMessage(u.id, session.id, m));
  return { engine, user: engine.user(u.id), session, outs, last: outs.at(-1) };
}
const shown = (o) => (o.search ? o.search.steps.flatMap((s) => s.cars) : []);
const traced = (o, agent) => o.agents.filter((t) => t.agent === agent);
const prio = (o, field, value) => o.priorities.find((x) => x.field === field && x.value === value);
const withAgent = (name, patch) => createCoordinator(AGENTS.map((a) => (a.name === name ? { ...a, ...patch } : a)));
const filler = (n) => Array.from({ length: n }, (_, i) => `hi ${i}`);

// ---------- coordinator ----------
test("agents run in dependency waves: answers and search in parallel, reply last", () => {
  assert.deepEqual(createCoordinator().schedule, [["intent"], ["memory"], ["answers", "search"], ["promises"], ["escalation"], ["reply"]]);
});

test("the coordinator rejects dependency cycles and unknown dependencies", () => {
  assert.throws(() => new Coordinator([{ name: "a", after: ["b"], run() {} }, { name: "b", after: ["a"], run() {} }]), /cycle/);
  assert.throws(() => new Coordinator([{ name: "a", after: ["ghost"], run() {} }]), /unknown agent/);
});

test("every turn carries an agent trace; a pure question skips search", async () => {
  const { last } = await chat(["UP78 car, I live in Delhi, what's the transfer process?"]);
  assert.equal(traced(last, "answers")[0].status, "ran");
  assert.equal(traced(last, "search")[0].status, "skipped");
  for (const a of ["intent", "memory", "promises", "escalation", "reply"]) assert.equal(traced(last, a)[0].status, "ran", a);
});

test("a failing non-critical agent is traced and the buyer still gets a reply", async () => {
  const engine = memEngine({ coordinator: withAgent("search", { run() { throw new Error("search index down"); } }) });
  const { last } = await chat(["Show me BMW under 20 lakh"], { engine });
  assert.equal(traced(last, "search")[0].status, "failed");
  assert.match(traced(last, "search")[0].error, /index down/);
  assert.equal(last.search, null);
  assert.ok(last.reply.length > 0);
  assert.ok(last.events.some((e) => e.topic === "agent.failed"));
});

// ---------- recency ----------
test("the newest brand leads; brands asked earlier are ranked newest first", async () => {
  const { last } = await chat(["Show me Mercedes-Benz", "Show me BMW", "Show me Audi"]);
  assert.deepEqual(last.profile.focus, ["Audi"]);
  assert.equal(prio(last, "brands", "Audi").status, "focus");
  assert.ok(prio(last, "brands", "BMW").weight > prio(last, "brands", "Mercedes-Benz").weight);
  assert.equal(last.search.steps.find((s) => s.key === "saved").label, "BMW / Mercedes-Benz (asked earlier)");
});

test("repeating an old intent refreshes it even though the profile does not change", async () => {
  const { last } = await chat(["Show me Mercedes-Benz", "Show me BMW", "Mercedes again please"]);
  assert.deepEqual(last.profile.brands, ["Mercedes-Benz", "BMW"]);
  assert.equal(prio(last, "brands", "Mercedes-Benz").turnsAgo, 0);
  assert.equal(prio(last, "brands", "Mercedes-Benz").status, "focus");
  assert.equal(last.priorities.find((x) => x.field === "brands").value, "Mercedes-Benz");
});

test("preferences fade to dormant when not repeated; constraints never decay", async () => {
  const { engine, user, last } = await chat(["BMW please", "No hatchbacks", "Mercedes-Benz then", ...filler(13)]);
  assert.equal(prio(last, "brands", "BMW").status, "dormant");
  assert.equal(prio(last, "brands", "Mercedes-Benz").status, "focus");
  assert.equal(prio(last, "excludeBodies", "Hatchback").weight, 1);
  // A month later, preferences have faded but promises hold.
  const later = engine.ledger.priorities(user.id, engine.user(user.id).profile, { now: Date.now() + 30 * DAY });
  assert.ok(later.find((x) => x.field === "brands" && x.value === "BMW").weight < 0.25);
  assert.equal(later.find((x) => x.field === "excludeBodies").weight, 1);
  assert.match(engine.createSession(user.id).greeting, /BMW is from a while back/);
});

test("newest statement wins a conflict: asking for a rejected brand unblocks it", async () => {
  const { last } = await chat(["Show me cars under 10 lakh", "I don't want Maruti", "OK show me Maruti Ciaz"]);
  assert.ok(!last.profile.rejectBrands.includes("Maruti"));
  assert.equal(prio(last, "brands", "Maruti").status, "focus");
  assert.ok(shown(last).some((c) => c.make === "Maruti"));
});

// ---------- promises ----------
test("the promise agent pulls any result that breaks a standing promise", async () => {
  const car = (id) => { const c = inventory().cars.find((x) => x.id === id); return { ...c, title: `${c.year} ${c.make} ${c.model}`, distanceKm: 0 }; };
  const leaky = withAgent("search", {
    run(ctx) {
      const cars = [car("mar-baleno"), car("mb-glc")];
      ctx.search = { steps: [{ key: "exact", label: "leaky", total: 2, cars }], shown: cars, beyond: [], withheld: 0, citiesSearched: ["Kanpur"], matched: 2, home: null };
    },
  });
  const { last } = await chat(["Mercedes please, and I don't want Maruti"], { engine: memEngine({ coordinator: leaky }) });
  assert.equal(last.violations.length, 1);
  assert.equal(last.violations[0].carId, "mar-baleno");
  assert.deepEqual(shown(last).map((c) => c.id), ["mb-glc"]);
  assert.ok(last.events.some((e) => e.topic === "promise.violation"));
});

// ---------- escalation ----------
test("‘don't call’ cancels a pending callback the moment memory reports it", async () => {
  const { engine, user, last } = await chat(["Have an advisor call me", "Actually, don't call me"]);
  assert.ok(last.agents.some((t) => t.agent === "escalation" && t.status === "reacted" && t.topic === "consent.revoked"));
  assert.ok(engine.store.list("tickets").every((t) => !t.callRequested));
  assert.equal(dialerCheck(user, engine.store.list("tickets")).allowed, false);
});

test("the advisor packet leads with the most recent intent", async () => {
  const { last } = await chat(["Show me Mercedes-Benz", "Show me BMW under 20 lakh", "Have an advisor call me"]);
  assert.equal(last.escalation.call, true);
  assert.match(last.packet.latest[0], /^BMW/);
});

// ---------- signals outside chat ----------
test("a dismissed listing disappears from chat and feed; a viewed car becomes interest, not a filter", async () => {
  const { engine, user, session } = await chat(["Show me BMW under 20 lakh"]);
  engine.recordSignal(user.id, { type: "dismiss", carId: "bmw-x5" });
  const r = engine.recordSignal(user.id, { type: "view", carId: "mb-glc" });
  assert.ok(r.priorities.some((x) => x.kind === "interest" && x.value === "GLC"));
  const again = await engine.handleMessage(user.id, session.id, "Show me BMW");
  assert.ok(!shown(again).some((c) => c.id === "bmw-x5"));
  assert.ok(!engine.feed(user.id).cars.some((c) => c.id === "bmw-x5"));
  assert.deepEqual(engine.user(user.id).profile.models, []);
  assert.throws(() => engine.recordSignal(user.id, { type: "like", carId: "mb-glc" }), /type must be/);
});

test("HTTP: signals and intents endpoints need the buyer token", async () => {
  const server = createApp({ engine: memEngine() });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const j = async (path, opts = {}) => { const r = await fetch(base + path, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } }); return { status: r.status, body: await r.json() }; };
    const { body: { user, token } } = await j("/api/users", { method: "POST", body: JSON.stringify({ name: "Sig", homeCity: "kanpur" }) });
    const sig = (headers) => j(`/api/users/${user.id}/signals`, { method: "POST", headers, body: JSON.stringify({ type: "view", carId: "mb-glc" }) });
    assert.equal((await sig({})).status, 401);
    assert.equal((await sig({ "X-User-Token": token })).status, 200);
    const intents = await j(`/api/users/${user.id}/intents`, { headers: { "X-User-Token": token } });
    assert.ok(intents.body.priorities.some((x) => x.value === "GLC"));
    assert.equal(intents.body.history.at(-1).source, "app");
  } finally { server.close(); }
});
