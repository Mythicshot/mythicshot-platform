// What the Connections page's script does when it runs: the page's document, the shared
// /dash/dash.js and the page's own /dash/connections.js are run in one fresh Node `vm`
// context against a stand-in document built from the page's own HTML (test/pages-dom.ts),
// with a stand-in timer and fetch answered from the test. Node only: the Workers runtime runs
// no code from a string.
//
// What this leaves unproven, for docs/dashboard-browser-check.md: real layout at phone width
// and with a very long name, the caret while the code is regrouped, focus rings, a screen
// reader, and the two-device sign-in with a real Mythicshot.
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { CONNECTIONS_HTML, CONNECTIONS_JS } from "../src/dash/connections.ts";
import { DASH_JS } from "../src/dash/script.ts";
import { FakeDocument, FakeElement, visibleText } from "./pages-dom.ts";

const CSRF = "c".repeat(64);
/** "Now" for the page: 20 November 2026, noon UTC. */
const NOW = Date.UTC(2026, 10, 20, 12);
const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 12);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A date as the page writes it, always with the year, in this process's time zone. */
const shown = (ms: number) => {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};

const FAILED = "Something went wrong. Try again in a moment.";
const TOO_MANY_REQUESTS = "Too many requests. Wait a few minutes and try again.";
const BAD_CODE = "That code does not work. Codes last 10 minutes and work once. Press Sign in in Mythicshot again for a new one.";
const NOT_RELOADED = "The change was made, but the list could not be loaded again. Reload the page to see it.";
const BAD_NAME = "A name is 1 to 60 characters, with no hidden characters.";
const ELSEWHERE = "This request came from a different network than the one you are on now. If you are not sure it is yours, press Not me.";
const WARN = "Confirm only if you pressed Sign in in Mythicshot on this computer just now. It will be able to publish, change and delete everything in this workspace.";
const HINT = "A connection lets Mythicshot on that computer publish, change and delete everything in this workspace. Disconnect one you no longer use or do not recognise.";

type Answer = { status: number; json?: unknown; headers?: Record<string, string> } | "network";
type Fetched = { method: string; path: string; headers: Record<string, string>; body: unknown };
type Responder = (req: Fetched) => Answer | Promise<Answer>;

type Tab = {
  doc: FakeDocument;
  fetched: Fetched[];
  left: () => string | null;
  $: (id: string) => FakeElement;
  shows: () => string[];
  settle: () => Promise<void>;
  /** Runs every timer set so far, and returns their delays. */
  tick: () => number[];
  pendingDelays: () => number[];
  violations: string[];
};

const opened: Tab[] = [];
afterEach(() => {
  for (const tab of opened.splice(0)) {
    expect(tab.violations, "the script used something it must not").toEqual([]);
    // The code never goes into any address.
    for (const f of tab.fetched) expect(f.path, f.path).not.toMatch(/K7QM|2HXD|connect\/requests/i);
  }
});

