// The guided Cloudflare setup command, with Wrangler replaced by a stub that keeps a
// pretend account in memory and records every call.
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkDomain, checkName, DEPLOY_CONFIG, main, parseArgs, readInstall, stripJsonComments, type Io, type WranglerResult } from "../scripts/setup-cloudflare.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const DB_ID = "11111111-2222-3333-4444-555555555555";

type Call = { args: string[]; input?: string };

/** The pretend Cloudflare account. */
type Account = {
  signedIn: boolean;
  databases: { name: string; uuid: string }[];
  buckets: string[];
  workers: Set<string>;
  secrets: Map<string, string>;
  pendingMigrations: boolean;
  /** Fail the first call whose shown command contains this text. */
  failOnce?: string;
};

const CHANGING = /^(d1 create|d1 migrations apply|r2 bucket create|deploy|secret put|secret delete|d1 delete|r2 bucket delete)/;

function fakeAccount(over: Partial<Account> = {}): Account {
  return { signedIn: true, databases: [], buckets: [], workers: new Set(), secrets: new Map(), pendingMigrations: true, ...over };
}

function stub(account: Account, calls: Call[]) {
  return async (args: string[], opts: { input?: string } = {}): Promise<WranglerResult> => {
    calls.push(opts.input === undefined ? { args: [...args] } : { args: [...args], input: opts.input });
    const line = args.join(" ");
    const ok = (stdout = ""): WranglerResult => ({ code: 0, stdout, stderr: "" });
    const fail = (stderr: string): WranglerResult => ({ code: 1, stdout: "", stderr });
    if (account.failOnce && line.includes(account.failOnce)) {
      account.failOnce = undefined;
      return fail("A request to the Cloudflare API failed (simulated).");
    }
    if (!account.signedIn) return fail("You are not authenticated. Please run `wrangler login`.");
    const worker = () => args[args.indexOf("--config") + 1] && "demo"; // one Worker per test
    if (line === "whoami --json") return ok('{"loggedIn":true}');
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
      account.workers.add(worker());
      return ok("Uploaded demo-platform\nDeployed demo-platform triggers\n  https://demo-platform.example-account.workers.dev\n");
    }
    if (args[0] === "secret" && args[1] === "list") {
      if (!account.workers.has("demo")) return fail("This Worker does not exist on your account. [code: 10007]");
      return ok(JSON.stringify([...account.secrets.keys()].map((name) => ({ name, type: "secret_text" }))));
    }
    if (args[0] === "secret" && args[1] === "put") {
      account.workers.add("demo");
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

function harness(account: Account, opts: { root?: string; answers?: string[]; tty?: boolean } = {}) {
  const root = opts.root ?? checkout();
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const answers = [...(opts.answers ?? [])];
  const asked: string[] = [];
  const io: Io = {
    root,
    wrangler: stub(account, calls),
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
    const h = harness(account, { answers: ["tours", "2", "tours.example.com", "y", ""] });
    expect(await h.run()).toBe(0);
    expect(h.asked).toHaveLength(5);
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
    expect(await h.run("--yes")).toBe(0);
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
    expect(await second.run("--yes", "--domain", "tours.example.com")).toBe(0);
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
      expect(account.workers.has("demo")).toBe(true);
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
    const asked = harness(fakeAccount(), { answers: ["", "2", "https://tours.example.com/", "tours.example.com", "y", ""] });
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
