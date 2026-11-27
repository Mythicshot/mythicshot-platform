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
// Who can view an item (Plan 2k): the list's "Who can view" column shows each item's setting
// from the list (`access`, and `viewers`, the count on its list), as the Tours page shows a
// tour's, and on a phone the setting joins the details line. Each row has Copy link, Open and
// More, as a published tour's row has; More holds "Sharing…" then Delete. Sharing… reads GET
// /api/v1/media/<id>/access and opens the tour's Sharing box, made by src/dash/sharing.ts for
// both pages, with an item's differences: nothing moves, so a change is in force at once (no
// progress and no stopped move); 409 too_large_to_restrict has its own sentence; and while a
// restricted setting is chosen for an item that is public now, a line says that restricting
// takes effect at once here but cannot take back a copy someone already opened or saved. Only
// a signed-in session may change the setting (src/media-access.ts); this page has no other
// credential, and the addresses travel only in a JSON body, never in a path.
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
// Delete, in More, asks first (Dash.question). While it answers 500 cleanup_pending (the item is
// deleted; some of its files are not removed yet) it is sent again after a pause, at most
// MAX_TRIES times in all. 204, a 404 with the error not_found from this app (already gone) and
// cleanup_pending are done; once a send answered cleanup_pending the item is done whatever a
// resend answers, as on the Storage page. When no answer came to a first send, the item itself is
// asked (GET /api/v1/media/<id>): only a 404 with the error not_found from this app means it was
// deleted; an item still there (online or still being
// sent), or no usable answer to that either, is a failure, told with that answer's sentence.
// The list read again never decides it, because newer items can push a still-online item off
// the pages shown. However it ends the list is read again (every page shown so far), so the page shows what is true; a
// delete that worked whose list cannot be read again says so, as on the Tours page. The
// list is read one request at a time: Show more does nothing while a read runs, and a read
// waits for Show more, as on the Admin page.
//
// Deleting several (the approved multi-select mockup): each row starts with a checkbox named
// "Select <title>" for a screen reader, and a checkbox above the table selects exactly the
// items shown ("Select all <n> shown"; mixed while some are selected), never those still
// behind Show more, which arrive unselected. While something is selected a bar above the list
// says how many, with Clear and Delete selected; the count is also said politely in a line of
// its own. The selection is kept only in this script, by the ids of the list's own items, and
// is cleared by Clear, by a reload, and when the list is read again after a delete in More
// that worked. The bar keeps its place while the list is shown (invisible and inert while
// nothing is selected), so ticking a row never moves the rows.
// Delete selected asks first (Dash.question, its own box), with no title in its heading, then
// deletes the items one after another through the same DELETE /api/v1/media/<id>, each as a
// delete in More is decided (deleteOne); the first one refused, or failed for good, stops the
// run. While it runs the box says "Deleting <i> of <n>…" politely and cannot start another.
// However it ends, the list is read again, the items deleted leave the selection and the
// others stay selected while the list has them, the box closes and one sentence says how many
// were deleted (with the failure's sentence when one stopped the run). Every delete question
// ends with the same red line with the warning sign: there are no backups.
import { shareConstants, shareHelpers, shareHtml, shareListeners, shareMenu, shareQuestion, shareRepeatIds, shareScript, shareState, shareText, shareViewOf, type SharePage } from "./sharing.ts";
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
  /** The line shown under the hint while the list has a restricted item. */
  gate: string;
  deleteButton: string;
  /** Who can view one of the page's items: the Sharing box's words and the API's ids. */
  sharing: SharePage;
  /** The words of the page's script (its TEXT). */
  text: Record<string, string>;
};

/** The single delete's sentence, and the one of a delete of one selected item. */
const QUESTION = "Its link stops working for everyone and it is removed. The copy on your computer is not touched.";
/** The sentence of a delete of several selected items. */
const QUESTION_SOME = "Their links stop working for everyone and they are removed. The copies on your computer are not touched.";
/** Under the sentence of every delete question, in red with the warning sign. */
const NO_BACKUPS = "There are no backups of this data, and its removal is permanent.";

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
  more: "More",
  notReloaded: "The change was made, but the list could not be loaded again. Reload the page to see it.",
  select: "Select ",
  allBefore: "Select all ",
  allAfter: " shown",
  selected: " selected",
  bulkBefore: "Delete ",
  bulkAfter: "?",
  askOne: QUESTION,
  askSome: QUESTION_SOME,
  keepIt: "Keep it",
  keepThem: "Keep them",
  progressBefore: "Deleting ",
  progressOf: " of ",
  progressAfter: "…",
  deletedAfter: " deleted.",
  restAfter: " deleted. The rest are still here.",
};

