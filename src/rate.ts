// Rate limits: counters in the database, the limits of signing in, and the keys an email
// and a network address are counted under. Uses only Web Crypto and the database port.
//
// A counter is one row of `rate_counter` per bucket, key and window. Windows are fixed:
// each starts at a multiple of its length, counted from the injected clock alone, so a
// count starts again when the next window does. A caller adds one with `hitLimit` and
// acts on its answer; nothing reads a counter first, so there is no moment between a
// check and a count for a second request to slip through.
//
// A key is a digest or one of two fixed words, never an email or a network address. The
// site has no secret to key a digest with, so a key is the plain SHA-256 of a fixed prefix
// and the value: the table cannot be read as a list of addresses, but someone who holds a
// copy of it can still test a guessed address against it. Counters are swept after a day.
//
// There is no site-wide cap on tries of a sign-in code from callers whose network is
// unknown. A code is 160 random bits, so such a cap would add nothing against guessing,
// and anyone could use it up and stop every sign-in. Tries are limited per network only.
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
  /**
   * Mails sent by the whole site. Over: nothing sent. Only a mail that is really about to
   * be sent is counted under SITE_KEY. A request that sends nothing (no account, no admin,
   * mail off, a recipient over its own limit) is counted under SITE_QUIET_KEY instead and
   * the answer is ignored: it then makes the same database call as a request that sends,
   * and spends nothing of the cap, so nobody can use the cap up by asking for strangers.
   */
  mailSite: { bucket: "mail_site", windowMs: 3_600_000, most: 100 },
  /** Code tries from one network, keyed by `networkKey`; not counted when that is null. Over: 429. */
  codeNetwork: { bucket: "code_network", windowMs: 900_000, most: 20 },
} as const satisfies Record<string, Limit>;

/**
 * The limits on changing an account's email address. Every request is from a signed-in
 * account, so it is counted per account and per address asked for, not per network. Each
 * limit has a bucket of its own, as in LIMITS_SIGNIN. Over any of them: 429. The mail a
 * request sends is also counted against the site's cap, LIMITS_SIGNIN.mailSite, which every
 * mail the site sends shares.
 */
export const LIMITS_EMAIL_CHANGE = {
  /** Change requests of one account, keyed by `accountKey`. */
  requestAccount: { bucket: "email_account", windowMs: 900_000, most: 3 },
  /** The same key, over a day. */
  requestAccountDay: { bucket: "email_account_day", windowMs: 86_400_000, most: 10 },
  /**
   * Change requests for one new address, from any account, keyed by `recipientKey`. Counted
   * for every request, whether or not the address is free, so the count says nothing about
   * who has an account; it keeps a mailbox from being sent link after link.
   */
  requestRecipient: { bucket: "email_recipient", windowMs: 900_000, most: 3 },
  /** The same key, over a day. */
  requestRecipientDay: { bucket: "email_recipient_day", windowMs: 86_400_000, most: 10 },
  /** Code tries of one account, keyed by `accountKey`. A code is 160 random bits; this only stops a page that loops. */
  confirmAccount: { bucket: "email_confirm_account", windowMs: 900_000, most: 20 },
} as const satisfies Record<string, Limit>;

/** The key of a counter that counts for the whole site. */
export const SITE_KEY = "site";

/**
 * The key for what the whole site did not do: a request that sends no mail hits the mail
 * cap's bucket under this key, so it costs one call like a request that sends, and the
 * count under SITE_KEY stays the number of mails sent. Nothing is ever refused on it.
 */
export const SITE_QUIET_KEY = "site_quiet";

/** The longest bucket name `hit` takes, in UTF-8 bytes. */
export const MAX_BUCKET_BYTES = 40;

/** The longest key `hit` takes, in UTF-8 bytes. A digest is 64. */
export const MAX_KEY_BYTES = 100;

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
 * The key an email address is counted under: 64 hex characters. It is not the bare digest
 * of the address. Callers pass what `parseEmail` returned, which is the one stored form
 * of an address; outer blanks are dropped and letters lowercased here all the same, so a
 * caller that forgot still counts one address once. Never throws: for anything that is
 * not text the promise rejects with "bad email", and nothing is counted under a made-up
 * key.
 */
export async function recipientKey(email: string): Promise<string> {
  if (typeof email !== "string") throw new Error("bad email");
  return sha256Hex("rate recipient\n" + email.trim().toLowerCase());
}

/**
 * The key an account is counted under: 64 hex characters, the digest of a fixed prefix and
 * the account's id, so a counter row names no account by its id either. Rejects with "bad
 * account" for anything that is not text.
 */
export async function accountKey(userId: string): Promise<string> {
  if (typeof userId !== "string" || userId === "") throw new Error("bad account");
  return sha256Hex("rate account\n" + userId);
}

const IPV4 = /^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$/;
const IPV6_GROUP = /^[0-9a-f]{1,4}$/;

/** The four numbers of a dotted IPv4 address, or null. Four decimal numbers only, no leading zero. */
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

/**
 * True for an IPv4 address that reaches this site from the internet: not "this network",
 * private, shared, loopback, link-local, protocol assignments (192.0.0.0/24), benchmarking
 * (198.18.0.0/15), multicast or reserved.
 *
 * The ranges kept for examples (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24, and
 * 2001:db8::/32 in IPv6) are counted like any public address. Such an address should
 * never arrive; if one does, counting it is the safe direction, since a caller with no
 * key is limited by less.
 */