function openPage(respond: Responder): Tab {
  const doc = new FakeDocument(CONNECTIONS_HTML);
  let left: string | null = null;
  const fetched: Fetched[] = [];
  const pending: Promise<unknown>[] = [];
  const violations: string[] = [];
  let timers: { fn: () => void; ms: number }[] = [];
  const location = {
    replace(path: string) {
      left = path;
    },
  };
  const fetch = (path: string, init: Record<string, unknown> = {}) => {
    const req: Fetched = { method: String(init.method ?? "GET"), path, headers: { ...(init.headers as Record<string, string>) }, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) };
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
  for (const name of ["localStorage", "sessionStorage", "indexedDB", "caches", "cookieStore", "XMLHttpRequest", "WebSocket", "EventSource", "window", "self", "top", "parent", "opener", "open", "postMessage", "setInterval", "console", "alert", "confirm", "prompt", "history", "URL", "Image", "navigator"]) {
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
  vm.runInContext(CONNECTIONS_JS, ctx, { filename: "connections.js" });
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

/** Answers from a table of "<METHOD> <path>" (a list is answered in order, its last one repeated); anything else fails the test. */
function answers(table: Record<string, Answer | Answer[] | ((req: Fetched) => Answer)>): Responder {
  const queues = new Map(Object.entries(table).map(([k, v]) => [k, typeof v === "function" ? v : Array.isArray(v) ? [...v] : [v]]));
  return (req) => {
    const q = queues.get(`${req.method} ${req.path}`);
    if (typeof q === "function") return q(req);
    if (!q || q.length === 0) throw new Error(`unexpected request ${req.method} ${req.path}`);
    return q.length > 1 ? q.shift()! : q[0];
  };
}

/** A responder whose answers to requests matching `held` wait until the test hands them over. */
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
const session: Answer = {
  status: 200,
  json: { account: { id: "usr_1", username: "solex", email: "solex@example.com", admin: false }, workspace: { id: "ws_1", name: "Cowfee Raid Tools" }, session: { id: "ses_1", created_at: NOW, expires_at: NOW }, csrf: CSRF },
};

const T1 = "tok_" + "1".repeat(24);
const T2 = "tok_" + "2".repeat(24);
const T3 = "tok_" + "3".repeat(24);
const T4 = "tok_" + "4".repeat(24);
const token = (id: string, name: string, over: Record<string, unknown> = {}) => ({ id, name, created_at: day(2026, 11, 17), last_used_at: day(2026, 11, 19), kind: "sign_in", ...over });
/** The three computers of mockup 1. */
const MOCKUP = [
  token(T1, "ALEX-DESKTOP", { created_at: day(2026, 11, 20), last_used_at: NOW }),
  token(T2, "Work laptop", { created_at: day(2026, 11, 14), last_used_at: day(2026, 11, 17) }),
  token(T3, "Mythicshot", { kind: "setup", created_at: day(2026, 11, 17), last_used_at: day(2026, 11, 19) }),
];
const list = (tokens: unknown[]): Answer => ({ status: 200, json: { tokens } });
const LOOKUP = "POST /api/v1/connect/lookup";
const found = (over: Record<string, unknown> = {}): Answer => ({ status: 200, json: { device_name: "ALEX-DESKTOP", asked_at: NOW - 2 * 60_000, same_network: true, ...over } });
const DONE: Answer = { status: 204 };
const NO_REQUEST: Answer = { status: 404, json: { error: "not_found" } };
const limited = (seconds?: string): Answer => ({ status: 429, json: { error: "rate_limited" }, headers: seconds === undefined ? {} : { "retry-after": seconds } });

function standard(extra: Record<string, Answer | Answer[] | ((req: Fetched) => Answer)> = {}): Responder {
  return answers({ "GET /api/v1/session": session, "GET /api/v1/tokens": list(MOCKUP), ...extra });
}

const rows = (tab: Tab) => tab.$("connections-rows").children.filter((c): c is FakeElement => c instanceof FakeElement);
const cells = (row: FakeElement) => row.children.filter((c): c is FakeElement => c instanceof FakeElement);
const nameOf = (row: FakeElement) => row.all().find((e) => e.className === "t name")!;
const button = (row: FakeElement, text: string) => row.all().find((e) => e.tagName === "button" && e.textContent === text)!;
const lineOf = (row: FakeElement) => {
  const d = row.all().find((e) => e.className === "d")!;
  const parts = d.children.filter((c): c is FakeElement => c instanceof FakeElement);
  return { wide: parts.filter((p) => p.className !== "narrow-only").map((p) => p.textContent).join(""), narrow: parts.map((p) => p.textContent).join("") };
};
const of = (tab: Tab, method: string, path: string) => tab.fetched.filter((f) => f.method === method && f.path === path);
const key = (el: FakeElement, k: string) => el.dispatch("keydown", { key: k });
const type = (tab: Tab, text: string) => {
  const input = tab.$("connect-code");
  input.value = text;
  input.dispatch("input");
};

/** Opens the page, types `code` and presses Continue. */
async function lookedUp(respond: Responder, code = "k7qm2hxd"): Promise<Tab> {
  const tab = openPage(respond);
  await tab.settle();
  type(tab, code);
  tab.$("connect-go").click();
  await tab.settle();
  return tab;
}

describe("the Connections page: the list", () => {
  it("shows mockup 1: the line, one row per computer with its kind, dates and buttons, and the hint", async () => {
    const tab = openPage(standard());
    await tab.settle();
    expect(tab.left()).toBeNull();
    expect(tab.fetched.map((f) => `${f.method} ${f.path}`)).toEqual(["GET /api/v1/session", "GET /api/v1/tokens"]);
    expect(tab.$("connections-sub").textContent).toBe("The computers where Mythicshot can publish to Cowfee Raid Tools.");
    const r = rows(tab);
    expect(r.map((row) => [nameOf(row).textContent, lineOf(row).wide, cells(row)[1].textContent, cells(row)[2].textContent, cells(row)[3].all().filter((e) => e.tagName === "button").map((b) => [b.textContent, b.className])])).toEqual([
      ["ALEX-DESKTOP", "Signed in from Mythicshot", shown(day(2026, 11, 20)), "Today", [["Rename", "btn sm quiet"], ["Disconnect", "btn sm danger"]]],
      ["Work laptop", "Signed in from Mythicshot", shown(day(2026, 11, 14)), shown(day(2026, 11, 17)), [["Rename", "btn sm quiet"], ["Disconnect", "btn sm danger"]]],
      ["Mythicshot", "From setup", shown(day(2026, 11, 17)), shown(day(2026, 11, 19)), [["Rename", "btn sm quiet"], ["Disconnect", "btn sm danger"]]],
    ]);
    // The mockup's own dates, with the year, this year too.
    expect(cells(r[1])[1].textContent).toMatch(/^1[34] Nov 2026$/);
    // The phone's line (mockup 5).
    expect(lineOf(r[0]).narrow).toBe(`Signed in from Mythicshot · connected ${shown(day(2026, 11, 20))} · last used today`);
    expect(lineOf(r[2]).narrow).toBe(`From setup · connected ${shown(day(2026, 11, 17))} · last used ${shown(day(2026, 11, 19))}`);
    for (const [i, row] of r.entries()) {
      expect(nameOf(row).id).toBe(`conn-${i}`);
      for (const b of row.all().filter((e) => e.tagName === "button")) expect([b.getAttribute("type"), b.getAttribute("aria-describedby")]).toEqual(["button", `conn-${i}`]);
    }
    expect([tab.$("connections-list").shown, tab.$("connections-hint").shown, tab.$("connections-empty").shown]).toEqual([true, true, false]);
    expect(tab.shows()).toEqual([
      "Mythicshot",
      "solex",
      "Connections",
      "The computers where Mythicshot can publish to Cowfee Raid Tools.",
      "Connect Mythicshot",
      "In Mythicshot, open Workspace and press Sign in. Type the code it shows here.",
      // The field's name, for a screen reader only (class vh).
      "Code",
      "Continue",
      "Rename",
      "Disconnect",
      "Rename",
      "Disconnect",
      "Rename",
      "Disconnect",
      HINT,
    ]);
  });

  it("writes Never for a computer never used, and an empty workspace with its own empty state", async () => {
    const tab = openPage(standard({ "GET /api/v1/tokens": list([token(T1, "New PC", { last_used_at: null })]) }));
    await tab.settle();
    expect([cells(rows(tab)[0])[2].textContent, lineOf(rows(tab)[0]).narrow]).toEqual(["Never", `Signed in from Mythicshot · connected ${shown(day(2026, 11, 17))} · last used never`]);

    const none = openPage(standard({ "GET /api/v1/tokens": list([]) }));
    await none.settle();
    expect([none.$("connections-list").shown, none.$("connections-hint").shown, none.$("connections-empty").shown]).toEqual([false, false, true]);
    expect(none.shows().slice(-2)).toEqual(["No computers connected yet", "Install Mythicshot, open Workspace and press Sign in. Then type the code it shows into the box above."]);
  });

  it("names with markup, quotes, control or bidi characters and very long names show as text, exactly", async () => {
    const names = ['<img src=x onerror="alert(1)">', '"quoted" & <b>bold</b>', "evil‮gnp.exe", "tab\there\u0000", "W".repeat(500)];
    const tab = openPage(standard({ "GET /api/v1/tokens": list(names.map((n, i) => token("tok_" + String(i + 1).repeat(24), n))) }));
    await tab.settle();
    expect(rows(tab).map((row) => nameOf(row).textContent)).toEqual(names);
    expect(tab.doc.root.all().filter((e) => e.tagName === "img" || e.tagName === "b" && e.id !== "confirm-device")).toEqual([]);
    for (const row of rows(tab)) expect(nameOf(row).children.every((c) => !(c instanceof FakeElement))).toBe(true);
    // Disconnect asks with the name as text too.
    button(rows(tab)[0], "Disconnect").click();
    expect(tab.$("disconnect-title").textContent).toBe(`Disconnect "${names[0]}"?`);
  });

  it("leaves out entries it cannot trust: an id of another shape, a name that is not text", async () => {
    const tab = openPage(standard({ "GET /api/v1/tokens": list([token("tok_../x", "A"), token(T2, 7 as unknown as string), { ...token(T3, "Good"), created_at: "x" }, token(T4, "Kept")]) }));
    await tab.settle();
    expect(rows(tab).map((row) => nameOf(row).textContent)).toEqual(["Kept"]);
  });

  it("a signed-out visitor is sent to sign in, and asks nothing else", async () => {
    const tab = openPage(answers({ "GET /api/v1/session": SIGNED_OUT }));
    await tab.settle();
    expect(tab.left()).toBe("/signin");
    expect(tab.fetched.map((f) => f.path)).toEqual(["/api/v1/session"]);
    // A session that ends before the list is read: the same.
    const later = openPage(standard({ "GET /api/v1/tokens": SIGNED_OUT }));
    await later.settle();
    expect(later.left()).toBe("/signin");
  });

  it("a list that cannot be read says so and still offers the code box", async () => {
    const tab = openPage(standard({ "GET /api/v1/tokens": { status: 503, json: { error: "unavailable" } } }));
    await tab.settle();
    expect(tab.$("dash-load").textContent).toBe(FAILED);
    expect([tab.$("connections").shown, tab.$("connect-code").shown, tab.$("connections-list").shown, tab.$("connections-empty").shown]).toEqual([true, true, false, false]);
  });
});

describe("the Connections page: connecting with a code", () => {
  it("shows the code upper-cased and grouped as typed, and accepts any case, with or without the dash or spaces", async () => {
    const tab = openPage(standard());
    await tab.settle();
    const input = tab.$("connect-code");
    for (const [typed, show] of [["k", "K"], ["k7qm", "K7QM"], ["k7qm2", "K7QM-2"], ["k7qm 2hxd", "K7QM-2HXD"], [" K7-QM-2H XD ", "K7QM-2HXD"], ["K7QM-2HXD", "K7QM-2HXD"]]) {
      type(tab, typed);
      expect(input.value, typed).toBe(show);
    }
    for (const typed of ["k7qm2hxd", "K7QM-2HXD", "k7qm 2hxd", "  k7QM-2hxD "]) {
      const t = await lookedUp(standard({ [LOOKUP]: found() }), typed);
      expect(of(t, "POST", "/api/v1/connect/lookup").map((f) => [f.body, f.headers["X-Csrf-Token"]]), typed).toEqual([[{ user_code: "K7QM2HXD" }, CSRF]]);
    }
  });

  it("a code with other characters, or of another length, does not work, without any request", async () => {
    for (const typed of ["K7QM-2HX0", "K7QM-2HXI", "K7QM-2HX", "K7QM-2HXDD", "K7QM_2HXD", "K7QM/2HX", "ſ7QM-2HXD", "K7QM-2HXＤ", "%4B7QM2HXD"]) {
      const tab = openPage(standard());
      await tab.settle();
      type(tab, typed);
      tab.$("connect-go").click();
      await tab.settle();
      expect(tab.fetched.map((f) => f.path), typed).toEqual(["/api/v1/session", "/api/v1/tokens"]);
      expect(tab.$("connect-message").textContent, typed).toBe(BAD_CODE);
      expect(tab.$("connect-code").getAttribute("aria-invalid"), typed).toBe("true");
    }
    // An empty field asks nothing and says nothing.
    const empty = openPage(standard());
    await empty.settle();
    empty.$("connect-go").click();
    key(empty.$("connect-code"), "Enter");
    await empty.settle();
    expect([empty.fetched.length, empty.$("connect-message").hidden]).toEqual([2, true]);
  });

  it("the question shows exactly the computer and the time the lookup gave, and the workspace", async () => {
    const tab = await lookedUp(standard({ [LOOKUP]: found() }));
    expect(tab.$("confirm-dialog").shown).toBe(true);
    expect([tab.$("confirm-title").textContent, tab.$("confirm-device").textContent, tab.$("confirm-device").tagName, tab.$("confirm-asked").textContent, tab.$("confirm-workspace").textContent]).toEqual(["Connect this computer?", "ALEX-DESKTOP", "b", "2 minutes ago", "Cowfee Raid Tools"]);
    expect([tab.$("confirm-elsewhere").shown, tab.$("confirm-warn").textContent]).toEqual([false, WARN]);
    expect(tab.doc.activeElement?.id).toBe("confirm-refuse");
    expect(tab.$("connections-page").getAttribute("inert")).toBe("");
    for (const [ago, text] of [[0, "just now"], [59_000, "just now"], [60_000, "1 minute ago"], [119_000, "1 minute ago"], [600_000, "10 minutes ago"], [-5_000, "just now"]] as const) {
      const t = await lookedUp(standard({ [LOOKUP]: found({ asked_at: NOW - ago }) }));
      expect(t.$("confirm-asked").textContent, String(ago)).toBe(text);
    }
    // A name with markup is text; a name over 60 characters is cut at 60, as the server stores names.
    const odd = await lookedUp(standard({ [LOOKUP]: found({ device_name: '<i>"x"</i>‮' }) }));
    expect(odd.$("confirm-device").textContent).toBe('<i>"x"</i>‮');
    const long = await lookedUp(standard({ [LOOKUP]: found({ device_name: "😀".repeat(80) }) }));
    expect(long.$("confirm-device").textContent).toBe("😀".repeat(60));
  });

  it("adds the other-network warning only when the lookup says same_network false", async () => {
    const other = await lookedUp(standard({ [LOOKUP]: found({ same_network: false }) }));
    expect([other.$("confirm-elsewhere").shown, other.$("confirm-elsewhere").textContent]).toEqual([true, ELSEWHERE]);
    expect(other.$("confirm-box").getAttribute("aria-describedby")).toBe("confirm-facts confirm-elsewhere confirm-warn");
    expect(other.shows()).toContain(ELSEWHERE);
    for (const same of [true, undefined]) {
      const t = await lookedUp(standard({ [LOOKUP]: found({ same_network: same }) }));
      expect([t.$("confirm-elsewhere").shown, t.$("confirm-box").getAttribute("aria-describedby")], String(same)).toEqual([false, "confirm-facts confirm-warn"]);
    }
  });

  it("Connect confirms the code that was looked up, once, even after the field changed; then the note, an empty field and the list read again", async () => {
    const h = holding((r) => r.path === "/api/v1/connect/confirm", standard({ [LOOKUP]: found() }));
    const tab = await lookedUp(h.respond);
    type(tab, "ZZZZ-ZZZZ");
    tab.$("confirm-go").click();
    tab.$("confirm-go").click();
    key(tab.$("confirm-go"), "Enter");
    await tab.settle();
    expect(tab.$("confirm-go").textContent).toBe("Connecting…");
    // Escape does nothing while it runs.
    key(tab.$("confirm-go"), "Escape");
    expect(tab.$("confirm-dialog").shown).toBe(true);
    h.answer(DONE);
    await tab.settle();
    expect(of(tab, "POST", "/api/v1/connect/confirm").map((f) => f.body)).toEqual([{ user_code: "K7QM2HXD" }]);
    expect(of(tab, "POST", "/api/v1/connect/refuse")).toEqual([]);
    expect(tab.$("confirm-dialog").shown).toBe(false);
    expect([tab.$("connect-note").shown, tab.$("connect-note").textContent, tab.$("connect-code").value]).toEqual([true, "ALEX-DESKTOP is connected. Mythicshot finishes signing in by itself within a few seconds.", ""]);
    expect(tab.doc.activeElement?.id).toBe("connect-code");
    expect(of(tab, "GET", "/api/v1/tokens")).toHaveLength(2);
  });

  it("after a confirm the list is read again after a few seconds, a bounded number of times, until the new computer shows up, without moving the focus", async () => {
    const lists = [list(MOCKUP), list(MOCKUP), list(MOCKUP), list([token(T4, "NEW-PC", { created_at: NOW, last_used_at: null }), ...MOCKUP])];
    const tab = await lookedUp(standard({ [LOOKUP]: found(), "POST /api/v1/connect/confirm": DONE, "GET /api/v1/tokens": lists }));
    tab.$("confirm-go").click();
    await tab.settle();
    expect(tab.pendingDelays()).toEqual([3000]);
    // The person moves on to a row's Rename; rereads that change nothing leave the rows and the focus alone.
    const before = rows(tab)[1];
    button(before, "Rename").focus();
    expect(tab.tick()).toEqual([3000]);
    await tab.settle();
    expect(rows(tab)[1]).toBe(before);
    expect(tab.pendingDelays()).toEqual([3000]);
    tab.tick();
    await tab.settle();
    expect(rows(tab).map((r) => nameOf(r).textContent)).toEqual(["NEW-PC", "ALEX-DESKTOP", "Work laptop", "Mythicshot"]);
    // Found: no more reads; the focus is on the same control in the new rows, nowhere else.
    expect(tab.pendingDelays()).toEqual([]);
    expect(tab.doc.activeElement).toBe(button(rows(tab)[2], "Rename"));
    expect(of(tab, "GET", "/api/v1/tokens")).toHaveLength(4);

    // When it never shows up: five more reads, then none.
    const never = await lookedUp(standard({ [LOOKUP]: found(), "POST /api/v1/connect/confirm": DONE }));
    never.$("confirm-go").click();
    await never.settle();
    const delays: number[] = [];
    for (let i = 0; i < 10; i++) {
      delays.push(...never.tick());
      await never.settle();
    }
    expect(delays).toEqual([3000, 3000, 4000, 10000, 10000]);
    expect(of(never, "GET", "/api/v1/tokens")).toHaveLength(7);
  });

  it("Escape and a click outside close the question and send nothing, and the code is no longer held", async () => {
    const tab = await lookedUp(standard({ [LOOKUP]: found() }));
    key(tab.$("confirm-go"), "Escape");
    expect(tab.$("confirm-dialog").shown).toBe(false);
    expect(tab.doc.activeElement?.id).toBe("connect-code");
    tab.$("confirm-dialog").dispatch("click");
    tab.$("confirm-go").click();
    await tab.settle();
    const again = await lookedUp(standard({ [LOOKUP]: found() }));
    again.$("confirm-dialog").dispatch("click");
    await again.settle();
    for (const t of [tab, again]) {
      expect(t.$("confirm-dialog").shown).toBe(false);
      expect(t.fetched.filter((f) => /confirm|refuse/.test(f.path))).toEqual([]);
      expect(t.$("connect-code").value).toBe("K7QM-2HXD");
    }
  });

  it("Not me refuses that code, closes the question and empties the field", async () => {
    const tab = await lookedUp(standard({ [LOOKUP]: found(), "POST /api/v1/connect/refuse": DONE }));
    tab.$("confirm-refuse").click();
    await tab.settle();
    expect(of(tab, "POST", "/api/v1/connect/refuse").map((f) => [f.body, f.headers["X-Csrf-Token"]])).toEqual([[{ user_code: "K7QM2HXD" }, CSRF]]);
    expect(of(tab, "POST", "/api/v1/connect/confirm")).toEqual([]);
    expect([tab.$("confirm-dialog").shown, tab.$("connect-code").value, tab.$("connect-note").shown, tab.$("connect-message").shown]).toEqual([false, "", false, false]);
  });

  it("a failed confirm never confirms and keeps the question open; a lost answer watches the list", async () => {
    for (const [answer, text] of [[{ status: 500, json: { error: "internal" } }, FAILED], [{ status: 403, json: { error: "csrf" } }, FAILED], ["network", FAILED]] as [Answer, string][]) {
      const tab = await lookedUp(standard({ [LOOKUP]: found(), "POST /api/v1/connect/confirm": answer }));
      tab.$("confirm-go").click();
      await tab.settle();
      expect([tab.$("confirm-dialog").shown, tab.$("confirm-message").textContent, tab.$("confirm-go").textContent, tab.$("confirm-go").disabled, tab.$("connect-note").shown], String(answer)).toEqual([true, text, "Connect", false, false]);
      expect(of(tab, "POST", "/api/v1/connect/confirm"), String(answer)).toHaveLength(1);
      expect(of(tab, "GET", "/api/v1/tokens").length, String(answer)).toBe(answer === "network" ? 2 : 1);
    }
  });

  it("a code that does not work, from the lookup or from Connect and Not me, says so", async () => {
    const miss = await lookedUp(standard({ [LOOKUP]: NO_REQUEST }));
    expect([miss.$("confirm-dialog").shown, miss.$("connect-message").textContent, miss.$("connect-code").value, miss.doc.activeElement?.id]).toEqual([false, BAD_CODE, "K7QM-2HXD", "connect-code"]);
    // Typing again clears the sentence.
    type(miss, "K7QM-2HX");
    expect(miss.$("connect-message").shown).toBe(false);
    for (const path of ["/api/v1/connect/confirm", "/api/v1/connect/refuse"]) {
      const tab = await lookedUp(standard({ [LOOKUP]: found(), [`POST ${path}`]: NO_REQUEST }));
      tab.$(path.endsWith("confirm") ? "confirm-go" : "confirm-refuse").click();
      await tab.settle();
      expect([tab.$("confirm-dialog").shown, tab.$("connect-message").textContent, tab.$("connect-note").shown], path).toEqual([false, BAD_CODE, false]);
    }
  });

  it("too many codes: the minutes from retry-after, rounded up, and Continue blocked until the time has passed", async () => {
    for (const [seconds, text] of [["600", "10 minutes."], ["540", "9 minutes."], ["61", "2 minutes."], ["60", "1 minute."], ["5", "1 minute."], [undefined, "10 minutes."], ["soon", "10 minutes."]] as const) {
      const tab = await lookedUp(standard({ [LOOKUP]: limited(seconds) }));
      expect(tab.$("connect-message").textContent, String(seconds)).toBe("Too many codes that did not work. Try again in " + text);
      expect(tab.$("connect-go").disabled).toBe(true);
    }
    const tab = await lookedUp(standard({ [LOOKUP]: [limited("540"), found()] }));
    // Nothing gets another lookup out while it rests: the button, Enter, a new code.
    tab.$("connect-go").click();
    key(tab.$("connect-code"), "Enter");
    type(tab, "AAAA-BBBB");
    key(tab.$("connect-code"), "Enter");
    await tab.settle();
    expect(of(tab, "POST", "/api/v1/connect/lookup")).toHaveLength(1);
    expect(tab.$("connect-message").textContent).toBe("Too many codes that did not work. Try again in 9 minutes.");
    expect(tab.tick()).toEqual([540_000]);
    expect([tab.$("connect-go").disabled, tab.$("connect-message").shown]).toEqual([false, false]);
    tab.$("connect-go").click();
    await tab.settle();
    expect(of(tab, "POST", "/api/v1/connect/lookup").map((f) => f.body)).toEqual([{ user_code: "K7QM2HXD" }, { user_code: "AAAABBBB" }]);
    expect(tab.$("confirm-dialog").shown).toBe(true);
    // A 429 to Connect closes the question and rests the same way.
    const late = await lookedUp(standard({ [LOOKUP]: found(), "POST /api/v1/connect/confirm": limited("120") }));
    late.$("confirm-go").click();
    await late.settle();
    expect([late.$("confirm-dialog").shown, late.$("connect-message").textContent, late.$("connect-go").disabled]).toEqual([false, "Too many codes that did not work. Try again in 2 minutes.", true]);
  });

  it("a lookup that fails otherwise says the shared sentence; a signed-out lookup goes to sign in", async () => {
    for (const [answer, text] of [[{ status: 500 }, FAILED], ["network", FAILED], [{ status: 200, json: { device_name: 7, asked_at: NOW } }, FAILED]] as [Answer, string][]) {
      const tab = await lookedUp(standard({ [LOOKUP]: answer }));
      expect([tab.$("confirm-dialog").shown, tab.$("connect-message").textContent, tab.$("connect-go").disabled], String(answer)).toEqual([false, text, false]);
    }
    const out = await lookedUp(standard({ [LOOKUP]: SIGNED_OUT }));
    expect(out.left()).toBe("/signin");
    const outLater = await lookedUp(standard({ [LOOKUP]: found(), "POST /api/v1/connect/confirm": SIGNED_OUT }));
    outLater.$("confirm-go").click();
    await outLater.settle();
    expect(outLater.left()).toBe("/signin");
  });

  it("a second Continue while the lookup runs sends nothing more", async () => {
    const h = holding((r) => r.path === "/api/v1/connect/lookup", standard());
    const tab = openPage(h.respond);
    await tab.settle();
    type(tab, "K7QM2HXD");
    tab.$("connect-go").click();
    key(tab.$("connect-code"), "Enter");
    tab.$("connect-go").click();
    await tab.settle();
    expect([of(tab, "POST", "/api/v1/connect/lookup").length, tab.$("connect-go").disabled, tab.$("connect-go").getAttribute("aria-busy")]).toEqual([1, true, "true"]);
    h.answer(found());
    await tab.settle();
    expect([tab.$("confirm-dialog").shown, tab.$("connect-go").getAttribute("aria-busy")]).toEqual([true, null]);
  });
});

describe("the Connections page: rename and disconnect", () => {
  it("Rename asks with the name prefilled, checks the server's rule first, saves and reads the list again", async () => {
    const renamed = [token(T1, "Desk", { created_at: day(2026, 11, 20), last_used_at: NOW }), ...MOCKUP.slice(1)];
    const tab = openPage(standard({ ["PATCH /api/v1/tokens/" + T1]: { status: 200, json: renamed[0] }, "GET /api/v1/tokens": [list(MOCKUP), list(renamed)] }));
    await tab.settle();
    button(rows(tab)[0], "Rename").click();
    expect([tab.$("rename-dialog").shown, tab.$("rename-title").textContent, tab.$("rename-input").value, tab.doc.activeElement?.id]).toEqual([true, "Rename this connection", "ALEX-DESKTOP", "rename-input"]);
    const input = tab.$("rename-input");
    for (const bad of ["", "   ", "x".repeat(61), "a\u0000b", "a​b", "a‮b", "a b"]) {
      input.value = bad;
      tab.$("rename-save").click();
      await tab.settle();
      expect([tab.$("rename-message").textContent, input.getAttribute("aria-invalid")], JSON.stringify(bad)).toEqual([BAD_NAME, "true"]);
    }
    expect(tab.fetched.filter((f) => f.method === "PATCH")).toEqual([]);
    // 60 characters is fine, counted as characters (an emoji is one).
    input.value = "  Desk  ";
    input.dispatch("input");
    expect(tab.$("rename-message").shown).toBe(false);
    key(input, "Enter");
    tab.$("rename-save").click();
    await tab.settle();
    expect(tab.fetched.filter((f) => f.method === "PATCH").map((f) => [f.path, f.body, f.headers["X-Csrf-Token"]])).toEqual([[`/api/v1/tokens/${T1}`, { name: "Desk" }, CSRF]]);
    expect(tab.$("rename-dialog").shown).toBe(false);
    expect(nameOf(rows(tab)[0]).textContent).toBe("Desk");
    expect(tab.doc.activeElement).toBe(button(rows(tab)[0], "Rename"));
    expect(tab.$("connections-message").shown).toBe(false);
  });

  it("a 60-character name of emoji passes the page's check", async () => {
    const tab = openPage(standard({ ["PATCH /api/v1/tokens/" + T2]: { status: 200, json: MOCKUP[1] } }));
    await tab.settle();
    button(rows(tab)[1], "Rename").click();
    tab.$("rename-input").value = "😀".repeat(60);
    tab.$("rename-save").click();
    await tab.settle();
    expect(tab.fetched.filter((f) => f.method === "PATCH").map((f) => f.body)).toEqual([{ name: "😀".repeat(60) }]);
  });

  it("the list is truthful after a rename that fails: read again, the sentence in the question, which stays open", async () => {
    const changed = [MOCKUP[0], token(T2, "Renamed meanwhile"), MOCKUP[2]];
    for (const [answer, text] of [[{ status: 500 }, FAILED], [{ status: 429 }, TOO_MANY_REQUESTS], ["network", FAILED], [{ status: 400, json: { error: "bad_name" } }, BAD_NAME]] as [Answer, string][]) {
      const tab = openPage(standard({ ["PATCH /api/v1/tokens/" + T2]: answer, "GET /api/v1/tokens": [list(MOCKUP), list(changed)] }));
      await tab.settle();
      button(rows(tab)[1], "Rename").click();
      tab.$("rename-input").value = "Laptop";
      tab.$("rename-save").click();
      await tab.settle();
      expect([tab.$("rename-dialog").shown, tab.$("rename-message").textContent, tab.$("rename-save").textContent, tab.$("rename-save").disabled], String(answer)).toEqual([true, text, "Save", false]);
      expect(nameOf(rows(tab)[1]).textContent, String(answer)).toBe("Renamed meanwhile");
      expect(of(tab, "GET", "/api/v1/tokens"), String(answer)).toHaveLength(2);
    }
    // Gone meanwhile: the question closes, the list loses the row, and the page says why.
    const gone = openPage(standard({ ["PATCH /api/v1/tokens/" + T2]: { status: 404, json: { error: "not_found" } }, "GET /api/v1/tokens": [list(MOCKUP), list([MOCKUP[0], MOCKUP[2]])] }));
    await gone.settle();
    button(rows(gone)[1], "Rename").click();
    gone.$("rename-save").click();
    await gone.settle();
    expect([gone.$("rename-dialog").shown, gone.$("connections-message").textContent, rows(gone).length, gone.doc.activeElement?.id]).toEqual([false, "That connection was already disconnected.", 2, "h-page"]);
  });

  it("Disconnect asks first; Keep it, Escape and a click outside send nothing", async () => {
    const tab = openPage(standard());
    await tab.settle();
    for (const close of [() => tab.$("disconnect-keep").click(), () => key(tab.$("disconnect-go"), "Escape"), () => tab.$("disconnect-dialog").dispatch("click")]) {
      button(rows(tab)[1], "Disconnect").click();
      expect([tab.$("disconnect-dialog").shown, tab.$("disconnect-title").textContent, tab.doc.activeElement?.id]).toEqual([true, 'Disconnect "Work laptop"?', "disconnect-keep"]);
      close();
      expect(tab.$("disconnect-dialog").shown).toBe(false);
      expect(tab.doc.activeElement).toBe(button(rows(tab)[1], "Disconnect"));
    }
    await tab.settle();
    expect(tab.fetched.filter((f) => f.method === "DELETE")).toEqual([]);
  });

  it("Disconnect: 204 and 404 are done, one request for a double click, and the list read again", async () => {
    for (const answer of [DONE, NO_REQUEST]) {
      const h = holding((r) => r.method === "DELETE", standard({ "GET /api/v1/tokens": [list(MOCKUP), list([MOCKUP[0], MOCKUP[2]])] }));
      const tab = openPage(h.respond);
      await tab.settle();
      button(rows(tab)[1], "Disconnect").click();
      tab.$("disconnect-go").click();
      tab.$("disconnect-go").click();
      await tab.settle();
      expect([tab.$("disconnect-go").textContent, rows(tab).flatMap((r) => r.all().filter((e) => e.tagName === "button")).every((b) => b.disabled)]).toEqual(["Disconnecting…", true]);
      h.answer(answer);
      await tab.settle();
      expect(tab.fetched.filter((f) => f.method === "DELETE").map((f) => [f.path, f.headers["X-Csrf-Token"]])).toEqual([[`/api/v1/tokens/${T2}`, CSRF]]);
      expect([tab.$("disconnect-dialog").shown, rows(tab).map((r) => nameOf(r).textContent), tab.doc.activeElement?.id, tab.$("connections-message").shown]).toEqual([false, ["ALEX-DESKTOP", "Mythicshot"], "h-page", false]);
    }
  });

  it("Disconnect that fails: the sentence in the question, and the list read again so it shows what is true", async () => {
    for (const [answer, text] of [[{ status: 500 }, FAILED], [{ status: 429 }, TOO_MANY_REQUESTS]] as [Answer, string][]) {
      const tab = openPage(standard({ ["DELETE /api/v1/tokens/" + T2]: answer }));
      await tab.settle();
      button(rows(tab)[1], "Disconnect").click();
      tab.$("disconnect-go").click();
      await tab.settle();
      expect([tab.$("disconnect-dialog").shown, tab.$("disconnect-message").textContent, tab.$("disconnect-go").disabled, rows(tab).length], String(answer)).toEqual([true, text, false, 3]);
      expect(of(tab, "GET", "/api/v1/tokens")).toHaveLength(2);
    }
  });

  it("Disconnect with no answer: the list decides, and only while it is the whole list", async () => {
    // Not listed any more: done.
    const gone = openPage(standard({ ["DELETE /api/v1/tokens/" + T2]: "network", "GET /api/v1/tokens": [list(MOCKUP), list([MOCKUP[0], MOCKUP[2]])] }));
    await gone.settle();
    button(rows(gone)[1], "Disconnect").click();
    gone.$("disconnect-go").click();
    await gone.settle();
    expect([gone.$("disconnect-dialog").shown, rows(gone).length]).toEqual([false, 2]);
    // Still listed: a failure.
    const still = openPage(standard({ ["DELETE /api/v1/tokens/" + T2]: "network" }));
    await still.settle();
    button(rows(still)[1], "Disconnect").click();
    still.$("disconnect-go").click();
    await still.settle();
    expect([still.$("disconnect-dialog").shown, still.$("disconnect-message").textContent]).toEqual([true, FAILED]);
    // A full list of 200 without it may only have pushed it off the end: a failure.
    const full = Array.from({ length: 200 }, (_, i) => token("tok_" + i.toString(16).padStart(24, "0"), `PC ${i}`));
    const pushed = openPage(standard({ ["DELETE /api/v1/tokens/" + T2]: "network", "GET /api/v1/tokens": [list(MOCKUP), list(full)] }));
    await pushed.settle();
    button(rows(pushed)[1], "Disconnect").click();
    pushed.$("disconnect-go").click();
    await pushed.settle();
    expect([pushed.$("disconnect-dialog").shown, pushed.$("disconnect-message").textContent]).toEqual([true, FAILED]);
    // The list cannot be read either: the read's sentence.
    const blind = openPage(standard({ ["DELETE /api/v1/tokens/" + T2]: "network", "GET /api/v1/tokens": [list(MOCKUP), { status: 429 }] }));
    await blind.settle();
    button(rows(blind)[1], "Disconnect").click();
    blind.$("disconnect-go").click();
    await blind.settle();
    expect([blind.$("disconnect-dialog").shown, blind.$("disconnect-message").textContent, rows(blind).length]).toEqual([true, TOO_MANY_REQUESTS, 3]);
  });

  it("a change that worked whose list cannot be read again says so", async () => {
    const tab = openPage(standard({ ["DELETE /api/v1/tokens/" + T2]: DONE, "GET /api/v1/tokens": [list(MOCKUP), "network"] }));
    await tab.settle();
    button(rows(tab)[1], "Disconnect").click();
    tab.$("disconnect-go").click();
    await tab.settle();
    expect([tab.$("disconnect-dialog").shown, tab.$("connections-message").textContent]).toEqual([false, NOT_RELOADED]);
  });
});
