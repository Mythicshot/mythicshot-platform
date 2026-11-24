// The dashboard's Account page, GET /account with its script /dash/account.js, and the page
// an email-change link opens, GET /account/email with its script /dash/account-email.js.
// What their answers are (headers, where they answer, that they cost no database or storage
// call and hold nothing about anyone), the exact wording of the approved mockups 7 and 8
// (and the proposed sentences, marked below), and what the scripts' text may and may not do,
// above all with the code a link carries. What the scripts do when they run is tested under
// Node in test/node-dash-account.test.ts.
import { describe, expect, it } from "vitest";
import { MANROPE_FACE } from "../src/brand-css.ts";
import { makeDeps, seedAccount } from "#harness";
import { ACCOUNT_EMAIL_HTML, ACCOUNT_EMAIL_JS } from "../src/dash/account-email.ts";
import { ACCOUNT_HTML, ACCOUNT_JS } from "../src/dash/account.ts";
import { DASH_LINK_PAGES, DASH_PAGES } from "../src/dash/routes.ts";
import { DASH_JS } from "../src/dash/script.ts";
import { DASH_CSS } from "../src/dash/style.ts";
import { UNDOCUMENTED_ROUTES } from "../src/docs/openapi.ts";
import { EMAIL_CHANGE_SAYS } from "../src/email-change.ts";
import { HOST_RULES } from "../src/host-gate.ts";
import type { Hosts } from "../src/hosts.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import { SIGNIN_JS } from "../src/signin/page.ts";
import { send, type Call } from "./bundle.ts";
import { expectNoForbiddenApis, expectPageShape, isBrandMarkAlt } from "./dash-checks.ts";
import { FakeDocument, textNodes } from "./pages-dom.ts";

const HOSTS: Hosts = { tours: "tours.example.com", app: "app.example.com" };
const TOURS = "https://tours.example.com";
const APP = "https://app.example.com";
const UNKNOWN = "https://evil.example.net";
const NOT_FOUND = '{"error":"not_found"}';
const BROWSER = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";
const POLICY = "default-src 'none'; img-src 'self'; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const SECURITY: Record<string, string> = {
  "content-security-policy": POLICY,
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "cross-origin-opener-policy": "same-origin",
};

type Served = { path: string; body: string; type: string };
const HTML = "text/html; charset=utf-8";
const JS = "text/javascript; charset=utf-8";
const ALL: Served[] = [
  { path: "/account", body: ACCOUNT_HTML, type: HTML },
  { path: "/dash/account.js", body: ACCOUNT_JS, type: JS },
  { path: "/account/email", body: ACCOUNT_EMAIL_HTML, type: HTML },
  { path: "/dash/account-email.js", body: ACCOUNT_EMAIL_JS, type: JS },
];
const PAGES = [
  { path: "/account", html: ACCOUNT_HTML, script: "/dash/account.js", js: ACCOUNT_JS },
  { path: "/account/email", html: ACCOUNT_EMAIL_HTML, script: "/dash/account-email.js", js: ACCOUNT_EMAIL_JS },
];

const seen = (c: Call) => ({ status: c.status, headers: [...c.headers.entries()].sort(), body: c.text });

function expectServed(r: Call, s: Served, what: string): void {
  expect(r.status, what).toBe(200);
  expect(r.text, what).toBe(s.body);
  expect(Object.fromEntries(r.headers.entries()), what).toEqual({ ...SECURITY, "content-type": s.type });
  expect(r.calls, `${what}: database and storage calls`).toBe(0);
}

async function signedIn(deps: Parameters<typeof seedAccount>[0], opts: { admin?: boolean; username?: string } = {}) {
  const account = await seedAccount(deps, opts);
  const made = await redeemSignInCode(deps, await createSignInCode(deps, account.userId), BROWSER, null);
  expect(made).not.toBeNull();
  return { ...account, cookie: `${SESSION_COOKIE}=${made!.secret}`, secret: made!.secret, sessionId: made!.sessionId, csrf: await csrfFor(made!.secret) };
}

