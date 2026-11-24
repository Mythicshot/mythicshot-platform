// The stored side of the removal clock (0.1.62): reading a workspace's warning mails (migration
// 0024) in the same statement as its billing row, and the digest a warning is recorded under in
// place of the address. Imports nothing but types, so the dashboard's state route (src/billing.ts)
// and the sweep (src/billing-sweep.ts) share it without importing each other.
import type { WarningRow } from "./removal-rules.ts";

/**
 * The warnings of the row of `workspace` in scope, as one JSON array: a scalar expression that
 * takes no parameter, for a statement that already reads the workspace's row.
 */
export const WARNINGS_JSON_SQL =
  "(SELECT json_group_array(json_object('stage', w.stage, 'removal_at', w.removal_at, 'email_sha256', w.email_sha256, 'claimed_at', w.claimed_at, 'sent_at', w.sent_at, 'named_at', w.named_at))" +
  " FROM billing_warning w WHERE w.workspace_id = workspace.id)";

/** The rows of WARNINGS_JSON_SQL's text; a row of any other shape is left out (and so counts as never sent). */
export function warningsOf(text: unknown): WarningRow[] {
  if (typeof text !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
  const out: WarningRow[] = [];
  for (const r of parsed as Record<string, unknown>[]) {
    if (r === null || typeof r !== "object") continue;
    if (!whole(r.stage) || !whole(r.removal_at) || typeof r.email_sha256 !== "string" || !whole(r.claimed_at) || !whole(r.named_at)) continue;
    if (r.sent_at !== null && !whole(r.sent_at)) continue;
    out.push({ stage: r.stage, removal_at: r.removal_at, email_sha256: r.email_sha256, claimed_at: r.claimed_at, sent_at: r.sent_at as number | null, named_at: r.named_at });
  }
  return out;
}

/** The SHA-256 of an address as stored, in hex: what a warning is recorded under. */
export async function emailSha256(email: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email)));
  let hex = "";
  for (const b of digest) hex += b.toString(16).padStart(2, "0");
  return hex;
}
