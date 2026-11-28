// The two buckets stay two (0.1.71): with FILE_STORE=r2 through the real app wiring (the
// harness builds the stores from the settings with the app's factory, in the node-r2 project of
// vitest.node.config.ts), each file is looked for in the stand-in's own buckets, not through
// the store's lister. A public tour's pictures land only in the public bucket; drafts, shared
// items and a restricted tour's pictures only in the private one; a switch to restricted leaves
// nothing behind in the public bucket, also when a delete from it fails part-way; deleting a tour
// or an account leaves neither bucket holding its files.
// Runs only in that project: on disk the same cases are in test/access.test.ts and the others.
import { describe, expect, it } from "vitest";
import { HARNESS_FILES, makeDeps, seedAccount } from "#harness";
import type { Deps } from "../src/ports.ts";
import { createSignInCode, csrfFor, redeemSignInCode, SESSION_COOKIE } from "../src/sessions.ts";
import { mp4, ORIGIN, png, send, uploadTour } from "./bundle.ts";
import { manifestOf } from "./isolation-world.ts";

const JSON_HEADERS = { "content-type": "application/json" };

async function site() {
  const ctx = await makeDeps({ siteHost: "tours.example.com" });
  if (ctx.r2 === null) throw new Error("this file runs on R2 only");
  const owner = await seedAccount(ctx.deps, { admin: true });
  const made = await redeemSignInCode(ctx.deps, await createSignInCode(ctx.deps, owner.userId), null, null);
  const session = { cookie: `${SESSION_COOKIE}=${made!.secret}`, "x-csrf-token": await csrfFor(made!.secret), origin: ORIGIN, "sec-fetch-site": "same-origin" };
  const { standIn, privateBucket, publicBucket } = ctx.r2;
  return {
    ...ctx,
    standIn,
    privateBucket,
    publicBucket,
    owner,
    session,
    /** The same, through the store lister the harness gives. */
    listedPublic: ctx.publicKeys,
    listedPrivate: ctx.draftKeys,
    /** The keys each bucket of the stand-in holds, read from the stand-in itself. */
    privateKeys: () => [...standIn.buckets.get(privateBucket)!.keys()].sort(),
    publicKeys: () => [...standIn.buckets.get(publicBucket)!.keys()].sort(),
  };
}

async function publish(deps: Deps, token: string, tourId: string): Promise<void> {
  let r = await send(deps, "POST", `/api/v1/tours/${tourId}/publish`, { token });
  for (let i = 0; r.status === 202; i++) {
    if (i > 60) throw new Error("publish does not finish");
    r = await send(deps, "POST", `/api/v1/tours/${tourId}/publish`, { token, headers: JSON_HEADERS, body: JSON.stringify({ publish_id: r.json.publish_id }) });
  }
  expect(r.status, r.text).toBe(200);
}

async function setAccess(deps: Deps, session: Record<string, string>, tourId: string, body: unknown): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const r = await send(deps, "PUT", `/api/v1/tours/${tourId}/access`, { headers: { ...JSON_HEADERS, ...session }, body: JSON.stringify(body) });
    if (r.status === 202) continue;
    expect(r.status, r.text).toBe(200);
    return;
  }
  throw new Error("the change does not finish");
}

