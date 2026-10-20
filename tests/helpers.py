"""Synthetic log fixtures and a fake HTTP server that plays both an OpenAI-compatible provider and the easiapiai
API. No real logs, keys or network."""
import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit


def write_jsonl(path, records):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        for r in records:
            fh.write((r if isinstance(r, str) else json.dumps(r)) + "\n")


def cc_line(mid, rid, model, ts, inp=0, out=0, read=0, w5=None, w1=None, legacy_cw=None, sidechain=False):
    """One Claude Code assistant line, shaped like the real files (only the fields that matter, plus some noise)."""
    usage = {"input_tokens": inp, "output_tokens": out, "cache_read_input_tokens": read,
             "service_tier": "standard"}
    if w5 is not None or w1 is not None:
        usage["cache_creation"] = {"ephemeral_5m_input_tokens": w5 or 0, "ephemeral_1h_input_tokens": w1 or 0}
        usage["cache_creation_input_tokens"] = (w5 or 0) + (w1 or 0)
    elif legacy_cw is not None:
        usage["cache_creation_input_tokens"] = legacy_cw
    msg = {"model": model, "role": "assistant", "type": "message", "usage": usage,
           "content": [{"type": "text", "text": "SECRET CONTENT never to be read"}]}
    if mid:
        msg["id"] = mid
    line = {"type": "assistant", "isSidechain": sidechain, "sessionId": "s-1", "timestamp": ts, "message": msg,
            "cwd": "/home/someone/secret-project"}
    if rid:
        line["requestId"] = rid
    return line


def claude_fixture(home):
    """Builds ~/.claude/projects (+ a sub-agent file, ~/.config/claude/projects and a CLAUDE_CONFIG_DIR folder).
    Returns (CLAUDE_CONFIG_DIR value, expected rows)."""
    sep, octo = "2026-09-15T12:00:00.000Z", "2026-10-15T12:00:00.000Z"
    main = os.path.join(home, ".claude", "projects", "-home-someone-proj", "sess1.jsonl")
    write_jsonl(main, [
        {"type": "user", "timestamp": sep, "message": {"role": "user", "content": "hello assistant"}},
        # one response over three lines (one per content block): output grows; only the last counts
        cc_line("msg_1", "req_1", "claude-sonnet-4-5", sep, inp=10, out=1, read=100, w5=20, w1=0),
        cc_line("msg_1", "req_1", "claude-sonnet-4-5", sep, inp=10, out=5, read=100, w5=20, w1=0),
        cc_line("msg_1", "req_1", "claude-sonnet-4-5", sep, inp=10, out=40, read=100, w5=20, w1=0),
        # an API-error line: skipped
        cc_line("msg_2", "req_2", "<synthetic>", sep, inp=999, out=999),
        # old log: cache writes only as cache_creation_input_tokens -> counted as 5-minute writes
        cc_line("msg_3", "req_3", "claude-sonnet-4-5", sep, inp=3, out=4, read=5, legacy_cw=7),
        # 1-hour cache writes, next month
        cc_line("msg_6", "req_6", "claude-sonnet-4-5", octo, inp=1, out=2, read=3, w5=0, w1=11),
        # no message id: counted on its own
        cc_line(None, None, "claude-sonnet-4-5", octo, inp=100, out=0),
        # an assistant line without usage, a broken line, and a tool result that carries a usage total: ignored
        {"type": "assistant", "timestamp": sep, "message": {"id": "msg_x", "model": "claude-sonnet-4-5"}},
        '{"type": "assistant", "broken',
        {"type": "user", "timestamp": sep, "toolUseResult": {"usage": {"input_tokens": 5000, "output_tokens": 5000}},
         "message": {"role": "user", "content": "assistant said"}},
        # shared with another file, same totals
        cc_line("msg_5", "req_5", "claude-opus-4-1-20250805", sep, inp=50, out=60, read=0, w5=0, w1=0),
    ])
    sub = os.path.join(home, ".claude", "projects", "-home-someone-proj", "sess1", "subagents", "agent-a1.jsonl")
    write_jsonl(sub, [
        cc_line("msg_4", "req_4", "claude-haiku-4-5", sep, inp=7, out=8, read=9, w5=1, w1=2, sidechain=True),
        cc_line("msg_4", "req_4", "claude-haiku-4-5", sep, inp=7, out=18, read=9, w5=1, w1=2, sidechain=True),
    ])
    other = os.path.join(home, ".config", "claude", "projects", "p2", "s2.jsonl")
    write_jsonl(other, [
        # the same response as in sess1, with a smaller (earlier) output: must not count again
        cc_line("msg_1", "req_1", "claude-sonnet-4-5", sep, inp=10, out=5, read=100, w5=20, w1=0),
        cc_line("msg_5", "req_5", "claude-opus-4-1-20250805", sep, inp=50, out=60, read=0, w5=0, w1=0),
    ])
    ccd = os.path.join(home, "alt-claude")
    write_jsonl(os.path.join(ccd, "projects", "p3", "s3.jsonl"), [
        cc_line("msg_7", "req_7", "claude-opus-4-1-20250805", octo, inp=1000, out=2000, read=0, w5=0, w1=0),
    ])
    row = lambda m, mon, i, o, r, a, b: {"model": m, "label": mon, "input_tokens": i, "output_tokens": o,
                                         "cached_input_tokens": r, "cache_write_tokens": a,
                                         "cache_write_1h_tokens": b}
    expected = [
        row("claude-haiku-4-5", "2026-09", 7, 18, 9, 1, 2),
        row("claude-opus-4-1-20250805", "2026-09", 50, 60, 0, 0, 0),
        row("claude-opus-4-1-20250805", "2026-10", 1000, 2000, 0, 0, 0),
        row("claude-sonnet-4-5", "2026-09", 13, 44, 105, 27, 0),
        row("claude-sonnet-4-5", "2026-10", 101, 2, 3, 0, 11),
    ]
    return ccd, expected


