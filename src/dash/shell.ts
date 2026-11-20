// The dashboard's shell: the one document every dashboard page is, with the top bar
// (the brand, the tabs and the username) and the page's own body. The shared stylesheet
// and script are src/dash/style.ts and src/dash/script.ts; src/dash/routes.ts serves them.
//
// How a later page joins the dashboard (Storage, Account and Admin are planned):
//
// 1. Its body and its script live in a module of its own under src/dash/, as the Tours
//    page does in src/dash/tours.ts: the body as an HTML string (fixed text only, no data),
//    the script as a string, and the page as
//      dashHtml({ title: "Storage", active: "storage", main: STORAGE_MAIN, script: "/dash/storage.js" })
//    `active` marks that page's tab. `script` is served after the shared /dash/dash.js,
//    both with `defer`, so the page's script runs once the shared one has defined `Dash`.
// 2. The page's script starts with Dash.start(function (who) { ... }). Dash.start asks
//    GET /api/v1/session, sends a visitor who is not signed in to /signin, fills the
//    username and shows the Admin tab for an admin, and only then calls the function with
//    { username, admin, workspace }. Inside it, Dash.api(method, path, body) sends every
//    request (the session cookie, and the X-Csrf-Token header on every change),
//    Dash.formatBytes and Dash.dateOf write sizes and dates as every page does, and
//    Dash.failure(res) is the approved sentence for a failed request. Data reaches the page
//    only through textContent and safe attributes.
// 3. Its route goes into DASH_PAGES in src/dash/routes.ts, one line: the path, the HTML
//    and the script's path and text. That serves both with ACCOUNT_PAGE_HEADERS and no
//    database call. Its styles go into src/dash/style.ts, after the shared ones.
// 4. Each of its two routes needs a line in HOST_RULES (src/host-gate.ts, "app"), in ROWS
//    (test/hosts.test.ts), in OPEN (test/isolation.test.ts) and in UNDOCUMENTED_ROUTES
//    (src/docs/openapi.ts), and its words are pinned in a test as test/dash.test.ts does.
//
// The tabs are fixed here, in this order: Tours, Storage, Account, Admin. Images and GIFs
// come with a later plan and are not shown until then. The Admin tab is in every page,
// hidden; only the shared script shows it, and only when the session says the person is
// an admin. Nothing about anyone is in the document: the username, too, is filled in by
// the shared script through textContent.
import { escapeHtml } from "../signin/invite.ts";

/** The tabs of this version, in order: what each is called and where it leads. */
export const DASH_TABS = [
  { key: "tours", label: "Tours", href: "/tours" },
  { key: "storage", label: "Storage", href: "/storage" },
  { key: "account", label: "Account", href: "/account" },
  { key: "admin", label: "Admin", href: "/admin" },
] as const;

export type DashTab = (typeof DASH_TABS)[number]["key"];

/** The path of a page's own script: under /dash/, lower-case letters and hyphens. */
const SCRIPT_PATH = /^\/dash\/[a-z][a-z-]*\.js$/;

/**
 * The whole document of one dashboard page. `title` is the document's title (escaped);
 * `main` is the page's own body, fixed HTML from its module; `script` is the path of the
 * page's own script, loaded after the shared one.
 */
export function dashHtml(opts: { title: string; active: DashTab; main: string; script: string }): string {
  if (!SCRIPT_PATH.test(opts.script) || opts.script === "/dash/dash.js") throw new Error("a dashboard page's script is its own file under /dash/");
  if (!DASH_TABS.some((t) => t.key === opts.active)) throw new Error("no such tab");
  const tabs = DASH_TABS.map((t) => {
    const current = t.key === opts.active ? ' aria-current="page"' : "";
    // The Admin tab is shown by the shared script, for an admin only.
    const admin = t.key === "admin" ? ' id="tab-admin" hidden' : "";
    return `<a href="${t.href}"${admin}${current}>${t.label}</a>`;
  }).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(opts.title)}</title>
<link rel="stylesheet" href="/dash/dash.css">
<script src="/dash/dash.js" defer></script>
<script src="${opts.script}" defer></script>
</head>
<body data-page="${opts.active}">
<header class="top">
  <p class="brand">Mythicshot</p>
  <nav class="nav">${tabs}</nav>
  <p class="who" id="dash-user"></p>
</header>
<main class="page">
  <noscript><p class="message">This page needs JavaScript.</p></noscript>
  <p class="load" id="dash-load" role="status" aria-live="polite"></p>
${opts.main}
</main>
</body>
</html>
`;
}
