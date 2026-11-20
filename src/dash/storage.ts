// The Storage page of the dashboard, /storage, as in the approved mockups 5 and 6, in the
// form this version has (tours only; images and short clips come with a later plan): the
// workspace's name, the allowance bar with the line "<used> of <allowance> used · N tours"
// (no bar, only the total, when no allowance is set), the over-allowance warning, what
// takes the room (the pictures in tours, logos, uploads in progress, as GET /api/v1/usage
// counts them), and the largest tours (GET /api/v1/usage/largest) with a small bar each and
// a Delete button. Its body is fixed text; its script, /dash/storage.js, fills it through
// textContent, so a title can never become markup.
//
// The bars are sized through the CSSOM (element.style.width), which the content security
// policy allows, as the account page sizes its bar; no style attribute is ever written.
//
// Delete asks the Tours page's question, with its sentences, in a question of this page's
// own (the two should become one shared question once both pages have merged). While it is
// open the rest of the page is inert, Escape and Tab are handled for the whole document, a
// click on the backdrop closes it, and its buttons are disabled while the request runs.
// After any outcome (deleted, refused, failed, no answer) the page reads the usage and the
// largest tours again, so it never shows a size or a tour that is no longer true; when they
// cannot be read, it shows none of them and says so.
import { dashHtml } from "./shell.ts";

