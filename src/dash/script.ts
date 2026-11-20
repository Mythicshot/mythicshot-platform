// The dashboard's shared script, served as /dash/dash.js before each page's own script
// (see src/dash/shell.ts for how a page uses it). It defines one global, `Dash`, and
// does nothing until a page calls Dash.start.
//
// Dash.start asks GET /api/v1/session once. Without a session the visitor is sent to
// /signin. With one it keeps the anti-forgery value in one variable of this function, puts
// the username in the bar and shows the Admin tab for an admin, all through textContent
// and `hidden`, then hands the page { username, admin, workspace } and, for the Account
// page, { named, email, sessionId, emailChange } (whether the account has a username, its
// address, this session's id, and whether the address can be changed here). A page that
// has something to say to a visitor who is not signed in passes a second function, which is
// called instead of sending the visitor to /signin. Every request goes
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
  // (src/usage.ts) writes them the same way; both are held to the one table in
  // test/sizes.ts.
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

  // ---- A question asked in the page ----
  //
  // Dash.question(o) is the one way a page asks a question in itself (the Tours and Storage
  // pages' delete, the Admin page's storage question, the Account page's email boxes). o names, by
  // id: backdrop (the dimmed area holding it), box (the question itself, given o.role:
  // "alertdialog" or "dialog"), title (its heading, which takes the focus while a request
  // runs), message (its message line, optional), behind (what is made inert and hidden from
  // screen readers while it is open; a part no longer in the page is left out), fields and
  // buttons (its controls, in Tab order), and lock ("readonly" or "disabled": what a field
  // becomes while a request runs). It answers:
  //   open({ title, focus, back, fallback, onClose }): shows it, with the title's text when
  //     given and the focus on \`focus\` (else the first control); false when it is open
  //     already or its backdrop is not in the page. back() is asked, when it closes, for the
  //     element to give the focus back to, looked up then (a list may have been rebuilt);
  //     when it gives none, the focus goes to \`fallback\`. onClose runs as it closes.
  //   close(refocus): closes it now, also while a request runs.
  //   dismiss(): Escape, a click on the backdrop and the page's own Cancel; nothing while a
  //     request runs.
  //   say(text): the message line, hidden while it has nothing to say.
  //   busy(on, button, label): a request runs (or no longer): every button disabled, every
  //     field locked, and \`button\` showing \`label\` and aria-busy.
  //   isOpen(), isWorking().
  // While it is open, Escape and Tab are handled for the whole document: Tab and Shift+Tab
  // go round its enabled controls, and stay on its title while a request runs.
  function question(o) {
    var fields = o.fields || [];
    var buttons = o.buttons || [];
    var lock = o.lock === "disabled" ? "disabled" : "readonly";
    var isOpen = false;
    var working = false;
    var back = null;
    var fallback = null;
    var onClose = null;

    function each(ids, fn) {
      ids.forEach(function (id) {
        var e = $(id);
        if (e !== null) fn(e);
      });
    }

    function setBehind(on) {
      each(o.behind || [], function (e) {
        if (on) {
          e.setAttribute("inert", "");
          e.setAttribute("aria-hidden", "true");
        } else {
          e.removeAttribute("inert");
          e.removeAttribute("aria-hidden");
        }
      });
    }

    function say(text) {
      var line = o.message ? $(o.message) : null;
      if (line === null) return;
      line.textContent = text;
      line.hidden = text === "";
    }

    function open(opts) {
      opts = opts || {};
      var backdrop = $(o.backdrop);
      if (isOpen || backdrop === null) return false;
      isOpen = true;
      back = typeof opts.back === "function" ? opts.back : null;
      fallback = typeof opts.fallback === "string" ? opts.fallback : null;
      onClose = typeof opts.onClose === "function" ? opts.onClose : null;
      var title = $(o.title);
      if (typeof opts.title === "string" && title !== null) title.textContent = opts.title;
      say("");
      backdrop.hidden = false;
      setBehind(true);
      var first = $(typeof opts.focus === "string" ? opts.focus : fields.concat(buttons)[0]);
      if (first !== null) first.focus();
      return true;
    }

    function close(refocus) {
      if (!isOpen) return;
      isOpen = false;
      var backdrop = $(o.backdrop);
      if (backdrop !== null) backdrop.hidden = true;
      say("");
      setBehind(false);
      var after = onClose;
      onClose = null;
      if (after !== null) after();
      if (!refocus) return;
      var target = back !== null ? back() : null;
      if (target === null || target === undefined) target = fallback !== null ? $(fallback) : null;
      if (target !== null && target !== undefined) target.focus();
    }

    function dismiss() {
      if (!working) close(true);
    }

    function busy(on, button, label) {
      working = on;
      each(buttons, function (b) { b.disabled = on; });
      each(fields, function (f) {
        if (lock === "disabled") f.disabled = on;
        else if (on) f.setAttribute("readonly", "");
        else f.removeAttribute("readonly");
      });
      var b = typeof button === "string" ? $(button) : null;
      if (b === null) return;
      if (on) {
        if (typeof label === "string") {
          b.setAttribute("data-label", b.textContent);
          b.textContent = label;
        }
        b.setAttribute("aria-busy", "true");
      } else {
        if (b.hasAttribute("data-label")) {
          b.textContent = b.getAttribute("data-label");
          b.removeAttribute("data-label");
        }
        b.removeAttribute("aria-busy");
      }
    }

    var box = $(o.box);
    if (box !== null && typeof o.role === "string") box.setAttribute("role", o.role);
    var backdrop = $(o.backdrop);
    // A click on the backdrop, outside the question itself, is the page's Cancel.
    if (backdrop !== null) backdrop.addEventListener("click", function (ev) { if (ev.target === backdrop) dismiss(); });
    document.addEventListener("keydown", function (ev) {
      if (!isOpen) return;
      if (ev.key === "Escape") {
        ev.preventDefault();
        dismiss();
        return;
      }
      if (ev.key !== "Tab") return;
      ev.preventDefault();
      var title = $(o.title);
      var list = [];
      if (!working) each(fields.concat(buttons), function (e) { if (!e.disabled) list.push(e); });
      if (list.length === 0) {
        if (title !== null) title.focus();
        return;
      }
      var n = list.length;
      var at = list.indexOf(document.activeElement);
      var next = at === -1 ? (ev.shiftKey ? n - 1 : 0) : (at + (ev.shiftKey ? n - 1 : 1)) % n;
      list[next].focus();
    });

    return {
      open: open,
      close: close,
      dismiss: dismiss,
      say: say,
      busy: busy,
      isOpen: function () { return isOpen; },
      isWorking: function () { return working; },
    };
  }

  // Who is signed in, then the page. A visitor who is not signed in goes to /signin, or to
  // the page's own whenSignedOut when it has one.
  function start(page, whenSignedOut) {
    var load = $("dash-load");
    api("GET", "/api/v1/session").then(function (res) {
      if (res.status === 401) {
        if (typeof whenSignedOut === "function") whenSignedOut();
        else signedOut();
        return;
      }
      var d = res.data;
      if (res.status !== 200 || d === null || typeof d !== "object" || typeof d.csrf !== "string" || d.account === null || typeof d.account !== "object" || d.workspace === null || typeof d.workspace !== "object") {
        load.textContent = failure(res);
        return;
      }
      csrf = d.csrf;
      var who = d.account;
      // Without a username the bar says Account, never the email address: people record their screens.
      var named = typeof who.username === "string" && who.username !== "";
      var name = named ? who.username : TEXT.account;
      $("dash-user").textContent = name;
      var admin = who.admin === true;
      if (admin) $("tab-admin").hidden = false;
      return page({
        username: name,
        admin: admin,
        workspace: typeof d.workspace.name === "string" ? d.workspace.name : "",
        named: named,
        email: typeof who.email === "string" ? who.email : "",
        sessionId: d.session !== null && typeof d.session === "object" && typeof d.session.id === "string" ? d.session.id : "",
        emailChange: d.email_change === true,
      });
    }).then(null, function () {
      load.textContent = TEXT.failed;
    });
  }

  return { api: api, errorOf: errorOf, failure: failure, formatBytes: formatBytes, dateOf: dateOf, signedOut: signedOut, start: start, question: question, TEXT: TEXT };
})();
`;
