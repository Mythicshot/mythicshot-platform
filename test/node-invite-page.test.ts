// What the invite page's script does when it runs: /invite/invite.js is run in a fresh Node
// `vm` context against a stand-in document built from the page's own HTML (test/pages-dom.ts),
// with a stand-in address bar, history and fetch, as test/node-signin-pages.test.ts runs the
// sign-in pages. The fetch either answers from the test, or is handed to the real app on fresh
// deps, as a browser on the app address sends it (Origin and Sec-Fetch-Site on changes, the
// session cookie kept in a jar); the walk through the real routes ends on the Connections page,
// run the same way with the dashboard's scripts. Node only: the Workers runtime runs no code
// from a string.
//
// What this leaves unproven, for docs/dashboard-browser-check.md: real layout and focus, the
// browser's own handling of the policy, the cookie and the history.
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { createApp } from "../src/app.ts";
import { CONNECTIONS_HTML, CONNECTIONS_JS } from "../src/dash/connections.ts";
import { DASH_JS } from "../src/dash/script.ts";
import type { Deps } from "../src/ports.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import { INVITE_HTML, INVITE_JS } from "../src/signin/accept.ts";
import { parseUsername } from "../src/usernames.ts";
import { send } from "./bundle.ts";
import { FakeDocument, FakeElement, visibleText } from "./pages-dom.ts";

const APP = "https://app.example.com";
const CODE = "dpi_" + "0123456789abcdef0123456789abcdef01234567";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";
/** "Now" for the page: 20 November 2026, noon UTC. */
const NOW = Date.UTC(2026, 10, 20, 12);

const BRAND = "Mythicshot";
const CHOOSE_LEAD = (email: string) => `You were invited as ${email}. Your username is how you appear here, and it cannot be changed later.`;
const HINT = "3 to 30 characters: lowercase letters, digits and hyphens.";
const FOOT = "You sign in with a link sent to your email address. There is no password.";
const DEAD = ["Mythicshot", "This invite no longer works", "An invite works once and for 7 days, and a newer invite replaces an older one. Ask the person who invited you to send it again.", "If you reloaded this page, open the link in your mail again.", "Already have an account? Sign in"];
const HERE = ["Mythicshot", "You are already signed in", "This invite is for a new account. If you have just used it, you are all set. Otherwise sign out first, then open the link from your mail again.", "Go to the dashboard"];
const BAD = "Use 3 to 30 lowercase letters, digits and hyphens, starting with a letter.";
const RESERVED = "That username cannot be chosen. Try another.";
const TAKEN = "That username is taken. Try another.";
const FAILED = "Something went wrong. Try again in a moment.";

type Answer = { status: number; json?: unknown; headers?: Record<string, string> } | "network";
type Fetched = { method: string; path: string; headers: Record<string, string>; body: string | undefined; init: Record<string, unknown> };
type Responder = (req: Fetched) => Answer | Promise<Answer>;

type Tab = {
  doc: FakeDocument;
  /** In order: "hash" when the fragment is read, "replaceState <url>", "fetch <method> <path>", "replace <path>", "assign <path>". */
  log: string[];
  fetched: Fetched[];
  url: () => string;
  history: string[];
  left: () => string | null;
  $: (id: string) => FakeElement;
  shows: () => string[];
  settle: () => Promise<void>;
  tick: () => void;
  violations: string[];
};

const open: Tab[] = [];
afterEach(() => {
  for (const tab of open.splice(0)) expect(tab.violations, "the script used something it must not").toEqual([]);
});

/**
 * Opens `html` at `url` and runs `scripts` in order, as a browser would after parsing the page.
 * `timers`: the dashboard's scripts may set timers (a stand-in that runs them on tick()); the
 * invite page's may not.
 */
