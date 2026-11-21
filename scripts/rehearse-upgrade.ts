// npm run rehearse:upgrade -- <data folder> <old build> <new build> [--mode one|two|three] [--tokens-file <file>]
//
// Rehearses an update on a copy of a site's data, on this computer only, and says plainly
// whether the new build serves that site exactly as the old one did, and whether the old
// one still does after the new one has migrated the database (the update keeps the
// previous version as the way back, without a restore).
//
// - <data folder> is a data folder or a backup folder made by cpanel.sh: db.sqlite (with
//   its -wal and -shm files, if any), drafts/ and public/. It is never written to and never
//   opened by SQLite: those three are copied into a scratch folder first, and nothing else
//   in it (the settings file, the app archive) is copied at all. The folder's files are
//   hashed at the start and again at the end, to show it was left as it was.
// - <old build> and <new build> are folders holding dist/node/entry.js, migrations/ and
//   package.json, with the two runtime packages installed (an unpacked cPanel archive after
//   `npm ci --omit=dev`, or a checkout after `npm run build`).
// - The mode is `one` (one address, the default), `two` (TOURS_HOST and APP_HOST set to
//   the placeholders tours.example.com and app.example.com) or `three` (IMG_HOST set to
//   img.example.com as well), from --mode or REHEARSE_MODE; never from the data. With
//   `three`, a build that does not know the img address (any before 0.1.19, seen from its
//   own compiled files: knowsImgRole) runs with two addresses instead; that is allowed for
//   the old build only, and the report says so in one line.
// - The tokens whose view of the site is compared come from REHEARSE_TOKENS (separated by
//   spaces, commas or line ends) or from a file named by --tokens-file, one per line. They
//   are never printed and never written anywhere.
//
// Each build is the real Node entry, started as a child process on 127.0.0.1 and a free
// port with only the settings above and CLIENT_ADDRESS_HEADER (no mail, no setup code), as
// behind a proxy (PROXY_SETTINGS). Requests carry the Host header the mode needs and the
// proxy's header with a documentation address, and go nowhere but 127.0.0.1.
//
// What is checked, in order: the old build on the copy (health, then per token the tour
// list, the usage when the build has it, the workspace, every listed tour's public page and
// every picture on it); the new build on the same copy, which applies the pending
// migrations as it starts; every answer byte for byte (scripts/rehearse-compare.ts holds
// the short allow-list), both stores file for file, every row of the old tables in the
// columns they had, the accounts tables and their backfill, SQLite's own checks, and the
// list of applied migrations; the old build again on the migrated copy; then, on a fresh
// copy, one tour restricted through the new build's API (restrictedWayBack) and the old
// build started on it, which must serve nothing of that tour; then, on another fresh copy, one
// shared item restricted the same way (restrictedItemWayBack: one is shared through the new
// build's API first when token 1's workspace has none) and the old build started on it, which
// must answer every address of that item as one that does not exist; then two new builds
// started at the same moment on a fresh copy. The report is one line per check,
// PASS or FAIL, with counts; the exit status is 1 when any check failed.
//
// The full rehearsal starts servers, so it is not part of npm test. The comparisons are
// tested in test/node-rehearse.test.ts. Synthetic data and builds of the released
// versions to run it on: scripts/rehearse-fixture.ts. The guide: docs/hosting/cpanel.md,
// "Rehearse an update on a copy of a backup".
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ACCOUNT_TABLES,
  addedFieldCount,
  identityProblems,
  playerFileProblems,
  playerFilesIn,
  PAGE_ROUTE,
  checkAccountsBackfill,
  compareAnswers,
  compareRows,
  compareStores,
  gateProblems,
  migrationProblems,
  servesNoPicture,
  tourContentOf,
  type TourContent,
  storesSame,
  usageFromRows,
  usageProblems,
  type Answer,
  type Cell,
  type DbSnapshot,
  type Recorded,
  type StoreListing,
} from "./rehearse-compare.ts";
import { SESSION_COOKIE, csrfFor } from "../src/sessions.ts";

export type Mode = "one" | "two" | "three";
export const MODES: readonly Mode[] = ["one", "two", "three"];

/** The Host header of each address. With one address the name is never checked, so any fixed name does. */
export const HOSTS: Record<Mode, { tours: string; app: string; img?: string }> = {
  one: { tours: "localhost", app: "localhost" },
  two: { tours: "tours.example.com", app: "app.example.com" },
  three: { tours: "tours.example.com", app: "app.example.com", img: "img.example.com" },
};

/**
 * Every address a build of the mode has, each checked for health when it starts: one
 * name with one address, tours and app with two, and img as well with three.
 */
export function healthHosts(mode: Mode): string[] {
  const h = HOSTS[mode];
  if (mode === "one") return [h.app];
  return h.img === undefined ? [h.tours, h.app] : [h.tours, h.app, h.img];
}

/** The roles a build's health answers must report on those addresses, in the same order: none asked with one address (the answer is taken as today), each address's own with two or three. */
export function healthRoles(mode: Mode): (string | null)[] {
  if (mode === "one") return [null];
  return HOSTS[mode].img === undefined ? ["tours", "app"] : ["tours", "app", "img"];
}

/**
 * Whether a build knows the img address (IMG_HOST, from 0.1.19), from its own compiled
 * files and never by starting it: its host roles (HOST_ROLES in dist/hosts.js) list
 * "img", and its Node settings (dist/node/config.js) read "IMG_HOST". An older build
 * ignores IMG_HOST, so its img address would answer as no address of the site.
 */
export function knowsImgRole(buildDir: string): boolean {
  const read = (...p: string[]) => {
    try {
      return readFileSync(join(buildDir, ...p), "utf8");
    } catch {
      return "";
    }
  };
  const roles = /\bHOST_ROLES\s*=\s*\[([^\]]*)\]/.exec(read("dist", "hosts.js"));
  return roles !== null && /["']img["']/.test(roles[1]) && /["']IMG_HOST["']/.test(read("dist", "node", "config.js"));
}

/**
 * Whether a build can serve restricted tours (from 0.1.44), from its own compiled files and
 * never by starting it, nor from the data or its version number: its app (dist/app.js)
 * imports restrictedAnswer from ./restricted.js and hands it to the page routes, and that
 * file (dist/restricted.js) has the restricted picture route /t/:slug/v/:name. Such a build
 * answers a restricted tour's page with its gate (403, fixed text) to a visitor who proved
 * no address; an older one knows nothing of the setting and answers as for no tour at all.
 */
