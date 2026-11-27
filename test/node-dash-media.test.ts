// What the Images and GIFs pages' scripts do when they run: the page's document, the shared
// /dash/dash.js and the page's own script are run in one fresh Node `vm` context against a
// stand-in document built from the page's own HTML (test/pages-dom.ts), with a stand-in
// address, clipboard, timer and fetch. The fetch either answers from the test or is handed
// to the real app, as a browser on the app address would send it. Node only: the Workers
// runtime runs no code from a string.
//
// What this leaves unproven, for docs/dashboard-browser-check.md: real layout at phone
// width, the preview pictures as a browser loads them (lazily, under the policy), focus
// rings, a screen reader, and the browser's clipboard.
import { isBrandMark } from "./dash-checks.ts";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { createApp } from "../src/app.ts";
import { GIFS_HTML, GIFS_JS, IMAGES_HTML, IMAGES_JS } from "../src/dash/media.ts";
import { DASH_JS } from "../src/dash/script.ts";
import { PART_BYTES } from "../src/media.ts";
import type { Deps } from "../src/ports.ts";
import { SESSION_COOKIE, createSignInCode, redeemSignInCode } from "../src/sessions.ts";
import { gif, png, send } from "./bundle.ts";
import { FakeDocument, FakeElement, markupOf, visibleText } from "./pages-dom.ts";
import { SOURCE_FOOTER } from "../src/source.ts";

const APP = "https://app.example.com";
const CSRF = "c".repeat(64);
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";
/** "Now" for the page: 19 November 2026, noon UTC. */
const NOW = Date.UTC(2026, 10, 19, 12);
const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 12);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A date as the page writes it, in this process's time zone, with the page's "now" in 2026. */
const shown = (ms: number) => {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === 2026 ? "" : " " + d.getFullYear()}`;
};

const FAILED = "Something went wrong. Try again in a moment.";
const TOO_MANY = "Too many requests. Wait a few minutes and try again.";
const NOT_RELOADED = "The change was made, but the list could not be loaded again. Reload the page to see it.";
const QUESTION = "Its link stops working for everyone and it is removed. The copy on your computer is not touched.";
const NO_BACKUPS = "There are no backups of this data, and its removal is permanent.";
const IMAGES_LIST = "/api/v1/media?kind=image";
const GIFS_LIST = "/api/v1/media?kind=clip";

type Answer = { status: number; json?: unknown } | "network";
type Fetched = { method: string; path: string; headers: Record<string, string>; body: string | undefined; init: Record<string, unknown> };
type Responder = (req: Fetched) => Answer | Promise<Answer>;
type Clipboard = { writes: string[]; answer: "ok" | "refuse" | "throw" | "none" };

type Tab = {
  doc: FakeDocument;
  fetched: Fetched[];
  left: () => string | null;
  $: (id: string) => FakeElement;
  shows: () => string[];
  settle: () => Promise<void>;
  tick: () => void;
  /** The delay of every timer the script set, in order. */
  delays: number[];
  clipboard: Clipboard;
  violations: string[];
};

const open: Tab[] = [];
afterEach(() => {
  for (const tab of open.splice(0)) expect(tab.violations, "the script used something it must not").toEqual([]);
});

type Which = "images" | "gifs";
const PAGE: Record<Which, { html: string; js: string }> = { images: { html: IMAGES_HTML, js: IMAGES_JS }, gifs: { html: GIFS_HTML, js: GIFS_JS } };

/** Opens the page at `origin` and runs its two scripts in order, as a browser does with two deferred scripts. */
function openPage(which: Which, respond: Responder, opts: { origin?: string; clipboard?: Clipboard["answer"] } = {}): Tab {
  const doc = new FakeDocument(PAGE[which].html);
  const origin = opts.origin ?? APP;
  let left: string | null = null;
  const fetched: Fetched[] = [];
  const pending: Promise<unknown>[] = [];
  const violations: string[] = [];
  const timers: (() => void)[] = [];
  const delays: number[] = [];
  const clipboard: Clipboard = { writes: [], answer: opts.clipboard ?? "ok" };
  const location = {
    get origin() {
      return origin;
    },
    replace(path: string) {
      left = path;
    },
  };
  const fetch = (path: string, init: Record<string, unknown> = {}) => {
    const req: Fetched = { method: String(init.method ?? "GET"), path, headers: { ...(init.headers as Record<string, string>) }, body: init.body as string | undefined, init };
    fetched.push(req);
    const p = Promise.resolve(respond(req)).then((a) => {
      if (a === "network") throw new TypeError("Failed to fetch");
      const body = a.json === undefined ? null : JSON.stringify(a.json);
      return new Response(a.status === 204 ? null : body, { status: a.status, headers: { "content-type": "application/json" } });
    });
    pending.push(p.catch(() => {}));
    return p;
  };
  const navigator = {
    get clipboard() {
      if (clipboard.answer === "none") return undefined;
      return {
        writeText(text: string) {
          clipboard.writes.push(text);
          if (clipboard.answer === "throw") throw new Error("not allowed");
          return clipboard.answer === "ok" ? Promise.resolve() : Promise.reject(new Error("refused"));
        },
      };
    },
  };
  const setTimeout = (fn: () => void, ms?: number) => {
    timers.push(fn);
    delays.push(Number(ms));
    return timers.length;
  };
  const context: Record<string, unknown> = { document: doc, location, fetch, navigator, setTimeout };
  for (const name of ["localStorage", "sessionStorage", "indexedDB", "caches", "cookieStore", "XMLHttpRequest", "WebSocket", "EventSource", "window", "self", "top", "parent", "opener", "open", "postMessage", "setInterval", "console", "alert", "confirm", "prompt", "history", "URL", "Image"]) {
    Object.defineProperty(context, name, {
      get() {
        violations.push(name);
        throw new Error(`${name} is not for the dashboard's scripts`);
      },
    });
  }
  const ctx = vm.createContext(context);
  vm.runInContext(`(function () { var Real = Date; Date = function (v) { return arguments.length === 0 ? new Real(${NOW}) : new Real(v); }; Date.now = function () { return ${NOW}; }; Date.prototype = Real.prototype; })();`, ctx);
  vm.runInContext(DASH_JS, ctx, { filename: "dash.js" });
  vm.runInContext(PAGE[which].js, ctx, { filename: `${which}.js` });
  const tab: Tab = {
    doc,
    fetched,
    left: () => left,
    $: (id) => {
      const el = doc.root.all().find((e) => e.id === id);
      if (!el) throw new Error(`no #${id}`);
      return el;
    },
    shows: () => visibleText(doc),
    async settle() {
      for (let i = 0; i < 30; i++) {
        await Promise.race([Promise.all(pending), new Promise((r) => globalThis.setTimeout(r, 1))]);
        await new Promise((r) => setImmediate(r));
      }
    },
    tick: () => {
      for (const fn of timers.splice(0)) fn();
    },
    delays,
    clipboard,
    violations,
  };
  open.push(tab);
  return tab;
}

/** The usage when a test gives none: an answer the page cannot use, so the line is made from the list itself. */
const NO_USAGE: Answer = { status: 503, json: { error: "unavailable" } };

/**
 * A responder from a table of "<METHOD> <path>" to answers (a list is answered in order, its
 * last one repeated); anything else fails the test. GET /api/v1/usage answers NO_USAGE unless
 * the table gives it.
 */
