// Runs deploy/cpanel/app.cjs, the startup file for shared cPanel hosting, the way the
// hosting does: as a CommonJS file inside the app folder, with the settings file beside
// that folder. A stand-in dist/node/entry.js prints the settings it was started with, so
// each test sees what the real app would have seen.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { NODE_SETTINGS } from "../src/node/config.ts";

const APP_CJS = fileURLToPath(new URL("../deploy/cpanel/app.cjs", import.meta.url));
/** A made-up value that must never show up in anything the startup file prints. */
const SECRET = "made-up-setup-code-0123456789abcdef";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** An app folder `<home>/apps/<name>` holding the startup file and a stand-in app. */
function layout(name = "tours"): { home: string; app: string; settings: string } {
  const home = mkdtempSync(join(tmpdir(), "dp-cpanel-app-"));
  made.push(home);
  const app = join(home, "apps", name);
  mkdirSync(join(app, "dist", "node"), { recursive: true });
  copyFileSync(APP_CJS, join(app, "app.cjs"));
  writeFileSync(join(app, "package.json"), '{"type":"module"}\n');
  writeFileSync(
    join(app, "dist", "node", "entry.js"),
    'const pick = (k) => process.env[k] ?? null;\nconsole.log("STARTED " + JSON.stringify({ DATA_DIR: pick("DATA_DIR"), SETUP_CODE: pick("SETUP_CODE"), EXTRA: pick("EXTRA"), QUOTED: pick("QUOTED"), SINGLE: pick("SINGLE"), lower: pick("lower") }));\n',
  );
  return { home, app, settings: join(home, "apps", `${name}-config.env`) };
}

function start(app: string, env: Record<string, string> = {}, args: string[] = []): { status: number | null; stdout: string; stderr: string; started: Record<string, string | null> | null } {
  // Only what Node itself needs, so nothing from the test runner's environment leaks in.
  const base: Record<string, string> = {};
  for (const k of ["PATH", "Path", "SystemRoot", "TEMP", "TMP"]) if (process.env[k] !== undefined) base[k] = process.env[k] as string;
  const r = spawnSync(process.execPath, [join(app, "app.cjs"), ...args], { env: { ...base, ...env }, encoding: "utf8", timeout: 20_000, windowsHide: true });
  const line = r.stdout.split("\n").find((l) => l.startsWith("STARTED "));
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, started: line ? (JSON.parse(line.slice(8)) as Record<string, string | null>) : null };
}

