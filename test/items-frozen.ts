// The fixed public shared items whose answers test/fixtures/public-items-0.1.46.json holds,
// as 0.1.46 answered them (commit b7cf43f, src/media-page.ts): every public route of an
// image and a clip, whole and in ranges, conditional, HEAD, the 404s and the two files, in
// the three address modes. test/media-access-serve.test.ts sends the same requests to the
// current build and holds every answer to those bytes and those call counts, with and
// without viewer cookies, so restricting items changed nothing of a public one.
//
// Everything is fixed: the ids, link ids, claims, bytes and times, so the ETags are too.
import type { Hosts } from "../src/hosts.ts";
import type { Deps } from "../src/ports.ts";
import { gif, jpeg, mp4, png, sha256Hex, type Call } from "./bundle.ts";

const PART = 2_000_000;
const ONLINE_AT = Date.UTC(2026, 10, 19, 15, 30);

/** The three address modes the answers were taken in: the media address's origin in each. */
export const FROZEN_MODES: { name: string; hosts: Hosts | null; siteHost?: string; origin: string }[] = [
  { name: "one", hosts: null, origin: "https://tours.example.com" },
  { name: "one with SITE_HOST", hosts: null, siteHost: "tours.example.com", origin: "https://tours.example.com" },
  { name: "two", hosts: { tours: "tours.example.com", app: "app.example.com" }, origin: "https://tours.example.com" },
  { name: "three", hosts: { tours: "tours.example.com", app: "app.example.com", img: "img.example.com" }, origin: "https://img.example.com" },
];

type Spec = { id: string; link: string; kind: "image" | "clip"; type: string; width: number; height: number; duration: number | null; title: string | null; file: Uint8Array; preview: Uint8Array | null; claims: string[]; previewClaim: string };

const hex = (n: number, len = 24) => n.toString(16).padStart(len, "0");

/** The items: a titled PNG with a preview, an untitled JPEG, a GIF with a preview, and an MP4 of two parts without one. */
export function frozenItems(): Spec[] {
  return [
    { id: "med_" + hex(1), link: "aaaaaaaaaaaaaaaaaaa2", kind: "image", type: "image/png", width: 40, height: 30, duration: null, title: "Frozen <b>image</b> & \"quotes\"", file: png(40, 30, 3000, 7), preview: png(16, 12, 400, 9), claims: [hex(11)], previewClaim: hex(12) },
    { id: "med_" + hex(2), link: "aaaaaaaaaaaaaaaaaaa3", kind: "image", type: "image/jpeg", width: 20, height: 20, duration: null, title: null, file: jpeg(20, 20, 2500, 5), preview: null, claims: [hex(21)], previewClaim: hex(22) },
    { id: "med_" + hex(3), link: "aaaaaaaaaaaaaaaaaaa4", kind: "clip", type: "image/gif", width: 32, height: 24, duration: 4200, title: "Frozen clip", file: gif(32, 24, 5000, 3), preview: png(16, 12, 400, 4), claims: [hex(31)], previewClaim: hex(32) },
    { id: "med_" + hex(4), link: "aaaaaaaaaaaaaaaaaaa5", kind: "clip", type: "video/mp4", width: 64, height: 36, duration: 75_000, title: "Frozen video", file: mp4(PART + 1234, 2), preview: null, claims: [hex(41), hex(42)], previewClaim: hex(43) },
  ];
}

/** Writes the items into the database and the private store, as the API leaves an online item. */
export async function seedFrozen(deps: Deps, workspaceId: string): Promise<Spec[]> {
  const items = frozenItems();
  for (const s of items) {
    const parts = Math.ceil(s.file.length / PART);
    await deps.db.run(
      `INSERT INTO media (id, workspace_id, link_id, kind, content_type, bytes, parts, width, height, duration_ms, title, state, created_at, online_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'online', ?, ?)`,
      [s.id, workspaceId, s.link, s.kind, s.type, s.file.length, parts, s.width, s.height, s.duration, s.title, ONLINE_AT - 60_000, ONLINE_AT],
    );
    for (let n = 0; n < parts; n++) {
      const part = s.file.subarray(n * PART, Math.min(s.file.length, (n + 1) * PART));
      await deps.db.run("INSERT INTO media_object (media_id, claim, n, ext, bytes, claimed_at, stored_at, current) VALUES (?, ?, ?, NULL, ?, ?, ?, 1)", [s.id, s.claims[n], n, part.length, ONLINE_AT - 60_000, ONLINE_AT - 60_000]);
      await deps.drafts.put(`m/${s.id}/part-${String(n).padStart(3, "0")}.${s.claims[n]}`, part, { contentType: s.type, cacheControl: "no-store" });
    }
    if (s.preview !== null) {
      await deps.db.run("INSERT INTO media_object (media_id, claim, n, ext, bytes, claimed_at, stored_at, current) VALUES (?, ?, -1, 'png', ?, ?, ?, 1)", [s.id, s.previewClaim, s.preview.length, ONLINE_AT - 60_000, ONLINE_AT - 60_000]);
      await deps.drafts.put(`m/${s.id}/preview.${s.previewClaim}.png`, s.preview, { contentType: "image/png", cacheControl: "no-store" });
    }
  }
  return items;
}

