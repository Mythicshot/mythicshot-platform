// What the dashboard's scripts do when they run: the Tours page's document, the shared
// /dash/dash.js and the page's /dash/tours.js are run in one fresh Node `vm` context
// against a stand-in document built from the page's own HTML (test/pages-dom.ts), with a
// stand-in address, clipboard, timer and fetch. The fetch either answers from the test or
// is handed to the real app, as a browser on the app address would send it. Node only: the
// Workers runtime runs no code from a string.
//
// What this leaves unproven, for docs/dashboard-browser-check.md: real layout at phone
// width, focus rings, a screen reader, the browser's clipboard and its handling of the policy.
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { createApp } from "../src/app.ts";
import { DASH_JS } from "../src/dash/script.ts";
import { TOURS_HTML, TOURS_JS } from "../src/dash/tours.ts";
import type { Deps } from "../src/ports.ts";
import { SESSION_COOKIE, createSignInCode, redeemSignInCode } from "../src/sessions.ts";
import { fixtures, send, uploadTour, type Json } from "./bundle.ts";
import { FakeDocument, FakeElement, visibleText } from "./pages-dom.ts";
import { SIZE_TABLE } from "./sizes.ts";

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
// Proposed for the owner's approval (review follow-ups L4 and M1).
const EMPTY_TOUR = "This tour has no steps, so it cannot be published.";
const PUBLISH_BUSY = "This tour is being published. Try again when that is done.";
const NOT_RELOADED = "The change was made, but the list could not be loaded again. Reload the page to see it.";

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
  /** Runs every timer the script set, as if their time had passed. */
  tick: () => void;
  clipboard: Clipboard;
  violations: string[];
};

const open: Tab[] = [];
afterEach(() => {
  for (const tab of open.splice(0)) expect(tab.violations, "the script used something it must not").toEqual([]);
});

