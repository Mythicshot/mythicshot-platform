// "Download all my data": one zip file holding everything in the workspace of a signed-in
// person (Plan 2l, item 9; the wording is section 7 of the billing mockups). Two requests,
// both a browser session's alone, never a token or a connected computer's:
//
// - POST /api/v1/account/data asks for a download. It is a change, so requireAuth holds it to
//   the dashboard's own pages (Origin and X-Csrf-Token). It counts against LIMITS_EXPORT,
//   refuses a workspace too large for this target (below), and takes the workspace's one
//   download row (one at a time). It answers 200 {url}: the address of the file, good once,
//   for this session, for TICKET_MS.
// - GET /api/v1/account/data/<ticket> is that address. The page opens it as a plain download,
//   so the browser writes the zip to disk as it arrives and nothing holds it whole. The ticket
//   is the time the row was taken and an HMAC, keyed by the session's own secret from its
//   cookie, of the workspace, the session and that time: no other session, and no other site,
//   can make one, and a GET without the cookie is refused before the ticket is looked at. The
//   first GET that uses it marks the row running, with the audit row of the export, in one
//   batch; a second use finds no ready row and answers as an unknown ticket.
//
// Allowed in every state of billing, read-only included: an ended subscription or a finished
// trial may still take its data away, so readOnlyRefusal (src/billing.ts) is not asked.
//
// What is read, and from where. Every row comes from ONE statement (LISTING_SQL), scoped to
// the session's workspace at every level, so the zip is a consistent copy of one moment and
// costs one call. Every file is read by the key its own row names (a step's picture, a tour's
// logo, a shared item's current parts) from the private store, never found by listing a store
// and never by a name taken from a request, so no file of another workspace can be reached.
// A tour's pages are its DRAFT, what the person last saved, built by the publish's own
// buildSnapshot and checked by the page's own pageTour.
//
// The call budget (src/budget.ts). The rows are one call, and every stored file one more as
// it is reached: a step's picture, a logo, each part of a shared item (PART_BYTES each). On
// Workers a request makes at most SUBREQUEST_BUDGET calls, so a download there may read at
// most EXPORT_WORKER_FILES files; a workspace with more is refused with 409
// too_large_to_export before any byte is sent, never cut short. The Node server has no such
// limit: its entry sets Config.exportFileReads to null, and every file is streamed from disk.
//
// The zip (src/zip.ts) is written as a stream, file after file, as the browser takes it:
//   README.txt              what is in the file, for a person
//   account.json            the same list, for a program
//   tours/<name>/index.html the tour as a click-through page that opens from disk, offline
//   tours/<name>/tour.json  its chapters, steps and settings
//   tours/<name>/pictures/  step-001.png, ... and logo.png when it has a logo
//   images/<name>.png|jpg   each shared image
//   clips/<name>.gif|mp4    each shared clip
// Every name is made here from a title by safeName: lower-case ASCII letters, digits and
// hyphens only, never a Windows device name, unique within its folder. The two lists come
// last, so they can say which file could not be read, if any.
import type { Hono } from "hono";
import { auditStatement } from "./audit.ts";
import { constantTimeEqual, requireAuth, type Auth } from "./auth.ts";
import { SUBREQUEST_BUDGET } from "./budget.ts";
import { apiError, json } from "./http.ts";
import { objectKey } from "./media.ts";
import { MalformedSnapshot, escapeHtml, pageTour, scriptJson, type PageData, type PageTour } from "./page.ts";
import { PLAYER_CSS, PLAYER_JS } from "./player/assets.ts";
import { isNotNullViolation, isUniqueViolation, type Deps, type FileStore } from "./ports.ts";
import { buildSnapshot, type DraftRow, type DraftTour, type Snapshot } from "./publish.ts";
import { EXPORT_RUNNING_BUCKET, LIMITS_EXPORT, hitLimit, workspaceKey } from "./rate.ts";
import { readSessionCookie } from "./sessions.ts";
import { withHeader } from "./signin.ts";
import { zipStream, type ZipEntry } from "./zip.ts";

/** How long the address POST answers can be opened: the page opens it at once. */
export const TICKET_MS = 60_000;
/**
 * How long a download that was started counts as running when nothing ended it (a server that
 * stopped while sending): after this a new one may start. A download that ends, fails or is
 * cancelled lets the next one start at once.
 */
