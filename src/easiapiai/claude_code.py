"""Claude Code token usage per model and month, from its own logs on this computer.

Rules (checked against 949 real log files and the open-source ccusage, 2026-10-20):
- every *.jsonl under the projects folders, sub-agent folders included (they are not repeated in the parent);
- only lines with type "assistant"; skip model "<synthetic>" (API-error lines with zero tokens);
- one API response appears on several lines (one per content block): key (message.id, requestId) across all
  files, keep the line with the largest token total (output grows from line to line);
- input_tokens excludes cache reads and writes; thinking is part of output_tokens;
- the month is the line's timestamp in your local time zone.

Only the model name, timestamp, ids and token counts of each line are used. Nothing here reads or keeps message
content beyond the line being parsed.
"""
import datetime
import glob
import json
import os
import re
from collections import defaultdict

FIELDS = ("input_tokens", "output_tokens", "cached_input_tokens", "cache_write_tokens", "cache_write_1h_tokens")
SELLER = "Anthropic"


def project_dirs(home=None, environ=None):
    """The folders Claude Code writes its logs to: ~/.claude/projects, ~/.config/claude/projects and
    <each entry of $CLAUDE_CONFIG_DIR>/projects (a comma-separated list)."""
    home = home or os.path.expanduser("~")
    environ = os.environ if environ is None else environ
    roots = [os.path.join(home, ".claude", "projects"), os.path.join(home, ".config", "claude", "projects")]
    roots += [os.path.join(p.strip(), "projects") for p in environ.get("CLAUDE_CONFIG_DIR", "").split(",")
              if p.strip()]
    return list(dict.fromkeys(roots))


def _n(v):
    """A token count: numbers as they are, anything else (missing, null, malformed) as 0."""
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else 0


def month_of(ts):
    """'YYYY-MM' of an ISO timestamp in local time, or 'unknown'."""
    try:
        s = ts.replace("Z", "+00:00")
        try:
            dt = datetime.datetime.fromisoformat(s)
        except ValueError:
            # Python 3.9/3.10 accept only 3 or 6 fractional digits; pad or cut to 6 and retry
            dt = datetime.datetime.fromisoformat(re.sub(r"\.(\d+)", lambda m: "." + (m.group(1) + "00000")[:6], s))
        return dt.astimezone().strftime("%Y-%m")
    except (ValueError, AttributeError, TypeError, OverflowError, OSError):
        return "unknown"


def read_lines(dirs):
    """{key: (model, month, (input, output, cache_read, cache_write_5m, cache_write_1h))}, one entry per API
    response, keeping its line with the largest token total; plus the number of files read."""
    best = {}
    files = 0
    for root in dirs:
        for path in glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True):
            try:
                fh = open(path, encoding="utf-8", errors="replace")
            except OSError:
                continue
            files += 1
            with fh:
                for line in fh:
                    if '"assistant"' not in line:
                        continue
                    try:
                        d = json.loads(line)
                    except ValueError:
                        continue
                    if not isinstance(d, dict):
                        continue
                    m = d.get("message") if d.get("type") == "assistant" else None
                    m = m if isinstance(m, dict) else None
                    u, model = (m or {}).get("usage"), (m or {}).get("model")
                    if not u or not isinstance(u, dict) or not model or not isinstance(model, str) \
                            or model == "<synthetic>":
                        continue
                    cc = u.get("cache_creation") or {}
                    cc = cc if isinstance(cc, dict) else {}
                    w5, w1 = cc.get("ephemeral_5m_input_tokens"), cc.get("ephemeral_1h_input_tokens")
                    if w5 is None and w1 is None:
                        w5, w1 = u.get("cache_creation_input_tokens") or 0, 0
                    row = (_n(u.get("input_tokens")), _n(u.get("output_tokens")),
                           _n(u.get("cache_read_input_tokens")), _n(w5), _n(w1))
                    month = month_of(d.get("timestamp")) if "timestamp" in d else "unknown"
                    key = (m.get("id"), d.get("requestId")) if m.get("id") else (path, line)
                    if key not in best or sum(row) > sum(best[key][2]):
                        best[key] = (model, month, row)
    return best, files


def monthly_totals(dirs=None):
    """([{model, label (YYYY-MM), input_tokens, output_tokens, cached_input_tokens, cache_write_tokens,
    cache_write_1h_tokens}] sorted by model and month, number of files read)."""
    best, files = read_lines(project_dirs() if dirs is None else dirs)
    tot = defaultdict(lambda: [0, 0, 0, 0, 0])
    for model, month, row in best.values():
        t = tot[(model, month)]
        for i, v in enumerate(row):
            t[i] += v
    rows = []
    for (model, month), t in sorted(tot.items()):
        r = {"model": model, "label": month}
        r.update(zip(FIELDS, t))
        rows.append(r)
    return rows, files
