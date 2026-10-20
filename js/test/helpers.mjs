// Synthetic log fixtures and a fake HTTP server that plays both an OpenAI-compatible provider and the easiapiai
// API. No real logs, keys or network. A port of tests/helpers.py.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "easiapiai.mjs");

export function writeJsonl(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => (typeof r === "string" ? r : JSON.stringify(r)) + "\n").join(""));
}

// One Claude Code assistant line, shaped like the real files (only the fields that matter, plus some noise)
export function ccLine(mid, rid, model, ts, { inp = 0, out = 0, read = 0, w5 = null, w1 = null, legacyCw = null,
  sidechain = false } = {}) {
  const usage = { input_tokens: inp, output_tokens: out, cache_read_input_tokens: read, service_tier: "standard" };
  if (w5 !== null || w1 !== null) {
    usage.cache_creation = { ephemeral_5m_input_tokens: w5 || 0, ephemeral_1h_input_tokens: w1 || 0 };
    usage.cache_creation_input_tokens = (w5 || 0) + (w1 || 0);
  } else if (legacyCw !== null) {
    usage.cache_creation_input_tokens = legacyCw;
  }
  const msg = { model, role: "assistant", type: "message", usage,
    content: [{ type: "text", text: "SECRET CONTENT never to be read" }] };
  if (mid) msg.id = mid;
  const line = { type: "assistant", isSidechain: sidechain, sessionId: "s-1", timestamp: ts, message: msg,
    cwd: "/home/someone/secret-project" };
  if (rid) line.requestId = rid;
  return line;
}

const row = (model, label, i, o, r, a, b) => ({ model, label, input_tokens: i, output_tokens: o,
  cached_input_tokens: r, cache_write_tokens: a, cache_write_1h_tokens: b });

// Builds ~/.claude/projects (+ a sub-agent file, ~/.config/claude/projects and a CLAUDE_CONFIG_DIR folder).
// Returns [CLAUDE_CONFIG_DIR value, expected rows].
export function claudeFixture(home) {
  const sep = "2026-09-15T12:00:00.000Z";
  const octo = "2026-10-15T12:00:00.000Z";
  writeJsonl(path.join(home, ".claude", "projects", "-home-someone-proj", "sess1.jsonl"), [
    { type: "user", timestamp: sep, message: { role: "user", content: "hello assistant" } },
    // one response over three lines (one per content block): output grows; only the last counts
    ccLine("msg_1", "req_1", "claude-sonnet-4-5", sep, { inp: 10, out: 1, read: 100, w5: 20, w1: 0 }),
    ccLine("msg_1", "req_1", "claude-sonnet-4-5", sep, { inp: 10, out: 5, read: 100, w5: 20, w1: 0 }),
    ccLine("msg_1", "req_1", "claude-sonnet-4-5", sep, { inp: 10, out: 40, read: 100, w5: 20, w1: 0 }),
    // an API-error line: skipped
    ccLine("msg_2", "req_2", "<synthetic>", sep, { inp: 999, out: 999 }),
    // old log: cache writes only as cache_creation_input_tokens -> counted as 5-minute writes
    ccLine("msg_3", "req_3", "claude-sonnet-4-5", sep, { inp: 3, out: 4, read: 5, legacyCw: 7 }),
    // 1-hour cache writes, next month
    ccLine("msg_6", "req_6", "claude-sonnet-4-5", octo, { inp: 1, out: 2, read: 3, w5: 0, w1: 11 }),
    // no message id: counted on its own
    ccLine(null, null, "claude-sonnet-4-5", octo, { inp: 100, out: 0 }),
    // an assistant line without usage, a broken line, and a tool result that carries a usage total: ignored
    { type: "assistant", timestamp: sep, message: { id: "msg_x", model: "claude-sonnet-4-5" } },
    '{"type": "assistant", "broken',
    { type: "user", timestamp: sep, toolUseResult: { usage: { input_tokens: 5000, output_tokens: 5000 } },
      message: { role: "user", content: "assistant said" } },
    // shared with another file, same totals
    ccLine("msg_5", "req_5", "claude-opus-4-1-20250805", sep, { inp: 50, out: 60, read: 0, w5: 0, w1: 0 }),
  ]);
  writeJsonl(path.join(home, ".claude", "projects", "-home-someone-proj", "sess1", "subagents", "agent-a1.jsonl"), [
    ccLine("msg_4", "req_4", "claude-haiku-4-5", sep, { inp: 7, out: 8, read: 9, w5: 1, w1: 2, sidechain: true }),
    ccLine("msg_4", "req_4", "claude-haiku-4-5", sep, { inp: 7, out: 18, read: 9, w5: 1, w1: 2, sidechain: true }),
  ]);
  writeJsonl(path.join(home, ".config", "claude", "projects", "p2", "s2.jsonl"), [
    // the same response as in sess1, with a smaller (earlier) output: must not count again
    ccLine("msg_1", "req_1", "claude-sonnet-4-5", sep, { inp: 10, out: 5, read: 100, w5: 20, w1: 0 }),
    ccLine("msg_5", "req_5", "claude-opus-4-1-20250805", sep, { inp: 50, out: 60, read: 0, w5: 0, w1: 0 }),
  ]);
  const ccd = path.join(home, "alt-claude");
  writeJsonl(path.join(ccd, "projects", "p3", "s3.jsonl"), [
    ccLine("msg_7", "req_7", "claude-opus-4-1-20250805", octo, { inp: 1000, out: 2000, read: 0, w5: 0, w1: 0 }),
  ]);
  const expected = [
    row("claude-haiku-4-5", "2026-09", 7, 18, 9, 1, 2),
    row("claude-opus-4-1-20250805", "2026-09", 50, 60, 0, 0, 0),
    row("claude-opus-4-1-20250805", "2026-10", 1000, 2000, 0, 0, 0),
    row("claude-sonnet-4-5", "2026-09", 13, 44, 105, 27, 0),
    row("claude-sonnet-4-5", "2026-10", 101, 2, 3, 0, 11),
  ];
  return [ccd, expected];
}

