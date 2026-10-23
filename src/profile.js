// The buyer's intent profile: one per user, shared by every session and every surface (chat, app
// feed, advisor console, dialer). merge() applies a delta and returns what changed, in words the
// buyer can see and undo.
import { findCity } from "./inventory.js";
import { LUXURY_BRANDS, CITY_STATE, CITY_ALIAS } from "./rules.js";
import { config } from "./config.js";

const CAP = (s) => String(s).replace(/\b\w/g, (c) => c.toUpperCase());
export const lakh = (n) => `₹${Number(n).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}L`;

export function newProfile(homeCity) {
  const city = findCity(homeCity);
  return {
    homeCity: city ? city.name : homeCity ? CAP(homeCity) : null,
    brands: [], models: [], focus: [], tier: null,
    budgetMin: null, budgetMax: null, radiusKm: config.defaultRadiusKm, radiusSource: "auto", cities: [],
    location: null, // last GPS fix: {lat, lon, accuracyM, source, at, city, cityKm}
    includeBodies: [], excludeBodies: [], fuels: [], excludeFuels: [], transmission: null, yearMin: null, kmMax: null,
    rejectBrands: [], rejectModels: [], rejectedIds: [], widened: false,
    callConsent: null, callConsentAt: null,
    lastShown: [], updatedAt: null,
  };
}

const add = (arr, v) => (arr.includes(v) ? false : (arr.push(v), true));
const drop = (arr, v) => { const i = arr.indexOf(v); if (i < 0) return false; arr.splice(i, 1); return true; };
const cityName = (k) => findCity(k)?.name || CAP(CITY_ALIAS[k] || k);

export function tierFor(brands) {
  if (!brands.length) return null;
  return brands.every((b) => LUXURY_BRANDS.includes(b)) ? "luxury" : brands.some((b) => LUXURY_BRANDS.includes(b)) ? "mixed" : "mass";
}

// Apply a delta in place. Returns [{field, op, value, label}] for the audit log and the promise guard.
export function merge(p, d) {
  const ch = [];
  const note = (field, op, value, label) => ch.push({ field, op, value, label });

  for (const c of d.clear) {
    if (c === "all") { const keep = { homeCity: p.homeCity, location: p.location, callConsent: p.callConsent, callConsentAt: p.callConsentAt }; Object.assign(p, newProfile(p.homeCity), keep); note("all", "clear", null, "Started a fresh search (kept your city and call preference)"); }
    if (c === "budget" && (p.budgetMax || p.budgetMin)) { p.budgetMax = p.budgetMin = null; note("budget", "clear", null, "Budget removed"); }
    if (c === "brands" && p.brands.length) { p.brands = []; p.models = []; p.focus = []; note("brands", "clear", null, "Brands removed"); }
    if (c === "models" && p.models.length) { p.models = []; note("models", "clear", null, "Models removed"); }
    if (c === "bodies" && (p.excludeBodies.length || p.includeBodies.length)) { p.excludeBodies = []; p.includeBodies = []; note("bodies", "clear", null, "Body-type filters removed"); }
    if (c === "cities" && p.cities.length) { p.cities = []; note("cities", "clear", null, "Extra cities removed"); }
    if (c === "radius") { p.radiusKm = config.defaultRadiusKm; p.radiusSource = "auto"; note("radius", "clear", null, "Radius back to automatic"); }
    if (c === "fuels") { p.fuels = []; p.excludeFuels = []; note("fuels", "clear", null, "Fuel filters removed"); }
    if (c === "transmission" && p.transmission) { p.transmission = null; note("transmission", "clear", null, "Transmission filter removed"); }
    if (c === "year" && p.yearMin) { p.yearMin = null; note("year", "clear", null, "Year filter removed"); }
    if (c === "km" && p.kmMax) { p.kmMax = null; note("km", "clear", null, "Km filter removed"); }
    if (c === "rejections" && (p.rejectBrands.length || p.rejectModels.length)) { p.rejectBrands = []; p.rejectModels = []; note("rejections", "clear", null, "Blocked brands unblocked"); }
  }

  if (d.homeCity) {
    const name = cityName(d.homeCity);
    if (name !== p.homeCity) { p.homeCity = name; note("homeCity", "set", name, `Your city: ${name}`); }
  }
  for (const b of d.brands) {
    if (drop(p.rejectBrands, b)) note("rejectBrands", "remove", b, `${b} unblocked`);
    if (add(p.brands, b)) note("brands", "add", b, `Looking for ${b}`);
  }
  for (const m of d.models) { drop(p.rejectModels, m); if (add(p.models, m)) note("models", "add", m, `Model: ${m}`); }
  if (d.brands.length || d.models.length) p.focus = [...d.brands];
  for (const b of d.rejectBrands) {
    if (add(p.rejectBrands, b)) note("rejectBrands", "add", b, `Won't show ${b}`);
    if (drop(p.brands, b)) drop(p.focus, b);
  }
  for (const m of d.rejectModels) { if (add(p.rejectModels, m)) note("rejectModels", "add", m, `Won't show ${m}`); drop(p.models, m); }
  const tier = tierFor(p.brands);
  if (tier !== p.tier) { p.tier = tier; if (tier) note("tier", "set", tier, `Segment: ${tier}`); }

  if (d.budgetMax && d.budgetMax !== p.budgetMax) { p.budgetMax = d.budgetMax; note("budgetMax", "set", d.budgetMax, `Budget up to ${lakh(d.budgetMax)}`); }
  if (d.budgetMin && d.budgetMin !== p.budgetMin) { p.budgetMin = d.budgetMin; note("budgetMin", "set", d.budgetMin, `Budget from ${lakh(d.budgetMin)}`); }
  if (d.radiusKm && (d.radiusKm !== p.radiusKm || p.radiusSource !== "stated")) { p.radiusKm = d.radiusKm; p.radiusSource = "stated"; note("radiusKm", "set", d.radiusKm, `Search radius ${d.radiusKm} km`); }
  for (const c of d.cities) {
    const name = cityName(c);
    if (name !== p.homeCity && (!d.transfer || d.transfer.toCity !== c) && CITY_STATE[c] !== undefined && add(p.cities, name)) note("cities", "add", name, `Also search ${name}`);
  }
  for (const b of d.includeBodies) { drop(p.excludeBodies, b); if (add(p.includeBodies, b)) note("includeBodies", "add", b, `Body type: ${b}`); }
  for (const b of d.excludeBodies) { drop(p.includeBodies, b); if (add(p.excludeBodies, b)) note("excludeBodies", "add", b, `No ${b}s`); }
  for (const f of d.fuels) { drop(p.excludeFuels, f); if (add(p.fuels, f)) note("fuels", "add", f, `Fuel: ${f}`); }
  for (const f of d.excludeFuels) { drop(p.fuels, f); if (add(p.excludeFuels, f)) note("excludeFuels", "add", f, `No ${f}`); }
  if (d.transmission && d.transmission !== p.transmission) { p.transmission = d.transmission; note("transmission", "set", d.transmission, `${d.transmission} only`); }
  if (d.yearMin && d.yearMin !== p.yearMin) { p.yearMin = d.yearMin; note("yearMin", "set", d.yearMin, `${d.yearMin} or newer`); }
  if (d.kmMax && d.kmMax !== p.kmMax) { p.kmMax = d.kmMax; note("kmMax", "set", d.kmMax, `Under ${d.kmMax.toLocaleString("en-IN")} km`); }
  if (d.widen && !p.widened) { p.widened = true; note("widened", "set", true, "Open to other brands and segments"); }
  if (d.callConsent !== null && d.callConsent !== p.callConsent) {
    p.callConsent = d.callConsent; p.callConsentAt = new Date().toISOString();
    note("callConsent", "set", d.callConsent, d.callConsent ? "You asked for an advisor call" : "No calls");
  }
  if (ch.length) p.updatedAt = new Date().toISOString();
  return ch;
}

