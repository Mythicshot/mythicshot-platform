// Test only, Node only (left out of the Workers typecheck in tsconfig.cloudflare.json, as
// test/harness.node.ts is): the harness that runs the Admin page's scripts under Node, shared by
// test/node-dash-admin.test.ts (the list and the allowance) and
// test/node-dash-admin-actions.test.ts (invites, disabling, enabling and deleting). The page's
// document, the shared /dash/dash.js and the page's /dash/admin.js are run in one fresh Node
// `vm` context against a stand-in document built from the page's own HTML
// (test/pages-dom.ts), with a stand-in address, fetch and timer. The fetch either answers
// from the test or is handed to the real app, as a browser on the app address would send it.
// The timer only records what the script asked for; `tick` runs what is due.
import vm from "node:vm";
import { expect } from "vitest";
import { createApp } from "../src/app.ts";
import { ADMIN_HTML, ADMIN_JS } from "../src/dash/admin.ts";
import { DASH_JS } from "../src/dash/script.ts";
import type { Deps } from "../src/ports.ts";
import { SESSION_COOKIE, createSignInCode, redeemSignInCode } from "../src/sessions.ts";
import { FakeDocument, FakeElement, visibleText } from "./pages-dom.ts";

export const APP = "https://app.example.com";
export const CSRF = "c".repeat(64);
export const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";
export const FAILED = "Something went wrong. Try again in a moment.";
export const TOO_MANY = "Too many requests. Wait a few minutes and try again.";
export const GB = 1024 ** 3;
export const MB = 1024 ** 2;

export type Answer = { status: number; json?: unknown; headers?: Record<string, string> } | "network";
export type Fetched = { method: string; path: string; headers: Record<string, string>; body: string | undefined; init: Record<string, unknown> };
export type Responder = (req: Fetched) => Answer | Promise<Answer>;

export type Tab = {
  doc: FakeDocument;
  fetched: Fetched[];
  left: () => string | null;
  $: (id: string) => FakeElement;
  has: (id: string) => boolean;
  shows: () => string[];
  settle: () => Promise<void>;
  /** Runs every timer set so far, and returns their delays. */
  tick: () => number[];
  pendingDelays: () => number[];
  violations: string[];
};

const opened: Tab[] = [];

/** For each test file's afterEach: no tab used anything it must not. */
export function checkTabs(): void {
  for (const tab of opened.splice(0)) expect(tab.violations, "the script used something it must not").toEqual([]);
}

/** Opens the Admin page and runs its two scripts in order, as a browser does with two deferred scripts. */
export function openAdmin(respond: Responder): Tab {
  const doc = new FakeDocument(ADMIN_HTML);
  let left: string | null = null;
  const fetched: Fetched[] = [];
  const pending: Promise<unknown>[] = [];
  const violations: string[] = [];
  let timers: { fn: () => void; ms: number }[] = [];
  const location = {
    get origin() {
      return APP;
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
      return new Response(a.status === 204 ? null : body, { status: a.status, headers: { "content-type": "application/json", ...a.headers } });
    });
    pending.push(p.catch(() => {}));
    return p;
  };
  const setTimeout = (fn: () => void, ms?: number) => {
    timers.push({ fn, ms: Number(ms) });
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
  vm.runInContext(ADMIN_JS, ctx, { filename: "admin.js" });
  const find = (id: string) => doc.root.all().find((e) => e.id === id);
  const tab: Tab = {
    doc,
    fetched,
    left: () => left,
    $: (id) => {
      const el = find(id);
      if (!el) throw new Error(`no #${id}`);
      return el;
    },
    has: (id) => find(id) !== undefined,
    shows: () => visibleText(doc),
    async settle() {
      for (let i = 0; i < 30; i++) {
        await Promise.race([Promise.all(pending), new Promise((r) => globalThis.setTimeout(r, 1))]);
        await new Promise((r) => setImmediate(r));
      }
    },
    tick: () => {
      const now = timers;
      timers = [];
      for (const t of now) t.fn();
      return now.map((t) => t.ms);
    },
    pendingDelays: () => timers.map((t) => t.ms),
    violations,
  };
  opened.push(tab);
  return tab;
}

