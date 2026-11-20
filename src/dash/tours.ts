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
import { dashHtml } from "./shell.ts";

const TOURS_MAIN = `  <div id="tours-page">
  <h1 id="h-page" tabindex="-1">Tours</h1>
  <section id="tours" aria-labelledby="h-page" hidden>
    <p class="sub"><span id="tours-count"></span><span class="wide-only" id="tours-in"></span><span id="tours-used"></span></p>
    <p class="message" id="tours-message" role="status" aria-live="polite" hidden></p>
    <div class="card" id="tours-list" hidden>
      <table class="tours">
        <thead><tr><th scope="col">Tour</th><th scope="col">Status</th><th scope="col" class="n">Size</th><th scope="col" class="n">Changed</th><th scope="col"><span class="vh">Actions</span></th></tr></thead>
        <tbody id="tours-rows"></tbody>
      </table>
    </div>
    <div class="card" id="tours-empty" hidden>
      <div class="empty">
        <p class="empty-title">No tours yet</p>
        <p>Record a tour in Mythicshot and choose Publish. It shows up here with a link to share.</p>
      </div>
    </div>
    <p class="hint" id="tours-hint" hidden>"Changes waiting" means Mythicshot uploaded a newer version that visitors do not see yet. "More" holds: Publish changes, Unpublish, Delete.</p>
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
  };
  // A publish, unpublish or delete is driven by at most this many requests.
  var MAX_ROUNDS = 1000;
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
      entry.addEventListener("click", function () {
        closeMenu(true);
        if (item.kind === "delete") ask(t);
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

  function row(t, i) {
    var tr = el("tr");
    var titleId = "tour-" + i;
    var published = t.status === "published";
    var waiting = published && t.unpublished_changes === true;
    var link = linkOf(t);
    var size = typeof t.bytes === "number" ? Dash.formatBytes(t.bytes) : "";
    var when = Dash.dateOf(t.updated_at);
    var steps = t.steps === 1 ? TEXT.oneStep : (typeof t.steps === "number" ? t.steps : 0) + TEXT.steps;

    var what = el("td", "what");
    var name = el("div", "t", String(t.title));
    name.setAttribute("id", titleId);
    what.appendChild(name);
    var d = el("div", "d");
    d.appendChild(el("span", "", steps));
    var shown = el("span", "wide-only", TEXT.dot + (link !== null ? shortOf(link) : TEXT.noLink));
    if (link !== null) shown.setAttribute("title", link);
    d.appendChild(shown);
    d.appendChild(el("span", "narrow-only", TEXT.dot + size + TEXT.dot + when));
    what.appendChild(d);
    tr.appendChild(what);

    var status = el("td", "status");
    status.appendChild(published ? el("span", "tag ok", TEXT.published) : el("span", "tag", TEXT.notPublished));
    if (waiting) status.appendChild(el("span", "tag warn", TEXT.waiting));
    tr.appendChild(status);
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
    if (working) return;
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

  function startPage() {
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
    return load().then(function (r) {
      if (r !== true && r !== false) $("dash-load").textContent = Dash.failure(r);
    });
  });
})();
`;
