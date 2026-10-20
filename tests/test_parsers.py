import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
sys.path.insert(0, os.path.dirname(__file__))

from easiapiai import claude_code, codex  # noqa: E402
from helpers import CODEX_EXPECTED, claude_fixture, codex_session, write_jsonl  # noqa: E402

REFERENCE = os.path.join(os.path.dirname(__file__), "..", "reference_claude_code_usage.py")


class ClaudeCodeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = self.tmp.name
        self.ccd, self.expected = claude_fixture(self.home)

    def tearDown(self):
        self.tmp.cleanup()

    def dirs(self, ccd=None):
        return claude_code.project_dirs(self.home, {"CLAUDE_CONFIG_DIR": ccd or ""})

    def test_totals_follow_the_verified_rules(self):
        rows, files = claude_code.monthly_totals(self.dirs(self.ccd + ", "))
        self.assertEqual(files, 4)
        self.assertEqual(rows, self.expected)

    def test_config_dir_is_optional(self):
        rows, files = claude_code.monthly_totals(self.dirs())
        self.assertEqual(files, 3)
        self.assertEqual(rows, [r for r in self.expected if r["input_tokens"] != 1000])

    def test_project_dirs(self):
        d = claude_code.project_dirs("/h", {"CLAUDE_CONFIG_DIR": "/a, /b,,/a"})
        self.assertEqual(d, [os.path.join("/h", ".claude", "projects"),
                             os.path.join("/h", ".config", "claude", "projects"),
                             os.path.join("/a", "projects"), os.path.join("/b", "projects")])

    def test_month_of(self):
        self.assertEqual(claude_code.month_of("2026-09-15T12:00:00.000Z"), "2026-09")
        self.assertEqual(claude_code.month_of("2026-09-15T12:00:00.1234567Z"), "2026-09")
        for bad in (None, "", "yesterday", 5):
            self.assertEqual(claude_code.month_of(bad), "unknown")

    def test_malformed_values_do_not_crash(self):
        write_jsonl(os.path.join(self.home, ".claude", "projects", "bad", "b.jsonl"), [
            {"type": "assistant", "message": "not a dict"},
            {"type": "assistant", "timestamp": 7, "message": {"id": "m", "model": "claude-x", "usage": {
                "input_tokens": "12", "output_tokens": None, "cache_creation": "odd"}}},
            ["assistant"],
        ])
        rows, _ = claude_code.monthly_totals(self.dirs())
        self.assertIn({"model": "claude-x", "label": "unknown", "input_tokens": 0, "output_tokens": 0,
                       "cached_input_tokens": 0, "cache_write_tokens": 0, "cache_write_1h_tokens": 0}, rows)

    @unittest.skipUnless(os.path.exists(REFERENCE), "reference script not in this checkout")
    def test_same_as_reference_script(self):
        env = dict(os.environ, HOME=self.home, USERPROFILE=self.home, CLAUDE_CONFIG_DIR=self.ccd)
        out = subprocess.run([sys.executable, REFERENCE], env=env, capture_output=True, text=True, check=True)
        ref = json.loads(out.stdout)
        rows, _ = claude_code.monthly_totals(self.dirs(self.ccd))
        self.assertEqual(ref["usage"], rows)
        self.assertEqual(ref["current_seller"], claude_code.SELLER)


class CodexTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = os.path.join(self.tmp.name, "codexhome")
        name = "rollout-2026-09-15T10-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl"
        write_jsonl(os.path.join(self.home, "sessions", "2026", "09", "15", name), codex_session())
        # the same rollout, archived: identical events count once
        write_jsonl(os.path.join(self.home, "archived_sessions", name), codex_session())

    def tearDown(self):
        self.tmp.cleanup()

    def test_totals(self):
        rows, files, skipped = codex.monthly_totals([self.home])
        self.assertEqual((files, skipped), (2, 0))
        self.assertEqual(rows, CODEX_EXPECTED)

    def test_event_without_model_goes_under_unknown(self):
        recs = [r for r in codex_session("2026-08-01") if r["type"] != "turn_context"]
        write_jsonl(os.path.join(self.home, "sessions", "2026", "08", "01", "rollout-x.jsonl"), recs)
        rows, _, _ = codex.monthly_totals([self.home])
        unknown = [r for r in rows if r["model"] == "unknown"]
        self.assertEqual(len(unknown), 1)
        self.assertEqual(unknown[0]["label"], "2026-08")
        self.assertEqual(unknown[0]["output_tokens"], 100)

    def test_cached_never_exceeds_input(self):
        bad = {"input_tokens": 10, "cached_input_tokens": 50, "output_tokens": 1, "reasoning_output_tokens": 0,
               "total_tokens": 11}
        lines = [json.dumps({"type": "turn_context", "payload": {"model": "m"}}),
                 json.dumps({"timestamp": "2026-09-01T00:00:00Z", "type": "event_msg", "payload": {
                     "type": "token_count", "info": {"total_token_usage": bad, "last_token_usage": bad}}})]
        (ev,) = list(codex.events(lines))
        self.assertEqual(ev[2][:2], (10, 10))

    def test_codex_homes(self):
        self.assertEqual(codex.codex_homes("/h", {}), [os.path.join("/h", ".codex")])
        self.assertEqual(codex.codex_homes("/h", {"CODEX_HOME": "/a, /b"}), ["/a", "/b"])

    def test_zst_rollouts(self):
        z = codex._zstd()
        path = os.path.join(self.home, "sessions", "2026", "07", "01", "rollout-z.jsonl.zst")
        os.makedirs(os.path.dirname(path))
        data = "\n".join(json.dumps(r) for r in codex_session("2026-07-01")).encode()
        if z is None:
            with open(path, "wb") as fh:
                fh.write(b"not really zstd")
            _, files, skipped = codex.monthly_totals([self.home])
            self.assertEqual((files, skipped), (2, 1))
        else:
            with open(path, "wb") as fh:
                fh.write(z.compress(data))
            rows, files, skipped = codex.monthly_totals([self.home])
            self.assertEqual((files, skipped), (3, 0))
            self.assertIn("2026-07", {r["label"] for r in rows})


if __name__ == "__main__":
    unittest.main()
