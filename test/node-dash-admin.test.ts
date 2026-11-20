// What the Admin page's script does when it runs: the page's document, the shared
// /dash/dash.js and the page's /dash/admin.js are run in one fresh Node `vm` context
// against a stand-in document built from the page's own HTML (test/pages-dom.ts), with a
// stand-in address and fetch. The fetch either answers from the test or is handed to the
// real app, as a browser on the app address would send it. Node only: the Workers runtime
// runs no code from a string. The size parser (SIZE_JS) is also run on its own, on its
// table of inputs.
//
// What this leaves unproven, for docs/dashboard-browser-check.md: real layout at phone
// width, focus rings, `inert` as a browser applies it, and a screen reader.
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { createApp } from "../src/app.ts";
import { ADMIN_HTML, ADMIN_JS, SIZE_JS } from "../src/dash/admin.ts";
import { DASH_JS } from "../src/dash/script.ts";
import type { Deps } from "../src/ports.ts";
import { SESSION_COOKIE, createSignInCode, redeemSignInCode } from "../src/sessions.ts";
import { send } from "./bundle.ts";
import { FakeDocument, FakeElement, visibleText } from "./pages-dom.ts";
import { SIZE_TABLE } from "./sizes.ts";

const APP = "https://app.example.com";
const CSRF = "c".repeat(64);
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";
const FAILED = "Something went wrong. Try again in a moment.";
const TOO_MANY = "Too many requests. Wait a few minutes and try again.";
const GB = 1024 ** 3;
const MB = 1024 ** 2;

type Answer = { status: number; json?: unknown } | "network";
type Fetched = { method: string; path: string; headers: Record<string, string>; body: string | undefined; init: Record<string, unknown> };
type Responder = (req: Fetched) => Answer | Promise<Answer>;

type Tab = {
  doc: FakeDocument;
  fetched: Fetched[];
  left: () => string | null;
  $: (id: string) => FakeElement;
  has: (id: string) => boolean;
  shows: () => string[];
  settle: () => Promise<void>;
  violations: string[];
};

const open: Tab[] = [];
afterEach(() => {
  for (const tab of open.splice(0)) expect(tab.violations, "the script used something it must not").toEqual([]);
});

