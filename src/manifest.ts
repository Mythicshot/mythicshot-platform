// The tour manifest the recorder writes (versions 1, 2 and 3), checked field by field.
//
// This is the server's front door for untrusted input. `parseManifest` builds a new
// object from checked values only, so nothing unchecked reaches storage; unknown fields
// are dropped, and anything out of range, of the wrong type or over a cap is refused,
// never cut or clamped. Errors name the field path and never repeat the bad value.
// Pure functions with no I/O, so both targets run the same code. Nothing here builds HTML.

export type Point = { x: number; y: number };
export type Box = { x: number; y: number; w: number; h: number };
export type Note =
  | { kind: "text"; x: number; y: number; text: string; size: number; color: string }
  | { kind: "bubble"; x: number; y: number; w: number; h: number; tail: Point; text: string; size: number; color: string; fill: string };
export type Link = { label: string; url: string };
export type Theme = { card_style: "dark" | "light" | "compact" | "auto"; accent: string; hotspot: "pulse" | "dot" | "none"; progress_bar: boolean; backdrop: string; spotlight_soft: boolean };
export type Zoom = { enabled: boolean; percent: number };
export type Cover = { title: string; body: string; button: string; logo: "logo.png" | "logo.jpg" | null };
export type EndCard = { text: string; primary: Link | null; secondary: Link | null; replay: boolean };
export type Autoplay = { enabled: boolean; seconds: number };
export type Card = { title: string; body: string; next_label: string; anchor: "hotspot" | "point" | "none"; point: Point | null; placement: "auto" | "top" | "bottom" | "left" | "right" };
export type ManifestStep = { image: string; width: number; height: number; bytes: number; click: Point | null; t_ms: number; spotlight: Box | null; notes: Note[]; card: Card | null; advance: "hotspot" | "anywhere"; zoom: boolean | null };
export type Manifest = { version: 1 | 2 | 3; generator: string; title: string; spotlight_dim: number | null; theme: Theme; zoom: Zoom; cover: Cover | null; cta: Link | null; end: EndCard | null; autoplay: Autoplay; steps: ManifestStep[] };

/** Caps from the plan's Global Constraints. Text caps are Unicode code points after trimming. */
export const LIMITS = {
  steps: 200,
  imageBytes: 2_000_000,
  imageSide: 4096,
  title: 200,
  generator: 100,
  notesPerStep: 20,
  noteText: 500,
  cardTitle: 80,
  cardBody: 300,
  nextLabel: 24,
  coverTitle: 80,
  coverBody: 200,
  coverButton: 24,
  buttonLabel: 24,
  endText: 200,
  link: 500,
  manifestBytes: 262_144,
} as const;

const DEFAULT_THEME: Theme = { card_style: "dark", accent: "#5dcaa5", hotspot: "pulse", progress_bar: true, backdrop: "auto", spotlight_soft: true };
const DEFAULT_ZOOM: Zoom = { enabled: true, percent: 118 };
const DEFAULT_AUTOPLAY: Autoplay = { enabled: false, seconds: 5 };

// Each pattern is a single character class tested once, so its cost is linear in the input.
/** Control (Cc), format (Cf, which covers bidi overrides and zero-width characters), lone surrogates, line and paragraph separators. */
const FORBIDDEN_ONE_LINE = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;
/** The same, except that a line feed is allowed. */
const FORBIDDEN_MULTI_LINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\p{Cf}\p{Cs}\u2028\u2029]/u;
/** Any whitespace, for links. */
const WHITESPACE = /\p{White_Space}/u;
/** True for a Unicode White_Space character (all of them are in the Basic Multilingual Plane). */
function isSpace(c: number): boolean {
  return (
    (c >= 0x09 && c <= 0x0d) || c === 0x20 || c === 0x85 || c === 0xa0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000
  );
}

/**
 * Trims Unicode White_Space from both ends, the same set the recorder trims. Unlike
 * `String.prototype.trim` it keeps U+FEFF, which is then refused as a format character.
 */
