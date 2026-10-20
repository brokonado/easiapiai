# Contributing

Thanks for helping. A few rules keep this tool small and trustworthy:

- **No dependencies.** Node 18+ built-ins only (`js/`), Python 3.9+ standard library only (`src/`), so the tool
  stays fast and auditable.
- **Never commit real logs.** Usage logs contain your prompts and code. Tests use small synthetic files
  (`js/test/`, `tests/helpers.py`); if a log format changes, add a synthetic line that shows the new shape.
- **Readers take numbers only.** A new source (another coding tool's logs, a provider's usage report) reads only
  token, request, error, cost, provider, model and time fields, never text, and follows the token rule at the top
  of `js/readers/index.mjs`.
- **Nothing new leaves the machine without saying so.** If a change sends a new field anywhere, update the
  `--help` text, `docs/DETAILS.md` and the table in the README in the same change.
- **No invented numbers** in docs or output. Example output uses made-up inputs and says so.
- **Keys:** read only from the environment variable the user names, sent only to the provider's base URL, never
  printed or logged.

Run the tests:

```
npm test                                   # Node
python -m unittest discover -s tests       # Python
```

Wrong prices, missing sellers or models: tell us at https://easiapiai.com (prices are maintained there, not in
this repository). Codex users: a comparison of `easiapiai bill --codex --dry-run` with Codex's own token counts
is especially welcome, since the Codex reader has not yet been checked against real logs. The same goes for
the opencode, Kilo Code and Cline readers, which were built from those tools' source code.
