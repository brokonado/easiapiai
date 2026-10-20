// Every local source of usage numbers that `easiapiai share` (and the plugin's weekly send) reads.
//
// ONE MEANING FOR EVERY SOURCE (sharing only; `easiapiai bill` keeps its own rules):
//   input_tokens        = every input token that was NOT read from a cache: uncached input + cache writes
//   cached_input_tokens = cache reads only
//   output_tokens       = output, reasoning included
// e.g. Claude Code: input_tokens + cache writes (5m + 1h), cached = cache reads; OpenRouter: prompt_tokens -
// cached_tokens (at least 0), cached = cached_tokens; Codex: input_tokens - cached_input_tokens (its
// cache_write_input_tokens are already part of input_tokens, so they are not added again).
//
// The reader interface: each module exports `async function read(ctx)` returning {name, found, rows, note}.
//   ctx   = {home, env, platform, now (a Date), months (["YYYY-MM", ...]: only these months are wanted)}
//   name  = the source as shown to the user ("Claude Code")
//   found = whether the source exists on this computer
//   rows  = [{seller, served_by?, model, month, input_tokens, output_tokens, cached_input_tokens?, requests?,
//             errors? {rate_limit, overloaded, server, auth, other}, cost_usd?, source? ("logs" when missing),
//             tps_median?, tps_n? (speed: both or neither, see speed.mjs)}]
//   note  = one short line for the user, or null
// A reader reads only numbers, model and provider names and timestamps: never prompts, replies, code or file names,
// and never keeps file contents. It skips silently when its source is absent.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { compareStr, isDict } from "../py.mjs";
import * as claudeCode from "./claude_code.mjs";
import * as codex from "./codex.mjs";
import * as openrouter from "./openrouter.mjs";
import { combine, validSpeed } from "./speed.mjs";

const ERRORS = ["rate_limit", "overloaded", "server", "auth", "other"];
const SOURCES = new Set(["logs", "usage_api", "export", "manual"]);

// Readers written separately (opencode, Cline): used when present; a missing file is skipped silently, one that
// fails to load is shown as a note instead of stopping the others.
async function optional(name) {
  const url = new URL(`./${name}.mjs`, import.meta.url);
  if (!fs.existsSync(fileURLToPath(url))) return null;
  try {
    return await import(url.href);
  } catch (err) {
    return { read: async () => ({ name, found: false, rows: [], note: `not read: ${err && err.message}` }) };
  }
}

// In the order they are shown
export const READERS = [claudeCode, codex, await optional("opencode"), await optional("cline"), openrouter]
  .filter((r) => r !== null && typeof r.read === "function");

// "YYYY-MM" of the current month (local time) and the n - 1 months before it
export function lastMonths(n, now = new Date()) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

function count(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

// what the server would refuse outright (the whole request, not just the row): a long text, or anything like a key
function plainName(v) {
  return typeof v === "string" && v.trim() !== "" && v.length <= 200 && !/^\s*["']?sk-/i.test(v)
    && !/(?:^|[\s:="'])sk-[A-Za-z0-9_-]{6,}/i.test(v);
}

// A row as it is sent, or null when it cannot be sent
function clean(row, months) {
  if (!isDict(row) || !plainName(row.seller) || !plainName(row.model) || !months.includes(row.month)) return null;
  const out = { seller: row.seller.trim(), model: row.model.trim(), month: row.month };
  if (plainName(row.served_by)) out.served_by = row.served_by.trim();
  out.input_tokens = count(row.input_tokens);
  out.output_tokens = count(row.output_tokens);
  out.cached_input_tokens = count(row.cached_input_tokens);
  out.requests = count(row.requests);
  const errors = {};
  if (isDict(row.errors)) for (const e of ERRORS) if (count(row.errors[e])) errors[e] = count(row.errors[e]);
  if (Object.keys(errors).length) out.errors = errors;
  out.source = SOURCES.has(row.source) ? row.source : "logs";
  // cost only from a usage report (what the seller billed); coding tools' logs hold their own estimate from list
  // prices, which would make easiapiai's "what people really pay" just repeat the list price
  if (out.source === "usage_api" && typeof row.cost_usd === "number" && Number.isFinite(row.cost_usd) && row.cost_usd >= 0) {
    out.cost_usd = row.cost_usd;
  }
  // speed only as a valid pair (0 < tps_median <= 5000, 1 <= tps_n <= 10^9); otherwise neither is sent
  if (validSpeed(row.tps_median, row.tps_n)) {
    out.tps_median = row.tps_median;
    out.tps_n = row.tps_n;
  }
  if (!out.input_tokens && !out.output_tokens && !out.requests && !out.errors) return null;
  return out;
}

// Two rows for the same seller, provider, model and month (two tools using the same seller) become one: easiapiai
// keeps one row per seller, model and month for each person, so sending both would count only one of them.
function add(a, b) {
  for (const f of ["input_tokens", "output_tokens", "cached_input_tokens", "requests"]) a[f] += b[f];
  if (b.errors) {
    a.errors = a.errors || {};
    for (const [e, n] of Object.entries(b.errors)) a.errors[e] = (a.errors[e] || 0) + n;
  }
  a.cost_usd = a.cost_usd !== undefined && b.cost_usd !== undefined ? a.cost_usd + b.cost_usd : undefined;
  if (a.cost_usd === undefined) delete a.cost_usd;
  if (a.source !== b.source) a.source = "logs";
  // speed: the two medians averaged, weighted by their reply counts (an approximation of the median of all the
  // replies, which are no longer at hand: see speed.mjs combine), and the counts added
  const speed = combine(a, b);
  delete a.tps_median;
  delete a.tps_n;
  if (speed) Object.assign(a, speed);
  return a;
}

// Runs the readers -> {sources: [{name, found, rows (count), note}], rows}. Rows are cleaned, merged and sorted.
export async function collect(ctx, readers = READERS) {
  const sources = [];
  const all = [];
  for (const reader of readers) {
    let res;
    try {
      res = await reader.read(ctx);
    } catch (err) {
      res = { name: reader.NAME || "a source", found: false, rows: [], note: `could not be read (${err && err.message})` };
    }
    const rows = (Array.isArray(res.rows) ? res.rows : []).map((r) => clean(r, ctx.months)).filter((r) => r);
    sources.push({ name: res.name, found: Boolean(res.found), rows: rows.length, note: res.note || null });
    all.push(...rows);
  }
  // OpenRouter's own activity report already holds every tool's OpenRouter usage: for a model and month it covers,
  // a tool's local count of the same usage would be counted twice
  const reported = new Set(all.filter((r) => r.seller === "OpenRouter" && r.source === "usage_api")
    .map((r) => r.model + "|" + r.month));
  const merged = new Map();
  for (const r of all) {
    if (r.source !== "usage_api" && /^openrouter(\.ai)?$/i.test(r.seller) && reported.has(r.model + "|" + r.month)) {
      continue;
    }
    const key = JSON.stringify([r.seller, r.served_by ?? null, r.model, r.month]);
    if (merged.has(key)) add(merged.get(key), r);
    else merged.set(key, { ...r, errors: r.errors ? { ...r.errors } : undefined });
  }
  const rows = [...merged.values()].map((r) => {
    if (!r.errors) delete r.errors;
    return r;
  });
  rows.sort((a, b) => compareStr(a.seller, b.seller) || compareStr(a.served_by ?? "", b.served_by ?? "")
    || compareStr(a.model, b.model) || compareStr(a.month, b.month));
  return { sources, rows };
}
