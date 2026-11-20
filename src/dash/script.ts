// The dashboard's shared script, served as /dash/dash.js before each page's own script
// (see src/dash/shell.ts for how a page uses it). It defines one global, `Dash`, and
// does nothing until a page calls Dash.start.
//
// Dash.start asks GET /api/v1/session once. Without a session the visitor is sent to
// /signin. With one it keeps the anti-forgery value in one variable of this function, puts
// the username in the bar and shows the Admin tab for an admin, all through textContent
// and `hidden`, then hands the page { username, admin, workspace }. Every request goes
// through Dash.api: to this site only, with the browser's session for this address, no
// referrer, and the X-Csrf-Token header on every change, as the account page sends it.
// Nothing here writes to storage, to a cookie or to an address.
export const DASH_JS = `var Dash = (function () {
  "use strict";
  var TEXT = {
    tooMany: "Too many requests. Wait a few minutes and try again.",
    failed: "Something went wrong. Try again in a moment.",
    account: "Account",
    oneByte: "1 byte",
    bytes: " bytes",
  };
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var csrf = "";

  var $ = function (id) { return document.getElementById(id); };

  // Every request goes through here. A change made with the session carries the
  // anti-forgery value from GET /api/v1/session. A path must be one absolute path of this
  // site; anything else (another origin, a protocol-relative or relative path) is refused
  // before any request.
  function api(method, path, body) {
    if (typeof path !== "string" || !/^\\/(?![\\/\\\\])/.test(path)) throw new TypeError("path");
    var headers = {};
    var init = { method: method, headers: headers, credentials: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    if (method !== "GET" && method !== "HEAD") headers["X-Csrf-Token"] = csrf;
    return fetch(path, init).then(function (r) {
      return r.text().then(function (t) {
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
        return { status: r.status, data: data };
      });
    });
  }

  function errorOf(res) {
    return res !== null && typeof res === "object" && res.data !== null && typeof res.data === "object" && typeof res.data.error === "string" ? res.data.error : "";
  }

  // The approved sentence for a request that did not do what was asked.
  function failure(res) {
    return res !== null && typeof res === "object" && res.status === 429 ? TEXT.tooMany : TEXT.failed;
  }

  // Sizes as the owner chose them: 1024 to the next unit, as the server counts, at most
  // one decimal and no trailing .0 (1.2 GB, 5 GB, 512 KB). The server's formatBytes
  // (src/usage.ts) and the account page write them the same way; all three are held to
  // the one table in test/sizes.ts.
  function formatBytes(n) {
    if (n < 1024) return n === 1 ? TEXT.oneByte : n + TEXT.bytes;
    var units = ["KB", "MB", "GB"];
    var value = n;
    for (var i = 0; i < units.length; i++) {
      value /= 1024;
      var rounded = Math.round(value * 10) / 10;
      if (rounded < 1024 || i === units.length - 1) return String(rounded) + " " + units[i];
    }
    return n + TEXT.bytes;
  }

  // Day and short month, with the year when it is not this year, as the account page writes it.
  function dateOf(ms) {
    if (typeof ms !== "number" || !isFinite(ms)) return "";
    var d = new Date(ms);
    var text = d.getDate() + " " + MONTHS[d.getMonth()];
    return d.getFullYear() === new Date().getFullYear() ? text : text + " " + d.getFullYear();
  }

  function signedOut() {
    location.replace("/signin");
  }

  // Who is signed in, then the page. A visitor who is not signed in goes to /signin.
  function start(page) {
    var load = $("dash-load");
    api("GET", "/api/v1/session").then(function (res) {
      if (res.status === 401) { signedOut(); return; }
      var d = res.data;
      if (res.status !== 200 || d === null || typeof d !== "object" || typeof d.csrf !== "string" || d.account === null || typeof d.account !== "object" || d.workspace === null || typeof d.workspace !== "object") {
        load.textContent = failure(res);
        return;
      }
      csrf = d.csrf;
      var who = d.account;
      // Without a username the bar says Account, never the email address: people record their screens.
      var name = typeof who.username === "string" && who.username !== "" ? who.username : TEXT.account;
      $("dash-user").textContent = name;
      var admin = who.admin === true;
      if (admin) $("tab-admin").hidden = false;
      return page({ username: name, admin: admin, workspace: typeof d.workspace.name === "string" ? d.workspace.name : "" });
    }).then(null, function () {
      load.textContent = TEXT.failed;
    });
  }

  return { api: api, errorOf: errorOf, failure: failure, formatBytes: formatBytes, dateOf: dateOf, signedOut: signedOut, start: start, TEXT: TEXT };
})();
`;
