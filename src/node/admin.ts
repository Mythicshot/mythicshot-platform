// The server command, run by a person on the server beside the running app:
//
//   node dist/node/admin.js first-admin --email <address> --username <name>
//   node dist/node/admin.js signin-link --email <address>
//   node dist/node/admin.js change-email --username <name> --email <address>
//   node dist/node/admin.js mail-check [--send-to <address>]
//   node dist/node/admin.js audit [--last <n>]
//   node dist/node/admin.js terms publish <file>      ("-" reads the file from standard input)
//   node dist/node/admin.js terms list
//   node dist/node/admin.js terms show <id>
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
//
// Printing a link for an account that exists, and changing an account's email address
// without a mailed link, are recovery tools, behind a gate that is never read from this
// process's environment: app.cjs hands over what the settings file says (RECOVERY_LINKS),
// and run as its own file the gate is what the environment of process 1 says, which in
// the container is the app started from the stack's .env.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEmail } from "../accounts.ts";
import { claimFirstAdmin, setEmailOnServer, signInLinkFor, type ClaimProblem, type EmailSetProblem } from "../admin.ts";
import type { Mailer } from "../mail.ts";
import type { Deps, FileStore } from "../ports.ts";
import { listTerms, parseTerms, publishTerms, showTerms, TERMS_LIMITS } from "../terms.ts";
import { parseUsername } from "../usernames.ts";
import { configFromEnv, mailFromEnv, NODE_SETTINGS } from "./config.ts";
import { NodeDb } from "./db.ts";
import { SmtpError, smtpMailer, type SmtpSettings } from "./smtp.ts";

/**
 * `makeMailer` replaces how the SMTP client is made (tests). `recoveryLinks` is the
 * recovery gate: true lets the command print a link for an account that exists. Absent
 * means closed.
 */
export type AdminOptions = { makeMailer?: (settings: SmtpSettings) => Mailer; recoveryLinks?: boolean; readStdin?: () => Promise<Uint8Array | "too_large"> };

/** The name of the recovery setting. Only this file and the startup file use it. */
const RECOVERY_SETTING = "RECOVERY_LINKS";

/**
 * Every setting the startup file clears from the environment before it reads the
 * settings file for this command, so the file is the command's only source: each one the
 * Node target reads, and the recovery setting.
 */
export const ADMIN_SETTINGS: readonly string[] = [...NODE_SETTINGS, RECOVERY_SETTING];

/**
 * True for the command line of this application's server as the image starts it (the
 * Dockerfile's CMD ["node", "dist/node/entry.js"]): a program named `node`, options
 * after it allowed, then a script that is `dist/node/entry.js` by a relative or an
 * absolute path. A shell, an init wrapper, another script or another program is not it.
 */
function isAppServer(args: string[]): boolean {
  if (args.length < 2 || !/^node(\.exe)?$/.test(basename(args[0]))) return false;
  const script = args.slice(1).find((a) => !a.startsWith("-"));
  if (script === undefined) return false;
  const path = script.replace(/\\/g, "/");
  return path === "dist/node/entry.js" || path.endsWith("/dist/node/entry.js");
}

/** The gate's rule for a written value: `on`, in any case, with spaces around it. Anything else, absent included, is closed. */
export function isRecoveryOn(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "on";
}

/**
 * The gate when the command runs as its own file: what the environment of process 1 says
 * of RECOVERY_LINKS. In a container process 1 is the app, started with the stack's .env,
 * so the gate opens only with the line there and the container recreated; `exec -e`
 * cannot open it. Closed when this is process 1 itself, on any system but Linux, and for
 * any file that cannot be read (shared hosting does not let it be read).
 */
export function recoveryFromProcessOne(at: { pid: number; platform: NodeJS.Platform; read: (path: string) => Buffer } = { pid: process.pid, platform: process.platform, read: (p) => readFileSync(p) }): boolean {
  if (at.pid === 1 || at.platform !== "linux") return false;
  let text: string;
  try {
    // Process 1 counts only when it is this application's own server.
    if (!isAppServer(at.read("/proc/1/cmdline").toString("utf8").split("\0").filter((s) => s !== ""))) return false;
    text = at.read("/proc/1/environ").toString("utf8");
  } catch {
    return false;
  }
  const prefix = `${RECOVERY_SETTING}=`;
  for (const pair of text.split("\0")) if (pair.startsWith(prefix)) return isRecoveryOn(pair.slice(prefix.length));
  return false;
}

