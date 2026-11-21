// The sign-in pages, their one stylesheet and their one script, served by src/pages.ts.
// They live in this module as strings, as the setup wizard's do, so both targets serve
// them the same way with no build step. Wording and order follow the owner's approved
// mockups; the look is the wizard's (src/setup/page.ts).
//
// The pages are fixed text: nothing about any account is in them. Everything personal is
// fetched by the script from /api/v1 and set only through textContent, so neither what a
// person types nor what the server sends can become markup.
//
// The page a sign-in link opens gets the code after `#`, which a browser sends to no
// server. The script's first two statements read that part of the address and take it
// out of the address bar, before the script does anything else, so back, reload and the
// history never show it. The code then lives in one variable of the link page's own
// function and leaves it once: in the JSON body of POST /api/v1/signin/complete, when the
// button is pressed. Nothing here writes to storage, to a cookie or to an address.
import { BRAND_PLAIN } from "../brand.ts";
import { escapeHtml, type InviteContact } from "./invite.ts";

export const SIGNIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>Sign in</title>
<link rel="stylesheet" href="/signin/signin.css">
<script src="/signin/signin.js" defer></script>
</head>
<body data-page="signin">
<main class="card">
  ${BRAND_PLAIN}
  <noscript><p class="message">This page needs JavaScript.</p></noscript>

  <section id="ask" aria-labelledby="h-ask">
    <h1 id="h-ask" tabindex="-1">Sign in</h1>
    <p class="lead">Enter your email address and we will send you a link to sign in. There is no password.</p>
    <form id="ask-form" method="post" novalidate>
      <div class="field">
        <label for="email">Email address</label>
        <input id="email" type="email" autocomplete="email" autocapitalize="off" spellcheck="false" maxlength="254" placeholder="you@example.com" aria-describedby="ask-message" required>
      </div>
      <p class="message" id="ask-message" role="status" aria-live="polite"></p>
      <button type="submit" class="primary wide" id="ask-button">Send me a sign-in link</button>
    </form>
    <p class="small">Mythicshot is invite-only for now.</p>
  </section>

  <section id="sent" aria-labelledby="h-sent" hidden>
    <h1 id="h-sent" tabindex="-1">Check your mail</h1>
    <p class="lead">If <span class="address" id="sent-to"></span> has an account, a sign-in link is on its way. It works once and for 15 minutes.</p>
    <p class="small">Nothing after a few minutes? Look in your spam folder, or <a href="/signin" id="again">try another address</a>.</p>
  </section>
</main>
</body>
</html>
`;

export const LINK_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>Finish signing in</title>
<link rel="stylesheet" href="/signin/signin.css">
<script src="/signin/signin.js" defer></script>
</head>
<body data-page="link">
<main class="card">
  ${BRAND_PLAIN}
  <noscript><p class="message">This page needs JavaScript.</p></noscript>

  <section id="finish" aria-labelledby="h-finish" hidden>
    <h1 id="h-finish" tabindex="-1">Finish signing in</h1>
    <p class="lead">Press the button to sign in on this browser.</p>
    <p class="message" id="finish-message" role="status" aria-live="polite"></p>
    <button type="button" class="primary wide" id="finish-button">Sign in</button>
    <p class="small">You stay signed in here for 30 days of use. If you did not ask for this link, close this page: nothing happens.</p>
  </section>

  <section id="dead" aria-labelledby="h-dead" hidden>
    <h1 id="h-dead" tabindex="-1">This sign-in link no longer works</h1>
    <p class="lead">A link works once and for 15 minutes. Ask for a new one and use the newest mail.</p>
    <button type="button" class="primary wide" id="dead-button">Send me a new link</button>
  </section>
</main>
</body>
</html>
`;

