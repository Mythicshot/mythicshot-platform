// The one token set: every stylesheet the platform serves starts with the brand's custom
// properties (src/brand-tokens.ts through src/brand-css.ts) and writes no colour of its own;
// the token values are the brand's; every pair of colours the stylesheets put together reaches
// its contrast in both schemes; and the type, corners and focus ring follow the brand.
import { describe, expect, it } from "vitest";
import { CINZEL_FACE, MANROPE_FACE, PAGE_BASE_CSS, PLAYER_BASE_CSS } from "../src/brand-css.ts";
import { COLOR_TOKENS, FIXED_TOKENS, GROUND, schemeTokensCss, tokensCss } from "../src/brand-tokens.ts";
import { DASH_CSS } from "../src/dash/style.ts";
import { DOCS_CSS } from "../src/docs/site-assets.ts";
import { SHARE_CSS } from "../src/media-assets.ts";
import { MEDIA_SHARED_CSS, MEDIA_VIEW_CSS } from "../src/media-view-page.ts";
import { PLAYER_CSS } from "../src/player/assets.ts";
import { SETUP_CSS } from "../src/setup/page.ts";
import { SIGNIN_CSS } from "../src/signin/page.ts";
import { SHARED_CSS, VIEW_CSS } from "../src/view-page.ts";
import { contrastTable } from "./brand-contrast.ts";
import { isStageRule, rulesOf } from "./player-stage.ts";

/** The brand's 25 colours, light and dark, as its tokens.json (version 1) gives them. */
const BRAND: Record<string, [string, string]> = {
  ground: ["#f7f5fb", "#16121c"],
  surface: ["#fdfcff", "#1e1928"],
  "surface-raised": ["#ffffff", "#241e30"],
  border: ["#ddd7ea", "#3a3250"],
  "border-strong": ["#857c9e", "#7c7399"],
  text: ["#1d1828", "#ede8f5"],
  "text-muted": ["#5c5470", "#b2a8c6"],
  primary: ["#6d4ae8", "#7352ea"],
  "primary-hover": ["#5b3ad1", "#7a59ee"],
  "on-primary": ["#ffffff", "#ffffff"],
  "primary-text": ["#5b3ad1", "#b7a3ff"],
  gold: ["#f5b841", "#f5b841"],
  "accent-text": ["#8a5a00", "#f5b841"],
  focus: ["#8a5a00", "#f5b841"],
  selection: ["#e9e2ff", "#3a2e66"],
  "success-tint": ["#e0f3f0", "#12302d"],
  "success-text": ["#0b645c", "#7fdccf"],
  "success-border": ["#14857a", "#2ba596"],
  "caution-tint": ["#ffebdd", "#2e1a0c"],
  "caution-text": ["#9a3d00", "#ffb380"],
  "caution-border": ["#c65a0a", "#c8590c"],
  "danger-tint": ["#fde7e7", "#3a1719"],
  "danger-text": ["#a32020", "#ff9c9c"],
  "danger-border": ["#d13b3b", "#e05252"],
  "danger-fill": ["#b42323", "#b42323"],
};

/** Every stylesheet of the pages named in the restyle, as served. */
const PAGE_SHEETS: [string, string][] = [
  ["/dash/dash.css (dashboard, terms screen)", DASH_CSS],
  ["/signin/signin.css (sign-in, link, invite)", SIGNIN_CSS],
  ["/view/view.css (a restricted tour's gate)", VIEW_CSS],
  ["/s/view.css (a restricted item's gate)", MEDIA_VIEW_CSS],
  ["/s/share.css (shared image and clip pages, their not-found page)", SHARE_CSS],
  ["/setup/setup.css (setup wizard)", SETUP_CSS],
  ["the API documentation page's own stylesheet", DOCS_CSS],
];

/** A colour written as a value: hex, a colour function, or a colour keyword (transparent and currentColor are not colours of their own). */
const LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(|(?<![-\w])(?:white|black|red|green|blue|gr[ae]y|silver|orange|yellow|purple|navy|teal|maroon|olive|lime|aqua|fuchsia|gold|tomato|crimson)\b/i;

/** Every declaration value of a stylesheet, comments taken out first, with the line it is on. */
function values(css: string): { value: string; line: string }[] {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: { value: string; line: string }[] = [];
  for (const line of plain.split("\n")) for (const m of line.matchAll(/:\s*([^;{}]+)(?=[;}])/g)) out.push({ value: m[1], line });
  return out;
}

/** The colours a stylesheet writes itself, after its token block. */
function literalsAfter(css: string, base: string): string[] {
  expect(css.startsWith(base)).toBe(true);
  return values(css.slice(base.length)).filter((v) => LITERAL.test(v.value)).map((v) => v.line.trim());
}


