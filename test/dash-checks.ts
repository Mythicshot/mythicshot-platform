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

/**
 * Whether `name` on `e` is the brand mark's empty alt (src/brand.ts): the image beside the
 * name, inside the brand or the brand's link, whose alt is empty because the name beside it
 * is the label. That alt is no words, so the checks for words hidden in attributes skip it,
 * and only it.
 */
export function isBrandMarkAlt(e: FakeElement, name: string): boolean {
  if (name !== "alt" || e.tagName !== "img" || e.getAttribute("alt") !== "" || e.getAttribute("src") !== "/dash/mark.png") return false;
  const p = e.parent;
  return p !== null && (p.className === "brand" || (p.tagName === "a" && p.parent?.className === "brand"));
}
