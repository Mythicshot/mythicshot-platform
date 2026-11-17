import { describe, expect, it } from "vitest";
import { parseManifest, safeUrl, type Manifest } from "../src/manifest.ts";
import v1 from "./fixtures/manifest-v1.json" with { type: "json" };
import v2 from "./fixtures/manifest-v2.json" with { type: "json" };
import v3 from "./fixtures/manifest-v3.json" with { type: "json" };

type Json = Record<string, any>;
const HOSTILE = "</script><img src=x onerror=alert(1)>";
const EMOJI = "\u{1F600}"; // one code point, two UTF-16 units

function clone(m: unknown): Json {
  return JSON.parse(JSON.stringify(m));
}

/** Splits "steps[0].card.title" into ["steps", 0, "card", "title"]. */
function parts(path: string): (string | number)[] {
  const out: (string | number)[] = [];
  for (const seg of path.split(".")) {
    const open = seg.indexOf("[");
    if (open === -1) out.push(seg);
    else out.push(seg.slice(0, open), Number(seg.slice(open + 1, -1)));
  }
  return out;
}

/** A copy of `base` with the value at `path` replaced, or removed when `value` is undefined. */
function withField(base: unknown, path: string, value: unknown): Json {
  const m = clone(base);
  const p = parts(path);
  let o: any = m;
  for (const k of p.slice(0, -1)) o = o[k];
  const last = p[p.length - 1];
  if (value === undefined) delete o[last];
  else o[last] = value;
  return m;
}

function ok(json: unknown): Manifest {
  const r = parseManifest(json);
  if (!r.ok) throw new Error("expected ok, got: " + r.error);
  return r.manifest;
}

function refused(json: unknown): string {
  const r = parseManifest(json);
  if (r.ok) throw new Error("expected a refusal");
  return r.error;
}

function expectRefused(base: unknown, path: string, value: unknown, name = path): string {
  const error = refused(withField(base, path, value));
  expect(error).toContain(name);
  return error;
}

describe("versions 1 and 2", () => {
  it("accepts the v2 fixture and keeps every layer field", () => {
    const m = ok(v2);
    expect(m.version).toBe(2);
    expect(m.spotlight_dim).toBe(60);
    expect(m.steps[0].spotlight).toEqual({ x: 40, y: 30, w: 25, h: 12 });
    expect(m.steps[0].notes[0]).toEqual({ kind: "text", x: 12.5, y: 8, text: "Start here", size: 4.17, color: "#ffffff" });
    expect(m.steps[1].notes[0]).toEqual({ kind: "bubble", x: 55, y: 60, w: 30, h: 15.5, tail: { x: 10, y: 25 }, text: "Then pick the customer", size: 3.33, color: "#1a1a1a", fill: "#ffffff" });
    expect(m.steps[0].click).toEqual({ x: 50, y: 50 });
    expect(m.steps[2].click).toBeNull();
  });

  it("accepts the v1 fixture as a tour with no layer", () => {
    const m = ok(v1);
    expect(m.version).toBe(1);
    expect(m.spotlight_dim).toBeNull();
    for (const s of m.steps) {
      expect(s.spotlight).toBeNull();
      expect(s.notes).toEqual([]);
    }
  });

  it("v1 and v2 manifests get the default theme with zoom and the progress bar off", () => {
    for (const fixture of [v1, v2]) {
      const m = ok(fixture);
      expect(m.theme).toEqual({ card_style: "dark", accent: "#5dcaa5", hotspot: "pulse", progress_bar: false, backdrop: "auto", spotlight_soft: true });
      expect(m.zoom).toEqual({ enabled: false, percent: 118 });
      expect(m.autoplay).toEqual({ enabled: false, seconds: 5 });
      expect([m.cover, m.cta, m.end]).toEqual([null, null, null]);
      for (const s of m.steps) {
        expect(s.card).toBeNull();
        expect(s.advance).toBe("hotspot");
        expect(s.zoom).toBeNull();
      }
    }
  });

  it("v1 and v2 ignore version 3 fields that an older writer never wrote", () => {
    const m = ok(withField(v2, "theme", { card_style: "neon" }));
    expect(m.theme.card_style).toBe("dark");
    expect(ok(withField(v1, "steps[0].spotlight", { x: 1, y: 1, w: 1, h: 1 })).steps[0].spotlight).toBeNull();
  });
});

