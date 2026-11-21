// Who may view a tour: its setting, its list of addresses, and the switch that moves its
// live pictures between the two stores (migrations 0014 and the private_data column).
//
// The setting is `public` (anyone with the link; every tour before this, and the default),
// `people` (the addresses on the tour's list, and the owner) or `me` (the owner alone). The
// owner is every account that is a member of the tour's workspace, looked up through the
// membership and the account row at the moment of the check (mayView), so an email change
// counts from the next request, and nothing about the owner is copied anywhere. The list
// holds up to MAX_VIEWERS addresses, each as parseEmail (src/accounts.ts) writes it, which is
// how sign-in writes the address it mails; it is kept when the setting moves away from
// `people`. Nothing here sends mail. Making a public tour `people` or `me` needs a site that
// can mail a link (canMailLinks), since nobody could otherwise prove an address; moving
// between the two restricted settings never loosens anything and is always allowed, and a
// tour already restricted stays restricted when mail goes away. Only a signed-in session may
// change the setting or the list: a token (the desktop app) may read them, so a stolen token
// cannot make a restricted tour public.
//
// Where the live pictures are follows from the setting. A public tour's are in the public
// store (`p/` keys), served by GET /p/<name> and perhaps straight from a public bucket
// domain (PUBLIC_IMAGE_BASE). A restricted tour's are in the PRIVATE store (`v/` keys), so
// no bucket domain can reach them; only a route that runs the app's check may serve them
// (tourForServing and mayView below, for the task that builds that route). Until then the
// tour page and /p/ answer a restricted tour exactly as an unknown one (src/page.ts,
// src/publish.ts: both look for `access = 'public'` in the one lookup they make).
//
// An older build knows none of this, so a restricted tour holds nothing it could serve: the
// real snapshot text is in snapshot.private_data, which no older build reads, and
// snapshot.data holds RESTRICTED_STUB, which every older build's page answers as not found
// (it is no tour: no zoom, no theme, no chapters). Its live pictures are `v/` keys, which no
// older build's picture route serves (it serves `p/` names only), and from the first step of
// a move to restricted the old public pictures are no live snapshot's any more.
//
// Between `people` and `me`, and for a change of the list, nothing moves: one batch, in
// force on the next request. Across `public` and the two others, an UNPUBLISHED tour also
// changes in one batch (a publish in progress is cancelled, as unpublish cancels one, since
// its pictures were going to the other store). A PUBLISHED tour's live pictures move:
// the version that is live now, never the draft, under the same slug. The move is an access
// switch, in bounded steps on the publish machinery (src/publish.ts: its copy, its pending
// rows, its batches), driven by the client sending the same PUT again, each request within
// SUBREQUEST_BUDGET calls:
//
// Public to restricted (target 'private'):
// 1. One read of the live snapshot, then ONE batch: the setting becomes the new one (from
//    this moment the page and /p/ answer 404, and every name /p/ might still serve, a
//    re-publish's retired names inside their grace included, stops with it), the audit
//    row, every retired picture of the tour made due now, a publish in progress cancelled,
//    the switch row with the snapshot renamed to new `v/` keys, the live `p/` keys moved out
//    of snapshot_object into pending "source" rows (publish_id 'sws_' + the switch's hex),
//    one pending row per new key, before anything is written, and the snapshot's text moved
//    to private_data with the stub left in data. The batch takes effect only while the
//    snapshot is still the one read (its publish and its keys) and no switch exists, so
//    nothing is half done.
// 2. Each request copies the next pictures from their `p/` keys to their `v/` keys, marks
//    them copied with a heartbeat on the switch row, and then deletes those pictures' `p/`
//    objects from the public store, each object before its source row. So the public store
//    empties as the move goes.
// 3. The request that copies the last ones commits in ONE batch: the renamed snapshot (with
//    the tour's title as it is now, so a rename meanwhile is kept) into private_data, the
//    remaining source rows retired and due now (no grace), the new keys into
//    snapshot_object, the switch row dropped. Then it deletes the due keys; it answers 200
//    only once no `p/` key of the tour is left, else 202, and the next request deletes the
//    rest.
// A switch to private that makes no progress for CARRY_AFTER_MS is carried on by the
// workspace's housekeeping (carryOnSwitch), CARRY_COPIES pictures per request, so it
// finishes without its client. Only the requests with room for it give housekeeping the
// calls (CARRY_CALLS): the tour list and unpublish. An upload's create, publish and a delete
// give none, so no request goes over its budget for it. A switch to public left for
// STALE_PUBLISH_MS is cancelled the same way.
//
// Restricted to public (target 'public'): the same steps, except that the setting stays
// restricted until the commit, which switches it to 'public' in the same batch, puts the
// renamed text back into data (private_data emptied), and writes the audit row. So the
// tour is publicly served only when every picture is in the public store. Until then it can
// be cancelled by asking for the setting it still has: the switch row goes, its new public
// pictures are retired and deleted, and the tour stays as it was.
//
// Why each step is safe to interrupt: before the first batch nothing has changed; after it
// the tour is restricted (or, going public, still restricted) and stays so whatever
// happens; each new object is named by its pending row before it is written, each old one by
// its live, source or retired row until it is deleted, and a row goes only after its object;
// a request that dies anywhere leaves a switch the next request (or housekeeping, going
// private) continues (a copy is written again under the same key; a commit is one batch). A
// switch is never taken for an abandoned publish (RETIRE_ABANDONED_SQL). Unpublish and delete
// cancel it (their batches retire or record its rows and drop it); a request of it still
// running then finds its rows gone, deletes what it wrote unless it is live, and answers 409
// switch_cancelled. While a switch is in progress a publish answers 409 access_switching,
// and a PUT with another target is refused with that same code.
//
// The storage allowance counts the draft pictures and logo, never a live copy in either
// store (src/usage.ts), so a switch changes nothing in it at any moment: every byte it
// counts is counted once throughout.
//
// The list of addresses is the workspace's data: it is answered by GET .../access to a
// signed-in session alone (a token gets its count), never by another route, an audit row (which holds counts) or a log line, and a refusal of
// a malformed address names its position only.
import type { Hono } from "hono";
import { noDisabledAccount } from "./accounts.ts";
import { requireAuth, type Auth } from "./auth.ts";
import { metered, SUBREQUEST_BUDGET } from "./budget.ts";
import { apiError, json } from "./http.ts";
import { canMailLinks, isNotNullViolation, isUniqueViolation, type Deps, type Stmt } from "./ports.ts";
import { COPY_BATCH, MissingSource, STALE_PUBLISH_MS, clearDuePage, copyOne, deleteKeys, keyList, liveKey, mime, nextBatch, randomHex, runLimited, typeOfKey, type Copy } from "./publish.ts";
import * as viewing from "./viewing.ts";
import { MAX_VIEWERS, isRestricted, readAccessBody, sameList, type Access, type AccessBody, type ListPlace } from "./viewing.ts";

/** The settings, the list's limit and the body's cap: shared with shared items (src/viewing.ts). */
export { ACCESS_BODY_BYTES, ACCESS_SETTINGS, MAX_VIEWERS, type Access } from "./viewing.ts";