function tu(inp, cached, out, reasoning = 0) {
  return { input_tokens: inp, cached_input_tokens: cached, output_tokens: out, reasoning_output_tokens: reasoning,
    total_tokens: inp + out };
}

// Records of one Codex rollout file, shaped per the Codex source
export function codexSession(day = "2026-09-15") {
  const t = (hh) => `${day}T${hh}:00:00.000Z`;
  const t1 = tu(1000, 200, 50, 10);
  const t2 = tu(1500, 600, 80, 15);
  const t3 = tu(1800, 650, 100, 15);
  const tc = (hh, total, last) => ({ timestamp: t(hh), type: "event_msg", payload: {
    type: "token_count", info: total === null ? null : { total_token_usage: total, model_context_window: 272000,
      ...(last !== null ? { last_token_usage: last } : {}) }, rate_limits: null } });
  return [
    { timestamp: t("10"), type: "session_meta", payload: { id: "abc", cwd: "/secret" } },
    { timestamp: t("10"), type: "turn_context", payload: { cwd: "/secret", model: "gpt-5.1-codex" } },
    { timestamp: t("10"), type: "response_item", payload: { type: "message", content: "hi" } },
    tc("10", null, null), // info null: nothing
    tc("11", t1, t1), // first call
    tc("11", t1, t1), // repeated event: total unchanged, skip
    tc("12", t2, tu(500, 400, 30, 5)), // second call
    { timestamp: t("13"), type: "turn_context", payload: { model: "gpt-5.2" } },
    tc("14", t3, null), // no last_token_usage: use the difference
  ];
}

export const CODEX_EXPECTED = [
  // gpt-5.1-codex: (1000-200) + (500-400) input, 200+400 cached, 50+30 output
  row("gpt-5.1-codex", "2026-09", 900, 80, 600, 0, 0),
  // gpt-5.2: t3 - t2 = 300 input of which 50 cached, 20 output
  row("gpt-5.2", "2026-09", 250, 20, 50, 0, 0),
];

