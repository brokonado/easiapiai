# easiapiai

The command-line tool for [easiapiai.com](https://easiapiai.com): an open, human + agent maintained library of
LLM API prices, and a provider-accountability project.

It does two things:

- **`easiapiai bill`** adds up the tokens your coding agent actually used, from its own logs on your computer
  (Claude Code; Codex as an experiment), and prices that usage at every seller of the same model.
- **`easiapiai test`** asks a provider you already use a short set of questions that have exact answers, with
  your own key, on your own machine, and sends the raw answers to easiapiai for grading. Pooled with other
  people's runs, this helps check what providers actually serve.

Python 3.9+, standard library only, no dependencies. MIT licence.

## Install

```
uvx --from git+https://github.com/brokonado/easiapiai easiapiai bill      # run it without installing (needs uv)
pipx run --spec git+https://github.com/brokonado/easiapiai easiapiai bill  # the same with pipx
pip install git+https://github.com/brokonado/easiapiai                     # or install it
```

Not on PyPI yet; these install straight from this repository.

From a checkout of this repository: `pip install .`, or without installing:
`PYTHONPATH=src python -m easiapiai --help`.

## `easiapiai bill`: price your real usage

```
easiapiai bill                       # Claude Code usage
easiapiai bill --codex               # Claude Code and Codex (experimental)
easiapiai bill --dry-run             # print the totals, send nothing
easiapiai bill --json                # print the exact request body as JSON, send nothing
easiapiai bill --seller OpenRouter   # the seller you pay today (default: Anthropic / OpenAI)
```

First it prints a table of your totals per model and month:

| Column | Meaning |
|---|---|
| Model | the model name as the logs record it |
| Month | the month of each reply, in your local time |
| Input | input tokens not read from the cache (for Claude Code, cache writes are left out too) |
| Output | output tokens, thinking / reasoning included |
| Cache read | input tokens read from the prompt cache |
| Cache write 5m / 1h | tokens written to the 5-minute and 1-hour caches (shown only when not zero) |

Then it sends those totals to `https://easiapiai.com/api/bill` and prints, for each model and month: the cost at
the official list price, the cheapest seller easiapiai has verified and the saving against the list price, the
cheapest seller of all when that one is not verified, and the cost at the seller you named. Models that do not
match a model on easiapiai.com exactly (a date suffix like `-20250805` is ignored) are listed as "not priced",
with suggestions; nothing is priced by guess.

Prices are the standard list prices each seller publishes. Check the seller before you switch. If you use a
subscription plan rather than an API key, you did not pay per token: the figures show what the same usage costs
at API prices. The same pricing is on the web at https://easiapiai.com/bill.

### How Claude Code usage is counted

These rules were checked against 949 real Claude Code log files and against the open-source
[ccusage](https://github.com/ryoppippi/ccusage):

- every `*.jsonl` under `~/.claude/projects`, `~/.config/claude/projects` and `<each $CLAUDE_CONFIG_DIR
  entry>/projects`, including sub-agent folders (sub-agent replies are not repeated in the parent file);
- only lines with `type` `"assistant"`; lines with model `<synthetic>` (API errors, zero tokens) are skipped;
- one API reply is written on several lines, one per content block, and its output count grows from line to
  line: lines are grouped by `(message.id, requestId)` across all files, and the line with the largest token
  total is kept;
- `input_tokens` excludes cache reads and writes; thinking is part of `output_tokens`; cache writes are split
  into 5-minute and 1-hour writes (older logs that have only `cache_creation_input_tokens` count as 5-minute).

### How Codex usage is counted (experimental)

Built from the Codex source code; **not yet checked against real Codex log files**. Compare it with Codex's own
numbers before you rely on it, and tell us if they differ.

- `rollout-*.jsonl` under `$CODEX_HOME` (or `~/.codex`) in `sessions/` and `archived_sessions/`; compressed
  `.jsonl.zst` copies are read on Python 3.14+ and skipped, with a count, on older versions;
- `token_count` events; an event counts only when the session's running total changed, and the same event found
  in two files counts once;
- the model is the one named by the latest `turn_context` line;
- input = `input_tokens - cached_input_tokens`; reasoning is already part of output;
- not counted yet: compaction requests, which Codex records in separate lines.

## `easiapiai test`: check what a provider serves

```
export PROVIDER_KEY=...   # your key for that provider, in an environment variable
easiapiai test \
  --model "<the model's name on easiapiai.com>" \
  --base-url <the provider's OpenAI-compatible base URL, e.g. https://api.deepinfra.com/v1/openai> \
  --provider-model "<the model's id at that provider>" \
  --seller "<the seller's name as on easiapiai.com>" \
  --key-env PROVIDER_KEY
```

Options: `-n` questions (1 to 20, default 10), `--official` when the seller is the model's own developer,
`--timeout` seconds per request (default 60).

What happens:

1. It fetches the questions from easiapiai, with a signed run id. Each question has an exact reference answer:
   a number or a multiple-choice letter.
2. It sends each question to `<base-url>/chat/completions` as a single user message, with temperature 0 and
   `max_tokens` 2048 (room for reasoning models), and records the answer text, the latency, the output tokens, or an error
   (`timeout`, `http_429`, `http_5xx`, `other`).
3. It sends the raw answers to easiapiai, which grades them, and prints the score and a link to the results.

If the first question fails with a set-up error (a wrong key, URL or model id), it stops and sends nothing to
easiapiai. A run costs you the provider requests it makes: at most 20 questions, at most 2048 output tokens each.

## Privacy

### `bill`

- **Read on your computer:** the log files listed above. Of each line only the model name, timestamp,
  message/request ids and token counts are used.
- **Sent** (to `https://easiapiai.com/api/bill`, not with `--dry-run` or `--json`): one row per model per month
  with the model name, the month and five token totals, plus the seller name. `--json` prints exactly this.
- **Never sent:** prompts, replies, code, file names or paths, project names, session ids, API keys.
- **Kept by easiapiai:** the API prices the totals and stores none of them. The web server's normal log records
  that `/api/bill` was called (the path, not the body), and a per-address request count is kept in memory for
  rate limiting.

### `test`

- **Read on your computer:** only the environment variable you name with `--key-env`.
- **Sent to your provider** (`--base-url` only): the test questions, the model id, and your key as an
  `Authorization` header. Redirects are refused, so the key cannot be forwarded to another address.
- **Sent to easiapiai:** the run id, the seller name, the host of `--base-url` (not its path), the provider's
  model id, `--official`, a random install id, the client version, and per question the raw answer text (at most
  4000 characters), latency, output tokens and error code. When the provider returns an error, the answer is sent
  empty, because error text can echo part of a key.
- **Never sent to easiapiai:** your key, the full base URL, anything from your files.
- **Kept on your computer:** `~/.config/easiapiai/install_id`, a random id created on first use. It lets
  easiapiai count distinct contributors and says nothing else about you. Delete it whenever you like.
- **Kept by easiapiai:** the graded answers with the question id, a response excerpt of at most 500 characters,
  a hashed IP address and the hashed install id. No keys.

## How test results are used and published

- Each answer is graded against the reference: for number questions, the last number in the answer; for
  multiple-choice questions, the chosen letter. Answers that ended in an error are counted as errors, not graded.
- Results are pooled per model and seller: accuracy with a 95% interval (Wilson), median latency and error
  counts.
- A result is **published only once there are at least 300 answers from at least 5 different people**. Until
  then the site shows only how many answers have come in.
- Results are stated as measured agreement with the reference answers, with the number of answers and the
  interval. They are not accusations: a difference can have ordinary causes, which is why the thresholds exist.
- Sellers get a right of reply before anything negative is published, and nobody can pay for a ranking.

The charter: https://easiapiai.com/accountability. The results: https://easiapiai.com/test.

## For coding agents

Agents can run both commands for their user. `easiapiai bill --json` prints the totals as JSON (one request body
per source) without sending anything. The HTTP API behind both commands is described at
https://easiapiai.com/bill and https://easiapiai.com/test.

## Development

```
python -m unittest discover -s tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md). MIT licence, see [LICENSE](LICENSE).
