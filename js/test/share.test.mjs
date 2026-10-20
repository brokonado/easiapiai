// Usage sharing: the readers (Claude Code errors and sellers, Codex providers, the OpenRouter activity report),
// merging, `share`, `sharing on|off|status` and the plugin's two hooks, against a local fake server.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { errorKind } from "../claude_code.mjs";
import * as claudeReader from "../readers/claude_code.mjs";
import * as codexReader from "../readers/codex.mjs";
import { collect, lastMonths } from "../readers/index.mjs";
import * as openrouter from "../readers/openrouter.mjs";
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

  it("credits other models to the host of ANTHROPIC_BASE_URL", async () => {
    const res = await claudeReader.read(ctxFor(t.home, { ANTHROPIC_BASE_URL: "https://API.Z.ai/api/anthropic" }));
    const glm = res.rows.find((r) => r.model === "glm-4.6");
    assert.deepEqual(glm, { seller: "api.z.ai", model: "glm-4.6", month: THIS, input_tokens: 1, output_tokens: 2,
      cached_input_tokens: 0, requests: 1, errors: { auth: 1, other: 1 } });
    assert.equal(res.rows.find((r) => r.model === "claude-sonnet-4-5" && r.month === THIS).seller, "Anthropic");
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
