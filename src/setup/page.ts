// The setup wizard's page, stylesheet and script, served by src/setup.ts while setup is
// open. They live in this module as strings so both targets serve them the same way,
// with no build step and no static folder, and so they disappear with the setup routes
// once setup is complete. Wording and order follow the approved mockup.
//
// The script sets text only through textContent and keeps the code and the token in
// memory, never in storage, a cookie or a URL.
import { PAGE_BASE_CSS } from "../brand-css.ts";
import { FAVICON_LINKS } from "../brand.ts";

export const SETUP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>Set up your tour site</title>
${FAVICON_LINKS}
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

export const SETUP_CSS = `${PAGE_BASE_CSS}*, *::before, *::after { box-sizing: border-box; }
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
}
.progress { display: flex; gap: 6px; margin-bottom: 24px; }
.progress span { flex: 1; height: 4px; border-radius: var(--radius-sm); background: var(--border); transition: background-color 0.25s ease; }
.progress span.done { background: var(--primary); }
.progress span.current { background: var(--primary); opacity: 0.55; }
h1 { font-size: 24px; line-height: 32px; font-weight: 700; margin: 0 0 8px; }
h1:focus { outline: none; }
.lead { margin: 0 0 24px; color: var(--text-muted); }
.field { margin-bottom: 16px; }
label, .label { display: block; font-size: 13px; line-height: 18px; font-weight: 600; margin: 0 0 4px; }
input[type="text"], input[type="email"], input[type="password"] {
  width: 100%;
  min-height: var(--control-roomy);
  padding: 10px 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  background: var(--surface);
  color: var(--text);
  font: inherit;
}
input[aria-invalid="true"] { border-color: var(--danger-border); box-shadow: inset 0 0 0 1px var(--danger-border); }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.error { color: var(--danger-text); font-size: 14px; line-height: 20px; margin: 6px 0 0; }
form > .error { margin: 0 0 12px; }
.actions { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 24px; }
.actions.end { justify-content: flex-end; }
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
button.primary { background: var(--primary); border-color: var(--primary); color: var(--on-primary); min-width: 112px; }
button.primary:hover:not(:disabled) { background: var(--primary-hover); border-color: var(--primary-hover); }
button.secondary { background: var(--surface); color: var(--text); border-color: var(--border-strong); }
button.secondary:hover:not(:disabled) { background: var(--ground); border-color: var(--text-muted); }
button:disabled { opacity: 0.45; cursor: not-allowed; }
button[aria-busy="true"] { cursor: progress; }
.copy { display: flex; align-items: stretch; gap: 8px; margin-bottom: 16px; }
.copy .value {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  padding: 10px 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  background: var(--ground);
  font: 13px/20px var(--font-mono);
  word-break: break-all;
  user-select: all;
}
.copy button { flex: none; min-width: 84px; }
.note { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border-radius: var(--radius-md); margin: 0 0 18px; font-size: 15px; line-height: 22px; }
.note svg { flex: none; margin-top: 2px; }
.warn { border: 1px solid var(--caution-border); background: var(--caution-tint); color: var(--caution-text); }
.warn svg { color: var(--caution-border); }
.tick { display: flex; align-items: center; gap: 10px; font-weight: 500; font-size: 16px; cursor: pointer; margin: 0; }
.tick input { width: 20px; height: 20px; margin: 0; accent-color: var(--primary); }
.status { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius-md); margin: 4px 0 0; background: var(--ground); color: var(--text-muted); font-size: 15px; }
.status .dot { flex: none; width: 10px; height: 10px; border-radius: 50%; background: var(--text-muted); animation: breathe 1.8s ease-in-out infinite; }
.status[data-state="connected"] { border-color: var(--success-border); background: var(--success-tint); color: var(--success-text); }
.status[data-state="connected"] .dot { background: var(--success-text); animation: none; }
@keyframes breathe { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .status .dot { animation: none; }
  .progress span, button { transition: none; }
}
@media (max-width: 480px) {
  body { align-items: flex-start; padding-top: 24px; }
  .card { padding: 24px 18px 20px; }
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

  // Controls and characters that are invisible or reorder text; the server refuses them too.
  var HIDDEN = /[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\u2028\\u2029\\ufeff]/;

  function validName(v) {
    var s = v.trim();
    return s.length >= 1 && s.length <= 80 && !HIDDEN.test(s);
  }

  function validEmail(v) {
    var s = v.trim();
    if (s.length > 254 || /\\s/.test(s) || HIDDEN.test(s)) return false;
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