/** Who can view an item of the noun's kind: nothing moves (src/dash/sharing.ts). */
function itemSharing(noun: "image" | "clip"): SharePage {
  const copies = `Restricting takes effect at once on this site, but anyone who already opened or saved the ${noun} keeps their copy.`;
  return {
    moves: false,
    noun,
    nouns: noun + "s",
    idVar: "ITEM_ID",
    api: "/api/v1/media/",
    title: "titleOf(t)",
    words: {
      restrict: `Restrict ${noun}`,
      askWarn: copies,
      copies,
      tooLarge: `This ${noun} is too large to restrict on this site. Nothing was changed.`,
    },
  };
}

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
  hint: 'Deleting an image stops its link for everyone. "More" holds: Sharing, Delete.',
  gate: "Opening a restricted image asks you for your email address too: the dashboard's sign-in does not carry over to the image's address.",
  deleteButton: "Delete image",
  sharing: itemSharing("image"),
  text: { oneItem: "1 image", items: " images", untitled: "Untitled image", oneNot: "The image was not deleted.", noneDeleted: "No images were deleted.", ...SHARED_TEXT },
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
  hint: 'Deleting a GIF stops its link for everyone. "More" holds: Sharing, Delete.',
  gate: "Opening a restricted clip asks you for your email address too: the dashboard's sign-in does not carry over to the clip's address.",
  deleteButton: "Delete GIF",
  sharing: itemSharing("clip"),
  text: { oneItem: "1 GIF", items: " GIFs", untitled: "Untitled GIF", oneNot: "The GIF was not deleted.", noneDeleted: "No GIFs were deleted.", ...SHARED_TEXT },
};

/** The page's body: fixed text only. */
function mediaMain(p: MediaPage): string {
  return `  <div id="media-page">
  <h1 id="h-page" tabindex="-1">${p.heading}</h1>
  <section id="media" aria-labelledby="h-page" hidden>
    <p class="sub"><span id="media-count"></span><span class="wide-only" id="media-in"></span><span id="media-used"></span></p>
    <p class="message" id="media-message" role="status" aria-live="polite" hidden></p>
    <p class="vh" id="pick-said" role="status" aria-live="polite"></p>
    <div class="pick-bar idle" id="pick-bar" inert aria-hidden="true" hidden>
      <span class="pick-count" id="pick-count" aria-hidden="true"></span>
      <button type="button" class="btn quiet" id="pick-clear">Clear</button>
      <button type="button" class="btn danger" id="pick-delete">Delete selected</button>
    </div>
    <div class="card" id="media-list" hidden>
      <label class="pick-all" for="media-all"><input type="checkbox" class="pick" id="media-all"><span id="media-all-text"></span></label>
      <table class="media">
        <thead><tr><td class="pick-cell"></td><th scope="col" class="thumb-cell"><span class="vh">Preview</span></th><th scope="col">${p.column}</th><th scope="col">Who can view</th><th scope="col" class="n">Size</th><th scope="col" class="n">Shared</th><th scope="col"><span class="vh">Actions</span></th></tr></thead>
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
    <p class="hint" id="media-gate" hidden>${p.gate}</p>
  </section>
  </div>
  <div class="backdrop" id="delete-dialog" hidden>
    <div class="dialog" id="delete-box" role="alertdialog" aria-modal="true" aria-labelledby="delete-title" aria-describedby="delete-text delete-warn">
      <h2 id="delete-title" tabindex="-1"></h2>
      <p class="sub" id="delete-text">${QUESTION}</p>
      <p class="danger-line" id="delete-warn">${NO_BACKUPS}</p>
      <p class="message" id="delete-message" role="status" aria-live="polite" hidden></p>
      <div class="two">
        <button type="button" class="btn quiet" id="delete-keep">Keep it</button>
        <button type="button" class="btn danger" id="delete-go">${p.deleteButton}</button>
      </div>
    </div>
  </div>
  <div class="backdrop" id="bulk-dialog" hidden>
    <div class="dialog" id="bulk-box" role="alertdialog" aria-modal="true" aria-labelledby="bulk-title" aria-describedby="bulk-text bulk-warn">
      <h2 id="bulk-title" tabindex="-1"></h2>
      <p class="sub" id="bulk-text"></p>
      <p class="danger-line" id="bulk-warn">${NO_BACKUPS}</p>
      <p class="sub" id="bulk-progress" role="status" aria-live="polite"></p>
      <div class="two">
        <button type="button" class="btn quiet" id="bulk-keep"></button>
        <button type="button" class="btn danger" id="bulk-go"></button>
      </div>
    </div>
  </div>
${shareHtml(p.sharing)}`;
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
${shareText(p.sharing)}  };
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
${shareConstants(p.sharing)}  // How long Copy link reads Copied.
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
  // The question before deleting the selected items, one after another.
  var bulkQ = Dash.question({ backdrop: "bulk-dialog", box: "bulk-box", role: "alertdialog", title: "bulk-title", behind: BEHIND, buttons: ["bulk-keep", "bulk-go"] });
