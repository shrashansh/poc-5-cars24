// Pulls live used-car listings from cars24.com into data/inventory.json and data/cities.json.
//
// cars24.com server-renders 20 cars per listing page and has no server-side pagination, so
// coverage comes from crawling every brand / model / budget / body / fuel page linked from each
// city page and de-duplicating by appointmentId. Only paths allowed by cars24.com/robots.txt are
// fetched, one request at a time with a delay.
//
//   node scripts/scrape.js                 # default cities
//   node scripts/scrape.js kanpur lucknow  # chosen cities (merged into the existing pull)
//   Saves after every city, so a partial pull is usable.
//   MAX_PAGES=40 node scripts/scrape.js    # cap facet pages per city

import { writeFileSync, mkdirSync, readFileSync, existsSync, renameSync } from "node:fs";

const DEFAULT_CITIES = ["kanpur", "lucknow", "agra", "allahabad", "varanasi", "noida", "ghaziabad", "new-delhi", "gurgaon", "jaipur", "mumbai", "bangalore"];
const CITIES = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_CITIES;
const MAX_PAGES = Number(process.env.MAX_PAGES || 140);
const DELAY_MS = Number(process.env.DELAY_MS || 350);
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const OUT = new URL("../data/", import.meta.url);

const BODY_PAGES = { hatchback: "Hatchback", sedan: "Sedan", suv: "SUV", muv: "MUV", "luxury-suv": "SUV", "luxury-sedan": "Sedan", "compact-suv": "SUV", coupe: "Coupe", convertible: "Convertible" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(`https://www.cars24.com/${path}`, { headers: { "User-Agent": UA, Accept: "text/html" }, redirect: "follow" });
      if (r.status === 404) return null;
      if (r.ok) return await r.text();
      if (r.status === 429 || r.status >= 500) { await sleep(2000 * attempt); continue; }
      return null;
    } catch { await sleep(1500 * attempt); }
  }
  return null;
}

// Next.js streams page data as self.__next_f.push([1,"..."]) string chunks.
function rsc(html) {
  let s = "";
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,"(.*?)"\]\)<\/script>/gs)) {
    try { s += JSON.parse(`"${m[1]}"`); } catch { /* skip a malformed chunk */ }
  }
  return s;
}

// Cut out every JSON object that follows `key` (e.g. "carCard":{ … }) by walking braces.
function objectsAfter(s, key) {
  const out = [];
  let i = 0;
  while ((i = s.indexOf(key, i)) !== -1) {
    const start = i + key.length - 1;
    let depth = 0, j = start, inStr = false;
    for (; j < s.length; j++) {
      const ch = s[j];
      if (inStr) { if (ch === "\\") j++; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) break;
    }
    try { out.push(JSON.parse(s.slice(start, j + 1))); } catch { /* skip */ }
    i = j;
  }
  return out;
}
const cards = (s) => objectsAfter(s, '"carCard":{');

