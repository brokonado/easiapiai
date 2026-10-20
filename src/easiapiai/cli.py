"""Command line: `easiapiai bill` and `easiapiai test`."""
import argparse
import json
import sys

from . import __version__, api, claude_code, codex, test_runner

MAX_ROWS = 60  # rows per /api/bill request

BILL_HELP = """\
Price your real token usage at every seller of the same model.

What is read (on this computer, nothing leaves it while reading):
  Claude Code logs: ~/.claude/projects, ~/.config/claude/projects and $CLAUDE_CONFIG_DIR/projects (*.jsonl,
  sub-agent folders included). Of each assistant line only the model name, timestamp, message/request ids
  and token counts are used.
  With --codex (experimental): $CODEX_HOME or ~/.codex, sessions/ and archived_sessions/ (rollout-*.jsonl);
  only token_count events and the model name.

What is sent (after the totals table is printed; not with --dry-run or --json):
  To {api}/api/bill (change it with --api):
  one row per model per month with the model name, the month (YYYY-MM) and five token totals (input,
  output, cache read, cache write 5m, cache write 1h), plus the seller you pay (default: Anthropic for
  Claude Code, OpenAI for Codex; change it with --seller). easiapiai prices the totals and stores none of them.

Never sent: prompts, replies, code, file names or paths, project names, session ids, API keys.
"""

TEST_HELP = """\
Ask a provider easiapiai's test questions with your own key, on your machine, and send the raw answers for
grading. Questions have exact reference answers (numbers or multiple choice).

The key: read only from the environment variable named by --key-env; sent only to --base-url, as an
Authorization header (redirects are refused, so it cannot be forwarded elsewhere). It is never printed, logged
or sent to easiapiai.

Sent to easiapiai: the run id, the seller name, the host of --base-url (not its path), the provider's model id,
--official, a random install id kept in ~/.config/easiapiai/install_id (it counts distinct contributors), the
client version, and per question the raw answer text (at most 4000 characters), latency, output tokens and an
error code. On a provider error the answer is sent empty: error text can echo part of a key.

How results are used: easiapiai grades each answer against the reference and publishes per model and seller
only once there are 300 answers from at least 5 people, as measured agreement with a 95% interval, with a
right of reply for the seller before anything negative is published. See https://easiapiai.com/accountability
"""


def _num(v):
    return "{:,}".format(int(v)) if v == int(v) else "{:,.1f}".format(v)


def _money(v):
    if v is None:
        return "-"
    return "$0" if abs(v) < 5e-5 else ("${:,.2f}".format(v) if abs(v) >= 1 else "${:,.4f}".format(v))


def print_table(title, rows, out=None):
    out = out or sys.stdout
    cols = [("Model", "model"), ("Month", "label"), ("Input", "input_tokens"), ("Output", "output_tokens"),
            ("Cache read", "cached_input_tokens"), ("Cache write 5m", "cache_write_tokens"),
            ("Cache write 1h", "cache_write_1h_tokens")]
    cols = [c for c in cols if c[1] in ("model", "label", "input_tokens", "output_tokens")
            or any(r[c[1]] for r in rows)]
    total = {"model": "Total", "label": ""}
    for _h, k in cols[2:]:
        total[k] = sum(r[k] for r in rows)
    cells = [[h for h, _k in cols]]
    for r in rows + [total]:
        cells.append([str(r[k]) if i < 2 else _num(r[k]) for i, (_h, k) in enumerate(cols)])
    widths = [max(len(row[i]) for row in cells) for i in range(len(cols))]
    print(title, file=out)
    for n, row in enumerate(cells):
        if n == len(cells) - 1:
            print("  " + "  ".join("-" * w for w in widths), file=out)
        print("  " + "  ".join(c.ljust(w) if i < 2 else c.rjust(w) for i, (c, w) in enumerate(zip(row, widths))),
              file=out)


