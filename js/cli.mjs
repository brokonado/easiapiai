// Command line: `easiapiai bill` and `easiapiai test`.
import * as api from "./api.mjs";
import { ArgumentParser, ParserExit } from "./argparse.mjs";
import * as claudeCode from "./claude_code.mjs";
import * as codex from "./codex.mjs";
import {
  add, formatFixed, formatInt, get, iterate, jsonDumps, ljust, or, pyLen, pyRepr, pyStr, rjust, truthy,
} from "./py.mjs";
import * as share from "./share.mjs";
import * as testRunner from "./test_runner.mjs";
import { VERSION } from "./version.mjs";

const MAX_ROWS = 60; // rows per /api/bill request

const BILL_HELP = `\
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
`;

const TEST_HELP = `\
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
`;

const SHARE_HELP = `\
Share your LLM API usage with easiapiai.com, as numbers only, to show which sellers people really use and how
they hold up.

What is read (on this computer): Claude Code logs, Codex logs, opencode and Cline data when present, and the
OpenRouter activity report when OPENROUTER_MANAGEMENT_KEY is set (that key is sent only to openrouter.ai).
What is sent, after the table is shown and you agree: per seller, model and month of the last 13 months, token,
request and error counts, and a random contributor id kept in ~/.config/easiapiai/contributor_id (sending again
replaces your earlier numbers instead of adding to them).
Never sent: prompts, replies, code, file names, project names, keys.
`;

// the easiapiai API address: --api, else $EASIAPIAI_API, else https://easiapiai.com
const API = process.env.EASIAPIAI_API || api.DEFAULT_API;

function print(s = "") {
  process.stdout.write(s + "\n");
}

function printErr(s) {
  process.stderr.write(s + "\n");
}

// a token count: grouped by commas, one decimal if it is not whole
function num(v) {
  if (typeof v === "number" && !Number.isFinite(v)) throw new RangeError("cannot convert float to integer");
  return Number.isInteger(v) ? formatInt(v) : formatFixed(v, 1);
}

// a price in dollars, as the Python client prints it
function money(v) {
  if (v === null || v === undefined) return "-";
  if (typeof v === "boolean") v = Number(v);
  if (typeof v !== "number") throw new TypeError("bad operand type for abs()");
  if (Math.abs(v) < 5e-5) return "$0";
  return "$" + formatFixed(v, Math.abs(v) >= 1 ? 2 : 4);
}

export function printTable(title, rows) {
  let cols = [["Model", "model"], ["Month", "label"], ["Input", "input_tokens"], ["Output", "output_tokens"],
    ["Cache read", "cached_input_tokens"], ["Cache write 5m", "cache_write_tokens"],
    ["Cache write 1h", "cache_write_1h_tokens"]];
  cols = cols.filter(([, k]) => ["model", "label", "input_tokens", "output_tokens"].includes(k)
    || rows.some((r) => truthy(r[k])));
  const total = { model: "Total", label: "" };
  for (const [, k] of cols.slice(2)) total[k] = rows.reduce((s, r) => s + r[k], 0);
  const cells = [cols.map(([h]) => h)];
  for (const r of [...rows, total]) cells.push(cols.map(([, k], i) => (i < 2 ? pyStr(r[k]) : num(r[k]))));
  const widths = cols.map((_, i) => Math.max(...cells.map((row) => pyLen(row[i]))));
  print(title);
  cells.forEach((row, n) => {
    if (n === cells.length - 1) print("  " + widths.map((w) => "-".repeat(w)).join("  "));
    print("  " + row.map((c, i) => (i < 2 ? ljust(c, widths[i]) : rjust(c, widths[i]))).join("  "));
  });
}

// [[source title, rows, seller, notes]] for the sources asked for
export function collect(args) {
  const sources = [];
  let [rows, files] = claudeCode.monthlyTotals();
  let notes = rows.length ? [] : [`No Claude Code usage found (${files} log files read).`];
  sources.push(["Claude Code", rows, claudeCode.SELLER, notes]);
  if (args.codex) {
    let skipped;
    [rows, files, skipped] = codex.monthlyTotals();
    notes = ["Codex support is EXPERIMENTAL: built from the Codex source code, not yet checked against real "
      + "Codex logs. Compare with Codex's own numbers before relying on it."];
    if (!rows.length) notes.push(`No Codex usage found (${files} rollout files read).`);
    if (skipped) {
      notes.push(`${skipped} compressed .jsonl.zst rollout files were skipped: reading them needs Node.js 22.15+.`);
    }
    if (rows.some((r) => r.model === "unknown")) {
      notes.push("Rows under model 'unknown' (no turn_context line before them) are shown but not sent.");
    }
    sources.push(["Codex", rows, codex.SELLER, notes]);
  }
  return sources;
}

