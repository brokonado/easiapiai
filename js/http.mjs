// HTTP requests made the way the Python client makes them with urllib.request, so that servers see the same thing
// and errors come out the same way:
// - the same headers (Accept-Encoding: identity, Connection: close, plus the caller's);
// - the timeout applies to each wait on the network (connecting, each read), as a socket timeout does in Python,
//   not to the request as a whole;
// - redirects are followed only when asked for (the easiapiai API, with urllib's rules); a provider call never
//   follows one, so the key in its Authorization header cannot be sent anywhere else.
import http from "node:http";
import https from "node:https";

import { reprStr, strip, unquote, urlsplit } from "./py.mjs";

// An answer outside 200-299 (urllib's HTTPError). The body can still be read from .response.
export class HTTPError extends Error {
  constructor(status, response) {
    super("HTTP Error " + status);
    this.status = status;
    this.response = response;
  }
}

// No answer: the network failed or the URL could not be used (urllib's URLError and the errors under it).
// .timedOut is true when a wait on the network took longer than the timeout.
export class URLError extends Error {
  constructor(reason, timedOut = false) {
    super(reason);
    this.reason = reason;
    this.timedOut = timedOut;
  }
}

// A value Python's urllib or socket module refuses with ValueError (a negative timeout, a URL without a scheme)
export class ValueError extends Error {}

const DISALLOWED = /[\x00-\x20\x7f]/; // what http.client refuses in a host or path

// Where a request goes, read from the URL as urllib.request.Request reads it
function target(fullUrl) {
  let url = strip(fullUrl);
  if (url.startsWith("<") && url.endsWith(">")) url = strip(url.slice(1, -1));
  if (url.startsWith("URL:")) url = strip(url.slice(4));
  const hash = url.lastIndexOf("#");
  if (hash >= 0) url = url.slice(0, hash);
  const m = /^([^/:]+):([\s\S]*)$/.exec(url);
  if (!m) throw new ValueError("unknown url type: " + reprStr(url));
  const scheme = m[1].toLowerCase();
  if (scheme !== "http" && scheme !== "https") throw new URLError("unknown url type: " + scheme);
  const h = /^\/\/([^/#?]*)([\s\S]*)$/.exec(m[2]);
  let host = h ? unquote(h[1]) : "";
  let path = h ? h[2] : m[2];
  if (h && path && !path.startsWith("/")) path = "/" + path;
  path = path || "/";
  if (!host) throw new URLError("no host given");
  // host[:port], as http.client splits it
  let port = scheme === "https" ? 443 : 80;
  const colon = host.lastIndexOf(":");
  if (colon > host.lastIndexOf("]")) {
    const text = host.slice(colon + 1);
    if (text !== "") {
      if (!/^\s*\+?\d+(?:_\d+)*\s*$/.test(text)) throw new URLError(`nonnumeric port: '${text}'`);
      port = Number(text.replace(/_/g, ""));
    }
    host = host.slice(0, colon);
  }
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (DISALLOWED.test(host)) throw new URLError(`URL can't contain control characters. '${host}'`);
  if (DISALLOWED.test(path)) throw new URLError(`URL can't contain control characters. '${path}'`);
  return { scheme, host, port, path };
}

// the timeout in milliseconds for a socket; throws where Python's socket.settimeout() does
function socketTimeout(seconds) {
  if (Number.isNaN(seconds)) throw new ValueError("Invalid value NaN (not a number)");
  if (seconds < 0) throw new ValueError("Timeout value out of range");
  // Python keeps the timeout in 64-bit nanoseconds; beyond that it raises OverflowError (not caught anywhere)
  if (seconds * 1e9 >= 2 ** 63) throw new RangeError("timestamp out of range for platform time_t");
  const ms = seconds * 1000;
  return ms > 2147483647 ? null : ms; // longer than Node.js timers allow: no timeout, in effect
}

// One request; resolves with the response once its headers are in (any status). Rejects with URLError or
// ValueError.
export function send(method, fullUrl, { body = null, headers = {}, timeout = 60 } = {}) {
  return new Promise((resolve, reject) => {
    let t;
    let ms;
    try {
      t = target(fullUrl);
      ms = socketTimeout(timeout);
    } catch (err) {
      reject(err);
      return;
    }
    if (ms === 0) {
      // Python's timeout 0 makes the socket non-blocking, and connecting fails at once
      reject(new URLError("Operation now in progress"));
      return;
    }
    const allHeaders = { "Accept-Encoding": "identity", ...headers };
    if (body !== null) allHeaders["Content-Length"] = String(body.length);
    allHeaders.Connection = "close";
    // autoSelectFamily: try every address of the host, as Python does (on Node.js 18 "localhost" would
    // otherwise mean only ::1, and a local provider listening on 127.0.0.1 would be unreachable)
    const options = {
      method, host: t.host, port: t.port, path: t.path, headers: allHeaders, agent: false, autoSelectFamily: true,
    };
    if (ms !== null) options.timeout = ms;
    let req;
    try {
      req = (t.scheme === "https" ? https : http).request(options);
    } catch (err) {
      reject(new URLError(err.message)); // an invalid header value or path
      return;
    }
    req.on("timeout", () => req.destroy(new URLError("timed out", true)));
    req.on("error", (err) => reject(err instanceof URLError ? err : new URLError(err.message, err.code === "ETIMEDOUT")));
    req.on("response", (res) => {
      res.request = req;
      resolve(res);
    });
    req.end(body === null ? undefined : body);
  });
}

// The whole body of a response. Rejects with URLError if the connection fails or times out while reading.
export function readBody(res) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let failed = null;
    const fail = (err) => {
      if (failed) return;
      failed = err instanceof URLError ? err : new URLError(err.message, err.code === "ETIMEDOUT");
      reject(failed);
    };
    res.request.on("error", fail);
    res.on("error", fail);
    res.on("aborted", () => fail(new URLError("connection closed before the whole answer arrived")));
    res.on("data", (chunk) => parts.push(chunk));
    res.on("end", () => {
      if (!failed) resolve(Buffer.concat(parts));
    });
  });
}

