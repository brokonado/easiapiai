// `easiapiai bill` and `easiapiai test`, run as a user runs them, against a local fake server. A port of
// tests/test_commands.py.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

import { completionsUrl, installId } from "../test_runner.mjs";
import { CLIENT, VERSION } from "../version.mjs";
import {
  CODEX_EXPECTED, FakeServer, ccLine, claudeFixture, codexSession, runCli, tempEnv, writeJsonl,
} from "./helpers.mjs";

const KEY = "sk-test-0123456789abcdef-SECRET";

describe("bill", () => {
  let t;
  let api;
  let expected;
  beforeEach(async () => {
    t = tempEnv();
    let ccd;
    [ccd, expected] = claudeFixture(t.home);
    t.env.CLAUDE_CONFIG_DIR = ccd;
    api = await new FakeServer().start();
  });
  afterEach(async () => {
    await api.close();
    t.cleanup();
  });
  const bodies = () => api.requests.filter((r) => r.path === "/api/bill").map((r) => JSON.parse(r.body));

  it("prints the table first, then sends, then prints the prices", async () => {
    const { code, out, err } = await runCli(["bill", "--api", api.url], t.env);
    assert.equal(code, 0, err);
    assert.ok(out.indexOf("Claude Code usage on this computer") < out.indexOf("Sending the Claude Code totals"));
    assert.ok(out.indexOf("Sending") < out.indexOf("cheapest verified seller: CheapCo $1.00"));
    assert.ok(out.includes("saves $2.00"));
    assert.ok(out.includes("Total at list prices $15.00"));
    assert.deepEqual(bodies(), [{ usage: expected, current_seller: "Anthropic" }]);
  });

  it("sends nothing but the totals", async () => {
    await runCli(["bill", "--api", api.url], t.env);
    const raw = Buffer.concat(api.requests.map((r) => r.body)).toString("utf-8");
    for (const leak of ["SECRET CONTENT", "secret-project", "msg_1", "req_1", "s-1", t.home]) {
      assert.ok(!raw.includes(leak), leak);
    }
  });

  it("--dry-run and --json send nothing", async () => {
    let r = await runCli(["bill", "--dry-run", "--api", api.url], t.env);
    assert.equal(r.code, 0);
    assert.ok(r.out.includes("Dry run: nothing was sent."));
    r = await runCli(["bill", "--json", "--seller", "OpenRouter", "--api", api.url], t.env);
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { claude_code: { usage: expected, current_seller: "OpenRouter" } });
    assert.deepEqual(api.requests, []);
  });

  it("sends Codex separately and flags it experimental", async () => {
    t.env.CODEX_HOME = path.join(t.home, "cx");
    writeJsonl(path.join(t.home, "cx", "sessions", "2026", "09", "15", "rollout-a.jsonl"), codexSession());
    const { code, out, err } = await runCli(["bill", "--codex", "--api", api.url], t.env);
    assert.equal(code, 0, err);
    assert.ok(err.includes("EXPERIMENTAL"));
    assert.ok(out.includes("Codex usage on this computer"));
    const [cc, cx] = bodies();
    assert.equal(cc.current_seller, "Anthropic");
    assert.deepEqual(cx, { usage: CODEX_EXPECTED, current_seller: "OpenAI" });
  });

  it("models that are not priced get suggestions", async () => {
    writeJsonl(path.join(t.home, ".claude", "projects", "p9", "x.jsonl"),
      [ccLine("m9", "r9", "mystery-model", "2026-09-15T12:00:00.000Z", { inp: 1, out: 1 })]);
    const { code, out } = await runCli(["bill", "--api", api.url], t.env);
    assert.equal(code, 0);
    assert.ok(out.includes("Not priced: 'mystery-model' (2026-09) is not a model on easiapiai.com; "
      + "did you mean GPT-5?"));
  });

  it("splits more than 60 rows over several requests", async () => {
    const many = [];
    for (let i = 0; i < 70; i++) {
      many.push(ccLine(`m${i}`, "r", `claude-m${String(i).padStart(2, "0")}`, "2026-09-15T12:00:00.000Z", { inp: 1, out: 1 }));
    }
    writeJsonl(path.join(t.home, ".claude", "projects", "many", "m.jsonl"), many);
    const { code, out, err } = await runCli(["bill", "--api", api.url], t.env);
    assert.equal(code, 0, err);
    assert.deepEqual(bodies().map((b) => b.usage.length), [60, 15]);
    assert.ok(out.includes("Total at list prices $225.00"));
  });

  it("reports an API it cannot reach", async () => {
    const { code, err } = await runCli(["bill", "--api", "http://127.0.0.1:9"], t.env);
    assert.equal(code, 1);
    assert.ok(err.includes("could not reach"));
  });

  it("says so when there are no logs", async () => {
    t.env.HOME = t.env.USERPROFILE = path.join(t.home, "empty");
    delete t.env.CLAUDE_CONFIG_DIR;
    const { code, err } = await runCli(["bill", "--api", api.url], t.env);
    assert.equal(code, 1);
    assert.ok(err.includes("No Claude Code usage found"));
    assert.deepEqual(api.requests, []);
  });
});

