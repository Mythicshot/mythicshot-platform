// What the terms page's script, and the terms parts of the shared script, the Account page and
// the Admin page, do when they run: each page's document and scripts in one fresh Node `vm`
// context against the stand-in document (test/pages-dom.ts), with a stand-in address bar and a
// fetch that answers from the test or hands the request to the real app on fresh deps. Node
// only: the Workers runtime runs no code from a string.
//
// What this leaves unproven, for docs/dashboard-browser-check.md: real layout and scrolling,
// focus rings, the phone width, a screen reader.
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { createApp } from "../src/app.ts";
import { ACCOUNT_HTML, ACCOUNT_JS } from "../src/dash/account.ts";
import { ADMIN_HTML, ADMIN_JS } from "../src/dash/admin.ts";
import { DASH_JS } from "../src/dash/script.ts";
import { TERMS_HTML, TERMS_JS, TERMS_SAYS } from "../src/dash/terms.ts";
import { TOURS_HTML, TOURS_JS } from "../src/dash/tours.ts";
import type { Deps } from "../src/ports.ts";
import { SESSION_COOKIE, createSignInCode, redeemSignInCode } from "../src/sessions.ts";
import { parseTerms, publishTerms } from "../src/terms.ts";
import { FakeDocument, FakeElement, visibleText } from "./pages-dom.ts";

const APP = "https://app.example.com";
const CSRF = "c".repeat(64);
const ID = "trm_" + "1".repeat(24);
const ID2 = "trm_" + "2".repeat(24);
const NOW = Date.UTC(2026, 10, 21, 12);

type Answer = { status: number; json?: unknown } | "network";
type Fetched = { method: string; path: string; headers: Record<string, string>; body: string | undefined };
type Responder = (req: Fetched) => Answer | Promise<Answer>;

type Tab = { doc: FakeDocument; fetched: Fetched[]; left: () => string | null; $: (id: string) => FakeElement; shows: () => string[]; settle: () => Promise<void>; violations: string[] };

const open: Tab[] = [];
afterEach(() => {
  for (const tab of open.splice(0)) expect(tab.violations, "the script used something it must not").toEqual([]);
});

