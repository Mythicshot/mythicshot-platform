// Migration 0020 (a chapter's upload time follows its revision) on a database that already
// holds tours at the version before it: every migration before 0020, then 0020 (Node only: the
// shared harness always applies every migration to an empty database). Before it, this build's
// commits still date their chapters; it changes no row; after it, a replace written the way
// every build before 0.1.55 writes it (the revision, never uploaded_at) leaves the chapter with
// no time instead of the time of the pictures it replaced, while this build's own replaces
// stay dated; and a second application stops at its statement.
import { copyFile, mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NodeDb } from "../src/node/db.ts";
import { NodeFileStore } from "../src/node/files.ts";
import { migrate } from "../src/node/migrate.ts";
import type { Deps } from "../src/ports.ts";
import { createWorkspace } from "../src/workspaces.ts";
import { clone, commit, createUpload, fixtures, putStep, send, sha256Hex, stepImage, type Json } from "./bundle.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const NAME = "0020_chapter_uploaded_follows.sql";
const T0 = 1_800_000_000_000;

function manifestOf(title: string): Json {
  const m = clone(fixtures.v2 as Json);
  m.title = title;
  m.steps = [{ ...clone(m.steps[1]), image: "step-001.png", width: 64, height: 64, bytes: 120 }];
  return m;
}

async function uploadInto(deps: Deps, token: string, target: Json, title: string, pic: number): Promise<Json> {
  const m = manifestOf(title);
  const replace = target.kind === "replace";
  const body: Json = { manifest: m, target };
  if (replace) body.sha256 = [await sha256Hex(stepImage(m.steps[0], pic))];
  const created = replace ? await send(deps, "POST", "/api/v1/uploads", { token, body: JSON.stringify(body), headers: { "content-type": "application/json" } }) : await createUpload(deps, token, m, target);
  expect(created.status, created.text).toBe(201);
  if (!(created.json.have ?? []).includes(1)) expect((await putStep(deps, token, created.json.upload_id, 1, stepImage(m.steps[0], pic))).status).toBe(204);
  const done = await commit(deps, token, created.json.upload_id);
  expect(done.status, done.text).toBe(201);
  return done.json;
}

/** What a build before 0.1.55 writes to the chapter row when its replace commits. */
async function olderBuildReplace(db: NodeDb, tourId: string, chapterId: string, uploadId: string): Promise<void> {
  await db.run(
    "UPDATE chapter SET revision = ?, replaced_version = (SELECT draft_version FROM tour WHERE id = ?), replaced_from = (SELECT draft_version FROM tour WHERE id = ?) WHERE id = ?",
    [uploadId, tourId, tourId, chapterId],
  );
}