/** Where a tour's list is kept. */
const TOUR_LIST: ListPlace = { list: "tour_viewer", key: "tour_id", owner: "tour" };

/** Copies in flight at once, as a publish. */
const COPIES_IN_FLIGHT = 4;
/**
 * The calls a switch request may need after its copies, in the worst case: the commit and
 * the clean-up of the old keys (1 + 4); or marking (2) and then, going private, deleting the
 * batch's public sources and their rows (2); or marking (2) and then, when the switch was
 * ended meanwhile, a read and the deletes of what it wrote (1 + 2), and after a commit that
 * a second request made, the clean-up too (4). The largest is 9.
 */
const CALLS_AFTER_COPIES = 9;
/** A switch to private with no progress for this long is carried on by the workspace's housekeeping. */
export const CARRY_AFTER_MS = 60_000;
/** The most pictures one housekeeping run moves of a stopped switch to private. */
export const CARRY_COPIES = 4;
/**
 * The calls the requests with room give housekeeping for carrying on a switch (the tour list
 * and unpublish): 9 + 2 per picture, so CARRY_COPIES pictures (see carryOnSwitch).
 */
export const CARRY_CALLS = 9 + 2 * CARRY_COPIES;

/**
 * What snapshot.data holds while a tour is restricted (its real text is in private_data). It
 * is no tour: every build's page reads `zoom`, `theme`, `autoplay` and `chapters` from the
 * snapshot and answers a snapshot without them as not found, so an older build that knows
 * nothing of the setting serves nothing of it either (test/access.test.ts runs the lookup of
 * 0.1.35 against it). It holds nothing of the tour, not even its title.
 */
export const RESTRICTED_STUB = '{"restricted":true}';

const TOUR_ID = /^tour_[0-9a-f]{24}$/;
const SLUG = /^[a-z2-7]{10}$/;
/** A restricted tour's live key, and the name the page uses for it after `v/`. */
const PRIVATE_KEY = /^v\/([0-9a-f]{32}\.(?:png|jpg))$/;

/** The publish_id of a switch to private's source rows: its old public pictures, until each is deleted. */
const sourcesOf = (switchId: string) => "sws_" + switchId.slice(3);

// ---- For the route that serves restricted tours ----

/** A restricted tour's live picture in the private store. */
export type ServedPicture = { key: string; contentType: "image/png" | "image/jpeg" };

/** Everything needed to decide whether to serve a tour, and to serve it. */
export type ServedTour = {
  id: string;
  slug: string;
  workspaceId: string;
  /** The setting in force. During a switch to public it stays restricted until the switch's last step. */
  access: Access;
  /** True when the tour is published: its status says so and it has a live snapshot. */
  published: boolean;
  /** False when an account of its workspace is disabled (noDisabledAccount): then nothing of it may be served. */
  enabled: boolean;
  /** True while a switch of its live pictures between the stores is in progress. */
  switching: boolean;
  /**
   * The live snapshot's text, for pageTour (src/page.ts). For a public tour, whenever it is
   * published. For a restricted tour only together with `pictures`, so a caller that forgot to
   * check them cannot render one that cannot be served; null otherwise.
   */
  data: string | null;
  /**
   * For a published restricted tour whose live pictures are all in the private store: each
   * picture by the name the page uses for it. The snapshot's `image` fields (and the cover's
   * `logo`) hold `v/<name>`, so a page rendered with base B makes the player ask for
   * `B/v/<name>`; `<name>` is 32 hex characters and `.png` or `.jpg`. Null otherwise, which
   * includes a tour in the middle of a switch to restricted (its pictures are still public
   * ones): such a tour must be answered as unavailable.
   */
  pictures: ReadonlyMap<string, ServedPicture> | null;
};

const servedSql = (by: "slug" | "id") => `
  SELECT t.id, t.slug, t.workspace_id, t.access, t.status, coalesce(s.private_data, s.data) AS data,
         EXISTS (SELECT 1 FROM access_switch w WHERE w.tour_id = t.id) AS switching,
         CASE WHEN ${noDisabledAccount("t.workspace_id")} THEN 1 ELSE 0 END AS enabled,
         (SELECT json_group_array(o.image_key) FROM snapshot_object o WHERE o.tour_id = t.id) AS live_keys
    FROM tour t LEFT JOIN snapshot s ON s.tour_id = t.id
   WHERE t.${by} = ?`;

/**
 * The tour with this slug (or id), and all a serving route needs about it, in ONE database
 * call; null when there is none (a malformed slug or id makes no call). It decides nothing:
 * the caller answers 404 unless `published` and `enabled`, asks mayView for a restricted tour,
 * and serves a restricted tour's pictures only through `pictures`.
 */
export async function tourForServing(deps: Deps, ref: { slug: string } | { id: string }): Promise<ServedTour | null> {
  const bySlug = "slug" in ref;
  const value = bySlug ? ref.slug : ref.id;
  if (typeof value !== "string" || !(bySlug ? SLUG : TOUR_ID).test(value)) return null;
  type Row = { id: string; slug: string; workspace_id: string; access: Access; status: string; data: string | null; switching: number; enabled: number; live_keys: string };
  const row = await deps.db.first<Row>(servedSql(bySlug ? "slug" : "id"), [value]);
  if (row === null) return null;
  const published = row.status === "published" && row.data !== null;
  let pictures: Map<string, ServedPicture> | null = null;
  if (published && isRestricted(row.access)) {
    const keys = JSON.parse(row.live_keys) as string[];
    pictures = keys.length > 0 ? new Map() : null;
    for (const key of keys) {
      const m = PRIVATE_KEY.exec(key);
      if (m === null) {
        pictures = null;
        break;
      }
      pictures?.set(m[1], { key, contentType: mime(typeOfKey(key)) as ServedPicture["contentType"] });
    }
  }
  return {
    id: row.id,
    slug: row.slug,
    workspaceId: row.workspace_id,
    access: row.access,
    published,
    enabled: row.enabled === 1,
    switching: row.switching === 1,
    data: !published ? null : isRestricted(row.access) ? (pictures === null ? null : row.data) : row.data,
    pictures,
  };
}

/**
 * Whether a visitor who has proved the address `provedEmail` (null: none) may view the tour,
 * read fresh in ONE database call every time, whatever `tour` held when it was read: true for
 * a public tour; for `people` when the address is on the tour's list or is the address of an
 * account that is a member of the tour's workspace; for `me` only the latter. Always false for
 * a tour that does not exist and for one whose workspace has a disabled account. The address
 * is compared as parseEmail writes it; one it refuses proves nothing.
 */
export async function mayView(deps: Deps, tour: { id: string }, provedEmail: string | null): Promise<boolean> {
  if (typeof tour?.id !== "string" || !TOUR_ID.test(tour.id)) return false;
  return viewing.mayViewIn(deps, TOUR_LIST, tour.id, provedEmail);
}

// ---- The API ----

const notFound = () => apiError(404, "not_found", "no such tour");
const switching = () =>
  apiError(409, "access_switching", "who may view this tour is being changed to another setting; send that same change again until it is done, then this one");
