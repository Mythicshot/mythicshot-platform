// The cross-workspace suite: no workspace reaches another's data by any key. It builds
// two workspaces that each hold one of everything (test/isolation-world.ts), then signs in
// as one and tries to read, change and delete the other's data on every route, on both
// targets. An attempt fails the build when it gets anything but the route's own answer for
// an id that never existed (status, body and headers, byte for byte), when a row of any
// table changed, or when anything was written to or deleted from either store.
//
// Every route of the app is in exactly one of ten tables, keyed "<METHOD> <route path>"
// exactly as in `createApp(deps).routes`:
// - CASES: routes with an id in the path. Each lists the requests in which one workspace
//   names the other's ids, with the exact answer.
// - BODY_IDS: routes with no id in the path whose body carries one. The same kind of list.
// - LISTS: routes that answer a collection or a summary of the caller's own workspace.
// - CREATES: routes with no id that make something new in the caller's own workspace,
//   each with a request that does. Made by one workspace, it must change nothing of the
//   other, and belong to the caller's.
// - SELF: routes with no id that change only the caller's own session or account.
// - OPEN: routes with no owner at all, each with its reason.
// - CONNECT: the desktop app's two requests while it connects, which take no credential and
//   belong to no workspace until a signed-in person confirms the request; then its token
//   belongs to the confirming workspace alone, which a test of its own checks.
// - ADMIN: routes that cross workspaces on purpose, for the site's admin alone, each with
//   the list of fields it may answer. Only an admin's session reaches them; everyone else
//   gets one 404. They answer counts, the allowance and the site's invites, never a tour,
//   picture, token or session, which the suite checks by scanning each answer for every
//   name of both sides.
// - INVITE: looking up and accepting an invite, which take no credential and belong to no
//   workspace; accepting makes a new workspace, which a test of its own checks is new and
//   separate from every other.
// - VIEWER: a visitor proving an email address on the tours address (src/viewers.ts), which
//   takes no credential and reaches no workspace; a test of its own checks that a viewer
//   cookie changes the answer of no other route, byte for byte, but a restricted tour's page
//   and live pictures (OPEN, served by src/restricted.ts), which it opens to an address the
//   tour may be viewed by, and to nothing else (test/restricted.test.ts has every case).
// A route in none of them, or in two, fails the first test below; so does a table key no
// route has. The route list is the router's own, as in test/openapi.test.ts, so the
// tables cannot drift from the app.
//
// A request names a foreign id in one of two places. In the path: that is what CASES is
// for. In the body: the request says which field with `field`, and every body field of the
// API description whose name ends in `_id` must have such a request. A route with both (a
// path id and a body id) is in CASES and marks its body requests the same way.
//
// How a later task adds to this file:
// - A new route: add its key to one table. With an id in the path it goes in CASES with
//   one request per foreign id it can be given; add what the requests need to `Ids` and to
//   `inventedIds` in test/isolation-world.ts.
// - Every test that sends a case sends it once per credential in CREDENTIALS: the side's
//   token, and its session with the anti-forgery header and an Origin of the address the
//   request goes to, as the site's own page sends them. A route that takes only a session
//   marks its requests `only: "session"`; a token is then answered 401, never the data.
// - An admin route: add it to ADMIN with its reason, a request the admin would be answered,
//   and every field (as a key path, such as "accounts[].id") its answer may hold.
import { describe, expect, it } from "vitest";
import { makeDeps } from "#harness";
import { createApp } from "../src/app.ts";
import { hashToken, newId, newToken } from "../src/auth.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import { openapi, type OpenApiDoc } from "../src/docs/openapi.ts";
import { BILLING_CONFIG, eventOf, notify, withBilling, type FakeStripe } from "./fake-stripe.ts";
import { TRIAL_BYTES } from "../src/billing-rules.ts";
import type { Hosts } from "../src/hosts.ts";
import type { Deps } from "../src/ports.ts";
import { LIMITS_SIGNIN } from "../src/rate.ts";
import { POLL_GAP_MS } from "../src/connect.ts";
import { PAD_BUCKET } from "../src/signin.ts";
import { parseTerms, publishTerms } from "../src/terms.ts";
import { UPLOAD_MAX_AGE_MS } from "../src/uploads.ts";
import { VIEW_GATE_HTML } from "../src/view-page.ts";
import { MEDIA_VIEWER_COOKIE, VIEWER_CODE_MS, VIEWER_COOKIE } from "../src/viewers.ts";
import { ORIGIN, commit, logoPng, putStep, send, stepImage, type Call, type Json } from "./bundle.ts";
import { OWNED, SHARED, TRY_BUCKETS, createReplace, dumpOf, inventedIds, manifestOf, mediaPart, namesIn, needlesOf, snapshotOf, tablesOf, world, type Ids, type Side, type World } from "./isolation-world.ts";

// The world holds a restricted tour and a switch in progress as well, so every case runs over more tours.
const SLOW = { timeout: 300_000 };
const HOSTS: Hosts = { tours: "tours.example.com", app: "app.example.com" };
const TOURS = "https://tours.example.com";
const APP = "https://app.example.com";
const SETUP_CODE = "correct-horse-battery-staple";

// ---- The answers ----

type Expect = { status: number; body: Json | null };
const notFound = (what: string): Expect => ({ status: 404, body: { error: "not_found", detail: `no such ${what}` } });
const NO_TOUR = notFound("tour");
const NO_CHAPTER = notFound("chapter");
const NO_STEP = notFound("step");
const NO_UPLOAD = notFound("upload");
const NO_SESSION = notFound("session");
const NO_ITEM = notFound("item");
const NO_TOKEN = notFound("token");
const NO_REQUEST = notFound("request");
/** What a credential that may not be used here gets: a token on a route that takes only a session, a session on the tours address. */
const NOBODY: Expect = { status: 401, body: { error: "unauthorized" } };
/** Aborting an upload answers 204 whatever the id: there is nothing to tell apart. */
const NOTHING: Expect = { status: 204, body: null };
/** A publish id the tour does not have: the publish it names was stopped, or never was. */
const NO_PUBLISH: Expect = {
  status: 409,
  body: { error: "publish_cancelled", detail: "this publish was stopped before it finished (the tour was unpublished, or the publish failed or was abandoned); publish again to start over" },
};

// ---- The tables ----

/** One request in which the caller names an id that is not its own. */
type Req = {
  what: string;
  method: string;
  path: string;
  json?: unknown;
  bytes?: Uint8Array;
  /** The body field that carries the foreign id, when it is not in the path. */
  field?: string;
  /** The route takes a session and no token: any other credential is answered NOBODY. */
  only?: "session";
  expect: Expect;
};

/** The requests of one route: `theirs` are the other workspace's ids (or ids that never existed), `mine` the caller's own. */
type Entry = (theirs: Ids, mine: Ids) => Req[];

const tourPath = (id: string, rest = "") => `/api/v1/tours/${id}${rest}`;
/** Each of the other workspace's tokens: its first, its revoked one, and the one connecting the app made. */
const theirTokens = (t: Ids): [string, string][] => [
  ["their workspace's first token", t.tokens.live],
  ["their revoked token", t.tokens.revoked],
  ["the token connecting the app made for them", t.tokens.connected],
];
/** Each of the other workspace's requests to connect, by its short code. */
const theirCodes = (t: Ids): [string, string][] => [
  ["their confirmed request, not collected yet", t.connect.confirmed],
  ["their confirmed request whose token was collected", t.connect.collected],
  ["the request they refused", t.connect.refused],
];
const uploadPath = (id: string, rest = "") => `/api/v1/uploads/${id}${rest}`;
const mediaPath = (id: string, rest = "") => `/api/v1/media/${id}${rest}`;
/** Each of the other workspace's shared items, in every state an item can be in. */
const theirItems = (t: Ids): [string, string][] => [
  ["their online image", t.media.image],
  ["their online clip", t.media.clip],
  ["their unfinished item", t.media.uploading],
  ["their restricted image", t.media.restricted],
];
/** Each of the other workspace's tours, in every state a tour can be in. */
const theirTours = (t: Ids): [string, string][] => [
  ["their published tour", t.published.tour],
  ["their draft tour", t.draft.tour],
  ["their tour with a publish in progress", t.publishing.tour],
  ["their half-deleted tour", t.deleting.tour],
  ["their restricted tour", t.restricted.tour],
  ["their tour whose switch to restricted is in progress", t.switching.tour],
];

const CASES: Record<string, Entry> = {
  "PUT /api/v1/uploads/:id/steps/:n": (t) => [
    { what: "the step their open upload still waits for, with a picture it would accept", method: "PUT", path: uploadPath(t.upload, "/steps/2"), bytes: stepImage(t.pictures.upload[1], t.fill), expect: NO_UPLOAD },
    { what: "a step their open upload already has", method: "PUT", path: uploadPath(t.upload, "/steps/1"), bytes: stepImage(t.pictures.upload[0], t.fill), expect: NO_UPLOAD },
    { what: "a step number their open upload does not have", method: "PUT", path: uploadPath(t.upload, "/steps/999"), bytes: stepImage(t.pictures.upload[0], t.fill), expect: NO_UPLOAD },
    { what: "the step their open replace still waits for", method: "PUT", path: uploadPath(t.replaceUpload, "/steps/2"), bytes: stepImage(t.pictures.replaceUpload[1], t.fill), expect: NO_UPLOAD },
    { what: "the step their open replace reuses", method: "PUT", path: uploadPath(t.replaceUpload, "/steps/1"), bytes: stepImage(t.pictures.replaceUpload[0], t.fill), expect: NO_UPLOAD },
    { what: "a step of their committed upload", method: "PUT", path: uploadPath(t.draft.committedUpload, "/steps/1"), bytes: stepImage(t.pictures.draft[0], t.fill), expect: NO_UPLOAD },
  ],
  "PUT /api/v1/uploads/:id/logo": (t) => [
    { what: "the logo their open upload still waits for", method: "PUT", path: uploadPath(t.upload, "/logo"), bytes: logoPng(), expect: NO_UPLOAD },
    { what: "a logo for their open replace, which takes none", method: "PUT", path: uploadPath(t.replaceUpload, "/logo"), bytes: logoPng(), expect: NO_UPLOAD },
  ],
  "POST /api/v1/uploads/:id/commit": (t) => [
    { what: "their open upload", method: "POST", path: uploadPath(t.upload, "/commit"), expect: NO_UPLOAD },
    { what: "their open replace", method: "POST", path: uploadPath(t.replaceUpload, "/commit"), expect: NO_UPLOAD },
    { what: "their committed upload, whose commit answers its owner again", method: "POST", path: uploadPath(t.draft.committedUpload, "/commit"), expect: NO_UPLOAD },
    { what: "their committed replace, whose commit answers its owner again", method: "POST", path: uploadPath(t.draft.committedReplace, "/commit"), expect: NO_UPLOAD },
  ],
  "DELETE /api/v1/uploads/:id": (t) => [
    { what: "their open upload", method: "DELETE", path: uploadPath(t.upload), expect: NOTHING },
    { what: "their open replace", method: "DELETE", path: uploadPath(t.replaceUpload), expect: NOTHING },
  ],
  "PATCH /api/v1/tours/:id": (t) => theirTours(t).map(([what, id]) => ({ what, method: "PATCH", path: tourPath(id), json: { title: "Taken over" }, expect: NO_TOUR })),
  "DELETE /api/v1/tours/:id": (t) => theirTours(t).map(([what, id]) => ({ what, method: "DELETE", path: tourPath(id), expect: NO_TOUR })),
  "GET /api/v1/tours/:id/steps/:step_id/image": (t, m) => [
    { what: "a picture of their draft tour", method: "GET", path: tourPath(t.draft.tour, `/steps/${t.draft.step}/image`), expect: NO_STEP },
    { what: "a picture of their published tour", method: "GET", path: tourPath(t.published.tour, `/steps/${t.published.step}/image`), expect: NO_STEP },
    { what: "a picture of their tour with a publish in progress", method: "GET", path: tourPath(t.publishing.tour, `/steps/${t.publishing.step}/image`), expect: NO_STEP },
    { what: "their step under the caller's own tour", method: "GET", path: tourPath(m.published.tour, `/steps/${t.published.step}/image`), expect: NO_STEP },
    { what: "the caller's own step under their tour", method: "GET", path: tourPath(t.published.tour, `/steps/${m.published.step}/image`), expect: NO_STEP },
  ],
  "POST /api/v1/tours/:id/publish": (t, m) => [
    ...theirTours(t).map(([what, id]) => ({ what, method: "POST", path: tourPath(id, "/publish"), expect: NO_TOUR })),
    { what: "their publish in progress, continued by its id", method: "POST", path: tourPath(t.publishing.tour, "/publish"), json: { publish_id: t.publishing.publishId }, expect: NO_TOUR },
    { what: "their publish in progress, named for the caller's own tour", method: "POST", path: tourPath(m.published.tour, "/publish"), json: { publish_id: t.publishing.publishId }, field: "publish_id", expect: NO_PUBLISH },
    { what: "their live publish, named for the caller's own tour", method: "POST", path: tourPath(m.published.tour, "/publish"), json: { publish_id: t.published.publishId }, field: "publish_id", expect: NO_PUBLISH },
    // Who may view a tour, stated at its first publish (0.1.51): their tours, the never
    // published draft among them, answer as no tour, and nothing of them changes.
    ...theirTours(t).flatMap(([what, id]) => [
      { what: `${what}, first published restricted to the caller's address`, method: "POST", path: tourPath(id, "/publish"), json: { access: "people", viewers: ["intruder@example.com"] }, expect: NO_TOUR },
      { what: `${what}, first published as me`, method: "POST", path: tourPath(id, "/publish"), json: { access: "me" }, expect: NO_TOUR },
      { what: `${what}, first published public with a list`, method: "POST", path: tourPath(id, "/publish"), json: { access: "public", viewers: ["intruder@example.com"] }, expect: NO_TOUR },
    ]),
  ],
  "POST /api/v1/tours/:id/unpublish": (t) => theirTours(t).map(([what, id]) => ({ what, method: "POST", path: tourPath(id, "/unpublish"), expect: NO_TOUR })),
  // A tour's chapters (0.1.55): their tours answer as no tour; their chapters named in a change
  // of the caller's own tour, at its right revision, answer as no chapter, and nothing of
  // either tour changes (the caller's chapters are never removed for a list that is refused).
  "GET /api/v1/tours/:id/chapters": (t) => theirTours(t).map(([what, id]) => ({ what, method: "GET", path: tourPath(id, "/chapters"), expect: NO_TOUR })),
  "PUT /api/v1/tours/:id/chapters": (t, m) => [
    ...theirTours(t).map(([what, id]) => ({ what, method: "PUT", path: tourPath(id, "/chapters"), json: { revision: t.draft.revision, chapters: [t.draft.chapter] }, expect: NO_TOUR })),
    { what: "their draft tour, reordered with the caller's own chapter", method: "PUT", path: tourPath(t.draft.tour, "/chapters"), json: { revision: t.draft.revision, chapters: [m.draft.chapter] }, expect: NO_TOUR },
    { what: "their chapter kept in the caller's own tour", method: "PUT", path: tourPath(m.draft.tour, "/chapters"), json: { revision: m.draft.revision, chapters: [m.draft.chapter, t.draft.chapter] }, expect: NO_CHAPTER },
    { what: "their chapter alone in the caller's own tour, which would remove the caller's", method: "PUT", path: tourPath(m.draft.tour, "/chapters"), json: { revision: m.draft.revision, chapters: [t.draft.chapter] }, expect: NO_CHAPTER },
    { what: "their published tour's chapter first in the caller's own published tour", method: "PUT", path: tourPath(m.published.tour, "/chapters"), json: { revision: m.published.revision, chapters: [t.published.chapter, m.published.chapter] }, expect: NO_CHAPTER },
  ],
  // Who may view a tour, and its list of addresses: the workspace's own data.
  "GET /api/v1/tours/:id/access": (t) => theirTours(t).map(([what, id]) => ({ what, method: "GET", path: tourPath(id, "/access"), expect: NO_TOUR })),
  "PUT /api/v1/tours/:id/access": (t) =>
    theirTours(t).flatMap(([what, id]) => [
      { what: `${what}, made public with an empty list`, method: "PUT", path: tourPath(id, "/access"), json: { access: "public", viewers: [] }, only: "session" as const, expect: NO_TOUR },
      { what: `${what}, made restricted to the caller's address`, method: "PUT", path: tourPath(id, "/access"), json: { access: "people", viewers: ["intruder@example.com"] }, only: "session" as const, expect: NO_TOUR },
      { what: `${what}, its switch continued`, method: "PUT", path: tourPath(id, "/access"), json: { access: "me" }, only: "session" as const, expect: NO_TOUR },
    ]),
  // Who may view a shared item, and its list of addresses: the workspace's own data.
  "GET /api/v1/media/:id/access": (t) => theirItems(t).map(([what, id]) => ({ what, method: "GET", path: mediaPath(id, "/access"), expect: NO_ITEM })),
  "PUT /api/v1/media/:id/access": (t) =>
    theirItems(t).flatMap(([what, id]) => [
      { what: `${what}, made public with an empty list`, method: "PUT", path: mediaPath(id, "/access"), json: { access: "public", viewers: [] }, only: "session" as const, expect: NO_ITEM },
      { what: `${what}, made restricted to the caller's address`, method: "PUT", path: mediaPath(id, "/access"), json: { access: "people", viewers: ["intruder@example.com"] }, only: "session" as const, expect: NO_ITEM },
      { what: `${what}, made the owner's alone`, method: "PUT", path: mediaPath(id, "/access"), json: { access: "me" }, only: "session" as const, expect: NO_ITEM },
    ]),
  "DELETE /api/v1/sessions/:id": (t) => [
    { what: "the session they are signed in with", method: "DELETE", path: `/api/v1/sessions/${t.session}`, only: "session", expect: NO_SESSION },
    { what: "another live session of theirs", method: "DELETE", path: `/api/v1/sessions/${t.otherSession}`, only: "session", expect: NO_SESSION },
  ],
  "PUT /api/v1/media/:id/parts/:n": (t) => [
    { what: "the part their unfinished item has, with bytes it would accept", method: "PUT", path: mediaPath(t.media.uploading, "/parts/0"), bytes: mediaPart(t.pictures.media, t.fill), expect: NO_ITEM },
    { what: "a part number their unfinished item does not have", method: "PUT", path: mediaPath(t.media.uploading, "/parts/1"), bytes: mediaPart(t.pictures.media, t.fill), expect: NO_ITEM },
    { what: "the part of their online image", method: "PUT", path: mediaPath(t.media.image, "/parts/0"), bytes: mediaPart(t.pictures.media, t.fill), expect: NO_ITEM },
    { what: "the part of their online clip", method: "PUT", path: mediaPath(t.media.clip, "/parts/0"), bytes: mediaPart(t.pictures.media, t.fill), expect: NO_ITEM },
  ],
  "PUT /api/v1/media/:id/preview": (t) => [
    { what: "a preview for their unfinished item", method: "PUT", path: mediaPath(t.media.uploading, "/preview"), bytes: logoPng(), expect: NO_ITEM },
    { what: "a preview for their online image", method: "PUT", path: mediaPath(t.media.image, "/preview"), bytes: logoPng(), expect: NO_ITEM },
  ],
  "POST /api/v1/media/:id/commit": (t) => [
    { what: "their unfinished item, which its owner could commit", method: "POST", path: mediaPath(t.media.uploading, "/commit"), expect: NO_ITEM },
    { what: "their online image, whose commit answers its owner again", method: "POST", path: mediaPath(t.media.image, "/commit"), expect: NO_ITEM },
  ],
  "DELETE /api/v1/media/:id": (t) => [
    { what: "their unfinished item", method: "DELETE", path: mediaPath(t.media.uploading), expect: NO_ITEM },
    { what: "their online image", method: "DELETE", path: mediaPath(t.media.image), expect: NO_ITEM },
    { what: "their online clip", method: "DELETE", path: mediaPath(t.media.clip), expect: NO_ITEM },
  ],
  "GET /api/v1/media/:id": (t) => [
    { what: "their online image", method: "GET", path: mediaPath(t.media.image), expect: NO_ITEM },
    { what: "their online clip", method: "GET", path: mediaPath(t.media.clip), expect: NO_ITEM },
    { what: "their unfinished item", method: "GET", path: mediaPath(t.media.uploading), expect: NO_ITEM },
  ],
  "PATCH /api/v1/tokens/:id": (t) => theirTokens(t).map(([what, id]) => ({ what, method: "PATCH", path: `/api/v1/tokens/${id}`, json: { name: "Taken over" }, only: "session" as const, expect: NO_TOKEN })),
  "DELETE /api/v1/tokens/:id": (t) => theirTokens(t).map(([what, id]) => ({ what, method: "DELETE", path: `/api/v1/tokens/${id}`, only: "session" as const, expect: NO_TOKEN })),
  "GET /api/v1/media/:id/preview": (t) => [
    { what: "the preview of their online image", method: "GET", path: mediaPath(t.media.image, "/preview"), expect: NO_ITEM },
    { what: "the preview of their unfinished item", method: "GET", path: mediaPath(t.media.uploading, "/preview"), expect: NO_ITEM },
  ],
};

