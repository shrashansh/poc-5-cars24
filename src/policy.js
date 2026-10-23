// Promises, consent and escalation.
// - Every promise CarGPT makes maps to the system that enforces it (no promise without an enforcer).
// - The app feed and the dialer read the same profile, so "no Baleno" and "don't call" hold everywhere.
// - A call happens only when the buyer asks, and the advisor gets the context packet.
import { search } from "./search.js";
import { describe, lakh } from "./profile.js";

export function commitmentsFor(changes) {
  const out = [];
  for (const c of changes) {
    if (c.field === "excludeBodies") out.push({ promise: `No ${c.value}s in any recommendation`, enforcedBy: "Shared intent profile → app feed, web feed and CarGPT all filter on it", check: "feed" });
    if (c.field === "rejectBrands" && c.op === "add") out.push({ promise: `No ${c.value} recommendations`, enforcedBy: "Shared intent profile → removed from every recommendation surface", check: "feed" });
    if (c.field === "rejectModels" && c.op === "add") out.push({ promise: `No ${c.value} recommendations`, enforcedBy: "Shared intent profile → removed from every recommendation surface", check: "feed" });
    if (c.field === "callConsent" && c.value === false) out.push({ promise: "No calls from Cars24", enforcedBy: "Dialer suppression flag on the lead; open callbacks cancelled", check: "dialer" });
    if (c.field === "brands" && c.op === "add") out.push({ promise: `${c.value} stays first in your results`, enforcedBy: "Ranking pins requested brands above every fallback", check: "ranking" });
    if (c.field === "budgetMax") out.push({ promise: `Nothing above ${lakh(c.value)}`, enforcedBy: "Budget filter on the shared profile", check: "feed" });
  }
  return out;
}

// The app's "Recommended for you" feed. Same profile, same filters as the chat.
export function feedFor(profile, limit = 12, { weights } = {}) {
  const r = search(profile, { weights });
  const cars = r.shown.slice(0, limit);
  return { cars, rules: describe(profile), excluded: { brands: profile.rejectBrands, models: profile.rejectModels, bodies: profile.excludeBodies } };
}

// The dialer asks before every outbound call.
export function dialerCheck(user, tickets) {
  const p = user.profile;
  if (p.callConsent === false) return { allowed: false, reason: `Buyer said no calls (${p.callConsentAt?.slice(0, 16).replace("T", " ") || "on file"})` };
  const open = tickets.find((t) => t.userId === user.id && t.status === "open" && t.callRequested);
  if (open) return { allowed: true, reason: "Buyer asked for a call", ticketId: open.id };
  return { allowed: false, reason: "No call requested. Reply in chat instead." };
}

export function escalationDecision(p, { unresolved, openTicket, askedNow }) {
  if (askedNow) return { escalate: true, call: true, reason: "Buyer asked for a call. The advisor gets the context packet." };
  if (!unresolved) return { escalate: false, reason: "Answered in chat; nothing to escalate" };
  if (p.callConsent === false) return { escalate: true, call: false, reason: "Buyer said no calls. Question goes to async review; answer comes back in chat." };
  if (openTicket) return { escalate: false, reason: "Added to the open ticket; no new call" };
  return { escalate: false, ask: true, reason: "Ask first: “Want an advisor to call, or should I keep it here?”" };
}

export function contextPacket(user, { openQuestions, shortlist, sessionCount, priorities = [] }) {
  const p = user.profile;
  return {
    buyer: user.name, city: p.homeCity, sessions: sessionCount,
    intent: describe(p),
    // What the buyer wants now, newest first, so the advisor opens with the current ask, not an old one.
    latest: priorities.filter((x) => x.kind !== "constraint" && x.status !== "dormant").slice(0, 5).map((x) => `${x.label}${x.turnsAgo === 0 ? " (just now)" : x.turnsAgo ? ` (${x.turnsAgo} turn${x.turnsAgo === 1 ? "" : "s"} ago)` : ""}`),
    dormant: priorities.filter((x) => x.status === "dormant").map((x) => x.label),
    blocked: [...p.rejectBrands, ...p.rejectModels, ...p.excludeBodies.map((b) => `${b}s`)],
    shortlist: shortlist.slice(0, 5).map((c) => ({ id: c.id, title: `${c.year} ${c.make} ${c.model}`, price: lakh(c.priceLakh), city: c.city, url: c.url })),
    openQuestions,
    callConsent: p.callConsent === null ? "not asked" : p.callConsent ? "yes, asked for a call" : "NO — do not dial",
    opener: p.brands.length
      ? `“You were looking at ${p.brands.join(", ")}${p.budgetMax ? ` under ${lakh(p.budgetMax)}` : ""} near ${p.homeCity}. I have ${shortlist.length} options lined up.”`
      : `“You were asking about ${openQuestions[0] || "a car"}. Here's what I found.”`,
  };
}
