// The guided Cloudflare setup command, with Wrangler replaced by a stub that keeps a
// pretend account in memory and records every call.
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkDomain, checkName, DEPLOY_CONFIG, isCustomDomainFailure, main, parseArgs, readInstall, stripJsonComments, wranglerError, type Io, type WranglerResult } from "../scripts/setup-cloudflare.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const DB_ID = "11111111-2222-3333-4444-555555555555";

type Call = { args: string[]; input?: string };

/** The pretend Cloudflare account. */
type Account = {
  signedIn: boolean;
  accounts: { id: string; name: string }[];
  databases: { name: string; uuid: string }[];
  buckets: string[];
  /** Worker names. */
  workers: Set<string>;
  /** SETUP_CODE and other secrets (of any Worker; tests use one at a time). */
  secrets: Map<string, string>;
  pendingMigrations: boolean;
  /** Custom domains the deploy cannot attach (their domain is not on the account). */
  unattachable: Set<string>;
  /** Fail the first call whose shown command contains this text. */
  failOnce?: string;
};

const CHANGING = /^(d1 create|d1 migrations apply|r2 bucket create|deploy|secret put|secret delete|d1 delete|r2 bucket delete|delete)/;

function fakeAccount(over: Partial<Account> = {}): Account {
  return {
    signedIn: true,
    accounts: [{ id: "0123456789abcdef0123456789abcdef", name: "owner@example.com's Account" }],
    databases: [],
    buckets: [],
    workers: new Set(),
    secrets: new Map(),
    pendingMigrations: true,
    unattachable: new Set(),
    ...over,
  };
}

function stub(account: Account, calls: Call[], root: string) {
  return async (args: string[], opts: { input?: string } = {}): Promise<WranglerResult> => {
    calls.push(opts.input === undefined ? { args: [...args] } : { args: [...args], input: opts.input });
    const line = args.join(" ");
    const ok = (stdout = ""): WranglerResult => ({ code: 0, stdout, stderr: "" });
    const fail = (stderr: string): WranglerResult => ({ code: 1, stdout: "", stderr });
    if (account.failOnce && line.includes(account.failOnce)) {
      account.failOnce = undefined;
      return fail("A request to the Cloudflare API failed (simulated).");
    }
    if (line === "whoami --json") return account.signedIn ? ok(JSON.stringify({ loggedIn: true, email: "owner@example.com", accounts: account.accounts })) : fail('{"loggedIn":false}');
    if (!account.signedIn) return fail("You are not authenticated. Please run `wrangler login`.");
    /** The Worker a call is about: --name, or the name in the --config file. */
    const config = () => JSON.parse(stripJsonComments(readFileSync(join(root, args[args.indexOf("--config") + 1]), "utf8")));
    const worker = () => (args.includes("--name") ? args[args.indexOf("--name") + 1] : config().name);
    if (line === "d1 list --json") return ok(JSON.stringify(account.databases.map((d) => ({ uuid: d.uuid, name: d.name }))));
    if (args[0] === "d1" && args[1] === "create") {
      account.databases.push({ name: args[2], uuid: DB_ID });
      return ok("Created");
    }
    if (line === "r2 bucket list") return ok("Listing buckets...\n" + account.buckets.map((b) => `name:           ${b}\ncreation_date:  2026-11-17T00:00:00.000Z`).join("\n\n"));
    if (args[0] === "r2" && args[2] === "create") {
      account.buckets.push(args[3]);
      return ok("Created bucket");
    }
    if (args[0] === "d1" && args[1] === "migrations" && args[2] === "list") return ok(account.pendingMigrations ? "Migrations to be applied:\n0001_init.sql" : "✅ No migrations to apply!");
    if (args[0] === "d1" && args[1] === "migrations" && args[2] === "apply") {
      account.pendingMigrations = false;
      return ok("applied");
    }
    if (args[0] === "deploy") {
      const c = config();
      account.workers.add(c.name); // the script is uploaded before its domains are attached
      // Wrangler's own wording for a failed call to the Worker's domains endpoint; the API's
      // message on the second line is made up for the stub.
      for (const r of c.routes ?? []) {
        if (account.unattachable.has(r.pattern)) {
          return fail(`X [ERROR] A request to the Cloudflare API (/accounts/0123/workers/scripts/${c.name}/domains/records) failed.\n\n  The zone for ${r.pattern} was not found on this account. [code: 100117]`);
        }
      }
      return ok(`Uploaded ${c.name}\nDeployed ${c.name} triggers\n  https://${c.name}.example-account.workers.dev\n`);
    }
    if (args[0] === "secret" && args[1] === "list") {
      const w = worker();
      if (!account.workers.has(w)) return fail(`X [ERROR] Worker "${w}" not found.\nIf this is a new Worker, run \`wrangler deploy\` first to create it.`);
      return ok(JSON.stringify([...account.secrets.keys()].map((name) => ({ name, type: "secret_text" }))));
    }
    if (args[0] === "secret" && args[1] === "put") {
      account.workers.add(worker());
      account.secrets.set(args[2], (opts.input ?? "").trim());
      return ok("Success! Uploaded secret SETUP_CODE");
    }
    return fail(`stub: unexpected call ${line}`);
  };
}

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A fresh copy of the parts of the repository the command reads. */
function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), "dp-setup-"));
  roots.push(root);
  cpSync(join(REPO, "wrangler.jsonc"), join(root, "wrangler.jsonc"));
  cpSync(join(REPO, "migrations"), join(root, "migrations"), { recursive: true });
  return root;
}

function harness(account: Account, opts: { root?: string; answers?: string[]; tty?: boolean; env?: Record<string, string> } = {}) {
  const root = opts.root ?? checkout();
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const answers = [...(opts.answers ?? [])];
  const asked: string[] = [];
  const io: Io = {
    root,
    wrangler: stub(account, calls, root),
    env: opts.env ?? {},
    hasWrangler: () => true,
    nodeVersion: "v24.19.0",
    ask:
      opts.tty === false
        ? null
        : async (q) => {
            asked.push(q);
            return answers.shift() ?? "";
          },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    random: () => Uint8Array.from({ length: 16 }, (_, i) => (i * 37 + 11) & 0xff),
  };
  const run = (...argv: string[]) => main(argv, io);
  return { root, calls, out, err, asked, io, run };
}

const shown = (calls: Call[]) => calls.map((c) => c.args.join(" "));
const changing = (calls: Call[]) => shown(calls).filter((l) => CHANGING.test(l));
const text = (lines: string[]) => lines.join("\n");
const codeIn = (out: string[]) => text(out).match(/Setup code: +([0-9a-f]+)/)?.[1] ?? null;

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

