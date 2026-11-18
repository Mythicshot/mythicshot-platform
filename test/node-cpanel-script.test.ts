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

  it.skipIf("reason" in found)(`copies a database in use, row in the WAL included, and checks the copy${"reason" in found ? ` (skipped: ${found.reason})` : ""}`, () => {
    const r = spawnSync((found as { bash: string }).bash, [HARNESS, "--inside", TEST], { cwd: ROOT, encoding: "utf8", timeout: 280_000, windowsHide: true });
    const output = `${r.stdout}\n${r.stderr}`;
    // Run, and passed: not skipped inside the Bash file for want of a Node.js.
    expect(output).toContain(`PASS  ${TEST}`);
    expect(output).toMatch(/^1 passed, 0 failed, 0 skipped$/m);
    expect(r.status, output).toBe(0);
  }, 300_000);
});
