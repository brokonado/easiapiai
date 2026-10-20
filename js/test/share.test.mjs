// Usage sharing: the readers (Claude Code errors and sellers, Codex providers, the OpenRouter activity report),
// merging, `share`, `sharing on|off|status` and the plugin's two hooks, against a local fake server.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { errorKind, readLines } from "../claude_code.mjs";
import * as claudeReader from "../readers/claude_code.mjs";
import * as codexReader from "../readers/codex.mjs";
import { collect, lastMonths } from "../readers/index.mjs";
import * as openrouter from "../readers/openrouter.mjs";
import { combine, median, replyTps, summarize, validSpeed } from "../readers/speed.mjs";
import { printTable } from "../share.mjs";
import { FakeServer, ccLine, runCli, tempEnv, writeJsonl } from "./helpers.mjs";

const NOW = new Date();
const MONTHS = lastMonths(13, NOW);
const THIS = MONTHS[0];
const at = (monthsBack, day = 15) => new Date(NOW.getFullYear(), NOW.getMonth() - monthsBack, day, 12).toISOString();
const ctxFor = (home, env = {}, months = MONTHS) => ({ home, env, platform: process.platform, now: NOW, months });

// An API error line as Claude Code writes it (only the fields that matter, plus its message text)
function errLine(uuid, ts, error, status = null) {
  const line = { type: "assistant", uuid, timestamp: ts, isApiErrorMessage: true, error, sessionId: "s-1",
    message: { id: "e-" + uuid, model: "<synthetic>", role: "assistant", type: "message",
      usage: { input_tokens: 0, output_tokens: 0 }, content: [{ type: "text", text: "API Error: SECRET text" }] } };
  if (status !== null) line.apiErrorStatus = status;
  return line;
}

function claudeErrorsFixture(home) {
  const proj = path.join(home, ".claude", "projects", "p");
  writeJsonl(path.join(proj, "a.jsonl"), [
    errLine("u0", at(0), "rate_limit"), // no reply before it in this file: left out
    ccLine("m1", "r1", "claude-sonnet-4-5", at(0), { inp: 10, out: 20, read: 30, w5: 4, w1: 2 }),
    errLine("u1", at(0), "rate_limit"),
    errLine("u2", at(0), "rate_limit", 429),
    errLine("u3", at(0), "server_error", 529),
    errLine("u4", at(0), "server_error", 500),
    errLine("u5", at(0), "server_error"),
    ccLine("m2", "r2", "glm-4.6", at(0), { inp: 1, out: 2 }),
    errLine("u6", at(0), "authentication_failed"),
    errLine("u7", at(0), "unknown", 400),
    ccLine("m3", "r3", "claude-sonnet-4-5", at(14), { inp: 5, out: 5 }), // older than 13 months: left out
  ]);
  // the same error line again in another file counts once; an error before any reply in this file is left out
  writeJsonl(path.join(proj, "b.jsonl"), [errLine("u9", at(0), "server_error", 529),
    ccLine("m4", "r4", "claude-sonnet-4-5", at(1), { inp: 1, out: 1, legacyCw: 3 }), errLine("u1", at(0), "rate_limit")]);
}

// Claude Code speed: lines with uuid, parentUuid and timestamps (seconds after the 15th of this month, 12:00)
const BASE = new Date(NOW.getFullYear(), NOW.getMonth(), 15, 12).getTime();
const T = (sec) => new Date(BASE + sec * 1000).toISOString();
const SPEED_MODEL = "claude-sonnet-4-5";
const other = (type, uuid, sec, parentUuid = null, extra = {}) => ({ type, uuid, parentUuid, timestamp: T(sec),
  sessionId: "s-1", ...extra });
const user = (uuid, sec, parent = null) => other("user", uuid, sec, parent,
  { message: { role: "user", content: "SECRET prompt" } });
const reply = (mid, uuid, parent, sec, out) => ({ ...ccLine(mid, "r-" + mid, SPEED_MODEL, T(sec), { inp: 1, out }), uuid,
  parentUuid: parent });

