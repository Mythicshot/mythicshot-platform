// What the viewer pages' script does when it runs: /view/view.js is run in a fresh Node `vm`
// context against a stand-in document built from each page's own HTML (test/pages-dom.ts),
// with a stand-in address bar, history and fetch, as test/node-invite-page.test.ts runs the
// invite page. The fetch either answers from the test, or is handed to the real app on fresh
// deps as a browser on the tours address sends it (Origin and Sec-Fetch-Site on changes, the
// viewer cookie kept in a jar); one walk goes from the gate through the mail and /view to the
// restricted tour's page and out again through "Not you?". Node only: the Workers runtime runs
// no code from a string.
//
// What this leaves unproven, for docs/dashboard-browser-check.md: real layout and focus, the
// browser's own handling of the policy, the cookie and the history.
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import type { Hosts } from "../src/hosts.ts";
import type { Deps } from "../src/ports.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import { VIEW_DENIED_HTML, VIEW_GATE_HTML, VIEW_JS, VIEW_LINK_HTML, VIEW_SIGNOUT_HTML } from "../src/view-page.ts";
import { VIEWER_COOKIE } from "../src/viewers.ts";
import { send, uploadTour } from "./bundle.ts";
import { manifestOf } from "./isolation-world.ts";
import { FakeDocument, FakeElement, visibleText } from "./pages-dom.ts";

const TOURS = "https://tours.example.com";
const APP = "https://app.example.com";
const TWO: Hosts = { tours: "tours.example.com", app: "app.example.com" };
const SLUG = "abcdefghij";
const CODE = "dpv_" + "0123456789abcdef0123456789abcdef01234567";
const NOW = Date.UTC(2026, 10, 20, 12);
const BRAND = "Mythicshot";
const FAILED = "Something went wrong. Try again in a moment.";
const OPEN_LEAD = (email: string) => `Press the button to view it in this browser as ${email}.`;
const REMEMBER = "This browser will remember your address for tours shared with you, for 30 days of use. It gives no access to anything else.";
const DEAD = [BRAND, "This link no longer works", "A link works once and for 15 minutes. Open the tour's own link again and ask for a new one.", "If you reloaded this page, open the link in your mail again."];
const ASK = [BRAND, "This tour is shared with specific people", "Enter your email address. If the tour is shared with you, we send you a link to open it. There is no password.", "Email address", "Send me a link"];
const SENT = (email: string) => [
  BRAND,
  "Check your mail",
  `If this tour is shared with ${email}, a link is on its way. It works once and for 15 minutes.`,
  "Nothing after a few minutes? Look in your spam folder, or check with the person who sent you the tour that they used this address. Try another address",
];
const DENIED = (email: string) => [
  BRAND,
  "This tour is not shared with you",
  `You are viewing as ${email}, and this tour is shared with other people. If you were given this link, ask the person who sent it to add your address.`,
  "Use another address",
];

type Answer = { status: number; json?: unknown; headers?: Record<string, string> } | "network";
type Fetched = { method: string; path: string; headers: Record<string, string>; body: string | undefined; init: Record<string, unknown> };
type Responder = (req: Fetched) => Answer | Promise<Answer>;

type Tab = {
  doc: FakeDocument;
  log: string[];
  fetched: Fetched[];
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

/** Opens `html` at `url` and runs the viewer pages' script, as a browser would after parsing the page. */
function openPage(html: string, url: string, respond: Responder): Tab {
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
  const banned = ["localStorage", "sessionStorage", "indexedDB", "caches", "cookieStore", "XMLHttpRequest", "WebSocket", "EventSource", "navigator", "window", "self", "top", "parent", "opener", "open", "postMessage", "setInterval", "setTimeout", "console", "alert", "confirm", "prompt"];
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
  vm.runInContext(VIEW_JS, ctx, { filename: "view.js" });
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
    violations,
  };
  open.push(tab);
  return tab;
}

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