const cannotRestrictAnswer = () =>
  apiError(409, "cannot_restrict", "this site cannot send mail, so nobody could get a link to view a restricted tour; the tour stays as it is");
const cancelled = () =>
  apiError(409, "switch_cancelled", "the change was stopped before it finished (the tour was unpublished or deleted meanwhile); send it again to apply it to the tour as it is now");
const busy = () => apiError(409, "access_busy", "the tour changed while this request was being decided; send it again");
const failed = () => apiError(500, "access_failed", "the change could not be completed yet; send the same request again to continue it");
const pictureMissing = () =>
  apiError(409, "republish_needed", "a picture of the tour's published version is missing, so it cannot be moved; unpublish the tour, then publish it again");
const republish = () =>
  apiError(409, "republish_needed", "the tour's published version cannot be moved as it is; publish the tour again, then send this change again");
/** Which way a move goes, in the API's words: to "public", or to "restricted" (the private store). */
type Direction = "public" | "restricted";
const directionOf = (target: "public" | "private"): Direction => (target === "public" ? "public" : "restricted");
const progress = (done: number, total: number, target: Direction) => json(202, { status: "switching", done, total, target });
/** The `switching` field of an answer: null, or the move's progress and which way it goes. */
const switchingOf = (sw: { copied: number; total: number; target: "public" | "private" } | null) => (sw === null ? null : { done: sw.copied, total: sw.total, target: directionOf(sw.target) });

/** What the two routes read of a tour: its setting, list, live version and switch. */
type State = {
  id: string;
  access: Access;
  /** True when the tour has a live snapshot. */
  live: boolean;
  viewers: string[];
  switch: { id: string; target: "public" | "private"; total: number; copied: number } | null;
  /** Retired `p/` pictures of the tour still in the public store. */
  stray: number;
  /** Retired pictures of the tour, of either store, whose time to be deleted has come. */
  due: number;
  /** True when the tour has been published at least once (see `everPublished`). */
  ever: boolean;
};

/**
 * Whether a tour has been published at least once, over a tour row `t` in scope: it is
 * published now (its status, published_at, a snapshot or a switch says so), or its
 * ever_published mark is set (migration 0017: unpublish sets it in the batch that removes the
 * rest of that evidence, and nothing clears it). A tour unpublished before migration 0017, or
 * by an older build, left nothing behind and does not count. No parameter.
 */
const EVER_PUBLISHED = `(t.ever_published = 1 OR t.status = 'published' OR t.published_at IS NOT NULL
   OR EXISTS (SELECT 1 FROM snapshot e WHERE e.tour_id = t.id) OR EXISTS (SELECT 1 FROM access_switch e WHERE e.tour_id = t.id))`;

/** One call. Null for a tour that is not this workspace's. */
async function readState(deps: Deps, auth: Auth, id: string): Promise<State | null> {
  type Row = { id: string; access: Access; live: number; viewers: string; switch_id: string | null; target: "public" | "private" | null; total: number | null; copied: number; stray: number; due: number; ever: number };
  const row = await deps.db.first<Row>(
    `SELECT t.id, t.access, s.tour_id IS NOT NULL AS live,
            (SELECT json_group_array(v.email) FROM tour_viewer v WHERE v.tour_id = t.id) AS viewers,
            w.switch_id, w.target, w.total,
            (SELECT count(*) FROM public_object o WHERE o.publish_id = w.switch_id AND o.tour_id = t.id AND o.state = 'pending' AND o.copied = 1) AS copied,
            (SELECT count(*) FROM public_object o WHERE o.tour_id = t.id AND o.state = 'retired' AND substr(o.image_key, 1, 2) = 'p/') AS stray,
            (SELECT count(*) FROM public_object o WHERE o.tour_id = t.id AND o.state = 'retired' AND o.delete_after <= ?) AS due,
            ${EVER_PUBLISHED} AS ever
       FROM tour t LEFT JOIN snapshot s ON s.tour_id = t.id LEFT JOIN access_switch w ON w.tour_id = t.id
      WHERE t.id = ? AND t.workspace_id = ?`,
    [deps.now(), id, auth.workspaceId],
  );
  if (row === null) return null;
  return {
    id: row.id,
    access: row.access,
    live: row.live === 1,
    viewers: (JSON.parse(row.viewers) as string[]).sort(),
    switch: row.switch_id === null ? null : { id: row.switch_id, target: row.target ?? "private", total: row.total ?? 0, copied: row.copied },
    stray: row.stray,
    due: row.due,
    ever: row.ever === 1,
  };
}

/** The answer of GET, and of a PUT that is done. */
function settingAnswer(deps: Deps, access: Access, viewers: string[], sw: State["switch"]) {
  return json(200, { access, viewers, limit: MAX_VIEWERS, can_restrict: canMailLinks(deps), switching: switchingOf(sw) });
}

const OWNED = "SELECT id FROM tour WHERE id = ? AND workspace_id = ?";

/** Replaces the tour's list with `list` (sorted, distinct, parsed), keeping the time an address that stays was added. */
function viewerStatements(id: string, ws: string, list: string[], now: number): Stmt[] {
  return viewing.viewerStatements(TOUR_LIST, id, ws, list, now);
}

/** A publish in progress is cancelled as unpublish cancels one: its rows retired and due now, its job dropped, so it can never commit. */
function cancelPublish(id: string, ws: string, now: number): Stmt[] {
  return [
    { sql: `UPDATE public_object SET state = 'retired', delete_after = ? WHERE state = 'pending' AND tour_id IN (${OWNED})`, params: [now, id, ws] },
    { sql: `DELETE FROM publish_job WHERE tour_id IN (${OWNED})`, params: [id, ws] },
  ];
}

/** Every retired picture of the tour becomes due now: nothing waits out a grace once the tour is restricted. */
function expediteRetired(id: string, ws: string, now: number): Stmt {
  return { sql: `UPDATE public_object SET delete_after = ? WHERE state = 'retired' AND delete_after > ? AND tour_id IN (${OWNED})`, params: [now, now, id, ws] };
}

/** The audit row of a change: the settings and the list's sizes, never an address. */
function changeAudit(deps: Deps, auth: Auth, id: string, from: Access, to: Access, before: number, after: number, guard: boolean): Stmt {
  return viewing.changeAudit(deps, auth, "tour_access_changed", id, from, to, before, after, guard);
}

/**
 * The live snapshot renamed for the other store: each live key gets a new key of the target
 * store, and every picture the snapshot names (each step's image, the cover's logo) is
 * renamed with it. Null when the snapshot is not JSON of the expected shape, names a picture
 * that is not live, or a live key is already of the target store.
 */
