// The intent ledger: every signal a buyer gives (chat, app taps, the "forget" button), with when it
// happened. The profile says WHAT the buyer wants; the ledger says how RECENTLY they said it, so new
// intent outranks old.
//
//   weight = 0.5^(turnsAgo / HALF_LIFE_TURNS) × 0.5^(daysAgo / HALF_LIFE_DAYS)
//
// Preferences (brands, models, bodies, fuels, cities…) decay. A preference that is not reaffirmed
// fades to "dormant": it stays in the profile but ranks last. Constraints (rejections, budget cap,
// excluded bodies/fuels, dismissed listings, "no calls") are promises, so they NEVER decay. Only
// the buyer can lift them.
import { lakh } from "../profile.js";

export const HALF_LIFE_TURNS = 6;
export const HALF_LIFE_DAYS = 14;
export const DORMANT_BELOW = 0.25;
const MAX_ENTRIES = 500;
const DAY = 24 * 3600 * 1000;

// field → [kind, label]
const LISTS = {
  brands: ["preference", (v) => v], models: ["preference", (v) => v], includeBodies: ["preference", (v) => v],
  fuels: ["preference", (v) => v], cities: ["preference", (v) => `Also ${v}`],
  rejectBrands: ["constraint", (v) => `No ${v}`], rejectModels: ["constraint", (v) => `No ${v}`],
  excludeBodies: ["constraint", (v) => `No ${v}s`], excludeFuels: ["constraint", (v) => `No ${v}`],
  rejectedIds: ["constraint", (v) => `Hidden listing ${v}`],
};
const SCALARS = {
  budgetMax: ["constraint", (v) => `Up to ${lakh(v)}`], budgetMin: ["preference", (v) => `From ${lakh(v)}`],
  transmission: ["preference", (v) => `${v} only`], yearMin: ["preference", (v) => `${v} or newer`],
  kmMax: ["preference", (v) => `Under ${Number(v).toLocaleString("en-IN")} km`],
};

export const keyOf = (field, value) => (field in SCALARS ? field : `${field}:${value}`);

// What one message says, as ledger signals. Taken from the delta, not from profile changes, so a
// buyer repeating "BMW" refreshes its recency even though the profile does not change.
export function signalsFromDelta(d) {
  const out = [];
  const push = (field, value, op = "state") => out.push({ key: keyOf(field, value), field, value, op });
  for (const f of ["brands", "models", "includeBodies", "fuels", "rejectBrands", "rejectModels", "excludeBodies", "excludeFuels"]) for (const v of d[f] || []) push(f, v);
  for (const f of ["budgetMax", "budgetMin", "transmission", "yearMin", "kmMax"]) if (d[f] !== null && d[f] !== undefined) push(f, d[f]);
  for (const c of d.cities || []) out.push({ key: `cities:${c}`, field: "cities", value: c, op: "state", raw: true });
  if (d.callConsent !== null && d.callConsent !== undefined) push("callConsent", d.callConsent);
  if (d.radiusKm) push("radiusKm", d.radiusKm);
  if (d.homeCity) push("homeCity", d.homeCity);
  if (d.widen) push("widened", true);
  for (const c of d.clear || []) out.push({ key: `clear:${c}`, field: "clear", value: c, op: "clear" });
  // A model or brand named only in a question ("on-road cost of the GLC") is interest, not a filter.
  if (d.onRoad?.model) out.push({ key: `interest:${d.onRoad.model}`, field: "interest", value: d.onRoad.model, op: "interest" });
  return out;
}

export class IntentLedger {
  constructor(store) { this.store = store; }

  doc(userId) { return this.store.get("intents", userId) || { seq: 0, entries: [] }; }

  // One call = one buyer turn or app signal. Returns the turn number it was recorded under.
  record(userId, signals, { sessionId = null, source = "chat", at = new Date().toISOString() } = {}) {
    const d = this.doc(userId);
    const seq = d.seq + 1;
    const entries = [...d.entries, ...signals.map((s) => ({ ...s, seq, at, sessionId, source }))].slice(-MAX_ENTRIES);
    this.store.put("intents", userId, { seq, entries });
    return seq;
  }

  history(userId, limit = 50) { return this.doc(userId).entries.slice(-limit); }

  // Every active intent in the profile, ranked newest-and-strongest first.
  priorities(userId, p, { now = Date.now() } = {}) {
    const { seq, entries } = this.doc(userId);
    const last = new Map();
    for (const e of entries) last.set(e.key, e);
    // City signals are recorded raw ("lucknow"); the profile stores display names ("Lucknow").
    const seen = (field, value) => last.get(keyOf(field, value)) || (field === "cities" ? last.get(`cities:${String(value).toLowerCase()}`) : null);
    const fallbackAt = p.updatedAt ? Date.parse(p.updatedAt) : now;
    const weigh = (kind, e) => {
      const turnsAgo = e ? seq - e.seq : seq;
      const daysAgo = Math.max(0, (now - (e ? Date.parse(e.at) : fallbackAt)) / DAY);
      const w = kind === "constraint" ? 1 : 0.5 ** (turnsAgo / HALF_LIFE_TURNS) * 0.5 ** (daysAgo / HALF_LIFE_DAYS);
      return { turnsAgo, daysAgo: Math.round(daysAgo * 10) / 10, weight: Math.round(w * 1000) / 1000 };
    };
    const out = [];
    const add = (field, value, kind, label) => {
      const e = seen(field, value);
      const r = weigh(kind, e);
      const status = kind === "constraint" ? "enforced" : field === "brands" && p.focus?.includes(value) ? "focus" : r.weight < DORMANT_BELOW ? "dormant" : "active";
      out.push({ field, value, kind, label, status, lastSeenTurn: e?.seq ?? null, ...r });
    };
    for (const [field, [kind, label]] of Object.entries(LISTS)) for (const v of p[field] || []) add(field, v, kind, label(v));
    for (const [field, [kind, label]] of Object.entries(SCALARS)) if (p[field] !== null && p[field] !== undefined) add(field, p[field], kind, label(p[field]));
    if (p.callConsent === false) add("callConsent", false, "constraint", "No calls");

    // Interest: asked about but never made a filter. Half weight, and dropped once it fades.
    for (const e of last.values()) {
      if (e.op !== "interest" || p.models.includes(e.value)) continue;
      const r = weigh("preference", e);
      if (r.weight * 0.5 >= 0.1) out.push({ field: e.field, value: e.value, kind: "interest", label: `Asked about ${e.value}`, status: "active", lastSeenTurn: e.seq, ...r, weight: Math.round(r.weight * 500) / 1000 });
    }
    const rankOf = { focus: 0, active: 1, enforced: 1, dormant: 2 };
    return out.sort((a, b) => rankOf[a.status] - rankOf[b.status] || b.weight - a.weight || (b.lastSeenTurn ?? 0) - (a.lastSeenTurn ?? 0));
  }
}

// What search needs from the priorities: a recency weight per brand and per asked-about model.
export function recencyWeights(priorities) {
  const brands = {}, interests = {};
  for (const x of priorities) {
    if (x.field === "brands") brands[x.value] = x.status === "focus" ? 1 : x.weight;
    if (x.kind === "interest") interests[x.value] = x.weight;
  }
  return { brands, interests };
}
