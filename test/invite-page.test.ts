// The page an invite's link opens: GET /invite and its own script /invite/invite.js
// (src/signin/accept.ts), with the sign-in pages' stylesheet. What their answers are (headers,
// where they answer, that they cost no database or storage call and hold nothing about anyone),
// the exact wording of the approved mockups 5 and 6 and of the proposed sentences, and what the
// script's text may and may not do: the rules the sign-in pages are held to in
// test/pages.test.ts. What the script does when it runs is tested under Node in
// test/node-invite-page.test.ts.
import { describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { UNDOCUMENTED_ROUTES } from "../src/docs/openapi.ts";
import { HOST_RULES } from "../src/host-gate.ts";
import type { Hosts } from "../src/hosts.ts";
import { INVITE_MS, INVITE_SAYS } from "../src/invites.ts";
import { ACCOUNT_PAGE_HEADERS } from "../src/pages.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import { INVITE_HTML, INVITE_JS } from "../src/signin/accept.ts";
import { SIGNIN_CSS, SIGNIN_JS } from "../src/signin/page.ts";
import { RESERVED } from "../src/usernames.ts";
import { send, type Call } from "./bundle.ts";
import { isBrandMarkAlt, withoutSourceLine } from "./dash-checks.ts";
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

type Served = { path: string; body: string; type: string };
const SERVED: Served[] = [
  { path: "/invite", body: INVITE_HTML, type: "text/html; charset=utf-8" },
  { path: "/invite/invite.js", body: INVITE_JS, type: "text/javascript; charset=utf-8" },
];

const seen = (c: Call) => ({ status: c.status, headers: [...c.headers.entries()].sort(), body: c.text });

/** Every text of the page's body, in order, hidden parts included. Nothing else may be in it. */
const WORDING = [
  "Mythicshot",
  "This page needs JavaScript.",
  // Proposed: the heading while the invite is looked up, and its button after a failure.
  "Opening your invite",
  "Try again",
  // Mockup 5.
  "Choose your username",
  "You were invited as",
  ". Your username is how you appear here, and it cannot be changed later.",
  "Username",
  "3 to 30 characters: lowercase letters, digits and hyphens.",
  "Create my account",
  "You sign in with a link sent to your email address. There is no password.",
  // Mockup 6.
  "This invite no longer works",
  "An invite works once and for 7 days, and a newer invite replaces an older one. Ask the person who invited you to send it again.",
  // Asked in review: a reload lands here too, as the code left the address when the page first opened.
  "If you reloaded this page, open the link in your mail again.",
  "Already have an account?",
  "Sign in",
  // Proposed: a browser that is signed in already.
  "You are already signed in",
  // Asked in review: also a second tab right after the invite was used in the first.
  "This invite is for a new account. If you have just used it, you are all set. Otherwise sign out first, then open the link from your mail again.",
  "Go to the dashboard",
];

/** Every text the script puts on the page, by its key in the script's TEXT. */
const TEXT: Record<string, string> = {
  // Mockup 6 and the server's own sentences (INVITE_SAYS).
  badUsername: "Use 3 to 30 lowercase letters, digits and hyphens, starting with a letter.",
  reserved: "That username cannot be chosen. Try another.",
  taken: "That username is taken. Try another.",
  // The sign-in pages' failure sentence.
  failed: "Something went wrong. Try again in a moment.",
  // Proposed: too many tries, in the sign-in pages' style, with the wait from retry-after.
  waitBefore: "Too many tries. Wait ",
  waitMinutes: " minutes and try again.",
  waitOneMinute: "Too many tries. Wait 1 minute and try again.",
  // Proposed: the button's busy label.
  creating: "Creating…",
};

function scriptText(): Record<string, string> {
  const block = /\n {2}var TEXT = \{\n([\s\S]*?)\n {2}\};\n/.exec(INVITE_JS);
  expect(block, "the script keeps its words in one TEXT object").not.toBeNull();
  const out: Record<string, string> = {};
  for (const line of block![1].split("\n")) {
    const m = /^ {4}([a-zA-Z]+): ("(?:[^"\\]|\\.)*"),$/.exec(line);
    expect(m, `a line of TEXT: ${line}`).not.toBeNull();
    out[m![1]] = JSON.parse(m![2]);
  }
  return out;
}

