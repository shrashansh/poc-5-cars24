// The intent delta: what one buyer message changes. Both extractors (OpenAI and rules) return this
// shape, and normalise() is the single gate that cleans it before it touches a profile.
import { inventory, findCity } from "./inventory.js";
import { CITY_STATE, STATE_CODES, CITY_ALIAS } from "./rules.js";

export const BODIES = ["Hatchback", "Sedan", "SUV", "MUV", "Coupe", "Convertible"];
export const FUELS = ["Petrol", "Diesel", "CNG", "Electric", "Hybrid"];
export const CLEARABLE = ["brands", "models", "budget", "bodies", "cities", "radius", "fuels", "transmission", "year", "km", "rejections", "all"];
export const INTENTS = ["search", "question", "complaint", "preference", "call_request", "call_refuse", "reset", "other"];

export const emptyDelta = () => ({
  intent: "other", brands: [], models: [], rejectBrands: [], rejectModels: [], cities: [], homeCity: null, useCurrentLocation: false,
  budgetMin: null, budgetMax: null, radiusKm: null, includeBodies: [], excludeBodies: [], fuels: [], excludeFuels: [],
  transmission: null, yearMin: null, kmMax: null, callConsent: null, transfer: null, onRoad: null, widen: false, clear: [],
});

const nullable = (type) => ({ type: [type, "null"] });
const strArr = (desc, items = { type: "string" }) => ({ type: "array", items, description: desc });

// OpenAI structured-output schema (strict mode: every key required, nulls for "not mentioned").
export const DELTA_SCHEMA = {
  type: "object", additionalProperties: false,
  required: Object.keys(emptyDelta()),
  properties: {
    intent: { type: "string", enum: INTENTS, description: "Main purpose of the message" },
    brands: strArr("Car brands the buyer wants, canonical names (e.g. Mercedes-Benz, BMW, Maruti, Hyundai)"),
    models: strArr("Specific models the buyer wants (e.g. GLC, Creta, City)"),
    rejectBrands: strArr("Brands the buyer complained about, refused, or does not want to see"),
    rejectModels: strArr("Models the buyer complained about or refused"),
    cities: strArr("Cities to search in (lower-case), excluding the buyer's own city unless they ask for it"),
    homeCity: { ...nullable("string"), description: "The buyer's own city if they state it (\"I live in Delhi\"), lower-case" },
    useCurrentLocation: { type: "boolean", description: "Buyer asked to use their current location" },
    budgetMin: { ...nullable("number"), description: "Minimum budget in lakh rupees" },
    budgetMax: { ...nullable("number"), description: "Maximum budget in lakh rupees (1 crore = 100)" },
    radiusKm: { ...nullable("number"), description: "Search radius in km if stated" },
    includeBodies: strArr("Body types the buyer wants", { type: "string", enum: BODIES }),
    excludeBodies: strArr("Body types the buyer does not want", { type: "string", enum: BODIES }),
    fuels: strArr("Fuel types wanted", { type: "string", enum: FUELS }),
    excludeFuels: strArr("Fuel types not wanted", { type: "string", enum: FUELS }),
    transmission: { type: ["string", "null"], enum: ["Manual", "Automatic", null] },
    yearMin: { ...nullable("number"), description: "Oldest acceptable model year" },
    kmMax: { ...nullable("number"), description: "Maximum odometer km" },
    callConsent: { ...nullable("boolean"), description: "false if the buyer refuses or complains about calls, true if they ask for a call, else null" },
    transfer: {
      type: ["object", "null"], additionalProperties: false, required: ["regCode", "regState", "toCity"],
      description: "Set when the buyer asks about RC / ownership transfer or NOC",
      properties: { regCode: { ...nullable("string"), description: "e.g. UP78" }, regState: nullable("string"), toCity: { ...nullable("string"), description: "City the car will be registered in, lower-case" } },
    },
    onRoad: {
      type: ["object", "null"], additionalProperties: false, required: ["model", "listingRef"],
      description: "Set when the buyer asks for on-road / total / final cost of a car",
      properties: { model: nullable("string"), listingRef: { ...nullable("number"), description: "1-based index if they refer to 'the first/second car' shown" } },
    },
    widen: { type: "boolean", description: "Buyer explicitly agrees to see other brands, cheaper segments or a wider budget" },
    clear: strArr("Things the buyer asks to forget or reset", { type: "string", enum: CLEARABLE }),
  },
};

const uniq = (a) => [...new Set(a)];
const num = (v, lo, hi) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null);

