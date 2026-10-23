# POC-5: CarGPT Intent Engine (Cars24)

Shrashansh Dixit, October 2026. Built from public information only, with no Cars24 data or system access. Not affiliated with Cars24.

CarGPT is the AI buying assistant in the Cars24 app. This project is a layer that sits in front of it. The layer:

- remembers what a buyer wants across messages and sessions
- searches every seller type without dropping the buyer's brand or budget
- answers RC-transfer and on-road questions itself
- only makes promises that some system actually enforces
- calls only when the buyer asks

It runs on 2,584 live listings pulled from cars24.com across 12 cities, handles many buyers with many chat sessions each, and uses OpenAI with a rule-based fallback.

## How this started

On 23 October 2026 I used CarGPT to look for a used Mercedes in Kanpur, over about 40 minutes and four app sessions. The full conversation, with CarGPT's replies word for word, is in `src/replay.js`.

I searched for a Mercedes. The app showed three, then a Baleno, a Wagon R and a Tavera under "Other cars you may like". CarGPT apologised and promised to keep the search on Mercedes. Eleven minutes later the Baleno was still in the feed.

CarGPT then told me five times that Kanpur "isn't serviceable". At the same time, cars24.com listed 273 cars in Kanpur, including three Mercedes and a BMW X5 at ₹16L that fit my budget.

It couldn't search by distance either. "Search within 200 km" got "I can't verify a 200 km radius search". When I named Lucknow, Agra and Prayagraj, it said "I couldn't find an available car under ₹20 lakh", while the Lucknow page listed Mercedes, BMW and Audi.

Two questions with standard answers went to an advisor: a same-state RC transfer and a UP78-to-Delhi transfer. Both were "shared with our team".

I got four calls I hadn't asked for. One arrived in the same minute CarGPT wrote "I'll only arrange an advisor callback when you ask for one". None of the callers knew what I was looking for.

The last reply kept "no hatchbacks" but forgot luxury and the ₹20L budget. It recommended a ₹3.6L Honda City at a hub about 460 km away.

Each of these comes from something around the model:

1. Intent isn't stored anywhere that lasts.
2. Search is limited to one seller type.
3. Promises aren't wired to the systems that would keep them.
4. The dialer doesn't check consent.

## What changes with the engine

Same conversation, replayed through the engine on live listings (`npm run replay`):

| Buyer said | CarGPT today | With the engine |
|---|---|---|
| I searched for a Mercedes. Why am I seeing Baleno? | Apologises, promises to stay on Mercedes. Baleno stays in the feed. | Shows the 3 Kanpur Mercedes (CLA ₹10L, GLC ₹15.5L, GLS ₹20L). Blocks Maruti on the shared profile, so the feed drops it too. |
| Use my current location | "Cars24 Assured cars aren't currently available there." Unrequested call a minute later. | Uses Kanpur and keeps the Mercedes results. No call. |
| Any Mercedes in UP that can be transferred to Kanpur? | "I can't confirm… shared with our team." Second call. | Same state: Form 29/30 only. No NOC, no re-registration. |
| Why am I getting calls without my consent? | "I can't change your contact preferences here." Third call the same minute. | Sets the dialer suppression flag. The dialer refuses every later call. |
| BMW under 20 lakhs near Kanpur | "Assured cars aren't available in Kanpur." | 2016 BMW X5, ₹16L, Kanpur. Mercedes stays in the profile. |
| Search within 200 km | "I can't verify a 200 km radius search." | Adds Lucknow (~94 km): Audi A3 ₹7.5L, Audi Q5 ₹5.56L. |
| Lucknow, Agra, Prayagraj… | "I couldn't find an available car under ₹20 lakh." | Searches all three. BMW X1 ₹14.52L in Agra, Jaguar F-Pace ₹18.5L in Prayagraj. |
| UP78 car, I live in Delhi: transfer process? | Escalated. Fourth call. | Interstate: NOC (Form 28), Form 29/30, re-register in Delhi within 12 months, road tax refund. My home city stays Kanpur. |
| On-road cost of the GLC including transfer? | "I couldn't find the GLC details." | Finds the listed GLC: ₹15.5L, UP16, same-state transfer fee only. |
| Please don't show me any hatchback | Keeps "no hatchbacks", drops luxury and budget. Recommends a ₹3.6L City 460 km away. | Confirms hatchbacks are already blocked. Results stay luxury, under ₹20L, within 200 km. |
| OK, have an advisor call me about the GLC | Not tested. All four earlier calls started from zero. | Opens one ticket. The advisor gets intent, blocked brands, shortlist, open questions and an opening line. |

Over the full transcript, CarGPT today made 4 calls, none requested and none with context. The engine makes 1 call, the one the buyer asked for, and the advisor has the whole context.

## How it works

Each turn is run by a team of agents that share one blackboard. A coordinator schedules them by dependency, so agents that don't depend on each other run together. It also records every run, skip, failure and event in the turn's `agents` trace.

