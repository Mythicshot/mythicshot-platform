// What a tour (src/access.ts) and a shared item (src/media-access.ts) have in common about who
// may view them: the three settings, the list of up to MAX_VIEWERS addresses and how a change
// of it is read, written and recorded, whether the site can let anything be restricted at
// all, and the one question "may this proved address view it now". Each caller names its own
// table and words; nothing here knows a tour from an item.
//
// The list is the workspace's data: it is answered by GET .../access to a signed-in session
// alone (a token gets its count), never by another route, an audit row (which holds counts)
// or a log line, and a refusal of a malformed address names its position only.
import { noDisabledAccount, parseEmail } from "./accounts.ts";
import { linksUpSql } from "./removal-rules.ts";
import { auditStatement, type AuditEvent } from "./audit.ts";
import type { Auth } from "./auth.ts";
import { apiError, readCapped } from "./http.ts";
import { canMailLinks, type Deps, type Stmt } from "./ports.ts";

/** A viewing setting: anyone with the link, the listed addresses and the owner, or the owner alone. */
export type Access = "public" | "people" | "me";
export const ACCESS_SETTINGS: readonly Access[] = ["public", "people", "me"];
/** The most addresses one list holds. */
export const MAX_VIEWERS = 200;
/** The longest PUT body: 200 addresses of 254 characters, escaped, fit with room to spare. */
export const ACCESS_BODY_BYTES = 65_536;
/** The most entries a list may have before duplicates are collapsed: more is refused unread. */
const MAX_ENTRIES = 1000;

export const isRestricted = (a: Access) => a !== "public";

/** The PUT body, checked. `viewers` is null when the body leaves the list as it is. */
export type AccessBody = { access: Access; viewers: string[] | null };

/**
 * Reads `{"access": ..., "viewers": [...]?}`. Every address must pass parseEmail; a refusal
 * names the entry's position, never an address. Duplicates are collapsed, then more than
 * MAX_VIEWERS is refused. Other fields are ignored. `what` names the thing in the one
 * sentence that says so ("a tour's", "an item's").
 */
export async function readAccessBody(req: Request, what: string): Promise<AccessBody | Response> {
  const bad = () => apiError(400, "bad_request", 'the body must be JSON such as {"access": "people", "viewers": ["ana@example.com"]}');
  const raw = await readCapped(req, ACCESS_BODY_BYTES);
  if (raw === "too_large") return apiError(413, "too_large", `the request is over ${ACCESS_BODY_BYTES} bytes`);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw));
  } catch {
    return bad();
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return bad();
  return accessFields(body as Record<string, unknown>, what);
}

/**
 * The two fields of a body that is already a JSON object, checked as readAccessBody checks
 * them: `access` must be one of the three settings; `viewers`, when given and not null, a list
 * of addresses that each pass parseEmail (a refusal names the position, never the address),
 * collapsed, then at most MAX_VIEWERS. Other fields are not looked at.
 */
export function accessFields(o: Record<string, unknown>, what: string): AccessBody | Response {
  const bad = () => apiError(400, "bad_request", 'the body must be JSON such as {"access": "people", "viewers": ["ana@example.com"]}');
  const tooMany = () => apiError(400, "too_many_viewers", `${what} list holds at most ${MAX_VIEWERS} addresses; nothing was changed`);
  const access = Object.hasOwn(o, "access") ? o.access : undefined;
  if (typeof access !== "string" || !(ACCESS_SETTINGS as readonly string[]).includes(access)) {
    return apiError(400, "bad_access", "access must be one of public, people and me");
  }
  const given = Object.hasOwn(o, "viewers") ? o.viewers : undefined;
  if (given === undefined || given === null) return { access: access as Access, viewers: null };
  if (!Array.isArray(given)) return bad();
  if (given.length > MAX_ENTRIES) return tooMany();
  const seen = new Set<string>();
  for (let i = 0; i < given.length; i++) {
    const email = parseEmail(given[i]);
    if (email === null) return apiError(400, "bad_viewer", `viewers[${i}] is not an email address; nothing was changed`);
    seen.add(email);
  }
  if (seen.size > MAX_VIEWERS) return tooMany();
  return { access: access as Access, viewers: [...seen].sort() };
}

/** True when a JSON object names either field with a value other than null. */
export function hasAccessFields(o: unknown): boolean {
  if (o === null || typeof o !== "object" || Array.isArray(o)) return false;
  const r = o as Record<string, unknown>;
  return (Object.hasOwn(r, "access") && r.access !== null) || (Object.hasOwn(r, "viewers") && r.viewers !== null);
}

/**
 * The setting a token states when it creates something (a shared item's create, a tour's first
 * publish): null when the body names neither field (or both are null), which means what it
 * always meant, today's behaviour. Otherwise the fields as accessFields checks them, except
 * that `viewers` without `access` is refused (bad_access) rather than taken as `public`, so a
 * client that forgot the setting never gets a thing more open than it asked for.
 */
export function creationAccess(o: Record<string, unknown>, what: string): AccessBody | null | Response {
  if (!hasAccessFields(o)) return null;
  const access = Object.hasOwn(o, "access") ? o.access : undefined;
  if (access === undefined || access === null) return apiError(400, "bad_access", "access must be given with viewers: one of public, people and me");
  // `pad`: text of any content that a client adds so that the body is longer than an older
  // server takes (1,024 bytes for a first publish, 4,096 for an item's create), which then
  // refuses it whole instead of misreading it. It counts in the body's limit and is ignored.
  if (Object.hasOwn(o, "pad") && o.pad !== null && typeof o.pad !== "string") return apiError(400, "bad_request", "pad must be text");
  return accessFields(o, what);
}

