// The sign-in pages: /signin, /signin/link and /account, with their one stylesheet and
// one script. What their answers are (headers, where they answer, that they cost no
// database or storage call and hold nothing about anyone), the exact wording, and what
// the script text may and may not do. What the script does when it runs is tested under
// Node in test/node-signin-pages.test.ts, where it can be run against a stand-in document.
import { describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { UNDOCUMENTED_ROUTES } from "../src/docs/openapi.ts";
import { HOST_RULES } from "../src/host-gate.ts";
import type { Hosts } from "../src/hosts.ts";
import { ACCOUNT_PAGE_HEADERS } from "../src/pages.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import { ACCOUNT_HTML, LINK_HTML, SIGNIN_CSS, SIGNIN_HTML, SIGNIN_JS } from "../src/signin/page.ts";
import { send, type Call } from "./bundle.ts";
import { FakeDocument, textNodes } from "./pages-dom.ts";

const HOSTS: Hosts = { tours: "tours.example.com", app: "app.example.com" };
const TOURS = "https://tours.example.com";
const APP = "https://app.example.com";
const UNKNOWN = "https://evil.example.net";
const NOT_FOUND = '{"error":"not_found"}';
const BROWSER = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";

const POLICY = "default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

type Served = { path: string; body: string; type: string };
const PAGES: Served[] = [
  { path: "/signin", body: SIGNIN_HTML, type: "text/html; charset=utf-8" },
  { path: "/signin/link", body: LINK_HTML, type: "text/html; charset=utf-8" },
  { path: "/account", body: ACCOUNT_HTML, type: "text/html; charset=utf-8" },
];
const FILES: Served[] = [
  { path: "/signin/signin.css", body: SIGNIN_CSS, type: "text/css; charset=utf-8" },
  { path: "/signin/signin.js", body: SIGNIN_JS, type: "text/javascript; charset=utf-8" },
];
const ALL = [...PAGES, ...FILES];
const KEYS = ALL.map((s) => `GET ${s.path}`);

/** The headers every one of the five answers carries, the content type aside. */
const SECURITY: Record<string, string> = {
  "content-security-policy": POLICY,
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "cross-origin-opener-policy": "same-origin",
};

/** Everything a client can see of an answer. */
const seen = (c: Call) => ({ status: c.status, headers: [...c.headers.entries()].sort(), body: c.text });

function expectServed(r: Call, s: Served, what: string): void {
  expect(r.status, what).toBe(200);
  expect(r.text, what).toBe(s.body);
  expect(r.text.length, what).toBeGreaterThan(100);
  expect(Object.fromEntries(r.headers.entries()), what).toEqual({ ...SECURITY, "content-type": s.type });
  expect(r.calls, `${what}: database and storage calls`).toBe(0);
}

// ---- The wording ----

const BRAND = "Mythicshot";
const NOSCRIPT = "This page needs JavaScript.";

/** Every text of each page's body, in order, hidden parts included. Nothing else may be in it. */
const WORDING: Record<string, string[]> = {
  "/signin": [
    BRAND,
    NOSCRIPT,
    "Sign in",
    "Enter your email address and we will send you a link to sign in. There is no password.",
    "Email address",
    "Send me a sign-in link",
    "Mythicshot is invite-only for now.",
    "Check your mail",
    "If",
    "has an account, a sign-in link is on its way. It works once and for 15 minutes.",
    "Nothing after a few minutes? Look in your spam folder, or",
    "try another address",
    ".",
  ],
  "/signin/link": [
    BRAND,
    NOSCRIPT,
    "Finish signing in",
    "Press the button to sign in on this browser.",
    "Sign in",
    "You stay signed in here for 30 days of use. If you did not ask for this link, close this page: nothing happens.",
    "This sign-in link no longer works",
    "A link works once and for 15 minutes. Ask for a new one and use the newest mail.",
    "Send me a new link",
  ],
  "/account": [
    BRAND,
    NOSCRIPT,
    "Signed in",
    "Storage",
    "Tours and their pictures count. Deleting a tour frees its space within a few minutes.",
    "Where you are signed in",
    "Sign out",
    "Sign out everywhere",
    "Tours are managed from Mythicshot for now. A dashboard is coming to this page.",
  ],
};
const TITLES: Record<string, string> = { "/signin": "Sign in", "/signin/link": "Finish signing in", "/account": "Signed in" };

/** Every text the script itself puts on a page, by its key in the script's TEXT. */
const SCRIPT_TEXT: Record<string, string> = {
  badEmail: "That does not look like an email address.",
  tooMany: "Too many requests. Wait a few minutes and try again.",
  failed: "Something went wrong. Try again in a moment.",
  notEnded: "That session could not be ended. Reload the page.",
  sending: "Sending…",
  signingIn: "Signing in…",
  signingOut: "Signing out…",
  signedIn: "Signed in",
  signedInAs: "Signed in as ",
  of: " of ",
  used: " used",
  dot: " · ",
  oneTour: "1 tour",
  tours: " tours",
  thisBrowser: "This browser",
  since: "since ",
  lastUsed: "last used ",
  signOut: "Sign out",
  oneByte: "1 byte",
  bytes: " bytes",
};

/** The script's TEXT object, read from the script's own text. */
function scriptText(): Record<string, string> {
  const block = /\n {2}var TEXT = \{\n([\s\S]*?)\n {2}\};\n/.exec(SIGNIN_JS);
  expect(block, "the script keeps its words in one TEXT object").not.toBeNull();
  const out: Record<string, string> = {};
  for (const line of block![1].split("\n")) {
    const m = /^ {4}([a-zA-Z]+): ("(?:[^"\\]|\\.)*"),$/.exec(line);
    expect(m, `a line of TEXT: ${line}`).not.toBeNull();
    out[m![1]] = JSON.parse(m![2]);
  }
  return out;
}