function claudeSpeedFixture(home) {
  const proj = path.join(home, ".claude", "projects", "speed");
  writeJsonl(path.join(proj, "a.jsonl"), [
    user("u1", 0),
    // A: three lines, output grows; ends at the last line: 200 tokens in 5 s = 40/s
    reply("A", "a1", "u1", 1, 10), reply("A", "a2", "a1", 3, 10), reply("A", "a3", "a2", 5, 200),
    // B answers tool results through two attachment lines; a queued message carries the earlier time it was typed.
    // Sent = the latest of them (10); ends at its LAST line of the largest output (15): 300 in 5 s = 60/s
    user("t1", 9, "a3"), other("attachment", "att1", 10, "t1", { attachment: { type: "todo_reminder" } }),
    other("attachment", "att2", -30, "att1", { attachment: { type: "queued_command", prompt: "SECRET" } }),
    reply("B", "b1", "att2", 12, 300), reply("B", "b2", "b1", 15, 300),
    // C: its parent is not in the file: the previous user/attachment/system line (20), not the queue line (21)
    other("system", "s1", 20, "b2"), other("queue-operation", "q1", 21),
    reply("C", "c1", "gone", 25, 100), // 100 in 5 s = 20/s
    user("u2", 30, "c1"), reply("D", "d1", "u2", 31, 49), // under 50 tokens
    user("u3", 40, "d1"), reply("E", "e1", "u3", 40.4, 100), // under 0.5 s
    user("u4", 50, "e1"), reply("F", "f1", "u4", 50.5, 3000), // 6000/s: a broken timestamp
    user("u5", 60, "f1"), reply("G", "g1", "u5", 60.5, 2500), // exactly 5000/s and 0.5 s: counted
    user("u6", 70, "g1"), reply("H", "h1", "u6", 71, 50), // exactly 50 tokens: 50/s, counted
    '{"type": "user", "broken',
  ]);
  // A again in another file (a resumed session), same output, later times: the copy that finished first is kept
  writeJsonl(path.join(home, ".claude", "projects", "speed-copy", "b.jsonl"), [user("u9", 100),
    reply("A", "a1", "u9", 400, 200)]);
}

describe("Claude Code reader", () => {
  let t;
  beforeEach(() => {
    t = tempEnv();
    claudeErrorsFixture(t.home);
  });
  afterEach(() => t.cleanup());

  it("classifies API errors as the spec says", () => {
    assert.equal(errorKind("rate_limit", undefined), "rate_limit");
    assert.equal(errorKind("rate_limit", 429), "rate_limit");
    assert.equal(errorKind("server_error", 529), "overloaded");
    assert.equal(errorKind("server_error", 500), "server");
    assert.equal(errorKind("server_error", null), "server");
    assert.equal(errorKind("authentication_failed", null), "auth");
    assert.equal(errorKind("unknown", 400), "other");
    assert.equal(errorKind(undefined, undefined), "other");
  });

  it("counts requests and errors per model, by the model in use before each error", async () => {
    const res = await claudeReader.read(ctxFor(t.home));
    assert.equal(res.found, true);
    assert.equal(res.rows.length, 2);
    assert.deepEqual(res.rows.find((r) => r.month === THIS), { seller: "Anthropic", model: "claude-sonnet-4-5",
      month: THIS, input_tokens: 16, output_tokens: 20, cached_input_tokens: 30, requests: 1, // 10 + writes 4 + 2
      errors: { rate_limit: 2, overloaded: 1, server: 2 } });
    assert.deepEqual(res.rows.find((r) => r.month === MONTHS[1]), { seller: "Anthropic", model: "claude-sonnet-4-5",
      month: MONTHS[1], input_tokens: 4, output_tokens: 1, cached_input_tokens: 0, requests: 1 }); // 1 + 3 written
    assert.ok(!res.rows.some((r) => r.model === "glm-4.6"), "no seller known for glm-4.6");
    assert.match(res.note, /ANTHROPIC_BASE_URL/);
  });

  it("sends no speed when the lines carry no request time", async () => {
    const res = await claudeReader.read(ctxFor(t.home));
    assert.ok(res.rows.every((r) => !("tps_median" in r) && !("tps_n" in r)));
  });

  it("credits other models to the host of ANTHROPIC_BASE_URL", async () => {
    const res = await claudeReader.read(ctxFor(t.home, { ANTHROPIC_BASE_URL: "https://API.Z.ai/api/anthropic" }));
    const glm = res.rows.find((r) => r.model === "glm-4.6");
    assert.deepEqual(glm, { seller: "api.z.ai", model: "glm-4.6", month: THIS, input_tokens: 1, output_tokens: 2,
      cached_input_tokens: 0, requests: 1, errors: { auth: 1, other: 1 } });
    assert.equal(res.rows.find((r) => r.model === "claude-sonnet-4-5" && r.month === THIS).seller, "Anthropic");
  });
});