describe("the token source", () => {
  it("holds the brand's 25 colours with their light and dark values, and the platform's three, nothing else", () => {
    for (const [name, [light, dark]] of Object.entries(BRAND)) expect(COLOR_TOKENS.find((t) => t.name === name), name).toEqual({ name, light, dark });
    expect(COLOR_TOKENS.map((t) => t.name).filter((n) => !(n in BRAND))).toEqual(["wordmark", "scrim", "shadow-raised"]);
    expect(GROUND).toEqual({ light: BRAND.ground[0], dark: BRAND.ground[1] });
    const wordmark = COLOR_TOKENS.find((t) => t.name === "wordmark");
    expect(wordmark).toEqual({ name: "wordmark", light: BRAND.text[0], dark: BRAND.gold[1] });
  });

  it("gives the type families, the spacing scale, the two control heights and the radii", () => {
    const fixed = Object.fromEntries(FIXED_TOKENS);
    expect(fixed["font-sans"].startsWith('"Manrope", system-ui')).toBe(true);
    expect(fixed["font-display"].startsWith('"Cinzel", Georgia')).toBe(true);
    expect(fixed["font-mono"].startsWith("ui-monospace")).toBe(true);
    expect([1, 2, 3, 4, 6, 8, 12].map((n) => fixed[`space-${n}`])).toEqual(["4px", "8px", "12px", "16px", "24px", "32px", "48px"]);
    expect([fixed["control-dense"], fixed["control-roomy"]]).toEqual(["36px", "44px"]);
    expect([fixed["radius-sm"], fixed["radius-md"], fixed["radius-lg"], fixed["radius-pill"]]).toEqual(["4px", "8px", "12px", "999px"]);
  });

  it("writes light values on :root and dark ones under the system's dark scheme, and per scheme for the player's chrome", () => {
    const css = tokensCss();
    const [light, dark] = css.split("@media (prefers-color-scheme: dark)");
    for (const t of COLOR_TOKENS) {
      expect(light, t.name).toContain(`  --${t.name}: ${t.light};\n`);
      expect(dark, t.name).toContain(`    --${t.name}: ${t.dark};\n`);
    }
    expect(light.startsWith(":root {\n  color-scheme: light dark;\n")).toBe(true);
    const scheme = schemeTokensCss(".a", ".b");
    expect(scheme.startsWith(".a {\n")).toBe(true);
    for (const t of COLOR_TOKENS) expect(scheme, t.name).toContain(`--${t.name}: ${t.dark};`);
  });

  it("every pair of colours the stylesheets put together meets its contrast in both schemes", () => {
    const table = contrastTable();
    expect(table.length).toBeGreaterThan(35);
    for (const r of table) {
      expect(r.light, `${r.fg} on ${r.bg}, light (${r.use})`).toBeGreaterThanOrEqual(r.min);
      expect(r.dark, `${r.fg} on ${r.bg}, dark (${r.use})`).toBeGreaterThanOrEqual(r.min);
    }
  });
});