```
wave 0  intent       OpenAI structured output, with the profile, intents ranked by recency and
                     recent turns as context; rules take over if the LLM fails
wave 1  memory       records the message in the intent ledger, merges it into the one shared
                     profile (newest statement wins), re-ranks every intent by recency
wave 2  answers  ∥   RC transfer and on-road cost from rules and the listing
        search       every seller type, in steps that keep intent (below), brands ranked by recency
wave 3  promises     each promise maps to the system that enforces it; independently audits the
                     search results and pulls any car that breaks a standing promise
wave 4  escalation   call only on request; otherwise ask, or keep it in chat. Reacts at once
                     to "consent.revoked" from memory and cancels any pending callback
wave 5  reply        the LLM phrases the facts; a guard blocks anything not in them
```

If a non-critical agent fails (answers, search, promises, escalation), the failure is traced and the turn still gets a reply. Agents are plain objects (`name`, `after`, `when`, `run`, `on`) in `src/agents/`, so you can add or replace one without touching the engine. The tests replace the search agent with one that fails or leaks results.

### Intent by recency

The profile says what the buyer wants. The intent ledger (`src/agents/ledger.js`) says when they last said it. Every chat message, app tap and "forget" is written to the ledger with its turn number and time. Each remembered intent gets a weight:

```
weight = 0.5^(turns since last mentioned / 6) × 0.5^(days since / 14)
```

- The brand named most recently leads. Brands asked for earlier are ranked newest first, both in the "asked earlier" search step and in scoring.
- Repeating an intent refreshes it, even if the profile doesn't change.
- When two statements conflict, the newer one wins. Asking for a brand you blocked unblocks it. A new budget replaces the old one.
- A preference that isn't repeated fades to dormant. It stays in the profile but ranks last, and a returning buyer is told it is from a while back.
- Constraints never decay: blocked brands and models, excluded bodies and fuels, the budget cap, hidden listings and "no calls". These are promises, and only the buyer can lift them.
- A car the buyer only asked about ("on-road cost of the GLC") or viewed in the app counts as interest. It gives a small ranking boost but never becomes a filter.

The advisor's context packet lists the buyer's latest intents first, so the advisor opens with what the buyer wants now.

The search starts from where the buyer is. The app asks the browser for a GPS fix and sends it with every message; if the buyer declines, or the fix is more than 6 hours old, the search starts from their home city. The home city stays separate because RTO rules depend on it, so a Kanpur buyer travelling in Lucknow sees Lucknow cars first but still gets Kanpur transfer answers.

The message decides the scope. A city named in it ("any Audi in Lucknow?") anchors that turn's search. "Within 150 km" is used exactly. Without a stated radius, the search tries 25, 50, 100, 200 and then 400 km from the buyer and stops at the first ring with at least six matching cars. "Near me" never sets a radius by itself. Every distance is measured from the buyer's position to each city's centre.

Within that scope, the search widens in this order, and only as far as the buyer would accept:

1. Requested brands in the anchor city (the one the buyer is in, or the one they named).
2. The same brands within the radius, or in cities the buyer named earlier.
3. Brands the buyer asked for earlier.
4. The same segment from other brands. A luxury buyer sees luxury.
5. Cheaper or other-segment cars are counted but withheld unless the buyer opts in.

When nothing is in range, the reply names the nearest city that has matching stock.

Promises such as "no hatchbacks", "no Maruti", "nothing above ₹20L" and "no calls" are written to the buyer's profile. The "Recommended for you" feed (`/api/users/:id/feed`) and the dialer (`/api/dialer/check`) read that same profile, so a promise made in chat also holds in the feed and on the phone.

Car cards come straight from the listing data, and the LLM only writes the sentence above them. A guard rejects a reply that mentions a price or model not in the results, says nothing is available when cars exist or when no search ran, or promises a call that isn't booked. A rejected reply is replaced by a plain template.

A returning buyer is greeted with what CarGPT remembers. The app shows the profile, and the buyer can remove any item. "Start over" clears the search but keeps the city and the no-call flag.

## Numbers

| | |
|---|---|
| Live listings in `data/inventory.json` | 2,584 across 12 cities (Kanpur, Lucknow, Agra, Prayagraj, Varanasi, Noida, Ghaziabad, New Delhi, Gurgaon, Jaipur, Mumbai, Bangalore), pulled 23 Oct 2026 |
| Seller types covered | Direct sellers (1,295) and Cars24 stock (1,289) |
| Intent extraction on 40 reworded messages the rules were never tuned on | OpenAI (gpt-4.1-mini): 38/40 (95%). Rules alone: 28/40 (70%). `npm run eval:llm` |
| Calls in the real transcript | Today: 4 unrequested, 0 with context. Engine: 1, requested, with context |
| Tests | 50, on a fixed inventory fixture, no network |

The eval set includes Hinglish ("12 lakh tak", "hatchback mat dikhao", "diesel nahi chahiye"). The rules keep the product answering when OpenAI is down, and the 25-point gap is why the LLM is the primary path.

## Run it

Node 18 or later. No dependencies.

