// Minimal OpenAI Chat Completions client: structured JSON output, timeout, one retry, response cache.
// Any failure throws; callers fall back to rules so a buyer always gets an answer.
import { createHash } from "node:crypto";
import { config, llmEnabled } from "./config.js";

export class LLMError extends Error {}

const CACHE_MAX = 5000;
function pruneCache(store) {
  if (!store) return;
  const entries = Object.entries(store.data.llmcache);
  if (entries.length <= CACHE_MAX) return;
  entries.sort((a, b) => a[1].at - b[1].at).slice(0, entries.length - CACHE_MAX).forEach(([k]) => store.remove("llmcache", k));
}

export async function chatJSON({ store, name, schema, messages, temperature = 0, cacheTtlMs = 7 * 24 * 3600 * 1000, fetchImpl = globalThis.fetch }) {
  if (!llmEnabled()) throw new LLMError("OPENAI_API_KEY not set");
  const key = createHash("sha256").update(JSON.stringify([config.openaiModel, name, messages])).digest("hex").slice(0, 32);
  const hit = store?.get("llmcache", key);
  if (hit && Date.now() - hit.at < cacheTtlMs) return { ...hit.value, cached: true };

  const body = JSON.stringify({
    model: config.openaiModel, temperature, messages,
    response_format: { type: "json_schema", json_schema: { name, strict: true, schema } },
  });
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.llmTimeoutMs);
    const started = Date.now();
    try {
      const r = await fetchImpl(`${config.openaiBaseUrl}/chat/completions`, {
        method: "POST", signal: ctrl.signal, body,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.openaiKey}` },
      });
      if (r.status === 429 || r.status >= 500) { lastErr = new LLMError(`OpenAI ${r.status}`); await new Promise((s) => setTimeout(s, 600 * attempt)); continue; }
      const j = await r.json();
      if (!r.ok) throw new LLMError(`OpenAI ${r.status}: ${j?.error?.message || "error"}`);
      const msg = j.choices?.[0]?.message;
      if (msg?.refusal) throw new LLMError(`refused: ${msg.refusal}`);
      const value = { data: JSON.parse(msg.content), usage: j.usage || null, model: j.model, ms: Date.now() - started };
      store?.put("llmcache", key, { at: Date.now(), value });
      pruneCache(store);
      return value;
    } catch (e) {
      lastErr = e.name === "AbortError" ? new LLMError(`timeout after ${config.llmTimeoutMs} ms`) : e;
      if (e instanceof LLMError && !/timeout|OpenAI 5|OpenAI 429/.test(e.message)) break;
    } finally { clearTimeout(timer); }
  }
  throw lastErr instanceof LLMError ? lastErr : new LLMError(String(lastErr?.message || lastErr));
}
