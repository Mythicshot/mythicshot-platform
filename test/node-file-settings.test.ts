// Where the Node target keeps its files (0.1.71): FILE_STORE and the five R2 settings
// (src/node/file-stores.ts, read by name in src/node/config.ts). Every refusal is one fixed
// line that names the setting and never a value, at the start of the app and of the admin
// command; the settings reach the app on every install path; and the one factory gives the
// folders for disk and the buckets for r2, never a quiet fallback. Node only, no network.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ADMIN_SETTINGS, runAdmin } from "../src/node/admin.ts";
import { configFromEnv, fileStoreFromEnv, NODE_SETTINGS } from "../src/node/config.ts";
import { fileStoreFromSettings, makeFileStores, R2_SETTING_NAMES, siteFileStores } from "../src/node/file-stores.ts";
import { NodeFileStore } from "../src/node/files.ts";

const SECRET = "Zq9-made-up-secret-for-the-settings-test-7Hk2";
const GOOD = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_ACCESS_KEY_ID: "made-up-key-id-4711",
  R2_SECRET_ACCESS_KEY: SECRET,
  R2_PRIVATE_BUCKET: "tours-private-bucket",
  R2_PUBLIC_BUCKET: "tours-public-bucket",
};
const ALL_SIX = ["FILE_STORE", ...R2_SETTING_NAMES];