/** Every double-quoted string in the script, unescaped. */
function scriptStrings(): string[] {
  return [...SIGNIN_JS.matchAll(/"(?:[^"\\\n]|\\.)*"/g)].map((m) => JSON.parse(m[0]) as string);
}

describe("the sign-in pages", () => {
  it("each page answers with its headers and makes no database or storage call", async () => {
    const one = await makeDeps();
    const two = await makeDeps({ hosts: HOSTS });
    for (const s of ALL) {
      expectServed(await send(one.deps, "GET", s.path, { origin: "https://any.example.org" }), s, `one address ${s.path}`);
      expectServed(await send(one.deps, "GET", s.path, { origin: "http://localhost:3000" }), s, `localhost ${s.path}`);
      expectServed(await send(two.deps, "GET", s.path, { origin: APP }), s, `app address ${s.path}`);
      // HEAD gives the same headers and no body.
      const head = await send(two.deps, "HEAD", s.path, { origin: APP });
      expect(head.status, s.path).toBe(200);
      expect(head.bytes.length, s.path).toBe(0);
      expect(head.headers.get("content-security-policy"), s.path).toBe(POLICY);
      expect(head.calls, s.path).toBe(0);
    }
    expect(ACCOUNT_PAGE_HEADERS).toEqual(SECURITY);
  });

  it("no page holds anything about any account", async () => {
    const { deps } = await makeDeps({ hosts: HOSTS });
    const admin = await seedAccount(deps, { admin: true, username: "pagecheck-owner" });
    const made = await redeemSignInCode(deps, await createSignInCode(deps, admin.userId), BROWSER, null);
    expect(made).not.toBeNull();
    const cookie = `${SESSION_COOKIE}=${made!.secret}`;
    const csrf = await csrfFor(made!.secret);
    const secrets = [admin.email, "pagecheck-owner", admin.userId, admin.workspaceId, admin.token, made!.secret, made!.sessionId, csrf, "Account"];
    for (const s of ALL) {
      const nobody = await send(deps, "GET", s.path, { origin: APP });
      const withCookie = await send(deps, "GET", s.path, { origin: APP, headers: { cookie, "user-agent": BROWSER } });
      const withToken = await send(deps, "GET", s.path, { origin: APP, token: admin.token });
      expect(seen(withCookie), s.path).toEqual(seen(nobody));
      expect(seen(withToken), s.path).toEqual(seen(nobody));
      for (const r of [nobody, withCookie, withToken]) {
        expect(r.calls, s.path).toBe(0);
        expect(r.headers.get("set-cookie"), s.path).toBeNull();
        for (const secret of secrets.filter((x) => x !== "Account")) expect(r.text, `${s.path} holds ${secret}`).not.toContain(secret);
      }
    }
    // The workspace's name is a word the pages could use; it is "Account" here, and no page says it.
    for (const s of PAGES) expect(textNodes(new FakeDocument(s.body).body).join(" "), s.path).not.toContain("Account");
  });

  it("the pages answer on the app address only", async () => {
    const two = await makeDeps({ hosts: HOSTS });
    for (const s of ALL) {
      const key = `GET ${s.path}`;
      expect(HOST_RULES[key], key).toBe("app");
      const onTours = await send(two.deps, "GET", s.path, { origin: TOURS });
      expect([onTours.status, onTours.text, onTours.calls], `tours ${s.path}`).toEqual([404, NOT_FOUND, 0]);
      expect(onTours.headers.get("location"), s.path).toBeNull();
      const unknown = await send(two.deps, "GET", s.path, { origin: UNKNOWN });
      expect([unknown.status, unknown.bytes.length, unknown.calls], `unknown ${s.path}`).toEqual([421, 0, 0]);
      expect((await send(two.deps, "GET", s.path, { origin: APP })).status, `app ${s.path}`).toBe(200);
    }
    // They are pages, not API: left out of the description, each with its reason.
    for (const key of KEYS) expect(UNDOCUMENTED_ROUTES[key]?.length ?? 0, key).toBeGreaterThan(10);
  });

  it("the wording is the planned one", () => {
    for (const s of PAGES) {
      const doc = new FakeDocument(s.body);
      expect(textNodes(doc.body), s.path).toEqual(WORDING[s.path]);
      expect(textNodes(doc.head), s.path).toEqual([TITLES[s.path]]);
      // No other words hide in attributes a person can meet: the one placeholder, and labels only by reference.
      const placeholders = doc.body.all().flatMap((e) => (e.hasAttribute("placeholder") ? [e.getAttribute("placeholder")] : []));
      expect(placeholders, s.path).toEqual(s.path === "/signin" ? ["you@example.com"] : []);
      for (const e of doc.body.all()) for (const name of ["aria-label", "title", "alt"]) expect(e.hasAttribute(name), `${s.path} <${e.tagName} ${name}>`).toBe(false);
    }
    // The script's own words are exactly these, and it has no other sentence.
    expect(scriptText()).toEqual(SCRIPT_TEXT);
    const words = new Set(Object.values(SCRIPT_TEXT));
    const sentences = scriptStrings().filter((t) => /[a-z]/i.test(t) && /\s/.test(t));
    for (const t of sentences) expect(words.has(t), `a text outside TEXT: ${JSON.stringify(t)}`).toBe(true);
    // The script sets text only through textContent.
    for (const api of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "createContextualFragment", "DOMParser", "srcdoc"]) expect(SIGNIN_JS, api).not.toContain(api);
  });

  it("the link page's script takes the code from the address, removes it from the address bar before anything else, and sends it only when the button is pressed", () => {
    // The first two statements, before any other: read the part after #, then clean the address bar.
    const start = SIGNIN_JS.indexOf('"use strict";');
    expect(start).toBeGreaterThan(0);
    const statements = SIGNIN_JS.slice(start)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("//"));
    expect(statements.slice(0, 3)).toEqual(['"use strict";', "var fragment = location.hash;", 'if (fragment !== "") history.replaceState(null, "", location.pathname + location.search);']);
    // The hash is read once, and nothing reads or writes the address otherwise.
    expect(SIGNIN_JS.match(/location\.hash/g)).toHaveLength(1);
    expect(SIGNIN_JS.match(/replaceState/g)).toHaveLength(1);
    // The code is sent from one place: the request the press makes, as a JSON body.
    expect(SIGNIN_JS.match(/\/api\/v1\/signin\/complete/g)).toHaveLength(1);
    const press = SIGNIN_JS.indexOf('$("finish-button").addEventListener("click"');
    const sent = SIGNIN_JS.indexOf('call("POST", "/api/v1/signin/complete", { code: code })');
    expect(press).toBeGreaterThan(0);
    expect(sent).toBeGreaterThan(press);
    // Between the handler's start and the request there is no other function: the request is the press's own.
    expect(SIGNIN_JS.slice(press, sent)).not.toMatch(/\}\);\n/);
    // The code is taken only in the shape a link carries, and goes nowhere else.
    expect(SIGNIN_JS).toContain("/^#c=(dpl_[0-9a-f]{40})$/.exec(fragment)");
    for (const m of SIGNIN_JS.matchAll(/\bcode\b/g)) {
      const line = SIGNIN_JS.slice(SIGNIN_JS.lastIndexOf("\n", m.index) + 1, SIGNIN_JS.indexOf("\n", m.index)).trim();
      expect(
        [
          'var code = match === null ? "" : match[1];',
          'if (code === "") {',
          'if (code === "") return;',
          'call("POST", "/api/v1/signin/complete", { code: code }).then(function (res) {',
          'code = "";',
        ].some((ok) => line.startsWith(ok)) || line.startsWith("//"),
        `a use of the code: ${line}`,
      ).toBe(true);
    }
  });

  it("the script never writes the code or the anti-forgery value to a store, a cookie or an address", () => {
    const forbidden = [
      "localStorage", "sessionStorage", "indexedDB", "cookie", "cookieStore", "caches", "postMessage", "window.name", "pushState",
      "location.href", "location.hash =", "location.search =", "sendBeacon", "XMLHttpRequest", "WebSocket", "EventSource", "import(",
      "eval(", "Function(", "console.", "open(", "setTimeout(", "setInterval(", "document.referrer", "?c=", "?code",
    ];
    for (const api of forbidden) expect(SIGNIN_JS, api).not.toContain(api);
    // Leaving a page goes only to a fixed address of this site.
    const navigations = [...SIGNIN_JS.matchAll(/location\.(replace|assign)\(([^)]*)\)/g)].map((m) => m[2]);
    expect(navigations.length).toBeGreaterThan(0);
    for (const target of navigations) expect(["\"/signin\"", "\"/account\""], target).toContain(target);
    // Every request goes to the API of this site, by a fixed path or a session's id.
    const requests = [...SIGNIN_JS.matchAll(/\bcall\("([A-Z]+)", ([^,)]+)/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(requests.sort()).toEqual(
      [
        'DELETE "/api/v1/sessions/" + encodeURIComponent(id)',
        'GET "/api/v1/session"',
        'GET "/api/v1/session"',
        'GET "/api/v1/sessions"',
        'GET "/api/v1/usage"',
        'POST "/api/v1/signin/complete"',
        'POST "/api/v1/signin/request"',
        'POST "/api/v1/signout"',
        'POST "/api/v1/signout/everywhere"',
      ].sort(),
    );
    expect(SIGNIN_JS.match(/\bfetch\(/g), "one place makes every request").toHaveLength(1);
    expect(SIGNIN_JS).toContain('credentials: "same-origin"');
    expect(SIGNIN_JS).toContain('referrerPolicy: "no-referrer"');
    // The anti-forgery value lives in one variable and goes only into the request header.
    for (const m of SIGNIN_JS.matchAll(/\bcsrf\b/g)) {
      const line = SIGNIN_JS.slice(SIGNIN_JS.lastIndexOf("\n", m.index) + 1, SIGNIN_JS.indexOf("\n", m.index)).trim();
      expect(/^(?:var csrf = "";|csrf = res\.data\.csrf;|if \(csrf !== undefined\) headers\["X-Csrf-Token"\] = csrf;|function call\(method, path, body, csrf\) \{|.*call\("(?:POST|DELETE)", [^;]*, undefined, csrf\)|if \(typeof res\.data\.csrf !== "string"|\/\/)/.test(line), `a use of csrf: ${line}`).toBe(true);
    }
  });

  it("the account page sends the anti-forgery header with both sign-outs", () => {
    expect(SIGNIN_JS).toContain('call("POST", "/api/v1/signout", undefined, csrf)');
    expect(SIGNIN_JS).toContain('call("POST", "/api/v1/signout/everywhere", undefined, csrf)');
    expect(SIGNIN_JS).toContain('call("DELETE", "/api/v1/sessions/" + encodeURIComponent(id), undefined, csrf)');
    expect(SIGNIN_JS).toContain('headers["X-Csrf-Token"] = csrf;');
    // A JSON body is labelled as JSON.
    expect(SIGNIN_JS).toContain('headers["content-type"] = "application/json";');
  });

  it("the pages load nothing from another origin and carry no inline script or style", () => {
    for (const s of PAGES) {
      const doc = new FakeDocument(s.body);
      const all = doc.root.all();
      const scripts = all.filter((e) => e.tagName === "script");
      expect(scripts.map((e) => [e.getAttribute("src"), e.textContent]), s.path).toEqual([["/signin/signin.js", ""]]);
      expect(all.filter((e) => e.tagName === "link").map((e) => [e.getAttribute("rel"), e.getAttribute("href")]), s.path).toEqual([["stylesheet", "/signin/signin.css"]]);
      expect(all.filter((e) => e.tagName === "style"), s.path).toEqual([]);
      for (const e of all) {
        for (const [name, value] of e.attrs) {
          expect(name === "style" || name.startsWith("on"), `${s.path} <${e.tagName} ${name}>`).toBe(false);
          if (["src", "href", "action", "formaction", "srcset", "poster", "data"].includes(name)) expect(value, `${s.path} ${name}`).toMatch(/^\/(?!\/)/);
        }
      }
      expect(s.body, s.path).not.toMatch(/https?:|\/\//i);
      // The referrer is withheld by the page as well as by the header.
      expect(all.some((e) => e.tagName === "meta" && e.getAttribute("name") === "referrer" && e.getAttribute("content") === "no-referrer"), s.path).toBe(true);
      // The forms post nowhere: without the script they cannot put an address in a URL.
      for (const form of all.filter((e) => e.tagName === "form")) {
        expect(form.getAttribute("method"), s.path).toBe("post");
        expect(form.hasAttribute("action"), s.path).toBe(false);
      }
    }
    expect(SIGNIN_CSS).not.toMatch(/url\(|@import|https?:|\/\//i);
    expect(SIGNIN_JS).not.toMatch(/https?:|\/\/[a-z]/i);
  });

  it("no page can be framed", async () => {
    const two = await makeDeps({ hosts: HOSTS });
    for (const s of ALL) {
      const r = await send(two.deps, "GET", s.path, { origin: APP });
      expect(r.headers.get("x-frame-options"), s.path).toBe("DENY");
      expect(r.headers.get("content-security-policy")!.split(";").map((d) => d.trim()), s.path).toContain("frame-ancestors 'none'");
      expect(r.headers.get("cross-origin-opener-policy"), s.path).toBe("same-origin");
    }
  });

  it("the pages are usable with the keyboard and a screen reader, at phone width and in both colour schemes", () => {
    for (const s of PAGES) {
      const doc = new FakeDocument(s.body);
      const all = doc.root.all();
      expect(doc.root.all().find((e) => e.tagName === "html")?.getAttribute("lang"), s.path).toBe("en");
      // Every field has a label tied to it.
      for (const input of all.filter((e) => e.tagName === "input")) expect(all.some((e) => e.tagName === "label" && e.getAttribute("for") === input.id), `${s.path} #${input.id}`).toBe(true);
      // Every control is a real button with its type, or a link with an address.
      for (const b of all.filter((e) => e.tagName === "button")) expect(["button", "submit"], `${s.path} #${b.id}`).toContain(b.getAttribute("type"));
      for (const a of all.filter((e) => e.tagName === "a")) expect(a.getAttribute("href"), s.path).toMatch(/^\//);
      for (const e of all) expect(["div", "span", "p", "li"].includes(e.tagName) && (e.hasAttribute("tabindex") || e.getAttribute("role") === "button"), `${s.path} <${e.tagName}> as a control`).toBe(false);
      // Messages are announced politely, and their place is kept so nothing moves when one appears.
      const messages = all.filter((e) => e.className.split(" ").includes("message") && e.parent?.tagName !== "noscript");
      expect(messages.length, s.path).toBeGreaterThan(0);
      for (const m of messages) {
        expect(m.getAttribute("role"), `${s.path} #${m.id}`).toBe("status");
        expect(m.getAttribute("aria-live"), `${s.path} #${m.id}`).toBe("polite");
      }
      // Each heading the script moves focus to can take it.
      for (const h of all.filter((e) => e.tagName === "h1")) expect(h.getAttribute("tabindex"), `${s.path} #${h.id}`).toBe("-1");
      expect(all.some((e) => e.tagName === "meta" && e.getAttribute("name") === "viewport" && e.getAttribute("content") === "width=device-width, initial-scale=1"), s.path).toBe(true);
    }
    // Every element the script looks up by id is on a page.
    const ids = new Set(PAGES.flatMap((s) => new FakeDocument(s.body).root.all().map((e) => e.id)));
    const asked = [...SIGNIN_JS.matchAll(/\$\("([a-z-]+)"\)/g)].map((m) => m[1]);
    expect(asked.length).toBeGreaterThan(10);
    for (const id of asked) expect(ids.has(id), `#${id}`).toBe(true);
    // The stylesheet: a visible focus ring, both colour schemes from the system, a reserved line for messages, phone width.
    expect(SIGNIN_CSS).toContain("@media (prefers-color-scheme: dark)");
    expect(SIGNIN_CSS).toContain(":focus-visible");
    expect(SIGNIN_CSS).toMatch(/\.message \{[^}]*min-height:/);
    expect(SIGNIN_CSS).toContain("@media (max-width: 480px)");
    expect(SIGNIN_CSS).toMatch(/overflow-wrap: anywhere/);
  });
});
