// node scripts/rehearse-fixture.ts <empty folder>
//
// Makes what the upgrade rehearsal (scripts/rehearse-upgrade.ts) runs on, with no network:
// - builds of the two released versions, 0.1.7 (commit 34b53cb) and 0.1.8 (commit 2cd568f),
//   and of this checkout's HEAD, each in <folder>/builds/<name>. Each is `git archive` of
//   that commit unpacked with tar, compiled with this checkout's TypeScript. The runtime
//   packages are this checkout's node_modules, reached through a directory junction (a
//   symbolic link elsewhere), which is only done when the commit's package-lock.json names
//   exactly the same packages as this checkout's; otherwise it stops and says so.
// - a data folder written by each released build through its own routes, in the shape
//   of a backup folder made by cpanel.sh: <folder>/data-0.1.7 and <folder>/data-0.1.8, each
//   with db.sqlite (a VACUUM INTO copy, as the backup makes), drafts/ and public/, and a
//   settings file with a made-up mailbox password, which the rehearsal must not copy.
// - the token of each, in <folder>/token-0.1.7.txt and <folder>/token-0.1.8.txt. They are
//   made up here, for these folders only.
//
// What each data folder holds, all made by the build's own routes on 127.0.0.1: the setup
// wizard's claim and its token; tour 1 with three chapters, a logo and a cover, published,
// then one chapter replaced and the tour published again (the previous public pictures
// wait out their ten-minute grace), then a fourth chapter added that is not published yet,
// and the tour renamed; tour 2 with two chapters, a draft; tour 3 published and then
// unpublished; tour 4 of 130 steps, published and then deleted with one delete call, so 10
// of its files are still to be removed; and an upload that was started, sent one picture
// of three and never finished. The pictures are small real PNG files.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { fetchAnswer, freePort, spawnBuild, stopBuild, waitReady, type Running } from "./rehearse-upgrade.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
export const RELEASES: { name: string; commit: string }[] = [
  { name: "0.1.7", commit: "34b53cb" },
  { name: "0.1.8", commit: "2cd568f" },
];
const HOST = "localhost";

/** A real PNG of one colour: signature, IHDR, one IDAT and IEND, with their CRCs. */
export function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** The package list of a lockfile, without the project's own version, for comparing two of them. */
function packagesOf(lock: string): string {
  const parsed = JSON.parse(lock) as { packages?: Record<string, Record<string, unknown>> };
  const packages = { ...parsed.packages };
  if (packages[""] !== undefined) packages[""] = { ...packages[""], version: null };
  return JSON.stringify(packages);
}