function trimSpace(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && isSpace(s.charCodeAt(a))) a++;
  while (b > a && isSpace(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}

class Bad extends Error {
  constructor(path: string, why: string) {
    super(`${path}: ${why}`);
  }
}

/** The number of Unicode code points, the way the recorder counts characters. */
function codePoints(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function obj(v: unknown, path: string): Obj {
  if (!isObj(v)) throw new Bad(path, "must be an object");
  return v;
}

/** An own property only, so nothing is read from a prototype. */
function get(o: Obj, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

/** The list's own element at `i`; a hole in a sparse list is refused, never skipped. */
function element(list: unknown[], i: number, path: string): unknown {
  if (!Object.hasOwn(list, i)) throw new Bad(`${path}[${i}]`, "is required");
  return list[i];
}

function join(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

type TextRule = { min: number; max: number; multiLine?: boolean };

/**
 * A string with no control or format characters (a line feed only where `multiLine`),
 * between `min` and `max` code points after trimming. Returns the trimmed text, so the
 * cap bounds what is stored.
 */
function text(v: unknown, path: string, rule: TextRule): string {
  if (typeof v !== "string") throw new Bad(path, "must be a string");
  // A code point is at most two UTF-16 units, so even with padding a string longer than
  // twice the cap cannot be valid; refuse it before doing any other work.
  if (v.length > rule.max * 2) throw new Bad(path, `must be at most ${rule.max} characters`);
  if ((rule.multiLine ? FORBIDDEN_MULTI_LINE : FORBIDDEN_ONE_LINE).test(v)) throw new Bad(path, "contains a control or format character");
  const trimmed = trimSpace(v);
  const n = codePoints(trimmed);
  if (n < rule.min) throw new Bad(path, rule.min === 1 ? "must not be empty" : `must be at least ${rule.min} characters`);
  if (n > rule.max) throw new Bad(path, `must be at most ${rule.max} characters`);
  return trimmed;
}

function int(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new Bad(path, `must be a whole number from ${min} to ${max}`);
  return v;
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== "boolean") throw new Bad(path, "must be true or false");
  return v;
}

function percent(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) throw new Bad(path, "must be a number from 0 to 100");
  return v;
}

function oneOf<T extends string>(v: unknown, path: string, values: readonly T[]): T {
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) throw new Bad(path, `must be one of ${values.join(", ")}`);
  return v as T;
}

function isHex(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
}

/** `#rrggbb`, returned lowercase. */
function colour(v: unknown, path: string): string {
  if (typeof v !== "string" || v.length !== 7 || v[0] !== "#") throw new Bad(path, "must be a colour like #rrggbb");
  for (let i = 1; i < 7; i++) if (!isHex(v.charCodeAt(i))) throw new Bad(path, "must be a colour like #rrggbb");
  return v.toLowerCase();
}

/** A field with a default: absent takes the default, present must be valid. */
function opt<T>(o: Obj, key: string, path: string, fallback: T, check: (v: unknown, path: string) => T): T {
  const v = get(o, key);
  return v === undefined ? fallback : check(v, join(path, key));
}

/** A nullable field: absent or null is null, anything else must be valid. */
function nullable<T>(o: Obj, key: string, path: string, check: (v: unknown, path: string) => T): T | null {
  const v = get(o, key);
  return v === undefined || v === null ? null : check(v, join(path, key));
}

function req<T>(o: Obj, key: string, path: string, check: (v: unknown, path: string) => T): T {
  const v = get(o, key);
  if (v === undefined) throw new Bad(join(path, key), "is required");
  return check(v, join(path, key));
}

function isAsciiAlnum(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

function isAsciiLetter(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

/**
 * At least two dot-separated labels of ASCII letters, digits and `-`, no label starting or
 * ending with `-`, a last label holding at least one letter (so no bare IP address or
 * single-label name), then an optional `:` and a port from 1 to 65535 in 1 to 5 digits.
 */
function goodAuthority(auth: string): boolean {
  const colon = auth.indexOf(":");
  const host = colon === -1 ? auth : auth.slice(0, colon);
  if (colon !== -1) {
    const port = auth.slice(colon + 1);
    if (port.length < 1 || port.length > 5) return false;
    let value = 0;
    for (let i = 0; i < port.length; i++) {
      const c = port.charCodeAt(i);
      if (c < 0x30 || c > 0x39) return false;
      value = value * 10 + (c - 0x30);
    }
    if (value < 1 || value > 65535) return false;
  }
  const labels = host.split(".");
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (label.length === 0 || label[0] === "-" || label[label.length - 1] === "-") return false;
    for (let i = 0; i < label.length; i++) {
      const c = label.charCodeAt(i);
      if (!isAsciiAlnum(c) && c !== 0x2d) return false;
    }
  }
  const last = labels[labels.length - 1];
  for (let i = 0; i < last.length; i++) if (isAsciiLetter(last.charCodeAt(i))) return true;
  return false;
}

/**
 * `https://` (any case) with a host of ASCII letters, digits and `-` in dot-separated
 * labels and an optional port, no `@` in the authority, no whitespace, control or format
 * characters anywhere, at most 500 code points after trimming. Returns the trimmed link with its
 * scheme written in lowercase, or null.
 * Same rule as `TourCore.safeUrl`. Written out by hand, not left to a URL parser.
 */
export function safeUrl(s: unknown): string | null {
  if (typeof s !== "string") return null;
  if (s.length > LIMITS.link * 2) return null;
  // Control and format characters are refused before trimming, so none is ever trimmed away.
  if (FORBIDDEN_ONE_LINE.test(s)) return null;
  const t = trimSpace(s);
  if (codePoints(t) > LIMITS.link) return null;
  if (WHITESPACE.test(t)) return null;
  if (t.slice(0, 8).toLowerCase() !== "https://") return null;
  const rest = t.slice(8);
  let end = rest.length;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === "/" || c === "?" || c === "#") {
      end = i;
      break;
    }
  }
  return goodAuthority(rest.slice(0, end)) ? "https://" + rest : null;
}

