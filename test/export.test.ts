// "Download all my data" (src/export.ts), on both targets: what the zip holds and how it is
// laid out, the tour pages that open from disk, the two lists, what it never holds, who may
// ask for it and how often, one at a time, a read-only workspace, the limit within the call
// budget, and a file that cannot be read. Every zip is read back by the independent reader in
// test/zip-reader.ts.
import { describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { createApp } from "../src/app.ts";
import { newLinkId } from "../src/auth.ts";
import { SUBREQUEST_BUDGET } from "../src/budget.ts";
import { EXPORT_FILE_NAME, EXPORT_FIXED_CALLS, EXPORT_PATH, EXPORT_WORKER_FILES, FAILURE_SENTENCE, OFFLINE_CSS, RUNNING_MS, TICKET_MS, exportFileLimit, offlinePolicy, safeName } from "../src/export.ts";
import { PART_BYTES } from "../src/media.ts";
import { PLAYER_CSS, PLAYER_JS } from "../src/player/assets.ts";
import type { Deps } from "../src/ports.ts";
import { EXPORT_RUNNING_BUCKET, LIMITS_EXPORT } from "../src/rate.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import { ORIGIN, clone, fixtures, gif, logoPng, mp4, png, send, stepImage, uploadTour, type Call, type Json } from "./bundle.ts";
import { withBilling } from "./fake-stripe.ts";
import { filesOf, readZip } from "./zip-reader.ts";

const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
const JSON_HEADERS = { "content-type": "application/json" };
const v3 = fixtures.v3 as Json;

type Session = { id: string; cookie: string; csrf: string; secret: string };
type Acct = { workspaceId: string; userId: string; token: string; email: string; session: Session };

async function signInAs(deps: Deps, userId: string): Promise<Session> {
  const made = await redeemSignInCode(deps, await createSignInCode(deps, userId), null, null);
  if (made === null) throw new Error("the sign-in was refused");
  return { id: made.sessionId, cookie: `${SESSION_COOKIE}=${made.secret}`, csrf: await csrfFor(made.secret), secret: made.secret };
}

/** The headers the site's own page sends with a session. */
const page = (s: Session) => ({ cookie: s.cookie, "x-csrf-token": s.csrf, origin: ORIGIN, "sec-fetch-site": "same-origin" });

async function clocked(config?: Parameters<typeof makeDeps>[0]) {
  const ctx = await makeDeps(config);
  let now = T0;
  ctx.deps.now = () => now;
  // A site has its admin before anyone else can sign in; theirs is another workspace still.
  await seedAccount(ctx.deps, { admin: true });
  return { ...ctx, advance: (ms: number) => (now += ms) };
}

async function account(deps: Deps, opts: { username?: string } = {}): Promise<Acct> {
  const a = await seedAccount(deps, opts);
  return { ...a, session: await signInAs(deps, a.userId) };
}

const ask = (deps: Deps, s: Session) => send(deps, "POST", EXPORT_PATH, { headers: page(s) });
const fetchFile = (deps: Deps, s: Session, url: string) => send(deps, "GET", url, { headers: { cookie: s.cookie } });

/** Asks for the download and takes the whole file. */
async function download(deps: Deps, s: Session): Promise<{ asked: Call; file: Call }> {
  const asked = await ask(deps, s);
  expect([asked.status, asked.text]).toEqual([200, asked.text]);
  expect(asked.json.url).toMatch(/^\/api\/v1\/account\/data\/[0-9a-f]{76}$/);
  const file = await fetchFile(deps, s, asked.json.url);
  expect([file.status, file.headers.get("content-type")]).toEqual([200, "application/zip"]);
  return { asked, file };
}

async function zipOf(deps: Deps, s: Session): Promise<Map<string, Uint8Array>> {
  return filesOf((await download(deps, s)).file.bytes);
}

const seenAs = (c: Call) => ({ status: c.status, text: c.text });
const text = (b: Uint8Array | undefined) => (b === undefined ? "" : new TextDecoder().decode(b));
const listOf = (files: Map<string, Uint8Array>) => JSON.parse(text(files.get("account.json"))) as Json;

/** A manifest of v3's settings with `n` small steps, each a 64 x 64 PNG of 200 bytes. */
function smallManifest(n: number, title: string, logo = false): Json {
  const m = clone(v3);
  m.title = title;
  if (!logo) m.cover = null;
  const base = m.steps[0];
  m.steps = Array.from({ length: n }, (_, i) => ({ ...clone(base), image: `step-${String(i + 1).padStart(3, "0")}.png`, width: 64, height: 64, bytes: 200, card: { ...clone(base.card), title: `Step ${i + 1} of ${title}` } }));
  return m;
}

async function shareItem(deps: Deps, token: string, body: Json, file: Uint8Array): Promise<{ id: string; link: string }> {
  const made = await send(deps, "POST", "/api/v1/media", { token, body: JSON.stringify(body), headers: JSON_HEADERS });
  if (made.status !== 201) throw new Error(`create failed: ${made.status} ${made.text}`);
  const id = made.json.id as string;
  for (let n = 0; n < made.json.parts; n++) {
    const r = await send(deps, "PUT", `/api/v1/media/${id}/parts/${n}`, { token, body: file.subarray(n * PART_BYTES, (n + 1) * PART_BYTES) as NonNullable<RequestInit["body"]> });
    if (r.status !== 204) throw new Error(`part failed: ${r.status} ${r.text}`);
  }
  const done = await send(deps, "POST", `/api/v1/media/${id}/commit`, { token });
  if (done.status !== 200) throw new Error(`commit failed: ${done.status} ${done.text}`);
  return { id, link: done.json.link_id as string };
}

async function publishAll(deps: Deps, token: string, tourId: string): Promise<void> {
  let r = await send(deps, "POST", `/api/v1/tours/${tourId}/publish`, { token });
  while (r.status === 202) r = await send(deps, "POST", `/api/v1/tours/${tourId}/publish`, { token, body: JSON.stringify({ publish_id: r.json.publish_id }), headers: JSON_HEADERS });
  if (r.status !== 200) throw new Error(`publish failed: ${r.status} ${r.text}`);
}

const rename = (deps: Deps, token: string, id: string, title: string) => send(deps, "PATCH", `/api/v1/tours/${id}`, { token, body: JSON.stringify({ title }), headers: JSON_HEADERS });

/** A workspace with one of everything: a published tour whose draft has gone on, a draft tour, an image, a GIF and an MP4 of three parts. */
async function full(deps: Deps, a: Acct, fill = 0) {
  const published = await uploadTour(deps, a.token, v3, { kind: "new" }, fill);
  await publishAll(deps, a.token, published.tour_id);
  // A chapter added after the publish: the zip holds the draft, with it.
  const more = smallManifest(2, "More");
  await uploadTour(deps, a.token, more, { kind: "chapter", tour_id: published.tour_id }, fill);
  const draft = await uploadTour(deps, a.token, smallManifest(3, "Draft one"), { kind: "new" }, fill + 1);
  await rename(deps, a.token, draft.tour_id, "Draft one");
  const imageFile = png(32, 32, 5000, fill + 2);
  const image = await shareItem(deps, a.token, { kind: "image", content_type: "image/png", bytes: imageFile.length, width: 32, height: 32, title: "Screen shot" }, imageFile);
  const gifFile = gif(40, 30, 3000, fill + 3);
  const gifItem = await shareItem(deps, a.token, { kind: "clip", content_type: "image/gif", bytes: gifFile.length, width: 40, height: 30, duration_ms: 1500, title: "Loop" }, gifFile);
  const mp4File = mp4(PART_BYTES * 2 + 1234, fill + 4);
  const mp4Item = await shareItem(deps, a.token, { kind: "clip", content_type: "video/mp4", bytes: mp4File.length, width: 1280, height: 720, duration_ms: 9000, title: null }, mp4File);
  return { published, more, draft, image, imageFile, gifItem, gifFile, mp4Item, mp4File };
}

describe("Download all my data: the zip", () => {
  it("an empty workspace gives a zip of the two lists alone, with the download's headers", async () => {
    const { deps } = await clocked();
    const a = await account(deps, { username: "morgan" });
    const { file } = await download(deps, a.session);
    expect(file.headers.get("content-disposition")).toBe(`attachment; filename="${EXPORT_FILE_NAME}"`);
    expect(file.headers.get("cache-control")).toBe("no-store");
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    const zip = readZip(file.bytes);
    expect(zip.entries.map((e) => e.name)).toEqual(["README.txt", "account.json"]);
    const list = JSON.parse(text(zip.entries[1].bytes));
    expect(list).toEqual({
      exported_at: new Date(T0).toISOString(),
      account: { email: a.email, username: "morgan" },
      workspace: { name: "Account" },
      tours: [],
      images: [],
      clips: [],
      not_included: [],
    });
    const readme = text(zip.entries[0].bytes);
    expect(readme).toContain(`Account: ${a.email} (username morgan)`);
    expect(readme).toContain("Workspace: Account");
    expect(readme).toContain("Tours (0)\r\n\r\nNone.");
  });

  it("holds every tour with its pictures, logo, data and page, and every image and clip, byte for byte, laid out as the README says", async () => {
    const { deps } = await clocked();
    const a = await account(deps);
    const w = await full(deps, a);
    const files = await zipOf(deps, a.session);
    const names = [...files.keys()];
    // Made at the same moment here, so in the order of their titles; images before clips.
    expect(names).toEqual([
      "tours/draft-one/index.html",
      "tours/draft-one/tour.json",
      "tours/draft-one/pictures/step-001.png",
      "tours/draft-one/pictures/step-002.png",
      "tours/draft-one/pictures/step-003.png",
      "tours/send-an-invoice/index.html",
      "tours/send-an-invoice/tour.json",
      "tours/send-an-invoice/pictures/step-001.png",
      "tours/send-an-invoice/pictures/step-002.png",
      "tours/send-an-invoice/pictures/step-003.jpg",
      "tours/send-an-invoice/pictures/step-004.png",
      "tours/send-an-invoice/pictures/step-005.png",
      "tours/send-an-invoice/pictures/logo.png",
      "images/screen-shot.png",
      "clips/clip.mp4",
      "clips/loop.gif",
      "README.txt",
      "account.json",
    ]);
    // The pictures are the ones uploaded, in the draft's order: v3's three, then the chapter added after the publish.
    const steps = [...(v3.steps as Json[]).map((s) => stepImage(s, 0)), ...(w.more.steps as Json[]).map((s) => stepImage(s, 0))];
    steps.forEach((b, i) => expect(files.get(`tours/send-an-invoice/pictures/step-00${i + 1}.${i === 2 ? "jpg" : "png"}`), `step ${i + 1}`).toEqual(b));
    expect(files.get("tours/send-an-invoice/pictures/logo.png")).toEqual(logoPng());
    expect(files.get("images/screen-shot.png")).toEqual(w.imageFile);
    expect(files.get("clips/loop.gif")).toEqual(w.gifFile);
    expect(files.get("clips/clip.mp4")).toEqual(w.mp4File);

    // The readable data of the published tour is its draft: five steps in two chapters, the settings, the pictures by name.
    const data = JSON.parse(text(files.get("tours/send-an-invoice/tour.json")));
    expect(data.title).toBe("Send an invoice");
    expect(data.chapters.map((c: Json) => c.steps.length)).toEqual([3, 2]);
    expect(data.chapters[0].steps[0]).toMatchObject({ picture: "pictures/step-001.png", width: 1280, height: 720, card: v3.steps[0].card, notes: v3.steps[0].notes, advance: "anywhere", zoom: false });
    expect(data.chapters[1].steps[1]).toMatchObject({ picture: "pictures/step-005.png", card: { title: "Step 2 of More" } });
    expect(data.settings).toMatchObject({ spotlight_dim: 60, theme: v3.theme, cover: { ...v3.cover, logo: "pictures/logo.png" }, cta: v3.cta, end: v3.end, autoplay: v3.autoplay });
    expect(JSON.stringify(data)).not.toMatch(/"id"|st_|ch_|tour_|u\//);

    // The list says what each is.
    const list = listOf(files);
    expect(list.tours).toEqual([
      expect.objectContaining({ title: "Draft one", folder: "tours/draft-one", published: false, published_at: null, link: null, sharing: "public", chapters: 1, steps: 3, bytes: 600 }),
      expect.objectContaining({ title: "Send an invoice", folder: "tours/send-an-invoice", published: true, link: expect.stringMatching(/^\/t\/[a-z2-7]{10}$/), sharing: "public", viewers: [], chapters: 2, steps: 5, page: true }),
    ]);
    expect(list.tours[1].bytes).toBe(48213 + 51022 + 402117 + 400 + logoPng().length);
    expect(list.tours[1].files).toEqual(names.filter((n) => n.startsWith("tours/send-an-invoice/pictures/")).map((path) => ({ path, bytes: files.get(path)!.length })));
    expect(list.images).toEqual([{ title: "Screen shot", file: "images/screen-shot.png", created_at: new Date(T0).toISOString(), shared_at: new Date(T0).toISOString(), sharing: "public", viewers: [], link: `/i/${w.image.link}`, bytes: 5000, width: 32, height: 32 }]);
    expect(list.clips.map((c: Json) => [c.title, c.file, c.bytes, c.duration_ms, c.link])).toEqual([
      [null, "clips/clip.mp4", w.mp4File.length, 9000, `/r/${w.mp4Item.link}`],
      ["Loop", "clips/loop.gif", 3000, 1500, `/r/${w.gifItem.link}`],
    ]);
    const readme = text(files.get("README.txt"));
    for (const line of ["Send an invoice", "  Folder: tours/send-an-invoice", `  Published: yes, on 2027-01-15, at ${list.tours[1].link}`, "  Shared with: anyone with the link", "  2 chapters, 5 steps, ", "Draft one", "  Published: no", "Images (1)", "  File: images/screen-shot.png", "Clips (2)", "(no title)", "  File: clips/clip.mp4"]) {
      expect(readme, line).toContain(line);
    }
    expect(readme).not.toContain("Not included");
  });

  it("makes every name plain ASCII, safe on Windows, and unique, whatever the titles", async () => {
    const { deps } = await clocked();
    const a = await account(deps);
    const titles = ["Ünïcode Straße / ../../etc/passwd", "CON", "Same", "same", "!!!", "a".repeat(200), "C:\\Windows\\System32"];
    for (const t of titles) {
      const made = await uploadTour(deps, a.token, smallManifest(1, "x"));
      expect((await rename(deps, a.token, made.tour_id, t)).status).toBe(200);
    }
    for (const title of ["Nul", "Nul", null]) {
      const f = png(8, 8, 100);
      await shareItem(deps, a.token, { kind: "image", content_type: "image/png", bytes: 100, width: 8, height: 8, title }, f);
    }
    const files = await zipOf(deps, a.session);
    const folders = [...new Set([...files.keys()].filter((n) => n.startsWith("tours/")).map((n) => n.split("/")[1]))];
    // Made at the same moment, so in the order of their titles.
    expect(folders).toEqual(["tour", "c-windows-system32", "con-tour", "same", "a".repeat(60), "same-2", "unicode-stra-e-etc-passwd"]);
    expect([...files.keys()].filter((n) => n.startsWith("images/"))).toEqual(["images/image.png", "images/nul-image.png", "images/nul-image-2.png"]);
    for (const n of files.keys()) expect(n).toMatch(/^[a-z0-9._/-]+$/i);
    // The titles themselves are kept, as written, in the lists.
    expect(listOf(files).tours.map((t: Json) => t.title)).toEqual(["!!!", titles[6], "CON", "Same", "a".repeat(200), "same", titles[0]]);
  });

  it("names every file safely, and only uniquely, in the function the zip uses", () => {
    const taken = new Set<string>();
    expect(["Hello World", "hello-world", "HELLO world!", "", "aux", "LPT1", "com0x"].map((t) => safeName(t, "tour", taken))).toEqual([
      "hello-world",
      "hello-world-2",
      "hello-world-3",
      "tour",
      "aux-tour",
      "lpt1-tour",
      "com0x",
    ]);
    expect(safeName(null, "clip", new Set())).toBe("clip");
    expect(safeName("-".repeat(80) + "x", "tour", new Set())).toBe("x");
  });

  it("includes a restricted tour and restricted items for their owner, with who may view them", async () => {
    const { deps } = await clocked();
    const a = await account(deps);
    const w = await full(deps, a);
    await deps.db.run("UPDATE tour SET access = 'people' WHERE id = ?", [w.draft.tour_id]);
    for (const email of ["zoe@example.com", "adam@example.com"]) await deps.db.run("INSERT INTO tour_viewer (tour_id, email, created_at) VALUES (?, ?, ?)", [w.draft.tour_id, email, T0]);
    // A restricted item's link id is kept apart, as switching its setting keeps it (migration 0016).
    await deps.db.run("UPDATE media SET access = 'me', private_link_id = link_id, link_id = ? WHERE id = ?", [newLinkId(), w.image.id]);
    await deps.db.run("UPDATE media SET access = 'people', private_link_id = link_id, link_id = ? WHERE id = ?", [newLinkId(), w.gifItem.id]);
    await deps.db.run("INSERT INTO media_viewer (media_id, email, created_at) VALUES (?, ?, ?)", [w.gifItem.id, "eve@example.com", T0]);
    const files = await zipOf(deps, a.session);
    const list = listOf(files);
    expect(list.tours[0]).toMatchObject({ title: "Draft one", sharing: "people", viewers: ["adam@example.com", "zoe@example.com"] });
    expect(list.images[0]).toMatchObject({ sharing: "me", viewers: [] });
    expect(list.clips[1]).toMatchObject({ title: "Loop", sharing: "people", viewers: ["eve@example.com"] });
    expect(files.get("images/screen-shot.png")).toEqual(w.imageFile);
    expect(files.get("tours/draft-one/pictures/step-001.png")).toBeDefined();
    const readme = text(files.get("README.txt"));
    expect(readme).toContain("  Shared with: only the people listed (adam@example.com, zoe@example.com)");
    expect(readme).toContain("  Shared with: only you");
    expect(readme).toContain("  Shared with: only the people listed (eve@example.com)");
  });

  it("holds nothing of another workspace, and no token, session, digest, key or internal id", async () => {
    const { deps } = await clocked();
    const a = await account(deps, { username: "alpha" });
    const b = await account(deps, { username: "bravo" });
    await deps.db.run("UPDATE workspace SET name = ? WHERE id = ?", ["Bravo's workspace", b.workspaceId]);
    await full(deps, a, 10);
    const wb = await full(deps, b, 50);
    for (const [id, t] of [[wb.published.tour_id, "Bravo published secret"], [wb.draft.tour_id, "Bravo draft secret"]] as const) expect((await rename(deps, b.token, id, t)).status).toBe(200);
    await deps.db.run("UPDATE media SET title = 'Bravo item secret' WHERE workspace_id = ?", [b.workspaceId]);
    const { asked, file } = await download(deps, a.session);
    const raw = new TextDecoder("latin1").decode(file.bytes);
    for (const needle of ["Bravo", "bravo", b.email, b.workspaceId, b.userId, b.token, b.session.secret, b.session.id, wb.image.link, wb.gifItem.link]) expect(raw, needle).not.toContain(needle);
    // B's pictures are filled with their own bytes: none is in A's zip.
    const files = filesOf(file.bytes);
    for (const [name, bytes] of files) {
      if (!/\.(png|jpg|gif|mp4)$/.test(name)) continue;
      for (const theirs of [wb.imageFile, wb.gifFile, wb.mp4File]) expect(bytes, name).not.toEqual(theirs);
    }
    // Nothing secret or internal of A's own either: the lists and the tour data hold no token, session, digest, key or id.
    const tokenRow = await deps.db.first<{ hash: string }>("SELECT hash FROM api_token WHERE workspace_id = ?", [a.workspaceId]);
    const steps = await deps.db.all<{ image_key: string; sha256: string | null }>("SELECT image_key, sha256 FROM step");
    const claims = await deps.db.all<{ claim: string }>("SELECT claim FROM media_object");
    for (const [name, bytes] of files) {
      if (!/\.(txt|json|html)$/.test(name)) continue;
      // The data of a page is its #tour block; the player itself is the same in every page.
      const t = name.endsWith(".html") ? /<script type="application\/json" id="tour">([^<]*)<\/script>/.exec(text(bytes))![1] : text(bytes);
      for (const needle of [a.token, a.session.secret, a.session.csrf, a.session.id, a.workspaceId, a.userId, tokenRow!.hash, asked.json.url.split("/").pop(), ...steps.map((s) => s.image_key), ...steps.map((s) => s.sha256 ?? "none"), ...claims.map((c) => c.claim)]) {
        expect(t, `${name}: ${needle}`).not.toContain(needle);
      }
      expect(t, name).not.toMatch(/\b(?:dp[a-z]?_[0-9a-f]{8}|(?:ws|usr|tok|ses|tour|ch|st|up|med|aud)_[0-9a-f]{24})/);
    }
  });

  it("writes one audit row for each download started, naming the account and the workspace, before anything is read", async () => {
    const { deps, advance } = await clocked();
    const a = await account(deps);
    await full(deps, a);
    await download(deps, a.session);
    advance(TICKET_MS + 1);
    // A ticket asked for and never used starts nothing.
    expect((await ask(deps, a.session)).status).toBe(200);
    const rows = await deps.db.all<{ event: string; user_id: string; workspace_id: string; subject: string | null; detail: string }>("SELECT event, user_id, workspace_id, subject, detail FROM audit WHERE event = 'data_exported'");
    expect(rows).toEqual([{ event: "data_exported", user_id: a.userId, workspace_id: a.workspaceId, subject: null, detail: null }]);
  });

  it("a file that cannot be read is left out, the zip is still whole, and both lists say so", async () => {
    const { deps } = await clocked();
    const a = await account(deps);
    const w = await full(deps, a);
    const lost = await deps.db.first<{ image_key: string }>("SELECT image_key FROM step WHERE tour_id = ? ORDER BY position LIMIT 1", [w.draft.tour_id]);
    const part = await deps.db.first<{ claim: string }>("SELECT claim FROM media_object WHERE media_id = ? AND n = 1 AND current = 1", [w.mp4Item.id]);
    await deps.drafts.delete([lost!.image_key, `m/${w.mp4Item.id}/part-001.${part!.claim}`]);
    const files = await zipOf(deps, a.session);
    expect(files.has("tours/draft-one/pictures/step-001.png")).toBe(false);
    expect(files.get("clips/clip.mp4")).toEqual(w.mp4File.subarray(0, PART_BYTES));
    expect(listOf(files).not_included).toEqual([
      { path: "tours/draft-one/pictures/step-001.png", reason: "the file could not be read" },
      { path: "clips/clip.mp4", reason: "only part of the file could be read" },
    ]);
    expect(text(files.get("README.txt"))).toContain("Not included\r\n\r\n- tours/draft-one/pictures/step-001.png: the file could not be read\r\n- clips/clip.mp4: only part of the file could be read");
  });
});

describe("Download all my data: the tour page that opens from disk", () => {
  /** The attributes of every tag outside the two scripts and the style. */
  function markupOf(html: string): string {
    return html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, "<script></script>").replace(/<style>[\s\S]*?<\/style>/g, "<style></style>");
  }

  it("holds the player, its style and the tour's data inline, refers only to pictures beside it in the zip, and loads nothing from anywhere", async () => {
    const { deps } = await clocked();
    const a = await account(deps);
    await full(deps, a);
    const files = await zipOf(deps, a.session);
    for (const folder of ["tours/send-an-invoice", "tours/draft-one"]) {
      const html = text(files.get(`${folder}/index.html`));
      // The player's own script and stylesheet, as they are, inside the page.
      const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
      expect(scripts.map((m) => m[1])).toEqual([' type="application/json" id="tour"', ""]);
      expect(scripts[1][2]).toBe(PLAYER_JS);
      // The stylesheet without its web font, which a page on disk has no address for: the player's fallback fonts are used.
      expect(/<style>([\s\S]*?)<\/style>/.exec(html)![1]).toBe(OFFLINE_CSS);
      expect(OFFLINE_CSS).toBe(PLAYER_CSS.replace(/@font-face\s*\{[^}]*\}\n?/g, ""));
      expect(PLAYER_CSS).toContain("@font-face");
      // Its policy allows exactly those two by their digests, pictures from disk, and nothing else.
      const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)![1];
      expect(policy).toBe(await offlinePolicy());
      const digest = async (t: string) => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))));
      expect(policy).toBe(`default-src 'none'; img-src 'self' file:; style-src 'sha256-${await digest(OFFLINE_CSS)}'; script-src 'sha256-${await digest(PLAYER_JS)}'; base-uri 'none'; form-action 'none'`);
      // The markup loads nothing: no src, href, srcset, action, url() or @import, and no inline handler.
      const markup = markupOf(html);
      expect(markup).not.toMatch(/\s(?:src|href|srcset|action|formaction|poster|data|style)=/i);
      expect(markup).not.toMatch(/\son[a-z]+=/i);
      expect(markup.match(/<[a-z][a-z0-9]*/g)!.sort()).toEqual(["<body", "<div", "<h1", "<head", "<html", "<main", "<meta", "<meta", "<meta", "<meta", "<meta", "<noscript", "<p", "<script", "<script", "<style", "<title"].sort());
      expect(OFFLINE_CSS).not.toMatch(/url\(|@import|@font-face/i);
      for (const call of ["fetch(", "XMLHttpRequest", "WebSocket", "sendBeacon", "EventSource", "import(", "Worker(", "localStorage", "document.cookie"]) expect(PLAYER_JS, call).not.toContain(call);
      // The data: base ".", every picture a relative name that is a file of this tour's folder in the zip.
      const data = JSON.parse(scripts[0][2]);
      expect(data.base).toBe(".");
      const pictures = [data.tour.cover?.logo, ...data.tour.chapters.flatMap((c: Json) => c.steps.map((s: Json) => s.image))].filter((p) => p !== null && p !== undefined);
      expect(pictures.length).toBeGreaterThan(2);
      for (const p of pictures) {
        expect(p).toMatch(/^pictures\/[a-z0-9-]+\.(png|jpg)$/);
        expect(files.has(`${folder}/${p}`), `${folder}/${p}`).toBe(true);
      }
      // Every picture of the folder is used by the page, so none is left to guess about.
      expect([...files.keys()].filter((n) => n.startsWith(`${folder}/pictures/`)).map((n) => n.slice(folder.length + 1)).sort()).toEqual([...new Set(pictures)].sort());
      expect(JSON.stringify(data)).not.toMatch(/st_[0-9a-f]{24}/);
    }
    // The published tour's page shows its draft: the chapter added after the publish is in it.
    const data = JSON.parse(/<script type="application\/json" id="tour">([^<]*)<\/script>/.exec(text(files.get("tours/send-an-invoice/index.html")))![1]);
    expect(data.tour.chapters.map((c: Json) => c.steps.length)).toEqual([3, 2]);
    expect(data.tour.cover).toMatchObject({ title: v3.cover.title, logo: "pictures/logo.png" });
  });

  it("escapes a title that looks like markup, as the public page does", async () => {
    const { deps } = await clocked();
    const a = await account(deps);
    const made = await uploadTour(deps, a.token, smallManifest(1, "x"));
    expect((await rename(deps, a.token, made.tour_id, `</script><script>alert(1)</script> & "x"`)).status).toBe(200);
    const files = await zipOf(deps, a.session);
    const html = text(files.get("tours/script-script-alert-1-script-x/index.html"));
    expect(html).toContain("<title>&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;</title>");
    expect([...html.matchAll(/<script/g)]).toHaveLength(2);
    expect(html).toContain("\\u003c/script\\u003e");
  });

  it("the player takes pictures beside the page only with the offline base, and that base takes nothing else", () => {
    expect(PLAYER_JS).toContain('OFFLINE_BASE = "."');
    expect(PLAYER_JS).toContain("OFFLINE_KEY = /^pictures\\/[a-z0-9][a-z0-9-]{0,62}\\.(png|jpg)$/");
    expect(PLAYER_JS).toContain("const rule = base === OFFLINE_BASE ? OFFLINE_KEY : RESTRICTED_BASE.test(base) ? RESTRICTED_KEY : IMAGE_KEY;");
  });
});

