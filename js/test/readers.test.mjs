// The opencode/Kilo and Cline usage readers, on synthetic files modelled on the schemas cited at the top of
// js/readers/opencode.mjs and js/readers/cline.mjs (this machine has none of these tools). Every test uses a fake
// home; nothing reads the real ~/.local/share, ~/.config or ~/.cline.
//
// Months are local time: the whole file runs in a fixed zone, UTC+5 without daylight saving.
process.env.TZ = "Etc/GMT-5";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import * as cline from "../readers/cline.mjs";
import * as opencode from "../readers/opencode.mjs";

const DatabaseSync = await opencode.loadSqlite();
const HAS_SQLITE = DatabaseSync !== null;
const MONTHS = ["2026-09", "2026-10"];
const SEP = Date.parse("2026-09-15T12:00:00Z");
const OCT = Date.parse("2026-10-05T12:00:00Z");
const JUL = Date.parse("2026-07-10T12:00:00Z");
const SECRET = "SECRET-do-not-leak";

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "easiapiai-readers-"));
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
}

function ctx(home, { env = {}, platform = "linux", months = MONTHS } = {}) {
  return { home, env, platform, now: new Date("2026-10-20T12:00:00Z"), months };
}

// ------------------------------------------------------------------ opencode fixtures

function apiError(statusCode) {
  const data = { message: `${SECRET} provider said no`, isRetryable: true, responseBody: SECRET };
  if (statusCode !== undefined) data.statusCode = statusCode;
  return { name: "APIError", data };
}

// an assistant message as opencode stores it in message.data (packages/schema/src/v1/session.ts Assistant)
function asst(provider, model, created, { input = 0, output = 0, reasoning = 0, read = 0, write: cw = 0, total,
  cost = 0, error } = {}) {
  const tokens = { input, output, reasoning, cache: { read, write: cw } };
  if (total !== undefined) tokens.total = total;
  const m = {
    role: "assistant", parentID: "msg_parent", modelID: model, providerID: provider, mode: "build", agent: "build",
    path: { cwd: `/home/u/${SECRET}`, root: `/home/u/${SECRET}` }, time: { created, completed: created + 1000 },
    cost, tokens, finish: "stop",
  };
  if (error) m.error = error;
  return m;
}

const USER_MSG = { role: "user", time: { created: SEP }, agent: "build", model: { providerID: "anthropic", modelID: "x" },
  summary: { title: SECRET } };

// a database with opencode's tables (only `message` is read; the others hold text that must never be read)
function makeDb(file, messages) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE credential (id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
  db.prepare("INSERT INTO session VALUES (?, ?)").run("ses_1", SECRET);
  db.prepare("INSERT INTO part VALUES (?, ?, ?, ?)").run("prt_1", "msg_001", "ses_1",
    JSON.stringify({ type: "text", text: SECRET }));
  db.prepare("INSERT INTO credential VALUES (?, ?)").run("anthropic", JSON.stringify({ key: `sk-${SECRET}` }));
  const ins = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
  for (const [id, data] of messages) {
    ins.run(id, "ses_1", 1, 1, typeof data === "string" ? data : JSON.stringify(data));
  }
  db.close();
}