/**
 * Obligation for every later task that outputs a link: a link that passes `safeUrl` may
 * still hold `"`, `<`, `>` and `'` in its path, query or fragment, so it must be escaped
 * or set as a DOM attribute value, never pasted into HTML or a script as raw text.
 */
function link(v: unknown, path: string): Link {
  const o = obj(v, path);
  const label = req(o, "label", path, (x, p) => text(x, p, { min: 1, max: LIMITS.buttonLabel }));
  const url = req(o, "url", path, (x, p) => {
    const u = safeUrl(x);
    if (u === null) throw new Bad(p, `must be an https:// link with a plain host, at most ${LIMITS.link} characters`);
    return u;
  });
  return { label, url };
}

function point(v: unknown, path: string): Point {
  const o = obj(v, path);
  return { x: req(o, "x", path, percent), y: req(o, "y", path, percent) };
}

/** A box in percent: `w > 0`, `h > 0`, and it ends by 100.01 to allow for rounding. */
function boxOf(o: Obj, path: string): Box {
  const x = req(o, "x", path, percent);
  const y = req(o, "y", path, percent);
  const w = req(o, "w", path, percent);
  const h = req(o, "h", path, percent);
  if (w <= 0) throw new Bad(join(path, "w"), "must be above 0");
  if (h <= 0) throw new Bad(join(path, "h"), "must be above 0");
  if (x + w > 100.01) throw new Bad(path, "must end inside the image (x + w at most 100)");
  if (y + h > 100.01) throw new Bad(path, "must end inside the image (y + h at most 100)");
  return { x, y, w, h };
}

function size(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 100) throw new Bad(path, "must be a number above 0 and at most 100");
  return v;
}

const noteText = (v: unknown, p: string) => text(v, p, { min: 1, max: LIMITS.noteText, multiLine: true });

function note(v: unknown, path: string): Note {
  const o = obj(v, path);
  const kind = req(o, "kind", path, (x, p) => oneOf(x, p, ["text", "bubble"] as const));
  if (kind === "text") {
    return {
      kind,
      x: req(o, "x", path, percent),
      y: req(o, "y", path, percent),
      text: req(o, "text", path, noteText),
      size: req(o, "size", path, size),
      color: req(o, "color", path, colour),
    };
  }
  const box = boxOf(o, path);
  return {
    kind,
    ...box,
    tail: req(o, "tail", path, point),
    text: req(o, "text", path, noteText),
    size: req(o, "size", path, size),
    color: req(o, "color", path, colour),
    fill: req(o, "fill", path, colour),
  };
}

/** `step-NNN.png` or `step-NNN.jpg`, checked character by character. */
function imageName(v: unknown, path: string): string {
  const bad = () => new Bad(path, "must be step-NNN.png or step-NNN.jpg");
  if (typeof v !== "string" || v.length !== 12 || !v.startsWith("step-")) throw bad();
  for (let i = 5; i < 8; i++) {
    const c = v.charCodeAt(i);
    if (c < 0x30 || c > 0x39) throw bad();
  }
  const ext = v.slice(8);
  if (ext !== ".png" && ext !== ".jpg") throw bad();
  return v;
}

