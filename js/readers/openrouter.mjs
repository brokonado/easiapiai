// OpenRouter: the account's activity report, read only when OPENROUTER_MANAGEMENT_KEY is set. The key is sent only
// to openrouter.ai (as an Authorization header, never on a redirect) and is never printed or sent to easiapiai.
//
// GET https://openrouter.ai/api/v1/activity: one item per day, model and serving endpoint for the last 30 completed
// UTC days: {date, model, provider_name, prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens,
// requests, usage (USD of OpenRouter credits), ...} (OpenRouter API reference, "Get user activity grouped by
// endpoint"). Rows: seller OpenRouter, served_by the provider, per model and month.
//
// A month is sent only while the 30-day window still starts on or before its first day: easiapiai keeps the latest
// numbers sent for a month, so a later, partly covered copy of the same month must never replace a fuller one.
import { HTTPError, URLError, ValueError, open, readBody } from "../http.mjs";
import { loads } from "../api.mjs";
import { get, isDict } from "../py.mjs";
import { CLIENT } from "../version.mjs";

export const NAME = "OpenRouter";
export const SOURCE = "usage_api";
const BASE = "https://openrouter.ai/api/v1";
const DAY = 86400000;

function whole(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

// a provider name as easiapiai's served_by takes it: letters, digits, space, ".", "_", "-"; at most 60
function providerName(v) {
  return typeof v === "string" ? v.replace(/[^A-Za-z0-9 ._-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) : "";
}

// ctx.openrouterBase replaces the address only in tests (a local mock); the command line never sets it
export async function read(ctx) {
  const key = (ctx.env.OPENROUTER_MANAGEMENT_KEY || "").trim();
  if (!key) return { name: NAME, found: false, rows: [], note: "not used (set OPENROUTER_MANAGEMENT_KEY to include it)" };
  let data;
  try {
    const res = await open("GET", (ctx.openrouterBase || BASE) + "/activity", {
      headers: { Authorization: "Bearer " + key, Accept: "application/json", "User-Agent": CLIENT },
      timeout: ctx.timeout ?? 30,
      redirects: false,
    });
    data = loads(await readBody(res));
  } catch (err) {
    if (err instanceof HTTPError) {
      return { name: NAME, found: false, rows: [], note: `could not read the activity report (HTTP ${err.status})` };
    }
    if (err instanceof URLError || err instanceof ValueError) {
      return { name: NAME, found: false, rows: [], note: "could not reach openrouter.ai" };
    }
    throw err;
  }
  const items = isDict(data) && Array.isArray(get(data, "data")) ? data.data : null;
  if (items === null) return { name: NAME, found: false, rows: [], note: "unexpected answer from openrouter.ai" };

  const now = ctx.now instanceof Date ? ctx.now : new Date(ctx.now ?? Date.now());
  const today = Math.floor(now.getTime() / DAY) * DAY;
  const windowStart = new Date(today - 30 * DAY).toISOString().slice(0, 10);
  const groups = new Map();
  for (const it of items) {
    if (!isDict(it) || typeof it.date !== "string" || typeof it.model !== "string" || !it.model) continue;
    const month = it.date.slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month) || !ctx.months.includes(month) || windowStart > month + "-01") continue;
    const servedBy = providerName(it.provider_name);
    const k = JSON.stringify([servedBy, it.model, month]);
    if (!groups.has(k)) {
      groups.set(k, { seller: "OpenRouter", served_by: servedBy, model: it.model, month, input_tokens: 0,
        output_tokens: 0, cached_input_tokens: 0, requests: 0, cost_usd: 0, source: SOURCE });
    }
    const g = groups.get(k);
    // prompt_tokens include the cache reads: input is what was not read from a cache (see readers/index.mjs)
    g.input_tokens += Math.max(whole(it.prompt_tokens) - whole(it.cached_tokens), 0);
    g.output_tokens += whole(it.completion_tokens);
    g.cached_input_tokens += whole(it.cached_tokens);
    g.requests += whole(it.requests);
    if (typeof it.usage === "number" && Number.isFinite(it.usage) && it.usage > 0) g.cost_usd += it.usage;
  }
  const rows = [...groups.values()].map((g) => {
    const row = { ...g, cost_usd: Math.round(g.cost_usd * 1e6) / 1e6 };
    if (!row.served_by) delete row.served_by;
    return row;
  });
  return { name: NAME, found: true, rows, note: null };
}
