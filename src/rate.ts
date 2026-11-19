// Rate limits: counters in the database, the limits of signing in, and the keys an email
// and a network address are counted under. Uses only Web Crypto and the database port.
//
// A counter is one row of `rate_counter` per bucket, key and window. Windows are fixed:
// each starts at a multiple of its length, counted from the injected clock alone, so a
// count starts again when the next window does. A caller adds one with `hit` and compares
// what comes back with `over`; nothing reads a counter first, so there is no moment
// between a check and a count for a second request to slip through.
//
// A key is a digest or the fixed word SITE_KEY, never an email or a network address. The
// site has no secret to key a digest with, so a key is the plain SHA-256 of a fixed prefix
// and the value: the table cannot be read as a list of addresses, but someone who holds a
// copy of it can still test a guessed address against it. Counters are swept after a day.
import type { Deps } from "./ports.ts";

export type Limit = {
  /** The name the counter is stored under. Two limits never share one. */
  bucket: string;
  windowMs: number;
  /** How many are let through in one window; the next one is over. */
  most: number;
};

/**
 * The limits on asking for a sign-in link and on trying a code. The two limits per
 * recipient have a bucket each: a day's window starts where a quarter hour's does, so in
 * one bucket they would share a row.
 */
export const LIMITS_SIGNIN = {
  /** Link requests for one recipient, keyed by `recipientKey`. Over: the usual answer, nothing sent. */
  linkRecipient: { bucket: "link_recipient", windowMs: 900_000, most: 3 },
  /** The same key, over a day. */
  linkRecipientDay: { bucket: "link_recipient_day", windowMs: 86_400_000, most: 10 },
  /** Link requests from one network, keyed by `networkKey`; not counted when that is null. Over: 429. */
  linkNetwork: { bucket: "link_network", windowMs: 900_000, most: 10 },
  /** Mails sent by the whole site, keyed by SITE_KEY. Over: nothing sent. */
  mailSite: { bucket: "mail_site", windowMs: 3_600_000, most: 100 },
  /** Code tries from one network, keyed by `networkKey`. Over: 429. */
  codeNetwork: { bucket: "code_network", windowMs: 900_000, most: 20 },
  /** Code tries from all callers whose network is unknown, keyed by SITE_KEY. Over: 429. */
  codeUnknown: { bucket: "code_unknown", windowMs: 3_600_000, most: 600 },
} as const satisfies Record<string, Limit>;

/** The key of a counter that counts for the whole site. */
export const SITE_KEY = "site";

/**
 * How long a counter is kept after its window started, and so the longest window `hit`
 * takes: a counter is never swept while its window is open.
 */
export const COUNTER_KEEP_MS = 86_400_000;

/** The most counters one sweep removes. */
export const COUNTER_SWEEP_PAGE = 100;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  let s = "";
  for (const b of new Uint8Array(digest)) s += b.toString(16).padStart(2, "0");
  return s;
}

/**
 * The key an email address is counted under: 64 hex characters, the same for one address
 * however it is typed (outer blanks dropped, lowercased). It is not the bare digest of
 * the address.
 */
export function recipientKey(email: string): Promise<string> {
  return sha256Hex("rate recipient\n" + email.trim().toLowerCase());
}

const IPV4 = /^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$/;
const IPV6_GROUP = /^[0-9a-f]{1,4}$/;

/** The four numbers of a dotted IPv4 address, or null. Decimal only, no leading zero. */
function parseIPv4(text: string): number[] | null {
  const m = IPV4.exec(text);
  if (m === null) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return parts.every((p) => p <= 255) ? parts : null;
}

function parseGroups(text: string): number[] | null {
  if (text === "") return [];
  const out: number[] = [];
  for (const g of text.split(":")) {
    if (!IPV6_GROUP.test(g)) return null;
    out.push(Number.parseInt(g, 16));
  }
  return out;
}

