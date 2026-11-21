// Serving a restricted tour (setting `people` or `me`, src/access.ts) on the tours address:
// its page, its pictures, the pages around them (src/view-page.ts), and the gate that decides
// who may ask for a viewer link (src/viewers.ts).
//
// The rule: nothing of a restricted tour (its page, title, text, any picture, its logo)
// reaches a browser that has not proved an address the tour may be viewed by. Every request
// checks again, from the database, in this order: the tour (tourForServing, one call), the
// proved address (provedEmail, one call when a viewer cookie is sent), whether that address
// may view the tour now (mayView, one call, fresh every time). A viewer session alone opens
// nothing: removing the address from the list, switching the tour to `me`, unpublishing it,
// disabling its workspace or starting a move of its pictures closes it on the very next page
// or picture request. Nothing a restricted tour answers is cacheable (`private, no-store`)
// and nothing carries an ETag, so no cache and no 304 can answer without those checks.
//
// The tour page, GET /t/<slug> (src/page.ts), makes its one public lookup first, exactly as
// before; only when that finds nothing does it ask `restrictedAnswer` here, which answers:
// - the tour page, for a browser whose proved address may view the tour: built from the real
//   snapshot by pageTour, as a public page is, with its pictures at /t/<slug>/v/<name> on this
//   origin (never the public image base), framing denied, no referrer, and the public page's
//   policy with images from this origin alone. It has no `connect-src`: the page carries
//   customer-written text, and nothing on it may call the API. Under the tour, one line written
//   here, as escaped text: "Shared with you, <address> · Not you?", where "Not you?" is a
//   plain link to /view/signout/<slug>, a page that holds no customer content and signs the
//   browser out on a press there (src/view-page.ts). So no script of the tour page needs or
//   gets a way to read the address or reach the API: the address is text the server wrote, the
//   viewer cookie is HttpOnly, and the policy allows no script but the player's own file.
// - the gate (mockup 4), for a browser that has proved no address: a cookie that is missing,
//   expired, signed out, malformed or sent beside a token proves none. It says that a
//   restricted tour exists at this link, and nothing about its list.
// - the "not shared with you" page (mockup 6), for a browser whose proved address may not view
//   it. Both pages answer 403 and are fixed text: neither holds the tour's title or anything
//   else of it.
// - null, which the page answers with its one not-found page, byte for byte the answer for an
//   unknown slug: for a tour that is not published, is of a disabled workspace, is in the
//   middle of a move of its pictures (either way), or whose snapshot cannot be served.
//
// Calls: the public lookup, the tour, and, with a viewer cookie, the session and mayView:
// at most 4, and one more after the answer at most once a day (the session's last use).
import type { Hono } from "hono";
import { mayView, tourForServing, type ServedPicture, type ServedTour } from "./access.ts";
import { hashToken } from "./auth.ts";
import { json } from "./http.ts";
import { MalformedSnapshot, contentSecurityPolicy, escapeHtml, pageHtml, pageTour, type PageTour } from "./page.ts";
import { ACCOUNT_PAGE_HEADERS } from "./pages.ts";
import type { Deps } from "./ports.ts";
import { SHARED_CSS, VIEW_CSS, VIEW_DENIED_HTML, VIEW_GATE_HTML, VIEW_JS, VIEW_LINK_HTML, VIEW_SIGNOUT_HTML } from "./view-page.ts";
import { provedEmail, useViewerGate, type ViewerGate } from "./viewers.ts";

const SLUG = /^[a-z2-7]{10}$/;
/** The name of a restricted tour's picture after `v/`, as tourForServing's map keys it. */
const PICTURE_NAME = /^[0-9a-f]{32}\.(?:png|jpg)$/;
/** A snapshot's picture field on a restricted tour: `v/` and a name. */
const PICTURE_FIELD = /^v\/([0-9a-f]{32}\.(?:png|jpg))$/;
/**
 * What the gate asks about when the slug it is given is malformed (tourForServing asks nothing
 * about a malformed slug): a slug of the right shape, so the statement is the very one any
 * other question makes. Whatever it finds is never used.
 */