const OC_MAIN = [
  ["msg_001", asst("anthropic", "claude-sonnet-4-5", SEP, { input: 100, output: 50, read: 1000, write: 200, cost: 0.01 })],
  // v1.19 semantics: output excludes reasoning, total = everything -> reasoning added
  ["msg_002", asst("openai", "gpt-5", SEP, { input: 100, output: 40, reasoning: 60, total: 200, cost: 0.02 })],
  // v1.2 semantics: output already includes reasoning, total says so -> not added again
  ["msg_003", asst("openai", "gpt-5", SEP, { input: 50, output: 100, reasoning: 30, total: 150, cost: 0.03 })],
  // no total: as opencode's own stats, output + reasoning
  ["msg_004", asst("openai", "gpt-5", SEP, { input: 10, output: 10, reasoning: 5, cost: 0.04 })],
  ["msg_005", USER_MSG],
  ["msg_006", asst("ollama", "llama3", SEP, { input: 999, output: 999 })],
  ["msg_007", asst("github-copilot", "gpt-4.1", SEP, { input: 999, output: 999 })],
  ["msg_008", asst("anthropic", "claude-sonnet-4-5", SEP, { error: apiError(429) })],
  ["msg_009", asst("anthropic", "claude-sonnet-4-5", SEP, { error: apiError(529) })],
  ["msg_010", asst("anthropic", "claude-sonnet-4-5", SEP, { error: apiError(503) })],
  ["msg_011", asst("anthropic", "claude-sonnet-4-5", SEP,
    { error: { name: "ProviderAuthError", data: { providerID: "anthropic", message: SECRET } } })],
  ["msg_012", asst("anthropic", "claude-sonnet-4-5", SEP, { error: apiError(401) })],
  ["msg_013", asst("anthropic", "claude-sonnet-4-5", SEP, { error: { name: "UnknownError", data: { message: SECRET } } })],
  // stopped by the user after some tokens: a request, not an error
  ["msg_014", asst("anthropic", "claude-sonnet-4-5", SEP, { input: 5, output: 5, cost: 0.001,
    error: { name: "MessageAbortedError", data: { message: "aborted" } } })],
  ["msg_015", asst("anthropic", "claude-sonnet-4-5", SEP, { error: apiError(undefined) })],
  ["msg_016", `{"role":"assistant", ${SECRET} not json`],
  ["msg_017", asst("anthropic", "claude-sonnet-4-5", JUL, { input: 999, output: 999, cost: 9 })],
  ["msg_018", asst("my-proxy", "glm-4.6", OCT, { input: 1, output: 2, cost: 0 })],
  ["msg_019", asst("deepseek", "deepseek-chat", OCT, { input: 10, output: 1, read: 5, cost: 0.002 })],
  ["msg_020", asst("deepseek", "deepseek-chat", OCT, { input: 1, cost: 0 })],
];
const OC_BETA = [
  ["msg_001", OC_MAIN[0][1]], // the same message in a second database: counted once
  ["msg_101", asst("google", "gemini-2.5-pro", OCT, { input: 7, output: 3, cost: 0.5 })],
];
const KILO = [
  ["msg_201", asst("kilo", "anthropic/claude-sonnet-4.5", OCT, { input: 20, output: 2, cost: 0.1 })],
  ["msg_202", asst("openrouter", "x-ai/grok-code-fast-1", OCT, { input: 30, output: 3, cost: 0.2 })],
];

function legacyMessages(dir) {
  const d = path.join(dir, "storage", "message", "ses_old");
  write(path.join(d, "msg_001.json"), { id: "msg_001", sessionID: "ses_old", ...OC_MAIN[0][1] }); // imported: skip
  write(path.join(d, "msg_301.json"), { id: "msg_301", sessionID: "ses_old",
    ...asst("anthropic", "claude-sonnet-4-5", SEP, { input: 1, output: 1, cost: 0.001 }) });
  write(path.join(d, "msg_302.json"), { id: "msg_302", sessionID: "ses_old", ...USER_MSG });
  write(path.join(d, "broken.json"), `{"role": "assistant", "providerID": "${SECRET}`);
}

const OC_EXPECTED = [
  { seller: "Anthropic", model: "claude-sonnet-4-5", month: "2026-09", input_tokens: 306, output_tokens: 56,
    cached_input_tokens: 1000, requests: 3, errors: { rate_limit: 1, overloaded: 1, server: 1, auth: 2, other: 2 },
    cost_usd: 0.012 },
  { seller: "DeepSeek", model: "deepseek-chat", month: "2026-10", input_tokens: 11, output_tokens: 1,
    cached_input_tokens: 5, requests: 2 },
  { seller: "Google AI Studio", model: "gemini-2.5-pro", month: "2026-10", input_tokens: 7, output_tokens: 3,
    cached_input_tokens: 0, requests: 1, cost_usd: 0.5 },
  { seller: "OpenAI", model: "gpt-5", month: "2026-09", input_tokens: 160, output_tokens: 215,
    cached_input_tokens: 0, requests: 3, cost_usd: 0.09 },
  { seller: "OpenRouter", model: "x-ai/grok-code-fast-1", month: "2026-10", input_tokens: 30, output_tokens: 3,
    cached_input_tokens: 0, requests: 1, cost_usd: 0.2 },
  { seller: "kilo", model: "anthropic/claude-sonnet-4.5", month: "2026-10", input_tokens: 20, output_tokens: 2,
    cached_input_tokens: 0, requests: 1, cost_usd: 0.1 },
  { seller: "my-proxy", model: "glm-4.6", month: "2026-10", input_tokens: 1, output_tokens: 2,
    cached_input_tokens: 0, requests: 1 },
];

