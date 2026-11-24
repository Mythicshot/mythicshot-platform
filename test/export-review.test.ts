// "Download all my data" after the review (0.1.60 rework), on both targets: the ticket is
// claimed before any listing work (M1), tour pages are built one at a time (M1), a HEAD burns
// no ticket (L2), a refused ticket answers a page the browser shows and never a file (L5), the
// page can tell whether a download is still going (L5), links in the lists are full addresses
// from the configuration (L7), exportInProgress for the removal sweep, and the terms rule.
// The idle and total timers (L1) are in test/node-export.test.ts, with a fake clock.
import { describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { createApp } from "../src/app.ts";
import { EXPORT_PATH, FAILURE_SENTENCE, README_WORDS, RUNNING_MS, TICKET_MS, exportEntries, exportInProgress, offlinePageHtml, planOf, readListing } from "../src/export.ts";
import { PART_BYTES } from "../src/media.ts";
import type { Deps } from "../src/ports.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import { parseTerms, publishTerms } from "../src/terms.ts";
import { zipStream } from "../src/zip.ts";
import { ORIGIN, clone, fixtures, gif, mp4, png, send, uploadTour, type Call, type Json } from "./bundle.ts";
import { filesOf } from "./zip-reader.ts";

const T0 = 1_800_000_000_000;
const JSON_HEADERS = { "content-type": "application/json" };
const v3 = fixtures.v3 as Json;
const APP = "https://app.example.com";

type Session = { id: string; cookie: string; csrf: string; secret: string };
type Acct = { workspaceId: string; userId: string; token: string; email: string; session: Session };

async function clocked(config?: Parameters<typeof makeDeps>[0]) {
  const ctx = await makeDeps(config);
  let now = T0;
  ctx.deps.now = () => now;
  await seedAccount(ctx.deps, { admin: true });
  return { ...ctx, advance: (ms: number) => (now += ms) };
}

async function account(deps: Deps): Promise<Acct> {
  const a = await seedAccount(deps);
  const made = await redeemSignInCode(deps, await createSignInCode(deps, a.userId), null, null);
  if (made === null) throw new Error("no session");
  return { ...a, session: { id: made.sessionId, cookie: `${SESSION_COOKIE}=${made.secret}`, csrf: await csrfFor(made.secret), secret: made.secret } };
}

const page = (s: Session, origin = ORIGIN) => ({ cookie: s.cookie, "x-csrf-token": s.csrf, origin, "sec-fetch-site": "same-origin" });
const ask = (deps: Deps, s: Session, origin = ORIGIN) => send(deps, "POST", EXPORT_PATH, { origin, headers: page(s, origin) });
const fetchFile = (deps: Deps, s: Session, url: string, origin = ORIGIN) => send(deps, "GET", url, { origin, headers: { cookie: s.cookie } });
const text = (b: Uint8Array | undefined) => (b === undefined ? "" : new TextDecoder().decode(b));
const listOf = (files: Map<string, Uint8Array>) => JSON.parse(text(files.get("account.json"))) as Json;

async function zipOf(deps: Deps, s: Session, origin = ORIGIN): Promise<Map<string, Uint8Array>> {
  const asked = await ask(deps, s, origin);
  expect(asked.status, asked.text).toBe(200);
  const file = await fetchFile(deps, s, asked.json.url, origin);
  expect(file.status, file.text).toBe(200);
  return filesOf(file.bytes);
}

function smallManifest(n: number, title: string): Json {
  const m = clone(v3);
  m.title = title;
  m.cover = null;
  m.steps = Array.from({ length: n }, (_, i) => ({ ...clone(v3.steps[0]), image: `step-${String(i + 1).padStart(3, "0")}.png`, width: 64, height: 64, bytes: 200 }));
  return m;
}

async function shareItem(deps: Deps, token: string, body: Json, file: Uint8Array): Promise<{ id: string; link: string }> {
  const made = await send(deps, "POST", "/api/v1/media", { token, body: JSON.stringify(body), headers: JSON_HEADERS });
  const id = made.json.id as string;
  for (let n = 0; n < made.json.parts; n++) await send(deps, "PUT", `/api/v1/media/${id}/parts/${n}`, { token, body: file.subarray(n * PART_BYTES, (n + 1) * PART_BYTES) as NonNullable<RequestInit["body"]> });
  const done = await send(deps, "POST", `/api/v1/media/${id}/commit`, { token });
  if (done.status !== 200) throw new Error(`commit failed: ${done.status} ${done.text}`);
  return { id, link: done.json.link_id as string };
}

/** A published tour with a logo, an image and a GIF. */
async function some(deps: Deps, a: Acct) {
  const tour = await uploadTour(deps, a.token, v3);
  let r = await send(deps, "POST", `/api/v1/tours/${tour.tour_id}/publish`, { token: a.token });
  while (r.status === 202) r = await send(deps, "POST", `/api/v1/tours/${tour.tour_id}/publish`, { token: a.token, body: JSON.stringify({ publish_id: r.json.publish_id }), headers: JSON_HEADERS });
  const image = await shareItem(deps, a.token, { kind: "image", content_type: "image/png", bytes: 500, width: 8, height: 8, title: "Shot" }, png(8, 8, 500));
  const clip = await shareItem(deps, a.token, { kind: "clip", content_type: "image/gif", bytes: 400, width: 8, height: 8, duration_ms: 500, title: "Loop" }, gif(8, 8, 400));
  return { tour, image, clip };
}

/** What every refused ticket answers: the dashboard's own sentence as plain text, never a file to save. */
function expectRefusedPage(c: Call, status: number): void {
  expect([c.status, c.text, c.headers.get("content-type"), c.headers.get("content-disposition"), c.headers.get("cache-control"), c.headers.get("x-content-type-options")]).toEqual([
    status,
    FAILURE_SENTENCE,
    "text/plain; charset=utf-8",
    null,
    "no-store",
    "nosniff",
  ]);
}

describe("Download all my data, after the review", () => {
  it("M1: 50 GETs of one ticket at once: one streams the zip; every other is refused at the claim, with no listing and at most two calls", async () => {
    const { deps } = await clocked();
    const a = await account(deps);
    await some(deps, a);
    let listings = 0;
    const first = deps.db.first.bind(deps.db);
    deps.db.first = (<T>(sql: string, params?: Parameters<Deps["db"]["first"]>[1]) => {
      if (sql.includes("json_group_array")) listings++;
      return first<T>(sql, params);
    }) as Deps["db"]["first"];
    const asked = await ask(deps, a.session);
    const all = await Promise.all(Array.from({ length: 50 }, () => fetchFile(deps, a.session, asked.json.url)));
    const won = all.filter((c) => c.status === 200);
    expect(won).toHaveLength(1);
    expect(filesOf(won[0].bytes).has("README.txt")).toBe(true);
    for (const c of all.filter((x) => x.status !== 200)) {
      expectRefusedPage(c, 404);
      expect(c.calls).toBeLessThanOrEqual(2);
    }
    expect(listings).toBe(1);
    expect(await deps.db.all("SELECT event FROM audit WHERE event = 'data_exported'")).toHaveLength(1);
  });

  it("M1: tour pages are built one at a time, as the zip reaches each tour, and the plan holds none", async () => {
    const { deps } = await clocked();
    const a = await account(deps);
    for (let i = 0; i < 6; i++) await uploadTour(deps, a.token, smallManifest(2, `Tour ${i}`));
    const log: string[] = [];
    const store = { put: deps.drafts.put.bind(deps.drafts), delete: deps.drafts.delete.bind(deps.drafts), get: (key: string) => (log.push("file"), deps.drafts.get(key)) };
    const read = await readListing(deps, { workspaceId: a.workspaceId, tokenId: "", session: { id: a.session.id, userId: a.userId, admin: false } }, null);
    const plan = planOf(deps.config, read.listing!, T0);
    expect(JSON.stringify(plan)).not.toContain("<!doctype");
    const render = async (t: Parameters<typeof offlinePageHtml>[0]) => (log.push("page"), offlinePageHtml(t));
    const zip = filesOf(new Uint8Array(await new Response(zipStream(exportEntries(plan, store, new Map(), T0, render))).arrayBuffer()));
    expect([...zip.keys()].filter((n) => n.endsWith("index.html"))).toHaveLength(6);
    // Each tour: its page, then its two pictures; never a second page before the first tour's files.
    expect(log.join(" ")).toBe(Array.from({ length: 6 }, () => "page file file").join(" "));
  });

  it("L2: a HEAD of a good ticket answers as an unknown path does, makes no call, and leaves the ticket good", async () => {
    const { deps } = await clocked();
    const a = await account(deps);
    const asked = await ask(deps, a.session);
    const head = await send(deps, "HEAD", asked.json.url, { headers: { cookie: a.session.cookie } });
    const unknown = await send(deps, "HEAD", "/api/v1/no-such-path", { headers: { cookie: a.session.cookie } });
    expect([head.status, head.headers.get("content-type"), head.headers.get("content-disposition")]).toEqual([unknown.status, unknown.headers.get("content-type"), null]);
    expect(head.status).toBe(404);
    expect(head.calls).toBe(0);
    expect((await fetchFile(deps, a.session, asked.json.url)).status).toBe(200);
  });

  it("L5: every refused ticket answers the dashboard's own sentence as plain text with no file name, so a browser shows it and saves nothing", async () => {
    const { deps, advance } = await clocked({ exportFileReads: 2 });
    const a = await account(deps);
    expectRefusedPage(await fetchFile(deps, a.session, `${EXPORT_PATH}/${"0".repeat(76)}`), 404);
    expectRefusedPage(await fetchFile(deps, a.session, `${EXPORT_PATH}/x`), 404);
    const late = await ask(deps, a.session);
    advance(TICKET_MS);
    expectRefusedPage(await fetchFile(deps, a.session, late.json.url), 404);
    const asked = await ask(deps, a.session);
    await uploadTour(deps, a.token, smallManifest(3, "Grown"));
    expectRefusedPage(await fetchFile(deps, a.session, asked.json.url), 409);
    expect(FAILURE_SENTENCE).toBe("Something went wrong. Try again in a moment.");
  });

  it("L5: the page can ask whether a download of its own workspace is still going, a session alone", async () => {
    const { deps, advance } = await clocked();
    const a = await account(deps);
    const b = await account(deps);
    const state = async (s: Session) => {
      const r = await send(deps, "GET", EXPORT_PATH, { headers: { cookie: s.cookie } });
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.calls).toBeLessThanOrEqual(3);
      return r.json;
    };
    expect(await state(a.session)).toEqual({ running: false });
    const asked = await ask(deps, a.session);
    expect([await state(a.session), await state(b.session)]).toEqual([{ running: true }, { running: false }]);
    expect((await fetchFile(deps, a.session, asked.json.url)).status).toBe(200);
    expect(await state(a.session)).toEqual({ running: false });
    await ask(deps, a.session);
    advance(TICKET_MS);
    expect(await state(a.session)).toEqual({ running: false });
    expect((await send(deps, "GET", EXPORT_PATH, { token: a.token })).status).toBe(401);
    expect((await send(deps, "GET", EXPORT_PATH)).status).toBe(401);
  });

  it("exportInProgress: a ticket ready for its minute, a download running until its limit, nothing else, and only its own workspace", async () => {
    const { deps } = await clocked();
    const a = await account(deps);
    const b = await account(deps);
    const now = deps.now();
    expect(await exportInProgress(deps, a.workspaceId, now)).toBe(false);
    const asked = await ask(deps, a.session);
    expect([await exportInProgress(deps, a.workspaceId, now), await exportInProgress(deps, b.workspaceId, now)]).toEqual([true, false]);
    expect(await exportInProgress(deps, a.workspaceId, now + TICKET_MS)).toBe(false);
    const res = await createApp(deps).fetch(new Request(ORIGIN + asked.json.url, { headers: { cookie: a.session.cookie } }));
    const reader = res.body!.getReader();
    await reader.read();
    expect(await exportInProgress(deps, a.workspaceId, now + TICKET_MS)).toBe(true);
    expect(await exportInProgress(deps, a.workspaceId, now + RUNNING_MS - 1)).toBe(true);
    expect(await exportInProgress(deps, a.workspaceId, now + RUNNING_MS)).toBe(false);
    expect(await exportInProgress(deps, b.workspaceId, now)).toBe(false);
    await reader.cancel();
    expect(await exportInProgress(deps, a.workspaceId, now)).toBe(false);
  });

  it("terms: an account that has not agreed to the site's current terms can still ask for, follow and download its data", async () => {
    const { deps } = await clocked();
    const a = await account(deps);
    await uploadTour(deps, a.token, smallManifest(1, "Mine"));
    const read = await parseTerms(new TextEncoder().encode("title: Terms\nversion: 1\nmain points:\n- One point.\nterms:\nThe terms.\n"));
    if (!read.ok) throw new Error(read.reason);
    expect((await publishTerms(deps, read)).ok).toBe(true);
    expect((await send(deps, "GET", "/api/v1/sessions", { headers: { cookie: a.session.cookie } })).json.error).toBe("terms_required");
    const files = await zipOf(deps, a.session);
    expect(listOf(files).tours.map((t: Json) => t.title)).toEqual(["Mine"]);
    expect((await send(deps, "GET", EXPORT_PATH, { headers: { cookie: a.session.cookie } })).status).toBe(200);
  });

  it("a disabled account cannot download", async () => {
    const { deps } = await clocked();
    const a = await account(deps);
    const asked = await ask(deps, a.session);
    await deps.db.run("UPDATE user SET status = 'disabled' WHERE id = ?", [a.userId]);
    expect((await fetchFile(deps, a.session, asked.json.url)).status).toBe(401);
    expect((await ask(deps, a.session)).status).toBe(401);
  });

  it("L7: links are full addresses from the configured hosts, never the request's; steps are those the page shows; a logo of no known type is no file", async () => {
    const { deps } = await clocked({ hosts: { tours: "tours.example.com", app: "app.example.com", img: "img.example.com" } });
    const a = await account(deps);
    const w = await some(deps, a);
    await deps.db.run("UPDATE tour SET logo_type = NULL WHERE id = ?", [w.tour.tour_id]);
    const files = await zipOf(deps, a.session, APP);
    const list = listOf(files);
    expect(list.tours[0].link).toMatch(/^https:\/\/tours\.example\.com\/t\/[a-z2-7]{10}$/);
    expect(list.images[0].link).toBe(`https://img.example.com/i/${w.image.link}`);
    expect(list.clips[0].link).toBe(`https://img.example.com/r/${w.clip.link}`);
    const readme = text(files.get("README.txt"));
    expect(readme).toContain(`at ${list.tours[0].link}`);
    expect(readme).toContain(`at https://img.example.com/i/${w.image.link}`);
    expect(readme).not.toContain("app.example.com");
    expect(files.has("tours/send-an-invoice/pictures/logo.png")).toBe(false);
    expect(list.tours[0].files.some((f: Json) => String(f.path).endsWith("logo.png"))).toBe(false);
    expect(list.tours[0].bytes).toBe(48213 + 51022 + 402117);
    expect(list.tours[0].steps).toBe(3);
  });

  it("L7: shared items without an image address are on the tours address; with one address and a site host, both are on it; with neither, a link is the path", async () => {
    const two = await clocked({ hosts: { tours: "tours.example.com", app: "app.example.com" } });
    const a = await account(two.deps);
    const w = await some(two.deps, a);
    expect(listOf(await zipOf(two.deps, a.session, APP)).images[0].link).toBe(`https://tours.example.com/i/${w.image.link}`);
    const site = await clocked({ siteHost: "demo.example.com" });
    const b = await account(site.deps);
    const wb = await some(site.deps, b);
    const listB = listOf(await zipOf(site.deps, b.session));
    expect([listB.images[0].link, listB.tours[0].link]).toEqual([`https://demo.example.com/i/${wb.image.link}`, expect.stringMatching(/^https:\/\/demo\.example\.com\/t\/[a-z2-7]{10}$/)]);
    const none = await clocked();
    const c = await account(none.deps);
    const wc = await some(none.deps, c);
    const listC = listOf(await zipOf(none.deps, c.session));
    expect([listC.images[0].link, listC.tours[0].link]).toEqual([`/i/${wc.image.link}`, expect.stringMatching(/^\/t\/[a-z2-7]{10}$/)]);
  });

  it("L7: the file count asked before the download leaves out a logo of no known type", async () => {
    const { deps } = await clocked({ exportFileReads: 3 });
    const a = await account(deps);
    const made = await uploadTour(deps, a.token, smallManifest(3, "Three"));
    await deps.db.run("UPDATE tour SET logo_key = 'u/x/logo.png', logo_bytes = 10, logo_type = NULL WHERE id = ?", [made.tour_id]);
    expect((await ask(deps, a.session)).status).toBe(200);
  });

  it("README.txt's words live in one object, and a clip of three parts is still whole", async () => {
    expect(README_WORDS.title).toBe("Your data");
    for (const v of Object.values(README_WORDS)) expect(["string", "function", "object"]).toContain(typeof v);
    const { deps } = await clocked();
    const a = await account(deps);
    const file = mp4(PART_BYTES * 2 + 7);
    await shareItem(deps, a.token, { kind: "clip", content_type: "video/mp4", bytes: file.length, width: 8, height: 8, duration_ms: 500, title: "Three" }, file);
    expect((await zipOf(deps, a.session)).get("clips/three.mp4")).toEqual(file);
  });
});
