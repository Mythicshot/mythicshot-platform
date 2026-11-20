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
// It goes into an href only when it is https, of this page's own origin, or http on a
// local name; otherwise the tour shows no link and no Copy link or Open.
//
// Every change goes through the existing routes: publish (driven until it is live),
// unpublish and delete (each called again while it answers 202), with the session cookie
// and the anti-forgery header Dash.api adds. Unpublish asks nothing; delete asks first.
import { dashHtml } from "./shell.ts";

const TOURS_MAIN = `  <h1 id="h-page" tabindex="-1">Tours</h1>
  <section id="tours" aria-labelledby="h-page" hidden>
    <p class="sub"><span id="tours-count"></span><span class="wide-only" id="tours-in"></span><span id="tours-used"></span></p>
    <p class="message" id="tours-message" role="status" aria-live="polite"></p>
    <div class="card" id="tours-list" hidden>
      <table class="tours">
        <thead><tr><th scope="col">Tour</th><th scope="col">Status</th><th scope="col" class="n">Size</th><th scope="col" class="n">Changed</th><th scope="col"></th></tr></thead>
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
  <div class="backdrop" id="delete-dialog" hidden>
    <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-title" aria-describedby="delete-text">
      <h2 id="delete-title" tabindex="-1"></h2>
      <p class="sub" id="delete-text">Its link stops working for everyone and its pictures are removed. This cannot be undone. The recording on your computer is not touched.</p>
      <p class="message" id="delete-message" role="status" aria-live="polite"></p>
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
  };
  // A publish, unpublish or delete is driven by at most this many requests.
  var MAX_ROUNDS = 1000;
  // How long Copy link reads Copied.
  var COPIED_MS = 2000;
  var TOUR_ID = /^tour_[0-9a-f]{24}$/;
  var TOUR_PATH = /^\\/t\\/[a-z0-9]{1,64}$/;

  var $ = function (id) { return document.getElementById(id); };
  var workspace = "";
  // The tours address's origin, from GET /api/v1/me; null until it is known, or when it cannot be used.
  var base = null;
  // The menu that is open, the question that is asked, and whether a change is running.
  var openMenu = null;
  var asking = null;
  var working = false;
  // Each row's first control, by tour id, to give focus back after the list is rebuilt.
  var firstOf = {};

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function say(text) {
    $("tours-message").textContent = text;
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

  // A name the server writes with http (src/hosts.ts, originOf): this computer's own.
  function localName(host) {
    var name = host.replace(/:[0-9]+$/, "");
    return name === "localhost" || /\\.localhost$/.test(name) || name === "127.0.0.1";
  }

  // The origin public links start with: this page's own in one-address mode, else the tours address's.
  function baseOf(me) {
    if (me === null || typeof me !== "object") return null;
    var a = me.addresses;
    if (a === undefined) return location.origin;
    if (a === null || typeof a !== "object" || typeof a.tours !== "string") return null;
    var host = a.tours.toLowerCase();
    if (!/^(?:[a-z0-9.-]+|\\[[0-9a-f:.]+\\])(?::[0-9]{1,5})?$/.test(host)) return null;
    return (localName(host) ? "http:" : "https:") + "//" + host;
  }

  // Only an https link, one of this page's own origin, or http on a local name goes into an href.
  function safe(link) {
    if (/^https:\\/\\/[^/?#@\\\\]+\\//.test(link)) return true;
    if (link.indexOf(location.origin + "/") === 0) return true;
    var m = /^http:\\/\\/([^/?#@\\\\]+)\\//.exec(link);
    return m !== null && localName(m[1]);
  }

  function linkOf(t) {
    if (base === null || t.status !== "published" || typeof t.url !== "string" || !TOUR_PATH.test(t.url)) return null;
    var link = base + t.url;
    return safe(link) ? link : null;
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

  function moreMenu(t, i, items, titleId, controls) {
    var wrap = el("div", "more");
    var btn = el("button", "btn sm quiet", TEXT.more);
    btn.type = "button";
    btn.setAttribute("aria-haspopup", "true");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", "menu-" + i);
    btn.setAttribute("aria-describedby", titleId);
    controls.push(btn);
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
        if (item.kind === "delete") ask(t, btn);
        else change(t, item.kind, btn, controls);
      });
      menu.appendChild(entry);
      m.entries.push(entry);
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
    d.appendChild(el("span", "wide-only", TEXT.dot + (link !== null ? link.replace(/^https?:\\/\\//, "") : TEXT.noLink)));
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
    var controls = [];
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
      controls.push(copy);
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
      pub.addEventListener("click", function () { change(t, "publish", pub, controls); });
      acts.appendChild(pub);
      controls.push(pub);
    }
    var items = [];
    if (waiting) items.push({ text: TEXT.publishChanges, kind: "publish" });
    if (published) items.push({ text: TEXT.unpublish, kind: "unpublish" });
    items.push({ text: TEXT.remove, kind: "delete", danger: true });
    acts.appendChild(moreMenu(t, i, items, titleId, controls));
    cell.appendChild(acts);
    tr.appendChild(cell);
    firstOf[t.id] = controls[0];
    return tr;
  }

  function show(tours, used) {
    closeMenu(false);
    firstOf = {};
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

  // Whether the change is done: published, unpublished, or deleted (or already gone).
  function done(kind, res) {
    if (kind === "publish") return res.status === 200;
    if (kind === "unpublish") return res.status === 204;
    return res.status === 200 || res.status === 404;
  }

  function change(t, kind, btn, controls) {
    if (working || btn.disabled) return;
    working = true;
    say("");
    controls.forEach(function (c) { c.disabled = true; });
    busy(btn, true, kind === "publish" ? TEXT.publishing : TEXT.unpublishing);
    function back(text) {
      working = false;
      busy(btn, false);
      controls.forEach(function (c) { c.disabled = false; });
      say(text);
      btn.focus();
    }
    run(t.id, kind).then(function (res) {
      if (res.status === 401) { Dash.signedOut(); return; }
      if (!done(kind, res)) { back(Dash.failure(res)); return; }
      return reload().then(function (r) {
        if (r === false) return;
        if (r !== true) { back(Dash.failure(r)); return; }
        working = false;
        // The focus goes to the tour's row as it is now.
        var first = firstOf[t.id];
        if (first !== undefined) first.focus();
        else $("h-page").focus();
      });
    }).then(null, function () { back(Dash.TEXT.failed); });
  }

  // ---- The question before a delete ----

  function ask(t, opener) {
    if (working) return;
    asking = { t: t, opener: opener };
    $("delete-title").textContent = TEXT.askBefore + String(t.title) + TEXT.askAfter;
    $("delete-message").textContent = "";
    $("delete-dialog").hidden = false;
    $("delete-keep").focus();
  }

  function closeAsk() {
    if (asking === null || working) return;
    var opener = asking.opener;
    asking = null;
    $("delete-dialog").hidden = true;
    opener.focus();
  }

  function startPage() {
    var keep = $("delete-keep");
    var go = $("delete-go");
    keep.addEventListener("click", closeAsk);
    go.addEventListener("click", function () {
      if (asking === null || working) return;
      var t = asking.t;
      working = true;
      $("delete-message").textContent = "";
      keep.disabled = true;
      busy(go, true, TEXT.deleting);
      go.disabled = true;
      function back(text) {
        working = false;
        keep.disabled = false;
        go.disabled = false;
        busy(go, false);
        $("delete-message").textContent = text;
        go.focus();
      }
      run(t.id, "delete").then(function (res) {
        if (res.status === 401) { Dash.signedOut(); return; }
        if (!done("delete", res)) { back(Dash.failure(res)); return; }
        keep.disabled = false;
        go.disabled = false;
        busy(go, false);
        asking = null;
        $("delete-dialog").hidden = true;
        return reload().then(function (r) {
          working = false;
          if (r === false) return;
          // The tour is gone; when the list cannot be read again, the page says so.
          if (r !== true) say(Dash.failure(r));
          $("h-page").focus();
        });
      }).then(null, function () { back(Dash.TEXT.failed); });
    });
    // Escape closes the question; Tab and Shift+Tab stay on its two buttons.
    $("delete-dialog").addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") { ev.preventDefault(); closeAsk(); return; }
      if (ev.key !== "Tab") return;
      if (ev.shiftKey && document.activeElement === keep) { ev.preventDefault(); go.focus(); }
      else if (!ev.shiftKey && document.activeElement === go) { ev.preventDefault(); keep.focus(); }
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