// ------------------------------------------------------------------ Cline fixtures

const T = (iso) => Date.parse(iso);
const req = (ts, info, extra = {}) => ({ ts, type: "say", say: "api_req_started",
  text: JSON.stringify({ request: `${SECRET} the whole prompt`, ...info }), ...extra });
const clineError = (status) => JSON.stringify({ message: `${SECRET} 429 body`, status, request_id: "req_1",
  modelId: "m", providerId: "p" });

function vscodeRoot(home, app = "Code") {
  return path.join(home, ".config", app, "User", "globalStorage", "saoudrizwan.claude-dev");
}

function classicTask(root, id, messages, metadata) {
  const dir = path.join(root, "tasks", id);
  write(path.join(dir, "ui_messages.json"), messages);
  write(path.join(dir, "api_conversation_history.json"), [{ role: "user", content: SECRET }]);
  if (metadata) write(path.join(dir, "task_metadata.json"), metadata);
}

function clineFixture(home) {
  const root = vscodeRoot(home);
  classicTask(root, "1760000000001", [
    { ts: T("2026-09-10T00:00:01Z"), type: "say", say: "task", text: `${SECRET} do the thing` },
    req(T("2026-09-12T12:00:00Z"), { tokensIn: 10, tokensOut: 20, cacheWrites: 30, cacheReads: 40, cost: 0.5 }),
    { ts: T("2026-09-12T12:01:00Z"), type: "say", say: "error_retry",
      text: JSON.stringify({ attempt: 1, maxAttempts: 3, delaySeconds: 2, errorMessage: clineError(429) }) },
    { ts: T("2026-09-12T12:02:00Z"), type: "say", say: "error_retry",
      text: JSON.stringify({ attempt: 3, maxAttempts: 3, delaySeconds: 0, failed: true, errorMessage: clineError(500) }) },
    { ts: T("2026-09-12T12:02:01Z"), type: "ask", ask: "api_req_failed", text: clineError(500) }, // same failure
    { ts: T("2026-09-12T12:03:00Z"), type: "ask", ask: "api_req_failed", text: clineError(401) },
    { ts: T("2026-09-12T12:04:00Z"), type: "say", say: "error_retry",
      text: JSON.stringify({ attempt: 1, maxAttempts: 3, errorMessage: "No assistant message was received." }) },
    { ts: T("2026-09-12T13:00:00Z"), type: "say", say: "deleted_api_reqs",
      text: JSON.stringify({ tokensIn: 7, tokensOut: 3, cacheWrites: 0, cacheReads: 0, cost: 0.1 }) },
    { ts: T("2026-09-12T14:00:00Z"), type: "say", say: "api_req_started", text: `{"request": "${SECRET}` },
    req(T("2026-09-12T15:00:00Z"), { cancelReason: "streaming_failed", streamingFailedMessage: clineError(503) }),
    // DeepSeek: Cline records cache misses as cacheWrites and tokensIn ~0
    req(T("2026-09-21T00:00:00Z"), { tokensIn: 0, tokensOut: 5, cacheWrites: 100, cacheReads: 50, cost: 0.01 }),
    req(T("2026-10-02T00:00:00Z"), { tokensIn: 11, tokensOut: 12, cost: 0.3 },
      { modelInfo: { providerId: "openrouter", modelId: "x-ai/grok-4", mode: "act" } }),
    req(T("2026-10-02T00:01:00Z"), { tokensIn: 999, tokensOut: 999 },
      { modelInfo: { providerId: "openai", modelId: "qwen-local", mode: "act" } }),
    req(T("2026-10-02T00:02:00Z"), { tokensIn: 999, tokensOut: 999 },
      { modelInfo: { providerId: "vscode-lm", modelId: "copilot/gpt-4.1", mode: "act" } }),
    req(T("2026-07-01T00:00:00Z"), { tokensIn: 999, tokensOut: 999, cost: 9 }),
    { ts: T("2026-09-12T16:00:00Z"), type: "say", say: "text", text: SECRET },
  ], {
    files_in_context: [{ path: `/home/u/${SECRET}/a.ts`, record_state: "active", record_source: "read_tool" }],
    model_usage: [
      { ts: T("2026-09-20T00:00:00Z"), model_id: "deepseek-chat", model_provider_id: "deepseek", mode: "act" },
      { ts: T("2026-09-10T00:00:00Z"), model_id: "claude-sonnet-4-5", model_provider_id: "anthropic", mode: "act" },
    ],
    environment_history: [{ ts: 1, os_name: "linux", host_name: SECRET, cline_version: "3.89.2" }],
  });
  // no model_usage, no modelInfo: the task's HistoryItem gives the model
  const second = [req(T("2026-10-03T00:00:00Z"), { tokensIn: 5, tokensOut: 6, cacheWrites: 0, cacheReads: 1, cost: 0.02 })];
  classicTask(root, "1760000000002", second);
  write(path.join(root, "state", "taskHistory.json"), [
    { id: "1760000000002", ts: 1, task: `${SECRET} first prompt`, tokensIn: 5, tokensOut: 6, totalCost: 0.02,
      modelId: "gemini-2.5-pro", apiProvider: "gemini", cwdOnTaskInitialization: `/home/u/${SECRET}` },
    { id: "nope", task: SECRET },
    "junk",
  ]);
  classicTask(root, "1760000000003", `[{"ts": 1, "type": "say", "say": "api_req_started", "text": "${SECRET}`);
  // the JetBrains/CLI data dir: the same task id again (read once) and two more tasks
  const data = path.join(home, ".cline", "data");
  classicTask(data, "1760000000002", second);
  classicTask(data, "1760000000004", [
    req(T("2026-10-04T00:00:00Z"), { tokensIn: 999, tokensOut: 999, cost: 1 },
      { modelInfo: { providerId: "claude-code", modelId: "claude-sonnet-4-5", mode: "act" } }),
    req(T("2026-10-04T00:01:00Z"), { tokensIn: 3, tokensOut: 4, cost: 0.05 },
      { modelInfo: { providerId: "cline", modelId: "anthropic/claude-sonnet-4.5", mode: "act" } }),
  ]);
  // SDK / CLI sessions
  const sdir = path.join(data, "sessions", "1760000000000_abcde");
  const am = (ts, provider, id, metrics) => ({ id: `msg_${ts}`, role: "assistant",
    content: [{ type: "text", text: SECRET }], ts, ...(provider ? { modelInfo: { id, provider } } : {}), metrics });
  write(path.join(sdir, "1760000000000_abcde.messages.json"), {
    version: 1, updated_at: "2026-10-03T00:00:00Z", agent: "lead", sessionId: "1760000000000_abcde",
    origin: { source: "cli", mode: "user", sessionId: "1760000000000_abcde" },
    messages: [
      { id: "m0", role: "user", content: `${SECRET} prompt`, ts: T("2026-10-03T00:00:00Z") },
      am(T("2026-10-03T00:00:01Z"), "anthropic", "claude-opus-4-1",
        { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 600, cacheWriteTokens: 300, cost: 0.2 }),
      // resuming a classic task stamps its whole total on the last message: not counted again
      am(T("2026-10-03T00:00:02Z"), "unknown", "gemini-2.5-pro", { inputTokens: 5, outputTokens: 6, cost: 0.02 }),
      am(T("2026-10-03T00:00:03Z"), null, null, { inputTokens: 999, outputTokens: 999 }),
    ],
    system_prompt: SECRET,
  });
  write(path.join(sdir, "agent_1.messages.json"), [
    am(T("2026-10-04T00:00:00Z"), "anthropic", "claude-opus-4-1",
      { inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.01 }),
  ]);
  write(path.join(sdir, "1760000000000_abcde.json"), { title: SECRET, prompt: SECRET });
  write(path.join(data, "sessions", "imported", "imported.messages.json"), {
    version: 1, origin: { source: "desktop", mode: "import", trigger: "claude-code" },
    messages: [am(T("2026-10-03T00:00:00Z"), "anthropic", "claude-sonnet-4-5",
      { inputTokens: 9999, outputTokens: 9999, cost: 0 })],
  });
  write(path.join(data, "sessions", "broken", "broken.messages.json"), `{"messages": [${SECRET}`);
}

