// Where the always-on button goes on a step. Pure geometry, so it is tested without a
// browser (test/player-layout.test.ts).

/** A box in the picture's displayed pixels: left, top, right, bottom. */
export type Rect = { x0: number; y0: number; x1: number; y1: number };
export type Corner = { left: boolean; bottom: boolean };

/** Room kept between the button and the card, so the card's pointer and shadow stay clear too. */
export const CTA_CARD_GAP = 8;
/** Half the side of the square kept clear around the click hotspot (the ring is 30 px, its pulse a little more). */
export const HOTSPOT_HALF = 22;

const CORNERS: Corner[] = [
  { left: false, bottom: false },
  { left: true, bottom: false },
  { left: false, bottom: true },
  { left: true, bottom: true },
];

const hits = (a: Rect | null, b: Rect, gap = 0) => a !== null && b.x0 < a.x1 + gap && b.x1 > a.x0 - gap && b.y0 < a.y1 + gap && b.y1 > a.y0 - gap;

/** The button's box in a W x H picture at `corner`, `inset` pixels from the edges. */
export function ctaBox(W: number, H: number, w: number, h: number, inset: number, corner: Corner): Rect {
  const x0 = corner.left ? inset : W - inset - w;
  const y0 = corner.bottom ? H - inset - h : inset;
  return { x0, y0, x1: x0 + w, y1: y0 + h };
}

/** The square kept clear around a hotspot at (x, y) in displayed pixels, `zoom` its scale. */
export function hotspotBox(x: number, y: number, zoom = 1): Rect {
  const half = Math.max(HOTSPOT_HALF, 15 * zoom + 7);
  return { x0: x - half, y0: y - half, x1: x + half, y1: y + half };
}

/**
 * The corner for a `w` x `h` button in a W x H picture: top right as before, then top
 * left, bottom right and bottom left. It never overlaps the card (with CTA_CARD_GAP to
 * spare). Among the corners clear of the card it takes the first that is also clear of
 * every box in `avoid` (the hotspot, then the spotlight); failing that, the first clear of
 * as many of them as possible, in that order of importance. Null when every corner would
 * touch the card: the caller then docks the card under the picture, where it cannot meet
 * the button.
 */
export function ctaCorner(W: number, H: number, w: number, h: number, inset: number, card: Rect | null, avoid: (Rect | null)[]): Corner | null {
  const clear = CORNERS.filter((c) => !hits(card, ctaBox(W, H, w, h, inset, c), CTA_CARD_GAP));
  if (clear.length === 0) return null;
  for (let n = avoid.length; n > 0; n--) {
    const found = clear.find((c) => avoid.slice(0, n).every((a) => !hits(a, ctaBox(W, H, w, h, inset, c))));
    if (found) return found;
  }
  return clear[0];
}
