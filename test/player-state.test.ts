import { describe, expect, it } from "vitest";
import type { PageTour } from "../src/page.ts";
import { allSeen, canHit, hashFor, nextUnseen, parseHash, reduce, start, type Action, type State } from "../src/player/state.ts";
import fixture from "./fixtures/snapshot.json" with { type: "json" };

const tour = fixture as unknown as PageTour;

function copy(over: Partial<PageTour> = {}): PageTour {
  return { ...JSON.parse(JSON.stringify(tour)), ...over };
}

function run(t: PageTour, s: State, ...actions: Action["type"][]): State {
  return actions.reduce((st, type) => reduce(t, st, { type } as Action), s);
}

const step = (chapter: number, n: number) => ({ kind: "step", chapter, step: n }) as const;
const playing = (t = tour) => start(copy({ ...t, autoplay: { enabled: true, seconds: 5 } }));

describe("player state", () => {
  it("starts on the menu with nothing seen", () => {
    const s = start(tour);
    expect(s).toEqual({ screen: { kind: "menu" }, seen: [false, false], missPulse: 0, autoplay: "off" });
  });

  it("open, next, next reaches the last step and next again ends the chapter and marks it seen", () => {
    let s = reduce(tour, start(tour), { type: "open", chapter: 0 });
    expect(s.screen).toEqual(step(0, 0));
    s = run(tour, s, "next", "next");
    expect(s.screen).toEqual(step(0, 2));
    expect(s.seen).toEqual([false, false]);
    s = run(tour, s, "next");
    expect(s.screen).toEqual({ kind: "chapter-end", chapter: 0 });
    expect(s.seen).toEqual([true, false]);
    // Next does nothing more on the end panel.
    expect(run(tour, s, "next")).toEqual(s);
  });

  it("back on the first step stays put; back from chapter-end returns to the last step", () => {
    const first = reduce(tour, start(tour), { type: "open", chapter: 1 });
    expect(run(tour, first, "back")).toEqual(first);
    const ended = run(tour, first, "next", "next");
    expect(ended.screen).toEqual({ kind: "chapter-end", chapter: 1 });
    const back = run(tour, ended, "back");
    expect(back.screen).toEqual(step(1, 1));
    // The chapter stays seen.
    expect(back.seen).toEqual([false, true]);
  });

  it("hit behaves as next; miss changes only missPulse", () => {
    const s = reduce(tour, start(tour), { type: "open", chapter: 0 });
    expect(run(tour, s, "hit")).toEqual(run(tour, s, "next"));
    const missed = run(tour, s, "miss", "miss");
    expect(missed).toEqual({ ...s, missPulse: 2 });
    // A miss off a step does nothing.
    expect(run(tour, start(tour), "miss")).toEqual(start(tour));
  });

  it("hit on a step with no click does nothing", () => {
    const s = reduce(tour, start(tour), { type: "goto", chapter: 0, step: 2 });
    expect(canHit(tour, 0, 2)).toBe(false);
    expect(run(tour, s, "hit")).toEqual(s);
  });

  it("hit on a step that advances anywhere moves on even without a hotspot", () => {
    const t = copy();
    t.chapters[1].steps[0].click = null;
    const s = reduce(t, start(t), { type: "open", chapter: 1 });
    expect(run(t, s, "hit").screen).toEqual(step(1, 1));
  });

  it("the chapter-end screen leads to the end card only when every chapter is seen", () => {
    let s = run(tour, reduce(tour, start(tour), { type: "open", chapter: 0 }), "next", "next", "next");
    expect(nextUnseen(s, 0)).toBe(1);
    expect(run(tour, s, "end")).toEqual(s);
    s = run(tour, reduce(tour, s, { type: "open", chapter: 1 }), "next", "next");
    expect(allSeen(s)).toBe(true);
    expect(nextUnseen(s, 1)).toBeNull();
    expect(run(tour, s, "end").screen).toEqual({ kind: "end" });
  });

  it("the next unseen chapter wraps round to earlier chapters", () => {
    const s = run(tour, reduce(tour, start(tour), { type: "open", chapter: 1 }), "next", "next");
    expect(nextUnseen(s, 1)).toBe(0);
  });

  it("menu from anywhere keeps the seen ticks", () => {
    const s = run(tour, reduce(tour, start(tour), { type: "open", chapter: 0 }), "next", "next", "next");
    const fromEnd = run(tour, s, "menu");
    expect(fromEnd.screen).toEqual({ kind: "menu" });
    expect(fromEnd.seen).toEqual([true, false]);
    const mid = run(tour, reduce(tour, fromEnd, { type: "open", chapter: 1 }), "menu");
    expect(mid.seen).toEqual([true, false]);
    // From the menu, the end card is reachable once everything is seen.
    const done = run(tour, reduce(tour, mid, { type: "open", chapter: 1 }), "next", "next", "menu", "end");
    expect(done.screen).toEqual({ kind: "end" });
  });

  it("an out-of-range chapter index is ignored", () => {
    const s = start(tour);
    for (const chapter of [-1, 2, 99, 0.5, Number.NaN]) {
      expect(reduce(tour, s, { type: "open", chapter })).toEqual(s);
      expect(reduce(tour, s, { type: "goto", chapter, step: 0 })).toEqual(s);
    }
    expect(reduce(tour, s, { type: "goto", chapter: 0, step: 3 })).toEqual(s);
  });

  it("a tour with a cover starts on it and start leads to the menu, or to the first step when there is one chapter", () => {
    const cover = { title: "Hello", body: "", button: "Start", logo: null };
    const t = copy({ cover });
    const s = start(t);
    expect(s.screen).toEqual({ kind: "cover" });
    expect(run(t, s, "start").screen).toEqual({ kind: "menu" });
    expect(run(t, s, "next").screen).toEqual({ kind: "menu" });
    const one = copy({ cover, chapters: [tour.chapters[0]] });
    expect(run(one, start(one), "start").screen).toEqual(step(0, 0));
    // Start means nothing once past the cover.
    const menu = run(t, s, "start");
    expect(run(t, menu, "start")).toEqual(menu);
  });

  it("a tour of one chapter and no cover starts on its first step and ends on the end card", () => {
    const one = copy({ chapters: [tour.chapters[1]] });
    const s = start(one);
    expect(s.screen).toEqual(step(0, 0));
    const done = run(one, s, "next", "next");
    expect(done.screen).toEqual({ kind: "end" });
    expect(done.seen).toEqual([true]);
  });

  it("a hash of #chapter-2-step-3 starts on that step and #chapter-9 or #x is ignored", () => {
    const t = copy({ cover: { title: "Hello", body: "", button: "Start", logo: null } });
    t.chapters[1].steps.push({ ...t.chapters[1].steps[1], id: "st_000000000000000000000006" });
    expect(start(t, "#chapter-2-step-3").screen).toEqual(step(1, 2));
    expect(start(t, "#chapter-2").screen).toEqual(step(1, 0));
    for (const h of ["#chapter-9", "#x", "", "#chapter-2-step-4", "#chapter-0", "#chapter-02", "#chapter-1-step-0", "#chapter-1-step-1x", "chapter-1"]) {
      expect(start(t, h).screen, h).toEqual({ kind: "cover" });
    }
    expect(parseHash(t, "#chapter-1-step-2")).toEqual({ chapter: 0, step: 1 });
    expect(hashFor(0, 1)).toBe("#chapter-1-step-2");
  });

  it("tick moves forward while autoplay runs and does nothing when paused or off", () => {
    // A link to a step (goto) is not a viewer's click, so autoplay keeps running.
    const on = reduce(tour, playing(), { type: "goto", chapter: 0, step: 0 });
    expect(on.autoplay).toBe("running");
    expect(run(tour, on, "tick").screen).toEqual(step(0, 1));
    const paused = run(tour, on, "pause");
    expect(paused.autoplay).toBe("paused");
    expect(run(tour, paused, "tick")).toEqual(paused);
    const off = reduce(tour, start(tour), { type: "open", chapter: 0 });
    expect(run(tour, off, "tick")).toEqual(off);
    // Not on a step: nothing.
    expect(run(tour, playing(), "tick")).toEqual(playing());
  });

  it("tick on a chapter's last step ends the chapter and holds on its end panel", () => {
    const last = reduce(tour, playing(), { type: "goto", chapter: 1, step: 1 });
    const ended = run(tour, last, "tick");
    expect(ended.screen).toEqual({ kind: "chapter-end", chapter: 1 });
    expect(ended.seen).toEqual([false, true]);
    expect(run(tour, ended, "tick", "tick")).toEqual(ended);
    // Still running on the panel: it holds there, and only the viewer moves on.
    expect(ended.autoplay).toBe("running");
  });

  it("next, back, hit and opening a chapter pause autoplay until Play; ticks do not", () => {
    const on = reduce(tour, playing(), { type: "goto", chapter: 0, step: 1 });
    expect(on.autoplay).toBe("running");
    for (const a of ["next", "back", "hit"] as const) expect(run(tour, on, a).autoplay, a).toBe("paused");
    expect(reduce(tour, on, { type: "open", chapter: 1 }).autoplay).toBe("paused");
    // "Next: <chapter>" on the end panel is an open too.
    const ended = run(tour, reduce(tour, playing(), { type: "goto", chapter: 1, step: 1 }), "tick");
    expect(reduce(tour, ended, { type: "open", chapter: 0 }).autoplay).toBe("paused");
    // Play brings it back, and a tick is not a manual step.
    const resumed = run(tour, on, "next", "resume");
    expect(resumed.autoplay).toBe("running");
    expect(run(tour, resumed, "tick").autoplay).toBe("running");
    // A paused tour does not move on a tick.
    const paused = run(tour, on, "next");
    expect(run(tour, paused, "tick")).toEqual(paused);
  });

  it("pause and resume switch autoplay; stop ends it for good; a tour without autoplay stays off", () => {
    const on = reduce(tour, playing(), { type: "goto", chapter: 0, step: 1 });
    expect(run(tour, on, "pause").autoplay).toBe("paused");
    expect(run(tour, on, "pause", "resume").autoplay).toBe("running");
    expect(run(tour, on, "stop").autoplay).toBe("off");
    expect(run(tour, on, "stop", "resume").autoplay).toBe("off");
    const off = reduce(tour, start(tour), { type: "open", chapter: 0 });
    expect(run(tour, off, "next", "resume").autoplay).toBe("off");
  });

  it("autoplay never starts under reduced motion", () => {
    expect(start(copy({ autoplay: { enabled: true, seconds: 5 } }), undefined, { motion: false }).autoplay).toBe("off");
  });

  it("replay returns to the first chapter's first step with the seen ticks kept", () => {
    const s = run(tour, reduce(tour, start(tour), { type: "open", chapter: 1 }), "next", "next");
    const r = run(tour, s, "replay");
    expect(r.screen).toEqual(step(0, 0));
    expect(r.seen).toEqual([false, true]);
  });

  it("a tour with no chapters stays on the menu and ignores every action", () => {
    const empty = copy({ chapters: [] });
    const s = start(empty, "#chapter-1");
    expect(s.screen).toEqual({ kind: "menu" });
    for (const type of ["start", "next", "back", "hit", "tick", "end", "replay", "menu"] as const) expect(reduce(empty, s, { type } as Action)).toEqual(s);
  });
});
