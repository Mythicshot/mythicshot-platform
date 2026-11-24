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
//   first GET that uses it claims it BEFORE anything is read: one batch marks the row running
//   (exactly one row, ready and within its minute) with the audit row of the export, which the
//   batch writes only after that one change. A second use, at once or later, loses the claim
//   and is answered at once, having read nothing. A refused ticket (unknown, used, expired, or
//   a workspace grown too large) answers the dashboard's own failure sentence as plain text
//   with no file name, so a browser shows it and saves no file. A HEAD of the address answers as
//   an unknown path does and touches no ticket. A download whose reader takes no bytes for
//   EXPORT_IDLE_MS, or that is still going after EXPORT_MAX_MS, is stopped and its row released.
// - GET /api/v1/account/data says whether a download of the workspace is being prepared or
//   sent ({running}), so the page keeps its button disabled until it has ended.
//
// Allowed in every state of billing, read-only included: an ended subscription or a finished
// trial may still take its data away, so readOnlyRefusal (src/billing.ts) is not asked. And
// allowed before the account has agreed to the site's current terms (terms: "open", as the
// sign-outs are): taking one's data away needs no agreement. A disabled account has no session.
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
import { closing, deletingAccount } from "./billing.ts";
import { constantTimeEqual, requireAuth, type Auth } from "./auth.ts";
import { SUBREQUEST_BUDGET } from "./budget.ts";
import { apiError, json } from "./http.ts";
import { normaliseHost, originOf } from "./hosts.ts";
import { mediaLink, objectKey } from "./media.ts";
import { MalformedSnapshot, escapeHtml, pageTour, scriptJson, type PageData, type PageTour } from "./page.ts";
import { PLAYER_CSS, PLAYER_JS } from "./player/assets.ts";
import { isNotNullViolation, isUniqueViolation, type Config, type Deps, type FileStore } from "./ports.ts";
import { buildSnapshot, type DraftRow, type DraftTour, type Snapshot } from "./publish.ts";
import { EXPORT_RUNNING_BUCKET, LIMITS_EXPORT, hitLimit, workspaceKey } from "./rate.ts";
import { readSessionCookie } from "./sessions.ts";
import { withHeader } from "./signin.ts";
import { zipStream, type ZipEntry } from "./zip.ts";

/** How long the address POST answers can be opened: the page opens it at once. */
export const TICKET_MS = 60_000;
/** A download whose reader takes no bytes for this long is stopped, and its row released. */
export const EXPORT_IDLE_MS = 5 * 60_000;
/** The longest a download may go on, however fast its reader takes bytes; then it is stopped and its row released. */
export const EXPORT_MAX_MS = 6 * 3_600_000;
/**
 * How long a download that was started counts as running when nothing ended it (a server that
 * stopped while sending): after this a new one may start. As long as the longest download may
 * go on, so two can never run at once. A download that ends, fails, stops or is cancelled lets
 * the next one start at once.
 */
export const RUNNING_MS = EXPORT_MAX_MS;
/** What a refused ticket answers, as plain text: the dashboard's own failure sentence (src/dash/script.ts, TEXT.failed). */
export const FAILURE_SENTENCE = "Something went wrong. Try again in a moment.";
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

/**
 * The answer to a ticket that cannot be followed: the failure sentence as plain text, with no
 * Content-Disposition, so the browser that opened it shows it as a page and saves no file.
 */
function refusedPage(status: 404 | 409 | 500): Response {
  return new Response(FAILURE_SENTENCE, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "referrer-policy": "no-referrer",
    },
  });
}
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
  + (SELECT count(*) FROM tour t JOIN p ON t.workspace_id = p.ws WHERE t.logo_key IS NOT NULL AND t.logo_type IS NOT NULL)
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
export type Listing = {
  account: { email: string; username: string | null } | null;
  workspace: string | null;
  tours: TourRow[];
  chapters: ChapterRow[];
  steps: StepRow[];
  media: MediaRow[];
};

