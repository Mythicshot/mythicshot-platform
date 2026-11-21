// Who may view a shared item (an image or a clip): its setting, its list of addresses, the
// access API, the check every restricted item's route makes, and the gate the media viewer
// scope asks before it mails a link (src/viewers.ts, MEDIA_VIEWERS). Migration 0016.
//
// The settings, the list and their rules are a tour's (src/viewing.ts holds what the two
// share): `public` (anyone with the link: every item before this, and the default),
// `people` (the addresses on the item's list, and the owner) or `me` (the owner alone). The
// owner is every account that is a member of the item's workspace, looked up at the moment of
// the check. The list holds up to MAX_VIEWERS addresses and is kept when the setting moves
// away from `people`. Making a public item restricted needs a site that can mail a viewer
// link to the media address (canRestrictItems); moving between the two restricted settings
// is always allowed, and an item already restricted stays restricted when mail goes away. Only
// a signed-in session may change the setting or the list; a token may read them, and gets the
// list's size, never its addresses.
//
// Unlike a tour, nothing moves: an item's files were always in the private store, served only
// through the app (src/media.ts), so a change is one batch and in force at the next request.
// No answer here is ever 202, and there is no `switching`.
//
// What does change is where the item's link id is kept, for the sake of an older build, which
// knows nothing of the setting and would serve a restricted item to anyone with its link. A
// restricted item's real link id is in media.private_link_id, which no older build reads, and
// media.link_id, the column every older build looks an item up by, holds a fresh random name
// that nothing gives out: making an item restricted moves the link id there and draws that
// name, in the same statement as the setting; making it public puts the link id back. So an
// older build answers a restricted item's link as one that does not exist (the triggers of
// migration 0016 hold the two columns to the setting whatever a build writes). This build
// answers every item's link from private_link_id first (src/media.ts), and never serves an item
// by link_id while it is restricted.
//
// A restricted item may have at most RESTRICTED_SERVED_PARTS parts (src/limits.ts): a whole
// file of more could not be sent within the call budget past the viewer check. With the
// default size settings no item reaches it; restricting a larger one is refused with 409
// too_large_to_restrict, and it stays as it is.
import type { Hono } from "hono";
import { newLinkId, requireAuth, type Auth } from "./auth.ts";
import { apiError, json } from "./http.ts";
import { PART_BYTES, RESTRICTED_SERVED_PARTS } from "./limits.ts";
import { mediaViewerLinkOrigin } from "./mail.ts";
import { ITEM_ID, MEDIA_MAX_AGE_MS, onlineItemFiles, type OnlineItemFiles } from "./media.ts";
import { canMailLinks, isNotNullViolation, isUniqueViolation, type Deps, type Stmt } from "./ports.ts";
import { workspaceKeyOf } from "./restricted.ts";
import { ITEM_PAGE, useMediaViewerGate, type ViewerGate } from "./viewers.ts";
import { MAX_VIEWERS, cannotRestrict, changeAudit, isRestricted, mayViewIn, readAccessBody, sameList, viewerStatements, type Access, type AccessBody, type ListPlace } from "./viewing.ts";

/** Where an item's list is kept. */
const ITEM_LIST: ListPlace = { list: "media_viewer", key: "media_id", owner: "media" };

/** The most bytes an item may have and still be restricted. */
export const RESTRICTED_MAX_BYTES = RESTRICTED_SERVED_PARTS * PART_BYTES;

/**
 * Whether this site can let an item be restricted: it can mail a link (canMailLinks), and it
 * has an address for viewer links to items (mediaViewerLinkOrigin). Without either, nobody
 * could prove an address, so only "anyone with the link" is offered.
 */
export function canRestrictItems(deps: Deps): boolean {
  return canMailLinks(deps) && mediaViewerLinkOrigin(deps.config) !== null;
}

