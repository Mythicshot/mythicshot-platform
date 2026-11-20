// The dashboard's shell and its Tours page: GET /, GET /tours, and the shared stylesheet
// and script with the page's own script. What their answers are (headers, where they
// answer, that they cost no database or storage call and hold nothing about anyone, admin
// or not), the exact wording of the approved mockups, and what the scripts' text may and
// may not do. What the scripts do when they run is tested under Node in
// test/node-dash-pages.test.ts, against a stand-in document.
import { describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { DASH_PAGES } from "../src/dash/routes.ts";
import { DASH_JS } from "../src/dash/script.ts";
import { DASH_TABS, dashHtml } from "../src/dash/shell.ts";
import { DASH_CSS } from "../src/dash/style.ts";
import { TOURS_HTML, TOURS_JS } from "../src/dash/tours.ts";
import { UNDOCUMENTED_ROUTES } from "../src/docs/openapi.ts";
import { HOST_RULES } from "../src/host-gate.ts";
import type { Hosts } from "../src/hosts.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import { send, type Call } from "./bundle.ts";
import { FakeDocument, textNodes } from "./pages-dom.ts";

const HOSTS: Hosts = { tours: "tours.example.com", app: "app.example.com" };
const TOURS = "https://tours.example.com";
const APP = "https://app.example.com";
const UNKNOWN = "https://evil.example.net";
const NOT_FOUND = '{"error":"not_found"}';
const BROWSER = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";
const POLICY = "default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const SECURITY: Record<string, string> = {
  "content-security-policy": POLICY,
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "cross-origin-opener-policy": "same-origin",
};

type Served = { path: string; body: string; type: string };
// Every page the shell serves, from DASH_PAGES itself, so a page added later gets every
// check below that is not about the Tours page's own words.
const PAGES: (Served & { script: string })[] = DASH_PAGES.map((p) => ({ path: p.path, body: p.html, type: "text/html; charset=utf-8", script: p.script.path }));
const FILES: Served[] = [
  { path: "/dash/dash.css", body: DASH_CSS, type: "text/css; charset=utf-8" },
  { path: "/dash/dash.js", body: DASH_JS, type: "text/javascript; charset=utf-8" },
  ...DASH_PAGES.map((p) => ({ path: p.script.path, body: p.script.body, type: "text/javascript; charset=utf-8" })),
];
const ALL = [...PAGES, ...FILES];
/** The shared script and every page's own script. */
const SCRIPTS = [DASH_JS, ...DASH_PAGES.map((p) => p.script.body)];
/** The pages that are not the admin's: none of them may name an admin route or field. */
const MEMBER_PAGES = DASH_PAGES.filter((p) => p.path !== "/admin");

const seen = (c: Call) => ({ status: c.status, headers: [...c.headers.entries()].sort(), body: c.text });

function expectServed(r: Call, s: Served, what: string): void {
  expect(r.status, what).toBe(200);
  expect(r.text, what).toBe(s.body);
  expect(Object.fromEntries(r.headers.entries()), what).toEqual({ ...SECURITY, "content-type": s.type });
  expect(r.calls, `${what}: database and storage calls`).toBe(0);
}

/** A signed-in browser's cookie and anti-forgery value for a new account. */
async function signedIn(deps: Parameters<typeof seedAccount>[0], opts: { admin?: boolean; username?: string } = {}) {
  const account = await seedAccount(deps, opts);
  const made = await redeemSignInCode(deps, await createSignInCode(deps, account.userId), BROWSER, null);
  expect(made).not.toBeNull();
  return { ...account, cookie: `${SESSION_COOKIE}=${made!.secret}`, secret: made!.secret, sessionId: made!.sessionId, csrf: await csrfFor(made!.secret) };
}

// ---- The wording ----

const BRAND = "Mythicshot";
const NOSCRIPT = "This page needs JavaScript.";
const TABS = ["Tours", "Storage", "Account", "Admin"];

