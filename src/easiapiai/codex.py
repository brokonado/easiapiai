"""Codex CLI token usage per model and month. EXPERIMENTAL.

These rules come from the Codex source code (openai/codex) and the open-source ccusage; they have NOT yet been
checked against real Codex log files. Reports that compare these totals with Codex's own numbers are welcome.

- files: $CODEX_HOME (a comma-separated list is allowed) or ~/.codex; sessions/**/rollout-*.jsonl and
  archived_sessions/**/rollout-*.jsonl. Compressed rollout-*.jsonl.zst copies are read on Python 3.14+ (which ships
  zstd in the standard library) and skipped, with a count, on older Pythons;
- usage lines: type "event_msg" with payload.type "token_count"; payload.info.total_token_usage is cumulative per
  session and the event repeats, so last_token_usage counts only when total_token_usage changed (if
  last_token_usage is missing, the difference between the totals is used);
- the same event found in two files (an archived copy, a forked session replaying its parent) counts once;
- model: the latest turn_context line's payload.model before the event;
- input_tokens includes cached_input_tokens, so input = input_tokens - cached_input_tokens (cache writes, which
  OpenAI bills as ordinary input, stay in input); reasoning tokens are already part of output_tokens;
- not counted: compaction requests recorded in separate token_usage_record lines.
"""
import glob
import json
import os
from collections import defaultdict

from .claude_code import FIELDS, month_of

SELLER = "OpenAI"
_RAW = ("input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens",
        "reasoning_output_tokens", "total_tokens")


def _zstd():
    try:
        from compression import zstd  # Python 3.14+
        return zstd
    except ImportError:
        return None


def codex_homes(home=None, environ=None):
    environ = os.environ if environ is None else environ
    env = environ.get("CODEX_HOME", "")
    if env.strip():
        return list(dict.fromkeys(p.strip() for p in env.split(",") if p.strip()))
    return [os.path.join(home or os.path.expanduser("~"), ".codex")]


def rollout_files(homes):
    """(files to read, number of .zst files skipped because this Python cannot read them)."""
    can_zstd = _zstd() is not None
    files, skipped = [], 0
    for h in homes:
        for sub in ("sessions", "archived_sessions"):
            d = os.path.join(h, sub)
            plain = sorted(glob.glob(os.path.join(d, "**", "rollout-*.jsonl"), recursive=True))
            files += plain
            have = set(plain)
            for p in sorted(glob.glob(os.path.join(d, "**", "rollout-*.jsonl.zst"), recursive=True)):
                if p[:-4] in have:
                    continue  # the plain copy is read instead
                if can_zstd:
                    files.append(p)
                else:
                    skipped += 1
    return files, skipped


def _open(path):
    if path.endswith(".zst"):
        return _zstd().open(path, "rt", encoding="utf-8", errors="replace")
    return open(path, encoding="utf-8", errors="replace")


def _usage(u):
    if not isinstance(u, dict):
        return None
    return tuple(int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else 0
                 for v in (u.get(f) for f in _RAW))


def events(lines):
    """(timestamp, model, (input, cached, cache_write, output, reasoning, total)) for each token_count event
    that adds usage, in one rollout file."""
    model, prev = None, None
    for line in lines:
        if "token_count" not in line and "turn_context" not in line:
            continue
        try:
            d = json.loads(line)
        except ValueError:
            continue
        p = d.get("payload") if isinstance(d, dict) else None
        if not isinstance(p, dict):
            continue
        if d.get("type") == "turn_context":
            if isinstance(p.get("model"), str) and p["model"]:
                model = p["model"]
            continue
        if d.get("type") != "event_msg" or p.get("type") != "token_count" or not isinstance(p.get("info"), dict):
            continue
        total, last = _usage(p["info"].get("total_token_usage")), _usage(p["info"].get("last_token_usage"))
        if last is not None and (total is None or total != prev):
            raw = last
        elif total is not None:
            raw = tuple(max(a - b, 0) for a, b in zip(total, prev or (0,) * len(total)))
        else:
            raw = None
        if total is not None:
            prev = total
        if raw is None:
            continue
        inp, cached, cw, out, reasoning, tot = raw
        cached = min(cached, inp)
        if not (inp or cached or cw or out or reasoning):
            continue
        yield d.get("timestamp"), model, (inp, cached, cw, out, reasoning, tot)


def monthly_totals(homes=None):
    """([{model, label, input_tokens, output_tokens, cached_input_tokens, cache_write_tokens (0),
    cache_write_1h_tokens (0)}], files read, .zst files skipped)."""
    files, skipped = rollout_files(codex_homes() if homes is None else homes)
    seen = set()
    tot = defaultdict(lambda: [0, 0, 0, 0, 0])
    read = 0
    for path in files:
        try:
            fh = _open(path)
        except OSError:
            continue
        read += 1
        try:
            with fh:
                for ts, model, u in events(fh):
                    key = (ts, model) + u
                    if key in seen:
                        continue
                    seen.add(key)
                    inp, cached, _cw, out, _reasoning, _total = u
                    t = tot[(model or "unknown", month_of(ts))]
                    t[0] += inp - cached
                    t[1] += out
                    t[2] += cached
        except Exception:  # a truncated or corrupt (compressed) file: keep what was read before the damage
            continue
    rows = []
    for (model, month), t in sorted(tot.items()):
        r = {"model": model, "label": month}
        r.update(zip(FIELDS, t))
        rows.append(r)
    return rows, read, skipped
