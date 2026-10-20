// Claude Code: tokens per model and month by the same rules as `easiapiai bill`, plus requests (the replies counted)
// and API errors (lines marked isApiErrorMessage, counted for the model in use just before them).
//
// Seller: models named claude-* are sold by Anthropic. Claude Code can also be pointed at another seller's
// Anthropic-compatible endpoint (GLM, Kimi, DeepSeek...) with ANTHROPIC_BASE_URL: other models are then credited to
// that URL's host. Without it, rows for other models are left out (their seller is unknown).
//
// Speed (tps_median, tps_n; rules in speed.mjs): per reply, its output tokens over the time from the line that
// triggered the request (the prompt or tool results it answers, or the attachment lines Claude Code adds just
// before sending) to the reply's last line (see readLines in ../claude_code.mjs). Checked with this code on 964 real
// log files (2026-10-20, 51,701 replies of 50+ output tokens, 10 Claude models): per model, medians of 44-128 tokens
// per second (p10 25-79, p90 54-159), at most 0.2% of replies below 5 and at most 2% above 500. A request Claude
// Code retried after an API error counts its waiting too.
import { projectDirs, readLines } from "../claude_code.mjs";
import { urlsplit } from "../py.mjs";
import { replyTps, summarize } from "./speed.mjs";

export const NAME = "Claude Code";

function baseHost(env) {
  if (!env.ANTHROPIC_BASE_URL) return null;
  try {
    return urlsplit(env.ANTHROPIC_BASE_URL).hostname;
  } catch {
    return null;
  }
}

export async function read(ctx) {
  const errors = new Map();
  const timing = new Map();
  const [best, files] = readLines(projectDirs(ctx.home, ctx.env), errors, timing);
  if (!files) return { name: NAME, found: false, rows: [], note: null };
  const host = baseHost(ctx.env);
  const groups = new Map();
  const group = (model, month) => {
    const key = JSON.stringify([model, month]);
    if (!groups.has(key)) {
      groups.set(key, { model, month, input: 0, output: 0, cached: 0, requests: 0, errors: {}, speeds: [] });
    }
    return groups.get(key);
  };
  for (const [key, [model, month, row]] of best) {
    const g = group(model, month);
    g.input += row[0] + row[3] + row[4]; // uncached input + cache writes (5m, 1h): see readers/index.mjs
    g.output += row[1];
    g.cached += row[2];
    g.requests += 1;
    const t = timing.get(key);
    const tps = t ? replyTps(t[2], (t[1] - t[0]) / 1000) : null;
    if (tps !== null) g.speeds.push(tps);
  }
  for (const [model, month, kind] of errors.values()) {
    const g = group(model, month);
    g.errors[kind] = (g.errors[kind] || 0) + 1;
  }
  const rows = [];
  let unknownSeller = 0;
  for (const g of groups.values()) {
    if (!ctx.months.includes(g.month)) continue;
    const seller = g.model.startsWith("claude-") ? "Anthropic" : host;
    if (!seller) {
      unknownSeller += 1;
      continue;
    }
    const row = { seller, model: g.model, month: g.month, input_tokens: Math.round(g.input),
      output_tokens: Math.round(g.output), cached_input_tokens: Math.round(g.cached), requests: g.requests };
    if (Object.keys(g.errors).length) row.errors = g.errors;
    const speed = summarize(g.speeds);
    if (speed) Object.assign(row, speed);
    rows.push(row);
  }
  const note = unknownSeller ? `${unknownSeller} rows for models not sold by Anthropic left out (their seller is `
    + "unknown; set ANTHROPIC_BASE_URL as Claude Code uses it to include them)" : null;
  return { name: NAME, found: true, rows, note };
}
