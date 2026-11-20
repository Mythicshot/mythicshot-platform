// What the Account page's script and the email-change link page's script do when they run:
// the page's document, the shared /dash/dash.js and the page's own script are run in one
// fresh Node `vm` context against a stand-in document built from the page's own HTML
// (test/pages-dom.ts), with a stand-in address bar, history and fetch. The fetch either
// answers from the test, or is handed to the real app on fresh deps as a browser on the app
// address would send it (Origin and Sec-Fetch-Site on changes, the session cookie in a jar).
// Node only: the Workers runtime runs no code from a string.
//
// The account page's tests moved here from test/node-signin-pages.test.ts when /account
// became a dashboard page; the storage block they also covered is the Storage page's now
// (test/node-dash-storage.test.ts).
//
// What this leaves unproven, for docs/dashboard-browser-check.md: real layout, focus rings,
// `inert` as a browser applies it, a screen reader, the browser's own history and cookie.
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { createApp } from "../src/app.ts";
import { ACCOUNT_EMAIL_HTML, ACCOUNT_EMAIL_JS } from "../src/dash/account-email.ts";
import { ACCOUNT_HTML, ACCOUNT_JS } from "../src/dash/account.ts";
import { DASH_JS } from "../src/dash/script.ts";
import type { Deps } from "../src/ports.ts";
import { SESSION_COOKIE, createSignInCode, redeemSignInCode } from "../src/sessions.ts";
import { FakeDocument, FakeElement, visibleText } from "./pages-dom.ts";

const APP = "https://app.example.com";
const CSRF = "c".repeat(64);
const CODE = "dpe_" + "0123456789abcdef0123456789abcdef01234567";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";
const CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
/** "Now" for the page: 19 November 2026, noon UTC, so the day is the same in nearly every time zone. */
const NOW = Date.UTC(2026, 10, 19, 12);
const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 12);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shown = (ms: number) => {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === 2026 ? "" : " " + d.getFullYear()}`;
};

const FAILED = "Something went wrong. Try again in a moment.";
const TOO_MANY = "Too many requests. Wait a few minutes and try again.";
const BAD_EMAIL = "That does not look like an email address.";
const NOT_ENDED = "That session could not be ended. Reload the page.";
const MAIL_OFF_DETAIL = "This site cannot send mail, so an email address cannot be changed here.";
// Proposed, not in the mockups.
const MAIL_OFF_LINE = "This site cannot send mail, so an email address cannot be changed here.";
const HINT = "We send a link to the new address. Your address changes when you open it.";
const BAD_CODE = "This link no longer works. Ask for a new one from your account page.";
// Proposed (review follow-up L3).
const OTHER_ACCOUNT = "If you have more than one account, sign in to the one that asked for the change and open the link again.";

type Answer = { status: number; json?: unknown } | "network";
type Fetched = { method: string; path: string; headers: Record<string, string>; body: string | undefined; init: Record<string, unknown> };
type Responder = (req: Fetched) => Answer | Promise<Answer>;

type Tab = {
  doc: FakeDocument;
  /** In order: "hash" when the fragment is read, "replaceState <url>", "fetch <method> <path>", "replace <path>". */
  log: string[];
  fetched: Fetched[];
  url: () => string;
  history: string[];
  left: () => string | null;
  $: (id: string) => FakeElement;
  shows: () => string[];
  settle: () => Promise<void>;
  key: (k: string, shiftKey?: boolean) => boolean;
  violations: string[];
};

const open: Tab[] = [];
afterEach(() => {
  for (const tab of open.splice(0)) expect(tab.violations, "the script used something it must not").toEqual([]);
});

/** Opens a dashboard page at `url` and runs the shared script and the page's own, in order, as a browser does with two deferred scripts. */
function openPage(html: string, js: string, url: string, respond: Responder): Tab {
  const doc = new FakeDocument(html);
  const log: string[] = [];
  const history = [url];
  let current = new URL(url);
  let left: string | null = null;
  const fetched: Fetched[] = [];
  const pending: Promise<unknown>[] = [];
  const violations: string[] = [];
  const location = {
    get hash() {
      log.push("hash");
      return current.hash;
    },
    get pathname() {
      return current.pathname;
    },
    get search() {
      return current.search;
    },
    get origin() {
      return APP;
    },
    replace(path: string) {
      log.push(`replace ${path}`);
      left = path;
    },
  };
  const historyApi = {
    replaceState(_state: unknown, _title: string, next: string) {
      log.push(`replaceState ${next}`);
      current = new URL(next, current);
      history[history.length - 1] = current.href;
    },
  };
  const fetch = (path: string, init: Record<string, unknown> = {}) => {
    const req: Fetched = { method: String(init.method ?? "GET"), path, headers: { ...(init.headers as Record<string, string>) }, body: init.body as string | undefined, init };
    fetched.push(req);
    log.push(`fetch ${req.method} ${path}`);
    const p = Promise.resolve(respond(req)).then((a) => {
      if (a === "network") throw new TypeError("Failed to fetch");
      const body = a.json === undefined ? null : JSON.stringify(a.json);
      return new Response(a.status === 204 ? null : body, { status: a.status, headers: { "content-type": "application/json" } });
    });
    pending.push(p.catch(() => {}));
    return p;
  };
  const context: Record<string, unknown> = { document: doc, location, history: historyApi, fetch };
  for (const name of ["localStorage", "sessionStorage", "indexedDB", "caches", "cookieStore", "XMLHttpRequest", "WebSocket", "EventSource", "navigator", "window", "self", "top", "parent", "opener", "open", "postMessage", "setTimeout", "setInterval", "console", "alert", "confirm", "prompt"]) {
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
  vm.runInContext(js, ctx, { filename: "page.js" });
  const tab: Tab = {
    doc,
    log,
    fetched,
    url: () => current.href,
    history,
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
    key: (k, shiftKey = false) => (doc.activeElement ?? doc.body).dispatch("keydown", { key: k, shiftKey }).defaultPrevented,
    violations,
  };
  open.push(tab);
  return tab;
}

function answers(table: Record<string, Answer | Answer[]>): Responder {
  const queues = new Map(Object.entries(table).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  return (req) => {
    const q = queues.get(`${req.method} ${req.path}`);
    if (!q || q.length === 0) throw new Error(`unexpected request ${req.method} ${req.path}`);
    return q.length > 1 ? q.shift()! : q[0];
  };
}

function later(): { respond: Responder; answer: (a: Answer) => void } {
  let release: (a: Answer) => void = () => {};
  const p = new Promise<Answer>((r) => (release = r));
  return { respond: () => p, answer: (a) => release(a) };
}

const SIGNED_OUT: Answer = { status: 401, json: { error: "unauthorized" } };

// ---- The Account page ----

type SessionRow = { id: string; label: string; created_at: number; last_used_at: number; expires_at: number; current: boolean };
const ME = "ses_" + "a".repeat(24);
const OTHER = "ses_" + "b".repeat(24);
const THIRD = "ses_" + "c".repeat(24);

function sessionAnswer(o: { username?: string | null; email?: string; workspace?: string; emailChange?: boolean } = {}): Answer {
  return {
    status: 200,
    json: {
      account: { id: "usr_x", username: o.username === undefined ? "solex" : o.username, email: o.email ?? "you@example.com", admin: false },
      workspace: { id: "ws_x", name: o.workspace ?? "Cowfee Raid Tools" },
      session: { id: ME, created_at: day(2026, 11, 2), expires_at: NOW + 1 },
      csrf: CSRF,
      email_change: o.emailChange ?? true,
    },
  };
}
const ROWS: SessionRow[] = [
  { id: ME, label: "Firefox on Linux", created_at: day(2026, 11, 2), last_used_at: NOW, expires_at: NOW + 1, current: true },
  { id: OTHER, label: "Chrome on Windows", created_at: day(2026, 1, 5), last_used_at: day(2026, 11, 18), expires_at: NOW + 1, current: false },
  { id: THIRD, label: "Safari on iOS", created_at: day(2025, 2, 1), last_used_at: day(2025, 3, 3), expires_at: NOW + 1, current: false },
];
const sessionsAnswer = (rows: SessionRow[] = ROWS): Answer => ({ status: 200, json: { sessions: rows } });

function account(more: Record<string, Answer | Answer[]> = {}, base: { session?: Answer; sessions?: Answer } = {}): Tab {
  return openPage(ACCOUNT_HTML, ACCOUNT_JS, `${APP}/account`, answers({ "GET /api/v1/session": base.session ?? sessionAnswer(), "GET /api/v1/sessions": base.sessions ?? sessionsAnswer(), ...more }));
}

const sessionRows = (tab: Tab) => tab.$("sessions").all().filter((e) => e.tagName === "li");
/** Whether the bar and the page behind a dialog are inert and hidden from screen readers (both or neither). */
const inert = (tab: Tab) =>
  [tab.$("dash-top"), tab.$("account-page")].map((e) => {
    expect(e.hasAttribute("inert"), `#${e.id}`).toBe(e.getAttribute("aria-hidden") === "true");
    return e.hasAttribute("inert");
  });

