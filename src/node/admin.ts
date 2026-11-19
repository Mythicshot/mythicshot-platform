// The server command, run by a person on the server beside the running app:
//
//   node dist/node/admin.js first-admin --email <address> --username <name>
//   node dist/node/admin.js signin-link --email <address>
//   node dist/node/admin.js mail-check [--send-to <address>]
//   node dist/node/admin.js audit [--last <n>]
//
// Without a command, `--email` with `--username` is first-admin and `--email` alone is
// signin-link, which is how `./cpanel.sh admin --email … --username …` reads.
//
// It reads the same settings as the app (DATA_DIR, the two addresses or SITE_HOST, the
// mail block) from the environment, opens the app's database file with the app's busy
// timeout, and writes in single batches, so it is safe to run while the app runs. It
// never applies a migration: on a database without the accounts migration it stops and
// says to update first. Everything it says goes through `out`, one line at a time, to
// the terminal: no line names a setting's value, a token, the setup code, a digest or a
// cookie. The only secret it ever prints is a sign-in link, which is the point of it.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseEmail } from "../accounts.ts";
import { claimFirstAdmin, signInLinkFor, type ClaimProblem } from "../admin.ts";
import type { Mailer } from "../mail.ts";
import type { Deps, FileStore } from "../ports.ts";
import { parseUsername } from "../usernames.ts";
import { configFromEnv, mailFromEnv } from "./config.ts";
import { NodeDb } from "./db.ts";
import { SmtpError, smtpMailer, type SmtpSettings } from "./smtp.ts";

export type AdminOptions = { makeMailer?: (settings: SmtpSettings) => Mailer };

/** The migration that made the tables this command reads and writes. */
const ACCOUNTS_MIGRATION = "0008_accounts.sql";

const USAGE = [
  "Usage: node dist/node/admin.js <command> [options]",
  "",
  "  first-admin --email <address> --username <name>",
  "      Make the site's owner its admin, with this address and username, and print a sign-in link. Works once.",
  "  signin-link --email <address>",
  "      Print a sign-in link for the account with this address. It works once and for 15 minutes.",
  "  mail-check [--send-to <address>]",
  "      Say whether mail is set up, without showing any setting. With --send-to, send one test mail.",
  "  audit [--last <n>]",
  "      Print the last n rows of the audit record, oldest first (default 20, at most 1000).",
  "",
  "Without a command, --email with --username is first-admin, and --email alone is signin-link.",
];

const DEFAULT_AUDIT_ROWS = 20;
const MAX_AUDIT_ROWS = 1000;

const SAID = {
  linkFollows: "Open this link within 15 minutes to sign in:",
  noLinkHost: "No address for sign-in links is set (APP_HOST and TOURS_HOST, or SITE_HOST), so the link is shown without one. It works once and for 15 minutes.",
  pathFollows: "Open your site's address followed by:",
  noLink: "No link was made. Check the address, and that the site has an admin.",
  notAnEmail: "That is not an email address.",
  older: "The database is from an older version. Update the site first.",
  noDataDir: "DATA_DIR is not set, so the site's data is not known. Nothing was changed.",
  noDatabase: "There is no database in the data folder yet. Start the site once, then run this again.",
  busy: "The database is busy. Try again in a moment.",
  failed: "The command stopped on an error it does not know. Nothing more was changed.",
  mailOff: "Mail is off.",
  mailOn: "Mail is set to SMTP: host, port, user, password and sender are set.",
  mailNoLinkHost: "Mail is off because no address for sign-in links is set. Set APP_HOST and TOURS_HOST, or SITE_HOST.",
  auditEmpty: "The audit record is empty.",
} as const;

const REFUSED: Record<ClaimProblem, string> = {
  has_admin: "This site already has an admin. Nothing was changed.",
  not_set_up: "This site is not set up yet. Open the setup page first.",
  bad_email: SAID.notAnEmail,
  email_taken: "That email address belongs to another account.",
  bad_username: "A username is 3 to 30 lowercase letters, digits and hyphens, and starts with a letter.",
  reserved: "That username is reserved. Choose another.",
  username_taken: "That username is taken.",
};

type Parsed =
  | { kind: "help" }
  | { kind: "first-admin"; email: string; username: string }
  | { kind: "signin-link"; email: string }
  | { kind: "mail-check"; sendTo: string | null }
  | { kind: "audit"; last: number };

