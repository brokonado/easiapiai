// The month of a log timestamp in local time, exactly as the Python client's month_of computes it:
// datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone().strftime("%Y-%m"), or "unknown".
//
// The parser follows CPython's C implementation of datetime.fromisoformat (Modules/_datetimemodule.c), which is the
// one Python actually runs, including its leniencies: it works on the UTF-8 bytes of the text, accepts any single
// character between date and time, and ignores some characters after the sixth digit of a fraction.

const MINYEAR = 1;
const MAXYEAR = 9999;
const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const DAYS_BEFORE_MONTH = [0, 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

function isLeap(y) {
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

function daysInMonth(y, m) {
  return m === 2 && isLeap(y) ? 29 : DAYS_IN_MONTH[m];
}

// days since 0001-01-01 (day 1), proleptic Gregorian, as datetime's toordinal()
function ymdToOrd(y, m, d) {
  const py = y - 1;
  return py * 365 + Math.floor(py / 4) - Math.floor(py / 100) + Math.floor(py / 400)
    + DAYS_BEFORE_MONTH[m] + (m > 2 && isLeap(y) ? 1 : 0) + d;
}

function divmod(a, b) {
  const q = Math.floor(a / b);
  return [q, a - q * b];
}

function ordToYmd(ord) {
  const DI400Y = 146097;
  const DI100Y = 36524;
  const DI4Y = 1461;
  let n = ord - 1;
  let n400;
  let n100;
  let n4;
  let n1;
  [n400, n] = divmod(n, DI400Y);
  let year = n400 * 400 + 1;
  [n100, n] = divmod(n, DI100Y);
  [n4, n] = divmod(n, DI4Y);
  [n1, n] = divmod(n, 365);
  year += n100 * 100 + n4 * 4 + n1;
  if (n1 === 4 || n100 === 4) return [year - 1, 12, 31];
  const leap = n1 === 3 && (n4 !== 24 || n100 === 3);
  let month = (n + 50) >> 5;
  let preceding = DAYS_BEFORE_MONTH[month] + (month > 2 && leap ? 1 : 0);
  if (preceding > n) {
    month -= 1;
    preceding -= DAYS_IN_MONTH[month] + (month === 2 && leap ? 1 : 0);
  }
  return [year, month, n - preceding + 1];
}

function isoWeek1Monday(year) {
  const first = ymdToOrd(year, 1, 1);
  const weekday = (first + 6) % 7;
  return first - weekday + (weekday > 3 ? 7 : 0);
}

// the date of ISO year/week/day, or null when Python rejects it
function isoToYmd(isoYear, week, day) {
  if (isoYear < MINYEAR || isoYear > MAXYEAR) return null;
  if (week <= 0 || week >= 53) {
    let outOfRange = true;
    if (week === 53) {
      const firstWeekday = (ymdToOrd(isoYear, 1, 1) + 6) % 7;
      if (firstWeekday === 3 || (firstWeekday === 2 && isLeap(isoYear))) outOfRange = false;
    }
    if (outOfRange) return null;
  }
  if (day <= 0 || day >= 8) return null;
  return ordToYmd(isoWeek1Monday(isoYear) + (week - 1) * 7 + day - 1);
}

// ------------------------------------------------------------------ the C parser, on bytes

const ZERO = 0x30;

function isDigit(c) {
  return c >= ZERO && c <= ZERO + 9;
}

// byte at i, or 0 past the end (the C code reads the terminating NUL there)
function at(b, i) {
  return i < b.length ? b[i] : 0;
}

// reads n digits at p into a number; [value, next position] or null
function digits(b, p, n) {
  let v = 0;
  for (let i = 0; i < n; i++) {
    const c = at(b, p++);
    if (!isDigit(c)) return null;
    v = v * 10 + (c - ZERO);
  }
  return [v, p];
}

function separatorLocation(b) {
  const len = b.length;
  const DASH = 0x2d;
  const W = 0x57;
  if (len === 7) return 7;
  if (at(b, 4) === DASH) {
    if (at(b, 5) === W) {
      if (len < 8) return -1;
      if (len > 8 && at(b, 8) === DASH) {
        if (len === 9) return -1;
        if (len > 10 && isDigit(at(b, 10))) return 8;
        return 10;
      }
      return 8;
    }
    return 10;
  }
  if (at(b, 4) === W) {
    let idx = 7;
    while (idx < len && isDigit(at(b, idx))) idx++;
    if (idx < 9) return idx;
    return idx % 2 === 0 ? 7 : 8;
  }
  return 8;
}

// -> [year, month, day] or null
function parseDate(b, len) {
  let r = digits(b, 0, 4);
  if (!r) return null;
  let [year, p] = r;
  const sep = at(b, p) === 0x2d;
  if (sep) p++;
  if (at(b, p) === 0x57) { // "W": an ISO week date
    p++;
    r = digits(b, p, 2);
    if (!r) return null;
    const week = r[0];
    p = r[1];
    let day = 1;
    if (p < len) {
      if (sep && at(b, p++) !== 0x2d) return null;
      r = digits(b, p, 1);
      if (!r) return null;
      day = r[0];
    }
    return isoToYmd(year, week, day);
  }
  r = digits(b, p, 2);
  if (!r) return null;
  const month = r[0];
  p = r[1];
  if (sep && at(b, p++) !== 0x2d) return null;
  r = digits(b, p, 2);
  if (!r) return null;
  return [year, month, r[0]];
}

// HH[:MM[:SS[.ffffff]]] between p and end. -> {rv: 0 at the end of the text, 1 if more follows, or null, values}
function parseHms(b, p, end) {
  const vals = [0, 0, 0];
  let hasSep = true;
  for (let i = 0; i < 3; i++) {
    const r = digits(b, p, 2);
    if (!r) return null;
    vals[i] = r[0];
    p = r[1];
    const c = at(b, p++);
    if (i === 0) hasSep = c === 0x3a; // ":"
    if (p >= end) return { rv: c !== 0 ? 1 : 0, vals, us: 0 };
    if (hasSep && c === 0x3a) {
      if (i === 2) return null;
      continue;
    }
    if (c === 0x2e || c === 0x2c) { // "." or ","
      if (i < 2) return null;
      break;
    }
    if (hasSep) return null;
    p--; // no separators: the next digits follow directly
  }
  // the fraction: up to 6 digits are read, further digits skipped
  const toParse = Math.min(end - p, 6);
  const r = digits(b, p, toParse);
  if (!r) return null;
  const us = r[0] * [1, 100000, 10000, 1000, 100, 10, 1][toParse];
  p = r[1];
  while (isDigit(at(b, p))) p++;
  return { rv: at(b, p) !== 0 ? 1 : 0, vals, us };
}

// -> {h, m, s, us, offset: null or [seconds, microseconds]} or null
function parseTime(b, p, len) {
  const end = len;
  let tz = p;
  do {
    const c = at(b, tz);
    if (c === 0x5a || c === 0x2b || c === 0x2d) break; // Z + -
  } while (++tz < end);
  const t = parseHms(b, p, tz);
  if (!t) return null;
  const [h, m, s] = t.vals;
  if (tz === end) return t.rv === 1 ? null : { h, m, s, us: t.us, offset: null };
  if (at(b, tz) === 0x5a) return at(b, tz + 1) !== 0 ? null : { h, m, s, us: t.us, offset: [0, 0] };
  const sign = at(b, tz) === 0x2d ? -1 : 1;
  const z = parseHms(b, tz + 1, end);
  if (!z || z.rv) return null;
  const [zh, zm, zs] = z.vals;
  const seconds = sign * (zh * 3600 + zm * 60 + zs);
  // the C code takes a zero offset as UTC even when the offset has a fraction of a second
  return { h, m, s, us: t.us, offset: seconds === 0 ? [0, 0] : [seconds, sign * z.us] };
}

// datetime.fromisoformat(text) -> {year, month, day, h, m, s, us, offset} (offset null for a naive time), or null
// where Python raises ValueError
export function fromIsoFormat(text) {
  const cps = Array.from(text);
  if (cps.length < 7) return null;
  // the character between date and time may be anything: one outside ASCII is replaced, as the C code does
  for (const pos of [7, 8, 10]) {
    if (pos >= cps.length) break;
    if (cps[pos].codePointAt(0) > 0x7f) {
      cps[pos] = "T";
      break;
    }
  }
  const clean = cps.join("");
  if (/[\ud800-\udfff]/.test(clean.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ""))) return null; // not UTF-8
  const b = new TextEncoder().encode(clean);
  const len = b.length;
  const sep = separatorLocation(b);
  if (sep < 0) return null;
  const date = parseDate(b, sep);
  if (!date) return null;
  let [year, month, day] = date;
  let t = { h: 0, m: 0, s: 0, us: 0, offset: null };
  if (len > sep) {
    t = parseTime(b, sep + 1, len);
    if (!t) return null;
  }
  let { h } = t;
  if (t.offset) {
    const total = t.offset[0] * 1e6 + t.offset[1];
    if (!(total > -86400e6 && total < 86400e6)) return null;
  }
  if (h === 24 && month <= 12) {
    const dim = daysInMonth(year, month);
    if (day <= dim) {
      if (t.m !== 0 || t.s !== 0 || t.us !== 0) return null;
      h = 0;
      day += 1;
      if (day > dim) {
        day = 1;
        month += 1;
        if (month > 12) {
          month = 1;
          year += 1;
        }
      }
    }
  }
  if (year < MINYEAR || year > MAXYEAR || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  if (h > 23 || t.m > 59 || t.s > 59 || t.us > 999999) return null;
  return { year, month, day, h, m: t.m, s: t.s, us: t.us, offset: t.offset };
}

// ------------------------------------------------------------------ to local time
// .astimezone() as the C code does it, in whole milliseconds and seconds so that no rounding moves a time across
// midnight. Python fails (OverflowError, ValueError) when a time it computes on the way falls outside years
// 1..9999; that is "unknown" here.

const EPOCH_ORD = 719163; // ymdToOrd(1970, 1, 1)
const MAX_ORD = 3652059; // ymdToOrd(9999, 12, 31)
const DAY_MS = 86400000;
const EPOCH_SECONDS = EPOCH_ORD * 86400; // the C code counts seconds from day 0 of its ordinals
const MAX_FOLD_SECONDS = 24 * 3600;

function monthText(year, month) {
  return String(year).padStart(4, "0") + "-" + String(month).padStart(2, "0");
}

function inRange(ms) {
  const ord = Math.floor(ms / DAY_MS) + EPOCH_ORD;
  return ord >= 1 && ord <= MAX_ORD;
}

// the local UTC offset in seconds at a Unix time (tm_gmtoff of localtime())
function gmtoff(unixSeconds) {
  return -Math.round(new Date(unixSeconds * 1000).getTimezoneOffset() * 60);
}

// local(u) of the C code: the local wall time of instant u, both counted in seconds from day 0; null when its year
// is outside 1..9999
function local(u) {
  const lt = u + gmtoff(u - EPOCH_SECONDS);
  const ord = Math.floor(lt / 86400);
  return ord >= 1 && ord <= MAX_ORD ? lt : null;
}

// local_to_seconds of the C code: the instant whose local wall time is t (fold picks one of two candidates)
function localToSeconds(t, fold) {
  let lt = local(t);
  if (lt === null) return null;
  const a = lt - t;
  const u1 = t - a;
  const t1 = local(u1);
  if (t1 === null) return null;
  let b;
  if (t1 === t) {
    // one solution found; look for an earlier one (fold 0) or a later one (fold 1)
    const probe = fold ? u1 + MAX_FOLD_SECONDS : u1 - MAX_FOLD_SECONDS;
    lt = local(probe);
    if (lt === null) return null;
    b = lt - probe;
    if (a === b) return u1;
  } else {
    b = t1 - u1;
  }
  const u2 = t - b;
  const t2 = local(u2);
  if (t2 === null) return null;
  if (t2 === t) return u2;
  if (t1 === t) return u1;
  return fold ? Math.min(u1, u2) : Math.max(u1, u2); // t is in a gap
}

// the month of dt (with offset [seconds, microseconds]) in local time
function awareMonth(dt, offset) {
  const ord = ymdToOrd(dt.year, dt.month, dt.day);
  const wallMs = (ord - EPOCH_ORD) * DAY_MS + ((dt.h * 60 + dt.m) * 60 + dt.s) * 1000 + Math.floor(dt.us / 1000);
  const utcMs = wallMs + Math.floor(((dt.us % 1000) - (offset[0] * 1e6 + offset[1])) / 1000);
  if (!inRange(utcMs)) return null;
  const localMs = utcMs + gmtoff(Math.floor(utcMs / 1000)) * 1000;
  if (!inRange(localMs)) return null;
  const [year, month] = ordToYmd(Math.floor(localMs / DAY_MS) + EPOCH_ORD);
  return monthText(year, month);
}

// .astimezone().strftime("%Y-%m"), or null
function localMonth(dt) {
  if (dt.offset !== null) return awareMonth(dt, dt.offset);
  // a time without an offset is local time: find its UTC offset as local_timezone_from_local does (fold 0)
  const t = ymdToOrd(dt.year, dt.month, dt.day) * 86400 + (dt.h * 60 + dt.m) * 60 + dt.s;
  let seconds = localToSeconds(t, 0);
  if (seconds === null) return null;
  const seconds2 = localToSeconds(t, 1);
  if (seconds2 === null) return null;
  if (seconds2 < seconds) seconds = seconds2; // a gap
  return awareMonth(dt, [gmtoff(seconds - EPOCH_SECONDS), 0]);
}

// 'YYYY-MM' of an ISO timestamp in local time, or 'unknown'
export function monthOf(ts) {
  if (typeof ts !== "string") return "unknown";
  const s = ts.replaceAll("Z", "+00:00");
  let dt = fromIsoFormat(s);
  if (dt === null) {
    // the Python client's fallback for Python 3.9/3.10: pad or cut the fraction to 6 digits and retry
    dt = fromIsoFormat(s.replace(/\.(\p{Nd}+)/gu, (_, d) => "." + Array.from(d + "00000").slice(0, 6).join("")));
  }
  if (dt === null) return "unknown";
  return localMonth(dt) ?? "unknown";
}
