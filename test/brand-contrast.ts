// The colour pairs the platform's stylesheets put together, with the contrast each must reach
// in both schemes (WCAG 2): 4.5:1 for text, 3:1 for borders of controls, focus rings, icons,
// meaningful fills and large text. test/brand-tokens.test.ts holds every pair to its minimum
// from the token table itself, so a token changed later cannot drop a pair below it.
import { COLOR_TOKENS } from "../src/brand-tokens.ts";

export type Pair = { fg: string; bg: string; min: 4.5 | 3; use: string };

const text = (fg: string, bgs: string[], use: string): Pair[] => bgs.map((bg) => ({ fg, bg, min: 4.5, use }));
const edge = (fg: string, bgs: string[], use: string): Pair[] => bgs.map((bg) => ({ fg, bg, min: 3, use }));
const GROUNDS = ["ground", "surface", "surface-raised"];

export const PAIRS: readonly Pair[] = [
  ...text("text", [...GROUNDS, "selection"], "body text, headings, the current tab and menu rows"),
  ...text("text-muted", GROUNDS, "supporting text, captions, table headers"),
  ...text("on-primary", ["primary", "primary-hover", "danger-fill"], "labels of primary and confirming buttons"),
  ...text("primary-text", GROUNDS, "quiet buttons"),
  ...text("accent-text", GROUNDS, "links"),
  ...text("wordmark", ["surface", "ground"], "the name beside the mark"),
  ...text("success-text", ["success-tint", "surface", "ground"], "done tags and notices"),
  ...text("caution-text", ["caution-tint"], "caution boxes and tags"),
  ...text("danger-text", ["danger-tint", "surface", "ground", "surface-raised"], "errors and quiet delete buttons"),
  ...edge("border-strong", GROUNDS, "edges of fields and secondary buttons"),
  ...edge("focus", GROUNDS, "the focus ring"),
  ...edge("primary", GROUNDS, "a primary button against its ground; meters and selected options"),
  ...edge("success-border", ["success-tint", "surface"], "edge of a done notice or tag"),
  ...edge("caution-border", ["caution-tint", "surface"], "edge and icon of a caution box; a meter over its allowance"),
  ...edge("danger-border", ["danger-tint", "surface"], "edge of an error notice; a field marked wrong"),
];

const value = (name: string, scheme: "light" | "dark") => {
  const t = COLOR_TOKENS.find((c) => c.name === name);
  if (t === undefined) throw new Error(`no token ${name}`);
  return t[scheme];
};

function luminance(hex: string): number {
  const n = hex.replace("#", "");
  const c = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((s) => (s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** The WCAG 2 contrast ratio of two #rrggbb colours. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Every pair with its ratio in each scheme. */
export function contrastTable(): (Pair & { light: number; dark: number })[] {
  return PAIRS.map((p) => ({ ...p, light: contrast(value(p.fg, "light"), value(p.bg, "light")), dark: contrast(value(p.fg, "dark"), value(p.bg, "dark")) }));
}
