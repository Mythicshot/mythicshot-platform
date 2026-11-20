// The pages and files a shared link opens (src/media-page.ts), on both targets: the page
// of an image and of a clip with their exact sentences and headers, escaping, the link
// preview tags, the file with ETag and Range, the one 404 for every link that does not
// work, the call budget for the largest clip, and the addresses that answer.
import { describe, expect, it } from "vitest";
import { makeDeps, seedAccount, seedWorkspace } from "#harness";
import { newId, newLinkId } from "../src/auth.ts";
import { SUBREQUEST_BUDGET } from "../src/budget.ts";
import type { Hosts } from "../src/hosts.ts";
import { PART_BYTES } from "../src/media.ts";
import { SHARE_CSS, SHARE_JS } from "../src/media-assets.ts";
import { SHARE_NOT_FOUND_HTML, shareDate, shareDuration } from "../src/media-page.ts";
import type { Deps } from "../src/ports.ts";
import { gif, jpeg, mp4, png, send, type Call } from "./bundle.ts";

const SLOW = { timeout: 300_000 };
const HOSTS: Hosts = { tours: "tours.example.com", app: "app.example.com" };
const THREE: Hosts = { ...HOSTS, img: "img.example.com" };
const IMG = "https://img.example.com";
const TOURS = "https://tours.example.com";
const APP = "https://app.example.com";
const ONLINE_AT = Date.UTC(2026, 10, 19, 15, 30); // 19 Nov 2026
const PAGE_CSP = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const FILE_CSP = "default-src 'none'; sandbox";

type ItemSpec = {
  kind: "image" | "clip";
  content_type: string;
  width: number;
  height: number;
  duration_ms?: number;
  title?: string | null;
  state?: "uploading" | "online" | "closing";
  file: Uint8Array;
  preview?: Uint8Array;
  createdAt?: number;
};

type Seeded = { id: string; link: string; file: Uint8Array };