describe("the cPanel startup file", () => {
  it("reads the settings file beside the app folder and starts the app with them", () => {
    const l = layout();
    writeFileSync(l.settings, `DATA_DIR=/home/user/apps/tours-data\nSETUP_CODE=${SECRET}\n`);
    const r = start(l.app);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.started).toMatchObject({ DATA_DIR: "/home/user/apps/tours-data", SETUP_CODE: SECRET });
  });

  it("takes the settings file's name from the app folder's name", () => {
    const l = layout("demo");
    expect(l.settings.endsWith("demo-config.env")).toBe(true);
    writeFileSync(l.settings, "DATA_DIR=/data/demo\n");
    expect(start(l.app).started).toMatchObject({ DATA_DIR: "/data/demo" });
    // A settings file named for another app folder is not picked up.
    const other = layout("tours");
    writeFileSync(join(other.home, "apps", "demo-config.env"), "DATA_DIR=/data/demo\n");
    expect(start(other.app).status).toBe(1);
  });

  it("ignores blank lines and comments, accepts Windows line ends, and drops one pair of quotes", () => {
    const l = layout();
    writeFileSync(
      l.settings,
      ["# settings for the tours app", "", "   ", "DATA_DIR=/data/tours\r", "  # SETUP_CODE=commented-out", "EXTRA=a=b c", 'QUOTED="in double quotes"', "SINGLE='in single quotes'", "lower=ignored", "not a setting", ""].join("\n"),
    );
    const r = start(l.app);
    expect(r.status).toBe(0);
    expect(r.started).toEqual({ DATA_DIR: "/data/tours", SETUP_CODE: null, EXTRA: "a=b c", QUOTED: "in double quotes", SINGLE: "in single quotes", lower: null });
  });

  it("lets a variable that is already set win over the file", () => {
    const l = layout();
    writeFileSync(l.settings, `DATA_DIR=/from/the/file\nSETUP_CODE=${SECRET}\nEXTRA=from-file\n`);
    const r = start(l.app, { DATA_DIR: "/from/the/environment", EXTRA: "" });
    expect(r.status).toBe(0);
    // An empty value that is set still counts as set.
    expect(r.started).toMatchObject({ DATA_DIR: "/from/the/environment", SETUP_CODE: SECRET, EXTRA: "" });
  });

  it("a missing settings file gives one line on stderr naming the expected path, and a non-zero exit", () => {
    const l = layout();
    const r = start(l.app);
    expect(r.status).toBe(1);
    expect(r.started).toBeNull();
    expect(r.stdout).toBe("");
    const lines = r.stderr.split("\n").filter((x) => x !== "");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(l.settings);
    expect(lines[0]).toContain("tours-config.env");
    expect(lines[0]).toMatch(/settings file/);
  });

  it("a settings file that cannot be read as a file gives the same one line and never prints a value", () => {
    const l = layout();
    // A folder in the file's place cannot be read as a file on any system.
    mkdirSync(l.settings);
    writeFileSync(join(l.settings, "inner"), `SETUP_CODE=${SECRET}\n`);
    const r = start(l.app);
    expect(r.status).toBe(1);
    const lines = r.stderr.split("\n").filter((x) => x !== "");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(l.settings);
    expect(r.stdout + r.stderr).not.toContain(SECRET);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a settings file without read permission gives the one line too", () => {
    const l = layout();
    writeFileSync(l.settings, `SETUP_CODE=${SECRET}\n`);
    chmodSync(l.settings, 0o000);
    const r = start(l.app);
    chmodSync(l.settings, 0o600);
    expect(r.status).toBe(1);
    expect(r.stderr.split("\n").filter((x) => x !== "")).toHaveLength(1);
    expect(r.stderr).toContain(l.settings);
    expect(r.stderr).not.toContain(SECRET);
  });

  it("never prints a value from the file, also when the app fails to start", () => {
    const l = layout();
    writeFileSync(l.settings, `DATA_DIR=/data/tours\nSETUP_CODE=${SECRET}\n`);
    writeFileSync(join(l.app, "dist", "node", "entry.js"), 'throw new Error("the app could not start");\n');
    const r = start(l.app);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("the app could not start");
    expect(r.stdout + r.stderr).not.toContain(SECRET);
    expect(r.stdout + r.stderr).not.toContain("/data/tours");
  });

  it("a missing build gives a non-zero exit, not a silent stop", () => {
    const l = layout();
    writeFileSync(l.settings, "DATA_DIR=/data/tours\n");
    rmSync(join(l.app, "dist"), { recursive: true });
    const r = start(l.app);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/entry\.js/);
  });

  it("its header comment names every setting it passes on: each one the app reads, the recovery setting and the removal setting", () => {
    const header = readFileSync(APP_CJS, "utf8").split("\n").filter((l) => l.startsWith("//")).join("\n");
    for (const name of [...NODE_SETTINGS, "RECOVERY_LINKS", "BILLING_REMOVAL"]) expect(header, name).toMatch(new RegExp(`\\b${name}\\b`));
  });
});