${shareQuestion(p.sharing)}
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
  // The item the question is about, and whether a delete, or a read or change of who can view, is running.
  var asking = null;
  var working = false;
  // The menu that is open.
  var openMenu = null;
  // Each row's first control and its More, by item id, to give the focus back after the list is rebuilt.
  var firstOf = {};
  var moreOf = {};
  // Every button and checkbox of every row, menus included, to disable while a change runs.
  var rowButtons = [];
  // The items selected, by id: only ever ids of items in the list shown, so only ids this
  // workspace's own list gave. Kept in this page alone, never in storage or the address.
  var picked = Object.create(null);
  // Each row's checkbox, by item id.
  var pickOf = {};
  // The ids the question before deleting the selected items is about, in the list's order, while it is open.
  var bulk = null;
${shareState(p.sharing)}
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // A message line is hidden while it has nothing to say. A plain one (the outcome of
  // deleting the selected items when every one was deleted) is in the text's colour.
  function say(text, plain) {
    var line = $("media-message");
    line.className = plain === true ? "message plain" : "message";
    line.textContent = text;
    line.hidden = text === "";
  }

  function rowsDisabled(on) {
    rowButtons.forEach(function (b) { b.disabled = on; });
    ["media-all", "pick-clear", "pick-delete"].forEach(function (id) { $(id).disabled = on; });
  }

${shareHelpers(["bulkQ"])}
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

${shareMenu(p.sharing)}
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