/** An item written straight into the database and the private store, as the API leaves an item: rows, one object per part, the preview. */
async function seedItem(deps: Deps, workspaceId: string, spec: ItemSpec): Promise<Seeded> {
  const id = newId("med");
  const link = newLinkId();
  const bytes = spec.file.length;
  const parts = Math.ceil(bytes / PART_BYTES);
  const state = spec.state ?? "online";
  const created = spec.createdAt ?? ONLINE_AT - 60_000;
  await deps.db.run(
    `INSERT INTO media (id, workspace_id, link_id, kind, content_type, bytes, parts, width, height, duration_ms, title, state, preview_type, preview_bytes, preview_stored_at, created_at, online_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, workspaceId, link, spec.kind, spec.content_type, bytes, parts, spec.width, spec.height, spec.kind === "clip" ? (spec.duration_ms ?? 12_000) : null,
      spec.title ?? null, state, spec.preview ? "png" : null, spec.preview ? spec.preview.length : null, spec.preview ? created : null, created, state === "online" ? ONLINE_AT : null,
    ],
  );
  for (let n = 0; n < parts; n++) {
    const part = spec.file.subarray(n * PART_BYTES, Math.min(bytes, (n + 1) * PART_BYTES));
    await deps.db.run("INSERT INTO media_part (media_id, n, bytes, claim, stored_at) VALUES (?, ?, ?, NULL, ?)", [id, n, part.length, created]);
    await deps.drafts.put(`m/${id}/part-${String(n).padStart(3, "0")}`, part, { contentType: spec.content_type, cacheControl: "no-store" });
  }
  if (spec.preview) await deps.drafts.put(`m/${id}/preview.png`, spec.preview, { contentType: "image/png", cacheControl: "no-store" });
  return { id, link, file: spec.file };
}

/** A file whose every part is filled with its own number, so a range shows which parts it came from. */
function partsFile(head: Uint8Array, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let n = 0; n * PART_BYTES < bytes; n++) out.fill(n + 1, n * PART_BYTES, Math.min(bytes, (n + 1) * PART_BYTES));
  out.set(head.subarray(0, Math.min(head.length, 32)));
  return out;
}

const IMAGE = (title: string | null = "Loot window, settings tab"): ItemSpec => ({ kind: "image", content_type: "image/png", width: 1920, height: 1080, title, file: png(1920, 1080, 1_468_006, 3) });
const MP4 = (title: string | null = "Sending a note to the raid"): ItemSpec => ({ kind: "clip", content_type: "video/mp4", width: 960, height: 540, duration_ms: 12_000, title, file: partsFile(mp4(64), 2 * PART_BYTES + 500_000) });
const GIF = (title: string | null = null): ItemSpec => ({ kind: "clip", content_type: "image/gif", width: 320, height: 200, duration_ms: 1500, title, file: gif(320, 200, 9000, 5) });

async function world(config?: Parameters<typeof makeDeps>[0]) {
  const ctx = await makeDeps(config);
  const a = await seedWorkspace(ctx.deps, "Acme Secret Workspace");
  return { ...ctx, a };
}

/** Everything a client can see of an answer. */
const seen = (c: Call) => ({ status: c.status, headers: [...c.headers.entries()].sort(), body: c.text });

const at = (origin?: string) => (origin === undefined ? {} : { origin });
const get = (deps: Deps, path: string, headers: Record<string, string> = {}, origin?: string) => send(deps, "GET", path, { headers, ...at(origin) });
const head = (deps: Deps, path: string, headers: Record<string, string> = {}, origin?: string) => send(deps, "HEAD", path, { headers, ...at(origin) });

function expectPageHeaders(r: Call, cache: string): void {
  expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(r.headers.get("content-security-policy")).toBe(PAGE_CSP);
  expect(r.headers.get("x-frame-options")).toBe("DENY");
  expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  expect(r.headers.get("cache-control")).toBe(cache);
  expect(r.headers.get("set-cookie")).toBeNull();
}

function expectFileHeaders(r: Call, type: string): void {
  expect(r.headers.get("content-type")).toBe(type);
  expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  expect(r.headers.get("content-security-policy")).toBe(FILE_CSP);
  expect(r.headers.get("cache-control")).toBe("public, max-age=3600");
  expect(r.headers.get("accept-ranges")).toBe("bytes");
  expect(r.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);
  expect(r.headers.get("set-cookie")).toBeNull();
}

describe("the page of an image", () => {
  it("shows the image, its title and details, the two buttons and the footer, in the mockup's words, with the page headers", SLOW, async () => {
    const { deps, a } = await world();
    const item = await seedItem(deps, a.workspaceId, IMAGE());
    const r = await get(deps, `/i/${item.link}`);
    expect(r.status, r.text).toBe(200);
    expectPageHeaders(r, "public, max-age=60");
    expect(r.calls).toBe(1);
    const t = r.text;
    expect(t).toContain(`<header class="top"><span class="brand">Mythicshot</span><span class="who">Shared image</span></header>`);
    expect(t).toContain("<title>Loot window, settings tab</title>");
    expect(t).toContain("<h1>Loot window, settings tab</h1>");
    expect(t).toContain(`<p class="d">1920 × 1080 · PNG · 1.4 MB · shared 19 Nov 2026</p>`);
    expect(t).toContain(`<img src="/i/${item.link}.png" width="1920" height="1080" alt="Loot window, settings tab">`);
    expect(t).toContain(`<a class="btn" href="/i/${item.link}.png">Open full size</a><a class="btn" href="/i/${item.link}/download">Download</a>`);
    expect(t).toContain(`<footer class="foot">Shared with <a href="https://mythicshot.com/">Mythicshot</a>, a screenshot and recording tool.</footer>`);
    expect(t).toContain(`<link rel="stylesheet" href="/s/share.css">`);
    // An image page has no script, no inline style and no inline handler.
    expect(t).not.toContain("<script");
    expect(t).not.toMatch(/\sstyle=|\son[a-z]+=/i);
    // Nothing about who shared it.
    for (const secret of [item.id, a.workspaceId, "Acme", a.token, "owner-"]) expect(t.includes(secret), secret).toBe(false);
    // A minute in a cache, then a 304 by ETag.
    const etag = r.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const again = await get(deps, `/i/${item.link}`, { "if-none-match": etag });
    expect([again.status, again.bytes.length, again.headers.get("etag")]).toEqual([304, 0, etag]);
  });

  it("an image without a title is an untitled image", SLOW, async () => {
    const { deps, a } = await world();
    const item = await seedItem(deps, a.workspaceId, { ...IMAGE(null), width: 842, height: 311, content_type: "image/jpeg", file: jpeg(842, 311, 90_112) });
    const r = await get(deps, `/i/${item.link}`);
    expect(r.text).toContain("<title>Untitled image</title>");
    expect(r.text).toContain("<h1>Untitled image</h1>");
    expect(r.text).toContain(`<p class="d">842 × 311 · JPEG · 88 KB · shared 19 Nov 2026</p>`);
    expect(r.text).toContain(`src="/i/${item.link}.jpg"`);
  });

  it("every value from the database reaches the page escaped: a title of markup, quotes and </title>", SLOW, async () => {
    const { deps, a } = await world({ hosts: THREE });
    const evil = `</title><script>alert("x")</script><img src=x onerror='alert(1)'> & "quoted" 'single'`;
    const item = await seedItem(deps, a.workspaceId, IMAGE(evil));
    const r = await get(deps, `/i/${item.link}`, {}, IMG);
    expect(r.status).toBe(200);
    const escaped = "&lt;/title&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&lt;img src=x onerror=&#39;alert(1)&#39;&gt; &amp; &quot;quoted&quot; &#39;single&#39;";
    expect(r.text).toContain(`<title>${escaped}</title>`);
    expect(r.text).toContain(`<h1>${escaped}</h1>`);
    expect(r.text).toContain(`alt="${escaped}"`);
    expect(r.text).toContain(`<meta property="og:title" content="${escaped}">`);
    expect(r.text).not.toContain("<script");
    expect(r.text).not.toContain("onerror='");
    expect(r.text.match(/<\/title>/g)?.length).toBe(1);
  });
});

describe("the page of a clip", () => {
  it("an MP4 is a muted, looping, autoplaying inline video with the click-to-pause script and the clip's words", SLOW, async () => {
    const { deps, a } = await world();
    const item = await seedItem(deps, a.workspaceId, { ...MP4(), preview: png(256, 144, 900) });
    const r = await get(deps, `/r/${item.link}`);
    expect(r.status).toBe(200);
    expectPageHeaders(r, "public, max-age=60");
    const t = r.text;
    expect(t).toContain(`<span class="who">Shared clip</span>`);
    expect(t).toContain(
      `<video id="clip" src="/r/${item.link}.mp4" width="960" height="540" poster="/r/${item.link}/preview" muted loop autoplay playsinline preload="auto" tabindex="0" aria-label="Sending a note to the raid"></video>`,
    );
    expect(t).toContain(`<p class="d">12 s · 960 × 540 · MP4 · 4.3 MB · shared 19 Nov 2026</p><p class="d">Plays in a loop, without sound. Click the clip to pause it.</p>`);
    expect(t).toContain(`<a class="btn" href="/r/${item.link}.mp4">Open file</a><a class="btn" href="/r/${item.link}/download">Download</a>`);
    // The one script is the external file: nothing inline.
    expect(t.match(/<script/g)).toEqual(["<script"]);
    expect(t).toContain(`<script src="/s/share.js" defer></script>`);
    expect(t).not.toMatch(/\sstyle=|\son[a-z]+=/i);
  });

  it("a GIF is an image, says it loops without the pause sentence, and is an untitled GIF without a title", SLOW, async () => {
    const { deps, a } = await world();
    const item = await seedItem(deps, a.workspaceId, GIF());
    const r = await get(deps, `/r/${item.link}`);
    expect(r.status).toBe(200);
    expect(r.text).toContain("<h1>Untitled GIF</h1>");
    expect(r.text).toContain(`<img id="clip" src="/r/${item.link}.gif" width="320" height="200" alt="Untitled GIF">`);
    expect(r.text).toContain(`<p class="d">2 s · 320 × 200 · GIF · 8.8 KB · shared 19 Nov 2026</p><p class="d">Plays in a loop, without sound.</p>`);
    expect(r.text).not.toContain("<script");
    // An untitled MP4.
    const clip = await seedItem(deps, a.workspaceId, MP4(null));
    expect((await get(deps, `/r/${clip.link}`)).text).toContain("<h1>Untitled clip</h1>");
  });

  it("dates are in UTC and lengths are seconds, then minutes", () => {
    expect(shareDate(Date.UTC(2026, 10, 19, 23, 59))).toBe("19 Nov 2026");
    expect(shareDate(Date.UTC(2027, 0, 1, 0, 0))).toBe("1 Jan 2027");
    expect([shareDuration(1), shareDuration(1500), shareDuration(12_000), shareDuration(59_400), shareDuration(60_000), shareDuration(125_000)]).toEqual(["1 s", "2 s", "12 s", "59 s", "1 min", "2 min 5 s"]);
  });
});

describe("link preview tags", () => {
  it("with the img address: absolute addresses on it, the image file for an image, the preview and the video for an MP4", SLOW, async () => {
    const { deps, a } = await world({ hosts: THREE });
    const image = await seedItem(deps, a.workspaceId, IMAGE());
    const r = await get(deps, `/i/${image.link}`, {}, IMG);
    expect(r.text).toContain(
      [
        `<meta property="og:title" content="Loot window, settings tab">`,
        `<meta property="og:type" content="website">`,
        `<meta property="og:url" content="${IMG}/i/${image.link}">`,
        `<meta property="og:image" content="${IMG}/i/${image.link}.png">`,
        `<meta property="og:image:width" content="1920">`,
        `<meta property="og:image:height" content="1080">`,
        `<meta name="twitter:card" content="summary_large_image">`,
      ].join("\n"),
    );
    const clip = await seedItem(deps, a.workspaceId, { ...MP4(), preview: png(256, 144, 900) });
    const c = await get(deps, `/r/${clip.link}`, {}, IMG);
    expect(c.text).toContain(
      [
        `<meta property="og:type" content="video.other">`,
        `<meta property="og:url" content="${IMG}/r/${clip.link}">`,
        `<meta property="og:image" content="${IMG}/r/${clip.link}/preview">`,
        `<meta property="og:video" content="${IMG}/r/${clip.link}.mp4">`,
        `<meta property="og:video:secure_url" content="${IMG}/r/${clip.link}.mp4">`,
        `<meta property="og:video:type" content="video/mp4">`,
        `<meta property="og:video:width" content="960">`,
        `<meta property="og:video:height" content="540">`,
        `<meta name="twitter:card" content="summary_large_image">`,
      ].join("\n"),
    );
    // An MP4 without a preview has no picture to show.
    const bare = await seedItem(deps, a.workspaceId, MP4());
    const b = await get(deps, `/r/${bare.link}`, {}, IMG);
    expect(b.text).not.toContain("og:image");
    expect(b.text).toContain(`<meta name="twitter:card" content="summary">`);
  });

  it("with one address and no SITE_HOST: no absolute address at all, whatever host the request names; with SITE_HOST, that origin", SLOW, async () => {
    const { deps, a } = await world();
    const image = await seedItem(deps, a.workspaceId, IMAGE());
    const r = await send(deps, "GET", `/i/${image.link}`, { origin: "https://evil.example.net", headers: { "x-forwarded-host": "evil.example.net" } });
    expect(r.status).toBe(200);
    for (const tag of ["og:url", "og:image", "og:video", "https://"]) expect(r.text.replace("https://mythicshot.com/", ""), tag).not.toContain(tag);
    expect(r.text).toContain(`<meta property="og:title" content="Loot window, settings tab">`);
    expect(r.text).toContain(`<meta name="twitter:card" content="summary">`);

    const site = await world({ siteHost: "share.example.org" });
    const item = await seedItem(site.deps, site.a.workspaceId, IMAGE());
    const s = await send(site.deps, "GET", `/i/${item.link}`, { origin: "https://evil.example.net" });
    expect(s.text).toContain(`<meta property="og:image" content="https://share.example.org/i/${item.link}.png">`);
    expect(s.text).not.toContain("evil");
  });
});

describe("the file", () => {
  it("is answered whole with its stored type, a strong ETag, ranges accepted, and a 304 that reads no part", SLOW, async () => {
    const { deps, a } = await world();
    const item = await seedItem(deps, a.workspaceId, IMAGE());
    const r = await get(deps, `/i/${item.link}.png`);
    expect(r.status).toBe(200);
    expectFileHeaders(r, "image/png");
    expect(r.headers.get("content-length")).toBe(String(item.file.length));
    expect(r.headers.get("content-disposition")).toBe(`inline; filename="${item.link}.png"`);
    expect(r.bytes).toEqual(item.file);
    expect(r.calls).toBe(2);
    const etag = r.headers.get("etag")!;
    const cached = await get(deps, `/i/${item.link}.png`, { "if-none-match": etag });
    expect([cached.status, cached.bytes.length, cached.calls, cached.headers.get("etag")]).toEqual([304, 0, 1, etag]);
    // HEAD: the headers, no body, and no part read.
    const h = await head(deps, `/i/${item.link}.png`);
    expect([h.status, h.bytes.length, h.calls, h.headers.get("content-length"), h.headers.get("content-type")]).toEqual([200, 0, 1, String(item.file.length), "image/png"]);
  });

  it("Download is the same file as an attachment named from the link id and the extension alone", SLOW, async () => {
    const { deps, a } = await world();
    const item = await seedItem(deps, a.workspaceId, { ...MP4(`evil"; filename="x.html`) });
    const r = await get(deps, `/r/${item.link}/download`);
    expect(r.status).toBe(200);
    expectFileHeaders(r, "video/mp4");
    expect(r.headers.get("content-disposition")).toBe(`attachment; filename="${item.link}.mp4"`);
    expect(r.bytes).toEqual(item.file);
  });

  it("stored bytes that look like HTML or SVG are still answered only as the stored type, sandboxed and not sniffed", SLOW, async () => {
    const { deps, a } = await world();
    const html = new TextEncoder().encode(`<!doctype html><html><body><script>alert(document.cookie)</script></body></html>`);
    const svg = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>`);
    const one = await seedItem(deps, a.workspaceId, { kind: "image", content_type: "image/png", width: 10, height: 10, file: html });
    const two = await seedItem(deps, a.workspaceId, { kind: "clip", content_type: "image/gif", width: 10, height: 10, file: svg });
    for (const [path, type, bytes] of [
      [`/i/${one.link}.png`, "image/png", html],
      [`/i/${one.link}/download`, "image/png", html],
      [`/r/${two.link}.gif`, "image/gif", svg],
    ] as const) {
      for (const headers of [{}, { range: "bytes=0-20" }, { accept: "text/html" }] as Record<string, string>[]) {
        const r = await get(deps, path, headers);
        expect(r.status, path).toBe("range" in headers ? 206 : 200);
        expectFileHeaders(r, type);
        expect(bytes.subarray(0, r.bytes.length), path).toEqual(r.bytes);
      }
    }
    // A preview that looks like HTML is answered as a PNG too.
    const three = await seedItem(deps, a.workspaceId, { ...IMAGE(), preview: html });
    const p = await get(deps, `/i/${three.link}/preview`);
    expect([p.status, p.headers.get("content-type"), p.headers.get("x-content-type-options"), p.headers.get("content-security-policy")]).toEqual([200, "image/png", "nosniff", FILE_CSP]);
    expect(p.bytes).toEqual(html);
  });

  it("the preview picture is served under the media rule with fixed headers and an ETag", SLOW, async () => {
    const { deps, a } = await world();
    const preview = png(256, 144, 900, 2);
    const item = await seedItem(deps, a.workspaceId, { ...MP4(), preview });
    const r = await get(deps, `/r/${item.link}/preview`);
    expect(r.status).toBe(200);
    expect(r.bytes).toEqual(preview);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(r.headers.get("content-disposition")).toBe(`inline; filename="${item.link}-preview.png"`);
    const cached = await get(deps, `/r/${item.link}/preview`, { "if-none-match": r.headers.get("etag")! });
    expect([cached.status, cached.calls]).toEqual([304, 1]);
  });
});

