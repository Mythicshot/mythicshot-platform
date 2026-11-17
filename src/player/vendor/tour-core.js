// tour_core.js: the rules every tour player and the editor must agree on.
// Card placement, zoom, bold text, text clean-up, safe links, numbers and colours. Mirrored in tour/core.rs and
// tour/doc.rs and checked against tests/fixtures/tour-core-cases.json.
//
// Plain ES2020 with no imports, no DOM and no globals except `TourCore`, so it can
// be inlined into a page as a classic script or loaded as a CommonJS module.
// Nothing here builds HTML: text comes back as pieces for the caller to turn into
// text nodes.
//
// In a Worker: the file has no `export` statement, so it stays valid inline. Import it
// from the Worker's ES module (`import TourCore from "./tour_core.js"`) and let the
// Worker's bundler wrap the CommonJS `module.exports` line below, or vendor a copy with
// `export default TourCore;` appended.
var TourCore = (function () {
  "use strict";

  var MARGIN = 8;
  var GAP = 12;
  var BOTTOM_INSET = 16;
  var LINK_MAX = 500;
  // A fit within this many pixels counts, so float32 and float64 callers agree on ties.
  var SLACK = 0.001;

  // Unicode White_Space, the set Rust's char::is_whitespace and str::trim use.
  function isSpace(c) {
    return (c >= 0x09 && c <= 0x0d) || c === 0x20 || c === 0x85 || c === 0xa0 || c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
  }

  // Control (Cc), as Rust's char::is_control.
  function isControl(c) {
    return c <= 0x1f || (c >= 0x7f && c <= 0x9f);
  }

  // Format (Cf): soft hyphen, bidi controls and isolates, zero-width characters, the byte order
  // mark, tags and the like. The same list as is_format in tour/doc.rs.
  var FORMAT = [
    [0x00ad, 0x00ad], [0x0600, 0x0605], [0x061c, 0x061c], [0x06dd, 0x06dd], [0x070f, 0x070f], [0x0890, 0x0891],
    [0x08e2, 0x08e2], [0x180e, 0x180e], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x206f],
    [0xfeff, 0xfeff], [0xfff9, 0xfffb], [0x110bd, 0x110bd], [0x110cd, 0x110cd], [0x13430, 0x1343f],
    [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a], [0xe0001, 0xe0001], [0xe0020, 0xe007f],
  ];
  function isFormat(c) {
    for (var i = 0; i < FORMAT.length; i++) {
      if (c >= FORMAT[i][0] && c <= FORMAT[i][1]) return true;
    }
    return false;
  }

  // The string as code points (numbers), never UTF-16 units.
  function codePoints(s) {
    return Array.from(s, function (ch) { return ch.codePointAt(0); });
  }

  // Trimmed of White_Space at both ends, as code points.
  function trimPoints(cps) {
    var a = 0, b = cps.length;
    while (a < b && isSpace(cps[a])) a++;
    while (b > a && isSpace(cps[b - 1])) b--;
    return cps.slice(a, b);
  }

  function fromPoints(cps) {
    var out = "";
    for (var i = 0; i < cps.length; i++) out += String.fromCodePoint(cps[i]);
    return out;
  }

  function finite(v) {
    return typeof v === "number" && isFinite(v);
  }

  function clamp(v, lo, hi) {
    return Math.min(Math.max(v, lo), hi);
  }

  // Where a card of cardW x cardH goes on an imgW x imgH image so it never covers
  // `avoid` ({x0,y0,x1,y1} or null) and never leaves the image. `placement` is
  // "auto", "top", "bottom", "left" or "right". Returns {x, y, side}; side
  // "docked" means under the image at full width, also when the box holds a value
  // that is not a finite number.
  function placeCard(imgW, imgH, cardW, cardH, avoid, placement) {
    if (!avoid) {
      return { x: (imgW - cardW) / 2, y: imgH - cardH - BOTTOM_INSET, side: "none" };
    }
    if (!finite(avoid.x0) || !finite(avoid.y0) || !finite(avoid.x1) || !finite(avoid.y1)) {
      return { x: 0, y: imgH, side: "docked" };
    }
    var x0 = Math.min(avoid.x0, avoid.x1), x1 = Math.max(avoid.x0, avoid.x1);
    var y0 = Math.min(avoid.y0, avoid.y1), y1 = Math.max(avoid.y0, avoid.y1);
    var order = ["bottom", "top", "right", "left"];
    if (order.indexOf(placement) >= 0) {
      order = [placement].concat(order.filter(function (s) { return s !== placement; }));
    }
    for (var i = 0; i < order.length; i++) {
      var side = order[i], x, y;
      if (side === "bottom" || side === "top") {
        x = clamp((x0 + x1) / 2 - cardW / 2, MARGIN, imgW - cardW - MARGIN);
        y = side === "bottom" ? y1 + GAP : y0 - GAP - cardH;
      } else {
        y = clamp((y0 + y1) / 2 - cardH / 2, MARGIN, imgH - cardH - MARGIN);
        x = side === "right" ? x1 + GAP : x0 - GAP - cardW;
      }
      if (x >= MARGIN - SLACK && y >= MARGIN - SLACK && x + cardW <= imgW - MARGIN + SLACK && y + cardH <= imgH - MARGIN + SLACK) {
        return { x: x, y: y, side: side };
      }
    }
    return { x: 0, y: imgH, side: "docked" };
  }

  // The translation for a view zoomed by k around (focusX, focusY) that never
  // shows anything outside the image. Any input that is not a finite number means no
  // zoom: the offset is {tx: 0, ty: 0} and the caller draws at scale 1.
  function zoomOffset(viewW, viewH, focusX, focusY, k) {
    if (!finite(viewW) || !finite(viewH) || !finite(focusX) || !finite(focusY) || !finite(k)) {
      return { tx: 0, ty: 0 };
    }
    return {
      tx: clamp(viewW / 2 - focusX * k, viewW - viewW * k, 0),
      ty: clamp(viewH / 2 - focusY * k, viewH - viewH * k, 0),
    };
  }

  // Text split into [{text, bold}]: text between a pair of ** is bold, an unpaired
  // ** stays as typed, empty pieces are dropped. CRLF and CR become LF. Anything but
  // a string gives no pieces.
  function parseBold(text) {
    if (typeof text !== "string") return [];
    var parts = text.replace(/\r\n?/g, "\n").split("**");
    if (parts.length % 2 === 0) {
      var last = parts.pop();
      parts[parts.length - 1] += "**" + last;
    }
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] !== "") out.push({ text: parts[i], bold: i % 2 === 1 });
    }
    return out;
  }

  // Tour text cleaned and capped, as clean in tour/doc.rs: CRLF and CR become LF; a tab becomes a
  // space; every other control and format character is removed; LF is kept only when `multiline`
  // and becomes a space otherwise; then the text is trimmed and cut at `max` code points.
  function cleanText(s, max, multiline) {
    if (typeof s !== "string") return "";
    var cps = codePoints(s.replace(/\r\n?/g, "\n"));
    var kept = [];
    for (var i = 0; i < cps.length; i++) {
      var c = cps[i];
      if (c === 0x0a) kept.push(multiline ? 0x0a : 0x20);
      else if (c === 0x09) kept.push(0x20);
      else if (!isControl(c) && !isFormat(c)) kept.push(c);
    }
    return fromPoints(trimPoints(kept).slice(0, max));
  }

  // The link when it is safe, else null, as safe_url in tour/doc.rs: trimmed; `https://` in any case
  // (written back lowercase); an authority with no `@` that is two or more non-empty labels of ASCII
  // letters, digits and `-` separated by `.`, no label starting or ending with `-`, the last label
  // holding at least one letter, with an optional `:` and a port of 1 to 5 digits from 1 to 65535; no whitespace,
  // control or format character anywhere; at most 500 code points. No URL parser is used, so every
  // player gives the same answer as the editor.
  function safeUrl(s) {
    if (typeof s !== "string") return null;
    var cps = trimPoints(codePoints(s));
    if (cps.length > LINK_MAX) return null;
    for (var i = 0; i < cps.length; i++) {
      if (isSpace(cps[i]) || isControl(cps[i]) || isFormat(cps[i])) return null;
    }
    var t = fromPoints(cps);
    if (t.slice(0, 8).replace(/[A-Z]/g, function (ch) { return ch.toLowerCase(); }) !== "https://") return null;
    var rest = t.slice(8);
    var authority = rest.split(/[/?#]/)[0];
    var colon = authority.indexOf(":");
    var host = colon < 0 ? authority : authority.slice(0, colon);
    var port = colon < 0 ? null : authority.slice(colon + 1);
    var labels = host.split(".");
    var hostOk = labels.length >= 2 && labels.every(function (l) { return /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(l); }) &&
      /[A-Za-z]/.test(labels[labels.length - 1]);
    var portOk = port === null || (/^[0-9]{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535);
    return hostOk && portOk ? "https://" + rest : null;
  }

  // "#rrggbb" lowercased (after trimming), else the fallback, as hex_colour in tour/doc.rs.
  function color(v, fallback) {
    if (typeof v !== "string") return fallback;
    var t = fromPoints(trimPoints(codePoints(v)));
    return /^#[0-9A-Fa-f]{6}$/.test(t) ? t.toLowerCase() : fallback;
  }

  // A finite number clamped to lo..hi, else the fallback. Strings are not numbers.
  function num(v, lo, hi, fallback) {
    return typeof v === "number" && isFinite(v) ? clamp(v, lo, hi) : fallback;
  }

  return {
    placeCard: placeCard,
    zoomOffset: zoomOffset,
    parseBold: parseBold,
    cleanText: cleanText,
    safeUrl: safeUrl,
    num: num,
    color: color,
  };
})();

if (typeof module === "object" && module && module.exports) module.exports = TourCore;
