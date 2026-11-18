// Guided setup of the platform on Cloudflare, run from a checkout of this repository.
//
//   npm run setup:cloudflare -- [setup|status|update] [--dry-run] [--yes]
//                               [--name <name>] [--domain <host> | --no-domain]
//                               [--replace-existing-domain] [--adopt-existing]
//                               [--new-setup-code] [--help]
//
// setup (the default) checks Node and Wrangler, checks Wrangler is signed in to exactly
// one account, asks for a name and an address, then creates the D1 database and the two
// R2 buckets if they do not exist, writes wrangler.deploy.jsonc (this install's Wrangler
// configuration, built from wrangler.jsonc and ignored by Git), applies the migrations
// to the remote database, deploys, stores a generated setup code as the SETUP_CODE
// secret and prints the setup wizard's address and the code once. status only reads.
// update applies new migrations, then deploys.
//
// Safety rules this script keeps:
// - It never deletes a database, bucket, Worker or secret, and never recreates one that
//   exists: it looks first and reuses what it finds, saying so.
// - In a checkout that has not installed before, a database, bucket or Worker that
//   already has the chosen name is only taken over with --adopt-existing (or the name
//   typed at the prompt); --yes is not enough. Otherwise it stops before any change.
// - Attaching a new own address replaces whatever DNS record or Worker domain that
//   hostname has: Wrangler run without a terminal overrides both without asking. So a
//   new hostname is only attached with --replace-existing-domain (or the hostname typed
//   at the prompt); --yes is not enough. Otherwise it stops before any change.
// - The setup code is generated here from node:crypto, handed to Wrangler on standard
//   input (never as an argument, so it never shows in the process list), never written
//   to a file and printed once, at the end of the run that stored it. A code that is
//   already set is kept and never shown again; only --new-setup-code replaces it.
// - --dry-run makes only reading calls and prints every changing command instead.
// - Every step can be run again: a run that stopped half-way is completed by the next.
//
// Every Wrangler call goes through Io.wrangler, so the tests replace it with a stub.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** The modes this command has. test/docs.test.ts reads these lists from this file's text. */
export const COMMANDS = ["setup", "status", "update"];
/** The options this command takes. */
export const FLAGS = ["--dry-run", "--yes", "--name", "--domain", "--no-domain", "--replace-existing-domain", "--adopt-existing", "--new-setup-code", "--help"];
/** The options that take a value, as the next word. */
const VALUE_FLAGS = ["--name", "--domain"];
/** The options only setup takes. */
const SETUP_ONLY = ["--name", "--domain", "--no-domain", "--replace-existing-domain", "--adopt-existing", "--new-setup-code"];

/** This install's Wrangler configuration, written by this script and ignored by Git. */
export const DEPLOY_CONFIG = "wrangler.deploy.jsonc";
const BASE_CONFIG = "wrangler.jsonc";
const DEFAULT_NAME = "demo-platform";
const MIN_NODE = 24;

const DOCS = {
  runbook: "docs/runbook-cloudflare.md",
  addSite: "https://developers.cloudflare.com/fundamentals/manage-domains/add-site/",
  partial: "https://developers.cloudflare.com/dns/zone-setups/partial-setup/",
};

export type WranglerResult = { code: number; stdout: string; stderr: string };
/**
 * Runs Wrangler with these arguments. `input` goes to its standard input (the only way a
 * secret is ever handed over); `show` echoes its output to the person as it runs.
 */
export type Wrangler = (args: string[], opts?: { input?: string; show?: boolean }) => Promise<WranglerResult>;

export type Io = {
  /** The repository checkout: wrangler.jsonc is read and wrangler.deploy.jsonc written here. */
  root: string;
  wrangler: Wrangler;
  /** True when Wrangler is installed in the checkout (npm ci has run). */
  hasWrangler: () => boolean;
  nodeVersion: string;
  /** The environment; only CLOUDFLARE_ACCOUNT_ID is read, which Wrangler also reads. */
  env: Record<string, string | undefined>;
  /** Asks one question and returns the answer; null when nobody can answer (no terminal). */
  ask: ((question: string) => Promise<string>) | null;
  out: (line: string) => void;
  err: (line: string) => void;
  /** 16 random bytes for the setup code. */
  random: () => Uint8Array;
};

export type Options = {
  command: string;
  dryRun: boolean;
  yes: boolean;
  newSetupCode: boolean;
  replaceExistingDomain: boolean;
  adoptExisting: boolean;
  help: boolean;
  name?: string;
  domain?: string;
  noDomain: boolean;
};

class Stop extends Error {}

export function parseArgs(argv: string[]): Options | { error: string } {
  const o: Options = { command: "setup", dryRun: false, yes: false, newSetupCode: false, replaceExistingDomain: false, adoptExisting: false, help: false, noDomain: false };
  const seen: string[] = [];
  let commandSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("-")) {
      const [flag, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
      if (!FLAGS.includes(flag)) return { error: `Unknown option ${flag}. Run with --help to see the options.` };
      seen.push(flag);
      if (VALUE_FLAGS.includes(flag)) {
        const v = inline ?? argv[++i];
        if (v === undefined || v === "") return { error: `${flag} needs a value, such as ${flag === "--name" ? "--name demo-platform" : "--domain tours.example.com"}.` };
        if (flag === "--name") o.name = v;
        else o.domain = v;
      } else if (inline !== undefined) {
        return { error: `${flag} takes no value.` };
      } else if (flag === "--dry-run") o.dryRun = true;
      else if (flag === "--yes") o.yes = true;
      else if (flag === "--no-domain") o.noDomain = true;
      else if (flag === "--replace-existing-domain") o.replaceExistingDomain = true;
      else if (flag === "--adopt-existing") o.adoptExisting = true;
      else if (flag === "--new-setup-code") o.newSetupCode = true;
      else if (flag === "--help") o.help = true;
    } else {
      if (commandSeen) return { error: `Only one mode can be given; got ${o.command} and ${a}.` };
      if (!COMMANDS.includes(a)) return { error: `Unknown mode ${a}. The modes are ${COMMANDS.join(", ")}.` };
      o.command = a;
      commandSeen = true;
    }
  }
  if (o.domain !== undefined && o.noDomain) return { error: "--domain and --no-domain cannot be used together." };
  const misplaced = seen.filter((f) => SETUP_ONLY.includes(f));
  if (o.command !== "setup" && misplaced.length > 0) return { error: `${misplaced.join(", ")} belong${misplaced.length === 1 ? "s" : ""} to setup, not ${o.command}.` };
  return o;
}