function openPage(html: string, url: string, scripts: [string, string][], respond: Responder, timers = false): Tab {
  const doc = new FakeDocument(html);
  const log: string[] = [];
  const history = [url];
  let current = new URL(url);
  let left: string | null = null;
  const fetched: Fetched[] = [];
  const pending: Promise<unknown>[] = [];
  const violations: string[] = [];
  let waiting: (() => void)[] = [];

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
    const req: Fetched = { method: String(init.method ?? "GET"), path, headers: { ...(init.headers as Record<string, string>) }, body: init.body as string | undefined, init };
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
  if (timers) context.setTimeout = (fn: () => void) => waiting.push(fn);
  const banned = ["localStorage", "sessionStorage", "indexedDB", "caches", "cookieStore", "XMLHttpRequest", "WebSocket", "EventSource", "navigator", "window", "self", "top", "parent", "opener", "open", "postMessage", "setInterval", "console", "alert", "confirm", "prompt"];
  if (!timers) banned.push("setTimeout");
  for (const name of banned) {
    Object.defineProperty(context, name, {
      get() {
        violations.push(name);
        throw new Error(`${name} is not for this page's script`);
      },
    });
  }
  const ctx = vm.createContext(context);
  vm.runInContext(`(function () { var Real = Date; Date = function (v) { return arguments.length === 0 ? new Real(${NOW}) : new Real(v); }; Date.now = function () { return ${NOW}; }; Date.prototype = Real.prototype; })();`, ctx);
  for (const [name, js] of scripts) vm.runInContext(js, ctx, { filename: name });

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
        await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, 1))]);
        await new Promise((r) => setImmediate(r));
      }
    },
    tick: () => {
      const now = waiting;
      waiting = [];
      for (const fn of now) fn();
    },
    violations,
  };
  open.push(tab);
  return tab;
}

const invitePage = (url: string, respond: Responder) => openPage(INVITE_HTML, url, [["invite.js", INVITE_JS]], respond);

