// node scripts/local-signin-link.ts --email <address>
//
// A TEST TOOL, for the by-hand browser check of the sign-in pages
// (docs/signin-browser-check.md): it prints a sign-in link for an account of a scratch
// site on this computer, so a person can sign in again and again while the site's mail
// is off. It is never shipped (the cPanel archive holds no scripts/ folder, which a test
// holds) and it refuses to run against anything that could be a real site. Both must hold:
//
// - The address the site's settings give sign-in links (APP_HOST in two-address mode, else
//   SITE_HOST) is `localhost`, a `.localhost` name or `127.0.0.1`, with or without a port.
//   A real site's links name its public host, so a link for one is never made here.
// - DATA_DIR, with every link in its path followed, is a folder strictly inside this
//   computer's temporary folder (os.tmpdir()). Chosen over a required folder name because
//   a name is something anyone can give a real site's folder by copying or renaming it,
//   while no install guide, the container or the cPanel host keeps a site's data in the
//   temporary folder, and the system clears that folder on its own.
//
// It reads the same settings as the app from the environment, opens the database only when
// it exists (it never creates one and never applies a migration), and writes what the
// server command writes for a printed link: one sign-in code and its audit row. It is not
// the recovery gate of src/node/admin.ts and does not open it: that gate guards real sites.
// Every line it prints starts by naming it as a test tool; the only secret it prints is
// the link, which is the point of it.
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { signInLinkFor } from "../src/admin.ts";
import { linkOrigin } from "../src/mail.ts";
import { configFromEnv } from "../src/node/config.ts";
import { NodeDb } from "../src/node/db.ts";
import type { Config, Deps, FileStore } from "../src/ports.ts";

/** The first line of every run: what this is. */
export const TOOL_LINE = "local-signin-link: a test tool for a scratch site on this computer. It is never shipped and refuses any site that could be real.";

/** Every other line it can print, besides the link itself. */
export const SAID = {
  usage: "Usage: node scripts/local-signin-link.ts --email <address>",
  settings: "Refused: the site's settings could not be read. Check TOURS_HOST, APP_HOST, SITE_HOST and STORAGE_ALLOWANCE_BYTES.",
  host: "Refused: this site's sign-in links do not go to localhost, a .localhost name or 127.0.0.1. Set SITE_HOST=localhost:3000, or APP_HOST and TOURS_HOST to .localhost names.",
  dataDir: "Refused: DATA_DIR must be a folder inside this computer's temporary folder.",
  noDatabase: "Refused: DATA_DIR holds no database. Start the site on it once first.",
  notMigrated: "Refused: the database has no accounts yet. Start the site's current build on it once first.",
  noLink: "No link was made. Check the address, and that the site has an admin (node dist/node/admin.js first-admin).",
  failed: "No link was made: the database could not be read.",
  follows: "Open this link within 15 minutes to sign in. It works once:",
} as const;

/** True for a host name the browser check may use: localhost, a .localhost name, 127.0.0.1. */
export function isLocalName(name: string): boolean {
  return name === "localhost" || name.endsWith(".localhost") || name === "127.0.0.1";
}

/** The origin sign-in links of this configuration start with, when it names this computer; else null. */
export function localLinkOrigin(config: Config): string | null {
  const origin = linkOrigin(config);
  if (origin === null) return null;
  return isLocalName(new URL(origin).hostname) ? origin : null;
}

/** True when `dir` exists and, links followed, lies strictly inside `tmp` (links followed too). */
export function insideTemp(dir: string, tmp: string): boolean {
  let real: string;
  let base: string;
  try {
    real = realpathSync.native(resolve(dir));
    base = realpathSync.native(resolve(tmp));
  } catch {
    return false;
  }
  if (process.platform === "win32") {
    real = real.toLowerCase();
    base = base.toLowerCase();
  }
  const rel = relative(base, real);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Files are never read or written here. */
const NO_FILES: FileStore = new Proxy({} as FileStore, {
  get() {
    throw new Error("no files here");
  },
});

/** The address after --email, or null when the arguments are anything else. */
function emailArg(argv: string[]): string | null {
  return argv.length === 2 && argv[0] === "--email" && argv[1] !== "" ? argv[1] : null;
}

/**
 * Runs the tool: every check before the database is opened, then one link. Returns the
 * exit status: 0 with a link printed, 1 for every refusal, 2 for wrong arguments.
 * `opts.tmp` is the temporary folder (tests).
 */
export async function runLocalSigninLink(argv: string[], env: NodeJS.ProcessEnv, out: (line: string) => void, opts: { tmp?: string } = {}): Promise<number> {
  out(TOOL_LINE);
  const email = emailArg(argv);
  if (email === null) {
    out(SAID.usage);
    return 2;
  }
  let config: Config;
  try {
    config = configFromEnv(env);
  } catch {
    out(SAID.settings);
    return 1;
  }
  if (localLinkOrigin(config) === null) {
    out(SAID.host);
    return 1;
  }
  const dataDir = env.DATA_DIR;
  if (typeof dataDir !== "string" || dataDir === "" || !insideTemp(dataDir, opts.tmp ?? tmpdir())) {
    out(SAID.dataDir);
    return 1;
  }
  const dbPath = join(realpathSync.native(resolve(dataDir)), "db.sqlite");
  if (!existsSync(dbPath)) {
    out(SAID.noDatabase);
    return 1;
  }
  let db: NodeDb | null = null;
  try {
    db = new NodeDb(dbPath);
    const tables = await db.first("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = '_migrations'");
    const migrated = tables === null ? null : await db.first("SELECT 1 AS x FROM _migrations WHERE name = ?", ["0008_accounts.sql"]);
    if (migrated === null) {
      out(SAID.notMigrated);
      return 1;
    }
    const deps: Deps = { db, drafts: NO_FILES, pub: NO_FILES, config, now: () => Date.now() };
    const link = await signInLinkFor(deps, email);
    // The origin was checked above, so a link is whole; a path alone is never printed.
    if (!link.ok || !link.whole) {
      out(SAID.noLink);
      return 1;
    }
    out(SAID.follows);
    out(link.link);
    return 0;
  } catch {
    out(SAID.failed);
    return 1;
  } finally {
    db?.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runLocalSigninLink(process.argv.slice(2), process.env, (line) => {
    process.stdout.write(line + "\n");
  });
}