/** Settles, runs the timers that are due, and again, until nothing is waiting (at most `rounds` times); the delays that ran. */
export async function drain(tab: Tab, rounds = 50): Promise<number[]> {
  const ran: number[] = [];
  for (let i = 0; i < rounds; i++) {
    await tab.settle();
    if (tab.pendingDelays().length === 0) break;
    ran.push(...tab.tick());
  }
  await tab.settle();
  return ran;
}

/** A responder from a table of "<METHOD> <path>" to answers (a list is answered in order, its last one repeated; a function answers each request); anything else fails the test. */
export function answers(table: Record<string, Answer | Answer[] | ((req: Fetched) => Answer | Promise<Answer>)>): Responder {
  const queues = new Map(Object.entries(table).map(([k, v]) => [k, typeof v === "function" ? v : Array.isArray(v) ? [...v] : [v]]));
  return (req) => {
    const q = queues.get(`${req.method} ${req.path}`);
    if (typeof q === "function") return q(req);
    if (!q || q.length === 0) throw new Error(`unexpected request ${req.method} ${req.path}`);
    return q.length > 1 ? q.shift()! : q[0];
  };
}

export const U1 = "usr_" + "1".repeat(24);
export const U2 = "usr_" + "2".repeat(24);
export const U3 = "usr_" + "3".repeat(24);
export const W1 = "ws_" + "1".repeat(24);
export const W2 = "ws_" + "2".repeat(24);
export const W3 = "ws_" + "3".repeat(24);
export const STANDARD = 5 * GB;

export const SIGNED_OUT: Answer = { status: 401, json: { error: "unauthorized" } };
export const NOT_FOUND: Answer = { status: 404, json: { error: "not_found" } };
/** The session answer: by default the admin `solex`, whose account is U1. */
export const session = (admin: unknown, username = "solex", id: unknown = U1): Answer => ({
  status: 200,
  json: { account: { id, username, email: "solex@example.com", admin }, workspace: { id: "ws_1", name: "Cowfee Raid Tools" }, session: { id: "ses_1", created_at: 1, expires_at: 2 }, csrf: CSRF },
});
export const summary = (accounts: number, used: number, standard: number | null): Answer => ({ status: 200, json: { accounts, used_bytes: used, standard_allowance_bytes: standard } });

/** One account as GET /api/v1/admin/accounts gives it. */
export function account(id: string, ws: string, over: Record<string, unknown>) {
  const own = (over.storage_allowance_bytes ?? null) as number | null;
  const standard = "standard" in over ? (over.standard as number | null) : STANDARD;
  const allowance = own ?? standard;
  const used = (over.used_bytes ?? 0) as number;
  const out: Record<string, unknown> = {
    id,
    username: "someone",
    email: "someone@example.com",
    status: "active",
    admin: false,
    created_at: 1,
    deleting: false,
    workspace_id: ws,
    workspace_name: "A workspace",
    tours: 0,
    used_bytes: used,
    allowance_bytes: allowance,
    storage_allowance_bytes: own,
    over: allowance !== null && used > allowance,
    counted: { pictures: used, logos: 0, uploads_in_progress: 0 },
    ...over,
  };
  delete out.standard;
  return out;
}

/** The three accounts of mockup 9. */
export const MOCKUP = [
  account(U1, W1, { username: "solex", email: "you@example.com", admin: true, workspace_name: "Cowfee Raid Tools", tours: 12, used_bytes: 1_288_490_189 }),
  account(U2, W2, { username: "mara", email: "mara@example.com", workspace_name: "Harbor Studio", tours: 31, used_bytes: 5_690_831_667 }),
  account(U3, W3, { username: "bram", email: "bram@example.com", workspace_name: "Bram's demos", tours: 2, used_bytes: 96 * MB, storage_allowance_bytes: 20 * GB }),
];
export const MOCKUP_USED = 1_288_490_189 + 5_690_831_667 + 96 * MB;
export const list = (accounts: unknown[], next: string | null = null): Answer => ({ status: 200, json: { accounts, next } });
export const inviteList = (invites: unknown[]): Answer => ({ status: 200, json: { invites } });

