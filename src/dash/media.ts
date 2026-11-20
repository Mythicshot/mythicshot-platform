// The Images and GIFs pages of the dashboard, /images and /gifs, as in the approved mockups
// 3, 4 and 11: the workspace's shared items of one kind (GET /api/v1/media?kind=image or
// kind=clip), newest first, each with its preview, title, details, size and day, and Copy
// link, Open and Delete; the in-page question before a delete, the empty state, "Show more"
// while the list has another page, and the phone layout (each item a block;
// src/dash/style.ts). Both pages are made here by one function of the kind, so their
// documents and scripts cannot drift apart: what differs is the words and the API's kind.
// Each body is fixed text; each script fills it through createElement and textContent, so
// a title can never become markup.
//
// The line under the heading is the mockup's "48 images in <workspace> · 64 MB used" from
// the first load: the count and the size of the page's kind from GET /api/v1/usage, read
// beside the list every time the list is read (so also after a delete): the top-level
// images or gifs (the items online) and counted.images or counted.gifs (what they hold of
// the allowance, previews and leftovers of sends included). When the usage cannot be read,
// the line is made from the list itself, as before the usage had these totals: while the
// list has another page it names how many of the newest are shown and leaves the size out;
// once the last page is in, it is the whole count and the items' own bytes.
//
// A preview is the item's own route, GET /api/v1/media/<id>/preview, on this site (the
// policy allows images from 'self'), loaded lazily at a fixed size with no referrer; its
// address is made only from an id of the API's exact shape. A preview that does not load,
// and an item without one, show a plain box; a GIF's box carries a play mark drawn by the
// stylesheet. The list never loads an item's file itself.
//
// A link goes into an href, and into what Copy link copies, only when it is http(s) with a
// plain host name (and optional port) followed by one path, or one path of this site
// (which is then put after this page's own origin, as the Tours page does in one-address
// mode). Anything else gives the row no Copy link and no Open.
//
// Delete asks first (Dash.question). While it answers 500 cleanup_pending (the item is
// deleted; some of its files are not removed yet) it is sent again after a pause, at most
// MAX_TRIES times in all. 204, 404 (already gone) and cleanup_pending are done, as on the
// Tours page. When no answer came, the item itself is asked (GET /api/v1/media/<id>): only the
// API's own 404 not_found means it was deleted; an item still there (online or still being
// sent), or no usable answer to that either, is a failure, told with that answer's sentence.
// The list read again never decides it, because newer items can push a still-online item off
// the pages shown. However it ends the list is read again (every page shown so far), so the page shows what is true; a
// delete that worked whose list cannot be read again says so, as on the Tours page. The
// list is read one request at a time: Show more does nothing while a read runs, and a read
// waits for Show more, as on the Admin page.
import { dashHtml } from "./shell.ts";

/** What makes one of the two pages: its tab, its words and the API's kind. */
type MediaPage = {
  tab: "images" | "gifs";
  path: string;
  script: string;
  /** The `kind` of GET /api/v1/media. */
  api: "image" | "clip";
  /** Whether a row's preview box carries the play mark. */
  play: boolean;
  heading: string;
  column: string;
  emptyTitle: string;
  emptyText: string;
  hint: string;
  deleteButton: string;
  /** The words of the page's script (its TEXT). */
  text: Record<string, string>;
};

const QUESTION = "Its link stops working for everyone and it is removed. This cannot be undone. The copy on your computer is not touched.";

/** The words both scripts share; each page adds its own after them. */
const SHARED_TEXT = {
  newest: "The newest ",
  inWorkspace: " in ",
  dot: " · ",
  used: " used",
  by: " × ",
  seconds: " s",
  png: "PNG",
  jpeg: "JPEG",
  copy: "Copy link",
  copied: "Copied",
  open: "Open",
  remove: "Delete",
  askBefore: 'Delete "',
  askAfter: '"?',
  deleting: "Deleting…",
  cut: "…",
  notReloaded: "The change was made, but the list could not be loaded again. Reload the page to see it.",
};

