// Sign-in lifetimes (Plan 2j): how long a dashboard session and a connection made by signing
// in from Mythicshot may be used, from three optional site settings in whole days.
//
// - SESSION_MAX_DAYS (default 90): a session ends this long after it was made (its
//   created_at), however active it is. Its sliding end (expires_at, 30 days after its last
//   use, src/sessions.ts) still applies too.
// - CONNECTION_IDLE_DAYS (default 90): a token of kind `sign_in` that has not been used for
//   this long (since its last_used_at, or its created_at when it was never used) is refused.
// - CONNECTION_MAX_DAYS (default off): a token of kind `sign_in` is refused this long after
//   its created_at.
//
// Nothing is stored for them. Each limit is checked when a request is made, from the times
// the row already holds and the request's clock, inside the one lookup that resolves the
// credential (src/sessions.ts, src/auth.ts), so a changed setting applies to every existing
// row at once and no migration is needed. A token of kind `setup` (the setup wizard's, a new
// account's, or one an older build made) is never touched by them.
//
// The boundaries are those expires_at already has: a credential whose end is `end` works
// while now < end, and is refused from `end` on.

/** One day, in milliseconds. */
export const DAY_MS = 86_400_000;
/** The most days a limit may be set to: ten years. */
export const MAX_LIMIT_DAYS = 3650;

/** The three effective limits, in whole days, or null where the limit is off. */
export type Lifetimes = { sessionMaxDays: number | null; connectionIdleDays: number | null; connectionMaxDays: number | null };

/** The limits a site has when none of the three settings is written. */
export const DEFAULT_LIFETIMES: Lifetimes = { sessionMaxDays: 90, connectionIdleDays: 90, connectionMaxDays: null };

/** The settings by name, in the order they are read and named. */
export const LIFETIME_SETTINGS = ["SESSION_MAX_DAYS", "CONNECTION_IDLE_DAYS", "CONNECTION_MAX_DAYS"] as const;
export type LifetimeSetting = (typeof LIFETIME_SETTINGS)[number];

const KEY_OF: Record<LifetimeSetting, keyof Lifetimes> = {
  SESSION_MAX_DAYS: "sessionMaxDays",
  CONNECTION_IDLE_DAYS: "connectionIdleDays",
  CONNECTION_MAX_DAYS: "connectionMaxDays",
};

/**
 * The one fixed line for each setting whose value cannot be used. It names the setting and
 * the default that applies instead, and never repeats the value.
 */
export const LIFETIME_UNUSABLE: Record<LifetimeSetting, string> = {
  SESSION_MAX_DAYS: "sign-in lifetimes: SESSION_MAX_DAYS is not a whole number of days from 1 to 3650, 0 or off, so the default of 90 days applies. The site runs.",
  CONNECTION_IDLE_DAYS: "sign-in lifetimes: CONNECTION_IDLE_DAYS is not a whole number of days from 1 to 3650, 0 or off, so the default of 90 days applies. The site runs.",
  CONNECTION_MAX_DAYS: "sign-in lifetimes: CONNECTION_MAX_DAYS is not a whole number of days from 1 to 3650, 0 or off, so the default, no limit, applies. The site runs.",
};

/**
 * One setting's value. Unset, null or empty (spaces only included): the default, nothing to
 * say. `0` or `off` in any case (spaces around allowed): off. Digits only, 1 to MAX_LIMIT_DAYS
 * once leading zeros are dropped: that many days (a whole number that is not text, as a
 * Worker var written as a JSON number is, is read as its digits). Anything else: the default,
 * and `bad` is true so the target writes the setting's one fixed line.
 */
export function daysSetting(raw: unknown, fallback: number | null): { days: number | null; bad: boolean } {
  if (raw === undefined || raw === null) return { days: fallback, bad: false };
  // A Worker var written as a JSON number ("SESSION_MAX_DAYS": 30) is read as its digits.
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) raw = String(raw);
  if (typeof raw !== "string") return { days: fallback, bad: true };
  const text = raw.trim();
  if (text === "") return { days: fallback, bad: false };
  if (text.toLowerCase() === "off") return { days: null, bad: false };
  if (!/^[0-9]{1,9}$/.test(text)) return { days: fallback, bad: true };
  const n = Number(text);
  if (n === 0) return { days: null, bad: false };
  if (n > MAX_LIMIT_DAYS) return { days: fallback, bad: true };
  return { days: n, bad: false };
}

/**
 * The three limits from the settings, on either target (a Node environment or a Worker's
 * vars), and the fixed lines for the ones that cannot be used, in the order of
 * LIFETIME_SETTINGS. It never stops the start.
 */
