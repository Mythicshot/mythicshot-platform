// Migration 0008 on a database that already holds a site: workspaces, their owners,
// tokens, tours, a published snapshot and an open upload (Node only: the shared harness
// always applies every migration to an empty database).
import { copyFile, mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { accountByEmail, hasAdmin, healMemberships, workspaceOf } from "../src/accounts.ts";
import { hashToken, requireAuth } from "../src/auth.ts";
import { NodeDb } from "../src/node/db.ts";
import { NodeFileStore } from "../src/node/files.ts";
import { migrate } from "../src/node/migrate.ts";
import type { Deps } from "../src/ports.ts";
import { clone, commit, createUpload, fixtures, png, putStep, send, sendAll, stepImage, uploadTour, type Call, type Json } from "./bundle.ts";
import snapshotFixture from "./fixtures/snapshot.json" with { type: "json" };

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const NAME = "0008_accounts.sql";
const NOW = 1_800_000_000_000;

/** What migration 0008 adds. */
const NEW_TABLES = ["audit", "membership", "rate_counter", "session", "signin_code", "signin_method"];
const NEW_USER_COLUMNS = ["username", "status", "is_admin"];

const TOKEN_A = "dp_" + "a1".repeat(20);
const TOKEN_B = "dp_" + "b2".repeat(20);
const TOUR_LIVE = "tour_" + "1".repeat(24);
const TOUR_DRAFT = "tour_" + "2".repeat(24);
const TOUR_OTHER = "tour_" + "3".repeat(24);
const SLUG_LIVE = "abcdefghij";
/** The five steps and pictures the snapshot fixture names. */
const LIVE_STEPS = (snapshotFixture as Json).chapters.flatMap((c: Json) => c.steps) as { id: string; image: string }[];

type Site = { root: string; db: NodeDb; deps: Deps; dir: (n: number) => string; files: string[] };

/**
 * A new database migrated with the first `level` files only, and a folder for every level
 * up to 8. Migration 0010 (shared items) is applied beside every level: today's build
 * counts items in the storage use, so its routes need that table, and it touches nothing
 * the migrations here made. So is migration 0014 (who may view a tour): today's tour list,
 * page and picture route read its setting, and it only adds a column with a default and
 * two empty tables. A real install runs today's build only after every migration
 * (the Node server migrates before it serves, the Cloudflare update before it deploys).
 */
async function siteAt(level: number): Promise<Site> {
  const root = await mkdtemp(join(tmpdir(), "demo-platform-migrate-"));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  expect(files[7]).toBe(NAME);
  // Only the first eight files are ever applied here, so a later migration cannot break
  // what this file says about this one.
  for (let n = 5; n <= 8; n++) {
    await mkdir(join(root, `upto${n}`));
    for (const f of files.slice(0, n)) await copyFile(join(MIGRATIONS_DIR, f), join(root, `upto${n}`, f));
  }
  const dir = (n: number) => join(root, `upto${n}`);
  const db = new NodeDb(join(root, "db.sqlite"));
  expect(await migrate(db, dir(level))).toEqual(files.slice(0, level));
  await mkdir(join(root, "media"));
  await copyFile(join(MIGRATIONS_DIR, "0010_media.sql"), join(root, "media", "0010_media.sql"));
  await copyFile(join(MIGRATIONS_DIR, "0014_tour_access.sql"), join(root, "media", "0014_tour_access.sql"));
  expect(await migrate(db, join(root, "media"))).toEqual(["0010_media.sql", "0014_tour_access.sql"]);
  const deps: Deps = { db, drafts: new NodeFileStore(join(root, "drafts")), pub: new NodeFileStore(join(root, "public")), config: { publicImageBase: "", setupCode: null }, now: () => NOW };
  return { root, db, deps, dir, files };
}

/** A workspace, its owner and its first token, in the three statements every version up to 0.1.8 ran. */
async function oldOwner(db: NodeDb, n: string, name: string, email: string, token: string): Promise<void> {
  await db.batch([
    { sql: "INSERT INTO workspace (id, name, created_at) VALUES (?, ?, ?)", params: [`ws_${n.repeat(24)}`, name, NOW - 50_000] },
    { sql: "INSERT INTO user (id, workspace_id, email, created_at) VALUES (?, ?, ?, ?)", params: [`usr_${n.repeat(24)}`, `ws_${n.repeat(24)}`, email, NOW - 50_000] },
    { sql: "INSERT INTO api_token (id, workspace_id, name, hash, created_at) VALUES (?, ?, ?, ?, ?)", params: [`tok_${n.repeat(24)}`, `ws_${n.repeat(24)}`, "First token", await hashToken(token), NOW - 50_000] },
  ]);
}

const WS_A = "ws_" + "a".repeat(24);
const WS_B = "ws_" + "b".repeat(24);
const USR_A = "usr_" + "a".repeat(24);
const USR_B = "usr_" + "b".repeat(24);

/**
 * A site written by SQL and by the stores, with only the columns a 0.1.1 database has, so
 * the same rows are valid at every later level: two workspaces with an owner and a token
 * each; in the first a published tour (five steps in two chapters, its snapshot and the
 * five published pictures), a draft tour and an open upload with one stored step; in the
 * second one draft tour.
 */
async function writeOldSite(s: Site): Promise<void> {
  const { db, deps } = s;
  await oldOwner(db, "a", "Acme", "owner@example.com", TOKEN_A);
  await oldOwner(db, "b", "Other", "other@example.org", TOKEN_B);
  const tour = (id: string, ws: string, slug: string, live: boolean) =>
    db.run("INSERT INTO tour (id, workspace_id, title, slug, status, created_at, updated_at, published_at, draft_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)", [
      id, ws, live ? "Send an invoice" : `Draft ${slug}`, slug, live ? "published" : "draft", NOW - 40_000, NOW - 40_000, live ? NOW - 30_000 : null,
    ]);
  const step = async (id: string, tourId: string, chapterId: string, position: number, bytes: number) => {
    const key = `u/up_${tourId.slice(5)}/step-00${position + 1}.png`;
    await db.run("INSERT INTO step (id, tour_id, chapter_id, position, image_key, image_type, width, height, bytes, click_x, click_y, notes) VALUES (?, ?, ?, ?, ?, 'png', 1280, 720, ?, 50, 50, '[]')", [id, tourId, chapterId, position, key, bytes]);
    await deps.drafts.put(key, png(1280, 720, bytes, position + 1), { contentType: "image/png" });
  };
  await tour(TOUR_LIVE, WS_A, SLUG_LIVE, true);
  for (const [c, ids] of [LIVE_STEPS.slice(0, 3), LIVE_STEPS.slice(3)].entries()) {
    const chapterId = `ch_${String(c + 1).repeat(24)}`;
    await db.run("INSERT INTO chapter (id, tour_id, title, position) VALUES (?, ?, ?, ?)", [chapterId, TOUR_LIVE, `Chapter ${c + 1}`, c]);
    for (const [i, st] of ids.entries()) await step(st.id, TOUR_LIVE, chapterId, c * 3 + i, 1000 + c * 3 + i);
  }
  await db.run("INSERT INTO snapshot (tour_id, data, published_at, publish_id, steps) VALUES (?, ?, ?, 'pub_x', 5)", [TOUR_LIVE, JSON.stringify(snapshotFixture), NOW - 30_000]);
  for (const [i, st] of LIVE_STEPS.entries()) {
    await db.run("INSERT INTO snapshot_object (tour_id, image_key) VALUES (?, ?)", [TOUR_LIVE, st.image]);
    await deps.pub.put(st.image, png(1280, 720, 2000 + i, 9), { contentType: st.image.endsWith(".png") ? "image/png" : "image/jpeg" });
  }
  await tour(TOUR_DRAFT, WS_A, "bcdefghijk", false);
  await db.run("INSERT INTO chapter (id, tour_id, title, position) VALUES ('ch_draft', ?, 'Only', 0)", [TOUR_DRAFT]);
  await step("st_" + "d".repeat(24), TOUR_DRAFT, "ch_draft", 0, 700);
  await tour(TOUR_OTHER, WS_B, "cdefghijkl", false);
  await db.run("INSERT INTO chapter (id, tour_id, title, position) VALUES ('ch_other', ?, 'Only', 0)", [TOUR_OTHER]);
  await step("st_" + "e".repeat(24), TOUR_OTHER, "ch_other", 0, 77_000);
  await db.run("INSERT INTO upload (id, workspace_id, tour_id, manifest, created_at) VALUES (?, ?, NULL, ?, ?)", ["up_" + "f".repeat(24), WS_A, JSON.stringify(fixtures.v1), NOW - 1000]);
  await db.run("INSERT INTO upload_step (upload_id, n, image_key, bytes, stored_at) VALUES (?, 1, ?, 5000, ?)", ["up_" + "f".repeat(24), `u/up_${"f".repeat(24)}/step-001.png`, NOW - 500]);
  await deps.drafts.put(`u/up_${"f".repeat(24)}/step-001.png`, png(1280, 720, 5000), { contentType: "image/png" });
}

/** Every row of every table of the site, by table. */
async function everything(db: NodeDb): Promise<Record<string, Record<string, unknown>[]>> {
  const out: Record<string, Record<string, unknown>[]> = {};
  const tables = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_*' ORDER BY name");
  for (const t of tables) out[t.name] = await db.all(`SELECT * FROM "${t.name}" ORDER BY 1, 2`);
  return out;
}

/** `after` without the tables and columns migration 0008 adds. */
function withoutNew(after: Record<string, Record<string, unknown>[]>): Record<string, Record<string, unknown>[]> {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const [t, rows] of Object.entries(after)) {
    if (NEW_TABLES.includes(t)) continue;
    out[t] = t === "user" ? rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !NEW_USER_COLUMNS.includes(k)))) : rows;
  }
  return out;
}

