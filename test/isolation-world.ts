// The world the cross-workspace suite (test/isolation.test.ts) runs in: two workspaces
// that each hold one of everything a workspace can hold, the ids of all of it, stand-in
// ids that never existed, and the two ways the suite looks at what is stored.
//
// Each workspace ("side") is built through the API as a client would build it, with its
// own token:
// - a published tour with a logo, published twice, so it has a live snapshot, live public
//   pictures and public pictures a re-publish retired that are still inside their grace;
// - a draft-only tour whose chapter was replaced once (a committed replace, whose clean-up
//   was cut off, so the picture it took out still waits to be removed) and has a second
//   replace open that reuses one of its pictures by hash;
// - an open upload for a new tour: step 1 sent, step 2 and the logo not;
// - a tour of 13 steps with a publish in progress (12 pictures copied, not live);
// - a tour whose delete was cut off after its rows went and before its files did;
// - a second token that was revoked (written by SQL: no route revokes a token yet);
// - two live sessions of its account, signed in as the server signs a browser in; the
//   first is the one the suite sends requests with. The first side's account is the site's
//   admin, since nobody can sign in on a site without one;
// - an open change of its account's email address, as asking for one leaves it (written by
//   SQL, since asking needs a site that can mail), with the code its link would carry;
// - three shared items: an online image with a preview, an online GIF clip, and an
//   unfinished image whose one part and preview are sent but which is not committed;
// - three requests to connect the app, each started by the app and settled by the side's
//   session: one confirmed and not collected, one confirmed and collected (so the side has a
//   token made by connecting), and one refused.
// Beside the two sides, the site holds one open invite the first side's account (the
// admin) sent, written by SQL as sending one leaves it, with the code its link would carry.
// An invite belongs to no workspace (SHARED) until it is accepted, which makes a new one.
//
// The two sides differ in every title, every picture's bytes and every size, so a value of
// one can never be mistaken for the other's.
//
// world() also takes over the clock (a fixed time that only tick() moves) and puts a
// journal in front of both stores: every put and delete any request makes is recorded.
//
import { seedAccount } from "#harness";
import { hashToken, newId, newLinkId, newSlug, newToken } from "../src/auth.ts";
import { formatUserCode, newUserCode } from "../src/connect.ts";
import { originOf } from "../src/hosts.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import type { Deps, FileStore } from "../src/ports.ts";
import { LIMITS_CONNECT } from "../src/rate.ts";
import { ORIGIN, clone, commit, createUpload, fixtures, gif, logoPng, png, putStep, send, sha256Hex, stepImage, uploadTour, type Call, type Json } from "./bundle.ts";

/** The harness's listing of both stores (`makeDeps()` returns it beside `deps`). */
export type StoreKeys = { draftKeys: () => Promise<string[]>; publicKeys: () => Promise<string[]> };

type TourIds = { tour: string; chapter: string; step: string; slug: string };

/**
 * Every id of one side that a request can name. `inventedIds` makes the same shape out of
 * ids that never existed.
 */
export type Ids = {
  /** Published twice: live, with one live and one retired public picture name and the live publish's id. */
  published: TourIds & { publicName: string; retiredName: string; publishId: string; sha256: string[] };
  /** Never published. `committedUpload` made its chapter, `committedReplace` replaced it; both are gone as uploads. */
  draft: TourIds & { sha256: string[]; committedUpload: string; committedReplace: string };
  /** A publish in progress: `pendingName` is a picture it has already copied to the public store. */
  publishing: TourIds & { publishId: string; pendingName: string };
  /** Half deleted: the tour row is gone, its deletion and its files are not. */
  deleting: { tour: string };
  /** An open upload for a new tour: step 1 sent, step 2 and the logo not. */
  upload: string;
  /** An open upload that replaces the draft tour's chapter: step 1 reused, step 2 not sent. */
  replaceUpload: string;
  /** Shared items: an online image (with a preview), an online clip, and an unfinished image (its part and preview sent); each with its link id. */
  media: { image: string; clip: string; uploading: string; imageLink: string; clipLink: string; uploadingLink: string };
  /**
   * The manifest steps of the two open uploads and of the draft chapter as it is now, and
   * the declared shape of the unfinished item, to build pictures that would be accepted.
   */
  pictures: { upload: Json[]; replaceUpload: Json[]; draft: Json[]; media: { width: number; height: number; bytes: number } };
  /** The byte the side's pictures are filled with. */
  fill: number;
  /** The session the suite sends the side's requests with, and a second live session of the same account. */
  session: string;
  otherSession: string;
  /** The side's tokens: the workspace's first, the revoked one, and the one connecting the app made. */
  tokens: { live: string; revoked: string; connected: string };
  /** The short codes of the side's requests to connect: confirmed by it and not collected, confirmed and collected, refused by it. */
  connect: { confirmed: string; collected: string; refused: string };
};