export function knowsRestrictedServing(buildDir: string): boolean {
  const read = (...p: string[]) => {
    try {
      return readFileSync(join(buildDir, ...p), "utf8");
    } catch {
      return "";
    }
  };
  const app = read("dist", "app.js");
  const imports = /import\s*\{[^}]*\brestrictedAnswer\b[^}]*\}\s*from\s*["']\.\/restricted\.js["']/.test(app);
  const handed = /\bpageRoutes\(\s*app\s*,\s*deps\s*,\s*restrictedAnswer\s*\)/.test(app);
  const route = /\.get\(\s*["']\/t\/:slug\/v\/:name["']/.test(read("dist", "restricted.js"));
  return imports && handed && route;
}

/**
 * The mode each build runs with: the asked one, except that with `three` an old build that
 * does not know the img address runs with `two`, and `note` is the report's line saying
 * so. A new build that does not know it cannot be rehearsed with three addresses.
 */
export function buildModes(asked: Mode, old: { version: string; knowsImg: boolean }, next: { version: string; knowsImg: boolean }): { old: Mode; next: Mode; note: string | null } {
  if (asked !== "three") return { old: asked, next: asked, note: null };
  if (!next.knowsImg) throw new Error(`the new build ${next.version} does not know the img address (IMG_HOST, from 0.1.19); rehearse it with --mode two`);
  if (old.knowsImg) return { old: "three", next: "three", note: null };
  return { old: "two", next: "three", note: `the old build ${old.version} does not know the img address, which came in 0.1.19: it runs with two addresses, the new build with three` };
}

const LOOPBACK = "127.0.0.1";

/**
 * The rehearsal stands in for a site behind a proxy, as every install is (cPanel, the
 * container behind its tunnel): every build runs with the setting that names the header the
 * proxy writes the visitor's address in, and every request carries that header with one
 * fixed documentation address (RFC 5737), so a build sees a known client address as it does
 * in production. Without it, a build from 0.1.26 on sees requests from 127.0.0.1 and writes
 * its one line that a proxy hides every visitor's address. A build before the setting came
 * (0.1.7 and 0.1.8 read neither the setting nor any forwarded header) ignores both.
 */
export const PROXY_SETTINGS: Readonly<Record<string, string>> = { CLIENT_ADDRESS_HEADER: "X-Forwarded-For" };
export const CLIENT_ADDRESS = "203.0.113.7";
const TOKEN = /^dp_[0-9a-f]{40}$/;
/** The accounts migration, whose tables and backfill are checked when the update applies it. */
export const ACCOUNTS_MIGRATION = "0008_accounts.sql";
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;

/** A port nothing listens on at this moment, on 127.0.0.1. */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, LOOPBACK, () => {
      const a = s.address();
      const port = typeof a === "object" && a !== null ? a.port : 0;
      s.close(() => resolvePort(port));
    });
  });
}

/**
 * Loaded before the app with --import: the app listens on every interface when given only
 * a port, so here a listen with no host gets 127.0.0.1, and the address actually bound is
 * written on its own line for the rehearsal to check. Nothing of the app is changed.
 */
const PRELOAD = `import net from "node:net";
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  if (typeof args[0] === "number" && (args[1] === undefined || args[1] === null || typeof args[1] === "function")) {
    if (typeof args[1] === "function") args.splice(1, 0, "${LOOPBACK}"); else args[1] = "${LOOPBACK}";
  } else if (args[0] !== null && typeof args[0] === "object" && args[0].path === undefined && args[0].host === undefined) {
    args[0] = { ...args[0], host: "${LOOPBACK}" };
  }
  this.once("listening", () => {
    const a = this.address();
    if (a !== null && typeof a === "object") process.stdout.write("rehearse-bound " + a.address + " " + a.port + "\\n");
  });
  return listen.apply(this, args);
};
`;

/** Writes the preload into `workDir` once and returns its address for --import. */
function preloadIn(workDir: string): string {
  const file = join(workDir, "listen-on-loopback.mjs");
  if (!existsSync(file)) writeFileSync(file, PRELOAD);
  return pathToFileURL(file).href;
}

