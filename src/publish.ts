// Publish, unpublish and the public image route.
//
// Drafts are private and publishing makes a copy: publish copies the tour's current
// chapters, steps, layer, cards and settings into one snapshot row, and every image (and
// the cover logo) into the public store under a new random name. The player reads only
// the snapshot, so nothing done to the draft afterwards reaches it until the next publish.
//
// Every public object is named by exactly one row at every moment (see migration 0003):
// - A publish records each key it intends to write as 'pending' in public_object BEFORE
//   writing it, then copies, then commits in one batch that moves its pending keys into
//   snapshot_object and the previous snapshot's keys into public_object as 'retired'.
//   A retired key stays served for a grace period (config.retiredGraceMs), so a viewer
//   still on the previous page (cached for a minute) keeps its images; once that has
//   passed, a later request deletes it from the store, then its row.
// - Unpublish moves the snapshot's keys to 'retired' in one batch with deleting the
//   snapshot, with no grace (and ends the grace of keys an earlier re-publish retired),
//   then deletes exactly those keys, then their rows.
// - Every publish and unpublish also sweeps a few other tours of its workspace, oldest
//   due first, so a replaced or abandoned image never stays public for want of another
//   request on its own tour.
// - A publish that fails retires its own pending keys, deletes every key it chose (it
//   holds them in memory, so even a key written after its rows were swept is caught),
//   then the rows. If that cleanup fails too, the rows stay and a later request finishes.
// - The commit only takes effect while all of this publish's pending rows are still
//   pending, so a sweep that retired a stale publish can never race it into going live
//   with missing images.
// Keys are random and never reused, so a retired key past its grace can be deleted by any
// request at any time. Nothing is ever found by listing the store.
import type { Hono } from "hono";
import { requireAuth, type Auth } from "./auth.ts";
import { apiError, json, noContent } from "./http.ts";
import { legacySettings, safeUrl, type Autoplay, type Box, type Card, type Cover, type EndCard, type Link, type Note, type Theme, type Zoom } from "./manifest.ts";
import type { Deps, Stmt } from "./ports.ts";

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
/** A pending publish older than this is taken to be dead and is swept by a later request on the same tour. */
export const STALE_PUBLISH_MS = 15 * 60 * 1000;
/**
 * The most steps one publish copies. Each copy is one read from the drafts store and one
 * write to the public store, so 400 steps and a logo are 802 storage calls, which with
 * about a dozen database calls stays under the 1,000 subrequests a Worker may make.
 */
export const MAX_PUBLISH_STEPS = 400;
/**
 * The largest snapshot text. D1 stores up to 2,000,000 bytes in one value, but CPU sets
 * the cap: reading the draft rows, building the snapshot and serialising it twice costs
 * about 4 ms of pure CPU per megabyte (measured in V8), so 512,000 bytes keeps that part
 * near 2 ms of the free plan's 10 ms. A single upload's manifest is at most 262,144 bytes,
 * so this allows about two full-size uploads' worth of text per tour.
 */
export const MAX_SNAPSHOT_BYTES = 512_000;
/** Copies in flight at once, inside the six connections a Worker may hold open. */
const COPIES_IN_FLIGHT = 4;
/** Retired rows cleared per call, and calls per request. */
const RETIRED_PAGE = 500;
const RETIRED_PAGES = 3;
/** Other tours of the workspace one request sweeps, oldest due first. */
export const SWEEP_TOURS = 2;

const TOUR_ID = /^tour_[0-9a-f]{24}$/;
const PUBLIC_NAME = /^[0-9a-f]{32}\.(png|jpg)$/;

type ImageType = "png" | "jpg";
const mime = (t: ImageType) => (t === "png" ? "image/png" : "image/jpeg");

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

type Copy = { from: string; to: string; type: ImageType };

/** The snapshot's id for a draft chapter: one-way, so it says nothing about the upload behind the chapter. */
async function publicChapterId(chapterId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("demo-platform snapshot chapter:" + chapterId)));
  let s = "";
  for (const b of digest.subarray(0, 12)) s += b.toString(16).padStart(2, "0");
  return "c_" + s;
}

