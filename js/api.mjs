// The easiapiai HTTP API: JSON in, JSON out. No keys, no cookies.
import { HTTPError, URLError, open, readBody } from "./http.mjs";
import { isDict, jsonDumps, pyStr, truthy, urlencode, urlsplit } from "./py.mjs";
import { CLIENT } from "./version.mjs";

export const DEFAULT_API = "https://easiapiai.com";
export const USER_AGENT = CLIENT + " (+https://easiapiai.com)";

// The API (or the network) said no. .status is the HTTP status (null for network errors); .data is the decoded
// JSON error body, if any.
export class ApiError extends Error {
  constructor(message, status = null, data = null) {
    super(message);
    this.status = status;
    this.data = isDict(data) ? data : {};
  }
}

export function url(base, path, query = null) {
  const out = base.replace(/\/+$/, "") + path;
  return out + (query && Object.keys(query).length ? "?" + urlencode(query) : "");
}

// JSON text in UTF-8 -> value, or null (a byte order mark or invalid UTF-8 is not JSON, as in Python)
export function loads(raw) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw));
  } catch {
    return null;
  }
}

// Send one request to the easiapiai API and return the decoded JSON object.
export async function call(method, fullUrl, body = null, timeout = 60) {
  const host = urlsplit(fullUrl).netloc || fullUrl;
  const data = body === null ? null : Buffer.from(jsonDumps(body), "utf-8");
  const headers = { Accept: "application/json", "User-Agent": USER_AGENT };
  if (data !== null) headers["Content-Type"] = "application/json";
  let raw;
  try {
    const res = await open(method, fullUrl, { body: data, headers, timeout, redirects: true });
    raw = await readBody(res);
  } catch (err) {
    if (err instanceof HTTPError) {
      const obj = loads(await readBody(err.response));
      const msg = isDict(obj) ? obj.error ?? null : null;
      throw new ApiError(truthy(msg) ? pyStr(msg) : `HTTP ${err.status} from ${host}`, err.status, obj);
    }
    if (err instanceof URLError) throw new ApiError(`could not reach ${host}: ${err.reason}`);
    throw err;
  }
  const obj = loads(raw);
  if (!isDict(obj)) throw new ApiError(`unexpected answer from ${host} (not a JSON object)`);
  return obj;
}
