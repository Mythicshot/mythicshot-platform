// The server command's storage-sweep (0.1.66, src/node/admin.ts), run in this process on a
// database file in a scratch folder, as `cpanel.sh admin storage-sweep` runs it: the sweep with
// and without --dry-run, mail off, the stale unconfirmed claim it reports on every run, and
// --clear-claim. Node only. No mail is sent: the fake mailer is handed in.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runAdmin } from "../src/node/admin.ts";
import { NodeDb } from "../src/node/db.ts";
import { migrate } from "../src/node/migrate.ts";
import type { Deps } from "../src/ports.ts";
import { workspaceStatements } from "../src/workspaces.ts";
import { FakeMailer } from "./fake-mail.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const BASE_ENV = { SETUP_CODE: "made-up-setup-code-0123456789abcdef", SITE_HOST: "app.example.com", STORAGE_ALLOWANCE_BYTES: "1000" };
const SMTP = { MAIL_MODE: "smtp", MAIL_FROM: "no-reply@example.com", SMTP_HOST: "mail.example.com", SMTP_PORT: "465", SMTP_USER: "no-reply@example.com", SMTP_PASSWORD: "made-up-password" };
const none = { put: async () => {}, get: async () => null, delete: async () => {} };

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A data folder with two workspaces, A at 90% of its 1000 bytes and B at 95% with a claim of its 80% mail left unconfirmed two hours ago. */
async function site() {
  const dir = mkdtempSync(join(tmpdir(), "demo-platform-test-storage-sweep-"));
  made.push(dir);
  const db = new NodeDb(join(dir, "db.sqlite"));
  await migrate(db, MIGRATIONS_DIR);
  const deps: Deps = { db, drafts: none, pub: none, config: { publicImageBase: "", setupCode: null }, now: () => Date.now() };
  const a = await workspaceStatements(deps, "Alpha", "alpha@example.com");
  const b = await workspaceStatements(deps, "Bravo", "bravo@example.com");
  await db.batch([...a.stmts, ...b.stmts]);
  let n = 0;
  for (const [ws, bytes] of [[a.workspaceId, 900], [b.workspaceId, 950]] as const) {
    n += 1;
    await db.run("INSERT INTO media (id, workspace_id, link_id, kind, content_type, bytes, parts, width, height, state, created_at, online_at) VALUES (?, ?, ?, 'image', 'image/png', ?, 1, 1, 1, 'online', 1, 1)", [
      "med_" + String(n).padStart(24, "0"),
      ws,
      (n === 1 ? "a" : "b").repeat(20),
      bytes,
    ]);
  }
  await db.run("INSERT INTO storage_mail (workspace_id, stage, email_sha256, claimed_at, sent_at) VALUES (?, 80, ?, ?, NULL)", [b.workspaceId, "0".repeat(64), Date.now() - 2 * 3_600_000]);
  db.close();
  return { dir, env: { DATA_DIR: dir, ...BASE_ENV }, a: a.workspaceId, b: b.workspaceId };
}

async function run(env: NodeJS.ProcessEnv, argv: string[]) {
  const lines: string[] = [];
  const mail = new FakeMailer();
  const code = await runAdmin(argv, env, (line) => lines.push(line), { makeMailer: () => mail });
  return { code, lines, mail };
}

function rowsOf(dir: string, sql: string, params: (string | number)[] = []) {
  const db = new NodeDb(join(dir, "db.sqlite"));
  try {
    return db.raw.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

describe("storage-sweep", () => {
  it("is in the usage, takes --dry-run or --clear-claim <workspace id> alone, and refuses anything else", async () => {
    const s = await site();
    const help = (await run(s.env, ["--help"])).lines.join("\n");
    expect(help).toContain("storage-sweep [--dry-run]");
    expect(help).toContain("storage-sweep --clear-claim <workspace id>");
    for (const argv of [["storage-sweep", "--dry-run", "--dry-run"], ["storage-sweep", "now"], ["storage-sweep", "--clear-claim"], ["storage-sweep", "--clear-claim", "ws_1"]]) {
      expect((await run(s.env, argv)).code, argv.join(" ")).toBe(2);
    }
  });

  it("with mail off it says so; with mail on it sends what is due, and says the stale claim on every run until it is cleared", async () => {
    const s = await site();
    expect((await run(s.env, ["storage-sweep"])).lines).toEqual(["Mail is off, so no storage mail was sent. Nothing was changed."]);
    const env = { ...s.env, ...SMTP };
    const dry = await run(env, ["storage-sweep", "--dry-run"]);
    expect(dry.mail.sent).toEqual([]);
    expect(dry.lines).toContain("Storage mails that would be sent: 1.");
    const first = await run(env, ["storage-sweep"]);
    expect(first.code).toBe(0);
    expect(first.mail.sent.map((m) => [m.to, m.subject])).toEqual([["alpha@example.com", "Your Mythicshot storage is 90% full"]]);
    const stale = [`Storage mails whose sending was never confirmed (not sent again for this fill-up until the claim is cleared with storage-sweep --clear-claim): 1.`, `  unconfirmed ${s.b}`];
    expect(first.lines.join("\n")).toContain(stale.join("\n"));
    // Not resent by itself, and said again on the next run.
    const second = await run(env, ["storage-sweep"]);
    expect(second.mail.sent).toEqual([]);
    expect(second.lines.join("\n")).toContain(stale.join("\n"));

    // --clear-claim removes only B's unconfirmed claim, with an audit row of ids and the count.
    expect((await run(env, ["storage-sweep", "--clear-claim", s.a])).lines).toEqual(["That workspace has no unconfirmed storage mail. Nothing was changed."]);
    expect((await run(env, ["storage-sweep", "--clear-claim", s.b])).lines).toEqual(["Cleared 1 unconfirmed storage mail; the next check or sweep sends it again if it is still due."]);
    expect(rowsOf(s.dir, "SELECT workspace_id, stage FROM storage_mail ORDER BY workspace_id")).toEqual([{ workspace_id: s.a, stage: 80 }]);
    expect(rowsOf(s.dir, "SELECT workspace_id, user_id, subject, detail FROM audit WHERE event = 'storage_mail_claim_cleared'")).toEqual([{ workspace_id: s.b, user_id: null, subject: null, detail: '{"count":1}' }]);
    // The next sweep sends B's mail, once.
    const third = await run(env, ["storage-sweep"]);
    expect(third.mail.sent.map((m) => m.to)).toEqual(["bravo@example.com"]);
    expect(third.lines.join("\n")).not.toContain("never confirmed");
  });
});
