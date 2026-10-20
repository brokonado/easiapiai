// opencode and Kilo Code token usage per seller, model and month, from their local session stores.
//
// ONE reader: `read(ctx)` returns {name: "opencode", ...} with the rows of BOTH tools (Kilo Code 7.x is an opencode
// fork with the same schema; a model used in both is one row). There is no separate readKilo.
//
// Schema verified against the source (anomalyco/opencode tag v1.19.3, commit e3c4eb2; Kilo-Org/kilocode 5cc65d1,
// packages/opencode 7.8.15):
// - where: xdg-basedir's data dir, $XDG_DATA_HOME or ~/.local/share, on EVERY OS (packages/core/src/global.ts:3-11),
//   + "opencode" (Kilo: "kilo"). Database: opencode.db, or opencode-<channel>.db for other release channels, or
//   $OPENCODE_DB (absolute, or relative to that dir) (packages/core/src/database/database.ts:43-55). Kilo: kilo.db,
//   kilo-<channel>.db, a pre-existing opencode-<channel>.db, or $KILO_DB. We read every opencode*.db (Kilo also
//   kilo*.db) in the folder.
// - table `message`, column `data` = JSON of SessionV1.Info (packages/core/src/session/sql.ts:68-80). Assistant
//   messages (packages/schema/src/v1/session.ts:453-485): providerID, modelID, time{created,completed} (ms),
//   cost, tokens{total?, input, output, reasoning, cache{read, write}}, error?{name, data{statusCode?, ...}}.
//   One assistant message = one model call (packages/opencode/src/session/prompt.ts:1187 makes a new one per step).
//   The SQL pulls only those fields with json_extract (plus the message id, to count a message once); the message
//   text lives in other tables (`part`), which are never touched, and nothing else in `data` reaches JavaScript.
// - older versions kept each message as storage/message/<session>/<message>.json in the same folder; a one-time
//   import copies them into the database under the same id (Kilo's packages/opencode/src/kilocode/storage/
//   json-migration.ts:346-378) and leaves the files, so a file whose id is already in a database is skipped.
//
// Token meaning (the same for every easiapiai source): input_tokens = every input token that was not a cache read
// (uncached input + cache writes), cached_input_tokens = cache reads.
// - opencode's tokens.input already excludes cache reads AND writes: getUsage stores
//   input = inputTokens - cacheRead - cacheWrite (packages/opencode/src/session/session.ts:361-364; v1.2.0 did the
//   same for every provider but Anthropic/Bedrock, whose inputTokens already excluded them). So
//   input_tokens = tokens.input + tokens.cache.write, cached_input_tokens = tokens.cache.read.
// - reasoning: since v1.2 opencode stores output = outputTokens - reasoning (session.ts:371) and its own cost charges
//   reasoning at the output price (session.ts:398-400); `opencode stats` reports output + reasoning
//   (packages/opencode/src/cli/cmd/stats.ts:198-199). So output_tokens = output + reasoning. Records written by
//   v1.2.x (AI SDK v5) kept reasoning inside output as well; those carry tokens.total, and when total matches
//   input + cache + output (reasoning already inside output) reasoning is not added again. Records older than
//   tokens.total (before 2026-02) add reasoning, as opencode's own stats does.
// - cost_usd: opencode's recorded cost (its estimate from models.dev prices, or the provider's figure) summed, only
//   when every counted message of the row has a cost above 0 (0 means no price known or a subscription).
//
// requests = assistant messages with any tokens. errors (the message's final error; retries that later succeeded
// are kept in `part` rows and are not read): APIError by statusCode (429 rate_limit, 529 overloaded, 5xx server,
// 401/403 auth, otherwise other); ProviderAuthError auth; MessageAbortedError (the user stopped it),
// MessageOutputLengthError and StructuredOutputError are not API failures and are not counted; any other error
// (UnknownError, ContextOverflowError, ContentFilterError, ...) other. A failed message with no tokens counts as an
// error only, not as a request.
//
// Not read: the newer `session_message` table, which only the experimental V2 runner (packages/cli, "lildax")
// writes; the opencode CLI records every model call in `message` (packages/core/src/session/projector.ts:260-272).
//
// SQLite needs node:sqlite (Node.js 22.13+ without flags). It is imported only when a database exists; on older
// Node.js the databases are skipped with a note (old JSON files are still read).
import fs from "node:fs";
import path from "node:path";

