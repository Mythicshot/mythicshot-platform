// The Tours page of the dashboard, /tours, as in the approved mockups 1, 2 and 11: the
// workspace's tours, newest change first, with Copy link, Open and the More menu
// (Publish changes, Unpublish, Delete), the in-page question before a delete, the empty
// state and the phone layout (each tour a block; src/dash/style.ts). Its body is fixed
// text; its script, /dash/tours.js, fetches the tours through Dash.api and builds every row
// with createElement and textContent, so a title can never become markup.
//
// The public link: GET /api/v1/tours answers a path (/t/<slug>) and GET /api/v1/me names
// the tours address in two-address mode (and nothing in one-address mode, where it is this
// page's own address). The link is that address's origin, written as the server writes it
// (https, or http for localhost and 127.0.0.1, as originOf in src/hosts.ts), and the path.
// It is made only from a path of exactly that shape and a tours address that is a plain
// host name with an optional port; anything else gives the tour no link, no Copy link and
// no Open. The row shows the link without its scheme and with the slug cut after four
// characters, as the mockup does; the whole link is in the text's title and is what Copy
// link copies.
//
// Every change goes through the existing routes: publish (driven until it is live),
// unpublish and delete (each called again while it answers 202), with the session cookie
// and the anti-forgery header Dash.api adds. Unpublish asks nothing; delete asks first.
// While a change runs every row's buttons are disabled. However a change ends, the list
// is read again, so the page shows what is true.
//
// Who can view a tour (the restricted tours set's mockups 1 to 3): the list's "Who can view"
// column shows each published tour's setting from GET /api/v1/tours (`access`, and `viewers`,
// the count on its list), a dash for a tour that is not published (it has nothing to share
// yet, and is offered no Sharing), and on a phone the setting joins the details line. A
// published tour's More starts with "Sharing…", which reads GET /api/v1/tours/<id>/access
// and opens the Sharing box: three real radio buttons, and for "Only people I choose" the
// list as removable chips with a field that adds one or several addresses. The list is
// edited in the page only and sent whole on Save as {access, viewers}, to the tour whose box
// is open (its id is kept when the box opens; a list read again underneath changes nothing
// of it). The addresses are other people's text: they reach the page through textContent,
// each in its own bidi-isolated element, and travel only in a JSON body, never in a path.
// A change between public and restricted asks first, in the same box; its button works only
// after a short pause, so a second click of a double click on Save presses nothing. While
// the API answers 202 the box shows the move's progress and sends the very same body again
// after a short pause; 500 access_failed and a lost answer are sent again too, at most
// MAX_MISSES times in a row, and the whole loop at most MAX_ROUNDS times; a refusal stops
// it at once, and so does leaving the page (pagehide). However it ends, the list is read
// again, and unless the answer was the final 200 so is GET .../access, which decides a lost
// answer and shows what is true. A move that stopped is reported by GET .../access as
// `switching`, with its `target`: for a move to restricted the box offers "Keep it
// restricted" (the setting the tour has now, which finishes it); for a move to public also
// "Make public" (which finishes it), "Keep it restricted" then cancelling it. The server may
// finish a move to restricted, or cancel a stalled move to public, by itself, so the setting
// is read again when the box opens and again before anything is sent: when it is no longer
// what the box shows, nothing is sent and the box shows it as it is now. Only a signed-in
// session may change the setting (src/access.ts); this page has no other credential.
import { dashHtml } from "./shell.ts";

const TOURS_MAIN = `  <div id="tours-page">
  <h1 id="h-page" tabindex="-1">Tours</h1>
  <section id="tours" aria-labelledby="h-page" hidden>
    <p class="sub"><span id="tours-count"></span><span class="wide-only" id="tours-in"></span><span id="tours-used"></span></p>
    <p class="message" id="tours-message" role="status" aria-live="polite" hidden></p>
    <div class="card" id="tours-list" hidden>
      <table class="tours">
        <thead><tr><th scope="col">Tour</th><th scope="col">Status</th><th scope="col">Who can view</th><th scope="col" class="n">Size</th><th scope="col" class="n">Changed</th><th scope="col"><span class="vh">Actions</span></th></tr></thead>
        <tbody id="tours-rows"></tbody>
      </table>
    </div>
    <div class="card" id="tours-empty" hidden>
      <div class="empty">
        <p class="empty-title">No tours yet</p>
        <p>Record a tour in Mythicshot and choose Publish. It shows up here with a link to share.</p>
      </div>
    </div>
    <p class="hint" id="tours-hint" hidden>"Changes waiting" means Mythicshot uploaded a newer version that visitors do not see yet. "More" holds: Sharing, Publish changes, Unpublish, Delete.</p>
    <p class="hint" id="tours-gate" hidden>Opening a restricted tour asks you for your email address too: the dashboard's sign-in does not carry over to the tour's address.</p>
  </section>
  </div>
  <div class="backdrop" id="delete-dialog" hidden>
    <div class="dialog" id="delete-box" role="alertdialog" aria-modal="true" aria-labelledby="delete-title" aria-describedby="delete-text">
      <h2 id="delete-title" tabindex="-1"></h2>
      <p class="sub" id="delete-text">Its link stops working for everyone and its pictures are removed. This cannot be undone. The recording on your computer is not touched.</p>
      <p class="message" id="delete-message" role="status" aria-live="polite" hidden></p>
      <div class="two">
        <button type="button" class="btn quiet" id="delete-keep">Keep it</button>
        <button type="button" class="btn danger" id="delete-go">Delete tour</button>
      </div>
    </div>
  </div>
  <div class="backdrop" id="share-dialog" hidden>
    <div class="dialog" id="share-box" role="dialog" aria-modal="true" aria-labelledby="share-title">
      <h2 id="share-title" tabindex="-1"></h2>
      <div id="share-form">
        <fieldset class="opts">
          <legend class="vh">Who can view</legend>
          <label class="opt" for="share-public"><input type="radio" name="share-access" id="share-public" value="public"><span class="opt-text"><span class="opt-name">Anyone with the link</span><span class="opt-d">No sign-in. Fastest for viewers.</span></span></label>
          <label class="opt" for="share-people"><input type="radio" name="share-access" id="share-people" value="people"><span class="opt-text"><span class="opt-name">Only people I choose</span><span class="opt-d">They prove their email address with a link we send them.</span></span></label>
          <label class="opt" for="share-me"><input type="radio" name="share-access" id="share-me" value="me"><span class="opt-text"><span class="opt-name">Only me</span><span class="opt-d" id="share-me-text"></span></span></label>
        </fieldset>
        <p class="warn-box" id="share-nomail" hidden>This site cannot send mail, so only "Anyone with the link" can be chosen here.</p>
        <p class="warn-box" id="share-nomail-kept" hidden>This site cannot send mail, so once this tour is public it cannot be restricted again here.</p>
        <div id="share-people-part" hidden>
          <label for="share-input" id="share-count"></label>
          <ul class="chips" id="share-chips"></ul>
          <div class="inline">
            <input class="field" id="share-input" type="text" placeholder="name@example.com" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="share-add-message share-hint">
            <button type="button" class="btn quiet" id="share-add">Add</button>
          </div>
          <p class="message" id="share-add-message" role="status" aria-live="polite" hidden></p>
          <p class="hint" id="share-hint">You can always view your own tours. People on the list are not told they were added: send them the link yourself.</p>
        </div>
      </div>
      <div id="share-ask" hidden>
        <p class="sub" id="share-ask-text"></p>
        <p class="warn-box" id="share-ask-warn" hidden>Anyone who already opened this tour may still have its pictures in their browser. Restricting cannot take those back.</p>
      </div>
      <p class="sub" id="share-resume" hidden></p>
      <div id="share-moving" hidden>
        <progress class="progress" id="share-progress" max="1" value="0" aria-hidden="true"></progress>
        <p class="hint" id="share-moving-text"></p>
      </div>
      <p class="message" id="share-message" role="status" aria-live="polite" hidden></p>
      <div class="two" id="share-form-buttons">
        <button type="button" class="btn quiet" id="share-cancel">Cancel</button>
        <button type="button" class="btn" id="share-save">Save</button>
      </div>
      <div class="two" id="share-ask-buttons" hidden>
        <button type="button" class="btn quiet" id="share-keep"></button>
        <button type="button" class="btn" id="share-go"></button>
      </div>
      <div class="two" id="share-resume-buttons" hidden>
        <button type="button" class="btn quiet" id="share-close">Cancel</button>
        <button type="button" class="btn quiet" id="share-restricted">Keep it restricted</button>
        <button type="button" class="btn" id="share-make-public">Make public</button>
      </div>
    </div>
  </div>`;