export type Side = {
  name: string;
  workspaceId: string;
  workspaceName: string;
  userId: string;
  email: string;
  token: string;
  tokenId: string;
  revokedToken: string;
  revokedTokenId: string;
  /** The account's session: its secret, the Cookie header that carries it, and its anti-forgery value. */
  session: { id: string; secret: string; cookie: string; csrf: string };
  /** The code of the account's open email change, as the mail to the new address carries it. */
  emailCode: string;
  ids: Ids;
};

export type World = {
  deps: Deps;
  keys: StoreKeys;
  a: Side;
  b: Side;
  /** The open invite the first side's account sent: its id, its address and the code its link carries. */
  invite: { id: string; email: string; code: string };
  /** Moves the clock on. */
  tick: (ms?: number) => void;
  /** Every put and delete made on either store since the world was built or `forgetWrites` was called. */
  writes: () => string[];
  forgetWrites: () => void;
};

const T0 = 1_800_000_000_000;
const JSON_HEADERS = { "content-type": "application/json" };

function randomHex(chars: number): string {
  let s = "";
  for (const b of crypto.getRandomValues(new Uint8Array(chars / 2))) s += b.toString(16).padStart(2, "0");
  return s;
}

/** A manifest with one 64 x 64 PNG step per entry of `sizes`, each of that many bytes; with `logo`, a cover that names a PNG logo. */
export function manifestOf(sizes: number[], title: string, logo = false): Json {
  const m = clone((logo ? fixtures.v3 : fixtures.v2) as Json);
  m.title = title;
  if (!logo) m.cover = null;
  const base = m.steps[0];
  m.steps = sizes.map((bytes, i) => ({ ...clone(base), image: `step-${String(i + 1).padStart(3, "0")}.png`, width: 64, height: 64, bytes }));
  return m;
}

// The sizes of a side's pictures, from its base: no two pictures of the two sides weigh the same.
const sizes = (base: number) => ({
  published: [base + 1, base + 2],
  draft: [base + 3, base + 4],
  replaced: [base + 3, base + 5],
  openReplace: [base + 3, base + 8],
  upload: [base + 6, base + 7],
  large: Array.from({ length: 13 }, (_, i) => base + 10 + i),
  gone: [base + 30],
  media: { image: base + 40, clip: base + 41, uploading: base + 42 },
});

/**
 * Ids of the shape of a side's, none of which ever existed. The pictures and their fill
 * are those of `like` (so a request built from them carries the same bytes), or a set of
 * their own.
 */
