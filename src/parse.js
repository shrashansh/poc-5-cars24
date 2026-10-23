// Rule-based extractor. Runs when OPENAI_API_KEY is missing or the LLM call fails, so the product
// never stops answering. Returns the same raw shape as the LLM; normalise() cleans both.
import { inventory } from "./inventory.js";
import { CITY_STATE, LUXURY_BRANDS } from "./rules.js";
import { emptyDelta } from "./intent.js";

export const BRAND_ALIASES = {
  "Mercedes-Benz": ["mercedes", "merc", "benz"], BMW: ["bmw"], Maruti: ["maruti", "suzuki"], Volkswagen: ["volkswagen", "vw"],
  "Land Rover": ["land rover", "range rover"], Hyundai: ["hyundai", "hundai"], Mahindra: ["mahindra"], Toyota: ["toyota"],
};
// Model names that are also everyday words; they count only after their brand ("honda city").
const AMBIGUOUS_MODELS = new Set(["city", "go", "go+", "plus", "new", "one", "venue", "glide", "magnite", "aura", "duster", "s", "zen", "eon", "jazz", "brio", "quanto", "punch", "nexon", "compass", "verna", "thar"]);
const SAFE_AFTER_BRAND_ONLY = new Set(["city", "go", "go+", "plus", "new", "one", "glide", "s", "zen", "eon", "jazz", "venue"]);
const BODY_WORDS = { Hatchback: ["hatchback", "hatchbacks", "hatch"], Sedan: ["sedan", "sedans"], SUV: ["suv", "suvs"], MUV: ["muv", "muvs", "mpv", "7 seater", "7-seater"] };
const FUEL_WORDS = { Petrol: ["petrol"], Diesel: ["diesel"], CNG: ["cng"], Electric: ["electric", "ev"], Hybrid: ["hybrid"] };
export const NEG = /(why am i seeing|why are you showing|recommending me|instead of|don'?t want|do not want|not interested|stop showing|no more|don'?t show|do not show|never show|hate|nahi chahiye|mat dikhao|without)/;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const has = (t, w) => new RegExp(`(^|[^a-z0-9])${esc(w)}([^a-z0-9]|$)`).test(t);

function brandKeys() {
  const out = {};
  for (const m of inventory().vocab.makes) out[m] = [m.toLowerCase()];
  for (const [m, keys] of Object.entries(BRAND_ALIASES)) out[m] = [...new Set([...(out[m] || []), ...keys])];
  return out;
}