/** A create for the open upload's own pictures, into `target`. */
const createInto = (t: Ids, target: Json, more: Json = {}) => ({ manifest: manifestOf(t.pictures.draft.map((s) => s.bytes), "Taken over"), target, ...more });

const BODY_IDS: Record<string, Entry> = {
  "POST /api/v1/connect/lookup": (t) => theirCodes(t).map(([what, code]) => ({ what, method: "POST", path: "/api/v1/connect/lookup", json: { user_code: code }, field: "user_code", only: "session" as const, expect: NO_REQUEST })),
  "POST /api/v1/connect/confirm": (t) => theirCodes(t).map(([what, code]) => ({ what, method: "POST", path: "/api/v1/connect/confirm", json: { user_code: code }, field: "user_code", only: "session" as const, expect: NO_REQUEST })),
  "POST /api/v1/connect/refuse": (t) => theirCodes(t).map(([what, code]) => ({ what, method: "POST", path: "/api/v1/connect/refuse", json: { user_code: code }, field: "user_code", only: "session" as const, expect: NO_REQUEST })),
  "POST /api/v1/uploads": (t, m) => [
    { what: "a new chapter for their draft tour", method: "POST", path: "/api/v1/uploads", json: createInto(t, { kind: "chapter", tour_id: t.draft.tour }), field: "tour_id", expect: NO_TOUR },
    { what: "a new chapter for their published tour", method: "POST", path: "/api/v1/uploads", json: createInto(t, { kind: "chapter", tour_id: t.published.tour }), field: "tour_id", expect: NO_TOUR },
    { what: "a new chapter for their half-deleted tour", method: "POST", path: "/api/v1/uploads", json: createInto(t, { kind: "chapter", tour_id: t.deleting.tour }), field: "tour_id", expect: NO_TOUR },
    { what: "a replace of their chapter", method: "POST", path: "/api/v1/uploads", json: createInto(t, { kind: "replace", tour_id: t.draft.tour, chapter_id: t.draft.chapter }), field: "tour_id", expect: NO_TOUR },
    {
      what: "a replace of their chapter that names their pictures by hash",
      method: "POST",
      path: "/api/v1/uploads",
      json: createInto(t, { kind: "replace", tour_id: t.draft.tour, chapter_id: t.draft.chapter }, { sha256: t.draft.sha256 }),
      field: "tour_id",
      expect: NO_TOUR,
    },
    { what: "their tour with the caller's own chapter", method: "POST", path: "/api/v1/uploads", json: createInto(t, { kind: "replace", tour_id: t.draft.tour, chapter_id: m.draft.chapter }), field: "tour_id", expect: NO_TOUR },
    { what: "their chapter under the caller's own tour", method: "POST", path: "/api/v1/uploads", json: createInto(t, { kind: "replace", tour_id: m.draft.tour, chapter_id: t.draft.chapter }), field: "chapter_id", expect: NO_CHAPTER },
    {
      what: "their chapter under the caller's own tour, naming their pictures by hash",
      method: "POST",
      path: "/api/v1/uploads",
      json: createInto(t, { kind: "replace", tour_id: m.draft.tour, chapter_id: t.draft.chapter }, { sha256: t.draft.sha256 }),
      field: "chapter_id",
      expect: NO_CHAPTER,
    },
  ],
};

/** Routes that answer the caller's own workspace or account as a whole: what the answer holds, and the one credential it takes when it does not take both. */
const LISTS: Record<string, { path: string; holds: string; only?: "token" | "session" }> = {
  "GET /api/v1/me": { path: "/api/v1/me", holds: "the caller's workspace name" },
  "GET /api/v1/usage": { path: "/api/v1/usage", holds: "the caller's workspace's usage and allowance" },
  "GET /api/v1/usage/largest": { path: "/api/v1/usage/largest", holds: "the ten largest tours of the caller's workspace, with their sizes" },
  "GET /api/v1/tours": { path: "/api/v1/tours", holds: "the caller's workspace's tours" },
  // The clips' list is looked at beside it in the test of the lists.
  "GET /api/v1/media": { path: "/api/v1/media?kind=image", holds: "the caller's workspace's online shared images (and, with kind=clip, clips)" },
  "GET /api/v1/setup/connected": { path: "/api/v1/setup/connected", holds: "whether the caller's own token was used", only: "token" },
  "GET /api/v1/session": { path: "/api/v1/session", holds: "the caller's account, workspace, session and anti-forgery value", only: "session" },
  "GET /api/v1/sessions": { path: "/api/v1/sessions", holds: "the live sessions of the caller's own account", only: "session" },
  "GET /api/v1/tokens": { path: "/api/v1/tokens", holds: "the caller's workspace's tokens that are not revoked: ids, names, times and kinds", only: "session" },
  "GET /api/v1/terms": { path: "/api/v1/terms", holds: "the site's current terms, the caller's own account's newest agreement and its session's anti-forgery value", only: "session" },
  "GET /api/v1/terms/agreed": { path: "/api/v1/terms/agreed", holds: "the version of the site's terms the caller's own account agreed to last, and when", only: "session" },
  "GET /api/v1/billing": { path: "/api/v1/billing", holds: "where the caller's own workspace stands with billing: its state, dates, usage and allowance", only: "session" },
};

/**
 * `viewer`: the answer depends on the viewer cookie as well (a restricted tour's page or live
 * picture, which src/restricted.ts serves to a proved address that may view it); the test "a
 * viewer cookie" checks that it opens there, and test/restricted.test.ts checks every case.
 */
type Sample = { method: string; path: string; json?: unknown; headers?: Record<string, string>; viewer?: true; mediaViewer?: true };

/**
 * Routes with no id that make something new in the caller's own workspace: what they make,
 * a request that makes it (`made` names the table the new row is in), and nothing more.
 */
const CREATES: Record<string, { makes: string; sample: (side: Side) => Sample; more?: (side: Side, other: Side) => Sample[]; made: string }> = {
  "POST /api/v1/media": {
    makes: "starts a shared item in the caller's own workspace; the body names no workspace and no id",
    sample: (side) => ({ method: "POST", path: "/api/v1/media", json: { kind: "image", content_type: "image/png", bytes: 1234, width: 10, height: 10, title: `${side.name} new item` } }),
    // Who may view it, stated at its create (0.1.51): the list names addresses, among them the
    // other workspace's viewer and account, and still reaches nothing of that workspace. (This
    // world cannot mail, so only public takes a list here; restricted creates are in the test
    // "who may view, stated at a create or a first publish" below, on a site that can mail.)
    more: (side, other) => [
      { method: "POST", path: "/api/v1/media", json: { kind: "image", content_type: "image/png", bytes: 1234, width: 10, height: 10, title: `${side.name} listed item`, access: "public", viewers: [other.ids.restricted.viewer, other.email] } },
    ],
    made: "media",
  },
};

/**
 * Routes that belong to no workspace: why, and requests that must answer everyone the same.
 * `byCookie`: the answer may differ with whether a session cookie is sent, and on nothing
 * else: every caller with a cookie gets one answer, every caller without one another.
 */
const OPEN: Record<string, { reason: string; samples: (w: World) => Sample[]; byCookie?: true }> = {
  "GET /healthz": { reason: "says only that the site is up", samples: () => [{ method: "GET", path: "/healthz" }] },
  "GET /setup": { reason: "the wizard's page, open only while the site has no workspace at all", samples: () => [{ method: "GET", path: "/setup" }] },
  "GET /setup/setup.css": { reason: "the wizard's stylesheet, open only while the site has no workspace at all", samples: () => [{ method: "GET", path: "/setup/setup.css" }] },
  "GET /setup/setup.js": { reason: "the wizard's script, open only while the site has no workspace at all", samples: () => [{ method: "GET", path: "/setup/setup.js" }] },
  "POST /setup/check": {
    reason: "checks the setup code, and only while the site has no workspace at all",
    samples: () => [{ method: "POST", path: "/setup/check", json: { code: SETUP_CODE }, headers: { origin: TOURS } }],
  },
  "POST /setup/claim": {
    reason: "makes the first workspace, and only while the site has no workspace at all",
    samples: () => [{ method: "POST", path: "/setup/claim", json: { code: SETUP_CODE, workspace: "Taken over", email: "intruder@example.com" }, headers: { origin: TOURS } }],
  },
  "GET /p/:name": {
    reason: "a published picture, for visitors: the name is 128 random bits and is served only while a live snapshot or a re-publish inside its grace names it",
    samples: (w) =>
      [w.a.ids.published.publicName, w.a.ids.published.retiredName, w.a.ids.publishing.pendingName, inventedIds().published.publicName, w.a.ids.switching.publicName, w.a.ids.restricted.privateName].map((name) => ({
        method: "GET",
        path: `/p/${name}`,
      })),
  },
  "GET /:file{player(?:\\.[0-9a-f]{16})?\\.(?:js|css)}": { reason: "the player's own files, the same for every tour", samples: () => [{ method: "GET", path: "/player.js" }, { method: "GET", path: "/player.css" }] },
  "GET /t/:slug": {
    reason:
      "a published tour's page, for visitors: only a published tour answers, from its snapshot; a restricted one answers its fixed gate page to everyone but a viewer cookie of an address it may be viewed by",
    samples: (w) =>
      [w.a.ids.published.slug, w.a.ids.draft.slug, w.a.ids.publishing.slug, inventedIds().published.slug, w.a.ids.restricted.slug, w.a.ids.switching.slug].map((slug) => ({
        method: "GET",
        path: `/t/${slug}`,
        ...(slug === w.a.ids.restricted.slug ? { viewer: true as const } : {}),
      })),
  },
  "GET /t/:slug/v/:name": {
    reason: "a restricted tour's live picture, for a visitor whose viewer cookie proved an address the tour may be viewed by; to everyone else the one 404",
    samples: (w) => [
      { method: "GET", path: `/t/${w.a.ids.restricted.slug}/v/${w.a.ids.restricted.privateName}`, viewer: true },
      { method: "GET", path: `/t/${w.a.ids.restricted.slug}/v/${w.b.ids.restricted.privateName}` },
      { method: "GET", path: `/t/${w.b.ids.restricted.slug}/v/${w.a.ids.restricted.privateName}` },
      { method: "GET", path: `/t/${w.a.ids.restricted.slug}/v/${inventedIds().restricted.privateName}` },
      { method: "GET", path: `/t/${w.a.ids.published.slug}/v/${w.a.ids.published.publicName}` },
      { method: "GET", path: `/t/${w.a.ids.switching.slug}/v/${w.a.ids.switching.movedName}` },
    ],
  },
  "GET /view": { reason: "the page a viewer link opens, fixed text; the code stays in the browser and goes to the API only in request bodies", samples: () => [{ method: "GET", path: "/view" }] },
  "GET /view/signout/:slug": { reason: "the page \"Not you?\" under a restricted tour leads to, fixed text whatever the slug; it signs out only on a press", samples: (w) => [{ method: "GET", path: `/view/signout/${w.a.ids.restricted.slug}` }] },
  "GET /view/view.js": { reason: "the viewer pages' script, fixed text", samples: () => [{ method: "GET", path: "/view/view.js" }] },
  "GET /view/view.css": { reason: "the viewer pages' stylesheet, fixed text", samples: () => [{ method: "GET", path: "/view/view.css" }] },
  "GET /view/shared.css": { reason: "the stylesheet of the line under a restricted tour, fixed text", samples: () => [{ method: "GET", path: "/view/shared.css" }] },
  // Shared items: found by their 100-bit link id alone, and only while online and of an
  // account that is not disabled; every other link is the one 404 page.
  "GET /i/:name": {
    reason: "a shared image's page or file, for visitors: only an online item answers, by its random link id, never by its database id",
    samples: (w) => [
      { method: "GET", path: `/i/${w.a.ids.media.imageLink}` },
      { method: "GET", path: `/i/${w.a.ids.media.imageLink}.png` },
      { method: "GET", path: `/i/${w.a.ids.media.uploadingLink}` },
      { method: "GET", path: `/i/${w.a.ids.media.image}` },
      { method: "GET", path: `/i/${w.a.ids.media.clipLink}` },
      { method: "GET", path: `/i/${inventedIds().media.imageLink}` },
      // A restricted image: its fixed gate to everyone but a media viewer cookie of an address it may be viewed by.
      { method: "GET", path: `/i/${w.a.ids.media.restrictedLink}`, mediaViewer: true },
      { method: "GET", path: `/i/${w.a.ids.media.restrictedLink}.png`, mediaViewer: true },
    ],
  },
  "GET /i/:name/download": {
    reason: "a shared image's file to save, for visitors: only an online item answers, by its random link id",
    samples: (w) => [{ method: "GET", path: `/i/${w.a.ids.media.imageLink}/download` }, { method: "GET", path: `/i/${w.a.ids.media.uploadingLink}/download` }, { method: "GET", path: `/i/${inventedIds().media.imageLink}/download` }, { method: "GET", path: `/i/${w.a.ids.media.restrictedLink}/download`, mediaViewer: true }],
  },
  "GET /i/:name/preview": {
    reason: "a shared image's preview picture, for link previews: only an online item's, by its random link id",
    samples: (w) => [{ method: "GET", path: `/i/${w.a.ids.media.imageLink}/preview` }, { method: "GET", path: `/i/${w.a.ids.media.uploadingLink}/preview` }, { method: "GET", path: `/i/${inventedIds().media.imageLink}/preview` }, { method: "GET", path: `/i/${w.a.ids.media.restrictedLink}/preview`, mediaViewer: true }],
  },
  "GET /r/:name": {
    reason: "a shared clip's page or file, for visitors: only an online item answers, by its random link id, never by its database id",
    samples: (w) => [{ method: "GET", path: `/r/${w.a.ids.media.clipLink}` }, { method: "GET", path: `/r/${w.a.ids.media.clipLink}.gif` }, { method: "GET", path: `/r/${w.a.ids.media.imageLink}` }, { method: "GET", path: `/r/${w.a.ids.media.clip}` }, { method: "GET", path: `/r/${inventedIds().media.clipLink}` }],
  },
  "GET /r/:name/download": {
    reason: "a shared clip's file to save, for visitors: only an online item answers, by its random link id",
    samples: (w) => [{ method: "GET", path: `/r/${w.a.ids.media.clipLink}/download` }, { method: "GET", path: `/r/${inventedIds().media.clipLink}/download` }],
  },
  "GET /r/:name/preview": {
    reason: "a shared clip's preview picture, for link previews and its poster: only an online item's, by its random link id",
    samples: (w) => [{ method: "GET", path: `/r/${w.a.ids.media.clipLink}/preview` }, { method: "GET", path: `/r/${inventedIds().media.clipLink}/preview` }],
  },
  "GET /s/share.css": { reason: "the shared-item pages' stylesheet, fixed text", samples: () => [{ method: "GET", path: "/s/share.css" }] },
  "GET /s/share.js": { reason: "the shared-item pages' script, fixed text", samples: () => [{ method: "GET", path: "/s/share.js" }] },
  "GET /i/:name/signout": { reason: "the page \"Not you?\" under a restricted image leads to, fixed text whatever the name; it signs out only on a press", samples: (w) => [{ method: "GET", path: `/i/${w.a.ids.media.restrictedLink}/signout` }] },
  "GET /r/:name/signout": { reason: "the page \"Not you?\" under a restricted clip leads to, fixed text whatever the name; it signs out only on a press", samples: (w) => [{ method: "GET", path: `/r/${w.a.ids.media.clipLink}/signout` }] },
  "GET /s/view": { reason: "the page a viewer link for an image or clip opens, fixed text; the code stays in the browser and goes to the API only in request bodies", samples: () => [{ method: "GET", path: "/s/view" }] },
  "GET /s/view.js": { reason: "the media viewer pages' script, fixed text", samples: () => [{ method: "GET", path: "/s/view.js" }] },
  "GET /s/view.css": { reason: "the media viewer pages' stylesheet, fixed text", samples: () => [{ method: "GET", path: "/s/view.css" }] },
  "GET /s/shared.css": { reason: "the stylesheet of the line under a restricted image or clip, fixed text", samples: () => [{ method: "GET", path: "/s/shared.css" }] },
  "GET /docs": { reason: "the documentation page, the same for everyone", samples: () => [{ method: "GET", path: "/docs" }] },
  "GET /docs/:file{(?:viewer|docs)\\.[0-9a-f]{16}\\.(?:js|css)}": { reason: "the documentation page's own files", samples: () => [{ method: "GET", path: "/docs/viewer.0123456789abcdef.js" }] },
  "GET /docs/licences.txt": { reason: "licence notices, fixed text", samples: () => [{ method: "GET", path: "/docs/licences.txt" }] },
  "GET /api/v1/openapi.json": { reason: "the API description, fixed text", samples: () => [{ method: "GET", path: "/api/v1/openapi.json" }] },
  "GET /api/v1/openapi.yaml": { reason: "the API description, fixed text", samples: () => [{ method: "GET", path: "/api/v1/openapi.yaml" }] },
  "GET /signin": { reason: "the sign-in page, fixed text the same for everyone; what it shows of an account its script asks the API for", samples: () => [{ method: "GET", path: "/signin" }] },
  "GET /signin/link": { reason: "the page a sign-in link opens, fixed text; the code stays in the browser until the press sends it to the API", samples: () => [{ method: "GET", path: "/signin/link" }] },
  "GET /account": { reason: "the dashboard's Account page, fixed text the same for everyone; the account and sessions it shows its script asks the API for", samples: () => [{ method: "GET", path: "/account" }] },
  "GET /signin/signin.css": { reason: "the sign-in pages' stylesheet, fixed text", samples: () => [{ method: "GET", path: "/signin/signin.css" }] },
  "GET /signin/signin.js": { reason: "the sign-in pages' script, fixed text", samples: () => [{ method: "GET", path: "/signin/signin.js" }] },
  "GET /invite": { reason: "the page an invite's link opens, fixed text the same for everyone; the code stays in the browser and goes to the API only in request bodies", samples: () => [{ method: "GET", path: "/invite" }] },
  "GET /invite/invite.js": { reason: "the invite page's script, fixed text", samples: () => [{ method: "GET", path: "/invite/invite.js" }] },
  "GET /": {
    reason: "sends a browser to the Tours page when it sends a session cookie and to the sign-in page when not, without looking the cookie up",
    samples: () => [{ method: "GET", path: "/" }],
    byCookie: true,
  },
  "GET /tours": { reason: "the dashboard's Tours page, fixed text the same for everyone; the tours it shows its script asks the API for", samples: () => [{ method: "GET", path: "/tours" }] },
  "GET /dash/tours.js": { reason: "the Tours page's script, fixed text", samples: () => [{ method: "GET", path: "/dash/tours.js" }] },
  "GET /dash/dash.css": { reason: "the dashboard's stylesheet, fixed text", samples: () => [{ method: "GET", path: "/dash/dash.css" }] },
  "GET /dash/dash.js": { reason: "the dashboard's shared script, fixed text", samples: () => [{ method: "GET", path: "/dash/dash.js" }] },
  "GET /dash/mark.svg": { reason: "the product's mark beside the name on the dashboard and the sign-in pages, a fixed file", samples: () => [{ method: "GET", path: "/dash/mark.svg" }] },
  "GET /dash/wordmark-dark.png": { reason: "the product's name beside the mark, drawn for dark grounds, a fixed picture", samples: () => [{ method: "GET", path: "/dash/wordmark-dark.png" }] },
  "GET /dash/wordmark-light.png": { reason: "the product's name beside the mark, drawn for light grounds, a fixed picture", samples: () => [{ method: "GET", path: "/dash/wordmark-light.png" }] },
  "GET /favicon.svg": { reason: "the browser tab's icon, the product's small mark, a fixed file", samples: () => [{ method: "GET", path: "/favicon.svg" }] },
  "GET /favicon.ico": { reason: "the browser tab's icon in the older format, a fixed file", samples: () => [{ method: "GET", path: "/favicon.ico" }] },
  "GET /fonts/:file{manrope(?:\\.[0-9a-f]{16})?\\.ttf}": { reason: "the pages' text font, the same file for everyone", samples: () => [{ method: "GET", path: "/fonts/manrope.ttf" }, { method: "GET", path: "/fonts/manrope.0123456789abcdef.ttf" }] },
  "GET /fonts/manrope-OFL.txt": { reason: "the text font's licence, fixed text", samples: () => [{ method: "GET", path: "/fonts/manrope-OFL.txt" }] },
  "GET /images": { reason: "the dashboard's Images page, fixed text the same for everyone; the items it shows its script asks the API for", samples: () => [{ method: "GET", path: "/images" }] },
  "GET /dash/images.js": { reason: "the Images page's script, fixed text", samples: () => [{ method: "GET", path: "/dash/images.js" }] },
  "GET /gifs": { reason: "the dashboard's GIFs page, fixed text the same for everyone; the items it shows its script asks the API for", samples: () => [{ method: "GET", path: "/gifs" }] },
  "GET /dash/gifs.js": { reason: "the GIFs page's script, fixed text", samples: () => [{ method: "GET", path: "/dash/gifs.js" }] },
  "GET /storage": { reason: "the dashboard's Storage page, fixed text the same for everyone; the numbers it shows its script asks the API for", samples: () => [{ method: "GET", path: "/storage" }] },
  "GET /dash/storage.js": { reason: "the Storage page's script, fixed text", samples: () => [{ method: "GET", path: "/dash/storage.js" }] },
  "GET /connections": { reason: "the dashboard's Connections page, fixed text the same for everyone; the connections it shows and the codes it confirms go through the API", samples: () => [{ method: "GET", path: "/connections" }] },
  "GET /dash/connections.js": { reason: "the Connections page's script, fixed text", samples: () => [{ method: "GET", path: "/dash/connections.js" }] },
  "GET /admin": { reason: "the dashboard's Admin page, fixed text the same for everyone; its script asks the admin routes only for an admin's session, and they answer no one else", samples: () => [{ method: "GET", path: "/admin" }] },
  "GET /dash/admin.js": { reason: "the Admin page's script, fixed text", samples: () => [{ method: "GET", path: "/dash/admin.js" }] },
  "GET /dash/account.js": { reason: "the Account page's script, fixed text", samples: () => [{ method: "GET", path: "/dash/account.js" }] },
  "GET /account/email": { reason: "the page an email-change link opens, fixed text; the code stays in the browser until the press sends it to the API, which takes it only from the account that asked", samples: () => [{ method: "GET", path: "/account/email" }] },
  "GET /dash/account-email.js": { reason: "the email-change link page's script, fixed text", samples: () => [{ method: "GET", path: "/dash/account-email.js" }] },
  "GET /terms": { reason: "the terms screen and, with ?read, the terms agreed to: fixed text the same for everyone; the terms and the agreement it shows its script asks the API for", samples: () => [{ method: "GET", path: "/terms" }, { method: "GET", path: "/terms?read" }] },
  "GET /dash/terms.js": { reason: "the terms page's script, fixed text", samples: () => [{ method: "GET", path: "/dash/terms.js" }] },
  "POST /api/v1/billing/webhook": { reason: "Stripe's signed notices: no credential is read, and without a valid signature nothing is read or written; a notice finds a workspace only through ids the platform stored (the test of billing below)", samples: () => [{ method: "POST", path: "/api/v1/billing/webhook", json: { id: "evt_x", type: "invoice.paid", data: { object: {} } } }] },
  "GET /billing/subscribe": { reason: "the Subscribe page, fixed text the same for everyone; its script asks the checkout route, which takes the caller's own session", samples: () => [{ method: "GET", path: "/billing/subscribe" }] },
  "GET /dash/billing-subscribe.js": { reason: "the Subscribe page's script, fixed text", samples: () => [{ method: "GET", path: "/dash/billing-subscribe.js" }] },
  "GET /billing/return": { reason: "the page Stripe sends a person back to, fixed text; its script asks the caller's own billing state", samples: () => [{ method: "GET", path: "/billing/return" }] },
  "GET /dash/billing-return.js": { reason: "the return page's script, fixed text", samples: () => [{ method: "GET", path: "/dash/billing-return.js" }] },
  "GET /dash/billing.js": { reason: "the dashboard's billing script, fixed text", samples: () => [{ method: "GET", path: "/dash/billing.js" }] },
  "POST /api/v1/signin/request": {
    reason: "asks for a sign-in link: the answer is the same for every address and every caller, and a link goes only to the address's own mailbox",
    samples: () => [{ method: "POST", path: "/api/v1/signin/request", json: { email: "nobody-here@example.com" }, headers: { origin: ORIGIN } }],
  },
  "POST /api/v1/signin/complete": {
    reason: "turns a mailed code into a session: the code alone says whose, the caller's credential is not read, and the answer names nothing",
    samples: () => [{ method: "POST", path: "/api/v1/signin/complete", json: { code: "dpl_" + "0".repeat(40) }, headers: { origin: ORIGIN } }],
  },
};