function sendable(rows) {
  return rows.filter((r) => r.model !== "unknown" && claudeCode.FIELDS.some((k) => truthy(r[k])));
}

// One bill out of several /api/bill answers (the API takes at most 60 rows per request)
function merge(responses) {
  const out = { rows: [], unmatched: [], as_of_human: null, as_of: null };
  const t = {
    rows_with_list_price: 0, at_list_price_usd: 0.0, at_cheapest_usd: 0.0, saving_vs_list_usd: 0.0,
    rows_with_current_seller: 0, at_current_seller_usd: 0.0,
  };
  for (const r of responses) {
    out.rows.push(...iterate(or(get(r, "rows"), [])));
    out.unmatched.push(...iterate(or(get(r, "unmatched"), [])));
    out.as_of_human = or(out.as_of_human, get(r, "as_of_human"));
    out.as_of = or(out.as_of, get(r, "as_of"));
    const totals = or(get(r, "totals"), {});
    for (const k of Object.keys(t)) t[k] = add(t[k], or(get(totals, k), 0));
  }
  out.totals = t;
  return out;
}

export function printBill(b) {
  const when = or(b.as_of_human, b.as_of);
  print("Prices" + (truthy(when) ? ` as of ${pyStr(when)}` : "") + ":");
  for (const r of b.rows) {
    const m = or(get(r, "model"), {});
    print();
    print(`${pyStr(or(get(m, "name"), get(m, "asked")))}${truthy(get(r, "label")) ? ` (${pyStr(r.label)})` : ""}  `
      + pyStr(or(get(m, "url"), "")));
    if (get(r, "list_price_usd") !== null) {
      print(`  at the ${pyStr(or(get(r, "list_note"), "list price"))}: ${money(r.list_price_usd)}`);
    }
    const c = get(r, "cheapest");
    if (truthy(c)) {
      const s = get(r, "saving_vs_list_usd");
      const saving = truthy(s) && s > 0 ? ` - saves ${money(s)} against the list price`
        : s === 0 || s === false ? " - the list price is already the cheapest verified option" : "";
      const notes = truthy(get(c, "notes")) ? ` (${iterate(c.notes).join("; ")})` : "";
      print(`  cheapest verified seller: ${pyStr(get(c, "seller"))} ${money(get(c, "total_usd"))}${saving}${notes}`);
    } else {
      print("  no seller has a complete price for this usage");
    }
    const a = get(r, "cheapest_any");
    if (truthy(a)) {
      print(`  cheapest of all, not verified by easiapiai: ${pyStr(get(a, "seller"))} ${money(get(a, "total_usd"))}`);
    }
    const cur = get(r, "current");
    if (truthy(cur)) {
      print(`  at ${pyStr(get(cur, "seller"))} (the seller you named): ${money(get(cur, "total_usd"))}`);
    }
  }
  for (const u of b.unmatched) {
    const sug = or(get(u, "suggestions"), []);
    print();
    print(`Not priced: '${pyStr(get(u, "model"))}'${truthy(get(u, "label")) ? ` (${pyStr(u.label)})` : ""} `
      + `is not a model on easiapiai.com${truthy(sug) ? `; did you mean ${iterate(sug).join(", ")}?` : "."}`);
  }
  const t = b.totals;
  print();
  if (truthy(t.rows_with_list_price)) {
    print(`Total at list prices ${money(t.at_list_price_usd)}, at the cheapest verified sellers `
      + `${money(t.at_cheapest_usd)}: saving ${money(t.saving_vs_list_usd)}.`);
  }
  if (truthy(t.rows_with_current_seller)) print(`Total at the seller you named: ${money(t.at_current_seller_usd)}.`);
  print("Standard list prices as each seller publishes them; check the seller before you switch. On a subscription "
    + "plan rather than an API key you did not pay per token: these are API-price equivalents. "
    + "Every seller: https://easiapiai.com/bill");
}