export function parse(text) {
  const t = String(text).toLowerCase().replace(/[’‘]/g, "'");
  const d = emptyDelta();
  const brands = brandKeys();

  for (const sentence of t.split(/[.?!\n]/)) {
    if (!sentence.trim()) continue;
    const negative = NEG.test(sentence);
    for (const [brand, keys] of Object.entries(brands)) {
      if (!keys.some((k) => has(sentence, k))) continue;
      // A luxury brand in a complaint ("I searched Mercedes, why Baleno") is still what they want.
      const list = negative && !LUXURY_BRANDS.includes(brand) ? d.rejectBrands : d.brands;
      if (!list.includes(brand)) list.push(brand);
    }
    for (const { make, model } of inventory().vocab.models) {
      const k = model.toLowerCase();
      if (k.length < 2) continue;
      const brandKeyed = (brands[make] || []).some((b) => has(sentence, `${b} ${k}`));
      if (!brandKeyed && (SAFE_AFTER_BRAND_ONLY.has(k) || k.length < 3 || !has(sentence, k))) continue;
      if (AMBIGUOUS_MODELS.has(k) && !brandKeyed && !/\b(show|want|looking|buy|any|find|search)\b/.test(sentence)) continue;
      const list = negative ? d.rejectModels : d.models;
      if (!list.includes(model)) list.push(model);
      if (!negative && !d.brands.includes(make)) d.brands.push(make);
      if (negative && !LUXURY_BRANDS.includes(make) && !d.rejectBrands.includes(make) && !d.brands.includes(make)) d.rejectBrands.push(make);
    }
  }

  for (const [body, words] of Object.entries(BODY_WORDS)) {
    for (const w of words) {
      if (!has(t, w)) continue;
      const neg = new RegExp(`(no|don'?t|do not|not|exclude|without|never|except|nahi|mat)[^.]{0,40}?${esc(w)}`).test(t) || new RegExp(`${esc(w)}[^.]{0,15}?(nahi|mat|not)`).test(t);
      (neg ? d.excludeBodies : d.includeBodies).push(body);
      break;
    }
  }
  for (const [fuel, words] of Object.entries(FUEL_WORDS)) {
    for (const w of words) {
      if (!has(t, w)) continue;
      const neg = new RegExp(`(no|don'?t|not|without|never|except)[^.]{0,25}?${esc(w)}`).test(t);
      (neg ? d.excludeFuels : d.fuels).push(fuel);
      break;
    }
  }
  if (/\b(automatic|auto gear|amt|cvt|dct)\b/.test(t)) d.transmission = "Automatic";
  else if (/\bmanual\b/.test(t)) d.transmission = "Manual";

  const amount = (n, unit) => (/^(cr|crore)/.test(unit) ? n * 100 : /^k$/.test(unit) ? n / 100 : n);
  const unit = "(l|lakh|lakhs|lac|lacs|lk|cr|crore|crores)\\b";
  const range = t.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:-|to)\\s*(\\d+(?:\\.\\d+)?)\\s*${unit}`));
  const max = t.match(new RegExp(`(under|below|upto|up to|within|max|maximum|less than|budget(?: is| of)?|around|about|tak)\\s*(?:rs\\.?|₹|inr)?\\s*(\\d+(?:\\.\\d+)?)\\s*${unit}`)) || t.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${unit}\\s*(tak|max|or less|budget)`));
  if (range) { d.budgetMin = amount(+range[1], range[3]); d.budgetMax = amount(+range[2], range[3]); }
  else if (max) d.budgetMax = max[1].match(/\d/) ? amount(+max[1], max[2]) : amount(+max[2], max[3]);
  if (/(above|over|more than|at least|minimum)\s*(?:rs\.?|₹)?\s*(\d+(?:\.\d+)?)\s*(l|lakh|lakhs|lac)\b/.test(t)) d.budgetMin = +t.match(/(above|over|more than|at least|minimum)\s*(?:rs\.?|₹)?\s*(\d+(?:\.\d+)?)/)[2];

  const radius = t.match(/(\d{2,4})\s*(km|kms|kilometer|kilometre)/);
  if (radius && !/\b(driven|run|odometer|done)\b/.test(t)) d.radiusKm = parseInt(radius[1], 10);
  const kmMax = t.match(/(?:under|below|less than|max)\s*(\d[\d,]*)\s*(k|km|kms)\s*(driven|run)?/);
  if (kmMax && /driven|run|odometer/.test(t)) { d.kmMax = parseInt(kmMax[1].replace(/,/g, ""), 10) * (kmMax[2] === "k" ? 1000 : 1); d.radiusKm = null; }
  const y = t.match(/\b(after|newer than|since|from)\s+(20\d\d)\b/) || t.match(/\b(20\d\d)\s*(?:or|and|\+)\s*(?:newer|above|later|onwards)/);
  if (y) d.yearMin = Number(y[2] || y[1]) + (y[1] === "after" ? 1 : 0);

  const live = t.match(/\b(?:i live in|i stay in|i'm in|i am in|i'm from|i am from|based in|located in|my city is)\s+([a-z ]+?)(?:[,.?!]|$| and| what| so| but)/);
  if (live && CITY_STATE[live[1].trim()]) d.homeCity = live[1].trim();
  for (const c of Object.keys(CITY_STATE)) if (has(t, c) && c !== d.homeCity) d.cities.push(c);

  if (/(don'?t|do not|no|stop|never|mat)\s+(call|phone|ring)|without my consent|not requesting.*call|calls? (?:me )?without|unwanted calls?|stop calling|why am i (?:receiving|getting) calls/.test(t)) d.callConsent = false;
  else if (/\b(call me|call back|callback|talk to (?:an |a )?(?:advisor|agent|person|human)|have an advisor call|advisor call|speak to (?:an |a )?(?:advisor|person|human))\b/.test(t)) d.callConsent = true;

  if (/on-?road|total cost|final price|all[- ]in|including transfer|landed cost/.test(t)) {
    const ref = t.match(/\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\b/);
    const idx = ref ? ["first", "second", "third", "fourth", "fifth"].indexOf(ref[1].replace(/(st|nd|rd|th)$/, "")) : -1;
    const n = ref && /^\d/.test(ref[1]) ? parseInt(ref[1], 10) : idx + 1;
    // Buyers name a model by its first word ("the GLC" for "GLC Class"), so match that too.
    const named = d.models[0] || inventory().vocab.models.find(({ model }) => {
      const head = model.toLowerCase().split(" ")[0];
      return head.length >= 3 && !AMBIGUOUS_MODELS.has(head) && has(t, head);
    })?.model;
    d.onRoad = { model: named || null, listingRef: ref ? n : null };
  }
  const reg = t.match(/\b([a-z]{2})\s?-?(\d{2})\b/);
  if (!d.onRoad && /transfer|noc|\brc\b|registration|registered|re-?register/.test(t)) {
    d.transfer = { regCode: reg ? `${reg[1]}${reg[2]}` : null, regState: /\bup\b|uttar pradesh/.test(t) && !reg ? "Uttar Pradesh" : null, toCity: d.homeCity || null };
    // "I live in Delhi, what's the transfer process?" is context for this question, not a move.
    if (d.homeCity) { d.transfer.toCity = d.homeCity; d.homeCity = null; }
    const to = t.match(/\btransferr?ed to ([a-z ]+?)(?:[,.?!]|$| and)/);
    if (to && CITY_STATE[to[1].trim()]) d.transfer.toCity = to[1].trim();
    d.cities = d.cities.filter((c) => c !== d.transfer.toCity);
  }

  if (/current location|my location|near me|nearby/.test(t)) d.useCurrentLocation = true;
  if (/\b(other brands are fine|show (?:me )?anything|any brand|open to other|cheaper (?:is|are) (?:fine|ok)|widen|expand (?:the )?search|increase (?:my )?budget)\b/.test(t)) d.widen = true;

  if (/\b(start over|reset|forget everything|clear (?:all|everything)|new search)\b/.test(t)) d.clear.push("all");
  if (/\b(forget|remove|ignore|drop|no)\s+(?:the |my )?budget\b|budget (?:doesn'?t|does not) matter/.test(t)) d.clear.push("budget");
  if (/\b(forget|remove|clear)\s+(?:the |my )?(?:brands?)\b/.test(t)) d.clear.push("brands");
  if (/\b(hatchbacks? (?:are|is) (?:fine|ok|okay) now|show hatchbacks? again)\b/.test(t)) d.clear.push("bodies");

  if (d.clear.includes("all")) d.intent = "reset";
  else if (d.callConsent === false && !d.brands.length) d.intent = "call_refuse";
  else if (d.callConsent === true) d.intent = "call_request";
  else if (d.transfer || d.onRoad) d.intent = "question";
  else if (d.rejectBrands.length || /why am i|why are you|wrong|useless|not what i/.test(t)) d.intent = d.brands.length ? "search" : "complaint";
  else if (d.brands.length || d.models.length || d.budgetMax || d.cities.length || d.radiusKm || d.includeBodies.length || /\b(show|search|find|any|available|recommend|looking for|want|need|chahiye)\b/.test(t)) d.intent = "search";
  else if (d.excludeBodies.length || d.excludeFuels.length) d.intent = "preference";
  return d;
}
