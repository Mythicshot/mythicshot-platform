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
import { SESSION_COOKIE, createSignInCode } from "../src/sessions.ts";
import { LINK_HTML, SIGNIN_HTML, SIGNIN_JS } from "../src/signin/page.ts";
import { NODE_SETTINGS, configFromEnv } from "../src/node/config.ts";
import { FakeDocument, FakeElement, visibleText } from "./pages-dom.ts";

const APP = "https://app.example.com";
const CODE = "dpl_" + "0123456789abcdef0123456789abcdef01234567";
const CSRF = "c".repeat(64);
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";
/** "Now" for the page: 19 November 2026, noon UTC, so the day is the same in nearly every time zone. */
const NOW = Date.UTC(2026, 10, 19, 12);

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

  it("sends someone who is signed in on to the Tours page", async () => {
    const tab = openPage(SIGNIN_HTML, `${APP}/signin`, answers({ "GET /api/v1/session": { status: 200, json: { account: {}, csrf: CSRF } } }));
    await tab.settle();
    expect(tab.left()).toBe("/tours");
    expect(tab.log).toContain("replace /tours");
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

  it("sends the code once, in the body, when the button is pressed, and goes to the Tours page", async () => {
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
    expect(tab.left()).toBe("/tours");
    expect(tab.log.filter((l) => l.startsWith("replace "))).toEqual(["replace /tours"]);
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
    expect(tab.left()).toBe("/tours");
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

// ---- The settings the sign-in page reads ----
//
// The account page's tests moved to test/node-dash-account.test.ts when /account became a
// dashboard page; its storage block's to the Storage page's (test/node-dash-storage.test.ts).

describe("the Node settings of the sign-in page", () => {
  it("INVITE_CONTACT is read from the Node settings as text, and a value it cannot use never stops the start", () => {
    expect(configFromEnv({ INVITE_CONTACT: " hello@example.com " }).inviteContact).toBe("hello@example.com");
    expect(configFromEnv({ INVITE_CONTACT: "https://example.com/invite" }).inviteContact).toBe("https://example.com/invite");
    expect(() => configFromEnv({ INVITE_CONTACT: "javascript:alert(1)" })).not.toThrow();
    for (const v of [undefined, "", "   "]) expect("inviteContact" in configFromEnv({ INVITE_CONTACT: v }), String(v)).toBe(false);
    expect(NODE_SETTINGS).toContain("INVITE_CONTACT");
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
  it("asking, opening the link, pressing, and landing on the Tours page signed in", async () => {
    const made = await makeDeps({ hosts: { tours: "tours.example.com", app: "app.example.com" } });
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
    expect(opened.left()).toBe("/tours");
    expect(me.jar.cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=dps_[0-9a-f]{64}$`));
    // The session is live: the account page's part of this walk is in test/node-dash-account.test.ts.
    const live = await deps.db.first<{ n: number }>("SELECT count(*) AS n FROM session WHERE user_id = ? AND revoked_at IS NULL", [owner.userId]);
    expect(live!.n).toBe(1);
  });

  it("the link works once", async () => {
    const made = await makeDeps({ hosts: { tours: "tours.example.com", app: "app.example.com" } });
    const { deps } = made;
    const owner = await seedAccount(deps, { admin: true, username: "owner" });
    const code = await createSignInCode(deps, owner.userId);
    const me = browser(deps);
    const first = me.open(LINK_HTML, `${APP}/signin/link#c=${code}`);
    first.$("finish-button").click();
    await first.settle();
    expect(first.left()).toBe("/tours");
    // The same link again, in another browser: the dead-link state.
    const thief = browser(deps).open(LINK_HTML, `${APP}/signin/link#c=${code}`);
    thief.$("finish-button").click();
    await thief.settle();
    expect(thief.$("dead").hidden).toBe(false);
    expect(thief.left()).toBeNull();
  });
});
