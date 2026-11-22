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
import { CINZEL_FACE, PAGE_BASE_CSS, WORDMARK_CSS } from "../brand-css.ts";
import { BRAND_PLAIN, FAVICON_LINKS } from "../brand.ts";
import { escapeHtml, type InviteContact } from "./invite.ts";

export const SIGNIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>Sign in</title>
${FAVICON_LINKS}
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
${FAVICON_LINKS}
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

/**
 * The sign-in card's look, shared with the gate pages viewers of a restricted tour or item see
 * (src/view-page.ts): the brand's tokens and Manrope, a card of 12px corners, fields and
 * buttons 44px tall. The name at the top of those gate pages stands alone, without the mark,
 * so it is set in Manrope here; only SIGNIN_CSS adds the wordmark style beside the mark.
 */
export const SIGNIN_CARD_CSS = `${PAGE_BASE_CSS}*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 16px;
  background: var(--ground);
  color: var(--text);
  font: 16px/26px var(--font-sans);
}
::selection { background: var(--selection); color: var(--text); }
.card {
  width: 100%;
  max-width: 440px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-raised);
  padding: 28px 28px 24px;
  overflow-wrap: anywhere;
}
.brand { display: flex; align-items: center; gap: 8px; margin: 0 0 16px; font-size: 15px; line-height: 22px; font-weight: 700; color: var(--text); }
.brand a { display: inline-flex; align-items: center; gap: 8px; color: inherit; text-decoration: none; }
.brand a:hover { text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 4px; }
.brand img { display: block; flex: none; }
h1 { font-size: 24px; line-height: 32px; font-weight: 700; margin: 0 0 8px; }
h1:focus, h2:focus { outline: none; }
.lead { margin: 0 0 24px; color: var(--text-muted); }
.address { color: var(--text); font-weight: 600; }
.address.invited { font-weight: 700; }
.field { margin-bottom: 8px; }
label { display: block; font-size: 13px; line-height: 18px; font-weight: 600; margin: 0 0 4px; }
input[type="email"], input[type="text"] {
  width: 100%;
  min-height: var(--control-roomy);
  padding: 10px 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  background: var(--surface);
  color: var(--text);
  font: inherit;
}
input::placeholder { color: var(--text-muted); opacity: 1; }
input[aria-invalid="true"] { border-color: var(--danger-border); box-shadow: inset 0 0 0 1px var(--danger-border); }
.hint { margin: 6px 0 4px; color: var(--text-muted); font-size: 14px; line-height: 20px; }
.message { min-height: 2.9em; margin: 0 0 8px; color: var(--danger-text); font-size: 14px; line-height: 20px; }
noscript .message { min-height: 0; }
button {
  min-height: var(--control-roomy);
  padding: 10px 18px;
  border-radius: var(--radius-md);
  font: inherit;
  font-size: 15px;
  font-weight: 600;
  line-height: 22px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
button.primary { background: var(--primary); border-color: var(--primary); color: var(--on-primary); }
button.primary:hover:not(:disabled) { background: var(--primary-hover); border-color: var(--primary-hover); }
button.wide { width: 100%; }
button:disabled { opacity: 0.45; cursor: not-allowed; }
button[aria-busy="true"] { cursor: progress; }
a { color: var(--accent-text); text-underline-offset: 2px; }
a:hover { text-decoration-thickness: 2px; }
a:focus-visible { border-radius: var(--radius-sm); }
.small { margin: 18px 0 0; color: var(--text-muted); font-size: 14px; line-height: 20px; }
@media (prefers-reduced-motion: reduce) {
  button { transition: none; }
}
@media (max-width: 480px) {
  body { align-items: flex-start; padding-top: 24px; }
  .card { padding: 24px 18px 20px; }
}
`;

/** The sign-in pages' stylesheet: the card, then Cinzel and the wordmark style for the name beside the mark. */
export const SIGNIN_CSS = `${SIGNIN_CARD_CSS}${CINZEL_FACE}${WORDMARK_CSS}`;

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