describe("every stylesheet uses the one token set", () => {
  it("each page stylesheet starts with the tokens and Manrope, and writes no colour of its own", () => {
    expect(PAGE_BASE_CSS).toBe(tokensCss() + MANROPE_FACE);
    for (const [what, css] of PAGE_SHEETS) expect(literalsAfter(css, PAGE_BASE_CSS), what).toEqual([]);
  });

  it("the line under restricted content uses the tokens its page's other stylesheet declares, and writes no colour", () => {
    for (const css of [SHARED_CSS, MEDIA_SHARED_CSS]) {
      expect(literalsAfter(css, ""), css).toEqual([]);
      expect(css).toContain("var(--text-muted)");
    }
  });

  it("the player's stylesheet starts with the tokens, its chrome's per scheme, and Manrope; only the tour's own stage and cards keep colours", () => {
    expect(PLAYER_BASE_CSS).toBe(tokensCss() + schemeTokensCss('.dp[data-scheme="light"]', '.dp[data-scheme="dark"]') + MANROPE_FACE);
    // The stage (test/player-stage.ts) is the tour's own look, as 0.1.53 drew it: the one
    // allow-list of colour literals, which test/player-theme.test.ts holds to 0.1.53's bytes.
    expect(PLAYER_CSS.startsWith(PLAYER_BASE_CSS)).toBe(true);
    const rules = rulesOf(PLAYER_CSS.slice(PLAYER_BASE_CSS.length));
    const coloured = (r: { body: string }) => values(`x{${r.body}}`).some((v) => LITERAL.test(v.value));
    expect(rules.filter((r) => !isStageRule(r) && coloured(r)).map((r) => `${r.context} ${r.selector}`)).toEqual([]);
    expect(rules.filter((r) => isStageRule(r) && coloured(r)).length).toBeGreaterThan(5);
  });

  it("the literal check finds colours in every form it should", () => {
    for (const v of ["#fff", "#A0B1C2", "#a0b1c2ff", "rgb(1, 2, 3)", "rgba(0,0,0,.5)", "hsl(1 2% 3%)", "white", "Black", "oklch(0.5 0.1 200)", "color-mix(in srgb, red, blue)"]) expect(literalsAfter(`${PAGE_BASE_CSS}.x { color: ${v}; }`, PAGE_BASE_CSS), v).toHaveLength(1);
    for (const v of ["transparent", "currentColor", "var(--text)", "var(--gold)", "inherit"]) expect(literalsAfter(`${PAGE_BASE_CSS}.x { color: ${v}; }`, PAGE_BASE_CSS), v).toHaveLength(0);
    // Selectors and comments are not values: an id that looks like hex is not a colour.
    expect(literalsAfter(`${PAGE_BASE_CSS}#add, #bad { margin: 0; } /* #fff */`, PAGE_BASE_CSS)).toEqual([]);
  });

  it("Cinzel is declared only where the mark is shown with the name: the dashboard's and the sign-in pages' stylesheets", () => {
    for (const [what, css] of [["dash", DASH_CSS], ["signin", SIGNIN_CSS]] as const) expect(css.split(CINZEL_FACE).length - 1, what).toBe(1);
    for (const [what, css, base] of [...PAGE_SHEETS.filter(([, c]) => c !== DASH_CSS && c !== SIGNIN_CSS).map(([w, c]) => [w, c, PAGE_BASE_CSS]), ["player", PLAYER_CSS, PLAYER_BASE_CSS]]) {
      // The token of the family is there with the rest; nothing after it declares or uses Cinzel.
      expect(css.slice(base.length), what).not.toContain("Cinzel");
      expect(css, what).not.toContain("var(--font-display)");
    }
  });
});

describe("the brand's components", () => {
  const sheets: [string, string][] = [["dash", DASH_CSS], ["signin", SIGNIN_CSS], ["view", VIEW_CSS], ["share", SHARE_CSS], ["setup", SETUP_CSS], ["docs", DOCS_CSS], ["player", PLAYER_CSS]];

  it("every page sets its text in Manrope from the token, with the system font behind it", () => {
    for (const [what, css] of sheets) expect(css, what).toMatch(/\nbody \{[^}]*font: [^;]*var\(--font-sans\)/);
  });

  it("the focus ring is the brand's: 2px solid in the focus colour with a 2px offset, and nothing hides it", () => {
    for (const [what, css] of sheets) {
      expect(css, what).toContain(":focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }");
      // No rule takes a focus ring away without drawing the brand's.
      for (const m of css.matchAll(/([^\n{}]*:focus-visible[^{]*)\{([^}]*)\}/g)) {
        if (/outline:\s*(none|0)\b/.test(m[2])) expect(m[2], `${what}: ${m[1]}`).toContain("outline: 2px solid var(--focus)");
      }
    }
  });

  it("buttons and fields have 8px corners, cards and dialogs 12px, and only badges and chips are pills", () => {
    for (const [what, css] of sheets.filter(([w]) => w !== "player")) {
      for (const m of css.matchAll(/\n([^\n{]*)\{([^}]*border-radius: ([^;]+);[^}]*)\}/g)) {
        const [selector, , radius] = [m[1], m[2], m[3].trim()];
        expect(["var(--radius-sm)", "var(--radius-md)", "var(--radius-lg)", "var(--radius-pill)", "inherit", "50%", "0"], `${what}: ${selector}`).toContain(radius);
        if (radius === "var(--radius-pill)") expect(selector, what).toMatch(/\.(tag|chip|badge|dot)\b|progress|meter|mini|\.dp-tick|\.dp-dots/);
      }
    }
  });

  it("table headers are in sentence case: no stylesheet makes text upper case but the name beside the mark", () => {
    for (const [what, css] of sheets) {
      const upper = [...css.matchAll(/\n([^\n{]*)\{[^}]*text-transform: uppercase/g)].map((m) => m[1].trim());
      expect(upper.filter((s) => s !== ".brand" && !s.startsWith(".dp-p-kicker")), what).toEqual([]);
    }
  });

  it("motion stops under reduced motion wherever something moves", () => {
    for (const [what, css] of sheets) if (/transition:|animation:/.test(css.replace(/transition: none/g, ""))) expect(css, what).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