export function inventedIds(like?: Ids): Ids {
  const tour = (): TourIds => ({ tour: newId("tour"), chapter: newId("ch"), step: newId("st"), slug: newSlug() });
  const name = () => randomHex(32) + ".png";
  const s = sizes(100);
  return {
    published: { ...tour(), publicName: name(), retiredName: name(), publishId: "pub_" + randomHex(24), sha256: [randomHex(64), randomHex(64)] },
    draft: { ...tour(), sha256: [randomHex(64), randomHex(64)], committedUpload: newId("up"), committedReplace: newId("up") },
    publishing: { ...tour(), publishId: "pub_" + randomHex(24), pendingName: name() },
    deleting: { tour: newId("tour") },
    upload: newId("up"),
    replaceUpload: newId("up"),
    media: { image: newId("med"), clip: newId("med"), uploading: newId("med"), imageLink: newLinkId(), clipLink: newLinkId(), uploadingLink: newLinkId() },
    pictures: like?.pictures ?? {
      upload: manifestOf(s.upload, "x", true).steps,
      replaceUpload: manifestOf(s.openReplace, "x").steps,
      draft: manifestOf(s.replaced, "x").steps,
      media: { width: 64, height: 64, bytes: s.media.uploading },
    },
    fill: like?.fill ?? 0,
    session: newId("ses"),
    otherSession: newId("ses"),
    tokens: { live: newId("tok"), revoked: newId("tok"), connected: newId("tok") },
    connect: { confirmed: formatUserCode(newUserCode()), collected: formatUserCode(newUserCode()), refused: formatUserCode(newUserCode()) },
  };
}

/** Every string in `ids` that names something: the ids, slugs, picture names and hashes. */
export function namesIn(ids: Ids): string[] {
  const out: string[] = [];
  const walk = (v: unknown, key: string) => {
    if (key === "pictures") return;
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) for (const x of v) walk(x, key);
    else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(ids, "");
  return out;
}

function must(call: Call, status: number, what: string): Call {
  if (call.status !== status) throw new Error(`the world could not be built: ${what} answered ${call.status} ${call.text}, not ${status}`);
  return call;
}

async function need<T>(row: Promise<T | null>, what: string): Promise<T> {
  const found = await row;
  if (found === null) throw new Error(`the world could not be built: no ${what}`);
  return found;
}

/** The one part of the unfinished item `pictures.media` describes, as its owner would send it. */
export function mediaPart(spec: { width: number; height: number; bytes: number }, fill: number): Uint8Array {
  return png(spec.width, spec.height, spec.bytes, fill);
}

/** Shares one item through the API: create, its one part, a preview when asked, and commit unless told not to. Returns the id and link id. */
async function shareItem(deps: Deps, token: string, body: Json, part: Uint8Array, opts: { preview: boolean; commit: boolean }): Promise<{ id: string; link: string }> {
  const made = must(await send(deps, "POST", "/api/v1/media", { token, body: JSON.stringify(body), headers: JSON_HEADERS }), 201, `the item ${body.title}`);
  const id = made.json.id as string;
  must(await send(deps, "PUT", `/api/v1/media/${id}/parts/0`, { token, body: part as NonNullable<RequestInit["body"]> }), 204, `the part of ${body.title}`);
  if (opts.preview) must(await send(deps, "PUT", `/api/v1/media/${id}/preview`, { token, body: logoPng(1000 + part.length) as NonNullable<RequestInit["body"]> }), 204, `the preview of ${body.title}`);
  if (!opts.commit) {
    const row = await need(deps.db.first<{ link_id: string }>("SELECT link_id FROM media WHERE id = ?", [id]), "unfinished item");
    return { id, link: row.link_id };
  }
  const done = must(await send(deps, "POST", `/api/v1/media/${id}/commit`, { token }), 200, `the commit of ${body.title}`);
  return { id, link: done.json.link_id as string };
}

/** A create that replaces a chapter, with the hash of each picture as the client would send it. */
export async function createReplace(deps: Deps, token: string, manifest: Json, target: unknown, sha256: string[]): Promise<Call> {
  return send(deps, "POST", "/api/v1/uploads", { token, body: JSON.stringify({ manifest, target, sha256 }), headers: JSON_HEADERS });
}

/** The hash of each picture `stepImage` makes for the manifest's steps. */
export function hashesOf(manifest: Json, fill: number): Promise<string[]> {
  return Promise.all((manifest.steps as Json[]).map((s) => sha256Hex(stepImage(s, fill))));
}

function journal(name: string, store: FileStore, log: string[]): FileStore {
  return {
    put: (key, body, meta) => (log.push(`${name} put ${key}`), store.put(key, body, meta)),
    get: (key) => store.get(key),
    delete: (keys) => (log.push(`${name} delete ${keys.join(" ")}`), store.delete(keys)),
  };
}

