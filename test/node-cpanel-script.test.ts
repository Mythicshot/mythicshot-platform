// Runs deploy/cpanel/test-cpanel.sh, the tests of the cPanel script against stand-ins
// for the hosting's commands, as part of `npm run test:node`. Every test function in
// that file is checked by name here, so a test that is removed, renamed or no longer run
// fails this file. Where there is no usable Bash the whole file is skipped with the
// reason; no hosting, no network and no container is involved either way.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HARNESS = "deploy/cpanel/test-cpanel.sh";

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
const names = [...readFileSync(join(ROOT, HARNESS), "utf8").matchAll(/^(test_[a-z0-9_]+)\(\) \{$/gm)].map((m) => m[1]);

describe.skipIf("reason" in found)(`the cPanel script against stand-ins${"reason" in found ? ` (skipped: ${found.reason})` : ""}`, () => {
  // One run of the whole file; each test below reads its own line from the output.
  let output = "";
  let status: number | null = null;
  const run = () => {
    if (output !== "") return;
    const r = spawnSync((found as { bash: string }).bash, [HARNESS], { cwd: ROOT, encoding: "utf8", timeout: 1_800_000, windowsHide: true });
    output = `${r.stdout}\n${r.stderr}`;
    status = r.status;
  };

  it("the file has tests", () => {
    expect(names.length).toBeGreaterThanOrEqual(25);
  });

  it("the whole file passes", () => {
    run();
    expect(output).toMatch(/^\d+ passed, 0 failed, \d+ skipped$/m);
    expect(status, output).toBe(0);
  }, 1_800_000);

  for (const name of names) {
    it(name.replace(/^test_/, "").replace(/_/g, " "), (ctx) => {
      run();
      const line = output.split(/\r?\n/).find((l) => /^(PASS|FAIL|SKIP) {2}/.test(l) && l.slice(6) === name);
      expect(line, `${name} was not run\n${output}`).toBeDefined();
      if (line?.startsWith("SKIP")) {
        const at = output.indexOf(line);
        return ctx.skip(output.slice(at).split(/\r?\n/)[1]?.trim() || "skipped by the Bash file");
      }
      // On a failure, show what the Bash file printed for this test.
      const at = output.indexOf(line as string);
      const detail = output.slice(at).split(/\r?\n/).slice(0, 30).join("\n");
      expect(line?.startsWith("PASS"), detail).toBe(true);
    }, 1_800_000);
  }
});