// Buyer-facing edits from the "What CarGPT remembers" panel: remove one remembered item.
export function forget(p, field, value) {
  const arrays = ["brands", "models", "cities", "includeBodies", "excludeBodies", "fuels", "excludeFuels", "rejectBrands", "rejectModels", "rejectedIds"];
  if (arrays.includes(field)) { const ok = drop(p[field], value); if (field === "brands") { drop(p.focus, value); p.tier = tierFor(p.brands); } return ok; }
  if (["budgetMax", "budgetMin", "transmission", "yearMin", "kmMax"].includes(field)) { const ok = p[field] !== null; p[field] = null; return ok; }
  if (field === "radiusKm") { p.radiusKm = config.defaultRadiusKm; p.radiusSource = "auto"; return true; }
  if (field === "location") { const ok = Boolean(p.location); p.location = null; return ok; }
  if (field === "widened") { p.widened = false; return true; }
  if (field === "callConsent") { p.callConsent = null; p.callConsentAt = new Date().toISOString(); return true; }
  return false;
}

export function describe(p) {
  const parts = [];
  if (p.brands.length) parts.push(p.brands.join(" / ") + (p.models.length ? ` (${p.models.join(", ")})` : ""));
  if (p.tier) parts.push(p.tier);
  if (p.budgetMax) parts.push(`≤ ${lakh(p.budgetMax)}`);
  if (p.budgetMin) parts.push(`≥ ${lakh(p.budgetMin)}`);
  if (p.includeBodies.length) parts.push(p.includeBodies.join("/"));
  if (p.excludeBodies.length) parts.push(`no ${p.excludeBodies.join("/").toLowerCase()}s`);
  if (p.fuels.length) parts.push(p.fuels.join("/"));
  if (p.transmission) parts.push(p.transmission.toLowerCase());
  if (p.yearMin) parts.push(`${p.yearMin}+`);
  const from = p.location?.source === "gps" && p.location.city ? `you (near ${p.location.city})` : p.homeCity || "?";
  parts.push(`${p.radiusSource === "stated" ? `within ${p.radiusKm} km` : "nearest first"} of ${from}${p.cities.length ? ` + ${p.cities.join(", ")}` : ""}`);
  return parts.join(", ");
}