import { isDict } from "../py.mjs";

export const NAME = "opencode";

// providers that are not paid API sellers (local models; Copilot's subscription)
const SKIP = new Set(["ollama", "lmstudio", "llama.cpp", "github-copilot"]);
// opencode provider ids (models.dev ids) -> easiapiai seller names; any other id is sent as it is
const SELLERS = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  deepseek: "DeepSeek",
  google: "Google AI Studio",
};

export const SQLITE_NOTE = "opencode/Kilo database skipped: needs Node 22.13+";
const MAX_NAME = 100;

// ------------------------------------------------------------------ shared with cline.mjs

// a token count: a finite number above 0, rounded; anything else 0
export function tokens(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

// "YYYY-MM" in local time of a time in milliseconds since 1970, or null
export function monthOfMs(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getFullYear()).padStart(4, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// an HTTP status -> error kind
export function statusKind(status) {
  if (typeof status !== "number" || !Number.isFinite(status)) return "other";
  if (status === 429) return "rate_limit";
  if (status === 529) return "overloaded";
  if (status >= 500 && status <= 599) return "server";
  if (status === 401 || status === 403) return "auth";
  return "other";
}

// a provider or model id fit to send: a non-empty string of at most 100 characters without control characters
export function plainId(v) {
  return typeof v === "string" && v.trim() !== "" && v.length <= MAX_NAME && !/[\u0000-\u001f\u007f]/.test(v);
}

// the easiapiai seller for a provider id: the table's name for it (case-insensitive), else the id as it is
export function sellerName(table, provider) {
  const id = provider.toLowerCase();
  return Object.prototype.hasOwnProperty.call(table, id) ? table[id] : provider;
}

const ERROR_KINDS = ["rate_limit", "overloaded", "server", "auth", "other"];

// Sums per (seller, model, month); rows() gives the rows of the reader interface
export class Totals {
  constructor(months) {
    this.months = Array.isArray(months) ? new Set(months) : null;
    this.groups = new Map();
  }

  wants(month) {
    return month !== null && (this.months === null || this.months.has(month));
  }

  group(seller, model, month) {
    const key = JSON.stringify([seller, model, month]);
    let g = this.groups.get(key);
    if (!g) {
      g = { seller, model, month, input: 0, output: 0, cached: 0, cachedKnown: false, requests: 0, cost: 0,
        costMissing: false, errors: {} };
      this.groups.set(key, g);
    }
    return g;
  }

  // one model call: input (uncached + cache writes), output, cached (cache reads, or null when not recorded), cost
  addRequest(seller, model, month, { input, output, cached, cost }) {
    const g = this.group(seller, model, month);
    g.requests += 1;
    g.input += input;
    g.output += output;
    if (cached !== null) {
      g.cached += cached;
      g.cachedKnown = true;
    }
    if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) g.cost += cost;
    else g.costMissing = true;
  }

  // tokens with no request count (e.g. Cline's totals of deleted requests)
  addTokens(seller, model, month, { input, output, cached, cost }) {
    const g = this.group(seller, model, month);
    g.input += input;
    g.output += output;
    if (cached !== null) {
      g.cached += cached;
      g.cachedKnown = true;
    }
    if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) g.cost += cost;
    else g.costMissing = true;
  }

  addError(seller, model, month, kind) {
    const g = this.group(seller, model, month);
    g.errors[kind] = (g.errors[kind] || 0) + 1;
  }

  rows() {
    const out = [];
    for (const g of this.groups.values()) {
      const row = { seller: g.seller, model: g.model, month: g.month, input_tokens: g.input, output_tokens: g.output };
      if (g.cachedKnown) row.cached_input_tokens = g.cached;
      row.requests = g.requests;
      if (ERROR_KINDS.some((k) => g.errors[k])) {
        row.errors = {};
        for (const k of ERROR_KINDS) row.errors[k] = g.errors[k] || 0;
      }
      const counted = g.requests > 0 || g.input + g.output + g.cached > 0;
      if (counted && !g.costMissing) row.cost_usd = Math.round(g.cost * 1e6) / 1e6;
      out.push(row);
    }
    const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    return out.sort((a, b) => cmp(a.seller, b.seller) || cmp(a.model, b.model) || cmp(a.month, b.month));
  }
}