function answers(table: Record<string, Answer | Answer[]>): Responder {
  const queues = new Map(Object.entries({ "GET /api/v1/usage": NO_USAGE, ...table }).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  return (req) => {
    const q = queues.get(`${req.method} ${req.path}`);
    if (!q || q.length === 0) throw new Error(`unexpected request ${req.method} ${req.path}`);
    return q.length > 1 ? q.shift()! : q[0];
  };
}

/** A responder whose answers to requests matching `held` wait until the test hands them over; the rest go to `rest`. */
function holding(held: (req: Fetched) => boolean, rest: Responder): { respond: Responder; answer: (a: Answer) => void } {
  const waiting: ((a: Answer) => void)[] = [];
  return {
    respond: (req) => (held(req) ? new Promise<Answer>((r) => waiting.push(r)) : rest(req)),
    answer: (a) => {
      for (const r of waiting.splice(0)) r(a);
    },
  };
}

const SIGNED_OUT: Answer = { status: 401, json: { error: "unauthorized" } };
const session = (workspace = "Cowfee Raid Tools"): Answer => ({
  status: 200,
  json: { account: { id: "usr_1", username: "morgan", email: "morgan@example.com", admin: false }, workspace: { id: "ws_1", name: workspace }, session: { id: "ses_1", created_at: NOW, expires_at: NOW }, csrf: CSRF },
});

const M1 = "med_" + "1".repeat(24);
const M2 = "med_" + "2".repeat(24);
const M3 = "med_" + "3".repeat(24);
const M4 = "med_" + "4".repeat(24);
const M5 = "med_" + "5".repeat(24);
const KB = 1024;
const MB = 1024 * KB;

const image = (id: string, linkId: string, over: Record<string, unknown> = {}) => ({
  id,
  link_id: linkId,
  kind: "image",
  title: "An image",
  content_type: "image/png",
  bytes: 90_112,
  width: 842,
  height: 311,
  duration_ms: null,
  created_at: day(2026, 11, 19),
  has_preview: true,
  path: `/i/${linkId}`,
  link: `https://img.example.com/i/${linkId}`,
  ...over,
});
const clip = (id: string, linkId: string, over: Record<string, unknown> = {}) => ({
  ...image(id, linkId),
  kind: "clip",
  title: "A clip",
  content_type: "image/gif",
  duration_ms: 6000,
  path: `/r/${linkId}`,
  link: `https://img.example.com/r/${linkId}`,
  ...over,
});

/** The three images of mockup 3. */
const MOCKUP_IMAGES = [
  image(M1, "q8d2abcdefghijklmnop", { title: "Loot window, settings tab", bytes: 1_468_006, width: 1920, height: 1080, created_at: day(2026, 11, 19) }),
  image(M2, "m04xabcdefghijklmnop", { title: "Timeline, boss two", bytes: 612 * KB, width: 1280, height: 720, created_at: day(2026, 11, 19), content_type: "image/jpeg", has_preview: false }),
  image(M3, "z7haabcdefghijklmnop", { title: null, bytes: 88 * KB, width: 842, height: 311, created_at: day(2026, 11, 18) }),
];
/** The three GIFs of mockup 4 (the second an MP4 clip). */
const MOCKUP_GIFS = [
  clip(M1, "c51kabcdefghijklmnop", { title: "Sending a note to the raid", bytes: 18 * MB, width: 960, height: 540, duration_ms: 12_000, created_at: day(2026, 11, 19) }),
  clip(M2, "t9wbabcdefghijklmnop", { title: "Loot council vote, full round", bytes: 96 * MB, width: 1280, height: 720, duration_ms: 37_600, content_type: "video/mp4", created_at: day(2026, 11, 18), has_preview: false }),
  clip(M3, "a3vnabcdefghijklmnop", { title: "", bytes: 4_404_019, width: 640, height: 360, duration_ms: 5_600, created_at: day(2026, 11, 17) }),
];

const list = (items: unknown[], next: string | null = null): Answer => ({ status: 200, json: { items, next } });

function standard(which: Which, extra: Record<string, Answer | Answer[]> = {}): Responder {
  return which === "images"
    ? answers({ "GET /api/v1/session": session(), [`GET ${IMAGES_LIST}`]: list(MOCKUP_IMAGES), ...extra })
    : answers({ "GET /api/v1/session": session(), [`GET ${GIFS_LIST}`]: list(MOCKUP_GIFS), ...extra });
}

const rows = (tab: Tab) => tab.$("media-rows").children.filter((c): c is FakeElement => c instanceof FakeElement);
const cells = (row: FakeElement) => row.children.filter((c): c is FakeElement => c instanceof FakeElement);
const titleOf = (row: FakeElement) => row.all().find((e) => e.className === "t")!;
const controlsOf = (row: FakeElement) => row.all().filter((e) => (e.tagName === "button" || e.tagName === "a") && e.shown);
const byText = (row: FakeElement, text: string) => {
  const found = row.all().find((e) => (e.tagName === "button" || e.tagName === "a") && e.textContent === text);
  if (!found) throw new Error(`no "${text}" in the row`);
  return found;
};
/** Delete, which is in the row's More (Plan 2k): opens the menu and presses it, as a person does. */
const pressDelete = (row: FakeElement) => {
  byText(row, "More").click();
  const entry = row.all().find((e) => e.getAttribute("role") === "menuitem" && e.textContent === "Delete");
  if (!entry) throw new Error('no "Delete" in the menu');
  entry.click();
};
const rowButtons = (tab: Tab) => rows(tab).flatMap((row) => row.all().filter((e) => e.tagName === "button"));
const key = (el: FakeElement, k: string, shiftKey = false) => el.dispatch("keydown", { key: k, shiftKey });
const line = (tab: Tab) => tab.$("media-count").textContent + tab.$("media-in").textContent + tab.$("media-used").textContent;
const details = (row: FakeElement) => {
  const d = row.all().find((e) => e.className === "d")!;
  const parts = d.children.filter((c): c is FakeElement => c instanceof FakeElement);
  return {
    wide: parts.filter((c) => c.className !== "narrow-only").map((c) => c.textContent).join(""),
    narrow: parts.filter((c) => c.className !== "wide-only").map((c) => c.textContent).join(""),
  };
};
const thumbOf = (row: FakeElement) => cells(row)[1].all()[0];
const imgOf = (row: FakeElement) => row.all().find((e) => e.tagName === "img") as (FakeElement & { src?: string }) | undefined;
const deletes = (tab: Tab) => tab.fetched.filter((f) => f.method === "DELETE");
const lists = (tab: Tab, which: Which = "images") => tab.fetched.filter((f) => f.method === "GET" && f.path.startsWith(which === "images" ? IMAGES_LIST : GIFS_LIST));

describe("the Images page", () => {
  it("shows mockup 3: the line, one row per image with its preview, details, size, day and buttons, and the hint", async () => {
    const tab = openPage("images", standard("images"));
    await tab.settle();
    expect(tab.left()).toBeNull();
    expect(tab.fetched.map((f) => `${f.method} ${f.path}`).sort()).toEqual(["GET /api/v1/media?kind=image", "GET /api/v1/session", "GET /api/v1/usage"]);
    expect(line(tab)).toBe("3 images in Cowfee Raid Tools · 2.1 MB used");
    const r = rows(tab);
    expect(r.map((row) => titleOf(row).textContent)).toEqual(["Loot window, settings tab", "Timeline, boss two", "Untitled image"]);
    expect(r.map((row) => ({ ...details(row), size: cells(row)[4].textContent, when: cells(row)[5].textContent, controls: controlsOf(row).map((c) => c.textContent) }))).toEqual([
      { wide: "1920 × 1080 · PNG · img.example.com/i/q8d2…", narrow: `1920 × 1080 · PNG · 1.4 MB · ${shown(day(2026, 11, 19))}`, size: "1.4 MB", when: "19 Nov", controls: ["Copy link", "Open", "More"] },
      { wide: "1280 × 720 · JPEG · img.example.com/i/m04x…", narrow: `1280 × 720 · JPEG · 612 KB · ${shown(day(2026, 11, 19))}`, size: "612 KB", when: "19 Nov", controls: ["Copy link", "Open", "More"] },
      { wide: "842 × 311 · PNG · img.example.com/i/z7ha…", narrow: `842 × 311 · PNG · 88 KB · ${shown(day(2026, 11, 18))}`, size: "88 KB", when: shown(day(2026, 11, 18)), controls: ["Copy link", "Open", "More"] },
    ]);
    // The whole link is in the shortened text's title; Open is a real link in a new tab, without the opener or a referrer.
    expect(r[0].all().find((e) => e.className === "wide-only")!.getAttribute("title")).toBe("https://img.example.com/i/q8d2abcdefghijklmnop");
    const openLink = byText(r[0], "Open");
    expect([openLink.tagName, openLink.getAttribute("href"), openLink.getAttribute("target"), openLink.getAttribute("rel")]).toEqual(["a", "https://img.example.com/i/q8d2abcdefghijklmnop", "_blank", "noopener noreferrer"]);
    expect([byText(r[0], "More").className, byText(r[0], "Copy link").className, openLink.className]).toEqual(["btn sm quiet", "btn sm", "btn sm quiet"]);
    // Delete is in More, after Sharing…, as on the Tours page (Plan 2k).
    expect(r[0].all().filter((e) => e.getAttribute("role") === "menuitem").map((e) => [e.textContent, e.className])).toEqual([["Sharing…", ""], ["Delete", "danger"]]);
    // The preview: the item's own route on this site, at a fixed size, lazily, with no referrer and no words; a plain box without one; no play mark on an image.
    const img = imgOf(r[0])!;
    expect([img.src, img.getAttribute("width"), img.getAttribute("height"), img.getAttribute("loading"), img.getAttribute("alt"), img.getAttribute("referrerpolicy")]).toEqual([`/api/v1/media/${M1}/preview`, "56", "36", "lazy", "", "no-referrer"]);
    expect(img.hasAttribute("src")).toBe(false);
    expect(r.map((row) => [thumbOf(row).className, imgOf(row) !== undefined])).toEqual([["thumb", true], ["thumb", false], ["thumb", true]]);
    expect(cells(r[0])[1].getAttribute("aria-hidden")).toBe("true");
    // Every control names its image for a screen reader, and every button is a plain button.
    for (const [i, row] of r.entries()) {
      expect(titleOf(row).id).toBe(`item-${i}`);
      for (const c of controlsOf(row)) expect(c.getAttribute("aria-describedby"), c.textContent).toBe(`item-${i}`);
      for (const b of row.all().filter((e) => e.tagName === "button")) expect(b.getAttribute("type")).toBe("button");
    }
    expect([tab.$("media-list").shown, tab.$("media-hint").shown, tab.$("media-empty").shown, tab.$("media-more").shown]).toEqual([true, true, false, false]);
    expect([tab.$("media-message").hidden, tab.$("delete-message").hidden, tab.$("dash-load").textContent]).toEqual([true, true, ""]);
    expect(tab.$("media-in").className).toBe("wide-only");
    expect(tab.shows()).toEqual([
      "Mythicshot",
      "morgan",
      "Images",
      "3 images in Cowfee Raid Tools · 2.1 MB used",
      "Select all 3 shown",
      "Copy link",
      "More",
      "Copy link",
      "More",
      "Copy link",
      "More",
      'Deleting an image stops its link for everyone. "More" holds: Sharing, Delete.',
    ]);
  });

  it("writes one image in the singular, and an empty workspace with its own empty state", async () => {
    const one = openPage("images", standard("images", { [`GET ${IMAGES_LIST}`]: list([MOCKUP_IMAGES[0]]) }));
    await one.settle();
    expect(line(one)).toBe("1 image in Cowfee Raid Tools · 1.4 MB used");

    const none = openPage("images", standard("images", { [`GET ${IMAGES_LIST}`]: list([]) }));
    await none.settle();
    expect([none.$("media-list").shown, none.$("media-hint").shown, none.$("media-empty").shown, none.$("media-more").shown]).toEqual([false, false, true, false]);
    expect(none.shows()).toEqual(["Mythicshot", "morgan", "Images", "0 images in Cowfee Raid Tools · 0 bytes used", "No images yet", "Take a screenshot in Mythicshot and choose Publish to. It shows up here with a link to share."]);

    // A workspace without a name leaves " in …" out.
    const unnamed = openPage("images", standard("images", { "GET /api/v1/session": session("") }));
    await unnamed.settle();
    expect(line(unnamed)).toBe("3 images · 2.1 MB used");
  });

  it("shows a title holding markup, quotes or a javascript: look-alike as text, never as markup or a link", async () => {
    const hostile = ['<img src=x onerror="alert(1)">', 'javascript:alert("x")', '"><a href="javascript:alert(1)">x</a>', "</td></tr><script>alert(1)</script>"];
    const tab = openPage("images", standard("images", { [`GET ${IMAGES_LIST}`]: list(hostile.map((title, i) => image(["med_", "1", "2", "3", "4"][0] + String(i + 1).repeat(24), `abcd${i}efghijklmnopqrs`, { title, has_preview: false }))), "GET /api/v1/session": session("<i>ws</i>") }));
    await tab.settle();
    const r = rows(tab);
    expect(r.map((row) => titleOf(row).textContent)).toEqual(hostile);
    for (const row of r) expect(titleOf(row).children.every((c) => !(c instanceof FakeElement))).toBe(true);
    expect(tab.$("media-in").textContent).toBe(" in <i>ws</i>");
    // No element came from a title: only the page's own img, a and script tags are anywhere.
    expect(tab.doc.root.all().filter((e) => ["img", "i", "script", "b"].includes(e.tagName) && !isBrandMark(e) && e.parent?.tagName !== "head")).toEqual([]);
    // The only links in the rows are Open, to the item's own link.
    for (const row of r) expect(row.all().filter((e) => e.tagName === "a").map((a) => a.getAttribute("href"))).toEqual([row.all().find((e) => e.className === "wide-only")!.getAttribute("title")]);
    // The question names it as text too.
    pressDelete(r[1]);
    expect(tab.$("delete-title").textContent).toBe('Delete "javascript:alert("x")"?');
    expect(tab.$("delete-title").children.every((c) => !(c instanceof FakeElement))).toBe(true);
  });

  it("uses an item's link only when it is http(s) with a plain host and a path, or one path of this site", async () => {
    const linkFor = async (link: unknown, origin = APP) => {
      const tab = openPage("images", standard("images", { [`GET ${IMAGES_LIST}`]: list([image(M1, "q8d2abcdefghijklmnop", { link })]) }), { origin });
      await tab.settle();
      const row = rows(tab)[0];
      const wide = row.all().find((e) => e.className === "wide-only");
      return { hrefs: row.all().filter((e) => e.tagName === "a").map((a) => a.getAttribute("href")), controls: controlsOf(row).map((c) => c.textContent), text: wide?.textContent ?? null, title: wide?.getAttribute("title") ?? null };
    };
    expect(await linkFor("https://img.example.com/i/q8d2abcdefghijklmnop")).toEqual({ hrefs: ["https://img.example.com/i/q8d2abcdefghijklmnop"], controls: ["Copy link", "Open", "More"], text: " · img.example.com/i/q8d2…", title: "https://img.example.com/i/q8d2abcdefghijklmnop" });
    expect((await linkFor("http://tours.localhost:8787/i/q8d2")).text).toBe(" · tours.localhost:8787/i/q8d2");
    // A path is put after this page's own origin, as the Tours page does in one-address mode.
    expect(await linkFor("/i/q8d2abcdefghijklmnop", "http://localhost:3000")).toEqual({ hrefs: ["http://localhost:3000/i/q8d2abcdefghijklmnop"], controls: ["Copy link", "Open", "More"], text: " · localhost:3000/i/q8d2…", title: "http://localhost:3000/i/q8d2abcdefghijklmnop" });
    const none = { hrefs: [], controls: ["More"], text: null, title: null };
    const hostile = [
      "javascript:alert(1)", "JAVASCRIPT:alert(1)", " javascript:alert(1)", "data:text/html,<b>x</b>", "vbscript:x", "//evil.example.net/i/x", "/\\evil.example.net/i/x", "\\\\evil.example.net/i/x",
      "https://evil.example.net", "https://user@evil.example.net/i/x", "https://evil.example.net//x", "https:/evil.example.net/i/x", "ftp://img.example.com/i/x", "/i/x y", '/i/x"><b>x', "/i/x\n", "i/x", "",
      "https://img.example.com:999999/i/x", null, 7, { toString: () => "/i/x" }, ["/i/x"],
    ];
    for (const link of hostile) expect(await linkFor(link), String(link)).toEqual(none);
  });

  it("never shows a GIF, nor an item whose id is not the API's", async () => {
    const tab = openPage("images", standard("images", { [`GET ${IMAGES_LIST}`]: list([MOCKUP_IMAGES[0], clip(M4, "c51kabcdefghijklmnop", { title: "A clip on the wrong page" }), image("med_x", "zzzzabcdefghijklmnop"), image("tour_" + "1".repeat(24), "yyyyabcdefghijklmnop"), { ...MOCKUP_IMAGES[1], kind: undefined }, { ...MOCKUP_IMAGES[2], bytes: "88" }, null, "x"]) }));
    await tab.settle();
    expect(rows(tab).map((row) => titleOf(row).textContent)).toEqual(["Loot window, settings tab"]);
    expect(line(tab)).toBe("1 image in Cowfee Raid Tools · 1.4 MB used");
  });

  it("a preview that does not load leaves the plain box", async () => {
    const tab = openPage("images", standard("images"));
    await tab.settle();
    const row = rows(tab)[0];
    const img = imgOf(row)!;
    img.dispatch("error");
    expect(imgOf(row)).toBeUndefined();
    expect(thumbOf(row).className).toBe("thumb");
    expect(thumbOf(row).children).toEqual([]);
    // Nothing was asked of the API for it: the browser loads a preview by itself.
    expect(tab.fetched.filter((f) => f.path.includes("/preview"))).toEqual([]);
  });

  it("Copy link writes the link inside the click, reads Copied for a moment, and selects the link in a field when the clipboard refuses", async () => {
    const tab = openPage("images", standard("images"));
    await tab.settle();
    const copy = byText(rows(tab)[0], "Copy link");
    copy.click();
    expect(tab.clipboard.writes).toEqual(["https://img.example.com/i/q8d2abcdefghijklmnop"]);
    await tab.settle();
    expect(copy.textContent).toBe("Copied");
    tab.tick();
    expect(copy.textContent).toBe("Copy link");
    for (const answer of ["refuse", "throw", "none"] as const) {
      const refused = openPage("images", standard("images"), { clipboard: answer });
      await refused.settle();
      const row = rows(refused)[1];
      byText(row, "Copy link").click();
      await refused.settle();
      const field = row.all().find((e) => e.tagName === "input" && e.className === "copy")!;
      expect([field.value, field.getAttribute("readonly"), field.getAttribute("aria-labelledby"), field.className], answer).toEqual(["https://img.example.com/i/m04xabcdefghijklmnop", "", "item-1", "copy"]);
      expect(refused.doc.activeElement, answer).toBe(field);
      byText(row, "Copy link").click();
      await refused.settle();
      expect(row.all().filter((e) => e.tagName === "input" && e.className === "copy"), answer).toHaveLength(1);
    }
    expect(tab.fetched.filter((f) => f.method !== "GET")).toEqual([]);
  });
});

describe("the GIFs page", () => {
  it("shows mockup 4: clips only, with the length in whole seconds, the play mark and the clip's own words", async () => {
    const tab = openPage("gifs", standard("gifs"));
    await tab.settle();
    expect(tab.fetched.map((f) => `${f.method} ${f.path}`).sort()).toEqual(["GET /api/v1/media?kind=clip", "GET /api/v1/session", "GET /api/v1/usage"]);
    expect(line(tab)).toBe("3 GIFs in Cowfee Raid Tools · 118.2 MB used");
    const r = rows(tab);
    expect(r.map((row) => [titleOf(row).textContent, details(row).wide, details(row).narrow])).toEqual([
      ["Sending a note to the raid", "12 s · 960 × 540 · img.example.com/r/c51k…", `12 s · 960 × 540 · 18 MB · ${shown(day(2026, 11, 19))}`],
      ["Loot council vote, full round", "38 s · 1280 × 720 · img.example.com/r/t9wb…", `38 s · 1280 × 720 · 96 MB · ${shown(day(2026, 11, 18))}`],
      ["Untitled GIF", "6 s · 640 × 360 · img.example.com/r/a3vn…", `6 s · 640 × 360 · 4.2 MB · ${shown(day(2026, 11, 17))}`],
    ]);
    // Every box carries the play mark, with or without a preview.
    expect(r.map((row) => [thumbOf(row).className, imgOf(row)?.src ?? null])).toEqual([["thumb play", `/api/v1/media/${M1}/preview`], ["thumb play", null], ["thumb play", `/api/v1/media/${M3}/preview`]]);
    expect(r.map((row) => controlsOf(row).map((c) => c.textContent))).toEqual([["Copy link", "Open", "More"], ["Copy link", "Open", "More"], ["Copy link", "Open", "More"]]);
    expect(tab.$("media-hint").textContent).toBe('Deleting a GIF stops its link for everyone. "More" holds: Sharing, Delete.');
  });

  it("never shows an image, and has its own singular and empty state", async () => {
    const mixed = openPage("gifs", standard("gifs", { [`GET ${GIFS_LIST}`]: list([image(M4, "q8d2abcdefghijklmnop", { title: "An image on the wrong page" }), MOCKUP_GIFS[0]]) }));
    await mixed.settle();
    expect(rows(mixed).map((row) => titleOf(row).textContent)).toEqual(["Sending a note to the raid"]);
    expect(line(mixed)).toBe("1 GIF in Cowfee Raid Tools · 18 MB used");
    expect(mixed.doc.root.textContent).not.toContain("An image on the wrong page");

    const onlyImages = openPage("gifs", standard("gifs", { [`GET ${GIFS_LIST}`]: list(MOCKUP_IMAGES) }));
    await onlyImages.settle();
    expect(rows(onlyImages)).toEqual([]);
    expect(onlyImages.shows()).toEqual(["Mythicshot", "morgan", "GIFs", "0 GIFs in Cowfee Raid Tools · 0 bytes used", "No GIFs yet", "Record a clip in Mythicshot and choose Publish to. It shows up here with a link to share."]);
    // And the Images page never asks for clips.
    const images = openPage("images", standard("images"));
    await images.settle();
    expect(images.fetched.some((f) => f.path.includes("kind=clip"))).toBe(false);
  });

  it("a clip of under half a second shows 1 s, and one without a length or size shows what it has", async () => {
    const tab = openPage("gifs", standard("gifs", { [`GET ${GIFS_LIST}`]: list([clip(M1, "c51kabcdefghijklmnop", { duration_ms: 300 }), clip(M2, "t9wbabcdefghijklmnop", { duration_ms: null, width: 0, height: "x" })]) }));
    await tab.settle();
    expect(rows(tab).map((row) => details(row).wide)).toEqual(["1 s · 842 × 311 · img.example.com/r/c51k…", "img.example.com/r/t9wb…"]);
  });
});

describe("Show more", () => {
  const PAGE1 = [MOCKUP_IMAGES[0], MOCKUP_IMAGES[1]];
  const PAGE2 = [MOCKUP_IMAGES[2]];
  const CURSOR = "MTc2MzU1MzYwMDAwMC5tZWRfMjIy";

  it("while the list has another page the line names the newest shown and no size; Show more loads the next page, once, with the cursor", async () => {
    const held = holding((req) => req.path.includes("&cursor="), standard("images", { [`GET ${IMAGES_LIST}`]: list(PAGE1, CURSOR) }));
    const tab = openPage("images", held.respond);
    await tab.settle();
    expect(line(tab)).toBe("The newest 2 images in Cowfee Raid Tools");
    expect([tab.$("media-more").shown, tab.$("media-more").disabled, tab.$("media-more").textContent]).toEqual([true, false, "Show more"]);
    expect(tab.$("media-empty").shown).toBe(false);
    const more = tab.$("media-more");
    more.click();
    more.click();
    more.dispatch("click");
    await tab.settle();
    expect(lists(tab).map((f) => f.path)).toEqual([IMAGES_LIST, `${IMAGES_LIST}&cursor=${CURSOR}`]);
    expect(more.disabled).toBe(true);
    held.answer(list(PAGE2));
    await tab.settle();
    expect(rows(tab).map((row) => titleOf(row).textContent)).toEqual(["Loot window, settings tab", "Timeline, boss two", "Untitled image"]);
    expect(line(tab)).toBe("3 images in Cowfee Raid Tools · 2.1 MB used");
    expect([more.shown, more.disabled]).toEqual([false, false]);
    // The focus is on the first new row's first control.
    expect(tab.doc.activeElement).toBe(byText(rows(tab)[2], "Copy link"));
  });

  it("a Show more that fails says so and keeps the list; a cursor that is not the API's shape ends the list", async () => {
    for (const [answer, text] of [[{ status: 500, json: { error: "internal" } }, FAILED], [{ status: 429, json: { error: "rate_limited" } }, TOO_MANY], ["network", FAILED], [{ status: 200, json: { items: "x" } }, FAILED]] as [Answer, string][]) {
      const tab = openPage("images", standard("images", { [`GET ${IMAGES_LIST}`]: list(PAGE1, CURSOR), [`GET ${IMAGES_LIST}&cursor=${CURSOR}`]: answer }));
      await tab.settle();
      tab.$("media-more").click();
      await tab.settle();
      expect(tab.$("media-message").textContent, JSON.stringify(answer)).toBe(text);
      expect(tab.$("media-message").hidden).toBe(false);
      expect(rows(tab)).toHaveLength(2);
      expect([tab.$("media-more").shown, tab.$("media-more").disabled]).toEqual([true, false]);
    }
    for (const next of ["a&kind=clip", "../x", "a b", "x".repeat(101), 7, ""]) {
      const tab = openPage("images", standard("images", { [`GET ${IMAGES_LIST}`]: list(PAGE1, next as string) }));
      await tab.settle();
      expect(tab.$("media-more").shown, String(next)).toBe(false);
      expect(line(tab), String(next)).toBe("2 images in Cowfee Raid Tools · 2 MB used");
    }
    const out = openPage("images", standard("images", { [`GET ${IMAGES_LIST}`]: list(PAGE1, CURSOR), [`GET ${IMAGES_LIST}&cursor=${CURSOR}`]: SIGNED_OUT }));
    await out.settle();
    out.$("media-more").click();
    await out.settle();
    expect(out.left()).toBe("/signin");
  });

  it("a delete reads again every page shown, after any Show more still running, so answers cannot arrive out of order", async () => {
    const held = holding(
      (req) => req.path === `${IMAGES_LIST}&cursor=${CURSOR}` && req.method === "GET",
      standard("images", { [`GET ${IMAGES_LIST}`]: [list(PAGE1, CURSOR), list([MOCKUP_IMAGES[1]], CURSOR)], [`DELETE /api/v1/media/${M1}`]: { status: 204 } }),
    );
    const tab = openPage("images", held.respond);
    await tab.settle();
    tab.$("media-more").click();
    await tab.settle();
    // The Show more answer is held; the list is two rows still.
    expect(rows(tab)).toHaveLength(2);
    pressDelete(rows(tab)[0]);
    tab.$("delete-go").click();
    await tab.settle();
    // The read after the delete waits for Show more.
    expect(lists(tab).map((f) => f.path)).toEqual([IMAGES_LIST, `${IMAGES_LIST}&cursor=${CURSOR}`]);
    held.answer(list(PAGE2));
    await tab.settle();
    // Then both pages are read again, in order: the first page, then the second with the new first page's cursor.
    expect(lists(tab).map((f) => f.path)).toEqual([IMAGES_LIST, `${IMAGES_LIST}&cursor=${CURSOR}`, IMAGES_LIST, `${IMAGES_LIST}&cursor=${CURSOR}`]);
    // The question stays busy until the whole list is in.
    expect(tab.$("delete-go").textContent).toBe("Deleting…");
    held.answer(list(PAGE2));
    await tab.settle();
    // Only the server's answer is shown.
    expect(rows(tab).map((row) => titleOf(row).textContent)).toEqual(["Timeline, boss two", "Untitled image"]);
    expect(line(tab)).toBe("2 images in Cowfee Raid Tools · 700 KB used");
  });
});

describe("deleting an item", () => {
  it("asks first with the proposed question; Keep it, Escape and the backdrop close it, and the focus comes back to More", async () => {
    for (const which of ["images", "gifs"] as const) {
      const tab = openPage(which, standard(which));
      await tab.settle();
      const more = byText(rows(tab)[2], "More");
      pressDelete(rows(tab)[2]);
      expect(tab.$("delete-dialog").hidden).toBe(false);
      const untitled = which === "images" ? "Untitled image" : "Untitled GIF";
      expect(tab.shows().slice(-5)).toEqual([`Delete "${untitled}"?`, QUESTION, NO_BACKUPS, "Keep it", which === "images" ? "Delete image" : "Delete GIF"]);
      expect(tab.doc.activeElement).toBe(tab.$("delete-keep"));
      // The source line at the foot goes inert with the bar and the page.
      for (const id of ["dash-top", "media-page", "source-line"]) expect([tab.$(id).getAttribute("inert"), tab.$(id).getAttribute("aria-hidden")], id).toEqual(["", "true"]);
      expect(key(tab.$("delete-keep"), "Tab").defaultPrevented).toBe(true);
      expect(tab.doc.activeElement).toBe(tab.$("delete-go"));
      tab.$("delete-keep").click();
      expect(tab.$("delete-dialog").hidden).toBe(true);
      expect(tab.doc.activeElement).toBe(more);
      pressDelete(rows(tab)[2]);
      key(tab.doc.body, "Escape");
      expect(tab.$("delete-dialog").hidden).toBe(true);
      pressDelete(rows(tab)[2]);
      tab.$("delete-dialog").click();
      expect(tab.$("delete-dialog").hidden).toBe(true);
      expect(tab.doc.activeElement).toBe(more);
      for (const id of ["dash-top", "media-page", "source-line"]) expect([tab.$(id).hasAttribute("inert"), tab.$(id).hasAttribute("aria-hidden")], id).toEqual([false, false]);
      // After the page's script ran and the question came and went, the source line is exactly as built.
      expect(markupOf(tab.$("source-line"))).toBe(SOURCE_FOOTER);
      expect(tab.fetched.filter((f) => f.method !== "GET")).toEqual([]);
    }
  });

  it("Delete image deletes with the anti-forgery header, closes the question and shows the list again", async () => {
    const tab = openPage("images", standard("images", { [`DELETE /api/v1/media/${M2}`]: { status: 204 }, [`GET ${IMAGES_LIST}`]: [list(MOCKUP_IMAGES), list([MOCKUP_IMAGES[0], MOCKUP_IMAGES[2]])] }));
    await tab.settle();
    pressDelete(rows(tab)[1]);
    const go = tab.$("delete-go");
    go.click();
    expect([go.textContent, go.disabled, tab.$("delete-keep").disabled, go.getAttribute("aria-busy")]).toEqual(["Deleting…", true, true, "true"]);
    for (const b of rowButtons(tab)) expect(b.disabled, b.textContent).toBe(true);
    key(go, "Escape");
    expect(tab.$("delete-dialog").hidden).toBe(false);
    await tab.settle();
    expect(deletes(tab).map((f) => [f.path, f.headers["X-Csrf-Token"], f.body])).toEqual([[`/api/v1/media/${M2}`, CSRF, undefined]]);
    expect(tab.$("delete-dialog").hidden).toBe(true);
    expect([go.textContent, go.disabled]).toEqual(["Delete image", false]);
    expect(rows(tab).map((row) => titleOf(row).textContent)).toEqual(["Loot window, settings tab", "Untitled image"]);
    expect(line(tab)).toBe("2 images in Cowfee Raid Tools · 1.5 MB used");
    expect(tab.$("media-message").hidden).toBe(true);
    for (const b of rowButtons(tab)) expect(b.disabled, b.textContent).toBe(false);
    expect(tab.doc.activeElement).toBe(tab.$("h-page"));
    // The last one gone: the empty state.
    const last = openPage("gifs", standard("gifs", { [`DELETE /api/v1/media/${M1}`]: { status: 204 }, [`GET ${GIFS_LIST}`]: [list([MOCKUP_GIFS[0]]), list([])] }));
    await last.settle();
    pressDelete(rows(last)[0]);
    last.$("delete-go").click();
    await last.settle();
    expect(last.$("media-empty").shown).toBe(true);
    expect(line(last)).toBe("0 GIFs in Cowfee Raid Tools · 0 bytes used");
  });

  it("sends the delete again after a pause while its files are still being removed, at most three times; the item is deleted either way", async () => {
    // Finished on the second try, after a pause of 400 ms.
    const second = openPage("images", standard("images", { [`DELETE /api/v1/media/${M1}`]: [{ status: 500, json: { error: "cleanup_pending" } }, { status: 204 }], [`GET ${IMAGES_LIST}`]: [list(MOCKUP_IMAGES), list(MOCKUP_IMAGES.slice(1))] }));
    await second.settle();
    pressDelete(rows(second)[0]);
    second.$("delete-go").click();
    await second.settle();
    // Nothing is sent again before the pause has passed.
    expect(deletes(second)).toHaveLength(1);
    expect(second.delays).toEqual([400]);
    expect(second.$("delete-go").textContent).toBe("Deleting…");
    second.tick();
    await second.settle();
    expect(deletes(second)).toHaveLength(2);
    expect(second.$("delete-dialog").hidden).toBe(true);
    expect(rows(second)).toHaveLength(2);
    expect(second.$("media-message").hidden).toBe(true);

    // Never finished: three sends, 400 ms and 1200 ms apart, and then it is done all the same: the
    // server marked the item deleted before removing its files, which a later request finishes.
    const never = openPage("images", standard("images", { [`DELETE /api/v1/media/${M1}`]: { status: 500, json: { error: "cleanup_pending" } }, [`GET ${IMAGES_LIST}`]: [list(MOCKUP_IMAGES), list(MOCKUP_IMAGES.slice(1))] }));
    await never.settle();
    pressDelete(rows(never)[0]);
    never.$("delete-go").click();
    for (let i = 0; i < 4; i++) {
      await never.settle();
      never.tick();
    }
    await never.settle();
    expect(deletes(never)).toHaveLength(3);
    expect(never.delays).toEqual([400, 1200]);
    expect(never.$("delete-dialog").hidden).toBe(true);
    expect(never.$("delete-message").hidden).toBe(true);
    expect(never.$("media-message").hidden).toBe(true);
    expect(lists(never)).toHaveLength(2);
    expect(rows(never).map((row) => titleOf(row).textContent)).toEqual(["Timeline, boss two", "Untitled image"]);
    for (const b of rowButtons(never)) expect(b.disabled, b.textContent).toBe(false);
    expect(never.doc.activeElement).toBe(never.$("h-page"));
  });

  it("a delete whose answer is lost asks the item itself: only a 404 means done; still there, or no answer again, means it failed", async () => {
    const ITEM_M1 = `GET /api/v1/media/${M1}`;
    const items = (tab: Tab) => tab.fetched.filter((f) => f.method === "GET" && f.path === `/api/v1/media/${M1}`);
    // The item answers 404: it was deleted, and the question closes as for a delete that answered.
    const gone = openPage("images", standard("images", { [`DELETE /api/v1/media/${M1}`]: "network", [ITEM_M1]: { status: 404, json: { error: "not_found" } }, [`GET ${IMAGES_LIST}`]: [list(MOCKUP_IMAGES), list(MOCKUP_IMAGES.slice(1))] }));
    await gone.settle();
    pressDelete(rows(gone)[0]);
    gone.$("delete-go").click();
    await gone.settle();
    expect(deletes(gone)).toHaveLength(1);
    expect(items(gone).map((f) => [f.path, f.body])).toEqual([[`/api/v1/media/${M1}`, undefined]]);
    expect(gone.$("delete-dialog").hidden).toBe(true);
    expect([gone.$("delete-message").hidden, gone.$("media-message").hidden]).toEqual([true, true]);
    expect(lists(gone)).toHaveLength(2);
    expect(rows(gone)).toHaveLength(2);
    for (const b of rowButtons(gone)) expect(b.disabled, b.textContent).toBe(false);
    expect(gone.doc.activeElement).toBe(gone.$("h-page"));

    // A lost answer after a cleanup_pending: the item decides too.
    const later = openPage("images", standard("images", { [`DELETE /api/v1/media/${M1}`]: [{ status: 500, json: { error: "cleanup_pending" } }, "network"], [ITEM_M1]: { status: 404, json: { error: "not_found" } }, [`GET ${IMAGES_LIST}`]: [list(MOCKUP_IMAGES), list(MOCKUP_IMAGES.slice(1))] }));
    await later.settle();
    pressDelete(rows(later)[0]);
    later.$("delete-go").click();
    await later.settle();
    later.tick();
    await later.settle();
    expect(deletes(later)).toHaveLength(2);
    expect(items(later)).toHaveLength(1);
    expect(later.$("delete-dialog").hidden).toBe(true);
    expect(rows(later)).toHaveLength(2);

    // The item is still there, online or still being sent: the delete did not happen, even when
    // newer items pushed it off the pages shown, so the list read again no longer has it.
    for (const state of ["online", "uploading"]) {
      const newer = [image(M4, "n4n4abcdefghijklmnop", { title: "Newer one" }), image(M5, "n5n5abcdefghijklmnop", { title: "Newer two" })];
      const still = openPage("images", standard("images", { [`DELETE /api/v1/media/${M1}`]: "network", [ITEM_M1]: { status: 200, json: { ...MOCKUP_IMAGES[0], state } }, [`GET ${IMAGES_LIST}`]: [list(MOCKUP_IMAGES), list([...newer, ...MOCKUP_IMAGES.slice(1)])] }));
      await still.settle();
      pressDelete(rows(still)[0]);
      still.$("delete-go").click();
      await still.settle();
      expect(items(still), state).toHaveLength(1);
      expect(still.$("delete-dialog").hidden, state).toBe(false);
      expect([still.$("delete-message").textContent, still.$("delete-message").hidden], state).toEqual([FAILED, false]);
      expect(rows(still).map((row) => titleOf(row).textContent), state).toEqual(["Newer one", "Newer two", "Timeline, boss two", "Untitled image"]);
      expect([still.$("delete-go").disabled, still.$("delete-keep").disabled], state).toEqual([false, false]);
      for (const b of rowButtons(still)) expect(b.disabled, `${state} ${b.textContent}`).toBe(false);
      expect(still.doc.activeElement, state).toBe(still.$("delete-go"));
    }

    // The item cannot be asked either (no answer, a 404 that is not the API's own not_found, as
    // from a proxy, or another answer): nothing says it is gone, so the failure stands, though the
    // list read again no longer has it. A 429 is told with its own sentence.
    for (const [asked, text] of [
      ["network", FAILED],
      [{ status: 404, json: null }, FAILED],
      [{ status: 404, json: { error: "gone" } }, FAILED],
      [{ status: 500, json: { error: "internal" } }, FAILED],
      [{ status: 429, json: { error: "rate_limited" } }, TOO_MANY],
    ] as [Answer, string][]) {
      const what = JSON.stringify(asked);
      const unknown = openPage("images", standard("images", { [`DELETE /api/v1/media/${M1}`]: "network", [ITEM_M1]: asked, [`GET ${IMAGES_LIST}`]: [list(MOCKUP_IMAGES), list(MOCKUP_IMAGES.slice(1))] }));
      await unknown.settle();
      pressDelete(rows(unknown)[0]);
      unknown.$("delete-go").click();
      await unknown.settle();
      expect(unknown.$("delete-dialog").hidden, what).toBe(false);
      expect(unknown.$("delete-message").textContent, what).toBe(text);
      expect(rows(unknown), what).toHaveLength(2);
      expect(unknown.doc.activeElement, what).toBe(unknown.$("delete-go"));
    }

    // A lost session while asking goes to sign in.
    const out = openPage("images", standard("images", { [`DELETE /api/v1/media/${M1}`]: "network", [ITEM_M1]: SIGNED_OUT }));
    await out.settle();
    pressDelete(rows(out)[0]);
    out.$("delete-go").click();
    await out.settle();
    expect(out.left()).toBe("/signin");

    // An answered delete never asks the item.
    const answered = openPage("images", standard("images", { [`DELETE /api/v1/media/${M1}`]: { status: 204 }, [`GET ${IMAGES_LIST}`]: [list(MOCKUP_IMAGES), list(MOCKUP_IMAGES.slice(1))] }));
    await answered.settle();
    pressDelete(rows(answered)[0]);
    answered.$("delete-go").click();
    await answered.settle();
    expect(items(answered)).toHaveLength(0);
  });

  it("a delete that fails keeps the question open with the reason, reads the list again and gives every button back; one already gone counts as deleted", async () => {
    const cases: [Answer, string][] = [
      [{ status: 500, json: { error: "internal" } }, FAILED],
      [{ status: 429, json: { error: "rate_limited" } }, TOO_MANY],
      [{ status: 400, json: { error: "bad_request" } }, FAILED],
      ["network", FAILED],
    ];
    for (const [answer, text] of cases) {
      const what = JSON.stringify(answer);
      // A lost answer asks the item, which is still online.
      const tab = openPage("images", standard("images", { [`DELETE /api/v1/media/${M1}`]: [answer, { status: 404, json: { error: "not_found" } }], [`GET /api/v1/media/${M1}`]: { status: 200, json: { ...MOCKUP_IMAGES[0], state: "online" } }, [`GET ${IMAGES_LIST}`]: [list(MOCKUP_IMAGES), list(MOCKUP_IMAGES), list(MOCKUP_IMAGES.slice(1))] }));
      await tab.settle();
      pressDelete(rows(tab)[0]);
      tab.$("delete-go").click();
      await tab.settle();
      expect(deletes(tab), what).toHaveLength(1);
      expect(tab.$("delete-dialog").hidden, what).toBe(false);
      expect([tab.$("delete-message").textContent, tab.$("delete-message").hidden], what).toEqual([text, false]);
      expect(lists(tab), what).toHaveLength(2);
      expect(rows(tab), what).toHaveLength(3);
      expect([tab.$("delete-go").textContent, tab.$("delete-go").disabled, tab.$("delete-keep").disabled], what).toEqual(["Delete image", false, false]);
      for (const b of rowButtons(tab)) expect(b.disabled, `${what} ${b.textContent}`).toBe(false);
      tab.$("delete-go").click();
      await tab.settle();
      expect(tab.$("delete-dialog").hidden, what).toBe(true);
      expect(rows(tab), what).toHaveLength(2);
    }
    // Keep it after a failed delete gives the focus to the row's More as the list now shows it.
    const kept = openPage("images", standard("images", { [`DELETE /api/v1/media/${M1}`]: { status: 500, json: { error: "internal" } } }));
    await kept.settle();
    pressDelete(rows(kept)[0]);
    kept.$("delete-go").click();
    await kept.settle();
    kept.$("delete-keep").click();
    expect(kept.doc.activeElement).toBe(byText(rows(kept)[0], "More"));
    // A lost session goes to sign in.
    const out = openPage("images", standard("images", { [`DELETE /api/v1/media/${M1}`]: SIGNED_OUT }));
    await out.settle();
    pressDelete(rows(out)[0]);
    out.$("delete-go").click();
    await out.settle();
    expect(out.left()).toBe("/signin");
  });

  it("a delete that worked but whose list cannot be read again keeps the list as last known and says so", async () => {
    for (const reload of [{ status: 500, json: { error: "internal" } }, "network"] as Answer[]) {
      const what = JSON.stringify(reload);
      const tab = openPage("images", standard("images", { [`DELETE /api/v1/media/${M2}`]: { status: 204 }, [`GET ${IMAGES_LIST}`]: [list(MOCKUP_IMAGES), reload] }));
      await tab.settle();
      pressDelete(rows(tab)[1]);
      tab.$("delete-go").click();
      await tab.settle();
      expect(tab.$("delete-dialog").hidden, what).toBe(true);
      expect([tab.$("media-message").textContent, tab.$("media-message").hidden], what).toEqual([NOT_RELOADED, false]);
      expect(rows(tab), what).toHaveLength(3);
      for (const b of rowButtons(tab)) expect(b.disabled, `${what} ${b.textContent}`).toBe(false);
      expect(tab.$("dash-load").textContent, what).toBe("");
      expect(tab.doc.activeElement, what).toBe(tab.$("h-page"));
    }
  });

  it("Delete pressed twice sends one delete, and no row's button can start anything while it runs", async () => {
    const held = holding((req) => req.method === "DELETE", standard("images", { [`GET ${IMAGES_LIST}`]: [list(MOCKUP_IMAGES), list(MOCKUP_IMAGES.slice(1))] }));
    const tab = openPage("images", held.respond);
    await tab.settle();
    pressDelete(rows(tab)[0]);
    tab.$("delete-go").click();
    tab.$("delete-go").click();
    tab.$("delete-go").dispatch("click");
    await tab.settle();
    expect(deletes(tab)).toHaveLength(1);
    for (const b of rowButtons(tab)) expect(b.disabled, b.textContent).toBe(true);
    expect(byText(rows(tab)[1], "More").click()).toBeNull();
    held.answer({ status: 204 });
    await tab.settle();
    expect(deletes(tab)).toHaveLength(1);
    expect(rows(tab)).toHaveLength(2);
    for (const b of rowButtons(tab)) expect(b.disabled, b.textContent).toBe(false);
  });
});

// ---- Selecting items, and deleting what is selected (the approved multi-select mockup) ----

const QUESTION_SOME = "Their links stop working for everyone and they are removed. The copies on your computer are not touched.";
/** Five images, newest first. */
const FIVE = [
  image(M1, "a1a1abcdefghijklmnop", { title: "Loot window, settings tab" }),
  image(M2, "b2b2abcdefghijklmnop", { title: "Timeline, boss two" }),
  image(M3, "c3c3abcdefghijklmnop", { title: null }),
  image(M4, "d4d4abcdefghijklmnop", { title: "Raid frames" }),
  image(M5, "e5e5abcdefghijklmnop", { title: "Note sent" }),
];
const pickIn = (row: FakeElement) => cells(row)[0].all().find((e) => e.tagName === "input")!;
const picks = (tab: Tab) => rows(tab).map((row) => pickIn(row).checked);
/** What the selection shows: the header's words, checked and mixed; the bar; the polite line. */
const picked = (tab: Tab) => ({
  header: tab.$("media-all-text").textContent,
  checked: tab.$("media-all").checked,
  mixed: tab.$("media-all").indeterminate,
  bar: tab.$("pick-bar").shown ? tab.$("pick-count").textContent : null,
  said: tab.$("pick-said").textContent,
});
const titled = (tab: Tab) => rows(tab).map((row) => titleOf(row).textContent);
/** Runs every pause the script set, until nothing more happens. */
async function drain(tab: Tab): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await tab.settle();
    tab.tick();
  }
  await tab.settle();
}
/** Selects the rows at these places by clicking their checkboxes, as a person does (Space on one does the same). */
const select = (tab: Tab, ...at: number[]) => {
  for (const i of at) pickIn(rows(tab)[i]).click();
};
const DELETE = (id: string) => `DELETE /api/v1/media/${id}`;
const NOT_FOUND_ANSWER: Answer = { status: 404, json: { error: "not_found" } };
const PENDING: Answer = { status: 500, json: { error: "cleanup_pending" } };

