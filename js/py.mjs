// The small pieces of Python behaviour the Python client relies on (truthiness, str() and repr(), json.dumps,
// number formatting, str.strip, urllib.parse), written out so that both clients print and send exactly the same
// thing. Only what the client needs; each function names the Python behaviour it follows.
import net from "node:net";

export function isDict(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function has(d, key) {
  return Object.prototype.hasOwnProperty.call(d, key);
}

function typeName(v) {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return "str";
  return Array.isArray(v) ? "list" : "dict";
}

// bool(v) for a value decoded from JSON: None, False, 0, "", [] and {} are false
export function truthy(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string" || Array.isArray(v)) return v.length > 0;
  return Object.keys(v).length > 0;
}

// `a or b`
export function or(a, b) {
  return truthy(a) ? a : b;
}

// d.get(key) on a decoded JSON object: null when the key is missing. Like Python it fails on a value that is not
// an object, so malformed input stops both clients alike instead of being read two different ways.
export function get(d, key) {
  if (!isDict(d)) throw new TypeError(`'${typeName(d)}' object has no attribute 'get'`);
  return has(d, key) ? d[key] : null;
}

// iter(v) for a decoded JSON value: a list, the characters of a string, the keys of an object
export function iterate(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return Array.from(v);
  if (isDict(v)) return Object.keys(v);
  throw new TypeError(`'${typeName(v)}' object is not iterable`);
}

// a + b for the numbers in an API answer (bool counts as 0 or 1, as in Python); anything else fails, as in Python
export function add(a, b) {
  for (const v of [a, b]) {
    if (typeof v !== "number" && typeof v !== "boolean") {
      throw new TypeError(`unsupported operand type(s) for +: '${typeName(a)}' and '${typeName(b)}'`);
    }
  }
  return Number(a) + Number(b);
}

// ------------------------------------------------------------------ str() and repr()

// str() of a number decoded from JSON. Whole numbers print as integers (once decoded, JavaScript cannot tell 3 from
// 3.0); other values print like Python's float repr: 1.5, 0.0001, 1e-05, 1e+16, inf, nan.
export function numStr(x) {
  if (Number.isInteger(x)) return BigInt(x).toString();
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  // both languages print the shortest digits that read back as the same number; only the layout differs
  const [mantissa, expText] = x.toExponential().split("e");
  const exp = Number(expText);
  const sign = mantissa.startsWith("-") ? "-" : "";
  const digits = mantissa.replace("-", "").replace(".", "");
  const point = exp + 1; // where the decimal point goes, counted in digits
  if (point > -4 && point <= 16) {
    if (point <= 0) return sign + "0." + "0".repeat(-point) + digits;
    if (point >= digits.length) return sign + digits + "0".repeat(point - digits.length) + ".0";
    return sign + digits.slice(0, point) + "." + digits.slice(point);
  }
  const rest = digits.length > 1 ? "." + digits.slice(1) : "";
  return sign + digits[0] + rest + "e" + (exp < 0 ? "-" : "+") + String(Math.abs(exp)).padStart(2, "0");
}

const NOT_PRINTABLE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;

// repr() of a str: single quotes unless the text has a ' and no ", backslash escapes for what is not printable
export function reprStr(s) {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === quote || ch === "\\") out += "\\" + ch;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (cp < 0x20 || cp === 0x7f) out += "\\x" + cp.toString(16).padStart(2, "0");
    else if (cp < 0x7f || ch === " " || !NOT_PRINTABLE.test(ch)) out += ch;
    else if (cp < 0x100) out += "\\x" + cp.toString(16).padStart(2, "0");
    else if (cp < 0x10000) out += "\\u" + cp.toString(16).padStart(4, "0");
    else out += "\\U" + cp.toString(16).padStart(8, "0");
  }
  return out + quote;
}

// str(v), as "%s" % v prints it
export function pyStr(v) {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return numStr(v);
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  return "{" + Object.keys(v).map((k) => reprStr(k) + ": " + pyRepr(v[k])).join(", ") + "}";
}

// repr(v), as "%r" % v prints it
export function pyRepr(v) {
  return typeof v === "string" ? reprStr(v) : pyStr(v);
}

// ------------------------------------------------------------------ json.dumps

// json.dumps(v) (indent null: ", " and ": " between items) or json.dump(v, fp, indent=n), with Python's default
// ensure_ascii: every character outside printable ASCII is written as a \uXXXX escape.
export function jsonDumps(v, indent = null) {
  return dump(v, indent, 0);
}

