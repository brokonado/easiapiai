// Speed: output tokens per second of each reply, end to end (output tokens / (reply finished - request sent)), so
// it includes the time to the first token. A row carries `tps_median` (the median over its replies, 1 decimal) and
// `tps_n` (how many replies), both or neither. Only replies with at least 50 output tokens and at least 0.5 s count,
// and a reply above 5000 tokens per second is dropped as a broken timestamp.
//
// Which sources measure it: Claude Code and opencode/Kilo (see their readers). Not measured: Cline (its files keep
// either the start of a request or its end, never both: see readers/cline.mjs), Codex and the OpenRouter report.

export const MIN_OUTPUT = 50;
export const MIN_SECONDS = 0.5;
export const MAX_TPS = 5000;
const MAX_N = 1e9;

// tokens per second of one reply, or null when it does not count
export function replyTps(outputTokens, seconds) {
  if (typeof outputTokens !== "number" || !Number.isFinite(outputTokens) || outputTokens < MIN_OUTPUT) return null;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < MIN_SECONDS) return null;
  const tps = outputTokens / seconds;
  return tps <= MAX_TPS ? tps : null;
}

export function median(values) {
  const a = [...values].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// whether a row's two fields are fit to send
export function validSpeed(tpsMedian, tpsN) {
  return typeof tpsMedian === "number" && Number.isFinite(tpsMedian) && tpsMedian > 0 && tpsMedian <= MAX_TPS
    && Number.isInteger(tpsN) && tpsN >= 1 && tpsN <= MAX_N;
}

// {tps_median, tps_n} for the speeds of a row's replies, or null when there are none
export function summarize(values) {
  if (!values.length) return null;
  const out = { tps_median: Math.round(median(values) * 10) / 10, tps_n: values.length };
  return validSpeed(out.tps_median, out.tps_n) ? out : null;
}

// Two rows' speeds as one (two tools using the same seller and model): the mean of the two medians weighted by
// their reply counts. This approximates the median of all the replies together (the replies themselves are gone by
// now); it is exact when both have the same median. -> {tps_median, tps_n} or null
export function combine(a, b) {
  const okA = a && validSpeed(a.tps_median, a.tps_n);
  const okB = b && validSpeed(b.tps_median, b.tps_n);
  if (!okA && !okB) return null;
  if (!okB) return { tps_median: a.tps_median, tps_n: a.tps_n };
  if (!okA) return { tps_median: b.tps_median, tps_n: b.tps_n };
  const n = a.tps_n + b.tps_n;
  const out = { tps_median: Math.round(((a.tps_median * a.tps_n + b.tps_median * b.tps_n) / n) * 10) / 10, tps_n: n };
  return validSpeed(out.tps_median, out.tps_n) ? out : null;
}
