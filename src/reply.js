// Writes the chat reply. Cars, prices and answers come from the engine; the LLM only phrases them.
// A guard rejects any LLM reply that mentions a price or model not in the facts, says "not
// available" when stock exists, or promises a call that isn't booked. On rejection (or with no
// API key) a template reply is used, so the buyer never sees an invented car or promise.
import { chatJSON } from "./llm.js";
import { inventory } from "./inventory.js";
import { lakh } from "./profile.js";
import { llmEnabled } from "./config.js";

const REPLY_SCHEMA = { type: "object", additionalProperties: false, required: ["reply"], properties: { reply: { type: "string" } } };

const SYSTEM = `You are CarGPT, the Cars24 India car-buying assistant. Write the reply to the buyer's latest message using ONLY the facts JSON.
- Max 90 words. Plain text, no markdown, no lists of more than 3 cars (the app shows car cards below your text).
- Mention cars only from facts.cars, with their exact price. Never invent stock, prices, fees or timelines.
- If facts.searchRan is false, this message needed no search: answer it and do not mention searching, availability or stock.
- If facts.searchRan is true and facts.cars is empty but facts.beyond has cities, say where the nearest matching cars are and offer to widen the radius.
- State each item in facts.commitments as done (e.g. "Done: no hatchbacks anywhere in your feed").
- If facts.answers exist, give the answer directly. Do not say an advisor will check.
- Only say an advisor will call if facts.escalation.call is true. If facts.escalation.ask is true, ask whether they want a call or prefer chat.
- Never say a city is "not serviceable"; Cars24 lists cars from direct sellers there.
- Match the buyer's language (English or Hinglish).`;

export function factsFor(turn) {
  const s = turn.search;
  return {
    buyerMessage: turn.text,
    // Without a search this turn the profile only invites guesses about stock, so it is left out.
    profile: s ? turn.profileSummary : null,
    searchRan: Boolean(s),
    commitments: turn.commitments.map((c) => c.promise),
    answers: turn.answers.map((a) => ({ type: a.type, resolved: a.resolved, text: a.text, steps: a.steps, lines: a.lines })),
    cars: s ? s.shown.slice(0, 6).map((c) => ({ title: `${c.year} ${c.make} ${c.model}`, price: lakh(c.priceLakh), city: c.city, distanceKm: c.distanceKm })) : [],
    steps: s ? s.steps.map((x) => ({ label: x.label, found: x.total })) : [],
    beyond: s ? s.beyond : [],
    withheldCheaperOrOtherSegment: s ? s.withheld : 0,
    citiesSearched: s ? s.citiesSearched : [],
    escalation: turn.escalation,
    needs: turn.needs,
  };
}

export function guard(text, facts) {
  const problems = [];
  // Any amount that appears in the facts (car prices, the buyer's budget, their own message, answers) is allowed.
  const prices = new Set(facts.cars.map((c) => String(Number(c.price.replace(/[₹L\s]/g, "")))));
  for (const m of JSON.stringify(facts).matchAll(/(?:₹\s?|\b)(\d+(?:\.\d+)?)\s*(?:l\b|lakh|lac|L\b)/gi)) prices.add(String(Number(m[1])));
  for (const m of text.matchAll(/₹\s?(\d+(?:\.\d+)?)\s*(?:l|lakh|lac)/gi)) if (!prices.has(String(Number(m[1])))) problems.push(`price ₹${m[1]}L not in facts`);
  const allowed = (facts.cars.map((c) => c.title).join(" ") + " " + JSON.stringify(facts.profile) + " " + JSON.stringify(facts.answers) + " " + facts.buyerMessage).toLowerCase();
  for (const { model } of inventory().vocab.models) {
    const k = model.toLowerCase();
    if (k.length < 4) continue;
    if (new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text) && !allowed.includes(k)) problems.push(`model ${model} not in facts`);
  }
  const saysNone = /not serviceable|isn'?t serviceable|(?:aren'?t|not) (?:currently )?available|there (?:are|is) (?:currently )?no\b|no [\w -]{0,40}(?:cars?|options?) (?:are )?(?:available|within|under|in)|couldn'?t find|(?:do ?n'?t|do not) have (?:any )?(?:listings?|cars?|options?|stock)|no listings?|nothing (?:matching|available)/i.test(text);
  if (saysNone && (facts.cars.length || !facts.searchRan)) problems.push(facts.searchRan ? "says unavailable while cars exist" : "claims availability without a search");
  if (/(advisor|team|someone|we)\s+(will|'ll|shall)\s+(call|contact|reach)/i.test(text) && !facts.escalation?.call) problems.push("promises a call that isn't booked");
  return problems;
}

export function templateReply(turn) {
  const out = [];
  const s = turn.search;
  if (turn.commitments.length) out.push(`Done: ${turn.commitments.map((c) => c.promise).join("; ")}.`);
  for (const a of turn.answers) out.push(a.text);
  if (turn.needs) out.push(turn.needs);
  if (s) {
    const first = s.steps.find((x) => x.cars.length);
    const exact = s.steps[0];
    const near = s.steps.find((x) => x.key === "nearby");
    if (exact?.cars.length) {
      out.push(`${exact.total} match${exact.total === 1 ? "" : "es"} for ${exact.label}. Top pick: ${exact.cars[0].title} at ${lakh(exact.cars[0].priceLakh)}.`);
      if (near?.cars.length) out.push(`Plus ${near.total} nearby: ${near.cars[0].title} at ${lakh(near.cars[0].priceLakh)} in ${near.cars[0].city} (~${near.cars[0].distanceKm} km).`);
    }
    else if (first) out.push(`Nothing for ${exact.label} right now. Closest fit: ${first.label}. ${first.cars[0].title} at ${lakh(first.cars[0].priceLakh)} in ${first.cars[0].city}.`);
    else if (s.beyond.length) out.push(`Nothing within ${s.radiusKm} km of ${s.origin.label} yet. Nearest matching stock: ${s.beyond.slice(0, 2).map((b) => `${b.city} (~${b.km} km, ${b.count} car${b.count === 1 ? "" : "s"})`).join(", ")}. Want me to widen the radius?`);
    else out.push("No listing matches all your filters right now. Want me to relax the budget or another filter?");
    if (s.withheld && !turn.profile.widened && turn.profile.brands.length) out.push(`I've kept ${s.withheld} cheaper or other-segment cars out; say “show other brands” to see them.`);
  }
  if (turn.escalation.call) out.push("An advisor will call you. They already have your shortlist and questions, so you won't have to repeat anything.");
  else if (turn.escalation.ask) out.push("Want an advisor to call, or should I keep it here?");
  if (!out.length) out.push("Tell me the brand, budget or city you have in mind and I'll search every seller on Cars24.");
  return out.join(" ");
}

export async function writeReply(turn, { store, fetchImpl } = {}) {
  const fallback = templateReply(turn);
  if (!llmEnabled()) return { text: fallback, source: "template" };
  const facts = factsFor(turn);
  try {
    const r = await chatJSON({ store, fetchImpl, name: "reply", schema: REPLY_SCHEMA, temperature: 0.3, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: JSON.stringify(facts) }] });
    const text = String(r.data.reply || "").trim();
    const problems = guard(text, facts);
    if (!text || problems.length) return { text: fallback, source: "template", rejected: { text, problems } };
    return { text, source: r.cached ? "llm-cache" : "llm", usage: r.usage };
  } catch (e) {
    return { text: fallback, source: "template", error: e.message };
  }
}
