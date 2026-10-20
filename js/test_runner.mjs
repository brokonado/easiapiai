// `easiapiai test`: ask a provider easiapiai's test questions with your own key, on your machine, and send the raw
// answers (never the key) to easiapiai for grading.
//
// The key is read only from the environment variable you name, and is sent only to --base-url: as an
// Authorization header that is never forwarded on a redirect (redirects are refused outright).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import * as api from "./api.mjs";
import { configDir } from "./config.mjs";
import { joinPath } from "./files.mjs";
import { HTTPError, URLError, ValueError, discard, open, readBody } from "./http.mjs";
import {
  get, has, head, isDict, iterate, jsonDumps, ljust, pyLen, pyRepr, pyStr, or, rjust, strip, stripChars, truthy,
  urlsplit,
} from "./py.mjs";
import { CLIENT } from "./version.mjs";

const MAX_RESPONSE = 4000;
// Python's $ also matches before a final newline
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}\n?$/;


// uuid.UUID(text) then str(): the canonical form, or null where Python raises ValueError
function parseUuid(text) {
  let hex = text.replaceAll("urn:", "").replaceAll("uuid:", "");
  hex = stripChars(hex, "{}").replaceAll("-", "");
  if (pyLen(hex) !== 32) return null;
  const m = /^\s*([+-]?)(?:0[xX]_?)?([0-9a-fA-F]+(?:_[0-9a-fA-F]+)*)\s*$/.exec(hex); // int(hex, 16)
  if (!m) return null;
  let value = BigInt("0x" + m[2].replaceAll("_", ""));
  if (m[1] === "-") value = -value;
  if (value < 0n || value >= 1n << 128n) return null;
  const h = value.toString(16).padStart(32, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// A random id kept in ~/.config/easiapiai/install_id (the same file the Python client uses unless
// $EASIAPIAI_CONFIG_DIR is set), created on first use.
// It lets easiapiai count distinct contributors (results publish only once 5 people have tested a seller); it says
// nothing about you.
export function installId(directory = null) {
  const file = joinPath(directory || configDir(), "install_id");
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(file));
    const id = parseUuid(strip(text));
    if (id !== null) return id;
  } catch {
    // missing or unreadable: make a new one
  }
  const fresh = crypto.randomUUID();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fresh + os.EOL, "utf-8");
  } catch {
    process.stderr.write(`note: could not save ${file}; this run uses a one-off install id\n`);
  }
  return fresh;
}

export function completionsUrl(baseUrl) {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/chat/completions") ? base : base + "/chat/completions";
}

// obj["choices"][0]["message"].get("content") as text, or null when the answer does not have that shape
function textOf(obj) {
  if (!has(obj, "choices")) return null;
  const choices = obj.choices;
  if (!Array.isArray(choices) || !choices.length) return null;
  const first = choices[0];
  if (!isDict(first) || !has(first, "message") || !isDict(first.message)) return null;
  let content = get(first.message, "content");
  if (Array.isArray(content)) { // some providers return content parts
    let joined = "";
    for (const part of content) {
      if (!isDict(part)) continue;
      const text = or(get(part, "text"), "");
      if (typeof text !== "string") throw new TypeError("sequence item: expected str instance"); // as Python's join
      joined += text;
    }
    content = joined;
  }
  return typeof content === "string" ? content : (content === null ? "" : null);
}

// One question to an OpenAI-compatible chat/completions endpoint.
// -> {response, latency_ms, ttft_ms, output_tokens, error, status}. On an error the response is empty: a provider's
// error text can echo part of the key, so it is never kept.
export async function ask(endpoint, providerModel, key, prompt, timeout = 60.0) {
  const body = Buffer.from(jsonDumps({
    model: providerModel, messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: 2048,
  }), "utf-8");
  const headers = {
    "Content-Type": "application/json", Accept: "application/json", "User-Agent": CLIENT,
    Authorization: "Bearer " + key,
  };
  const out = { response: "", latency_ms: 0, ttft_ms: null, output_tokens: null, error: null, status: null };
  const t0 = performance.now();
  let raw;
  try {
    const res = await open("POST", endpoint, { body, headers, timeout, redirects: false });
    out.status = res.statusCode;
    raw = await readBody(res);
  } catch (err) {
    if (err instanceof HTTPError) {
      discard(err.response);
      out.status = err.status;
      out.error = err.status === 429 ? "http_429" : err.status >= 500 && err.status < 600 ? "http_5xx" : "other";
    } else if (err instanceof URLError && err.timedOut) {
      out.error = "timeout";
    } else if (err instanceof URLError || err instanceof ValueError) {
      out.error = "other";
    } else {
      throw err;
    }
  }
  out.latency_ms = Math.round(performance.now() - t0);
  if (out.error) return out;
  const obj = api.loads(raw);
  const text = isDict(obj) ? textOf(obj) : null;
  if (text === null) {
    out.error = "other";
    return out;
  }
  out.response = head(text, MAX_RESPONSE);
  const usage = isDict(get(obj, "usage")) ? get(obj, "usage") : {};
  const ct = get(usage, "completion_tokens");
  out.output_tokens = Number.isInteger(ct) ? ct : null;
  return out;
}

function fail(msg, code = 1) {
  process.stderr.write("easiapiai test: " + msg + "\n");
  return code;
}

function print(s = "") {
  process.stdout.write(s + "\n");
}

