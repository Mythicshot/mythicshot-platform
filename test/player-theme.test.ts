// A tour's own look is the author's data, and the restyle moves only the player's chrome to the
// brand: the theme of a published tour reaches the page untouched, the player applies it as
// 0.1.53 did (the accent and its default, the colour on the accent, the card style deciding the
// scheme, an explicit backdrop), and the stage and card rules are 0.1.53's to the byte.
import { describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { GROUND } from "../src/brand-tokens.ts";
import { pageHtml, pageTour, type PageData } from "../src/page.ts";
import { PLAYER_CSS, PLAYER_JS } from "../src/player/assets.ts";
import { clone, fixtures, send, sha256Hex, uploadTour } from "./bundle.ts";
import { isStageLine } from "./brand-tokens.test.ts";

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

  it("the player applies it as 0.1.53 did: the accent with its default, the colour on it, the scheme from the card style, an explicit backdrop", () => {
    for (const line of [
      'const accent = import_tour_core.default.color(theme.accent, "#5dcaa5");',
      'const cardStyle = pick(theme.card_style, ["dark", "light", "compact", "auto"], "dark");',
      'const backdrop = theme.backdrop === "auto" ? null : import_tour_core.default.color(theme.backdrop, null);',
      'css.setProperty("--accent", accent);',
      'css.setProperty("--on-accent", onAccent(accent));',
      'css.setProperty("--accent-soft", "rgba(" + rgb(accent).join(", ") + ", .2)");',
      'return cardStyle === "auto" ? prefersDark.matches ? "dark" : "light" : cardStyle;',
      'const scheme = style() === "dark" ? "dark" : "light";',
    ]) expect(PLAYER_JS, line).toContain(line);
    // Only the "auto" backdrop, which is the player's page colour, moves: to the brand's ground of the scheme.
    expect(PLAYER_JS).toContain(`css.setProperty("--backdrop", backdrop ?? mix(scheme === "light" ? GROUND.light : GROUND.dark, accent, 0.06));`);
    expect(PLAYER_JS).toContain(`light: "${GROUND.light}"`);
    expect(PLAYER_JS).toContain(`dark: "${GROUND.dark}"`);
  });

  it("the stage and the cards, the tour's own look, are 0.1.53's rules to the byte, and keep 0.1.53's font", async () => {
    const lines = PLAYER_CSS.split("\n").filter(isStageLine);
    expect(lines).toHaveLength(73);
    expect(await sha256Hex(new TextEncoder().encode(lines.join("\n")))).toBe("6e0f41cc9dd202355d8e557aca5bc04de6c3e1553522ef35d1eb109cf90d0723");
    expect(PLAYER_CSS).toContain('\n.dp-stage { font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }\n');
    // Inside the stage and the cards, focus keeps the tour's accent, as before.
    expect(PLAYER_CSS).toContain(".dp-stage :focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }");
  });
});