/** The migration that made the tables this command reads and writes. */
const ACCOUNTS_MIGRATION = "0008_accounts.sql";
/** The migration that made the table of email changes, which change-email also writes. */
const EMAIL_CHANGE_MIGRATION = "0009_email_change.sql";
/** The migration that made the tables of the terms, which the terms commands read and write. */
const TERMS_MIGRATION = "0018_terms.sql";

/** How the usage names the command when nothing else is said: run as its own file. */
const DIRECT_NAME = "node dist/node/admin.js";

/**
 * The name the usage gives the command: DEMO_PLATFORM_ADMIN_NAME when a wrapper set it to
 * one short line of plain characters (cpanel.sh admin sets it to how it was started
 * itself), else DIRECT_NAME.
 */
function usageName(env: NodeJS.ProcessEnv): string {
  const name = env.DEMO_PLATFORM_ADMIN_NAME;
  return typeof name === "string" && /^[ -~]{1,100}$/.test(name) && name.trim() !== "" ? name : DIRECT_NAME;
}

const usage = (name: string): string[] => [
  `Usage: ${name} <command> [options]`,
  "",
  "  first-admin --email <address> --username <name>",
  "      Make the site's owner its admin, with this address and username, and print a sign-in link. Works once.",
  "  signin-link --email <address>",
  "      Recovery only, while the settings file holds RECOVERY_LINKS=on: print a sign-in link for the account with this address. It works once and for 15 minutes.",
  "  change-email --username <name> --email <address>",
  "      Recovery only, while the settings file holds RECOVERY_LINKS=on: change the email address of the account with this username at once, without a mailed link. For a site whose mail is off.",
  "  mail-check [--send-to <address>]",
  "      Say whether mail is set up, without showing any setting. With --send-to, send one test mail.",
  "  audit [--last <n>]",
  "      Print the last n rows of the audit record, oldest first (default 20, at most 1000).",
  "  terms publish <file>",
  '      Publish the site\'s terms from a plain-text file (the format is in docs/terms-example.txt); "-" reads it from standard input. From then on every account is asked to agree to them before it uses the dashboard.',
  "  terms list",
  "      List every published version of the terms, oldest first, with how many accounts agreed to each.",
  "  terms show <id>",
  "      Print one version of the terms exactly as it was published.",
  "",
  "Without a command, --email with --username is first-admin, and --email alone is signin-link.",
];

const DEFAULT_AUDIT_ROWS = 20;
const MAX_AUDIT_ROWS = 1000;

const SAID = {
  linkFollows: "Open this link within 15 minutes to sign in:",
  noLinkHost: "No address for sign-in links is set, so the link is shown without one. Set APP_HOST and TOURS_HOST, or SITE_HOST.",
  pathFollows: "Open your site's address followed by:",
  noLink: "No link was made. Check the address, and that the site has an admin.",
  notAnEmail: "That is not an email address.",
  older: "The database is from an older version. Update the site first.",
  noDataDir: "DATA_DIR is not set, so the site's data is not known. Nothing was changed.",
  noDatabase: "There is no database in the data folder yet. Start the site once, then run this again.",
  busy: "The database is busy. Try again in a moment.",
  failed: "The command stopped on an unexpected error.",
  madeNoLink: "The admin was made, but no link was made. To get one, add the line RECOVERY_LINKS=on to the site's settings file, run the command again with --email alone, then remove the line.",
  recoveryOff: "Recovery links are off. To get one, add the line RECOVERY_LINKS=on to the site's settings file, run this again, then remove the line.",
  recoveryRemind: "Remove the line RECOVERY_LINKS=on from the settings file now.",
  changeOff: "Changing an email address here is off. To do it, add the line RECOVERY_LINKS=on to the site's settings file, run this again, then remove the line.",
  setupUnfinished: 'This site\'s setup did not finish. Follow "If the setup did not finish" in the hosting guide, then run this again.',
  mailOff: "Mail is off.",
  mailOn: "Mail is set to SMTP: host, port, user, password and sender are set.",
  mailNoLinkHost: "Mail is off because no address for sign-in links is set. Set APP_HOST and TOURS_HOST, or SITE_HOST.",
  auditEmpty: "The audit record is empty.",
} as const;

