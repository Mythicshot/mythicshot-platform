// The hosted player: reads the page's #tour block, then draws the cover, the chapter
// menu, steps with their spotlight, notes, hotspot and card, the chapter-end panel and
// the end card, driven by the state machine in state.ts.
//
// Rules shared with the recorder's preview (card placement, zoom, bold text, text
// clean-up, safe links, colours and numbers) come from the vendored tour-core.js, so the
// two players place, zoom and filter alike. The drawing here is the hosted player's own.
//
// Every string reaches the page as a text node; links pass the shared link rule and open
// in a new tab with no opener and no referrer; colours pass the shared colour rule and
// are set through the CSSOM, never as markup. Nothing is stored and nothing is sent: no
// cookie, no storage, no network request but the tour's own images.
import type { PageChapter, PageData, PageStep, PageTour } from "../page.ts";
import { allSeen, canHit, hashFor, nextUnseen, parseHash, reduce, start, type Action, type Screen, type State } from "./state.ts";
import { ctaCorner, hotspotBox, type Rect } from "./layout.ts";
import TourCore from "./vendor/tour-core.js";

type Box4 = [number, number, number, number];
type Pt = [number, number];
type Avoid = { x0: number; y0: number; x1: number; y1: number };
type Zoomed = { k: number; tx: number; ty: number };
/** `picked` is true when the card points at a spot chosen for it (anchor "point"), not the hotspot. */
type CardInfo = { title: string; body: string; next: string; point: Pt | null; picked: boolean; placement: string; caption: boolean };
type Via = "" | "back" | "next" | "hotspot" | "key" | "auto" | "menu" | "open";

const SVG = "http://www.w3.org/2000/svg";
const IMAGE_KEY = /^p\/[0-9a-f]{32}\.(png|jpg)$/;
/**
 * A restricted tour's page (src/restricted.ts) gives as its base the tour's own path on this
 * same origin, and its pictures as `v/` names, which only the route that checks the viewer
 * serves (/t/<slug>/v/<name>). A `v/` name is taken only with such a base, never with "" or a
 * public image base, so a public page can never ask for one.
 */
const RESTRICTED_BASE = /^\/t\/[a-z2-7]{10}$/;
const RESTRICTED_KEY = /^v\/[0-9a-f]{32}\.(png|jpg)$/;
const ZOOM_MS = 550;
const FADE_MS = 400;
const ENTER_MS = 280;

// ---- Small helpers -------------------------------------------------------------------

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => ((allowed as readonly unknown[]).includes(v) ? (v as T) : fallback);
const line = (v: unknown, max: number) => TourCore.cleanText(v, max, false);
const para = (v: unknown, max: number) => TourCore.cleanText(v, max, true);
const pct = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? Math.min(100, Math.max(0, v)) : null);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function svgEl(name: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS(SVG, name);
  for (const k of Object.keys(attrs)) e.setAttribute(k, String(attrs[k]));
  return e;
}

function button(cls: string, text: string, onclick: () => void, label?: string): HTMLButtonElement {
  const b = el("button", cls, text);
  b.type = "button";
  if (label) b.setAttribute("aria-label", label);
  b.addEventListener("click", onclick);
  return b;
}

type Link = { label: string; url: string };
function link(v: unknown): Link | null {
  const l = obj(v);
  const label = l ? line(l.label, 24) : "";
  const url = l ? TourCore.safeUrl(l.url) : null;
  return label && url ? { label, url } : null;
}

/** A link that leaves the tour: a checked https:// address, a new tab, no opener and no referrer. */
function linkEl(l: Link, cls: string): HTMLAnchorElement {
  const a = el("a", cls, l.label);
  a.href = l.url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.referrerPolicy = "no-referrer";
  return a;
}