/** The rows of a download, or the count of files when it is over the limit. */
export async function readListing(deps: Deps, auth: Auth, limit: number | null): Promise<{ files: number; listing: Listing | null }> {
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
/**
 * One file of the zip, in its order: a tour's page, which is built only when the zip reaches it
 * (from its data, a few kilobytes, not the page of some 80 KB), a small text, or a stored file.
 */
type PlannedFile =
  | { kind: "page"; path: string; tour: PageTour; modified: number | null }
  | { kind: "text"; path: string; text: string; modified: number | null }
  | ({ kind: "stored" } & StoredItem);
export type Plan = {
  exportedAt: number;
  account: { email: string; username: string | null };
  workspace: string;
  tours: TourOut[];
  images: MediaOut[];
  clips: MediaOut[];
  files: PlannedFile[];
};

/** Viewers only for "people": "public" and "me" have no list. Sorted, so the lists read the same each time. */
const viewersOf = (access: string, viewers: unknown): string[] => (access === "people" && Array.isArray(viewers) ? viewers.filter((v): v is string => typeof v === "string").sort() : []);

/**
 * A tour's public address, from the configuration alone, as a shared item's is (mediaLink): the
 * tours address, else SITE_HOST, else no host, and the link is then the path the API answers.
 * Nothing of the request is read.
 */
function tourLink(config: Config, slug: string): string {
  const hosts = config.hosts ?? null;
  const site = typeof config.siteHost === "string" ? normaliseHost(config.siteHost) : null;
  const origin = hosts !== null ? originOf(hosts.tours) : site !== null ? originOf(site) : "";
  return `${origin}/t/${slug}`;
}

/**
 * The tour's draft as the publish would build it, with the zip's own picture names in place of
 * live keys: the data the page is built from (null when the page cannot show it), the readable
 * data, the stored files, and the steps and chapters the page shows. A logo of no known type is
 * no file.
 */
function tourFiles(t: TourRow, chapters: ChapterRow[], steps: StepRow[], folder: string): { page: PageTour | null; readable: unknown; stored: StoredItem[]; steps: number; chapters: number } {
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
  let page: PageTour | null = null;
  try {
    page = pageTour(offline);
  } catch (err) {
    // A draft the page cannot show (the public page answers 404 for such a snapshot) still has its data and pictures.
    if (!(err instanceof MalformedSnapshot)) throw err;
  }
  return { page, readable, stored, steps: offline.chapters.reduce((k, c) => k + c.steps.length, 0), chapters: offline.chapters.length };
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

/** What the zip holds and in which order, and what the lists say; no page is built here. */
export function planOf(config: Config, listing: Listing, now: number): Plan {
  // Oldest first; made at the same moment, by title, then by id, so the same data always gives the same names.
  // Images before clips, as the zip's folders are.
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  const byAge = (a: { created_at: number; id: string; title: string | null; kind?: string }, b: { created_at: number; id: string; title: string | null; kind?: string }) =>
    (a.kind === "clip" ? 1 : 0) - (b.kind === "clip" ? 1 : 0) || a.created_at - b.created_at || cmp(a.title ?? "", b.title ?? "") || cmp(a.id, b.id);
  const files: PlannedFile[] = [];
  const tours: TourOut[] = [];
  const folders = new Set<string>();
  for (const t of [...listing.tours].sort(byAge)) {
    const folder = safeName(t.title, "tour", folders);
    const made = tourFiles(
      t,
      listing.chapters.filter((c) => c.tour_id === t.id),
      listing.steps.filter((s) => s.tour_id === t.id),
      folder,
    );
    if (made.page !== null) files.push({ kind: "page", path: `tours/${folder}/index.html`, tour: made.page, modified: t.updated_at });
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
      link: published ? tourLink(config, t.slug) : null,
      sharing: t.access,
      viewers: viewersOf(t.access, t.viewers),
      chapters: made.chapters,
      steps: made.steps,
      bytes: made.stored.reduce((k, s) => k + s.bytes, 0),
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
    const whole = parts.length === m.parts && parts.every((p, i) => p[0] === i) && parts.reduce((k, p) => k + p[2], 0) === m.bytes;
    if (whole) files.push({ kind: "stored", path: file, keys: parts.map((p) => objectKey(m.id, { n: p[0], claim: p[1], ext: null })), bytes: m.bytes, modified: m.online_at ?? m.created_at });
    const out: MediaOut = {
      title: m.title,
      file,
      created_at: iso(m.created_at),
      shared_at: iso(m.online_at ?? m.created_at),
      sharing: m.access,
      viewers: viewersOf(m.access, m.viewers),
      link: mediaLink(config, { kind: m.kind, link_id: m.link_id }),
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

/**
 * Every sentence of README.txt, in one place, so the wording can change in one edit. Each
 * function puts the values of one line in place; the text around them is fixed.
 */
export const README_WORDS = {
  title: "Your data",
  savedOn: (when: string) => `Saved on ${when} UTC.`,
  account: (email: string, username: string | null) => `Account: ${email}${username === null ? "" : ` (username ${username})`}`,
  workspace: (name: string) => `Workspace: ${name}`,
  whatIsInIt: "What is in this file",
  aboutTours:
    "- tours: one folder for each tour. Open index.html in a tour's folder to click through the tour in your browser. It needs no internet connection. tour.json holds the tour's chapters, steps and settings, and the pictures folder its pictures.",
  aboutImages: "- images: your shared images.",
  aboutClips: "- clips: your shared GIFs and clips.",
  aboutList: "- account.json: this same list, for programs.",
  tours: (n: number) => `Tours (${n})`,
  images: (n: number) => `Images (${n})`,
  clips: (n: number) => `Clips (${n})`,
  none: "None.",
  folder: (path: string) => `  Folder: ${path}`,
  made: (made: string, changed: string) => `  Made ${made}, last changed ${changed}`,
  publishedYes: (on: string, link: string) => `  Published: yes, on ${on}, at ${link}`,
  publishedNo: "  Published: no",
  sharedWith: (who: string, viewers: string[]) => `  Shared with: ${who}${viewers.length > 0 ? ` (${viewers.join(", ")})` : ""}`,
  sharing: { public: "anyone with the link", people: "only the people listed", me: "only you" } as Record<string, string>,
  counts: (chapters: number, steps: number, bytes: number) => `  ${chapters} chapter${chapters === 1 ? "" : "s"}, ${steps} step${steps === 1 ? "" : "s"}, ${bytes} bytes`,
  noPage: "  This tour could not be made into a page; its data and pictures are in its folder.",
  noTitle: "(no title)",
  file: (path: string) => `  File: ${path}`,
  shared: (on: string, link: string) => `  Shared ${on}, at ${link}`,
  size: (width: number, height: number, bytes: number) => `  ${width} x ${height} pixels, ${bytes} bytes`,
  notIncluded: "Not included",
  missing: "the file could not be read",
  incomplete: "only part of the file could be read",
  unknownDay: "unknown",
};

/** One line of user text in README.txt: no control, format, line or paragraph separator character. */
const oneLine = (s: string) => s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();
const day = (s: string | null) => (s === null ? README_WORDS.unknownDay : s.slice(0, 10));

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
    not_included: [...missing].map(([path, why]) => ({ path, reason: README_WORDS[why] })),
  };
  return JSON.stringify(out, null, 2) + "\n";
}

function readme(plan: Plan, missing: Missing): string {
  const W = README_WORDS;
  const lines: string[] = [];
  const add = (...l: string[]) => lines.push(...l);
  add(W.title, "", W.savedOn(iso(plan.exportedAt)!.replace("T", " ").slice(0, 16)), "");
  add(W.account(oneLine(plan.account.email), plan.account.username === null ? null : oneLine(plan.account.username)));
  add(W.workspace(oneLine(plan.workspace)), "");
  add(W.whatIsInIt, "");
  add(W.aboutTours);
  add(W.aboutImages);
  add(W.aboutClips);
  add(W.aboutList, "");
  add(W.tours(plan.tours.length), "");
  if (plan.tours.length === 0) add(W.none, "");
  for (const t of plan.tours) {
    add(oneLine(t.title));
    add(W.folder(t.folder));
    add(W.made(day(t.created_at), day(t.updated_at)));
    add(t.published ? W.publishedYes(day(t.published_at), t.link ?? "") : W.publishedNo);
    add(W.sharedWith(W.sharing[t.sharing], t.viewers));
    add(W.counts(t.chapters, t.steps, t.bytes));
    if (!t.page) add(W.noPage);
    add("");
  }
  for (const [heading, list] of [
    [W.images, plan.images],
    [W.clips, plan.clips],
  ] as const) {
    add(heading(list.length), "");
    if (list.length === 0) add(W.none, "");
    for (const m of list) {
      add(m.title === null ? W.noTitle : oneLine(m.title));
      add(W.file(m.file));
      add(W.shared(day(m.shared_at), m.link));
      add(W.sharedWith(W.sharing[m.sharing], m.viewers));
      add(W.size(m.width, m.height, m.bytes), "");
    }
  }
  if (missing.size > 0) {
    add(W.notIncluded, "");
    for (const [path, why] of missing) add(`- ${path}: ${W[why]}`);
    add("");
  }
  return lines.join("\r\n");
}

/**
 * The zip's files, in the plan's order, each opened only when the zip reaches it: a tour's page
 * is built then (by `render`) and dropped once written, a stored file is read part by part, and
 * the two lists come last, so they can name a file that could not be read. So memory holds
 * about one page and one part at a time, however many tours there are.
 */
export async function* exportEntries(plan: Plan, store: FileStore, missing: Missing, now: number, render: (tour: PageTour) => Promise<string> = offlinePageHtml): AsyncGenerator<ZipEntry> {
  const encode = (s: string) => new TextEncoder().encode(s);
  for (const f of plan.files) {
    if (f.kind === "page") {
      yield { name: f.path, modified: f.modified, size: 0, open: async () => encode(await render(f.tour)) };
      continue;
    }
    if (f.kind === "text") {
      yield { name: f.path, modified: f.modified, size: 0, open: async () => encode(f.text) };
      continue;
    }
    let short = false;
    yield {
      name: f.path,
      modified: f.modified,
      size: f.bytes,
      open: () => storedBody(store, f, () => (short = true)),
      done: (written) => {
        if (written === null) missing.set(f.path, "missing");
        else if (short || written !== f.bytes) missing.set(f.path, "incomplete");
      },
    };
  }
  yield { name: "README.txt", modified: now, size: 0, open: async () => encode(readme(plan, missing)) };
  yield { name: "account.json", modified: now, size: 0, open: async () => encode(accountJson(plan, missing)) };
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

/**
 * True when the workspace has a download in progress: a ticket asked for in the last TICKET_MS
 * and not opened yet, or a download started in the last RUNNING_MS and not ended. The same row
 * and rule the two routes use. One database call. For the removal sweep, which must not remove
 * a workspace's files while it is downloading them.
 */
export async function exportInProgress(deps: Deps, workspaceId: string, now: number): Promise<boolean> {
  const key = await workspaceKey(workspaceId);
  const row = await deps.db.first<{ one: number }>(`SELECT 1 AS one FROM rate_counter WHERE bucket = ? AND key = ? AND ${LIVE} LIMIT 1`, [EXPORT_RUNNING_BUCKET, key, now - TICKET_MS, now - RUNNING_MS]);
  return row !== null;
}

const ZIP_HEADERS: Record<string, string> = {
  "content-type": "application/zip",
  "content-disposition": `attachment; filename="${EXPORT_FILE_NAME}"`,
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
  "referrer-policy": "no-referrer",
};

/** Every request here takes a browser session alone, and is open before the site's terms are agreed to. */
const SESSION_OPEN = { only: "session", terms: "open" } as const;

export function exportRoutes(app: Hono, deps: Deps): void {
  // Whether a download of the workspace is in progress: 200 {running}. Two calls at most besides the session.
  app.get(EXPORT_PATH, async (c) => {
    const auth = await requireAuth(c.req.raw, deps, SESSION_OPEN);
    if (auth instanceof Response) return auth;
    // 0.1.62: refused while a removal of the workspace is recorded (the checkout route's own check).
    if (await closing(deps, auth.workspaceId, auth.session?.userId ?? "")) return deletingAccount();
    return json(200, { running: await exportInProgress(deps, auth.workspaceId, deps.now()) });
  });

  // Ask for a download. 200 {url}; 409 too_large_to_export (Workers only) or export_busy; 429 rate_limited. At most 5 calls.
  app.post(EXPORT_PATH, async (c) => {
    const auth = await requireAuth(c.req.raw, deps, SESSION_OPEN);
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
            WHERE NOT EXISTS (SELECT 1 FROM rate_counter WHERE bucket = ? AND key = ? AND ${LIVE})
              AND NOT EXISTS (SELECT 1 FROM account_removal r WHERE r.workspace_id = ?)`,
          [EXPORT_RUNNING_BUCKET, key, now, EXPORT_RUNNING_BUCKET, key, now - TICKET_MS, now - RUNNING_MS, auth.workspaceId],
        )
      ).changes;
    } catch (err) {
      // Two asks in the same millisecond: the one that lost is told another is under way.
      if (!isUniqueViolation(err)) throw err;
      taken = 0;
    }
    // Not taken: another download is under way, or (0.1.62) a removal of the workspace is recorded,
    // which only then costs the read that tells them apart.
    if (taken !== 1) return (await closing(deps, auth.workspaceId, auth.session.userId)) ? deletingAccount() : busy();
    return json(200, { url: `${EXPORT_PATH}/${await ticketOf(secret, auth, now)}` });
  });

  // The file. 200 with the zip as a stream; the plain-text refusal (404) for a ticket that is not
  // this session's, used, or older than TICKET_MS, and (409) for a workspace grown past this
  // target's limit. The claim comes first: a request that does not win it makes no other call.
  // Then the rows (one call), the files (one each) and the end (one).
  app.get(`${EXPORT_PATH}/:ticket`, async (c) => {
    // Hono answers a HEAD with this route and drops the body: a HEAD would use the ticket up and
    // hold the row while sending nothing. It is answered as an unknown path, before anything.
    if (c.req.method === "HEAD") return c.json({ error: "not_found" }, 404);
    const auth = await requireAuth(c.req.raw, deps, SESSION_OPEN);
    if (auth instanceof Response) return auth;
    const secret = readSessionCookie(c.req.raw);
    if (auth.session === undefined || secret === null) return json(401, { error: "unauthorized" });
    const ticket = c.req.param("ticket");
    if (!TICKET.test(ticket)) return refusedPage(404);
    const start = Number.parseInt(ticket.slice(0, 12), 16);
    const now = deps.now();
    // Judged before any call: a ticket that is not this session's costs nothing.
    if (!constantTimeEqual(ticket, await ticketOf(secret, auth, start)) || start <= now - TICKET_MS || start > now + TICKET_MS) return refusedPage(404);
    const key = await workspaceKey(auth.workspaceId);
    const release = () => deps.db.run("DELETE FROM rate_counter WHERE bucket = ? AND key = ? AND window_start = ?", [EXPORT_RUNNING_BUCKET, key, start]);

    // The claim: exactly one ready row within its minute becomes running, and only then is the
    // export recorded (the audit row fails the batch unless that one row changed). A ticket
    // used before, at once or later, finds no ready row and is refused here, having read nothing.
    try {
      await deps.db.batch([
        {
          // 0.1.62: never claimed while a removal of the workspace is recorded (no call more).
          sql: `UPDATE rate_counter SET count = ${RUNNING} WHERE bucket = ? AND key = ? AND window_start = ? AND count = ${READY} AND window_start > ?
                  AND NOT EXISTS (SELECT 1 FROM account_removal r WHERE r.workspace_id = ?)`,
          params: [EXPORT_RUNNING_BUCKET, key, start, now - TICKET_MS, auth.workspaceId],
        },
        auditStatement(deps, { event: "data_exported", userId: auth.session.userId, workspaceId: auth.workspaceId }, { onlyAfterOneChange: true }),
      ]);
    } catch (err) {
      if (isNotNullViolation(err)) return refusedPage(404);
      throw err;
    }

    const limit = exportFileLimit(deps);
    let listing: Listing | null;
    try {
      listing = (await readListing(deps, auth, limit)).listing;
    } catch (err) {
      await release().catch(() => {});
      throw err;
    }
    if (listing === null) {
      // Grown past the limit since it was asked for: the row this request holds goes, so the next ask is answered at once.
      await release();
      return refusedPage(409);
    }
    // Planning reads nothing more, but should it ever fail, the row this request holds goes at
    // once (not after RUNNING_MS) and the browser is shown the refusal, never a broken file.
    let plan: Plan;
    try {
      plan = planOf(deps.config, listing, now);
    } catch {
      // Fixed text only: the error could carry anything of the rows.
      console.error("export: a download could not be planned; nothing was sent");
      await release().catch(() => {});
      return refusedPage(500);
    }
    listing = null;

    const zip = zipStream(exportEntries(plan, deps.drafts, new Map(), now)).getReader();
    // The row goes when the zip has been sent, when it fails, when the browser stops taking it,
    // when the browser takes nothing for EXPORT_IDLE_MS, and after EXPORT_MAX_MS whatever happens.
    let ended = false;
    let idle: ReturnType<typeof setTimeout> | null = null;
    let total: ReturnType<typeof setTimeout> | null = null;
    const clear = (t: ReturnType<typeof setTimeout> | null) => {
      if (t !== null) clearTimeout(t);
    };
    let out: ReadableStreamDefaultController<Uint8Array> | null = null;
    const end = async () => {
      if (ended) return;
      ended = true;
      clear(idle);
      clear(total);
      await release().catch(() => console.error("export: the end of a download could not be recorded; the next one may start after six hours"));
    };
    const stop = async () => {
      if (ended) return;
      await zip.cancel().catch(() => {});
      await end();
      try {
        out?.error(new Error("export stopped"));
      } catch {
        // Already closed.
      }
    };
    const waitForReader = () => {
      clear(idle);
      idle = setTimeout(() => void stop(), EXPORT_IDLE_MS);
    };
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          out = controller;
          total = setTimeout(() => void stop(), EXPORT_MAX_MS);
          waitForReader();
        },
        async pull(controller) {
          // The reader wants bytes: it is not idle while the next ones are being read.
          clear(idle);
          let next: Awaited<ReturnType<typeof zip.read>>;
          try {
            next = await zip.read();
          } catch {
            if (ended) return;
            // Fixed text only: the error could carry a key or anything a store put in it.
            console.error("export: a download stopped because a file could not be read");
            await end();
            controller.error(new Error("export failed"));
            return;
          }
          if (ended) return;
          if (next.done) {
            await end();
            controller.close();
          } else {
            controller.enqueue(next.value);
            waitForReader();
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
