// The server command (src/node/admin.ts), run in this process on a database file in a
// scratch folder, as `node dist/node/admin.js` runs it beside the app. Node only. No mail
// is sent: where a mailer is needed the fake one is handed in, and every host is a
// placeholder.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { auditStatement } from "../src/audit.ts";
import { requireAuth } from "../src/auth.ts";
import { ADMIN_SETTINGS, isMainModule, isRecoveryOn, mainDecision, recoveryFromProcessOne, runAdmin, type AdminOptions } from "../src/node/admin.ts";
import { NODE_SETTINGS } from "../src/node/config.ts";
import { NodeDb } from "../src/node/db.ts";
import { migrate } from "../src/node/migrate.ts";
import type { Deps } from "../src/ports.ts";
import { redeemSignInCode } from "../src/sessions.ts";
import { workspaceStatements } from "../src/workspaces.ts";
import { FakeMailer } from "./fake-mail.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const ACCOUNTS_MIGRATION = "0008_accounts.sql";
const NEEDS_ACCOUNTS = ["0025_token_account.sql"];
const SETUP_CODE = "made-up-setup-code-0123456789abcdef";
const SMTP_PASSWORD = "pw-S3cret/with+chars=";
const TWO = { TOURS_HOST: "tours.example.com", APP_HOST: "app.example.com" };
const SMTP = { MAIL_MODE: "smtp", MAIL_FROM: "no-reply@example.com", SMTP_HOST: "mail.example.com", SMTP_PORT: "465", SMTP_USER: "no-reply@example.com", SMTP_PASSWORD };

const CREATED = (name: string) => [`The admin account "${name}" was created.`, "Your tours, their links and your tokens stay exactly as they are.", "", "Open this link within 15 minutes to sign in:"];
const LINK = /^https:\/\/app\.example\.com\/signin\/link#c=dpl_[0-9a-f]{40}$/;
const NO_LINK = "No link was made. Check the address, and that the site has an admin.";
const HAS_ADMIN = "This site already has an admin. Nothing was changed.";
/** The recovery setting, for the runs that print a link for an existing account. */
const ON = { RECOVERY_LINKS: "on" };
const REMIND = "Remove the line RECOVERY_LINKS=on from the settings file now.";
const RECOVERY_OFF = "Recovery links are off. To get one, add the line RECOVERY_LINKS=on to the site's settings file, run this again, then remove the line.";

const made: string[] = [];
const open: NodeDb[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A connection of this test's own to the site's database, closed after the test. */
function connect(dir: string): NodeDb {
  const db = new NodeDb(join(dir, "db.sqlite"));
  open.push(db);
  return db;
}

function depsOn(db: NodeDb): Deps {
  const none = { put: async () => {}, get: async () => null, delete: async () => {} };
  return { db, drafts: none, pub: none, config: { publicImageBase: "", setupCode: null }, now: () => Date.now() };
}

type Site = { dir: string; env: NodeJS.ProcessEnv; workspaceId: string; userId: string; token: string };

/**
 * A data folder as a running site has it: the database with every migration (or, with
 * `accounts: false`, every one before accounts) and, unless `setUp` is false, the
 * workspace, owner, token and setup row the wizard writes.
 */
async function site(opts: { setUp?: boolean; accounts?: boolean; email?: string } = {}): Promise<Site> {
  const dir = mkdtempSync(join(tmpdir(), "dp-admin-cmd-"));
  made.push(dir);
  let migrations = MIGRATIONS_DIR;
  if (opts.accounts === false) {
    migrations = join(dir, "migrations-before-accounts");
    // And the migrations that read the accounts' tables (0025 fills a column from the audit
    // record and the memberships), which a database before accounts cannot have either.
    cpSync(MIGRATIONS_DIR, migrations, { recursive: true, filter: (from) => !from.endsWith(ACCOUNTS_MIGRATION) && !NEEDS_ACCOUNTS.some((m) => from.endsWith(m)) });
  }
  const db = new NodeDb(join(dir, "db.sqlite"));
  try {
    await migrate(db, migrations);
    let ids = { workspaceId: "", userId: "", token: "" };
    if (opts.setUp !== false && opts.accounts !== false) {
      const w = await workspaceStatements(depsOn(db), "Acme", opts.email ?? "typed-at-setup@example.com");
      await db.batch([...w.stmts, { sql: "INSERT INTO setup (id, workspace_id, completed_at) VALUES (1, ?, 1)", params: [w.workspaceId] }]);
      ids = { workspaceId: w.workspaceId, userId: w.userId, token: w.token };
    }
    return { dir, env: { DATA_DIR: dir, SETUP_CODE, ...TWO }, ...ids };
  } finally {
    db.close();
  }
}

/**
 * Runs the command as app.cjs does and returns what it said and its exit code: `settings`
 * stands for the settings file. Its RECOVERY_LINKS line becomes the explicit gate and is
 * not handed over in the environment, as app.cjs does it.
 */
async function run(settings: NodeJS.ProcessEnv, argv: string[], opts?: AdminOptions): Promise<{ code: number; lines: string[] }> {
  const { RECOVERY_LINKS: recovery, ...env } = settings;
  return runRaw(env, argv, { recoveryLinks: isRecoveryOn(recovery), ...opts });
}

/** Runs the command with exactly this environment and these options, nothing translated. */
async function runRaw(env: NodeJS.ProcessEnv, argv: string[], opts?: AdminOptions): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runAdmin(argv, env, (line) => lines.push(line), opts);
  return { code, lines };
}

/** Every file of a folder with its size and time of change: nothing was touched when this is equal. */
function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((p) => {
      const s = statSync(join(dir, p));
      return `${p} ${s.isDirectory() ? "dir" : `${s.size} ${s.mtimeMs}`}`;
    })
    .sort();
}

