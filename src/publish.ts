// Publish, unpublish and the public image route.
//
// Drafts are private and publishing makes a copy: publish copies the tour's current
// chapters, steps, layer, cards and settings into one snapshot row, and every image (and
// the cover logo) into the public store under a new random name. The player reads only
// the snapshot, so nothing done to the draft afterwards reaches it until the next publish.
//
// Publishing runs in bounded steps, so that no request makes more than SUBREQUEST_BUDGET
// database and storage calls however large the tour (see src/budget.ts). The client calls
// the publish route again and again:
// - The first call reads the draft in ONE statement (a consistent read), builds the
//   snapshot, and records a job (migration 0004) holding the snapshot text together with
//   one 'pending' public_object row per image, before writing any image. It then copies
//   the first COPY_BATCH images.
// - Each later call copies the next COPY_BATCH images and marks them copied. Until the
//   end it answers 202 with how many images are done out of how many.
// - The call that copies the last images commits in one batch, exactly as a one-request
//   publish did: the snapshot switches only then, so viewers see the previous version
//   until that moment. It answers 200 with { slug, url, steps }.
// A publish continues against the draft version it started from: the snapshot was built
// from one consistent read at the start, and draft objects never change once written
// (each upload writes its own keys and nothing rewrites them), so the remaining copies are
// exactly that version's images. Calls naming the publish keep driving it, so a tour
// that is being added to still finishes. A fresh start (no publish_id) that finds a
// running publish of an older draft (tour.draft_version, bumped by every upload commit,
// against the version the job recorded) stops it and starts from the current draft, so a
// client whose first answer was lost never puts an older version live by accident.
//
// Every public object is named by exactly one row at every moment (see migration 0003):
// - A publish records each key as 'pending' BEFORE writing it. Every call that makes
//   progress refreshes the job's heartbeat (publish_job.touched_at) and marks only the
//   rows it copied, so a publish counts as abandoned only after STALE_PUBLISH_MS without
//   progress; the workspace's next publish, unpublish, tour list or upload create then
//   retires its rows and drops its job, and a fresh start of the same tour begins a new one. The commit moves the pending keys into
//   snapshot_object and the previous snapshot's keys into public_object as 'retired', and
//   only takes effect while the job exists and every one of its rows is still pending, so
//   a sweep, an unpublish or a failure that ended the publish can never race it into
//   going live with missing images.
// - A retired key stays served for a grace period (config.retiredGraceMs), so a viewer
//   still on the previous page (cached for a minute) keeps its images; once that has
//   passed, a later request deletes it from the store, then its row.
// - Unpublish cancels a publish in progress (retires its rows, drops its job) and moves
//   the snapshot's keys to 'retired' in one batch with deleting the snapshot, with no grace,
//   then deletes the due keys a page at a time.
// - A publish that fails or finds itself cancelled retires its own pending rows, drops its
//   job, and deletes every key it recorded plus the keys this call wrote (so even a key
//   written after its rows were swept is caught). It deletes nothing another publish made.
// - Every publish and unpublish also sweeps a few other tours of its workspace, most
//   overdue first, so a replaced or abandoned image never stays public for want of
//   another request on its own tour.
// Keys are random and never reused, so a retired key past its grace can be deleted by any
// request at any time. Nothing is ever found by listing the store.
//
// Who may view a tour (src/access.ts, migration 0014) decides where its live pictures go.
// A public tour's are in the public store under `p/<32 hex>.<ext>`; a restricted tour's
// (setting 'people' or 'me') are in the PRIVATE store under `v/<32 hex>.<ext>`, so a public
// bucket domain can never serve them. The first letters of a key tell its store, here and
// in every clean-up (storeOfKey). A publish takes the store from the tour's setting when it
// starts; its job is recorded only while the setting still says that store and no move of
// the live pictures between the stores (an access switch) is in progress, and its commit
// takes effect only while every one of its keys is still of the store the setting says.
// A change of setting across the two stores cancels a publish in progress (src/access.ts),
// as unpublish does. While a switch is in progress a publish is refused (409
// access_switching); unpublish cancels the switch. The public page and the picture route
// serve a tour only while its setting is 'public'.
import { billingConfigured } from "./billing-rules.ts";
import type { Hono } from "hono";
import { readOnlyRefusal } from "./billing.ts";
import { CARRY_CALLS, RESTRICTED_STUB, alreadySet, carryOnSwitch, planFirstPublish, type FirstPublishPlan } from "./access.ts";
import { beforeAccountsToo, noDisabledAccount } from "./accounts.ts";
import { linksUpSql } from "./removal-rules.ts";
import { requireAuth, type Auth } from "./auth.ts";
import { metered, SUBREQUEST_BUDGET } from "./budget.ts";
import { apiError, json, noContent, readCapped } from "./http.ts";
import { legacySettings, safeUrl, type Autoplay, type Box, type Card, type Cover, type EndCard, type Link, type Note, type Theme, type Zoom } from "./manifest.ts";
import { isNotNullViolation, isUniqueViolation, type Deps, type FileStore, type Stmt } from "./ports.ts";
import { ACCESS_BODY_BYTES, creationAccess, hasAccessFields, isRestricted, type AccessBody } from "./viewing.ts";

export type SnapshotStep = {
  id: string;
  image: string;
  width: number;
  height: number;
  click: { x: number; y: number; size: number } | null;
  caption: string | null;
  spotlight: Box | null;
  notes: Note[];
  card: Card | null;
  advance: "hotspot" | "anywhere";
  zoom: boolean | null;
};
/**
 * `id` is the snapshot's own chapter id (`c_` and 24 hex characters), derived one way from
 * the draft chapter so it is stable across publishes but reveals nothing about the draft.
 */
export type SnapshotChapter = { id: string; title: string; description: string | null; steps: SnapshotStep[] };
/**
 * `cover.logo` is the published logo's key (`p/<32 hex>.<ext>`) or null. Every link has
 * passed `safeUrl` again at publish time. The snapshot holds no image base: whoever
 * renders it passes the currently configured one alongside, so changing it later still
 * applies to every published tour. Step ids are the only draft ids it carries.
 */
export type Snapshot = {
  title: string;
  spotlight_dim: number | null;
  theme: Theme;
  zoom: Zoom;
  cover: (Omit<Cover, "logo"> & { logo: string | null }) | null;
  cta: Link | null;
  end: EndCard | null;
  autoplay: Autoplay;
  chapters: SnapshotChapter[];
};

/** Published names are never reused, so a published file never changes. */
export const PUBLIC_CACHE = "public, max-age=31536000, immutable";
/** Stored with a restricted tour's live pictures in the private store; the route that serves them sets its own headers. */
export const PRIVATE_CACHE = "private, no-store";
/** How long a key a re-publish replaced keeps being served, when the config sets nothing else. */
export const DEFAULT_RETIRED_GRACE_MS = 10 * 60 * 1000;
/** A publish that has made no progress for this long is taken to be abandoned and is swept by a later request in the workspace. */
export const STALE_PUBLISH_MS = 15 * 60 * 1000;
/**
 * The most steps one tour publishes. Publishing is no longer one request, so this is not
 * a subrequest limit any more: it bounds the first call's draft read and snapshot build
 * (see MAX_SNAPSHOT_BYTES) and the number of calls a publish takes (34 at 400 steps).
 */