const CHECK = "POST /api/v1/view/check";
const COMPLETE = "POST /api/v1/view/complete";
const REQUEST = "POST /api/v1/view/request";
const SIGNOUT = "POST /api/v1/view/signout";
const SESSION = "GET /api/v1/view/session";
const FOUND = (email = "mara@example.com", slug = SLUG): Answer => ({ status: 200, json: { email, slug } });
const INVALID: Answer = { status: 404, json: { error: "view_link_invalid", detail: "this link no longer works; open the tour's own link again and ask for a new one" } };
const limited = (seconds?: string): Answer => ({ status: 429, json: { error: "rate_limited" }, headers: seconds === undefined ? {} : { "retry-after": seconds } });

function expectCodeNowhere(tab: Tab, code = CODE): void {
  expect(tab.doc.root.all().some((e) => e.textContent.includes(code.slice(4)) || [...e.attrs.values()].some((v) => v.includes(code.slice(4)))), "the code is on the page").toBe(false);
  for (const f of tab.fetched) expect(f.path, "a request's address").not.toContain(code.slice(4));
  for (const f of tab.fetched) expect(f.path, "a request's address").not.toMatch(/[?#]/);
  expect(tab.url(), "the address bar").not.toContain(code.slice(4));
  for (const h of tab.history) expect(h, "a history entry").not.toContain(code.slice(4));
}

const linkPage = (url: string, respond: Responder) => openPage(VIEW_LINK_HTML, url, respond);

describe("the page a viewer link opens", () => {
  it("reads the code, cleans the address bar before anything else, then looks the code up with it in the body", async () => {
    const server = holding((r) => r.path === "/api/v1/view/check", answers({}));
    const tab = linkPage(`${TOURS}/view#${CODE}`, server.respond);
    expect(tab.log.slice(0, 2)).toEqual(["hash", "replaceState /view"]);
    expect(tab.log.findIndex((l) => l.startsWith("fetch "))).toBe(2);
    expect(tab.url()).toBe(`${TOURS}/view`);
    expect(tab.history).toEqual([`${TOURS}/view`]);
    expect(tab.shows()).toEqual([BRAND, "Opening your link"]);
    const req = tab.fetched[0];
    expect([req.method, req.path, req.headers]).toEqual(["POST", "/api/v1/view/check", { "content-type": "application/json" }]);
    expect(JSON.parse(req.body!)).toEqual({ code: CODE });
    expect([req.init.credentials, req.init.referrerPolicy, req.init.cache, req.init.redirect]).toEqual(["same-origin", "no-referrer", "no-store", "error"]);
    server.answer(FOUND());
    await tab.settle();
    expect(tab.shows()).toEqual([BRAND, "Open the tour", OPEN_LEAD("mara@example.com"), "Open the tour", REMEMBER]);
    expect(tab.doc.activeElement?.id).toBe("open-button");
    // Opening the link made no session: only the check was sent.
    expect(tab.fetched.map((f) => f.path)).toEqual(["/api/v1/view/check"]);
    expect(tab.left()).toBeNull();
    expectCodeNowhere(tab);
  });

  it("the press completes once, then goes to the tour with replace; a double press sends one completion", async () => {
    const server = holding((r) => r.path === "/api/v1/view/complete", answers({ [CHECK]: FOUND() }));
    const tab = linkPage(`${TOURS}/view#${CODE}`, server.respond);
    await tab.settle();
    tab.$("open-button").click();
    tab.$("open-button").click();
    tab.$("open-button").dispatch("click");
    expect(tab.$("open-button").textContent).toBe("Opening…");
    expect(tab.fetched.map((f) => `${f.method} ${f.path}`)).toEqual([CHECK, COMPLETE]);
    expect(JSON.parse(tab.fetched[1].body!)).toEqual({ code: CODE });
    server.answer({ status: 200, json: { slug: SLUG } });
    await tab.settle();
    expect(tab.left()).toBe(`/t/${SLUG}`);
    expect(tab.log.filter((l) => l.startsWith("replace ") || l.startsWith("assign "))).toEqual([`replace /t/${SLUG}`]);
    // The code was forgotten: nothing presses it again.
    tab.$("open-button").click();
    await tab.settle();
    expect(tab.fetched).toHaveLength(2);
    expectCodeNowhere(tab);
  });

  it("a slug of the wrong shape from the server goes nowhere", async () => {
    for (const slug of ["../admin", "//evil.example", "ABCDEFGHIJ", ""]) {
      const tab = await (async () => {
        const t = linkPage(`${TOURS}/view#${CODE}`, answers({ [CHECK]: FOUND(), [COMPLETE]: { status: 200, json: { slug } } }));
        await t.settle();
        t.$("open-button").click();
        await t.settle();
        return t;
      })();
      expect(tab.left(), slug).toBeNull();
      expect(tab.$("open-message").textContent, slug).toBe(FAILED);
    }
    const checked = linkPage(`${TOURS}/view#${CODE}`, answers({ [CHECK]: FOUND("mara@example.com", "../admin") }));
    await checked.settle();
    expect(checked.shows()).toEqual([BRAND, "Opening your link", FAILED, "Try again"]);
  });

  it("every dead link shows the one page, and a code of the wrong shape asks nothing", async () => {
    for (const url of [`${TOURS}/view`, `${TOURS}/view#`, `${TOURS}/view#dpv_`, `${TOURS}/view#${CODE.toUpperCase()}`, `${TOURS}/view#${CODE}0`, `${TOURS}/view#c=${CODE}`, `${TOURS}/view#dpi_${"0".repeat(40)}`, `${TOURS}/view?code=${CODE}`]) {
      const tab = linkPage(url, answers({}));
      await tab.settle();
      expect(tab.shows(), url).toEqual(DEAD);
      expect(tab.fetched, url).toEqual([]);
      expect(tab.doc.activeElement?.id, url).toBe("h-dead");
    }
    const refused = linkPage(`${TOURS}/view#${CODE}`, answers({ [CHECK]: INVALID }));
    await refused.settle();
    expect(refused.shows()).toEqual(DEAD);
    refused.$("open-button").click();
    await refused.settle();
    expect(refused.fetched).toHaveLength(1);
    // A completion refused (used meanwhile, in another tab): the same page.
    const used = linkPage(`${TOURS}/view#${CODE}`, answers({ [CHECK]: FOUND(), [COMPLETE]: INVALID }));
    await used.settle();
    used.$("open-button").click();
    await used.settle();
    expect(used.shows()).toEqual(DEAD);
  });

  it("a failure keeps the code in memory; too many tries says the wait and asks nothing until it is over", async () => {
    const tab = linkPage(`${TOURS}/view#${CODE}`, answers({ [CHECK]: ["network", FOUND()] }));
    await tab.settle();
    expect(tab.shows()).toEqual([BRAND, "Opening your link", FAILED, "Try again"]);
    tab.$("opening-button").click();
    await tab.settle();
    expect(tab.$("open").shown).toBe(true);
    for (const [answer, words] of [[limited("900"), "Too many tries. Wait 15 minutes and try again."], [limited("30"), "Too many tries. Wait 1 minute and try again."], [limited(), "Too many tries. Wait 15 minutes and try again."]] as const) {
      const t = linkPage(`${TOURS}/view#${CODE}`, answers({ [CHECK]: answer }));
      await t.settle();
      expect(t.shows()).toEqual([BRAND, "Opening your link", words, "Try again"]);
      t.$("opening-button").click();
      await t.settle();
      expect(t.fetched).toHaveLength(1);
    }
    const pressed = linkPage(`${TOURS}/view#${CODE}`, answers({ [CHECK]: FOUND(), [COMPLETE]: ["network", limited("120"), { status: 200, json: { slug: SLUG } }] }));
    await pressed.settle();
    pressed.$("open-button").click();
    await pressed.settle();
    expect(pressed.$("open-message").textContent).toBe(FAILED);
    pressed.$("open-button").click();
    await pressed.settle();
    expect(pressed.$("open-message").textContent).toBe("Too many tries. Wait 2 minutes and try again.");
    pressed.$("open-button").click();
    await pressed.settle();
    expect(pressed.fetched.map((f) => f.path)).toEqual(["/api/v1/view/check", "/api/v1/view/complete", "/api/v1/view/complete"]);
    expectCodeNowhere(pressed);
  });

  it("shows the address exactly as the check gave it, as text", async () => {
    const hostile = 'x"><img src=x onerror=alert(1)>@example.com';
    const tab = linkPage(`${TOURS}/view#${CODE}`, answers({ [CHECK]: FOUND(hostile) }));
    await tab.settle();
    const el = tab.$("open-email");
    expect([el.children.length, el.all(), el.textContent]).toEqual([1, [], hostile]);
    expect(tab.doc.root.all().filter((e) => e.tagName === "img")).toEqual([]);
  });
});

describe("the gate", () => {
  it("asks for a link for the tour of its own path, never of its query, then says the same thing for every address", async () => {
    const server = holding((r) => r.path === "/api/v1/view/request", answers({}));
    const tab = openPage(VIEW_GATE_HTML, `${TOURS}/t/${SLUG}?slug=zzzzzzzzzz#slug=zzzzzzzzzz`, server.respond);
    expect(tab.shows()).toEqual(ASK);
    expect(tab.doc.activeElement?.id).toBe("email");
    expect(tab.fetched).toEqual([]);
    tab.$("email").value = "  Mara@Example.com ";
    tab.$("ask-form").dispatch("submit");
    tab.$("ask-form").dispatch("submit");
    expect(tab.$("ask-button").textContent).toBe("Sending…");
    expect(tab.fetched.map((f) => `${f.method} ${f.path}`)).toEqual([REQUEST]);
    expect(JSON.parse(tab.fetched[0].body!)).toEqual({ email: "Mara@Example.com", slug: SLUG });
    server.answer({ status: 202, json: { ok: true } });
    await tab.settle();
    expect(tab.shows()).toEqual(SENT("Mara@Example.com"));
    expect(tab.doc.activeElement?.id).toBe("h-sent");
    tab.$("again").click();
    expect(tab.shows()).toEqual(ASK);
    expect(tab.$("sent-to").textContent).toBe("");
  });

  it("a malformed address asks nothing; a failure and too many tries say so in the form", async () => {
    const tab = openPage(VIEW_GATE_HTML, `${TOURS}/t/${SLUG}`, answers({ [REQUEST]: ["network", limited("600")] }));
    for (const bad of ["", "mara", "mara@", "@example.com", "a b@example.com"]) {
      tab.$("email").value = bad;
      tab.$("ask-form").dispatch("submit");
      expect(tab.$("ask-message").textContent, bad).toBe("That does not look like an email address.");
      expect(tab.$("email").getAttribute("aria-invalid"), bad).toBe("true");
    }
    expect(tab.fetched).toEqual([]);
    tab.$("email").value = "mara@example.com";
    tab.$("ask-form").dispatch("submit");
    await tab.settle();
    expect(tab.$("ask-message").textContent).toBe(FAILED);
    tab.$("ask-form").dispatch("submit");
    await tab.settle();
    expect(tab.$("ask-message").textContent).toBe("Too many tries. Wait 10 minutes and try again.");
    tab.$("ask-form").dispatch("submit");
    await tab.settle();
    expect(tab.fetched).toHaveLength(2);
  });
});

describe("the not-shared page and the sign-out page", () => {
  it("shows the proved address as text, and Use another address signs out on the press, then goes back to the tour", async () => {
    const tab = openPage(VIEW_DENIED_HTML, `${TOURS}/t/${SLUG}`, answers({ [SESSION]: { status: 200, json: { email: "bram@example.com" } }, [SIGNOUT]: { status: 204 } }));
    await tab.settle();
    expect(tab.shows()).toEqual(DENIED("bram@example.com"));
    expect(tab.fetched.map((f) => `${f.method} ${f.path}`)).toEqual([SESSION]);
    tab.$("denied-button").click();
    await tab.settle();
    expect(tab.fetched.map((f) => `${f.method} ${f.path}`)).toEqual([SESSION, SIGNOUT]);
    expect(tab.fetched[1].body).toBeUndefined();
    expect(tab.left()).toBe(`/t/${SLUG}`);
  });

  it("a session that ended meanwhile goes back to the tour; a failure offers Try again; a failed sign-out stays", async () => {
    const ended = openPage(VIEW_DENIED_HTML, `${TOURS}/t/${SLUG}`, answers({ [SESSION]: { status: 401, json: { error: "unauthorized" } } }));
    await ended.settle();
    expect(ended.left()).toBe(`/t/${SLUG}`);
    const failing = openPage(VIEW_DENIED_HTML, `${TOURS}/t/${SLUG}`, answers({ [SESSION]: ["network", { status: 200, json: { email: "bram@example.com" } }], [SIGNOUT]: "network" }));
    await failing.settle();
    expect(failing.shows()).toEqual([BRAND, "This tour is not shared with you", FAILED, "Try again"]);
    failing.$("opening-button").click();
    await failing.settle();
    expect(failing.shows()).toEqual(DENIED("bram@example.com"));
    failing.$("denied-button").click();
    await failing.settle();
    expect(failing.left()).toBeNull();
    expect(failing.$("denied-message").textContent).toBe(FAILED);
  });

  it("the sign-out page signs out only on the press, then goes to the tour of its own path", async () => {
    const tab = openPage(VIEW_SIGNOUT_HTML, `${TOURS}/view/signout/${SLUG}?to=zzzzzzzzzz`, answers({ [SIGNOUT]: { status: 204 } }));
    await tab.settle();
    expect(tab.shows()).toEqual([BRAND, "Not you?", "Sign this browser out of tours shared with you, then enter your own address on the tour's page.", "Use another address"]);
    expect(tab.fetched).toEqual([]);
    tab.$("signout-button").click();
    await tab.settle();
    expect(tab.fetched.map((f) => `${f.method} ${f.path}`)).toEqual([SIGNOUT]);
    expect(tab.left()).toBe(`/t/${SLUG}`);
  });
});

/** A browser on the tours address: fetches go to the real app with the viewer cookie it keeps, Origin and Sec-Fetch-Site on changes. */
function browser(deps: Deps) {
  const jar = new Map<string, string>();
  const respond: Responder = async (req) => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const headers: Record<string, string> = { ...req.headers, ...(cookie === "" ? {} : { cookie }) };
    if (req.method !== "GET") Object.assign(headers, { origin: TOURS, "sec-fetch-site": "same-origin" });
    const r = await send(deps, req.method, req.path, { origin: TOURS, headers, body: req.body });
    for (const set of r.headers.getSetCookie()) {
      const [pair, ...attrs] = set.split(";");
      const [name, value] = [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
      if (value === "" || attrs.some((a) => a.trim() === "Max-Age=0")) jar.delete(name);
      else jar.set(name, value);
    }
    return { status: r.status, json: r.json ?? undefined, headers: Object.fromEntries(r.headers.entries()) };
  };
  const page = (path: string) => send(deps, "GET", path, { origin: TOURS, headers: jar.size === 0 ? {} : { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } });
  return { jar, respond, page };
}

describe("the whole walk through the real routes", () => {
  it("gate, mail, the link's page, the tour with its line, Not you?, and the gate again", { timeout: 300_000 }, async () => {
    const { deps, mail, settle } = await makeDeps({ hosts: TWO });
    const owner = await seedAccount(deps, { admin: true, username: "walker" });
    const made = await redeemSignInCode(deps, await createSignInCode(deps, owner.userId), null, null);
    const t = await uploadTour(deps, owner.token, manifestOf([310, 311], "Walk-through tour", true), { kind: "new" }, 9);
    const slug = (await deps.db.first<{ slug: string }>("SELECT slug FROM tour WHERE id = ?", [t.tour_id]))!.slug;
    const put = await send(deps, "PUT", `/api/v1/tours/${t.tour_id}/access`, {
      origin: APP,
      headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${made!.secret}`, "x-csrf-token": await csrfFor(made!.secret), origin: APP, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ access: "people", viewers: ["mara@example.com"] }),
    });
    expect(put.status).toBe(200);
    let r = await send(deps, "POST", `/api/v1/tours/${t.tour_id}/publish`, { token: owner.token });
    while (r.status === 202) r = await send(deps, "POST", `/api/v1/tours/${t.tour_id}/publish`, { token: owner.token, headers: { "content-type": "application/json" }, body: JSON.stringify({ publish_id: r.json.publish_id }) });
    expect(r.status).toBe(200);

    const b = browser(deps);
    const first = await b.page(`/t/${slug}`);
    expect([first.status, first.text]).toEqual([403, VIEW_GATE_HTML]);
    const gate = openPage(first.text, `${TOURS}/t/${slug}`, b.respond);
    gate.$("email").value = "mara@example.com";
    gate.$("ask-form").dispatch("submit");
    await gate.settle();
    await settle();
    expect(gate.shows()).toEqual(SENT("mara@example.com"));
    expect(mail.sent.map((m) => m.to)).toEqual(["mara@example.com"]);
    const link = /https?:\/\/[^\s]+\/view#dpv_[0-9a-f]{40}/.exec(mail.sent[0].text)![0];
    expect(link.startsWith(`${TOURS}/view#`)).toBe(true);

    const view = await b.page("/view");
    const opened = openPage(view.text, link, b.respond);
    await opened.settle();
    expect(opened.shows()).toEqual([BRAND, "Open the tour", OPEN_LEAD("mara@example.com"), "Open the tour", REMEMBER]);
    expect(b.jar.size).toBe(0);
    opened.$("open-button").click();
    await opened.settle();
    expect(opened.left()).toBe(`/t/${slug}`);
    expect([...b.jar.keys()]).toEqual([VIEWER_COOKIE]);
    expectCodeNowhere(opened, link.slice(link.indexOf("#") + 1));

    const tour = await b.page(`/t/${slug}`);
    expect(tour.status).toBe(200);
    expect(tour.text).toContain("<title>Walk-through tour</title>");
    expect(tour.text).toContain(`<p class="dp-shared">Shared with you, mara@example.com · <a href="/view/signout/${slug}">Not you?</a></p>`);
    const names = [...tour.text.matchAll(/"v\/([0-9a-f]{32}\.png)"/g)].map((m) => m[1]);
    expect(names).toHaveLength(3);
    for (const name of names) expect((await b.page(`/t/${slug}/v/${name}`)).status).toBe(200);

    const signout = await b.page(`/view/signout/${slug}`);
    const out = openPage(signout.text, `${TOURS}/view/signout/${slug}`, b.respond);
    out.$("signout-button").click();
    await out.settle();
    expect(out.left()).toBe(`/t/${slug}`);
    expect(b.jar.size).toBe(0);
    expect((await b.page(`/t/${slug}`)).text).toBe(VIEW_GATE_HTML);
    for (const name of names) expect((await b.page(`/t/${slug}/v/${name}`)).status).toBe(404);
  });
});
