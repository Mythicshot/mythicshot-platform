// The pages a visitor of a restricted shared item sees on the media address, their script and
// their two stylesheets, served by src/media-page.ts: the media scope's counterparts of the
// restricted tour's pages (src/view-page.ts), with the same look, the same states, the same
// rules, and words about an image or a clip. Every sentence that differs from an approved tour
// sentence is proposed (CHANGELOG.md, 0.1.47, lists them).
//
// Every page is fixed text: nothing about any item, list or address is in it, not even the
// item's title. What a page shows of the visitor its script asks the API for and sets only
// through textContent. The gate and the not-shared page come in two versions, for an image
// (/i/...) and a clip (/r/...): the word is the address's own letter, never anything read
// from the database.
//
// The pages, told apart by `data-page` as the tour pages are:
// - gate: served at every address of a restricted item (its page, its file, its download and
//   its preview picture) to a browser that has proved no address on the media address. The
//   page it asks for is read from the page's own path, reduced to /i/<link id> or
//   /r/<link id>, never from a query or the fragment.
// - denied: the same addresses, to a browser whose proved address may not view the item.
// - link: /s/view, the page a viewer link for an item opens (the code after `#`, taken out of
//   the address bar before anything else, as on /view).
// - signout: /i/<link id>/signout or /r/<link id>/signout, where "Not you?" under a restricted
//   item leads.
import { SHARED_CSS, VIEW_CSS, VIEW_JS } from "./view-page.ts";

/** The pages' own files, on the media address. */
export const MEDIA_VIEW_JS_PATH = "/s/view.js";
export const MEDIA_VIEW_CSS_PATH = "/s/view.css";
export const MEDIA_SHARED_CSS_PATH = "/s/shared.css";

/** The stylesheets: the tour pages' own, unchanged. */
export const MEDIA_VIEW_CSS = VIEW_CSS;
export const MEDIA_SHARED_CSS = SHARED_CSS;