/** Opens a page at `url`, running its scripts in order, as a browser does with deferred scripts. */
function openPage(html: string, scripts: string[], url: string, respond: Responder): Tab {
  const doc = new FakeDocument(html);
  const current = new URL(url);
  let left: string | null = null;
  const fetched: Fetched[] = [];
  const pending: Promise<unknown>[] = [];
  const violations: string[] = [];
  const location = {
    get pathname() { return current.pathname; },
    get search() { return current.search; },
    get origin() { return APP; },
    get hash() { violations.push("location.hash"); return current.hash; },
    replace(path: string) { left = path; },
  };
  const fetch = (path: string, init: Record<string, unknown> = {}) => {
    const req: Fetched = { method: String(init.method ?? "GET"), path, headers: { ...(init.headers as Record<string, string>) }, body: init.body as string | undefined };
    fetched.push(req);
    const p = Promise.resolve(respond(req)).then((a) => {
      if (a === "network") throw new TypeError("Failed to fetch");
      return new Response(a.status === 204 || a.json === undefined ? null : JSON.stringify(a.json), { status: a.status, headers: { "content-type": "application/json" } });
    });
    pending.push(p.catch(() => {}));
    return p;
  };
  // The Tours page listens on the window for a page shown again; nothing here fires it.
  const context: Record<string, unknown> = { document: doc, location, fetch, addEventListener: () => {} };
  for (const name of ["localStorage", "sessionStorage", "indexedDB", "XMLHttpRequest", "WebSocket", "navigator", "window", "self", "top", "parent", "opener", "open", "postMessage", "setTimeout", "setInterval", "console", "alert", "confirm", "prompt", "history"]) {
    Object.defineProperty(context, name, { get() { violations.push(name); throw new Error(`${name} is not for these scripts`); } });
  }
  const ctx = vm.createContext(context);
  vm.runInContext(`(function () { var Real = Date; Date = function (v) { return arguments.length === 0 ? new Real(${NOW}) : new Real(v); }; Date.now = function () { return ${NOW}; }; Date.prototype = Real.prototype; })();`, ctx);
  for (const [i, js] of scripts.entries()) vm.runInContext(js, ctx, { filename: `script-${i}.js` });
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

const TERMS = (id = ID, more: Record<string, unknown> = {}) => ({
  id,
  title: "Mythicshot terms of service",
  version: "21 November 2026",
  points: ["You keep your rights.", "We store little."],
  links: [{ label: "terms", url: "https://example.com/terms" }, { label: "Your data", url: "https://example.com/data" }, { label: "Privacy", url: "https://example.com/privacy" }],
  body: [{ kind: "heading", text: "1. Who we are" }, { kind: "paragraph", text: "The owner runs it." }, { kind: "list", items: ["one", "two"] }],
  published_at: NOW,
  ...more,
});
const STATE = (o: Record<string, unknown> = {}): Answer => ({ status: 200, json: { terms: TERMS(), agreed: null, required: true, csrf: CSRF, ...o } });

describe("the terms screen", () => {
  it("shows the mockup's card with the current terms, every text as text, and the links line", async () => {
    const tab = openPage(TERMS_HTML, [TERMS_JS], `${APP}/terms?next=/connections`, answers({ "GET /api/v1/terms": STATE() }));
    await tab.settle();
    expect(tab.$("terms").shown).toBe(true);
    expect(tab.shows()).toEqual([
      "Before you start",
      "Mythicshot terms of service",
      "The main points",
      "You keep your rights.",
      "We store little.",
      "This list is a summary. The full terms below are what you agree to.",
      "The full terms · version of 21 November 2026",
      "The owner runs it.",
      "one",
      "two",
      "Open the terms, Your data and Privacy as pages",
      "Sign out",
      "I agree",
    ]);
    expect(tab.$("terms-box").all().map((e) => e.tagName)).toEqual(["h3", "p", "ul", "li", "li"]);
    const links = tab.$("terms-links").all().filter((e) => e.tagName === "a");
    expect(links.map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("target"), a.getAttribute("rel")])).toEqual([
      ["terms", "https://example.com/terms", "_blank", "noopener noreferrer"],
      ["Your data", "https://example.com/data", "_blank", "noopener noreferrer"],
      ["Privacy", "https://example.com/privacy", "_blank", "noopener noreferrer"],
    ]);
    expect(tab.doc.activeElement?.id).toBe("terms-title");
    expect(tab.$("terms-back").shown).toBe(false);
  });

  it("one link reads as a page; no link, no line", async () => {
    const one = openPage(TERMS_HTML, [TERMS_JS], `${APP}/terms`, answers({ "GET /api/v1/terms": STATE({ terms: TERMS(ID, { links: [{ label: "terms", url: "https://example.com/terms" }] }) }) }));
    await one.settle();
    expect(one.$("terms-links").textContent).toBe("Open the terms as a page");
    const none = openPage(TERMS_HTML, [TERMS_JS], `${APP}/terms`, answers({ "GET /api/v1/terms": STATE({ terms: TERMS(ID, { links: [] }) }) }));
    await none.settle();
    expect(none.$("terms-links").shown).toBe(false);
  });

  it("markup in any text stays text, and a link that is not of the strict shape never becomes an href", async () => {
    const evil = '<img src=x onerror=alert(1)>"></script>';
    const terms = TERMS(ID, {
      title: evil,
      version: evil,
      points: [evil],
      body: [{ kind: "heading", text: evil }, { kind: "paragraph", text: evil }, { kind: "list", items: [evil] }, { kind: "script", text: evil }],
      links: [{ label: evil, url: "javascript:alert(1)" }, { label: "x", url: "http://example.com/" }, { label: "y", url: "https://user:pw@example.com/" }, { label: "z", url: "https://example.com/a b" }, { label: 5, url: "https://example.com/" }],
    });
    const tab = openPage(TERMS_HTML, [TERMS_JS], `${APP}/terms`, answers({ "GET /api/v1/terms": STATE({ terms }) }));
    await tab.settle();
    expect(tab.$("terms-title").textContent).toBe(evil);
    expect(tab.$("terms-version").textContent).toBe("· version of " + evil);
    expect(tab.$("terms-box").all().map((e) => [e.tagName, e.textContent])).toEqual([["h3", evil], ["p", evil], ["ul", evil], ["li", evil]]);
    expect(tab.doc.root.all().some((e) => e.tagName === "img" || e.tagName === "script" && e.parent?.tagName !== "head")).toBe(false);
    expect(tab.$("terms-links").shown).toBe(false);
    expect(tab.doc.root.all().filter((e) => e.hasAttribute("href")).map((e) => e.getAttribute("href"))).toEqual(["/dash/dash.css", "/account"]);
  });

  it("I agree sends the version shown with the anti-forgery header, then goes back to the dashboard page that sent the person, a tab only", async () => {
    for (const [url, back] of [[`${APP}/terms?next=/connections`, "/connections"], [`${APP}/terms`, "/tours"], [`${APP}/terms?next=https://evil.example.net/`, "/tours"], [`${APP}/terms?next=//evil.example.net`, "/tours"], [`${APP}/terms?next=/terms`, "/tours"], [`${APP}/terms?next=%2Fadmin`, "/admin"]]) {
      const tab = openPage(TERMS_HTML, [TERMS_JS], url, answers({ "GET /api/v1/terms": STATE(), "POST /api/v1/terms/agree": { status: 204 } }));
      await tab.settle();
      tab.$("terms-agree").click();
      await tab.settle();
      const sent = tab.fetched.find((f) => f.method === "POST")!;
      expect([sent.path, sent.body, sent.headers["X-Csrf-Token"], sent.headers["content-type"]]).toEqual(["/api/v1/terms/agree", JSON.stringify({ terms: ID }), CSRF, "application/json"]);
      expect(tab.left(), url).toBe(back);
    }
  });

  it("a version published meanwhile: the screen shows the new one and says so; I agree then sends the new id", async () => {
    const tab = openPage(TERMS_HTML, [TERMS_JS], `${APP}/terms`, answers({ "GET /api/v1/terms": [STATE(), STATE({ terms: TERMS(ID2, { version: "1 December 2026" }) })], "POST /api/v1/terms/agree": [{ status: 409, json: { error: "terms_changed", detail: "x" } }, { status: 204 }] }));
    await tab.settle();
    tab.$("terms-agree").click();
    await tab.settle();
    expect(tab.left()).toBeNull();
    expect(tab.$("terms-version").textContent).toBe("· version of 1 December 2026");
    expect(tab.$("terms-message").textContent).toBe(TERMS_SAYS.changed);
    tab.$("terms-agree").click();
    await tab.settle();
    expect(tab.fetched.filter((f) => f.method === "POST").map((f) => f.body)).toEqual([JSON.stringify({ terms: ID }), JSON.stringify({ terms: ID2 })]);
    expect(tab.left()).toBe("/tours");
  });

  it("Sign out ends this session and goes to /signin; a failure says so and keeps the screen", async () => {
    const tab = openPage(TERMS_HTML, [TERMS_JS], `${APP}/terms`, answers({ "GET /api/v1/terms": STATE(), "POST /api/v1/signout": [{ status: 500, json: { error: "internal" } }, { status: 204 }] }));
    await tab.settle();
    tab.$("terms-signout").click();
    await tab.settle();
    expect(tab.$("terms-message").textContent).toBe(TERMS_SAYS.failed);
    expect(tab.left()).toBeNull();
    tab.$("terms-signout").click();
    await tab.settle();
    expect(tab.fetched.filter((f) => f.path === "/api/v1/signout").map((f) => f.headers["X-Csrf-Token"])).toEqual([CSRF, CSRF]);
    expect(tab.left()).toBe("/signin");
  });

  it("nothing to agree to goes on to the dashboard; no session goes to /signin; a failure says so", async () => {
    const done = openPage(TERMS_HTML, [TERMS_JS], `${APP}/terms?next=/account`, answers({ "GET /api/v1/terms": STATE({ required: false }) }));
    await done.settle();
    expect(done.left()).toBe("/account");
    const none = openPage(TERMS_HTML, [TERMS_JS], `${APP}/terms`, answers({ "GET /api/v1/terms": STATE({ terms: null, required: false }) }));
    await none.settle();
    expect(none.left()).toBe("/tours");
    const out = openPage(TERMS_HTML, [TERMS_JS], `${APP}/terms`, answers({ "GET /api/v1/terms": { status: 401, json: { error: "unauthorized" } } }));
    await out.settle();
    expect(out.left()).toBe("/signin");
    const broken = openPage(TERMS_HTML, [TERMS_JS], `${APP}/terms`, answers({ "GET /api/v1/terms": "network" }));
    await broken.settle();
    expect(broken.$("terms-load").textContent).toBe(TERMS_SAYS.failed);
    expect(broken.$("terms").shown).toBe(false);
  });
});

