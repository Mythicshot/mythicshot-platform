// The cPanel script's tests are a Bash file, deploy/cpanel/test-cpanel.sh, run in Debian
// containers by `npm run test:cpanel`. Those containers have no Node.js, so the one test
// that needs a real one runs here instead, as part of `npm run test:node`: the backup's
// database copy, made by the script with this computer's Node.js from a real database
// that another process holds open in WAL mode. Everything else in that test is a
// stand-in; no hosting, no network and no container is involved. Where there is no
// usable Bash the test is skipped with the reason.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
  "test_install_with_app_domain_writes_both_host_lines",
  "test_install_without_app_domain_writes_todays_settings",
  "test_existing_settings_file_is_kept_and_the_two_lines_are_printed",
  "test_app_domain_is_remembered_by_update_and_status",
  "test_health_needs_each_address_to_report_its_own_role",
  "test_health_names_the_address_that_reports_the_wrong_role",
  "test_dry_run_with_app_domain_changes_nothing",
  "test_app_domain_never_shows_the_setup_code",
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
    expect([...new Set(names)].sort()).toEqual(["app.example.com", "demo.example.com", "other.example.com", "sub.domain.example.org", "tours.example.com"]);
  });

  it.skipIf("reason" in found)(`copies a database in use, row in the WAL included, and checks the copy${"reason" in found ? ` (skipped: ${found.reason})` : ""}`, () => {
    const r = spawnSync((found as { bash: string }).bash, [HARNESS, "--inside", TEST], { cwd: ROOT, encoding: "utf8", timeout: 280_000, windowsHide: true });
    const output = `${r.stdout}\n${r.stderr}`;
    // Run, and passed: not skipped inside the Bash file for want of a Node.js.
    expect(output).toContain(`PASS  ${TEST}`);
    expect(output).toMatch(/^1 passed, 0 failed, 0 skipped$/m);
    expect(r.status, output).toBe(0);
  }, 300_000);
});