function meta(s) {
  const m = s.match(/"page":\{"currentPage":\d+,"carListOffset":\d+,"size":\d+,"totalElements":(\d+)/);
  const city = objectsAfter(s, '"cities":{').map((o) => Object.values(o)[0]).find((c) => c && c.legacyId) || null;
  return { total: m ? Number(m[1]) : null, city };
}

function normalise(card, citySlug, cityName) {
  const badges = (card.carInfoBadges || []).map((b) => b.text);
  const reg = badges.find((t) => /^[A-Z]{2}\d{1,2}$/.test(t)) || null;
  const trans = badges.find((t) => /^(Manual|Automatic|Auto|AMT|CVT|DCT)$/i.test(t)) || null;
  const [make, ...rest] = String(card.carName || "").split(" ");
  const tag = card.businessTagV2?.media?.alt || card.platformImage?.alt || "";
  return {
    id: String(card.appointmentId),
    cityId: card.cityId ?? null,
    city: cityName,
    citySlug,
    year: card.year ?? null,
    make: make === "Mercedes" ? "Mercedes-Benz" : make,
    model: (make === "Mercedes" ? rest.join(" ").replace(/^Benz\s*/i, "") : rest.join(" ")) || null,
    variant: card.variant || null,
    fuel: card.fuelType || null,
    transmission: trans ? (/^man/i.test(trans) ? "Manual" : "Automatic") : null,
    km: card.odometer?.value ?? null,
    owners: card.ownership ?? null,
    reg,
    priceLakh: card.listingPriceV2?.value ? Math.round(card.listingPriceV2.value / 1000) / 100 : null,
    emi: card.emiDetails?.emiStartingValue ?? null,
    seller: card.businessVertical || null,
    sellerLabel: tag || null,
    status: card.status || null,
    url: card.cdpBaseUrl && card.cdpRelativeUrl ? card.cdpBaseUrl + card.cdpRelativeUrl : null,
    image: card.listingImage?.uri || null,
    body: null,
  };
}

async function crawlCity(slug) {
  const root = `buy-used-cars-${slug}/`;
  const html = await get(root);
  if (!html) { console.log(`  ${slug}: city page not found, skipped`); return null; }
  const s = rsc(html);
  const { total, city } = meta(s);
  const name = city?.name || slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const cars = new Map();
  for (const c of cards(s)) cars.set(String(c.appointmentId), normalise(c, slug, name));

  const links = [...new Set([...s.matchAll(new RegExp(`buy-used-[a-z0-9.-]+-${slug}/`, "g"))].map((m) => m[0]))].filter((l) => l !== root);
  // Body-type pages first so every car seen on one gets a body tag; then brands, models, budgets.
  const bodyLinks = Object.keys(BODY_PAGES).map((b) => `buy-used-${b}-cars-${slug}/`);
  const queue = [...new Set([...bodyLinks, ...links])].slice(0, MAX_PAGES);
  let pages = 1;
  for (const path of queue) {
    await sleep(DELAY_MS);
    const h = await get(path);
    if (!h) continue;
    pages++;
    const bodyKey = Object.keys(BODY_PAGES).find((b) => path === `buy-used-${b}-cars-${slug}/`);
    for (const c of cards(rsc(h))) {
      const id = String(c.appointmentId);
      const car = cars.get(id) || normalise(c, slug, name);
      if (bodyKey && !car.body) car.body = BODY_PAGES[bodyKey];
      cars.set(id, car);
    }
    if (pages % 20 === 0) console.log(`  ${slug}: ${pages} pages, ${cars.size}/${total ?? "?"} cars`);
  }
  console.log(`  ${slug}: done — ${cars.size} of ${total ?? "?"} listed cars from ${pages} pages`);
  return {
    city: {
      slug, name, legacyId: city?.legacyId ?? null, state: city?.stateCode || null, geo: city?.geoLocation || null, pincode: city?.pincode || null,
      totalListed: total, luxeCount: city?.luxeCount ?? null, captured: cars.size,
      assuredServiceable: city?.d2CServiceable ?? null, serviceableVerticals: city?.serviceableBusinessVerticals || [],
    },
    cars: [...cars.values()],
  };
}

const started = new Date();
const cities = [];
const byId = new Map();
mkdirSync(OUT, { recursive: true });
const invPath = new URL("inventory.json", OUT), cityPath = new URL("cities.json", OUT);
const prior = existsSync(invPath) && existsSync(cityPath)
  ? { cars: JSON.parse(readFileSync(invPath, "utf8")).cars, cities: JSON.parse(readFileSync(cityPath, "utf8")).cities }
  : { cars: [], cities: [] };

// Written after every city (temp file + rename), so a long pull is usable while it runs and
// an interrupted pull keeps what it finished. Cities from earlier pulls that this run hasn't
// reached yet are kept.
function save() {
  // Facet pages in a metro also show cars from neighbouring cities (a Noida page lists Ghaziabad cars).
  // Each card carries its own cityId, so place every car in its real city; hold cars from cities not crawled yet.
  const cityByLegacy = Object.fromEntries(cities.filter((c) => c.legacyId).map((c) => [c.legacyId, c]));
  let fresh = [];
  for (const c of byId.values()) {
    const home = cityByLegacy[c.cityId];
    if (home) fresh.push({ ...c, city: home.name, citySlug: home.slug });
  }
  for (const c of cities) c.captured = fresh.filter((x) => x.citySlug === c.slug).length;
  const pulled = new Set(cities.map((c) => c.slug));
  const inventory = prior.cars.filter((c) => !pulled.has(c.citySlug)).concat(fresh);
  const allCities = prior.cities.filter((c) => !pulled.has(c.slug)).concat(cities);

  // Fill body type for cars never seen on a body page, from the most common body of the same model.
  const byModel = {};
  for (const c of inventory) if (c.body) {
    const k = `${c.make}|${c.model}`;
    byModel[k] ??= {};
    byModel[k][c.body] = (byModel[k][c.body] || 0) + 1;
  }
  for (const c of inventory) if (!c.body && byModel[`${c.make}|${c.model}`])
    c.body = Object.entries(byModel[`${c.make}|${c.model}`]).sort((a, b) => b[1] - a[1])[0][0];

  const write = (url, data) => { const tmp = new URL(url.href + ".tmp"); writeFileSync(tmp, JSON.stringify(data, null, 1)); renameSync(tmp, url); };
  write(invPath, { source: "cars24.com city listing pages", capturedAt: started.toISOString(), count: inventory.length, cars: inventory });
  write(cityPath, { capturedAt: started.toISOString(), cities: allCities });
  return { cars: inventory.length, cities: allCities.length };
}

for (const slug of CITIES) {
  console.log(`→ ${slug}`);
  const r = await crawlCity(slug);
  if (!r) continue;
  cities.push(r.city);
  for (const c of r.cars) if (!byId.has(c.id) || !byId.get(c.id).body) byId.set(c.id, { ...byId.get(c.id), ...c, body: c.body || byId.get(c.id)?.body || null });
  const t = save();
  console.log(`  saved: ${t.cars} cars across ${t.cities} cities`);
  await sleep(DELAY_MS);
}
console.log("\nDone → data/inventory.json");