describe("Claude Code speed", () => {
  let t;
  beforeEach(() => {
    t = tempEnv();
    claudeSpeedFixture(t.home);
  });
  afterEach(() => t.cleanup());

  it("times each reply from the line it answers to its last line", () => {
    const timing = new Map();
    readLines([path.join(t.home, ".claude", "projects")], null, timing);
    const tps = (mid) => {
      const r = timing.get(`s${JSON.stringify(mid)}|s${JSON.stringify("r-" + mid)}`);
      return replyTps(r[2], (r[1] - r[0]) / 1000);
    };
    assert.deepEqual(["A", "B", "C", "D", "E", "F", "G", "H"].map(tps), [40, 60, 20, null, null, null, 5000, 50]);
  });

  it("keeps the copy of a reply that finished first, whichever folder is read first", () => {
    const a = path.join(t.home, ".claude", "projects", "speed");
    const b = path.join(t.home, ".claude", "projects", "speed-copy");
    const key = `s${JSON.stringify("A")}|s${JSON.stringify("r-A")}`;
    for (const dirs of [[a, b], [b, a]]) {
      const timing = new Map();
      readLines(dirs, null, timing);
      const r = timing.get(key);
      assert.equal(replyTps(r[2], (r[1] - r[0]) / 1000), 40);
    }
  });

  it("a row carries the median and the number of replies counted", async () => {
    const res = await claudeReader.read(ctxFor(t.home));
    assert.deepEqual(res.rows, [{ seller: "Anthropic", model: SPEED_MODEL, month: THIS, input_tokens: 8,
      output_tokens: 6299, cached_input_tokens: 0, requests: 8, tps_median: 50, tps_n: 5 }]); // 20 40 50 60 5000
  });

  it("bill reads the same tokens with or without timing", () => {
    const dirs = [path.join(t.home, ".claude", "projects")];
    assert.deepEqual([...readLines(dirs)[0]], [...readLines(dirs, null, new Map())[0]]);
  });
});

describe("speed rules", () => {
  it("counts a reply with 50+ output tokens, 0.5 s or more, at most 5000 per second", () => {
    assert.equal(replyTps(50, 1), 50);
    assert.equal(replyTps(49, 1), null);
    assert.equal(replyTps(100, 0.5), 200);
    assert.equal(replyTps(100, 0.49), null);
    assert.equal(replyTps(5000, 1), 5000);
    assert.equal(replyTps(5001, 1), null);
    assert.equal(replyTps(100, -3), null);
    assert.equal(replyTps(100, NaN), null);
    assert.equal(replyTps("100", 1), null);
  });

  it("median, summary and validity", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(summarize([]), null);
    assert.deepEqual(summarize([10, 20.04, 30]), { tps_median: 20, tps_n: 3 });
    assert.deepEqual(summarize([10.04, 20.11]), { tps_median: 15.1, tps_n: 2 });
    assert.equal(summarize([0.01]), null); // rounds to 0: not sendable
    assert.ok(validSpeed(5000, 1e9));
    for (const [m, n] of [[0, 1], [5000.1, 1], [-1, 1], [NaN, 1], ["50", 1], [50, 0], [50, 1.5], [50, 1e9 + 1],
      [50, undefined], [undefined, 3]]) {
      assert.equal(validSpeed(m, n), false, `${m} ${n}`);
    }
  });

  it("combines two rows' speeds weighted by reply counts", () => {
    assert.deepEqual(combine({ tps_median: 50, tps_n: 2 }, { tps_median: 81, tps_n: 1 }),
      { tps_median: 60.3, tps_n: 3 });
    assert.deepEqual(combine({ tps_median: 50, tps_n: 2 }, {}), { tps_median: 50, tps_n: 2 });
    assert.deepEqual(combine({}, { tps_median: 70, tps_n: 4 }), { tps_median: 70, tps_n: 4 });
    assert.equal(combine({}, {}), null);
  });
});

