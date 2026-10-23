// The CarGPT agent team and its schedule.
//
//   wave 0  intent       understand the message (LLM, rules fallback)
//   wave 1  memory       ledger + profile merge + recency ranking
//   wave 2  answers ∥ search
//   wave 3  promises     commitments + independent audit of search results
//   wave 4  escalation   call gate, tickets, context packet (reacts to consent.revoked at once)
//   wave 5  reply        grounded reply with guard
import { Coordinator } from "./coordinator.js";
import { intentAgent } from "./intent-agent.js";
import { memoryAgent } from "./memory-agent.js";
import { answersAgent } from "./answers-agent.js";
import { searchAgent } from "./search-agent.js";
import { promiseAgent } from "./promises-agent.js";
import { escalationAgent } from "./escalation-agent.js";
import { replyAgent } from "./reply-agent.js";

export const AGENTS = [intentAgent, memoryAgent, answersAgent, searchAgent, promiseAgent, escalationAgent, replyAgent];
export const createCoordinator = (agents = AGENTS) => new Coordinator(agents);
export { Coordinator } from "./coordinator.js";
export { IntentLedger, recencyWeights } from "./ledger.js";
