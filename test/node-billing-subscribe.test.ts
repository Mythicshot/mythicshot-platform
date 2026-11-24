// What the Subscribe page's script (SUBSCRIBE_JS, src/dash/billing.ts) does to the box Stripe's
// form mounts in: run in a fresh Node `vm` context against a stand-in Stripe and Dash, the box
// is framed (class "mounted": a light card with the page's border) only once Stripe's form is
// mounted in it, and never while the page waits or when it shows the failure sentence instead.
// Node only: the Workers runtime runs no code from a string.
//
// What this leaves unproven: Stripe's real iframe inside the card (its height, its single
// column at the card's width, its own expired screen), which only a browser with Stripe shows.
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { SUBSCRIBE_HTML, SUBSCRIBE_JS } from "../src/dash/billing.ts";
import { DASH_CSS } from "../src/dash/style.ts";

type Box = { classes: Set<string>; mountedAt: number | null };

/** Runs the Subscribe page's script with Stripe answering as `stripe` says and the server as `answer`. */
async function run(opts: { stripe: "missing" | "mounts" | "rejects" | "throws"; answer: "ok" | "error" | "network" }) {
  const box: Box = { classes: new Set(["checkout"]), mountedAt: null };
  const line = { textContent: "", hidden: true };
  const events: string[] = [];
  const classList = {
    add: (c: string) => { box.classes.add(c); events.push(`add ${c}`); },
    remove: (c: string) => { box.classes.delete(c); events.push(`remove ${c}`); },
    contains: (c: string) => box.classes.has(c),
  };
  const checkoutEl = { id: "checkout", classList };
  const document = { getElementById: (id: string) => (id === "checkout" ? checkoutEl : id === "subscribe-message" ? line : null) };
  const window: Record<string, unknown> = {};
  if (opts.stripe !== "missing") {
    window.Stripe = () => ({
      createEmbeddedCheckoutPage: () => {
        if (opts.stripe === "throws") throw new Error("no");
        if (opts.stripe === "rejects") return Promise.reject(new Error("no"));
        return Promise.resolve({ mount: (sel: string) => { events.push(`mount ${sel}`); box.mountedAt = events.length; } });
      },
    });
  }
  const Dash = {
    start: (fn: () => void) => fn(),
    failure: () => "FAILED",
    api: () =>
      opts.answer === "network"
        ? Promise.reject(new Error("offline"))
        : Promise.resolve(opts.answer === "ok" ? { status: 200, data: { client_secret: "cs_x_secret_y", publishable_key: "pk_x" } } : { status: 500, data: { error: "internal" } }),
  };
  const ctx = vm.createContext({ window, document, Dash, Promise });
  vm.runInContext(SUBSCRIBE_JS, ctx);
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  return { box, line, events };
}

describe("the Subscribe page's box for Stripe's form", () => {
  it("is not framed in the page as served: no light card before the script runs", () => {
    expect(SUBSCRIBE_HTML).toContain('<div class="checkout" id="checkout"></div>');
    expect(SUBSCRIBE_HTML).not.toMatch(/\bmounted\b/);
  });

  it("is framed only right after Stripe's form is mounted in it", async () => {
    const { box, line, events } = await run({ stripe: "mounts", answer: "ok" });
    expect(events).toEqual(["mount #checkout", "add mounted"]);
    expect([...box.classes]).toEqual(["checkout", "mounted"]);
    expect(line.hidden).toBe(true);
  });

  it("stays unframed when the failure sentence shows instead of the form", async () => {
    for (const opts of [
      { stripe: "missing", answer: "ok" },
      { stripe: "mounts", answer: "error" },
      { stripe: "mounts", answer: "network" },
      { stripe: "rejects", answer: "ok" },
      { stripe: "throws", answer: "ok" },
    ] as const) {
      const { box, line, events } = await run(opts);
      expect([...box.classes], JSON.stringify(opts)).toEqual(["checkout"]);
      expect(events, JSON.stringify(opts)).not.toContain("add mounted");
      expect([line.hidden, line.textContent], JSON.stringify(opts)).toEqual([false, "FAILED"]);
    }
  });

  it("the stylesheet draws the card only on the framed box: centred, 480px at most, the page's border, white inside", () => {
    const rule = (sel: string) => {
      const m = DASH_CSS.match(new RegExp(`^${sel.replace(/[.]/g, "\\.")} \\{([^}]*)\\}`, "m"));
      return m === null ? null : m[1];
    };
    const base = rule(".checkout");
    expect(base).not.toBeNull();
    // Before the form mounts the box paints nothing: no background and no border of its own.
    expect(base).not.toMatch(/background|border/);
    const framed = rule(".checkout.mounted");
    expect(framed).not.toBeNull();
    for (const d of ["max-width: 480px", "margin-inline: auto", "border: 1px solid var(--border)", "border-radius: var(--radius-lg)", "overflow: hidden"]) expect(framed, d).toContain(d);
    // No fill of its own: Stripe's form paints the box, dark or light.
    expect(framed).not.toMatch(/background/);
    // The card never sets a height of its own, so Stripe's form grows it with no inner scrollbar.
    expect(framed).not.toMatch(/(?:^|[\s;])(?:height|max-height|overflow-y|overflow:\s*(?:auto|scroll))/);
  });
});
