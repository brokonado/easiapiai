// Cline token usage per seller, model and month: the VS Code extension's task files (classic format) and the
// Cline SDK / CLI session files.
//
// Schema verified against the source (cline/cline main at 0870796, 2026-10-20, which is SDK-based, and tag v3.89.2
// at e1bdeef, the last classic release):
// - classic tasks: <globalStorage>/tasks/<task id>/ui_messages.json, a JSON array of ClineMessage {ts, type, say,
//   ask, text, modelInfo?{providerId, modelId}} (apps/vscode/src/shared/ExtensionMessage.ts:191-221). globalStorage
//   is VS Code's own folder for the extension saoudrizwan.claude-dev (apps/vscode/src/extension.ts:600) under the
//   user-data folder of Code, Code - Insiders, Cursor, VSCodium or Windsurf; the JetBrains plugin and the old CLI use
//   $CLINE_DATA_DIR or ($CLINE_DIR or ~/.cline)/data instead (apps/vscode/src/standalone/vscode-context.ts:15-19,
//   shared/storage/storage-context.ts:93-99). Both are read; a task id seen twice is read once.
//   say "api_req_started": `text` is JSON ClineApiReqInfo {request, tokensIn, tokensOut, cacheWrites, cacheReads,
//   cost, ...} (ExtensionMessage.ts:382-391). Only the five numbers are taken; `request` (the prompt) and everything
//   else are dropped as soon as the text is parsed. say "deleted_api_reqs" (totals of requests the user deleted) and
//   "subagent_usage" (sub-agent totals) carry the same numbers and are added as tokens without a request count, as
//   Cline's own task totals do (apps/vscode/src/shared/getApiMetrics.ts:40-66).
//   Model and provider of a message: its own modelInfo (every message since ~v3.3x, v3.89.2 core/task/index.ts:839-
//   880), else the latest task_metadata.json model_usage entry {ts, model_id, model_provider_id} at or before the
//   message (ContextTrackerTypes.ts:11-31; recorded before each request, v3.89.2 core/task/index.ts:2375 vs 2623),
//   else the task's HistoryItem {id, modelId, apiProvider} in <globalStorage>/state/taskHistory.json
//   (shared/HistoryItem.ts; sdk/legacy-state-reader.ts:43-45). Only those fields are read from the two files.
// - SDK / CLI sessions (the current VS Code extension writes these, not ui_messages.json:
//   apps/vscode/src/sdk/sdk-task-control-coordinator.ts:143-144): $CLINE_SESSION_DATA_DIR or <data dir>/sessions,
//   <session id>/<stem>.messages.json, the lead session and its sub-agents/teammates as separate stems in the same
//   folder (sdk/packages/shared/src/storage/paths.ts:186-200, sdk/packages/core/src/services/session-artifacts.ts:
//   34-58,135-145). A file is {version, origin{mode,...}, messages[]} or a bare array
//   (core/src/runtime/host/runtime-host-support.ts:53-77); a message is MessageWithMetadata {role, ts,
//   modelInfo{id, provider}, metrics{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost}}
//   (sdk/packages/shared/src/llms/messages.ts:140-165), one assistant message per model call (usage delta,
//   sdk/packages/agents/src/agent-runtime.ts:2071-2078). Only role, ts, modelInfo, metrics and origin.mode are read.
//   Skipped: sessions imported from Claude Code, Codex or opencode (origin.mode "import",
//   core/src/services/session-import/service.ts:302-315) because those tools' own logs are read by their own readers;
//   and the aggregate that resuming a classic task stamps on its last message (provider "unknown",
//   apps/vscode/src/sdk/legacy-task-handling.ts:157-166), which the classic task files already count.
//
// Token meaning (the same for every easiapiai source): input_tokens = every input token that was not a cache read
// (uncached input + cache writes), cached_input_tokens = cache reads.
// - classic: tokensIn, cacheWrites and cacheReads are disjoint (getApiMetrics adds all three for a request's size,
//   getApiMetrics.ts:123). Checked per provider in v3.89.2 core/api/providers: anthropic tokensIn = input_tokens
//   (excludes cache, anthropic.ts:191); openrouter prompt - cached - cache writes (openrouter.ts:163-166); openai-native
//   prompt - cached (openai-native.ts:69-77, 655-672); gemini prompt - cached (gemini.ts:306); deepseek records the
//   cache MISSES as cacheWrites and tokensIn ~0 (deepseek.ts:63-74). So input_tokens = tokensIn + cacheWrites,
//   cached_input_tokens = cacheReads (left out of a row when no request recorded it): no double count, and DeepSeek's
//   real input is kept. (openrouter's rare fallback path leaves cache writes in tokensIn too, openrouter.ts:193-196.)
//   Output: tokensOut as recorded (OpenAI-style providers include reasoning; Gemini's thoughts are not recorded).
// - SDK: inputTokens is the full prompt INCLUDING cache reads and writes (core/src/services/usage.ts:69-74,
//   llms/src/providers/ai-sdk.ts:1175-1178), so input_tokens = inputTokens - cacheReadTokens. outputTokens has
//   reasoning stripped out (ai-sdk.ts:1357-1369) and the reasoning count is not saved
//   (core/src/runtime/config/agent-message-codec.ts:321-331): reasoning models' output is under-counted there.
// - cost_usd: Cline's recorded cost summed, only when every counted request of the row has a cost above 0.
//
// requests = classic api_req_started / SDK assistant messages with any tokens.
// errors: classic tasks record failed requests as say "error_retry" {attempt, errorMessage, failed?} (one per failed
// attempt, `failed: true` when retries ran out) and ask "api_req_failed" (the failure shown to the user, right after
// a `failed: true` error_retry unless auth/quota/spend-limit errors skipped the retries) (v3.89.2
// core/task/index.ts:2061-2199, 3017-3055, 3270-3301). Their error text is a serialized ClineError with an HTTP
// `status` (services/error/ClineError.ts:94-104): only that number is taken. Counted once per failure: every
// error_retry, plus each api_req_failed not right after a `failed: true` error_retry; classified 429 rate_limit,
// 529 overloaded, 5xx server, 401/403 auth, otherwise (or no status) other.
// SDK sessions keep no record of failed requests on disk, so they give no errors.
//
// No speed (tps_median / tps_n) from Cline: neither format records both ends of a request. Classic tasks keep an
// early START only: api_req_started is written as a placeholder before Cline gathers the environment details for
// the request (v3.89.2 core/task/index.ts:2620-2627, "can take a few seconds"), its ts is not changed when the
// tokens are filled in at the end, the old api_req_finished message is no longer written (index.ts:1201), and the
// next messages' ts are the first streamed chunk or come after tools ran. SDK sessions keep the END only: an assistant
// message's ts is createdAt, set when the streamed reply has been assembled (sdk/packages/agents/src/agent-runtime.ts:
// 361-373, 2066; core/src/runtime/config/agent-message-codec.ts:133); the request's own start time is kept in memory
// for telemetry (agent-runtime.ts:1685, 1777) and not saved, and the previous message's ts is earlier by hooks,
// compaction and request building.
import fs from "node:fs";
import path from "node:path";

