// The player's state machine: which screen is showing, which chapters have been seen and
// whether autoplay is running. Pure functions with no DOM, timers or storage, so the
// whole flow is tested without a browser; main.ts draws whatever state this returns.
//
// Chapters and steps are addressed by position (0-based here, 1-based in links), never
// by id. "Seen" lives in memory only and is lost when the page closes.
import type { PageTour } from "../page.ts";

export type Screen =
  | { kind: "cover" }
  | { kind: "menu" }
  | { kind: "step"; chapter: number; step: number }
  | { kind: "chapter-end"; chapter: number }
  | { kind: "end" };

export type State = { screen: Screen; seen: boolean[]; missPulse: number; autoplay: "off" | "running" | "paused" };

export type Action =
  | { type: "start" }
  | { type: "open"; chapter: number }
  | { type: "next" }
  | { type: "back" }
  | { type: "hit" }
  | { type: "miss" }
  | { type: "tick" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop" }
  | { type: "menu" }
  | { type: "end" }
  | { type: "replay" }
  | { type: "goto"; chapter: number; step: number };

export type StartOptions = {
  /** False under prefers-reduced-motion: autoplay never runs then. Default true. */
  motion?: boolean;
};

const chapters = (t: PageTour) => (Array.isArray(t.chapters) ? t.chapters : []);
const stepCount = (t: PageTour, c: number) => {
  const ch = chapters(t)[c];
  return ch && Array.isArray(ch.steps) ? ch.steps.length : 0;
};
const validStep = (t: PageTour, c: number, s: number) => Number.isInteger(c) && Number.isInteger(s) && c >= 0 && s >= 0 && s < stepCount(t, c);

/** "#chapter-2" or "#chapter-2-step-3", 1-based and in range, as 0-based positions; anything else null. */
export function parseHash(tour: PageTour, hash: string | undefined | null): { chapter: number; step: number } | null {
  if (typeof hash !== "string") return null;
  const m = /^#chapter-([1-9][0-9]{0,3})(?:-step-([1-9][0-9]{0,3}))?$/.exec(hash);
  if (m === null) return null;
  const chapter = Number(m[1]) - 1;
  const step = m[2] === undefined ? 0 : Number(m[2]) - 1;
  return validStep(tour, chapter, step) ? { chapter, step } : null;
}

/** The link for a step, 1-based: "#chapter-N-step-M". */
export function hashFor(chapter: number, step: number): string {
  return `#chapter-${chapter + 1}-step-${step + 1}`;
}

/** Where Start leads: the menu when there is more than one chapter, else the first step. */
function afterCover(tour: PageTour): Screen {
  return chapters(tour).length > 1 ? { kind: "menu" } : { kind: "step", chapter: 0, step: 0 };
}

export function start(tour: PageTour, hash?: string, opts: StartOptions = {}): State {
  const n = chapters(tour).length;
  const seen = Array.from({ length: n }, () => false);
  const autoplay = tour.autoplay?.enabled === true && opts.motion !== false ? "running" : "off";
  const linked = parseHash(tour, hash);
  let screen: Screen;
  if (linked !== null) screen = { kind: "step", ...linked };
  else if (n === 0) screen = { kind: "menu" };
  else if (tour.cover) screen = { kind: "cover" };
  else screen = afterCover(tour);
  return { screen, seen, missPulse: 0, autoplay };
}

export function allSeen(s: State): boolean {
  return s.seen.length > 0 && s.seen.every(Boolean);
}

/** The chapter the chapter-end panel offers next: the first unseen one after `from`, wrapping round; null when all are seen. */
export function nextUnseen(s: State, from: number): number | null {
  const n = s.seen.length;
  for (let k = 1; k <= n; k++) {
    const c = (from + k) % n;
    if (!s.seen[c]) return c;
  }
  return null;
}

/** True when a click on the step should move on: it has a hotspot, or it advances on a click anywhere. */
export function canHit(tour: PageTour, chapter: number, step: number): boolean {
  const st = chapters(tour)[chapter]?.steps[step];
  return !!st && (st.click !== null || st.advance === "anywhere");
}

/** Forward one step; past a chapter's last step, the chapter is seen and its end panel shows (a one-chapter tour goes to the end card). */
function forward(tour: PageTour, s: State, chapter: number, step: number): State {
  if (step + 1 < stepCount(tour, chapter)) return { ...s, screen: { kind: "step", chapter, step: step + 1 } };
  const seen = s.seen.slice();
  seen[chapter] = true;
  const screen: Screen = chapters(tour).length === 1 ? { kind: "end" } : { kind: "chapter-end", chapter };
  return { ...s, seen, screen };
}

/**
 * Autoplay, as decided by the owner on 2026-11-17: it plays inside a chapter, holds on
 * the chapter-end panel (a tick there does nothing), and any manual action by the viewer
 * (Next, Back, the hotspot or a click anywhere, a chapter card, "Next: <chapter>") pauses
 * it until they press Play again. Only reduced motion ("stop") turns it off for good.
 */
const manual = (s: State): State => (s.autoplay === "running" ? { ...s, autoplay: "paused" } : s);

export function reduce(tour: PageTour, s: State, a: Action): State {
  const sc = s.screen;
  switch (a.type) {
    case "start":
      return sc.kind === "cover" ? { ...s, screen: afterCover(tour) } : s;
    case "open":
      // A chapter card or "Next: <chapter>" is a manual action too.
      return validStep(tour, a.chapter, 0) ? { ...manual(s), screen: { kind: "step", chapter: a.chapter, step: 0 } } : s;
    case "goto":
      return validStep(tour, a.chapter, a.step) ? { ...s, screen: { kind: "step", chapter: a.chapter, step: a.step } } : s;
    case "next":
      if (sc.kind === "cover") return reduce(tour, s, { type: "start" });
      if (sc.kind !== "step") return s;
      return forward(tour, manual(s), sc.chapter, sc.step);
    case "hit":
      if (sc.kind !== "step" || !canHit(tour, sc.chapter, sc.step)) return s;
      return forward(tour, manual(s), sc.chapter, sc.step);
    case "back":
      if (sc.kind === "step") return sc.step > 0 ? { ...manual(s), screen: { kind: "step", chapter: sc.chapter, step: sc.step - 1 } } : s;
      if (sc.kind === "chapter-end") return { ...manual(s), screen: { kind: "step", chapter: sc.chapter, step: stepCount(tour, sc.chapter) - 1 } };
      return s;
    case "miss":
      return sc.kind === "step" ? { ...s, missPulse: s.missPulse + 1 } : s;
    case "tick":
      // Autoplay moves only inside a chapter and holds on its end panel.
      if (s.autoplay !== "running" || sc.kind !== "step") return s;
      return forward(tour, s, sc.chapter, sc.step);
    case "pause":
      return s.autoplay === "running" ? { ...s, autoplay: "paused" } : s;
    case "resume":
      return s.autoplay === "paused" ? { ...s, autoplay: "running" } : s;
    case "stop":
      return s.autoplay === "off" ? s : { ...s, autoplay: "off" };
    case "menu":
      return chapters(tour).length > 0 ? { ...s, screen: { kind: "menu" } } : s;
    case "end":
      return allSeen(s) ? { ...s, screen: { kind: "end" } } : s;
    case "replay":
      return validStep(tour, 0, 0) ? { ...s, screen: { kind: "step", chapter: 0, step: 0 } } : s;
  }
}
