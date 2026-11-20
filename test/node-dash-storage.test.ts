// What the Storage page's script does when it runs: the page's document, the shared
// /dash/dash.js and the page's /dash/storage.js are run in one fresh Node `vm` context
// against a stand-in document built from the page's own HTML (test/pages-dom.ts), with a
// stand-in fetch that either answers from the test or hands the request to the real app.
// Node only: the Workers runtime runs no code from a string.
//
// What this leaves unproven, for a by-hand check in two browsers: the real layout of the
// bars, `inert` as a browser applies it, focus rings, and a screen reader.
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { createApp } from "../src/app.ts";
import { DASH_JS } from "../src/dash/script.ts";
import { STORAGE_HTML, STORAGE_JS } from "../src/dash/storage.ts";
import type { Deps } from "../src/ports.ts";
import { SESSION_COOKIE, createSignInCode, redeemSignInCode } from "../src/sessions.ts";
import { formatBytes } from "../src/usage.ts";
import { fixtures, send, uploadTour, type Json } from "./bundle.ts";
import { FakeDocument, FakeElement, visibleText } from "./pages-dom.ts";

const APP = "https://app.example.com";
const CSRF = "c".repeat(64);
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";
const FAILED = "Something went wrong. Try again in a moment.";
const TOO_MANY = "Too many requests. Wait a few minutes and try again.";
const BUSY = "This tour is being published. Try again when that is done.";
const OVER = "You are over your storage allowance. New uploads are refused until you delete tours or get more room.";
const ONLINE = "Tours that are already online are not affected.";
const COUNTS = "Tours and their pictures count. Deleting a tour frees its space within a few minutes.";
const QUESTION = "Its link stops working for everyone and its pictures are removed. This cannot be undone. The recording on your computer is not touched.";

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
  // The document as a browser's: its own keyboard events reach listeners on it (the stand-in
  // sends every event up to its root element).
  const document = new Proxy(doc, {
    get(target, prop) {
      if (prop === "addEventListener") return (type: string, fn: (e: unknown) => void) => target.root.addEventListener(type, fn);
      return Reflect.get(target, prop, target);
    },
  });
  const context: Record<string, unknown> = { document, location, fetch };
  for (const name of ["localStorage", "sessionStorage", "indexedDB", "caches", "cookieStore", "XMLHttpRequest", "WebSocket", "EventSource", "window", "self", "top", "parent", "opener", "open", "postMessage", "setInterval", "setTimeout", "console", "alert", "confirm", "prompt", "history", "navigator"]) {
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
  json: { account: { id: "usr_1", username: "solex", email: "solex@example.com", admin: false }, workspace: { id: "ws_1", name: workspace }, session: { id: "ses_1", created_at: 0, expires_at: 0 }, csrf: CSRF },
});
type UsageNumbers = { pictures: number; logos: number; uploads: number; allowance: number | null; tours: number };
const usage = (n: UsageNumbers): Answer => {
  const used = n.pictures + n.logos + n.uploads;
  return { status: 200, json: { used_bytes: used, allowance_bytes: n.allowance, over: n.allowance !== null && used > n.allowance, tours: n.tours, counted: { pictures: n.pictures, logos: n.logos, uploads_in_progress: n.uploads } } };
};

const T1 = "tour_" + "1".repeat(24);
const T2 = "tour_" + "2".repeat(24);
const T3 = "tour_" + "3".repeat(24);
const largest = (tours: { id: string; title: string; bytes: number }[]): Answer => ({ status: 200, json: { tours } });

/** Mockup 5, in this version: 1.2 GB of 5 GB, 12 tours, the three largest. */
const M5 = { pictures: 790 * MB, logos: 340 * KB, uploads: 438 * MB + 500 * KB, allowance: 5 * GB, tours: 12 };
const M5_TOURS = [
  { id: T1, title: "Full onboarding, long cut", bytes: 412 * MB },
  { id: T2, title: "Timeline rehearsal walkthrough", bytes: 255 * MB },
  { id: T3, title: "Loot council vote, full round", bytes: 96 * MB },
];

function standard(extra: Record<string, Answer | Answer[]> = {}): Responder {
  return answers({ "GET /api/v1/session": session(), "GET /api/v1/usage": usage(M5), "GET /api/v1/usage/largest": largest(M5_TOURS), ...extra });
}

