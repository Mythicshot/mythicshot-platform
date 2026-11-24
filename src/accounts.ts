// Accounts: the email rule and the lookups. No platform API and no web framework.
//
// An account is a row of the `user` table (the name is older than the word on screen).
// The workspace an account works in is found through `membership` only; the
// `workspace_id` on the account's own row is the workspace that was made with it, kept
// because the table cannot lose a column, and never read here.
import { normaliseHost } from "./hosts.ts";
import type { Deps, Stmt } from "./ports.ts";

/** The longest address a mail server takes. */
export const MAX_EMAIL_CHARS = 254;

/** Printable ASCII without the space. Checked before lowercasing: some non-ASCII letters lowercase to ASCII ones. */
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;

/** The part before the @, after lowercasing. No quotes, brackets, commas or colons, so it cannot end an SMTP path or a header. */
const LOCAL_PART = /^[a-z0-9._%+-]{1,64}$/;

const ALL_DIGITS = /^[0-9]+$/;

/** A space or a tab: the only outer characters `parseEmail` drops. A line break is never dropped, so it is always refused. */
function isOuterBlank(code: number): boolean {
  return code === 32 || code === 9;
}

/**
 * The one stored form of an email address, or null when `v` is not one. Drops outer
 * spaces and tabs and lowercases A to Z, then asks for at most 254 characters of visible
 * ASCII with exactly one @: before it 1 to 64 characters of `a-z 0-9 . _ % + -`, after it
 * a host name as `normaliseHost` writes it, with no port and no trailing dot, of at least
 * two labels whose last is not a number (so not a bare name such as `localhost`, and not
 * an IP address).
 *
 * Whatever this returns holds no line break, space, control or hidden character, angle
 * bracket, quote, comma or colon. A line break is refused wherever it stands, also at
 * the very end. Never throws.
 */
export function parseEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  // Two walks from the ends: one pass, whatever the length.
  let start = 0;
  let end = v.length;
  while (start < end && isOuterBlank(v.charCodeAt(start))) start++;
  while (end > start && isOuterBlank(v.charCodeAt(end - 1))) end--;
  if (end - start < 3 || end - start > MAX_EMAIL_CHARS) return null;
  const trimmed = v.slice(start, end);
  if (!VISIBLE_ASCII.test(trimmed)) return null;
  const email = trimmed.toLowerCase();
  const at = email.indexOf("@");
  if (at < 0 || at !== email.lastIndexOf("@")) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!LOCAL_PART.test(local)) return null;
  // The host name must already be in its one comparable form: a trailing dot or anything
  // else normaliseHost would change or refuse is not part of an address, and neither is
  // a port, which normaliseHost would keep.
  if (domain.includes(":") || normaliseHost(domain) !== domain) return null;
  const labels = domain.split(".");
  if (labels.length < 2 || ALL_DIGITS.test(labels[labels.length - 1])) return null;
  return email;
}

export type Account = { id: string; status: "active" | "disabled"; admin: boolean; username: string | null };

/**
 * The account with exactly this address, or null. One call, whether or not there is one.
 * Addresses are stored lowercased, so pass what `parseEmail` returned; anything else
 * finds nobody. A disabled account is returned too, with its status.
 */
export async function accountByEmail(deps: Deps, email: string): Promise<Account | null> {
  const row = await deps.db.first<{ id: string; status: "active" | "disabled"; is_admin: number; username: string | null }>(
    "SELECT id, status, is_admin, username FROM user WHERE email = ?",
    [email],
  );
  if (row === null) return null;
  return { id: row.id, status: row.status, admin: row.is_admin === 1, username: row.username };
}

/**
 * True when the site has an admin, whatever that account's status: a site whose admin is
 * disabled still has one, so nobody can claim to be the first again. One call.
 */
export async function hasAdmin(deps: Deps): Promise<boolean> {
  return (await deps.db.first("SELECT 1 AS x FROM user WHERE is_admin = 1 LIMIT 1")) !== null;
}

/**
 * The workspace the account is a member of, or null when there is no such account or it
 * has no membership. An account has at most one membership (a unique index holds that).
 * One call.
 */