describe("selecting items", () => {
  it("every row starts with a checkbox named for its item; the header selects exactly the items shown and is mixed while some are", async () => {
    const tab = openPage("images", standard("images", { [`GET ${IMAGES_LIST}`]: list(FIVE) }));
    await tab.settle();
    // The checkbox is the first cell and the first control of its row, a real checkbox (Space toggles it), named for a screen reader.
    for (const row of rows(tab)) {
      const box = pickIn(row);
      expect([cells(row)[0].className, box.tagName, box.type, box.className, box.checked]).toEqual(["pick-cell", "input", "checkbox", "pick", false]);
      expect(row.all().filter((e) => ["input", "button", "a"].includes(e.tagName))[0]).toBe(box);
    }
    expect(rows(tab).map((row) => pickIn(row).getAttribute("aria-label"))).toEqual(["Select Loot window, settings tab", "Select Timeline, boss two", "Select Untitled image", "Select Raid frames", "Select Note sent"]);
    expect(picked(tab)).toEqual({ header: "Select all 5 shown", checked: false, mixed: false, bar: null, said: "" });

    select(tab, 1);
    expect(picks(tab)).toEqual([false, true, false, false, false]);
    expect(picked(tab)).toEqual({ header: "Select all 5 shown", checked: false, mixed: true, bar: "1 selected", said: "1 selected" });
    // The bar, with what it shows: the count (also said politely), Clear and the red Delete selected.
    const shown = tab.shows();
    expect(shown.filter((t) => t === "1 selected")).toHaveLength(1);
    expect(shown.slice(shown.indexOf("1 selected"), shown.indexOf("1 selected") + 4)).toEqual(["1 selected", "Clear", "Delete selected", "Select all 5 shown"]);
    expect(tab.$("pick-count").textContent).toBe("1 selected");
    expect([tab.$("pick-delete").className, tab.$("pick-clear").className]).toEqual(["btn danger", "btn quiet"]);
    select(tab, 3);
    expect(picked(tab)).toEqual({ header: "Select all 5 shown", checked: false, mixed: true, bar: "2 selected", said: "2 selected" });
    // Select all from the mixed state: every item shown.
    tab.$("media-all").click();
    expect(picks(tab)).toEqual([true, true, true, true, true]);
    expect(picked(tab)).toEqual({ header: "Select all 5 shown", checked: true, mixed: false, bar: "5 selected", said: "5 selected" });
    // One off again: mixed.
    select(tab, 0);
    expect(picked(tab)).toEqual({ header: "Select all 5 shown", checked: false, mixed: true, bar: "4 selected", said: "4 selected" });
    select(tab, 0);
    // Select all when all are selected: none.
    tab.$("media-all").click();
    expect(picks(tab)).toEqual([false, false, false, false, false]);
    expect(picked(tab)).toEqual({ header: "Select all 5 shown", checked: false, mixed: false, bar: null, said: "" });
    // Clear: nothing selected, the bar goes, and the focus is on the header's checkbox.
    select(tab, 2, 4);
    tab.$("pick-clear").click();
    expect(picks(tab)).toEqual([false, false, false, false, false]);
    expect(picked(tab)).toEqual({ header: "Select all 5 shown", checked: false, mixed: false, bar: null, said: "" });
    expect(tab.doc.activeElement).toBe(tab.$("media-all"));
    // Selecting asks the server nothing.
    expect(tab.fetched.map((f) => `${f.method} ${f.path}`).sort()).toEqual(["GET /api/v1/media?kind=image", "GET /api/v1/session", "GET /api/v1/usage"]);
    // A reload starts with nothing selected: the selection was kept in no storage (the tab's use of any is a violation) and in no address.
    const again = openPage("images", standard("images", { [`GET ${IMAGES_LIST}`]: list(FIVE) }));
    await again.settle();
    expect(picks(again)).toEqual([false, false, false, false, false]);
    expect(picked(again).bar).toBeNull();
  });

  it("Select all selects only the items shown; Show more adds items unselected and the header's count and state follow", async () => {
    const CURSOR = "MTc2MzU1MzYwMDAwMC5tZWRfMjIy";
    const tab = openPage("images", standard("images", { [`GET ${IMAGES_LIST}`]: list(FIVE.slice(0, 2), CURSOR), [`GET ${IMAGES_LIST}&cursor=${CURSOR}`]: list(FIVE.slice(2)) }));
    await tab.settle();
    expect(picked(tab).header).toBe("Select all 2 shown");
    tab.$("media-all").click();
    expect(picked(tab)).toEqual({ header: "Select all 2 shown", checked: true, mixed: false, bar: "2 selected", said: "2 selected" });
    // The question is about the two shown, not the items behind Show more.
    tab.$("pick-delete").click();
    expect(tab.$("bulk-title").textContent).toBe("Delete 2 images?");
    tab.$("bulk-keep").click();
    tab.$("media-more").click();
    await tab.settle();
    expect(rows(tab)).toHaveLength(5);
    expect(picks(tab)).toEqual([true, true, false, false, false]);
    expect(picked(tab)).toEqual({ header: "Select all 5 shown", checked: false, mixed: true, bar: "2 selected", said: "2 selected" });
    tab.$("media-all").click();
    expect(picked(tab)).toEqual({ header: "Select all 5 shown", checked: true, mixed: false, bar: "5 selected", said: "5 selected" });
  });

  it("shows hostile titles as text in the row and in the checkbox's name, and never in the question's title", async () => {
    const hostile = ['<img src=x onerror="alert(1)">', '"quoted" & \'single\'', "‮evil.exe‬ reversed", "x".repeat(5000)];
    const ids = [M1, M2, M3, M4];
    const tab = openPage("images", standard("images", { [`GET ${IMAGES_LIST}`]: list(hostile.map((title, i) => image(ids[i], `abc${i}defghijklmnopq`, { title, has_preview: false }))) }));
    await tab.settle();
    expect(titled(tab)).toEqual(hostile);
    expect(rows(tab).map((row) => pickIn(row).getAttribute("aria-label"))).toEqual(hostile.map((t) => "Select " + t));
    for (const row of rows(tab)) expect(titleOf(row).children.every((c) => !(c instanceof FakeElement))).toBe(true);
    tab.$("media-all").click();
    tab.$("pick-delete").click();
    expect([tab.$("bulk-title").textContent, tab.$("bulk-go").textContent, tab.$("bulk-text").textContent]).toEqual(["Delete 4 images?", "Delete 4 images", QUESTION_SOME]);
    expect(tab.$("bulk-title").children.every((c) => !(c instanceof FakeElement))).toBe(true);
    const box = tab.$("bulk-box");
    for (const t of hostile) expect(box.textContent).not.toContain(t.slice(0, 20));
    expect(tab.doc.root.all().filter((e) => ["img", "script", "b"].includes(e.tagName) && !isBrandMark(e) && e.parent?.tagName !== "head")).toEqual([]);
  });
});

