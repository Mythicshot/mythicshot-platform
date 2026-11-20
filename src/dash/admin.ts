// The Admin page of the dashboard, /admin, as in the approved mockups 9 and 10 and the
// invites set's mockups 1 to 4: the summary line; the "Invite someone" card and the open
// invites, each with Resend and Cancel; every account with its workspace, tour count, a
// small usage bar, what it uses (with "Over" when it is over its allowance) and its
// allowance, "Show more" while the list has another page; and each account's More menu:
// Set allowance (the question that sets one workspace's allowance, with the warning when
// the new number is below what the workspace uses), Disable or Enable, and Delete.
//
// The document is the same for everyone and holds no data (src/dash/shell.ts); the admin
// screen in it is hidden. Its script, /dash/admin.js, asks nothing of the admin routes until
// the session says the person is the admin. For anyone else, and when an admin route
// answers 404 to a read, it takes the admin screen and its questions out of the page and
// shows what a missing page shows: "Page not found" and a link back to Tours. The admin
// routes answer everyone but the admin's session the one 404 (src/admin-api.ts), so a
// member's browser never receives their data either way. The invites are read only after
// the accounts were, so finding out costs no request more than before.
//
// Every account and invite is built with createElement and textContent: a username, an
// email address or a workspace's name can never become markup, and each is put in its own
// bidi-isolated element (class "name") wherever it stands inside a sentence. The email
// address is shown here, to the admin alone, by design. The bars' widths are set through
// the CSSOM (`style.width`), which the content security policy allows, never through a
// style attribute.
//
// Setting an allowance: the field takes a size as a person writes it (SIZE_JS below); empty
// means the standard allowance, which the API is told with null. An allowance that leaves the
// workspace no room (0, what it uses, or less) shows a warning and "Save anyway". Enter in the
// field is Save. The list is read one request at a time: Show more does nothing while a read
// runs, and a read waits for Show more. After every change the list is read again from the
// start through the pages shown so far, with the cursor exactly as the API gave it, and after
// any failure too, so the page never shows a number or a status the server did not give it.
//
// The house rules: one question or menu at a time, also while a request runs (every change
// sets `working`, which disables every row's controls and Send invite until the list is back);
// a held key's repeats press nothing; a second click sends nothing; an id goes into a path
// only when it has the API's shape, and escaped; an address goes only in a JSON body.
//
// Invites (POST, GET /api/v1/admin/invites, .../:id/resend, DELETE .../:id): Send invite
// checks the address's shape in the page (one @ with something on each side, no blank), then
// sends it. A 429 rests Send invite and every Resend for the answer's retry-after, as the
// Connections page rests Continue. Resend asks nothing; Cancel asks first. A 404 from either
// means the invite is gone: the list is read again. When no answer comes, the list read
// again decides: an invite whose dates changed was sent (whether its mail went out is not
// known, and the page says so); one no longer listed, while the list is whole (fewer than
// MAX_INVITES), was cancelled; anything else is a failure.
//
// Disable asks first, Enable asks nothing; when no answer comes, the row's status in the list
// read again decides. Delete first reads what it would remove (GET .../removal), then asks
// for the username to be typed (the email address for an account without one): the button
// stays disabled until the text is exactly that. Then DELETE {username} is sent again, with a
// short pause, while it answers 202, showing its progress; 500 cleanup_pending and a lost
// answer are sent again too, at most MAX_MISSES times in a row, and the whole loop at most
// MAX_ROUNDS times. A refusal stops it at once. However it ends, the list is read again: the
// account is deleted when the answer said so, or when the list no longer holds it. An
// interrupted delete leaves the account listed with "Deleting"; the API takes the username
// on every call, so the page keeps the name it was given in memory (never in storage) for
// the life of the page, and opening Delete again on that row goes straight on. After a
// reload it asks for the name again.
import { MAX_INVITES } from "../invites.ts";
import { dashHtml } from "./shell.ts";