/** Every build this process started and has not seen exit, so none outlives the rehearsal. */
const running = new Set<ChildProcess>();
/** The scratch folder of a rehearsal in progress: it holds a copy of real data, so it is removed even on Ctrl-C (best effort). */
let scratch: string | null = null;
process.on("exit", () => {
  for (const c of running) c.kill("SIGKILL");
  if (scratch !== null) rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

export type Running = { port: number; child: ChildProcess; out: string[]; err: string[]; exited: Promise<number | null>; startedAt: number };

/** The environment a build is started with: what Node itself needs to run, and the given settings, nothing else. */
function childEnv(settings: Record<string, string>): NodeJS.ProcessEnv {
  const keep = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LANG"];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...settings };
}

/** The settings of a mode: none for one address, the two placeholder names for two, and the img one as well for three. */
export function modeSettings(mode: Mode): Record<string, string> {
  if (mode === "one") return {};
  const h = HOSTS[mode];
  return h.img === undefined ? { TOURS_HOST: h.tours, APP_HOST: h.app } : { TOURS_HOST: h.tours, APP_HOST: h.app, IMG_HOST: h.img };
}

/** Starts a build's Node entry on `dataDir` and a free port. Does not wait for it; see waitReady. */
export function spawnBuild(build: string, dataDir: string, mode: Mode, workDir: string, port: number, extra: Record<string, string> = {}): Running {
  const entry = join(build, "dist", "node", "entry.js");
  const child = spawn(process.execPath, ["--import", preloadIn(workDir), entry], {
    cwd: build,
    env: childEnv({ ...PROXY_SETTINGS, ...modeSettings(mode), ...extra, DATA_DIR: dataDir, PORT: String(port) }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const out: string[] = [];
  const err: string[] = [];
  child.stdout?.setEncoding("utf8").on("data", (d: string) => out.push(...d.split(/\r?\n/).filter(Boolean)));
  child.stderr?.setEncoding("utf8").on("data", (d: string) => err.push(...d.split(/\r?\n/).filter(Boolean)));
  running.add(child);
  const exited = new Promise<number | null>((done) =>
    child.once("exit", (code) => {
      running.delete(child);
      done(code);
    }),
  );
  return { port, child, out, err, exited, startedAt: Date.now() };
}

/**
 * Waits until the build has bound 127.0.0.1 on its port and every address answers its health
 * check. When `roles` names a role for a host, the health answer there must report it
 * (`"address"`, the role the build sees the host in): a build that does not take a host's
 * setting, such as one given IMG_HOST that does not know it, answers there as no address of
 * the site, and fails at once with a line naming the placeholder host and the roles only.
 */
export async function waitReady(r: Running, hosts: string[], roles: (string | null)[] = []): Promise<void> {
  let gone = false;
  void r.exited.then(() => (gone = true));
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (gone) throw new Error("the build stopped while starting");
    const bound = r.out.find((l) => l.startsWith("rehearse-bound "));
    if (bound !== undefined) {
      if (bound !== `rehearse-bound ${LOOPBACK} ${r.port}`) throw new Error("the build did not listen on 127.0.0.1 only");
      let ok = true;
      for (const [i, host] of hosts.entries()) {
        let a: Answer;
        try {
          a = await fetchAnswer(r.port, "GET", "/healthz", host);
        } catch {
          ok = false;
          continue;
        }
        if (a.status !== 200) {
          ok = false;
          continue;
        }
        const want = roles[i] ?? null;
        if (want === null) continue;
        const said = jsonOf(a)?.address;
        if (said === want) continue;
        const as = said === undefined || said === null ? "no address of the site" : typeof said === "string" && KNOWN_ROLES.includes(said) ? `the ${said} address` : "something else";
        throw new Error(`the build answers health on ${host} as ${as}, not as the ${want} address`);
      }
      if (ok) return;
    }
    await new Promise((d) => setTimeout(d, 100));
  }
  throw new Error("the build did not answer its health check in time");
}

/**
 * The error lines a build may write that the report repeats word for word: the app's own
 * fixed lines, none of which holds a value. Any other line could hold data (an id, a reason
 * from a mail server), so it is named by its length only.
 */
export const KNOWN_ERROR_LINES: readonly string[] = [
  "client address: requests come from a private or local address, which is how a proxy in front of the app looks; set CLIENT_ADDRESS_HEADER to the header your proxy writes the visitor's address in, or the limits per network (signing in, connecting the app) cannot tell visitors apart",
  "client address: unknown, because CLIENT_ADDRESS_HEADER is not a usable header name. The site runs; no request is counted by its network address.",
  "background: work after an answer failed",
  "page: a published snapshot is malformed; answering 404",
  "share: an online item's part is missing or has the wrong length; answering 404",
  "media: could not remove loose files of an item; a later send, commit or sweep removes them",
  "media: could not remove replaced files; a later send, commit or sweep removes them",
  "media: could not remove an object that was not stored; the item's delete or sweep removes it",
  "media: could not remove replaced files of a finished item; the sweep removes them",
  "sweep: could not look for unfinished items; will retry later",
  "sweep: could not look for abandoned uploads; will retry later",
  "delete: could not remove some files of a deleted item; the next delete call retries",
  "delete: could not remove some files of a deleted tour; the next delete call retries",
  "publish: could not remove old public images; will retry later",
  "replace: could not remove replaced pictures; will retry later",
];

/** One line per distinct error line, in the order first seen: a known one word for word, any other by its length only. */
export function errorLineProblems(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of [...new Set(lines)]) {
    out.push(KNOWN_ERROR_LINES.includes(line) ? `a known message: ${line}` : `an error line that is not one of the known messages (${line.length} ${line.length === 1 ? "character" : "characters"})`);
  }
  return out;
}

export type PairStart = { spread: number; startProblems: string[]; errors: string[]; answers: Recorded[] | null; ports: number[] };

/**
 * Two new builds started at the same moment on one data folder: both must start and answer
 * health on every address with its role; then the site is recorded from the first, both are
 * stopped, and every line either wrote to its error output is given back.
 */
export async function startPair(build: string, dataDir: string, mode: Mode, workDir: string, tokens: string[], extra: Record<string, string> = {}): Promise<PairStart> {
  const ports = [await freePort(), await freePort()];
  const pair = ports.map((p) => spawnBuild(build, dataDir, mode, workDir, p, extra));
  const spread = Math.abs(pair[1].startedAt - pair[0].startedAt);
  const ready = await Promise.allSettled(pair.map((r) => waitReady(r, healthHosts(mode), healthRoles(mode))));
  let answers: Recorded[] | null = null;
  try {
    if (ready.every((x) => x.status === "fulfilled")) answers = await recordSite(pair[0].port, mode, tokens);
  } finally {
    await Promise.all(pair.map((r) => stopBuild(r)));
  }
  const startProblems = ready.flatMap((x, i) => (x.status === "rejected" ? [`process ${i + 1}: ${x.reason instanceof Error ? x.reason.message : "did not start"}`] : []));
  return { spread, startProblems, errors: pair.flatMap((r) => r.err), answers, ports };
}

/** Stops a build: SIGTERM (on Windows the process is ended at once), then a kill if it does not exit. */
export async function stopBuild(r: Running): Promise<void> {
  if (r.child.exitCode !== null || r.child.signalCode !== null) return;
  r.child.kill("SIGTERM");
  const timer = setTimeout(() => r.child.kill("SIGKILL"), STOP_TIMEOUT_MS);
  await r.exited;
  clearTimeout(timer);
}

/** One request to 127.0.0.1 with the given Host header, read whole. */
export function fetchAnswer(port: number, method: string, path: string, host: string, opts: { token?: string; body?: string | Uint8Array; headers?: Record<string, string> } = {}): Promise<Answer> {
  return new Promise((done, fail) => {
    const headers: Record<string, string> = { host, "x-forwarded-for": CLIENT_ADDRESS, ...opts.headers };
    if (opts.token !== undefined) headers.authorization = "Bearer " + opts.token;
    if (opts.body !== undefined) headers["content-length"] = String(Buffer.byteLength(opts.body));
    const req = httpRequest({ host: LOOPBACK, port, method, path, headers, agent: false, setHost: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const h: Record<string, string> = {};
        for (let i = 0; i < res.rawHeaders.length; i += 2) {
          const name = res.rawHeaders[i].toLowerCase();
          h[name] = name in h ? `${h[name]}, ${res.rawHeaders[i + 1]}` : res.rawHeaders[i + 1];
        }
        done({ status: res.statusCode ?? 0, headers: h, body: new Uint8Array(Buffer.concat(chunks)) });
      });
      res.on("error", fail);
    });
    req.on("error", fail);
    req.setTimeout(30_000, () => req.destroy(new Error("request timed out")));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** The roles a health answer may report that the report repeats by name; any other value is never printed. */
const KNOWN_ROLES: readonly string[] = ["tours", "app", "img"];

const decoder = new TextDecoder();
function jsonOf(a: Answer): any {
  try {
    return JSON.parse(decoder.decode(a.body));
  } catch {
    return null;
  }
}

/** The picture addresses a tour page names: every step's image and the cover logo, after the page's own base. */
export function pictureAddresses(html: string): string[] | null {
  const m = /<script type="application\/json" id="tour">([\s\S]*?)<\/script>/.exec(html);
  if (m === null) return null;
  let data: any;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const base = typeof data?.base === "string" ? data.base : "";
  const names: string[] = [];
  for (const ch of data?.tour?.chapters ?? []) for (const st of ch?.steps ?? []) if (typeof st?.image === "string") names.push(st.image);
  if (typeof data?.tour?.cover?.logo === "string") names.push(data.tour.cover.logo);
  return names.map((n) => `${base}/${n}`);
}

/**
 * Every request the rehearsal compares, with its answer, labelled without any data: the
 * health of each address; the tour list without a token and with an unknown one; per token
 * (by its number) the workspace, the tour list and the usage on each address, and for
 * every listed tour (by its place in the list) its page and every picture the page names.
 * With three addresses these are the very requests of two, on the tours and app addresses,
 * so a build with three compares with one with two; the img address's health is checked
 * when the build starts (waitReady with healthHosts).
 */
export async function recordSite(port: number, mode: Mode, tokens: string[]): Promise<Recorded[]> {
  const out: Recorded[] = [];
  const { tours, app } = HOSTS[mode];
  const several = mode !== "one";
  const apiHosts = several ? [["app", app], ["tours", tours]] : [["one", app]];
  const add = async (key: string, method: string, routePath: string, path: string, host: string, token?: string) => {
    const answer = await fetchAnswer(port, method, path, host, token === undefined ? {} : { token });
    out.push({ key, route: `${method} ${routePath}`, answer });
    return answer;
  };
  for (const [label, host] of several ? [["tours", tours], ["app", app]] : [["one", app]]) {
    await add(`health (${label} address)`, "GET", "/healthz", "/healthz", host);
  }
  await add("no token: tour list", "GET", "/api/v1/tours", "/api/v1/tours", app);
  await add("unknown token: tour list", "GET", "/api/v1/tours", "/api/v1/tours", app, "dp_" + "0".repeat(40));
  for (const [i, token] of tokens.entries()) {
    const who = `token ${i + 1}`;
    let list: any = null;
    for (const [label, host] of apiHosts) {
      await add(`${who}: workspace (${label} address)`, "GET", "/api/v1/me", "/api/v1/me", host, token);
      const l = await add(`${who}: tour list (${label} address)`, "GET", "/api/v1/tours", "/api/v1/tours", host, token);
      list ??= l.status === 200 ? jsonOf(l) : null;
      await add(`${who}: usage (${label} address)`, "GET", "/api/v1/usage", "/api/v1/usage", host, token);
    }
    const listed: any[] = Array.isArray(list?.tours) ? list.tours : [];
    for (const [j, t] of listed.entries()) {
      if (typeof t?.slug !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(t.slug)) continue;
      const tourKey = `${who}: tour ${j + 1}`;
      const page = await add(`${tourKey} page`, "GET", "/t/:slug", `/t/${t.slug}`, tours);
      if (several) await add(`${tourKey} page (app address)`, "GET", "/t/:slug", `/t/${t.slug}`, app);
      if (page.status !== 200) continue;
      const pictures = pictureAddresses(decoder.decode(page.body)) ?? [];
      for (const [k, address] of pictures.entries()) {
        if (!address.startsWith("/p/")) continue; // a picture on another host is not this server's to answer
        await add(`${tourKey} picture ${k + 1}`, "GET", "/p/:name", address, tours);
      }
    }
  }
  return out;
}

export type PlayerFiles = { files: number; failed: number; problems: string[] };

/**
 * Asks, on the tours address, every distinct player file (script and stylesheet) the
 * recorded tour pages that answered 200 name in their own two tags (playerFilesIn), and
 * checks each answers 200 with its type. Problems name a file by its kind and number only.
 */
export async function checkPlayerFiles(port: number, host: string, answers: Recorded[]): Promise<PlayerFiles> {
  const names = new Set<string>();
  for (const r of answers) if (r.route === PAGE_ROUTE && r.answer.status === 200) for (const n of playerFilesIn(r.answer.body)) names.add(n);
  const problems: string[] = [];
  let failed = 0;
  const counts = { css: 0, js: 0 };
  for (const name of [...names].sort((a, b) => Number(a.endsWith(".js")) - Number(b.endsWith(".js")) || (a < b ? -1 : 1))) {
    const kind = name.endsWith(".css") ? "css" : "js";
    const label = `${kind === "css" ? "stylesheet" : "script"} ${++counts[kind]}`;
    const p = playerFileProblems(name, await fetchAnswer(port, "GET", name, host));
    if (p.length > 0) {
      failed++;
      problems.push(`${label}: ${p.join(", ")}`);
    }
  }
  return { files: names.size, failed, problems };
}

/** Every file under drafts/ and public/ of a data folder, with its size and SHA-256. */
export function listStores(dataDir: string): StoreListing {
  const out: StoreListing = new Map();
  for (const store of ["drafts", "public"]) {
    const root = join(dataDir, store);
    if (!existsSync(root)) continue;
    for (const file of walk(root)) {
      const data = readFileSync(file);
      out.set(`${store}/${relative(root, file).split(sep).join("/")}`, { size: data.length, sha256: createHash("sha256").update(data).digest("hex") });
    }
  }
  return out;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** A hash of every file of a folder, by its relative path: the proof that it was left alone. */
export function hashTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of walk(dir)) out.set(relative(dir, file), createHash("sha256").update(readFileSync(file)).digest("hex"));
  return out;
}

function cell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "bigint") return `bigint:${v.toString()}`;
  if (v instanceof Uint8Array) return `blob:${Buffer.from(v).toString("hex")}`;
  return `other:${String(v)}`;
}

export type DbRead = { snapshot: DbSnapshot; migrations: string[]; foreignKeyProblems: number; integrity: string };

/**
 * Reads every table of a copy's database (never the given folder's), table by table, and
 * runs SQLite's own two checks. Only SELECT and PRAGMA statements are run.
 */
export function readDb(dbPath: string): DbRead {
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  try {
    const snapshot: DbSnapshot = {};
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name <> '_migrations' ORDER BY name").all() as { name: string }[];
    for (const { name } of tables) {
      const columns = (db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map((c) => c.name);
      const rows = (db.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[]).map((r) => columns.map((c) => cell(r[c])));
      snapshot[name] = { columns, rows };
    }
    const hasMigrations = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = '_migrations'").get() !== undefined;
    const migrations = hasMigrations ? (db.prepare("SELECT name FROM _migrations ORDER BY name").all() as { name: string }[]).map((r) => r.name) : [];
    const foreignKeyProblems = db.prepare("PRAGMA foreign_key_check").all().length;
    const integrity = (db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[]).map((r) => r.integrity_check).join("; ");
    return { snapshot, migrations, foreignKeyProblems, integrity };
  } finally {
    db.close();
  }
}

/** Copies the database files and the two stores of `from` into `to`, and nothing else. */
export function copyData(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  if (!existsSync(join(from, "db.sqlite"))) throw new Error("the data folder holds no db.sqlite");
  for (const f of ["db.sqlite", "db.sqlite-wal", "db.sqlite-shm"]) if (existsSync(join(from, f))) cpSync(join(from, f), join(to, f));
  for (const d of ["drafts", "public"]) if (existsSync(join(from, d))) cpSync(join(from, d), join(to, d), { recursive: true });
}

export type BuildInfo = { dir: string; version: string; migrations: string[] };

/** What a build folder is: its version (package.json or VERSION) and its migration files. */
export function buildInfo(dir: string): BuildInfo {
  const root = resolve(dir);
  if (!existsSync(join(root, "dist", "node", "entry.js"))) throw new Error("a build folder must hold dist/node/entry.js");
  if (!existsSync(join(root, "migrations"))) throw new Error("a build folder must hold migrations/");
  let version = "unknown";
  try {
    version = String(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? "unknown");
  } catch {
    if (existsSync(join(root, "VERSION"))) version = readFileSync(join(root, "VERSION"), "utf8").trim();
  }
  const migrations = readdirSync(join(root, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  return { dir: root, version, migrations };
}

/** The tokens from REHEARSE_TOKENS or a file, checked for their form; a bad one is refused without being repeated. */
export function readTokens(env: NodeJS.ProcessEnv, file: string | null): string[] {
  const raw = file !== null ? readFileSync(file, "utf8") : (env.REHEARSE_TOKENS ?? "");
  const tokens = raw.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) throw new Error("give at least one token, in REHEARSE_TOKENS or in a file named by --tokens-file");
  tokens.forEach((t, i) => {
    if (!TOKEN.test(t)) throw new Error(`token ${i + 1} is not a token (dp_ and 40 lowercase hex characters)`);
  });
  return tokens;
}

export type Args = { data: string; old: string; next: string; mode: Mode; tokensFile: string | null };

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): Args {
  const positional: string[] = [];
  let mode = env.REHEARSE_MODE?.trim() || "one";
  let tokensFile: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode") mode = argv[++i] ?? "";
    else if (a.startsWith("--mode=")) mode = a.slice(7);
    else if (a === "--tokens-file") tokensFile = argv[++i] ?? "";
    else if (a.startsWith("--tokens-file=")) tokensFile = a.slice(14);
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 3) throw new Error("usage: rehearse-upgrade <data folder> <old build> <new build> [--mode one|two|three] [--tokens-file <file>]");
  if (!(MODES as readonly string[]).includes(mode)) throw new Error("the mode is one, two or three");
  return { data: resolve(positional[0]), old: positional[1], next: positional[2], mode: mode as Mode, tokensFile };
}

/** The report: one line per check, and for a failed check one indented line per problem. */
class Report {
  readonly lines: string[] = [];
  failed = 0;
  private readonly print: (line: string) => void;
  constructor(print: (line: string) => void) {
    this.print = print;
  }
  line(text: string): void {
    this.lines.push(text);
    this.print(text);
  }
  check(ok: boolean, text: string, problems: string[] = []): boolean {
    this.line(`${ok ? "PASS" : "FAIL"}  ${text}`);
    if (!ok) {
      this.failed++;
      for (const p of problems.slice(0, 40)) this.line(`        ${p}`);
      if (problems.length > 40) this.line(`        and ${problems.length - 40} more`);
    }
    return ok;
  }
}

const MODE_WORDS: Record<Mode, string> = { one: "one address", two: "two addresses", three: "three addresses" };

type Phase = { answers: Recorded[]; stores: StoreListing; startedDb: DbRead; endDb: DbRead; playerFiles: PlayerFiles | null };

/**
 * One build on one data folder: start it, read the database as it is once the build is up
 * (the migrations it applied at start included, no request made yet), ask every request
 * twice and keep the second answers (the first lets work that is due anyway, such as
 * removing pictures past their grace, happen in every phase alike), stop it, and read the
 * stores and the database again.
 */
async function runPhase(build: BuildInfo, dataDir: string, mode: Mode, workDir: string, tokens: string[], report: Report, what: string, askPlayerFiles = false): Promise<Phase | null> {
  const port = await freePort();
  const r = spawnBuild(build.dir, dataDir, mode, workDir, port);
  const hosts = healthHosts(mode);
  try {
    await waitReady(r, hosts, healthRoles(mode));
  } catch (err) {
    await stopBuild(r);
    const said = r.err.map((l) => l.split(workDir).join("<scratch>")).slice(-3);
    report.check(false, `${what}: starts on 127.0.0.1 and answers health on ${hosts.length} address(es)`, [err instanceof Error ? err.message : "did not start", ...said]);
    return null;
  }
  report.check(true, `${what}: starts on 127.0.0.1 and answers health on ${hosts.length} address(es)`);
  const startedDb = readDb(join(dataDir, "db.sqlite"));
  let answers: Recorded[];
  let playerFiles: PlayerFiles | null = null;
  try {
    await recordSite(port, mode, tokens);
    answers = await recordSite(port, mode, tokens);
    if (askPlayerFiles) playerFiles = await checkPlayerFiles(port, HOSTS[mode].tours, answers);
  } finally {
    await stopBuild(r);
  }
  return { answers, stores: listStores(dataDir), startedDb, endDb: readDb(join(dataDir, "db.sqlite")), playerFiles };
}

const tokenHash = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

/**
 * The report's last line: `RESULT: FAIL (...)` when a check failed; otherwise `RESULT: PASS`,
 * or, when the new build's answers added fields, `RESULT: PASS, with N added fields to read
 * above` (N: the field paths listed, over all routes). The exit status is 0 for both: an added
 * field is allowed, but it is to be read before updating, because a new field can also be a leak.
 */
export function resultLine(failed: number, addedFields: number): string {
  const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
  if (failed > 0) return `RESULT: FAIL (${plural(failed, "check")} failed)`;
  return addedFields === 0 ? "RESULT: PASS" : `RESULT: PASS, with ${plural(addedFields, "added field")} to read above`;
}

/**
 * The settings the new build runs with to restrict a tour on the scratch copy: one address
 * (a session counts only from a page of its own address, which the rehearsal's plain-HTTP
 * requests can be only on a local name), an address for links, and a mail setting whose
 * server is never contacted (restricting needs a site that can mail; nothing is mailed by it).
 * The mail settings must be complete for mail to be on (mailFromEnv in src/node/config.ts),
 * so they hold a user and a password too: placeholders that are plainly not real, for a
 * server on the discard port of 127.0.0.1 that no build ever connects to here.
 */
export const RESTRICT_SETTINGS: Readonly<Record<string, string>> = {
  SITE_HOST: "localhost",
  MAIL_MODE: "smtp",
  MAIL_FROM: "rehearsal@example.com",
  SMTP_HOST: "127.0.0.1",
  SMTP_PORT: "9",
  SMTP_USER: "rehearsal",
  SMTP_PASSWORD: "not-a-real-password",
};

const ERROR_CODE = /^[a-z_]{1,40}$/;

/**
 * The line for a refused change of who views a tour: its status and, when the answer is a
 * JSON object whose `error` is shaped like one of the API's codes (lowercase letters and
 * underscores, at most 40), that code in brackets. No other part of the body is ever shown.
 */
export function refusalLine(a: Answer): string {
  const code = jsonOf(a)?.error;
  return typeof code === "string" && ERROR_CODE.test(code) ? `the change answered ${a.status} (${code})` : `the change answered ${a.status}`;
}

/** A session for the account of the token's workspace, written into the scratch copy only (made the site's admin there when the copy has none, which signing in needs). Null when the workspace has no account. */
export async function scratchSession(dbPath: string, token: string): Promise<{ cookie: string; csrf: string } | null> {
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  try {
    const row = db.prepare("SELECT m.user_id AS user_id FROM api_token k JOIN membership m ON m.workspace_id = k.workspace_id WHERE k.hash = ? LIMIT 1").get(tokenHash(token)) as { user_id: string } | undefined;
    if (row === undefined) return null;
    db.prepare("UPDATE user SET is_admin = 1 WHERE id = ? AND NOT EXISTS (SELECT 1 FROM user WHERE is_admin = 1)").run(row.user_id);
    db.prepare("UPDATE user SET status = 'active' WHERE id = ?").run(row.user_id);
    const secret = "dps_" + createHash("sha256").update(String(Math.random()) + Date.now()).digest("hex");
    const now = Date.now();
    db.prepare("INSERT INTO session (id, user_id, hash, label, created_at, last_used_at, expires_at) VALUES (?, ?, ?, 'rehearsal', ?, ?, ?)").run(
      "ses_" + createHash("sha256").update(secret).digest("hex").slice(0, 24),
      row.user_id,
      createHash("sha256").update(secret, "utf8").digest("hex"),
      now,
      now,
      now + 86_400_000,
    );
    return { cookie: `${SESSION_COOKIE}=${secret}`, csrf: await csrfFor(secret) };
  } finally {
    db.close();
  }
}

/**
 * The way back with a restricted tour, on a fresh scratch copy: the new build (it migrates)
 * restricts one of the first token's tours through its own API (publishing one first when
 * none is published), then the old build is started on that copy and must serve nothing of
 * that tour: its page answers as for a tour that does not exist, and so does every picture
 * the tour's page named while it was public. One report line for the restriction, one for
 * the way back. With an old build from before restricted tours this is the case that
 * matters: it knows nothing of the setting.
 *
 * An old build that can serve restricted tours (knowsRestrictedServing, from its compiled
 * files) answers the page with its gate instead, to a request without a viewer cookie: then
 * the page must be a fixed 403 that no cache may store (no-store), carries no etag, cannot be framed and holds
 * nothing of what the tour's public page showed (gateProblems, from tourContentOf, kept in
 * memory and never printed), and every picture address and restricted picture address
 * (/t/<slug>/v/<name>) must answer as an unknown picture (servesNoPicture).
 */
async function restrictedWayBack(args: Args, oldBuild: BuildInfo, newBuild: BuildInfo, oldMode: Mode, work: string, tokens: string[], report: Report): Promise<void> {
  const what = "way back with a restricted tour";
  const copy = join(work, "restricted");
  copyData(args.data, copy);
  const host = HOSTS.one.app;
  const port = await freePort();
  const r = spawnBuild(newBuild.dir, copy, "one", work, port, RESTRICT_SETTINGS);
  let slug: string | null = null;
  let pictures: string[] = [];
  // What the tour showed of itself while public, kept in memory only and never printed.
  let content: TourContent | null = null;
  try {
    try {
      await waitReady(r, healthHosts("one"), healthRoles("one"));
    } catch {
      report.check(false, `${what}: the new build starts on a fresh copy to restrict a tour`, r.err.slice(-3).map((l) => l.split(work).join("<scratch>")));
      return;
    }
    const token = tokens[0];
    const list = jsonOf(await fetchAnswer(port, "GET", "/api/v1/tours", host, { token }))?.tours as { id: string; slug: string; status: string }[] | undefined;
    const tour = list?.find((t) => t.status === "published") ?? list?.[0];
    if (tour === undefined) {
      report.check(false, `${what}: token 1's workspace has a tour to restrict`, ["it has none, so the way back with a restricted tour could not be tried; rehearse with data that holds a tour"]);
      return;
    }
    if (tour.status !== "published") {
      let p = await fetchAnswer(port, "POST", `/api/v1/tours/${tour.id}/publish`, host, { token });
      for (let i = 0; p.status === 202 && i < 60; i++) {
        p = await fetchAnswer(port, "POST", `/api/v1/tours/${tour.id}/publish`, host, { token, body: JSON.stringify({ publish_id: jsonOf(p)?.publish_id }), headers: { "content-type": "application/json" } });
      }
      if (p.status !== 200) {
        report.check(false, `${what}: the tour to restrict is published first`, [`publish answered ${p.status}`]);
        return;
      }
    }
    slug = tour.slug;
    const publicHtml = decoder.decode((await fetchAnswer(port, "GET", `/t/${slug}`, host)).body);
    pictures = pictureAddresses(publicHtml) ?? [];
    content = tourContentOf(publicHtml, tour.id);
    // Without the page's pictures the way back could pass for want of anything to ask: fail.
    if (!report.check(pictures.length > 0, `${what}: the tour's public page names its pictures (${pictures.length})`, ["the tour's page named no picture, or could not be read, so the way back could not be checked"])) return;
    const session = await scratchSession(join(copy, "db.sqlite"), token);
    if (session === null) {
      report.check(false, `${what}: token 1's workspace has an account to sign in with`, ["it has none, so no session could change the tour"]);
      return;
    }
    const headers = { cookie: session.cookie, "x-csrf-token": session.csrf, origin: `http://${host}`, "sec-fetch-site": "same-origin", "content-type": "application/json" };
    let a = await fetchAnswer(port, "PUT", `/api/v1/tours/${tour.id}/access`, host, { body: JSON.stringify({ access: "me" }), headers });
    for (let i = 0; a.status === 202 && i < 100; i++) a = await fetchAnswer(port, "PUT", `/api/v1/tours/${tour.id}/access`, host, { body: JSON.stringify({ access: "me" }), headers });
    if (!report.check(a.status === 200 && jsonOf(a)?.access === "me", `${what}: the new build restricted one tour of token 1 (${pictures.length} pictures) through its API`, [refusalLine(a)])) return;
  } finally {
    await stopBuild(r);
  }

  const oldPort = await freePort();
  const old = spawnBuild(oldBuild.dir, copy, oldMode, work, oldPort);
  try {
    try {
      await waitReady(old, healthHosts(oldMode), healthRoles(oldMode));
    } catch {
      report.check(false, `${what}: the old build ${oldBuild.version} starts on that copy`, old.err.slice(-3).map((l) => l.split(work).join("<scratch>")));
      return;
    }
    const tours = HOSTS[oldMode].tours;
    const same = (x: Answer, y: Answer) => x.status === y.status && Buffer.from(x.body).equals(Buffer.from(y.body));
    const problems: string[] = [];
    const page = await fetchAnswer(oldPort, "GET", `/t/${slug}`, tours);
    if (knowsRestrictedServing(oldBuild.dir)) {
      // A build from 0.1.44 on serves restricted tours: to a visitor who proved no address it
      // answers the gate, fixed text, and nothing of the tour by any address.
      if (content === null) {
        report.check(false, `${what}: the tour's public page could be read for its content`, ["the page held no tour data, so the old build's gate could not be checked"]);
        return;
      }
      problems.push(...gateProblems(page, content));
      const unknownPicture = await fetchAnswer(oldPort, "GET", `/p/${"0".repeat(32)}.png`, tours);
      let asUnknown = 0;
      for (const [i, address] of pictures.entries()) {
        if (servesNoPicture(await fetchAnswer(oldPort, "GET", address, tours), unknownPicture)) asUnknown++;
        else problems.push(`picture ${i + 1} was served by its public address`);
      }
      const unknownRestricted = await fetchAnswer(oldPort, "GET", `/t/${slug}/v/${"0".repeat(32)}.png`, tours);
      let routeUnknown = 0;
      for (const [i, name] of content.names.entries()) {
        const bare = name.slice(name.lastIndexOf("/") + 1);
        if (servesNoPicture(await fetchAnswer(oldPort, "GET", `/t/${slug}/v/${bare}`, tours), unknownRestricted)) routeUnknown++;
        else problems.push(`picture ${i + 1} was served by the restricted picture route`);
      }
      report.check(
        problems.length === 0,
        `${what}: old build ${oldBuild.version} serves restricted tours, and answers its gate with nothing of the tour (page: a fixed 403, no-store, no etag, not framable; ${asUnknown} of ${pictures.length} picture addresses and ${routeUnknown} of ${content.names.length} restricted picture addresses as unknown)`,
        problems,
      );
      return;
    }
    const unknownPage = await fetchAnswer(oldPort, "GET", "/t/aaaaaaaaaa", tours);
    if (!same(page, unknownPage)) problems.push(`the tour's page answered ${page.status}, not as a tour that does not exist`);
    const unknownPicture = await fetchAnswer(oldPort, "GET", `/p/${"0".repeat(32)}.png`, tours);
    let served = 0;
    for (const [i, address] of pictures.entries()) {
      const pic = await fetchAnswer(oldPort, "GET", address, tours);
      if (!same(pic, unknownPicture)) {
        served++;
        problems.push(`picture ${i + 1} answered ${pic.status}`);
      }
    }
    report.check(problems.length === 0, `${what}: old build ${oldBuild.version} serves nothing of it (page as unknown, ${pictures.length - served} of ${pictures.length} pictures as unknown)`, problems);
  } finally {
    await stopBuild(old);
  }
}

/**
 * Whether a build knows who may view a shared item (from 0.1.47), from its own compiled files:
 * it has dist/media-access.js with the access routes. Such a build answers a restricted item
 * with its gate; an older one knows nothing of the setting.
 */
export function knowsItemAccess(buildDir: string): boolean {
  try {
    return /\.put\(\s*["']\/api\/v1\/media\/:id\/access["']/.test(readFileSync(join(buildDir, "dist", "media-access.js"), "utf8"));
  } catch {
    return false;
  }
}

/** A PNG header for width x height, padded to `total` bytes: what the item routes take as a PNG (they read the type and size from the first bytes). */
function rehearsalPng(width: number, height: number, total: number): Uint8Array {
  const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(width), ...be32(height), 8, 6, 0, 0, 0];
  const out = new Uint8Array(total).fill(0x5a);
  out.set(head);
  return out;
}

const ITEM_EXT: Readonly<Record<string, string>> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "video/mp4": "mp4" };

/**
 * The way back with a restricted shared item, on a fresh scratch copy. The new build (it
 * migrates) restricts one online item of the first token's workspace through its own API, to
 * `me`; when the workspace has none, it first shares a small image through the same API, and
 * the report says so. Then the old build is started on that copy. An old build from before
 * 0.1.47 knows nothing of the setting, which is the case that matters: the item's page, file,
 * download and preview must each answer exactly as the same address of an item that does not
 * exist (the item's link id is out of the column such a build looks it up by, migration 0016),
 * and no answer may hold the file's bytes. An old build that knows the setting
 * (knowsItemAccess) must answer each with its gate instead: 403, no-store, no ETag, and none of
 * the file's bytes. The item's link and bytes are kept in memory only, never printed.
 */
async function restrictedItemWayBack(args: Args, oldBuild: BuildInfo, newBuild: BuildInfo, oldMode: Mode, work: string, tokens: string[], report: Report): Promise<void> {
  const what = "way back with a restricted item";
  const copy = join(work, "restricted-item");
  copyData(args.data, copy);
  const host = HOSTS.one.app;
  const port = await freePort();
  const r = spawnBuild(newBuild.dir, copy, "one", work, port, RESTRICT_SETTINGS);
  let page = "";
  let file = "";
  let bytes: Uint8Array | null = null;
  try {
    try {
      await waitReady(r, healthHosts("one"), healthRoles("one"));
    } catch {
      report.check(false, `${what}: the new build starts on a fresh copy to restrict an item`, r.err.slice(-3).map((l) => l.split(work).join("<scratch>")));
      return;
    }
    const token = tokens[0];
    type Item = { id: string; path: string; content_type: string };
    let found: Item | undefined;
    for (const kind of ["image", "clip"]) {
      found ??= (jsonOf(await fetchAnswer(port, "GET", `/api/v1/media?kind=${kind}`, host, { token }))?.items as Item[] | undefined)?.[0];
    }
    if (found === undefined) {
      // None to restrict: one is shared through the new build's API, on this scratch copy only.
      const json = { "content-type": "application/json" };
      const png = rehearsalPng(8, 8, 1200);
      const made = await fetchAnswer(port, "POST", "/api/v1/media", host, { token, headers: json, body: JSON.stringify({ kind: "image", content_type: "image/png", bytes: png.length, width: 8, height: 8, title: "Rehearsal" }) });
      const id = jsonOf(made)?.id;
      const part = typeof id === "string" ? await fetchAnswer(port, "PUT", `/api/v1/media/${id}/parts/0`, host, { token, body: png }) : null;
      const done = typeof id === "string" ? await fetchAnswer(port, "POST", `/api/v1/media/${id}/commit`, host, { token }) : null;
      if (!report.check(made.status === 201 && part?.status === 204 && done?.status === 200, `${what}: token 1's workspace had no shared item, so one was shared through the new build's API`, [`the create answered ${made.status}, the part ${part?.status ?? "-"}, the commit ${done?.status ?? "-"}`])) return;
      found = { id, path: jsonOf(done!)?.path, content_type: "image/png" };
    }
    page = found.path;
    file = `${page}.${ITEM_EXT[found.content_type] ?? "png"}`;
    const before = await fetchAnswer(port, "GET", file, host);
    if (!report.check(before.status === 200 && before.body.length > 0, `${what}: the item's file is served while it is public (${before.body.length} bytes)`, [`the file answered ${before.status}`])) return;
    bytes = before.body;
    const session = await scratchSession(join(copy, "db.sqlite"), token);
    if (session === null) {
      report.check(false, `${what}: token 1's workspace has an account to sign in with`, ["it has none, so no session could change the item"]);
      return;
    }
    const headers = { cookie: session.cookie, "x-csrf-token": session.csrf, origin: `http://${host}`, "sec-fetch-site": "same-origin", "content-type": "application/json" };
    const a = await fetchAnswer(port, "PUT", `/api/v1/media/${found.id}/access`, host, { body: JSON.stringify({ access: "me" }), headers });
    if (!report.check(a.status === 200 && jsonOf(a)?.access === "me", `${what}: the new build restricted one item of token 1 through its API`, [refusalLine(a)])) return;
    const gate = await fetchAnswer(port, "GET", file, host);
    if (!report.check(gate.status === 403 && !Buffer.from(gate.body).includes(Buffer.from(bytes)), `${what}: the new build answers its gate for the item's file, without its bytes`, [`the file answered ${gate.status}`])) return;
  } finally {
    await stopBuild(r);
  }

  const oldPort = await freePort();
  const old = spawnBuild(oldBuild.dir, copy, oldMode, work, oldPort);
  try {
    try {
      await waitReady(old, healthHosts(oldMode), healthRoles(oldMode));
    } catch {
      report.check(false, `${what}: the old build ${oldBuild.version} starts on that copy`, old.err.slice(-3).map((l) => l.split(work).join("<scratch>")));
      return;
    }
    const media = HOSTS[oldMode].img ?? HOSTS[oldMode].tours;
    const letter = page.slice(0, 3);
    const unknownLink = "z".repeat(20);
    const ext = file.slice(file.lastIndexOf("."));
    const addresses: [string, string, string][] = [
      ["page", page, `${letter}${unknownLink}`],
      ["file", file, `${letter}${unknownLink}${ext}`],
      ["download", `${page}/download`, `${letter}${unknownLink}/download`],
      ["preview", `${page}/preview`, `${letter}${unknownLink}/preview`],
    ];
    const problems: string[] = [];
    const holdsBytes = (x: Answer) => bytes !== null && Buffer.from(x.body).includes(Buffer.from(bytes));
    if (knowsItemAccess(oldBuild.dir)) {
      for (const [name, address] of addresses) {
        const x = await fetchAnswer(oldPort, "GET", address, media);
        if (x.status !== 403) problems.push(`the item's ${name} answered ${x.status}, not the gate`);
        if (!/no-store/.test(x.headers["cache-control"] ?? "")) problems.push(`the item's ${name} may be stored by a cache`);
        if (x.headers.etag !== undefined) problems.push(`the item's ${name} carries an ETag`);
        if (holdsBytes(x)) problems.push(`the item's ${name} holds its file`);
      }
      report.check(problems.length === 0, `${what}: old build ${oldBuild.version} knows who may view an item, and answers its gate at all ${addresses.length} addresses with nothing of the item`, problems);
      return;
    }
    let asUnknown = 0;
    for (const [name, address, unknown] of addresses) {
      const x = await fetchAnswer(oldPort, "GET", address, media);
      const y = await fetchAnswer(oldPort, "GET", unknown, media);
      if (x.status === y.status && Buffer.from(x.body).equals(Buffer.from(y.body)) && !holdsBytes(x)) asUnknown++;
      else problems.push(`the item's ${name} answered ${x.status}, not as an item that does not exist`);
    }
    report.check(problems.length === 0, `${what}: old build ${oldBuild.version} serves nothing of it (${asUnknown} of ${addresses.length} addresses as an item that does not exist)`, problems);
  } finally {
    await stopBuild(old);
  }
}

/** Runs the whole rehearsal and returns the exit status. */
export async function rehearse(argv: string[], env: NodeJS.ProcessEnv, print: (line: string) => void): Promise<number> {
  const args = parseArgs(argv, env);
  const tokens = readTokens(env, args.tokensFile);
  const oldBuild = buildInfo(args.old);
  const newBuild = buildInfo(args.next);
  const modes = buildModes(args.mode, { version: oldBuild.version, knowsImg: knowsImgRole(oldBuild.dir) }, { version: newBuild.version, knowsImg: knowsImgRole(newBuild.dir) });
  const report = new Report(print);
  const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

  report.line(`Upgrade rehearsal, ${MODE_WORDS[args.mode]}: ${oldBuild.version} -> ${newBuild.version}, ${plural(tokens.length, "token")}`);
  if (modes.note !== null) report.line(`      ${modes.note}`);
  if (!existsSync(join(args.data, "db.sqlite"))) throw new Error("the data folder holds no db.sqlite");
  const sourceBefore = hashTree(args.data);
  // How many added field paths the old-to-new comparison named: the last line asks the reader to read them.
  let addedCount = 0;
  const work = mkdtempSync(join(tmpdir(), "rehearse-upgrade-"));
  scratch = work;
  try {
    const copy = join(work, "copy");
    copyData(args.data, copy);
    report.line("      the copy holds db.sqlite, drafts and public only; nothing else of the folder was copied");

    // --- the old build, as the site runs today
    const before = readDb(join(copy, "db.sqlite"));
    const unknownToOld = before.migrations.filter((m) => !oldBuild.migrations.includes(m));
    if (!report.check(unknownToOld.length === 0, `the data was written by the old build or an older one (${plural(before.migrations.length, "migration")} applied)`, unknownToOld.map((m) => `${m} is applied but not in the old build`))) return 1;
    const old = await runPhase(oldBuild, copy, modes.old, work, tokens, report, `old build ${oldBuild.version}`);
    if (old === null) return 1;
    report.line(`      recorded ${plural(old.answers.length, "answer")}; stores hold ${plural(old.stores.size, "file")}; database has ${plural(Object.keys(old.endDb.snapshot).length, "table")}`);
    const pending = newBuild.migrations.filter((m) => !old.endDb.migrations.includes(m));
    report.line(`      pending for the new build: ${pending.length === 0 ? "none" : pending.join(", ")}`);

    // --- the new build on the same copy
    const next = await runPhase(newBuild, copy, modes.next, work, tokens, report, `new build ${newBuild.version}`, true);
    if (next === null) return 1;

    // The old build against the new one: a JSON answer that only adds fields is allowed, and
    // named; a tour page that names the new build's player files is allowed, and counted.
    const cmp = compareAnswers(old.answers, next.answers, { allowAddedFields: true, allowPlayerNames: true });
    addedCount = addedFieldCount(cmp);
    report.check(cmp.problems.length === 0, `answers: ${cmp.identical} identical, ${cmp.allowed} differ only in the version, ${cmp.playerNames} differ only in the player's file names, ${cmp.addedFields} differ only by added fields, ${cmp.added.length} new in this build, ${cmp.problems.length} differ`, cmp.problems);
    for (const route of Object.keys(cmp.addedFieldsByRoute).sort()) report.line(`      added fields, ${route}: ${cmp.addedFieldsByRoute[route].join(", ")}`);

    // The player files the new build's tour pages name must be there: a page that names a
    // file its own build does not serve would pass the comparison above and play nothing.
    const pf = next.playerFiles;
    if (pf === null || pf.files === 0) report.line("SKIP  player files: no tour page of the new build answered with a player file to ask for");
    else report.check(pf.problems.length === 0, `player files: ${pf.files - pf.failed} of ${pf.files} named by the new build's tour pages answer 200 with their type`, pf.problems);

    for (const [i, token] of tokens.entries()) {
      const ws = next.endDb.snapshot.api_token?.rows.find((r) => r[next.endDb.snapshot.api_token.columns.indexOf("hash")] === tokenHash(token));
      const usage = next.answers.find((r) => r.key === `token ${i + 1}: usage (${modes.next === "one" ? "one" : "app"} address)`);
      if (ws === undefined || usage === undefined) {
        report.check(false, `token ${i + 1}: usage equals the sum of the rows`, ["the token or its usage answer was not found"]);
        continue;
      }
      const wsId = ws[next.endDb.snapshot.api_token.columns.indexOf("workspace_id")] as string;
      const sum = usageFromRows(next.endDb.snapshot, wsId);
      const problems = usageProblems(usage.answer, sum);
      report.check(problems.length === 0, `token ${i + 1}: usage equals the sum of the rows (${sum.used} bytes: pictures ${sum.pictures}, logos ${sum.logos}, uploads ${sum.uploads}; ${plural(sum.tours, "tour")})`, problems);
    }

    const stores = compareStores(old.stores, next.stores);
    report.check(storesSame(stores), `stores: ${stores.files} files identical (${stores.missing} missing, ${stores.extra} extra, ${stores.changed} changed)`);

    // The rows as the old build left them, against the rows once the new build has started
    // (its migrations applied, no request served yet): the update alone, nothing else.
    const rows = compareRows(old.endDb.snapshot, next.startedDb.snapshot);
    report.check(rows.problems.length === 0, `rows: ${rows.rows} rows of ${rows.tables} tables identical in every column they had`, rows.problems);

    if (pending.includes(ACCOUNTS_MIGRATION)) {
      const added = Object.keys(next.startedDb.snapshot).filter((t) => !(t in old.endDb.snapshot)).sort();
      const missing = ACCOUNT_TABLES.filter((t) => !added.includes(t));
      report.check(missing.length === 0, `new tables present: ${added.join(", ")}`, missing.map((t) => `${t} is missing`));
      const fill = checkAccountsBackfill(next.startedDb.snapshot);
      report.check(fill.problems.length === 0, `backfill: ${fill.memberships} memberships and ${fill.methods} sign-in methods for ${plural(fill.users, "user")}; ${fill.admins} admins; no sessions, codes, counters or audit rows`, fill.problems);
    } else {
      report.line(`SKIP  accounts tables and backfill: ${ACCOUNTS_MIGRATION} is not pending for this update`);
    }

    report.check(next.endDb.foreignKeyProblems === 0, `foreign_key_check: ${next.endDb.foreignKeyProblems} problems`);
    report.check(next.endDb.integrity === "ok", `integrity_check: ${next.endDb.integrity === "ok" ? "ok" : "not ok"}`);
    const applied = migrationProblems(next.endDb.migrations, newBuild.migrations);
    report.check(applied.length === 0, `applied migrations: exactly the new build's ${newBuild.migrations.length}, each once`, applied);

    // --- the way back: the old build on the migrated copy
    const back = await runPhase(oldBuild, copy, modes.old, work, tokens, report, `way back: old build ${oldBuild.version} on the migrated copy`);
    if (back !== null) {
      // Nothing of the new build's allowances: the old build must answer as it did, but the date.
      const again = compareAnswers(old.answers, back.answers);
      const backProblems = identityProblems(again);
      report.check(backProblems.length === 0, `way back: answers ${again.identical} identical to before the update, ${again.allowed + again.playerNames + again.added.length} allowed differences, ${again.problems.length} differ`, backProblems);
      const s = compareStores(old.stores, back.stores);
      report.check(storesSame(s), `way back: stores ${s.files} files identical (${s.missing} missing, ${s.extra} extra, ${s.changed} changed)`);
      const keptMigrations = migrationProblems(back.endDb.migrations, newBuild.migrations);
      report.check(keptMigrations.length === 0 && back.endDb.integrity === "ok" && back.endDb.foreignKeyProblems === 0, "way back: the database keeps the new schema and passes both checks", [
        ...keptMigrations,
        ...(back.endDb.integrity === "ok" ? [] : ["integrity_check is not ok"]),
        ...(back.endDb.foreignKeyProblems === 0 ? [] : [`${back.endDb.foreignKeyProblems} foreign key problems`]),
      ]);
    }

    // --- the way back once a tour is restricted, on a fresh copy of the old data
    await restrictedWayBack(args, oldBuild, newBuild, modes.old, work, tokens, report);
    // --- and once a shared item is restricted, on another fresh copy
    await restrictedItemWayBack(args, oldBuild, newBuild, modes.old, work, tokens, report);

    // --- two new builds at the same moment on a fresh copy of the old data
    const race = join(work, "race");
    copyData(args.data, race);
    const { spread, startProblems, errors, answers: raceAnswers } = await startPair(newBuild.dir, race, modes.next, work, tokens);
    // Each distinct line the two wrote is named once: a known message word for word, any other by its length.
    report.check(startProblems.length === 0 && errors.length === 0, `two new builds started ${spread} ms apart on a fresh copy: both answer health, ${errors.length} error lines`, [...startProblems, ...errorLineProblems(errors)]);
    const raced = readDb(join(race, "db.sqlite"));
    const raceMigrations = migrationProblems(raced.migrations, newBuild.migrations);
    report.check(raceMigrations.length === 0 && raced.integrity === "ok" && raced.foreignKeyProblems === 0, `two new builds: each migration applied once (${plural(raced.migrations.length, "record")}), integrity ok, no foreign key problems`, [
      ...raceMigrations,
      ...(raced.integrity === "ok" ? [] : ["integrity_check is not ok"]),
      ...(raced.foreignKeyProblems === 0 ? [] : [`${raced.foreignKeyProblems} foreign key problems`]),
    ]);
    if (raceAnswers !== null) {
      const same = compareAnswers(next.answers, raceAnswers);
      // The same build twice: the same to the byte but the date, with nothing set aside.
      const raceProblems = identityProblems(same);
      report.check(raceProblems.length === 0 && same.added.length === 0, `two new builds: answers ${same.identical} identical to the single new build's, ${same.problems.length} differ`, raceProblems);
    }
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    scratch = null;
    const sourceAfter = hashTree(args.data);
    let changed = 0;
    for (const [p, h] of sourceBefore) if (sourceAfter.get(p) !== h) changed++;
    for (const p of sourceAfter.keys()) if (!sourceBefore.has(p)) changed++;
    report.check(changed === 0, `the given folder is as it was (${plural(sourceBefore.size, "file")}, ${changed} changed); the scratch copy was removed`);
    report.line(resultLine(report.failed, addedCount));
  }
  return report.failed === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // A reader that goes away (the report piped into a pager that was closed) is not a failure of the rehearsal.
  process.stdout.on("error", () => {});
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(130));
  rehearse(process.argv.slice(2), process.env, (l) => process.stdout.write(l + "\n")).then(
    (code) => process.exit(code),
    (err: unknown) => {
      // Fixed text from this script only: none of it holds a token or a value from the data.
      // A system error (a file that could not be read or copied) names a path, so only its code is shown.
      const code = (err as NodeJS.ErrnoException)?.code;
      console.error(typeof code === "string" ? `a file could not be read, copied or removed (${code})` : err instanceof Error ? err.message : "the rehearsal failed");
      process.exit(1);
    },
  );
}