describe("the Account page", () => {
  it("sends a visitor who is not signed in to the sign-in page and shows nothing", async () => {
    const tab = openPage(ACCOUNT_HTML, ACCOUNT_JS, `${APP}/account`, answers({ "GET /api/v1/session": SIGNED_OUT }));
    await tab.settle();
    expect(tab.left()).toBe("/signin");
    expect(tab.$("account").hidden).toBe(true);
    expect(tab.fetched.map((f) => f.path)).toEqual(["/api/v1/session"]);
  });

  it("shows mockup 7: who, the details with Change, and where the account is signed in, in the approved words", async () => {
    const tab = account();
    expect(tab.$("account").hidden).toBe(true);
    await tab.settle();
    expect(tab.left()).toBeNull();
    expect(tab.shows()).toEqual([
      "Mythicshot",
      "solex",
      "Account",
      "Signed in as solex",
      "Your details",
      "Change",
      "Where you are signed in",
      "This browser | Firefox on Linux | since 2 Nov",
      "Chrome on Windows | last used 18 Nov",
      "Sign out",
      "Safari on iOS | last used 3 Mar 2025",
      "Sign out",
      "Sign out",
      "Sign out everywhere",
    ]);
    // The details, row by row.
    const details = tab.$("h-details").parent!.all().filter((e) => e.className === "row" && e.shown);
    expect(details.map((r) => r.textContent)).toEqual(["Usernamesolex", "Email addressyou@example.comChange", "WorkspaceCowfee Raid Tools"]);
    expect(tab.$("email-off").shown).toBe(false);
    // Each row's button names its row for a screen reader, by reference; this browser's row has none.
    const rows = sessionRows(tab);
    expect(rows).toHaveLength(3);
    expect(rows[0].all().some((e) => e.tagName === "button")).toBe(false);
    expect(rows[0].all().find((e) => e.className === "tag ok")!.textContent).toBe("This browser");
    for (const row of rows.slice(1)) {
      const button = row.all().find((e) => e.tagName === "button")!;
      expect([button.getAttribute("type"), button.className]).toEqual(["button", "btn sm quiet"]);
      expect(row.contains(tab.doc.getElementById(button.getAttribute("aria-describedby")!))).toBe(true);
    }
    expect(tab.fetched.map((f) => `${f.method} ${f.path}`)).toEqual(["GET /api/v1/session", "GET /api/v1/sessions"]);
    for (const f of tab.fetched) expect([f.init.credentials, f.headers], f.path).toEqual(["same-origin", {}]);
    expect([tab.$("account-message").hidden, tab.$("dash-load").textContent]).toEqual([true, ""]);
    // The page leaves the address bar alone.
    expect(tab.log.filter((l) => l === "hash" || l.startsWith("replaceState"))).toEqual([]);
  });

  it("with mail off there is no Change button, and the line under the address says why", async () => {
    const tab = account({}, { session: sessionAnswer({ emailChange: false }) });
    await tab.settle();
    expect(tab.$("email-change").shown).toBe(false);
    expect([tab.$("email-off").shown, tab.$("email-off").textContent]).toEqual([true, MAIL_OFF_LINE]);
    expect(tab.shows().slice(4, 6)).toEqual(["Your details", MAIL_OFF_LINE]);
    // A session answer without the flag counts as off.
    const old = account({}, { session: { status: 200, json: { ...(sessionAnswer() as { json: Record<string, unknown> }).json, email_change: undefined } } });
    await old.settle();
    expect([old.$("email-change").shown, old.$("email-off").shown]).toEqual([false, true]);
  });

  it("without a username the line says Signed in and the Username row is not shown", async () => {
    const tab = account({}, { session: sessionAnswer({ username: null }) });
    await tab.settle();
    expect(tab.$("account-who").textContent).toBe("Signed in");
    expect(tab.$("row-username").shown).toBe(false);
    expect(tab.$("dash-user").textContent).toBe("Account");
  });

  it("nothing the server sends becomes markup: a username, a workspace name, an address or a session's label holding markup shows as text", async () => {
    const tab = account(
      {},
      {
        session: sessionAnswer({ username: "<script>x</script>", email: "<b>bold</b>@example.com", workspace: '<img src=x onerror="alert(1)">' }),
        sessions: sessionsAnswer([{ ...ROWS[0], label: "<i>Firefox</i>" }, { ...ROWS[1], label: "<img src=x onerror=alert(1)>" }]),
      },
    );
    await tab.settle();
    expect(tab.$("account-who").textContent).toBe("Signed in as <script>x</script>");
    expect(tab.$("account-username").textContent).toBe("<script>x</script>");
    expect(tab.$("account-email").textContent).toBe("<b>bold</b>@example.com");
    expect(tab.$("account-workspace").textContent).toBe('<img src=x onerror="alert(1)">');
    expect(sessionRows(tab).map((r) => r.textContent)).toEqual(["This browser<i>Firefox</i>since 2 Nov", "<img src=x onerror=alert(1)>last used 18 NovSign out"]);
    expect(tab.doc.root.all().some((e) => ["script", "b", "img", "i"].includes(e.tagName) && e.parent?.tagName !== "head")).toBe(false);
  });

  it("ending another session sends the anti-forgery header and removes its row", async () => {
    const tab = account({ [`DELETE /api/v1/sessions/${OTHER}`]: { status: 204 } });
    await tab.settle();
    const row = sessionRows(tab)[1];
    row.all().find((e) => e.tagName === "button")!.click();
    await tab.settle();
    const del = tab.fetched.find((f) => f.method === "DELETE")!;
    expect([del.path, del.headers, del.body, del.init.credentials]).toEqual([`/api/v1/sessions/${OTHER}`, { "X-Csrf-Token": CSRF }, undefined, "same-origin"]);
    expect(tab.$("sessions").contains(row)).toBe(false);
    expect(sessionRows(tab)).toHaveLength(2);
    expect(tab.$("account-message").hidden).toBe(true);
    expect(tab.left()).toBeNull();
    expect(tab.doc.activeElement?.id).toBe("h-where");
  });

  it("a session that could not be ended keeps its row and says so", async () => {
    for (const answer of [{ status: 404, json: { error: "not_found" } }, { status: 403, json: { error: "bad_csrf" } }, { status: 500, json: {} }, "network"] as Answer[]) {
      const tab = account({ [`DELETE /api/v1/sessions/${OTHER}`]: answer });
      await tab.settle();
      const row = sessionRows(tab)[1];
      const button = row.all().find((e) => e.tagName === "button")!;
      button.click();
      expect([button.textContent, button.disabled]).toEqual(["Signing out…", true]);
      await tab.settle();
      expect([tab.$("account-message").textContent, tab.$("account-message").hidden]).toEqual([NOT_ENDED, false]);
      expect(tab.$("sessions").contains(row)).toBe(true);
      expect([button.textContent, button.disabled]).toEqual(["Sign out", false]);
    }
  });

  it("ending the current session from the list is a sign-out, and so is a 401 on the way", async () => {
    const own = account({ [`DELETE /api/v1/sessions/${ME}`]: { status: 204 } }, { sessions: sessionsAnswer([{ ...ROWS[0], current: false }, ROWS[1]]) });
    await own.settle();
    own.$("sessions").all().filter((e) => e.tagName === "button")[0].click();
    await own.settle();
    expect(own.left()).toBe("/signin");
    const gone = account({ [`DELETE /api/v1/sessions/${OTHER}`]: SIGNED_OUT });
    await gone.settle();
    gone.$("sessions").all().filter((e) => e.tagName === "button")[0].click();
    await gone.settle();
    expect(gone.left()).toBe("/signin");
  });

  it("both sign-outs send the anti-forgery header and end on the sign-in page", async () => {
    for (const [id, path] of [["signout", "/api/v1/signout"], ["signout-everywhere", "/api/v1/signout/everywhere"]]) {
      const server = later();
      const base = answers({ "GET /api/v1/session": sessionAnswer(), "GET /api/v1/sessions": sessionsAnswer() });
      const tab = openPage(ACCOUNT_HTML, ACCOUNT_JS, `${APP}/account`, (req) => (req.method === "POST" ? server.respond(req) : base(req)));
      await tab.settle();
      tab.$(id).click();
      await tab.settle();
      const post = tab.fetched.find((f) => f.method === "POST")!;
      expect([post.path, post.headers, post.body], id).toEqual([path, { "X-Csrf-Token": CSRF }, undefined]);
      expect(tab.$(id).textContent, id).toBe("Signing out…");
      expect(tab.$("signout").disabled && tab.$("signout-everywhere").disabled, id).toBe(true);
      server.answer({ status: 204 });
      await tab.settle();
      expect(tab.left(), id).toBe("/signin");
      expect(tab.log.filter((l) => l.startsWith("replace ")), id).toEqual(["replace /signin"]);
    }
  });

  it("a sign-out that fails says so and gives the buttons back; a 401 is signed out all the same", async () => {
    for (const answer of [{ status: 500, json: {} }, { status: 403, json: { error: "bad_csrf" } }, "network"] as Answer[]) {
      const tab = account({ "POST /api/v1/signout": answer });
      await tab.settle();
      tab.$("signout").click();
      await tab.settle();
      expect([tab.$("account-message").textContent, tab.$("account-message").hidden]).toEqual([FAILED, false]);
      expect(tab.$("signout").textContent).toBe("Sign out");
      expect(tab.$("signout").disabled || tab.$("signout-everywhere").disabled).toBe(false);
      expect(tab.left()).toBeNull();
      expect(tab.doc.activeElement?.id).toBe("signout");
    }
    const ended = account({ "POST /api/v1/signout/everywhere": SIGNED_OUT });
    await ended.settle();
    ended.$("signout-everywhere").click();
    await ended.settle();
    expect(ended.left()).toBe("/signin");
  });

  it("a session answer without its session part is a failure, as the old account page had it", async () => {
    const full = (sessionAnswer() as { json: Record<string, unknown> }).json;
    for (const part of [undefined, null, "ses_x"]) {
      const tab = account({}, { session: { status: 200, json: { ...full, session: part } } });
      await tab.settle();
      expect(tab.$("dash-load").textContent, String(part)).toBe(FAILED);
      expect(tab.$("account").hidden, String(part)).toBe(true);
      expect(tab.fetched.map((f) => f.path), String(part)).toEqual(["/api/v1/session"]);
      expect(tab.$("dash-user").textContent, String(part)).toBe("");
    }
  });

  it("when the session cannot be read the page says so; when the list cannot, the page shows the rest and says so", async () => {
    const broken = openPage(ACCOUNT_HTML, ACCOUNT_JS, `${APP}/account`, answers({ "GET /api/v1/session": "network" }));
    await broken.settle();
    expect(broken.shows()).toEqual(["Mythicshot", FAILED, "Account"]);
    expect(broken.$("account").hidden).toBe(true);
    expect(broken.left()).toBeNull();
    for (const [sessions, text] of [[{ status: 500, json: {} }, FAILED], ["network", FAILED], [{ status: 429, json: { error: "rate_limited" } }, TOO_MANY], [{ status: 200, json: { sessions: "x" } }, FAILED]] as [Answer, string][]) {
      const tab = account({}, { sessions });
      await tab.settle();
      expect(tab.$("account").hidden).toBe(false);
      expect([tab.$("account-message").textContent, tab.$("account-message").hidden]).toEqual([text, false]);
      expect(tab.$("account-who").textContent).toBe("Signed in as solex");
    }
    const out = account({}, { sessions: SIGNED_OUT });
    await out.settle();
    expect(out.left()).toBe("/signin");
  });
});