describe.skipIf(HARNESS_FILES !== "r2")("the private and the public bucket on R2", () => {
  it("drafts go to the private bucket only; a public tour's pictures to the public bucket only", async () => {
    const s = await site();
    const t = await uploadTour(s.deps, s.owner.token, manifestOf([200, 201, 202], "Public tour", true), { kind: "new" }, 3);
    expect(s.publicKeys()).toEqual([]);
    expect(s.privateKeys().length).toBeGreaterThan(0);
    expect(s.privateKeys().every((k) => k.startsWith("u/"))).toBe(true);
    await publish(s.deps, s.owner.token, t.tour_id);
    expect(s.publicKeys().length).toBeGreaterThan(0);
    expect(s.publicKeys().every((k) => /^p\/[0-9a-f]{32}\.(png|jpg)$/.test(k))).toBe(true);
    expect(s.privateKeys().some((k) => k.startsWith("p/"))).toBe(false);
    // What the app's own lister says is what the stand-in holds.
    expect(await s.listedPublic()).toEqual(s.publicKeys());
    expect(await s.listedPrivate()).toEqual(s.privateKeys());
  });

  it("a restricted tour's pictures are in the private bucket only, and the switch leaves nothing in the public bucket; back to public moves them back", async () => {
    const s = await site();
    const t = await uploadTour(s.deps, s.owner.token, manifestOf([200, 201], "Becomes restricted", true), { kind: "new" }, 3);
    await publish(s.deps, s.owner.token, t.tour_id);
    const before = s.publicKeys();
    expect(before.length).toBeGreaterThan(0);
    await setAccess(s.deps, s.session, t.tour_id, { access: "me" });
    expect(s.publicKeys()).toEqual([]);
    expect(s.privateKeys().filter((k) => k.startsWith("v/")).length).toBe(before.length);
    expect(s.privateKeys().some((k) => k.startsWith("p/"))).toBe(false);
    // Publishing again while restricted keeps the public bucket empty.
    await publish(s.deps, s.owner.token, t.tour_id);
    expect(s.publicKeys()).toEqual([]);
    await setAccess(s.deps, s.session, t.tour_id, { access: "public" });
    expect(s.publicKeys().length).toBe(before.length);
    expect(s.privateKeys().filter((k) => k.startsWith("v/"))).toEqual([]);
  });

  it("a shared image goes to the private bucket only", async () => {
    const s = await site();
    const spec = { kind: "image", content_type: "image/png", bytes: 5000, width: 640, height: 480 };
    const made = await send(s.deps, "POST", "/api/v1/media", { token: s.owner.token, body: JSON.stringify(spec), headers: JSON_HEADERS });
    expect(made.status, made.text).toBe(201);
    const id = made.json.id as string;
    const part = await send(s.deps, "PUT", `/api/v1/media/${id}/parts/0`, { token: s.owner.token, body: png(640, 480, 5000, 0) as NonNullable<RequestInit["body"]> });
    expect(part.status, part.text).toBe(204);
    const done = await send(s.deps, "POST", `/api/v1/media/${id}/commit`, { token: s.owner.token });
    expect(done.status, done.text).toBe(200);
    expect(s.publicKeys()).toEqual([]);
    expect(s.privateKeys().filter((k) => k.startsWith(`m/${id}/`)).length).toBeGreaterThan(0);
  });

  it("deleting a tour leaves neither bucket holding its files", async () => {
    const s = await site();
    const t = await uploadTour(s.deps, s.owner.token, manifestOf([200, 201, 202], "To delete", true), { kind: "new" }, 3);
    await publish(s.deps, s.owner.token, t.tour_id);
    expect(s.publicKeys().length + s.privateKeys().length).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) {
      const r = await send(s.deps, "DELETE", `/api/v1/tours/${t.tour_id}`, { token: s.owner.token });
      if (r.status === 404) break;
      expect([200, 202, 204], r.text).toContain(r.status);
    }
    await s.settle();
    expect(s.publicKeys()).toEqual([]);
    expect(s.privateKeys()).toEqual([]);
  });
});

/** Shares an item through the API and returns its id. */
async function share(deps: Deps, token: string, spec: { kind: "image" | "clip"; content_type: string; bytes: number; width: number; height: number; duration_ms?: number }, file: Uint8Array): Promise<string> {
  const made = await send(deps, "POST", "/api/v1/media", { token, body: JSON.stringify(spec), headers: JSON_HEADERS });
  expect(made.status, made.text).toBe(201);
  const id = made.json.id as string;
  for (let n = 0; n < made.json.parts; n++) {
    const part = await send(deps, "PUT", `/api/v1/media/${id}/parts/${n}`, { token, body: file.subarray(n * 2_000_000, (n + 1) * 2_000_000) as NonNullable<RequestInit["body"]> });
    expect(part.status, part.text).toBe(204);
  }
  const done = await send(deps, "POST", `/api/v1/media/${id}/commit`, { token });
  expect(done.status, done.text).toBe(200);
  return id;
}