const ADMIN_MAIN = `  <section id="admin" aria-labelledby="h-page" hidden>
    <h1 id="h-page" tabindex="-1">Admin</h1>
    <p class="sub" id="admin-summary"></p>
    <div class="card">
      <h2 class="card-title" id="h-invite" tabindex="-1">Invite someone</h2>
      <p class="note" id="invite-note" role="status" aria-live="polite" hidden></p>
      <p class="sub invite-text" id="invite-text">They get a mail with a link that works once and for 7 days. They pick their own username and get an empty workspace of their own.</p>
      <div class="inline">
        <label class="vh" for="invite-email">Email address</label>
        <input class="field" id="invite-email" type="email" placeholder="name@example.com" maxlength="254" autocomplete="off" spellcheck="false" aria-describedby="invite-text invite-message">
        <button type="button" class="btn" id="invite-go">Send invite</button>
      </div>
      <p class="message invite-message" id="invite-message" role="status" aria-live="polite" hidden></p>
    </div>
    <div class="card" id="invites" hidden>
      <h2 class="card-title" id="h-invites" tabindex="-1">Open invites</h2>
      <p class="note" id="invites-note" role="status" aria-live="polite" hidden></p>
      <p class="message" id="invites-message" role="status" aria-live="polite" hidden></p>
      <table class="invites" id="invites-table" hidden>
        <thead><tr><th scope="col">Address</th><th scope="col">Sent</th><th scope="col">Works until</th><th scope="col"><span class="vh">Actions</span></th></tr></thead>
        <tbody id="invites-rows"></tbody>
      </table>
      <p class="hint" id="invites-empty" hidden>No open invites.</p>
    </div>
    <div class="card">
      <h2 class="card-title" id="h-accounts" tabindex="-1">Accounts</h2>
      <p class="note" id="admin-note" role="status" aria-live="polite" hidden></p>
      <p class="message" id="admin-message" role="status" aria-live="polite" hidden></p>
      <table class="accounts">
        <thead><tr><th scope="col">Account</th><th scope="col">Workspace</th><th scope="col" class="n">Tours</th><th scope="col" class="bar"><span class="vh">Share</span></th><th scope="col" class="n">Used</th><th scope="col" class="n">Allowance</th><th scope="col"><span class="vh">Actions</span></th></tr></thead>
        <tbody id="admin-rows"></tbody>
      </table>
    </div>
    <div class="show-more"><button type="button" class="btn quiet" id="admin-more" hidden>Show more</button></div>
    <p class="hint">You see totals only. What is in another person's workspace is never shown here.</p>
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
  </div>
  <div class="backdrop" id="cancel-dialog" hidden>
    <div class="dialog" id="cancel-box" role="alertdialog" aria-modal="true" aria-labelledby="cancel-title" aria-describedby="cancel-text">
      <h2 id="cancel-title" tabindex="-1"></h2>
      <p class="sub" id="cancel-text">The link in the mail stops working. You can invite the same address again later.</p>
      <p class="message" id="cancel-message" role="status" aria-live="polite" hidden></p>
      <div class="two">
        <button type="button" class="btn quiet" id="cancel-keep">Keep it</button>
        <button type="button" class="btn danger" id="cancel-go">Cancel invite</button>
      </div>
    </div>
  </div>
  <div class="backdrop" id="disable-dialog" hidden>
    <div class="dialog" id="disable-box" role="alertdialog" aria-modal="true" aria-labelledby="disable-title" aria-describedby="disable-text disable-warn">
      <h2 id="disable-title" tabindex="-1"></h2>
      <p class="sub" id="disable-text"></p>
      <p class="warn-box" id="disable-warn">Pictures that people already opened may stay in their browsers.</p>
      <p class="message" id="disable-message" role="status" aria-live="polite" hidden></p>
      <div class="two">
        <button type="button" class="btn quiet" id="disable-keep">Keep it</button>
        <button type="button" class="btn danger" id="disable-go">Disable account</button>
      </div>
    </div>
  </div>
  <div class="backdrop" id="delete-dialog" hidden>
    <div class="dialog" id="delete-box" role="alertdialog" aria-modal="true" aria-labelledby="delete-title" aria-describedby="delete-text delete-warn">
      <h2 id="delete-title" tabindex="-1"></h2>
      <div id="delete-ask">
        <p class="sub" id="delete-text">This removes the account and everything in its workspace:</p>
        <dl class="kv" id="delete-facts"><dt>Tours</dt><dd id="delete-tours"></dd><dt>Images and GIFs</dt><dd id="delete-items"></dd><dt>Connected computers</dt><dd id="delete-computers"></dd><dt>Storage freed</dt><dd id="delete-bytes"></dd></dl>
        <p class="warn-box" id="delete-warn"></p>
        <label for="delete-input" id="delete-label"></label>
        <input class="field" id="delete-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="delete-message">
      </div>
      <div id="delete-progress" hidden>
        <div class="meter" aria-hidden="true"><div class="meter-fill" id="delete-fill"></div></div>
        <p class="hint" id="delete-done"></p>
      </div>
      <p class="message" id="delete-message" role="status" aria-live="polite" hidden></p>
      <div class="two" id="delete-buttons">
        <button type="button" class="btn quiet" id="delete-keep">Keep it</button>
        <button type="button" class="btn danger" id="delete-go">Delete account</button>
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
    zero: "An allowance of 0 refuses every upload from this workspace.",
    badSize: "Write a size such as 500 MB or 10 GB.",
    save: "Save",
    saveAnyway: "Save anyway",
    saving: "Saving…",
    notFound: "Page not found",
    disabled: "Disabled",
    notReloaded: "The change was made, but the list could not be loaded again. Reload the page to see it.",
    more: "More",
    disable: "Disable",
    enable: "Enable",
    remove: "Delete",
    deletingTag: "Deleting",
    sending: "Sending…",
    invitedBefore: "An invite is on its way to ",
    invitedMiddle: ". The link works once and until ",
    invitedAfter: ".",
    hasAccount: "That address already has an account.",
    badEmail: "That does not look like an email address.",
    mailOff: "This site cannot send mail, so nobody can be invited from here.",
    mailFailed: "The invite was saved, but the mail could not be sent. Press Resend to try again.",
    tooManyInvites: "There are ${MAX_INVITES} open invites already. Cancel one you no longer need first.",
    restBefore: "Too many invites in a short time. Try again in ",
    oneMinute: "1 minute.",
    minutes: " minutes.",
    lostSendAfter: " has an invite now, but the answer was lost on the way, so it is not known whether its mail went out. If it does not arrive, press Resend.",
    sentInLine: "sent ",
    untilInLine: "works until ",
    ranOut: "Ran out ",
    resend: "Resend",
    cancel: "Cancel",
    resentBefore: "A new invite is on its way to ",
    resentAfter: ". The earlier link no longer works.",
    lostResendAfter: " has a new link, so the earlier one no longer works, but the answer was lost on the way, so it is not known whether its mail went out. If it does not arrive, press Resend again.",
    inviteGone: "That invite is no longer open: it was used or cancelled meanwhile.",
    cancelBefore: "Cancel the invite to ",
    cancelAfter: "?",
    cancelling: "Cancelling…",
    disableBefore: 'Disable "',
    quoteAfter: '"?',
    fromNowOn: "From now on ",
    disableMiddle: " cannot sign in, Mythicshot on their computers cannot publish, and their ",
    oneTour: "1 tour",
    manyTours: " tours",
    allTours: "tours",
    disableEnd: " and every image and clip they shared stop being available to anyone. Nothing is deleted: enabling the account brings everything back.",
    disabling: "Disabling…",
    enabling: "Enabling…",
    enabledAfter: " is enabled again. Their tours and shared links work as before; they sign in again to use the dashboard.",
    ownDisable: "You cannot disable your own account.",
    lastAdminDisable: "This is the last admin, so it cannot be disabled.",
    ownEnable: "You cannot enable your own account.",
    beingDeleted: "This account is being deleted and cannot be enabled.",
    deleteBefore: 'Delete "',
    deleteAfter: '" for good?',
    removeWarnBefore: "This cannot be undone. Their links stop working for everyone, and ",
    removeWarnAfter: " can be invited again as a new account.",
    typeUsername: "Type the username to confirm",
    typeEmail: "Type the email address to confirm",
    deletingBefore: 'Deleting "',
    deletingAfter: '"…',
    filesBefore: "Removing files, ",
    filesOf: " of ",
    filesAfter: ". Keep this page open. If it is interrupted, open Delete again to finish.",
    deletedAfter: " was deleted.",
    mismatch: "That does not match. Type it exactly as it is shown in the list.",
    notDisabled: "Disable the account first.",
    siteOwner: "This account set the site up and cannot be deleted.",
    sharedWorkspace: "Another account belongs to this workspace, so it cannot be deleted.",
    lastAdminDelete: "This is the last admin, so it cannot be deleted.",
    ownDelete: "You cannot delete your own account.",
  };
  var ACCOUNTS = "/api/v1/admin/accounts";
  var WORKSPACES = "/api/v1/admin/workspaces/";
  var INVITES = "/api/v1/admin/invites";
  var USER_ID = /^usr_[0-9a-f]{24}$/;
  var WORKSPACE_ID = /^ws_[0-9a-f]{24}$/;
  var INVITE_ID = /^inv_[0-9a-f]{24}$/;
  // The most invites the list answers (src/invites.ts): with fewer, the list is the whole of them.
  var MAX_LISTED = ${MAX_INVITES};
  // A delete is sent again after this pause while it answers 202, at most MAX_ROUNDS times in
  // all; after a lost answer or 500 cleanup_pending, after MISS_PAUSES_MS, at most MAX_MISSES in a row.
  var PAUSE_MS = 300;
  var MISS_PAUSES_MS = [1000, 3000];
  var MAX_MISSES = 3;
  var MAX_ROUNDS = 5000;
  // How long Send invite and Resend rest after a 429 without a usable retry-after (the limits' hour), and at most.
  var WAIT_S = 3600;
  var MAX_WAIT_S = 86400;
  // What the page behind a question is, made inert while one is open.
  var BEHIND = ["dash-top", "admin"];
  // The questions (Dash.question, src/dash/script.ts).
  var question = Dash.question({ backdrop: "allow-dialog", box: "allow-box", role: "dialog", title: "allow-title", message: "allow-message", behind: BEHIND, fields: ["allow-input"], buttons: ["allow-cancel", "allow-save"], lock: "readonly" });
  var cancelQ = Dash.question({ backdrop: "cancel-dialog", box: "cancel-box", role: "alertdialog", title: "cancel-title", message: "cancel-message", behind: BEHIND, buttons: ["cancel-keep", "cancel-go"] });
  var disableQ = Dash.question({ backdrop: "disable-dialog", box: "disable-box", role: "alertdialog", title: "disable-title", message: "disable-message", behind: BEHIND, buttons: ["disable-keep", "disable-go"] });
  var deleteQ = Dash.question({ backdrop: "delete-dialog", box: "delete-box", role: "alertdialog", title: "delete-title", message: "delete-message", behind: BEHIND, fields: ["delete-input"], buttons: ["delete-keep", "delete-go"], lock: "readonly" });
${SIZE_JS}
  var $ = function (id) { return document.getElementById(id); };
  // The admin's own account id, from the session; null when it is not of the API's shape,
  // and then no row offers Disable, Enable or Delete.
  var me = null;
  // The standard allowance from the summary, null when there is none.
  var standard = null;
  // The accounts shown, how many pages of the list they are, and the cursor of the page after them.
  var shown = [];
  var pages = 0;
  var next = null;
  // Each account's More button, by workspace id, to give focus back after the list is rebuilt.
  var moreOf = {};
  // The invites shown, and each one's Resend and Cancel, by invite id.
  var invites = [];
  var resendOf = {};
  var cancelOf = {};
  // Every control of every row (accounts, their menus, invites), disabled while a change runs.
  var rowButtons = [];
  // The menu that is open.
  var openMenu = null;
  // The questions' subjects: { a, ws } for the allowance, the invite to cancel, the account to
  // disable, and { id, ws, expected, label, email } for the account to delete.
  var asking = null;
  var cancelling = null;
  var disabling = null;
  var removing = null;
  // The name a delete was confirmed with, by account id, kept for the life of the page so an
  // interrupted delete can be finished: the API wants it on every call.
  var confirmed = {};
  // A change is running (a send, a resend, a cancel, a disable, an enable, a delete, or the
  // read before the delete question): one at a time, and nothing else opens meanwhile.
  var working = false;
  // Send invite and Resend rest until blockedUntil after a 429.
  var blockedUntil = 0;
  var blockNo = 0;
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

  // A line made of fixed text and other people's text, alternately: each name (at the odd
  // places) in its own bidi-isolated element, so its letters cannot reorder the words around it.
  function fill(line, parts) {
    line.textContent = "";
    for (var i = 0; i < parts.length; i++) line.appendChild(el("span", i % 2 === 1 ? "name" : "", parts[i]));
  }

  // A green note (or a plain one, for a lost answer); note(id, null) hides it.
  function note(id, parts, plain) {
    var line = $(id);
    if (line === null) return;
    if (parts === null) {
      line.textContent = "";
      line.hidden = true;
      return;
    }
    line.className = plain === true ? "note plain" : "note";
    fill(line, parts);
    line.hidden = false;
  }

  // Nothing said anywhere on the page from an earlier change.
  function quiet() {
    say("");
    note("admin-note", null);
    note("invite-note", null);
    note("invites-note", null);
    sayIn($("invites-message"), "");
    if (!blocked()) sayIn($("invite-message"), "");
  }

  function anyOpen() {
    return question.isOpen() || cancelQ.isOpen() || disableQ.isOpen() || deleteQ.isOpen();
  }

  // Whether something may start: nothing running, no question open, the page still here.
  function free() {
    return !working && !anyOpen() && !gone;
  }

  // A held key's repeats never press a button.
  function noRepeat(b) {
    b.addEventListener("keydown", function (ev) {
      if (ev.repeat === true && (ev.key === "Enter" || ev.key === " ")) ev.preventDefault();
    });
  }

  function blocked() {
    return blockedUntil !== 0 && Date.now() < blockedUntil;
  }

  // The rows' controls and Send invite: disabled while a change runs, Resend and Send invite also while they rest.
  function syncRows() {
    rowButtons.forEach(function (b) { b.el.disabled = working || (b.rests === true && blocked()); });
    var go = $("invite-go");
    if (go !== null) go.disabled = working || blocked();
  }

  function setWorking(on) {
    working = on;
    if (on) closeMenu(false);
    syncRows();
  }

  function busyButton(btn, on, label) {
    if (btn === null || btn === undefined) return;
    if (on) {
      btn.setAttribute("data-label", btn.textContent);
      btn.textContent = label;
      btn.setAttribute("aria-busy", "true");
    } else {
      if (btn.hasAttribute("data-label")) btn.textContent = btn.getAttribute("data-label");
      btn.removeAttribute("data-label");
      btn.removeAttribute("aria-busy");
    }
  }

  // ---- A missing page, for anyone but the admin ----

  // The admin screen and its questions leave the page; what is left is what a missing page shows.
  function notFound() {
    [question, cancelQ, disableQ, deleteQ].forEach(function (q) { q.close(false); });
    asking = null;
    cancelling = null;
    disabling = null;
    removing = null;
    openMenu = null;
    gone = true;
    var parts = [$("admin"), $("allow-dialog"), $("cancel-dialog"), $("disable-dialog"), $("delete-dialog")];
    for (var i = 0; i < parts.length; i++) if (parts[i] !== null) parts[i].remove();
    $("dash-load").textContent = "";
    document.title = TEXT.notFound;
    $("missing").hidden = false;
  }

  // ---- Reading the list ----

  // The list's cursor is opaque base64url text (src/admin-api.ts), sent back exactly as it
  // came; anything else ends the paging.
  var CURSOR = /^[A-Za-z0-9_-]{20,100}$/;

  function cursorOf(v) {
    return typeof v === "string" && CURSOR.test(v) ? v : null;
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

  // The account with this id as the list shows it now, or null.
  function accountById(id) {
    for (var i = 0; i < shown.length; i++) if (shown[i].id === id) return shown[i];
    return null;
  }

  // ---- The More menu, as on the Tours page ----

  function openTheMenu(m, index) {
    closeMenu(false);
    if (!free()) return;
    m.menu.hidden = false;
    m.button.setAttribute("aria-expanded", "true");
    openMenu = m;
    m.entries[index].focus();
  }

  function closeMenu(refocus) {
    if (openMenu === null) return;
    var m = openMenu;
    openMenu = null;
    m.menu.hidden = true;
    m.button.setAttribute("aria-expanded", "false");
    if (refocus) m.button.focus();
  }

  function moreMenu(a, i, items, nameId) {
    var wrap = el("div", "more");
    var btn = el("button", "btn sm quiet", TEXT.more);
    btn.type = "button";
    btn.setAttribute("aria-haspopup", "true");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", "menu-" + i);
    btn.setAttribute("aria-describedby", nameId);
    noRepeat(btn);
    rowButtons.push({ el: btn });
    var menu = el("div", "menu");
    menu.setAttribute("id", "menu-" + i);
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-labelledby", nameId);
    menu.hidden = true;
    var m = { wrap: wrap, button: btn, menu: menu, entries: [] };
    items.forEach(function (item) {
      var entry = el("button", item.danger ? "danger" : "", item.text);
      entry.type = "button";
      entry.setAttribute("role", "menuitem");
      entry.setAttribute("tabindex", "-1");
      noRepeat(entry);
      entry.addEventListener("click", function () {
        if (openMenu !== m) return;
        closeMenu(true);
        item.run();
      });
      menu.appendChild(entry);
      m.entries.push(entry);
      rowButtons.push({ el: entry });
    });
    btn.addEventListener("click", function () {
      if (openMenu === m) closeMenu(true);
      else openTheMenu(m, 0);
    });
    btn.addEventListener("keydown", function (ev) {
      if (ev.repeat === true) return;
      if (ev.key === "ArrowDown") { ev.preventDefault(); openTheMenu(m, 0); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); openTheMenu(m, m.entries.length - 1); }
    });
    menu.addEventListener("keydown", function (ev) {
      var n = m.entries.length;
      var at = m.entries.indexOf(document.activeElement);
      if (ev.key === "ArrowDown") { ev.preventDefault(); m.entries[(at + 1) % n].focus(); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); m.entries[(at - 1 + n) % n].focus(); }
      else if (ev.key === "Home") { ev.preventDefault(); m.entries[0].focus(); }
      else if (ev.key === "End") { ev.preventDefault(); m.entries[n - 1].focus(); }
      else if (ev.key === "Escape") { ev.preventDefault(); closeMenu(true); }
      else if (ev.key === "Tab") closeMenu(false);
    });
    wrap.appendChild(btn);
    wrap.appendChild(menu);
    moreOf[a.workspace_id] = btn;
    return wrap;
  }

  // ---- One account ----

  function labelled(td, label) {
    td.setAttribute("data-label", label);
    return td;
  }

  // The name an account is shown and asked about by: its username, or its email address without one.
  function nameOf(a) {
    return typeof a.username === "string" && a.username !== "" ? a.username : typeof a.email === "string" ? a.email : "";
  }

  // What the account's More menu holds. The admin's own row has nothing that the API refuses
  // for it; an account whose delete has started has only Delete, to finish it.
  function entriesOf(a) {
    var items = [];
    var own = me === null || a.id === me || !USER_ID.test(a.id);
    if (a.deleting === true && !own) return [{ text: TEXT.remove, danger: true, run: function () { askDelete(a); } }];
    items.push({ text: TEXT.setAllowance, run: function () { ask(a); } });
    if (own) return items;
    if (a.status === "disabled") {
      items.push({ text: TEXT.enable, run: function () { runEnable(a); } });
      items.push({ text: TEXT.remove, danger: true, run: function () { askDelete(a); } });
    } else items.push({ text: TEXT.disable, run: function () { askDisable(a); } });
    return items;
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
    if (a.deleting === true) t.appendChild(el("span", "tag warn", TEXT.deletingTag));
    else if (a.status === "disabled") t.appendChild(el("span", "tag", TEXT.disabled));
    who.appendChild(t);
    if (named && email !== "") who.appendChild(el("div", "d name", email));
    tr.appendChild(who);
    tr.appendChild(el("td", "ws name", typeof a.workspace_name === "string" ? a.workspace_name : ""));
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
    acts.appendChild(moreMenu(a, i, entriesOf(a), nameId));
    cell.appendChild(acts);
    tr.appendChild(cell);
    return tr;
  }

  // The rows rebuilt from the list; the invites' controls are kept.
  function render() {
    closeMenu(false);
    var had = document.activeElement;
    var hadWs = null;
    for (var ws in moreOf) if (Object.prototype.hasOwnProperty.call(moreOf, ws) && moreOf[ws] === had) hadWs = ws;
    moreOf = {};
    rowButtons = rowButtons.filter(function (b) { return b.invite === true; });
    var rows = $("admin-rows");
    rows.textContent = "";
    for (var i = 0; i < shown.length; i++) rows.appendChild(row(shown[i], i));
    $("admin-more").hidden = next === null;
    syncRows();
    if (hadWs !== null && moreOf[hadWs] !== undefined) moreOf[hadWs].focus();
  }

  function focusRow(ws) {
    var b = moreOf[ws];
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
    // Decided on the allowance that would apply, typed or the standard one for an empty field.
    var wanted = v === null ? standard : v;
    if (wanted === null) return "";
    if (wanted === 0) return TEXT.zero;
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
    if (!free()) return;
    var ws = a.workspace_id;
    var input = $("allow-input");
    $("allow-uses").textContent = TEXT.usesBefore + Dash.formatBytes(a.used_bytes) + TEXT.usesAfter;
    $("allow-hint").textContent = TEXT.hintSize + (standard !== null ? TEXT.hintStandardBefore + Dash.formatBytes(standard) + TEXT.hintStandardAfter : TEXT.hintNone);
    input.value = prefill(a);
    input.removeAttribute("aria-invalid");
    asking = { a: a, ws: ws };
    update();
    var opened = question.open({
      title: TEXT.askTitle + (typeof a.workspace_name === "string" ? a.workspace_name : ""),
      focus: "allow-input",
      // Back to the account's More, as the list shows it by then.
      back: function () { return moreOf[ws]; },
      fallback: "h-page",
      onClose: function () {
        asking = null;
        $("allow-input").removeAttribute("aria-invalid");
      },
    });
    if (!opened) { asking = null; return; }
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
    quiet();
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

  // ---- Invites ----

  function isTime(n) {
    return typeof n === "number" && isFinite(n);
  }

  function inviteOk(v) {
    return v !== null && typeof v === "object" && typeof v.id === "string" && INVITE_ID.test(v.id) && typeof v.email === "string" && isTime(v.created_at) && isTime(v.expires_at);
  }

  // The same check as the sign-in page's: one @ with something on each side, no blank. The
  // server decides the rest (bad_email).
  function looksLikeEmail(v) {
    if (v.length === 0 || v.length > 254 || /\\s/.test(v)) return false;
    var parts = v.split("@");
    return parts.length === 2 && parts[0] !== "" && parts[1] !== "";
  }

  function inviteSays(text) {
    sayIn($("invite-message"), text);
    var input = $("invite-email");
    if (text === TEXT.badEmail) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  }

  // A 429: Send invite and every Resend rest for its retry-after (whole seconds), rounded up
  // to minutes in the sentence, said on the line of the card it came from.
  function block(retryAfter, lineId) {
    var s = typeof retryAfter === "string" && /^[0-9]{1,9}$/.test(retryAfter) ? Number(retryAfter) : WAIT_S;
    s = Math.min(MAX_WAIT_S, Math.max(1, s));
    var n = Math.ceil(s / 60);
    blockedUntil = Date.now() + s * 1000;
    var mine = ++blockNo;
    var line = $(lineId);
    var text = TEXT.restBefore + (n === 1 ? TEXT.oneMinute : n + TEXT.minutes);
    if (lineId === "invite-message") inviteSays(text);
    else sayIn(line, text);
    syncRows();
    setTimeout(function () {
      if (mine !== blockNo) return;
      blockedUntil = 0;
      if (line !== null && line.textContent === text) sayIn(line, "");
      syncRows();
    }, s * 1000);
  }

  function inviteRow(v, i) {
    var tr = el("tr");
    var nameId = "invite-" + i;
    var sent = Dash.dateOf(v.created_at, true);
    var expired = v.state === "expired";
    var until = Dash.dateOf(v.expires_at, true);

    var what = el("td", "what");
    var name = el("div", "t name", v.email);
    name.setAttribute("id", nameId);
    what.appendChild(name);
    var d = el("div", "d narrow-only");
    d.appendChild(el("span", "", TEXT.sentInLine + sent + TEXT.dot));
    if (expired) d.appendChild(el("span", "tag warn", TEXT.ranOut + Dash.dateOf(v.expires_at)));
    else d.appendChild(el("span", "", TEXT.untilInLine + until));
    what.appendChild(d);
    tr.appendChild(what);
    tr.appendChild(el("td", "when", sent));
    var end = el("td", "when");
    if (expired) end.appendChild(el("span", "tag warn", TEXT.ranOut + Dash.dateOf(v.expires_at)));
    else end.textContent = until;
    tr.appendChild(end);

    var cell = el("td", "acts-cell");
    var acts = el("div", "acts");
    var again = el("button", "btn sm quiet", TEXT.resend);
    again.type = "button";
    again.setAttribute("aria-describedby", nameId);
    noRepeat(again);
    again.addEventListener("click", function () { runResend(v, again); });
    var drop = el("button", "btn sm danger", TEXT.cancel);
    drop.type = "button";
    drop.setAttribute("aria-describedby", nameId);
    noRepeat(drop);
    drop.addEventListener("click", function () { askCancel(v); });
    acts.appendChild(again);
    acts.appendChild(drop);
    cell.appendChild(acts);
    tr.appendChild(cell);
    resendOf[v.id] = again;
    cancelOf[v.id] = drop;
    rowButtons.push({ el: again, invite: true, rests: true }, { el: drop, invite: true });
    return tr;
  }

  function renderInvites(list) {
    invites = list;
    resendOf = {};
    cancelOf = {};
    rowButtons = rowButtons.filter(function (b) { return b.invite !== true; });
    var rows = $("invites-rows");
    rows.textContent = "";
    for (var i = 0; i < list.length; i++) rows.appendChild(inviteRow(list[i], i));
    $("invites-table").hidden = list.length === 0;
    $("invites-empty").hidden = list.length !== 0;
    $("invites").hidden = false;
    syncRows();
  }

  function gotInvites(r) {
    return r !== null && r !== false && typeof r === "object" && r.shown === true;
  }

  // The invites read and shown. Resolves to { shown: true, list, complete } (complete: the
  // list holds every invite), false when the visitor was sent on, or the answer that failed
  // (null when none came); then the card keeps what it showed.
  function readInvites() {
    return Dash.api("GET", INVITES).then(function (res) {
      if (res.status === 401) { Dash.signedOut(); return false; }
      if (res.status === 404) { notFound(); return false; }
      var d = res.data;
      if (res.status !== 200 || d === null || typeof d !== "object" || !Array.isArray(d.invites) || gone) return res;
      var list = d.invites.filter(inviteOk);
      renderInvites(list);
      return { shown: true, list: list, complete: d.invites.length < MAX_LISTED };
    }, function () { return null; });
  }

  function inviteById(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function inviteByEmail(list, email) {
    for (var i = 0; i < list.length; i++) if (list[i].email === email) return list[i];
    return null;
  }

  // Sending: the address in the body of POST /api/v1/admin/invites.
  function sendInvite() {
    if (!free() || blocked()) return;
    var input = $("invite-email");
    var v = String(input.value).trim();
    if (v === "") { input.focus(); return; }
    quiet();
    if (!looksLikeEmail(v)) {
      inviteSays(TEXT.badEmail);
      input.focus();
      return;
    }
    inviteSays("");
    // What the list said of this address before, to tell after a lost answer whether it was sent.
    var known = inviteByEmail(invites, v.toLowerCase());
    var before = known === null ? null : known.created_at;
    setWorking(true);
    busyButton($("invite-go"), true, TEXT.sending);
    function done() {
      busyButton($("invite-go"), false);
      setWorking(false);
    }
    function settle(res) {
      if (res !== null && res.status === 401) { Dash.signedOut(); return; }
      var code = Dash.errorOf(res);
      var status = res === null ? 0 : res.status;
      if (status === 201 && inviteOk(res.data)) {
        var entry = res.data;
        input.value = "";
        note("invite-note", [TEXT.invitedBefore, entry.email, TEXT.invitedMiddle + Dash.dateOf(entry.expires_at, true) + TEXT.invitedAfter]);
        return readInvites().then(function () {
          done();
          if (!gone) input.focus();
        });
      }
      if (res === null || status === 502 || status === 404) {
        // The invite may be there: the list read again says so.
        return readInvites().then(function (r) {
          done();
          if (r === false) return;
          if (status === 502 && Dash.errorOf(res) === "mail_failed") inviteSays(TEXT.mailFailed);
          else if (res === null && gotInvites(r)) {
            var now = inviteByEmail(r.list, v.toLowerCase());
            if (now !== null && now.created_at !== before) {
              input.value = "";
              note("invite-note", ["", now.email, TEXT.lostSendAfter], true);
            } else inviteSays(Dash.TEXT.failed);
          } else inviteSays(res === null ? Dash.TEXT.failed : Dash.failure(res));
          input.focus();
        });
      }
      done();
      if (status === 429) block(res.retryAfter, "invite-message");
      else if (status === 409 && code === "has_account") inviteSays(TEXT.hasAccount);
      else if (status === 400) inviteSays(TEXT.badEmail);
      else if (status === 409 && code === "mail_off") inviteSays(TEXT.mailOff);
      else if (status === 409 && code === "too_many_invites") inviteSays(TEXT.tooManyInvites);
      else inviteSays(Dash.failure(res));
      input.focus();
    }
    Dash.api("POST", INVITES, { email: v }).then(settle, function () { return settle(null); });
  }

  // Resend asks nothing: a fresh link, and the earlier one stops working.
  function runResend(v, btn) {
    if (!free() || blocked() || !INVITE_ID.test(v.id)) return;
    quiet();
    var before = v.created_at;
    setWorking(true);
    busyButton(btn, true, TEXT.sending);
    function settle(res) {
      if (res !== null && res.status === 401) { Dash.signedOut(); return; }
      var status = res === null ? 0 : res.status;
      var code = Dash.errorOf(res);
      if (status === 429) {
        busyButton(btn, false);
        setWorking(false);
        block(res.retryAfter, "invites-message");
        btn.focus();
        return;
      }
      // However it ended, the list is read again before the page says anything.
      return readInvites().then(function (r) {
        busyButton(btn, false);
        setWorking(false);
        if (r === false) return;
        var now = gotInvites(r) ? inviteById(r.list, v.id) : null;
        if (status === 200 && inviteOk(res.data)) note("invites-note", [TEXT.resentBefore, res.data.email, TEXT.resentAfter]);
        else if (status === 404 || (res === null && gotInvites(r) && now === null)) sayIn($("invites-message"), TEXT.inviteGone);
        else if (res === null && now !== null && now.created_at !== before) note("invites-note", ["", now.email, TEXT.lostResendAfter], true);
        else if (status === 502 && code === "mail_failed") sayIn($("invites-message"), TEXT.mailFailed);
        else if (status === 409 && code === "has_account") sayIn($("invites-message"), TEXT.hasAccount);
        else if (status === 409 && code === "mail_off") sayIn($("invites-message"), TEXT.mailOff);
        else if (status === 409 && code === "too_many_invites") sayIn($("invites-message"), TEXT.tooManyInvites);
        else sayIn($("invites-message"), res === null ? Dash.TEXT.failed : Dash.failure(res));
        if (!gotInvites(r) && (status === 200 || status === 404)) say(TEXT.notReloaded);
        var back = resendOf[v.id];
        if (back !== undefined) back.focus();
        else $("h-invites").focus();
      });
    }
    Dash.api("POST", INVITES + "/" + encodeURIComponent(v.id) + "/resend").then(settle, function () { return settle(null); });
  }

  function askCancel(v) {
    if (!free() || !INVITE_ID.test(v.id)) return;
    fill($("cancel-title"), [TEXT.cancelBefore, v.email, TEXT.cancelAfter]);
    var opened = cancelQ.open({
      focus: "cancel-keep",
      // Back to the invite's Cancel, as the list shows it by then.
      back: function () { return cancelOf[v.id]; },
      fallback: "h-invites",
      onClose: function () { cancelling = null; },
    });
    if (opened) cancelling = v;
  }

  function runCancel() {
    if (cancelling === null || cancelQ.isWorking()) return;
    var v = cancelling;
    cancelQ.say("");
    quiet();
    setWorking(true);
    cancelQ.busy(true, "cancel-go", TEXT.cancelling);
    function settle(res) {
      if (res !== null && res.status === 401) { Dash.signedOut(); return; }
      return readInvites().then(function (r) {
        if (r === false) return;
        // 204, and 404 (already gone), are done. With no answer, the list just read decides,
        // and only while it is the whole list.
        var done = res !== null && (res.status === 204 || res.status === 404);
        if (res === null && gotInvites(r) && r.complete && inviteById(r.list, v.id) === null) done = true;
        cancelQ.busy(false, "cancel-go");
        setWorking(false);
        if (done) {
          cancelQ.close(false);
          say(gotInvites(r) ? "" : TEXT.notReloaded);
          $("h-invites").focus();
          return;
        }
        cancelQ.say(res === null ? Dash.TEXT.failed : Dash.failure(res));
        $("cancel-go").focus();
      });
    }
    Dash.api("DELETE", INVITES + "/" + encodeURIComponent(v.id)).then(settle, function () { return settle(null); });
  }

  // ---- Disable and enable ----

  // "their 3 tours", "their 1 tour", and "their tours" for none.
  function toursOf(n) {
    if (typeof n !== "number" || !(n > 0)) return TEXT.allTours;
    return n === 1 ? TEXT.oneTour : n + TEXT.manyTours;
  }

  function askDisable(a) {
    if (!free() || !USER_ID.test(a.id)) return;
    var name = nameOf(a);
    fill($("disable-title"), [TEXT.disableBefore, name, TEXT.quoteAfter]);
    fill($("disable-text"), [TEXT.fromNowOn, name, TEXT.disableMiddle + toursOf(a.tours) + TEXT.disableEnd]);
    var ws = a.workspace_id;
    var opened = disableQ.open({
      focus: "disable-keep",
      back: function () { return moreOf[ws]; },
      fallback: "h-accounts",
      onClose: function () { disabling = null; },
    });
    if (opened) disabling = { id: a.id, ws: ws };
  }

  function refusalOf(kind, res) {
    var code = Dash.errorOf(res);
    var status = res === null ? 0 : res.status;
    if (status === 409 && code === "own_account") return kind === "disable" ? TEXT.ownDisable : kind === "enable" ? TEXT.ownEnable : TEXT.ownDelete;
    if (status === 409 && code === "last_admin") return kind === "disable" ? TEXT.lastAdminDisable : TEXT.lastAdminDelete;
    if (kind === "enable" && status === 409 && code === "deleting") return TEXT.beingDeleted;
    if (kind === "delete" && status === 400 && code === "username_mismatch") return TEXT.mismatch;
    if (kind === "delete" && status === 409 && code === "not_disabled") return TEXT.notDisabled;
    if (kind === "delete" && status === 409 && code === "site_owner") return TEXT.siteOwner;
    if (kind === "delete" && status === 409 && code === "shared_workspace") return TEXT.sharedWorkspace;
    return res === null ? Dash.TEXT.failed : Dash.failure(res);
  }

  function runDisable() {
    if (disabling === null || disableQ.isWorking()) return;
    var d = disabling;
    disableQ.say("");
    quiet();
    setWorking(true);
    disableQ.busy(true, "disable-go", TEXT.disabling);
    function settle(res) {
      if (res !== null && res.status === 401) { Dash.signedOut(); return; }
      // However it ended, the list is read again; with no answer, the row's status decides.
      return read().then(function (r) {
        if (r === false) return;
        var now = r === true ? accountById(d.id) : null;
        var done = res !== null && res.status === 204;
        if (r === true && (res === null || (res !== null && res.status === 404))) {
          if (now !== null && now.status === "disabled") done = true;
          if (now === null && res !== null) done = true;
        }
        disableQ.busy(false, "disable-go");
        setWorking(false);
        if (done) {
          disableQ.close(false);
          say(r === true ? "" : TEXT.notReloaded);
          focusRow(d.ws);
          return;
        }
        disableQ.say(refusalOf("disable", res));
        $("disable-go").focus();
      });
    }
    Dash.api("POST", ACCOUNTS + "/" + encodeURIComponent(d.id) + "/disable").then(settle, function () { return settle(null); });
  }

  // Enable asks nothing.
  function runEnable(a) {
    if (!free() || !USER_ID.test(a.id)) return;
    var ws = a.workspace_id;
    var name = nameOf(a);
    quiet();
    setWorking(true);
    var btn = moreOf[ws];
    busyButton(btn, true, TEXT.enabling);
    function settle(res) {
      if (res !== null && res.status === 401) { Dash.signedOut(); return; }
      return read().then(function (r) {
        busyButton(moreOf[ws] === btn ? btn : null, false);
        setWorking(false);
        if (r === false) return;
        var now = r === true ? accountById(a.id) : null;
        var done = res !== null && res.status === 204;
        if (res === null && now !== null && now.status === "active") done = true;
        if (done) {
          note("admin-note", ["", name, TEXT.enabledAfter]);
          if (r !== true) say(TEXT.notReloaded);
        } else say(refusalOf("enable", res));
        focusRow(ws);
      });
    }
    Dash.api("POST", ACCOUNTS + "/" + encodeURIComponent(a.id) + "/enable").then(settle, function () { return settle(null); });
  }

  // ---- Delete ----

  function pause(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function removalOk(d) {
    return d !== null && typeof d === "object" && (d.username === null || typeof d.username === "string") && typeof d.email === "string" && isTime(d.tours) && isTime(d.items) && isTime(d.connections) && isTime(d.used_bytes);
  }

  function progressOk(d) {
    return d !== null && typeof d === "object" && isTime(d.done) && isTime(d.total) && d.done >= 0 && d.total >= 0;
  }

  // The button works only while the field holds exactly the name the API wants.
  function syncDelete() {
    if (removing === null || deleteQ.isWorking()) return;
    $("delete-go").disabled = $("delete-input").value !== removing.expected;
  }

  // The question's two views: what goes and the name to type, or the progress of a delete running.
  function deleteView(running, progress) {
    var r = removing;
    $("delete-ask").hidden = running;
    $("delete-buttons").hidden = running;
    $("delete-progress").hidden = !running;
    $("delete-box").setAttribute("aria-describedby", running ? "delete-done" : "delete-text delete-warn");
    if (running) {
      fill($("delete-title"), [TEXT.deletingBefore, r.label, TEXT.deletingAfter]);
      var done = progress === null ? 0 : Math.min(progress.done, progress.total);
      var total = progress === null ? 0 : progress.total;
      var share = total > 0 ? Math.round((done / total) * 10000) / 100 : 0;
      $("delete-fill").style.width = share + "%";
      $("delete-done").textContent = progress === null ? "" : TEXT.filesBefore + done + TEXT.filesOf + total + TEXT.filesAfter;
    } else fill($("delete-title"), [TEXT.deleteBefore, r.label, TEXT.deleteAfter]);
  }

  // The counts the question shows.
  function showRemoval(d) {
    $("delete-tours").textContent = String(d.tours);
    $("delete-items").textContent = String(d.items);
    $("delete-computers").textContent = String(d.connections);
    $("delete-bytes").textContent = Dash.formatBytes(d.used_bytes);
    fill($("delete-warn"), [TEXT.removeWarnBefore, d.email, TEXT.removeWarnAfter]);
  }

  // Delete: what it would remove is read first, then the question asks for the name. On a row
  // whose delete has started and whose name this page was given, it goes straight on.
  function askDelete(a) {
    if (!free() || !USER_ID.test(a.id)) return;
    var ws = a.workspace_id;
    quiet();
    setWorking(true);
    function settle(res) {
      if (res !== null && res.status === 401) { Dash.signedOut(); return; }
      setWorking(false);
      if (res !== null && res.status === 200 && removalOk(res.data)) {
        var d = res.data;
        // What the API compares the confirmation with: the username, or the email address without one.
        var expected = d.username !== null ? d.username : d.email;
        openDelete({ id: a.id, ws: ws, expected: expected, label: d.username !== null && d.username !== "" ? d.username : d.email, named: d.username !== null }, d);
        // Started from this page before: the API takes the same name again, so it goes on without asking.
        if (removing !== null && a.deleting === true && confirmed[a.id] === expected) runDelete();
        return;
      }
      if (res !== null && res.status === 404) {
        // Gone, or this session is no longer the admin's: the list read again says which.
        setWorking(true);
        return read().then(function (r) {
          setWorking(false);
          if (r === false) return;
          if (r !== true || accountById(a.id) !== null) say(r === true ? Dash.TEXT.failed : Dash.failure(r));
          focusRow(ws);
        });
      }
      say(res === null ? Dash.TEXT.failed : Dash.failure(res));
      focusRow(ws);
    }
    Dash.api("GET", ACCOUNTS + "/" + encodeURIComponent(a.id) + "/removal").then(settle, function () { return settle(null); });
  }

  function openDelete(r, d) {
    if (anyOpen() || gone) return;
    removing = r;
    var input = $("delete-input");
    input.value = confirmed[r.id] === r.expected ? r.expected : "";
    $("delete-label").textContent = r.named === false ? TEXT.typeEmail : TEXT.typeUsername;
    if (d !== null) showRemoval(d);
    deleteView(false, null);
    var opened = deleteQ.open({
      focus: "delete-input",
      back: function () { return moreOf[r.ws]; },
      fallback: "h-accounts",
      onClose: function () { removing = null; },
    });
    if (!opened) { removing = null; return; }
    syncDelete();
  }

  function runDelete() {
    if (removing === null || deleteQ.isWorking()) return;
    var r = removing;
    // Pressed only with the name exactly as the API wants it in the field (a click on a
    // disabled button reaches nothing; this holds when one does anyway).
    if ($("delete-input").value !== r.expected) return;
    deleteQ.say("");
    quiet();
    setWorking(true);
    deleteQ.busy(true, "delete-go");
    deleteView(true, null);
    $("delete-title").focus();
    var path = ACCOUNTS + "/" + encodeURIComponent(r.id);
    var rounds = 0;
    var misses = 0;
    function send() {
      if (gone) return Promise.resolve();
      rounds++;
      return Dash.api("DELETE", path, { username: r.expected }).then(step, function () { return step(null); });
    }
    function step(res) {
      if (res !== null && res.status === 401) { Dash.signedOut(); return; }
      if (gone) return;
      if (res !== null && res.status === 202 && progressOk(res.data)) {
        // Started: the name is kept, so an interrupted delete can be finished from this page.
        confirmed[r.id] = r.expected;
        misses = 0;
        deleteView(true, res.data);
        return rounds < MAX_ROUNDS ? pause(PAUSE_MS).then(send) : finish(null, false);
      }
      if (res !== null && res.status === 200) return finish(res, true);
      var again = res === null || (res.status === 500 && Dash.errorOf(res) === "cleanup_pending");
      if (again && rounds < MAX_ROUNDS) {
        misses++;
        if (misses < MAX_MISSES) return pause(MISS_PAUSES_MS[misses - 1]).then(send);
      }
      return finish(res, false);
    }
    // However it ended, the list is read again: the account is deleted when the answer said
    // so, or when the list no longer holds it (after a 404 or a lost answer).
    function finish(res, deleted) {
      return read().then(function (got) {
        if (got === false || gone) return;
        var now = got === true ? accountById(r.id) : null;
        var deletedNow = deleted || (got === true && now === null && (res === null || res.status === 404 || res.status === 500));
        if (res !== null && res.status === 400 && Dash.errorOf(res) === "username_mismatch") delete confirmed[r.id];
        deleteQ.busy(false, "delete-go");
        setWorking(false);
        if (deletedNow) {
          delete confirmed[r.id];
          deleteQ.close(false);
          note("admin-note", ["", r.label, TEXT.deletedAfter]);
          if (got !== true) say(TEXT.notReloaded);
          $("h-accounts").focus();
          return;
        }
        // Interrupted or refused: back to the question, which says so; pressing Delete account goes on.
        deleteView(false, null);
        deleteQ.say(refusalOf("delete", res));
        syncDelete();
        if ($("delete-go").disabled) $("delete-input").focus();
        else $("delete-go").focus();
      });
    }
    send();
  }

  function startPage() {
    $("admin-more").addEventListener("click", more);
    $("allow-cancel").addEventListener("click", function () { question.dismiss(); });
    $("allow-save").addEventListener("click", save);
    $("allow-input").addEventListener("input", function () {
      complain("");
      update();
    });
    // Enter in the field is Save; a held Enter's repeats do nothing.
    $("allow-input").addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      if (ev.repeat === true) return;
      save();
    });
    $("invite-go").addEventListener("click", sendInvite);
    $("invite-email").addEventListener("input", function () {
      if (!blocked()) inviteSays("");
    });
    // Enter in the field is Send invite; a held Enter's repeats do nothing.
    $("invite-email").addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      if (ev.repeat === true) return;
      sendInvite();
    });
    $("cancel-keep").addEventListener("click", function () { cancelQ.dismiss(); });
    $("cancel-go").addEventListener("click", runCancel);
    $("disable-keep").addEventListener("click", function () { disableQ.dismiss(); });
    $("disable-go").addEventListener("click", runDisable);
    $("delete-keep").addEventListener("click", function () { deleteQ.dismiss(); });
    $("delete-go").addEventListener("click", runDelete);
    $("delete-input").addEventListener("input", function () {
      deleteQ.say("");
      syncDelete();
    });
    ["invite-go", "allow-cancel", "allow-save", "cancel-keep", "cancel-go", "disable-keep", "disable-go", "delete-keep", "delete-go", "admin-more"].forEach(function (id) { noRepeat($(id)); });
    // A click outside the open menu closes it.
    document.body.addEventListener("click", function (ev) {
      if (openMenu !== null && !openMenu.wrap.contains(ev.target)) closeMenu(false);
    });
  }

  startPage();
  Dash.start(function (who) {
    // Nothing is asked of the admin routes before the session says admin.
    if (who.admin !== true) { notFound(); return; }
    me = typeof who.accountId === "string" && USER_ID.test(who.accountId) ? who.accountId : null;
    return read().then(function (r) {
      if (r !== true && r !== false) { $("dash-load").textContent = Dash.failure(r); return; }
      if (r !== true) return;
      // The invites only once the accounts were shown: finding out costs nothing more.
      return readInvites().then(function (v) {
        if (v === false || gotInvites(v)) return;
        $("invites").hidden = false;
        sayIn($("invites-message"), v === null ? Dash.TEXT.failed : Dash.failure(v));
      });
    });
  });
})();
`;