/**
 * Routes with no id that change only the caller's own session or account: what they end.
 * Each is sent by one workspace with its session; nothing of the other may change.
 */
const SELF: Record<string, { path: string; ends?: string; changes?: string }> = {
  "POST /api/v1/signout": { path: "/api/v1/signout", ends: "the session the request is sent with" },
  "POST /api/v1/signout/everywhere": { path: "/api/v1/signout/everywhere", ends: "every session of the caller's own account" },
  "POST /api/v1/account/email": { path: "/api/v1/account/email", changes: "asks for a change of the caller's own email address; another account's address answers the same and changes nothing" },
  "POST /api/v1/account/email/confirm": { path: "/api/v1/account/email/confirm", changes: "confirms a change of the caller's own email address; another account's code is refused like one that never existed" },
  "POST /api/v1/terms/agree": { path: "/api/v1/terms/agree", changes: "records that the caller's own account agrees to the site's current terms; the body names the version and nothing of any account" },
  "POST /api/v1/billing/checkout": { path: "/api/v1/billing/checkout", changes: "starts a checkout for the caller's own workspace and stores its id there; nothing in the request names a workspace" },
  "POST /api/v1/billing/portal": { path: "/api/v1/billing/portal", changes: "opens Stripe's page for the customer on the caller's own workspace's record; nothing in the request names one" },
};
/** The SELF routes that end sessions, and those that change the caller's email address. */
const SELF_ENDS = Object.entries(SELF).filter(([, entry]) => entry.ends !== undefined);
const SELF_CHANGES = Object.keys(SELF).filter((key) => SELF[key].changes !== undefined && key.includes("/account/email"));

/** The fields of one account in the admin's list: who it is, its counts and its allowance. */
const ACCOUNT_FIELDS = ["id", "username", "email", "status", "admin", "created_at", "deleting", "workspace_id", "workspace_name", "tours", "used_bytes", "allowance_bytes", "storage_allowance_bytes", "over", "counted", "counted.pictures", "counted.logos", "counted.uploads_in_progress", "counted.images", "counted.gifs", "terms"];

/**
 * Routes that cross workspaces on purpose, for the site's admin alone: why, a request the
 * admin is answered (sent with the first side's session, the admin's), and every field the
 * answer may hold, as key paths. An answer holds exactly these, and nothing of any
 * workspace's content: an account's id, username and email and its workspace's id are the
 * only names it may carry. The requests are sent in this order, so a later one may rely on
 * an earlier one (the delete on the disable before it). `status` is the answer's status when
 * it is not 200; `answers` gives the fields per status for a route whose answer may be
 * either of two (a delete that finishes in one request or takes more).
 */
const ADMIN: Record<string, { reason: string; request: (w: World) => Sample; fields: string[]; status?: number; answers?: Record<number, string[]> }> = {
  "GET /api/v1/admin/accounts": {
    reason: "the admin's overview of how each account uses its storage: counts and the allowance, nothing of any tour",
    request: () => ({ method: "GET", path: "/api/v1/admin/accounts" }),
    fields: ["accounts", "next", "current_terms", ...ACCOUNT_FIELDS.map((f) => `accounts[].${f}`)],
  },
  "GET /api/v1/admin/summary": {
    reason: "the admin's summary line: how many accounts there are, the bytes they use in all and the site's standard allowance; three numbers, nothing of any workspace",
    request: () => ({ method: "GET", path: "/api/v1/admin/summary" }),
    // With billing on (as in this world, which has no billing problem): their count and an empty list
    // (an entry's event, workspace id and time are checked in test/billing-rework.test.ts).
    fields: ["accounts", "used_bytes", "standard_allowance_bytes", "billing_problems", "billing_problems.count", "billing_problems.recent"],
  },
  "PATCH /api/v1/admin/workspaces/:id": {
    reason: "the admin sets or clears one workspace's storage allowance, by the workspace's id; it answers the numbers only",
    request: (w) => ({ method: "PATCH", path: `/api/v1/admin/workspaces/${w.b.workspaceId}`, json: { storage_allowance_bytes: 1_000_000 } }),
    fields: ["workspace_id", "allowance_bytes", "storage_allowance_bytes", "used_bytes", "over"],
  },
  "GET /api/v1/admin/accounts/:id/removal": {
    reason: "the counts the admin's delete question shows for one account, by its id: its username and address, and how many tours, items and connections it has and the bytes it uses",
    request: (w) => ({ method: "GET", path: `/api/v1/admin/accounts/${w.b.userId}/removal` }),
    fields: ["username", "email", "tours", "items", "connections", "used_bytes"],
  },
  "POST /api/v1/admin/accounts/:id/enable": {
    reason: "the admin enables a disabled account, by its id; it answers nothing",
    request: (w) => ({ method: "POST", path: `/api/v1/admin/accounts/${w.b.userId}/enable` }),
    fields: [],
    status: 204,
  },
  "POST /api/v1/admin/accounts/:id/disable": {
    reason: "the admin disables an account, by its id, which stops everything of its workspace being served; it answers nothing",
    request: (w) => ({ method: "POST", path: `/api/v1/admin/accounts/${w.b.userId}/disable` }),
    fields: [],
    status: 204,
  },
  // 0.1.61: no delete of B is recorded yet, so it is refused; the delete after it is not stopped.
  "POST /api/v1/admin/accounts/:id/undo-removal": {
    reason: "the admin undoes a delete of one account that has removed nothing yet, by the account's id; it answers nothing, or a refusal",
    request: (w) => ({ method: "POST", path: `/api/v1/admin/accounts/${w.b.userId}/undo-removal` }),
    fields: ["error", "detail"],
    status: 409,
  },
  "DELETE /api/v1/admin/accounts/:id": {
    reason: "the admin deletes a disabled account and its workspace, by the account's id, in steps; it answers the progress in numbers only",
    request: (w) => ({ method: "DELETE", path: `/api/v1/admin/accounts/${w.b.userId}`, json: { username: w.b.email } }),
    fields: ["status", "done", "total"],
    answers: { 202: ["status", "done", "total"], 200: ["deleted"] },
  },
  // The invites: an address, an id and two times each, never anything of a workspace.
  "POST /api/v1/admin/invites": {
    reason: "the admin invites an address; it answers the invite, which belongs to no workspace until it is accepted",
    request: () => ({ method: "POST", path: "/api/v1/admin/invites", json: { email: "another-newcomer@example.com" } }),
    fields: ["id", "email", "created_at", "expires_at", "state"],
    status: 201,
  },
  "GET /api/v1/admin/invites": {
    reason: "the admin's list of the site's open and expired invites: addresses and times, nothing of any workspace",
    request: () => ({ method: "GET", path: "/api/v1/admin/invites" }),
    fields: ["invites", "invites[].id", "invites[].email", "invites[].created_at", "invites[].expires_at", "invites[].state"],
  },
  "POST /api/v1/admin/invites/:id/resend": {
    reason: "the admin sends an invite again with a new link; it answers the invite",
    request: (w) => ({ method: "POST", path: `/api/v1/admin/invites/${w.invite.id}/resend` }),
    fields: ["id", "email", "created_at", "expires_at", "state"],
  },
  "DELETE /api/v1/admin/invites/:id": {
    reason: "the admin cancels an invite; it answers nothing",
    request: (w) => ({ method: "DELETE", path: `/api/v1/admin/invites/${w.invite.id}` }),
    fields: [],
    status: 204,
  },
};

/**
 * Looking up and accepting an invite: no credential (one that carries any is refused), and
 * no workspace until the accept makes a new one. Each with its reason; the test "an
 * accepted invite's workspace is new and separate from every other" sends them.
 */
const INVITE: Record<string, { reason: string }> = {
  "POST /api/v1/invite/check": { reason: "shows the invited address and the inviter's username to whoever holds the 160-bit code; it changes nothing and reads no workspace" },
  "POST /api/v1/invite/accept": { reason: "makes a new account in a new workspace of its own for whoever holds the 160-bit code; it reaches no existing workspace" },
};

/**
 * The desktop app's requests while it connects: no credential, and no workspace until a
 * signed-in person confirms the request. Each with its reason; the test "a connection is the
 * confirming workspace's alone" sends them.
 */
const CONNECT: Record<string, { reason: string }> = {
  "POST /api/v1/connect/start": { reason: "starts a request that belongs to no workspace: its codes go to the app alone, and only the person who types the short code decides whose it becomes" },
  "POST /api/v1/connect/token": { reason: "gives a confirmed request's token, once, to whoever holds its 160-bit device code; the token belongs to the confirming workspace alone" },
};

/**
 * A visitor proving an email address on the tours address: no credential (one that carries a
 * token is refused), no workspace and no account. Each with its reason; the test "a viewer
 * cookie changes no answer of any other route" sends every other route with and without one.
 */
const VIEWER: Record<string, { reason: string }> = {
  "POST /api/v1/view/request": { reason: "asks for a viewer link to a tour: the same answer for every tour and address, and a link goes only to an address the tour's own list holds" },
  "POST /api/v1/view/check": { reason: "shows the address and the tour's slug a viewer code was mailed for, to whoever holds the 160-bit code; it changes nothing and reads no workspace" },
  "POST /api/v1/view/complete": { reason: "turns a 160-bit viewer code into a viewer session for the address it was mailed to; it reaches no workspace and no account" },
  "POST /api/v1/view/signout": { reason: "ends the browser's own viewer session, named by its cookie; nothing of any workspace or account" },
  "GET /api/v1/view/session": { reason: "the address the browser's own viewer cookie proved, and nothing else" },
  // The same on the media address, for shared items (src/viewers.ts, MEDIA_VIEWERS): their own cookie and tables.
  "POST /api/v1/media-view/request": { reason: "asks for a viewer link to a shared item: the same answer for every item and address, and a link goes only to an address the item's own list holds" },
  "POST /api/v1/media-view/check": { reason: "shows the address and the item's page a viewer code was mailed for, to whoever holds the 160-bit code; it changes nothing and reads no workspace" },
  "POST /api/v1/media-view/complete": { reason: "turns a 160-bit viewer code for an item into a media viewer session for the address it was mailed to; it reaches no workspace and no account" },
  "POST /api/v1/media-view/signout": { reason: "ends the browser's own media viewer session, named by its cookie; nothing of any workspace or account" },
  "GET /api/v1/media-view/session": { reason: "the address the browser's own media viewer cookie proved, and nothing else" },
};

type Tables = Record<string, Record<string, unknown>>;
const TABLES: Tables = { CASES, BODY_IDS, LISTS, CREATES, OPEN, SELF, ADMIN, CONNECT, INVITE, VIEWER };

// ---- The route list against the tables ----

/** The app's routes as table keys. Only the host gate, registered for every method and every path, is left out. */
function routeKeysOf(app: { routes: { method: string; path: string }[] }): string[] {
  return [...new Set(app.routes.filter((r) => !(r.method === "ALL" && r.path === "/*")).map((r) => `${r.method} ${r.path}`))];
}

const hasParameter = (key: string) => key.slice(key.indexOf(" ") + 1).includes(":");

/** Where a route with no table belongs. */
function whereToAdd(key: string): string {
  return hasParameter(key)
    ? "add it to CASES in test/isolation.test.ts, with a request for every id it can be given (or to OPEN with its reason, if it has no owner, or to ADMIN with its fields, if it is an admin route)"
    : "add it to LISTS in test/isolation.test.ts if it answers a collection or a summary, to CREATES if it makes something new in the caller's own workspace, to SELF if it changes only the caller's own session or account, to BODY_IDS if its body carries an id, to ADMIN with its fields if it is an admin route, or to OPEN with its reason if it has no owner";
}

/** An admin route, by its path: every one is under /api/v1/admin/. */
const isAdminKey = (key: string) => key.slice(key.indexOf(" ") + 1).startsWith("/api/v1/admin/");

/** Everything wrong between a route list and the tables: one line per problem, none when each route is in exactly one table and no table has a key without a route. */
function tableProblems(routes: string[], tables: Tables = TABLES): string[] {
  const problems: string[] = [];
  for (const key of routes) {
    const found = Object.keys(tables).filter((name) => Object.hasOwn(tables[name], key));
    if (found.length === 0) problems.push(`${key} is in no table: ${whereToAdd(key)}`);
    if (found.length > 1) problems.push(`${key} is in ${found.join(" and ")}: keep it in one`);
  }
  for (const [name, table] of Object.entries(tables)) {
    for (const key of Object.keys(table)) if (!routes.includes(key)) problems.push(`${key} is in ${name} but no route has it: remove it from ${name}`);
  }
  return problems;
}

/**
 * Routes with an id in the path that are not in CASES or OPEN (or, for an admin route, in
 * ADMIN); admin routes anywhere but in ADMIN; and routes in ADMIN that are no admin route.
 */
function parameterProblems(routes: string[], tables: Tables = TABLES): string[] {
  const inTable = (name: string, key: string) => Object.hasOwn(tables[name] ?? {}, key);
  const problems = routes
    .filter((key) => hasParameter(key) && !inTable("CASES", key) && !inTable("OPEN", key) && !(isAdminKey(key) && inTable("ADMIN", key)))
    .map((key) => `${key} takes an id in its path: it belongs in CASES (or in OPEN with its reason), not in LISTS, CREATES, SELF or BODY_IDS`);
  for (const key of routes) {
    if (isAdminKey(key) && !inTable("ADMIN", key)) problems.push(`${key} is an admin route: it belongs in ADMIN, with every field it may answer`);
    if (!isAdminKey(key) && inTable("ADMIN", key)) problems.push(`${key} is in ADMIN but is no admin route: only routes under /api/v1/admin/ cross workspaces`);
  }
  return problems;
}

/** For each operation of the description, the names ending in `_id` anywhere in its request body. */
function bodyIdFields(doc: OpenApiDoc): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const follow = (schema: any, seen: Set<string>, into: Set<string>): void => {
    if (schema === null || typeof schema !== "object") return;
    if (typeof schema.$ref === "string") {
      if (seen.has(schema.$ref)) return;
      seen.add(schema.$ref);
      let at: any = doc;
      for (const part of schema.$ref.slice(2).split("/")) at = at?.[part];
      return follow(at, seen, into);
    }
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      if (name.endsWith("_id")) into.add(name);
      follow(child, seen, into);
    }
    for (const list of [schema.oneOf, schema.anyOf, schema.allOf]) for (const child of list ?? []) follow(child, seen, into);
    follow(schema.items, seen, into);
    if (typeof schema.additionalProperties === "object") follow(schema.additionalProperties, seen, into);
  };
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item as Record<string, any>)) {
      const fields = new Set<string>();
      for (const media of Object.values((op.requestBody?.content ?? {}) as Record<string, any>)) follow(media.schema, new Set(), fields);
      if (fields.size > 0) out[`${method.toUpperCase()} ${path.replace(/\{([^}]+)\}/g, ":$1")}`] = [...fields].sort();
    }
  }
  return out;
}

// ---- Sending ----

/**
 * One credential as a request carries it. `page`: the request comes from the site's own
 * page, so it also carries an Origin of the address it is sent to.
 */
type Credential = { token: string | null; headers?: Record<string, string>; page?: boolean };

/**
 * The credentials every case is sent with: the side's token, and its session with the
 * anti-forgery value, as the site's own page sends a change. The session's header is
 * right for the session, so a refusal can only be about whose the ids are.
 */
const CREDENTIALS: { name: "token" | "session"; of: (side: Side) => Credential }[] = [
  { name: "token", of: (side) => ({ token: side.token }) },
  { name: "session", of: (side) => ({ token: null, headers: { cookie: side.session.cookie, "x-csrf-token": side.session.csrf, "sec-fetch-site": "same-origin" }, page: true }) },
];
const [BY_TOKEN, BY_SESSION] = CREDENTIALS as [(typeof CREDENTIALS)[number], (typeof CREDENTIALS)[number]];