describe("Range", () => {
  // A clip of three parts: 2,000,000 + 2,000,000 + 500,000 bytes, each part filled with its number.
  const SIZE = 2 * PART_BYTES + 500_000;

  it("answers one range with 206 and Content-Range, reading only the parts it covers", SLOW, async () => {
    const { deps, a } = await world();
    const item = await seedItem(deps, a.workspaceId, MP4());
    const path = `/r/${item.link}.mp4`;
    const cases: [string, number, number, number][] = [
      // header, first byte, last byte, parts read
      ["bytes=0-0", 0, 0, 1],
      ["bytes=0-", 0, SIZE - 1, 3],
      [`bytes=${SIZE - 1}-`, SIZE - 1, SIZE - 1, 1],
      [`bytes=${SIZE - 1}-${SIZE - 1}`, SIZE - 1, SIZE - 1, 1],
      ["bytes=-1", SIZE - 1, SIZE - 1, 1],
      ["bytes=-100", SIZE - 100, SIZE - 1, 1],
      [`bytes=-${SIZE + 10}`, 0, SIZE - 1, 3],
      // Across the boundary between parts 0 and 1, and exactly on it.
      [`bytes=${PART_BYTES - 10}-${PART_BYTES + 9}`, PART_BYTES - 10, PART_BYTES + 9, 2],
      [`bytes=${PART_BYTES - 1}-${PART_BYTES}`, PART_BYTES - 1, PART_BYTES, 2],
      [`bytes=${PART_BYTES}-${PART_BYTES}`, PART_BYTES, PART_BYTES, 1],
      [`bytes=${PART_BYTES}-${2 * PART_BYTES - 1}`, PART_BYTES, 2 * PART_BYTES - 1, 1],
      // A last byte past the end is the end.
      [`bytes=${2 * PART_BYTES + 5}-${SIZE * 10}`, 2 * PART_BYTES + 5, SIZE - 1, 1],
      ["bytes = 5 - 9", 5, 9, 1],
    ];
    for (const [range, first, last, parts] of cases) {
      const r = await get(deps, path, { range });
      expect(r.status, range).toBe(206);
      expectFileHeaders(r, "video/mp4");
      expect(r.headers.get("content-range"), range).toBe(`bytes ${first}-${last}/${SIZE}`);
      expect(r.headers.get("content-length"), range).toBe(String(last - first + 1));
      expect(r.bytes.length, range).toBe(last - first + 1);
      expect(r.bytes, range).toEqual(item.file.subarray(first, last + 1));
      expect(r.calls, range).toBe(1 + parts);
    }
  });

  it("a range the file cannot satisfy is 416 with the size; several ranges, a malformed one or another unit answer the whole file", SLOW, async () => {
    const { deps, a } = await world();
    const item = await seedItem(deps, a.workspaceId, MP4());
    const path = `/r/${item.link}.mp4`;
    for (const range of [`bytes=${SIZE}-`, `bytes=${SIZE}-${SIZE + 5}`, `bytes=${SIZE * 3}-`, "bytes=-0"]) {
      const r = await get(deps, path, { range });
      expect([r.status, r.headers.get("content-range"), r.bytes.length, r.calls], range).toEqual([416, `bytes */${SIZE}`, 0, 1]);
      expect(r.headers.get("content-type"), range).toBe("video/mp4");
      expect(r.headers.get("content-security-policy"), range).toBe(FILE_CSP);
    }
    for (const range of ["bytes=0-1,5-9", "bytes=0-1, 10-", "bytes=9-5", "bytes=abc", "items=0-5", "bytes=", "bytes=-", "bytes=99999999999999999999-"]) {
      const r = await get(deps, path, { range });
      expect([r.status, r.headers.get("content-range"), r.bytes.length], range).toEqual([200, null, SIZE]);
    }
    // If-Range with another validator answers the whole file; with the file's own ETag, the range.
    const etag = (await head(deps, path)).headers.get("etag")!;
    expect((await get(deps, path, { range: "bytes=0-9", "if-range": '"other"' })).status).toBe(200);
    expect((await get(deps, path, { range: "bytes=0-9", "if-range": etag })).status).toBe(206);
    // HEAD with a range: the 206 headers and no part read.
    const h = await head(deps, path, { range: "bytes=10-19" });
    expect([h.status, h.headers.get("content-range"), h.headers.get("content-length"), h.calls]).toEqual([206, `bytes 10-19/${SIZE}`, "10", 1]);
  });

  it("the largest clip, 27 parts, streams whole within the call budget, and its last range reads one part", SLOW, async () => {
    const { deps, a } = await world();
    const bytes = 26 * PART_BYTES + 1_000;
    const item = await seedItem(deps, a.workspaceId, { ...MP4(), file: partsFile(mp4(64), bytes) });
    const r = await get(deps, `/r/${item.link}.mp4`);
    expect(r.status).toBe(200);
    expect(r.bytes.length).toBe(bytes);
    for (let n = 0; n < 27; n++) expect(r.bytes[n * PART_BYTES + 100], `part ${n}`).toBe(n + 1);
    expect(r.bytes.subarray(0, 32)).toEqual(item.file.subarray(0, 32));
    expect(r.calls).toBe(28);
    expect(r.calls).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
    const tail = await get(deps, `/r/${item.link}.mp4`, { range: "bytes=-500" });
    expect([tail.status, tail.calls, tail.bytes.every((b) => b === 27)]).toEqual([206, 2, true]);
  });

  it("an online item whose part has gone from the store is the 404 page, not a short file", SLOW, async () => {
    const { deps, a } = await world();
    const item = await seedItem(deps, a.workspaceId, IMAGE());
    await deps.drafts.delete([`m/${item.id}/part-000`]);
    const r = await get(deps, `/i/${item.link}.png`);
    expect([r.status, r.text]).toEqual([404, SHARE_NOT_FOUND_HTML]);
  });
});