// ------------------------------------------------------------------ fake HTTP server

export const QUESTIONS = [
  { qid: "gsm8k-0001", kind: "number", prompt: "Q1: what is 6*7?", answer: "42" },
  { qid: "mmlu-0002", kind: "choice", prompt: "Q2: pick B", answer: "B" },
  { qid: "gsm8k-0003", kind: "number", prompt: "Q3: what is 1+1?", answer: "2" },
  { qid: "gsm8k-0004", kind: "number", prompt: "Q4: what is 2+2?", answer: "4" },
];

// One local server; .script maps a prompt prefix to the provider's behaviour:
// ["ok", text, completion_tokens] | ["status", code] | ["sleep", seconds] | ["junk"].
// .overrides maps a path to canned answers [{status, headers, body, delay}], used in turn (the last one repeats).
export class FakeServer {
  constructor() {
    this.requests = [];
    this.script = {};
    this.submitted = new Set();
    this.overrides = {};
    this.server = http.createServer((req, res) => {
      const parts = [];
      req.on("data", (c) => parts.push(c));
      req.on("end", () => {
        const body = Buffer.concat(parts);
        this.requests.push({ method: req.method, path: req.url, headers: { ...req.headers }, body });
        this.handle(req, res, body);
      });
    });
  }

  async start() {
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${this.server.address().port}`;
    return this;
  }

  async close() {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  paths() {
    return this.requests.map((r) => r.path.split("?")[0]);
  }

  send(res, code, obj = null, headers = {}) {
    const body = obj === null ? Buffer.alloc(0) : Buffer.isBuffer(obj) ? obj : Buffer.from(JSON.stringify(obj));
    try {
      res.writeHead(code, { ...headers, "Content-Type": "application/json", "Content-Length": body.length });
      res.end(body);
    } catch {
      // the client went away
    }
  }

  handle(req, res, body) {
    const u = new URL(req.url, "http://x");
    const canned = this.overrides[u.pathname];
    if (canned && canned.length) {
      const c = canned.length > 1 ? canned.shift() : canned[0];
      const reply = () => {
        if (c.destroy) {
          res.writeHead(200, { "Content-Length": 100 });
          res.write("{\"partial\":");
          res.destroy();
          return;
        }
        this.send(res, c.status ?? 200, typeof c.body === "string" ? Buffer.from(c.body) : c.body ?? {}, c.headers);
      };
      if (c.delay) setTimeout(reply, c.delay * 1000);
      else reply();
      return;
    }
    if (req.method === "GET") {
      if (u.pathname === "/api/test/questions") {
        if (u.searchParams.get("model") === "nope") {
          return this.send(res, 404, { error: "unknown model 'nope'", suggestions: ["Nope 2", "Nap"] });
        }
        const n = Number(u.searchParams.get("n") ?? "10");
        return this.send(res, 200, { run_id: "run-1", expires: Math.floor(Date.now() / 1000) + 3600,
          model: { name: "Test Model", id: "test-model", url: "https://easiapiai.com/m/test-model" },
          questions: QUESTIONS.slice(0, n).map(({ qid, kind, prompt }) => ({ qid, kind, prompt })),
          instructions: "ask each prompt as one user message" });
      }
      return this.send(res, 404, { error: "not found" });
    }
    if (u.pathname === "/redirect/chat/completions") {
      return this.send(res, 307, {}, { Location: "/capture/chat/completions" });
    }
    if (u.pathname.endsWith("/chat/completions")) return this.provider(res, JSON.parse(body));
    if (u.pathname === "/api/test/submit") return this.submit(res, JSON.parse(body));
    if (u.pathname === "/api/bill") return this.bill(res, JSON.parse(body));
    return this.send(res, 404, { error: "not found" });
  }

  provider(res, req) {
    const prompt = req.messages[0].content;
    const key = Object.keys(this.script).find((k) => prompt.startsWith(k));
    let act = key !== undefined ? this.script[key] : ["ok", "no idea", 3];
    const answer = (a) => {
      if (a[0] === "status") return this.send(res, a[1], { error: { message: "Incorrect API key sk-****abcd" } });
      if (a[0] === "junk") return this.send(res, 200, Buffer.from("<html>not json</html>"));
      return this.send(res, 200, { id: "c1", object: "chat.completion", model: req.model,
        choices: [{ index: 0, message: { role: "assistant", content: a[1] }, finish_reason: "stop" }],
        usage: { prompt_tokens: 9, completion_tokens: a[2], total_tokens: 9 + a[2] } });
    };
    if (act[0] === "sleep") {
      const seconds = act[1];
      act = ["ok", "too late", 1];
      setTimeout(() => answer(act), seconds * 1000);
      return undefined;
    }
    return answer(act);
  }

  submit(res, body) {
    if (this.submitted.has(body.run_id)) return this.send(res, 409, { error: "this run was already submitted" });
    this.submitted.add(body.run_id);
    const answers = Object.fromEntries(QUESTIONS.map((q) => [q.qid, q.answer]));
    const graded = body.answers.map((a) => {
      if (a.error) return { qid: a.qid, correct: null };
      const ref = answers[a.qid];
      const nums = a.response.replaceAll(",", "").match(/-?\d+(?:\.\d+)?/g);
      const correct = /^\d+$/.test(ref) ? Boolean(nums) && nums[nums.length - 1] === ref : a.response.trim().endsWith(ref);
      return { qid: a.qid, correct };
    });
    const ok = graded.filter((g) => g.correct).length;
    const errors = graded.filter((g) => g.correct === null).length;
    return this.send(res, 200, { graded, score: { correct: ok, total: graded.length, errors },
      seller_matched: body.seller.toLowerCase() === "deepinfra" ? "DeepInfra" : null,
      results_url: "https://easiapiai.com/test#test-model" });
  }

  bill(res, body) {
    const rows = [];
    const unmatched = [];
    for (const u of body.usage) {
      if (!u.model.startsWith("claude") && !u.model.startsWith("gpt")) {
        unmatched.push({ model: u.model, label: u.label, suggestions: ["GPT-5"] });
        continue;
      }
      const seller = { seller: "CheapCo", kind: "standard", official: false, verified: true, complete: true,
        total_usd: 1.0, parts_usd: {}, notes: [], url: null };
      rows.push({ model: { asked: u.model, name: "Name of " + u.model, id: u.model, url: "https://easiapiai.com/m/x",
        developer: "Dev" }, label: u.label, period_days: null, tokens: {}, list_price_usd: 3.0,
      list_note: "official list price", cheapest: seller, cheapest_any: null, current: null, saving_vs_list_usd: 2.0,
      saving_vs_current_usd: null, sellers: [seller] });
    }
    const n = rows.length;
    return this.send(res, 200, { as_of: "2026-10-20T00:00:00Z", as_of_human: "20 Oct 2026", currency: "USD", rows,
      unmatched, totals: { rows_with_list_price: n, at_list_price_usd: 3.0 * n, at_cheapest_usd: n ? 1.0 * n : null,
        saving_vs_list_usd: n ? 2.0 * n : null, rows_with_current_seller: 0, at_current_seller_usd: null },
      source: "https://easiapiai.com/bill" });
  }
}

// A temporary HOME (and config dir), with no CLAUDE_CONFIG_DIR / CODEX_HOME from the real environment
export function tempEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "easiapiai-test-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, "cfg") };
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "COLUMNS", "ANTHROPIC_BASE_URL", "OPENROUTER_MANAGEMENT_KEY",
    "EASIAPIAI_API", "EASIAPIAI_CONFIG_DIR", "EASIAPIAI_DEBUG", "XDG_DATA_HOME", "CLINE_DATA_DIR"]) delete env[k];
  return { home, env, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

// Runs the command line in a child process: {code, out, err}
export function runCli(argv, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...argv], { env, stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("close", (code) => resolve({
      code, out: Buffer.concat(out).toString("utf-8"), err: Buffer.concat(err).toString("utf-8"),
    }));
  });
}