describe("Download all my data: who may ask, how often, and when", () => {
  it("takes a session of the dashboard's own page alone: no token, no other origin, no missing anti-forgery value, no credential at all", async () => {
    const { deps } = await clocked();
    const a = await account(deps);
    const unauthorized = { error: "unauthorized" };
    expect([(await send(deps, "POST", EXPORT_PATH, { token: a.token })).json]).toEqual([unauthorized]);
    expect((await send(deps, "POST", EXPORT_PATH, { token: a.token })).status).toBe(401);
    expect((await send(deps, "POST", EXPORT_PATH)).status).toBe(401);
    expect((await send(deps, "POST", EXPORT_PATH, { headers: { ...page(a.session), "x-csrf-token": "0".repeat(64) } })).json.error).toBe("bad_csrf");
    expect((await send(deps, "POST", EXPORT_PATH, { headers: { ...page(a.session), origin: "https://evil.example" } })).json.error).toBe("bad_origin");
    expect((await send(deps, "POST", EXPORT_PATH, { headers: { ...page(a.session), "sec-fetch-site": "cross-site" } })).json.error).toBe("bad_origin");
    // None of those took the workspace's download row.
    expect(await deps.db.all("SELECT * FROM rate_counter WHERE bucket = ?", [EXPORT_RUNNING_BUCKET])).toEqual([]);
    const asked = await ask(deps, a.session);
    expect(asked.status).toBe(200);
    expect(asked.headers.get("cache-control")).toBe("no-store");
    // The file: a token, no credential and a token beside the cookie are refused, and the ticket stays good.
    expect((await send(deps, "GET", asked.json.url, { token: a.token })).status).toBe(401);
    expect((await send(deps, "GET", asked.json.url)).status).toBe(401);
    expect((await send(deps, "GET", asked.json.url, { token: a.token, headers: { cookie: a.session.cookie } })).status).toBe(400);
    expect(seenAs(await fetchFile(deps, a.session, asked.json.url)).status).toBe(200);
  });

  it("a ticket is good once, for its own session, for a minute, and nothing else is one", async () => {
    const { deps, advance } = await clocked();
    const a = await account(deps);
    const other = await signInAs(deps, a.userId);
    const b = await account(deps);
    // A refused ticket answers the dashboard's failure sentence as plain text (src/export.ts, refusedPage).
    const noSuch = { status: 404, text: FAILURE_SENTENCE };
    const asked = await ask(deps, a.session);
    const ticket = asked.json.url.split("/").pop() as string;
    // Another session of the same account, another account, a changed ticket, a malformed one: no such download.
    expect(seenAs(await fetchFile(deps, other, asked.json.url))).toEqual(noSuch);
    expect(seenAs(await fetchFile(deps, b.session, asked.json.url))).toEqual(noSuch);
    const flipped = ticket.slice(0, -1) + (ticket.endsWith("0") ? "1" : "0");
    for (const bad of [flipped, ticket.slice(0, -1), ticket.toUpperCase(), "0".repeat(76), "x", `${ticket}0`]) expect(seenAs(await fetchFile(deps, a.session, `${EXPORT_PATH}/${bad}`)), bad).toEqual(noSuch);
    // The same ticket with an earlier time is not this download's.
    const earlier = (Number.parseInt(ticket.slice(0, 12), 16) - 1).toString(16).padStart(12, "0") + ticket.slice(12);
    expect(seenAs(await fetchFile(deps, a.session, `${EXPORT_PATH}/${earlier}`))).toEqual(noSuch);
    // Good once.
    expect(seenAs(await fetchFile(deps, a.session, asked.json.url)).status).toBe(200);
    expect(seenAs(await fetchFile(deps, a.session, asked.json.url))).toEqual(noSuch);
    // And only for TICKET_MS.
    const late = await ask(deps, a.session);
    advance(TICKET_MS);
    expect(seenAs(await fetchFile(deps, a.session, late.json.url))).toEqual(noSuch);
  });

  it("one download at a time per workspace: a second ask is busy while one is ready or being sent, and free once it ended or its time ran out", async () => {
    const { deps, advance } = await clocked();
    const a = await account(deps);
    const b = await account(deps);
    await full(deps, a);
    const busy = { error: "export_busy", detail: "a download of this workspace's data is already being prepared or sent; wait for it to finish" };
    const first = await ask(deps, a.session);
    expect((await ask(deps, a.session)).json).toEqual(busy);
    // Another workspace is not held up.
    expect((await ask(deps, b.session)).status).toBe(200);
    // While the file is being sent: busy. Read through the app itself, a chunk at a time.
    const res = await createApp(deps).fetch(new Request(ORIGIN + first.json.url, { headers: { cookie: a.session.cookie } }));
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read();
    expect((await ask(deps, a.session)).json).toEqual(busy);
    // Stopped by the browser: free at once.
    await reader.cancel();
    const second = await ask(deps, a.session);
    expect(second.status).toBe(200);
    // A ready ticket never used holds the row for TICKET_MS only.
    advance(TICKET_MS);
    const third = await ask(deps, a.session);
    expect(third.status).toBe(200);
    // A download that was started and never ended (a server that stopped) holds it for RUNNING_MS.
    const stuck = await createApp(deps).fetch(new Request(ORIGIN + third.json.url, { headers: { cookie: a.session.cookie } }));
    await stuck.body!.getReader().read();
    advance(RUNNING_MS - 1);
    expect((await ask(deps, a.session)).json).toEqual(busy);
    advance(1);
    expect((await ask(deps, a.session)).status).toBe(200);
  });

  it("is counted per workspace: a few an hour, then 429 with the time to wait", async () => {
    const { deps, advance } = await clocked();
    const a = await account(deps);
    const b = await account(deps);
    for (let i = 0; i < LIMITS_EXPORT.start.most; i++) {
      const r = await ask(deps, a.session);
      expect(r.status, `ask ${i + 1}`).toBe(200);
      expect(seenAs(await fetchFile(deps, a.session, r.json.url)).status).toBe(200);
    }
    const over = await ask(deps, a.session);
    expect([over.status, over.json.error, over.headers.get("retry-after")]).toEqual([429, "rate_limited", "3600"]);
    expect((await ask(deps, b.session)).status).toBe(200);
    advance(HOUR);
    expect((await ask(deps, a.session)).status).toBe(200);
    expect(LIMITS_EXPORT.start).toEqual({ bucket: "export_start", windowMs: HOUR, most: 5 });
  });

  it("works for a read-only workspace: a trial that is over may still take its data, though it can no longer change it", async () => {
    const { deps } = await clocked();
    withBilling(deps);
    const a = await account(deps);
    const made = await uploadTour(deps, a.token, smallManifest(2, "Kept"));
    await deps.db.run("UPDATE workspace SET billing_trial = 1, created_at = ? WHERE id = ?", [T0 - 200 * 24 * HOUR, a.workspaceId]);
    expect((await rename(deps, a.token, made.tour_id, "Changed")).status).toBe(402);
    const files = await zipOf(deps, a.session);
    expect(listOf(files).tours.map((t: Json) => t.title)).toEqual(["Kept"]);
  });

  it("works whether billing is on or off: the routes are there in both", () => {
    const off = createApp({ config: { publicImageBase: "", setupCode: null } } as Deps).routes.map((r) => `${r.method} ${r.path}`);
    expect(off).toContain(`POST ${EXPORT_PATH}`);
    expect(off).toContain(`GET ${EXPORT_PATH}/:ticket`);
  });
});