export const MAX_PUBLISH_STEPS = 400;
/**
 * The largest snapshot text. D1 stores up to 2,000,000 bytes in one value, but CPU sets
 * the cap: the first call reads the draft rows, builds the snapshot and serialises it
 * once, which costs about 2 ms of pure CPU per 100,000 bytes of notes in V8 (see the
 * README), so 512,000 bytes keeps that call within reach of the free plan's 10 ms. Later
 * calls never read the text; the commit copies it inside the database. A single upload's
 * manifest is at most 262,144 bytes, so this allows about two full-size uploads' worth of
 * text per tour.
 */
export const MAX_SNAPSHOT_BYTES = 512_000;
/**
 * The calls a publish request may still need after its copies, in the worst case: the
 * commit batch, then either the cleanup of this tour's due keys (3), or after a failed
 * commit a status read (1) and stopping the publish (4: one batch, a read, a store delete,
 * a row delete). A call that does not finish needs at most 6 too: marking its images and
 * the job's heartbeat (2), then stopping the publish if it was ended meanwhile (4).
 */
const CALLS_AFTER_COPIES = 6;
/**
 * The most images one request copies; each is one read from the drafts store and one
 * write to the public store. A request copies fewer when what it has already spent
 * (authentication, housekeeping, a start, a join, stopping a publish of an older draft)
 * leaves less room: it counts its own calls and sizes the batch from what is left, so
 * it never passes SUBREQUEST_BUDGET. A plain middle call (2 authentication, 4
 * housekeeping, 1 state, 1 next images) copies the full 12.
 */
export const COPY_BATCH = 12;
/** Copies in flight at once, inside the six connections a Worker may hold open. */
const COPIES_IN_FLIGHT = 4;
/** Due keys deleted per page: one store delete call takes at most 1,000 keys. */
const DUE_PAGE = 1000;
/** Pages of due keys per request: publish does one; unpublish, which retires a whole snapshot at once, two. */
const PUBLISH_PAGES = 1;
const UNPUBLISH_PAGES = 2;
/** Other tours of the workspace one request sweeps, most overdue first. */
export const SWEEP_TOURS = 2;

const TOUR_ID = /^tour_[0-9a-f]{24}$/;
const PUBLISH_ID = /^pub_[0-9a-f]{24}$/;
const PUBLIC_NAME = /^[0-9a-f]{32}\.(png|jpg)$/;
/** The publish route's optional body: {"publish_id": "..."}. */
const PUBLISH_BODY_BYTES = 1024;

export type ImageType = "png" | "jpg";
export const mime = (t: ImageType) => (t === "png" ? "image/png" : "image/jpeg");
export const typeOfKey = (key: string): ImageType => (key.endsWith(".png") ? "png" : "jpg");

export function randomHex(bytes: number): string {
  let s = "";
  for (const b of crypto.getRandomValues(new Uint8Array(bytes))) s += b.toString(16).padStart(2, "0");
  return s;
}

/** A new public key: 128 random bits, so it cannot be guessed and is never reused. */
function publicKey(type: ImageType): string {
  return `p/${randomHex(16)}.${type}`;
}

/** A new live key for a picture of a public tour (public store, `p/`) or of a restricted one (private store, `v/`), equally random. */
export function liveKey(type: ImageType, restricted: boolean): string {
  return restricted ? `v/${randomHex(16)}.${type}` : publicKey(type);
}

/**
 * The store a key lives in: `p/` keys in the public store, every other key (draft `u/`,
 * restricted live `v/`, shared items' `m/`) in the private one.
 */
export function storeOfKey(deps: Deps, key: string): FileStore {
  return key.startsWith("p/") ? deps.pub : deps.drafts;
}

/** Deletes keys of either store: one delete call for each store that has any of them. */
export async function deleteKeys(deps: Deps, keys: string[]): Promise<void> {
  const pub = keys.filter((k) => k.startsWith("p/"));
  const priv = keys.filter((k) => !k.startsWith("p/"));
  if (pub.length > 0) await deps.pub.delete(pub);
  if (priv.length > 0) await deps.drafts.delete(priv);
}

const notFound = () => apiError(404, "not_found", "no such tour");

type DraftRow = {
  title: string;
  slug: string;
  draft_version: number;
  spotlight_dim: number | null;
  theme: string | null;
  t_zoom: string | null;
  cover: string | null;
  cta: string | null;
  end_card: string | null;
  autoplay: string | null;
  logo_key: string | null;
  logo_type: ImageType | null;
  c_id: string;
  c_title: string;
  c_description: string | null;
  s_id: string;
  image_key: string;
  image_type: ImageType;
  width: number;
  height: number;
  click_x: number | null;
  click_y: number | null;
  click_size: number;
  caption: string | null;
  spotlight: string | null;
  notes: string;
  card: string | null;
  advance: "hotspot" | "anywhere";
  s_zoom: number | null;
};

/**
 * The whole draft in ONE statement, so it is a consistent read: an upload's commit that
 * lands at the same moment is either wholly in it or wholly out of it.
 */
const DRAFT_SQL = `
  SELECT t.title, t.slug, t.draft_version, t.spotlight_dim, t.theme, t.zoom AS t_zoom, t.cover, t.cta, t.end_card, t.autoplay, t.logo_key, t.logo_type,
         c.id AS c_id, c.title AS c_title, c.description AS c_description,
         s.id AS s_id, s.image_key, s.image_type, s.width, s.height, s.click_x, s.click_y, s.click_size, s.caption,
         s.spotlight, s.notes, s.card, s.advance, s.zoom AS s_zoom
    FROM tour t
    JOIN chapter c ON c.tour_id = t.id
    JOIN step s ON s.chapter_id = c.id AND s.tour_id = t.id
   WHERE t.id = ? AND t.workspace_id = ?
   ORDER BY c.position, c.id, s.position, s.id
   LIMIT ?`;

function parse<T>(text: string | null): T | null {
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** A stored button with its link checked again; null when the link fails. */
function cleanLink(v: unknown): Link | null {
  if (v === null || typeof v !== "object") return null;
  const l = v as Record<string, unknown>;
  const url = safeUrl(l.url);
  if (url === null || typeof l.label !== "string") return null;
  return { label: l.label, url };
}

export type Copy = { from: string; to: string };

/** The snapshot's id for a draft chapter: one-way, so it says nothing about the upload behind the chapter. */
async function publicChapterId(chapterId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("demo-platform snapshot chapter:" + chapterId)));
  let s = "";
  for (const b of digest.subarray(0, 12)) s += b.toString(16).padStart(2, "0");
  return "c_" + s;
}

