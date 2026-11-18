// The documentation page's built script (DOCS_JS), run as a browser would run it, against
// a stand-in page: just enough of a document, a viewer and a network to watch what the
// script does with a pasted token. No browser is involved, so this says nothing about
// how the page looks; it holds the script to its rules: the token goes only to this
// site's /api/v1/me and through the viewer's interceptor, never with a cookie, never into
// any store, and "Forget token" really forgets.
//
// The stand-in viewer does what the real one does with a request it sends: it keeps the
// request as the interceptor left it (Authorization header included) in its own store and
// draws it on the page. So a token that is forgotten, replaced or refused must be gone
// from every viewer still on the page, which is only true if the old viewer is thrown away.
//
// Node only: it uses node:vm, which the Workers runtime does not have.
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { REFUSED, type ViewerRequest } from "../src/docs/client/rules.ts";
import { GUIDE_ORIGIN } from "../src/docs/guides.ts";
import { GET_STARTED } from "../src/docs/openapi.ts";
import { docsHtml } from "../src/docs/page.ts";
import { DOCS_JS } from "../src/docs/site-assets.ts";

const SITE = "http://localhost:8787";
const TOKEN = "dp_" + "0".repeat(40);
const OTHER = "dp_" + "1".repeat(40);

type Listener = (event: { key?: string }) => void;

/** As much of an element as the script touches. */
class El {
  hidden = false;
  textContent = "";
  className = "";
  value = "";
  focused = 0;
  children: El[] = [];
  parts: Record<string, El | null> = {};
  private listeners: Record<string, Listener[]> = {};
  addEventListener(type: string, listener: Listener): void {
    (this.listeners[type] ??= []).push(listener);
  }
  fire(type: string, event: { key?: string } = {}): void {
    for (const l of this.listeners[type] ?? []) l(event);
  }
  focus(): void {
    this.focused++;
  }
  querySelector(selector: string): El | null {
    return this.parts[selector] ?? null;
  }
  replaceChildren(...nodes: El[]): void {
    this.children = nodes;
  }
}

type Fetched = { url: string; init: Record<string, any> };
type Answer = { status: number; body?: unknown } | "network error";