/** What a browser sends as its User-Agent; only the label made from it is stored. */
const BROWSER = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";

/** A session of the account, made as completing a sign-in makes one. The site must have an admin. */
async function signIn(deps: Deps, userId: string): Promise<Side["session"]> {
  const made = await redeemSignInCode(deps, await createSignInCode(deps, userId), BROWSER, null);
  if (made === null) throw new Error("the world could not be built: the sign-in was refused");
  return { id: made.sessionId, secret: made.secret, cookie: `${SESSION_COOKIE}=${made.secret}`, csrf: await csrfFor(made.secret) };
}

async function side(deps: Deps, name: string, base: number, fill: number, admin: boolean): Promise<Side> {
  const account = await seedAccount(deps, { admin });
  const { workspaceId, token } = account;
  const s = sizes(base);
  // Every account's workspace is seeded with the same name; these two must differ.
  const workspaceName = `${name} workspace`;
  await deps.db.run("UPDATE workspace SET name = ? WHERE id = ?", [workspaceName, workspaceId]);
  const tokenId = (await need(deps.db.first<{ id: string }>("SELECT id FROM api_token WHERE workspace_id = ? AND kind = 'setup'", [workspaceId]), "token")).id;
  const revokedToken = newToken();
  const revokedTokenId = newId("tok");
  await deps.db.run("INSERT INTO api_token (id, workspace_id, name, hash, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    revokedTokenId, workspaceId, `${name} revoked token`, await hashToken(revokedToken), deps.now(), deps.now(), deps.now(),
  ]);
  const publishOf = (tourId: string) => send(deps, "POST", `/api/v1/tours/${tourId}/publish`, { token });
  // One request sent while the drafts store refuses every delete, so its clean-up is left undone.
  const cutOff = async (run: (broken: Deps) => Promise<Call>): Promise<Call> => {
    const broken: Deps = { ...deps, drafts: { ...deps.drafts, delete: () => Promise.reject(new Error("the store is down")) } };
    const log = console.error;
    console.error = () => {};
    try {
      return await run(broken);
    } finally {
      console.error = log;
    }
  };

  // The published tour, published twice: the second publish retires the first one's pictures.
  const published = await uploadTour(deps, token, manifestOf(s.published, `${name} published tour`, true), { kind: "new" }, fill);
  must(await publishOf(published.tour_id), 200, "the first publish");
  must(await publishOf(published.tour_id), 200, "the second publish");

  // The draft tour: its chapter replaced once, and a second replace left open. Both reuse the first picture.
  const draft = await uploadTour(deps, token, manifestOf(s.draft, `${name} draft tour`), { kind: "new" }, fill);
  const replaceTarget = { kind: "replace", tour_id: draft.tour_id, chapter_id: draft.chapter_id };
  const replaced = manifestOf(s.replaced, `${name} draft tour`);
  const first = must(await createReplace(deps, token, replaced, replaceTarget, await hashesOf(replaced, fill)), 201, "the replace");
  if (JSON.stringify(first.json.have) !== "[1]") throw new Error("the world could not be built: the replace did not reuse its first picture");
  must(await putStep(deps, token, first.json.upload_id, 2, stepImage(replaced.steps[1], fill)), 204, "the replace's second step");
  must(await cutOff((broken) => commit(broken, token, first.json.upload_id)), 201, "the replace's commit");
  await need(deps.db.first("SELECT 1 AS x FROM replaced_object WHERE tour_id = ?", [draft.tour_id]), "replaced picture waiting to be removed");
  const openReplace = manifestOf(s.openReplace, `${name} draft tour`);
  const second = must(await createReplace(deps, token, openReplace, replaceTarget, await hashesOf(openReplace, fill)), 201, "the open replace");
  if (JSON.stringify(second.json.have) !== "[1]") throw new Error("the world could not be built: the open replace did not reuse its first picture");

  // The open upload for a new tour.
  const uploading = manifestOf(s.upload, `${name} upload in progress`, true);
  const upload = must(await createUpload(deps, token, uploading), 201, "the open upload").json.upload_id as string;
  must(await putStep(deps, token, upload, 1, stepImage(uploading.steps[0], fill)), 204, "the open upload's first step");

  // A publish in progress: 13 pictures are one more than a request copies.
  const large = await uploadTour(deps, token, manifestOf(s.large, `${name} large tour`), { kind: "new" }, fill);
  const publishing = must(await publishOf(large.tour_id), 202, "the publish in progress");

  // A delete cut off between its rows and its files: the store refuses the delete once.
  const gone = await uploadTour(deps, token, manifestOf(s.gone, `${name} tour being deleted`), { kind: "new" }, fill);
  must(await cutOff((broken) => send(broken, "DELETE", `/api/v1/tours/${gone.tour_id}`, { token })), 500, "the delete that is cut off");
  await need(deps.db.first("SELECT 1 AS x FROM tour_deletion WHERE tour_id = ?", [gone.tour_id]), "deletion in progress");

  // The shared items.
  const mediaSpec = { width: 64, height: 64, bytes: s.media.uploading };
  const image = await shareItem(deps, token, { kind: "image", content_type: "image/png", bytes: s.media.image, width: 64, height: 64, title: `${name} shared image` }, png(64, 64, s.media.image, fill), { preview: true, commit: true });
  const clip = await shareItem(deps, token, { kind: "clip", content_type: "image/gif", bytes: s.media.clip, width: 32, height: 32, duration_ms: 1200, title: `${name} shared clip` }, gif(32, 32, s.media.clip, fill), { preview: false, commit: true });
  const unfinished = await shareItem(deps, token, { kind: "image", content_type: "image/png", ...mediaSpec, title: `${name} unfinished item` }, mediaPart(mediaSpec, fill), { preview: true, commit: false });

  const tourIds = async (t: { tour_id: string; chapter_id: string }): Promise<TourIds & { sha256: string[] }> => {
    const slug = (await need(deps.db.first<{ slug: string }>("SELECT slug FROM tour WHERE id = ?", [t.tour_id]), "tour")).slug;
    const steps = await deps.db.all<{ id: string; sha256: string | null }>("SELECT id, sha256 FROM step WHERE tour_id = ? ORDER BY position, id", [t.tour_id]);
    if (steps.length === 0 || steps.some((x) => x.sha256 === null)) throw new Error("the world could not be built: a tour without hashed steps");
    return { tour: t.tour_id, chapter: t.chapter_id, step: steps[0].id, slug, sha256: steps.map((x) => x.sha256 as string) };
  };
  const nameOf = async (sql: string, tourId: string, what: string) => (await need(deps.db.first<{ image_key: string }>(sql, [tourId]), what)).image_key.slice(2);
  const live = await need(deps.db.first<{ publish_id: string }>("SELECT publish_id FROM snapshot WHERE tour_id = ?", [published.tour_id]), "snapshot");
  const { sha256: _unused, ...largeIds } = await tourIds(large);

  const ids: Ids = {
    published: {
      ...(await tourIds(published)),
      publicName: await nameOf("SELECT image_key FROM snapshot_object WHERE tour_id = ? ORDER BY image_key LIMIT 1", published.tour_id, "live public picture"),
      retiredName: await nameOf("SELECT image_key FROM public_object WHERE tour_id = ? AND state = 'retired' ORDER BY image_key LIMIT 1", published.tour_id, "retired public picture"),
      publishId: live.publish_id,
    },
    draft: { ...(await tourIds(draft)), committedUpload: "up_" + draft.chapter_id.slice(3), committedReplace: first.json.upload_id },
    publishing: {
      ...largeIds,
      publishId: publishing.json.publish_id,
      pendingName: await nameOf("SELECT image_key FROM public_object WHERE tour_id = ? AND state = 'pending' AND copied = 1 ORDER BY image_key LIMIT 1", large.tour_id, "copied picture of the publish in progress"),
    },
    deleting: { tour: gone.tour_id },
    upload,
    replaceUpload: second.json.upload_id,
    media: { image: image.id, clip: clip.id, uploading: unfinished.id, imageLink: image.link, clipLink: clip.link, uploadingLink: unfinished.link },
    pictures: { upload: uploading.steps, replaceUpload: openReplace.steps, draft: replaced.steps, media: mediaSpec },
    fill,
    session: "",
    otherSession: "",
    tokens: { live: tokenId, revoked: revokedTokenId, connected: "" },
    connect: { confirmed: "", collected: "", refused: "" },
  };
  const session = await signIn(deps, account.userId);
  ids.session = session.id;
  ids.otherSession = (await signIn(deps, account.userId)).id;

  // Three requests to connect the app: the app starts each on the tours address with no
  // credential, the side's session settles it on the app address, and one is collected.
  const hosts = deps.config.hosts ?? null;
  const toursOrigin = hosts === null ? ORIGIN : originOf(hosts.tours);
  const appOrigin = hosts === null ? ORIGIN : originOf(hosts.app);
  const page = { cookie: session.cookie, origin: appOrigin, "x-csrf-token": session.csrf, "sec-fetch-site": "same-origin", ...JSON_HEADERS };
  const startConnect = async (device: string) => must(await send(deps, "POST", "/api/v1/connect/start", { origin: toursOrigin, body: JSON.stringify({ device_name: device }), headers: JSON_HEADERS }), 201, `the request to connect ${device}`).json;
  const settleConnect = async (how: "confirm" | "refuse", code: string) => must(await send(deps, "POST", `/api/v1/connect/${how}`, { origin: appOrigin, body: JSON.stringify({ user_code: code }), headers: page }), 204, `the ${how} of ${code}`);
  const confirmed = await startConnect(`${name} laptop`);
  await settleConnect("confirm", confirmed.user_code);
  const collected = await startConnect(`${name} connected device`);
  await settleConnect("confirm", collected.user_code);
  must(await send(deps, "POST", "/api/v1/connect/token", { origin: toursOrigin, body: JSON.stringify({ device_code: collected.device_code }), headers: JSON_HEADERS }), 200, "the collection of the connected device's token");
  const refused = await startConnect(`${name} refused device`);
  await settleConnect("refuse", refused.user_code);
  ids.connect = { confirmed: confirmed.user_code, collected: collected.user_code, refused: refused.user_code };
  ids.tokens.connected = (await need(deps.db.first<{ id: string }>("SELECT id FROM api_token WHERE workspace_id = ? AND kind = 'sign_in'", [workspaceId]), "token made by connecting")).id;
  const emailCode = "dpe_" + randomHex(40);
  await deps.db.run("INSERT INTO email_change (id, user_id, new_email, code_hash, created_at) VALUES (?, ?, ?, ?, ?)", [
    newId("emc"), account.userId, `${name.toLowerCase()}-next@example.com`, await hashToken(emailCode), deps.now(),
  ]);
  return { name, workspaceId, workspaceName, userId: account.userId, email: account.email, token, tokenId, revokedToken, revokedTokenId, session, emailCode, ids };
}

