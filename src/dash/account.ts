// The Account page of the dashboard, /account, as in the approved mockups 7 and 8: who is
// signed in, the account's details (the username, the email address with a Change button,
// the workspace) and where the account is signed in, with a Sign out for each other browser
// and the two buttons Sign out and Sign out everywhere. It replaces the account page the
// sign-in pages had (src/signin/page.ts until this version); its storage block is the
// Storage page now. Its body is fixed text; its script, /dash/account.js, fills it through
// textContent, so a username, a workspace's name, an address or a session's label can never
// become markup.
//
// The terms line (0.1.53), at the end of the details: "You agreed to the terms of <version> on
// <date>." with a check mark and "Read them", which opens the version agreed to, read-only
// (/terms?read). Filled from the session answer's terms_agreed (no request more) through
// textContent; hidden when the account has agreed to no version, so a site without terms reads
// as before.
//
// The download card (Plan 2i), between the details and the sessions: shown only when the
// session names a usable address of the app's download page (download_url, checked again by
// the shared script), with a link that opens it in a new tab; hidden otherwise, so without
// the setting the page reads as before.
//
// "Download all my data" (billing mockups, section 7), after the download card, in every state
// of the account and whether billing is on or off: its heading, its one sentence and a Download
// button. Download asks POST /api/v1/account/data, then opens the address it answers as a plain
// download (Dash.saveFile, src/dash/script.ts), so the browser saves the zip as
// it arrives and the page stays. While it asks, the button is disabled, with no words more; a
// request that fails says the dashboard's own failure sentence (Dash.failure) under it.
//
// Changing the email address, mockup 8's first two boxes: Change is shown only when the
// session says the site can mail the link (email_change); otherwise one line under the
// address says why. Change opens a question with the field for the new address; Send the
// link checks the address's shape in the page, then asks POST /api/v1/account/email. Every
// 200 answer shows the second box, "Check <new address>", which names the present address:
// the server answers the same for an address that is free, another account's or the
// account's own, and so does this page. The address changes only when the mailed link is
// opened and confirmed (src/dash/account-email.ts).
//
// The two boxes are the dashboard's one question helper (Dash.question, src/dash/script.ts):
// while one is open the bar and the page are inert and hidden from screen
// readers, Escape and Tab are handled for the whole document, a click on the backdrop is
// Cancel (or Done), and while the request runs nothing closes it, its controls are disabled
// and the focus stays inside it. When a box closes the focus goes back to Change. Message
// lines are hidden while they have nothing to say.
import { dashHtml } from "./shell.ts";