function scriptStrings(): string[] {
  const js = INVITE_JS.split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  return [...js.matchAll(/"(?:[^"\\\n]|\\.)*"/g)].map((m) => JSON.parse(m[0]) as string);
}

describe("the invite page", () => {
  it("answers with the sign-in pages' headers and makes no database or storage call", async () => {
    const one = await makeDeps();
    const two = await makeDeps({ hosts: HOSTS });
    for (const s of SERVED) {
      for (const [deps, origin] of [[one.deps, "https://any.example.org"], [one.deps, "http://localhost:3000"], [two.deps, APP]] as const) {
        const r = await send(deps, "GET", s.path, { origin });
        expect([r.status, r.text, r.calls], s.path).toEqual([200, s.body, 0]);
        expect(Object.fromEntries(r.headers.entries()), s.path).toEqual({ ...ACCOUNT_PAGE_HEADERS, "content-type": s.type });
      }
      const head = await send(two.deps, "HEAD", s.path, { origin: APP });
      expect([head.status, head.bytes.length, head.headers.get("content-security-policy"), head.calls], s.path).toEqual([200, 0, POLICY, 0]);
    }
    expect(ACCOUNT_PAGE_HEADERS["cache-control"]).toBe("no-store");
    expect(ACCOUNT_PAGE_HEADERS["referrer-policy"]).toBe("no-referrer");
    expect(ACCOUNT_PAGE_HEADERS["content-security-policy"]).toBe(POLICY);
  });

  it("holds nothing about anyone: the same answer for nobody, a session and a token", async () => {
    const { deps } = await makeDeps({ hosts: HOSTS });
    const admin = await seedAccount(deps, { admin: true, username: "invitecheck-owner" });
    const made = await redeemSignInCode(deps, await createSignInCode(deps, admin.userId), BROWSER, null);
    const cookie = `${SESSION_COOKIE}=${made!.secret}`;
    const secrets = [admin.email, "invitecheck-owner", admin.userId, admin.workspaceId, admin.token, made!.secret, made!.sessionId, await csrfFor(made!.secret)];
    for (const s of SERVED) {
      const nobody = await send(deps, "GET", s.path, { origin: APP });
      for (const r of [nobody, await send(deps, "GET", s.path, { origin: APP, headers: { cookie, "user-agent": BROWSER } }), await send(deps, "GET", s.path, { origin: APP, token: admin.token })]) {
        expect(seen(r), s.path).toEqual(seen(nobody));
        expect([r.calls, r.headers.get("set-cookie")], s.path).toEqual([0, null]);
        for (const secret of secrets) expect(r.text, `${s.path} holds ${secret}`).not.toContain(secret);
      }
    }
  });

  it("answers on the app address only: the tours and img addresses refuse the page and its script", async () => {
    const two = await makeDeps({ hosts: HOSTS });
    const three = await makeDeps({ hosts: THREE });
    for (const s of SERVED) {
      const key = `GET ${s.path}`;
      expect(HOST_RULES[key], key).toBe("app");
      const onTours = await send(two.deps, "GET", s.path, { origin: TOURS });
      expect([onTours.status, onTours.text, onTours.calls, onTours.headers.get("location")], `tours ${s.path}`).toEqual([404, NOT_FOUND, 0, null]);
      const onImg = await send(three.deps, "GET", s.path, { origin: IMG });
      expect([onImg.status, onImg.text, onImg.calls], `img ${s.path}`).toEqual([404, NOT_FOUND, 0]);
      const unknown = await send(two.deps, "GET", s.path, { origin: UNKNOWN });
      expect([unknown.status, unknown.bytes.length, unknown.calls], `unknown ${s.path}`).toEqual([421, 0, 0]);
      expect((await send(three.deps, "GET", s.path, { origin: APP })).status, `app ${s.path}`).toBe(200);
      // A page, not API: left out of the description, with its reason.
      expect(UNDOCUMENTED_ROUTES[key]?.length ?? 0, key).toBeGreaterThan(10);
    }
    // The page's top-level path cannot be anyone's username.
    expect(RESERVED.has("invite")).toBe(true);
  });

  it("the wording is the approved mockups' own, with the proposed sentences pinned", () => {
    const doc = new FakeDocument(INVITE_HTML);
    expect(textNodes(doc.body)).toEqual(WORDING);
    expect(textNodes(doc.head)).toEqual(["Your invite"]);
    // The only words in attributes a person can meet: none.
    for (const e of doc.body.all()) for (const name of ["aria-label", "title", "alt", "placeholder"]) expect(e.hasAttribute(name) && !isBrandMarkAlt(e, name), `<${e.tagName} ${name}>`).toBe(false);
    expect(scriptText()).toEqual(TEXT);
    const words = new Set(Object.values(TEXT));
    for (const t of scriptStrings().filter((s) => /[a-z]/i.test(s) && /\s/.test(s) && s !== "use strict")) expect(words.has(t), `a text outside TEXT: ${JSON.stringify(t)}`).toBe(true);
    // The sentences the server also says are the server's own, and the dead page's days are the invite's.
    expect([TEXT.badUsername, TEXT.reserved, TEXT.taken]).toEqual([INVITE_SAYS.badUsername, INVITE_SAYS.reservedUsername, INVITE_SAYS.usernameTaken]);
    expect(INVITE_HTML).toContain(`An invite works once and for ${INVITE_MS / 86_400_000} days`);
    // The page tells a reserved name by the server's error code, never by comparing its words.
    expect(INVITE_JS).toContain('if (res.status === 400 && error === "reserved_username") { refuse(TEXT.reserved); return; }');
    expect(INVITE_JS).not.toContain("detail");
    // The failure sentence is the sign-in pages' own.
    expect(SIGNIN_JS).toContain(`failed: ${JSON.stringify(TEXT.failed)},`);
    // The wait, put together.
    expect(TEXT.waitBefore + "15" + TEXT.waitMinutes).toBe("Too many tries. Wait 15 minutes and try again.");
  });

  it("the invited address is set as text in a bold element of its own, inside the one sentence", () => {
    const doc = new FakeDocument(INVITE_HTML);
    const to = doc.getElementById("invite-email")!;
    expect([to.tagName, to.className, to.children.length]).toEqual(["strong", "address invited", 0]);
    expect(to.parent!.textContent).toBe("You were invited as . Your username is how you appear here, and it cannot be changed later.");
    expect(INVITE_JS).toContain('$("invite-email").textContent = email;');
    expect(SIGNIN_CSS).toContain(".address.invited { font-weight: 700; }");
  });

  it("the username field: its name, no autofill of another kind, no capitals or spelling help, and a hint", () => {
    const doc = new FakeDocument(INVITE_HTML);
    const input = doc.getElementById("username")!;
    expect(["type", "autocomplete", "autocapitalize", "spellcheck", "aria-describedby"].map((n) => input.getAttribute(n))).toEqual(["text", "username", "none", "false", "username-hint choose-message"]);
    expect(doc.body.all().find((e) => e.tagName === "label" && e.getAttribute("for") === "username")?.textContent).toBe("Username");
    // The script never lowers what is typed: a capital is refused, not changed.
    expect(INVITE_JS).not.toMatch(/toLowerCase|toUpperCase/);
  });

  it("the script takes the code from the address and removes it from the address bar before anything else", () => {
    const start = INVITE_JS.indexOf('"use strict";');
    const statements = INVITE_JS.slice(start)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("//"));
    expect(statements.slice(0, 3)).toEqual(['"use strict";', "var fragment = location.hash;", 'if (fragment !== "") history.replaceState(null, "", location.pathname + location.search);']);
    expect(INVITE_JS.match(/location\.hash/g)).toHaveLength(1);
    expect(INVITE_JS.match(/replaceState/g)).toHaveLength(1);
    // The code only in the shape an invite's link carries, and the fragment forgotten at once.
    expect(INVITE_JS).toContain("var match = /^#(dpi_[0-9a-f]{40})$/.exec(fragment);");
    expect(INVITE_JS).toContain('var code = match === null ? "" : match[1];\n  fragment = "";\n  match = null;');
    // Every use of the code: these lines and no other.
    for (const m of INVITE_JS.matchAll(/\bcode\b/g)) {
      const line = INVITE_JS.slice(INVITE_JS.lastIndexOf("\n", m.index) + 1, INVITE_JS.indexOf("\n", m.index)).trim();
      expect(
        [
          'var code = match === null ? "" : match[1];',
          'code = "";',
          'if (code === "" || checking) return;',
          'if (code === "" || accepting || btn.disabled) return;',
          'if (code === "") {',
          "post(CHECK, { code: code }).then(function (res) {",
          "post(ACCEPT, { code: code, username: name }).then(function (res) {",
        ].includes(line) || line.startsWith("//"),
        `a use of the code: ${line}`,
      ).toBe(true);
    }
  });

  it("the accept is sent only from the press, and every request is a POST of a JSON body to a fixed path", () => {
    expect(INVITE_JS.match(/\bpost\(/g), "the one helper and its two calls").toHaveLength(3);
    const requests = [...INVITE_JS.matchAll(/\bpost\(([A-Z]+), /g)].map((m) => m[1]);
    expect(requests).toEqual(["CHECK", "ACCEPT"]);
    expect(INVITE_JS).toContain('var CHECK = "/api/v1/invite/check";');
    expect(INVITE_JS).toContain('var ACCEPT = "/api/v1/invite/accept";');
    expect(INVITE_JS.match(/\bfetch\(/g), "one place makes every request").toHaveLength(1);
    expect(INVITE_JS).toContain('method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer"');
    // The accept's request is inside press(), which only the button's click and Enter in the field call.
    const pressAt = INVITE_JS.indexOf("function press() {");
    const pressEnd = INVITE_JS.indexOf("\n  }\n", pressAt);
    const acceptAt = INVITE_JS.indexOf("post(ACCEPT");
    expect(acceptAt > pressAt && acceptAt < pressEnd).toBe(true);
    expect(INVITE_JS.match(/\bpress\(\)/g)).toHaveLength(2);
    expect(INVITE_JS).toContain('$("choose-button").addEventListener("click", press);');
    expect(INVITE_JS).toContain('if (ev.repeat === true) return;\n    press();');
  });

  it("the script never writes the code to a store, a cookie, a log or an address", () => {
    const forbidden = [
      "localStorage", "sessionStorage", "indexedDB", "cookie", "cookieStore", "caches", "postMessage", "window.name", "pushState",
      "location.href", "location.hash =", "location.search =", "sendBeacon", "XMLHttpRequest", "WebSocket", "EventSource", "import(",
      "eval(", "Function(", "console.", "open(", "setTimeout(", "setInterval(", "document.referrer", "?code", "?c=", "csrf",
      "innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "createContextualFragment", "DOMParser", "srcdoc", "document.title",
    ];
    for (const api of forbidden) expect(INVITE_JS, api).not.toContain(api);
    const navigations = [...INVITE_JS.matchAll(/location\.(replace|assign)\(([^)]*)\)/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(navigations.sort()).toEqual(['assign "/"', 'replace "/connections"']);
    expect(INVITE_JS).not.toMatch(/\blocation\s*=(?!=)/);
    expect(INVITE_JS).not.toMatch(/\b(?:window|document|self|top|parent|globalThis)\s*\.\s*location\b/);
    const uses = [...INVITE_JS.matchAll(/\blocation\b\s*(\.\s*[a-zA-Z]+)?/g)].map((m) => (m[1] ?? "").replace(/\s/g, ""));
    expect(new Set(uses)).toEqual(new Set([".hash", ".pathname", ".search", ".replace", ".assign"]));
    expect(INVITE_JS).not.toMatch(/\.style\b|setAttribute\("(?:style|on[a-z]+|src|href)"|\.on[a-z]+\s*=/);
    expect(INVITE_JS).not.toMatch(/https?:|\/\/[a-z]/i);
  });

  it("loads nothing from another origin, carries no inline script or style, and is usable with the keyboard and a screen reader", () => {
    const doc = new FakeDocument(withoutSourceLine(INVITE_HTML));
    const all = doc.root.all();
    expect(all.filter((e) => e.tagName === "script").map((e) => [e.getAttribute("src"), e.getAttribute("defer"), e.textContent])).toEqual([["/invite/invite.js", "", ""]]);
    expect(all.filter((e) => e.tagName === "link").map((e) => [e.getAttribute("rel"), e.getAttribute("href")])).toEqual([["icon", "/favicon.ico"], ["icon", "/favicon.svg"], ["stylesheet", "/signin/signin.css"]]);
    expect(all.filter((e) => e.tagName === "style" || e.tagName === "form")).toEqual([]);
    for (const e of all) {
      for (const [name, value] of e.attrs) {
        expect(name === "style" || name.startsWith("on"), `<${e.tagName} ${name}>`).toBe(false);
        if (["src", "href", "action", "formaction", "srcset", "poster", "data"].includes(name)) expect(value, name).toMatch(/^\/(?!\/)/);
      }
    }
    expect(withoutSourceLine(INVITE_HTML)).not.toMatch(/https?:|\/\//i);
    expect(all.some((e) => e.tagName === "meta" && e.getAttribute("name") === "referrer" && e.getAttribute("content") === "no-referrer")).toBe(true);
    expect(all.find((e) => e.tagName === "html")?.getAttribute("lang")).toBe("en");
    expect(all.some((e) => e.tagName === "meta" && e.getAttribute("name") === "viewport" && e.getAttribute("content") === "width=device-width, initial-scale=1")).toBe(true);
    for (const b of all.filter((e) => e.tagName === "button")) expect(b.getAttribute("type"), `#${b.id}`).toBe("button");
    for (const a of all.filter((e) => e.tagName === "a")) expect(a.getAttribute("href")).toBe("/signin");
    for (const e of all) expect(["div", "span", "p", "li"].includes(e.tagName) && (e.hasAttribute("tabindex") || e.getAttribute("role") === "button"), `<${e.tagName}> as a control`).toBe(false);
    const messages = all.filter((e) => e.className.split(" ").includes("message") && e.parent?.tagName !== "noscript");
    expect(messages.map((m) => m.id)).toEqual(["opening-message", "choose-message"]);
    for (const m of messages) expect([m.getAttribute("role"), m.getAttribute("aria-live")], m.id).toEqual(["status", "polite"]);
    for (const h of all.filter((e) => e.tagName === "h1")) expect(h.getAttribute("tabindex"), h.id).toBe("-1");
    // Every state starts hidden: the script shows one.
    expect(all.filter((e) => e.tagName === "section").map((e) => [e.id, e.hidden])).toEqual([["opening", true], ["choose", true], ["dead", true], ["here", true]]);
    const ids = new Set(all.map((e) => e.id));
    for (const m of INVITE_JS.matchAll(/\$\("([a-z-]+)"\)/g)) expect(ids.has(m[1]), `#${m[1]}`).toBe(true);
    for (const s of JSON.parse(/var STATES = (\[.*\]);/.exec(INVITE_JS)![1]) as string[]) expect(ids.has(s) && ids.has(`h-${s}`), s).toBe(true);
    // The sign-in stylesheet styles the text field and the hint as it does the email field.
    expect(SIGNIN_CSS).toContain('input[type="email"], input[type="text"] {');
    expect(SIGNIN_CSS).toContain("\n:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }");
    expect(SIGNIN_CSS).toMatch(/\n\.hint \{[^}]*color: var\(--text-muted\)/);
  });
});