describe("Download all my data: the limit within the call budget", () => {
  it("on Workers a download reads at most the files the budget leaves, and the Node server has no limit", () => {
    expect(EXPORT_FIXED_CALLS).toBe(5);
    expect(EXPORT_WORKER_FILES).toBe(SUBREQUEST_BUDGET - EXPORT_FIXED_CALLS);
    expect(EXPORT_WORKER_FILES).toBe(35);
    const deps = (config: Json) => ({ config: { publicImageBase: "", setupCode: null, ...config } }) as Deps;
    expect(exportFileLimit(deps({}))).toBe(EXPORT_WORKER_FILES);
    expect(exportFileLimit(deps({ exportFileReads: null }))).toBe(null);
    expect(exportFileLimit(deps({ exportFileReads: 3 }))).toBe(3);
  });

  it("a workspace of exactly the most files is sent whole within the budget", async () => {
    const { deps } = await clocked();
    const a = await account(deps);
    // 30 step pictures, a logo, and an MP4 of three parts and an image of one: 35 files.
    await uploadTour(deps, a.token, smallManifest(20, "Twenty", true));
    await uploadTour(deps, a.token, smallManifest(10, "Ten"));
    const mp4File = mp4(PART_BYTES * 2 + 10);
    await shareItem(deps, a.token, { kind: "clip", content_type: "video/mp4", bytes: mp4File.length, width: 64, height: 64, duration_ms: 1000, title: "Three parts" }, mp4File);
    await shareItem(deps, a.token, { kind: "image", content_type: "image/png", bytes: 100, width: 8, height: 8, title: "One" }, png(8, 8, 100));
    const { asked, file } = await download(deps, a.session);
    expect(asked.calls).toBeLessThanOrEqual(5);
    expect(file.calls).toBe(EXPORT_FIXED_CALLS - 1 + EXPORT_WORKER_FILES);
    expect(file.calls).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
    expect(filesOf(file.bytes).get("clips/three-parts.mp4")).toEqual(mp4File);
  });

  it("a workspace over the limit is refused before any byte, on asking and on opening, and its row is not kept", async () => {
    const { deps } = await clocked({ exportFileReads: 4 });
    const a = await account(deps);
    const made = await uploadTour(deps, a.token, smallManifest(3, "Three"));
    const asked = await ask(deps, a.session);
    expect(asked.status).toBe(200);
    // Grown past the limit before the file is opened: refused, and the row goes.
    await uploadTour(deps, a.token, smallManifest(2, "More"), { kind: "chapter", tour_id: made.tour_id });
    const refusal = { error: "too_large_to_export", detail: "this workspace has 5 stored files, more than the 4 one download can hold on this server" };
    const opened = await fetchFile(deps, a.session, asked.json.url);
    expect([opened.status, opened.text, opened.headers.get("content-type")]).toEqual([409, FAILURE_SENTENCE, "text/plain; charset=utf-8"]);
    expect(await deps.db.all("SELECT * FROM rate_counter WHERE bucket = ?", [EXPORT_RUNNING_BUCKET])).toEqual([]);
    // The ticket was claimed, and so recorded, before anything was read: the claim comes first (review M1).
    expect(await deps.db.all("SELECT * FROM audit WHERE event = 'data_exported'")).toHaveLength(1);
    const again = await ask(deps, a.session);
    expect([again.status, again.json]).toEqual([409, refusal]);
    expect(again.calls).toBeLessThanOrEqual(5);
  });
});
