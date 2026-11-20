// The Admin page of the dashboard, /admin, as in the approved mockups 9 and 10: the summary
// line, every account with its workspace, tour count, a small usage bar, what it uses (with
// "Over" when it is over its allowance) and its allowance, "Show more" while the list has
// another page, and the question that sets one workspace's allowance, with the warning when
// the new number is below what the workspace uses.
//
// The document is the same for everyone and holds no data (src/dash/shell.ts); the admin
// screen in it is hidden. Its script, /dash/admin.js, asks nothing of the admin routes until
// the session says the person is the admin. For anyone else, and when an admin route
// answers 404, it takes the admin screen and its question out of the page and shows what a
// missing page shows: "Page not found" and a link back to Tours. The admin routes answer
// everyone but the admin's session the one 404 (src/admin-api.ts), so a member's browser
// never receives their data either way.
//
// Every account is built with createElement and textContent: a username, an email address
// or a workspace's name can never become markup. The email address is shown here, to the
// admin alone, by design. The bar's width is set through the CSSOM (`style.width`), which
// the content security policy allows, never through a style attribute.
//
// Setting an allowance: the field takes a size as a person writes it (SIZE_JS below); empty
// means the standard allowance, which the API is told with null. An allowance that leaves the
// workspace no room (0, what it uses, or less) shows a warning and "Save anyway". The question
// is the dashboard's one question helper (Dash.question, src/dash/script.ts); Enter in the
// field is Save. The list is read one request at a time: Show more does nothing while a read
// runs, and a read waits for Show more. After a save the list is
// read again from the API, and after any failure too, so the page never shows a number the
// server did not give it.
import { dashHtml } from "./shell.ts";

const ADMIN_MAIN = `  <section id="admin" aria-labelledby="h-page" hidden>
    <h1 id="h-page" tabindex="-1">Accounts</h1>
    <p class="sub" id="admin-summary"></p>
    <p class="message" id="admin-message" role="status" aria-live="polite" hidden></p>
    <div class="card">
      <table class="accounts">
        <thead><tr><th scope="col">Account</th><th scope="col">Workspace</th><th scope="col" class="n">Tours</th><th scope="col" class="bar"><span class="vh">Share</span></th><th scope="col" class="n">Used</th><th scope="col" class="n">Allowance</th><th scope="col"><span class="vh">Actions</span></th></tr></thead>
        <tbody id="admin-rows"></tbody>
      </table>
    </div>
    <div class="show-more"><button type="button" class="btn quiet" id="admin-more" hidden>Show more</button></div>
    <p class="hint">You see how much each workspace uses, never what is in it. Inviting people comes in a later phase.</p>
  </section>
  <section id="missing" aria-labelledby="missing-title" hidden>
    <h1 id="missing-title" tabindex="-1">Page not found</h1>
    <p><a href="/tours">Back to Tours</a></p>
  </section>
  <div class="backdrop" id="allow-dialog" hidden>
    <div class="dialog" id="allow-box" role="dialog" aria-modal="true" aria-labelledby="allow-title" aria-describedby="allow-uses">
      <h2 id="allow-title" tabindex="-1"></h2>
      <p class="sub" id="allow-uses"></p>
      <label for="allow-input">Allowance</label>
      <input class="field" id="allow-input" type="text" autocomplete="off" spellcheck="false" aria-describedby="allow-hint allow-message">
      <p class="hint" id="allow-hint"></p>
      <p class="warn-box" id="allow-warn" hidden></p>
      <p class="message" id="allow-message" role="status" aria-live="polite" hidden></p>
      <div class="two">
        <button type="button" class="btn quiet" id="allow-cancel">Cancel</button>
        <button type="button" class="btn" id="allow-save">Save</button>
      </div>
    </div>
  </div>`;

/** The Admin page: the shell with the page's body and its own script. */
export const ADMIN_HTML = dashHtml({ title: "Admin", active: "admin", main: ADMIN_MAIN, script: "/dash/admin.js" });

/**
 * The size parser of the allowance field, as script text: sizeOf(text) is the number of
 * bytes, null for an empty field (the standard allowance), or undefined when the text is
 * not a size. The rule: optional spaces around; digits, with at most one decimal part
 * written with a point (a comma is refused); optional spaces; then B, byte, bytes, KB, MB
 * or GB in any case, or nothing for bytes. 1024 to the next unit, as the pages write sizes;
 * a fraction is rounded to the nearest byte (a half up), exactly: the digits are worked on as
 * whole numbers (BigInt), never as a floating-point number; bytes themselves take no fraction. TB and
 * every other unit are refused: the pages write the largest sizes in GB. The result must be
 * a whole number from 0 to 9007199254740991, the largest allowance the API takes.
 */