describe("tour-level fields", () => {
  it.each([
    ["version", 4],
    ["version", 0],
    ["version", "3"],
    ["version", 2.5],
    ["title", ""],
    ["title", "   "],
    ["title", "x".repeat(201)],
    ["title", 7],
    ["generator", 7],
    ["generator", "x".repeat(101)],
    ["steps", []],
    ["steps", "step-001.png"],
    ["spotlight_dim", 9],
    ["spotlight_dim", 91],
    ["spotlight_dim", 60.5],
    ["spotlight_dim", "60"],
  ])("rejects %s = %j", (field, value) => {
    expectRefused(v2, field, value);
  });

  it("rejects input that is not an object", () => {
    for (const bad of [null, [], "x", 3, undefined]) expect(refused(bad)).toBeTruthy();
  });

  it("rejects a missing title, version or steps", () => {
    for (const f of ["title", "version", "steps"]) expect(refused(withField(v3, f, undefined))).toContain(f);
  });

  it("rejects a spotlight when spotlight_dim is missing", () => {
    expect(refused(withField(v2, "spotlight_dim", undefined))).toContain("spotlight_dim");
  });

  it("rejects 201 steps, a 2,000,001-byte image and a 4097-pixel width", () => {
    const many = clone(v2);
    const s = many.steps[2];
    many.steps = Array.from({ length: 201 }, (_, i) => ({ ...s, image: `step-${String(i + 1).padStart(3, "0")}.png` }));
    expect(refused(many)).toContain("steps");
    const exact = clone(many);
    exact.steps.length = 200;
    expect(ok(exact).steps).toHaveLength(200);
    expectRefused(v2, "steps[0].bytes", 2_000_001);
    expectRefused(v2, "steps[0].width", 4097);
    expectRefused(v2, "steps[0].height", 4097);
    expectRefused(v2, "steps[0].height", 0);
    expectRefused(v2, "steps[0].bytes", 0);
    expectRefused(v2, "steps[0].width", 12.5);
    expect(ok(withField(v2, "steps[0].bytes", 2_000_000)).steps[0].bytes).toBe(2_000_000);
    expect(ok(withField(v2, "steps[0].width", 4096)).steps[0].width).toBe(4096);
  });

  it("rejects image names that are not step-NNN.png or step-NNN.jpg, or that repeat", () => {
    for (const name of ["../x.png", "step-001.svg", "step-01.png", "step-0001.png", "STEP-001.png", "step-001.PNG", "step-001.png ", "step-00a.png", "u/step-001.png", ""]) {
      expectRefused(v2, "steps[0].image", name, "steps[0].image");
    }
    expectRefused(v2, "steps[1].image", "step-001.png", "steps[1].image");
    expect(ok(withField(v2, "steps[0].image", "step-999.jpg")).steps[0].image).toBe("step-999.jpg");
  });

  it("rejects a negative, fractional or missing t_ms", () => {
    expectRefused(v2, "steps[0].t_ms", -1);
    expectRefused(v2, "steps[0].t_ms", 1.5);
    expectRefused(v2, "steps[0].t_ms", undefined);
  });
});

