// Message → intent delta. OpenAI first (with the buyer's profile and recent turns as context, so
// "yes", "Lucknow, Agra…" or "the first one" resolve), rules as the fallback. Output always passes
// through normalise(), so a bad LLM answer can't put an unknown brand or a ₹0 budget into a profile.
import { chatJSON } from "./llm.js";
import { parse, NEG, BRAND_ALIASES, has } from "./parse.js";
import { DELTA_SCHEMA, normalise } from "./intent.js";
import { inventory } from "./inventory.js";
import { llmEnabled } from "./config.js";
import { CITY_ALIAS } from "./rules.js";

// A brand counts as named if the message has the brand, an alias, or the first word of one of its models.
const mentionsBrand = (t, brand) => {
  const keys = [brand.toLowerCase(), ...(BRAND_ALIASES[brand] || [])];
  if (keys.some((k) => has(t, k))) return true;
  return inventory().vocab.models.some((m) => m.make === brand && m.model.length >= 3 && has(t, m.model.toLowerCase().split(" ")[0]));
};
const mentionsModel = (t, model) => has(t, model.toLowerCase()) || has(t, model.toLowerCase().split(" ")[0]);

const mentionsCity = (t, city) => [city, CITY_ALIAS[city], ...Object.keys(CITY_ALIAS).filter((a) => CITY_ALIAS[a] === city)]
  .filter(Boolean).some((c) => new RegExp(`\\b${c}\\b`).test(t));

const SYSTEM = `You extract a used-car buyer's intent from ONE chat message on Cars24 India.
Rules:
- Extract only what this message states or clearly confirms. Use the context only to resolve references ("yes", "there", "that one", a bare list of cities). context.latestIntents is newest first: resolve an ambiguous reference to the most recent intent.
- A brand named in a complaint about recommendations ("why am I seeing Baleno") goes to rejectBrands/rejectModels — unless it is the brand they say they searched for.
- Budgets are in lakh rupees: "20 lakhs" = 20, "1.5 cr" = 150, "15-20L" = min 15 max 20.
- "don't show X", "no X" for a body type → excludeBodies. Complaints about calls, or "don't call" → callConsent false. "call me" → true.
- Questions about RC transfer / NOC / registration → transfer. Questions about on-road / total / final cost → onRoad.
- "I live in X" → homeCity, EXCEPT inside an RC transfer question, where that city goes to transfer.toCity and homeCity stays null. Cities to search go in cities (lower-case).
- A model named only in a question (on-road cost, transfer) goes in onRoad.model, not models.
- Asking for a new brand is NOT a rejection of brands asked for earlier. rejectBrands needs an explicit complaint or refusal in this message.
- widen=true only if the buyer explicitly accepts other brands, cheaper cars, or a higher budget. A bigger radius or more cities is not widen.
- Hindi/Hinglish is common ("20 lakh tak", "hatchback mat dikhao" = exclude hatchback).
Known brands: {{BRANDS}}.`;

export async function extract(text, { profile, priorities = [], recent = [], store, fetchImpl } = {}) {
  const rules = () => ({ source: "rules", delta: normalise(parse(text)) });
  if (!llmEnabled()) return rules();
  const ctx = {
    homeCity: profile?.homeCity, brands: profile?.brands,
    // Remembered intents, newest first. When this message is ambiguous, the most recent intent wins.
    latestIntents: priorities.filter((x) => x.kind !== "constraint").slice(0, 6).map((x) => x.label),
    budgetMax: profile?.budgetMax, radiusKm: profile?.radiusKm,
    lastShown: (profile?.lastShown || []).slice(0, 5).map((c, i) => `${i + 1}. ${c.title}`),
    recentTurns: recent.slice(-4).map((m) => `${m.role}: ${String(m.text).slice(0, 300)}`),
  };
  try {
    const r = await chatJSON({
      store, fetchImpl, name: "intent_delta", schema: DELTA_SCHEMA,
      messages: [
        { role: "system", content: SYSTEM.replace("{{BRANDS}}", inventory().vocab.makes.join(", ")) },
        { role: "user", content: `Context: ${JSON.stringify(ctx)}\n\nMessage: ${text}` },
      ],
    });
    const delta = normalise(r.data);
    // The rules are precise on call consent and RC codes; keep them if the LLM missed them.
    const ruled = normalise(parse(text));
    // Rejections and widening change what the buyer sees everywhere, so they need words in the
    // message that say so; the LLM sometimes infers them from context.
    const t = text.toLowerCase();
    if (!NEG.test(t) && !/\b(no|not|don'?t|stop|never|hate|without|except)\b/.test(t)) { delta.rejectBrands = []; delta.rejectModels = []; }
    if (!/\b(other|any|anything|else|cheaper|widen|expand|more brands|open to|increase|stretch|higher)\b/.test(t)) delta.widen = false;
    if (!/\b(forget|remove|clear|reset|start over|ignore|drop|new search|fresh|doesn'?t matter|does not matter|again)\b/.test(t)) delta.clear = [];
    // Asking for a brand unblocks it, so a brand the LLM carried over from context must not count
    // unless this message names it.
    delta.brands = delta.brands.filter((b) => mentionsBrand(t, b));
    delta.models = delta.models.filter((m) => mentionsModel(t, m));
    delta.rejectBrands = delta.rejectBrands.filter((b) => mentionsBrand(t, b));
    // "near me" is not a radius; only a number with km in the message sets one (else the radius stays automatic).
    if (!/\d\s*(km|kms|kilomet)/.test(t)) delta.radiusKm = null;
    // Moving the buyer's home city re-scopes every search, so the message itself must name the city.
    if (delta.homeCity && !mentionsCity(t, delta.homeCity)) delta.homeCity = null;
    if (delta.callConsent === null && ruled.callConsent !== null) delta.callConsent = ruled.callConsent;
    if (delta.transfer && !delta.transfer.regCode && ruled.transfer?.regCode) delta.transfer = { ...ruled.transfer, toCity: delta.transfer.toCity || ruled.transfer.toCity };
    return { source: r.cached ? "llm-cache" : "llm", delta, usage: r.usage, ms: r.ms };
  } catch (e) {
    return { ...rules(), error: e.message };
  }
}
