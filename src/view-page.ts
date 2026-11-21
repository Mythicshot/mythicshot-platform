// The pages a visitor of a restricted tour sees on the tours address, their one script and
// their stylesheet, served by src/restricted.ts. They live here as strings, as the sign-in
// pages do (src/signin/page.ts), with the sign-in card's look: the stylesheet is the sign-in
// pages' own, with one rule added for a quiet button. Wording and order follow the owner's
// approved mockups 4 to 7 of restricted tours; the states the mockups do not draw are
// proposed and listed in the changelog.
//
// Every page is fixed text: nothing about any tour, list or address is in it, not even the
// tour's title. What a page shows of the visitor (the address a link was mailed to, the
// address this browser proved) its script asks the API for and sets only through
// textContent, so neither what the server sends nor what a person types can become markup.
// These pages carry no customer content at all, which is why they, and not the tour page,
// may call the API (connect-src 'self').
//
// The pages, one script for all four, told apart by `data-page`:
// - gate (mockup 4): served at /t/<slug> to a browser that has proved no address. The slug
//   it asks for is read from the page's own path, never from a query or the fragment, so a
//   link cannot make it ask about another tour than the one in the address bar. It says that
//   a restricted tour exists at this link, which is approved, and never whether an address is
//   on its list: the request answers the same 202 for every address, and the page then says
//   the same "If this tour is shared with ..." for every one.
// - denied (mockup 6, left): served at /t/<slug> to a browser whose proved address may not
//   view the tour. "Use another address" signs the browser out and loads the tour's address
//   again, which then shows the gate.
// - link (mockup 5, right; 6, right): /view, the page a viewer link opens. It shows the address
//   the link proves in bold, inside its one sentence, as the invite page shows the invited
//   address, so a person who was forwarded someone else's link notices. The code is after
//   `#`, which a browser sends to no server. The script's first two statements read that
//   part of the address and take it out of the address bar, before anything else and before
//   any request, so back, reload and the tab's history never show it. The code then lives in
//   one variable of the script's own function and leaves it only in JSON request bodies: the
//   check, when the page opens (it changes nothing, so a mail scanner that opens the link
//   uses nothing up), and the completion, only when the person presses "Open the tour", once.
//   Then the browser goes to the tour with location.replace, so the page leaves no history
//   entry either. Nothing here writes to storage, to a cookie, to the page or to an address.
// - signout: /view/signout/<slug>, where "Not you?" under a restricted tour leads. The tour
//   page itself has no script of its own and may not call the API, so the sign-out is done
//   here, on a press, by a page that holds no customer content; then the browser goes back
//   to the tour's address, which shows the gate.
import { SIGNIN_CSS } from "./signin/page.ts";

