// Which pictures the real player asks for: the player's own bundled script (PLAYER_JS, the
// file a tour page loads) is run in a fresh Node `vm` context against a permissive stand-in
// document that only records every address given to an image's `src`, with the page's data
// block taken from the exact HTML a route answered. Once per step (the player starts at the
// step its address names) and once on the cover (where the logo is shown), so every picture
// the tour names is asked for at least once. Node only: the Workers runtime runs no code from
// a string.
//
// It holds the restricted tour page to asking for /t/<slug>/v/<name> for each step and the
// logo, a public page to its old addresses, and both to asking nothing for a picture name of
// the other kind or of any other shape; and it walks a listed viewer through the real routes
// to the stored bytes of each picture the player asks for.
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { hashToken, newId } from "../src/auth.ts";
import type { Hosts } from "../src/hosts.ts";
import { pageHtml, pageTour, type PageTour } from "../src/page.ts";
import { PLAYER_JS, PLAYER_JS_PATH } from "../src/player/assets.ts";
import type { Deps } from "../src/ports.ts";
import { restrictedPageHtml } from "../src/restricted.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import { VIEWER_CODE_MS } from "../src/viewers.ts";
import { send, uploadTour } from "./bundle.ts";
import { manifestOf } from "./isolation-world.ts";

const TOURS = "https://tours.example.com";
const APP = "https://app.example.com";
const TWO: Hosts = { tours: "tours.example.com", app: "app.example.com" };
const HEX = (n: number) => n.toString(16).padStart(32, "0");

/**
 * A stand-in for whatever the player touches: every property is another stand-in (or what was
 * set on it), every call answers a stand-in, it iterates as empty and counts as 0. Only the
 * data block's text, the root element and the addresses given to `src` are real.
 */
function runPlayer(html: string, hash = ""): string[] {
  const block = /<script type="application\/json" id="tour">([\s\S]*?)<\/script>/.exec(html);
  if (block === null) throw new Error("no data block");
  const scripts = [...html.matchAll(/<script src="([^"]+)" defer><\/script>/g)].map((m) => m[1]);
  expect(scripts, "the page loads the player's file and nothing else").toEqual([PLAYER_JS_PATH]);
  const requested: string[] = [];
  const thing = (name: string, store: Record<PropertyKey, unknown> = {}): unknown => {
    const target = function () {} as unknown as Record<PropertyKey, unknown>;
    const proxy: unknown = new Proxy(target, {
      get(_t, prop) {
        if (Object.hasOwn(store, prop)) return store[prop];
        if (prop === Symbol.toPrimitive) return () => 0;
        if (prop === Symbol.iterator) return function* () {};
        if (prop === "then" || prop === "toJSON") return undefined;
        if (typeof prop === "symbol") return undefined;
        const made = thing(`${name}.${String(prop)}`);
        store[prop] = made;
        return made;
      },
      set(_t, prop, value) {
        if (prop === "src" && typeof value === "string") requested.push(value);
        store[prop] = value;
        return true;
      },
      apply() {
        return thing(`${name}()`);
      },
      construct() {
        return thing(`new ${name}`) as object;
      },
    });
    return proxy;
  };
  const tourBlock = thing("tour", { textContent: block[1] });
  const root = thing("player");
  const document = thing("document", {
    readyState: "complete",
    getElementById: (id: string) => (id === "tour" ? tourBlock : id === "player" ? root : null),
    createElement: (tag: string) => thing(`<${tag}>`, { tagName: tag.toUpperCase() }),
    createElementNS: (_ns: string, tag: string) => thing(`<svg:${tag}>`),
    createTextNode: () => thing("#text"),
  });
  let current = new URL(`${TOURS}/t/abcdefghij${hash}`);
  const context: Record<string, unknown> = {
    document,
    window: thing("window", { matchMedia: () => thing("media", { matches: false, addEventListener: () => {} }) }),
    location: {
      get hash() {
        return current.hash;
      },
      get pathname() {
        return current.pathname;
      },
      get search() {
        return current.search;
      },
    },
    history: { state: null, replaceState: (_s: unknown, _t: string, next: string) => (current = new URL(next, current)) },
    Image: function Image() {
      return thing("Image");
    },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    navigator: thing("navigator"),
    getComputedStyle: () => thing("style"),
    ResizeObserver: function () {
      return thing("observer");
    },
  };
  vm.runInContext(PLAYER_JS, vm.createContext(context), { filename: "player.js" });
  return requested;
}

