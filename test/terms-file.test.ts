// The terms file (parseTerms in src/terms.ts) on both targets: the example in docs/ reads as it
// says, every rule refuses with its one line naming the line, the caps are where they are said
// to be, markup and odd text are kept as text, and the canonical form and its digest are the
// same for two files that read the same.
import { describe, expect, it } from "vitest";
import { TERMS_FILE_SAYS, TERMS_LIMITS, canonicalTerms, lineSays, parseTerms, termsBlocks, termsDigest } from "../src/terms.ts";

const EXAMPLE = Object.values(import.meta.glob("../docs/terms-example.txt", { query: "?raw", import: "default", eager: true }))[0] as string;
const enc = (s: string) => new TextEncoder().encode(s);
const read = (s: string) => parseTerms(enc(s));
async function refused(s: string | Uint8Array): Promise<string> {
  const r = await parseTerms(typeof s === "string" ? enc(s) : s);
  if (r.ok) throw new Error("taken");
  return r.reason;
}
const MIN = "title: T\nversion: 1\nmain points:\n- P\nterms:\nBody.\n";

describe("the example file in docs/", () => {
  it("reads as the format says: title, version, three links, five points and the full terms in blocks", async () => {
    const r = await read(EXAMPLE);
    if (!r.ok) throw new Error(r.reason);
    expect(r.terms.title).toBe("Mythicshot terms of service");
    expect(r.terms.version).toBe("21 November 2026");
    expect(r.terms.links).toEqual([
      { label: "terms", url: "https://example.com/terms" },
      { label: "Your data", url: "https://example.com/data" },
      { label: "Privacy", url: "https://example.com/privacy" },
    ]);
    expect(r.terms.points).toHaveLength(5);
    expect(r.terms.blocks[0]).toEqual({ kind: "heading", text: "1. Who we are" });
    expect(r.terms.blocks[1]).toEqual({ kind: "paragraph", text: "This site is run by its owner. These terms are between you and the owner of this site. They apply to everything you do on the site." });
    expect(r.terms.blocks.find((b) => b.kind === "list")).toEqual({ kind: "list", items: ["you have the right to share what you upload;", "it breaks no law;", "it does not harm anyone."] });
    expect(termsBlocks(r.terms.body)).toEqual(r.terms.blocks);
    expect(r.sha256).toBe(await termsDigest(r.canonical));
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The canonical form reads back to the same terms and the same digest.
    const again = await read(r.canonical);
    if (!again.ok) throw new Error(again.reason);
    expect([again.terms, again.canonical, again.sha256]).toEqual([r.terms, r.canonical, r.sha256]);
  });
});

describe("two files that read the same are one content", () => {
  it("line ends, spaces at either end of a line, blank lines and a leading byte order mark do not change the canonical form", async () => {
    const plain = await read(MIN);
    const messy = await read("\ufefftitle:   T  \r\n\r\nversion: 1\r\n\r\nmain points:\r\n  - P  \r\n\r\nterms:\r\n\r\n\r\n   Body.   \r\n\r\n\r\n");
    if (!plain.ok || !messy.ok) throw new Error("refused");
    expect(messy.canonical).toBe(plain.canonical);
    expect(messy.sha256).toBe(plain.sha256);
    // Any change of a word is another content.
    const other = await read(MIN.replace("Body.", "Body!"));
    if (!other.ok) throw new Error("refused");
    expect(other.sha256).not.toBe(plain.sha256);
    expect(canonicalTerms(plain.terms)).toBe(plain.canonical);
  });

  it("paragraphs keep their own line breaks in the stored text, and a run of blank lines becomes one", async () => {
    const r = await read("title: T\nversion: 1\nmain points:\n- P\nterms:\nOne\ntwo\n\n\n\n# H\n- a\n- b\nafter the list\n");
    if (!r.ok) throw new Error(r.reason);
    expect(r.terms.body).toBe("One\ntwo\n\n# H\n- a\n- b\nafter the list");
    expect(r.terms.blocks).toEqual([
      { kind: "paragraph", text: "One two" },
      { kind: "heading", text: "H" },
      { kind: "list", items: ["a", "b"] },
      { kind: "paragraph", text: "after the list" },
    ]);
  });
});