/** A page, a viewer and a network for the script, and what it did to them. */
function standIn(opts: { dark?: boolean; viewer?: boolean; clipboard?: boolean; hash?: string } = {}) {
  const html = docsHtml();
  const el = (hidden = false) => Object.assign(new El(), { hidden });
  const byId: Record<string, El> = {
    "token-box": el(html.includes('id="token-box" hidden')),
    token: el(),
    "use-token": el(),
    "forget-token": el(html.includes('id="forget-token" class="quiet" hidden')),
    "token-status": el(),
    "guide-errors-and-limits": el(),
  };
  // Every command of the real page, each with its copy button, hidden as the page has it.
  const commands = [...html.matchAll(/<div class="command"><pre><code[^>]*>([^<]*)<\/code><\/pre><button type="button" hidden>Copy<\/button><\/div>/g)].map((m) => {
    const code = Object.assign(new El(), { textContent: m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&") });
    const button = Object.assign(new El(), { hidden: true, textContent: "Copy" });
    return Object.assign(new El(), { parts: { code, button } as Record<string, El | null> });
  });
  const mount = new El();
  const scrolled: string[] = [];
  for (const [id, e] of Object.entries(byId)) Object.assign(e, { scrollIntoView: () => scrolled.push(id) });
  const classes = new Set<string>();
  const media = { matches: opts.dark === true, listeners: [] as (() => void)[], addEventListener: (_: string, l: () => void) => media.listeners.push(l) };
  const fetched: Fetched[] = [];
  const answers: Answer[] = [];
  const copied: string[] = [];
  const timers: (() => void)[] = [];
  /** Every viewer started: its options, the requests it keeps, and what it drew. */
  const viewers: { options: Record<string, any>; store: string[]; el: El }[] = [];
  const started: Record<string, any>[] = [];
  const touched: string[] = [];
  const forbidden = (name: string) => ({ get: () => (touched.push(name), undefined), set: () => void touched.push(name), enumerable: true });

  const document = {
    getElementById: (id: string) => byId[id] ?? null,
    querySelector: (selector: string) => (selector === "#reference" ? mount : null),
    querySelectorAll: (selector: string) => (selector === ".command" ? commands : []),
    createElement: (_tag: string) => new El(),
    documentElement: { classList: { toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)) } },
  };
  Object.defineProperty(document, "cookie", forbidden("document.cookie"));

  const sandbox: Record<string, any> = {
    document,
    location: Object.freeze({ origin: SITE, href: `${SITE}/docs${opts.hash ?? ""}`, hash: opts.hash ?? "" }),
    navigator: opts.clipboard === false ? {} : { clipboard: { writeText: (text: string) => (copied.push(text), Promise.resolve()) } },
    matchMedia: (query: string) => (query === "(prefers-color-scheme: dark)" ? media : { matches: false, addEventListener: () => undefined }),
    fetch: (url: string, init: Record<string, any>) => {
      fetched.push({ url, init });
      const answer = answers.shift() ?? "network error";
      if (answer === "network error") return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve({ status: answer.status, json: () => (answer.body === undefined ? Promise.reject(new SyntaxError("no body")) : Promise.resolve(answer.body)) });
    },
    setTimeout: (fn: () => void) => timers.push(fn),
    clearTimeout: () => undefined,
    URL,
  };
  if (opts.viewer !== false) {
    sandbox.SwaggerUIBundle = Object.assign(
      (options: Record<string, any>) => {
        started.push(options);
        // A viewer draws itself into the mount, replacing what was there, and has a store of its own.
        const viewer = { options, store: [] as string[], el: new El() };
        viewers.push(viewer);
        mount.children = [viewer.el];
        // Its store has no way to forget a request, like the real one's.
        return { getStore: () => viewer.store };
      },
      { presets: { apis: "the apis preset" } },
    );
  }
  // Every store a page has: looking at one is recorded, and fails the test.
  for (const name of ["localStorage", "sessionStorage", "indexedDB", "caches", "cookieStore", "name", "history", "opener", "parent", "top", "XMLHttpRequest", "WebSocket", "EventSource", "BroadcastChannel"]) {
    Object.defineProperty(sandbox, name, forbidden(name));
  }
  const context = vm.createContext(sandbox);
  const before = new Set(Object.getOwnPropertyNames(sandbox));
  vm.runInContext(DOCS_JS, context, { filename: "docs.js" });

  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  return {
    byId, commands, mount, classes, media, fetched, answers, copied, timers, viewers, started, touched, scrolled, settle,
    /** "Execute" in the viewer on the page: the request passes the interceptor, then the viewer keeps it and draws it. */
    execute(url: string): string {
      const viewer = viewers.find((v) => mount.children.includes(v.el));
      if (viewer === undefined) throw new Error("no viewer on the page");
      const sent = JSON.stringify(viewer.options.requestInterceptor({ url, headers: {} }));
      viewer.store.push(sent);
      viewer.el.textContent += `curl ${sent}\n`;
      return sent;
    },
    /** Everything a viewer that is still on the page holds or shows. */
    viewersOnPage: () => JSON.stringify(viewers.filter((v) => mount.children.includes(v.el)).map((v) => [v.store, v.el.textContent])),
    /** Types into the field and presses "Use token", then lets the answer arrive. */
    async use(text: string, answer?: Answer) {
      if (answer !== undefined) answers.push(answer);
      byId.token.value = text;
      byId["use-token"].fire("click");
      await settle();
    },
    /** What a request of the viewer becomes on its way out: its headers, or the refusal. */
    through(url: string, more: Partial<ViewerRequest> = {}): ViewerRequest | string {
      try {
        return started[started.length - 1].requestInterceptor({ url, headers: {}, ...more }) as ViewerRequest;
      } catch (err) {
        return (err as Error).message;
      }
    },
    /** Globals the script left behind. */
    added: () => Object.getOwnPropertyNames(sandbox).filter((n) => !before.has(n)),
    /** Everything the page shows or holds after the script ran, as one text. */
    everything: () => JSON.stringify([Object.values(byId).map((e) => [e.textContent, e.value, e.className]), commands.map((c) => [c.parts.code!.textContent, c.parts.button!.textContent]), mount.children.map((c) => c.textContent), [...classes]]),
  };
}