describe("setup:cloudflare from nothing", () => {
  it("creates the database and both buckets, writes the settings, migrates, deploys and sets the code, in that order", async () => {
    const account = fakeAccount();
    const h = harness(account);
    expect(await h.run("--yes")).toBe(0);
    expect(changing(h.calls)).toEqual([
      "d1 create demo-platform",
      "r2 bucket create demo-platform-drafts",
      "r2 bucket create demo-platform-public",
      `d1 migrations apply demo-platform --remote --config ${DEPLOY_CONFIG}`,
      `deploy --config ${DEPLOY_CONFIG}`,
      `secret put SETUP_CODE --config ${DEPLOY_CONFIG}`,
    ]);
    expect(shown(h.calls)[0]).toBe("whoami --json");
    const install = readInstall(h.root)!;
    expect(install).toEqual({ name: "demo-platform", domain: null, databaseId: DB_ID, publicImageBase: "" });
    const config = JSON.parse(stripJsonComments(readFileSync(join(h.root, DEPLOY_CONFIG), "utf8")));
    expect(config.workers_dev).toBe(true);
    expect(config.routes).toBeUndefined();
    expect(config.r2_buckets.map((b: { bucket_name: string }) => b.bucket_name)).toEqual(["demo-platform-drafts", "demo-platform-public"]);
    expect(config.d1_databases[0]).toMatchObject({ binding: "DB", database_name: "demo-platform", database_id: DB_ID, migrations_dir: "migrations" });
    const code = codeIn(h.out);
    expect(code).toMatch(/^[0-9a-f]{32}$/);
    expect(account.secrets.get("SETUP_CODE")).toBe(code);
    expect(text(h.out)).toContain("https://demo-platform.example-account.workers.dev/setup");
    expect(h.err).toEqual([]);
  });

  it("asks for a name and an address, and attaches an own domain that is on Cloudflare", async () => {
    const account = fakeAccount();
    const h = harness(account, { answers: ["tours", "2", "tours.example.com", "y", "tours.example.com", ""] });
    expect(await h.run()).toBe(0);
    expect(h.asked).toHaveLength(6);
    expect(h.asked[4]).toContain("Type tours.example.com");
    expect(changing(h.calls).slice(0, 3)).toEqual(["d1 create tours", "r2 bucket create tours-drafts", "r2 bucket create tours-public"]);
    const config = JSON.parse(stripJsonComments(readFileSync(join(h.root, DEPLOY_CONFIG), "utf8")));
    expect(config.name).toBe("tours");
    expect(config.routes).toEqual([{ pattern: "tours.example.com", custom_domain: true }]);
    expect(config.workers_dev).toBe(true);
    expect(text(h.out)).toContain("Setup wizard: https://tours.example.com/setup");
  });

  it("explains both options and uses workers.dev for a domain that is not on Cloudflare yet", async () => {
    const h = harness(fakeAccount(), { answers: ["", "2", "tours.example.com", "n", ""] });
    expect(await h.run()).toBe(0);
    const out = text(h.out);
    expect(out).toContain("https://developers.cloudflare.com/fundamentals/manage-domains/add-site/");
    expect(out).toContain("https://developers.cloudflare.com/dns/zone-setups/partial-setup/");
    expect(out).toMatch(/Business and Enterprise/);
    expect(out).toContain("npm run setup:cloudflare -- --domain tours.example.com");
    expect(readInstall(h.root)!.domain).toBeNull();
  });
});

describe("setup:cloudflare again", () => {
  it("changes nothing on a second run and says what it skipped", async () => {
    const account = fakeAccount();
    const first = harness(account);
    expect(await first.run("--yes")).toBe(0);
    const config = readFileSync(join(first.root, DEPLOY_CONFIG), "utf8");
    const second = harness(account, { root: first.root });
    expect(await second.run("--yes")).toBe(0);
    expect(changing(second.calls)).toEqual([]);
    expect(readFileSync(join(first.root, DEPLOY_CONFIG), "utf8")).toBe(config);
    const out = text(second.out);
    for (const s of ["Already exists: reused, not recreated", "already up to date: skipped", "already applied: skipped", "nothing changed: skipped", "Already set: kept, and not shown again"]) expect(out).toContain(s);
    expect(codeIn(second.out)).toBeNull();
  });

  it("reuses a database and buckets that already exist", async () => {
    const account = fakeAccount({ databases: [{ name: "demo-platform", uuid: DB_ID }], buckets: ["demo-platform-drafts"] });
    const h = harness(account);
    expect(await h.run("--yes", "--adopt-existing")).toBe(0);
    const c = changing(h.calls);
    expect(c).not.toContain("d1 create demo-platform");
    expect(c).not.toContain("r2 bucket create demo-platform-drafts");
    expect(c).toContain("r2 bucket create demo-platform-public");
    expect(readInstall(h.root)!.databaseId).toBe(DB_ID);
  });

  it("adds a domain later by changing only the address", async () => {
    const account = fakeAccount();
    const first = harness(account);
    expect(await first.run("--yes")).toBe(0);
    const second = harness(account, { root: first.root });
    expect(await second.run("--yes", "--domain", "tours.example.com", "--replace-existing-domain")).toBe(0);
    expect(changing(second.calls)).toEqual([`deploy --config ${DEPLOY_CONFIG}`]);
    expect(readInstall(first.root)).toEqual({ name: "demo-platform", domain: "tours.example.com", databaseId: DB_ID, publicImageBase: "" });
    expect(text(second.out)).toContain("change the server address in Mythicshot to https://tours.example.com");
  });

  it("keeps PUBLIC_IMAGE_BASE set by hand in the install's settings", async () => {
    const account = fakeAccount();
    const first = harness(account);
    expect(await first.run("--yes")).toBe(0);
    const path = join(first.root, DEPLOY_CONFIG);
    writeFileSync(path, readFileSync(path, "utf8").replace('"PUBLIC_IMAGE_BASE": ""', '"PUBLIC_IMAGE_BASE": "https://images.example.com"'));
    const up = harness(account, { root: first.root });
    expect(await up.run("update", "--yes")).toBe(0);
    expect(readInstall(first.root)!.publicImageBase).toBe("https://images.example.com");
  });

  it("refuses a different name in a checkout that is already set up", async () => {
    const account = fakeAccount();
    const first = harness(account);
    expect(await first.run("--yes")).toBe(0);
    const second = harness(account, { root: first.root });
    expect(await second.run("--yes", "--name", "other")).toBe(1);
    expect(text(second.err)).toContain("already set up as demo-platform");
    expect(changing(second.calls)).toEqual([]);
  });

  it("replaces the setup code only with --new-setup-code, and prints the new one once", async () => {
    const account = fakeAccount();
    const first = harness(account);
    expect(await first.run("--yes")).toBe(0);
    account.secrets.set("SETUP_CODE", "old");
    const second = harness(account, { root: first.root });
    expect(await second.run("--yes", "--new-setup-code")).toBe(0);
    expect(changing(second.calls)).toEqual([`secret put SETUP_CODE --config ${DEPLOY_CONFIG}`]);
    expect(account.secrets.get("SETUP_CODE")).toBe(codeIn(second.out));
  });
});