/** Null when the name is usable for the Worker, the database and both buckets, else why not. */
export function checkName(name: string): string | null {
  if (!/^[a-z0-9-]+$/.test(name)) return "Use only lowercase letters, digits and hyphens, such as demo-platform.";
  if (name.length < 3 || name.length > 56) return "Use 3 to 56 characters, so the bucket names stay within R2's 63.";
  if (!/^[a-z]/.test(name) || name.endsWith("-")) return "Start with a letter and do not end with a hyphen.";
  return null;
}

/**
 * The host name in a usable form (lowercase, no trailing dot), or an error saying what is
 * wrong. Only a plain host name is accepted: no scheme, path, port, wildcard or address.
 */
export function checkDomain(input: string): { host: string } | { error: string } {
  const plain = "Enter only the host name, such as tours.example.com";
  const s = input.trim().toLowerCase().replace(/\.$/, "");
  if (s === "") return { error: `${plain}.` };
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) return { error: `${plain}, without https:// in front.` };
  if (/[/?#]/.test(s)) return { error: `${plain}, without a path after it.` };
  if (s.includes(":")) return { error: `${plain}, without a port.` };
  if (s.includes("*")) return { error: `${plain}; a wildcard cannot be the platform's address.` };
  if (/^[0-9.]+$/.test(s)) return { error: `${plain}; an IP address cannot be attached as a custom domain.` };
  const labels = s.split(".");
  if (labels.length < 2 || s.length > 253) return { error: `${plain}: a name with at least one dot.` };
  for (const l of labels) {
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) return { error: `"${input.trim()}" is not a valid host name. ${plain}.` };
  }
  if (!/^[a-z]{2,63}$/.test(labels[labels.length - 1])) return { error: `"${input.trim()}" does not end in a top-level domain. ${plain}.` };
  if (s === "workers.dev" || s.endsWith(".workers.dev")) return { error: "A workers.dev address is Cloudflare's own; choose the free address option instead of entering it." };
  return { host: s };
}

/** Removes // and /* *\/ comments outside strings, so a .jsonc file parses as JSON. */
export function stripJsonComments(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return out;
}

type Json = Record<string, any>;

/**
 * What this script records about an install: everything is in wrangler.deploy.jsonc.
 * `pending` is there while `domain` is confirmed but not yet attached by a deploy that
 * succeeded; `previous` is the address attached before it (null: none).
 */
export type Install = { name: string; domain: string | null; databaseId: string | null; publicImageBase: string; pending?: { previous: string | null } };

/** The comment line in wrangler.deploy.jsonc that records a confirmed address not attached yet. */
const PENDING_LINE = /^\/\/ setup:cloudflare: address (\S+) confirmed, not attached yet; attached before: (\S+)$/m;

/** A wrangler.deploy.jsonc this script cannot use as it stands. */
export class InstallConfigError extends Error {}

function readJsonc(path: string): Json {
  return JSON.parse(stripJsonComments(readFileSync(path, "utf8"))) as Json;
}

/**
 * The install recorded in wrangler.deploy.jsonc, or null when there is none. The name and
 * address are checked with the same rules as the options, since the file can be edited
 * by hand; a bad value throws InstallConfigError.
 */
export function readInstall(root: string): Install | null {
  const path = join(root, DEPLOY_CONFIG);
  if (!existsSync(path)) return null;
  let c: Json;
  try {
    c = readJsonc(path);
  } catch {
    throw new InstallConfigError(`${DEPLOY_CONFIG} is not valid JSON with comments. Fix it by hand, or move it aside and run setup again.`);
  }
  const name = typeof c.name === "string" ? c.name : "";
  const nameError = checkName(name);
  if (nameError !== null) throw new InstallConfigError(`${DEPLOY_CONFIG} names the install "${name}": ${nameError}`);
  const routes: Json[] = Array.isArray(c.routes) ? c.routes : [];
  const domains = routes.filter((r) => r && r.custom_domain === true);
  if (routes.length !== domains.length || domains.length > 1) {
    throw new InstallConfigError(`${DEPLOY_CONFIG} has routes this command did not write; it handles one custom domain only. Fix "routes" by hand.`);
  }
  let domain: string | null = null;
  if (domains.length === 1) {
    const checked = checkDomain(String(domains[0].pattern ?? ""));
    if ("error" in checked) throw new InstallConfigError(`${DEPLOY_CONFIG} has the address "${String(domains[0].pattern)}": ${checked.error}`);
    if (checked.host !== domains[0].pattern) throw new InstallConfigError(`${DEPLOY_CONFIG} has the address "${String(domains[0].pattern)}": write it as ${checked.host}.`);
    domain = checked.host;
  }
  const id = c.d1_databases?.[0]?.database_id;
  const install: Install = {
    name,
    domain,
    databaseId: typeof id === "string" && !/^0{8}-/.test(id) ? id : null,
    publicImageBase: typeof c.vars?.PUBLIC_IMAGE_BASE === "string" ? c.vars.PUBLIC_IMAGE_BASE : "",
  };
  const pending = readFileSync(path, "utf8").match(PENDING_LINE);
  if (pending) {
    const previous = pending[2] === "none" ? null : pending[2];
    if (pending[1] !== domain || (previous !== null && "error" in checkDomain(previous))) {
      throw new InstallConfigError(`${DEPLOY_CONFIG} has a "not attached yet" line that does not match its address. Delete that line, or fix "routes".`);
    }
    install.pending = { previous };
  }
  return install;
}

