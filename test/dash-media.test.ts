// The dashboard's Images and GIFs pages: GET /images and GET /gifs, with their own scripts
// /dash/images.js and /dash/gifs.js, both made by one module (src/dash/media.ts). What
// their answers are (headers, where they answer, that they cost no database or storage
// call and hold nothing about anyone), the exact wording of the approved mockups 3 and 4
// and of the sentences proposed beside them, and what the scripts' text may and may not
// do. What the scripts do when they run is tested under Node in test/node-dash-media.test.ts.
import { describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { DASH_PAGES } from "../src/dash/routes.ts";
import { GIFS_HTML, GIFS_JS, IMAGES_HTML, IMAGES_JS } from "../src/dash/media.ts";
import { DASH_CSS } from "../src/dash/style.ts";
import { UNDOCUMENTED_ROUTES } from "../src/docs/openapi.ts";
import { HOST_RULES } from "../src/host-gate.ts";
import type { Hosts } from "../src/hosts.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import { send, type Call } from "./bundle.ts";
import { expectNoForbiddenApis, expectPageShape } from "./dash-checks.ts";
import { FakeDocument, textNodes } from "./pages-dom.ts";

const HOSTS: Hosts = { tours: "tours.example.com", app: "app.example.com" };
const THREE: Hosts = { ...HOSTS, img: "img.example.com" };
const TOURS = "https://tours.example.com";
const APP = "https://app.example.com";
const IMG = "https://img.example.com";
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
const HTML = "text/html; charset=utf-8";
const JS = "text/javascript; charset=utf-8";

// ---- The wording ----

const SHELL = ["Mythicshot", "Images", "GIFs", "Tours", "Storage", "Connections", "Account", "Admin", "This page needs JavaScript."];
/** Proposed beside the mockups (not in them): the delete question's sentence, and the two empty states. */
const QUESTION = "Its link stops working for everyone and it is removed. This cannot be undone. The copy on your computer is not touched.";
const NOT_RELOADED = "The change was made, but the list could not be loaded again. Reload the page to see it.";

/** What the two scripts share in their words. */
const SHARED_TEXT: Record<string, string> = {
  newest: "The newest ",
  inWorkspace: " in ",
  dot: " · ",
  used: " used",
  by: " × ",
  seconds: " s",
  png: "PNG",
  jpeg: "JPEG",
  copy: "Copy link",
  copied: "Copied",
  open: "Open",
  remove: "Delete",
  askBefore: 'Delete "',
  askAfter: '"?',
  deleting: "Deleting…",
  cut: "…",
  notReloaded: NOT_RELOADED,
};

type Page = { name: string; path: string; script: string; html: string; js: string; wording: string[]; text: Record<string, string>; api: string; other: string; button: string };

const PAGES: Page[] = [
  {
    name: "Images",
    path: "/images",
    script: "/dash/images.js",
    html: IMAGES_HTML,
    js: IMAGES_JS,
    api: "image",
    other: "clip",
    button: "Delete image",
    wording: [
      ...SHELL,
      "Images",
      // Proposed: the names a screen reader gives the preview's column and the buttons' column; the eye does not see them.
      "Preview",
      "Image",
      "Size",
      "Shared",
      "Actions",
      "Show more",
      "No images yet",
      "Take a screenshot in Mythicshot and choose Publish to. It shows up here with a link to share.",
      "Anyone with the link can see the image. Deleting it stops the link for everyone.",
      QUESTION,
      "Keep it",
      "Delete image",
    ],
    text: { oneItem: "1 image", items: " images", untitled: "Untitled image", ...SHARED_TEXT },
  },
  {
    name: "GIFs",
    path: "/gifs",
    script: "/dash/gifs.js",
    html: GIFS_HTML,
    js: GIFS_JS,
    api: "clip",
    other: "image",
    button: "Delete GIF",
    wording: [
      ...SHELL,
      "GIFs",
      "Preview",
      "GIF",
      "Size",
      "Shared",
      "Actions",
      "Show more",
      "No GIFs yet",
      "Record a clip in Mythicshot and choose Publish to. It shows up here with a link to share.",
      "Anyone with the link can watch the GIF. Deleting it stops the link for everyone.",
      QUESTION,
      "Keep it",
      "Delete GIF",
    ],
    text: { oneItem: "1 GIF", items: " GIFs", untitled: "Untitled GIF", ...SHARED_TEXT },
  },
];

/** The strings with a space in the scripts that are not words for a person: class names and a link's rel. */
const CLASS_NAMES = ["btn sm", "btn sm quiet", "btn sm danger", "thumb play", "n size", "n when", "noopener noreferrer"];

const seen = (c: Call) => ({ status: c.status, headers: [...c.headers.entries()].sort(), body: c.text });

function served(p: Page): Served[] {
  return [
    { path: p.path, body: p.html, type: HTML },
    { path: p.script, body: p.js, type: JS },
  ];
}

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
  return [...[...js.matchAll(/"(?:[^"\\\n]|\\.)*"/g)].map((m) => JSON.parse(m[0]) as string), ...[...js.matchAll(/'[^'\\\n]*'/g)].map((m) => m[0].slice(1, -1))];
}

describe("the Images and GIFs pages", () => {
  it("answer with the sign-in pages' headers and make no database or storage call, on one address and on the app address", async () => {
    const one = await makeDeps();
    const two = await makeDeps({ hosts: HOSTS });
    for (const p of PAGES) {
      for (const s of served(p)) {
        expectServed(await send(one.deps, "GET", s.path, { origin: "https://any.example.org" }), s, `one address ${s.path}`);
        expectServed(await send(one.deps, "GET", s.path, { origin: "http://localhost:3000" }), s, `localhost ${s.path}`);
        expectServed(await send(two.deps, "GET", s.path, { origin: APP }), s, `app address ${s.path}`);
        const head = await send(two.deps, "HEAD", s.path, { origin: APP });
        expect([head.status, head.bytes.length, head.headers.get("content-security-policy"), head.calls], s.path).toEqual([200, 0, POLICY, 0]);
      }
      expect(DASH_PAGES.filter((d) => d.path === p.path).map((d) => [d.path, d.html, d.script.path, d.script.body]), p.path).toEqual([[p.path, p.html, p.script, p.js]]);
    }
    // The two pages come first in the list, in the order of the bar.
    expect(DASH_PAGES.slice(0, 2).map((d) => d.path)).toEqual(["/images", "/gifs"]);
  });

  it("hold nothing about anyone: the same answer for nobody, a member, an admin and a token", async () => {
    const { deps } = await makeDeps({ hosts: HOSTS });
    const admin = await signedIn(deps, { admin: true, username: "mediacheck-owner" });
    const member = await signedIn(deps, { username: "mediacheck-member" });
    const secrets = [admin.email, member.email, "mediacheck-owner", "mediacheck-member", admin.userId, member.userId, admin.workspaceId, member.workspaceId, admin.token, member.token, admin.secret, member.secret, admin.sessionId, admin.csrf, member.csrf];
    for (const p of PAGES) {
      for (const s of served(p)) {
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
      for (const text of [p.html, p.js]) {
        expect(text, p.path).not.toContain("/api/v1/admin");
        expect(text, p.path).not.toMatch(/allowance|accounts|is_admin/);
      }
      expect(new FakeDocument(p.html).getElementById("tab-admin")!.hidden, p.path).toBe(true);
      expectPageShape(p.html, p.path);
    }
  });

  it("answer on the app address only: the tours and img addresses refuse the pages and their scripts", async () => {
    const two = await makeDeps({ hosts: HOSTS });
    await seedAccount(two.deps, { admin: true, username: "mediacheck-admin" });
    const viewer = await signedIn(two.deps, { username: "mediacheck-viewer" });
    const three = await makeDeps({ hosts: THREE });
    for (const p of PAGES) {
      for (const s of served(p)) {
        expect(HOST_RULES[`GET ${s.path}`], s.path).toBe("app");
        for (const headers of [{}, { cookie: viewer.cookie }] as Record<string, string>[]) {
          const onTours = await send(two.deps, "GET", s.path, { origin: TOURS, headers });
          expect([onTours.status, onTours.text, onTours.calls, onTours.headers.get("location")], `tours ${s.path}`).toEqual([404, NOT_FOUND, 0, null]);
          const onImg = await send(three.deps, "GET", s.path, { origin: IMG, headers });
          expect([onImg.status, onImg.text, onImg.calls, onImg.headers.get("location")], `img ${s.path}`).toEqual([404, NOT_FOUND, 0, null]);
        }
        const unknown = await send(two.deps, "GET", s.path, { origin: UNKNOWN });
        expect([unknown.status, unknown.bytes.length, unknown.calls], `unknown ${s.path}`).toEqual([421, 0, 0]);
        expect(UNDOCUMENTED_ROUTES[`GET ${s.path}`]?.length ?? 0, s.path).toBeGreaterThan(10);
      }
    }
  });

  it("the wording is the approved mockups' own, with the proposed sentences, and each page marks its own tab", () => {
    for (const p of PAGES) {
      const doc = new FakeDocument(p.html);
      expect(textNodes(doc.body), p.path).toEqual(p.wording);
      expect(textNodes(doc.head), p.path).toEqual([p.name]);
      for (const e of doc.body.all()) for (const name of ["aria-label", "title", "alt", "placeholder"]) expect(e.hasAttribute(name), `${p.path} <${e.tagName} ${name}>`).toBe(false);
      const current = doc.body.all().filter((e) => e.tagName === "a" && e.getAttribute("aria-current") === "page");
      expect(current.map((a) => [a.textContent, a.getAttribute("href")]), p.path).toEqual([[p.name, p.path]]);
      // The question before a delete.
      expect(p.text.askBefore + "Loot window, settings tab" + p.text.askAfter).toBe('Delete "Loot window, settings tab"?');
      expect(doc.getElementById("delete-text")!.textContent, p.path).toBe(QUESTION);
      expect([doc.getElementById("delete-keep")!.textContent, doc.getElementById("delete-go")!.textContent], p.path).toEqual(["Keep it", p.button]);
      // The script's words are exactly these, and it has no other sentence.
      expect(scriptText(p.js), p.path).toEqual(p.text);
      const words = new Set(Object.values(p.text));
      const sentences = scriptStrings(p.js).filter((t) => /[a-z]/i.test(t) && /\s/.test(t) && t !== "use strict");
      for (const t of sentences) expect(words.has(t) || CLASS_NAMES.includes(t), `${p.path}: a text outside TEXT: ${JSON.stringify(t)}`).toBe(true);
      expectNoForbiddenApis(p.js, p.script);
    }
    // The mockups' lines, put together from the words.
    const [images, gifs] = PAGES.map((p) => p.text);
    expect("48" + images.items + images.inWorkspace + "Cowfee Raid Tools" + images.dot + "64 MB" + images.used).toBe("48 images in Cowfee Raid Tools · 64 MB used");
    expect("9" + gifs.items + gifs.inWorkspace + "Cowfee Raid Tools" + gifs.dot + "250 MB" + gifs.used).toBe("9 GIFs in Cowfee Raid Tools · 250 MB used");
    expect("1920" + images.by + "1080" + images.dot + images.png).toBe("1920 × 1080 · PNG");
    expect("12" + gifs.seconds + gifs.dot + "960" + gifs.by + "540").toBe("12 s · 960 × 540");
  });

  it("are one module: the two documents and the two scripts differ only in their words and the API's kind", () => {
    const [images, gifs] = PAGES;
    const neutral = (text: string, p: Page) => {
      let out = text;
      for (const w of [...p.wording.slice(SHELL.length), ...Object.values(p.text), p.name, p.path, p.script].sort((a, b) => b.length - a.length)) out = out.split(w).join("<w>");
      return out.replace(/var KIND = "[a-z]+";/, "").replace(/var PLAY = (?:true|false);/, "");
    };
    const main = (html: string) => html.slice(html.indexOf("<main"));
    expect(neutral(main(images.html), images)).toBe(neutral(main(gifs.html), gifs));
    expect(neutral(images.js, images)).toBe(neutral(gifs.js, gifs));
    expect(images.js).toContain('var KIND = "image";');
    expect(images.js).toContain("var PLAY = false;");
    expect(gifs.js).toContain('var KIND = "clip";');
    expect(gifs.js).toContain("var PLAY = true;");
  });

  it("load nothing from another origin, carry no inline script, style or handler, and touch no style", () => {
    for (const p of PAGES) {
      const doc = new FakeDocument(p.html);
      const all = doc.root.all();
      expect(all.filter((e) => e.tagName === "script").map((e) => [e.getAttribute("src"), e.hasAttribute("defer"), e.textContent]), p.path).toEqual([
        ["/dash/dash.js", true, ""],
        [p.script, true, ""],
      ]);
      expect(all.filter((e) => e.tagName === "style" || e.tagName === "form" || e.tagName === "img"), p.path).toEqual([]);
      for (const e of all) {
        for (const [name, value] of e.attrs) {
          expect(name === "style" || name.startsWith("on"), `${p.path} <${e.tagName} ${name}>`).toBe(false);
          if (["src", "href", "action", "formaction", "srcset", "poster", "data"].includes(name)) expect(value, name).toMatch(/^\/(?!\/)/);
        }
      }
      expect(p.html, p.path).not.toMatch(/https?:|\/\//i);
      expect(p.js, p.path).not.toMatch(/setAttribute\("(?:style|on[a-z]+|src|srcdoc|srcset)"/);
      expect(p.js, p.path).not.toMatch(/\.on[a-z]+\s*=/);
      expect(p.js, p.path).not.toMatch(/\.style\b|cssText|setProperty\(|innerText|\.outerText/);
    }
    expect(DASH_CSS).toContain("/* The Images and GIFs pages. */");
    // The play mark is drawn by the stylesheet, on a GIF's box only.
    expect(DASH_CSS).toMatch(/\.thumb\.play::after \{[^}]*content: "";/);
    expect(DASH_CSS).not.toMatch(/url\(|@import|https?:|\/\/|expression\(/i);
  });

  it("keep to this site: every request through Dash.api, the routes they may call, and leaving only for /signin", () => {
    for (const p of PAGES) {
      expect(p.js, p.path).not.toMatch(/\bfetch\(|XMLHttpRequest|csrf/i);
      // The list of the page's own kind, an item's delete, the usage, and its preview (the one address not asked through Dash.api: an <img>'s).
      expect(p.js).toContain(`var KIND = ${JSON.stringify(p.api)};`);
      expect(p.js).toContain('var LIST = "/api/v1/media?kind=" + KIND;');
      expect(p.js).toContain('var ITEM = "/api/v1/media/";');
      expect(p.js).toContain('return Dash.api("GET", after === null ? LIST : LIST + "&cursor=" + encodeURIComponent(after));');
      expect(p.js).toContain('return Dash.api("DELETE", ITEM + encodeURIComponent(id)).then(');
      // The item itself, asked only when a delete got no answer: its id matched the API's shape and is escaped.
      expect(p.js).toContain('return Dash.api("GET", ITEM + encodeURIComponent(id)).then(');
      // And the usage, read beside the list for the line's count and size of this kind.
      expect(p.js).toContain('var USAGE = "/api/v1/usage";');
      expect(p.js).toContain('var TOTAL = KIND === "image" ? "images" : "gifs";');
      expect(p.js).toContain('return Dash.api("GET", USAGE).then(');
      expect(p.js.match(/Dash\.api\(/g), p.path).toHaveLength(4);
      expect(p.js).not.toContain(p.other === "clip" ? "kind=clip" : "kind=image");
      // The preview's address: the fixed path and the item's own id, which matched the API's exact shape.
      expect(p.js).toContain("var ITEM_ID = /^med_[0-9a-f]{24}$/;");
      expect(p.js).toContain('img.src = ITEM + it.id + "/preview";');
      expect(p.js.match(/\.src\b/g), p.path).toHaveLength(1);
      expect(p.js).toContain('it.kind === KIND && isCount(it.bytes)');
      const forbidden = ["localStorage", "sessionStorage", "indexedDB", "cookie", "cookieStore", "caches", "postMessage", "window.name", "pushState", "replaceState", "location.href", "location.hash", "location.replace", "location.assign", "sendBeacon", "XMLHttpRequest", "WebSocket", "EventSource", "import(", "eval(", "Function(", "console.", "window.open", "setInterval(", "document.referrer", "innerHTML"];
      for (const api of forbidden) expect(p.js, `${p.path} ${api}`).not.toContain(api);
      // The one use of the address is its origin, put before a link that is one path of this site.
      expect([...p.js.matchAll(/\blocation\b\s*(\.\s*[a-zA-Z]+)?/g)].map((m) => m[1])).toEqual([".origin"]);
      // Two timers: the moment "Copied" shows, and the pause before a delete is sent again. The one browser API beyond the page is the clipboard.
      expect(p.js.match(/setTimeout\(/g), p.path).toHaveLength(2);
      expect(p.js).toContain("var PAUSES_MS = [400, 1200];");
      expect([...p.js.matchAll(/navigator\.[a-zA-Z]+/g)].map((m) => m[0]), p.path).toEqual(["navigator.clipboard", "navigator.clipboard", "navigator.clipboard"]);
      expect(p.js).toContain("Dash.signedOut()");
    }
  });

  it("a link goes into an href only when it is http(s) with a plain host and a path, or one path of this site", () => {
    for (const p of PAGES) {
      expect(p.js).toContain("var ABSOLUTE = /^https?:\\/\\/(?:[a-z0-9.-]+|\\[[0-9a-f:.]+\\])(?::[0-9]{1,5})?\\/(?![\\/\\\\])[A-Za-z0-9._~!$&()*+,;=:@%\\/?#-]*$/i;");
      expect(p.js).toContain("var PATH = /^\\/(?![\\/\\\\])[A-Za-z0-9._~!$&()*+,;=:@%\\/?#-]*$/;");
      expect(p.js).toContain("if (ABSOLUTE.test(it.link)) return it.link;");
      expect(p.js).toContain("if (PATH.test(it.link)) return location.origin + it.link;");
      expect(p.js.match(/setAttribute\("href"/g), p.path).toHaveLength(1);
      expect(p.js).toContain('open.setAttribute("href", link);');
      expect(p.js).toContain('open.setAttribute("target", "_blank");');
      expect(p.js).toContain('open.setAttribute("rel", "noopener noreferrer");');
    }
    // The two patterns as the page compiles them.
    const absolute = /^https?:\/\/(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::[0-9]{1,5})?\/(?![/\\])[A-Za-z0-9._~!$&()*+,;=:@%/?#-]*$/i;
    const path = /^\/(?![/\\])[A-Za-z0-9._~!$&()*+,;=:@%/?#-]*$/;
    const ok = (s: string) => absolute.test(s) || path.test(s);
    for (const good of ["https://img.mythicshot.com/i/q8d2abcd", "http://localhost:3000/r/c51k", "https://[::1]:8443/i/x", "/i/q8d2abcd", "HTTPS://IMG.example.com/i/x"]) expect(ok(good), good).toBe(true);
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "//evil.example.net/i/x", "/\\evil.example.net/i/x", "https://evil.example.net", "https://user@evil.example.net/i/x", "https://evil.example.net//x", "https:/evil.example.net/i/x", " /i/x", "/i/x y", "/i/\"><b>", "/i/x\n", "vbscript:x", "ftp://img.example.com/i/x", "https://img.example.com:123456/i/x", "https://img.example.com\\@evil/i/x"]) expect(ok(bad), bad).toBe(false);
  });

  it("are usable with the keyboard and a screen reader, and lay out at phone width", () => {
    for (const p of PAGES) {
      const doc = new FakeDocument(p.html);
      const all = doc.root.all();
      for (const b of all.filter((e) => e.tagName === "button")) expect(b.getAttribute("type"), `${p.path} #${b.id}`).toBe("button");
      const messages = all.filter((e) => /\b(?:message|load)\b/.test(e.className) && e.parent?.tagName !== "noscript");
      expect(messages.map((m) => m.id).sort(), p.path).toEqual(["dash-load", "delete-message", "media-message"]);
      for (const m of messages) expect([m.getAttribute("role"), m.getAttribute("aria-live")], `${p.path} #${m.id}`).toEqual(["status", "polite"]);
      for (const m of messages.filter((e) => e.id !== "dash-load")) expect(m.hidden, `${p.path} #${m.id}`).toBe(true);
      expect(p.js).toContain('var BEHIND = ["dash-top", "media-page"];');
      expect(doc.getElementById("media-page")!.contains(doc.getElementById("delete-dialog"))).toBe(false);
      for (const h of all.filter((e) => e.tagName === "h1" || e.tagName === "h2")) expect(h.getAttribute("tabindex"), `${p.path} #${h.id}`).toBe("-1");
      const dialog = all.find((e) => e.getAttribute("role") === "alertdialog")!;
      expect([dialog.getAttribute("aria-modal"), dialog.getAttribute("aria-labelledby"), dialog.getAttribute("aria-describedby")]).toEqual(["true", "delete-title", "delete-text"]);
      // The empty headers have names a screen reader reads and the eye does not see.
      expect(all.filter((e) => e.tagName === "th").map((th) => [th.textContent, th.all().map((c) => c.className)]), p.path).toEqual([["Preview", ["vh"]], [p.wording[SHELL.length + 2], []], ["Size", []], ["Shared", []], ["Actions", ["vh"]]]);
      // On a phone the workspace's name is left out of the line, as in mockup 11.
      expect(doc.getElementById("media-in")!.className).toBe("wide-only");
      // Every element the script looks up by id is on the page.
      const ids = new Set(all.map((e) => e.id));
      const asked = [...p.js.matchAll(/\$\("([a-z-]+)"\)/g)].map((m) => m[1]);
      expect(asked.length).toBeGreaterThan(10);
      for (const id of asked) expect(ids.has(id), `${p.path} #${id}`).toBe(true);
    }
    const phone = [...DASH_CSS.matchAll(/@media \(max-width: 720px\) \{\n([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
    expect(phone).toContain(".media thead, .media td.size, .media td.when { display: none; }");
    expect(phone).toContain(".media td.acts-cell { grid-column: 1 / -1; margin-top: 8px; }");
    expect(DASH_CSS).not.toMatch(/overflow-x|100vw/);
  });
});