export const SIZE_JS = `  // A size as a person writes it (500 MB, 10 GB, 1.5 GB, plain bytes), in bytes; null
  // when empty, undefined when it is not a size. See SIZE_JS in src/dash/admin.ts.
  var SIZE = /^([0-9]+)(?:\\.([0-9]+))?\\s*(b|bytes?|kb|mb|gb)?$/i;
  var UNITS = { b: 1, byte: 1, bytes: 1, kb: 1024, mb: 1048576, gb: 1073741824 };
  var MAX_BYTES = 9007199254740991;
  function sizeOf(text) {
    var t = String(text).trim();
    if (t === "") return null;
    var m = SIZE.exec(t);
    if (m === null) return undefined;
    var unit = UNITS[(m[3] === undefined ? "b" : m[3]).toLowerCase()];
    if (m[2] !== undefined && unit === 1) return undefined;
    // More than 16 digits before the point is past the largest allowance, and is not read at all.
    if (m[1].replace(/^0+(?=[0-9])/, "").length > 16) return undefined;
    // (whole + fraction) times the unit, rounded: on whole numbers, (whole * 10^k + digits) * unit / 10^k.
    var frac = m[2] === undefined ? "" : m[2];
    var scale = BigInt("1" + "0".repeat(frac.length));
    var exact = (BigInt(m[1]) * scale + BigInt(frac === "" ? "0" : frac)) * BigInt(unit);
    var bytes = exact / scale;
    if ((exact % scale) * BigInt(2) >= scale) bytes += BigInt(1);
    return bytes <= BigInt(MAX_BYTES) ? Number(bytes) : undefined;
  }
`;