export const SIGNIN_CSS = `:root {
  color-scheme: light dark;
  --bg: #f3f1ec;
  --card: #fcfbf8;
  --text: #2a2926;
  --muted: #66625b;
  --line: #e2ded5;
  --field: #ffffff;
  --accent: #3d6b5f;
  --accent-text: #ffffff;
  --accent-soft: rgba(61, 107, 95, 0.28);
  --ok-bg: #e3efe8;
  --ok-text: #2b5a47;
  --warn: #a8620a;
  --error: #a33a2c;
  --shadow: 0 1px 2px rgba(40, 36, 28, 0.05), 0 8px 28px rgba(40, 36, 28, 0.07);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #181a1c;
    --card: #212427;
    --text: #e6e3dc;
    --muted: #a39f97;
    --line: #353a3e;
    --field: #1a1c1f;
    --accent: #8dc1af;
    --accent-text: #13221d;
    --accent-soft: rgba(141, 193, 175, 0.3);
    --ok-bg: #1d3128;
    --ok-text: #a8d7c2;
    --warn: #e6a855;
    --error: #f0a093;
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 10px 30px rgba(0, 0, 0, 0.25);
  }
}
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 16px;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
.card {
  width: 100%;
  max-width: 440px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 16px;
  box-shadow: var(--shadow);
  padding: 28px 28px 24px;
  overflow-wrap: anywhere;
}
.brand { display: flex; align-items: center; gap: 8px; margin: 0 0 14px; font-size: 0.875rem; font-weight: 650; letter-spacing: 0.02em; color: var(--muted); }
.brand a { display: inline-flex; align-items: center; gap: 8px; color: inherit; text-decoration: none; }
.brand img { display: block; flex: none; }
h1 { font-size: 1.375rem; line-height: 1.3; font-weight: 650; margin: 0 0 8px; letter-spacing: -0.01em; }
h1:focus, h2:focus { outline: none; }
.lead { margin: 0 0 22px; color: var(--muted); }
.address { color: var(--text); font-weight: 600; }
.address.invited { font-weight: 700; }
.field { margin-bottom: 8px; }
label { display: block; font-size: 0.9rem; font-weight: 600; margin: 0 0 6px; }
input[type="email"], input[type="text"] {
  width: 100%;
  min-height: 44px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--field);
  color: var(--text);
  font: inherit;
}
input[type="email"]:focus-visible, input[type="text"]:focus-visible {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
input[aria-invalid="true"] { border-color: var(--error); }
.hint { margin: 6px 0 4px; color: var(--muted); font-size: 0.9rem; }
.message { min-height: 2.9em; margin: 0 0 8px; color: var(--error); font-size: 0.9rem; line-height: 1.45; }
noscript .message { min-height: 0; }
button {
  min-height: 44px;
  padding: 10px 18px;
  border-radius: 10px;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background-color 0.15s ease, opacity 0.15s ease;
}
button:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-soft); }
button.primary { background: var(--accent); color: var(--accent-text); }
button.primary:hover:not(:disabled) { opacity: 0.9; }
button.wide { width: 100%; }
button:disabled { opacity: 0.45; cursor: not-allowed; }
button[aria-busy="true"] { cursor: progress; }
a { color: var(--accent); text-underline-offset: 2px; }
a:focus-visible { outline: 3px solid var(--accent-soft); outline-offset: 2px; border-radius: 4px; }
.small { margin: 18px 0 0; color: var(--muted); font-size: 0.9rem; }
@media (prefers-reduced-motion: reduce) {
  button { transition: none; }
}
@media (max-width: 480px) {
  body { align-items: flex-start; padding-top: 24px; }
  .card { padding: 22px 18px 20px; border-radius: 14px; }
}
`;