/**
 * Builds both sides on `deps`, which must be fresh from the harness's `makeDeps()`; `keys`
 * is the store listing `makeDeps()` returned with it. Takes over `deps.now` and puts the
 * journal in front of `deps.drafts` and `deps.pub`.
 */
export async function world(deps: Deps, keys: StoreKeys): Promise<World> {
  let now = T0;
  deps.now = () => now;
  const log: string[] = [];
  deps.drafts = journal("drafts", deps.drafts, log);
  deps.pub = journal("public", deps.pub, log);
  const a = await side(deps, "Alpha", 300, 0xa1, true);
  now += 1000;
  const b = await side(deps, "Bravo", 500, 0xb2, false);
  const invite = { id: newId("inv"), email: "invited-newcomer@example.com", code: "dpi_" + randomHex(40) };
  await deps.db.run("INSERT INTO invite (id, email, code_hash, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)", [
    invite.id, invite.email, await hashToken(invite.code), a.userId, now, now + 7 * 86_400_000,
  ]);
  now += 60_000;
  log.length = 0;
  return { deps, keys, a, b, invite, tick: (ms = 100) => void (now += ms), writes: () => [...log], forgetWrites: () => void (log.length = 0) };
}

// ---- What is stored ----

/** Tables the app's migrations did not make: each target's own record of applied migrations. */
const NOT_THE_APPS = ["_migrations", "d1_migrations"];