describe("the layer", () => {
  it("rejects percentages outside 0 to 100, NaN, Infinity, 1e9 and strings", () => {
    expectRefused(v2, "steps[0].click.x", 1e9);
    expectRefused(v2, "steps[0].click.y", -0.01);
    expectRefused(v2, "steps[0].click.x", Number.NaN);
    expectRefused(v2, "steps[0].click.x", Number.POSITIVE_INFINITY);
    expectRefused(v2, "steps[0].click.x", "50");
    expectRefused(v2, "steps[0].click", { x: 50 }, "steps[0].click.y");
    expectRefused(v2, "steps[0].spotlight.w", 0);
    expectRefused(v2, "steps[0].spotlight.h", -1);
    expectRefused(v2, "steps[0].spotlight", { x: 50, y: 0, w: 50.02, h: 10 }, "steps[0].spotlight");
    expectRefused(v2, "steps[0].spotlight", { x: 0, y: 99, w: 10, h: 1.02 }, "steps[0].spotlight");
    expectRefused(v2, "steps[1].notes[0].tail.y", -1);
    expectRefused(v2, "steps[1].notes[0].w", 0);
    expectRefused(v2, "steps[1].notes[0].x", 101);
    expectRefused(v2, "steps[0].notes[0].x", "12");
    // Rounding to two decimals may leave a box ending at 100.01.
    expect(ok(withField(v2, "steps[0].spotlight", { x: 50, y: 0, w: 50.01, h: 100 })).steps[0].spotlight).toEqual({ x: 50, y: 0, w: 50.01, h: 100 });
    expect(ok(withField(v2, "steps[0].click", { x: 0, y: 100 })).steps[0].click).toEqual({ x: 0, y: 100 });
  });

  it("rejects a size of 0 and of 100.5 and accepts 100", () => {
    expectRefused(v2, "steps[0].notes[0].size", 0);
    expectRefused(v2, "steps[0].notes[0].size", 100.5);
    expectRefused(v2, "steps[1].notes[0].size", -1);
    expect(ok(withField(v2, "steps[0].notes[0].size", 100)).steps[0].notes[0].size).toBe(100);
  });

  it("rejects a 21st note, an empty note, a 501-character note and an unknown kind", () => {
    const note = v2.steps[0].notes[0];
    expect(ok(withField(v2, "steps[0].notes", Array(20).fill(note))).steps[0].notes).toHaveLength(20);
    expectRefused(v2, "steps[0].notes", Array(21).fill(note), "steps[0].notes");
    expectRefused(v2, "steps[0].notes[0].text", "");
    expectRefused(v2, "steps[0].notes[0].text", "  ");
    expectRefused(v2, "steps[0].notes[0].text", "x".repeat(501));
    expectRefused(v2, "steps[0].notes[0].kind", "arrow");
    expectRefused(v2, "steps[0].notes", "x", "steps[0].notes");
    expectRefused(v2, "steps[0].notes", [null], "steps[0].notes[0]");
    expect(ok(withField(v2, "steps[0].notes[0].text", "x".repeat(500))).steps[0].notes[0].text).toHaveLength(500);
  });

  it("allows line breaks in note text, which the recorder's text tool can write", () => {
    expect(ok(withField(v2, "steps[0].notes[0].text", "two\nlines")).steps[0].notes[0].text).toBe("two\nlines");
  });

  it("rejects colours that are not #rrggbb and lowercases the ones that are", () => {
    for (const bad of ["red;background:url(//x)", "#fff", "#ffaa000", "ffaa00", "#ggaa00", " #ffaa00", "#ffaa00 ", 0xffaa00]) {
      expectRefused(v2, "steps[0].notes[0].color", bad);
      expectRefused(v2, "steps[1].notes[0].fill", bad);
    }
    expect(ok(withField(v2, "steps[0].notes[0].color", "#FFAA00")).steps[0].notes[0].color).toBe("#ffaa00");
  });

  it("keeps hostile text as text", () => {
    let m = withField(v2, "title", "</script><b>x");
    m = withField(m, "steps[0].notes[0].text", "<img src=x onerror=alert(1)>");
    const r = ok(m);
    expect(r.title).toBe("</script><b>x");
    expect(r.steps[0].notes[0].text).toBe("<img src=x onerror=alert(1)>");
  });

  it("drops unknown fields", () => {
    let m = withField(v3, "steps[0].keys", ["Ctrl", "S"]);
    m = withField(m, "extra", { a: 1 });
    m = withField(m, "steps[0].card.html", "<b>x</b>");
    m = withField(m, "theme.font", "Comic Sans");
    m = withField(m, "steps[0].notes[0].onclick", "x");
    const r = ok(m) as any;
    expect(r.steps[0].keys).toBeUndefined();
    expect(r.extra).toBeUndefined();
    expect(r.steps[0].card.html).toBeUndefined();
    expect(r.theme.font).toBeUndefined();
    expect(r.steps[0].notes[0].onclick).toBeUndefined();
  });

  it("does not read inherited properties", () => {
    const m = clone(v1);
    delete m.title;
    const withProto = Object.create({ title: "inherited" });
    Object.assign(withProto, m);
    expect(refused(withProto)).toContain("title");
  });
});

