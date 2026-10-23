// IntentAgent: understands one message. OpenAI structured output with the buyer's profile, their
// intents ranked by recency, and recent turns as context; rules take over if the LLM fails. Output
// always passes through normalise(), so it can only ever propose a clean delta.
import { extract } from "../extract.js";

export const intentAgent = {
  name: "intent",
  critical: true,
  async run(ctx) {
    const p = ctx.profile;
    const ex = await extract(ctx.text, { profile: p, priorities: ctx.prioritiesBefore, recent: ctx.recent, store: ctx.services.store, fetchImpl: ctx.services.fetchImpl });
    const d = ex.delta;
    // A car named in a question ("on-road cost of the GLC") is not a new search filter.
    if (d.intent === "question" && (d.onRoad || d.transfer)) { d.models = []; d.brands = d.brands.filter((b) => p.brands.includes(b)); }
    ctx.delta = d;
    ctx.extraction = { source: ex.source, error: ex.error || null, ms: ex.ms || null, delta: d };
    ctx.emit("intent.extracted", { intent: d.intent, source: ex.source }, "intent");
    return `${ex.source}: ${d.intent}`;
  },
};
