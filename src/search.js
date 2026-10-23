// Search with a fallback ladder that keeps the buyer's intent. CarGPT today searches Assured stock
// only and, when that's empty, falls back to cheap cars nearby. This searches every seller type and
// only widens in steps the buyer would accept:
//   1. requested brands in the home city
//   2. requested brands in other cities within the radius, or cities the buyer named
//   3. other brands the buyer asked for earlier
//   4. same segment, other brands (luxury stays luxury)
//   5. everything else is withheld and counted, shown only if the buyer opts in
import { inventory, findCity, roadKm } from "./inventory.js";
import { LUXURY_BRANDS } from "./rules.js";
import { lakh } from "./profile.js";

const PER_STEP = 6;

export function baseFilter(p) {
  return (c) =>
    (!p.budgetMax || c.priceLakh <= p.budgetMax) && (!p.budgetMin || c.priceLakh >= p.budgetMin)
    && !p.excludeBodies.includes(c.body) && (!p.includeBodies.length || p.includeBodies.includes(c.body))
    && !p.excludeFuels.includes(c.fuel) && (!p.fuels.length || p.fuels.includes(c.fuel))
    && (!p.transmission || c.transmission === p.transmission)
    && (!p.yearMin || c.year >= p.yearMin) && (!p.kmMax || (c.km ?? 0) <= p.kmMax)
    && !p.rejectBrands.includes(c.make) && !p.rejectModels.includes(c.model) && !p.rejectedIds.includes(c.id);
}

// Which cities are in scope, with estimated road distance from home.
export function scope(p) {
  const home = findCity(p.homeCity);
  const named = p.cities.map(findCity).filter(Boolean);
  const all = inventory().cities.map((c) => ({ ...c, km: home ? roadKm(home, c) : null }));
  const inRadius = all.filter((c) => home && c.slug !== home.slug && c.km !== null && c.km <= p.radiusKm);
  const extra = named.filter((n) => !inRadius.some((c) => c.slug === n.slug) && (!home || n.slug !== home.slug)).map((n) => all.find((c) => c.slug === n.slug));
  return { home, nearby: [...inRadius, ...extra].sort((a, b) => (a.km ?? 1e9) - (b.km ?? 1e9)), all };
}

function rank(p, list) {
  const target = p.budgetMax || null;
  return list.sort((a, b) => score(b) - score(a));
  function score(c) {
    let s = 0;
    if (p.models.includes(c.model)) s += 50;
    if (p.focus.includes(c.make)) s += 20;
    if (target) s += 15 * (c.priceLakh / target); // closer to the top of budget = more car for the money
    s += Math.max(0, (c.year || 2005) - 2005) * 1.2;
    s -= (c.km || 80000) / 20000;
    if (c._km) s -= c._km / 60;
    return s;
  }
}

const card = (c, km = 0) => ({ ...c, title: `${c.year} ${c.make} ${c.model}`, distanceKm: km });