const COMMANDS = ["first-admin", "signin-link", "mail-check", "audit"] as const;
type Command = (typeof COMMANDS)[number];
const FLAGS: Record<Command | "", readonly string[]> = {
  "": ["--email", "--username"],
  "first-admin": ["--email", "--username"],
  "signin-link": ["--email"],
  "mail-check": ["--send-to"],
  audit: ["--last"],
};

/** The arguments as a command, or null for anything it does not take exactly. */
function parseArgs(argv: readonly string[]): Parsed | null {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help")) return { kind: "help" };
  let i = 0;
  let command: Command | "" = "";
  if (argv.length > 0 && (COMMANDS as readonly string[]).includes(argv[0])) {
    command = argv[0] as Command;
    i = 1;
  }
  const allowed = FLAGS[command];
  const values = new Map<string, string>();
  for (; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const name = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    if (!allowed.includes(name) || values.has(name)) return null;
    let value: string | undefined;
    if (name !== a) {
      value = a.slice(eq + 1);
    } else {
      value = argv[i + 1];
      i += 1;
    }
    // A value that is missing, empty or another option is no value.
    if (value === undefined || value === "" || value.startsWith("--")) return null;
    values.set(name, value);
  }
  const email = values.get("--email");
  const username = values.get("--username");
  switch (command) {
    case "":
      if (email === undefined) return null;
      return username === undefined ? { kind: "signin-link", email } : { kind: "first-admin", email, username };
    case "first-admin":
      return email === undefined || username === undefined ? null : { kind: "first-admin", email, username };
    case "signin-link":
      return email === undefined ? null : { kind: "signin-link", email };
    case "mail-check":
      return { kind: "mail-check", sendTo: values.get("--send-to") ?? null };
    case "audit": {
      const last = values.get("--last");
      if (last === undefined) return { kind: "audit", last: DEFAULT_AUDIT_ROWS };
      if (!/^[1-9][0-9]{0,3}$/.test(last) || Number(last) > MAX_AUDIT_ROWS) return null;
      return { kind: "audit", last: Number(last) };
    }
  }
}

/** The file stores of these deps: nothing this command does reads or writes a file. */
const NO_FILES: FileStore = {
  put: () => Promise.reject(new Error("the admin command stores no file")),
  get: () => Promise.reject(new Error("the admin command reads no file")),
  delete: () => Promise.reject(new Error("the admin command deletes no file")),
};

/** True for SQLite's answer when another connection held the write lock past the busy timeout. */
function isBusy(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 3; e = e.cause, depth++) {
    if (/\bdatabase is locked\b|\bSQLITE_BUSY\b/i.test(e.message)) return true;
  }
  return false;
}

/** The mail settings in one sentence, with the exit code a check of them gets. Never a value. */
function mailState(problem: string | null, mode: "off" | "smtp"): { line: string; usable: boolean; code: number } {
  if (mode === "smtp") return { line: SAID.mailOn, usable: true, code: 0 };
  if (problem === null) return { line: SAID.mailOff, usable: false, code: 0 };
  const setting = /^mail: off, because ([A-Z_]+) is missing or not usable\./.exec(problem);
  return { line: setting === null ? SAID.mailNoLinkHost : `Mail is off because ${setting[1]} is missing or not usable.`, usable: false, code: 1 };
}

/** The lines that hand a person their link, or the path when the site has no configured address. */
function linkLines(link: { link: string; whole: boolean }): string[] {
  return link.whole ? [SAID.linkFollows, link.link] : [SAID.noLinkHost, SAID.pathFollows, link.link];
}

type AuditRow = { at: number; event: string; user_id: string | null; workspace_id: string | null; subject: string | null; detail: string | null };

/** One audit row as a line: time, event, the ids that are set, and the detail when there is one. */
function auditLine(row: AuditRow): string {
  const parts = [new Date(row.at).toISOString(), row.event];
  if (row.user_id !== null) parts.push(`account=${row.user_id}`);
  if (row.workspace_id !== null) parts.push(`workspace=${row.workspace_id}`);
  if (row.subject !== null) parts.push(`subject=${row.subject}`);
  if (row.detail !== null) parts.push(row.detail);
  return parts.join("  ");
}

/**
 * Runs the command and returns its exit code: 0 when it did what was asked, 1 when it
 * refused or could not, 2 for arguments it does not take (the usage is printed, and
 * nothing of what was typed is repeated). `env` is the app's settings, as the app gets
 * them. `out` takes every line the command says.
 */
