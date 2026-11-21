// The audit record: what was done, when, and by which account. No platform API and no
// web framework. This file is the only writer of the `audit` table.
//
// A row holds the time, the event, the acting account's id, the workspace id, a subject
// id (a session, an account or a workspace) and, for some events, a few numbers. It never
// holds an email, a network address, a sign-in code, a cookie, a token or a digest of
// one. The writer below takes only what a row is meant to hold (ids of the one form every
// row id has, whole numbers, nulls and short lowercase words) and refuses everything
// else, so a mistake in a caller fails loudly in its tests instead of putting a secret
// in the database.
import type { Deps, Stmt } from "./ports.ts";

export const AUDIT_EVENTS = [
  "first_admin",
  "signin_link_sent",
  "signin_link_printed",
  "signin",
  "signout",
  "signout_everywhere",
  "session_revoked",
  "allowance_set",
  "email_change_requested",
  "email_changed",
  "email_changed_on_server",
  "connection_confirmed",
  "connection_refused",
  "connection_collected",
  "connection_mail_not_sent",
  "token_renamed",
  "token_revoked",
  "invite_sent",
  "invite_resent",
  "invite_cancelled",
  "invite_accepted",
  "account_disabled",
  "account_enabled",
  "account_deleted",
  "tour_access_changed",
  "media_access_changed",
  "viewer_link_sent",
  "viewer_signin",
  "terms_agreed",
] as const;
export type AuditEvent = (typeof AUDIT_EVENTS)[number];

export type AuditEntry = {
  event: AuditEvent;
  /** The id of the account that acted. */
  userId?: string | null;
  /** The id of the workspace it happened in. */
  workspaceId?: string | null;
  /** The id of what was acted on: a session, an account, a workspace, a token, a connect request, an invite, a viewer code, a viewer session or a version of the terms. */
  subject?: string | null;
  /**
   * A flat record of at most 8 entries. A value is a whole number, null (such as an
   * allowance that is the site's default) or a short lowercase word.
   */
  detail?: Record<string, number | string | null> | null;
};

/**
 * The form of every row id in this codebase, as `newId` in src/auth.ts makes them: a
 * prefix of two to four lowercase letters (`ws`, `usr`, `tok`, `tour`, `ch`, `st`, `up`,
 * and `aud` here), an underscore and 24 lowercase hex characters. A token, a sign-in
 * code and a session secret have more hex than that, so none of them is an id.
 */
const ROW_ID = /^[a-z]{2,4}_[0-9a-f]{24}$/;

/** A detail key or text value: a lowercase letter, then at most 39 lowercase letters, digits and underscores. */
const WORD = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * The prefix of a token (`dp_`), a sign-in code (`dpl_`), an email-change code (`dpe_`), a
 * device code (`dpd_`), an invite code (`dpi_`), a viewer code (`dpv_`), a session secret
 * (`dps_`) or a viewer session secret (`dpw_`) with hex after it: a word can be most of one.
 */
const SECRET_PREFIX = /dp[lsedivw]?_[0-9a-f]{8}/;

/** 32 or more hex characters in a row: a digest, or the random part of a secret. */
const LONG_HEX = /[0-9a-f]{32}/;

/** Keys that name a part of every object. Refused, so a reader of the JSON can never be confused by one. */
const OBJECT_PARTS = new Set(["__proto__", "constructor", "prototype"]);

/** The most entries a detail may have. */
const MAX_DETAIL_ENTRIES = 8;

/** The one refusal for anything that must not be recorded. Fixed text: it never repeats the value. */
function refuse(): never {
  throw new Error("audit: a value that must not be recorded");
}

/** An id field: absent or null, or a row id. */
function idField(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !ROW_ID.test(v)) refuse();
  return v;
}

/** Throws unless `s` is a word that is no part of a secret. */
function checkWord(s: unknown): asserts s is string {
  if (typeof s !== "string" || !WORD.test(s) || SECRET_PREFIX.test(s) || LONG_HEX.test(s)) refuse();
}

/** The detail as JSON text, or null when there is none. */
function detailText(detail: unknown): string | null {
  if (detail === undefined || detail === null) return null;
  if (typeof detail !== "object" || Array.isArray(detail)) refuse();
  const proto: unknown = Object.getPrototypeOf(detail);
  if (proto !== Object.prototype && proto !== null) refuse();
  const entries = Object.entries(detail as Record<string, unknown>);
  if (entries.length > MAX_DETAIL_ENTRIES) refuse();
  // Built on no prototype, so no key can be anything but an entry.
  const out: Record<string, number | string | null> = Object.create(null);
  for (const [key, value] of entries) {
    checkWord(key);
    if (OBJECT_PARTS.has(key)) refuse();
    if (value === null) {
      out[key] = null;
    } else if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) refuse();
      out[key] = value;
    } else {
      checkWord(value);
      out[key] = value;
    }
  }
  return JSON.stringify(out);
}

/** A new audit row id: "aud_" and 24 lowercase hex characters, the form every row id has. */
function newAuditId(): string {
  let s = "aud_";
  for (const b of crypto.getRandomValues(new Uint8Array(12))) s += b.toString(16).padStart(2, "0");
  return s;
}

/**
 * The statement that records one event, for the caller to run in the same batch as the
 * action itself, so the record and the action are written together or not at all.
 * Nothing is written by calling this. The time is `deps.now()`. With `onlyAfterOneChange`,
 * the row also guards the batch: placed right after another statement, it fails (and so
 * undoes the batch) unless that statement changed exactly one row.
 *
 * Throws `Error("audit: unknown event")` for an event outside `AUDIT_EVENTS`, and
 * `Error("audit: a value that must not be recorded")` when:
 *
 * - `userId`, `workspaceId` or `subject` is neither null nor a row id
 *   (`^[a-z]{2,4}_[0-9a-f]{24}$`);
 * - the detail is not a plain flat record of at most 8 entries;
 * - a detail key, or a detail value that is text, is not a word
 *   (`^[a-z][a-z0-9_]{0,39}$`, so never empty), is `__proto__`, `constructor` or
 *   `prototype` as a key, or holds most of a token, a sign-in code, a session secret or
 *   a digest;
 * - a detail value is anything but such a word, a safe whole number or null.
 *
 * So no email, network address, cookie, token, code or digest can pass. Neither message
 * repeats the value. The JSON of the largest detail is under 1000 bytes, the most the
 * table takes.
 */
export function auditStatement(deps: Deps, e: AuditEntry, opts: { onlyAfterOneChange?: boolean } = {}): Stmt {
  if (typeof e.event !== "string" || !(AUDIT_EVENTS as readonly string[]).includes(e.event)) throw new Error("audit: unknown event");
  const userId = idField(e.userId);
  const workspaceId = idField(e.workspaceId);
  const subject = idField(e.subject);
  const detail = detailText(e.detail);
  return {
    // With onlyAfterOneChange the row is the guard of a batch: it must come right after the
    // statement it judges, and unless that statement changed exactly one row its time is
    // NULL, which the column refuses, so the whole batch is undone. changes() is the count
    // of the last statement that finished on the connection, on both targets.
    sql:
      opts.onlyAfterOneChange === true
        ? "INSERT INTO audit (id, at, event, user_id, workspace_id, subject, detail) VALUES (?, CASE WHEN changes() = 1 THEN ? END, ?, ?, ?, ?, ?)"
        : "INSERT INTO audit (id, at, event, user_id, workspace_id, subject, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
    params: [newAuditId(), deps.now(), e.event, userId, workspaceId, subject, detail],
  };
}
