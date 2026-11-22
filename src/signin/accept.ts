// The page an invite's link opens, /invite#dpi_<40 hex>, on the app address, and its own
// script, served by src/pages.ts with the sign-in pages' headers and their stylesheet
// (/signin/signin.css: the look is the sign-in card's). Wording and order follow the owner's
// approved invite mockups 5 and 6; the states the mockups do not draw are proposed.
//
// The page is fixed text: nothing about any invite or account is in it. What the person sees
// of the invite (the invited address) is fetched by the script from POST /api/v1/invite/check
// and set only through textContent, so neither what the server sends nor what a person types
// can become markup.
//
// The code is after `#`, which a browser sends to no server. The script's first two
// statements read that part of the address and take it out of the address bar, before the
// script does anything else and before any request, so back, reload and the tab's history
// never show it. The code then lives in one variable of the script's own function and leaves
// it only in JSON request bodies: the check, sent when the page opens (it changes nothing, so
// a mail scanner that opens the link uses nothing up), and the accept, sent only when the
// person presses "Create my account". Nothing here writes to storage, to a cookie, to the
// page or to an address.
//
// The states, one shown at a time:
// - opening: while the check runs, and when it failed (the failure sentence, or the wait
//   after too many tries) with "Try again", which checks the same code again from memory.
// - choose: mockup 5. The invited address in bold, so a person who was forwarded someone
//   else's invite notices. The username is checked in the page by the server's shape rule
//   (lower case only: a capital is refused, never silently lowered); a reserved or taken name
//   is the server's answer, by its error code. Accepted: the browser is signed in, and the page goes to the
//   Connections page, which decides by itself whether to welcome the person.
// - dead: mockup 6, one page for every invite that cannot be used: no code or a malformed one
//   in the address (nothing is asked), invite_invalid from either request, and has_account.
//   A reload also lands here, as the code left the address when the page first opened, so a
//   line says to open the link from the mail again rather than ask for a new invite.
// - here: the browser is signed in already (409 signed_in), also in a second tab right after
//   the invite was used in the first. Proposed wording. It offers the dashboard and nothing
//   that would act on the account that is signed in.

import { BRAND_PLAIN } from "../brand.ts";

export const INVITE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>Your invite</title>
<link rel="stylesheet" href="/signin/signin.css">
<script src="/invite/invite.js" defer></script>
</head>
<body data-page="invite">
<main class="card">
  ${BRAND_PLAIN}
  <noscript><p class="message">This page needs JavaScript.</p></noscript>

  <section id="opening" aria-labelledby="h-opening" hidden>
    <h1 id="h-opening" tabindex="-1">Opening your invite</h1>
    <p class="message" id="opening-message" role="status" aria-live="polite"></p>
    <button type="button" class="primary wide" id="opening-button" hidden>Try again</button>
  </section>

  <section id="choose" aria-labelledby="h-choose" hidden>
    <h1 id="h-choose" tabindex="-1">Choose your username</h1>
    <p class="lead">You were invited as <strong class="address invited" id="invite-email"></strong>. Your username is how you appear here, and it cannot be changed later.</p>
    <div class="field">
      <label for="username">Username</label>
      <input id="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="64" aria-describedby="username-hint choose-message">
    </div>
    <p class="hint" id="username-hint">3 to 30 characters: lowercase letters, digits and hyphens.</p>
    <p class="message" id="choose-message" role="status" aria-live="polite"></p>
    <button type="button" class="primary wide" id="choose-button">Create my account</button>
    <p class="small">You sign in with a link sent to your email address. There is no password.</p>
  </section>

  <section id="dead" aria-labelledby="h-dead" hidden>
    <h1 id="h-dead" tabindex="-1">This invite no longer works</h1>
    <p class="lead">An invite works once and for 7 days, and a newer invite replaces an older one. Ask the person who invited you to send it again.</p>
    <p class="small">If you reloaded this page, open the link in your mail again.</p>
    <p class="small">Already have an account? <a href="/signin">Sign in</a></p>
  </section>

  <section id="here" aria-labelledby="h-here" hidden>
    <h1 id="h-here" tabindex="-1">You are already signed in</h1>
    <p class="lead">This invite is for a new account. If you have just used it, you are all set. Otherwise sign out first, then open the link from your mail again.</p>
    <button type="button" class="primary wide" id="here-button">Go to the dashboard</button>
  </section>
