// The two interfaces every route reaches data through, and the rules both adapters
// share. Nothing in this file, or in any file outside src/cloudflare/ and src/node/,
// may import a platform API.
import type { Hosts } from "./hosts.ts";
import { NO_MAIL, linkOrigin, type Mailer } from "./mail.ts";

/**
 * A bound parameter. Both back ends bind every JS number as REAL, so a TEXT column
 * stores 5 as "5.0": bind a string for a TEXT column. Integral numbers outside
 * ±(2^53 - 1), NaN and infinities are refused.
 */
export type Value = string | number | null;
export type Stmt = { sql: string; params?: Value[] };

/**
 * Rows come back with TEXT as string, INTEGER and REAL as number, BLOB as Uint8Array
 * and NULL as null, on both back ends. A row holding an integral number outside
 * ±(2^53 - 1) is refused with Error("integer out of range") instead of rounded.
 */
export interface Db {
  all<T>(sql: string, params?: Value[]): Promise<T[]>;
  first<T>(sql: string, params?: Value[]): Promise<T | null>;
  run(sql: string, params?: Value[]): Promise<{ changes: number }>;
  /** Every statement commits, or none does. An empty list is a no-op. */
  batch(stmts: Stmt[]): Promise<void>;
}

export type StoredFile = { body: ReadableStream<Uint8Array>; size: number; contentType: string; cacheControl: string | null };

export interface FileStore {
  /** Replaces an existing key. Throws on a key that fails checkKey. */
  put(key: string, body: Uint8Array, meta: { contentType: string; cacheControl?: string }): Promise<void>;
  get(key: string): Promise<StoredFile | null>;
  /** Deletes exactly these keys. A key that is already gone is not an error. */
  delete(keys: string[]): Promise<void>;
}

/**
 * The longest key both stores accept, in bytes (R2 allows 1,024). Keys are ASCII, so
 * bytes equal characters.
 */
export const MAX_KEY_BYTES = 512;

const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;

/**
 * Throws Error("bad key") unless the key matches the file key pattern and is at most
 * MAX_KEY_BYTES long. Both adapters accept exactly the keys this accepts.
 */
export function checkKey(key: string): void {
  if (typeof key !== "string" || key.length > MAX_KEY_BYTES || !KEY_PATTERN.test(key)) throw new Error("bad key");
}

/** Throws unless every parameter is one both back ends store without loss. */
export function checkParams(params: readonly Value[]): void {
  for (const v of params) {
    if (typeof v !== "number") continue;
    if (!Number.isFinite(v)) throw new Error("number out of range");
    if (Number.isInteger(v) && !Number.isSafeInteger(v)) throw new Error("integer out of range");
  }
}

/**
 * Brings one row to the shared shape: blobs (an array of bytes, an ArrayBuffer or a
 * Uint8Array) become a Uint8Array, and an integral number outside the safe range
 * throws rather than being passed on rounded.
 */
export function normalizeRow<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === "number") {
      if (Number.isInteger(v) && !Number.isSafeInteger(v)) throw new Error("integer out of range");
      out[k] = v;
    } else if (v instanceof Uint8Array) {
      out[k] = new Uint8Array(v);
    } else if (v instanceof ArrayBuffer) {
      out[k] = new Uint8Array(v.slice(0));
    } else if (Array.isArray(v)) {
      out[k] = Uint8Array.from(v as number[]);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/** True when `err` is a UNIQUE or PRIMARY KEY constraint failure from either adapter. */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 3; e = e.cause, depth++) {
    if (/\bUNIQUE constraint failed\b/.test(e.message)) return true;
  }
  return false;
}

/** True when `err` is a NOT NULL constraint failure from either adapter. */
export function isNotNullViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 3; e = e.cause, depth++) {
    if (/\bNOT NULL constraint failed\b/.test(e.message)) return true;
  }
  return false;
}

