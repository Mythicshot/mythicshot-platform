// The setup wizard's page, stylesheet and script, served by src/setup.ts while setup is
// open. They live in this module as strings so both targets serve them the same way,
// with no build step and no static folder, and so they disappear with the setup routes
// once setup is complete. Wording and order follow the approved mockup.
//
// The script sets text only through textContent and keeps the code and the token in
// memory, never in storage, a cookie or a URL.

export const SETUP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>Set up your tour site</title>
<link rel="stylesheet" href="/setup/setup.css">
<script src="/setup/setup.js" defer></script>
</head>
<body>
<main class="card">
  <div class="progress" aria-hidden="true"><span data-n="1"></span><span data-n="2"></span><span data-n="3"></span><span data-n="4"></span></div>
  <p class="sr-only" id="progress-text" aria-live="polite">Step 1 of 4</p>

  <section id="step-1" data-step="1" aria-labelledby="h-1">
    <h1 id="h-1" tabindex="-1">Set up your tour site</h1>
    <p class="lead">Enter the setup code you chose when you installed. It stops anyone else from claiming this site.</p>
    <form id="form-1" method="post" novalidate>
      <div class="field">
        <label for="code">Setup code</label>
        <input id="code" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="1024" aria-describedby="error-1" required>
      </div>
      <p class="error" id="error-1" role="alert" hidden></p>
      <div class="actions end">
        <button type="submit" class="primary" id="continue-1">Continue</button>
      </div>
    </form>
  </section>

  <section id="step-2" data-step="2" aria-labelledby="h-2" hidden>
    <h1 id="h-2" tabindex="-1">Name your workspace</h1>
    <p class="lead">Your tours, chapters and viewing data belong to this workspace.</p>
    <form id="form-2" method="post" novalidate>
      <div class="field">
        <label for="workspace">Workspace name</label>
        <input id="workspace" type="text" autocomplete="organization" maxlength="80" aria-describedby="error-workspace" required>
        <p class="error" id="error-workspace" hidden></p>
      </div>
      <div class="field">
        <label for="email">Owner email</label>
        <input id="email" type="email" autocomplete="email" autocapitalize="off" spellcheck="false" maxlength="254" aria-describedby="error-email" required>
        <p class="error" id="error-email" hidden></p>
      </div>
      <p class="error" id="error-2" role="alert" hidden></p>
      <div class="actions">
        <button type="button" class="secondary" id="back-2">Back</button>
        <button type="submit" class="primary" id="continue-2">Continue</button>
      </div>
    </form>
  </section>

  <section id="step-3" data-step="3" aria-labelledby="h-3" hidden>
    <h1 id="h-3" tabindex="-1">Copy your API token</h1>
    <p class="lead">Mythicshot uses this to upload tours. It is shown once and can&#39;t be recovered.</p>
    <div class="copy">
      <code id="token" class="value" aria-label="API token"></code>
      <button type="button" class="secondary" id="copy-token">Copy</button>
    </div>
    <p class="note warn"><svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false"><path d="M10 2.5 18 17H2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M10 8v4.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="10" cy="14.6" r="0.95" fill="currentColor"/></svg><span>Anyone with this token can upload to and unpublish your tours.</span></p>
    <label class="tick"><input type="checkbox" id="saved"><span>I&#39;ve saved the token</span></label>
    <div class="actions end">
      <button type="button" class="primary" id="continue-3" disabled>Continue</button>
    </div>
  </section>

  <section id="step-4" data-step="4" aria-labelledby="h-4" hidden>
    <h1 id="h-4" tabindex="-1">Connect Mythicshot</h1>
    <p class="lead">In Mythicshot, open Settings › Output › Tour publishing and paste these, then press Test connection.</p>
    <p class="label" id="address-label">Server address</p>
    <div class="copy">
      <code id="address" class="value" aria-labelledby="address-label"></code>
      <button type="button" class="secondary" id="copy-address">Copy</button>
    </div>
    <p class="status" id="status" role="status" data-state="waiting"><span class="dot" aria-hidden="true"></span><span id="status-text">Waiting for Mythicshot to connect…</span></p>
    <div class="actions end">
      <button type="button" class="primary" id="finish">Finish</button>
    </div>
  </section>

  <section id="step-5" data-step="5" aria-labelledby="h-5" hidden>
    <h1 id="h-5" tabindex="-1">Your tour site is ready</h1>
    <p class="lead">Setup is complete. You can close this page.</p>
  </section>
