// Test only, Node only (left out of the Workers typecheck in tsconfig.cloudflare.json, as
// test/harness.node.ts is): the harness that runs the Tours page's scripts under Node, shared by
// test/node-dash-pages.test.ts (the list and its changes) and test/node-dash-tours-sharing.test.ts
// (who can view a tour), and through openDash by test/node-dash-media-sharing.test.ts (who can
// view an image or a clip). The page's document, the shared /dash/dash.js and the page's
// /dash/tours.js are run in one fresh Node `vm` context against a stand-in document built from
// the page's own HTML (test/pages-dom.ts), with a stand-in address, clipboard, timer, window
// listener and fetch. The fetch either answers from the test or is handed to the real app, as a
// browser on the app address would send it. The timer only records what the script asked for;
// `tick` runs it.
import vm from "node:vm";
import { expect } from "vitest";
import { createApp } from "../src/app.ts";
import { DASH_JS } from "../src/dash/script.ts";
import { TOURS_HTML, TOURS_JS } from "../src/dash/tours.ts";
import type { Deps } from "../src/ports.ts";
import { FakeDocument, FakeElement, visibleText } from "./pages-dom.ts";

export const APP = "https://app.example.com";
export const CSRF = "c".repeat(64);
export const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";
/** "Now" for the page: 19 November 2026, noon UTC. */
export const NOW = Date.UTC(2026, 10, 19, 12);
export const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 12);
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A date as the page writes it, in this process's time zone, with the page's "now" in 2026. */
export const shown = (ms: number) => {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === 2026 ? "" : " " + d.getFullYear()}`;
};

export const FAILED = "Something went wrong. Try again in a moment.";
export const TOO_MANY = "Too many requests. Wait a few minutes and try again.";
// Proposed for the owner's approval (review follow-ups L4 and M1).
export const EMPTY_TOUR = "This tour has no steps, so it cannot be published.";
export const PUBLISH_BUSY = "This tour is being published. Try again when that is done.";
export const NOT_RELOADED = "The change was made, but the list could not be loaded again. Reload the page to see it.";

export type Answer = { status: number; json?: unknown } | "network";
export type Fetched = { method: string; path: string; headers: Record<string, string>; body: string | undefined; init: Record<string, unknown> };
export type Responder = (req: Fetched) => Answer | Promise<Answer>;
export type Clipboard = { writes: string[]; answer: "ok" | "refuse" | "throw" | "none" };

export type Tab = {
  doc: FakeDocument;
  fetched: Fetched[];
  left: () => string | null;
  $: (id: string) => FakeElement;
  shows: () => string[];
  settle: () => Promise<void>;
  /** Runs every timer the script set, as if their time had passed, and returns their delays. */
  tick: () => number[];
  /** How many timers are set and not run yet. */
  timers: () => number;
  /** The browser leaves the page (the window's pagehide event). */
  pagehide: () => void;
  clipboard: Clipboard;
  violations: string[];
};

const open: Tab[] = [];
/** For each test file's afterEach: no tab used anything it must not. */
export function checkTabs(): void {
  for (const tab of open.splice(0)) expect(tab.violations, "the script used something it must not").toEqual([]);
}

/** Opens the Tours page at `origin` and runs its two scripts in order, as a browser does with two deferred scripts. */
export function openTours(respond: Responder, opts: { origin?: string; clipboard?: Clipboard["answer"] } = {}): Tab {
  return openDash({ html: TOURS_HTML, js: TOURS_JS, file: "tours.js" }, respond, opts);
}

/**
 * Opens a dashboard page (its document, and its script after /dash/dash.js) at `origin`, as
 * openTours does the Tours page; `forbid` names more globals the script must not touch (the
 * Images and GIFs pages' tests add URL and Image).
 */
export function openDash(page: { html: string; js: string; file: string }, respond: Responder, opts: { origin?: string; clipboard?: Clipboard["answer"]; forbid?: string[] } = {}): Tab {
  const doc = new FakeDocument(page.html);
  const origin = opts.origin ?? APP;
  let left: string | null = null;
  const fetched: Fetched[] = [];
  const pending: Promise<unknown>[] = [];
  /** Requests not answered yet. */
  let unanswered = 0;
  const violations: string[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const onWindow: Record<string, (() => void)[]> = {};
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
    unanswered++;
    pending.push(p.catch(() => {}).finally(() => unanswered--));
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
    timers.push({ fn, ms: typeof ms === "number" ? ms : 0 });
    return timers.length;
  };
  const addEventListener = (type: string, fn: () => void) => (onWindow[type] ??= []).push(fn);

  const context: Record<string, unknown> = { document: doc, location, fetch, navigator, setTimeout, addEventListener };
  for (const name of ["localStorage", "sessionStorage", "indexedDB", "caches", "cookieStore", "XMLHttpRequest", "WebSocket", "EventSource", "window", "self", "top", "parent", "opener", "open", "postMessage", "setInterval", "console", "alert", "confirm", "prompt", "history", ...(opts.forbid ?? [])]) {
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
  vm.runInContext(page.js, ctx, { filename: page.file });

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
      // A request against the real app can take longer than these thirty short turns on a
      // busy machine, and returning with one still open ends a test's wait too early. So an
      // open request is waited for, up to ten seconds; one a test never answers ends at that.
      const until = Date.now() + 10_000;
      for (let i = 0; i < 30 || (unanswered > 0 && Date.now() < until); i++) {
        await Promise.race([Promise.all(pending), new Promise((r) => globalThis.setTimeout(r, 1))]);
        await new Promise((r) => setImmediate(r));
      }
    },
    tick: () =>
      timers.splice(0).map((t) => {
        t.fn();
        return t.ms;
      }),
    timers: () => timers.length,
    pagehide: () => {
      for (const fn of onWindow.pagehide ?? []) fn();
    },
    clipboard,
    violations,
  };
  open.push(tab);
  return tab;
}

/** A responder from a table of "<METHOD> <path>" to answers (a list is answered in order, its last one repeated); anything else fails the test. */
export function answers(table: Record<string, Answer | Answer[]>): Responder {
  const queues = new Map(Object.entries(table).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  return (req) => {
    const q = queues.get(`${req.method} ${req.path}`);
    if (!q || q.length === 0) throw new Error(`unexpected request ${req.method} ${req.path}`);
    return q.length > 1 ? q.shift()! : q[0];
  };
}

export const SIGNED_OUT: Answer = { status: 401, json: { error: "unauthorized" } };
export const session = (account: Record<string, unknown> = {}, workspace = "Cowfee Raid Tools"): Answer => ({
  status: 200,
  json: { account: { id: "usr_1", username: "morgan", email: "morgan@example.com", admin: false, ...account }, workspace: { id: "ws_1", name: workspace }, session: { id: "ses_1", created_at: NOW, expires_at: NOW }, csrf: CSRF },
});
export const ME_ONE: Answer = { status: 200, json: { workspace: "Cowfee Raid Tools", version: "0.1.12" } };
export const meTwo = (tours: string): Answer => ({ status: 200, json: { workspace: "Cowfee Raid Tools", version: "0.1.12", addresses: { tours, app: "app.example.com" } } });
export const usage = (used: number): Answer => ({ status: 200, json: { used_bytes: used, allowance_bytes: null, over: false, tours: 3, counted: { pictures: used, logos: 0, uploads_in_progress: 0 } } });

export const T1 = "tour_" + "1".repeat(24);
export const T2 = "tour_" + "2".repeat(24);
export const T3 = "tour_" + "3".repeat(24);
export const tour = (id: string, over: Record<string, unknown>) => ({
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
  access: "public",
  viewers: 0,
  ...over,
});
/** The three tours of mockup 1 (the Tours set's): a public tour, one shared with 4 people that has changes waiting, and a draft set to "Only me", which shows a dash. */
export const MOCKUP_TOURS = [
  tour(T1, { title: "Timeline rehearsal walkthrough", slug: "k3f9abcdef", url: "/t/k3f9abcdef", steps: 14, bytes: 6_396_313, updated_at: day(2026, 11, 19) }),
  tour(T2, { title: "Loot master setup", slug: "p71cabcdef", url: "/t/p71cabcdef", steps: 9, bytes: 2_726_298, updated_at: day(2026, 11, 18), unpublished_changes: true, access: "people", viewers: 4 }),
  tour(T3, { title: "Note send rehearsal", status: "draft", slug: "q2zzabcdef", url: null, steps: 6, bytes: 1_992_294, updated_at: day(2026, 11, 17), published_at: null, access: "me" }),
];
export const toursAnswer = (tours: unknown[]): Answer => ({ status: 200, json: { tours } });
export const USED = 9_122_611; // 8.7 MB

/** The standard page: signed in, the mockup's tours, one-address mode. */
export function standard(extra: Record<string, Answer | Answer[]> = {}): Responder {
  return answers({ "GET /api/v1/session": session(), "GET /api/v1/me": ME_ONE, "GET /api/v1/tours": toursAnswer(MOCKUP_TOURS), "GET /api/v1/usage": usage(USED), ...extra });
}

/** The rows of the list. */
export const rows = (tab: Tab) => tab.$("tours-rows").children.filter((c): c is FakeElement => c instanceof FakeElement);
/** The controls a person can use in a row, by their words: buttons and links shown. */
export const controlsOf = (row: FakeElement) => row.all().filter((e) => (e.tagName === "button" || e.tagName === "a") && e.shown && e.getAttribute("role") !== "menuitem");
export const byText = (row: FakeElement, text: string) => {
  const found = row.all().find((e) => (e.tagName === "button" || e.tagName === "a") && e.textContent === text);
  if (!found) throw new Error(`no "${text}" in the row`);
  return found;
};
export const menuOf = (row: FakeElement) => row.all().find((e) => e.getAttribute("role") === "menu")!;
export const menuItems = (row: FakeElement) => menuOf(row).all().filter((e) => e.getAttribute("role") === "menuitem");
export const key = (el: FakeElement, k: string, shiftKey = false) => el.dispatch("keydown", { key: k, shiftKey });
/** Every button of every row, menus included. */
export const rowButtons = (tab: Tab) => rows(tab).flatMap((row) => row.all().filter((e) => e.tagName === "button"));

/** A responder whose answers to requests matching `held` wait until the test hands them over; the rest go to `rest`. */
export function holding(held: (req: Fetched) => boolean, rest: Responder): { respond: Responder; answer: (a: Answer) => void } {
  const waiting: ((a: Answer) => void)[] = [];
  return {
    respond: (req) => (held(req) ? new Promise<Answer>((r) => waiting.push(r)) : rest(req)),
    answer: (a) => {
      for (const r of waiting.splice(0)) r(a);
    },
  };
}

/** A tab whose fetch goes to the real app on the app address, as a browser sends it there, with a session cookie. */
export function browser(deps: Deps, cookie: string) {
  const app = createApp(deps);
  return async (req: Fetched): Promise<Answer> => {
    const headers: Record<string, string> = { ...req.headers, "user-agent": FIREFOX, cookie };
    if (req.method !== "GET" && req.method !== "HEAD") Object.assign(headers, { origin: APP, "sec-fetch-site": "same-origin" });
    const res = await app.fetch(new Request(APP + req.path, { method: req.method, headers, body: req.body }));
    const text = await res.text();
    return { status: res.status, json: text === "" ? undefined : JSON.parse(text) };
  };
}