export async function runAdmin(argv: string[], env: NodeJS.ProcessEnv, out: (line: string) => void, opts: AdminOptions = {}): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed === null || parsed.kind === "help") {
    for (const line of USAGE) out(line);
    return parsed === null ? 2 : 0;
  }

  if (parsed.kind !== "mail-check" && (typeof env.DATA_DIR !== "string" || env.DATA_DIR === "")) {
    out(SAID.noDataDir);
    return 1;
  }
  let config;
  try {
    config = configFromEnv(env);
  } catch (err) {
    // The app's own one line for a setting it would refuse to start with. It never holds a value.
    out(err instanceof Error ? err.message : SAID.failed);
    return 1;
  }

  if (parsed.kind === "mail-check") {
    const mail = mailFromEnv(env, config, opts.makeMailer ?? smtpMailer);
    let to: string | null = null;
    if (parsed.sendTo !== null) {
      to = parseEmail(parsed.sendTo);
      if (to === null) {
        out(SAID.notAnEmail);
        return 1;
      }
    }
    const state = mailState(mail.problem, mail.mode);
    out(state.line);
    if (to === null) return state.code;
    if (!state.usable) return 1;
    // Mail is on only with an address for links, so this is the app address or SITE_HOST.
    const host = config.hosts?.app ?? config.siteHost ?? "";
    try {
      await mail.mailer.send({ to, subject: `Test mail from ${host}`, text: `This is a test mail from the site at ${host}. Nothing needs to be done.\n` });
    } catch (err) {
      out(`The mail server did not take the test mail (${err instanceof SmtpError ? err.reason : "unknown"}).`);
      return 1;
    }
    out(`A test mail was handed to the mail server for ${to}.`);
    return 0;
  }

  const dbPath = join(env.DATA_DIR as string, "db.sqlite");
  // Opening a file that is not there would create an empty database: never from here.
  if (!existsSync(dbPath)) {
    out(SAID.noDatabase);
    return 1;
  }
  let db: NodeDb | null = null;
  try {
    db = new NodeDb(dbPath);
    const tables = await db.first("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = '_migrations'");
    const migrated = tables === null ? null : await db.first("SELECT 1 AS x FROM _migrations WHERE name = ?", [ACCOUNTS_MIGRATION]);
    if (migrated === null) {
      out(SAID.older);
      return 1;
    }
    const deps: Deps = { db, drafts: NO_FILES, pub: NO_FILES, config, now: () => Date.now() };

    switch (parsed.kind) {
      case "first-admin": {
        const claim = await claimFirstAdmin(deps, { email: parsed.email, username: parsed.username });
        if (!claim.ok) {
          out(REFUSED[claim.problem]);
          return 1;
        }
        const name = parseUsername(parsed.username);
        out(`The admin account "${name.ok ? name.username : ""}" was created.`);
        out("Your tours, their links and your tokens stay exactly as they are.");
        out("");
        const link = await signInLinkFor(deps, parsed.email);
        if (!link.ok) {
          out(SAID.noLink);
          return 1;
        }
        for (const line of linkLines(link)) out(line);
        return 0;
      }
      case "signin-link": {
        const link = await signInLinkFor(deps, parsed.email);
        if (!link.ok) {
          out(SAID.noLink);
          return 1;
        }
        for (const line of linkLines(link)) out(line);
        return 0;
      }
      case "audit": {
        const rows = await db.all<AuditRow>("SELECT at, event, user_id, workspace_id, subject, detail FROM audit ORDER BY at DESC, id DESC LIMIT ?", [parsed.last]);
        if (rows.length === 0) {
          out(SAID.auditEmpty);
          return 0;
        }
        for (const row of rows.reverse()) out(auditLine(row));
        return 0;
      }
    }
  } catch (err) {
    // Fixed lines only: an error's text is never shown, since it could carry anything.
    out(isBusy(err) ? SAID.busy : SAID.failed);
    return 1;
  } finally {
    db?.close();
  }
}

/** Runs the command as `node dist/node/admin.js …`: the environment's settings, the terminal's standard output. */
export async function main(argv: string[]): Promise<void> {
  // As the app does: anything SQLite creates beside the database is for this account only.
  process.umask(0o077);
  process.exitCode = await runAdmin(argv, process.env, (line) => {
    process.stdout.write(line + "\n");
  });
}

if (import.meta.main) void main(process.argv.slice(2));