const JSON_HEADERS = { "content-type": "application/json" };

async function fire(deps: Deps, r: Req | Sample, credential: Credential, origin?: string): Promise<Call> {
  // The suite tries other workspaces' short codes far more often than the limit on wrong
  // codes allows; that limit has its own tests (test/connect.test.ts), so it starts afresh here.
  if (r.path.startsWith("/api/v1/connect/")) await deps.db.run(`DELETE FROM rate_counter WHERE bucket IN (${TRY_BUCKETS.map(() => "?").join(", ")})`, [...TRY_BUCKETS]);
  const headers = { ...(r.json !== undefined ? JSON_HEADERS : {}), ...("headers" in r ? r.headers : {}), ...credential.headers, ...(credential.page ? { origin: origin ?? ORIGIN } : {}) };
  const body = r.json !== undefined ? JSON.stringify(r.json) : "bytes" in r ? r.bytes : undefined;
  return send(deps, r.method, r.path, { token: credential.token, body: body as RequestInit["body"], headers, origin });
}

/** Everything a client can see of an answer. */
const seen = (c: Call) => ({ status: c.status, headers: [...c.headers.entries()].sort(), body: c.text });

/** The tours address's answer for a route only the app address has, whoever asks. */
const NOT_HERE: Expect = { status: 404, body: { error: "not_found" } };

/**
 * The answer a request must get by this credential: its own, unless the credential may not
 * be used there, which is NOBODY: a token on a route that takes only a session, or a
 * session on the tours address of a site with two addresses (`onTours`), where sessions do
 * not count. A route that takes only a session is not on the tours address at all.
 */
function wanted(r: Req, credential: string, onTours = false): Expect {
  if (r.only === "session" && onTours) return NOT_HERE;
  if (r.only === "session" && credential !== "session") return NOBODY;
  if (credential === "session" && onTours) return NOBODY;
  return r.expect;
}

function expectAnswer(c: Call, r: Req, label: string, credential: string, onTours = false): void {
  const want = wanted(r, credential, onTours);
  expect({ status: c.status, body: want.body === null ? c.text : c.json }, label).toEqual({ status: want.status, body: want.body ?? "" });
}

/** Every request of CASES and BODY_IDS with its route key. */
function everyCase(theirs: Ids, mine: Ids): { key: string; req: Req }[] {
  return Object.entries({ ...CASES, ...BODY_IDS }).flatMap(([key, entry]) => entry(theirs, mine).map((req) => ({ key, req })));
}

const label = (key: string, req: Req, credential: string, as: Side) => `${key}: ${req.what} (as ${as.name}, by ${credential})`;

async function build(config?: Parameters<typeof makeDeps>[0]): Promise<World> {
  const ctx = await makeDeps(config);
  // Billing on, with the fake Stripe: every route of it is in the tables, and every case runs with it.
  withBilling(ctx.deps);
  return world(ctx.deps, { draftKeys: ctx.draftKeys, publicKeys: ctx.publicKeys });
}

/** Each workspace as the caller, the other as the one whose ids are named. */
const directions = (w: World): [Side, Side][] => [[w.b, w.a], [w.a, w.b]];

describe("the tables against the route table", () => {
  const routes = () => routeKeysOf(createApp({ config: BILLING_CONFIG } as Deps));

  it("every route in the route table is in exactly one of the tables, and nothing else is", () => {
    expect(tableProblems(routes())).toEqual([]);
    // The routes are really there: an empty route list would agree with empty tables.
    expect(routes().length).toBeGreaterThanOrEqual(27);
    expect(routes()).toContain("DELETE /api/v1/tours/:id");
    for (const [key, entry] of Object.entries(OPEN)) expect(entry.reason.length, `${key} needs a reason`).toBeGreaterThan(10);
    for (const [key, entry] of Object.entries(LISTS)) expect(entry.holds.length, `${key} must say what it holds`).toBeGreaterThan(10);
    for (const [key, entry] of Object.entries(CREATES)) expect(entry.makes.length, `${key} must say what it makes`).toBeGreaterThan(10);
    for (const [key, entry] of Object.entries(SELF)) expect((entry.ends ?? entry.changes ?? "").length, `${key} must say what it ends or changes`).toBeGreaterThan(10);
    for (const [key, entry] of Object.entries(CONNECT)) expect(entry.reason.length, `${key} needs a reason`).toBeGreaterThan(10);
    for (const [key, entry] of Object.entries(INVITE)) expect(entry.reason.length, `${key} needs a reason`).toBeGreaterThan(10);
    for (const [key, entry] of Object.entries(VIEWER)) expect(entry.reason.length, `${key} needs a reason`).toBeGreaterThan(10);
    for (const [key, entry] of Object.entries(ADMIN)) {
      expect(entry.reason.length, `${key} needs a reason`).toBeGreaterThan(10);
      // Only an answer with no body has no field.
      if (entry.status !== 204) expect(entry.fields.length, `${key} must list the fields it may answer`).toBeGreaterThan(0);
    }
    // The admin routes are there, and are in ADMIN.
    expect(routes().filter(isAdminKey).sort()).toEqual(Object.keys(ADMIN).sort());
  });

  it("every route whose path has a parameter is in CASES or OPEN", () => {
    expect(parameterProblems(routes())).toEqual([]);
    // And every such route names a foreign id in its path at least once, with a request of its own method and path.
    const theirs = inventedIds();
    const mine = inventedIds();
    for (const [key, entry] of Object.entries(CASES)) {
      const [method, path] = key.split(" ");
      const shape = new RegExp("^" + path.replace(/:[a-z_]+/g, "[^/]+") + "$");
      const reqs = entry(theirs, mine);
      expect(reqs.length, `${key} has no request`).toBeGreaterThan(0);
      for (const r of reqs) {
        expect(r.method, `${key}: ${r.what}`).toBe(method);
        expect(r.path, `${key}: ${r.what}`).toMatch(shape);
        const names = namesIn(theirs).filter((n) => r.path.includes(n) || JSON.stringify(r.json ?? null).includes(n));
        expect(names.length, `${key}: ${r.what} names none of the other workspace's ids`).toBeGreaterThan(0);
      }
      expect(reqs.some((r) => namesIn(theirs).some((n) => r.path.includes(n))), `${key} never names a foreign id in its path`).toBe(true);
    }
  });

  it("every request-body field of the description whose name ends in _id has a case in BODY_IDS", () => {
    const fields = bodyIdFields(openapi());
    // The walk finds the fields there are today; if it found none, it would check nothing.
    expect(fields).toMatchObject({ "POST /api/v1/uploads": ["chapter_id", "tour_id"], "POST /api/v1/tours/:id/publish": ["publish_id"] });
    const theirs = inventedIds();
    const mine = inventedIds();
    for (const [key, names] of Object.entries(fields)) {
      // A route with an id in its path is in CASES and carries its body-id requests there.
      const table = hasParameter(key) ? CASES : BODY_IDS;
      const tableName = hasParameter(key) ? "CASES" : "BODY_IDS";
      expect(Object.hasOwn(table, key), `${key} has ${names.join(", ")} in its body: add it to ${tableName} with a request for each, marked with \`field\``).toBe(true);
      const reqs = table[key](theirs, mine);
      for (const name of names) {
        const marked = reqs.filter((r) => r.field === name);
        expect(marked.length, `${key}: no request of ${tableName} is marked \`field: "${name}"\``).toBeGreaterThan(0);
        // The marked request really carries one of the other workspace's ids in that field.
        const carries = (v: unknown): boolean =>
          v !== null && typeof v === "object" && Object.entries(v).some(([k, x]) => (k === name && typeof x === "string" && namesIn(theirs).includes(x)) || carries(x));
        for (const r of marked) expect(carries(r.json), `${key}: ${r.what} does not put a foreign id in ${name}`).toBe(true);
      }
    }
    // And BODY_IDS holds nothing else: each of its requests names a field.
    for (const [key, entry] of Object.entries(BODY_IDS)) for (const r of entry(theirs, mine)) expect(r.field, `${key}: ${r.what}`).toBeTypeOf("string");
  });

  it("the suite itself fails for a route with no case", () => {
    const app = createApp({ config: BILLING_CONFIG } as Deps);
    app.get("/api/v1/tours/:id/notes", (c) => c.json({}));
    app.post("/api/v1/export", (c) => c.json({}));
    app.all("/api/v1/anything/:id", (c) => c.json({}));
    const problems = tableProblems(routeKeysOf(app));
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/^GET \/api\/v1\/tours\/:id\/notes is in no table: add it to CASES in test\/isolation\.test\.ts/);
    expect(problems[1]).toMatch(/^POST \/api\/v1\/export is in no table: add it to LISTS in test\/isolation\.test\.ts .* to BODY_IDS .* or to OPEN/);
    expect(problems[2]).toMatch(/^ALL \/api\/v1\/anything\/:id is in no table: add it to CASES/);

    // A route with an id in its path cannot be passed off as a list.
    const asList: Tables = { ...TABLES, LISTS: { ...LISTS, "GET /api/v1/tours/:id/notes": {} } };
    expect(tableProblems(["GET /api/v1/tours/:id/notes", ...routes()], asList)).toEqual([]);
    expect(parameterProblems(["GET /api/v1/tours/:id/notes", ...routes()], asList)).toEqual([
      "GET /api/v1/tours/:id/notes takes an id in its path: it belongs in CASES (or in OPEN with its reason), not in LISTS, CREATES, SELF or BODY_IDS",
    ]);
    // A route in two tables, and a table key left behind by a route that is gone.
    const twice: Tables = { ...TABLES, LISTS: { ...LISTS, "GET /healthz": {} } };
    expect(tableProblems(routes(), twice)).toEqual(["GET /healthz is in LISTS and OPEN: keep it in one"]);
    expect(tableProblems(routes().filter((k) => k !== "GET /api/v1/usage"))).toEqual(["GET /api/v1/usage is in LISTS but no route has it: remove it from LISTS"]);

    // A new admin route with no entry fails, and so does one passed off as a list or put in CASES,
    // and a route in ADMIN that is no admin route.
    const withAdmin = createApp({ config: BILLING_CONFIG } as Deps);
    withAdmin.get("/api/v1/admin/tours", (c) => c.json({}));
    withAdmin.delete("/api/v1/admin/workspaces/:id", (c) => c.json({}));
    expect(tableProblems(routeKeysOf(withAdmin))).toEqual([
      "GET /api/v1/admin/tours is in no table: add it to LISTS in test/isolation.test.ts if it answers a collection or a summary, to CREATES if it makes something new in the caller's own workspace, to SELF if it changes only the caller's own session or account, to BODY_IDS if its body carries an id, to ADMIN with its fields if it is an admin route, or to OPEN with its reason if it has no owner",
      "DELETE /api/v1/admin/workspaces/:id is in no table: add it to CASES in test/isolation.test.ts, with a request for every id it can be given (or to OPEN with its reason, if it has no owner, or to ADMIN with its fields, if it is an admin route)",
    ]);
    const misplaced: Tables = { ...TABLES, LISTS: { ...LISTS, "GET /api/v1/admin/tours": {} }, CASES: { ...CASES, "DELETE /api/v1/admin/workspaces/:id": () => [] } };
    expect(tableProblems(routeKeysOf(withAdmin), misplaced)).toEqual([]);
    expect(parameterProblems(routeKeysOf(withAdmin), misplaced)).toEqual([
      "GET /api/v1/admin/tours is an admin route: it belongs in ADMIN, with every field it may answer",
      "DELETE /api/v1/admin/workspaces/:id is an admin route: it belongs in ADMIN, with every field it may answer",
    ]);
    const notAdmin: Tables = { ...TABLES, LISTS: { ...LISTS }, ADMIN: { ...ADMIN, "GET /api/v1/usage": {} } };
    delete (notAdmin.LISTS as Record<string, unknown>)["GET /api/v1/usage"];
    expect(parameterProblems(routes(), notAdmin)).toEqual(["GET /api/v1/usage is in ADMIN but is no admin route: only routes under /api/v1/admin/ cross workspaces"]);
  });
});

