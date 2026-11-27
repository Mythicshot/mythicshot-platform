// The dashboard's billing screens (src/dash/billing.ts): served only with billing on, the one
// loosened policy on the Subscribe page and today's policy everywhere else byte for byte, the
// approved wording pinned, and scripts that hold no key, no inline handler and no inline script.
import { describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { BILLING_JS, RETURN_HTML, RETURN_JS, SUBSCRIBE_HTML, SUBSCRIBE_JS, SUBSCRIBE_WORDS } from "../src/dash/billing.ts";
import { BILLING_PAGES, DASH_LINK_PAGES, DASH_PAGES, SUBSCRIBE_CSP, TERMS_PAGE } from "../src/dash/routes.ts";
import { DASH_JS } from "../src/dash/script.ts";
import { ACCOUNT_PAGE_HEADERS } from "../src/pages.ts";
import type { Deps } from "../src/ports.ts";
import { STRIPE_JS_URL } from "../src/stripe.ts";
import { send, uploadTour, clone, fixtures, type Json } from "./bundle.ts";
import { withoutSourceLine } from "./dash-checks.ts";
import { BILLING, withBilling } from "./fake-stripe.ts";

const POLICY = "default-src 'none'; img-src 'self'; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

describe("the billing pages", () => {
  it("the Subscribe page has exactly the loosened policy, and nothing else of its headers changes", async () => {
    expect(SUBSCRIBE_CSP).toBe(
      "default-src 'none'; img-src 'self' https://*.stripe.com; style-src 'self'; font-src 'self'; script-src 'self' https://js.stripe.com https://checkout.stripe.com; frame-src https://js.stripe.com https://checkout.stripe.com; connect-src 'self' https://api.stripe.com https://checkout.stripe.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(SUBSCRIBE_CSP).not.toMatch(/unsafe|'nonce|\*\.(?!stripe\.com)|data:|blob:/);
    const { deps } = await makeDeps();
    withBilling(deps);
    const r = await send(deps, "GET", "/billing/subscribe");
    expect(r.status).toBe(200);
    expect(Object.fromEntries(r.headers.entries())).toEqual({ ...ACCOUNT_PAGE_HEADERS, "content-security-policy": SUBSCRIBE_CSP, "content-type": "text/html; charset=utf-8" });
    expect(ACCOUNT_PAGE_HEADERS["content-security-policy"]).toBe(POLICY);
  });

  it("every other dashboard page and file keeps today's policy byte for byte with billing on", async () => {
    const { deps } = await makeDeps();
    withBilling(deps);
    const paths = [...DASH_PAGES, ...DASH_LINK_PAGES, TERMS_PAGE, ...BILLING_PAGES].flatMap((p) => [p.path, p.script.path]).filter((p) => p !== "/billing/subscribe");
    for (const path of [...paths, "/dash/billing.js", "/dash/dash.css", "/dash/dash.js", "/signin", "/invite"]) {
      const r = await send(deps, "GET", path);
      expect(r.status, path).toBe(200);
      expect(r.headers.get("content-security-policy"), path).toBe(POLICY);
    }
  });

  it("a tour's page, a missing tour's page and the image pages answer the same headers with billing on as without it", async () => {
    const headersOf = async (billing: boolean) => {
      const { deps } = await makeDeps();
      if (billing) withBilling(deps);
      const a = await seedAccount(deps, { username: "pub" });
      const m = clone(fixtures.v2 as Json);
      m.steps = [{ ...clone(m.steps[1]), image: "step-001.png", width: 64, height: 64, bytes: 120 }];
      const t = await uploadTour(deps, a.token, m);
      let r = await send(deps, "POST", `/api/v1/tours/${t.tour_id}/publish`, { token: a.token });
      while (r.status === 202) r = await send(deps, "POST", `/api/v1/tours/${t.tour_id}/publish`, { token: a.token, body: JSON.stringify({ publish_id: r.json.publish_id }), headers: { "content-type": "application/json" } });
      expect(r.status).toBe(200);
      const out: Record<string, unknown> = {};
      const slug = (await deps.db.first<{ slug: string }>("SELECT slug FROM tour WHERE id = ?", [t.tour_id]))!.slug;
      for (const path of [`/t/${slug}`, "/t/aaaaaaaaaa", "/s/view", "/view"]) {
        const page = await send(deps, "GET", path);
        out[path.startsWith("/t/") && path !== "/t/aaaaaaaaaa" ? "tour" : path] = { status: page.status, headers: [...page.headers.entries()].filter(([k]) => k !== "etag" && k !== "last-modified").sort() };
      }
      return out;
    };
    expect(await headersOf(true)).toEqual(await headersOf(false));
  });

  it("the Subscribe page loads Stripe's script before the page's own, with the approved words, and no script holds a key", () => {
    expect(STRIPE_JS_URL).toBe("https://js.stripe.com/endive/stripe.js");
    expect(SUBSCRIBE_HTML).toContain(`<script src="${STRIPE_JS_URL}" defer></script>\n<script src="/dash/dash.js" defer></script>`);
    expect(SUBSCRIBE_WORDS).toEqual({
      heading: "Subscribe to Mythicshot Essentials",
      summary: "$7 a month, plus tax where it applies. 5 GB for tours, images and clips. Cancel any time.",
      seller: "The payment form below is run by Stripe. The seller is Link, a Stripe company, so your receipt and card statement show Link, not Mythicshot. We never see your card.",
      back: "Back to your account",
    });
    for (const w of Object.values(SUBSCRIBE_WORDS)) expect(SUBSCRIBE_HTML).toContain(w);
    expect(SUBSCRIBE_HTML).not.toMatch(/Continue to payment|Not now/);
    for (const [name, text] of Object.entries({ SUBSCRIBE_HTML, SUBSCRIBE_JS, RETURN_HTML, RETURN_JS, BILLING_JS, DASH_JS })) {
      expect(text, name).not.toMatch(/\b(?:pk|rk|sk)_(?:test|live)|whsec_|price_FAKE/);
      expect(text, name).not.toContain(BILLING.publishableKey);
      // No inline handler: none written in a page, and none set by a script.
      if (name.endsWith("_HTML")) expect(text, name).not.toMatch(/<[^>]*\son[a-z]+\s*=/i);
      else expect(text, name).not.toMatch(/\.on[a-z]+\s*=[^=]|setAttribute\(\s*"on/);
      expect(text, name).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
    }
    for (const html of [SUBSCRIBE_HTML, RETURN_HTML]) {
      for (const tag of html.match(/<script[^>]*>/g) ?? []) expect(tag).toMatch(/ src="/);
      expect(html).not.toMatch(/style="/);
    }
    // The page asks the server for the client secret and the publishable key, and mounts Stripe's form in its box.
    expect(SUBSCRIBE_JS).toContain('Dash.api("POST", "/api/v1/billing/checkout")');
    expect(SUBSCRIBE_JS).toContain("createEmbeddedCheckoutPage({ clientSecret: secret })");
    expect(SUBSCRIBE_JS).toContain('checkout.mount("#checkout")');
    expect(SUBSCRIBE_HTML).toContain('<div class="checkout" id="checkout"></div>');
    // The secret goes into no address and no storage.
    expect(SUBSCRIBE_JS).not.toMatch(/location|localStorage|sessionStorage|history/);
  });

  it("framing the box for Stripe's form changed no word: the page is byte for byte as before, and its script writes no new text", async () => {
    // SUBSCRIBE_HTML as of 0.1.60, before the box was framed (the frame is a class the script adds), without the source line of 0.1.69.
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(withoutSourceLine(SUBSCRIBE_HTML)))), (b) => b.toString(16).padStart(2, "0")).join("");
    expect(digest).toBe("5c1b3f6e282d55f0e0261fb4000e8a4e46bcd315726f6ed3432e8c4c7fa1cfb9");
    // Every string the script holds: ids, types, the request, and the frame's class, none of them shown.
    expect([...new Set(SUBSCRIBE_JS.match(/"[^"]*"/g))].sort()).toEqual(
      ['"#checkout"', '"/api/v1/billing/checkout"', '"POST"', '"add"', '"checkout"', '"function"', '"mounted"', '"object"', '"remove"', '"string"', '"subscribe-message"', '"use strict"'].sort(),
    );
    expect(SUBSCRIBE_JS).not.toMatch(/textContent\s*=\s*"|createTextNode|innerText/);
  });

  it("the return page's three states, the notices and the Billing card hold the approved words", () => {
    for (const w of [
      "Confirming your payment",
      "This usually takes a few seconds. You can leave this page; your account updates by itself.",
      "You're subscribed",
      "You now have 5 GB. Your receipt is on its way by email from Link.",
      "Go to your tours",
      "No payment was made",
      "Nothing has changed. You can subscribe whenever you're ready.",
      "Back to your account",
    ]) expect(RETURN_HTML).toContain(w);
    for (const w of [
      "Trial:",
      " days left. You're using ",
      "Your trial ends in ",
      " Subscribe to keep your tours, images and clips. On ",
      " they are removed.",
      "Your last payment didn't go through.",
      " We'll try again. Update your card to keep your subscription.",
      "Your subscription has ended.",
      " You can view, download and delete, but not publish. Your links stay up until ",
      ", and everything is removed on ",
      "Subscribe again",
      "Manage subscription",
      "Trial ends",
      "After that",
      "Your content is removed",
      "Subscribe for $7 a month to get 5 GB and keep everything.",
      "Mythicshot Essentials, $7 a month",
      "Next payment",
      "Sold by",
      "Link, a Stripe company",
      "Receipts come from Link by email. Change your card or cancel on Stripe's page.",
      "Links stay up until",
      "Content removed",
      "You cancelled. Nothing changes until the end date, and you can keep the subscription from Stripe's page.",
      "No subscription",
      "Subscribe again before then and everything comes back as it was.",
    ]) expect(BILLING_JS).toContain(JSON.stringify(w).slice(1, -1));
    expect(BILLING_JS).toContain('"January","February","March"');
    // Manage subscription leaves only for Stripe's own page, as a top-level navigation.
    expect(BILLING_JS).toContain('url.indexOf("https://billing.stripe.com/") === 0');
    // The shared script loads billing's only when the session says billing is on.
    expect(DASH_JS).toContain("d.billing === true");
    expect(DASH_JS).toContain('billing.src = "/dash/billing.js"');
  });

  it("without the settings none of billing's pages or scripts exists", async () => {
    const { deps } = await makeDeps();
    const never = await send(deps as Deps, "GET", "/never/was");
    for (const path of ["/billing/subscribe", "/billing/return", "/dash/billing.js", "/dash/billing-subscribe.js", "/dash/billing-return.js"]) {
      const r = await send(deps, "GET", path);
      expect([r.status, r.text], path).toEqual([never.status, never.text]);
    }
  });
});
