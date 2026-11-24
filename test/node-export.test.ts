// "Download all my data" on the Node server only: no limit on the files one download reads
// (its entry sets Config.exportFileReads to null), and the zip opened by the unzip programs the
// machine has, as an extra check beside the reader in test/zip-reader.ts: tar (bsdtar, which
// Windows 10 and later ship and most Unix systems have) and, on Windows, PowerShell's
// Expand-Archive. Each unpacks into a new folder under the system's temporary folder, which
// the test deletes. A program that is not there is skipped, and says so.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { createApp } from "../src/app.ts";
import { EXPORT_PATH, EXPORT_WORKER_FILES } from "../src/export.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import { zipStream } from "../src/zip.ts";
import { ORIGIN, clone, fixtures, png, uploadTour, type Json } from "./bundle.ts";
import { filesOf } from "./zip-reader.ts";

const v3 = fixtures.v3 as Json;

async function signedIn(config: Parameters<typeof makeDeps>[0]) {
  const ctx = await makeDeps(config);
  await seedAccount(ctx.deps, { admin: true });
  const a = await seedAccount(ctx.deps);
  const made = await redeemSignInCode(ctx.deps, await createSignInCode(ctx.deps, a.userId), null, null);
  if (made === null) throw new Error("no session");
  return { ...ctx, a, cookie: `${SESSION_COOKIE}=${made.secret}`, csrf: await csrfFor(made.secret) };
}

function manifest(n: number, title: string): Json {
  const m = clone(v3);
  m.title = title;
  m.steps = Array.from({ length: n }, (_, i) => ({ ...clone(v3.steps[0]), image: `step-${String(i + 1).padStart(3, "0")}.png`, width: 64, height: 64, bytes: 150 + i }));
  return m;
}

/** The whole download, asked and read through the app itself, past the per-request meter, as the Node server reads its disk. */
async function wholeDownload(s: Awaited<ReturnType<typeof signedIn>>): Promise<Uint8Array> {
  const app = createApp(s.deps);
  const asked = await app.fetch(new Request(ORIGIN + EXPORT_PATH, { method: "POST", headers: { cookie: s.cookie, "x-csrf-token": s.csrf, origin: ORIGIN, "sec-fetch-site": "same-origin" } }));
  expect(asked.status).toBe(200);
  const { url } = (await asked.json()) as { url: string };
  const res = await app.fetch(new Request(ORIGIN + url, { headers: { cookie: s.cookie } }));
  expect(res.status).toBe(200);
  return new Uint8Array(await res.arrayBuffer());
}

async function listFiles(root: string, at = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(root, at), { withFileTypes: true })) {
    const rel = at === "" ? e.name : `${at}/${e.name}`;
    if (e.isDirectory()) out.push(...(await listFiles(root, rel)));
    else out.push(rel);
  }
  return out.sort();
}

/** Unpacks `zip` with `run` in a new temporary folder, then compares every file with what the reader read; the folder is deleted. */
async function unpackedBy(zip: Uint8Array, run: (zipPath: string, outDir: string) => { ok: boolean; skipped?: string }): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "demo-platform-test-unzip-"));
  try {
    const zipPath = join(dir, "data.zip");
    const out = join(dir, "out");
    await writeFile(zipPath, zip);
    const r = run(zipPath, out);
    if (r.skipped !== undefined) return r.skipped;
    expect(r.ok).toBe(true);
    const expected = filesOf(zip);
    expect(await listFiles(out)).toEqual([...expected.keys()].sort());
    for (const [name, bytes] of expected) expect(new Uint8Array(await readFile(join(out, ...name.split("/")))), name).toEqual(bytes);
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Windows' own bsdtar first: a shell's PATH may put GNU tar, which reads no zip, before it. */
const TAR_PROGRAM = process.platform === "win32" && existsSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")) ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

const TAR = (zipPath: string, outDir: string) => {
  const has = spawnSync(TAR_PROGRAM, ["--version"], { encoding: "utf8" });
  if (has.status !== 0 || !/bsdtar|libarchive/i.test(has.stdout)) return { ok: false, skipped: "no bsdtar here" };
  mkdirSync(outDir, { recursive: true });
  const r = spawnSync(TAR_PROGRAM, ["-xf", zipPath, "-C", outDir], { encoding: "utf8" });
  return { ok: r.status === 0 };
};

const EXPAND_ARCHIVE = (zipPath: string, outDir: string) => {
  if (process.platform !== "win32") return { ok: false, skipped: "Expand-Archive is Windows PowerShell's" };
  const command = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${outDir.replace(/'/g, "''")}' -ErrorAction Stop`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8" });
  return { ok: r.status === 0 };
};

describe("Download all my data on the Node server", () => {
  it("its entry has no limit on the files one download reads", async () => {
    const entry = await readFile(new URL("../src/node/entry.ts", import.meta.url), "utf8");
    expect(entry).toContain("config: { ...config, exportFileReads: null },");
  });

  it("sends a workspace with more files than a Worker could read, every file whole", async () => {
    const s = await signedIn({ exportFileReads: null });
    await uploadTour(s.deps, s.a.token, manifest(EXPORT_WORKER_FILES + 20, "Long tour"));
    await uploadTour(s.deps, s.a.token, manifest(5, "Short tour"));
    const files = filesOf(await wholeDownload(s));
    const pictures = [...files.keys()].filter((n) => n.includes("/pictures/"));
    expect(pictures).toHaveLength(EXPORT_WORKER_FILES + 20 + 1 + 5 + 1);
    expect(files.get("tours/long-tour/pictures/step-055.png")).toEqual(png(64, 64, 150 + 54));
  });

  it("the zip unpacks with tar and with Expand-Archive exactly as the reader reads it, ZIP64 forms included", async () => {
    const s = await signedIn({ exportFileReads: null });
    await uploadTour(s.deps, s.a.token, manifest(4, "Tour one"));
    await uploadTour(s.deps, s.a.token, manifest(2, "Tour two"));
    const zip = await wholeDownload(s);
    const skipped: string[] = [];
    for (const [what, run] of [["tar", TAR], ["Expand-Archive", EXPAND_ARCHIVE]] as const) {
      const why = await unpackedBy(zip, run);
      if (why !== null) skipped.push(`${what}: ${why}`);
    }
    // The same files written with ZIP64 in every place it can be (small limits): tar reads those too.
    const entries = [...filesOf(zip)].map(([name, bytes]) => ({ name, modified: null, size: bytes.length, open: async () => bytes }));
    const zip64 = new Uint8Array(await new Response(zipStream(entries, { u16: 3, u32: 500 })).arrayBuffer());
    const why = await unpackedBy(zip64, TAR);
    if (why !== null) skipped.push(`tar, ZIP64: ${why}`);
    if (skipped.length > 0) console.log(`unzip programs not found, skipped: ${skipped.join("; ")}`);
    // On Windows both are part of the system: neither may be skipped there.
    if (process.platform === "win32") expect(skipped).toEqual([]);
  });
});