function publicIPv4(a: number[]): boolean {
  if (a[0] === 0 || a[0] === 10 || a[0] === 127 || a[0] >= 224) return false;
  if (a[0] === 100 && a[1] >= 64 && a[1] <= 127) return false;
  if (a[0] === 169 && a[1] === 254) return false;
  if (a[0] === 172 && a[1] >= 16 && a[1] <= 31) return false;
  if (a[0] === 192 && a[1] === 168) return false;
  if (a[0] === 192 && a[1] === 0 && a[2] === 0) return false;
  if (a[0] === 198 && (a[1] === 18 || a[1] === 19)) return false;
  return true;
}

/**
 * What a network address is counted as: `4 a.b.c.d` for one IPv4 address, `6 a:b:c:d` for
 * an IPv6 /64, or null for no address, something that is not one, and a loopback,
 * link-local, private or otherwise non-public one. An IPv4 address written inside IPv6
 * (`::ffff:a.b.c.d`, and `64:ff9b::a.b.c.d`) is that IPv4 address.
 */
function network(address: string | null): string | null {
  // Nothing longer than an address with its brackets, blanks and zone is looked at.
  if (typeof address !== "string" || address.length > 100) return null;
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
      // 64:ff9b:1::/48 is the translation prefix for use inside one network.
      if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return null;
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

/** True for text of 1 to `maxBytes` UTF-8 bytes. Text of more characters than that is never encoded. */
function nameFits(name: unknown, maxBytes: number): boolean {
  return typeof name === "string" && name !== "" && name.length <= maxBytes && new TextEncoder().encode(name).length <= maxBytes;
}

/** The count of `key` in `bucket` after adding one, in the window of `windowMs` that holds `now`. Every check is done before the database is called. */
async function count(deps: Deps, bucket: string, key: string, windowMs: number, now: number): Promise<number> {
  if (!nameFits(bucket, MAX_BUCKET_BYTES)) throw new Error("bad bucket");
  if (!nameFits(key, MAX_KEY_BYTES)) throw new Error("bad key");
  if (!Number.isSafeInteger(windowMs) || windowMs < 1 || windowMs > COUNTER_KEEP_MS) throw new Error("bad window");
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("bad clock");
  const row = await deps.db.first<{ count: number }>(
    `INSERT INTO rate_counter (bucket, key, window_start, count) VALUES (?, ?, ?, 1)
     ON CONFLICT (bucket, key, window_start) DO UPDATE SET count = count + 1
     RETURNING count`,
    [bucket, key, now - (now % windowMs)],
  );
  if (row === null || !Number.isSafeInteger(row.count) || row.count < 1) throw new Error("rate counter gave no count");
  return row.count;
}

/**
 * Adds one to the counter of `key` in `bucket` for the window of `windowMs` that holds
 * `deps.now()`, and returns the count including this hit. One statement adds and reads,
 * so hits at the same time each get their own number and none is lost: of any number of
 * racing callers, exactly `most` see a count that is not `over`. A refused try is counted
 * too.
 *
 * Rejects when the counter could not be written, or the database answered without a
 * count: there is then no count, and the caller must not go on as if under the limit (the
 * app's error handler answers 500 with no detail). Rejects before any database call with
 * "bad bucket" or "bad key" for a name that is empty, not text or longer than
 * MAX_BUCKET_BYTES or MAX_KEY_BYTES, with "bad window" for a window that is not a whole
 * number of milliseconds from 1 to COUNTER_KEEP_MS, and with "bad clock" when
 * `deps.now()` is not a whole number of milliseconds from 0 up.
 *
 * Exported for tests. Routes use `hitLimit`, which cannot pair one limit's count with
 * another limit's number.
 */
export async function hit(deps: Deps, bucket: string, key: string, windowMs: number): Promise<number> {
  return count(deps, bucket, key, windowMs, deps.now());
}

/**
 * True when `count`, as `hit` returned it, is more than the limit lets through. Only a
 * whole number from 0 up that is at most `most`, itself a whole number from 0 up, is not
 * over: anything else (a negative or broken count, no count, a limit that is not a
 * number or has no end) is over. Exported for tests; routes use `hitLimit`.
 */
export function over(count: number, most: number): boolean {
  return !(Number.isSafeInteger(count) && count >= 0 && Number.isSafeInteger(most) && most >= 0 && count <= most);
}

/**
 * Counts one hit for `key` against `limit`, in the limit's own bucket and window, and
 * judges it by the limit's own `most`. `retryAfterSeconds` is the time until the window
 * ends and the count starts again, rounded up, from 1 to the window's length: the value
 * of a `retry-after` header. One database call, and one reading of the clock for both
 * answers. Rejects as `hit` does, and with "bad limit" before any database call when
 * `most` is not a whole number from 0 up.
 */
export async function hitLimit(deps: Deps, limit: Limit, key: string): Promise<{ over: boolean; retryAfterSeconds: number }> {
  if (!Number.isSafeInteger(limit.most) || limit.most < 0) throw new Error("bad limit");
  const now = deps.now();
  const n = await count(deps, limit.bucket, key, limit.windowMs, now);
  return { over: over(n, limit.most), retryAfterSeconds: Math.ceil((limit.windowMs - (now % limit.windowMs)) / 1000) };
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
