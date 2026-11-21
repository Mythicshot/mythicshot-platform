// The pages around a restricted tour (src/view-page.ts, served by src/restricted.ts): the gate
// and the "not shared with you" page at /t/<slug>, the page a viewer link opens (/view), the
// page "Not you?" leads to (/view/signout/<slug>), their script and stylesheets. Their answers
// (headers, where they answer, no database or storage call, nothing about anyone), the exact
// wording of the approved mockups 4 to 7 and of the proposed sentences, and what the script's
// text may and may not do: the rules the sign-in and invite pages are held to. What the script
// does when it runs is tested under Node in test/node-view-pages.test.ts.
import { describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { UNDOCUMENTED_ROUTES } from "../src/docs/openapi.ts";
import { HOST_RULES } from "../src/host-gate.ts";
import type { Hosts } from "../src/hosts.ts";
import { ACCOUNT_PAGE_HEADERS } from "../src/pages.ts";
import { SHARED_LINE } from "../src/restricted.ts";
import { SESSION_COOKIE, createSignInCode, redeemSignInCode } from "../src/sessions.ts";
import { INVITE_JS } from "../src/signin/accept.ts";
import { SIGNIN_CSS, SIGNIN_JS } from "../src/signin/page.ts";
import { SHARED_CSS, VIEW_CSS, VIEW_DENIED_HTML, VIEW_GATE_HTML, VIEW_JS, VIEW_LINK_HTML, VIEW_SIGNOUT_HTML } from "../src/view-page.ts";
import { VIEWER_COOKIE, VIEWER_SAYS } from "../src/viewers.ts";
import { send, type Call } from "./bundle.ts";
import { FakeDocument, textNodes } from "./pages-dom.ts";

const HOSTS: Hosts = { tours: "tours.example.com", app: "app.example.com" };
const THREE: Hosts = { ...HOSTS, img: "img.example.com" };
const TOURS = "https://tours.example.com";
const APP = "https://app.example.com";
const IMG = "https://img.example.com";
const UNKNOWN = "https://evil.example.net";
const NOT_FOUND = '{"error":"not_found"}';
const POLICY = "default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const HTML = "text/html; charset=utf-8";

type Served = { route: string; path: string; body: string; type: string };
const SERVED: Served[] = [
  { route: "GET /view", path: "/view", body: VIEW_LINK_HTML, type: HTML },
  { route: "GET /view/signout/:slug", path: "/view/signout/abcdefghij", body: VIEW_SIGNOUT_HTML, type: HTML },
  { route: "GET /view/view.js", path: "/view/view.js", body: VIEW_JS, type: "text/javascript; charset=utf-8" },
  { route: "GET /view/view.css", path: "/view/view.css", body: VIEW_CSS, type: "text/css; charset=utf-8" },
  { route: "GET /view/shared.css", path: "/view/shared.css", body: SHARED_CSS, type: "text/css; charset=utf-8" },
];

const seen = (c: Call) => ({ status: c.status, headers: [...c.headers.entries()].sort(), body: c.text });

/** Every text of each page's body, in order, hidden parts included. Nothing else may be in them. */
const WORDING: Record<string, { html: string; title: string; words: string[] }> = {
  gate: {
    html: VIEW_GATE_HTML,
    // Proposed: the tab's title.
    title: "Shared with specific people",
    words: [
      "Mythicshot",
      "This page needs JavaScript.",
      // Mockup 4, left.
      "This tour is shared with specific people",
      "Enter your email address. If the tour is shared with you, we send you a link to open it. There is no password.",
      "Email address",
      "Send me a link",
      // Mockup 4, right.
      "Check your mail",
      "If this tour is shared with",
      ", a link is on its way. It works once and for 15 minutes.",
      "Nothing after a few minutes? Look in your spam folder, or check with the person who sent you the tour that they used this address.",
      "Try another address",
    ],
  },
  denied: {
    html: VIEW_DENIED_HTML,
    // Proposed: the tab's title.
    title: "Not shared with you",
    words: [
      "Mythicshot",
      "This page needs JavaScript.",
      // Proposed: while the address is looked up, and after a failure, the heading of mockup 6 and the invite page's button.
      "This tour is not shared with you",
      "Try again",
      // Mockup 6, left.
      "This tour is not shared with you",
      "You are viewing as",
      ", and this tour is shared with other people. If you were given this link, ask the person who sent it to add your address.",
      "Use another address",
    ],
  },
  link: {
    html: VIEW_LINK_HTML,
    // Mockup 5's heading as the tab's title.
    title: "Open the tour",
    words: [
      "Mythicshot",
      "This page needs JavaScript.",
      // Proposed: while the code is looked up, and after a failure.
      "Opening your link",
      "Try again",
      // Mockup 5, right.
      "Open the tour",
      "Press the button to view it in this browser as",
      ".",
      "Open the tour",
      "This browser will remember your address for tours shared with you, for 30 days of use. It gives no access to anything else.",
      // Mockup 6, right.
      "This link no longer works",
      "A link works once and for 15 minutes. Open the tour's own link again and ask for a new one.",
      // The invite page's line for a reload, approved there.
      "If you reloaded this page, open the link in your mail again.",
    ],
  },
  signout: {
    html: VIEW_SIGNOUT_HTML,
    // Proposed: the page "Not you?" leads to, with mockup 6's button.
    title: "Not you?",
    words: ["Mythicshot", "This page needs JavaScript.", "Not you?", "Sign this browser out of tours shared with you, then enter your own address on the tour's page.", "Use another address"],
  },
};

/** Every text the script puts on the page, by its key in the script's TEXT. */
const TEXT: Record<string, string> = {
  // The sign-in page's own sentences.
  badEmail: "That does not look like an email address.",
  failed: "Something went wrong. Try again in a moment.",
  // The invite page's wait after too many tries.
  waitBefore: "Too many tries. Wait ",
  waitMinutes: " minutes and try again.",
  waitOneMinute: "Too many tries. Wait 1 minute and try again.",
  // The sign-in page's busy label, and a proposed one for "Open the tour".
  sending: "Sending…",
  opening: "Opening…",
};

function scriptText(): Record<string, string> {
  const block = /\n {2}var TEXT = \{\n([\s\S]*?)\n {2}\};\n/.exec(VIEW_JS);
  expect(block, "the script keeps its words in one TEXT object").not.toBeNull();
  const out: Record<string, string> = {};
  for (const line of block![1].split("\n")) {
    const m = /^ {4}([a-zA-Z]+): ("(?:[^"\\]|\\.)*"),?$/.exec(line);
    expect(m, `a line of TEXT: ${line}`).not.toBeNull();
    out[m![1]] = JSON.parse(m![2]);
  }
  return out;
}