describe("the cPanel startup file run as the admin command", () => {
  /**
   * A stand-in dist/node/admin.js with the real one's exports: the settings to clear, the
   * gate's rule, and a main that prints the arguments, the settings it sees and the gate
   * it was handed, and sets the exit code.
   */
  function withAdmin(l: { app: string }): void {
    writeFileSync(
      join(l.app, "dist", "node", "admin.js"),
      [
        'export const ADMIN_SETTINGS = ["DATA_DIR", "APP_HOST", "TOURS_HOST", "SITE_HOST", "SMTP_PASSWORD", "RECOVERY_LINKS"];',
        'export function isRecoveryOn(v) { return typeof v === "string" && v.trim().toLowerCase() === "on"; }',
        "export async function main(argv, opts) {",
        "  const pick = (k) => process.env[k] ?? null;",
        '  console.log("ADMIN " + JSON.stringify({ argv, DATA_DIR: pick("DATA_DIR"), APP_HOST: pick("APP_HOST"), TOURS_HOST: pick("TOURS_HOST"), SITE_HOST: pick("SITE_HOST"), SMTP_PASSWORD: pick("SMTP_PASSWORD"), RECOVERY_LINKS: pick("RECOVERY_LINKS"), gate: opts?.recoveryLinks ?? null }));',
        '  process.exitCode = argv.includes("--fail") ? 1 : 0;',
        "}",
        "",
      ].join("\n"),
    );
  }
  const admin = (r: { stdout: string }): Record<string, unknown> | null => {
    const line = r.stdout.split("\n").find((x) => x.startsWith("ADMIN "));
    return line ? (JSON.parse(line.slice(6)) as Record<string, unknown>) : null;
  };
  const lines = (text: string) => text.split("\n").filter((x) => x !== "");

  it("`node app.cjs admin …` runs the admin command with the arguments unchanged and the settings file as its only source", () => {
    const l = layout();
    withAdmin(l);
    writeFileSync(l.settings, [`DATA_DIR=/data/tours`, `SETUP_CODE=${SECRET}`, `APP_HOST="app.example.com"`, `SMTP_PASSWORD=pw with spaces=and+signs`, ""].join("\n"));
    const args = ["admin", "first-admin", "--email", "You@Example.com", "--username=robin", "a b", ""];
    const r = start(l.app, {}, args);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.started).toBeNull();
    const all = { DATA_DIR: "/data/tours", APP_HOST: "app.example.com", TOURS_HOST: null, SITE_HOST: null, SMTP_PASSWORD: "pw with spaces=and+signs", RECOVERY_LINKS: null, gate: false };
    expect(admin(r)).toEqual({ argv: args.slice(1), ...all });
    // A setting set in the shell it is started from never reaches the command: the file holds it or nobody does.
    const shell = { DATA_DIR: "/from/the/shell", APP_HOST: "other.example.com", TOURS_HOST: "tours.other.example.com", SITE_HOST: "site.other.example.com", SMTP_PASSWORD: "from-the-shell" };
    expect(admin(start(l.app, shell, ["admin", "audit"]))).toEqual({ argv: ["audit"], ...all });
    writeFileSync(l.settings, "SITE_HOST=tours.example.com\n");
    expect(admin(start(l.app, shell, ["admin", "audit"]))).toEqual({ argv: ["audit"], ...all, DATA_DIR: null, APP_HOST: null, SMTP_PASSWORD: null, SITE_HOST: "tours.example.com" });
    // The app itself keeps its rule: what is set already wins.
    expect(start(l.app, { DATA_DIR: "/from/the/shell" }).started).toMatchObject({ DATA_DIR: "/from/the/shell" });
    // The command's exit code is the process's.
    expect(start(l.app, {}, ["admin", "--fail"]).status).toBe(1);
  });

  it("the recovery gate is the settings file's RECOVERY_LINKS, handed over explicitly and never as a variable", () => {
    const l = layout();
    withAdmin(l);
    writeFileSync(l.settings, "DATA_DIR=/data/tours\n");
    // Exported in the SSH session, with the file silent about it: closed, and not passed on.
    for (const value of ["on", "ON", " on "]) expect(admin(start(l.app, { RECOVERY_LINKS: value }, ["admin", "signin-link"])), value).toMatchObject({ RECOVERY_LINKS: null, gate: false });
    // In the file: open, by the command's own rule, and still not in the environment.
    writeFileSync(l.settings, "DATA_DIR=/data/tours\nRECOVERY_LINKS= On \n");
    expect(admin(start(l.app, {}, ["admin", "signin-link"]))).toMatchObject({ RECOVERY_LINKS: null, gate: true });
    writeFileSync(l.settings, "DATA_DIR=/data/tours\nRECOVERY_LINKS=off\n");
    expect(admin(start(l.app, { RECOVERY_LINKS: "on" }, ["admin", "signin-link"]))).toMatchObject({ RECOVERY_LINKS: null, gate: false });
  });

  it("without `admin` first, or with it only in the settings file, the app starts as always", () => {
    const l = layout();
    withAdmin(l);
    writeFileSync(l.settings, ["DATA_DIR=/data/tours", "COMMAND=admin", "DEMO_PLATFORM_COMMAND=admin", ""].join("\n"));
    for (const args of [[], ["status"], ["--admin"], ["first-admin", "admin"]]) {
      const r = start(l.app, {}, args);
      expect(r.status, args.join(" ")).toBe(0);
      expect(r.started, args.join(" ")).toMatchObject({ DATA_DIR: "/data/tours" });
      expect(admin(r), args.join(" ")).toBeNull();
    }
  });

  it("a missing settings file stops the command with the app's one line, and a build without the command says so in one line without a value", () => {
    const l = layout();
    withAdmin(l);
    const none = start(l.app, {}, ["admin", "audit"]);
    expect(none.status).toBe(1);
    expect(admin(none)).toBeNull();
    expect(lines(none.stderr)).toEqual([expect.stringContaining(l.settings)]);

    writeFileSync(l.settings, `DATA_DIR=/data/tours\nSETUP_CODE=${SECRET}\n`);
    rmSync(join(l.app, "dist", "node", "admin.js"));
    const missing = start(l.app, {}, ["admin", "audit"]);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe("");
    expect(lines(missing.stderr)).toEqual(["demo-platform: the admin command could not be run. Update the site with a current archive and try again."]);
    expect(missing.stdout + missing.stderr).not.toContain(SECRET);
    expect(missing.stdout + missing.stderr).not.toContain("/data/tours");
  });
});

