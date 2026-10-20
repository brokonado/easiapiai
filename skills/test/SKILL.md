---
name: test
description: Test an LLM API provider the user already uses (any OpenAI-compatible seller of DeepSeek, Qwen, GLM, Llama, etc.) with a short exact-answer quiz from easiapiai.com, run on this computer with the user's own key, and add the graded answers to easiapiai's public provider-accountability results. Use when the user asks to test or check their provider or seller, or runs /easiapiai:test.
---

# Test my provider

easiapiai asks 10 questions that have exact answers (grade-school maths, multiple choice). This computer sends
them to the user's provider with the user's key; only the provider's raw answers go to easiapiai, which grades
them. Pooled results are published once there are 300 answers from 5 different people, with a right of reply
for the seller. One run on its own proves nothing either way; never present it as an accusation.

1. Work out, from what the user said and their project (config files, `.env` names, code that builds the
   client), these five things. Ask only for what you cannot find:
   - the seller's name as easiapiai lists it (e.g. "DeepInfra", "Together", "RunInfra");
   - the OpenAI-compatible base URL (e.g. `https://api.deepinfra.com/v1/openai`);
   - the model id at that provider (what goes in the request's `model` field);
   - the model's name on easiapiai: look it up with the easiapiai `search_models` tool from this plugin;
   - the name of the environment variable that holds the key.
2. The key: never ask the user to paste it into the chat, and never print, log or write its value. If it is
   only in a `.env` file, ask the user to export it in the shell that runs Claude Code, or load that file for
   this one command without showing it.
3. Tell the user it costs their provider at most a few cents (10 requests, at most 2048 output tokens each),
   then run the first of these that works (Node 18+, else Python 3.9+):

   ```
   node "${CLAUDE_PLUGIN_ROOT}/js/easiapiai.mjs" test --model "<name on easiapiai>" --base-url "<base URL>" --provider-model "<model id>" --seller "<seller>" --key-env <VARIABLE>
   ```
   ```
   PYTHONPATH="${CLAUDE_PLUGIN_ROOT}/src" python3 -m easiapiai test --model "<name on easiapiai>" --base-url "<base URL>" --provider-model "<model id>" --seller "<seller>" --key-env <VARIABLE>
   ```

   Add `--official` when the seller is the model's own developer (e.g. DeepSeek's own API for a DeepSeek
   model). If the first question fails with a set-up error (wrong key, URL or model id), the tool stops and
   sends nothing; fix the setting and run it again.
4. Report the score and the results link from the tool's output, and that results are published only at 300
   answers from 5 people.