describe("the server command", () => {
  it("works with a HOME_URL the app cannot use: the logo's link is cosmetic and never closes the recovery commands", async () => {
    const s = await site();
    const r = await run({ ...s.env, HOME_URL: "http://made-up.example.com/" }, ["first-admin", "--email", "You@Example.com", "--username", "Robin"]);
    expect(r.code).toBe(0);
    expect(r.lines.slice(0, 4)).toEqual(CREATED("robin"));
    expect(r.lines.join("\n")).not.toContain("made-up");
  });

  it("first-admin prints the planned sentence and exits 0", async () => {
    const s = await site();
    const r = await run(s.env, ["first-admin", "--email", "You@Example.com", "--username", "Robin"]);
    expect(r.code).toBe(0);
    expect(r.lines.slice(0, 4)).toEqual(CREATED("robin"));
    expect(r.lines).toHaveLength(5);
    expect(r.lines[4]).toMatch(LINK);

    const db = connect(s.dir);
    expect(await db.first("SELECT email, username, is_admin FROM user WHERE id = ?", [s.userId])).toEqual({ email: "you@example.com", username: "robin", is_admin: 1 });
    expect(await db.all("SELECT event, user_id, workspace_id, subject, detail FROM audit ORDER BY at, event")).toEqual([
      { event: "first_admin", user_id: s.userId, workspace_id: s.workspaceId, subject: s.userId, detail: null },
      { event: "signin_link_printed", user_id: s.userId, workspace_id: s.workspaceId, subject: s.userId, detail: null },
    ]);
    // The token made at setup still resolves to its workspace, and nothing else of the site changed.
    const auth = await requireAuth(new Request("https://tours.example.com/api/v1/me", { headers: { authorization: "Bearer " + s.token } }), depsOn(db));
    expect(auth).toMatchObject({ workspaceId: s.workspaceId });
    expect(await db.first("SELECT count(*) AS n FROM workspace")).toEqual({ n: 1 });
    expect(await db.first("SELECT count(*) AS n FROM api_token")).toEqual({ n: 1 });
    // The link signs the new admin in, once.
    const code = r.lines[4].split("#c=")[1];
    expect((await redeemSignInCode(depsOn(db), code, null, null))?.userId).toBe(s.userId);
    expect(await redeemSignInCode(depsOn(db), code, null, null)).toBeNull();
  });

  it("without a command, --email with --username makes the admin and --email alone prints a link", async () => {
    const s = await site();
    const made = await run(s.env, ["--email", "you@example.com", "--username=robin"]);
    expect(made.code).toBe(0);
    expect(made.lines.slice(0, 4)).toEqual(CREATED("robin"));
    expect(made.lines[4]).toMatch(LINK);
    const link = await run({ ...s.env, ...ON }, ["--email=you@example.com"]);
    expect(link.code).toBe(0);
    expect(link.lines).toEqual(["Open this link within 15 minutes to sign in:", expect.stringMatching(LINK), REMIND]);
    expect(link.lines[1]).not.toBe(made.lines[4]);
  });

  it("the gate is never read from the command's own environment: a direct run with RECOVERY_LINKS=on refuses and writes nothing", async () => {
    const s = await site();
    await run(s.env, ["first-admin", "--email", "you@example.com", "--username", "robin"]);
    const db = connect(s.dir);
    const written = async () => [await db.all("SELECT * FROM signin_code ORDER BY id"), await db.all("SELECT * FROM audit ORDER BY id")];
    const before = await written();
    for (const argv of [["signin-link", "--email", "you@example.com"], ["--email", "you@example.com"]]) {
      const r = await runRaw({ ...s.env, RECOVERY_LINKS: "on" }, argv);
      expect(r.lines).toEqual([RECOVERY_OFF]);
      expect(r.code).toBe(1);
      // Only the explicit gate opens it, and then the reminder follows the link.
      expect((await runRaw(s.env, argv, { recoveryLinks: true })).lines).toEqual(["Open this link within 15 minutes to sign in:", expect.stringMatching(LINK), REMIND]);
    }
    expect((await runRaw({ ...s.env, RECOVERY_LINKS: "on" }, ["signin-link", "--email", "you@example.com"], { recoveryLinks: false })).lines).toEqual([RECOVERY_OFF]);
    expect((await written())[0]).toHaveLength((before[0] as unknown[]).length + 2);
    // first-admin is the same whatever the gate says.
    const fresh = await site();
    const r = await runRaw({ ...fresh.env, RECOVERY_LINKS: "on" }, ["first-admin", "--email", "you@example.com", "--username", "robin"], { recoveryLinks: true });
    expect(r.lines).toEqual([...CREATED("robin"), expect.stringMatching(LINK)]);
  });

  it("run as its own file, the gate is the environment of process 1, and anything unreadable is off", () => {
    const environ = (pairs: string[]) => Buffer.from(pairs.join("\0") + "\0");
    // Process 1 as the container starts it: the Dockerfile's CMD ["node", "dist/node/entry.js"].
    const APP = environ(["node", "dist/node/entry.js"]);
    const at = (file: Buffer | Error, cmdline: Buffer | Error = APP) => ({ pid: 4242, platform: "linux" as NodeJS.Platform, read: (path: string) => {
      const got = path === "/proc/1/cmdline" ? cmdline : path === "/proc/1/environ" ? file : new Error(`read ${path}`);
      if (got instanceof Error) throw got;
      return got;
    } });
    expect(recoveryFromProcessOne(at(environ(["PATH=/usr/bin", "RECOVERY_LINKS=on", "DATA_DIR=/data"])))).toBe(true);
    expect(recoveryFromProcessOne(at(environ(["RECOVERY_LINKS= ON "])))).toBe(true);
    for (const pairs of [["RECOVERY_LINKS=off"], ["RECOVERY_LINKS=1"], ["RECOVERY_LINKS="], ["NOT_RECOVERY_LINKS=on"], ["RECOVERY_LINKS_X=on"], []]) {
      expect(recoveryFromProcessOne(at(environ(pairs))), pairs.join(",")).toBe(false);
    }
    expect(recoveryFromProcessOne(at(Object.assign(new Error("EACCES"), { code: "EACCES" })))).toBe(false);
    expect(recoveryFromProcessOne(at(Object.assign(new Error("ENOENT"), { code: "ENOENT" })))).toBe(false);
    // Not Linux, or the command is process 1 itself (its own environment): off without reading anything.
    const never = (path: string): Buffer => {
      throw new Error(`read ${path}`);
    };
    expect(recoveryFromProcessOne({ pid: 4242, platform: "win32", read: never })).toBe(false);
    expect(recoveryFromProcessOne({ pid: 1, platform: "linux", read: never })).toBe(false);
  });

  it("process 1 counts only when it is this application's own server", () => {
    const nul = (parts: string[]) => Buffer.from(parts.join("\0") + "\0");
    const ON_ENV = nul(["RECOVERY_LINKS=on"]);
    const with1 = (cmdline: Buffer | Error) => ({
      pid: 4242,
      platform: "linux" as NodeJS.Platform,
      read: (path: string) => {
        const got = path === "/proc/1/cmdline" ? cmdline : path === "/proc/1/environ" ? ON_ENV : new Error(path);
        if (got instanceof Error) throw got;
        return got;
      },
    });
    // The app, as the image starts it, by any spelling of node and of the script's path.
    for (const parts of [["node", "dist/node/entry.js"], ["/usr/local/bin/node", "dist/node/entry.js"], ["node", "/app/dist/node/entry.js"], ["node", "--enable-source-maps", "dist/node/entry.js"], ["node", "./dist/node/entry.js"]]) {
      expect(recoveryFromProcessOne(with1(nul(parts))), parts.join(" ")).toBe(true);
    }
    // A shell, an init, another script, another program, nothing: closed, whatever the environment says.
    for (const parts of [
      ["sh", "-c", "RECOVERY_LINKS=on node dist/node/entry.js"],
      ["/bin/sh", "-c", "node dist/node/entry.js"],
      ["/sbin/docker-init", "--", "node", "dist/node/entry.js"],
      ["tini", "--", "node", "dist/node/entry.js"],
      ["node", "dist/node/admin.js"],
      ["node", "dist/node/entry.js.bak"],
      ["node", "/tmp/fake-dist/node/entry.jsx"],
      ["node"],
      ["nodejs-fake", "dist/node/entry.js"],
      ["bash"],
      [],
    ]) {
      expect(recoveryFromProcessOne(with1(nul(parts))), parts.join(" ")).toBe(false);
    }
    expect(recoveryFromProcessOne(with1(Object.assign(new Error("EACCES"), { code: "EACCES" })))).toBe(false);
  });

  it("started as its own file with RECOVERY_LINKS=on in its environment, it still refuses", async () => {
    const s = await site();
    await run(s.env, ["first-admin", "--email", "you@example.com", "--username", "robin"]);
    const db = connect(s.dir);
    const codes = await db.all("SELECT id FROM signin_code");
    const base: Record<string, string> = {};
    for (const k of ["PATH", "Path", "SystemRoot", "TEMP", "TMP"]) if (process.env[k] !== undefined) base[k] = process.env[k] as string;
    const file = fileURLToPath(new URL("../src/node/admin.ts", import.meta.url));
    const r = spawnSync(process.execPath, [file, "--email", "you@example.com"], { env: { ...base, ...s.env, RECOVERY_LINKS: "on" }, encoding: "utf8", timeout: 60_000, windowsHide: true });
    expect(r.stdout).toBe(RECOVERY_OFF + "\n");
    expect(r.status).toBe(1);
    expect(await db.all("SELECT id FROM signin_code")).toEqual(codes);
  }, 60_000);

  it("the settings app.cjs clears for the command are every one the Node target reads, and the gate", () => {
    const names = new Set<string>();
    for (const f of ["../src/node/config.ts", "../src/node/entry.ts"]) {
      for (const m of readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8").matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1]);
    }
    expect([...NODE_SETTINGS].sort()).toEqual([...names].sort());
    expect([...ADMIN_SETTINGS].sort()).toEqual([...NODE_SETTINGS, "RECOVERY_LINKS", "BILLING_REMOVAL"].sort());
  });

  it("started under the command's name but not recognised as itself, it prints the usage instead of doing nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "dp-admin-decide-"));
    made.push(dir);
    mkdirSync(join(dir, "dist", "node"), { recursive: true });
    mkdirSync(join(dir, "copy"));
    const file = join(dir, "dist", "node", "admin.js");
    writeFileSync(file, "");
    writeFileSync(join(dir, "copy", "admin.js"), "");
    const url = pathToFileURL(file).href;
    expect(mainDecision(file, url)).toBe("run");
    // Without its extension, as `node dist/node/admin` is typed.
    expect(mainDecision(join(dir, "dist", "node", "admin"), url)).toBe("run");
    // Another file of the same name (a copy or a hard link elsewhere): said, not silent.
    expect(mainDecision(join(dir, "copy", "admin.js"), url)).toBe("usage");
    expect(mainDecision(join(dir, "copy", "admin"), url)).toBe("usage");
    // Loaded by something else: nothing.
    for (const other of [undefined, join(dir, "app.cjs"), join(dir, "dist", "node", "entry.js")]) expect(mainDecision(other, url), String(other)).toBe("none");
  });

  it("only the command reads RECOVERY_LINKS: no other source file names it", () => {
    const src = fileURLToPath(new URL("../src/", import.meta.url));
    const readers = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((p) => p.endsWith(".ts"))
      .filter((p) => readFileSync(join(src, p), "utf8").includes("RECOVERY_LINKS"))
      .map((p) => p.replace(/\\/g, "/"));
    expect(readers).toEqual(["node/admin.ts"]);
  });

  it("a link for an existing account is a recovery tool, off unless the settings say RECOVERY_LINKS=on", async () => {
    const s = await site();
    // The first admin's own link is part of the one act, whatever the setting says, and never reminds.
    const first = await run({ ...s.env, RECOVERY_LINKS: "off" }, ["first-admin", "--email", "you@example.com", "--username", "robin"]);
    expect(first.code).toBe(0);
    expect(first.lines).toEqual([...CREATED("robin"), expect.stringMatching(LINK)]);
    const db = connect(s.dir);
    const written = async () => [await db.all("SELECT * FROM signin_code ORDER BY id"), await db.all("SELECT * FROM audit ORDER BY id")];
    const before = await written();
    // Off: unset, and every value but `on`. Nothing is made and nothing is recorded, by either spelling.
    for (const value of [undefined, "", "off", "1", "true", "yes", "enabled", "o n", "on1"]) {
      for (const argv of [["signin-link", "--email", "you@example.com"], ["--email", "you@example.com"]]) {
        const r = await run({ ...s.env, RECOVERY_LINKS: value }, argv);
        expect(r.lines, `${value} ${argv[0]}`).toEqual([RECOVERY_OFF]);
        expect(r.code).toBe(1);
      }
    }
    expect(await written()).toEqual(before);
    // On: `on` in any case, with spaces around it. Each link is recorded as before.
    for (const value of ["on", "ON", " On ", "\ton"]) {
      const r = await run({ ...s.env, RECOVERY_LINKS: value }, ["signin-link", "--email", "you@example.com"]);
      expect(r.lines, JSON.stringify(value)).toEqual(["Open this link within 15 minutes to sign in:", expect.stringMatching(LINK), REMIND]);
      expect(r.code).toBe(0);
    }
    expect(await db.all("SELECT event FROM audit WHERE event = 'signin_link_printed'")).toHaveLength(5);
    // A stranger's refusal with the setting on still writes nothing and does not remind.
    expect((await run({ ...s.env, ...ON }, ["signin-link", "--email", "stranger@example.com"])).lines).toEqual([NO_LINK]);
  });

  it("each refusal prints its sentence and exits 1", async () => {
    const s = await site();
    const db = connect(s.dir);
    const other = await workspaceStatements(depsOn(db), "Other", "other@example.com");
    await db.batch([...other.stmts, { sql: "UPDATE user SET username = 'sam' WHERE id = ?", params: [other.userId] }]);
    const rows = async () => [await db.all("SELECT * FROM user ORDER BY id"), await db.all("SELECT * FROM audit"), await db.all("SELECT * FROM signin_code")];
    const before = await rows();

    const cases: [string[], string][] = [
      [["--email", "you-at-example.com", "--username", "robin"], "That is not an email address."],
      [["--email", "you@localhost", "--username", "robin"], "That is not an email address."],
      [["--email", "other@example.com", "--username", "robin"], "That email address belongs to another account."],
      [["--email", "you@example.com", "--username", "ro"], "A username is 3 to 30 lowercase letters, digits and hyphens, and starts with a letter."],
      [["--email", "you@example.com", "--username", "9lives"], "A username is 3 to 30 lowercase letters, digits and hyphens, and starts with a letter."],
      [["--email", "you@example.com", "--username", "admin"], "That username is reserved. Choose another."],
      [["--email", "you@example.com", "--username", "Mythic-Shot"], "That username is reserved. Choose another."],
      [["--email", "you@example.com", "--username", "sam"], "That username is taken."],
    ];
    for (const [flags, sentence] of cases) {
      const r = await run(s.env, ["first-admin", ...flags]);
      expect(r.lines, flags.join(" ")).toEqual([sentence]);
      expect(r.code, flags.join(" ")).toBe(1);
    }
    expect(await rows()).toEqual(before);

    // Once there is an admin, every further claim is told so, the same one included.
    expect((await run(s.env, ["first-admin", "--email", "you@example.com", "--username", "robin"])).code).toBe(0);
    const after = await rows();
    for (const flags of [["--email", "you@example.com", "--username", "robin"], ["--email", "new@example.com", "--username", "kim"]]) {
      const r = await run(s.env, ["first-admin", ...flags]);
      expect(r.lines).toEqual([HAS_ADMIN]);
      expect(r.code).toBe(1);
    }
    expect(await rows()).toEqual(after);
    expect(await db.all("SELECT id FROM user WHERE is_admin = 1")).toEqual([{ id: s.userId }]);

    // A site nobody has set up yet.
    const empty = await site({ setUp: false });
    const r = await run(empty.env, ["first-admin", "--email", "you@example.com", "--username", "robin"]);
    expect(r.lines).toEqual(["This site is not set up yet. Open the setup page first."]);
    expect(r.code).toBe(1);
  });

  it("run by two processes at once it makes one admin", async () => {
    const s = await site();
    const results = await Promise.all([
      run(s.env, ["first-admin", "--email", "one@example.com", "--username", "one"]),
      run(s.env, ["first-admin", "--email", "two@example.com", "--username", "two"]),
    ]);
    expect(results.map((r) => r.code).sort()).toEqual([0, 1]);
    expect(results.find((r) => r.code === 1)?.lines).toEqual([HAS_ADMIN]);
    const db = connect(s.dir);
    expect(await db.all("SELECT id FROM user WHERE is_admin = 1")).toEqual([{ id: s.userId }]);
    expect(await db.all("SELECT event FROM audit WHERE event = 'first_admin'")).toHaveLength(1);
  });

  it("it works beside a running app that holds the database open", async () => {
    const s = await site();
    // The app's own connection, in the middle of its work: a read snapshot held open, and
    // a write of its own just before and just after the command.
    const app = connect(s.dir);
    await app.run("UPDATE workspace SET name = 'Acme Tours' WHERE id = ?", [s.workspaceId]);
    const reading = app.raw.prepare("SELECT id FROM user").iterate();
    reading.next();
    const r = await run(s.env, ["first-admin", "--email", "you@example.com", "--username", "robin"]);
    expect(r.code).toBe(0);
    reading.return?.();
    await app.run("UPDATE workspace SET name = 'Acme' WHERE id = ?", [s.workspaceId]);
    expect(await app.first("SELECT username, is_admin FROM user WHERE id = ?", [s.userId])).toEqual({ username: "robin", is_admin: 1 });

    // A writer that does not let go: the command waits as long as the app would, then says so and changes nothing.
    const stuck = await site();
    const holder = connect(stuck.dir);
    holder.raw.exec("BEGIN IMMEDIATE");
    const started = Date.now();
    const busy = await run(stuck.env, ["first-admin", "--email", "you@example.com", "--username", "robin"]);
    holder.raw.exec("ROLLBACK");
    expect(busy.lines).toEqual(["The database is busy. Try again in a moment."]);
    expect(busy.code).toBe(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4000);
    expect(await holder.first("SELECT count(*) AS n FROM user WHERE is_admin = 1")).toEqual({ n: 0 });
    // And it is safe to run again.
    expect((await run(stuck.env, ["first-admin", "--email", "you@example.com", "--username", "robin"])).code).toBe(0);
  }, 30_000);

  it("signin-link prints a link that signs in once", async () => {
    const s = await site();
    await run(s.env, ["first-admin", "--email", "you@example.com", "--username", "robin"]);
    const r = await run({ ...s.env, ...ON }, ["signin-link", "--email", " You@Example.com"]);
    expect(r.code).toBe(0);
    expect(r.lines).toEqual(["Open this link within 15 minutes to sign in:", expect.stringMatching(LINK), REMIND]);
    const code = r.lines[1].split("#c=")[1];
    const db = connect(s.dir);
    const session = await redeemSignInCode(depsOn(db), code, "Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0", null);
    expect(session?.userId).toBe(s.userId);
    expect(await redeemSignInCode(depsOn(db), code, null, null)).toBeNull();
    // Each run makes a link of its own, and each is on record.
    const again = await run({ ...s.env, ...ON }, ["signin-link", "--email", "you@example.com"]);
    expect(again.lines[1]).not.toBe(r.lines[1]);
    expect(await db.all("SELECT event FROM audit WHERE event = 'signin_link_printed'")).toHaveLength(3);
    // Only digests are stored.
    const stored = JSON.stringify([await db.all("SELECT * FROM signin_code"), await db.all("SELECT * FROM audit"), await db.all("SELECT * FROM session")]);
    for (const link of [r.lines[1], again.lines[1]]) {
      expect(stored).not.toContain(link.split("#c=")[1]);
      expect(stored).not.toContain(link.split("#c=dpl_")[1]);
    }
  });

  it("signin-link for a stranger, a disabled account or a site without an admin prints the same refusal", async () => {
    const s = await site({ email: "you@example.com" });
    const db = connect(s.dir);
    const member = await workspaceStatements(depsOn(db), "Member", "member@example.com");
    await db.batch(member.stmts);
    const written = async () => [await db.all("SELECT * FROM signin_code"), await db.all("SELECT * FROM audit")];

    // No admin yet: nobody gets a link, the owner included.
    for (const email of ["you@example.com", "member@example.com", "stranger@example.com"]) {
      const r = await run({ ...s.env, ...ON }, ["signin-link", "--email", email]);
      expect(r.lines, email).toEqual([NO_LINK]);
      expect(r.code).toBe(1);
    }
    expect(await written()).toEqual([[], []]);

    await run(s.env, ["first-admin", "--email", "you@example.com", "--username", "robin"]);
    await db.run("UPDATE user SET status = 'disabled' WHERE id = ?", [member.userId]);
    const before = await written();
    for (const email of ["stranger@example.com", "member@example.com", "not an address", "robin"]) {
      const r = await run({ ...s.env, ...ON }, ["signin-link", "--email", email]);
      expect(r.lines, email).toEqual([NO_LINK]);
      expect(r.code).toBe(1);
    }
    expect(await written()).toEqual(before);
  });

  it("without an address for links the admin is still made and the link is a path", async () => {
    const s = await site();
    const env = { DATA_DIR: s.dir, SETUP_CODE };
    const r = await run(env, ["first-admin", "--email", "you@example.com", "--username", "robin"]);
    expect(r.code).toBe(0);
    expect(r.lines.slice(0, 3)).toEqual(CREATED("robin").slice(0, 3));
    expect(r.lines.slice(3, 5)).toEqual([
      "No address for sign-in links is set, so the link is shown without one. Set APP_HOST and TOURS_HOST, or SITE_HOST.",
      "Open your site's address followed by:",
    ]);
    expect(r.lines[5]).toMatch(/^\/signin\/link#c=dpl_[0-9a-f]{40}$/);
    expect(r.lines).toHaveLength(6);
    const db = connect(s.dir);
    expect((await redeemSignInCode(depsOn(db), r.lines[5].split("#c=")[1], null, null))?.userId).toBe(s.userId);

    // The same for a later link; with SITE_HOST set it is whole, and a forged request cannot matter: no request is involved.
    const path = await run({ ...env, ...ON }, ["signin-link", "--email", "you@example.com"]);
    expect(path.code).toBe(0);
    expect(path.lines).toHaveLength(4);
    expect(path.lines[3]).toBe(REMIND);
    expect(path.lines.slice(0, 2)).toEqual(r.lines.slice(3, 5));
    expect(path.lines[2]).toMatch(/^\/signin\/link#c=dpl_[0-9a-f]{40}$/);
    const whole = await run({ ...env, ...ON, SITE_HOST: "Tours.Example.com" }, ["signin-link", "--email", "you@example.com"]);
    expect(whole.lines).toEqual(["Open this link within 15 minutes to sign in:", expect.stringMatching(/^https:\/\/tours\.example\.com\/signin\/link#c=dpl_[0-9a-f]{40}$/), REMIND]);
  });

  it("a link step that fails after the claim was written says so in one sentence and exits 1", async () => {
    const MADE_NO_LINK = "The admin was made, but no link was made. To get one, add the line RECOVERY_LINKS=on to the site's settings file, run the command again with --email alone, then remove the line.";
    // An error from the database while the link is made: the claim is already written.
    const broken = await site();
    const db = connect(broken.dir);
    db.raw.exec("CREATE TRIGGER no_codes BEFORE INSERT ON signin_code BEGIN SELECT RAISE(ABORT, 'made-up failure'); END");
    const r = await run(broken.env, ["first-admin", "--email", "you@example.com", "--username", "robin"]);
    expect(r.lines).toEqual([MADE_NO_LINK]);
    expect(r.code).toBe(1);
    expect(await db.first("SELECT username, is_admin FROM user WHERE id = ?", [broken.userId])).toEqual({ username: "robin", is_admin: 1 });
    // The same error outside a claim is the plain unexpected one.
    const later = await run({ ...broken.env, ...ON }, ["signin-link", "--email", "you@example.com"]);
    expect(later.lines).toEqual(["The command stopped on an unexpected error."]);
    expect(later.code).toBe(1);
    // Once the cause is gone, the email alone gives the link the sentence promised.
    db.raw.exec("DROP TRIGGER no_codes");
    expect((await run({ ...broken.env, ...ON }, ["--email", "you@example.com"])).lines).toEqual(["Open this link within 15 minutes to sign in:", expect.stringMatching(LINK), REMIND]);

    // A link step that refuses (here: the account lost its sign-in method in the same moment).
    const refused = await site();
    const db2 = connect(refused.dir);
    db2.raw.exec("CREATE TRIGGER drop_method AFTER UPDATE OF is_admin ON user BEGIN DELETE FROM signin_method WHERE user_id = NEW.id; END");
    const r2 = await run(refused.env, ["first-admin", "--email", "you@example.com", "--username", "robin"]);
    expect(r2.lines).toEqual([MADE_NO_LINK]);
    expect(r2.code).toBe(1);
    expect(await db2.first("SELECT count(*) AS n FROM user WHERE is_admin = 1")).toEqual({ n: 1 });
  });

  it("a setup that did not finish has its own sentence, and the oldest account of the setup's workspace is the one made admin", async () => {
    const s = await site({ setUp: false });
    const db = connect(s.dir);
    const ws = "ws_" + "b".repeat(24);
    await db.batch([
      { sql: "INSERT INTO workspace (id, name, created_at) VALUES (?, 'Half', 1)", params: [ws] },
      { sql: "INSERT INTO setup (id, workspace_id, completed_at) VALUES (1, ?, 1)", params: [ws] },
    ]);
    const r = await run(s.env, ["first-admin", "--email", "you@example.com", "--username", "robin"]);
    expect(r.lines).toEqual(['This site\'s setup did not finish. Follow "If the setup did not finish" in the hosting guide, then run this again.']);
    expect(r.code).toBe(1);
    expect(await db.all("SELECT * FROM audit")).toEqual([]);

    // Two accounts in that workspace: the older one is the owner.
    const older = "usr_" + "1".repeat(24);
    const newer = "usr_" + "2".repeat(24);
    await db.batch([
      { sql: "INSERT INTO user (id, workspace_id, email, created_at) VALUES (?, ?, 'newer@example.com', 20)", params: [newer, ws] },
      { sql: "INSERT INTO user (id, workspace_id, email, created_at) VALUES (?, ?, 'older@example.com', 10)", params: [older, ws] },
    ]);
    expect((await run(s.env, ["first-admin", "--email", "you@example.com", "--username", "robin"])).code).toBe(0);
    expect(await db.all("SELECT id FROM user WHERE is_admin = 1")).toEqual([{ id: older }]);
  });

  it("the usage names the command the way it was run", async () => {
    const plain = await run({}, ["--help"]);
    expect(plain.lines[0]).toBe("Usage: node dist/node/admin.js <command> [options]");
    const wrapped = await run({ DEMO_PLATFORM_ADMIN_NAME: "./cpanel.sh admin" }, ["nonsense"]);
    expect(wrapped.code).toBe(2);
    expect(wrapped.lines[0]).toBe("Usage: ./cpanel.sh admin <command> [options]");
    // A name that could break a line, or is long, is not used.
    for (const bad of ["x\nUsage: evil", "a".repeat(101), ""]) expect((await run({ DEMO_PLATFORM_ADMIN_NAME: bad }, ["--help"])).lines[0]).toBe(plain.lines[0]);
  });

  it("it runs as the main module only when started as its own file, through any link to it", () => {
    const dir = mkdtempSync(join(tmpdir(), "dp-admin-main-"));
    made.push(dir);
    mkdirSync(join(dir, "real"));
    const file = join(dir, "real", "admin.js");
    writeFileSync(file, "");
    const url = pathToFileURL(file).href;
    expect(isMainModule(file, url)).toBe(true);
    expect(isMainModule(join(dir, "real", ".", "admin.js"), url)).toBe(true);
    if (process.platform === "win32") expect(isMainModule(file.toUpperCase(), url)).toBe(true);
    symlinkSync(join(dir, "real"), join(dir, "linked"), "junction");
    expect(isMainModule(join(dir, "linked", "admin.js"), url)).toBe(true);
    for (const other of [undefined, "", join(dir, "real", "app.cjs"), join(dir, "missing.js")]) expect(isMainModule(other, url), String(other)).toBe(false);
  });

  it("mail-check never prints a setting's value", async () => {
    const values = [SMTP_PASSWORD, "mail.example.com", "no-reply@example.com", "465", SETUP_CODE, "app.example.com", "tours.example.com"];
    const check = async (env: NodeJS.ProcessEnv, line: string, code: number) => {
      const r = await run(env, ["mail-check"], { makeMailer: () => new FakeMailer() });
      expect(r.lines).toEqual([line]);
      expect(r.code).toBe(code);
      for (const v of values) expect(r.lines.join("\n"), v).not.toContain(v);
    };
    // It needs no database: it reads the settings only.
    await check({ ...TWO }, "Mail is off.", 0);
    await check({ ...TWO, MAIL_MODE: "off", SMTP_PASSWORD }, "Mail is off.", 0);
    await check({ ...TWO, ...SMTP, SETUP_CODE }, "Mail is set to SMTP: host, port, user, password and sender are set.", 0);
    for (const name of ["MAIL_FROM", "SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD"] as const) {
      await check({ ...TWO, ...SMTP, [name]: undefined }, `Mail is off because ${name} is missing or not usable.`, 1);
    }
    await check({ ...TWO, ...SMTP, SMTP_PORT: "70000" }, "Mail is off because SMTP_PORT is missing or not usable.", 1);
    await check({ ...TWO, ...SMTP, MAIL_MODE: "sendmail" }, "Mail is off because MAIL_MODE is missing or not usable.", 1);
    await check({ ...SMTP, SITE_HOST: "not a host" }, "Mail is off because SITE_HOST is missing or not usable.", 1);
    await check({ ...SMTP }, "Mail is off because no address for sign-in links is set. Set APP_HOST and TOURS_HOST, or SITE_HOST.", 1);
  });

  it("mail-check sends nothing without --send-to", async () => {
    const mailer = new FakeMailer();
    let madeWith: unknown = null;
    const opts: AdminOptions = {
      makeMailer: (settings) => {
        madeWith = settings;
        return mailer;
      },
    };
    expect((await run({ ...TWO, ...SMTP }, ["mail-check"], opts)).code).toBe(0);
    expect(mailer.sent).toEqual([]);

    // With it: one mail, to that address, saying only that it is a test.
    const sent = await run({ ...TWO, ...SMTP }, ["mail-check", "--send-to", "Ada@Example.com"], opts);
    expect(sent.lines).toEqual(["Mail is set to SMTP: host, port, user, password and sender are set.", "A test mail was handed to the mail server for ada@example.com."]);
    expect(sent.code).toBe(0);
    expect(mailer.sent).toEqual([{ to: "ada@example.com", subject: "Test mail from app.example.com", text: "This is a test mail from the site at app.example.com. Nothing needs to be done.\n" }]);
    expect(madeWith).toMatchObject({ host: "mail.example.com", port: 465, from: "no-reply@example.com" });

    // A mail server that refuses: one line with a fixed word for the reason.
    mailer.failNext();
    const refused = await run({ ...TWO, ...SMTP }, ["mail-check", "--send-to", "ada@example.com"], opts);
    expect(refused.lines[1]).toBe("The mail server did not take the test mail (unknown).");
    expect(refused.code).toBe(1);
    expect(mailer.sent).toHaveLength(1);

    // Mail off, or an address that is none: nothing is sent, and the exit code says so.
    const off = await run({ ...TWO }, ["mail-check", "--send-to", "ada@example.com"], opts);
    expect(off.lines).toEqual(["Mail is off."]);
    expect(off.code).toBe(1);
    const bad = await run({ ...TWO, ...SMTP }, ["mail-check", "--send-to", "ada@example.com\r\nBcc: x@example.com"], opts);
    expect(bad.lines).toEqual(["That is not an email address."]);
    expect(bad.code).toBe(1);
    expect(mailer.sent).toHaveLength(1);
  });

  it("the command stops on a database that is not migrated", async () => {
    const old = await site({ accounts: false });
    const before = files(old.dir);
    for (const argv of [["first-admin", "--email", "you@example.com", "--username", "robin"], ["signin-link", "--email", "you@example.com"], ["audit"]]) {
      const r = await run(old.env, argv);
      expect(r.lines, argv[0]).toEqual(["The database is from an older version. Update the site first."]);
      expect(r.code).toBe(1);
    }
    // It applied nothing itself.
    const db = connect(old.dir);
    expect((await db.all<{ name: string }>("SELECT name FROM _migrations ORDER BY name")).map((m) => m.name)).not.toContain(ACCOUNTS_MIGRATION);
    expect(await db.all("SELECT name FROM sqlite_master WHERE name IN ('membership', 'audit', 'session')")).toEqual([]);
    db.close();
    open.pop();
    expect(files(old.dir).filter((f) => !/db\.sqlite-(wal|shm) /.test(f))).toEqual(before.filter((f) => !/db\.sqlite-(wal|shm) /.test(f)));

    // A database no version has ever opened.
    const blank = mkdtempSync(join(tmpdir(), "dp-admin-cmd-"));
    made.push(blank);
    new NodeDb(join(blank, "db.sqlite")).close();
    expect((await run({ DATA_DIR: blank }, ["audit"])).lines).toEqual(["The database is from an older version. Update the site first."]);
  });

  it("without a data folder or a database it says so and creates nothing", async () => {
    const none = await run({ ...TWO }, ["first-admin", "--email", "you@example.com", "--username", "robin"]);
    expect(none.lines).toEqual(["DATA_DIR is not set, so the site's data is not known. Nothing was changed."]);
    expect(none.code).toBe(1);

    const empty = mkdtempSync(join(tmpdir(), "dp-admin-cmd-"));
    made.push(empty);
    for (const dir of [empty, join(empty, "missing")]) {
      const r = await run({ DATA_DIR: dir }, ["signin-link", "--email", "you@example.com"]);
      expect(r.lines).toEqual(["There is no database in the data folder yet. Start the site once, then run this again."]);
      expect(r.code).toBe(1);
    }
    expect(readdirSync(empty)).toEqual([]);
    expect(existsSync(join(empty, "missing"))).toBe(false);

    // A pair of addresses the app itself would refuse to start with: its own one line, and nothing is done.
    const s = await site();
    const bad = await run({ DATA_DIR: s.dir, APP_HOST: "app.example.com" }, ["first-admin", "--email", "you@example.com", "--username", "robin"]);
    expect(bad.lines).toEqual(["APP_HOST is set but TOURS_HOST is not. Set both for two addresses, or neither for one."]);
    expect(bad.code).toBe(1);
    expect(await connect(s.dir).first("SELECT count(*) AS n FROM user WHERE is_admin = 1")).toEqual({ n: 0 });
  });

  it("audit prints the last rows oldest first", async () => {
    const s = await site();
    expect((await run(s.env, ["audit"])).lines).toEqual(["The audit record is empty."]);
    const db = connect(s.dir);
    const deps = depsOn(db);
    const session = "ses_" + "1".repeat(24);
    let at = Date.UTC(2026, 10, 19, 12, 0, 0);
    deps.now = () => at;
    for (let i = 0; i < 25; i++) {
      at += 1000;
      const row = auditStatement(deps, i === 24 ? { event: "allowance_set", userId: s.userId, workspaceId: s.workspaceId, subject: s.workspaceId, detail: { old: null, new: 1073741824 } } : { event: "signin", userId: s.userId, workspaceId: s.workspaceId, subject: session });
      await db.run(row.sql, row.params);
    }
    const all = await run(s.env, ["audit"]);
    expect(all.code).toBe(0);
    // The last 20 by default, oldest of them first.
    expect(all.lines).toHaveLength(20);
    expect(all.lines[0]).toBe(`2026-11-19T12:00:06.000Z  signin  account=${s.userId}  workspace=${s.workspaceId}  subject=${session}`);
    expect(all.lines[19]).toBe(`2026-11-19T12:00:25.000Z  allowance_set  account=${s.userId}  workspace=${s.workspaceId}  subject=${s.workspaceId}  {"old":null,"new":1073741824}`);
    expect([...all.lines].sort()).toEqual(all.lines);
    const three = await run(s.env, ["audit", "--last", "3"]);
    expect(three.lines).toEqual(all.lines.slice(17));
    expect((await run(s.env, ["audit", "--last=100"])).lines).toHaveLength(25);
    // Reading the record writes nothing.
    expect(await db.first("SELECT count(*) AS n FROM audit")).toEqual({ n: 25 });
    for (const last of ["0", "-1", "ten", "1.5", "100000"]) expect((await run(s.env, ["audit", "--last", last])).code, last).toBe(2);
  });

  it("arguments it does not know print the usage and exit 2, and nothing is done", async () => {
    const s = await site();
    const bad: string[][] = [
      [],
      ["make-admin", "--email", "you@example.com"],
      ["first-admin"],
      ["first-admin", "--email", "you@example.com"],
      ["first-admin", "--username", "robin"],
      ["first-admin", "--email", "you@example.com", "--username"],
      ["first-admin", "--email", "--username", "robin"],
      ["first-admin", "--email", "you@example.com", "--username", "robin", "--admin"],
      ["first-admin", "--email", "you@example.com", "--email", "other@example.com", "--username", "robin"],
      ["first-admin", "--email", "you@example.com", "--username", "robin", "extra"],
      ["signin-link"],
      ["signin-link", "--email", "you@example.com", "--username", "robin"],
      ["--username", "robin"],
      ["mail-check", "--email", "you@example.com"],
      ["audit", "--last"],
    ];
    for (const argv of bad) {
      const r = await run(s.env, argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.lines.join("\n"), argv.join(" ")).toContain("first-admin --email <address> --username <name>");
      // What was typed is not repeated.
      for (const typed of ["you@example.com", "other@example.com", "make-admin", "extra"]) expect(r.lines.join("\n")).not.toContain(typed);
    }
    const help = await run({}, ["--help"]);
    expect(help.code).toBe(0);
    for (const word of ["first-admin", "signin-link", "mail-check", "audit", "--send-to", "--last"]) expect(help.lines.join("\n")).toContain(word);
    const db = connect(s.dir);
    expect(await db.first("SELECT count(*) AS n FROM user WHERE is_admin = 1")).toEqual({ n: 0 });
    expect(await db.all("SELECT * FROM audit")).toEqual([]);
  });

  it("no output holds a password, a hash or a cookie", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stdout = vi.spyOn(process.stdout, "write");
    const stderr = vi.spyOn(process.stderr, "write");

    const s = await site();
    const env = { ...s.env, ...SMTP, ...ON };
    const opts: AdminOptions = { makeMailer: () => new FakeMailer() };
    const said: string[] = [];
    const links: string[] = [];
    for (const argv of [
      ["first-admin", "--email", "you@example.com", "--username", "admin"],
      ["first-admin", "--email", "you@example.com", "--username", "robin"],
      ["first-admin", "--email", "you@example.com", "--username", "robin"],
      ["signin-link", "--email", "you@example.com"],
      ["signin-link", "--email", "stranger@example.com"],
      ["mail-check"],
      ["mail-check", "--send-to", "ada@example.com"],
      ["audit"],
      ["nonsense"],
    ]) {
      const r = await run(env, argv, opts);
      said.push(...r.lines);
      links.push(...r.lines.filter((l) => l.includes("#c=")));
    }
    expect(links).toHaveLength(2);
    // A session made from one of the links, so there is a cookie value to look for.
    const db = connect(s.dir);
    const session = await redeemSignInCode(depsOn(db), links[0].split("#c=")[1], null, null);
    said.push(...(await run(env, ["audit"], opts)).lines);

    const text = said.join("\n");
    const stored = [
      ...(await db.all<{ hash: string }>("SELECT hash FROM signin_code")),
      ...(await db.all<{ hash: string }>("SELECT hash FROM session")),
      ...(await db.all<{ hash: string }>("SELECT hash FROM api_token")),
    ].map((r) => r.hash);
    expect(stored.length).toBeGreaterThanOrEqual(4);
    for (const never of [SMTP_PASSWORD, SETUP_CODE, s.token, session!.secret, ...stored, "mail.example.com", "dps_", "__Host-", "typed-at-setup"]) expect(text, never).not.toContain(never);
    // No token, no digest and no session secret of any kind: the only long hex is the code inside a link.
    expect(text.replace(/#c=dpl_[0-9a-f]{40}$/gm, "")).not.toMatch(/dp_[0-9a-f]{40}|[0-9a-f]{32}/);
    // Everything went through the one output: no line to the console, where a log would catch it.
    for (const spy of [log, error, warn, stdout, stderr]) expect(spy).not.toHaveBeenCalled();
  });
  it("change-email changes an account's address at once, behind RECOVERY_LINKS=on, and says so in one sentence", async () => {
    const s = await site();
    expect((await run(s.env, ["first-admin", "--email", "you@example.com", "--username", "robin"])).code).toBe(0);
    const db = connect(s.dir);
    const written = async () => [await db.all("SELECT id, email FROM user ORDER BY id"), await db.all("SELECT * FROM audit ORDER BY id")];
    const before = await written();
    const CHANGE_OFF = "Changing an email address here is off. To do it, add the line RECOVERY_LINKS=on to the site's settings file, run this again, then remove the line.";
    for (const value of [undefined, "", "off", "yes", "o n"]) {
      const r = await run({ ...s.env, RECOVERY_LINKS: value }, ["change-email", "--username", "robin", "--email", "new@example.com"]);
      expect(r.lines, String(value)).toEqual([CHANGE_OFF]);
      expect(r.code).toBe(1);
    }
    expect(await written()).toEqual(before);

    const done = await run({ ...s.env, ...ON }, ["change-email", "--username", "Robin", "--email", "New@Example.com"]);
    expect(done.lines).toEqual(['The account "robin" now signs in with new@example.com.', REMIND]);
    expect(done.code).toBe(0);
    expect(await db.first("SELECT email FROM user WHERE id = ?", [s.userId])).toEqual({ email: "new@example.com" });
    expect(await db.all("SELECT event, user_id, subject, detail FROM audit WHERE event = 'email_changed_on_server'")).toEqual([{ event: "email_changed_on_server", user_id: s.userId, subject: s.userId, detail: null }]);
    // The new address signs in from now on; the old one does not.
    expect((await run({ ...s.env, ...ON }, ["signin-link", "--email", "new@example.com"])).code).toBe(0);
    expect((await run({ ...s.env, ...ON }, ["signin-link", "--email", "you@example.com"])).lines).toEqual([NO_LINK]);

    // Each refusal: its sentence, exit 1, and nothing written.
    const other = await workspaceStatements(depsOn(db), "Other", "taken@example.com");
    await db.batch(other.stmts);
    const after = await written();
    const refusals: [string[], string][] = [
      [["--username", "robin", "--email", "taken@example.com"], "That email address belongs to another account. Nothing was changed."],
      [["--username", "robin", "--email", "new@example.com"], "That is already the account's email address. Nothing was changed."],
      [["--username", "nobody", "--email", "free@example.com"], "No account has that username. Nothing was changed."],
      [["--username", "a", "--email", "free@example.com"], "No account has that username. Nothing was changed."],
      [["--username", "robin", "--email", "not an address"], "That is not an email address. Nothing was changed."],
      [["--username", "robin", "--email", "x@example.com\r\nBcc: y@example.com"], "That is not an email address. Nothing was changed."],
    ];
    for (const [args, line] of refusals) {
      const r = await run({ ...s.env, ...ON }, ["change-email", ...args]);
      expect(r.lines, args.join(" ")).toEqual([line]);
      expect(r.code).toBe(1);
    }
    expect(await written()).toEqual(after);

    // Arguments it does not take: the usage, which names it, and exit 2.
    for (const argv of [["change-email"], ["change-email", "--username", "robin"], ["change-email", "--email", "x@example.com"], ["change-email", "--username", "robin", "--email", "x@example.com", "--send-to", "y@example.com"]]) {
      const r = await run({ ...s.env, ...ON }, argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.lines.join(" ")).toContain("change-email --username <name> --email <address>");
    }
  });

  it("change-email sends no notice, not even with mail set up: the person at the server tells the account's owner", async () => {
    const s = await site();
    expect((await run(s.env, ["first-admin", "--email", "you@example.com", "--username", "robin"])).code).toBe(0);
    const mailers: FakeMailer[] = [];
    const opts: AdminOptions = { makeMailer: () => (mailers.push(new FakeMailer()), mailers[mailers.length - 1]) };
    const r = await run({ ...s.env, ...SMTP, ...ON }, ["change-email", "--username", "robin", "--email", "new@example.com"], opts);
    expect(r.code).toBe(0);
    expect(mailers.flatMap((m) => m.sent)).toEqual([]);
    expect(mailers).toHaveLength(0);
  });

  it("change-email stops on a database without the email-change migration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dp-admin-cmd-"));
    made.push(dir);
    const migrations = join(dir, "migrations-before-email-change");
    cpSync(MIGRATIONS_DIR, migrations, { recursive: true, filter: (from) => !from.endsWith("0009_email_change.sql") });
    const db = new NodeDb(join(dir, "db.sqlite"));
    await migrate(db, migrations);
    const w = await workspaceStatements(depsOn(db), "Acme", "you@example.com");
    await db.batch([...w.stmts, { sql: "UPDATE user SET username = 'robin' WHERE id = ?", params: [w.userId] }]);
    db.close();
    const r = await run({ DATA_DIR: dir, ...TWO, ...ON }, ["change-email", "--username", "robin", "--email", "new@example.com"]);
    expect(r.lines).toEqual(["The database is from an older version. Update the site first."]);
    expect(r.code).toBe(1);
    expect(await connect(dir).first("SELECT email FROM user WHERE id = ?", [w.userId])).toEqual({ email: "you@example.com" });
  });
});