/** What the terms commands say: fixed lines, and functions for the lines that carry a version's number, id or label. */
export const TERMS_SAID = {
  notRead: "The file could not be read. Nothing was changed.",
  refused: (reason: string) => `The terms were not published: ${reason}`,
  same: (version: { seq: number; id: string } | null) =>
    version === null ? "These terms are the same as a version already published. Nothing was changed." : `These terms are the same as version ${version.seq} (${version.id}), already published. Nothing was changed.`,
  busy: "Another version of the terms was published at the same moment. Nothing was changed; run the command again.",
  published: (seq: number, id: string, label: string) => `Published version ${seq} of the terms, "${label}" (${id}).`,
  publishedNext: "From now on every account is asked to agree to it at its next sign-in or dashboard request. Connected computers keep working.",
  none: "No terms have been published. Nobody is asked to agree to anything.",
  row: (seq: number, id: string, at: number, label: string, agreed: number, current: boolean) =>
    `${seq}  ${id}  ${new Date(at).toISOString()}  "${label}"  ${agreed === 1 ? "1 account agreed" : `${agreed} accounts agreed`}${current ? "  (current)" : ""}`,
  notFound: "No version of the terms has that id.",
  shown: (seq: number, at: number, sha256: string) => `Version ${seq} of the terms, published ${new Date(at).toISOString()}, SHA-256 ${sha256}:`,
} as const;

/**
 * A line of stored text made safe for a terminal: every control character, line or paragraph
 * separator and direction control becomes U+FFFD. parseTerms never stores one; this holds
 * even for a database changed by other means.
 */
function forTerminal(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g, "\ufffd");
}

/**
 * The bytes of a terms file, at most TERMS_LIMITS.fileBytes: "-" is standard input. A relative
 * path is taken from the folder the person ran cpanel.sh in when it says so
 * (DEMO_PLATFORM_ADMIN_FROM, an absolute path), else from this process's own folder. null when
 * there is no such file or it cannot be read; "too_large" past the cap.
 */
async function readTermsFile(file: string, env: NodeJS.ProcessEnv, opts: AdminOptions): Promise<Uint8Array | "too_large" | null> {
  if (file === "-") return (opts.readStdin ?? readStdinCapped)();
  const from = env.DEMO_PLATFORM_ADMIN_FROM;
  const path = isAbsolute(file) || typeof from !== "string" || !isAbsolute(from) ? resolve(file) : resolve(from, file);
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    if (st.size > TERMS_LIMITS.fileBytes) return "too_large";
    const bytes = readFileSync(path);
    return bytes.byteLength > TERMS_LIMITS.fileBytes ? "too_large" : new Uint8Array(bytes);
  } catch {
    return null;
  }
}

/** Standard input, read until it ends or passes TERMS_LIMITS.fileBytes. */
async function readStdinCapped(): Promise<Uint8Array | "too_large"> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    total += chunk.byteLength;
    if (total > TERMS_LIMITS.fileBytes) return "too_large";
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

const REFUSED: Record<ClaimProblem, string> = {
  has_admin: "This site already has an admin. Nothing was changed.",
  not_set_up: "This site is not set up yet. Open the setup page first.",
  bad_email: SAID.notAnEmail,
  email_taken: "That email address belongs to another account.",
  bad_username: "A username is 3 to 30 lowercase letters, digits and hyphens, and starts with a letter.",
  reserved: "That username is reserved. Choose another.",
  username_taken: "That username is taken.",
};

/** What change-email says when it changes nothing. */
const NOT_CHANGED: Record<EmailSetProblem, string> = {
  bad_email: "That is not an email address. Nothing was changed.",
  no_account: "No account has that username. Nothing was changed.",
  email_taken: "That email address belongs to another account. Nothing was changed.",
  same_email: "That is already the account's email address. Nothing was changed.",
};

type Parsed =
  | { kind: "help" }
  | { kind: "change-email"; username: string; email: string }
  | { kind: "first-admin"; email: string; username: string }
  | { kind: "signin-link"; email: string }
  | { kind: "mail-check"; sendTo: string | null }
  | { kind: "audit"; last: number }
  | { kind: "terms-publish"; file: string }
  | { kind: "terms-list" }
  | { kind: "terms-show"; id: string };

const COMMANDS = ["first-admin", "signin-link", "change-email", "mail-check", "audit"] as const;
type Command = (typeof COMMANDS)[number];
const FLAGS: Record<Command | "", readonly string[]> = {
  "": ["--email", "--username"],
  "first-admin": ["--email", "--username"],
  "signin-link": ["--email"],
  "change-email": ["--username", "--email"],
  "mail-check": ["--send-to"],
  audit: ["--last"],
};