const ACCOUNT_MAIN = `  <div id="account-page">
  <h1 id="h-page" tabindex="-1">Account</h1>
  <section id="account" aria-labelledby="h-page" hidden>
    <p class="sub" id="account-who"></p>
    <div class="card">
      <h2 class="card-title" id="h-details" tabindex="-1">Your details</h2>
      <div class="row" id="row-username"><span>Username</span><span class="r" id="account-username"></span></div>
      <div class="row"><span>Email address</span><span class="r"><span id="account-email"></span><button type="button" class="btn sm quiet" id="email-change" hidden>Change</button></span></div>
      <p class="hint" id="email-off" hidden>This site cannot send mail, so an email address cannot be changed here.</p>
      <div class="row"><span>Workspace</span><span class="r" id="account-workspace"></span></div>
      <p class="terms-agreed" id="terms-agreed" hidden><span class="terms-check" aria-hidden="true">✓</span> <span id="terms-agreed-text"></span> <a href="/terms?read" id="terms-read">Read them</a></p>
    </div>
    <div class="card" id="download-card" hidden>
      <h2 class="card-title" id="h-download" tabindex="-1">Mythicshot for Windows</h2>
      <p class="sub" id="download-text">Get the installer from the download page. It shows the latest version and its checksum.</p>
      <div class="two" id="download-actions"></div>
    </div>
    <div class="card" id="data-card">
      <h2 class="card-title" id="h-data" tabindex="-1">Download all my data</h2>
      <p class="sub" id="data-text">One zip file with your tours, images and clips, and a list of what's in your account.</p>
      <p class="message" id="data-message" role="status" aria-live="polite" hidden></p>
      <div class="two">
        <button type="button" class="btn quiet" id="data-download">Download</button>
      </div>
    </div>
    <div class="card">
      <h2 class="card-title" id="h-where" tabindex="-1">Where you are signed in</h2>
      <ul class="sessions" id="sessions" aria-labelledby="h-where"></ul>
      <p class="message" id="account-message" role="status" aria-live="polite" hidden></p>
      <div class="two">
        <button type="button" class="btn quiet" id="signout">Sign out</button>
        <button type="button" class="btn quiet" id="signout-everywhere">Sign out everywhere</button>
      </div>
    </div>
  </section>
  </div>
  <div class="backdrop" id="change-dialog" hidden>
    <div class="dialog" id="change-box" role="dialog" aria-modal="true" aria-labelledby="change-title" aria-describedby="change-hint">
      <h2 id="change-title" tabindex="-1">Change your email address</h2>
      <label class="field-label" for="change-email">New email address</label>
      <input class="field" id="change-email" type="email" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="254" aria-describedby="change-hint change-message">
      <p class="hint" id="change-hint">We send a link to the new address. Your address changes when you open it.</p>
      <p class="message" id="change-message" role="status" aria-live="polite" hidden></p>
      <div class="two">
        <button type="button" class="btn quiet" id="change-cancel">Cancel</button>
        <button type="button" class="btn" id="change-send">Send the link</button>
      </div>
    </div>
  </div>
  <div class="backdrop" id="sent-dialog" hidden>
    <div class="dialog" id="sent-box" role="dialog" aria-modal="true" aria-labelledby="sent-title" aria-describedby="sent-text">
      <h2 id="sent-title" tabindex="-1"></h2>
      <p class="sub" id="sent-text">Open the link we sent there to finish. It works once and for 15 minutes. Until then you keep signing in with <span class="address" id="sent-old"></span>.</p>
      <div class="two">
        <button type="button" class="btn quiet" id="sent-done">Done</button>
      </div>
    </div>
  </div>`;

/** The Account page: the shell with the page's body and its own script. */
export const ACCOUNT_HTML = dashHtml({ title: "Account", active: "account", main: ACCOUNT_MAIN, script: "/dash/account.js" });