/** Builds the snapshot and the copies it needs, choosing a fresh public key for each image. */
function buildSnapshot(rows: DraftRow[], chapterIds: Map<string, string>): { snapshot: Snapshot; copies: Copy[] } {
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
    copies.push({ from: r.image_key, to: image, type: r.image_type });
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
      copies.push({ from: t.logo_key, to: logo, type: t.logo_type });
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
  await deps.pub.put(c.to, bytes, { contentType: mime(c.type), cacheControl: PUBLIC_CACHE });
}

const keyList = (keys: string[]) => JSON.stringify(keys);

const graceOf = (deps: Deps) => deps.config.retiredGraceMs ?? DEFAULT_RETIRED_GRACE_MS;

/**
 * Deletes this tour's retired objects whose grace has passed, then their rows. They are
 * referenced by nothing live and no longer served, so this is safe at any time and from
 * any number of requests at once.
 */
async function clearRetired(deps: Deps, tourId: string, pages = RETIRED_PAGES): Promise<void> {
  const now = deps.now();
  for (let page = 0; page < pages; page++) {
    const rows = await deps.db.all<{ image_key: string }>(
      "SELECT image_key FROM public_object WHERE tour_id = ? AND state = 'retired' AND delete_after <= ? ORDER BY image_key LIMIT ?",
      [tourId, now, RETIRED_PAGE],
    );
    if (rows.length === 0) return;
    const keys = rows.map((r) => r.image_key);
    await deps.pub.delete(keys);
    await deps.db.run("DELETE FROM public_object WHERE tour_id = ? AND state = 'retired' AND image_key IN (SELECT value FROM json_each(?))", [
      tourId,
      keyList(keys),
    ]);
    if (rows.length < RETIRED_PAGE) return;
  }
}

/**
 * Housekeeping before a publish or unpublish: retires the tour's pending keys of any
 * publish older than STALE_PUBLISH_MS (its request is taken to be dead; if it is not,
 * its commit now fails), then clears every retired key of the tour. Errors are logged
 * as fixed text and never fail the request.
 */
async function sweepTour(deps: Deps, tourId: string, pages = RETIRED_PAGES): Promise<void> {
  try {
    const now = deps.now();
    await deps.db.run(
      "UPDATE public_object SET state = 'retired', publish_id = ?, delete_after = ? WHERE tour_id = ? AND state = 'pending' AND created_at < ?",
      ["sweep_" + randomHex(12), now, tourId, now - STALE_PUBLISH_MS],
    );
    await clearRetired(deps, tourId, pages);
  } catch {
    console.error(`publish: could not remove old public images of ${tourId}; will retry later`);
  }
}

/**
 * Sweeps up to SWEEP_TOURS other tours of the workspace that have a retired image past
 * its grace or a stale pending publish, the longest due first. Bounded, so one request
 * does a fixed amount of work; logged as fixed text and never fails the request.
 */
async function sweepWorkspace(deps: Deps, workspaceId: string, exceptTourId: string): Promise<void> {
  let due: { tour_id: string }[];
  try {
    const now = deps.now();
    due = await deps.db.all<{ tour_id: string }>(
      `SELECT o.tour_id, min(CASE WHEN o.state = 'retired' THEN o.delete_after ELSE o.created_at + ? END) AS due
         FROM public_object o JOIN tour t ON t.id = o.tour_id
        WHERE t.workspace_id = ? AND o.tour_id <> ?
          AND ((o.state = 'retired' AND o.delete_after <= ?) OR (o.state = 'pending' AND o.created_at < ?))
        GROUP BY o.tour_id ORDER BY due, o.tour_id LIMIT ?`,
      [STALE_PUBLISH_MS, workspaceId, exceptTourId, now, now - STALE_PUBLISH_MS, SWEEP_TOURS],
    );
  } catch {
    console.error("publish: could not look for old public images; will retry later");
    return;
  }
  for (const { tour_id } of due) await sweepTour(deps, tour_id, 1);
}