function renamed(data: string, liveKeys: string[], toPrivate: boolean): { data: string; copies: Copy[] } | null {
  const names = new Map<string, string>();
  const copies: Copy[] = [];
  for (const key of liveKeys) {
    if (key.startsWith("p/") !== toPrivate) return null;
    const to = liveKey(typeOfKey(key), toPrivate);
    names.set(key, to);
    copies.push({ from: key, to });
  }
  let snap: unknown;
  try {
    snap = JSON.parse(data);
  } catch {
    return null;
  }
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObj(snap) || !Array.isArray(snap.chapters)) return null;
  const swap = (v: unknown): string | null => (typeof v === "string" ? (names.get(v) ?? null) : null);
  for (const chapter of snap.chapters) {
    if (!isObj(chapter) || !Array.isArray(chapter.steps)) return null;
    for (const step of chapter.steps) {
      if (!isObj(step)) return null;
      const to = swap(step.image);
      if (to === null) return null;
      step.image = to;
    }
  }
  if (isObj(snap.cover) && snap.cover.logo !== null && snap.cover.logo !== undefined) {
    const to = swap(snap.cover.logo);
    if (to === null) return null;
    snap.cover.logo = to;
  }
  return { data: JSON.stringify(snap), copies };
}


/**
 * The first batch of a switch (see the top of this file). Its guard is the switch row's
 * insert: NOT NULL fails it, and the whole batch, unless the tour is this workspace's, its
 * setting is restricted (just made so, going to private), the snapshot is still the publish
 * read and holds exactly the keys read, and no switch exists (the primary key).
 */
function startStatements(deps: Deps, auth: Auth, st: State, body: AccessBody, list: string[], sw: { id: string; toPrivate: boolean; from: string | null; data: string; copies: Copy[] }, now: number): Stmt[] {
  const ws = auth.workspaceId;
  const id = st.id;
  const listChanged = !sameList(list, st.viewers);
  const stmts: Stmt[] = [];
  if (sw.toPrivate) {
    stmts.push({ sql: "UPDATE tour SET access = ? WHERE id = ? AND workspace_id = ? AND access = 'public'", params: [body.access, id, ws] });
    stmts.push(changeAudit(deps, auth, id, st.access, body.access, st.viewers.length, list.length, true));
  } else if (listChanged) {
    stmts.push(changeAudit(deps, auth, id, st.access, st.access, st.viewers.length, list.length, false));
  }
  stmts.push(expediteRetired(id, ws, now), ...cancelPublish(id, ws, now));
  const sources = JSON.stringify(sw.copies.map((c) => c.from));
  stmts.push({
    sql: `INSERT INTO access_switch (tour_id, switch_id, target, from_publish, data, total, created_at, touched_at)
          VALUES ((SELECT t.id FROM tour t JOIN snapshot s ON s.tour_id = t.id
                    WHERE t.id = ? AND t.workspace_id = ? AND t.access <> 'public' AND s.publish_id IS ?
                      AND (SELECT count(*) FROM snapshot_object o WHERE o.tour_id = t.id) = ?
                      AND NOT EXISTS (SELECT 1 FROM snapshot_object o WHERE o.tour_id = t.id AND o.image_key NOT IN (SELECT value FROM json_each(?)))),
                  ?, ?, ?, ?, ?, ?, ?)`,
    params: [id, ws, sw.from, sw.copies.length, sources, sw.id, sw.toPrivate ? "private" : "public", sw.from, sw.data, sw.copies.length, now, now],
  });
  if (sw.toPrivate) {
    // The live public pictures are no live snapshot's from now on: no build, an older one
    // included, serves them; each stays named by its source row until it is deleted.
    stmts.push(
      {
        sql: `INSERT INTO public_object (image_key, tour_id, publish_id, state, created_at, copied) SELECT image_key, tour_id, ?, 'pending', ?, 0 FROM snapshot_object WHERE tour_id IN (${OWNED})`,
        params: [sourcesOf(sw.id), now, id, ws],
      },
      { sql: `DELETE FROM snapshot_object WHERE tour_id IN (${OWNED})`, params: [id, ws] },
      // The real text where no older build looks, and the stub in its place.
      { sql: `UPDATE snapshot SET private_data = coalesce(private_data, data), data = ? WHERE tour_id IN (${OWNED})`, params: [RESTRICTED_STUB, id, ws] },
    );
  }
  stmts.push({
    sql: `INSERT INTO public_object (image_key, tour_id, publish_id, state, created_at, source_key, seq, copied)
          SELECT json_extract(j.value, '$[0]'), t.id, ?, 'pending', ?, json_extract(j.value, '$[1]'), j.key, 0
            FROM json_each(?) j JOIN tour t ON t.id = ? AND t.workspace_id = ?`,
    params: [sw.id, now, JSON.stringify(sw.copies.map((c) => [c.to, c.from])), id, ws],
  });
  if (listChanged) stmts.push(...viewerStatements(id, ws, list, now));
  return stmts;
}

/**
 * The last batch of a switch. The snapshot statement is its guard: its data is NULL, which
 * fails the whole batch, unless the switch still exists, every one of its rows is pending and
 * copied (or copied by this request), and the snapshot is still the publish it started from.
 * Going private, the renamed text goes to private_data (data keeps the stub) and the source
 * rows left are retired, due now. Going public, the setting becomes 'public' first, `audit`
 * (the audit row) right after that change as its guard, then the text goes back to data and
 * private_data is emptied.
 */
function commitStatements(ws: string, id: string, switchId: string, toPublic: boolean, justCopied: string[], now: number, audit: Stmt | null): Stmt[] {
  const text = `(SELECT json_set(w.data, '$.title', t.title) FROM access_switch w JOIN tour t ON t.id = w.tour_id JOIN snapshot n ON n.tour_id = t.id
                  WHERE w.switch_id = ? AND w.tour_id = ? AND t.workspace_id = ? AND n.publish_id IS w.from_publish
                    AND (SELECT count(*) FROM public_object o
                          WHERE o.publish_id = w.switch_id AND o.tour_id = w.tour_id AND o.state = 'pending'
                            AND (o.copied = 1 OR o.image_key IN (SELECT value FROM json_each(?)))) = w.total)`;
  const textParams = [switchId, id, ws, keyList(justCopied)];
  const snapshot: Stmt = toPublic
    ? {
        sql: `INSERT INTO snapshot (tour_id, data, private_data, published_at) VALUES (?, ${text}, NULL, 0)
              ON CONFLICT (tour_id) DO UPDATE SET data = excluded.data, private_data = NULL`,
        params: [id, ...textParams],
      }
    : {
        sql: `INSERT INTO snapshot (tour_id, data, private_data, published_at) VALUES (?, CASE WHEN ${text} IS NULL THEN NULL ELSE ? END, ${text}, 0)
              ON CONFLICT (tour_id) DO UPDATE SET data = excluded.data, private_data = excluded.private_data`,
        params: [id, ...textParams, RESTRICTED_STUB, ...textParams],
      };
  // Going public, the setting changes first in the batch: the database refuses a public
  // picture or a text other than the stub for a tour that is still restricted (the
  // triggers of migration 0014), and the whole batch is undone if anything after it fails.
  const head: Stmt[] = toPublic
    ? [{ sql: "UPDATE tour SET access = 'public' WHERE id = ? AND workspace_id = ? AND access <> 'public'", params: [id, ws] }, ...(audit === null ? [] : [audit])]
    : [];
  const stmts: Stmt[] = [
    ...head,
    snapshot,
    { sql: "UPDATE public_object SET state = 'retired', delete_after = ? WHERE publish_id = ? AND tour_id = ? AND state = 'pending'", params: [now, sourcesOf(switchId), id] },
    // The old live keys (going public, the private ones): retired and due now.
    {
      sql: "INSERT INTO public_object (image_key, tour_id, publish_id, state, created_at, delete_after) SELECT image_key, tour_id, ?, 'retired', ?, ? FROM snapshot_object WHERE tour_id = ?",
      params: [switchId, now, now, id],
    },
    { sql: "DELETE FROM snapshot_object WHERE tour_id = ?", params: [id] },
    { sql: "INSERT INTO snapshot_object (tour_id, image_key) SELECT tour_id, image_key FROM public_object WHERE publish_id = ? AND state = 'pending' AND tour_id = ?", params: [switchId, id] },
    { sql: "DELETE FROM public_object WHERE publish_id = ? AND state = 'pending' AND tour_id = ?", params: [switchId, id] },
    { sql: "DELETE FROM access_switch WHERE switch_id = ? AND tour_id = ?", params: [switchId, id] },
  ];
  return stmts;
}