def collect(args):
    """[(source title, rows, seller, notes)] for the sources asked for."""
    sources = []
    rows, files = claude_code.monthly_totals()
    notes = [] if rows else ["No Claude Code usage found (%d log files read)." % files]
    sources.append(("Claude Code", rows, claude_code.SELLER, notes))
    if args.codex:
        rows, files, skipped = codex.monthly_totals()
        notes = ["Codex support is EXPERIMENTAL: built from the Codex source code, not yet checked against real "
                 "Codex logs. Compare with Codex's own numbers before relying on it."]
        if not rows:
            notes.append("No Codex usage found (%d rollout files read)." % files)
        if skipped:
            notes.append("%d compressed .jsonl.zst rollout files were skipped: reading them needs Python 3.14+."
                         % skipped)
        if any(r["model"] == "unknown" for r in rows):
            notes.append("Rows under model 'unknown' (no turn_context line before them) are shown but not sent.")
        sources.append(("Codex", rows, codex.SELLER, notes))
    return sources


def _sendable(rows):
    keys = claude_code.FIELDS
    return [r for r in rows if r["model"] != "unknown" and any(r[k] for k in keys)]


def _merge(responses):
    """One bill out of several /api/bill answers (the API takes at most 60 rows per request)."""
    out = {"rows": [], "unmatched": [], "as_of_human": None, "as_of": None}
    t = {"rows_with_list_price": 0, "at_list_price_usd": 0.0, "at_cheapest_usd": 0.0, "saving_vs_list_usd": 0.0,
         "rows_with_current_seller": 0, "at_current_seller_usd": 0.0}
    for r in responses:
        out["rows"] += r.get("rows") or []
        out["unmatched"] += r.get("unmatched") or []
        out["as_of_human"] = out["as_of_human"] or r.get("as_of_human")
        out["as_of"] = out["as_of"] or r.get("as_of")
        for k in t:
            t[k] += (r.get("totals") or {}).get(k) or 0
    out["totals"] = t
    return out


def print_bill(b, out=None):
    out = out or sys.stdout
    p = lambda s="": print(s, file=out)
    when = b.get("as_of_human") or b.get("as_of")
    p("Prices" + (" as of %s" % when if when else "") + ":")
    for r in b["rows"]:
        m = r.get("model") or {}
        p()
        p("%s%s  %s" % (m.get("name") or m.get("asked"), " (%s)" % r["label"] if r.get("label") else "",
                        m.get("url") or ""))
        if r.get("list_price_usd") is not None:
            p("  at the %s: %s" % (r.get("list_note") or "list price", _money(r["list_price_usd"])))
        c = r.get("cheapest")
        if c:
            s = r.get("saving_vs_list_usd")
            saving = (" - saves %s against the list price" % _money(s) if s and s > 0 else
                      " - the list price is already the cheapest verified option" if s == 0 else "")
            p("  cheapest verified seller: %s %s%s%s" % (c.get("seller"), _money(c.get("total_usd")), saving,
                                                         " (%s)" % "; ".join(c["notes"]) if c.get("notes") else ""))
        else:
            p("  no seller has a complete price for this usage")
        a = r.get("cheapest_any")
        if a:
            p("  cheapest of all, not verified by easiapiai: %s %s" % (a.get("seller"), _money(a.get("total_usd"))))
        cur = r.get("current")
        if cur:
            p("  at %s (the seller you named): %s" % (cur.get("seller"), _money(cur.get("total_usd"))))
    for u in b["unmatched"]:
        sug = u.get("suggestions") or []
        p()
        p("Not priced: '%s'%s is not a model on easiapiai.com%s" % (
            u.get("model"), " (%s)" % u["label"] if u.get("label") else "",
            "; did you mean %s?" % ", ".join(sug) if sug else "."))
    t = b["totals"]
    p()
    if t["rows_with_list_price"]:
        p("Total at list prices %s, at the cheapest verified sellers %s: saving %s." % (
            _money(t["at_list_price_usd"]), _money(t["at_cheapest_usd"]), _money(t["saving_vs_list_usd"])))
    if t["rows_with_current_seller"]:
        p("Total at the seller you named: %s." % _money(t["at_current_seller_usd"]))
    p("Standard list prices as each seller publishes them; check the seller before you switch. On a subscription "
      "plan rather than an API key you did not pay per token: these are API-price equivalents. "
      "Every seller: https://easiapiai.com/bill")