def _tu(inp, cached, out, reasoning=0):
    return {"input_tokens": inp, "cached_input_tokens": cached, "output_tokens": out,
            "reasoning_output_tokens": reasoning, "total_tokens": inp + out}


def codex_session(ts_day="2026-09-15"):
    """Records of one Codex rollout file, shaped per the Codex source."""
    t = lambda hh: "%sT%s:00:00.000Z" % (ts_day, hh)
    t1 = _tu(1000, 200, 50, 10)
    t2 = _tu(1500, 600, 80, 15)
    t3 = _tu(1800, 650, 100, 15)
    tc = lambda hh, total, last: {"timestamp": t(hh), "type": "event_msg", "payload": {
        "type": "token_count", "info": None if total is None else dict(
            {"total_token_usage": total, "model_context_window": 272000},
            **({"last_token_usage": last} if last is not None else {})), "rate_limits": None}}
    return [
        {"timestamp": t("10"), "type": "session_meta", "payload": {"id": "abc", "cwd": "/secret"}},
        {"timestamp": t("10"), "type": "turn_context", "payload": {"cwd": "/secret", "model": "gpt-5.1-codex"}},
        {"timestamp": t("10"), "type": "response_item", "payload": {"type": "message", "content": "hi"}},
        tc("10", None, None),                              # info null: nothing
        tc("11", t1, t1),                                  # first call
        tc("11", t1, t1),                                  # repeated event: total unchanged, skip
        tc("12", t2, _tu(500, 400, 30, 5)),                # second call
        {"timestamp": t("13"), "type": "turn_context", "payload": {"model": "gpt-5.2"}},
        tc("14", t3, None),                                # no last_token_usage: use the difference
    ]


CODEX_EXPECTED = [
    # gpt-5.1-codex: (1000-200) + (500-400) input, 200+400 cached, 50+30 output
    {"model": "gpt-5.1-codex", "label": "2026-09", "input_tokens": 900, "output_tokens": 80,
     "cached_input_tokens": 600, "cache_write_tokens": 0, "cache_write_1h_tokens": 0},
    # gpt-5.2: t3 - t2 = 300 input of which 50 cached, 20 output
    {"model": "gpt-5.2", "label": "2026-09", "input_tokens": 250, "output_tokens": 20,
     "cached_input_tokens": 50, "cache_write_tokens": 0, "cache_write_1h_tokens": 0},
]


# ------------------------------------------------------------------ fake HTTP server
QUESTIONS = [
    {"qid": "gsm8k-0001", "kind": "number", "prompt": "Q1: what is 6*7?", "answer": "42"},
    {"qid": "mmlu-0002", "kind": "choice", "prompt": "Q2: pick B", "answer": "B"},
    {"qid": "gsm8k-0003", "kind": "number", "prompt": "Q3: what is 1+1?", "answer": "2"},
    {"qid": "gsm8k-0004", "kind": "number", "prompt": "Q4: what is 2+2?", "answer": "4"},
]


