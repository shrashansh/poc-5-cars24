// MemoryAgent: keeps the buyer's intent current. Every turn it
//   1. records what the message said in the intent ledger (with turn number and time),
//   2. merges the delta into the shared profile (newest statement wins on any conflict:
//      a brand asked for after a rejection unblocks it, a new budget replaces the old one),
//   3. re-ranks every remembered intent by recency, so new intent outranks old.
// It also announces changes other agents must react to (consent revoked or granted).
import { merge } from "../profile.js";
import { signalsFromDelta } from "./ledger.js";
import { gpsFresh } from "../location.js";

export const memoryAgent = {
  name: "memory",
  after: ["intent"],
  critical: true,
  run(ctx) {
    const { profile: p, delta: d, user } = ctx;
    ctx.shownBefore = [...(p.lastShown || [])]; // what "the first one" refers to, before search replaces it
    ctx.turnSeq = ctx.services.ledger.record(user.id, signalsFromDelta(d), { sessionId: ctx.sessionId, source: ctx.extraction.source });
    ctx.changes = merge(p, d);
    ctx.priorities = ctx.services.ledger.priorities(user.id, p);
    if (d.useCurrentLocation) ctx.needs = gpsFresh(p.location)
      ? `Searching around your current location (near ${p.location.city}).`
      : `I don't have your location yet. Tap 📍 Use my location, or tell me your city; for now I'm searching around ${p.homeCity}.`;
    if (d.callConsent === false) ctx.emit("consent.revoked", null, "memory");
    if (d.callConsent === true) ctx.emit("consent.granted", null, "memory");
    if (ctx.changes.length) ctx.emit("profile.changed", ctx.changes.map((c) => c.label), "memory");
    const top = ctx.priorities.filter((x) => x.kind !== "constraint").slice(0, 3).map((x) => `${x.value}(${x.weight})`);
    return `${ctx.changes.length} change(s); turn ${ctx.turnSeq}; top: ${top.join(", ") || "none"}`;
  },
};