// Map whatever the extractor said onto names that exist in the inventory.
export function canonicalMake(s) {
  if (!s) return null;
  const k = String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const alias = { mercedes: "Mercedes-Benz", "mercedes benz": "Mercedes-Benz", merc: "Mercedes-Benz", benz: "Mercedes-Benz", "maruti suzuki": "Maruti", suzuki: "Maruti", vw: "Volkswagen", "land rover": "Land Rover", "range rover": "Land Rover", "mg motor": "MG" };
  if (alias[k]) return alias[k];
  return inventory().vocab.makes.find((m) => m.toLowerCase().replace(/[^a-z0-9]+/g, " ") === k) || null;
}

export function canonicalModel(s) {
  if (!s) return null;
  const k = String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const models = inventory().vocab.models;
  return models.find((m) => m.model.toLowerCase().replace(/[^a-z0-9]+/g, " ") === k)
    || models.find((m) => m.model.toLowerCase().replace(/[^a-z0-9]+/g, " ").startsWith(k + " "))
    || null;
}

const cityKey = (s) => {
  if (!s) return null;
  const k = String(s).toLowerCase().trim().replace(/-/g, " ");
  return CITY_ALIAS[k] || k;
};
const knownCity = (s) => Boolean(findCity(s) || CITY_STATE[cityKey(s)]);

export function normalise(raw) {
  const d = { ...emptyDelta(), ...(raw || {}) };
  const out = emptyDelta();
  out.intent = INTENTS.includes(d.intent) ? d.intent : "other";

  const models = (d.models || []).map(canonicalModel).filter(Boolean);
  out.models = uniq(models.map((m) => m.model));
  out.brands = uniq([...(d.brands || []).map(canonicalMake), ...models.map((m) => m.make)].filter(Boolean));
  const rejModels = (d.rejectModels || []).map(canonicalModel).filter(Boolean);
  out.rejectModels = uniq(rejModels.map((m) => m.model));
  out.rejectBrands = uniq((d.rejectBrands || []).map(canonicalMake).filter(Boolean)).filter((b) => !out.brands.includes(b));

  out.cities = uniq((d.cities || []).map(cityKey).filter(knownCity));
  out.homeCity = d.homeCity && knownCity(d.homeCity) ? cityKey(d.homeCity) : null;
  out.useCurrentLocation = d.useCurrentLocation === true;

  out.budgetMax = num(d.budgetMax, 0.5, 500);
  out.budgetMin = num(d.budgetMin, 0, 500);
  if (out.budgetMin && out.budgetMax && out.budgetMin > out.budgetMax) [out.budgetMin, out.budgetMax] = [out.budgetMax, out.budgetMin];
  out.radiusKm = num(d.radiusKm, 1, 2500);
  out.includeBodies = uniq((d.includeBodies || []).filter((b) => BODIES.includes(b)));
  out.excludeBodies = uniq((d.excludeBodies || []).filter((b) => BODIES.includes(b) && !out.includeBodies.includes(b)));
  out.fuels = uniq((d.fuels || []).filter((f) => FUELS.includes(f)));
  out.excludeFuels = uniq((d.excludeFuels || []).filter((f) => FUELS.includes(f) && !out.fuels.includes(f)));
  out.transmission = ["Manual", "Automatic"].includes(d.transmission) ? d.transmission : null;
  out.yearMin = num(d.yearMin, 1990, new Date().getFullYear() + 1);
  out.kmMax = num(d.kmMax, 1000, 1000000);
  out.callConsent = typeof d.callConsent === "boolean" ? d.callConsent : null;

  if (d.transfer && typeof d.transfer === "object") {
    const code = String(d.transfer.regCode || "").toUpperCase().replace(/[^A-Z0-9]/g, "").match(/^[A-Z]{2}\d{1,2}/)?.[0] || null;
    const st = d.transfer.regState ? Object.values(STATE_CODES).find((s) => s.toLowerCase() === String(d.transfer.regState).toLowerCase()) || STATE_CODES[String(d.transfer.regState).toUpperCase()] || null : null;
    out.transfer = { regCode: code, regState: st || (code ? STATE_CODES[code.slice(0, 2)] || null : null), toCity: d.transfer.toCity && knownCity(d.transfer.toCity) ? cityKey(d.transfer.toCity) : null };
  }
  // A city stated inside an RC-transfer question is where that car would be registered, not a move.
  if (out.transfer && out.homeCity) { out.transfer.toCity ||= out.homeCity; out.homeCity = null; }
  if (d.onRoad && typeof d.onRoad === "object") {
    const m = canonicalModel(d.onRoad.model);
    out.onRoad = { model: m ? m.model : d.onRoad.model ? String(d.onRoad.model).slice(0, 40) : null, listingRef: num(d.onRoad.listingRef, 1, 50) };
  }
  out.widen = d.widen === true;
  out.clear = uniq((d.clear || []).filter((c) => CLEARABLE.includes(c)));
  return out;
}