/**
 * Builds the snapshot and the copies it needs, choosing a fresh live key for each image:
 * a public one, or for a restricted tour (`restricted`) a private one.
 */
export function buildSnapshot(rows: DraftRow[], chapterIds: Map<string, string>, restricted = false): { snapshot: Snapshot; copies: Copy[] } {
  const t = rows[0];
  const legacy = legacySettings();
  const copies: Copy[] = [];
  const chapters: SnapshotChapter[] = [];
  let current: string | null = null;
  for (const r of rows) {
    let ch = chapters[chapters.length - 1];
    if (ch === undefined || current !== r.c_id) {
      current = r.c_id;
      ch = { id: chapterIds.get(r.c_id) as string, title: r.c_title, description: r.c_description, steps: [] };
      chapters.push(ch);
    }
    const image = liveKey(r.image_type, restricted);
    copies.push({ from: r.image_key, to: image });
    ch.steps.push({
      id: r.s_id,
      image,
      width: r.width,
      height: r.height,
      click: r.click_x === null || r.click_y === null ? null : { x: r.click_x, y: r.click_y, size: r.click_size },
      caption: r.caption,
      spotlight: parse<Box>(r.spotlight),
      notes: parse<Note[]>(r.notes) ?? [],
      card: parse<Card>(r.card),
      advance: r.advance === "anywhere" ? "anywhere" : "hotspot",
      zoom: r.s_zoom === null ? null : r.s_zoom === 1,
    });
  }

  const storedCover = parse<Cover>(t.cover);
  let cover: Snapshot["cover"] = null;
  if (storedCover !== null) {
    let logo: string | null = null;
    if (storedCover.logo && t.logo_key !== null && t.logo_type !== null) {
      logo = liveKey(t.logo_type, restricted);
      copies.push({ from: t.logo_key, to: logo });
    }
    cover = { title: storedCover.title, body: storedCover.body, button: storedCover.button, logo };
  }
  const storedEnd = parse<EndCard>(t.end_card);
  const end: EndCard | null =
    storedEnd === null ? null : { text: storedEnd.text, primary: cleanLink(storedEnd.primary), secondary: cleanLink(storedEnd.secondary), replay: storedEnd.replay };

  const snapshot: Snapshot = {
    title: t.title,
    spotlight_dim: t.spotlight_dim,
    theme: parse<Theme>(t.theme) ?? legacy.theme,
    zoom: parse<Zoom>(t.t_zoom) ?? legacy.zoom,
    cover,
    cta: cleanLink(parse(t.cta)),
    end,
    autoplay: parse<Autoplay>(t.autoplay) ?? legacy.autoplay,
    chapters,
  };
  return { snapshot, copies };
}

