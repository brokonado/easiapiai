import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
sys.path.insert(0, os.path.dirname(__file__))

from easiapiai import CLIENT, cli, test_runner  # noqa: E402
from helpers import (CODEX_EXPECTED, FakeServer, claude_fixture, cc_line, codex_session,  # noqa: E402
                     write_jsonl)

KEY = "sk-test-0123456789abcdef-SECRET"


def run_cli(argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = cli.main(argv)
    return code, out.getvalue(), err.getvalue()


class Env(unittest.TestCase):
    """A temporary HOME (and config dir), with no CLAUDE_CONFIG_DIR / CODEX_HOME from the real environment."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = self.tmp.name
        env = {k: v for k, v in os.environ.items() if k not in ("CLAUDE_CONFIG_DIR", "CODEX_HOME")}
        env.update(HOME=self.home, USERPROFILE=self.home, XDG_CONFIG_HOME=os.path.join(self.home, "cfg"))
        self.env = mock.patch.dict(os.environ, env, clear=True)
        self.env.start()
        self.api = FakeServer()

    def tearDown(self):
        self.api.close()
        self.env.stop()
        self.tmp.cleanup()


class BillTest(Env):
    def setUp(self):
        super().setUp()
        self.ccd, self.expected = claude_fixture(self.home)
        os.environ["CLAUDE_CONFIG_DIR"] = self.ccd

    def bodies(self):
        return [json.loads(r["body"]) for r in self.api.requests if r["path"] == "/api/bill"]

    def test_table_first_then_send_then_prices(self):
        code, out, err = run_cli(["bill", "--api", self.api.url])
        self.assertEqual(code, 0, err)
        self.assertLess(out.index("Claude Code usage on this computer"), out.index("Sending the Claude Code totals"))
        self.assertLess(out.index("Sending"), out.index("cheapest verified seller: CheapCo $1.00"))
        self.assertIn("saves $2.00", out)
        self.assertIn("Total at list prices $15.00", out)
        (body,) = self.bodies()
        self.assertEqual(body, {"usage": self.expected, "current_seller": "Anthropic"})

    def test_nothing_but_totals_is_sent(self):
        run_cli(["bill", "--api", self.api.url])
        raw = b"".join(r["body"] for r in self.api.requests)
        for leak in (b"SECRET CONTENT", b"secret-project", b"msg_1", b"req_1", b"s-1", self.home.encode()):
            self.assertNotIn(leak, raw)

    def test_dry_run_and_json_send_nothing(self):
        code, out, _ = run_cli(["bill", "--dry-run", "--api", self.api.url])
        self.assertEqual(code, 0)
        self.assertIn("Dry run: nothing was sent.", out)
        code, out, _ = run_cli(["bill", "--json", "--seller", "OpenRouter", "--api", self.api.url])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), {"claude_code": {"usage": self.expected, "current_seller": "OpenRouter"}})
        self.assertEqual(self.api.requests, [])

    def test_codex_is_sent_separately_and_flagged_experimental(self):
        os.environ["CODEX_HOME"] = os.path.join(self.home, "cx")
        write_jsonl(os.path.join(self.home, "cx", "sessions", "2026", "09", "15", "rollout-a.jsonl"),
                    codex_session())
        code, out, err = run_cli(["bill", "--codex", "--api", self.api.url])
        self.assertEqual(code, 0, err)
        self.assertIn("EXPERIMENTAL", err)
        self.assertIn("Codex usage on this computer", out)
        cc, cx = self.bodies()
        self.assertEqual(cc["current_seller"], "Anthropic")
        self.assertEqual(cx, {"usage": CODEX_EXPECTED, "current_seller": "OpenAI"})

    def test_unmatched_models_get_suggestions(self):
        write_jsonl(os.path.join(self.home, ".claude", "projects", "p9", "x.jsonl"),
                    [cc_line("m9", "r9", "mystery-model", "2026-09-15T12:00:00.000Z", inp=1, out=1)])
        code, out, _ = run_cli(["bill", "--api", self.api.url])
        self.assertEqual(code, 0)
        self.assertIn("Not priced: 'mystery-model' (2026-09) is not a model on easiapiai.com; did you mean GPT-5?",
                      out)

    def test_more_than_60_rows_are_split(self):
        write_jsonl(os.path.join(self.home, ".claude", "projects", "many", "m.jsonl"),
                    [cc_line("m%d" % i, "r", "claude-m%02d" % i, "2026-09-15T12:00:00.000Z", inp=1, out=1)
                     for i in range(70)])
        code, out, err = run_cli(["bill", "--api", self.api.url])
        self.assertEqual(code, 0, err)
        sizes = [len(b["usage"]) for b in self.bodies()]
        self.assertEqual(sizes, [60, 15])
        self.assertIn("Total at list prices $225.00", out)

    def test_api_error_is_reported(self):
        code, _, err = run_cli(["bill", "--api", "http://127.0.0.1:9"])
        self.assertEqual(code, 1)
        self.assertIn("could not reach", err)

    def test_no_logs(self):
        os.environ["HOME"] = os.environ["USERPROFILE"] = os.path.join(self.home, "empty")
        del os.environ["CLAUDE_CONFIG_DIR"]
        code, _, err = run_cli(["bill", "--api", self.api.url])
        self.assertEqual(code, 1)
        self.assertIn("No Claude Code usage found", err)
        self.assertEqual(self.api.requests, [])


class TestCommand(Env):
    def setUp(self):
        super().setUp()
        self.provider = FakeServer()
        os.environ["MY_KEY"] = KEY

    def tearDown(self):
        self.provider.close()
        super().tearDown()

    def run_test(self, *extra, base=None, n="4"):
        return run_cli(["test", "--model", "test-model", "--base-url", base or self.provider.url + "/v1",
                        "--provider-model", "org/test-model-fp8", "--seller", "DeepInfra", "--key-env", "MY_KEY",
                        "-n", n, "--api", self.api.url, "--timeout", "0.5"] + list(extra))

    def assert_key_never_left_for(self, server):
        for r in server.requests:
            self.assertNotIn(KEY, json.dumps(r["headers"]))
            self.assertNotIn(KEY.encode(), r["body"])

    def test_full_run_maps_errors_and_submits(self):
        self.provider.script = {"Q1": ("ok", "6*7 = 42", 7), "Q2": ("status", 429), "Q3": ("status", 503),
                                "Q4": ("sleep", 1.5)}
        code, out, err = self.run_test("--official")
        self.assertEqual(code, 0, err)
        # the provider got the key, in the header, with the OpenAI-compatible body
        prov = [r for r in self.provider.requests if r["path"] == "/v1/chat/completions"]
        self.assertEqual(len(prov), 4)
        self.assertEqual(prov[0]["headers"]["authorization"], "Bearer " + KEY)
        self.assertEqual(json.loads(prov[0]["body"]), {
            "model": "org/test-model-fp8", "messages": [{"role": "user", "content": "Q1: what is 6*7?"}],
            "temperature": 0, "max_tokens": 2048})
        # easiapiai never did
        self.assertEqual(self.api.paths(), ["/api/test/questions", "/api/test/submit"])
        self.assert_key_never_left_for(self.api)
        self.assertNotIn(KEY, out + err)
        body = json.loads(self.api.requests[1]["body"])
        self.assertEqual(body["run_id"], "run-1")
        self.assertEqual(body["seller"], "DeepInfra")
        self.assertEqual(body["base_url_host"], "127.0.0.1")
        self.assertEqual(body["model_requested"], "org/test-model-fp8")
        self.assertIs(body["official"], True)
        self.assertEqual(body["client"], CLIENT)
        with open(os.path.join(self.home, "cfg", "easiapiai", "install_id")) as fh:
            self.assertEqual(body["install_id"], fh.read().strip())
        a = body["answers"]
        self.assertEqual([x["qid"] for x in a], ["gsm8k-0001", "mmlu-0002", "gsm8k-0003", "gsm8k-0004"])
        self.assertEqual([x["error"] for x in a], [None, "http_429", "http_5xx", "timeout"])
        self.assertEqual(a[0]["response"], "6*7 = 42")
        self.assertEqual(a[0]["output_tokens"], 7)
        self.assertTrue(all(x["response"] == "" for x in a[1:]))  # provider error text is never sent
        self.assertTrue(all(isinstance(x["latency_ms"], int) and x["ttft_ms"] is None for x in a))
        self.assertEqual(set(a[0]), {"qid", "response", "latency_ms", "ttft_ms", "output_tokens", "error"})
        self.assertIn("Score: 1 of 4 answers agree with the reference answers (3 errors, not graded).", out)
        self.assertIn("Results: https://easiapiai.com/test#test-model", out)

    def test_refuses_without_key(self):
        os.environ["MY_KEY"] = "  "
        code, _, err = self.run_test()
        self.assertEqual(code, 2)
        self.assertIn("MY_KEY is empty or not set", err)
        self.assertEqual(self.api.requests + self.provider.requests, [])

    def test_refuses_a_key_passed_as_the_variable_name(self):
        code, out, err = run_cli(["test", "--model", "m", "--base-url", self.provider.url, "--provider-model", "x",
                                  "--seller", "s", "--key-env", KEY, "--api", self.api.url])
        self.assertEqual(code, 2)
        self.assertNotIn(KEY, out + err)
        self.assertEqual(self.api.requests + self.provider.requests, [])

    def test_refuses_to_send_the_key_to_easiapiai(self):
        code, _, err = self.run_test(base=self.api.url + "/v1")
        self.assertEqual(code, 2)
        self.assertIn("points at the easiapiai API", err)
        self.assertEqual(self.api.requests, [])

    def test_bad_key_stops_before_anything_is_submitted(self):
        self.provider.script = {"Q1": ("status", 401)}
        code, _, err = self.run_test()
        self.assertEqual(code, 1)
        self.assertIn("HTTP 401", err)
        self.assertNotIn("/api/test/submit", self.api.paths())
        self.assertNotIn(KEY, err)

    def test_redirects_are_refused(self):
        code, _, err = self.run_test(base=self.provider.url + "/redirect")
        self.assertEqual(code, 1)
        self.assertIn("HTTP 307", err)
        self.assertNotIn("/capture/chat/completions", self.provider.paths())

    def test_non_json_answer_is_an_error(self):
        self.provider.script = {"Q1": ("ok", "42", 1), "Q2": ("junk",)}
        code, _, err = self.run_test(n="2")
        self.assertEqual(code, 0, err)
        a = json.loads(self.api.requests[1]["body"])["answers"]
        self.assertEqual([x["error"] for x in a], [None, "other"])

    def test_unknown_model_shows_suggestions(self):
        code, _, err = run_cli(["test", "--model", "nope", "--base-url", self.provider.url, "--provider-model", "x",
                                "--seller", "s", "--key-env", "MY_KEY", "--api", self.api.url])
        self.assertEqual(code, 1)
        self.assertIn("did you mean Nope 2, Nap?", err)
        self.assertEqual(self.provider.requests, [])

    def test_install_id_is_kept_and_repaired(self):
        d = os.path.join(self.home, "ids")
        first = test_runner.install_id(d)
        self.assertEqual(test_runner.install_id(d), first)
        with open(os.path.join(d, "install_id"), "w") as fh:
            fh.write("garbage")
        self.assertNotEqual(test_runner.install_id(d), first)

    def test_completions_url(self):
        self.assertEqual(test_runner.completions_url("https://x/v1/"), "https://x/v1/chat/completions")
        self.assertEqual(test_runner.completions_url("https://x/v1/chat/completions"),
                         "https://x/v1/chat/completions")


class VersionTest(unittest.TestCase):
    def test_version(self):
        with self.assertRaises(SystemExit) as cm:
            run_cli(["--version"])
        self.assertEqual(cm.exception.code, 0)


if __name__ == "__main__":
    unittest.main()