// ---- The wording ----

const SHELL = ["Mythicshot", "Images", "GIFs", "Tours", "Storage", "Connections", "Account", "Admin", "This page needs JavaScript."];

/** Not in the mockups: the line under the address when the site cannot send mail, the server's own sentence (review follow-up L6). */
const MAIL_OFF_LINE = "This site cannot send mail, so an email address cannot be changed here.";

/** Every text of the Account page's body, in order, hidden parts included (mockups 7 and 8). */
const ACCOUNT_WORDING = [
  ...SHELL,
  "Account",
  "Your details",
  "Username",
  "Email address",
  "Change",
  MAIL_OFF_LINE,
  "Workspace",
  // 0.1.53: the line on the site's terms, hidden unless the account has agreed to a version
  // (its sentence is filled by the script; test/dash-terms.test.ts pins it).
  "\u2713",
  "Read them",
  // Plan 2i: the download card, hidden unless the session names a usable download page.
  "Mythicshot for Windows",
  "Get the installer from the download page. It shows the latest version and its checksum.",
  // 0.1.60: Download all my data, in every state (billing mockups, section 7).
  "Download all my data",
  "One zip file with your tours, images and clips, and a list of what's in your account.",
  "Download",
  "Where you are signed in",
  "Sign out",
  "Sign out everywhere",
  "Change your email address",
  "New email address",
  "We send a link to the new address. Your address changes when you open it.",
  "Cancel",
  "Send the link",
  "Open the link we sent there to finish. It works once and for 15 minutes. Until then you keep signing in with",
  ".",
  "Done",
];

/** Every text the Account page's script puts on the page. */
const ACCOUNT_TEXT: Record<string, string> = {
  signedIn: "Signed in",
  signedInAs: "Signed in as ",
  thisBrowser: "This browser",
  since: "since ",
  lastUsed: "last used ",
  signOut: "Sign out",
  signingOut: "Signing out…",
  notEnded: "That session could not be ended. Reload the page.",
  badEmail: "That does not look like an email address.",
  sending: "Sending…",
  checkBefore: "Check ",
  openDownload: "Open the download page",
  // Proposed (Plan 2j): when a session ends however much it is used, beside it in the list.
  ends: "Ends ",
  // 0.1.53: the line on the site's terms, "You agreed to the terms of <version> on <date>."
  agreedBefore: "You agreed to the terms of ",
  agreedMiddle: " on ",
  agreedAfter: ".",
};

/** Every text of the page a link opens, in order, hidden parts included. Proposed: all but mockup 8's third box. */
const EMAIL_WORDING = [
  ...SHELL,
  "Confirm your new email address",
  "Press the button to make this your Mythicshot email address.",
  "Confirm",
  "Sign in first",
  "Sign in with your current email address, then open the link from your mail again.",
  "Sign in",
  "Sign-in links go to this address from now on. We sent a notice to",
  ".",
  "Back to your account",
  "Confirm your new email address",
  EMAIL_CHANGE_SAYS.badCode,
  // Proposed (review follow-up L3): for a person with more than one account.
  "If you have more than one account, sign in to the one that asked for the change and open the link again.",
  "Back to your account",
];

const EMAIL_TEXT: Record<string, string> = {
  confirming: "Confirming…",
  nowBefore: "Your email address is now ",
};

/** The strings with a space in the scripts that are not words for a person: class names. */
const CLASS_NAMES = ["tag ok", "btn sm quiet", "row session", "btn quiet"];

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

function scriptStrings(script: string): string[] {
  const js = script
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  return [...[...js.matchAll(/"(?:[^"\\\n]|\\.)*"/g)].map((m) => JSON.parse(m[0]) as string), ...[...js.matchAll(/'[^'\\\n]*'/g)].map((m) => m[0].slice(1, -1))];
}

/** The lines of a script that are code: trimmed, without blank lines and comments. */
const codeLines = (js: string) =>
  js
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("//"));