describe("migration 0020", () => {
  it("before it this build dates its commits; it changes no row; after it an older build's replace leaves no time and this build's are dated; cannot run twice", async () => {
    const root = await mkdtemp(join(tmpdir(), "demo-platform-migrate-"));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    expect(files).toContain(NAME);
    const before = files.filter((f) => f < NAME);
    const upTo19 = join(root, "before");
    const upTo20 = join(root, "with");
    await mkdir(upTo19);
    await mkdir(upTo20);
    for (const f of before) await copyFile(join(MIGRATIONS_DIR, f), join(upTo19, f));
    for (const f of [...before, NAME]) await copyFile(join(MIGRATIONS_DIR, f), join(upTo20, f));
    const db = new NodeDb(join(root, "db.sqlite"));
    expect(await migrate(db, upTo19)).toEqual(before);
    let now = T0;
    const deps: Deps = { db, drafts: new NodeFileStore(join(root, "drafts")), pub: new NodeFileStore(join(root, "public")), config: { publicImageBase: "", setupCode: null }, now: () => now };
    const { token } = await createWorkspace(deps, "Acme", "owner@example.com");
    const timeOf = async (id: string) => (await db.first<{ uploaded_at: number | null }>("SELECT uploaded_at FROM chapter WHERE id = ?", [id]))!.uploaded_at;

    // This build on the database before 0020: a new tour and a replace are dated.
    const made = await uploadInto(deps, token, { kind: "new" }, "Made", 1);
    const other = await uploadInto(deps, token, { kind: "new" }, "Other", 2);
    now += 60_000;
    await uploadInto(deps, token, { kind: "replace", tour_id: other.tour_id, chapter_id: other.chapter_id }, "Other", 3);
    expect([await timeOf(made.chapter_id), await timeOf(other.chapter_id)]).toEqual([T0, T0 + 60_000]);
    // Without 0020, an older build's replace leaves the earlier time behind: what 0020 is for.
    await olderBuildReplace(db, other.tour_id, other.chapter_id, "up_" + "1".repeat(24));
    expect(await timeOf(other.chapter_id)).toBe(T0 + 60_000);

    const rows = () => db.all<Record<string, unknown>>("SELECT * FROM chapter ORDER BY id");
    const was = await rows();
    expect(await migrate(db, upTo20)).toEqual([NAME]);
    // It changes no row: a time left stale before it cannot be told from a right one.
    expect(await rows()).toEqual(was);

    // From now on an older build's replace leaves no time.
    await olderBuildReplace(db, made.tour_id, made.chapter_id, "up_" + "2".repeat(24));
    expect(await timeOf(made.chapter_id)).toBeNull();
    // Writing the same revision again changes nothing.
    now += 60_000;
    await uploadInto(deps, token, { kind: "replace", tour_id: made.tour_id, chapter_id: made.chapter_id }, "Made", 4);
    expect(await timeOf(made.chapter_id)).toBe(T0 + 120_000);
    await db.run("UPDATE chapter SET revision = revision WHERE id = ?", [made.chapter_id]);
    expect(await timeOf(made.chapter_id)).toBe(T0 + 120_000);
    // 0.1.55's own replace (its exact UPDATE: the revision and the time in one statement, as in
    // src/replace.ts at 3e98323) on the migrated database: the trigger runs after that statement
    // and empties the time, so the chapter has none until 0.1.56 or later replaces it again.
    // Deliberate and documented: no time is a correct "not known".
    now += 60_000;
    const version = "(SELECT draft_version FROM tour WHERE id = ? AND workspace_id = ?)";
    const ws = (await db.first<{ workspace_id: string }>("SELECT workspace_id FROM tour WHERE id = ?", [made.tour_id]))!.workspace_id;
    await db.run(
      `UPDATE chapter SET revision = ?, replaced_version = ${version},
                               replaced_from = CASE WHEN replaced_version = ${version} - 1 THEN replaced_from ELSE ${version} END, uploaded_at = ?
             WHERE id = ? AND tour_id IN (SELECT id FROM tour WHERE id = ? AND workspace_id = ?)`,
      ["up_" + "3".repeat(24), made.tour_id, ws, made.tour_id, ws, made.tour_id, ws, now, made.chapter_id, made.tour_id, ws],
    );
    expect(await db.first("SELECT revision, uploaded_at FROM chapter WHERE id = ?", [made.chapter_id])).toEqual({ revision: "up_" + "3".repeat(24), uploaded_at: null });
    now += 60_000;
    await uploadInto(deps, token, { kind: "replace", tour_id: made.tour_id, chapter_id: made.chapter_id }, "Made", 5);
    expect(await timeOf(made.chapter_id)).toBe(T0 + 240_000);
    // A reorder or a rename of another row moves no time.
    await db.run("UPDATE chapter SET position = position + 1 WHERE id = ?", [made.chapter_id]);
    expect([await timeOf(made.chapter_id), await timeOf(other.chapter_id)]).toEqual([T0 + 240_000, T0 + 60_000]);

    // Applied again by hand, its statement fails and nothing changes.
    const sql = await readFile(join(MIGRATIONS_DIR, NAME), "utf8");
    const at = await rows();
    expect(() => db.raw.exec(sql)).toThrow(/already exists/);
    expect(await rows()).toEqual(at);
  });
});
