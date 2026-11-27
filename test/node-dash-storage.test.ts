// What the Storage page's script does when it runs: the page's document, the shared
// /dash/dash.js and the page's /dash/storage.js are run in one fresh Node `vm` context
// against a stand-in document built from the page's own HTML (test/pages-dom.ts), with a
// stand-in fetch that either answers from the test or hands the request to the real app.
// Node only: the Workers runtime runs no code from a string.
//
// What this leaves unproven, for a by-hand check in two browsers: the real layout of the
// bars, `inert` as a browser applies it, focus rings, and a screen reader.
import { isBrandMark } from "./dash-checks.ts";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { createApp } from "../src/app.ts";
import { DASH_JS } from "../src/dash/script.ts";
import { STORAGE_HTML, STORAGE_JS } from "../src/dash/storage.ts";
import type { Deps } from "../src/ports.ts";
import { SESSION_COOKIE, createSignInCode, redeemSignInCode } from "../src/sessions.ts";
import { formatBytes } from "../src/usage.ts";
import { fixtures, gif, png, send, uploadTour, type Json } from "./bundle.ts";
import { FakeDocument, FakeElement, visibleText } from "./pages-dom.ts";

const APP = "https://app.example.com";
const CSRF = "c".repeat(64);
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";
const FAILED = "Something went wrong. Try again in a moment.";
const TOO_MANY = "Too many requests. Wait a few minutes and try again.";
const BUSY = "This tour is being published. Try again when that is done.";
const NOT_RELOADED = "The change was made, but the list could not be loaded again. Reload the page to see it.";
const OVER = "You are over your storage allowance. New uploads are refused until you delete tours or get more room.";
const ONLINE = "Tours that are already online are not affected.";
const COUNTS = "Images, GIFs and tours all count. Deleting one frees its space within a few minutes.";
const QUESTION = "Its link stops working for everyone and its pictures are removed. This cannot be undone. The recording on your computer is not touched.";
const QUESTION_ITEM = "Its link stops working for everyone and it is removed. The copy on your computer is not touched.";
const NO_BACKUPS = "There are no backups of this data, and its removal is permanent.";
const EVERYTHING_ELSE = "Everything else is on the Images, GIFs and Tours pages.";

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

type Answer = { status: number; json?: unknown } | "network";
type Fetched = { method: string; path: string; headers: Record<string, string>; body: string | undefined };
type Responder = (req: Fetched) => Answer | Promise<Answer>;

type Tab = {
  doc: FakeDocument;
  fetched: Fetched[];
  left: () => string | null;
  $: (id: string) => FakeElement;
  shows: () => string[];
  settle: () => Promise<void>;
  /** A key pressed with the focus nowhere in particular: on the page's body. */
  pressOnPage: (key: string, shiftKey?: boolean) => boolean;
  violations: string[];
  /** The delay of every timer the page set, in order. */
  delays: number[];
  /** Runs the timers set so far, as if their time had passed. */
  tick: () => void;
};

const open: Tab[] = [];
afterEach(() => {
  for (const tab of open.splice(0)) expect(tab.violations, "the script used something it must not").toEqual([]);
});

/** Opens the Storage page and runs its two scripts in order, as a browser does with two deferred scripts. */
function openStorage(respond: Responder): Tab {
  const doc = new FakeDocument(STORAGE_HTML);
  let left: string | null = null;
  const fetched: Fetched[] = [];
  const pending: Promise<unknown>[] = [];
  const violations: string[] = [];
  const location = {
    get origin() {
      return APP;
    },
    replace(path: string) {
      left = path;
    },
  };
  const fetch = (path: string, init: Record<string, unknown> = {}) => {
    const req: Fetched = { method: String(init.method ?? "GET"), path, headers: { ...(init.headers as Record<string, string>) }, body: init.body as string | undefined };
    fetched.push(req);
    const p = Promise.resolve(respond(req)).then((a) => {
      if (a === "network") throw new TypeError("Failed to fetch");
      const body = a.json === undefined ? null : JSON.stringify(a.json);
      return new Response(a.status === 204 ? null : body, { status: a.status, headers: { "content-type": "application/json" } });
    });
    pending.push(p.catch(() => {}));
    return p;
  };
  // Timers run only when the test says their time has passed.
  const timers: (() => void)[] = [];
  const delays: number[] = [];
  const setTimeout = (fn: () => void, ms?: number) => {
    timers.push(fn);
    delays.push(Number(ms));
    return timers.length;
  };
  const context: Record<string, unknown> = { document: doc, location, fetch, setTimeout };
  for (const name of ["localStorage", "sessionStorage", "indexedDB", "caches", "cookieStore", "XMLHttpRequest", "WebSocket", "EventSource", "window", "self", "top", "parent", "opener", "open", "postMessage", "setInterval", "console", "alert", "confirm", "prompt", "history", "navigator"]) {
    Object.defineProperty(context, name, {
      get() {
        violations.push(name);
        throw new Error(`${name} is not for the dashboard's scripts`);
      },
    });
  }
  const ctx = vm.createContext(context);
  vm.runInContext(DASH_JS, ctx, { filename: "dash.js" });
  vm.runInContext(STORAGE_JS, ctx, { filename: "storage.js" });
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
    pressOnPage: (key, shiftKey = false) => doc.body.dispatch("keydown", { key, shiftKey }).defaultPrevented,
    violations,
    delays,
    tick: () => {
      for (const fn of timers.splice(0)) fn();
    },
  };
  open.push(tab);
  return tab;
}