export async function cmdBill(args) {
  // Reading the logs is synchronous, and Node.js runs a Ctrl-C handler only once it is done: while reading, Ctrl-C
  // keeps its default effect (the program stops at once, exit status 130) instead of waiting for the end
  const handlers = process.rawListeners("SIGINT");
  process.removeAllListeners("SIGINT");
  let sources;
  try {
    sources = collect(args);
  } finally {
    for (const h of handlers) process.on("SIGINT", h);
  }
  for (const [, , , notes] of sources) for (const n of notes) printErr("note: " + n);
  const found = sources.filter(([, rows]) => rows.length).map(([t, r, s]) => [t, r, s]);
  if (!found.length) {
    printErr("Nothing to price: no usage found on this computer.");
    return 1;
  }
  if (args.json) {
    const out = {};
    for (const [t, r, s] of found) out[t.toLowerCase().replaceAll(" ", "_")] = { usage: sendable(r), current_seller: args.seller || s };
    print(jsonDumps(out, 1));
    return 0;
  }
  for (const [title, rows] of found) {
    printTable(`${title} usage on this computer, tokens per model and month:`, rows);
    print();
  }
  if (args.dry_run) {
    print("Dry run: nothing was sent.");
    return 0;
  }
  const endpoint = api.url(args.api, "/api/bill");
  const responses = [];
  let failed = false;
  for (const [title, rows, defaultSeller] of found) {
    const send = sendable(rows);
    const seller = args.seller || defaultSeller;
    if (!send.length) continue;
    print(`Sending the ${title} totals above (model, month, token counts; seller ${pyRepr(seller)}) to ${endpoint} ...`);
    for (let i = 0; i < send.length; i += MAX_ROWS) {
      try {
        responses.push(await api.call("POST", endpoint, { usage: send.slice(i, i + MAX_ROWS), current_seller: seller }));
      } catch (err) {
        if (!(err instanceof api.ApiError)) throw err;
        printErr(`easiapiai bill: the ${title} price request failed: ${err.message}`);
        failed = true;
        break;
      }
    }
  }
  if (!responses.length) {
    if (!failed) printErr("Nothing was sent: no row has a known model and tokens.");
    return 1;
  }
  print();
  printBill(merge(responses));
  return failed ? 1 : 0;
}