describe("test", () => {
  let t;
  let api;
  let provider;
  beforeEach(async () => {
    t = tempEnv();
    api = await new FakeServer().start();
    provider = await new FakeServer().start();
    t.env.MY_KEY = KEY;
  });
  afterEach(async () => {
    await provider.close();
    await api.close();
    t.cleanup();
  });
  const runTest = (extra = [], { base = null, n = "4" } = {}) => runCli(["test", "--model", "test-model",
    "--base-url", base ?? provider.url + "/v1", "--provider-model", "org/test-model-fp8", "--seller", "DeepInfra",
    "--key-env", "MY_KEY", "-n", n, "--api", api.url, "--timeout", "0.5", ...extra], t.env);
  const keyNeverLeftFor = (server) => {
    for (const r of server.requests) {
      assert.ok(!JSON.stringify(r.headers).includes(KEY));
      assert.ok(!r.body.includes(KEY));
    }
  };

  it("a full run maps errors and submits", async () => {
    provider.script = { Q1: ["ok", "6*7 = 42", 7], Q2: ["status", 429], Q3: ["status", 503], Q4: ["sleep", 1.5] };
    const { code, out, err } = await runTest(["--official"]);
    assert.equal(code, 0, err);
    // the provider got the key, in the header, with the OpenAI-compatible body
    const prov = provider.requests.filter((r) => r.path === "/v1/chat/completions");
    assert.equal(prov.length, 4);
    assert.equal(prov[0].headers.authorization, "Bearer " + KEY);
    assert.deepEqual(JSON.parse(prov[0].body), { model: "org/test-model-fp8",
      messages: [{ role: "user", content: "Q1: what is 6*7?" }], temperature: 0, max_tokens: 2048 });
    // easiapiai never did
    assert.deepEqual(api.paths(), ["/api/test/questions", "/api/test/submit"]);
    keyNeverLeftFor(api);
    assert.ok(!(out + err).includes(KEY));
    const body = JSON.parse(api.requests[1].body);
    assert.equal(body.run_id, "run-1");
    assert.equal(body.seller, "DeepInfra");
    assert.equal(body.base_url_host, "127.0.0.1");
    assert.equal(body.model_requested, "org/test-model-fp8");
    assert.equal(body.official, true);
    assert.equal(body.client, CLIENT);
    const saved = fs.readFileSync(path.join(t.home, "cfg", "easiapiai", "install_id"), "utf-8").trim();
    assert.equal(body.install_id, saved);
    const a = body.answers;
    assert.deepEqual(a.map((x) => x.qid), ["gsm8k-0001", "mmlu-0002", "gsm8k-0003", "gsm8k-0004"]);
    assert.deepEqual(a.map((x) => x.error), [null, "http_429", "http_5xx", "timeout"]);
    assert.equal(a[0].response, "6*7 = 42");
    assert.equal(a[0].output_tokens, 7);
    assert.ok(a.slice(1).every((x) => x.response === "")); // provider error text is never sent
    assert.ok(a.every((x) => Number.isInteger(x.latency_ms) && x.ttft_ms === null));
    assert.deepEqual(Object.keys(a[0]).sort(), ["error", "latency_ms", "output_tokens", "qid", "response", "ttft_ms"]);
    assert.ok(out.includes("Score: 1 of 4 answers agree with the reference answers (3 errors, not graded)."));
    assert.ok(out.includes("Results: https://easiapiai.com/test#test-model"));
  });

  it("refuses to run without a key", async () => {
    t.env.MY_KEY = "  ";
    const { code, err } = await runTest();
    assert.equal(code, 2);
    assert.ok(err.includes("MY_KEY is empty or not set"));
    assert.deepEqual([...api.requests, ...provider.requests], []);
  });

  it("refuses a key passed as the variable name", async () => {
    const { code, out, err } = await runCli(["test", "--model", "m", "--base-url", provider.url, "--provider-model",
      "x", "--seller", "s", "--key-env", KEY, "--api", api.url], t.env);
    assert.equal(code, 2);
    assert.ok(!(out + err).includes(KEY));
    assert.deepEqual([...api.requests, ...provider.requests], []);
  });

  it("refuses to send the key to easiapiai", async () => {
    const { code, err } = await runTest([], { base: api.url + "/v1" });
    assert.equal(code, 2);
    assert.ok(err.includes("points at the easiapiai API"));
    assert.deepEqual(api.requests, []);
  });

  it("a bad key stops before anything is submitted", async () => {
    provider.script = { Q1: ["status", 401] };
    const { code, err } = await runTest();
    assert.equal(code, 1);
    assert.ok(err.includes("HTTP 401"));
    assert.ok(!api.paths().includes("/api/test/submit"));
    assert.ok(!err.includes(KEY));
  });

  it("refuses redirects", async () => {
    const { code, err } = await runTest([], { base: provider.url + "/redirect" });
    assert.equal(code, 1);
    assert.ok(err.includes("HTTP 307"));
    assert.ok(!provider.paths().includes("/capture/chat/completions"));
  });

  it("an answer that is not JSON is an error", async () => {
    provider.script = { Q1: ["ok", "42", 1], Q2: ["junk"] };
    const { code, err } = await runTest([], { n: "2" });
    assert.equal(code, 0, err);
    const a = JSON.parse(api.requests[1].body).answers;
    assert.deepEqual(a.map((x) => x.error), [null, "other"]);
  });

  it("an unknown model shows suggestions", async () => {
    const { code, err } = await runCli(["test", "--model", "nope", "--base-url", provider.url, "--provider-model", "x",
      "--seller", "s", "--key-env", "MY_KEY", "--api", api.url], t.env);
    assert.equal(code, 1);
    assert.ok(err.includes("did you mean Nope 2, Nap?"));
    assert.deepEqual(provider.requests, []);
  });

  it("the install id is kept, and replaced when damaged", () => {
    const d = path.join(t.home, "ids");
    const first = installId(d);
    assert.equal(installId(d), first);
    fs.writeFileSync(path.join(d, "install_id"), "garbage");
    assert.notEqual(installId(d), first);
    // the forms Python's uuid.UUID() accepts are read the same way
    fs.writeFileSync(path.join(d, "install_id"), "{URN:UUID:0123ABCD-0000-4000-8000-00000000000F}\n");
    assert.notEqual(installId(d), "0123abcd-0000-4000-8000-00000000000f"); // "URN:" is case sensitive in Python
    fs.writeFileSync(path.join(d, "install_id"), "urn:uuid:{0123ABCD-0000-4000-8000-00000000000F}\r\n");
    assert.equal(installId(d), "0123abcd-0000-4000-8000-00000000000f");
  });

  it("completions URL", () => {
    assert.equal(completionsUrl("https://x/v1/"), "https://x/v1/chat/completions");
    assert.equal(completionsUrl("https://x/v1/chat/completions"), "https://x/v1/chat/completions");
  });
});

describe("version", () => {
  it("--version", async () => {
    const t = tempEnv();
    const { code, out } = await runCli(["--version"], t.env);
    t.cleanup();
    assert.equal(code, 0);
    assert.equal(out, `easiapiai ${VERSION}\n`);
  });

  it("the same version in package.json and the Python client", () => {
    const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    assert.equal(JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf-8")).version, VERSION);
    const init = path.join(repo, "src", "easiapiai", "__init__.py");
    if (fs.existsSync(init)) assert.ok(fs.readFileSync(init, "utf-8").includes(`__version__ = "${VERSION}"`));
  });
});