const STAND_IN_SLUG = "aaaaaaaaaa";
/** A tour id of the right shape that no tour has (newId draws 96 random bits; this one is all zeros), for mayView when there is no tour. */
const NO_TOUR = { id: "tour_" + "0".repeat(24) };

/** What a restricted tour's page and pictures answer with, and the not-shared and gate pages too: never kept by any cache. */
export const RESTRICTED_CACHE = "private, no-store";

/** The restricted tour page's policy: the public page's, with images from this origin alone and no framing anywhere. */
export const RESTRICTED_PAGE_CSP = `${contentSecurityPolicy("")}; frame-ancestors 'none'`;

/** The words of the one line under a restricted tour (mockup 7). */
export const SHARED_LINE = { before: "Shared with you, ", notYou: "Not you?" } as const;

/** A restricted tour that may be served at all: published, of an enabled workspace, not moving, with its real text and its live private pictures. */
export type ServableTour = ServedTour & { data: string; pictures: ReadonlyMap<string, ServedPicture> };

/** True for a tour this module may serve to an address that may view it. Everything else answers as an unknown tour. */
export function servable(tour: ServedTour | null): tour is ServableTour {
  return tour !== null && tour.published && tour.enabled && !tour.switching && tour.access !== "public" && tour.data !== null && tour.pictures !== null && tour.pictures.size > 0;
}

/**
 * The opaque key the gate gives for a tour's workspace: a digest of its id with a label of its
 * own, never the id. Made for every question (of "" when there is no tour), so a yes takes no
 * time a no does not.
 */
export async function workspaceKeyOf(workspaceId: string): Promise<string> {
  return hashToken("restricted-tour-workspace:" + workspaceId);
}

/**
 * The gate src/viewers.ts asks before it mails a viewer link (ViewerGate). Yes only for a
 * tour this module serves (`servable`) and an address mayView allows. Every question makes
 * exactly the same two statements in the same order, whatever it answers: the tour by slug
 * (STAND_IN_SLUG when the slug is malformed), and mayView (for the all-zero id when there is
 * no tour, with "" for a malformed address, which proves nothing). Then one digest.
 */
export const RESTRICTED_GATE: ViewerGate = {
  async mayRequest(deps, slug, email) {
    const wellFormed = typeof slug === "string" && SLUG.test(slug);
    const found = await tourForServing(deps, { slug: wellFormed ? slug : STAND_IN_SLUG });
    const tour = wellFormed ? found : null;
    const may = await mayView(deps, tour ?? NO_TOUR, typeof email === "string" ? email : "");
    const workspaceKey = await workspaceKeyOf(tour?.workspaceId ?? "");
    return servable(tour) && may ? { allowed: true, workspaceKey } : { allowed: false };
  },
};

// Wired once, when this module is loaded (src/app.ts imports it): from then on every viewer
// link request asks this gate.
useViewerGate(RESTRICTED_GATE);

/**
 * The page's copy of a restricted tour's snapshot (pageTour), after a check that every
 * picture it names (each step's image, the cover's logo) is one of the tour's live private
 * pictures. Throws MalformedSnapshot otherwise, which answers as an unknown tour.
 */
export function restrictedTour(tour: ServableTour): PageTour {
  let parsed: unknown;
  try {
    parsed = JSON.parse(tour.data);
  } catch {
    throw new MalformedSnapshot();
  }
  const page = pageTour(parsed);
  const live = (field: string) => {
    const m = PICTURE_FIELD.exec(field);
    if (m === null || !tour.pictures.has(m[1])) throw new MalformedSnapshot();
  };
  for (const chapter of page.chapters) for (const step of chapter.steps) live(step.image);
  if (page.cover !== null && page.cover.logo !== null) live(page.cover.logo);
  return page;
}

/** The restricted tour's page: the public page's document, its pictures under the tour's own path, and the one line under it. */
export function restrictedPageHtml(tour: PageTour, slug: string, email: string): string {
  if (!SLUG.test(slug)) throw new Error("not a slug");
  return pageHtml(tour, `/t/${slug}`, {
    head: `<link rel="stylesheet" href="/view/shared.css">\n`,
    afterMain: `<p class="dp-shared">${escapeHtml(SHARED_LINE.before)}${escapeHtml(email)} · <a href="/view/signout/${slug}">${escapeHtml(SHARED_LINE.notYou)}</a></p>\n`,
  });
}

