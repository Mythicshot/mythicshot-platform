// The terms screen, /terms, and the read-only terms, /terms?read, on the app address, as in
// the owner's approved mockup: a centred card on its own page with "Before you start", the
// terms' title, "The main points" and their list, the sentence that the list is a summary,
// "The full terms" with "· version of <label>", the full terms in a bordered box of fixed
// height that scrolls on its own, an optional line of links, and at the bottom right
// "Sign out" and "I agree". The read-only page is the same card without the buttons, opened
// by "Read them" on the Account page.
//
// Above the card, the product's brand as every dashboard page has it (BRAND_PLAIN,
// src/brand.ts): the mark and the name, one link to the site's home page when HOME_URL is set,
// swapped in by the route (withHome). Below the card, the source line every dashboard page has
// (SOURCE_FOOTER, src/source.ts), with the SOURCE_URL setting's address (withSource). Both are one document, fixed text with no data, served with the sign-in pages' headers and
// no database call (src/dash/routes.ts), like every dashboard page; its styles are in the
// dashboard's stylesheet (src/dash/style.ts, "The terms screen"). Its one script,
// /dash/terms.js, asks GET /api/v1/terms (or GET /api/v1/terms/agreed) and builds every text
// of the terms with createElement and textContent alone: a title, a point, a heading, a
// paragraph or a link's label can never become markup, whatever the file held. A link's href
// is set only to an address of the strict https shape (STRICT_HTTPS_SHAPE, checked by the
// server when the terms were published and again when they are answered, and once more here),
// in a new tab with no opener and no referrer.
//
// Like the sign-in pages and the dashboard, the pages need JavaScript: the content security
// policy (form-action 'none') lets no form be sent, and "I agree" is a session request that
// carries the anti-forgery header. Without JavaScript the page says so.
//
// Where a person goes after "I agree": the dashboard page that sent them here, named in
// ?next= by the shared script (src/dash/script.ts), only when it is one of the dashboard's own
// tabs (DASH_TABS); anything else is the Tours page.
import { BRAND_PLAIN, FAVICON_LINKS } from "../brand.ts";
import { SOURCE_FOOTER } from "../source.ts";
import { STRICT_HTTPS_SHAPE } from "../https-address.ts";
import { DASH_TABS } from "./shell.ts";

/**
 * Every sentence the two pages show, each pinned by test/dash-terms.test.ts. Those of the
 * approved mockup first; the rest are new wording awaiting the owner's approval.
 */
export const TERMS_SAYS = {
  // From the mockup.
  beforeYouStart: "Before you start",
  mainPoints: "The main points",
  summary: "This list is a summary. The full terms below are what you agree to.",
  fullTerms: "The full terms",
  versionOf: "· version of ",
  signOut: "Sign out",
  agree: "I agree",
  // New wording.
  documentTitle: "Terms",
  openThe: "Open the ",
  asPage: " as a page",
  asPages: " as pages",
  listComma: ", ",
  listAnd: " and ",
  agreedOn: "You agreed to these terms on ",
  agreedOnAfter: ".",
  current: "These are the site's current terms. You have not agreed to a version yet.",
  noTerms: "This site has no terms.",
  back: "Back to your account",
  changed: "The terms changed while you were reading. This is the new version.",
  agreeing: "Saving…",
  signingOut: "Signing out…",
  failed: "Something went wrong. Try again in a moment.",
  needsScript: "This page needs JavaScript.",
} as const;

/**
 * The one document of both pages: the card, its message line, the buttons (shown on the
 * screen) and the way back (shown on the read-only terms). The script shows one of the two.
 */
export const TERMS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>${TERMS_SAYS.documentTitle}</title>
${FAVICON_LINKS}
<link rel="stylesheet" href="/dash/dash.css">
<script src="/dash/terms.js" defer></script>
</head>
<body data-page="terms">
<main class="terms-page">
  ${BRAND_PLAIN}
  <noscript><p class="message">${TERMS_SAYS.needsScript}</p></noscript>
  <p class="load" id="terms-load" role="status" aria-live="polite"></p>
  <section class="card terms-card" id="terms" aria-labelledby="terms-title" hidden>
    <p class="terms-kicker" id="terms-kicker"></p>
    <h1 class="terms-title" id="terms-title" tabindex="-1"></h1>
    <div id="terms-content">
      <h2 class="terms-label" id="h-points">${TERMS_SAYS.mainPoints}</h2>
      <ul class="terms-points" id="terms-points" aria-labelledby="h-points"></ul>
      <p class="terms-note">${TERMS_SAYS.summary}</p>
      <h2 class="terms-label" id="h-full">${TERMS_SAYS.fullTerms} <span class="terms-version" id="terms-version"></span></h2>
      <section class="terms-box" id="terms-box" role="region" tabindex="0" aria-labelledby="h-full"></section>
      <p class="terms-links" id="terms-links" hidden></p>
    </div>
    <p class="message" id="terms-message" role="status" aria-live="polite" hidden></p>
    <div class="terms-actions" id="terms-actions" hidden>
      <button type="button" class="btn quiet" id="terms-signout">${TERMS_SAYS.signOut}</button>
      <button type="button" class="btn" id="terms-agree">${TERMS_SAYS.agree}</button>
    </div>
    <p class="terms-back" id="terms-back" hidden><a href="/account">${TERMS_SAYS.back}</a></p>
  </section>