/**
 * Marks a batch copied, with the heartbeat on the switch row (two calls). False when the
 * switch ended meanwhile: one of the two found fewer rows than it should. Housekeeping passes
 * `heartbeat` false: its work leaves the switch as stopped as it was, so the next request of
 * the workspace carries it on again rather than waiting CARRY_AFTER_MS.
 */
async function markCopied(d: Deps, id: string, switchId: string, written: string[], heartbeat = true): Promise<boolean> {
  const touched = heartbeat
    ? await d.db.run("UPDATE access_switch SET touched_at = ? WHERE switch_id = ? AND tour_id = ?", [d.now(), switchId, id])
    : await d.db.run("UPDATE access_switch SET touched_at = touched_at WHERE switch_id = ? AND tour_id = ?", [switchId, id]);
  const marked = await d.db.run(
    "UPDATE public_object SET copied = 1 WHERE publish_id = ? AND tour_id = ? AND state = 'pending' AND image_key IN (SELECT value FROM json_each(?))",
    [switchId, id, keyList(written)],
  );
  return touched.changes === 1 && marked.changes === written.length;
}

/**
 * Going private, once a batch is marked copied: its public pictures are deleted from the
 * public store, then their source rows (two calls). A failure leaves them to the commit,
 * which retires every source row left, and to the clean-up after it.
 */
async function dropSources(d: Deps, id: string, switchId: string, batch: Copy[]): Promise<void> {
  const keys = batch.map((c) => c.from).filter((k) => k.startsWith("p/"));
  if (keys.length === 0) return;
  try {
    await deleteKeys(d, keys);
    await d.db.run("DELETE FROM public_object WHERE publish_id = ? AND tour_id = ? AND state = 'pending' AND image_key IN (SELECT value FROM json_each(?))", [
      sourcesOf(switchId),
      id,
      keyList(keys),
    ]);
  } catch {
    console.error("access: could not remove some public pictures of a tour made restricted yet; they are removed when the move ends");
  }
}

type Run = { d: Deps; calls: () => number; auth: Auth };

/**
 * Deletes the tour's due retired pictures (one page), the old keys of a switch that just
 * finished among them. True when nothing due is left. Fixed text only in the log.
 */
async function clearTour(d: Deps, ws: string, id: string): Promise<boolean> {
  try {
    return !(await clearDuePage(d, ws, id, 0)).more;
  } catch {
    console.error("access: could not remove a tour's old pictures yet; the next request retries");
    return false;
  }
}

/**
 * After the switch's last batch took effect: the old keys go, then the final answer. Made
 * restricted, the answer is 200 only once no public picture of the tour is left (else 202,
 * and the next request clears the rest); made public, it is 200 at once, the old private
 * pictures being removed now or by a later request.
 */
async function finish(r: Run, st: State, list: string[], access: Access, total: number): Promise<Response> {
  const clean = await clearTour(r.d, r.auth.workspaceId, st.id);
  if (!clean && isRestricted(access)) return progress(total, total, "restricted");
  return settingAnswer(r.d, access, list, null);
}

/**
 * The switch this request was driving ended meanwhile: finished by another request (then
 * the keys this one wrote are live), or cancelled by unpublish or delete (then they are named
 * by nothing, and are deleted here). At most three calls, and the clean-up after a finish.
 */
async function ended(r: Run, st: State, list: string[], sw: NonNullable<State["switch"]>, written: string[], finalAccess: Access): Promise<Response> {
  const { d } = r;
  try {
    const live = new Set(
      (await d.db.all<{ image_key: string }>("SELECT image_key FROM snapshot_object WHERE tour_id = ? AND image_key IN (SELECT value FROM json_each(?))", [st.id, keyList(written)])).map(
        (x) => x.image_key,
      ),
    );
    await deleteKeys(
      d,
      written.filter((k) => !live.has(k)),
    );
    if (written.length > 0 && live.size === written.length) return finish(r, st, list, finalAccess, sw.total);
  } catch {
    console.error("access: could not remove the pictures of a stopped switch; they are removed later");
    return failed();
  }
  return cancelled();
}

/**
 * One request's share of a switch: the next pictures copied and marked (going private, their
 * public pictures then deleted), or the last ones copied and the commit. `first` is the copy
 * list of a switch this request just started.
 */