const HEAD = (title: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>${title}</title>
<link rel="stylesheet" href="/view/view.css">
<script src="/view/view.js" defer></script>
</head>`;

const NOSCRIPT = `<noscript><p class="message">This page needs JavaScript.</p></noscript>`;

/** Mockup 4: the gate, and "Check your mail" after the request. */
export const VIEW_GATE_HTML = `${HEAD("Shared with specific people")}
<body data-page="gate">
<main class="card">
  <p class="brand">Mythicshot</p>
  ${NOSCRIPT}

  <section id="ask" aria-labelledby="h-ask">
    <h1 id="h-ask" tabindex="-1">This tour is shared with specific people</h1>
    <p class="lead">Enter your email address. If the tour is shared with you, we send you a link to open it. There is no password.</p>
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
    <p class="lead">If this tour is shared with <span class="address" id="sent-to"></span>, a link is on its way. It works once and for 15 minutes.</p>
    <p class="small">Nothing after a few minutes? Look in your spam folder, or check with the person who sent you the tour that they used this address. <a href="" id="again">Try another address</a></p>
  </section>
</main>
</body>
</html>
`;

/** Mockup 6, left: this browser proved an address the tour is not shared with. */
export const VIEW_DENIED_HTML = `${HEAD("Not shared with you")}
<body data-page="denied">
<main class="card">
  <p class="brand">Mythicshot</p>
  ${NOSCRIPT}

  <section id="opening" aria-labelledby="h-opening" hidden>
    <h1 id="h-opening" tabindex="-1">This tour is not shared with you</h1>
    <p class="message" id="opening-message" role="status" aria-live="polite"></p>
    <button type="button" class="primary wide" id="opening-button" hidden>Try again</button>
  </section>

  <section id="denied" aria-labelledby="h-denied" hidden>
    <h1 id="h-denied" tabindex="-1">This tour is not shared with you</h1>
    <p class="lead">You are viewing as <span class="address" id="denied-email"></span>, and this tour is shared with other people. If you were given this link, ask the person who sent it to add your address.</p>
    <p class="message" id="denied-message" role="status" aria-live="polite"></p>
    <button type="button" class="quiet wide" id="denied-button">Use another address</button>
  </section>
</main>
</body>
</html>
`;

/** Mockup 5, right, and mockup 6, right: the page a viewer link opens, /view#dpv_<40 hex>. */
export const VIEW_LINK_HTML = `${HEAD("Open the tour")}
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
    <h1 id="h-open" tabindex="-1">Open the tour</h1>
    <p class="lead">Press the button to view it in this browser as <strong class="address invited" id="open-email"></strong>.</p>
    <p class="message" id="open-message" role="status" aria-live="polite"></p>
    <button type="button" class="primary wide" id="open-button">Open the tour</button>
    <p class="small">This browser will remember your address for tours shared with you, for 30 days of use. It gives no access to anything else.</p>
  </section>

  <section id="dead" aria-labelledby="h-dead" hidden>
    <h1 id="h-dead" tabindex="-1">This link no longer works</h1>
    <p class="lead">A link works once and for 15 minutes. Open the tour's own link again and ask for a new one.</p>
    <p class="small">If you reloaded this page, open the link in your mail again.</p>
  </section>
</main>
</body>
</html>
`;

/** Where "Not you?" under a restricted tour leads: the sign-out, on a press. */
export const VIEW_SIGNOUT_HTML = `${HEAD("Not you?")}
<body data-page="signout">
<main class="card">
  <p class="brand">Mythicshot</p>
  ${NOSCRIPT}

  <section id="signout" aria-labelledby="h-signout">
    <h1 id="h-signout" tabindex="-1">Not you?</h1>
    <p class="lead">Sign this browser out of tours shared with you, then enter your own address on the tour's page.</p>
    <p class="message" id="signout-message" role="status" aria-live="polite"></p>
    <button type="button" class="primary wide" id="signout-button">Use another address</button>
  </section>
</main>
</body>
</html>
`;

/** The sign-in pages' stylesheet, with a quiet button added (mockup 6's "Use another address"). */
export const VIEW_CSS = `${SIGNIN_CSS}button.quiet { background: transparent; color: var(--accent); border-color: var(--line); }
button.quiet:hover:not(:disabled) { background: var(--bg); }
`;

/**
 * The one line under a restricted tour (mockup 7), for the tour page, which keeps the player's
 * own stylesheet: this file only adds the line's look. Nothing else on the page changes.
 */
export const SHARED_CSS = `.dp-shared { margin: 0; padding: 10px 16px 16px; text-align: center; font-size: 13px; line-height: 1.5; color: #5c636f; overflow-wrap: anywhere; }
.dp-shared a { color: inherit; text-underline-offset: 2px; }
@media (prefers-color-scheme: dark) { .dp-shared { color: #9ba2ae; } }
`;

export const VIEW_JS = String.raw`(function () {
  "use strict";
  var fragment = location.hash;
  if (fragment !== "") history.replaceState(null, "", location.pathname + location.search);
  // Above, first, before anything else and before any request: the part of the address
  // after # (a viewer link's code) was read and taken out of the address bar, so it stays in
  // no history entry.

  var TEXT = {
    badEmail: "That does not look like an email address.",
    failed: "Something went wrong. Try again in a moment.",
    waitBefore: "Too many tries. Wait ",
    waitMinutes: " minutes and try again.",
    waitOneMinute: "Too many tries. Wait 1 minute and try again.",
    sending: "Sending…",
    opening: "Opening…"
  };
  // How long the page waits after a 429 without a usable retry-after (the API's window), and at most.
  var WAIT_S = 900;
  var MAX_WAIT_S = 86400;
  var SLUG = /^[a-z2-7]{10}$/;
  var STATES = ["ask", "sent", "opening", "denied", "open", "dead", "signout"];

  var $ = function (id) { return document.getElementById(id); };
  var page = document.body.getAttribute("data-page");
  // A viewer link's code, only in the shape a link carries and only on the link's page; anything else is no code.
  var match = page === "link" ? /^#(dpv_[0-9a-f]{40})$/.exec(fragment) : null;
  var code = match === null ? "" : match[1];
  fragment = "";
  match = null;

  // Every request goes through here: to this site only, with the credentials the browser
  // keeps for this address, no referrer, no cache, and a JSON body labelled as JSON. It
  // answers { status, data, retryAfter }.
  function call(method, path, body) {
    var init = { method: method, headers: {}, credentials: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" };
    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return fetch(path, init).then(function (r) {
      return r.text().then(function (t) {
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
        return { status: r.status, data: data, retryAfter: r.headers.get("retry-after") };
      });
    });
  }

  function errorOf(res) {
    return res.data !== null && typeof res.data === "object" && typeof res.data.error === "string" ? res.data.error : "";
  }

  function say(el, text) {
    el.textContent = text;
  }

  function busy(btn, on, label) {
    if (on) {
      if (typeof label === "string") {
        btn.setAttribute("data-label", btn.textContent);
        btn.textContent = label;
      }
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
    } else {
      if (btn.hasAttribute("data-label")) {
        btn.textContent = btn.getAttribute("data-label");
        btn.removeAttribute("data-label");
      }
      btn.removeAttribute("aria-busy");
      btn.disabled = false;
    }
  }

  // Shows one of the page's sections (each page has some of these).
  function only(id) {
    STATES.forEach(function (s) {
      var el = $(s);
      if (el !== null) el.hidden = s !== id;
    });
  }

  // ---- Too many tries ----

  var blockedUntil = 0;

  function blocked() {
    return blockedUntil !== 0 && Date.now() < blockedUntil;
  }

  // A 429: the wait is its retry-after (whole seconds), said in whole minutes, rounded up.
  function block(retryAfter) {
    var s = typeof retryAfter === "string" && /^[0-9]{1,9}$/.test(retryAfter) ? Number(retryAfter) : WAIT_S;
    s = Math.min(MAX_WAIT_S, Math.max(1, s));
    blockedUntil = Date.now() + s * 1000;
  }

  function waitText() {
    var n = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 60000));
    return n === 1 ? TEXT.waitOneMinute : TEXT.waitBefore + n + TEXT.waitMinutes;
  }

  function looksLikeEmail(v) {
    if (v.length === 0 || v.length > 254 || /\s/.test(v)) return false;
    var parts = v.split("@");
    return parts.length === 2 && parts[0] !== "" && parts[1] !== "";
  }

  // The tour's slug from this page's own path, for the gate and the not-shared page (/t/<slug>)
  // and the sign-out page (/view/signout/<slug>); "" for anything else.
  function slugOfPath(prefix) {
    var path = location.pathname;
    if (path.indexOf(prefix) !== 0) return "";
    var slug = path.slice(prefix.length);
    return SLUG.test(slug) ? slug : "";
  }

  // Signs this browser out of tours shared with it, then goes to the tour's own address,
  // which shows the gate. A failure says so and leaves the button to press again.
  function signOutThen(btn, message, slug) {
    if (btn.disabled || slug === "") return;
    say(message, "");
    busy(btn, true);
    call("POST", "/api/v1/view/signout").then(function (res) {
      if (res.status === 204) {
        location.replace("/t/" + slug);
        return;
      }
      busy(btn, false);
      say(message, TEXT.failed);
      btn.focus();
    }, function () {
      busy(btn, false);
      say(message, TEXT.failed);
      btn.focus();
    });
  }

  // ---- The gate (mockup 4) ----

  function gatePage() {
    var slug = slugOfPath("/t/");
    var input = $("email");
    var btn = $("ask-button");
    var message = $("ask-message");

    function invalid() {
      say(message, TEXT.badEmail);
      input.setAttribute("aria-invalid", "true");
      input.focus();
    }

    input.focus();
    $("ask-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (btn.disabled || slug === "") return;
      var value = input.value.trim();
      if (!looksLikeEmail(value)) { invalid(); return; }
      if (blocked()) { say(message, waitText()); btn.focus(); return; }
      input.removeAttribute("aria-invalid");
      say(message, "");
      busy(btn, true, TEXT.sending);
      call("POST", "/api/v1/view/request", { email: value, slug: slug }).then(function (res) {
        busy(btn, false);
        if (res.status === 202) {
          say($("sent-to"), value);
          only("sent");
          $("h-sent").focus();
          return;
        }
        if (res.status === 429) block(res.retryAfter);
        say(message, res.status === 429 ? waitText() : TEXT.failed);
        btn.focus();
      }, function () {
        busy(btn, false);
        say(message, TEXT.failed);
        btn.focus();
      });
    });

    $("again").addEventListener("click", function (ev) {
      ev.preventDefault();
      say($("sent-to"), "");
      only("ask");
      say(message, "");
      input.focus();
    });
  }

  // ---- Not shared with this address (mockup 6, left) ----

  function deniedPage() {
    var slug = slugOfPath("/t/");
    var retry = $("opening-button");

    function trouble(text) {
      only("opening");
      say($("opening-message"), text);
      retry.hidden = false;
      retry.focus();
    }

    // The address this browser proved, from the API, shown as text.
    function look() {
      if (retry.disabled) return;
      busy(retry, true);
      call("GET", "/api/v1/view/session").then(function (res) {
        busy(retry, false);
        var d = res.data;
        if (res.status === 200 && d !== null && typeof d === "object" && typeof d.email === "string" && d.email !== "") {
          say($("denied-email"), d.email);
          only("denied");
          $("h-denied").focus();
          return;
        }
        // The session ended meanwhile: the tour's address now shows the gate.
        if (res.status === 401 && slug !== "") { location.replace("/t/" + slug); return; }
        trouble(TEXT.failed);
      }, function () {
        busy(retry, false);
        trouble(TEXT.failed);
      });
    }

    retry.addEventListener("click", look);
    $("denied-button").addEventListener("click", function () { signOutThen($("denied-button"), $("denied-message"), slug); });
    look();
  }

  // ---- The page a viewer link opens (mockups 5 and 6) ----

  function linkPage() {
    var retry = $("opening-button");
    var btn = $("open-button");
    var message = $("open-message");
    var checking = false;
    var completing = false;

    // The link cannot be used: the code is forgotten.
    function dead() {
      code = "";
      only("dead");
      $("h-dead").focus();
    }

    function trouble(text) {
      only("opening");
      say($("opening-message"), text);
      retry.hidden = false;
      retry.focus();
    }

    function check() {
      if (code === "" || checking) return;
      if (blocked()) { trouble(waitText()); return; }
      checking = true;
      say($("opening-message"), "");
      busy(retry, true);
      call("POST", "/api/v1/view/check", { code: code }).then(function (res) {
        checking = false;
        busy(retry, false);
        var d = res.data;
        if (res.status === 200 && d !== null && typeof d === "object" && typeof d.email === "string" && d.email !== "" && typeof d.slug === "string" && SLUG.test(d.slug)) {
          say($("open-email"), d.email);
          only("open");
          btn.focus();
          return;
        }
        if (res.status === 404 && errorOf(res) === "view_link_invalid") { dead(); return; }
        if (res.status === 429) block(res.retryAfter);
        trouble(res.status === 429 ? waitText() : TEXT.failed);
      }, function () {
        checking = false;
        busy(retry, false);
        trouble(TEXT.failed);
      });
    }

    // "Open the tour": the viewer session is made only here, on a press, one request at a time.
    function press() {
      if (code === "" || completing || btn.disabled) return;
      if (blocked()) { say(message, waitText()); btn.focus(); return; }
      say(message, "");
      completing = true;
      busy(btn, true, TEXT.opening);
      call("POST", "/api/v1/view/complete", { code: code }).then(function (res) {
        var d = res.data;
        if (res.status === 200 && d !== null && typeof d === "object" && typeof d.slug === "string" && SLUG.test(d.slug)) {
          code = "";
          location.replace("/t/" + d.slug);
          return;
        }
        completing = false;
        busy(btn, false);
        if (res.status === 404 && errorOf(res) === "view_link_invalid") { dead(); return; }
        if (res.status === 429) block(res.retryAfter);
        say(message, res.status === 429 ? waitText() : TEXT.failed);
        btn.focus();
      }, function () {
        // No answer came: the code is kept, so another press tries again without the mail.
        completing = false;
        busy(btn, false);
        say(message, TEXT.failed);
        btn.focus();
      });
    }

    retry.addEventListener("click", check);
    btn.addEventListener("click", press);
    // A held key's repeats never press the button.
    btn.addEventListener("keydown", function (ev) {
      if (ev.repeat === true && (ev.key === "Enter" || ev.key === " ")) ev.preventDefault();
    });

    if (code === "") {
      dead();
      return;
    }
    only("opening");
    check();
  }

  // ---- Where "Not you?" leads ----

  function signoutPage() {
    var slug = slugOfPath("/view/signout/");
    var btn = $("signout-button");
    btn.addEventListener("click", function () { signOutThen(btn, $("signout-message"), slug); });
  }

  if (page === "gate") gatePage();
  else if (page === "denied") deniedPage();
  else if (page === "link") linkPage();
  else if (page === "signout") signoutPage();
})();
`;