describe("Codex reader", () => {
  let t;
  beforeEach(() => {
    t = tempEnv();
  });
  afterEach(() => t.cleanup());

  const rollout = (name, provider, model) => {
    const recs = [];
    if (provider !== null) recs.push({ timestamp: at(0), type: "session_meta", payload: { id: "x", model_provider: provider } });
    recs.push({ timestamp: at(0), type: "turn_context", payload: { model } });
    // cache writes are part of input_tokens in Codex: input stays 100 - 40
    const u = { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 30, output_tokens: 10,
      reasoning_output_tokens: 0, total_tokens: 110 };
    recs.push({ timestamp: at(0), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: u, last_token_usage: u } } });
    writeJsonl(path.join(t.home, ".codex", "sessions", `rollout-${name}.jsonl`), recs);
  };

  it("takes the seller from the session's model_provider and skips local runtimes", async () => {
    rollout("a", "openai", "gpt-5.1-codex");
    rollout("b", "deepseek", "deepseek-chat");
    rollout("c", "ollama", "qwen3");
    rollout("d", null, "gpt-5");
    rollout("e", null, "qwen3-coder");
    rollout("f", "lmstudio", "gpt-oss-20b");
    const res = await codexReader.read(ctxFor(t.home));
    assert.deepEqual(res.rows.map((r) => [r.seller, r.model]).sort(),
      [["OpenAI", "gpt-5"], ["OpenAI", "gpt-5.1-codex"], ["deepseek", "deepseek-chat"]]);
    assert.deepEqual(res.rows.find((r) => r.model === "gpt-5").input_tokens, 60);
  });
});

describe("OpenRouter reader", () => {
  let server;
  beforeEach(async () => {
    server = await new FakeServer().start();
  });
  afterEach(async () => server.close());
  const now = new Date(Date.UTC(2026, 9, 20, 12)); // 2026-10-20: the 30-day window starts 2026-09-20
  const ctx = (env) => ({ home: "/nonexistent", env, platform: process.platform, now,
    months: lastMonths(13, now), openrouterBase: server.url + "/api/v1" });
  const item = (date, model, provider, p, c, cached, req, usage) => ({ date, model, model_permaslug: model + "-x",
    endpoint_id: "e", provider_name: provider, prompt_tokens: p, completion_tokens: c, cached_tokens: cached,
    reasoning_tokens: 1, requests: req, usage, byok_usage_inference: 0 });

  it("is not used without a management key, and sends no request", async () => {
    const res = await openrouter.read(ctx({}));
    assert.equal(res.found, false);
    assert.match(res.note, /OPENROUTER_MANAGEMENT_KEY/);
    assert.deepEqual(server.requests, []);
  });

  it("maps the activity report to rows per provider, model and month", async () => {
    server.overrides["/api/v1/activity"] = [{ body: { data: [
      item("2026-10-01", "deepseek/deepseek-chat", "DeepInfra", 100, 10, 5, 2, 0.01),
      item("2026-10-02", "deepseek/deepseek-chat", "DeepInfra", 200, 20, 0, 3, 0.02),
      item("2026-10-02", "deepseek/deepseek-chat", "Together (turbo)!", 50, 5, 0, 1, 0.005),
      item("2026-10-03", "deepseek/deepseek-chat", "Together (turbo)!", 4, 1, 9, 1, 0), // more cached than prompt
      item("2026-09-25", "deepseek/deepseek-chat", "DeepInfra", 999, 999, 0, 9, 9), // September is only partly covered
    ] } }];
    const res = await openrouter.read(ctx({ OPENROUTER_MANAGEMENT_KEY: "mgmt-key-123" }));
    assert.equal(server.requests[0].headers.authorization, "Bearer mgmt-key-123");
    assert.equal(server.requests[0].path, "/api/v1/activity");
    assert.deepEqual(res.rows, [
      { seller: "OpenRouter", served_by: "DeepInfra", model: "deepseek/deepseek-chat", month: "2026-10",
        input_tokens: 295, output_tokens: 30, cached_input_tokens: 5, requests: 5, cost_usd: 0.03, source: "usage_api" },
      { seller: "OpenRouter", served_by: "Together turbo", model: "deepseek/deepseek-chat", month: "2026-10",
        input_tokens: 50, output_tokens: 6, cached_input_tokens: 9, requests: 2, cost_usd: 0.005, source: "usage_api" },
    ]);
  });

  it("reports a refused key without rows, and never follows a redirect with the key", async () => {
    server.overrides["/api/v1/activity"] = [{ status: 401, body: { error: { message: "bad key" } } }];
    let res = await openrouter.read(ctx({ OPENROUTER_MANAGEMENT_KEY: "k" }));
    assert.deepEqual([res.found, res.rows, res.note], [false, [], "could not read the activity report (HTTP 401)"]);
    server.overrides["/api/v1/activity"] = [{ status: 302, headers: { Location: "/elsewhere" } }];
    res = await openrouter.read(ctx({ OPENROUTER_MANAGEMENT_KEY: "k" }));
    assert.equal(res.found, false);
    assert.ok(!server.paths().includes("/elsewhere"));
  });
});