/** Every table of the app's schema, read from the database itself. */
export async function tablesOf(deps: Deps): Promise<string[]> {
  const rows = await deps.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY name");
  return rows.map((r) => r.name).filter((n) => !NOT_THE_APPS.includes(n));
}

const BY_TOUR = "tour_id IN (SELECT id FROM tour WHERE workspace_id = ?)";
const BY_USER = "user_id IN (SELECT user_id FROM membership WHERE workspace_id = ?)";

/**
 * For each table, the condition that picks the rows of one workspace; every `?` is the
 * workspace id. A table missing here and in SHARED fails the suite: a migration that adds
 * a table must say whose its rows are.
 */
export const OWNED: Readonly<Record<string, string>> = {
  workspace: "id = ?",
  user: "workspace_id = ? OR id IN (SELECT user_id FROM membership WHERE workspace_id = ?)",
  membership: "workspace_id = ?",
  signin_method: BY_USER,
  signin_code: BY_USER,
  session: BY_USER,
  email_change: BY_USER,
  api_token: "workspace_id = ?",
  setup: "workspace_id = ?",
  audit: `workspace_id = ? OR ${BY_USER}`,
  tour: "workspace_id = ?",
  chapter: BY_TOUR,
  step: BY_TOUR,
  snapshot: BY_TOUR,
  snapshot_object: BY_TOUR,
  public_object: BY_TOUR,
  publish_job: BY_TOUR,
  replaced_object: BY_TOUR,
  upload: "workspace_id = ?",
  upload_step: "upload_id IN (SELECT id FROM upload WHERE workspace_id = ?)",
  tour_deletion: "workspace_id = ?",
  deleted_object: "tour_id IN (SELECT tour_id FROM tour_deletion WHERE workspace_id = ?)",
  media: "workspace_id = ?",
  media_object: "media_id IN (SELECT id FROM media WHERE workspace_id = ?)",
  // A request to connect belongs to no workspace until it is confirmed, and then to the confirming one.
  connect_request: "workspace_id = ?",
};