export type Config = {
  publicImageBase: string; // "" when the app serves published images itself, else an https origin
  setupCode: string | null; // null or shorter than 16 characters: setup is off
  /** Open (uncommitted, unexpired) uploads a workspace may have at once. Default 5. */
  maxOpenUploads?: number;
  /**
   * How long a published image a re-publish replaced stays served before it is deleted,
   * so a viewer still on the previous page keeps its images. Default 10 minutes.
   */
  retiredGraceMs?: number;
  /** The tours and the app address in two-address mode. Absent or null: one address, no host check. */
  hosts?: Hosts | null;
  /**
   * The site's default storage allowance per workspace, in bytes, from the
   * STORAGE_ALLOWANCE_BYTES setting; a workspace's own number comes before it. Absent or
   * null: no limit. 0 is a limit.
   */
  storageAllowanceBytes?: number | null;
  /**
   * The host name sign-in links use on a one-address site, from the SITE_HOST setting, as
   * normaliseHost writes it. Used for links only: no request is checked against it.
   * Absent or null: none. It is not set in two-address mode, where the app address is used.
   */
  siteHost?: string | null;
  /**
   * Who to ask for an invite, from the INVITE_CONTACT setting, trimmed, as written: an
   * email address or an https address. The sign-in page checks it (src/signin/invite.ts)
   * and leaves out a value it cannot use. Absent or null: no contact is shown.
   */
  inviteContact?: string | null;
};

export type Deps = {
  db: Db;
  drafts: FileStore;
  pub: FileStore;
  config: Config;
  now: () => number;
  /** What sends mail. Absent: mail is off. Read it through mailOf. */
  mail?: Mailer;
  /**
   * Takes work that goes on after the answer was given (a mail being sent), so the target
   * can keep it alive and wait for it. Absent: the work just runs. Use it through deferOf.
   */
  defer?: (work: Promise<unknown>) => void;
};

/** The mailer of these deps: the one they carry, or the one that is off and sends nothing. */
export function mailOf(deps: Deps): Mailer {
  return deps.mail ?? NO_MAIL;
}

/**
 * True when the site can mail a link: it has a mailer and an address for links, which come
 * from the settings alone. Without either, nothing that depends on a mailed link (a sign-in
 * link, an email change) can work.
 */
export function canMailLinks(deps: Deps): boolean {
  return mailOf(deps) !== NO_MAIL && linkOrigin(deps.config) !== null;
}

/**
 * The one line written when deferred work fails. Fixed: the failure itself is never
 * written, since it could carry anything a mail server or a back end put in its message.
 */
export const DEFER_FAILED = "background: work after an answer failed";

/**
 * Hands work that outlives the answer to the target. The answer never waits for it, and
 * it must never be given something to retry: a mail that failed after its text was sent
 * may have been delivered. Without a `defer` of their own the deps let the work run, and
 * a failure is the fixed line, so no rejection is ever left unhandled.
 */
export function deferOf(deps: Deps): (work: Promise<unknown>) => void {
  return (
    deps.defer ??
    ((work) => {
      void Promise.resolve(work).catch(() => console.error(DEFER_FAILED));
    })
  );
}

/**
 * Keeps track of deferred work for a target that has to wait for it itself. `defer` takes
 * the work; `settle` resolves when everything taken so far, and anything that work took
 * in turn, has ended. Work that fails calls `onFailure` once, with nothing of the error,
 * and counts as ended; `settle` never rejects.
 */
export function deferTracker(onFailure: () => void): { defer(work: Promise<unknown>): void; settle(): Promise<void> } {
  const open = new Set<Promise<void>>();
  return {
    defer(work) {
      const tracked: Promise<void> = Promise.resolve(work)
        .then(
          () => {},
          () => {
            try {
              onFailure();
            } catch {
              // A handler that fails changes nothing: the work has ended.
            }
          },
        )
        .then(() => {
          open.delete(tracked);
        });
      open.add(tracked);
    },
    async settle() {
      while (open.size > 0) await Promise.all([...open]);
    },
  };
}
