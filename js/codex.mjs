// Codex CLI token usage per model and month. EXPERIMENTAL.
//
// These rules come from the Codex source code (openai/codex) and the open-source ccusage; they have NOT yet been
// checked against real Codex log files. Reports that compare these totals with Codex's own numbers are welcome.
//
// - files: $CODEX_HOME (a comma-separated list is allowed) or ~/.codex; sessions/**/rollout-*.jsonl and
//   archived_sessions/**/rollout-*.jsonl. Compressed rollout-*.jsonl.zst copies are read on Node.js 22.15+ (which
//   ships zstd) and skipped, with a count, on older versions;
// - usage lines: type "event_msg" with payload.type "token_count"; payload.info.total_token_usage is cumulative per
//   session and the event repeats, so last_token_usage counts only when total_token_usage changed (if
//   last_token_usage is missing, the difference between the totals is used);
// - the same event found in two files (an archived copy, a forked session replaying its parent) counts once;
// - model: the latest turn_context line's payload.model before the event;
// - input_tokens includes cached_input_tokens, so input = input_tokens - cached_input_tokens (cache writes, which
//   OpenAI bills as ordinary input, stay in input); reasoning tokens are already part of output_tokens;
// - not counted: compaction requests recorded in separate token_usage_record lines.
import fs from "node:fs";

import { keyPart, sortedRows } from "./claude_code.mjs";
import { CAN_ZSTD, fileChunks, globTree, homeDir, joinPath, openFile, textLines, zstdChunks } from "./files.mjs";
import { monthOf } from "./isotime.mjs";
import { compareStr, get, isDict, strip } from "./py.mjs";

export const SELLER = "OpenAI";
const RAW = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens",
  "reasoning_output_tokens", "total_tokens"];

export function codexHomes(home = null, environ = null) {
  environ = environ ?? process.env;
  const env = environ.CODEX_HOME ?? "";
  if (strip(env)) return [...new Set(env.split(",").map(strip).filter((p) => p))];
  return [joinPath(home || homeDir(), ".codex")];
}

// fnmatch "rollout-*.jsonl" (and with ".zst"): a fixed start and end, anything between
function rolloutMatcher(suffix) {
  return (name) => name.length >= 8 + suffix.length && name.startsWith("rollout-") && name.endsWith(suffix);
}

function sorted(list) {
  return [...list].sort(compareStr);
}

// [files to read, number of .zst files skipped because this Node.js cannot read them]
export function rolloutFiles(homes, canZstd = CAN_ZSTD) {
  const files = [];
  let skipped = 0;
  for (const h of homes) {
    for (const sub of ["sessions", "archived_sessions"]) {
      const d = joinPath(h, sub);
      const plain = sorted(globTree(d, rolloutMatcher(".jsonl")));
      files.push(...plain);
      const have = new Set(plain);
      for (const p of sorted(globTree(d, rolloutMatcher(".jsonl.zst")))) {
        if (have.has(p.slice(0, -4))) continue; // the plain copy is read instead
        if (canZstd) files.push(p);
        else skipped += 1;
      }
    }
  }
  return [files, skipped];
}

// a whole token count: int(v) of a number, 0 for anything else; like Python, inf and nan fail (and end the file)
function usage(u) {
  if (!isDict(u)) return null;
  return RAW.map((f) => {
    const v = get(u, f);
    if (typeof v !== "number") return 0;
    if (!Number.isFinite(v)) throw new RangeError("cannot convert float infinity or NaN to integer");
    return Math.trunc(v);
  });
}

function same(a, b) {
  return b !== null && a.every((v, i) => v === b[i]);
}

// [timestamp, model, [input, cached, cache_write, output, reasoning, total], provider] for each token_count event
// that adds usage, in one rollout file. The provider is the session_meta line's model_provider (codex-rs protocol:
// "openai", "ollama", "lmstudio" or a configured provider's id), null when the file has none.
export function* events(lines) {
  let model = null;
  let provider = null;
  let prev = null;
  for (const line of lines) {
    if (!line.includes("token_count") && !line.includes("turn_context") && !line.includes("session_meta")) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const p = isDict(d) ? get(d, "payload") : null;
    if (!isDict(p)) continue;
    if (get(d, "type") === "turn_context") {
      const m = get(p, "model");
      if (typeof m === "string" && m) model = m;
      continue;
    }
    if (get(d, "type") === "session_meta") {
      const mp = get(p, "model_provider");
      if (typeof mp === "string" && mp) provider = mp;
      continue;
    }
    if (get(d, "type") !== "event_msg" || get(p, "type") !== "token_count" || !isDict(get(p, "info"))) continue;
    const info = get(p, "info");
    const tot = usage(get(info, "total_token_usage"));
    const last = usage(get(info, "last_token_usage"));
    let raw;
    if (last !== null && (tot === null || !same(tot, prev))) {
      raw = last;
    } else if (tot !== null) {
      raw = tot.map((a, i) => Math.max(a - (prev === null ? 0 : prev[i]), 0));
    } else {
      raw = null;
    }
    if (tot !== null) prev = tot;
    if (raw === null) continue;
    const [inp, cachedRaw, cw, out, reasoning, total] = raw;
    const cached = Math.min(cachedRaw, inp);
    if (!(inp || cached || cw || out || reasoning)) continue;
    yield [get(d, "timestamp"), model, [inp, cached, cw, out, reasoning, total], provider];
  }
}

// Map{key: [name, month, [input, output, cached, 0, 0]]} over every rollout file, plus files read and .zst files
// skipped. `group` names the group of an event (model and provider): bill groups by model, sharing by both.
export function tally(homes, group) {
  const [files, skipped] = rolloutFiles(homes);
  const seen = new Set();
  const totals = new Map();
  let read = 0;
  for (const path of files) {
    let fd;
    try {
      fd = openFile(path);
    } catch {
      continue;
    }
    read += 1;
    try {
      const chunks = path.endsWith(".zst") ? zstdChunks(fd) : fileChunks(fd);
      for (const [ts, model, u, provider] of events(textLines(chunks))) {
        const key = [ts, model, ...u].map(keyPart).join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        const [inp, cached, , out] = u;
        const name = group(model || "unknown", provider);
        const month = monthOf(ts);
        const tkey = keyPart(name) + "|" + keyPart(month);
        if (!totals.has(tkey)) totals.set(tkey, [name, month, [0, 0, 0, 0, 0]]);
        const t = totals.get(tkey)[2];
        t[0] += inp - cached;
        t[1] += out;
        t[2] += cached;
      }
    } catch {
      // a truncated or corrupt (compressed) file: keep what was read before the damage
    } finally {
      fs.closeSync(fd);
    }
  }
  return [totals, read, skipped];
}

// [rows like Claude Code's (cache_write_tokens and cache_write_1h_tokens are 0), files read, .zst files skipped]
export function monthlyTotals(homes = null) {
  const [totals, read, skipped] = tally(homes === null ? codexHomes() : homes, (model) => model);
  return [sortedRows(totals), read, skipped];
}