import { isDict } from "../py.mjs";
import { Totals, monthOfMs, plainId, sellerName, statusKind, tokens } from "./opencode.mjs";

export const NAME = "cline";

const EXTENSION = "saoudrizwan.claude-dev";
const APPS = ["Code", "Code - Insiders", "Cursor", "VSCodium", "Windsurf"];
// Cline provider ids -> easiapiai seller names; any other id is sent as it is
const SELLERS = {
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  "openai-native": "OpenAI",
  gemini: "Google AI Studio",
};
// not attributable to a seller: generic OpenAI-compatible endpoints ("openai" classic, "openai-compatible" SDK),
// local models, VS Code's language-model API; "claude-code" and "openai-codex-cli" run the Claude Code / Codex CLIs,
// whose own logs the Claude Code and Codex readers count; "unknown" is the resumed-classic-task aggregate
const SKIP = new Set(["openai", "openai-compatible", "ollama", "lmstudio", "vscode-lm", "claude-code",
  "openai-codex-cli", "unknown"]);

// ------------------------------------------------------------------ where the files are

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function envDir(env, name) {
  const v = env[name];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// Cline's data dir: $CLINE_DATA_DIR, else ($CLINE_DIR or <home>/.cline)/data
export function dataDir(ctx) {
  const env = ctx.env || {};
  return envDir(env, "CLINE_DATA_DIR") || path.join(envDir(env, "CLINE_DIR") || path.join(ctx.home, ".cline"), "data");
}

// $CLINE_SESSION_DATA_DIR, else <data dir>/sessions
export function sessionsDir(ctx) {
  return envDir(ctx.env || {}, "CLINE_SESSION_DATA_DIR") || path.join(dataDir(ctx), "sessions");
}

// The folders holding classic tasks/ and state/: each editor's globalStorage/saoudrizwan.claude-dev, then Cline's
// data dir. User data: $VSCODE_APPDATA if set, else macOS ~/Library/Application Support, Windows %APPDATA%,
// elsewhere $XDG_CONFIG_HOME or ~/.config (as VS Code itself resolves it).
export function classicRoots(ctx) {
  const env = ctx.env || {};
  let appData = envDir(env, "VSCODE_APPDATA");
  if (!appData) {
    if (ctx.platform === "darwin") appData = path.join(ctx.home, "Library", "Application Support");
    else if (ctx.platform === "win32") appData = envDir(env, "APPDATA") || path.join(ctx.home, "AppData", "Roaming");
    else appData = envDir(env, "XDG_CONFIG_HOME") || path.join(ctx.home, ".config");
  }
  const roots = APPS.map((app) => path.join(appData, app, "User", "globalStorage", EXTENSION));
  roots.push(dataDir(ctx));
  return [...new Set(roots)];
}

// ------------------------------------------------------------------ attribution

// [provider, model] or null
function pair(provider, model) {
  return plainId(provider) && plainId(model) ? [provider.trim(), model] : null;
}

// task id -> [provider, model] from <root>/state/taskHistory.json (only id, apiProvider and modelId are kept)
function historyModels(root) {
  const out = new Map();
  const list = readJson(path.join(root, "state", "taskHistory.json"));
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (!isDict(item) || typeof item.id !== "string") continue;
    const p = pair(item.apiProvider, item.modelId);
    if (p) out.set(item.id, p);
  }
  return out;
}