describe("deleting the selected items", () => {
  it("asks with the approved words for one and for several, on both pages, with the page behind inert, and sends nothing before the press", async () => {
    const words = {
      images: { three: ["Delete 3 images?", QUESTION_SOME, NO_BACKUPS, "Keep them", "Delete 3 images"], one: ["Delete 1 image?", QUESTION, NO_BACKUPS, "Keep it", "Delete 1 image"] },
      gifs: { three: ["Delete 3 GIFs?", QUESTION_SOME, NO_BACKUPS, "Keep them", "Delete 3 GIFs"], one: ["Delete 1 GIF?", QUESTION, NO_BACKUPS, "Keep it", "Delete 1 GIF"] },
    };
    for (const which of ["images", "gifs"] as const) {
      const tab = openPage(which, standard(which));
      await tab.settle();
      tab.$("media-all").click();
      const go = tab.$("pick-delete");
      go.click();
      expect(tab.$("bulk-dialog").hidden, which).toBe(false);
      expect(tab.shows().slice(-5), which).toEqual(words[which].three);
      expect(tab.$("bulk-warn").className).toBe("danger-line");
      expect(tab.doc.activeElement, which).toBe(tab.$("bulk-keep"));
      for (const id of ["dash-top", "media-page", "source-line"]) expect([tab.$(id).getAttribute("inert"), tab.$(id).getAttribute("aria-hidden")], `${which} ${id}`).toEqual(["", "true"]);
      // Tab goes round its two buttons.
      key(tab.$("bulk-keep"), "Tab");
      expect(tab.doc.activeElement).toBe(tab.$("bulk-go"));
      key(tab.$("bulk-go"), "Tab");
      expect(tab.doc.activeElement).toBe(tab.$("bulk-keep"));
      // Keep them, Escape and the backdrop close it with nothing sent, the selection kept and the focus back on Delete selected.
      tab.$("bulk-keep").click();
      expect([tab.$("bulk-dialog").hidden, tab.doc.activeElement === go, picked(tab).bar]).toEqual([true, true, "3 selected"]);
      go.click();
      key(tab.doc.body, "Escape");
      expect([tab.$("bulk-dialog").hidden, tab.doc.activeElement === go]).toEqual([true, true]);
      go.click();
      tab.$("bulk-dialog").click();
      expect([tab.$("bulk-dialog").hidden, tab.doc.activeElement === go]).toEqual([true, true]);
      for (const id of ["dash-top", "media-page", "source-line"]) expect([tab.$(id).hasAttribute("inert"), tab.$(id).hasAttribute("aria-hidden")], id).toEqual([false, false]);
      expect(markupOf(tab.$("source-line"))).toBe(SOURCE_FOOTER);
      // One selected: the single sentence and "Keep it".
      tab.$("pick-clear").click();
      select(tab, 1);
      go.click();
      expect(tab.shows().slice(-5), which).toEqual(words[which].one);
      tab.$("bulk-keep").click();
      // The single delete's question has the same red line, word for word.
      pressDelete(rows(tab)[0]);
      expect(tab.shows().slice(-5).slice(1, 3), which).toEqual([QUESTION, NO_BACKUPS]);
      expect(tab.$("delete-warn").textContent).toBe(tab.$("bulk-warn").textContent);
      tab.$("delete-keep").click();
      expect(tab.fetched.filter((f) => f.method !== "GET"), which).toEqual([]);
    }
  });

  it("deletes one after another through the item's own route, counting 204, 404, cleanup_pending and a lost answer the item says is gone; then reads the list again and says so", async () => {
    let running = 0;
    let most = 0;
    const base = standard("images", {
      [`GET ${IMAGES_LIST}`]: [list(FIVE), list([])],
      [DELETE(M1)]: { status: 204 },
      [DELETE(M2)]: NOT_FOUND_ANSWER,
      [DELETE(M3)]: [PENDING, { status: 204 }],
      [DELETE(M4)]: PENDING,
      [DELETE(M5)]: "network",
      [`GET /api/v1/media/${M5}`]: NOT_FOUND_ANSWER,
    });
    const tab = openPage("images", async (req) => {
      if (req.method !== "DELETE") return base(req);
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setImmediate(r));
      running--;
      return base(req);
    });
    await tab.settle();
    tab.$("media-all").click();
    tab.$("pick-delete").click();
    tab.$("bulk-go").click();
    await drain(tab);
    // In the list's order, never two at once, each with the anti-forgery header and no body; cleanup_pending sent again within the same limits.
    expect(deletes(tab).map((f) => f.path.slice("/api/v1/media/".length))).toEqual([M1, M2, M3, M3, M4, M4, M4, M5]);
    expect(most).toBe(1);
    for (const f of deletes(tab)) expect([f.headers["X-Csrf-Token"], f.body]).toEqual([CSRF, undefined]);
    expect(tab.delays).toEqual([400, 400, 1200]);
    expect(tab.fetched.filter((f) => f.method === "GET" && f.path === `/api/v1/media/${M5}`)).toHaveLength(1);
    // No new route: only the item's own delete, and the item read after a lost answer.
    expect(tab.fetched.filter((f) => !f.path.startsWith("/api/v1/media/") && !f.path.startsWith(IMAGES_LIST) && f.path !== "/api/v1/usage" && f.path !== "/api/v1/session")).toEqual([]);
    // The list is read again; the question is closed; the sentence is plain; nothing is selected; the focus is on the heading.
    expect(lists(tab)).toHaveLength(2);
    expect(tab.$("bulk-dialog").hidden).toBe(true);
    expect([tab.$("media-message").textContent, tab.$("media-message").className, tab.$("media-message").hidden]).toEqual(["5 images deleted.", "message plain", false]);
    expect(tab.$("media-empty").shown).toBe(true);
    expect(picked(tab)).toEqual({ header: "Select all 0 shown", checked: false, mixed: false, bar: null, said: "" });
    expect(tab.doc.activeElement).toBe(tab.$("h-page"));
    expect([tab.$("bulk-go").disabled, tab.$("bulk-keep").disabled, tab.$("bulk-go").getAttribute("aria-busy")]).toEqual([false, false, null]);
    // The sentence goes with the next change.
    const one = openPage("gifs", standard("gifs", { [`GET ${GIFS_LIST}`]: [list(MOCKUP_GIFS), list(MOCKUP_GIFS.slice(1))], [DELETE(M1)]: { status: 204 } }));
    await one.settle();
    select(one, 0);
    one.$("pick-delete").click();
    one.$("bulk-go").click();
    await drain(one);
    expect(one.$("media-message").textContent).toBe("1 GIF deleted.");
    expect(titled(one)).toEqual(["Loot council vote, full round", "Untitled GIF"]);
  });

  it("shows its progress politely while it runs, and nothing can start a second run", async () => {
    const held = holding((req) => req.method === "DELETE", standard("images", { [`GET ${IMAGES_LIST}`]: [list(FIVE), list(FIVE.slice(3))] }));
    const tab = openPage("images", held.respond);
    await tab.settle();
    select(tab, 0, 1, 2);
    tab.$("pick-delete").click();
    const go = tab.$("bulk-go");
    go.click();
    go.click();
    go.dispatch("click");
    await tab.settle();
    expect(deletes(tab)).toHaveLength(1);
    const progress = tab.$("bulk-progress");
    expect([progress.textContent, progress.hidden, progress.getAttribute("role"), progress.getAttribute("aria-live")]).toEqual(["Deleting 1 of 3…", false, "status", "polite"]);
    expect([go.textContent, go.disabled, go.getAttribute("aria-busy"), tab.$("bulk-keep").disabled]).toEqual(["Deleting…", true, "true", true]);
    // Escape, the backdrop and the page behind do nothing meanwhile.
    key(tab.doc.body, "Escape");
    tab.$("bulk-dialog").click();
    expect(tab.$("bulk-dialog").hidden).toBe(false);
    for (const id of ["media-all", "pick-clear", "pick-delete"]) expect(tab.$(id).disabled, id).toBe(true);
    for (const row of rows(tab)) expect(pickIn(row).disabled).toBe(true);
    for (const b of rowButtons(tab)) expect(b.disabled, b.textContent).toBe(true);
    expect(tab.$("pick-delete").click()).toBeNull();
    expect(pickIn(rows(tab)[4]).click()).toBeNull();
    expect(byText(rows(tab)[4], "More").click()).toBeNull();
    // Tab stays on the question's title while it runs.
    key(go, "Tab");
    expect(tab.doc.activeElement).toBe(tab.$("bulk-title"));
    held.answer({ status: 204 });
    await tab.settle();
    expect(deletes(tab)).toHaveLength(2);
    expect(progress.textContent).toBe("Deleting 2 of 3…");
    go.dispatch("click");
    held.answer({ status: 204 });
    await tab.settle();
    expect(progress.textContent).toBe("Deleting 3 of 3…");
    held.answer({ status: 204 });
    await tab.settle();
    expect(deletes(tab).map((f) => f.path)).toEqual([M1, M2, M3].map((id) => `/api/v1/media/${id}`));
    expect(tab.$("bulk-dialog").hidden).toBe(true);
    expect(tab.$("media-message").textContent).toBe("3 images deleted.");
    expect(titled(tab)).toEqual(["Raid frames", "Note sent"]);
    // Nothing more is sent by a press after it ended.
    go.dispatch("click");
    await tab.settle();
    expect(deletes(tab)).toHaveLength(3);
    // The next question starts without the last run's progress.
    select(tab, 0);
    tab.$("pick-delete").click();
    expect([progress.hidden, progress.textContent]).toEqual([true, ""]);
  });

  it("stops at the first refusal or failure that lasts, on the first or a later item; the rest stay listed and selected, with the sentence", async () => {
    const STILL = (it: Record<string, unknown>): Answer => ({ status: 200, json: { ...it, state: "online" } });
    const cases: { name: string; table: Record<string, Answer | Answer[]>; sent: string[]; after: unknown[]; text: string }[] = [
      { name: "403 on the first", table: { [DELETE(M1)]: { status: 403, json: { error: "read_only" } } }, sent: [M1], after: FIVE.slice(0, 3), text: `0 of 3 images deleted. The rest are still here. ${FAILED}` },
      { name: "403 on the third", table: { [DELETE(M1)]: { status: 204 }, [DELETE(M2)]: { status: 204 }, [DELETE(M3)]: { status: 403, json: { error: "read_only" } } }, sent: [M1, M2, M3], after: [FIVE[2]], text: `2 of 3 images deleted. The rest are still here. ${FAILED}` },
      { name: "500 on the second", table: { [DELETE(M1)]: { status: 204 }, [DELETE(M2)]: { status: 500, json: { error: "internal" } } }, sent: [M1, M2], after: FIVE.slice(1, 3), text: `1 of 3 images deleted. The rest are still here. ${FAILED}` },
      { name: "429 on the second", table: { [DELETE(M1)]: { status: 204 }, [DELETE(M2)]: { status: 429, json: { error: "rate_limited" } } }, sent: [M1, M2], after: FIVE.slice(1, 3), text: `1 of 3 images deleted. The rest are still here. ${TOO_MANY}` },
      { name: "network, the item still there", table: { [DELETE(M1)]: { status: 204 }, [DELETE(M2)]: "network", [`GET /api/v1/media/${M2}`]: STILL(FIVE[1]) }, sent: [M1, M2], after: FIVE.slice(1, 3), text: `1 of 3 images deleted. The rest are still here. ${FAILED}` },
      { name: "network, the item not answering", table: { [DELETE(M1)]: "network", [`GET /api/v1/media/${M1}`]: "network" }, sent: [M1], after: FIVE.slice(0, 3), text: `0 of 3 images deleted. The rest are still here. ${FAILED}` },
    ];
    for (const c of cases) {
      const tab = openPage("images", standard("images", { [`GET ${IMAGES_LIST}`]: [list(FIVE), list([...c.after, ...FIVE.slice(3)])], ...c.table }));
      await tab.settle();
      select(tab, 0, 1, 2);
      tab.$("pick-delete").click();
      tab.$("bulk-go").click();
      await drain(tab);
      expect(deletes(tab).map((f) => f.path.slice("/api/v1/media/".length)), c.name).toEqual(c.sent);
      expect(lists(tab), c.name).toHaveLength(2);
      expect(tab.$("bulk-dialog").hidden, c.name).toBe(true);
      expect([tab.$("media-message").textContent, tab.$("media-message").className, tab.$("media-message").hidden], c.name).toEqual([c.text, "message", false]);
      // What the server listed again is shown; what was not deleted is still selected, and nothing else.
      const left = c.after.length;
      expect(picks(tab), c.name).toEqual([...Array(left).fill(true), false, false]);
      expect(picked(tab).bar, c.name).toBe(`${left} selected`);
      // The focus is on Delete selected, to try again; every control works again.
      expect(tab.doc.activeElement, c.name).toBe(tab.$("pick-delete"));
      for (const b of [...rowButtons(tab), tab.$("pick-delete"), tab.$("pick-clear"), tab.$("media-all")]) expect(b.disabled, `${c.name} ${b.textContent}`).toBe(false);
    }
  });

  it("a lost session goes to sign in and sends nothing more; a list that cannot be read again keeps what it showed, says so, and unselects what was deleted", async () => {
    const out = openPage("images", standard("images", { [`GET ${IMAGES_LIST}`]: list(FIVE), [DELETE(M1)]: { status: 204 }, [DELETE(M2)]: SIGNED_OUT }));
    await out.settle();
    select(out, 0, 1, 2);
    out.$("pick-delete").click();
    out.$("bulk-go").click();
    await drain(out);
    expect(out.left()).toBe("/signin");
    expect(deletes(out)).toHaveLength(2);
    expect(lists(out)).toHaveLength(1);

    for (const reload of [{ status: 500, json: { error: "internal" } }, "network"] as Answer[]) {
      const what = JSON.stringify(reload);
      const tab = openPage("images", standard("images", { [`GET ${IMAGES_LIST}`]: [list(FIVE), reload], [DELETE(M1)]: { status: 204 }, [DELETE(M2)]: { status: 204 } }));
      await tab.settle();
      select(tab, 0, 1);
      tab.$("pick-delete").click();
      tab.$("bulk-go").click();
      await drain(tab);
      expect(tab.$("media-message").textContent, what).toBe(`2 images deleted. ${NOT_RELOADED}`);
      expect(tab.$("media-message").className, what).toBe("message");
      expect(rows(tab), what).toHaveLength(5);
      expect(picks(tab), what).toEqual([false, false, false, false, false]);
      expect(picked(tab).bar, what).toBeNull();
      expect(tab.doc.activeElement, what).toBe(tab.$("h-page"));
    }
  });

  it("a delete in More clears the selection once the list is read again; a change of who can view keeps it", async () => {
    const tab = openPage("images", standard("images", { [`GET ${IMAGES_LIST}`]: [list(FIVE), list(FIVE.slice(1))], [DELETE(M1)]: { status: 204 } }));
    await tab.settle();
    select(tab, 2, 3);
    pressDelete(rows(tab)[0]);
    tab.$("delete-go").click();
    await tab.settle();
    expect(titled(tab)).toHaveLength(4);
    expect(picks(tab)).toEqual([false, false, false, false]);
    expect(picked(tab)).toEqual({ header: "Select all 4 shown", checked: false, mixed: false, bar: null, said: "" });
    // A failed delete in More is read again too, and clears it as well.
    const failed = openPage("images", standard("images", { [`GET ${IMAGES_LIST}`]: list(FIVE), [DELETE(M1)]: { status: 500, json: { error: "internal" } } }));
    await failed.settle();
    select(failed, 1);
    pressDelete(rows(failed)[0]);
    failed.$("delete-go").click();
    await failed.settle();
    expect(failed.$("delete-message").textContent).toBe(FAILED);
    expect(picked(failed).bar).toBeNull();
  });

  it("sends only ids of the workspace's own list: an id written into the page's checkbox is never sent, and an item whose id is not the API's has no checkbox", async () => {
    const OTHER = "med_" + "f".repeat(24);
    const tab = openPage("images", standard("images", { [`GET ${IMAGES_LIST}`]: [list([FIVE[0], image("med_xyz", "zzzzabcdefghijklmnop", { title: "Bad id" }), FIVE[1]]), list([])], [DELETE(M1)]: { status: 204 }, [DELETE(M2)]: { status: 204 } }));
    await tab.settle();
    expect(titled(tab)).toEqual(["Loot window, settings tab", "Timeline, boss two"]);
    for (const row of rows(tab)) {
      const box = pickIn(row);
      box.setAttribute("value", OTHER);
      box.setAttribute("aria-label", "Select " + OTHER);
      box.setAttribute("id", OTHER);
    }
    tab.$("media-all").click();
    tab.$("pick-delete").click();
    tab.$("bulk-go").click();
    await drain(tab);
    expect(deletes(tab).map((f) => f.path)).toEqual([`/api/v1/media/${M1}`, `/api/v1/media/${M2}`]);
    expect(tab.fetched.some((f) => f.path.includes(OTHER) || f.path.includes("med_xyz"))).toBe(false);
  });
});