describe("version 3", () => {
  it("accepts the v3 fixture and keeps every guide-card field", () => {
    const m = ok(v3);
    expect(m.version).toBe(3);
    expect(m.theme).toEqual({ card_style: "dark", accent: "#5dcaa5", hotspot: "pulse", progress_bar: true, backdrop: "auto", spotlight_soft: true });
    expect(m.zoom).toEqual({ enabled: true, percent: 118 });
    expect(m.cover).toEqual({ title: "Invoicing in a minute", body: "See how to send your first invoice.", button: "Start", logo: "logo.png" });
    expect(m.cta).toEqual({ label: "Book a call", url: "https://tours.example.com/book" });
    expect(m.end).toEqual({ text: "That is all it takes.", primary: { label: "Start free", url: "https://tours.example.com/start" }, secondary: null, replay: true });
    expect(m.autoplay).toEqual({ enabled: false, seconds: 5 });
    expect(m.steps[0].card).toEqual({ title: "Unpaid invoices", body: "One click away.\n**Try it**", next_label: "Next", anchor: "hotspot", point: null, placement: "auto" });
    expect(m.steps[0].advance).toBe("anywhere");
    expect(m.steps[0].zoom).toBe(false);
    expect(m.steps[1].zoom).toBeNull();
    expect(m.steps[1].card).toEqual({ title: "Here", body: "", next_label: "Next", anchor: "point", point: { x: 20, y: 50 }, placement: "right" });
    expect(m.steps[2].card?.anchor).toBe("none");
  });

  it("a v3 manifest with every new field missing gets the defaults", () => {
    const m = clone(v3);
    for (const f of ["theme", "zoom", "cover", "cta", "end", "autoplay"]) delete m[f];
    for (const s of m.steps) for (const f of ["card", "advance", "zoom"]) delete s[f];
    const r = ok(m);
    expect(r.theme).toEqual({ card_style: "dark", accent: "#5dcaa5", hotspot: "pulse", progress_bar: true, backdrop: "auto", spotlight_soft: true });
    expect(r.zoom).toEqual({ enabled: true, percent: 118 });
    expect(r.autoplay).toEqual({ enabled: false, seconds: 5 });
    expect([r.cover, r.cta, r.end]).toEqual([null, null, null]);
    for (const s of r.steps) {
      expect(s.card).toBeNull();
      expect(s.advance).toBe("hotspot");
      expect(s.zoom).toBeNull();
    }
  });

  it("missing parts of a present object take their defaults", () => {
    let m = withField(v3, "theme", { accent: "#112233" });
    m = withField(m, "cover", { title: "Hi" });
    m = withField(m, "end", { text: "Bye" });
    m = withField(m, "steps[0].card", { title: "Done" });
    const r = ok(m);
    expect(r.theme).toEqual({ card_style: "dark", accent: "#112233", hotspot: "pulse", progress_bar: true, backdrop: "auto", spotlight_soft: true });
    expect(r.cover).toEqual({ title: "Hi", body: "", button: "Start", logo: null });
    expect(r.end).toEqual({ text: "Bye", primary: null, secondary: null, replay: true });
    expect(r.steps[0].card).toEqual({ title: "Done", body: "", next_label: "Next", anchor: "hotspot", point: null, placement: "auto" });
  });

  it.each([
    ["theme", null], ["theme", "dark"], ["zoom", null], ["autoplay", null],
    ["theme.card_style", "neon"], ["theme.accent", "red;background:url(//x)"], ["theme.hotspot", "blink"], ["theme.backdrop", "url(x)"],
    ["theme.progress_bar", "yes"], ["theme.spotlight_soft", 1], ["zoom.enabled", "true"], ["autoplay.enabled", 0],
    ["zoom.percent", 104], ["zoom.percent", 141], ["zoom.percent", 118.5], ["autoplay.seconds", 1], ["autoplay.seconds", 21], ["autoplay.seconds", 5.5],
    ["cover", "x"], ["cover.title", ""], ["cover.title", "x".repeat(81)], ["cover.body", "x".repeat(201)], ["cover.button", ""], ["cover.button", "x".repeat(25)],
    ["cover.logo", "../logo.png"], ["cover.logo", "logo.svg"], ["cover.logo", "LOGO.PNG"],
    ["cta", "https://tours.example.com"], ["cta.label", ""], ["cta.label", "x".repeat(25)], ["cta.url", "javascript:alert(1)"], ["cta.url", "http://tours.example.com"], ["cta.url", "https://"], ["cta.url", undefined],
    ["end.text", "x".repeat(201)], ["end.primary.url", "data:text/html,x"], ["end.secondary", { label: "x", url: "//tours.example.com" }], ["end.replay", "no"],
    ["steps[0].card", "x"], ["steps[0].card.title", "x".repeat(81)], ["steps[0].card.body", "x".repeat(301)], ["steps[0].card.next_label", "x".repeat(25)], ["steps[0].card.next_label", ""],
    ["steps[0].card.anchor", "mouse"], ["steps[0].card.placement", "center"], ["steps[0].advance", "hover"], ["steps[0].zoom", "yes"], ["steps[0].zoom", 1],
  ])("rejects %s = %j naming the field", (field, value) => {
    expectRefused(v3, field, value);
  });

  it("names the nested link field when an end-card link is bad", () => {
    expect(refused(withField(v3, "end.secondary", { label: "x", url: "//tours.example.com" }))).toContain("end.secondary.url");
  });

  it("rejects a card with neither title nor body, a point without anchor point, and a hotspot anchor on a step with no click", () => {
    expectRefused(v3, "steps[0].card", { title: " ", body: "", anchor: "none" }, "steps[0].card");
    expectRefused(v3, "steps[0].card.point", { x: 10, y: 10 });
    expectRefused(v3, "steps[1].card.point", null);
    expectRefused(v3, "steps[1].card.point", { x: 101, y: 10 }, "steps[1].card.point.x");
    expectRefused(v3, "steps[2].card.anchor", "hotspot");
  });

  it("accepts accent #FFAA00 as #ffaa00 and a link padded with spaces as trimmed", () => {
    let m = withField(v3, "theme.accent", "#FFAA00");
    m = withField(m, "theme.backdrop", "#AABBCC");
    m = withField(m, "cta.url", "  https://tours.example.com/book  ");
    const r = ok(m);
    expect(r.theme.accent).toBe("#ffaa00");
    expect(r.theme.backdrop).toBe("#aabbcc");
    expect(r.cta?.url).toBe("https://tours.example.com/book");
  });

  it("keeps hostile text as text in every new string field", () => {
    const label = HOSTILE.slice(0, 24);
    let m = withField(v3, "steps[0].card.title", HOSTILE);
    m = withField(m, "steps[0].card.body", HOSTILE);
    m = withField(m, "steps[0].card.next_label", label);
    m = withField(m, "cover.title", HOSTILE);
    m = withField(m, "cover.body", HOSTILE);
    m = withField(m, "cover.button", label);
    m = withField(m, "end.text", HOSTILE);
    m = withField(m, "cta.label", label);
    m = withField(m, "end.primary.label", label);
    const r = ok(m);
    expect([r.steps[0].card?.title, r.steps[0].card?.body, r.cover?.title, r.cover?.body, r.end?.text]).toEqual(Array(5).fill(HOSTILE));
    expect([r.steps[0].card?.next_label, r.cover?.button, r.cta?.label, r.end?.primary?.label]).toEqual(Array(4).fill(label));
  });

  it("trims the recorder's whitespace but not U+FEFF", () => {
    expect(ok(withField(v3, "cover.title", "\u3000Hi\u3000")).cover?.title).toBe("Hi");
    // Control characters are refused even at the ends, before any trimming.
    expectRefused(v3, "cover.title", "Hi\u0085");
    expectRefused(v3, "cover.title", "Hi\ufeff");
    expect(safeUrl("https://tours.example.com/\u3000")).toBe("https://tours.example.com/");
  });

  it("caps are counted after trimming", () => {
    const r = ok(withField(v3, "cover.title", "  " + "x".repeat(80) + "  "));
    expect(r.cover?.title).toBe("x".repeat(80));
  });
});