class FakeServer:
    """One local server; .script maps a prompt prefix to the provider's behaviour:
    ("ok", text, completion_tokens) | ("status", code) | ("sleep", seconds) | ("junk",)."""

    def __init__(self):
        self.requests = []
        self.script = {}
        self.submitted = set()
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, obj=None, headers=()):
                body = b"" if obj is None else (obj if isinstance(obj, bytes) else json.dumps(obj).encode())
                try:
                    self.send_response(code)
                    for k, v in headers:
                        self.send_header(k, v)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                except OSError:
                    pass

            def _record(self, body):
                fake.requests.append({"method": self.command, "path": self.path,
                                      "headers": {k.lower(): v for k, v in self.headers.items()}, "body": body})

            def do_GET(self):
                self._record(b"")
                u = urlsplit(self.path)
                if u.path == "/api/test/questions":
                    q = parse_qs(u.query)
                    if q.get("model") == ["nope"]:
                        return self._send(404, {"error": "unknown model 'nope'", "suggestions": ["Nope 2", "Nap"]})
                    n = int(q.get("n", ["10"])[0])
                    return self._send(200, {"run_id": "run-1", "expires": int(time.time()) + 3600,
                                            "model": {"name": "Test Model", "id": "test-model",
                                                      "url": "https://easiapiai.com/m/test-model"},
                                            "questions": [{k: x[k] for k in ("qid", "kind", "prompt")}
                                                          for x in QUESTIONS[:n]],
                                            "instructions": "ask each prompt as one user message"})
                self._send(404, {"error": "not found"})

            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(n)
                self._record(body)
                path = urlsplit(self.path).path
                if path == "/redirect/chat/completions":
                    return self._send(307, {}, [("Location", "/capture/chat/completions")])
                if path.endswith("/chat/completions"):
                    return self._provider(json.loads(body))
                if path == "/api/test/submit":
                    return self._submit(json.loads(body))
                if path == "/api/bill":
                    return self._bill(json.loads(body))
                self._send(404, {"error": "not found"})

            def _provider(self, req):
                prompt = req["messages"][0]["content"]
                act = next((v for k, v in fake.script.items() if prompt.startswith(k)), ("ok", "no idea", 3))
                if act[0] == "sleep":
                    time.sleep(act[1])
                    act = ("ok", "too late", 1)
                if act[0] == "status":
                    return self._send(act[1], {"error": {"message": "Incorrect API key sk-****abcd"}})
                if act[0] == "junk":
                    return self._send(200, b"<html>not json</html>")
                self._send(200, {"id": "c1", "object": "chat.completion", "model": req["model"],
                                 "choices": [{"index": 0, "message": {"role": "assistant", "content": act[1]},
                                              "finish_reason": "stop"}],
                                 "usage": {"prompt_tokens": 9, "completion_tokens": act[2], "total_tokens": 9 + act[2]}})

            def _submit(self, body):
                if body["run_id"] in fake.submitted:
                    return self._send(409, {"error": "this run was already submitted"})
                fake.submitted.add(body["run_id"])
                ans = {q["qid"]: q["answer"] for q in QUESTIONS}
                graded = []
                for a in body["answers"]:
                    if a["error"]:
                        graded.append({"qid": a["qid"], "correct": None})
                        continue
                    nums = re.findall(r"-?\d+(?:\.\d+)?", a["response"].replace(",", ""))
                    graded.append({"qid": a["qid"], "correct": bool(nums) and nums[-1] == ans[a["qid"]]
                                   if ans[a["qid"]].isdigit() else a["response"].strip().endswith(ans[a["qid"]])})
                ok = sum(1 for g in graded if g["correct"])
                errs = sum(1 for g in graded if g["correct"] is None)
                self._send(200, {"graded": graded, "score": {"correct": ok, "total": len(graded), "errors": errs},
                                 "seller_matched": "DeepInfra" if body["seller"].lower() == "deepinfra" else None,
                                 "results_url": "https://easiapiai.com/test#test-model"})

            def _bill(self, body):
                rows, unmatched = [], []
                for u in body["usage"]:
                    if not u["model"].startswith("claude") and not u["model"].startswith("gpt"):
                        unmatched.append({"model": u["model"], "label": u.get("label"), "suggestions": ["GPT-5"]})
                        continue
                    seller = {"seller": "CheapCo", "kind": "standard", "official": False, "verified": True,
                              "complete": True, "total_usd": 1.0, "parts_usd": {}, "notes": [], "url": None}
                    rows.append({"model": {"asked": u["model"], "name": "Name of " + u["model"], "id": u["model"],
                                           "url": "https://easiapiai.com/m/x", "developer": "Dev"},
                                 "label": u.get("label"), "period_days": None, "tokens": {},
                                 "list_price_usd": 3.0, "list_note": "official list price", "cheapest": seller,
                                 "cheapest_any": None, "current": None, "saving_vs_list_usd": 2.0,
                                 "saving_vs_current_usd": None, "sellers": [seller]})
                n = len(rows)
                self._send(200, {"as_of": "2026-10-20T00:00:00Z", "as_of_human": "20 Oct 2026", "currency": "USD",
                                 "rows": rows, "unmatched": unmatched,
                                 "totals": {"rows_with_list_price": n, "at_list_price_usd": 3.0 * n,
                                            "at_cheapest_usd": 1.0 * n if n else None,
                                            "saving_vs_list_usd": 2.0 * n if n else None,
                                            "rows_with_current_seller": 0, "at_current_seller_usd": None},
                                 "source": "https://easiapiai.com/bill"})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.httpd.daemon_threads = True
        self.httpd.handle_error = lambda *a: None
        self.url = "http://127.0.0.1:%d" % self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def paths(self):
        return [r["path"].split("?")[0] for r in self.requests]