describe("the Account page and the page an email-change link opens", () => {
  it("answer with the sign-in pages' headers and make no database or storage call, on one address and on the app address", async () => {
    const one = await makeDeps();
    const two = await makeDeps({ hosts: HOSTS });
    for (const s of ALL) {
      expectServed(await send(one.deps, "GET", s.path, { origin: "https://any.example.org" }), s, `one address ${s.path}`);
      expectServed(await send(one.deps, "GET", s.path, { origin: "http://localhost:3000" }), s, `localhost ${s.path}`);
      expectServed(await send(two.deps, "GET", s.path, { origin: APP }), s, `app address ${s.path}`);
      const head = await send(two.deps, "HEAD", s.path, { origin: APP });
      expect([head.status, head.bytes.length, head.headers.get("content-security-policy"), head.calls], s.path).toEqual([200, 0, POLICY, 0]);
      // A query string changes nothing: the page is the same fixed text.
      expectServed(await send(two.deps, "GET", `${s.path}?c=x`, { origin: APP }), s, `with a query ${s.path}`);
    }
    // The Account page is a dashboard page; the link's page is served the same way, in a list of its own.
    expect(DASH_PAGES.filter((p) => p.path === "/account").map((p) => [p.html, p.script.path, p.script.body])).toEqual([[ACCOUNT_HTML, "/dash/account.js", ACCOUNT_JS]]);
    expect(DASH_LINK_PAGES.map((p) => [p.path, p.html, p.script.path, p.script.body])).toEqual([["/account/email", ACCOUNT_EMAIL_HTML, "/dash/account-email.js", ACCOUNT_EMAIL_JS]]);
    const paths = [...DASH_PAGES, ...DASH_LINK_PAGES].flatMap((p) => [p.path, p.script.path]);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("hold nothing about anyone: the same answer for nobody, a member, an admin and a token", async () => {
    const { deps } = await makeDeps({ hosts: HOSTS });
    const admin = await signedIn(deps, { admin: true, username: "acctcheck-owner" });
    const member = await signedIn(deps, { username: "acctcheck-member" });
    const secrets = [admin.email, member.email, "acctcheck-owner", "acctcheck-member", admin.userId, member.userId, admin.workspaceId, member.workspaceId, admin.token, member.token, admin.secret, member.secret, admin.sessionId, member.sessionId, admin.csrf, member.csrf];
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
    // Nothing names an admin route or field; the Admin tab is hidden as on every page.
    for (const p of PAGES) {
      for (const text of [p.html, p.js]) {
        expect(text, p.path).not.toContain("/api/v1/admin");
        expect(text, p.path).not.toMatch(/allowance|accounts|is_admin/);
      }
      expect(new FakeDocument(p.html).getElementById("tab-admin")!.hidden, p.path).toBe(true);
    }
  });

  it("answer on the app address only: the tours address answers 404, an unknown one 421", async () => {
    const two = await makeDeps({ hosts: HOSTS });
    await seedAccount(two.deps, { admin: true, username: "acctcheck-admin" });
    const viewer = await signedIn(two.deps, { username: "acctcheck-viewer" });
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

  it("the Account page's wording is mockup 7 and 8's own, with the Account tab current", () => {
    const doc = new FakeDocument(ACCOUNT_HTML);
    expect(textNodes(doc.body)).toEqual(ACCOUNT_WORDING);
    expect(textNodes(doc.head)).toEqual(["Account"]);
    for (const e of doc.body.all()) for (const name of ["aria-label", "title", "alt", "placeholder"]) expect(e.hasAttribute(name) && !isBrandMarkAlt(e, name), `<${e.tagName} ${name}>`).toBe(false);
    const current = doc.body.all().filter((e) => e.tagName === "a" && e.getAttribute("aria-current") === "page");
    expect(current.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([["Account", "/account"]]);
    // Each sentence where it belongs.
    expect(doc.getElementById("email-change")!.textContent).toBe("Change");
    expect(doc.getElementById("email-off")!.textContent).toBe(MAIL_OFF_LINE);
    expect(MAIL_OFF_LINE).toBe(EMAIL_CHANGE_SAYS.mailOff);
    expect(doc.getElementById("change-title")!.textContent).toBe("Change your email address");
    expect(doc.getElementById("change-hint")!.textContent).toBe("We send a link to the new address. Your address changes when you open it.");
    expect([doc.getElementById("change-cancel")!.textContent, doc.getElementById("change-send")!.textContent]).toEqual(["Cancel", "Send the link"]);
    expect(doc.getElementById("sent-text")!.textContent).toBe("Open the link we sent there to finish. It works once and for 15 minutes. Until then you keep signing in with .");
    expect(doc.getElementById("sent-done")!.textContent).toBe("Done");
    expect([doc.getElementById("signout")!.textContent, doc.getElementById("signout-everywhere")!.textContent]).toEqual(["Sign out", "Sign out everywhere"]);
    // The download card: above Where you are signed in, hidden until the script has a usable address, its link made by the shared script.
    const card = doc.getElementById("download-card")!;
    expect([card.className, card.hidden]).toEqual(["card", true]);
    expect(doc.getElementById("h-download")!.textContent).toBe("Mythicshot for Windows");
    expect(doc.getElementById("download-text")!.textContent).toBe("Get the installer from the download page. It shows the latest version and its checksum.");
    expect(doc.getElementById("download-actions")!.children).toEqual([]);
    expect(ACCOUNT_HTML.indexOf('id="download-card"')).toBeGreaterThan(ACCOUNT_HTML.indexOf('id="h-details"'));
    expect(ACCOUNT_HTML.indexOf('id="download-card"')).toBeLessThan(ACCOUNT_HTML.indexOf('id="h-where"'));
    expect(ACCOUNT_JS).toContain('var link = Dash.downloadLink(TEXT.openDownload, "btn quiet");');
    // The Change button and the mail-off line both start hidden: the session decides which shows.
    expect([doc.getElementById("email-change")!.hidden, doc.getElementById("email-off")!.hidden]).toEqual([true, true]);
    // The old account page's storage block lives on /storage now.
    for (const word of ["Storage</h2>", "usage", "allowance", "Tours are managed from Mythicshot"]) expect(ACCOUNT_HTML + ACCOUNT_JS, word).not.toContain(word);
    // The script's words are exactly these, and it has no other sentence.
    expect(scriptText(ACCOUNT_JS)).toEqual(ACCOUNT_TEXT);
    expect(ACCOUNT_TEXT.checkBefore + "new@example.com").toBe("Check new@example.com");
    expect(ACCOUNT_TEXT.signedInAs + "solex").toBe("Signed in as solex");
    const words = new Set(Object.values(ACCOUNT_TEXT));
    for (const t of scriptStrings(ACCOUNT_JS).filter((t) => /[a-z]/i.test(t) && /\s/.test(t) && t !== "use strict")) expect(words.has(t) || CLASS_NAMES.includes(t), `a text outside TEXT: ${JSON.stringify(t)}`).toBe(true);
    // The busy label, the address check and the failure sentences are the sign-in page's own.
    expect(ACCOUNT_TEXT.badEmail).toBe("That does not look like an email address.");
    expect(SIGNIN_JS).toContain('badEmail: "That does not look like an email address."');
    expect(SIGNIN_JS).toContain('sending: "Sending…"');
  });

  it("Download all my data is section 7's card, shown in every state, with no words of its own in the script but the failure sentence it shares", () => {
    const doc = new FakeDocument(ACCOUNT_HTML);
    const card = doc.getElementById("data-card")!;
    // Never hidden: not by billing, not by the session; the page is shown once the session has answered.
    expect([card.className, card.hidden]).toEqual(["card", false]);
    expect(doc.getElementById("h-data")!.textContent).toBe("Download all my data");
    expect(doc.getElementById("data-text")!.textContent).toBe("One zip file with your tours, images and clips, and a list of what's in your account.");
    const button = doc.getElementById("data-download")!;
    expect([button.tagName, button.getAttribute("type"), button.textContent]).toEqual(["button", "button", "Download"]);
    expect(doc.getElementById("data-message")!.hidden).toBe(true);
    // After the details and the download card, before where the account is signed in.
    expect(ACCOUNT_HTML.indexOf('id="data-card"')).toBeGreaterThan(ACCOUNT_HTML.indexOf('id="download-card"'));
    expect(ACCOUNT_HTML.indexOf('id="data-card"')).toBeLessThan(ACCOUNT_HTML.indexOf('id="h-where"'));
    // The script asks for the download, takes only an address of exactly the server's shape, and opens it as a download of this site.
    expect(ACCOUNT_JS).toContain('Dash.api("POST", "/api/v1/account/data").then(');
    expect(ACCOUNT_JS).toContain("var DATA_URL = /^\\/api\\/v1\\/account\\/data\\/[0-9a-f]{76}$/;");
    expect(ACCOUNT_JS).toContain('if (typeof url !== "string" || !DATA_URL.test(url)) { back(res); return; }');
    expect(ACCOUNT_JS).toContain('Dash.saveFile(url, "mythicshot-data.zip");');
    // While it asks, the button is disabled with no new words; a failure is the dashboard's own sentence.
    expect(ACCOUNT_JS).toContain("sayIn(message, Dash.failure(res));");
    const block = ACCOUNT_JS.slice(ACCOUNT_JS.indexOf("function downloadData()"), ACCOUNT_JS.indexOf("function startPage()"));
    expect(block).not.toContain("busy(");
    expect(block).not.toContain("TEXT.");
  });

  it("the link's page has the proposed wording and mockup 8's third box, and its sentence for a dead link is the server's", () => {
    const doc = new FakeDocument(ACCOUNT_EMAIL_HTML);
    expect(textNodes(doc.body)).toEqual(EMAIL_WORDING);
    expect(textNodes(doc.head)).toEqual(["Confirm your new email address"]);
    for (const e of doc.body.all()) for (const name of ["aria-label", "title", "alt", "placeholder"]) expect(e.hasAttribute(name) && !isBrandMarkAlt(e, name), `<${e.tagName} ${name}>`).toBe(false);
    expect(doc.body.all().filter((e) => e.tagName === "a" && e.getAttribute("aria-current") === "page").map((a) => a.textContent)).toEqual(["Account"]);
    // Every state starts hidden: the script shows one, and none before it knows which.
    for (const id of ["confirm", "first", "done", "dead"]) expect(doc.getElementById(id)!.hidden, id).toBe(true);
    expect(doc.getElementById("confirm-button")!.textContent).toBe("Confirm");
    expect(doc.getElementById("first-button")!.textContent).toBe("Sign in");
    // Both ways back lead to the account page.
    const back = doc.body.all().filter((e) => e.tagName === "a" && e.textContent === "Back to your account");
    expect(back.map((a) => a.getAttribute("href"))).toEqual(["/account", "/account"]);
    expect(doc.getElementById("dead")!.textContent).toContain("This link no longer works. Ask for a new one from your account page.");
    expect(scriptText(ACCOUNT_EMAIL_JS)).toEqual(EMAIL_TEXT);
    expect(EMAIL_TEXT.nowBefore + "new@example.com").toBe("Your email address is now new@example.com");
    const words = new Set(Object.values(EMAIL_TEXT));
    for (const t of scriptStrings(ACCOUNT_EMAIL_JS).filter((t) => /[a-z]/i.test(t) && /\s/.test(t) && t !== "use strict")) expect(words.has(t), `a text outside TEXT: ${JSON.stringify(t)}`).toBe(true);
  });

  it("the link page's script takes the code from the address, removes it from the address bar before anything else, and sends it only in the confirm request's body", () => {
    const js = ACCOUNT_EMAIL_JS;
    // The first statements, before any other: read the part after #, then clean the address bar.
    expect(codeLines(js).slice(0, 4)).toEqual(["(function () {", '"use strict";', "var fragment = location.hash;", 'if (fragment !== "") history.replaceState(null, "", location.pathname + location.search);']);
    expect(js.match(/location\.hash/g)).toHaveLength(1);
    expect(js.match(/replaceState/g)).toHaveLength(1);
    // The code is taken only in the shape a link carries.
    expect(js).toContain("var match = /^#c=(dpe_[0-9a-f]{40})$/.exec(fragment);");
    // It is sent from one place: the request the press makes, as a JSON body, through the shared Dash.api.
    expect(js.match(/\/api\/v1\/account\/email\/confirm/g)).toHaveLength(1);
    const press = js.indexOf('$("confirm-button").addEventListener("click"');
    const sent = js.indexOf('Dash.api("POST", "/api/v1/account/email/confirm", { code: code })');
    expect(press).toBeGreaterThan(0);
    expect(sent).toBeGreaterThan(press);
    expect(js.slice(press, sent)).not.toMatch(/\}\);\n/);
    for (const m of js.matchAll(/\bcode\b/g)) {
      const line = js.slice(js.lastIndexOf("\n", m.index) + 1, js.indexOf("\n", m.index)).trim();
      expect(
        ['var code = match === null ? "" : match[1];', 'code = "";', 'if (code === "") {', 'if (code === "" || btn.disabled) return;', 'Dash.api("POST", "/api/v1/account/email/confirm", { code: code }).then(function (res) {'].some((ok) => line === ok) || line.startsWith("//"),
        `a use of the code: ${line}`,
      ).toBe(true);
    }
    // The checks every dashboard page script has (test/dash-checks.ts), shared, not copied.
    expectNoForbiddenApis(js, "/dash/account-email.js");
    // Nothing writes it anywhere else, puts it in an address, or logs it.
    const forbidden = ["localStorage", "sessionStorage", "indexedDB", "cookie", "cookieStore", "caches", "postMessage", "window.name", "pushState", "location.href", "location.hash =", "location.search =", "location.assign", "sendBeacon", "XMLHttpRequest", "WebSocket", "EventSource", "import(", "eval(", "Function(", "console.", "open(", "setTimeout(", "setInterval(", "document.referrer", "?c=", "?code", "fetch(", "csrf"];
    for (const api of forbidden) expect(js, api).not.toContain(api);
    expect(js).not.toMatch(/\blocation\s*=(?!=)/);
    expect(js).not.toMatch(/\b(?:window|document|self|top|parent|globalThis)\s*\.\s*location\b/);
    const uses = [...js.matchAll(/\blocation\b\s*(\.\s*[a-zA-Z]+)?/g)].map((m) => (m[1] ?? "").replace(/\s/g, ""));
    expect(new Set(uses)).toEqual(new Set([".hash", ".pathname", ".search"]));
    // Its requests: the confirm, and after a lost answer the session read again (which carries
    // no code); leaving only through the shared script (to /signin).
    expect([...js.matchAll(/\bapi\("([A-Z]+)", ("[^"]*")/g)].map((m) => `${m[1]} ${m[2]}`).sort()).toEqual(['GET "/api/v1/session"', 'POST "/api/v1/account/email/confirm"']);
    expect(js).toContain('Dash.api("GET", "/api/v1/session").then(function (res) {');
    expect(js).toContain("Dash.signedOut()");
    // A page without a code in the right shape asks nothing: the dead link comes before Dash.start.
    expect(js.indexOf('if (code === "") {')).toBeLessThan(js.indexOf("Dash.start("));
  });

  it("the Account page's script keeps to this site: its requests, the anti-forgery header from the shared script, and leaving only for /signin", () => {
    const js = ACCOUNT_JS;
    const requests = [...js.matchAll(/\bapi\("([A-Z]+)", ("[^"]*")/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(requests.sort()).toEqual(['DELETE "/api/v1/sessions/"', 'GET "/api/v1/sessions"', 'POST "/api/v1/account/data"', 'POST "/api/v1/account/email"', 'POST "/api/v1/signout"', 'POST "/api/v1/signout/everywhere"'].sort());
    expect(js).toContain('Dash.api("DELETE", "/api/v1/sessions/" + encodeURIComponent(id))');
    expect(js).toContain('Dash.api("POST", "/api/v1/account/email", { email: value })');
    // Every change carries the X-Csrf-Token header: Dash.api adds it to every request that is not a GET.
    expect(DASH_JS).toContain('if (method !== "GET" && method !== "HEAD") headers["X-Csrf-Token"] = csrf;');
    const forbidden = ["fetch(", "csrf", "localStorage", "sessionStorage", "indexedDB", "cookie", "cookieStore", "caches", "postMessage", "window.name", "pushState", "replaceState", "location", "sendBeacon", "XMLHttpRequest", "WebSocket", "EventSource", "import(", "eval(", "Function(", "console.", "window.open", "setInterval(", "setTimeout(", "document.referrer", "navigator", "innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "confirm(", "alert(", "prompt("];
    for (const api of forbidden) expect(js, api).not.toContain(api);
    expect(js).toContain("Dash.signedOut()");
    // The shared script hands the page what the session says, and leaves the one who is signed out to a page that asks for it.
    expect(DASH_JS).toContain("emailChange: d.email_change === true");
    expect(DASH_JS).toContain('if (typeof whenSignedOut === "function") whenSignedOut();');
  });

  it("both pages load nothing from another origin, carry no inline script, style or handler, and are usable with the keyboard and a screen reader", () => {
    // The Account page has these through test/dash.test.ts (it is in DASH_PAGES); the link page, served apart, here.
    expectPageShape(ACCOUNT_EMAIL_HTML, "/account/email");
    expectNoForbiddenApis(ACCOUNT_JS, "/dash/account.js");
    for (const p of PAGES) {
      const doc = new FakeDocument(p.html);
      const all = doc.root.all();
      expect(all.filter((e) => e.tagName === "script").map((e) => [e.getAttribute("src"), e.hasAttribute("defer"), e.textContent]), p.path).toEqual([
        ["/dash/dash.js", true, ""],
        [p.script, true, ""],
      ]);
      expect(all.filter((e) => e.tagName === "link").map((e) => [e.getAttribute("rel"), e.getAttribute("href")]), p.path).toEqual([["icon", "/favicon.ico"], ["icon", "/favicon.svg"], ["stylesheet", "/dash/dash.css"]]);
      expect(all.filter((e) => e.tagName === "style" || e.tagName === "form"), p.path).toEqual([]);
      for (const e of all) {
        for (const [name, value] of e.attrs) {
          expect(name === "style" || name.startsWith("on"), `${p.path} <${e.tagName} ${name}>`).toBe(false);
          if (["src", "href", "action", "formaction", "srcset", "poster", "data"].includes(name)) expect(value, `${p.path} ${name}`).toMatch(/^\/(?!\/)/);
        }
      }
      expect(p.html, p.path).not.toMatch(/https?:|\/\//i);
      expect(p.js, p.path).not.toMatch(/https?:|\/\/[a-z]/i);
      expect(p.js, p.path).not.toMatch(/setAttribute\(\s*["'](?:style|on[a-z]+|src|srcdoc|href)["']/);
      expect(p.js, p.path).not.toMatch(/\.style\b|cssText|setProperty\(|\.on[a-z]+\s*=/);
      expect(all.some((e) => e.tagName === "meta" && e.getAttribute("name") === "referrer" && e.getAttribute("content") === "no-referrer"), p.path).toBe(true);
      for (const b of all.filter((e) => e.tagName === "button")) expect(b.getAttribute("type"), `${p.path} #${b.id}`).toBe("button");
      for (const input of all.filter((e) => e.tagName === "input")) expect(all.some((e) => e.tagName === "label" && e.getAttribute("for") === input.id), `${p.path} #${input.id}`).toBe(true);
      const messages = all.filter((e) => /\b(?:message|load)\b/.test(e.className) && e.parent?.tagName !== "noscript");
      for (const m of messages) expect([m.getAttribute("role"), m.getAttribute("aria-live")], `${p.path} #${m.id}`).toEqual(["status", "polite"]);
      for (const m of messages.filter((e) => e.id !== "dash-load")) expect(m.hidden, `${p.path} #${m.id}`).toBe(true);
      for (const h of all.filter((e) => e.tagName === "h1" || e.tagName === "h2")) expect(h.getAttribute("tabindex"), `${p.path} #${h.id}`).toBe("-1");
      const ids = new Set(all.map((e) => e.id));
      const asked = [...p.js.matchAll(/\$\("([a-z-]+)"\)/g)].map((m) => m[1]);
      expect(asked.length, p.path).toBeGreaterThan(4);
      for (const id of asked) expect(ids.has(id), `${p.path} #${id}`).toBe(true);
    }
    const account = new FakeDocument(ACCOUNT_HTML);
    expect(account.root.all().filter((e) => /\bmessage\b/.test(e.className) && e.parent?.tagName !== "noscript").map((m) => m.id).sort()).toEqual(["account-message", "change-message", "data-message"]);
    // The two dialogs: tied to their titles and texts, outside the part of the page made inert while one is open.
    const dialogs = account.body.all().filter((e) => e.getAttribute("role") === "dialog");
    expect(dialogs.map((d) => [d.getAttribute("aria-modal"), d.getAttribute("aria-labelledby"), d.getAttribute("aria-describedby")])).toEqual([
      ["true", "change-title", "change-hint"],
      ["true", "sent-title", "sent-text"],
    ]);
    for (const id of ["change-dialog", "sent-dialog"]) {
      expect(account.getElementById(id)!.hidden, id).toBe(true);
      expect(account.getElementById("account-page")!.contains(account.getElementById(id)), id).toBe(false);
    }
    expect(ACCOUNT_JS).toContain('var BEHIND = ["dash-top", "account-page"];');
    // The field: an email field, its label, the hint and the message tied to it, nothing a browser would autofill with the old address.
    const field = account.getElementById("change-email")!;
    expect([field.getAttribute("type"), field.getAttribute("autocomplete"), field.getAttribute("maxlength"), field.getAttribute("aria-describedby")]).toEqual(["email", "off", "254", "change-hint change-message"]);
    // The stylesheet has the pages' own part.
    expect(DASH_CSS).toContain("/* The Account page. */");
    expect(DASH_CSS.replace(MANROPE_FACE, "")).not.toMatch(/url\(|@import|https?:|\/\/|expression\(/i);
    expect(DASH_CSS).not.toMatch(/overflow-x|100vw/);
  });
});

describe("the sign-in pages after the account page moved", () => {
  it("send a person who is signed in, or who just signed in, to the Tours page", () => {
    expect(SIGNIN_JS).toContain('if (res.status === 200) location.replace("/tours");');
    expect(SIGNIN_JS.match(/location\.replace\("\/tours"\)/g)).toHaveLength(2);
    expect(SIGNIN_JS).not.toContain("/account");
    expect(SIGNIN_JS).not.toContain('page === "account"');
  });
});