export const RUNNING_MS = 60 * 60_000;
/** The calls a download makes besides its files: the session (two), the rows, the start, the end. */
export const EXPORT_FIXED_CALLS = 5;
/** The most stored files one download reads on Workers, within the call budget. */
export const EXPORT_WORKER_FILES = SUBREQUEST_BUDGET - EXPORT_FIXED_CALLS;
/** The file name the browser saves the zip as. */
export const EXPORT_FILE_NAME = "mythicshot-data.zip";
/** The paths of the two requests. */
export const EXPORT_PATH = "/api/v1/account/data";

const TICKET = /^[0-9a-f]{76}$/;
const READY = 1;
const RUNNING = 2;

const noDownload = () => apiError(404, "not_found", "no such download");
const busy = () => apiError(409, "export_busy", "a download of this workspace's data is already being prepared or sent; wait for it to finish");
const tooLarge = (files: number, most: number) =>
  apiError(409, "too_large_to_export", `this workspace has ${files} stored files, more than the ${most} one download can hold on this server`);
const tooMany = (retryAfterSeconds: number) =>
  withHeader(apiError(429, "rate_limited", "this workspace asked for its data too many times in the last hour; try again later"), "retry-after", String(retryAfterSeconds));

/** The most files one download of this site may read: a number on Workers (the default), null for no limit. */
export function exportFileLimit(deps: Deps): number | null {
  const v = deps.config.exportFileReads;
  return v === null ? null : typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : EXPORT_WORKER_FILES;
}

// ---- What is read ----------------------------------------------------------------------

/** The stored files of the workspace a download would read, as a scalar over the CTE `p`. */
const FILES_EXPR = `(
  (SELECT count(*) FROM step s JOIN tour t ON t.id = s.tour_id JOIN p ON t.workspace_id = p.ws)
  + (SELECT count(*) FROM tour t JOIN p ON t.workspace_id = p.ws WHERE t.logo_key IS NOT NULL)
  + (SELECT count(*) FROM media_object o JOIN media m ON m.id = o.media_id JOIN p ON m.workspace_id = p.ws
      WHERE m.state = 'online' AND o.current = 1 AND o.n >= 0))`;

/** The count alone, for the request that asks for a download. Parameter: the workspace. */
const FILES_SQL = `WITH p AS (SELECT ? AS ws) SELECT ${FILES_EXPR} AS files`;

/**
 * Everything a download holds, in one statement: the count of files, and, only when it is
 * within the limit, the rows as one JSON text (SQLite works out a CASE branch only when it is
 * taken, so a workspace that is refused costs no more than its count). Every subquery is
 * scoped to the workspace through `p`; the account's row must be a member of it. Nested
 * results go through json() so they stay JSON inside the outer object. Parameters: the
 * workspace, the limit, the account.
 */
const LISTING_SQL = `WITH p AS (SELECT ? AS ws), f AS (SELECT ${FILES_EXPR} AS n)
SELECT f.n AS files, CASE WHEN f.n <= ? THEN json_object(
  'account', json((SELECT json_object('email', u.email, 'username', u.username) FROM user u JOIN membership ms ON ms.user_id = u.id JOIN p ON ms.workspace_id = p.ws WHERE u.id = ?)),
  'workspace', (SELECT w.name FROM workspace w JOIN p ON w.id = p.ws),
  'tours', json((SELECT json_group_array(json_object(
      'id', t.id, 'title', t.title, 'slug', t.slug, 'status', t.status, 'access', t.access,
      'created_at', t.created_at, 'updated_at', t.updated_at, 'published_at', t.published_at,
      'spotlight_dim', t.spotlight_dim, 'theme', t.theme, 't_zoom', t.zoom, 'cover', t.cover, 'cta', t.cta, 'end_card', t.end_card, 'autoplay', t.autoplay,
      'logo_key', t.logo_key, 'logo_type', t.logo_type, 'logo_bytes', t.logo_bytes,
      'viewers', json((SELECT json_group_array(v.email) FROM tour_viewer v WHERE v.tour_id = t.id))))
    FROM tour t JOIN p ON t.workspace_id = p.ws)),
  'chapters', json((SELECT json_group_array(json_object('id', c.id, 'tour_id', c.tour_id, 'title', c.title, 'description', c.description, 'position', c.position))
    FROM chapter c JOIN tour t ON t.id = c.tour_id JOIN p ON t.workspace_id = p.ws)),
  'steps', json((SELECT json_group_array(json_object(
      'id', s.id, 'tour_id', s.tour_id, 'chapter_id', s.chapter_id, 'position', s.position, 'image_key', s.image_key, 'image_type', s.image_type,
      'width', s.width, 'height', s.height, 'bytes', s.bytes, 'click_x', s.click_x, 'click_y', s.click_y, 'click_size', s.click_size,
      'caption', s.caption, 'spotlight', s.spotlight, 'notes', s.notes, 'card', s.card, 'advance', s.advance, 's_zoom', s.zoom))
    FROM step s JOIN tour t ON t.id = s.tour_id JOIN p ON t.workspace_id = p.ws)),
  'media', json((SELECT json_group_array(json_object(
      'id', m.id, 'kind', m.kind, 'content_type', m.content_type, 'bytes', m.bytes, 'parts', m.parts, 'width', m.width, 'height', m.height,
      'duration_ms', m.duration_ms, 'title', m.title, 'created_at', m.created_at, 'online_at', m.online_at, 'access', m.access,
      'link_id', coalesce(m.private_link_id, m.link_id),
      'viewers', json((SELECT json_group_array(v.email) FROM media_viewer v WHERE v.media_id = m.id)),
      'objects', json((SELECT json_group_array(json_array(o.n, o.claim, o.bytes)) FROM media_object o WHERE o.media_id = m.id AND o.current = 1 AND o.n >= 0))))
    FROM media m JOIN p ON m.workspace_id = p.ws WHERE m.state = 'online'))
) END AS data FROM f`;