/** Tables whose rows belong to no workspace, each with the reason. */
export const SHARED: Readonly<Record<string, string>> = {
  rate_counter: "counters for the whole site's sign-in requests; a key is a hash and names no workspace",
  connect_key: "the install's one key for the short codes' HMAC, made by the migration; no workspace has a part in it",
  invite: "the site's invites, which the admin alone lists and changes: an address and the digest of a code, until accepting one makes a new workspace for it",
};

/**
 * The counters of wrong short codes (src/connect.ts). A lookup, confirm or refusal with a
 * code that names no waiting request is counted against the caller's own account and
 * network, keyed by digests that name no workspace: that count is the one write such a
 * refused request makes, so `dumpOf` leaves these rows out, and the suite clears them before
 * each request to a connect route, so its many refused tries are never cut short by the
 * limit, whose own tests are in test/connect.test.ts.
 */
export const TRY_BUCKETS: readonly string[] = [LIMITS_CONNECT.wrongAccount.bucket, LIMITS_CONNECT.wrongNetwork.bucket];

const byText = (rows: Json[]) => [...rows].sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1));

async function digest(store: FileStore, key: string): Promise<string> {
  const file = await store.get(key);
  if (file === null) return "missing";
  const bytes = new Uint8Array(await new Response(file.body).arrayBuffer());
  return `${bytes.byteLength} bytes, sha256 ${await sha256Hex(bytes)}, ${file.contentType}, ${file.cacheControl}`;
}

/** Published pictures (`p/`) are in the public store; everything else, shared items' objects (`m/`) too, in the drafts. */
const storeOf = (deps: Deps, key: string) => (key.startsWith("p/") ? deps.pub : deps.drafts);