describe("setup:cloudflare --dry-run", () => {
  it("issues no changing call and prints every command it would run", async () => {
    const account = fakeAccount();
    const h = harness(account);
    expect(await h.run("--dry-run", "--yes")).toBe(0);
    expect(changing(h.calls)).toEqual([]);
    const out = text(h.out);
    for (const c of [
      "would run: npx wrangler d1 create demo-platform",
      "would run: npx wrangler r2 bucket create demo-platform-drafts",
      "would run: npx wrangler r2 bucket create demo-platform-public",
      `would write ${DEPLOY_CONFIG}`,
      `would run: npx wrangler d1 migrations apply demo-platform --remote --config ${DEPLOY_CONFIG}`,
      `would run: npx wrangler deploy --config ${DEPLOY_CONFIG}`,
      `would run: npx wrangler secret put SETUP_CODE --config ${DEPLOY_CONFIG}`,
    ])
      expect(out).toContain(c);
    expect(readdirSync(h.root)).not.toContain(DEPLOY_CONFIG);
    expect(codeIn(h.out)).toBeNull();
    expect(account.databases).toEqual([]);
  });

  it("goes on with the plan when not signed in, making no call but whoami", async () => {
    const h = harness(fakeAccount({ signedIn: false }));
    expect(await h.run("--dry-run")).toBe(0);
    expect(shown(h.calls)).toEqual(["whoami --json"]);
    expect(text(h.out)).toContain("A real run would stop here");
    expect(text(h.out)).toContain("would run: npx wrangler deploy");
  });

  it("works for update too", async () => {
    const account = fakeAccount();
    const first = harness(account);
    expect(await first.run("--yes")).toBe(0);
    account.pendingMigrations = true;
    const h = harness(account, { root: first.root });
    expect(await h.run("update", "--dry-run")).toBe(0);
    expect(changing(h.calls)).toEqual([]);
    expect(text(h.out)).toContain(`would run: npx wrangler d1 migrations apply demo-platform --remote --config ${DEPLOY_CONFIG}`);
  });
});

describe("the setup code", () => {
  it("never appears in an argument, in the output except the one final print, or in a file", async () => {
    const account = fakeAccount();
    const h = harness(account, { answers: ["", "1", ""] });
    expect(await h.run()).toBe(0);
    const code = codeIn(h.out)!;
    expect(code).toMatch(/^[0-9a-f]{32}$/);
    for (const c of h.calls) expect(c.args.join(" ")).not.toContain(code);
    expect(h.calls.filter((c) => c.input !== undefined)).toEqual([{ args: ["secret", "put", "SETUP_CODE", "--config", DEPLOY_CONFIG], input: code }]);
    expect(h.out.filter((l) => l.includes(code))).toEqual([`  Setup code:  ${code}`]);
    expect(text(h.err)).not.toContain(code);
    for (const f of filesUnder(h.root)) expect(readFileSync(f, "utf8"), f).not.toContain(code);
    // A later status, update and setup never show it.
    for (const argv of [["status"], ["update", "--yes"], ["--yes"]]) {
      const again = harness(account, { root: h.root });
      expect(await again.run(...argv)).toBe(0);
      expect(text(again.out) + text(again.err)).not.toContain(code);
    }
  });

  it("the real generator gives 32 hex characters from node:crypto", async () => {
    const src = readFileSync(join(REPO, "scripts/setup-cloudflare.ts"), "utf8");
    expect(src).toContain('import { randomBytes } from "node:crypto"');
    expect(src).toContain("random: () => randomBytes(16)");
  });
});

describe("a run that stops half-way", () => {
  for (const step of ["r2 bucket create demo-platform-public", "d1 migrations apply", "deploy --config", "secret put"]) {
    it(`completes on the next run after "${step}" failed`, async () => {
      const account = fakeAccount({ failOnce: step });
      const first = harness(account);
      expect(await first.run("--yes")).toBe(1);
      expect(text(first.err)).toContain("run the same command again");
      expect(codeIn(first.out)).toBeNull();
      const second = harness(account, { root: first.root });
      expect(await second.run("--yes")).toBe(0);
      expect(account.databases).toHaveLength(1);
      expect(account.buckets.sort()).toEqual(["demo-platform-drafts", "demo-platform-public"]);
      expect(account.pendingMigrations).toBe(false);
      expect(account.workers.has("demo-platform")).toBe(true);
      expect(account.secrets.get("SETUP_CODE")).toBe(codeIn(second.out));
      expect(shown(second.calls)).not.toContain("d1 create demo-platform");
    });
  }
});

describe("not signed in", () => {
  it("stops before anything else and says exactly what to run", async () => {
    const h = harness(fakeAccount({ signedIn: false }));
    expect(await h.run()).toBe(1);
    expect(shown(h.calls)).toEqual(["whoami --json"]);
    expect(h.asked).toEqual([]);
    expect(text(h.err)).toContain("npx wrangler login");
    expect(readdirSync(h.root)).not.toContain(DEPLOY_CONFIG);
  });

  it("status and update stop too", async () => {
    const account = fakeAccount();
    const first = harness(account);
    expect(await first.run("--yes")).toBe(0);
    account.signedIn = false;
    for (const mode of ["status", "update"]) {
      const h = harness(account, { root: first.root });
      expect(await h.run(mode)).toBe(1);
      expect(shown(h.calls)).toEqual(["whoami --json"]);
    }
  });
});

describe("prerequisites", () => {
  it("stops on an old Node or a missing Wrangler, before calling Wrangler", async () => {
    const old = harness(fakeAccount());
    old.io.nodeVersion = "v22.11.0";
    expect(await old.run()).toBe(1);
    expect(text(old.err)).toContain("Node 24 or later");
    const none = harness(fakeAccount());
    none.io.hasWrangler = () => false;
    expect(await none.run()).toBe(1);
    expect(text(none.err)).toContain("npm ci");
    expect(old.calls.length + none.calls.length).toBe(0);
  });

  it("without a terminal it asks for --yes instead of going ahead", async () => {
    const h = harness(fakeAccount(), { tty: false });
    expect(await h.run()).toBe(1);
    expect(text(h.err)).toContain("--yes");
    expect(changing(h.calls)).toEqual([]);
  });
});