function rgb(hex: string): number[] {
  return [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
}
function mix(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return "#" + x.map((v, k) => ("0" + Math.round(v + (y[k] - v) * t).toString(16)).slice(-2)).join("");
}
function luminance(hex: string): number {
  const c = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** Dark or light text on the accent, whichever contrasts more. */
function onAccent(accent: string): string {
  const L = luminance(accent);
  const DARK = "#10201a";
  return contrast(L, luminance(DARK)) >= contrast(L, 1) ? DARK : "#ffffff";
}

// ---- Reading the page ------------------------------------------------------------------

function readData(): PageData | null {
  const block = document.getElementById("tour");
  if (!block) return null;
  try {
    const d = JSON.parse(block.textContent || "") as unknown;
    const o = obj(d);
    const tour = o && obj(o.tour);
    if (!o || !tour || !Array.isArray(tour.chapters)) return null;
    return { base: typeof o.base === "string" ? o.base : "", tour: tour as unknown as PageTour };
  } catch {
    return null;
  }
}

function boot(): void {
  const root = document.getElementById("player");
  const data = readData();
  if (!root || !data) return;
  // Steps that are not objects, and chapters left with no steps, are dropped.
  const chapters: PageChapter[] = data.tour.chapters
    .filter((c) => obj(c) !== null)
    .map((c) => ({ ...c, steps: (Array.isArray(c.steps) ? c.steps : []).filter((s) => obj(s) !== null) }))
    .filter((c) => c.steps.length > 0);
  const tour: PageTour = { ...data.tour, chapters };
  const base = data.base === "" || /^https:\/\/[^\s"'<>\\]+$/.test(data.base) ? data.base : null;
  player(root, tour, base);
}

// ---- The player ------------------------------------------------------------------------

function player(root: HTMLElement, tour: PageTour, base: string | null): void {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
  /** The narrow layout of player.css, where the always-on button sits 9 px from the edges instead of 12. */
  const narrow = window.matchMedia("(max-width: 640px)");
  const ms = (n: number) => (reduced.matches ? 0 : n);

  const theme = obj(tour.theme) ?? {};
  const zoomSet = obj(tour.zoom) ?? {};
  const playSet = obj(tour.autoplay) ?? {};
  const cardStyle = pick(theme.card_style, ["dark", "light", "compact", "auto"] as const, "dark");
  const accent = TourCore.color(theme.accent, "#5dcaa5");
  const hotspot = pick(theme.hotspot, ["pulse", "dot", "none"] as const, "pulse");
  const showBar = bool(theme.progress_bar, true);
  const soft = bool(theme.spotlight_soft, true);
  const backdrop = theme.backdrop === "auto" ? null : TourCore.color(theme.backdrop, null);
  const zoomOn = bool(zoomSet.enabled, true);
  const zoomK = TourCore.num(zoomSet.percent, 105, 140, 118) / 100;
  const playEnabled = bool(playSet.enabled, false);
  const playMs = TourCore.num(playSet.seconds, 2, 20, 5) * 1000;
  const dimStrength = TourCore.num(tour.spotlight_dim, 10, 90, 60) / 100;

  const title = line(tour.title, 200) || "Tour";
  const coverSet = obj(tour.cover);
  const cover =
    coverSet && line(coverSet.title, 80)
      ? {
          title: line(coverSet.title, 80),
          body: para(coverSet.body, 200),
          button: line(coverSet.button, 24) || "Start",
          logo: typeof coverSet.logo === "string" ? imageUrl(coverSet.logo) : null,
        }
      : null;
  const cta = link(tour.cta);
  const endSet = obj(tour.end);
  const end = endSet ? { text: para(endSet.text, 200), primary: link(endSet.primary), secondary: link(endSet.secondary), replay: bool(endSet.replay, true) } : null;
  const chapters = tour.chapters;
  const chapterTitle = (c: number) => line(chapters[c]?.title, 200) || `Chapter ${c + 1}`;

  function imageUrl(key: unknown): string | null {
    if (base === null || typeof key !== "string") return null;
    return (RESTRICTED_BASE.test(base) ? RESTRICTED_KEY : IMAGE_KEY).test(key) ? base + "/" + key : null;
  }

  // ---- Theme ----
  const css = root.style;
  css.setProperty("--accent", accent);
  css.setProperty("--on-accent", onAccent(accent));
  css.setProperty("--accent-soft", "rgba(" + rgb(accent).join(", ") + ", .2)");
  function style(): "dark" | "light" | "compact" {
    return cardStyle === "auto" ? (prefersDark.matches ? "dark" : "light") : cardStyle;
  }
  function applyScheme(): void {
    // Compact follows Light's colours, as the recorder's preview does.
    const scheme = style() === "dark" ? "dark" : "light";
    root.dataset.scheme = scheme;
    // "auto" is a calm tint of the page colour toward the accent.
    css.setProperty("--backdrop", backdrop ?? mix(scheme === "light" ? "#eeede8" : "#131518", accent, 0.06));
  }
  applyScheme();
  root.classList.add("dp");

  // ---- The page's parts ----
  const head = el("header", "dp-head");
  const headText = el("div", "dp-head-text");
  const tourName = el("p", "dp-tour", title);
  const chapterName = el("p", "dp-chapter");
  headText.append(tourName, chapterName);
  const ctaEl = cta ? linkEl(cta, "dp-cta") : null;
  const chaptersBtn = button("dp-chapters", "Chapters", () => act({ type: "menu" }, "menu"));
  chaptersBtn.setAttribute("aria-label", "Chapters menu");
  head.append(headText, chaptersBtn);

  const bodyEl = el("div", "dp-body");

  const menu = el("section", "dp-menu");
  menu.setAttribute("aria-labelledby", "dp-menu-title");
  const menuTitle = el("h1", "dp-menu-title", title);
  menuTitle.id = "dp-menu-title";
  menuTitle.tabIndex = -1;
  const meterText = el("p", "dp-meter-text");
  const meter = el("div", "dp-meter");
  meter.setAttribute("aria-hidden", "true");
  const lead = el("p", "dp-lead", "Pick what you want to see. You can come back here any time.");
  const list = el("ol", "dp-list");
  const toEnd = button("dp-to-end", "See the end of the tour", () => act({ type: "end" }, "open"));
  menu.append(menuTitle, meterText, meter, lead, list, toEnd);
  const chapterCards: HTMLButtonElement[] = [];
  const ticks: HTMLElement[] = [];
  const segments: HTMLElement[] = [];
  chapters.forEach((ch, c) => {
    const li = el("li");
    const b = button("dp-chapter-card", "", () => act({ type: "open", chapter: c }, "open"));
    const num = el("span", "dp-num", String(c + 1).padStart(2, "0"));
    num.setAttribute("aria-hidden", "true");
    const text = el("span", "dp-card-text");
    text.append(el("span", "dp-card-title", chapterTitle(c)));
    const desc = para(ch.description, 300);
    if (desc) text.append(el("span", "dp-card-desc", desc));
    const metaRow = el("span", "dp-card-meta");
    const n = ch.steps.length;
    metaRow.append(el("span", "dp-steps", n === 1 ? "1 step" : `${n} steps`));
    const tick = el("span", "dp-tick");
    const tickIcon = svgEl("svg", { viewBox: "0 0 16 16", width: 14, height: 14, "aria-hidden": "true", focusable: "false" });
    tickIcon.append(svgEl("path", { d: "M3.5 8.5l3 3 6-7", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" }));
    tick.append(tickIcon, el("span", "", "seen"));
    metaRow.append(tick);
    text.append(metaRow);
    b.append(num, text);
    li.append(b);
    list.append(li);
    chapterCards.push(b);
    ticks.push(tick);
    const seg = el("span");
    meter.append(seg);
    segments.push(seg);
  });

  const endCard = el("section", "dp-endcard");
  endCard.setAttribute("aria-labelledby", "dp-end-title");
  const endTitle = el("h1", "dp-end-title", "That's the whole tour");
  endTitle.id = "dp-end-title";
  endTitle.tabIndex = -1;
  endCard.append(endTitle);
  if (end?.text) endCard.append(el("p", "dp-end-text", end.text));
  const endActions = el("div", "dp-actions");
  if (end?.primary) endActions.append(linkEl(end.primary, "dp-btn"));
  if (end?.secondary) endActions.append(linkEl(end.secondary, "dp-ghost"));
  if (end?.replay) endActions.append(button("dp-ghost", "Replay", () => act({ type: "replay" }, "open"), "Replay the tour"));
  const watchAgain = button("dp-ghost", "Watch a chapter again", () => act({ type: "menu" }, "menu"));
  endActions.append(watchAgain);
  endCard.append(endActions);

  const stage = el("div", "dp-stage");
  // While a new card is still entering (and inert), focus rests here: a stable, visible
  // region, so a Tab or a second Enter in that moment never starts again from the top.
  stage.tabIndex = -1;
  stage.setAttribute("role", "region");
  stage.setAttribute("aria-label", "Tour");
  const frame = el("div", "dp-frame");
  const view = el("div", "dp-view");
  const shot = el("img", "dp-shot");
  shot.alt = "";
  shot.decoding = "async";
  const missing = el("div", "dp-missing", "This step's picture could not be loaded.");
  missing.hidden = true;
  const dim = el("div", "dp-dim");
  dim.hidden = true;
  const hole = el("div", "dp-hole");
  dim.append(hole);
  const layer = el("div", "dp-layer");
  layer.setAttribute("aria-live", "polite");
  const ring = button("dp-ring", "", () => act({ type: "hit" }, "hotspot"), "Next step");
  ring.hidden = true;
  view.append(shot, missing, dim, layer, ring);
  const bar = el("div", "dp-bar");
  const barFill = el("div", "dp-bar-fill");
  bar.append(barFill);
  bar.hidden = !showBar;
  bar.setAttribute("aria-hidden", "true");
  const scrim = el("div", "dp-scrim");
  frame.append(view, bar, scrim);
  // The always-on button sits in the picture's top corner on a step (moving to the other
  // corner when the spotlight is there) and at the top of the chapter menu.
  if (ctaEl) frame.append(ctaEl);
  const card = el("div", "dp-card");
  card.setAttribute("role", "group");
  card.hidden = true;
  stage.append(frame, card);

  bodyEl.append(menu, endCard, stage);

  const foot = el("footer", "dp-foot");
  const hint = el("p", "dp-hint", "Click the highlighted spot, or use the arrow keys");
  const where = el("div", "dp-where");
  const whereText = el("span", "dp-where-text");
  const dots = el("span", "dp-dots");
  dots.setAttribute("aria-hidden", "true");
  for (let c = 0; c < chapters.length; c++) dots.append(el("span"));
  where.append(whereText, dots);
  const playBtn = button("dp-play", "Pause", () => togglePlay());
  playBtn.hidden = true;
  foot.append(hint, where, playBtn);

  const status = el("div", "dp-sr");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("role", "status");

  root.replaceChildren(head, bodyEl, foot, status);
  ring.classList.toggle("pulse", hotspot === "pulse");
  if (hotspot === "none") {
    // No visible hotspot: it still takes a click, while keyboard and screen reader users use Next.
    ring.classList.add("ghost");
    ring.tabIndex = -1;
    ring.setAttribute("aria-hidden", "true");
  }

  // ---- State ----
  let state: State = start(tour, location.hash, { motion: !reduced.matches });
  let drawnKey = "";
  let shownMiss = state.missPulse;
  let boxOn = false;
  let dimTimer = 0;
  let enterTimer = 0;
  let safetyTimer = 0;
  let missTimer = 0;
  let pendingEnter = false;
  let cardKind: "" | "guide" | "compact" | "panel" = "";
  let cardData: CardInfo | null = null;
  let backBtn: HTMLButtonElement | null = null;
  let nextBtn: HTMLButtonElement | null = null;
  let defaultFocus: HTMLElement | null = null;
  let pendingFocus: HTMLElement | null = null;
  let announced = "";
  let lastChapter = 0;
  let preloaded: Record<string, HTMLImageElement> = {};
  let nav: { via: Via; from: Element | null; force: boolean } = { via: "", from: null, force: false };

  const screen = (): Screen => state.screen;
  /** The step whose picture shows: the current one, the chapter's last on its end panel, the first on the cover. */
  function pictured(): { c: number; s: number; step: PageStep } | null {
    const sc = screen();
    let c: number, s: number;
    if (sc.kind === "step") [c, s] = [sc.chapter, sc.step];
    else if (sc.kind === "chapter-end") [c, s] = [sc.chapter, chapters[sc.chapter].steps.length - 1];
    else if (sc.kind === "cover") [c, s] = [0, 0];
    else return null;
    const step = chapters[c]?.steps[s];
    return step ? { c, s, step } : null;
  }
  const onStep = () => screen().kind === "step";

  function box(st: PageStep): Box4 | null {
    const a = obj(st.spotlight);
    const b = a && [pct(a.x), pct(a.y), pct(a.w), pct(a.h)];
    return b && !b.includes(null) && (b[2] as number) > 0 && (b[3] as number) > 0 ? (b as Box4) : null;
  }
  function click(st: PageStep): Pt | null {
    const c = obj(st.click);
    const x = c && pct(c.x);
    const y = c && pct(c.y);
    return x === null || y === null || !c ? null : [x, y];
  }
  /** The step's guide card, or the plain caption box when it has none. */
  function stepCard(st: PageStep): CardInfo {
    const c = obj(st.card);
    if (c) {
      const t = line(c.title, 80);
      const b = para(c.body, 300);
      if (t || b) {
        const anchor = pick(c.anchor, ["hotspot", "point", "none"] as const, "hotspot");
        let point: Pt | null = null;
        if (anchor === "point") {
          const p = obj(c.point);
          const x = p && pct(p.x);
          const y = p && pct(p.y);
          point = p && x !== null && y !== null ? [x, y] : null;
        } else if (anchor === "hotspot") point = click(st);
        return { title: t, body: b, next: line(c.next_label, 24) || "Next", point, picked: anchor === "point" && !!point, placement: pick(c.placement, ["auto", "top", "bottom", "left", "right"] as const, "auto"), caption: false };
      }
    }
    return { title: "", body: para(st.caption, 300), next: "Next", point: click(st), picked: false, placement: "auto", caption: true };
  }

  function size(): { w: number; h: number } {
    const e = missing.hidden ? shot : missing;
    return { w: e.clientWidth, h: e.clientHeight };
  }

  // ---- The picture ----
  function showMissing(): void {
    const p = pictured();
    const st = p?.step;
    const ar = st && st.width > 0 && st.height > 0 ? st.width / st.height : 1.6;
    const w = Math.max(160, Math.min(bodyEl.clientWidth - 32, (window.innerHeight - 170) * ar));
    missing.style.width = Math.round(w) + "px";
    missing.style.height = Math.round(w / ar) + "px";
    missing.hidden = false;
    shot.hidden = true;
  }
  function setImage(src: string | null): void {
    if (!src) {
      shot.removeAttribute("src");
      showMissing();
      return;
    }
    if (shot.getAttribute("src") !== src) shot.src = src;
  }
  const imageReady = () => !missing.hidden || (shot.complete && shot.naturalWidth > 0);
  shot.addEventListener("load", () => {
    missing.hidden = true;
    shot.hidden = false;
    layout(true);
  });
  shot.addEventListener("error", () => {
    showMissing();
    layout(true);
  });

  // ---- Zoom, spotlight and notes ----
  function zoomFor(st: PageStep, sz: { w: number; h: number }): Zoomed {
    if (!onStep()) return { k: 1, tx: 0, ty: 0 };
    const on = st.zoom === true || (st.zoom !== false && zoomOn);
    const b = box(st);
    const f: Pt | null = b ? [b[0] + b[2] / 2, b[1] + b[3] / 2] : click(st);
    if (!on || !f || !sz.w) return { k: 1, tx: 0, ty: 0 };
    const o = TourCore.zoomOffset(sz.w, sz.h, (f[0] / 100) * sz.w, (f[1] / 100) * sz.h, zoomK);
    return { k: zoomK, tx: o.tx, ty: o.ty };
  }
  /** The box a card must not cover, in displayed pixels after zoom: the spotlight, else a 44 px square on the anchor, else nothing. */
  function avoidFor(st: PageStep, z: Zoomed, sz: { w: number; h: number }, c: CardInfo | null): Avoid | null {
    const b = box(st);
    const at = (px: number, py: number): Pt => [(px / 100) * sz.w * z.k + z.tx, (py / 100) * sz.h * z.k + z.ty];
    let r: Avoid;
    if (b) {
      const p0 = at(b[0], b[1]);
      const p1 = at(b[0] + b[2], b[1] + b[3]);
      r = { x0: p0[0], y0: p0[1], x1: p1[0], y1: p1[1] };
    } else if (c && c.point) {
      const p = at(c.point[0], c.point[1]);
      r = { x0: p[0] - 22, y0: p[1] - 22, x1: p[0] + 22, y1: p[1] + 22 };
    } else return null;
    r = { x0: Math.max(0, r.x0), y0: Math.max(0, r.y0), x1: Math.min(sz.w, r.x1), y1: Math.min(sz.h, r.y1) };
    return r.x1 > r.x0 && r.y1 > r.y0 ? r : null;
  }
  /** The square around the click hotspot, in displayed pixels after zoom, or null when the step has none. */
  function hotspotFor(st: PageStep, z: Zoomed, sz: { w: number; h: number }): Rect | null {
    const c = onStep() ? click(st) : null;
    if (!c) return null;
    return hotspotBox((c[0] / 100) * sz.w * z.k + z.tx, (c[1] / 100) * sz.h * z.k + z.ty, z.k);
  }
  /**
   * A spot picked for the card, in displayed pixels after zoom, while it is on the picture:
   * the card points at it and still keeps clear of the spotlight. Null for the hotspot or no anchor.
   */
  function aimFor(z: Zoomed, sz: { w: number; h: number }, c: CardInfo | null): { x: number; y: number } | null {
    if (!c || !c.picked || !c.point) return null;
    const x = (c.point[0] / 100) * sz.w * z.k + z.tx;
    const y = (c.point[1] / 100) * sz.h * z.k + z.ty;
    return x >= 0 && x <= sz.w && y >= 0 && y <= sz.h ? { x, y } : null;
  }
  const overlaps = (a: Avoid | null, x: number, y: number, w: number, h: number) => !!a && x < a.x1 && x + w > a.x0 && y < a.y1 && y + h > a.y0;

  /** The darkening fades in; between two spotlighted steps its bright box glides instead. */
  function drawSpot(st: PageStep | null): void {
    const b = st && onStep() ? box(st) : null;
    window.clearTimeout(dimTimer);
    if (!b) {
      if (boxOn) {
        dim.classList.remove("on");
        dimTimer = window.setTimeout(() => (dim.hidden = true), ms(FADE_MS));
      }
      boxOn = false;
      return;
    }
    hole.classList.toggle("soft", soft);
    hole.classList.toggle("glide", boxOn && !dim.hidden && !reduced.matches);
    hole.style.left = b[0] + "%";
    hole.style.top = b[1] + "%";
    hole.style.width = b[2] + "%";
    hole.style.height = b[3] + "%";
    hole.style.boxShadow = soft
      ? `0 0 0 1px rgba(255, 255, 255, .3), 0 0 24px 200vmax rgba(0, 0, 0, ${dimStrength})`
      : `0 0 0 1.5px rgba(255, 255, 255, .5), 0 0 0 200vmax rgba(0, 0, 0, ${dimStrength})`;
    if (!boxOn || dim.hidden) {
      dim.hidden = false;
      dim.classList.remove("on");
      void dim.offsetWidth;
    }
    dim.classList.add("on");
    boxOn = true;
  }

  /** A rounded box whose outline runs out to the tail point on the side facing it. */
  function bubblePath(x: number, y: number, w: number, h: number, tx: number, ty: number): string {
    const r = Math.min(w, h) * 0.18;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const dx = tx - cx;
    const dy = ty - cy;
    const inside = tx > x && tx < x + w && ty > y && ty < y + h;
    const side = inside ? "" : Math.abs(dy) * w >= Math.abs(dx) * h ? (dy > 0 ? "b" : "t") : dx > 0 ? "r" : "l";
    const sx = Math.max(0, Math.min(w * 0.18, w / 2 - r));
    const sy = Math.max(0, Math.min(h * 0.18, h / 2 - r));
    const tail = ` L${tx} ${ty}`;
    let d = `M${x + r} ${y}`;
    if (side === "t") d += ` L${cx - sx} ${y}${tail} L${cx + sx} ${y}`;
    d += ` L${x + w - r} ${y} Q${x + w} ${y} ${x + w} ${y + r}`;
    if (side === "r") d += ` L${x + w} ${cy - sy}${tail} L${x + w} ${cy + sy}`;
    d += ` L${x + w} ${y + h - r} Q${x + w} ${y + h} ${x + w - r} ${y + h}`;
    if (side === "b") d += ` L${cx + sx} ${y + h}${tail} L${cx - sx} ${y + h}`;
    d += ` L${x + r} ${y + h} Q${x} ${y + h} ${x} ${y + h - r}`;
    if (side === "l") d += ` L${x} ${cy + sy}${tail} L${x} ${cy - sy}`;
    d += ` L${x} ${y + r} Q${x} ${y} ${x + r} ${y} Z`;
    return d;
  }

  /** Notes at their percentages, font sizes a share of the displayed image height (cqh), text as text nodes. */
  function drawNotes(st: PageStep | null): void {
    if (!st) {
      layer.replaceChildren();
      return;
    }
    const notes = Array.isArray(st.notes) ? st.notes : [];
    const W = st.width > 0 ? st.width : 100;
    const H = st.height > 0 ? st.height : 100;
    const shapes = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", "aria-hidden": "true", focusable: "false" });
    const texts: HTMLElement[] = [];
    for (const raw of notes) {
      const n = obj(raw);
      if (!n) continue;
      const x = pct(n.x);
      const y = pct(n.y);
      const text = para(n.text, 500);
      if (x === null || y === null || !text) continue;
      const e = el("div", "", text);
      e.style.left = x + "%";
      e.style.top = y + "%";
      const sz = pct(n.size);
      e.style.fontSize = (sz === null || sz <= 0 ? 3 : sz) + "cqh";
      if (n.kind === "bubble") {
        const w = pct(n.w);
        const h = pct(n.h);
        const tail = obj(n.tail);
        let tx = tail ? pct(tail.x) : null;
        let ty = tail ? pct(tail.y) : null;
        if (w === null || h === null || w <= 0 || h <= 0) continue;
        if (tx === null || ty === null) [tx, ty] = [x + w / 2, y + h / 2];
        shapes.append(
          svgEl("path", {
            d: bubblePath((x * W) / 100, (y * H) / 100, (w * W) / 100, (h * H) / 100, (tx * W) / 100, (ty * H) / 100),
            fill: TourCore.color(n.fill, "#ffffff"),
            stroke: TourCore.color(n.color, "#1f2430"),
            "stroke-width": Math.max(2, H / 320),
            "stroke-linejoin": "round",
          }),
        );
        e.className = "dp-bubble";
        e.style.width = w + "%";
        e.style.height = h + "%";
        e.style.color = TourCore.color(n.color, "#1f2430");
      } else if (n.kind === "text") {
        e.className = "dp-note";
        e.style.color = TourCore.color(n.color, "#ffffff");
      } else continue;
      texts.push(e);
    }
    layer.replaceChildren(shapes, ...texts);
  }

  // ---- The card: a guide card or caption box, the compact bar, or a panel ----
  function rich(text: string): HTMLElement {
    const b = el("div", "dp-c-body");
    for (const p of TourCore.parseBold(text)) b.append(p.bold ? el("strong", "", p.text) : document.createTextNode(p.text));
    return b;
  }
  const plain = (text: string) => TourCore.parseBold(text).map((p) => p.text).join("");

  function buildCard(): void {
    window.clearTimeout(enterTimer);
    window.clearTimeout(safetyTimer);
    card.classList.add("now");
    card.classList.remove("in");
    // Until it has entered, the card's controls take neither focus nor clicks.
    card.inert = true;
    pendingFocus = null;
    card.replaceChildren();
    card.style.width = "";
    card.style.left = "";
    card.style.top = "";
    stage.style.paddingBottom = "";
    cardKind = "";
    cardData = null;
    backBtn = null;
    nextBtn = null;
    defaultFocus = null;
    const sc = screen();
    const kids: HTMLElement[] = [];
    let first: HTMLElement | null = null;
    if (sc.kind === "cover" && cover) {
      cardKind = "panel";
      if (cover.logo) {
        const logo = el("img", "dp-logo");
        logo.alt = "";
        // The logo changes the panel's height once it arrives, so the panel is placed again.
        logo.addEventListener("load", () => layout(false));
        logo.addEventListener("error", () => {
          logo.remove();
          layout(false);
        });
        logo.src = cover.logo;
        kids.push(logo);
      }
      const h = el("h2", "dp-p-title", cover.title);
      kids.push(h);
      if (cover.body) kids.push(el("p", "dp-p-body", cover.body));
      first = button("dp-btn", cover.button, () => act({ type: "start" }, "open"));
      const row = el("div", "dp-actions");
      row.append(first);
      kids.push(row);
      card.setAttribute("aria-label", cover.title);
    } else if (sc.kind === "chapter-end") {
      cardKind = "panel";
      const nextC = nextUnseen(state, sc.chapter);
      kids.push(el("p", "dp-p-kicker", "Chapter complete"));
      const h = el("h2", "dp-p-title", chapterTitle(sc.chapter));
      h.tabIndex = -1;
      kids.push(h);
      const row = el("div", "dp-actions");
      if (nextC !== null) {
        first = button("dp-btn", `Next: ${chapterTitle(nextC)}`, () => act({ type: "open", chapter: nextC }, "open"));
      } else {
        first = button("dp-btn", "See the end of the tour", () => act({ type: "end" }, "open"));
      }
      row.append(first, button("dp-ghost", "Chapters", () => act({ type: "menu" }, "menu"), "Back to the chapters menu"));
      kids.push(row);
      card.setAttribute("aria-label", "End of chapter");
    } else if (sc.kind === "step") {
      const st = chapters[sc.chapter].steps[sc.step];
      const n = chapters[sc.chapter].steps.length;
      const c = stepCard(st);
      const compact = style() === "compact" && !c.caption;
      cardKind = compact ? "compact" : "guide";
      cardData = c;
      const back = button("dp-c-back", "‹", () => act({ type: "back" }, "back"), "Back");
      back.disabled = sc.step === 0;
      const count = el("span", "dp-c-count", `${sc.step + 1} of ${n}`);
      const next = button("dp-c-next", c.next, () => act({ type: "next" }, "next"));
      backBtn = back;
      nextBtn = next;
      if (compact) {
        kids.push(back, count, c.body ? rich(c.body) : el("div", "dp-c-body", c.title), next);
      } else {
        if (c.title) kids.push(el("div", "dp-c-title", c.title));
        if (c.body) kids.push(c.caption ? el("div", "dp-c-body", c.body) : rich(c.body));
        const footRow = el("div", "dp-c-foot");
        footRow.append(back, count, next);
        kids.push(footRow, el("span", "dp-notch"));
      }
      first = next;
      card.setAttribute("aria-label", `Step ${sc.step + 1} of ${n}`);
    }
    // A compact tour follows Light's colours, so its panels and caption boxes use the light card.
    const palette = style() === "compact" ? "light" : style();
    card.className = "dp-card now" + (cardKind === "compact" ? " compact" : cardKind ? " " + palette : "") + (cardKind === "panel" ? " panel" : "") + (cardData?.caption ? " caption" : "");
    card.replaceChildren(...kids);
    card.hidden = !cardKind;
    defaultFocus = first;
    pendingEnter = !!cardKind;
    // Should the picture never lay out, the card still enters rather than staying invisible.
    if (cardKind) safetyTimer = window.setTimeout(() => {
      if (pendingEnter) {
        pendingEnter = false;
        enterCard(true);
      }
    }, 1500);
  }

  function enterCard(instant: boolean): void {
    window.clearTimeout(enterTimer);
    window.clearTimeout(safetyTimer);
    if (instant) {
      card.classList.add("now", "in");
      void card.offsetWidth;
      card.classList.remove("now");
    } else card.classList.add("in");
    card.inert = false;
    // Hand focus over only if it is still resting on the stage (or was lost): a viewer who
    // tabbed on meanwhile keeps their place.
    const resting = document.activeElement === stage || !usable(document.activeElement);
    if (pendingFocus && card.contains(pendingFocus) && resting) pendingFocus.focus({ preventScroll: true });
    pendingFocus = null;
  }

  /** Places the card; returns its box over the picture, or null when there is none or it is docked under it. */
  function placeCard(sz: { w: number; h: number }, avoid: Avoid | null, aim: { x: number; y: number } | null, dock = false): Avoid | null {
    if (!cardKind) return null;
    const W = sz.w;
    const H = sz.h;
    const w = cardKind === "compact" ? W - 16 : Math.min(cardKind === "panel" ? 380 : 320, W - 16);
    stage.style.paddingBottom = "";
    card.style.width = w + "px";
    let h = card.offsetHeight;
    let x = 0;
    let y = 0;
    let side: string;
    if (cardKind === "guide" && cardData) {
      const p = TourCore.placeCard(W, H, w, h, avoid, cardData.placement, aim ?? undefined);
      ({ x, y, side } = p);
    } else if (cardKind === "compact") {
      x = 8;
      side = "bottom";
      if (!overlaps(avoid, 8, H - h - 8, w, h + 8)) y = H - h - 8;
      else if (!overlaps(avoid, 8, 8, w, h + 8)) y = 8;
      else side = "docked";
    } else if (h <= H - 16) {
      x = (W - w) / 2;
      y = (H - h) / 2;
      side = "none";
    } else side = "docked";
    if (h > H - 16 || dock) side = "docked";
    if (side === "docked") {
      // No room beside the box: the card goes under the picture at full width.
      card.style.width = W + "px";
      h = card.offsetHeight;
      x = 0;
      y = H + 12;
      stage.style.paddingBottom = h + 12 + "px";
    }
    card.style.left = Math.round(x) + "px";
    card.style.top = Math.round(y) + "px";
    card.classList.toggle("docked", side === "docked");
    const notch = card.querySelector<HTMLElement>(".dp-notch");
    if (notch) {
      const dir = ({ bottom: "up", top: "down", right: "toleft", left: "toright" } as Record<string, string>)[side];
      notch.hidden = !dir || !avoid;
      if (dir && avoid) {
        // The notch points at the picked spot when there is one, else at the middle of the box.
        const tx = aim ? aim.x : (avoid.x0 + avoid.x1) / 2;
        const ty = aim ? aim.y : (avoid.y0 + avoid.y1) / 2;
        notch.className = "dp-notch " + dir;
        if (dir === "up" || dir === "down") {
          notch.style.top = "";
          notch.style.left = Math.max(16, Math.min(w - 28, tx - x - 6)) + "px";
        } else {
          notch.style.left = "";
          notch.style.top = Math.max(14, Math.min(h - 26, ty - y - 6)) + "px";
        }
      }
    }
    return side === "docked" ? null : { x0: x, y0: y, x1: x + w, y1: y + h };
  }

  /** Geometry for the current state. `animate` is false on resize, so nothing travels. */
  function layout(animate: boolean): void {
    if (stage.hidden) return;
    const sz = size();
    const p = pictured();
    if (!sz.w || !sz.h || !p) return;
    const z = zoomFor(p.step, sz);
    const t = `translate(${z.tx}px, ${z.ty}px) scale(${z.k})`;
    const moved = view.style.transform !== t && !(z.k === 1 && !view.style.transform);
    if (!animate) {
      view.style.transition = "none";
      hole.classList.remove("glide");
    }
    view.style.transform = t;
    const avoid = onStep() ? avoidFor(p.step, z, sz, cardData) : null;
    const aim = avoid && cardKind === "guide" ? aimFor(z, sz, cardData) : null;
    const cardBox = placeCard(sz, avoid, aim);
    if (ctaEl && ctaEl.parentElement === frame && !ctaEl.hidden) {
      // Top right, unless the hotspot, the spotlight or the card is there: then another
      // corner. The button never covers the card or the card the button: if every corner
      // would meet the card, the card docks under the picture instead. It keeps clear of
      // the hotspot first and the spotlight second wherever some corner allows.
      const inset = narrow.matches ? 9 : 12;
      const keepClear = [hotspotFor(p.step, z, sz), avoid];
      let corner = ctaCorner(sz.w, sz.h, ctaEl.offsetWidth, ctaEl.offsetHeight, inset, cardBox, keepClear);
      if (corner === null) {
        placeCard(sz, avoid, aim, true);
        corner = ctaCorner(sz.w, sz.h, ctaEl.offsetWidth, ctaEl.offsetHeight, inset, null, keepClear) ?? { left: false, bottom: false };
      }
      ctaEl.classList.toggle("left", corner.left);
      ctaEl.classList.toggle("bottom", corner.bottom);
    }
    if (!animate) {
      void view.offsetWidth;
      view.style.transition = "";
    }
    if (pendingEnter) {
      pendingEnter = false;
      void card.offsetWidth;
      if (!animate || reduced.matches) enterCard(true);
      else {
        card.classList.remove("now");
        // The card enters once the zoom has settled.
        enterTimer = window.setTimeout(() => enterCard(false), (moved ? ZOOM_MS : 0) + ENTER_MS);
      }
    }
  }

  // ---- Focus and announcements ----
  function usable(e: Element | null): boolean {
    return !!e && e !== document.body && document.contains(e) && !e.closest("[hidden]") && !(e as HTMLButtonElement).disabled && !e.closest("[inert]");
  }
  /**
   * Focus follows the control the viewer used: Back stays on Back, Next on Next. A step
   * reached by the hotspot, a key or autoplay focuses the card's main control. A viewer
   * whose focus was nowhere (a mouse user) keeps it nowhere.
   */
  function refocus(): void {
    const from = nav.from;
    const wasOn = !!from && from !== document.body;
    const lost = !usable(document.activeElement);
    const rebuilt = !!from && (card.contains(from) || menu.contains(from) || endCard.contains(from) || !document.contains(from));
    if (!nav.force && !(wasOn && (rebuilt || lost || nav.via === "menu" || nav.via === "open"))) return;
    const sc = screen();
    let t: HTMLElement | null = null;
    if (sc.kind === "menu") t = chapterCards[lastChapter] ?? menuTitle;
    else if (sc.kind === "end") t = (endActions.firstElementChild as HTMLElement | null) ?? endTitle;
    else if (cardKind) t = nav.via === "back" && backBtn && !backBtn.disabled ? backBtn : nav.via === "next" && nextBtn ? nextBtn : defaultFocus;
    if (!t) return;
    if (card.contains(t) && card.inert) {
      // The card is still entering: hold focus on the stage, then hand it over once it can take it.
      pendingFocus = t;
      if (!stage.hidden) stage.focus({ preventScroll: true });
    } else t.focus({ preventScroll: true });
  }

  function announce(text: string): void {
    status.textContent = text;
  }

  // ---- Drawing a state ----
  function render(): void {
    const sc = screen();
    if (sc.kind === "step" || sc.kind === "chapter-end") lastChapter = sc.chapter;
    const pic = pictured();
    const imageScreen = pic !== null;
    menu.hidden = sc.kind !== "menu";
    endCard.hidden = sc.kind !== "end";
    stage.hidden = !imageScreen;
    root.dataset.screen = sc.kind;
    // Panels on the menu and end card enter softly too.
    for (const panel of [menu, endCard]) {
      if (panel.hidden) panel.classList.remove("in");
      else if (!panel.classList.contains("in")) {
        panel.classList.add("now");
        void panel.offsetWidth;
        panel.classList.remove("now");
        panel.classList.add("in");
      }
    }

    // Header and footer.
    chapterName.textContent = sc.kind === "step" || sc.kind === "chapter-end" ? chapterTitle(sc.chapter) : "";
    chaptersBtn.hidden = chapters.length < 2 || sc.kind === "menu" || sc.kind === "cover";
    if (ctaEl) {
      ctaEl.hidden = !(sc.kind === "step" || sc.kind === "menu");
      const home = sc.kind === "menu" ? menu : frame;
      if (ctaEl.parentElement !== home) {
        ctaEl.classList.remove("left", "bottom");
        if (home === menu) menu.prepend(ctaEl);
        else frame.append(ctaEl);
      }
    }
    hint.hidden = sc.kind !== "step";
    const inChapter = sc.kind === "step" || sc.kind === "chapter-end";
    where.hidden = !inChapter || chapters.length < 2;
    if (inChapter) {
      whereText.textContent = `Chapter ${sc.chapter + 1} of ${chapters.length}`;
      [...dots.children].forEach((d, k) => {
        d.className = k === sc.chapter ? "now" : state.seen[k] ? "seen" : "";
      });
    }

    // The menu's ticks and the end card link.
    const seenCount = state.seen.filter(Boolean).length;
    meterText.textContent = `${seenCount} of ${chapters.length} seen`;
    state.seen.forEach((s, k) => {
      ticks[k].hidden = !s;
      segments[k].className = s ? "on" : "";
      chapterCards[k].setAttribute("aria-label", `Chapter ${k + 1}: ${chapterTitle(k)}${s ? ", seen" : ""}`);
    });
    toEnd.hidden = !allSeen(state);

    // The picture, its layer and the hotspot.
    if (pic) {
      setImage(imageUrl(pic.step.image));
      const key = sc.kind + ":" + pic.c + ":" + pic.s;
      if (key !== drawnKey) {
        drawnKey = key;
        drawSpot(sc.kind === "step" ? pic.step : null);
        drawNotes(sc.kind === "step" ? pic.step : null);
      }
      const c = click(pic.step);
      ring.hidden = sc.kind !== "step" || !c;
      if (c) {
        ring.style.left = c[0] + "%";
        ring.style.top = c[1] + "%";
      }
      scrim.classList.toggle("on", sc.kind !== "step");
      frame.classList.toggle("anywhere", sc.kind === "step" && pic.step.advance === "anywhere");
      const n = chapters[pic.c].steps.length;
      barFill.style.transform = `scaleX(${sc.kind === "cover" ? 0 : sc.kind === "chapter-end" ? 1 : (pic.s + 1) / n})`;
      shot.alt = sc.kind === "step" ? `Step ${pic.s + 1} of ${n}` : "";
    } else {
      drawnKey = "";
      drawSpot(null);
      drawNotes(null);
    }
    buildCard();

    // Announced politely, once per screen.
    const words: string[] =
      sc.kind === "cover" && cover ? [cover.title, cover.body]
      : sc.kind === "menu" ? ["Chapters", `${seenCount} of ${chapters.length} seen`]
      : sc.kind === "chapter-end" ? [`Chapter complete: ${chapterTitle(sc.chapter)}`]
      : sc.kind === "end" ? ["That's the whole tour", end?.text ?? ""]
      : sc.kind === "step" ? stepWords(sc.chapter, sc.step)
      : [];
    const akey = JSON.stringify(sc);
    if (akey !== announced) {
      announced = akey;
      announce(words.filter(Boolean).join(". "));
    }

    if (pic && imageReady()) layout(true);
    // Otherwise the picture's load or error event lays it out.
    preload();
    syncHash();
    refocus();
    nav = { via: "", from: null, force: false };
    showPlay();
    schedule();
  }

  function stepWords(c: number, s: number): string[] {
    const st = chapters[c].steps[s];
    const info = stepCard(st);
    const head = chapters.length > 1 ? `${chapterTitle(c)}, step ${s + 1} of ${chapters[c].steps.length}` : `Step ${s + 1} of ${chapters[c].steps.length}`;
    return [head, info.title, plain(info.body)];
  }

  /** Only the next and previous pictures are kept loaded ahead. */
  function preload(): void {
    const sc = screen();
    const want: (PageStep | undefined)[] = [];
    if (sc.kind === "step") want.push(chapters[sc.chapter].steps[sc.step + 1], chapters[sc.chapter].steps[sc.step - 1]);
    else if (sc.kind === "cover" || sc.kind === "menu") want.push(chapters[0]?.steps[0]);
    else if (sc.kind === "chapter-end") {
      const nc = nextUnseen(state, sc.chapter);
      if (nc !== null) want.push(chapters[nc].steps[0]);
    }
    const keep: Record<string, HTMLImageElement> = {};
    for (const st of want) {
      const src = st ? imageUrl(st.image) : null;
      if (!src) continue;
      if (preloaded[src]) keep[src] = preloaded[src];
      else {
        const img = new Image();
        img.decoding = "async";
        img.src = src;
        keep[src] = img;
      }
    }
    preloaded = keep;
  }

  /** The address shows the step, so it can be copied as a link; nothing else is kept. */
  function syncHash(): void {
    const sc = screen();
    const want = sc.kind === "step" ? hashFor(sc.chapter, sc.step) : "";
    if (location.hash === want || (want === "" && location.hash === "")) return;
    try {
      history.replaceState(history.state, "", want === "" ? location.pathname + location.search : want);
    } catch {
      // A sandboxed frame may refuse; the link is a convenience only.
    }
  }

  // ---- Moving through the tour ----
  function act(a: Action, via: Via, auto = false): void {
    nav = { via: auto ? "auto" : via, from: document.activeElement, force: false };
    const before = state;
    state = reduce(tour, state, a);
    if (state.missPulse !== shownMiss) {
      shownMiss = state.missPulse;
      pulseHarder();
    }
    // Reaching a panel by hand moves focus onto it, wherever focus was.
    if (!auto && state.screen !== before.screen && (state.screen.kind === "end" || state.screen.kind === "chapter-end")) nav.force = true;
    if (state.screen !== before.screen) render();
    else {
      showPlay();
      schedule();
      nav = { via: "", from: null, force: false };
    }
  }

  function pulseHarder(): void {
    if (reduced.matches || ring.hidden) return;
    window.clearTimeout(missTimer);
    ring.classList.remove("miss");
    void ring.offsetWidth;
    ring.classList.add("miss");
    missTimer = window.setTimeout(() => ring.classList.remove("miss"), 700);
  }

  frame.addEventListener("click", (e) => {
    const sc = screen();
    if (sc.kind !== "step" || (e.target as Element).closest("button, a")) return;
    if (chapters[sc.chapter].steps[sc.step].advance === "anywhere") act({ type: "hit" }, "hotspot");
    else act({ type: "miss" }, "");
  });

  document.addEventListener("keydown", (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
    const sc = screen();
    if (e.key === "Escape") {
      if (chapters.length > 1 && sc.kind !== "menu" && sc.kind !== "cover") {
        e.preventDefault();
        act({ type: "menu" }, "menu");
      }
      return;
    }
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    if (sc.kind === "cover" && e.key === "ArrowRight") {
      act({ type: "start" }, "key");
      return;
    }
    if (sc.kind !== "step" && sc.kind !== "chapter-end") return;
    e.preventDefault();
    act({ type: e.key === "ArrowRight" ? "next" : "back" }, "key");
  });

  // A horizontal swipe of at least 40 px on the picture.
  let touch: Pt | null = null;
  stage.addEventListener("touchstart", (e) => {
    touch = e.touches.length === 1 ? [e.touches[0].clientX, e.touches[0].clientY] : null;
  }, { passive: true });
  stage.addEventListener("touchend", (e) => {
    if (!touch) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touch[0];
    const dy = t.clientY - touch[1];
    touch = null;
    if (Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy)) act({ type: dx < 0 ? "next" : "back" }, "key");
  });

  window.addEventListener("hashchange", () => {
    const p = parseHash(tour, location.hash);
    if (p) act({ type: "goto", chapter: p.chapter, step: p.step }, "");
  });

  let resizeFrame = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      if (!missing.hidden) showMissing();
      layout(false);
    });
  });

  // ---- Autoplay: pauses on hover, keyboard focus and a hidden tab; ends for good on a manual step ----
  let hoverHold = false;
  let focusHold = false;
  let playTimer = 0;
  function showPlay(): void {
    const running = state.autoplay === "running";
    playBtn.hidden = !playEnabled || state.autoplay === "off" || !onStep() || reduced.matches;
    playBtn.textContent = running ? "Pause" : "Play";
    playBtn.setAttribute("aria-label", running ? "Pause autoplay" : "Play autoplay");
    root.classList.toggle("holding", running && (hoverHold || focusHold));
  }
  function schedule(): void {
    window.clearTimeout(playTimer);
    showPlay();
    if (state.autoplay !== "running" || hoverHold || focusHold || document.hidden || !onStep()) return;
    playTimer = window.setTimeout(() => {
      if (state.autoplay === "running" && !hoverHold && !focusHold && !document.hidden) act({ type: "tick" }, "auto", true);
    }, playMs);
  }
  function togglePlay(): void {
    act({ type: state.autoplay === "running" ? "pause" : "resume" }, "");
  }
  document.addEventListener("visibilitychange", schedule);
  stage.addEventListener("pointerenter", (e) => {
    if (e.pointerType === "mouse") {
      hoverHold = true;
      schedule();
    }
  });
  stage.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "mouse") {
      hoverHold = false;
      schedule();
    }
  });
  function checkFocus(): void {
    const a = document.activeElement;
    // Keyboard focus only: a control focused by a mouse click does not hold autoplay.
    let keyboard = false;
    try {
      keyboard = !!a && a.matches(":focus-visible");
    } catch {
      keyboard = true;
    }
    focusHold = keyboard && !!a && a !== playBtn && a !== document.body && !!a.closest("button, a");
    schedule();
  }
  document.addEventListener("focusin", checkFocus);
  document.addEventListener("focusout", () => window.setTimeout(checkFocus, 0));
  reduced.addEventListener("change", () => {
    if (reduced.matches) act({ type: "stop" }, "");
    else showPlay();
  });
  prefersDark.addEventListener("change", () => {
    if (cardStyle !== "auto") return;
    applyScheme();
    nav = { via: "", from: document.activeElement, force: false };
    buildCard();
    refocus();
    layout(false);
    nav = { via: "", from: null, force: false };
  });

  render();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