function jsonString(s) {
  return JSON.stringify(s).replace(/[\u007f-￿]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

function dump(v, indent, level) {
  if (v === null || v === undefined) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "NaN";
    if (v === Infinity) return "Infinity";
    if (v === -Infinity) return "-Infinity";
    return numStr(v);
  }
  if (typeof v === "string") return jsonString(v);
  const list = Array.isArray(v);
  const items = list ? v.map((x) => dump(x, indent, level + 1))
    : Object.keys(v).map((k) => jsonString(k) + ": " + dump(v[k], indent, level + 1));
  const [open, close] = list ? ["[", "]"] : ["{", "}"];
  if (!items.length) return open + close;
  if (indent === null) return open + items.join(", ") + close;
  const pad = "\n" + " ".repeat(indent * (level + 1));
  return open + pad + items.join("," + pad) + "\n" + " ".repeat(indent * level) + close;
}

// ------------------------------------------------------------------ number formatting

function group(intDigits) {
  return intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// True when x * 10**digits lies exactly halfway between two integers. Python rounds those halves to the even
// neighbour; JavaScript's toFixed rounds them up. Decided on the exact binary value of x.
function exactHalf(x, digits) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const expBits = (hi >>> 20) & 0x7ff;
  let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let exp;
  if (expBits === 0) {
    exp = -1074;
  } else {
    mantissa |= 1n << 52n;
    exp = expBits - 1075;
  }
  if (exp >= 0) return false; // a whole number
  const twice = 2n * mantissa * 10n ** BigInt(digits);
  const scale = 1n << BigInt(-exp);
  return twice % scale === 0n && (twice / scale) % 2n === 1n;
}

// "{:,.Nf}".format(x)
export function formatFixed(x, digits) {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const negative = x < 0 || Object.is(x, -0);
  const a = Math.abs(x);
  let s;
  if (a >= 1e21) {
    s = BigInt(a).toString() + (digits ? "." + "0".repeat(digits) : "");
  } else {
    s = a.toFixed(digits);
    if (exactHalf(a, digits)) {
      // toFixed went up; Python keeps the even one of the two neighbours
      let n = BigInt(s.replace(".", ""));
      if (n % 2n === 1n) n -= 1n;
      const t = n.toString().padStart(digits + 1, "0");
      s = digits ? t.slice(0, t.length - digits) + "." + t.slice(t.length - digits) : t;
    }
  }
  const [whole, frac] = s.split(".");
  return (negative ? "-" : "") + group(whole) + (frac !== undefined ? "." + frac : "");
}

// "{:,}".format(int(v)) for a whole number
export function formatInt(v) {
  const s = BigInt(v).toString();
  return s.startsWith("-") ? "-" + group(s.slice(1)) : group(s);
}

// ------------------------------------------------------------------ strings

// str.isspace() characters, for str.strip() with no argument (not the same set as String.prototype.trim)
const SPACE = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const STRIP = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, "g");

export function strip(s) {
  return s.replace(STRIP, "");
}

