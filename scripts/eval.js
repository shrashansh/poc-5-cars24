// Scores intent extraction on reworded buyer messages the rules were not tuned on.
// Each case lists only the fields it checks; a case passes when every listed field matches.
//
//   node scripts/eval.js            # rules only (no key needed)
//   node scripts/eval.js --llm      # rules vs OpenAI side by side (needs OPENAI_API_KEY)
import { loadInventory } from "../src/inventory.js";
import { parse } from "../src/parse.js";
import { normalise } from "../src/intent.js";
import { extract } from "../src/extract.js";
import { Store } from "../src/store.js";
import { llmEnabled } from "../src/config.js";

const CASES = [
  // brands, rejections
  ["Looking for a used Merc in my area", { brands: ["Mercedes-Benz"] }],
  ["I asked for a Benz, why is the app pushing Wagon R at me?", { brands: ["Mercedes-Benz"], rejectBrands: ["Maruti"] }],
  ["stop recommending maruti cars, not interested", { rejectBrands: ["Maruti"] }],
  ["any bmw or audi around?", { brands: ["BMW", "Audi"] }],
  ["Mujhe Mercedes chahiye", { brands: ["Mercedes-Benz"] }],
  ["Show me a Creta", { models: ["Creta"] }],
  ["Honda City dikhao", { models: ["City"] }],
  // budget
  ["budget is 20 lakhs max", { budgetMax: 20 }],
  ["something below ₹8 lakh", { budgetMax: 8 }],
  ["between 10 and 15 lakh", { budgetMin: 10, budgetMax: 15 }],
  ["15-20L range", { budgetMin: 15, budgetMax: 20 }],
  ["12 lakh tak ki gaadi", { budgetMax: 12 }],
  ["can stretch to 1.2 crore for the right car", { budgetMax: 120 }],
  ["I don't want to spend more than 6 lacs", { budgetMax: 6 }],
  // body / fuel / transmission
  ["no hatchbacks please", { excludeBodies: ["Hatchback"] }],
  ["hatchback mat dikhao", { excludeBodies: ["Hatchback"] }],
  ["I only want an SUV", { includeBodies: ["SUV"] }],
  ["need a 7 seater for the family", { includeBodies: ["MUV"] }],
  ["diesel only", { fuels: ["Diesel"] }],
  ["anything except diesel", { excludeFuels: ["Diesel"] }],
  ["must be automatic", { transmission: "Automatic" }],
  ["2019 or newer", { yearMin: 2019 }],
  // geography
  ["check within 150 km of me", { radiusKm: 150 }],
  ["look in Lucknow and Agra as well", { cities: ["lucknow", "agra"] }],
  ["What about cars in Delhi?", { cities: ["new delhi"] }],
  ["I've moved to Bangalore now", { homeCity: "bangalore" }],
  // calls
  ["please stop calling me", { callConsent: false }],
  ["why do your people keep phoning me? I never asked", { callConsent: false }],
  ["no calls, chat only", { callConsent: false }],
  ["can someone from your team ring me?", { callConsent: true }],
  ["I'd like to speak to an advisor", { callConsent: true }],
  // questions
  ["The car is HR26 registered and I stay in Noida, what paperwork?", { transfer: { regCode: "HR26", toCity: "noida" }, homeCity: null }],
  ["Do I need an NOC for a UP32 car if I'm in Lucknow?", { transfer: { regCode: "UP32", toCity: "lucknow" } }],
  ["what will the GLC cost me all-in?", { onRoad: { model: "GLC Class" } }],
  ["final price of the second one including transfer?", { onRoad: { listingRef: 2 } }],
  // widen / reset
  ["fine, show me other brands too", { widen: true }],
  ["let's start over", { clear: ["all"] }],
  ["forget the budget", { clear: ["budget"] }],
  // combined
  ["BMW X1 under 30 lakh, petrol, automatic, not older than 2018", { models: ["X1"], budgetMax: 30, fuels: ["Petrol"], transmission: "Automatic", yearMin: 2018 }],
  ["Seltos ya Creta, 14 lakh tak, diesel nahi chahiye", { budgetMax: 14, excludeFuels: ["Diesel"] }],
];

const same = (a, b) => JSON.stringify(typeof a === "object" && a ? Object.fromEntries(Object.entries(a).sort()) : a) === JSON.stringify(typeof b === "object" && b ? Object.fromEntries(Object.entries(b).sort()) : b);
function check(delta, want) {
  const misses = [];
  for (const [k, v] of Object.entries(want)) {
    let got = delta[k];
    if (Array.isArray(v)) { if (!v.every((x) => (got || []).includes(x))) misses.push(`${k}=${JSON.stringify(got)}`); continue; }
    if (v && typeof v === "object") { got = got || {}; for (const [kk, vv] of Object.entries(v)) if (!same(got[kk], vv)) misses.push(`${k}.${kk}=${JSON.stringify(got[kk])}`); continue; }
    if (!same(got, v)) misses.push(`${k}=${JSON.stringify(got)}`);
  }
  return misses;
}

try { loadInventory(); } catch { loadInventory(new URL("../test/fixtures/", import.meta.url)); }
const useLLM = process.argv.includes("--llm");
if (useLLM && !llmEnabled()) { console.error("--llm needs OPENAI_API_KEY"); process.exit(1); }
const store = new Store(null, { persist: false });

const score = { rules: 0, llm: 0 };
const rows = [];
for (const [text, want] of CASES) {
  const r = check(normalise(parse(text)), want);
  if (!r.length) score.rules++;
  let l = null;
  if (useLLM) { const ex = await extract(text, { store }); l = ex.source.startsWith("llm") ? check(ex.delta, want) : ["LLM failed: " + ex.error]; if (!l.length) score.llm++; }
  rows.push({ text, rules: r, llm: l });
}
for (const row of rows) {
  const mark = (m) => (m === null ? "" : m.length ? `✗ ${m.join(", ")}` : "✓");
  console.log(`${row.text.slice(0, 60).padEnd(62)} rules ${mark(row.rules).padEnd(30)} ${useLLM ? "llm " + mark(row.llm) : ""}`);
}
const pct = (n) => `${n}/${CASES.length} (${Math.round((100 * n) / CASES.length)}%)`;
console.log(`\nRules: ${pct(score.rules)}${useLLM ? `   LLM: ${pct(score.llm)}` : ""}`);