// [[ts, provider, model]] sorted by time, from <task>/task_metadata.json model_usage (only those fields are kept)
function modelUsage(taskDir) {
  const meta = readJson(path.join(taskDir, "task_metadata.json"));
  const out = [];
  if (!isDict(meta) || !Array.isArray(meta.model_usage)) return out;
  for (const e of meta.model_usage) {
    if (!isDict(e) || typeof e.ts !== "number" || !Number.isFinite(e.ts)) continue;
    const p = pair(e.model_provider_id, e.model_id);
    if (p) out.push([e.ts, p[0], p[1]]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

// ------------------------------------------------------------------ counting

function sellerOf(provider) {
  if (SKIP.has(provider.toLowerCase())) return null;
  return sellerName(SELLERS, provider);
}

// the five usage numbers of an api_req_started / deleted_api_reqs / subagent_usage text; nothing else is kept
export function usageOf(text) {
  if (typeof text !== "string") return null;
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isDict(d)) return null;
  const u = {
    input: tokens(d.tokensIn) + tokens(d.cacheWrites),
    output: tokens(d.tokensOut),
    cached: typeof d.cacheReads === "number" ? tokens(d.cacheReads) : null,
    cost: typeof d.cost === "number" ? d.cost : null,
  };
  return u;
}

// the HTTP status inside a failed request's error text (a serialized ClineError), or null
export function statusOf(errorText) {
  if (typeof errorText !== "string") return null;
  let d;
  try {
    d = JSON.parse(errorText);
  } catch {
    return null;
  }
  return isDict(d) && typeof d.status === "number" ? d.status : null;
}

function errorRetryOf(text) {
  if (typeof text !== "string") return { failed: false, status: null };
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    return { failed: false, status: null };
  }
  if (!isDict(d)) return { failed: false, status: null };
  return { failed: d.failed === true, status: statusOf(d.errorMessage) };
}

const WANTED = ["api_req_started", "deleted_api_reqs", "subagent_usage", "error_retry", "api_req_failed"];

// one classic task folder
function readTask(totals, taskDir, history) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(taskDir, "ui_messages.json"), "utf8");
  } catch {
    return;
  }
  if (!WANTED.some((w) => raw.includes(w))) return;
  let messages;
  try {
    messages = JSON.parse(raw);
  } catch {
    return;
  }
  raw = null;
  if (!Array.isArray(messages)) return;
  let usage = null; // model_usage, read when first needed
  const fallback = history.get(path.basename(taskDir)) || null;
  const attribution = (m) => {
    const own = isDict(m.modelInfo) ? pair(m.modelInfo.providerId, m.modelInfo.modelId) : null;
    if (own) return own;
    if (usage === null) usage = modelUsage(taskDir);
    let best = null;
    for (const [ts, provider, model] of usage) {
      if (ts <= m.ts) best = [provider, model];
      else break;
    }
    return best || fallback;
  };
  let afterFailedRetry = false;
  for (const m of messages) {
    const prevFailed = afterFailedRetry;
    afterFailedRetry = false;
    if (!isDict(m)) continue;
    const kind = m.type === "say" ? m.say : m.type === "ask" ? m.ask : null;
    if (!WANTED.includes(kind)) continue;
    let u = null;
    let err = null;
    if (m.type === "say" && (kind === "api_req_started" || kind === "deleted_api_reqs" || kind === "subagent_usage")) {
      u = usageOf(m.text);
      if (!u || u.input + u.output + (u.cached || 0) === 0) continue;
    } else if (m.type === "say" && kind === "error_retry") {
      const r = errorRetryOf(m.text);
      afterFailedRetry = r.failed;
      err = statusKind(r.status);
    } else if (m.type === "ask" && kind === "api_req_failed") {
      if (prevFailed) continue; // the same failure as the error_retry just before it
      err = statusKind(statusOf(m.text));
    } else {
      continue;
    }
    const month = monthOfMs(m.ts);
    if (!totals.wants(month)) continue;
    const who = attribution(m);
    if (!who) continue;
    const seller = sellerOf(who[0]);
    if (!seller) continue;
    if (err) totals.addError(seller, who[1], month, err);
    else if (kind === "api_req_started") totals.addRequest(seller, who[1], month, u);
    else totals.addTokens(seller, who[1], month, u);
  }
}