/** Every address the player asks for over the whole tour: on the cover, then starting at each step. */
function everyRequest(html: string, tour: PageTour): string[] {
  const all = new Set(runPlayer(html));
  tour.chapters.forEach((c, ci) => c.steps.forEach((_s, si) => runPlayer(html, `#chapter-${ci + 1}-step-${si + 1}`).forEach((u) => all.add(u))));
  return [...all].sort();
}

/** A tour of `steps` steps, each picture field given, with a cover naming `logo`. */
function tourWith(images: string[], logo: string | null): PageTour {
  const step = (image: string, i: number) => ({
    id: `st_${String(i).padStart(24, "0")}`,
    image,
    width: 64,
    height: 64,
    click: null,
    caption: null,
    spotlight: null,
    notes: [],
    card: null,
    advance: "anywhere",
    zoom: null,
  });
  return pageTour({
    title: "Pictures",
    spotlight_dim: null,
    theme: { card_style: "dark", accent: "#5dcaa5", hotspot: "pulse", progress_bar: true, backdrop: "auto", spotlight_soft: true },
    zoom: { enabled: false, percent: 100 },
    cover: logo === null ? null : { title: "Cover", body: "", button: "Start", logo },
    cta: null,
    end: null,
    autoplay: { enabled: false, seconds: 5 },
    chapters: [{ title: "One", description: null, steps: images.map(step) }],
  });
}

describe("the pictures the player asks for", () => {
  it("a restricted page asks for /t/<slug>/v/<name> for each step and the logo, and for nothing else", () => {
    const tour = tourWith([`v/${HEX(1)}.png`, `v/${HEX(2)}.jpg`, `v/${HEX(3)}.png`], `v/${HEX(4)}.png`);
    const html = restrictedPageHtml(tour, "abcdefghij", "mara@example.com");
    expect(everyRequest(html, tour)).toEqual([1, 2, 3, 4].map((n) => `/t/abcdefghij/v/${HEX(n)}.${n === 2 ? "jpg" : "png"}`).sort());
  });

  it("a public page asks for its pictures exactly as before: under /p/ on this origin, or under the public image base", () => {
    const tour = tourWith([`p/${HEX(1)}.png`, `p/${HEX(2)}.jpg`], `p/${HEX(3)}.png`);
    expect(everyRequest(pageHtml(tour, ""), tour)).toEqual([`/p/${HEX(1)}.png`, `/p/${HEX(2)}.jpg`, `/p/${HEX(3)}.png`]);
    expect(everyRequest(pageHtml(tour, "https://pictures.example.net/"), tour)).toEqual([`https://pictures.example.net/p/${HEX(1)}.png`, `https://pictures.example.net/p/${HEX(2)}.jpg`, `https://pictures.example.net/p/${HEX(3)}.png`]);
  });

  it("a public page asks for nothing for a v/ picture, with either base", () => {
    const tour = tourWith([`v/${HEX(1)}.png`, `p/${HEX(2)}.png`], `v/${HEX(3)}.png`);
    expect(everyRequest(pageHtml(tour, ""), tour)).toEqual([`/p/${HEX(2)}.png`]);
    expect(everyRequest(pageHtml(tour, "https://pictures.example.net"), tour)).toEqual([`https://pictures.example.net/p/${HEX(2)}.png`]);
  });

  it("a restricted page asks for nothing for a p/ picture, an address, or a name with dots, slashes, backslashes or an encoded form", () => {
    const strange = [
      `p/${HEX(1)}.png`,
      "https://evil.example.net/x.png",
      "//evil.example.net/x.png",
      `/p/${HEX(1)}.png`,
      `v/../${HEX(1)}.png`,
      `v/..%2F${HEX(1)}.png`,
      `v/${HEX(1)}/x.png`,
      `v\\${HEX(1)}.png`,
      `v%2F${HEX(1)}.png`,
      `v/${HEX(1)}%2Epng`,
      `v/${HEX(1)}.png?x=1`,
      `v/${HEX(1)}.png#x`,
      `v/${HEX(0xabc).toUpperCase()}.png`,
      `v/${HEX(1)}.gif`,
      `v/${HEX(1)}.png `,
    ];
    const tour = tourWith([...strange, `v/${HEX(9)}.png`], strange[1]);
    expect(everyRequest(restrictedPageHtml(tour, "abcdefghij", "mara@example.com"), tour)).toEqual([`/t/abcdefghij/v/${HEX(9)}.png`]);
  });

  it("a base of any other shape asks for nothing", () => {
    const tour = tourWith([`v/${HEX(1)}.png`, `p/${HEX(2)}.png`], null);
    for (const base of ["/t/../admin", "//evil.example.net", "/t/abcdefghij/x", "/t/ABCDEFGHIJ", "/p", "http://pictures.example.net", "javascript:alert(1)"]) {
      expect(everyRequest(pageHtml(tour, base), tour), base).toEqual([]);
    }
  });
});