// ------------------------------------------------------------------ where the files are

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// xdg-basedir's xdgData: $XDG_DATA_HOME or <home>/.local/share (opencode uses it on Windows and macOS too)
function dataHome(ctx) {
  const env = ctx.env || {};
  return env.XDG_DATA_HOME || path.join(ctx.home, ".local", "share");
}

// [{tool, dir, dbs: [paths]}] for opencode and Kilo Code
export function stores(ctx) {
  const env = ctx.env || {};
  const base = dataHome(ctx);
  const out = [];
  for (const [tool, app, prefixes, envVar] of [
    ["opencode", "opencode", ["opencode"], "OPENCODE_DB"],
    ["kilo", "kilo", ["kilo", "opencode"], "KILO_DB"],
  ]) {
    const dir = path.join(base, app);
    const dbs = [];
    for (const e of listDir(dir)) {
      if (!e.name.endsWith(".db") || !prefixes.some((p) => e.name.startsWith(p))) continue;
      const p = path.join(dir, e.name);
      if (isFile(p)) dbs.push(p);
    }
    const named = (env[envVar] || "").trim();
    if (named && named !== ":memory:") {
      const p = path.isAbsolute(named) ? named : path.join(dir, named);
      if (!dbs.includes(p) && isFile(p)) dbs.push(p);
    }
    out.push({ tool, dir, dbs: dbs.sort() });
  }
  return out;
}

// [[message id, path]] of the old per-message JSON files: <dir>/storage/message/<session>/<message>.json
function legacyFiles(dir) {
  const root = path.join(dir, "storage", "message");
  const out = [];
  for (const s of listDir(root)) {
    if (!s.isDirectory()) continue;
    const sdir = path.join(root, s.name);
    for (const f of listDir(sdir)) {
      if (f.isFile() && f.name.endsWith(".json")) out.push([f.name.slice(0, -5), path.join(sdir, f.name)]);
    }
  }
  return out.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
}

// ------------------------------------------------------------------ SQLite

// node:sqlite's DatabaseSync, or null when this Node.js has none. Node 22/23 print an ExperimentalWarning when the
// module loads; that one warning is dropped so that the background hook prints nothing.
export async function loadSqlite() {
  const emit = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const type = typeof rest[0] === "string" ? rest[0] : rest[0] && rest[0].type;
    const text = warning && typeof warning === "object" ? warning.message : warning;
    if ((type === "ExperimentalWarning" || (warning && warning.name === "ExperimentalWarning"))
      && /sqlite/i.test(String(text))) return undefined;
    return emit.call(process, warning, ...rest);
  };
  try {
    const mod = await import("node:sqlite");
    return typeof mod.DatabaseSync === "function" ? mod.DatabaseSync : null;
  } catch {
    return null;
  } finally {
    process.emitWarning = emit;
  }
}

// json_extract only on valid JSON: one malformed row must not fail the whole query
const J = (p) => `CASE WHEN json_valid(data) THEN json_extract(data, '${p}') END`;
const QUERY = `SELECT id,
  ${J("$.providerID")} AS provider, ${J("$.modelID")} AS model, ${J("$.time.created")} AS created,
  ${J("$.tokens.input")} AS input, ${J("$.tokens.output")} AS output, ${J("$.tokens.reasoning")} AS reasoning,
  ${J("$.tokens.cache.read")} AS cache_read, ${J("$.tokens.cache.write")} AS cache_write,
  ${J("$.tokens.total")} AS total, ${J("$.cost")} AS cost,
  CASE WHEN json_valid(data) THEN json_type(data, '$.error') END AS error_type,
  ${J("$.error.name")} AS error_name, ${J("$.error.data.statusCode")} AS status
FROM message WHERE ${J("$.role")} = 'assistant'`;

