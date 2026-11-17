// API tokens, ids, slugs and the request guard. Uses only Web Crypto, which both
// targets provide as the global `crypto`.
import type { Deps } from "./ports.ts";

export type Auth = { workspaceId: string; tokenId: string };

const TOKEN_PATTERN = /^dp_[0-9a-f]{40}$/;
const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** A new API token: "dp_" and 40 lowercase hex characters (160 random bits). */
export function newToken(): string {
  return "dp_" + hex(randomBytes(20));
}

/** The SHA-256 hex digest of the token, the only form in which a token is stored. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return hex(new Uint8Array(digest));
}

/** A new row id: the prefix, "_" and 24 lowercase hex characters (96 random bits). */
export function newId(prefix: "ws" | "usr" | "tok" | "tour" | "ch" | "st" | "up"): string {
  return prefix + "_" + hex(randomBytes(12));
}

/** A new public slug: 10 characters from a-z and 2-7 (50 random bits). */
export function newSlug(): string {
  // 256 is a multiple of 32, so masking each byte keeps every character equally likely.
  let s = "";
  for (const b of randomBytes(10)) s += SLUG_ALPHABET[b & 31];
  return s;
}

/**
 * True when the strings are equal. Runs through every character of the longer string
 * whatever the inputs, so the time taken does not reveal where they first differ.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const n = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  return diff === 0;
}

/** The one answer for a missing, malformed, unknown or revoked token. */
function unauthorized(): Response {
  return new Response('{"error":"unauthorized"}', {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Resolves `Authorization: Bearer <token>` to the token's workspace, and records when
 * the token was last used. Anything else answers the 401 Response. The token is never
 * logged, stored or put in an error: only its hash reaches the database.
 */
export async function requireAuth(req: Request, deps: Deps): Promise<Auth | Response> {
  const header = req.headers.get("authorization") ?? "";
  const sp = header.indexOf(" ");
  const scheme = sp < 0 ? "" : header.slice(0, sp);
  const token = sp < 0 ? "" : header.slice(sp + 1);
  if (scheme.toLowerCase() !== "bearer" || !TOKEN_PATTERN.test(token)) return unauthorized();

  // The lookup compares SHA-256 digests, not the token, so its timing tells a caller
  // nothing useful about any stored token; the row's hash is compared again in
  // constant time before it is trusted.
  const hash = await hashToken(token);
  const row = await deps.db.first<{ id: string; workspace_id: string; hash: string }>(
    "SELECT id, workspace_id, hash FROM api_token WHERE hash = ? AND revoked_at IS NULL",
    [hash],
  );
  if (row === null || !constantTimeEqual(row.hash, hash)) return unauthorized();

  await deps.db.run("UPDATE api_token SET last_used_at = ? WHERE id = ? AND workspace_id = ?", [
    deps.now(),
    row.id,
    row.workspace_id,
  ]);
  return { workspaceId: row.workspace_id, tokenId: row.id };
}
