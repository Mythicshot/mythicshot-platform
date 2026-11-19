// What the sign-in pages' script does when it runs: each page's script is run in a fresh
// Node `vm` context against a stand-in document built from the page's own HTML
// (test/pages-dom.ts), with a stand-in address bar, history and fetch. The fetch either
// answers from the test, or is handed to the real app on fresh deps, as a browser on the
// app address would send it (Origin and Sec-Fetch-Site on changes, the session cookie kept
// in a jar). Node only: the Workers runtime runs no code from a string.
//
// What this leaves unproven, for docs/signin-browser-check.md: real layout, focus and
// screen reader behaviour, the browser's own handling of the policy, the cookie and history.
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { createApp } from "../src/app.ts";
import type { Deps } from "../src/ports.ts";
import { SESSION_COOKIE, createSignInCode, redeemSignInCode } from "../src/sessions.ts";
import { ACCOUNT_HTML, LINK_HTML, SIGNIN_HTML, SIGNIN_JS } from "../src/signin/page.ts";
import { formatBytes } from "../src/usage.ts";
import { FakeDocument, FakeElement, visibleText } from "./pages-dom.ts";

const APP = "https://app.example.com";
const CODE = "dpl_" + "0123456789abcdef0123456789abcdef01234567";
const CSRF = "c".repeat(64);
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";
const CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
/** "Now" for the page: 19 November 2026, noon UTC, so the day is the same in nearly every time zone. */
const NOW = Date.UTC(2026, 10, 19, 12);
const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 12);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A date as the page writes it, in this process's time zone, with the page's "now" in 2026. */
const shown = (ms: number) => {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === 2026 ? "" : " " + d.getFullYear()}`;
};

type Answer = { status: number; json?: unknown; headers?: Record<string, string> } | "network";
type Fetched = { method: string; path: string; headers: Record<string, string>; body: string | undefined; init: Record<string, unknown> };
type Responder = (req: Fetched) => Answer | Promise<Answer>;

/** One page in a stand-in browser tab. */
type Tab = {
  doc: FakeDocument;
  /** In order: "hash" when the address's fragment is read, "replaceState <url>", "document" for each use of the document, "fetch <method> <path>", "replace <path>", "assign <path>". */
  log: string[];
  fetched: Fetched[];
  /** What the address bar shows now, and every entry of the tab's history. */
  url: () => string;
  history: string[];
  left: () => string | null;
  $: (id: string) => FakeElement;
  shows: () => string[];
  settle: () => Promise<void>;
  violations: string[];
};

const open: Tab[] = [];
afterEach(() => {
  for (const tab of open.splice(0)) expect(tab.violations, "the script used something it must not").toEqual([]);
});

/** Opens `html` at `url` and runs the script, as a browser would after parsing the page. */
function openPage(html: string, url: string, respond: Responder): Tab {
  const doc = new FakeDocument(html);
  const log: string[] = [];
  doc.log = log;
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
    replace(path: string) {
      log.push(`replace ${path}`);
      left = path;
    },
    assign(path: string) {
      log.push(`assign ${path}`);
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
    const headers = { ...(init.headers as Record<string, string>) };
    const req: Fetched = { method: String(init.method ?? "GET"), path, headers, body: init.body as string | undefined, init };
    fetched.push(req);
    log.push(`fetch ${req.method} ${path}`);
    const p = Promise.resolve(respond(req)).then((a) => {
      if (a === "network") throw new TypeError("Failed to fetch");
      const body = a.json === undefined ? null : JSON.stringify(a.json);
      return new Response(a.status === 204 ? null : body, { status: a.status, headers: { "content-type": "application/json", ...a.headers } });
    });
    pending.push(p.catch(() => {}));
    return p;
  };

  const context: Record<string, unknown> = { document: doc, location, history: historyApi, fetch };
  for (const name of ["localStorage", "sessionStorage", "indexedDB", "caches", "cookieStore", "XMLHttpRequest", "WebSocket", "EventSource", "navigator", "window", "self", "top", "parent", "opener", "open", "postMessage", "setTimeout", "setInterval", "console", "alert"]) {
    Object.defineProperty(context, name, {
      get() {
        violations.push(name);
        throw new Error(`${name} is not for the sign-in pages' script`);
      },
    });
  }
  const ctx = vm.createContext(context);
  // The page's "now", for the year a date shows.
  vm.runInContext(`(function () { var Real = Date; Date = function (v) { return arguments.length === 0 ? new Real(${NOW}) : new Real(v); }; Date.now = function () { return ${NOW}; }; Date.prototype = Real.prototype; })();`, ctx);
  vm.runInContext(SIGNIN_JS, ctx, { filename: "signin.js" });

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
      // Lets every answer that can arrive arrive, and the script react to it; an answer
      // the test holds back (later()) is not waited for.
      for (let i = 0; i < 20; i++) {
        await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, 1))]);
        await new Promise((r) => setImmediate(r));
      }
    },
    violations,
  };
  open.push(tab);
  return tab;
}

