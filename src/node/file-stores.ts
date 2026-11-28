// Where the Node target keeps its files (0.1.71): the one place that turns the file settings
// into the pair of stores, for the app (src/node/entry.ts) and for every admin command that
// touches a file (src/node/admin.ts). No code path builds a store any other way, so with
// FILE_STORE=r2 nothing can fall back to the data folder by itself.
//
// The settings, six of them, read by name in src/node/config.ts (fileStoreFromEnv):
// - FILE_STORE: `disk` (also when unset or empty), the drafts/ and public/ folders of the
//   data folder, as before; or `r2`, two R2 buckets.
// - R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_PRIVATE_BUCKET, R2_PUBLIC_BUCKET:
//   all five or none. They may be written while FILE_STORE is disk (so the key can be typed in
//   and checked with r2-check before the switch), and are then checked all the same, so a typo
//   is found early. With FILE_STORE=r2 all five are required.
// A setting that is missing or of the wrong shape is a problem: one fixed line that names the
// setting and never repeats a value, for the start to stop with, as billing's settings do.
// The secret is handed to the R2 store only, inside an R2Secret that never prints.
import { join } from "node:path";
import type { FileStore } from "../ports.ts";
import { NodeFileStore } from "./files.ts";
import { R2Secret, r2Stores, type R2Options, type R2Settings } from "./r2-files.ts";

/** The five R2 settings, in the order they are checked. */
export const R2_SETTING_NAMES = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_PRIVATE_BUCKET", "R2_PUBLIC_BUCKET"] as const;
type R2SettingName = (typeof R2_SETTING_NAMES)[number];

/**
 * The file settings as checked: where the files are, and the R2 settings when they are written.
 * `r2Problem` (0.1.71): with the files on disk, the one line for R2 settings that cannot be used
 * yet. The site runs on disk and says it at its start; r2-check and files-copy refuse with it.
 */
export type FileStoreSettings = { mode: "disk" | "r2"; r2: R2Settings | null; r2Problem?: string };

/** A store whose keys can be listed: both kinds have it, for the admin command's tools and the tests. */
export type ListableStore = FileStore & { keys(): Promise<string[]> };

/** R2's rule for a bucket name: 3 to 63 lowercase letters, digits and hyphens, beginning and ending with a letter or digit. */
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
/** Printable ASCII without spaces. */
const PRINTABLE = /^[\x21-\x7e]+$/;

const SHAPES: Record<R2SettingName, { test: (v: string) => boolean; says: string }> = {
  R2_ACCOUNT_ID: { test: (v) => /^[0-9a-f]{32}$/.test(v), says: "a Cloudflare account id: 32 characters, digits and the letters a to f" },
  R2_ACCESS_KEY_ID: { test: (v) => v.length <= 128 && PRINTABLE.test(v), says: "an R2 access key id: up to 128 printable characters without spaces" },
  R2_SECRET_ACCESS_KEY: { test: (v) => v.length <= 256 && PRINTABLE.test(v), says: "an R2 secret access key: up to 256 printable characters without spaces" },
  R2_PRIVATE_BUCKET: { test: (v) => BUCKET.test(v), says: "an R2 bucket name: 3 to 63 lowercase letters, digits and hyphens, beginning and ending with a letter or digit" },
  R2_PUBLIC_BUCKET: { test: (v) => BUCKET.test(v), says: "an R2 bucket name: 3 to 63 lowercase letters, digits and hyphens, beginning and ending with a letter or digit" },
};

const KEEP_ON_DISK = "Fix it, or remove all five R2 settings (and FILE_STORE=r2) to keep the files on disk.";

/**
 * The file settings from their raw values. Each is trimmed; a value that is unset, empty or
 * only spaces is missing. Never throws, and a problem never holds a value.
 */
export function fileStoreFromSettings(raw: Partial<Record<"FILE_STORE" | R2SettingName, unknown>>): { ok: true; settings: FileStoreSettings } | { ok: false; problem: string; mode: "disk" | "r2" | null } {
  const modeRaw = raw.FILE_STORE;
  const modeText = typeof modeRaw === "string" ? modeRaw.trim().toLowerCase() : modeRaw === undefined || modeRaw === null ? "" : null;
  if (modeText !== "" && modeText !== "disk" && modeText !== "r2") {
    return { ok: false, problem: "files: FILE_STORE is neither disk nor r2. Fix it, or remove the line to keep the files on disk.", mode: null };
  }
  const mode = modeText === "r2" ? "r2" : "disk";
  const values: Partial<Record<R2SettingName, string>> = {};
  for (const name of R2_SETTING_NAMES) {
    const v = raw[name];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") return { ok: false, problem: `files: ${name} is not ${SHAPES[name].says}. ${KEEP_ON_DISK}`, mode };
    const text = v.trim();
    if (text === "") continue;
    if (!SHAPES[name].test(text)) return { ok: false, problem: `files: ${name} is not ${SHAPES[name].says}. ${KEEP_ON_DISK}`, mode };
    values[name] = text;
  }
  const missing = R2_SETTING_NAMES.filter((name) => values[name] === undefined);
  if (missing.length === R2_SETTING_NAMES.length) {
    if (mode === "r2") {
      return { ok: false, problem: "files: FILE_STORE is r2, but the five R2 settings are missing. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_PRIVATE_BUCKET and R2_PUBLIC_BUCKET, or set FILE_STORE=disk.", mode };
    }
    return { ok: true, settings: { mode: "disk", r2: null } };
  }
  const { R2_ACCOUNT_ID: accountId, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secret, R2_PRIVATE_BUCKET: privateBucket, R2_PUBLIC_BUCKET: publicBucket } = values;
  if (accountId === undefined || accessKeyId === undefined || secret === undefined || privateBucket === undefined || publicBucket === undefined) {
    return { ok: false, problem: `files: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing. Set all five R2 settings, or none of them to keep the files on disk.`, mode };
  }
  if (privateBucket === publicBucket) {
    return { ok: false, problem: "files: R2_PRIVATE_BUCKET and R2_PUBLIC_BUCKET name the same bucket. The private and the public files must be in two different buckets.", mode };
  }
  return { ok: true, settings: { mode, r2: { accountId, accessKeyId, secret: new R2Secret(secret), privateBucket, publicBucket } } };
}

/** The line the start writes for R2 settings that cannot be used while the files are on disk. */
export function diskModeR2Line(problem: string): string {
  return `${problem} The files stay on disk and the site runs; r2-check shows the same line, and FILE_STORE=r2 is refused until this is fixed.`;
}

/**
 * The pair of stores for `mode`: the drafts/ and public/ folders of `dataRoot` for disk, the
 * two buckets for r2. Throws when r2 is asked for without R2 settings: never a quiet
 * fallback to the folders. `r2` changes how the R2 stores reach R2 (tests only).
 */
export function makeFileStores(mode: "disk" | "r2", settings: FileStoreSettings, dataRoot: string, r2: R2Options = {}): { drafts: ListableStore; pub: ListableStore } {
  if (mode === "disk") return { drafts: new NodeFileStore(join(dataRoot, "drafts")), pub: new NodeFileStore(join(dataRoot, "public")) };
  if (settings.r2 === null) throw new Error("files: the R2 settings are missing");
  return r2Stores(settings.r2, r2);
}

/** The site's own stores: those of the mode the settings name. */
export function siteFileStores(settings: FileStoreSettings, dataRoot: string, r2: R2Options = {}): { drafts: ListableStore; pub: ListableStore } {
  return makeFileStores(settings.mode, settings, dataRoot, r2);
}
