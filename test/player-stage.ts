// The tour player's stage, as a list of rules: the tour's own look, which the brand restyle
// leaves as 0.1.53 wrote it. A rule belongs to the stage when any selector of it names a part
// of the stage: the stage and its frame, the picture and its view, the missing-picture
// placeholder, the dim layer and its hole, the hotspot (ring, note, bubble, layer), the card
// and its parts (header, body, buttons, notch, logo, the progress bar), the scrim and the
// always-on button, or one of the stage's own animations. Rules inside @media blocks count too
// (their media query is part of the rule), and so are indented rules.

/** A rule: its at-rule context ("" at the top), its selector and its body, each trimmed and with single spaces. */
export interface Rule { context: string; selector: string; body: string }

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Every rule of a stylesheet, comments taken out, @media and @supports blocks opened, @keyframes kept whole. */
export function rulesOf(css: string, context = ""): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    const head = squash(text.slice(i, open));
    let depth = 1;
    let j = open + 1;
    for (; j < text.length && depth > 0; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") depth--;
    }
    const body = text.slice(open + 1, j - 1);
    if (/^@(media|supports)\b/.test(head)) out.push(...rulesOf(body, squash(`${context} ${head}`)));
    else out.push({ context, selector: head, body: squash(body) });
    i = j;
  }
  return out;
}

const STAGE_PART = /\.dp-(?:stage|frame|view|shot|missing|dim|hole|layer|ring|note|bubble|card|c-[a-z]+|notch|ghost|btn|logo|p-[a-z]+|actions|bar|bar-fill|scrim|cta)(?![\w-])/;

/** Whether a rule styles the stage: one of its selectors names a stage part, or it is one of the stage's animations. */
export function isStageRule(r: Rule): boolean {
  if (r.selector.startsWith("@keyframes ")) return r.selector.startsWith("@keyframes dp-");
  return r.selector.split(",").some((s) => STAGE_PART.test(s));
}

/** The stage's rules of a stylesheet, one string per rule, in order. */
export function stageRules(css: string): string[] {
  return rulesOf(css).filter(isStageRule).map((r) => `${r.context ? r.context + " | " : ""}${r.selector} { ${r.body} }`);
}

/**
 * The rules 0.1.54 adds to the stage, and nothing else: they keep the stage as 0.1.53 drew it
 * now that the chrome around it follows the brand. The stage's font, text colour and focus
 * ring were inherited from the page in 0.1.53, and the frame's edge and shadow colours
 * (--line, --shade) were the page's; the chrome's are the brand's now, so the stage sets 0.1.53's values for itself.
 */
export const STAGE_ADDITIONS = [
  '.dp-stage { font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: #e7e9ee; --line: rgba(255, 255, 255, .08); --shade: rgba(0, 0, 0, .34); }',
  '.dp[data-scheme="light"] .dp-stage { color: #1f232a; --line: rgba(20, 24, 32, .09); --shade: rgba(24, 28, 36, .14); }',
  ".dp-stage :focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }",
];