/** Opens the Tours page at `origin` and runs its two scripts in order, as a browser does with two deferred scripts. */
function openTours(respond: Responder, opts: { origin?: string; clipboard?: Clipboard["answer"] } = {}): Tab {
  const doc = new FakeDocument(TOURS_HTML);
  const origin = opts.origin ?? APP;
  let left: string | null = null;
  const fetched: Fetched[] = [];
  const pending: Promise<unknown>[] = [];
  const violations: string[] = [];
  const timers: (() => void)[] = [];
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
  const setTimeout = (fn: () => void) => {
    timers.push(fn);
    return timers.length;
  };

  const context: Record<string, unknown> = { document: doc, location, fetch, navigator, setTimeout };
  for (const name of ["localStorage", "sessionStorage", "indexedDB", "caches", "cookieStore", "XMLHttpRequest", "WebSocket", "EventSource", "window", "self", "top", "parent", "opener", "open", "postMessage", "setInterval", "console", "alert", "confirm", "prompt", "history"]) {
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
  vm.runInContext(TOURS_JS, ctx, { filename: "tours.js" });

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
    clipboard,
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
const session = (account: Record<string, unknown> = {}, workspace = "Cowfee Raid Tools"): Answer => ({
  status: 200,
  json: { account: { id: "usr_1", username: "solex", email: "solex@example.com", admin: false, ...account }, workspace: { id: "ws_1", name: workspace }, session: { id: "ses_1", created_at: NOW, expires_at: NOW }, csrf: CSRF },
});
const ME_ONE: Answer = { status: 200, json: { workspace: "Cowfee Raid Tools", version: "0.1.12" } };
const meTwo = (tours: string): Answer => ({ status: 200, json: { workspace: "Cowfee Raid Tools", version: "0.1.12", addresses: { tours, app: "app.example.com" } } });
const usage = (used: number): Answer => ({ status: 200, json: { used_bytes: used, allowance_bytes: null, over: false, tours: 3, counted: { pictures: used, logos: 0, uploads_in_progress: 0 } } });

const T1 = "tour_" + "1".repeat(24);
const T2 = "tour_" + "2".repeat(24);
const T3 = "tour_" + "3".repeat(24);
const tour = (id: string, over: Record<string, unknown>) => ({
  id,
  title: "A tour",
  status: "published",
  slug: "k3f9abcdef",
  url: "/t/k3f9abcdef",
  chapters: 1,
  steps: 14,
  bytes: 6_396_313,
  updated_at: day(2026, 11, 19),
  published_at: day(2026, 11, 19),
  unpublished_changes: false,
  ...over,
});
/** The three tours of mockup 1. */
const MOCKUP_TOURS = [
  tour(T1, { title: "Timeline rehearsal walkthrough", slug: "k3f9abcdef", url: "/t/k3f9abcdef", steps: 14, bytes: 6_396_313, updated_at: day(2026, 11, 19) }),
  tour(T2, { title: "Loot master setup", slug: "p71cabcdef", url: "/t/p71cabcdef", steps: 9, bytes: 2_726_298, updated_at: day(2026, 11, 18), unpublished_changes: true }),
  tour(T3, { title: "Note send rehearsal", status: "draft", slug: "q2zzabcdef", url: null, steps: 6, bytes: 1_992_294, updated_at: day(2026, 11, 17), published_at: null }),
];
const toursAnswer = (tours: unknown[]): Answer => ({ status: 200, json: { tours } });
const USED = 9_122_611; // 8.7 MB

/** The standard page: signed in, the mockup's tours, one-address mode. */
function standard(extra: Record<string, Answer | Answer[]> = {}): Responder {
  return answers({ "GET /api/v1/session": session(), "GET /api/v1/me": ME_ONE, "GET /api/v1/tours": toursAnswer(MOCKUP_TOURS), "GET /api/v1/usage": usage(USED), ...extra });
}

/** The rows of the list. */
const rows = (tab: Tab) => tab.$("tours-rows").children.filter((c): c is FakeElement => c instanceof FakeElement);
/** The controls a person can use in a row, by their words: buttons and links shown. */
const controlsOf = (row: FakeElement) => row.all().filter((e) => (e.tagName === "button" || e.tagName === "a") && e.shown && e.getAttribute("role") !== "menuitem");
const byText = (row: FakeElement, text: string) => {
  const found = row.all().find((e) => (e.tagName === "button" || e.tagName === "a") && e.textContent === text);
  if (!found) throw new Error(`no "${text}" in the row`);
  return found;
};
const menuOf = (row: FakeElement) => row.all().find((e) => e.getAttribute("role") === "menu")!;
const menuItems = (row: FakeElement) => menuOf(row).all().filter((e) => e.getAttribute("role") === "menuitem");
const key = (el: FakeElement, k: string, shiftKey = false) => el.dispatch("keydown", { key: k, shiftKey });
/** Every button of every row, menus included. */
const rowButtons = (tab: Tab) => rows(tab).flatMap((row) => row.all().filter((e) => e.tagName === "button"));

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

describe("the shared script", () => {
  it("sends a visitor who is not signed in to /signin and asks nothing else", async () => {
    const tab = openTours(answers({ "GET /api/v1/session": SIGNED_OUT }));
    await tab.settle();
    expect(tab.left()).toBe("/signin");
    expect(tab.fetched.map((f) => `${f.method} ${f.path}`)).toEqual(["GET /api/v1/session"]);
    expect(tab.$("tours").hidden).toBe(true);
    expect(tab.$("dash-user").textContent).toBe("");
  });

  it("says when the session cannot be read, with the approved sentences", async () => {
    for (const [answer, text] of [[{ status: 500, json: { error: "internal" } }, FAILED], [{ status: 429, json: { error: "rate_limited" } }, TOO_MANY], ["network", FAILED], [{ status: 200, json: { account: {} } }, FAILED]] as const) {
      const tab = openTours(answers({ "GET /api/v1/session": answer as Answer }));
      await tab.settle();
      expect(tab.$("dash-load").textContent, JSON.stringify(answer)).toBe(text);
      expect(tab.$("tours").hidden).toBe(true);
      expect(tab.left()).toBeNull();
    }
  });

  it("fills the username with text, shows Admin only for an admin, and every request goes to this site with the session", async () => {
    const member = openTours(standard({ "GET /api/v1/session": session({ username: "<b>solex</b>" }) }));
    await member.settle();
    expect(member.$("dash-user").textContent).toBe("<b>solex</b>");
    expect(member.$("dash-user").children.every((c) => !(c instanceof FakeElement))).toBe(true);
    expect(member.$("tab-admin").hidden).toBe(true);
    for (const f of member.fetched) {
      expect(f.init, f.path).toMatchObject({ credentials: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" });
      expect(f.headers["X-Csrf-Token"], `${f.path}: a GET carries no anti-forgery value`).toBeUndefined();
    }

    const admin = openTours(standard({ "GET /api/v1/session": session({ admin: true }) }));
    await admin.settle();
    expect(admin.$("tab-admin").hidden).toBe(false);
    // Anything but true is no admin.
    const truthy = openTours(standard({ "GET /api/v1/session": session({ admin: "yes" }) }));
    await truthy.settle();
    expect(truthy.$("tab-admin").hidden).toBe(true);
    // An account without a username shows the word Account, never its email address: people record their screens.
    for (const username of [null, "", 7]) {
      const noName = openTours(standard({ "GET /api/v1/session": session({ username }) }));
      await noName.settle();
      expect(noName.$("dash-user").textContent, String(username)).toBe("Account");
      expect(noName.doc.root.textContent, String(username)).not.toContain("solex@example.com");
    }
  });

  it("Dash.api refuses any path that is not one absolute path of this site, before any request", async () => {
    const fetched: string[] = [];
    const ctx = vm.createContext({ document: {}, location: {}, fetch: (p: string) => (fetched.push(p), Promise.resolve(new Response("{}"))) });
    vm.runInContext(DASH_JS, ctx);
    const api = vm.runInContext("Dash.api", ctx) as (method: string, path: unknown, body?: unknown) => Promise<unknown>;
    for (const path of ["//evil.example.net/x", "/\\evil.example.net/x", "https://evil.example.net/", "api/v1/tours", "", " /api/v1/tours", "javascript:alert(1)", null, 7]) {
      expect(() => api("GET", path), String(path)).toThrow();
      expect(() => api("POST", path, {}), String(path)).toThrow();
    }
    expect(fetched).toEqual([]);
    await api("GET", "/api/v1/tours");
    expect(fetched).toEqual(["/api/v1/tours"]);
  });

  it("writes sizes as the server and the account page do", async () => {
    const ctx = vm.createContext({ document: {}, location: {}, fetch: () => Promise.reject(new Error("no")) });
    vm.runInContext(DASH_JS, ctx);
    const format = vm.runInContext("Dash.formatBytes", ctx) as (n: number) => string;
    for (const [n, text] of SIZE_TABLE) expect(format(n), String(n)).toBe(text);
    vm.runInContext(`(function () { var Real = Date; Date = function (v) { return arguments.length === 0 ? new Real(${NOW}) : new Real(v); }; Date.prototype = Real.prototype; })();`, ctx);
    const dateOf = vm.runInContext("Dash.dateOf", ctx) as (ms: unknown) => string;
    for (const ms of [day(2026, 11, 19), day(2026, 1, 1), day(2025, 12, 31)]) expect(dateOf(ms)).toBe(shown(ms));
    expect(dateOf("x")).toBe("");
    // With the year asked for, always with the year, this year's dates too (the Connections page).
    const withYear = dateOf as (ms: unknown, withYear?: unknown) => string;
    for (const ms of [day(2026, 11, 19), day(2025, 12, 31)]) {
      const d = new Date(ms);
      expect(withYear(ms, true)).toBe(`${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`);
      expect(withYear(ms, "yes")).toBe(shown(ms));
    }
    expect(withYear("x", true)).toBe("");
  });

  it("Dash.api hands the page the answer's retry-after header as sent, or null", async () => {
    const answers = [new Response('{"error":"rate_limited"}', { status: 429, headers: { "retry-after": "540" } }), new Response("{}", { status: 200 })];
    const ctx = vm.createContext({ document: {}, location: {}, fetch: () => Promise.resolve(answers.shift()) });
    vm.runInContext(DASH_JS, ctx);
    const api = vm.runInContext("Dash.api", ctx) as (method: string, path: string) => Promise<unknown>;
    expect(JSON.parse(JSON.stringify(await api("GET", "/api/v1/connect/requests/ABCDEFGH")))).toEqual({ status: 429, data: { error: "rate_limited" }, retryAfter: "540" });
    expect(JSON.parse(JSON.stringify(await api("GET", "/api/v1/tokens")))).toEqual({ status: 200, data: {}, retryAfter: null });
  });
});

describe("the Tours page", () => {
  it("shows mockup 1: the heading line, one row per tour in the API's order, tags, sizes, dates and buttons, and the hint", async () => {
    const tab = openTours(standard());
    await tab.settle();
    expect(tab.left()).toBeNull();
    expect(tab.fetched.map((f) => `${f.method} ${f.path}`).sort()).toEqual(["GET /api/v1/me", "GET /api/v1/session", "GET /api/v1/tours", "GET /api/v1/usage"]);
    expect(tab.$("tours-count").textContent + tab.$("tours-in").textContent + tab.$("tours-used").textContent).toBe("3 tours in Cowfee Raid Tools · 8.7 MB used");
    // On a phone the workspace's name is left out, as in mockup 11.
    expect(tab.$("tours-in").className).toBe("wide-only");
    const r = rows(tab);
    expect(r.map((row) => row.all().find((e) => e.className === "t")!.textContent)).toEqual(["Timeline rehearsal walkthrough", "Loot master setup", "Note send rehearsal"]);
    const cells = (row: FakeElement) => row.children.filter((c): c is FakeElement => c instanceof FakeElement);
    const summary = (row: FakeElement) => {
      const [what, status, size, when] = cells(row);
      const d = what.all().find((e) => e.className === "d")!;
      return {
        wide: d.children.filter((c): c is FakeElement => c instanceof FakeElement && c.className !== "narrow-only").map((c) => c.textContent).join(""),
        narrow: d.children.filter((c): c is FakeElement => c instanceof FakeElement && c.className !== "wide-only").map((c) => c.textContent).join(""),
        tags: status.all().map((t) => [t.className, t.textContent]),
        size: size.textContent,
        when: when.textContent,
        controls: controlsOf(row).map((c) => c.textContent),
      };
    };
    expect(r.map(summary)).toEqual([
      { wide: "14 steps · app.example.com/t/k3f9…", narrow: `14 steps · 6.1 MB · ${shown(day(2026, 11, 19))}`, tags: [["tag ok", "Published"]], size: "6.1 MB", when: shown(day(2026, 11, 19)), controls: ["Copy link", "Open", "More"] },
      {
        wide: "9 steps · app.example.com/t/p71c…",
        narrow: `9 steps · 2.6 MB · ${shown(day(2026, 11, 18))}`,
        tags: [["tag ok", "Published"], ["tag warn", "Changes waiting"]],
        size: "2.6 MB",
        when: shown(day(2026, 11, 18)),
        controls: ["Copy link", "Open", "More"],
      },
      { wide: "6 steps · no public link", narrow: `6 steps · 1.9 MB · ${shown(day(2026, 11, 17))}`, tags: [["tag", "Not published"]], size: "1.9 MB", when: shown(day(2026, 11, 17)), controls: ["Publish", "More"] },
    ]);
    expect(shown(day(2026, 11, 19))).toBe("19 Nov");
    // The full link is in the shortened text's title; a tour without a link has none.
    expect(r.map((row) => row.all().find((e) => e.className === "wide-only")!.getAttribute("title"))).toEqual([`${APP}/t/k3f9abcdef`, `${APP}/t/p71cabcdef`, null]);
    // The last column's header has a name for a screen reader, hidden from sight.
    const lastHeader = tab.doc.root.all().filter((e) => e.tagName === "th").at(-1)!;
    expect([lastHeader.textContent, lastHeader.all()[0]?.className]).toEqual(["Actions", "vh"]);
    // Message lines take no room until there is a message.
    expect(tab.$("tours-message").hidden).toBe(true);
    expect(tab.$("delete-message").hidden).toBe(true);
    // The hint under the table, and no empty state.
    expect(tab.$("tours-hint").shown).toBe(true);
    expect(tab.$("tours-empty").shown).toBe(false);
    expect(tab.$("tours-list").shown).toBe(true);
    // Open is a real link to the public tour in a new tab, without the opener or a referrer.
    const openLink = byText(r[0], "Open");
    expect([openLink.tagName, openLink.getAttribute("href"), openLink.getAttribute("target"), openLink.getAttribute("rel")]).toEqual(["a", `${APP}/t/k3f9abcdef`, "_blank", "noopener noreferrer"]);
    // Every control names its tour for a screen reader.
    for (const [i, row] of r.entries()) for (const c of controlsOf(row)) expect(c.getAttribute("aria-describedby"), c.textContent).toBe(`tour-${i}`);
    for (const row of r) for (const b of row.all().filter((e) => e.tagName === "button")) expect(b.getAttribute("type")).toBe("button");
    // The menus are closed.
    for (const row of r) expect(menuOf(row).hidden).toBe(true);
  });

  it("writes one tour and one step in the singular, and an empty workspace as in mockup 2", async () => {
    const one = openTours(standard({ "GET /api/v1/tours": toursAnswer([tour(T1, { steps: 1 })]) }));
    await one.settle();
    expect(one.$("tours-count").textContent).toBe("1 tour");
    expect(rows(one)[0].all().find((e) => e.className === "d")!.children[0]).toMatchObject({ textContent: "1 step" });

    const none = openTours(standard({ "GET /api/v1/tours": toursAnswer([]), "GET /api/v1/usage": usage(0) }));
    await none.settle();
    expect(none.$("tours-count").textContent + none.$("tours-in").textContent + none.$("tours-used").textContent).toBe("0 tours in Cowfee Raid Tools · 0 bytes used");
    expect(none.$("tours-empty").shown).toBe(true);
    expect(none.$("tours-list").shown).toBe(false);
    expect(none.$("tours-hint").shown).toBe(false);
    expect(none.shows()).toEqual([
      "Mythicshot",
      "solex",
      "Tours",
      "0 tours in Cowfee Raid Tools · 0 bytes used",
      "No tours yet",
      "Record a tour in Mythicshot and choose Publish. It shows up here with a link to share.",
    ]);
  });

  it("shows a title holding markup as text", async () => {
    const tab = openTours(standard({ "GET /api/v1/tours": toursAnswer([tour(T1, { title: '<img src=x onerror="alert(1)">' })]), "GET /api/v1/session": session({}, "<i>ws</i>") }));
    await tab.settle();
    const title = rows(tab)[0].all().find((e) => e.className === "t")!;
    expect(title.textContent).toBe('<img src=x onerror="alert(1)">');
    expect(title.children.every((c) => !(c instanceof FakeElement))).toBe(true);
    expect(tab.$("tours-in").textContent).toBe(" in <i>ws</i>");
    expect(tab.doc.root.all().some((e) => e.tagName === "img" || e.tagName === "i")).toBe(false);
  });

  it("builds the public link from the tours address: https, http only on a local name, and no link at all when it cannot be trusted", async () => {
    const linkFor = async (me: Answer, url: unknown = "/t/k3f9abcdef", origin = APP) => {
      const tab = openTours(standard({ "GET /api/v1/me": me, "GET /api/v1/tours": toursAnswer([tour(T1, { url })]) }), { origin });
      await tab.settle();
      const row = rows(tab)[0];
      const link = row.all().find((e) => e.tagName === "a");
      const wide = row.all().find((e) => e.className === "wide-only")!;
      return { href: link?.getAttribute("href") ?? null, controls: controlsOf(row).map((c) => c.textContent), text: wide.textContent, title: wide.getAttribute("title") };
    };
    expect(await linkFor(meTwo("tours.example.com"))).toEqual({ href: "https://tours.example.com/t/k3f9abcdef", controls: ["Copy link", "Open", "More"], text: " · tours.example.com/t/k3f9…", title: "https://tours.example.com/t/k3f9abcdef" });
    // A slug of four characters or fewer is shown whole.
    expect((await linkFor(ME_ONE, "/t/k3f9")).text).toBe(" · app.example.com/t/k3f9");
    expect((await linkFor(meTwo("TOURS.example.com:8443"))).href).toBe("https://tours.example.com:8443/t/k3f9abcdef");
    expect((await linkFor(meTwo("tours.localhost:8787"), undefined, "http://app.localhost:8787")).href).toBe("http://tours.localhost:8787/t/k3f9abcdef");
    expect((await linkFor(meTwo("127.0.0.1:3001"), undefined, "http://localhost:3000")).href).toBe("http://127.0.0.1:3001/t/k3f9abcdef");
    // One-address mode: this page's own origin, http on a local machine too.
    expect((await linkFor(ME_ONE, undefined, "http://localhost:3000")).href).toBe("http://localhost:3000/t/k3f9abcdef");
    // Nothing that is not a plain path of a tour, and no address that is not a host name, makes a link.
    const none = { href: null, controls: ["More"], text: " · no public link", title: null };
    const hostileUrls = [
      "//evil.example.net/t/x", "javascript:alert(1)", "https://evil.example.net/t/x", "/t/../account", "/t/x?y", "/t/X", "/t/k3f9abcdef#x", "/t/k3f9abcdef/",
      '/t/k3f9"><b>x', "/t/a b", "/t/%2F%2Fevil", "/t/" + "a".repeat(65), "/t/", "/t\\evil", " /t/k3f9abcdef", null, 7, { toString: () => "/t/k3f9abcdef" },
    ];
    for (const url of hostileUrls) expect(await linkFor(ME_ONE, url), String(url)).toEqual(none);
    for (const url of hostileUrls) expect(await linkFor(meTwo("tours.example.com"), url), String(url)).toEqual(none);
    const hostileHosts = ["evil.example.net/x", "user@evil.example.net", "evil.example.net\\x", "", "javascript:alert(1)", " tours.example.com", "tours.example.com\n", "tours.example.com#", "tours.example.com?x", "tours.example.com/", "tours.example.com:", "tours.example.com:123456", '"><b>x'];
    for (const host of hostileHosts) expect(await linkFor(meTwo(host)), host).toEqual(none);
    expect(await linkFor({ status: 200, json: { addresses: null } })).toEqual(none);
  });

  it("Copy link writes the link inside the click, reads Copied for a moment, and selects the link in a field when the clipboard refuses", async () => {
    const tab = openTours(standard());
    await tab.settle();
    const copy = byText(rows(tab)[0], "Copy link");
    copy.click();
    // Written in the click itself, before any answer.
    expect(tab.clipboard.writes).toEqual([`${APP}/t/k3f9abcdef`]);
    await tab.settle();
    expect(copy.textContent).toBe("Copied");
    tab.tick();
    expect(copy.textContent).toBe("Copy link");
    expect(tab.fetched.filter((f) => f.method !== "GET")).toEqual([]);

    for (const answer of ["refuse", "throw", "none"] as const) {
      const refused = openTours(standard(), { clipboard: answer });
      await refused.settle();
      const row = rows(refused)[1];
      byText(row, "Copy link").click();
      await refused.settle();
      const field = row.all().find((e) => e.tagName === "input")!;
      expect([field.value, field.getAttribute("readonly"), field.getAttribute("aria-labelledby"), field.className], answer).toEqual([`${APP}/t/p71cabcdef`, "", "tour-1", "copy"]);
      expect(refused.doc.activeElement, answer).toBe(field);
      expect(byText(row, "Copy link").textContent, answer).toBe("Copy link");
      // Pressed again, the same field is selected again.
      byText(row, "Copy link").click();
      await refused.settle();
      expect(row.all().filter((e) => e.tagName === "input"), answer).toHaveLength(1);
    }
  });

  it("the More menu holds what each tour can do, opens with the keyboard and closes with Escape or a click elsewhere", async () => {
    const tab = openTours(standard());
    await tab.settle();
    const r = rows(tab);
    expect(r.map((row) => menuItems(row).map((m) => m.textContent))).toEqual([["Unpublish", "Delete"], ["Publish changes", "Unpublish", "Delete"], ["Delete"]]);
    const row = r[1];
    const more = byText(row, "More");
    expect([more.getAttribute("aria-haspopup"), more.getAttribute("aria-expanded"), more.getAttribute("aria-controls")]).toEqual(["true", "false", "menu-1"]);
    expect(menuOf(row).id).toBe("menu-1");
    for (const item of menuItems(row)) expect(item.getAttribute("tabindex")).toBe("-1");

    // A click opens it and puts the focus on the first entry; the arrows move, Home and End jump.
    more.click();
    expect(menuOf(row).hidden).toBe(false);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const items = menuItems(row);
    expect(tab.doc.activeElement).toBe(items[0]);
    key(items[0], "ArrowDown");
    expect(tab.doc.activeElement).toBe(items[1]);
    key(items[1], "ArrowUp");
    key(items[0], "ArrowUp");
    expect(tab.doc.activeElement).toBe(items[2]);
    key(items[2], "Home");
    expect(tab.doc.activeElement).toBe(items[0]);
    key(items[0], "End");
    expect(tab.doc.activeElement).toBe(items[2]);
    // Escape closes it and gives the focus back to More.
    key(items[2], "Escape");
    expect(menuOf(row).hidden).toBe(true);
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(tab.doc.activeElement).toBe(more);
    // ArrowDown on More opens it too, ArrowUp at the last entry.
    key(more, "ArrowUp");
    expect(tab.doc.activeElement).toBe(items[2]);
    // Tab leaves it closed.
    key(items[2], "Tab");
    expect(menuOf(row).hidden).toBe(true);
    key(more, "ArrowDown");
    expect(tab.doc.activeElement).toBe(items[0]);
    // A click elsewhere closes it; opening another closes this one.
    tab.$("h-page").click();
    expect(menuOf(row).hidden).toBe(true);
    more.click();
    byText(r[0], "More").click();
    expect(menuOf(row).hidden).toBe(true);
    expect(menuOf(r[0]).hidden).toBe(false);
    // A second click on More closes its menu.
    byText(r[0], "More").click();
    expect(menuOf(r[0]).hidden).toBe(true);
    expect(tab.fetched.filter((f) => f.method !== "GET")).toEqual([]);
  });

  it("Unpublish asks nothing: it calls the route with the anti-forgery header until done, then shows the list again", async () => {
    const after = MOCKUP_TOURS.map((t) => (t.id === T1 ? { ...t, status: "draft", url: null, published_at: null } : t));
    const tab = openTours(
      standard({
        ["POST /api/v1/tours/" + T1 + "/unpublish"]: [{ status: 202, json: { status: "in_progress" } }, { status: 204 }],
        "GET /api/v1/tours": [toursAnswer(MOCKUP_TOURS), toursAnswer(after)],
      }),
    );
    await tab.settle();
    const more = byText(rows(tab)[0], "More");
    more.click();
    menuItems(rows(tab)[0])[0].click();
    expect(tab.$("delete-dialog").hidden).toBe(true);
    expect(more.textContent).toBe("Unpublishing…");
    expect(more.disabled).toBe(true);
    await tab.settle();
    const changes = tab.fetched.filter((f) => f.method !== "GET");
    expect(changes.map((f) => [f.method, f.path, f.headers["X-Csrf-Token"], f.body])).toEqual([
      ["POST", `/api/v1/tours/${T1}/unpublish`, CSRF, undefined],
      ["POST", `/api/v1/tours/${T1}/unpublish`, CSRF, undefined],
    ]);
    // The list is read again (the tours address is not asked twice), and the tour now offers Publish, with the focus on it.
    expect(tab.fetched.filter((f) => f.path === "/api/v1/me")).toHaveLength(1);
    expect(tab.fetched.filter((f) => f.path === "/api/v1/tours")).toHaveLength(2);
    const row = rows(tab)[0];
    expect(controlsOf(row).map((c) => c.textContent)).toEqual(["Publish", "More"]);
    expect(tab.doc.activeElement).toBe(byText(row, "Publish"));
    expect(tab.$("tours-message").textContent).toBe("");
    expect(tab.$("tours-message").hidden).toBe(true);
  });

  it("Publish and Publish changes drive the publish until it is live", async () => {
    const after = MOCKUP_TOURS.map((t) => (t.id === T3 ? { ...t, status: "published", url: "/t/q2zzabcdef" } : t));
    const tab = openTours(
      standard({
        ["POST /api/v1/tours/" + T3 + "/publish"]: [{ status: 202, json: { status: "in_progress", publish_id: "pub_1", done: 0, total: 2 } }, { status: 202, json: { status: "in_progress", publish_id: "pub_1", done: 1, total: 2 } }, { status: 200, json: { slug: "q2zzabcdef", url: "/t/q2zzabcdef", steps: 6 } }],
        ["POST /api/v1/tours/" + T2 + "/publish"]: { status: 200, json: { slug: "p71cabcdef", url: "/t/p71cabcdef", steps: 9 } },
        "GET /api/v1/tours": [toursAnswer(MOCKUP_TOURS), toursAnswer(after), toursAnswer(after)],
      }),
    );
    await tab.settle();
    const publish = byText(rows(tab)[2], "Publish");
    publish.click();
    expect(publish.textContent).toBe("Publishing…");
    expect(publish.getAttribute("aria-busy")).toBe("true");
    await tab.settle();
    const sent = tab.fetched.filter((f) => f.method === "POST");
    expect(sent.map((f) => [f.path, f.headers["X-Csrf-Token"], f.headers["content-type"], f.body])).toEqual([
      [`/api/v1/tours/${T3}/publish`, CSRF, undefined, undefined],
      [`/api/v1/tours/${T3}/publish`, CSRF, "application/json", '{"publish_id":"pub_1"}'],
      [`/api/v1/tours/${T3}/publish`, CSRF, "application/json", '{"publish_id":"pub_1"}'],
    ]);
    expect(controlsOf(rows(tab)[2]).map((c) => c.textContent)).toEqual(["Copy link", "Open", "More"]);
    expect(tab.doc.activeElement).toBe(byText(rows(tab)[2], "Copy link"));

    byText(rows(tab)[1], "More").click();
    menuItems(rows(tab)[1])[0].click();
    await tab.settle();
    expect(tab.fetched.filter((f) => f.method === "POST").at(-1)!.path).toBe(`/api/v1/tours/${T2}/publish`);
  });

  it("a change that fails says why, reads the list again so it shows what is true, and gives every button back", async () => {
    const cases: [Answer, string][] = [
      [{ status: 429, json: { error: "rate_limited" } }, TOO_MANY],
      [{ status: 409, json: { error: "publish_cancelled" } }, FAILED],
      [{ status: 500, json: { error: "internal" } }, FAILED],
      [{ status: 400, json: { error: "empty_tour", detail: "a tour with no steps cannot be published" } }, EMPTY_TOUR],
      [{ status: 400, json: { error: "bad_request" } }, FAILED],
      [{ status: 413, json: { error: "too_large", detail: "a tour of more than 300 steps cannot be published" } }, "A tour of more than 300 steps cannot be published."],
      [{ status: 413, json: { error: "too_large", detail: "<b>the tour is too large to publish.</b>" } }, "<b>the tour is too large to publish.</b>"],
      [{ status: 413, json: { error: "too_large" } }, FAILED],
      [{ status: 413, json: { error: "too_large", detail: "" } }, FAILED],
      ["network", FAILED],
    ];
    for (const [answer, text] of cases) {
      const what = JSON.stringify(answer);
      const tab = openTours(standard({ [`POST /api/v1/tours/${T3}/publish`]: answer }));
      await tab.settle();
      byText(rows(tab)[2], "Publish").click();
      await tab.settle();
      expect(tab.$("tours-message").textContent, what).toBe(text);
      expect(tab.$("tours-message").hidden, what).toBe(false);
      expect(tab.$("tours-message").children.every((c) => !(c instanceof FakeElement)), what).toBe(true);
      // The list was read again after the failure.
      expect(tab.fetched.filter((f) => f.path === "/api/v1/tours"), what).toHaveLength(2);
      const publish = byText(rows(tab)[2], "Publish");
      expect([publish.textContent, publish.disabled, publish.getAttribute("aria-busy")], what).toEqual(["Publish", false, null]);
      for (const b of rowButtons(tab)) expect(b.disabled, `${what} ${b.textContent}`).toBe(false);
      expect(tab.doc.activeElement, what).toBe(publish);
    }
    const out = openTours(standard({ ["POST /api/v1/tours/" + T1 + "/unpublish"]: SIGNED_OUT }));
    await out.settle();
    byText(rows(out)[0], "More").click();
    menuItems(rows(out)[0])[0].click();
    await out.settle();
    expect(out.left()).toBe("/signin");
  });

  it("an unpublish that stops part way or loses the network says so, and the list shows the tour as it now is", async () => {
    const after = MOCKUP_TOURS.map((t) => (t.id === T1 ? { ...t, status: "draft", url: null, published_at: null } : t));
    const cases: [Answer[], string][] = [
      [[{ status: 202, json: { status: "in_progress" } }, { status: 500, json: { error: "internal" } }], FAILED],
      [["network"], FAILED],
      // The tour is unpublished; only some of its public images wait to be removed, which later requests finish.
      [[{ status: 202, json: { status: "in_progress" } }, { status: 500, json: { error: "cleanup_pending" } }], ""],
    ];
    for (const [answer, text] of cases) {
      const what = JSON.stringify(answer);
      const tab = openTours(standard({ [`POST /api/v1/tours/${T1}/unpublish`]: answer, "GET /api/v1/tours": [toursAnswer(MOCKUP_TOURS), toursAnswer(after)] }));
      await tab.settle();
      byText(rows(tab)[0], "More").click();
      menuItems(rows(tab)[0])[0].click();
      await tab.settle();
      expect(tab.$("tours-message").textContent, what).toBe(text);
      expect(tab.$("tours-message").hidden, what).toBe(text === "");
      const row = rows(tab)[0];
      expect(controlsOf(row).map((c) => c.textContent), what).toEqual(["Publish", "More"]);
      for (const b of rowButtons(tab)) expect(b.disabled, `${what} ${b.textContent}`).toBe(false);
      expect(tab.doc.activeElement, what).toBe(byText(row, "Publish"));
    }
  });

  it("a change that worked but whose list cannot be read again keeps the list as last known and says so, without claiming the change failed", async () => {
    for (const reload of [{ status: 500, json: { error: "internal" } }, "network"] as Answer[]) {
      const what = JSON.stringify(reload);
      const tab = openTours(standard({ [`POST /api/v1/tours/${T1}/unpublish`]: { status: 204 }, "GET /api/v1/tours": [toursAnswer(MOCKUP_TOURS), reload] }));
      await tab.settle();
      const more = byText(rows(tab)[0], "More");
      more.click();
      menuItems(rows(tab)[0])[0].click();
      await tab.settle();
      expect(tab.$("tours-message").textContent, what).toBe(NOT_RELOADED);
      expect(tab.$("tours-message").hidden, what).toBe(false);
      expect(rows(tab), what).toHaveLength(3);
      expect([more.textContent, more.disabled, more.getAttribute("aria-busy")], what).toEqual(["More", false, null]);
      for (const b of rowButtons(tab)) expect(b.disabled, `${what} ${b.textContent}`).toBe(false);
      expect(tab.$("dash-load").textContent, what).toBe("");
    }
    // The same after a delete: the question closes, the list stays as it was, with the same sentence.
    const del = openTours(standard({ [`DELETE /api/v1/tours/${T2}`]: { status: 200, json: { deleted: true } }, "GET /api/v1/tours": [toursAnswer(MOCKUP_TOURS), { status: 500, json: { error: "internal" } }] }));
    await del.settle();
    byText(rows(del)[1], "More").click();
    menuItems(rows(del)[1])[2].click();
    del.$("delete-go").click();
    await del.settle();
    expect(del.$("delete-dialog").hidden).toBe(true);
    expect(del.$("tours-message").textContent).toBe(NOT_RELOADED);
    expect(rows(del)).toHaveLength(3);
    for (const b of rowButtons(del)) expect(b.disabled, b.textContent).toBe(false);
  });

  it("while a change runs every row's buttons are disabled, so no other click can start anything", async () => {
    const after = MOCKUP_TOURS.map((t) => (t.id === T1 ? { ...t, status: "draft", url: null, published_at: null } : t));
    const held = holding((req) => req.method === "POST", standard({ "GET /api/v1/tours": [toursAnswer(MOCKUP_TOURS), toursAnswer(after)] }));
    const tab = openTours(held.respond);
    await tab.settle();
    byText(rows(tab)[0], "More").click();
    menuItems(rows(tab)[0])[0].click();
    await tab.settle();
    const buttons = rowButtons(tab).filter((b) => b.getAttribute("role") !== "menuitem");
    expect(buttons.map((b) => [b.textContent, b.disabled])).toEqual([
      ["Copy link", true],
      ["Unpublishing…", true],
      ["Copy link", true],
      ["More", true],
      ["Publish", true],
      ["More", true],
    ]);
    // A click on another row's button does nothing.
    expect(byText(rows(tab)[2], "Publish").click()).toBeNull();
    expect(byText(rows(tab)[1], "More").click()).toBeNull();
    expect(menuOf(rows(tab)[1]).hidden).toBe(true);
    expect(tab.fetched.filter((f) => f.method === "POST")).toHaveLength(1);
    held.answer({ status: 204 });
    await tab.settle();
    for (const b of rowButtons(tab)) expect(b.disabled, b.textContent).toBe(false);
    expect(tab.fetched.filter((f) => f.method === "POST")).toHaveLength(1);
  });

  it("Delete tour pressed twice sends one delete, and the rows cannot be used while it runs", async () => {
    const held = holding((req) => req.method === "DELETE", standard({ "GET /api/v1/tours": [toursAnswer(MOCKUP_TOURS), toursAnswer(MOCKUP_TOURS.slice(1))] }));
    const tab = openTours(held.respond);
    await tab.settle();
    byText(rows(tab)[0], "More").click();
    menuItems(rows(tab)[0])[1].click();
    tab.$("delete-go").click();
    tab.$("delete-go").click();
    tab.$("delete-go").dispatch("click");
    await tab.settle();
    expect(tab.fetched.filter((f) => f.method === "DELETE")).toHaveLength(1);
    for (const b of rowButtons(tab)) expect(b.disabled, b.textContent).toBe(true);
    held.answer({ status: 200, json: { deleted: true } });
    await tab.settle();
    expect(tab.fetched.filter((f) => f.method === "DELETE")).toHaveLength(1);
    expect(rows(tab)).toHaveLength(2);
    for (const b of rowButtons(tab)) expect(b.disabled, b.textContent).toBe(false);
  });

  it("Delete asks first with mockup 2's question; Keep it and Escape close it, the focus stays inside and comes back to More", async () => {
    const tab = openTours(standard());
    await tab.settle();
    const row = rows(tab)[1];
    const more = byText(row, "More");
    more.click();
    menuItems(row)[2].click();
    const dialog = tab.$("delete-dialog");
    expect(dialog.hidden).toBe(false);
    expect(tab.$("delete-title").textContent).toBe('Delete "Loot master setup"?');
    expect(tab.shows().slice(-4)).toEqual([
      'Delete "Loot master setup"?',
      "Its link stops working for everyone and its pictures are removed. This cannot be undone. The recording on your computer is not touched.",
      "Keep it",
      "Delete tour",
    ]);
    expect(tab.doc.activeElement).toBe(tab.$("delete-keep"));
    // Tab and Shift+Tab stay on the two buttons.
    expect(key(tab.$("delete-keep"), "Tab", true).defaultPrevented).toBe(true);
    expect(tab.doc.activeElement).toBe(tab.$("delete-go"));
    expect(key(tab.$("delete-go"), "Tab").defaultPrevented).toBe(true);
    expect(tab.doc.activeElement).toBe(tab.$("delete-keep"));
    expect(key(tab.$("delete-keep"), "Tab").defaultPrevented).toBe(true);
    expect(tab.doc.activeElement).toBe(tab.$("delete-go"));
    // Keep it closes it and gives the focus back to More.
    tab.$("delete-keep").click();
    expect(dialog.hidden).toBe(true);
    expect(tab.doc.activeElement).toBe(more);
    // So does Escape.
    more.click();
    menuItems(row)[2].click();
    expect(dialog.hidden).toBe(false);
    key(tab.$("delete-keep"), "Escape");
    expect(dialog.hidden).toBe(true);
    expect(tab.doc.activeElement).toBe(more);
    expect(tab.fetched.filter((f) => f.method !== "GET")).toEqual([]);
  });

  it("Delete tour deletes with the anti-forgery header until done, closes the question and shows the list again", async () => {
    const after = MOCKUP_TOURS.filter((t) => t.id !== T2);
    const tab = openTours(
      standard({
        ["DELETE /api/v1/tours/" + T2]: [{ status: 202, json: { status: "in_progress", done: 250, total: 300 } }, { status: 200, json: { deleted: true } }],
        "GET /api/v1/tours": [toursAnswer(MOCKUP_TOURS), toursAnswer(after)],
        "GET /api/v1/usage": [usage(USED), usage(USED - 2_726_298)],
      }),
    );
    await tab.settle();
    byText(rows(tab)[1], "More").click();
    menuItems(rows(tab)[1])[2].click();
    const go = tab.$("delete-go");
    go.click();
    expect([go.textContent, go.disabled, tab.$("delete-keep").disabled]).toEqual(["Deleting…", true, true]);
    // Escape does nothing while it runs.
    key(go, "Escape");
    expect(tab.$("delete-dialog").hidden).toBe(false);
    // Tab and Shift+Tab never try the disabled buttons: the focus stays on the question's title.
    expect(key(go, "Tab").defaultPrevented).toBe(true);
    expect(tab.doc.activeElement).toBe(tab.$("delete-title"));
    expect(key(tab.$("delete-title"), "Tab", true).defaultPrevented).toBe(true);
    expect(tab.doc.activeElement).toBe(tab.$("delete-title"));
    await tab.settle();
    expect(tab.fetched.filter((f) => f.method === "DELETE").map((f) => [f.path, f.headers["X-Csrf-Token"], f.body])).toEqual([
      [`/api/v1/tours/${T2}`, CSRF, undefined],
      [`/api/v1/tours/${T2}`, CSRF, undefined],
    ]);
    expect(tab.$("delete-dialog").hidden).toBe(true);
    expect([go.textContent, go.disabled]).toEqual(["Delete tour", false]);
    expect(rows(tab).map((r) => r.all().find((e) => e.className === "t")!.textContent)).toEqual(["Timeline rehearsal walkthrough", "Note send rehearsal"]);
    expect(tab.$("tours-count").textContent + tab.$("tours-used").textContent).toBe("2 tours · 6.1 MB used");
    expect(tab.doc.activeElement).toBe(tab.$("h-page"));
  });

  it("a delete that could not yet remove every file counts as done: the tour is gone", async () => {
    const tab = openTours(standard({ [`DELETE /api/v1/tours/${T1}`]: { status: 500, json: { error: "cleanup_pending" } }, "GET /api/v1/tours": [toursAnswer(MOCKUP_TOURS), toursAnswer(MOCKUP_TOURS.slice(1))] }));
    await tab.settle();
    byText(rows(tab)[0], "More").click();
    menuItems(rows(tab)[0])[1].click();
    tab.$("delete-go").click();
    await tab.settle();
    expect(tab.$("delete-dialog").hidden).toBe(true);
    expect(tab.$("tours-message").hidden).toBe(true);
    expect(rows(tab)).toHaveLength(2);
    expect(tab.doc.activeElement).toBe(tab.$("h-page"));
  });

  it("a delete that fails keeps the question open with the reason and reads the list again; a tour already gone counts as deleted", async () => {
    const cases: [Answer, string][] = [
      [{ status: 500, json: { error: "internal" } }, FAILED],
      [{ status: 409, json: { error: "publish_busy" } }, PUBLISH_BUSY],
      [{ status: 429, json: { error: "rate_limited" } }, TOO_MANY],
      ["network", FAILED],
    ];
    for (const [answer, text] of cases) {
      const what = JSON.stringify(answer);
      const tab = openTours(standard({ [`DELETE /api/v1/tours/${T1}`]: [answer, { status: 404, json: { error: "not_found" } }], "GET /api/v1/tours": [toursAnswer(MOCKUP_TOURS), toursAnswer(MOCKUP_TOURS), toursAnswer(MOCKUP_TOURS.slice(1))] }));
      await tab.settle();
      byText(rows(tab)[0], "More").click();
      menuItems(rows(tab)[0])[1].click();
      tab.$("delete-go").click();
      await tab.settle();
      expect(tab.$("delete-dialog").hidden, what).toBe(false);
      expect(tab.$("delete-message").textContent, what).toBe(text);
      expect(tab.$("delete-message").hidden, what).toBe(false);
      expect(tab.fetched.filter((f) => f.path === "/api/v1/tours"), what).toHaveLength(2);
      expect([tab.$("delete-go").textContent, tab.$("delete-go").disabled, tab.$("delete-keep").disabled], what).toEqual(["Delete tour", false, false]);
      expect(tab.doc.activeElement, what).toBe(tab.$("delete-go"));
      // Pressed again: the tour is gone now, which is what was asked.
      tab.$("delete-go").click();
      await tab.settle();
      expect(tab.$("delete-dialog").hidden, what).toBe(true);
      expect(rows(tab), what).toHaveLength(2);
      expect(tab.$("delete-message").hidden, what).toBe(true);
    }
    // Keep it after a failed delete gives the focus to the row's More as the list now shows it.
    const kept = openTours(standard({ [`DELETE /api/v1/tours/${T1}`]: { status: 500, json: { error: "internal" } } }));
    await kept.settle();
    byText(rows(kept)[0], "More").click();
    menuItems(rows(kept)[0])[1].click();
    kept.$("delete-go").click();
    await kept.settle();
    kept.$("delete-keep").click();
    expect(kept.$("delete-dialog").hidden).toBe(true);
    expect(kept.doc.activeElement).toBe(byText(rows(kept)[0], "More"));
  });

  it("while the question is open the page behind is inert, the backdrop closes it, and Escape and Tab are handled for the whole document", async () => {
    const tab = openTours(standard());
    await tab.settle();
    const behind = ["dash-top", "tours-page"];
    for (const id of behind) expect([tab.$(id).hasAttribute("inert"), tab.$(id).hasAttribute("aria-hidden")], id).toEqual([false, false]);
    const openIt = () => {
      byText(rows(tab)[1], "More").click();
      menuItems(rows(tab)[1])[2].click();
      expect(tab.$("delete-dialog").hidden).toBe(false);
    };
    openIt();
    for (const id of behind) expect([tab.$(id).getAttribute("inert"), tab.$(id).getAttribute("aria-hidden")], id).toEqual(["", "true"]);
    // A click inside the question does not close it; a click on the backdrop does, like Keep it.
    tab.$("delete-text").click();
    expect(tab.$("delete-dialog").hidden).toBe(false);
    tab.$("delete-dialog").click();
    expect(tab.$("delete-dialog").hidden).toBe(true);
    expect(tab.doc.activeElement).toBe(byText(rows(tab)[1], "More"));
    for (const id of behind) expect([tab.$(id).hasAttribute("inert"), tab.$(id).hasAttribute("aria-hidden")], id).toEqual([false, false]);
    // Escape pressed anywhere in the document closes it.
    openIt();
    key(tab.doc.body, "Escape");
    expect(tab.$("delete-dialog").hidden).toBe(true);
    expect(tab.doc.activeElement).toBe(byText(rows(tab)[1], "More"));
    // Tab from outside the question brings the focus into it, and wraps inside it both ways.
    openIt();
    tab.$("h-page").focus();
    expect(key(tab.doc.body, "Tab").defaultPrevented).toBe(true);
    expect(tab.doc.activeElement).toBe(tab.$("delete-keep"));
    key(tab.doc.body, "Tab");
    expect(tab.doc.activeElement).toBe(tab.$("delete-go"));
    key(tab.doc.body, "Tab");
    expect(tab.doc.activeElement).toBe(tab.$("delete-keep"));
    key(tab.doc.body, "Tab", true);
    expect(tab.doc.activeElement).toBe(tab.$("delete-go"));
    tab.$("h-page").focus();
    key(tab.doc.body, "Tab", true);
    expect(tab.doc.activeElement).toBe(tab.$("delete-go"));
    // Once it is closed, Tab and Escape are the page's own again.
    tab.$("delete-keep").click();
    expect(key(tab.doc.body, "Tab").defaultPrevented).toBe(false);
    expect(tab.fetched.filter((f) => f.method !== "GET")).toEqual([]);
  });

  it("says when the list cannot be read, with the approved sentences", async () => {
    for (const [table, text] of [
      [{ "GET /api/v1/tours": { status: 500, json: { error: "internal" } } }, FAILED],
      [{ "GET /api/v1/usage": { status: 429, json: { error: "rate_limited" } } }, TOO_MANY],
      [{ "GET /api/v1/me": { status: 500, json: { error: "internal" } } }, FAILED],
      [{ "GET /api/v1/tours": "network" }, FAILED],
      [{ "GET /api/v1/tours": { status: 200, json: { tours: "x" } } }, FAILED],
    ] as const) {
      const tab = openTours(standard(table as Record<string, Answer>));
      await tab.settle();
      expect(tab.$("dash-load").textContent, JSON.stringify(table)).toBe(text);
      expect(tab.$("tours").hidden).toBe(true);
    }
    const out = openTours(standard({ "GET /api/v1/usage": SIGNED_OUT }));
    await out.settle();
    expect(out.left()).toBe("/signin");
  });
});

// ---- Against the real app ----

/** A tab whose fetch goes to the real app on the app address, as a browser sends it there, with a session cookie. */
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

describe("the Tours page against the real app", () => {
  it("lists a published tour with its link on the tours address, unpublishes, publishes and deletes it through the API", async () => {
    const { deps } = await makeDeps({ hosts: { tours: "tours.example.com", app: "app.example.com" }, retiredGraceMs: 0 });
    await seedAccount(deps, { admin: true, username: "realcheck-admin" });
    const owner = await seedAccount(deps, { username: "realcheck" });
    const made = await redeemSignInCode(deps, await createSignInCode(deps, owner.userId), FIREFOX, null);
    const cookie = `${SESSION_COOKIE}=${made!.secret}`;

    // An empty workspace first.
    const empty = openTours(browser(deps, cookie));
    await empty.settle();
    expect(empty.$("dash-user").textContent).toBe("realcheck");
    expect(empty.$("tours-empty").shown).toBe(true);
    expect(empty.$("tours-count").textContent + empty.$("tours-in").textContent + empty.$("tours-used").textContent).toBe("0 tours in Account · 0 bytes used");

    // A tour uploaded and published by the recorder's token.
    const uploaded = await uploadTour(deps, owner.token, fixtures.v3 as Json);
    let r = await send(deps, "POST", `/api/v1/tours/${uploaded.tour_id}/publish`, { token: owner.token });
    while (r.status === 202) r = await send(deps, "POST", `/api/v1/tours/${uploaded.tour_id}/publish`, { token: owner.token, body: JSON.stringify({ publish_id: r.json.publish_id }), headers: { "content-type": "application/json" } });
    expect(r.status).toBe(200);
    const slug = r.json.slug as string;

    const tab = openTours(browser(deps, cookie));
    await tab.settle();
    const row = rows(tab)[0];
    expect(byText(row, "Open").getAttribute("href")).toBe(`https://tours.example.com/t/${slug}`);
    expect(row.all().find((e) => e.className === "tag ok")!.textContent).toBe("Published");

    // Unpublish, through the real API with the real anti-forgery check.
    byText(row, "More").click();
    menuItems(row)[0].click();
    await tab.settle();
    expect(tab.$("tours-message").textContent).toBe("");
    expect(controlsOf(rows(tab)[0]).map((c) => c.textContent)).toEqual(["Publish", "More"]);
    expect((await send(deps, "GET", `/t/${slug}`, { origin: "https://tours.example.com" })).status).toBe(404);

    // Publish again: the same link comes back.
    byText(rows(tab)[0], "Publish").click();
    await tab.settle();
    expect(tab.$("tours-message").textContent).toBe("");
    expect(byText(rows(tab)[0], "Open").getAttribute("href")).toBe(`https://tours.example.com/t/${slug}`);

    // Delete, after the question.
    byText(rows(tab)[0], "More").click();
    menuItems(rows(tab)[0]).find((m) => m.textContent === "Delete")!.click();
    tab.$("delete-go").click();
    await tab.settle();
    expect(tab.$("delete-dialog").hidden).toBe(true);
    expect(tab.$("tours-empty").shown).toBe(true);
    expect((await send(deps, "GET", "/api/v1/tours", { token: owner.token })).json.tours).toEqual([]);
  });

  it("a page whose anti-forgery value is wrong changes nothing", async () => {
    const { deps } = await makeDeps();
    await seedAccount(deps, { admin: true, username: "csrfcheck-admin" });
    const owner = await seedAccount(deps, { username: "csrfcheck" });
    const made = await redeemSignInCode(deps, await createSignInCode(deps, owner.userId), FIREFOX, null);
    const real = browser(deps, `${SESSION_COOKIE}=${made!.secret}`);
    await uploadTour(deps, owner.token, fixtures.v3 as Json);
    // The session answer is the real one, with another anti-forgery value in it.
    const tab = openTours(async (req) => {
      const a = await real(req);
      if (req.path === "/api/v1/session" && a !== "network") (a.json as Json).csrf = "0".repeat(64);
      return a;
    });
    await tab.settle();
    byText(rows(tab)[0], "More").click();
    menuItems(rows(tab)[0])[0].click();
    tab.$("delete-go").click();
    await tab.settle();
    expect(tab.$("delete-message").textContent).toBe(FAILED);
    expect((await send(deps, "GET", "/api/v1/tours", { token: owner.token })).json.tours).toHaveLength(1);
  });
});