describe("collect", () => {
  const reader = (name, rows) => ({ NAME: name, read: async () => ({ name, found: true, rows, note: null }) });
  const row = (seller, model, extra = {}) => ({ seller, model, month: THIS, input_tokens: 10, output_tokens: 1, ...extra });

  it("merges rows of the same seller, model and month, and drops what cannot be sent", async () => {
    const { sources, rows } = await collect(ctxFor("/x"), [
      reader("A", [row("Anthropic", "claude-x", { requests: 1, errors: { rate_limit: 1 } }),
        row("Anthropic", "sk-abcdefgh123"), row("Anthropic", "claude-y", { month: "1999-01" }),
        row("Anthropic", "claude-z", { input_tokens: 0, output_tokens: 0 })]),
      reader("B", [row("Anthropic", "claude-x", { requests: 2, errors: { rate_limit: 2, server: 1 }, cost_usd: 1 })]),
    ]);
    assert.deepEqual(sources.map((s) => s.rows), [1, 1]);
    assert.deepEqual(rows, [{ seller: "Anthropic", model: "claude-x", month: THIS, input_tokens: 20, output_tokens: 2,
      cached_input_tokens: 0, requests: 3, errors: { rate_limit: 3, server: 1 }, source: "logs" }]);
  });

  it("merges speed as the reply-weighted mean of the medians, and sends it only as a valid pair", async () => {
    const { rows } = await collect(ctxFor("/x"), [
      reader("A", [row("Anthropic", "claude-x", { tps_median: 50, tps_n: 2 }), row("Anthropic", "claude-y"),
        row("Anthropic", "claude-z", { tps_median: 40, tps_n: 3 })]),
      reader("B", [row("Anthropic", "claude-x", { tps_median: 81, tps_n: 1 }),
        row("Anthropic", "claude-y", { tps_median: 70, tps_n: 4 }),
        row("Anthropic", "claude-z", { tps_median: 0, tps_n: 9 })]), // invalid: dropped, A's speed kept
    ]);
    assert.deepEqual(rows.map((r) => [r.model, r.tps_median, r.tps_n]),
      [["claude-x", 60.3, 3], ["claude-y", 70, 4], ["claude-z", 40, 3]]);
    const bad = [{ tps_median: 5001, tps_n: 1 }, { tps_median: 50, tps_n: 0 }, { tps_median: 50, tps_n: 2.5 },
      { tps_median: 50 }, { tps_n: 5 }, { tps_median: "50", tps_n: 1 }, { tps_median: 50, tps_n: 1e10 }];
    const cleaned = await collect(ctxFor("/x"), [reader("C", bad.map((b, i) => row("S", `m${i}`, b)))]);
    assert.equal(cleaned.rows.length, bad.length);
    assert.ok(cleaned.rows.every((r) => !("tps_median" in r) && !("tps_n" in r)));
    const edge = await collect(ctxFor("/x"), [reader("D", [row("S", "m", { tps_median: 5000, tps_n: 1e9 })])]);
    assert.deepEqual([edge.rows[0].tps_median, edge.rows[0].tps_n], [5000, 1e9]);
  });

  it("leaves out a tool's OpenRouter rows when the activity report covers them", async () => {
    const { rows } = await collect(ctxFor("/x"), [
      reader("Cline", [row("OpenRouter", "a/m"), row("OpenRouter", "a/other")]),
      reader("OpenRouter", [row("OpenRouter", "a/m", { served_by: "DeepInfra", source: "usage_api" })]),
    ]);
    assert.deepEqual(rows.map((r) => [r.model, r.served_by ?? null, r.source]),
      [["a/other", null, "logs"], ["a/m", "DeepInfra", "usage_api"]]);
  });

  it("a reader that fails is a note, not an error", async () => {
    const { sources, rows } = await collect(ctxFor("/x"), [{ NAME: "Broken", read: async () => { throw new Error("x"); } }]);
    assert.deepEqual([sources[0].found, rows], [false, []]);
    assert.match(sources[0].note, /could not be read/);
  });
});

