// The Storage page of the dashboard, /storage, as in the approved mockups 5 and 6: the
// workspace's name, the allowance bar with the line "<used> of <allowance> used · N images ·
// N GIFs · N tours" (no bar, only the total, when no allowance is set; a count of images or
// GIFs is left out while it is 0, as mockup 6 shows a workspace with tours only), the
// over-allowance warning, what takes the room (the pictures in tours, GIFs, images, logos,
// uploads in progress, as GET /api/v1/usage counts them), and the largest things of every
// kind (the `largest` list of GET /api/v1/usage/largest), each marked Tour, Image or GIF,
// with a small bar and a Delete button. The Images and GIFs pages are not part of this page.
// Its body is fixed text; its script, /dash/storage.js, fills it through textContent, so a
// title can never become markup.
//
// The bars are sized through the CSSOM (element.style.width), which the content security
// policy allows, as the Admin page sizes its bars; no style attribute is ever written.
//
// Delete asks a question through the dashboard's one question helper (Dash.question,
// src/dash/script.ts): for a tour the Tours page's question with its sentences, for an image
// or a GIF the same question in the item's words. While it is open the bar and the page are
// inert and hidden from screen readers, Escape and Tab are handled for the whole document, a
// click on the backdrop is Keep it, and its buttons are disabled while the request runs.
// Every row's Delete is disabled while a delete runs and while the numbers are read again
// after it, as on the Tours page.
// - A tour is deleted as the Tours page deletes it: DELETE /api/v1/tours/:id again while it
//   answers 202. It is done when the tour is gone: 200, 404 (already gone), or 500
//   cleanup_pending (gone, with files left for later requests to remove).
// - An image or a GIF: DELETE /api/v1/media/:id, sent again after a pause (PAUSES_MS, at
//   most ITEM_ROUNDS times in all) while it answers 500 cleanup_pending, as the API asks and
//   as the Images and GIFs pages do. It is done on 204, 404 (already gone), or a last
//   cleanup_pending: the item is closing by then, so it is no longer listed (it counts in the
//   usage until its files are gone), and a later request or the sweep removes what is left.
//   When no answer came, the largest list read again decides: the item is gone when it is no
//   longer listed although it would still fit in the list; otherwise it is a failure.
// After any outcome the page reads the usage and the largest list again; when that fails
// after a delete that worked, the page says the change was made and asks for a reload.
// Message lines are hidden while they have nothing to say.
import { dashHtml } from "./shell.ts";

const STORAGE_MAIN = `  <div id="storage-page">
  <h1 id="h-page" tabindex="-1">Storage</h1>
  <section id="storage" aria-labelledby="h-page" hidden>
    <p class="sub" id="storage-workspace"></p>
    <p class="message" id="storage-message" role="status" aria-live="polite" hidden></p>
    <div class="card">
      <div class="meter" id="storage-bar" aria-hidden="true" hidden><div class="meter-fill" id="storage-fill"></div></div>
      <p class="total" id="storage-total"></p>
      <p class="over-box" id="storage-over" hidden>You are over your storage allowance. New uploads are refused until you delete tours or get more room.</p>
      <p class="hint" id="storage-online" hidden>Tours that are already online are not affected.</p>
      <p class="hint" id="storage-counts">Images, GIFs and tours all count. Deleting one frees its space within a few minutes.</p>
    </div>
    <div class="card">
      <h2 class="card-title" id="h-room" tabindex="-1">What takes the room</h2>
      <div class="room"><span>Tours</span><span class="r" id="room-tours"></span></div>
      <div class="room"><span>GIFs</span><span class="r" id="room-gifs"></span></div>
      <div class="room"><span>Images</span><span class="r" id="room-images"></span></div>
      <div class="room"><span>Logos</span><span class="r" id="room-logos"></span></div>
      <div class="room"><span>Uploads in progress</span><span class="r" id="room-uploads"></span></div>
    </div>
    <div class="card" id="largest" hidden>
      <h2 class="card-title" id="h-largest" tabindex="-1">Largest items</h2>
      <table class="largest" aria-labelledby="h-largest">
        <thead><tr><th scope="col">Item</th><th scope="col" class="mini-cell"><span class="vh">Share</span></th><th scope="col" class="n">Size</th><th scope="col"><span class="vh">Actions</span></th></tr></thead>
        <tbody id="largest-rows"></tbody>
      </table>
      <p class="hint" id="largest-all">Everything else is on the Images, GIFs and Tours pages.</p>
    </div>
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
  </div>`;