describe("signing in and failures", () => {
  it("sends a visitor who is not signed in to /signin and asks nothing else, on both pages", async () => {
    for (const which of ["images", "gifs"] as const) {
      const tab = openPage(which, answers({ "GET /api/v1/session": SIGNED_OUT }));
      await tab.settle();
      expect(tab.left(), which).toBe("/signin");
      expect(tab.fetched.map((f) => `${f.method} ${f.path}`), which).toEqual(["GET /api/v1/session"]);
      expect(tab.$("media").hidden, which).toBe(true);
      // A session that ends before the list answers goes there too.
      const later = openPage(which, standard(which, { [`GET ${which === "images" ? IMAGES_LIST : GIFS_LIST}`]: SIGNED_OUT }));
      await later.settle();
      expect(later.left(), which).toBe("/signin");
      expect(later.$("media").hidden, which).toBe(true);
    }
  });

  it("says when the list cannot be read, with the approved sentences", async () => {
    for (const [answer, text] of [[{ status: 500, json: { error: "internal" } }, FAILED], [{ status: 429, json: { error: "rate_limited" } }, TOO_MANY], ["network", FAILED], [{ status: 200, json: { items: "x" } }, FAILED], [{ status: 200, json: null }, FAILED]] as [Answer, string][]) {
      const tab = openPage("gifs", standard("gifs", { [`GET ${GIFS_LIST}`]: answer }));
      await tab.settle();
      expect(tab.$("dash-load").textContent, JSON.stringify(answer)).toBe(text);
      expect(tab.$("media").hidden).toBe(true);
      expect(tab.left()).toBeNull();
    }
  });
});