describe("markup and odd text are text", () => {
  it("every field keeps markup, script, quotes, entities, right-to-left letters, joined emoji and combining marks exactly, and nothing more", async () => {
    const odd = ['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', "&amp; &lt;b&gt; </title>", "שלום עולם مرحبا", "👩‍👩‍👧 é ë̃", "javascript:alert(1)"];
    for (const t of odd) {
      const file = `title: ${t}\nversion: ${t}\nlink: ${t} | https://example.com/x\nmain points:\n- ${t}\nterms:\n# ${t}\n${t}\n- ${t}\n`;
      const r = await read(file);
      if (!r.ok) throw new Error(`${t}: ${r.reason}`);
      expect(r.terms.title, t).toBe(t);
      expect(r.terms.version, t).toBe(t);
      expect(r.terms.links[0].label, t).toBe(t);
      expect(r.terms.points, t).toEqual([t]);
      expect(r.terms.blocks, t).toEqual([{ kind: "heading", text: t }, { kind: "paragraph", text: t }, { kind: "list", items: [t] }]);
    }
  });

  it("a link is only an explicit link: line, and only an https address of the strict shape", async () => {
    const link = (url: string) => refused(`title: T\nversion: 1\nlink: L | ${url}\nmain points:\n- P\nterms:\nB\n`);
    for (const bad of ["http://example.com/", "javascript:alert(1)", "https://user:pass@example.com/", "https://example.com/#part", "https://127.0.0.1/", "https://[::1]/", "//example.com/", "https://exa mple.com/", 'https://example.com/"onclick', "https://example.com/<x>", `https://example.com/${"a".repeat(TERMS_LIMITS.linkUrlChars)}`]) {
      expect(await link(bad), bad).toBe(lineSays(3, TERMS_FILE_SAYS.badLinkUrl));
    }
    // An address in the text is text, never a link.
    const r = await read("title: T\nversion: 1\nmain points:\n- See https://example.com/\nterms:\nhttps://example.com/\n");
    if (!r.ok) throw new Error(r.reason);
    expect(r.terms.links).toEqual([]);
  });
});