export const SIGNIN_JS = `(function () {
  "use strict";
  // First, before anything else: read the part of the address after # (a sign-in link's
  // code) and take it out of the address bar, so it stays in no history entry.
  var fragment = location.hash;
  if (fragment !== "") history.replaceState(null, "", location.pathname + location.search);

  var TEXT = {
    badEmail: "That does not look like an email address.",
    tooMany: "Too many requests. Wait a few minutes and try again.",
    failed: "Something went wrong. Try again in a moment.",
    sending: "Sending…",
    signingIn: "Signing in…",
  };

  var $ = function (id) { return document.getElementById(id); };

  // Every request goes through here: to this site only, with the session the browser
  // keeps for this address, no referrer, and a JSON body labelled as JSON.
  function call(method, path, body) {
    var headers = {};
    var init = { method: method, headers: headers, credentials: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return fetch(path, init).then(function (r) {
      return r.text().then(function (t) {
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
        return { status: r.status, data: data };
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
      btn.setAttribute("data-label", btn.textContent);
      btn.textContent = label;
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
    } else {
      btn.textContent = btn.getAttribute("data-label") || btn.textContent;
      btn.removeAttribute("aria-busy");
      btn.disabled = false;
    }
  }

  function looksLikeEmail(v) {
    if (v.length === 0 || v.length > 254 || /\\s/.test(v)) return false;
    var parts = v.split("@");
    return parts.length === 2 && parts[0] !== "" && parts[1] !== "";
  }

  // A sign-in link's code, only in the shape a link carries; anything else is no code.
  function codeOf(text) {
    var match = /^#c=(dpl_[0-9a-f]{40})$/.exec(text);
    return match === null ? "" : match[1];
  }

  // Sign in: ask for a link, then say to check the mail, the same whether or not the
  // address has an account.
  function signinPage() {
    var input = $("email");
    var btn = $("ask-button");
    var message = $("ask-message");

    function invalid() {
      say(message, TEXT.badEmail);
      input.setAttribute("aria-invalid", "true");
      input.focus();
    }

    input.focus();
    // Someone who is signed in already belongs on the dashboard, which starts at the Tours page.
    call("GET", "/api/v1/session").then(function (res) {
      if (res.status === 200) location.replace("/tours");
    }, function () { /* the form stays */ });

    $("ask-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (btn.disabled) return;
      var value = input.value.trim();
      if (!looksLikeEmail(value)) { invalid(); return; }
      input.removeAttribute("aria-invalid");
      say(message, "");
      busy(btn, true, TEXT.sending);
      call("POST", "/api/v1/signin/request", { email: value }).then(function (res) {
        busy(btn, false);
        if (res.status === 200) {
          say($("sent-to"), value);
          $("ask").hidden = true;
          $("sent").hidden = false;
          $("h-sent").focus();
          return;
        }
        if (res.status === 400 && errorOf(res) === "bad_email") { invalid(); return; }
        say(message, res.status === 429 ? TEXT.tooMany : TEXT.failed);
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
      $("sent").hidden = true;
      $("ask").hidden = false;
      say(message, "");
      input.focus();
    });
  }

  // The page a link opens: the code, if it has the shape of one, waits in this function
  // until the button is pressed. A missing or malformed code, and every refusal of it, is
  // the one state of a link that no longer works.
  function linkPage(code) {
    var btn = $("finish-button");
    var message = $("finish-message");

    function dead() {
      code = "";
      $("finish").hidden = true;
      $("dead").hidden = false;
      $("h-dead").focus();
    }

    $("dead-button").addEventListener("click", function () { location.assign("/signin"); });
    if (code === "") {
      dead();
      return;
    }
    $("finish").hidden = false;

    $("finish-button").addEventListener("click", function () {
      if (code === "") return;
      if (btn.disabled) return;
      say(message, "");
      busy(btn, true, TEXT.signingIn);
      call("POST", "/api/v1/signin/complete", { code: code }).then(function (res) {
        if (res.status === 200) {
          code = "";
          location.replace("/tours");
          return;
        }
        busy(btn, false);
        var error = errorOf(res);
        if (error === "link_invalid" || error === "bad_code") { dead(); return; }
        say(message, res.status === 429 ? TEXT.tooMany : TEXT.failed);
        btn.focus();
      }, function () {
        busy(btn, false);
        say(message, TEXT.failed);
        btn.focus();
      });
    });
  }

  var page = document.body.getAttribute("data-page");
  if (page === "link") linkPage(codeOf(fragment));
  else if (page === "signin") signinPage();
  fragment = "";
})();
`;

/** The invite line of the sign-in page as built, without a contact. */
const INVITE_LINE = '<p class="small">Mythicshot is invite-only for now.</p>';

/**
 * The sign-in page with the invite line for `contact` (from INVITE_CONTACT through
 * inviteContactFrom): an https address as the link "Ask for an invite", an email address
 * after "Ask for an invite:" as its own mailto link. Without one it is SIGNIN_HTML itself.
 * Every part of the contact is escaped.
 */
export function signinHtml(contact: InviteContact | null): string {
  if (contact === null) return SIGNIN_HTML;
  const line =
    contact.kind === "url"
      ? `<p class="small">Mythicshot is invite-only for now. <a href="${escapeHtml(contact.href)}" rel="noopener noreferrer">Ask for an invite</a></p>`
      : `<p class="small">Mythicshot is invite-only for now. Ask for an invite: <a href="mailto:${escapeHtml(contact.address)}" class="address">${escapeHtml(contact.address)}</a></p>`;
  return SIGNIN_HTML.replace(INVITE_LINE, () => line);
}