const STORAGE_MAIN = `  <div id="storage-page">
  <h1 id="h-page" tabindex="-1">Storage</h1>
  <section id="storage" aria-labelledby="h-page" hidden>
    <p class="sub" id="storage-workspace"></p>
    <p class="message" id="storage-message" role="status" aria-live="polite"></p>
    <div class="card">
      <div class="meter" id="storage-bar" aria-hidden="true" hidden><div class="meter-fill" id="storage-fill"></div></div>
      <p class="total" id="storage-total"></p>
      <p class="over-box" id="storage-over" hidden>You are over your storage allowance. New uploads are refused until you delete tours or get more room.</p>
      <p class="hint" id="storage-online" hidden>Tours that are already online are not affected.</p>
      <p class="hint" id="storage-counts">Tours and their pictures count. Deleting a tour frees its space within a few minutes.</p>
    </div>
    <div class="card">
      <h2 class="card-title" id="h-room">What takes the room</h2>
      <div class="room"><span>Tours</span><span class="r" id="room-tours"></span></div>
      <div class="room"><span>Logos</span><span class="r" id="room-logos"></span></div>
      <div class="room"><span>Uploads in progress</span><span class="r" id="room-uploads"></span></div>
    </div>
    <div class="card" id="largest" hidden>
      <h2 class="card-title" id="h-largest">Largest tours</h2>
      <table class="largest" aria-labelledby="h-largest">
        <thead><tr><th scope="col">Tour</th><th scope="col" class="mini-cell"></th><th scope="col" class="n">Size</th><th scope="col"></th></tr></thead>
        <tbody id="largest-rows"></tbody>
      </table>
      <p class="hint"><span id="largest-all"></span><a href="/tours">Tours page</a>.</p>
    </div>
  </section>
  </div>
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

/** The Storage page: the shell with the page's body and its own script. */
export const STORAGE_HTML = dashHtml({ title: "Storage", active: "storage", main: STORAGE_MAIN, script: "/dash/storage.js" });

export const STORAGE_JS = `(function () {
  "use strict";
  var TEXT = {
    of: " of ",
    used: " used",
    dot: " · ",
    oneTour: "1 tour",
    tours: " tours",
    allBefore: "All ",
    allAfter: " tours are on the ",
    oneOnTours: "Your tour is on the ",
    remove: "Delete",
    askBefore: 'Delete "',
    askAfter: '"?',
    deleting: "Deleting…",
    busy: "This tour is being published. Try again when that is done.",
  };
  // A delete is driven by at most this many requests.
  var MAX_ROUNDS = 1000;
  var TOUR_ID = /^tour_[0-9a-f]{24}$/;

  var $ = function (id) { return document.getElementById(id); };
  // The tour the question is about, and whether its delete is running.
  var asking = null;
  var working = false;
  // Each listed tour's Delete button, by tour id, to give the focus back after the question.
  var deleteOf = {};

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function isSize(n) {
    return typeof n === "number" && isFinite(n) && n >= 0;
  }

  // A share of a bar, in percent, from 0 to 100 with at most two decimals.
  function pct(share) {
    return Math.round(Math.max(0, Math.min(100, share)) * 100) / 100;
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

  // ---- What the page shows ----

  function usageOk(u) {
    if (u === null || typeof u !== "object" || !isSize(u.used_bytes) || !isSize(u.tours)) return false;
    if (u.allowance_bytes !== null && !isSize(u.allowance_bytes)) return false;
    var c = u.counted;
    return c !== null && typeof c === "object" && isSize(c.pictures) && isSize(c.logos) && isSize(c.uploads_in_progress);
  }

  function row(t, i, max) {
    var tr = el("tr");
    var titleId = "largest-" + i;
    var name = el("td", "t", String(t.title));
    name.setAttribute("id", titleId);
    tr.appendChild(name);
    var mini = el("td", "mini-cell");
    mini.setAttribute("aria-hidden", "true");
    var track = el("div", "mini");
    var fill = el("div", "mini-fill");
    var share = max > 0 ? (t.bytes / max) * 100 : 0;
    fill.style.width = pct(share) + "%";
    track.appendChild(fill);
    mini.appendChild(track);
    tr.appendChild(mini);
    tr.appendChild(el("td", "n size", Dash.formatBytes(t.bytes)));
    var cell = el("td", "del");
    var btn = el("button", "btn sm danger", TEXT.remove);
    btn.type = "button";
    btn.setAttribute("aria-describedby", titleId);
    btn.addEventListener("click", function () { ask(t, btn); });
    cell.appendChild(btn);
    tr.appendChild(cell);
    deleteOf[t.id] = btn;
    return tr;
  }

  function show(u, tours, workspace) {
    var limit = u.allowance_bytes;
    var over = limit !== null && u.over === true;
    $("storage-workspace").textContent = workspace;
    $("storage-total").textContent = Dash.formatBytes(u.used_bytes) + (limit !== null ? TEXT.of + Dash.formatBytes(limit) : "") + TEXT.used + TEXT.dot + (u.tours === 1 ? TEXT.oneTour : u.tours + TEXT.tours);
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
    $("room-logos").textContent = Dash.formatBytes(u.counted.logos);
    $("room-uploads").textContent = Dash.formatBytes(u.counted.uploads_in_progress);

    var list = tours.filter(function (t) { return t !== null && typeof t === "object" && typeof t.id === "string" && TOUR_ID.test(t.id) && isSize(t.bytes); });
    var max = 0;
    list.forEach(function (t) { if (t.bytes > max) max = t.bytes; });
    deleteOf = {};
    var rows = $("largest-rows");
    rows.textContent = "";
    for (var i = 0; i < list.length; i++) rows.appendChild(row(list[i], i, max));
    $("largest-all").textContent = u.tours === 1 ? TEXT.oneOnTours : TEXT.allBefore + u.tours + TEXT.allAfter;
    $("largest").hidden = list.length === 0;
    $("dash-load").textContent = "";
    $("storage").hidden = false;
  }

  var workspace = "";

  // The usage and the largest tours, read again every time. Resolves to true when shown,
  // false when the visitor was sent to sign in, or the answer that failed (null for no answer),
  // in which case nothing of the old numbers stays on the page.
  function refresh() {
    return Promise.all([Dash.api("GET", "/api/v1/usage"), Dash.api("GET", "/api/v1/usage/largest")]).then(function (got) {
      if (got[0].status === 401 || got[1].status === 401) { Dash.signedOut(); return false; }
      var usage = got[0];
      var largest = got[1];
      if (usage.status !== 200 || !usageOk(usage.data)) return usage;
      if (largest.status !== 200 || largest.data === null || typeof largest.data !== "object" || !Array.isArray(largest.data.tours)) return largest;
      show(usage.data, largest.data.tours, workspace);
      return true;
    }).then(null, function () { return null; }).then(function (r) {
      if (r !== true && r !== false) {
        $("storage").hidden = true;
        $("dash-load").textContent = Dash.failure(r);
      }
      return r;
    });
  }

  // ---- The question before a delete ----

  // While the question is open, everything but it is inert: the bar, the page and its message.
  function setInert(on) {
    var parts = [$("storage-page"), $("dash-load")];
    var kids = document.body.children;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].tagName && String(kids[i].tagName).toLowerCase() === "header") parts.push(kids[i]);
    }
    parts.forEach(function (p) {
      if (on) p.setAttribute("inert", "");
      else p.removeAttribute("inert");
    });
  }

  function ask(t) {
    if (working || asking !== null) return;
    asking = { t: t };
    $("delete-title").textContent = TEXT.askBefore + String(t.title) + TEXT.askAfter;
    $("delete-message").textContent = "";
    $("delete-dialog").hidden = false;
    setInert(true);
    $("delete-keep").focus();
  }

  // Closes the question; the focus goes back to the tour's Delete when it is still listed,
  // else (or when toHeading) to the page's heading.
  function closeAsk(toHeading) {
    if (asking === null || working) return;
    var id = asking.t.id;
    asking = null;
    $("delete-dialog").hidden = true;
    $("delete-message").textContent = "";
    setInert(false);
    var back = deleteOf[id];
    if (toHeading !== true && back !== undefined && !$("storage").hidden) back.focus();
    else $("h-page").focus();
  }

  // Calls the delete until it is no longer in progress; the last answer.
  function run(id) {
    var rounds = 0;
    function next() {
      rounds++;
      return Dash.api("DELETE", "/api/v1/tours/" + encodeURIComponent(id)).then(function (res) {
        return res.status === 202 && rounds < MAX_ROUNDS ? next() : res;
      });
    }
    return next();
  }

  // What a delete's last answer means: "" when the tour is gone (or was already), the
  // sentence to show otherwise, or "out" when the session is gone.
  function outcomeOf(res) {
    if (res.status === 401) return "out";
    if (res.status === 200 || res.status === 404) return "";
    if (res.status === 409 && Dash.errorOf(res) === "publish_busy") return TEXT.busy;
    return Dash.failure(res);
  }

  function startPage() {
    var dialog = $("delete-dialog");
    var keep = $("delete-keep");
    var go = $("delete-go");
    keep.addEventListener("click", function () { closeAsk(false); });
    go.addEventListener("click", function () {
      if (asking === null || working) return;
      var t = asking.t;
      working = true;
      $("delete-message").textContent = "";
      keep.disabled = true;
      go.disabled = true;
      busy(go, true, TEXT.deleting);
      run(t.id).then(outcomeOf, function () { return Dash.TEXT.failed; }).then(function (outcome) {
        if (outcome === "out") { Dash.signedOut(); return; }
        // Whatever happened, the page reads the numbers again before it says anything.
        return refresh().then(function (r) {
          if (r === false) return;
          working = false;
          keep.disabled = false;
          go.disabled = false;
          busy(go, false);
          if (outcome === "") { closeAsk(true); return; }
          $("delete-message").textContent = outcome;
          go.focus();
        });
      });
    });
    // A click on the backdrop, outside the question, closes it.
    dialog.addEventListener("click", function (ev) {
      if (ev.target === dialog) closeAsk(false);
    });
    // For the whole document while the question is open: Escape closes it; Tab and
    // Shift+Tab stay on its two buttons (on its title while the delete runs).
    document.addEventListener("keydown", function (ev) {
      if (asking === null) return;
      if (ev.key === "Escape") { ev.preventDefault(); closeAsk(false); return; }
      if (ev.key !== "Tab") return;
      ev.preventDefault();
      if (working) { $("delete-title").focus(); return; }
      var at = document.activeElement;
      if (ev.shiftKey) (at === go ? keep : go).focus();
      else (at === keep ? go : keep).focus();
    });
  }

  startPage();
  Dash.start(function (who) {
    workspace = who.workspace;
    return refresh();
  });
})();
`;