async function drive(r: Run, st: State, list: string[], sw: NonNullable<State["switch"]>, first: Copy[] | null): Promise<Response> {
  const { d, calls } = r;
  const room = () => Math.min(COPY_BATCH, Math.max(0, Math.floor((SUBREQUEST_BUDGET - calls() - CALLS_AFTER_COPIES) / 2)));
  const toPublic = sw.target === "public";
  const finalAccess: Access = toPublic ? "public" : st.access;
  let batch: Copy[];
  let left: number;
  if (first !== null) {
    batch = first.slice(0, room());
    left = first.length;
  } else {
    ({ batch, left } = await nextBatch(d, st.id, sw.id, room()));
  }
  const written = batch.map((c) => c.to);
  const missing: string[] = [];
  try {
    await copyBatch(d, batch, missing);
  } catch {
    // A switch that was ended meanwhile (its sources may be gone with it) is told apart from
    // a store that failed: then every key written so far is named by its pending row, and
    // the next request copies it again.
    let still: unknown = 1;
    try {
      still = await d.db.first("SELECT 1 AS x FROM access_switch WHERE switch_id = ? AND tour_id = ?", [sw.id, st.id]);
    } catch {
      // Cannot tell: answer as for a failure, and leave everything for the next request.
    }
    if (still === null) return ended(r, st, list, sw, written, finalAccess);
    if (missing.length > 0) {
      // A source is gone while its copy is still to make. Only the copies that met a missing
      // source are looked at: one that another request (or the carry) made meanwhile, and
      // whose source it then deleted, is marked copied and does not count. A source goes only
      // after its copy is marked, so what is left means that no request can finish this
      // switch. The tour stays restricted; going private, its remaining public sources go
      // now, so nothing of it stays in the public store; unpublishing it ends the switch and
      // removes its pictures, and publishing it again puts its draft live in the right store.
      try {
        const open = await d.db.first<{ n: number }>("SELECT count(*) AS n FROM public_object WHERE publish_id = ? AND tour_id = ? AND state = 'pending' AND copied = 0 AND image_key IN (SELECT value FROM json_each(?))", [
          sw.id,
          st.id,
          keyList(missing),
        ]);
        if ((open?.n ?? 0) > 0) {
          console.error("access: a picture of a published version is missing, so its switch cannot finish; the tour must be unpublished and published again");
          if (!toPublic && (await retireSourcesOfStuck(d, st.id, sw.id, missing))) await clearTour(d, r.auth.workspaceId, st.id);
          return pictureMissing();
        }
      } catch {
        // Cannot tell: answer as for a failure.
      }
    }
    console.error("access: could not copy a tour's pictures to the other store; the next request retries");
    return failed();
  }

  if (batch.length < left) {
    if (!(await markCopied(d, st.id, sw.id, written))) return ended(r, st, list, sw, written, finalAccess);
    if (!toPublic) await dropSources(d, st.id, sw.id, batch);
    return progress(sw.total - left + batch.length, sw.total, directionOf(sw.target));
  }

  const audit = toPublic ? changeAudit(d, r.auth, st.id, st.access, "public", list.length, list.length, true) : null;
  try {
    await d.db.batch(commitStatements(r.auth.workspaceId, st.id, sw.id, toPublic, written, d.now(), audit));
  } catch {
    // It may have taken effect and only its answer been lost, or another request of the same
    // switch may have committed it: look before anything is undone.
    let look: { pending: number | null; other: number; live: number } | null;
    try {
      look = await d.db.first<{ pending: number | null; other: number; live: number }>(
        `SELECT (SELECT 1 FROM access_switch WHERE switch_id = ?) AS pending,
                (SELECT count(*) FROM snapshot_object WHERE tour_id = ? AND (substr(image_key, 1, 2) = 'p/') <> ?) AS other,
                (SELECT count(*) FROM snapshot_object WHERE tour_id = ?) AS live`,
        [sw.id, st.id, toPublic ? 1 : 0, st.id],
      );
    } catch {
      return failed();
    }
    if (look?.pending === 1) return failed(); // still in progress: the next request commits it
    if (look !== null && look.live > 0 && look.other === 0) return finish(r, st, list, finalAccess, sw.total);
    try {
      await deleteKeys(d, written);
    } catch {
      console.error("access: could not remove the pictures of a stopped switch; they are removed later");
    }
    return cancelled();
  }
  return finish(r, st, list, finalAccess, sw.total);
}

/**
 * Runs a batch's copies, noting in `missing` the target of each copy whose source was not in
 * its store (MissingSource), so a caller can tell a source that is really gone from a copy
 * another request has already made (whose source it then deleted).
 */
async function copyBatch(d: Deps, batch: Copy[], missing: string[]): Promise<void> {
  await runLimited(
    batch.map((c) => () =>
      copyOne(d, c).catch((err: unknown) => {
        if (err instanceof MissingSource) missing.push(c.to);
        throw err;
      }),
    ),
    COPIES_IN_FLIGHT,
  );
}

/**
 * A switch to private that can never finish (a picture's source is really gone): its
 * remaining public sources are retired, due now, so the clean-up deletes them and nothing of
 * the tour stays in the public store. Only while one of `missing` is still to copy (a copy
 * another request made does not count). The tour stays restricted, and unavailable until it
 * is unpublished and published again. One call; true when it retired something.
 */
async function retireSourcesOfStuck(d: Deps, id: string, switchId: string, missing: string[]): Promise<boolean> {
  if (missing.length === 0) return false;
  const r = await d.db.run(
    `UPDATE public_object SET state = 'retired', delete_after = ? WHERE publish_id = ? AND tour_id = ? AND state = 'pending'
       AND EXISTS (SELECT 1 FROM public_object m WHERE m.publish_id = ? AND m.tour_id = ? AND m.state = 'pending' AND m.copied = 0
                     AND m.image_key IN (SELECT value FROM json_each(?)))`,
    [d.now(), sourcesOf(switchId), id, switchId, id, keyList(missing)],
  );
  return r.changes > 0;
}

/**
 * Deletes what one run wrote that no live row names: after a copy or a commit that failed
 * when the switch is gone (unpublish or delete ended it), or a mark that found its rows gone.
 * Keys another request put live meanwhile are kept. Three calls at most.
 */
async function dropUnnamed(d: Deps, id: string, written: string[]): Promise<void> {
  if (written.length === 0) return;
  const live = new Set(
    (await d.db.all<{ image_key: string }>("SELECT image_key FROM snapshot_object WHERE tour_id = ? AND image_key IN (SELECT value FROM json_each(?))", [id, keyList(written)])).map((x) => x.image_key),
  );
  await deleteKeys(
    d,
    written.filter((k) => !live.has(k)),
  );
}

/**
 * Housekeeping's share (src/publish.ts, `housekeeping`), within `allowance` calls, which the
 * caller gives from what it has left (CARRY_CALLS from the tour list and unpublish; nothing
 * from the requests with less room): the workspace's switch its client left, the longest
 * stopped first.
 * - To private, with no progress for `afterMs` (CARRY_AFTER_MS): moved on by as many pictures
 *   as the allowance leaves room for (CARRY_COPIES with CARRY_CALLS), their public pictures
 *   deleted, or committed and cleaned up when those are its last. A run that fails, or meets
 *   a picture whose source is gone, puts the heartbeat on the switch, so the next run waits
 *   CARRY_AFTER_MS again rather than spending calls on every request; what it wrote that no
 *   row names (the switch ended under it) is deleted.
 * - To public, with no progress for STALE_PUBLISH_MS: cancelled, as asking for the setting
 *   the tour still has cancels it; the tour stays restricted and the public copies are
 *   deleted.
 * The calls: the look (1); to public, the cancel (2) and the clean-up (4); to private, the
 * batch (1), 2 per picture, and at most 7 after them (marking 2 and then, when the switch
 * ended meanwhile, a read and 2 deletes; or the commit, the clean-up 4; or after a failure a
 * look, a read and 2 deletes, or a look, the retiring of a stuck switch's sources, their
 * clean-up 4 and the heartbeat). So 9 + 2 per picture. Errors are
 * logged as fixed text and never thrown: a later request tries again.
 */