</main>
</body>
</html>
`;

export const SETUP_CSS = `:root {
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
  --warn-bg: #f8eedb;
  --warn-text: #66450d;
  --ok-bg: #e3efe8;
  --ok-text: #2b5a47;
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
    --warn-bg: #362c1b;
    --warn-text: #efd19a;
    --ok-bg: #1d3128;
    --ok-text: #a8d7c2;
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
}
.progress { display: flex; gap: 6px; margin-bottom: 26px; }
.progress span { flex: 1; height: 4px; border-radius: 4px; background: var(--line); transition: background-color 0.25s ease; }
.progress span.done { background: var(--accent); }
.progress span.current { background: var(--accent); opacity: 0.55; }
h1 { font-size: 1.375rem; line-height: 1.3; font-weight: 650; margin: 0 0 8px; letter-spacing: -0.01em; }
h1:focus { outline: none; }
.lead { margin: 0 0 22px; color: var(--muted); }
.field { margin-bottom: 16px; }
label, .label { display: block; font-size: 0.9rem; font-weight: 600; margin: 0 0 6px; }
input[type="text"], input[type="email"], input[type="password"] {
  width: 100%;
  min-height: 44px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--field);
  color: var(--text);
  font: inherit;
}
input[type="text"]:focus-visible, input[type="email"]:focus-visible, input[type="password"]:focus-visible {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
input[aria-invalid="true"] { border-color: var(--error); }
.error { color: var(--error); font-size: 0.9rem; margin: 6px 0 0; }
form > .error { margin: 0 0 12px; }
.actions { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 22px; }
.actions.end { justify-content: flex-end; }
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
button.primary { background: var(--accent); color: var(--accent-text); min-width: 112px; }
button.primary:hover:not(:disabled) { opacity: 0.9; }
button.secondary { background: transparent; color: var(--text); border-color: var(--line); }
button.secondary:hover:not(:disabled) { background: var(--bg); }
button:disabled { opacity: 0.45; cursor: not-allowed; }
button[aria-busy="true"] { cursor: progress; }
.copy { display: flex; align-items: stretch; gap: 8px; margin-bottom: 16px; }
.copy .value {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--field);
  font: 0.9rem/1.45 ui-monospace, "Cascadia Mono", Consolas, "SF Mono", Menlo, monospace;
  word-break: break-all;
  user-select: all;
}
.copy button { flex: none; min-width: 84px; }
.note { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border-radius: 10px; margin: 0 0 18px; font-size: 0.925rem; }
.note svg { flex: none; margin-top: 2px; }
.warn { background: var(--warn-bg); color: var(--warn-text); }
.tick { display: flex; align-items: center; gap: 10px; font-weight: 500; font-size: 1rem; cursor: pointer; margin: 0; }
.tick input { width: 20px; height: 20px; margin: 0; accent-color: var(--accent); }
.tick input:focus-visible { outline: 3px solid var(--accent-soft); outline-offset: 2px; }
.status { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-radius: 10px; margin: 4px 0 0; background: var(--bg); color: var(--muted); font-size: 0.95rem; }
.status .dot { flex: none; width: 10px; height: 10px; border-radius: 50%; background: var(--muted); animation: breathe 1.8s ease-in-out infinite; }
.status[data-state="connected"] { background: var(--ok-bg); color: var(--ok-text); }
.status[data-state="connected"] .dot { background: var(--ok-text); animation: none; }
@keyframes breathe { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .status .dot { animation: none; }
  .progress span, button { transition: none; }
}
@media (max-width: 480px) {
  body { align-items: flex-start; padding-top: 24px; }
  .card { padding: 22px 18px 20px; border-radius: 14px; }
  .copy { flex-wrap: wrap; }
  .copy .value { flex-basis: 100%; }
  .copy button { margin-left: auto; }
}
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.offscreen { position: fixed; left: -9999px; top: 0; opacity: 0; }
`;

export const SETUP_JS = `(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var code = "";
  var token = "";
  var poll = 0;

  var MESSAGES = {
    emptyCode: "Enter the setup code.",
    wrongCode: "That setup code isn\\u2019t right.",
    taken: "This site has already been set up.",
    failed: "Something went wrong. Try again.",
    workspace: "Enter a name of 1 to 80 characters.",
    email: "Enter an email address like name@example.com.",
    connected: "Mythicshot is connected.",
  };

  function show(n) {
    var sections = document.querySelectorAll("section[data-step]");
    for (var i = 0; i < sections.length; i++) sections[i].hidden = sections[i].getAttribute("data-step") !== String(n);
    var bars = document.querySelectorAll(".progress span");
    for (var j = 0; j < bars.length; j++) {
      var k = j + 1;
      bars[j].className = k < n ? "done" : k === n ? "current" : "";
    }
    if (n <= 4) $("progress-text").textContent = "Step " + n + " of 4";
  }

  function go(n) {
    show(n);
    var h = $("h-" + n);
    if (h) h.focus();
  }

  function setError(id, text, input) {
    var el = $(id);
    el.textContent = text || "";
    el.hidden = !text;
    if (input) {
      if (text) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
    }
  }

  function busy(btn, on) {
    btn.disabled = on;
    if (on) btn.setAttribute("aria-busy", "true");
    else btn.removeAttribute("aria-busy");
  }

  function postJson(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    }).then(function (r) {
      return r.text().then(function (t) {
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
        return { status: r.status, data: data };
      });
    });
  }

  function copyText(text, btn) {
    function done() {
      btn.textContent = "Copied";
      setTimeout(function () { btn.textContent = "Copy"; }, 2000);
    }
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.className = "offscreen";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (e) { /* the text stays selectable */ }
      document.body.removeChild(ta);
      btn.focus();
      done();
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }

  function validName(v) {
    var s = v.trim();
    return s.length >= 1 && s.length <= 80 && !/[\\u0000-\\u001f\\u007f-\\u009f]/.test(s);
  }

  function validEmail(v) {
    var s = v.trim();
    if (s.length > 254 || /\\s/.test(s)) return false;
    var parts = s.split("@");
    return parts.length === 2 && parts[0] !== "" && parts[1] !== "";
  }

  // Step 1: the setup code.
  $("form-1").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var input = $("code");
    var btn = $("continue-1");
    var value = input.value;
    if (value === "") { setError("error-1", MESSAGES.emptyCode, input); input.focus(); return; }
    setError("error-1", "", input);
    busy(btn, true);
    postJson("/setup/check", { code: value }).then(function (res) {
      busy(btn, false);
      if (res.status === 204) { code = value; show(2); $("workspace").focus(); return; }
      var msg = res.status === 403 && res.data && res.data.error === "wrong_code" ? MESSAGES.wrongCode
        : res.status === 404 ? MESSAGES.taken : MESSAGES.failed;
      setError("error-1", msg, input);
      input.focus();
    }, function () {
      busy(btn, false);
      setError("error-1", MESSAGES.failed, null);
    });
  });

  // Step 2: the workspace and its owner.
  $("back-2").addEventListener("click", function () {
    setError("error-2", "", null);
    show(1);
    $("code").focus();
  });

  $("form-2").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var nameInput = $("workspace");
    var emailInput = $("email");
    var btn = $("continue-2");
    var okName = validName(nameInput.value);
    var okEmail = validEmail(emailInput.value);
    setError("error-workspace", okName ? "" : MESSAGES.workspace, nameInput);
    setError("error-email", okEmail ? "" : MESSAGES.email, emailInput);
    setError("error-2", "", null);
    if (!okName) { nameInput.focus(); return; }
    if (!okEmail) { emailInput.focus(); return; }
    busy(btn, true);
    $("back-2").disabled = true;
    postJson("/setup/claim", { code: code, workspace: nameInput.value, email: emailInput.value }).then(function (res) {
      busy(btn, false);
      $("back-2").disabled = false;
      var err = res.data && res.data.error;
      if (res.status === 201 && res.data && typeof res.data.token === "string") {
        token = res.data.token;
        code = "";
        $("code").value = "";
        $("token").textContent = token;
        go(3);
        return;
      }
      if (res.status === 400 && err === "bad_workspace") { setError("error-workspace", MESSAGES.workspace, nameInput); nameInput.focus(); return; }
      if (res.status === 400 && err === "bad_email") { setError("error-email", MESSAGES.email, emailInput); emailInput.focus(); return; }
      if (res.status === 403 && err === "wrong_code") { code = ""; show(1); setError("error-1", MESSAGES.wrongCode, $("code")); $("code").focus(); return; }
      setError("error-2", res.status === 404 ? MESSAGES.taken : MESSAGES.failed, null);
    }, function () {
      busy(btn, false);
      $("back-2").disabled = false;
      setError("error-2", MESSAGES.failed, null);
    });
  });

  // Step 3: the token, shown once.
  $("copy-token").addEventListener("click", function () { copyText(token, $("copy-token")); });
  $("saved").addEventListener("change", function () { $("continue-3").disabled = !$("saved").checked; });
  $("continue-3").addEventListener("click", function () {
    if (!$("saved").checked) return;
    go(4);
    startPolling();
  });

  // Step 4: the server address and the live connection check.
  $("address").textContent = location.origin;
  $("copy-address").addEventListener("click", function () { copyText(location.origin, $("copy-address")); });

  function check() {
    fetch("/api/v1/setup/connected", {
      headers: { authorization: "Bearer " + token },
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    }).then(function (r) { return r.ok ? r.json() : null; }).then(function (data) {
      if (data && data.connected === true) {
        stopPolling();
        $("status").setAttribute("data-state", "connected");
        $("status-text").textContent = MESSAGES.connected;
      }
    }, function () { /* try again on the next tick */ });
  }

  function startPolling() {
    if (poll) return;
    check();
    poll = setInterval(check, 3000);
  }

  function stopPolling() {
    if (poll) clearInterval(poll);
    poll = 0;
  }

  $("finish").addEventListener("click", function () {
    stopPolling();
    token = "";
    $("token").textContent = "";
    go(5);
  });

  show(1);
  $("code").focus();
})();
`;