describe("share table", () => {
  const capture = (fn) => {
    const write = process.stdout.write;
    let out = "";
    process.stdout.write = (chunk) => {
      out += chunk;
      return true;
    };
    try {
      fn();
    } finally {
      process.stdout.write = write;
    }
    return out;
  };
  const base = { model: "m", month: "2026-10", input_tokens: 1000, output_tokens: 20, cached_input_tokens: 0,
    requests: 2 };

  it("adds a tok/s column when a row has speed, empty for rows without it and for the total", () => {
    const rows = [{ seller: "A", ...base, tps_median: 64.25, tps_n: 9 }, { seller: "B", ...base }];
    const out = capture(() => printTable(rows)).split("\n");
    assert.match(out[0], /Errors +tok\/s$/);
    assert.match(out[1], /^ +A +m +2026-10 +1,000 +20 +0 +2 +0 +64\.3$/);
    assert.match(out[2], /^ +B +m +2026-10 +1,000 +20 +0 +2 +0$/);
    assert.match(out[4], /^ +Total +2,000 +40 +0 +4 +0$/);
  });

  it("has no speed column when no row has speed", () => {
    const out = capture(() => printTable([{ seller: "A", ...base }]));
    assert.ok(!out.includes("tok/s"));
    assert.match(out.split("\n")[0], /Errors$/);
  });
});