/** The Storage page: the shell with the page's body and its own script. */
export const STORAGE_HTML = dashHtml({ title: "Storage", active: "storage", main: STORAGE_MAIN, script: "/dash/storage.js" });

export const STORAGE_JS = `(function () {
  "use strict";
  var TEXT = {
    of: " of ",
    used: " used",
    dot: " · ",
    oneImage: "1 image",
    images: " images",
    oneGif: "1 GIF",
    gifs: " GIFs",
    oneTour: "1 tour",
    tours: " tours",
    tagTour: "Tour",
    tagImage: "Image",
    tagGif: "GIF",
    untitledImage: "Untitled image",
    untitledGif: "Untitled GIF",
    remove: "Delete",
    askBefore: 'Delete "',
    askAfter: '"?',
    askTour: "Its link stops working for everyone and its pictures are removed. This cannot be undone. The recording on your computer is not touched.",
    askItem: "Its link stops working for everyone and it is removed. This cannot be undone. The copy on your computer is not touched.",
    goTour: "Delete tour",
    goImage: "Delete image",
    goGif: "Delete GIF",
    deleting: "Deleting…",
    publishBusy: "This tour is being published. Try again when that is done.",
    notReloaded: "The change was made, but the list could not be loaded again. Reload the page to see it.",
  };
  // A tour's delete is driven by at most this many requests.
  var MAX_ROUNDS = 1000;
  // An item's delete is sent at most this many times while its files are not all removed yet.
  var ITEM_ROUNDS = 3;
  // The pauses before the second and the third send, so a moment's fault in the store does not use them all at once.
  var PAUSES_MS = [400, 1200];
  // How many entries the largest list holds at most (LARGEST_TOURS in src/usage.ts).
  var LARGEST = 10;
  var TOUR_ID = /^tour_[0-9a-f]{24}$/;
  var ITEM_ID = /^med_[0-9a-f]{24}$/;
  // What each kind of entry is called on the page, and asked about.
  var KINDS = {
    tour: { id: TOUR_ID, tag: TEXT.tagTour, untitled: "", ask: TEXT.askTour, go: TEXT.goTour },
    image: { id: ITEM_ID, tag: TEXT.tagImage, untitled: TEXT.untitledImage, ask: TEXT.askItem, go: TEXT.goImage },
    gif: { id: ITEM_ID, tag: TEXT.tagGif, untitled: TEXT.untitledGif, ask: TEXT.askItem, go: TEXT.goGif },
  };
  // What the page behind the question is, made inert while it is open.
  var BEHIND = ["dash-top", "storage-page"];
  // The question before a delete (Dash.question, src/dash/script.ts).
  var question = Dash.question({ backdrop: "delete-dialog", box: "delete-box", role: "alertdialog", title: "delete-title", message: "delete-message", behind: BEHIND, buttons: ["delete-keep", "delete-go"] });

  var $ = function (id) { return document.getElementById(id); };
  // The entry the question is about, and whether its delete is running.
  var asking = null;
  var working = false;
  // Each listed entry's Delete button, by id, to give the focus back after the question.
  var deleteOf = {};
  // The entries the list shows now.
  var listed = [];

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

  function isSize(n) {
    return typeof n === "number" && isFinite(n) && n >= 0;
  }

  // A share of a bar, in percent, from 0 to 100 with at most two decimals.
  function pct(share) {
    return Math.round(Math.max(0, Math.min(100, share)) * 100) / 100;
  }

  // "1 image", "48 images": a count with its word, singular for one.
  function counted(n, one, many) {
    return n === 1 ? one : n + many;
  }

  // Every listed entry's Delete, disabled while a delete runs and while the numbers are read again.
  function rowsDisabled(on) {
    for (var id in deleteOf) if (Object.prototype.hasOwnProperty.call(deleteOf, id)) deleteOf[id].disabled = on;
  }

  // ---- What the page shows ----

  function usageOk(u) {
    if (u === null || typeof u !== "object" || !isSize(u.used_bytes) || !isSize(u.tours) || !isSize(u.images) || !isSize(u.gifs)) return false;
    if (u.allowance_bytes !== null && !isSize(u.allowance_bytes)) return false;
    var c = u.counted;
    return c !== null && typeof c === "object" && isSize(c.pictures) && isSize(c.logos) && isSize(c.uploads_in_progress) && isSize(c.images) && isSize(c.gifs);
  }

  // Whether an entry of the largest list is one the page can show and delete.
  function entryOk(e) {
    if (e === null || typeof e !== "object" || !Object.prototype.hasOwnProperty.call(KINDS, e.kind)) return false;
    var k = KINDS[e.kind];
    if (typeof e.id !== "string" || !k.id.test(e.id) || !isSize(e.bytes)) return false;
    return e.kind === "tour" ? typeof e.title === "string" : e.title === null || typeof e.title === "string";
  }

  // The name an entry is shown and asked about by: its title, or "Untitled image" or "Untitled GIF" for an item without one.
  function nameOf(e) {
    return e.kind !== "tour" && (e.title === null || e.title === "") ? KINDS[e.kind].untitled : String(e.title);
  }

  function row(e, i, max) {
    var tr = el("tr");
    var nameId = "largest-" + i;
    var kindId = nameId + "-kind";
    var title = el("td", "t");
    var name = el("span", "name", nameOf(e));
    name.setAttribute("id", nameId);
    var tag = el("span", "tag", KINDS[e.kind].tag);
    tag.setAttribute("id", kindId);
    title.appendChild(name);
    title.appendChild(tag);
    tr.appendChild(title);
    var mini = el("td", "mini-cell");
    mini.setAttribute("aria-hidden", "true");
    var track = el("div", "mini");
    var fill = el("div", "mini-fill");
    var share = max > 0 ? (e.bytes / max) * 100 : 0;
    fill.style.width = pct(share) + "%";
    track.appendChild(fill);
    mini.appendChild(track);
    tr.appendChild(mini);
    tr.appendChild(el("td", "n size", Dash.formatBytes(e.bytes)));
    var cell = el("td", "del");
    var btn = el("button", "btn sm danger", TEXT.remove);
    btn.type = "button";
    // A screen reader hears which entry, and of which kind, the button deletes.
    btn.setAttribute("aria-describedby", nameId + " " + kindId);
    btn.disabled = working;
    btn.addEventListener("click", function () { ask(e); });
    cell.appendChild(btn);
    tr.appendChild(cell);
    deleteOf[e.id] = btn;
    return tr;
  }

  function show(u, entries, workspace) {
    var limit = u.allowance_bytes;
    var over = limit !== null && u.over === true;
    $("storage-workspace").textContent = workspace;
    var parts = [Dash.formatBytes(u.used_bytes) + (limit !== null ? TEXT.of + Dash.formatBytes(limit) : "") + TEXT.used];
    if (u.images > 0) parts.push(counted(u.images, TEXT.oneImage, TEXT.images));
    if (u.gifs > 0) parts.push(counted(u.gifs, TEXT.oneGif, TEXT.gifs));
    parts.push(counted(u.tours, TEXT.oneTour, TEXT.tours));
    $("storage-total").textContent = parts.join(TEXT.dot);
    var bar = $("storage-bar");
    bar.hidden = limit === null;
    if (limit !== null) {
      var share = over ? 100 : limit > 0 ? (u.used_bytes / limit) * 100 : u.used_bytes > 0 ? 100 : 0;
      bar.className = over ? "meter over" : "meter";
      $("storage-fill").style.width = pct(share) + "%";
    }
    $("storage-over").hidden = !over;
    $("storage-online").hidden = !over;
    $("storage-counts").hidden = over;
    $("room-tours").textContent = Dash.formatBytes(u.counted.pictures);
    $("room-gifs").textContent = Dash.formatBytes(u.counted.gifs);
    $("room-images").textContent = Dash.formatBytes(u.counted.images);
    $("room-logos").textContent = Dash.formatBytes(u.counted.logos);
    $("room-uploads").textContent = Dash.formatBytes(u.counted.uploads_in_progress);

    var list = entries.filter(entryOk);
    listed = list;
    var max = 0;
    list.forEach(function (e) { if (e.bytes > max) max = e.bytes; });
    deleteOf = {};
    var rows = $("largest-rows");
    rows.textContent = "";
    for (var i = 0; i < list.length; i++) rows.appendChild(row(list[i], i, max));
    $("largest").hidden = list.length === 0;
    $("dash-load").textContent = "";
    $("storage").hidden = false;
  }

  var workspace = "";

  // The usage and the largest list. Resolves to true when shown, false when the visitor
  // was sent to sign in, or the answer that failed (null when no answer came); then the page
  // keeps what it showed before.
  function load() {
    return Promise.all([Dash.api("GET", "/api/v1/usage"), Dash.api("GET", "/api/v1/usage/largest")]).then(function (got) {
      if (got[0].status === 401 || got[1].status === 401) { Dash.signedOut(); return false; }
      var usage = got[0];
      var largest = got[1];
      if (usage.status !== 200 || !usageOk(usage.data)) return usage;
      if (largest.status !== 200 || largest.data === null || typeof largest.data !== "object" || !Array.isArray(largest.data.largest)) return largest;
      show(usage.data, largest.data.largest, workspace);
      return true;
    }).then(null, function () { return null; });
  }

  // ---- The question before a delete ----

  function ask(e) {
    if (working || asking !== null) return;
    var k = KINDS[e.kind];
    // The question's words for this kind; the dialog is closed, so its button has no saved label.
    $("delete-text").textContent = k.ask;
    $("delete-go").textContent = k.go;
    var opened = question.open({
      title: TEXT.askBefore + nameOf(e) + TEXT.askAfter,
      focus: "delete-keep",
      // Back to the entry's Delete when it is still listed, else to the page's heading.
      back: function () { return deleteOf[e.id]; },
      fallback: "h-page",
      onClose: function () { asking = null; },
    });
    if (opened) asking = { e: e };
  }

  // Calls a tour's delete until it is no longer in progress; the last answer.
  function runTour(id) {
    var rounds = 0;
    function next() {
      rounds++;
      return Dash.api("DELETE", "/api/v1/tours/" + encodeURIComponent(id)).then(function (res) {
        return res.status === 202 && rounds < MAX_ROUNDS ? next() : res;
      });
    }
    return next();
  }

  function pause(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // Sends an item's delete, again after a pause while its files are not all removed yet, at most ITEM_ROUNDS times; the last answer.
  function runItem(id) {
    var rounds = 0;
    function next() {
      rounds++;
      return Dash.api("DELETE", "/api/v1/media/" + encodeURIComponent(id)).then(function (res) {
        return leftovers(res) && rounds < ITEM_ROUNDS ? pause(PAUSES_MS[rounds - 1]).then(next) : res;
      });
    }
    return next();
  }

  // After a delete whose answer was lost, whether the list read again shows the item gone: it
  // is not listed although it would still fit (the list is not full, or holds a smaller entry).
  function goneFromList(e) {
    var smaller = false;
    for (var i = 0; i < listed.length; i++) {
      if (listed[i].id === e.id) return false;
      if (listed[i].bytes < e.bytes) smaller = true;
    }
    return listed.length < LARGEST || smaller;
  }

  function leftovers(res) {
    return res !== null && res.status === 500 && Dash.errorOf(res) === "cleanup_pending";
  }

  // Whether the entry is gone (null: no answer came). One whose leftover files could not all
  // be removed yet is gone too: it is no longer listed, and later requests finish the cleaning.
  function done(e, res) {
    if (res === null) return false;
    if (leftovers(res) || res.status === 404) return true;
    return e.kind === "tour" ? res.status === 200 : res.status === 204;
  }

  // The sentence for a delete that did not happen.
  function problem(e, res) {
    if (e.kind === "tour" && res !== null && res.status === 409 && Dash.errorOf(res) === "publish_busy") return TEXT.publishBusy;
    return Dash.failure(res);
  }

  function startPage() {
    $("delete-keep").addEventListener("click", function () { question.dismiss(); });
    $("delete-go").addEventListener("click", function () {
      if (asking === null || working) return;
      var e = asking.e;
      working = true;
      question.say("");
      sayIn($("storage-message"), "");
      question.busy(true, "delete-go", TEXT.deleting);
      rowsDisabled(true);
      function settle(res) {
        if (res !== null && res.status === 401) { Dash.signedOut(); return; }
        var ok = done(e, res);
        if (ok) question.close(false);
        // However the delete ended, the numbers are read again before the page says anything;
        // the rows' Delete buttons stay disabled until then.
        return load().then(function (r) {
          if (r === false) return;
          working = false;
          question.busy(false, "delete-go");
          rowsDisabled(false);
          // No answer came for an image or a GIF: the list read again decides.
          if (res === null && e.kind !== "tour" && r === true && goneFromList(e)) {
            ok = true;
            question.close(false);
          }
          if (ok) {
            sayIn($("storage-message"), r === true ? "" : TEXT.notReloaded);
            $("h-page").focus();
            return;
          }
          question.say(problem(e, res));
          $("delete-go").focus();
        });
      }
      (e.kind === "tour" ? runTour(e.id) : runItem(e.id)).then(settle, function () { return settle(null); });
    });
  }

  startPage();
  Dash.start(function (who) {
    workspace = who.workspace;
    return load().then(function (r) {
      if (r !== true && r !== false) $("dash-load").textContent = Dash.failure(r);
    });
  });
})();
`;