const CLINE_EXPECTED = [
  { seller: "Anthropic", model: "claude-opus-4-1", month: "2026-10", input_tokens: 450, output_tokens: 105,
    cached_input_tokens: 600, requests: 2, cost_usd: 0.21 },
  { seller: "Anthropic", model: "claude-sonnet-4-5", month: "2026-09", input_tokens: 47, output_tokens: 23,
    cached_input_tokens: 40, requests: 1, errors: { rate_limit: 1, overloaded: 0, server: 1, auth: 1, other: 1 },
    cost_usd: 0.6 },
  { seller: "DeepSeek", model: "deepseek-chat", month: "2026-09", input_tokens: 100, output_tokens: 5,
    cached_input_tokens: 50, requests: 1, cost_usd: 0.01 },
  { seller: "Google AI Studio", model: "gemini-2.5-pro", month: "2026-10", input_tokens: 5, output_tokens: 6,
    cached_input_tokens: 1, requests: 1, cost_usd: 0.02 },
  { seller: "OpenRouter", model: "x-ai/grok-4", month: "2026-10", input_tokens: 11, output_tokens: 12, requests: 1,
    cost_usd: 0.3 },
  { seller: "cline", model: "anthropic/claude-sonnet-4.5", month: "2026-10", input_tokens: 3, output_tokens: 4,
    requests: 1, cost_usd: 0.05 },
];