function card(v: unknown, path: string, click: Point | null): Card {
  const o = obj(v, path);
  const title = opt(o, "title", path, "", (x, p) => text(x, p, { min: 0, max: LIMITS.cardTitle }));
  const body = opt(o, "body", path, "", (x, p) => text(x, p, { min: 0, max: LIMITS.cardBody, multiLine: true }));
  if (title === "" && body === "") throw new Bad(path, "needs a title or a body");
  const next_label = opt(o, "next_label", path, "Next", (x, p) => text(x, p, { min: 1, max: LIMITS.nextLabel }));
  const anchor = opt(o, "anchor", path, "hotspot" as const, (x, p) => oneOf(x, p, ["hotspot", "point", "none"] as const));
  const pt = nullable(o, "point", path, point);
  if (anchor === "point" && pt === null) throw new Bad(join(path, "point"), "is required when anchor is point");
  if (anchor !== "point" && pt !== null) throw new Bad(join(path, "point"), "must be null unless anchor is point");
  if (anchor === "hotspot" && click === null) throw new Bad(join(path, "anchor"), "cannot be hotspot on a step with no click");
  const placement = opt(o, "placement", path, "auto" as const, (x, p) => oneOf(x, p, ["auto", "top", "bottom", "left", "right"] as const));
  return { title, body, next_label, anchor, point: pt, placement };
}

function step(v: unknown, path: string, version: 1 | 2 | 3): ManifestStep {
  const o = obj(v, path);
  const image = req(o, "image", path, imageName);
  const width = req(o, "width", path, (x, p) => int(x, p, 1, LIMITS.imageSide));
  const height = req(o, "height", path, (x, p) => int(x, p, 1, LIMITS.imageSide));
  const bytes = req(o, "bytes", path, (x, p) => int(x, p, 1, LIMITS.imageBytes));
  const clickValue = get(o, "click");
  if (clickValue === undefined) throw new Bad(join(path, "click"), "is required (null for no click)");
  const click = clickValue === null ? null : point(clickValue, join(path, "click"));
  const t_ms = req(o, "t_ms", path, (x, p) => int(x, p, 0, Number.MAX_SAFE_INTEGER));
  const out: ManifestStep = { image, width, height, bytes, click, t_ms, spotlight: null, notes: [], card: null, advance: "hotspot", zoom: null };
  if (version === 1) return out;
  out.spotlight = nullable(o, "spotlight", path, (x, p) => boxOf(obj(x, p), p));
  out.notes = opt(o, "notes", path, [] as Note[], (x, p) => {
    if (!Array.isArray(x)) throw new Bad(p, "must be a list");
    if (x.length > LIMITS.notesPerStep) throw new Bad(p, `must hold at most ${LIMITS.notesPerStep} notes`);
    const out: Note[] = [];
    for (let i = 0; i < x.length; i++) out.push(note(element(x, i, p), `${p}[${i}]`));
    return out;
  });
  if (version === 2) return out;
  out.card = nullable(o, "card", path, (x, p) => card(x, p, click));
  out.advance = opt(o, "advance", path, "hotspot" as const, (x, p) => oneOf(x, p, ["hotspot", "anywhere"] as const));
  const zoom = get(o, "zoom");
  out.zoom = zoom === undefined || zoom === null ? null : bool(zoom, join(path, "zoom"));
  return out;
}

function theme(v: unknown, path: string): Theme {
  const o = obj(v, path);
  const d = DEFAULT_THEME;
  return {
    card_style: opt(o, "card_style", path, d.card_style, (x, p) => oneOf(x, p, ["dark", "light", "compact", "auto"] as const)),
    accent: opt(o, "accent", path, d.accent, colour),
    hotspot: opt(o, "hotspot", path, d.hotspot, (x, p) => oneOf(x, p, ["pulse", "dot", "none"] as const)),
    progress_bar: opt(o, "progress_bar", path, d.progress_bar, bool),
    backdrop: opt(o, "backdrop", path, d.backdrop, (x, p) => (x === "auto" ? "auto" : colour(x, p))),
    spotlight_soft: opt(o, "spotlight_soft", path, d.spotlight_soft, bool),
  };
}