function scriptStrings(): string[] {
  const js = VIEW_JS.split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  return [...js.matchAll(/"(?:[^"\\\n]|\\.)*"/g)].map((m) => JSON.parse(m[0]) as string);
}

describe("the viewer pages", () => {
  it("answer with the sign-in pages' headers and make no database or storage call, on the one address and on the tours address", async () => {
    const one = await makeDeps();
    const two = await makeDeps({ hosts: HOSTS });
    for (const s of SERVED) {
      for (const [deps, origin] of [[one.deps, "https://any.example.org"], [one.deps, "http://localhost:3000"], [two.deps, TOURS]] as const) {
        const r = await send(deps, "GET", s.path, { origin });
        expect([r.status, r.text, r.calls], s.path).toEqual([200, s.body, 0]);
        expect(Object.fromEntries(r.headers.entries()), s.path).toEqual({ ...ACCOUNT_PAGE_HEADERS, "content-type": s.type });
      }
      const head = await send(two.deps, "HEAD", s.path, { origin: TOURS });
      expect([head.status, head.bytes.length, head.headers.get("content-security-policy"), head.calls], s.path).toEqual([200, 0, POLICY, 0]);
    }
    // The sign-out page answers only for a slug of the right shape; else the app's own 404.
    for (const path of ["/view/signout/ABCDEFGHIJ", "/view/signout/short", "/view/signout/abcdefghijk", "/view/signout/abcdefghi1"]) {
      const r = await send(two.deps, "GET", path, { origin: TOURS });
      expect([r.status, r.text, r.calls], path).toEqual([404, NOT_FOUND, 0]);
    }
  });

  it("hold nothing about anyone: the same answer for nobody, a viewer cookie, an account's session and a token", async () => {
    const { deps } = await makeDeps({ hosts: HOSTS });
    const admin = await seedAccount(deps, { admin: true, username: "viewcheck-owner" });
    const made = await redeemSignInCode(deps, await createSignInCode(deps, admin.userId), null, null);
    const viewer = `${VIEWER_COOKIE}=dpw_${"a".repeat(64)}`;
    const secrets = [admin.email, "viewcheck-owner", admin.userId, admin.workspaceId, admin.token, made!.secret];
    for (const s of SERVED) {
      const nobody = await send(deps, "GET", s.path, { origin: TOURS });
      for (const r of [
        nobody,
        await send(deps, "GET", s.path, { origin: TOURS, headers: { cookie: viewer } }),
        await send(deps, "GET", s.path, { origin: TOURS, headers: { cookie: `${SESSION_COOKIE}=${made!.secret}` } }),
        await send(deps, "GET", s.path, { origin: TOURS, token: admin.token }),
      ]) {
        expect(seen(r), s.path).toEqual(seen(nobody));
        expect([r.calls, r.headers.get("set-cookie")], s.path).toEqual([0, null]);
        for (const secret of secrets) expect(r.text, `${s.path} holds ${secret}`).not.toContain(secret);
      }
    }
  });

  it("answer on the tours address only: the app and img addresses refuse them, an unknown host gets 421", async () => {
    const two = await makeDeps({ hosts: HOSTS });
    const three = await makeDeps({ hosts: THREE });
    for (const s of SERVED) {
      expect(HOST_RULES[s.route], s.route).toBe("tours");
      const onApp = await send(two.deps, "GET", s.path, { origin: APP });
      expect([onApp.status, onApp.text, onApp.calls, onApp.headers.get("location")], `app ${s.path}`).toEqual([404, NOT_FOUND, 0, null]);
      const onImg = await send(three.deps, "GET", s.path, { origin: IMG });
      expect([onImg.status, onImg.text, onImg.calls], `img ${s.path}`).toEqual([404, NOT_FOUND, 0]);
      const unknown = await send(two.deps, "GET", s.path, { origin: UNKNOWN });
      expect([unknown.status, unknown.bytes.length, unknown.calls], `unknown ${s.path}`).toEqual([421, 0, 0]);
      expect((await send(three.deps, "GET", s.path, { origin: TOURS })).status, `tours ${s.path}`).toBe(200);
      // Pages and files, not API: left out of the description, with their reasons.
      expect(UNDOCUMENTED_ROUTES[s.route]?.length ?? 0, s.route).toBeGreaterThan(10);
    }
    expect(HOST_RULES["GET /t/:slug/v/:name"]).toBe("tours");
    expect(UNDOCUMENTED_ROUTES["GET /t/:slug/v/:name"]?.length ?? 0).toBeGreaterThan(10);
  });

  it("the wording is the approved mockups' own, with the proposed sentences pinned", () => {
    for (const [page, w] of Object.entries(WORDING)) {
      const doc = new FakeDocument(w.html);
      expect(textNodes(doc.body), page).toEqual(w.words);
      expect(textNodes(doc.head), page).toEqual([w.title]);
      expect(doc.body.getAttribute("data-page"), page).toBe(page);
      // The only words in attributes a person can meet: the gate's placeholder, as on the sign-in page.
      for (const e of doc.body.all()) for (const name of ["aria-label", "title", "alt"]) expect(e.hasAttribute(name), `${page} <${e.tagName} ${name}>`).toBe(false);
    }
    expect(new FakeDocument(VIEW_GATE_HTML).getElementById("email")!.getAttribute("placeholder")).toBe("you@example.com");
    expect(scriptText()).toEqual(TEXT);
    const words = new Set(Object.values(TEXT));
    for (const t of scriptStrings().filter((s) => /[a-z]/i.test(s) && /\s/.test(s) && s !== "use strict")) expect(words.has(t), `a text outside TEXT: ${JSON.stringify(t)}`).toBe(true);
    // The sentences borrowed are the sign-in and invite pages' own, word for word.
    expect(SIGNIN_JS).toContain(`badEmail: ${JSON.stringify(TEXT.badEmail)},`);
    expect(SIGNIN_JS).toContain(`failed: ${JSON.stringify(TEXT.failed)},`);
    expect(SIGNIN_JS).toContain(`sending: ${JSON.stringify(TEXT.sending)},`);
    for (const k of ["waitBefore", "waitMinutes", "waitOneMinute"]) expect(INVITE_JS).toContain(`${k}: ${JSON.stringify(TEXT[k])},`);
    // The dead link's sentence is the server's own refusal, in a page's words.
    expect(VIEWER_SAYS.invalid).toBe("this link no longer works; open the tour's own link again and ask for a new one");
    // The line under a restricted tour (mockup 7).
    expect([SHARED_LINE.before, SHARED_LINE.notYou]).toEqual(["Shared with you, ", "Not you?"]);
  });

  it("each address shown is set as text in an element of its own, inside its one sentence", () => {
    const where: [string, string, string][] = [
      [VIEW_GATE_HTML, "sent-to", "If this tour is shared with , a link is on its way. It works once and for 15 minutes."],
      [VIEW_DENIED_HTML, "denied-email", "You are viewing as , and this tour is shared with other people. If you were given this link, ask the person who sent it to add your address."],
      [VIEW_LINK_HTML, "open-email", "Press the button to view it in this browser as ."],
    ];
    for (const [html, id, sentence] of where) {
      const el = new FakeDocument(html).getElementById(id)!;
      expect([el.tagName, el.className, el.children.length], id).toEqual(["span", "address", 0]);
      expect(el.parent!.textContent, id).toBe(sentence);
      expect(VIEW_JS, id).toMatch(new RegExp(`say\\(\\$\\("${id}"\\), (value|d\\.email)\\);`));
    }
  });

  it("the script takes the code from the address and removes it from the address bar before anything else, and uses it only in two request bodies", () => {
    const start = VIEW_JS.indexOf('"use strict";');
    const statements = VIEW_JS.slice(start)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("//"));
    expect(statements.slice(0, 3)).toEqual(['"use strict";', "var fragment = location.hash;", 'if (fragment !== "") history.replaceState(null, "", location.pathname + location.search);']);
    expect(VIEW_JS.match(/location\.hash/g)).toHaveLength(1);
    expect(VIEW_JS.match(/replaceState/g)).toHaveLength(1);
    expect(VIEW_JS).toContain('var match = page === "link" ? /^#(dpv_[0-9a-f]{40})$/.exec(fragment) : null;');
    expect(VIEW_JS).toContain('var code = match === null ? "" : match[1];\n  fragment = "";\n  match = null;');
    for (const m of VIEW_JS.matchAll(/\bcode\b/g)) {
      const line = VIEW_JS.slice(VIEW_JS.lastIndexOf("\n", m.index) + 1, VIEW_JS.indexOf("\n", m.index)).trim();
      expect(
        [
          'var code = match === null ? "" : match[1];',
          'code = "";',
          'if (code === "" || checking) return;',
          'if (code === "" || completing || btn.disabled) return;',
          'if (code === "") {',
          'call("POST", "/api/v1/view/check", { code: code }).then(function (res) {',
          'call("POST", "/api/v1/view/complete", { code: code }).then(function (res) {',
        ].includes(line) || line.startsWith("//"),
        `a use of the code: ${line}`,
      ).toBe(true);
    }
  });

  it("every request goes to a fixed path of this site; the completion only from the press; the gate's slug only from the page's own path", () => {
    expect(VIEW_JS.match(/\bfetch\(/g), "one place makes every request").toHaveLength(1);
    expect(VIEW_JS).toContain('var init = { method: method, headers: {}, credentials: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" };');
    const requests = [...VIEW_JS.matchAll(/\bcall\(("[A-Z]+"), ("[^"]+")/g)].map((m) => `${JSON.parse(m[1])} ${JSON.parse(m[2])}`);
    expect(requests.sort()).toEqual(["GET /api/v1/view/session", "POST /api/v1/view/check", "POST /api/v1/view/complete", "POST /api/v1/view/request", "POST /api/v1/view/signout"]);
    const pressAt = VIEW_JS.indexOf("function press() {");
    const pressEnd = VIEW_JS.indexOf("\n    }\n", pressAt);
    const completeAt = VIEW_JS.indexOf('call("POST", "/api/v1/view/complete"');
    expect(completeAt > pressAt && completeAt < pressEnd).toBe(true);
    const uncommented = VIEW_JS.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(uncommented.match(/\bpress\b/g)).toHaveLength(2);
    expect(VIEW_JS).toContain("btn.addEventListener(\"click\", press);");
    // The slug the gate asks about: the page's own path, never its query or fragment.
    expect(VIEW_JS).toContain('call("POST", "/api/v1/view/request", { email: value, slug: slug })');
    expect(VIEW_JS).toContain('var slug = slugOfPath("/t/");');
    expect(VIEW_JS.match(/location\.search/g)).toHaveLength(1);
  });

  it("the script never writes the code or an address to a store, a cookie, a log or an address, and goes nowhere but a tour's own page", () => {
    const forbidden = [
      "localStorage", "sessionStorage", "indexedDB", "cookie", "cookieStore", "caches", "postMessage", "window.name", "pushState",
      "location.href", "location.hash =", "location.search =", "sendBeacon", "XMLHttpRequest", "WebSocket", "EventSource", "import(",
      "eval(", "Function(", "console.", "open(", "setTimeout(", "setInterval(", "document.referrer", "?code", "?c=", "?slug", "csrf",
      "innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "createContextualFragment", "DOMParser", "srcdoc", "document.title",
    ];
    for (const api of forbidden) expect(VIEW_JS, api).not.toContain(api);
    const navigations = [...VIEW_JS.matchAll(/location\.(replace|assign)\(([^)]*)\)/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(navigations.sort()).toEqual(['replace "/t/" + d.slug', 'replace "/t/" + slug', 'replace "/t/" + slug']);
    expect(VIEW_JS).not.toMatch(/\blocation\s*=(?!=)/);
    expect(VIEW_JS).not.toMatch(/\b(?:window|document|self|top|parent|globalThis)\s*\.\s*location\b/);
    const uses = [...VIEW_JS.matchAll(/\blocation\b\s*(\.\s*[a-zA-Z]+)?/g)].map((m) => (m[1] ?? "").replace(/\s/g, ""));
    expect(new Set(uses)).toEqual(new Set([".hash", ".pathname", ".search", ".replace"]));
    expect(VIEW_JS).not.toMatch(/\.style\b|setAttribute\("(?:style|on[a-z]+|src|href)"|\.on[a-z]+\s*=/);
    expect(VIEW_JS).not.toMatch(/https?:|\/\/[a-z]/i);
    // Each slug the script goes to has the shape of one first.
    expect(VIEW_JS).toContain("return SLUG.test(slug) ? slug : \"\";");
    expect(VIEW_JS).toContain('typeof d.slug === "string" && SLUG.test(d.slug)');
  });

  it("load nothing from another origin, carry no inline script or style, and are usable with the keyboard and a screen reader", () => {
    for (const [page, w] of Object.entries(WORDING)) {
      const doc = new FakeDocument(w.html);
      const all = doc.root.all();
      expect(all.filter((e) => e.tagName === "script").map((e) => [e.getAttribute("src"), e.getAttribute("defer"), e.textContent]), page).toEqual([["/view/view.js", "", ""]]);
      expect(all.filter((e) => e.tagName === "link").map((e) => [e.getAttribute("rel"), e.getAttribute("href")]), page).toEqual([["stylesheet", "/view/view.css"]]);
      expect(all.filter((e) => e.tagName === "style"), page).toEqual([]);
      for (const e of all) {
        for (const [name, value] of e.attrs) {
          expect(name === "style" || name.startsWith("on"), `${page} <${e.tagName} ${name}>`).toBe(false);
          if (["src", "href", "action", "formaction", "srcset", "poster", "data"].includes(name)) expect(value, `${page} ${name}`).toMatch(/^(\/(?!\/)|$)/);
        }
      }
      expect(w.html, page).not.toMatch(/https?:|\/\//i);
      expect(all.some((e) => e.tagName === "meta" && e.getAttribute("name") === "referrer" && e.getAttribute("content") === "no-referrer"), page).toBe(true);
      expect(all.some((e) => e.tagName === "meta" && e.getAttribute("name") === "robots" && e.getAttribute("content") === "noindex"), page).toBe(true);
      expect(all.find((e) => e.tagName === "html")?.getAttribute("lang"), page).toBe("en");
      for (const b of all.filter((e) => e.tagName === "button")) expect(b.getAttribute("type"), `${page} #${b.id}`).toBe(b.id === "ask-button" ? "submit" : "button");
      for (const e of all) expect(["div", "span", "p", "li"].includes(e.tagName) && (e.hasAttribute("tabindex") || e.getAttribute("role") === "button"), `${page} <${e.tagName}> as a control`).toBe(false);
      for (const m of all.filter((e) => e.className.split(" ").includes("message") && e.parent?.tagName !== "noscript")) expect([m.getAttribute("role"), m.getAttribute("aria-live")], `${page} ${m.id}`).toEqual(["status", "polite"]);
      for (const h of all.filter((e) => e.tagName === "h1")) expect(h.getAttribute("tabindex"), `${page} ${h.id}`).toBe("-1");
      const ids = new Set(all.map((e) => e.id));
      for (const sec of all.filter((e) => e.tagName === "section")) expect(ids.has(`h-${sec.id}`), `${page} #h-${sec.id}`).toBe(true);
    }
    // Every id the script asks for is on one of its pages; every section is a state the script knows.
    const ids = new Set(Object.values(WORDING).flatMap((w) => new FakeDocument(w.html).root.all().map((e) => e.id)));
    for (const m of VIEW_JS.matchAll(/\$\("([a-z-]+)"\)/g)) expect(ids.has(m[1]), `#${m[1]}`).toBe(true);
    const states = JSON.parse(/var STATES = (\[.*\]);/.exec(VIEW_JS)![1]) as string[];
    for (const w of Object.values(WORDING)) for (const sec of new FakeDocument(w.html).root.all().filter((e) => e.tagName === "section")) expect(states, sec.id).toContain(sec.id);
    // Before the script runs, only the gate's form and the sign-out page show; the other pages show their state when the script picks it.
    const shownAtFirst = (html: string) => new FakeDocument(html).root.all().filter((e) => e.tagName === "section" && !e.hidden).map((e) => e.id);
    expect([shownAtFirst(VIEW_GATE_HTML), shownAtFirst(VIEW_DENIED_HTML), shownAtFirst(VIEW_LINK_HTML), shownAtFirst(VIEW_SIGNOUT_HTML)]).toEqual([["ask"], [], [], ["signout"]]);
    // The look is the sign-in card's, with a quiet button added; the tour page's line keeps to its own two rules.
    expect(VIEW_CSS.startsWith(SIGNIN_CSS)).toBe(true);
    expect(VIEW_CSS.slice(SIGNIN_CSS.length)).toMatch(/^button\.quiet \{/);
    expect(SHARED_CSS).not.toMatch(/url\(|@import|https?:/);
    expect(SHARED_CSS.match(/^\.dp-shared/gm)).toHaveLength(2);
  });
});
