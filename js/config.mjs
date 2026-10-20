// The small files easiapiai keeps on this computer, in ~/.config/easiapiai (or $XDG_CONFIG_HOME/easiapiai, or
// $EASIAPIAI_CONFIG_DIR when set): install_id (the test command's), contributor_id (usage sharing) and
// sharing.json (whether the user agreed to automatic sharing). Nothing else.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { homeDir, joinPath } from "./files.mjs";
import { isDict, strip } from "./py.mjs";

export function configDir(environ = null) {
  environ = environ ?? process.env;
  if (environ.EASIAPIAI_CONFIG_DIR) return environ.EASIAPIAI_CONFIG_DIR;
  const base = environ.XDG_CONFIG_HOME || joinPath(homeDir(), ".config");
  return joinPath(base, "easiapiai");
}

// Writes a file whole or not at all (a second session reading it at the same moment never sees half of it)
export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, "utf-8");
  fs.renameSync(tmp, file);
}

const CONTRIBUTOR = /^[A-Za-z0-9._-]{8,64}$/; // what the server accepts

// A random id kept in contributor_id, created on first use: sending again replaces this person's rows on
// easiapiai instead of counting them twice. 32 random hex characters; it says nothing about you.
export function contributorId(dir = null) {
  const file = joinPath(dir || configDir(), "contributor_id");
  try {
    const id = strip(fs.readFileSync(file, "utf-8"));
    if (CONTRIBUTOR.test(id)) return id;
  } catch {
    // missing or unreadable: make one
  }
  const fresh = crypto.randomBytes(16).toString("hex");
  try {
    writeAtomic(file, fresh + "\n");
  } catch {
    process.stderr.write(`note: could not save ${file}; this run uses a one-off contributor id\n`);
  }
  return fresh;
}

// sharing.json: {"auto": true|false (missing: not decided), "decided_at", "last_sent", "asked", "asked_at"}
export function loadSharing(dir = null) {
  const out = { auto: null, decided_at: null, last_sent: null, asked: 0, asked_at: null };
  try {
    const data = JSON.parse(fs.readFileSync(joinPath(dir || configDir(), "sharing.json"), "utf-8"));
    if (isDict(data)) {
      if (typeof data.auto === "boolean") out.auto = data.auto;
      for (const k of ["decided_at", "last_sent", "asked_at"]) if (typeof data[k] === "string") out[k] = data[k];
      if (Number.isInteger(data.asked) && data.asked >= 0) out.asked = data.asked;
    }
  } catch {
    // missing or damaged: not decided
  }
  return out;
}

export function saveSharing(state, dir = null) {
  writeAtomic(joinPath(dir || configDir(), "sharing.json"), JSON.stringify(state, null, 1) + "\n");
}
