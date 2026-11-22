// The parts every stylesheet of the platform starts with: the brand's tokens (src/brand-tokens.ts)
// and the fonts, served by the app itself (src/brand-routes.ts) from addresses that name
// their content. Manrope sets all text; the name beside the mark is a picture (src/brand.ts),
// so no other font is served. Until the font has loaded, the system font of the stack is used
// (font-display: swap).
import { MANROPE_PATH } from "./brand-assets.ts";
import { schemeTokensCss, tokensCss } from "./brand-tokens.ts";

/** Manrope, the variable font: every weight from 200 to 800. Licence: /fonts/manrope-OFL.txt. */
export const MANROPE_FACE = `/* Manrope, SIL Open Font License 1.1: /fonts/manrope-OFL.txt */
@font-face {
  font-family: "Manrope";
  src: url("${MANROPE_PATH}") format("truetype");
  font-weight: 200 800;
  font-style: normal;
  font-display: swap;
}
`;

/** The start of a stylesheet of a page that follows the system's colour scheme: the tokens, then Manrope. */
export const PAGE_BASE_CSS = `${tokensCss()}${MANROPE_FACE}`;

/**
 * The start of the tour player's stylesheet: the tokens of the page, then again per scheme
 * for the player's chrome, whose scheme follows the tour's card style (data-scheme on .dp,
 * set by src/player/main.ts), then Manrope.
 */
export const PLAYER_BASE_CSS = `${tokensCss()}${schemeTokensCss('.dp[data-scheme="light"]', '.dp[data-scheme="dark"]')}${MANROPE_FACE}`;

/**
 * The brand: the mark, then the wordmark's picture at its own size. When the picture cannot
 * be loaded, a browser shows its alt, "Mythicshot", in the wordmark's colour.
 */
export const WORDMARK_CSS = `.brand { font-size: 20px; line-height: 24px; font-weight: 700; color: var(--wordmark); }
.brand picture { display: block; flex: none; }
`;