describe("answers are checked", () => {
  it("refuses a domain that is not a plain host name, with a clear message", () => {
    for (const bad of ["https://tours.example.com", "tours.example.com/setup", "tours.example.com:8443", "*.example.com", "203.0.113.10", "localhost", "tours_example.com", "-tours.example.com", "demo.example-account.workers.dev"]) {
      const r = checkDomain(bad);
      expect("error" in r, bad).toBe(true);
      if ("error" in r) expect(r.error, bad).toMatch(/tours\.example\.com|workers\.dev/);
    }
    expect(checkDomain(" Tours.Example.com. ")).toEqual({ host: "tours.example.com" });
  });

  it("asks again after a bad domain, and stops with the message on a bad --domain", async () => {
    const asked = harness(fakeAccount(), { answers: ["", "2", "https://tours.example.com/", "tours.example.com", "y", "tours.example.com", ""] });
    expect(await asked.run()).toBe(0);
    expect(text(asked.err)).toContain("without https:// in front");
    expect(readInstall(asked.root)!.domain).toBe("tours.example.com");
    const flag = harness(fakeAccount());
    expect(await flag.run("--yes", "--domain", "https://tours.example.com")).toBe(1);
    expect(text(flag.err)).toContain("without https:// in front");
    expect(changing(flag.calls)).toEqual([]);
  });

  it("refuses a name that cannot name the Worker, database and buckets", async () => {
    for (const bad of ["Demo", "de", "demo_platform", "-demo", "demo-", "a".repeat(57)]) expect(checkName(bad), bad).not.toBeNull();
    expect(checkName("demo-platform")).toBeNull();
    const h = harness(fakeAccount());
    expect(await h.run("--yes", "--name", "Demo Platform")).toBe(1);
    expect(changing(h.calls)).toEqual([]);
  });

  it("parses modes and options, and refuses unknown ones", () => {
    expect(parseArgs([])).toMatchObject({ command: "setup", dryRun: false });
    expect(parseArgs(["status"])).toMatchObject({ command: "status" });
    expect(parseArgs(["update", "--dry-run"])).toMatchObject({ command: "update", dryRun: true });
    expect(parseArgs(["--domain=tours.example.com"])).toMatchObject({ domain: "tours.example.com" });
    for (const bad of [["delete"], ["--force"], ["--domain"], ["--domain", "a", "--no-domain"], ["status", "update"], ["status", "--new-setup-code"]]) expect(parseArgs(bad), bad.join(" ")).toHaveProperty("error");
  });
});

describe("status", () => {
  it("only reads", async () => {
    const account = fakeAccount();
    const first = harness(account);
    expect(await first.run("--yes")).toBe(0);
    const h = harness(account, { root: first.root });
    expect(await h.run("status")).toBe(0);
    expect(changing(h.calls)).toEqual([]);
    const out = text(h.out);
    expect(out).toContain("Setup code: set");
    expect(out).toContain("Migrations: all applied");
  });
});

describe("update", () => {
  it("applies new migrations, then deploys, and never touches the setup code", async () => {
    const account = fakeAccount();
    const first = harness(account);
    expect(await first.run("--yes")).toBe(0);
    account.pendingMigrations = true;
    const h = harness(account, { root: first.root });
    expect(await h.run("update")).toBe(0);
    expect(changing(h.calls)).toEqual([`d1 migrations apply demo-platform --remote --config ${DEPLOY_CONFIG}`, `deploy --config ${DEPLOY_CONFIG}`]);
  });

  it("refuses to run in a checkout that is not set up", async () => {
    const h = harness(fakeAccount());
    expect(await h.run("update")).toBe(1);
    expect(text(h.err)).toContain("npm run setup:cloudflare");
    expect(h.calls).toEqual([]);
  });
});

describe("Wrangler's errors", () => {
  it("are shown without colour codes or generic lines, with a next step when R2 is not enabled", async () => {
    const r = {
      code: 1,
      stdout: "",
      stderr:
        "\u001b[31mX [ERROR]\u001b[0m A request to the Cloudflare API (/accounts/<id>/r2/buckets) failed.\n\n  Please enable R2 through the Cloudflare Dashboard. [code: 10042]\n\n  If you think this is a bug, please open an issue.\n🪵  Logs were written to \"x.log\"\n",
    };
    const lines = wranglerError(r);
    expect(lines.join("\n")).not.toMatch(/\u001b|bug|Logs were written/);
    expect(lines).toContain("Please enable R2 through the Cloudflare Dashboard. [code: 10042]");
    expect(lines.at(-1)).toMatch(/R2 is not enabled on this account yet/);
    const h = harness(fakeAccount({ failOnce: "r2 bucket list" }));
    expect(await h.run("--yes")).toBe(1);
    expect(changing(h.calls)).toEqual([]);
  });
});

/** Calls that create, attach, deploy or store something: none may happen before a gate is passed. */
const noChange = (calls: Call[]) => expect(changing(calls)).toEqual([]);

describe("a new own address (it replaces what that hostname has)", () => {
  it("stops with --yes alone, before anything is created or deployed", async () => {
    const h = harness(fakeAccount());
    expect(await h.run("--yes", "--domain", "www.example.com")).toBe(1);
    expect(text(h.out)).toMatch(/WILL be pointed at this platform/);
    expect(text(h.err)).toContain("--replace-existing-domain; --yes is not enough");
    noChange(h.calls);
    expect(readdirSync(h.root)).not.toContain(DEPLOY_CONFIG);
  });

  it("stops without a terminal, and when the hostname typed at the prompt does not match", async () => {
    const none = harness(fakeAccount(), { tty: false });
    expect(await none.run("--domain", "www.example.com")).toBe(1);
    noChange(none.calls);
    const typo = harness(fakeAccount(), { answers: ["", "www.exampel.com"] });
    expect(await typo.run("--domain", "www.example.com")).toBe(1);
    noChange(typo.calls);
  });

  it("goes on with --replace-existing-domain, or with the hostname typed", async () => {
    const flag = harness(fakeAccount());
    expect(await flag.run("--yes", "--domain", "www.example.com", "--replace-existing-domain")).toBe(0);
    expect(readInstall(flag.root)!.domain).toBe("www.example.com");
    const typed = harness(fakeAccount(), { answers: ["", "www.example.com", ""] });
    expect(await typed.run("--domain", "www.example.com")).toBe(0);
  });

  it("asks again when the address changes, but not on a re-run with the same address", async () => {
    const account = fakeAccount();
    const first = harness(account);
    expect(await first.run("--yes", "--domain", "tours.example.com", "--replace-existing-domain")).toBe(0);
    const same = harness(account, { root: first.root });
    expect(await same.run("--yes")).toBe(0);
    const other = harness(account, { root: first.root });
    expect(await other.run("--yes", "--domain", "www.example.com")).toBe(1);
    noChange(other.calls);
    expect(readInstall(first.root)!.domain).toBe("tours.example.com");
  });

  it("a dry run says the flag would be needed and changes nothing", async () => {
    const h = harness(fakeAccount());
    expect(await h.run("--dry-run", "--domain", "www.example.com")).toBe(0);
    expect(text(h.out)).toContain("A real run would need --replace-existing-domain");
    noChange(h.calls);
  });
});