describe("the documentation page's script on a stand-in page", () => {
  it("on load it shows the token box, puts this site's address in every command and starts the viewer, and asks the network nothing", async () => {
    const page = standIn();
    await page.settle();
    expect(page.byId["token-box"].hidden).toBe(false);
    expect(page.byId["forget-token"].hidden).toBe(true);
    expect(page.byId["token-status"].textContent).toBe("");
    expect(page.commands.length).toBeGreaterThan(10);
    for (const c of page.commands) {
      const text = c.parts.code!.textContent;
      expect(text.startsWith("curl "), text).toBe(true);
      expect(text, text).toContain(`${SITE}/api/v1/`);
      expect(text, text).not.toContain(GUIDE_ORIGIN);
      expect(text, text).not.toContain("YOUR-SITE");
      expect(c.parts.button!.hidden).toBe(false);
    }
    expect(page.commands[0].parts.code!.textContent).toBe(GET_STARTED.replace(GUIDE_ORIGIN, SITE));
    expect(page.fetched).toEqual([]);

    expect(page.started).toHaveLength(1);
    const { requestInterceptor, onComplete, ...options } = page.started[0];
    expect(options).toEqual({
      url: "/api/v1/openapi.json",
      dom_id: "#reference",
      layout: "BaseLayout",
      presets: ["the apis preset"],
      validatorUrl: null,
      persistAuthorization: false,
      deepLinking: true,
      docExpansion: "list",
      defaultModelsExpandDepth: -1,
      requestSnippetsEnabled: true,
      withCredentials: false,
    });
    expect(typeof requestInterceptor).toBe("function");
    expect(typeof onComplete).toBe("function");
    expect(page.mount.children).toEqual([page.viewers[0].el]);
    // Without a token the viewer's requests go out bare, and only to this site's API.
    expect(page.through("/api/v1/me")).toEqual({ url: "/api/v1/me", credentials: "omit", headers: {} });
    expect(page.through("/api/v1/openapi.json", { loadSpec: true })).toEqual({ url: "/api/v1/openapi.json", loadSpec: true, credentials: "omit", headers: {} });
    expect(page.through("https://evil.example.net/api/v1/me")).toBe(REFUSED);
    expect(page.through("/setup/claim")).toBe(REFUSED);
    // It left no global behind and looked at no store.
    expect(page.added()).toEqual([]);
    expect(page.touched).toEqual([]);
  });

  it("refuses text that is not a token without asking the server", async () => {
    const page = standIn();
    for (const text of ["", "hello", "YOUR_TOKEN", TOKEN.slice(0, -1), TOKEN + "0", `Bearer ${TOKEN}`]) {
      await page.use(text);
      expect(page.byId["token-status"].textContent, text).toBe("That does not look like a token. A token starts with dp_ and is 43 characters long.");
      expect(page.byId["token-status"].className).toBe("status bad");
    }
    expect(page.fetched).toEqual([]);
    expect(page.byId["forget-token"].hidden).toBe(true);
    expect(page.through("/api/v1/me")).toEqual({ url: "/api/v1/me", credentials: "omit", headers: {} });
  });

  it("Use token asks /api/v1/me without cookies, then the calls on the page carry the token to this site's API only", async () => {
    const page = standIn();
    page.answers.push({ status: 200, body: { workspace: "Acme <b>&", version: "0.0.0" } });
    page.byId.token.value = `  ${TOKEN}\n`;
    page.byId["use-token"].fire("click");
    // While the answer is on its way.
    expect(page.byId["token-status"].textContent).toBe("Checking…");
    expect(page.through("/api/v1/me")).toEqual({ url: "/api/v1/me", credentials: "omit", headers: {} });
    await page.settle();

    expect(page.fetched).toEqual([{ url: "/api/v1/me", init: { credentials: "omit", headers: { Authorization: `Bearer ${TOKEN}` }, cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" } }]);
    // The workspace's name is shown as text, whatever it holds.
    expect(page.byId["token-status"].textContent).toBe("Connected to Acme <b>&. The calls on this page now use this token.");
    expect(page.byId["token-status"].className).toBe("status ok");
    expect(page.byId.token.value).toBe("");
    expect(page.byId["forget-token"].hidden).toBe(false);

    const authorised = { credentials: "omit", headers: { Authorization: `Bearer ${TOKEN}` } };
    expect(page.through("/api/v1/tours")).toEqual({ url: "/api/v1/tours", ...authorised });
    expect(page.through(`${SITE}/api/v1/me`)).toEqual({ url: `${SITE}/api/v1/me`, ...authorised });
    // Not when fetching the description, not to the health check, and nowhere else at all.
    expect(page.through("/api/v1/openapi.json", { loadSpec: true })).toEqual({ url: "/api/v1/openapi.json", loadSpec: true, credentials: "omit", headers: {} });
    expect(page.through("/healthz")).toEqual({ url: "/healthz", credentials: "omit", headers: {} });
    for (const url of ["https://evil.example.net/api/v1/me", "http://localhost:9999/api/v1/me", "https://localhost:8787/api/v1/me", "//evil.example.net/api/v1/me", "/setup/claim", "/docs", "/api/v1/../setup"]) {
      expect(page.through(url), url).toBe(REFUSED);
    }

    // The token is nowhere on the page, in no global and in no store.
    expect(page.everything()).not.toContain(TOKEN);
    expect(page.added()).toEqual([]);
    expect(page.touched).toEqual([]);
    expect(page.copied).toEqual([]);
  });

  it("the Enter key in the field does what the button does", async () => {
    const page = standIn();
    page.answers.push({ status: 200, body: { workspace: "Acme" } });
    page.byId.token.value = TOKEN;
    page.byId.token.fire("keydown", { key: "a" });
    await page.settle();
    expect(page.fetched).toEqual([]);
    page.byId.token.fire("keydown", { key: "Enter" });
    await page.settle();
    expect(page.fetched).toHaveLength(1);
    expect(page.byId["token-status"].textContent).toBe("Connected to Acme. The calls on this page now use this token.");
  });

  it("a token the server does not know is not used, and neither is the one before it", async () => {
    const page = standIn();
    await page.use(TOKEN, { status: 200, body: { workspace: "Acme" } });
    expect(page.through("/api/v1/me")).toEqual({ url: "/api/v1/me", credentials: "omit", headers: { Authorization: `Bearer ${TOKEN}` } });

    for (const status of [401, 404]) {
      await page.use(OTHER, { status, body: { error: "unauthorized" } });
      expect(page.byId["token-status"].textContent, String(status)).toBe("The server does not know this token. Check that you pasted all of it.");
      expect(page.byId["token-status"].className).toBe("status bad");
      expect(page.byId.token.value).toBe("");
      expect(page.byId["forget-token"].hidden).toBe(true);
      expect(page.through("/api/v1/me")).toEqual({ url: "/api/v1/me", credentials: "omit", headers: {} });
    }
    expect(page.fetched.map((f) => f.init.headers.Authorization)).toEqual([`Bearer ${TOKEN}`, `Bearer ${OTHER}`, `Bearer ${OTHER}`]);
    expect(page.everything()).not.toContain("dp_0");
    expect(page.everything()).not.toContain("dp_1");
  });

  it("a server that cannot be reached, or answers something else, is said so and no token is used", async () => {
    const page = standIn();
    const cases: Answer[] = ["network error", { status: 500, body: { error: "internal" } }, { status: 421 }, { status: 200 }, { status: 200, body: { workspace: 7 } }, { status: 200, body: null }, { status: 308 }];
    for (const answer of cases) {
      await page.use(TOKEN, answer);
      expect(page.byId["token-status"].textContent, JSON.stringify(answer)).toBe("The server could not be reached. Try again.");
      expect(page.byId["token-status"].className).toBe("status bad");
      expect(page.byId["forget-token"].hidden).toBe(true);
      expect(page.through("/api/v1/me")).toEqual({ url: "/api/v1/me", credentials: "omit", headers: {} });
      // The field keeps what was typed, to try again; it is a password field.
      expect(page.byId.token.value).toBe(TOKEN);
    }
    expect(page.fetched).toHaveLength(cases.length);
    for (const f of page.fetched) expect(f.init.credentials).toBe("omit");
  });

  it("an answer that arrives after a newer attempt changes nothing", async () => {
    const page = standIn();
    // The first check is still on its way when the visitor types something that is no token.
    page.answers.push({ status: 200, body: { workspace: "Acme" } });
    page.byId.token.value = TOKEN;
    page.byId["use-token"].fire("click");
    page.byId.token.value = "oops";
    page.byId["use-token"].fire("click");
    await page.settle();
    expect(page.byId["token-status"].textContent).toBe("That does not look like a token. A token starts with dp_ and is 43 characters long.");
    expect(page.byId["forget-token"].hidden).toBe(true);
    expect(page.through("/api/v1/me")).toEqual({ url: "/api/v1/me", credentials: "omit", headers: {} });
  });

  it("Forget token empties the variable and throws the viewer away, so nothing on the page holds or shows the token", async () => {
    const page = standIn();
    await page.use(TOKEN, { status: 200, body: { workspace: "Acme" } });
    expect(page.viewers).toHaveLength(1);
    // The visitor tries two calls: the viewer now keeps and shows the token.
    expect(page.execute("/api/v1/me")).toContain(TOKEN);
    page.execute("/api/v1/tours");
    expect(page.viewersOnPage().split(TOKEN).length - 1).toBe(4);
    expect(page.everything()).toContain(TOKEN);

    page.byId["forget-token"].fire("click");
    await page.settle();
    expect(page.byId["token-status"].textContent).toBe("Token forgotten.");
    expect(page.byId["token-status"].className).toBe("status");
    expect(page.byId["forget-token"].hidden).toBe(true);
    expect(page.byId.token.value).toBe("");
    expect(page.byId.token.focused).toBe(1);
    // A new viewer is on the page, the old one is not, and the new one holds nothing.
    expect(page.viewers).toHaveLength(2);
    expect(page.mount.children).toEqual([page.viewers[1].el]);
    expect(page.viewers[1].store).toEqual([]);
    expect(page.viewersOnPage()).toBe('[[[],""]]');
    expect(page.viewersOnPage()).not.toContain("dp_");
    expect(page.everything()).not.toContain(TOKEN);
    // The new viewer was started exactly as the first, and its calls go out bare; so would the old one's.
    const { requestInterceptor: _a, onComplete: _b, ...first } = page.viewers[0].options;
    const { requestInterceptor: _c, onComplete: _d, ...second } = page.viewers[1].options;
    expect(second).toEqual(first);
    expect(page.execute("/api/v1/me")).toBe('{"url":"/api/v1/me","headers":{},"credentials":"omit"}');
    expect(page.viewers[0].options.requestInterceptor({ url: "/api/v1/me", headers: {} })).toEqual({ url: "/api/v1/me", credentials: "omit", headers: {} });
    expect(page.fetched).toHaveLength(1);
    expect(page.touched).toEqual([]);
    expect(page.added()).toEqual([]);

    // Forgetting while a check is on its way drops that check's answer, too; no token was in use, so the viewer stays.
    page.answers.push({ status: 200, body: { workspace: "Acme" } });
    page.byId.token.value = TOKEN;
    page.byId["use-token"].fire("click");
    page.byId["forget-token"].fire("click");
    await page.settle();
    expect(page.byId["token-status"].textContent).toBe("Token forgotten.");
    expect(page.through("/api/v1/me")).toEqual({ url: "/api/v1/me", credentials: "omit", headers: {} });
    expect(page.viewers).toHaveLength(2);
  });

  it("a token that is replaced, or lost to a failed attempt, is gone from the viewer on the page as well", async () => {
    // What is typed next, the answer to it, and what the box says; in every case the old token must be gone.
    const cases: [string, Answer | undefined, string][] = [
      [OTHER, { status: 200, body: { workspace: "Other" } }, "Connected to Other. The calls on this page now use this token."],
      [OTHER, { status: 401, body: { error: "unauthorized" } }, "The server does not know this token. Check that you pasted all of it."],
      [OTHER, "network error", "The server could not be reached. Try again."],
      [TOKEN, { status: 401, body: { error: "unauthorized" } }, "The server does not know this token. Check that you pasted all of it."],
      ["not a token", undefined, "That does not look like a token. A token starts with dp_ and is 43 characters long."],
      ["", undefined, "That does not look like a token. A token starts with dp_ and is 43 characters long."],
    ];
    for (const [typed, answer, says] of cases) {
      const page = standIn();
      await page.use(TOKEN, { status: 200, body: { workspace: "Acme" } });
      page.execute("/api/v1/me");
      page.execute("/api/v1/tours");
      expect(page.viewersOnPage(), typed).toContain(TOKEN);

      // The viewer is replaced as soon as the new attempt starts, before any answer.
      if (answer !== undefined) page.answers.push(answer);
      page.byId.token.value = typed;
      page.byId["use-token"].fire("click");
      expect(page.viewers, typed).toHaveLength(2);
      expect(page.viewersOnPage(), typed).toBe('[[[],""]]');
      await page.settle();

      expect(page.byId["token-status"].textContent, typed).toBe(says);
      expect(page.mount.children, typed).toEqual([page.viewers[1].el]);
      // Nothing of the first token is held or shown by a viewer on the page, whatever came of the attempt.
      expect(page.everything().includes(TOKEN), typed).toBe(false);
      expect(page.viewersOnPage(), typed).toBe('[[[],""]]');
      const connected = says.startsWith("Connected");
      expect(page.execute("/api/v1/me").includes(TOKEN), typed).toBe(false);
      expect(page.execute("/api/v1/me").includes(OTHER), typed).toBe(connected);
      expect(page.byId["forget-token"].hidden, typed).toBe(!connected);
      // The old viewer, should anything of it still run, sends no more than the new one.
      expect(JSON.stringify(page.viewers[0].options.requestInterceptor({ url: "/api/v1/me", headers: {} })).includes(TOKEN), typed).toBe(false);
      expect(page.touched, typed).toEqual([]);
    }

    // An attempt with no token in use starts no second viewer: there is nothing to throw away.
    const fresh = standIn();
    await fresh.use("nope");
    await fresh.use(TOKEN, { status: 401 });
    await fresh.use(TOKEN, { status: 200, body: { workspace: "Acme" } });
    expect(fresh.viewers).toHaveLength(1);
  });

  it("Copy copies the command with this site's address and the placeholder token, never the real one", async () => {
    const page = standIn();
    await page.use(TOKEN, { status: 200, body: { workspace: "Acme" } });
    const first = page.commands[0];
    first.parts.button!.fire("click");
    await page.settle();
    expect(page.copied).toEqual([`curl ${SITE}/api/v1/me -H "Authorization: Bearer YOUR_TOKEN"`]);
    expect(first.parts.button!.textContent).toBe("Copied");
    expect(page.timers).toHaveLength(1);
    page.timers[0]();
    expect(first.parts.button!.textContent).toBe("Copy");
    for (const c of page.commands) c.parts.button!.fire("click");
    await page.settle();
    expect(page.copied).toHaveLength(page.commands.length + 1);
    for (const text of page.copied) expect(text).not.toContain(TOKEN);

    // Where the browser cannot copy, the buttons stay hidden; the commands still get the address.
    const plain = standIn({ clipboard: false });
    for (const c of plain.commands) {
      expect(c.parts.button!.hidden).toBe(true);
      expect(c.parts.code!.textContent).toContain(SITE);
    }
  });

  it("the viewer's dark look follows the system, also when it changes", async () => {
    const light = standIn({ dark: false });
    expect([...light.classes]).toEqual([]);
    const dark = standIn({ dark: true });
    expect([...dark.classes]).toEqual(["dark-mode"]);
    expect(dark.media.listeners).toHaveLength(1);
    dark.media.matches = false;
    dark.media.listeners[0]();
    expect([...dark.classes]).toEqual([]);
    dark.media.matches = true;
    dark.media.listeners[0]();
    expect([...dark.classes]).toEqual(["dark-mode"]);
  });

  it("without the viewer it says the reference could not be loaded, and the rest of the page still works", async () => {
    const page = standIn({ viewer: false });
    expect(page.started).toEqual([]);
    expect(page.mount.children.map((c) => [c.textContent, c.className])).toEqual([["The reference could not be loaded. Reload the page, or read the description as JSON or YAML.", "status bad"]]);
    expect(page.byId["token-box"].hidden).toBe(false);
    await page.use(TOKEN, { status: 200, body: { workspace: "Acme" } });
    expect(page.byId["token-status"].textContent).toBe("Connected to Acme. The calls on this page now use this token.");
    page.byId["forget-token"].fire("click");
    expect(page.byId["token-status"].textContent).toBe("Token forgotten.");
  });

  it("a link to a guide is gone back to once the reference above it is drawn", () => {
    const page = standIn({ hash: "#guide-errors-and-limits" });
    expect(page.scrolled).toEqual([]);
    page.started[0].onComplete();
    expect(page.scrolled).toEqual(["guide-errors-and-limits"]);
    // Any other fragment is the viewer's own business.
    for (const hash of ["", "#/Tours/listTours", "#token", "#guide-nope"]) {
      const other = standIn({ hash });
      other.started[0].onComplete();
      expect(other.scrolled, hash).toEqual([]);
    }
  });
});