describe("one workspace against another", () => {
  it("the world holds two full workspaces, and the stand-in ids are none of theirs", SLOW, async () => {
    const w = await build();
    const names = [...namesIn(w.a.ids), ...namesIn(w.b.ids)];
    expect(new Set(names).size).toBe(names.length);
    const invented = namesIn(inventedIds(w.a.ids));
    expect(invented.length).toBe(namesIn(w.a.ids).length);
    for (const n of invented) expect(names).not.toContain(n);
    for (const side of [w.a, w.b]) {
      const s = await snapshotOf(w.deps, side, w.keys);
      for (const table of ["workspace", "user", "membership", "signin_method", "signin_code", "session", "email_change", "audit", "api_token", "tour", "chapter", "step", "snapshot", "snapshot_object", "public_object", "publish_job", "replaced_object", "upload", "upload_step", "tour_deletion", "deleted_object", "media", "media_object", "tour_viewer", "access_switch", "media_viewer"]) {
        expect(s.rows[table].length, `${side.name} has no row in ${table}`).toBeGreaterThan(0);
      }
      // Every file a row names is there, but the one picture the publish in progress has not
      // copied yet, and the three the switch in progress has not moved yet.
      const notCopied = s.rows.public_object.filter((o) => o.state === "pending" && o.copied === 0 && !String(o.publish_id).startsWith("sws_")).map((o) => o.image_key);
      expect(notCopied).toHaveLength(4);
      // And the public pictures the switch to restricted has moved: deleted from the public
      // store as soon as their copies were marked; only the copies' rows still say where they
      // came from (source_key).
      const dropped = s.rows.public_object.filter((o) => String(o.publish_id).startsWith("sw_") && o.copied === 1).map((o) => o.source_key as string);
      expect(dropped).toHaveLength(12);
      expect(Object.keys(s.files).filter((key) => s.files[key] === "missing").sort()).toEqual([...notCopied, ...dropped].sort());
      expect(Object.keys(s.files).length).toBeGreaterThan(20);
    }
  });

  it("every table of the database belongs to a workspace in the snapshot, or is listed as shared", async () => {
    const { deps } = await makeDeps();
    const tables = await tablesOf(deps);
    expect(tables.length).toBeGreaterThan(20);
    const known = [...Object.keys(OWNED), ...Object.keys(SHARED)];
    expect(tables.filter((t) => !known.includes(t)), "say whose rows these tables hold: add each to OWNED in test/isolation-world.ts, or to SHARED with its reason").toEqual([]);
    expect(known.filter((t) => !tables.includes(t)), "no such table: remove these from OWNED or SHARED in test/isolation-world.ts").toEqual([]);
    expect(Object.keys(OWNED).filter((t) => Object.hasOwn(SHARED, t))).toEqual([]);
    for (const [table, reason] of Object.entries(SHARED)) expect(reason.length, `${table} needs a reason`).toBeGreaterThan(10);
  });

  it("another workspace's token gets the route's own not-found answer for every case", SLOW, async () => {
    const w = await build();
    for (const [mine, theirs] of directions(w)) {
      for (const credential of CREDENTIALS) {
        for (const { key, req } of everyCase(theirs.ids, mine.ids)) {
          w.tick();
          expectAnswer(await fire(w.deps, req, credential.of(mine)), req, label(key, req, credential.name, mine), credential.name);
        }
      }
    }
    // The same requests are not refused for everyone: with its own ids a workspace is answered otherwise, by either credential.
    for (const credential of CREDENTIALS) {
      w.tick();
      const own = await fire(w.deps, CASES["PATCH /api/v1/tours/:id"](w.a.ids, w.a.ids)[1], credential.of(w.a));
      expect(own.status, credential.name).toBe(200);
    }
    const ownSession = await fire(w.deps, CASES["DELETE /api/v1/sessions/:id"](w.a.ids, w.a.ids)[1], BY_SESSION.of(w.a));
    expect(ownSession.status).toBe(204);
  });

  it("that answer is byte for byte the answer for an id that never existed", SLOW, async () => {
    const w = await build();
    for (const [mine, theirs] of directions(w)) {
      const real = everyCase(theirs.ids, mine.ids);
      const invented = everyCase(inventedIds(theirs.ids), mine.ids);
      expect(invented.length).toBe(real.length);
      for (const credential of CREDENTIALS) {
        for (let i = 0; i < real.length; i++) {
          w.tick();
          const never = await fire(w.deps, invented[i].req, credential.of(mine));
          const theirsAnswer = await fire(w.deps, real[i].req, credential.of(mine));
          expect(seen(theirsAnswer), label(real[i].key, real[i].req, credential.name, mine)).toEqual(seen(never));
        }
      }
    }
  });

  it("nothing of the first workspace changed: rows and files are identical before and after every case", SLOW, async () => {
    const w = await build();
    const everyUse = [w.a.tokenId, w.b.tokenId, w.a.session.id, w.b.session.id];
    const start = await dumpOf(w.deps, w.keys, { files: true, touched: everyUse });
    for (const [mine, theirs] of directions(w)) {
      // A request with an accepted token or session records that it was used; nothing else may differ.
      const look = () => dumpOf(w.deps, w.keys, { touched: [mine.tokenId, mine.session.id] });
      const before = await look();
      const real = everyCase(theirs.ids, mine.ids);
      const invented = everyCase(inventedIds(theirs.ids), mine.ids);
      for (const credential of CREDENTIALS) {
        for (const { key, req } of [...real, ...invented]) {
          w.tick();
          await fire(w.deps, req, credential.of(mine));
          const what = label(key, req, credential.name, mine);
          expect(w.writes(), `${what} wrote to or deleted from a store`).toEqual([]);
          expect(await look(), `${what} changed what is stored`).toEqual(before);
        }
      }
    }
    // And every file still holds the bytes it held, under the type it had.
    expect(await dumpOf(w.deps, w.keys, { files: true, touched: everyUse })).toEqual(start);
    expect(Object.keys(start.files ?? {}).length).toBeGreaterThan(60);
  });

  it("nothing of the first workspace changes when it has an old upload, a stale publish and pictures past their grace", SLOW, async () => {
    const w = await build();
    // A day on, both workspaces hold things housekeeping removes: uploads past their age, a
    // publish nobody continued, public pictures a re-publish retired. The second workspace's
    // requests run its own housekeeping, also the refused ones; none may reach the first's.
    w.tick(UPLOAD_MAX_AGE_MS + 60_000);
    const before = await snapshotOf(w.deps, w.a, w.keys);
    expect(before.rows.publish_job).toHaveLength(1);
    expect(before.rows.upload).toHaveLength(2);
    expect(before.rows.replaced_object).toHaveLength(1);
    expect(before.rows.public_object.filter((o) => o.state === "retired" && o.delete_after <= w.deps.now()).length).toBeGreaterThan(0);

    for (const credential of CREDENTIALS) {
      for (const { key, req } of everyCase(w.a.ids, w.b.ids)) {
        w.tick();
        const what = label(key, req, credential.name, w.b);
        expectAnswer(await fire(w.deps, req, credential.of(w.b)), req, what, credential.name);
        expect(await snapshotOf(w.deps, w.a, w.keys), `${what} changed something of the other workspace`).toEqual(before);
      }
    }
    // Its own ordinary requests, each of which runs housekeeping for its own workspace.
    const own: [string, () => Promise<Call>][] = [
      ["list tours", () => send(w.deps, "GET", "/api/v1/tours", { token: w.b.token })],
      ["create an upload", () => send(w.deps, "POST", "/api/v1/uploads", { token: w.b.token, body: JSON.stringify({ manifest: manifestOf([700], "Bravo later tour"), target: { kind: "new" } }), headers: JSON_HEADERS })],
      ["publish", () => send(w.deps, "POST", tourPath(w.b.ids.published.tour, "/publish"), { token: w.b.token })],
      ["unpublish", () => send(w.deps, "POST", tourPath(w.b.ids.published.tour, "/unpublish"), { token: w.b.token })],
      ["delete a tour", () => send(w.deps, "DELETE", tourPath(w.b.ids.draft.tour), { token: w.b.token })],
      ["finish a delete", () => send(w.deps, "DELETE", tourPath(w.b.ids.deleting.tour), { token: w.b.token })],
      ["start a shared item", () => send(w.deps, "POST", "/api/v1/media", { token: w.b.token, body: JSON.stringify(CREATES["POST /api/v1/media"].sample(w.b).json), headers: JSON_HEADERS })],
    ];
    for (const [what, run] of own) {
      w.tick();
      const r = await run();
      expect(r.status, `${what}: ${r.text}`).toBeLessThan(300);
      expect(await snapshotOf(w.deps, w.a, w.keys), `the other workspace's own ${what} changed something of the first`).toEqual(before);
    }
    // The housekeeping did run, for the workspace that asked: its stale publish, its old
    // uploads and its retired pictures are gone. So the first workspace's were there to take.
    const after = await snapshotOf(w.deps, w.b, w.keys);
    expect(after.rows.publish_job).toEqual([]);
    expect(after.rows.upload.map((u) => u.id)).not.toContain(w.b.ids.upload);
    expect(after.rows.tour_deletion).toEqual([]);
    expect(after.rows.replaced_object).toEqual([]);
    // Its switch to restricted, left for a day, was finished by that same housekeeping.
    expect(after.rows.public_object).toEqual([]);
    expect(after.rows.access_switch).toEqual([]);
    expect(before.rows.access_switch).toHaveLength(1);
    expect(after.rows.media.map((m) => m.id)).not.toContain(w.b.ids.media.uploading);
    expect(before.rows.media.map((m) => m.id)).toContain(w.a.ids.media.uploading);
  });

  it("no list or summary of one workspace holds anything of the other", SLOW, async () => {
    const w = await build();
    const { deps } = w;
    const needles = async (side: Side) => needlesOf(await snapshotOf(deps, side, w.keys), [side.token, side.revokedToken, side.workspaceName, side.email, side.session.secret, side.session.csrf]);
    // Each list by each credential it takes, keyed "<route> by <credential>".
    const answers = async (side: Side) => {
      const out: Record<string, { status: number; body: string }> = {};
      for (const [key, list] of Object.entries(LISTS)) {
        for (const credential of CREDENTIALS) {
          if (list.only !== undefined && list.only !== credential.name) continue;
          const r = await fire(deps, { method: "GET", path: list.path }, credential.of(side));
          out[`${key} by ${credential.name}`] = { status: r.status, body: r.text };
        }
      }
      return out;
    };
    const all = { a: await needles(w.a), b: await needles(w.b) };
    // The one name both have is the fixed name of a workspace's first token, which tells nothing.
    expect(all.a.filter((n) => all.b.includes(n))).toEqual(["First token"]);
    const mine = { a: all.a.filter((n) => !all.b.includes(n)), b: all.b.filter((n) => !all.a.includes(n)) };
    // The needles are what would give a workspace away: its ids, titles, slugs, email and file names.
    for (const n of [w.a.workspaceId, w.a.email, w.a.ids.published.tour, w.a.ids.draft.step, w.a.ids.published.slug, w.a.ids.published.publicName, w.a.ids.upload, "Alpha published tour", "Alpha workspace"]) expect(mine.a).toContain(n);
    expect(mine.a.length).toBeGreaterThan(80);

    const first = { a: await answers(w.a), b: await answers(w.b) };
    // Six lists take one credential, the others both.
    expect(Object.keys(first.a)).toHaveLength(Object.keys(LISTS).length * 2 - 7);
    for (const key of Object.keys(first.a)) {
      expect(first.a[key].status, key).toBe(200);
      expect(first.b[key].status, key).toBe(200);
      for (const n of mine.a) expect(first.b[key].body.includes(n), `${key} told the second workspace ${n} of the first`).toBe(false);
      for (const n of mine.b) expect(first.a[key].body.includes(n), `${key} told the first workspace ${n} of the second`).toBe(false);
    }
    // The list of clips, which LISTS does not ask for, holds nothing of the other workspace either, by either credential.
    for (const credential of CREDENTIALS) {
      const clipsOfB = await fire(deps, { method: "GET", path: "/api/v1/media?kind=clip" }, credential.of(w.b));
      const clipsOfA = await fire(deps, { method: "GET", path: "/api/v1/media?kind=clip" }, credential.of(w.a));
      expect([clipsOfA.status, clipsOfB.status]).toEqual([200, 200]);
      for (const n of mine.a) expect(clipsOfB.text.includes(n), `the clips told the second workspace ${n} of the first`).toBe(false);
      for (const n of mine.b) expect(clipsOfA.text.includes(n), `the clips told the first workspace ${n} of the second`).toBe(false);
      expect(clipsOfA.json.items.map((i: Json) => i.id)).toEqual([w.a.ids.media.clip]);
    }
    // A leak would be seen: each workspace's own answers do hold its own names.
    expect(first.a["GET /api/v1/tours by token"].body).toContain(w.a.ids.published.tour);
    expect(first.a["GET /api/v1/tours by session"].body).toContain("Alpha draft tour");
    expect(first.a["GET /api/v1/me by session"].body).toContain("Alpha workspace");
    expect(first.a["GET /api/v1/session by session"].body).toContain(w.a.email);
    expect(first.a["GET /api/v1/sessions by session"].body).toContain(w.a.ids.otherSession);
    expect(first.a["GET /api/v1/media by token"].body).toContain(w.a.ids.media.imageLink);
    expect(first.a["GET /api/v1/media by session"].body).toContain("Alpha shared image");
    // A token and a session of one workspace see the same tours and the same usage.
    expect(first.b["GET /api/v1/tours by session"]).toEqual(first.b["GET /api/v1/tours by token"]);
    expect(first.b["GET /api/v1/usage by session"]).toEqual(first.b["GET /api/v1/usage by token"]);
    expect(first.b["GET /api/v1/usage/largest by session"]).toEqual(first.b["GET /api/v1/usage/largest by token"]);
    // The largest tours are the workspace's own, every one of them here (it has fewer than ten).
    const largestA = JSON.parse(first.a["GET /api/v1/usage/largest by session"].body).tours as Json[];
    expect(largestA.map((t) => t.id).sort()).toEqual([w.a.ids.published.tour, w.a.ids.draft.tour, w.a.ids.publishing.tour, w.a.ids.restricted.tour, w.a.ids.switching.tour].sort());
    // The largest of every kind: the workspace's own tours and items (the unfinished one too), never the other's.
    for (const [me, them] of [[w.a, w.b], [w.b, w.a]] as const) {
      const mine = JSON.parse(first[me === w.a ? "a" : "b"]["GET /api/v1/usage/largest by session"].body).largest as Json[];
      expect(mine.map((e) => e.id).sort()).toEqual(
        [me.ids.published.tour, me.ids.draft.tour, me.ids.publishing.tour, me.ids.restricted.tour, me.ids.switching.tour, me.ids.media.image, me.ids.media.clip, me.ids.media.uploading, me.ids.media.restricted].sort(),
      );
      const theirs = new Set([them.ids.published.tour, them.ids.draft.tour, them.ids.publishing.tour, them.ids.restricted.tour, them.ids.switching.tour, them.ids.media.image, them.ids.media.clip, them.ids.media.uploading, them.ids.media.restricted]);
      for (const e of mine) expect(theirs.has(e.id as string), String(e.id)).toBe(false);
    }

    // The numbers of a workspace are its own rows' and nobody else's.
    const usage = async (side: Side) => {
      const s = await snapshotOf(deps, side, w.keys);
      const sum = (rows: Json[], column: string) => rows.reduce((n, r) => n + ((r[column] as number | null) ?? 0), 0);
      const pictures = sum(s.rows.step, "bytes");
      const logos = sum(s.rows.tour, "logo_bytes");
      const uploads = sum(s.rows.upload.filter((u) => u.closing_at === null), "reserved_bytes");
      // Every item in every state with its counted claim rows (the current preview, every claim that is not current), split by kind.
      const counts = (o: Json) => o.current === 0 || o.n === -1;
      const of = (kind: string) => s.rows.media.filter((m) => m.kind === kind);
      const bytesOf = (kind: string) => {
        const ids = new Set(of(kind).map((m) => m.id));
        return sum(of(kind), "bytes") + sum(s.rows.media_object.filter((o) => ids.has(o.media_id) && counts(o)), "bytes");
      };
      const images = bytesOf("image");
      const gifs = bytesOf("clip");
      expect(images).toBeGreaterThan(0);
      expect(gifs).toBeGreaterThan(0);
      const online = (kind: string) => of(kind).filter((m) => m.state === "online").length;
      return {
        used_bytes: pictures + logos + uploads + images + gifs,
        // Billing is on in this world (no site default): the admin's own workspace is exempt and has no limit, the other is on its trial.
        allowance_bytes: s.rows.user.some((u) => u.is_admin === 1) ? null : TRIAL_BYTES,
        over: false,
        tours: s.rows.tour.length,
        images: online("image"),
        gifs: online("clip"),
        counted: { pictures, logos, uploads_in_progress: uploads, images, gifs },
      };
    };
    const usedA = JSON.parse(first.a["GET /api/v1/usage by token"].body);
    const usedB = JSON.parse(first.b["GET /api/v1/usage by token"].body);
    expect(usedA).toEqual(await usage(w.a));
    expect(usedB).toEqual(await usage(w.b));
    expect(usedA.used_bytes).not.toBe(usedB.used_bytes);
    expect(JSON.parse(first.b["GET /api/v1/tours by token"].body).tours).toHaveLength(5);

    // Whatever the first workspace then does, the second's answers stay the same, byte for byte.
    w.tick();
    const token = w.a.token;
    const steps = [
      await send(deps, "PATCH", tourPath(w.a.ids.published.tour), { token, body: JSON.stringify({ title: "Alpha renamed tour" }), headers: JSON_HEADERS }),
      await send(deps, "POST", tourPath(w.a.ids.draft.tour, "/publish"), { token }),
      await send(deps, "POST", tourPath(w.a.ids.published.tour, "/unpublish"), { token }),
      await send(deps, "DELETE", uploadPath(w.a.ids.upload), { token }),
      await send(deps, "DELETE", tourPath(w.a.ids.deleting.tour), { token }),
      await send(deps, "POST", "/api/v1/uploads", { token, body: JSON.stringify({ manifest: manifestOf([90_000, 90_001], "Alpha later tour"), target: { kind: "new" } }), headers: JSON_HEADERS }),
    ];
    for (const r of steps) expect(r.status, r.text).toBeLessThan(300);
    const second = { a: await answers(w.a), b: await answers(w.b) };
    // The token list holds when each token was last used, and the second workspace's own token
    // was used by the requests above; nothing else of its answers may differ.
    const unused = (all: Record<string, { status: number; body: string }>) => {
      const list = all["GET /api/v1/tokens by session"];
      const tokens = (JSON.parse(list.body).tokens as Json[]).map((t) => ({ ...t, last_used_at: "(its own use)" }));
      return { ...all, "GET /api/v1/tokens by session": { status: list.status, body: JSON.stringify({ tokens }) } };
    };
    expect(unused(second.b)).toEqual(unused(first.b));
    expect(second.a["GET /api/v1/usage by token"].body).not.toBe(first.a["GET /api/v1/usage by token"].body);
    expect(second.a["GET /api/v1/tours by session"].body).not.toBe(first.a["GET /api/v1/tours by session"].body);

    // And a workspace at its allowance does not take room from another: the limit is per workspace.
    await deps.db.run("UPDATE workspace SET storage_allowance_bytes = ? WHERE id = ?", [JSON.parse(second.a["GET /api/v1/usage by token"].body).used_bytes, w.a.workspaceId]);
    const full = await send(deps, "POST", "/api/v1/uploads", { token, body: JSON.stringify({ manifest: manifestOf([10], "Alpha one more"), target: { kind: "new" } }), headers: JSON_HEADERS });
    expect(full.status).toBe(413);
    const other = await send(deps, "POST", "/api/v1/uploads", { token: w.b.token, body: JSON.stringify({ manifest: manifestOf([10], "Bravo one more"), target: { kind: "new" } }), headers: JSON_HEADERS });
    expect(other.status).toBe(201);
  });

  it("signing out, here or everywhere, ends nothing of the other workspace", SLOW, async () => {
    const w = await build();
    const { deps, a, b } = w;
    const fresh = async (side: Side): Promise<Credential> => {
      const made = await redeemSignInCode(deps, await createSignInCode(deps, side.userId), null, null);
      if (made === null) throw new Error("the sign-in was refused");
      return { token: null, headers: { cookie: `${SESSION_COOKIE}=${made.secret}`, "x-csrf-token": await csrfFor(made.secret), "sec-fetch-site": "same-origin" }, page: true };
    };
    const alive = async (credential: Credential) => (await fire(deps, { method: "GET", path: "/api/v1/session" }, credential)).status;
    for (const [mine, theirs] of directions(w)) {
      for (const [key, self] of SELF_ENDS) {
        const caller = await fresh(mine);
        const theirsLive = await fresh(theirs);
        // Asked once, so that asking again below writes nothing.
        expect(await alive(theirsLive)).toBe(200);
        const before = await snapshotOf(deps, theirs, w.keys);
        w.tick();
        // By token: nobody, and nothing ends.
        expect((await fire(deps, { method: "POST", path: self.path }, BY_TOKEN.of(mine))).status, `${key} by token`).toBe(401);
        expect(await alive(caller), `${key} by token`).toBe(200);
        // By session: the caller's own session ends, and nothing of the other workspace does.
        expect((await fire(deps, { method: "POST", path: self.path }, caller)).status, key).toBe(204);
        expect(await alive(caller), key).toBe(401);
        expect(await snapshotOf(deps, theirs, w.keys), `${key} by ${mine.name} changed something of ${theirs.name}`).toEqual(before);
        expect(await alive(theirsLive), `${key} by ${mine.name} ended a session of ${theirs.name}`).toBe(200);
      }
    }
    expect(w.writes()).toEqual([]);
    // Everywhere did end the caller's own sessions: the ones the world made, too.
    expect(await alive(BY_SESSION.of(a))).toBe(401);
    expect(await alive(BY_SESSION.of(b))).toBe(401);
  });

  it("what a workspace makes is its own, and nothing of the other workspace changes", SLOW, async () => {
    const w = await build();
    for (const [mine, theirs] of directions(w)) {
      for (const credential of CREDENTIALS) {
        for (const [key, entry] of Object.entries(CREATES)) {
          for (const [i, sample] of [entry.sample(mine), ...(entry.more?.(mine, theirs) ?? [])].entries()) {
            const before = await snapshotOf(w.deps, theirs, w.keys);
            const had = (await snapshotOf(w.deps, mine, w.keys)).rows[entry.made].length;
            w.tick();
            const what = `${key} #${i} (as ${mine.name}, by ${credential.name})`;
            const r = await fire(w.deps, sample, credential.of(mine));
            expect(r.status, `${what}: ${r.text}`).toBe(201);
            expect(await snapshotOf(w.deps, theirs, w.keys), `${what} changed something of ${theirs.name}`).toEqual(before);
            expect((await snapshotOf(w.deps, mine, w.keys)).rows[entry.made].length, what).toBe(had + 1);
            // The answer names nothing of the other workspace.
            for (const n of namesIn(theirs.ids)) expect(r.text.includes(n), `${what} told ${n}`).toBe(false);
          }
        }
      }
    }
    expect(w.writes()).toEqual([]);
  });

  it("the fields of the cases that name the other workspace's tours are taken on the caller's own never-published tour, so their 404 is about whose the tour is", SLOW, async () => {
    const w = await build({ siteHost: "tours.example.com" });
    const [mine, theirs] = directions(w)[0];
    const bodies = new Map<string, unknown>();
    for (const r of CASES["POST /api/v1/tours/:id/publish"](theirs.ids, mine.ids)) {
      const json = r.json as Record<string, unknown> | undefined;
      if (json !== undefined && Object.hasOwn(json, "access")) bodies.set(JSON.stringify(json), json);
    }
    expect(bodies.size).toBe(3);
    for (const [text, json] of bodies) {
      const fresh = await send(w.deps, "POST", "/api/v1/uploads", { token: mine.token, body: JSON.stringify({ manifest: manifestOf([801], `${mine.name} own ${bodies.size}`), target: { kind: "new" } }), headers: JSON_HEADERS });
      expect(fresh.status, fresh.text).toBe(201);
      expect((await putStep(w.deps, mine.token, fresh.json.upload_id, 1, stepImage(manifestOf([801], "x").steps[0], 4))).status).toBe(204);
      const committed = await commit(w.deps, mine.token, fresh.json.upload_id);
      const before = await snapshotOf(w.deps, theirs, w.keys);
      const r = await fire(w.deps, { method: "POST", path: tourPath(committed.json.tour_id, "/publish"), json }, BY_TOKEN.of(mine));
      expect([r.status, r.json.access], `${text}: ${r.text}`).toEqual([200, (json as { access: string }).access]);
      expect(await snapshotOf(w.deps, theirs, w.keys), text).toEqual(before);
    }
  });

  it("a change of the caller's own chapters, removing one with a replace open and pictures waiting, reaches nothing of the other workspace", SLOW, async () => {
    const w = await build();
    for (const [mine, theirs] of directions(w)) {
      for (const credential of CREDENTIALS) {
        const what = `(as ${mine.name}, by ${credential.name})`;
        const tourId = mine.ids.draft.tour;
        const read = await fire(w.deps, { method: "GET", path: tourPath(tourId, "/chapters") }, credential.of(mine));
        expect(read.status, `${what}: ${read.text}`).toBe(200);
        // A second chapter, so the first (with its open replace) can be removed.
        const added = await send(w.deps, "POST", "/api/v1/uploads", { token: mine.token, body: JSON.stringify({ manifest: manifestOf([900], `${mine.name} added ${credential.name}`), target: { kind: "chapter", tour_id: tourId } }), headers: JSON_HEADERS });
        expect(added.status, added.text).toBe(201);
        expect((await putStep(w.deps, mine.token, added.json.upload_id, 1, stepImage(manifestOf([900], "x").steps[0], 5))).status).toBe(204);
        const chapter = (await commit(w.deps, mine.token, added.json.upload_id)).json.chapter_id as string;
        const now = (await fire(w.deps, { method: "GET", path: tourPath(tourId, "/chapters") }, credential.of(mine))).json;
        const before = await snapshotOf(w.deps, theirs, w.keys);
        w.tick();
        const r = await fire(w.deps, { method: "PUT", path: tourPath(tourId, "/chapters"), json: { revision: now.revision, chapters: [chapter] } }, credential.of(mine));
        expect(r.status, `${what}: ${r.text}`).toBe(200);
        expect(r.json.chapters.map((c: Json) => c.id)).toEqual([chapter]);
        expect(await snapshotOf(w.deps, theirs, w.keys), `${what} changed something of ${theirs.name}`).toEqual(before);
        for (const needle of needlesOf(before)) expect(r.text, what).not.toContain(needle);
      }
    }
  });

  it("the most chapters a tour has (0.1.56) counts the caller's own tour only: the other's full tour answers as no tour, and neither count moves the other", SLOW, async () => {
    const w = await build();
    const max = 400;
    for (const [mine, theirs] of directions(w)) {
      // Their draft tour is full (filled in straight: through the routes each chapter would be an upload).
      const have = (await w.deps.db.first<{ n: number }>("SELECT count(*) AS n FROM chapter WHERE tour_id = ?", [theirs.ids.draft.tour]))!.n;
      const fill = Array.from({ length: max - have }, () => newId("ch"));
      await w.deps.db.run("INSERT INTO chapter (id, tour_id, title, description, position) SELECT j.value, ?, 'Bare', NULL, 1000 + j.key FROM json_each(?) j", [theirs.ids.draft.tour, JSON.stringify(fill)]);
      for (const credential of CREDENTIALS) {
        const what = `(as ${mine.name}, by ${credential.name})`;
        const before = await snapshotOf(w.deps, theirs, w.keys);
        const req: Req = { what: "a new chapter for their full tour", method: "POST", path: "/api/v1/uploads", json: createInto(theirs.ids, { kind: "chapter", tour_id: theirs.ids.draft.tour }), field: "tour_id", expect: NO_TOUR };
        expectAnswer(await fire(w.deps, req, credential.of(mine)), req, `${req.what} ${what}`, credential.name);
        // The caller's own tour, far from full, still takes a new chapter.
        const own = await fire(w.deps, { what: "own", method: "POST", path: "/api/v1/uploads", json: createInto(mine.ids, { kind: "chapter", tour_id: mine.ids.draft.tour }), expect: NO_TOUR }, credential.of(mine));
        expect(own.status, `${what}: ${own.text}`).toBe(201);
        await send(w.deps, "DELETE", `/api/v1/uploads/${own.json.upload_id}`, { token: mine.token });
        expect(await snapshotOf(w.deps, theirs, w.keys), `${what} changed something of ${theirs.name}`).toEqual(before);
      }
      await w.deps.db.run("DELETE FROM chapter WHERE id IN (SELECT value FROM json_each(?))", [JSON.stringify(fill)]);
    }
  });

  it("who may view, stated at a create or a first publish on a site that can mail, reaches nothing of the other workspace", SLOW, async () => {
    const w = await build({ siteHost: "tours.example.com" });
    for (const [mine, theirs] of directions(w)) {
      for (const credential of CREDENTIALS) {
        const what = `(as ${mine.name}, by ${credential.name})`;
        const before = await snapshotOf(w.deps, theirs, w.keys);
        const listed = [theirs.ids.restricted.viewer, theirs.email];
        const item = { kind: "image", content_type: "image/png", bytes: 1234, width: 10, height: 10 };
        // The caller's own new tour, never published: its first publish may state who views it.
        const fresh = await send(w.deps, "POST", "/api/v1/uploads", { token: mine.token, body: JSON.stringify({ manifest: manifestOf([800], `${mine.name} first published ${credential.name}`), target: { kind: "new" } }), headers: JSON_HEADERS });
        expect(fresh.status, fresh.text).toBe(201);
        const step = await putStep(w.deps, mine.token, fresh.json.upload_id, 1, stepImage(manifestOf([800], "x").steps[0], 3));
        expect(step.status, step.text).toBe(204);
        const committed = await commit(w.deps, mine.token, fresh.json.upload_id);
        expect(committed.status, committed.text).toBe(201);
        const answers: Call[] = [];
        for (const json of [{ ...item, title: `${mine.name} restricted item`, access: "people", viewers: listed }, { ...item, title: `${mine.name} item for me`, access: "me" }]) {
          w.tick();
          answers.push(await fire(w.deps, { method: "POST", path: "/api/v1/media", json }, credential.of(mine)));
          expect(answers.at(-1)!.status, `${what}: ${answers.at(-1)!.text}`).toBe(201);
        }
        w.tick();
        answers.push(await fire(w.deps, { method: "POST", path: tourPath(committed.json.tour_id, "/publish"), json: { access: "people", viewers: listed } }, credential.of(mine)));
        expect(answers.at(-1)!.status, `${what}: ${answers.at(-1)!.text}`).toBe(200);
        expect(answers.at(-1)!.json).toMatchObject({ access: "people", viewers: 2 });
        expect(await snapshotOf(w.deps, theirs, w.keys), `${what} changed something of ${theirs.name}`).toEqual(before);
        // The addresses went on the caller's own lists, and no answer names anything of the other workspace.
        expect((await w.deps.db.all<{ n: number }>("SELECT count(*) AS n FROM tour_viewer WHERE tour_id = ?", [committed.json.tour_id]))[0].n).toBe(2);
        for (const r of answers) for (const n of [...namesIn(theirs.ids), ...listed]) expect(r.text.includes(n), `${what} told ${n}`).toBe(false);
      }
    }
  });

  it("billing is the workspace's own: neither can read, start or change the other's, a checkout id of the other answers as one that never existed, and a notice for one changes nothing of the other", SLOW, async () => {
    const w = await build();
    const stripe = w.deps.stripe as FakeStripe;
    const state = (side: Side, query = "") => fire(w.deps, { method: "GET", path: `/api/v1/billing${query}` }, BY_SESSION.of(side));
    const checkoutOf = async (side: Side) => (await w.deps.db.first<{ c: string | null }>("SELECT checkout_session_id AS c FROM workspace WHERE id = ?", [side.workspaceId]))!.c;
    for (const [mine, theirs] of directions(w)) {
      const before = await snapshotOf(w.deps, theirs, w.keys);
      w.tick();
      const started = await fire(w.deps, { method: "POST", path: "/api/v1/billing/checkout" }, BY_SESSION.of(mine));
      expect(started.status, started.text).toBe(200);
      expect(await checkoutOf(mine)).toMatch(/^cs_test_/);
      // Manage subscription without a customer of its own: refused, whatever the other has.
      expect((await fire(w.deps, { method: "POST", path: "/api/v1/billing/portal" }, BY_SESSION.of(mine))).status).toBe(409);
      expect(await snapshotOf(w.deps, theirs, w.keys), `${mine.name}'s Subscribe changed something of ${theirs.name}`).toEqual(before);
      const own = (await state(mine)).text;
      for (const n of namesIn(theirs.ids)) expect(own.includes(n), n).toBe(false);
    }
    // The other workspace's checkout id answers byte for byte as an id that never existed, and Stripe is not asked.
    for (const [mine, theirs] of directions(w)) {
      const calls = stripe.calls.length;
      const theirsAnswer = await state(mine, `?session_id=${await checkoutOf(theirs)}`);
      const never = await state(mine, "?session_id=cs_test_never");
      expect(seen(theirsAnswer)).toEqual(seen(never));
      expect(stripe.calls.length).toBe(calls);
    }
    // B pays. A notice of B's checkout, customer and subscription changes nothing of A, and A's portal never reaches B's customer.
    const aBefore = await snapshotOf(w.deps, w.a, w.keys);
    stripe.subscription("sub_ISO_B", "cus_ISO_B", "active");
    const checkoutB = await checkoutOf(w.b);
    expect((await notify(w.deps, eventOf("checkout.session.completed", { id: checkoutB, client_reference_id: w.b.workspaceId, customer: "cus_ISO_B", subscription: "sub_ISO_B", payment_status: "paid" }))).status).toBe(200);
    // A's own checkout completing with B's reference, or with B's customer, is ignored: B is untouched,
    // and of A only its audit record gains the two refusals (it is A's own checkout).
    const bPaid = await snapshotOf(w.deps, w.b, w.keys);
    const aRow = await w.deps.db.first("SELECT * FROM workspace WHERE id = ?", [w.a.workspaceId]);
    stripe.subscription("sub_ISO_X", "cus_ISO_B", "active");
    const checkoutA = await checkoutOf(w.a);
    await notify(w.deps, eventOf("checkout.session.completed", { id: checkoutA, client_reference_id: w.b.workspaceId, customer: "cus_ISO_B", subscription: "sub_ISO_X", payment_status: "paid" }));
    await notify(w.deps, eventOf("checkout.session.completed", { id: checkoutA, client_reference_id: w.a.workspaceId, customer: "cus_ISO_B", subscription: "sub_ISO_X", payment_status: "paid" }));
    expect(await snapshotOf(w.deps, w.b, w.keys)).toEqual(bPaid);
    expect(await w.deps.db.first("SELECT * FROM workspace WHERE id = ?", [w.a.workspaceId])).toEqual(aRow);
    expect((await w.deps.db.all<{ detail: string }>("SELECT detail FROM audit WHERE event = 'billing_checkout_mismatch' AND workspace_id = ? ORDER BY rowid", [w.a.workspaceId])).map((r) => r.detail)).toEqual(['{"reason":"reference_differs","paid":1}', '{"reason":"customer_taken","paid":1}']);
    const aAfterOwn = await snapshotOf(w.deps, w.a, w.keys);
    stripe.subscription("sub_ISO_B", "cus_ISO_B", "past_due");
    stripe.charges.set("ch_ISO", { id: "ch_ISO", customer: "cus_ISO_B" });
    for (const e of [
      eventOf("customer.subscription.updated", { id: "sub_ISO_B", customer: "cus_ISO_B" }),
      eventOf("invoice.payment_failed", { id: "in_ISO", customer: "cus_ISO_B" }),
      eventOf("charge.dispute.created", { id: "dp_ISO", charge: "ch_ISO" }),
    ]) expect((await notify(w.deps, e)).status).toBe(200);
    expect(await snapshotOf(w.deps, w.a, w.keys), "a notice of B's changed something of A").toEqual(aAfterOwn);
    expect(aBefore.rows.workspace).toEqual(aAfterOwn.rows.workspace);
    expect((await w.deps.db.first<{ s: string }>("SELECT subscription_status AS s FROM workspace WHERE id = ?", [w.b.workspaceId]))!.s).toBe("past_due");
    expect((await fire(w.deps, { method: "POST", path: "/api/v1/billing/portal" }, BY_SESSION.of(w.a))).status).toBe(409);
    expect(stripe.to("/v1/billing_portal/sessions").every((c) => !JSON.stringify(c.form).includes("cus_ISO_B"))).toBe(true);
    expect(w.writes()).toEqual([]);
  });

  it("an agreement to the site's terms is the account's own: agreeing changes nothing of the other workspace, and neither can read or make the other's", SLOW, async () => {
    const w = await build();
    const read = await parseTerms(new TextEncoder().encode("title: Terms\nversion: 1\nmain points:\n- One.\nterms:\nThe terms.\n"));
    if (!read.ok) throw new Error(read.reason);
    const published = await publishTerms(w.deps, read);
    if (!published.ok) throw new Error("not published");
    for (const [mine, theirs] of directions(w)) {
      const before = await snapshotOf(w.deps, theirs, w.keys);
      w.tick();
      // By token: nobody. By session: the caller's own account only, whatever the body adds.
      expect((await fire(w.deps, { method: "POST", path: "/api/v1/terms/agree", json: { terms: published.id } }, BY_TOKEN.of(mine))).status).toBe(401);
      expect((await fire(w.deps, { method: "POST", path: "/api/v1/terms/agree", json: { terms: published.id, user_id: theirs.userId } }, BY_SESSION.of(mine))).status).toBe(400);
      expect((await fire(w.deps, { method: "POST", path: "/api/v1/terms/agree", json: { terms: published.id } }, BY_SESSION.of(mine))).status).toBe(204);
      expect(await snapshotOf(w.deps, theirs, w.keys), `${mine.name}'s agreement changed something of ${theirs.name}`).toEqual(before);
      const mineState = (await fire(w.deps, { method: "GET", path: "/api/v1/terms" }, BY_SESSION.of(mine))).json;
      expect(mineState.agreed.terms_id).toBe(published.id);
      for (const n of [theirs.userId, theirs.email, theirs.session.csrf, theirs.session.id]) expect(JSON.stringify(mineState), n).not.toContain(n);
    }
    // Each agreed for itself, once; the admin's list shows each account's version and date only.
    const rows = await w.deps.db.all<{ user_id: string }>("SELECT user_id FROM terms_agreement ORDER BY user_id");
    expect(rows.map((r) => r.user_id).sort()).toEqual([w.a.userId, w.b.userId].sort());
    const list = await fire(w.deps, { method: "GET", path: "/api/v1/admin/accounts" }, BY_SESSION.of(w.a));
    for (const account of list.json.accounts) expect(Object.keys(account.terms).sort()).toEqual(["agreed_at", "current", "version"]);
    expect(list.text).not.toContain(published.id);
    expect(w.writes()).toEqual([]);
  });

  it("changing an email address reaches nothing of the other workspace: its address answers as a free one, its code as one that never existed", SLOW, async () => {
    // A site that can mail links: two addresses, the fake mailer.
    const ctx = await makeDeps({ hosts: HOSTS });
    const w = await world(ctx.deps, { draftKeys: ctx.draftKeys, publicKeys: ctx.publicKeys });
    const { deps } = w;
    const exercised = new Set<string>();
    const request = async (key: string, side: Side, json: unknown, credential: Credential = BY_SESSION.of(side)) => {
      exercised.add(key);
      return fire(deps, { method: "POST", path: SELF[key].path, json }, credential, APP);
    };
    const free = { status: 200, body: '{"ok":true}' };
    for (const [mine, theirs] of directions(w)) {
      const before = await snapshotOf(deps, theirs, w.keys);
      ctx.mail.sent.length = 0;
      w.tick();
      // Their address answers what a free address answers, and nothing is stored or sent.
      const asked = await request("POST /api/v1/account/email", mine, { email: theirs.email });
      // Nor later: asking for their address ended the caller's own open change exactly as a free
      // address would, so confirming that change says nothing of whose the address is.
      const mineEnded = await request("POST /api/v1/account/email/confirm", mine, { code: mine.emailCode });
      const neverBefore = await request("POST /api/v1/account/email/confirm", mine, { code: "dpe_" + "1".repeat(40) });
      expect(mineEnded.status, mineEnded.text).toBe(400);
      expect(seen(mineEnded)).toEqual(seen(neverBefore));
      const nobodys = await request("POST /api/v1/account/email", mine, { email: `nobody-${mine.name.toLowerCase()}@example.com` });
      expect({ status: asked.status, body: asked.text }).toEqual(free);
      expect(seen(asked)).toEqual(seen(nobodys));
      expect(ctx.mail.sent.map((m) => m.to)).toEqual([`nobody-${mine.name.toLowerCase()}@example.com`]);
      // Their open change's code: the refusal of a code that never existed, byte for byte.
      const theirCode = await request("POST /api/v1/account/email/confirm", mine, { code: theirs.emailCode });
      const neverCode = await request("POST /api/v1/account/email/confirm", mine, { code: "dpe_" + "0".repeat(40) });
      expect(theirCode.status).toBe(400);
      expect(seen(theirCode)).toEqual(seen(neverCode));
      // By token: nobody, for both.
      for (const key of SELF_CHANGES) expect((await request(key, mine, { email: theirs.email, code: theirs.emailCode }, BY_TOKEN.of(mine))).status, key).toBe(401);
      expect(await snapshotOf(deps, theirs, w.keys), `${mine.name} changed something of ${theirs.name}`).toEqual(before);
    }
    // The routes are not refused for everyone. Each side's request for a free address above
    // replaced its open change, so its old code no longer works; the code mailed for the new
    // one works for it, and changes nothing of the other side.
    const before = await snapshotOf(deps, w.b, w.keys);
    const replaced = await request("POST /api/v1/account/email/confirm", w.a, { code: w.a.emailCode });
    expect(replaced.status, replaced.text).toBe(400);
    const code = (ctx.mail.sent.at(-1)?.text.match(/dpe_[0-9a-f]{40}/) ?? [""])[0];
    const own = await request("POST /api/v1/account/email/confirm", w.a, { code });
    expect(own.status, own.text).toBe(200);
    expect(own.json).toEqual({ email: "nobody-alpha@example.com", previous_email: w.a.email });
    expect(await snapshotOf(deps, w.b, w.keys)).toEqual(before);
    expect([...exercised].sort()).toEqual([...SELF_CHANGES].sort());
    expect(w.writes()).toEqual([]);
  });

  it("a connection is the confirming workspace's alone: the other cannot look it up, settle it or revoke its token, and the token reaches nothing of the other", SLOW, async () => {
    const w = await build();
    const { deps } = w;
    const app = (path: string, json: unknown, credential: Credential = { token: null }) => fire(deps, { method: "POST", path, json }, credential);
    expect(Object.keys(CONNECT).sort()).toEqual(["POST /api/v1/connect/start", "POST /api/v1/connect/token"]);
    for (const [mine, theirs] of directions(w)) {
      const before = await snapshotOf(deps, theirs, w.keys);
      w.tick(POLL_GAP_MS);
      // The app starts a request, with no credential: one that sends one is refused, and nothing is stored.
      for (const credential of [BY_TOKEN.of(mine), BY_SESSION.of(mine), BY_TOKEN.of(theirs)]) {
        for (const path of Object.keys(CONNECT).map((k) => k.split(" ")[1])) {
          const refused = await app(path, { device_name: "x", device_code: "dpd_" + "0".repeat(40) }, credential);
          expect([refused.status, refused.json.error], path).toEqual([400, "credentials_not_allowed"]);
        }
      }
      const started = await app("/api/v1/connect/start", { device_name: `${mine.name} new laptop` });
      expect(started.status, started.text).toBe(201);
      const code = started.json.user_code as string;
      // The caller confirms it; then the other workspace finds nothing and changes nothing.
      expect((await fire(deps, { method: "POST", path: "/api/v1/connect/confirm", json: { user_code: code } }, BY_SESSION.of(mine))).status).toBe(204);
      for (const req of [
        { method: "POST", path: "/api/v1/connect/lookup", json: { user_code: code } },
        { method: "POST", path: "/api/v1/connect/confirm", json: { user_code: code } },
        { method: "POST", path: "/api/v1/connect/refuse", json: { user_code: code } },
      ]) {
        const r = await fire(deps, req, BY_SESSION.of(theirs));
        expect({ status: r.status, body: r.json }, `${req.method} ${req.path} by ${theirs.name}`).toEqual(NO_REQUEST);
      }
      const confirmed = await deps.db.first<{ workspace_id: string; confirmed_by: string; refused_at: number | null }>("SELECT workspace_id, confirmed_by, refused_at FROM connect_request WHERE device_name = ?", [`${mine.name} new laptop`]);
      expect(confirmed).toEqual({ workspace_id: mine.workspaceId, confirmed_by: mine.userId, refused_at: null });

      // The app collects the token: the caller's workspace's, and nothing of the other's.
      const got = await app("/api/v1/connect/token", { device_code: started.json.device_code });
      expect(got.json.status, got.text).toBe("connected");
      expect(got.json.workspace).toEqual({ id: mine.workspaceId, name: mine.workspaceName });
      const token = got.json.token as string;
      const tours = await send(deps, "GET", "/api/v1/tours", { token });
      expect(tours.json.tours.map((t: Json) => t.id).sort()).toEqual([mine.ids.published.tour, mine.ids.draft.tour, mine.ids.publishing.tour, mine.ids.restricted.tour, mine.ids.switching.tour].sort());
      for (const n of namesIn(theirs.ids)) expect(tours.text.includes(n), n).toBe(false);
      expect((await send(deps, "PATCH", tourPath(theirs.ids.draft.tour), { token, body: JSON.stringify({ title: "Taken over" }), headers: JSON_HEADERS })).json).toEqual(NO_TOUR.body);
      // The other workspace can neither see the token in its list nor revoke or rename it; the caller sees it.
      const tokenId = (await deps.db.first<{ id: string }>("SELECT id FROM api_token WHERE hash = ?", [await hashToken(token)]))!.id;
      const theirList = await fire(deps, { method: "GET", path: "/api/v1/tokens" }, BY_SESSION.of(theirs));
      expect(theirList.text.includes(tokenId)).toBe(false);
      expect((await fire(deps, { method: "GET", path: "/api/v1/tokens" }, BY_SESSION.of(mine))).text).toContain(tokenId);
      expect((await fire(deps, { method: "DELETE", path: `/api/v1/tokens/${tokenId}` }, BY_SESSION.of(theirs))).json).toEqual(NO_TOKEN.body);
      expect((await fire(deps, { method: "PATCH", path: `/api/v1/tokens/${tokenId}`, json: { name: "Mine now" } }, BY_SESSION.of(theirs))).json).toEqual(NO_TOKEN.body);
      expect((await send(deps, "GET", "/api/v1/me", { token })).json.workspace).toBe(mine.workspaceName);
      // Nothing of the other workspace changed.
      expect(await snapshotOf(deps, theirs, w.keys), `connecting ${mine.name} changed something of ${theirs.name}`).toEqual(before);
    }
  });

  it("an accepted invite's workspace is new and separate from every other, and its account reaches nothing of either workspace", SLOW, async () => {
    const w = await build();
    const { deps, a, b } = w;
    expect(Object.keys(INVITE).sort()).toEqual(["POST /api/v1/invite/accept", "POST /api/v1/invite/check"]);
    const invite = (path: string, json: unknown, credential: Credential = { token: null }) => fire(deps, { method: "POST", path, json, headers: { origin: ORIGIN, "user-agent": "Mozilla/5.0 Firefox/132.0" } }, credential);
    const before = { a: await snapshotOf(deps, a, w.keys), b: await snapshotOf(deps, b, w.keys) };
    // Any credential is refused, the inviting admin's own too, and nothing is made.
    for (const [credential, code] of [[BY_TOKEN.of(a), 400], [BY_TOKEN.of(b), 400], [BY_SESSION.of(a), 409], [BY_SESSION.of(b), 409]] as const) {
      for (const path of Object.keys(INVITE).map((k) => k.split(" ")[1])) {
        w.tick();
        const refused = await invite(path, { code: w.invite.code, username: "newcomer" }, credential);
        expect([refused.status, refused.json.error], path).toEqual([code, code === 400 ? "credentials_not_allowed" : "signed_in"]);
      }
    }
    expect(await deps.db.first("SELECT count(*) AS n FROM invite")).toEqual({ n: 1 });
    // The look-up answers the address and the inviter, nothing of the inviter's workspace.
    const looked = await invite("/api/v1/invite/check", { code: w.invite.code });
    expect(Object.keys(looked.json).sort()).toEqual(["email", "expires_at", "invited_by"]);
    for (const n of namesIn(a.ids)) expect(looked.text.includes(n), n).toBe(false);
    for (const n of [a.workspaceId, a.workspaceName, a.email, a.userId]) expect(looked.text.includes(n), n).toBe(false);

    const accepted = await invite("/api/v1/invite/accept", { code: w.invite.code, username: "newcomer" });
    expect(accepted.status, accepted.text).toBe(200);
    const secret = /^__Host-dp_session=(dps_[0-9a-f]{64});/.exec(accepted.headers.getSetCookie()[0] ?? "")?.[1] ?? "";
    const made = (await deps.db.first<{ id: string; is_admin: number; workspace_id: string }>("SELECT u.id, u.is_admin, m.workspace_id FROM user u JOIN membership m ON m.user_id = u.id WHERE u.email = ?", [w.invite.email]))!;
    // A new workspace of its own: neither side's, the only member its own account, no admin flag, no allowance of its own.
    expect([a.workspaceId, b.workspaceId]).not.toContain(made.workspace_id);
    expect(made.is_admin).toBe(0);
    expect(await deps.db.all("SELECT user_id FROM membership WHERE workspace_id = ?", [made.workspace_id])).toEqual([{ user_id: made.id }]);
    expect(await deps.db.first("SELECT storage_allowance_bytes FROM workspace WHERE id = ?", [made.workspace_id])).toEqual({ storage_allowance_bytes: null });
    expect(await deps.db.first("SELECT count(*) AS n FROM membership WHERE user_id = ?", [made.id])).toEqual({ n: 1 });
    expect(await snapshotOf(deps, a, w.keys)).toEqual(before.a);
    expect(await snapshotOf(deps, b, w.keys)).toEqual(before.b);

    // The new account's session, against every case of each side: each side's ids answer
    // exactly as ids that never existed, and nothing of either side changes.
    const newcomer: Credential = { token: null, headers: { cookie: `${SESSION_COOKIE}=${secret}`, "x-csrf-token": await csrfFor(secret), "sec-fetch-site": "same-origin" }, page: true };
    const mine = inventedIds();
    for (const theirs of [a, b]) {
      const real = everyCase(theirs.ids, mine);
      const invented = everyCase(inventedIds(theirs.ids), mine);
      expect(real.length).toBeGreaterThan(40);
      for (let i = 0; i < real.length; i++) {
        w.tick();
        const what = label(real[i].key, real[i].req, "the new account's session", theirs);
        const answer = await fire(deps, real[i].req, newcomer);
        expect(seen(answer), what).toEqual(seen(await fire(deps, invented[i].req, newcomer)));
        expect(answer.status, what).toBeGreaterThanOrEqual(204);
      }
    }
    expect(w.writes()).toEqual([]);
    expect(await snapshotOf(deps, a, w.keys)).toEqual(before.a);
    expect(await snapshotOf(deps, b, w.keys)).toEqual(before.b);
    // Its lists hold nothing of either side, and its session is no admin's.
    const needles = [...needlesOf(before.a, [a.token, a.workspaceName, a.email]), ...needlesOf(before.b, [b.token, b.workspaceName, b.email])].filter((n) => n !== "First token");
    for (const [key, list] of Object.entries(LISTS)) {
      if (list.only === "token") continue;
      const r = await fire(deps, { method: "GET", path: list.path }, newcomer);
      expect(r.status, key).toBe(200);
      for (const n of needles) expect(r.text.includes(n), `${key} told the new account ${n}`).toBe(false);
    }
    for (const [key, entry] of Object.entries(ADMIN)) expect((await fire(deps, entry.request(w), newcomer)).text, key).toBe('{"error":"not_found"}');
  });

  it("an upload cannot target another workspace's tour or chapter", SLOW, async () => {
    const w = await build();
    const { deps, a, b } = w;
    const before = await snapshotOf(deps, a, w.keys);
    const uploadsOfB = async () => (await snapshotOf(deps, b, w.keys)).rows.upload.length;
    const had = await uploadsOfB();
    // Every way of naming the other's tour or chapter in a create leaves no upload behind.
    for (const req of BODY_IDS["POST /api/v1/uploads"](a.ids, b.ids)) {
      for (const credential of CREDENTIALS) {
        expectAnswer(await fire(deps, req, credential.of(b)), req, `${req.what} (by ${credential.name})`, credential.name);
        expect(await uploadsOfB(), req.what).toBe(had);
      }
    }

    // A hash reaches only the pictures of the chapter being replaced, and that chapter is the
    // caller's own. The second workspace replaces its own chapter with pictures of exactly
    // the type, size and length of the first's, and says it has the first's hashes.
    const target = { kind: "replace", tour_id: b.ids.draft.tour, chapter_id: b.ids.draft.chapter };
    const manifest = manifestOf(a.ids.pictures.draft.map((s) => s.bytes), "Bravo draft tour");
    const withTheirs = await createReplace(deps, b.token, manifest, target, a.ids.draft.sha256);
    const withNobodys = await createReplace(deps, b.token, manifest, target, inventedIds().draft.sha256);
    // Nothing is reused, and the answer is the one for hashes no picture has: it tells nothing.
    expect(withTheirs.status).toBe(201);
    expect(withTheirs.json).toEqual({ upload_id: expect.stringMatching(/^up_[0-9a-f]{24}$/), steps: 2, have: [], settings: true });
    expect({ ...withNobodys.json, upload_id: "" }).toEqual({ ...withTheirs.json, upload_id: "" });
    expect(seen(withNobodys).headers).toEqual(seen(withTheirs).headers);
    expect(await deps.db.all("SELECT * FROM upload_step WHERE upload_id IN (?, ?)", [withTheirs.json.upload_id, withNobodys.json.upload_id])).toEqual([]);
    // Its own pictures are found by hash, so the reuse does work; only never across workspaces.
    const mixed = manifestOf([a.ids.pictures.draft[0].bytes, b.ids.pictures.draft[1].bytes], "Bravo draft tour");
    const own = await createReplace(deps, b.token, mixed, target, [a.ids.draft.sha256[0], b.ids.draft.sha256[1]]);
    expect(own.json).toMatchObject({ have: [2] });

    // It then sends the very bytes the first workspace stored and commits. Its steps name
    // files under its own upload, never the first's, although the bytes are the same.
    const id = withTheirs.json.upload_id as string;
    for (const n of [1, 2]) expect((await putStep(deps, b.token, id, n, stepImage(manifest.steps[n - 1], a.ids.fill))).status).toBe(204);
    expect((await commit(deps, b.token, id)).status).toBe(201);
    const steps = await deps.db.all<{ image_key: string; sha256: string }>("SELECT image_key, sha256 FROM step WHERE chapter_id = ? ORDER BY position", [b.ids.draft.chapter]);
    expect(steps.map((s) => s.sha256)).toEqual(a.ids.draft.sha256);
    for (const s of steps) expect(s.image_key.startsWith(`u/${id}/`), s.image_key).toBe(true);
    const theirKeys = Object.keys(before.files);
    for (const row of await deps.db.all<Json>("SELECT * FROM upload_step WHERE upload_id IN (SELECT id FROM upload WHERE workspace_id = ?)", [b.workspaceId])) {
      expect(theirKeys).not.toContain(row.image_key);
    }
    expect(await snapshotOf(deps, a, w.keys)).toEqual(before);
  });

  it("on a site with two addresses every case answers the same on the tours address and on the app address", SLOW, async () => {
    const w = await build({ hosts: HOSTS });
    const everyUse = [w.a.tokenId, w.b.tokenId, w.a.session.id, w.b.session.id];
    const start = await dumpOf(w.deps, w.keys, { files: true, touched: everyUse });
    // The fixed name every workspace's first token has tells nothing, and the token list holds it for both.
    const needles = needlesOf(await snapshotOf(w.deps, w.a, w.keys), [w.a.token, w.a.workspaceName, w.a.email, w.a.session.secret, w.a.session.csrf]).filter((n) => n !== "First token");
    for (const origin of [TOURS, APP]) {
      for (const [mine, theirs] of directions(w)) {
        const real = everyCase(theirs.ids, mine.ids);
        const invented = everyCase(inventedIds(theirs.ids), mine.ids);
        for (const credential of CREDENTIALS) {
          for (let i = 0; i < real.length; i++) {
            w.tick();
            const what = `${label(real[i].key, real[i].req, credential.name, mine)} on ${origin}`;
            const r = await fire(w.deps, real[i].req, credential.of(mine), origin);
            // A session counts on the app address only: on the tours address it is nobody.
            expectAnswer(r, real[i].req, what, credential.name, origin === TOURS);
            expect(seen(r), what).toEqual(seen(await fire(w.deps, invented[i].req, credential.of(mine), origin)));
          }
        }
      }
    }
    expect(w.writes()).toEqual([]);
    expect(await dumpOf(w.deps, w.keys, { files: true, touched: everyUse })).toEqual(start);
    // The lists last: listing tours also clears the caller's own replaced pictures.
    for (const origin of [TOURS, APP]) {
      for (const [key, list] of Object.entries(LISTS)) {
        for (const credential of CREDENTIALS) {
          if (list.only !== undefined && list.only !== credential.name) continue;
          const what = `${key} by ${credential.name} on ${origin}`;
          const r = await fire(w.deps, { method: "GET", path: list.path }, credential.of(w.b), origin);
          // The session's own routes are not on the tours address at all, and a session there is nobody.
          const status = origin === APP ? 200 : list.only === "session" ? 404 : credential.name === "session" ? 401 : 200;
          expect(r.status, what).toBe(status);
          for (const n of needles) expect(r.text.includes(n), `${what} told the second workspace ${n} of the first`).toBe(false);
        }
      }
    }
  });
});