/** The standard page: the admin signed in, mockup 9's accounts, no invites. */
export function standard(extra: Record<string, Answer | Answer[] | ((req: Fetched) => Answer | Promise<Answer>)> = {}): Responder {
  return answers({ "GET /api/v1/session": session(true), "GET /api/v1/admin/summary": summary(3, MOCKUP_USED, STANDARD), "GET /api/v1/admin/accounts": list(MOCKUP), "GET /api/v1/admin/invites": inviteList([]), ...extra });
}

export const rows = (tab: Tab) => tab.$("admin-rows").children.filter((c): c is FakeElement => c instanceof FakeElement);
export const cells = (row: FakeElement) => row.children.filter((c): c is FakeElement => c instanceof FakeElement);
/** A row's More button. */
export const more = (row: FakeElement) => row.all().find((e) => e.tagName === "button" && e.getAttribute("aria-haspopup") === "true")!;
/** A row's menu entries, by their text. */
export const entries = (row: FakeElement) => row.all().filter((e) => e.getAttribute("role") === "menuitem").map((e) => e.textContent);
/** Opens a row's More menu and presses the entry with this text. */
export function choose(row: FakeElement, text: string): void {
  more(row).click();
  const entry = row.all().find((e) => e.getAttribute("role") === "menuitem" && e.textContent === text);
  if (!entry) throw new Error(`no entry ${text}`);
  entry.click();
}
/** Opens the question that sets the row's allowance, as the menu's "Set allowance" does. */
export const allowFor = (row: FakeElement) => choose(row, "Set allowance");
export const key = (el: FakeElement, k: string, shiftKey = false, repeat = false) => el.dispatch("keydown", { key: k, shiftKey, repeat });
/** Types into the field as a person does: the value, then the input event. */
export const type = (tab: Tab, text: string, id = "allow-input") => {
  const input = tab.$(id);
  input.value = text;
  input.dispatch("input");
};
export const of = (tab: Tab, method: string, path: string) => tab.fetched.filter((f) => f.method === method && f.path === path);

/** What one row shows, cell by cell. */
export function rowOf(row: FakeElement) {
  const [who, ws, tours, bar, used, allowance] = cells(row);
  const mini = bar.all().find((e) => e.className.startsWith("mini"));
  return {
    name: who.all().find((e) => e.className === "name")!.textContent,
    tags: who.all().filter((e) => e.className.startsWith("tag")).map((e) => e.textContent),
    email: who.all().find((e) => e.className === "d name")?.textContent ?? null,
    workspace: ws.textContent,
    tours: tours.textContent,
    bar: mini === undefined ? null : { cls: mini.className, width: mini.children.filter((c): c is FakeElement => c instanceof FakeElement)[0].style.width },
    used: used.textContent,
    over: used.all().filter((e) => e.className === "tag warn").map((e) => e.textContent),
    allowance: allowance.textContent,
    button: more(row).textContent,
    menu: entries(row),
  };
}

/** A tab's fetch that goes to the real app on the app address, as a browser sends it there, with a session cookie. */
export function browser(deps: Deps, cookie: string) {
  const app = createApp(deps);
  const seenAnswers: string[] = [];
  const respond = async (req: Fetched): Promise<Answer> => {
    const headers: Record<string, string> = { ...req.headers, "user-agent": FIREFOX, cookie };
    if (req.method !== "GET" && req.method !== "HEAD") Object.assign(headers, { origin: APP, "sec-fetch-site": "same-origin" });
    const res = await app.fetch(new Request(APP + req.path, { method: req.method, headers, body: req.body }));
    const text = await res.text();
    seenAnswers.push(text);
    const out: Record<string, string> = {};
    const after = res.headers.get("retry-after");
    if (after !== null) out["retry-after"] = after;
    return { status: res.status, json: text === "" ? undefined : JSON.parse(text), headers: out };
  };
  return { respond, seenAnswers };
}

export async function sessionOf(deps: Deps, userId: string): Promise<string> {
  const made = await redeemSignInCode(deps, await createSignInCode(deps, userId), FIREFOX, null);
  return `${SESSION_COOKIE}=${made!.secret}`;
}
