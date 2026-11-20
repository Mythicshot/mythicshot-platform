// The dashboard's Storage page: GET /storage and its own script /dash/storage.js. What their
// answers are (headers, where they answer, that they cost no database or storage call and
// hold nothing about anyone), the exact wording of the approved mockups 5 and 6 (images,
// GIFs and tours; the Images and GIFs pages themselves are not linked or tabbed from here),
// and what the script's text may and may not do. What the script does when it runs is tested under Node in
// test/node-dash-storage.test.ts.
import { describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { DASH_PAGES } from "../src/dash/routes.ts";
import { DASH_JS } from "../src/dash/script.ts";
import { STORAGE_HTML, STORAGE_JS } from "../src/dash/storage.ts";
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
const PAGE: Served = { path: "/storage", body: STORAGE_HTML, type: "text/html; charset=utf-8" };
const SCRIPT: Served = { path: "/dash/storage.js", body: STORAGE_JS, type: "text/javascript; charset=utf-8" };
const ALL = [PAGE, SCRIPT];

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

/** Every text of the Storage page's body, in order, hidden parts included. Nothing else may be in it. */
const STORAGE_WORDING = [
  "Mythicshot",
  "Tours",
  "Storage",
  "Account",
  "Admin",
  "This page needs JavaScript.",
  "Storage",
  "You are over your storage allowance. New uploads are refused until you delete tours or get more room.",
  "Tours that are already online are not affected.",
  "Images, GIFs and tours all count. Deleting one frees its space within a few minutes.",
  "What takes the room",
  "Tours",
  "GIFs",
  "Images",
  "Logos",
  "Uploads in progress",
  "Largest items",
  "Item",
  // Proposed: the names a screen reader gives the bar's column and the buttons' column; the eye does not see them.
  "Share",
  "Size",
  "Actions",
  "Everything else is on the Images, GIFs and Tours pages.",
  "Its link stops working for everyone and its pictures are removed. This cannot be undone. The recording on your computer is not touched.",
  "Keep it",
  "Delete tour",
];

/** Every text the Storage page's script puts on the page. */
const STORAGE_TEXT: Record<string, string> = {
  of: " of ",
  used: " used",
  dot: " · ",
  oneImage: "1 image",
  images: " images",
  oneGif: "1 GIF",
  gifs: " GIFs",
  oneTour: "1 tour",
  tours: " tours",
  tagTour: "Tour",
  tagImage: "Image",
  tagGif: "GIF",
  untitledImage: "Untitled image",
  untitledGif: "Untitled GIF",
  remove: "Delete",
  askBefore: 'Delete "',
  askAfter: '"?',
  askTour: "Its link stops working for everyone and its pictures are removed. This cannot be undone. The recording on your computer is not touched.",
  // Proposed: the question for an image or a GIF, in the tour question's words.
  askItem: "Its link stops working for everyone and it is removed. This cannot be undone. The copy on your computer is not touched.",
  goTour: "Delete tour",
  goImage: "Delete image",
  goGif: "Delete GIF",
  deleting: "Deleting…",
  publishBusy: "This tour is being published. Try again when that is done.",
  notReloaded: "The change was made, but the list could not be loaded again. Reload the page to see it.",
};

/** The strings with a space in the script that are not words for a person: class names. */
const CLASS_NAMES = ["btn sm danger", "meter over", "n size", "mini-cell"];

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

describe("the Storage page", () => {
  it("answers with the sign-in pages' headers and makes no database or storage call, on one address and on the app address", async () => {
    const one = await makeDeps();
    const two = await makeDeps({ hosts: HOSTS });
    for (const s of ALL) {
      expectServed(await send(one.deps, "GET", s.path, { origin: "https://any.example.org" }), s, `one address ${s.path}`);
      expectServed(await send(one.deps, "GET", s.path, { origin: "http://localhost:3000" }), s, `localhost ${s.path}`);
      expectServed(await send(two.deps, "GET", s.path, { origin: APP }), s, `app address ${s.path}`);
      const head = await send(two.deps, "HEAD", s.path, { origin: APP });
      expect([head.status, head.bytes.length, head.headers.get("content-security-policy"), head.calls], s.path).toEqual([200, 0, POLICY, 0]);
    }
    expect(DASH_PAGES.filter((p) => p.path === "/storage").map((p) => [p.path, p.html, p.script.path, p.script.body])).toEqual([["/storage", STORAGE_HTML, "/dash/storage.js", STORAGE_JS]]);
    expect(new Set(DASH_PAGES.map((p) => p.path)).size).toBe(DASH_PAGES.length);
  });

  it("holds nothing about anyone: the same answer for nobody, a member, an admin and a token", async () => {
    const { deps } = await makeDeps({ hosts: HOSTS });
    const admin = await signedIn(deps, { admin: true, username: "storecheck-owner" });
    const member = await signedIn(deps, { username: "storecheck-member" });
    const secrets = [admin.email, member.email, "storecheck-owner", "storecheck-member", admin.userId, member.userId, admin.workspaceId, member.workspaceId, admin.token, member.token, admin.secret, member.secret, admin.sessionId, admin.csrf, member.csrf];
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
    for (const text of [STORAGE_HTML, STORAGE_JS]) {
      expect(text).not.toContain("/api/v1/admin");
      expect(text).not.toMatch(/accounts|is_admin/);
    }
    expect(new FakeDocument(STORAGE_HTML).getElementById("tab-admin")!.hidden).toBe(true);
  });

  it("answers on the app address only: the tours address refuses the page and its script", async () => {
    const two = await makeDeps({ hosts: HOSTS });
    await seedAccount(two.deps, { admin: true, username: "storecheck-admin" });
    const viewer = await signedIn(two.deps, { username: "storecheck-viewer" });
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

  it("the wording is the approved mockups' own", () => {
    const doc = new FakeDocument(STORAGE_HTML);
    expect(textNodes(doc.body)).toEqual(STORAGE_WORDING);
    expect(textNodes(doc.head)).toEqual(["Storage"]);
    for (const e of doc.body.all()) for (const name of ["aria-label", "title", "alt", "placeholder"]) expect(e.hasAttribute(name), `<${e.tagName} ${name}>`).toBe(false);
    // The Storage tab is the current one.
    const current = doc.body.all().filter((e) => e.tagName === "a" && e.getAttribute("aria-current") === "page");
    expect(current.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([["Storage", "/storage"]]);
    // The sentences, each where it belongs.
    expect(doc.getElementById("storage-over")!.textContent).toBe("You are over your storage allowance. New uploads are refused until you delete tours or get more room.");
    expect(doc.getElementById("storage-online")!.textContent).toBe("Tours that are already online are not affected.");
    expect(doc.getElementById("storage-counts")!.textContent).toBe("Images, GIFs and tours all count. Deleting one frees its space within a few minutes.");
    expect(doc.getElementById("h-largest")!.textContent).toBe("Largest items");
    expect(doc.getElementById("largest-all")!.textContent).toBe("Everything else is on the Images, GIFs and Tours pages.");
    // What takes the room, in the mockup's order.
    const rooms = doc.body.all().filter((e) => e.className === "room");
    expect(rooms.map((r) => [r.all().find((c) => c.tagName === "span" && c.className === "")!.textContent, r.all().find((c) => c.className === "r")!.id])).toEqual([
      ["Tours", "room-tours"],
      ["GIFs", "room-gifs"],
      ["Images", "room-images"],
      ["Logos", "room-logos"],
      ["Uploads in progress", "room-uploads"],
    ]);
    // The summary line's words, as mockup 5 writes it.
    expect("1.2 GB" + STORAGE_TEXT.of + "5 GB" + STORAGE_TEXT.used + STORAGE_TEXT.dot + 48 + STORAGE_TEXT.images + STORAGE_TEXT.dot + 9 + STORAGE_TEXT.gifs + STORAGE_TEXT.dot + 12 + STORAGE_TEXT.tours).toBe("1.2 GB of 5 GB used · 48 images · 9 GIFs · 12 tours");
    // The question before a delete: for a tour the Tours page's own sentences, which the page holds until a question is asked.
    expect(STORAGE_TEXT.askBefore + "Loot master setup" + STORAGE_TEXT.askAfter).toBe('Delete "Loot master setup"?');
    expect(doc.getElementById("delete-text")!.textContent).toBe(STORAGE_TEXT.askTour);
    expect(STORAGE_TEXT.askTour).toBe("Its link stops working for everyone and its pictures are removed. This cannot be undone. The recording on your computer is not touched.");
    expect([doc.getElementById("delete-keep")!.textContent, doc.getElementById("delete-go")!.textContent]).toEqual(["Keep it", STORAGE_TEXT.goTour]);
    // The script's words are exactly these, and it has no other sentence.
    expect(scriptText(STORAGE_JS)).toEqual(STORAGE_TEXT);
    const words = new Set(Object.values(STORAGE_TEXT));
    const sentences = scriptStrings(STORAGE_JS).filter((t) => /[a-z]/i.test(t) && /\s/.test(t) && t !== "use strict");
    for (const t of sentences) expect(words.has(t) || CLASS_NAMES.includes(t), `a text outside TEXT: ${JSON.stringify(t)}`).toBe(true);
    // The Images and GIFs pages are another task's: no tab, link or address of them here. The tabs are the shell's four.
    for (const path of ["/images", "/gifs"]) for (const text of [STORAGE_HTML, STORAGE_JS]) expect(text, path).not.toContain(path);
    expect(doc.body.all().filter((e) => e.tagName === "a").map((a) => a.getAttribute("href"))).toEqual(["/tours", "/storage", "/account", "/admin"]);
    for (const api of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "createContextualFragment", "DOMParser", "srcdoc", "confirm(", "alert(", "prompt("]) expect(STORAGE_JS, api).not.toContain(api);
  });

  it("loads nothing from another origin and carries no inline script, style or handler; the bars are sized through the CSSOM only", () => {
    const doc = new FakeDocument(STORAGE_HTML);
    const all = doc.root.all();
    expect(all.filter((e) => e.tagName === "script").map((e) => [e.getAttribute("src"), e.hasAttribute("defer"), e.textContent])).toEqual([
      ["/dash/dash.js", true, ""],
      ["/dash/storage.js", true, ""],
    ]);
    expect(all.filter((e) => e.tagName === "link").map((e) => [e.getAttribute("rel"), e.getAttribute("href")])).toEqual([["stylesheet", "/dash/dash.css"]]);
    expect(all.filter((e) => e.tagName === "style" || e.tagName === "form")).toEqual([]);
    for (const e of all) {
      for (const [name, value] of e.attrs) {
        expect(name === "style" || name.startsWith("on"), `<${e.tagName} ${name}>`).toBe(false);
        if (["src", "href", "action", "formaction", "srcset", "poster", "data"].includes(name)) expect(value, name).toMatch(/^\/(?!\/)/);
      }
    }
    expect(STORAGE_HTML).not.toMatch(/https?:|\/\//i);
    expect(STORAGE_JS).not.toMatch(/setAttribute\("(?:style|on[a-z]+|src|srcdoc|href)"/);
    expect(STORAGE_JS).not.toMatch(/\.on[a-z]+\s*=/);
    expect(STORAGE_JS).not.toMatch(/cssText|setProperty\(|\[\s*["']style["']\s*\]/);
    // The only style the script touches is a bar's width, through the CSSOM, which the policy allows.
    expect([...STORAGE_JS.matchAll(/\.style\b[^;]*;/g)].map((m) => m[0])).toEqual(['.style.width = pct(share) + "%";', '.style.width = pct(share) + "%";']);
    // The stylesheet has the page's own part, with the warning colour for the bar that is over.
    expect(DASH_CSS).toContain("/* The Storage page. */");
    expect(DASH_CSS).toContain(".meter.over .meter-fill { background: var(--warn-bar); }");
    expect(DASH_CSS).not.toMatch(/url\(|@import|https?:|\/\/|expression\(/i);
  });

  it("keeps to this site: every request through Dash.api, the routes it may call, and leaving only for /signin", () => {
    expect(STORAGE_JS).not.toMatch(/\bfetch\(/);
    expect(STORAGE_JS).not.toMatch(/csrf/i);
    const requests = [...STORAGE_JS.matchAll(/\bapi\("([A-Z]+)", ("[^"]*")/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(requests.sort()).toEqual(['DELETE "/api/v1/media/"', 'DELETE "/api/v1/tours/"', 'GET "/api/v1/usage"', 'GET "/api/v1/usage/largest"']);
    expect(STORAGE_JS).toContain('Dash.api("DELETE", "/api/v1/tours/" + encodeURIComponent(id))');
    expect(STORAGE_JS).toContain('Dash.api("DELETE", "/api/v1/media/" + encodeURIComponent(id))');
    const forbidden = ["localStorage", "sessionStorage", "indexedDB", "cookie", "cookieStore", "caches", "postMessage", "window.name", "pushState", "replaceState", "location", "sendBeacon", "XMLHttpRequest", "WebSocket", "EventSource", "import(", "eval(", "Function(", "console.", "window.open", "setInterval(", "document.referrer", "navigator"];
    for (const api of forbidden) expect(STORAGE_JS, api).not.toContain(api);
    // One timer only: the pause before an image's or a GIF's delete is sent again, as on the Images and GIFs pages.
    expect(STORAGE_JS.match(/setTimeout\(/g)).toHaveLength(1);
    expect(STORAGE_JS).toContain("return new Promise(function (resolve) { setTimeout(resolve, ms); });");
    expect(STORAGE_JS).toContain("var PAUSES_MS = [400, 1200];");
    // A lost session goes to /signin through the shared script.
    expect(STORAGE_JS).toContain("Dash.signedOut()");
  });

  it("is usable with the keyboard and a screen reader, and lays out at phone width", () => {
    const doc = new FakeDocument(STORAGE_HTML);
    const all = doc.root.all();
    for (const b of all.filter((e) => e.tagName === "button")) expect(b.getAttribute("type"), `#${b.id}`).toBe("button");
    const messages = all.filter((e) => /\b(?:message|load)\b/.test(e.className) && e.parent?.tagName !== "noscript");
    expect(messages.map((m) => m.id).sort()).toEqual(["dash-load", "delete-message", "storage-message"]);
    for (const m of messages) expect([m.getAttribute("role"), m.getAttribute("aria-live")], `#${m.id}`).toEqual(["status", "polite"]);
    // A message line takes no room until it has a message.
    for (const m of messages.filter((e) => e.id !== "dash-load")) expect(m.hidden, `#${m.id}`).toBe(true);
    // The page behind the question, made inert while it is open: the shell's bar and this page's own part.
    expect(STORAGE_JS).toContain('var BEHIND = ["dash-top", "storage-page"];');
    expect(doc.getElementById("dash-top")!.tagName).toBe("header");
    expect(doc.getElementById("h-page")!.getAttribute("tabindex")).toBe("-1");
    expect(doc.getElementById("delete-title")!.getAttribute("tabindex")).toBe("-1");
    const dialog = all.find((e) => e.getAttribute("role") === "alertdialog")!;
    expect([dialog.getAttribute("aria-modal"), dialog.getAttribute("aria-labelledby"), dialog.getAttribute("aria-describedby")]).toEqual(["true", "delete-title", "delete-text"]);
    // The question is outside the part of the page made inert while it is open.
    expect(doc.getElementById("storage-page")!.contains(doc.getElementById("delete-dialog"))).toBe(false);
    // The bars are drawings: their numbers are in the text beside them.
    expect(doc.getElementById("storage-bar")!.getAttribute("aria-hidden")).toBe("true");
    // Every element the script looks up by id is on the page.
    const ids = new Set(all.map((e) => e.id));
    const asked = [...STORAGE_JS.matchAll(/\$\("([a-z-]+)"\)/g)].map((m) => m[1]);
    expect(asked.length).toBeGreaterThan(10);
    for (const id of asked) expect(ids.has(id), `#${id}`).toBe(true);
    // The empty headers have names a screen reader reads and the eye does not see.
    expect(all.filter((e) => e.tagName === "th").map((th) => [th.textContent, th.all().map((c) => c.className)])).toEqual([["Item", []], ["Share", ["vh"]], ["Size", []], ["Actions", ["vh"]]]);
    const phone = [...DASH_CSS.matchAll(/@media \(max-width: 720px\) \{\n([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
    expect(phone).toContain(".largest .mini-cell { display: none; }");
    expect(DASH_CSS).not.toMatch(/overflow-x|100vw/);
  });
});