// ---- Changing the email address: mockup 8's first two boxes ----

describe("changing the email address from the Account page", () => {
  it("Change opens the question: the field has the focus, the page behind is inert, Tab stays inside, and Escape, Cancel and the backdrop close it with the focus back on Change", async () => {
    const tab = account();
    await tab.settle();
    const change = tab.$("email-change");
    const dialog = tab.$("change-dialog");
    expect(inert(tab)).toEqual([false, false]);
    change.click();
    expect(dialog.shown).toBe(true);
    expect(tab.shows().slice(-5)).toEqual(["Change your email address", "New email address", HINT, "Cancel", "Send the link"]);
    expect(tab.doc.activeElement).toBe(tab.$("change-email"));
    expect(inert(tab)).toEqual([true, true]);
    // Tab and Shift+Tab go round the field and the two buttons, handled for the whole document.
    expect(tab.key("Tab")).toBe(true);
    expect(tab.doc.activeElement).toBe(tab.$("change-cancel"));
    expect(tab.key("Tab")).toBe(true);
    expect(tab.doc.activeElement).toBe(tab.$("change-send"));
    expect(tab.key("Tab")).toBe(true);
    expect(tab.doc.activeElement).toBe(tab.$("change-email"));
    expect(tab.key("Tab", true)).toBe(true);
    expect(tab.doc.activeElement).toBe(tab.$("change-send"));
    tab.doc.activeElement = tab.doc.body;
    expect(tab.key("Tab")).toBe(true);
    expect(tab.doc.activeElement).toBe(tab.$("change-email"));
    // Escape closes it from anywhere.
    tab.doc.activeElement = tab.doc.body;
    expect(tab.key("Escape")).toBe(true);
    expect(dialog.shown).toBe(false);
    expect(inert(tab)).toEqual([false, false]);
    expect(tab.doc.activeElement).toBe(change);
    // Closed, the page's keys are its own again.
    expect(tab.key("Tab")).toBe(false);
    // Cancel closes it, and what was typed is gone next time.
    change.click();
    tab.$("change-email").value = "half@exa";
    tab.$("change-cancel").click();
    expect([dialog.shown, tab.doc.activeElement]).toEqual([false, change]);
    change.click();
    expect(tab.$("change-email").value).toBe("");
    // A click inside the question does not close it; one on the backdrop does.
    tab.$("change-hint").click();
    expect(dialog.shown).toBe(true);
    dialog.click();
    expect([dialog.shown, tab.doc.activeElement]).toEqual([false, change]);
    expect(inert(tab)).toEqual([false, false]);
    expect(tab.fetched.filter((f) => f.method !== "GET")).toEqual([]);
  });

  it("refuses what is not an address without asking the server", async () => {
    const tab = account();
    await tab.settle();
    tab.$("email-change").click();
    for (const value of ["", "   ", "name", "name@", "@example.com", "two words@example.com", "a@b@example.com", "x".repeat(250) + "@e.co"]) {
      tab.$("change-email").value = value;
      tab.$("change-send").click();
      await tab.settle();
      expect([tab.$("change-message").textContent, tab.$("change-message").hidden], value).toEqual([BAD_EMAIL, false]);
      expect(tab.$("change-email").getAttribute("aria-invalid"), value).toBe("true");
      expect(tab.doc.activeElement?.id, value).toBe("change-email");
    }
    expect(tab.fetched.filter((f) => f.method === "POST")).toEqual([]);
    // Closing and opening again clears the message and the mark.
    tab.$("change-cancel").click();
    tab.$("email-change").click();
    expect([tab.$("change-message").hidden, tab.$("change-email").hasAttribute("aria-invalid")]).toEqual([true, false]);
  });

  it("Send the link posts the address with the anti-forgery header, holds the focus while it runs, then shows mockup 8's second box naming the current address", async () => {
    const server = later();
    const base = answers({ "GET /api/v1/session": sessionAnswer(), "GET /api/v1/sessions": sessionsAnswer() });
    const tab = openPage(ACCOUNT_HTML, ACCOUNT_JS, `${APP}/account`, (req) => (req.method === "POST" ? server.respond(req) : base(req)));
    await tab.settle();
    tab.$("email-change").click();
    tab.$("change-email").value = "  New@Example.COM ";
    tab.$("change-send").click();
    await tab.settle();
    const post = tab.fetched.find((f) => f.method === "POST")!;
    // The address goes as typed, trimmed; the server makes it lower-case.
    expect([post.path, post.headers, JSON.parse(post.body!), post.init.credentials, post.init.referrerPolicy]).toEqual(["/api/v1/account/email", { "content-type": "application/json", "X-Csrf-Token": CSRF }, { email: "New@Example.COM" }, "same-origin", "no-referrer"]);
    // While it runs: the busy label, nothing can be pressed twice, nothing closes it, and Tab keeps the focus inside.
    expect([tab.$("change-send").textContent, tab.$("change-send").disabled, tab.$("change-cancel").disabled, tab.$("change-email").disabled, tab.$("change-send").getAttribute("aria-busy")]).toEqual(["Sending…", true, true, true, "true"]);
    expect(tab.$("change-send").click()).toBeNull();
    tab.$("change-email").dispatch("keydown", { key: "Enter" });
    tab.key("Escape");
    tab.$("change-dialog").click();
    expect(tab.$("change-dialog").shown).toBe(true);
    tab.doc.activeElement = tab.doc.body;
    expect(tab.key("Tab")).toBe(true);
    expect(tab.$("change-dialog").contains(tab.doc.activeElement)).toBe(true);
    expect(tab.fetched.filter((f) => f.method === "POST")).toHaveLength(1);
    server.answer({ status: 200, json: { ok: true } });
    await tab.settle();
    expect(tab.$("change-dialog").shown).toBe(false);
    expect(tab.$("sent-dialog").shown).toBe(true);
    // The second box names the address as the server stores it: trimmed and lower-case.
    expect(tab.shows().slice(-3)).toEqual(["Check new@example.com", "Open the link we sent there to finish. It works once and for 15 minutes. Until then you keep signing in with you@example.com.", "Done"]);
    expect(tab.doc.activeElement).toBe(tab.$("sent-done"));
    expect(inert(tab)).toEqual([true, true]);
    // Tab stays on Done.
    expect(tab.key("Tab")).toBe(true);
    expect(tab.doc.activeElement).toBe(tab.$("sent-done"));
    expect(tab.key("Tab", true)).toBe(true);
    expect(tab.doc.activeElement).toBe(tab.$("sent-done"));
    // Done closes it; nothing on the page has changed: the address changes only when the link is opened.
    tab.$("sent-done").click();
    expect([tab.$("sent-dialog").shown, tab.doc.activeElement]).toEqual([false, tab.$("email-change")]);
    expect(inert(tab)).toEqual([false, false]);
    expect(tab.$("account-email").textContent).toBe("you@example.com");
    expect([tab.$("change-send").textContent, tab.$("change-send").disabled, tab.$("change-email").disabled]).toEqual(["Send the link", false, false]);
    // Escape and the backdrop close the second box too.
    for (const close of [() => tab.key("Escape"), () => tab.$("sent-dialog").click()]) {
      tab.$("email-change").click();
      tab.$("change-email").value = "new@example.com";
      tab.$("change-send").click();
      server.answer({ status: 200, json: { ok: true } });
      await tab.settle();
      expect(tab.$("sent-dialog").shown).toBe(true);
      close();
      expect([tab.$("sent-dialog").shown, tab.doc.activeElement]).toEqual([false, tab.$("email-change")]);
    }
  });

  it("Enter in the field sends, and the address typed is shown as text", async () => {
    const hostile = 'x<img/src=x/onerror=alert(1)>@example.com';
    const tab = account({ "POST /api/v1/account/email": { status: 200, json: { ok: true } } }, { session: sessionAnswer({ email: "<b>old</b>@example.com" }) });
    await tab.settle();
    tab.$("email-change").click();
    tab.$("change-email").value = hostile;
    expect(tab.$("change-email").dispatch("keydown", { key: "Enter" }).defaultPrevented).toBe(true);
    await tab.settle();
    expect(JSON.parse(tab.fetched.find((f) => f.method === "POST")!.body!)).toEqual({ email: hostile });
    expect(tab.$("sent-title").textContent).toBe(`Check ${hostile}`);
    expect(tab.$("sent-old").textContent).toBe("<b>old</b>@example.com");
    expect(tab.doc.root.all().some((e) => e.tagName === "img" || e.tagName === "b")).toBe(false);
  });

  it("says why when the server refuses, keeps the question open and gives the buttons back", async () => {
    const cases: [Answer, string, boolean][] = [
      [{ status: 400, json: { error: "bad_email" } }, BAD_EMAIL, true],
      [{ status: 429, json: { error: "rate_limited", detail: "Too many requests. Wait a few minutes and try again." } }, TOO_MANY, false],
      [{ status: 409, json: { error: "mail_off", detail: MAIL_OFF_DETAIL } }, MAIL_OFF_DETAIL, false],
      [{ status: 409, json: { error: "mail_off" } }, FAILED, false],
      [{ status: 403, json: { error: "bad_csrf", detail: "<b>x</b>" } }, FAILED, false],
      [{ status: 500, json: { error: "internal" } }, FAILED, false],
      ["network", FAILED, false],
    ];
    for (const [answer, words, field] of cases) {
      const tab = account({ "POST /api/v1/account/email": answer });
      await tab.settle();
      tab.$("email-change").click();
      tab.$("change-email").value = "new@example.com";
      tab.$("change-send").click();
      await tab.settle();
      const what = JSON.stringify(answer);
      expect([tab.$("change-message").textContent, tab.$("change-message").hidden], what).toEqual([words, false]);
      expect(tab.$("change-dialog").shown, what).toBe(true);
      expect(tab.$("sent-dialog").shown, what).toBe(false);
      expect([tab.$("change-send").textContent, tab.$("change-send").disabled, tab.$("change-cancel").disabled, tab.$("change-email").disabled], what).toEqual(["Send the link", false, false, false]);
      expect(tab.$("change-email").getAttribute("aria-invalid"), what).toBe(field ? "true" : null);
      expect(tab.doc.activeElement?.id, what).toBe(field ? "change-email" : "change-send");
      expect(inert(tab), what).toEqual([true, true]);
    }
    const out = account({ "POST /api/v1/account/email": SIGNED_OUT });
    await out.settle();
    out.$("email-change").click();
    out.$("change-email").value = "new@example.com";
    out.$("change-send").click();
    await out.settle();
    expect(out.left()).toBe("/signin");
  });
});