</main>
${SOURCE_FOOTER}
</body>
</html>
`;

/** The dashboard's own pages a person may be sent back to after agreeing: its tabs, from DASH_TABS. */
const BACK_TO: readonly string[] = DASH_TABS.map((t) => t.href);

export const TERMS_JS = `(function () {
  "use strict";
  var TEXT = ${JSON.stringify(TERMS_SAYS)};
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  // The dashboard's tabs: the only places ?next= may send a person after "I agree".
  var BACK_TO = ${JSON.stringify(BACK_TO)};
  // A link's address must be of the strict https shape (STRICT_HTTPS_SHAPE, src/https-address.ts).
  var LINK = ${STRICT_HTTPS_SHAPE.toString()};
  var TERMS_ID = /^trm_[0-9a-f]{24}$/;
  // /terms?read is the read-only terms; anything else is the screen.
  var READ_ONLY = location.search === "?read";

  var $ = function (id) { return document.getElementById(id); };
  // The session's anti-forgery value, from GET /api/v1/terms, and the id of the version shown.
  var csrf = "";
  var shown = "";
  var working = false;

  // Every request: to this site only, with the session for this address, no referrer, no cache.
  function ask(method, path, body) {
    var headers = {};
    var init = { method: method, headers: headers, credentials: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    if (method !== "GET") headers["X-Csrf-Token"] = csrf;
    return fetch(path, init).then(function (r) {
      return r.text().then(function (t) {
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
        return { status: r.status, data: data };
      });
    });
  }

  function errorOf(res) {
    return res !== null && res.data !== null && typeof res.data === "object" && typeof res.data.error === "string" ? res.data.error : "";
  }

  // Day, short month and year, as the dashboard writes a date with its year.
  function dateOf(ms) {
    if (typeof ms !== "number" || !isFinite(ms)) return "";
    var d = new Date(ms);
    return d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear();
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (typeof text === "string") e.textContent = text;
    return e;
  }

  function text(v) { return typeof v === "string" ? v : ""; }

  function say(t) {
    var line = $("terms-message");
    if (line === null) return;
    line.textContent = t;
    line.hidden = t === "";
  }

  function signedOut() { location.replace("/signin"); }

  // Where to go after agreeing: ?next= when it names one of the dashboard's tabs, else Tours.
  function next() {
    var m = /^\\?next=([^&]*)$/.exec(location.search);
    var path = "";
    if (m !== null) {
      try { path = decodeURIComponent(m[1]); } catch (e) { path = ""; }
    }
    return BACK_TO.indexOf(path) >= 0 ? path : "/tours";
  }

  // One version's card, every text through textContent.
  function render(t) {
    $("terms-title").textContent = text(t.title);
    $("terms-version").textContent = TEXT.versionOf + text(t.version);
    var points = $("terms-points");
    points.textContent = "";
    (Array.isArray(t.points) ? t.points : []).forEach(function (p) { points.appendChild(el("li", "", text(p))); });
    var box = $("terms-box");
    box.textContent = "";
    box.scrollTop = 0;
    (Array.isArray(t.body) ? t.body : []).forEach(function (b) {
      if (b === null || typeof b !== "object") return;
      if (b.kind === "heading") box.appendChild(el("h3", "", text(b.text)));
      else if (b.kind === "paragraph") box.appendChild(el("p", "", text(b.text)));
      else if (b.kind === "list" && Array.isArray(b.items)) {
        var ul = el("ul");
        b.items.forEach(function (i) { ul.appendChild(el("li", "", text(i))); });
        box.appendChild(ul);
      }
    });
    var links = (Array.isArray(t.links) ? t.links : []).filter(function (l) {
      return l !== null && typeof l === "object" && typeof l.label === "string" && l.label !== "" && typeof l.url === "string" && l.url.length <= 300 && LINK.test(l.url);
    });
    var line = $("terms-links");
    line.textContent = "";
    line.hidden = links.length === 0;
    if (links.length === 0) return;
    line.appendChild(document.createTextNode(TEXT.openThe));
    links.forEach(function (l, i) {
      if (i > 0) line.appendChild(document.createTextNode(i === links.length - 1 ? TEXT.listAnd : TEXT.listComma));
      var a = el("a", "name", l.label);
      a.setAttribute("href", l.url);
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
      line.appendChild(a);
    });
    line.appendChild(document.createTextNode(links.length === 1 ? TEXT.asPage : TEXT.asPages));
  }

  function valid(t) {
    return t !== null && typeof t === "object" && typeof t.id === "string" && TERMS_ID.test(t.id) && typeof t.title === "string" && typeof t.version === "string";
  }

  function show() {
    $("terms-load").textContent = "";
    $("terms").hidden = false;
    $("terms-title").focus();
  }

  function trouble() {
    $("terms-load").textContent = TEXT.failed;
  }

  // ---- The terms screen ----

  // The current terms, or on to the dashboard when there is nothing to agree to.
  function load(changed) {
    return ask("GET", "/api/v1/terms").then(function (res) {
      if (res.status === 401) { signedOut(); return; }
      var d = res.data;
      if (res.status !== 200 || d === null || typeof d !== "object" || typeof d.csrf !== "string") { trouble(); return; }
      csrf = d.csrf;
      if (d.required !== true || !valid(d.terms)) { location.replace(next()); return; }
      shown = d.terms.id;
      $("terms-kicker").textContent = TEXT.beforeYouStart;
      render(d.terms);
      show();
      say(changed === true ? TEXT.changed : "");
    }, trouble);
  }

  function busy(btn, on, label) {
    working = on;
    $("terms-agree").disabled = on;
    $("terms-signout").disabled = on;
    if (on) {
      btn.setAttribute("data-label", btn.textContent);
      btn.textContent = label;
      btn.setAttribute("aria-busy", "true");
    } else {
      if (btn.hasAttribute("data-label")) btn.textContent = btn.getAttribute("data-label");
      btn.removeAttribute("data-label");
      btn.removeAttribute("aria-busy");
    }
  }

  // "I agree": the version shown, once at a time.
  function agree() {
    var btn = $("terms-agree");
    if (working || shown === "") return;
    say("");
    busy(btn, true, TEXT.agreeing);
    ask("POST", "/api/v1/terms/agree", { terms: shown }).then(function (res) {
      if (res.status === 204) { location.replace(next()); return; }
      busy(btn, false);
      if (res.status === 401) { signedOut(); return; }
      if (res.status === 409 && errorOf(res) === "terms_changed") { load(true); return; }
      say(TEXT.failed);
      btn.focus();
    }, function () {
      busy(btn, false);
      say(TEXT.failed);
      btn.focus();
    });
  }

  // "Sign out": ends this session only, and leaves the account as it is.
  function signOut() {
    var btn = $("terms-signout");
    if (working) return;
    say("");
    busy(btn, true, TEXT.signingOut);
    ask("POST", "/api/v1/signout").then(function (res) {
      if (res.status === 204 || res.status === 401) { signedOut(); return; }
      busy(btn, false);
      say(TEXT.failed);
      btn.focus();
    }, function () {
      busy(btn, false);
      say(TEXT.failed);
      btn.focus();
    });
  }

  // ---- The read-only terms ----

  // The version the account agreed to last; without one, the current terms; without any, a line.
  function readOnly() {
    return ask("GET", "/api/v1/terms/agreed").then(function (res) {
      if (res.status === 401) { signedOut(); return; }
      var d = res.data;
      if (res.status !== 200 || d === null || typeof d !== "object") { trouble(); return; }
      if (valid(d.terms)) {
        $("terms-kicker").textContent = TEXT.agreedOn + dateOf(d.agreed_at) + TEXT.agreedOnAfter;
        render(d.terms);
        show();
        return;
      }
      return ask("GET", "/api/v1/terms").then(function (cur) {
        if (cur.status === 401) { signedOut(); return; }
        var c = cur.data;
        if (cur.status !== 200 || c === null || typeof c !== "object") { trouble(); return; }
        if (valid(c.terms)) {
          $("terms-kicker").textContent = TEXT.current;
          render(c.terms);
        } else {
          $("terms-title").textContent = TEXT.noTerms;
          $("terms-content").hidden = true;
        }
        show();
      });
    }).then(null, trouble);
  }

  if (READ_ONLY) {
    $("terms-back").hidden = false;
    readOnly();
    return;
  }
  $("terms-actions").hidden = false;
  $("terms-agree").addEventListener("click", agree);
  $("terms-signout").addEventListener("click", signOut);
  // A held key's repeats press nothing.
  ["terms-agree", "terms-signout"].forEach(function (id) {
    $(id).addEventListener("keydown", function (ev) {
      if (ev.repeat === true && (ev.key === "Enter" || ev.key === " ")) ev.preventDefault();
    });
  });
  load(false);
})();
`;
