// SearchAgent: runs the intent-keeping fallback-ladder search when the message is about finding
// cars or changed what the buyer is looking for. Brands are ranked by recency weight (the brand
// asked for most recently leads; ones not mentioned for a while sink), and a model the buyer asked
// about gets a small boost.
import { search } from "../search.js";
import { recencyWeights } from "./ledger.js";

const NOT_FILTERS = ["callConsent"];

export function wantsSearch(ctx) {
  const { delta: d, profile: p, changes } = ctx;
  const filterChanged = changes.some((c) => !NOT_FILTERS.includes(c.field));
  const pureQuestion = (d.transfer || d.onRoad) && !d.brands.length && !d.budgetMax && !d.models.length;
  const wantsCars = ["search", "preference", "complaint", "reset"].includes(d.intent) || filterChanged || d.useCurrentLocation;
  return Boolean(wantsCars && !pureQuestion && (p.brands.length || p.budgetMax || p.includeBodies.length || p.models.length || d.intent === "search"));
}

export const searchAgent = {
  name: "search",
  after: ["memory"],
  when: wantsSearch,
  run(ctx) {
    const p = ctx.profile;
    ctx.search = search(p, { weights: recencyWeights(ctx.priorities), turnCities: ctx.delta.cities });
    p.lastShown = ctx.search.shown.slice(0, 10).map((c) => ({ id: c.id, title: `${c.year} ${c.make} ${c.model}`, model: c.model }));
    ctx.emit("search.results", { matched: ctx.search.matched, shown: ctx.search.shown.length }, "search");
    return `${ctx.search.matched} matched, ${ctx.search.shown.length} shown`;
  },
};
