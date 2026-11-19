// Rate limits: the counters in the database, the limits as data, and the keys a network
// address and an email are counted under. Runs on both targets.
import { describe, expect, it } from "vitest";
import { makeDeps } from "#harness";
import type { Deps } from "../src/ports.ts";
import { COUNTER_KEEP_MS, COUNTER_SWEEP_PAGE, hit, hitLimit, LIMITS_SIGNIN, MAX_BUCKET_BYTES, MAX_KEY_BYTES, networkKey, over, recipientKey, SITE_KEY, SITE_QUIET_KEY, sweepCounters } from "../src/rate.ts";

const NOW = 1_800_000_000_000;
const MIN_15 = 900_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const HEX_64 = /^[0-9a-f]{64}$/;

type Row = { bucket: string; key: string; window_start: number; count: number };

async function rows(deps: Deps): Promise<Row[]> {
  return deps.db.all<Row>("SELECT bucket, key, window_start, count FROM rate_counter ORDER BY bucket, key, window_start");
}

/** `n` counters of one bucket, keys k1 to kn, all in the window that starts at `windowStart`. */
async function fill(deps: Deps, bucket: string, n: number, windowStart: number): Promise<void> {
  await deps.db.run(
    `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?)
     INSERT INTO rate_counter (bucket, key, window_start, count) SELECT ?, 'k' || x, ?, 1 FROM c`,
    [n, bucket, windowStart],
  );
}