export async function carryOnSwitch(deps: Deps, workspaceId: string, allowance: number, afterMs = CARRY_AFTER_MS): Promise<void> {
  const copies = Math.min(CARRY_COPIES, Math.floor((allowance - 9) / 2));
  if (allowance < 7) return;
  try {
    const now = deps.now();
    const sw = await deps.db.first<{ switch_id: string; tour_id: string; target: "public" | "private" }>(
      `SELECT w.switch_id, w.tour_id, w.target FROM access_switch w JOIN tour t ON t.id = w.tour_id
        WHERE t.workspace_id = ? AND ((w.target = 'private' AND w.touched_at < ?) OR (w.target = 'public' AND w.touched_at < ?))
        ORDER BY w.touched_at, w.tour_id LIMIT 1`,
      [workspaceId, now - afterMs, now - STALE_PUBLISH_MS],
    );
    if (sw === null) return;
    if (sw.target === "public") {
      if (await cancelToPublic(deps, sw.tour_id, sw.switch_id)) await clearDuePage(deps, workspaceId, sw.tour_id, 0);
      return;
    }
    if (copies < 1) return;
    const backOff = () => deps.db.run("UPDATE access_switch SET touched_at = ? WHERE switch_id = ? AND tour_id = ?", [deps.now(), sw.switch_id, sw.tour_id]);
    const exists = async () => (await deps.db.first("SELECT 1 AS x FROM access_switch WHERE switch_id = ? AND tour_id = ?", [sw.switch_id, sw.tour_id])) !== null;
    const { batch, left } = await nextBatch(deps, sw.tour_id, sw.switch_id, copies);
    const written = batch.map((c) => c.to);
    const missing: string[] = [];
    try {
      await copyBatch(deps, batch, missing);
    } catch {
      console.error("access: housekeeping could not move the pictures of a stopped switch; it waits before it tries again");
      if (await exists()) {
        // A source that is really gone: the switch can never finish, so its remaining public
        // sources go now (one call, then the clean-up's four) rather than wait forever.
        if (await retireSourcesOfStuck(deps, sw.tour_id, sw.switch_id, missing)) await clearDuePage(deps, workspaceId, sw.tour_id, 0);
        await backOff();
      } else await dropUnnamed(deps, sw.tour_id, written);
      return;
    }
    if (batch.length < left) {
      if (await markCopied(deps, sw.tour_id, sw.switch_id, written, false)) await dropSources(deps, sw.tour_id, sw.switch_id, batch);
      else await dropUnnamed(deps, sw.tour_id, written);
      return;
    }
    try {
      await deps.db.batch(commitStatements(workspaceId, sw.tour_id, sw.switch_id, false, written, deps.now(), null));
    } catch {
      console.error("access: housekeeping could not finish a stopped switch; it waits before it tries again");
      if (await exists()) await backOff();
      else await dropUnnamed(deps, sw.tour_id, written);
      return;
    }
    await clearDuePage(deps, workspaceId, sw.tour_id, 0);
  } catch {
    console.error("access: housekeeping could not carry on a stopped switch; a later request tries again");
  }
}

/**
 * Cancels a switch to public: the tour keeps the restricted setting it has. The switch row
 * goes first (from then on its commit cannot take effect), then its new public pictures are
 * retired, due now, for the clean-up. True when this request removed it; false when it was
 * gone already (finished or cancelled by another request).
 */
async function cancelToPublic(d: Deps, id: string, switchId: string): Promise<boolean> {
  const gone = await d.db.run("DELETE FROM access_switch WHERE switch_id = ? AND tour_id = ? AND target = 'public'", [switchId, id]);
  if (gone.changes !== 1) return false;
  // Should this fail, the rows stay pending with no switch, and housekeeping retires them as
  // an abandoned publish's (RETIRE_ABANDONED_SQL); every object stays named by its row.
  await d.db.run("UPDATE public_object SET state = 'retired', delete_after = ? WHERE publish_id = ? AND tour_id = ? AND state = 'pending'", [d.now(), switchId, id]);
  return true;
}

/** PUT, after the body and the id were checked: decide, and act. */
async function putAccess(r: Run, id: string, body: AccessBody): Promise<Response> {
  const { d, auth } = r;
  const ws = auth.workspaceId;
  // A tour that changes under the request (a publish going live, a switch starting) between
  // the read and the batch makes the batch fail and is decided once more from a new read.
  for (let attempt = 0; attempt < 2; attempt++) {
    const st = await readState(d, auth, id);
    if (st === null) return notFound();
    const list = body.viewers ?? st.viewers;
    const listChanged = !sameList(list, st.viewers);
    const now = d.now();

    if (st.switch !== null) {
      const toPublic = st.switch.target === "public";
      // Going public, asking for the setting the tour still has cancels the move.
      const cancel = toPublic && body.access === st.access;
      const same = toPublic ? body.access === "public" : body.access === st.access;
      if (!same && !cancel) return switching();
      if (listChanged) {
        await d.db.batch([...viewerStatements(id, ws, list, now), changeAudit(d, auth, id, st.access, st.access, st.viewers.length, list.length, false)]);
        st.viewers = list;
      }
      if (cancel) {
        if (!(await cancelToPublic(d, id, st.switch.id))) continue; // finished or gone meanwhile: decide again
        await clearTour(d, ws, id);
        return settingAnswer(d, st.access, list, null);
      }
      return drive(r, st, list, st.switch, null);
    }

    // Only making a public tour restricted needs mail; between the two restricted settings
    // nothing is loosened.
    if (viewing.cannotRestrict(d, st.access, body.access)) return cannotRestrictAnswer();
    const cross = isRestricted(body.access) !== isRestricted(st.access);

    if (cross && st.live) {
      const snap = await d.db.first<{ data: string; publish_id: string | null; keys: string }>(
        `SELECT coalesce(s.private_data, s.data) AS data, s.publish_id, (SELECT json_group_array(o.image_key) FROM snapshot_object o WHERE o.tour_id = s.tour_id) AS keys
           FROM snapshot s JOIN tour t ON t.id = s.tour_id WHERE t.id = ? AND t.workspace_id = ?`,
        [id, ws],
      );
      if (snap === null) continue; // unpublished meanwhile
      const toPrivate = isRestricted(body.access);
      const plan = renamed(snap.data, JSON.parse(snap.keys) as string[], toPrivate);
      if (plan === null) {
        console.error("access: a published snapshot could not be renamed for a switch; the tour must be published again");
        return republish();
      }
      const sw = { id: "sw_" + randomHex(12), toPrivate, from: snap.publish_id, data: plan.data, copies: plan.copies };
      try {
        await d.db.batch(startStatements(d, auth, st, body, list, sw, now));
      } catch (err) {
        if (isNotNullViolation(err) || isUniqueViolation(err)) continue;
        throw err;
      }
      const started: State = {
        ...st,
        access: toPrivate ? body.access : st.access,
        viewers: list,
        switch: { id: sw.id, target: toPrivate ? "private" : "public", total: sw.copies.length, copied: 0 },
      };
      return drive(r, started, list, started.switch!, sw.copies);
    }

    // Nothing moves: one batch.
    const stmts: Stmt[] = [];
    if (body.access !== st.access) {
      // Across the stores only while the tour is still unpublished; never during a switch.
      const unpublished = cross ? " AND NOT EXISTS (SELECT 1 FROM snapshot n WHERE n.tour_id = tour.id)" : "";
      stmts.push({
        sql: `UPDATE tour SET access = ? WHERE id = ? AND workspace_id = ? AND access = ? AND NOT EXISTS (SELECT 1 FROM access_switch w WHERE w.tour_id = tour.id)${unpublished}`,
        params: [body.access, id, ws, st.access],
      });
      stmts.push(changeAudit(d, auth, id, st.access, body.access, st.viewers.length, list.length, true));
      if (cross) stmts.push(...cancelPublish(id, ws, now));
      if (isRestricted(body.access)) stmts.push(expediteRetired(id, ws, now));
    } else if (listChanged) {
      stmts.push(changeAudit(d, auth, id, st.access, st.access, st.viewers.length, list.length, false));
    }
    if (listChanged) stmts.push(...viewerStatements(id, ws, list, now));
    if (stmts.length > 0) {
      try {
        await d.db.batch(stmts);
      } catch (err) {
        if (isNotNullViolation(err)) continue;
        throw err;
      }
    }
    // A restricted tour keeps nothing in the public store: anything left there (a cancelled
    // publish's pictures, a clean-up that was cut off) goes before the answer is 200. Other
    // due pictures (the old private ones of a move to public whose last answer was lost) go
    // too, but the state is final already, so the answer is 200 either way.
    const strays = isRestricted(body.access) && (cross || st.stray > 0);
    if (strays || st.due > 0) {
      const clean = await clearTour(d, ws, id);
      if (strays && !clean) return progress(0, Math.max(1, st.stray), "restricted");
    }
    return settingAnswer(d, body.access, list, null);
  }
  return busy();
}

