// The log readers and the Python-compatible helpers. A port of tests/test_parsers.py, plus the pieces the Node
// client had to write out itself (number formatting, repr, json.dumps, line reading, ISO timestamps, zstd frames).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import zlib from "node:zlib";

import * as claudeCode from "../claude_code.mjs";
import * as codex from "../codex.mjs";
import { CAN_ZSTD, textLines } from "../files.mjs";
import { fromIsoFormat, monthOf } from "../isotime.mjs";
import { formatFixed, jsonDumps, pyRepr, pyStr, reprStr } from "../py.mjs";
import { CODEX_EXPECTED, claudeFixture, codexSession, tempEnv, writeJsonl } from "./helpers.mjs";

describe("Claude Code", () => {
  let t;
  let ccd;
  let expected;
  beforeEach(() => {
    t = tempEnv();
    [ccd, expected] = claudeFixture(t.home);
  });
  afterEach(() => t.cleanup());
  const dirs = (configDir = "") => claudeCode.projectDirs(t.home, { CLAUDE_CONFIG_DIR: configDir });

  it("totals follow the verified rules", () => {
    const [rows, files] = claudeCode.monthlyTotals(dirs(ccd + ", "));
    assert.equal(files, 4);
    assert.deepEqual(rows, expected);
  });

  it("CLAUDE_CONFIG_DIR is optional", () => {
    const [rows, files] = claudeCode.monthlyTotals(dirs());
    assert.equal(files, 3);
    assert.deepEqual(rows, expected.filter((r) => r.input_tokens !== 1000));
  });

  it("project folders", () => {
    const s = path.sep;
    assert.deepEqual(claudeCode.projectDirs("/h", { CLAUDE_CONFIG_DIR: "/a, /b,,/a" }),
      [`/h${s}.claude${s}projects`, `/h${s}.config${s}claude${s}projects`, `/a${s}projects`, `/b${s}projects`]);
  });

  it("month_of", () => {
    assert.equal(monthOf("2026-09-15T12:00:00.000Z"), "2026-09");
    assert.equal(monthOf("2026-09-15T12:00:00.1234567Z"), "2026-09");
    for (const bad of [null, "", "yesterday", 5]) assert.equal(monthOf(bad), "unknown");
  });

  it("malformed values do not crash", () => {
    writeJsonl(path.join(t.home, ".claude", "projects", "bad", "b.jsonl"), [
      { type: "assistant", message: "not a dict" },
      { type: "assistant", timestamp: 7, message: { id: "m", model: "claude-x", usage: {
        input_tokens: "12", output_tokens: null, cache_creation: "odd" } } },
      ["assistant"],
    ]);
    const [rows] = claudeCode.monthlyTotals(dirs());
    assert.deepEqual(rows.find((r) => r.model === "claude-x"), { model: "claude-x", label: "unknown",
      input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0, cache_write_1h_tokens: 0 });
  });

  it("ids compare as Python tuples do (True == 1 == 1.0, '1' is different)", () => {
    assert.equal(claudeCode.keyPart(true), claudeCode.keyPart(1));
    assert.equal(claudeCode.keyPart(1.0), claudeCode.keyPart(1));
    assert.notEqual(claudeCode.keyPart("1"), claudeCode.keyPart(1));
    assert.throws(() => claudeCode.keyPart(["x"]), TypeError);
  });
});