export function search(p) {
  const { home, nearby, all } = scope(p);
  const fits = baseFilter(p);
  const cars = inventory().cars;
  const kmOf = Object.fromEntries(all.map((c) => [c.slug, c.km]));
  const inHome = (c) => home && c.citySlug === home.slug;
  const inNearby = (c) => nearby.some((n) => n.slug === c.citySlug);
  const focus = p.focus.length ? p.focus : p.brands;
  const others = p.brands.filter((b) => !focus.includes(b));
  const wantModel = (c) => !p.models.length || !focus.includes(c.make) || p.models.includes(c.model) || !p.models.some((m) => cars.some((x) => x.make === c.make && x.model === m));
  const seen = new Set();
  const take = (list) => {
    const fresh = rank(p, list.filter((c) => !seen.has(c.id)).map((c) => ({ ...c, _km: kmOf[c.citySlug] ?? 0 })));
    fresh.forEach((c) => seen.add(c.id));
    return { total: fresh.length, cars: fresh.slice(0, PER_STEP).map((c) => card(c, kmOf[c.citySlug] ?? 0)) };
  };

  const steps = [];
  const where = home ? home.name : "your city";
  const budget = p.budgetMax ? ` ≤ ${lakh(p.budgetMax)}` : "";
  if (focus.length) {
    steps.push({ key: "exact", label: `${focus.join(" / ")}${p.models.length ? ` (${p.models.join(", ")})` : ""} in ${where}${budget}`, ...take(cars.filter((c) => inHome(c) && focus.includes(c.make) && wantModel(c) && fits(c))) });
    steps.push({ key: "nearby", label: `${focus.join(" / ")} within ${p.radiusKm} km${p.cities.length ? ` + ${p.cities.join(", ")}` : ""}`, ...take(cars.filter((c) => inNearby(c) && focus.includes(c.make) && wantModel(c) && fits(c))) });
    if (others.length) steps.push({ key: "saved", label: `${others.join(" / ")} (asked earlier)`, ...take(cars.filter((c) => (inHome(c) || inNearby(c)) && others.includes(c.make) && fits(c))) });
    const lux = p.tier === "luxury";
    // "Similar" for a mass-market model means the same body type (a Creta buyer sees SUVs, not hatchbacks).
    const modelBodies = new Set(cars.filter((c) => p.models.includes(c.model) && c.body).map((c) => c.body));
    const sameSeg = (c) => (lux ? LUXURY_BRANDS.includes(c.make) : p.widened || (!LUXURY_BRANDS.includes(c.make) && (!modelBodies.size || modelBodies.has(c.body))));
    steps.push({ key: "segment", label: lux ? `Other luxury brands near ${where}${budget}` : `Similar cars from other brands near ${where}${budget}`, ...take(cars.filter((c) => (inHome(c) || inNearby(c)) && !p.brands.includes(c.make) && sameSeg(c) && fits(c))) });
    if (p.widened) steps.push({ key: "widened", label: `Anything else that fits your filters near ${where}`, ...take(cars.filter((c) => (inHome(c) || inNearby(c)) && fits(c))) });
  } else {
    steps.push({ key: "exact", label: `Cars in ${where} that fit your filters`, ...take(cars.filter((c) => inHome(c) && fits(c))) });
    steps.push({ key: "nearby", label: `Within ${p.radiusKm} km${p.cities.length ? ` + ${p.cities.join(", ")}` : ""}`, ...take(cars.filter((c) => inNearby(c) && fits(c))) });
  }

  // Beyond the radius: say where the nearest matching stock is instead of saying "not available".
  const wanted = (c) => (focus.length ? focus.includes(c.make) : true) && fits(c);
  const farCounts = {};
  for (const c of cars) if (wanted(c) && !inHome(c) && !inNearby(c)) farCounts[c.citySlug] = (farCounts[c.citySlug] || 0) + 1;
  const beyond = Object.entries(farCounts).map(([slug, n]) => ({ city: all.find((c) => c.slug === slug)?.name || slug, km: kmOf[slug] ?? null, count: n })).sort((a, b) => (a.km ?? 1e9) - (b.km ?? 1e9)).slice(0, 4);

  const shownIds = new Set(steps.flatMap((s) => s.cars.map((c) => c.id)));
  const withheld = cars.filter((c) => (inHome(c) || inNearby(c)) && !shownIds.has(c.id) && !seen.has(c.id)).length;
  return {
    home: home ? { name: home.name, totalListed: home.totalListed, assuredServiceable: home.assuredServiceable } : null,
    citiesSearched: [home?.name, ...nearby.map((n) => `${n.name} (~${n.km} km)`)].filter(Boolean),
    steps, beyond, withheld,
    shown: steps.flatMap((s) => s.cars),
    matched: steps.reduce((n, s) => n + s.total, 0),
  };
}