describe("rate limits", () => {
  it("the limits are the five that are kept, each with its own bucket", () => {
    expect(LIMITS_SIGNIN).toEqual({
      linkRecipient: { bucket: "link_recipient", windowMs: MIN_15, most: 3 },
      linkRecipientDay: { bucket: "link_recipient_day", windowMs: DAY, most: 10 },
      linkNetwork: { bucket: "link_network", windowMs: MIN_15, most: 10 },
      mailSite: { bucket: "mail_site", windowMs: HOUR, most: 100 },
      codeNetwork: { bucket: "code_network", windowMs: MIN_15, most: 20 },
    });
    // Two limits on one key must not share a row: a day's window starts where a quarter hour's does.
    const buckets = Object.values(LIMITS_SIGNIN).map((l) => l.bucket);
    expect(new Set(buckets).size).toBe(buckets.length);
    // No window outlives the time a counter is kept.
    for (const l of Object.values(LIMITS_SIGNIN)) expect(l.windowMs).toBeLessThanOrEqual(COUNTER_KEEP_MS);
    // The fixed key is a word, not a digest, and cannot be mistaken for one.
    expect(SITE_KEY).toBe("site");
    // Requests that send nothing are counted under a second word, never under the real cap's.
    expect(SITE_QUIET_KEY).toBe("site_quiet");
    for (const l of Object.values(LIMITS_SIGNIN)) expect(new TextEncoder().encode(l.bucket).length).toBeLessThanOrEqual(MAX_BUCKET_BYTES);

    // "Most 3" lets three through and stops the fourth.
    expect(over(0, 3)).toBe(false);
    expect(over(3, 3)).toBe(false);
    expect(over(4, 3)).toBe(true);
    expect(over(0, 0)).toBe(false);
    expect(over(1, 0)).toBe(true);
    // A count that is not a whole number from 0 up is over, whatever the limit.
    for (const count of [Number.NaN, undefined, -1, null, true, [], [1], "1", 1.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(over(count as never, 3), String(count)).toBe(true);
    }
    // And so is any count against a limit that is not one.
    for (const most of [Number.POSITIVE_INFINITY, Number.NaN, -1, 1.5, null, undefined, "3"]) {
      expect(over(0, most as never), String(most)).toBe(true);
      expect(over(1, most as never), String(most)).toBe(true);
    }
  });

  it("a limit is counted and judged by itself, and says when its window ends", async () => {
    const { deps, calls } = await makeDeps();
    const limit = LIMITS_SIGNIN.linkRecipient;
    const start = Math.floor(NOW / limit.windowMs) * limit.windowMs;
    let now = start;
    deps.now = () => now;
    const key = await recipientKey("sam@example.com");

    const before = calls();
    expect(await hitLimit(deps, limit, key)).toEqual({ over: false, retryAfterSeconds: 900 });
    expect(calls() - before).toBe(1);
    now = start + 1;
    expect(await hitLimit(deps, limit, key)).toEqual({ over: false, retryAfterSeconds: 900 });
    now = start + 1000;
    expect(await hitLimit(deps, limit, key)).toEqual({ over: false, retryAfterSeconds: 899 });
    now = start + limit.windowMs - 1;
    expect(await hitLimit(deps, limit, key)).toEqual({ over: true, retryAfterSeconds: 1 });
    expect(await rows(deps)).toEqual([{ bucket: limit.bucket, key, window_start: start, count: 4 }]);
    // The next window starts again.
    now = start + limit.windowMs;
    expect(await hitLimit(deps, limit, key)).toEqual({ over: false, retryAfterSeconds: 900 });

    // The same key under another limit is another counter, judged by that limit's own number.
    const day = LIMITS_SIGNIN.linkRecipientDay;
    for (let i = 0; i < day.most; i++) expect((await hitLimit(deps, day, key)).over, String(i)).toBe(false);
    expect((await hitLimit(deps, day, key)).over).toBe(true);

    // A limit that is not one is refused before the database, and a counter that fails rejects.
    const n = calls();
    await expect(hitLimit(deps, { bucket: "b", windowMs: MIN_15, most: Number.POSITIVE_INFINITY }, key)).rejects.toThrow("bad limit");
    await expect(hitLimit(deps, { bucket: "b", windowMs: MIN_15, most: -1 }, key)).rejects.toThrow("bad limit");
    await expect(hitLimit(deps, { bucket: "b", windowMs: 0, most: 3 }, key)).rejects.toThrow("bad window");
    expect(calls() - n).toBe(0);
    const broken: Deps = { ...deps, db: { ...deps.db, first: () => Promise.reject(new Error("database is locked")) } };
    await expect(hitLimit(broken, limit, key)).rejects.toThrow();
  });

  it("the count rises by one per hit and starts again in the next window", async () => {
    const { deps, calls } = await makeDeps();
    // The window that holds NOW starts at a multiple of its length.
    const start = Math.floor(NOW / MIN_15) * MIN_15;
    let now = start;
    deps.now = () => now;

    expect(await hit(deps, "b", "k", MIN_15)).toBe(1);
    expect(await hit(deps, "b", "k", MIN_15)).toBe(2);
    // One statement, one call, and the count it returned is the count that was stored.
    const before = calls();
    expect(await hit(deps, "b", "k", MIN_15)).toBe(3);
    expect(calls() - before).toBe(1);
    expect(await rows(deps)).toEqual([{ bucket: "b", key: "k", window_start: start, count: 3 }]);

    // The last millisecond of the window still counts in it; the next one starts again.
    now = start + MIN_15 - 1;
    expect(await hit(deps, "b", "k", MIN_15)).toBe(4);
    now = start + MIN_15;
    expect(await hit(deps, "b", "k", MIN_15)).toBe(1);
    expect(await hit(deps, "b", "k", MIN_15)).toBe(2);
    expect(await rows(deps)).toEqual([
      { bucket: "b", key: "k", window_start: start, count: 4 },
      { bucket: "b", key: "k", window_start: start + MIN_15, count: 2 },
    ]);

    // Another key, another bucket and another window length each count for themselves.
    expect(await hit(deps, "b", "other", MIN_15)).toBe(1);
    expect(await hit(deps, "c", "k", MIN_15)).toBe(1);
    expect(await hit(deps, "b", "k", MIN_15)).toBe(3);

    // The time is the injected clock's alone: a clock far from the real one decides the window.
    now = 5 * DAY + 7;
    expect(await hit(deps, "d", "k", DAY)).toBe(1);
    expect((await rows(deps)).filter((r) => r.bucket === "d")).toEqual([{ bucket: "d", key: "k", window_start: 5 * DAY, count: 1 }]);
  });

  it("two hits at once count two", async () => {
    const { deps } = await makeDeps();
    deps.now = () => NOW;
    const two = await Promise.all([hit(deps, "b", "k", MIN_15), hit(deps, "b", "k", MIN_15)]);
    expect(two.sort((a, b) => a - b)).toEqual([1, 2]);

    // Forty more at once: every hit gets its own number, none is lost and none is given twice.
    const many = await Promise.all(Array.from({ length: 40 }, () => hit(deps, "b", "k", MIN_15)));
    expect(many.sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i + 3));
    expect(await rows(deps)).toEqual([{ bucket: "b", key: "k", window_start: Math.floor(NOW / MIN_15) * MIN_15, count: 42 }]);
  });

  it("a limit cannot be passed by racing", async () => {
    const { deps } = await makeDeps();
    deps.now = () => NOW;
    const limit = LIMITS_SIGNIN.linkRecipient;
    const key = await recipientKey("sam@example.com");
    const counts = await Promise.all(Array.from({ length: 12 }, () => hit(deps, limit.bucket, key, limit.windowMs)));
    expect(counts.filter((n) => !over(n, limit.most))).toHaveLength(limit.most);
    // The refused tries are counted too, so going on trying never opens the window again.
    expect((await rows(deps))[0].count).toBe(12);
    expect(over(await hit(deps, limit.bucket, key, limit.windowMs), limit.most)).toBe(true);
  });

  it("a counter that cannot be written rejects, and a hit that makes no sense is refused before the database", async () => {
    const { deps, calls } = await makeDeps();
    deps.now = () => NOW;
    const broken: Deps = { ...deps, db: { ...deps.db, first: () => Promise.reject(new Error("database is locked")) } };
    // No count comes back, so nothing can be let through on it.
    await expect(hit(broken, "b", "k", MIN_15)).rejects.toThrow();

    const before = calls();
    for (const windowMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, COUNTER_KEEP_MS + 1]) {
      await expect(hit(deps, "b", "k", windowMs), String(windowMs)).rejects.toThrow("bad window");
    }
    await expect(hit(deps, "", "k", MIN_15)).rejects.toThrow("bad bucket");
    await expect(hit(deps, "b", "", MIN_15)).rejects.toThrow("bad key");
    // A name longer than its column will take, counted in bytes.
    await expect(hit(deps, "b".repeat(MAX_BUCKET_BYTES + 1), "k", MIN_15)).rejects.toThrow("bad bucket");
    await expect(hit(deps, "é".repeat(MAX_BUCKET_BYTES / 2 + 1), "k", MIN_15)).rejects.toThrow("bad bucket");
    await expect(hit(deps, "b", "k".repeat(MAX_KEY_BYTES + 1), MIN_15)).rejects.toThrow("bad key");
    await expect(hit(deps, "b", "é".repeat(MAX_KEY_BYTES / 2 + 1), MIN_15)).rejects.toThrow("bad key");
    await expect(hit(deps, 5 as never, "k", MIN_15)).rejects.toThrow("bad bucket");
    await expect(hit(deps, "b", null as never, MIN_15)).rejects.toThrow("bad key");
    // A clock that gives no time, or one before the start of time.
    for (const t of [Number.NaN, -1, -MIN_15, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, undefined, "5"]) {
      await expect(hit({ ...deps, now: () => t as never }, "b", "k", MIN_15), String(t)).rejects.toThrow("bad clock");
    }
    expect(calls() - before).toBe(0);
    expect(await rows(deps)).toEqual([]);
    expect([MAX_BUCKET_BYTES, MAX_KEY_BYTES]).toEqual([40, 100]);

    // The longest names are taken, and the clock's first millisecond is a time.
    expect(await hit(deps, "b".repeat(MAX_BUCKET_BYTES), "k".repeat(MAX_KEY_BYTES), MIN_15)).toBe(1);
    expect(await hit({ ...deps, now: () => 0 }, "b", "k", MIN_15)).toBe(1);

    // A database that answers without a count is no count either.
    for (const answer of [null, { count: 0 }, { count: -1 }, { count: 1.5 }, { count: "2" }, {}]) {
      const odd: Deps = { ...deps, db: { ...deps.db, first: () => Promise.resolve(answer as never) } };
      await expect(hit(odd, "b", "k", MIN_15), JSON.stringify(answer)).rejects.toThrow("rate counter gave no count");
      await expect(hitLimit(odd, LIMITS_SIGNIN.linkNetwork, "k"), JSON.stringify(answer)).rejects.toThrow("rate counter gave no count");
    }
  });

  it("a private, loopback or missing address has no network key", async () => {
    const none = [
      null,
      "",
      " ",
      "unknown",
      // Loopback, private, link-local, shared, "this network", multicast and reserved IPv4.
      "127.0.0.1",
      "127.255.255.254",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.169",
      "169.254.10.10",
      "100.64.0.1",
      "100.127.255.255",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      // The same in IPv6.
      "::",
      "::1",
      "fe80::1",
      "fe80::1%eth0",
      "febf::1",
      "fc00::1",
      "fd12:3456:789a::1",
      "fec0::1",
      "ff02::1",
      // An IPv4 address written inside IPv6 is judged as the IPv4 address.
      "::ffff:127.0.0.1",
      "::ffff:10.1.2.3",
      "::ffff:c0a8:0101",
      "::192.168.1.1",
      "64:ff9b::10.0.0.1",
      "64:ff9b::7f00:1",
      "FE80::1",
      // Benchmarking, protocol assignments and the local-use translation prefix.
      "198.18.0.1",
      "198.19.255.255",
      "192.0.0.1",
      "192.0.0.255",
      "::ffff:198.18.0.1",
      "64:ff9b:1::1",
      "64:ff9b:1:ffff::203.0.113.7",
      // Not an address: nothing is guessed from it.
      "010.1.1.1",
      "2130706433",
      "0x7f000001",
      "[2001:db8::1]:443",
      "203.0.113.7\u0000",
      "203.0.113.7\u0000.example",
      "2001:db8::1\u0000",
      "\u0000",
      "1".repeat(1_000_000),
      "1:".repeat(500_000),
      "2001:db8::1%" + "z".repeat(1_000_000),
      5 as never,
      {} as never,
      undefined as never,
      "1.2.3",
      "1.2.3.4.5",
      "256.1.1.1",
      "01.2.3.4",
      "1.2.3.4:443",
      "1.2.3.4, 5.6.7.8",
      "2001:db8::1::2",
      "2001:db8:1:2:3:4:5:6:7",
      "2001:db8",
      "2001:db8::12345",
      "2001:db8::g",
      ":::",
      "example.com",
    ];
    for (const address of none) expect(await networkKey(address), String(address)).toBeNull();

    // The neighbours of each private range are public.
    for (const address of ["9.255.255.255", "11.0.0.0", "100.63.255.255", "100.128.0.0", "126.255.255.255", "128.0.0.0", "169.253.0.1", "169.255.0.1", "172.15.255.255", "172.32.0.0", "192.167.0.1", "192.169.0.1", "223.255.255.255", "203.0.113.7", "2001:db8::1", "fbff::1", "fe00::1", "2a00::1", "198.17.255.255", "198.20.0.0", "191.255.255.255", "192.0.1.1", "64:ff9b:0:1::1", "64:ff9b:2::1"]) {
      expect(await networkKey(address), address).toMatch(HEX_64);
    }
    // The ranges kept for examples are counted like any public address: counting is the safe direction.
    for (const address of ["192.0.2.1", "198.51.100.1", "203.0.113.1", "2001:db8:1::1"]) {
      expect(await networkKey(address), address).toMatch(HEX_64);
    }
  });

  it("two addresses in one IPv6 /64 share a key", async () => {
    const key = await networkKey("2001:db8:aa:bb::1");
    expect(key).toMatch(HEX_64);
    // The same /64, written every way an address may be.
    for (const address of ["2001:db8:aa:bb:ffff:ffff:ffff:ffff", "2001:0db8:00aa:00bb:0000:0000:0000:0002", "2001:DB8:AA:BB::2", "2001:db8:aa:bb:1:2:3:4", "[2001:db8:aa:bb::9]", "2001:db8:aa:bb::9%en0", " 2001:db8:aa:bb::9 ", "2001:db8:aa:bb::1.2.3.4"]) {
      expect(await networkKey(address), address).toBe(key);
    }
    // The next /64 and the one before it are other networks.
    for (const address of ["2001:db8:aa:bc::1", "2001:db8:aa:ba::1", "2001:db8:ab:bb::1", "2001:db9:aa:bb::1", "2002:db8:aa:bb::1"]) {
      const other = await networkKey(address);
      expect(other, address).toMatch(HEX_64);
      expect(other, address).not.toBe(key);
    }

    // An IPv4 address is one network by itself, and its neighbour is another.
    const v4 = await networkKey("203.0.113.7");
    expect(v4).toMatch(HEX_64);
    expect(await networkKey(" 203.0.113.7 ")).toBe(v4);
    expect(await networkKey("203.0.113.8")).not.toBe(v4);
    // However it is written inside IPv6, it is that IPv4 address and no /64 of its own.
    for (const address of ["::ffff:203.0.113.7", "::FFFF:203.0.113.7", "::ffff:cb00:7107", "0:0:0:0:0:ffff:cb00:7107", "64:ff9b::203.0.113.7", "64:ff9b::cb00:7107"]) {
      expect(await networkKey(address), address).toBe(v4);
    }
    expect(await networkKey("::ffff:203.0.113.8")).not.toBe(v4);
  });

  it("no key holds the address or the email it was made from", async () => {
    const { deps } = await makeDeps();
    deps.now = () => NOW;
    const email = "sam.jones+tours@example.com";
    const address4 = "203.0.113.77";
    const address6 = "2001:db8:aa:bb::77";
    const recipient = await recipientKey(email);
    const net4 = (await networkKey(address4))!;
    const net6 = (await networkKey(address6))!;
    for (const k of [recipient, net4, net6]) expect(k).toMatch(HEX_64);
    expect(new Set([recipient, net4, net6]).size).toBe(3);

    // One address has one key however it was typed, and another address another.
    expect(await recipientKey("  Sam.Jones+Tours@Example.COM\t")).toBe(recipient);
    expect(await recipientKey("sam.jones@example.com")).not.toBe(recipient);
    // A key is not the bare digest of what it was made from, so a table of plain digests
    // of addresses does not open it, and an email and a network never meet in one key.
    const plain = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), (b) => b.toString(16).padStart(2, "0")).join("");
    expect(recipient).not.toBe(await plain(email));
    expect(net4).not.toBe(await plain(address4));
    expect(await recipientKey(address4)).not.toBe(net4);
    // Something that is not text has no key: a rejected promise, never a throw on the spot.
    for (const v of [null, undefined, 5, {}, ["a@example.com"]]) {
      let made: Promise<string> | undefined;
      expect(() => (made = recipientKey(v as never)), String(v)).not.toThrow();
      await expect(made, String(v)).rejects.toThrow("bad email");
    }

    // Counted the way a sign-in request counts, the table holds digests and fixed words only.
    await hit(deps, LIMITS_SIGNIN.linkRecipient.bucket, recipient, LIMITS_SIGNIN.linkRecipient.windowMs);
    await hit(deps, LIMITS_SIGNIN.linkRecipientDay.bucket, recipient, LIMITS_SIGNIN.linkRecipientDay.windowMs);
    await hit(deps, LIMITS_SIGNIN.linkNetwork.bucket, net4, LIMITS_SIGNIN.linkNetwork.windowMs);
    await hit(deps, LIMITS_SIGNIN.codeNetwork.bucket, net6, LIMITS_SIGNIN.codeNetwork.windowMs);
    await hit(deps, LIMITS_SIGNIN.mailSite.bucket, SITE_KEY, LIMITS_SIGNIN.mailSite.windowMs);
    await hit(deps, LIMITS_SIGNIN.mailSite.bucket, SITE_QUIET_KEY, LIMITS_SIGNIN.mailSite.windowMs);
    const stored = await rows(deps);
    expect(stored).toHaveLength(6);
    for (const r of stored) expect(r.key === SITE_KEY || r.key === SITE_QUIET_KEY || HEX_64.test(r.key), r.key).toBe(true);
    // A request that sends nothing spends nothing of the real cap.
    expect(stored.filter((r) => r.bucket === "mail_site").map((r) => [r.key, r.count])).toEqual([["site", 1], ["site_quiet", 1]]);
    const text = JSON.stringify(stored).toLowerCase();
    for (const part of [email, "sam", "jones", "example.com", "@", address4, "203.0", "113.77", address6, "2001:", "db8:", "aa:bb"]) {
      expect(text.includes(part), part).toBe(false);
    }
  });

  it("old windows are removed, at most a page at a time", async () => {
    const { deps, calls } = await makeDeps();
    deps.now = () => NOW;
    const edge = NOW - COUNTER_KEEP_MS;
    // Old: two and a half pages, in three ages. Kept: the one exactly at the edge, and live ones.
    await fill(deps, "oldest", COUNTER_SWEEP_PAGE, edge - 3 * DAY);
    await fill(deps, "older", COUNTER_SWEEP_PAGE, edge - 2 * DAY);
    await fill(deps, "old", COUNTER_SWEEP_PAGE / 2, edge - 1);
    await fill(deps, "edge", 1, edge);
    await fill(deps, "live", 3, NOW - MIN_15);
    await hit(deps, "now", "k", MIN_15);
    const left = async () => {
      const out: Record<string, number> = {};
      for (const r of await deps.db.all<{ bucket: string; n: number }>("SELECT bucket, count(*) AS n FROM rate_counter GROUP BY bucket")) out[r.bucket] = r.n;
      return out;
    };
    const kept = { edge: 1, live: 3, now: 1 };

    // One call, one page, the oldest first.
    const before = calls();
    await sweepCounters(deps);
    expect(calls() - before).toBe(1);
    expect(await left()).toEqual({ older: COUNTER_SWEEP_PAGE, old: COUNTER_SWEEP_PAGE / 2, ...kept });
    await sweepCounters(deps);
    expect(await left()).toEqual({ old: COUNTER_SWEEP_PAGE / 2, ...kept });
    await sweepCounters(deps);
    expect(await left()).toEqual(kept);
    // Nothing old is left, so nothing more goes, and a live counter goes on counting.
    await sweepCounters(deps);
    expect(await left()).toEqual(kept);
    expect(await hit(deps, "now", "k", MIN_15)).toBe(2);

    // A sweep that fails is never the request's problem.
    const broken: Deps = { ...deps, db: { ...deps.db, run: () => Promise.reject(new Error("database is locked")) } };
    await expect(sweepCounters(broken)).resolves.toBeUndefined();
  });
});
