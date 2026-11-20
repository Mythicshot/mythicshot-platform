// The dashboard's Admin page, /admin, and its script /dash/admin.js: what their answers
// are (headers, where they answer, no database or storage call, nothing about anyone and
// the same document for an admin and a member), the exact wording of the approved mockups
// 9 and 10, and what the script's text may and may not do. What the script does when it
// runs, for an admin and for a member, and the size parser's table of inputs, are tested
// under Node in test/node-dash-admin.test.ts: the Workers runtime runs no code from a
// string, so on this target the parser's rule is pinned by its text.
import { describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { ADMIN_HTML, ADMIN_JS, SIZE_JS } from "../src/dash/admin.ts";
import { DASH_PAGES } from "../src/dash/routes.ts";
import { DASH_JS } from "../src/dash/script.ts";
import { DASH_CSS } from "../src/dash/style.ts";
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
const PAGE: Served = { path: "/admin", body: ADMIN_HTML, type: "text/html; charset=utf-8" };
const SCRIPT: Served = { path: "/dash/admin.js", body: ADMIN_JS, type: "text/javascript; charset=utf-8" };
const ALL = [PAGE, SCRIPT];

const seen = (c: Call) => ({ status: c.status, headers: [...c.headers.entries()].sort(), body: c.text });

/** A signed-in browser's cookie for a new account. */
async function signedIn(deps: Parameters<typeof seedAccount>[0], opts: { admin?: boolean; username?: string } = {}) {
  const account = await seedAccount(deps, opts);
  const made = await redeemSignInCode(deps, await createSignInCode(deps, account.userId), BROWSER, null);
  expect(made).not.toBeNull();
  return { ...account, cookie: `${SESSION_COOKIE}=${made!.secret}`, secret: made!.secret, sessionId: made!.sessionId, csrf: await csrfFor(made!.secret) };
}

// ---- The wording ----

/** Every text of the Admin page's body, in order, hidden parts included. Nothing else may be in it. */
const ADMIN_WORDING = [
  "Mythicshot",
  "Tours",
  "Storage",
  "Account",
  "Admin",
  "This page needs JavaScript.",
  "Accounts",
  "Account",
  "Workspace",
  "Tours",
  "Used",
  "Allowance",
  "Show more",
  "You see how much each workspace uses, never what is in it. Inviting people comes in a later phase.",
  "Page not found",
  "Back to Tours",
  "Allowance",
  "Cancel",
  "Save",
];

/** Every text the Admin page's script puts on the page. */
const ADMIN_TEXT: Record<string, string> = {
  oneAccount: "1 account",
  accounts: " accounts",
  dot: " · ",
  usedInAll: " used in all",
  standard: " · standard allowance ",
  noStandard: " · no standard allowance",
  admin: "Admin",
  over: "Over",
  none: "None",
  setAllowance: "Set allowance",
  tours: "Tours",
  used: "Used",
  allowance: "Allowance",
  askTitle: "Storage allowance for ",
  usesBefore: "Uses ",
  usesAfter: " now.",
  hintSize: "Write a size such as 500 MB or 10 GB.",
  hintStandardBefore: " Leave it empty to use the standard allowance of ",
  hintStandardAfter: ".",
  hintNone: " Leave it empty for no allowance.",
  warnBefore: "That is less than this workspace uses. Nothing is deleted, but its new uploads are refused until it is under ",
  warnAfter: ".",
  badSize: "Write a size such as 500 MB or 10 GB.",
  save: "Save",
  saveAnyway: "Save anyway",
  saving: "Saving…",
  notFound: "Page not found",
  disabled: "Disabled",
  notReloaded: "The change was made, but the list could not be loaded again. Reload the page to see it.",
};

/** The strings with a space in the script that are not words for a person: class names. */
const CLASS_NAMES = ["btn sm quiet", "tag warn", "n tours", "n used", "n allowance", "mini over"];

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

describe("the Admin page and its script", () => {
  it("each answers with the sign-in pages' headers, makes no database or storage call, and is in the dashboard's routes", async () => {
    const one = await makeDeps();
    const two = await makeDeps({ hosts: HOSTS });
    for (const s of ALL) {
      for (const [deps, origin] of [[one.deps, "https://any.example.org"], [one.deps, "http://localhost:3000"], [two.deps, APP]] as const) {
        const r = await send(deps, "GET", s.path, { origin });
        expect(r.status, `${origin} ${s.path}`).toBe(200);
        expect(r.text, s.path).toBe(s.body);
        expect(Object.fromEntries(r.headers.entries()), s.path).toEqual({ ...SECURITY, "content-type": s.type });
        expect(r.calls, `${s.path}: database and storage calls`).toBe(0);
      }
      const head = await send(two.deps, "HEAD", s.path, { origin: APP });
      expect([head.status, head.bytes.length, head.headers.get("content-security-policy"), head.calls], s.path).toEqual([200, 0, POLICY, 0]);
    }
    const entry = DASH_PAGES.find((p) => p.path === "/admin");
    expect(entry && [entry.path, entry.html, entry.script.path, entry.script.body]).toEqual(["/admin", ADMIN_HTML, "/dash/admin.js", ADMIN_JS]);
    expect(DASH_PAGES.filter((p) => p.path === "/admin" || p.script.path === "/dash/admin.js")).toHaveLength(1);
  });

  it("the page is the same for nobody, a member, an admin and a token, and holds nothing about anyone", async () => {
    const { deps } = await makeDeps({ hosts: HOSTS });
    const admin = await signedIn(deps, { admin: true, username: "admincheck-owner" });
    const member = await signedIn(deps, { username: "admincheck-member" });
    const secrets = [admin.email, member.email, "admincheck-owner", "admincheck-member", admin.userId, member.userId, admin.workspaceId, member.workspaceId, admin.token, member.token, admin.secret, member.secret, admin.sessionId, admin.csrf, member.csrf];
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
    // The admin screen is hidden in the document; only the script shows it, after the session says admin.
    const doc = new FakeDocument(ADMIN_HTML);
    expect(doc.getElementById("admin")!.hidden).toBe(true);
    expect(doc.getElementById("missing")!.hidden).toBe(true);
    expect(doc.getElementById("allow-dialog")!.hidden).toBe(true);
    expect(doc.getElementById("tab-admin")!.hidden).toBe(true);
    expect(doc.getElementById("tab-admin")!.getAttribute("aria-current")).toBe("page");
  });

  it("answers on the app address only: the tours address refuses it, an unknown address is misdirected", async () => {
    const two = await makeDeps({ hosts: HOSTS });
    await seedAccount(two.deps, { admin: true, username: "admincheck-admin" });
    const viewer = await signedIn(two.deps, { admin: false, username: "admincheck-viewer" });
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
  });

  it("the wording is mockups 9 and 10's own", () => {
    const doc = new FakeDocument(ADMIN_HTML);
    expect(textNodes(doc.body)).toEqual(ADMIN_WORDING);
    expect(textNodes(doc.head)).toEqual(["Admin"]);
    for (const e of doc.body.all()) for (const name of ["aria-label", "title", "alt", "placeholder"]) expect(e.hasAttribute(name), `<${e.tagName} ${name}>`).toBe(false);
    expect(scriptText(ADMIN_JS)).toEqual(ADMIN_TEXT);
    const words = new Set(Object.values(ADMIN_TEXT));
    const sentences = scriptStrings(ADMIN_JS).filter((t) => /[a-z]/i.test(t) && /\s/.test(t) && t !== "use strict");
    for (const t of sentences) expect(words.has(t) || CLASS_NAMES.includes(t), `a text outside TEXT: ${JSON.stringify(t)}`).toBe(true);
    // The sentences of mockups 9 and 10, put together from their parts.
    const T = ADMIN_TEXT;
    expect("3" + T.accounts + T.dot + "6.6 GB" + T.usedInAll + T.standard + "5 GB").toBe("3 accounts · 6.6 GB used in all · standard allowance 5 GB");
    expect(T.oneAccount + T.dot + "0 bytes" + T.usedInAll + T.noStandard).toBe("1 account · 0 bytes used in all · no standard allowance");
    expect(T.askTitle + "Harbor Studio").toBe("Storage allowance for Harbor Studio");
    expect(T.usesBefore + "5.3 GB" + T.usesAfter).toBe("Uses 5.3 GB now.");
    expect(T.hintSize + T.hintStandardBefore + "5 GB" + T.hintStandardAfter).toBe("Write a size such as 500 MB or 10 GB. Leave it empty to use the standard allowance of 5 GB.");
    expect(T.hintSize + T.hintNone).toBe("Write a size such as 500 MB or 10 GB. Leave it empty for no allowance.");
    expect(T.warnBefore + "2 GB" + T.warnAfter).toBe("That is less than this workspace uses. Nothing is deleted, but its new uploads are refused until it is under 2 GB.");
    // The failure sentences are the shared script's approved ones; the page has none of its own.
    expect(ADMIN_JS).toContain("Dash.failure(");
    expect(ADMIN_JS).not.toMatch(/Something went wrong|Too many requests/);
    // Text only through textContent; no confirm().
    for (const api of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "createContextualFragment", "DOMParser", "srcdoc", "confirm(", "alert(", "prompt("]) expect(ADMIN_JS, api).not.toContain(api);
  });

  it("the page loads nothing from another origin and carries no inline script, style or handler", () => {
    const doc = new FakeDocument(ADMIN_HTML);
    const all = doc.root.all();
    expect(all.filter((e) => e.tagName === "script").map((e) => [e.getAttribute("src"), e.hasAttribute("defer"), e.textContent])).toEqual([
      ["/dash/dash.js", true, ""],
      ["/dash/admin.js", true, ""],
    ]);
    expect(all.filter((e) => e.tagName === "link").map((e) => [e.getAttribute("rel"), e.getAttribute("href")])).toEqual([["stylesheet", "/dash/dash.css"]]);
    expect(all.filter((e) => e.tagName === "style")).toEqual([]);
    for (const e of all) {
      for (const [name, value] of e.attrs) {
        expect(name === "style" || name.startsWith("on"), `<${e.tagName} ${name}>`).toBe(false);
        if (["src", "href", "action", "formaction", "srcset", "poster", "data"].includes(name)) expect(value, name).toMatch(/^\/(?!\/)/);
      }
    }
    expect(ADMIN_HTML).not.toMatch(/https?:|\/\//i);
    expect(all.filter((e) => e.tagName === "form")).toEqual([]);
    // The script sets no style or handler attribute; the one style it touches is a bar's width, through the CSSOM.
    expect(ADMIN_JS).not.toMatch(/setAttribute\("(?:style|on[a-z]+|src|srcdoc|href)"/);
    expect(ADMIN_JS).not.toMatch(/\.on[a-z]+\s*=/);
    expect([...ADMIN_JS.matchAll(/\.style\b[^;]*/g)].map((m) => m[0])).toEqual(['.style.width = width + "%"']);
    expect(DASH_CSS).not.toMatch(/url\(|@import|https?:|\/\/|expression\(/i);
  });

  it("the script keeps to this site and to the admin routes, and a member's page asks for nothing of them", () => {
    expect(ADMIN_JS).not.toMatch(/\bfetch\(/);
    expect(ADMIN_JS).not.toMatch(/csrf/i);
    // Every request, by method and path.
    const requests = [...ADMIN_JS.matchAll(/\bapi\("([A-Z]+)", ([^,)]*)/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(requests.sort()).toEqual(['GET "/api/v1/admin/summary"', "GET path", "PATCH WORKSPACES + encodeURIComponent(id"].sort());
    expect(ADMIN_JS).toContain('var ACCOUNTS = "/api/v1/admin/accounts";');
    expect(ADMIN_JS).toContain('var WORKSPACES = "/api/v1/admin/workspaces/";');
    expect(ADMIN_JS).toContain('var path = after === null ? ACCOUNTS : ACCOUNTS + "?after=" + encodeURIComponent(after);');
    // The ids that go into an address are checked first.
    expect(ADMIN_JS).toContain("var USER_ID = /^usr_[0-9a-f]{24}$/;");
    expect(ADMIN_JS).toContain("var WORKSPACE_ID = /^ws_[0-9a-f]{24}$/;");
    // Nothing is asked of the admin routes before the session says admin.
    expect(ADMIN_JS).toContain("if (who.admin !== true) { notFound(); return; }");
    // Nothing is stored, no cookie is touched, and leaving the page goes only to /signin, through the shared script.
    const forbidden = ["localStorage", "sessionStorage", "indexedDB", "cookie", "cookieStore", "caches", "postMessage", "window.name", "pushState", "replaceState", "location", "sendBeacon", "XMLHttpRequest", "WebSocket", "EventSource", "import(", "eval(", "Function(", "console.", "window.open", "setInterval(", "setTimeout(", "document.referrer", "navigator."];
    for (const api of forbidden) expect(ADMIN_JS, api).not.toContain(api);
    // No other page serves, loads or names the Admin page's script.
    for (const p of DASH_PAGES.filter((x) => x.path !== "/admin")) {
      expect(p.html, p.path).not.toContain("/dash/admin.js");
      expect(p.script.body, p.path).not.toContain("admin.js");
    }
    expect(DASH_JS).not.toContain("admin.js");
    // The one link in the page leads back to Tours.
    const links = new FakeDocument(ADMIN_HTML).body.all().filter((e) => e.tagName === "a" && e.parent?.tagName !== "nav");
    expect(links.map((a) => [a.getAttribute("href"), a.textContent])).toEqual([["/tours", "Back to Tours"]]);
  });

  it("the size parser's rule: digits with at most one decimal part, then B, byte(s), KB, MB or GB in any case, 1024 to the next unit", () => {
    expect(ADMIN_JS).toContain(SIZE_JS);
    expect(SIZE_JS).toContain("var SIZE = /^([0-9]+)(?:\\.([0-9]+))?\\s*(b|bytes?|kb|mb|gb)?$/i;");
    expect(SIZE_JS).toContain('var UNITS = { b: 1, byte: 1, bytes: 1, kb: 1024, mb: 1048576, gb: 1073741824 };');
    expect(SIZE_JS).toContain("var MAX_BYTES = 9007199254740991;");
    expect(SIZE_JS).toContain("Math.round(");
  });

  it("the page is usable with the keyboard and a screen reader, and its table becomes blocks on a phone", () => {
    const doc = new FakeDocument(ADMIN_HTML);
    const all = doc.root.all();
    for (const b of all.filter((e) => e.tagName === "button")) expect(b.getAttribute("type"), `#${b.id}`).toBe("button");
    const messages = all.filter((e) => /\b(?:message|load)\b/.test(e.className) && e.parent?.tagName !== "noscript");
    expect(messages.map((m) => m.id).sort()).toEqual(["admin-message", "allow-message", "dash-load"]);
    for (const m of messages) expect([m.getAttribute("role"), m.getAttribute("aria-live")], `#${m.id}`).toEqual(["status", "polite"]);
    // A message line takes no room until it has a message.
    for (const m of messages.filter((e) => e.id !== "dash-load")) expect(m.hidden, `#${m.id}`).toBe(true);
    // The page behind the question, made inert while it is open: the bar and the admin screen.
    expect(ADMIN_JS).toContain('var BEHIND = ["dash-top", "admin"];');
    for (const h of all.filter((e) => e.tagName === "h1" || e.tagName === "h2")) expect(h.getAttribute("tabindex"), `#${h.id}`).toBe("-1");
    const dialog = all.find((e) => e.getAttribute("role") === "dialog")!;
    expect([dialog.getAttribute("aria-modal"), dialog.getAttribute("aria-labelledby"), dialog.getAttribute("aria-describedby")]).toEqual(["true", "allow-title", "allow-uses"]);
    const input = doc.getElementById("allow-input")!;
    expect([input.tagName, input.getAttribute("type"), input.getAttribute("autocomplete"), input.getAttribute("spellcheck"), input.getAttribute("aria-describedby")]).toEqual(["input", "text", "off", "false", "allow-hint allow-warn allow-message"]);
    expect(all.find((e) => e.tagName === "label")!.getAttribute("for")).toBe("allow-input");
    // Every element the script looks up by id is on the page.
    const ids = new Set(all.map((e) => e.id));
    const asked = [...ADMIN_JS.matchAll(/\$\("([a-z-]+)"\)/g)].map((m) => m[1]);
    expect(asked.length).toBeGreaterThan(10);
    for (const id of asked) expect(ids.has(id), `#${id}`).toBe(true);
    // The Admin page's own styles, after the shared ones: the small bar, the warning, and blocks on a phone.
    const own = DASH_CSS.slice(DASH_CSS.indexOf("/* The Admin page. */"));
    expect(DASH_CSS.indexOf("/* The Admin page. */")).toBeGreaterThan(DASH_CSS.indexOf("/* The Tours page. */"));
    expect(own).toContain(".accounts .mini { min-width: 80px; }");
    expect(own).toContain(".accounts .mini.over i { background: var(--warn-bar); }");
    expect(own).toContain(".warn-box { background: var(--warn-bg); color: var(--warn-text);");
    const phone = [...own.matchAll(/@media \(max-width: 720px\) \{\n([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
    expect(phone).toContain(".accounts, .accounts tbody, .accounts tr, .accounts td { display: block; }");
    expect(phone).toContain(".accounts thead { display: none; }");
    expect(phone).toContain(".accounts td[data-label]::before { content: attr(data-label); ");
    expect(DASH_CSS).not.toMatch(/overflow-x|100vw/);
  });
});
