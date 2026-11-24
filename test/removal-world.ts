// Shared set-up of the removal tests (test/billing-removal*.test.ts): a site with billing on and
// a clock that moves only when told, A and B made at T0, and the helpers that publish, share,
// visit, record warnings and end subscriptions. Fake Stripe and the fake mailer only.
import { expect } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { billingSweep, type SweepOptions } from "../src/billing-sweep.ts";
import { DAY, TRIAL_MS } from "../src/billing-rules.ts";
import type { Deps } from "../src/ports.ts";
import { emailSha256 } from "../src/removal-store.ts";
import { clone, fixtures, png, send, uploadTour, type Json } from "./bundle.ts";
import { withBilling, type FakeStripe } from "./fake-stripe.ts";

/** A and B are made at T0: their trials end on 10 April 2027 at 14:23 UTC, and their removal day is 11 April. */
export const T0 = Date.UTC(2027, 0, 10, 14, 23);
export const TRIAL_END = T0 + TRIAL_MS;
export const REMOVAL_DAY = Date.UTC(2027, 3, 11);
/** 03:00 UTC on a day, when the daily sweep runs in these tests. */
export const at3 = (month: number, day: number, year = 2027) => Date.UTC(year, month, day, 3, 0);
export const ORIGIN = "https://tours.example.com";
export const SUBSCRIBE = `${ORIGIN}/billing/subscribe`;
export const ACCOUNT = `${ORIGIN}/account`;
export const DOWNLOAD = `You can download everything in your account first: ${ACCOUNT}`;

export type Side = { workspaceId: string; userId: string; token: string; email: string };

export async function site(opts: { mail?: boolean; billing?: boolean } = {}) {
  const ctx = await makeDeps({}, { mail: opts.mail ?? true });
  let now = T0;
  ctx.deps.now = () => now;
  const stripe = opts.billing === false ? (null as unknown as FakeStripe) : withBilling(ctx.deps);
  if (opts.billing === false) ctx.deps.config = { ...ctx.deps.config, siteHost: "tours.example.com" };
  const admin = await seedAccount(ctx.deps, { username: "siteadmin", admin: true });
  const a = await seedAccount(ctx.deps, { username: "alpha" });
  const b = await seedAccount(ctx.deps, { username: "bravo" });
  return { ...ctx, stripe, admin, a, b, now: () => now, at: (ms: number) => (now = ms) };
}
export type Site = Awaited<ReturnType<typeof site>>;

export const sweep = (s: Site, opts: Partial<SweepOptions> = {}) => billingSweep(s.deps, { removal: true, ...opts });

/** One sweep at 03:00 UTC each day from `from` to `to`, both included. */
export async function daily(s: Site, from: number, to: number, opts: Partial<SweepOptions> = {}) {
  for (let t = from; t <= to; t += DAY) {
    s.at(t);
    await sweep(s, opts);
  }
}

export function manifest(title: string): Json {
  const m = clone(fixtures.v2 as Json);
  m.title = title;
  m.steps = [{ ...clone(m.steps[1]), image: "step-001.png", width: 64, height: 64, bytes: 120 }];
  return m;
}

/** A published public tour of this side: its id, slug and one live picture's name under /p/. */
export async function publishedTour(s: Site, side: Side, title = "Removal") {
  const tour = await uploadTour(s.deps, side.token, manifest(title));
  let pub = await send(s.deps, "POST", `/api/v1/tours/${tour.tour_id}/publish`, { token: side.token });
  while (pub.status === 202) pub = await send(s.deps, "POST", `/api/v1/tours/${tour.tour_id}/publish`, { token: side.token, headers: { "content-type": "application/json" }, body: JSON.stringify({ publish_id: pub.json.publish_id }) });
  expect(pub.status, pub.text).toBe(200);
  const row = await s.deps.db.first<{ slug: string; key: string }>("SELECT t.slug AS slug, o.image_key AS key FROM tour t JOIN snapshot_object o ON o.tour_id = t.id WHERE t.id = ? LIMIT 1", [tour.tour_id]);
  return { id: tour.tour_id, slug: row!.slug, picture: "/" + row!.key };
}

/** A public shared image of this side: its id and its page's path. */
export async function sharedImage(s: Site, side: Side) {
  const made = await send(s.deps, "POST", "/api/v1/media", { token: side.token, headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "image", content_type: "image/png", bytes: 300, width: 8, height: 8, title: "Shot" }) });
  expect(made.status, made.text).toBe(201);
  const id = made.json.id as string;
  expect((await send(s.deps, "PUT", `/api/v1/media/${id}/parts/0`, { token: side.token, body: png(8, 8, 300, 3) as NonNullable<RequestInit["body"]> })).status).toBe(204);
  const done = await send(s.deps, "POST", `/api/v1/media/${id}/commit`, { token: side.token });
  expect(done.status, done.text).toBe(200);
  return { id, path: done.json.path as string };
}

/** What a visitor gets: status, every header and the body, byte for byte. */
export async function visit(deps: Deps, path: string) {
  const r = await send(deps, "GET", path);
  return { status: r.status, headers: [...r.headers.entries()].sort(), body: [...r.bytes] };
}

export const exists = async (deps: Deps, ws: string) => (await deps.db.first("SELECT 1 AS x FROM workspace WHERE id = ?", [ws])) !== null;
export const userStatus = async (deps: Deps, id: string) => (await deps.db.first<{ status: string }>("SELECT status FROM user WHERE id = ?", [id]))?.status ?? null;
export const warnings = (deps: Deps, ws: string) => deps.db.all<Json>("SELECT stage, removal_at, sent_at, named_at, email_sha256 FROM billing_warning WHERE workspace_id = ? ORDER BY claimed_at, stage DESC", [ws]);
export const mailsTo = (s: Site, to: string) => s.mail.sent.filter((m) => m.to === to);
export const audits = (deps: Deps, ws: string, event: string) => deps.db.all<Json>("SELECT event, user_id, workspace_id, subject, detail FROM audit WHERE workspace_id = ? AND event = ? ORDER BY at, id", [ws, event]);

/** Records the three warnings of a side as accepted, at these times, for this removal day (test set-up, not the sweep). */
export async function warned(s: Site, side: Side, removalAt: number, sent: [number, number, number], email = side.email) {
  const sha = await emailSha256(email);
  for (const [i, stage] of ([30, 7, 1] as const).entries()) {
    await s.deps.db.run("INSERT INTO billing_warning (workspace_id, removal_at, stage, email_sha256, claimed_at, sent_at, named_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [side.workspaceId, removalAt, stage, sha, sent[i], sent[i], removalAt]);
  }
}
/** The usual on-time warnings of A's and B's trial clock. */
export const ON_TIME: [number, number, number] = [at3(2, 12), at3(3, 4), at3(3, 10)];

/** Puts a side on an ended subscription, ended at `endedAt`, as Stripe has it too. */
export async function ended(s: Site, side: Side, endedAt: number, n: string) {
  await s.deps.db.run(
    "UPDATE workspace SET stripe_customer_id = ?, stripe_subscription_id = ?, subscription_status = 'canceled', subscription_period_end = ?, subscription_ended_at = ? WHERE id = ?",
    [`cus_${n}`, `sub_${n}`, endedAt, endedAt, side.workspaceId],
  );
  s.stripe.subscription(`sub_${n}`, `cus_${n}`, "canceled", { endedAt: Math.floor(endedAt / 1000), periodEnd: Math.floor(endedAt / 1000) });
}

export const keysOf = (s: Site) => ({ draftKeys: s.draftKeys, publicKeys: s.publicKeys });

