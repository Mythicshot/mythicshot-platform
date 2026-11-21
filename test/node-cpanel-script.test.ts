// The cPanel script's tests are a Bash file, deploy/cpanel/test-cpanel.sh, run in Debian
// containers by `npm run test:cpanel`. Those containers have no Node.js, so the one test
// that needs a real one runs here instead, as part of `npm run test:node`: the backup's
// database copy, made by the script with this computer's Node.js from a real database
// that another process holds open in WAL mode. Everything else in that test is a
// stand-in; no hosting, no network and no container is involved. Where there is no
// usable Bash the test is skipped with the reason.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NodeDb } from "../src/node/db.ts";
import { migrate } from "../src/node/migrate.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HARNESS = "deploy/cpanel/test-cpanel.sh";
const TEST = "test_backup_with_real_node_copies_a_live_wal_database";
/**
 * The tests of the second address (--app-domain). They run in the containers only: on a
 * computer without a fast Bash each takes about a minute. This file checks that none of
 * them is dropped from the Bash file without anyone noticing.
 */
const TWO_ADDRESS_TESTS = [
  "test_app_domain_is_checked",
  "test_install_with_app_domain_is_refused",
  "test_install_without_app_domain_writes_todays_settings",
  "test_existing_settings_file_is_kept_and_the_two_lines_are_printed",
  "test_a_failed_update_does_not_record_a_new_app_address",
  "test_app_domain_is_remembered_by_update_and_status",
  "test_health_needs_each_address_to_report_its_own_role",
  "test_health_names_the_address_that_reports_the_wrong_role",
  "test_dry_run_with_app_domain_changes_nothing",
  "test_health_notices_an_address_that_refuses_every_other_request",
  "test_one_recorded_address_that_reports_the_app_role_fails",
  "test_app_domain_never_shows_the_setup_code",
];

/**
 * The tests of `cpanel.sh admin` and of the old sqlite3 tool. They are run here too, all
 * in one go, because they are few and quick: the containers cannot run the one with a
 * real Node.js, and nothing about them needs Debian.
 */
const ADMIN_TESTS = [
  "test_admin_runs_the_command_in_the_apps_node_with_the_data_folder",
  "test_admin_passes_its_arguments_unchanged",
  "test_admin_needs_an_install",
  "test_admin_dry_run_runs_nothing",
  "test_an_old_sqlite3_tool_is_not_used_for_the_copy",
  "test_admin_with_real_node_hands_the_command_the_settings",
];