export const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Where one kind of thing keeps its list: the list's table and the column naming the thing,
 * and the thing's own table, whose `id` and `workspace_id` scope every statement.
 */
export type ListPlace = { list: "tour_viewer" | "media_viewer"; key: "tour_id" | "media_id"; owner: "tour" | "media" };

/** Replaces the list of `id` with `list` (sorted, distinct, parsed), keeping the time an address that stays was added. Only while `id` is the workspace's. */
export function viewerStatements(place: ListPlace, id: string, ws: string, list: string[], now: number): Stmt[] {
  const owned = `SELECT id FROM ${place.owner} WHERE id = ? AND workspace_id = ?`;
  const text = JSON.stringify(list);
  return [
    { sql: `DELETE FROM ${place.list} WHERE ${place.key} IN (${owned}) AND email NOT IN (SELECT value FROM json_each(?))`, params: [id, ws, text] },
    {
      sql: `INSERT INTO ${place.list} (${place.key}, email, created_at) SELECT t.id, j.value, ? FROM json_each(?) j JOIN ${place.owner} t ON t.id = ? AND t.workspace_id = ?
            ON CONFLICT (${place.key}, email) DO NOTHING`,
      params: [now, text, id, ws],
    },
  ];
}

/**
 * The audit row of a change: the two settings and the list's sizes, never an address (and,
 * with `atCreation`, that it was stated at creation). With
 * `guard`, it also guards its batch (auditStatement's onlyAfterOneChange): placed right after
 * the statement that changes the setting, it undoes the batch unless that changed one row.
 */
export function changeAudit(deps: Deps, auth: Auth, event: AuditEvent, id: string, from: Access, to: Access, before: number, after: number, guard: boolean, atCreation = false): Stmt {
  const by = auth.session === undefined ? "token" : "session";
  return auditStatement(
    deps,
    {
      event,
      userId: auth.session?.userId ?? null,
      workspaceId: auth.workspaceId,
      subject: id,
      // `at: "creation"` marks a setting stated when the thing was created (a shared item's
      // create, a tour's first publish), which only a token's request does.
      // A token is named by its id, never its secret.
      detail: atCreation
        ? { from, to, viewers_before: before, viewers: after, by, at: "creation", ...(auth.session === undefined ? { token_id: auth.tokenId } : {}) }
        : { from, to, viewers_before: before, viewers: after, by },
    },
    guard ? { onlyAfterOneChange: true } : {},
  );
}

/**
 * Whether a change from `from` to `to` must be refused because nobody could prove an address:
 * only making a public thing restricted needs a site that can mail a link (`canMail`, which
 * defaults to canMailLinks); between the two restricted settings nothing is loosened, so it is
 * always allowed, and a thing already restricted stays restricted when mail goes away.
 */
export function cannotRestrict(deps: Deps, from: Access, to: Access, canMail: (d: Deps) => boolean = canMailLinks): boolean {
  return isRestricted(to) && !isRestricted(from) && !canMail(deps);
}

/**
 * The one statement of "may this proved address view the thing now": its setting, whether the
 * address is on its list, whether it is the address of an account that is a member of the
 * thing's workspace (the owner), and whether that workspace has no disabled account. Two
 * parameters, the address twice, then the thing's id.
 */
function mayViewSql(place: ListPlace, linksUp: string): string {
  return `SELECT t.access,
            EXISTS (SELECT 1 FROM ${place.list} v WHERE v.${place.key} = t.id AND v.email = ?) AS listed,
            EXISTS (SELECT 1 FROM membership m JOIN user u ON u.id = m.user_id WHERE m.workspace_id = t.workspace_id AND u.email = ?) AS owner,
            CASE WHEN ${noDisabledAccount("t.workspace_id")}${linksUp} THEN 1 ELSE 0 END AS enabled
       FROM ${place.owner} t WHERE t.id = ?`;
}

/**
 * Whether a visitor who has proved `provedEmail` (null: none) may view the thing `id`, read
 * fresh in ONE database call every time: true for a public one; for `people` when the address
 * is on its list or is the owner's; for `me` only the owner's. Always false for a thing that
 * does not exist and one whose workspace has a disabled account. The address is compared as
 * parseEmail writes it; one it refuses proves nothing. `extra` adds to the WHERE clause (an
 * item must be online), with no parameter.
 */
export async function mayViewIn(deps: Deps, place: ListPlace, id: string, provedEmail: string | null, extra = ""): Promise<boolean> {
  const email = provedEmail === null ? null : parseEmail(provedEmail);
  // An empty address matches no stored one (every stored address has at least 3 characters).
  const asked = email ?? "";
  const row = await deps.db.first<{ access: Access; listed: number; owner: number; enabled: number }>(mayViewSql(place, linksUpSql(deps.config, "t.workspace_id", deps.now())) + extra, [asked, asked, id]);
  if (row === null || row.enabled !== 1) return false;
  if (row.access === "public") return true;
  if (email === null) return false;
  if (row.access === "people") return row.listed === 1 || row.owner === 1;
  return row.owner === 1;
}