/**
 * Whether a visitor who has proved `provedEmail` (null: none) may view the item `id` now, read
 * fresh in ONE database call every time (src/viewing.ts, mayViewIn): never for an item that is
 * not online, does not exist, or is of a workspace with a disabled account.
 */
export async function itemMayView(deps: Deps, id: string, provedEmail: string | null): Promise<boolean> {
  if (typeof id !== "string" || !ITEM_ID.test(id)) return false;
  return mayViewIn(deps, ITEM_LIST, id, provedEmail, " AND t.state = 'online'");
}

/** The kind of item each letter of an address serves. */
const KIND_OF_LETTER = { i: "image", r: "clip" } as const;

/**
 * True for an item that may be served restricted: found online by its link (onlineItemFiles,
 * which leaves out a disabled account's), restricted, of the kind its address's letter serves,
 * and of no more parts than one restricted answer may read.
 */
export function servableRestricted(item: OnlineItemFiles | null, letter: "i" | "r"): item is OnlineItemFiles {
  return item !== null && isRestricted(item.access) && item.kind === KIND_OF_LETTER[letter] && item.parts.length > 0 && item.parts.length <= RESTRICTED_SERVED_PARTS;
}

/** What the gate looks up when the path it is given is malformed: a link id of the right shape, so the statements are the very ones of any other question. */
const STAND_IN_LINK = "a".repeat(20);
/** An item id of the right shape that no item has (newId draws 96 random bits; this one is all zeros). */
const NO_ITEM = "med_" + "0".repeat(24);

/**
 * The gate the media viewer scope asks before it mails a link (ViewerGate): yes only for an
 * item servableRestricted allows at the page `path` asked from, and an address itemMayView
 * allows. Every question makes the same three statements in the same order, whatever it
 * answers: the item by link (two, STAND_IN_LINK for a malformed path), then the check (for the
 * all-zero id when there is no item, with "" for a malformed address, which proves nothing).
 * Then one digest, the workspace key a restricted tour's gate gives for the same workspace, so
 * the workspace's viewer mails of both kinds are counted together.
 */
export const MEDIA_GATE: ViewerGate = {
  async mayRequest(deps, path, email) {
    const wellFormed = typeof path === "string" && ITEM_PAGE.test(path);
    const found = await onlineItemFiles(deps, wellFormed ? path.slice(3) : STAND_IN_LINK);
    const item = wellFormed ? found : null;
    const may = await itemMayView(deps, item?.id ?? NO_ITEM, typeof email === "string" ? email : "");
    const workspaceKey = await workspaceKeyOf(item?.workspaceId ?? "");
    const letter = wellFormed ? (path[1] as "i" | "r") : "i";
    return servableRestricted(item, letter) && may ? { allowed: true, workspaceKey } : { allowed: false };
  },
};

// Wired once, when this module is loaded (src/app.ts imports it): from then on every viewer
// link request on the media address asks this gate.
useMediaViewerGate(MEDIA_GATE);

// ---- The API ----

const notFound = () => apiError(404, "not_found", "no such item");
const cannotRestrictAnswer = () =>
  apiError(409, "cannot_restrict", "this site cannot send mail, so nobody could get a link to view a restricted item; the item stays as it is");
const tooLarge = () =>
  apiError(409, "too_large_to_restrict", `a restricted item may have at most ${RESTRICTED_MAX_BYTES} bytes on this site, so this one cannot be restricted; the item stays as it is`);
const busy = () => apiError(409, "access_busy", "the item changed while this request was being decided; send it again");

/** What the two routes read of an item. */
type State = { id: string; access: Access; parts: number; viewers: string[] };