export function bucketNames(name: string): { drafts: string; pub: string } {
  return { drafts: `${name}-drafts`, pub: `${name}-public` };
}

/** This install's Wrangler configuration: wrangler.jsonc with the install's names, id and address. */
export function deployConfigText(root: string, install: Install & { databaseId: string }): string {
  const c = readJsonc(join(root, BASE_CONFIG));
  const b = bucketNames(install.name);
  c.name = install.name;
  c.d1_databases = (c.d1_databases ?? []).map((d: Json) => (d.binding === "DB" ? { ...d, database_name: install.name, database_id: install.databaseId } : d));
  c.r2_buckets = (c.r2_buckets ?? []).map((r: Json) => (r.binding === "DRAFTS" ? { ...r, bucket_name: b.drafts } : r.binding === "PUB" ? { ...r, bucket_name: b.pub } : r));
  // Set explicitly: with routes present and workers_dev unset, Wrangler turns workers.dev off.
  c.workers_dev = true;
  if (install.domain) c.routes = [{ pattern: install.domain, custom_domain: true }];
  else delete c.routes;
  c.vars = { ...(c.vars ?? {}), PUBLIC_IMAGE_BASE: install.publicImageBase };
  const pending =
    install.domain && install.pending
      ? `// setup:cloudflare: address ${install.domain} confirmed, not attached yet; attached before: ${install.pending.previous ?? "none"}\n`
      : "";
  return (
    "// This install's Wrangler configuration, written by `npm run setup:cloudflare` from\n" +
    "// wrangler.jsonc. Ignored by Git; holds no secret. `update` rewrites it, keeping the\n" +
    "// name, database id, address and PUBLIC_IMAGE_BASE.\n" +
    pending +
    JSON.stringify(c, null, 2) +
    "\n"
  );
}

const say = (io: Io, s: string) => io.out(`\n==> ${s}`);
const info = (io: Io, s: string) => io.out(`    ${s}`);

/** The command a person would type for these Wrangler arguments. */
export function shown(args: string[]): string {
  return "npx wrangler " + args.join(" ");
}

/**
 * What to show of a failed Wrangler call: its own message without colour codes or the
 * generic lines about logs and bug reports, and a plain next step for the failures a
 * new account meets.
 */
export function wranglerError(r: WranglerResult): string[] {
  const text = (r.stderr + "\n" + r.stdout).replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g"), "");
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !/If you think this is a bug|Logs were written to|^-+$/.test(l));
  const out = lines.slice(-6);
  if (/\[code: 10042\]/.test(text)) {
    out.push("R2 is not enabled on this account yet. In the Cloudflare dashboard, open R2 object storage and enable it, then run the same command again.");
  }
  return out;
}

/** A reading call: always run, also in a dry run. Throws Stop when it fails. */
async function read(io: Io, args: string[], what: string): Promise<string> {
  const r = await io.wrangler(args);
  if (r.code !== 0) {
    io.err(`ERROR: could not ${what} (${shown(args)} failed).`);
    for (const l of wranglerError(r)) io.err(`    ${l}`);
    io.err("    Nothing was changed by this step. Fix the cause and run the same command again.");
    throw new Stop();
  }
  return r.stdout;
}

/**
 * True when a failed deploy failed on attaching its custom domain, recognised by the two
 * errors Wrangler's deploy gives for that: the API call to the Worker's domains endpoint
 * failing ("A request to the Cloudflare API (/accounts/…/workers/scripts/<name>/domains/records)
 * failed."), or "Publishing to Custom Domain … was skipped". Anything else is not.
 */
export function isCustomDomainFailure(r: WranglerResult): boolean {
  const text = r.stderr + "\n" + r.stdout;
  return /Cloudflare API \([^)\n]*\/workers\/scripts\/[^)\n]*\/domains\/(?:records|changeset)[^)\n]*\) failed/.test(text) || /Publishing to (?:\d+ )?Custom Domains? .*was skipped/.test(text);
}

/** A changing call: printed instead in a dry run. Returns its output, or throws Stop when it fails. */
async function change(io: Io, o: Options, args: string[], what: string, input?: string, onFail?: (r: WranglerResult) => boolean): Promise<string> {
  if (o.dryRun) {
    info(io, `would run: ${shown(args)}${input === undefined ? "" : "   (the value goes on standard input and is not shown)"}`);
    return "";
  }
  info(io, `running: ${shown(args)}`);
  const r = await io.wrangler(args, input === undefined ? { show: true } : { input, show: true });
  if (r.code !== 0) {
    io.err(`ERROR: could not ${what}.`);
    for (const l of wranglerError(r)) io.err(`    ${l}`);
    if (!onFail || !onFail(r)) io.err("    Everything done before this step is kept. Fix the cause and run the same command again: it picks up where it stopped.");
    throw new Stop();
  }
  return r.stdout;
}

function checkPrerequisites(io: Io): void {
  say(io, "Checking this computer");
  const major = Number(io.nodeVersion.replace(/^v/, "").split(".")[0]);
  if (!(major >= MIN_NODE)) {
    io.err(`ERROR: this needs Node ${MIN_NODE} or later; this computer has ${io.nodeVersion}. Install a current Node and run this again.`);
    throw new Stop();
  }
  info(io, `Node ${io.nodeVersion}: fine`);
  if (!io.hasWrangler()) {
    io.err("ERROR: Wrangler is not installed in this folder. Run `npm ci` here first, then run this again.");
    throw new Stop();
  }
  info(io, "Wrangler: installed");
}

/**
 * The account_id set in the Wrangler configuration this command uses: wrangler.jsonc
 * (reading calls) and wrangler.deploy.jsonc (changing calls). When the two disagree
 * (including one setting it and the other not), the calls could reach two accounts, so
 * it stops.
 */