describe("the read-only terms", () => {
  it("shows the version agreed to and when, without the buttons, and a way back", async () => {
    const tab = openPage(TERMS_HTML, [TERMS_JS], `${APP}/terms?read`, answers({ "GET /api/v1/terms/agreed": { status: 200, json: { terms: TERMS(), agreed_at: NOW } } }));
    await tab.settle();
    expect(tab.$("terms-kicker").textContent).toBe("You agreed to these terms on 21 Nov 2026.");
    expect(tab.$("terms-actions").shown).toBe(false);
    expect(tab.$("terms-back").shown).toBe(true);
    expect(tab.shows()).not.toContain("I agree");
    expect(tab.fetched.map((f) => `${f.method} ${f.path}`)).toEqual(["GET /api/v1/terms/agreed"]);
  });

  it("an account that agreed to none sees the current terms, said so; a site with none says so", async () => {
    const current = openPage(TERMS_HTML, [TERMS_JS], `${APP}/terms?read`, answers({ "GET /api/v1/terms/agreed": { status: 200, json: { terms: null, agreed_at: null } }, "GET /api/v1/terms": STATE() }));
    await current.settle();
    expect(current.$("terms-kicker").textContent).toBe(TERMS_SAYS.current);
    const nothing = openPage(TERMS_HTML, [TERMS_JS], `${APP}/terms?read`, answers({ "GET /api/v1/terms/agreed": { status: 200, json: { terms: null, agreed_at: null } }, "GET /api/v1/terms": STATE({ terms: null, required: false }) }));
    await nothing.settle();
    expect(nothing.$("terms-title").textContent).toBe(TERMS_SAYS.noTerms);
    expect(nothing.$("terms-content").shown).toBe(false);
  });
});