// ---- The setting stated at a tour's first publish ----
//
// A token may state who may view a tour on the call that starts its FIRST publish
// (POST /api/v1/tours/:id/publish, src/publish.ts), and only then: a token never changes the
// setting of a tour that has been published (EVER_PUBLISHED, now or before, including one
// unpublished since), nor one whose setting or list a session has already set. Such a tour is
// unpublished, so changing its setting moves nothing: it is the one-batch change above
// ("Nothing moves"), with the statements putAccess writes for it: the setting, the audit row
// as its guard (marked `at: "creation"`), a publish in progress cancelled, every retired
// picture due now, the list. They do not run on their own: the publish puts them at the head
// of the batch that records its job (startPublish), so the setting and the publish that
// follows from it are written together or not at all, and the job's own condition (the store
// its keys are for must be the one the setting says) is read after the setting changed. So a
// restricted first publish writes only `v/` keys, from its first object on, and is served
// only as a restricted tour, from its commit on.

/** What the first publish does with a stated setting. */
export type FirstPublishPlan =
  /** Refused, and nothing changed. */
  | { kind: "refuse"; res: Response }
  /** The tour already has exactly the stated setting and list: the publish is today's. */
  | { kind: "same" }
  /** The statements that set it, for the head of the publish's first batch, and what the answers then show. */
  | { kind: "apply"; stmts: Stmt[]; access: Access; viewers: number };

const publishedBefore = () =>
  apiError(409, "already_published", "this tour has been published before, so who may view it can be changed in the dashboard only; publish without access and viewers to publish it as it is set");
const alreadySet = () =>
  apiError(409, "access_already_set", "who may view this tour was already set in the dashboard; publish without access and viewers to publish it as it is set, or change it in the dashboard");

/**
 * Decides a setting stated at a tour's first publish, in ONE call (the state, as GET and PUT
 * read it). Null for a tour that is not this workspace's. Refused with 409 already_published
 * for a tour published before; "same" when the tour already has exactly that setting and list
 * (a stated `public` with no addresses on a tour never set is that, so it equals leaving the
 * fields out); refused with 409 access_already_set when its setting or list was set before
 * (anything but `public` with an empty list); refused with cannot_restrict, as the PUT, when a
 * restricted setting needs mail this site cannot send. Otherwise the statements, each guarded:
 * the setting changes only while the tour is still unpublished, never published, `public`, with
 * no list and no switch, and the audit row right after it undoes the batch unless it did.
 * `viewers` left out keeps the list as it is (empty), as the PUT keeps it.
 */
export async function planFirstPublish(deps: Deps, auth: Auth, id: string, body: AccessBody): Promise<FirstPublishPlan | null> {
  if (!TOUR_ID.test(id)) return null;
  const st = await readState(deps, auth, id);
  if (st === null) return null;
  if (st.ever) return { kind: "refuse", res: publishedBefore() };
  const list = body.viewers ?? st.viewers;
  if (body.access === st.access && sameList(list, st.viewers)) return { kind: "same" };
  if (st.access !== "public" || st.viewers.length > 0 || st.switch !== null) return { kind: "refuse", res: alreadySet() };
  if (viewing.cannotRestrict(deps, st.access, body.access)) return { kind: "refuse", res: cannotRestrictAnswer() };
  const ws = auth.workspaceId;
  const now = deps.now();
  const stmts: Stmt[] = [
    {
      sql: `UPDATE tour SET access = ? WHERE id = ? AND workspace_id = ? AND access = 'public' AND status = 'draft' AND published_at IS NULL AND ever_published = 0
              AND NOT EXISTS (SELECT 1 FROM snapshot n WHERE n.tour_id = tour.id) AND NOT EXISTS (SELECT 1 FROM access_switch w WHERE w.tour_id = tour.id)
              AND NOT EXISTS (SELECT 1 FROM tour_viewer v WHERE v.tour_id = tour.id)`,
      params: [body.access, id, ws],
    },
    viewing.changeAudit(deps, auth, "tour_access_changed", id, "public", body.access, 0, list.length, true, true),
    // The publish starts afresh from the draft as it is now, in the store the setting says:
    // whatever publish was in progress (of the public store) can never commit.
    ...cancelPublish(id, ws, now),
    ...(isRestricted(body.access) ? [expediteRetired(id, ws, now)] : []),
    ...(list.length > 0 ? viewerStatements(id, ws, list, now) : []),
  ];
  return { kind: "apply", stmts, access: body.access, viewers: list.length };
}

export function accessRoutes(app: Hono, deps: Deps): void {
  // The setting, for the tour's own workspace. A signed-in session gets the whole list of
  // addresses; a token (the desktop app) gets how many there are, `viewers_count`, in its
  // place and never the addresses, so a token that leaked does not give them away:
  //   session: {access, viewers: [...], limit, can_restrict, switching}
  //   token:   {access, viewers_count, limit, can_restrict, switching}
  // One call after the credential.
  app.get("/api/v1/tours/:id/access", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    const id = c.req.param("id");
    if (!TOUR_ID.test(id)) return notFound();
    const st = await readState(deps, auth, id);
    if (st === null) return notFound();
    if (auth.session === undefined) {
      const sw = st.switch;
      return json(200, { access: st.access, viewers_count: st.viewers.length, limit: MAX_VIEWERS, can_restrict: canMailLinks(deps), switching: switchingOf(sw) });
    }
    return settingAnswer(deps, st.access, st.viewers, st.switch);
  });

  // Change the setting, and the whole list when `viewers` is given: a signed-in session
  // only, with the anti-forgery header; a token gets the one 401, so a stolen desktop token
  // cannot make a restricted tour public. Answers 200 with the state as GET gives it once
  // done, or 202 {status: "switching", done, total} while the live pictures move: send the
  // same request again until 200.
  app.put("/api/v1/tours/:id/access", async (c) => {
    const meter = metered(deps);
    const d = meter.deps;
    const auth = await requireAuth(c.req.raw, d, { only: "session" });
    if (auth instanceof Response) return auth;
    const body = await readAccessBody(c.req.raw, "a tour's");
    if (body instanceof Response) return body;
    const id = c.req.param("id");
    if (!TOUR_ID.test(id)) return notFound();
    return putAccess({ d, calls: meter.calls, auth }, id, body);
  });
}