describe("a domain that cannot be attached", () => {
  it("is taken out of the settings again, so the next run completes, and says what to do", async () => {
    const account = fakeAccount({ unattachable: new Set(["tours.example.com"]) });
    const first = harness(account);
    expect(await first.run("--yes", "--domain", "tours.example.com", "--replace-existing-domain")).toBe(1);
    const err = text(first.err);
    expect(err).toContain("npm run setup:cloudflare -- --no-domain");
    expect(err).toContain("taken out of wrangler.deploy.jsonc again");
    expect(readInstall(first.root)!.domain).toBeNull();
    expect(account.secrets.has("SETUP_CODE")).toBe(false);
    const again = harness(account, { root: first.root });
    expect(await again.run("--yes")).toBe(0);
    expect(account.secrets.get("SETUP_CODE")).toBe(codeIn(again.out));
  });
});

describe("same-named things in a checkout that has not installed before", () => {
  const cases: [string, Partial<Account>][] = [
    ["a database", { databases: [{ name: "demo-platform", uuid: DB_ID }] }],
    ["a bucket", { buckets: ["demo-platform-public"] }],
    ["a Worker", { workers: new Set(["demo-platform"]) }],
  ];
  for (const [what, over] of cases) {
    it(`${what}: lists it and stops with --yes alone, before any change`, async () => {
      const h = harness(fakeAccount(over));
      expect(await h.run("--yes")).toBe(1);
      expect(text(h.out)).toContain("already exist on this account, but this checkout has not set them up");
      expect(text(h.err)).toContain("--adopt-existing; --yes is not enough");
      noChange(h.calls);
      expect(readdirSync(h.root)).not.toContain(DEPLOY_CONFIG);
    });
  }

  it("a second checkout with the default name cannot take over the first install", async () => {
    const account = fakeAccount();
    const first = harness(account);
    expect(await first.run("--yes")).toBe(0);
    const second = harness(account); // a fresh checkout
    expect(await second.run("--yes")).toBe(1);
    noChange(second.calls);
    const named = harness(account);
    expect(await named.run("--yes", "--name", "tours-two")).toBe(0);
  });

  it("goes on with the name typed, and keeps the code the Worker has", async () => {
    const account = fakeAccount({ workers: new Set(["demo-platform"]), secrets: new Map([["SETUP_CODE", "old"]]) });
    const h = harness(account, { answers: ["", "", "demo-platform", ""] });
    expect(await h.run()).toBe(0);
    expect(account.secrets.get("SETUP_CODE")).toBe("old");
    expect(codeIn(h.out)).toBeNull();
  });
});

describe("the account", () => {
  it("is named in the plan, with no email address or account id", async () => {
    const h = harness(fakeAccount());
    expect(await h.run("--yes")).toBe(0);
    const out = text(h.out);
    expect(out).toContain("Account: (email hidden)'s Account");
    expect(out).not.toContain("owner@example.com");
    expect(out).not.toContain("0123456789abcdef0123456789abcdef");
  });

  it("with several accounts, stops before anything else and explains CLOUDFLARE_ACCOUNT_ID", async () => {
    const accounts = [
      { id: "a".repeat(32), name: "Acme Tours" },
      { id: "b".repeat(32), name: "Side project" },
    ];
    const h = harness(fakeAccount({ accounts }));
    expect(await h.run("--yes")).toBe(1);
    expect(text(h.err)).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(text(h.err)).toContain("Side project");
    expect(shown(h.calls)).toEqual(["whoami --json"]);
    const chosen = harness(fakeAccount({ accounts }), { env: { CLOUDFLARE_ACCOUNT_ID: "b".repeat(32) } });
    expect(await chosen.run("--yes")).toBe(0);
    expect(text(chosen.out)).toContain("Account: Side project");
    const wrong = harness(fakeAccount({ accounts }), { env: { CLOUDFLARE_ACCOUNT_ID: "c".repeat(32) } });
    expect(await wrong.run("--yes")).toBe(1);
    expect(shown(wrong.calls)).toEqual(["whoami --json"]);
  });
});

describe("--new-setup-code on an install that had a code", () => {
  it("says the code does nothing if setup was already finished", async () => {
    const account = fakeAccount();
    const first = harness(account);
    expect(await first.run("--yes")).toBe(0);
    expect(text(first.out)).toContain("Open the setup wizard and enter this setup code");
    const again = harness(account, { root: first.root });
    expect(await again.run("--yes", "--new-setup-code")).toBe(0);
    const out = text(again.out);
    expect(out).not.toContain("Open the setup wizard and enter this setup code");
    expect(out).toContain("If setup was already finished, the wizard stays closed and this code opens nothing");
    expect(out).toContain("The token was lost");
  });
});

describe("a hand-edited wrangler.deploy.jsonc", () => {
  const cases: [string, string, string][] = [
    ["a bad name", '"name": "demo-platform"', '"name": "Demo Platform"'],
    ["a domain that is not a plain host name", '"pattern": "tours.example.com"', '"pattern": "https://tours.example.com/"'],
    ["a domain in capitals", '"pattern": "tours.example.com"', '"pattern": "Tours.example.com"'],
  ];
  for (const [label, from, to] of cases) {
    it(`with ${label} stops every mode before any change`, async () => {
      const account = fakeAccount();
      const first = harness(account);
      expect(await first.run("--yes", "--domain", "tours.example.com", "--replace-existing-domain")).toBe(0);
      const path = join(first.root, DEPLOY_CONFIG);
      const before = readFileSync(path, "utf8");
      expect(before).toContain(from);
      writeFileSync(path, before.replace(from, to));
      for (const argv of [["--yes"], ["update", "--yes"], ["status"]]) {
        const h = harness(account, { root: first.root });
        expect(await h.run(...argv), argv.join(" ")).toBe(1);
        expect(text(h.err)).toContain(DEPLOY_CONFIG);
        noChange(h.calls);
      }
    });
  }
});