/** A Bash that runs POSIX scripts here, or the reason there is none. */
function findBash(): { bash: string } | { reason: string } {
  const works = (bash: string) => spawnSync(bash, ["-c", "echo ok"], { encoding: "utf8", windowsHide: true }).stdout?.trim() === "ok";
  if (process.platform !== "win32") return works("bash") ? { bash: "bash" } : { reason: "bash is not installed" };
  // On Windows, plain "bash" may be the launcher of a Linux subsystem, which sees other
  // paths and another file system. Only the Bash that comes with Git is used.
  const gits = (spawnSync("where", ["git"], { encoding: "utf8", windowsHide: true }).stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (gits.length === 0) return { reason: "Git for Windows, which brings Bash, was not found" };
  // git.exe is in <Git>\cmd or <Git>\mingw64\bin; Bash is <Git>\bin\bash.exe.
  for (const git of gits) {
    for (const base of [dirname(dirname(git)), dirname(dirname(dirname(git)))]) {
      const bash = join(base, "bin", "bash.exe");
      if (existsSync(bash) && works(bash)) return { bash };
    }
  }
  return { reason: `no working Bash was found beside ${gits[0]}` };
}

const found = findBash();

describe("the cPanel script's backup with a real Node.js", () => {
  it("the Bash file still has the test this file runs", () => {
    expect(readFileSync(join(ROOT, HARNESS), "utf8")).toMatch(new RegExp(`^${TEST}\\(\\) \\{$`, "m"));
  });

  it("the Bash file has every test of the second address, and its stand-in for curl answers by host name", () => {
    const harness = readFileSync(join(ROOT, HARNESS), "utf8");
    for (const name of TWO_ADDRESS_TESTS) expect(harness, name).toMatch(new RegExp(`^${name}\\(\\) \\{$`, "m"));
    // Every one of them is run by default: the file runs each function named test_*.
    expect(harness).toContain(`TESTS="$(declare -F | awk '{print $3}' | grep '^test_')"`);
    // The stand-in reports a role only for the two placeholder names, like an app in two-address mode.
    expect(harness).toContain(`tours.example.com) mode="\${STUB_HEALTH_TOURS:-tours}" ;;`);
    expect(harness).toContain(`app.example.com) mode="\${STUB_HEALTH_APP:-app}" ;;`);
    expect(harness).toContain(`tours) echo '{"ok":true,"address":"tours"}' ;;`);
    expect(harness).toContain(`app) echo '{"ok":true,"address":"app"}' ;;`);
    // No test reaches a real host: the containers have no network, and the only names are placeholders.
    expect(harness).toContain("docker run --rm --init --network none");
    const names = [...harness.matchAll(/\b(?:[a-z0-9-]+\.)+example\.(?:com|net|org)\b/g)].map((m) => m[0]);
    expect([...new Set(names)].sort()).toEqual(["app.example.com", "appp.example.com", "demo.example.com", "other.example.com", "sub.domain.example.org", "tours.example.com"]);
  });

  it.skipIf("reason" in found)(`copies a database in use, row in the WAL included, and checks the copy${"reason" in found ? ` (skipped: ${found.reason})` : ""}`, () => {
    const r = spawnSync((found as { bash: string }).bash, [HARNESS, "--inside", TEST], { cwd: ROOT, encoding: "utf8", timeout: 280_000, windowsHide: true });
    const output = `${r.stdout}\n${r.stderr}`;
    // Run, and passed: not skipped inside the Bash file for want of a Node.js.
    expect(output).toContain(`PASS  ${TEST}`);
    expect(output).toMatch(/^1 passed, 0 failed, 0 skipped$/m);
    expect(r.status, output).toBe(0);
  }, 300_000);

  it("the Bash file has every test of the admin command", () => {
    const harness = readFileSync(join(ROOT, HARNESS), "utf8");
    for (const name of ADMIN_TESTS) expect(harness, name).toMatch(new RegExp(`^${name}\\(\\) \\{$`, "m"));
  });

  it.skipIf("reason" in found)(`runs the admin command through cpanel.sh: in the app's Node.js, with the settings the app gets, its arguments unchanged${"reason" in found ? ` (skipped: ${found.reason})` : ""}`, () => {
    const r = spawnSync((found as { bash: string }).bash, [HARNESS, "--inside", ...ADMIN_TESTS], { cwd: ROOT, encoding: "utf8", timeout: 280_000, windowsHide: true });
    const output = `${r.stdout}\n${r.stderr}`;
    for (const name of ADMIN_TESTS) expect(output, name).toContain(`PASS  ${name}`);
    expect(output).toMatch(new RegExp(`^${ADMIN_TESTS.length} passed, 0 failed, 0 skipped$`, "m"));
    expect(r.status, output).toBe(0);
  }, 300_000);
});

/** The test of the refusal to go back while a tour is restricted (stand-ins only; it runs here too, being one). */
const RESTRICTED_TESTS = ["test_update_refuses_the_way_back_when_a_tour_is_restricted", "test_downgrade_below_access_is_refused_while_a_tour_is_restricted"];

describe("the way back while a tour is restricted", () => {
  it("the Bash file has the test of the refusal", () => {
    for (const name of RESTRICTED_TESTS) expect(readFileSync(join(ROOT, HARNESS), "utf8")).toMatch(new RegExp(`^${name}\\(\\) \\{$`, "m"));
  });

  it.skipIf("reason" in found)(`refuses the commands to go back and a downgrade below 0.1.38 while a tour is restricted or the database cannot be read, names the backup and what restoring it loses${"reason" in found ? ` (skipped: ${found.reason})` : ""}`, () => {
    const r = spawnSync((found as { bash: string }).bash, [HARNESS, "--inside", ...RESTRICTED_TESTS], { cwd: ROOT, encoding: "utf8", timeout: 280_000, windowsHide: true });
    const output = `${r.stdout}
${r.stderr}`;
    for (const name of RESTRICTED_TESTS) expect(output, name).toContain(`PASS  ${name}`);
    expect(output).toMatch(new RegExp(`^${RESTRICTED_TESTS.length} passed, 0 failed, 0 skipped$`, "m"));
    expect(r.status, output).toBe(0);
  }, 300_000);

  it("the check's own program and statements, run with this Node.js on real databases: 0 before migration 0014 and with public tours only, else the restricted tours and the moves under way", async () => {
    const script = readFileSync(join(ROOT, "deploy/cpanel/cpanel.sh"), "utf8");
    const program = /node -e '([^']*)' "\$db" restricted-check/.exec(script)?.[1];
    const hasSql = /^ACCESS_COLUMN_SQL="([^"]*)"$/m.exec(script)?.[1];
    const countSql = /^RESTRICTED_SQL="([^"]*)"$/m.exec(script)?.[1];
    expect([typeof program, typeof hasSql, typeof countSql]).toEqual(["string", "string", "string"]);
    const check = (db: string) => {
      const r = spawnSync(process.execPath, ["-e", program!, db, "restricted-check", hasSql!, countSql!], { encoding: "utf8", windowsHide: true });
      expect(r.status, r.stderr).toBe(0);
      return r.stdout;
    };
    const migrations = fileURLToPath(new URL("../migrations/", import.meta.url));
    const root = mkdtempSync(join(tmpdir(), "demo-platform-restricted-"));
    const upTo13 = join(root, "upto13");
    mkdirSync(upTo13);
    for (const f of readdirSync(migrations).filter((f) => f.endsWith(".sql") && f < "0014")) copyFileSync(join(migrations, f), join(upTo13, f));
    const file = join(root, "db.sqlite");
    const db = new NodeDb(file);
    try {
      await migrate(db, upTo13);
      await db.run("INSERT INTO workspace (id, name, created_at) VALUES ('ws_1', 'A', 1)");
      await db.run("INSERT INTO tour (id, workspace_id, title, slug, status, created_at, updated_at) VALUES ('tour_1', 'ws_1', 'T', 'abcdefghij', 'draft', 1, 1)");
      expect(check(file)).toBe("0"); // the earlier schema: no restricted tour can exist
      await migrate(db, migrations);
      expect(check(file)).toBe("0");
      await db.run("UPDATE tour SET access = 'me' WHERE id = 'tour_1'");
      expect(check(file)).toBe("1");
      await db.run("INSERT INTO tour (id, workspace_id, title, slug, status, created_at, updated_at) VALUES ('tour_2', 'ws_1', 'U', 'bcdefghijk', 'draft', 1, 1)");
      await db.run(`INSERT INTO access_switch (tour_id, switch_id, target, data, total, created_at, touched_at) VALUES ('tour_2', 'sw_${"0".repeat(24)}', 'public', '{}', 0, 1, 1)`);
      expect(check(file)).toBe("2");
    } finally {
      db.close();
    }
  });
});