describe("the dashboard while the terms wait", () => {
  it("a dashboard page whose session is held goes to the terms screen, naming itself, and shows nothing", async () => {
    const tab = openPage(TOURS_HTML, [DASH_JS, TOURS_JS], `${APP}/tours`, answers({ "GET /api/v1/session": { status: 403, json: { error: "terms_required", detail: "agree to the site's terms first" } } }));
    await tab.settle();
    expect(tab.left()).toBe("/terms?next=%2Ftours");
    expect(tab.fetched.map((f) => f.path)).toEqual(["/api/v1/session"]);
  });

  it("the Account page shows the line on the terms agreed to, and no line without one", async () => {
    const session = (extra: Record<string, unknown>): Answer => ({ status: 200, json: { account: { id: "usr_x", username: "solex", email: "you@example.com", admin: false }, workspace: { id: "ws_x", name: "W" }, session: { id: "ses_" + "a".repeat(24), created_at: NOW, expires_at: NOW + 1 }, csrf: CSRF, email_change: true, ...extra } });
    const sessions: Answer = { status: 200, json: { sessions: [] } };
    const tab = openPage(ACCOUNT_HTML, [DASH_JS, ACCOUNT_JS], `${APP}/account`, answers({ "GET /api/v1/session": session({ terms_agreed: { version: "21 November 2026", agreed_at: NOW } }), "GET /api/v1/sessions": sessions }));
    await tab.settle();
    expect(tab.$("terms-agreed").shown).toBe(true);
    expect(tab.$("terms-agreed-text").textContent).toBe("You agreed to the terms of 21 November 2026 on 21 Nov 2026.");
    expect(tab.$("terms-read").getAttribute("href")).toBe("/terms?read");
    const none = openPage(ACCOUNT_HTML, [DASH_JS, ACCOUNT_JS], `${APP}/account`, answers({ "GET /api/v1/session": session({}), "GET /api/v1/sessions": sessions }));
    await none.settle();
    expect(none.$("terms-agreed").shown).toBe(false);
    const evil = openPage(ACCOUNT_HTML, [DASH_JS, ACCOUNT_JS], `${APP}/account`, answers({ "GET /api/v1/session": session({ terms_agreed: { version: "<b>x</b>", agreed_at: NOW } }), "GET /api/v1/sessions": sessions }));
    await evil.settle();
    expect(evil.$("terms-agreed-text").textContent).toBe("You agreed to the terms of <b>x</b> on 21 Nov 2026.");
    expect(evil.$("terms-agreed-text").all()).toEqual([]);
  });
});