// ---- Against the real app ----

/** A tab's fetch to the real app on the app address, as a browser sends it there, with a session cookie. */
function browser(deps: Deps, cookie: string) {
  const app = createApp(deps);
  return async (req: Fetched): Promise<Answer> => {
    const headers: Record<string, string> = { ...req.headers, "user-agent": FIREFOX, cookie };
    if (req.method !== "GET" && req.method !== "HEAD") Object.assign(headers, { origin: APP, "sec-fetch-site": "same-origin" });
    const res = await app.fetch(new Request(APP + req.path, { method: req.method, headers, body: req.body }));
    const text = await res.text();
    return { status: res.status, json: text === "" ? undefined : JSON.parse(text) };
  };
}

/** Shares one item through the API with the recorder's token: create, its one part, an optional preview, commit. */
async function share(deps: Deps, token: string, spec: { kind: "image" | "clip"; content_type: string; file: Uint8Array; width: number; height: number; duration_ms?: number; title?: string }, preview?: Uint8Array): Promise<string> {
  const { file, ...rest } = spec;
  expect(file.length).toBeLessThanOrEqual(PART_BYTES);
  const made = await send(deps, "POST", "/api/v1/media", { token, body: JSON.stringify({ ...rest, bytes: file.length }), headers: { "content-type": "application/json" } });
  expect(made.status, made.text).toBe(201);
  const id = made.json.id as string;
  expect((await send(deps, "PUT", `/api/v1/media/${id}/parts/0`, { token, body: file as NonNullable<RequestInit["body"]> })).status).toBe(204);
  if (preview) {
    const p = await send(deps, "PUT", `/api/v1/media/${id}/preview`, { token, body: preview as NonNullable<RequestInit["body"]> });
    expect(p.status, p.text).toBe(204);
  }
  expect((await send(deps, "POST", `/api/v1/media/${id}/commit`, { token })).status).toBe(200);
  return id;
}