/** One call. Null for an item that is not this workspace's, is being deleted, or was left unfinished past its age (as the item routes answer it). */
async function readState(deps: Deps, auth: Auth, id: string): Promise<State | null> {
  type Row = { id: string; access: Access; parts: number; state: string; created_at: number; viewers: string };
  const row = await deps.db.first<Row>(
    `SELECT m.id, m.access, m.parts, m.state, m.created_at, (SELECT json_group_array(v.email) FROM media_viewer v WHERE v.media_id = m.id) AS viewers
       FROM media m WHERE m.id = ? AND m.workspace_id = ?`,
    [id, auth.workspaceId],
  );
  if (row === null || row.state === "closing") return null;
  if (row.state === "uploading" && row.created_at < deps.now() - MEDIA_MAX_AGE_MS) return null;
  return { id: row.id, access: row.access, parts: row.parts, viewers: (JSON.parse(row.viewers) as string[]).sort() };
}

/** The answer of GET to a session, and of a PUT. */
function settingAnswer(deps: Deps, access: Access, viewers: string[]) {
  return json(200, { access, viewers, limit: MAX_VIEWERS, can_restrict: canRestrictItems(deps) });
}

/**
 * The statement that changes the setting from `from` to `to`, and with it where the link id is
 * kept: into private_link_id, with a fresh name nobody is given in link_id, when the item
 * becomes restricted; back into link_id when it becomes public. Only while the item is the
 * workspace's, not being deleted, and still has the setting `from`.
 */
function settingStatement(id: string, ws: string, from: Access, to: Access): Stmt {
  const where = "WHERE id = ? AND workspace_id = ? AND access = ? AND state <> 'closing'";
  if (!isRestricted(from) && isRestricted(to)) {
    return { sql: `UPDATE media SET access = ?, private_link_id = link_id, link_id = ? ${where}`, params: [to, newLinkId(), id, ws, from] };
  }
  if (isRestricted(from) && !isRestricted(to)) {
    return { sql: `UPDATE media SET access = 'public', link_id = private_link_id, private_link_id = NULL ${where}`, params: [id, ws, from] };
  }
  return { sql: `UPDATE media SET access = ? ${where}`, params: [to, id, ws, from] };
}

/** PUT, after the body and the id were checked: decide, and act, in one batch. */
async function putAccess(d: Deps, auth: Auth, id: string, body: AccessBody): Promise<Response> {
  const ws = auth.workspaceId;
  // An item that changes under the request between the read and the batch makes the batch
  // fail (its audit row guards the change of setting) and is decided once more.
  for (let attempt = 0; attempt < 2; attempt++) {
    const st = await readState(d, auth, id);
    if (st === null) return notFound();
    const list = body.viewers ?? st.viewers;
    const listChanged = !sameList(list, st.viewers);
    if (cannotRestrict(d, st.access, body.access, canRestrictItems)) return cannotRestrictAnswer();
    if (isRestricted(body.access) && !isRestricted(st.access) && st.parts > RESTRICTED_SERVED_PARTS) return tooLarge();
    const now = d.now();
    const stmts: Stmt[] = [];
    if (body.access !== st.access) {
      stmts.push(settingStatement(id, ws, st.access, body.access));
      stmts.push(changeAudit(d, auth, "media_access_changed", id, st.access, body.access, st.viewers.length, list.length, true));
    } else if (listChanged) {
      stmts.push(changeAudit(d, auth, "media_access_changed", id, st.access, st.access, st.viewers.length, list.length, false));
    }
    if (listChanged) stmts.push(...viewerStatements(ITEM_LIST, id, ws, list, now));
    if (stmts.length > 0) {
      try {
        await d.db.batch(stmts);
      } catch (err) {
        // Changed meanwhile (the guard), or the fresh name met one taken (2^-100): decide again.
        if (isNotNullViolation(err) || isUniqueViolation(err)) continue;
        throw err;
      }
    }
    return settingAnswer(d, body.access, list);
  }
  return busy();
}