/** UTF-8 length of a string without encoding it. */
function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** Runs `jobs` with at most `limit` in flight. Stops starting new ones after a failure, waits for those running, then throws. */
export async function runLimited(jobs: (() => Promise<void>)[], limit: number): Promise<void> {
  let next = 0;
  let failure: { err: unknown } | null = null;
  const worker = async () => {
    while (failure === null && next < jobs.length) {
      const job = jobs[next++];
      try {
        await job();
      } catch (err) {
        failure ??= { err };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  if (failure !== null) throw (failure as { err: unknown }).err;
}

/**
 * Copies one picture: read from the store its source key is in and written to the store
 * its target key is in (storeOfKey). A publish copies from draft keys; an access switch
 * from a live key to its new name in the other store (src/access.ts).
 */
/** A copy whose source object is not in its store (it carries no key, so it is safe to log). */
export class MissingSource extends Error {
  constructor() {
    super("a source image is missing");
  }
}

export async function copyOne(deps: Deps, c: Copy): Promise<void> {
  const file = await storeOfKey(deps, c.from).get(c.from);
  if (file === null) throw new MissingSource();
  const bytes = new Uint8Array(await new Response(file.body).arrayBuffer());
  const cacheControl = c.to.startsWith("p/") ? PUBLIC_CACHE : PRIVATE_CACHE;
  await storeOfKey(deps, c.to).put(c.to, bytes, { contentType: mime(typeOfKey(c.to)), cacheControl });
}

export const keyList = (keys: string[]) => JSON.stringify(keys);

const graceOf = (deps: Deps) => deps.config.retiredGraceMs ?? DEFAULT_RETIRED_GRACE_MS;

const WORKSPACE_TOURS = "SELECT id FROM tour WHERE workspace_id = ?";

/**
 * One page of retired keys past their grace: this tour's first (when `tourId` is given),
 * then those of up to `otherTours` other tours of the workspace, most overdue first.
 * Deletes the objects in one store call, then their rows. Returns whether more of this
 * tour's keys are due. Every key it touches belongs to a tour of the workspace, whatever
 * `tourId` names. They are referenced by nothing live and no longer served, so this is
 * safe at any time and from any number of requests at once.
 */
export async function clearDuePage(deps: Deps, workspaceId: string, tourId: string | null, otherTours: number): Promise<{ any: boolean; more: boolean }> {
  const now = deps.now();
  const own = tourId ?? "";
  const rows = await deps.db.all<{ image_key: string; tour_id: string }>(
    `SELECT o.image_key, o.tour_id FROM public_object o
      WHERE o.state = 'retired' AND o.delete_after <= ? AND o.tour_id IN (${WORKSPACE_TOURS})
        AND (o.tour_id = ? OR o.tour_id IN (
              SELECT p.tour_id FROM public_object p
               WHERE p.state = 'retired' AND p.delete_after <= ? AND p.tour_id <> ? AND p.tour_id IN (${WORKSPACE_TOURS})
               GROUP BY p.tour_id ORDER BY min(p.delete_after), p.tour_id LIMIT ?))
      ORDER BY o.tour_id <> ?, o.delete_after, o.image_key
      LIMIT ?`,
    [now, workspaceId, own, now, own, workspaceId, otherTours, own, DUE_PAGE + 1],
  );
  if (rows.length === 0) return { any: false, more: false };
  const page = rows.slice(0, DUE_PAGE);
  const keys = page.map((r) => r.image_key);
  // A restricted tour's keys are in the private store: each key is deleted from its own.
  await deleteKeys(deps, keys);
  await deps.db.run(
    `DELETE FROM public_object WHERE state = 'retired' AND delete_after <= ? AND image_key IN (SELECT value FROM json_each(?)) AND tour_id IN (${WORKSPACE_TOURS})`,
    [now, keyList(keys), workspaceId],
  );
  return { any: true, more: tourId !== null && rows.length > DUE_PAGE && rows[DUE_PAGE].tour_id === tourId };
}

/**
 * Retires the pending rows of a workspace's abandoned publishes. Parameters: now, the
 * workspace, the stale moment twice. Reached through the workspace's tours and the
 * public_object_tour_pending index, so it never scans other workspaces' rows. The pending
 * rows of an access switch (src/access.ts), its new pictures and, going private, its sources
 * (publish_id 'sws_' and the switch's hex), belong to no publish and are never taken for an
 * abandoned one: a switch stays until it is finished, or cancelled by unpublish or delete.
 */
export const RETIRE_ABANDONED_SQL = `UPDATE public_object SET state = 'retired', delete_after = ?
   WHERE tour_id IN (${WORKSPACE_TOURS}) AND state = 'pending' AND created_at < ?
     AND NOT EXISTS (SELECT 1 FROM publish_job j WHERE j.publish_id = public_object.publish_id AND j.touched_at >= ?)
     AND NOT EXISTS (SELECT 1 FROM access_switch w WHERE public_object.publish_id IN (w.switch_id, 'sws_' || substr(w.switch_id, 4)))`;
/** Drops a workspace's jobs that are stale or have no pending rows left. Parameters: the workspace, the stale moment. */
export const DROP_ABANDONED_JOBS_SQL = `DELETE FROM publish_job WHERE tour_id IN (${WORKSPACE_TOURS})
    AND (touched_at < ? OR NOT EXISTS (SELECT 1 FROM public_object o WHERE o.publish_id = publish_job.publish_id AND o.state = 'pending'))`;

/**
 * Housekeeping, in at most 1 + 3 x `pages` calls, scoped to one workspace: retires the
 * pending rows of every publish of the workspace that has made no progress for
 * STALE_PUBLISH_MS (its job's heartbeat is older, or it has no job) and drops those jobs
 * (one batch), then deletes due keys a page at a time, this tour's first (if `tourId` is
 * given) and a few other tours' after. It runs on every publish and unpublish, and with
 * one page on listing tours and creating an upload, so an abandoned publish is cleared
 * by the workspace's next ordinary request. Errors are logged as fixed text and never
 * thrown. Answers "failed" if anything failed, "more" if this tour still has due keys,
 * else "clean".
 */
export async function housekeeping(deps: Deps, workspaceId: string, tourId: string | null, pages: number, carry = 0): Promise<"clean" | "more" | "failed"> {
  try {
    const now = deps.now();
    const stale = now - STALE_PUBLISH_MS;
    await deps.db.batch([
      { sql: RETIRE_ABANDONED_SQL, params: [now, workspaceId, stale, stale] },
      { sql: DROP_ABANDONED_JOBS_SQL, params: [workspaceId, stale] },
      // 0.1.61 (second review N1): checkout records are no longer cleared here by age. A record
      // past its expiry may be of a checkout that was paid and never linked; only the billing
      // sweep clears one, once Stripe has confirmed that checkout expired (src/billing-sweep.ts).
    ]);
    let result: "clean" | "more" = "more";
    for (let page = 0; page < pages; page++) {
      const r = await clearDuePage(deps, workspaceId, tourId, SWEEP_TOURS);
      if (!r.more) {
        result = "clean";
        break;
      }
    }
    // A switch its client left is carried on (to restricted: a few pictures moved) or ended
    // (to public: cancelled), within the calls the caller can give, `carry` (src/access.ts,
    // carryOnSwitch; it never throws). Only callers with that much room give any: the tour
    // list and unpublish give CARRY_CALLS; an upload's create, publish and a delete give none.
    if (carry > 0) await carryOnSwitch(deps, workspaceId, carry);
    return result;
  } catch {
    console.error("publish: could not remove old public images; will retry later");
    return "failed";
  }
}

/**
 * Ends a publish that will not commit: retires its pending rows and drops its job in one
 * batch (after which it can never commit), then, unless it turns out to have committed
 * after all (a second call of the same publish finished it), deletes every key it recorded
 * and every key in `written`, then those rows. Four calls. If anything fails the rows
 * stay retired and due, and a later request finishes the job.
 */
async function stopPublish(deps: Deps, tourId: string, publishId: string, written: string[]): Promise<"live" | "stopped"> {
  try {
    const now = deps.now();
    await deps.db.batch([
      { sql: "UPDATE public_object SET state = 'retired', delete_after = ? WHERE publish_id = ? AND state = 'pending' AND tour_id = ?", params: [now, publishId, tourId] },
      { sql: "DELETE FROM publish_job WHERE publish_id = ? AND tour_id = ?", params: [publishId, tourId] },
    ]);
    const row = await deps.db.first<{ live: string | null; keys: string }>(
      `SELECT (SELECT publish_id FROM snapshot WHERE tour_id = ?) AS live,
              (SELECT json_group_array(image_key) FROM public_object WHERE publish_id = ? AND tour_id = ? AND state = 'retired' AND source_key IS NOT NULL) AS keys`,
      [tourId, publishId, tourId],
    );
    if (row?.live === publishId) return "live";
    const recorded = parse<string[]>(row?.keys ?? "[]") ?? [];
    const keys = [...new Set([...recorded, ...written])];
    await deleteKeys(deps, keys);
    if (recorded.length > 0) {
      await deps.db.run(
        "DELETE FROM public_object WHERE publish_id = ? AND tour_id = ? AND state = 'retired' AND source_key IS NOT NULL AND image_key IN (SELECT value FROM json_each(?))",
        [publishId, tourId, keyList(recorded)],
      );
    }
  } catch {
    console.error(`publish: could not remove the images of a stopped publish of ${tourId}; will retry later`);
  }
  return "stopped";
}

/**
 * The commit, one batch. The snapshot insert fails (NOT NULL on data) unless the job still
 * exists, every one of its rows is still pending and copied (or copied by this call), the
 * tour is still this workspace's, no access switch of it is in progress, and every key of
 * the job is of the store the tour's setting says (`p/` for a public tour, else not), so a
 * change of setting since the job started never puts pictures live in the wrong store.
 * Otherwise the whole batch rolls back.
 */
function commitStatements(auth: Auth, tourId: string, publishId: string, justCopied: string[], now: number, graceMs: number): Stmt[] {
  return [
    {
      // draft_version is the draft the job's snapshot was built from, so a later replace of a
      // chapter can tell whether the draft holds other changes that were never published.
      // A restricted tour's text goes to private_data, and data holds the stub, which no build
      // serves (src/access.ts, RESTRICTED_STUB); a public tour's goes to data, as always.
      sql: `INSERT INTO snapshot (tour_id, data, private_data, published_at, publish_id, steps, draft_version)
            SELECT ?, CASE WHEN g.x IS NULL THEN NULL WHEN g.pub = 1 THEN g.x ELSE ? END, CASE WHEN g.pub = 1 THEN NULL ELSE g.x END, ?, ?,
                   (SELECT steps FROM publish_job WHERE publish_id = ?), (SELECT draft_version FROM publish_job WHERE publish_id = ?)
              FROM (SELECT (SELECT j.data FROM publish_job j
                         WHERE j.publish_id = ? AND j.tour_id = ?
                           AND (SELECT count(*) FROM public_object o
                                 WHERE o.publish_id = ? AND o.state = 'pending' AND o.tour_id = ?
                                   AND (o.copied = 1 OR o.image_key IN (SELECT value FROM json_each(?)))) = j.total
                           AND EXISTS (SELECT 1 FROM tour WHERE id = ? AND workspace_id = ?)
                           AND NOT EXISTS (SELECT 1 FROM access_switch w WHERE w.tour_id = j.tour_id)
                           AND NOT EXISTS (SELECT 1 FROM public_object o JOIN tour t ON t.id = o.tour_id
                                            WHERE o.publish_id = j.publish_id AND o.state = 'pending'
                                              AND (substr(o.image_key, 1, 2) = 'p/') <> (t.access = 'public'))) AS x,
                           (SELECT access = 'public' FROM tour WHERE id = ?) AS pub) g
             WHERE true
            ON CONFLICT (tour_id) DO UPDATE SET data = excluded.data, private_data = excluded.private_data, published_at = excluded.published_at, publish_id = excluded.publish_id,
                                                steps = excluded.steps, draft_version = excluded.draft_version`,
      params: [tourId, RESTRICTED_STUB, now, publishId, publishId, publishId, publishId, tourId, publishId, tourId, keyList(justCopied), tourId, auth.workspaceId, tourId],
    },
    {
      sql: "INSERT INTO public_object (image_key, tour_id, publish_id, state, created_at, delete_after) SELECT image_key, tour_id, ?, 'retired', ?, ? FROM snapshot_object WHERE tour_id = ?",
      params: [publishId, now, now + graceMs, tourId],
    },
    { sql: "DELETE FROM snapshot_object WHERE tour_id = ?", params: [tourId] },
    {
      sql: "INSERT INTO snapshot_object (tour_id, image_key) SELECT tour_id, image_key FROM public_object WHERE publish_id = ? AND state = 'pending' AND tour_id = ?",
      params: [publishId, tourId],
    },
    { sql: "DELETE FROM public_object WHERE publish_id = ? AND state = 'pending'", params: [publishId] },
    { sql: "DELETE FROM publish_job WHERE publish_id = ?", params: [publishId] },
    { sql: "UPDATE tour SET status = 'published', published_at = ? WHERE id = ? AND workspace_id = ?", params: [now, tourId, auth.workspaceId] },
  ];
}

type TourState = {
  id: string;
  slug: string;
  access: "public" | "people" | "me";
  /** How many addresses the tour's list holds. */
  viewers: number;
  /** 1 while an access switch of the tour is in progress. */
  switching: number;
  draft_version: number;
  job_id: string | null;
  job_total: number | null;
  job_steps: number | null;
  job_version: number | null;
  live_id: string | null;
  live_steps: number | null;
};

const TOUR_STATE_SQL = `
  SELECT t.id, t.slug, t.access, (SELECT count(*) FROM tour_viewer v WHERE v.tour_id = t.id) AS viewers,
         EXISTS (SELECT 1 FROM access_switch w WHERE w.tour_id = t.id) AS switching,
         t.draft_version, j.publish_id AS job_id, j.total AS job_total, j.steps AS job_steps, j.draft_version AS job_version,
         s.publish_id AS live_id, s.steps AS live_steps
    FROM tour t LEFT JOIN publish_job j ON j.tour_id = t.id LEFT JOIN snapshot s ON s.tour_id = t.id
   WHERE t.id = ? AND t.workspace_id = ?`;

async function tourState(deps: Deps, auth: Auth, id: string): Promise<TourState | null> {
  return deps.db.first<TourState>(TOUR_STATE_SQL, [id, auth.workspaceId]);
}

const publishFailed = () => apiError(500, "publish_failed", "the tour could not be published; what was published before is unchanged");
const publishStopped = () =>
  apiError(409, "publish_cancelled", "this publish was stopped before it finished (the tour was unpublished, or the publish failed or was abandoned); publish again to start over");
const publishBusy = () => apiError(409, "publish_busy", "another publish of this tour is starting at this moment; try again");
const draftMoved = () => apiError(409, "publish_busy", "the tour's draft changed while this publish was starting; try again");
const accessSwitching = () =>
  apiError(409, "access_switching", "who may view this tour is being changed; send that change again until it is done, then publish");
/** Added to both answers: the tour's setting, and how many addresses its list holds. */
type Shown = { access: TourState["access"]; viewers: number };
const shown = (t: TourState): Shown => ({ access: t.access, viewers: t.viewers });
const done = (slug: string, steps: number, s: Shown) => json(200, { slug, url: `/t/${slug}`, steps, access: s.access, viewers: s.viewers });
const inProgress = (publishId: string, doneCount: number, total: number, s: Shown) =>
  json(202, { status: "in_progress", publish_id: publishId, done: doneCount, total, access: s.access, viewers: s.viewers });

/**
 * The publish route's body: nothing, or {"publish_id": "pub_..."} to continue that publish,
 * or, on the call that starts a tour's first publish only, {"access": ..., "viewers": [...]}
 * (src/access.ts, planFirstPublish). `access` is null when the body states no setting. A body
 * that states one may be longer than PUBLISH_BODY_BYTES by up to ACCESS_BODY_BYTES (a full
 * list of addresses); every other body is held to PUBLISH_BODY_BYTES exactly as before.
 */
async function readPublishBody(req: Request): Promise<{ publishId: string | null; access: AccessBody | null } | Response> {
  const bad = () => apiError(400, "bad_request", 'the body must be empty or {"publish_id": "<id from the previous answer>"}');
  const overCap = () => apiError(413, "too_large", `the request is over ${PUBLISH_BODY_BYTES} bytes`);
  const raw = await readCapped(req, PUBLISH_BODY_BYTES + ACCESS_BODY_BYTES);
  if (raw === "too_large") return overCap();
  if (raw.byteLength === 0) return { publishId: null, access: null };
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw));
  } catch {
    return raw.byteLength > PUBLISH_BODY_BYTES ? overCap() : bad();
  }
  if (raw.byteLength > PUBLISH_BODY_BYTES && !hasAccessFields(body)) return overCap();
  if (body === null || typeof body !== "object" || Array.isArray(body)) return bad();
  const o = body as Record<string, unknown>;
  const id = o.publish_id;
  let publishId: string | null = null;
  if (id !== undefined && id !== null) {
    if (typeof id !== "string" || !PUBLISH_ID.test(id)) return bad();
    publishId = id;
  }
  const access = creationAccess(o, "a tour's");
  if (access instanceof Response) return access;
  if (access !== null && publishId !== null) {
    return apiError(400, "bad_request", "access and viewers go on the call that starts a tour's first publish only, never with publish_id");
  }
  return { publishId, access };
}

