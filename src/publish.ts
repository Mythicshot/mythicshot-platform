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
// exactly that version's images, and a chapter committed meanwhile goes out with the next
// publish. Restarting instead would let a tour that is being added to never finish.
//
// Every public object is named by exactly one row at every moment (see migration 0003):
// - A publish records each key as 'pending' BEFORE writing it. A pending row's created_at
//   is refreshed by every call that makes progress, so a publish counts as abandoned only
//   after STALE_PUBLISH_MS without progress; any later request in the workspace then
//   retires its rows and drops its job. The commit moves the pending keys into
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
import type { Hono } from "hono";
import { requireAuth, type Auth } from "./auth.ts";
import { SUBREQUEST_BUDGET } from "./budget.ts";
import { apiError, json, noContent, readCapped } from "./http.ts";
import { legacySettings, safeUrl, type Autoplay, type Box, type Card, type Cover, type EndCard, type Link, type Note, type Theme, type Zoom } from "./manifest.ts";
import { isUniqueViolation, type Deps, type Stmt } from "./ports.ts";

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
 * The calls one publish request makes besides its copies, in the worst case:
 *   2  authentication (token lookup, last-used update)
 *   1  the tour with its job and live snapshot, in one query
 *   4  housekeeping: one batch retiring abandoned publishes, then one page of due keys
 *      (select, one store delete, delete their rows)
 *   2  starting: the draft read, and one batch recording the job and its pending rows
 *      (resuming instead: 1, the select of the next images)
 *   6  finishing: the commit batch, then either the cleanup of this tour's due keys (3), or
 *      after a failed commit a status read (1) and stopping the publish (4: one batch, a
 *      read, a store delete, a row delete). A call that does not finish uses at most 5.
 */
const FIXED_PUBLISH_CALLS = 15;
/** Images one request copies: each is one read from the drafts store and one write to the public store. */
export const COPY_BATCH = Math.floor((SUBREQUEST_BUDGET - FIXED_PUBLISH_CALLS) / 2);
/** Copies in flight at once, inside the six connections a Worker may hold open. */
const COPIES_IN_FLIGHT = 4;
/** Due keys deleted per page: one store delete call takes at most 1,000 keys. */
const DUE_PAGE = 1000;
/** Pages of due keys per request: publish does one; unpublish, which retires a whole snapshot at once, two. */
const PUBLISH_PAGES = 1;
const UNPUBLISH_PAGES = 2;
/** Other tours of the workspace one request sweeps, most overdue first. */
export const SWEEP_TOURS = 2;
/** Starts that lost a race to another start of the same tour, before giving up. */
const START_ATTEMPTS = 3;

const TOUR_ID = /^tour_[0-9a-f]{24}$/;
const PUBLISH_ID = /^pub_[0-9a-f]{24}$/;
const PUBLIC_NAME = /^[0-9a-f]{32}\.(png|jpg)$/;
/** The publish route's optional body: {"publish_id": "..."}. */
const PUBLISH_BODY_BYTES = 1024;

type ImageType = "png" | "jpg";
const mime = (t: ImageType) => (t === "png" ? "image/png" : "image/jpeg");
const typeOfKey = (key: string): ImageType => (key.endsWith(".png") ? "png" : "jpg");

function randomHex(bytes: number): string {
  let s = "";
  for (const b of crypto.getRandomValues(new Uint8Array(bytes))) s += b.toString(16).padStart(2, "0");
  return s;
}

/** A new public key: 128 random bits, so it cannot be guessed and is never reused. */
function publicKey(type: ImageType): string {
  return `p/${randomHex(16)}.${type}`;
}

const notFound = () => apiError(404, "not_found", "no such tour");

type DraftRow = {
  title: string;
  slug: string;
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
  SELECT t.title, t.slug, t.spotlight_dim, t.theme, t.zoom AS t_zoom, t.cover, t.cta, t.end_card, t.autoplay, t.logo_key, t.logo_type,
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

type Copy = { from: string; to: string };

/** The snapshot's id for a draft chapter: one-way, so it says nothing about the upload behind the chapter. */
async function publicChapterId(chapterId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("demo-platform snapshot chapter:" + chapterId)));
  let s = "";
  for (const b of digest.subarray(0, 12)) s += b.toString(16).padStart(2, "0");
  return "c_" + s;
}