describe("characters in text fields", () => {
  it("counts caps in code points: 80 emoji fit an 80 cap and 81 do not", () => {
    expect(ok(withField(v3, "cover.title", EMOJI.repeat(80))).cover?.title).toBe(EMOJI.repeat(80));
    expectRefused(v3, "cover.title", EMOJI.repeat(81));
    expect(ok(withField(v3, "steps[0].card.title", EMOJI.repeat(80))).steps[0].card?.title).toBe(EMOJI.repeat(80));
    expectRefused(v3, "steps[0].card.title", EMOJI.repeat(81));
    expect(ok(withField(v3, "cta.label", EMOJI.repeat(24))).cta?.label).toBe(EMOJI.repeat(24));
    expectRefused(v3, "cta.label", EMOJI.repeat(25));
    expect(ok(withField(v2, "title", EMOJI.repeat(200))).title).toBe(EMOJI.repeat(200));
    expectRefused(v2, "title", EMOJI.repeat(201));
    expect(ok(withField(v2, "steps[0].notes[0].text", EMOJI.repeat(500))).steps[0].notes[0].text).toBe(EMOJI.repeat(500));
    expectRefused(v2, "steps[0].notes[0].text", EMOJI.repeat(501));
  });

  const forbidden = ["\u0000", "\u0007", "\t", "\r", "\u001b", "\u007f", "\u0085", "\u009f", "\u200b", "\u200c", "\u200d", "\u200e", "\u200f", "\u202a", "\u202e", "\u2066", "\u2069", "\ufeff", "\u2028", "\u2029", "\u00ad", "\ud800"];

  it.each(forbidden.map((c) => [c.codePointAt(0)!.toString(16).padStart(4, "0"), c]))("refuses U+%s in every text field", (_hex, c) => {
    const text = "a" + c + "b";
    for (const [base, path] of [
      [v3, "title"], [v3, "generator"], [v3, "steps[0].notes[0].text"], [v3, "steps[1].notes[0].text"],
      [v3, "steps[0].card.title"], [v3, "steps[0].card.body"], [v3, "steps[0].card.next_label"],
      [v3, "cover.title"], [v3, "cover.body"], [v3, "cover.button"], [v3, "cta.label"],
      [v3, "end.text"], [v3, "end.primary.label"],
    ] as const) {
      expectRefused(base, path, text);
    }
  });

  it("allows a line break only in the multi-line fields", () => {
    const r = ok(withField(withField(withField(v3, "steps[0].card.body", "a\nb"), "end.text", "a\nb"), "cover.body", "a\nb"));
    expect([r.steps[0].card?.body, r.end?.text, r.cover?.body]).toEqual(["a\nb", "a\nb", "a\nb"]);
    for (const path of ["title", "steps[0].card.title", "steps[0].card.next_label", "cover.title", "cover.button", "cta.label", "end.primary.label"]) {
      expectRefused(v3, path, "a\nb");
    }
  });

  it("the error never echoes the bad value", () => {
    const secret = "S3CRET-" + "x".repeat(400);
    const error = refused(withField(v3, "cover.title", secret));
    expect(error).not.toContain("S3CRET");
    expect(error.length).toBeLessThan(200);
    expect(refused(withField(v3, "cta.url", "javascript:S3CRET"))).not.toContain("S3CRET");
    expect(refused(withField(v3, "theme.card_style", "S3CRET"))).not.toContain("S3CRET");
  });
});

