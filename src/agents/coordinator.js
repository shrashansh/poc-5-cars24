// Multi-agent coordinator.
//
// Agents share one blackboard per turn (the TurnContext). Each agent declares:
//   name      unique id
//   after     agents that must finish first (a DAG; independent agents run concurrently)
//   when(ctx) optional: whether this agent has work this turn (otherwise it is skipped, and traced)
//   run(ctx)  does its work on the blackboard; may return a short note for the trace
//   on        optional { topic: (ctx, data) => void }: reacts to events other agents emit
//   critical  if true, a failure aborts the turn; otherwise it is traced and the turn carries on
//
// Every run, skip, failure and event lands in ctx.trace / ctx.events, so a turn is auditable
// agent by agent.
import { performance } from "node:perf_hooks";

export class Coordinator {
  constructor(agents) {
    const names = new Set();
    for (const a of agents) {
      if (!a.name || typeof a.run !== "function") throw new Error("agent needs a name and run()");
      if (names.has(a.name)) throw new Error(`duplicate agent ${a.name}`);
      names.add(a.name);
    }
    for (const a of agents) for (const d of a.after || []) if (!names.has(d)) throw new Error(`agent ${a.name} waits on unknown agent ${d}`);
    this.agents = agents;
    this.waves = plan(agents);
  }

  // The schedule, for docs and tests: [["intent"], ["memory"], ["answers", "search"], ...]
  get schedule() { return this.waves.map((w) => w.map((a) => a.name)); }

  context(fields) {
    const ctx = { ...fields, trace: [], events: [] };
    ctx.emit = (topic, data = null, from = ctx.current || "coordinator") => {
      ctx.events.push({ topic, from, data });
      for (const a of this.agents) {
        const h = a.on?.[topic];
        if (!h) continue;
        try { h(ctx, data); ctx.trace.push({ agent: a.name, status: "reacted", topic, from }); }
        catch (e) { ctx.trace.push({ agent: a.name, status: "failed", topic, error: e.message }); if (a.critical) throw e; }
      }
    };
    return ctx;
  }

  async run(ctx) {
    for (const [i, wave] of this.waves.entries()) await Promise.all(wave.map((a) => this.#runOne(a, ctx, i)));
    return ctx;
  }

  async #runOne(a, ctx, wave) {
    if (a.when && !a.when(ctx)) { ctx.trace.push({ agent: a.name, wave, status: "skipped" }); return; }
    const t0 = performance.now();
    const ms = () => Math.round((performance.now() - t0) * 10) / 10;
    try {
      ctx.current = a.name;
      const note = await a.run(ctx);
      ctx.trace.push({ agent: a.name, wave, status: "ran", ms: ms(), note: note || null });
    } catch (e) {
      ctx.trace.push({ agent: a.name, wave, status: "failed", ms: ms(), error: e.message });
      ctx.emit("agent.failed", { agent: a.name, error: e.message }, a.name);
      if (a.critical) throw e;
    }
  }
}

// Topological waves: everything whose dependencies are done runs together.
function plan(agents) {
  const done = new Set(), waves = [];
  let left = [...agents];
  while (left.length) {
    const wave = left.filter((a) => (a.after || []).every((d) => done.has(d)));
    if (!wave.length) throw new Error(`agent dependency cycle among ${left.map((a) => a.name).join(", ")}`);
    wave.forEach((a) => done.add(a.name));
    left = left.filter((a) => !wave.includes(a));
    waves.push(wave);
  }
  return waves;
}
