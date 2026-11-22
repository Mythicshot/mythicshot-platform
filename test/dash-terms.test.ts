// The terms screen and the read-only terms (src/dash/terms.ts), the Account page's line and the
// Admin page's column, on both targets: how the page is served (headers, the app address only,
// no database call, nothing about anyone), the exact markup and every sentence (the mockup's,
// and the new wording awaiting approval), and what the script may and may not do. What the
// scripts do when they run is test/node-dash-terms.test.ts.
import { describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { ACCOUNT_HTML, ACCOUNT_JS } from "../src/dash/account.ts";
import { ADMIN_HTML, ADMIN_JS } from "../src/dash/admin.ts";
import { TERMS_PAGE } from "../src/dash/routes.ts";
import { DASH_JS } from "../src/dash/script.ts";
import { DASH_CSS } from "../src/dash/style.ts";
import { TERMS_HTML, TERMS_JS, TERMS_SAYS } from "../src/dash/terms.ts";
import { UNDOCUMENTED_ROUTES } from "../src/docs/openapi.ts";
import { HOST_RULES } from "../src/host-gate.ts";
import type { Hosts } from "../src/hosts.ts";
import { SESSION_COOKIE, createSignInCode, redeemSignInCode } from "../src/sessions.ts";
import { send } from "./bundle.ts";
import { expectNoForbiddenApis, expectPageShape, isBrandMark } from "./dash-checks.ts";
import { BRAND_PLAIN } from "../src/brand.ts";
import { FakeDocument, textNodes } from "./pages-dom.ts";

const HOSTS: Hosts = { tours: "tours.example.com", app: "app.example.com" };
const POLICY = "default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const SECURITY = { "content-security-policy": POLICY, "x-frame-options": "DENY", "referrer-policy": "no-referrer", "cache-control": "no-store", "x-content-type-options": "nosniff", "cross-origin-opener-policy": "same-origin" };

describe("the sentences", () => {
  it("the mockup's own words, exactly", () => {
    expect(TERMS_SAYS.beforeYouStart).toBe("Before you start");
    expect(TERMS_SAYS.mainPoints).toBe("The main points");
    expect(TERMS_SAYS.summary).toBe("This list is a summary. The full terms below are what you agree to.");
    expect(TERMS_SAYS.fullTerms).toBe("The full terms");
    expect(TERMS_SAYS.versionOf).toBe("· version of ");
    expect(TERMS_SAYS.signOut).toBe("Sign out");
    expect(TERMS_SAYS.agree).toBe("I agree");
    // The Account page's line, "You agreed to the terms of <label> on <date>." with "Read them",
    // and the Admin page's "Not yet".
    expect(ACCOUNT_JS).toContain('agreedBefore: "You agreed to the terms of ",');
    expect(ACCOUNT_JS).toContain('agreedMiddle: " on ",');
    expect(ACCOUNT_JS).toContain('agreedAfter: ".",');
    expect(ACCOUNT_JS).toContain("TEXT.agreedBefore + agreed.version + TEXT.agreedMiddle + Dash.dateOf(agreed.agreedAt, true) + TEXT.agreedAfter");
    expect(ACCOUNT_HTML).toContain('<a href="/terms?read" id="terms-read">Read them</a>');
    expect(ADMIN_JS).toContain('notYet: "Not yet",');
  });

  it("the new wording, awaiting the owner's approval, every sentence a named constant", () => {
    expect({ ...TERMS_SAYS }).toEqual({
      beforeYouStart: "Before you start",
      mainPoints: "The main points",
      summary: "This list is a summary. The full terms below are what you agree to.",
      fullTerms: "The full terms",
      versionOf: "· version of ",
      signOut: "Sign out",
      agree: "I agree",
      documentTitle: "Terms",
      openThe: "Open the ",
      asPage: " as a page",
      asPages: " as pages",
      listComma: ", ",
      listAnd: " and ",
      agreedOn: "You agreed to these terms on ",
      agreedOnAfter: ".",
      current: "These are the site's current terms. You have not agreed to a version yet.",
      noTerms: "This site has no terms.",
      back: "Back to your account",
      changed: "The terms changed while you were reading. This is the new version.",
      agreeing: "Saving…",
      signingOut: "Signing out…",
      failed: "Something went wrong. Try again in a moment.",
      needsScript: "This page needs JavaScript.",
    });
    expect(ADMIN_JS).toContain('terms: "Terms",');
    expect(ADMIN_JS).toContain('agreedToBefore: "Agreed to ",');
    expect(ADMIN_JS).toContain('agreedToMiddle: " on ",');
    expect(ADMIN_HTML).toContain('<th scope="col" class="terms">Terms</th>');
    // The script's sentences are the constants, handed over whole.
    expect(TERMS_JS).toContain(`var TEXT = ${JSON.stringify(TERMS_SAYS)};`);
  });
});

describe("the markup", () => {
  it("the terms screen is the mockup's card: the line, the title, the points, the summary, the full terms in a box that scrolls on its own, the links, Sign out and I agree", () => {
    const doc = new FakeDocument(TERMS_HTML);
    expectPageShape(TERMS_HTML, "terms");
    expect(textNodes(doc.head)).toEqual(["Terms"]);
    // The brand above the card, as every dashboard page has it (src/brand.ts), once.
    expect(TERMS_HTML.split(BRAND_PLAIN).length - 1).toBe(1);
    expect(doc.root.all().filter((e) => e.tagName === "img").map((e) => isBrandMark(e))).toEqual([true]);
    expect(textNodes(doc.body)).toEqual(["Mythicshot", "This page needs JavaScript.", "The main points", "This list is a summary. The full terms below are what you agree to.", "The full terms", "Sign out", "I agree", "Back to your account"]);
    const $ = (id: string) => doc.getElementById(id)!;
    // The box: a named region, reached with Tab and scrolled with the keys, and no trap: it is one stop.
    expect([$("terms-box").getAttribute("role"), $("terms-box").getAttribute("tabindex"), $("terms-box").getAttribute("aria-labelledby")]).toEqual(["region", "0", "h-full"]);
    expect(DASH_CSS).toMatch(/\.terms-box \{ height: 320px; max-height: 50vh; overflow-y: auto;/);
    expect(DASH_CSS).toContain(".terms-box:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }");
    expect($("h-full").textContent).toBe("The full terms ");
    expect($("terms-version").className).toBe("terms-version");
    // The card is labelled by the title, which takes the focus when it is shown.
    expect([$("terms").getAttribute("aria-labelledby"), $("terms-title").getAttribute("tabindex"), $("terms").hidden]).toEqual(["terms-title", "-1", true]);
    // The buttons, at the bottom right, Sign out first; real buttons, reached with Tab.
    expect([$("terms-signout").tagName, $("terms-signout").getAttribute("type"), $("terms-signout").className]).toEqual(["button", "button", "btn quiet"]);
    expect([$("terms-agree").tagName, $("terms-agree").getAttribute("type"), $("terms-agree").className]).toEqual(["button", "button", "btn"]);
    expect(DASH_CSS).toContain(".terms-actions { display: flex; justify-content: flex-end;");
    // Phone width: the page keeps a 16px gutter and the buttons share the row.
    expect(DASH_CSS).toContain("@media (max-width: 480px) {\n  .terms-page { padding: 16px; }");
    expect([$("terms-links").hidden, $("terms-actions").hidden, $("terms-back").hidden, $("terms-message").getAttribute("role")]).toEqual([true, true, true, "status"]);
    // Nothing from another site: the dashboard's stylesheet and the page's own script.
    expect(doc.root.all().filter((e) => e.tagName === "link" || e.tagName === "script").map((e) => e.getAttribute("href") ?? e.getAttribute("src"))).toEqual(["/dash/dash.css", "/dash/terms.js"]);
  });

  it("the Account page's line and the Admin page's column", () => {
    const account = new FakeDocument(ACCOUNT_HTML);
    const line = account.getElementById("terms-agreed")!;
    expect(line.hidden).toBe(true);
    expect(textNodes(line)).toEqual(["✓", "Read them"]);
    expect(account.getElementById("terms-agreed")!.all().find((e) => e.className === "terms-check")!.getAttribute("aria-hidden")).toBe("true");
    const admin = new FakeDocument(ADMIN_HTML);
    expect(admin.getElementById("accounts-table")!.className).toBe("accounts no-terms");
    expect(DASH_CSS).toContain(".accounts.no-terms th.terms, .accounts.no-terms td.terms { display: none; }");
  });
});

describe("how the page is served", () => {
  it("fixed text with the sign-in pages' headers and no database call, on the app address only, with or without a session", async () => {
    const one = await makeDeps();
    await seedAccount(one.deps, { admin: true });
    for (const s of [{ path: TERMS_PAGE.path, body: TERMS_HTML, type: "text/html; charset=utf-8" }, { path: TERMS_PAGE.script.path, body: TERMS_JS, type: "text/javascript; charset=utf-8" }]) {
      for (const query of ["", "?read", "?next=/connections"]) {
        const r = await send(one.deps, "GET", s.path + query);
        expect([r.status, r.text, r.calls], s.path + query).toEqual([200, s.body, 0]);
        expect(Object.fromEntries(r.headers.entries())).toEqual({ ...SECURITY, "content-type": s.type });
      }
      expect(HOST_RULES[`GET ${s.path}`]).toBe("app");
      expect(UNDOCUMENTED_ROUTES[`GET ${s.path}`]?.length ?? 0).toBeGreaterThan(10);
    }
    const two = await makeDeps({ hosts: HOSTS });
    const u = await seedAccount(two.deps, { admin: true });
    const made = await redeemSignInCode(two.deps, await createSignInCode(two.deps, u.userId), null, null);
    for (const path of [TERMS_PAGE.path, TERMS_PAGE.script.path]) {
      for (const headers of [{}, { cookie: `${SESSION_COOKIE}=${made!.secret}` }] as Record<string, string>[]) {
        const tours = await send(two.deps, "GET", path, { origin: "https://tours.example.com", headers });
        expect([tours.status, tours.calls], path).toEqual([404, 0]);
        const app = await send(two.deps, "GET", path, { origin: "https://app.example.com", headers });
        expect([app.status, app.calls], path).toEqual([200, 0]);
      }
    }
  });
});

describe("what the script may do", () => {
  it("builds every text with textContent and every link only from an address of the strict shape, keeps to this site, and leaves only for the dashboard's own pages or /signin", () => {
    expectNoForbiddenApis(TERMS_JS, "terms.js");
    for (const api of ["localStorage", "sessionStorage", "indexedDB", "cookie", "postMessage", "pushState", "replaceState", "location.href", "location.hash", "eval(", "Function(", "import(", "XMLHttpRequest", "WebSocket", "console.", "window.open", "setInterval(", "setTimeout(", "document.referrer"]) expect(TERMS_JS, api).not.toContain(api);
    // Every request, by method and path: the terms' own three and the sign-out.
    expect([...TERMS_JS.matchAll(/\bask\("([A-Z]+)", ("[^"]*")/g)].map((m) => `${m[1]} ${m[2]}`).sort()).toEqual(['GET "/api/v1/terms"', 'GET "/api/v1/terms/agreed"', 'GET "/api/v1/terms"', 'POST "/api/v1/signout"', 'POST "/api/v1/terms/agree"'].sort());
    expect(TERMS_JS).toContain('credentials: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer"');
    expect(TERMS_JS).toContain('if (method !== "GET") headers["X-Csrf-Token"] = csrf;');
    // Where it goes: /signin, or a dashboard tab named in ?next=, else Tours.
    expect([...TERMS_JS.matchAll(/location\.replace\(([^)]*)\)/g)].map((m) => m[1])).toEqual(['"/signin"', "next(", "next("]);
    expect(TERMS_JS).toContain('var BACK_TO = ["/images","/gifs","/tours","/storage","/connections","/account","/admin"];');
    expect(TERMS_JS).toContain('return BACK_TO.indexOf(path) >= 0 ? path : "/tours";');
    // Links: the strict shape, a new tab, no opener, no referrer; the label as text.
    expect(TERMS_JS).toContain('l.url.length <= 300 && LINK.test(l.url)');
    expect(TERMS_JS).toContain('a.setAttribute("rel", "noopener noreferrer");');
    expect([...TERMS_JS.matchAll(/setAttribute\("([a-z-]+)"/g)].map((m) => m[1]).sort()).toEqual(["data-label", "aria-busy", "href", "rel", "target"].sort());
    // The shared script sends a held page to the terms screen, naming the page it came from.
    expect(DASH_JS).toContain('location.replace("/terms?next=" + encodeURIComponent(location.pathname));');
    expect(DASH_JS).toContain('return res.status === 403 && res.data !== null && typeof res.data === "object" && res.data.error === "terms_required";');
  });
});