/** Each row cut down to the columns the same row had in `before`: what an older level could know of it. */
function asKnownBefore(before: Record<string, Record<string, unknown>[]>, after: Record<string, Record<string, unknown>[]>): Record<string, Record<string, unknown>[]> {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const [t, rows] of Object.entries(before)) {
    const keys = rows.length === 0 ? [] : Object.keys(rows[0]);
    out[t] = (after[t] ?? []).map((r) => Object.fromEntries(keys.map((k) => [k, r[k]])));
  }
  return out;
}

/** Headers that differ from one moment to the next whatever the server does. Every other header is compared. */
const IGNORED_HEADERS = ["date"];

/** What a client can tell of an answer: status, every header but the ignored ones, and every byte. */
function seen(c: Call): { status: number; headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = {};
  c.headers.forEach((value, name) => {
    if (!IGNORED_HEADERS.includes(name.toLowerCase())) headers[name.toLowerCase()] = value;
  });
  return { status: c.status, headers, body: Buffer.from(c.bytes).toString("base64") };
}

/** The requests that show a site to its owner and to a visitor, each with its answer. */
async function answers(deps: Deps, tokens: string[], paths: { open: string[]; withToken: string[] }): Promise<Record<string, ReturnType<typeof seen>>> {
  const out: Record<string, ReturnType<typeof seen>> = {};
  for (const [i, token] of tokens.entries()) {
    for (const path of ["/api/v1/me", "/api/v1/tours", "/api/v1/usage", ...paths.withToken]) out[`token ${i} GET ${path}`] = seen(await send(deps, "GET", path, { token }));
  }
  for (const path of paths.open) out[`GET ${path}`] = seen(await send(deps, "GET", path));
  out["no token GET /api/v1/tours"] = seen(await send(deps, "GET", "/api/v1/tours"));
  out["unknown token GET /api/v1/tours"] = seen(await send(deps, "GET", "/api/v1/tours", { token: "dp_" + "0".repeat(40) }));
  return out;
}

