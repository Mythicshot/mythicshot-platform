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
  <p class="brand">Mythicshot</p>
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
  <p class="brand">Mythicshot</p>
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

export const ACCOUNT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>Mythicshot</title>
<link rel="stylesheet" href="/signin/signin.css">
<script src="/signin/signin.js" defer></script>
</head>
<body data-page="account">
<main class="card">
  <p class="brand">Mythicshot</p>
  <noscript><p class="message">This page needs JavaScript.</p></noscript>

  <section id="account" aria-labelledby="h-account" hidden>
    <h1 id="h-account" tabindex="-1">Signed in</h1>
    <p class="lead" id="account-email"></p>

    <h2 class="label" id="h-storage">Storage</h2>
    <div class="bar" id="usage-bar" aria-hidden="true"><div class="fill" id="usage-fill"></div></div>
    <p class="usage" id="usage-text"></p>
    <p class="hint">Tours and their pictures count. Deleting a tour frees its space within a few minutes.</p>

    <h2 class="label" id="h-where" tabindex="-1">Where you are signed in</h2>
    <ul class="sessions" id="sessions" aria-labelledby="h-where"></ul>

    <p class="message" id="account-message" role="status" aria-live="polite"></p>
    <div class="actions">
      <button type="button" class="secondary" id="signout">Sign out</button>
      <button type="button" class="secondary" id="signout-everywhere">Sign out everywhere</button>
    </div>
    <p class="small">Tours are managed from Mythicshot for now. A dashboard is coming to this page.</p>
  </section>
  <p class="message" id="load-message" role="status" aria-live="polite"></p>
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
.brand { margin: 0 0 14px; font-size: 0.875rem; font-weight: 650; letter-spacing: 0.02em; color: var(--muted); }
h1 { font-size: 1.375rem; line-height: 1.3; font-weight: 650; margin: 0 0 8px; letter-spacing: -0.01em; }
h1:focus, h2:focus { outline: none; }
.lead { margin: 0 0 22px; color: var(--muted); }
.address { color: var(--text); font-weight: 600; }
.field { margin-bottom: 8px; }
label { display: block; font-size: 0.9rem; font-weight: 600; margin: 0 0 6px; }
input[type="email"] {
  width: 100%;
  min-height: 44px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--field);
  color: var(--text);
  font: inherit;
}
input[type="email"]:focus-visible {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
input[aria-invalid="true"] { border-color: var(--error); }
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
button.secondary { background: transparent; color: var(--text); border-color: var(--line); }
button.secondary:hover:not(:disabled) { background: var(--bg); }
button.link {
  flex: none;
  padding: 0 4px;
  background: transparent;
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}
button:disabled { opacity: 0.45; cursor: not-allowed; }
button[aria-busy="true"] { cursor: progress; }
a { color: var(--accent); text-underline-offset: 2px; }
a:focus-visible { outline: 3px solid var(--accent-soft); outline-offset: 2px; border-radius: 4px; }
.small { margin: 18px 0 0; color: var(--muted); font-size: 0.9rem; }
.label { margin: 22px 0 8px; font-size: 0.9rem; font-weight: 600; }
.lead + .label { margin-top: 0; }
.bar { height: 8px; margin: 0 0 8px; border-radius: 8px; background: var(--line); overflow: hidden; }
.bar .fill { width: 0; height: 100%; border-radius: inherit; background: var(--accent); }
.bar[data-over="true"] .fill { background: var(--warn); }
.usage { margin: 0 0 4px; font-weight: 500; }
.hint { margin: 0; color: var(--muted); font-size: 0.875rem; }
.sessions { list-style: none; margin: 0 0 12px; padding: 0; border: 1px solid var(--line); border-radius: 10px; }
.session { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 12px; min-height: 60px; }
.session + .session { border-top: 1px solid var(--line); }
.info { display: flex; flex-direction: column; min-width: 0; }
.tag { display: inline-block; margin-right: 8px; padding: 0 8px; border-radius: 999px; background: var(--ok-bg); color: var(--ok-text); font-size: 0.8rem; font-weight: 600; }
.when { color: var(--muted); font-size: 0.875rem; }
.actions { display: flex; flex-wrap: wrap; gap: 12px; }
.actions button { flex: 1 1 auto; }
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
    notEnded: "That session could not be ended. Reload the page.",
    sending: "Sending…",
    signingIn: "Signing in…",
    signingOut: "Signing out…",
    signedIn: "Signed in",
    signedInAs: "Signed in as ",
    of: " of ",
    used: " used",
    dot: " · ",
    oneTour: "1 tour",
    tours: " tours",
    thisBrowser: "This browser",
    since: "since ",
    lastUsed: "last used ",
    signOut: "Sign out",
    oneByte: "1 byte",
    bytes: " bytes",
  };
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  var $ = function (id) { return document.getElementById(id); };

  // Every request goes through here: to this site only, with the session the browser
  // keeps for this address, no referrer, and a JSON body labelled as JSON. A change made
  // with a session carries the anti-forgery value from GET /api/v1/session.
  function call(method, path, body, csrf) {
    var headers = {};
    var init = { method: method, headers: headers, credentials: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    if (csrf !== undefined) headers["X-Csrf-Token"] = csrf;
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

  // The server's own rule for sizes (formatBytes in src/usage.ts): 1024-based, three
  // significant digits. A test holds the two to the same table.
  function formatBytes(n) {
    if (n < 1024) return n === 1 ? TEXT.oneByte : n + TEXT.bytes;
    var units = ["KB", "MB", "GB"];
    var value = n;
    for (var i = 0; i < units.length; i++) {
      value /= 1024;
      var text = value < 9.995 ? value.toFixed(2) : value < 99.95 ? value.toFixed(1) : String(Math.round(value));
      if (Number(text) < 1024 || i === units.length - 1) return text + " " + units[i];
    }
    return n + TEXT.bytes;
  }

  // Day and short month, with the year when it is not this year.
  function dateOf(ms) {
    if (typeof ms !== "number" || !isFinite(ms)) return "";
    var d = new Date(ms);
    var text = d.getDate() + " " + MONTHS[d.getMonth()];
    return d.getFullYear() === new Date().getFullYear() ? text : text + " " + d.getFullYear();
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
    // Someone who is signed in already belongs on the account page.
    call("GET", "/api/v1/session").then(function (res) {
      if (res.status === 200) location.replace("/account");
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
          location.replace("/account");
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

  // The account: who, the storage, where the account is signed in, and the two sign-outs.
  // A visitor who is not signed in is sent to the sign-in page.
  function accountPage() {
    var csrf = "";
    var current = "";
    var message = $("account-message");

    function signedOut() {
      location.replace("/signin");
    }
    function notRead() {
      return false;
    }

    function showUsage(res) {
      if (res.status === 401) return "out";
      var u = res.data;
      if (res.status !== 200 || u === null || typeof u.used_bytes !== "number" || typeof u.tours !== "number") return false;
      var limit = typeof u.allowance_bytes === "number" ? u.allowance_bytes : null;
      var line = formatBytes(u.used_bytes);
      if (limit !== null) line += TEXT.of + formatBytes(limit);
      line += TEXT.used + TEXT.dot + (u.tours === 1 ? TEXT.oneTour : u.tours + TEXT.tours);
      say($("usage-text"), line);
      var bar = $("usage-bar");
      if (limit === null) {
        bar.hidden = true;
        return true;
      }
      var over = u.over === true;
      var share = over ? 100 : limit > 0 ? Math.min(100, (u.used_bytes / limit) * 100) : 0;
      $("usage-fill").style.width = Math.round(share * 100) / 100 + "%";
      if (over) bar.setAttribute("data-over", "true");
      else bar.removeAttribute("data-over");
      bar.hidden = false;
      return true;
    }

    function row(s, i) {
      var li = document.createElement("li");
      li.className = "session";
      var info = document.createElement("div");
      info.className = "info";
      var what = document.createElement("span");
      what.className = "what";
      if (s.current === true) {
        var tag = document.createElement("span");
        tag.className = "tag";
        say(tag, TEXT.thisBrowser);
        what.appendChild(tag);
      }
      var name = document.createElement("span");
      name.setAttribute("id", "session-" + i);
      say(name, String(s.label));
      what.appendChild(name);
      var when = document.createElement("span");
      when.className = "when";
      say(when, s.current === true ? TEXT.since + dateOf(s.created_at) : TEXT.lastUsed + dateOf(s.last_used_at));
      info.appendChild(what);
      info.appendChild(when);
      li.appendChild(info);
      if (s.current !== true) {
        var end = document.createElement("button");
        end.type = "button";
        end.className = "link";
        end.setAttribute("aria-describedby", "session-" + i);
        say(end, TEXT.signOut);
        end.addEventListener("click", function () { endSession(String(s.id), li, end); });
        li.appendChild(end);
      }
      return li;
    }

    function showSessions(res) {
      if (res.status === 401) return "out";
      if (res.status !== 200 || res.data === null || !Array.isArray(res.data.sessions)) return false;
      var list = $("sessions");
      for (var i = 0; i < res.data.sessions.length; i++) list.appendChild(row(res.data.sessions[i], i));
      return true;
    }

    // Ending one session from the list. Ending this browser's own is a sign-out.
    function endSession(id, li, btn) {
      if (btn.disabled) return;
      say(message, "");
      busy(btn, true, TEXT.signingOut);
      call("DELETE", "/api/v1/sessions/" + encodeURIComponent(id), undefined, csrf).then(function (res) {
        if (res.status === 401 || (res.status === 204 && id === current)) { signedOut(); return; }
        if (res.status === 204) {
          li.remove();
          $("h-where").focus();
          return;
        }
        busy(btn, false);
        say(message, TEXT.notEnded);
      }, function () {
        busy(btn, false);
        say(message, TEXT.notEnded);
      });
    }

    // What a sign-out button does while its request runs, and after.
    function leaving(btn, other) {
      say(message, "");
      busy(btn, true, TEXT.signingOut);
      other.disabled = true;
      function back() {
        busy(btn, false);
        other.disabled = false;
        say(message, TEXT.failed);
        btn.focus();
      }
      return {
        ok: function (res) {
          if (res.status === 204 || res.status === 401) { signedOut(); return; }
          back();
        },
        fail: back,
      };
    }

    $("signout").addEventListener("click", function () {
      if ($("signout").disabled) return;
      var done = leaving($("signout"), $("signout-everywhere"));
      call("POST", "/api/v1/signout", undefined, csrf).then(done.ok, done.fail);
    });
    $("signout-everywhere").addEventListener("click", function () {
      if ($("signout-everywhere").disabled) return;
      var done = leaving($("signout-everywhere"), $("signout"));
      call("POST", "/api/v1/signout/everywhere", undefined, csrf).then(done.ok, done.fail);
    });

    call("GET", "/api/v1/session").then(function (res) {
      if (res.status === 401) { signedOut(); return; }
      if (res.status !== 200 || res.data === null || typeof res.data !== "object") { say($("load-message"), TEXT.failed); return; }
      if (typeof res.data.csrf !== "string" || res.data.account === null || typeof res.data.account !== "object" || res.data.session === null || typeof res.data.session !== "object") {
        say($("load-message"), TEXT.failed);
        return;
      }
      csrf = res.data.csrf;
      current = String(res.data.session.id);
      // The title stays the site's name until someone is known to be signed in.
      document.title = TEXT.signedIn;
      var who = res.data.account;
      say($("h-account"), typeof who.username === "string" && who.username !== "" ? TEXT.signedInAs + who.username : TEXT.signedIn);
      say($("account-email"), typeof who.email === "string" ? who.email : "");
      return Promise.all([
        call("GET", "/api/v1/usage").then(showUsage, notRead),
        call("GET", "/api/v1/sessions").then(showSessions, notRead),
      ]).then(function (shown) {
        if (shown[0] === "out" || shown[1] === "out") { signedOut(); return; }
        if (shown[0] !== true || shown[1] !== true) say(message, TEXT.failed);
        $("load-message").hidden = true;
        $("account").hidden = false;
      });
    }).then(null, function () {
      say($("load-message"), TEXT.failed);
    });
  }

  var page = document.body.getAttribute("data-page");
  if (page === "link") linkPage(codeOf(fragment));
  else if (page === "signin") signinPage();
  else if (page === "account") accountPage();
  fragment = "";
})();
`;

/** Placeholder: written after its tests. */
export function signinHtml(_contact: import("./invite.ts").InviteContact | null): string {
  return SIGNIN_HTML;
}