function zoom(v: unknown, path: string): Zoom {
  const o = obj(v, path);
  return {
    enabled: opt(o, "enabled", path, DEFAULT_ZOOM.enabled, bool),
    percent: opt(o, "percent", path, DEFAULT_ZOOM.percent, (x, p) => int(x, p, 105, 140)),
  };
}

function autoplay(v: unknown, path: string): Autoplay {
  const o = obj(v, path);
  return {
    enabled: opt(o, "enabled", path, DEFAULT_AUTOPLAY.enabled, bool),
    seconds: opt(o, "seconds", path, DEFAULT_AUTOPLAY.seconds, (x, p) => int(x, p, 2, 20)),
  };
}

function cover(v: unknown, path: string): Cover {
  const o = obj(v, path);
  return {
    title: req(o, "title", path, (x, p) => text(x, p, { min: 1, max: LIMITS.coverTitle })),
    body: opt(o, "body", path, "", (x, p) => text(x, p, { min: 0, max: LIMITS.coverBody, multiLine: true })),
    button: opt(o, "button", path, "Start", (x, p) => text(x, p, { min: 1, max: LIMITS.coverButton })),
    logo: nullable(o, "logo", path, (x, p) => oneOf(x, p, ["logo.png", "logo.jpg"] as const)),
  };
}

function endCard(v: unknown, path: string): EndCard {
  const o = obj(v, path);
  return {
    text: opt(o, "text", path, "", (x, p) => text(x, p, { min: 0, max: LIMITS.endText, multiLine: true })),
    primary: nullable(o, "primary", path, link),
    secondary: nullable(o, "secondary", path, link),
    replay: opt(o, "replay", path, true, bool),
  };
}

function manifest(json: unknown): Manifest {
  const o = obj(json, "manifest");
  const version = req(o, "version", "", (x, p) => int(x, p, 1, 3)) as 1 | 2 | 3;
  const generator = req(o, "generator", "", (x, p) => text(x, p, { min: 0, max: LIMITS.generator }));
  const title = req(o, "title", "", (x, p) => text(x, p, { min: 1, max: LIMITS.title }));
  const steps = req(o, "steps", "", (x, p) => {
    if (!Array.isArray(x)) throw new Bad(p, "must be a list");
    if (x.length < 1 || x.length > LIMITS.steps) throw new Bad(p, `must hold 1 to ${LIMITS.steps} steps`);
    const seen = new Set<string>();
    const out: ManifestStep[] = [];
    for (let i = 0; i < x.length; i++) {
      const st = step(element(x, i, p), `${p}[${i}]`, version);
      if (seen.has(st.image)) throw new Bad(`${p}[${i}].image`, "repeats another step's image");
      seen.add(st.image);
      out.push(st);
    }
    return out;
  });

  let spotlight_dim: number | null = null;
  if (version >= 2) {
    spotlight_dim = nullable(o, "spotlight_dim", "", (x, p) => int(x, p, 10, 90));
    if (spotlight_dim === null && steps.some((s) => s.spotlight !== null)) throw new Bad("spotlight_dim", "is required when a step has a spotlight");
  }

  if (version < 3) {
    // Older tours look as they did: no cards or cover, and zoom and the progress bar off.
    return { version, generator, title, spotlight_dim, theme: { ...DEFAULT_THEME, progress_bar: false }, zoom: { ...DEFAULT_ZOOM, enabled: false }, cover: null, cta: null, end: null, autoplay: { ...DEFAULT_AUTOPLAY }, steps };
  }
  return {
    version,
    generator,
    title,
    spotlight_dim,
    theme: opt(o, "theme", "", { ...DEFAULT_THEME }, theme),
    zoom: opt(o, "zoom", "", { ...DEFAULT_ZOOM }, zoom),
    cover: nullable(o, "cover", "", cover),
    cta: nullable(o, "cta", "", link),
    end: nullable(o, "end", "", endCard),
    autoplay: opt(o, "autoplay", "", { ...DEFAULT_AUTOPLAY }, autoplay),
    steps,
  };
}

/**
 * Returns a normalised manifest (v1 gets spotlight null and notes []; v1 and v2 get the
 * default theme with zoom and the progress bar off, no cover, button, end card or cards)
 * or a message naming the first bad field.
 */
export function parseManifest(json: unknown): { ok: true; manifest: Manifest } | { ok: false; error: string } {
  try {
    return { ok: true, manifest: manifest(json) };
  } catch (e) {
    if (e instanceof Bad) return { ok: false, error: e.message };
    throw e;
  }
}