/** The one line configFromEnv stops with for these settings, or null when it takes them. */
function refusal(env: Record<string, string>): string | null {
  try {
    configFromEnv(env);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** Every value in `env`, so a test can check that none of them is in a line. */
const valuesOf = (env: Record<string, string>) => Object.values(env).map((v) => v.trim()).filter((v) => v.length >= 3 && v !== "disk");

describe("the file settings", () => {
  it("are six settings the Node target reads by name, cleared for the admin command like every other", () => {
    for (const name of ALL_SIX) {
      expect(NODE_SETTINGS).toContain(name);
      expect(ADMIN_SETTINGS).toContain(name);
    }
    const config = readFileSync(fileURLToPath(new URL("../src/node/config.ts", import.meta.url)), "utf8");
    for (const name of ALL_SIX) expect(config, name).toContain(`${name}: env.${name},`);
  });

  it("unset, empty or disk: the folders, and nothing else is read or required", () => {
    const envs: Record<string, string>[] = [{}, { FILE_STORE: "" }, { FILE_STORE: "  " }, { FILE_STORE: "disk" }, { FILE_STORE: " DISK " }];
    for (const env of envs) {
      expect(fileStoreFromEnv(env)).toEqual({ mode: "disk", r2: null });
      expect(refusal(env)).toBeNull();
    }
  });

  it("disk with all five R2 settings written: still the folders, and the five are checked and kept for r2-check", () => {
    const s = fileStoreFromEnv({ FILE_STORE: "disk", ...GOOD });
    expect(s.mode).toBe("disk");
    expect(s.r2).toMatchObject({ accountId: GOOD.R2_ACCOUNT_ID, accessKeyId: GOOD.R2_ACCESS_KEY_ID, privateBucket: GOOD.R2_PRIVATE_BUCKET, publicBucket: GOOD.R2_PUBLIC_BUCKET });
    expect(s.r2!.secret.reveal()).toBe(SECRET);
    expect(fileStoreFromEnv({ ...GOOD }).mode).toBe("disk");
  });

  it("r2 with all five: the buckets, values trimmed, in any case of r2", () => {
    for (const mode of ["r2", "R2", " r2 "]) {
      const s = fileStoreFromEnv({ FILE_STORE: mode, ...Object.fromEntries(Object.entries(GOOD).map(([k, v]) => [k, ` ${v} `])) });
      expect(s.mode).toBe("r2");
      expect(s.r2!.privateBucket).toBe(GOOD.R2_PRIVATE_BUCKET);
      expect(s.r2!.secret.reveal()).toBe(SECRET);
    }
  });

  it("the secret never prints: not in the settings, the config, or the stores", () => {
    const env = { FILE_STORE: "r2", ...GOOD };
    const s = fileStoreFromEnv(env);
    const stores = siteFileStores(s, tmpdir());
    const config = configFromEnv(env);
    const printed = [inspect(s, { depth: 10 }), JSON.stringify(s), inspect(stores, { depth: 10 }), JSON.stringify(stores), inspect(config, { depth: 10 }), JSON.stringify(config)].join("\n");
    expect(printed).not.toContain(SECRET);
    // The app's config holds nothing of the file settings at all.
    expect(JSON.stringify(config)).not.toContain(GOOD.R2_ACCESS_KEY_ID);
    expect(JSON.stringify(config)).not.toContain(GOOD.R2_PRIVATE_BUCKET);
  });

  const REFUSALS: [string, Record<string, string>, string][] = [
    ["FILE_STORE neither disk nor r2", { FILE_STORE: "s3", ...GOOD }, "files: FILE_STORE is neither disk nor r2. Fix it, or remove the line to keep the files on disk."],
    ["FILE_STORE=r2 without the five", { FILE_STORE: "r2" }, "files: FILE_STORE is r2, but the five R2 settings are missing. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_PRIVATE_BUCKET and R2_PUBLIC_BUCKET, or set FILE_STORE=disk."],
    ["one missing, with r2", { FILE_STORE: "r2", ...GOOD, R2_SECRET_ACCESS_KEY: "" }, "files: R2_SECRET_ACCESS_KEY is missing. Set all five R2 settings, or none of them to keep the files on disk."],
    ["two missing, on disk (a half-filled set is caught early)", { R2_ACCOUNT_ID: GOOD.R2_ACCOUNT_ID, R2_ACCESS_KEY_ID: GOOD.R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY: SECRET }, "files: R2_PRIVATE_BUCKET, R2_PUBLIC_BUCKET are missing. Set all five R2 settings, or none of them to keep the files on disk."],
    ["only the secret, on disk", { R2_SECRET_ACCESS_KEY: SECRET }, "files: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_PRIVATE_BUCKET, R2_PUBLIC_BUCKET are missing. Set all five R2 settings, or none of them to keep the files on disk."],
    ["one bucket for both", { FILE_STORE: "r2", ...GOOD, R2_PUBLIC_BUCKET: GOOD.R2_PRIVATE_BUCKET }, "files: R2_PRIVATE_BUCKET and R2_PUBLIC_BUCKET name the same bucket. The private and the public files must be in two different buckets."],
    ["one bucket for both, on disk too", { ...GOOD, R2_PUBLIC_BUCKET: GOOD.R2_PRIVATE_BUCKET }, "files: R2_PRIVATE_BUCKET and R2_PUBLIC_BUCKET name the same bucket. The private and the public files must be in two different buckets."],
  ];
  it.each(REFUSALS)("refuses %s with one fixed line and no value", (_name, env, line) => {
    expect(refusal(env)).toBe(line);
    for (const v of valuesOf(env)) expect(line).not.toContain(v);
  });

  const SHAPE_SAYS: Record<string, string> = {
    R2_ACCOUNT_ID: "a Cloudflare account id: 32 characters, digits and the letters a to f",
    R2_ACCESS_KEY_ID: "an R2 access key id: up to 128 printable characters without spaces",
    R2_SECRET_ACCESS_KEY: "an R2 secret access key: up to 256 printable characters without spaces",
    R2_PRIVATE_BUCKET: "an R2 bucket name: 3 to 63 lowercase letters, digits and hyphens, beginning and ending with a letter or digit",
    R2_PUBLIC_BUCKET: "an R2 bucket name: 3 to 63 lowercase letters, digits and hyphens, beginning and ending with a letter or digit",
  };
  const BAD_SHAPES: [string, string][] = [
    ["R2_ACCOUNT_ID", "0123456789abcdef0123456789abcde"],
    ["R2_ACCOUNT_ID", "0123456789abcdef0123456789abcdef0"],
    ["R2_ACCOUNT_ID", "0123456789ABCDEF0123456789ABCDEF"],
    ["R2_ACCOUNT_ID", "0123456789abcdef0123456789abcdeg"],
    ["R2_ACCOUNT_ID", "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com"],
    ["R2_ACCESS_KEY_ID", "has a space"],
    ["R2_ACCESS_KEY_ID", "k".repeat(129)],
    ["R2_ACCESS_KEY_ID", "tab\there"],
    ["R2_ACCESS_KEY_ID", "nonascii-é"],
    ["R2_SECRET_ACCESS_KEY", `${SECRET} tail`],
    ["R2_SECRET_ACCESS_KEY", "s".repeat(257)],
    ["R2_SECRET_ACCESS_KEY", `line\nbreak-${SECRET}`],
    ["R2_PRIVATE_BUCKET", "ab"],
    ["R2_PRIVATE_BUCKET", "b".repeat(64)],
    ["R2_PRIVATE_BUCKET", "Tours-Private"],
    ["R2_PRIVATE_BUCKET", "-tours-private"],
    ["R2_PRIVATE_BUCKET", "tours-private-"],
    ["R2_PRIVATE_BUCKET", "tours.private"],
    ["R2_PRIVATE_BUCKET", "tours_private"],
    ["R2_PUBLIC_BUCKET", "tours/public"],
    ["R2_PUBLIC_BUCKET", "tours public"],
  ];
  it.each(BAD_SHAPES)("refuses %s of the wrong shape, %j, naming the setting and not the value, with FILE_STORE disk or r2", (name, value) => {
    for (const mode of ["disk", "r2", ""]) {
      const env = { FILE_STORE: mode, ...GOOD, [name]: value };
      const line = refusal(env);
      expect(line).toBe(`files: ${name} is not ${SHAPE_SAYS[name]}. Fix it, or remove all five R2 settings (and FILE_STORE=r2) to keep the files on disk.`);
      for (const v of valuesOf(env)) expect(line).not.toContain(v);
    }
  });

  it("takes the edges of each shape", () => {
    for (const over of [{ R2_PRIVATE_BUCKET: "abc" }, { R2_PRIVATE_BUCKET: "a".repeat(63) }, { R2_PUBLIC_BUCKET: "0-9" }, { R2_ACCESS_KEY_ID: "k".repeat(128) }, { R2_SECRET_ACCESS_KEY: "s".repeat(256) }, { R2_SECRET_ACCESS_KEY: "!#$%&'()*+,-./:;<=>?@[\\]^_`{|}~" }]) {
      expect(refusal({ FILE_STORE: "r2", ...GOOD, ...over }), JSON.stringify(over)).toBeNull();
    }
  });

  it("a value that is not text is refused as of the wrong shape", () => {
    const r = fileStoreFromSettings({ FILE_STORE: "r2", ...GOOD, R2_ACCOUNT_ID: 42 });
    expect(r).toEqual({ ok: false, problem: expect.stringMatching(/^files: R2_ACCOUNT_ID is not /) });
    expect(fileStoreFromSettings({ FILE_STORE: 7 })).toEqual({ ok: false, problem: "files: FILE_STORE is neither disk nor r2. Fix it, or remove the line to keep the files on disk." });
  });
});

describe("the one factory", () => {
  it("disk: the data folder's drafts and public folders, whatever R2 settings are written", () => {
    const root = mkdtempSync(join(tmpdir(), "dp-files-"));
    for (const env of [{}, { ...GOOD }]) {
      const { drafts, pub } = siteFileStores(fileStoreFromEnv(env), root);
      expect(drafts).toBeInstanceOf(NodeFileStore);
      expect((drafts as NodeFileStore).root).toBe(join(root, "drafts"));
      expect((pub as NodeFileStore).root).toBe(join(root, "public"));
    }
  });

  it("r2: the two buckets and never a folder", () => {
    const { drafts, pub } = siteFileStores(fileStoreFromEnv({ FILE_STORE: "r2", ...GOOD }), tmpdir());
    expect(drafts).not.toBeInstanceOf(NodeFileStore);
    expect(pub).not.toBeInstanceOf(NodeFileStore);
    expect((drafts as unknown as { role: string }).role).toBe("private");
    expect((pub as unknown as { role: string }).role).toBe("public");
  });

  it("refuses r2 without R2 settings rather than fall back to the folders", () => {
    expect(() => makeFileStores("r2", { mode: "r2", r2: null }, tmpdir())).toThrow("files: the R2 settings are missing");
  });

  it("entry.ts and every admin command that touches a file make their stores with it, and nothing else in src/node makes a store", () => {
    const read = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");
    expect(read("../src/node/entry.ts")).toContain("const files = siteFileStores(fileStoreFromEnv(process.env), root);");
    const admin = read("../src/node/admin.ts");
    expect(admin.match(/const fileSettings = fileSettingsOrSay\(env, out\);\n\s+if \(fileSettings === null\) return 1;\n\s+const files = siteFileStores\(fileSettings, root, opts\.r2\);/g)?.length).toBe(2);
    for (const f of ["../src/node/entry.ts", "../src/node/admin.ts", "../src/node/config.ts"]) {
      expect(read(f), f).not.toMatch(/new NodeFileStore\(|r2Stores\(/);
    }
  });
});

describe("the start stops on a bad set, with one line and no value", () => {
  it("the app: exit 1, the line on standard error, nothing else of the settings", () => {
    const data = mkdtempSync(join(tmpdir(), "dp-files-entry-"));
    const base: Record<string, string> = {};
    for (const k of ["PATH", "Path", "SystemRoot", "TEMP", "TMP"]) if (process.env[k] !== undefined) base[k] = process.env[k] as string;
    const entry = fileURLToPath(new URL("../src/node/entry.ts", import.meta.url));
    const env = { ...base, DATA_DIR: data, PORT: "3999", FILE_STORE: "r2", R2_ACCOUNT_ID: GOOD.R2_ACCOUNT_ID, R2_SECRET_ACCESS_KEY: SECRET };
    const r = spawnSync(process.execPath, [entry], { env, encoding: "utf8", timeout: 60_000, windowsHide: true });
    expect(r.status).toBe(1);
    expect(r.stderr.trim()).toBe("files: R2_ACCESS_KEY_ID, R2_PRIVATE_BUCKET, R2_PUBLIC_BUCKET are missing. Set all five R2 settings, or none of them to keep the files on disk.");
    expect(r.stdout + r.stderr).not.toContain(SECRET);
    expect(r.stdout + r.stderr).not.toContain(GOOD.R2_ACCOUNT_ID);
  }, 60_000);

  it("the admin command: a command that touches files refuses with the same line and exit 1; one that touches none is not closed by it", async () => {
    const env = { DATA_DIR: tmpdir(), FILE_STORE: "r2", ...GOOD, R2_PUBLIC_BUCKET: "Bad_Bucket" };
    const LINE = "files: R2_PUBLIC_BUCKET is not an R2 bucket name: 3 to 63 lowercase letters, digits and hyphens, beginning and ending with a letter or digit. Fix it, or remove all five R2 settings (and FILE_STORE=r2) to keep the files on disk.";
    for (const argv of [["r2-check"], ["files-copy", "--from", "r2", "--to", "disk", "--dry-run"]]) {
      const lines: string[] = [];
      expect(await runAdmin(argv, env, (l) => lines.push(l)), argv[0]).toBe(1);
      expect(lines).toEqual([LINE]);
    }
    // audit is not closed by the file settings: it stops for its own reason (no database here), not theirs.
    const lines: string[] = [];
    await runAdmin(["audit"], env, (l) => lines.push(l));
    expect(lines.join("\n")).not.toContain("files:");
  });
});

describe("the settings reach the app on every install path", () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

  it("the tunnel stack and its copy in install.sh pass each one on from .env, the secret to the app only", () => {
    for (const f of ["../deploy/tunnel/docker-compose.yml", "../deploy/install.sh"]) {
      const text = read(f);
      for (const name of ALL_SIX) expect(text, `${f}: ${name}`).toContain(`      ${name}: \${${name}:-}\n`);
    }
    const stack = read("../deploy/tunnel/docker-compose.yml");
    const app = stack.match(/^  app:\n((?:(?:    .*)?\n)*)/m)?.[1] ?? "";
    expect(stack.match(/R2_SECRET_ACCESS_KEY/g)?.length).toBe(app.match(/R2_SECRET_ACCESS_KEY/g)?.length);
  });

  it("the cPanel startup file's header names them", () => {
    const header = read("../deploy/cpanel/app.cjs").split("\n").filter((l) => l.startsWith("//")).join("\n");
    for (const name of ALL_SIX) expect(header, name).toMatch(new RegExp(`\\b${name}\\b`));
  });

  it("the README's settings table has a row for each", () => {
    const readme = read("../README.md");
    for (const name of ALL_SIX) expect(readme, name).toMatch(new RegExp(`^\\| \`${name}\` \\| Node \\| `, "m"));
  });
});
