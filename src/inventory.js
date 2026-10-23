// Listings pulled from cars24.com (scripts/scrape.js) plus the city table with coordinates.
// Tests swap in a fixture with setInventory().
import { readFileSync, existsSync } from "node:fs";
import { config } from "./config.js";
import { tierOf, CITY_ALIAS } from "./rules.js";

let INV = { cars: [], cities: [], capturedAt: null, vocab: { makes: [], models: [] } };

// cars24 cards mix "GLC CLASS" and "CLA Class"; keep short codes (GLC, XUV700) and soften shouted words.
const tidy = (s) => (s ? s.split(" ").map((w) => (w.length > 3 && /^[A-Z]+$/.test(w) ? w[0] + w.slice(1).toLowerCase() : w)).join(" ") : s);

export function setInventory({ cars, cities, capturedAt = null }) {
  const enriched = cars.filter((c) => c.priceLakh && c.make && c.status !== "SOLD").map((c) => ({ ...c, model: tidy(c.model), tier: c.tier || tierOf(c.make) }));
  const makes = [...new Set(enriched.map((c) => c.make))];
  const models = [...new Map(enriched.filter((c) => c.model).map((c) => [`${c.make}|${c.model}`, { make: c.make, model: c.model }])).values()];
  INV = { cars: enriched, cities, capturedAt, vocab: { makes, models } };
  return INV;
}

export function loadInventory(dir = config.dataDir) {
  const inv = new URL("inventory.json", dir), cty = new URL("cities.json", dir);
  if (!existsSync(inv) || !existsSync(cty)) throw new Error("No inventory. Run `npm run scrape` first.");
  const a = JSON.parse(readFileSync(inv, "utf8")), b = JSON.parse(readFileSync(cty, "utf8"));
  return setInventory({ cars: a.cars, cities: b.cities, capturedAt: a.capturedAt });
}

export const inventory = () => INV;

export function findCity(name) {
  if (!name) return null;
  const k = String(name).toLowerCase().trim().replace(/-/g, " ");
  const match = (key) => INV.cities.find((c) => c.name.toLowerCase() === key || c.slug.replace(/-/g, " ") === key);
  // Try the name as given, then its alias in either direction (cars24 lists Prayagraj as "allahabad").
  const reverse = Object.keys(CITY_ALIAS).find((a) => CITY_ALIAS[a] === k);
  return match(k) || (CITY_ALIAS[k] && match(CITY_ALIAS[k])) || (reverse && match(reverse)) || null;
}

// Straight-line distance × 1.25 ≈ road distance in India; labelled as an estimate in the UI.
export function roadKm(a, b) {
  if (!a?.geo || !b?.geo) return null;
  if (a.slug === b.slug) return 0;
  const R = 6371, rad = (d) => (d * Math.PI) / 180;
  const [la1, lo1] = a.geo, [la2, lo2] = b.geo;
  const h = Math.sin(rad(la2 - la1) / 2) ** 2 + Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(rad(lo2 - lo1) / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 1.25);
}

export const carById = (id) => INV.cars.find((c) => c.id === String(id)) || null;