describe("an address confirmed in a run that stopped before its deploy", () => {
  it("is still taken back out when a later run's deploy fails on it, and the run after completes", async () => {
    // A new account with R2 off and a domain that is not active yet.
    const account = fakeAccount({ unattachable: new Set(["tours.example.com"]), failOnce: "r2 bucket create" });
    const first = harness(account);
    expect(await first.run("--yes", "--domain", "tours.example.com", "--replace-existing-domain")).toBe(1);
    expect(readInstall(first.root)).toMatchObject({ domain: "tours.example.com", pending: { previous: null } });
    expect(changing(first.calls)).not.toContain(`deploy --config ${DEPLOY_CONFIG}`);

    // R2 is on now; the domain still is not. No second confirmation is asked for.
    const second = harness(account, { root: first.root });
    expect(await second.run("--yes")).toBe(1);
    expect(text(second.err)).not.toContain("--replace-existing-domain; --yes is not enough");
    expect(text(second.err)).toContain("Cloudflare would not attach tours.example.com");
    expect(readInstall(first.root)!.domain).toBeNull();
    expect(account.secrets.has("SETUP_CODE")).toBe(false);

    const third = harness(account, { root: first.root });
    expect(await third.run("--yes")).toBe(0);
    expect(account.secrets.get("SETUP_CODE")).toBe(codeIn(third.out));
  });

  it("goes back to the address attached before, not to none", async () => {
    const account = fakeAccount();
    const first = harness(account);
    expect(await first.run("--yes", "--domain", "tours.example.com", "--replace-existing-domain")).toBe(0);
    account.unattachable.add("www.example.com");
    account.failOnce = "d1 migrations list"; // the run stops before its deploy
    const second = harness(account, { root: first.root });
    expect(await second.run("--yes", "--domain", "www.example.com", "--replace-existing-domain")).toBe(1);
    expect(readInstall(first.root)).toMatchObject({ domain: "www.example.com", pending: { previous: "tours.example.com" } });
    const third = harness(account, { root: first.root });
    expect(await third.run("--yes")).toBe(1);
    expect(readInstall(first.root)).toEqual({ name: "demo-platform", domain: "tours.example.com", databaseId: DB_ID, publicImageBase: "" });
  });
});

describe("a deploy that fails for another reason", () => {
  it("keeps a new address confirmed but not attached, shows the real error, and the next run attaches it", async () => {
    const account = fakeAccount({ failOnce: "deploy --config" });
    const first = harness(account);
    expect(await first.run("--yes", "--domain", "tours.example.com", "--replace-existing-domain")).toBe(1);
    const err = text(first.err);
    expect(err).toContain("A request to the Cloudflare API failed (simulated).");
    expect(err).toContain("stays in wrangler.deploy.jsonc, confirmed but not attached yet");
    expect(err).not.toContain("Cloudflare would not attach");
    expect(readInstall(first.root)).toMatchObject({ domain: "tours.example.com", pending: { previous: null } });
    const second = harness(account, { root: first.root });
    expect(await second.run("--yes")).toBe(0);
    expect(readInstall(first.root)).toEqual({ name: "demo-platform", domain: "tours.example.com", databaseId: DB_ID, publicImageBase: "" });
    expect(readFileSync(join(first.root, DEPLOY_CONFIG), "utf8")).not.toContain("not attached yet");
  });

  it("is told apart from a failure to attach the custom domain by Wrangler's own wording", () => {
    const r = (stderr: string) => ({ code: 1, stdout: "", stderr });
    expect(isCustomDomainFailure(r("X [ERROR] A request to the Cloudflare API (/accounts/abc/workers/scripts/demo-platform/domains/records) failed.\n  some API message [code: 100117]"))).toBe(true);
    expect(isCustomDomainFailure(r('X [ERROR] Publishing to Custom Domain "tours.example.com" was skipped, fix conflict and try again'))).toBe(true);
    expect(isCustomDomainFailure(r("X [ERROR] You can either deploy your worker to one or more routes by specifying them in your wrangler.deploy.jsonc file, or register a workers.dev subdomain here:"))).toBe(false);
    expect(isCustomDomainFailure(r("X [ERROR] A request to the Cloudflare API (/accounts/abc/workers/scripts/demo-platform) failed.\n  fetch failed"))).toBe(false);
    expect(isCustomDomainFailure(r("X [ERROR] Build failed with 1 error"))).toBe(false);
  });
});

describe("an account_id in the Wrangler configuration", () => {
  const accounts = [
    { id: "a".repeat(32), name: "Acme Tours" },
    { id: "b".repeat(32), name: "Side project" },
  ];
  function withAccountId(root: string, file: string, id: string) {
    const path = join(root, file);
    writeFileSync(path, readFileSync(path, "utf8").replace('"name": "demo-platform",', `"name": "demo-platform",\n  "account_id": "${id}",`));
  }

  it("is the account the plan names, since Wrangler prefers it", async () => {
    const root = checkout();
    withAccountId(root, "wrangler.jsonc", "b".repeat(32));
    const h = harness(fakeAccount({ accounts }), { root });
    expect(await h.run("--yes")).toBe(0);
    expect(text(h.out)).toContain("Account: Side project");
    expect(text(h.out)).toContain("account_id in wrangler.jsonc");
  });

  it("stops before anything else when it disagrees with CLOUDFLARE_ACCOUNT_ID, or names an account the login cannot use", async () => {
    const root = checkout();
    withAccountId(root, "wrangler.jsonc", "b".repeat(32));
    const clash = harness(fakeAccount({ accounts }), { root, env: { CLOUDFLARE_ACCOUNT_ID: "a".repeat(32) } });
    expect(await clash.run("--yes")).toBe(1);
    expect(text(clash.err)).toContain("Wrangler would use the one in the file");
    expect(shown(clash.calls)).toEqual(["whoami --json"]);
    const other = checkout();
    withAccountId(other, "wrangler.jsonc", "c".repeat(32));
    const unknown = harness(fakeAccount({ accounts }), { root: other });
    expect(await unknown.run("--yes")).toBe(1);
    expect(text(unknown.err)).toContain("account this login cannot use");
    expect(shown(unknown.calls)).toEqual(["whoami --json"]);
  });

  it("set by hand in wrangler.deploy.jsonc only, stops every mode before any change", async () => {
    const account = fakeAccount({ accounts: [accounts[0]] });
    const first = harness(account);
    expect(await first.run("--yes")).toBe(0);
    withAccountId(first.root, DEPLOY_CONFIG, "a".repeat(32));
    for (const argv of [["--yes"], ["update", "--yes"], ["status"]]) {
      const h = harness(account, { root: first.root });
      expect(await h.run(...argv), argv.join(" ")).toBe(1);
      expect(text(h.err)).toContain("account_id differs between wrangler.jsonc and wrangler.deploy.jsonc");
      noChange(h.calls);
    }
  });
});