// Lets go of a response without reading it
export function discard(res) {
  res.on("error", () => {});
  res.request.on("error", () => {});
  res.destroy();
}

const REDIRECTS = [301, 302, 303, 307, 308];

// A request whose answer must be in 200-299, following redirects as urllib's default opener does: GET and HEAD
// follow 301, 302, 303, 307 and 308; POST follows 301, 302 and 303 as a GET without the body; at most 10 redirects
// and 4 visits of one URL. Rejects with HTTPError for any other answer.
export async function open(method, fullUrl, { body = null, headers = {}, timeout = 60, redirects = false } = {}) {
  const visited = new Map();
  for (;;) {
    const res = await send(method, fullUrl, { body, headers, timeout });
    const code = res.statusCode;
    if (code >= 200 && code < 300) return res;
    const location = res.headers.location ?? res.headers.uri;
    if (!redirects || !REDIRECTS.includes(code) || location === undefined) throw new HTTPError(code, res);
    const scheme = urlsplit(location).scheme;
    if (!["http", "https", "ftp", ""].includes(scheme)) throw new HTTPError(code, res);
    const allowed = (["GET", "HEAD"].includes(method)) || ([301, 302, 303].includes(code) && method === "POST");
    if (!allowed) throw new HTTPError(code, res);
    const next = new URL(location, fullUrl).href;
    if (visited.size && ((visited.get(next) ?? 0) >= 4 || visited.size >= 10)) throw new HTTPError(code, res);
    visited.set(next, (visited.get(next) ?? 0) + 1);
    await readBody(res).catch(() => {});
    // the redirected request: a GET (HEAD stays HEAD) without the body and its headers
    method = method === "HEAD" ? "HEAD" : "GET";
    body = null;
    headers = Object.fromEntries(Object.entries(headers)
      .filter(([k]) => !["content-length", "content-type"].includes(k.toLowerCase())));
    fullUrl = next;
  }
}
