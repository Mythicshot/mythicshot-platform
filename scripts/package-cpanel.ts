// npm run package:cpanel: builds the Node target and writes one archive for shared
// cPanel hosting, dist/cpanel/demo-platform-<version>-cpanel.tgz. Unpacked, it holds
// exactly: dist/ (the compiled app, with the player's and the documentation page's files inside it),
// migrations/, package.json, package-lock.json, app.cjs (the startup file), cpanel.sh
// (install, update, backup, status) and VERSION. No source, no tests, no settings and no
// node_modules: the hosting installs the two runtime packages itself with npm ci.
//
// The build goes into a scratch folder, not into dist/, so nothing stale in dist/ and no
// earlier archive in dist/cpanel can end up inside a new one. The archive is written
// here, without a tar program, so that cpanel.sh is executable and every line end is as
// committed whichever system the archive is built on.
//
// Tests: test/node-cpanel-package.test.ts. The guide: docs/hosting/cpanel.md.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { siteModule, viewerModule } from "./docs-bundle.ts";
import { assetsModule } from "./player-bundle.ts";

/** What the unpacked archive holds at its top level, and nothing else. */
export const ARCHIVE_TOP_LEVEL = ["dist", "migrations", "package.json", "package-lock.json", "app.cjs", "cpanel.sh", "VERSION"] as const;

export type ArchiveFile = { path: string; data: Buffer; mode: number };
export type PackageResult = { file: string; version: string; paths: string[] };
export type PackageOptions = {
  /** The repository checkout to package. */
  root: string;
  /** Where the archive goes; `<root>/dist/cpanel` when left out. */
  outDir?: string;
  log?: (line: string) => void;
};

/** One 512-byte ustar header. */
function header(path: string, size: number, mode: number, type: "0" | "5", mtime: number): Buffer {
  let name = path;
  let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    // The path is split at a slash: at most 155 bytes before it, at most 100 after.
    let cut = -1;
    for (let i = path.indexOf("/"); i !== -1 && i < path.length - 1; i = path.indexOf("/", i + 1)) {
      if (Buffer.byteLength(path.slice(0, i)) <= 155 && Buffer.byteLength(path.slice(i + 1)) <= 100) cut = i;
    }
    if (cut === -1) throw new Error(`path too long for the archive: ${path}`);
    prefix = path.slice(0, cut);
    name = path.slice(cut + 1);
  }
  const h = Buffer.alloc(512);
  const octal = (value: number, width: number) => value.toString(8).padStart(width - 1, "0") + "\0";
  h.write(name, 0, 100, "utf8");
  h.write(octal(mode, 8), 100, 8, "ascii");
  h.write(octal(0, 8), 108, 8, "ascii"); // owner and group 0: tar unpacks as the user running it
  h.write(octal(0, 8), 116, 8, "ascii");
  h.write(octal(size, 12), 124, 12, "ascii");
  h.write(octal(mtime, 12), 136, 12, "ascii");
  h.write("        ", 148, 8, "ascii");
  h.write(type, 156, 1, "ascii");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  h.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return h;
}

/**
 * A gzip-compressed tar archive of the given files, sorted by path, with an entry for
 * each folder (mode 755) before the files in it. Paths use forward slashes and stay
 * inside the folder the archive is unpacked in. `mtime` is in seconds.
 */
export function tarGz(files: ArchiveFile[], mtime: number): Buffer {
  const seen = new Set<string>();
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.path.split("/");
    if (f.path === "" || f.path.includes("\\") || parts.some((p) => p === "" || p === "." || p === "..")) throw new Error(`unsafe path for the archive: ${f.path}`);
    if (seen.has(f.path)) throw new Error(`path given twice: ${f.path}`);
    seen.add(f.path);
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/") + "/");
  }
  const all = [...[...dirs].map((path) => ({ path, data: Buffer.alloc(0), mode: 0o755, dir: true })), ...files.map((f) => ({ ...f, dir: false }))];
  all.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const blocks: Buffer[] = [];
  for (const e of all) {
    blocks.push(header(e.path, e.data.length, e.mode, e.dir ? "5" : "0", mtime));
    if (e.data.length > 0) blocks.push(e.data, Buffer.alloc((512 - (e.data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

/** Every file under `dir`, as forward-slash paths from it. */
function filesUnder(dir: string, rel = ""): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const path = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) return filesUnder(dir, path);
    if (!e.isFile()) throw new Error(`not a plain file: ${join(dir, path)}`);
    return [path];
  });
}

/** Compiles the Node target into `<stage>/dist`, with the compiler installed in the checkout. */
function compile(root: string, stage: string): Promise<void> {
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(tsc)) throw new Error("the TypeScript compiler is not installed; run npm ci first");
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [tsc, "-p", "tsconfig.build.json", "--outDir", join(stage, "dist")], { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    child.on("error", fail);
    child.on("close", (code) => (code === 0 ? done() : fail(new Error(`the build failed (tsc exited with ${code}):\n${output.trim()}`))));
  });
}