describe("a listed viewer through the real routes", () => {
  it("signs in, gets the page, and every picture the player asks for answers its stored bytes with the viewer cookie", { timeout: 300_000 }, async () => {
    const { deps } = await makeDeps({ hosts: TWO });
    const owner = await seedAccount(deps, { admin: true, username: "pictures" });
    const made = await redeemSignInCode(deps, await createSignInCode(deps, owner.userId), null, null);
    const t = await uploadTour(deps, owner.token, manifestOf([320, 321, 322], "Pictures walk", true), { kind: "new" }, 11);
    const slug = (await deps.db.first<{ slug: string }>("SELECT slug FROM tour WHERE id = ?", [t.tour_id]))!.slug;
    const put = await send(deps, "PUT", `/api/v1/tours/${t.tour_id}/access`, {
      origin: APP,
      headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${made!.secret}`, "x-csrf-token": await csrfFor(made!.secret), origin: APP, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ access: "people", viewers: ["mara@example.com"] }),
    });
    expect(put.status).toBe(200);
    let r = await send(deps, "POST", `/api/v1/tours/${t.tour_id}/publish`, { token: owner.token });
    while (r.status === 202) r = await send(deps, "POST", `/api/v1/tours/${t.tour_id}/publish`, { token: owner.token, headers: { "content-type": "application/json" }, body: JSON.stringify({ publish_id: r.json.publish_id }) });
    expect(r.status).toBe(200);

    const cookie = await signIn(deps, "mara@example.com", slug);
    const page = await send(deps, "GET", `/t/${slug}`, { origin: TOURS, headers: { cookie } });
    expect(page.status).toBe(200);
    const tour = JSON.parse(/<script type="application\/json" id="tour">([\s\S]*?)<\/script>/.exec(page.text)![1]).tour as PageTour;
    const urls = everyRequest(page.text, tour);
    const live = (await deps.db.all<{ image_key: string }>("SELECT image_key FROM snapshot_object WHERE tour_id = ?", [t.tour_id])).map((x) => x.image_key);
    expect(live).toHaveLength(4);
    expect(urls).toEqual(live.map((k) => `/t/${slug}/${k}`).sort());
    for (const url of urls) {
      const got = await send(deps, "GET", url, { origin: TOURS, headers: { cookie } });
      const stored = await deps.drafts.get(url.slice(`/t/${slug}/`.length));
      expect([got.status, got.bytes], url).toEqual([200, new Uint8Array(await new Response(stored!.body).arrayBuffer())]);
      // Without the cookie, nothing.
      expect((await send(deps, "GET", url, { origin: TOURS })).status, url).toBe(404);
    }
  });
});

/** A viewer session for `email` through the real completion; its Cookie header. */
async function signIn(deps: Deps, email: string, slug: string): Promise<string> {
  const code = "dpv_" + Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, "0")).join("");
  await deps.db.run("INSERT INTO viewer_code (id, email, slug, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)", [newId("vco"), email, slug, await hashToken(code), deps.now(), deps.now() + VIEWER_CODE_MS]);
  const r = await send(deps, "POST", "/api/v1/view/complete", { origin: TOURS, headers: { "content-type": "application/json", origin: TOURS, "sec-fetch-site": "same-origin" }, body: JSON.stringify({ code }) });
  expect(r.status, r.text).toBe(200);
  return r.headers.getSetCookie()[0].split(";")[0];
}
