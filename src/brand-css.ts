// The parts every stylesheet of the platform starts with: the brand's tokens (src/brand-tokens.ts)
// and the fonts, served by the app itself (src/brand-routes.ts) from addresses that name
// their content. Manrope sets all text; Cinzel sets the name "Mythicshot" beside the mark,
// and nothing else, so only the stylesheets of pages that show the mark (the dashboard's and
// the sign-in pages', on the app address) declare it. Until a font has loaded, the system
// font of each stack is used (font-display: swap).
import { CINZEL_PATH, MANROPE_PATH } from "./brand-assets.ts";
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

/** Cinzel, the variable font, for the name beside the mark only. Licence: /fonts/cinzel-OFL.txt. */
export const CINZEL_FACE = `/* Cinzel, SIL Open Font License 1.1: /fonts/cinzel-OFL.txt. The name beside the mark only. */
@font-face {
  font-family: "Cinzel";
  src: url("${CINZEL_PATH}") format("truetype");
  font-weight: 400 900;
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
 * The name beside the mark, in the brand's wordmark style: Cinzel capitals, weight 600,
 * letter-spacing 0.06em, in the wordmark colour. The text stays "Mythicshot"; the capitals
 * are only drawn.
 */
export const WORDMARK_CSS = `.brand { font-family: var(--font-display); font-size: 20px; line-height: 24px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--wordmark); }
`;
