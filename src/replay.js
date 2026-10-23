// The buyer's real CarGPT conversations on 23 Oct 2026 (Cars24 app, Kanpur), in order.
// "today" = CarGPT's reply verbatim from screenshots, plus what happened around it.
// Four app sessions are treated as one buyer journey: the point of the engine is that intent survives sessions.

export const REPLAY = [
  {
    time: "11:53", user: "I searched for a Mercedes-Benz in my locality. Why am I seeing Maruti Baleno as a recommendation? You listed just three Mercedes and then started recommending me Baleno.",
    today: { reply: "I'm sorry—the Maruti Baleno recommendations didn't match your Mercedes-Benz search. I'll keep your search focused on Mercedes-Benz and won't substitute another brand. Which locality or city should I search in?",
      feed: ["mar-baleno", "mar-wagonr", "chev-tavera"], feedLabel: "App feed at 12:04, under the 3 Mercedes: “Other cars you may like”",
      verdict: "Promise not enforced — Baleno still in the feed 11 minutes later" },
  },
  {
    time: "11:54", user: "Use my current location data",
    today: { reply: "I checked your current location, Kanpur, but Cars24 Assured cars aren't currently available there. I've shared this with our team so an advisor can help you find Mercedes-Benz options nearby.",
      call: "11:55 · 36s · unrequested · caller opened with “are you looking for a car?”",
      verdict: "Says nothing is available while the app lists 3 Mercedes in Kanpur" },
  },
  {
    time: "11:56", user: "Aren't there any Mercedes available in UP which can be transferred to Kanpur?",
    today: { reply: "Kanpur isn't currently serviceable for Cars24 Assured cars. I can't confirm whether a Mercedes-Benz from elsewhere in Uttar Pradesh can be transferred to Kanpur, so I've shared your question with our team for an advisor to check.",
      call: "11:56 · 1 min · unrequested · no context", verdict: "Same-state transfer is a rule, not an advisor question" },
  },
  {
    time: "11:59", user: "Since I'm not requesting a call back from your advisor, why am I receiving calls from Cars24 without my consent?",
    today: { reply: "I'm sorry you're receiving unwanted calls. I can't verify why they're happening or change your contact preferences here, so I've shared your concern with our team for review. I'll only arrange an advisor callback when you ask for one.",
      call: "11:59 · 27s · arrived the same minute", verdict: "Promise made, third call arrives anyway" },
  },
  {
    time: "12:16", user: "Show me BMW under 20 lakhs near Kanpur",
    today: { reply: "Cars24 Assured cars aren't currently available in Kanpur. Would you like to search in another city?",
      verdict: "Kanpur Luxe page lists a BMW X5 at ₹16L" },
  },
  {
    time: "12:17", user: "Yes, search for cars which are in 200km radius to Kanpur",
    today: { reply: "Kanpur itself isn't serviceable for Cars24 Assured cars, and I can't verify a 200 km radius search. Which nearby city would you like me to check?",
      verdict: "No distance-based search" },
  },
  {
    time: "12:22", user: "Lucknow, Agra, Prayagraj...",
    today: { reply: "I couldn't find an available car under ₹20 lakh right now.",
      verdict: "cars24.com shows Mercedes + BMW in Lucknow and Agra" },
  },
  {
    time: "12:23", user: "Please don't show hatchback to me in any search from now onwards",
    today: { reply: "Understood—I'll exclude hatchbacks from your future searches.",
      verdict: "Remembered for the chat only — not the feed" },
  },
  {
    time: "12:25", user: "Do we have any audi in lucknow?",
    today: { reply: "I couldn't find an available car right now.", verdict: "cars24.com Lucknow page lists 2 Audis" },
  },
  {
    time: "12:26", user: "I am planning to buy a UP78 registered car, I live in Delhi, what's the transfer process?",
    today: { reply: "RC transfer is generally handled digitally, and buyers usually don't need to visit the RTO. Since this car is registered in Uttar Pradesh and you live in Delhi, the exact documents, RTO steps, and charges depend on the case and destination RTO. I've shared your question with our team, and an advisor will call to help.",
      call: "~12:28 · 1 min 8s+ · unrequested · started from zero", verdict: "Standard interstate process, escalated to a sales call" },
  },
  {
    time: "12:27", user: "What's the onroad cost of the GLC including transfer",
    today: { reply: "I couldn't find the GLC details to confirm its on-road cost, including transfer.", verdict: "The GLC is listed in Kanpur at ₹15.5L" },
  },
  {
    time: "12:28", user: "Don't call me, just answer here.",
    today: { reply: "Understood—I'll keep our conversation here and won't arrange a call.", call: "Call already in progress while this was sent", verdict: "Promise made during the call" },
  },
  {
    time: "12:32", user: "I mean please don't show me any hatchback in recommendations",
    today: { reply: "Absolutely—no hatchbacks. I found these sedan recommendations at the Ghaziabad hub: 2022 Tata Tigor XZ Plus Petrol — ₹6 lakh · 2023 Hyundai Aura SX 1.2 CNG — ₹5.5 lakh · 2015 Honda City 1.5L i-VTEC SV CVT — ₹3.6 lakh · 2021 Hyundai Verna SX 1.5 VTVT — ₹7.2 lakh. (reply printed twice, raw ** markdown)",
      external: ["2022 Tata Tigor XZ Plus — ₹6L", "2023 Hyundai Aura SX CNG — ₹5.5L", "2015 Honda City SV CVT — ₹3.6L", "2021 Hyundai Verna SX — ₹7.2L"], externalLabel: "Ghaziabad hub (~460 km away)",
      verdict: "Kept the last instruction, dropped luxury + ₹20L budget" },
  },
  {
    time: "next", user: "OK, have an advisor call me about the GLC",
    today: { reply: "(Not tested — today every escalation reaches the advisor without the chat transcript: 4 calls, 0 with context.)", verdict: "Advisor starts from zero" },
  },
];
