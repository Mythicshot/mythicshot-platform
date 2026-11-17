import { accessSync, constants, mkdirSync } from "node:fs";
import { resolve } from "node:path";

/** The user id the container image runs the app as; the data folder must be writable by it. */
export const APP_UID = 1001;

/**
 * Makes sure the data folder exists and this process can write to it, and returns its
 * absolute path. Otherwise throws one plain line naming the folder and the user id that
 * needs write access, so a misowned volume reads clearly in `docker logs`.
 */
export function prepareDataDir(dataDir: string): string {
  const root = resolve(dataDir);
  const uid = typeof process.getuid === "function" ? process.getuid() : APP_UID;
  try {
    mkdirSync(root, { recursive: true });
    accessSync(root, constants.W_OK | constants.X_OK);
  } catch {
    throw new Error(`data folder ${root} is missing or not writable: it must exist and be writable by uid ${uid}`);
  }
  return root;
}
