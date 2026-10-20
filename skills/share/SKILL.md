---
name: share
description: Share the user's LLM API usage with easiapiai.com as numbers only (seller, model, month, token, request and error counts, optionally what they paid), never keys or prompts, to help show which API sellers people actually use and how they hold up. Also turns automatic weekly sharing on or off. Use when the user asks to share or contribute their usage, to stop or start automatic sharing, or runs /easiapiai:share.
---

# Share my usage

easiapiai pools usage numbers from many people: which sellers and models they use, how many tokens, requests and
errors, what they paid. Nothing is shown until 3 different people have shared the same seller. Only numbers are
sent: never a key, a prompt, a reply, code, a file name or a project name.

## With Node.js (the usual way)

The tool in this plugin finds the numbers on this computer (Claude Code and Codex logs, opencode and Cline data,
and the OpenRouter activity report when `OPENROUTER_MANAGEMENT_KEY` is set) and shows them before anything is sent:

1. Show the user what would be sent, and the sources it came from:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/js/easiapiai.mjs" share --dry-run
   ```
   (`share --json` prints the exact request bodies instead; neither sends anything.)
2. Send only after the user agrees:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/js/easiapiai.mjs" share --yes
   ```
   It prints how many rows were saved. Rows listed as not saved name a seller or model easiapiai does not know;
   the suggestions are the names it knows.
3. Automatic sharing (about once a week, while this plugin is installed), only when the user asks for it:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/js/easiapiai.mjs" sharing on       # agree; also sends now
   node "${CLAUDE_PLUGIN_ROOT}/js/easiapiai.mjs" sharing off      # stop
   node "${CLAUDE_PLUGIN_ROOT}/js/easiapiai.mjs" sharing status   # the setting and when numbers were last sent
   ```

Usage the tool cannot see (another seller's dashboard or usage export) can be added by hand with the steps below.

## Without Node.js, or for other sellers (by hand)

1. Find out which API sellers the user pays for: ask, or look at their projects for base URLs and model ids (config
   files, environment variable NAMES, the code that builds the client). Never read out, print, store or send a key.
2. Get the numbers per seller, model and month from a usage export the user downloads from the seller's dashboard
   (ask for the file and add it up per model and month), the seller's usage API called on this computer with the
   user's key, or numbers the user reads off the dashboard. Never guess a number.
3. Build the request and show it to the user exactly as it will be sent. Send only after they agree.
   ```
   {"source": "export" | "usage_api" | "manual", "client": "agent",
    "contributor": "<id>",
    "rows": [{"seller": "<name as on easiapiai>", "model": "<model name or id>", "month": "YYYY-MM",
              "input_tokens": <int>, "output_tokens": <int>, "cached_input_tokens": <int, optional>,
              "requests": <int, optional>, "cost_usd": <what they paid, optional>}]}
   ```
   `contributor` is the random id kept in `~/.config/easiapiai/contributor_id` (create it with 32 random hex
   characters if it does not exist), so sending again replaces this person's rows instead of counting twice.
   At most 50 rows per request.
4. Send it (curl is on macOS, Linux and Windows 10+):
   ```
   curl -s -X POST https://easiapiai.com/api/usage/share -H "Content-Type: application/json" --data @<file with the JSON>
   ```
5. Tell the user how many rows were saved. Rows under `unmatched` were not saved; the reply suggests the right
   seller or model name: fix the name and send those rows again. Their numbers appear only as totals, once 3
   people have shared the same seller: https://easiapiai.com/share