describe("share and sharing", () => {
  let t;
  let api;
  beforeEach(async () => {
    t = tempEnv();
    claudeErrorsFixture(t.home);
    api = await new FakeServer().start();
    api.overrides["/api/usage/share"] = [{ body: { saved: 1, unmatched: [], thanks: "Thank you." } }];
  });
  afterEach(async () => {
    await api.close();
    t.cleanup();
  });
  const cfg = () => path.join(t.home, "cfg", "easiapiai");
  const posts = () => api.requests.filter((r) => r.path === "/api/usage/share").map((r) => JSON.parse(r.body));

  it("--json prints the request bodies and sends nothing", async () => {
    const { code, out } = await runCli(["share", "--json", "--api", api.url], t.env);
    assert.equal(code, 0);
    const bodies = JSON.parse(out);
    assert.equal(bodies.length, 1);
    assert.deepEqual(Object.keys(bodies[0]).sort(), ["client", "contributor", "rows", "source"]);
    assert.match(bodies[0].contributor, /^[0-9a-f]{32}$/);
    assert.equal(fs.readFileSync(path.join(cfg(), "contributor_id"), "utf-8").trim(), bodies[0].contributor);
    assert.ok(!out.includes("SECRET") && !out.includes("API Error"));
    assert.deepEqual(api.requests, []);
  });

  it("--dry-run, and no terminal without --yes, send nothing", async () => {
    let r = await runCli(["share", "--dry-run", "--api", api.url], t.env);
    assert.equal(r.code, 0);
    assert.match(r.out, /Claude Code +2 rows/);
    assert.match(r.out, /Dry run: nothing was sent/);
    r = await runCli(["share", "--api", api.url], t.env);
    assert.equal(r.code, 0);
    assert.match(r.out, /Nothing was sent\. To send these numbers to 127\.0\.0\.1, run again with --yes/);
    assert.deepEqual(api.requests, []);
  });

  it("shows and sends the speed of timed replies", async () => {
    claudeSpeedFixture(t.home);
    const r = await runCli(["share", "--dry-run", "--api", api.url], t.env);
    assert.equal(r.code, 0);
    assert.match(r.out,
      /\ntok\/s: the median output tokens per second of a reply, from the request to its last token\.\n/);
    assert.match(r.out, /claude-sonnet-4-5 +\d{4}-\d{2} .* 50\.0\n/);
    const { out } = await runCli(["share", "--json", "--api", api.url], t.env);
    const sent = JSON.parse(out)[0].rows.find((x) => x.model === "claude-sonnet-4-5" && x.month === THIS);
    assert.deepEqual([sent.tps_median, sent.tps_n], [50, 5]);
    assert.deepEqual(api.requests, []);
  });

  it("sends more than 50 rows in several requests", async () => {
    writeJsonl(path.join(t.home, ".claude", "projects", "many", "m.jsonl"), Array.from({ length: 55 },
      (_, i) => ccLine(`x${i}`, "r", `claude-m${String(i).padStart(2, "0")}`, at(0), { inp: 1, out: 1 })));
    const { code, out, err } = await runCli(["share", "--yes", "--api", api.url], t.env);
    assert.equal(code, 0, err);
    assert.deepEqual(posts().map((b) => b.rows.length), [50, 7]);
    assert.equal(new Set(posts().map((b) => b.contributor)).size, 1);
    assert.match(out, /Saved 2 of 57 rows/);
  });

  it("prints what was not saved, with suggestions", async () => {
    api.overrides["/api/usage/share"] = [{ body: { saved: 1, unmatched: [{ row: 1, why: "unknown model",
      suggestions: ["Claude Sonnet 4.5"] }], thanks: "ok" } }];
    const { out } = await runCli(["share", "--yes", "--api", api.url], t.env);
    assert.match(out, /Anthropic \/ claude-sonnet-4-5 \/ \d{4}-\d{2}: unknown model; did you mean Claude Sonnet 4\.5\?/);
  });

  it("sharing on / status / off keep the choice in sharing.json", async () => {
    let r = await runCli(["sharing", "on", "--no-send", "--api", api.url], t.env);
    assert.equal(r.code, 0);
    assert.match(r.out, /Automatic reporting is on: .*once a week.*sharing off/);
    let state = JSON.parse(fs.readFileSync(path.join(cfg(), "sharing.json"), "utf-8"));
    assert.deepEqual([state.auto, state.last_sent], [true, null]);
    r = await runCli(["sharing", "status"], t.env);
    assert.match(r.out, /Automatic reporting: on .*\nLast sent: never\./);
    r = await runCli(["sharing", "off"], t.env);
    state = JSON.parse(fs.readFileSync(path.join(cfg(), "sharing.json"), "utf-8"));
    assert.equal(state.auto, false);
    assert.deepEqual(api.requests, []);
  });

  it("sharing on sends right away and records when", async () => {
    const { code, out } = await runCli(["sharing", "on", "--api", api.url], t.env);
    assert.equal(code, 0);
    assert.equal(posts().length, 1);
    assert.match(out, /Sent now: 1 of 2 rows saved/);
    const state = JSON.parse(fs.readFileSync(path.join(cfg(), "sharing.json"), "utf-8"));
    assert.ok(Date.now() - Date.parse(state.last_sent) < 60000);
  });
});