type Started = { kind: "started"; publishId: string; total: number; steps: number; copies: Copy[] } | { kind: "joined" } | { kind: "changed" } | { kind: "answer"; res: Response };

/**
 * Reads the draft once, builds the snapshot and records the job (with the draft version
 * it was built from, read in the same statement) and every key it will write, in one
 * batch, before writing any. When another start of the same tour won the race, answers
 * "joined" so the caller continues that publish instead. The job is recorded only while
 * the tour still exists at the draft version that was read: when the tour was deleted or
 * its draft changed in between (an upload's commit, or a replace of a chapter, which also
 * removes the pictures it took out), nothing is recorded or written and the answer is
 * "changed", so no publish ever starts on pictures that may be gone. The caller then
 * starts once more from the draft as it is now. Two calls: the read and the batch. `head`
 * is put at the start of the batch: the statements of a setting stated at a first publish,
 * which take effect only together with the job (a guard among them that fails answers
 * "changed" too). `exactly`, for a publish whose request stated a setting, records the job only
 * while the tour's setting is exactly that one (not only of the same store), so a change in the
 * dashboard after the decision answers "changed", and the caller decides again from the tour
 * as it is then (src/publish.ts refuses a stated setting the tour no longer has).
 */
async function startPublish(deps: Deps, auth: Auth, tourId: string, restricted: boolean, head: Stmt[] = [], exactly: AccessBody["access"] | null = null): Promise<Started> {
  const rows = await deps.db.all<DraftRow>(DRAFT_SQL, [tourId, auth.workspaceId, MAX_PUBLISH_STEPS + 1]);
  if (rows.length === 0) return { kind: "answer", res: apiError(400, "empty_tour", "a tour with no steps cannot be published") };
  if (rows.length > MAX_PUBLISH_STEPS) return { kind: "answer", res: apiError(413, "too_large", `a tour of more than ${MAX_PUBLISH_STEPS} steps cannot be published`) };
  const chapterIds = new Map<string, string>();
  for (const r of rows) if (!chapterIds.has(r.c_id)) chapterIds.set(r.c_id, await publicChapterId(r.c_id));
  const { snapshot, copies } = buildSnapshot(rows, chapterIds, restricted);
  const data = JSON.stringify(snapshot);
  if (utf8Length(data) > MAX_SNAPSHOT_BYTES) return { kind: "answer", res: apiError(413, "too_large", "the tour is too large to publish") };

  const publishId = "pub_" + randomHex(12);
  const now = deps.now();
  try {
    await deps.db.batch([
      // A setting stated at a first publish (src/access.ts, planFirstPublish) goes first, so
      // the job below is recorded only together with it, and its condition reads it.
      ...head,
      {
        // The tour id comes from the tour row itself, and only while its draft is still the
        // version that was read, so a tour deleted or changed since the draft was read
        // fails the batch (NOT NULL) instead of starting a publish no row records, or one
        // of a draft whose pictures a replace has since removed.
        // The title is taken from the tour row here, not from the draft read above, so a
        // rename that landed in between (it found no job to update) is not lost.
        // And only while the tour's setting still says the store these keys are for and no
        // access switch of it is in progress (src/access.ts).
        sql: `INSERT INTO publish_job (tour_id, publish_id, data, steps, total, draft_version, created_at, touched_at)
              VALUES ((SELECT id FROM tour WHERE id = ? AND workspace_id = ? AND draft_version = ? AND access ${exactly !== null ? "= ?" : restricted ? "<> 'public'" : "= 'public'"}
                         AND NOT EXISTS (SELECT 1 FROM access_switch w WHERE w.tour_id = tour.id)), ?,
                      json_set(?, '$.title', (SELECT title FROM tour WHERE id = ? AND workspace_id = ?)), ?, ?, ?, ?, ?)`,
        params: [tourId, auth.workspaceId, rows[0].draft_version, ...(exactly !== null ? [exactly] : []), publishId, data, tourId, auth.workspaceId, rows.length, copies.length, rows[0].draft_version, now, now],
      },
      {
        sql: `INSERT INTO public_object (image_key, tour_id, publish_id, state, created_at, source_key, seq, copied)
              SELECT json_extract(j.value, '$[0]'), t.id, ?, 'pending', ?, json_extract(j.value, '$[1]'), j.key, 0
                FROM json_each(?) j JOIN tour t ON t.id = ? AND t.workspace_id = ?`,
        params: [publishId, now, JSON.stringify(copies.map((c) => [c.to, c.from])), tourId, auth.workspaceId],
      },
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) return { kind: "joined" };
    if (isNotNullViolation(err)) return { kind: "changed" }; // deleted, its draft or setting changed, or a switch began, since the draft was read
    throw err;
  }
  return { kind: "started", publishId, total: copies.length, steps: rows.length, copies };
}

/** The next `limit` images of a publish still to copy, and how many are left in all. */
export async function nextBatch(deps: Deps, tourId: string, publishId: string, limit: number): Promise<{ batch: Copy[]; left: number }> {
  const rows = await deps.db.all<{ image_key: string; source_key: string; left: number }>(
    `SELECT image_key, source_key,
            (SELECT count(*) FROM public_object WHERE publish_id = ? AND tour_id = ? AND state = 'pending' AND copied = 0) AS left
       FROM public_object WHERE publish_id = ? AND tour_id = ? AND state = 'pending' AND copied = 0
      ORDER BY seq LIMIT ?`,
    [publishId, tourId, publishId, tourId, Math.max(1, limit)],
  );
  return { batch: rows.slice(0, limit).map((r) => ({ from: r.source_key, to: r.image_key })), left: rows[0]?.left ?? 0 };
}

/** True for the error of a statement naming tour.ever_published on a database migration 0017 has not reached. */
function isBeforeEverPublished(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 3; e = e.cause, depth++) {
    if (/no such column: ever_published(?:$|:| at offset )/.test(e.message)) return true;
  }
  return false;
}

