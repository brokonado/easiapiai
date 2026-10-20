// Claude Code: tokens per model and month by the same rules as `easiapiai bill`, plus requests (the replies counted)
// and API errors (lines marked isApiErrorMessage, counted for the model in use just before them).
//
// Seller: models named claude-* are sold by Anthropic. Claude Code can also be pointed at another seller's
// Anthropic-compatible endpoint (GLM, Kimi, DeepSeek...) with ANTHROPIC_BASE_URL: other models are then credited to
// that URL's host. Without it, rows for other models are left out (their seller is unknown).
import { projectDirs, readLines } from "../claude_code.mjs";
import { urlsplit } from "../py.mjs";

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
  const [best, files] = readLines(projectDirs(ctx.home, ctx.env), errors);
  if (!files) return { name: NAME, found: false, rows: [], note: null };
  const host = baseHost(ctx.env);
  const groups = new Map();
  const group = (model, month) => {
    const key = JSON.stringify([model, month]);
    if (!groups.has(key)) {
      groups.set(key, { model, month, input: 0, output: 0, cached: 0, requests: 0, errors: {} });
    }
    return groups.get(key);
  };
  for (const [model, month, row] of best.values()) {
    const g = group(model, month);
    g.input += row[0] + row[3] + row[4]; // uncached input + cache writes (5m, 1h): see readers/index.mjs
    g.output += row[1];
    g.cached += row[2];
    g.requests += 1;
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
    rows.push(row);
  }
  const note = unknownSeller ? `${unknownSeller} rows for models not sold by Anthropic left out (their seller is `
    + "unknown; set ANTHROPIC_BASE_URL as Claude Code uses it to include them)" : null;
  return { name: NAME, found: true, rows, note };
}