describe("a caller that is nobody", () => {
  const UNAUTHORIZED = { status: 401, headers: [["content-type", "application/json"]], body: '{"error":"unauthorized"}' };

  /** One request per route that needs a caller, each naming the caller's own data: a valid token would be answered with it. */
  function ownRequests(side: Side): { key: string; req: Req | Sample }[] {
    const lists = Object.entries(LISTS).map(([key, list]) => ({ key, req: { method: "GET", path: list.path } as Sample }));
    const creates = Object.entries(CREATES).map(([key, entry]) => ({ key, req: entry.sample(side) }));
    return [...everyCase(side.ids, side.ids), ...lists, ...creates];
  }

  it("a revoked token and a malformed one get 401 everywhere", SLOW, async () => {
    const w = await build();
    const { deps, a } = w;
    const before = await dumpOf(deps, w.keys, { files: true });
    const unknown = newToken();
    const headers: [string, string | null][] = [
      ["no Authorization header", null],
      ["the revoked token", `Bearer ${a.revokedToken}`],
      ["a token nobody was given", `Bearer ${unknown}`],
      ["the token in capitals", `Bearer ${a.token.toUpperCase()}`],
      ["the token with a character more", `Bearer ${a.token}0`],
      ["the token with a character less", `Bearer ${a.token.slice(0, -1)}`],
      ["the token without its prefix", `Bearer ${a.token.slice(3)}`],
      ["the token after two spaces", `Bearer  ${a.token}`],
      ["the token as a Basic credential", `Basic ${a.token}`],
      ["the bare token", a.token],
      ["two tokens", `Bearer ${a.token}, Bearer ${w.b.token}`],
      ["the stored hash of the token", `Bearer ${await hashToken(a.token)}`],
      ["the token's id", `Bearer ${a.tokenId}`],
      ["the workspace's id", `Bearer ${a.workspaceId}`],
    ];
    const requests = ownRequests(a);
    expect(new Set(requests.map((r) => r.key))).toEqual(new Set([...Object.keys(CASES), ...Object.keys(BODY_IDS), ...Object.keys(LISTS), ...Object.keys(CREATES)]));
    for (const [what, value] of headers) {
      for (const { key, req } of requests) {
        w.tick();
        const r = await fire(deps, req, { token: null, headers: value === null ? {} : { authorization: value } });
        expect(seen(r), `${key} with ${what}`).toEqual(UNAUTHORIZED);
      }
      // Not even the record of a token's last use: nobody was there.
      expect(w.writes(), what).toEqual([]);
      expect(await dumpOf(deps, w.keys), what).toEqual({ rows: before.rows, drafts: before.drafts, public: before.public });
    }
    expect(await dumpOf(deps, w.keys, { files: true })).toEqual(before);
    // The same requests with the token itself are answered: the 401s were about the credential.
    expect((await send(deps, "GET", "/api/v1/tours", { token: a.token })).status).toBe(200);
  });

  it("a signed-out session, and a cookie that is no session, get 401 everywhere", SLOW, async () => {
    const w = await build();
    const { deps, a } = w;
    const live = BY_SESSION.of(a);
    // The side's session ends, as signing out ends it; its other session stays live.
    await deps.db.run("UPDATE session SET revoked_at = ? WHERE id = ?", [deps.now(), a.session.id]);
    const before = await dumpOf(deps, w.keys, { files: true });
    const nobody = "dps_" + "0".repeat(64);
    // Each with the anti-forgery value its cookie would have, so only the cookie is wrong.
    const cookies: [string, string, string][] = [
      ["the signed-out session", a.session.cookie, a.session.csrf],
      ["a session nobody was given", `${SESSION_COOKIE}=${nobody}`, await csrfFor(nobody)],
      ["the session's id as the cookie", `${SESSION_COOKIE}=${a.session.id}`, a.session.csrf],
      ["the session in capitals", `${SESSION_COOKIE}=${a.session.secret.toUpperCase()}`, a.session.csrf],
      ["the session twice", `${a.session.cookie}; ${a.session.cookie}`, a.session.csrf],
    ];
    const requests = ownRequests(a);
    for (const [what, cookie, csrf] of cookies) {
      for (const { key, req } of requests) {
        w.tick();
        const r = await fire(deps, req, { token: null, headers: { cookie, "x-csrf-token": csrf, "sec-fetch-site": "same-origin" }, page: true });
        expect(seen(r), `${key} with ${what}`).toEqual(UNAUTHORIZED);
      }
      expect(w.writes(), what).toEqual([]);
      expect(await dumpOf(deps, w.keys), what).toEqual({ rows: before.rows, drafts: before.drafts, public: before.public });
    }
    expect(await dumpOf(deps, w.keys, { files: true })).toEqual(before);
    // The same request with a live session of the other workspace is answered: the 401s were about the cookie.
    expect((await fire(deps, { method: "GET", path: "/api/v1/tours" }, BY_SESSION.of(w.b))).status).toBe(200);
    expect((await fire(deps, { method: "GET", path: "/api/v1/tours" }, live)).status).toBe(401);
  });

  // The token lookup does not yet look at the owner's status: `requireAuth` gains that
  // condition with sessions (Task 9, src/auth.ts). Until then this test is expected to fail,
  // and vitest reports it as failing the build the moment it passes: then change `it.fails`
  // to `it`. Nothing can disable an account before that task either.
  it("a token of a disabled owner's workspace gets 401 everywhere", SLOW, async () => {
    const w = await build();
    const { deps, a } = w;
    await deps.db.run("UPDATE user SET status = 'disabled' WHERE id = ?", [a.userId]);
    const before = await dumpOf(deps, w.keys);
    for (const credential of CREDENTIALS) {
      for (const { key, req } of ownRequests(a)) {
        const r = await fire(deps, req, credential.of(a));
        expect(seen(r), `${key} by ${credential.name}`).toEqual(UNAUTHORIZED);
      }
    }
    expect(w.writes()).toEqual([]);
    expect(await dumpOf(deps, w.keys)).toEqual(before);
    // The other workspace is not disabled with it, by either credential.
    expect((await send(deps, "GET", "/api/v1/tours", { token: w.b.token })).status).toBe(200);
    expect((await fire(deps, { method: "GET", path: "/api/v1/tours" }, BY_SESSION.of(w.b))).status).toBe(200);
  });
});