</main>
</body>
</html>
`;

export const INVITE_JS = String.raw`(function () {
  "use strict";
  var fragment = location.hash;
  if (fragment !== "") history.replaceState(null, "", location.pathname + location.search);
  // Above, first, before anything else and before any request: the part of the address
  // after # (the invite's code) was read and taken out of the address bar, so it stays in
  // no history entry.

  var TEXT = {
    badUsername: "Use 3 to 30 lowercase letters, digits and hyphens, starting with a letter.",
    reserved: "That username cannot be chosen. Try another.",
    taken: "That username is taken. Try another.",
    failed: "Something went wrong. Try again in a moment.",
    waitBefore: "Too many tries. Wait ",
    waitMinutes: " minutes and try again.",
    waitOneMinute: "Too many tries. Wait 1 minute and try again.",
    creating: "Creating…",
  };
  var CHECK = "/api/v1/invite/check";
  var ACCEPT = "/api/v1/invite/accept";
  // The username rule of src/usernames.ts, in lower case only: a letter first, then letters,
  // digits and single inner hyphens, 3 to 30 in all. The server also lowers capitals; this
  // page refuses them instead, so the name sent is the name the person sees.
  var SHAPE = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){2,29}$/;
  var OUTER_SPACE = /^[ \t\r\n]+|[ \t\r\n]+$/g;
  // How long the page waits after a 429 without a usable retry-after (the API's window), and at most.
  var WAIT_S = 900;
  var MAX_WAIT_S = 86400;
  var STATES = ["opening", "choose", "dead", "here"];

  var $ = function (id) { return document.getElementById(id); };
  // The code, only in the shape an invite's link carries; anything else is no code.
  var match = /^#(dpi_[0-9a-f]{40})$/.exec(fragment);
  var code = match === null ? "" : match[1];
  fragment = "";
  match = null;

  // Every request goes through here: a POST to this site only, with a JSON body, the
  // session the browser keeps for this address, no referrer, no cache. It answers
  // { status, data, retryAfter }.
  function post(path, body) {
    var init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" };
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

  // Shows one state.
  function only(id) {
    STATES.forEach(function (s) { $(s).hidden = s !== id; });
  }

  // The invite cannot be used: the code is forgotten.
  function dead() {
    code = "";
    only("dead");
    $("h-dead").focus();
  }

  // The browser is signed in already: the code is forgotten; the mail still holds the link.
  function here() {
    code = "";
    only("here");
    $("h-here").focus();
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

  // What is left of the wait, as a sentence. A press before it ends asks nothing.
  function waitText() {
    var n = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 60000));
    return n === 1 ? TEXT.waitOneMinute : TEXT.waitBefore + n + TEXT.waitMinutes;
  }

  // ---- Looking the invite up ----

  var checking = false;

  // The check failed: why, and "Try again", which checks the code held in memory.
  function trouble(text) {
    only("opening");
    say($("opening-message"), text);
    $("opening-button").hidden = false;
    $("opening-button").focus();
  }

  function check() {
    if (code === "" || checking) return;
    var btn = $("opening-button");
    if (blocked()) { trouble(waitText()); return; }
    checking = true;
    say($("opening-message"), "");
    busy(btn, true);
    post(CHECK, { code: code }).then(function (res) {
      checking = false;
      busy(btn, false);
      var d = res.data;
      if (res.status === 200 && d !== null && typeof d === "object" && typeof d.email === "string" && d.email !== "") { choose(d.email); return; }
      var error = errorOf(res);
      if (res.status === 404 && error === "invite_invalid") { dead(); return; }
      if (res.status === 409 && error === "signed_in") { here(); return; }
      if (res.status === 429) block(res.retryAfter);
      trouble(res.status === 429 ? waitText() : TEXT.failed);
    }, function () {
      checking = false;
      busy(btn, false);
      trouble(TEXT.failed);
    });
  }

  // ---- Choosing the username ----

  // Mockup 5, with the invited address exactly as the check gave it, as text.
  function choose(email) {
    $("invite-email").textContent = email;
    only("choose");
    $("username").focus();
  }

  // The username to send, or null when the shape rule refuses it.
  function usernameOf(v) {
    if (typeof v !== "string" || v.length > 64) return null;
    var name = v.replace(OUTER_SPACE, "");
    return SHAPE.test(name) ? name : null;
  }

  function refuse(text) {
    var input = $("username");
    say($("choose-message"), text);
    input.setAttribute("aria-invalid", "true");
    input.focus();
  }

  var accepting = false;

  // "Create my account": the account is made only here, on a press, with one request at a time.
  function press() {
    var btn = $("choose-button");
    var input = $("username");
    var message = $("choose-message");
    if (code === "" || accepting || btn.disabled) return;
    var name = usernameOf(input.value);
    if (name === null) { refuse(TEXT.badUsername); return; }
    if (blocked()) {
      say(message, waitText());
      btn.focus();
      return;
    }
    input.removeAttribute("aria-invalid");
    say(message, "");
    accepting = true;
    busy(btn, true, TEXT.creating);
    input.setAttribute("readonly", "");
    function back() {
      accepting = false;
      busy(btn, false);
      input.removeAttribute("readonly");
    }
    post(ACCEPT, { code: code, username: name }).then(function (res) {
      if (res.status === 200) {
        code = "";
        location.replace("/connections");
        return;
      }
      back();
      var error = errorOf(res);
      if ((res.status === 404 && error === "invite_invalid") || (res.status === 409 && error === "has_account")) { dead(); return; }
      if (res.status === 409 && error === "signed_in") { here(); return; }
      if (res.status === 400 && error === "reserved_username") { refuse(TEXT.reserved); return; }
      if (res.status === 400 && error === "bad_username") { refuse(TEXT.badUsername); return; }
      if (res.status === 409 && error === "username_taken") { refuse(TEXT.taken); return; }
      if (res.status === 429) block(res.retryAfter);
      say(message, res.status === 429 ? waitText() : TEXT.failed);
      btn.focus();
    }, function () {
      // No answer came: the code is kept, so another press tries again without the mail.
      back();
      say(message, TEXT.failed);
      btn.focus();
    });
  }

  $("opening-button").addEventListener("click", check);
  $("choose-button").addEventListener("click", press);
  // A held key's repeats never press the button.
  $("choose-button").addEventListener("keydown", function (ev) {
    if (ev.repeat === true && (ev.key === "Enter" || ev.key === " ")) ev.preventDefault();
  });
  $("username").addEventListener("input", function () {
    $("username").removeAttribute("aria-invalid");
    say($("choose-message"), "");
  });
  // Enter in the field is the button; a held Enter's repeats do nothing.
  $("username").addEventListener("keydown", function (ev) {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    if (ev.repeat === true) return;
    press();
  });
  $("here-button").addEventListener("click", function () { location.assign("/"); });

  if (code === "") {
    dead();
    return;
  }
  only("opening");
  check();
})();
`;
