// Settings from the environment, with an optional .env file in the project root.
// Real environment variables win over .env.
import { readFileSync, existsSync } from "node:fs";

const envFile = new URL("../.env", import.meta.url);
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const env = process.env;
export const config = {
  port: Number(env.PORT || 8000),
  openaiKey: env.OPENAI_API_KEY || "",
  openaiModel: env.OPENAI_MODEL || "gpt-4.1-mini",
  openaiBaseUrl: (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
  llmTimeoutMs: Number(env.LLM_TIMEOUT_MS || 15000),
  dataDir: new URL(env.DATA_DIR ? `file://${env.DATA_DIR.replace(/\/?$/, "/")}` : "../data/", import.meta.url),
  storeDir: new URL(env.STORE_DIR ? `file://${env.STORE_DIR.replace(/\/?$/, "/")}` : "../data/store/", import.meta.url),
  advisorKey: env.ADVISOR_KEY || "advisor-demo",
  maxMessageChars: 1000,
  rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MIN || 20),
  defaultRadiusKm: 50,
};

export const llmEnabled = () => Boolean(config.openaiKey);