describe("routes with no owner", () => {
  it("an open route answers everyone the same, reads no credential and shows only what was published", SLOW, async () => {
    const w = await build({ setupCode: SETUP_CODE });
    const { deps, a, b } = w;
    // Asking for a sign-in link counts the request in the site's own sign-in counters,
    // whoever asks; they (and the pad counter the sign-in job keeps) belong to no workspace (SHARED), and only they are left out here.
    const signInBuckets: string[] = [...Object.values(LIMITS_SIGNIN).map((limit) => limit.bucket), PAD_BUCKET];
    const look = async (files: boolean) => {
      const d = await dumpOf(deps, w.keys, { files });
      d.rows.rate_counter = (d.rows.rate_counter ?? []).filter((row) => !signInBuckets.includes(row.bucket as string));
      return d;
    };
    const before = await look(true);
    const callers: [string, Credential][] = [
      ["nobody", { token: null }],
      ["the owner", { token: a.token }],
      ["the other workspace", { token: b.token }],
      ["a revoked token", { token: a.revokedToken }],
      ["the owner's session", BY_SESSION.of(a)],
      ["the other workspace's session", BY_SESSION.of(b)],
    ];
    const statuses: Record<string, number[]> = {};
    for (const [key, entry] of Object.entries(OPEN)) {
      const samples = entry.samples(w);
      expect(samples.length, key).toBeGreaterThan(0);
      statuses[key] = [];
      for (const sample of samples) {
        w.tick();
        const first = await fire(deps, sample, callers[0][1]);
        statuses[key].push(first.status);
        // For a route that answers by whether a cookie is sent, the first caller with one sets that answer.
        let firstWithCookie: Call | null = null;
        for (const [who, credential] of callers.slice(1)) {
          const answer = await fire(deps, sample, credential);
          if (entry.byCookie === true && credential.headers?.cookie !== undefined) {
            firstWithCookie ??= answer;
            expect(seen(answer), `${key} ${sample.path} for ${who}`).toEqual(seen(firstWithCookie));
          } else expect(seen(answer), `${key} ${sample.path} for ${who}`).toEqual(seen(first));
        }
        if (entry.byCookie === true) {
          expect([first.status, first.headers.get("location"), first.calls], `${key} without a cookie`).toEqual([302, "/signin", 0]);
          expect([firstWithCookie?.status, firstWithCookie?.headers.get("location"), firstWithCookie?.calls], `${key} with a cookie`).toEqual([302, "/tours", 0]);
        }
      }
    }
    // No token or session was looked at (none records a use), nothing was claimed and nothing stored.
    expect(w.writes()).toEqual([]);
    expect(await look(true)).toEqual(before);

    // What each answers: the wizard is closed on a site that has workspaces; a tour page and
    // a picture answer only for what is live (or retired and inside its grace).
    for (const key of Object.keys(OPEN).filter((k) => k.includes(" /setup"))) expect(statuses[key], key).toEqual([404]);
    // The restricted tour answers its fixed gate page (403) to every caller here: none has a viewer cookie.
    expect(statuses["GET /t/:slug"]).toEqual([200, 404, 404, 404, 403, 404]);
    expect(statuses["GET /t/:slug/v/:name"]).toEqual([404, 404, 404, 404, 404, 404]);
    expect(statuses["GET /view/signout/:slug"]).toEqual([200]);
    expect(statuses["GET /p/:name"]).toEqual([200, 200, 404, 404, 404, 404]);
    // A code nobody was given gets the one refusal of a sign-in link.
    expect(statuses["POST /api/v1/signin/complete"]).toEqual([403]);
    expect(statuses["GET /"]).toEqual([302]);
    // A shared item answers only online, by its link id and under its own letter; the image has a preview, the clip none.
    // The restricted image answers its fixed gate (403) on every one of its addresses: no caller here has a media viewer cookie.
    expect(statuses["GET /i/:name"]).toEqual([200, 200, 404, 404, 404, 404, 403, 403]);
    expect(statuses["GET /i/:name/download"]).toEqual([200, 404, 404, 403]);
    expect(statuses["GET /i/:name/preview"]).toEqual([200, 404, 404, 403]);
    expect(statuses["GET /r/:name"]).toEqual([200, 200, 404, 404, 404]);
    expect(statuses["GET /r/:name/download"]).toEqual([200, 404]);
    expect(statuses["GET /r/:name/preview"]).toEqual([404, 404]);
    for (const key of Object.keys(OPEN).filter((k) => !k.includes(" /setup") && !k.includes(":slug") && !k.includes(":name") && !k.endsWith("/signin/complete") && k !== "GET /" && k !== "POST /api/v1/billing/webhook")) for (const s of statuses[key]) expect(s, key).toBe(200);
    // Stripe's listener refuses a notice without a valid signature, whoever sends it.
    expect(statuses["POST /api/v1/billing/webhook"]).toEqual([400]);

    // A draft's link, the link of a tour whose publish has not finished, and a picture that
    // publish has already copied answer exactly as a name that never existed.
    const page = async (slug: string) => seen(await send(deps, "GET", `/t/${slug}`));
    const picture = async (name: string) => seen(await send(deps, "GET", `/p/${name}`));
    const never = inventedIds();
    expect(await page(a.ids.draft.slug)).toEqual(await page(never.draft.slug));
    expect(await page(a.ids.publishing.slug)).toEqual(await page(never.draft.slug));
    expect(await picture(a.ids.publishing.pendingName)).toEqual(await picture(never.published.publicName));
    // A tour whose switch to restricted is in progress answers as a tour that never existed,
    // and so do the live pictures of both still in the public store and the names of their
    // private ones under /p/. A restricted tour's page is the fixed gate page, nothing of it.
    expect((await page(a.ids.restricted.slug)).body).toBe(VIEW_GATE_HTML);
    expect(await page(a.ids.switching.slug)).toEqual(await page(never.draft.slug));
    for (const name of [a.ids.switching.publicName, a.ids.switching.movedName, a.ids.restricted.privateName]) expect(await picture(name)).toEqual(await picture(never.published.publicName));
    // The live page names its own public pictures: no draft file, no workspace, account or
    // token, and nothing of the other workspace. (It does carry its steps' ids, which the
    // player uses; a step id opens nothing without its workspace's credential.)
    const live = await send(deps, "GET", `/t/${a.ids.published.slug}`);
    for (const n of [a.ids.published.tour, a.ids.published.chapter, a.workspaceId, a.userId, a.email, a.token, a.tokenId, "u/up_", ...namesIn(b.ids)]) expect(live.text.includes(n), n).toBe(false);
    // A draft file is not reachable as a public picture under any of its names.
    const draftKeys = (await w.keys.draftKeys()).filter((k) => k.includes("/step-"));
    expect(draftKeys.length).toBeGreaterThan(20);
    for (const key of draftKeys.slice(0, 5)) {
      for (const path of [`/p/${key}`, `/p/${encodeURIComponent(key)}`, `/p/${key.split("/").pop()}`]) expect((await send(deps, "GET", path)).status, path).toBe(404);
    }
    // Once the owner unpublishes, the page and every picture it had are gone at once.
    expect((await send(deps, "POST", tourPath(a.ids.published.tour, "/unpublish"), { token: a.token })).status).toBeLessThan(300);
    expect(await page(a.ids.published.slug)).toEqual(await page(never.draft.slug));
    expect(await picture(a.ids.published.publicName)).toEqual(await picture(never.published.publicName));
    expect(await picture(a.ids.published.retiredName)).toEqual(await picture(never.published.publicName));
  });
});