/** Every text of the Tours page's body, in order, hidden parts included. Nothing else may be in it. */
const TOURS_WORDING = [
  BRAND,
  ...TABS,
  NOSCRIPT,
  "Tours",
  "Tour",
  "Status",
  "Size",
  "Changed",
  "Actions",
  "No tours yet",
  "Record a tour in Mythicshot and choose Publish. It shows up here with a link to share.",
  '"Changes waiting" means Mythicshot uploaded a newer version that visitors do not see yet. "More" holds: Publish changes, Unpublish, Delete.',
  "Its link stops working for everyone and its pictures are removed. This cannot be undone. The recording on your computer is not touched.",
  "Keep it",
  "Delete tour",
];

/** Every text the shared script puts on a page. */
const DASH_TEXT: Record<string, string> = {
  tooMany: "Too many requests. Wait a few minutes and try again.",
  failed: "Something went wrong. Try again in a moment.",
  account: "Account",
  oneByte: "1 byte",
  bytes: " bytes",
};

/** Every text the Tours page's script puts on the page. */
const TOURS_TEXT: Record<string, string> = {
  oneTour: "1 tour",
  tours: " tours",
  inWorkspace: " in ",
  dot: " · ",
  used: " used",
  oneStep: "1 step",
  steps: " steps",
  noLink: "no public link",
  published: "Published",
  waiting: "Changes waiting",
  notPublished: "Not published",
  copy: "Copy link",
  copied: "Copied",
  open: "Open",
  more: "More",
  publish: "Publish",
  publishChanges: "Publish changes",
  unpublish: "Unpublish",
  remove: "Delete",
  askBefore: 'Delete "',
  askAfter: '"?',
  publishing: "Publishing…",
  unpublishing: "Unpublishing…",
  deleting: "Deleting…",
  cut: "…",
  emptyTour: "This tour has no steps, so it cannot be published.",
  publishBusy: "This tour is being published. Try again when that is done.",
  notReloaded: "The change was made, but the list could not be loaded again. Reload the page to see it.",
};

/** The strings with a space in the scripts that are not words for a person: class names and a link's rel. */
const CLASS_NAMES = ["btn sm", "btn sm quiet", "tag ok", "tag warn", "n size", "n when", "noopener noreferrer"];

/** A script's TEXT object, read from the script's own text. */
function scriptText(js: string): Record<string, string> {
  const block = /\n {2}var TEXT = \{\n([\s\S]*?)\n {2}\};\n/.exec(js);
  expect(block, "the script keeps its words in one TEXT object").not.toBeNull();
  const out: Record<string, string> = {};
  for (const line of block![1].split("\n")) {
    const m = /^ {4}([a-zA-Z]+): ("(?:[^"\\]|\\.)*"|'[^'\\]*'),$/.exec(line);
    expect(m, `a line of TEXT: ${line}`).not.toBeNull();
    out[m![1]] = m![2].startsWith("'") ? m![2].slice(1, -1) : JSON.parse(m![2]);
  }
  return out;
}

