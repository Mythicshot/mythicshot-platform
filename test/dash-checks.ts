// Test only: the checks every dashboard page and page script is held to, shared by
// test/dash.test.ts (the pages in DASH_PAGES) and test/dash-account.test.ts (the page an
// email-change link opens, which is served apart in DASH_LINK_PAGES), so the lists cannot
// drift apart.
import { expect } from "vitest";
import { FakeDocument, FakeElement, textNodes } from "./pages-dom.ts";

/**
 * What no page script may use: anything that parses markup, a browser dialog, or the
 * document's title. The Admin page alone sets the title, to "Page not found" for anyone but
 * the admin, and is exempted from that one entry by its caller.
 */
export const FORBIDDEN_IN_SCRIPTS = ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "createContextualFragment", "DOMParser", "srcdoc", "confirm(", "alert(", "prompt(", "document.title"] as const;

/** A page script holds none of FORBIDDEN_IN_SCRIPTS, but for the entries in `except`. */
export function expectNoForbiddenApis(js: string, what: string, except: readonly string[] = []): void {
  for (const api of FORBIDDEN_IN_SCRIPTS) if (!except.includes(api)) expect(js, `${what}: ${api}`).not.toContain(api);
}

/**
 * The shape every dashboard page has: English, the phone viewport, no div, span, p, li or
 * td standing in for a control, and no text naming "Account" but the tab itself (the
 * workspace's name, "Account" for a seeded account, is fetched by the script, never in the
 * page). `allowText` lists other texts holding "Account" that a page may have.
 */
export function expectPageShape(html: string, what: string, allowText: readonly string[] = []): void {
  const doc = new FakeDocument(html);
  const all = doc.root.all();
  expect(all.find((e) => e.tagName === "html")?.getAttribute("lang"), what).toBe("en");
  expect(all.some((e) => e.tagName === "meta" && e.getAttribute("name") === "viewport" && e.getAttribute("content") === "width=device-width, initial-scale=1"), what).toBe(true);
  for (const e of all) expect(["div", "span", "p", "li", "td"].includes(e.tagName) && (e.hasAttribute("tabindex") || e.getAttribute("role") === "button"), `${what} <${e.tagName}> as a control`).toBe(false);
  expect(textNodes(doc.body).filter((t) => t.includes("Account") && t !== "Account" && !allowText.includes(t)), what).toEqual([]);
}

/** The brand mark's attributes, exactly, in order (src/brand.ts). */
const MARK_ATTRS: readonly (readonly [string, string])[] = [["src", "/dash/mark.svg"], ["alt", ""], ["width", "24"], ["height", "24"]];
/** The wordmark's picture: its source for dark grounds, then its image, attributes exactly, in order (src/brand.ts). */
const WORDMARK_SOURCE_ATTRS: readonly (readonly [string, string])[] = [["srcset", "/dash/wordmark-dark.png"], ["media", "(prefers-color-scheme: dark)"]];
const WORDMARK_ATTRS: readonly (readonly [string, string])[] = [["src", "/dash/wordmark-light.png"], ["alt", "Mythicshot"], ["width", "153"], ["height", "24"]];

const exactly = (e: FakeElement, want: readonly (readonly [string, string])[]) => {
  const attrs = [...e.attrs.entries()];
  return attrs.length === want.length && attrs.every(([n, v], i) => n === want[i][0] && v === want[i][1]);
};
/** Whether `e` sits in the element of class "brand", or in that element's link. */
const inBrand = (e: FakeElement | null) => e !== null && (e.className === "brand" || (e.tagName === "a" && e.parent?.className === "brand"));
const rootOf = (e: FakeElement) => {
  let root: FakeElement = e;
  while (root.parent !== null) root = root.parent;
  return root;
};

/**
 * Whether `e` is one of the brand's two images (src/brand.ts), the only images a page holds
 * by itself: the mark, an img whose attributes are exactly src="/dash/mark.svg", alt="",
 * width="24" and height="24"; or the wordmark, an img whose attributes are exactly
 * src="/dash/wordmark-light.png", alt="Mythicshot", width="153" and height="24", the last
 * child of a picture whose only other child is its source for dark grounds (exactly
 * srcset="/dash/wordmark-dark.png" media="(prefers-color-scheme: dark)"). Either sits in the
 * element of class "brand" or in that element's link (the wordmark through its picture), and
 * is the only one of its kind in its document. Anything more (another attribute such as
 * onerror, another parent, a second mark) is not the brand. The checks that nothing a page
 * shows became markup skip them, and only them.
 */
export function isBrandMark(e: FakeElement): boolean {
  if (e.tagName !== "img") return false;
  if (exactly(e, MARK_ATTRS)) {
    if (!inBrand(e.parent)) return false;
    return rootOf(e).all().filter((x) => x.tagName === "img" && x.getAttribute("src") === "/dash/mark.svg").length === 1;
  }
  if (exactly(e, WORDMARK_ATTRS)) {
    const picture = e.parent;
    if (picture === null || picture.tagName !== "picture" || !inBrand(picture.parent)) return false;
    const kids = picture.children.filter((c): c is FakeElement => c instanceof FakeElement);
    if (kids.length !== picture.children.length) return false;
    if (kids.length !== 2 || kids[1] !== e || kids[0].tagName !== "source" || !exactly(kids[0], WORDMARK_SOURCE_ATTRS)) return false;
    const all = rootOf(e).all();
    return all.filter((x) => x.tagName === "picture").length === 1 && all.filter((x) => x.tagName === "img" && x.getAttribute("src") === "/dash/wordmark-light.png").length === 1;
  }
  return false;
}

/**
 * Whether `name` on `e` is the alt of one of the brand's images: the mark's, empty, as the
 * name beside it is the label; or the wordmark's, the product's name, which is what the
 * picture shows. The checks for words hidden in attributes skip them, and only them.
 */
export function isBrandMarkAlt(e: FakeElement, name: string): boolean {
  return name === "alt" && isBrandMark(e);
}
