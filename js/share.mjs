// `easiapiai share`, `easiapiai sharing on|off|status`, and the two hooks of the Claude Code plugin
// (`hook session-start`, `hook send`). What is sent: per seller, model and month, token, request and error counts,
// and the median speed (output tokens per second) where the source records it. Never prompts, replies, code, file
// names, project names or keys.
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import * as api from "./api.mjs";
import { configDir, contributorId, loadSharing, saveSharing } from "./config.mjs";
import { homeDir, joinPath } from "./files.mjs";
import { formatInt, ljust, pyLen, rjust, urlsplit } from "./py.mjs";
import { collect, lastMonths } from "./readers/index.mjs";
import { CLIENT } from "./version.mjs";

export const MAX_ROWS = 50; // rows per request, as the server takes them
const WEEK = 7 * 86400000;
const ASK_EVERY = 3 * 86400000;
const ASK_TIMES = 3;

const QUESTION = "easiapiai plugin: the user has not decided about usage reporting yet. Ask them once, briefly, at the "
  + "start of your first reply (or at the end if they asked for urgent work): \"easiapiai shows how LLM API sellers "
  + "actually perform: speed, failed requests and real cost, from people's own usage. It can add yours "
  + "automatically, about once a week: token, error and speed numbers per seller and month, never your key, prompts "
  + "or code. Add yours automatically? (yes/no)\". If they say yes, "
  + "run `<CMD> sharing on`; if no, run `<CMD> sharing off`. Then do not mention it again.";

function print(s = "") {
  process.stdout.write(s + "\n");
}

// The command that runs this copy of easiapiai: node and the absolute path of this script
export function selfCommand() {
  return `node "${path.join(path.dirname(fileURLToPath(import.meta.url)), "easiapiai.mjs")}"`;
}

function context(months, now = new Date()) {
  return { home: homeDir(), env: process.env, platform: process.platform, now, months };
}

// The request bodies for the rows, at most 50 rows each
export function bodies(rows, client) {
  const contributor = contributorId();
  const out = [];
  for (let i = 0; i < rows.length; i += MAX_ROWS) {
    out.push({ rows: rows.slice(i, i + MAX_ROWS), source: "logs", contributor, client });
  }
  return out;
}

function errorCount(r) {
  return r.errors ? Object.values(r.errors).reduce((a, b) => a + b, 0) : 0;
}

function printSources(sources) {
  print("Sources on this computer:");
  const width = Math.max(...sources.map((s) => pyLen(s.name)));
  for (const s of sources) {
    const what = s.found ? `${s.rows} row${s.rows === 1 ? "" : "s"}${s.note ? ` (${s.note})` : ""}`
      : s.note || "not found";
    print(`  ${ljust(s.name, width)}  ${what}`);
  }
}

function hasSpeed(rows) {
  return rows.some((r) => typeof r.tps_median === "number");
}

// The rows as a table; the tok/s column (median output tokens per second) only when some row has it. The total line
// leaves it empty: a median across different sellers and models means nothing.
export function printTable(rows) {
  const total = { seller: "Total", model: "", month: "", input_tokens: 0, output_tokens: 0, cached_input_tokens: 0,
    requests: 0, errors: {} };
  for (const r of rows) {
    for (const f of ["input_tokens", "output_tokens", "cached_input_tokens", "requests"]) total[f] += r[f];
    total.errors.all = (total.errors.all || 0) + errorCount(r);
  }
  const served = rows.some((r) => r.served_by);
  const speed = hasSpeed(rows);
  const head = ["Seller", ...(served ? ["Served by"] : []), "Model", "Month", "Input", "Output", "Cached", "Requests",
    "Errors", ...(speed ? ["tok/s"] : [])];
  const line = (r) => [r.seller, ...(served ? [r.served_by ?? ""] : []), r.model, r.month, formatInt(r.input_tokens),
    formatInt(r.output_tokens), formatInt(r.cached_input_tokens), formatInt(r.requests), formatInt(errorCount(r)),
    ...(speed ? [typeof r.tps_median === "number" ? r.tps_median.toFixed(1) : ""] : [])];
  const cells = [head, ...rows.map(line), line(total)];
  const left = served ? 4 : 3;
  const widths = head.map((_, i) => Math.max(...cells.map((c) => pyLen(c[i]))));
  cells.forEach((c, n) => {
    if (n === cells.length - 1) print("  " + widths.map((w) => "-".repeat(w)).join("  "));
    print("  " + c.map((v, i) => (i < left ? ljust(v, widths[i]) : rjust(v, widths[i]))).join("  ").trimEnd());
  });
}