/** A responder from a table of "<METHOD> <path>" to answers (a list in order, its last repeated); anything else fails the test. */
function answers(table: Record<string, Answer | Answer[]>): Responder {
  const queues = new Map(Object.entries(table).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  return (req) => {
    const q = queues.get(`${req.method} ${req.path}`);
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

const CHECK = "POST /api/v1/invite/check";
const ACCEPT = "POST /api/v1/invite/accept";
const FOUND = (email = "mara@example.com"): Answer => ({ status: 200, json: { email, invited_by: "solex", expires_at: NOW + 7 * 86_400_000 } });
const INVALID: Answer = { status: 404, json: { error: "invite_invalid", detail: "This invite no longer works. Ask the person who invited you to send it again." } };
const SIGNED_IN: Answer = { status: 409, json: { error: "signed_in", detail: "You are signed in. Sign out first, then open the invite link again." } };
const OK: Answer = { status: 200, json: { ok: true } };
const limited = (seconds?: string): Answer => ({ status: 429, json: { error: "rate_limited", detail: "Too many tries. Wait a few minutes and try again." }, headers: seconds === undefined ? {} : { "retry-after": seconds } });

function type(tab: Tab, value: string): void {
  const input = tab.$("username");
  input.value = value;
  input.dispatch("input");
}

/** Nothing of the code is on the page: no text, no attribute. */
function expectCodeNowhere(tab: Tab, code = CODE): void {
  expect(tab.doc.root.all().some((e) => e.textContent.includes(code) || [...e.attrs.values()].some((v) => v.includes(code))), "the code is on the page").toBe(false);
  for (const f of tab.fetched) expect(f.path, "a request's address").not.toContain(code.slice(4));
  for (const f of tab.fetched) expect(f.path, "a request's address").not.toMatch(/[?#]/);
  expect(tab.url(), "the address bar").not.toContain(code.slice(4));
  for (const h of tab.history) expect(h, "a history entry").not.toContain(code.slice(4));
}

async function chosen(respond: Responder, url = `${APP}/invite#${CODE}`): Promise<Tab> {
  const tab = invitePage(url, respond);
  await tab.settle();
  return tab;
}

// ---- Opening the link ----

describe("the invite page: opening the link", () => {
  it("reads the code, cleans the address bar before anything else, then looks the invite up with the code in the body", async () => {
    const server = holding((r) => r.path === "/api/v1/invite/check", answers({}));
    const tab = invitePage(`${APP}/invite#${CODE}`, server.respond);
    // Before any request: the fragment was read, and the address bar cleaned.
    expect(tab.log.slice(0, 2)).toEqual(["hash", "replaceState /invite"]);
    expect(tab.log.findIndex((l) => l.startsWith("fetch "))).toBeGreaterThan(1);
    expect(tab.url()).toBe(`${APP}/invite`);
    expect(tab.history).toEqual([`${APP}/invite`]);
    // While it is looked up: the heading, nothing else.
    expect(tab.shows()).toEqual([BRAND, "Opening your invite"]);
    expect(tab.fetched).toHaveLength(1);
    const req = tab.fetched[0];
    expect([req.method, req.path, req.headers]).toEqual(["POST", "/api/v1/invite/check", { "content-type": "application/json" }]);
    expect(JSON.parse(req.body!)).toEqual({ code: CODE });
    expect([req.init.credentials, req.init.referrerPolicy, req.init.cache, req.init.redirect]).toEqual(["same-origin", "no-referrer", "no-store", "error"]);
    server.answer(FOUND());
    await tab.settle();
    expect(tab.shows()).toEqual([BRAND, "Choose your username", CHOOSE_LEAD("mara@example.com"), "Username", HINT, "Create my account", FOOT]);
    expect(tab.doc.activeElement?.id).toBe("username");
    // Opening the link made no account: only the check was sent.
    expect(tab.fetched.map((f) => f.path)).toEqual(["/api/v1/invite/check"]);
    expect(tab.left()).toBeNull();
    expectCodeNowhere(tab);
  });

  it("shows the invited address exactly as the check gave it, as one text node in the bold element", async () => {
    const hostile = 'x"><img src=x onerror=alert(1)>@example.com';
    for (const email of ["mara@example.com", hostile, "very.long.address.of.someone@a-rather-long-domain-name.example.com"]) {
      const tab = await chosen(answers({ [CHECK]: FOUND(email) }));
      const to = tab.$("invite-email");
      expect([to.tagName, to.children.length, to.all(), to.textContent], email).toEqual(["strong", 1, [], email]);
      expect(tab.shows()[2], email).toBe(CHOOSE_LEAD(email));
      expect(tab.doc.root.all().filter((e) => e.tagName === "img"), email).toEqual([]);
    }
  });

  it("every dead-link cause shows the one page: no code, a malformed code, an unknown, used or expired code", async () => {
    const urls = [
      `${APP}/invite`,
      `${APP}/invite#`,
      `${APP}/invite#dpi_`,
      `${APP}/invite#${CODE.toUpperCase()}`,
      `${APP}/invite#${CODE}0`,
      `${APP}/invite#c=${CODE}`,
      `${APP}/invite#${CODE}&x=1`,
      `${APP}/invite#dpl_${"0".repeat(40)}`,
      `${APP}/invite?code=x#${CODE.slice(0, -1)}`,
    ];
    for (const url of urls) {
      const tab = invitePage(url, answers({}));
      await tab.settle();
      expect(tab.shows(), url).toEqual(DEAD);
      expect(tab.fetched, url).toEqual([]);
      expect(tab.url(), url).not.toMatch(/#.+/);
      expect(tab.doc.activeElement?.id, url).toBe("h-dead");
    }
    // The check refuses the code: the same page.
    const refused = await chosen(answers({ [CHECK]: INVALID }));
    expect(refused.shows()).toEqual(DEAD);
    expect(refused.$("dead").all().find((e) => e.tagName === "a")?.getAttribute("href")).toBe("/signin");
    // The code is forgotten: the hidden button of the form, pressed by any means, sends nothing.
    refused.$("choose-button").dispatch("click");
    await refused.settle();
    expect(refused.fetched).toHaveLength(1);
  });

  it("a browser signed in already: the proposed page, the dashboard and nothing that acts on the account", async () => {
    const tab = await chosen(answers({ [CHECK]: SIGNED_IN }));
    expect(tab.shows()).toEqual(HERE);
    expect(tab.doc.activeElement?.id).toBe("h-here");
    expect(tab.$("here").all().filter((e) => e.tagName === "button" || e.tagName === "a").map((e) => e.textContent)).toEqual(["Go to the dashboard"]);
    tab.$("here-button").click();
    expect(tab.left()).toBe("/");
    expect(tab.fetched.map((f) => f.path)).toEqual(["/api/v1/invite/check"]);
  });

  it("a failure keeps the code in memory: Try again checks it again without the mail", async () => {
    for (const failure of ["network", { status: 500, json: { error: "internal" } }, { status: 403, json: { error: "bad_origin" } }, { status: 400, json: { error: "bad_request" } }] as Answer[]) {
      const tab = await chosen(answers({ [CHECK]: [failure, FOUND()] }));
      expect(tab.shows(), JSON.stringify(failure)).toEqual([BRAND, "Opening your invite", FAILED, "Try again"]);
      expect(tab.doc.activeElement?.id).toBe("opening-button");
      tab.$("opening-button").click();
      await tab.settle();
      expect(tab.$("choose").shown).toBe(true);
      expect(tab.fetched.map((f) => JSON.parse(f.body!).code)).toEqual([CODE, CODE]);
      expectCodeNowhere(tab);
    }
  });

  it("too many tries: the wait from retry-after in minutes, and Try again asks nothing until it is over", async () => {
    const cases: [Answer, string][] = [
      [limited("900"), "Too many tries. Wait 15 minutes and try again."],
      [limited("61"), "Too many tries. Wait 2 minutes and try again."],
      [limited("30"), "Too many tries. Wait 1 minute and try again."],
      [limited(), "Too many tries. Wait 15 minutes and try again."],
      [limited("soon"), "Too many tries. Wait 15 minutes and try again."],
    ];
    for (const [answer, words] of cases) {
      const tab = await chosen(answers({ [CHECK]: answer }));
      expect(tab.shows()).toEqual([BRAND, "Opening your invite", words, "Try again"]);
      tab.$("opening-button").click();
      await tab.settle();
      expect(tab.fetched).toHaveLength(1);
      expect(tab.$("opening-message").textContent).toBe(words);
    }
  });
});

// ---- Choosing the username ----

describe("the invite page: choosing the username", () => {
  it("a press sends the code and the name once, in the body, says it is creating, and goes to the Connections page", async () => {
    const server = holding((r) => r.path === "/api/v1/invite/accept", answers({ [CHECK]: FOUND() }));
    const tab = await chosen(server.respond);
    type(tab, "  mara  ");
    tab.$("choose-button").click();
    tab.$("choose-button").click();
    tab.$("choose-button").dispatch("click");
    tab.$("username").dispatch("keydown", { key: "Enter" });
    await tab.settle();
    const accepts = tab.fetched.filter((f) => f.path === "/api/v1/invite/accept");
    expect(accepts).toHaveLength(1);
    expect([accepts[0].method, accepts[0].headers]).toEqual(["POST", { "content-type": "application/json" }]);
    expect(JSON.parse(accepts[0].body!)).toEqual({ code: CODE, username: "mara" });
    expect([tab.$("choose-button").textContent, tab.$("choose-button").disabled, tab.$("choose-button").getAttribute("aria-busy"), tab.$("username").hasAttribute("readonly")]).toEqual(["Creating…", true, "true", true]);
    server.answer(OK);
    await tab.settle();
    expect(tab.left()).toBe("/connections");
    expect(tab.log.filter((l) => l.startsWith("replace ") || l.startsWith("assign "))).toEqual(["replace /connections"]);
    expect(tab.fetched.filter((f) => f.path === "/api/v1/invite/accept")).toHaveLength(1);
    expectCodeNowhere(tab);
  });

  it("Enter in the field presses the button; a held Enter's repeats do nothing", async () => {
    const tab = await chosen(answers({ [CHECK]: FOUND(), [ACCEPT]: { status: 409, json: { error: "username_taken" } } }));
    type(tab, "tess");
    const repeat = tab.$("username").dispatch("keydown", { key: "Enter", repeat: true });
    await tab.settle();
    expect([repeat.defaultPrevented, tab.fetched.length]).toEqual([true, 1]);
    const enter = tab.$("username").dispatch("keydown", { key: "Enter" });
    await tab.settle();
    expect([enter.defaultPrevented, tab.fetched.length]).toEqual([true, 2]);
    for (let i = 0; i < 5; i++) tab.$("username").dispatch("keydown", { key: "Enter", repeat: true });
    await tab.settle();
    expect(tab.fetched).toHaveLength(2);
    // Other keys type as usual.
    expect(tab.$("username").dispatch("keydown", { key: "a" }).defaultPrevented).toBe(false);
    // A held key on the button itself does not press it again.
    expect(tab.$("choose-button").dispatch("keydown", { key: "Enter", repeat: true }).defaultPrevented).toBe(true);
    expect(tab.$("choose-button").dispatch("keydown", { key: " ", repeat: true }).defaultPrevented).toBe(true);
  });

  it("a name the shape rule refuses is refused in the page without a request, shown as typed and never lowered", async () => {
    const tab = await chosen(answers({ [CHECK]: FOUND() }));
    for (const name of ["", "  ", "Mara_K", "Mara", "ma", "a".repeat(31), "4mara", "mara-", "ma--ra", "mára", "mar a", "<b>bold</b>", '"><img src=x onerror=alert(1)>', "x".repeat(200)]) {
      type(tab, name);
      tab.$("choose-button").click();
      await tab.settle();
      expect(tab.$("choose-message").textContent, name).toBe(BAD);
      expect(tab.$("username").getAttribute("aria-invalid"), name).toBe("true");
      expect(tab.$("username").value, name).toBe(name);
      expect(tab.doc.activeElement?.id, name).toBe("username");
    }
    expect(tab.fetched.map((f) => f.path)).toEqual(["/api/v1/invite/check"]);
    expect(tab.doc.root.all().filter((e) => e.tagName === "img" || e.tagName === "b")).toEqual([]);
    // Typing clears the sentence.
    type(tab, "mara");
    expect([tab.$("choose-message").textContent, tab.$("username").hasAttribute("aria-invalid")]).toEqual(["", false]);
  });

  it("the page's rule matches the server's for every lower-case name, and refuses what the server would only take lowered", async () => {
    const tab = await chosen(answers({ [CHECK]: FOUND(), [ACCEPT]: { status: 500, json: { error: "internal" } } }));
    const samples = [
      "mara", "mara-k", "m4ra", "abc", "a".repeat(30), "a".repeat(31), "ab", "mara_k", "mara-", "-mara", "ma--ra", "4mara", " mara ", "\tmara\n", "\rmara\r",
      "mara ", "mára", "mar a", "a-b", "a-bc", "ab-", "Kelvin", "kelvin", "admin", "ad-min", "my-mythicshot", "invite", "x-1-2-3",
      "Mara", "MARA", "Mara_K", "Admin",
    ];
    for (const s of samples) {
      type(tab, s);
      const before = tab.fetched.length;
      tab.$("choose-button").click();
      await tab.settle();
      const sent = tab.fetched.length > before;
      const server = parseUsername(s);
      if (/[A-Z]/.test(s)) {
        expect(sent, `${JSON.stringify(s)}: a capital is refused`).toBe(false);
        continue;
      }
      // Sent exactly when the server's shape rule takes it (a reserved name is the server's answer).
      expect(sent, JSON.stringify(s)).toBe(server.ok || server.problem === "reserved");
      if (sent) expect(JSON.parse(tab.fetched[tab.fetched.length - 1].body!).username, JSON.stringify(s)).toBe(server.ok ? server.username : s.trim());
    }
  });

  it("taken and reserved names say so under the field; the invite stays usable", async () => {
    const tab = await chosen(
      answers({
        [CHECK]: FOUND(),
        [ACCEPT]: [
          { status: 409, json: { error: "username_taken", detail: TAKEN } },
          { status: 400, json: { error: "reserved_username", detail: RESERVED } },
          { status: 400, json: { error: "bad_username", detail: BAD } },
          // The words the server sends are never what the page goes by: the code is.
          { status: 400, json: { error: "bad_username", detail: RESERVED } },
          OK,
        ],
      }),
    );
    for (const [name, words] of [["tess", TAKEN], ["admin", RESERVED], ["mara", BAD], ["mara", BAD]]) {
      type(tab, name);
      tab.$("choose-button").click();
      await tab.settle();
      expect(tab.$("choose-message").textContent, name).toBe(words);
      expect([tab.$("username").getAttribute("aria-invalid"), tab.doc.activeElement?.id, tab.$("choose-button").textContent, tab.$("choose-button").disabled, tab.$("username").hasAttribute("readonly")], name).toEqual(["true", "username", "Create my account", false, false]);
    }
    type(tab, "mara-k");
    tab.$("choose-button").click();
    await tab.settle();
    expect(tab.left()).toBe("/connections");
  });

  it("an accept refused as invite_invalid or has_account shows the dead-link page; signed_in shows the signed-in page", async () => {
    for (const [answer, page] of [
      [INVALID, DEAD],
      [{ status: 409, json: { error: "has_account", detail: "This address already has an account. Sign in instead." } }, DEAD],
      [SIGNED_IN, HERE],
    ] as [Answer, string[]][]) {
      const tab = await chosen(answers({ [CHECK]: FOUND(), [ACCEPT]: answer }));
      type(tab, "mara");
      tab.$("choose-button").click();
      await tab.settle();
      expect(tab.shows()).toEqual(page);
      // The code is forgotten.
      tab.$("choose-button").dispatch("click");
      await tab.settle();
      expect(tab.fetched.filter((f) => f.path === "/api/v1/invite/accept")).toHaveLength(1);
      expect(tab.left()).toBeNull();
    }
  });

  it("a failure keeps the code for another press, and too many tries waits", async () => {
    const tab = await chosen(answers({ [CHECK]: FOUND(), [ACCEPT]: ["network", { status: 500, json: { error: "internal" } }, { status: 403, json: { error: "bad_origin" } }, OK] }));
    type(tab, "mara");
    for (let i = 0; i < 3; i++) {
      tab.$("choose-button").click();
      await tab.settle();
      expect(tab.$("choose-message").textContent).toBe(FAILED);
      expect([tab.$("choose-button").textContent, tab.$("choose-button").disabled, tab.doc.activeElement?.id]).toEqual(["Create my account", false, "choose-button"]);
    }
    tab.$("choose-button").click();
    await tab.settle();
    expect(tab.left()).toBe("/connections");
    expect(tab.fetched.filter((f) => f.path === "/api/v1/invite/accept").map((f) => JSON.parse(f.body!))).toEqual(Array(4).fill({ code: CODE, username: "mara" }));

    const slow = await chosen(answers({ [CHECK]: FOUND(), [ACCEPT]: limited("120") }));
    type(slow, "mara");
    slow.$("choose-button").click();
    await slow.settle();
    expect(slow.$("choose-message").textContent).toBe("Too many tries. Wait 2 minutes and try again.");
    slow.$("choose-button").click();
    await slow.settle();
    expect(slow.fetched.filter((f) => f.path === "/api/v1/invite/accept")).toHaveLength(1);
    expect(slow.$("choose-message").textContent).toBe("Too many tries. Wait 2 minutes and try again.");
  });
});

// ---- Against the real app ----

/** A tab's fetch to the real app on the app address, as a browser sends it, with a cookie jar shared by the tabs of one browser. */
function browser(deps: Deps) {
  const jar = { cookie: null as string | null };
  const app = createApp(deps);
  const respond: Responder = async (req) => {
    const headers: Record<string, string> = { ...req.headers, "user-agent": FIREFOX };
    if (req.method !== "GET" && req.method !== "HEAD") Object.assign(headers, { origin: APP, "sec-fetch-site": "same-origin" });
    if (jar.cookie !== null) headers.cookie = jar.cookie;
    const res = await app.fetch(new Request(APP + req.path, { method: req.method, headers, body: req.body }));
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      jar.cookie = /Max-Age=0/.test(c) ? null : pair;
    }
    const text = await res.text();
    const retry = res.headers.get("retry-after");
    return { status: res.status, json: text === "" ? undefined : JSON.parse(text), headers: retry === null ? {} : ({ "retry-after": retry } as Record<string, string>) };
  };
  return {
    jar,
    invite: (url: string) => invitePage(url, respond),
    connections: () => openPage(CONNECTIONS_HTML, `${APP}/connections`, [["dash.js", DASH_JS], ["connections.js", CONNECTIONS_JS]], respond, true),
  };
}

/** The admin sends an invite to `email` through the real route; the link the mail holds. */
async function sendInvite(made: Awaited<ReturnType<typeof makeDeps>>, email: string): Promise<string> {
  const { deps, mail } = made;
  const admin = await seedAccount(deps, { admin: true, username: "solex" });
  const signed = await redeemSignInCode(deps, await createSignInCode(deps, admin.userId), FIREFOX, null);
  const cookie = `${SESSION_COOKIE}=${signed!.secret}`;
  const r = await send(deps, "POST", "/api/v1/admin/invites", {
    origin: APP,
    body: JSON.stringify({ email }),
    headers: { cookie, origin: APP, "x-csrf-token": await csrfFor(signed!.secret), "sec-fetch-site": "same-origin", "content-type": "application/json", "user-agent": FIREFOX },
  });
  expect(r.status).toBe(201);
  await made.settle();
  const sent = mail.sent.filter((m) => m.to === email);
  expect(sent).toHaveLength(1);
  return /https:\/\/app\.example\.com\/invite#dpi_[0-9a-f]{40}/.exec(sent[0].text)![0];
}

describe("the invite page against the real app", () => {
  it("send, open the link, check, choose, accept: signed in on the Connections page with the welcome; the same link again is dead", async () => {
    const made = await makeDeps({ hosts: { tours: "tours.example.com", app: "app.example.com" } });
    const { deps } = made;
    const link = await sendInvite(made, "mara@example.com");
    const code = link.slice(link.indexOf("#") + 1);
    const me = browser(deps);

    const page = me.invite(link);
    await page.settle();
    expect(page.url()).toBe(`${APP}/invite`);
    expect(page.shows()[2]).toBe(CHOOSE_LEAD("mara@example.com"));
    // A capital is refused in the page; the lower-case name is sent.
    type(page, "Mara");
    page.$("choose-button").click();
    await page.settle();
    expect(page.$("choose-message").textContent).toBe(BAD);
    type(page, "mara");
    page.$("choose-button").click();
    await page.settle();
    expect(page.left()).toBe("/connections");
    expect(me.jar.cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=dps_[0-9a-f]{64}$`));
    expectCodeNowhere(page, code);
    const account = await deps.db.first<{ username: string; email: string; is_admin: number }>("SELECT username, email, is_admin FROM user WHERE email = ?", ["mara@example.com"]);
    expect(account).toEqual({ username: "mara", email: "mara@example.com", is_admin: 0 });

    // The Connections page in the same browser: signed in as mara, the welcome above the heading.
    const conn = me.connections();
    await conn.settle();
    expect(conn.left()).toBeNull();
    expect(conn.$("dash-user").textContent).toBe("mara");
    expect(conn.shows().slice(0, 4)).toEqual([
      "Mythicshot",
      "mara",
      "Welcome, mara. Your workspace is ready. Connect Mythicshot on your computer to start sharing: open Workspace in Mythicshot, press Sign in, and type the code it shows below.",
      "Connections",
    ]);
    expect(conn.$("connections-empty").shown).toBe(true);
    expect(conn.fetched.map((f) => `${f.method} ${f.path}`)).toEqual(["GET /api/v1/session", "GET /api/v1/tokens", "GET /api/v1/usage"]);

    // The same link again, in another browser that is signed out: the dead-link page at once after the check.
    const again = browser(deps).invite(link);
    await again.settle();
    expect(again.shows()).toEqual(DEAD);
    // And in the browser that is now signed in: the signed-in page.
    const mine = me.invite(link);
    await mine.settle();
    expect(mine.shows()).toEqual(HERE);
  });

  it("two pages of one invite: the second accept meets the dead-link page; a name taken meanwhile says so", async () => {
    const made = await makeDeps({ hosts: { tours: "tours.example.com", app: "app.example.com" } });
    const { deps } = made;
    const link = await sendInvite(made, "tess@example.com");
    const first = browser(deps).invite(link);
    const second = browser(deps).invite(link);
    await first.settle();
    await second.settle();
    // The admin's username is taken.
    type(first, "solex");
    first.$("choose-button").click();
    await first.settle();
    expect(first.$("choose-message").textContent).toBe(TAKEN);
    // A reserved name: the server's own code.
    type(first, "admin");
    first.$("choose-button").click();
    await first.settle();
    expect(first.$("choose-message").textContent).toBe(RESERVED);
    type(first, "tess");
    first.$("choose-button").click();
    await first.settle();
    expect(first.left()).toBe("/connections");
    type(second, "tess-two");
    second.$("choose-button").click();
    await second.settle();
    expect(second.shows()).toEqual(DEAD);
  });

  it("a page opened with no code while signed out shows the dead-link page and asks nothing", async () => {
    const { deps } = await makeDeps({ hosts: { tours: "tours.example.com", app: "app.example.com" } });
    const tab = browser(deps).invite(`${APP}/invite`);
    await tab.settle();
    expect([tab.shows(), tab.fetched]).toEqual([DEAD, []]);
  });
});