// ---- The setting stated at an item's create ----
//
// A token may state who may view an item in the request that creates it (POST /api/v1/media,
// src/media.ts), and only there: from then on only a signed-in session changes it (PUT above).
// The row is written with the setting already in it, in the one batch that writes it, so a
// restricted item is restricted from its first moment: it is uploading then, which no route
// serves to anyone, and when its commit puts it online it is already restricted, with its link
// id kept apart (private_link_id, and a fresh name nobody is given in link_id) exactly as a
// change to restricted keeps it. Its list and the audit row go in the same batch. Everything
// that could refuse a restricted setting is decided before anything is written: the same
// refusals, with the same codes and words, as the PUT.

/** What an item's create needs to write the stated setting: the row's three columns, and the statements after it. */
export type ItemCreationAccess = {
  access: Access;
  /** The real link id, in link_id for a public item, in private_link_id for a restricted one. */
  linkId: string;
  /** link_id: the real link id for a public item; for a restricted one a fresh name nothing gives out. */
  rowLinkId: string;
  privateLinkId: string | null;
  /** The number of addresses on the list it is created with. */
  viewers: number;
  /** After the row's insert, in its batch: the audit row (its guard: the insert must have written the row), then the list. */
  after: (deps: Deps, auth: Auth, id: string, now: number) => Stmt[];
};

/**
 * Decides the setting stated at an item's create, before anything is written: null when the
 * request stated nothing, or exactly what an item is created with anyway (`public` and no
 * addresses), so the create is today's, byte for byte. Otherwise the refusal (cannot_restrict,
 * too_large_to_restrict, as the PUT words them), or what to write.
 */
export function itemCreationAccess(deps: Deps, asked: AccessBody | null, parts: number): ItemCreationAccess | null | Response {
  if (asked === null) return null;
  const list = asked.viewers ?? [];
  if (asked.access === "public" && list.length === 0) return null;
  if (cannotRestrict(deps, "public", asked.access, canRestrictItems)) return cannotRestrictAnswer();
  if (isRestricted(asked.access) && parts > RESTRICTED_SERVED_PARTS) return tooLarge();
  const linkId = newLinkId();
  const restricted = isRestricted(asked.access);
  return {
    access: asked.access,
    linkId,
    rowLinkId: restricted ? newLinkId() : linkId,
    privateLinkId: restricted ? linkId : null,
    viewers: list.length,
    after: (d, auth, id, now) => [
      changeAudit(d, auth, "media_access_changed", id, "public", asked.access, 0, list.length, true, true),
      ...(list.length > 0 ? viewerStatements(ITEM_LIST, id, auth.workspaceId, list, now) : []),
    ],
  };
}

export function mediaAccessRoutes(app: Hono, deps: Deps): void {
  // The setting, for the item's own workspace. A signed-in session gets the whole list of
  // addresses; a token (the desktop app) gets how many there are, `viewers_count`, in its
  // place and never the addresses:
  //   session: {access, viewers: [...], limit, can_restrict}
  //   token:   {access, viewers_count, limit, can_restrict}
  // One call after the credential.
  app.get("/api/v1/media/:id/access", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    const id = c.req.param("id");
    if (!ITEM_ID.test(id)) return notFound();
    const st = await readState(deps, auth, id);
    if (st === null) return notFound();
    if (auth.session === undefined) return json(200, { access: st.access, viewers_count: st.viewers.length, limit: MAX_VIEWERS, can_restrict: canRestrictItems(deps) });
    return settingAnswer(deps, st.access, st.viewers);
  });

  // Change the setting, and the whole list when `viewers` is given: a signed-in session only,
  // with the anti-forgery header; a token gets the one 401, so a stolen desktop token cannot
  // make a restricted item public. Answers 200 with the state as GET gives it to a session.
  app.put("/api/v1/media/:id/access", async (c) => {
    const auth = await requireAuth(c.req.raw, deps, { only: "session" });
    if (auth instanceof Response) return auth;
    const body = await readAccessBody(c.req.raw, "an item's");
    if (body instanceof Response) return body;
    const id = c.req.param("id");
    if (!ITEM_ID.test(id)) return notFound();
    return putAccess(deps, auth, id, body);
  });
}
