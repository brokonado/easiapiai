# Contributing

Thanks for helping. A few rules keep this tool small and trustworthy:

- **Standard library only, Python 3.9+.** No dependencies, so `uvx easiapiai` stays fast and auditable.
- **Never commit real logs.** Usage logs contain your prompts and code. Tests use small synthetic files written
  by `tests/helpers.py`; if a log format changes, add a synthetic line that shows the new shape.
- **Nothing new leaves the machine without saying so.** If a change sends a new field anywhere, update the
  `--help` text and the Privacy section of the README in the same change.
- **No invented numbers** in docs or output. Example output uses made-up inputs and says so.
- **Keys:** read only from the environment variable the user names, sent only to the provider's base URL, never
  printed or logged.

Run the tests:

```
python -m unittest discover -s tests
```

Wrong prices, missing sellers or models: tell us at https://easiapiai.com (prices are maintained there, not in
this repository). Codex users: a comparison of `easiapiai bill --codex --dry-run` with Codex's own token counts
is especially welcome, since the Codex reader has not yet been checked against real logs.