/** `git archive` of one commit of this checkout, unpacked into `dir`, compiled, with this checkout's packages. */
export function buildCommit(commit: string, dir: string, log: (l: string) => void): void {
  mkdirSync(dir, { recursive: true });
  const tar = join(dir, "..", `${commit}.tar`);
  execFileSync("git", ["-C", REPO, "archive", "--format=tar", "-o", tar, commit, "src", "migrations", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json"], { stdio: "pipe" });
  // Relative names only: one tar takes "C:" in a path for the name of a remote machine.
  execFileSync("tar", ["-xf", join("..", `${commit}.tar`)], { cwd: dir, stdio: "pipe" });
  rmSync(tar, { force: true });
  if (packagesOf(readFileSync(join(dir, "package-lock.json"), "utf8")) !== packagesOf(readFileSync(join(REPO, "package-lock.json"), "utf8"))) {
    throw new Error(`commit ${commit} locks other packages than this checkout; install them there with npm ci --offline instead of the junction`);
  }
  symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"), "junction");
  execFileSync(process.execPath, [join(REPO, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"], { cwd: dir, stdio: "pipe" });
  if (!existsSync(join(dir, "dist", "node", "entry.js"))) throw new Error(`commit ${commit} built no dist/node/entry.js`);
  log(`built ${commit} in ${dir}`);
}

type Step = { image: string; width: number; height: number; bytes: number };
type Picture = { name: string; data: Buffer };

/** `count` pictures of 320 x 180, each its own colour from `seed`. */
function pictures(count: number, seed: number): Picture[] {
  return Array.from({ length: count }, (_, i) => {
    const n = seed * 37 + i * 11;
    return { name: `step-${String(i + 1).padStart(3, "0")}.png`, data: solidPng(320, 180, [n % 256, (n * 3) % 256, (n * 7) % 256]) };
  });
}

/** A version 3 manifest for the pictures, with a cover and its logo when `logo` is set. */
function manifest(title: string, pics: Picture[], logo: boolean): Record<string, unknown> {
  const steps = pics.map((p, i) => ({
    image: p.name,
    width: 320,
    height: 180,
    bytes: p.data.length,
    click: i % 3 === 2 ? null : { x: 20 + (i % 60), y: 30 + (i % 60) },
    t_ms: 500 * (i + 1),
    spotlight: i === 0 ? { x: 10, y: 10, w: 30, h: 20 } : null,
    notes: i === 0 ? [{ kind: "text", x: 12.5, y: 8, text: `Start with ${title}`, size: 4.17, color: "#ffffff" }] : [],
    card: { title: `Step ${i + 1}`, body: "", next_label: "Next", anchor: i % 3 === 2 ? "none" : "hotspot", point: null, placement: "auto" },
    advance: "hotspot",
    zoom: null,
  })) satisfies (Step & Record<string, unknown>)[];
  return {
    version: 3,
    generator: "rehearsal fixture",
    title,
    steps,
    spotlight_dim: 60,
    theme: { card_style: "dark", accent: "#5dcaa5", hotspot: "pulse", progress_bar: true, backdrop: "auto", spotlight_soft: true },
    zoom: { enabled: true, percent: 118 },
    cover: logo ? { title, body: "A tour made for the upgrade rehearsal.", button: "Start", logo: "logo.png" } : null,
    cta: null,
    end: { text: "That is all.", primary: null, secondary: null, replay: true },
    autoplay: { enabled: false, seconds: 5 },
  };
}

/** Drives one running build through its routes. Every unexpected answer stops with the route and status only. */
class Driver {
  private readonly port: number;
  constructor(port: number) {
    this.port = port;
  }

  async call(method: string, path: string, opts: { token?: string; json?: unknown; body?: Buffer; headers?: Record<string, string> } = {}): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = { ...opts.headers };
    let body: string | Uint8Array | undefined;
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      headers["content-type"] = "application/json";
    } else if (opts.body !== undefined) body = new Uint8Array(opts.body);
    const a = await fetchAnswer(this.port, method, path, HOST, { ...(opts.token === undefined ? {} : { token: opts.token }), ...(body === undefined ? {} : { body }), headers });
    let json: any = null;
    try {
      json = JSON.parse(new TextDecoder().decode(a.body));
    } catch {
      json = null;
    }
    return { status: a.status, json };
  }

  async expect(status: number | number[], method: string, path: string, opts: Parameters<Driver["call"]>[2] = {}): Promise<any> {
    const r = await this.call(method, path, opts);
    const ok = Array.isArray(status) ? status.includes(r.status) : r.status === status;
    if (!ok) throw new Error(`${method} ${path.replace(/[0-9a-f]{24}/g, ":id")} answered ${r.status}${r.json?.error ? ` ${r.json.error}` : ""}${r.json?.detail ? `: ${r.json.detail}` : ""}`);
    return r.json;
  }

  /** Create an upload, send its pictures (all, or the first `send`), and the logo when the manifest has one. */
  async upload(token: string, m: Record<string, unknown>, pics: Picture[], target: Record<string, unknown>, send = pics.length): Promise<string> {
    const created = await this.expect(201, "POST", "/api/v1/uploads", { token, json: { manifest: m, target } });
    const id = created.upload_id as string;
    for (let i = 0; i < send; i++) await this.expect(204, "PUT", `/api/v1/uploads/${id}/steps/${i + 1}`, { token, body: pics[i].data });
    if (m.cover !== null && target.kind === "new") await this.expect(204, "PUT", `/api/v1/uploads/${id}/logo`, { token, body: solidPng(64, 64, [200, 40, 90]) });
    return id;
  }

  async commit(token: string, id: string): Promise<{ tour_id: string; chapter_id: string }> {
    return this.expect(201, "POST", `/api/v1/uploads/${id}/commit`, { token });
  }

  async publish(token: string, tourId: string): Promise<void> {
    let r = await this.expect([200, 202], "POST", `/api/v1/tours/${tourId}/publish`, { token });
    for (let i = 0; r.status === "in_progress" && i < 200; i++) {
      r = await this.expect([200, 202], "POST", `/api/v1/tours/${tourId}/publish`, { token, json: { publish_id: r.publish_id } });
    }
    if (r.status === "in_progress") throw new Error("publish did not finish");
  }

  async unpublish(token: string, tourId: string): Promise<void> {
    for (let i = 0; i < 50; i++) {
      const r = await this.call("POST", `/api/v1/tours/${tourId}/unpublish`, { token });
      if (r.status === 204 || r.status === 200) return;
      if (r.status !== 202) throw new Error(`unpublish answered ${r.status}`);
    }
    throw new Error("unpublish did not finish");
  }
}

/** Writes one site through the build running on `port`, and returns its token. */
async function writeSite(port: number, setupCode: string): Promise<string> {
  const d = new Driver(port);
  const origin = { origin: `http://${HOST}` };
  await d.expect(204, "POST", "/setup/check", { json: { code: setupCode }, headers: origin });
  const claim = await d.expect(201, "POST", "/setup/claim", { json: { code: setupCode, workspace: "Rehearsal workspace", email: "owner@example.com" }, headers: origin });
  const token = claim.token as string;

  // Tour 1: three chapters, a cover with a logo, published; then a chapter replaced and the tour renamed.
  const one = pictures(3, 1);
  const t1 = await d.commit(token, await d.upload(token, manifest("Send an invoice", one, true), one, { kind: "new" }));
  const ch2 = pictures(2, 2);
  const c2 = await d.commit(token, await d.upload(token, manifest("Add a customer", ch2, false), ch2, { kind: "chapter", tour_id: t1.tour_id }));
  const ch3 = pictures(3, 3);
  await d.commit(token, await d.upload(token, manifest("Get paid", ch3, false), ch3, { kind: "chapter", tour_id: t1.tour_id }));
  await d.publish(token, t1.tour_id);
  const again = pictures(3, 4);
  await d.commit(token, await d.upload(token, manifest("Add a customer, again", again, false), again, { kind: "replace", tour_id: t1.tour_id, chapter_id: c2.chapter_id }));
  await d.publish(token, t1.tour_id);
  const ch4 = pictures(2, 10);
  await d.commit(token, await d.upload(token, manifest("Send a reminder", ch4, false), ch4, { kind: "chapter", tour_id: t1.tour_id }));
  await d.expect(200, "PATCH", `/api/v1/tours/${t1.tour_id}`, { token, json: { title: "Send and track an invoice" } });

  // Tour 2: a draft of two chapters.
  const two = pictures(2, 5);
  const t2 = await d.commit(token, await d.upload(token, manifest("Set up taxes", two, false), two, { kind: "new" }));
  const two2 = pictures(2, 6);
  await d.commit(token, await d.upload(token, manifest("Tax rates", two2, false), two2, { kind: "chapter", tour_id: t2.tour_id }));

  // Tour 3: published, then unpublished.
  const three = pictures(2, 7);
  const t3 = await d.commit(token, await d.upload(token, manifest("Old pricing page", three, false), three, { kind: "new" }));
  await d.publish(token, t3.tour_id);
  await d.unpublish(token, t3.tour_id);

  // Tour 4: 130 steps, published, then one delete call: 260 files, 250 removed per call.
  const four = pictures(130, 8);
  const t4 = await d.commit(token, await d.upload(token, manifest("A tour to delete", four, false), four, { kind: "new" }));
  await d.publish(token, t4.tour_id);
  const deleted = await d.expect(202, "DELETE", `/api/v1/tours/${t4.tour_id}`, { token });
  if (deleted.status !== "in_progress") throw new Error("the delete did not leave files to remove");

  // An upload started, one picture of three sent, never finished.
  const open = pictures(3, 9);
  await d.upload(token, manifest("Unfinished", open, false), open, { kind: "new" }, 1);
  return token;
}

/** Writes the data folder of one released build: run it, drive it, stop it, then copy it as a backup does. */
async function makeData(build: string, out: string, name: string, log: (l: string) => void): Promise<void> {
  const live = join(out, "work", `live-${name}`);
  const dest = join(out, `data-${name}`);
  mkdirSync(live, { recursive: true });
  const setupCode = "rehearsal-setup-" + Math.random().toString(16).slice(2).padEnd(12, "0");
  const port = await freePort();
  const r: Running = spawnBuild(build, live, "one", join(out, "work"), port, { SETUP_CODE: setupCode });
  let token: string;
  try {
    await waitReady(r, [HOST]);
    token = await writeSite(port, setupCode);
  } finally {
    await stopBuild(r);
  }
  if (r.err.length > 0) log(`note: the ${name} build wrote ${r.err.length} line(s) to its error output`);
  mkdirSync(dest, { recursive: true });
  // As cpanel.sh backup does: a consistent single-file copy made by SQLite, then the two folders.
  const db = new DatabaseSync(join(live, "db.sqlite"));
  try {
    db.prepare("VACUUM INTO ?").run(join(dest, "db.sqlite"));
  } finally {
    db.close();
  }
  for (const store of ["drafts", "public"]) if (existsSync(join(live, store))) cpSync(join(live, store), join(dest, store), { recursive: true });
  writeFileSync(join(dest, "tours-config.env"), "DATA_DIR=/home/you/apps/tours-data\nMAIL_MODE=off\nSMTP_PASSWORD=made-up-for-the-rehearsal\n", { mode: 0o600 });
  writeFileSync(join(out, `token-${name}.txt`), token + "\n", { mode: 0o600 });
  log(`wrote data-${name} and token-${name}.txt`);
}

export async function makeFixture(out: string, log: (l: string) => void): Promise<void> {
  const root = resolve(out);
  if (existsSync(root) && readdirSync(root).length > 0) throw new Error("give an empty or new folder");
  mkdirSync(join(root, "builds"), { recursive: true });
  for (const { name, commit } of RELEASES) buildCommit(commit, join(root, "builds", name), log);
  buildCommit("HEAD", join(root, "builds", "new"), log);
  for (const { name } of RELEASES) await makeData(join(root, "builds", name), root, name, log);
  rmSync(join(root, "work"), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  log("next: npm run rehearse:upgrade -- <folder>/data-0.1.7 <folder>/builds/0.1.7 <folder>/builds/new --tokens-file <folder>/token-0.1.7.txt");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (out === undefined) {
    console.error("usage: node scripts/rehearse-fixture.ts <empty folder>");
    process.exit(2);
  }
  makeFixture(out, (l) => console.log(l)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : "making the fixture failed");
    process.exit(1);
  });
}