/** A responder from a table of "<METHOD> <path>" to answers; anything else fails the test. */
function answers(table: Record<string, Answer | Answer[]>): Responder {
  const queues = new Map(Object.entries(table).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  return (req) => {
    const q = queues.get(`${req.method} ${req.path}`);
    if (!q || q.length === 0) throw new Error(`unexpected request ${req.method} ${req.path}`);
    return q.length > 1 ? q.shift()! : q[0];
  };
}

/** A responder whose answer the test hands over later. */
function later(): { respond: Responder; answer: (a: Answer) => void } {
  let release: (a: Answer) => void = () => {};
  const p = new Promise<Answer>((r) => (release = r));
  return { respond: () => p, answer: (a) => release(a) };
}

const SIGNED_OUT: Answer = { status: 401, json: { error: "unauthorized" } };

function type(tab: Tab, id: string, value: string): void {
  tab.$(id).value = value;
}

// ---- The sign-in page ----

describe("the sign-in page", () => {
  it("shows the form, focuses the field and asks whether someone is signed in", async () => {
    const tab = openPage(SIGNIN_HTML, `${APP}/signin`, answers({ "GET /api/v1/session": SIGNED_OUT }));
    await tab.settle();
    expect(tab.shows()).toEqual([
      "Mythicshot",
      "Sign in",
      "Enter your email address and we will send you a link to sign in. There is no password.",
      "Email address",
      "Send me a sign-in link",
      "Mythicshot is invite-only for now.",
    ]);
    expect(tab.doc.activeElement?.id).toBe("email");
    expect(tab.fetched.map((f) => [f.method, f.path, f.init.credentials])).toEqual([["GET", "/api/v1/session", "same-origin"]]);
    expect(tab.left()).toBeNull();
  });

  it("sends someone who is signed in on to the account page", async () => {
    const tab = openPage(SIGNIN_HTML, `${APP}/signin`, answers({ "GET /api/v1/session": { status: 200, json: { account: {}, csrf: CSRF } } }));
    await tab.settle();
    expect(tab.left()).toBe("/account");
    expect(tab.log).toContain("replace /account");
  });

  it("refuses what is not an address without asking the server", async () => {
    const tab = openPage(SIGNIN_HTML, `${APP}/signin`, answers({ "GET /api/v1/session": SIGNED_OUT }));
    await tab.settle();
    const message = tab.$("ask-message");
    for (const value of ["", "   ", "name", "name@", "@example.com", "two words@example.com", "a@b@example.com"]) {
      type(tab, "email", value);
      tab.$("ask-button").click();
      await tab.settle();
      expect(message.textContent, value).toBe("That does not look like an email address.");
      expect(tab.$("email").getAttribute("aria-invalid"), value).toBe("true");
      expect(tab.doc.activeElement?.id, value).toBe("email");
    }
    expect(tab.fetched.filter((f) => f.method === "POST")).toEqual([]);
    // The message's place was there before it was filled: nothing moves.
    expect(tab.$("ask-message")).toBe(message);
  });

  it("asks for a link with a JSON body, says it is sending, and then shows the address as text", async () => {
    const hostile = "x<img/src=x/onerror=alert(1)>@example.com";
    const server = later();
    const tab = openPage(SIGNIN_HTML, `${APP}/signin`, (req) => (req.method === "GET" ? SIGNED_OUT : server.respond(req)));
    await tab.settle();
    type(tab, "email", `  ${hostile} `);
    tab.$("ask-button").click();
    await tab.settle();
    const post = tab.fetched.find((f) => f.method === "POST")!;
    expect(post.path).toBe("/api/v1/signin/request");
    expect(post.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(post.body!)).toEqual({ email: hostile });
    expect(post.init.credentials).toBe("same-origin");
    // While the server works, the button says so and cannot be pressed twice.
    expect(tab.$("ask-button").textContent).toBe("Sending…");
    expect(tab.$("ask-button").disabled).toBe(true);
    expect(tab.$("ask-button").click()).toBeNull();
    // Enter in the field submits the form without the button: the form's own guard holds that too.
    tab.$("ask-form").dispatch("submit");
    tab.$("ask-form").dispatch("submit");
    await tab.settle();
    expect(tab.fetched.filter((f) => f.method === "POST")).toHaveLength(1);
    server.answer({ status: 200, json: { ok: true } });
    await tab.settle();
    expect(tab.shows()).toEqual([
      "Mythicshot",
      "Check your mail",
      `If ${hostile} has an account, a sign-in link is on its way. It works once and for 15 minutes.`,
      "Nothing after a few minutes? Look in your spam folder, or try another address.",
    ]);
    // The address is one text node, never markup.
    const to = tab.$("sent-to");
    expect(to.children.length).toBe(1);
    expect(to.all()).toEqual([]);
    expect(to.textContent).toBe(hostile);
    expect(tab.doc.activeElement?.id).toBe("h-sent");
    expect(tab.fetched.filter((f) => f.method === "POST")).toHaveLength(1);
  });

  it("says why when the server refuses, and the button comes back", async () => {
    const cases: [Answer, string][] = [
      [{ status: 400, json: { error: "bad_email" } }, "That does not look like an email address."],
      [{ status: 429, json: { error: "rate_limited" }, headers: { "retry-after": "900" } }, "Too many requests. Wait a few minutes and try again."],
      [{ status: 403, json: { error: "bad_origin" } }, "Something went wrong. Try again in a moment."],
      [{ status: 500, json: { error: "internal" } }, "Something went wrong. Try again in a moment."],
      ["network", "Something went wrong. Try again in a moment."],
    ];
    for (const [answer, words] of cases) {
      const tab = openPage(SIGNIN_HTML, `${APP}/signin`, answers({ "GET /api/v1/session": SIGNED_OUT, "POST /api/v1/signin/request": answer }));
      await tab.settle();
      type(tab, "email", "someone@example.com");
      tab.$("ask-button").click();
      await tab.settle();
      expect(tab.$("ask-message").textContent, words).toBe(words);
      expect(tab.$("ask-button").textContent).toBe("Send me a sign-in link");
      expect(tab.$("ask-button").disabled).toBe(false);
      expect(tab.$("sent").hidden).toBe(true);
    }
  });

  it("try another address goes back to the form", async () => {
    const tab = openPage(SIGNIN_HTML, `${APP}/signin`, answers({ "GET /api/v1/session": SIGNED_OUT, "POST /api/v1/signin/request": { status: 200, json: { ok: true } } }));
    await tab.settle();
    type(tab, "email", "someone@example.com");
    tab.$("ask-button").click();
    await tab.settle();
    const event = tab.$("again").click();
    expect(event?.defaultPrevented).toBe(true);
    expect(tab.$("ask").hidden).toBe(false);
    expect(tab.$("sent").hidden).toBe(true);
    expect(tab.$("sent-to").textContent).toBe("");
    expect(tab.$("ask-message").textContent).toBe("");
    expect(tab.doc.activeElement?.id).toBe("email");
    expect(tab.left()).toBeNull();
  });
});

// ---- The page a link opens ----

describe("the page a sign-in link opens", () => {
  it("reads the code, cleans the address bar before anything else, and asks nothing until the press", async () => {
    const tab = openPage(LINK_HTML, `${APP}/signin/link#c=${CODE}`, answers({}));
    await tab.settle();
    expect(tab.log.slice(0, 2)).toEqual(["hash", "replaceState /signin/link"]);
    expect(tab.url()).toBe(`${APP}/signin/link`);
    expect(tab.history).toEqual([`${APP}/signin/link`]);
    expect(tab.fetched).toEqual([]);
    expect(tab.shows()).toEqual([
      "Mythicshot",
      "Finish signing in",
      "Press the button to sign in on this browser.",
      "Sign in",
      "You stay signed in here for 30 days of use. If you did not ask for this link, close this page: nothing happens.",
    ]);
    // Nothing of the code is on the page.
    expect(tab.doc.root.all().some((e) => e.textContent.includes(CODE) || [...e.attrs.values()].some((v) => v.includes(CODE)))).toBe(false);
  });

  it("sends the code once, in the body, when the button is pressed, and goes to the account page", async () => {
    const server = later();
    const tab = openPage(LINK_HTML, `${APP}/signin/link#c=${CODE}`, server.respond);
    tab.$("finish-button").click();
    await tab.settle();
    expect(tab.fetched).toHaveLength(1);
    const req = tab.fetched[0];
    expect([req.method, req.path, req.headers]).toEqual(["POST", "/api/v1/signin/complete", { "content-type": "application/json" }]);
    expect(JSON.parse(req.body!)).toEqual({ code: CODE });
    expect(req.init.credentials).toBe("same-origin");
    expect(req.init.referrerPolicy).toBe("no-referrer");
    expect(tab.$("finish-button").textContent).toBe("Signing in…");
    expect(tab.$("finish-button").click()).toBeNull();
    server.answer({ status: 200, json: { ok: true } });
    await tab.settle();
    expect(tab.left()).toBe("/account");
    expect(tab.log.filter((l) => l.startsWith("replace "))).toEqual(["replace /account"]);
    expect(tab.fetched).toHaveLength(1);
  });

  it("a used, expired, unknown or malformed code shows the one dead-link state", async () => {
    for (const answer of [{ status: 403, json: { error: "link_invalid", detail: "x" } }, { status: 400, json: { error: "bad_code" } }] as Answer[]) {
      const tab = openPage(LINK_HTML, `${APP}/signin/link#c=${CODE}`, answers({ "POST /api/v1/signin/complete": answer }));
      tab.$("finish-button").click();
      await tab.settle();
      expect(tab.shows()).toEqual(["Mythicshot", "This sign-in link no longer works", "A link works once and for 15 minutes. Ask for a new one and use the newest mail.", "Send me a new link"]);
      expect(tab.doc.activeElement?.id).toBe("h-dead");
      expect(tab.left()).toBeNull();
      // The code is gone from the page's memory: the hidden button, pressed by any means, sends nothing.
      expect(tab.$("finish-button").disabled).toBe(false);
      tab.$("finish-button").dispatch("click");
      await tab.settle();
      expect(tab.fetched).toHaveLength(1);
    }
    // The same when the page had no code to begin with.
    const empty = openPage(LINK_HTML, `${APP}/signin/link#c=abc`, answers({}));
    empty.$("finish-button").dispatch("click");
    await empty.settle();
    expect(empty.fetched).toEqual([]);
  });

  it("a page opened without a code, or with one that is not a code, shows the dead link at once and asks nothing", async () => {
    const urls = [
      `${APP}/signin/link`,
      `${APP}/signin/link#`,
      `${APP}/signin/link#c=`,
      `${APP}/signin/link#c=abc`,
      `${APP}/signin/link#c=${CODE.toUpperCase()}`,
      `${APP}/signin/link#c=${CODE}0`,
      `${APP}/signin/link#c=${CODE}&x=1`,
      `${APP}/signin/link#code=${CODE}`,
      `${APP}/signin/link#c=dps_${"0".repeat(64)}`,
    ];
    for (const url of urls) {
      const tab = openPage(LINK_HTML, url, answers({}));
      await tab.settle();
      expect(tab.$("dead").hidden, url).toBe(false);
      expect(tab.$("finish").hidden, url).toBe(true);
      expect(tab.fetched, url).toEqual([]);
      expect(tab.url(), url).not.toMatch(/#.+/);
      expect(tab.history.join(" "), url).not.toContain("c=");
    }
  });

  it("a refusal for too many tries or a failure keeps the code for another press", async () => {
    const tab = openPage(LINK_HTML, `${APP}/signin/link#c=${CODE}`, answers({ "POST /api/v1/signin/complete": [{ status: 429, json: { error: "rate_limited" } }, "network", { status: 500, json: { error: "internal" } }, { status: 200, json: { ok: true } }] }));
    const expected = ["Too many requests. Wait a few minutes and try again.", "Something went wrong. Try again in a moment.", "Something went wrong. Try again in a moment."];
    for (const words of expected) {
      tab.$("finish-button").click();
      await tab.settle();
      expect(tab.$("finish-message").textContent).toBe(words);
      expect(tab.$("finish-button").textContent).toBe("Sign in");
      expect(tab.$("finish").hidden).toBe(false);
    }
    tab.$("finish-button").click();
    await tab.settle();
    expect(tab.left()).toBe("/account");
    expect(tab.fetched.map((f) => JSON.parse(f.body!).code)).toEqual([CODE, CODE, CODE, CODE]);
  });

  it("send me a new link goes to the sign-in page, and a reload after the press shows no code", async () => {
    const first = openPage(LINK_HTML, `${APP}/signin/link#c=${CODE}`, answers({ "POST /api/v1/signin/complete": { status: 403, json: { error: "link_invalid" } } }));
    first.$("finish-button").click();
    await first.settle();
    first.$("dead-button").click();
    expect(first.left()).toBe("/signin");
    // Back or reload lands on what the address bar holds now: the page without its code.
    const again = openPage(LINK_HTML, first.history[first.history.length - 1], answers({}));
    await again.settle();
    expect(again.$("dead").hidden).toBe(false);
    expect(again.fetched).toEqual([]);
  });
});

// ---- The account page ----

type SessionRow = { id: string; label: string; created_at: number; last_used_at: number; expires_at: number; current: boolean };
const ME = "ses_" + "a".repeat(24);
const OTHER = "ses_" + "b".repeat(24);
const THIRD = "ses_" + "c".repeat(24);

function sessionAnswer(username: string | null = "alice", email = "alice@example.com"): Answer {
  return { status: 200, json: { account: { id: "usr_x", username, email, admin: false }, workspace: { id: "ws_x", name: "Acme" }, session: { id: ME, created_at: day(2026, 11, 2), expires_at: NOW + 1 }, csrf: CSRF } };
}
function usageAnswer(used: number, allowance: number | null, tours: number, over = allowance !== null && used > allowance): Answer {
  return { status: 200, json: { used_bytes: used, allowance_bytes: allowance, over, tours, counted: { pictures: used, logos: 0, uploads_in_progress: 0 } } };
}
const ROWS: SessionRow[] = [
  { id: ME, label: "Firefox on Linux", created_at: day(2026, 11, 2), last_used_at: NOW, expires_at: NOW + 1, current: true },
  { id: OTHER, label: "Chrome on Windows", created_at: day(2026, 1, 5), last_used_at: day(2026, 11, 18), expires_at: NOW + 1, current: false },
  { id: THIRD, label: "Safari on iOS", created_at: day(2025, 2, 1), last_used_at: day(2025, 3, 3), expires_at: NOW + 1, current: false },
];
const sessionsAnswer = (rows: SessionRow[] = ROWS): Answer => ({ status: 200, json: { sessions: rows } });

function account(more: Record<string, Answer | Answer[]> = {}, base: { session?: Answer; usage?: Answer; sessions?: Answer } = {}): Tab {
  return openPage(
    ACCOUNT_HTML,
    `${APP}/account`,
    answers({ "GET /api/v1/session": base.session ?? sessionAnswer(), "GET /api/v1/usage": base.usage ?? usageAnswer(1_288_490_189, 5 * 1024 ** 3, 12), "GET /api/v1/sessions": base.sessions ?? sessionsAnswer(), ...more }),
  );
}

describe("the account page", () => {
  it("sends a visitor who is not signed in to the sign-in page and shows nothing", async () => {
    const tab = openPage(ACCOUNT_HTML, `${APP}/account`, answers({ "GET /api/v1/session": SIGNED_OUT }));
    await tab.settle();
    expect(tab.left()).toBe("/signin");
    expect(tab.$("account").hidden).toBe(true);
    expect(tab.fetched.map((f) => f.path)).toEqual(["/api/v1/session"]);
    // While it is sent away, the tab's title is the site's name alone.
    expect(tab.doc.title).toBe("Mythicshot");
  });

  it("shows who is signed in, the storage and where, in the approved words", async () => {
    const tab = account();
    expect(tab.$("account").hidden).toBe(true);
    expect(tab.doc.title).toBe("Mythicshot");
    await tab.settle();
    expect(tab.doc.title).toBe("Signed in");
    expect(tab.shows()).toEqual([
      "Mythicshot",
      "Signed in as alice",
      "alice@example.com",
      "Storage",
      "1.20 GB of 5.00 GB used · 12 tours",
      "Tours and their pictures count. Deleting a tour frees its space within a few minutes.",
      "Where you are signed in",
      "This browser | Firefox on Linux | since 2 Nov",
      "Chrome on Windows | last used 18 Nov",
      "Sign out",
      "Safari on iOS | last used 3 Mar 2025",
      "Sign out",
      "Sign out",
      "Sign out everywhere",
      "Tours are managed from Mythicshot for now. A dashboard is coming to this page.",
    ]);
    expect(tab.$("usage-bar").hidden).toBe(false);
    expect(tab.$("usage-fill").style.width).toBe("24%");
    expect(tab.$("usage-bar").hasAttribute("data-over")).toBe(false);
    // Each row's button names its row for a screen reader, by reference.
    const rows = tab.$("sessions").all().filter((e) => e.tagName === "li");
    expect(rows).toHaveLength(3);
    expect(rows[0].all().some((e) => e.tagName === "button")).toBe(false);
    for (const row of rows.slice(1)) {
      const button = row.all().find((e) => e.tagName === "button")!;
      expect(button.getAttribute("type")).toBe("button");
      const named = tab.doc.getElementById(button.getAttribute("aria-describedby")!)!;
      expect(row.contains(named)).toBe(true);
    }
    expect(tab.fetched.map((f) => `${f.method} ${f.path}`).sort()).toEqual(["GET /api/v1/session", "GET /api/v1/sessions", "GET /api/v1/usage"]);
    for (const f of tab.fetched) expect([f.init.credentials, f.headers], f.path).toEqual(["same-origin", {}]);
  });

  it("without a username the heading is Signed in, and nothing the server sends becomes markup", async () => {
    const tab = account({}, { session: sessionAnswer(null, "<b>bold</b>@example.com"), sessions: sessionsAnswer([{ ...ROWS[0], label: "<img src=x onerror=alert(1)>" }]) });
    await tab.settle();
    expect(tab.$("h-account").textContent).toBe("Signed in");
    expect(tab.$("account-email").textContent).toBe("<b>bold</b>@example.com");
    expect(tab.$("account-email").all()).toEqual([]);
    const label = tab.$("sessions").all().find((e) => e.textContent === "<img src=x onerror=alert(1)>")!;
    expect(label.all()).toEqual([]);
    const evil = account({}, { session: sessionAnswer("<script>x</script>") });
    await evil.settle();
    expect(evil.$("h-account").textContent).toBe("Signed in as <script>x</script>");
    expect(evil.$("h-account").all()).toEqual([]);
  });

  it("the storage line and bar under, at and over the allowance and with no limit", async () => {
    const GB = 1024 ** 3;
    const cases: [Answer, string, string | null, boolean][] = [
      [usageAnswer(0, 5 * GB, 0), "0 bytes of 5.00 GB used · 0 tours", "0%", false],
      [usageAnswer(512 * 1024, 1 * GB, 1), "512 KB of 1.00 GB used · 1 tour", "0.05%", false],
      [usageAnswer(5 * GB, 5 * GB, 2), "5.00 GB of 5.00 GB used · 2 tours", "100%", false],
      [usageAnswer(6 * GB, 5 * GB, 3), "6.00 GB of 5.00 GB used · 3 tours", "100%", true],
      [usageAnswer(1, 0, 1), "1 byte of 0 bytes used · 1 tour", "100%", true],
      [usageAnswer(1_288_490_189, null, 12), "1.20 GB used · 12 tours", null, false],
    ];
    for (const [usage, line, width, over] of cases) {
      const tab = account({}, { usage });
      await tab.settle();
      expect(tab.$("usage-text").textContent, line).toBe(line);
      expect(tab.$("usage-bar").hidden, line).toBe(width === null);
      if (width !== null) expect(tab.$("usage-fill").style.width, line).toBe(width);
      expect(tab.$("usage-bar").getAttribute("data-over"), line).toBe(over ? "true" : null);
    }
  });

  it("sizes read exactly as the server's own rule writes them", async () => {
    const sizes = [0, 1, 2, 1023, 1024, 1025, 10_239, 10_240, 102_399, 102_400, 1_048_063, 1_048_064, 1_048_576, 14_889_779, 1_073_217_536, 1_073_741_824, 1_095_216_660, 5 * 1024 ** 3, 1024 ** 4, 9_007_199_254_740_991];
    for (const n of sizes) {
      const tab = account({}, { usage: usageAnswer(n, null, 1) });
      await tab.settle();
      expect(tab.$("usage-text").textContent, String(n)).toBe(`${formatBytes(n)} used · 1 tour`);
    }
  });

  it("ending another session sends the anti-forgery header and removes its row", async () => {
    const tab = account({ [`DELETE /api/v1/sessions/${OTHER}`]: { status: 204 } });
    await tab.settle();
    const row = tab.$("sessions").all().filter((e) => e.tagName === "li")[1];
    row.all().find((e) => e.tagName === "button")!.click();
    await tab.settle();
    const del = tab.fetched.find((f) => f.method === "DELETE")!;
    expect(del.path).toBe(`/api/v1/sessions/${OTHER}`);
    expect(del.headers).toEqual({ "X-Csrf-Token": CSRF });
    expect(del.body).toBeUndefined();
    expect(del.init.credentials).toBe("same-origin");
    expect(tab.$("sessions").contains(row)).toBe(false);
    expect(tab.$("sessions").all().filter((e) => e.tagName === "li")).toHaveLength(2);
    expect(tab.$("account-message").textContent).toBe("");
    expect(tab.left()).toBeNull();
    // Focus does not fall to the page's start with the row.
    expect(tab.doc.activeElement?.id).toBe("h-where");
  });

  it("a session that could not be ended keeps its row and says so", async () => {
    for (const answer of [{ status: 404, json: { error: "not_found" } }, { status: 403, json: { error: "bad_csrf" } }, { status: 500, json: {} }, "network"] as Answer[]) {
      const tab = account({ [`DELETE /api/v1/sessions/${OTHER}`]: answer });
      await tab.settle();
      const row = tab.$("sessions").all().filter((e) => e.tagName === "li")[1];
      const button = row.all().find((e) => e.tagName === "button")!;
      button.click();
      expect(button.textContent).toBe("Signing out…");
      await tab.settle();
      expect(tab.$("account-message").textContent).toBe("That session could not be ended. Reload the page.");
      expect(tab.$("sessions").contains(row)).toBe(true);
      expect(button.textContent).toBe("Sign out");
      expect(button.disabled).toBe(false);
    }
  });

  it("ending the current session from the list is a sign-out, and so is a 401 on the way", async () => {
    // A list that names this browser's session without marking it current.
    const rows = [{ ...ROWS[0], current: false }, ROWS[1]];
    const own = account({ [`DELETE /api/v1/sessions/${ME}`]: { status: 204 } }, { sessions: sessionsAnswer(rows) });
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
      const tab = openPage(ACCOUNT_HTML, `${APP}/account`, (req) =>
        req.method === "POST" ? server.respond(req) : answers({ "GET /api/v1/session": sessionAnswer(), "GET /api/v1/usage": usageAnswer(0, null, 0), "GET /api/v1/sessions": sessionsAnswer() })(req),
      );
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

  it("a sign-out that fails says so and gives the buttons back", async () => {
    for (const answer of [{ status: 500, json: {} }, { status: 403, json: { error: "bad_csrf" } }, "network"] as Answer[]) {
      const tab = account({ "POST /api/v1/signout": answer });
      await tab.settle();
      tab.$("signout").click();
      await tab.settle();
      expect(tab.$("account-message").textContent).toBe("Something went wrong. Try again in a moment.");
      expect(tab.$("signout").textContent).toBe("Sign out");
      expect(tab.$("signout").disabled || tab.$("signout-everywhere").disabled).toBe(false);
      expect(tab.left()).toBeNull();
    }
    // A 401 means the session already ended: signed out all the same.
    const ended = account({ "POST /api/v1/signout/everywhere": SIGNED_OUT });
    await ended.settle();
    ended.$("signout-everywhere").click();
    await ended.settle();
    expect(ended.left()).toBe("/signin");
  });

  it("when the session cannot be read, or the storage or the list cannot, the page says so", async () => {
    const broken = openPage(ACCOUNT_HTML, `${APP}/account`, answers({ "GET /api/v1/session": "network" }));
    await broken.settle();
    expect(broken.shows()).toEqual(["Mythicshot", "Something went wrong. Try again in a moment."]);
    expect(broken.left()).toBeNull();
    for (const base of [{ usage: { status: 500, json: {} } }, { sessions: "network" as Answer }] as { usage?: Answer; sessions?: Answer }[]) {
      const tab = account({}, base);
      await tab.settle();
      expect(tab.$("account").hidden).toBe(false);
      expect(tab.$("account-message").textContent).toBe("Something went wrong. Try again in a moment.");
      expect(tab.$("h-account").textContent).toBe("Signed in as alice");
    }
  });
});

// ---- Against the real app ----

/** A tab whose fetch goes to the real app, as a browser on the app address sends it, with a cookie jar shared by the tabs of one test. */
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
  return { jar, open: (html: string, url: string) => openPage(html, url, respond) };
}

describe("the pages against the real app", () => {
  it("asking, opening the link, pressing, the account page, ending another session and signing out everywhere", async () => {
    const made = await makeDeps({ hosts: { tours: "tours.example.com", app: "app.example.com" }, storageAllowanceBytes: 1_000_000 });
    const { deps, mail } = made;
    const owner = await seedAccount(deps, { admin: true, username: "owner" });
    const me = browser(deps);

    const ask = me.open(SIGNIN_HTML, `${APP}/signin`);
    await ask.settle();
    type(ask, "email", owner.email);
    ask.$("ask-button").click();
    await ask.settle();
    await made.settle();
    expect(ask.$("sent").hidden).toBe(false);
    expect(mail.sent).toHaveLength(1);
    const link = /https:\/\/app\.example\.com\/signin\/link#c=dpl_[0-9a-f]{40}/.exec(mail.sent[0].text)![0];

    const opened = me.open(LINK_HTML, link);
    await opened.settle();
    expect(opened.fetched).toEqual([]);
    expect(opened.url()).toBe(`${APP}/signin/link`);
    opened.$("finish-button").click();
    await opened.settle();
    expect(opened.left()).toBe("/account");
    expect(me.jar.cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=dps_[0-9a-f]{64}$`));

    // Another browser of the same account.
    const elsewhere = await redeemSignInCode(deps, await createSignInCode(deps, owner.userId), CHROME_WIN, null);
    expect(elsewhere).not.toBeNull();

    const page = me.open(ACCOUNT_HTML, `${APP}/account`);
    await page.settle();
    const lines = page.shows();
    expect(lines.slice(0, 5)).toEqual(["Mythicshot", "Signed in as owner", owner.email, "Storage", "0 bytes of 977 KB used · 0 tours"]);
    const stored = await deps.db.all<{ id: string; created_at: number; last_used_at: number }>("SELECT id, created_at, last_used_at FROM session WHERE user_id = ? AND revoked_at IS NULL", [owner.userId]);
    const mine = stored.find((r) => r.id !== elsewhere!.sessionId)!;
    const theirs = stored.find((r) => r.id === elsewhere!.sessionId)!;
    expect(lines.filter((l) => l.includes(" | "))).toEqual([`This browser | Firefox on Linux | since ${shown(mine.created_at)}`, `Chrome on Windows | last used ${shown(theirs.last_used_at)}`]);

    // Ending the other browser's session.
    page.$("sessions").all().filter((e) => e.tagName === "button")[0].click();
    await page.settle();
    expect(page.$("account-message").textContent).toBe("");
    expect(page.$("sessions").all().filter((e) => e.tagName === "li")).toHaveLength(1);
    const other = await deps.db.first<{ revoked_at: number | null }>("SELECT revoked_at FROM session WHERE id = ?", [elsewhere!.sessionId]);
    expect(other!.revoked_at).not.toBeNull();

    // Signing out everywhere.
    page.$("signout-everywhere").click();
    await page.settle();
    expect(page.left()).toBe("/signin");
    expect(me.jar.cookie).toBeNull();
    const live = await deps.db.first<{ n: number }>("SELECT count(*) AS n FROM session WHERE user_id = ? AND revoked_at IS NULL", [owner.userId]);
    expect(live!.n).toBe(0);

    // The account page now sends the visitor to sign in.
    const after = me.open(ACCOUNT_HTML, `${APP}/account`);
    await after.settle();
    expect(after.left()).toBe("/signin");
  });

  it("the plain sign-out ends this session only, and the link works once", async () => {
    const made = await makeDeps({ hosts: { tours: "tours.example.com", app: "app.example.com" } });
    const { deps } = made;
    const owner = await seedAccount(deps, { admin: true, username: "owner" });
    const code = await createSignInCode(deps, owner.userId);
    const me = browser(deps);
    const first = me.open(LINK_HTML, `${APP}/signin/link#c=${code}`);
    first.$("finish-button").click();
    await first.settle();
    expect(first.left()).toBe("/account");
    // The same link again, in another browser: the dead-link state.
    const thief = browser(deps).open(LINK_HTML, `${APP}/signin/link#c=${code}`);
    thief.$("finish-button").click();
    await thief.settle();
    expect(thief.$("dead").hidden).toBe(false);
    expect(thief.left()).toBeNull();

    const elsewhere = await redeemSignInCode(deps, await createSignInCode(deps, owner.userId), CHROME_WIN, null);
    const page = me.open(ACCOUNT_HTML, `${APP}/account`);
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