export async function workspaceOf(deps: Deps, userId: string): Promise<string | null> {
  const row = await deps.db.first<{ workspace_id: string }>("SELECT workspace_id FROM membership WHERE user_id = ?", [userId]);
  return row === null ? null : row.workspace_id;
}

/**
 * True when `err` is the database's report that the status column or the membership
 * table a lookup names does not exist: a database the accounts migration (0008) has not
 * reached yet, as when a build is started before its migrations ran. The exact texts,
 * which the tests take from each target's own database:
 * - Node (node:sqlite): `no such table: membership` and `no such column: u.status`,
 *   the whole message;
 * - Workers (D1): `D1_ERROR: no such table: membership: SQLITE_ERROR` and
 *   `D1_ERROR: no such column: u.status at offset <n>: SQLITE_ERROR`.
 * The column is named by the alias the lookup gives the account table: `u` (the token
 * lookup) or `du` (noDisabledAccount). The name must end where the text does, at a colon
 * or at ` at offset`, so no longer name matches, and no other failure (a lock, a missing
 * table of another name) is this one.
 */
export function isBeforeAccounts(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 3; e = e.cause, depth++) {
    if (/(?:^|: )no such (?:table: membership|column: d?u\.status)(?:$|:| at offset )/.test(e.message)) return true;
  }
  return false;
}

/**
 * Runs a public route's one lookup with the disabled-account condition, and on a database
 * the accounts migration has not reached (which has no account that could be disabled) the
 * same lookup without it. Any other failure is a failure. One call, or two only on such a
 * database.
 */
export async function beforeAccountsToo<T>(withCondition: () => Promise<T>, without: () => Promise<T>): Promise<T> {
  try {
    return await withCondition();
  } catch (err) {
    if (!isBeforeAccounts(err)) throw err;
    return without();
  }
}

/**
 * The SQL condition that no account of the workspace `ws` names is disabled, for a public
 * route to fold into the one lookup it already makes: an account belongs to a workspace by
 * its membership or, for a row an older build wrote without one, by the workspace its own
 * row names (the rule the token lookup in src/auth.ts holds). `ws` is a column of the
 * query, such as `t.workspace_id`, never a value from a request. Two index lookups (the
 * account table's workspace index and the membership's key), no added call.
 *
 * It hides a whole workspace when ANY account of it is disabled. That is today's rule,
 * where a workspace has exactly one account, and the rule the token lookup holds; it must
 * be revisited when a workspace can have several members (teams), so that disabling one
 * member does not take the others' links down.
 */
export function noDisabledAccount(ws: string): string {
  return (
    `NOT EXISTS (SELECT 1 FROM user du WHERE du.workspace_id = ${ws} AND du.status = 'disabled')` +
    ` AND NOT EXISTS (SELECT 1 FROM membership dm JOIN user du ON du.id = dm.user_id WHERE dm.workspace_id = ${ws} AND du.status = 'disabled')`
  );
}

/**
 * The statements that give every account lacking them its membership (owner of the
 * workspace its own row names) and its sign-in method (a link sent by mail), for the
 * caller to run in a batch. An account lacks them when a build from before accounts made
 * its workspace on a database that already had them: the migration filled the rows once
 * and does not run again.
 *
 * Idempotent: an account that has a membership, of any workspace, gets no second one, and
 * one that has the sign-in method keeps it, so running this at every start changes
 * nothing after the first time. Each new row is dated as its account is, as the
 * migration dated its rows, so no clock is read and `deps` is not used yet. It changes no
 * existing row and makes nobody an admin. Nothing is written by calling this.
 */
export function healMemberships(_deps: Deps): Stmt[] {
  return [
    {
      sql: "INSERT INTO membership (workspace_id, user_id, role, created_at) SELECT u.workspace_id, u.id, 'owner', u.created_at FROM user u WHERE NOT EXISTS (SELECT 1 FROM membership m WHERE m.user_id = u.id)",
    },
    {
      sql: "INSERT INTO signin_method (user_id, kind, created_at) SELECT u.id, 'email_link', u.created_at FROM user u WHERE NOT EXISTS (SELECT 1 FROM signin_method s WHERE s.user_id = u.id AND s.kind = 'email_link')",
    },
  ];
}