// Sends the rows; -> {saved, unmatched: [{row, why, suggestions}], failed: message or null, thanks}
export async function send(rows, apiBase, client, timeout) {
  const endpoint = api.url(apiBase, "/api/usage/share");
  const out = { saved: 0, unmatched: [], failed: null, thanks: null };
  const list = bodies(rows, client);
  for (let i = 0; i < list.length; i++) {
    try {
      const res = await api.call("POST", endpoint, list[i], timeout);
      out.saved += Number.isInteger(res.saved) ? res.saved : 0;
      for (const u of Array.isArray(res.unmatched) ? res.unmatched : []) {
        out.unmatched.push({ ...u, row: Number.isInteger(u.row) ? u.row + i * MAX_ROWS : null });
      }
      if (typeof res.thanks === "string") out.thanks = res.thanks;
    } catch (err) {
      if (!(err instanceof api.ApiError)) throw err;
      out.failed = err.message;
      break;
    }
  }
  return out;
}

function printResult(result, rows) {
  if (result.failed) process.stderr.write(`easiapiai share: sending failed: ${result.failed}\n`);
  print(`Saved ${result.saved} of ${rows.length} rows.`);
  if (result.unmatched.length) {
    print("Not saved (easiapiai does not know the name; fix it and share again):");
    for (const u of result.unmatched) {
      const r = rows[u.row];
      const what = r ? `${r.seller}${r.served_by ? ` (${r.served_by})` : ""} / ${r.model} / ${r.month}` : `row ${u.row}`;
      const sug = Array.isArray(u.suggestions) && u.suggestions.length ? `; did you mean ${u.suggestions.join(", ")}?` : "";
      print(`  ${what}: ${u.why}${sug}`);
    }
  }
  if (result.thanks && !result.failed) print(result.thanks);
}

function hostOf(apiBase) {
  try {
    return urlsplit(apiBase).hostname || apiBase;
  } catch {
    return apiBase;
  }
}

// [Y/n] on the terminal; Enter means yes
function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.on("SIGINT", () => {
      rl.close();
      process.stderr.write("\ninterrupted\n");
      process.exit(130);
    });
    rl.on("close", () => {
      if (!answered) resolve(false);
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(/^(y|yes)?$/i.test(answer.trim()));
    });
  });
}

export async function cmdShare(args) {
  const { sources, rows } = await collect(context(lastMonths(13)));
  if (args.json) {
    for (const s of sources) if (s.note) process.stderr.write(`note: ${s.name}: ${s.note}\n`);
    print(JSON.stringify(rows.length ? bodies(rows, CLIENT) : [], null, 1));
    return rows.length ? 0 : 1;
  }
  printSources(sources);
  if (!rows.length) {
    print("Nothing to share: no usage found for the last 13 months.");
    return 1;
  }
  print();
  print("Usage to share, per seller, model and month (numbers only; errors are failed API requests):");
  printTable(rows);
  if (hasSpeed(rows)) {
    print("tok/s: the median output tokens per second of a reply, from the request to its last token.");
  }
  print();
  if (args.dry_run) {
    print("Dry run: nothing was sent.");
    return 0;
  }
  const host = hostOf(args.api);
  if (!args.yes) {
    if (!process.stdin.isTTY) {
      print(`Nothing was sent. To send these numbers to ${host}, run again with --yes (--json shows the exact `
        + "request).");
      return 0;
    }
    if (!(await confirm(`Send these numbers to ${host}? [Y/n] `))) {
      print("Nothing was sent.");
      return 0;
    }
  }
  const result = await send(rows, args.api, CLIENT, 60);
  printResult(result, rows);
  return result.failed ? 1 : 0;
}

