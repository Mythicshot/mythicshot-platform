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
//
// The Sharing box, its words and its script, with the More menu and the row's "Who can view",
// are made by src/dash/sharing.ts, which the Images and GIFs pages use too; this page's
// document and script are what they were before that module.
//
// The Chapters box (0.1.55, its approved mockup): "Chapters…" in every tour's More, after
// Sharing, reads GET /api/v1/tours/<id>/chapters and opens a box like the Sharing box, one row
// per chapter with Move up, Move down and Remove. Everything is edited in the page only: a
// removed chapter is struck through and moved to the end (its button becomes Put back, which
// puts it back where it was among the others), a moved one says so, the last chapter cannot be
// removed, and a caution box says how many pictures a removal deletes. Save changes sends the
// kept ids in order with the revision they were read at, once, as PUT .../chapters; Cancel,
// Escape and the backdrop send nothing. A stale revision (409 tour_changed) reads the chapters
// again and says nothing was saved; a lost answer reads them again too, and counts as saved
// only when they are now exactly what was sent. However it ends, the list is read again, so a
// published tour shows "Changes waiting". Chapter and tour titles are other people's text:
// textContent only, each in its own bidi-isolated element.
import { shareConstants, shareHelpers, shareHtml, shareListeners, shareMenu, shareQuestion, shareRepeatIds, shareScript, shareState, shareText, shareViewOf, type SharePage } from "./sharing.ts";
import { dashHtml } from "./shell.ts";

/** Who can view a tour: a change moves its pictures. */
const TOUR_SHARING: SharePage = {
  moves: true,
  noun: "tour",
  nouns: "tours",
  idVar: "TOUR_ID",
  api: "/api/v1/tours/",
  title: "String(t.title)",
  words: {
    restrict: "Restrict tour",
    askWarn: "Anyone who already opened this tour may still have its pictures in their browser. Restricting cannot take those back.",
  },
};

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
    <p class="hint" id="tours-hint" hidden>"Changes waiting" means Mythicshot uploaded a newer version that visitors do not see yet. "More" holds: Sharing, Chapters, Publish changes, Unpublish, Delete.</p>
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
${shareHtml(TOUR_SHARING)}
  <div class="backdrop" id="chapters-dialog" hidden>
    <div class="dialog" id="chapters-box" role="dialog" aria-modal="true" aria-labelledby="chapters-title" aria-describedby="chapters-sub">
      <h2 id="chapters-title" tabindex="-1"></h2>
      <p class="sub" id="chapters-sub">Visitors see the chapters in this order.</p>
      <ol class="chapters" id="chapters-list"></ol>
      <p class="warn-box" id="chapters-warn" hidden></p>
      <p class="message" id="chapters-message" role="status" aria-live="polite" hidden></p>
      <div class="two">
        <button type="button" class="btn quiet" id="chapters-cancel">Cancel</button>
        <button type="button" class="btn" id="chapters-save">Save changes</button>
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
    chapters: "Chapters…",
    chaptersBefore: 'Chapters of "',
    chaptersAfter: '"',
    moveUp: "Move up",
    moveDown: "Move down",
    upMark: "↑",
    downMark: "↓",
    removeChapter: "Remove",
    putBack: "Put back",
    movedUp: "moved up",
    movedDown: "moved down",
    uploaded: "uploaded ",
    lastChapter: "A tour needs at least one chapter. Delete the tour instead.",
    removingOneBefore: 'Removing "',
    removingOneAfter: '" deletes its ',
    removingBefore: "Removing ",
    removingMany: " chapters deletes their ",
    onePicture: "1 picture",
    pictures: " pictures",
    forGood: " for good. Visitors keep seeing the tour as it is until you publish.",
    chaptersStale: "This tour changed while the box was open. The chapters were loaded again; nothing was saved.",
${shareText(TOUR_SHARING)}  };
  // A publish, unpublish or delete is driven by at most this many requests.
  var MAX_ROUNDS = 1000;
