// The Connections page of the dashboard, /connections, as in the approved mockups 1 to 5 of
// the connections set: the computers where Mythicshot can publish to the workspace (the
// workspace's tokens, GET /api/v1/tokens), each with how it was made, the day it was
// connected and the day it was last used, and Rename and Disconnect; above them the card
// that connects Mythicshot with the short code it shows (src/connect.ts); the empty state
// and the phone layout (each computer a block; src/dash/style.ts). The body is fixed text;
// the script fills it through createElement and textContent, so a device's or a token's name
// (text a computer chose) can never become markup.
//
// Connecting. The person types the code Mythicshot shows. The field shows what is typed with
// a-z upper-cased and the blanks and dashes taken out, grouped XXXX-XXXX. Continue first
// checks it in the page: 8 characters of the code's own alphabet, else the "does not work"
// sentence and no request. Then it looks the code up, POST /api/v1/connect/lookup with
// { user_code } (8 capitals, no dash) in the body, in the one function lookupRequest: the
// code is never put in any address. On 200 the question "Connect this computer?" names the
// computer (at most NAME_MAX characters, wrapping, so no name pushes the warning or the
// buttons away) and when it asked, exactly as that answer gave them, adds a warning line
// when the answer's same_network is false, and keeps that code: Connect and Not me send that code in the body of POST
// /api/v1/connect/confirm or /refuse, whatever the field holds by then. Escape and a click
// outside close the question and send nothing: the request stays open until it expires. A
// 404 from any of the three is the "does not work" sentence; a 429 says how many minutes to
// wait (its retry-after, rounded up) and Continue stays disabled, and does nothing, until
// then. When no answer comes to Connect or Not me, the code is looked up once: a 404 (no
// longer open) closes the question with a neutral note and the list is watched as after a
// confirm; anything else keeps the question open with the failure. The code is never read
// from or written to the page's address, storage or a log.
//
// After a confirm the token does not exist yet: Mythicshot makes it when it next asks, every
// few seconds (src/connect.ts). So the list is read at once and then again after each pause
// of REFRESH_MS, until a computer that was not listed at the confirm shows up, at most
// REFRESH_MS.length more times. Those reads change the rows only when what they show changed,
// never move the focus to another control, and are skipped while a rename or a disconnect
// runs (which reads the list itself).
//
// Rename and Disconnect ask first (Dash.question). The name is checked in the page by the
// server's own rule (1 to NAME_MAX characters once trimmed, no control, formatting or
// separator character). However either ends, the list is read again, so the page shows what
// is true. A disconnect that got no answer is decided by that read: the list holds every
// token of the workspace while it has fewer than MAX_LISTED entries (src/tokens.ts answers
// at most that many, newest first), so then a token not in it is gone; with MAX_LISTED
// entries it may only have been pushed off the end, and the page says the disconnect failed.
import { DEVICE_NAME_MAX, USER_CODE_ALPHABET } from "../connect.ts";
import { MAX_TOKENS_LISTED } from "../tokens.ts";
import { dashHtml } from "./shell.ts";