def cmd_bill(args):
    sources = collect(args)
    for title, rows, seller, notes in sources:
        for n in notes:
            print("note: " + n, file=sys.stderr)
    found = [(t, r, s) for t, r, s, _n in sources if r]
    if not found:
        print("Nothing to price: no usage found on this computer.", file=sys.stderr)
        return 1
    if args.json:
        json.dump({t.lower().replace(" ", "_"): {"usage": _sendable(r), "current_seller": args.seller or s}
                   for t, r, s in found}, sys.stdout, indent=1)
        print()
        return 0
    for title, rows, _s in found:
        print_table("%s usage on this computer, tokens per model and month:" % title, rows)
        print()
    if args.dry_run:
        print("Dry run: nothing was sent.")
        return 0
    endpoint = api.url(args.api, "/api/bill")
    responses, failed = [], False
    for title, rows, seller in found:
        send = _sendable(rows)
        seller = args.seller or seller
        if not send:
            continue
        print("Sending the %s totals above (model, month, token counts; seller %r) to %s ..."
              % (title, seller, endpoint))
        for i in range(0, len(send), MAX_ROWS):
            try:
                responses.append(api.call("POST", endpoint, {"usage": send[i:i + MAX_ROWS],
                                                             "current_seller": seller}))
            except api.ApiError as exc:
                print("easiapiai bill: the %s price request failed: %s" % (title, exc), file=sys.stderr)
                failed = True
                break
    if not responses:
        if not failed:
            print("Nothing was sent: no row has a known model and tokens.", file=sys.stderr)
        return 1
    print()
    print_bill(_merge(responses))
    return 1 if failed else 0


def build_parser():
    ap = argparse.ArgumentParser(
        prog="easiapiai",
        description="easiapiai: an open, human + agent maintained library of LLM API prices and a "
                    "provider-accountability project. https://easiapiai.com",
        epilog="Commands:\n  bill   price your real usage (Claude Code, Codex) at every seller of the same model\n"
               "  test   help check what a provider actually serves, with your own key\n\n"
               "Run 'easiapiai bill --help' or 'easiapiai test --help' for what each one reads and sends.",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--version", action="version", version="easiapiai " + __version__)
    sub = ap.add_subparsers(dest="command", metavar="{bill,test}")

    b = sub.add_parser("bill", help="price your real usage at every seller of the same model",
                       description=BILL_HELP.replace("{api}", api.DEFAULT_API),
                       formatter_class=argparse.RawDescriptionHelpFormatter)
    b.add_argument("--codex", action="store_true", help="also read Codex CLI logs (experimental)")
    b.add_argument("--dry-run", action="store_true", help="print the totals only; send nothing")
    b.add_argument("--json", action="store_true",
                   help="print the request body(ies) as JSON, one per source, instead of the table; send nothing")
    b.add_argument("--seller", metavar="NAME",
                   help="the seller you pay today, e.g. 'OpenRouter' (default: Anthropic / OpenAI)")
    b.add_argument("--api", metavar="URL", default=api.DEFAULT_API, help="API base URL (default: %(default)s)")
    b.set_defaults(func=cmd_bill)

    t = sub.add_parser("test", help="check what a provider serves, with your own key",
                       description=TEST_HELP, formatter_class=argparse.RawDescriptionHelpFormatter)
    t.add_argument("--model", required=True, metavar="NAME", help="the model's name or id on easiapiai.com")
    t.add_argument("--base-url", required=True, metavar="URL",
                   help="the provider's OpenAI-compatible base URL, e.g. https://api.deepinfra.com/v1/openai")
    t.add_argument("--provider-model", required=True, metavar="ID", help="the model id at that provider")
    t.add_argument("--seller", required=True, metavar="NAME", help="the seller's name as on easiapiai.com")
    t.add_argument("--key-env", required=True, metavar="VAR",
                   help="NAME of the environment variable holding your key (not the key itself)")
    t.add_argument("-n", type=int, default=10, help="number of questions, 1-20 (default: 10)")
    t.add_argument("--official", action="store_true",
                   help="the seller is the model's own developer (its official API)")
    t.add_argument("--api", metavar="URL", default=api.DEFAULT_API, help="API base URL (default: %(default)s)")
    t.add_argument("--timeout", type=float, default=60.0, metavar="SECONDS",
                   help="per-request timeout (default: 60)")
    t.set_defaults(func=test_runner.run)
    return ap


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = build_parser()
    args = ap.parse_args(argv)
    if not getattr(args, "func", None):
        ap.print_help()
        return 2
    try:
        return args.func(args)
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        return 130