${shareConstants(TOUR_SHARING)}  // How long Copy link reads Copied.
  var COPIED_MS = 2000;
  // How many characters of the slug the row shows.
  var SLUG_SHOWN = 4;
  var TOUR_ID = /^tour_[0-9a-f]{24}$/;
  var TOUR_PATH = /^\\/t\\/[a-z0-9]{1,64}$/;
  var CHAPTER_ID = /^ch_[0-9a-f]{24}$/;
  // What the page behind the question is, made inert while it is open.
  var BEHIND = ["dash-top", "tours-page"];
  // The question before a delete (Dash.question, src/dash/script.ts).
  var question = Dash.question({ backdrop: "delete-dialog", box: "delete-box", role: "alertdialog", title: "delete-title", message: "delete-message", behind: BEHIND, buttons: ["delete-keep", "delete-go"] });
${shareQuestion(TOUR_SHARING)}  // The Chapters box: its rows are made again on every change, so it gives Tab its own order.
  var chaptersQ = Dash.question({
    backdrop: "chapters-dialog",
    box: "chapters-box",
    role: "dialog",
    title: "chapters-title",
    message: "chapters-message",
    behind: BEHIND,
    buttons: ["chapters-cancel", "chapters-save"],
    lock: "disabled",
    order: chaptersOrder,
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
${shareState(TOUR_SHARING)}  // The Chapters box's subject while it is open: { id, title, revision, all (the chapters as
  // read, in their order), order (the ids kept, in the order shown), removed (the ids marked
  // for removal, in the order marked) }.
  var chap = null;
  // The row buttons of the Chapters box as last made, by chapter id: { up, down, remove }.
  var chapterButtons = {};

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

${shareHelpers(["chaptersQ"])}
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

${shareMenu(TOUR_SHARING)}
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

${shareViewOf(TOUR_SHARING)}
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
    items.push({ text: TEXT.chapters, kind: "chapters" });
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

${shareScript(TOUR_SHARING)}
  // ---- The Chapters box ----

  // The tour's chapters path: only for an id of the API's shape, and escaped.
  function chaptersPath(id) {
    if (typeof id !== "string" || !TOUR_ID.test(id)) throw new TypeError("id");
    return "/api/v1/tours/" + encodeURIComponent(id) + "/chapters";
  }

  function isWhole(n) {
    return typeof n === "number" && isFinite(n) && n >= 0 && Math.floor(n) === n;
  }

  // An answer of GET (or PUT) .../chapters as the page uses it, or null when it is not of the API's shape.
  function chaptersOf(d) {
    if (d === null || typeof d !== "object" || !isWhole(d.revision) || !Array.isArray(d.chapters)) return null;
    var out = [];
    for (var i = 0; i < d.chapters.length; i++) {
      var c = d.chapters[i];
      if (c === null || typeof c !== "object" || typeof c.id !== "string" || !CHAPTER_ID.test(c.id) || typeof c.title !== "string" || !isWhole(c.steps) || !isWhole(c.pictures)) return null;
      if (c.uploaded_at !== null && !isWhole(c.uploaded_at)) return null;
      out.push({ id: c.id, title: c.title, steps: c.steps, pictures: c.pictures, uploaded: c.uploaded_at });
    }
    return { revision: d.revision, chapters: out };
  }

  // Reads the tour's chapters: { status (0 when no answer came), res, list (null unless a usable 200) }.
  function readChapters(id) {
    return Dash.api("GET", chaptersPath(id)).then(function (res) {
      return { status: res.status, res: res, list: res.status === 200 ? chaptersOf(res.data) : null };
    }, function () {
      return { status: 0, res: null, list: null };
    });
  }

  function chapterOf(s, id) {
    for (var i = 0; i < s.all.length; i++) if (s.all[i].id === id) return s.all[i];
    return null;
  }

  function sameIds(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // Whether anything was changed in the box: a chapter marked for removal, or another order.
  function chaptersChanged(s) {
    return s.removed.length > 0 || !sameIds(s.order, s.all.map(function (c) { return c.id; }));
  }

  // Where a kept chapter stood among the kept chapters as they were read: its place before any move.
  function placeBefore(s, id) {
    var kept = s.all.filter(function (c) { return s.order.indexOf(c.id) >= 0; });
    for (var i = 0; i < kept.length; i++) if (kept[i].id === id) return i;
    return -1;
  }

  function stepsText(n) {
    return n === 1 ? TEXT.oneStep : n + TEXT.steps;
  }

  function picturesText(n) {
    return n === 1 ? TEXT.onePicture : n + TEXT.pictures;
  }

  // One row: its number and title (struck through, with no number, when it is marked for
  // removal), its steps and upload date, a note when it moved, and its buttons. at is its
  // place among the kept chapters, -1 for one marked for removal.
  function chapterRow(s, c, at, busy) {
    var gone = at < 0;
    var li = el("li", gone ? "ch gone" : "ch");
    var nameId = "chapters-name-" + c.id;
    var text = el("div", "ch-text");
    var name = el("div", "ch-name");
    name.setAttribute("id", nameId);
    if (gone) name.appendChild(el("s", "name", c.title));
    else fill(name, [(at + 1) + ". ", c.title]);
    text.appendChild(name);
    var d = el("div", "ch-d");
    d.appendChild(el("span", "", stepsText(c.steps) + (c.uploaded !== null ? TEXT.dot + TEXT.uploaded + Dash.dateOf(c.uploaded) : "")));
    if (!gone) {
      var was = placeBefore(s, c.id);
      if (was !== at) d.appendChild(el("span", "tag ch-moved", was > at ? TEXT.movedUp : TEXT.movedDown));
    }
    text.appendChild(d);
    li.appendChild(text);
    var acts = el("div", "ch-acts");
    var made = { up: null, down: null, remove: null };
    function button(cls, label, aria, onClick) {
      var b = el("button", cls, label);
      b.type = "button";
      if (aria !== null) b.setAttribute("aria-label", aria);
      b.setAttribute("aria-describedby", nameId);
      noRepeat(b);
      b.addEventListener("click", onClick);
      acts.appendChild(b);
      return b;
    }
    if (!gone) {
      made.up = button("btn sm quiet ch-move", TEXT.upMark, TEXT.moveUp, function () { moveChapter(c.id, -1); });
      made.up.disabled = busy || at === 0;
      made.down = button("btn sm quiet ch-move", TEXT.downMark, TEXT.moveDown, function () { moveChapter(c.id, 1); });
      made.down.disabled = busy || at === s.order.length - 1;
      made.remove = button("btn sm quiet", TEXT.removeChapter, null, function () { removeChapter(c.id); });
      made.remove.disabled = busy;
      // The last chapter stays: the button is inert but focusable, announced as unavailable, and its title says why.
      if (s.order.length <= 1) {
        made.remove.setAttribute("aria-disabled", "true");
        made.remove.setAttribute("title", TEXT.lastChapter);
      }
    } else {
      made.remove = button("btn sm quiet", TEXT.putBack, null, function () { putBack(c.id); });
      made.remove.disabled = busy;
    }
    li.appendChild(acts);
    chapterButtons[c.id] = made;
    return li;
  }

  // The box as \`chap\` says it is: the rows, the caution and Save changes.
  function renderChapters() {
    var s = chap;
    if (s === null) return;
    var busy = chaptersQ.isWorking();
    var list = $("chapters-list");
    list.textContent = "";
    chapterButtons = {};
    s.order.forEach(function (id, i) { list.appendChild(chapterRow(s, chapterOf(s, id), i, busy)); });
    s.removed.forEach(function (id) { list.appendChild(chapterRow(s, chapterOf(s, id), -1, busy)); });
    // What a removal deletes, while anything is marked for it.
    var warn = $("chapters-warn");
    var n = 0;
    s.removed.forEach(function (id) { n += chapterOf(s, id).pictures; });
    if (s.removed.length === 0) fill(warn, []);
    else if (s.removed.length === 1) fill(warn, [TEXT.removingOneBefore, chapterOf(s, s.removed[0]).title, TEXT.removingOneAfter + picturesText(n) + TEXT.forGood]);
    else fill(warn, [TEXT.removingBefore + s.removed.length + TEXT.removingMany + picturesText(n) + TEXT.forGood]);
    warn.hidden = s.removed.length === 0;
    $("chapters-box").setAttribute("aria-describedby", ["chapters-sub"].concat(s.removed.length === 0 ? [] : ["chapters-warn"]).join(" "));
    $("chapters-cancel").disabled = busy;
    $("chapters-save").disabled = busy || !chaptersChanged(s);
  }

  // The order Tab goes round the box in: every row's buttons that can be used, then Cancel and Save changes.
  function chaptersOrder() {
    var s = chap;
    if (s === null) return [];
    var out = [];
    s.order.concat(s.removed).forEach(function (id) {
      var b = chapterButtons[id];
      if (b === undefined) return;
      [b.up, b.down, b.remove].forEach(function (x) { if (x !== null) out.push(x); });
    });
    return out.concat([$("chapters-cancel"), $("chapters-save")]);
  }

  // The focus after a change in the box: the first of \`kinds\` of that chapter's row that can be used.
  function focusChapter(id, kinds) {
    var b = chapterButtons[id];
    if (b === undefined) return;
    for (var i = 0; i < kinds.length; i++) {
      var x = b[kinds[i]];
      if (x !== null && !x.disabled) { x.focus(); return; }
    }
  }

  function editable() {
    return chap !== null && !chaptersQ.isWorking();
  }

  function moveChapter(id, by) {
    if (!editable()) return;
    var s = chap;
    var at = s.order.indexOf(id);
    var to = at + by;
    if (at < 0 || to < 0 || to >= s.order.length) return;
    s.order[at] = s.order[to];
    s.order[to] = id;
    chaptersQ.say("");
    renderChapters();
    focusChapter(id, by < 0 ? ["up", "down", "remove"] : ["down", "up", "remove"]);
  }

  function removeChapter(id) {
    if (!editable()) return;
    var s = chap;
    var at = s.order.indexOf(id);
    if (at < 0 || s.order.length <= 1) return;
    s.order.splice(at, 1);
    s.removed.push(id);
    chaptersQ.say("");
    renderChapters();
    focusChapter(id, ["remove"]);
  }

  // Put back where it was among the kept chapters, as near as the order now allows.
  function putBack(id) {
    if (!editable()) return;
    var s = chap;
    var at = s.removed.indexOf(id);
    if (at < 0) return;
    s.removed.splice(at, 1);
    var was = 0;
    for (var i = 0; i < s.all.length && s.all[i].id !== id; i++) if (s.order.indexOf(s.all[i].id) >= 0) was++;
    s.order.splice(Math.min(was, s.order.length), 0, id);
    chaptersQ.say("");
    renderChapters();
    focusChapter(id, ["remove"]);
  }

  // Chapters… in a tour's More: its chapters are read first, then the box opens.
  function askChapters(t) {
    if (working || anyOpen() || !TOUR_ID.test(t.id)) return;
    var id = t.id;
    working = true;
    say("");
    rowsDisabled(true);
    readChapters(id).then(function (got) {
      if (got.status === 401) { Dash.signedOut(); return; }
      if (got.list !== null) {
        working = false;
        rowsDisabled(false);
        openChapters(t, got.list);
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

  // The chapters as read, with nothing edited.
  function takeChapters(s, list) {
    s.revision = list.revision;
    s.all = list.chapters;
    s.order = list.chapters.map(function (c) { return c.id; });
    s.removed = [];
  }

  function openChapters(t, list) {
    if (anyOpen()) return;
    var id = t.id;
    chap = { id: id, title: String(t.title), revision: 0, all: [], order: [], removed: [] };
    takeChapters(chap, list);
    fill($("chapters-title"), [TEXT.chaptersBefore, chap.title, TEXT.chaptersAfter]);
    renderChapters();
    // The focus starts on the first row's first button that can be used, else on Cancel.
    var first = chap.order.length > 1 ? chapterButtons[chap.order[0]].down : null;
    if (first !== null) first.setAttribute("id", "chapters-first");
    var opened = chaptersQ.open({
      focus: first !== null ? "chapters-first" : "chapters-cancel",
      // Back to the tour's More, as the list shows it by then.
      back: function () { return moreOf[id]; },
      fallback: "h-page",
      onClose: function () {
        chap = null;
        chapterButtons = {};
        $("chapters-list").textContent = "";
      },
    });
    if (first !== null) first.removeAttribute("id");
    if (!opened) chap = null;
  }

  // Save changes: the kept ids in their order, with the revision they were read at, sent once.
  function saveChapters() {
    var s = chap;
    if (s === null || chaptersQ.isWorking() || !chaptersChanged(s)) return;
    var body = { revision: s.revision, chapters: s.order.slice() };
    working = true;
    chaptersQ.say("");
    chaptersQ.busy(true, "chapters-save", TEXT.saving);
    renderChapters();
    Dash.api("PUT", chaptersPath(s.id), body).then(null, function () { return null; }).then(function (res) {
      if (res !== null && res.status === 401) { Dash.signedOut(); return; }
      if (chap !== s) return;
      if (res !== null && res.status === 200 && chaptersOf(res.data) !== null) return chaptersSaved(s);
      // Changed meanwhile, or a chapter (or the tour) is gone: the chapters read again tell
      // which, and a tour that is gone closes the box.
      if (res !== null && ((res.status === 409 && Dash.errorOf(res) === "tour_changed") || res.status === 404)) return chaptersAgain(s, [TEXT.chaptersStale]);
      // No answer, a failure, or a 200 the page cannot read: what the tour holds now decides.
      if (res === null || res.status >= 500 || res.status === 200) return chaptersLost(s, body);
      chaptersEnd(s, [Dash.failure(res)]);
    });
  }

  // Not saved: the box stays with the person's edits, and says why.
  function chaptersEnd(s, parts) {
    working = false;
    chaptersQ.busy(false, "chapters-save");
    renderChapters();
    sayParts($("chapters-message"), parts);
    $($("chapters-save").disabled ? "chapters-cancel" : "chapters-save").focus();
  }

  // Saved: the box closes and the list is read again, so a published tour shows "Changes waiting".
  function chaptersSaved(s) {
    return reload().then(function (r) {
      if (r === false || chap !== s) return;
      working = false;
      chaptersQ.busy(false, "chapters-save");
      chaptersQ.close(false);
      say(r === true ? "" : TEXT.notReloaded);
      focusTour(s.id);
    });
  }

  // The tour is gone: the box closes, and the list read again shows it.
  function chaptersGone(s) {
    working = false;
    chaptersQ.busy(false, "chapters-save");
    chaptersQ.close(false);
    return reload().then(function (r) {
      if (r === false) return;
      focusTour(s.id);
    });
  }

  // The chapters read again with the edits dropped, and \`parts\` said; the list behind is read again too.
  function chaptersAgain(s, parts) {
    return Promise.all([readChapters(s.id), reload()]).then(function (got) {
      var fresh = got[0];
      if (fresh.status === 401) { Dash.signedOut(); return; }
      if (got[1] === false || chap !== s) return;
      if (fresh.status === 404) return chaptersGone(s);
      if (fresh.list === null) return chaptersEnd(s, [fresh.status === 0 ? Dash.TEXT.failed : Dash.failure(fresh.res)]);
      takeChapters(s, fresh.list);
      working = false;
      chaptersQ.busy(false, "chapters-save");
      renderChapters();
      sayParts($("chapters-message"), parts);
      $("chapters-title").focus();
    });
  }

  // No answer that says what happened: the chapters now exactly what was sent, at a newer
  // revision, mean it was saved; the same revision means nothing was, and the edits stay;
  // anything else is a change by someone else.
  function chaptersLost(s, body) {
    return readChapters(s.id).then(function (fresh) {
      if (fresh.status === 401) { Dash.signedOut(); return; }
      if (chap !== s) return;
      if (fresh.status === 404) return chaptersGone(s);
      if (fresh.list === null) return chaptersEnd(s, [Dash.TEXT.failed]);
      var ids = fresh.list.chapters.map(function (c) { return c.id; });
      if (fresh.list.revision !== s.revision && sameIds(ids, body.chapters)) return chaptersSaved(s);
      if (fresh.list.revision === s.revision) return chaptersEnd(s, [Dash.TEXT.failed]);
      return chaptersAgain(s, [TEXT.chaptersStale]);
    });
  }

  function startPage() {
${shareListeners(TOUR_SHARING)}    $("chapters-cancel").addEventListener("click", function () { if (chap !== null) chaptersQ.dismiss(); });
    $("chapters-save").addEventListener("click", saveChapters);
    [${shareRepeatIds(TOUR_SHARING)}, "chapters-cancel", "chapters-save", "delete-keep", "delete-go"].forEach(function (id) { noRepeat($(id)); });
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