export async function cmdSharing(args) {
  const state = loadSharing();
  const cmd = selfCommand();
  if (args.sharing_action === "status") {
    const setting = state.auto === true ? "on" : state.auto === false ? "off" : "not decided yet";
    print(`Automatic reporting: ${setting}${state.decided_at ? ` (since ${state.decided_at})` : ""}.`);
    print(`Last sent: ${state.last_sent ?? "never"}.`);
    print(`Setting kept in ${joinPath(configDir(), "sharing.json")}`);
    return 0;
  }
  state.auto = args.sharing_action === "on";
  state.decided_at = new Date().toISOString();
  saveSharing(state);
  if (!state.auto) {
    print(`Automatic reporting is off: nothing will be sent. Turn it on any time with: ${cmd} sharing on`);
    return 0;
  }
  print("Automatic reporting is on: while the easiapiai Claude Code plugin is installed, it sends your usage numbers "
    + "about once a week (providers, models, token, request and error counts, speed; never prompts, code, file names "
    + `or keys). Stop any time with: ${cmd} sharing off`);
  if (args.no_send) return 0;
  const { rows } = await collect(context(lastMonths(13)));
  if (!rows.length) {
    print("Nothing to send yet: no usage found on this computer.");
    return 0;
  }
  const result = await send(rows, args.api, CLIENT, 60);
  if (result.failed) {
    print(`Could not send now (${result.failed}); the plugin tries again at a later session.`);
    return 0;
  }
  const fresh = loadSharing();
  fresh.last_sent = new Date().toISOString();
  saveSharing(fresh);
  const unmatched = new Set(result.unmatched.map((u) => u.row)).size;
  print(`Sent now: ${result.saved} of ${rows.length} rows saved`
    + (unmatched ? `; ${unmatched} not matched (see them with: ${cmd} share --dry-run, then ${cmd} share)` : "") + ".");
  return 0;
}

// The plugin's SessionStart hook: no network, nothing on stdout but the question, never fails the session
export function hookSessionStart() {
  try {
    const state = loadSharing();
    if (state.auto !== null || state.asked >= ASK_TIMES) return 0;
    const now = Date.now();
    if (state.asked_at && now - Date.parse(state.asked_at) < ASK_EVERY) return 0;
    // recorded before printing: if it cannot be recorded, better not to ask at every start
    state.asked += 1;
    state.asked_at = new Date(now).toISOString();
    saveSharing(state);
    print(QUESTION.replaceAll("<CMD>", selfCommand()));
  } catch {
    // a broken setting must never get in the way of a session
  }
  return 0;
}

// The plugin's background SessionStart hook: once a week when the user agreed; silent, never fails
export async function hookSend(args) {
  const debug = process.env.EASIAPIAI_DEBUG === "1";
  try {
    const state = loadSharing();
    if (state.auto !== true) return 0;
    const now = new Date();
    if (state.last_sent && now.getTime() - Date.parse(state.last_sent) < WEEK) return 0;
    const { rows } = await collect(context(lastMonths(2, now), now));
    if (rows.length) {
      const result = await send(rows, args.api, CLIENT + " auto", 10);
      if (result.failed) {
        if (debug) process.stderr.write(`easiapiai hook send: ${result.failed}\n`);
        return 0;
      }
    }
    const fresh = loadSharing();
    fresh.last_sent = new Date().toISOString();
    saveSharing(fresh);
  } catch (err) {
    if (debug) process.stderr.write(`easiapiai hook send: ${err && err.message}\n`);
  }
  return 0;
}