/** The headers of the restricted tour page. */
export const RESTRICTED_PAGE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": RESTRICTED_PAGE_CSP,
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "cache-control": RESTRICTED_CACHE,
};

const HTML = "text/html; charset=utf-8";

/** A platform page of src/view-page.ts: the sign-in pages' headers (strict policy, no framing, no-store). */
function platformPage(body: string, status = 200, type = HTML): Response {
  return new Response(body, { status, headers: { ...ACCOUNT_PAGE_HEADERS, "content-type": type } });
}

/**
 * What GET /t/<slug> answers when its public lookup found nothing (see the top of this
 * file); null for the not-found page. `slug` is the route's, already reduced to "" when it is
 * malformed (then no call is made).
 */
export async function restrictedAnswer(req: Request, deps: Deps, slug: string): Promise<Response | null> {
  const tour = await tourForServing(deps, { slug });
  if (!servable(tour)) return null;
  // Built before anything about the visitor is read, so a snapshot that cannot be served
  // answers not found to everyone alike.
  let page: PageTour;
  try {
    page = restrictedTour(tour);
  } catch (err) {
    if (!(err instanceof MalformedSnapshot)) throw err;
    console.error("restricted: a published snapshot cannot be served; answering 404");
    return null;
  }
  const email = await provedEmail(req, deps);
  if (email === null) return platformPage(VIEW_GATE_HTML, 403);
  if (!(await mayView(deps, tour, email))) return platformPage(VIEW_DENIED_HTML, 403);
  return new Response(restrictedPageHtml(page, tour.slug, email), { status: 200, headers: RESTRICTED_PAGE_HEADERS });
}

/** The one answer of the picture route for anything it does not serve: the picture route's (/p/) own 404. */
const missing = () => json(404, { error: "not_found" });

export function restrictedRoutes(app: Hono, deps: Deps): void {
  // A restricted tour's picture or logo. Checked in this order, each failure the same 404 and
  // nothing ever read from the store first: the name's shape (no call); the tour (one call),
  // which must be servable and whose LIVE snapshot must hold the picture by that name (from
  // tourForServing's map, never a key made from the request); the proved address (one call);
  // mayView (one call); then the one read of the private store. 4 calls, and one more after
  // the answer at most once a day. No Range (the whole picture is always a correct answer),
  // no ETag, and no-store, so an address removed from the list loses the pictures it has
  // seen at its next request.
  app.get("/t/:slug/v/:name", async (c) => {
    const name = c.req.param("name");
    if (!PICTURE_NAME.test(name)) return missing();
    const tour = await tourForServing(deps, { slug: c.req.param("slug") });
    if (!servable(tour)) return missing();
    const picture = tour.pictures.get(name);
    if (picture === undefined) return missing();
    const email = await provedEmail(c.req.raw, deps);
    if (email === null || !(await mayView(deps, tour, email))) return missing();
    const file = await deps.drafts.get(picture.key);
    if (file === null) return missing();
    return new Response(file.body, {
      status: 200,
      headers: {
        "content-type": picture.contentType,
        "content-length": String(file.size),
        "cache-control": RESTRICTED_CACHE,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "referrer-policy": "no-referrer",
        "cross-origin-resource-policy": "same-origin",
      },
    });
  });

  // The page a viewer link opens, the sign-out page "Not you?" leads to, and the two
  // stylesheets and one script of these pages. Fixed text, no call.
  app.get("/view", () => platformPage(VIEW_LINK_HTML));
  app.get("/view/signout/:slug", (c) => (SLUG.test(c.req.param("slug")) ? platformPage(VIEW_SIGNOUT_HTML) : c.notFound()));
  app.get("/view/view.js", () => platformPage(VIEW_JS, 200, "text/javascript; charset=utf-8"));
  app.get("/view/view.css", () => platformPage(VIEW_CSS, 200, "text/css; charset=utf-8"));
  app.get("/view/shared.css", () => platformPage(SHARED_CSS, 200, "text/css; charset=utf-8"));
}