// ---- The page the link opens: mockup 8's third box ----

function linkPage(url: string, respond: Responder): Tab {
  return openPage(ACCOUNT_EMAIL_HTML, ACCOUNT_EMAIL_JS, url, respond);
}
const confirmed = (email = "new@example.com", previous = "you@example.com"): Answer => ({ status: 200, json: { email, previous_email: previous } });
const states = (tab: Tab) => ["confirm", "first", "done", "dead"].filter((id) => tab.$(id).shown);

describe("the page an email-change link opens", () => {
  it("reads the code, cleans the address bar before anything else, asks only who is signed in, and changes nothing until the press", async () => {
    const tab = linkPage(`${APP}/account/email#c=${CODE}`, answers({ "GET /api/v1/session": sessionAnswer() }));
    expect(tab.log.slice(0, 2)).toEqual(["hash", "replaceState /account/email"]);
    expect(tab.url()).toBe(`${APP}/account/email`);
    expect(tab.history).toEqual([`${APP}/account/email`]);
    await tab.settle();
    expect(tab.fetched.map((f) => `${f.method} ${f.path}`)).toEqual(["GET /api/v1/session"]);
    expect(states(tab)).toEqual(["confirm"]);
    expect(tab.shows()).toEqual(["Mythicshot", "solex", "Confirm your new email address", "Press the button to make this your Mythicshot email address.", "Confirm"]);
    // Nothing of the code is on the page or in any request so far.
    expect(tab.doc.root.all().some((e) => e.textContent.includes(CODE) || [...e.attrs.values()].some((v) => v.includes(CODE)))).toBe(false);
    expect(JSON.stringify(tab.fetched)).not.toContain(CODE.slice(4));
  });

  it("sends the code once, in the confirm request's body with the anti-forgery header, and shows mockup 8's third box", async () => {
    const server = later();
    const base = answers({ "GET /api/v1/session": sessionAnswer() });
    const tab = linkPage(`${APP}/account/email?x=1#c=${CODE}`, (req) => (req.method === "POST" ? server.respond(req) : base(req)));
    expect(tab.url()).toBe(`${APP}/account/email?x=1`);
    await tab.settle();
    tab.$("confirm-button").click();
    await tab.settle();
    const posts = tab.fetched.filter((f) => f.method === "POST");
    expect(posts.map((f) => [f.path, f.headers, JSON.parse(f.body!), f.init.credentials, f.init.referrerPolicy])).toEqual([["/api/v1/account/email/confirm", { "content-type": "application/json", "X-Csrf-Token": CSRF }, { code: CODE }, "same-origin", "no-referrer"]]);
    // The code goes nowhere else: not in a path or a header of any request.
    for (const f of tab.fetched) expect(f.path + JSON.stringify(f.headers), f.path).not.toContain(CODE.slice(4));
    expect([tab.$("confirm-button").textContent, tab.$("confirm-button").disabled]).toEqual(["Confirming…", true]);
    expect(tab.$("confirm-button").click()).toBeNull();
    server.answer(confirmed());
    await tab.settle();
    expect(states(tab)).toEqual(["done"]);
    expect(tab.shows()).toEqual(["Mythicshot", "solex", "Your email address is now new@example.com", "Sign-in links go to this address from now on. We sent a notice to you@example.com."]);
    expect([tab.$("done-back").getAttribute("href"), tab.$("done-back").textContent]).toEqual(["/account", "Back to your account"]);
    expect(tab.doc.activeElement?.id).toBe("h-done");
    // The code is forgotten: the hidden button, pressed by any means, sends nothing.
    tab.$("confirm-button").dispatch("click");
    await tab.settle();
    expect(tab.fetched.filter((f) => f.method === "POST")).toHaveLength(1);
    expect(tab.left()).toBeNull();
  });

  it("a used, expired, replaced or unknown code shows the server's sentence with the way back to the account page, and is forgotten", async () => {
    const tab = linkPage(`${APP}/account/email#c=${CODE}`, answers({ "GET /api/v1/session": sessionAnswer(), "POST /api/v1/account/email/confirm": { status: 400, json: { error: "bad_code", detail: BAD_CODE } } }));
    await tab.settle();
    tab.$("confirm-button").click();
    await tab.settle();
    expect(states(tab)).toEqual(["dead"]);
    expect(tab.shows()).toEqual(["Mythicshot", "solex", "Confirm your new email address", BAD_CODE, OTHER_ACCOUNT]);
    expect(tab.$("dead").all().filter((e) => e.tagName === "a").map((a) => [a.getAttribute("href"), a.textContent])).toEqual([["/account", "Back to your account"]]);
    expect(tab.doc.activeElement?.id).toBe("h-dead");
    expect(tab.$("confirm-button").disabled).toBe(false);
    tab.$("confirm-button").dispatch("click");
    await tab.settle();
    expect(tab.fetched.filter((f) => f.method === "POST")).toHaveLength(1);
  });

  it("a page opened without a code, or with one that is not one, shows the dead link at once and asks nothing", async () => {
    const urls = [
      `${APP}/account/email`,
      `${APP}/account/email#`,
      `${APP}/account/email#c=`,
      `${APP}/account/email#c=abc`,
      `${APP}/account/email#c=${CODE.toUpperCase()}`,
      `${APP}/account/email#c=${CODE}0`,
      `${APP}/account/email#c=${CODE}&x=1`,
      `${APP}/account/email#code=${CODE}`,
      `${APP}/account/email#c=dpl_${"0".repeat(40)}`,
    ];
    for (const url of urls) {
      const tab = linkPage(url, answers({}));
      await tab.settle();
      expect(states(tab), url).toEqual(["dead"]);
      expect(tab.fetched, url).toEqual([]);
      expect(tab.url(), url).not.toMatch(/#.+/);
      expect(tab.history.join(" "), url).not.toContain("c=");
      expect(tab.doc.activeElement?.id, url).toBe("h-dead");
      tab.$("confirm-button").dispatch("click");
      await tab.settle();
      expect(tab.fetched, url).toEqual([]);
    }
  });

  it("a visitor who is not signed in is told to sign in first; the code is never sent, and the button goes to the sign-in page", async () => {
    const tab = linkPage(`${APP}/account/email#c=${CODE}`, answers({ "GET /api/v1/session": SIGNED_OUT }));
    await tab.settle();
    expect(tab.url()).toBe(`${APP}/account/email`);
    expect(states(tab)).toEqual(["first"]);
    expect(tab.shows()).toEqual(["Mythicshot", "Sign in first", "Sign in with your current email address, then open the link from your mail again.", "Sign in"]);
    expect(tab.doc.activeElement?.id).toBe("h-first");
    expect(tab.left()).toBeNull();
    tab.$("confirm-button").dispatch("click");
    await tab.settle();
    expect(tab.fetched.map((f) => `${f.method} ${f.path}`)).toEqual(["GET /api/v1/session"]);
    tab.$("first-button").click();
    expect(tab.left()).toBe("/signin");
    // A session that ends before the press: the same state.
    const late = linkPage(`${APP}/account/email#c=${CODE}`, answers({ "GET /api/v1/session": sessionAnswer(), "POST /api/v1/account/email/confirm": SIGNED_OUT }));
    await late.settle();
    late.$("confirm-button").click();
    await late.settle();
    expect(states(late)).toEqual(["first"]);
    expect(late.left()).toBeNull();
  });

  it("too many tries or a failure keeps the code for another press, with the approved sentences", async () => {
    const tab = linkPage(
      `${APP}/account/email#c=${CODE}`,
      answers({ "GET /api/v1/session": sessionAnswer(), "POST /api/v1/account/email/confirm": [{ status: 429, json: { error: "rate_limited" } }, "network", { status: 500, json: { error: "internal" } }, { status: 200, json: { email: 5 } }, confirmed()] }),
    );
    await tab.settle();
    for (const words of [TOO_MANY, FAILED, FAILED, FAILED]) {
      tab.$("confirm-button").click();
      await tab.settle();
      expect([tab.$("confirm-message").textContent, tab.$("confirm-message").hidden]).toEqual([words, false]);
      expect([tab.$("confirm-button").textContent, tab.$("confirm-button").disabled]).toEqual(["Confirm", false]);
      expect(tab.doc.activeElement?.id).toBe("confirm-button");
      expect(states(tab)).toEqual(["confirm"]);
    }
    tab.$("confirm-button").click();
    await tab.settle();
    expect(states(tab)).toEqual(["done"]);
    expect(tab.fetched.filter((f) => f.method === "POST").map((f) => JSON.parse(f.body!).code)).toEqual([CODE, CODE, CODE, CODE, CODE]);
  });

  it("a confirm whose answer was lost keeps the code; when the retry is refused but the address did change, the page says it is done", async () => {
    const tab = linkPage(
      `${APP}/account/email#c=${CODE}`,
      answers({
        "GET /api/v1/session": [sessionAnswer(), sessionAnswer({ email: "new@example.com" })],
        "POST /api/v1/account/email/confirm": ["network", { status: 400, json: { error: "bad_code", detail: BAD_CODE } }],
      }),
    );
    await tab.settle();
    tab.$("confirm-button").click();
    await tab.settle();
    // No answer came: the general sentence, and the code kept for another press.
    expect([tab.$("confirm-message").textContent, states(tab)]).toEqual([FAILED, ["confirm"]]);
    tab.$("confirm-button").click();
    await tab.settle();
    // The first press did go through: the session now has the new address.
    expect(states(tab)).toEqual(["done"]);
    expect(tab.shows()).toEqual(["Mythicshot", "solex", "Your email address is now new@example.com", "Sign-in links go to this address from now on. We sent a notice to you@example.com."]);
    expect(tab.fetched.map((f) => `${f.method} ${f.path}`)).toEqual(["GET /api/v1/session", "POST /api/v1/account/email/confirm", "POST /api/v1/account/email/confirm", "GET /api/v1/session"]);
    expect(tab.doc.activeElement?.id).toBe("h-done");
  });

  it("a retry after a lost answer that is refused, with the address unchanged or not readable, is the dead link; a refusal with no lost answer asks nothing more", async () => {
    for (const second of [sessionAnswer(), SIGNED_OUT, "network", { status: 500, json: {} }] as Answer[]) {
      const tab = linkPage(
        `${APP}/account/email#c=${CODE}`,
        answers({ "GET /api/v1/session": [sessionAnswer(), second], "POST /api/v1/account/email/confirm": ["network", { status: 400, json: { error: "bad_code" } }] }),
      );
      await tab.settle();
      tab.$("confirm-button").click();
      await tab.settle();
      tab.$("confirm-button").click();
      await tab.settle();
      expect(states(tab), JSON.stringify(second)).toEqual(["dead"]);
    }
    const plain = linkPage(`${APP}/account/email#c=${CODE}`, answers({ "GET /api/v1/session": sessionAnswer(), "POST /api/v1/account/email/confirm": { status: 400, json: { error: "bad_code" } } }));
    await plain.settle();
    plain.$("confirm-button").click();
    await plain.settle();
    expect(states(plain)).toEqual(["dead"]);
    expect(plain.fetched.filter((f) => f.path === "/api/v1/session")).toHaveLength(1);
  });

  it("against the real app: the confirm went through but its answer was lost; the retry shows that the address is changed", async () => {
    const made = await makeDeps(TWO);
    const { deps, mail } = made;
    await seedAccount(deps, { admin: true, username: "acct-admin" });
    const owner = await seedAccount(deps, { username: "solex" });
    const me = browser(deps);
    await me.signIn(owner.userId);
    const page = me.account();
    await page.settle();
    page.$("email-change").click();
    page.$("change-email").value = "solex.new@example.com";
    page.$("change-send").click();
    await page.settle();
    await made.settle();
    const link = /https:\/\/app\.example\.com\/account\/email#c=dpe_[0-9a-f]{40}/.exec(mail.sent[0].text)![0];
    // A browser whose first confirm reaches the server but whose answer never arrives.
    const app = createApp(deps);
    let lose = true;
    const respond: Responder = async (req) => {
      const headers: Record<string, string> = { ...req.headers, "user-agent": FIREFOX, cookie: me.jar.cookie! };
      if (req.method !== "GET") Object.assign(headers, { origin: APP, "sec-fetch-site": "same-origin" });
      const res = await app.fetch(new Request(APP + req.path, { method: req.method, headers, body: req.body }));
      const text = await res.text();
      if (req.method === "POST" && lose) {
        lose = false;
        return "network";
      }
      return { status: res.status, json: text === "" ? undefined : JSON.parse(text) };
    };
    const tab = linkPage(link, respond);
    await tab.settle();
    tab.$("confirm-button").click();
    await tab.settle();
    await made.settle();
    expect(tab.$("confirm-message").textContent).toBe(FAILED);
    expect(await emailOf(deps, owner.userId)).toBe("solex.new@example.com");
    tab.$("confirm-button").click();
    await tab.settle();
    expect(states(tab)).toEqual(["done"]);
    expect(tab.$("h-done").textContent).toBe("Your email address is now solex.new@example.com");
    expect(tab.$("done-old").textContent).toBe(owner.email);
  });

  it("when who is signed in cannot be read, the page says so and shows no state", async () => {
    const tab = linkPage(`${APP}/account/email#c=${CODE}`, answers({ "GET /api/v1/session": "network" }));
    await tab.settle();
    expect(states(tab)).toEqual([]);
    expect(tab.$("dash-load").textContent).toBe(FAILED);
  });

  it("addresses holding markup show as text", async () => {
    const tab = linkPage(`${APP}/account/email#c=${CODE}`, answers({ "GET /api/v1/session": sessionAnswer(), "POST /api/v1/account/email/confirm": confirmed("<b>n</b>@example.com", '<img src=x onerror="alert(1)">@example.com') }));
    await tab.settle();
    tab.$("confirm-button").click();
    await tab.settle();
    expect(tab.$("h-done").textContent).toBe("Your email address is now <b>n</b>@example.com");
    expect(tab.$("done-old").textContent).toBe('<img src=x onerror="alert(1)">@example.com');
    expect(tab.doc.root.all().some((e) => e.tagName === "img" || e.tagName === "b")).toBe(false);
  });
});

// ---- Against the real app ----

/** A browser on the app address whose fetch goes to the real app, with one cookie jar for all its tabs. */
function browser(deps: Deps, agent = FIREFOX) {
  const jar = { cookie: null as string | null };
  const app = createApp(deps);
  const respond: Responder = async (req) => {
    const headers: Record<string, string> = { ...req.headers, "user-agent": agent };
    if (req.method !== "GET" && req.method !== "HEAD") Object.assign(headers, { origin: APP, "sec-fetch-site": "same-origin" });
    if (jar.cookie !== null) headers.cookie = jar.cookie;
    const res = await app.fetch(new Request(APP + req.path, { method: req.method, headers, body: req.body }));
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      jar.cookie = /Max-Age=0/.test(c) ? null : pair;
    }
    const text = await res.text();
    return { status: res.status, json: text === "" ? undefined : JSON.parse(text) };
  };
  return {
    jar,
    async signIn(userId: string) {
      const made = await redeemSignInCode(deps, await createSignInCode(deps, userId), agent, null);
      jar.cookie = `${SESSION_COOKIE}=${made!.secret}`;
      return made!;
    },
    account: () => openPage(ACCOUNT_HTML, ACCOUNT_JS, `${APP}/account`, respond),
    link: (url: string) => openPage(ACCOUNT_EMAIL_HTML, ACCOUNT_EMAIL_JS, url, respond),
  };
}

