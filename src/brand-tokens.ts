// The Mythicshot brand's design tokens, the one place a colour is written down for the
// platform's pages. Every stylesheet the platform serves starts with the custom properties
// written from this table (tokensCss, or schemeTokensCss for the tour player's own chrome)
// and uses them by name; test/brand-tokens.test.ts fails when a colour is written anywhere
// else in those stylesheets.
//
// The 25 colours, the type families, the spacing, the radii and the shadow are the brand's
// (Files/Mythicshot brand/tokens.json in the owner's notes, version 1), each with its light
// and dark value. Three entries are the platform's own, made from the brand's colours and
// marked as such: the dimmed layer behind a question in the page (`scrim`), the colour of
// the name beside the mark (`wordmark`: the brand's text colour on light grounds, its gold on
// dark ones, as on the front page), and the brand's one shadow.
//
// Pure: no import, no platform API, so the tour player's script can import GROUND from here
// without pulling anything else into its bundle.

/** A colour token: its CSS name (without `--`) and its light and dark values. */
export type ColorToken = { name: string; light: string; dark: string };

/** The brand's colours, in the brand book's order, then the platform's three. */
export const COLOR_TOKENS: readonly ColorToken[] = [
  { name: "ground", light: "#f7f5fb", dark: "#16121c" },
  { name: "surface", light: "#fdfcff", dark: "#1e1928" },
  { name: "surface-raised", light: "#ffffff", dark: "#241e30" },
  { name: "border", light: "#ddd7ea", dark: "#3a3250" },
  { name: "border-strong", light: "#857c9e", dark: "#7c7399" },
  { name: "text", light: "#1d1828", dark: "#ede8f5" },
  { name: "text-muted", light: "#5c5470", dark: "#b2a8c6" },
  { name: "primary", light: "#6d4ae8", dark: "#7352ea" },
  { name: "primary-hover", light: "#5b3ad1", dark: "#7a59ee" },
  { name: "on-primary", light: "#ffffff", dark: "#ffffff" },
  { name: "primary-text", light: "#5b3ad1", dark: "#b7a3ff" },
  { name: "gold", light: "#f5b841", dark: "#f5b841" },
  { name: "accent-text", light: "#8a5a00", dark: "#f5b841" },
  { name: "focus", light: "#8a5a00", dark: "#f5b841" },
  { name: "selection", light: "#e9e2ff", dark: "#3a2e66" },
  { name: "success-tint", light: "#e0f3f0", dark: "#12302d" },
  { name: "success-text", light: "#0b645c", dark: "#7fdccf" },
  { name: "success-border", light: "#14857a", dark: "#2ba596" },
  { name: "caution-tint", light: "#ffebdd", dark: "#2e1a0c" },
  { name: "caution-text", light: "#9a3d00", dark: "#ffb380" },
  { name: "caution-border", light: "#c65a0a", dark: "#c8590c" },
  { name: "danger-tint", light: "#fde7e7", dark: "#3a1719" },
  { name: "danger-text", light: "#a32020", dark: "#ff9c9c" },
  { name: "danger-border", light: "#d13b3b", dark: "#e05252" },
  { name: "danger-fill", light: "#b42323", dark: "#b42323" },
  // The platform's own, from the brand's colours.
  { name: "wordmark", light: "#1d1828", dark: "#f5b841" },
  { name: "scrim", light: "rgba(29, 24, 40, 0.42)", dark: "rgba(0, 0, 0, 0.6)" },
  { name: "shadow-raised", light: "0 1px 2px rgba(29, 24, 40, 0.06), 0 8px 24px rgba(29, 24, 40, 0.1)", dark: "0 1px 2px rgba(0, 0, 0, 0.4), 0 8px 24px rgba(0, 0, 0, 0.45)" },
];

/** The page ground of each scheme: the tour player tints it toward a tour's accent for the "auto" backdrop. */
export const GROUND = { light: "#f7f5fb", dark: "#16121c" } as const;

/** The type families, spacing, control heights and radii: the same in both schemes. */
export const FIXED_TOKENS: readonly (readonly [string, string])[] = [
  ["font-sans", '"Manrope", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'],
  ["font-display", '"Cinzel", Georgia, "Times New Roman", serif'],
  ["font-mono", 'ui-monospace, "Cascadia Mono", Consolas, "SF Mono", Menlo, monospace'],
  ["space-1", "4px"],
  ["space-2", "8px"],
  ["space-3", "12px"],
  ["space-4", "16px"],
  ["space-6", "24px"],
  ["space-8", "32px"],
  ["space-12", "48px"],
  ["control-dense", "36px"],
  ["control-roomy", "44px"],
  ["radius-sm", "4px"],
  ["radius-md", "8px"],
  ["radius-lg", "12px"],
  ["radius-pill", "999px"],
];

const declarations = (scheme: "light" | "dark", indent: string) => COLOR_TOKENS.map((t) => `${indent}--${t.name}: ${t[scheme]};`).join("\n");

/**
 * The custom properties of a page that follows the system's colour scheme: the light values
 * and the fixed tokens on :root, the dark values under prefers-color-scheme: dark.
 */
export function tokensCss(): string {
  return `:root {
  color-scheme: light dark;
${declarations("light", "  ")}
${FIXED_TOKENS.map(([k, v]) => `  --${k}: ${v};`).join("\n")}
}
@media (prefers-color-scheme: dark) {
  :root {
${declarations("dark", "    ")}
  }
}
`;
}

/**
 * The colours again for an element whose scheme is chosen by something other than the
 * system: the tour player's chrome follows the tour's card style (data-scheme on .dp).
 */
export function schemeTokensCss(light: string, dark: string): string {
  return `${light} {
${declarations("light", "  ")}
}
${dark} {
${declarations("dark", "  ")}
}
`;
}