describe("the cPanel startup file and the file settings (0.1.71)", () => {
  const ONCE = ["FILE_STORE", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_PRIVATE_BUCKET", "R2_PUBLIC_BUCKET"];
  /** A stand-in admin command that says it ran. */
  const withAdmin = (l: { app: string }) =>
    writeFileSync(join(l.app, "dist", "node", "admin.js"), ['export const ADMIN_SETTINGS = ["DATA_DIR"];', "export function isRecoveryOn() { return false; }", 'export async function main() { console.log("ADMIN RAN"); }', ""].join("\n"));

  it.each(ONCE)("refuses a settings file that holds %s twice, for the app and for the admin command, with one line and no value", (name) => {
    const l = layout();
    withAdmin(l);
    // The two lines disagree, as when the app would see one and the command the other.
    writeFileSync(l.settings, `DATA_DIR=/data/tours\nSETUP_CODE=${SECRET}\n${name}=made-up-first-value\n# a comment\n  ${name}="made-up-second-value"\n`);
    for (const args of [[], ["admin", "audit"]]) {
      const r = start(l.app, {}, args);
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.started).toBeNull();
      expect(r.stdout).not.toContain("ADMIN RAN");
      expect(r.stderr.trim()).toBe(`demo-platform: the settings file ${l.settings} holds ${name} more than once. Keep one ${name} line and start again.`);
      expect(r.stdout + r.stderr).not.toContain("made-up");
      expect(r.stdout + r.stderr).not.toContain(SECRET);
    }
  });

  it("one line of each is taken as before, a byte-order mark at the start of the file included, and other settings' duplicates still behave as before", () => {
    const l = layout();
    writeFileSync(l.settings, `\uFEFFFILE_STORE=disk\nDATA_DIR=/data/first\nDATA_DIR=/data/second\nSETUP_CODE=${SECRET}\nR2_PUBLIC_BUCKET=one-bucket\n`);
    const r = start(l.app);
    expect(r.status).toBe(0);
    // The app keeps the first of a duplicated other setting, as it always did.
    expect(r.started).toMatchObject({ DATA_DIR: "/data/first" });
  });
});
