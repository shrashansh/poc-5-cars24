// JSON-file store with an in-memory cache.
//
// Every collection (users, sessions, messages, tickets, events, llm cache) is held in memory and
// written back to data/store/<name>.json. Writes are debounced and atomic (write a temp file, then
// rename), so a crash mid-write never leaves a half-written file. Swap this module for Postgres or
// Redis in production; the rest of the app only uses get / put / list / update / append.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { randomUUID, randomBytes } from "node:crypto";
import { config } from "./config.js";

const COLLECTIONS = ["users", "sessions", "messages", "tickets", "events", "llmcache"];
const FLUSH_MS = 150;

export class Store {
  constructor(dir = config.storeDir, { persist = true } = {}) {
    this.dir = dir;
    this.persist = persist;
    this.data = {};
    this.dirty = new Set();
    this.timer = null;
    if (persist) mkdirSync(dir, { recursive: true });
    for (const c of COLLECTIONS) this.data[c] = persist ? this.#load(c) : {};
  }

  #file(c) { return new URL(`${c}.json`, this.dir); }

  #load(c) {
    const f = this.#file(c);
    if (!existsSync(f)) return {};
    try { return JSON.parse(readFileSync(f, "utf8")); }
    catch {
      // A corrupt file is kept aside rather than overwritten, and the store starts that collection empty.
      renameSync(f, new URL(`${c}.corrupt-${Date.now()}.json`, this.dir));
      return {};
    }
  }

  #touch(c) {
    if (!this.persist) return;
    this.dirty.add(c);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    for (const c of this.dirty) {
      const f = this.#file(c), tmp = new URL(`${c}.json.tmp`, this.dir);
      writeFileSync(tmp, JSON.stringify(this.data[c]));
      renameSync(tmp, f);
    }
    this.dirty.clear();
  }

  get(c, id) { return this.data[c][id] ?? null; }
  list(c, pred = () => true) { return Object.values(this.data[c]).filter(pred); }
  put(c, id, value) { this.data[c][id] = value; this.#touch(c); return value; }
  update(c, id, fn) {
    const cur = this.data[c][id];
    if (cur === undefined) return null;
    const next = fn(cur) ?? cur;
    this.data[c][id] = next;
    this.#touch(c);
    return next;
  }
  remove(c, id) { delete this.data[c][id]; this.#touch(c); }

  // Append-only log keyed by a parent id (messages per session, events per user).
  append(c, key, item) {
    (this.data[c][key] ??= []).push(item);
    this.#touch(c);
    return item;
  }
  items(c, key) { return this.data[c][key] ?? []; }
}

export const newId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
export const newToken = () => randomBytes(18).toString("base64url");

// Serialise work per key (one session processes one message at a time, in order).
const chains = new Map();
export function serial(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  chains.set(key, tail);
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return next;
}