const IMAGES: MediaPage = {
  tab: "images",
  path: "/images",
  script: "/dash/images.js",
  api: "image",
  play: false,
  heading: "Images",
  column: "Image",
  emptyTitle: "No images yet",
  emptyText: "Take a screenshot in Mythicshot and choose Publish to. It shows up here with a link to share.",
  hint: "Anyone with the link can see the image. Deleting it stops the link for everyone.",
  deleteButton: "Delete image",
  text: { oneItem: "1 image", items: " images", untitled: "Untitled image", ...SHARED_TEXT },
};

const GIFS: MediaPage = {
  tab: "gifs",
  path: "/gifs",
  script: "/dash/gifs.js",
  api: "clip",
  play: true,
  heading: "GIFs",
  column: "GIF",
  emptyTitle: "No GIFs yet",
  emptyText: "Record a clip in Mythicshot and choose Publish to. It shows up here with a link to share.",
  hint: "Anyone with the link can watch the GIF. Deleting it stops the link for everyone.",
  deleteButton: "Delete GIF",
  text: { oneItem: "1 GIF", items: " GIFs", untitled: "Untitled GIF", ...SHARED_TEXT },
};

/** The page's body: fixed text only. */
function mediaMain(p: MediaPage): string {
  return `  <div id="media-page">
  <h1 id="h-page" tabindex="-1">${p.heading}</h1>
  <section id="media" aria-labelledby="h-page" hidden>
    <p class="sub"><span id="media-count"></span><span class="wide-only" id="media-in"></span><span id="media-used"></span></p>
    <p class="message" id="media-message" role="status" aria-live="polite" hidden></p>
    <div class="card" id="media-list" hidden>
      <table class="media">
        <thead><tr><th scope="col" class="thumb-cell"><span class="vh">Preview</span></th><th scope="col">${p.column}</th><th scope="col" class="n">Size</th><th scope="col" class="n">Shared</th><th scope="col"><span class="vh">Actions</span></th></tr></thead>
        <tbody id="media-rows"></tbody>
      </table>
    </div>
    <div class="show-more"><button type="button" class="btn quiet" id="media-more" hidden>Show more</button></div>
    <div class="card" id="media-empty" hidden>
      <div class="empty">
        <p class="empty-title">${p.emptyTitle}</p>
        <p>${p.emptyText}</p>
      </div>
    </div>
    <p class="hint" id="media-hint" hidden>${p.hint}</p>
  </section>
  </div>
  <div class="backdrop" id="delete-dialog" hidden>
    <div class="dialog" id="delete-box" role="alertdialog" aria-modal="true" aria-labelledby="delete-title" aria-describedby="delete-text">
      <h2 id="delete-title" tabindex="-1"></h2>
      <p class="sub" id="delete-text">${QUESTION}</p>
      <p class="message" id="delete-message" role="status" aria-live="polite" hidden></p>
      <div class="two">
        <button type="button" class="btn quiet" id="delete-keep">Keep it</button>
        <button type="button" class="btn danger" id="delete-go">${p.deleteButton}</button>
      </div>
    </div>
  </div>`;
}

