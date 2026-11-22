// Migration 0019 (chapter.uploaded_at) on a database that already holds tours at the version
// before it: every migration before 0019, then 0019 (Node only: the shared harness always
// applies every migration to an empty database). Before it, this build's commits still work,
// without the time (a build may start before its migration has run); after it, the chapter a
// tour was made with, never replaced, gets the tour's creation time and no other chapter gets
// any, nothing else of any row changes, a commit records its time, and a second application
// stops at its first statement.
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
const NAME = "0019_chapter_uploaded.sql";
const T0 = 1_800_000_000_000;

/** A manifest of `n` small steps, picture `pic` each. */
function manifestOf(n: number, title: string): Json {
  const m = clone(fixtures.v2 as Json);
  m.title = title;
  m.steps = Array.from({ length: n }, (_, i) => ({ ...clone(m.steps[1]), image: `step-${String(i + 1).padStart(3, "0")}.png`, width: 64, height: 64, bytes: 120 }));
  return m;
}

async function uploadInto(deps: Deps, token: string, target: Json, title: string, pic: number, sha = false): Promise<Json> {
  const m = manifestOf(2, title);
  const body: Json = { manifest: m, target };
  if (sha) body.sha256 = await Promise.all(m.steps.map((s: Json) => sha256Hex(stepImage(s, pic))));
  const created = sha ? await send(deps, "POST", "/api/v1/uploads", { token, body: JSON.stringify(body), headers: { "content-type": "application/json" } }) : await createUpload(deps, token, m, target);
  expect(created.status, created.text).toBe(201);
  for (let i = 0; i < 2; i++) if (!(created.json.have ?? []).includes(i + 1)) expect((await putStep(deps, token, created.json.upload_id, i + 1, stepImage(m.steps[i], pic))).status).toBe(204);
  const done = await commit(deps, token, created.json.upload_id);
  expect(done.status, done.text).toBe(201);
  return done.json;
}

describe("migration 0019", () => {
  it("before it a commit works without the time; then it dates the chapter each tour was made with, and nothing else; cannot run twice", async () => {
    const root = await mkdtemp(join(tmpdir(), "demo-platform-migrate-"));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    expect(files).toContain(NAME);
    const before = files.filter((f) => f < NAME);
    const upTo18 = join(root, "before");
    const upTo19 = join(root, "with");
    await mkdir(upTo18);
    await mkdir(upTo19);
    for (const f of before) await copyFile(join(MIGRATIONS_DIR, f), join(upTo18, f));
    for (const f of [...before, NAME]) await copyFile(join(MIGRATIONS_DIR, f), join(upTo19, f));
    const db = new NodeDb(join(root, "db.sqlite"));
    expect(await migrate(db, upTo18)).toEqual(before);
    let now = T0;
    const deps: Deps = { db, drafts: new NodeFileStore(join(root, "drafts")), pub: new NodeFileStore(join(root, "public")), config: { publicImageBase: "", setupCode: null }, now: () => now };
    const { token } = await createWorkspace(deps, "Acme", "owner@example.com");

    // This build on the database before 0019: a new tour, a new chapter and a replace all commit.
    const plain = await uploadInto(deps, token, { kind: "new" }, "Made", 1);
    now += 1000;
    const added = await uploadInto(deps, token, { kind: "chapter", tour_id: plain.tour_id }, "Added", 2);
    now += 1000;
    const replaced = await uploadInto(deps, token, { kind: "new" }, "Replaced", 3);
    now += 1000;
    await uploadInto(deps, token, { kind: "replace", tour_id: replaced.tour_id, chapter_id: replaced.chapter_id }, "Replaced", 4, true);
    const rows = () => db.all<Record<string, unknown>>("SELECT id, tour_id, title, description, position, revision, replaced_version, replaced_from FROM chapter ORDER BY id");
    const was = await rows();
    expect(was).toHaveLength(3);

    expect(await migrate(db, upTo19)).toEqual([NAME]);
    expect(await rows()).toEqual(was);
    const times = Object.fromEntries((await db.all<{ id: string; uploaded_at: number | null }>("SELECT id, uploaded_at FROM chapter")).map((r) => [r.id, r.uploaded_at]));
    // The chapter the first tour was made with: its tour's time. The added one and the replaced one: not known.
    expect(times).toEqual({ [plain.chapter_id]: T0, [added.chapter_id]: null, [replaced.chapter_id]: null });

    // From now on each commit records its time.
    now = T0 + 60_000;
    const fresh = await uploadInto(deps, token, { kind: "chapter", tour_id: plain.tour_id }, "Fresh", 5);
    expect(await db.first("SELECT uploaded_at FROM chapter WHERE id = ?", [fresh.chapter_id])).toEqual({ uploaded_at: T0 + 60_000 });
    now = T0 + 120_000;
    await uploadInto(deps, token, { kind: "replace", tour_id: plain.tour_id, chapter_id: added.chapter_id }, "Added", 6, true);
    expect(await db.first("SELECT uploaded_at FROM chapter WHERE id = ?", [added.chapter_id])).toEqual({ uploaded_at: T0 + 120_000 });

    // Applied again by hand, its first statement fails and nothing changes.
    const sql = await readFile(join(MIGRATIONS_DIR, NAME), "utf8");
    expect(() => db.raw.exec(sql)).toThrow(/duplicate column/);
    expect((await db.first<{ uploaded_at: number }>("SELECT uploaded_at FROM chapter WHERE id = ?", [plain.chapter_id]))!.uploaded_at).toBe(T0);
  });
});