/** Builds the Node target and writes the archive. Changes nothing in the checkout but the archive. */
export async function packageCpanel(opts: PackageOptions): Promise<PackageResult> {
  const root = resolve(opts.root);
  const log = opts.log ?? ((line: string) => console.log(line));
  const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown }).version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("package.json has no plain x.y.z version");

  // The player's script and stylesheet are compiled into dist/ from a generated source
  // file; a stale one would ship an old player.
  if (readFileSync(join(root, "src", "player", "assets.ts"), "utf8") !== (await assetsModule())) {
    throw new Error("src/player/assets.ts is out of date; run npm run build:player, commit the result and package again");
  }
  // The same for the documentation page: the viewer's files and our own, with the API description.
  const docsModules: [string, string][] = [["viewer-assets.ts", viewerModule()], ["site-assets.ts", await siteModule()]];
  for (const [name, current] of docsModules) {
    if (readFileSync(join(root, "src", "docs", name), "utf8") !== current) {
      throw new Error(`src/docs/${name} is out of date; run npm run build:docs, commit the result and package again`);
    }
  }

  const stage = mkdtempSync(join(tmpdir(), "demo-platform-cpanel-"));
  try {
    log(`Building version ${version} for Node`);
    await compile(root, stage);
    const files: ArchiveFile[] = [];
    const add = (path: string, from: string, mode = 0o644) => files.push({ path, data: readFileSync(from), mode });
    for (const p of filesUnder(join(stage, "dist"))) add(`dist/${p}`, join(stage, "dist", p));
    for (const p of filesUnder(join(root, "migrations"))) add(`migrations/${p}`, join(root, "migrations", p));
    add("package.json", join(root, "package.json"));
    add("package-lock.json", join(root, "package-lock.json"));
    add("app.cjs", join(root, "deploy", "cpanel", "app.cjs"));
    add("cpanel.sh", join(root, "deploy", "cpanel", "cpanel.sh"), 0o755);
    files.push({ path: "VERSION", data: Buffer.from(`${version}\n`, "utf8"), mode: 0o644 });

    // Checks on what is about to ship, so a change to the build cannot widen it unseen.
    if (!files.some((f) => f.path === "dist/node/entry.js")) throw new Error("the build has no dist/node/entry.js");
    // The mail worker is loaded by path at run time, beside the mailer, so no import names it.
    if (!files.some((f) => f.path === "dist/node/mail-worker.js")) throw new Error("the build has no dist/node/mail-worker.js");
    const top: readonly string[] = ARCHIVE_TOP_LEVEL;
    for (const f of files) {
      if (!top.includes(f.path.split("/")[0])) throw new Error(`not part of the archive: ${f.path}`);
      if (f.path.startsWith("dist/") && !f.path.endsWith(".js")) throw new Error(`unexpected file in the build: ${f.path}`);
      if (f.path.startsWith("migrations/") && !/^migrations\/[^/]+\.sql$/.test(f.path)) throw new Error(`unexpected file in migrations: ${f.path}`);
    }
    for (const name of ["app.cjs", "cpanel.sh"]) {
      if (files.find((f) => f.path === name)?.data.includes(13)) throw new Error(`${name} has Windows line ends; check it out again with LF line ends`);
    }

    const outDir = resolve(opts.outDir ?? join(root, "dist", "cpanel"));
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `demo-platform-${version}-cpanel.tgz`);
    const partial = `${file}.partial`;
    writeFileSync(partial, tarGz(files, Math.floor(Date.now() / 1000)));
    renameSync(partial, file);
    log(`Wrote ${file} (${files.length} files)`);
    return { file, version, paths: files.map((f) => f.path).sort() };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await packageCpanel({ root: fileURLToPath(new URL("..", import.meta.url)) });
    console.log("Next: upload the archive to the hosting and follow docs/hosting/cpanel.md.");
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : "packaging failed");
    process.exit(1);
  }
}
