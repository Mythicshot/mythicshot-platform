import { describe, expect, it } from "vitest";
import { makeDeps, seedWorkspace } from "#harness";
import type { Deps } from "../src/ports.ts";
import { pageTour, type PageData } from "../src/page.ts";
import type { Snapshot } from "../src/publish.ts";
import { clone, fixtures, send, uploadTour, type Call, type Json } from "./bundle.ts";

const v2 = fixtures.v2 as Json;
const v3 = fixtures.v3 as Json;
const IMAGE_BASE = "https://images.example.net";

async function setup(config?: Parameters<typeof makeDeps>[0]) {
  const ctx = await makeDeps(config);
  const a = await seedWorkspace(ctx.deps, "Workspace A");
  return { ...ctx, a };
}

const publish = (deps: Deps, token: string, tourId: string) => send(deps, "POST", `/api/v1/tours/${tourId}/publish`, { token });
const unpublish = (deps: Deps, token: string, tourId: string) => send(deps, "POST", `/api/v1/tours/${tourId}/unpublish`, { token });
const page = (deps: Deps, slug: string, opts: Parameters<typeof send>[3] = {}) => send(deps, "GET", `/t/${slug}`, opts);

async function slugOf(deps: Deps, tourId: string): Promise<string> {
  return (await deps.db.first<{ slug: string }>("SELECT slug FROM tour WHERE id = ?", [tourId]))!.slug;
}

async function snapshotOf(deps: Deps, tourId: string): Promise<Snapshot> {
  return JSON.parse((await deps.db.first<{ data: string }>("SELECT data FROM snapshot WHERE tour_id = ?", [tourId]))!.data);
}

/** Uploads and publishes `manifest`; returns the tour id and its slug. */
async function published(deps: Deps, token: string, manifest: Json): Promise<{ tourId: string; slug: string }> {
  const t = await uploadTour(deps, token, manifest);
  const r = await publish(deps, token, t.tour_id);
  if (r.status !== 200) throw new Error(`publish failed: ${r.status} ${r.text}`);
  return { tourId: t.tour_id, slug: r.json.slug };
}

const DATA_BLOCK = /<script type="application\/json" id="tour">([\s\S]*?)<\/script>/;

/** The raw text of the page's data block. */
function dataText(r: Call): string {
  const m = DATA_BLOCK.exec(r.text);
  if (m === null) throw new Error("no data block");
  return m[1];
}

function data(r: Call): PageData {
  return JSON.parse(dataText(r));
}

const HOSTILE = "</script><img src=x onerror=alert(1)>";
/** Short enough for the 24-character fields. */
const HOSTILE_SHORT = "</script><img src=x>";