describe("Codex", () => {
  let t;
  let home;
  const name = "rollout-2026-09-15T10-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl";
  beforeEach(() => {
    t = tempEnv();
    home = path.join(t.home, "codexhome");
    writeJsonl(path.join(home, "sessions", "2026", "09", "15", name), codexSession());
    // the same rollout, archived: identical events count once
    writeJsonl(path.join(home, "archived_sessions", name), codexSession());
  });
  afterEach(() => t.cleanup());

  it("totals", () => {
    const [rows, files, skipped] = codex.monthlyTotals([home]);
    assert.deepEqual([files, skipped], [2, 0]);
    assert.deepEqual(rows, CODEX_EXPECTED);
  });

  it("an event without a model goes under 'unknown'", () => {
    const recs = codexSession("2026-08-01").filter((r) => r.type !== "turn_context");
    writeJsonl(path.join(home, "sessions", "2026", "08", "01", "rollout-x.jsonl"), recs);
    const [rows] = codex.monthlyTotals([home]);
    const unknown = rows.filter((r) => r.model === "unknown");
    assert.equal(unknown.length, 1);
    assert.equal(unknown[0].label, "2026-08");
    assert.equal(unknown[0].output_tokens, 100);
  });

  it("cached never exceeds input", () => {
    const bad = { input_tokens: 10, cached_input_tokens: 50, output_tokens: 1, reasoning_output_tokens: 0,
      total_tokens: 11 };
    const lines = [JSON.stringify({ type: "turn_context", payload: { model: "m" } }),
      JSON.stringify({ timestamp: "2026-09-01T00:00:00Z", type: "event_msg", payload: {
        type: "token_count", info: { total_token_usage: bad, last_token_usage: bad } } })];
    const evs = [...codex.events(lines)];
    assert.equal(evs.length, 1);
    assert.deepEqual(evs[0][2].slice(0, 2), [10, 10]);
  });

  it("CODEX_HOME", () => {
    assert.deepEqual(codex.codexHomes("/h", {}), [`/h${path.sep}.codex`]);
    assert.deepEqual(codex.codexHomes("/h", { CODEX_HOME: "/a, /b" }), ["/a", "/b"]);
  });

  it(".zst rollouts: read when Node.js has zstd, else skipped with a count", () => {
    const file = path.join(home, "sessions", "2026", "07", "01", "rollout-z.jsonl.zst");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const data = Buffer.from(codexSession("2026-07-01").map((r) => JSON.stringify(r)).join("\n"));
    if (!CAN_ZSTD) {
      fs.writeFileSync(file, "not really zstd");
      const [, files, skipped] = codex.monthlyTotals([home]);
      assert.deepEqual([files, skipped], [2, 1]);
    } else {
      fs.writeFileSync(file, zlib.zstdCompressSync(data));
      const [rows, files, skipped] = codex.monthlyTotals([home]);
      assert.deepEqual([files, skipped], [3, 0]);
      assert.ok(rows.some((r) => r.label === "2026-07"));
    }
    assert.deepEqual(codex.rolloutFiles([home], false)[1], 1);
  });

  it("a .zst file of several frames is read whole", { skip: !CAN_ZSTD && "no zstd in this Node.js" }, () => {
    const lines = codexSession("2026-06-01").map((r) => JSON.stringify(r) + "\n");
    const file = path.join(home, "sessions", "rollout-frames.jsonl.zst");
    fs.writeFileSync(file, Buffer.concat([zlib.zstdCompressSync(Buffer.from(lines.slice(0, 5).join(""))),
      zlib.zstdCompressSync(Buffer.from(lines.slice(5).join(""))), Buffer.from("trailing garbage")]));
    const [rows] = codex.monthlyTotals([home]);
    assert.deepEqual(rows.filter((r) => r.label === "2026-06").map((r) => r.input_tokens), [900, 250]);
  });
});

describe("Python-compatible helpers", () => {
  it("formats numbers like Python, halves to even", () => {
    assert.equal(formatFixed(0.125, 2), "0.12");
    assert.equal(formatFixed(0.375, 2), "0.38");
    assert.equal(formatFixed(2.5, 0), "2");
    assert.equal(formatFixed(1.005, 2), "1.00");
    assert.equal(formatFixed(1234567.891, 2), "1,234,567.89");
    assert.equal(formatFixed(-0.25, 1), "-0.2");
    assert.equal(formatFixed(1e21, 2), "1,000,000,000,000,000,000,000.00");
  });

  it("str() and repr()", () => {
    assert.equal(reprStr("it's"), "\"it's\"");
    assert.equal(reprStr("a'\"b"), "'a\\'\"b'");
    assert.equal(reprStr("tab\there é​"), "'tab\\there\\xa0é\\u200b'");
    assert.equal(pyStr(null), "None");
    assert.equal(pyStr(1.5e-5), "1.5e-05");
    assert.equal(pyStr(0.0001), "0.0001");
    assert.equal(pyStr(["a", 1, true]), "['a', 1, True]");
    assert.equal(pyRepr({ k: null }), "{'k': None}");
  });

  it("json.dumps with ensure_ascii", () => {
    assert.equal(jsonDumps({ a: [1, "é😀\u007f"], b: {} }), '{"a": [1, "\\u00e9\\ud83d\\ude00\\u007f"], "b": {}}');
    assert.equal(jsonDumps({ a: [] , b: [1] }, 1), '{\n "a": [],\n "b": [\n  1\n ]\n}');
  });

  it("reads lines as Python does: universal newlines, BOM kept, bad bytes replaced", () => {
    // a "\r\n" and a "€" each split between two reads, an invalid byte, no newline at the end
    const chunks = [Buffer.from("﻿one\r"), Buffer.concat([Buffer.from("\ntwo\rthree\n"), Buffer.from([0xff])]),
      Buffer.from([0xe2, 0x82]), Buffer.from([0xac, 0x0a, 0x6c, 0x61, 0x73, 0x74])];
    assert.deepEqual([...textLines(chunks)], ["﻿one\n", "two\n", "three\n", "�€\n", "last"]);
  });

  it("parses ISO timestamps as CPython's C fromisoformat does", () => {
    const parts = (s) => {
      const d = fromIsoFormat(s);
      return d && [d.year, d.month, d.day, d.h, d.m, d.s, d.us, d.offset];
    };
    assert.deepEqual(parts("2026-09-15T12:00:00.+05"), [2026, 9, 15, 12, 0, 0, 0, [18000, 0]]);
    assert.deepEqual(parts("2026-09-15é12:00:00"), [2026, 9, 15, 12, 0, 0, 0, null]);
    assert.deepEqual(parts("2026-W38-2T12"), [2026, 9, 15, 12, 0, 0, 0, null]);
    assert.deepEqual(parts("2026-09-15T24:00"), [2026, 9, 16, 0, 0, 0, 0, null]);
    for (const bad of ["2026-09-15T", "2026-09", "2026-09-15T12:00:00Z+05", "2026-02-29"]) {
      assert.equal(fromIsoFormat(bad), null, bad);
    }
  });
});