${shareViewOf(p.sharing)}
  function row(it, i) {
    var tr = el("tr");
    var titleId = "item-" + i;
    var link = linkOf(it);
    var size = Dash.formatBytes(it.bytes);
    var when = Dash.dateOf(it.created_at);
    var details = detailsOf(it);
    var lead = details !== "" ? TEXT.dot : "";
    var view = viewOf(it);

    // The checkbox, named for a screen reader with the item's title as text.
    var pickCell = el("td", "pick-cell");
    var box = el("input", "pick");
    box.type = "checkbox";
    box.setAttribute("aria-label", TEXT.select + titleOf(it));
    box.checked = picked[it.id] === true;
    box.addEventListener("change", function () { pick(it.id, box.checked); });
    pickCell.appendChild(box);
    tr.appendChild(pickCell);
    rowButtons.push(box);
    pickOf[it.id] = box;

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
    // On a phone the setting joins this line, as on the Tours page.
    d.appendChild(el("span", "narrow-only", lead + size + TEXT.dot + when + (view !== null ? TEXT.dot + view.text : "")));
    what.appendChild(d);
    tr.appendChild(what);
    var who = el("td", "view");
    who.appendChild(view === null ? el("span", "", TEXT.noSetting) : el("span", view.tag ? "tag warn" : "", view.text));
    tr.appendChild(who);
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
    acts.appendChild(moreMenu(it, i, [{ text: TEXT.sharing, kind: "share" }, { text: TEXT.remove, kind: "delete", danger: true }], titleId));
    if (firstOf[it.id] === undefined) firstOf[it.id] = moreOf[it.id];
    cell.appendChild(acts);
    tr.appendChild(cell);
    return tr;
  }

  function render() {
    closeMenu(false);
    firstOf = {};
    moreOf = {};
    pickOf = {};
    rowButtons = [];
    // Only an item in the list stays selected.
    var still = Object.create(null);
    items.forEach(function (it) { if (picked[it.id] === true) still[it.id] = true; });
    picked = still;
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
    showPicks();
    rowsDisabled(working);
    $("media-list").hidden = n === 0;
    $("media-hint").hidden = n === 0;
    // The line about opening a restricted item, when the list has one to open.
    $("media-gate").hidden = !items.some(function (it) { return it.access === "people" || it.access === "me"; });
    $("media-empty").hidden = n !== 0 || !all;
    $("media-more").hidden = all;
    $("dash-load").textContent = "";
    $("media").hidden = false;
  }

  // ---- Selecting items ----

  // The ids of the items selected, in the list's order, each once.
  function pickedIds() {
    // items holds each id once (joined, the one way it is filled).
    return items.filter(function (it) { return picked[it.id] === true; }).map(function (it) { return it.id; });
  }

  // The header's checkbox and words, and the bar; the count is said politely in a line of its
  // own. The bar keeps its place above the list whenever the list is shown, so a tick never
  // moves the rows: while nothing is selected it is invisible (the stylesheet's idle) and inert,
  // out of the Tab order, unread and not clickable. Without a list it is not in the layout.
  function showPicks() {
    Object.keys(pickOf).forEach(function (id) { pickOf[id].checked = picked[id] === true; });
    var n = items.length;
    var k = pickedIds().length;
    var all = $("media-all");
    all.checked = n > 0 && k === n;
    all.indeterminate = k > 0 && k < n;
    $("media-all-text").textContent = TEXT.allBefore + n + TEXT.allAfter;
    var count = k === 0 ? "" : k + TEXT.selected;
    $("pick-count").textContent = count;
    var bar = $("pick-bar");
    bar.hidden = n === 0;
    bar.className = k === 0 ? "pick-bar idle" : "pick-bar";
    if (k === 0) {
      // A focus on the bar's buttons goes to Select all first, never to the document as the bar turns inert.
      if (bar.contains(document.activeElement)) (n > 0 ? all : $("h-page")).focus();
      bar.setAttribute("inert", "");
      bar.setAttribute("aria-hidden", "true");
    } else {
      bar.removeAttribute("inert");
      bar.removeAttribute("aria-hidden");
    }
    if ($("pick-said").textContent !== count) $("pick-said").textContent = count;
  }

  function pick(id, on) {
    if (working || !ITEM_ID.test(id)) return;
    if (on) picked[id] = true;
    else delete picked[id];
    showPicks();
  }

  // Select all: exactly the items shown, never those still behind Show more; or none.
  function pickAll(on) {
    if (working) return;
    picked = Object.create(null);
    if (on) items.forEach(function (it) { picked[it.id] = true; });
    showPicks();
  }

  function clearPicks() {
    picked = Object.create(null);
    showPicks();
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

  // The items of a page after those before it: an id already listed is never listed twice.
  function joined(before, page) {
    var seen = Object.create(null);
    before.forEach(function (it) { seen[it.id] = true; });
    return before.concat(usable(page).filter(function (it) { return seen[it.id] === true ? false : (seen[it.id] = true); }));
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
        got = joined(got, res.data.items);
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

  // The list read again for the Sharing box (as read, which it is), with its rows usable
  // afterwards, as the Tours page's rows are when its list is rebuilt.
  function reload() {
    return read().then(function (r) {
      if (r === true) rowsDisabled(false);
      return r;
    });
  }

  // ---- Show more ----

  function more() {
    if (listing !== null || next === null || working) return;
    say("");
    var from = items.length;
    track(pageOf(next).then(function (res) {
      if (res.status === 401) { Dash.signedOut(); return; }
      if (!listed(res)) { say(Dash.failure(res)); return; }
      items = joined(items, res.data.items);
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
    if (working || anyOpen()) return;
    var opened = question.open({
      title: TEXT.askBefore + titleOf(it) + TEXT.askAfter,
      focus: "delete-keep",
      // Back to the item's More when it is still listed, else to the page's heading.
      back: function () { return moreOf[it.id]; },
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

  // Sends the delete, again after a pause while it answers cleanup_pending, at most MAX_TRIES
  // times; the last answer. Once one answered cleanup_pending the item is deleted for everyone,
  // so a later resend that answers anything but 204 or a not_found, or none, gives that
  // cleanup_pending instead, as the Storage page does: the page never says it was not deleted.
  function run(id) {
    var tries = 0;
    var pending = null;
    function send() {
      tries++;
      return Dash.api("DELETE", ITEM + encodeURIComponent(id)).then(function (res) {
        if (cleaning(res)) {
          pending = res;
          return tries < MAX_TRIES ? pause(PAUSES_MS[tries - 1]).then(send) : res;
        }
        return pending !== null && res.status !== 204 && !notFound(res) ? pending : res;
      }, function (err) {
        if (pending !== null) return pending;
        throw err;
      });
    }
    return send();
  }

  // A 404 with the error not_found from this app: the item is gone, or never was this workspace's.
  // A 404 without it (from something in between, say) says nothing about the item.
  function notFound(res) {
    return res !== null && res.status === 404 && Dash.errorOf(res) === "not_found";
  }

  // Whether the item is gone (null: no answer came): deleted now (with or without files
  // left to remove), or already gone, which only a 404 with the error not_found from this app
  // says (as for itemGone); any other 404 is a failure.
  function done(res) {
    return res !== null && (res.status === 204 || notFound(res) || cleaning(res));
  }

  // No answer came to a delete: the item itself decides, not the list (newer items can push a
  // listed one off the pages shown). Resolves to { gone, res }: gone only when it answers the
  // API's own 404 not_found (deleted, or never there), not a 404 from something in between;
  // res is that answer (null when none came), for the sentence of a failure (429 has its own).
  // Null when the visitor was sent to sign in. The id matched ITEM_ID.
  function itemGone(id) {
    return Dash.api("GET", ITEM + encodeURIComponent(id)).then(function (res) {
      if (res.status === 401) { Dash.signedOut(); return null; }
      return { gone: res.status === 404 && Dash.errorOf(res) === "not_found", res: res };
    }, function () { return { gone: false, res: null }; });
  }

  // One item deleted, the same way however the delete was asked for: sent again while it
  // answers cleanup_pending (run), done on 204, 404 and cleanup_pending (done), and, when no
  // answer came, decided by the item itself (itemGone). Resolves to { ok, res }: res is the
  // answer that tells a failure (the delete's, or the item's when the delete got none). Null
  // when the visitor was sent to sign in.
  function deleteOne(id) {
    return run(id).then(function (res) {
      if (res.status === 401) { Dash.signedOut(); return null; }
      return { ok: done(res), res: res };
    }, function () {
      return itemGone(id).then(function (g) {
        if (g === null) return null;
        return { ok: g.gone, res: g.res };
      });
    });
  }

  // ---- Deleting the selected items ----

  // One of the page's items, or how many of them, as the line under the heading counts them.
  function countOf(n) {
    return n === 1 ? TEXT.oneItem : n + TEXT.items;
  }

  // Delete selected: the question, about the items selected now; no title of theirs is in it.
  function askBulk() {
    if (working || anyOpen()) return;
    var ids = pickedIds();
    if (ids.length === 0) return;
    var one = ids.length === 1;
    $("bulk-text").textContent = one ? TEXT.askOne : TEXT.askSome;
    $("bulk-keep").textContent = one ? TEXT.keepIt : TEXT.keepThem;
    $("bulk-go").textContent = TEXT.bulkBefore + countOf(ids.length);
    showProgress("");
    var opened = bulkQ.open({
      title: TEXT.bulkBefore + countOf(ids.length) + TEXT.bulkAfter,
      focus: "bulk-keep",
      // Back to Delete selected while something is still selected, else to the page's heading.
      back: function () { return pickedIds().length > 0 ? $("pick-delete") : null; },
      fallback: "h-page",
      onClose: function () { bulk = null; },
    });
    if (opened) bulk = { ids: ids };
  }

  // The progress line is always in the open question, empty until the run starts, so its first words are announced.
  function showProgress(text) {
    $("bulk-progress").textContent = text;
  }

  // The items one after another, never two at once, each as Delete in More deletes it; the
  // first one refused, or failed for good, stops the run. However it ends, the list is read
  // again before the page says anything: the items deleted are no longer selected, the others
  // stay selected while the list still has them, and one sentence says how it went.
  function runBulk() {
    if (bulk === null || working) return;
    var ids = bulk.ids.slice();
    var n = ids.length;
    var deleted = [];
    // The answer of the item that stopped the run, or null when none did.
    var stopped = null;
    working = true;
    say("");
    bulkQ.busy(true, "bulk-go", TEXT.deleting);
    rowsDisabled(true);
    function next(i) {
      if (i >= n) return Promise.resolve(true);
      showProgress(TEXT.progressBefore + (i + 1) + TEXT.progressOf + n + TEXT.progressAfter);
      return deleteOne(ids[i]).then(function (got) {
        if (got === null) return null;
        if (!got.ok) {
          stopped = { res: got.res };
          return true;
        }
        deleted.push(ids[i]);
        return next(i + 1);
      });
    }
    next(0).then(function (end) {
      if (end === null) return;
      deleted.forEach(function (id) { delete picked[id]; });
      return read().then(function (r) {
        if (r === false) return;
        working = false;
        bulkQ.busy(false, "bulk-go");
        rowsDisabled(false);
        showPicks();
        var d = deleted.length;
        var text = d === n ? countOf(d) + TEXT.deletedAfter : d === 0 ? (n === 1 ? TEXT.oneNot : TEXT.noneDeleted) : d + TEXT.progressOf + countOf(n) + TEXT.restAfter;
        if (stopped !== null) text += " " + Dash.failure(stopped.res);
        // Only a run that deleted something made a change the page could not show.
        if (r !== true && d > 0) text += " " + TEXT.notReloaded;
        bulkQ.close(true);
        say(text, stopped === null && r === true);
      });
    });
  }

${shareScript(p.sharing)}
  function startPage() {
${shareListeners(p.sharing)}    [${shareRepeatIds(p.sharing)}, "delete-keep", "delete-go", "pick-clear", "pick-delete", "bulk-keep", "bulk-go"].forEach(function (id) { noRepeat($(id)); });
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
      deleteOne(it.id).then(function (got) {
        if (got === null) return;
        if (got.ok) question.close(false);
        // However the delete ended, the list is read again before the page says anything;
        // the rows' buttons stay disabled until then. A delete that worked clears the selection
        // once the list is read again; one that failed leaves it as the person made it.
        return read().then(function (r) {
          if (r === false) return;
          working = false;
          question.busy(false, "delete-go");
          rowsDisabled(false);
          if (got.ok && r === true) clearPicks();
          // Deleted, but the list as last shown still has it: it leaves the selection all the same.
          else if (got.ok) {
            delete picked[it.id];
            showPicks();
          }
          if (got.ok) {
            say(r === true ? "" : TEXT.notReloaded);
            $("h-page").focus();
            return;
          }
          question.say(Dash.failure(got.res));
          $("delete-go").focus();
        });
      });
    });
    // Selecting, and deleting what is selected.
    $("media-all").addEventListener("change", function () { pickAll($("media-all").checked); });
    $("pick-clear").addEventListener("click", function () {
      if (working) return;
      clearPicks();
      $("media-all").focus();
    });
    $("pick-delete").addEventListener("click", askBulk);
    $("bulk-keep").addEventListener("click", function () { bulkQ.dismiss(); });
    $("bulk-go").addEventListener("click", runBulk);
    // A click outside the open menu closes it.
    document.body.addEventListener("click", function (ev) {
      if (openMenu !== null && !openMenu.wrap.contains(ev.target)) closeMenu(false);
    });
  }

  startPage();
  Dash.start(function (who) {
    workspace = who.workspace;
    myEmail = who.email;
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