describe("the line from the usage", () => {
  /** A usage answer with these numbers for images and GIFs (the rest as the page does not read them). */
  const usageOf = (n: { images?: number; gifs?: number; imageBytes?: number; gifBytes?: number }): Answer => ({
    status: 200,
    json: {
      used_bytes: (n.imageBytes ?? 0) + (n.gifBytes ?? 0),
      allowance_bytes: null,
      over: false,
      tours: 0,
      images: n.images ?? 0,
      gifs: n.gifs ?? 0,
      counted: { pictures: 0, logos: 0, uploads_in_progress: 0, images: n.imageBytes ?? 0, gifs: n.gifBytes ?? 0 },
    },
  });
  const CURSOR = "MTc2MzU1MzYwMDAwMC5tZWRfMjIy";

  it("shows mockups 3 and 4 from the first load, with the whole count and size though the list has another page", async () => {
    const images = openPage("images", standard("images", { "GET /api/v1/usage": usageOf({ images: 48, imageBytes: 64 * MB }), [`GET ${IMAGES_LIST}`]: list(MOCKUP_IMAGES.slice(0, 2), CURSOR) }));
    await images.settle();
    expect(line(images)).toBe("48 images in Cowfee Raid Tools · 64 MB used");
    expect(images.$("media-more").shown).toBe(true);
    const gifs = openPage("gifs", standard("gifs", { "GET /api/v1/usage": usageOf({ gifs: 9, gifBytes: 250 * MB, images: 3, imageBytes: MB }) }));
    await gifs.settle();
    expect(line(gifs)).toBe("9 GIFs in Cowfee Raid Tools · 250 MB used");
    // The usage is read beside the list, once per read.
    expect(gifs.fetched.filter((f) => f.path === "/api/v1/usage")).toHaveLength(1);
  });

  it("writes one in the singular and none as 0", async () => {
    for (const [which, n, text] of [
      ["images", { images: 1, imageBytes: 1_468_006 }, "1 image in Cowfee Raid Tools · 1.4 MB used"],
      ["gifs", { gifs: 1, gifBytes: 18 * MB }, "1 GIF in Cowfee Raid Tools · 18 MB used"],
      ["images", { images: 0, imageBytes: 0 }, "0 images in Cowfee Raid Tools · 0 bytes used"],
    ] as const) {
      const tab = openPage(which, standard(which, { "GET /api/v1/usage": usageOf(n) }));
      await tab.settle();
      expect(line(tab), text).toBe(text);
    }
  });

  it("when the usage cannot be read, the line is made from the list as before, and no error is shown", async () => {
    for (const usage of [{ status: 500, json: { error: "internal" } }, { status: 429, json: { error: "rate_limited" } }, "network", { status: 200, json: { images: "48" } }, { status: 200, json: { images: 4, counted: { images: -1 } } }] as Answer[]) {
      const tab = openPage("images", standard("images", { "GET /api/v1/usage": usage, [`GET ${IMAGES_LIST}`]: list(MOCKUP_IMAGES.slice(0, 2), CURSOR) }));
      await tab.settle();
      const what = JSON.stringify(usage);
      expect(line(tab), what).toBe("The newest 2 images in Cowfee Raid Tools");
      expect([tab.$("dash-load").textContent, tab.$("media-message").hidden], what).toEqual(["", true]);
      expect(rows(tab), what).toHaveLength(2);
    }
  });

  it("is read again after a delete, and a usage that fails then falls back without an error", async () => {
    const tab = openPage(
      "images",
      standard("images", {
        [`DELETE /api/v1/media/${M2}`]: { status: 204 },
        [`GET ${IMAGES_LIST}`]: [list(MOCKUP_IMAGES), list([MOCKUP_IMAGES[0], MOCKUP_IMAGES[2]])],
        "GET /api/v1/usage": [usageOf({ images: 48, imageBytes: 64 * MB }), usageOf({ images: 47, imageBytes: 63 * MB + 400 * KB })],
      }),
    );
    await tab.settle();
    expect(line(tab)).toBe("48 images in Cowfee Raid Tools · 64 MB used");
    pressDelete(rows(tab)[1]);
    tab.$("delete-go").click();
    await tab.settle();
    expect(tab.fetched.filter((f) => f.path === "/api/v1/usage")).toHaveLength(2);
    expect(line(tab)).toBe("47 images in Cowfee Raid Tools · 63.4 MB used");
    expect(tab.$("media-message").hidden).toBe(true);

    const fails = openPage(
      "gifs",
      standard("gifs", {
        [`DELETE /api/v1/media/${M1}`]: { status: 204 },
        [`GET ${GIFS_LIST}`]: [list(MOCKUP_GIFS), list(MOCKUP_GIFS.slice(1))],
        "GET /api/v1/usage": [usageOf({ gifs: 9, gifBytes: 250 * MB }), { status: 500, json: { error: "internal" } }],
      }),
    );
    await fails.settle();
    pressDelete(rows(fails)[0]);
    fails.$("delete-go").click();
    await fails.settle();
    expect(line(fails)).toBe("2 GIFs in Cowfee Raid Tools · 100.2 MB used");
    expect([fails.$("media-message").hidden, fails.$("delete-dialog").hidden]).toEqual([true, true]);
  });
});