describe("every refusal is one line that names the line", () => {
  it("the file as a whole", async () => {
    expect(await refused("")).toBe(TERMS_FILE_SAYS.empty);
    expect(await refused("\n\n  \n")).toBe(TERMS_FILE_SAYS.empty);
    expect(await refused(new Uint8Array(TERMS_LIMITS.fileBytes + 1).fill(0x41))).toBe(TERMS_FILE_SAYS.tooLarge);
    expect(await refused(new Uint8Array([0x74, 0x69, 0xff, 0x0a]))).toBe(TERMS_FILE_SAYS.notUtf8);
    expect(TERMS_FILE_SAYS.tooLarge).toBe("the file is larger than 262,144 bytes.");
  });

  it("characters no line may hold: controls, separators, direction controls, a byte order mark past the start", async () => {
    for (const c of ["\u0000", "\u0007", "\u001b", "\t", "\r", "\u007f", "\u0085", "\u009b", "\u2028", "\u2029", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069", "\ufeff", "\uffff"]) {
      expect(await refused(MIN.replace("Body.", `Bo${c}dy.`)), JSON.stringify(c)).toBe(lineSays(6, TERMS_FILE_SAYS.badCharacter));
      // A CR at the very end of a line is its line end (CR LF), so it is tried inside the line only.
      if (c !== "\r") expect(await refused(MIN.replace("title: T", `title: T${c}`)), JSON.stringify(c)).toBe(lineSays(1, TERMS_FILE_SAYS.badCharacter));
    }
  });

  it("the header lines, in their order", async () => {
    expect(await refused("version: 1\n")).toBe(lineSays(1, TERMS_FILE_SAYS.needTitle));
    expect(await refused("\n\nTitle: T\n")).toBe(lineSays(3, TERMS_FILE_SAYS.needTitle));
    expect(await refused("title:\n")).toBe(lineSays(1, TERMS_FILE_SAYS.emptyTitle));
    expect(await refused(`title: ${"t".repeat(TERMS_LIMITS.titleChars + 1)}\n`)).toBe(lineSays(1, TERMS_FILE_SAYS.longTitle));
    expect(await refused("title: T\nmain points:\n")).toBe(lineSays(2, TERMS_FILE_SAYS.needVersion));
    expect(await refused("title: T\n")).toBe(lineSays(1, TERMS_FILE_SAYS.noTermsLine));
    expect(await refused("title: T\nversion:\n")).toBe(lineSays(2, TERMS_FILE_SAYS.emptyVersion));
    expect(await refused(`title: T\nversion: ${"v".repeat(TERMS_LIMITS.versionChars + 1)}\n`)).toBe(lineSays(2, TERMS_FILE_SAYS.longVersion));
    expect(await refused("title: T\nversion: 1\n- P\n")).toBe(lineSays(3, TERMS_FILE_SAYS.needPointsOrLink));
    expect(await refused("title: T\nversion: 1\nlink: no bar\n")).toBe(lineSays(3, TERMS_FILE_SAYS.badLink));
    expect(await refused("title: T\nversion: 1\nlink:  | https://example.com/\n")).toBe(lineSays(3, TERMS_FILE_SAYS.emptyLinkLabel));
    expect(await refused(`title: T\nversion: 1\nlink: ${"l".repeat(TERMS_LIMITS.linkLabelChars + 1)} | https://example.com/\n`)).toBe(lineSays(3, TERMS_FILE_SAYS.longLinkLabel));
    const four = "title: T\nversion: 1\n" + "link: L | https://example.com/\n".repeat(4) + "main points:\n- P\nterms:\nB\n";
    expect(await refused(four)).toBe(lineSays(6, TERMS_FILE_SAYS.tooManyLinks));
    expect(await refused("title: T\nversion: 1\nmain points:\n")).toBe(lineSays(3, TERMS_FILE_SAYS.noTermsLine));
    expect(await refused("title: T\nversion: 1\nmain points:\nterms:\nB\n")).toBe(lineSays(4, TERMS_FILE_SAYS.noPoints));
    expect(await refused("title: T\nversion: 1\nmain points:\nP\n")).toBe(lineSays(4, TERMS_FILE_SAYS.needPoint));
    expect(await refused("title: T\nversion: 1\nmain points:\n-\n")).toBe(lineSays(4, TERMS_FILE_SAYS.emptyPoint));
    expect(await refused(`title: T\nversion: 1\nmain points:\n- ${"p".repeat(TERMS_LIMITS.pointChars + 1)}\n`)).toBe(lineSays(4, TERMS_FILE_SAYS.longPoint));
    const thirteen = "title: T\nversion: 1\nmain points:\n" + "- P\n".repeat(13) + "terms:\nB\n";
    expect(await refused(thirteen)).toBe(lineSays(16, TERMS_FILE_SAYS.tooManyPoints));
  });

  it("the full terms", async () => {
    expect(await refused("title: T\nversion: 1\nmain points:\n- P\nterms:\n\n\n")).toBe(lineSays(5, TERMS_FILE_SAYS.noBody));
    expect(await refused("title: T\nversion: 1\nmain points:\n- P\nterms:\n")).toBe(lineSays(5, TERMS_FILE_SAYS.noBody));
    expect(await refused(MIN.replace("Body.", "Body.\n\n#"))).toBe(lineSays(8, TERMS_FILE_SAYS.emptyHeading));
    expect(await refused(MIN.replace("Body.", "Body.\n-"))).toBe(lineSays(7, TERMS_FILE_SAYS.emptyBullet));
    expect(await refused(MIN.replace("Body.", `# ${"h".repeat(TERMS_LIMITS.headingChars + 1)}`))).toBe(lineSays(6, TERMS_FILE_SAYS.longHeading));
    // A line of # that is not "# " is text.
    const hash = await read(MIN.replace("Body.", "#1 is text"));
    expect(hash.ok && hash.terms.blocks).toEqual([{ kind: "paragraph", text: "#1 is text" }]);
  });
});

describe("the sentences", () => {
  it("every reason a file is refused, word for word, as the owner is asked to approve them", () => {
    expect({ ...TERMS_FILE_SAYS }).toEqual({
      empty: "the file is empty.",
      tooLarge: "the file is larger than 262,144 bytes.",
      notUtf8: "the file is not UTF-8 text.",
      badCharacter: "this line has a character that is not allowed: a control character, a line or paragraph separator, or a character that changes the direction of text.",
      needTitle: 'the file must start with the line "title: <the title of the terms>".',
      emptyTitle: "the title is empty.",
      longTitle: "the title is longer than 200 characters.",
      needVersion: 'the line after the title must be "version: <the label of this version>".',
      emptyVersion: "the version's label is empty.",
      longVersion: "the version's label is longer than 100 characters.",
      needPointsOrLink: 'expected "link: <label> | https://…" or "main points:".',
      badLink: 'a link is written "link: <label> | https://…".',
      emptyLinkLabel: "the link's label is empty.",
      longLinkLabel: "the link's label is longer than 60 characters.",
      badLinkUrl: "the link's address must be an https address of at most 300 characters, with a host name, no user name or password, and no # part.",
      tooManyLinks: "there can be at most 3 links.",
      needPoint: 'under "main points:" each line starts with "- ", until the line "terms:".',
      emptyPoint: "this main point is empty.",
      longPoint: "this main point is longer than 300 characters.",
      tooManyPoints: "there can be at most 12 main points.",
      noPoints: 'there must be at least one main point before "terms:".',
      noTermsLine: 'the file ends before the line "terms:".',
      emptyHeading: "this heading is empty.",
      longHeading: "this heading is longer than 300 characters.",
      emptyBullet: "this bullet is empty.",
      noBody: 'there are no terms after "terms:".',
      longBody: "the full terms pass 200,000 bytes on this line.",
    });
    expect(lineSays(4, "x")).toBe("line 4: x");
  });
});

describe("the caps are where they are said to be", () => {
  it("each cap is taken exactly and refused one past it", async () => {
    const at = (title: string, version: string, points: string[], body: string) => `title: ${title}\nversion: ${version}\nmain points:\n${points.map((p) => `- ${p}`).join("\n")}\nterms:\n${body}\n`;
    // Characters are code points: four-byte letters count once.
    const wide = "😀".repeat(TERMS_LIMITS.titleChars);
    const r = await read(at(wide, "v".repeat(TERMS_LIMITS.versionChars), Array.from({ length: TERMS_LIMITS.points }, () => "p".repeat(TERMS_LIMITS.pointChars)), "x"));
    expect(r.ok).toBe(true);
    // The full terms: 200,000 bytes are taken, one more is not.
    const line = "y".repeat(999);
    const lines = Array.from({ length: 200 }, () => line);
    const exact = lines.join("\n");
    expect(new TextEncoder().encode(exact).byteLength).toBe(200 * 999 + 199);
    const fill = TERMS_LIMITS.bodyBytes - (200 * 999 + 199);
    const full = exact + "\n" + "z".repeat(fill - 1);
    expect(new TextEncoder().encode(full).byteLength).toBe(TERMS_LIMITS.bodyBytes);
    const ok = await read(at("T", "1", ["P"], full));
    expect(ok.ok).toBe(true);
    expect(await refused(at("T", "1", ["P"], full + "z"))).toBe(lineSays(206, TERMS_FILE_SAYS.longBody));
    expect(TERMS_LIMITS).toEqual({ fileBytes: 262_144, bodyBytes: 200_000, titleChars: 200, versionChars: 100, points: 12, pointChars: 300, links: 3, linkLabelChars: 60, linkUrlChars: 300, headingChars: 300 });
  });
});
