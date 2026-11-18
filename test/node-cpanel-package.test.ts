// Runs the cPanel packager (npm run package:cpanel) for real: it compiles the Node build
// into a scratch folder and writes dist/cpanel/demo-platform-<version>-cpanel.tgz. The
// archive is then read back with a small tar reader written here, independent of the
// packager's writer, and with the system's own tar where there is one.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ARCHIVE_TOP_LEVEL, packageCpanel, tarGz, type PackageResult } from "../scripts/package-cpanel.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p));
const VERSION = (JSON.parse(read("package.json").toString("utf8")) as { version: string }).version;

type Entry = { path: string; type: "file" | "dir"; mode: number; data: Buffer };

/** Reads a .tgz: plain ustar headers only, which is all the packager may write. */
function untar(tgz: Buffer): Entry[] {
  const tar = gunzipSync(tgz);
  const out: Entry[] = [];
  const text = (b: Buffer) => b.toString("utf8").replace(/\0.*$/s, "");
  for (let at = 0; at + 512 <= tar.length; ) {
    const h = tar.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    expect(text(h.subarray(257, 262)), "ustar magic").toBe("ustar");
    const prefix = text(h.subarray(345, 500));
    const path = (prefix ? prefix + "/" : "") + text(h.subarray(0, 100));
    const size = parseInt(text(h.subarray(124, 136)).trim(), 8);
    const flag = String.fromCharCode(h[156]);
    expect(["0", "5"], `${path}: entry type`).toContain(flag);
    // The header's checksum: the sum of its bytes with the checksum field as spaces.
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    expect(parseInt(text(h.subarray(148, 156)).trim(), 8), `${path}: checksum`).toBe(sum);
    out.push({ path, type: flag === "5" ? "dir" : "file", mode: parseInt(text(h.subarray(100, 108)).trim(), 8), data: Buffer.from(tar.subarray(at + 512, at + 512 + size)) });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** Every file under a folder of the repository, as paths from the repository root. */
function walk(rel: string): string[] {
  return readdirSync(join(ROOT, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${rel}/${e.name}`) : [`${rel}/${e.name}`]));
}

describe("the cPanel archive", () => {
  let result: PackageResult;
  let entries: Entry[];
  let files: Entry[];
  const decoys = [join(ROOT, "dist", "cpanel", "decoy-earlier-archive.tgz"), join(ROOT, "dist", "decoy-stale-build.js")];

  beforeAll(async () => {
    // Leftovers a real checkout has in dist/: an earlier archive and a stale build file.
    mkdirSync(join(ROOT, "dist", "cpanel"), { recursive: true });
    for (const d of decoys) writeFileSync(d, "decoy\n");
    result = await packageCpanel({ root: ROOT, log: () => {} });
    entries = untar(readFileSync(result.file));
    files = entries.filter((e) => e.type === "file");
  }, 180_000);

  afterAll(() => {
    for (const d of decoys) rmSync(d, { force: true });
  });

  it("is written to dist/cpanel under the version from package.json", () => {
    expect(result.version).toBe(VERSION);
    expect(result.file).toBe(join(ROOT, "dist", "cpanel", `demo-platform-${VERSION}-cpanel.tgz`));
    expect(existsSync(result.file)).toBe(true);
  });

  it("holds exactly the listed top-level entries", () => {
    expect([...ARCHIVE_TOP_LEVEL].sort()).toEqual(["VERSION", "app.cjs", "cpanel.sh", "dist", "migrations", "package-lock.json", "package.json"]);
    expect([...new Set(entries.map((e) => e.path.split("/")[0]))].sort()).toEqual([...ARCHIVE_TOP_LEVEL].sort());
    for (const top of ["dist", "migrations"]) expect(entries.find((e) => e.path === `${top}/`)?.type, top).toBe("dir");
    for (const top of ["VERSION", "app.cjs", "cpanel.sh", "package-lock.json", "package.json"]) expect(files.some((e) => e.path === top), top).toBe(true);
    // No path is absolute, climbs out of the folder it is unpacked in, or is listed twice.
    for (const e of entries) expect(e.path, e.path).not.toMatch(/^\/|(^|\/)\.\.(\/|$)|\\/);
    expect(new Set(entries.map((e) => e.path)).size).toBe(entries.length);
  });

  it("carries the files of the repository unchanged", () => {
    const get = (p: string) => files.find((e) => e.path === p)?.data;
    expect(get("package.json")?.equals(read("package.json"))).toBe(true);
    expect(get("package-lock.json")?.equals(read("package-lock.json"))).toBe(true);
    expect(get("app.cjs")?.equals(read("deploy/cpanel/app.cjs"))).toBe(true);
    expect(get("cpanel.sh")?.equals(read("deploy/cpanel/cpanel.sh"))).toBe(true);
    expect(get("VERSION")?.toString("utf8")).toBe(`${VERSION}\n`);
    const migrations = walk("migrations").sort();
    expect(files.filter((e) => e.path.startsWith("migrations/")).map((e) => e.path).sort()).toEqual(migrations);
    for (const m of migrations) expect(get(m)?.equals(read(m)), m).toBe(true);
    // Shell scripts must not carry Windows line ends, wherever the archive was built.
    expect(get("cpanel.sh")?.includes(13)).toBe(false);
    expect(get("app.cjs")?.includes(13)).toBe(false);
  });

  it("the script can be run as unpacked; everything else is a plain file", () => {
    for (const e of entries) {
      if (e.type === "dir") expect(e.mode, e.path).toBe(0o755);
      else expect(e.mode, e.path).toBe(e.path === "cpanel.sh" ? 0o755 : 0o644);
    }
  });

  it("dist holds the fresh Node build and nothing else", () => {
    const dist = files.filter((e) => e.path.startsWith("dist/")).map((e) => e.path);
    // One compiled file for every source file of the Node build, and no other file.
    const sources = walk("src")
      .filter((p) => p.endsWith(".ts") && !p.startsWith("src/cloudflare/") && p !== "src/player/main.ts" && !p.startsWith("src/player/vendor/"))
      .map((p) => p.replace(/^src\//, "dist/").replace(/\.ts$/, ".js"));
    expect(dist.sort()).toEqual(sources.sort());
    expect(dist).toContain("dist/node/entry.js");
    expect(dist).toContain("dist/node/backup.js");
    // The player's script and stylesheet travel inside the build, as text.
    const assets = files.find((e) => e.path === "dist/player/assets.js")?.data.toString("utf8") ?? "";
    expect(assets).toContain("PLAYER_JS");
    expect(assets).toContain("PLAYER_CSS");
    // The start file's import target runs as a module: it imports, and it is not empty.
    expect(files.find((e) => e.path === "dist/node/entry.js")?.data.toString("utf8")).toMatch(/^import /m);
  });

  it("holds no source, test, settings, dependency or leftover file", () => {
    for (const e of entries) {
      const p = e.path;
      expect(p, p).not.toMatch(/(^|\/)(node_modules|src|test|tests|scripts|deploy|docs|\.git|\.wrangler|data|\.data)(\/|$)/);
      expect(p, p).not.toMatch(/(^|\/)\.(env|dev\.vars)/);
      expect(p, p).not.toMatch(/\.(ts|map|sqlite|tgz|tar|gz|log)$/);
      expect(p, p).not.toMatch(/^dist\/(cpanel|cloudflare)(\/|$)/);
      expect(p, p).not.toMatch(/decoy/);
    }
    // The archive itself, and an earlier one beside it, are not swallowed into a new one.
    expect(existsSync(decoys[0])).toBe(true);
  });

  it("the system's tar lists the same entries", (ctx) => {
    // Run in the archive's folder with a relative name: GNU tar reads "C:" as a host name.
    const r = spawnSync("tar", ["-tzf", basename(result.file)], { cwd: dirname(result.file), encoding: "utf8", windowsHide: true });
    if (r.error || r.status === null) return ctx.skip("no tar program on this system");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout.split(/\r?\n/).filter(Boolean).sort()).toEqual(entries.map((e) => e.path).sort());
  });

  it("git ignores the output folder", (ctx) => {
    const r = spawnSync("git", ["check-ignore", "-q", "dist/cpanel/demo-platform-0.0.0-cpanel.tgz"], { cwd: ROOT, windowsHide: true });
    if (r.error || r.status === null || r.status > 1) return ctx.skip("git is not available, or this is not a checkout");
    expect(r.status).toBe(0);
  });

  it("can write somewhere else, and says so", async () => {
    const out = mkdtempSync(join(tmpdir(), "dp-cpanel-pkg-"));
    try {
      const lines: string[] = [];
      const again = await packageCpanel({ root: ROOT, outDir: out, log: (l) => lines.push(l) });
      expect(again.file).toBe(join(out, `demo-platform-${VERSION}-cpanel.tgz`));
      expect(untar(readFileSync(again.file)).map((e) => e.path)).toEqual(entries.map((e) => e.path));
      expect(lines.join("\n")).toContain(again.file);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 180_000);
});

describe("the archive writer", () => {
  it("refuses a path a plain tar header cannot hold, and unsafe paths", () => {
    const f = (path: string) => ({ path, data: Buffer.from("x"), mode: 0o644 });
    expect(() => tarGz([f("a/" + "b".repeat(101))], 0)).toThrow(/too long/);
    expect(() => tarGz([f("../outside")], 0)).toThrow(/unsafe path/);
    expect(() => tarGz([f("/etc/passwd")], 0)).toThrow(/unsafe path/);
    expect(() => tarGz([f("a/b"), f("a/b")], 0)).toThrow(/twice/);
  });

  it("splits a long path between the name and prefix fields, and adds each folder once", () => {
    const long = `${"d".repeat(60)}/${"e".repeat(60)}/file.js`;
    const got = untar(tarGz([{ path: long, data: Buffer.from("hello"), mode: 0o644 }, { path: "top.txt", data: Buffer.alloc(0), mode: 0o755 }], 0));
    expect(got.map((e) => e.path)).toEqual([`${"d".repeat(60)}/`, `${"d".repeat(60)}/${"e".repeat(60)}/`, long, "top.txt"]);
    expect(got[2].data.toString("utf8")).toBe("hello");
    expect(got[3].mode).toBe(0o755);
  });
});