describe("safeUrl", () => {
  it.each([
    [" https://tours.example.com/book ", "https://tours.example.com/book"],
    ["https://tours.example.com", "https://tours.example.com"],
    ["HTTPS://Tours.Example.com/x", "https://Tours.Example.com/x"],
    ["hTtPs://tours.example.com", "https://tours.example.com"],
    ["https://tours.example.com:8443/x?y=1#z", "https://tours.example.com:8443/x?y=1#z"],
    ["https://a-b.c1.example?x", "https://a-b.c1.example?x"],
    ["https://localhost#x", "https://localhost#x"],
    ["https://tours.example.com/\u00e9t\u00e9", "https://tours.example.com/\u00e9t\u00e9"],
    ["https://tours.example.com/a@b", "https://tours.example.com/a@b"],
    ["https://tours.example.com/" + "a".repeat(474), "https://tours.example.com/" + "a".repeat(474)],
  ])("accepts %j", (input, want) => {
    expect(safeUrl(input)).toBe(want);
  });

  it.each([
    "javascript:alert(1)", "http://tours.example.com", "https://", "https://a b.example", "//tours.example.com", "data:text/html,x",
    "HTTPS://\u0000x", "https://?x", "https://#x", "https:///x", "https://tours.example.com/\u0085", "ftp://tours.example.com",
    "https://@", "https://:443", "https://user:pw@evil.example", "https://tours.example.com@evil.example/", "https://@evil.example",
    "https://tours\u202e.example.com", "https://tours.example.com/\u202e", "https://tours.example.com/\u200b", "https://tours.example.com/\ufeff",
    "https://tours.example.com:", "https://tours.example.com:123456", "https://tours.example.com:8a", "https://tours.example.com:-1",
    "https://tours..example.com", "https://.tours.example.com", "https://tours.example.com.", "https://tours_x.example.com",
    "https://tours.ex\u00e4mple.com", "https://[::1]/", "https://127.0.0.1\\@evil.example", "https://tours.example.com\\evil",
    "https://tours.example.com/a\tb", "https://tours.example.com/a\u3000b", "https://tours.example.com/a\u0085b", "https:/tours.example.com", "https:tours.example.com",
    "https://tours.example.com/" + "a".repeat(475),
  ])("refuses %j", (input) => {
    expect(safeUrl(input)).toBeNull();
  });

  it("refuses anything that is not a string", () => {
    for (const v of [null, undefined, 1, {}, ["https://tours.example.com"]]) expect(safeUrl(v)).toBeNull();
  });

  it("counts the 500 cap in code points", () => {
    const base = "https://tours.example.com/";
    expect(safeUrl(base + EMOJI.repeat(500 - base.length))).not.toBeNull();
    expect(safeUrl(base + EMOJI.repeat(501 - base.length))).toBeNull();
  });
});

describe("no slow paths", () => {
  it("long hostile strings are refused quickly", () => {
    const started = Date.now();
    const long = "https://" + "a.".repeat(100_000) + "@";
    expect(safeUrl(long)).toBeNull();
    expect(safeUrl("https://" + "a".repeat(200_000))).toBeNull();
    expect(refused(withField(v3, "steps[0].card.body", "\n".repeat(100_000) + "\u202e"))).toContain("steps[0].card.body");
    expect(refused(withField(v3, "title", " ".repeat(100_000) + "x".repeat(100_000)))).toContain("title");
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