// one SDK *.messages.json file
function readSession(totals, file) {
  const d = readJson(file);
  let messages;
  if (Array.isArray(d)) messages = d;
  else if (isDict(d)) {
    if (isDict(d.origin) && d.origin.mode === "import") return;
    messages = d.messages;
  }
  if (!Array.isArray(messages)) return;
  for (const m of messages) {
    if (!isDict(m) || m.role !== "assistant" || !isDict(m.metrics) || !isDict(m.modelInfo)) continue;
    const who = pair(m.modelInfo.provider, m.modelInfo.id);
    if (!who) continue;
    const seller = sellerOf(who[0]);
    if (!seller) continue;
    const month = monthOfMs(m.ts);
    if (!totals.wants(month)) continue;
    const x = m.metrics;
    const read = tokens(x.cacheReadTokens);
    const u = {
      input: Math.max(0, tokens(x.inputTokens) - read),
      output: tokens(x.outputTokens),
      cached: typeof x.cacheReadTokens === "number" ? read : null,
      cost: typeof x.cost === "number" ? x.cost : null,
    };
    if (u.input + u.output + read > 0) totals.addRequest(seller, who[1], month, u);
  }
}

// {name, found, rows, note}
export async function read(ctx) {
  const totals = new Totals(ctx.months);
  let found = false;
  const seenTasks = new Set();
  for (const root of classicRoots(ctx)) {
    const tasks = path.join(root, "tasks");
    if (!isDirectory(tasks)) continue;
    let history = null;
    for (const e of listDir(tasks).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (!e.isDirectory() || seenTasks.has(e.name)) continue;
      const dir = path.join(tasks, e.name);
      if (!fs.existsSync(path.join(dir, "ui_messages.json"))) continue;
      found = true;
      seenTasks.add(e.name);
      if (history === null) history = historyModels(root);
      readTask(totals, dir, history);
    }
  }
  const sessions = sessionsDir(ctx);
  for (const s of listDir(sessions).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!s.isDirectory()) continue;
    const dir = path.join(sessions, s.name);
    for (const f of listDir(dir)) {
      if (!f.isFile() || !f.name.endsWith(".messages.json")) continue;
      found = true;
      readSession(totals, path.join(dir, f.name));
    }
  }
  return { name: NAME, found, rows: totals.rows(), note: null };
}
