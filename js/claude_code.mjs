// Claude Code token usage per model and month, from its own logs on this computer.
//
// Rules (the same as the Python client's, checked against 949 real log files and the open-source ccusage):
// - every *.jsonl under the projects folders, sub-agent folders included (they are not repeated in the parent);
// - only lines with type "assistant"; skip model "<synthetic>" (API-error lines with zero tokens);
// - one API response appears on several lines (one per content block): key (message.id, requestId) across all
//   files, keep the line with the largest token total (output grows from line to line);
// - input_tokens excludes cache reads and writes; thinking is part of output_tokens;
// - the month is the line's timestamp in your local time zone.
//
// Only the model name, timestamp, ids and token counts of each line are used. Nothing here reads or keeps message
// content beyond the line being parsed.
import fs from "node:fs";

import { fileChunks, globTree, homeDir, joinPath, openFile, textLines } from "./files.mjs";
import { monthOf } from "./isotime.mjs";
import { compareStr, get, has, isDict, strip, truthy } from "./py.mjs";

export const FIELDS = ["input_tokens", "output_tokens", "cached_input_tokens", "cache_write_tokens",
  "cache_write_1h_tokens"];
export const SELLER = "Anthropic";

// The folders Claude Code writes its logs to: ~/.claude/projects, ~/.config/claude/projects and
// <each entry of $CLAUDE_CONFIG_DIR>/projects (a comma-separated list).
export function projectDirs(home = null, environ = null) {
  home = home || homeDir();
  environ = environ ?? process.env;
  const roots = [joinPath(home, ".claude", "projects"), joinPath(home, ".config", "claude", "projects")];
  for (const p of (environ.CLAUDE_CONFIG_DIR ?? "").split(",")) {
    if (strip(p)) roots.push(joinPath(strip(p), "projects"));
  }
  return [...new Set(roots)];
}

// A token count: numbers as they are, anything else (missing, null, malformed) as 0
function n(v) {
  return typeof v === "number" ? v : 0;
}

// A key that is equal for two values exactly when Python's tuples of them are equal (True == 1, 1 == 1.0).
// Lists and objects cannot be dictionary keys in Python, so they fail here too.
export function keyPart(v) {
  if (v === null || v === undefined) return "z";
  if (typeof v === "boolean") return v ? "n1" : "n0";
  if (typeof v === "number") return "n" + String(v);
  if (typeof v === "string") return "s" + JSON.stringify(v);
  throw new TypeError(`unhashable type: '${Array.isArray(v) ? "list" : "dict"}'`);
}

function total(row) {
  let s = 0;
  for (const v of row) s += v;
  return s;
}

// API error lines (isApiErrorMessage) by their `error` field and HTTP status, as counted for usage sharing.
// Values seen in real logs: rate_limit (429 or no status), server_error (529, 500 or no status),
// authentication_failed, unknown (400).
export function errorKind(error, status) {
  if (error === "rate_limit") return "rate_limit";
  if (error === "server_error") return status === 529 ? "overloaded" : "server";
  if (error === "authentication_failed") return "auth";
  return "other";
}

// Map{key: [model, month, [input, output, cache_read, cache_write_5m, cache_write_1h]]}, one entry per API
// response, keeping its line with the largest token total; plus the number of files read.
// With `errors` (a Map), API error lines are added to it too: {line uuid: [model, month, kind]}, where the model is
// that of the latest earlier assistant line in the same file (an error line itself names no real model); error
// lines with no such line before them are left out.
export function readLines(dirs, errors = null) {
  const best = new Map();
  let files = 0;
  for (const root of dirs) {
    for (const path of globTree(root, (name) => name.endsWith(".jsonl"))) {
      let fd;
      try {
        fd = openFile(path);
      } catch {
        continue;
      }
      files += 1;
      let lastModel = null;
      try {
        for (const line of textLines(fileChunks(fd))) {
          if (!line.includes('"assistant"')) continue;
          let d;
          try {
            d = JSON.parse(line);
          } catch {
            continue;
          }
          if (!isDict(d)) continue;
          let m = get(d, "type") === "assistant" ? get(d, "message") : null;
          m = isDict(m) ? m : null;
          const u = m ? get(m, "usage") : null;
          const model = m ? get(m, "model") : null;
          if (errors !== null && m !== null) {
            if (get(d, "isApiErrorMessage") === true) {
              const uuid = get(d, "uuid");
              const key = typeof uuid === "string" && uuid ? "u" + uuid : keyPart(path) + "|" + keyPart(line);
              if (lastModel !== null && !errors.has(key)) {
                const month = has(d, "timestamp") ? monthOf(d.timestamp) : "unknown";
                errors.set(key, [lastModel, month, errorKind(get(d, "error"), get(d, "apiErrorStatus"))]);
              }
              continue;
            }
            if (typeof model === "string" && model && model !== "<synthetic>") lastModel = model;
          }
          if (!truthy(u) || !isDict(u) || !truthy(model) || typeof model !== "string" || model === "<synthetic>") {
            continue;
          }
          let cc = get(u, "cache_creation");
          cc = truthy(cc) && isDict(cc) ? cc : {};
          let w5 = get(cc, "ephemeral_5m_input_tokens");
          let w1 = get(cc, "ephemeral_1h_input_tokens");
          if (w5 === null && w1 === null) {
            // older logs have only the total: counted as 5-minute writes
            const legacy = get(u, "cache_creation_input_tokens");
            w5 = truthy(legacy) ? legacy : 0;
            w1 = 0;
          }
          const row = [n(get(u, "input_tokens")), n(get(u, "output_tokens")), n(get(u, "cache_read_input_tokens")),
            n(w5), n(w1)];
          const month = has(d, "timestamp") ? monthOf(d.timestamp) : "unknown";
          const id = get(m, "id");
          const key = truthy(id) ? keyPart(id) + "|" + keyPart(get(d, "requestId")) : keyPart(path) + "|" + keyPart(line);
          const seen = best.get(key);
          if (seen === undefined || total(row) > total(seen[2])) best.set(key, [model, month, row]);
        }
      } finally {
        fs.closeSync(fd);
      }
    }
  }
  return [best, files];
}

// Rows of {model, label (YYYY-MM), input_tokens, output_tokens, cached_input_tokens, cache_write_tokens,
// cache_write_1h_tokens} sorted by model and month, from rows of totals keyed by model and month
export function sortedRows(totals) {
  const rows = [...totals.values()].map(([model, month, t]) => {
    const r = { model, label: month };
    FIELDS.forEach((f, i) => {
      r[f] = t[i];
    });
    return r;
  });
  return rows.sort((a, b) => compareStr(a.model, b.model) || compareStr(a.label, b.label));
}

// [rows sorted by model and month, number of files read]
export function monthlyTotals(dirs = null) {
  const [best, files] = readLines(dirs === null ? projectDirs() : dirs);
  const totals = new Map();
  for (const [model, month, row] of best.values()) {
    const key = keyPart(model) + "|" + keyPart(month);
    if (!totals.has(key)) totals.set(key, [model, month, [0, 0, 0, 0, 0]]);
    const t = totals.get(key)[2];
    row.forEach((v, i) => {
      t[i] += v;
    });
  }
  return [sortedRows(totals), files];
}