/** The Tours page: the shell with the page's body and its own script. */
export const TOURS_HTML = dashHtml({ title: "Tours", active: "tours", main: TOURS_MAIN, script: "/dash/tours.js" });

export const TOURS_JS = `(function () {
  "use strict";
  var TEXT = {
    oneTour: "1 tour",
    tours: " tours",
    inWorkspace: " in ",
    dot: " · ",
    used: " used",
    oneStep: "1 step",
    steps: " steps",
    noLink: "no public link",
    published: "Published",
    waiting: "Changes waiting",
    notPublished: "Not published",
    copy: "Copy link",
    copied: "Copied",
    open: "Open",
    more: "More",
    publish: "Publish",
    publishChanges: "Publish changes",
    unpublish: "Unpublish",
    remove: "Delete",
    askBefore: 'Delete "',
    askAfter: '"?',
    publishing: "Publishing…",
    unpublishing: "Unpublishing…",
    deleting: "Deleting…",
    cut: "…",
    emptyTour: "This tour has no steps, so it cannot be published.",
    publishBusy: "This tour is being published. Try again when that is done.",
    notReloaded: "The change was made, but the list could not be loaded again. Reload the page to see it.",
    anyone: "Anyone with the link",
    onePerson: "1 person",
    people: " people",
    nobody: "Nobody yet",
    onlyMe: "Only me",
    noSetting: "—",
    sharing: "Sharing…",
    shareBefore: 'Who can view "',
    meBefore: "You prove your own address, ",
    meAfter: ", the same way.",
    countBefore: "People who can view · ",
    of: " of ",
    removeBefore: "Remove ",
    removeMark: "✕",
    quote: '"',
    notEmailAfter: '" does not look like an email address. Nothing was added.',
    fullBefore: "The list is full at ",
    fullAfter: " people. Remove someone first.",
    wouldBefore: "That would make ",
    wouldMiddle: " people, and the list holds ",
    wouldAfter: ". Nothing was added.",
    saving: "Saving…",
    restrictBefore: 'Restrict "',
    restrictPeople: "From now on only the people you chose can open the link. The link itself stays the same.",
    restrictMe: "From now on only you can open the link. The link itself stays the same.",
    keepPublic: "Keep it public",
    restrictTour: "Restrict tour",
    publicBefore: 'Let anyone with the link view "',
    publicText: "Nobody will be asked to sign in any more. Anyone who has or gets the link can open it. Your list of people is kept in case you restrict it again.",
    keepRestricted: "Keep it restricted",
    makePublic: "Make public",
    movingBefore: "Moving the pictures, ",
    movingAfter: ". Keep this page open.",
    stoppedBefore: "Moving this tour's pictures stopped at ",
    resumeBoth: '. "Keep it restricted" leaves it as it is now; "Make public" finishes making it public.',
    resumeRestrict: '. Choose "Keep it restricted" to finish restricting it.',
    cannotRestrict: "This site cannot send mail, so this tour cannot be restricted. Nothing was changed.",
    switching: "This tour's pictures are still being moved. Open Sharing again to finish that first.",
    cancelled: "The tour was unpublished or deleted while its pictures were being moved, so the change did not finish.",
    busyAgain: "The tour changed while this was being saved. Press Save again.",
    republish: "This tour's pictures could not be moved. Unpublish it, publish it again from Mythicshot, then set who can view it.",
    badViewerAfter: '" is not accepted as an email address. Remove it and press Save again.',
    tooManyBefore: "The list holds at most ",
    tooManyAfter: " people. Remove some and press Save again.",
  };
  // A publish, unpublish or delete is driven by at most this many requests.
  var MAX_ROUNDS = 1000;
  // A change of who can view is sent again after this pause while it answers 202, at most
  // SHARE_ROUNDS times in all; after a lost answer or 500 access_failed after MISS_PAUSES_MS,
  // at most MAX_MISSES times in a row. Then it stops, whatever the answers.
  var PAUSE_MS = 300;
  var MISS_PAUSES_MS = [1000, 3000];
  var MAX_MISSES = 3;
  var SHARE_ROUNDS = 5000;
  // How long the button that confirms a change between public and restricted stays inert (aria-disabled, still focusable) before it works.
  var ARM_MS = 600;
  // The settings, the most addresses a list holds when the API does not say, and how much of a refused entry is shown.
  var SETTINGS = ["public", "people", "me"];
  var LIMIT = 200;
  var ENTRY_SHOWN = 60;
  // How long Copy link reads Copied.
  var COPIED_MS = 2000;
  // How many characters of the slug the row shows.
  var SLUG_SHOWN = 4;
  var TOUR_ID = /^tour_[0-9a-f]{24}$/;
  var TOUR_PATH = /^\\/t\\/[a-z0-9]{1,64}$/;
  // What the page behind the question is, made inert while it is open.
  var BEHIND = ["dash-top", "tours-page"];
  // The question before a delete (Dash.question, src/dash/script.ts).
  var question = Dash.question({ backdrop: "delete-dialog", box: "delete-box", role: "alertdialog", title: "delete-title", message: "delete-message", behind: BEHIND, buttons: ["delete-keep", "delete-go"] });
  // The Sharing box: its controls change while it is open, so it gives Tab its own order and
  // goes back a step from the question before a change between public and restricted.
  var shareQ = Dash.question({
    backdrop: "share-dialog",
    box: "share-box",
    role: "dialog",
    title: "share-title",
    message: "share-message",
    behind: BEHIND,
    fields: ["share-public", "share-people", "share-me", "share-input"],
    buttons: ["share-add", "share-cancel", "share-save", "share-keep", "share-go", "share-close", "share-restricted", "share-make-public"],
    lock: "disabled",
    order: shareOrder,
    beforeDismiss: shareBack,
  });

  var $ = function (id) { return document.getElementById(id); };
  var workspace = "";
  // The tours address's origin, from GET /api/v1/me; null until it is known, or when it cannot be used.
  var base = null;
  // The menu that is open, the question that is asked, and whether a change is running.
  var openMenu = null;
  var asking = null;
  var working = false;
  // Each row's first control and its More, by tour id, to give focus back after the list is rebuilt.
  var firstOf = {};
  var moreOf = {};
  // Every button of every row, menus included, to disable while a change runs.
  var rowButtons = [];
  // The signed-in account's address, for "Only me".
  var myEmail = "";
  // The Sharing box's subject while it is open: { id, title, st (the state GET .../access
  // gave), choice, list (the addresses as edited here), view ("form", "ask", "resume" or
  // "moving"), pending (the body the question before a change is about), from (the view the
  // question came from), armed }.
  var share = null;
  // The page was left (pagehide): a change of who can view stops before its next send, so a
  // page restored from the back/forward cache never carries on by itself.
  var pageLeft = false;

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
    sayIn($("tours-message"), text);
  }

  // A line made of fixed text and other people's text, alternately: each of theirs (at the odd
  // places) in its own bidi-isolated element, so its letters cannot reorder the words around it.
  function fill(line, parts) {
    line.textContent = "";
    for (var i = 0; i < parts.length; i++) line.appendChild(el("span", i % 2 === 1 ? "name" : "", parts[i]));
  }

  // As sayIn, with other people's text in it isolated as fill does.
  function sayParts(line, parts) {
    fill(line, parts);
    line.hidden = parts.join("") === "";
  }

  // A held key's repeats never press a button.
  function noRepeat(b) {
    b.addEventListener("keydown", function (ev) {
      if (ev.repeat === true && (ev.key === "Enter" || ev.key === " ")) ev.preventDefault();
    });
  }

  function anyOpen() {
    return question.isOpen() || shareQ.isOpen();
  }

  function pause(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function busy(btn, on, label) {
    if (on) {
      btn.setAttribute("data-label", btn.textContent);
      btn.textContent = label;
      btn.setAttribute("aria-busy", "true");
    } else {
      btn.textContent = btn.getAttribute("data-label") || btn.textContent;
      btn.removeAttribute("aria-busy");
    }
  }

  function rowsDisabled(on) {
    rowButtons.forEach(function (b) { b.disabled = on; });
  }

  // A name the server writes with http (src/hosts.ts, originOf): this computer's own.
  function localName(host) {
    var name = host.replace(/:[0-9]+$/, "");
    return name === "localhost" || /\\.localhost$/.test(name) || name === "127.0.0.1";
  }

  // The origin public links start with: this page's own in one-address mode, else the
  // tours address's, which must be a plain host name or address with an optional port.
  function baseOf(me) {
    if (me === null || typeof me !== "object") return null;
    var a = me.addresses;
    if (a === undefined) return location.origin;
    if (a === null || typeof a !== "object" || typeof a.tours !== "string") return null;
    var host = a.tours.toLowerCase();
    if (!/^(?:[a-z0-9.-]+|\\[[0-9a-f:.]+\\])(?::[0-9]{1,5})?$/.test(host)) return null;
    return (localName(host) ? "http:" : "https:") + "//" + host;
  }

  function linkOf(t) {
    if (base === null || t.status !== "published" || typeof t.url !== "string" || !TOUR_PATH.test(t.url)) return null;
    return base + t.url;
  }

  // The link as the row shows it: no scheme, and the slug cut after a few characters.
  function shortOf(link) {
    var text = link.replace(/^https?:\\/\\//, "");
    var at = text.lastIndexOf("/t/") + 3;
    return text.length - at > SLUG_SHOWN ? text.slice(0, at + SLUG_SHOWN) + TEXT.cut : text;
  }

  // The sentence for a change that did not happen: a reason retrying cannot fix when there is one.
  function problem(kind, res) {
    var code = Dash.errorOf(res);
    var status = res !== null && typeof res === "object" ? res.status : 0;
    if (kind === "publish" && status === 400 && code === "empty_tour") return TEXT.emptyTour;
    if (kind === "publish" && status === 413) {
      var detail = res.data !== null && typeof res.data === "object" && typeof res.data.detail === "string" ? res.data.detail.trim() : "";
      if (detail !== "") {
        detail = detail.charAt(0).toUpperCase() + detail.slice(1);
        return /[a-z0-9]$/i.test(detail) ? detail + "." : detail;
      }
    }
    if (kind === "delete" && status === 409 && code === "publish_busy") return TEXT.publishBusy;
    return Dash.failure(res);
  }

  // ---- The More menu ----

  function openTheMenu(m, index) {
    closeMenu(false);
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

  function moreMenu(t, i, items, titleId) {
    var wrap = el("div", "more");
    var btn = el("button", "btn sm quiet", TEXT.more);
    btn.type = "button";
    btn.setAttribute("aria-haspopup", "true");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", "menu-" + i);
    btn.setAttribute("aria-describedby", titleId);
    rowButtons.push(btn);
    moreOf[t.id] = btn;
    var menu = el("div", "menu");
    menu.setAttribute("id", "menu-" + i);
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-labelledby", titleId);
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
        if (item.kind === "delete") ask(t);
        else if (item.kind === "share") askShare(t);
        else change(t, item.kind, btn);
      });
      menu.appendChild(entry);
      m.entries.push(entry);
      rowButtons.push(entry);
    });
    btn.addEventListener("click", function () {
      if (openMenu === m) closeMenu(true);
      else openTheMenu(m, 0);
    });
    btn.addEventListener("keydown", function (ev) {
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
    return wrap;
  }

  // ---- Copy link ----

  // Inside the click: the clipboard, and "Copied" for a moment. When the browser refuses,
  // the link is shown in a field, selected, for the person to copy.
  function copyLink(btn, link, showField) {
    var clip = typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function" ? navigator.clipboard : null;
    if (clip === null) { showField(); return; }
    var written;
    try { written = clip.writeText(link); } catch (e) { showField(); return; }
    Promise.resolve(written).then(function () {
      btn.textContent = TEXT.copied;
      setTimeout(function () { btn.textContent = TEXT.copy; }, COPIED_MS);
    }, showField);
  }

  // ---- One row ----

  // Who can view a published tour, as the list says it: { text, tag } (an amber tag for a
  // restricted tour), or null for a tour that is not published, or a setting the page does not know.
  function viewOf(t) {
    if (t.status !== "published") return null;
    if (t.access === "public") return { text: TEXT.anyone, tag: false };
    if (t.access === "me") return { text: TEXT.onlyMe, tag: true };
    if (t.access !== "people" || typeof t.viewers !== "number" || !isFinite(t.viewers) || t.viewers < 0) return null;
    return { text: t.viewers === 0 ? TEXT.nobody : t.viewers === 1 ? TEXT.onePerson : t.viewers + TEXT.people, tag: true };
  }

  function row(t, i) {
    var tr = el("tr");
    var titleId = "tour-" + i;
    var published = t.status === "published";
    var waiting = published && t.unpublished_changes === true;
    var link = linkOf(t);
    var size = typeof t.bytes === "number" ? Dash.formatBytes(t.bytes) : "";
    var when = Dash.dateOf(t.updated_at);
    var steps = t.steps === 1 ? TEXT.oneStep : (typeof t.steps === "number" ? t.steps : 0) + TEXT.steps;
    var view = viewOf(t);

    var what = el("td", "what");
    var name = el("div", "t", String(t.title));
    name.setAttribute("id", titleId);
    what.appendChild(name);
    var d = el("div", "d");
    d.appendChild(el("span", "", steps));
    var shown = el("span", "wide-only", TEXT.dot + (link !== null ? shortOf(link) : TEXT.noLink));
    if (link !== null) shown.setAttribute("title", link);
    d.appendChild(shown);
    // On a phone the setting joins this line.
    d.appendChild(el("span", "narrow-only", TEXT.dot + size + TEXT.dot + when + (view !== null ? TEXT.dot + view.text : "")));
    what.appendChild(d);
    tr.appendChild(what);

    var status = el("td", "status");
    status.appendChild(published ? el("span", "tag ok", TEXT.published) : el("span", "tag", TEXT.notPublished));
    if (waiting) status.appendChild(el("span", "tag warn", TEXT.waiting));
    tr.appendChild(status);
    var who = el("td", "view");
    who.appendChild(view === null ? el("span", "", TEXT.noSetting) : el("span", view.tag ? "tag warn" : "", view.text));
    tr.appendChild(who);
    tr.appendChild(el("td", "n size", size));
    tr.appendChild(el("td", "n when", when));

    var cell = el("td", "acts-cell");
    var acts = el("div", "acts");
    var first = null;
    if (link !== null) {
      var copy = el("button", "btn sm", TEXT.copy);
      copy.type = "button";
      copy.setAttribute("aria-describedby", titleId);
      var field = null;
      copy.addEventListener("click", function () {
        copyLink(copy, link, function () {
          if (field === null) {
            field = el("input", "copy");
            field.type = "text";
            field.setAttribute("readonly", "");
            field.setAttribute("aria-labelledby", titleId);
            field.value = link;
            acts.appendChild(field);
          }
          field.focus();
          field.select();
        });
      });
      acts.appendChild(copy);
      rowButtons.push(copy);
      first = copy;
      var open = el("a", "btn sm quiet", TEXT.open);
      open.setAttribute("href", link);
      open.setAttribute("target", "_blank");
      open.setAttribute("rel", "noopener noreferrer");
      open.setAttribute("aria-describedby", titleId);
      acts.appendChild(open);
    }
    if (!published) {
      var pub = el("button", "btn sm quiet", TEXT.publish);
      pub.type = "button";
      pub.setAttribute("aria-describedby", titleId);
      pub.addEventListener("click", function () { change(t, "publish", pub); });
      acts.appendChild(pub);
      rowButtons.push(pub);
      if (first === null) first = pub;
    }
    var items = [];
    // Only a published tour has something to share.
    if (published) items.push({ text: TEXT.sharing, kind: "share" });
    if (waiting) items.push({ text: TEXT.publishChanges, kind: "publish" });
    if (published) items.push({ text: TEXT.unpublish, kind: "unpublish" });
    items.push({ text: TEXT.remove, kind: "delete", danger: true });
    acts.appendChild(moreMenu(t, i, items, titleId));
    cell.appendChild(acts);
    tr.appendChild(cell);
    firstOf[t.id] = first !== null ? first : moreOf[t.id];
    return tr;
  }

  function show(tours, used) {
    closeMenu(false);
    firstOf = {};
    moreOf = {};
    rowButtons = [];
    var list = tours.filter(function (t) { return t !== null && typeof t === "object" && typeof t.id === "string" && TOUR_ID.test(t.id); });
    var n = list.length;
    $("tours-count").textContent = n === 1 ? TEXT.oneTour : n + TEXT.tours;
    $("tours-in").textContent = workspace !== "" ? TEXT.inWorkspace + workspace : "";
    $("tours-used").textContent = TEXT.dot + Dash.formatBytes(used) + TEXT.used;
    var rows = $("tours-rows");
    rows.textContent = "";
    for (var i = 0; i < n; i++) rows.appendChild(row(list[i], i));
    $("tours-list").hidden = n === 0;
    $("tours-hint").hidden = n === 0;
    // The line about opening a restricted tour, when the list has one to open.
    $("tours-gate").hidden = !list.some(function (t) { return t.status === "published" && (t.access === "people" || t.access === "me"); });
    $("tours-empty").hidden = n !== 0;
    $("tours").hidden = false;
  }

  // The list, the usage and (once) the tours address. Resolves to true when shown, false
  // when the visitor was sent to sign in, or the answer that failed.
  function load() {
    var asks = [Dash.api("GET", "/api/v1/tours"), Dash.api("GET", "/api/v1/usage"), base === null ? Dash.api("GET", "/api/v1/me") : null];
    return Promise.all(asks).then(function (got) {
      for (var i = 0; i < got.length; i++) {
        if (got[i] !== null && got[i].status === 401) { Dash.signedOut(); return false; }
      }
      var list = got[0];
      var usage = got[1];
      var me = got[2];
      if (me !== null) {
        if (me.status !== 200) return me;
        base = baseOf(me.data);
      }
      if (list.status !== 200 || list.data === null || typeof list.data !== "object" || !Array.isArray(list.data.tours)) return list;
      if (usage.status !== 200 || usage.data === null || typeof usage.data !== "object" || typeof usage.data.used_bytes !== "number") return usage;
      show(list.data.tours, usage.data.used_bytes);
      return true;
    });
  }

  // The list again after a change: as load, with null when no answer came.
  function reload() {
    return load().then(null, function () { return null; });
  }

  // ---- Changes ----

  // Calls a change's route until it is no longer in progress; the last answer.
  function run(id, kind) {
    var path = "/api/v1/tours/" + encodeURIComponent(id) + (kind === "delete" ? "" : "/" + kind);
    var method = kind === "delete" ? "DELETE" : "POST";
    var rounds = 0;
    function next(body) {
      rounds++;
      return Dash.api(method, path, body).then(function (res) {
        if (res.status !== 202 || rounds >= MAX_ROUNDS) return res;
        if (kind !== "publish") return next(undefined);
        var id = res.data !== null && typeof res.data === "object" ? res.data.publish_id : null;
        return typeof id === "string" ? next({ publish_id: id }) : res;
      });
    }
    return next(undefined);
  }

  // Whether the change is done: published, unpublished, or deleted (or already gone). An
  // unpublish or delete whose leftover files could not all be removed yet is done too: the
  // tour is unpublished or gone, and later requests finish the cleaning.
  function done(kind, res) {
    if (res === null) return false;
    var leftovers = res.status === 500 && Dash.errorOf(res) === "cleanup_pending";
    if (kind === "publish") return res.status === 200;
    if (kind === "unpublish") return res.status === 204 || leftovers;
    return res.status === 200 || res.status === 404 || leftovers;
  }

  // Runs a change, then reads the list again however it ended (null: no answer came).
  // steps.before(ok) runs before the list is read; steps.after(ok, res, shown) after it,
  // with shown false when the list could not be read and stays as last known.
  function changeThen(id, kind, steps) {
    function settle(res) {
      if (res !== null && res.status === 401) { Dash.signedOut(); return; }
      var ok = done(kind, res);
      if (steps.before) steps.before(ok);
      return reload().then(function (r) {
        if (r !== false) steps.after(ok, res, r === true);
      });
    }
    return run(id, kind).then(settle, function () { return settle(null); });
  }

  function change(t, kind, btn) {
    if (working || btn.disabled) return;
    working = true;
    say("");
    rowsDisabled(true);
    busy(btn, true, kind === "publish" ? TEXT.publishing : TEXT.unpublishing);
    changeThen(t.id, kind, {
      after: function (ok, res, shown) {
        working = false;
        if (!shown) {
          // The list is as last known: its buttons come back, and the page says what happened.
          busy(btn, false);
          rowsDisabled(false);
          say(ok ? TEXT.notReloaded : problem(kind, res));
          btn.focus();
          return;
        }
        say(ok ? "" : problem(kind, res));
        var first = firstOf[t.id];
        if (first !== undefined) first.focus();
        else $("h-page").focus();
      },
    });
  }

  // ---- The question before a delete ----

  function ask(t) {
    if (working || anyOpen()) return;
    var opened = question.open({
      title: TEXT.askBefore + String(t.title) + TEXT.askAfter,
      focus: "delete-keep",
      // The focus goes back to the More it came from, as the list shows it by then.
      back: function () { return moreOf[t.id]; },
      fallback: "h-page",
      onClose: function () { asking = null; },
    });
    if (opened) asking = { t: t };
  }

  // ---- Who can view: the Sharing box ----

  // The tour's access path: only for an id of the API's shape, and escaped.
  function accessPath(id) {
    if (typeof id !== "string" || !TOUR_ID.test(id)) throw new TypeError("id");
    return "/api/v1/tours/" + encodeURIComponent(id) + "/access";
  }

  function isCount(n) {
    return typeof n === "number" && isFinite(n) && n >= 0;
  }

  // An answer of GET .../access (or a final PUT) as the page uses it, or null when it is not of the API's shape.
  function stateOf(d) {
    if (d === null || typeof d !== "object" || SETTINGS.indexOf(d.access) < 0 || !Array.isArray(d.viewers) || typeof d.can_restrict !== "boolean") return null;
    for (var i = 0; i < d.viewers.length; i++) if (typeof d.viewers[i] !== "string") return null;
    var sw = d.switching;
    if (sw !== null && (sw === undefined || typeof sw !== "object" || !isCount(sw.done) || !isCount(sw.total) || (sw.target !== "public" && sw.target !== "restricted"))) return null;
    return { access: d.access, viewers: d.viewers.slice(), limit: typeof d.limit === "number" && d.limit > 0 ? d.limit : LIMIT, canRestrict: d.can_restrict, switching: sw === null ? null : { done: sw.done, total: sw.total, target: sw.target } };
  }

  // Reads who can view the tour: { status (0 when no answer came), res, state (null unless a usable 200) }.
  function readAccess(id) {
    return Dash.api("GET", accessPath(id)).then(function (res) {
      return { status: res.status, res: res, state: res.status === 200 ? stateOf(res.data) : null };
    }, function () {
      return { status: 0, res: null, state: null };
    });
  }

  // Making a public tour restricted needs a site that can mail; a restricted one may always move between the two restricted settings.
  function mayRestrict(st) {
    return st.canRestrict || st.access !== "public";
  }

  function crosses(from, to) {
    return (from === "public") !== (to === "public");
  }

  function sameList(a, b) {
    if (a.length !== b.length) return false;
    var x = a.slice().sort();
    var y = b.slice().sort();
    for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }

  // An entry as a sentence shows it: at most ENTRY_SHOWN characters.
  function cut(text) {
    var chars = Array.from(String(text));
    return chars.length > ENTRY_SHOWN ? chars.slice(0, ENTRY_SHOWN).join("") + TEXT.cut : String(text);
  }

  // Shaped like an address (the server's check is stricter, and has the last word): visible
  // characters, one @ with something before it, and a host name of two or more labels whose
  // last is not all digits.
  function shaped(e) {
    if (e.length < 3 || e.length > 254 || !/^[\\x21-\\x7e]+$/.test(e)) return false;
    var at = e.indexOf("@");
    if (at < 1 || at !== e.lastIndexOf("@")) return false;
    var labels = e.slice(at + 1).split(".");
    if (labels.length < 2) return false;
    for (var i = 0; i < labels.length; i++) if (labels[i] === "") return false;
    return !/^[0-9]+$/.test(labels[labels.length - 1]);
  }

  function focusTour(id) {
    var b = moreOf[id];
    if (b !== undefined) b.focus();
    else $("h-page").focus();
  }

  // The remove buttons of the chips, in order, for Tab and for the focus after a removal.
  var chipButtons = [];

  // The box as \`share\` says it is: its view, the options, the list and the buttons.
  function renderShare() {
    var s = share;
    if (s === null) return;
    var st = s.st;
    var busy = shareQ.isWorking();
    var form = s.view === "form";
    $("share-form").hidden = !form;
    $("share-ask").hidden = s.view !== "ask";
    $("share-resume").hidden = s.view !== "resume";
    $("share-moving").hidden = s.view !== "moving";
    $("share-form-buttons").hidden = !form;
    $("share-ask-buttons").hidden = s.view !== "ask";
    $("share-resume-buttons").hidden = s.view !== "resume";
    var described = s.view === "ask" ? ($("share-ask-warn").hidden ? "share-ask-text" : "share-ask-text share-ask-warn") : s.view === "resume" ? "share-resume" : s.view === "moving" ? "share-moving-text" : "";
    if (described !== "") $("share-box").setAttribute("aria-describedby", described);
    else $("share-box").removeAttribute("aria-describedby");
    SETTINGS.forEach(function (a) {
      var radio = $("share-" + a);
      radio.checked = s.choice === a;
      radio.disabled = busy || (a !== "public" && !mayRestrict(st));
    });
    $("share-nomail").hidden = st.canRestrict || st.access !== "public";
    $("share-nomail-kept").hidden = st.canRestrict || st.access === "public";
    var people = s.choice === "people";
    $("share-people-part").hidden = !people;
    $("share-count").textContent = TEXT.countBefore + s.list.length + TEXT.of + st.limit;
    var chips = $("share-chips");
    chips.textContent = "";
    chipButtons = [];
    s.list.forEach(function (address) {
      var chip = el("li", "chip");
      chip.appendChild(el("span", "name", address));
      var x = el("button", "", TEXT.removeMark);
      x.type = "button";
      x.setAttribute("aria-label", TEXT.removeBefore + address);
      x.disabled = busy;
      noRepeat(x);
      x.addEventListener("click", function () { removeAddress(address); });
      chip.appendChild(x);
      chips.appendChild(chip);
      chipButtons.push(x);
    });
    $("share-input").disabled = busy || !people;
    $("share-add").disabled = busy || !people;
    ["share-cancel", "share-save", "share-keep", "share-close", "share-restricted", "share-make-public"].forEach(function (id) { $(id).disabled = busy; });
    // Until it is armed the button is inert but stays focusable and in the Tab order, so a
    // keyboard or screen reader user meets it, announced as unavailable, rather than finding
    // it missing; a press then does nothing (confirmAsk).
    $("share-go").disabled = busy;
    if (s.armed) $("share-go").removeAttribute("aria-disabled");
    else $("share-go").setAttribute("aria-disabled", "true");
    var sw = st.switching;
    $("share-make-public").hidden = sw === null || sw.target !== "public";
    $("share-resume").textContent = sw === null ? "" : TEXT.stoppedBefore + Math.min(sw.done, sw.total) + TEXT.of + sw.total + (sw.target === "public" ? TEXT.resumeBoth : TEXT.resumeRestrict);
  }

  // The order Tab goes round the box in, as a browser would: the checked option alone of the
  // three, then the chips, the field and Add while the list shows, then the view's buttons.
  function shareOrder() {
    var s = share;
    if (s === null) return [];
    if (s.view === "ask") return [$("share-keep"), $("share-go")];
    if (s.view === "resume") return [$("share-close"), $("share-restricted"), $("share-make-public")].filter(function (b) { return !b.hidden; });
    if (s.view !== "form") return [];
    var radios = SETTINGS.map(function (a) { return $("share-" + a); }).filter(function (r) { return !r.disabled; });
    var checked = radios.filter(function (r) { return r.checked; });
    var list = radios.length === 0 ? [] : [checked.length > 0 ? checked[0] : radios[0]];
    if (s.choice === "people") list = list.concat(chipButtons, [$("share-input"), $("share-add")]);
    return list.concat([$("share-cancel"), $("share-save")]);
  }

  function titleShare() {
    fill($("share-title"), [TEXT.shareBefore, share.title, TEXT.askAfter]);
  }

  // The field's own message line (a refused entry, a full list); addSays([]) hides it.
  function addSays(parts) {
    sayParts($("share-add-message"), parts);
    if (parts.length > 0) $("share-input").setAttribute("aria-invalid", "true");
    else $("share-input").removeAttribute("aria-invalid");
  }

  // Sharing… in a published tour's More: who can view it is read first, then the box opens.
  function askShare(t) {
    if (working || anyOpen() || !TOUR_ID.test(t.id)) return;
    var id = t.id;
    working = true;
    say("");
    rowsDisabled(true);
    readAccess(id).then(function (got) {
      if (got.status === 401) { Dash.signedOut(); return; }
      if (got.state !== null) {
        working = false;
        rowsDisabled(false);
        openShare(t, got.state);
        return;
      }
      // Gone, or not readable: the list read again shows what is true.
      return reload().then(function (r) {
        working = false;
        if (r === false) return;
        if (r !== true) rowsDisabled(false);
        var gone = got.status === 404 && r === true && moreOf[id] === undefined;
        if (!gone) say(got.status === 0 ? Dash.TEXT.failed : Dash.failure(got.res));
        focusTour(id);
      });
    });
  }

  function openShare(t, st) {
    if (anyOpen()) return;
    var id = t.id;
    share = { id: id, title: String(t.title), st: st, choice: st.access, list: st.viewers.slice(), view: st.switching !== null ? "resume" : "form", pending: null, from: "form", armed: false };
    $("share-input").value = "";
    addSays([]);
    titleShare();
    fill($("share-me-text"), [TEXT.meBefore, myEmail, TEXT.meAfter]);
    renderShare();
    var opened = shareQ.open({
      focus: share.view === "resume" ? "share-restricted" : "share-" + share.choice,
      // Back to the tour's More, as the list shows it by then.
      back: function () { return moreOf[id]; },
      fallback: "h-page",
      onClose: function () {
        share = null;
        $("share-input").value = "";
      },
    });
    if (!opened) share = null;
  }

  // An option chosen (with the mouse, or the arrow keys as a browser moves between them).
  function choose(a) {
    var s = share;
    if (s === null) return;
    if (s.view === "form" && !shareQ.isWorking() && $("share-" + a).checked && (a === "public" || mayRestrict(s.st))) {
      s.choice = a;
      addSays([]);
    }
    renderShare();
  }

  // Add: one or several addresses, separated by commas, spaces, semicolons or line ends;
  // trimmed, lower-cased, without duplicates. Any entry not shaped like an address refuses
  // the whole of it, and so does a list that would grow past the limit. True when nothing
  // was refused (an empty field adds nothing and refuses nothing).
  function addEntries() {
    var s = share;
    if (s === null || shareQ.isWorking() || s.view !== "form" || s.choice !== "people") return false;
    var input = $("share-input");
    var entries = input.value.split(/[\\s,;]+/).filter(function (e) { return e !== ""; });
    var fresh = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i].toLowerCase();
      if (!shaped(e)) {
        addSays([TEXT.quote, cut(entries[i]), TEXT.notEmailAfter]);
        input.focus();
        return false;
      }
      if (s.list.indexOf(e) < 0 && fresh.indexOf(e) < 0) fresh.push(e);
    }
    var limit = s.st.limit;
    if (fresh.length > 0 && s.list.length >= limit) {
      addSays([TEXT.fullBefore + limit + TEXT.fullAfter]);
      input.focus();
      return false;
    }
    if (s.list.length + fresh.length > limit) {
      addSays([TEXT.wouldBefore + (s.list.length + fresh.length) + TEXT.wouldMiddle + limit + TEXT.wouldAfter]);
      input.focus();
      return false;
    }
    s.list = s.list.concat(fresh);
    input.value = "";
    addSays([]);
    renderShare();
    input.focus();
    return true;
  }

  function removeAddress(address) {
    var s = share;
    if (s === null || shareQ.isWorking() || s.view !== "form") return;
    var at = s.list.indexOf(address);
    if (at < 0) return;
    s.list = s.list.slice(0, at).concat(s.list.slice(at + 1));
    addSays([]);
    renderShare();
    if (chipButtons.length > 0) chipButtons[Math.min(at, chipButtons.length - 1)].focus();
    else $("share-input").focus();
  }

  // Save: the chosen setting and the whole list as edited. A change between public and
  // restricted asks first.
  function save() {
    var s = share;
    if (s === null || shareQ.isWorking() || s.view !== "form") return;
    if (s.choice !== "public" && !mayRestrict(s.st)) return;
    // An address typed and not added yet is added first; when it cannot be, nothing is sent.
    if (s.choice === "people" && $("share-input").value.trim() !== "" && !addEntries()) return;
    var body = { access: s.choice, viewers: s.list.slice() };
    if (crosses(s.st.access, body.access)) askFirst(body, "form");
    else sendShare(body, "share-save");
  }

  // The question before a change between public and restricted, in the same box. The focus
  // goes to the button that keeps the tour as it is; the one that changes it works only after
  // ARM_MS, so the second click of a double click on Save, which lands where it is, does nothing.
  function askFirst(body, from) {
    var s = share;
    var toPublic = body.access === "public";
    s.view = "ask";
    s.pending = body;
    s.from = from;
    s.armed = false;
    fill($("share-title"), [toPublic ? TEXT.publicBefore : TEXT.restrictBefore, s.title, TEXT.askAfter]);
    $("share-ask-text").textContent = toPublic ? TEXT.publicText : body.access === "me" ? TEXT.restrictMe : TEXT.restrictPeople;
    $("share-ask-warn").hidden = toPublic;
    $("share-keep").textContent = toPublic ? TEXT.keepRestricted : TEXT.keepPublic;
    $("share-go").textContent = toPublic ? TEXT.makePublic : TEXT.restrictTour;
    shareQ.say("");
    renderShare();
    $("share-keep").focus();
    pause(ARM_MS).then(function () {
      if (share !== s || s.view !== "ask" || s.pending !== body) return;
      s.armed = true;
      renderShare();
    });
  }

  // Keep it public / Keep it restricted, Escape and the backdrop while asking: back to where
  // the question came from, with nothing sent and the edits kept.
  function backFromAsk() {
    var s = share;
    if (s === null || s.view !== "ask" || shareQ.isWorking()) return;
    s.view = s.from;
    s.pending = null;
    s.armed = false;
    titleShare();
    renderShare();
    $(s.view === "resume" ? "share-restricted" : "share-save").focus();
  }

  function shareBack() {
    if (share === null || share.view !== "ask") return true;
    backFromAsk();
    return false;
  }

  function confirmAsk() {
    var s = share;
    if (s === null || s.view !== "ask" || !s.armed || s.pending === null || shareQ.isWorking()) return;
    sendShare(s.pending, "share-go");
  }

  // A move that stopped: "Keep it restricted" sends the setting the tour has now (which
  // finishes a move to restricted and cancels a move to public), "Make public" asks first and
  // then sends public (which finishes a move to public). Either with the list as it is.
  function keepRestricted() {
    var s = share;
    if (s === null || s.view !== "resume" || shareQ.isWorking()) return;
    sendShare({ access: s.st.access, viewers: s.st.viewers.slice() }, "share-restricted");
  }

  function makePublicAgain() {
    var s = share;
    if (s === null || s.view !== "resume" || shareQ.isWorking() || s.st.switching === null || s.st.switching.target !== "public") return;
    askFirst({ access: "public", viewers: s.st.viewers.slice() }, "resume");
  }

  // The move's progress, from a 202.
  function showMoving(s, d) {
    var total = d !== null && typeof d === "object" && isCount(d.total) ? d.total : 0;
    var done = d !== null && typeof d === "object" && isCount(d.done) ? Math.min(d.done, total) : 0;
    if (s.view !== "moving") {
      s.view = "moving";
      titleShare();
      renderShare();
      $("share-title").focus();
    }
    var bar = $("share-progress");
    bar.max = total > 0 ? total : 1;
    bar.value = total > 0 ? done : 0;
    $("share-moving-text").textContent = TEXT.movingBefore + done + TEXT.of + total + TEXT.movingAfter;
  }

  // Sends the body to the tour whose box is open, again while it answers 202, and decides.
  function sendShare(body, button) {
    var s = share;
    var path = accessPath(s.id);
    var fromResume = s.view === "resume" || (s.view === "ask" && s.from === "resume");
    var rounds = 0;
    var misses = 0;
    working = true;
    // Pressed by the person: a stop from leaving the page earlier is over.
    pageLeft = false;
    shareQ.say("");
    shareQ.busy(true, button, TEXT.saving);
    renderShare();
    // The setting read again first: the server may have finished or cancelled a move, or the
    // tour may have been changed elsewhere, since the box showed it.
    readAccess(s.id).then(function (got) {
      if (got.status === 401) { Dash.signedOut(); return; }
      if (share !== s) return;
      if (got.state !== null && sameState(got.state, s.st)) {
        s.st = got.state;
        return next();
      }
      working = false;
      shareQ.busy(false, button);
      if (got.status === 404) return gone(s, "");
      if (got.state === null) {
        renderShare();
        sayParts($("share-message"), [got.status === 0 ? Dash.TEXT.failed : Dash.failure(got.res)]);
        $(s.view === "resume" ? "share-restricted" : s.view === "ask" ? "share-keep" : "share-save").focus();
        return;
      }
      // Changed: nothing is sent. A move that ended by itself just shows the tour as it is now.
      showState(s, got.state, fromResume, fromResume && got.state.switching === null ? [] : [TEXT.busyAgain]);
    });
    function next() {
      if (share !== s) return;
      // The page was left (and may come back from the back/forward cache): nothing more is sent by itself.
      if (pageLeft) return finishShare(s, body, button, fromResume, { kind: "stopped" });
      rounds++;
      return Dash.api("PUT", path, body).then(step, function () { return step(null); });
    }
    function step(res) {
      if (res !== null && res.status === 401) { Dash.signedOut(); return; }
      if (share !== s) return;
      if (res !== null && res.status === 202) {
        misses = 0;
        showMoving(s, res.data);
        return rounds < SHARE_ROUNDS ? pause(PAUSE_MS).then(next) : finishShare(s, body, button, fromResume, { kind: "stopped" });
      }
      if (res !== null && res.status === 200) {
        var st = stateOf(res.data);
        // A 200 the page cannot read is decided by reading the setting again.
        return finishShare(s, body, button, fromResume, st !== null ? { kind: "done", state: st } : { kind: "lost", res: res });
      }
      if (res === null || (res.status === 500 && Dash.errorOf(res) === "access_failed")) {
        misses++;
        if (misses < MAX_MISSES && rounds < SHARE_ROUNDS) return pause(MISS_PAUSES_MS[misses - 1]).then(next);
        return finishShare(s, body, button, fromResume, { kind: "lost", res: res });
      }
      return finishShare(s, body, button, fromResume, { kind: "refused", res: res });
    }
  }

  // Whether the setting read now is still what the box shows: the same setting, the same site
  // mail, and the same move (or none), whatever its progress.
  function sameState(a, b) {
    if (a.access !== b.access || a.canRestrict !== b.canRestrict || (a.switching === null) !== (b.switching === null)) return false;
    return a.switching === null || a.switching.target === b.switching.target;
  }

  // The tour is gone: the box closes, and the list read again shows it.
  function gone(s, text) {
    shareQ.close(false);
    return reload().then(function (r) {
      if (r === false) return;
      say(text);
      focusTour(s.id);
    });
  }

  // The box shows the tour as \`st\` says it is now: a move that stopped, or the options (with
  // the person's edits kept, unless they came from a stopped move), and the sentence in \`parts\`.
  function showState(s, st, fromResume, parts) {
    s.st = st;
    if (st.switching !== null) s.view = "resume";
    else {
      if (fromResume) {
        s.choice = st.access;
        s.list = st.viewers.slice();
      }
      if (s.choice !== "public" && !mayRestrict(st)) s.choice = st.access;
      s.view = "form";
    }
    s.pending = null;
    s.armed = false;
    titleShare();
    renderShare();
    sayParts($("share-message"), parts);
    $(s.view === "resume" ? "share-restricted" : "share-save").focus();
  }

  // The sentence for a change of who can view that did not happen, as parts for sayParts.
  function refusalParts(res, body, fromResume) {
    var code = Dash.errorOf(res);
    var status = res !== null && typeof res === "object" ? res.status : 0;
    if (status === 409) {
      if (code === "cannot_restrict") return [TEXT.cannotRestrict];
      if (code === "access_switching") return [TEXT.switching];
      if (code === "switch_cancelled") return [TEXT.cancelled];
      if (code === "access_busy") return [TEXT.busyAgain];
      if (code === "republish_needed") return [TEXT.republish];
    }
    if (status === 400 && code === "bad_viewer") {
      // The server names a position only; the entry is the page's own, from the body it sent.
      var detail = res.data !== null && typeof res.data === "object" && typeof res.data.detail === "string" ? res.data.detail : "";
      var m = /^viewers\\[([0-9]{1,4})\\]/.exec(detail);
      var i = m === null ? -1 : Number(m[1]);
      if (i >= 0 && i < body.viewers.length) return [TEXT.quote, cut(body.viewers[i]), TEXT.badViewerAfter];
    }
    if (status === 400 && code === "too_many_viewers") return [TEXT.tooManyBefore + (share !== null ? share.st.limit : LIMIT) + TEXT.tooManyAfter];
    return [Dash.failure(res)];
  }

  // However a change ends, the list is read again, and so is the setting unless the answer
  // was the final 200: the change is done when the setting now is the one sent, with the list
  // sent and no move left. Otherwise the box stays, says why, and shows the tour as it is now.
  function finishShare(s, body, button, fromResume, o) {
    var reread = o.kind === "done" ? Promise.resolve(null) : readAccess(s.id);
    return Promise.all([reload(), reread]).then(function (got) {
      var listed = got[0];
      var fresh = got[1];
      if (listed === false) return;
      if (fresh !== null && fresh.status === 401) { Dash.signedOut(); return; }
      if (share !== s) return;
      working = false;
      shareQ.busy(false, button);
      var now = o.kind === "done" ? o.state : fresh.state;
      var done = o.kind === "done" || (now !== null && now.switching === null && now.access === body.access && sameList(now.viewers, body.viewers));
      if (done) {
        shareQ.close(false);
        say(listed === true ? "" : TEXT.notReloaded);
        focusTour(s.id);
        return;
      }
      if (fresh !== null && fresh.status === 404) {
        // The tour is gone: the list read again shows it.
        shareQ.close(false);
        say(o.kind === "refused" && o.res.status === 409 ? refusalParts(o.res, body, fromResume).join("") : "");
        focusTour(s.id);
        return;
      }
      var parts = o.kind === "refused" ? refusalParts(o.res, body, fromResume) : o.kind === "lost" && o.res !== null ? [Dash.failure(o.res)] : [Dash.TEXT.failed];
      showState(s, now !== null ? now : s.st, fromResume, parts);
    });
  }

  function startPage() {
    // The page's own window: leaving the page stops a change of who can view that is running.
    addEventListener("pagehide", function () { pageLeft = true; });
    $("share-cancel").addEventListener("click", function () { if (share !== null && share.view === "form") shareQ.dismiss(); });
    $("share-close").addEventListener("click", function () { if (share !== null && share.view === "resume") shareQ.dismiss(); });
    $("share-save").addEventListener("click", save);
    $("share-keep").addEventListener("click", backFromAsk);
    $("share-go").addEventListener("click", confirmAsk);
    $("share-restricted").addEventListener("click", keepRestricted);
    $("share-make-public").addEventListener("click", makePublicAgain);
    $("share-add").addEventListener("click", function () { addEntries(); });
    // Enter in the field is Add, never Save; a held Enter's repeats do nothing.
    $("share-input").addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      if (ev.repeat === true) return;
      addEntries();
    });
    $("share-input").addEventListener("input", function () { addSays([]); });
    SETTINGS.forEach(function (a) {
      $("share-" + a).addEventListener("change", function () { choose(a); });
    });
    ["share-cancel", "share-save", "share-keep", "share-go", "share-close", "share-restricted", "share-make-public", "share-add", "delete-keep", "delete-go"].forEach(function (id) { noRepeat($(id)); });
    $("delete-keep").addEventListener("click", function () { question.dismiss(); });
    $("delete-go").addEventListener("click", function () {
      if (asking === null || working) return;
      var t = asking.t;
      working = true;
      question.busy(true, "delete-go", TEXT.deleting);
      question.say("");
      rowsDisabled(true);
      changeThen(t.id, "delete", {
        before: function (ok) {
          if (ok) question.close(false);
        },
        after: function (ok, res, shown) {
          working = false;
          question.busy(false, "delete-go");
          if (!shown) rowsDisabled(false);
          if (ok) {
            say(shown ? "" : TEXT.notReloaded);
            $("h-page").focus();
            return;
          }
          question.say(problem("delete", res));
          $("delete-go").focus();
        },
      });
    });
    // A click outside the open menu closes it.
    document.body.addEventListener("click", function (ev) {
      if (openMenu !== null && !openMenu.wrap.contains(ev.target)) closeMenu(false);
    });
  }

  startPage();
  Dash.start(function (who) {
    workspace = who.workspace;
    myEmail = who.email;
    return load().then(function (r) {
      if (r !== true && r !== false) $("dash-load").textContent = Dash.failure(r);
    });
  });
})();
`;