/** Builds the snapshot and the copies it needs, choosing a fresh public key for each image. */
export function buildSnapshot(rows: DraftRow[], chapterIds: Map<string, string>): { snapshot: Snapshot; copies: Copy[] } {
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
    const image = publicKey(r.image_type);
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
      logo = publicKey(t.logo_type);
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
async function runLimited(jobs: (() => Promise<void>)[], limit: number): Promise<void> {
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

async function copyOne(deps: Deps, c: Copy): Promise<void> {
  const file = await deps.drafts.get(c.from);
  if (file === null) throw new Error("a draft image is missing");
  const bytes = new Uint8Array(await new Response(file.body).arrayBuffer());
  await deps.pub.put(c.to, bytes, { contentType: mime(typeOfKey(c.to)), cacheControl: PUBLIC_CACHE });
}

const keyList = (keys: string[]) => JSON.stringify(keys);

const graceOf = (deps: Deps) => deps.config.retiredGraceMs ?? DEFAULT_RETIRED_GRACE_MS;

const WORKSPACE_TOURS = "SELECT id FROM tour WHERE workspace_id = ?";

/**
 * One page of retired keys past their grace: this tour's first, then those of up to
 * `otherTours` other tours of the workspace, most overdue first. Deletes the objects in
 * one store call, then their rows. Returns whether more of this tour's keys are due.
 * They are referenced by nothing live and no longer served, so this is safe at any time
 * and from any number of requests at once.
 */
async function clearDuePage(deps: Deps, workspaceId: string, tourId: string, otherTours: number): Promise<{ any: boolean; more: boolean }> {
  const now = deps.now();
  const rows = await deps.db.all<{ image_key: string; tour_id: string }>(
    `SELECT o.image_key, o.tour_id FROM public_object o
      WHERE o.state = 'retired' AND o.delete_after <= ?
        AND (o.tour_id = ? OR o.tour_id IN (
              SELECT p.tour_id FROM public_object p
               WHERE p.state = 'retired' AND p.delete_after <= ? AND p.tour_id <> ? AND p.tour_id IN (${WORKSPACE_TOURS})
               GROUP BY p.tour_id ORDER BY min(p.delete_after), p.tour_id LIMIT ?))
      ORDER BY o.tour_id <> ?, o.delete_after, o.image_key
      LIMIT ?`,
    [now, tourId, now, tourId, workspaceId, otherTours, tourId, DUE_PAGE + 1],
  );
  if (rows.length === 0) return { any: false, more: false };
  const page = rows.slice(0, DUE_PAGE);
  const keys = page.map((r) => r.image_key);
  await deps.pub.delete(keys);
  await deps.db.run(
    `DELETE FROM public_object WHERE state = 'retired' AND delete_after <= ? AND image_key IN (SELECT value FROM json_each(?)) AND tour_id IN (${WORKSPACE_TOURS})`,
    [now, keyList(keys), workspaceId],
  );
  return { any: true, more: rows.length > DUE_PAGE && rows[DUE_PAGE].tour_id === tourId };
}

/**
 * Housekeeping on every publish and unpublish, in at most 1 + 3 x `pages` calls: retires
 * the pending rows of every publish in the workspace that has made no progress for
 * STALE_PUBLISH_MS and drops jobs left with no pending rows (one batch), then deletes due
 * keys a page at a time, this tour's first and a few other tours' after. Errors are logged
 * as fixed text and never thrown. Answers "failed" if anything failed, "more" if this
 * tour still has due keys, else "clean".
 */
async function housekeeping(deps: Deps, workspaceId: string, tourId: string, pages: number): Promise<"clean" | "more" | "failed"> {
  try {
    const now = deps.now();
    await deps.db.batch([
      {
        sql: `UPDATE public_object SET state = 'retired', delete_after = ? WHERE state = 'pending' AND created_at < ? AND tour_id IN (${WORKSPACE_TOURS})`,
        params: [now, now - STALE_PUBLISH_MS, workspaceId],
      },
      {
        sql: `DELETE FROM publish_job WHERE tour_id IN (${WORKSPACE_TOURS})
                AND NOT EXISTS (SELECT 1 FROM public_object o WHERE o.publish_id = publish_job.publish_id AND o.state = 'pending')`,
        params: [workspaceId],
      },
    ]);
    for (let page = 0; page < pages; page++) {
      const r = await clearDuePage(deps, workspaceId, tourId, SWEEP_TOURS);
      if (!r.more) return "clean";
    }
    return "more";
  } catch {
    console.error(`publish: could not remove old public images near ${tourId}; will retry later`);
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
    if (keys.length > 0) await deps.pub.delete(keys);
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
 * exists, every one of its rows is still pending and copied (or copied by this call), and
 * the tour is still this workspace's; then the whole batch rolls back.
 */
function commitStatements(auth: Auth, tourId: string, publishId: string, justCopied: string[], now: number, graceMs: number): Stmt[] {
  return [
    {
      sql: `INSERT INTO snapshot (tour_id, data, published_at, publish_id, steps)
            VALUES (?, (SELECT j.data FROM publish_job j
                         WHERE j.publish_id = ? AND j.tour_id = ?
                           AND (SELECT count(*) FROM public_object o
                                 WHERE o.publish_id = ? AND o.state = 'pending' AND o.tour_id = ?
                                   AND (o.copied = 1 OR o.image_key IN (SELECT value FROM json_each(?)))) = j.total
                           AND EXISTS (SELECT 1 FROM tour WHERE id = ? AND workspace_id = ?)),
                    ?, ?, (SELECT steps FROM publish_job WHERE publish_id = ?))
            ON CONFLICT (tour_id) DO UPDATE SET data = excluded.data, published_at = excluded.published_at, publish_id = excluded.publish_id, steps = excluded.steps`,
      params: [tourId, publishId, tourId, publishId, tourId, keyList(justCopied), tourId, auth.workspaceId, now, publishId, publishId],
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
  job_id: string | null;
  job_total: number | null;
  job_steps: number | null;
  live_id: string | null;
  live_steps: number | null;
};

const TOUR_STATE_SQL = `
  SELECT t.id, t.slug, j.publish_id AS job_id, j.total AS job_total, j.steps AS job_steps, s.publish_id AS live_id, s.steps AS live_steps
    FROM tour t LEFT JOIN publish_job j ON j.tour_id = t.id LEFT JOIN snapshot s ON s.tour_id = t.id
   WHERE t.id = ? AND t.workspace_id = ?`;

async function tourState(deps: Deps, auth: Auth, id: string): Promise<TourState | null> {
  if (!TOUR_ID.test(id)) return null;
  return deps.db.first<TourState>(TOUR_STATE_SQL, [id, auth.workspaceId]);
}

const publishFailed = () => apiError(500, "publish_failed", "the tour could not be published; what was published before is unchanged");
const publishStopped = () =>
  apiError(409, "publish_cancelled", "this publish was stopped before it finished (the tour was unpublished, or the publish failed or was abandoned); publish again to start over");
const done = (slug: string, steps: number) => json(200, { slug, url: `/t/${slug}`, steps });
const inProgress = (publishId: string, doneCount: number, total: number) => json(202, { status: "in_progress", publish_id: publishId, done: doneCount, total });

/** The publish route's body: nothing, or {"publish_id": "pub_..."} to continue that publish. */
async function readPublishBody(req: Request): Promise<{ publishId: string | null } | Response> {
  const bad = () => apiError(400, "bad_request", 'the body must be empty or {"publish_id": "<id from the previous answer>"}');
  const raw = await readCapped(req, PUBLISH_BODY_BYTES);
  if (raw === "too_large") return apiError(413, "too_large", `the request is over ${PUBLISH_BODY_BYTES} bytes`);
  if (raw.byteLength === 0) return { publishId: null };
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw));
  } catch {
    return bad();
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return bad();
  const id = (body as Record<string, unknown>).publish_id;
  if (id === undefined || id === null) return { publishId: null };
  if (typeof id !== "string" || !PUBLISH_ID.test(id)) return bad();
  return { publishId: id };
}

type Started = { kind: "started"; publishId: string; total: number; steps: number; batch: Copy[] } | { kind: "joined" } | { kind: "answer"; res: Response };

/**
 * Reads the draft once, builds the snapshot and records the job and every key it will
 * write, in one batch, before writing any. When another start of the same tour won the
 * race, answers "joined" so the caller continues that publish instead.
 */
async function startPublish(deps: Deps, auth: Auth, tourId: string): Promise<Started> {
  const rows = await deps.db.all<DraftRow>(DRAFT_SQL, [tourId, auth.workspaceId, MAX_PUBLISH_STEPS + 1]);
  if (rows.length === 0) return { kind: "answer", res: apiError(400, "empty_tour", "a tour with no steps cannot be published") };
  if (rows.length > MAX_PUBLISH_STEPS) return { kind: "answer", res: apiError(413, "too_large", `a tour of more than ${MAX_PUBLISH_STEPS} steps cannot be published`) };
  const chapterIds = new Map<string, string>();
  for (const r of rows) if (!chapterIds.has(r.c_id)) chapterIds.set(r.c_id, await publicChapterId(r.c_id));
  const { snapshot, copies } = buildSnapshot(rows, chapterIds);
  const data = JSON.stringify(snapshot);
  if (utf8Length(data) > MAX_SNAPSHOT_BYTES) return { kind: "answer", res: apiError(413, "too_large", "the tour is too large to publish") };

  const publishId = "pub_" + randomHex(12);
  const now = deps.now();
  try {
    await deps.db.batch([
      {
        sql: "INSERT INTO publish_job (tour_id, publish_id, data, steps, total, created_at) SELECT id, ?, ?, ?, ?, ? FROM tour WHERE id = ? AND workspace_id = ?",
        params: [publishId, data, rows.length, copies.length, now, tourId, auth.workspaceId],
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
    throw err;
  }
  return { kind: "started", publishId, total: copies.length, steps: rows.length, batch: copies.slice(0, COPY_BATCH) };
}

/** The next images of a publish still to copy, and how many are left in all. */
async function nextBatch(deps: Deps, tourId: string, publishId: string): Promise<{ batch: Copy[]; left: number }> {
  const rows = await deps.db.all<{ image_key: string; source_key: string; left: number }>(
    `SELECT image_key, source_key,
            (SELECT count(*) FROM public_object WHERE publish_id = ? AND tour_id = ? AND state = 'pending' AND copied = 0) AS left
       FROM public_object WHERE publish_id = ? AND tour_id = ? AND state = 'pending' AND copied = 0
      ORDER BY seq LIMIT ?`,
    [publishId, tourId, publishId, tourId, COPY_BATCH],
  );
  return { batch: rows.map((r) => ({ from: r.source_key, to: r.image_key })), left: rows[0]?.left ?? 0 };
}

export function publishRoutes(app: Hono, deps: Deps): void {
  // Publish in bounded steps. Request: POST with no body to start (or to join the publish
  // already in progress for this tour), then POST {"publish_id": "<id>"} until done.
  // Answers: 202 {status: "in_progress", publish_id, done, total} while images are being
  // copied; 200 {slug, url, steps} once the new version is live (again on any repeat);
  // 409 publish_cancelled when that publish was stopped (unpublished, failed, abandoned).
  app.post("/api/v1/tours/:id/publish", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    const body = await readPublishBody(c.req.raw);
    if (body instanceof Response) return body;
    let tour = await tourState(deps, auth, c.req.param("id"));
    if (tour === null) return notFound();
    await housekeeping(deps, auth.workspaceId, tour.id, PUBLISH_PAGES);

    const asked = body.publishId;
    let publishId: string;
    let total: number;
    let steps: number;
    let batch: Copy[];
    let left: number;
    for (let attempt = 1; ; attempt++) {
      // A publish that went live answers the same however often it is asked.
      if (asked !== null && tour.live_id === asked) return done(tour.slug, tour.live_steps ?? 0);
      if (asked !== null && tour.job_id !== asked) return publishStopped();
      if (tour.job_id !== null) {
        publishId = tour.job_id;
        total = tour.job_total ?? 0;
        steps = tour.job_steps ?? 0;
        ({ batch, left } = await nextBatch(deps, tour.id, publishId));
        break;
      }
      const started = await startPublish(deps, auth, tour.id);
      if (started.kind === "answer") return started.res;
      if (started.kind === "started") {
        ({ publishId, total, steps, batch } = started);
        left = total;
        break;
      }
      // Another start of this tour won: continue the publish it began.
      if (attempt >= START_ATTEMPTS) return apiError(409, "publish_busy", "another publish of this tour is starting; try again");
      const again = await tourState(deps, auth, tour.id);
      if (again === null) return notFound();
      tour = again;
    }

    const written = batch.map((x) => x.to);
    try {
      await runLimited(batch.map((x) => () => copyOne(deps, x)), COPIES_IN_FLIGHT);
    } catch {
      return (await stopPublish(deps, tour.id, publishId, written)) === "live" ? done(tour.slug, steps) : publishFailed();
    }

    if (batch.length < left) {
      // Not the last images: mark these copied and keep the publish alive. The update
      // touches every pending row of this publish, so it reports `total` changes unless
      // the publish was ended meanwhile (unpublish, a failure elsewhere, a sweep).
      const marked = await deps.db.run(
        `UPDATE public_object SET copied = CASE WHEN image_key IN (SELECT value FROM json_each(?)) THEN 1 ELSE copied END, created_at = ?
          WHERE publish_id = ? AND tour_id = ? AND state = 'pending'`,
        [keyList(written), deps.now(), publishId, tour.id],
      );
      if (marked.changes !== total) {
        return (await stopPublish(deps, tour.id, publishId, written)) === "live" ? done(tour.slug, steps) : publishStopped();
      }
      return inProgress(publishId, total - left + batch.length, total);
    }

    try {
      await deps.db.batch(commitStatements(auth, tour.id, publishId, written, deps.now(), graceOf(deps)));
    } catch {
      // The batch may have committed and only its answer been lost, or a second call of
      // the same publish may have committed it: look before undoing.
      let state: { live: string | null; job: number | null } | null;
      try {
        state = await deps.db.first<{ live: string | null; job: number | null }>(
          "SELECT (SELECT publish_id FROM snapshot WHERE tour_id = ?) AS live, (SELECT 1 FROM publish_job WHERE publish_id = ?) AS job",
          [tour.id, publishId],
        );
      } catch {
        // Cannot tell. Leave the rows: if it did not commit, a later sweep removes them.
        return publishFailed();
      }
      if (state?.live !== publishId) {
        if ((await stopPublish(deps, tour.id, publishId, written)) !== "live") return state?.job === 1 ? publishFailed() : publishStopped();
      }
    }

    // The new snapshot is live. The images it replaced go once their grace has passed;
    // this clears anything of this tour that is already due.
    try {
      await clearDuePage(deps, auth.workspaceId, tour.id, 0);
    } catch {
      console.error(`publish: could not remove the previous public images of ${tour.id}; will retry later`);
    }
    return done(tour.slug, steps);
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
    await deps.db.batch([
      // Unpublish has no grace: images an earlier re-publish retired stop now as well.
      {
        sql: `UPDATE public_object SET delete_after = ? WHERE state = 'retired' AND delete_after > ? AND tour_id IN (${owned})`,
        params: [now, now, tour.id, ws],
      },
      // A publish in progress is cancelled: its rows are retired and its job dropped, so it can never commit.
      { sql: `UPDATE public_object SET state = 'retired', delete_after = ? WHERE state = 'pending' AND tour_id IN (${owned})`, params: [now, tour.id, ws] },
      { sql: `DELETE FROM publish_job WHERE tour_id IN (${owned})`, params: [tour.id, ws] },
      {
        sql: `INSERT INTO public_object (image_key, tour_id, publish_id, state, created_at, delete_after)
              SELECT image_key, tour_id, ?, 'retired', ?, ? FROM snapshot_object WHERE tour_id IN (${owned})`,
        params: ["unpub_" + randomHex(12), now, now, tour.id, ws],
      },
      { sql: `DELETE FROM snapshot_object WHERE tour_id IN (${owned})`, params: [tour.id, ws] },
      { sql: `DELETE FROM snapshot WHERE tour_id IN (${owned})`, params: [tour.id, ws] },
      { sql: "UPDATE tour SET status = 'draft', published_at = NULL WHERE id = ? AND workspace_id = ?", params: [tour.id, ws] },
    ]);
    // Nothing of the tour is served from here on; deleting the objects takes as many
    // requests as it takes, UNPUBLISH_PAGES pages of keys at a time.
    const cleared = await housekeeping(deps, ws, tour.id, UNPUBLISH_PAGES);
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
  // from the type sniffed at upload, never from the stored object's metadata.
  app.get("/p/:name", async (c) => {
    const name = c.req.param("name");
    const missing = () => json(404, { error: "not_found" });
    if (!PUBLIC_NAME.test(name)) return missing();
    const key = "p/" + name;
    const live = await deps.db.first(
      `SELECT 1 AS x FROM snapshot_object WHERE image_key = ?
       UNION ALL SELECT 1 AS x FROM public_object WHERE image_key = ? AND state = 'retired' AND delete_after > ? LIMIT 1`,
      [key, key, deps.now()],
    );
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