/** The arguments as a command, or null for anything it does not take exactly. */
function parseArgs(argv: readonly string[]): Parsed | null {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help")) return { kind: "help" };
  // The terms commands take words, not options: exactly these shapes and nothing more.
  if (argv[0] === "terms") {
    if (argv.length === 2 && argv[1] === "list") return { kind: "terms-list" };
    if (argv.length === 3 && argv[1] === "show" && argv[2] !== "") return { kind: "terms-show", id: argv[2] };
    if (argv.length === 3 && argv[1] === "publish" && argv[2] !== "" && (argv[2] === "-" || !argv[2].startsWith("-"))) return { kind: "terms-publish", file: argv[2] };
    return null;
  }
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
    case "change-email":
      return email === undefined || username === undefined ? null : { kind: "change-email", username, email };
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
function mailState(mail: { mode: "off" | "smtp"; problem: string | null; setting: string | null }): { line: string; usable: boolean; code: number } {
  if (mail.mode === "smtp") return { line: SAID.mailOn, usable: true, code: 0 };
  if (mail.problem === null) return { line: SAID.mailOff, usable: false, code: 0 };
  return { line: mail.setting === null ? SAID.mailNoLinkHost : `Mail is off because ${mail.setting} is missing or not usable.`, usable: false, code: 1 };
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
    for (const line of usage(usageName(env))) out(line);
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
    const state = mailState(mail);
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

    if (parsed.kind === "terms-publish" || parsed.kind === "terms-list" || parsed.kind === "terms-show") {
      if ((await db.first("SELECT 1 AS x FROM _migrations WHERE name = ?", [TERMS_MIGRATION])) === null) {
        out(SAID.older);
        return 1;
      }
      return await termsCommand(parsed, deps, env, out, opts);
    }

    switch (parsed.kind) {
      case "first-admin": {
        // The owner is the oldest account of the workspace the setup row names (claimFirstAdmin).
        const claim = await claimFirstAdmin(deps, { email: parsed.email, username: parsed.username });
        if (!claim.ok) {
          // A setup row with nobody in its workspace is a setup that stopped half-way, not a site never set up.
          const unfinished = claim.problem === "not_set_up" && (await db.first("SELECT 1 AS x FROM setup WHERE id = 1")) !== null;
          out(unfinished ? SAID.setupUnfinished : REFUSED[claim.problem]);
          return 1;
        }
        // The claim is written. Whatever goes wrong from here (a refusal, a busy database,
        // any error), the one true thing to say is that the admin exists and how to get a link.
        let link: Awaited<ReturnType<typeof signInLinkFor>>;
        try {
          link = await signInLinkFor(deps, parsed.email);
        } catch {
          link = { ok: false };
        }
        if (!link.ok) {
          out(SAID.madeNoLink);
          return 1;
        }
        const name = parseUsername(parsed.username);
        out(`The admin account "${name.ok ? name.username : ""}" was created.`);
        out("Your tours, their links and your tokens stay exactly as they are.");
        out("");
        for (const line of linkLines(link)) out(line);
        return 0;
      }
      case "signin-link": {
        // A link for an account that exists is a recovery tool, off unless the settings
        // file says so for this one run: nothing is made or recorded while it is off.
        if (opts.recoveryLinks !== true) {
          out(SAID.recoveryOff);
          return 1;
        }
        const link = await signInLinkFor(deps, parsed.email);
        if (!link.ok) {
          out(SAID.noLink);
          return 1;
        }
        for (const line of linkLines(link)) out(line);
        out(SAID.recoveryRemind);
        return 0;
      }
      case "change-email": {
        // Changing an address without a mailed link is a recovery tool, off unless the
        // settings file says so for this one run: nothing is read or written while it is off.
        if (opts.recoveryLinks !== true) {
          out(SAID.changeOff);
          return 1;
        }
        if ((await db.first("SELECT 1 AS x FROM _migrations WHERE name = ?", [EMAIL_CHANGE_MIGRATION])) === null) {
          out(SAID.older);
          return 1;
        }
        const changed = await setEmailOnServer(deps, { username: parsed.username, email: parsed.email });
        if (!changed.ok) {
          out(NOT_CHANGED[changed.problem]);
          return 1;
        }
        out(`The account "${parsed.username.trim().toLowerCase()}" now signs in with ${changed.email}.`);
        out(SAID.recoveryRemind);
        return 0;
      }
      default: {
        // audit
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

/**
 * The three terms commands, on a database that has the terms tables. publish reads the file
 * before anything else and writes one version in one statement (src/terms.ts); list and show
 * only read. Each prints only its own fixed lines and the version's number, id, time, label and,
 * for show, its text, made safe for the terminal.
 */
async function termsCommand(
  parsed: { kind: "terms-publish"; file: string } | { kind: "terms-list" } | { kind: "terms-show"; id: string },
  deps: Deps,
  env: NodeJS.ProcessEnv,
  out: (line: string) => void,
  opts: AdminOptions,
): Promise<number> {
  if (parsed.kind === "terms-publish") {
    const bytes = await readTermsFile(parsed.file, env, opts);
    if (bytes === null) {
      out(TERMS_SAID.notRead);
      return 1;
    }
    const read = await parseTerms(bytes === "too_large" ? new Uint8Array(TERMS_LIMITS.fileBytes + 1) : bytes);
    if (!read.ok) {
      out(TERMS_SAID.refused(read.reason));
      return 1;
    }
    const made = await publishTerms(deps, read);
    if (!made.ok) {
      out(made.problem === "busy" ? TERMS_SAID.busy : TERMS_SAID.same(made.version));
      return 1;
    }
    out(forTerminal(TERMS_SAID.published(made.seq, made.id, read.terms.version)));
    out(TERMS_SAID.publishedNext);
    return 0;
  }
  if (parsed.kind === "terms-list") {
    const rows = await listTerms(deps);
    if (rows.length === 0) {
      out(TERMS_SAID.none);
      return 0;
    }
    for (const [i, r] of rows.entries()) out(forTerminal(TERMS_SAID.row(r.seq, r.id, r.published_at, r.version, r.agreed, i === rows.length - 1)));
    return 0;
  }
  const found = await showTerms(deps, parsed.id);
  if (found === null) {
    out(TERMS_SAID.notFound);
    return 1;
  }
  out(TERMS_SAID.shown(found.seq, found.answer.published_at, found.sha256));
  out("");
  const lines = found.canonical.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) out(forTerminal(line));
  return 0;
}

/**
 * Runs the command with the environment's settings and the terminal's standard output.
 * `opts.recoveryLinks` is the recovery gate, given by the caller: app.cjs hands over the
 * settings file's value, and a run as its own file hands over recoveryFromProcessOne().
 */
export async function main(argv: string[], opts: { recoveryLinks?: boolean } = {}): Promise<void> {
  // As the app does: anything SQLite creates beside the database is for this account only.
  process.umask(0o077);
  process.exitCode = await runAdmin(argv, process.env, (line) => {
    process.stdout.write(line + "\n");
  }, { recoveryLinks: opts.recoveryLinks === true });
}

/** The usage, to standard output, for a start under this command's name that is not recognised as this file. */
function usageAndStop(): void {
  for (const line of usage(usageName(process.env))) process.stdout.write(line + "\n");
  process.exitCode = 2;
}

/**
 * True when `argv1` (the script Node was started with) is the file at `moduleUrl`, also
 * through a link to it or to its folder, and on Windows whatever the letter case. False
 * for anything else, a path that does not exist included. (import.meta.main is not used:
 * it needs a later Node 24 than the one this package allows.)
 */
export function isMainModule(argv1: string | undefined, moduleUrl: string): boolean {
  if (typeof argv1 !== "string" || argv1 === "") return false;
  const same = (path: string): boolean => {
    try {
      const started = realpathSync.native(path);
      const self = realpathSync.native(fileURLToPath(moduleUrl));
      return process.platform === "win32" ? started.toLowerCase() === self.toLowerCase() : started === self;
    } catch {
      return false;
    }
  };
  // `node dist/node/admin` names the file without its extension.
  return same(argv1) || same(argv1 + ".js");
}

/**
 * What to do when this module is loaded: `run` when Node was started with this file;
 * `usage` when it was started with a file of this file's name that is not it (a copy, or
 * a hard link elsewhere), so that it never ends silently with nothing done; `none` when
 * something else loaded it (app.cjs, a test).
 */
export function mainDecision(argv1: string | undefined, moduleUrl: string): "run" | "usage" | "none" {
  if (isMainModule(argv1, moduleUrl)) return "run";
  if (typeof argv1 !== "string" || argv1 === "") return "none";
  const self = basename(fileURLToPath(moduleUrl)).toLowerCase();
  const started = basename(argv1).toLowerCase();
  return started === self || started + ".js" === self ? "usage" : "none";
}

const decision = mainDecision(process.argv[1], import.meta.url);
if (decision === "run") void main(process.argv.slice(2), { recoveryLinks: recoveryFromProcessOne() });
else if (decision === "usage") usageAndStop();
