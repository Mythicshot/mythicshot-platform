import { describe, expect, it } from "vitest";
import { CTA_CARD_GAP, ctaBox, ctaCorner, type Rect } from "../src/player/layout.ts";
import TourCoreModule from "../src/player/vendor/tour-core.js";

// The bundler and Vitest hand over the rules file's CommonJS export as the default export.
const TourCore = TourCoreModule as unknown as {
  placeCard(imgW: number, imgH: number, cardW: number, cardH: number, avoid: Rect | null, placement: string): { x: number; y: number; side: string };
};

const overlap = (a: Rect, b: Rect, gap = 0) => b.x0 < a.x1 + gap && b.x1 > a.x0 - gap && b.y0 < a.y1 + gap && b.y1 > a.y0 - gap;

describe("the always-on button's corner", () => {
  it("stays top right when nothing is there, and moves left for the spotlight as before", () => {
    expect(ctaCorner(1280, 720, 130, 30, 12, null, null)).toEqual({ left: false, bottom: false });
    expect(ctaCorner(1280, 720, 130, 30, 12, null, { x0: 1100, y0: 0, x1: 1280, y1: 100 })).toEqual({ left: true, bottom: false });
  });

  it("at 400 px wide a guide card placed at the top pushes the button to a bottom corner", () => {
    // A 400 x 225 picture; the card is 320 wide at the top, over both top corners.
    const card = { x0: 40, y0: 8, x1: 360, y1: 128 };
    const corner = ctaCorner(400, 225, 118, 26, 9, card, null)!;
    expect(corner).toEqual({ left: false, bottom: true });
    expect(overlap(card, ctaBox(400, 225, 118, 26, 9, corner))).toBe(false);
  });

  it("answers null when every corner would meet the card, so the card docks instead", () => {
    expect(ctaCorner(400, 225, 118, 26, 9, { x0: 8, y0: 8, x1: 392, y1: 217 }, null)).toBeNull();
  });

  it("prefers a corner clear of the spotlight, but never gives up the card for it", () => {
    const card = { x0: 200, y0: 8, x1: 392, y1: 120 }; // over the top right
    const spot = { x0: 0, y0: 0, x1: 150, y1: 60 }; // over the top left
    expect(ctaCorner(400, 300, 118, 26, 9, card, spot)).toEqual({ left: false, bottom: true });
    // Only the left corners are clear of the card and the spotlight covers both: the first is
    // taken even though the spotlight is there.
    const wide = { x0: 140, y0: 8, x1: 392, y1: 292 };
    expect(ctaCorner(400, 300, 118, 26, 9, wide, { x0: 0, y0: 0, x1: 150, y1: 300 })).toEqual({ left: true, bottom: false });
  });

  it("at every width, with cards placed by the shared rules, the button and the card never overlap", () => {
    let checked = 0;
    for (let W = 240; W <= 1600; W += 40) {
      for (const ratio of [16 / 9, 4 / 3, 1, 3 / 4]) {
        const H = Math.round(W / ratio);
        const inset = W <= 640 ? 9 : 12;
        const [bw, bh] = W <= 640 ? [118, 26] : [140, 30];
        const w = Math.min(320, W - 16);
        for (const h of [90, 140, 200]) {
          if (h > H - 16) continue; // such a card docks under the picture
          for (const placement of ["auto", "top", "bottom", "left", "right"]) {
            for (const [sx, sy] of [[0.1, 0.1], [0.5, 0.1], [0.9, 0.1], [0.5, 0.5], [0.1, 0.9], [0.9, 0.9]]) {
              const spot = { x0: sx * W - 40, y0: sy * H - 20, x1: sx * W + 40, y1: sy * H + 20 };
              const p = TourCore.placeCard(W, H, w, h, spot, placement);
              if (p.side === "docked") continue;
              const card = { x0: p.x, y0: p.y, x1: p.x + w, y1: p.y + h };
              const corner = ctaCorner(W, H, bw, bh, inset, card, spot);
              checked++;
              if (corner === null) continue; // the player docks the card: nothing left to overlap
              expect(overlap(card, ctaBox(W, H, bw, bh, inset, corner), CTA_CARD_GAP), `${W}x${H} ${placement} ${sx},${sy}`).toBe(false);
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});