/** A responder from a table of "<METHOD> <path>" to answers (a list is answered in order, its last one repeated); anything else fails the test. */
function answers(table: Record<string, Answer | Answer[]>): Responder {
  const queues = new Map(Object.entries(table).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  return (req) => {
    const q = queues.get(`${req.method} ${req.path}`);
    if (!q || q.length === 0) throw new Error(`unexpected request ${req.method} ${req.path}`);
    return q.length > 1 ? q.shift()! : q[0];
  };
}

const SIGNED_OUT: Answer = { status: 401, json: { error: "unauthorized" } };
const session = (workspace = "Cowfee Raid Tools"): Answer => ({
  status: 200,
  json: { account: { id: "usr_1", username: "morgan", email: "morgan@example.com", admin: false }, workspace: { id: "ws_1", name: workspace }, session: { id: "ses_1", created_at: 0, expires_at: 0 }, csrf: CSRF },
});
type UsageNumbers = { pictures: number; logos: number; uploads: number; allowance: number | null; tours: number; imageBytes?: number; gifBytes?: number; images?: number; gifs?: number };
const usage = (n: UsageNumbers): Answer => {
  const imageBytes = n.imageBytes ?? 0;
  const gifBytes = n.gifBytes ?? 0;
  const used = n.pictures + n.logos + n.uploads + imageBytes + gifBytes;
  return {
    status: 200,
    json: {
      used_bytes: used,
      allowance_bytes: n.allowance,
      over: n.allowance !== null && used > n.allowance,
      tours: n.tours,
      images: n.images ?? 0,
      gifs: n.gifs ?? 0,
      counted: { pictures: n.pictures, logos: n.logos, uploads_in_progress: n.uploads, images: imageBytes, gifs: gifBytes },
    },
  };
};

const T1 = "tour_" + "1".repeat(24);
const T2 = "tour_" + "2".repeat(24);
const T3 = "tour_" + "3".repeat(24);
const G1 = "med_" + "a".repeat(24);
const I1 = "med_" + "b".repeat(24);
type Entry = { kind: "tour" | "image" | "gif"; id: string; title: string | null; bytes: number };
/** The answer of GET /api/v1/usage/largest for these entries: `largest` as given, `tours` the tours among them. */
const largest = (entries: Entry[]): Answer => ({ status: 200, json: { tours: entries.filter((e) => e !== null && e.kind === "tour").map(({ id, title, bytes }) => ({ id, title, bytes })), largest: entries } });

/** Mockup 5: 1.2 GB of 5 GB, 48 images, 9 GIFs and 12 tours, the three largest of them. */
const M5 = { pictures: 790 * MB, gifBytes: 250 * MB, imageBytes: 64 * MB, logos: 340 * KB, uploads: 96 * MB, allowance: 5 * GB, tours: 12, images: 48, gifs: 9 };
const M5_TOURS: Entry[] = [
  { kind: "tour", id: T1, title: "Full onboarding, long cut", bytes: 412 * MB },
  { kind: "tour", id: T2, title: "Timeline rehearsal walkthrough", bytes: 255 * MB },
  { kind: "gif", id: G1, title: "Loot council vote, full round", bytes: 96 * MB },
];

function standard(extra: Record<string, Answer | Answer[]> = {}): Responder {
  return answers({ "GET /api/v1/session": session(), "GET /api/v1/usage": usage(M5), "GET /api/v1/usage/largest": largest(M5_TOURS), ...extra });
}

const rows = (tab: Tab) => tab.$("largest-rows").children.filter((c): c is FakeElement => c instanceof FakeElement);
const cells = (row: FakeElement) => row.children.filter((c): c is FakeElement => c instanceof FakeElement);
/** The name a row shows: its first cell's name, without the kind beside it. */
const titleOf = (row: FakeElement) => cells(row)[0].all().find((e) => e.className === "name")!.textContent;
const kindOf = (row: FakeElement) => cells(row)[0].all().find((e) => e.className === "tag")!.textContent;
const deleteOf = (row: FakeElement) => row.all().find((e) => e.tagName === "button")!;
const fillOf = (row: FakeElement) => row.all().find((e) => e.className === "mini-fill")!;
const line = (tab: Tab) => tab.$("storage-total").textContent;
const room = (tab: Tab) => ["tours", "gifs", "images", "logos", "uploads"].map((k) => tab.$(`room-${k}`).textContent);
/** Whether the bar and the page behind the question are inert and hidden from screen readers (both or neither). */
const inert = (tab: Tab) =>
  [tab.$("dash-top"), tab.$("storage-page")].map((e) => {
    expect(e.hasAttribute("inert"), `#${e.id}`).toBe(e.getAttribute("aria-hidden") === "true");
    return e.hasAttribute("inert");
  });
const key = (el: FakeElement, k: string, shiftKey = false) => el.dispatch("keydown", { key: k, shiftKey });
const gets = (tab: Tab, path: string) => tab.fetched.filter((f) => f.method === "GET" && f.path === path).length;

describe("the Storage page", () => {
  it("shows mockup 5: the workspace, the bar, the line with the counts, what takes the room, the largest items with their kinds and the hint", async () => {
    const tab = openStorage(standard());
    await tab.settle();
    expect(tab.left()).toBeNull();
    expect(tab.fetched.map((f) => `${f.method} ${f.path}`).sort()).toEqual(["GET /api/v1/session", "GET /api/v1/usage", "GET /api/v1/usage/largest"]);
    expect(tab.$("storage-workspace").textContent).toBe("Cowfee Raid Tools");
    expect(line(tab)).toBe("1.2 GB of 5 GB used · 48 images · 9 GIFs · 12 tours");
    const bar = tab.$("storage-bar");
    expect([bar.shown, bar.className, tab.$("storage-fill").style.width]).toEqual([true, "meter", "23.44%"]);
    expect([tab.$("storage-over").shown, tab.$("storage-online").shown, tab.$("storage-counts").shown]).toEqual([false, false, true]);
    expect(room(tab)).toEqual(["790 MB", "250 MB", "64 MB", "340 KB", "96 MB"]);
    expect(rows(tab).map((r) => [titleOf(r), kindOf(r), fillOf(r).style.width, cells(r)[2].textContent, deleteOf(r).textContent])).toEqual([
      ["Full onboarding, long cut", "Tour", "100%", "412 MB", "Delete"],
      ["Timeline rehearsal walkthrough", "Tour", "61.89%", "255 MB", "Delete"],
      ["Loot council vote, full round", "GIF", "23.3%", "96 MB", "Delete"],
    ]);
    // Each Delete names its entry and its kind for a screen reader; the kind is a tag beside the name; the small bars are drawings.
    for (const [i, r] of rows(tab).entries()) {
      const [name, tag] = cells(r)[0].children.filter((c): c is FakeElement => c instanceof FakeElement);
      expect([name.tagName, name.className, name.id, tag.tagName, tag.className, tag.id]).toEqual(["span", "name", `largest-${i}`, "span", "tag", `largest-${i}-kind`]);
      expect([deleteOf(r).getAttribute("type"), deleteOf(r).className, deleteOf(r).getAttribute("aria-describedby")]).toEqual(["button", "btn sm danger", `largest-${i} largest-${i}-kind`]);
      expect(cells(r)[1].getAttribute("aria-hidden")).toBe("true");
    }
    expect(tab.$("largest").shown).toBe(true);
    expect(tab.shows()).toEqual([
      "Mythicshot",
      "morgan",
      "Storage",
      "Cowfee Raid Tools",
      "1.2 GB of 5 GB used · 48 images · 9 GIFs · 12 tours",
      COUNTS,
      "What takes the room",
      "Largest items",
      "Delete",
      "Delete",
      "Delete",
      EVERYTHING_ELSE,
    ]);
    // What takes the room, row by row, in the mockup's order.
    expect(tab.$("h-room").parent!.all().filter((e) => e.className === "room").map((r) => r.textContent)).toEqual(["Tours790 MB", "GIFs250 MB", "Images64 MB", "Logos340 KB", "Uploads in progress96 MB"]);
    expect(tab.fetched.filter((f) => f.method !== "GET")).toEqual([]);
  });

  it("with no allowance there is no bar, only the total", async () => {
    const tab = openStorage(standard({ "GET /api/v1/usage": usage({ ...M5, allowance: null }) }));
    await tab.settle();
    expect(line(tab)).toBe("1.2 GB used · 48 images · 9 GIFs · 12 tours");
    expect(tab.$("storage-bar").shown).toBe(false);
    expect(tab.$("storage-over").shown).toBe(false);
    expect(tab.$("storage-counts").shown).toBe(true);
  });

  it("writes one of each in the singular, and leaves out a count that is 0 (never \"· 0 tours\" beside images or GIFs), but says \"0 tours\" for a workspace with nothing", async () => {
    for (const [n, text] of [
      [{ images: 1, gifs: 1, tours: 1 }, "2 MB used · 1 image · 1 GIF · 1 tour"],
      [{ images: 2, gifs: 0, tours: 0 }, "2 MB used · 2 images"],
      [{ images: 0, gifs: 1, tours: 0 }, "2 MB used · 1 GIF"],
      [{ images: 0, gifs: 0, tours: 0 }, "2 MB used · 0 tours"],
      [{ images: 0, gifs: 3, tours: 1 }, "2 MB used · 3 GIFs · 1 tour"],
      [{ images: 0, gifs: 0, tours: 5 }, "2 MB used · 5 tours"],
    ] as const) {
      const tab = openStorage(standard({ "GET /api/v1/usage": usage({ pictures: 2 * MB, logos: 0, uploads: 0, allowance: null, ...n }) }));
      await tab.settle();
      expect(line(tab), JSON.stringify(n)).toBe(text);
    }
  });

  it("shows mockup 6 when the workspace is over: the bar full in the warning colour, the warning, and that online tours are not affected", async () => {
    const tab = openStorage(standard({ "GET /api/v1/usage": usage({ pictures: 5 * GB + 300 * MB, logos: 0, uploads: 0, allowance: 5 * GB, tours: 31 }) }));
    await tab.settle();
    expect(line(tab)).toBe("5.3 GB of 5 GB used · 31 tours");
    expect([tab.$("storage-bar").shown, tab.$("storage-bar").className, tab.$("storage-fill").style.width]).toEqual([true, "meter over", "100%"]);
    expect([tab.$("storage-over").shown, tab.$("storage-online").shown, tab.$("storage-counts").shown]).toEqual([true, true, false]);
    expect(tab.shows().slice(4, 7)).toEqual(["5.3 GB of 5 GB used · 31 tours", OVER, ONLINE]);
  });

  it("items take the workspace over as tours do", async () => {
    const tab = openStorage(standard({ "GET /api/v1/usage": usage({ pictures: 0, logos: 0, uploads: 0, imageBytes: 3 * GB, gifBytes: 3 * GB, allowance: 5 * GB, tours: 0, images: 4, gifs: 2 }) }));
    await tab.settle();
    expect(line(tab)).toBe("6 GB of 5 GB used · 4 images · 2 GIFs");
    expect([tab.$("storage-bar").className, tab.$("storage-over").shown]).toEqual(["meter over", true]);
    expect(room(tab)).toEqual(["0 bytes", "3 GB", "3 GB", "0 bytes", "0 bytes"]);
  });

  it("the bar's width is used over allowance, from 0 to 100%; exactly the allowance is full but not over", async () => {
    for (const [n, width, cls] of [
      [{ pictures: 5 * GB, logos: 0, uploads: 0, allowance: 5 * GB, tours: 1 }, "100%", "meter"],
      [{ pictures: 0, logos: 0, uploads: 0, allowance: 0, tours: 0 }, "0%", "meter"],
      [{ pictures: 1, logos: 0, uploads: 0, allowance: 0, tours: 1 }, "100%", "meter over"],
      [{ pictures: 0, logos: 0, uploads: 0, allowance: 5 * GB, tours: 0 }, "0%", "meter"],
      [{ pictures: 1, logos: 0, uploads: 0, allowance: 3, tours: 1 }, "33.33%", "meter"],
    ] as const) {
      const tab = openStorage(standard({ "GET /api/v1/usage": usage(n), "GET /api/v1/usage/largest": largest(n.tours === 0 ? [] : [M5_TOURS[0]]) }));
      await tab.settle();
      expect([tab.$("storage-fill").style.width, tab.$("storage-bar").className], JSON.stringify(n)).toEqual([width, cls]);
    }
  });

  it("an empty workspace shows the totals as zeros and the hint, with no table", async () => {
    const tab = openStorage(standard({ "GET /api/v1/usage": usage({ pictures: 0, logos: 0, uploads: 0, allowance: 5 * GB, tours: 0 }), "GET /api/v1/usage/largest": largest([]) }));
    await tab.settle();
    expect(line(tab)).toBe("0 bytes of 5 GB used · 0 tours");
    expect(room(tab)).toEqual(["0 bytes", "0 bytes", "0 bytes", "0 bytes", "0 bytes"]);
    expect(tab.$("largest").shown).toBe(false);
    expect(rows(tab)).toEqual([]);
    expect(tab.$("storage-counts").shown).toBe(true);
  });

  it("shows a title holding markup as text, for a tour and for an item, and an untitled item by its kind", async () => {
    const markup = '<img src=x onerror="alert(1)">';
    const tab = openStorage(
      standard({
        "GET /api/v1/session": session("<i>ws</i>"),
        "GET /api/v1/usage": usage({ pictures: 2 * MB, logos: 0, uploads: 0, allowance: null, tours: 1, imageBytes: 3 * MB, gifBytes: 4 * MB, images: 2, gifs: 1 }),
        "GET /api/v1/usage/largest": largest([
          { kind: "gif", id: G1, title: null, bytes: 4 * MB },
          { kind: "image", id: I1, title: markup, bytes: 2 * MB + 1 },
          { kind: "tour", id: T1, title: markup, bytes: 2 * MB },
          { kind: "image", id: "med_" + "c".repeat(24), title: null, bytes: MB },
        ]),
      }),
    );
    await tab.settle();
    expect(rows(tab).map((r) => [titleOf(r), kindOf(r)])).toEqual([
      ["Untitled GIF", "GIF"],
      [markup, "Image"],
      [markup, "Tour"],
      ["Untitled image", "Image"],
    ]);
    for (const r of rows(tab)) {
      const name = cells(r)[0].all().find((e) => e.className === "name")!;
      expect(name.children.every((c) => !(c instanceof FakeElement))).toBe(true);
    }
    expect(tab.$("storage-workspace").textContent).toBe("<i>ws</i>");
    expect(tab.doc.root.all().some((e) => (e.tagName === "img" && !isBrandMark(e)) || e.tagName === "i")).toBe(false);
  });

  it("leaves out an entry the API did not answer as a tour, an image or a GIF", async () => {
    const tab = openStorage(
      standard({
        "GET /api/v1/usage/largest": largest([
          { kind: "tour", id: "x", title: "a", bytes: 1 },
          null as never,
          { kind: "tour", id: T2, title: "ok", bytes: 5 },
          { kind: "tour", id: T3, title: "no size", bytes: "5" as never },
          { kind: "tour", id: T3, title: null, bytes: 5 },
          { kind: "image", id: T1, title: "a tour's id", bytes: 5 },
          { kind: "gif", id: G1, title: 5 as never, bytes: 5 },
          { kind: "clip" as never, id: G1, title: "no such kind", bytes: 5 },
          { kind: "toString" as never, id: G1, title: "inherited", bytes: 5 },
          { kind: "image", id: I1, title: "item ok", bytes: 4 },
        ]),
      }),
    );
    await tab.settle();
    expect(rows(tab).map(titleOf)).toEqual(["ok", "item ok"]);
  });

  it("says when the numbers cannot be read, with the approved sentences, and shows none of them", async () => {
    for (const [table, text] of [
      [{ "GET /api/v1/usage": { status: 500, json: { error: "internal" } } }, FAILED],
      [{ "GET /api/v1/usage/largest": { status: 429, json: { error: "rate_limited" } } }, TOO_MANY],
      [{ "GET /api/v1/usage": "network" }, FAILED],
      [{ "GET /api/v1/usage": { status: 200, json: { used_bytes: "1" } } }, FAILED],
      [{ "GET /api/v1/usage/largest": { status: 200, json: { tours: [], largest: "x" } } }, FAILED],
      [{ "GET /api/v1/usage/largest": { status: 200, json: { tours: [] } } }, FAILED],
      [{ "GET /api/v1/usage": { status: 200, json: { used_bytes: 1, allowance_bytes: null, over: false, tours: 0, counted: { pictures: 1, logos: 0, uploads_in_progress: 0 } } } }, FAILED],
    ] as const) {
      const tab = openStorage(standard(table as Record<string, Answer>));
      await tab.settle();
      expect(tab.$("dash-load").textContent, JSON.stringify(table)).toBe(text);
      expect(tab.$("storage").hidden).toBe(true);
    }
    const out = openStorage(standard({ "GET /api/v1/usage/largest": SIGNED_OUT }));
    await out.settle();
    expect(out.left()).toBe("/signin");
    const nobody = openStorage(answers({ "GET /api/v1/session": SIGNED_OUT }));
    await nobody.settle();
    expect([nobody.left(), nobody.fetched.length]).toEqual(["/signin", 1]);
  });
});

describe("deleting from the Storage page", () => {
  it("asks first with the Tours page's question; the page behind is inert, Escape, Keep it and the backdrop close it, and the focus comes back", async () => {
    const tab = openStorage(standard());
    await tab.settle();
    expect(inert(tab)).toEqual([false, false]);
    const del = deleteOf(rows(tab)[1]);
    del.click();
    const dialog = tab.$("delete-dialog");
    expect(dialog.shown).toBe(true);
    expect(tab.$("delete-title").textContent).toBe('Delete "Timeline rehearsal walkthrough"?');
    expect(tab.shows().slice(-4)).toEqual(['Delete "Timeline rehearsal walkthrough"?', QUESTION, "Keep it", "Delete tour"]);
    expect(tab.doc.activeElement).toBe(tab.$("delete-keep"));
    expect(inert(tab)).toEqual([true, true]);
    // Tab and Shift+Tab stay on the two buttons, wherever the focus was, handled for the whole document.
    expect(key(tab.$("delete-keep"), "Tab").defaultPrevented).toBe(true);
    expect(tab.doc.activeElement).toBe(tab.$("delete-go"));
    expect(key(tab.$("delete-go"), "Tab").defaultPrevented).toBe(true);
    expect(tab.doc.activeElement).toBe(tab.$("delete-keep"));
    expect(key(tab.$("delete-keep"), "Tab", true).defaultPrevented).toBe(true);
    expect(tab.doc.activeElement).toBe(tab.$("delete-go"));
    tab.doc.activeElement = tab.doc.body;
    expect(tab.pressOnPage("Tab")).toBe(true);
    expect(tab.doc.activeElement).toBe(tab.$("delete-keep"));
    // Escape closes it from anywhere and gives the focus back to the row's Delete.
    tab.doc.activeElement = tab.doc.body;
    expect(tab.pressOnPage("Escape")).toBe(true);
    expect(dialog.shown).toBe(false);
    expect(inert(tab)).toEqual([false, false]);
    expect(tab.doc.activeElement).toBe(del);
    // Closed, the page's keys are its own again.
    expect(tab.pressOnPage("Tab")).toBe(false);
    // Keep it closes it.
    del.click();
    tab.$("delete-keep").click();
    expect(dialog.shown).toBe(false);
    expect(tab.doc.activeElement).toBe(del);
    // A click on the backdrop closes it; a click inside the question does not.
    del.click();
    tab.$("delete-text").click();
    expect(dialog.shown).toBe(true);
    dialog.click();
    expect(dialog.shown).toBe(false);
    expect(inert(tab)).toEqual([false, false]);
    expect(tab.doc.activeElement).toBe(del);
    expect(tab.fetched.filter((f) => f.method !== "GET")).toEqual([]);
  });

  it("Delete tour deletes with the anti-forgery header until done, then shows the numbers and the list as they are now", async () => {
    const after = { ...M5, pictures: M5.pictures - 255 * MB, tours: 11 };
    const tab = openStorage(
      standard({
        ["DELETE /api/v1/tours/" + T2]: [{ status: 202, json: { status: "in_progress", done: 1, total: 3 } }, { status: 200, json: { deleted: true } }],
        "GET /api/v1/usage": [usage(M5), usage(after)],
        "GET /api/v1/usage/largest": [largest(M5_TOURS), largest([M5_TOURS[0], M5_TOURS[2]])],
      }),
    );
    await tab.settle();
    deleteOf(rows(tab)[1]).click();
    const go = tab.$("delete-go");
    const keep = tab.$("delete-keep");
    go.click();
    expect([go.textContent, go.disabled, keep.disabled, go.getAttribute("aria-busy")]).toEqual(["Deleting…", true, true, "true"]);
    // While it runs nothing closes the question, and Tab stays inside it.
    tab.pressOnPage("Escape");
    tab.$("delete-dialog").click();
    expect(tab.$("delete-dialog").shown).toBe(true);
    expect(tab.pressOnPage("Tab")).toBe(true);
    expect(tab.$("delete-dialog").contains(tab.doc.activeElement)).toBe(true);
    await tab.settle();
    expect(tab.fetched.filter((f) => f.method === "DELETE").map((f) => [f.path, f.headers["X-Csrf-Token"], f.body])).toEqual([
      [`/api/v1/tours/${T2}`, CSRF, undefined],
      [`/api/v1/tours/${T2}`, CSRF, undefined],
    ]);
    expect(tab.$("delete-dialog").shown).toBe(false);
    expect(inert(tab)).toEqual([false, false]);
    expect([go.textContent, go.disabled, keep.disabled, go.getAttribute("aria-busy")]).toEqual(["Delete tour", false, false, null]);
    expect([gets(tab, "/api/v1/usage"), gets(tab, "/api/v1/usage/largest")]).toEqual([2, 2]);
    expect(rows(tab).map(titleOf)).toEqual(["Full onboarding, long cut", "Loot council vote, full round"]);
    expect(line(tab)).toBe("945.3 MB of 5 GB used · 48 images · 9 GIFs · 11 tours");
    expect(tab.doc.activeElement).toBe(tab.$("h-page"));
    expect([tab.$("storage-message").textContent, tab.$("storage-message").hidden]).toEqual(["", true]);
    expect([tab.$("delete-message").textContent, tab.$("delete-message").hidden]).toEqual(["", true]);
  });

  it("a tour already gone, or gone with files left to clean up (500 cleanup_pending), counts as deleted", async () => {
    for (const answer of [{ status: 404, json: { error: "not_found" } }, { status: 500, json: { error: "cleanup_pending" } }]) {
      const tab = openStorage(standard({ ["DELETE /api/v1/tours/" + T1]: answer, "GET /api/v1/usage/largest": [largest(M5_TOURS), largest(M5_TOURS.slice(1))] }));
      await tab.settle();
      deleteOf(rows(tab)[0]).click();
      tab.$("delete-go").click();
      await tab.settle();
      const what = JSON.stringify(answer);
      expect(tab.$("delete-dialog").shown, what).toBe(false);
      expect(inert(tab), what).toEqual([false, false]);
      expect(rows(tab).map(titleOf), what).toEqual(["Timeline rehearsal walkthrough", "Loot council vote, full round"]);
      expect(tab.$("storage-message").hidden, what).toBe(true);
      expect(tab.doc.activeElement, what).toBe(tab.$("h-page"));
    }
  });

  it("a delete that fails keeps the question open with its sentence, gives the buttons back, and still reads the numbers again", async () => {
    for (const [answer, text] of [
      [{ status: 500, json: { error: "internal" } }, FAILED],
      [{ status: 409, json: { error: "publish_busy" } }, BUSY],
      [{ status: 429, json: { error: "rate_limited" } }, TOO_MANY],
      [{ status: 409, json: { error: "other" } }, FAILED],
      ["network", FAILED],
    ] as const) {
      // After the failure the numbers have changed (another tab may have deleted it meanwhile): the page shows them as they are.
      const tab = openStorage(standard({ ["DELETE /api/v1/tours/" + T1]: answer as Answer, "GET /api/v1/usage/largest": [largest(M5_TOURS), largest(M5_TOURS.slice(1))], "GET /api/v1/usage": [usage(M5), usage({ ...M5, tours: 11 })] }));
      await tab.settle();
      deleteOf(rows(tab)[0]).click();
      tab.$("delete-go").click();
      await tab.settle();
      const what = JSON.stringify(answer);
      expect(tab.$("delete-dialog").shown, what).toBe(true);
      expect([tab.$("delete-message").textContent, tab.$("delete-message").hidden], what).toEqual([text, false]);
      expect(tab.$("storage-message").hidden, what).toBe(true);
      expect([tab.$("delete-go").textContent, tab.$("delete-go").disabled, tab.$("delete-keep").disabled], what).toEqual(["Delete tour", false, false]);
      expect(tab.doc.activeElement, what).toBe(tab.$("delete-go"));
      expect(inert(tab), what).toEqual([true, true]);
      expect([gets(tab, "/api/v1/usage"), gets(tab, "/api/v1/usage/largest")], what).toEqual([2, 2]);
      expect(rows(tab).map(titleOf), what).toEqual(["Timeline rehearsal walkthrough", "Loot council vote, full round"]);
      expect(line(tab), what).toBe("1.2 GB of 5 GB used · 48 images · 9 GIFs · 11 tours");
      // Closed now, the focus goes to the heading, as the row it came from is no longer shown.
      tab.$("delete-keep").click();
      expect(tab.$("delete-dialog").shown, what).toBe(false);
      expect(tab.doc.activeElement, what).toBe(tab.$("h-page"));
      expect([tab.$("delete-message").textContent, tab.$("delete-message").hidden], what).toEqual(["", true]);
    }
  });

  it("when the numbers cannot be read again after a delete that worked, the page says the change was made and asks for a reload", async () => {
    for (const reread of [{ status: 500, json: { error: "internal" } }, "network"] as const) {
      const tab = openStorage(standard({ ["DELETE /api/v1/tours/" + T1]: { status: 200, json: { deleted: true } }, "GET /api/v1/usage": [usage(M5), reread as Answer] }));
      await tab.settle();
      deleteOf(rows(tab)[0]).click();
      tab.$("delete-go").click();
      await tab.settle();
      expect(tab.$("delete-dialog").shown).toBe(false);
      expect(inert(tab)).toEqual([false, false]);
      expect([tab.$("storage-message").textContent, tab.$("storage-message").shown]).toEqual([NOT_RELOADED, true]);
      expect(tab.doc.activeElement).toBe(tab.$("h-page"));
      expect([tab.$("delete-go").disabled, tab.$("delete-go").textContent]).toEqual([false, "Delete tour"]);
      // The next delete clears the sentence.
      deleteOf(rows(tab)[1]).click();
      expect(tab.$("delete-message").hidden).toBe(true);
    }
  });

  it("when a delete fails and the numbers cannot be read again either, the question says why and the page keeps what it showed", async () => {
    const tab = openStorage(standard({ ["DELETE /api/v1/tours/" + T1]: { status: 409, json: { error: "publish_busy" } }, "GET /api/v1/usage": [usage(M5), { status: 500, json: { error: "internal" } }] }));
    await tab.settle();
    deleteOf(rows(tab)[0]).click();
    tab.$("delete-go").click();
    await tab.settle();
    expect([tab.$("delete-dialog").shown, tab.$("delete-message").textContent]).toEqual([true, BUSY]);
    expect(rows(tab).map(titleOf)).toEqual(M5_TOURS.map((t) => t.title));
    expect(tab.doc.activeElement).toBe(tab.$("delete-go"));
    // Keep it: the focus goes back to that tour's Delete, which is still listed.
    tab.$("delete-keep").click();
    expect(tab.doc.activeElement).toBe(deleteOf(rows(tab)[0]));
  });

  it("every row's Delete is disabled while the delete runs and while the numbers are read again afterwards", async () => {
    let release: (a: Answer) => void = () => {};
    const held = new Promise<Answer>((r) => (release = r));
    let usageAsked = 0;
    const base = standard({ ["DELETE /api/v1/tours/" + T1]: { status: 200, json: { deleted: true } }, "GET /api/v1/usage/largest": [largest(M5_TOURS), largest(M5_TOURS.slice(1))] });
    const tab = openStorage((req) => {
      if (req.method === "GET" && req.path === "/api/v1/usage" && ++usageAsked === 2) return held;
      return base(req);
    });
    await tab.settle();
    const before = rows(tab).map(deleteOf);
    deleteOf(rows(tab)[0]).click();
    tab.$("delete-go").click();
    expect(before.map((b) => b.disabled)).toEqual([true, true, true]);
    await tab.settle();
    // The delete is done and the question closed; the numbers are still on their way.
    expect(tab.$("delete-dialog").shown).toBe(false);
    expect(before.map((b) => b.disabled)).toEqual([true, true, true]);
    expect(before[1].click()).toBeNull();
    expect(tab.$("delete-dialog").shown).toBe(false);
    release(usage({ ...M5, tours: 11 }));
    await tab.settle();
    expect(rows(tab).map((r) => [titleOf(r), deleteOf(r).disabled])).toEqual([
      ["Timeline rehearsal walkthrough", false],
      ["Loot council vote, full round", false],
    ]);
  });

  it("when the numbers cannot be read again, the rows shown get their Delete back", async () => {
    const tab = openStorage(standard({ ["DELETE /api/v1/tours/" + T1]: { status: 409, json: { error: "publish_busy" } }, "GET /api/v1/usage": [usage(M5), { status: 500, json: { error: "internal" } }] }));
    await tab.settle();
    deleteOf(rows(tab)[0]).click();
    tab.$("delete-go").click();
    await tab.settle();
    expect(rows(tab).map((r) => deleteOf(r).disabled)).toEqual([false, false, false]);
  });

  it("a double click on Delete tour sends one request", async () => {
    const tab = openStorage(standard({ ["DELETE /api/v1/tours/" + T1]: { status: 200, json: { deleted: true } }, "GET /api/v1/usage/largest": [largest(M5_TOURS), largest(M5_TOURS.slice(1))] }));
    await tab.settle();
    deleteOf(rows(tab)[0]).click();
    tab.$("delete-go").click();
    tab.$("delete-go").click();
    tab.$("delete-go").dispatch("click");
    await tab.settle();
    expect(tab.fetched.filter((f) => f.method === "DELETE")).toHaveLength(1);
  });

  it("a delete that stays in progress is asked at most 1000 times, then says it did not happen", async () => {
    const tab = openStorage(standard({ ["DELETE /api/v1/tours/" + T1]: { status: 202, json: { status: "in_progress", done: 1, total: 3 } } }));
    await tab.settle();
    deleteOf(rows(tab)[0]).click();
    tab.$("delete-go").click();
    for (let i = 0; i < 40 && tab.$("delete-go").disabled; i++) await tab.settle();
    expect(tab.fetched.filter((f) => f.method === "DELETE")).toHaveLength(1000);
    expect([tab.$("delete-dialog").shown, tab.$("delete-message").textContent]).toEqual([true, FAILED]);
    expect(tab.$("delete-go").disabled).toBe(false);
  });

  it("a lost session goes to /signin", async () => {
    const tab = openStorage(standard({ ["DELETE /api/v1/tours/" + T1]: SIGNED_OUT }));
    await tab.settle();
    deleteOf(rows(tab)[0]).click();
    tab.$("delete-go").click();
    await tab.settle();
    expect(tab.left()).toBe("/signin");
  });
});


describe("deleting an image or a GIF from the Storage page", () => {
  const GIF_ROW = 2;
  const deletes = (tab: Tab) => tab.fetched.filter((f) => f.method === "DELETE").map((f) => [f.path, f.headers["X-Csrf-Token"], f.body]);
  const withoutGif = largest(M5_TOURS.slice(0, 2));
  const afterGif = usage({ ...M5, gifBytes: M5.gifBytes - 96 * MB, gifs: 8 });

  it("asks in the item's words, with its kind on the button; a tour's question comes back as it was", async () => {
    const markup = '<b onclick="x()">Raid</b>';
    const tab = openStorage(standard({ "GET /api/v1/usage/largest": largest([...M5_TOURS, { kind: "image", id: I1, title: null, bytes: MB }, { kind: "image", id: "med_" + "d".repeat(24), title: markup, bytes: KB }]) }));
    await tab.settle();
    deleteOf(rows(tab)[GIF_ROW]).click();
    expect(tab.$("delete-dialog").shown).toBe(true);
    expect(tab.shows().slice(-5)).toEqual(['Delete "Loot council vote, full round"?', QUESTION_ITEM, NO_BACKUPS, "Keep it", "Delete GIF"]);
    expect([tab.$("delete-warn").className, tab.$("delete-box").getAttribute("aria-describedby")]).toEqual(["danger-line", "delete-text delete-warn"]);
    expect(tab.doc.activeElement).toBe(tab.$("delete-keep"));
    expect(inert(tab)).toEqual([true, true]);
    tab.$("delete-keep").click();
    expect(tab.doc.activeElement).toBe(deleteOf(rows(tab)[GIF_ROW]));
    // An untitled image is asked about by its kind.
    deleteOf(rows(tab)[3]).click();
    expect(tab.shows().slice(-5)).toEqual(['Delete "Untitled image"?', QUESTION_ITEM, NO_BACKUPS, "Keep it", "Delete image"]);
    tab.pressOnPage("Escape");
    // A title holding markup is text in the question too.
    deleteOf(rows(tab)[4]).click();
    expect(tab.$("delete-title").textContent).toBe(`Delete "${markup}"?`);
    expect(tab.$("delete-title").children.every((c) => !(c instanceof FakeElement))).toBe(true);
    expect(tab.doc.root.all().some((e) => e.tagName === "b")).toBe(false);
    tab.$("delete-dialog").click();
    // A tour's question has the Tours page's words again.
    deleteOf(rows(tab)[0]).click();
    expect(tab.shows().slice(-4)).toEqual(['Delete "Full onboarding, long cut"?', QUESTION, "Keep it", "Delete tour"]);
    // A tour's question has no red line, and is described by its sentence alone.
    expect([tab.$("delete-warn").hidden, tab.$("delete-box").getAttribute("aria-describedby")]).toEqual([true, "delete-text"]);
    expect(tab.fetched.filter((f) => f.method !== "GET")).toEqual([]);
  });

  it("Delete GIF sends DELETE /api/v1/media/:id with the anti-forgery header, then shows the numbers and the list as they are now", async () => {
    const tab = openStorage(standard({ ["DELETE /api/v1/media/" + G1]: { status: 204 }, "GET /api/v1/usage": [usage(M5), afterGif], "GET /api/v1/usage/largest": [largest(M5_TOURS), withoutGif] }));
    await tab.settle();
    deleteOf(rows(tab)[GIF_ROW]).click();
    const go = tab.$("delete-go");
    go.click();
    expect([go.textContent, go.disabled, tab.$("delete-keep").disabled]).toEqual(["Deleting…", true, true]);
    await tab.settle();
    expect(deletes(tab)).toEqual([[`/api/v1/media/${G1}`, CSRF, undefined]]);
    expect(tab.$("delete-dialog").shown).toBe(false);
    expect(inert(tab)).toEqual([false, false]);
    expect([go.textContent, go.disabled]).toEqual(["Delete GIF", false]);
    expect([gets(tab, "/api/v1/usage"), gets(tab, "/api/v1/usage/largest")]).toEqual([2, 2]);
    expect(rows(tab).map(titleOf)).toEqual(["Full onboarding, long cut", "Timeline rehearsal walkthrough"]);
    expect(line(tab)).toBe("1.1 GB of 5 GB used · 48 images · 8 GIFs · 12 tours");
    expect(room(tab)[1]).toBe("154 MB");
    expect(tab.doc.activeElement).toBe(tab.$("h-page"));
    expect(tab.$("storage-message").hidden).toBe(true);
  });

  it("files left to remove (500 cleanup_pending): the delete is sent again after 400 ms, then 1200 ms, and counts as done when they stay", async () => {
    const pending = { status: 500, json: { error: "cleanup_pending", detail: "the item is deleted, but some of its files could not be removed yet; send the same request again later" } };
    for (const [answer, sent, delays] of [
      [[pending, { status: 204 }], 2, [400]],
      [[pending, pending, { status: 404, json: { error: "not_found" } }], 3, [400, 1200]],
      [[pending], 3, [400, 1200]],
    ] as const) {
      const tab = openStorage(standard({ ["DELETE /api/v1/media/" + G1]: [...answer] as Answer[], "GET /api/v1/usage": [usage(M5), afterGif], "GET /api/v1/usage/largest": [largest(M5_TOURS), withoutGif] }));
      await tab.settle();
      deleteOf(rows(tab)[GIF_ROW]).click();
      tab.$("delete-go").click();
      await tab.settle();
      const what = JSON.stringify(answer);
      // Nothing is sent again before the pause has passed; the question stays busy meanwhile.
      expect(deletes(tab), what).toHaveLength(1);
      expect([tab.delays, tab.$("delete-go").textContent, tab.$("delete-dialog").shown], what).toEqual([[400], "Deleting…", true]);
      for (let i = 0; i < 3; i++) {
        tab.tick();
        await tab.settle();
      }
      expect(tab.delays, what).toEqual(delays);
      expect(deletes(tab), what).toEqual(Array.from({ length: sent }, () => [`/api/v1/media/${G1}`, CSRF, undefined]));
      expect(tab.$("delete-dialog").shown, what).toBe(false);
      expect(rows(tab).map(titleOf), what).toEqual(["Full onboarding, long cut", "Timeline rehearsal walkthrough"]);
      expect([tab.$("storage-message").hidden, tab.$("delete-message").hidden], what).toEqual([true, true]);
      expect(tab.doc.activeElement, what).toBe(tab.$("h-page"));
    }
  });

  it("a delete whose answer is lost asks the item itself: only the API's own 404 not_found means done", async () => {
    const ITEM = "GET /api/v1/media/" + G1;
    const items = (tab: Tab) => tab.fetched.filter((f) => f.method === "GET" && f.path === "/api/v1/media/" + G1);
    const NOT_FOUND = { status: 404, json: { error: "not_found", detail: "no such item" } };
    // The API's own not_found: deleted, and the question closes as for a delete that answered.
    const gone = openStorage(standard({ ["DELETE /api/v1/media/" + G1]: "network", [ITEM]: NOT_FOUND, "GET /api/v1/usage": [usage(M5), afterGif], "GET /api/v1/usage/largest": [largest(M5_TOURS), withoutGif] }));
    await gone.settle();
    deleteOf(rows(gone)[GIF_ROW]).click();
    gone.$("delete-go").click();
    await gone.settle();
    expect(items(gone).map((f) => [f.path, f.body])).toEqual([["/api/v1/media/" + G1, undefined]]);
    expect(gone.$("delete-dialog").shown).toBe(false);
    expect([gone.$("storage-message").hidden, gone.$("delete-message").hidden]).toEqual([true, true]);
    expect(rows(gone).map(titleOf)).toEqual(["Full onboarding, long cut", "Timeline rehearsal walkthrough"]);
    expect(gone.doc.activeElement).toBe(gone.$("h-page"));

    // Still there (online or still being sent), even though the largest list read again no longer shows it: it failed.
    for (const state of ["online", "uploading"]) {
      const kept = openStorage(standard({ ["DELETE /api/v1/media/" + G1]: "network", [ITEM]: { status: 200, json: { id: G1, kind: "clip", state } }, "GET /api/v1/usage/largest": [largest(M5_TOURS), withoutGif] }));
      await kept.settle();
      deleteOf(rows(kept)[GIF_ROW]).click();
      kept.$("delete-go").click();
      await kept.settle();
      expect(kept.$("delete-dialog").shown, state).toBe(true);
      expect([kept.$("delete-message").textContent, kept.$("delete-go").disabled, kept.$("delete-go").textContent], state).toEqual([FAILED, false, "Delete GIF"]);
      expect(kept.$("storage-message").hidden, state).toBe(true);
      expect(kept.doc.activeElement, state).toBe(kept.$("delete-go"));
    }

    // A 404 that is not the API's own (from a proxy, say), no answer, or a server error: a failure; 429 says so in its own sentence.
    for (const [asked, text] of [
      [{ status: 404, json: null }, FAILED],
      [{ status: 404, json: { error: "gone" } }, FAILED],
      ["network", FAILED],
      [{ status: 500, json: { error: "internal" } }, FAILED],
      [{ status: 429, json: { error: "rate_limited" } }, TOO_MANY],
    ] as const) {
      const what = JSON.stringify(asked);
      const unsure = openStorage(standard({ ["DELETE /api/v1/media/" + G1]: "network", [ITEM]: asked as Answer, "GET /api/v1/usage/largest": [largest(M5_TOURS), withoutGif] }));
      await unsure.settle();
      deleteOf(rows(unsure)[GIF_ROW]).click();
      unsure.$("delete-go").click();
      await unsure.settle();
      expect([unsure.$("delete-dialog").shown, unsure.$("delete-message").textContent], what).toEqual([true, text]);
    }

    // A lost session while asking goes to /signin.
    const out = openStorage(standard({ ["DELETE /api/v1/media/" + G1]: "network", [ITEM]: SIGNED_OUT }));
    await out.settle();
    deleteOf(rows(out)[GIF_ROW]).click();
    out.$("delete-go").click();
    await out.settle();
    expect(out.left()).toBe("/signin");

    // Lost after a first cleanup_pending: the item was deleted by then, and nothing is asked.
    const second = openStorage(standard({ ["DELETE /api/v1/media/" + G1]: [{ status: 500, json: { error: "cleanup_pending" } }, "network"], "GET /api/v1/usage/largest": [largest(M5_TOURS), withoutGif] }));
    await second.settle();
    deleteOf(rows(second)[GIF_ROW]).click();
    second.$("delete-go").click();
    await second.settle();
    second.tick();
    await second.settle();
    expect(deletes(second)).toHaveLength(2);
    expect(items(second)).toHaveLength(0);
    expect(second.$("delete-dialog").shown).toBe(false);

    // A tour's lost delete is as before: nothing is asked, and it is a failure.
    const tour = openStorage(standard({ ["DELETE /api/v1/tours/" + T1]: "network" }));
    await tour.settle();
    deleteOf(rows(tour)[0]).click();
    tour.$("delete-go").click();
    await tour.settle();
    expect(tour.fetched.filter((f) => f.method === "GET" && f.path.startsWith("/api/v1/media/"))).toHaveLength(0);
    expect([tour.$("delete-dialog").shown, tour.$("delete-message").textContent]).toEqual([true, FAILED]);
  });

  it("once a send answered cleanup_pending the item is deleted: a later 429, 500 or lost answer still counts as done", async () => {
    const pending = { status: 500, json: { error: "cleanup_pending" } };
    for (const later of [{ status: 429, json: { error: "rate_limited" } }, { status: 500, json: { error: "internal" } }, "network", { status: 409, json: { error: "other" } }] as const) {
      for (const answers of [[pending, later], [pending, pending, later]]) {
        const tab = openStorage(standard({ ["DELETE /api/v1/media/" + G1]: answers as Answer[], "GET /api/v1/usage": [usage(M5), afterGif], "GET /api/v1/usage/largest": [largest(M5_TOURS), withoutGif] }));
        await tab.settle();
        deleteOf(rows(tab)[GIF_ROW]).click();
        tab.$("delete-go").click();
        for (let i = 0; i < 3; i++) {
          await tab.settle();
          tab.tick();
        }
        await tab.settle();
        const what = JSON.stringify(answers);
        expect(deletes(tab), what).toHaveLength(answers.length);
        expect(tab.$("delete-dialog").shown, what).toBe(false);
        expect([tab.$("delete-message").hidden, tab.$("storage-message").hidden], what).toEqual([true, true]);
        expect(rows(tab).map(titleOf), what).toEqual(["Full onboarding, long cut", "Timeline rehearsal walkthrough"]);
        expect(tab.doc.activeElement, what).toBe(tab.$("h-page"));
      }
    }
    // Even when the list read again still shows it (the server lists no closing item, but a page can be stale): the delete is done, the page shows the list as read.
    const stale = openStorage(standard({ ["DELETE /api/v1/media/" + G1]: [pending, "network"] }));
    await stale.settle();
    deleteOf(rows(stale)[GIF_ROW]).click();
    stale.$("delete-go").click();
    for (let i = 0; i < 3; i++) {
      await stale.settle();
      stale.tick();
    }
    await stale.settle();
    expect([stale.$("delete-dialog").shown, stale.$("delete-message").hidden]).toEqual([false, true]);
  });

  it("an item already gone (404) counts as deleted", async () => {
    const tab = openStorage(standard({ ["DELETE /api/v1/media/" + G1]: { status: 404, json: { error: "not_found", detail: "no such item" } }, "GET /api/v1/usage/largest": [largest(M5_TOURS), withoutGif] }));
    await tab.settle();
    deleteOf(rows(tab)[GIF_ROW]).click();
    tab.$("delete-go").click();
    await tab.settle();
    expect(deletes(tab)).toHaveLength(1);
    expect(tab.$("delete-dialog").shown).toBe(false);
    expect(rows(tab)).toHaveLength(2);
  });

  it("a delete that fails keeps the question open with its sentence and still reads the numbers again; a tour's sentence is not used for an item", async () => {
    for (const [answer, text] of [
      [{ status: 500, json: { error: "internal" } }, FAILED],
      [{ status: 429, json: { error: "rate_limited" } }, TOO_MANY],
      [{ status: 409, json: { error: "publish_busy" } }, FAILED],
      ["network", FAILED],
    ] as const) {
      // A lost answer asks the item, which is still online.
      const tab = openStorage(standard({ ["DELETE /api/v1/media/" + G1]: answer as Answer, ["GET /api/v1/media/" + G1]: { status: 200, json: { id: G1, kind: "clip", state: "online" } }, "GET /api/v1/usage": [usage(M5), usage({ ...M5, images: 47 })] }));
      await tab.settle();
      deleteOf(rows(tab)[GIF_ROW]).click();
      tab.$("delete-go").click();
      await tab.settle();
      const what = JSON.stringify(answer);
      expect(deletes(tab), what).toHaveLength(1);
      expect(tab.$("delete-dialog").shown, what).toBe(true);
      expect([tab.$("delete-message").textContent, tab.$("delete-message").hidden], what).toEqual([text, false]);
      expect([tab.$("delete-go").textContent, tab.$("delete-go").disabled], what).toEqual(["Delete GIF", false]);
      expect(tab.doc.activeElement, what).toBe(tab.$("delete-go"));
      // The page shows the numbers as they are now.
      expect([gets(tab, "/api/v1/usage"), gets(tab, "/api/v1/usage/largest")], what).toEqual([2, 2]);
      expect(line(tab), what).toBe("1.2 GB of 5 GB used · 47 images · 9 GIFs · 12 tours");
      tab.$("delete-keep").click();
      expect(tab.doc.activeElement, what).toBe(deleteOf(rows(tab)[GIF_ROW]));
    }
  });

  it("when the list cannot be read again after an item's delete that worked, or was left half-finished, the page says the change was made and asks for a reload", async () => {
    const pending = { status: 500, json: { error: "cleanup_pending" } };
    for (const [answer, reread] of [
      [{ status: 204 }, { status: 500, json: { error: "internal" } }],
      [pending, "network"],
    ] as const) {
      const tab = openStorage(standard({ ["DELETE /api/v1/media/" + G1]: answer as Answer, "GET /api/v1/usage/largest": [largest(M5_TOURS), reread as Answer] }));
      await tab.settle();
      deleteOf(rows(tab)[GIF_ROW]).click();
      tab.$("delete-go").click();
      for (let i = 0; i < 3; i++) {
        await tab.settle();
        tab.tick();
      }
      await tab.settle();
      const what = JSON.stringify(answer);
      expect(tab.$("delete-dialog").shown, what).toBe(false);
      expect([tab.$("storage-message").textContent, tab.$("storage-message").shown], what).toEqual([NOT_RELOADED, true]);
      expect(tab.doc.activeElement, what).toBe(tab.$("h-page"));
      // The rows as last shown get their Delete back.
      expect(rows(tab).map((r) => deleteOf(r).disabled), what).toEqual([false, false, false]);
    }
  });

  it("a double click on Delete GIF sends one request, and a lost session goes to /signin", async () => {
    const once = openStorage(standard({ ["DELETE /api/v1/media/" + G1]: { status: 204 }, "GET /api/v1/usage/largest": [largest(M5_TOURS), withoutGif] }));
    await once.settle();
    deleteOf(rows(once)[GIF_ROW]).click();
    once.$("delete-go").click();
    once.$("delete-go").click();
    await once.settle();
    expect(deletes(once)).toHaveLength(1);
    const out = openStorage(standard({ ["DELETE /api/v1/media/" + G1]: SIGNED_OUT }));
    await out.settle();
    deleteOf(rows(out)[GIF_ROW]).click();
    out.$("delete-go").click();
    await out.settle();
    expect(out.left()).toBe("/signin");
  });
});

// ---- Against the real app ----

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

describe("the Storage page against the real app", () => {
  it("shows the workspace's own numbers and largest tour, deletes it through the API, and shows the room freed", async () => {
    const { deps } = await makeDeps({ hosts: { tours: "tours.example.com", app: "app.example.com" }, storageAllowanceBytes: 5 * GB });
    await seedAccount(deps, { admin: true, username: "storagecheck-admin" });
    const owner = await seedAccount(deps, { username: "storagecheck" });
    const other = await seedAccount(deps, { username: "storagecheck-other" });
    const made = await redeemSignInCode(deps, await createSignInCode(deps, owner.userId), FIREFOX, null);
    const cookie = `${SESSION_COOKIE}=${made!.secret}`;
    await uploadTour(deps, owner.token, fixtures.v3 as Json);
    // Another workspace's tour never shows here.
    await uploadTour(deps, other.token, { ...(fixtures.v3 as Json), title: "Not yours" });
    const before = (await send(deps, "GET", "/api/v1/usage", { token: owner.token })).json;
    const listed = (await send(deps, "GET", "/api/v1/usage/largest", { token: owner.token })).json.tours;
    expect(listed).toHaveLength(1);

    const tab = openStorage(browser(deps, cookie));
    await tab.settle();
    expect(tab.$("dash-user").textContent).toBe("storagecheck");
    expect(before.used_bytes).toBeGreaterThan(0);
    expect(line(tab)).toBe(`${formatBytes(before.used_bytes)} of 5 GB used · 1 tour`);
    expect(tab.$("storage-bar").shown).toBe(true);
    expect(rows(tab).map(titleOf)).toEqual([listed[0].title]);
    expect(cells(rows(tab)[0])[2].textContent).toBe(formatBytes(listed[0].bytes));

    deleteOf(rows(tab)[0]).click();
    tab.$("delete-go").click();
    await tab.settle();
    expect(tab.$("delete-dialog").shown).toBe(false);
    expect(tab.$("delete-message").textContent).toBe("");
    expect(line(tab)).toBe("0 bytes of 5 GB used · 0 tours");
    expect(tab.$("largest").shown).toBe(false);
    expect((await send(deps, "GET", "/api/v1/tours", { token: owner.token })).json.tours).toEqual([]);
    expect((await send(deps, "GET", "/api/v1/tours", { token: other.token })).json.tours).toHaveLength(1);
  });
});

describe("the Storage page against the real app, with shared items", () => {
  /** Shares one image or clip through the API and finishes it; returns its id. */
  async function share(deps: Deps, token: string, kind: "image" | "clip", bytes: number, title: string | null, commit = true): Promise<string> {
    const body = kind === "image" ? { kind, content_type: "image/png", bytes, width: 64, height: 64, title } : { kind, content_type: "image/gif", bytes, width: 32, height: 32, duration_ms: 1200, title };
    if (title === null) delete (body as { title?: unknown }).title;
    const made = await send(deps, "POST", "/api/v1/media", { token, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    expect(made.status, made.text).toBe(201);
    const id = made.json.id as string;
    const file = kind === "image" ? png(64, 64, bytes) : gif(32, 32, bytes);
    expect((await send(deps, "PUT", `/api/v1/media/${id}/parts/0`, { token, body: file as NonNullable<RequestInit["body"]> })).status).toBe(204);
    if (commit) expect((await send(deps, "POST", `/api/v1/media/${id}/commit`, { token })).status).toBe(200);
    return id;
  }

  it("shows the workspace's own items with their kinds and counts, never another's, and deletes an image and a GIF through the API", async () => {
    const { deps } = await makeDeps({ hosts: { tours: "tours.example.com", app: "app.example.com" }, storageAllowanceBytes: 5 * GB });
    await seedAccount(deps, { admin: true, username: "itemcheck-admin" });
    const owner = await seedAccount(deps, { username: "itemcheck" });
    const other = await seedAccount(deps, { username: "itemcheck-other" });
    const made = await redeemSignInCode(deps, await createSignInCode(deps, owner.userId), FIREFOX, null);
    const cookie = `${SESSION_COOKIE}=${made!.secret}`;
    await uploadTour(deps, owner.token, fixtures.v3 as Json);
    const image = await share(deps, owner.token, "image", 900_000, '<script>x</script>');
    const clip = await share(deps, owner.token, "clip", 800_000, null);
    // An unfinished image: its bytes count and it is listed, but it is not one of the images yet.
    await share(deps, owner.token, "image", 700_000, "Still sending", false);
    // Another workspace's items never show here.
    await share(deps, other.token, "image", 950_000, "Not yours");
    await share(deps, other.token, "clip", 850_000, "Not yours either");
    const before = (await send(deps, "GET", "/api/v1/usage", { token: owner.token })).json;

    const tab = openStorage(browser(deps, cookie));
    await tab.settle();
    expect(line(tab)).toBe(`${formatBytes(before.used_bytes)} of 5 GB used · 1 image · 1 GIF · 1 tour`);
    expect(rows(tab).map((r) => [titleOf(r), kindOf(r)])).toEqual([
      ["<script>x</script>", "Image"],
      ["Untitled GIF", "GIF"],
      ["Still sending", "Image"],
      [(fixtures.v3 as Json).title, "Tour"],
    ]);
    expect(room(tab)[1]).toBe(formatBytes(before.counted.gifs));
    expect(room(tab)[2]).toBe(formatBytes(before.counted.images));
    expect(tab.doc.root.all().some((e) => e.tagName === "script" && e.textContent === "x")).toBe(false);

    // The image, then the GIF.
    deleteOf(rows(tab)[0]).click();
    expect(tab.$("delete-go").textContent).toBe("Delete image");
    tab.$("delete-go").click();
    await tab.settle();
    expect(tab.$("delete-dialog").shown).toBe(false);
    expect(rows(tab).map(titleOf)).toEqual(["Untitled GIF", "Still sending", (fixtures.v3 as Json).title]);
    deleteOf(rows(tab)[0]).click();
    expect(tab.$("delete-go").textContent).toBe("Delete GIF");
    tab.$("delete-go").click();
    await tab.settle();
    expect(rows(tab).map(kindOf)).toEqual(["Image", "Tour"]);
    expect(line(tab)).toMatch(/ used · 1 tour$/);
    for (const id of [image, clip]) expect((await send(deps, "GET", `/api/v1/media/${id}`, { token: owner.token })).status).toBe(404);
    const after = (await send(deps, "GET", "/api/v1/usage", { token: owner.token })).json;
    expect(after.used_bytes).toBe(before.used_bytes - before.counted.gifs - 900_000);
    // The other workspace's items are untouched.
    expect((await send(deps, "GET", "/api/v1/usage", { token: other.token })).json).toMatchObject({ images: 1, gifs: 1 });
  });
});