describe("the two address settings (TOURS_HOST and APP_HOST)", () => {
  const VARS = { PUBLIC_IMAGE_BASE: "", TOURS_HOST: "", APP_HOST: "" };
  const deployed = (root: string) => JSON.parse(stripJsonComments(readFileSync(join(root, DEPLOY_CONFIG), "utf8")));

  it("wrangler.jsonc carries both empty, so a plain deploy serves one address", () => {
    const base = JSON.parse(stripJsonComments(readFileSync(join(REPO, "wrangler.jsonc"), "utf8")));
    expect(base.vars).toEqual(VARS);
  });

  it("the install's Wrangler file carries TOURS_HOST and APP_HOST empty", async () => {
    const h = harness(fakeAccount());
    expect(await h.run("--yes")).toBe(0);
    expect(deployed(h.root).vars).toEqual(VARS);
    expect(readInstall(h.root)).toEqual({ name: "demo-platform", domain: null, databaseId: DB_ID, publicImageBase: "" });
  });

  it("still has at most one custom domain", async () => {
    const h = harness(fakeAccount());
    expect(await h.run("--yes", "--domain", "tours.example.com", "--replace-existing-domain")).toBe(0);
    const config = deployed(h.root);
    expect(config.routes).toEqual([{ pattern: "tours.example.com", custom_domain: true }]);
    expect(config.vars).toEqual(VARS);
    // A second address is not an option of the guided setup yet.
    expect(parseArgs(["--app-domain", "app.example.com"])).toHaveProperty("error");
    expect(parseArgs(["--app-domain=app.example.com"])).toHaveProperty("error");
  });

  /** An install with an own address whose file then gets these two values written in by hand, as JSON text. */
  async function installWith(tours: string, app: string) {
    const account = fakeAccount();
    const first = harness(account);
    expect(await first.run("--yes", "--domain", "tours.example.com", "--replace-existing-domain")).toBe(0);
    const path = join(first.root, DEPLOY_CONFIG);
    const before = readFileSync(path, "utf8");
    expect(before).toContain('"TOURS_HOST": ""');
    expect(before).toContain('"APP_HOST": ""');
    writeFileSync(path, before.replace('"PUBLIC_IMAGE_BASE": ""', '"PUBLIC_IMAGE_BASE": "https://images.example.com"').replace('"TOURS_HOST": ""', `"TOURS_HOST": ${tours}`).replace('"APP_HOST": ""', `"APP_HOST": ${app}`));
    return { account, root: first.root };
  }

  it("update keeps a hand-set pair, and so does running setup again", async () => {
    const { account, root } = await installWith('"tours.example.com"', '"app.example.com"');
    const kept = { PUBLIC_IMAGE_BASE: "https://images.example.com", TOURS_HOST: "tours.example.com", APP_HOST: "app.example.com" };
    for (const argv of [["update", "--yes"], ["--yes"], ["update", "--yes"]]) {
      const h = harness(account, { root });
      expect(await h.run(...argv), argv.join(" ")).toBe(0);
      expect(deployed(root).vars, argv.join(" ")).toEqual(kept);
      expect(deployed(root).routes).toEqual([{ pattern: "tours.example.com", custom_domain: true }]);
    }
    const status = harness(account, { root });
    expect(await status.run("status")).toBe(0);
    expect(deployed(root).vars).toEqual(kept);
  });

  it("update keeps a hand-set STORAGE_ALLOWANCE_BYTES, and so does running setup again", async () => {
    const account = fakeAccount();
    const first = harness(account);
    expect(await first.run("--yes")).toBe(0);
    const path = join(first.root, DEPLOY_CONFIG);
    expect(readFileSync(path, "utf8")).not.toContain('"STORAGE_ALLOWANCE_BYTES":');
    // Written in by hand; a value this command never checks or prints.
    for (const [written, value] of [['"1073741824"', "1073741824"], ['"made-up-number"', "made-up-number"], ["0", 0]] as [string, unknown][]) {
      writeFileSync(path, readFileSync(path, "utf8").replace(/"APP_HOST": ""(,\s*"STORAGE_ALLOWANCE_BYTES": [^\n,}]+)?/, `"APP_HOST": "", "STORAGE_ALLOWANCE_BYTES": ${written}`));
      const kept = { ...VARS, STORAGE_ALLOWANCE_BYTES: value };
      expect(deployed(first.root).vars).toEqual(kept);
      for (const argv of [["update", "--yes"], ["--yes"], ["status"], ["update", "--yes"]]) {
        const h = harness(account, { root: first.root });
        expect(await h.run(...argv), argv.join(" ")).toBe(0);
        expect(deployed(first.root).vars, argv.join(" ")).toEqual(kept);
        expect((text(h.out) + text(h.err)).toLowerCase(), argv.join(" ")).not.toContain("made-up");
      }
      expect(readInstall(first.root)).toEqual({ name: "demo-platform", domain: null, databaseId: DB_ID, publicImageBase: "", keptVars: { STORAGE_ALLOWANCE_BYTES: value } });
    }
    // The file's own first lines say it is kept.
    expect(readFileSync(path, "utf8").split("\n").slice(0, 4).join("\n")).toContain("STORAGE_ALLOWANCE_BYTES");
  });

  it("update keeps a hand-set SITE_HOST, alone and beside a storage allowance", async () => {
    const account = fakeAccount();
    const first = harness(account);
    expect(await first.run("--yes")).toBe(0);
    const path = join(first.root, DEPLOY_CONFIG);
    // wrangler.jsonc does not carry the var, so a new install's file has none.
    expect(readFileSync(path, "utf8")).not.toContain('"SITE_HOST":');
    // Written in by hand; a value this command never checks or prints.
    const hand: [string, Record<string, unknown>][] = [
      ['"SITE_HOST": "tours.example.com"', { SITE_HOST: "tours.example.com" }],
      ['"SITE_HOST": "https://made-up.example.com/"', { SITE_HOST: "https://made-up.example.com/" }],
      ['"STORAGE_ALLOWANCE_BYTES": "1073741824", "SITE_HOST": "tours.example.com"', { STORAGE_ALLOWANCE_BYTES: "1073741824", SITE_HOST: "tours.example.com" }],
    ];
    for (const [written, values] of hand) {
      writeFileSync(path, readFileSync(path, "utf8").replace(/"APP_HOST": ""(,\s*"(?:SITE_HOST|STORAGE_ALLOWANCE_BYTES)": [^\n,}]+)*/, `"APP_HOST": "", ${written}`));
      const kept = { ...VARS, ...values };
      expect(deployed(first.root).vars, written).toEqual(kept);
      for (const argv of [["update", "--yes"], ["--yes"], ["status"], ["update", "--yes"]]) {
        const h = harness(account, { root: first.root });
        expect(await h.run(...argv), argv.join(" ")).toBe(0);
        expect(deployed(first.root).vars, argv.join(" ")).toEqual(kept);
        expect((text(h.out) + text(h.err)).toLowerCase(), argv.join(" ")).not.toContain("made-up");
      }
      expect(readInstall(first.root)?.keptVars, written).toEqual(values);
    }
    // The file's own first lines say it is kept.
    expect(readFileSync(path, "utf8").split("\n").slice(0, 4).join("\n")).toContain("SITE_HOST");
  });

  it("update keeps a hand-set INVITE_CONTACT or DOWNLOAD_URL, alone and beside the other kept vars", async () => {
    const account = fakeAccount();
    const first = harness(account);
    expect(await first.run("--yes")).toBe(0);
    const path = join(first.root, DEPLOY_CONFIG);
    // wrangler.jsonc does not carry the var, so a new install's file has none.
    expect(readFileSync(path, "utf8")).not.toContain('"INVITE_CONTACT":');
    // Written in by hand; a value this command never checks or prints.
    const hand: [string, Record<string, unknown>][] = [
      ['"INVITE_CONTACT": "hello@example.com"', { INVITE_CONTACT: "hello@example.com" }],
      ['"INVITE_CONTACT": "https://made-up.example.com/invite"', { INVITE_CONTACT: "https://made-up.example.com/invite" }],
      [
        '"STORAGE_ALLOWANCE_BYTES": "1073741824", "SITE_HOST": "tours.example.com", "INVITE_CONTACT": "hello@example.com"',
        { STORAGE_ALLOWANCE_BYTES: "1073741824", SITE_HOST: "tours.example.com", INVITE_CONTACT: "hello@example.com" },
      ],
      ['"DOWNLOAD_URL": "https://made-up.example.com/download"', { DOWNLOAD_URL: "https://made-up.example.com/download" }],
      [
        '"INVITE_CONTACT": "hello@example.com", "DOWNLOAD_URL": "https://made-up.example.com/download"',
        { INVITE_CONTACT: "hello@example.com", DOWNLOAD_URL: "https://made-up.example.com/download" },
      ],
      [
        '"SESSION_MAX_DAYS": "30", "CONNECTION_IDLE_DAYS": "off", "CONNECTION_MAX_DAYS": "365"',
        { SESSION_MAX_DAYS: "30", CONNECTION_IDLE_DAYS: "off", CONNECTION_MAX_DAYS: "365" },
      ],
    ];
    for (const [written, values] of hand) {
      writeFileSync(path, readFileSync(path, "utf8").replace(/"APP_HOST": ""(,\s*"(?:SITE_HOST|STORAGE_ALLOWANCE_BYTES|INVITE_CONTACT|DOWNLOAD_URL|SESSION_MAX_DAYS|CONNECTION_IDLE_DAYS|CONNECTION_MAX_DAYS)": [^\n,}]+)*/, `"APP_HOST": "", ${written}`));
      const kept = { ...VARS, ...values };
      expect(deployed(first.root).vars, written).toEqual(kept);
      for (const argv of [["update", "--yes"], ["--yes"], ["status"], ["update", "--yes"]]) {
        const h = harness(account, { root: first.root });
        expect(await h.run(...argv), argv.join(" ")).toBe(0);
        expect(deployed(first.root).vars, argv.join(" ")).toEqual(kept);
        expect((text(h.out) + text(h.err)).toLowerCase(), argv.join(" ")).not.toContain("made-up");
      }
      expect(readInstall(first.root)?.keptVars, written).toEqual(values);
    }
    // The file's own first lines say it is kept.
    expect(readFileSync(path, "utf8").split("\n").slice(0, 4).join("\n")).toContain("INVITE_CONTACT");
    expect(readFileSync(path, "utf8").split("\n").slice(0, 4).join("\n")).toContain("DOWNLOAD_URL");
    expect(readFileSync(path, "utf8").split("\n").slice(0, 5).join("\n")).toContain("CONNECTION_MAX_DAYS");
  });

  it("update keeps a hand-set IMG_HOST beside the two addresses", async () => {
    const account = fakeAccount();
    const first = harness(account);
    expect(await first.run("--yes")).toBe(0);
    const path = join(first.root, DEPLOY_CONFIG);
    // wrangler.jsonc does not carry the var, so a new install's file has none.
    expect(readFileSync(path, "utf8")).not.toContain('"IMG_HOST":');
    const before = readFileSync(path, "utf8");
    writeFileSync(path, before.replace('"TOURS_HOST": ""', '"TOURS_HOST": "tours.example.com"').replace('"APP_HOST": ""', '"APP_HOST": "app.example.com", "IMG_HOST": "made-up-img.example.com"'));
    const kept = { ...VARS, TOURS_HOST: "tours.example.com", APP_HOST: "app.example.com", IMG_HOST: "made-up-img.example.com" };
    expect(deployed(first.root).vars).toEqual(kept);
    for (const argv of [["update", "--yes"], ["--yes"], ["status"], ["update", "--yes"]]) {
      const h = harness(account, { root: first.root });
      expect(await h.run(...argv), argv.join(" ")).toBe(0);
      expect(deployed(first.root).vars, argv.join(" ")).toEqual(kept);
      expect((text(h.out) + text(h.err)).toLowerCase(), argv.join(" ")).not.toContain("made-up");
    }
    expect(readInstall(first.root)?.keptVars).toEqual({ IMG_HOST: "made-up-img.example.com" });
    expect(readFileSync(path, "utf8").split("\n").slice(0, 4).join("\n")).toContain("IMG_HOST");
  });

  it("update keeps both empty when they were empty", async () => {
    const account = fakeAccount();
    const first = harness(account);
    expect(await first.run("--yes")).toBe(0);
    const before = readFileSync(join(first.root, DEPLOY_CONFIG), "utf8");
    const up = harness(account, { root: first.root });
    expect(await up.run("update", "--yes")).toBe(0);
    expect(deployed(first.root).vars).toEqual(VARS);
    expect(readFileSync(join(first.root, DEPLOY_CONFIG), "utf8")).toBe(before);
  });

  const AS_IT_IS: [string, string, string, unknown, unknown][] = [
    ["a half-set pair", '"made-up-tours.example.com"', '""', "made-up-tours.example.com", ""],
    ["a value that is not a host name", '"https://made-up-tours.example.com/"', '"app.example.com"', "https://made-up-tours.example.com/", "app.example.com"],
    ["the same name twice", '"made-up.example.com"', '"Made-Up.example.com:8443"', "made-up.example.com", "Made-Up.example.com:8443"],
    ["a value that is not text", "42", '"app.example.com"', 42, "app.example.com"],
  ];
  for (const [label, tours, app, toursValue, appValue] of AS_IT_IS) {
    it(`update keeps ${label} as it is, for the Worker to report, and prints none of it`, async () => {
      const { account, root } = await installWith(tours, app);
      for (const argv of [["update", "--yes"], ["--yes"], ["status"]]) {
        const h = harness(account, { root });
        expect(await h.run(...argv), argv.join(" ")).toBe(0);
        expect(deployed(root).vars, argv.join(" ")).toEqual({ PUBLIC_IMAGE_BASE: "https://images.example.com", TOURS_HOST: toursValue, APP_HOST: appValue });
        const printed = (text(h.out) + text(h.err)).toLowerCase();
        expect(printed, argv.join(" ")).not.toContain("made-up");
        expect(codeIn(h.out), argv.join(" ")).toBeNull();
      }
    });
  }
});