type TourRow = {
  id: string;
  title: string;
  slug: string;
  status: "draft" | "published";
  access: "public" | "people" | "me";
  created_at: number;
  updated_at: number;
  published_at: number | null;
  logo_bytes: number | null;
  viewers: string[];
} & DraftTour;
type ChapterRow = { id: string; tour_id: string; title: string; description: string | null; position: number };
type StepRow = Omit<DraftRow, keyof DraftTour | "slug" | "draft_version" | "c_id" | "c_title" | "c_description" | "s_id"> & {
  id: string;
  tour_id: string;
  chapter_id: string;
  position: number;
  bytes: number;
};
type MediaRow = {
  id: string;
  kind: "image" | "clip";
  content_type: string;
  bytes: number;
  parts: number;
  width: number;
  height: number;
  duration_ms: number | null;
  title: string | null;
  created_at: number;
  online_at: number | null;
  access: "public" | "people" | "me";
  link_id: string;
  viewers: string[];
  objects: [number, string, number][];
};
type Listing = {
  account: { email: string; username: string | null } | null;
  workspace: string | null;
  tours: TourRow[];
  chapters: ChapterRow[];
  steps: StepRow[];
  media: MediaRow[];
};

/** The rows of a download, or the count of files when it is over the limit. */
async function readListing(deps: Deps, auth: Auth, limit: number | null): Promise<{ files: number; listing: Listing | null }> {
  const userId = auth.session?.userId ?? "";
  const row = await deps.db.first<{ files: number; data: string | null }>(LISTING_SQL, [auth.workspaceId, limit ?? Number.MAX_SAFE_INTEGER, userId]);
  const files = row?.files ?? 0;
  if (row === null || row.data === null) return { files, listing: null };
  return { files, listing: JSON.parse(row.data) as Listing };
}

// ---- Names -----------------------------------------------------------------------------

/** Names Windows keeps for devices, with or without an extension. */
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;
const NAME_MAX = 60;

/**
 * A file or folder name from a title: letters with their accents taken off, lower-case, every
 * run of anything but a-z and 0-9 one hyphen, none at either end, at most NAME_MAX characters;
 * `fallback` when nothing is left, and `<name>-<fallback>` for a Windows device name. Unique
 * among `taken` (compared lower-case, as Windows and macOS compare), by "-2", "-3" and on.
 */
export function safeName(title: string | null, fallback: string, taken: Set<string>): string {
  let base = (title ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, NAME_MAX)
    .replace(/-+$/, "");
  if (base === "") base = fallback;
  if (DEVICE_NAME.test(base)) base = `${base}-${fallback}`;
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  taken.add(name);
  return name;
}

const pad3 = (n: number) => String(n).padStart(3, "0");
const extOf = (contentType: string) => (contentType === "image/png" ? "png" : contentType === "image/jpeg" ? "jpg" : contentType === "image/gif" ? "gif" : "mp4");
const iso = (ms: number | null) => (ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString());

// ---- The offline tour page -------------------------------------------------------------

async function sha256Base64(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  let s = "";
  for (const b of digest) s += String.fromCharCode(b);
  return btoa(s);
}

/**
 * The player's stylesheet without its web font: the font's address is one of the app's, which a
 * page opened from disk has not, so the page uses the fallback fonts the stylesheet names after
 * it. Nothing else of the stylesheet refers to a file.
 */
export const OFFLINE_CSS = PLAYER_CSS.replace(/@font-face\s*\{[^}]*\}\n?/g, "");