export function buildParser() {
  const ap = new ArgumentParser({
    prog: "easiapiai",
    description: "easiapiai: an open, human + agent maintained library of LLM API prices and a "
      + "provider-accountability project. https://easiapiai.com",
    epilog: "Commands:\n  bill     price your real usage (Claude Code, Codex) at every seller of the same model\n"
      + "  test     help check what a provider actually serves, with your own key\n"
      + "  share    share your usage numbers with easiapiai (shows them and asks first)\n"
      + "  sharing  turn automatic weekly sharing on or off (it runs from the Claude Code plugin)\n\n"
      + "Run 'easiapiai <command> --help' for what each one reads and sends.",
  });
  ap.addArgument(["--version"], { kind: "version", version: "easiapiai " + VERSION,
    help: "show program's version number and exit" });
  const sub = ap.addSubparsers({ dest: "command", metavar: "{bill,test,share,sharing}" });
  const apiHelp = "API base URL (default: %(default)s; set EASIAPIAI_API to change the default)";

  const b = sub.addParser("bill", { help: "price your real usage at every seller of the same model",
    description: BILL_HELP.replace("{api}", API) });
  b.addArgument(["--codex"], { kind: "store_true", help: "also read Codex CLI logs (experimental)" });
  b.addArgument(["--dry-run"], { kind: "store_true", help: "print the totals only; send nothing" });
  b.addArgument(["--json"], { kind: "store_true",
    help: "print the request body(ies) as JSON, one per source, instead of the table; send nothing" });
  b.addArgument(["--seller"], { metavar: "NAME",
    help: "the seller you pay today, e.g. 'OpenRouter' (default: Anthropic / OpenAI)" });
  b.addArgument(["--api"], { metavar: "URL", default: API, help: apiHelp });
  b.setDefaults({ func: cmdBill });

  const t = sub.addParser("test", { help: "check what a provider serves, with your own key", description: TEST_HELP });
  t.addArgument(["--model"], { required: true, metavar: "NAME", help: "the model's name or id on easiapiai.com" });
  t.addArgument(["--base-url"], { required: true, metavar: "URL",
    help: "the provider's OpenAI-compatible base URL, e.g. https://api.deepinfra.com/v1/openai" });
  t.addArgument(["--provider-model"], { required: true, metavar: "ID", help: "the model id at that provider" });
  t.addArgument(["--seller"], { required: true, metavar: "NAME", help: "the seller's name as on easiapiai.com" });
  t.addArgument(["--key-env"], { required: true, metavar: "VAR",
    help: "NAME of the environment variable holding your key (not the key itself)" });
  t.addArgument(["-n"], { type: "int", default: 10, help: "number of questions, 1-20 (default: 10)" });
  t.addArgument(["--official"], { kind: "store_true",
    help: "the seller is the model's own developer (its official API)" });
  t.addArgument(["--api"], { metavar: "URL", default: API, help: apiHelp });
  t.addArgument(["--timeout"], { type: "float", default: 60.0, metavar: "SECONDS",
    help: "per-request timeout (default: 60)" });
  t.setDefaults({ func: (args) => testRunner.run(args) });

  const s = sub.addParser("share", { help: "share your usage numbers with easiapiai (shows them and asks first)",
    description: SHARE_HELP });
  s.addArgument(["--dry-run"], { kind: "store_true", help: "print the sources and the table only; send nothing" });
  s.addArgument(["--json"], { kind: "store_true",
    help: "print the exact request bodies as a JSON list instead of the table; send nothing" });
  s.addArgument(["--yes"], { kind: "store_true", help: "send without asking (no terminal: needed to send at all)" });
  s.addArgument(["--api"], { metavar: "URL", default: API, help: apiHelp });
  s.setDefaults({ func: share.cmdShare });

  const sh = sub.addParser("sharing", { help: "turn automatic weekly sharing on or off",
    description: "Automatic sharing: the easiapiai Claude Code plugin sends the numbers 'easiapiai share' shows "
      + "about once a week, once you turn it on. The setting is kept in ~/.config/easiapiai/sharing.json." });
  sh.setDefaults({ func: () => {
    process.stdout.write(sh.formatHelp());
    return 2;
  } });
  const actions = sh.addSubparsers({ dest: "sharing_action", metavar: "{on,off,status}" });
  const on = actions.addParser("on", { help: "share automatically from now on, and send now" });
  on.addArgument(["--no-send"], { kind: "store_true", help: "only record the choice; send nothing now" });
  on.addArgument(["--api"], { metavar: "URL", default: API, help: apiHelp });
  on.setDefaults({ func: share.cmdSharing });
  actions.addParser("off", { help: "stop sharing automatically" }).setDefaults({ func: share.cmdSharing });
  actions.addParser("status", { help: "show the setting and when numbers were last sent" })
    .setDefaults({ func: share.cmdSharing });

  // the Claude Code plugin's hooks (not listed)
  const h = sub.addParser("hook", { description: "Hooks run by the easiapiai Claude Code plugin." });
  const hooks = h.addSubparsers({ dest: "hook_name", metavar: "{session-start,send}" });
  hooks.addParser("session-start", { help: "ask once whether to share (prints a note for Claude)" })
    .setDefaults({ func: share.hookSessionStart });
  const hs = hooks.addParser("send", { help: "send the numbers when sharing is on and a week has passed" });
  hs.addArgument(["--api"], { metavar: "URL", default: API, help: apiHelp });
  hs.setDefaults({ func: share.hookSend });
  return ap;
}

export async function main(argv = process.argv.slice(2)) {
  const ap = buildParser();
  let args;
  try {
    args = ap.parseArgs(argv);
  } catch (err) {
    if (err instanceof ParserExit) return err.status;
    throw err;
  }
  if (!args.func) {
    process.stdout.write(ap.formatHelp());
    return 2;
  }
  const interrupted = () => {
    process.stderr.write("interrupted\n");
    process.exit(130);
  };
  process.on("SIGINT", interrupted);
  try {
    return await args.func(args);
  } finally {
    process.removeListener("SIGINT", interrupted);
  }
}