describe("the admin routes", () => {
  /** Every key path of a JSON value, such as "accounts[].counted.pictures". */
  function keyPaths(v: unknown, at = ""): string[] {
    if (Array.isArray(v)) return v.flatMap((x) => keyPaths(x, `${at}[]`));
    if (v === null || typeof v !== "object") return [];
    return Object.entries(v).flatMap(([k, x]) => {
      const path = at === "" ? k : `${at}.${k}`;
      return [path, ...keyPaths(x, path)];
    });
  }

  /** Everything of a side an admin answer must not hold: every name of its rows and secrets but its account's id and email and its workspace's id. */
  async function forbiddenOf(w: World, side: Side): Promise<string[]> {
    const all = needlesOf(await snapshotOf(w.deps, side, w.keys), [side.token, side.revokedToken, side.workspaceName, side.session.secret, side.session.csrf, ...namesIn(side.ids)]);
    return all.filter((n) => ![side.userId, side.workspaceId, side.email].includes(n));
  }

  it("every admin route is in the ADMIN table and answers no field outside its list", SLOW, async () => {
    // A site that can mail an invite's link.
    const w = await build({ siteHost: "app.example.com" });
    const before = { a: await forbiddenOf(w, w.a), b: await forbiddenOf(w, w.b) };
    // The names are there to be found.
    for (const side of [w.a, w.b]) for (const n of [side.ids.published.tour, side.ids.published.slug, side.ids.published.publicName, side.ids.draft.step, side.token, side.session.id, side.workspaceName]) expect(before[side === w.a ? "a" : "b"]).toContain(n);
    for (const [key, entry] of Object.entries(ADMIN)) {
      w.tick();
      const r = await fire(w.deps, entry.request(w), BY_SESSION.of(w.a));
      if (entry.answers === undefined) expect(r.status, `${key}: ${r.text}`).toBe(entry.status ?? 200);
      else expect(Object.keys(entry.answers), `${key}: ${r.text}`).toContain(String(r.status));
      expect(r.headers.get("cache-control"), key).toBe("no-store");
      // Exactly the listed fields: none more, none missing.
      expect([...new Set(keyPaths(r.json))].sort(), key).toEqual([...(entry.answers?.[r.status] ?? entry.fields)].sort());
      // And no name of either workspace's content, by any of its names. The list of accounts
      // alone names each workspace, for the admin page's Workspace column.
      const named = key === "GET /api/v1/admin/accounts" ? [w.a.workspaceName, w.b.workspaceName] : [];
      for (const n of [...before.a, ...before.b]) if (!named.includes(n)) expect(r.text.includes(n), `${key} told the admin ${n}`).toBe(false);
    }
  });

  it("no caller but an admin's session reaches an admin route, and a refused call changes nothing", SLOW, async () => {
    const w = await build();
    const { deps, a, b } = w;
    const refused = { status: 404, headers: [["cache-control", "no-store"], ["content-type", "application/json"], ["x-content-type-options", "nosniff"]], body: '{"error":"not_found"}' };
    const callers: [string, Credential][] = [
      ["nobody", { token: null }],
      ["the admin's own token", BY_TOKEN.of(a)],
      ["a member's token", BY_TOKEN.of(b)],
      ["a member's session", BY_SESSION.of(b)],
      ["the admin's session with a token", { ...BY_SESSION.of(a), token: a.token }],
    ];
    const before = await dumpOf(deps, w.keys, { files: true, touched: [a.session.id, b.session.id] });
    for (const [key, entry] of Object.entries(ADMIN)) {
      for (const [who, credential] of callers) {
        w.tick();
        expect(seen(await fire(deps, entry.request(w), credential)), `${key} by ${who}`).toEqual(refused);
      }
    }
    expect(w.writes()).toEqual([]);
    expect(await dumpOf(deps, w.keys, { files: true, touched: [a.session.id, b.session.id] })).toEqual(before);
  });

  it("the admin's session is its own workspace's only, on every route that is no admin route", SLOW, async () => {
    const w = await build();
    const { deps, a, b } = w;
    // The first side's account is the site's admin, and its session says so.
    expect(await deps.db.first("SELECT is_admin FROM user WHERE id = ?", [a.userId])).toEqual({ is_admin: 1 });
    expect((await fire(deps, { method: "GET", path: "/api/v1/session" }, BY_SESSION.of(a))).json.account.admin).toBe(true);
    const look = () => dumpOf(deps, w.keys, { touched: [a.session.id, a.tokenId] });
    const before = await look();
    // Every case, with the admin's session, against the other workspace's ids and ids that never existed: the route's own not-found, byte for byte.
    const real = everyCase(b.ids, a.ids);
    const invented = everyCase(inventedIds(b.ids), a.ids);
    for (let i = 0; i < real.length; i++) {
      w.tick();
      const what = label(real[i].key, real[i].req, "session", a);
      const theirs = await fire(deps, real[i].req, BY_SESSION.of(a));
      expectAnswer(theirs, real[i].req, what, "session");
      expect(seen(theirs), what).toEqual(seen(await fire(deps, invented[i].req, BY_SESSION.of(a))));
      expect(w.writes(), what).toEqual([]);
      expect(await look(), what).toEqual(before);
    }
    // Every list and summary the admin's session gets holds nothing of the other workspace.
    const needles = needlesOf(await snapshotOf(deps, b, w.keys), [b.token, b.workspaceName, b.email, b.session.secret, b.session.csrf]).filter((n) => n !== "First token");
    for (const [key, list] of Object.entries(LISTS)) {
      if (list.only === "token") continue;
      const r = await fire(deps, { method: "GET", path: list.path }, BY_SESSION.of(a));
      expect(r.status, key).toBe(200);
      for (const n of needles) expect(r.text.includes(n), `${key} told the admin ${n} of the other workspace`).toBe(false);
    }
  });
});

describe("deleting an account", () => {
  /** The admin's request, with the first side's session. */
  const asAdmin = (w: World, method: string, path: string, json?: unknown) => fire(w.deps, { method, path, ...(json === undefined ? {} : { json }) }, BY_SESSION.of(w.a));

  it("removes every row of its workspace from every table of the schema and every file of it from both stores, and nothing of the other workspace", SLOW, async () => {
    const w = await build();
    const { deps, a, b } = w;
    expect((await asAdmin(w, "POST", `/api/v1/admin/accounts/${b.userId}/disable`)).status).toBe(204);

    // Every table of the schema, read from the database itself, says whose its rows are; a
    // table added later without that fails here as it does in the snapshot test above.
    const tables = await tablesOf(deps);
    expect(tables.filter((t) => !Object.hasOwn(OWNED, t) && !Object.hasOwn(SHARED, t))).toEqual([]);
    const beforeA = await snapshotOf(deps, a, w.keys);
    const beforeB = await snapshotOf(deps, b, w.keys);
    // The second side holds rows in most tables that belong to a workspace, and files in both stores.
    expect(Object.entries(beforeB.rows).filter(([, rows]) => rows.length > 0).map(([t]) => t).length).toBeGreaterThan(15);
    const filesB = Object.entries(beforeB.files).filter(([, v]) => v !== "missing").map(([k]) => k);
    expect(filesB.some((k) => k.startsWith("p/")) && filesB.some((k) => k.startsWith("u/")) && filesB.some((k) => k.startsWith("m/"))).toBe(true);
    // Everything that names the second side: its ids, keys, slugs, hashes, titles and address; a value the first side has too (such as a token's default name) names neither.
    const ofA = new Set(needlesOf(beforeA, [a.workspaceId, a.userId, a.email]));
    const needles = needlesOf(beforeB, [b.workspaceId, b.userId, b.email, b.session.id, ...namesIn(b.ids)]).filter((n) => !ofA.has(n));
    const auditBefore = await deps.db.all<Json>("SELECT * FROM audit ORDER BY id");
    // Invites belong to no workspace (SHARED). The site holds the first side's open invite; one
    // sent by the second side's account and one to its address are written here, as an admin's
    // and a stale one would be.
    await deps.db.run("INSERT INTO invite (id, email, code_hash, invited_by, created_at, expires_at) VALUES (?, 'from-bravo@example.com', ?, ?, ?, ?)", [newId("inv"), "b".repeat(64), b.userId, deps.now(), deps.now() + 86_400_000]);
    await deps.db.run("INSERT INTO invite (id, email, code_hash, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)", [newId("inv"), b.email, "c".repeat(64), a.userId, deps.now(), deps.now() + 86_400_000]);
    const invitesBefore = await deps.db.all<Json>("SELECT * FROM invite ORDER BY id");

    let r = await asAdmin(w, "DELETE", `/api/v1/admin/accounts/${b.userId}`, { username: b.email });
    for (let i = 0; r.status === 202 && i < 20; i++) {
      w.tick();
      r = await asAdmin(w, "DELETE", `/api/v1/admin/accounts/${b.userId}`, { username: b.email });
    }
    expect([r.status, r.json]).toEqual([200, { deleted: true }]);

    for (const table of tables) {
      const rows = await deps.db.all<Json>(`SELECT * FROM "${table}"`);
      if (table === "audit") continue;
      // No row of any table names anything of the deleted side, in any column.
      for (const row of rows) for (const [column, value] of Object.entries(row)) if (typeof value === "string") expect(needles.includes(value), `${table}.${column} still holds ${value}`).toBe(false);
      // And no row is the deleted workspace's by the table's own rule.
      const where = OWNED[table];
      if (where !== undefined) expect(await deps.db.all(`SELECT * FROM "${table}" WHERE ${where}`, Array(where.split("?").length - 1).fill(b.workspaceId)), table).toEqual([]);
    }
    // Invites: the one to the deleted address is gone, the one it sent stays with no sender, and the first side's is untouched.
    const invitesAfter = await deps.db.all<Json>("SELECT * FROM invite ORDER BY id");
    expect(invitesAfter).toEqual(invitesBefore.filter((i) => i.email !== b.email).map((i) => (i.invited_by === b.userId ? { ...i, invited_by: null } : i)));
    expect(invitesAfter.find((i) => i.id === w.invite.id)).toEqual(invitesBefore.find((i) => i.id === w.invite.id));
    // The audit record keeps what it had, and one row more: who deleted which account, by ids alone.
    const auditAfter = await deps.db.all<Json>("SELECT * FROM audit ORDER BY id");
    const added = auditAfter.filter((row) => !auditBefore.some((x) => x.id === row.id));
    expect(added.map(({ event, user_id, workspace_id, subject, detail }) => ({ event, user_id, workspace_id, subject, detail }))).toEqual([
      { event: "account_deleted", user_id: a.userId, workspace_id: b.workspaceId, subject: b.userId, detail: null },
    ]);
    expect(auditAfter.filter((row) => auditBefore.some((x) => x.id === row.id))).toEqual(auditBefore);
    expect(JSON.stringify(auditAfter).includes(b.email)).toBe(false);

    // No file of the deleted side is in either store, and every file left is the first side's.
    const stored = [...(await w.keys.draftKeys()), ...(await w.keys.publicKeys())];
    expect(filesB.filter((k) => stored.includes(k))).toEqual([]);
    const afterA = await snapshotOf(deps, a, w.keys);
    const filesA = Object.entries(afterA.files).filter(([, v]) => v !== "missing").map(([k]) => k);
    expect(stored.filter((k) => !filesA.includes(k))).toEqual([]);
    // Nothing of the first side changed but its record of the delete.
    expect({ ...afterA, rows: { ...afterA.rows, audit: [] } }).toEqual({ ...beforeA, rows: { ...beforeA.rows, audit: [] } });
    // The deleted account is gone from the admin's list, and its id answers as an unknown one.
    const listed = (await asAdmin(w, "GET", "/api/v1/admin/accounts")).json.accounts as Json[];
    expect(listed.map((x) => x.id)).toEqual([a.userId]);
    expect(seen(await asAdmin(w, "GET", `/api/v1/admin/accounts/${b.userId}/removal`))).toEqual(seen(await asAdmin(w, "GET", `/api/v1/admin/accounts/${inventedIds().tokens.live.replace("tok_", "usr_")}/removal`)));
  });
});

describe("a viewer cookie", () => {
  for (const kind of ["tour", "media"] as const) {
    it(`changes no answer of any route but the viewer's own: every answer with a live ${kind === "tour" ? "tours" : "media"} viewer cookie is the answer without it, byte for byte`, SLOW, async () => {
      const w = await build();
      const { deps, a, b } = w;
      // A live viewer session for the first side's own address, made by the real completion: on
      // a site with one address both viewer cookies and the account's session share the host,
      // which is where one could most easily be taken for another.
      const prefix = kind === "tour" ? "/api/v1/view" : "/api/v1/media-view";
      const code = (kind === "tour" ? "dpv_" : "dpi_") + "c".repeat(40);
      if (kind === "tour") await deps.db.run("INSERT INTO viewer_code (id, email, slug, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)", [newId("vco"), a.email, a.ids.published.slug, await hashToken(code), deps.now(), deps.now() + VIEWER_CODE_MS]);
      else await deps.db.run("INSERT INTO media_viewer_code (id, email, path, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)", [newId("vcm"), a.email, `/i/${a.ids.media.restrictedLink}`, await hashToken(code), deps.now(), deps.now() + VIEWER_CODE_MS]);
      const done = await fire(deps, { method: "POST", path: `${prefix}/complete`, json: { code } }, { token: null, headers: { "sec-fetch-site": "same-origin" }, page: true });
      expect(done.status, done.text).toBe(200);
      const viewer = done.headers.getSetCookie()[0].split(";")[0];
      expect(viewer.startsWith(kind === "tour" ? `${VIEWER_COOKIE}=dpw_` : `${MEDIA_VIEWER_COOKIE}=dpk_`)).toBe(true);
      expect((await fire(deps, { method: "GET", path: `${prefix}/session` }, { token: null, headers: { cookie: viewer } })).json).toEqual({ email: a.email });

      /** The same credential with the viewer cookie added to whatever cookies the request already sends. */
      const plus = (r: Req | Sample, c: Credential): Credential => {
        const cookies = ["headers" in r ? r.headers?.cookie : undefined, c.headers?.cookie, viewer].filter((x): x is string => typeof x === "string");
        return { ...c, headers: { ...c.headers, cookie: cookies.join("; ") } };
      };
      // A request that makes a request to connect answers new random codes each time: those alone are put aside.
      const steady = (c: Call) => ({ ...seen(c), body: c.text.replace(/dpd_[0-9a-f]{40}/g, "dpd_…").replace(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g, "XXXX-XXXX") });
      const covered = new Set<string>();
      const compare = async (key: string, what: string, r: Req | Sample, c: Credential) => {
        w.tick();
        const without = await fire(deps, r, c);
        const withIt = await fire(deps, r, plus(r, c));
        expect(steady(withIt), `${key}: ${what}`).toEqual(steady(without));
        covered.add(key);
      };
      const nobody: Credential = { token: null };
      const page: Credential = { token: null, headers: { "sec-fetch-site": "same-origin" }, page: true };

      // Ids in the path or the body: the other workspace's, by the token and by the session.
      for (const { key, req } of everyCase(b.ids, a.ids)) for (const credential of CREDENTIALS) await compare(key, `${req.what} by ${credential.name}`, req, credential.of(a));
      // The caller's own lists, by each credential each takes.
      for (const [key, list] of Object.entries(LISTS)) {
        for (const credential of CREDENTIALS) if (list.only === undefined || list.only === credential.name) await compare(key, `by ${credential.name}`, { method: "GET", path: list.path }, credential.of(a));
      }
      // Routes with no owner, by nobody and by the owner's session. A restricted tour's page and
      // live picture open to the tours viewer cookie of the owner's own address, a restricted
      // item's routes to the media viewer cookie of it, and each to nothing else.
      for (const [key, entry] of Object.entries(OPEN)) {
        for (const sample of entry.samples(w)) {
          for (const [who, c] of [["nobody", nobody], ["the session", BY_SESSION.of(a)]] as const) {
            const opens = kind === "tour" ? sample.viewer === true : sample.mediaViewer === true;
            if (!opens) {
              await compare(key, `${sample.path} by ${who}`, sample, c);
              continue;
            }
            const without = await fire(deps, sample, c);
            const withIt = await fire(deps, sample, plus(sample, c));
            const closed = kind === "media" || key === "GET /t/:slug" ? 403 : 404;
            expect([without.status, withIt.status], `${key}: ${sample.path} by ${who}`).toEqual([closed, 200]);
          }
        }
      }
      // What makes or changes something: asked by nobody (and so refused), which changes nothing either way.
      for (const [key, entry] of Object.entries(CREATES)) await compare(key, "by nobody", entry.sample(a), page);
      for (const [key, entry] of Object.entries(SELF)) await compare(key, "by nobody", { method: "POST", path: entry.path, json: {} }, page);
      // The admin's routes: those that only read, by the admin's session; every one by nobody.
      for (const [key, entry] of Object.entries(ADMIN)) {
        const r = entry.request(w);
        await compare(key, "by nobody", r, page);
        if (r.method === "GET") await compare(key, "by the admin", r, BY_SESSION.of(a));
      }
      // The app's two requests while it connects, and an invite looked up and accepted with a code nobody has; the real invite looked up.
      await compare("POST /api/v1/connect/start", "by nobody", { method: "POST", path: "/api/v1/connect/start", json: { device_name: "Laptop" } }, nobody);
      await compare("POST /api/v1/connect/start", "with a token", { method: "POST", path: "/api/v1/connect/start", json: { device_name: "Laptop" } }, BY_TOKEN.of(a));
      await compare("POST /api/v1/connect/token", "by nobody", { method: "POST", path: "/api/v1/connect/token", json: { device_code: "dpd_" + "0".repeat(40) } }, nobody);
      await compare("POST /api/v1/invite/check", "by nobody", { method: "POST", path: "/api/v1/invite/check", json: { code: w.invite.code } }, page);
      await compare("POST /api/v1/invite/accept", "by nobody", { method: "POST", path: "/api/v1/invite/accept", json: { code: "dpi_" + "0".repeat(40), username: "newcomer" } }, page);

      // Every route was asked, but the viewers' own, which are the routes that read the cookies.
      const routes = routeKeysOf(createApp({ config: BILLING_CONFIG } as Deps));
      expect(routes.filter((key) => !covered.has(key)).sort()).toEqual(Object.keys(VIEWER).sort());
      // The viewer session is still there, and still the first side's address alone.
      expect(await deps.db.all(`SELECT email FROM ${kind === "tour" ? "viewer_session" : "media_viewer_session"}`)).toEqual([{ email: a.email }]);
    });
  }
});
