// The line at the foot of the platform's own pages: "Mythicshot <version> · Source code", in
// the owner's approved wording, where only "Source code" is a link, to this copy's source.
// The platform is offered under a licence that asks for the source of a (changed) copy to be
// offered to the people who use it over a network; this line is that offer. "Mythicshot" is the
// software's name here, not the site's, and <version> is the running version (src/version.ts).
//
// Where: the sign-in pages (src/signin/page.ts), the invite page (src/signin/accept.ts), every
// dashboard page (src/dash/shell.ts, and the terms screen, src/dash/terms.ts), each as a footer
// after its main part, and the API documentation (src/docs/page.ts), as a second line in the
// footer it has. Never on a page viewers of other people's content see: a tour, the player, a
// shared image or clip, their gates and not-found pages.
//
// The address is the SOURCE_URL setting (sourceUrlSetting, src/https-address.ts), the product's
// own repository by default. Every page is built with the default's footer, SOURCE_FOOTER, and
// the routes serve it through withSource, which puts another address in when the setting names
// one. A plain link: no script, nothing the pages' policy has to allow, no database or storage
// call. Its look is the pages' own stylesheets' (".source", src/signin/page.ts and
// src/dash/style.ts).
import { SOURCE_URL_DEFAULT } from "./https-address.ts";
import { escapeHtml } from "./signin/invite.ts";
import { VERSION } from "./version.ts";

/** The line for `url`: the software's name and version, then the link. The address is escaped. */
export function sourceLineHtml(url: string): string {
  return `Mythicshot ${escapeHtml(VERSION)} · <a href="${escapeHtml(url)}" rel="noopener">Source code</a>`;
}

/** The footer of the sign-in and dashboard pages for `url`: the line, and nothing else. */
export function sourceFooterHtml(url: string): string {
  return `<footer class="source"><p>${sourceLineHtml(url)}</p></footer>`;
}

/** The footer as every page is built with it: the default address. */
export const SOURCE_FOOTER = sourceFooterHtml(SOURCE_URL_DEFAULT);

/**
 * A page with its footer for `sourceUrl` (Config.sourceUrl): the page itself when there is
 * none or it is the default. The page must hold SOURCE_FOOTER exactly once; anything else is a
 * mistake in the page, and throws.
 */
export function withSource(page: string, sourceUrl: string | null | undefined): string {
  if (page.split(SOURCE_FOOTER).length !== 2) throw new Error("a page with the source line holds it once");
  if (sourceUrl === null || sourceUrl === undefined || sourceUrl === SOURCE_URL_DEFAULT) return page;
  const footer = sourceFooterHtml(sourceUrl);
  return page.replace(SOURCE_FOOTER, () => footer);
}