describe.skipIf(HARNESS_FILES !== "r2")("more of the two buckets on R2", () => {
  it("a restricted shared image and a restricted clip are in the private bucket only", async () => {
    const s = await site();
    const image = await share(s.deps, s.owner.token, { kind: "image", content_type: "image/png", bytes: 5000, width: 640, height: 480 }, png(640, 480, 5000, 1));
    const clip = await share(s.deps, s.owner.token, { kind: "clip", content_type: "video/mp4", bytes: 6000, width: 640, height: 480, duration_ms: 3000 }, mp4(6000, 2));
    for (const id of [image, clip]) {
      const r = await send(s.deps, "PUT", `/api/v1/media/${id}/access`, { headers: { ...JSON_HEADERS, ...s.session }, body: JSON.stringify({ access: "me" }) });
      expect(r.status, r.text).toBe(200);
    }
    expect(s.publicKeys()).toEqual([]);
    for (const id of [image, clip]) expect(s.privateKeys().filter((k) => k.startsWith(`m/${id}/`)).length, id).toBeGreaterThan(0);
  });

  it("a tour's logo is a draft in the private bucket, and goes to the public bucket only with the public tour", async () => {
    const s = await site();
    const t = await uploadTour(s.deps, s.owner.token, manifestOf([200, 201], "With a logo", true), { kind: "new" }, 3);
    const logo = await s.deps.db.first<{ logo_key: string }>("SELECT logo_key FROM tour WHERE id = ?", [t.tour_id]);
    expect(logo!.logo_key).toMatch(/^u\//);
    expect(s.privateKeys()).toContain(logo!.logo_key);
    await publish(s.deps, s.owner.token, t.tour_id);
    // Two steps and the logo.
    expect(s.publicKeys()).toHaveLength(3);
    await setAccess(s.deps, s.session, t.tour_id, { access: "me" });
    expect(s.publicKeys()).toEqual([]);
    expect(s.privateKeys().filter((k) => k.startsWith("v/"))).toHaveLength(3);
  });

  it("deleting an account leaves neither bucket holding anything of its workspace", async () => {
    const s = await site();
    const member = await seedAccount(s.deps, { username: "rook" });
    const t = await uploadTour(s.deps, member.token, manifestOf([200, 201], "Member's tour", true), { kind: "new" }, 3);
    await publish(s.deps, member.token, t.tour_id);
    await share(s.deps, member.token, { kind: "image", content_type: "image/png", bytes: 5000, width: 640, height: 480 }, png(640, 480, 5000, 4));
    expect(s.publicKeys().length).toBeGreaterThan(0);
    expect(s.privateKeys().length).toBeGreaterThan(0);
    const admin = { ...s.session, ...JSON_HEADERS };
    expect((await send(s.deps, "POST", `/api/v1/admin/accounts/${member.userId}/disable`, { headers: s.session })).status).toBe(204);
    let r = await send(s.deps, "DELETE", `/api/v1/admin/accounts/${member.userId}`, { headers: admin, body: JSON.stringify({ username: "rook" }) });
    for (let i = 0; r.status === 202 && i < 40; i++) r = await send(s.deps, "DELETE", `/api/v1/admin/accounts/${member.userId}`, { headers: admin, body: JSON.stringify({ username: "rook" }) });
    expect(r.status, r.text).toBe(200);
    await s.settle();
    expect(s.publicKeys()).toEqual([]);
    expect(s.privateKeys()).toEqual([]);
  });

  it("a switch to restricted whose delete from the public bucket fails part-way: in between the picture left behind is never served; retried to its end, nothing is left in the public bucket", async () => {
    const s = await site();
    const t = await uploadTour(s.deps, s.owner.token, manifestOf([200, 201, 202], "Switch that breaks", true), { kind: "new" }, 3);
    await publish(s.deps, s.owner.token, t.tour_id);
    const slug = (await s.deps.db.first<{ slug: string }>("SELECT slug FROM tour WHERE id = ?", [t.tour_id]))!.slug;
    const before = s.publicKeys();
    expect(before).toHaveLength(4);
    let fired = false;
    s.standIn.fault = (q) => {
      if (fired || q.method !== "POST" || q.path !== `/${s.publicBucket}`) return null;
      fired = true;
      return { kind: "delete-error", key: before[0], code: "InternalError" };
    };
    const body = JSON.stringify({ access: "me" });
    try {
      for (let i = 0; i < 60 && !fired; i++) {
        const r = await send(s.deps, "PUT", `/api/v1/tours/${t.tour_id}/access`, { headers: { ...JSON_HEADERS, ...s.session }, body });
        if (r.status === 200 && !fired) throw new Error("the switch ended before its delete from the public bucket");
      }
    } finally {
      s.standIn.fault = null;
    }
    expect(fired).toBe(true);
    // In between, right after the call whose delete failed: one picture is still in the public
    // bucket, the four restricted copies are in the private one, and neither the picture's
    // address nor the tour's page shows anything: each answers as an unknown one does.
    expect(s.publicKeys()).toEqual([before[0]]);
    expect(s.privateKeys().filter((k) => k.startsWith("v/"))).toHaveLength(4);
    const leftover = await send(s.deps, "GET", `/${before[0]}`);
    const unknownPicture = await send(s.deps, "GET", `/p/${"0".repeat(32)}.png`);
    expect([leftover.status, leftover.text]).toEqual([unknownPicture.status, unknownPicture.text]);
    const page = await send(s.deps, "GET", `/t/${slug}`);
    expect(page.status === 403 || page.status === (await send(s.deps, "GET", "/t/aaaaaaaaaa")).status).toBe(true);
    expect(page.text).not.toContain(before[0].slice(2));
    // Retried to its end, as the dashboard does: nothing of the tour is left in the public bucket.
    await setAccess(s.deps, s.session, t.tour_id, { access: "me" });
    expect(s.publicKeys()).toEqual([]);
    expect(await s.deps.db.first("SELECT 1 AS x FROM public_object WHERE image_key = ?", [before[0]])).toBeNull();
  });
});