export const ADMIN_JS = `(function () {
  "use strict";
  var TEXT = {
    oneAccount: "1 account",
    accounts: " accounts",
    dot: " · ",
    usedInAll: " used in all",
    standard: " · standard allowance ",
    noStandard: " · no standard allowance",
    admin: "Admin",
    over: "Over",
    none: "None",
    setAllowance: "Set allowance",
    tours: "Tours",
    used: "Used",
    allowance: "Allowance",
    askTitle: "Storage allowance for ",
    usesBefore: "Uses ",
    usesAfter: " now.",
    hintSize: "Write a size such as 500 MB or 10 GB.",
    hintStandardBefore: " Leave it empty to use the standard allowance of ",
    hintStandardAfter: ".",
    hintNone: " Leave it empty for no allowance.",
    warnBefore: "That is less than this workspace uses. Nothing is deleted, but its new uploads are refused until it is under ",
    warnAfter: ".",
    warnEqualBefore: "That is exactly what this workspace uses. Nothing is deleted, but its new uploads are refused until it is under ",
    zeroStandard: "An allowance of 0 refuses every upload from this workspace. Leave the field empty for the standard allowance.",
    zeroNone: "An allowance of 0 refuses every upload from this workspace. Leave the field empty for no allowance.",
    badSize: "Write a size such as 500 MB or 10 GB.",
    save: "Save",
    saveAnyway: "Save anyway",
    saving: "Saving…",
    notFound: "Page not found",
    disabled: "Disabled",
    notReloaded: "The change was made, but the list could not be loaded again. Reload the page to see it.",
  };
  var ACCOUNTS = "/api/v1/admin/accounts";
  var WORKSPACES = "/api/v1/admin/workspaces/";
  var USER_ID = /^usr_[0-9a-f]{24}$/;
  var WORKSPACE_ID = /^ws_[0-9a-f]{24}$/;
  // What the page behind the question is, made inert while it is open.
  var BEHIND = ["dash-top", "admin"];
  // The question that sets an allowance (Dash.question, src/dash/script.ts).
  var question = Dash.question({ backdrop: "allow-dialog", box: "allow-box", role: "dialog", title: "allow-title", message: "allow-message", behind: BEHIND, fields: ["allow-input"], buttons: ["allow-cancel", "allow-save"], lock: "readonly" });
${SIZE_JS}
  var $ = function (id) { return document.getElementById(id); };
  // The standard allowance from the summary, null when there is none.
  var standard = null;
  // The accounts shown, how many pages of the list they are, and the cursor of the page after them.
  var shown = [];
  var pages = 0;
  var next = null;
  // Each account's Set allowance button, by workspace id, to give focus back after the list is rebuilt.
  var buttons = {};
  // The question that is open ({ a: the account, ws: its workspace id }).
  var asking = null;
  var gone = false;
  // The list request running (a read, or Show more), or null: one at a time.
  var listing = null;

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
    sayIn($("admin-message"), text);
  }

  // ---- A missing page, for anyone but the admin ----

  // The admin screen and its question leave the page; what is left is what a missing page shows.
  function notFound() {
    question.close(false);
    asking = null;
    gone = true;
    var parts = [$("admin"), $("allow-dialog")];
    for (var i = 0; i < parts.length; i++) if (parts[i] !== null) parts[i].remove();
    $("dash-load").textContent = "";
    document.title = TEXT.notFound;
    $("missing").hidden = false;
  }

  // ---- Reading the list ----

  function cursorOf(v) {
    return typeof v === "string" && USER_ID.test(v) ? v : null;
  }

  function listed(res) {
    return res.status === 200 && res.data !== null && typeof res.data === "object" && Array.isArray(res.data.accounts);
  }

  function summed(res) {
    var d = res.data;
    return res.status === 200 && d !== null && typeof d === "object" && typeof d.accounts === "number" && typeof d.used_bytes === "number" && (d.standard_allowance_bytes === null || typeof d.standard_allowance_bytes === "number");
  }

  // Only an account with a workspace id and its numbers is shown.
  function usable(list) {
    return list.filter(function (a) { return a !== null && typeof a === "object" && typeof a.workspace_id === "string" && WORKSPACE_ID.test(a.workspace_id) && typeof a.used_bytes === "number"; });
  }

  function pageOf(after) {
    var path = after === null ? ACCOUNTS : ACCOUNTS + "?after=" + encodeURIComponent(after);
    return Dash.api("GET", path);
  }

  // One list request at a time: Show more is disabled while one runs, and does nothing then;
  // a read asked for while Show more runs starts when it has ended, so it reads every page
  // shown by then. track() marks the request running until it ends.
  function track(p) {
    listing = p;
    var more = $("admin-more");
    if (more !== null) more.disabled = true;
    function end() {
      if (listing !== p) return;
      listing = null;
      var btn = $("admin-more");
      if (btn !== null) btn.disabled = false;
    }
    p.then(end, end);
    return p;
  }

  // The summary and the pages of the list shown so far (at least one), read again once any
  // list request running has ended. Resolves as readNow does.
  function read() {
    var before = listing === null ? Promise.resolve() : listing.then(null, function () {});
    return track(before.then(function () { return readNow(Math.max(1, pages)); }));
  }

  // The summary and the first \`want\` pages of the list, then the page shown again. Resolves
  // to true when shown, false when the visitor was sent on (to sign in, or to the missing
  // page), or the answer that failed (null when no answer came).
  function readNow(want) {
    var got = [];
    var cursor = null;
    var count = 0;
    function step(after) {
      return pageOf(after).then(function (res) {
        if (!listed(res)) return res;
        got = got.concat(usable(res.data.accounts));
        count++;
        cursor = cursorOf(res.data.next);
        return cursor !== null && count < want ? step(cursor) : true;
      });
    }
    return Promise.all([Dash.api("GET", "/api/v1/admin/summary"), step(null)]).then(function (all) {
      var sum = all[0];
      var list = all[1];
      var answers = [sum, list];
      for (var i = 0; i < answers.length; i++) {
        if (answers[i] !== true && answers[i].status === 401) { Dash.signedOut(); return false; }
      }
      for (var j = 0; j < answers.length; j++) {
        if (answers[j] !== true && answers[j].status === 404) { notFound(); return false; }
      }
      if (!summed(sum)) return sum;
      if (list !== true) return list;
      if (gone) return false;
      standard = sum.data.standard_allowance_bytes;
      shown = got;
      pages = count;
      next = cursor;
      var n = sum.data.accounts;
      $("admin-summary").textContent = (n === 1 ? TEXT.oneAccount : n + TEXT.accounts) + TEXT.dot + Dash.formatBytes(sum.data.used_bytes) + TEXT.usedInAll + (standard !== null ? TEXT.standard + Dash.formatBytes(standard) : TEXT.noStandard);
      render();
      $("admin").hidden = false;
      return true;
    }).then(null, function () { return null; });
  }

  // ---- One account ----

  function labelled(td, label) {
    td.setAttribute("data-label", label);
    return td;
  }

  function row(a, i) {
    var tr = el("tr");
    var nameId = "account-" + i;
    var email = typeof a.email === "string" ? a.email : "";
    var named = typeof a.username === "string" && a.username !== "";
    var limit = typeof a.allowance_bytes === "number" ? a.allowance_bytes : null;
    var over = limit !== null && a.over === true;

    var who = el("td", "who-cell");
    var t = el("div", "t");
    t.setAttribute("id", nameId);
    t.appendChild(el("span", "name", named ? a.username : email));
    if (a.admin === true) t.appendChild(el("span", "tag", TEXT.admin));
    if (a.status === "disabled") t.appendChild(el("span", "tag", TEXT.disabled));
    who.appendChild(t);
    if (named && email !== "") who.appendChild(el("div", "d", email));
    tr.appendChild(who);
    tr.appendChild(el("td", "ws", typeof a.workspace_name === "string" ? a.workspace_name : ""));
    tr.appendChild(labelled(el("td", "n tours", String(typeof a.tours === "number" ? a.tours : 0)), TEXT.tours));

    // The bar: what is used of the allowance in force, full when over it, none without an allowance.
    var bar = el("td", "bar");
    if (limit !== null) {
      var mini = el("div", over ? "mini over" : "mini");
      mini.setAttribute("aria-hidden", "true");
      var fill = el("i");
      var share = over ? 100 : limit > 0 ? Math.min(100, (a.used_bytes / limit) * 100) : 0;
      // A little use still shows.
      if (share > 0 && share < 1) share = 1;
      var width = Math.round(share * 100) / 100;
      fill.style.width = width + "%";
      mini.appendChild(fill);
      bar.appendChild(mini);
    }
    tr.appendChild(bar);

    var used = labelled(el("td", "n used", Dash.formatBytes(a.used_bytes)), TEXT.used);
    if (over) used.appendChild(el("span", "tag warn", TEXT.over));
    tr.appendChild(used);
    tr.appendChild(labelled(el("td", "n allowance", limit !== null ? Dash.formatBytes(limit) : TEXT.none), TEXT.allowance));

    var cell = el("td", "acts-cell");
    var acts = el("div", "acts");
    var btn = el("button", "btn sm quiet", TEXT.setAllowance);
    btn.type = "button";
    btn.setAttribute("aria-describedby", nameId);
    btn.addEventListener("click", function () { ask(a); });
    acts.appendChild(btn);
    cell.appendChild(acts);
    tr.appendChild(cell);
    buttons[a.workspace_id] = btn;
    return tr;
  }

  function render() {
    buttons = {};
    var rows = $("admin-rows");
    rows.textContent = "";
    for (var i = 0; i < shown.length; i++) rows.appendChild(row(shown[i], i));
    $("admin-more").hidden = next === null;
  }

  function focusRow(ws) {
    var b = buttons[ws];
    if (b !== undefined) b.focus();
    else $("h-page").focus();
  }

  // ---- Show more ----

  function more() {
    if (listing !== null || next === null || gone) return;
    say("");
    var from = shown.length;
    track(pageOf(next).then(function (res) {
      if (res.status === 401) { Dash.signedOut(); return; }
      if (res.status === 404) { notFound(); return; }
      if (!listed(res)) { say(Dash.failure(res)); return; }
      shown = shown.concat(usable(res.data.accounts));
      pages++;
      next = cursorOf(res.data.next);
      render();
      if (shown.length > from) focusRow(shown[from].workspace_id);
      else $("h-page").focus();
    }, function () {
      say(Dash.TEXT.failed);
    }));
  }

  // ---- The question that sets an allowance ----

  // The workspace's own number as the field shows it: as a size when that reads back as the
  // very number, else in bytes, so that saving it unchanged changes nothing.
  function prefill(a) {
    var own = a.storage_allowance_bytes;
    if (typeof own !== "number") return "";
    var text = Dash.formatBytes(own);
    return sizeOf(text) === own ? text : String(own);
  }

  // What the field asks for leaves the workspace no room, and the warning that says so (or
  // "" when it leaves room): an allowance of 0, one at what is used, one below it. An empty
  // field asks for the standard allowance.
  function warningFor(v) {
    if (v === undefined || asking === null) return "";
    if (v === 0) return standard !== null ? TEXT.zeroStandard : TEXT.zeroNone;
    var wanted = v === null ? standard : v;
    if (wanted === null) return "";
    if (wanted === asking.a.used_bytes) return TEXT.warnEqualBefore + Dash.formatBytes(wanted) + TEXT.warnAfter;
    if (wanted < asking.a.used_bytes) return TEXT.warnBefore + Dash.formatBytes(wanted) + TEXT.warnAfter;
    return "";
  }

  // The warning instead of the hint, and Save anyway, when the allowance leaves no room. A
  // screen reader is pointed at whichever of the two is shown, never at the hidden one.
  function update() {
    if (asking === null) return;
    var text = warningFor(sizeOf($("allow-input").value));
    var warn = $("allow-warn");
    warn.textContent = text;
    warn.hidden = text === "";
    $("allow-hint").hidden = text !== "";
    $("allow-input").setAttribute("aria-describedby", text !== "" ? "allow-warn allow-message" : "allow-hint allow-message");
    $("allow-save").textContent = text !== "" ? TEXT.saveAnyway : TEXT.save;
  }

  function complain(text) {
    var input = $("allow-input");
    question.say(text);
    if (text !== "") input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  }

  function ask(a) {
    if (question.isOpen() || gone) return;
    var ws = a.workspace_id;
    asking = { a: a, ws: ws };
    var input = $("allow-input");
    $("allow-uses").textContent = TEXT.usesBefore + Dash.formatBytes(a.used_bytes) + TEXT.usesAfter;
    $("allow-hint").textContent = TEXT.hintSize + (standard !== null ? TEXT.hintStandardBefore + Dash.formatBytes(standard) + TEXT.hintStandardAfter : TEXT.hintNone);
    input.value = prefill(a);
    input.removeAttribute("aria-invalid");
    update();
    question.open({
      title: TEXT.askTitle + (typeof a.workspace_name === "string" ? a.workspace_name : ""),
      focus: "allow-input",
      // Back to the account's button, as the list shows it by then.
      back: function () { return buttons[ws]; },
      fallback: "h-page",
      onClose: function () {
        asking = null;
        $("allow-input").removeAttribute("aria-invalid");
      },
    });
    input.select();
  }

  function busy(on) {
    question.busy(on, "allow-save", on ? TEXT.saving : undefined);
    if (!on) update();
  }

  // After a failure: the sentence in the question, the buttons back, and the list read again.
  function failed(text) {
    busy(false);
    complain(text);
    $("allow-save").focus();
    return read().then(function () {
      if (asking === null) return;
      for (var i = 0; i < shown.length; i++) {
        if (shown[i].workspace_id === asking.ws) {
          asking.a = shown[i];
          $("allow-uses").textContent = TEXT.usesBefore + Dash.formatBytes(shown[i].used_bytes) + TEXT.usesAfter;
          update();
        }
      }
    });
  }

  function save() {
    if (asking === null || question.isWorking()) return;
    var input = $("allow-input");
    var v = sizeOf(input.value);
    if (v === undefined) {
      complain(TEXT.badSize);
      input.focus();
      return;
    }
    var id = asking.ws;
    complain("");
    say("");
    busy(true);
    Dash.api("PATCH", WORKSPACES + encodeURIComponent(id), { storage_allowance_bytes: v }).then(function (res) {
      if (res.status === 401) { Dash.signedOut(); return; }
      if (res.status !== 200) return failed(Dash.failure(res));
      busy(false);
      question.close(true);
      return read().then(function (r) {
        if (r === false) return;
        // The allowance is set; when the list cannot be read again, the page says so and keeps what it shows.
        say(r === true ? "" : TEXT.notReloaded);
        focusRow(id);
      });
    }, function () {
      return failed(Dash.TEXT.failed);
    });
  }

  function startPage() {
    $("admin-more").addEventListener("click", more);
    $("allow-cancel").addEventListener("click", function () { question.dismiss(); });
    $("allow-save").addEventListener("click", save);
    $("allow-input").addEventListener("input", function () {
      complain("");
      update();
    });
    // Enter in the field is Save.
    $("allow-input").addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      save();
    });
  }

  startPage();
  Dash.start(function (who) {
    // Nothing is asked of the admin routes before the session says admin.
    if (who.admin !== true) { notFound(); return; }
    return read().then(function (r) {
      if (r !== true && r !== false) $("dash-load").textContent = Dash.failure(r);
    });
  });
})();
`;