describe("the player page", () => {
  it("a published tour's page carries its snapshot and the image base", async () => {
    const { deps, a } = await setup();
    const { tourId, slug } = await published(deps, a.token, v3);
    const r = await page(deps, slug);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(data(r)).toEqual({ base: "", tour: pageTour(await snapshotOf(deps, tourId)) });
    expect(r.text).toContain('<main id="player">');
    expect(r.text).toContain('<link rel="stylesheet" href="/player.css">');
    expect(r.text).toContain('<script src="/player.js" defer></script>');

    const withBase = await setup({ publicImageBase: IMAGE_BASE + "/" });
    const p = await published(withBase.deps, withBase.a.token, v3);
    expect(data(await page(withBase.deps, p.slug)).base).toBe(IMAGE_BASE);
  });

  it("with no image base the CSP allows images from 'self' only", async () => {
    const { deps, a } = await setup();
    const { slug } = await published(deps, a.token, v2);
    const r = await page(deps, slug);
    expect(r.headers.get("content-security-policy")).toBe(
      "default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'",
    );

    const other = await setup({ publicImageBase: IMAGE_BASE + "/tours/" });
    const p = await published(other.deps, other.a.token, v2);
    expect((await page(other.deps, p.slug)).headers.get("content-security-policy")).toBe(
      `default-src 'none'; img-src ${IMAGE_BASE}; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'`,
    );
  });

  it("an image base that is not an https origin allows no images rather than guessing", async () => {
    const { deps, a } = await setup({ publicImageBase: "http://images.example.net" });
    const { slug } = await published(deps, a.token, v2);
    expect((await page(deps, slug)).headers.get("content-security-policy")).toContain("img-src 'none';");
  });

  it("sets the safety headers, allows framing and relaxes nothing else", async () => {
    const { deps, a } = await setup();
    const { slug } = await published(deps, a.token, v3);
    const r = await page(deps, slug);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("x-frame-options")).toBeNull();
    expect(r.headers.get("content-security-policy")).not.toContain("frame-ancestors");
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    expect(r.headers.get("cache-control")).toBe("public, max-age=60");
    expect(r.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);
  });

  it("a matching If-None-Match answers 304, and publishing again changes the tag", async () => {
    const { deps, a } = await setup();
    const { tourId, slug } = await published(deps, a.token, v3);
    const first = await page(deps, slug);
    const tag = first.headers.get("etag")!;
    const again = await page(deps, slug, { headers: { "if-none-match": tag } });
    expect(again.status).toBe(304);
    expect(again.text).toBe("");
    expect(again.headers.get("etag")).toBe(tag);
    expect((await page(deps, slug, { headers: { "if-none-match": `W/${tag}, "x"` } })).status).toBe(304);
    expect((await page(deps, slug, { headers: { "if-none-match": '"0123"' } })).status).toBe(200);

    await publish(deps, a.token, tourId);
    const fresh = await page(deps, slug, { headers: { "if-none-match": tag } });
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get("etag")).not.toBe(tag);
  });

  it("an unknown slug and a draft tour both answer the same 404", async () => {
    const { deps, a } = await setup();
    const draft = await uploadTour(deps, a.token, v3);
    const draftSlug = await slugOf(deps, draft.tour_id);
    const unknown = await page(deps, "abcdefghij");
    const ofDraft = await page(deps, draftSlug);
    const malformed = await page(deps, "..%2f..%2fdb.sqlite");
    for (const r of [unknown, ofDraft, malformed]) {
      expect(r.status).toBe(404);
      expect(r.text).toBe(unknown.text);
      expect([...r.headers].sort()).toEqual([...unknown.headers].sort());
    }
    expect(unknown.headers.get("cache-control")).toBe("no-store");
    expect(unknown.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(unknown.text).not.toContain(draftSlug);
  });

  it("an unpublished tour answers 404 again", async () => {
    const { deps, a } = await setup();
    const { tourId, slug } = await published(deps, a.token, v3);
    const unknown = await page(deps, "abcdefghij");
    expect((await page(deps, slug)).status).toBe(200);
    expect((await unpublish(deps, a.token, tourId)).status).toBe(204);
    const r = await page(deps, slug);
    expect(r.status).toBe(404);
    expect(r.text).toBe(unknown.text);
  });

  it("the page never contains a draft key, an upload id or any internal id but step ids", async () => {
    const { deps, a } = await setup();
    const t = await uploadTour(deps, a.token, v3);
    // A second chapter, so chapter ids of both kinds of commit are in the snapshot.
    await uploadTour(deps, a.token, v2, { kind: "chapter", tour_id: t.tour_id });
    expect((await publish(deps, a.token, t.tour_id)).status).toBe(200);
    const slug = await slugOf(deps, t.tour_id);
    const r = await page(deps, slug);
    const snap = await snapshotOf(deps, t.tour_id);
    const uploads = (await deps.db.all<{ id: string }>("SELECT id FROM upload")).map((u) => u.id);
    const chapterIds = snap.chapters.map((c) => c.id);
    const internal = [t.tour_id, a.workspaceId, ...uploads, ...uploads.map((u) => u.slice(3)), ...chapterIds];
    for (const s of ["u/up_", "up_", "tour_", "ws_", "ch_", "pub_", "usr_", ...internal]) expect(r.text).not.toContain(s);
    // The only "id" fields in the data are the step ids, and they are the snapshot's.
    const ids: string[] = [];
    JSON.parse(dataText(r), (k, v) => {
      if (k === "id") ids.push(v);
      return v;
    });
    expect(ids).toEqual(snap.chapters.flatMap((c) => c.steps.map((s) => s.id)));
    expect(data(r).tour.chapters.map((c) => c.title)).toEqual(snap.chapters.map((c) => c.title));
  });

  it("a title of </script><b>x cannot close the data block", async () => {
    const { deps, a } = await setup();
    const m = clone(v2);
    m.title = "</script><b>x";
    const { slug } = await published(deps, a.token, m);
    const r = await page(deps, slug);
    expect(r.text).not.toContain("</script><b>x");
    expect(r.text).not.toContain("<b>");
    expect(data(r).tour.title).toBe("</script><b>x");
    // The title in <title> and in the no-script heading is escaped text.
    expect(r.text).toContain("<title>&lt;/script&gt;&lt;b&gt;x</title>");
  });

  it("hostile card, cover, end and button text cannot close the data block", async () => {
    const { deps, a } = await setup();
    const m = clone(v3);
    m.title = HOSTILE;
    m.steps[0].card = { ...m.steps[0].card, title: HOSTILE, body: HOSTILE + "\n**" + HOSTILE + "**", next_label: HOSTILE_SHORT };
    m.steps[0].notes[0].text = "<img src=x onerror=alert(1)>";
    m.cover = { ...m.cover, title: HOSTILE, body: HOSTILE, button: HOSTILE_SHORT };
    m.cta = { label: HOSTILE_SHORT, url: "https://tours.example.com/a?q=</script><b>&x='\"" };
    m.end = { text: HOSTILE, primary: { label: HOSTILE_SHORT, url: "https://tours.example.com/b" }, secondary: null, replay: true };
    const { tourId, slug } = await published(deps, a.token, m);
    const r = await page(deps, slug);
    expect(r.text).not.toContain("</script><img");
    expect(r.text).not.toContain("<img");
    expect(r.text).not.toContain("<b>");
    const tour = data(r).tour;
    expect(tour).toEqual(pageTour(await snapshotOf(deps, tourId)));
    expect(tour.chapters[0].steps[0].card!.title).toBe(HOSTILE);
    expect(tour.cover!.button).toBe(HOSTILE_SHORT);
    expect(tour.end!.text).toBe(HOSTILE);
    expect(tour.cta!.url).toBe("https://tours.example.com/a?q=</script><b>&x='\"");
  });

  it("the data block holds no <, >, &, U+2028 or U+2029, even from a row edited by hand", async () => {
    const { deps, a } = await setup();
    const { tourId, slug } = await published(deps, a.token, v3);
    const snap = await snapshotOf(deps, tourId);
    snap.title = "a\u2028b\u2029c <!-- d --> & </SCRIPT ";
    snap.chapters[0].title = "<script>alert(1)</script>";
    await deps.db.run("UPDATE snapshot SET data = ? WHERE tour_id = ?", [JSON.stringify(snap), tourId]);
    const r = await page(deps, slug);
    const raw = dataText(r);
    expect(raw).not.toMatch(/[<>&\u2028\u2029]/);
    expect(data(r).tour).toEqual(pageTour(snap));
    expect(r.text.toLowerCase()).not.toContain("<!--");
    expect(r.text.match(/<\/script/gi)).toHaveLength(2); // the player's tag and the data block's own
  });

  it("a snapshot row that is not valid JSON answers the same 404", async () => {
    const { deps, a } = await setup();
    const { tourId, slug } = await published(deps, a.token, v3);
    const unknown = await page(deps, "abcdefghij");
    await deps.db.run("UPDATE snapshot SET data = ? WHERE tour_id = ?", ["{not json", tourId]);
    const r = await page(deps, slug);
    expect(r.status).toBe(404);
    expect(r.text).toBe(unknown.text);
  });

  it("without JavaScript the page shows the title and a plain message", async () => {
    const { deps, a } = await setup();
    const m = clone(v3);
    m.title = "Tom & Jerry's <tour>";
    const { slug } = await published(deps, a.token, m);
    const html = (await page(deps, slug)).text;
    const body = html.replace(DATA_BLOCK, "");
    expect(body).toContain("<h1>Tom &amp; Jerry&#39;s &lt;tour&gt;</h1>");
    expect(body).toMatch(/<noscript>[^<]*<p>This tour needs JavaScript[^<]*<\/p>[^<]*<\/noscript>/);
  });

  it("the page sets no cookie", async () => {
    const { deps, a } = await setup();
    const { slug } = await published(deps, a.token, v3);
    expect((await page(deps, slug)).headers.get("set-cookie")).toBeNull();
    expect((await page(deps, "abcdefghij")).headers.get("set-cookie")).toBeNull();
  });

  it("no token is needed and a token is ignored", async () => {
    const { deps, a } = await setup();
    const { slug } = await published(deps, a.token, v3);
    const plain = await page(deps, slug);
    const withToken = await page(deps, slug, { token: a.token });
    const withBad = await page(deps, slug, { token: "dp_" + "0".repeat(40) });
    expect(plain.status).toBe(200);
    expect(withToken.text).toBe(plain.text);
    expect(withBad.status).toBe(200);
    expect(withBad.text).toBe(plain.text);
    expect(plain.text).not.toContain(a.token);
  });

  it("the page carries no link to anything but its own player files", async () => {
    const { deps, a } = await setup({ publicImageBase: IMAGE_BASE });
    const { slug } = await published(deps, a.token, v3);
    const html = (await page(deps, slug)).text.replace(DATA_BLOCK, "");
    const refs = [...html.matchAll(/\b(?:href|src|action|srcset|poster|data)\s*=\s*"([^"]*)"/gi)].map((x) => x[1]);
    expect(refs.sort()).toEqual(["/player.css", "/player.js"]);
    expect(html).not.toContain("https://");
    expect(html).not.toMatch(/\sstyle\s*=|\son[a-z]+\s*=/i);
    // With the data block taken out, the player's own tag is the only script left.
    expect(html.match(/<script\b/g)).toEqual(["<script"]);
  });
});