/** One request of the fixture. `etagOf`: send If-None-Match (or If-Range) with the ETag the request at that index answered. */
export type FrozenRequest = { method: string; path: string; headers?: Record<string, string>; etagOf?: { index: number; header: "if-none-match" | "if-range" } };

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "video/mp4": "mp4" };

/** Every request, in order: index-based ETag references point back into this list. */
export function frozenRequests(): FrozenRequest[] {
  const out: FrozenRequest[] = [];
  for (const s of frozenItems()) {
    const page = `/${s.kind === "image" ? "i" : "r"}/${s.link}`;
    const file = `${page}.${EXT[s.type]}`;
    const pageAt = out.length;
    out.push({ method: "GET", path: page });
    out.push({ method: "GET", path: page, etagOf: { index: pageAt, header: "if-none-match" } });
    out.push({ method: "HEAD", path: page });
    const fileAt = out.length;
    out.push({ method: "GET", path: file });
    out.push({ method: "HEAD", path: file });
    out.push({ method: "GET", path: file, etagOf: { index: fileAt, header: "if-none-match" } });
    out.push({ method: "GET", path: file, headers: { range: "bytes=0-99" } });
    out.push({ method: "GET", path: file, headers: { range: "bytes=-10" } });
    out.push({ method: "GET", path: file, headers: { range: "bytes=1999990-2000009" } });
    out.push({ method: "GET", path: file, headers: { range: "bytes=99999999-" } });
    out.push({ method: "GET", path: file, headers: { range: "bytes=0-1,4-5" } });
    out.push({ method: "GET", path: file, headers: { range: "bytes=0-9", "if-range": '"0123"' } });
    out.push({ method: "GET", path: file, headers: { range: "bytes=0-9" }, etagOf: { index: fileAt, header: "if-range" } });
    out.push({ method: "GET", path: `${page}/download` });
    out.push({ method: "GET", path: `${page}/download`, headers: { range: "bytes=5-15" } });
    const previewAt = out.length;
    out.push({ method: "GET", path: `${page}/preview` });
    out.push({ method: "HEAD", path: `${page}/preview` });
    out.push({ method: "GET", path: `${page}/preview`, etagOf: { index: previewAt, header: "if-none-match" } });
    out.push({ method: "GET", path: `${page}.${s.type === "image/png" ? "jpg" : "png"}` });
    out.push({ method: "GET", path: `/${s.kind === "image" ? "r" : "i"}/${s.link}` });
  }
  out.push({ method: "GET", path: "/i/zzzzzzzzzzzzzzzzzzzz" });
  out.push({ method: "GET", path: "/i/zzzzzzzzzzzzzzzzzzzz.png" });
  out.push({ method: "GET", path: "/r/zzzzzzzzzzzzzzzzzzzz/download" });
  out.push({ method: "GET", path: "/r/zzzzzzzzzzzzzzzzzzzz/preview" });
  out.push({ method: "GET", path: "/i/not-a-link" });
  out.push({ method: "GET", path: "/s/share.css" });
  out.push({ method: "GET", path: "/s/share.js" });
  return out;
}

/** The request's own headers, with the ETag it refers to when that answer had one. */
export function headersFor(r: FrozenRequest, before: FrozenAnswer[]): Record<string, string> {
  const headers: Record<string, string> = { ...r.headers };
  const etag = r.etagOf === undefined ? undefined : before[r.etagOf.index].headers.find(([k]) => k === "etag")?.[1];
  if (r.etagOf !== undefined && etag !== undefined) headers[r.etagOf.header] = etag;
  return headers;
}

/** What the fixture holds of one answer: status, every header, the body (text, or its length and digest when it is not text), and the calls. */
export type FrozenAnswer = { status: number; headers: [string, string][]; body: string; calls: number };

const TEXT_TYPES = /^(text\/|application\/json)/;

export async function frozenAnswer(r: Call): Promise<FrozenAnswer> {
  const type = r.headers.get("content-type") ?? "";
  const body = TEXT_TYPES.test(type) || r.bytes.length === 0 ? r.text : `${r.bytes.length} bytes, sha256 ${await sha256Hex(r.bytes)}`;
  return { status: r.status, headers: [...r.headers.entries()].sort(), body, calls: r.calls };
}
