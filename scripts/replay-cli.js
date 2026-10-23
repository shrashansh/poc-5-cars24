// Replays the real Kanpur CarGPT conversation (src/replay.js) through the engine and prints
// CarGPT's actual reply next to the engine's, turn by turn. Uses the live inventory if pulled,
// else the test fixture. Uses OpenAI when OPENAI_API_KEY is set.
import { loadInventory, inventory } from "../src/inventory.js";
import { Store } from "../src/store.js";
import { Engine } from "../src/engine.js";
import { REPLAY } from "../src/replay.js";

try { loadInventory(); } catch { loadInventory(new URL("../test/fixtures/", import.meta.url)); }
const engine = new Engine({ store: new Store(null, { persist: false }) });
const u = engine.createUser({ name: "Kanpur Buyer", homeCity: "kanpur" });
const { session } = engine.createSession(u.id);
console.log(`Inventory: ${inventory().cars.length} cars, ${inventory().cities.length} cities\n`);
for (const r of REPLAY) {
  const o = await engine.handleMessage(u.id, session.id, r.user);
  console.log(`[${r.time}] BUYER   ${r.user}`);
  console.log(`        TODAY   ${r.today.reply}${r.today.call ? `\n                📞 ${r.today.call}` : ""}`);
  console.log(`        ENGINE  ${o.reply}`);
  console.log(`                (${o.extraction.source}; ${o.changes.map((c) => c.label).join("; ") || "no profile change"}; ${o.escalation.reason})\n`);
}