const HEAD = (title: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>${title}</title>
<link rel="stylesheet" href="${MEDIA_VIEW_CSS_PATH}">
<script src="${MEDIA_VIEW_JS_PATH}" defer></script>
</head>`;

const NOSCRIPT = `<noscript><p class="message">This page needs JavaScript.</p></noscript>`;

type Noun = "image" | "clip";

/** The gate of an image or a clip (the tour gate's words, about the item). */
function gateHtml(noun: Noun): string {
  return `${HEAD("Shared with specific people")}
<body data-page="gate">
<main class="card">
  <p class="brand">Mythicshot</p>
  ${NOSCRIPT}

  <section id="ask" aria-labelledby="h-ask">
    <h1 id="h-ask" tabindex="-1">This ${noun} is shared with specific people</h1>
    <p class="lead">Enter your email address. If the ${noun} is shared with you, we send you a link to open it. There is no password.</p>
    <form id="ask-form" method="post" novalidate>
      <div class="field">
        <label for="email">Email address</label>
        <input id="email" type="email" autocomplete="email" autocapitalize="off" spellcheck="false" maxlength="254" placeholder="you@example.com" aria-describedby="ask-message" required>
      </div>
      <p class="message" id="ask-message" role="status" aria-live="polite"></p>
      <button type="submit" class="primary wide" id="ask-button">Send me a link</button>
    </form>
  </section>

  <section id="sent" aria-labelledby="h-sent" hidden>
    <h1 id="h-sent" tabindex="-1">Check your mail</h1>
    <p class="lead">If this ${noun} is shared with <span class="address" id="sent-to"></span>, a link is on its way. It works once and for 15 minutes.</p>
    <p class="small">Nothing after a few minutes? Look in your spam folder, or check with the person who sent you the ${noun} that they used this address. <a href="" id="again">Try another address</a></p>
  </section>
</main>
</body>
</html>
`;
}

/** The not-shared page of an image or a clip. */
function deniedHtml(noun: Noun): string {
  return `${HEAD("Not shared with you")}
<body data-page="denied">
<main class="card">
  <p class="brand">Mythicshot</p>
  ${NOSCRIPT}

  <section id="opening" aria-labelledby="h-opening" hidden>
    <h1 id="h-opening" tabindex="-1">This ${noun} is not shared with you</h1>
    <p class="message" id="opening-message" role="status" aria-live="polite"></p>
    <button type="button" class="primary wide" id="opening-button" hidden>Try again</button>
  </section>

  <section id="denied" aria-labelledby="h-denied" hidden>
    <h1 id="h-denied" tabindex="-1">This ${noun} is not shared with you</h1>
    <p class="lead">You are viewing as <span class="address" id="denied-email"></span>, and this ${noun} is shared with other people. If you were given this link, ask the person who sent it to add your address.</p>
    <p class="message" id="denied-message" role="status" aria-live="polite"></p>
    <button type="button" class="quiet wide" id="denied-button">Use another address</button>
  </section>
</main>
</body>
</html>
`;
}

export const MEDIA_GATE_HTML: Readonly<Record<Noun, string>> = { image: gateHtml("image"), clip: gateHtml("clip") };
export const MEDIA_DENIED_HTML: Readonly<Record<Noun, string>> = { image: deniedHtml("image"), clip: deniedHtml("clip") };

/** The page a viewer link for an item opens, /s/view#dpi_<40 hex>. */
export const MEDIA_LINK_HTML = `${HEAD("Open the image or clip")}
<body data-page="link">
<main class="card">
  <p class="brand">Mythicshot</p>
  ${NOSCRIPT}

  <section id="opening" aria-labelledby="h-opening" hidden>
    <h1 id="h-opening" tabindex="-1">Opening your link</h1>
    <p class="message" id="opening-message" role="status" aria-live="polite"></p>
    <button type="button" class="primary wide" id="opening-button" hidden>Try again</button>
  </section>

  <section id="open" aria-labelledby="h-open" hidden>
    <h1 id="h-open" tabindex="-1">Open the image or clip</h1>
    <p class="lead">Press the button to view it in this browser as <strong class="address invited" id="open-email"></strong>.</p>
    <p class="message" id="open-message" role="status" aria-live="polite"></p>
    <button type="button" class="primary wide" id="open-button">Open it</button>
    <p class="small">This browser will remember your address for images and clips shared with you, for 30 days of use. It gives no access to anything else.</p>
  </section>

  <section id="dead" aria-labelledby="h-dead" hidden>
    <h1 id="h-dead" tabindex="-1">This link no longer works</h1>
    <p class="lead">A link works once and for 15 minutes. Open the link you were sent for the image or clip again and ask for a new one.</p>
    <p class="small">If you reloaded this page, open the link in your mail again.</p>
  </section>
</main>
</body>
</html>
`;

/** Where "Not you?" under a restricted item leads: the sign-out of the media address, on a press. */
export const MEDIA_SIGNOUT_HTML = `${HEAD("Not you?")}
<body data-page="signout">
<main class="card">
  <p class="brand">Mythicshot</p>
  ${NOSCRIPT}

  <section id="signout" aria-labelledby="h-signout">
    <h1 id="h-signout" tabindex="-1">Not you?</h1>
    <p class="lead">Sign this browser out of images and clips shared with you, then enter your own address on the page you were sent.</p>
    <p class="message" id="signout-message" role="status" aria-live="polite"></p>
    <button type="button" class="primary wide" id="signout-button">Use another address</button>
  </section>
</main>
</body>
</html>
`;

/**
 * Replaces each `from` in `text` by its `to`, where `from` must be found exactly `times` times:
 * the media script is the tour script with these changes and no others, and a tour script that
 * no longer has one of these places fails here, when the module loads, never in a browser.
 */
function substituted(text: string, changes: readonly { from: string; to: string; times: number }[]): string {
  let out = text;
  for (const c of changes) {
    const found = out.split(c.from).length - 1;
    if (found !== c.times) throw new Error(`media-view-page: the viewer script changed (${found} of ${c.times})`);
    out = out.split(c.from).join(c.to);
  }
  return out;
}

/**
 * The script of the media pages: the tour pages' script (VIEW_JS), with
 * - the media scope's code ("dpi_") on the link page;
 * - the media scope's API (/api/v1/media-view/...);
 * - the target an item's page path, /i/<link id> or /r/<link id>, taken from the page's own
 *   path with any file, download, preview or sign-out ending removed, sent as `path`, and
 *   landed on as it is (a tour lands on /t/<slug>).
 */
export const MEDIA_VIEW_JS = substituted(VIEW_JS, [
  { from: "/^#(dpv_[0-9a-f]{40})$/", to: "/^#(dpi_[0-9a-f]{40})$/", times: 1 },
  { from: '"/api/v1/view/', to: '"/api/v1/media-view/', times: 5 },
  { from: "var SLUG = /^[a-z2-7]{10}$/;", to: "var SLUG = /^\\/[ir]\\/[a-z2-7]{20}$/;", times: 1 },
  {
    from: `  function slugOfPath(prefix) {
    var path = location.pathname;
    if (path.indexOf(prefix) !== 0) return "";
    var slug = path.slice(prefix.length);
    return SLUG.test(slug) ? slug : "";
  }`,
    to: `  function slugOfPath(prefix) {
    var m = /^(\\/[ir]\\/[a-z2-7]{20})(?:\\.(?:png|jpg|gif|mp4)|\\/download|\\/preview|\\/signout)?$/.exec(location.pathname);
    return m === null ? "" : m[1];
  }`,
    times: 1,
  },
  { from: 'location.replace("/t/" + slug);', to: "location.replace(slug);", times: 2 },
  { from: 'location.replace("/t/" + d.slug);', to: "location.replace(d.path);", times: 1 },
  { from: "{ email: value, slug: slug }", to: "{ email: value, path: slug }", times: 1 },
  { from: "d.slug", to: "d.path", times: 4 },
]);