const OLD_PATHS = {
  open: [`/t/${SLUG_LIVE}`, ...LIVE_STEPS.map((s) => "/" + s.image), "/t/bcdefghijk"],
  withToken: [`/api/v1/tours/${TOUR_LIVE}/steps/${LIVE_STEPS[0].id}/image`, `/api/v1/tours/${TOUR_DRAFT}/steps/st_${"d".repeat(24)}/image`, `/api/v1/tours/${TOUR_OTHER}/steps/st_${"e".repeat(24)}/image`],
};

describe("migration 0008 on an existing install", () => {
  it("a 0.1.1 database (migrations 1 to 5) and a 0.1.7 database (1 to 6) with an owner, a token, a published tour and an open upload migrate", async () => {
    // And a 0.1.8 database (1 to 7), the version this migration follows.
    for (const level of [5, 6, 7]) {
      const s = await siteAt(level);
      try {
        await writeOldSite(s);
        const before = await everything(s.db);
        expect(before.user).toHaveLength(2);
        expect(before.step).toHaveLength(7);
        // The site was sound before, so a broken reference afterwards would be the migration's.
        expect(await s.db.all("PRAGMA foreign_key_check"), `from ${level}`).toEqual([]);

        expect(await migrate(s.db, s.dir(8)), `from ${level}`).toEqual(s.files.slice(level, 8));
        const after = await everything(s.db);
        // Every row is still there, unchanged in every column it had.
        expect(asKnownBefore(before, after), `from ${level}`).toEqual(before);
        // From 0.1.8 nothing but the new tables and the three new columns differs at all.
        if (level === 7) expect(withoutNew(after)).toEqual(before);
        const added = Object.keys(after).filter((t) => !(t in before)).sort();
        expect(added.filter((t) => t !== "replaced_object")).toEqual(NEW_TABLES);
        expect(added.includes("replaced_object")).toBe(level === 5);
        // The new columns say "an active account, no username, no admin".
        expect(await s.db.all("SELECT id, username, status, is_admin FROM user ORDER BY id")).toEqual([
          { id: USR_A, username: null, status: "active", is_admin: 0 },
          { id: USR_B, username: null, status: "active", is_admin: 0 },
        ]);
        // Nobody is signed in, nothing was counted and nothing was recorded.
        for (const t of ["signin_code", "session", "rate_counter", "audit"]) expect(after[t], t).toEqual([]);
        expect(await s.db.all("PRAGMA foreign_key_check")).toEqual([]);
        expect(await s.db.first("PRAGMA integrity_check")).toEqual({ integrity_check: "ok" });
      } finally {
        s.db.close();
      }
    }
  });

  it("afterwards the same token lists the same tours and the tour page, its pictures and a draft picture answer as before", async () => {
    let fromEarlier: Record<string, ReturnType<typeof seen>> | null = null;
    for (const level of [7, 6, 5]) {
      const s = await siteAt(level);
      try {
        await writeOldSite(s);
        // This build runs on a 0.1.8 database, so there the answers are taken before and after.
        const before = level === 7 ? await answers(s.deps, [TOKEN_A, TOKEN_B], OLD_PATHS) : null;
        await migrate(s.db, s.dir(8));
        const after = await answers(s.deps, [TOKEN_A, TOKEN_B], OLD_PATHS);
        if (before !== null) expect(after).toEqual(before);
        // And a 0.1.1 or 0.1.7 database answers what the 0.1.8 one answers: byte for byte,
        // but for what the list says of a snapshot whose draft version 0.1.1 never recorded.
        const comparable = (a: Record<string, ReturnType<typeof seen>>) => Object.fromEntries(Object.entries(a).filter(([k]) => !k.endsWith("GET /api/v1/tours") || k.startsWith("no token") || k.startsWith("unknown token")));
        if (fromEarlier !== null) expect(comparable(after), `from ${level}`).toEqual(comparable(fromEarlier));
        fromEarlier ??= after;

        const body = (key: string) => Buffer.from(after[key].body, "base64");
        const json = (key: string) => JSON.parse(body(key).toString("utf8"));
        // Each token still lists its own workspace's tours and nobody else's.
        const listA = json("token 0 GET /api/v1/tours").tours as Json[];
        expect(listA.map((t) => [t.id, t.title, t.status, t.url, t.chapters, t.steps]).sort()).toEqual([
          [TOUR_LIVE, "Send an invoice", "published", `/t/${SLUG_LIVE}`, 2, 5],
          [TOUR_DRAFT, "Draft bcdefghijk", "draft", null, 1, 1],
        ]);
        expect((json("token 1 GET /api/v1/tours").tours as Json[]).map((t) => t.id)).toEqual([TOUR_OTHER]);
        expect(json("token 0 GET /api/v1/me").workspace).toBe("Acme");
        expect(json("token 1 GET /api/v1/me").workspace).toBe("Other");
        expect(json("token 0 GET /api/v1/usage")).toMatchObject({ used_bytes: 1000 + 1001 + 1002 + 1003 + 1004 + 700, allowance_bytes: null, over: false, tours: 2 });
        expect(json("token 1 GET /api/v1/usage")).toMatchObject({ used_bytes: 77_000, tours: 1 });
        // The published page and its five pictures, without a token.
        expect(after[`GET /t/${SLUG_LIVE}`].status).toBe(200);
        expect(body(`GET /t/${SLUG_LIVE}`).toString("utf8")).toContain("Send an invoice");
        for (const [i, st] of LIVE_STEPS.entries()) {
          expect(after[`GET /${st.image}`].status, st.image).toBe(200);
          expect(new Uint8Array(body(`GET /${st.image}`))).toEqual(png(1280, 720, 2000 + i, 9));
        }
        expect(after["GET /t/bcdefghijk"].status).toBe(404);
        // Draft pictures: each workspace's own answer, the other's do not.
        const draftOf = (who: number, tourId: string, stepId: string) => after[`token ${who} GET /api/v1/tours/${tourId}/steps/${stepId}/image`];
        expect(draftOf(0, TOUR_LIVE, LIVE_STEPS[0].id).status).toBe(200);
        expect(new Uint8Array(Buffer.from(draftOf(0, TOUR_LIVE, LIVE_STEPS[0].id).body, "base64"))).toEqual(png(1280, 720, 1000, 1));
        expect(draftOf(0, TOUR_DRAFT, "st_" + "d".repeat(24)).status).toBe(200);
        expect(draftOf(0, TOUR_OTHER, "st_" + "e".repeat(24)).status).toBe(404);
        expect(draftOf(1, TOUR_OTHER, "st_" + "e".repeat(24)).status).toBe(200);
        expect(draftOf(1, TOUR_LIVE, LIVE_STEPS[0].id).status).toBe(404);
        expect(after["no token GET /api/v1/tours"].status).toBe(401);
        expect(after["unknown token GET /api/v1/tours"].status).toBe(401);
      } finally {
        s.db.close();
      }
    }
  });

  it("a site that 0.1.8's own routes wrote answers the same, byte for byte, before and after", async () => {
    const s = await siteAt(7);
    try {
      const { db, deps } = s;
      await oldOwner(db, "a", "Acme", "owner@example.com", TOKEN_A);
      await oldOwner(db, "b", "Other", "other@example.org", TOKEN_B);
      // Uploads, a publish and an open upload through the routes themselves, which this
      // task does not change: the rows and files are exactly what 0.1.8 writes.
      const live = await uploadTour(deps, TOKEN_A, clone(fixtures.v3 as Json));
      let pub = await send(deps, "POST", `/api/v1/tours/${live.tour_id}/publish`, { token: TOKEN_A });
      while (pub.status === 202) pub = await send(deps, "POST", `/api/v1/tours/${live.tour_id}/publish`, { token: TOKEN_A, body: JSON.stringify({ publish_id: pub.json.publish_id }), headers: { "content-type": "application/json" } });
      expect(pub.status).toBe(200);
      const draft = await uploadTour(deps, TOKEN_A, clone(fixtures.v1 as Json));
      const other = await uploadTour(deps, TOKEN_B, clone(fixtures.v2 as Json), { kind: "new" }, 7);
      const open = await createUpload(deps, TOKEN_A, clone(fixtures.v1 as Json));
      expect(open.status).toBe(201);
      expect((await putStep(deps, TOKEN_A, open.json.upload_id, 1, stepImage((fixtures.v1 as Json).steps[0], 3))).status).toBe(204);
      await db.run("UPDATE workspace SET storage_allowance_bytes = 50000000 WHERE id = ?", [WS_B]);

      const slug = (await db.first<{ slug: string }>("SELECT slug FROM tour WHERE id = ?", [live.tour_id]))!.slug;
      const pictures = (await db.all<{ image_key: string }>("SELECT image_key FROM snapshot_object WHERE tour_id = ? ORDER BY image_key", [live.tour_id])).map((r) => "/" + r.image_key);
      expect(pictures.length).toBeGreaterThan(0);
      const stepOf = async (tourId: string) => (await db.first<{ id: string }>("SELECT id FROM step WHERE tour_id = ? ORDER BY position", [tourId]))!.id;
      const paths = {
        open: [`/t/${slug}`, ...pictures, "/healthz"],
        withToken: [`/api/v1/tours/${live.tour_id}/steps/${await stepOf(live.tour_id)}/image`, `/api/v1/tours/${draft.tour_id}/steps/${await stepOf(draft.tour_id)}/image`, `/api/v1/tours/${other.tour_id}/steps/${await stepOf(other.tour_id)}/image`],
      };
      const before = await answers(deps, [TOKEN_A, TOKEN_B], paths);
      expect(before[`GET /t/${slug}`].status).toBe(200);
      for (const p of pictures) expect(before[`GET ${p}`].status, p).toBe(200);
      expect(before[`token 0 GET ${paths.withToken[0]}`].status).toBe(200);
      expect(before[`token 0 GET ${paths.withToken[2]}`].status).toBe(404);
      expect(before[`token 1 GET ${paths.withToken[2]}`].status).toBe(200);
      const rowsBefore = await everything(db);
      expect(await db.all("PRAGMA foreign_key_check")).toEqual([]);
      const draftKeys = await (deps.drafts as NodeFileStore).keys();
      const publicKeys = await (deps.pub as NodeFileStore).keys();

      expect(await migrate(db, s.dir(8))).toEqual([NAME]);
      // No row of 0.1.8 changed, and no file was touched.
      expect(withoutNew(await everything(db))).toEqual(rowsBefore);
      expect(await (deps.drafts as NodeFileStore).keys()).toEqual(draftKeys);
      expect(await (deps.pub as NodeFileStore).keys()).toEqual(publicKeys);
      expect(await db.all("PRAGMA foreign_key_check")).toEqual([]);
      expect(await db.first("PRAGMA integrity_check")).toEqual({ integrity_check: "ok" });
      expect(await answers(deps, [TOKEN_A, TOKEN_B], paths)).toEqual(before);

      // The open upload still takes its last step and commits, and the new tour is listed.
      const open2 = open.json.upload_id as string;
      for (let n = 2; n <= (fixtures.v1 as Json).steps.length; n++) expect((await putStep(deps, TOKEN_A, open2, n, stepImage((fixtures.v1 as Json).steps[n - 1], 3))).status).toBe(204);
      const done = await commit(deps, TOKEN_A, open2);
      expect(done.status).toBe(201);
      const list = await send(deps, "GET", "/api/v1/tours", { token: TOKEN_A });
      expect((list.json.tours as Json[]).map((t) => t.id).sort()).toEqual([live.tour_id, draft.tour_id, done.json.tour_id].sort());
      // A whole new upload and a second publish work on the migrated database too.
      const later = await sendAll(deps, TOKEN_B, clone(fixtures.v1 as Json));
      expect((await commit(deps, TOKEN_B, later)).status).toBe(201);
      expect((await send(deps, "POST", `/api/v1/tours/${other.tour_id}/publish`, { token: TOKEN_B })).status).toBeLessThan(300);
    } finally {
      s.db.close();
    }
  });

  it("the owner has a membership and a sign-in method and is not an admin", async () => {
    for (const level of [5, 6, 7]) {
      const s = await siteAt(level);
      try {
        await writeOldSite(s);
        await migrate(s.db, s.dir(8));
        // One owner row per account that existed, in the workspace its user row names,
        // dated as the account is: no clock is read by the migration.
        expect(await s.db.all("SELECT * FROM membership ORDER BY user_id")).toEqual([
          { workspace_id: WS_A, user_id: USR_A, role: "owner", created_at: NOW - 50_000 },
          { workspace_id: WS_B, user_id: USR_B, role: "owner", created_at: NOW - 50_000 },
        ]);
        expect(await s.db.all("SELECT * FROM signin_method ORDER BY user_id")).toEqual([
          { user_id: USR_A, kind: "email_link", created_at: NOW - 50_000 },
          { user_id: USR_B, kind: "email_link", created_at: NOW - 50_000 },
        ]);
        expect(await s.db.all("SELECT u.id FROM user u JOIN membership m ON m.user_id = u.id WHERE m.workspace_id <> u.workspace_id")).toEqual([]);
        expect(await s.db.first("SELECT count(*) AS n FROM user WHERE is_admin <> 0")).toEqual({ n: 0 });
        // Through the lookups later code uses.
        expect(await hasAdmin(s.deps)).toBe(false);
        expect(await workspaceOf(s.deps, USR_A)).toBe(WS_A);
        expect(await workspaceOf(s.deps, USR_B)).toBe(WS_B);
        expect(await accountByEmail(s.deps, "owner@example.com")).toEqual({ id: USR_A, status: "active", admin: false, username: null });
        // And the owner's token still resolves to the same workspace and the same token row.
        for (const [token, ws, n] of [[TOKEN_A, WS_A, "a"], [TOKEN_B, WS_B, "b"]]) {
          const auth = await requireAuth(new Request("https://tours.example.com/api/v1/me", { headers: { authorization: "Bearer " + token } }), s.deps);
          expect(auth).toEqual({ workspaceId: ws, tokenId: "tok_" + n.repeat(24) });
        }
        expect(await s.db.all("SELECT id, workspace_id, hash, revoked_at FROM api_token ORDER BY id")).toEqual([
          { id: "tok_" + "a".repeat(24), workspace_id: WS_A, hash: await hashToken(TOKEN_A), revoked_at: null },
          { id: "tok_" + "b".repeat(24), workspace_id: WS_B, hash: await hashToken(TOKEN_B), revoked_at: null },
        ]);
      } finally {
        s.db.close();
      }
    }
  });

  it("a database with a workspace and no user row still migrates and its token still works", async () => {
    for (const level of [5, 7]) {
      const s = await siteAt(level);
      try {
        await s.db.run("INSERT INTO workspace (id, name, created_at) VALUES (?, 'Alone', 1)", [WS_A]);
        await s.db.run("INSERT INTO api_token (id, workspace_id, name, hash, created_at) VALUES ('tok_1', ?, 'First token', ?, 1)", [WS_A, await hashToken(TOKEN_A)]);
        await s.db.run("INSERT INTO setup (id, workspace_id, completed_at) VALUES (1, ?, 1)", [WS_A]);
        expect(await migrate(s.db, s.dir(8))).toEqual(s.files.slice(level, 8));
        for (const t of ["user", "membership", "signin_method"]) expect(await s.db.first(`SELECT count(*) AS n FROM ${t}`), t).toEqual({ n: 0 });
        const me = await send(s.deps, "GET", "/api/v1/me", { token: TOKEN_A });
        expect([me.status, me.json.workspace]).toEqual([200, "Alone"]);
        expect((await send(s.deps, "GET", "/api/v1/tours", { token: TOKEN_A })).json).toEqual({ tours: [] });
        expect(await hasAdmin(s.deps)).toBe(false);
      } finally {
        s.db.close();
      }
    }
    // And a database with nothing in it at all.
    const empty = await siteAt(7);
    try {
      expect(await migrate(empty.db, empty.dir(8))).toEqual([NAME]);
      for (const t of ["user", ...NEW_TABLES]) expect(await empty.db.first(`SELECT count(*) AS n FROM ${t}`), t).toEqual({ n: 0 });
    } finally {
      empty.db.close();
    }
  });

  it("0.1.7's statements still run on the migrated database", async () => {
    const s = await siteAt(7);
    try {
      const { db, deps } = s;
      await writeOldSite(s);
      await migrate(db, s.dir(8));
      // The three statements 0.1.7 and 0.1.8 create a workspace with: the four-column
      // INSERT INTO user names none of the new columns and writes no membership.
      const token = "dp_" + "c3".repeat(20);
      await oldOwner(db, "c", "Later", "later@example.com", token);
      expect(await db.first("SELECT username, status, is_admin FROM user WHERE id = ?", ["usr_" + "c".repeat(24)])).toEqual({ username: null, status: "active", is_admin: 0 });
      // Their token lookup and the update that follows it.
      const hash = await hashToken(token);
      expect(await db.first("SELECT id, workspace_id, hash FROM api_token WHERE hash = ? AND revoked_at IS NULL", [hash])).toEqual({ id: "tok_" + "c".repeat(24), workspace_id: "ws_" + "c".repeat(24), hash });
      expect(await db.run("UPDATE api_token SET last_used_at = ? WHERE id = ? AND workspace_id = ?", [NOW, "tok_" + "c".repeat(24), "ws_" + "c".repeat(24)])).toEqual({ changes: 1 });
      // The setup claim: 0.1.7 sees a site that is set up, and its one-row table still holds.
      expect(await db.first("SELECT (SELECT count(*) FROM setup) AS s, (SELECT count(*) FROM workspace) AS w")).toEqual({ s: 0, w: 3 });
      await db.run("INSERT INTO setup (id, workspace_id, completed_at) VALUES (1, ?, ?)", [WS_A, NOW]);
      // The statements either version reads the account table with: none, but a backup copies it whole.
      expect((await db.all("SELECT id, workspace_id, email, created_at FROM user ORDER BY id")).map((r) => (r as Json).email)).toEqual(["owner@example.com", "other@example.org", "later@example.com"]);
      // An account an older build made after the migration has no membership row, and its
      // workspace's token still resolves: a token belongs to a workspace, not to an account.
      expect(await workspaceOf(deps, "usr_" + "c".repeat(24))).toBeNull();
      expect(await requireAuth(new Request("https://tours.example.com/api/v1/me", { headers: { authorization: "Bearer " + token } }), deps)).toEqual({ workspaceId: "ws_" + "c".repeat(24), tokenId: "tok_" + "c".repeat(24) });
      // 0.1.7's and 0.1.8's upload create and tour insert, as in the test of migration 0007.
      await db.run("INSERT INTO upload (id, workspace_id, tour_id, manifest, created_at, replaces_chapter_id, base_revision) SELECT 'up_later', ?, NULL, '{}', ?, NULL, NULL WHERE (SELECT count(*) FROM upload WHERE workspace_id = ? AND closing_at IS NULL AND created_at >= 0) < 5", ["ws_" + "c".repeat(24), NOW, "ws_" + "c".repeat(24)]);
      await db.run("INSERT INTO tour (id, workspace_id, title, slug, status, spotlight_dim, theme, zoom, cover, cta, end_card, autoplay, logo_key, logo_type, created_at, updated_at, draft_version) VALUES ('tour_later', ?, 'T', 'later', 'draft', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 3, 3, 1)", ["ws_" + "c".repeat(24)]);
      // A second address in capitals or a repeated one is refused as before.
      await expect(db.run("INSERT INTO user (id, workspace_id, email, created_at) VALUES ('usr_x', ?, 'owner@example.com', 1)", [WS_A])).rejects.toThrow(/UNIQUE constraint failed/);
      await expect(db.run("INSERT INTO user (id, workspace_id, email, created_at) VALUES ('usr_y', ?, 'New@example.com', 1)", [WS_A])).rejects.toThrow(/CHECK constraint failed/);
      // A row an older build deletes by naming it is not held by anything new: an upload and its steps.
      await db.run("DELETE FROM upload WHERE id = 'up_later'");
      expect(await db.all("PRAGMA foreign_key_check")).toEqual([]);
    } finally {
      s.db.close();
    }
  });

  it("an account an older build wrote after the migration is repaired once the newer build is back", async () => {
    const s = await siteAt(7);
    try {
      const { db, deps } = s;
      await writeOldSite(s);
      expect(await migrate(db, s.dir(8))).toEqual([NAME]);
      // The way back was taken: 0.1.8 runs on the migrated database, which has 0008 on
      // record, and a workspace is made by its three statements.
      const token = "dp_" + "c3".repeat(20);
      await oldOwner(db, "c", "Later", "later@example.com", token);
      const USR_C = "usr_" + "c".repeat(24);
      const WS_C = "ws_" + "c".repeat(24);
      expect(await workspaceOf(deps, USR_C)).toBeNull();
      // Forward again: the migration is on record and does not run a second time, so it cannot fill the gap.
      expect(await migrate(db, s.dir(8))).toEqual([]);
      expect(await workspaceOf(deps, USR_C)).toBeNull();
      const before = await everything(db);

      await db.batch(healMemberships(deps));
      expect(await workspaceOf(deps, USR_C)).toBe(WS_C);
      expect(await db.all("SELECT * FROM membership ORDER BY user_id")).toEqual([
        { workspace_id: WS_A, user_id: USR_A, role: "owner", created_at: NOW - 50_000 },
        { workspace_id: WS_B, user_id: USR_B, role: "owner", created_at: NOW - 50_000 },
        { workspace_id: WS_C, user_id: USR_C, role: "owner", created_at: NOW - 50_000 },
      ]);
      expect(await db.all("SELECT user_id, kind FROM signin_method ORDER BY user_id")).toEqual([
        { user_id: USR_A, kind: "email_link" },
        { user_id: USR_B, kind: "email_link" },
        { user_id: USR_C, kind: "email_link" },
      ]);
      // Nothing else changed, nobody became an admin, and the repair is safe to run at every start.
      const after = await everything(db);
      expect({ ...after, membership: [], signin_method: [] }).toEqual({ ...before, membership: [], signin_method: [] });
      expect(await hasAdmin(deps)).toBe(false);
      await db.batch(healMemberships(deps));
      expect(await everything(db)).toEqual(after);
      expect(await db.all("PRAGMA foreign_key_check")).toEqual([]);
      for (const [t, ws] of [[TOKEN_A, WS_A], [token, WS_C]]) {
        expect(await requireAuth(new Request("https://tours.example.com/api/v1/me", { headers: { authorization: "Bearer " + t } }), deps)).toMatchObject({ workspaceId: ws });
      }
    } finally {
      s.db.close();
    }
  });

  it("running the migrations again applies nothing", async () => {
    const s = await siteAt(7);
    try {
      await writeOldSite(s);
      expect(await migrate(s.db, s.dir(8))).toEqual([NAME]);
      const settled = await everything(s.db);
      expect(await migrate(s.db, s.dir(8))).toEqual([]);
      expect(await everything(s.db)).toEqual(settled);
      // A process that meets the file a second time fails at its first statement, as a
      // whole, and leaves the database exactly as it was: nothing is half applied, and no
      // account gets a second membership.
      const sql = await readFile(join(MIGRATIONS_DIR, NAME), "utf8");
      expect(() => s.db.transaction(() => s.db.raw.exec(sql))).toThrow(/duplicate column name: username/);
      expect(await everything(s.db)).toEqual(settled);
      expect(await s.db.first("SELECT count(*) AS n FROM _migrations WHERE name = ?", [NAME])).toEqual({ n: 1 });
      const schema = await s.db.all("SELECT type, name, sql FROM sqlite_master ORDER BY type, name");
      // Each statement after the first, met alone a second time, fails too or changes nothing.
      for (const statement of statementsOf(sql).slice(1)) {
        try {
          s.db.transaction(() => s.db.raw.exec(statement));
        } catch {
          // Refused: a duplicate column, table or index, or a membership that is already there.
        }
        expect(await everything(s.db), statement).toEqual(settled);
        expect(await s.db.all("SELECT type, name, sql FROM sqlite_master ORDER BY type, name"), statement).toEqual(schema);
      }
    } finally {
      s.db.close();
    }
  });

  it("two connections migrating at once apply each file once", async () => {
    const s = await siteAt(7);
    const two = new NodeDb(join(s.root, "db.sqlite"));
    try {
      await writeOldSite(s);
      // Both read the list of applied files before either applies 0008.
      const [a, b] = await Promise.all([migrate(s.db, s.dir(8)), migrate(two, s.dir(8))]);
      expect([...a, ...b]).toEqual([NAME]);
      expect(await two.first("SELECT count(*) AS n FROM _migrations WHERE name = ?", [NAME])).toEqual({ n: 1 });
      // One membership and one sign-in method per account, not two.
      expect(await two.first("SELECT (SELECT count(*) FROM membership) AS m, (SELECT count(*) FROM signin_method) AS s, (SELECT count(*) FROM user) AS u")).toEqual({ m: 2, s: 2, u: 2 });
      expect(await migrate(s.db, s.dir(8))).toEqual([]);
      expect(await migrate(two, s.dir(8))).toEqual([]);

      // A connection whose list is stale: the other applied 0008 after it read the list.
      const t = await siteAt(7);
      const fast = new NodeDb(join(t.root, "db.sqlite"));
      try {
        await writeOldSite(t);
        const realAll = t.db.all.bind(t.db);
        let applied: string[] | null = null;
        t.db.all = (async (sql: string, params?: never) => {
          const rows = await realAll(sql, params);
          if (applied === null && sql.includes("_migrations")) applied = await migrate(fast, t.dir(8));
          return rows;
        }) as typeof t.db.all;
        expect(await migrate(t.db, t.dir(8))).toEqual([]);
        expect(applied).toEqual([NAME]);
        expect(await fast.first("SELECT (SELECT count(*) FROM membership) AS m, (SELECT count(*) FROM _migrations) AS f")).toEqual({ m: 2, f: 10 }); // 1 to 8, and 0010 and 0014 beside them
      } finally {
        t.db.close();
        fast.close();
      }
    } finally {
      s.db.close();
      two.close();
    }
  });

  it("the migration is plain and additive: columns, tables, indexes and two copies from user, nothing dropped, renamed or rebuilt", async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, NAME), "utf8");
    const statements = statementsOf(sql);
    const kinds = statements.map((st) => {
      if (/^ALTER TABLE user ADD COLUMN \w+ /.test(st)) return "add column";
      if (/^CREATE TABLE \w+ \(.*\) STRICT$/.test(st)) return "create table";
      if (/^CREATE (UNIQUE )?INDEX \w+ ON \w+ \([\w, ]+\)( WHERE username IS NOT NULL)?$/.test(st)) return "create index";
      if (/^INSERT INTO (membership|signin_method) \([\w, ]+\) SELECT [\w', ]+ FROM user$/.test(st)) return "copy from user";
      return st;
    });
    expect(kinds).toEqual([
      "add column", "add column", "add column", "create index",
      "create table", "create index", "copy from user",
      "create table", "copy from user",
      "create table", "create index",
      "create table", "create index",
      "create table", "create index",
      "create table", "create index",
    ]);
    // Nothing either target would refuse or that could change or remove what is there, and no clock.
    expect(statements.join(";\n")).not.toMatch(/\b(DROP|RENAME|DELETE|UPDATE|REPLACE|RETURNING|GENERATED|TRIGGER|VIEW|PRAGMA|VACUUM|ATTACH|BEGIN|COMMIT|CASCADE|WITHOUT ROWID|IF NOT EXISTS|AUTOINCREMENT|CURRENT_TIMESTAMP|CURRENT_TIME|CURRENT_DATE|strftime|datetime|unixepoch|julianday|random|randomblob)\b/i);
    // The first statement is one that fails on a second application, so a second run stops before anything.
    expect(statements[0]).toMatch(/^ALTER TABLE user ADD COLUMN username TEXT CHECK /);
    // No existing row is made an admin, and nothing is written but the two copies.
    expect(statements.filter((st) => st.startsWith("INSERT"))).toEqual([
      "INSERT INTO membership (workspace_id, user_id, role, created_at) SELECT workspace_id, id, 'owner', created_at FROM user",
      "INSERT INTO signin_method (user_id, kind, created_at) SELECT id, 'email_link', created_at FROM user",
    ]);
    // The lines of comment hold no semicolon that would cut a statement in two on either target.
    for (const line of sql.split("\n").filter((l) => l.trimStart().startsWith("--"))) expect(line).not.toContain(";");
  });
});

/** The statements of a migration file, comments out, each on one line. */
function statementsOf(sql: string): string[] {
  return sql
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((st) => st.trim().replace(/\s+/g, " "))
    .filter((st) => st !== "");
}