// the rows of one database, as plain records (numbers and ids only)
function dbRecords(DatabaseSync, file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(QUERY).all().map((r) => ({
      id: typeof r.id === "string" ? r.id : null,
      provider: r.provider, model: r.model, created: r.created,
      input: r.input, output: r.output, reasoning: r.reasoning, cacheRead: r.cache_read, cacheWrite: r.cache_write,
      total: r.total, cost: r.cost,
      hasError: r.error_type !== null && r.error_type !== undefined && r.error_type !== "null",
      errorName: r.error_name, status: r.status,
    }));
  } finally {
    db.close();
  }
}

// one old message file as a record, or null (not an assistant message, unreadable or malformed)
function fileRecord(file) {
  let d;
  try {
    d = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!isDict(d) || d.role !== "assistant") return null;
  const t = isDict(d.tokens) ? d.tokens : {};
  const cache = isDict(t.cache) ? t.cache : {};
  const time = isDict(d.time) ? d.time : {};
  const err = d.error;
  const data = isDict(err) && isDict(err.data) ? err.data : {};
  return {
    provider: d.providerID, model: d.modelID, created: time.created,
    input: t.input, output: t.output, reasoning: t.reasoning, cacheRead: cache.read, cacheWrite: cache.write,
    total: t.total, cost: d.cost,
    hasError: err !== undefined && err !== null, errorName: isDict(err) ? err.name : null, status: data.statusCode,
  };
}

// ------------------------------------------------------------------ counting

// the error kind of an assistant message's error, or null when it is not a failed API request
export function errorKind(name, status) {
  if (name === "APIError") return statusKind(status);
  if (name === "ProviderAuthError") return "auth";
  if (name === "MessageAbortedError" || name === "MessageOutputLengthError" || name === "StructuredOutputError") {
    return null;
  }
  return "other";
}

// output including reasoning, counting reasoning once (see the top of this file)
export function outputTokens(r) {
  const output = tokens(r.output);
  const reasoning = tokens(r.reasoning);
  if (!reasoning) return output;
  const total = tokens(r.total);
  if (total) {
    const base = tokens(r.input) + tokens(r.cacheRead) + tokens(r.cacheWrite) + output;
    if (Math.abs(total - base) <= Math.abs(total - (base + reasoning))) return output;
  }
  return output + reasoning;
}

function count(totals, r) {
  if (!plainId(r.provider) || !plainId(r.model)) return;
  const provider = r.provider.trim();
  if (SKIP.has(provider.toLowerCase())) return;
  const month = monthOfMs(r.created);
  if (!totals.wants(month)) return;
  const seller = sellerName(SELLERS, provider);
  const usage = {
    input: tokens(r.input) + tokens(r.cacheWrite),
    output: outputTokens(r),
    cached: tokens(r.cacheRead),
    cost: r.cost,
  };
  const kind = r.hasError ? errorKind(r.errorName, r.status) : null;
  if (usage.input + usage.output + usage.cached > 0) totals.addRequest(seller, r.model, month, usage);
  if (kind) totals.addError(seller, r.model, month, kind);
}

// {name, found, rows, note}
export async function read(ctx) {
  const totals = new Totals(ctx.months);
  const seen = new Set();
  const places = stores(ctx);
  let found = false;
  let skipped = 0;
  let failed = 0;
  const allDbs = places.flatMap((p) => p.dbs);
  if (allDbs.length) {
    found = true;
    const DatabaseSync = await loadSqlite();
    for (const file of allDbs) {
      if (!DatabaseSync) {
        skipped += 1;
        continue;
      }
      let records;
      try {
        records = dbRecords(DatabaseSync, file);
      } catch {
        failed += 1;
        continue;
      }
      for (const r of records) {
        if (r.id !== null) {
          if (seen.has(r.id)) continue;
          seen.add(r.id);
        }
        count(totals, r);
      }
    }
  }
  for (const place of places) {
    for (const [id, file] of legacyFiles(place.dir)) {
      found = true;
      if (seen.has(id)) continue;
      seen.add(id);
      const r = fileRecord(file);
      if (r) count(totals, r);
    }
  }
  let note = null;
  if (skipped) note = SQLITE_NOTE;
  else if (failed) note = `opencode/Kilo: ${failed} database${failed === 1 ? "" : "s"} could not be read`;
  return { name: NAME, found, rows: totals.rows(), note };
}