describe("the Admin page's Terms column", () => {
  const ADMIN_SESSION: Answer = { status: 200, json: { account: { id: "usr_" + "a".repeat(24), username: "owner", email: "owner@example.com", admin: true }, workspace: { id: "ws_" + "a".repeat(24), name: "W" }, session: { id: "ses_" + "a".repeat(24), created_at: NOW, expires_at: NOW + 1 }, csrf: CSRF, email_change: false } };
  const account = (n: string, terms: unknown) => ({ id: "usr_" + n.repeat(24), username: `user${n}`, email: `${n}@example.com`, status: "active", admin: n === "a", created_at: NOW, deleting: false, workspace_id: "ws_" + n.repeat(24), workspace_name: "W", tours: 0, used_bytes: 0, allowance_bytes: null, storage_allowance_bytes: null, over: false, counted: { pictures: 0, logos: 0, uploads_in_progress: 0, images: 0, gifs: 0 }, terms });
  const page = (list: Record<string, unknown>) =>
    openPage(ADMIN_HTML, [DASH_JS, ADMIN_JS], `${APP}/admin`, answers({
      "GET /api/v1/session": ADMIN_SESSION,
      "GET /api/v1/admin/summary": { status: 200, json: { accounts: 2, used_bytes: 0, standard_allowance_bytes: null } },
      "GET /api/v1/admin/accounts": { status: 200, json: { next: null, ...list } },
      "GET /api/v1/admin/invites": { status: 200, json: { invites: [] } },
    }));
  const cells = (tab: Tab) => tab.$("admin-rows").all().filter((e) => e.tagName === "td" && e.className === "terms").map((td) => td.children.map((c) => ("textContent" in c ? (c as FakeElement).textContent : "")));

  it("shows when the site has terms, whoever has agreed; an older agreement is Not yet with the older version under it", async () => {
    const tab = page({ current_terms: { version: "2 December 2026" }, accounts: [account("a", { version: "2 December 2026", agreed_at: NOW, current: true }), account("b", { version: "21 November 2026", agreed_at: NOW, current: false }), account("c", null)] });
    await tab.settle();
    expect(tab.$("accounts-table").className).toBe("accounts");
    expect(cells(tab)).toEqual([["2 December 2026", "21 Nov 2026"], ["Not yet", "Agreed to 21 November 2026 on 21 Nov 2026"], ["Not yet"]]);
    const nobody = page({ current_terms: { version: "1" }, accounts: [account("c", null)] });
    await nobody.settle();
    expect(nobody.$("accounts-table").className).toBe("accounts");
  });

  it("is hidden on a site with no terms, even beside a stray agreement", async () => {
    const tab = page({ current_terms: null, accounts: [account("a", { version: "x", agreed_at: NOW, current: false })] });
    await tab.settle();
    expect(tab.$("accounts-table").className).toBe("accounts no-terms");
  });
});

describe("against the real app", () => {
  it("a held person opens the dashboard, is sent to the terms screen, agrees, and the Account and Admin pages show it", async () => {
    const ctx = await makeDeps({ hosts: { tours: "tours.example.com", app: "app.example.com" } });
    const deps: Deps = ctx.deps;
    deps.now = () => NOW;
    const admin = await seedAccount(deps, { username: "owner", admin: true });
    const made = await redeemSignInCode(deps, await createSignInCode(deps, admin.userId), null, null);
    const cookie = `${SESSION_COOKIE}=${made!.secret}`;
    const read = await parseTerms(new TextEncoder().encode("title: Mythicshot terms of service\nversion: 21 November 2026\nmain points:\n- One.\nterms:\nThe terms.\n"));
    if (!read.ok) throw new Error(read.reason);
    await publishTerms(deps, read);
    const real: Responder = async (req) => {
      const headers: Record<string, string> = { ...req.headers, cookie };
      if (req.method !== "GET") Object.assign(headers, { origin: APP, "sec-fetch-site": "same-origin" });
      const res = await createApp(deps).fetch(new Request(APP + req.path, { method: req.method, headers, body: req.body }));
      const text = await res.text();
      return { status: res.status, json: text === "" ? undefined : JSON.parse(text) };
    };
    const tours = openPage(TOURS_HTML, [DASH_JS, TOURS_JS], `${APP}/tours`, real);
    await tours.settle();
    expect(tours.left()).toBe("/terms?next=%2Ftours");
    const screen = openPage(TERMS_HTML, [TERMS_JS], `${APP}/terms?next=/admin`, real);
    await screen.settle();
    expect(screen.$("terms-title").textContent).toBe("Mythicshot terms of service");
    screen.$("terms-agree").click();
    await screen.settle();
    expect(screen.left()).toBe("/admin");
    const account = openPage(ACCOUNT_HTML, [DASH_JS, ACCOUNT_JS], `${APP}/account`, real);
    await account.settle();
    expect(account.$("terms-agreed-text").textContent).toBe("You agreed to the terms of 21 November 2026 on 21 Nov 2026.");
    const adminPage = openPage(ADMIN_HTML, [DASH_JS, ADMIN_JS], `${APP}/admin`, real);
    await adminPage.settle();
    expect(adminPage.$("accounts-table").className).toBe("accounts");
    const cell = adminPage.$("admin-rows").all().find((e) => e.tagName === "td" && e.className === "terms")!;
    expect([cell.getAttribute("data-label"), cell.textContent]).toEqual(["Terms", "21 November 202621 Nov 2026"]);
  });
});