export async function run(args, environ = null) {
  environ = environ ?? process.env;
  if (!ENV_NAME.test(args.key_env || "")) {
    // never echo the value: people sometimes paste the key itself here
    return fail("--key-env takes the NAME of an environment variable (for example DEEPINFRA_API_KEY), "
      + "not the key itself.", 2);
  }
  const key = strip(environ[args.key_env] ?? "");
  if (!key) {
    return fail(`the environment variable ${args.key_env} is empty or not set. Put your provider key in it first, `
      + `e.g.  export ${args.key_env}=...  (the key is read from there and sent only to --base-url).`, 2);
  }
  const parts = urlsplit(args.base_url);
  if (!["http", "https"].includes(parts.scheme) || !parts.hostname) {
    return fail("--base-url must be an http(s) URL, e.g. https://api.deepinfra.com/v1/openai", 2);
  }
  if (parts.netloc.toLowerCase() === urlsplit(args.api).netloc.toLowerCase()) {
    return fail("--base-url points at the easiapiai API itself; your key must go to your provider only.", 2);
  }
  if (parts.scheme === "http" && !["localhost", "127.0.0.1", "::1"].includes(parts.hostname)) {
    process.stderr.write(`warning: --base-url is plain http, so your key travels unencrypted to ${parts.hostname}\n`);
  }
  if (!(args.n >= 1 && args.n <= 20)) return fail("-n must be between 1 and 20.", 2);

  let qs;
  try {
    qs = await api.call("GET", api.url(args.api, "/api/test/questions", { model: args.model, n: args.n }),
      null, args.timeout);
  } catch (err) {
    if (!(err instanceof api.ApiError)) throw err;
    const sug = get(err.data, "suggestions");
    return fail(`could not get test questions: ${err.message}`
      + (truthy(sug) ? `; did you mean ${iterate(sug).map(pyStr).join(", ")}?` : ""));
  }
  const questions = or(get(qs, "questions"), []);
  if (!truthy(get(qs, "run_id")) || !truthy(questions)) return fail("the question server sent no questions.");
  const model = or(get(qs, "model"), {});
  const endpoint = completionsUrl(args.base_url);
  print(`Testing ${pyStr(or(get(model, "name"), args.model))} as served by ${args.seller} `
    + `(model id ${pyRepr(args.provider_model)} at ${parts.hostname}).`);
  const items = iterate(questions);
  print(`${items.length} questions from ${args.api.replace(/\/+$/, "")}; your key comes from $${args.key_env} `
    + `and goes only to ${parts.hostname}.`);

  const answers = [];
  for (let i = 1; i <= items.length; i++) {
    const q = items[i - 1];
    const a = await ask(endpoint, args.provider_model, key, pyStr(or(get(q, "prompt"), "")), args.timeout);
    const status = a.status;
    delete a.status;
    if (i === 1 && a.error === "other") {
      // most likely a set-up problem (wrong key, URL or model id), not a provider failure: stop, send nothing
      return fail(`the first question failed (${status && status >= 300 ? `HTTP ${status}`
        : `no usable answer from ${parts.hostname}`}). Check the key, --base-url and --provider-model. `
        + "Nothing was sent to easiapiai.");
    }
    const tail = a.error ? `error: ${a.error}` + (status ? ` (HTTP ${status})` : "")
      : `${a.output_tokens !== null ? a.output_tokens : "?"} output tokens`;
    print(`  ${rjust(String(i), 2)}/${items.length}  ${ljust(pyStr(get(q, "qid")), 14)} `
      + `${rjust(String(a.latency_ms), 6)} ms  ${tail}`);
    a.qid = get(q, "qid");
    answers.push(a);
  }

  const body = {
    run_id: qs.run_id, seller: args.seller, base_url_host: parts.hostname, model_requested: args.provider_model,
    official: Boolean(args.official), install_id: installId(), client: CLIENT,
    answers: answers.map((a) => ({
      qid: a.qid, response: a.response, latency_ms: a.latency_ms, ttft_ms: a.ttft_ms,
      output_tokens: a.output_tokens, error: a.error,
    })),
  };
  print("Sending the raw answers for grading (no key, no URL path) ...");
  let res;
  try {
    res = await api.call("POST", api.url(args.api, "/api/test/submit"), body, args.timeout);
  } catch (err) {
    if (!(err instanceof api.ApiError)) throw err;
    return fail(`could not submit the answers: ${err.message}`);
  }

  const sc = or(get(res, "score"), {});
  const errors = get(sc, "errors");
  print(`\nScore: ${has(sc, "correct") ? pyStr(sc.correct) : "?"} of ${has(sc, "total") ? pyStr(sc.total) : "?"} `
    + `answers agree with the reference answers${truthy(errors) ? ` (${pyStr(errors)} errors, not graded)` : ""}.`);
  if (truthy(get(res, "seller_matched"))) {
    print(`Seller on easiapiai: ${pyStr(res.seller_matched)}`);
  } else {
    print(`Seller ${pyRepr(args.seller)} did not match a seller on easiapiai, so this run counts under no seller. `
      + "Use the name as it appears on easiapiai.com.");
  }
  if (truthy(get(res, "results_url"))) print(`Results: ${pyStr(res.results_url)}`);
  print("One run is a small sample. easiapiai publishes a model/seller result only after 300 answers from at "
    + "least 5 people, as measured agreement with an interval: https://easiapiai.com/accountability");
  return 0;
}