const TWO = { hosts: { tours: "tours.example.com", app: "app.example.com" } };
const emailOf = async (deps: Deps, userId: string) => (await deps.db.first<{ email: string }>("SELECT email FROM user WHERE id = ?", [userId]))!.email;

describe("the Account page and the link page against the real app", () => {
  it("changes the address end to end: Change, the link mailed to the new address, the press, and the notice to the old one", async () => {
    const made = await makeDeps(TWO);
    const { deps, mail } = made;
    await seedAccount(deps, { admin: true, username: "acct-admin" });
    const owner = await seedAccount(deps, { username: "solex" });
    const me = browser(deps);
    await me.signIn(owner.userId);

    const page = me.account();
    await page.settle();
    expect(page.$("account-email").textContent).toBe(owner.email);
    expect(page.$("email-change").shown).toBe(true);
    page.$("email-change").click();
    page.$("change-email").value = "Solex.New@Example.com";
    page.$("change-send").click();
    await page.settle();
    await made.settle();
    expect(page.$("sent-title").textContent).toBe("Check solex.new@example.com");
    expect(page.$("sent-old").textContent).toBe(owner.email);
    expect(mail.sent.map((m) => m.to)).toEqual(["solex.new@example.com"]);
    expect(mail.sent[0].text).toContain("It works once and for 15 minutes, and you need to be signed in to that Mythicshot account when you open it.");
    const link = /https:\/\/app\.example\.com\/account\/email#c=dpe_[0-9a-f]{40}/.exec(mail.sent[0].text)![0];
    // Nothing has changed yet.
    expect(await emailOf(deps, owner.userId)).toBe(owner.email);

    const opened = me.link(link);
    expect(opened.url()).toBe(`${APP}/account/email`);
    await opened.settle();
    expect(opened.fetched.map((f) => `${f.method} ${f.path}`)).toEqual(["GET /api/v1/session"]);
    expect(await emailOf(deps, owner.userId)).toBe(owner.email);
    opened.$("confirm-button").click();
    await opened.settle();
    await made.settle();
    expect(opened.shows().slice(-2)).toEqual(["Your email address is now solex.new@example.com", `Sign-in links go to this address from now on. We sent a notice to ${owner.email}.`]);
    expect(await emailOf(deps, owner.userId)).toBe("solex.new@example.com");
    // The old address got the notice, with the new one partly hidden.
    expect(mail.sent.map((m) => [m.to, m.subject])).toEqual([
      ["solex.new@example.com", "Confirm your new Mythicshot email address"],
      [owner.email, "Your Mythicshot email address was changed"],
    ]);
    expect(mail.sent[1].text).toContain('The email address of the Mythicshot account "solex" was changed to s…@example.com.');

    // Back on the account page, the new address; the same link again is a dead link.
    const back = me.account();
    await back.settle();
    expect(back.$("account-email").textContent).toBe("solex.new@example.com");
    const again = me.link(link);
    await again.settle();
    again.$("confirm-button").click();
    await again.settle();
    expect(states(again)).toEqual(["dead"]);
    expect(await emailOf(deps, owner.userId)).toBe("solex.new@example.com");
  });

  it("the page behaves the same for a free address, one another account has, and the account's own", async () => {
    const seenFor = async (pick: (o: { own: string; taken: string }) => string) => {
      const made = await makeDeps(TWO);
      const { deps, mail } = made;
      await seedAccount(deps, { admin: true, username: "acct-admin" });
      const owner = await seedAccount(deps, { username: "solex" });
      const other = await seedAccount(deps, { username: "someone" });
      const me = browser(deps);
      await me.signIn(owner.userId);
      const page = me.account();
      await page.settle();
      const address = pick({ own: owner.email, taken: other.email });
      page.$("email-change").click();
      page.$("change-email").value = address;
      page.$("change-send").click();
      await page.settle();
      await made.settle();
      const post = page.fetched.filter((f) => f.method === "POST");
      return {
        // The address typed is in the second box's title; the account's own address in its sentence.
        shows: page.shows().map((l) => (l.startsWith("Check ") ? l.split(address).join("<address>") : l.split(owner.email).join("<own>"))),
        focus: page.doc.activeElement?.id,
        inert: inert(page),
        requests: post.map((f) => f.path),
        mails: mail.sent.length,
        email: await emailOf(deps, owner.userId),
        own: owner.email,
      };
    };
    const free = await seenFor(() => "fresh-address@example.com");
    const taken = await seenFor((o) => o.taken);
    const own = await seenFor((o) => o.own);
    const page = (r: typeof free) => ({ shows: r.shows, focus: r.focus, inert: r.inert, requests: r.requests });
    expect(page(taken)).toEqual(page(free));
    expect(page(own)).toEqual(page(free));
    expect(free.shows.slice(-3)).toEqual(["Check <address>", "Open the link we sent there to finish. It works once and for 15 minutes. Until then you keep signing in with <own>.", "Done"]);
    // Only the free address was sent a link; no address changed.
    expect([free.mails, taken.mails, own.mails]).toEqual([1, 0, 0]);
    for (const r of [free, taken, own]) expect(r.email).toBe(r.own);
  });

  it("a browser that is not signed in opening the link is told to sign in first, and nothing changes", async () => {
    const made = await makeDeps(TWO);
    const { deps, mail } = made;
    await seedAccount(deps, { admin: true, username: "acct-admin" });
    const owner = await seedAccount(deps, { username: "solex" });
    const me = browser(deps);
    await me.signIn(owner.userId);
    const page = me.account();
    await page.settle();
    page.$("email-change").click();
    page.$("change-email").value = "solex.new@example.com";
    page.$("change-send").click();
    await page.settle();
    await made.settle();
    const link = /https:\/\/app\.example\.com\/account\/email#c=dpe_[0-9a-f]{40}/.exec(mail.sent[0].text)![0];
    const stranger = browser(deps).link(link);
    await stranger.settle();
    expect(states(stranger)).toEqual(["first"]);
    expect(stranger.fetched.map((f) => `${f.method} ${f.path}`)).toEqual(["GET /api/v1/session"]);
    expect(await emailOf(deps, owner.userId)).toBe(owner.email);
    // The owner's own browser can still use it.
    const mine = me.link(link);
    await mine.settle();
    mine.$("confirm-button").click();
    await mine.settle();
    expect(states(mine)).toEqual(["done"]);
  });

  it("with mail off the page offers no change, and says why", async () => {
    const made = await makeDeps(TWO, { mail: false });
    const { deps } = made;
    await seedAccount(deps, { admin: true, username: "acct-admin" });
    const owner = await seedAccount(deps, { username: "solex" });
    const me = browser(deps);
    await me.signIn(owner.userId);
    const page = me.account();
    await page.settle();
    expect([page.$("email-change").shown, page.$("email-off").shown]).toEqual([false, true]);
    expect(page.shows()).toContain(MAIL_OFF_LINE);
  });

  it("lists where the account is signed in, ends another browser's session, and signs out everywhere (moved from the old account page's tests)", async () => {
    const made = await makeDeps(TWO);
    const { deps } = made;
    const owner = await seedAccount(deps, { admin: true, username: "owner" });
    const me = browser(deps);
    const mineMade = await me.signIn(owner.userId);
    const elsewhere = await redeemSignInCode(deps, await createSignInCode(deps, owner.userId), CHROME_WIN, null);
    const page = me.account();
    await page.settle();
    expect(page.shows().slice(0, 4)).toEqual(["Mythicshot", "owner", "Account", "Signed in as owner"]);
    expect(page.$("account-workspace").textContent.length).toBeGreaterThan(0);
    const stored = await deps.db.all<{ id: string; created_at: number; last_used_at: number }>("SELECT id, created_at, last_used_at FROM session WHERE user_id = ? AND revoked_at IS NULL", [owner.userId]);
    const mine = stored.find((r) => r.id === mineMade.sessionId)!;
    const theirs = stored.find((r) => r.id === elsewhere!.sessionId)!;
    expect(page.shows().filter((l) => l.includes(" | "))).toEqual([`This browser | Firefox on Linux | since ${shown(mine.created_at)}`, `Chrome on Windows | last used ${shown(theirs.last_used_at)}`]);

    page.$("sessions").all().filter((e) => e.tagName === "button")[0].click();
    await page.settle();
    expect(page.$("account-message").hidden).toBe(true);
    expect(sessionRows(page)).toHaveLength(1);
    expect((await deps.db.first<{ revoked_at: number | null }>("SELECT revoked_at FROM session WHERE id = ?", [elsewhere!.sessionId]))!.revoked_at).not.toBeNull();

    page.$("signout-everywhere").click();
    await page.settle();
    expect(page.left()).toBe("/signin");
    expect(me.jar.cookie).toBeNull();
    expect((await deps.db.first<{ n: number }>("SELECT count(*) AS n FROM session WHERE user_id = ? AND revoked_at IS NULL", [owner.userId]))!.n).toBe(0);
    const after = me.account();
    await after.settle();
    expect(after.left()).toBe("/signin");
  });

  it("the plain sign-out ends this session only (moved from the old account page's tests)", async () => {
    const made = await makeDeps(TWO);
    const { deps } = made;
    const owner = await seedAccount(deps, { admin: true, username: "owner" });
    const me = browser(deps);
    await me.signIn(owner.userId);
    const elsewhere = await redeemSignInCode(deps, await createSignInCode(deps, owner.userId), CHROME_WIN, null);
    const page = me.account();
    await page.settle();
    page.$("signout").click();
    await page.settle();
    expect(page.left()).toBe("/signin");
    expect(me.jar.cookie).toBeNull();
    const rows = await deps.db.all<{ id: string; revoked_at: number | null }>("SELECT id, revoked_at FROM session WHERE user_id = ? ORDER BY created_at", [owner.userId]);
    expect(rows.find((r) => r.id === elsewhere!.sessionId)!.revoked_at).toBeNull();
    expect(rows.filter((r) => r.revoked_at !== null)).toHaveLength(1);
  });
});