/** Every quoted string in a script outside its comments, unescaped. */
function scriptStrings(script: string): string[] {
  const js = script
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  return [
    ...[...js.matchAll(/"(?:[^"\\\n]|\\.)*"/g)].map((m) => JSON.parse(m[0]) as string),
    ...[...js.matchAll(/'[^'\\\n]*'/g)].map((m) => m[0].slice(1, -1)),
  ];
}

describe("the dashboard's pages and files", () => {
  it("each answers with the sign-in pages' headers and makes no database or storage call", async () => {
    const one = await makeDeps();
    const two = await makeDeps({ hosts: HOSTS });
    for (const s of ALL) {
      expectServed(await send(one.deps, "GET", s.path, { origin: "https://any.example.org" }), s, `one address ${s.path}`);
      expectServed(await send(one.deps, "GET", s.path, { origin: "http://localhost:3000" }), s, `localhost ${s.path}`);
      expectServed(await send(two.deps, "GET", s.path, { origin: APP }), s, `app address ${s.path}`);
      const head = await send(two.deps, "HEAD", s.path, { origin: APP });
      expect([head.status, head.bytes.length, head.headers.get("content-security-policy"), head.calls], s.path).toEqual([200, 0, POLICY, 0]);
    }
    // The Tours page is among them, and every page's script is its own file under /dash/.
    expect(DASH_PAGES.find((p) => p.path === "/tours")).toEqual({ path: "/tours", html: TOURS_HTML, script: { path: "/dash/tours.js", body: TOURS_JS } });
    expect(new Set(DASH_PAGES.map((p) => p.script.path)).size).toBe(DASH_PAGES.length);
    for (const p of DASH_PAGES) expect(p.script.path, p.path).toMatch(/^\/dash\/[a-z][a-z-]*\.js$/);
    expect(PAGES.length).toBeGreaterThan(0);
  });

  it("no page or file holds anything about anyone: the same answer for nobody, a member, an admin and a token", async () => {
    const { deps } = await makeDeps({ hosts: HOSTS });
    const admin = await signedIn(deps, { admin: true, username: "dashcheck-owner" });
    const member = await signedIn(deps, { username: "dashcheck-member" });
    const secrets = [admin.email, member.email, "dashcheck-owner", "dashcheck-member", admin.userId, member.userId, admin.workspaceId, member.workspaceId, admin.token, member.token, admin.secret, member.secret, admin.sessionId, admin.csrf, member.csrf];
    for (const s of ALL) {
      const nobody = await send(deps, "GET", s.path, { origin: APP });
      const answers = [
        await send(deps, "GET", s.path, { origin: APP, headers: { cookie: admin.cookie, "user-agent": BROWSER } }),
        await send(deps, "GET", s.path, { origin: APP, headers: { cookie: member.cookie, "user-agent": BROWSER } }),
        await send(deps, "GET", s.path, { origin: APP, token: admin.token }),
      ];
      for (const r of [nobody, ...answers]) {
        expect(seen(r), s.path).toEqual(seen(nobody));
        expect(r.calls, s.path).toBe(0);
        expect(r.headers.get("set-cookie"), s.path).toBeNull();
        for (const secret of secrets) expect(r.text, `${s.path} holds ${secret}`).not.toContain(secret);
      }
    }
    // The workspace's name ("Account" for these accounts) is fetched by the script, never in the page.
    for (const s of PAGES) expect(textNodes(new FakeDocument(s.body).body).filter((t) => t.includes("Account") && t !== "Account"), s.path).toEqual([]);
  });

  it("a member's page carries no admin data: the Admin tab is hidden, leads only to /admin, and only the script can show it", () => {
    for (const p of DASH_PAGES) {
      const admin = new FakeDocument(p.html).getElementById("tab-admin")!;
      expect([admin.tagName, admin.getAttribute("href"), admin.hidden, admin.textContent], p.path).toEqual(["a", "/admin", true, "Admin"]);
    }
    // Nothing else in a member's page or its scripts names an admin route or field.
    for (const text of [DASH_JS, ...MEMBER_PAGES.flatMap((p) => [p.html, p.script.body])]) {
      expect(text).not.toContain("/api/v1/admin");
      expect(text).not.toMatch(/allowance|accounts|is_admin/);
    }
    // The shared script shows the tab only on the session's own word, and for an admin only.
    expect(DASH_JS).toContain("var admin = who.admin === true;");
    expect(DASH_JS).toContain('if (admin) $("tab-admin").hidden = false;');
    expect(DASH_JS.match(/tab-admin/g)).toHaveLength(1);
  });

  it("answer on the app address only: the tours address refuses the pages and files and sends / on to the app address", async () => {
    const two = await makeDeps({ hosts: HOSTS });
    // A site signs nobody in until it has an admin.
    await seedAccount(two.deps, { admin: true, username: "dashcheck-admin" });
    const viewer = await signedIn(two.deps, { username: "dashcheck-viewer" });
    for (const s of ALL) {
      expect(HOST_RULES[`GET ${s.path}`], s.path).toBe("app");
      for (const headers of [{}, { cookie: viewer.cookie }] as Record<string, string>[]) {
        const onTours = await send(two.deps, "GET", s.path, { origin: TOURS, headers });
        expect([onTours.status, onTours.text, onTours.calls, onTours.headers.get("location")], `tours ${s.path}`).toEqual([404, NOT_FOUND, 0, null]);
      }
      const unknown = await send(two.deps, "GET", s.path, { origin: UNKNOWN });
      expect([unknown.status, unknown.bytes.length, unknown.calls], `unknown ${s.path}`).toEqual([421, 0, 0]);
      expect(UNDOCUMENTED_ROUTES[`GET ${s.path}`]?.length ?? 0, s.path).toBeGreaterThan(10);
    }
    expect(HOST_RULES["GET /"]).toBe("app-redirect");
    for (const headers of [{}, { cookie: viewer.cookie }] as Record<string, string>[]) {
      const root = await send(two.deps, "GET", "/?x=1", { origin: TOURS, headers });
      expect([root.status, root.headers.get("location"), root.calls, root.headers.get("set-cookie")]).toEqual([308, APP + "/?x=1", 0, null]);
    }
    expect((await send(two.deps, "GET", "/", { origin: UNKNOWN })).status).toBe(421);
    expect(UNDOCUMENTED_ROUTES["GET /"]?.length ?? 0).toBeGreaterThan(10);
  });

  it("GET / sends a browser with a session cookie to /tours and anyone else to /signin, deciding from the request alone", async () => {
    for (const config of [{}, { hosts: HOSTS }]) {
      const { deps } = await makeDeps(config);
      await seedAccount(deps, { admin: true, username: "dashcheck-admin" });
      const viewer = await signedIn(deps, { username: "dashcheck-viewer" });
      const go = async (headers: Record<string, string>, token?: string) => {
        const r = await send(deps, "GET", "/", { origin: APP, headers, token });
        expect(r.status).toBe(302);
        expect(r.bytes.length).toBe(0);
        expect(r.calls, "GET / looks nothing up").toBe(0);
        expect(r.headers.get("set-cookie")).toBeNull();
        const { location, ...rest } = Object.fromEntries(r.headers.entries());
        expect(rest).toEqual(SECURITY);
        return location;
      };
      expect(await go({})).toBe("/signin");
      expect(await go({}, viewer.token)).toBe("/signin");
      expect(await go({ cookie: "other=1" })).toBe("/signin");
      expect(await go({ cookie: viewer.cookie })).toBe("/tours");
      // A cookie that names no session is not looked up: the Tours page's script finds no session and sends the browser to /signin.
      expect(await go({ cookie: `${SESSION_COOKIE}=nonsense` })).toBe("/tours");
    }
  });

  it("the wording is the approved mockups' own", () => {
    const doc = new FakeDocument(TOURS_HTML);
    expect(textNodes(doc.body)).toEqual(TOURS_WORDING);
    expect(textNodes(doc.head)).toEqual(["Tours"]);
    // No other words hide in attributes a person can meet.
    for (const e of doc.body.all()) for (const name of ["aria-label", "title", "alt", "placeholder"]) expect(e.hasAttribute(name), `<${e.tagName} ${name}>`).toBe(false);
    // The scripts' own words are exactly these, and they have no other sentence.
    expect(scriptText(DASH_JS)).toEqual(DASH_TEXT);
    expect(scriptText(TOURS_JS)).toEqual(TOURS_TEXT);
    for (const [js, text] of [[DASH_JS, DASH_TEXT], [TOURS_JS, TOURS_TEXT]] as const) {
      const words = new Set(Object.values(text));
      const sentences = scriptStrings(js).filter((t) => /[a-z]/i.test(t) && /\s/.test(t) && t !== "use strict");
      for (const t of sentences) expect(words.has(t) || CLASS_NAMES.includes(t), `a text outside TEXT: ${JSON.stringify(t)}`).toBe(true);
    }
    // The failure sentences are the approved ones the account page uses.
    expect([DASH_TEXT.failed, DASH_TEXT.tooMany]).toEqual(["Something went wrong. Try again in a moment.", "Too many requests. Wait a few minutes and try again."]);
    // The question before a delete: its title is made of the two parts around the tour's title.
    expect(TOURS_TEXT.askBefore + "Loot master setup" + TOURS_TEXT.askAfter).toBe('Delete "Loot master setup"?');
    expect(doc.getElementById("delete-keep")!.textContent).toBe("Keep it");
    expect(doc.getElementById("delete-go")!.textContent).toBe("Delete tour");
    // The scripts set text only through textContent, and ask nothing with confirm().
    for (const js of SCRIPTS) {
      for (const api of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "createContextualFragment", "DOMParser", "srcdoc", "confirm(", "alert(", "prompt("]) expect(js, api).not.toContain(api);
    }
  });

  it("the bar holds the brand, the four tabs of this version in order, and a place for the username; no Images or GIFs", () => {
    const doc = new FakeDocument(TOURS_HTML);
    const nav = doc.body.all().find((e) => e.tagName === "nav")!;
    const links = nav.all().filter((e) => e.tagName === "a");
    expect(links.map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("aria-current"), a.hidden])).toEqual([
      ["Tours", "/tours", "page", false],
      ["Storage", "/storage", null, false],
      ["Account", "/account", null, false],
      ["Admin", "/admin", null, true],
    ]);
    expect(DASH_TABS.map((t) => t.label)).toEqual(TABS);
    for (const word of ["Images", "GIFs", "/images", "/gifs"]) for (const text of [TOURS_HTML, DASH_JS, TOURS_JS]) expect(text, word).not.toContain(word);
    const user = doc.getElementById("dash-user")!;
    expect([user.textContent, user.className]).toEqual(["", "who"]);
    expect(doc.body.all().find((e) => e.className === "brand")!.textContent).toBe(BRAND);
    // Each page marks its own tab; Admin is hidden on every page.
    for (const t of DASH_TABS) {
      const page = new FakeDocument(dashHtml({ title: t.label, active: t.key, main: "<p>x</p>", script: "/dash/x.js" }));
      const tabs = page.body.all().filter((e) => e.tagName === "a" && e.parent?.tagName === "nav");
      expect(tabs.filter((a) => a.getAttribute("aria-current") === "page").map((a) => a.textContent), t.key).toEqual([t.label]);
      expect(page.getElementById("tab-admin")!.hidden, t.key).toBe(true);
      expect(page.body.getAttribute("data-page"), t.key).toBe(t.key);
    }
  });

  it("dashHtml escapes the title and takes only a page script of its own under /dash/", () => {
    const page = dashHtml({ title: '<b>"x"</b>', active: "storage", main: "<p>x</p>", script: "/dash/storage.js" });
    expect(page).toContain("<title>&lt;b&gt;&quot;x&quot;&lt;/b&gt;</title>");
    expect(page).toContain('<script src="/dash/dash.js" defer></script>\n<script src="/dash/storage.js" defer></script>');
    for (const script of ["/dash/dash.js", "https://evil.example.net/x.js", "//evil.example.net/x.js", "/dash/../x.js", "/dash/x.js?a", '/dash/x.js" onload="x', "/signin/signin.js"]) {
      expect(() => dashHtml({ title: "x", active: "tours", main: "", script }), script).toThrow();
    }
    expect(() => dashHtml({ title: "x", active: "images" as never, main: "", script: "/dash/x.js" })).toThrow();
  });

  it("the pages load nothing from another origin and carry no inline script, style or handler", () => {
    for (const s of PAGES) {
      const doc = new FakeDocument(s.body);
      const all = doc.root.all();
      expect(all.filter((e) => e.tagName === "script").map((e) => [e.getAttribute("src"), e.hasAttribute("defer"), e.textContent]), s.path).toEqual([
        ["/dash/dash.js", true, ""],
        [s.script, true, ""],
      ]);
      expect(all.filter((e) => e.tagName === "link").map((e) => [e.getAttribute("rel"), e.getAttribute("href")]), s.path).toEqual([["stylesheet", "/dash/dash.css"]]);
      expect(all.filter((e) => e.tagName === "style"), s.path).toEqual([]);
      for (const e of all) {
        for (const [name, value] of e.attrs) {
          expect(name === "style" || name.startsWith("on"), `${s.path} <${e.tagName} ${name}>`).toBe(false);
          if (["src", "href", "action", "formaction", "srcset", "poster", "data"].includes(name)) expect(value, `${s.path} ${name}`).toMatch(/^\/(?!\/)/);
        }
      }
      expect(s.body, s.path).not.toMatch(/https?:|\/\//i);
      expect(all.some((e) => e.tagName === "meta" && e.getAttribute("name") === "referrer" && e.getAttribute("content") === "no-referrer"), s.path).toBe(true);
      expect(all.filter((e) => e.tagName === "form"), s.path).toEqual([]);
    }
    expect(DASH_CSS).not.toMatch(/url\(|@import|https?:|\/\/|expression\(/i);
    // The scripts set no style attribute and add no handler attribute; the only style they touch is none.
    for (const js of SCRIPTS) {
      expect(js).not.toMatch(/setAttribute\("(?:style|on[a-z]+|src|srcdoc)"/);
      expect(js).not.toMatch(/\.style\b/);
      expect(js).not.toMatch(/\.on[a-z]+\s*=/);
    }
  });

  it("the scripts keep to this site: one place makes every request, with the session and the anti-forgery header on every change", () => {
    expect(DASH_JS.match(/\bfetch\(/g), "one place makes every request").toHaveLength(1);
    for (const p of DASH_PAGES) expect(p.script.body, p.path).not.toMatch(/\bfetch\(|XMLHttpRequest|csrf/i);
    // A path that is not one absolute path of this site is refused before any request.
    expect(DASH_JS).toContain('if (typeof path !== "string" || !/^\\/(?![\\/\\\\])/.test(path)) throw new TypeError("path");');
    expect(DASH_JS.indexOf("throw new TypeError")).toBeLessThan(DASH_JS.indexOf("fetch("));
    expect(DASH_JS).toContain('credentials: "same-origin"');
    expect(DASH_JS).toContain('referrerPolicy: "no-referrer"');
    expect(DASH_JS).toContain('redirect: "error"');
    expect(DASH_JS).toContain('if (method !== "GET" && method !== "HEAD") headers["X-Csrf-Token"] = csrf;');
    expect(DASH_JS).toContain('headers["content-type"] = "application/json";');
    // The anti-forgery value lives in one variable, set from the session, and goes only into the header.
    for (const m of DASH_JS.matchAll(/\bcsrf\b/g)) {
      const line = DASH_JS.slice(DASH_JS.lastIndexOf("\n", m.index) + 1, DASH_JS.indexOf("\n", m.index)).trim();
      expect(/^(?:var csrf = "";|csrf = d\.csrf;|if \(method !== "GET" && method !== "HEAD"\) headers\["X-Csrf-Token"\] = csrf;|if \(res\.status !== 200 \|\| d === null .*typeof d\.csrf !== "string"|\/\/)/.test(line), `a use of csrf: ${line}`).toBe(true);
    }
    expect(TOURS_JS).not.toMatch(/csrf/i);
    // Every request the Tours page makes, by method and path.
    const requests = [...(DASH_JS + TOURS_JS).matchAll(/\bapi\("([A-Z]+)", ("[^"]*")/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(requests.sort()).toEqual(['GET "/api/v1/me"', 'GET "/api/v1/session"', 'GET "/api/v1/tours"', 'GET "/api/v1/usage"'].sort());
    expect(TOURS_JS).toContain('var path = "/api/v1/tours/" + encodeURIComponent(id) + (kind === "delete" ? "" : "/" + kind);');
    expect(TOURS_JS).toContain("return Dash.api(method, path, body)");
    // Nothing is stored, no cookie is touched, and leaving a page goes only to /signin.
    const forbidden = ["localStorage", "sessionStorage", "indexedDB", "cookie", "cookieStore", "caches", "postMessage", "window.name", "pushState", "replaceState", "location.href", "location.hash", "sendBeacon", "XMLHttpRequest", "WebSocket", "EventSource", "import(", "eval(", "Function(", "console.", "window.open", "setInterval(", "document.referrer"];
    for (const js of SCRIPTS) for (const api of forbidden) expect(js, api).not.toContain(api);
    const navigations = [...(DASH_JS + TOURS_JS).matchAll(/location\.(replace|assign)\(([^)]*)\)/g)].map((m) => m[2]);
    expect(navigations).toEqual(['"/signin"']);
    expect(DASH_JS + TOURS_JS).not.toMatch(/\blocation\s*=(?!=)/);
    const uses = [...(DASH_JS + TOURS_JS).matchAll(/\blocation\b\s*(\.\s*[a-zA-Z]+)?/g)].map((m) => (m[1] ?? "").replace(/\s/g, ""));
    expect(new Set(uses)).toEqual(new Set([".replace", ".origin"]));
    // The one timer is the moment "Copied" shows; the one browser API beyond the page is the clipboard.
    expect(TOURS_JS.match(/setTimeout\(/g)).toHaveLength(1);
    expect(DASH_JS).not.toContain("setTimeout(");
    expect([...TOURS_JS.matchAll(/navigator\.[a-zA-Z]+/g)].map((m) => m[0])).toEqual(["navigator.clipboard", "navigator.clipboard", "navigator.clipboard"]);
  });

  it("a link goes into an href only from the API's strict path and a checked tours address", () => {
    expect(TOURS_JS).toContain("var TOUR_PATH = /^\\/t\\/[a-z0-9]{1,64}$/;");
    expect(TOURS_JS).toContain('if (base === null || t.status !== "published" || typeof t.url !== "string" || !TOUR_PATH.test(t.url)) return null;');
    expect(TOURS_JS).toContain("return base + t.url;");
    // No second check that could never decide anything (what the runtime tests hold instead).
    expect(TOURS_JS).not.toContain("function safe(");
    // The only href the script sets is that link, on a link that opens a new tab without the opener or a referrer.
    expect(TOURS_JS.match(/setAttribute\("href"/g)).toHaveLength(1);
    expect(TOURS_JS).toContain('open.setAttribute("href", link);');
    expect(TOURS_JS).toContain('open.setAttribute("target", "_blank");');
    expect(TOURS_JS).toContain('open.setAttribute("rel", "noopener noreferrer");');
  });

  it("the pages are usable with the keyboard and a screen reader, at phone width and in both colour schemes", () => {
    for (const s of PAGES) {
      const doc = new FakeDocument(s.body);
      const all = doc.root.all();
      expect(all.find((e) => e.tagName === "html")?.getAttribute("lang"), s.path).toBe("en");
      for (const b of all.filter((e) => e.tagName === "button")) expect(b.getAttribute("type"), `${s.path} #${b.id}`).toBe("button");
      for (const a of all.filter((e) => e.tagName === "a")) expect(a.getAttribute("href"), s.path).toMatch(/^\//);
      for (const e of all) expect(["div", "span", "p", "li", "td"].includes(e.tagName) && (e.hasAttribute("tabindex") || e.getAttribute("role") === "button"), `${s.path} <${e.tagName}> as a control`).toBe(false);
      const messages = all.filter((e) => /\b(?:message|load)\b/.test(e.className) && e.parent?.tagName !== "noscript");
      expect(messages.map((m) => m.id), s.path).toContain("dash-load");
      for (const m of messages) expect([m.getAttribute("role"), m.getAttribute("aria-live")], `${s.path} #${m.id}`).toEqual(["status", "polite"]);
      // A message line takes no room until it has a message.
      for (const m of messages.filter((e) => e.id !== "dash-load")) expect(m.hidden, `${s.path} #${m.id}`).toBe(true);
      for (const h of all.filter((e) => e.tagName === "h1" || e.tagName === "h2")) expect(h.getAttribute("tabindex"), `${s.path} #${h.id}`).toBe("-1");
      expect(all.some((e) => e.tagName === "meta" && e.getAttribute("name") === "viewport" && e.getAttribute("content") === "width=device-width, initial-scale=1"), s.path).toBe(true);
    }
    expect(new FakeDocument(TOURS_HTML).root.all().filter((e) => /\bmessage\b/.test(e.className) && e.parent?.tagName !== "noscript").map((m) => m.id).sort()).toEqual(["delete-message", "tours-message"]);
    expect(DASH_CSS).not.toMatch(/\.message \{[^}]*min-height/);
    // The last column's header has a name a screen reader reads and the eye does not see.
    expect(DASH_CSS).toMatch(/\.vh \{[^}]*position: absolute;[^}]*clip: rect\(0 0 0 0\);/);
    // The question is a dialog with its title and text tied to it.
    const dialog = new FakeDocument(TOURS_HTML).body.all().find((e) => e.getAttribute("role") === "alertdialog")!;
    expect([dialog.getAttribute("aria-modal"), dialog.getAttribute("aria-labelledby"), dialog.getAttribute("aria-describedby")]).toEqual(["true", "delete-title", "delete-text"]);
    // Every element the scripts look up by id is on the page.
    const ids = new Set(new FakeDocument(TOURS_HTML).root.all().map((e) => e.id));
    const asked = [...(DASH_JS + TOURS_JS).matchAll(/\$\("([a-z-]+)"\)/g)].map((m) => m[1]);
    expect(asked.length).toBeGreaterThan(10);
    for (const id of asked) expect(ids.has(id), `#${id}`).toBe(true);
    // The stylesheet: both colour schemes, a visible focus ring, and the phone layout of mockup 11.
    expect(DASH_CSS).toContain("@media (prefers-color-scheme: dark)");
    expect(DASH_CSS).toContain(":focus-visible");
    expect(DASH_CSS).toContain("[hidden] { display: none !important; }");
    expect(DASH_CSS).toMatch(/overflow-wrap: anywhere/);
    const phone = [...DASH_CSS.matchAll(/@media \(max-width: 720px\) \{\n([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
    expect(phone).toContain(".tours, .tours tbody, .tours tr, .tours td { display: block; }");
    expect(phone).toContain(".tours thead, .tours td.size, .tours td.when { display: none; }");
    expect(phone).toContain(".nav { order: 2; flex-basis: 100%; }");
    expect(phone).toContain(".who { order: 1; margin-left: auto; }");
    expect(phone).toContain(".narrow-only { display: inline; }");
    // Nothing is wider than the screen: no fixed minimum width, no sideways scroll box.
    expect(DASH_CSS).not.toMatch(/overflow-x|100vw/);
    expect(DASH_CSS).not.toMatch(/\.(?:tours|page|card|top)[^{]*\{[^}]*min-width: [1-9]/);
  });
});
