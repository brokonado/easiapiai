// Finding and reading log files the way the Python client does (os.path.join, glob.glob(..., recursive=True),
// open(..., encoding="utf-8", errors="replace")), so that both clients read the same files and see the same lines.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const WINDOWS = process.platform === "win32";
const SEP = WINDOWS ? "\\" : "/";

function endsWithSep(p) {
  return p.endsWith("/") || (WINDOWS && p.endsWith("\\"));
}

// os.path.join: parts are joined with the separator, not normalised. Python keeps "/a//b" as it is, so a folder
// named twice in two spellings is read twice by both clients.
export function joinPath(first, ...rest) {
  let out = first;
  for (const part of rest) {
    if (!out || (WINDOWS ? path.win32.isAbsolute(part) : part.startsWith("/"))) out = part;
    else if (endsWithSep(out)) out += part;
    else out += SEP + part;
  }
  return out;
}

// os.path.expanduser("~"): $HOME on macOS and Linux (an empty $HOME means "/"), the user profile on Windows
export function homeDir() {
  if (!WINDOWS && process.env.HOME !== undefined) return process.env.HOME.replace(/\/+$/, "") || "/";
  return os.homedir();
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// The names in a folder, in the order the file system lists them (as os.scandir does); with dirsOnly, only the
// folders, symlinked folders included. A folder that cannot be listed gives what was listed before the error.
function listNames(dir, dirsOnly) {
  let handle;
  try {
    handle = fs.opendirSync(dir);
  } catch {
    return [];
  }
  const names = [];
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      if (!dirsOnly) {
        names.push(entry.name);
        continue;
      }
      let folder = entry.isDirectory();
      const known = entry.isFile() || folder || entry.isSymbolicLink() || entry.isFIFO() || entry.isSocket()
        || entry.isBlockDevice() || entry.isCharacterDevice();
      if (!folder && (entry.isSymbolicLink() || !known)) folder = isDirectory(joinPath(dir, entry.name));
      if (folder) names.push(entry.name);
    }
  } catch {
    // keep what was listed
  } finally {
    try {
      handle.closeSync();
    } catch {
      // already closed
    }
  }
  return names;
}

// The paths glob.glob(os.path.join(root, "**", pattern), recursive=True) returns, in the same order: the folder's
// own matching files first, then each sub-folder depth first. Names starting with "." are skipped, files and
// folders alike, as Python's glob does. `match` tests a file name (matching is case-insensitive on Windows, as
// fnmatch is there).
export function globTree(root, match) {
  const out = [];
  const test = WINDOWS ? (name) => match(name.toLowerCase()) : match;
  const walk = (dir) => {
    for (const name of listNames(dir, false)) {
      if (!name.startsWith(".") && test(name)) out.push(joinPath(dir, name));
    }
    for (const name of listNames(dir, true)) {
      if (!name.startsWith(".")) walk(joinPath(dir, name));
    }
  };
  if (isDirectory(root)) walk(root);
  return out;
}

// Opens a file for reading. Like Python's open(), a folder is an error rather than an empty file.
export function openFile(p) {
  const fd = fs.openSync(p, "r");
  try {
    if (fs.fstatSync(fd).isDirectory()) {
      const err = new Error(`Is a directory: '${p}'`);
      err.code = "EISDIR";
      throw err;
    }
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
  return fd;
}

const CHUNK = 1 << 20;

// The bytes of an open file, a chunk at a time, so that large logs are never held in memory whole
export function* fileChunks(fd) {
  const buf = Buffer.allocUnsafe(CHUNK);
  for (;;) {
    const n = fs.readSync(fd, buf, 0, CHUNK, null);
    if (n === 0) return;
    yield buf.subarray(0, n);
  }
}

// The lines of a text as Python's open(..., encoding="utf-8", errors="replace") yields them: invalid bytes become
// U+FFFD, a byte order mark is kept (so a first line that starts with one is not valid JSON, as in Python), and
// "\r\n" or a lone "\r" ends a line just like "\n" (universal newlines). Each line ends with "\n" except perhaps
// the last.
export function* textLines(chunks) {
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const ends = /\r\n|\r|\n/g;
  let pending = "";
  const take = function* (final) {
    let start = 0;
    ends.lastIndex = 0;
    for (let m = ends.exec(pending); m !== null; m = ends.exec(pending)) {
      if (!final && m[0] === "\r" && m.index === pending.length - 1) break; // a "\n" may follow in the next chunk
      yield pending.slice(start, m.index) + "\n";
      start = m.index + m[0].length;
    }
    pending = pending.slice(start);
  };
  for (const chunk of chunks) {
    const text = decoder.decode(chunk, { stream: true });
    if (!text) continue;
    // a long line spread over many chunks: only look for line ends in the new text
    if (!/[\r\n]/.test(text) && !pending.endsWith("\r")) {
      pending += text;
      continue;
    }
    pending += text;
    yield* take(false);
  }
  pending += decoder.decode();
  yield* take(true);
  if (pending) yield pending;
}

// ------------------------------------------------------------------ zstd (Codex .jsonl.zst rollouts)

export const CAN_ZSTD = typeof zlib.zstdDecompressSync === "function"; // Node.js 22.15+

// Splits a .zst file into its frames, so that a file of several frames is read whole, as Python's zstd module
// reads it (zlib.zstdDecompressSync stops after the first frame). Returns [frames, rest]: the zstd frames found
// and whatever follows them that is not a complete frame.
function zstdFrames(buf) {
  const frames = [];
  let at = 0;
  while (at + 8 <= buf.length) {
    const magic = buf.readUInt32LE(at);
    if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) { // a skippable frame: no data
      const end = at + 8 + buf.readUInt32LE(at + 4);
      if (end > buf.length) break;
      at = end;
      continue;
    }
    if (magic !== 0xfd2fb528) break;
    const descriptor = buf[at + 4];
    const singleSegment = (descriptor >> 5) & 1;
    const checksum = (descriptor >> 2) & 1;
    const dictSize = [0, 1, 2, 4][descriptor & 3];
    const sizeFlag = descriptor >> 6;
    const contentSize = sizeFlag === 0 ? singleSegment : [0, 2, 4, 8][sizeFlag];
    let pos = at + 5 + (singleSegment ? 0 : 1) + dictSize + contentSize;
    let last = false;
    while (!last && pos + 3 <= buf.length) {
      const header = buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16);
      last = (header & 1) === 1;
      const type = (header >> 1) & 3;
      if (type === 3) return [frames, buf.subarray(at)]; // reserved: not a valid frame
      pos += 3 + (type === 1 ? 1 : header >>> 3);
    }
    pos += checksum ? 4 : 0;
    if (!last || pos > buf.length) break; // cut short
    frames.push(buf.subarray(at, pos));
    at = pos;
  }
  return [frames, buf.subarray(at)];
}

// The decompressed chunks of a .zst file, frame by frame. Like Python's zstd module: an error in the first frame is
// an error; data after a complete frame that is not a readable frame is ignored; a frame that is cut short gives
// what could be decompressed.
export function* zstdChunks(fd) {
  const parts = [];
  for (const chunk of fileChunks(fd)) parts.push(Buffer.from(chunk));
  const [frames, rest] = zstdFrames(Buffer.concat(parts));
  for (const frame of frames) yield zlib.zstdDecompressSync(frame);
  if (rest.length) {
    if (!frames.length) {
      yield zlib.zstdDecompressSync(rest);
    } else {
      try {
        yield zlib.zstdDecompressSync(rest);
      } catch {
        // trailing data that is not a valid frame: ignored, as Python does
      }
    }
  }
}