/** Housekeeping before a publish or unpublish: this tour's leftovers, then a few other tours'. */
async function housekeeping(deps: Deps, auth: Auth, tourId: string): Promise<void> {
  await sweepTour(deps, tourId);
  await sweepWorkspace(deps, auth.workspaceId, tourId);
}

/**
 * Undoes a publish that did not commit: retires its pending rows, deletes every key it
 * chose, then the rows. If any step fails the rows stay, pending or retired, and a later
 * request on the tour finishes the job.
 */
async function abandon(deps: Deps, tourId: string, publishId: string, keys: string[]): Promise<void> {
  try {
    await deps.db.run("UPDATE public_object SET state = 'retired', delete_after = ? WHERE publish_id = ? AND state = 'pending'", [deps.now(), publishId]);
    await deps.pub.delete(keys);
    await deps.db.run("DELETE FROM public_object WHERE tour_id = ? AND state = 'retired' AND image_key IN (SELECT value FROM json_each(?))", [
      tourId,
      keyList(keys),
    ]);
  } catch {
    console.error(`publish: could not remove the images of a failed publish of ${tourId}; will retry later`);
  }
}

function commitStatements(auth: Auth, tourId: string, publishId: string, data: string, expected: number, now: number, graceMs: number): Stmt[] {
  return [
    // Fails (NOT NULL on data) unless every pending row of this publish is still there and
    // the tour is still this workspace's; then the whole batch rolls back.
    {
      sql: `INSERT INTO snapshot (tour_id, data, published_at, publish_id)
            VALUES (?, (SELECT ? WHERE (SELECT count(*) FROM public_object WHERE publish_id = ? AND state = 'pending' AND tour_id = ?) = ?
                                  AND EXISTS (SELECT 1 FROM tour WHERE id = ? AND workspace_id = ?)), ?, ?)
            ON CONFLICT (tour_id) DO UPDATE SET data = excluded.data, published_at = excluded.published_at, publish_id = excluded.publish_id`,
      params: [tourId, data, publishId, tourId, expected, tourId, auth.workspaceId, now, publishId],
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
    { sql: "UPDATE tour SET status = 'published', published_at = ? WHERE id = ? AND workspace_id = ?", params: [now, tourId, auth.workspaceId] },
  ];
}

async function ownedTour(deps: Deps, auth: Auth, id: string): Promise<{ id: string } | null> {
  if (!TOUR_ID.test(id)) return null;
  return deps.db.first<{ id: string }>("SELECT id FROM tour WHERE id = ? AND workspace_id = ?", [id, auth.workspaceId]);
}

const publishFailed = () => apiError(500, "publish_failed", "the tour could not be published; what was published before is unchanged");

export function publishRoutes(app: Hono, deps: Deps): void {
  app.post("/api/v1/tours/:id/publish", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    const tour = await ownedTour(deps, auth, c.req.param("id"));
    if (tour === null) return notFound();
    await housekeeping(deps, auth, tour.id);

    const rows = await deps.db.all<DraftRow>(DRAFT_SQL, [tour.id, auth.workspaceId, MAX_PUBLISH_STEPS + 1]);
    if (rows.length === 0) return apiError(400, "empty_tour", "a tour with no steps cannot be published");
    if (rows.length > MAX_PUBLISH_STEPS) return apiError(413, "too_large", `a tour of more than ${MAX_PUBLISH_STEPS} steps cannot be published`);
    const chapterIds = new Map<string, string>();
    for (const r of rows) if (!chapterIds.has(r.c_id)) chapterIds.set(r.c_id, await publicChapterId(r.c_id));
    const { snapshot, copies } = buildSnapshot(rows, chapterIds);
    const data = JSON.stringify(snapshot);
    if (new TextEncoder().encode(data).byteLength > MAX_SNAPSHOT_BYTES) return apiError(413, "too_large", "the tour is too large to publish");

    // Record every key before writing any of them.
    const publishId = "pub_" + randomHex(12);
    const keys = copies.map((x) => x.to);
    const recorded = await deps.db.run(
      `INSERT INTO public_object (image_key, tour_id, publish_id, state, created_at)
       SELECT j.value, t.id, ?, 'pending', ? FROM json_each(?) j JOIN tour t ON t.id = ? AND t.workspace_id = ?`,
      [publishId, deps.now(), keyList(keys), tour.id, auth.workspaceId],
    );
    if (recorded.changes !== keys.length) {
      await abandon(deps, tour.id, publishId, keys);
      return notFound();
    }

    try {
      await runLimited(copies.map((x) => () => copyOne(deps, x)), COPIES_IN_FLIGHT);
    } catch {
      await abandon(deps, tour.id, publishId, keys);
      return publishFailed();
    }

    try {
      await deps.db.batch(commitStatements(auth, tour.id, publishId, data, keys.length, deps.now(), graceOf(deps)));
    } catch {
      // The batch may have committed and only its answer been lost: look before undoing.
      let live: { publish_id: string | null } | null;
      try {
        live = await deps.db.first<{ publish_id: string | null }>("SELECT publish_id FROM snapshot WHERE tour_id = ?", [tour.id]);
      } catch {
        // Cannot tell. Leave the pending rows: if it did not commit, a later sweep removes them.
        return publishFailed();
      }
      if (live?.publish_id !== publishId) {
        await abandon(deps, tour.id, publishId, keys);
        return publishFailed();
      }
    }

    // The new snapshot is live. The images it replaced go once their grace has passed;
    // this clears anything of this tour that is already due.
    try {
      await clearRetired(deps, tour.id);
    } catch {
      console.error(`publish: could not remove the previous public images of ${tour.id}; will retry later`);
    }
    const slug = rows[0].slug;
    return json(200, { slug, url: `/t/${slug}`, steps: rows.length });
  });

  app.post("/api/v1/tours/:id/unpublish", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    const tour = await ownedTour(deps, auth, c.req.param("id"));
    if (tour === null) return notFound();
    await housekeeping(deps, auth, tour.id);
    const ws = auth.workspaceId;
    const owned = "SELECT id FROM tour WHERE id = ? AND workspace_id = ?";
    const now = deps.now();
    await deps.db.batch([
      // Unpublish has no grace: images an earlier re-publish retired stop now as well.
      {
        sql: `UPDATE public_object SET delete_after = ? WHERE state = 'retired' AND delete_after > ? AND tour_id IN (${owned})`,
        params: [now, now, tour.id, ws],
      },
      {
        sql: `INSERT INTO public_object (image_key, tour_id, publish_id, state, created_at, delete_after)
              SELECT image_key, tour_id, ?, 'retired', ?, ? FROM snapshot_object WHERE tour_id IN (${owned})`,
        params: ["unpub_" + randomHex(12), now, now, tour.id, ws],
      },
      { sql: `DELETE FROM snapshot_object WHERE tour_id IN (${owned})`, params: [tour.id, ws] },
      { sql: `DELETE FROM snapshot WHERE tour_id IN (${owned})`, params: [tour.id, ws] },
      { sql: "UPDATE tour SET status = 'draft', published_at = NULL WHERE id = ? AND workspace_id = ?", params: [tour.id, ws] },
    ]);
    try {
      await clearRetired(deps, tour.id);
    } catch {
      console.error(`unpublish: could not remove the public images of ${tour.id}; will retry later`);
      return apiError(500, "cleanup_pending", "the tour is unpublished, but some of its public images could not be removed yet; unpublish again to retry");
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
        "content-type": mime(name.endsWith(".png") ? "png" : "jpg"),
        "content-length": String(file.size),
        "cache-control": PUBLIC_CACHE,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "referrer-policy": "no-referrer",
      },
    });
  });
}
