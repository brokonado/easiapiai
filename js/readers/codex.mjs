// Codex CLI: tokens per model and month by the same rules as `easiapiai bill --codex` (EXPERIMENTAL there too).
// Seller: the session's model_provider (codex-rs protocol): "openai" is OpenAI, any other provider id is sent as it
// is (easiapiai matches it by name), local runtimes are left out. Rollouts without a provider: OpenAI for its own
// model names (gpt-, o1, o3, o4, codex-), others left out. No requests or errors for Codex yet.
// Input is input_tokens - cached_input_tokens, as for bill: Codex's cache_write_input_tokens come from the Responses
// API's input_tokens_details, a part of input_tokens, so cache writes are already in it (see readers/index.mjs).
import { codexHomes, tally } from "../codex.mjs";

export const NAME = "Codex";
const LOCAL = new Set(["ollama", "lmstudio", "llama.cpp", "oss"]);

export function sellerOf(provider, model) {
  if (provider) {
    const id = provider.toLowerCase();
    if (LOCAL.has(id)) return null;
    return id === "openai" ? "OpenAI" : provider;
  }
  return /^(gpt-|o1|o3|o4|codex-)/.test(model) ? "OpenAI" : null;
}

export async function read(ctx) {
  const [totals, files, skipped] = tally(codexHomes(ctx.home, ctx.env),
    (model, provider) => JSON.stringify([provider, model]));
  if (!files && !skipped) return { name: NAME, found: false, rows: [], note: null };
  const rows = [];
  for (const [key, month, t] of totals.values()) {
    const [provider, model] = JSON.parse(key);
    const seller = model === "unknown" ? null : sellerOf(provider, model);
    if (!seller || !ctx.months.includes(month)) continue;
    rows.push({ seller, model, month, input_tokens: t[0], output_tokens: t[1], cached_input_tokens: t[2] });
  }
  const note = skipped ? `${skipped} compressed rollout files skipped (reading them needs Node.js 22.15+)` : null;
  return { name: NAME, found: true, rows, note };
}
