// Test only: the checks every dashboard page and page script is held to, shared by
// test/dash.test.ts (the pages in DASH_PAGES) and test/dash-account.test.ts (the page an
// email-change link opens, which is served apart in DASH_LINK_PAGES), so the lists cannot
// drift apart.
import { expect } from "vitest";
import { FakeDocument, textNodes, type FakeElement } from "./pages-dom.ts";

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

/**
 * Whether `e` is the brand's mark (src/brand.ts), the one image a page holds by itself: an
 * img whose attributes are exactly src="/dash/mark.svg", alt="", width="24" and height="24",
 * inside the element of class "brand" or inside that element's link, and the only such
 * image in its document. Anything more (another attribute such as onerror, another parent,
 * a second mark) is not the mark. The checks that nothing a page shows became markup skip
 * it, and only it.
 */
export function isBrandMark(e: FakeElement): boolean {
  if (e.tagName !== "img") return false;
  const attrs = [...e.attrs.entries()];
  if (attrs.length !== MARK_ATTRS.length || attrs.some(([n, v], i) => n !== MARK_ATTRS[i][0] || v !== MARK_ATTRS[i][1])) return false;
  const p = e.parent;
  if (p === null || !(p.className === "brand" || (p.tagName === "a" && p.parent?.className === "brand"))) return false;
  let root: FakeElement = e;
  while (root.parent !== null) root = root.parent;
  return root.all().filter((x) => x.tagName === "img" && x.getAttribute("src") === "/dash/mark.svg").length === 1;
}

/**
 * Whether `name` on `e` is the brand mark's empty alt: the name beside the mark is the
 * label, so that alt is no words, and the checks for words hidden in attributes skip it,
 * and only it.
 */
export function isBrandMarkAlt(e: FakeElement, name: string): boolean {
  return name === "alt" && isBrandMark(e);
}