```bash
cp .env.example .env     # add OPENAI_API_KEY; without it the rules and template replies run
npm run seed             # 7 buyers, 15 sessions, including the real Kanpur journey
npm start                # http://localhost:8000
```

The browser asks for your location when the app opens; allow it to search from where you are, or use "📍 Use my location" later. A new buyer can sign up with "Detect with GPS" instead of picking a city. In the Buyer tab, pick a buyer or create one. Each buyer has a list of chats, and a new chat already knows their profile. The right-hand panel shows the remembered profile, the app feed built from it, and a log of every change and dial attempt.

Each CarGPT reply has an expandable agent trace. The side panel ranks remembered intents by recency.

`POST /api/users/:id/location` with `{ "lat", "lon", "accuracy" }` updates the buyer's position; messages can also carry a `location` field. Between chats the app can send signals: `POST /api/users/:id/signals` with `{ "type": "view" | "shortlist" | "dismiss", "carId": "…" }`. "dismiss" hides that listing everywhere. "view" and "shortlist" record interest. `GET /api/users/:id/intents` returns the ranked intents and the ledger.

The Advisor console lists tickets with their context packets. "Dial buyer" asks the dialer, which refuses if the buyer said no calls.

Other commands:

```bash
npm test                 # 50 tests
npm run replay           # the real transcript, CarGPT today vs the engine, turn by turn
npm run eval:llm         # rules vs OpenAI on 40 reworded messages
npm run scrape           # refresh listings (~1.5 h for full coverage; saves after each city)
```

## Data

`scripts/scrape.js` reads the listing pages on cars24.com. Cars24 renders 20 cars per page and has no server-side pagination, so the scraper crawls each city's brand, model, budget, body and fuel pages and removes duplicates by listing id. Metro pages also show neighbouring cities' cars, so each car goes to the city its own card names. The scraper only fetches paths that robots.txt allows, one request at a time.

Each record has year, make, model, variant, fuel, transmission, km, owners, registration prefix, price, EMI, seller type, listing URL and image. Body type comes from the body-type pages.

The committed snapshot is a quick pass of about 25 pages per city. It is close to complete for smaller cities (Varanasi 84 of 88, Prayagraj 105 of 113) and partial for the metros (254 of 2,788 in Delhi). A full `npm run scrape` takes about 1.5 hours. Prices and availability change daily.

## Reliability

If OpenAI times out (15 seconds) or fails twice, rule extraction and a template reply take over, and every response says which path ran. Every extracted field is mapped to the inventory's real brands, models and cities, and anything else is dropped.

Anything the LLM extracts that changes what the buyer sees everywhere needs words in the message that say so. That covers asking for or rejecting a brand, opening the search to other brands, clearing the profile, moving the home city and setting a radius. In live runs the LLM inferred these from earlier turns: it read "Show me BMW" as "block Mercedes", carried "Maruti" into a later turn (which unblocked it), moved the buyer to Delhi because a previous message mentioned Delhi, and attached 50 km to "near me".

A double tap or network retry with the same `clientMsgId` runs once, and messages in one session are processed in order. The store is JSON files with an in-memory cache; each write goes to a temp file that is then renamed, and a corrupt file is set aside instead of crashing the app. Each buyer has their own token, with limits of 20 messages a minute, 1,000 characters per message and 20 KB per request.

## What this doesn't show

- The feed and the dialer here are the engine's own endpoints. Connecting them to Cars24's real feed and dialer is integration work, but both already read one shared profile.
- The store is single-instance JSON. In production it would be Postgres or Redis behind the same small interface in `src/store.js`.
- Inventory is known per city, not per street, so distances run from the buyer to each city's centre, as straight-line × 1.25. They are shown as estimates. RTO steps are indicative; fees vary by state and car age.
- The advisor key in the web page is there for the demo.

## Code

| | |
|---|---|
| `server.js` | HTTP API and web app |
| `src/engine.js` | Users, sessions, persistence, app signals; hands each turn to the agents |
| `src/agents/coordinator.js` | Dependency-scheduled agent runner, blackboard, event bus, trace |
| `src/agents/ledger.js` | Intent ledger and recency ranking |
| `src/agents/*-agent.js` | Intent, memory, answers, search, promises, escalation, reply |
| `src/extract.js`, `src/llm.js`, `src/parse.js` | OpenAI extraction, client, rule fallback |
| `src/intent.js` | Intent schema and `normalise()`, the only way into a profile |
| `src/profile.js` | Profile merge, forget, summary |
| `src/search.js` | Step-by-step search with distance |
| `src/location.js` | GPS fix, nearest city, distance from the buyer |
| `src/policy.js` | Promises, feed, dialer check, escalation, context packet |
| `src/reply.js` | LLM reply, guard, template |
| `src/rules.js` | Brand tiers, state codes, RC transfer, on-road cost |
| `src/store.js` | JSON store |
| `src/replay.js` | The 23 Oct 2026 conversation |
| `scripts/` | Scraper, seed, eval, replay |
| `web/index.html` | Buyer app and advisor console |
| `test/` | Tests and fixture |