const CONNECTIONS_MAIN = `  <div id="connections-page">
  <h1 id="h-page" tabindex="-1">Connections</h1>
  <section id="connections" aria-labelledby="h-page" hidden>
    <p class="sub" id="connections-sub"></p>
    <div class="card">
      <h2 class="card-title" id="h-connect" tabindex="-1">Connect Mythicshot</h2>
      <p class="note" id="connect-note" role="status" aria-live="polite" hidden></p>
      <p class="sub connect-text" id="connect-text">In Mythicshot, open Workspace and press Sign in. Type the code it shows here.</p>
      <div class="inline">
        <label class="vh" for="connect-code">Code</label>
        <input class="field code-field" id="connect-code" type="text" placeholder="XXXX-XXXX" maxlength="32" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-describedby="connect-text connect-message">
        <button type="button" class="btn" id="connect-go">Continue</button>
      </div>
      <p class="message connect-message" id="connect-message" role="status" aria-live="polite" hidden></p>
    </div>
    <p class="message" id="connections-message" role="status" aria-live="polite" hidden></p>
    <div class="card" id="connections-list" hidden>
      <table class="connections">
        <thead><tr><th scope="col">Computer</th><th scope="col">Connected</th><th scope="col">Last used</th><th scope="col"><span class="vh">Actions</span></th></tr></thead>
        <tbody id="connections-rows"></tbody>
      </table>
    </div>
    <div class="card" id="connections-empty" hidden>
      <div class="empty">
        <p class="empty-title">No computers connected yet</p>
        <p>Install Mythicshot, open Workspace and press Sign in. Then type the code it shows into the box above.</p>
      </div>
    </div>
    <p class="hint" id="connections-hint" hidden>A connection lets Mythicshot on that computer publish, change and delete everything in this workspace. Disconnect one you no longer use or do not recognise.</p>
  </section>
  </div>
  <div class="backdrop" id="confirm-dialog" hidden>
    <div class="dialog" id="confirm-box" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-facts confirm-warn">
      <h2 id="confirm-title" tabindex="-1">Connect this computer?</h2>
      <dl class="kv" id="confirm-facts"><dt>Computer</dt><dd><b class="name" id="confirm-device"></b></dd><dt>Asked</dt><dd id="confirm-asked"></dd><dt>Workspace</dt><dd id="confirm-workspace"></dd></dl>
      <p class="warn-box" id="confirm-elsewhere" hidden>This request may have come from a different network than the one you are on now. If you are not sure it is yours, press Not me.</p>
      <p class="warn-box" id="confirm-warn">Confirm only if you pressed Sign in in Mythicshot on this computer just now. It will be able to publish, change and delete everything in this workspace.</p>
      <p class="message" id="confirm-message" role="status" aria-live="polite" hidden></p>
      <div class="two">
        <button type="button" class="btn quiet" id="confirm-refuse">Not me</button>
        <button type="button" class="btn" id="confirm-go">Connect</button>
      </div>
    </div>
  </div>
  <div class="backdrop" id="rename-dialog" hidden>
    <div class="dialog" id="rename-box" role="dialog" aria-modal="true" aria-labelledby="rename-title" aria-describedby="rename-hint">
      <h2 id="rename-title" tabindex="-1">Rename this connection</h2>
      <label for="rename-input">Name</label>
      <input class="field" id="rename-input" type="text" autocomplete="off" spellcheck="false" aria-describedby="rename-hint rename-message">
      <p class="hint" id="rename-hint">Only you see this name. Up to 60 characters.</p>
      <p class="message" id="rename-message" role="status" aria-live="polite" hidden></p>
      <div class="two">
        <button type="button" class="btn quiet" id="rename-cancel">Cancel</button>
        <button type="button" class="btn" id="rename-save">Save</button>
      </div>
    </div>
  </div>
  <div class="backdrop" id="disconnect-dialog" hidden>
    <div class="dialog" id="disconnect-box" role="alertdialog" aria-modal="true" aria-labelledby="disconnect-title" aria-describedby="disconnect-text">
      <h2 id="disconnect-title" tabindex="-1"></h2>
      <p class="sub" id="disconnect-text">Mythicshot on that computer stops being able to publish to this workspace at once. Nothing already online is removed. To connect it again, press Sign in in Mythicshot there.</p>
      <p class="message" id="disconnect-message" role="status" aria-live="polite" hidden></p>
      <div class="two">
        <button type="button" class="btn quiet" id="disconnect-keep">Keep it</button>
        <button type="button" class="btn danger" id="disconnect-go">Disconnect</button>
      </div>
    </div>
  </div>`;

/** The Connections page: the shell with the page's body and its own script. */
export const CONNECTIONS_HTML = dashHtml({ title: "Connections", active: "connections", main: CONNECTIONS_MAIN, script: "/dash/connections.js" });