export type Snapshot = { rows: Record<string, Json[]>; files: Record<string, string> };

/**
 * Everything that belongs to the side's workspace: every row of every table in OWNED, and
 * every stored file one of those rows names or that lies under one of its uploads' or items' ids,
 * with its length, the hash of its bytes and its type ("missing" for a named file that is
 * not there).
 */
export async function snapshotOf(deps: Deps, side: { workspaceId: string }, keys: StoreKeys): Promise<Snapshot> {
  const rows: Record<string, Json[]> = {};
  const named = new Set<string>();
  for (const table of await tablesOf(deps)) {
    const where = OWNED[table];
    if (where === undefined) continue;
    const found = await deps.db.all<Json>(`SELECT * FROM "${table}" WHERE ${where}`, Array(where.split("?").length - 1).fill(side.workspaceId));
    rows[table] = byText(found);
    for (const row of found) {
      for (const [column, value] of Object.entries(row)) if (column.endsWith("_key") && typeof value === "string") named.add(value);
    }
  }
  const uploads = (rows.upload ?? []).map((u) => `u/${u.id}/`);
  for (const key of await keys.draftKeys()) if (uploads.some((prefix) => key.startsWith(prefix))) named.add(key);
  const items = (rows.media ?? []).map((m) => `m/${m.id}/`);
  for (const key of await keys.draftKeys()) if (items.some((prefix) => key.startsWith(prefix))) named.add(key);
  const files: Record<string, string> = {};
  for (const key of [...named].sort()) files[key] = await digest(storeOf(deps, key), key);
  return { rows, files };
}

export type Dump = { rows: Record<string, Json[]>; drafts: string[]; public: string[]; files?: Record<string, string> };

/**
 * The whole database and the key lists of both stores, whoever anything belongs to.
 * `touched` names tokens whose `last_used_at`, and sessions whose `last_used_at` and
 * `expires_at`, are left out: an accepted token or session records its use, and that is
 * the one write a refused request may make. The counters of wrong short codes (TRY_BUCKETS)
 * are left out too. With `files`, also the length, hash and type of every stored file.
 */
export async function dumpOf(deps: Deps, keys: StoreKeys, opts: { touched?: string[]; files?: boolean } = {}): Promise<Dump> {
  const rows: Record<string, Json[]> = {};
  for (const table of await tablesOf(deps)) {
    const found = await deps.db.all<Json>(`SELECT * FROM "${table}"`);
    if (table === "api_token") for (const row of found) if (opts.touched?.includes(row.id)) row.last_used_at = "(its own use)";
    if (table === "session") for (const row of found) if (opts.touched?.includes(row.id)) row.last_used_at = row.expires_at = "(its own use)";
    rows[table] = byText(table === "rate_counter" ? found.filter((row) => !TRY_BUCKETS.includes(row.bucket as string)) : found);
  }
  const dump: Dump = { rows, drafts: await keys.draftKeys(), public: await keys.publicKeys() };
  if (opts.files) {
    dump.files = {};
    for (const key of dump.drafts) dump.files[`drafts ${key}`] = await digest(deps.drafts, key);
    for (const key of dump.public) dump.files[`public ${key}`] = await digest(deps.pub, key);
  }
  return dump;
}

/** Columns whose value names one row, one file or one person. */
const NAMING = /^(id|slug|title|name|email|new_email|username|hash|code_hash|sha256|revision|claim)$|_id$|_key$/;

/**
 * The values that would give a side away in another workspace's answer: every id, slug,
 * title, name, email, hash and file key in its rows, the public names of its pictures,
 * and whatever else is passed in `more` (its token).
 */
export function needlesOf(snapshot: Snapshot, more: string[] = []): string[] {
  const out = new Set<string>(more);
  for (const rows of Object.values(snapshot.rows)) {
    for (const row of rows) {
      for (const [column, value] of Object.entries(row)) {
        if (typeof value !== "string" || value.length < 6 || !NAMING.test(column)) continue;
        out.add(value);
        if (value.startsWith("p/")) out.add(value.slice(2));
      }
    }
  }
  return [...out];
}