export function publishRoutes(app: Hono, deps: Deps): void {
  // Publish in bounded steps. Request: POST with no body to start (or to join the publish
  // of the current draft already in progress for this tour), then POST
  // {"publish_id": "<id>"} until done. Answers: 202 {status: "in_progress", publish_id,
  // done, total} while images are being copied; 200 {slug, url, steps} once the new version
  // is live (again on any repeat); 409 publish_cancelled when that publish was stopped
  // (unpublished, failed, abandoned, or replaced by a start from a newer draft).
  app.post("/api/v1/tours/:id/publish", async (c) => {
    // This request counts its own storage and database calls, so its copy batch is sized
    // from what is left of the budget after everything else it had to do.
    const meter = metered(deps);
    const d = meter.deps;
    const room = () => Math.min(COPY_BATCH, Math.max(0, Math.floor((SUBREQUEST_BUDGET - meter.calls() - CALLS_AFTER_COPIES) / 2)));

    const auth = await requireAuth(c.req.raw, d);
    if (auth instanceof Response) return auth;
    // Billing (src/billing.ts): a read-only workspace cannot start this; no call without billing.
    const ended = await readOnlyRefusal(d, auth.workspaceId);
    if (ended !== null) return ended;
    const body = await readPublishBody(c.req.raw);
    if (body instanceof Response) return body;
    const id = c.req.param("id");
    if (!TOUR_ID.test(id)) return notFound();
    // Housekeeping first, so an abandoned publish of this tour is already gone when its
    // state is read: a fresh start then begins a new publish in this same request. It only
    // ever touches the workspace's own tours, so it is safe before the tour is checked.
    await housekeeping(d, auth.workspaceId, id, PUBLISH_PAGES);
    // A setting stated at the first publish (src/access.ts): decided now, written later at the
    // head of the batch that records the job, so never without the publish it is for. Refused
    // here, nothing has changed. "same" is a publish exactly as without the fields.
    type Apply = Extract<FirstPublishPlan, { kind: "apply" }>;
    const decide = async (): Promise<Apply | Response | null> => {
      if (body.access === null) return null;
      const p = await planFirstPublish(d, auth, id, body.access);
      if (p === null) return notFound();
      if (p.kind === "refuse") return p.res;
      if (p.kind === "same") return null;
      return p;
    };
    let plan = await decide();
    if (plan instanceof Response) return plan;
    const tour = await tourState(d, auth, id);
    if (tour === null) return notFound();
    // A stated setting the tour already had ("same") must still be its setting now: a change
    // in the dashboard since the decision is refused, and nothing is published.
    if (body.access !== null && plan === null && tour.access !== body.access.access) return alreadySet();

    const asked = body.publishId;
    // A publish that went live answers the same however often it is asked.
    const s = plan === null ? shown(tour) : { access: plan.access, viewers: plan.viewers };
    if (asked !== null && tour.live_id === asked) return done(tour.slug, tour.live_steps ?? 0, s);
    if (asked !== null && tour.job_id !== asked) return publishStopped();
    // A switch of the live pictures between the stores must finish first (it cancelled any
    // publish when it began, so there is no job to drive).
    if (tour.switching === 1) return accessSwitching();
    // A fresh start finding a publish built from an older draft stops it and starts again
    // from the current draft; a call naming that publish keeps driving it.
    if (asked === null && tour.job_id !== null && (tour.job_version ?? 0) < tour.draft_version) {
      await stopPublish(d, tour.id, tour.job_id, []);
      tour.job_id = null;
    }
    // A stated setting always starts afresh: its batch cancels whatever publish of the tour
    // was in progress (of the other store, or of the same), so there is nothing to join.
    if (plan !== null) tour.job_id = null;

    let publishId: string;
    let total: number;
    let steps: number;
    let batch: Copy[];
    let left: number;
    if (tour.job_id !== null) {
      publishId = tour.job_id;
      total = tour.job_total ?? 0;
      steps = tour.job_steps ?? 0;
      ({ batch, left } = await nextBatch(d, tour.id, publishId, room()));
    } else {
      // With a stated setting, the job is recorded only while the tour has exactly that setting.
      const exactly = body.access === null ? null : body.access.access;
      let started = plan === null ? await startPublish(d, auth, tour.id, tour.access !== "public", [], exactly) : await startPublish(d, auth, tour.id, isRestricted(plan.access), plan.stmts, exactly);
      if (started.kind === "changed") {
        // The tour is gone, or its draft moved on while the publish was starting (an upload
        // or a chapter replace committed), or its setting changed or a switch began. Nothing
        // was written. If the tour is still there, read it again and start once more, in this
        // same request and in the store its setting says now, so the client gets its publish
        // of the newer draft; only losing a second time answers 409. A stated setting is
        // decided again first, from the tour as it is now (it may have been published or set
        // meanwhile, and is then refused).
        if (plan !== null) {
          plan = await decide();
          if (plan instanceof Response) return plan;
        }
        const again = await tourState(d, auth, tour.id);
        if (again === null) return notFound();
        if (again.switching === 1) return accessSwitching();
        if (body.access !== null && plan === null && again.access !== body.access.access) return alreadySet();
        Object.assign(s, plan === null ? shown(again) : { access: plan.access, viewers: plan.viewers });
        started = plan === null ? await startPublish(d, auth, tour.id, again.access !== "public", [], exactly) : await startPublish(d, auth, tour.id, isRestricted(plan.access), plan.stmts, exactly);
        if (started.kind === "changed") return (await tourState(d, auth, tour.id)) === null ? notFound() : draftMoved();
      }
      if (started.kind === "answer") return started.res;
      // A stated setting's batch also cancels any job before it records its own, so another
      // start cannot have won it; should one have all the same, nothing of this request was
      // written, and its setting is not joined to a publish that may be of another store.
      if (started.kind === "joined" && plan !== null) return publishBusy();
      if (started.kind === "started" && plan !== null) {
        // The publish its batch cancelled may have written public pictures already (never
        // live, never given out): they are due now, and go before this one copies anything,
        // so a tour made restricted keeps nothing in the public store. Housekeeping: a failure
        // leaves them to the clean-up after the commit.
        try {
          await clearDuePage(d, auth.workspaceId, tour.id, 0);
        } catch {
          console.error("publish: could not remove the pictures of a cancelled publish yet; will retry later");
        }
      }
      if (started.kind === "started") {
        ({ publishId, total, steps } = started);
        batch = started.copies.slice(0, room());
        left = total;
      } else {
        // Another start of this tour won: continue the publish it began. One join at most.
        const again = await tourState(d, auth, tour.id);
        if (again === null) return notFound();
        if (again.job_id === null) return publishBusy();
        publishId = again.job_id;
        total = again.job_total ?? 0;
        steps = again.job_steps ?? 0;
        ({ batch, left } = await nextBatch(d, tour.id, publishId, room()));
      }
    }

    const written = batch.map((x) => x.to);
    try {
      await runLimited(batch.map((x) => () => copyOne(d, x)), COPIES_IN_FLIGHT);
    } catch {
      return (await stopPublish(d, tour.id, publishId, written)) === "live" ? done(tour.slug, steps, s) : publishFailed();
    }

    if (batch.length < left) {
      // Not the last images. The heartbeat goes on the job row only, and only the rows of
      // the images copied here are marked. Either update finding fewer rows than expected
      // means the publish was ended meanwhile (unpublish, a failure elsewhere, a sweep).
      const touched = await d.db.run("UPDATE publish_job SET touched_at = ? WHERE publish_id = ? AND tour_id = ?", [d.now(), publishId, tour.id]);
      const marked = await d.db.run(
        "UPDATE public_object SET copied = 1 WHERE publish_id = ? AND tour_id = ? AND state = 'pending' AND image_key IN (SELECT value FROM json_each(?))",
        [publishId, tour.id, keyList(written)],
      );
      if (touched.changes !== 1 || marked.changes !== batch.length) {
        return (await stopPublish(d, tour.id, publishId, written)) === "live" ? done(tour.slug, steps, s) : publishStopped();
      }
      return inProgress(publishId, total - left + batch.length, total, s);
    }

    try {
      await d.db.batch(commitStatements(auth, tour.id, publishId, written, d.now(), graceOf(d)));
    } catch {
      // The batch may have committed and only its answer been lost, or a second call of
      // the same publish may have committed it: look before undoing.
      let state: { live: string | null; job: number | null } | null;
      try {
        state = await d.db.first<{ live: string | null; job: number | null }>(
          "SELECT (SELECT publish_id FROM snapshot WHERE tour_id = ?) AS live, (SELECT 1 FROM publish_job WHERE publish_id = ?) AS job",
          [tour.id, publishId],
        );
      } catch {
        // Cannot tell. Leave the rows: if it did not commit, a later sweep removes them.
        return publishFailed();
      }
      if (state?.live !== publishId) {
        if ((await stopPublish(d, tour.id, publishId, written)) !== "live") return state?.job === 1 ? publishFailed() : publishStopped();
      }
    }

    // The new snapshot is live. The images it replaced go once their grace has passed;
    // this clears anything of this tour that is already due.
    try {
      await clearDuePage(d, auth.workspaceId, tour.id, 0);
    } catch {
      console.error(`publish: could not remove the previous public images of ${tour.id}; will retry later`);
    }
    return done(tour.slug, steps, s);
  });

  app.post("/api/v1/tours/:id/unpublish", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    const id = c.req.param("id");
    const tour = TOUR_ID.test(id) ? await deps.db.first<{ id: string }>("SELECT id FROM tour WHERE id = ? AND workspace_id = ?", [id, auth.workspaceId]) : null;
    if (tour === null) return notFound();
    const ws = auth.workspaceId;
    const owned = "SELECT id FROM tour WHERE id = ? AND workspace_id = ?";
    const now = deps.now();
    // A tour that has been published keeps the mark that says so (migration 0017) through
    // this unpublish, set in the same batch that removes the rest of that evidence, so a first
    // publish can tell it apart (src/access.ts, EVER_PUBLISHED). Nothing ever clears the mark.
    // On a database that migration has not reached, the batch runs without it, as before.
    const mark: Stmt = {
      sql: `UPDATE tour SET ever_published = 1 WHERE id = ? AND workspace_id = ? AND ever_published = 0
              AND (status = 'published' OR published_at IS NOT NULL OR EXISTS (SELECT 1 FROM snapshot s WHERE s.tour_id = tour.id)
                   OR EXISTS (SELECT 1 FROM access_switch w WHERE w.tour_id = tour.id))`,
      params: [tour.id, ws],
    };
    const unpublishStatements: Stmt[] = [
      // Unpublish has no grace: images an earlier re-publish retired stop now as well.
      {
        sql: `UPDATE public_object SET delete_after = ? WHERE state = 'retired' AND delete_after > ? AND tour_id IN (${owned})`,
        params: [now, now, tour.id, ws],
      },
      // A publish in progress is cancelled: its rows are retired and its job dropped, so it can never commit.
      { sql: `UPDATE public_object SET state = 'retired', delete_after = ? WHERE state = 'pending' AND tour_id IN (${owned})`, params: [now, tour.id, ws] },
      { sql: `DELETE FROM publish_job WHERE tour_id IN (${owned})`, params: [tour.id, ws] },
      // So is a switch of the live pictures between the stores (src/access.ts): its pending
      // rows were retired just above, and a request of it still running deletes what it wrote.
      { sql: `DELETE FROM access_switch WHERE tour_id IN (${owned})`, params: [tour.id, ws] },
      {
        sql: `INSERT INTO public_object (image_key, tour_id, publish_id, state, created_at, delete_after)
              SELECT image_key, tour_id, ?, 'retired', ?, ? FROM snapshot_object WHERE tour_id IN (${owned})`,
        params: ["unpub_" + randomHex(12), now, now, tour.id, ws],
      },
      { sql: `DELETE FROM snapshot_object WHERE tour_id IN (${owned})`, params: [tour.id, ws] },
      { sql: `DELETE FROM snapshot WHERE tour_id IN (${owned})`, params: [tour.id, ws] },
      { sql: "UPDATE tour SET status = 'draft', published_at = NULL WHERE id = ? AND workspace_id = ?", params: [tour.id, ws] },
    ];
    try {
      await deps.db.batch([mark, ...unpublishStatements]);
    } catch (err) {
      if (!isBeforeEverPublished(err)) throw err;
      await deps.db.batch(unpublishStatements);
    }
    // Nothing of the tour is served from here on; deleting the objects takes as many
    // requests as it takes, UNPUBLISH_PAGES pages of keys at a time.
    const cleared = await housekeeping(deps, ws, tour.id, UNPUBLISH_PAGES, CARRY_CALLS);
    if (cleared === "failed") {
      return apiError(500, "cleanup_pending", "the tour is unpublished, but some of its public images could not be removed yet; unpublish again to retry");
    }
    if (cleared === "more") {
      return json(202, { status: "in_progress", detail: "the tour is unpublished; some of its public images are still to be removed; unpublish again to finish" });
    }
    return noContent();
  });

  // Published images, without a token. Only a name of a live snapshot, or one a re-publish
  // replaced whose grace has not passed, is served; the drafts store is never read here. The type comes from the name, which publish took
  // from the type sniffed at upload, never from the stored object's metadata. A name of a
  // tour whose workspace has a disabled account answers as an unknown name. The answer is
  // cached for a year (PUBLIC_CACHE), so that stops new fetches only: a copy a browser or a
  // cache already holds is not taken back. With PUBLIC_IMAGE_BASE set to a bucket's own
  // public address, pictures are fetched from the bucket and never pass through here, so
  // the app cannot stop them at all while their files exist.
  app.get("/p/:name", async (c) => {
    const name = c.req.param("name");
    const missing = () => json(404, { error: "not_found" });
    if (!PUBLIC_NAME.test(name)) return missing();
    const key = "p/" + name;
    // One call, as before the accounts could be disabled: the condition on the tour's
    // workspace is part of the same statement, through the tour row each name already has.
    const lookup = (condition: string) =>
      deps.db.first(
        `SELECT 1 AS x FROM snapshot_object o JOIN tour t ON t.id = o.tour_id WHERE o.image_key = ?${condition}
         UNION ALL SELECT 1 AS x FROM public_object o JOIN tour t ON t.id = o.tour_id
                    WHERE o.image_key = ? AND o.state = 'retired' AND o.delete_after > ?${condition} LIMIT 1`,
        [key, key, deps.now()],
      );
    // A database the accounts migration has not reached has no account to be disabled (nor
    // a tour that is restricted, which came later still). A restricted tour, or one becoming
    // restricted, answers as an unknown name, its retired names inside their grace too: its
    // pictures are served only by the app's own check (src/access.ts).
    // With billing on, a workspace whose links are down (src/removal-rules.ts) answers as an
    // unknown name too, in the same statement; without billing the statement is as before.
    const linksUp = linksUpSql(deps.config, "t.workspace_id", deps.now());
    const live = await beforeAccountsToo(() => lookup(` AND t.access = 'public' AND ${noDisabledAccount("t.workspace_id")}${linksUp}`), () => lookup(""));
    if (live === null) return missing();
    const file = await deps.pub.get(key);
    if (file === null) return missing();
    return new Response(file.body, {
      status: 200,
      headers: {
        "content-type": mime(typeOfKey(name)),
        "content-length": String(file.size),
        "cache-control": PUBLIC_CACHE,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "referrer-policy": "no-referrer",
      },
    });
  });
}