export const ACCOUNT_JS = `(function () {
  "use strict";
  var TEXT = {
    signedIn: "Signed in",
    signedInAs: "Signed in as ",
    thisBrowser: "This browser",
    since: "since ",
    lastUsed: "last used ",
    signOut: "Sign out",
    signingOut: "Signing out…",
    notEnded: "That session could not be ended. Reload the page.",
    badEmail: "That does not look like an email address.",
    sending: "Sending…",
    checkBefore: "Check ",
    openDownload: "Open the download page",
    ends: "Ends ",
    agreedBefore: "You agreed to the terms of ",
    agreedMiddle: " on ",
    agreedAfter: ".",
  };
  // What the page behind a box is, made inert while one is open.
  var BEHIND = ["dash-top", "account-page"];

  var $ = function (id) { return document.getElementById(id); };
  // This browser's session, and the account's address as the session gave it.
  var current = "";
  var email = "";
  // The two boxes (Dash.question, src/dash/script.ts). Each gives the focus back to Change.
  var change = Dash.question({ backdrop: "change-dialog", box: "change-box", role: "dialog", title: "change-title", message: "change-message", behind: BEHIND, fields: ["change-email"], buttons: ["change-cancel", "change-send"], lock: "disabled" });
  var sent = Dash.question({ backdrop: "sent-dialog", box: "sent-box", role: "dialog", title: "sent-title", behind: BEHIND, buttons: ["sent-done"] });
  function toChange() { return $("email-change"); }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // A message line is hidden while it has nothing to say.
  function sayIn(line, text) {
    line.textContent = text;
    line.hidden = text === "";
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

  // The same check as the sign-in page's: one @ with something on each side, no space.
  function looksLikeEmail(v) {
    if (v.length === 0 || v.length > 254 || /\\s/.test(v)) return false;
    var parts = v.split("@");
    return parts.length === 2 && parts[0] !== "" && parts[1] !== "";
  }

  // ---- Where the account is signed in ----

  function row(s, i) {
    var li = el("li", "row session");
    var what = el("span", "what");
    if (s.current === true) what.appendChild(el("span", "tag ok", TEXT.thisBrowser));
    var name = el("span", "", String(s.label));
    name.setAttribute("id", "session-" + i);
    what.appendChild(name);
    li.appendChild(what);
    var right = el("span", "r");
    right.appendChild(el("span", "when", s.current === true ? TEXT.since + Dash.dateOf(s.created_at) : TEXT.lastUsed + Dash.dateOf(s.last_used_at)));
    // When it ends however much it is used (SESSION_MAX_DAYS); nothing when that limit is off.
    if (typeof s.ends_at === "number" && isFinite(s.ends_at)) right.appendChild(el("span", "when", TEXT.ends + Dash.dateOf(s.ends_at)));
    if (s.current !== true) {
      var end = el("button", "btn sm quiet", TEXT.signOut);
      end.type = "button";
      end.setAttribute("aria-describedby", "session-" + i);
      end.addEventListener("click", function () { endSession(String(s.id), li, end); });
      right.appendChild(end);
    }
    li.appendChild(right);
    return li;
  }

  // True when shown, "out" when the session is gone, or the answer that failed (null: none came).
  function showSessions(res) {
    if (res.status === 401) return "out";
    if (res.status !== 200 || res.data === null || typeof res.data !== "object" || !Array.isArray(res.data.sessions)) return res;
    var list = $("sessions");
    list.textContent = "";
    for (var i = 0; i < res.data.sessions.length; i++) {
      var s = res.data.sessions[i];
      if (s !== null && typeof s === "object") list.appendChild(row(s, i));
    }
    return true;
  }

  // Ending one session from the list. Ending this browser's own is a sign-out.
  function endSession(id, li, btn) {
    if (btn.disabled) return;
    var message = $("account-message");
    sayIn(message, "");
    busy(btn, true, TEXT.signingOut);
    Dash.api("DELETE", "/api/v1/sessions/" + encodeURIComponent(id)).then(function (res) {
      if (res.status === 401 || (res.status === 204 && id === current)) { Dash.signedOut(); return; }
      if (res.status === 204) {
        li.remove();
        $("h-where").focus();
        return;
      }
      busy(btn, false);
      sayIn(message, TEXT.notEnded);
    }, function () {
      busy(btn, false);
      sayIn(message, TEXT.notEnded);
    });
  }

  // What a sign-out button does while its request runs (made by send), and after.
  function leave(btn, other, send) {
    if (btn.disabled) return;
    var message = $("account-message");
    sayIn(message, "");
    busy(btn, true, TEXT.signingOut);
    other.disabled = true;
    function back(res) {
      busy(btn, false);
      other.disabled = false;
      sayIn(message, Dash.failure(res));
      btn.focus();
    }
    send().then(function (res) {
      if (res.status === 204 || res.status === 401) { Dash.signedOut(); return; }
      back(res);
    }, function () { back(null); });
  }

  // ---- Changing the email address ----

  function openChange() {
    if (change.isOpen() || sent.isOpen()) return;
    var input = $("change-email");
    input.value = "";
    input.removeAttribute("aria-invalid");
    change.open({ focus: "change-email", back: toChange });
  }

  function invalid() {
    var input = $("change-email");
    change.say(TEXT.badEmail);
    input.setAttribute("aria-invalid", "true");
    input.focus();
  }

  // The second box, for every 200 answer, whatever the address was. It names the address as
  // the server stores it: trimmed and lower-case (the server's parseEmail takes only
  // visible ASCII, so lower-case here is the same).
  function showSent(value) {
    change.close(false);
    $("sent-old").textContent = email;
    sent.open({ title: TEXT.checkBefore + value.toLowerCase(), focus: "sent-done", back: toChange });
  }

  // The sentence for a request that did not do what was asked: the server's own when the
  // site's mail is off, else the approved one.
  function problem(res) {
    if (res !== null && res.status === 409 && Dash.errorOf(res) === "mail_off" && typeof res.data.detail === "string") return res.data.detail;
    return Dash.failure(res);
  }

  function sendLink() {
    if (!change.isOpen() || change.isWorking()) return;
    var input = $("change-email");
    var value = input.value.trim();
    if (!looksLikeEmail(value)) { invalid(); return; }
    input.removeAttribute("aria-invalid");
    change.say("");
    change.busy(true, "change-send", TEXT.sending);
    function settle(res) {
      if (res !== null && res.status === 401) { Dash.signedOut(); return; }
      change.busy(false, "change-send");
      if (res !== null && res.status === 200) { showSent(value); return; }
      if (res !== null && res.status === 400 && Dash.errorOf(res) === "bad_email") { invalid(); return; }
      change.say(problem(res));
      $("change-send").focus();
    }
    Dash.api("POST", "/api/v1/account/email", { email: value }).then(settle, function () { settle(null); });
  }

  // ---- Download all my data ----

  // The address the server answers for the file: one path of this site, of exactly this shape.
  var DATA_URL = /^\\/api\\/v1\\/account\\/data\\/[0-9a-f]{76}$/;

  function downloadData() {
    var btn = $("data-download");
    if (btn.disabled) return;
    var message = $("data-message");
    sayIn(message, "");
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    function ready() {
      btn.removeAttribute("aria-busy");
      btn.disabled = false;
    }
    function back(res) {
      ready();
      sayIn(message, Dash.failure(res));
      btn.focus();
    }
    Dash.api("POST", "/api/v1/account/data").then(function (res) {
      if (res.status === 401) { Dash.signedOut(); return; }
      var url = res.status === 200 && res.data !== null && typeof res.data === "object" ? res.data.url : null;
      if (typeof url !== "string" || !DATA_URL.test(url)) { back(res); return; }
      // A plain download of this site's own address: the browser writes the file as it comes.
      Dash.saveFile(url, "mythicshot-data.zip");
      ready();
    }, function () { back(null); });
  }

  function startPage() {
    $("data-download").addEventListener("click", downloadData);
    $("signout").addEventListener("click", function () {
      leave($("signout"), $("signout-everywhere"), function () { return Dash.api("POST", "/api/v1/signout"); });
    });
    $("signout-everywhere").addEventListener("click", function () {
      leave($("signout-everywhere"), $("signout"), function () { return Dash.api("POST", "/api/v1/signout/everywhere"); });
    });
    $("email-change").addEventListener("click", openChange);
    $("change-cancel").addEventListener("click", function () { change.dismiss(); });
    $("change-send").addEventListener("click", sendLink);
    $("sent-done").addEventListener("click", function () { sent.dismiss(); });
    $("change-email").addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      sendLink();
    });
  }

  // The download card, only when the session named a usable address of the app's download
  // page: the shared script checks it and makes the link (Dash.downloadLink).
  function showDownload() {
    var link = Dash.downloadLink(TEXT.openDownload, "btn quiet");
    if (link === null) return;
    $("download-actions").appendChild(link);
    $("download-card").hidden = false;
  }

  // The line under the details: the version of the site's terms the account agreed to last,
  // and when, with "Read them"; hidden when it has agreed to none (a site without terms).
  function showAgreement(agreed) {
    if (agreed === null || typeof agreed !== "object") return;
    $("terms-agreed-text").textContent = TEXT.agreedBefore + agreed.version + TEXT.agreedMiddle + Dash.dateOf(agreed.agreedAt, true) + TEXT.agreedAfter;
    $("terms-agreed").hidden = false;
  }

  startPage();
  Dash.start(function (who) {
    current = who.sessionId;
    showDownload();
    email = who.email;
    $("account-who").textContent = who.named ? TEXT.signedInAs + who.username : TEXT.signedIn;
    $("row-username").hidden = !who.named;
    $("account-username").textContent = who.named ? who.username : "";
    $("account-email").textContent = email;
    $("account-workspace").textContent = who.workspace;
    $("email-change").hidden = !who.emailChange;
    $("email-off").hidden = who.emailChange;
    showAgreement(who.agreed);
    return Dash.api("GET", "/api/v1/sessions").then(showSessions, function () { return null; }).then(function (shown) {
      if (shown === "out") { Dash.signedOut(); return; }
      if (shown !== true) sayIn($("account-message"), Dash.failure(shown));
      $("account").hidden = false;
    });
  });
})();
`;