describe("plugin hooks", () => {
  let t;
  let api;
  beforeEach(async () => {
    t = tempEnv();
    claudeErrorsFixture(t.home);
    api = await new FakeServer().start();
    api.overrides["/api/usage/share"] = [{ body: { saved: 1, unmatched: [] } }];
  });
  afterEach(async () => {
    await api.close();
    t.cleanup();
  });
  const file = () => path.join(t.home, "cfg", "easiapiai", "sharing.json");
  const state = () => JSON.parse(fs.readFileSync(file(), "utf-8"));
  const setState = (s) => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(s));
  };
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const start = () => runCli(["hook", "session-start"], t.env);
  const send = (env = t.env) => runCli(["hook", "send", "--api", api.url], env);

  it("session-start asks at most 3 times, 3 days apart, and never once decided", async () => {
    let r = await start();
    assert.equal(r.code, 0);
    assert.match(r.out, /^easiapiai plugin: the user has not decided about usage reporting yet\./);
    assert.match(r.out, /"easiapiai shows how LLM API sellers actually perform: speed, failed requests and real cost, /);
    assert.match(r.out, /token, error and speed numbers per seller and month, never your key, prompts or code\. Add /);
    assert.match(r.out, /run `node ".*easiapiai\.mjs" sharing on`; if no, run `node ".*easiapiai\.mjs" sharing off`/);
    assert.equal(r.out.trim().split("\n").length, 1);
    assert.equal(state().asked, 1);
    assert.equal((await start()).out, ""); // asked less than 3 days ago
    setState({ ...state(), asked_at: daysAgo(3.1) });
    assert.notEqual((await start()).out, "");
    setState({ ...state(), asked_at: daysAgo(4) });
    assert.notEqual((await start()).out, "");
    assert.equal(state().asked, 3);
    setState({ ...state(), asked_at: daysAgo(30) });
    assert.equal((await start()).out, ""); // three times is enough
    for (const auto of [true, false]) {
      setState({ auto, asked: 0, asked_at: null });
      r = await start();
      assert.deepEqual([r.code, r.out], [0, ""]);
    }
    assert.deepEqual(api.requests, []);
  });

  it("session-start never fails: a damaged or unwritable setting", async () => {
    setState({});
    fs.writeFileSync(file(), "{not json");
    let r = await start();
    assert.equal(r.code, 0);
    assert.match(r.out, /not decided/);
    const env = { ...t.env, EASIAPIAI_CONFIG_DIR: path.join(t.home, "a-file") };
    fs.writeFileSync(env.EASIAPIAI_CONFIG_DIR, "");
    r = await runCli(["hook", "session-start"], env);
    assert.deepEqual([r.code, r.out], [0, ""]); // cannot record the question: better not ask at all
  });

  it("send: only when sharing is on, at most once in 7 days, never a word on stdout", async () => {
    let r = await send();
    assert.deepEqual([r.code, r.out, r.err, api.requests.length], [0, "", "", 0]); // not decided
    setState({ auto: false });
    r = await send();
    assert.deepEqual([r.out, api.requests.length], ["", 0]);
    setState({ auto: true, asked: 1 });
    r = await send();
    assert.deepEqual([r.code, r.out, r.err], [0, "", ""]);
    assert.equal(api.requests.length, 1);
    const body = JSON.parse(api.requests[0].body);
    assert.match(body.client, / auto$/);
    assert.ok(body.rows.every((x) => x.month === MONTHS[0] || x.month === MONTHS[1]), "current and previous month only");
    assert.ok(state().last_sent);
    assert.equal(state().asked, 1); // the rest of the setting is kept
    r = await send();
    assert.deepEqual([r.out, api.requests.length], ["", 1]); // within 7 days: nothing
    setState({ ...state(), last_sent: daysAgo(8) });
    r = await send();
    assert.deepEqual([r.out, api.requests.length], ["", 2]);
  });

  it("send: a failure changes nothing and stays silent unless EASIAPIAI_DEBUG=1", async () => {
    api.overrides["/api/usage/share"] = [{ status: 500, body: { error: "boom" } }];
    setState({ auto: true });
    let r = await send();
    assert.deepEqual([r.code, r.out, r.err], [0, "", ""]);
    assert.equal(state().last_sent ?? null, null);
    r = await send({ ...t.env, EASIAPIAI_DEBUG: "1" });
    assert.equal(r.out, "");
    assert.match(r.err, /easiapiai hook send: boom/);
  });
});