export const CONNECTIONS_JS = String.raw`(function () {
  "use strict";
  var TEXT = {
    subBefore: "The computers where Mythicshot can publish to ",
    subAfter: ".",
    signedIn: "Signed in from Mythicshot",
    fromSetup: "From setup",
    today: "Today",
    never: "Never",
    dot: " · ",
    connectedOn: "connected ",
    lastUsed: "last used ",
    todayInLine: "today",
    neverInLine: "never",
    rename: "Rename",
    disconnect: "Disconnect",
    justNow: "just now",
    oneMinuteAgo: "1 minute ago",
    minutesAgo: " minutes ago",
    isConnected: " is connected. Mythicshot finishes signing in by itself within a few seconds.",
    badCode: "That code does not work. Codes last 10 minutes and work once. Press Sign in in Mythicshot again for a new one.",
    tooMany: "Too many codes that did not work. Try again in ",
    oneMinute: "1 minute.",
    minutes: " minutes.",
    connecting: "Connecting…",
    saving: "Saving…",
    disconnecting: "Disconnecting…",
    askBefore: 'Disconnect "',
    askAfter: '"?',
    badName: "A name is 1 to 60 characters, with no hidden characters.",
    alreadyGone: "That connection was already disconnected.",
    lostAnswer: "The answer was lost on the way. If the computer was connected, it shows in the list below within a few seconds; if not, press Sign in in Mythicshot again.",
    lostRefuse: "The answer was lost on the way. The code no longer works, so nothing can be connected with it.",
    notReloaded: "The change was made, but the list could not be loaded again. Reload the page to see it.",
  };
  var TOKENS = "/api/v1/tokens";
  var LOOKUP = "/api/v1/connect/lookup";
  var CONFIRM = "/api/v1/connect/confirm";
  var REFUSE = "/api/v1/connect/refuse";
  var TOKEN_ID = /^tok_[0-9a-f]{24}$/;
  // A short code as the API stores it: 8 characters of its alphabet (src/connect.ts).
  var CODE = /^[${USER_CODE_ALPHABET}]{8}$/;
  // The name rule of src/connect.ts (parseDeviceName): trimmed, 1 to NAME_MAX characters, none of these.
  var NAME_MAX = ${DEVICE_NAME_MAX};
  var HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
  // The most tokens the list answers (src/tokens.ts): with fewer, the list is the whole of them.
  var MAX_LISTED = ${MAX_TOKENS_LISTED};
  // The pauses between the reads of the list after a confirm, until the new computer shows up.
  var REFRESH_MS = [3000, 3000, 4000, 10000, 10000];
  // How long Continue rests after a 429 without a usable retry-after (the API's window), and at most.
  var WAIT_S = 600;
  var MAX_WAIT_S = 86400;
  // What the page behind a question is, made inert while one is open.
  var BEHIND = ["dash-top", "connections-page"];
  // The three questions (Dash.question, src/dash/script.ts).
  var confirmQ = Dash.question({ backdrop: "confirm-dialog", box: "confirm-box", role: "alertdialog", title: "confirm-title", message: "confirm-message", behind: BEHIND, buttons: ["confirm-refuse", "confirm-go"] });
  var renameQ = Dash.question({ backdrop: "rename-dialog", box: "rename-box", role: "dialog", title: "rename-title", message: "rename-message", behind: BEHIND, fields: ["rename-input"], buttons: ["rename-cancel", "rename-save"], lock: "readonly" });
  var disconnectQ = Dash.question({ backdrop: "disconnect-dialog", box: "disconnect-box", role: "alertdialog", title: "disconnect-title", message: "disconnect-message", behind: BEHIND, buttons: ["disconnect-keep", "disconnect-go"] });

  var $ = function (id) { return document.getElementById(id); };
  var workspace = "";
  // The tokens shown, and what they showed as (to leave the rows alone when nothing changed).
  var items = [];
  var shownKey = null;
  // Each row's controls by token id, to give the focus back after the rows are rebuilt.
  var renameOf = {};
  var disconnectOf = {};
  var rowButtons = [];
  // Reads of the list, numbered: an answer older than the one shown is not shown.
  var readNo = 0;
  var shownNo = 0;
  var reading = 0;
  // A rename or a disconnect is running.
  var working = false;
  // The token a rename or a disconnect question is about.
  var renaming = null;
  var disconnecting = null;
  // The request the confirm question is about: { code, device, asked }, as the lookup answered.
  var pending = null;
  // A lookup is running; Continue rests until blockedUntil after a 429.
  var looking = false;
  var blockedUntil = 0;
  var blockNo = 0;
  // The reads after a confirm, numbered: a newer confirm ends the older one's.
  var watchNo = 0;

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

  function say(text) {
    sayIn($("connections-message"), text);
  }

  function anyOpen() {
    return confirmQ.isOpen() || renameQ.isOpen() || disconnectQ.isOpen();
  }

  // The rows' buttons are disabled while a rename or a disconnect runs, and while a lookup
  // runs (its answer opens the confirm question): one question at a time.
  function syncRows() {
    var on = working || looking;
    rowButtons.forEach(function (b) { b.el.disabled = on; });
  }

  function isTime(n) {
    return typeof n === "number" && isFinite(n);
  }

  // ---- The code ----

  // a-z upper-cased (no other letter: the API looks at ASCII only), blanks and dashes out.
  function compact(v) {
    return String(v).replace(/[\s-]+/g, "").replace(/[a-z]+/g, function (m) { return m.toUpperCase(); });
  }

  // The code to send, or null when it cannot be one.
  function codeOf(v) {
    var c = compact(v);
    return CODE.test(c) ? c : null;
  }

  // The field as typed, grouped XXXX-XXXX, the caret kept after the same character.
  function regroup() {
    var input = $("connect-code");
    var c = compact(input.value);
    var shown = c.length > 4 ? c.slice(0, 4) + "-" + c.slice(4) : c;
    if (shown === input.value) return;
    var at = typeof input.selectionStart === "number" ? input.selectionStart : null;
    var before = at === null ? 0 : compact(input.value.slice(0, at)).length;
    input.value = shown;
    if (at === null || typeof input.setSelectionRange !== "function") return;
    var pos = before > 4 ? before + 1 : before;
    try { input.setSelectionRange(pos, pos); } catch (e) { /* not a text field any more */ }
  }

  function codeSays(text) {
    sayIn($("connect-message"), text);
    var input = $("connect-code");
    if (text === TEXT.badCode) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  }

  // The card's note: "<name> is connected…" in green, or a plain sentence (the lost answer's)
  // in the card's quiet colours; note(null) hides it.
  function note(name, plain) {
    var line = $("connect-note");
    line.textContent = "";
    line.className = typeof plain === "string" ? "note plain" : "note";
    if (name !== null) {
      line.appendChild(el("span", "name", name));
      line.appendChild(el("span", "", TEXT.isConnected));
    } else if (typeof plain === "string") line.textContent = plain;
    line.hidden = name === null && typeof plain !== "string";
  }

  function blocked() {
    return blockedUntil !== 0 && Date.now() < blockedUntil;
  }

  // A 429: Continue rests for its retry-after (whole seconds), rounded up to minutes in the sentence.
  function block(retryAfter) {
    var s = typeof retryAfter === "string" && /^[0-9]{1,9}$/.test(retryAfter) ? Number(retryAfter) : WAIT_S;
    s = Math.min(MAX_WAIT_S, Math.max(1, s));
    var n = Math.ceil(s / 60);
    blockedUntil = Date.now() + s * 1000;
    var mine = ++blockNo;
    $("connect-go").disabled = true;
    codeSays(TEXT.tooMany + (n === 1 ? TEXT.oneMinute : n + TEXT.minutes));
    setTimeout(function () {
      if (mine !== blockNo) return;
      blockedUntil = 0;
      if (!looking) $("connect-go").disabled = false;
      codeSays("");
    }, s * 1000);
  }

  function lookingUp(on) {
    looking = on;
    var go = $("connect-go");
    go.disabled = on || blocked();
    if (on) go.setAttribute("aria-busy", "true");
    else go.removeAttribute("aria-busy");
    syncRows();
  }

  // "just now" under a minute, then whole minutes.
  function agoOf(ms) {
    var m = Math.floor((Date.now() - ms) / 60000);
    if (!(m >= 1)) return TEXT.justNow;
    return m === 1 ? TEXT.oneMinuteAgo : m + TEXT.minutesAgo;
  }

  function lookUp() {
    if (looking || blocked() || anyOpen()) return;
    var input = $("connect-code");
    if (compact(input.value) === "") { input.focus(); return; }
    note(null);
    var code = codeOf(input.value);
    if (code === null) {
      codeSays(TEXT.badCode);
      input.focus();
      return;
    }
    codeSays("");
    lookingUp(true);
    function settle(res) {
      if (res !== null && res.status === 401) { Dash.signedOut(); return; }
      lookingUp(false);
      var d = res !== null ? res.data : null;
      if (res !== null && res.status === 200 && d !== null && typeof d === "object" && typeof d.device_name === "string" && isTime(d.asked_at)) {
        // Another question opened meanwhile: this one is not asked on top of it.
        if (anyOpen()) return;
        ask({ code: code, device: d.device_name, asked: d.asked_at, elsewhere: d.same_network === false });
        return;
      }
      if (res !== null && res.status === 404) codeSays(TEXT.badCode);
      else if (res !== null && res.status === 429) block(res.retryAfter);
      else codeSays(res === null ? Dash.TEXT.failed : Dash.failure(res));
      input.focus();
    }
    lookupRequest(code).then(settle, function () { settle(null); });
  }

  // The one place the lookup is asked: the code only ever in the body, never in an address.
  function lookupRequest(code) {
    return Dash.api("POST", LOOKUP, { user_code: code });
  }

  // ---- The confirm question ----

  function ask(p) {
    // At most NAME_MAX characters, as the server stores names, so no name pushes the warning away.
    $("confirm-device").textContent = Array.from(p.device).slice(0, NAME_MAX).join("");
    $("confirm-asked").textContent = agoOf(p.asked);
    $("confirm-workspace").textContent = workspace;
    // The extra warning when the request came from another network than this page's.
    $("confirm-elsewhere").hidden = !p.elsewhere;
    $("confirm-box").setAttribute("aria-describedby", p.elsewhere ? "confirm-facts confirm-elsewhere confirm-warn" : "confirm-facts confirm-warn");
    var opened = confirmQ.open({
      focus: "confirm-refuse",
      back: function () { return $("connect-code"); },
      // Escape, a click outside: the request is left as it is.
      onClose: function () { pending = null; },
    });
    if (opened) pending = p;
  }

  // Connect or Not me: the code the lookup was for, once.
  function settleCode(how) {
    if (pending === null || confirmQ.isWorking()) return;
    var p = pending;
    var button = how === "confirm" ? "confirm-go" : "confirm-refuse";
    confirmQ.say("");
    confirmQ.busy(true, button, how === "confirm" ? TEXT.connecting : undefined);
    // No answer came: it may have been settled all the same. The code is looked up once: a
    // 404 means the request is no longer open (settled, or expired), so the question closes
    // with the neutral note and the list is watched; anything else (a 200: it is still open)
    // keeps the question open with the failure.
    function lost() {
      lookupRequest(p.code).then(function (res) { return res; }, function () { return null; }).then(function (res) {
        if (res !== null && res.status === 401) { Dash.signedOut(); return; }
        confirmQ.busy(false, button);
        if (res !== null && res.status === 404) {
          confirmQ.close(false);
          $("connect-code").value = "";
          codeSays("");
          // After Connect the computer may have been connected, so the list is watched; after
          // Not me the code no longer works either way, and there is nothing to watch for.
          if (how === "confirm") {
            note(null, TEXT.lostAnswer);
            watch();
          } else note(null, TEXT.lostRefuse);
          $("connect-code").focus();
          return;
        }
        confirmQ.say(Dash.TEXT.failed);
        $(button).focus();
      });
    }
    function settle(res) {
      if (res !== null && res.status === 401) { Dash.signedOut(); return; }
      if (res === null) { lost(); return; }
      confirmQ.busy(false, button);
      var input = $("connect-code");
      if (res !== null && (res.status === 204 || res.status === 404 || res.status === 429)) {
        confirmQ.close(false);
        if (res.status === 204) {
          input.value = "";
          codeSays("");
          if (how === "confirm") {
            note(p.device);
            watch();
          }
        } else if (res.status === 404) codeSays(TEXT.badCode);
        else block(res.retryAfter);
        input.focus();
        return;
      }
      confirmQ.say(Dash.failure(res));
      $(button).focus();
    }
    Dash.api("POST", how === "confirm" ? CONFIRM : REFUSE, { user_code: p.code }).then(settle, function () { settle(null); });
  }

  // After a confirm: the list now, and again after each pause until a new computer shows up.
  function watch() {
    var mine = ++watchNo;
    var before = {};
    items.forEach(function (t) { before[t.id] = true; });
    var step = 0;
    function look() {
      if (mine !== watchNo) return;
      var round = working || reading > 0 ? Promise.resolve(null) : read();
      round.then(function (r) {
        if (mine !== watchNo || r === false) return;
        if (got(r) && r.list.some(function (t) { return before[t.id] !== true; })) return;
        if (step < REFRESH_MS.length) setTimeout(look, REFRESH_MS[step++]);
      });
    }
    look();
  }

  // ---- The list ----

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  // "Today", a date, or "Never" (in the phone's line: "today", a date, "never").
  function lastUsedOf(t, inLine) {
    if (t.last_used_at === null) return inLine ? TEXT.neverInLine : TEXT.never;
    if (sameDay(new Date(t.last_used_at), new Date())) return inLine ? TEXT.todayInLine : TEXT.today;
    return Dash.dateOf(t.last_used_at, true);
  }

  function kindOf(t) {
    return t.kind === "sign_in" ? TEXT.signedIn : t.kind === "setup" ? TEXT.fromSetup : "";
  }

  function row(t, i) {
    var tr = el("tr");
    var nameId = "conn-" + i;
    var connected = Dash.dateOf(t.created_at, true);
    var kind = kindOf(t);

    var what = el("td", "what");
    var name = el("div", "t name", t.name);
    name.setAttribute("id", nameId);
    what.appendChild(name);
    var d = el("div", "d");
    d.appendChild(el("span", "", kind));
    d.appendChild(el("span", "narrow-only", (kind !== "" ? TEXT.dot : "") + TEXT.connectedOn + connected + TEXT.dot + TEXT.lastUsed + lastUsedOf(t, true)));
    what.appendChild(d);
    tr.appendChild(what);
    tr.appendChild(el("td", "when", connected));
    tr.appendChild(el("td", "when", lastUsedOf(t, false)));

    var cell = el("td", "acts-cell");
    var acts = el("div", "acts");
    var rename = el("button", "btn sm quiet", TEXT.rename);
    rename.type = "button";
    rename.setAttribute("aria-describedby", nameId);
    rename.addEventListener("click", function () { askRename(t); });
    var drop = el("button", "btn sm danger", TEXT.disconnect);
    drop.type = "button";
    drop.setAttribute("aria-describedby", nameId);
    drop.addEventListener("click", function () { askDisconnect(t); });
    acts.appendChild(rename);
    acts.appendChild(drop);
    cell.appendChild(acts);
    tr.appendChild(cell);
    renameOf[t.id] = rename;
    disconnectOf[t.id] = drop;
    rowButtons.push({ id: t.id, which: "rename", el: rename }, { id: t.id, which: "disconnect", el: drop });
    return tr;
  }

  // The rows, rebuilt only when what they show changed. A row control that had the focus has
  // it again in the new rows; nothing else takes the focus.
  function render(list) {
    var key = JSON.stringify([new Date().toDateString(), list.map(function (t) { return [t.id, t.name, t.created_at, t.last_used_at, t.kind]; })]);
    items = list;
    if (key === shownKey) return;
    shownKey = key;
    var active = document.activeElement;
    var had = null;
    rowButtons.forEach(function (b) { if (b.el === active) had = b; });
    renameOf = {};
    disconnectOf = {};
    rowButtons = [];
    var rows = $("connections-rows");
    rows.textContent = "";
    for (var i = 0; i < list.length; i++) rows.appendChild(row(list[i], i));
    syncRows();
    $("connections-list").hidden = list.length === 0;
    $("connections-hint").hidden = list.length === 0;
    $("connections-empty").hidden = list.length !== 0;
    if (had !== null) {
      var again = (had.which === "rename" ? renameOf : disconnectOf)[had.id];
      if (again !== undefined) again.focus();
    }
  }

  // Only a token with an id of the API's shape, a name and its times is shown.
  function usable(list) {
    return list.filter(function (t) {
      return t !== null && typeof t === "object" && typeof t.id === "string" && TOKEN_ID.test(t.id) && typeof t.name === "string" && isTime(t.created_at) && (t.last_used_at === null || isTime(t.last_used_at));
    });
  }

  function got(r) {
    return r !== null && r !== false && typeof r === "object" && r.shown === true;
  }

  // The list read and shown. Resolves to { shown: true, list, complete } (complete: the list
  // holds every token of the workspace), false when the visitor was sent to sign in, or the
  // answer that failed (null when none came); then the page keeps what it showed.
  function read() {
    var mine = ++readNo;
    reading++;
    function done(r) {
      reading--;
      return r;
    }
    return Dash.api("GET", TOKENS).then(function (res) {
      if (res.status === 401) { Dash.signedOut(); return done(false); }
      var d = res.data;
      if (res.status !== 200 || d === null || typeof d !== "object" || !Array.isArray(d.tokens)) return done(res);
      var list = usable(d.tokens);
      if (mine > shownNo) {
        shownNo = mine;
        render(list);
      }
      return done({ shown: true, list: list, complete: d.tokens.length < MAX_LISTED });
    }, function () { return done(null); });
  }

  // ---- Rename ----

  // The name as the server will store it, or null when its rule refuses it.
  function nameOf(v) {
    if (typeof v !== "string" || v.length > 4 * NAME_MAX + 64) return null;
    var name = v.trim();
    var n = Array.from(name).length;
    return n < 1 || n > NAME_MAX || HIDDEN.test(name) ? null : name;
  }

  function complain(text) {
    var input = $("rename-input");
    renameQ.say(text);
    if (text !== "") input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  }

  function askRename(t) {
    if (working || looking || anyOpen()) return;
    var input = $("rename-input");
    input.value = t.name;
    input.removeAttribute("aria-invalid");
    var opened = renameQ.open({
      focus: "rename-input",
      back: function () { return renameOf[t.id]; },
      fallback: "h-page",
      onClose: function () {
        renaming = null;
        $("rename-input").removeAttribute("aria-invalid");
      },
    });
    if (!opened) return;
    renaming = t;
    input.select();
  }

  function saveRename() {
    if (renaming === null || working) return;
    var input = $("rename-input");
    var name = nameOf(input.value);
    if (name === null) {
      complain(TEXT.badName);
      input.focus();
      return;
    }
    var id = renaming.id;
    complain("");
    say("");
    working = true;
    syncRows();
    renameQ.busy(true, "rename-save", TEXT.saving);
    function settle(res) {
      if (res !== null && res.status === 401) { Dash.signedOut(); return; }
      var done = res !== null && res.status === 200;
      var gone = res !== null && res.status === 404;
      // However it ended, the list is read again before the page says anything.
      return read().then(function (r) {
        if (r === false) return;
        working = false;
        renameQ.busy(false, "rename-save");
        syncRows();
        if (done || gone) {
          renameQ.close(false);
          say(gone ? TEXT.alreadyGone : got(r) ? "" : TEXT.notReloaded);
          var back = renameOf[id];
          if (back !== undefined) back.focus();
          else $("h-page").focus();
          return;
        }
        if (res !== null && res.status === 400 && Dash.errorOf(res) === "bad_name") {
          complain(TEXT.badName);
          input.focus();
          return;
        }
        renameQ.say(res === null ? Dash.TEXT.failed : Dash.failure(res));
        $("rename-save").focus();
      });
    }
    Dash.api("PATCH", TOKENS + "/" + encodeURIComponent(id), { name: name }).then(settle, function () { return settle(null); });
  }

  // ---- Disconnect ----

  function askDisconnect(t) {
    if (working || looking || anyOpen()) return;
    // The name in its own bidi-isolated element, as in the list, so right-to-left letters
    // cannot reorder the quote marks around it.
    var title = $("disconnect-title");
    title.textContent = "";
    title.appendChild(el("span", "", TEXT.askBefore));
    title.appendChild(el("span", "name", t.name));
    title.appendChild(el("span", "", TEXT.askAfter));
    var opened = disconnectQ.open({
      focus: "disconnect-keep",
      back: function () { return disconnectOf[t.id]; },
      fallback: "h-page",
      onClose: function () { disconnecting = null; },
    });
    if (opened) disconnecting = t;
  }

  function runDisconnect() {
    if (disconnecting === null || working) return;
    var id = disconnecting.id;
    disconnectQ.say("");
    say("");
    working = true;
    syncRows();
    disconnectQ.busy(true, "disconnect-go", TEXT.disconnecting);
    // res: the answer, or null when none came.
    function settle(res) {
      if (res !== null && res.status === 401) { Dash.signedOut(); return; }
      return read().then(function (r) {
        if (r === false) return;
        // 204, and 404 (already gone), are done. With no answer, the list just read decides,
        // and only while it is the whole list (see the top of this file).
        var done = res !== null && (res.status === 204 || res.status === 404);
        var why = res;
        if (res === null) {
          if (got(r) && r.complete && !r.list.some(function (t) { return t.id === id; })) done = true;
          else why = got(r) ? null : r;
        }
        working = false;
        disconnectQ.busy(false, "disconnect-go");
        syncRows();
        if (done) {
          disconnectQ.close(false);
          say(got(r) ? "" : TEXT.notReloaded);
          $("h-page").focus();
          return;
        }
        disconnectQ.say(why === null ? Dash.TEXT.failed : Dash.failure(why));
        $("disconnect-go").focus();
      });
    }
    Dash.api("DELETE", TOKENS + "/" + encodeURIComponent(id)).then(settle, function () { return settle(null); });
  }

  function startPage() {
    $("connect-go").addEventListener("click", lookUp);
    $("connect-code").addEventListener("input", function () {
      regroup();
      if (!blocked()) codeSays("");
    });
    // Enter in the field is Continue; a held Enter's repeats do nothing.
    $("connect-code").addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter") return;
      if (ev.repeat === true) { ev.preventDefault(); return; }
      ev.preventDefault();
      lookUp();
    });
    $("confirm-go").addEventListener("click", function () { settleCode("confirm"); });
    // A held key's repeats never press Connect or Not me (the first Enter may have been the field's).
    ["confirm-go", "confirm-refuse"].forEach(function (id) {
      $(id).addEventListener("keydown", function (ev) {
        if (ev.repeat === true && (ev.key === "Enter" || ev.key === " ")) ev.preventDefault();
      });
    });
    $("confirm-refuse").addEventListener("click", function () { settleCode("refuse"); });
    $("rename-cancel").addEventListener("click", function () { renameQ.dismiss(); });
    $("rename-save").addEventListener("click", saveRename);
    $("rename-input").addEventListener("input", function () { complain(""); });
    $("rename-input").addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      saveRename();
    });
    $("disconnect-keep").addEventListener("click", function () { disconnectQ.dismiss(); });
    $("disconnect-go").addEventListener("click", runDisconnect);
  }

  startPage();
  Dash.start(function (who) {
    workspace = who.workspace;
    $("connections-sub").textContent = TEXT.subBefore + workspace + TEXT.subAfter;
    return read().then(function (r) {
      if (r === false) return;
      if (!got(r)) $("dash-load").textContent = Dash.failure(r);
      $("connections").hidden = false;
    });
  });
})();
`;
