// The audit record: what was done, when, and by which account. No platform API and no
// web framework. This file is the only writer of the `audit` table.
//
// A row holds the time, the event, the acting account's id, the workspace id, a subject
// id (a session or a workspace) and, for some events, a few numbers. It never holds an
// email, a network address, a sign-in code, a cookie, a token or a digest of one: the
// writer below refuses each of those shapes, so a mistake in a caller fails loudly in
// its tests instead of putting a secret in the database.
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
] as const;
export type AuditEvent = (typeof AUDIT_EVENTS)[number];

export type AuditEntry = {
  event: AuditEvent;
  /** The account that acted. */
  userId?: string | null;
  workspaceId?: string | null;
  /** The id of what was acted on: a session or a workspace. */
  subject?: string | null;
  /** A flat record of whole numbers and short plain words, such as the old and new allowance. */
  detail?: Record<string, number | string> | null;
};

/** The longest text one field or one detail value may hold. */
const MAX_TEXT_CHARS = 200;

/**
 * All a recorded text may be made of: ASCII letters, digits, the underscore, the dot, the
 * hyphen and the space. That alone keeps out an email (@), a cookie (=), an IPv6 address
 * (:), a line break and every character that is not ASCII.
 */
const PLAIN_TEXT = /^[A-Za-z0-9_. -]*$/;

/** The prefix of a token (`dp_`), a sign-in code (`dpl_`) or a session secret (`dps_`) with hex after it, whole or cut short. */
const SECRET_PREFIX = /dp[ls]?_[0-9a-f]{8}/i;

/** 32 or more hex characters in a row: a digest, or the random part of a secret. A row id has 24. */
const LONG_HEX = /[0-9a-f]{32}/i;

/** Four numbers with dots between them: an IPv4 address. */
const DOTTED_QUAD = /(?:^|[^0-9])[0-9]{1,3}(?:\.[0-9]{1,3}){3}(?:[^0-9]|$)/;

/** The one refusal for anything that must not be recorded. Fixed text: it never repeats the value. */
function refuse(): never {
  throw new Error("audit: a value that must not be recorded");
}

/** Throws unless `s` is short plain text in none of the secret shapes. */
function checkText(s: unknown): asserts s is string {
  if (typeof s !== "string" || s.length > MAX_TEXT_CHARS) refuse();
  if (!PLAIN_TEXT.test(s) || SECRET_PREFIX.test(s) || LONG_HEX.test(s) || DOTTED_QUAD.test(s)) refuse();
}

/** An id field: absent, null, or text that passes `checkText`. */
function idField(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return null;
  checkText(v);
  return v;
}

/** The detail as JSON text, or null. Keys are checked like values; a number must be a whole one that JSON keeps exactly. */
function detailText(detail: AuditEntry["detail"]): string | null {
  if (detail === undefined || detail === null) return null;
  if (typeof detail !== "object" || Array.isArray(detail)) refuse();
  const out: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(detail)) {
    checkText(key);
    if (key === "") refuse();
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) refuse();
    } else {
      checkText(value);
    }
    out[key] = value;
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
 * Nothing is written by calling this. The time is `deps.now()`.
 *
 * Throws `Error("audit: unknown event")` for an event outside `AUDIT_EVENTS`, and
 * `Error("audit: a value that must not be recorded")` when an id, a detail key or a
 * detail value is not short plain text (ASCII letters, digits, `_`, `.`, `-` and the
 * space, at most 200 characters) or looks like a token, a sign-in code, a session secret
 * or cookie, a digest, an email or a network address; also for a detail that is not a
 * flat record, and for a number that is not a safe whole number. Neither message
 * repeats the value.
 */
export function auditStatement(deps: Deps, e: AuditEntry): Stmt {
  if (typeof e.event !== "string" || !(AUDIT_EVENTS as readonly string[]).includes(e.event)) throw new Error("audit: unknown event");
  const userId = idField(e.userId);
  const workspaceId = idField(e.workspaceId);
  const subject = idField(e.subject);
  const detail = detailText(e.detail);
  return {
    sql: "INSERT INTO audit (id, at, event, user_id, workspace_id, subject, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
    params: [newAuditId(), deps.now(), e.event, userId, workspaceId, subject, detail],
  };
}
