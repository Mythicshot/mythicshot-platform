// The two buckets stay two (0.1.71): with FILE_STORE=r2 through the real app wiring (the
// harness builds the stores from the settings with the app's factory, in the node-r2 project of
// vitest.node.config.ts), each file is looked for in the stand-in's own buckets, not through
// the store's lister. A public tour's pictures land only in the public bucket; drafts, shared
// items and a restricted tour's pictures only in the private one; a switch to restricted leaves
// nothing behind in the public bucket; deleting a tour leaves neither bucket holding its files.
// Runs only in that project: on disk the same cases are in test/access.test.ts and the others.
import { describe, expect, it } from "vitest";
import { HARNESS_FILES, makeDeps, seedAccount } from "#harness";
import type { Deps } from "../src/ports.ts";
import { createSignInCode, csrfFor, redeemSignInCode, SESSION_COOKIE } from "../src/sessions.ts";
import { ORIGIN, png, send, uploadTour } from "./bundle.ts";
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
