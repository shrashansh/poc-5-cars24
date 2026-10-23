// HTTP API + web app. No framework, no dependencies.
//
// Buyer endpoints need the user's token (X-User-Token), issued at signup.
// Advisor / dialer endpoints need X-Advisor-Key (ADVISOR_KEY, default "advisor-demo").
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { config, llmEnabled } from "./src/config.js";
import { loadInventory, inventory } from "./src/inventory.js";
import { Engine, AppError } from "./src/engine.js";
import { dialerCheck } from "./src/policy.js";
import { describe } from "./src/profile.js";

const safeEq = (a, b) => { const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || "")); return x.length === y.length && timingSafeEqual(x, y); };

export function createApp({ engine = new Engine() } = {}) {
  const store = engine.store;
  const page = () => readFileSync(new URL("./web/index.html", import.meta.url));

  const routes = [];
  const on = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, "(?<$1>[\\w-]+)")}$`), fn });
  const buyer = (req, params) => {
    const u = engine.user(params.userId);
    if (!safeEq(req.headers["x-user-token"], u.token)) throw new AppError(401, "bad_token", "Missing or wrong user token");
    return u;
  };
  const advisor = (req) => { if (!safeEq(req.headers["x-advisor-key"], config.advisorKey)) throw new AppError(401, "bad_advisor_key", "Advisor key required"); };
  const now = () => new Date().toISOString();

  // ---- public ----
  on("GET", "/api/health", () => ({ ok: true, agents: engine.coordinator.schedule, llm: llmEnabled(), model: llmEnabled() ? config.openaiModel : null, cars: inventory().cars.length, cities: inventory().cities.length, capturedAt: inventory().capturedAt }));
  on("GET", "/api/cities", () => inventory().cities.map(({ slug, name, state, totalListed, captured, luxeCount, assuredServiceable }) => ({ slug, name, state, totalListed, captured, luxeCount, assuredServiceable })));
  on("POST", "/api/users", (req, _p, body) => { const u = engine.createUser(body); return { user: engine.publicUser(u), token: u.token }; });
  // Demo convenience: list users so the web app can switch between them. Tokens only go to the advisor key.
  on("GET", "/api/users", (req) => {
    const isAdvisor = safeEq(req.headers["x-advisor-key"], config.advisorKey);
    return store.list("users").map((u) => ({ ...engine.publicUser(u), ...(isAdvisor ? { token: u.token } : {}) }));
  });

  // ---- buyer ----
  on("GET", "/api/users/:userId", (req, p) => engine.publicUser(buyer(req, p)));
  on("GET", "/api/users/:userId/sessions", (req, p) => { buyer(req, p); return engine.sessionsOf(p.userId); });
  on("POST", "/api/users/:userId/sessions", (req, p, body) => { buyer(req, p); return engine.createSession(p.userId, body); });
  on("GET", "/api/users/:userId/sessions/:sessionId/messages", (req, p) => { buyer(req, p); engine.session(p.userId, p.sessionId); return engine.messages(p.sessionId); });
  on("POST", "/api/users/:userId/sessions/:sessionId/messages", (req, p, body) => { buyer(req, p); return engine.handleMessage(p.userId, p.sessionId, body.text, { clientMsgId: body.clientMsgId, location: body.location }); });
  on("POST", "/api/users/:userId/location", (req, p, body) => { buyer(req, p); return engine.setLocation(p.userId, body); });
  on("GET", "/api/users/:userId/profile", (req, p) => { const u = buyer(req, p); return { profile: u.profile, summary: describe(u.profile), priorities: engine.priorities(u.id), events: store.items("events", u.id).slice(-50) }; });
  on("DELETE", "/api/users/:userId/profile", (req, p, body) => { buyer(req, p); return engine.forget(p.userId, body.field, body.value); });
  on("GET", "/api/users/:userId/feed", (req, p) => { buyer(req, p); return engine.feed(p.userId); });
  // App taps keep intent current between chats: { type: "view" | "shortlist" | "dismiss", carId }.
  on("POST", "/api/users/:userId/signals", (req, p, body) => { buyer(req, p); return engine.recordSignal(p.userId, body); });
  on("GET", "/api/users/:userId/intents", (req, p) => { buyer(req, p); return { priorities: engine.priorities(p.userId), history: engine.ledger.history(p.userId) }; });

  // ---- advisor / dialer ----
  on("GET", "/api/advisor/tickets", (req) => { advisor(req); return store.list("tickets").sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((t) => ({ ...t, buyer: store.get("users", t.userId)?.name })); });
  on("POST", "/api/advisor/tickets/:ticketId/close", (req, p, body) => { advisor(req); return engine.closeTicket(p.ticketId, body.note); });
  on("POST", "/api/dialer/check", (req, _p, body) => {
    advisor(req);
    const u = engine.user(body.userId);
    const r = dialerCheck(u, store.list("tickets"));
    store.append("events", u.id, { at: now(), type: "dialer", changes: [`Dial attempt ${r.allowed ? "allowed" : "BLOCKED"}: ${r.reason}`] });
    return r;
  });
  on("GET", "/api/advisor/users/:userId", (req, p) => {
    advisor(req);
    const u = engine.user(p.userId);
    return { user: engine.publicUser(u), priorities: engine.priorities(u.id), events: store.items("events", u.id), sessions: engine.sessionsOf(u.id).map((s) => ({ ...s, messages: engine.messages(s.id).map(({ meta, ...m }) => ({ ...m, source: meta?.turn?.extraction?.source })) })) };
  });

  return createServer(async (req, res) => {
    const send = (status, data, type = "application/json") => {
      res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(type === "application/json" ? JSON.stringify(data) : data);
    };
    try {
      const url = new URL(req.url, "http://x");
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) return send(200, page(), "text/html; charset=utf-8");
      let params = null;
      const route = routes.find((r) => r.method === req.method && (params = url.pathname.match(r.re)));
      if (!route) return send(404, { error: "not_found" });
      let body = {};
      if (["POST", "DELETE", "PATCH"].includes(req.method)) {
        let raw = "";
        for await (const chunk of req) { raw += chunk; if (raw.length > 20000) throw new AppError(413, "too_large", "Request too large"); }
        try { body = raw ? JSON.parse(raw) : {}; } catch { throw new AppError(400, "bad_json", "Body must be JSON"); }
        if (typeof body !== "object" || body === null || Array.isArray(body)) throw new AppError(400, "bad_json", "Body must be a JSON object");
      }
      send(200, await route.fn(req, params.groups || {}, body));
    } catch (e) {
      if (e instanceof AppError) return send(e.status, { error: e.code, message: e.message });
      console.error(e);
      send(500, { error: "internal", message: "Something went wrong" });
    }
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  loadInventory();
  const engine = new Engine();
  const server = createApp({ engine });
  server.listen(config.port, () => console.log(`CarGPT Intent Engine on http://localhost:${config.port}  ·  ${inventory().cars.length} cars in ${inventory().cities.length} cities  ·  LLM: ${llmEnabled() ? config.openaiModel : "off (rules)"}`));
  const stop = () => { engine.store.flush(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
