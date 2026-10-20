#!/usr/bin/env node
// easiapiai: price your real LLM token usage at every seller of the same model, and help check what LLM API
// providers actually serve. Node.js 18+, built-in modules only. https://easiapiai.com
import { main } from "./cli.mjs";

// A closed pipe (for example `easiapiai --help | head -1`) is not an error worth a stack trace
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err) => {
    if (err.code !== "EPIPE") throw err;
  });
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
