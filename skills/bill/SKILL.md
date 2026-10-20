---
name: bill
description: Price the user's real Claude Code (and Codex) token usage at every seller of the same model with easiapiai.com. Use when the user asks what their usage costs or would cost at API prices, how much they would save at another seller or provider, or runs /easiapiai:bill.
---

# Price my usage

The tool ships with this plugin; nothing needs installing. It reads the Claude Code logs on this computer
(and Codex logs with `--codex`), adds up the tokens per model and month, and asks easiapiai.com what that usage
costs at every seller. Only the model names, months and token totals are sent; prompts, code, file names and
keys never leave the computer, and easiapiai stores nothing.

1. If the user did not ask for this directly (they did if they ran /easiapiai:bill), tell them in one line what
   will be sent and ask once before running.
2. Run the first of these that works (Node 18+, else Python 3.9+; on Windows `py` instead of `python3`):

   ```
   node "${CLAUDE_PLUGIN_ROOT}/js/easiapiai.mjs" bill
   ```
   ```
   PYTHONPATH="${CLAUDE_PLUGIN_ROOT}/src" python3 -m easiapiai bill
   ```

   Options the user may want: `--codex` (Codex usage too), `--seller "<name>"` (the seller they pay today; the
   default is Anthropic / OpenAI), `--dry-run` (show the totals, send nothing).
   If neither Node nor Python is available, follow the agent steps at https://easiapiai.com/bill instead.
3. Answer briefly, from the tool's output only; never estimate, add up or invent numbers yourself. Lead with
   the tool's closing "Total at list prices ..." line. Then name the models where a verified seller is cheaper
   than the list price, with that seller, the saving and the model's link; if there are none, say so in one line.
   Offer the full per-month list rather than printing it. If the user is on a subscription plan (Claude Pro/Max,
   ChatGPT plans), add that the figures are what the same usage costs at API prices, not what they paid.
4. Models the tool lists as "not priced" have no exact match on easiapiai; say so rather than guessing a price.
