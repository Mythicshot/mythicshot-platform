// A tour's own look is the author's data, and the restyle moves only the player's chrome to the
// brand: the theme of a published tour reaches the page untouched, the player applies it as
// 0.1.53 did (the accent and its default, the colour on the accent, the card style deciding the
// scheme, an explicit backdrop, the automatic backdrop's two page colours), and every rule of the
// stage (test/player-stage.ts) is 0.1.53's to the byte.
import { describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { pageHtml, pageTour, type PageData } from "../src/page.ts";
import { PLAYER_CSS, PLAYER_JS } from "../src/player/assets.ts";
import { clone, fixtures, send, sha256Hex, uploadTour } from "./bundle.ts";
import { STAGE_ADDITIONS, isStageRule, rulesOf, stageRules } from "./player-stage.ts";

/** Themes as authors set them, the default accent among them. */
const THEMES = [
  { card_style: "dark", accent: "#5dcaa5", hotspot: "pulse", progress_bar: true, backdrop: "auto", spotlight_soft: true },
  { card_style: "light", accent: "#ff3366", hotspot: "dot", progress_bar: false, backdrop: "#123456", spotlight_soft: false },
  { card_style: "compact", accent: "#ffd400", hotspot: "none", progress_bar: true, backdrop: "auto", spotlight_soft: true },
  { card_style: "auto", accent: "#1a73e8", hotspot: "pulse", progress_bar: true, backdrop: "#fafafa", spotlight_soft: true },
] as const;

const dataOf = (html: string): PageData => JSON.parse(/<script type="application\/json" id="tour">([^<]*)<\/script>/.exec(html)![1]);

describe("a tour's theme", () => {
  it("reaches the page exactly as the author set it, for every card style, accent and backdrop", () => {
    for (const theme of THEMES) {
      const snapshot = { ...clone(fixtures.v1), title: "Themed", spotlight_dim: null, theme, zoom: { enabled: true, percent: 118 }, cover: { title: "Cover", body: "", button: "Start", logo: null }, cta: null, end: null, autoplay: { enabled: false, seconds: 5 }, chapters: [] };
      const tour = pageTour(snapshot);
      expect(tour.theme, theme.accent).toEqual(theme);
      expect(dataOf(pageHtml(tour, "")).tour.theme, theme.accent).toEqual(theme);
    }
  });

  it("a published tour's page carries the theme its upload set, unchanged, with a non-default accent", async () => {
    const { deps } = await makeDeps();
    const owner = await seedAccount(deps);
    const manifest = clone(fixtures.v3) as Record<string, any>;
    manifest.theme = { ...manifest.theme, accent: "#e0457b", card_style: "light", backdrop: "#202a44" };
    const { tour_id } = await uploadTour(deps, owner.token, manifest);
    let r = await send(deps, "POST", `/api/v1/tours/${tour_id}/publish`, { token: owner.token });
    for (let i = 0; r.status === 202 && i < 60; i++) r = await send(deps, "POST", `/api/v1/tours/${tour_id}/publish`, { token: owner.token, headers: { "content-type": "application/json" }, body: JSON.stringify({ publish_id: r.json.publish_id }) });
    expect(r.status, r.text).toBe(200);
    const page = await send(deps, "GET", r.json.url);
    expect(page.status).toBe(200);
    const theme = dataOf(page.text).tour.theme;
    expect([theme.accent, theme.card_style, theme.backdrop]).toEqual(["#e0457b", "light", "#202a44"]);
  });

  it("the player applies it as 0.1.53 did: the accent with its default, the colour on it, the scheme from the card style, an explicit backdrop, and the automatic backdrop from 0.1.53's two page colours", () => {
    for (const line of [
      'const accent = import_tour_core.default.color(theme.accent, "#5dcaa5");',
      'const cardStyle = pick(theme.card_style, ["dark", "light", "compact", "auto"], "dark");',
      'const backdrop = theme.backdrop === "auto" ? null : import_tour_core.default.color(theme.backdrop, null);',
      'css.setProperty("--accent", accent);',
      'css.setProperty("--on-accent", onAccent(accent));',
      'css.setProperty("--accent-soft", "rgba(" + rgb(accent).join(", ") + ", .2)");',
      'return cardStyle === "auto" ? prefersDark.matches ? "dark" : "light" : cardStyle;',
      'const scheme = style() === "dark" ? "dark" : "light";',
      // The automatic backdrop is the tour's look too: a tint of 0.1.53's page colours, not the brand's ground.
      'css.setProperty("--backdrop", backdrop ?? mix(scheme === "light" ? "#eeede8" : "#131518", accent, 0.06));',
    ]) expect(PLAYER_JS, line).toContain(line);
    expect(PLAYER_JS.match(/css\.setProperty\("--backdrop"/g)).toHaveLength(1);
  });

  it("the stage, its frame, the missing-picture placeholder, the hotspot, the card, the always-on button and the progress bar: every rule that styles them, indented and @media ones included, is 0.1.53's to the byte, with only the rules that keep 0.1.53's font, text colour, frame colours and focus ring", async () => {
    const rules = stageRules(PLAYER_CSS);
    // The additions, each once and in order, and they set nothing but what the stage inherited in 0.1.53.
    expect(rules.filter((r) => STAGE_ADDITIONS.includes(r))).toEqual(STAGE_ADDITIONS);
    const kept = rules.filter((r) => !STAGE_ADDITIONS.includes(r));
    // 0.1.53's src/player/player.css, read with the same rule (test/player-stage.ts): 84 rules.
    expect(kept).toHaveLength(84);
    expect(await sha256Hex(new TextEncoder().encode(kept.join(String.fromCharCode(10))))).toBe("568dd7470e77e336fa54976f4522038217d534cf402bad2c4bc2913bb97de9ea");
    // The frame and the placeholder, which sit around the author's screenshot, read in full.
    expect(kept).toContain(".dp-frame { position: relative; overflow: hidden; border-radius: 16px; isolation: isolate; box-shadow: 0 16px 46px var(--shade), 0 0 0 1px var(--line); }");
    expect(kept).toContain(".dp-missing { display: flex; align-items: center; justify-content: center; padding: 16px; background: #1b1f27 repeating-linear-gradient(135deg, rgba(255, 255, 255, .03) 0 14px, transparent 14px 28px); color: #8e97a8; font-size: 13px; line-height: 1.4; text-align: center; }");
    // The stage's rules use no variable of the chrome's but --line and --shade, which the stage sets itself.
    const vars = new Set(rules.flatMap((r) => [...r.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1])));
    expect([...vars].sort()).toEqual(["--accent", "--accent-soft", "--ease", "--line", "--on-accent", "--shade"]);
    for (const name of ["--ease", "--accent", "--on-accent", "--accent-soft"]) {
      const setters = rulesOf(PLAYER_CSS).filter((r) => !isStageRule(r) && new RegExp(`(^|; )${name}:`).test(r.body));
      expect(setters.map((r) => r.selector), name).toEqual(name === "--ease" ? [".dp"] : []);
    }
    expect(PLAYER_CSS).toContain("--ease: cubic-bezier(.22, .8, .26, 1);");
  });
});