export function lifetimesSetting(env: Partial<Record<LifetimeSetting, unknown>>): { lifetimes: Lifetimes; problems: string[] } {
  const lifetimes: Lifetimes = { ...DEFAULT_LIFETIMES };
  const problems: string[] = [];
  for (const name of LIFETIME_SETTINGS) {
    const key = KEY_OF[name];
    const read = daysSetting(env[name], DEFAULT_LIFETIMES[key]);
    lifetimes[key] = read.days;
    if (read.bad) problems.push(LIFETIME_UNUSABLE[name]);
  }
  return { lifetimes, problems };
}

/** True when the two sets of limits are the same. */
export function sameLifetimes(a: Lifetimes, b: Lifetimes): boolean {
  return a.sessionMaxDays === b.sessionMaxDays && a.connectionIdleDays === b.connectionIdleDays && a.connectionMaxDays === b.connectionMaxDays;
}

/** The limits a config holds, a missing key being its default (null is off). */
export function lifetimesOf(config: { lifetimes?: Partial<Lifetimes> | null }): Lifetimes {
  const given = config.lifetimes ?? {};
  const pick = (key: keyof Lifetimes): number | null => {
    const v = given[key];
    return v === undefined ? DEFAULT_LIFETIMES[key] : v;
  };
  return { sessionMaxDays: pick("sessionMaxDays"), connectionIdleDays: pick("connectionIdleDays"), connectionMaxDays: pick("connectionMaxDays") };
}

const msOf = (days: number | null): number | null => (days === null ? null : days * DAY_MS);

/**
 * The earliest created_at a session may have and still be live at `now`, or null when
 * SESSION_MAX_DAYS is off: a session is live only while created_at > this. For a lookup's
 * `(? IS NULL OR s.created_at > ?)`.
 */
export function sessionBornAfter(config: { lifetimes?: Partial<Lifetimes> | null }, now: number): number | null {
  const max = msOf(lifetimesOf(config).sessionMaxDays);
  return max === null ? null : now - max;
}

/** When a session made at `createdAt` ends however active it is, or null when SESSION_MAX_DAYS is off. */
export function sessionEndsAt(config: { lifetimes?: Partial<Lifetimes> | null }, createdAt: number): number | null {
  const max = msOf(lifetimesOf(config).sessionMaxDays);
  return max === null ? null : createdAt + max;
}

/**
 * The SQL condition that a session row `s` is live at the bound time, beside its revoked_at
 * and expires_at: `s.created_at` later than the bound, or the limit off. Its two
 * parameters are sessionParams(...).
 */
export const SESSION_AGE_SQL = "(? IS NULL OR s.created_at > ?)";
export function sessionParams(config: { lifetimes?: Partial<Lifetimes> | null }, now: number): [number | null, number | null] {
  const after = sessionBornAfter(config, now);
  return [after, after];
}

/**
 * The SQL condition that a token row of the table `t` (an alias or `api_token`) may be used
 * at the bound time: its kind is not `sign_in`, or it was used (or made, when never used)
 * after the idle bound and made after the age bound, each bound null when its limit is off.
 * Its four parameters are tokenParams(...).
 */
export function tokenLifeSql(t: string): string {
  return `(${t}.kind <> 'sign_in' OR ((? IS NULL OR coalesce(${t}.last_used_at, ${t}.created_at) > ?) AND (? IS NULL OR ${t}.created_at > ?)))`;
}
export function tokenParams(config: { lifetimes?: Partial<Lifetimes> | null }, now: number): (number | null)[] {
  const l = lifetimesOf(config);
  const idle = msOf(l.connectionIdleDays);
  const max = msOf(l.connectionMaxDays);
  const idleAfter = idle === null ? null : now - idle;
  const maxAfter = max === null ? null : now - max;
  return [idleAfter, idleAfter, maxAfter, maxAfter];
}

/**
 * When a token stops working unless something changes, from its row: for kind `sign_in`, the
 * earlier of its idle end (last use, or creation when never used, plus CONNECTION_IDLE_DAYS)
 * and its age end (creation plus CONNECTION_MAX_DAYS); null for kind `setup` and when both
 * limits are off. `byAge` is true when that end is the age end (use does not move it).
 */
export function tokenExpiry(
  config: { lifetimes?: Partial<Lifetimes> | null },
  row: { kind: string; created_at: number; last_used_at: number | null },
): { at: number | null; byAge: boolean } {
  if (row.kind !== "sign_in") return { at: null, byAge: false };
  const l = lifetimesOf(config);
  const idle = msOf(l.connectionIdleDays);
  const max = msOf(l.connectionMaxDays);
  const idleEnd = idle === null ? null : (row.last_used_at ?? row.created_at) + idle;
  const ageEnd = max === null ? null : row.created_at + max;
  if (ageEnd !== null && (idleEnd === null || ageEnd <= idleEnd)) return { at: ageEnd, byAge: true };
  return { at: idleEnd, byAge: false };
}
