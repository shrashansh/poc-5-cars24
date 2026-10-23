// Where the buyer is. The search starts from the buyer's GPS position when the app shares it, and
// from their home city otherwise. Inventory is known per city, so distances run from the buyer's
// point to each city's centre (straight line × 1.25 ≈ road distance).
import { inventory, findCity } from "./inventory.js";

export const GPS_FRESH_MS = 6 * 3600 * 1000;
const ROAD_FACTOR = 1.25;

export function kmBetween(lat1, lon1, lat2, lon2) {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return Math.round(2 * 6371 * Math.asin(Math.sqrt(h)) * ROAD_FACTOR);
}

export function validPoint(loc) {
  if (!loc || typeof loc !== "object") return false;
  const { lat, lon } = loc;
  return typeof lat === "number" && typeof lon === "number" && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

export function nearestCity(lat, lon) {
  let best = null;
  for (const c of inventory().cities) {
    if (!c.geo) continue;
    const km = kmBetween(lat, lon, c.geo[0], c.geo[1]);
    if (!best || km < best.km) best = { city: c, km };
  }
  return best;
}

// A GPS fix → what the profile stores.
export function locate({ lat, lon, accuracy }) {
  const near = nearestCity(lat, lon);
  return {
    lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4, // ~11 m; enough for a city-level search
    accuracyM: typeof accuracy === "number" ? Math.round(accuracy) : null,
    source: "gps", at: new Date().toISOString(),
    city: near?.city.name || null, cityKm: near?.km ?? null,
  };
}

export const gpsFresh = (loc, now = Date.now()) => Boolean(loc && loc.source === "gps" && now - Date.parse(loc.at) < GPS_FRESH_MS);

// The point every distance is measured from this turn.
export function originOf(p) {
  if (gpsFresh(p.location)) {
    const city = findCity(p.location.city);
    return { lat: p.location.lat, lon: p.location.lon, city, source: "gps", label: city ? `your location (near ${city.name}, ~${p.location.cityKm} km)` : "your location" };
  }
  const city = findCity(p.homeCity);
  return { lat: city?.geo?.[0] ?? null, lon: city?.geo?.[1] ?? null, city, source: "city", label: city ? city.name : p.homeCity || "your city" };
}

export function kmFrom(origin, c) {
  if (origin.source === "city" && origin.city && origin.city.slug === c.slug) return 0;
  if (origin.lat === null || !c.geo) return null;
  return kmBetween(origin.lat, origin.lon, c.geo[0], c.geo[1]);
}