/**
 * The page's policy: its one stylesheet and its one script by their digests, pictures from
 * beside it, nothing else at all. No connection, no font, no frame, no form, no base: the page
 * asks no server for anything, wherever it is opened.
 */
let policy: Promise<string> | null = null;
export function offlinePolicy(): Promise<string> {
  policy ??= (async () => {
    // Neither may close its own element early, and the stylesheet may refer to no file; a test holds both.
    if (/<\/script/i.test(PLAYER_JS) || /<\/style/i.test(OFFLINE_CSS) || /url\(|@import/i.test(OFFLINE_CSS)) throw new Error("export: the player cannot be put inside a page");
    return `default-src 'none'; img-src 'self' file:; style-src 'sha256-${await sha256Base64(OFFLINE_CSS)}'; script-src 'sha256-${await sha256Base64(PLAYER_JS)}'; base-uri 'none'; form-action 'none'`;
  })();
  return policy;
}

/**
 * The tour as one page that plays from disk: the player's own stylesheet and script inside it,
 * the tour's data in its #tour block with "." as the base (src/player/main.ts takes only
 * `pictures/` names with it), so every picture is the relative address of a file beside it.
 * The title is escaped as on the public page; the data is scriptJson's.
 */
export async function offlinePageHtml(tour: PageTour): Promise<string> {
  const title = escapeHtml(tour.title);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${await offlinePolicy()}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<style>${OFFLINE_CSS}</style>
</head>
<body>
<main id="player">
<div class="fallback">
<h1>${title}</h1>
<noscript><p>This tour needs JavaScript to play. Turn it on in your browser to click through it.</p></noscript>
</div>
</main>
<script type="application/json" id="tour">${scriptJson({ base: ".", tour } satisfies PageData)}</script>
<script>${PLAYER_JS}</script>
</body>
</html>
`;
}

// ---- The plan of the zip ---------------------------------------------------------------

/** One stored file the zip holds, and where it goes. */
type StoredItem = { path: string; keys: string[]; bytes: number; modified: number | null };
/** What is said of a tour in the lists. */
type TourOut = {
  title: string;
  folder: string;
  created_at: string | null;
  updated_at: string | null;
  published: boolean;
  published_at: string | null;
  link: string | null;
  sharing: "public" | "people" | "me";
  viewers: string[];
  chapters: number;
  steps: number;
  bytes: number;
  page: boolean;
  files: { path: string; bytes: number }[];
};
type MediaOut = {
  title: string | null;
  file: string;
  created_at: string | null;
  shared_at: string | null;
  sharing: "public" | "people" | "me";
  viewers: string[];
  link: string;
  bytes: number;
  width: number;
  height: number;
  duration_ms?: number | null;
};
type Plan = {
  exportedAt: number;
  account: { email: string; username: string | null };
  workspace: string;
  tours: TourOut[];
  images: MediaOut[];
  clips: MediaOut[];
  /** In the order they go in the zip: written ones (text) and stored ones. */
  files: ({ kind: "text"; path: string; text: string; modified: number | null } | ({ kind: "stored" } & StoredItem))[];
};

/** Viewers only for "people": "public" and "me" have no list. Sorted, so the lists read the same each time. */
const viewersOf = (access: string, viewers: unknown): string[] => (access === "people" && Array.isArray(viewers) ? viewers.filter((v): v is string => typeof v === "string").sort() : []);

/** The tour's draft as the publish would build it, with the zip's own picture names in place of live keys. */
async function tourFiles(t: TourRow, chapters: ChapterRow[], steps: StepRow[], folder: string): Promise<{ readable: unknown; page: string | null; stored: StoredItem[] }> {
  const order = new Map(chapters.map((c) => [c.id, c]));
  const own = steps
    .filter((s) => order.has(s.chapter_id))
    .sort((a, b) => {
      const ca = order.get(a.chapter_id)!;
      const cb = order.get(b.chapter_id)!;
      return ca.position - cb.position || (ca.id < cb.id ? -1 : ca.id > cb.id ? 1 : 0) || a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
  const rows: DraftRow[] = own.map((s) => {
    const c = order.get(s.chapter_id)!;
    return { ...s, ...tourPart(t), slug: t.slug, draft_version: 0, c_id: c.id, c_title: c.title, c_description: c.description, s_id: s.id };
  });
  const { snapshot, copies } = buildSnapshot(rows, new Map(chapters.map((c) => [c.id, c.id])), false, tourPart(t));
  // buildSnapshot names one copy per step, in order, then the logo's when the cover uses it.
  const names = new Map<string, string>();
  const stored: StoredItem[] = [];
  own.forEach((s, i) => {
    const path = `pictures/step-${pad3(i + 1)}.${s.image_type}`;
    names.set(copies[i].to, path);
    stored.push({ path: `tours/${folder}/${path}`, keys: [s.image_key], bytes: s.bytes, modified: t.updated_at });
  });
  if (t.logo_key !== null && t.logo_type !== null) {
    const path = `pictures/logo.${t.logo_type}`;
    if (copies.length > own.length) names.set(copies[own.length].to, path);
    stored.push({ path: `tours/${folder}/${path}`, keys: [t.logo_key], bytes: t.logo_bytes ?? 0, modified: t.updated_at });
  }
  let n = 0;
  const offline: Snapshot = {
    ...snapshot,
    cover: snapshot.cover === null ? null : { ...snapshot.cover, logo: snapshot.cover.logo === null ? null : (names.get(snapshot.cover.logo) ?? null) },
    chapters: snapshot.chapters.map((c) => ({ ...c, steps: c.steps.map((s) => ({ ...s, id: `step-${pad3(++n)}`, image: names.get(s.image) ?? "" })) })),
  };
  // The readable file: the same, without the ids the player needs and nobody else does.
  const readable = {
    title: offline.title,
    settings: { spotlight_dim: offline.spotlight_dim, theme: offline.theme, zoom: offline.zoom, cover: offline.cover, cta: offline.cta, end: offline.end, autoplay: offline.autoplay },
    chapters: offline.chapters.map((c) => ({
      title: c.title,
      description: c.description,
      steps: c.steps.map(({ id: _id, image, ...rest }) => ({ picture: image, ...rest })),
    })),
  };
  let page: string | null = null;
  try {
    page = await offlinePageHtml(pageTour(offline));
  } catch (err) {
    // A draft the page cannot show (the public page answers 404 for such a snapshot) still has its data and pictures.
    if (!(err instanceof MalformedSnapshot)) throw err;
  }
  return { readable, page, stored };
}

function tourPart(t: TourRow): DraftTour {
  return {
    title: t.title,
    spotlight_dim: t.spotlight_dim,
    theme: t.theme,
    t_zoom: t.t_zoom,
    cover: t.cover,
    cta: t.cta,
    end_card: t.end_card,
    autoplay: t.autoplay,
    logo_key: t.logo_key,
    logo_type: t.logo_type,
  };
}

async function planOf(listing: Listing, now: number): Promise<Plan> {
  // Oldest first; made at the same moment, by title, then by id, so the same data always gives the same names.
  // Images before clips, as the zip's folders are.
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  const byAge = (a: { created_at: number; id: string; title: string | null; kind?: string }, b: { created_at: number; id: string; title: string | null; kind?: string }) =>
    (a.kind === "clip" ? 1 : 0) - (b.kind === "clip" ? 1 : 0) || a.created_at - b.created_at || cmp(a.title ?? "", b.title ?? "") || cmp(a.id, b.id);
  const files: Plan["files"] = [];
  const tours: TourOut[] = [];
  const folders = new Set<string>();
  for (const t of [...listing.tours].sort(byAge)) {
    const folder = safeName(t.title, "tour", folders);
    const chapters = listing.chapters.filter((c) => c.tour_id === t.id);
    const steps = listing.steps.filter((s) => s.tour_id === t.id);
    const made = await tourFiles(t, chapters, steps, folder);
    if (made.page !== null) files.push({ kind: "text", path: `tours/${folder}/index.html`, text: made.page, modified: t.updated_at });
    files.push({ kind: "text", path: `tours/${folder}/tour.json`, text: JSON.stringify(made.readable, null, 2) + "\n", modified: t.updated_at });
    for (const s of made.stored) files.push({ kind: "stored", ...s });
    const published = t.status === "published";
    tours.push({
      title: t.title,
      folder: `tours/${folder}`,
      created_at: iso(t.created_at),
      updated_at: iso(t.updated_at),
      published,
      published_at: published ? iso(t.published_at) : null,
      link: published ? `/t/${t.slug}` : null,
      sharing: t.access,
      viewers: viewersOf(t.access, t.viewers),
      chapters: new Set(steps.map((s) => s.chapter_id)).size,
      steps: steps.length,
      bytes: steps.reduce((n, s) => n + s.bytes, 0) + (t.logo_bytes ?? 0),
      page: made.page !== null,
      files: made.stored.map((s) => ({ path: s.path, bytes: s.bytes })),
    });
  }
  const images: MediaOut[] = [];
  const clips: MediaOut[] = [];
  const names = { image: new Set<string>(), clip: new Set<string>() };
  for (const m of [...listing.media].sort(byAge)) {
    const folder = m.kind === "image" ? "images" : "clips";
    const file = `${folder}/${safeName(m.title, m.kind, names[m.kind])}.${extOf(m.content_type)}`;
    // The current parts, in order: an item whose rows do not make its whole file is left out of the zip, and the lists say so.
    const parts = [...(Array.isArray(m.objects) ? m.objects : [])].sort((a, b) => a[0] - b[0]);
    const whole = parts.length === m.parts && parts.every((p, i) => p[0] === i) && parts.reduce((n, p) => n + p[2], 0) === m.bytes;
    if (whole) files.push({ kind: "stored", path: file, keys: parts.map((p) => objectKey(m.id, { n: p[0], claim: p[1], ext: null })), bytes: m.bytes, modified: m.online_at ?? m.created_at });
    const out: MediaOut = {
      title: m.title,
      file,
      created_at: iso(m.created_at),
      shared_at: iso(m.online_at ?? m.created_at),
      sharing: m.access,
      viewers: viewersOf(m.access, m.viewers),
      link: `${m.kind === "image" ? "/i/" : "/r/"}${m.link_id}`,
      bytes: m.bytes,
      width: m.width,
      height: m.height,
    };
    if (m.kind === "clip") out.duration_ms = m.duration_ms;
    (m.kind === "image" ? images : clips).push(out);
  }
  return {
    exportedAt: now,
    account: listing.account ?? { email: "", username: null },
    workspace: listing.workspace ?? "",
    tours,
    images,
    clips,
    files,
  };
}

// ---- The two lists ---------------------------------------------------------------------

const SHARING_WORDS: Record<string, string> = { public: "anyone with the link", people: "only the people listed", me: "only you" };
/** One line of user text in README.txt: no control or format character, no line break. */
const oneLine = (s: string) => s.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ").trim();
const day = (s: string | null) => (s === null ? "unknown" : s.slice(0, 10));

/** What the lists say of a file that could not be put in the zip, by its path. */
type Missing = Map<string, "missing" | "incomplete">;

function accountJson(plan: Plan, missing: Missing): string {
  const out = {
    exported_at: iso(plan.exportedAt),
    account: { email: plan.account.email, username: plan.account.username },
    workspace: { name: plan.workspace },
    tours: plan.tours,
    images: plan.images,
    clips: plan.clips,
    not_included: [...missing].map(([path, why]) => ({ path, reason: why === "missing" ? "the file could not be read" : "only part of the file could be read" })),
  };
  return JSON.stringify(out, null, 2) + "\n";
}

function readme(plan: Plan, missing: Missing): string {
  const lines: string[] = [];
  const add = (...l: string[]) => lines.push(...l);
  add("Your data", "", `Saved on ${iso(plan.exportedAt)!.replace("T", " ").slice(0, 16)} UTC.`, "");
  add(`Account: ${oneLine(plan.account.email)}${plan.account.username === null ? "" : ` (username ${oneLine(plan.account.username)})`}`);
  add(`Workspace: ${oneLine(plan.workspace)}`, "");
  add("What is in this file", "");
  add("- tours: one folder for each tour. Open index.html in a tour's folder to click through the tour in your browser. It needs no internet connection. tour.json holds the tour's chapters, steps and settings, and the pictures folder its pictures.");
  add("- images: your shared images.");
  add("- clips: your shared GIFs and clips.");
  add("- account.json: this same list, for programs.", "");
  add(`Tours (${plan.tours.length})`, "");
  if (plan.tours.length === 0) add("None.", "");
  for (const t of plan.tours) {
    add(`${oneLine(t.title)}`);
    add(`  Folder: ${t.folder}`);
    add(`  Made ${day(t.created_at)}, last changed ${day(t.updated_at)}`);
    add(`  Published: ${t.published ? `yes, on ${day(t.published_at)}, at ${t.link}` : "no"}`);
    add(`  Shared with: ${SHARING_WORDS[t.sharing]}${t.viewers.length > 0 ? ` (${t.viewers.join(", ")})` : ""}`);
    add(`  ${t.chapters} chapter${t.chapters === 1 ? "" : "s"}, ${t.steps} step${t.steps === 1 ? "" : "s"}, ${t.bytes} bytes`);
    if (!t.page) add("  This tour could not be made into a page; its data and pictures are in its folder.");
    add("");
  }
  for (const [what, list] of [
    ["Images", plan.images],
    ["Clips", plan.clips],
  ] as const) {
    add(`${what} (${list.length})`, "");
    if (list.length === 0) add("None.", "");
    for (const m of list) {
      add(`${m.title === null ? "(no title)" : oneLine(m.title)}`);
      add(`  File: ${m.file}`);
      add(`  Shared ${day(m.shared_at)}, at ${m.link}`);
      add(`  Shared with: ${SHARING_WORDS[m.sharing]}${m.viewers.length > 0 ? ` (${m.viewers.join(", ")})` : ""}`);
      add(`  ${m.width} x ${m.height} pixels, ${m.bytes} bytes`, "");
    }
  }
  if (missing.size > 0) {
    add("Not included", "");
    for (const [path, why] of missing) add(`- ${path}: ${why === "missing" ? "the file could not be read" : "only part of the file could be read"}`);
    add("");
  }
  return lines.join("\r\n");
}

// ---- Reading the files -----------------------------------------------------------------

/**
 * One stored file's bytes, its parts read one after another as the zip takes them. null when
 * its first part is missing or of the wrong length; a later part that is missing or wrong
 * ends the stream there, and `short` is told, so the file is listed as incomplete. Only the
 * keys its rows named are read.
 */
async function storedBody(store: FileStore, item: StoredItem, short: () => void): Promise<ReadableStream<Uint8Array> | null> {
  const first = await store.get(item.keys[0]);
  if (first === null) return null;
  let n = 0;
  let current: ReadableStreamDefaultReader<Uint8Array> | null = first.body.getReader();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        for (;;) {
          if (current === null) {
            n++;
            if (n >= item.keys.length) {
              controller.close();
              return;
            }
            const next = await store.get(item.keys[n]);
            if (next === null) {
              short();
              controller.close();
              return;
            }
            current = next.body.getReader();
          }
          const { done, value } = await current.read();
          if (done) {
            current = null;
            continue;
          }
          controller.enqueue(value);
          return;
        }
      },
      async cancel(reason) {
        await current?.cancel(reason).catch(() => {});
      },
    },
    { highWaterMark: 0 },
  );
}

// ---- The routes ------------------------------------------------------------------------

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** The ticket of a download row taken at `start`: the time in 12 hex digits, and the HMAC of the session's secret over the workspace, the session and the time. */
async function ticketOf(secret: string, auth: Auth, start: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`account data\n${auth.workspaceId}\n${auth.session?.id ?? ""}\n${start}`)));
  return start.toString(16).padStart(12, "0") + hex(mac);
}

/** The condition, over `rate_counter` in scope, that its row is a download that still counts. Parameters: the two floors (ready, running). */
const LIVE = "((count = 1 AND window_start > ?) OR (count = 2 AND window_start > ?))";

const ZIP_HEADERS: Record<string, string> = {
  "content-type": "application/zip",
  "content-disposition": `attachment; filename="${EXPORT_FILE_NAME}"`,
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
  "referrer-policy": "no-referrer",
};

export function exportRoutes(app: Hono, deps: Deps): void {
  // Ask for a download. 200 {url}; 409 too_large_to_export (Workers only) or export_busy; 429 rate_limited. At most 5 calls.
  app.post(EXPORT_PATH, async (c) => {
    const auth = await requireAuth(c.req.raw, deps, { only: "session" });
    if (auth instanceof Response) return auth;
    const secret = readSessionCookie(c.req.raw);
    if (auth.session === undefined || secret === null) return json(401, { error: "unauthorized" });
    const key = await workspaceKey(auth.workspaceId);
    const hit = await hitLimit(deps, LIMITS_EXPORT.start, key);
    if (hit.over) return tooMany(hit.retryAfterSeconds);
    const limit = exportFileLimit(deps);
    if (limit !== null) {
      const files = (await deps.db.first<{ files: number }>(FILES_SQL, [auth.workspaceId]))?.files ?? 0;
      if (files > limit) return tooLarge(files, limit);
    }
    const now = deps.now();
    let taken: number;
    try {
      taken = (
        await deps.db.run(
          `INSERT INTO rate_counter (bucket, key, window_start, count) SELECT ?, ?, ?, ${READY}
            WHERE NOT EXISTS (SELECT 1 FROM rate_counter WHERE bucket = ? AND key = ? AND ${LIVE})`,
          [EXPORT_RUNNING_BUCKET, key, now, EXPORT_RUNNING_BUCKET, key, now - TICKET_MS, now - RUNNING_MS],
        )
      ).changes;
    } catch (err) {
      // Two asks in the same millisecond: the one that lost is told another is under way.
      if (!isUniqueViolation(err)) throw err;
      taken = 0;
    }
    if (taken !== 1) return busy();
    return json(200, { url: `${EXPORT_PATH}/${await ticketOf(secret, auth, now)}` });
  });

  // The file. 200 with the zip as a stream; 404 for a ticket that is not this session's, used,
  // or older than TICKET_MS; 409 too_large_to_export (Workers only). Before the first byte: at
  // most 4 calls (the session, the rows, the start); then one per stored file, and one at the end.
  app.get(`${EXPORT_PATH}/:ticket`, async (c) => {
    const auth = await requireAuth(c.req.raw, deps, { only: "session" });
    if (auth instanceof Response) return auth;
    const secret = readSessionCookie(c.req.raw);
    if (auth.session === undefined || secret === null) return json(401, { error: "unauthorized" });
    const ticket = c.req.param("ticket");
    if (!TICKET.test(ticket)) return noDownload();
    const start = Number.parseInt(ticket.slice(0, 12), 16);
    const now = deps.now();
    // Judged before any call: a ticket that is not this session's costs nothing.
    if (!constantTimeEqual(ticket, await ticketOf(secret, auth, start)) || start <= now - TICKET_MS || start > now + TICKET_MS) return noDownload();
    const key = await workspaceKey(auth.workspaceId);
    const release = () => deps.db.run("DELETE FROM rate_counter WHERE bucket = ? AND key = ? AND window_start = ?", [EXPORT_RUNNING_BUCKET, key, start]);

    const limit = exportFileLimit(deps);
    const { files, listing } = await readListing(deps, auth, limit);
    if (listing === null) {
      // Over the limit since it was asked for: the row goes while it is still only ready (never a
      // download already running from this ticket), so the next ask is answered at once.
      await deps.db.run(`DELETE FROM rate_counter WHERE bucket = ? AND key = ? AND window_start = ? AND count = ${READY}`, [EXPORT_RUNNING_BUCKET, key, start]);
      return tooLarge(files, limit ?? 0);
    }
    const plan = await planOf(listing, now);
    // The row becomes running, and the export is recorded, together; a ticket used before finds no ready row.
    try {
      await deps.db.batch([
        { sql: `UPDATE rate_counter SET count = ${RUNNING} WHERE bucket = ? AND key = ? AND window_start = ? AND count = ${READY}`, params: [EXPORT_RUNNING_BUCKET, key, start] },
        auditStatement(
          deps,
          {
            event: "data_exported",
            userId: auth.session.userId,
            workspaceId: auth.workspaceId,
            detail: { tours: plan.tours.length, images: plan.images.length, clips: plan.clips.length, files: plan.files.filter((f) => f.kind === "stored").length },
          },
          { onlyAfterOneChange: true },
        ),
      ]);
    } catch (err) {
      if (isNotNullViolation(err)) return noDownload();
      throw err;
    }

    const missing: Missing = new Map();
    async function* entries(): AsyncGenerator<ZipEntry> {
      for (const f of plan.files) {
        if (f.kind === "text") {
          const bytes = new TextEncoder().encode(f.text);
          yield { name: f.path, modified: f.modified, size: bytes.length, open: async () => bytes };
          continue;
        }
        let short = false;
        yield {
          name: f.path,
          modified: f.modified,
          size: f.bytes,
          open: () => storedBody(deps.drafts, f, () => (short = true)),
          done: (written) => {
            if (written === null) missing.set(f.path, "missing");
            else if (short || written !== f.bytes) missing.set(f.path, "incomplete");
          },
        };
      }
      // Last, so they can name a file that could not be read.
      const readmeBytes = new TextEncoder().encode(readme(plan, missing));
      yield { name: "README.txt", modified: now, size: readmeBytes.length, open: async () => readmeBytes };
      const listBytes = new TextEncoder().encode(accountJson(plan, missing));
      yield { name: "account.json", modified: now, size: listBytes.length, open: async () => listBytes };
    }

    // The row goes when the zip has been sent, when it fails, and when the browser stops taking it.
    const zip = zipStream(entries()).getReader();
    let released = false;
    const end = async () => {
      if (released) return;
      released = true;
      await release().catch(() => console.error("export: the end of a download could not be recorded; the next one may start after an hour"));
    };
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          let next: Awaited<ReturnType<typeof zip.read>>;
          try {
            next = await zip.read();
          } catch {
            // Fixed text only: the error could carry a key or anything a store put in it.
            console.error("export: a download stopped because a file could not be read");
            await end();
            controller.error(new Error("export failed"));
            return;
          }
          if (next.done) {
            await end();
            controller.close();
          } else {
            controller.enqueue(next.value);
          }
        },
        async cancel(reason) {
          await zip.cancel(reason).catch(() => {});
          await end();
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { status: 200, headers: ZIP_HEADERS });
  });
}