/** Opens the Admin page and runs its two scripts in order, as a browser does with two deferred scripts. */
function openAdmin(respond: Responder): Tab {
  const doc = new FakeDocument(ADMIN_HTML);
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
  const context: Record<string, unknown> = { document: doc, location, fetch };
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
const NOT_FOUND: Answer = { status: 404, json: { error: "not_found" } };
const session = (admin: unknown, username = "solex"): Answer => ({
  status: 200,
  json: { account: { id: "usr_1", username, email: "solex@example.com", admin }, workspace: { id: "ws_1", name: "Cowfee Raid Tools" }, session: { id: "ses_1", created_at: 1, expires_at: 2 }, csrf: CSRF },
});
const summary = (accounts: number, used: number, standard: number | null): Answer => ({ status: 200, json: { accounts, used_bytes: used, standard_allowance_bytes: standard } });

const U1 = "usr_" + "1".repeat(24);
const U2 = "usr_" + "2".repeat(24);
const U3 = "usr_" + "3".repeat(24);
const W1 = "ws_" + "1".repeat(24);
const W2 = "ws_" + "2".repeat(24);
const W3 = "ws_" + "3".repeat(24);
const STANDARD = 5 * GB;

/** One account as GET /api/v1/admin/accounts gives it. */
function account(id: string, ws: string, over: Record<string, unknown>) {
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
const MOCKUP = [
  account(U1, W1, { username: "solex", email: "you@example.com", admin: true, workspace_name: "Cowfee Raid Tools", tours: 12, used_bytes: 1_288_490_189 }),
  account(U2, W2, { username: "mara", email: "mara@example.com", workspace_name: "Harbor Studio", tours: 31, used_bytes: 5_690_831_667 }),
  account(U3, W3, { username: "bram", email: "bram@example.com", workspace_name: "Bram's demos", tours: 2, used_bytes: 96 * MB, storage_allowance_bytes: 20 * GB }),
];
const MOCKUP_USED = 1_288_490_189 + 5_690_831_667 + 96 * MB;
const list = (accounts: unknown[], next: string | null = null): Answer => ({ status: 200, json: { accounts, next } });

/** The standard page: the admin signed in, mockup 9's accounts. */
function standard(extra: Record<string, Answer | Answer[]> = {}): Responder {
  return answers({ "GET /api/v1/session": session(true), "GET /api/v1/admin/summary": summary(3, MOCKUP_USED, STANDARD), "GET /api/v1/admin/accounts": list(MOCKUP), ...extra });
}

const rows = (tab: Tab) => tab.$("admin-rows").children.filter((c): c is FakeElement => c instanceof FakeElement);
const cells = (row: FakeElement) => row.children.filter((c): c is FakeElement => c instanceof FakeElement);
const setButton = (row: FakeElement) => row.all().find((e) => e.tagName === "button")!;
const key = (el: FakeElement, k: string, shiftKey = false) => el.dispatch("keydown", { key: k, shiftKey });
/** Types into the field as a person does: the value, then the input event. */
const type = (tab: Tab, text: string) => {
  const input = tab.$("allow-input");
  input.value = text;
  input.dispatch("input");
};

/** What one row shows, cell by cell. */
function rowOf(row: FakeElement) {
  const [who, ws, tours, bar, used, allowance, acts] = cells(row);
  const mini = bar.all().find((e) => e.className.startsWith("mini"));
  return {
    name: who.all().find((e) => e.className === "name")!.textContent,
    tags: who.all().filter((e) => e.className === "tag").map((e) => e.textContent),
    email: who.all().find((e) => e.className === "d")?.textContent ?? null,
    workspace: ws.textContent,
    tours: tours.textContent,
    bar: mini === undefined ? null : { cls: mini.className, width: mini.children.filter((c): c is FakeElement => c instanceof FakeElement)[0].style.width },
    used: used.textContent,
    over: used.all().filter((e) => e.className === "tag warn").map((e) => e.textContent),
    allowance: allowance.textContent,
    button: acts.textContent,
  };
}

// ---- The size parser on its own ----

function sizeOf(): (text: string) => number | null | undefined {
  const ctx = vm.createContext({});
  vm.runInContext(SIZE_JS, ctx);
  return vm.runInContext("sizeOf", ctx) as (text: string) => number | null | undefined;
}

describe("the size parser", () => {
  // undefined: refused. null: empty, the standard allowance.
  const TABLE: [string, number | null | undefined][] = [
    ["", null],
    ["   ", null],
    ["0", 0],
    ["1", 1],
    ["1024", 1024],
    ["512 bytes", 512],
    ["1 byte", 1],
    ["7 B", 7],
    ["7b", 7],
    ["1 KB", 1024],
    ["500 MB", 500 * MB],
    ["500mb", 500 * MB],
    ["10 GB", 10 * GB],
    ["10gb", 10 * GB],
    [" 10 GB ", 10 * GB],
    ["10 Gb", 10 * GB],
    ["10GB", 10 * GB],
    ["10  GB", 10 * GB],
    ["1.5 GB", 1.5 * GB],
    ["1.2 GB", Math.round(1.2 * GB)],
    ["0.1 GB", Math.round(0.1 * GB)],
    ["010 MB", 10 * MB],
    ["8388608 GB", undefined],
    ["8388607 GB", 8_388_607 * GB],
    ["9007199254740991", 9_007_199_254_740_991],
    ["9007199254740992", undefined],
    ["99999999999999999999", undefined],
    ["1,5 GB", undefined],
    ["1.5.1 GB", undefined],
    ["1. GB", undefined],
    [".5 GB", undefined],
    ["-1", undefined],
    ["-1 GB", undefined],
    ["+1 GB", undefined],
    ["1e3", undefined],
    ["10 TB", undefined],
    ["10 G", undefined],
    ["10 KiB", undefined],
    ["GB", undefined],
    ["ten GB", undefined],
    ["1.5", undefined],
    ["1.5 bytes", undefined],
    ["10 GB extra", undefined],
    ["Infinity", undefined],
    ["NaN", undefined],
    ["0x10", undefined],
    ["١٠ GB", undefined],
    // Exact to the byte, however many digits the fraction has (review follow-up B6).
    ["167518636910.729 KB", 171_539_084_196_586],
    ["3573639.63091475 GB", Number((357363963091475n * 1073741824n + 50000000n) / 100000000n)],
    ["0.0000000005 GB", 1],
    ["0.0000000004 GB", 0],
  ];

  it("takes sizes such as 500 MB, 10 GB, 1.5 GB and plain bytes, in any case, counting 1024 to the next unit, and refuses everything else", () => {
    const parse = sizeOf();
    for (const [text, want] of TABLE) expect(parse(text), JSON.stringify(text)).toBe(want);
  });

  it("rounds to the nearest byte exactly, as whole-number arithmetic on the digits does", () => {
    const parse = sizeOf();
    const units: [string, bigint][] = [["KB", 1024n], ["MB", 1048576n], ["GB", 1073741824n]];
    // A fixed-seed generator, so a failure can be repeated.
    let seed = 20261119;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const digits = (n: number) => Array.from({ length: n }, () => String(rand(10))).join("");
    for (let i = 0; i < 3000; i++) {
      const [unit, factor] = units[rand(3)];
      const whole = digits(1 + rand(10));
      const frac = digits(1 + rand(18));
      const scale = 10n ** BigInt(frac.length);
      const exact = (BigInt(whole) * scale + BigInt(frac)) * factor;
      let want = exact / scale;
      if ((exact % scale) * 2n >= scale) want += 1n;
      const text = `${whole}.${frac} ${unit}`;
      expect(parse(text), text).toBe(want <= 9007199254740991n ? Number(want) : undefined);
    }
  });

  it("reads back every size the pages write, so a size shown can be saved as it is", () => {
    const parse = sizeOf();
    const ctx = vm.createContext({ document: {}, location: {}, fetch: () => Promise.reject(new Error("no")) });
    vm.runInContext(DASH_JS, ctx);
    const format = vm.runInContext("Dash.formatBytes", ctx) as (n: number) => string;
    for (const [n, text] of SIZE_TABLE) {
      expect(format(n)).toBe(text);
      // The largest allowance there is shows as 8388608 GB, which is one byte past it: the field then holds the bytes.
      if (n === Number.MAX_SAFE_INTEGER) {
        expect(parse(text)).toBeUndefined();
        continue;
      }
      const back = parse(text);
      expect(typeof back, text).toBe("number");
      // What is read back is within the rounding of the shown size: half a tenth of its unit.
      const unit = n < 1024 ? 1 : n < 1024 ** 2 ? 1024 : n < 1024 ** 3 ? 1024 ** 2 : 1024 ** 3;
      expect(Math.abs((back as number) - n), text).toBeLessThanOrEqual(unit <= 1 ? 0 : unit * 0.05 + 1);
    }
  });
});

// ---- A member ----

describe("the Admin page for a member", () => {
  it("shows a missing page, asks nothing of the admin routes, and keeps nothing of the admin screen in the page", async () => {
    for (const admin of [false, "yes", 1, null, undefined]) {
      const tab = openAdmin(answers({ "GET /api/v1/session": session(admin, "<b>member</b>") }));
      await tab.settle();
      expect(tab.fetched.map((f) => `${f.method} ${f.path}`), String(admin)).toEqual(["GET /api/v1/session"]);
      expect(tab.left()).toBeNull();
      expect(tab.shows(), String(admin)).toEqual(["Mythicshot", "<b>member</b>", "Page not found", "Back to Tours"]);
      expect(tab.$("missing").shown).toBe(true);
      const back = tab.$("missing").all().find((e) => e.tagName === "a")!;
      expect([back.getAttribute("href"), back.textContent, back.shown]).toEqual(["/tours", "Back to Tours", true]);
      // The admin screen and its question are gone from the page, not just hidden.
      for (const id of ["admin", "admin-rows", "admin-summary", "allow-dialog", "allow-input"]) expect(tab.has(id), `#${id}`).toBe(false);
      expect(tab.doc.root.all().some((e) => e.tagName === "table")).toBe(false);
      expect(tab.$("tab-admin").hidden).toBe(true);
      expect(tab.doc.title).toBe("Page not found");
    }
  });

  it("a session that says admin but whose admin routes answer 404 shows the missing page too", async () => {
    for (const which of ["GET /api/v1/admin/summary", "GET /api/v1/admin/accounts"]) {
      const tab = openAdmin(standard({ [which]: NOT_FOUND }));
      await tab.settle();
      expect(tab.shows(), which).toEqual(["Mythicshot", "solex", "Page not found", "Back to Tours"]);
      expect(tab.has("admin-rows"), which).toBe(false);
      expect(tab.$("dash-load").textContent).toBe("");
    }
  });

  it("a visitor who is not signed in goes to /signin and asks nothing else", async () => {
    const tab = openAdmin(answers({ "GET /api/v1/session": SIGNED_OUT }));
    await tab.settle();
    expect(tab.left()).toBe("/signin");
    expect(tab.fetched.map((f) => `${f.method} ${f.path}`)).toEqual(["GET /api/v1/session"]);
    expect(tab.$("admin").hidden).toBe(true);
    expect(tab.$("missing").hidden).toBe(true);
  });
});

// ---- The admin ----

describe("the Admin page for the admin", () => {
  it("shows mockup 9: the summary line, a row per account with its tags, bar, sizes and button, and the hint", async () => {
    const tab = openAdmin(standard());
    await tab.settle();
    expect(tab.fetched.map((f) => `${f.method} ${f.path}`).sort()).toEqual(["GET /api/v1/admin/accounts", "GET /api/v1/admin/summary", "GET /api/v1/session"]);
    expect(tab.$("tab-admin").hidden).toBe(false);
    expect(tab.$("admin-summary").textContent).toBe("3 accounts · 6.6 GB used in all · standard allowance 5 GB");
    expect(rows(tab).map(rowOf)).toEqual([
      { name: "solex", tags: ["Admin"], email: "you@example.com", workspace: "Cowfee Raid Tools", tours: "12", bar: { cls: "mini", width: "24%" }, used: "1.2 GB", over: [], allowance: "5 GB", button: "Set allowance" },
      { name: "mara", tags: [], email: "mara@example.com", workspace: "Harbor Studio", tours: "31", bar: { cls: "mini over", width: "100%" }, used: "5.3 GBOver", over: ["Over"], allowance: "5 GB", button: "Set allowance" },
      { name: "bram", tags: [], email: "bram@example.com", workspace: "Bram's demos", tours: "2", bar: { cls: "mini", width: "1%" }, used: "96 MB", over: [], allowance: "20 GB", button: "Set allowance" },
    ]);
    expect(tab.shows()).toEqual(["Mythicshot", "solex", "Accounts", "3 accounts · 6.6 GB used in all · standard allowance 5 GB", "Set allowance", "Set allowance", "Set allowance", "You see how much each workspace uses, never what is in it. Inviting people comes in a later phase."]);
    expect(tab.$("admin-more").shown).toBe(false);
    expect(tab.$("missing").hidden).toBe(true);
    // Each button names its account for a screen reader; on a phone each figure carries its column's name.
    for (const [i, row] of rows(tab).entries()) {
      expect(setButton(row).getAttribute("aria-describedby")).toBe(`account-${i}`);
      expect(setButton(row).getAttribute("type")).toBe("button");
      expect(cells(row).map((c) => c.getAttribute("data-label"))).toEqual([null, null, "Tours", null, "Used", "Allowance", null]);
    }
    expect(tab.$("allow-dialog").hidden).toBe(true);
  });

  it("writes one account in the singular, no standard allowance, None where no allowance applies, and no bar without one", async () => {
    const none = account(U1, W1, { username: null, email: "only@example.com", workspace_name: "Solo", used_bytes: 0, standard: null });
    const own = account(U2, W2, { used_bytes: 10, storage_allowance_bytes: 0, standard: null });
    const tab = openAdmin(standard({ "GET /api/v1/admin/summary": summary(1, 0, null), "GET /api/v1/admin/accounts": list([none, own]) }));
    await tab.settle();
    expect(tab.$("admin-summary").textContent).toBe("1 account · 0 bytes used in all · no standard allowance");
    const [a, b] = rows(tab).map(rowOf);
    // An account without a username is named by its email address, once.
    expect(a).toMatchObject({ name: "only@example.com", email: null, bar: null, used: "0 bytes", allowance: "None" });
    // An allowance of 0 is an allowance: 10 bytes are over it.
    expect(b).toMatchObject({ bar: { cls: "mini over", width: "100%" }, used: "10 bytesOver", allowance: "0 bytes" });
  });

  it("tags a disabled account Disabled", async () => {
    const off = account(U2, W2, { username: "gone", status: "disabled" });
    const tab = openAdmin(standard({ "GET /api/v1/admin/accounts": list([MOCKUP[0], off]) }));
    await tab.settle();
    expect(rows(tab).map((r) => rowOf(r).tags)).toEqual([["Admin"], ["Disabled"]]);
  });

  it("shows usernames, emails and workspace names holding markup as text", async () => {
    const evil = account(U1, W1, { username: "<img src=x onerror=alert(1)>", email: '"<b>"@example.com', workspace_name: "</td><script>x</script>" });
    const tab = openAdmin(standard({ "GET /api/v1/admin/accounts": list([evil]) }));
    await tab.settle();
    expect(rowOf(rows(tab)[0])).toMatchObject({ name: "<img src=x onerror=alert(1)>", email: '"<b>"@example.com', workspace: "</td><script>x</script>" });
    expect(tab.doc.root.all().some((e) => ["img", "b", "script"].includes(e.tagName) && e.parent?.tagName !== "head")).toBe(false);
    setButton(rows(tab)[0]).click();
    expect(tab.$("allow-title").textContent).toBe("Storage allowance for </td><script>x</script>");
    expect(tab.$("allow-title").children.every((c) => !(c instanceof FakeElement))).toBe(true);
  });

  it("Show more asks for the page after the last one while the list says there is one, and adds its rows", async () => {
    const more = [account("usr_" + "4".repeat(24), "ws_" + "4".repeat(24), { username: "tess" }), account("usr_" + "5".repeat(24), "ws_" + "5".repeat(24), { username: "rook" })];
    const tab = openAdmin(standard({ "GET /api/v1/admin/summary": summary(5, MOCKUP_USED, STANDARD), "GET /api/v1/admin/accounts": list(MOCKUP, U3), [`GET /api/v1/admin/accounts?after=${U3}`]: list(more) }));
    await tab.settle();
    expect(rows(tab)).toHaveLength(3);
    const button = tab.$("admin-more");
    expect([button.shown, button.textContent, button.getAttribute("type")]).toEqual([true, "Show more", "button"]);
    button.click();
    expect(button.disabled).toBe(true);
    await tab.settle();
    expect(tab.fetched.map((f) => f.path).filter((p) => p.startsWith("/api/v1/admin/accounts"))).toEqual(["/api/v1/admin/accounts", `/api/v1/admin/accounts?after=${U3}`]);
    expect(rows(tab).map((r) => rowOf(r).name)).toEqual(["solex", "mara", "bram", "tess", "rook"]);
    expect(button.shown).toBe(false);
    expect(button.disabled).toBe(false);
    // The focus moves to the first new row.
    expect(tab.doc.activeElement).toBe(setButton(rows(tab)[3]));
    // Distinct ids for every row, across pages.
    expect(new Set(rows(tab).map((r) => setButton(r).getAttribute("aria-describedby"))).size).toBe(5);
  });

  it("Show more that fails says so and stays; a next that is not an account id shows no Show more", async () => {
    const tab = openAdmin(standard({ "GET /api/v1/admin/accounts": list(MOCKUP, U3), [`GET /api/v1/admin/accounts?after=${U3}`]: { status: 429, json: { error: "rate_limited" } } }));
    await tab.settle();
    tab.$("admin-more").click();
    await tab.settle();
    expect([tab.$("admin-message").textContent, tab.$("admin-message").hidden]).toEqual([TOO_MANY, false]);
    expect([tab.$("admin-more").shown, tab.$("admin-more").disabled]).toEqual([true, false]);
    expect(rows(tab)).toHaveLength(3);

    for (const next of ["x", "../summary", "usr_1&after=x", 7]) {
      const odd = openAdmin(standard({ "GET /api/v1/admin/accounts": list(MOCKUP, next as string) }));
      await odd.settle();
      expect(odd.$("admin-more").shown, String(next)).toBe(false);
    }
  });

  it("says when the list cannot be read, with the approved sentences, and a lost session goes to /signin", async () => {
    for (const [table, text] of [
      [{ "GET /api/v1/admin/summary": { status: 500, json: { error: "internal" } } }, FAILED],
      [{ "GET /api/v1/admin/accounts": { status: 429, json: { error: "rate_limited" } } }, TOO_MANY],
      [{ "GET /api/v1/admin/accounts": "network" }, FAILED],
      [{ "GET /api/v1/admin/accounts": { status: 200, json: { accounts: "x" } } }, FAILED],
      [{ "GET /api/v1/admin/summary": { status: 200, json: { accounts: 1 } } }, FAILED],
    ] as const) {
      const tab = openAdmin(standard(table as Record<string, Answer>));
      await tab.settle();
      expect(tab.$("dash-load").textContent, JSON.stringify(table)).toBe(text);
      expect(tab.$("admin").hidden).toBe(true);
      expect(tab.$("missing").hidden).toBe(true);
    }
    const out = openAdmin(standard({ "GET /api/v1/admin/accounts": SIGNED_OUT }));
    await out.settle();
    expect(out.left()).toBe("/signin");
  });
});

// ---- Setting an allowance ----

describe("setting an allowance", () => {
  it("asks mockup 10's question: the title, what is used, the field with the workspace's own number, and the hint with the standard allowance", async () => {
    const tab = openAdmin(standard());
    await tab.settle();
    const opener = setButton(rows(tab)[1]);
    opener.click();
    expect(tab.$("allow-dialog").hidden).toBe(false);
    expect(tab.$("allow-title").textContent).toBe("Storage allowance for Harbor Studio");
    expect(tab.$("allow-uses").textContent).toBe("Uses 5.3 GB now.");
    expect(tab.$("allow-input").value).toBe("");
    expect(tab.$("allow-hint").textContent).toBe("Write a size such as 500 MB or 10 GB. Leave it empty to use the standard allowance of 5 GB.");
    expect(tab.doc.activeElement).toBe(tab.$("allow-input"));
    // The page behind is inert and hidden from screen readers while it is open: the bar and the admin screen.
    const behind = tab.doc.body.all().filter((e) => e.hasAttribute("inert"));
    expect(behind.map((e) => e.id)).toEqual(["dash-top", "admin"]);
    for (const e of behind) expect(e.getAttribute("aria-hidden"), e.id).toBe("true");
    expect(tab.$("allow-dialog").hasAttribute("inert")).toBe(false);
    type(tab, "10 GB");
    expect([tab.$("allow-hint").shown, tab.$("allow-warn").shown, tab.$("allow-save").textContent]).toEqual([true, false, "Save"]);
    expect(tab.shows().slice(-6)).toEqual(["Storage allowance for Harbor Studio", "Uses 5.3 GB now.", "Allowance", "Write a size such as 500 MB or 10 GB. Leave it empty to use the standard allowance of 5 GB.", "Cancel", "Save"]);
    type(tab, "2 GB");
    expect(tab.$("allow-warn").textContent).toBe("That is less than this workspace uses. Nothing is deleted, but its new uploads are refused until it is under 2 GB.");
    expect([tab.$("allow-hint").shown, tab.$("allow-warn").shown, tab.$("allow-save").textContent]).toEqual([false, true, "Save anyway"]);
    expect(tab.shows().slice(-6)).toEqual(["Storage allowance for Harbor Studio", "Uses 5.3 GB now.", "Allowance", "That is less than this workspace uses. Nothing is deleted, but its new uploads are refused until it is under 2 GB.", "Cancel", "Save anyway"]);
    // Exactly what is used leaves no room either: the warning says so (review follow-up B2).
    type(tab, "5690831667");
    expect(tab.$("allow-warn").textContent).toBe("That is exactly what this workspace uses. Nothing is deleted, but its new uploads are refused until it is under 5.3 GB.");
    expect(tab.$("allow-save").textContent).toBe("Save anyway");
    // Empty is the standard allowance, which is below what this workspace uses: the warning, with the standard number.
    type(tab, "");
    expect(tab.$("allow-warn").textContent).toBe("That is less than this workspace uses. Nothing is deleted, but its new uploads are refused until it is under 5 GB.");
    expect(tab.$("allow-save").textContent).toBe("Save anyway");
    // A size that cannot be read gives no warning until Save.
    type(tab, "lots");
    expect([tab.$("allow-hint").shown, tab.$("allow-warn").shown, tab.$("allow-save").textContent]).toEqual([true, false, "Save"]);
    // Cancel closes it, gives the focus back, and the page is no longer inert.
    tab.$("allow-cancel").click();
    expect(tab.$("allow-dialog").hidden).toBe(true);
    expect(tab.doc.activeElement).toBe(opener);
    expect(tab.doc.body.all().filter((e) => e.hasAttribute("inert") || e.hasAttribute("aria-hidden") && ["dash-top", "admin"].includes(e.id))).toEqual([]);
    expect(tab.fetched.filter((f) => f.method !== "GET")).toEqual([]);
  });

  it("fills in the workspace's own allowance so that saving it unchanged keeps the very number, and with no standard allowance says so", async () => {
    const odd = account(U2, W2, { workspace_name: "Odd", used_bytes: 0, storage_allowance_bytes: 1_234_567_890, standard: null });
    const round = account(U3, W3, { workspace_name: "Round", used_bytes: 0, storage_allowance_bytes: 20 * GB, standard: null });
    const tab = openAdmin(
      standard({
        "GET /api/v1/admin/summary": summary(2, 0, null),
        "GET /api/v1/admin/accounts": list([odd, round]),
        [`PATCH /api/v1/admin/workspaces/${W2}`]: { status: 200, json: { workspace_id: W2, allowance_bytes: 1_234_567_890, storage_allowance_bytes: 1_234_567_890, used_bytes: 0, over: false } },
      }),
    );
    await tab.settle();
    setButton(rows(tab)[1]).click();
    expect(tab.$("allow-input").value).toBe("20 GB");
    expect(tab.$("allow-hint").textContent).toBe("Write a size such as 500 MB or 10 GB. Leave it empty for no allowance.");
    tab.$("allow-cancel").click();
    setButton(rows(tab)[0]).click();
    // 1.1 GB would not read back as the same number: the field holds the bytes.
    expect(tab.$("allow-input").value).toBe("1234567890");
    tab.$("allow-save").click();
    await tab.settle();
    expect(tab.fetched.filter((f) => f.method === "PATCH").map((f) => f.body)).toEqual(['{"storage_allowance_bytes":1234567890}']);
  });

  it("Save sends the size in bytes with the anti-forgery header, then reads the list again rather than trusting what it sent", async () => {
    const after = MOCKUP.map((a) => (a.id === U2 ? { ...a, storage_allowance_bytes: 10 * GB, allowance_bytes: 10 * GB, over: false } : a));
    const tab = openAdmin(
      standard({
        "GET /api/v1/admin/accounts": [list(MOCKUP), list(after)],
        "GET /api/v1/admin/summary": [summary(3, MOCKUP_USED, STANDARD), summary(3, MOCKUP_USED + 1, STANDARD)],
        [`PATCH /api/v1/admin/workspaces/${W2}`]: { status: 200, json: { workspace_id: W2, allowance_bytes: 10 * GB, storage_allowance_bytes: 10 * GB, used_bytes: 5_690_831_667, over: false } },
      }),
    );
    await tab.settle();
    setButton(rows(tab)[1]).click();
    type(tab, "10 GB");
    const save = tab.$("allow-save");
    save.click();
    // While it runs, nothing in the question can be pressed, and Escape and a click outside do nothing.
    expect([save.textContent, save.disabled, tab.$("allow-cancel").disabled, tab.$("allow-input").hasAttribute("readonly")]).toEqual(["Saving…", true, true, true]);
    key(tab.$("allow-input"), "Escape");
    tab.$("allow-dialog").click();
    expect(tab.$("allow-dialog").hidden).toBe(false);
    // Tab and Shift+Tab keep the focus in the question, on its title, while the buttons are disabled.
    expect(key(tab.$("allow-input"), "Tab").defaultPrevented).toBe(true);
    expect(tab.doc.activeElement).toBe(tab.$("allow-title"));
    expect(key(tab.$("allow-title"), "Tab", true).defaultPrevented).toBe(true);
    expect(tab.doc.activeElement).toBe(tab.$("allow-title"));
    await tab.settle();
    const sent = tab.fetched.filter((f) => f.method === "PATCH");
    expect(sent.map((f) => [f.path, f.headers["X-Csrf-Token"], f.headers["content-type"], f.body])).toEqual([[`/api/v1/admin/workspaces/${W2}`, CSRF, "application/json", `{"storage_allowance_bytes":${10 * GB}}`]]);
    // The list and the summary are read again, and the row shows what the server now says.
    expect(tab.fetched.filter((f) => f.path === "/api/v1/admin/accounts")).toHaveLength(2);
    expect(tab.fetched.filter((f) => f.path === "/api/v1/admin/summary")).toHaveLength(2);
    expect(tab.$("allow-dialog").hidden).toBe(true);
    expect(rowOf(rows(tab)[1])).toMatchObject({ used: "5.3 GB", over: [], allowance: "10 GB", bar: { cls: "mini", width: "53%" } });
    expect(tab.doc.activeElement).toBe(setButton(rows(tab)[1]));
    expect([save.textContent, save.disabled, tab.$("allow-cancel").disabled]).toEqual(["Save", false, false]);
    expect(tab.doc.body.all().filter((e) => e.hasAttribute("inert") || e.hasAttribute("aria-hidden") && ["dash-top", "admin"].includes(e.id))).toEqual([]);
  });

  it("a save that worked but whose list cannot be read again says so and keeps the numbers shown", async () => {
    for (const failure of [{ status: 500, json: { error: "internal" } }, "network"] as Answer[]) {
      const tab = openAdmin(
        standard({
          "GET /api/v1/admin/accounts": [list(MOCKUP), failure],
          [`PATCH /api/v1/admin/workspaces/${W2}`]: { status: 200, json: { workspace_id: W2, allowance_bytes: 10 * GB, storage_allowance_bytes: 10 * GB, used_bytes: 5_690_831_667, over: false } },
        }),
      );
      await tab.settle();
      const before = rows(tab).map(rowOf);
      setButton(rows(tab)[1]).click();
      type(tab, "10 GB");
      tab.$("allow-save").click();
      await tab.settle();
      expect(tab.$("allow-dialog").hidden).toBe(true);
      expect([tab.$("admin-message").textContent, tab.$("admin-message").hidden]).toEqual(["The change was made, but the list could not be loaded again. Reload the page to see it.", false]);
      expect(rows(tab).map(rowOf)).toEqual(before);
      expect(tab.$("admin-summary").textContent).toBe("3 accounts · 6.6 GB used in all · standard allowance 5 GB");
      expect(tab.doc.activeElement).toBe(setButton(rows(tab)[1]));
    }
  });

  it("an empty field sends null, which puts the workspace back on the standard allowance", async () => {
    const tab = openAdmin(standard({ [`PATCH /api/v1/admin/workspaces/${W3}`]: { status: 200, json: { workspace_id: W3, allowance_bytes: STANDARD, storage_allowance_bytes: null, used_bytes: 96 * MB, over: false } } }));
    await tab.settle();
    setButton(rows(tab)[2]).click();
    expect(tab.$("allow-input").value).toBe("20 GB");
    type(tab, "  ");
    tab.$("allow-save").click();
    await tab.settle();
    expect(tab.fetched.filter((f) => f.method === "PATCH").map((f) => f.body)).toEqual(['{"storage_allowance_bytes":null}']);
  });

  it("a size that cannot be read says how to write one and sends nothing", async () => {
    const tab = openAdmin(standard());
    await tab.settle();
    setButton(rows(tab)[0]).click();
    for (const text of ["1,5 GB", "10 TB", "-1", "lots", "9007199254740992"]) {
      type(tab, text);
      tab.$("allow-save").click();
      await tab.settle();
      expect(tab.$("allow-message").textContent, text).toBe("Write a size such as 500 MB or 10 GB.");
      expect(tab.$("allow-message").hidden, text).toBe(false);
      expect(tab.$("allow-input").getAttribute("aria-invalid"), text).toBe("true");
      expect(tab.doc.activeElement).toBe(tab.$("allow-input"));
    }
    expect(tab.fetched.filter((f) => f.method !== "GET")).toEqual([]);
    // Typing again clears the complaint.
    type(tab, "1 GB");
    expect([tab.$("allow-message").textContent, tab.$("allow-message").hidden, tab.$("allow-input").getAttribute("aria-invalid")]).toEqual(["", true, null]);
  });

  it("a save that fails says so with the approved sentences, keeps the question open, gives the buttons back and reads the list again", async () => {
    for (const [answer, text] of [[{ status: 429, json: { error: "rate_limited" } }, TOO_MANY], [{ status: 404, json: { error: "not_found" } }, FAILED], [{ status: 400, json: { error: "bad_allowance" } }, FAILED], [{ status: 500, json: { error: "internal" } }, FAILED], ["network", FAILED]] as const) {
      const tab = openAdmin(standard({ [`PATCH /api/v1/admin/workspaces/${W1}`]: answer as Answer }));
      await tab.settle();
      setButton(rows(tab)[0]).click();
      type(tab, "2 GB");
      tab.$("allow-save").click();
      await tab.settle();
      expect(tab.$("allow-message").textContent, JSON.stringify(answer)).toBe(text);
      expect(tab.$("allow-dialog").hidden).toBe(false);
      expect([tab.$("allow-save").textContent, tab.$("allow-save").disabled, tab.$("allow-cancel").disabled, tab.$("allow-input").hasAttribute("readonly")]).toEqual(["Save", false, false, false]);
      expect(tab.fetched.filter((f) => f.path === "/api/v1/admin/accounts"), JSON.stringify(answer)).toHaveLength(2);
      expect(tab.doc.activeElement).toBe(tab.$("allow-save"));
      // Closing it now gives the focus to the account's button in the list as it was read again.
      tab.$("allow-cancel").click();
      expect(tab.doc.activeElement).toBe(setButton(rows(tab)[0]));
    }
    const out = openAdmin(standard({ [`PATCH /api/v1/admin/workspaces/${W1}`]: SIGNED_OUT }));
    await out.settle();
    setButton(rows(out)[0]).click();
    out.$("allow-save").click();
    await out.settle();
    expect(out.left()).toBe("/signin");
  });

  it("the question keeps the keyboard: Escape anywhere closes it, Tab and Shift+Tab go round its controls, a click on the backdrop closes it", async () => {
    const tab = openAdmin(standard());
    await tab.settle();
    const opener = setButton(rows(tab)[1]);
    opener.click();
    const [input, cancel, save] = ["allow-input", "allow-cancel", "allow-save"].map((id) => tab.$(id));
    // Tab from the last goes to the first, Shift+Tab from the first to the last; in between the browser moves.
    tab.doc.activeElement = save;
    expect(key(save, "Tab").defaultPrevented).toBe(true);
    expect(tab.doc.activeElement).toBe(input);
    expect(key(input, "Tab", true).defaultPrevented).toBe(true);
    expect(tab.doc.activeElement).toBe(save);
    // In between, the question moves the focus itself, as every dashboard question does (Dash.question).
    cancel.focus();
    expect(key(cancel, "Tab").defaultPrevented).toBe(true);
    expect(tab.doc.activeElement).toBe(save);
    cancel.focus();
    expect(key(cancel, "Tab", true).defaultPrevented).toBe(true);
    expect(tab.doc.activeElement).toBe(input);
    // Focus that got out of the question (on the page itself) is brought back by Tab, at the document.
    tab.doc.activeElement = tab.doc.body;
    expect(key(tab.doc.body, "Tab").defaultPrevented).toBe(true);
    expect(tab.doc.activeElement).toBe(input);
    // Escape at the document closes it, wherever the focus is.
    tab.doc.activeElement = tab.doc.body;
    key(tab.doc.body, "Escape");
    expect(tab.$("allow-dialog").hidden).toBe(true);
    expect(tab.doc.activeElement).toBe(opener);
    // Closed, the document's keys are left alone.
    expect(key(tab.doc.body, "Tab").defaultPrevented).toBe(false);
    // A click on the backdrop closes it; a click inside the question does not.
    opener.click();
    tab.$("allow-title").click();
    input.click();
    expect(tab.$("allow-dialog").hidden).toBe(false);
    tab.$("allow-dialog").click();
    expect(tab.$("allow-dialog").hidden).toBe(true);
    expect(tab.doc.activeElement).toBe(opener);
    expect(tab.fetched.filter((f) => f.method !== "GET")).toEqual([]);
  });
});

describe("the allowance question: an allowance that leaves no room, Enter, and what a screen reader hears", () => {
  const ZERO_STANDARD = "An allowance of 0 refuses every upload from this workspace. Leave the field empty for the standard allowance.";
  const ZERO_NONE = "An allowance of 0 refuses every upload from this workspace. Leave the field empty for no allowance.";
  const SAVED: Answer = { status: 200, json: { workspace_id: W2, allowance_bytes: 10 * GB, storage_allowance_bytes: 10 * GB, used_bytes: 5_690_831_667, over: false } };

  it("an allowance of 0 warns and asks Save anyway, for a workspace that uses nothing and for one that uses some", async () => {
    const empty = account(U1, W1, { workspace_name: "Empty", used_bytes: 0 });
    const some = account(U2, W2, { workspace_name: "Some", used_bytes: 5 * MB });
    const tab = openAdmin(standard({ "GET /api/v1/admin/accounts": list([empty, some]), [`PATCH /api/v1/admin/workspaces/${W1}`]: { status: 200, json: { workspace_id: W1, allowance_bytes: 0, storage_allowance_bytes: 0, used_bytes: 0, over: false } } }));
    await tab.settle();
    for (const row of [0, 1]) {
      setButton(rows(tab)[row]).click();
      type(tab, "0");
      expect([tab.$("allow-warn").textContent, tab.$("allow-warn").shown, tab.$("allow-hint").shown, tab.$("allow-save").textContent], String(row)).toEqual([ZERO_STANDARD, true, false, "Save anyway"]);
      type(tab, "0 GB");
      expect(tab.$("allow-warn").textContent, String(row)).toBe(ZERO_STANDARD);
      tab.$("allow-cancel").click();
    }
    // Above what is used, no warning: 1 KB for the empty workspace, 6 MB for the other.
    setButton(rows(tab)[0]).click();
    type(tab, "1 KB");
    expect([tab.$("allow-warn").shown, tab.$("allow-hint").shown, tab.$("allow-save").textContent]).toEqual([false, true, "Save"]);
    tab.$("allow-cancel").click();
    setButton(rows(tab)[1]).click();
    type(tab, "6 MB");
    expect([tab.$("allow-warn").shown, tab.$("allow-save").textContent]).toEqual([false, "Save"]);
    // Exactly what it uses, and below it.
    type(tab, "5 MB");
    expect(tab.$("allow-warn").textContent).toBe("That is exactly what this workspace uses. Nothing is deleted, but its new uploads are refused until it is under 5 MB.");
    type(tab, "4 MB");
    expect(tab.$("allow-warn").textContent).toBe("That is less than this workspace uses. Nothing is deleted, but its new uploads are refused until it is under 4 MB.");
    tab.$("allow-cancel").click();
    // Saving 0 anyway sends 0.
    setButton(rows(tab)[0]).click();
    type(tab, "0");
    tab.$("allow-save").click();
    await tab.settle();
    expect(tab.fetched.filter((f) => f.method === "PATCH").map((f) => f.body)).toEqual(['{"storage_allowance_bytes":0}']);
  });

  it("with no standard allowance the 0 warning says an empty field is no allowance", async () => {
    const empty = account(U1, W1, { workspace_name: "Empty", used_bytes: 0, standard: null });
    const tab = openAdmin(standard({ "GET /api/v1/admin/summary": summary(1, 0, null), "GET /api/v1/admin/accounts": list([empty]) }));
    await tab.settle();
    setButton(rows(tab)[0]).click();
    type(tab, "0");
    expect([tab.$("allow-warn").textContent, tab.$("allow-save").textContent]).toEqual([ZERO_NONE, "Save anyway"]);
    // An empty field is no allowance at all: nothing to warn about.
    type(tab, "");
    expect([tab.$("allow-warn").shown, tab.$("allow-save").textContent]).toEqual([false, "Save"]);
  });

  it("the field is tied to the hint or to the warning for a screen reader, never to the one that is hidden", async () => {
    const tab = openAdmin(standard());
    await tab.settle();
    setButton(rows(tab)[1]).click();
    const input = tab.$("allow-input");
    type(tab, "10 GB");
    expect(input.getAttribute("aria-describedby")).toBe("allow-hint allow-message");
    type(tab, "1 GB");
    expect(input.getAttribute("aria-describedby")).toBe("allow-warn allow-message");
    type(tab, "0");
    expect(input.getAttribute("aria-describedby")).toBe("allow-warn allow-message");
    type(tab, "lots");
    expect(input.getAttribute("aria-describedby")).toBe("allow-hint allow-message");
  });

  it("Enter in the field saves, once, as Save does", async () => {
    const tab = openAdmin(standard({ [`PATCH /api/v1/admin/workspaces/${W2}`]: SAVED }));
    await tab.settle();
    setButton(rows(tab)[1]).click();
    type(tab, "10 GB");
    expect(key(tab.$("allow-input"), "Enter").defaultPrevented).toBe(true);
    key(tab.$("allow-input"), "Enter");
    await tab.settle();
    expect(tab.fetched.filter((f) => f.method === "PATCH").map((f) => f.body)).toEqual([`{"storage_allowance_bytes":${10 * GB}}`]);
    expect(tab.$("allow-dialog").hidden).toBe(true);
    // Other keys type as usual.
    setButton(rows(tab)[1]).click();
    expect(key(tab.$("allow-input"), "a").defaultPrevented).toBe(false);
  });

  it("a double click on Save sends one request", async () => {
    const tab = openAdmin(standard({ [`PATCH /api/v1/admin/workspaces/${W2}`]: SAVED }));
    await tab.settle();
    setButton(rows(tab)[1]).click();
    type(tab, "10 GB");
    tab.$("allow-save").click();
    tab.$("allow-save").click();
    tab.$("allow-save").dispatch("click");
    await tab.settle();
    expect(tab.fetched.filter((f) => f.method === "PATCH")).toHaveLength(1);
  });
});

describe("the list with two pages loaded: one request at a time", () => {
  const U4 = "usr_" + "4".repeat(24);
  const U5 = "usr_" + "5".repeat(24);
  const U6 = "usr_" + "6".repeat(24);
  const PAGE2 = [account(U4, "ws_" + "4".repeat(24), { username: "tess" }), account(U5, "ws_" + "5".repeat(24), { username: "rook" })];
  const PAGE3 = [account(U6, "ws_" + "6".repeat(24), { username: "vale" })];
  const SAVED: Answer = { status: 200, json: { workspace_id: W2, allowance_bytes: 10 * GB, storage_allowance_bytes: 10 * GB, used_bytes: 5_690_831_667, over: false } };
  const names = (tab: Tab) => rows(tab).map((r) => rowOf(r).name);

  /** A responder over three pages of accounts; while holding, every GET waits until the test releases it, in order. */
  function paged(extra: Record<string, Answer | Answer[]> = {}) {
    const waiting: { path: string; release: () => void }[] = [];
    let holding = false;
    const base = standard({
      "GET /api/v1/admin/summary": summary(6, MOCKUP_USED, STANDARD),
      "GET /api/v1/admin/accounts": list(MOCKUP, U3),
      [`GET /api/v1/admin/accounts?after=${U3}`]: list(PAGE2, U5),
      [`GET /api/v1/admin/accounts?after=${U5}`]: list(PAGE3),
      ...extra,
    });
    const respond: Responder = (req) => {
      if (!holding || req.method !== "GET") return base(req);
      return new Promise<Answer>((resolve) => waiting.push({ path: req.path, release: () => resolve(base(req) as Answer) }));
    };
    return { respond, hold: (on: boolean) => (holding = on), waiting };
  }

  async function twoPages(p: ReturnType<typeof paged>): Promise<Tab> {
    const tab = openAdmin(p.respond);
    await tab.settle();
    tab.$("admin-more").click();
    await tab.settle();
    expect(names(tab)).toEqual(["solex", "mara", "bram", "tess", "rook"]);
    return tab;
  }

  it("Show more does nothing, and is disabled, while the list is read again after a save", async () => {
    const p = paged({ [`PATCH /api/v1/admin/workspaces/${W2}`]: SAVED });
    const tab = await twoPages(p);
    setButton(rows(tab)[1]).click();
    type(tab, "10 GB");
    p.hold(true);
    tab.$("allow-save").click();
    await tab.settle();
    // The save is done; the list is being read again.
    expect(p.waiting.map((w) => w.path)).toEqual(["/api/v1/admin/summary", "/api/v1/admin/accounts"]);
    expect(tab.$("admin-more").disabled).toBe(true);
    tab.$("admin-more").click();
    tab.$("admin-more").dispatch("click");
    await tab.settle();
    expect(tab.fetched.filter((f) => f.path === `/api/v1/admin/accounts?after=${U5}`)).toEqual([]);
    p.hold(false);
    while (p.waiting.length > 0) {
      p.waiting.shift()!.release();
      await tab.settle();
    }
    expect(names(tab)).toEqual(["solex", "mara", "bram", "tess", "rook"]);
    expect([tab.$("admin-more").shown, tab.$("admin-more").disabled]).toEqual([true, false]);
    expect(tab.fetched.filter((f) => f.path === `/api/v1/admin/accounts?after=${U5}`)).toEqual([]);
  });

  it("a save while Show more is on its way: the list is read again only after it, with every page it then has, nothing twice and nothing dropped", async () => {
    const p = paged({ [`PATCH /api/v1/admin/workspaces/${W2}`]: SAVED });
    const tab = await twoPages(p);
    p.hold(true);
    tab.$("admin-more").click();
    await tab.settle();
    expect(p.waiting.map((w) => w.path)).toEqual([`/api/v1/admin/accounts?after=${U5}`]);
    setButton(rows(tab)[1]).click();
    type(tab, "10 GB");
    tab.$("allow-save").click();
    await tab.settle();
    // The save went out; its reading of the list waits for Show more.
    expect(tab.fetched.filter((f) => f.method === "PATCH")).toHaveLength(1);
    expect(p.waiting.map((w) => w.path)).toEqual([`/api/v1/admin/accounts?after=${U5}`]);
    p.hold(false);
    p.waiting.shift()!.release();
    await tab.settle();
    expect(names(tab)).toEqual(["solex", "mara", "bram", "tess", "rook", "vale"]);
    // Then the list was read again with its three pages.
    const reads = tab.fetched.filter((f) => f.path.startsWith("/api/v1/admin/accounts")).map((f) => f.path);
    expect(reads.slice(-3)).toEqual(["/api/v1/admin/accounts", `/api/v1/admin/accounts?after=${U3}`, `/api/v1/admin/accounts?after=${U5}`]);
  });

  it("after a save that fails, the list is read again with both pages, nothing twice and nothing dropped", async () => {
    const p = paged({ [`PATCH /api/v1/admin/workspaces/${W2}`]: { status: 500, json: { error: "internal" } } });
    const tab = await twoPages(p);
    setButton(rows(tab)[1]).click();
    type(tab, "10 GB");
    tab.$("allow-save").click();
    await tab.settle();
    expect(tab.$("allow-message").textContent).toBe(FAILED);
    expect(names(tab)).toEqual(["solex", "mara", "bram", "tess", "rook"]);
    expect(tab.fetched.filter((f) => f.path.startsWith("/api/v1/admin/accounts")).map((f) => f.path).slice(-2)).toEqual(["/api/v1/admin/accounts", `/api/v1/admin/accounts?after=${U3}`]);
    expect([tab.$("admin-more").shown, tab.$("admin-more").disabled]).toEqual([true, false]);
  });

  it("after a save that works, the list is read again with both pages, and the row shows the new allowance", async () => {
    const changed = MOCKUP.map((a) => (a.id === U2 ? { ...a, storage_allowance_bytes: 10 * GB, allowance_bytes: 10 * GB, over: false } : a));
    const p = paged({ "GET /api/v1/admin/accounts": [list(MOCKUP, U3), list(changed, U3)], [`PATCH /api/v1/admin/workspaces/${W2}`]: SAVED });
    const tab = await twoPages(p);
    setButton(rows(tab)[1]).click();
    type(tab, "10 GB");
    tab.$("allow-save").click();
    await tab.settle();
    expect(names(tab)).toEqual(["solex", "mara", "bram", "tess", "rook"]);
    expect(rowOf(rows(tab)[1]).allowance).toBe("10 GB");
    expect(tab.doc.activeElement).toBe(setButton(rows(tab)[1]));
  });
});

// ---- Against the real app ----

/** A tab's fetch that goes to the real app on the app address, as a browser sends it there, with a session cookie. */
function browser(deps: Deps, cookie: string) {
  const app = createApp(deps);
  const seenAnswers: string[] = [];
  const respond = async (req: Fetched): Promise<Answer> => {
    const headers: Record<string, string> = { ...req.headers, "user-agent": FIREFOX, cookie };
    if (req.method !== "GET" && req.method !== "HEAD") Object.assign(headers, { origin: APP, "sec-fetch-site": "same-origin" });
    const res = await app.fetch(new Request(APP + req.path, { method: req.method, headers, body: req.body }));
    const text = await res.text();
    seenAnswers.push(text);
    return { status: res.status, json: text === "" ? undefined : JSON.parse(text) };
  };
  return { respond, seenAnswers };
}

async function sessionOf(deps: Deps, userId: string): Promise<string> {
  const made = await redeemSignInCode(deps, await createSignInCode(deps, userId), FIREFOX, null);
  return `${SESSION_COOKIE}=${made!.secret}`;
}

describe("the Admin page against the real app", () => {
  it("the admin sees every account and sets, lowers and clears an allowance through the API", async () => {
    const { deps } = await makeDeps({ hosts: { tours: "tours.example.com", app: "app.example.com" }, storageAllowanceBytes: STANDARD });
    const admin = await seedAccount(deps, { admin: true, username: "realadmin" });
    const member = await seedAccount(deps, { username: "realmember" });
    await deps.db.run("UPDATE workspace SET name = ? WHERE id = ?", ["<b>Harbor</b> Studio", member.workspaceId]);
    const real = browser(deps, await sessionOf(deps, admin.userId));
    const tab = openAdmin(real.respond);
    await tab.settle();
    expect(tab.$("admin-summary").textContent).toBe("2 accounts · 0 bytes used in all · standard allowance 5 GB");
    expect(rows(tab).map(rowOf).map((r) => [r.name, r.tags, r.email, r.workspace, r.allowance])).toEqual([
      ["realadmin", ["Admin"], admin.email, "Account", "5 GB"],
      ["realmember", [], member.email, "<b>Harbor</b> Studio", "5 GB"],
    ]);

    setButton(rows(tab)[1]).click();
    expect(tab.$("allow-title").textContent).toBe("Storage allowance for <b>Harbor</b> Studio");
    type(tab, "1.5 gb");
    tab.$("allow-save").click();
    await tab.settle();
    expect(tab.$("allow-dialog").hidden).toBe(true);
    expect(await deps.db.first("SELECT storage_allowance_bytes FROM workspace WHERE id = ?", [member.workspaceId])).toEqual({ storage_allowance_bytes: 1.5 * GB });
    expect(rowOf(rows(tab)[1]).allowance).toBe("1.5 GB");

    // Back to the standard allowance with an empty field.
    setButton(rows(tab)[1]).click();
    expect(tab.$("allow-input").value).toBe("1.5 GB");
    type(tab, "");
    tab.$("allow-save").click();
    await tab.settle();
    expect(await deps.db.first("SELECT storage_allowance_bytes FROM workspace WHERE id = ?", [member.workspaceId])).toEqual({ storage_allowance_bytes: null });
    expect(rowOf(rows(tab)[1]).allowance).toBe("5 GB");
    const audit = await deps.db.all<{ detail: string }>("SELECT detail FROM audit WHERE event = 'allowance_set' ORDER BY rowid");
    expect(audit.map((a) => JSON.parse(a.detail))).toEqual([{ old_bytes: null, new_bytes: 1.5 * GB }, { old_bytes: 1.5 * GB, new_bytes: null }]);
  });

  it("a member's browser never receives admin data and never renders the table, even when it asks the admin routes itself", async () => {
    const { deps } = await makeDeps({ hosts: { tours: "tours.example.com", app: "app.example.com" } });
    const admin = await seedAccount(deps, { admin: true, username: "realadmin" });
    const member = await seedAccount(deps, { username: "realmember" });
    const cookie = await sessionOf(deps, member.userId);
    const real = browser(deps, cookie);
    const tab = openAdmin(real.respond);
    await tab.settle();
    expect(tab.fetched.map((f) => `${f.method} ${f.path}`)).toEqual(["GET /api/v1/session"]);
    expect(tab.shows()).toEqual(["Mythicshot", "realmember", "Page not found", "Back to Tours"]);
    expect(tab.doc.root.all().some((e) => e.tagName === "table")).toBe(false);
    // Nothing the browser received names the admin or the other account.
    for (const text of real.seenAnswers) for (const n of [admin.email, admin.userId, admin.workspaceId, "realadmin"]) expect(text).not.toContain(n);
    // And the admin routes themselves answer the member's session only the one 404.
    for (const path of ["/api/v1/admin/accounts", "/api/v1/admin/summary"]) {
      const r = await send(deps, "GET", path, { origin: APP, headers: { cookie, "user-agent": FIREFOX } });
      expect([r.status, r.text], path).toEqual([404, '{"error":"not_found"}']);
    }
  });
});