const rows = (tab: Tab) => tab.$("largest-rows").children.filter((c): c is FakeElement => c instanceof FakeElement);
const cells = (row: FakeElement) => row.children.filter((c): c is FakeElement => c instanceof FakeElement);
const titleOf = (row: FakeElement) => cells(row)[0].textContent;
const deleteOf = (row: FakeElement) => row.all().find((e) => e.tagName === "button")!;
const fillOf = (row: FakeElement) => row.all().find((e) => e.className === "mini-fill")!;
const line = (tab: Tab) => tab.$("storage-total").textContent;
const room = (tab: Tab) => [tab.$("room-tours").textContent, tab.$("room-logos").textContent, tab.$("room-uploads").textContent];
const inert = (tab: Tab) => [tab.doc.body.all().find((e) => e.tagName === "header")!, tab.$("storage-page"), tab.$("dash-load")].map((e) => e.hasAttribute("inert"));
const key = (el: FakeElement, k: string, shiftKey = false) => el.dispatch("keydown", { key: k, shiftKey });
const gets = (tab: Tab, path: string) => tab.fetched.filter((f) => f.method === "GET" && f.path === path).length;

describe("the Storage page", () => {
  it("shows mockup 5: the workspace, the bar, the line, what takes the room, the largest tours and the hint", async () => {
    const tab = openStorage(standard());
    await tab.settle();
    expect(tab.left()).toBeNull();
    expect(tab.fetched.map((f) => `${f.method} ${f.path}`).sort()).toEqual(["GET /api/v1/session", "GET /api/v1/usage", "GET /api/v1/usage/largest"]);
    expect(tab.$("storage-workspace").textContent).toBe("Cowfee Raid Tools");
    expect(line(tab)).toBe("1.2 GB of 5 GB used · 12 tours");
    const bar = tab.$("storage-bar");
    expect([bar.shown, bar.className, tab.$("storage-fill").style.width]).toEqual([true, "meter", "24%"]);
    expect([tab.$("storage-over").shown, tab.$("storage-online").shown, tab.$("storage-counts").shown]).toEqual([false, false, true]);
    expect(room(tab)).toEqual(["790 MB", "340 KB", "438.5 MB"]);
    expect(rows(tab).map((r) => [titleOf(r), fillOf(r).style.width, cells(r)[2].textContent, deleteOf(r).textContent])).toEqual([
      ["Full onboarding, long cut", "100%", "412 MB", "Delete"],
      ["Timeline rehearsal walkthrough", "61.89%", "255 MB", "Delete"],
      ["Loot council vote, full round", "23.3%", "96 MB", "Delete"],
    ]);
    // Each Delete names its tour for a screen reader; the small bars are drawings.
    for (const [i, r] of rows(tab).entries()) {
      expect([deleteOf(r).getAttribute("type"), deleteOf(r).className, deleteOf(r).getAttribute("aria-describedby")]).toEqual(["button", "btn sm danger", cells(r)[0].id]);
      expect(cells(r)[0].id).toBe(`largest-${i}`);
      expect(cells(r)[1].getAttribute("aria-hidden")).toBe("true");
    }
    expect(tab.$("largest").shown).toBe(true);
    expect(tab.shows()).toEqual([
      "Mythicshot",
      "solex",
      "Storage",
      "Cowfee Raid Tools",
      "1.2 GB of 5 GB used · 12 tours",
      COUNTS,
      "What takes the room",
      "Largest tours",
      "Delete",
      "Delete",
      "Delete",
      "All 12 tours are on the Tours page.",
    ]);
    // What takes the room, row by row.
    expect(tab.$("h-room").parent!.all().filter((e) => e.className === "room").map((r) => r.textContent)).toEqual(["Tours790 MB", "Logos340 KB", "Uploads in progress438.5 MB"]);
    expect(tab.fetched.filter((f) => f.method !== "GET")).toEqual([]);
  });

  it("with no allowance there is no bar, only the total", async () => {
    const tab = openStorage(standard({ "GET /api/v1/usage": usage({ ...M5, allowance: null }) }));
    await tab.settle();
    expect(line(tab)).toBe("1.2 GB used · 12 tours");
    expect(tab.$("storage-bar").shown).toBe(false);
    expect(tab.$("storage-over").shown).toBe(false);
    expect(tab.$("storage-counts").shown).toBe(true);
  });

  it("shows mockup 6 when the workspace is over: the bar full in the warning colour, the warning, and that online tours are not affected", async () => {
    const tab = openStorage(standard({ "GET /api/v1/usage": usage({ pictures: 5 * GB + 300 * MB, logos: 0, uploads: 0, allowance: 5 * GB, tours: 31 }) }));
    await tab.settle();
    expect(line(tab)).toBe("5.3 GB of 5 GB used · 31 tours");
    expect([tab.$("storage-bar").shown, tab.$("storage-bar").className, tab.$("storage-fill").style.width]).toEqual([true, "meter over", "100%"]);
    expect([tab.$("storage-over").shown, tab.$("storage-online").shown, tab.$("storage-counts").shown]).toEqual([true, true, false]);
    expect(tab.shows().slice(4, 7)).toEqual(["5.3 GB of 5 GB used · 31 tours", OVER, ONLINE]);
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
    expect(room(tab)).toEqual(["0 bytes", "0 bytes", "0 bytes"]);
    expect(tab.$("largest").shown).toBe(false);
    expect(rows(tab)).toEqual([]);
    expect(tab.$("storage-counts").shown).toBe(true);
  });

  it("writes one tour in the singular, and a title holding markup as text", async () => {
    const tab = openStorage(
      standard({
        "GET /api/v1/session": session("<i>ws</i>"),
        "GET /api/v1/usage": usage({ pictures: 2 * MB, logos: 0, uploads: 0, allowance: null, tours: 1 }),
        "GET /api/v1/usage/largest": largest([{ id: T1, title: '<img src=x onerror="alert(1)">', bytes: 2 * MB }]),
      }),
    );
    await tab.settle();
    expect(line(tab)).toBe("2 MB used · 1 tour");
    expect(tab.$("largest-all").textContent + "Tours page.").toBe("Your tour is on the Tours page.");
    const title = cells(rows(tab)[0])[0];
    expect(title.textContent).toBe('<img src=x onerror="alert(1)">');
    expect(title.children.every((c) => !(c instanceof FakeElement))).toBe(true);
    expect(tab.$("storage-workspace").textContent).toBe("<i>ws</i>");
    expect(tab.doc.root.all().some((e) => e.tagName === "img" || e.tagName === "i")).toBe(false);
  });

  it("leaves out a row the API did not answer as a tour", async () => {
    const tab = openStorage(standard({ "GET /api/v1/usage/largest": largest([{ id: "x", title: "a", bytes: 1 }, null as never, { id: T2, title: "ok", bytes: 5 }, { id: T3, title: "no size", bytes: "5" as never }]) }));
    await tab.settle();
    expect(rows(tab).map(titleOf)).toEqual(["ok"]);
  });

  it("says when the numbers cannot be read, with the approved sentences, and shows none of them", async () => {
    for (const [table, text] of [
      [{ "GET /api/v1/usage": { status: 500, json: { error: "internal" } } }, FAILED],
      [{ "GET /api/v1/usage/largest": { status: 429, json: { error: "rate_limited" } } }, TOO_MANY],
      [{ "GET /api/v1/usage": "network" }, FAILED],
      [{ "GET /api/v1/usage": { status: 200, json: { used_bytes: "1" } } }, FAILED],
      [{ "GET /api/v1/usage/largest": { status: 200, json: { tours: "x" } } }, FAILED],
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
    expect(inert(tab)).toEqual([false, false, false]);
    const del = deleteOf(rows(tab)[1]);
    del.click();
    const dialog = tab.$("delete-dialog");
    expect(dialog.shown).toBe(true);
    expect(tab.$("delete-title").textContent).toBe('Delete "Timeline rehearsal walkthrough"?');
    expect(tab.shows().slice(-4)).toEqual(['Delete "Timeline rehearsal walkthrough"?', QUESTION, "Keep it", "Delete tour"]);
    expect(tab.doc.activeElement).toBe(tab.$("delete-keep"));
    expect(inert(tab)).toEqual([true, true, true]);
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
    expect(inert(tab)).toEqual([false, false, false]);
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
    expect(inert(tab)).toEqual([false, false, false]);
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
    expect(inert(tab)).toEqual([false, false, false]);
    expect([go.textContent, go.disabled, keep.disabled, go.getAttribute("aria-busy")]).toEqual(["Delete tour", false, false, null]);
    expect([gets(tab, "/api/v1/usage"), gets(tab, "/api/v1/usage/largest")]).toEqual([2, 2]);
    expect(rows(tab).map(titleOf)).toEqual(["Full onboarding, long cut", "Loot council vote, full round"]);
    expect(line(tab)).toBe("973.8 MB of 5 GB used · 11 tours");
    expect(tab.$("largest-all").textContent).toBe("All 11 tours are on the ");
    expect(tab.doc.activeElement).toBe(tab.$("h-page"));
    expect(tab.$("storage-message").textContent).toBe("");
  });

  it("a tour already gone counts as deleted", async () => {
    const tab = openStorage(standard({ ["DELETE /api/v1/tours/" + T1]: { status: 404, json: { error: "not_found" } }, "GET /api/v1/usage/largest": [largest(M5_TOURS), largest(M5_TOURS.slice(1))] }));
    await tab.settle();
    deleteOf(rows(tab)[0]).click();
    tab.$("delete-go").click();
    await tab.settle();
    expect(tab.$("delete-dialog").shown).toBe(false);
    expect(rows(tab).map(titleOf)).toEqual(["Timeline rehearsal walkthrough", "Loot council vote, full round"]);
  });

  it("a delete that fails keeps the question open with its sentence, gives the buttons back, and still reads the numbers again", async () => {
    for (const [answer, text] of [
      [{ status: 500, json: { error: "cleanup_pending" } }, FAILED],
      [{ status: 409, json: { error: "publish_busy" } }, BUSY],
      [{ status: 429, json: { error: "rate_limited" } }, TOO_MANY],
      [{ status: 409, json: { error: "other" } }, FAILED],
      ["network", FAILED],
    ] as const) {
      // After the failure the numbers have changed (a cleanup_pending tour is gone from the list already).
      const tab = openStorage(standard({ ["DELETE /api/v1/tours/" + T1]: answer as Answer, "GET /api/v1/usage/largest": [largest(M5_TOURS), largest(M5_TOURS.slice(1))], "GET /api/v1/usage": [usage(M5), usage({ ...M5, tours: 11 })] }));
      await tab.settle();
      deleteOf(rows(tab)[0]).click();
      tab.$("delete-go").click();
      await tab.settle();
      const what = JSON.stringify(answer);
      expect(tab.$("delete-dialog").shown, what).toBe(true);
      expect(tab.$("delete-message").textContent, what).toBe(text);
      expect([tab.$("delete-go").textContent, tab.$("delete-go").disabled, tab.$("delete-keep").disabled], what).toEqual(["Delete tour", false, false]);
      expect(tab.doc.activeElement, what).toBe(tab.$("delete-go"));
      expect(inert(tab), what).toEqual([true, true, true]);
      expect([gets(tab, "/api/v1/usage"), gets(tab, "/api/v1/usage/largest")], what).toEqual([2, 2]);
      expect(rows(tab).map(titleOf), what).toEqual(["Timeline rehearsal walkthrough", "Loot council vote, full round"]);
      expect(line(tab), what).toBe("1.2 GB of 5 GB used · 11 tours");
      // Closed now, the focus goes to the heading, as the row it came from is no longer shown.
      tab.$("delete-keep").click();
      expect(tab.$("delete-dialog").shown, what).toBe(false);
      expect(tab.doc.activeElement, what).toBe(tab.$("h-page"));
      expect(tab.$("delete-message").textContent, what).toBe("");
    }
  });

  it("when the numbers cannot be read again after a delete, the page shows none of them and says so", async () => {
    const tab = openStorage(standard({ ["DELETE /api/v1/tours/" + T1]: { status: 200, json: { deleted: true } }, "GET /api/v1/usage": [usage(M5), { status: 500, json: { error: "internal" } }] }));
    await tab.settle();
    deleteOf(rows(tab)[0]).click();
    tab.$("delete-go").click();
    await tab.settle();
    expect(tab.$("delete-dialog").shown).toBe(false);
    expect(tab.$("storage").hidden).toBe(true);
    expect(tab.$("dash-load").textContent).toBe(FAILED);
    expect(inert(tab)).toEqual([false, false, false]);
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