/** The eight groups of an IPv6 address, or null. Takes `::`, a dotted IPv4 tail and a zone after `%`. */
function parseIPv6(text: string): number[] | null {
  let s = text.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  // The longest address in text is 45 characters; nothing longer is looked at.
  if (s.length < 2 || s.length > 45) return null;
  if (s.includes(".")) {
    const cut = s.lastIndexOf(":");
    const v4 = cut < 0 ? null : parseIPv4(s.slice(cut + 1));
    if (v4 === null) return null;
    s = s.slice(0, cut + 1) + ((v4[0] << 8) | v4[1]).toString(16) + ":" + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = parseGroups(halves[0]);
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = parseGroups(halves[1]);
  if (tail === null || head.length + tail.length > 7) return null;
  return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

/** True for an IPv4 address that reaches this site from the internet: not "this network", private, shared, loopback, link-local, multicast or reserved. */
function publicIPv4(a: number[]): boolean {
  if (a[0] === 0 || a[0] === 10 || a[0] === 127 || a[0] >= 224) return false;
  if (a[0] === 100 && a[1] >= 64 && a[1] <= 127) return false;
  if (a[0] === 169 && a[1] === 254) return false;
  if (a[0] === 172 && a[1] >= 16 && a[1] <= 31) return false;
  if (a[0] === 192 && a[1] === 168) return false;
  return true;
}

/**
 * What a network address is counted as: `4 a.b.c.d` for one IPv4 address, `6 a:b:c:d` for
 * an IPv6 /64, or null for no address, something that is not one, and a loopback,
 * link-local, private or otherwise non-public one. An IPv4 address written inside IPv6
 * (`::ffff:a.b.c.d`, and `64:ff9b::a.b.c.d`) is that IPv4 address.
 */
function network(address: string | null): string | null {
  if (typeof address !== "string") return null;
  let s = address.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  let v4 = parseIPv4(s);
  if (v4 === null) {
    const g = parseIPv6(s);
    if (g === null) return null;
    const mapped = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff;
    const translated = g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0;
    if (mapped || translated) {
      v4 = [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255];
    } else {
      // ::/64 holds the unspecified address, loopback and the old IPv4-compatible form.
      if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0) return null;
      // Link-local fe80::/10, site-local fec0::/10, unique local fc00::/7, multicast ff00::/8.
      if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xff00) === 0xff00) return null;
      return "6 " + g.slice(0, 4).map((n) => n.toString(16)).join(":");
    }
  }
  return publicIPv4(v4) ? "4 " + v4.join(".") : null;
}

/**
 * The key a client's network is counted under: 64 hex characters, or null when there is
 * no network to count for. Null for a missing address, anything that is not an address,
 * and a loopback, link-local or private address (behind a proxy every visitor would share
 * it): such a caller gets no bucket of its own. An IPv4 address is a network by itself;
 * an IPv6 address counts as its /64. Never throws.
 */
export async function networkKey(address: string | null): Promise<string | null> {
  const net = network(address);
  return net === null ? null : sha256Hex("rate network\n" + net);
}

/**
 * Adds one to the counter of `key` in `bucket` for the window of `windowMs` that holds
 * `deps.now()`, and returns the count including this hit. One statement adds and reads,
 * so hits at the same time each get their own number and none is lost: of any number of
 * racing callers, exactly `most` see a count that is not `over`. A refused try is counted
 * too.
 *
 * Rejects when the counter could not be written: there is then no count, and the caller
 * must not go on as if under the limit (the app's error handler answers 500 with no
 * detail). Rejects with "bad bucket", "bad key" or "bad window" before any database call
 * for an empty name or a window that is not a whole number of milliseconds from 1 to
 * COUNTER_KEEP_MS.
 */
export async function hit(deps: Deps, bucket: string, key: string, windowMs: number): Promise<number> {
  if (typeof bucket !== "string" || bucket === "") throw new Error("bad bucket");
  if (typeof key !== "string" || key === "") throw new Error("bad key");
  if (!Number.isSafeInteger(windowMs) || windowMs < 1 || windowMs > COUNTER_KEEP_MS) throw new Error("bad window");
  const now = deps.now();
  const windowStart = now - (now % windowMs);
  const row = await deps.db.first<{ count: number }>(
    `INSERT INTO rate_counter (bucket, key, window_start, count) VALUES (?, ?, ?, 1)
     ON CONFLICT (bucket, key, window_start) DO UPDATE SET count = count + 1
     RETURNING count`,
    [bucket, key, windowStart],
  );
  if (row === null || !Number.isSafeInteger(row.count) || row.count < 1) throw new Error("rate counter gave no count");
  return row.count;
}

/** True when `count`, as `hit` returned it, is more than the limit lets through. Anything that is not a number is over. */
export function over(count: number, most: number): boolean {
  return !(count <= most);
}

/**
 * Removes counters whose window started more than COUNTER_KEEP_MS ago, the oldest first,
 * at most COUNTER_SWEEP_PAGE of them: one bounded delete. Never rejects, since a counter
 * left for the next sweep is no reason to fail the request this rides on.
 */
export async function sweepCounters(deps: Deps): Promise<void> {
  try {
    await deps.db.run(
      `DELETE FROM rate_counter WHERE rowid IN (
         SELECT rowid FROM rate_counter WHERE window_start < ? ORDER BY window_start LIMIT ?)`,
      [deps.now() - COUNTER_KEEP_MS, COUNTER_SWEEP_PAGE],
    );
  } catch {
    // Left for the next sweep.
  }
}
