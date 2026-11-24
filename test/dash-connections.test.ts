// The dashboard's Connections page: GET /connections and its own script /dash/connections.js
// (src/dash/connections.ts). What their answers are (headers, where they answer, that they
// cost no database or storage call and hold nothing about anyone), the exact wording of the
// approved mockups 1 to 5 and of the sentences proposed beside them, and what the script's
// text may and may not do. What the script does when it runs is tested under Node in
// test/node-dash-connections.test.ts.
import { describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { USER_CODE_ALPHABET } from "../src/connect.ts";
import { CONNECTIONS_HTML, CONNECTIONS_JS } from "../src/dash/connections.ts";
import { DASH_PAGES } from "../src/dash/routes.ts";
import { DASH_JS } from "../src/dash/script.ts";
import { SIGNIN_JS } from "../src/signin/page.ts";
import { DASH_TABS } from "../src/dash/shell.ts";
import { DASH_CSS } from "../src/dash/style.ts";
import { UNDOCUMENTED_ROUTES } from "../src/docs/openapi.ts";
import { HOST_RULES } from "../src/host-gate.ts";
import type { Hosts } from "../src/hosts.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import { send, type Call } from "./bundle.ts";
import { expectNoForbiddenApis, expectPageShape, isBrandMarkAlt } from "./dash-checks.ts";
import { FakeDocument, textNodes } from "./pages-dom.ts";

const HOSTS: Hosts = { tours: "tours.example.com", app: "app.example.com" };
const THREE: Hosts = { ...HOSTS, img: "img.example.com" };
const TOURS = "https://tours.example.com";
const APP = "https://app.example.com";
const IMG = "https://img.example.com";
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
const SERVED: Served[] = [
  { path: "/connections", body: CONNECTIONS_HTML, type: "text/html; charset=utf-8" },
  { path: "/dash/connections.js", body: CONNECTIONS_JS, type: "text/javascript; charset=utf-8" },
];

const SHELL = ["Mythicshot", "Images", "GIFs", "Tours", "Storage", "Connections", "Account", "Admin", "This page needs JavaScript."];

/** Every text of the page's body, in order, hidden parts included. */
const WORDING = [
  ...SHELL,
  "Connections",
  "Connect Mythicshot",
  "In Mythicshot, open Workspace and press Sign in. Type the code it shows here.",
  // Proposed: the code field's name for a screen reader (the eye sees the placeholder).
  "Code",
  "Continue",
  "Computer",
  "Connected",
  "Last used",
  // Proposed: the buttons' column, for a screen reader.
  "Actions",
  "No computers connected yet",
  "Install Mythicshot, open Workspace and press Sign in. Then type the code it shows into the box above.",
  "A connection lets Mythicshot on that computer publish, change and delete everything in this workspace. Disconnect one you no longer use or do not recognise.",
  "Computer",
  "Asked",
  "Workspace",
  // Proposed in the security review: shown only when the request came from another network.
  "This request may have come from a different network than the one you are on now. If you are not sure it is yours, press Not me.",
  "Confirm only if you pressed Sign in in Mythicshot on this computer just now. It will be able to publish, change and delete everything in this workspace.",
  "Not me",
  "Connect",
  // Approved by the owner: under the question's buttons, ends this browser's session and goes to sign in.
  "Use a different account",
  "Rename this connection",
  "Name",
  "Only you see this name. Up to 60 characters.",
  "Cancel",
  "Save",
  "Mythicshot on that computer stops being able to publish to this workspace at once. Nothing already online is removed. To connect it again, press Sign in in Mythicshot there.",
  "Keep it",
  "Disconnect",
];

/** Every text the page's script puts on the page. */
const TEXT: Record<string, string> = {
  subBefore: "The computers where Mythicshot can publish to ",
  subAfter: ".",
  signedIn: "Signed in from Mythicshot",
  fromSetup: "From setup",
  today: "Today",
  never: "Never",
  dot: " · ",
  connectedOn: "connected ",
  lastUsed: "last used ",
  todayInLine: "today",
  neverInLine: "never",
  rename: "Rename",
  disconnect: "Disconnect",
  justNow: "just now",
  oneMinuteAgo: "1 minute ago",
  minutesAgo: " minutes ago",
  isConnected: " is connected. Mythicshot finishes signing in by itself within a few seconds.",
  badCode: "That code does not work. Codes last 10 minutes and work once. Press Sign in in Mythicshot again for a new one.",
  tooMany: "Too many codes that did not work. Try again in ",
  oneMinute: "1 minute.",
  minutes: " minutes.",
  // Proposed: the busy labels and the two sentences of a rename, and the reload sentence the other pages use.
  connecting: "Connecting…",
  saving: "Saving…",
  disconnecting: "Disconnecting…",
  askBefore: 'Disconnect "',
  askAfter: '"?',
  badName: "A name is 1 to 60 characters, with no hidden characters.",
  alreadyGone: "That connection was already disconnected.",
  // Proposed in review: when no answer came to Connect or Not me and the code is no longer open.
  lostAnswer: "The answer was lost on the way. If the computer was connected, it shows in the list below within a few seconds; if not, press Sign in in Mythicshot again.",
  // Proposed in review: the same for Not me.
  lostRefuse: "The answer was lost on the way. The code no longer works, so nothing can be connected with it.",
  notReloaded: "The change was made, but the list could not be loaded again. Reload the page to see it.",
  // Invite mockup 7: the welcome of a new account, around its username.
  welcomeBefore: "Welcome, ",
  welcomeAfter: ". Your workspace is ready. Connect Mythicshot on your computer to start sharing: open Workspace in Mythicshot, press Sign in, and type the code it shows below.",
  // Plan 2i: the welcome's last sentence when the session names a usable download page, "the download page" being the link.
  downloadBefore: " Not installed yet? Get Mythicshot from ",
  downloadLink: "the download page",
  downloadAfter: ".",
  // Proposed (Plan 2j): the muted line under a connection from Mythicshot about when it stops working.
  expires: "Expires ",
  unlessUsed: " unless it is used",
  expired: "Expired ",
  signInAgain: ". Sign in again from Mythicshot.",
  // Approved by the owner: the question names the account, "Connect <computer> to the workspace <workspace>? You are signed in as <email>."
  askConnect: "Connect ",
  toWorkspace: " to the workspace ",
  askEnd: "?",
  signedInAs: "You are signed in as ",
  signedInAsEnd: ".",
};

const CLASS_NAMES = ["note plain", "btn sm quiet", "btn sm danger", "t name", "confirm-who confirm-facts confirm-elsewhere confirm-warn", "confirm-who confirm-facts confirm-warn"];

const seen = (c: Call) => ({ status: c.status, headers: [...c.headers.entries()].sort(), body: c.text });

async function signedIn(deps: Parameters<typeof seedAccount>[0], opts: { admin?: boolean; username?: string } = {}) {
  const account = await seedAccount(deps, opts);
  const made = await redeemSignInCode(deps, await createSignInCode(deps, account.userId), BROWSER, null);
  expect(made).not.toBeNull();
  return { ...account, cookie: `${SESSION_COOKIE}=${made!.secret}`, secret: made!.secret, sessionId: made!.sessionId, csrf: await csrfFor(made!.secret) };
}

function scriptText(js: string): Record<string, string> {
  const block = /\n {2}var TEXT = \{\n([\s\S]*?)\n {2}\};\n/.exec(js);
  expect(block).not.toBeNull();
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

describe("the Connections page", () => {
  it("answers with the sign-in pages' headers and makes no database or storage call", async () => {
    const one = await makeDeps();
    const two = await makeDeps({ hosts: HOSTS });
    for (const s of SERVED) {
      for (const [deps, origin] of [[one.deps, "https://any.example.org"], [one.deps, "http://localhost:3000"], [two.deps, APP]] as const) {
        const r = await send(deps, "GET", s.path, { origin });
        expect([r.status, r.text, r.calls], s.path).toEqual([200, s.body, 0]);
        expect(Object.fromEntries(r.headers.entries()), s.path).toEqual({ ...SECURITY, "content-type": s.type });
      }
    }
    expect(DASH_PAGES.filter((p) => p.path === "/connections").map((p) => [p.html, p.script.path, p.script.body])).toEqual([[CONNECTIONS_HTML, "/dash/connections.js", CONNECTIONS_JS]]);
    // The tab sits between Storage and Account.
    expect(DASH_TABS.map((t) => t.key)).toEqual(["images", "gifs", "tours", "storage", "connections", "account", "admin"]);
  });

  it("holds nothing about anyone: the same answer for nobody, a member, an admin and a token", async () => {
    const { deps } = await makeDeps({ hosts: HOSTS });
    const admin = await signedIn(deps, { admin: true, username: "conncheck-owner" });
    const member = await signedIn(deps, { username: "conncheck-member" });
    const secrets = [admin.email, member.email, "conncheck-owner", "conncheck-member", admin.userId, member.userId, admin.workspaceId, member.workspaceId, admin.token, member.token, admin.secret, member.secret, admin.sessionId, admin.csrf, member.csrf];
    for (const s of SERVED) {
      const nobody = await send(deps, "GET", s.path, { origin: APP });
      for (const r of [
        nobody,
        await send(deps, "GET", s.path, { origin: APP, headers: { cookie: admin.cookie, "user-agent": BROWSER } }),
        await send(deps, "GET", s.path, { origin: APP, headers: { cookie: member.cookie, "user-agent": BROWSER } }),
        await send(deps, "GET", s.path, { origin: APP, token: admin.token }),
      ]) {
        expect(seen(r), s.path).toEqual(seen(nobody));
        expect(r.calls, s.path).toBe(0);
        for (const secret of secrets) expect(r.text, `${s.path} holds ${secret}`).not.toContain(secret);
      }
    }
    expectPageShape(CONNECTIONS_HTML, "/connections");
  });

  it("answers on the app address only: the tours and img addresses refuse the page and its script", async () => {
    const two = await makeDeps({ hosts: HOSTS });
    await seedAccount(two.deps, { admin: true, username: "conncheck-admin" });
    const viewer = await signedIn(two.deps, { username: "conncheck-viewer" });
    const three = await makeDeps({ hosts: THREE });
    for (const s of SERVED) {
      expect(HOST_RULES[`GET ${s.path}`], s.path).toBe("app");
      for (const headers of [{}, { cookie: viewer.cookie }] as Record<string, string>[]) {
        const onTours = await send(two.deps, "GET", s.path, { origin: TOURS, headers });
        expect([onTours.status, onTours.text, onTours.calls], `tours ${s.path}`).toEqual([404, NOT_FOUND, 0]);
        const onImg = await send(three.deps, "GET", s.path, { origin: IMG, headers });
        expect([onImg.status, onImg.text, onImg.calls], `img ${s.path}`).toEqual([404, NOT_FOUND, 0]);
      }
      expect((await send(two.deps, "GET", s.path, { origin: UNKNOWN })).status, s.path).toBe(421);
      expect(UNDOCUMENTED_ROUTES[`GET ${s.path}`]?.length ?? 0, s.path).toBeGreaterThan(10);
    }
  });

  it("the wording is the approved mockups' own, with the proposed sentences pinned", () => {
    const doc = new FakeDocument(CONNECTIONS_HTML);
    expect(textNodes(doc.body)).toEqual(WORDING);
    expect(textNodes(doc.head)).toEqual(["Connections"]);
    const current = doc.body.all().filter((e) => e.tagName === "a" && e.getAttribute("aria-current") === "page");
    expect(current.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([["Connections", "/connections"]]);
    // The only attribute words: the code field's placeholder, as in the mockup.
    const words = doc.body.all().flatMap((e) => ["aria-label", "title", "alt", "placeholder"].filter((n) => e.hasAttribute(n) && !isBrandMarkAlt(e, n)).map((n) => [e.id, n, e.getAttribute(n)]));
    expect(words).toEqual([["connect-code", "placeholder", "XXXX-XXXX"]]);
    expect(scriptText(CONNECTIONS_JS)).toEqual(TEXT);
    const all = new Set(Object.values(TEXT));
    for (const t of scriptStrings(CONNECTIONS_JS).filter((s) => /[a-z]/i.test(s) && /\s/.test(s) && s !== "use strict")) expect(all.has(t) || CLASS_NAMES.includes(t), `a text outside TEXT: ${JSON.stringify(t)}`).toBe(true);
    expectNoForbiddenApis(CONNECTIONS_JS, "/dash/connections.js");
    // The mockups' lines, put together from the words.
    expect(TEXT.subBefore + "Cowfee Raid Tools" + TEXT.subAfter).toBe("The computers where Mythicshot can publish to Cowfee Raid Tools.");
    expect("ALEX-DESKTOP" + TEXT.isConnected).toBe("ALEX-DESKTOP is connected. Mythicshot finishes signing in by itself within a few seconds.");
    expect(TEXT.tooMany + "10" + TEXT.minutes).toBe("Too many codes that did not work. Try again in 10 minutes.");
    expect(TEXT.askBefore + "Work laptop" + TEXT.askAfter).toBe('Disconnect "Work laptop"?');
    expect(TEXT.signedIn + TEXT.dot + TEXT.connectedOn + "20 Nov 2026" + TEXT.dot + TEXT.lastUsed + TEXT.todayInLine).toBe("Signed in from Mythicshot · connected 20 Nov 2026 · last used today");
    expect("2" + TEXT.minutesAgo).toBe("2 minutes ago");
    expect(TEXT.welcomeBefore + "mara" + TEXT.welcomeAfter).toBe(
      "Welcome, mara. Your workspace is ready. Connect Mythicshot on your computer to start sharing: open Workspace in Mythicshot, press Sign in, and type the code it shows below.",
    );
    expect(TEXT.expires + "20 Feb 2027" + TEXT.unlessUsed).toBe("Expires 20 Feb 2027 unless it is used");
    expect(TEXT.expires + "20 Feb 2027").toBe("Expires 20 Feb 2027");
    expect(TEXT.expired + "20 Feb 2027" + TEXT.signInAgain).toBe("Expired 20 Feb 2027. Sign in again from Mythicshot.");
    expect(TEXT.downloadBefore + TEXT.downloadLink + TEXT.downloadAfter).toBe(" Not installed yet? Get Mythicshot from the download page.");
    expect(TEXT.askConnect + "ALEX-DESKTOP" + TEXT.toWorkspace + "Cowfee Raid Tools" + TEXT.askEnd + " " + TEXT.signedInAs + "solex@example.com" + TEXT.signedInAsEnd).toBe("Connect ALEX-DESKTOP to the workspace Cowfee Raid Tools? You are signed in as solex@example.com.");
    // The question's heading and the line under it are filled by the script: empty in the page.
    for (const id of ["confirm-title", "confirm-who"]) expect([doc.getElementById(id)!.textContent, doc.getElementById(id)!.children.length], id).toEqual(["", 0]);
    expect(CONNECTIONS_JS).toContain('var link = Dash.downloadLink(TEXT.downloadLink, "");');
    // The welcome's place: the green note above the heading, empty and hidden until the script fills it.
    const welcome = doc.getElementById("connections-welcome")!;
    expect([welcome.tagName, welcome.className, welcome.hidden, welcome.children.length]).toEqual(["p", "note", true, 0]);
    expect(welcome.parent!.children.filter((c) => c instanceof Object && "tagName" in c).map((c) => (c as { id: string }).id).slice(0, 2)).toEqual(["connections-welcome", "h-page"]);
  });

  it("the code field: an accessible name, no autofill, capitals, no spelling, and the code never in an address", () => {
    const doc = new FakeDocument(CONNECTIONS_HTML);
    const input = doc.getElementById("connect-code")!;
    expect(["type", "autocomplete", "autocapitalize", "spellcheck"].map((n) => input.getAttribute(n))).toEqual(["text", "off", "characters", "false"]);
    const label = doc.body.all().find((e) => e.tagName === "label" && e.getAttribute("for") === "connect-code")!;
    expect([label.textContent, label.className]).toEqual(["Code", "vh"]);
    // The lookup is one function, a POST with the code in the body; no request path holds a code.
    expect(CONNECTIONS_JS).toContain('var LOOKUP = "/api/v1/connect/lookup";');
    expect(CONNECTIONS_JS).toContain('return Dash.api("POST", LOOKUP, { user_code: code });');
    expect(CONNECTIONS_JS).toContain('Dash.api("POST", how === "confirm" ? CONFIRM : REFUSE, { user_code: p.code })');
    expect(CONNECTIONS_JS).not.toContain("/api/v1/connect/requests");
    expect(CONNECTIONS_JS).toContain(`var CODE = /^[${USER_CODE_ALPHABET}]{8}$/;`);
    // Every request, by method and path.
    const calls = [...CONNECTIONS_JS.matchAll(/Dash\.api\("([A-Z]+)", ([^,)]+)/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(calls).toEqual(["POST LOOKUP", 'POST how === "confirm" ? CONFIRM : REFUSE', "POST SIGNOUT", "GET TOKENS", 'PATCH TOKENS + "/" + encodeURIComponent(id', 'DELETE TOKENS + "/" + encodeURIComponent(id', "GET USAGE"]);
    expect(CONNECTIONS_JS).toContain('var USAGE = "/api/v1/usage";');
    expect(CONNECTIONS_JS).toContain("var TOKEN_ID = /^tok_[0-9a-f]{24}$/;");
    // Nothing is stored, logged or read from the address, and no request leaves through anything but Dash.api.
    const forbidden = ["location", "history", "localStorage", "sessionStorage", "indexedDB", "cookie", "caches", "postMessage", "window.name", "sendBeacon", "XMLHttpRequest", "WebSocket", "EventSource", "fetch(", "csrf", "import(", "eval(", "Function(", "console.", "window.open", "setInterval(", "document.referrer", "innerHTML", "navigator."];
    for (const api of forbidden) expect(CONNECTIONS_JS, api).not.toContain(api);
    expect(CONNECTIONS_JS).not.toMatch(/\.style\b|setAttribute\("(?:style|on[a-z]+|src|href)"|\.on[a-z]+\s*=/);
  });

  it("Use a different account: the page's own Sign out, to the fixed sign-in page; no request can name where the browser goes, then or after signing in", async () => {
    // The one request: this session's sign-out (never everywhere), with no body.
    expect(CONNECTIONS_JS).toContain('var SIGNOUT = "/api/v1/signout";');
    expect(CONNECTIONS_JS.match(/SIGNOUT/g)).toHaveLength(2);
    expect(CONNECTIONS_JS).not.toContain("/signout/everywhere");
    // Leaving is the shared Dash.signedOut, which goes to "/signin" and nowhere else.
    expect(DASH_JS).toContain('function signedOut() {\n    location.replace("/signin");\n  }');
    // The sign-in pages take no return address: they read no query and land on the fixed Tours page.
    expect(SIGNIN_JS).not.toMatch(/[?&]next|return_?to|URLSearchParams|searchParams/i);
    // Its one use of the query: keeping it in the address bar while the link's code is taken out.
    expect(SIGNIN_JS.match(/location\.search/g)).toHaveLength(1);
    expect(SIGNIN_JS).toContain('history.replaceState(null, "", location.pathname + location.search);');
    expect([...SIGNIN_JS.matchAll(/location\.(?:replace|assign)\(([^)]*)\)/g)].map((m) => m[1])).toEqual(['"/tours"', '"/signin"', '"/tours"']);
    // A sign-in page asked with a return address answers byte for byte as without one.
    const { deps } = await makeDeps({ hosts: HOSTS });
    const plain = await send(deps, "GET", "/signin", { origin: APP });
    for (const q of ["?next=https://evil.example.net/", "?next=/connections", "?return_to=//evil.example.net", "?redirect=%2F%2Fevil.example.net"]) {
      const asked = await send(deps, "GET", "/signin" + q, { origin: APP });
      expect(seen(asked), q).toEqual(seen(plain));
      expect(asked.text, q).not.toContain("evil");
    }
  });

  it("is usable with the keyboard and a screen reader, keeps long names inside, and lays out at phone width", () => {
    const doc = new FakeDocument(CONNECTIONS_HTML);
    const all = doc.root.all();
    for (const b of all.filter((e) => e.tagName === "button")) expect(b.getAttribute("type"), `#${b.id}`).toBe("button");
    const messages = all.filter((e) => /\b(?:message|load)\b/.test(e.className) && e.parent?.tagName !== "noscript");
    expect(messages.map((m) => m.id).sort()).toEqual(["confirm-message", "connect-message", "connections-message", "dash-load", "disconnect-message", "rename-message"]);
    for (const m of messages) expect([m.getAttribute("role"), m.getAttribute("aria-live")], m.id).toEqual(["status", "polite"]);
    expect(CONNECTIONS_JS).toContain('var BEHIND = ["dash-top", "connections-page"];');
    for (const d of ["confirm-dialog", "rename-dialog", "disconnect-dialog"]) expect(doc.getElementById("connections-page")!.contains(doc.getElementById(d))).toBe(false);
    for (const h of all.filter((e) => e.tagName === "h1" || e.tagName === "h2")) expect(h.getAttribute("tabindex"), h.id).toBe("-1");
    const ids = new Set(all.map((e) => e.id));
    for (const m of CONNECTIONS_JS.matchAll(/\$\("([a-z-]+)"\)/g)) expect(ids.has(m[1]), `#${m[1]}`).toBe(true);
    expect(doc.getElementById("confirm-elsewhere")!.hidden).toBe(true);
    // A device's name: isolated, wrapping, and cut at the server's 60 characters in the question; the questions scroll inside the screen.
    expect(DASH_CSS).toContain(".name { unicode-bidi: isolate; overflow-wrap: anywhere; }");
    expect(DASH_CSS).toContain("#confirm-box, #rename-box, #disconnect-box { max-height: 100%; overflow-y: auto; }");
    expect(CONNECTIONS_JS).toContain('$("confirm-device").textContent = Array.from(p.device).slice(0, NAME_MAX).join("");');
    const phone = [...DASH_CSS.matchAll(/@media \(max-width: 720px\) \{\n([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
    expect(phone).toContain(".connections thead, .connections td.when { display: none; }");
    expect(DASH_CSS).not.toMatch(/overflow-x|100vw/);
  });
});
