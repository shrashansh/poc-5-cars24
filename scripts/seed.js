// Seeds data/store with buyers who each ran several chat sessions, so the app opens with history.
// The first buyer is the real Kanpur journey from 23 Oct 2026 (src/replay.js), split into the
// sessions it happened in. The others are typical buyers in other cities.
//
//   node scripts/seed.js          # replaces data/store with fresh seed data
//   SEED_LLM=1 node scripts/seed.js   # use OpenAI for extraction while seeding (slower, costs tokens)
import { loadInventory } from "../src/inventory.js";
import { Store } from "../src/store.js";
import { Engine } from "../src/engine.js";
import { REPLAY } from "../src/replay.js";

if (!process.env.SEED_LLM) process.env.OPENAI_API_KEY = "";
const { config } = await import("../src/config.js");
if (!process.env.SEED_LLM) config.openaiKey = "";

loadInventory();
const store = new Store();
for (const c of Object.keys(store.data)) if (c !== "llmcache") store.data[c] = {};
const engine = new Engine({ store });

const kanpur = REPLAY.map((r) => r.user);
const BUYERS = [
  { name: "Kanpur Buyer (real transcript)", homeCity: "kanpur", sessions: [kanpur.slice(0, 4), kanpur.slice(4, 12), kanpur.slice(12)] },
  { name: "Priya Raman", homeCity: "bangalore", sessions: [
    ["Need a 7 seater for family under 15 lakh, automatic", "No diesel please"],
    ["Any Innova Crysta or XUV700?", "What's the on-road cost of the first one?"],
  ] },
  { name: "Rahul Verma", homeCity: "noida", sessions: [
    ["First car, budget under 5 lakh, petrol", "Only 2018 or newer"],
    ["Show me options in Ghaziabad and New Delhi too", "Is a DL registered car easy to transfer to Noida?"],
  ] },
  { name: "Arjun Mehta", homeCity: "mumbai", sessions: [
    ["Creta ya Seltos chahiye 12 lakh tak, automatic", "Don't call me, I'll decide on chat"],
    ["Any Creta under 12 lakh now?", "I live in Mumbai, car is GJ registered. Transfer process?"],
  ] },
  { name: "Neha Srivastava", homeCity: "lucknow", sessions: [
    ["Toyota Fortuner under 25 lakh", "Search within 100 km"],
    ["Have an advisor call me about the Fortuner"],
  ] },
  { name: "Vikram Singh", homeCity: "jaipur", sessions: [
    ["Looking for a Mercedes or Audi sedan under 30 lakh"],
    ["Why are you showing me Hyundai? I only want luxury", "No SUVs either"],
  ] },
  { name: "Ananya Gupta", homeCity: "gurgaon", sessions: [
    ["Honda City or Hyundai Verna, petrol, under 10 lakh"],
    ["Start over", "Show me SUVs under 8 lakh"],
  ] },
];

let turns = 0;
for (const b of BUYERS) {
  const u = engine.createUser({ name: b.name, homeCity: b.homeCity });
  for (const msgs of b.sessions) {
    const { session } = engine.createSession(u.id, { channel: "app" });
    for (const m of msgs) { await engine.handleMessage(u.id, session.id, m); turns++; }
  }
  console.log(`${b.name.padEnd(32)} ${b.sessions.length} sessions · ${engine.publicUser(engine.user(u.id)).summary}`);
}
store.flush();
console.log(`\n${BUYERS.length} buyers, ${turns} turns, ${store.list("tickets").length} tickets → data/store/`);