// s.strip(chars)
export function stripChars(s, chars) {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

// len(s): Python counts code points, JavaScript counts UTF-16 units
export function pyLen(s) {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

export function ljust(s, width) {
  return s + " ".repeat(Math.max(0, width - pyLen(s)));
}

export function rjust(s, width) {
  return " ".repeat(Math.max(0, width - pyLen(s))) + s;
}

// s[:n] by code points
export function head(s, n) {
  let out = "";
  let i = 0;
  for (const ch of s) {
    if (i++ >= n) break;
    out += ch;
  }
  return out;
}

// how Python's sorted() orders two strings: by code point (JavaScript's < compares UTF-16 units)
export function compareStr(a, b) {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done || y.done) return x.done ? (y.done ? 0 : -1) : 1;
    const cx = x.value.codePointAt(0);
    const cy = y.value.codePointAt(0);
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

const DIGIT = /\p{Nd}/u;

// Python's int() and float() take the decimal digits of any script ("٣" is 3). Unicode encodes each set of ten in
// a row from zero, so a digit's value is its distance from the start of its run, modulo 10.
function asciiDigits(s) {
  return s.replace(/\p{Nd}/gu, (ch) => {
    const cp = ch.codePointAt(0);
    let start = cp;
    while (DIGIT.test(String.fromCodePoint(start - 1))) start--;
    return String((cp - start) % 10);
  });
}

// int(s) for a command-line value: surrounding whitespace, a sign, decimal digits with single underscores between
// them. null where Python raises ValueError.
export function parseIntArg(s) {
  const t = asciiDigits(strip(s));
  if (!/^[+-]?\d+(?:_\d+)*$/.test(t)) return null;
  return Number(t.replace(/_/g, ""));
}

// float(s) for a command-line value. null where Python raises ValueError.
export function parseFloatArg(s) {
  const t = asciiDigits(strip(s));
  if (/^[+-]?(?:inf|infinity|nan)$/i.test(t)) {
    if (/nan/i.test(t)) return NaN;
    return t.startsWith("-") ? -Infinity : Infinity;
  }
  const digits = "\\d(?:_?\\d)*";
  const pattern = new RegExp(`^[+-]?(?:${digits}(?:\\.(?:${digits})?)?|\\.${digits})(?:[eE][+-]?${digits})?$`);
  if (!pattern.test(t)) return null;
  return Number(t.replace(/_/g, ""));
}

// ------------------------------------------------------------------ urllib.parse

function checkBracketedNetloc(netloc) {
  const hostAndPort = netloc.slice(netloc.lastIndexOf("@") + 1);
  const open = hostAndPort.indexOf("[");
  let hostname;
  if (open >= 0) {
    if (open > 0) throw new Error("Invalid IPv6 URL"); // nothing may come before the bracket
    const bracketed = hostAndPort.slice(open + 1);
    const close = bracketed.indexOf("]");
    hostname = close >= 0 ? bracketed.slice(0, close) : bracketed;
    const port = close >= 0 ? bracketed.slice(close + 1) : "";
    if (port && !port.startsWith(":")) throw new Error("Invalid IPv6 URL");
  } else {
    const colon = hostAndPort.indexOf(":");
    hostname = colon >= 0 ? hostAndPort.slice(0, colon) : hostAndPort;
  }
  if (hostname.startsWith("v")) {
    if (!/^v[a-fA-F0-9]+\..+$/.test(hostname)) throw new Error("IPvFuture address is invalid");
  } else if (net.isIPv4(hostname)) {
    throw new Error("An IPv4 address cannot be in brackets");
  } else if (!net.isIPv6(hostname)) {
    throw new Error(`${reprStr(hostname)} does not appear to be an IPv4 or IPv6 address`);
  }
}

function hostnameOf(netloc) {
  const hostinfo = netloc.slice(netloc.lastIndexOf("@") + 1);
  const open = hostinfo.indexOf("[");
  let hostname;
  if (open >= 0) {
    const bracketed = hostinfo.slice(open + 1);
    const close = bracketed.indexOf("]");
    hostname = close >= 0 ? bracketed.slice(0, close) : bracketed;
  } else {
    const colon = hostinfo.indexOf(":");
    hostname = colon >= 0 ? hostinfo.slice(0, colon) : hostinfo;
  }
  if (!hostname) return null;
  const zone = hostname.indexOf("%"); // a scoped IPv6 zone keeps its case
  return zone >= 0 ? hostname.slice(0, zone).toLowerCase() + hostname.slice(zone) : hostname.toLowerCase();
}

// urllib.parse.urlsplit(url), plus the .hostname property. Throws where Python raises ValueError.
export function urlsplit(url) {
  url = url.replace(/^[\x00-\x20]+/, "").replace(/[\t\r\n]/g, "");
  let scheme = "";
  let netloc = "";
  let query = "";
  let fragment = "";
  const colon = url.indexOf(":");
  if (colon > 0 && /^[A-Za-z]/.test(url) && /^[A-Za-z0-9+\-.]*$/.test(url.slice(0, colon))) {
    scheme = url.slice(0, colon).toLowerCase();
    url = url.slice(colon + 1);
  }
  if (url.slice(0, 2) === "//") {
    let end = url.length;
    for (const c of "/?#") {
      const at = url.indexOf(c, 2);
      if (at >= 0) end = Math.min(end, at);
    }
    netloc = url.slice(2, end);
    url = url.slice(end);
    const hasOpen = netloc.includes("[");
    const hasClose = netloc.includes("]");
    if (hasOpen !== hasClose) throw new Error("Invalid IPv6 URL");
    if (hasOpen && hasClose) checkBracketedNetloc(netloc);
  }
  const hash = url.indexOf("#");
  if (hash >= 0) {
    fragment = url.slice(hash + 1);
    url = url.slice(0, hash);
  }
  const q = url.indexOf("?");
  if (q >= 0) {
    query = url.slice(q + 1);
    url = url.slice(0, q);
  }
  return { scheme, netloc, path: url, query, fragment, hostname: hostnameOf(netloc) };
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

// urllib.parse.quote_plus(s): UTF-8, letters, digits and "_.-~" kept, space as "+"
export function quotePlus(s) {
  if (LONE_SURROGATE.test(s)) throw new TypeError("'utf-8' codec can't encode a surrogate");
  let out = "";
  for (const b of new TextEncoder().encode(s)) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9_.\-~]/.test(c)) out += c;
    else if (c === " ") out += "+";
    else out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

// urllib.parse.urlencode(query) for an object of plain values
export function urlencode(query) {
  return Object.keys(query).map((k) => quotePlus(pyStr(k)) + "=" + quotePlus(pyStr(query[k]))).join("&");
}

// urllib.parse.unquote(s): %XX escapes decoded as UTF-8, bad bytes replaced
export function unquote(s) {
  if (!s.includes("%")) return s;
  return s.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
    return new TextDecoder("utf-8").decode(bytes);
  });
}