describe("the Images and GIFs pages against the real app", () => {
  it("list each kind on its own page with its link on the img address, load the preview with the session, and delete through the API", async () => {
    const { deps } = await makeDeps({ hosts: { tours: "tours.example.com", app: "app.example.com", img: "img.example.com" } });
    await seedAccount(deps, { admin: true, username: "mediareal-admin" });
    const owner = await seedAccount(deps, { username: "mediareal" });
    const made = await redeemSignInCode(deps, await createSignInCode(deps, owner.userId), FIREFOX, null);
    const cookie = `${SESSION_COOKIE}=${made!.secret}`;

    const empty = openPage("images", browser(deps, cookie));
    await empty.settle();
    expect(empty.$("dash-user").textContent).toBe("mediareal");
    expect(empty.$("media-empty").shown).toBe(true);

    const imageId = await share(deps, owner.token, { kind: "image", content_type: "image/png", file: png(640, 480, 5000), width: 640, height: 480, title: '<b>Loot</b> & "co"' }, png(64, 48, 300));
    const clipId = await share(deps, owner.token, { kind: "clip", content_type: "image/gif", file: gif(320, 200, 7000), width: 320, height: 200, duration_ms: 4200 });

    const images = openPage("images", browser(deps, cookie));
    await images.settle();
    expect(rows(images).map((row) => titleOf(row).textContent)).toEqual(['<b>Loot</b> & "co"']);
    // The line is the usage's: the image with its preview (5,000 + 300 bytes).
    expect(line(images)).toBe("1 image in Account · 5.2 KB used");
    const row = rows(images)[0];
    const href = byText(row, "Open").getAttribute("href")!;
    expect(href).toMatch(/^https:\/\/img\.example\.com\/i\/[a-z0-9]+$/);
    expect(details(row).wide).toBe(`640 × 480 · PNG · img.example.com/i/${href.slice(href.lastIndexOf("/") + 1, href.lastIndexOf("/") + 5)}…`);
    // The preview's address answers this session's browser with the picture, and nobody without the session.
    const src = imgOf(row)!.src!;
    expect(src).toBe(`/api/v1/media/${imageId}/preview`);
    const app = createApp(deps);
    const pic = await app.fetch(new Request(APP + src, { headers: { cookie, "user-agent": FIREFOX } }));
    expect([pic.status, pic.headers.get("content-type")]).toEqual([200, "image/png"]);
    const nobody = await app.fetch(new Request(APP + src, { headers: { "user-agent": FIREFOX } }));
    expect(nobody.status).toBe(401);

    const gifs = openPage("gifs", browser(deps, cookie));
    await gifs.settle();
    expect(rows(gifs).map((r) => [titleOf(r).textContent, details(r).wide.split(" · ").slice(0, 2).join(" · "), imgOf(r) === undefined])).toEqual([["Untitled GIF", "4 s · 320 × 200", true]]);

    // Delete the image after the question, through the real API with the real anti-forgery check.
    pressDelete(rows(images)[0]);
    images.$("delete-go").click();
    await images.settle();
    expect(images.$("delete-dialog").hidden).toBe(true);
    expect(images.$("media-empty").shown).toBe(true);
    expect((await send(deps, "GET", "/api/v1/media?kind=image", { token: owner.token })).json.items).toEqual([]);
    expect((await send(deps, "GET", "/api/v1/media?kind=clip", { token: owner.token })).json.items.map((i: { id: string }) => i.id)).toEqual([clipId]);
  });

  it("deletes the selected items through the real API one by one; another workspace's item slipped into the list gets the route's not found and stays", async () => {
    const { deps } = await makeDeps();
    await seedAccount(deps, { admin: true, username: "mediabulk-admin" });
    const owner = await seedAccount(deps, { username: "mediabulk" });
    const other = await seedAccount(deps, { username: "mediabulk-other" });
    expect(other.workspaceId).not.toBe(owner.workspaceId);
    const made = await redeemSignInCode(deps, await createSignInCode(deps, owner.userId), FIREFOX, null);
    const real = browser(deps, `${SESSION_COOKIE}=${made!.secret}`);
    const mine = [];
    for (let i = 0; i < 3; i++) mine.push(await share(deps, owner.token, { kind: "image", content_type: "image/png", file: png(10, 10, 500 + i), width: 10, height: 10, title: `Mine ${i}` }));
    const theirs = await share(deps, other.token, { kind: "image", content_type: "image/png", file: png(10, 10, 600), width: 10, height: 10, title: "Theirs" });
    const foreign = (await send(deps, "GET", "/api/v1/media?kind=image", { token: other.token })).json.items[0];
    expect(foreign.id).toBe(theirs);
    // The first list the page reads is tampered with on its way: the other workspace's item is added to it.
    let first = true;
    const answered: [string, number, unknown][] = [];
    const tab = openPage("images", async (req) => {
      const a = await real(req);
      if (req.method === "DELETE" && a !== "network") answered.push([req.path.slice("/api/v1/media/".length), a.status, a.json]);
      if (first && req.method === "GET" && req.path === IMAGES_LIST && a !== "network") {
        first = false;
        (a.json as { items: unknown[] }).items.push(foreign);
      }
      return a;
    });
    await tab.settle();
    expect(titled(tab)).toEqual(["Mine 2", "Mine 1", "Mine 0", "Theirs"]);
    // Two of mine and the slipped-in one.
    select(tab, 0, 2, 3);
    tab.$("pick-delete").click();
    tab.$("bulk-go").click();
    await drain(tab);
    expect(deletes(tab).map((f) => f.path)).toEqual([mine[2], mine[0], theirs].map((id) => `/api/v1/media/${id}`));
    // The route's answer for the other workspace's item is its own not found, as for any id that is not this workspace's.
    expect(answered.map(([id, status, json]) => [id, status, (json as { error?: string } | undefined)?.error ?? null])).toEqual([[mine[2], 204, null], [mine[0], 204, null], [theirs, 404, "not_found"]]);
    // Nothing of the other workspace was deleted; of mine, exactly the two selected.
    expect((await send(deps, "GET", `/api/v1/media/${theirs}`, { token: other.token })).status).toBe(200);
    expect((await send(deps, "GET", "/api/v1/media?kind=image", { token: other.token })).json.items.map((i: { id: string }) => i.id)).toEqual([theirs]);
    expect((await send(deps, "GET", "/api/v1/media?kind=image", { token: owner.token })).json.items.map((i: { id: string }) => i.id)).toEqual([mine[1]]);
    // The list read again is the server's own: only the image not selected, and nothing selected.
    expect(titled(tab)).toEqual(["Mine 1"]);
    expect(picked(tab).bar).toBeNull();
    // The 404 is counted as for an item already gone (the page cannot tell, by design, a foreign item from a missing one).
    expect(tab.$("media-message").textContent).toBe("3 images deleted.");
  });

  it("a page whose anti-forgery value is wrong deletes nothing", async () => {
    const { deps } = await makeDeps();
    await seedAccount(deps, { admin: true, username: "mediacsrf-admin" });
    const owner = await seedAccount(deps, { username: "mediacsrf" });
    const made = await redeemSignInCode(deps, await createSignInCode(deps, owner.userId), FIREFOX, null);
    const real = browser(deps, `${SESSION_COOKIE}=${made!.secret}`);
    await share(deps, owner.token, { kind: "image", content_type: "image/png", file: png(10, 10, 500), width: 10, height: 10 });
    const tab = openPage("images", async (req) => {
      const a = await real(req);
      if (req.path === "/api/v1/session" && a !== "network") (a.json as { csrf: string }).csrf = "0".repeat(64);
      return a;
    });
    await tab.settle();
    // One-address mode: the link is a path, put after this page's own origin.
    expect(byText(rows(tab)[0], "Open").getAttribute("href")).toMatch(/^https:\/\/app\.example\.com\/i\/[a-z0-9]+$/);
    pressDelete(rows(tab)[0]);
    tab.$("delete-go").click();
    await tab.settle();
    expect(tab.$("delete-message").textContent).toBe(FAILED);
    expect((await send(deps, "GET", "/api/v1/media?kind=image", { token: owner.token })).json.items).toHaveLength(1);
  });
});