describe("a link that does not work", () => {
  it("deleted, unfinished, closing, of a disabled account, malformed, unknown, by database id, of the other kind or with the wrong extension: one 404, byte for byte", SLOW, async () => {
    const { deps, a } = await world();
    const live = await seedItem(deps, a.workspaceId, IMAGE());
    const clip = await seedItem(deps, a.workspaceId, MP4());
    const uploading = await seedItem(deps, a.workspaceId, { ...IMAGE(), state: "uploading" });
    const stale = await seedItem(deps, a.workspaceId, { ...IMAGE(), state: "uploading", createdAt: ONLINE_AT - 3 * 24 * 3_600_000 });
    const closing = await seedItem(deps, a.workspaceId, { ...IMAGE(), state: "closing" });
    const deleted = await seedItem(deps, a.workspaceId, IMAGE());
    await deps.db.batch([
      { sql: "DELETE FROM media_part WHERE media_id = ?", params: [deleted.id] },
      { sql: "DELETE FROM media WHERE id = ?", params: [deleted.id] },
    ]);
    const off = await seedAccount(deps);
    const disabled = await seedItem(deps, off.workspaceId, { ...MP4(), preview: png(64, 64, 500) });
    await deps.db.run("UPDATE user SET status = 'disabled' WHERE id = ?", [off.userId]);

    const reference = await get(deps, `/i/${newLinkId()}`);
    expect(reference.status).toBe(404);
    expect(reference.text).toBe(SHARE_NOT_FOUND_HTML);
    expectPageHeaders(reference, "no-store");
    expect(reference.text).toContain("<title>This link no longer works</title>");
    expect(reference.text).toContain(
      `<main class="gone"><h1>This link no longer works</h1><p>The image or clip it pointed to was deleted, or the link is not complete. Ask whoever sent it to you for a new one.</p></main>`,
    );
    expect(reference.calls).toBe(1);

    const paths: string[] = [];
    for (const item of [uploading, stale, closing, deleted]) paths.push(`/i/${item.link}`, `/i/${item.link}.png`, `/i/${item.link}/download`, `/i/${item.link}/preview`);
    paths.push(`/r/${disabled.link}`, `/r/${disabled.link}.mp4`, `/r/${disabled.link}/download`, `/r/${disabled.link}/preview`);
    paths.push(
      // By database id, in every form.
      `/i/${live.id}`, `/i/${live.id}.png`, `/i/${live.id}/download`, `/i/${live.id.slice(4)}`,
      // The other kind's letter, the wrong extension, an extension that is no type, no preview.
      `/r/${live.link}`, `/r/${live.link}.png`, `/i/${clip.link}`, `/i/${live.link}.jpg`, `/i/${live.link}.gif`, `/i/${live.link}.html`, `/i/${live.link}.png.png`, `/i/${live.link}/preview`, `/r/${clip.link}.gif`,
      `/r/${clip.link}.mp4/download`, `/i/${live.link}.png/preview`,
      // Malformed: too short, too long, capitals, other letters, encoded, empty-ish.
      `/i/${live.link.slice(0, 19)}`, `/i/${live.link}a`, `/i/${live.link.toUpperCase()}`, "/i/abcdefghijklmnopqrs1", "/i/x", `/r/${"a".repeat(200)}`, "/i/aaaaaaaaaaaaaaaaaaa%00",
    );
    for (const path of paths) {
      const r = await get(deps, path);
      expect(seen(r), path).toEqual(seen(reference));
      expect(r.calls, path).toBe(1);
      // With a validator and a range it is the same 404.
      expect(seen(await get(deps, path, { "if-none-match": "*", range: "bytes=0-0" })), path).toEqual(seen(reference));
      const h = await head(deps, path);
      expect([h.status, [...h.headers.entries()].sort()], path).toEqual([404, seen(reference).headers]);
    }
    // The live items still answer.
    expect((await get(deps, `/i/${live.link}`)).status).toBe(200);
    expect((await get(deps, `/r/${clip.link}.mp4`, { range: "bytes=0-0" })).status).toBe(206);
    // Enabling the account again brings its item back: the rule is the account, nothing was removed.
    await deps.db.run("UPDATE user SET status = 'active' WHERE id = ?", [off.userId]);
    expect((await get(deps, `/r/${disabled.link}`)).status).toBe(200);
  });
});