function configAccountId(root: string): { id: string; file: string } | null {
  const ids: { file: string; id: string | null }[] = [];
  for (const file of [BASE_CONFIG, DEPLOY_CONFIG]) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    let c: Json;
    try {
      c = readJsonc(path);
    } catch {
      continue; // reported where the file is read for its settings
    }
    ids.push({ file, id: typeof c.account_id === "string" && c.account_id !== "" ? c.account_id : null });
  }
  if (ids.length === 2 && ids[0].id !== ids[1].id) {
    throw new InstallConfigError(`account_id differs between ${BASE_CONFIG} and ${DEPLOY_CONFIG}, so Wrangler's calls could reach two accounts. Set the same account_id in both, or remove it from both.`);
  }
  const set = ids.find((x) => x.id !== null);
  return set ? { id: set.id!, file: set.file } : null;
}

/** An account name with any email address in it hidden: the default name is "<email>'s Account". */
export function accountLabel(name: string): string {
  return name.replace(/[^\s@'"]+@[^\s@'"]+/g, "(email hidden)");
}

/**
 * The name of the one account the run acts on, or null in a dry run that is not signed
 * in. A real run that is not signed in, or that sees several accounts without
 * CLOUDFLARE_ACCOUNT_ID naming one of them, stops with what to do.
 */
async function checkSignedIn(io: Io, o: Options): Promise<string | null> {
  say(io, "Checking that Wrangler is signed in to Cloudflare");
  const r = await io.wrangler(["whoami", "--json"]);
  let who: Json | null = null;
  try {
    const start = r.stdout.indexOf("{");
    who = start >= 0 ? (JSON.parse(r.stdout.slice(start)) as Json) : null;
  } catch {
    who = null;
  }
  if (r.code !== 0 || !who || who.loggedIn === false) {
    if (o.dryRun) {
      info(io, "Not signed in. A real run would stop here; this dry run goes on as if the account were empty.");
      return null;
    }
    io.err("ERROR: Wrangler is not signed in to Cloudflare, so nothing was done.");
    io.err("    Run this, sign in in the browser window it opens, then run this command again:");
    io.err("");
    io.err("        npx wrangler login");
    io.err("");
    io.err("    On a computer without a browser, use `npx wrangler login --device` and open the address it prints on another device.");
    io.err("    No Cloudflare account yet? Create one first; the Free plan is enough to start.");
    throw new Stop();
  }
  const accounts: Json[] = Array.isArray(who.accounts) ? who.accounts : [];
  const chosen = io.env.CLOUDFLARE_ACCOUNT_ID;
  // Wrangler prefers an account_id in its configuration over CLOUDFLARE_ACCOUNT_ID, so
  // the account this run acts on is that one when it is set.
  const fromConfig = configAccountId(io.root);
  let account: Json | undefined;
  if (fromConfig) {
    account = accounts.find((a) => a && a.id === fromConfig.id);
    if (!account) {
      io.err(`ERROR: ${fromConfig.file} sets account_id to an account this login cannot use, so nothing was done. Fix or remove account_id there.`);
      throw new Stop();
    }
    if (chosen && chosen !== fromConfig.id) {
      io.err(`ERROR: account_id in ${fromConfig.file} and CLOUDFLARE_ACCOUNT_ID name different accounts, and Wrangler would use the one in the file. Nothing was done. Remove one of them.`);
      throw new Stop();
    }
    info(io, `The account is the one account_id in ${fromConfig.file} names.`);
  } else if (chosen) {
    account = accounts.find((a) => a && a.id === chosen);
    if (!account) {
      io.err("ERROR: CLOUDFLARE_ACCOUNT_ID names an account this login cannot use, so nothing was done. Check the id in the dashboard, or unset it.");
      throw new Stop();
    }
  } else if (accounts.length === 1) {
    account = accounts[0];
  } else {
    io.err(`ERROR: this login can use ${accounts.length === 0 ? "no account" : `${accounts.length} accounts`}, so nothing was done.`);
    if (accounts.length > 1) {
      io.err("    Choose one by setting CLOUDFLARE_ACCOUNT_ID to its id (shown on the account's overview page in the dashboard) for this command, then run it again. These are the accounts:");
      for (const a of accounts) io.err(`      - ${accountLabel(String(a?.name ?? "(no name)"))}`);
    }
    throw new Stop();
  }
  const label = accountLabel(String(account?.name ?? "(no name)"));
  info(io, `Signed in. Account: ${label}`);
  return label;
}

async function askLine(io: Io, o: Options, question: string, fallback: string): Promise<string> {
  if (o.yes || io.ask === null) return fallback;
  const a = (await io.ask(question)).trim();
  return a === "" ? fallback : a;
}

async function askYesNo(io: Io, o: Options, question: string, fallback: boolean): Promise<boolean> {
  if (o.yes || io.ask === null) return fallback;
  for (;;) {
    const a = (await io.ask(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
    if (a === "") return fallback;
    if (a === "y" || a === "yes") return true;
    if (a === "n" || a === "no") return false;
  }
}

/**
 * A confirmation that --yes does not give: the flag, or the exact word typed at the
 * prompt. Without either it stops; nothing has been changed when it is called.
 */
async function confirmStrongly(io: Io, o: Options, flagGiven: boolean, flag: string, word: string): Promise<void> {
  if (o.dryRun) {
    info(io, `A real run would need ${flag}, or ${word} typed at the prompt, to go on.`);
    return;
  }
  if (flagGiven) {
    info(io, `${flag} given: going on.`);
    return;
  }
  if (o.yes || io.ask === null) {
    io.err(`ERROR: this needs ${flag}; --yes is not enough. Nothing was changed.`);
    throw new Stop();
  }
  const typed = (await io.ask(`    Type ${word} to go on, or press Enter to stop: `)).trim().toLowerCase();
  if (typed !== word) {
    io.err("Stopped. Nothing was changed.");
    throw new Stop();
  }
}

type Checked = { ok: string } | { error: string };

async function askValid(io: Io, o: Options, question: string, fallback: string, check: (s: string) => Checked): Promise<string> {
  for (;;) {
    const r = check(await askLine(io, o, question, fallback));
    if ("ok" in r) return r.ok;
    io.err(`    ${r.error}`);
    if (o.yes || io.ask === null) throw new Stop();
  }
}

function explainDomainElsewhere(io: Io, host: string): void {
  say(io, `${host} is not on this Cloudflare account yet, so this run uses the free workers.dev address`);
  info(io, "Cloudflare can only attach an address whose domain is an active zone on your account. Two ways to get there:");
  info(io, `1. Move the domain's DNS to Cloudflare (the Free plan is enough): add the domain, then change its nameservers at your registrar. ${DOCS.addSite}`);
  info(io, `2. Keep your DNS where it is with a partial (CNAME) setup. Cloudflare offers this only on its Business and Enterprise plans. ${DOCS.partial}`);
  info(io, `Once the domain shows as active, run: npm run setup:cloudflare -- --domain ${host}`);
  info(io, `Nothing else changes when you do: the data stays, and only the address you give the recorder changes. See ${DOCS.runbook}.`);
}

/** The install's name and address, from flags, the existing install, or questions. */
async function decide(io: Io, o: Options, existing: Install | null): Promise<{ name: string; domain: string | null }> {
  say(io, "A few questions (press Enter to take the answer in brackets)");
  const nameCheck = (s: string): Checked => {
    const e = checkName(s);
    return e === null ? { ok: s } : { error: e };
  };
  let name: string;
  if (o.name !== undefined) {
    const e = checkName(o.name);
    if (e !== null) {
      io.err(`ERROR: --name ${o.name}: ${e}`);
      throw new Stop();
    }
    name = o.name;
  } else if (existing) {
    name = existing.name;
    info(io, `Name: ${name} (this checkout is already set up under that name)`);
  } else {
    name = await askValid(io, o, `    Name for this install, used for the Worker, the database and the buckets [${DEFAULT_NAME}]: `, DEFAULT_NAME, nameCheck);
  }
  if (existing && name !== existing.name) {
    io.err(`ERROR: this checkout is already set up as ${existing.name}. To set up a second install, use a separate checkout of the repository with a different --name.`);
    throw new Stop();
  }

  const domainCheck = (s: string): Checked => {
    const r = checkDomain(s);
    return "host" in r ? { ok: r.host } : { error: r.error };
  };
  if (o.noDomain) return { name, domain: null };
  if (o.domain !== undefined) {
    const r = checkDomain(o.domain);
    if ("error" in r) {
      io.err(`ERROR: --domain ${o.domain}: ${r.error}`);
      throw new Stop();
    }
    return { name, domain: r.host };
  }
  if (existing?.domain) {
    info(io, `Address: ${existing.domain} (kept; use --no-domain or --domain to change it)`);
    return { name, domain: existing.domain };
  }
  if (o.yes || io.ask === null) {
    info(io, "Address: Cloudflare's free workers.dev address (use --domain to give your own)");
    return { name, domain: null };
  }
  io.out("    Where should the platform answer?");
  io.out("      1. I don't have a domain yet: use Cloudflare's free workers.dev address (you can add a domain later)");
  io.out("      2. My own address, such as tours.example.com");
  let choice = "";
  while (choice !== "1" && choice !== "2") choice = await askLine(io, o, "    Choose 1 or 2 [1]: ", "1");
  if (choice === "1") return { name, domain: null };
  const host = await askValid(io, o, "    The address, as a host name such as tours.example.com: ", "", domainCheck);
  const onCloudflare = await askYesNo(io, o, `    Is the domain of ${host} already active on this Cloudflare account?`, false);
  if (!onCloudflare) {
    explainDomainElsewhere(io, host);
    return { name, domain: null };
  }
  return { name, domain: host };
}

/** What a Worker of this name has on the account: null when there is no such Worker. */
type WorkerFound = { setupCode: boolean } | null;
type Found = { databaseId: string | null; drafts: boolean; pub: boolean; worker: WorkerFound };

/** Whether a Worker of this name exists and has SETUP_CODE, from `secret list --name`. Stops when that cannot be told. */
async function findWorker(io: Io, name: string): Promise<WorkerFound> {
  const args = ["secret", "list", "--name", name];
  const r = await io.wrangler(args);
  if (r.code !== 0) {
    if (/Worker "[^"]*"(?: \(env: [^)]*\))? not found\./.test(r.stderr + r.stdout)) return null;
    io.err(`ERROR: could not tell whether a Worker named ${name} exists (${shown(args)} failed).`);
    for (const l of wranglerError(r)) io.err(`    ${l}`);
    io.err("    Nothing was changed by this step. Fix the cause and run the same command again.");
    throw new Stop();
  }
  const start = r.stdout.indexOf("[");
  try {
    const list = start < 0 ? [] : (JSON.parse(r.stdout.slice(start)) as Json[]);
    return { setupCode: list.some((s) => s && s.name === "SETUP_CODE") };
  } catch {
    io.err(`ERROR: could not read the secrets list of the Worker ${name}. Nothing was changed. Run the same command again.`);
    throw new Stop();
  }
}

async function lookUp(io: Io, name: string, signedIn: boolean): Promise<Found> {
  say(io, "Looking for what already exists on the account");
  if (!signedIn) {
    info(io, "Skipped: not signed in.");
    return { databaseId: null, drafts: false, pub: false, worker: null };
  }
  const databaseId = findDatabase(await read(io, ["d1", "list", "--json"], "list the D1 databases"), name);
  const buckets = listBuckets(await read(io, ["r2", "bucket", "list"], "list the R2 buckets"));
  const worker = await findWorker(io, name);
  const b = bucketNames(name);
  const found = { databaseId, drafts: buckets.has(b.drafts), pub: buckets.has(b.pub), worker };
  info(io, `Database ${name}: ${found.databaseId ? "exists" : "not there yet"}`);
  info(io, `Bucket ${b.drafts}: ${found.drafts ? "exists" : "not there yet"}`);
  info(io, `Bucket ${b.pub}: ${found.pub ? "exists" : "not there yet"}`);
  info(io, `Worker ${name}: ${found.worker ? "exists" : "not there yet"}`);
  return found;
}

export function findDatabase(listJson: string, name: string): string | null {
  const start = listJson.indexOf("[");
  if (start < 0) return null;
  const list = JSON.parse(listJson.slice(start)) as Json[];
  const db = list.find((d) => d && d.name === name);
  const id = db?.uuid ?? db?.database_id;
  return typeof id === "string" ? id : null;
}

export function listBuckets(listText: string): Set<string> {
  return new Set([...listText.matchAll(/^name:\s+(\S+)\s*$/gm)].map((m) => m[1]));
}

/** Writes the deploy config if its text changed; true when it changed (or would, in a dry run). */
function writeConfig(io: Io, o: Options, text: string, quiet = false): boolean {
  const path = join(io.root, DEPLOY_CONFIG);
  const before = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (before === text) {
    if (!quiet) info(io, `${DEPLOY_CONFIG} is already up to date: skipped`);
    return false;
  }
  if (o.dryRun) {
    info(io, `would write ${DEPLOY_CONFIG}`);
    return true;
  }
  writeFileSync(path + ".tmp", text);
  renameSync(path + ".tmp", path);
  info(io, `wrote ${DEPLOY_CONFIG}`);
  return true;
}

/** True when migrations were applied (or would be, in a dry run). */
async function migrate(io: Io, o: Options, name: string, canRead: boolean): Promise<boolean> {
  say(io, "Applying the database migrations to the remote database");
  if (canRead) {
    const pending = await read(io, ["d1", "migrations", "list", name, "--remote", "--config", DEPLOY_CONFIG], "list the migrations still to apply");
    if (/No migrations to apply/i.test(pending)) {
      info(io, "Every migration is already applied: skipped");
      return false;
    }
  }
  await change(io, o, ["d1", "migrations", "apply", name, "--remote", "--config", DEPLOY_CONFIG], "apply the migrations");
  return true;
}

function workersDevAddress(deployOutput: string): string | null {
  return deployOutput.match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev\b/)?.[0] ?? null;
}

async function setup(io: Io, o: Options): Promise<void> {
  checkPrerequisites(io);
  const account = await checkSignedIn(io, o);
  const signedIn = account !== null;
  const existing = readInstall(io.root);
  const { name, domain } = await decide(io, o, existing);
  const found = await lookUp(io, name, signedIn);
  const b = bucketNames(name);

  // Gate 1: same-named resources in a checkout that has not installed before.
  if (!existing) {
    const there = [
      found.databaseId ? `the database ${name}` : null,
      found.drafts ? `the bucket ${b.drafts}` : null,
      found.pub ? `the bucket ${b.pub}` : null,
      found.worker ? `the Worker ${name}` : null,
    ].filter((s): s is string => s !== null);
    if (there.length > 0) {
      say(io, `Things named ${name} already exist on this account, but this checkout has not set them up`);
      info(io, `Found: ${there.join(", ")}.`);
      info(io, "Going on takes them over: this install would use that database and those buckets, and the deploy would replace that Worker's code.");
      info(io, "If they belong to another install, stop and choose another name with --name. If they are this install's (set up from another copy of the repository, or by a run here that stopped before saving its settings), go on.");
      await confirmStrongly(io, o, o.adoptExisting, "--adopt-existing", name);
    }
  }

  // Gate 2: a new own address replaces what that hostname has today. "New" means not in
  // wrangler.deploy.jsonc yet; an address recorded there as confirmed but not attached
  // (an earlier run stopped before its deploy succeeded) is not asked for again.
  const newDomain = domain !== null && domain !== (existing?.domain ?? null);
  const pendingBefore = existing?.pending && existing.domain === domain ? existing.pending : null;
  /** The address attached by the last deploy that succeeded, as far as this checkout knows. */
  const attachedBefore = existing ? (existing.pending ? existing.pending.previous : existing.domain) : null;
  if (newDomain) {
    say(io, `Attaching ${domain} replaces what that address has today`);
    info(io, `If ${domain} already has a DNS record (a website, mail service or anything else) or is the custom domain of another Worker, it WILL be pointed at this platform instead, without a further question: Wrangler does that when it runs without a terminal.`);
    info(io, "This command cannot look the hostname up beforehand. Check the domain's DNS records in the Cloudflare dashboard first.");
    await confirmStrongly(io, o, o.replaceExistingDomain, "--replace-existing-domain", domain);
  }

  say(io, o.dryRun ? "Dry run: nothing below is changed, every changing command is printed instead" : "Here is what happens next");
  info(io, `Account: ${account ?? "(not signed in)"}`);
  info(io, `Database ${name}: ${found.databaseId ? "reuse the one that exists" : "create"}`);
  info(io, `Buckets ${b.drafts} and ${b.pub}: ${found.drafts && found.pub ? "reuse the ones that exist" : "create what is missing"} (neither gets public access)`);
  info(io, `Address: ${domain ? `https://${domain} (attached as a custom domain), plus the free workers.dev address` : "the free workers.dev address"}`);
  info(io, "Then: write the settings, apply the migrations, deploy, and set the setup code if it is not set yet.");
  if (!o.dryRun && !o.yes && io.ask === null) {
    io.err("ERROR: there is no terminal to ask in. Run it again with --yes (and --name or --domain if the defaults do not suit). Nothing was changed.");
    throw new Stop();
  }
  if (!o.dryRun && !(await askYesNo(io, o, "    Go ahead?", true))) {
    info(io, "Stopped. Nothing was changed.");
    return;
  }

  say(io, `Database ${name}`);
  let databaseId = found.databaseId;
  if (databaseId) info(io, `Already exists: reused, not recreated (id ${databaseId})`);
  else {
    await change(io, o, ["d1", "create", name], `create the database ${name}`);
    if (!o.dryRun) {
      databaseId = findDatabase(await read(io, ["d1", "list", "--json"], "list the D1 databases"), name);
      if (!databaseId) {
        io.err(`ERROR: the database ${name} was created but does not show in the list yet. Run the same command again in a minute.`);
        throw new Stop();
      }
      info(io, `Created (id ${databaseId})`);
    }
  }

  // Written as soon as the database id is known, so a run that stops later is this
  // checkout's install on the next run, not something to adopt.
  say(io, `Writing this install's settings to ${DEPLOY_CONFIG}`);
  // A new address is recorded as confirmed but not attached until a deploy succeeds, so a
  // run that stops at any later step keeps the right to take it back out again.
  const install: Install & { databaseId: string } = {
    name,
    domain,
    databaseId: databaseId ?? "00000000-0000-0000-0000-000000000000",
    publicImageBase: existing?.publicImageBase ?? "",
    ...(domain !== null && (newDomain || pendingBefore) ? { pending: { previous: newDomain ? attachedBefore : pendingBefore!.previous } } : {}),
  };
  const configChanged = writeConfig(io, o, deployConfigText(io.root, install));
  for (const [bucket, exists] of [[b.drafts, found.drafts], [b.pub, found.pub]] as const) {
    say(io, `Bucket ${bucket}`);
    if (exists) info(io, "Already exists: reused, not recreated");
    else await change(io, o, ["r2", "bucket", "create", bucket], `create the bucket ${bucket}`);
  }

  const canRead = signedIn && !o.dryRun ? true : signedIn && existsSync(join(io.root, DEPLOY_CONFIG)) && found.databaseId !== null;

  const migrated = await migrate(io, o, name, canRead);

  const codeBefore = found.worker?.setupCode ?? false;
  say(io, "Deploying the Worker");
  let deployOutput = "";
  if (configChanged || migrated || !found.worker || !codeBefore || install.pending) {
    // An address that Cloudflare refuses to attach (most often: its domain is not an active
    // zone on this account) must not stay in the settings, or every later run would stop
    // here again before the setup code: put the previous address back. Any other failure
    // keeps the address as confirmed but not attached, for the next run to try again.
    const pending = install.pending;
    const onFail = pending
      ? (r: WranglerResult): boolean => {
          if (!isCustomDomainFailure(r)) {
            io.err(`    ${domain} stays in ${DEPLOY_CONFIG}, confirmed but not attached yet. Fix the cause above and run the same command again;`);
            io.err(`    if it then fails on the address itself, the command takes the address out again. To give up on it now, run with --no-domain.`);
            return true;
          }
          writeConfig(io, { ...o, dryRun: false }, deployConfigText(io.root, { ...install, domain: pending.previous, pending: undefined }), true);
          io.err(`    Cloudflare would not attach ${domain}, so it was taken out of ${DEPLOY_CONFIG} again${pending.previous ? ` (back to ${pending.previous})` : ""}; running again does not repeat this failure.`);
          io.err("    The most common cause is a domain that is not an active zone on this Cloudflare account. Then either:");
          io.err(`      - set up without it now: npm run setup:cloudflare${pending.previous ? "" : " -- --no-domain"}`);
          io.err(`      - or, once the domain is active on this account: npm run setup:cloudflare -- --domain ${domain} --replace-existing-domain`);
          return true;
        }
      : undefined;
    deployOutput = await change(io, o, ["deploy", "--config", DEPLOY_CONFIG], "deploy the Worker", undefined, onFail);
    if (pending && !o.dryRun) {
      writeConfig(io, o, deployConfigText(io.root, { ...install, pending: undefined }), true);
      info(io, `Attached ${domain}. The certificate for a new custom domain can take a few minutes after the first deploy.`);
    }
  } else {
    info(io, "Already deployed and nothing changed: skipped (use `npm run setup:cloudflare -- update` to deploy a new version)");
  }

  say(io, "The setup code");
  let code: string | null = null;
  if (codeBefore && !o.newSetupCode) {
    info(io, "Already set: kept, and not shown again. If it was lost before setup was finished, run this again with --new-setup-code.");
  } else {
    if (codeBefore) info(io, "--new-setup-code: replacing the code that is set; the old one stops working.");
    const generated = Buffer.from(io.random()).toString("hex");
    if (!/^[0-9a-f]{32,}$/.test(generated)) throw new Error("the random source gave too few bytes");
    await change(io, o, ["secret", "put", "SETUP_CODE", "--config", DEPLOY_CONFIG], "store the setup code", generated);
    if (!o.dryRun) code = generated;
  }

  const address = domain ? `https://${domain}` : workersDevAddress(deployOutput);
  say(io, o.dryRun ? "Dry run finished: nothing was changed" : "Done");
  if (o.dryRun) return;
  if (address) info(io, `Address: ${address}`);
  else info(io, "Address: the workers.dev address Wrangler printed when it deployed, https://<name>.<your-account-subdomain>.workers.dev");
  info(io, `Setup wizard: ${address ?? "that address"}/setup`);
  // With no SETUP_CODE before this run, setup cannot have been finished on this Worker.
  if (code !== null && !codeBefore) {
    io.out("");
    io.out("Open the setup wizard and enter this setup code. It is shown only this once and not saved");
    io.out("anywhere on this computer; keep it until you have finished the wizard:");
    io.out("");
    io.out(`  Setup code:  ${code}`);
    io.out("");
  } else if (code !== null) {
    // A code was set before, so setup may already have been finished, and this command
    // cannot tell: the wizard closes for good once it is.
    io.out("");
    io.out("New setup code. It is shown only this once and not saved anywhere on this computer:");
    io.out("");
    io.out(`  Setup code:  ${code}`);
    io.out("");
    io.out("If setup has not been finished yet, open the setup wizard and enter it there; the old code no longer works.");
    io.out("If setup was already finished, the wizard stays closed and this code opens nothing. It does not reset the");
    io.out(`workspace or the API token. To start setup over after a lost token, see "The token was lost" in ${DOCS.runbook}.`);
  } else if (domain && existing && attachedBefore !== domain) {
    info(io, `If setup was already finished, change the server address in Mythicshot to ${address}. Nothing else changes.`);
  }
}

async function status(io: Io, o: Options): Promise<void> {
  checkPrerequisites(io);
  const existing = readInstall(io.root);
  if (!existing) {
    info(io, `This checkout is not set up yet (no ${DEPLOY_CONFIG}). Run: npm run setup:cloudflare`);
    return;
  }
  const account = await checkSignedIn(io, { ...o, dryRun: false });
  const found = await lookUp(io, existing.name, true);
  say(io, "This install");
  info(io, `Account: ${account}`);
  info(io, `Name: ${existing.name}`);
  info(io, `Address: ${existing.domain ? `https://${existing.domain} (custom domain), and the workers.dev address` : "the workers.dev address only, https://" + existing.name + ".<your-account-subdomain>.workers.dev"}`);
  info(io, `Database id in ${DEPLOY_CONFIG}: ${existing.databaseId ?? "none"}${found.databaseId && found.databaseId !== existing.databaseId ? ` (the account has ${found.databaseId}: run setup again)` : ""}`);
  if (found.databaseId) {
    const pending = await read(io, ["d1", "migrations", "list", existing.name, "--remote", "--config", DEPLOY_CONFIG], "list the migrations still to apply");
    info(io, `Migrations: ${/No migrations to apply/i.test(pending) ? "all applied" : "some still to apply (run update)"}`);
  }
  info(io, `Setup code: ${!found.worker ? "unknown: the Worker is not deployed yet (run setup again)" : found.worker.setupCode ? "set" : "not set (run setup again)"}`);
  info(io, `Published images: ${existing.publicImageBase ? existing.publicImageBase : "served by the app itself on /p/<name>"}`);
}

async function update(io: Io, o: Options): Promise<void> {
  checkPrerequisites(io);
  const existing = readInstall(io.root);
  if (!existing || !existing.databaseId) {
    io.err(`ERROR: this checkout is not set up yet (no ${DEPLOY_CONFIG} with a database id). Run \`npm run setup:cloudflare\` first.`);
    throw new Stop();
  }
  const account = await checkSignedIn(io, { ...o, dryRun: false });
  info(io, `Updating ${existing.name} on the account ${account}`);
  say(io, `Refreshing ${DEPLOY_CONFIG} from wrangler.jsonc, keeping this install's names, id and address`);
  writeConfig(io, o, deployConfigText(io.root, { ...existing, databaseId: existing.databaseId }));
  await migrate(io, o, existing.name, true);
  say(io, "Deploying the new version");
  await change(io, o, ["deploy", "--config", DEPLOY_CONFIG], "deploy the Worker");
  if (existing.pending && !o.dryRun) {
    writeConfig(io, o, deployConfigText(io.root, { ...existing, databaseId: existing.databaseId, pending: undefined }), true);
    info(io, `Attached ${existing.domain}.`);
  }
  say(io, o.dryRun ? "Dry run finished: nothing was changed" : "Done. The setup code and the data were not touched.");
}

export const HELP = `Guided setup of the demo platform on Cloudflare.

  npm run setup:cloudflare -- [setup|status|update] [options]

Modes:
  setup     (default) create what is missing, deploy, and print the setup wizard's address and code
  status    show what exists; changes nothing
  update    apply new migrations, then deploy the new version

Options:
  --dry-run                  make only reading calls; print every changing command instead
  --yes                      take the defaults instead of asking
  --name <name>              the install's name (default ${DEFAULT_NAME})
  --domain <host>            your own address, such as tours.example.com, on a domain active on this account
  --no-domain                use only the free workers.dev address
  --replace-existing-domain  confirm that a new --domain may replace the DNS record or Worker domain it has today
  --adopt-existing           confirm taking over a database, bucket or Worker that already has the name
  --new-setup-code           replace the setup code (when it was lost before setup was finished)
  --help                     show this

With several Cloudflare accounts, set CLOUDFLARE_ACCOUNT_ID to choose one.
It never deletes a database, bucket, Worker or secret. See ${DOCS.runbook}.`;

/** Runs the command; returns the exit code. */
export async function main(argv: string[], io: Io): Promise<number> {
  const o = parseArgs(argv);
  if ("error" in o) {
    io.err(`ERROR: ${o.error}`);
    return 2;
  }
  if (o.help) {
    io.out(HELP);
    return 0;
  }
  try {
    if (o.command === "status") await status(io, o);
    else if (o.command === "update") await update(io, o);
    else await setup(io, o);
    return 0;
  } catch (e) {
    if (e instanceof Stop) return 1;
    if (e instanceof InstallConfigError) {
      io.err(`ERROR: ${e.message} Nothing was changed.`);
      return 1;
    }
    throw e;
  }
}

/** The real Wrangler: the copy installed in the checkout, run with this Node and no shell. */
export function realWrangler(root: string): Wrangler {
  const bin = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
  return (args, opts = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [bin, ...args], {
        cwd: root,
        stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const echo = (s: string) => {
        if (opts.show) process.stdout.write(s.replace(/^(?=.)/gm, "    | "));
      };
      child.stdout!.on("data", (d: Buffer) => {
        stdout += d.toString();
        echo(d.toString());
      });
      child.stderr!.on("data", (d: Buffer) => {
        stderr += d.toString();
        echo(d.toString());
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      if (opts.input !== undefined) child.stdin!.end(opts.input + "\n");
    });
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase()) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const tty = Boolean(process.stdin.isTTY);
  const rl = tty ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const io: Io = {
    root,
    wrangler: realWrangler(root),
    hasWrangler: () => existsSync(join(root, "node_modules", "wrangler", "bin", "wrangler.js")),
    nodeVersion: process.version,
    env: process.env,
    ask: rl ? (q) => new Promise((res) => rl.question(q, res)) : null,
    out: (l) => process.stdout.write(l + "\n"),
    err: (l) => process.stderr.write(l + "\n"),
    random: () => randomBytes(16),
  };
  main(process.argv.slice(2), io).then(
    (code) => {
      rl?.close();
      process.exitCode = code;
    },
    (e: unknown) => {
      rl?.close();
      process.stderr.write(`ERROR: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