// ------------------------------------------------------------------ privacy check

const TOP_KEYS = new Set(["name", "found", "rows", "note"]);
const ROW_KEYS = new Set(["seller", "model", "month", "input_tokens", "output_tokens", "cached_input_tokens",
  "requests", "errors", "cost_usd"]);
const ERROR_KEYS = new Set(["rate_limit", "overloaded", "server", "auth", "other"]);

function assertPrivate(res) {
  for (const k of Object.keys(res)) assert.ok(TOP_KEYS.has(k), `unexpected key ${k}`);
  assert.ok(Array.isArray(res.rows));
  for (const row of res.rows) {
    for (const [k, v] of Object.entries(row)) {
      assert.ok(ROW_KEYS.has(k), `unexpected row key ${k}`);
      if (k === "errors") {
        for (const [e, n] of Object.entries(v)) {
          assert.ok(ERROR_KEYS.has(e), `unexpected error key ${e}`);
          assert.ok(Number.isInteger(n) && n >= 0);
        }
      } else if (k === "cost_usd") assert.ok(typeof v === "number" && Number.isFinite(v) && v >= 0);
      else if (["seller", "model", "month"].includes(k)) assert.equal(typeof v, "string");
      else assert.ok(Number.isInteger(v) && v >= 0, `${k} must be a whole number`);
    }
  }
  const walk = (v) => {
    if (typeof v === "string") assert.ok(v.length <= 100, `string longer than 100 characters: ${v.length}`);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(res);
  assert.ok(!JSON.stringify(res).includes("SECRET"), "fixture text leaked into the result");
}

// ------------------------------------------------------------------ tests

describe("opencode / Kilo reader", () => {
  let home;
  beforeEach(() => {
    home = tempHome();
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it("finds nothing in an empty home", async () => {
    const res = await opencode.read(ctx(home));
    assert.deepEqual(res, { name: "opencode", found: false, rows: [], note: null });
  });

  it("reads opencode databases (main + channel), Kilo and old JSON files, counting each message once", async (t) => {
    if (!HAS_SQLITE) {
      t.skip("needs node:sqlite (Node 22.13+)");
      return;
    }
    const dir = path.join(home, ".local", "share", "opencode");
    makeDb(path.join(dir, "opencode.db"), OC_MAIN);
    makeDb(path.join(dir, "opencode-beta.db"), OC_BETA);
    makeDb(path.join(home, ".local", "share", "kilo", "kilo.db"), KILO);
    legacyMessages(dir);
    write(path.join(dir, "opencode.db-wal.json"), "not a database"); // not *.db: ignored
    const res = await opencode.read(ctx(home));
    assert.equal(res.name, "opencode");
    assert.equal(res.found, true);
    assert.equal(res.note, null);
    assert.deepEqual(res.rows, OC_EXPECTED);
    assertPrivate(res);
  });

  it("follows $XDG_DATA_HOME and $OPENCODE_DB", async (t) => {
    if (!HAS_SQLITE) {
      t.skip("needs node:sqlite (Node 22.13+)");
      return;
    }
    const xdg = path.join(home, "xdg");
    makeDb(path.join(xdg, "opencode", "opencode.db"), [OC_MAIN[0]]);
    makeDb(path.join(home, "elsewhere", "custom.sqlite"), [OC_BETA[1]]);
    makeDb(path.join(home, ".local", "share", "opencode", "opencode.db"), [KILO[0]]); // not used: XDG wins
    const res = await opencode.read(ctx(home, { env: { XDG_DATA_HOME: xdg,
      OPENCODE_DB: path.join(home, "elsewhere", "custom.sqlite") } }));
    assert.deepEqual(res.rows.map((r) => [r.seller, r.model, r.requests]),
      [["Anthropic", "claude-sonnet-4-5", 1], ["Google AI Studio", "gemini-2.5-pro", 1]]);
  });

  it("skips a database that cannot be read, with a note, and keeps the others", async (t) => {
    if (!HAS_SQLITE) {
      t.skip("needs node:sqlite (Node 22.13+)");
      return;
    }
    const dir = path.join(home, ".local", "share", "opencode");
    makeDb(path.join(dir, "opencode.db"), [OC_MAIN[0]]);
    write(path.join(dir, "opencode-dev.db"), `${SECRET} this is not sqlite`);
    const res = await opencode.read(ctx(home));
    assert.equal(res.found, true);
    assert.equal(res.rows.length, 1);
    assert.match(res.note, /1 database could not be read/);
    assertPrivate(res);
  });

  it("on Node.js without node:sqlite: database skipped with the note, old JSON files still read", async () => {
    const dir = path.join(home, ".local", "share", "opencode");
    legacyMessages(dir);
    if (HAS_SQLITE) {
      makeDb(path.join(dir, "opencode.db"), [OC_MAIN[0]]);
    } else {
      write(path.join(dir, "opencode.db"), "SQLite format 3\u0000");
    }
    const res = await opencode.read(ctx(home));
    assert.equal(res.found, true);
    const anthropic = res.rows.find((r) => r.seller === "Anthropic");
    if (HAS_SQLITE) {
      assert.equal(res.note, null);
      assert.equal(anthropic.requests, 2); // msg_001 from the database, msg_301 from its file
    } else {
      assert.equal(res.note, opencode.SQLITE_NOTE);
      assert.equal(res.note, "opencode/Kilo database skipped: needs Node 22.13+");
      assert.equal(anthropic.requests, 2); // both from files (msg_001.json is not known to be imported)
    }
    assertPrivate(res);
  });

  it("old JSON storage alone (any Node.js): found, corrupt files skipped", async () => {
    legacyMessages(path.join(home, ".local", "share", "opencode"));
    legacyMessages(path.join(home, ".local", "share", "kilo"));
    const res = await opencode.read(ctx(home));
    assert.equal(res.found, true);
    assert.equal(res.note, null);
    // msg_001 and msg_301 in each folder: ids are shared across both folders, so each counts once
    assert.deepEqual(res.rows, [{ seller: "Anthropic", model: "claude-sonnet-4-5", month: "2026-09",
      input_tokens: 301, output_tokens: 51, cached_input_tokens: 1000, requests: 2, cost_usd: 0.011 }]);
    assertPrivate(res);
  });

  it("puts a message in its local-time month", async () => {
    const d = path.join(home, ".local", "share", "opencode", "storage", "message", "ses_tz");
    // 2026-09-30 20:00 UTC is 2026-10-01 01:00 at UTC+5
    write(path.join(d, "msg_tz.json"), asst("anthropic", "claude-haiku-4-5", Date.parse("2026-09-30T20:00:00Z"),
      { input: 1, output: 1, cost: 0.001 }));
    assert.deepEqual((await opencode.read(ctx(home))).rows.map((r) => r.month), ["2026-10"]);
    assert.deepEqual((await opencode.read(ctx(home, { months: ["2026-09"] }))).rows, []);
  });

  it("classifies errors and counts reasoning once", () => {
    assert.equal(opencode.errorKind("APIError", 429), "rate_limit");
    assert.equal(opencode.errorKind("APIError", 529), "overloaded");
    assert.equal(opencode.errorKind("APIError", 500), "server");
    assert.equal(opencode.errorKind("APIError", 599), "server");
    assert.equal(opencode.errorKind("APIError", 403), "auth");
    assert.equal(opencode.errorKind("APIError", 400), "other");
    assert.equal(opencode.errorKind("APIError", null), "other");
    assert.equal(opencode.errorKind("ProviderAuthError", null), "auth");
    assert.equal(opencode.errorKind("ContextOverflowError", null), "other");
    assert.equal(opencode.errorKind("MessageAbortedError", null), null);
    assert.equal(opencode.errorKind("MessageOutputLengthError", null), null);
    assert.equal(opencode.outputTokens({ output: 40, reasoning: 60, input: 100, total: 200 }), 100);
    assert.equal(opencode.outputTokens({ output: 100, reasoning: 30, input: 50, total: 150 }), 100);
    assert.equal(opencode.outputTokens({ output: 10, reasoning: 5 }), 15);
    assert.equal(opencode.outputTokens({ output: 10, reasoning: 0, total: 99 }), 10);
    // provider ids are looked up as own keys only
    assert.equal(opencode.sellerName({ openai: "OpenAI" }, "OpenAI"), "OpenAI");
    assert.equal(opencode.sellerName({ openai: "OpenAI" }, "constructor"), "constructor");
    assert.equal(opencode.sellerName({ openai: "OpenAI" }, "__proto__"), "__proto__");
  });
});

describe("Cline reader", () => {
  let home;
  beforeEach(() => {
    home = tempHome();
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it("finds nothing in an empty home", async () => {
    const res = await cline.read(ctx(home));
    assert.deepEqual(res, { name: "cline", found: false, rows: [], note: null });
  });

  it("reads classic tasks and SDK sessions with models from modelInfo, model_usage and task history", async () => {
    clineFixture(home);
    const res = await cline.read(ctx(home));
    assert.equal(res.name, "cline");
    assert.equal(res.found, true);
    assert.equal(res.note, null);
    assert.deepEqual(res.rows, CLINE_EXPECTED);
    assertPrivate(res);
  });

  it("filters months in local time", async () => {
    clineFixture(home);
    const res = await cline.read(ctx(home, { months: ["2026-09"] }));
    assert.deepEqual(res.rows.map((r) => [r.seller, r.month]), [["Anthropic", "2026-09"], ["DeepSeek", "2026-09"]]);
    // 2026-09-30 20:00 UTC is October at UTC+5
    const root = vscodeRoot(home, "VSCodium");
    classicTask(root, "tz", [req(T("2026-09-30T20:00:00Z"), { tokensIn: 1, tokensOut: 1, cost: 0.001 },
      { modelInfo: { providerId: "anthropic", modelId: "claude-haiku-4-5", mode: "act" } })]);
    const tz = await cline.read(ctx(home, { months: ["2026-10"] }));
    assert.equal(tz.rows.find((r) => r.model === "claude-haiku-4-5").month, "2026-10");
  });

  it("finds the extension under macOS and Windows user-data folders", async () => {
    const info = { modelInfo: { providerId: "anthropic", modelId: "claude-haiku-4-5", mode: "act" } };
    classicTask(path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage",
      "saoudrizwan.claude-dev"), "mac", [req(SEP, { tokensIn: 2, tokensOut: 2 }, info)]);
    classicTask(path.join(home, "roaming", "Windsurf", "User", "globalStorage", "saoudrizwan.claude-dev"), "win",
      [req(SEP, { tokensIn: 3, tokensOut: 3 }, info)]);
    const mac = await cline.read(ctx(home, { platform: "darwin" }));
    assert.equal(mac.rows[0].input_tokens, 2);
    const win = await cline.read(ctx(home, { platform: "win32", env: { APPDATA: path.join(home, "roaming") } }));
    assert.equal(win.rows[0].input_tokens, 3);
    const lin = await cline.read(ctx(home, { platform: "linux" }));
    assert.equal(lin.found, false);
    const roots = cline.classicRoots(ctx("/h", { platform: "win32" }));
    assert.ok(roots.includes(path.join("/h", "AppData", "Roaming", "Code - Insiders", "User", "globalStorage",
      "saoudrizwan.claude-dev")));
    assert.equal(roots.at(-1), path.join("/h", ".cline", "data"));
  });

  it("follows CLINE_DIR, CLINE_DATA_DIR and CLINE_SESSION_DATA_DIR", async () => {
    const msg = (n) => [{ role: "assistant", ts: OCT, modelInfo: { id: "deepseek-chat", provider: "deepseek" },
      metrics: { inputTokens: n, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }];
    write(path.join(home, "cd", "data", "sessions", "s1", "s1.messages.json"), msg(10));
    write(path.join(home, "dd", "sessions", "s2", "s2.messages.json"), msg(20));
    write(path.join(home, "sd", "s3", "s3.messages.json"), msg(30));
    const input = async (env) => (await cline.read(ctx(home, { env }))).rows.map((r) => r.input_tokens);
    assert.deepEqual(await input({ CLINE_DIR: path.join(home, "cd") }), [10]);
    assert.deepEqual(await input({ CLINE_DIR: path.join(home, "cd"), CLINE_DATA_DIR: path.join(home, "dd") }), [20]);
    assert.deepEqual(await input({ CLINE_DATA_DIR: path.join(home, "dd"),
      CLINE_SESSION_DATA_DIR: path.join(home, "sd") }), [30]);
  });

  it("does not throw on corrupt files and counts an error-only month", async () => {
    const root = vscodeRoot(home);
    classicTask(root, "bad1", "{");
    classicTask(root, "bad2", { not: "an array" });
    classicTask(root, "errs", [
      { ts: OCT, type: "ask", ask: "api_req_failed", text: clineError(529),
        modelInfo: { providerId: "openrouter", modelId: "z-ai/glm-4.6", mode: "act" } },
      { ts: OCT, type: "say", say: "error_retry", text: "{broken",
        modelInfo: { providerId: "openrouter", modelId: "z-ai/glm-4.6", mode: "act" } },
    ], "{not json");
    write(path.join(home, ".cline", "data", "sessions", "x", "x.messages.json"), "");
    const res = await cline.read(ctx(home));
    assert.equal(res.found, true);
    assert.deepEqual(res.rows, [{ seller: "OpenRouter", model: "z-ai/glm-4.6", month: "2026-10", input_tokens: 0,
      output_tokens: 0, requests: 0, errors: { rate_limit: 0, overloaded: 1, server: 0, auth: 0, other: 1 } }]);
    assertPrivate(res);
  });

  it("parses only the numbers of a request record", () => {
    assert.deepEqual(cline.usageOf(JSON.stringify({ request: SECRET, tokensIn: 1, tokensOut: 2, cacheWrites: 3,
      cacheReads: 4, cost: 0.5, streamingFailedMessage: SECRET })), { input: 4, output: 2, cached: 4, cost: 0.5 });
    assert.equal(cline.usageOf("{nope"), null);
    assert.equal(cline.statusOf(clineError(429)), 429);
    assert.equal(cline.statusOf("plain text"), null);
  });
});