/** The page's script: the same code for both pages, with the page's words and kind. */
function mediaJs(p: MediaPage): string {
  const text = Object.entries(p.text)
    .map(([k, v]) => `    ${k}: ${JSON.stringify(v)},`)
    .join("\n");
  return String.raw`(function () {
  "use strict";
  var TEXT = {
${text}
  };
  // The items this page lists (the kind of GET /api/v1/media), and whether a preview carries the play mark.
  var KIND = ${JSON.stringify(p.api)};
  var PLAY = ${p.play ? "true" : "false"};
  var LIST = "/api/v1/media?kind=" + KIND;
  var ITEM = "/api/v1/media/";
  // The usage, and its two numbers for this page's kind.
  var USAGE = "/api/v1/usage";
  var TOTAL = KIND === "image" ? "images" : "gifs";
  // A delete is sent at most this many times in all while it answers 500 cleanup_pending.
  var MAX_TRIES = 3;
  // The pauses before the second and the third send, so a moment's fault in the store does not use them all at once.
  var PAUSES_MS = [400, 1200];
  // How long Copy link reads Copied.
  var COPIED_MS = 2000;
  // How many characters of the link's last part the row shows.
  var SHOWN = 4;
  // The preview's fixed size, in pixels.
  var THUMB_W = "56";
  var THUMB_H = "36";
  var ITEM_ID = /^med_[0-9a-f]{24}$/;
  var CURSOR = /^[A-Za-z0-9_-]{1,100}$/;
  // A link the page may use: http(s), a plain host name or address with an optional port, and one path; or one path of this site.
  var ABSOLUTE = /^https?:\/\/(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::[0-9]{1,5})?\/(?![\/\\])[A-Za-z0-9._~!$&()*+,;=:@%\/?#-]*$/i;
  var PATH = /^\/(?![\/\\])[A-Za-z0-9._~!$&()*+,;=:@%\/?#-]*$/;
  // What the page behind the question is, made inert while it is open.
  var BEHIND = ["dash-top", "media-page"];
  // The question before a delete (Dash.question, src/dash/script.ts).
  var question = Dash.question({ backdrop: "delete-dialog", box: "delete-box", role: "alertdialog", title: "delete-title", message: "delete-message", behind: BEHIND, buttons: ["delete-keep", "delete-go"] });

  var $ = function (id) { return document.getElementById(id); };
  var workspace = "";
  // The items shown, how many pages of the list they are, and the cursor of the page after them.
  var items = [];
  var pages = 0;
  var next = null;
  // This kind's count and size from the usage ({ n, bytes }), or null when it could not be read.
  var totals = null;
  // The list request running (a read, or Show more), or null: one at a time.
  var listing = null;
  // The item the question is about, and whether its delete is running.
  var asking = null;
  var working = false;
  // Each row's first control and its Delete, by item id, to give the focus back after the list is rebuilt.
  var firstOf = {};
  var deleteOf = {};
  // Every button of every row, to disable while a delete runs.
  var rowButtons = [];

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // A message line is hidden while it has nothing to say.
  function say(text) {
    var line = $("media-message");
    line.textContent = text;
    line.hidden = text === "";
  }

  function rowsDisabled(on) {
    rowButtons.forEach(function (b) { b.disabled = on; });
  }

  function isCount(n) {
    return typeof n === "number" && isFinite(n) && n >= 0 && Math.floor(n) === n;
  }

  // ---- What a row shows ----

  // The whole link, or null when it cannot be trusted.
  function linkOf(it) {
    if (typeof it.link !== "string") return null;
    if (ABSOLUTE.test(it.link)) return it.link;
    if (PATH.test(it.link)) return location.origin + it.link;
    return null;
  }

  // The link as the row shows it: no scheme, and its last part cut after a few characters.
  function shortOf(link) {
    var text = link.replace(/^https?:\/\//i, "");
    var at = text.lastIndexOf("/") + 1;
    return text.length - at > SHOWN ? text.slice(0, at + SHOWN) + TEXT.cut : text;
  }

  function titleOf(it) {
    return typeof it.title === "string" && it.title.trim() !== "" ? it.title : TEXT.untitled;
  }

  // "1920 × 1080 · PNG" for an image, "12 s · 960 × 540" for a clip; a part the item lacks is left out.
  function detailsOf(it) {
    var parts = [];
    if (KIND === "clip" && typeof it.duration_ms === "number" && isFinite(it.duration_ms) && it.duration_ms > 0) parts.push(Math.max(1, Math.round(it.duration_ms / 1000)) + TEXT.seconds);
    if (isCount(it.width) && isCount(it.height) && it.width > 0 && it.height > 0) parts.push(it.width + TEXT.by + it.height);
    if (KIND === "image") {
      var type = it.content_type === "image/png" ? TEXT.png : it.content_type === "image/jpeg" ? TEXT.jpeg : "";
      if (type !== "") parts.push(type);
    }
    return parts.join(TEXT.dot);
  }

  // The preview box: the item's own preview when it has one, else (and when it does not load) a plain box.
  function preview(it) {
    var box = el("span", PLAY ? "thumb play" : "thumb");
    if (it.has_preview !== true) return box;
    var img = el("img");
    img.setAttribute("alt", "");
    img.setAttribute("width", THUMB_W);
    img.setAttribute("height", THUMB_H);
    img.setAttribute("loading", "lazy");
    img.setAttribute("decoding", "async");
    img.setAttribute("referrerpolicy", "no-referrer");
    img.addEventListener("error", function () { img.remove(); });
    img.src = ITEM + it.id + "/preview";
    box.appendChild(img);
    return box;
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

  function row(it, i) {
    var tr = el("tr");
    var titleId = "item-" + i;
    var link = linkOf(it);
    var size = Dash.formatBytes(it.bytes);
    var when = Dash.dateOf(it.created_at);
    var details = detailsOf(it);
    var lead = details !== "" ? TEXT.dot : "";

    var thumb = el("td", "thumb-cell");
    thumb.setAttribute("aria-hidden", "true");
    thumb.appendChild(preview(it));
    tr.appendChild(thumb);

    var what = el("td", "what");
    var name = el("div", "t", titleOf(it));
    name.setAttribute("id", titleId);
    what.appendChild(name);
    var d = el("div", "d");
    d.appendChild(el("span", "", details));
    if (link !== null) {
      var shown = el("span", "wide-only", lead + shortOf(link));
      shown.setAttribute("title", link);
      d.appendChild(shown);
    }
    d.appendChild(el("span", "narrow-only", lead + size + TEXT.dot + when));
    what.appendChild(d);
    tr.appendChild(what);
    tr.appendChild(el("td", "n size", size));
    tr.appendChild(el("td", "n when", when));

    var cell = el("td", "acts-cell");
    var acts = el("div", "acts");
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
      firstOf[it.id] = copy;
      var open = el("a", "btn sm quiet", TEXT.open);
      open.setAttribute("href", link);
      open.setAttribute("target", "_blank");
      open.setAttribute("rel", "noopener noreferrer");
      open.setAttribute("aria-describedby", titleId);
      acts.appendChild(open);
    }
    var del = el("button", "btn sm danger", TEXT.remove);
    del.type = "button";
    del.setAttribute("aria-describedby", titleId);
    del.addEventListener("click", function () { ask(it); });
    acts.appendChild(del);
    rowButtons.push(del);
    deleteOf[it.id] = del;
    if (firstOf[it.id] === undefined) firstOf[it.id] = del;
    cell.appendChild(acts);
    tr.appendChild(cell);
    return tr;
  }

  function render() {
    firstOf = {};
    deleteOf = {};
    rowButtons = [];
    var n = items.length;
    var all = next === null;
    var bytes = 0;
    items.forEach(function (it) { bytes += it.bytes; });
    if (totals !== null) {
      $("media-count").textContent = totals.n === 1 ? TEXT.oneItem : totals.n + TEXT.items;
      $("media-used").textContent = TEXT.dot + Dash.formatBytes(totals.bytes) + TEXT.used;
    } else {
      $("media-count").textContent = all ? (n === 1 ? TEXT.oneItem : n + TEXT.items) : TEXT.newest + n + TEXT.items;
      $("media-used").textContent = all ? TEXT.dot + Dash.formatBytes(bytes) + TEXT.used : "";
    }
    $("media-in").textContent = workspace !== "" ? TEXT.inWorkspace + workspace : "";
    var rows = $("media-rows");
    rows.textContent = "";
    for (var i = 0; i < n; i++) rows.appendChild(row(items[i], i));
    rowsDisabled(working);
    $("media-list").hidden = n === 0;
    $("media-hint").hidden = n === 0;
    $("media-empty").hidden = n !== 0 || !all;
    $("media-more").hidden = all;
    $("dash-load").textContent = "";
    $("media").hidden = false;
  }

  // ---- Reading the list ----

  function cursorOf(v) {
    return typeof v === "string" && CURSOR.test(v) ? v : null;
  }

  function listed(res) {
    return res.status === 200 && res.data !== null && typeof res.data === "object" && Array.isArray(res.data.items);
  }

  // Only an item of this page's kind, with an id of the API's shape and a size, is shown.
  function usable(list) {
    return list.filter(function (it) { return it !== null && typeof it === "object" && typeof it.id === "string" && ITEM_ID.test(it.id) && it.kind === KIND && isCount(it.bytes); });
  }

  function pageOf(after) {
    return Dash.api("GET", after === null ? LIST : LIST + "&cursor=" + encodeURIComponent(after));
  }

  // One list request at a time: Show more is disabled while one runs, and does nothing then;
  // a read asked for while Show more runs starts when it has ended, so it reads every page
  // shown by then. track() marks the request running until it ends.
  function track(p) {
    listing = p;
    $("media-more").disabled = true;
    function end() {
      if (listing !== p) return;
      listing = null;
      $("media-more").disabled = false;
    }
    p.then(end, end);
    return p;
  }

  // The pages of the list shown so far (at least one), read again once any list request
  // running has ended. Resolves as readNow does.
  function read() {
    var before = listing === null ? Promise.resolve() : listing.then(null, function () {});
    return track(before.then(function () { return readNow(Math.max(1, pages)); }));
  }

  // This kind's count and size from the usage, or null when the answer is not one (or none came).
  function totalsOf() {
    return Dash.api("GET", USAGE).then(function (res) {
      var u = res.status === 200 ? res.data : null;
      if (u === null || typeof u !== "object" || u.counted === null || typeof u.counted !== "object") return null;
      var n = u[TOTAL];
      var bytes = u.counted[TOTAL];
      return isCount(n) && isCount(bytes) ? { n: n, bytes: bytes } : null;
    }, function () { return null; });
  }

  // The first "want" pages, then the page shown again, with the usage's totals read beside
  // them. Resolves to true when shown, false when the visitor was sent to sign in, or the
  // answer that failed (null when no answer came); then the page keeps what it showed before.
  function readNow(want) {
    var got = [];
    var cursor = null;
    var count = 0;
    function step(after) {
      return pageOf(after).then(function (res) {
        if (!listed(res)) return res;
        got = got.concat(usable(res.data.items));
        count++;
        cursor = cursorOf(res.data.next);
        return cursor !== null && count < want ? step(cursor) : true;
      });
    }
    var usage = totalsOf();
    return step(null).then(function (r) {
      if (r !== true) {
        if (r.status === 401) { Dash.signedOut(); return false; }
        return r;
      }
      return usage.then(function (t) {
        totals = t;
        return true;
      });
    }).then(function (r) {
      if (r !== true) return r;
      items = got;
      pages = count;
      next = cursor;
      render();
      return true;
    }).then(null, function () { return null; });
  }

  // ---- Show more ----

  function more() {
    if (listing !== null || next === null || working) return;
    say("");
    var from = items.length;
    track(pageOf(next).then(function (res) {
      if (res.status === 401) { Dash.signedOut(); return; }
      if (!listed(res)) { say(Dash.failure(res)); return; }
      items = items.concat(usable(res.data.items));
      pages++;
      next = cursorOf(res.data.next);
      render();
      var first = items.length > from ? firstOf[items[from].id] : undefined;
      if (first !== undefined) first.focus();
      else $("h-page").focus();
    }, function () {
      say(Dash.TEXT.failed);
    }));
  }

  // ---- The question before a delete ----

  function ask(it) {
    if (working || asking !== null) return;
    var opened = question.open({
      title: TEXT.askBefore + titleOf(it) + TEXT.askAfter,
      focus: "delete-keep",
      // Back to the item's Delete when it is still listed, else to the page's heading.
      back: function () { return deleteOf[it.id]; },
      fallback: "h-page",
      onClose: function () { asking = null; },
    });
    if (opened) asking = { it: it };
  }

  // Whether the item is deleted but some of its files are still being removed: then it is
  // sent again, to finish the cleaning (a later request finishes it otherwise).
  function cleaning(res) {
    return res !== null && res.status === 500 && Dash.errorOf(res) === "cleanup_pending";
  }

  function pause(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // Sends the delete, again after a pause while it answers cleanup_pending, at most MAX_TRIES times; the last answer.
  function run(id) {
    var tries = 0;
    function send() {
      tries++;
      return Dash.api("DELETE", ITEM + encodeURIComponent(id)).then(function (res) {
        return cleaning(res) && tries < MAX_TRIES ? pause(PAUSES_MS[tries - 1]).then(send) : res;
      });
    }
    return send();
  }

  // Whether the item is gone (null: no answer came): deleted now (with or without files
  // left to remove), or already gone. The Tours page counts the same answers as done.
  function done(res) {
    return res !== null && (res.status === 204 || res.status === 404 || cleaning(res));
  }

  // No answer came to a delete: the item itself decides, not the list (newer items can push a
  // listed one off the pages shown). Resolves to { gone, res }: gone only when it answers the
  // API's own 404 not_found (deleted, or never there), not a 404 from something in between;
  // res is that answer (null when none came), for the sentence of a failure (429 has its own).
  // Null when the visitor was sent to sign in. The id matched ITEM_ID.
  function gone(id) {
    return Dash.api("GET", ITEM + encodeURIComponent(id)).then(function (res) {
      if (res.status === 401) { Dash.signedOut(); return null; }
      return { gone: res.status === 404 && Dash.errorOf(res) === "not_found", res: res };
    }, function () { return { gone: false, res: null }; });
  }

  function startPage() {
    $("media-more").addEventListener("click", more);
    $("delete-keep").addEventListener("click", function () { question.dismiss(); });
    $("delete-go").addEventListener("click", function () {
      if (asking === null || working) return;
      var it = asking.it;
      working = true;
      question.say("");
      say("");
      question.busy(true, "delete-go", TEXT.deleting);
      rowsDisabled(true);
      // res: the delete's last answer, or null when none came; asked: what the item itself
      // answered then (gone).
      function settle(res, asked) {
        if (res !== null && res.status === 401) { Dash.signedOut(); return; }
        var ok = done(res) || (res === null && asked !== undefined && asked.gone);
        if (ok) question.close(false);
        // However the delete ended, the list is read again before the page says anything;
        // the rows' buttons stay disabled until then.
        return read().then(function (r) {
          if (r === false) return;
          working = false;
          question.busy(false, "delete-go");
          rowsDisabled(false);
          if (ok) {
            say(r === true ? "" : TEXT.notReloaded);
            $("h-page").focus();
            return;
          }
          question.say(Dash.failure(res === null && asked !== undefined ? asked.res : res));
          $("delete-go").focus();
        });
      }
      run(it.id).then(function (res) { return settle(res); }, function () {
        return gone(it.id).then(function (g) {
          if (g === null) return;
          return settle(null, g);
        });
      });
    });
  }

  startPage();
  Dash.start(function (who) {
    workspace = who.workspace;
    return read().then(function (r) {
      if (r !== true && r !== false) $("dash-load").textContent = Dash.failure(r);
    });
  });
})();
`;
}

/** The Images page, /images: the shell with the page's body and its own script. */
export const IMAGES_HTML = dashHtml({ title: IMAGES.heading, active: IMAGES.tab, main: mediaMain(IMAGES), script: IMAGES.script });
export const IMAGES_JS = mediaJs(IMAGES);
/** The GIFs page, /gifs: the same page for clips. */
export const GIFS_HTML = dashHtml({ title: GIFS.heading, active: GIFS.tab, main: mediaMain(GIFS), script: GIFS.script });
export const GIFS_JS = mediaJs(GIFS);