describe("the pages' files and the addresses", () => {
  it("the stylesheet and the script are fixed text, an hour in a cache, with an ETag", SLOW, async () => {
    const { deps } = await makeDeps();
    for (const [path, body, type] of [["/s/share.css", SHARE_CSS, "text/css; charset=utf-8"], ["/s/share.js", SHARE_JS, "text/javascript; charset=utf-8"]] as const) {
      const r = await get(deps, path);
      expect([r.status, r.text, r.headers.get("content-type"), r.headers.get("cache-control"), r.headers.get("x-content-type-options"), r.calls]).toEqual([200, body, type, "public, max-age=3600", "nosniff", 0]);
      const again = await get(deps, path, { "if-none-match": r.headers.get("etag")! });
      expect(again.status).toBe(304);
    }
    expect(SHARE_CSS).not.toMatch(/url\(|@import/);
  });

  it("with IMG_HOST set they answer only there; with two addresses only on the tours address", SLOW, async () => {
    const three = await world({ hosts: THREE });
    const item = await seedItem(three.deps, three.a.workspaceId, { ...MP4(), preview: png(64, 64, 500) });
    const paths = [`/r/${item.link}`, `/r/${item.link}.mp4`, `/r/${item.link}/download`, `/r/${item.link}/preview`, "/s/share.css", "/s/share.js"];
    for (const path of paths) {
      expect((await get(three.deps, path, {}, IMG)).status, path).toBe(200);
      for (const origin of [TOURS, APP]) {
        const r = await get(three.deps, path, {}, origin);
        expect([r.status, r.text, r.calls], `${origin} ${path}`).toEqual([404, '{"error":"not_found"}', 0]);
      }
      expect((await get(three.deps, path, {}, "https://evil.example.net")).status, path).toBe(421);
    }
    const two = await world({ hosts: HOSTS });
    const other = await seedItem(two.deps, two.a.workspaceId, MP4());
    expect((await get(two.deps, `/r/${other.link}`, {}, TOURS)).status).toBe(200);
    expect((await get(two.deps, `/r/${other.link}`, {}, APP)).status).toBe(404);
    expect((await get(two.deps, `/r/${other.link}`, {}, IMG)).status).toBe(421);
  });

  it("no token and no cookie is read: a request carrying them gets the same answer and nothing records a use", SLOW, async () => {
    const { deps, a } = await world();
    const item = await seedItem(deps, a.workspaceId, IMAGE());
    const plain = await get(deps, `/i/${item.link}`);
    const used = await deps.db.first<{ last_used_at: number | null }>("SELECT last_used_at FROM api_token LIMIT 1");
    const carrying = await send(deps, "GET", `/i/${item.link}`, { token: a.token, headers: { cookie: "dp_session=abc; other=1" } });
    expect(seen(carrying)).toEqual(seen(plain));
    expect(await deps.db.first("SELECT last_used_at FROM api_token LIMIT 1")).toEqual(used);
  });
});
