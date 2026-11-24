// Disabling, enabling and deleting an account: the site's admin's routes for an account as
// a whole. No platform API.
//
// - POST /api/v1/admin/accounts/:id/disable: the account cannot sign in from now on. In one
//   batch: its status, every session of it ended, its open sign-in codes and its open email
//   change spent, and the audit row. Its tokens are kept but refused while it is disabled
//   (the token lookup in src/auth.ts refuses every token of a workspace with a disabled
//   account), and a request to connect the app that it confirmed can no longer be collected
//   (src/connect.ts holds the same rule). Nothing of its workspace is served: tour pages and
//   pictures (src/page.ts, src/publish.ts) and shared items (onlineItemFiles in
//   src/media.ts) answer as for one that does not exist. Nothing is deleted. Viewer sessions
//   and codes for the account's address (src/viewers.ts) are not the account's and are left
//   as they are: a viewer is an address that proved it reads its mail, not an account.
// - POST /api/v1/admin/accounts/:id/enable: the status goes back to active and nothing else
//   changes; the person signs in again for the dashboard.
// - GET /api/v1/admin/accounts/:id/removal: what a delete would remove, as counts.
// - DELETE /api/v1/admin/accounts/:id with {"username": ...}: deletes a disabled account
//   and everything in its workspace, in bounded steps (see `work` below).
// - POST /api/v1/admin/accounts/:id/undo-removal (0.1.61): takes back a delete that has removed
//   nothing yet; the account stays disabled.
// The billing sweep (src/billing-sweep.ts) removes a workspace with the same steps, `work`
// and its last batch, never with a path of its own; it is reached from no route.
//
// What holds for every route here, as for the rest of the admin API (src/admin-api.ts): the
// caller is learnt from `requireAuth(..., { admin: true })` alone, and anyone but a
// signed-in site admin, on the app address, with the anti-forgery header for a change, gets
// the one 404 `not_found` and changes nothing. An account id that is malformed or names no
// account is that same 404. Every answer is `cache-control: no-store`.
import type { Hono } from "hono";
import { prepareDeletion } from "./billing.ts";
import { SWEEP_ACTOR } from "./removal-rules.ts";
import { auditStatement } from "./audit.ts";
import { requireAuth } from "./auth.ts";
import { SUBREQUEST_BUDGET, metered } from "./budget.ts";
import { apiError, json, noContent, readCapped } from "./http.ts";
import { CLAIM_LIFETIME_MS, removeClosing } from "./media.ts";
import { isNotNullViolation, type Deps, type Stmt } from "./ports.ts";
import { accountKey, pairKey, workspaceKey } from "./rate.ts";
import { clearDeletionPage, removeTourStatements } from "./tours.ts";
import { abortUpload } from "./uploads.ts";
import { usageOf } from "./usage.ts";

/** Tours one batch of a delete removes as rows (each recorded with its files, as a tour's own delete does). */
export const TOURS_PER_BATCH = 5;
/** Closing items one look of a delete finds; each is then removed in three calls. */
const ITEMS_PER_LOOK = 5;
/** The calls a delete request keeps for its end: the last batch, and the read of its progress. */
export const CALLS_AT_THE_END = 2;
/** The longest delete body read: `{"username": "<a 254-character address>"}` is well under this. */
const MAX_BODY_BYTES = 1024;

const USER_ID = /^usr_[0-9a-f]{24}$/;

const NEEDS_BODY = 'the body must be JSON such as {"username": "rook"}, with nothing else in it';

const notFound = () => json(404, { error: "not_found" });
const ownAccount = () => apiError(409, "own_account", "this is your own account; another admin must do this");
const lastAdmin = () => apiError(409, "last_admin", "this is the last active admin; the site would have no admin left");
const notDisabled = () => apiError(409, "not_disabled", "only a disabled account can be deleted; disable it first");
const deleting = () => apiError(409, "deleting", "this account is being deleted; send the delete again to finish it");
const sharedWorkspace = () => apiError(409, "shared_workspace", "the account's workspace has other members; deleting it would delete their work too");
const siteOwner = () => apiError(409, "site_owner", "this account owns the workspace the site was set up with, which cannot be deleted");
const notDeleting = () => apiError(409, "not_deleting", "no delete of this account is recorded; there is nothing to undo");
const removalStarted = () => apiError(409, "removal_started", "the delete has begun removing the account's files or rows, so it cannot be undone; send the delete again to finish it");
const wrongName = () => apiError(400, "username_mismatch", "username must be the account's username exactly, or its email address when it has no username");

/** What every route here reads of the account named: who it is and what a refusal needs. One call. */
export type Target = {
  id: string;
  username: string | null;
  email: string;
  status: "active" | "disabled";
  is_admin: number;
  workspace_id: string;
  /** 1 while a delete of it has started and not finished. */
  removing: number;
  /** The site's other active admins. */
  other_admins: number;
  /** 1 when the setup record names its workspace. */
  site_workspace: number;
  /** Its workspace's tokens that are not revoked: the computers and scripts that can publish there. */
  connections: number;
  /** 1 when another account belongs to its workspace: by a membership, or by its own row naming it (an older build's account). */
  shared: number;
};

/**
 * The condition that the workspace `ws` has no account but `uid`: no other membership, and
 * no other account whose own row names it. A delete removes the whole workspace, so it is
 * allowed only for a workspace of one account. Today every workspace has one; with teams,
 * deleting one member must not take the others' work.
 */
export const aloneIn = (ws: string, uid: string) =>
  `NOT EXISTS (SELECT 1 FROM membership om WHERE om.workspace_id = ${ws} AND om.user_id <> ${uid}) AND NOT EXISTS (SELECT 1 FROM user ou WHERE ou.workspace_id = ${ws} AND ou.id <> ${uid})`;

/**
 * The account with this id and its one workspace, or null for an id of another shape, one
 * no account has, and an account with no membership (which no list shows either).
 */
export async function readTarget(deps: Deps, id: string): Promise<Target | null> {
  if (!USER_ID.test(id)) return null;
  return deps.db.first<Target>(
    `SELECT u.id, u.username, u.email, u.status, u.is_admin, m.workspace_id,
            EXISTS (SELECT 1 FROM account_removal r WHERE r.user_id = u.id) AS removing,
            (SELECT count(*) FROM user a WHERE a.is_admin = 1 AND a.status = 'active' AND a.id <> u.id) AS other_admins,
            EXISTS (SELECT 1 FROM setup s WHERE s.workspace_id = m.workspace_id) AS site_workspace,
            (SELECT count(*) FROM api_token k WHERE k.workspace_id = m.workspace_id AND k.revoked_at IS NULL) AS connections,
            NOT (${aloneIn("m.workspace_id", "u.id")}) AS shared
       FROM user u JOIN membership m ON m.user_id = u.id
      WHERE u.id = ?`,
    [id],
  );
}

/**
 * The files a workspace holds in the two stores, counted from the rows that name them: its
 * tours' pictures, logos, replaced pictures and public pictures (live, pending or retired),
 * its unfinished uploads' pictures and logos, the files of its tours being deleted, and its
 * shared items' parts and previews. The delete's progress counts these. Nine parameters,
 * each the workspace id.
 */
export const FILES_SQL = [
  "(SELECT count(*) FROM step s JOIN tour t ON t.id = s.tour_id WHERE t.workspace_id = ?)",
  "(SELECT count(*) FROM tour t WHERE t.workspace_id = ? AND t.logo_key IS NOT NULL)",
  "(SELECT count(*) FROM replaced_object o JOIN tour t ON t.id = o.tour_id WHERE t.workspace_id = ?)",
  "(SELECT count(*) FROM snapshot_object o JOIN tour t ON t.id = o.tour_id WHERE t.workspace_id = ?)",
  "(SELECT count(*) FROM public_object o JOIN tour t ON t.id = o.tour_id WHERE t.workspace_id = ?)",
  "(SELECT count(*) FROM upload_step s JOIN upload u ON u.id = s.upload_id WHERE u.workspace_id = ? AND s.reused = 0)",
  "(SELECT count(*) FROM upload u WHERE u.workspace_id = ? AND u.logo_key IS NOT NULL)",
  "(SELECT count(*) FROM deleted_object o JOIN tour_deletion d ON d.tour_id = o.tour_id WHERE d.workspace_id = ?)",
  "(SELECT count(*) FROM media_object o JOIN media m ON m.id = o.media_id WHERE m.workspace_id = ?)",
].join(" + ");
export const filesParams = (ws: string) => Array<string>(9).fill(ws);

/** The account's id from a request that passed `requireAuth` with `admin`, which only a session does. */
function adminOf(auth: { session?: { userId: string } }): string | null {
  return auth.session?.userId ?? null;
}

/**
 * Stops every publish of the workspace that is in progress, as unpublish does: its pending
 * rows are retired, so they are recorded with the tour's other files, and its job is
 * dropped, so it can never commit. A publish request still running finds its job gone and
 * deletes the pictures it wrote itself (src/publish.ts).
 */
function stopPublishes(ws: string, now: number): Stmt[] {
  const tours = "SELECT id FROM tour WHERE workspace_id = ?";
  return [
    { sql: `UPDATE public_object SET state = 'retired', delete_after = ? WHERE state = 'pending' AND tour_id IN (${tours})`, params: [now, ws] },
    { sql: `DELETE FROM publish_job WHERE tour_id IN (${tours})`, params: [ws] },
  ];
}

/**
 * The delete's last batch: the account and every row left that belongs to it or to its
 * workspace. The first statement removes the progress row only while the account is still
 * disabled and its workspace has no tour, tour being deleted, upload or shared item left;
 * the audit row after it is the batch's guard (unless that statement removed exactly one
 * row it fails, and the whole batch is undone). Then, children before parents (foreign keys
 * never cascade): its requests to connect the app, its tokens, sessions, sign-in codes,
 * email change and rate counters, the invites to its address and its name on the invites it
 * sent, its agreements to the site's terms, its sign-in methods and membership, the account,
 * and the workspace. Everything here is named by the account's or the workspace's id, or by a
 * counter key made from them, so nothing of another workspace can be reached.
 */
async function finalStatements(deps: Deps, t: Target, adminId: string): Promise<Stmt[]> {
  const ws = t.workspace_id;
  const uid = t.id;
  // The rate counters keyed to the account: its own, its workspace's, and its own requests
  // for its address and for the address of its open email change, if any. Counters keyed to
  // an address alone are the address's, not the account's, and run out by themselves. So are
  // viewer codes and viewer sessions (migration 0015), keyed by an address and holding nothing
  // of any workspace: neither a disable nor a delete touches them, and each tour still decides
  // whom it shows by its own list.
  const found = await deps.db.first<{ new_email: string }>("SELECT new_email FROM email_change WHERE user_id = ?", [uid]);
  const newEmail = found?.new_email ?? null;
  const keys = [await accountKey(uid), await workspaceKey(ws), await pairKey(uid, t.email), ...(newEmail === null ? [] : [await pairKey(uid, newEmail)])];
  // Invites (migration 0012, which every database has once its migrations ran: both
  // targets run them before serving): one to the account's own address (none can be open
  // while the account exists, but none may outlive it) goes, and those it sent stay valid
  // with nobody named as their sender.
  const invites: Stmt[] = [
    { sql: "DELETE FROM invite WHERE email = ?", params: [t.email] },
    { sql: "UPDATE invite SET invited_by = NULL WHERE invited_by = ?", params: [uid] },
  ];
  const nothingLeft = ["tour", "tour_deletion", "upload", "media"].map((table) => `NOT EXISTS (SELECT 1 FROM ${table} WHERE workspace_id = ?)`).join(" AND ");
  return [
    {
      sql: `DELETE FROM account_removal WHERE user_id = ? AND workspace_id = ? AND ${nothingLeft} AND EXISTS (SELECT 1 FROM user WHERE id = ? AND status = 'disabled')`,
      params: [uid, ws, ws, ws, ws, ws, uid],
    },
    auditStatement(deps, { event: "account_deleted", userId: adminId, workspaceId: ws, subject: uid }, { onlyAfterOneChange: true }),
    { sql: "DELETE FROM connect_request WHERE workspace_id = ? OR confirmed_by = ?", params: [ws, uid] },
    { sql: "DELETE FROM api_token WHERE workspace_id = ?", params: [ws] },
    { sql: "DELETE FROM session WHERE user_id = ?", params: [uid] },
    { sql: "DELETE FROM signin_code WHERE user_id = ?", params: [uid] },
    { sql: "DELETE FROM email_change WHERE user_id = ?", params: [uid] },
    { sql: "DELETE FROM rate_counter WHERE key IN (SELECT value FROM json_each(?))", params: [JSON.stringify(keys)] },
    ...invites,
    // Its agreements to the site's terms (migration 0018); the versions stay, as every
    // version is kept, and so do the audit rows of the agreements, ids only.
    { sql: "DELETE FROM terms_agreement WHERE user_id = ?", params: [uid] },
    { sql: "DELETE FROM signin_method WHERE user_id = ?", params: [uid] },
    { sql: "DELETE FROM membership WHERE user_id = ? AND workspace_id = ?", params: [uid, ws] },
    { sql: "DELETE FROM user WHERE id = ? AND status = 'disabled'", params: [uid] },
    // The checkouts this site made for it (migration 0021), which name the workspace.
    { sql: "DELETE FROM stripe_checkout WHERE workspace_id = ?", params: [ws] },
    // The record of its warning mails before removal (migration 0024).
    { sql: "DELETE FROM billing_warning WHERE workspace_id = ?", params: [ws] },
    { sql: "DELETE FROM workspace WHERE id = ?", params: [ws] },
  ];
}

/**
 * One request's share of a delete, in this order, each step only once the one before it
 * has nothing left, and each only while the request has the calls for it (`room`) and for
 * its end:
 * 1. Tours, TOURS_PER_BATCH at a time, in one batch per page with stopping the workspace's
 *    publishes: each tour's rows go and every file they named is recorded under a
 *    tour_deletion row, exactly as the first call of a tour's own delete does
 *    (removeTourStatements in src/tours.ts). Two calls a page.
 * 2. The files of the workspace's tours being deleted (those of step 1, and any whose own
 *    delete was cut off), a page at a time with the tour delete's own code
 *    (clearDeletionPage): files first, then their rows, then the tour_deletion row. At most
 *    seven calls a page.
 * 3. Unfinished uploads, one at a time, with the upload abort's own code (abortUpload in
 *    src/uploads.ts): closed, its files, then its rows. At most six calls each.
 * 4. Shared items: all closed in one statement (from then on no request finds or changes
 *    them), then each removed with the item delete's own code (removeClosing in
 *    src/media.ts): its files, then its rows. An item that a send still holds a young claim
 *    on waits for it, at most CLAIM_LIFETIME_MS. Three calls each.
 * 5. The last batch (finalStatements), which takes effect only when nothing is left.
 * Every file is deleted before the row that names it, so a request cut off at any point
 * leaves every file still named by a row, and the next request deletes it again (a key
 * already gone is not an error). Until the last batch the account, its membership and its
 * workspace stay, so a delete stopped anywhere leaves an account that is still disabled,
 * still listed and can be deleted again to the end. Returns "deleted" once the last batch
 * took effect, "more" otherwise, and "undone" when the removal's record is gone (an undo):
 * then nothing was removed.
 */
export async function work(d: Deps, calls: () => number, t: Target, adminId: string): Promise<"deleted" | "more" | "undone"> {
  const ws = t.workspace_id;
  const room = (cost: number) => calls() + cost + CALLS_AT_THE_END <= SUBREQUEST_BUDGET;

  // Before anything is removed, in one guarded statement (0.1.61): the removal must still be
  // recorded, and it is marked as begun (migration 0024), from then on beyond an undo
  // (POST /api/v1/admin/accounts/:id/undo-removal). An undo that landed while the delete's
  // preparation asked Stripe took the record away: then nothing is removed ("undone").
  if (!room(1)) return "more";
  const marked = await d.db.run("UPDATE account_removal SET work_started_at = coalesce(work_started_at, ?) WHERE user_id = ? AND workspace_id = ?", [d.now(), t.id, ws]);
  if (marked.changes !== 1) return "undone";

  for (;;) {
    if (!room(2)) return "more";
    const tours = await d.db.all<{ id: string }>("SELECT id FROM tour WHERE workspace_id = ? ORDER BY id LIMIT ?", [ws, TOURS_PER_BATCH]);
    if (tours.length === 0) break;
    const now = d.now();
    await d.db.batch([...stopPublishes(ws, now), ...tours.flatMap((tour) => removeTourStatements(ws, tour.id, now))]);
  }

  for (;;) {
    if (!room(7)) return "more";
    const deletion = await d.db.first<{ tour_id: string }>("SELECT tour_id FROM tour_deletion WHERE workspace_id = ? ORDER BY tour_id LIMIT 1", [ws]);
    if (deletion === null) break;
    await clearDeletionPage(d, ws, deletion.tour_id);
  }

  for (;;) {
    if (!room(6)) return "more";
    const upload = await d.db.first<{ id: string }>("SELECT id FROM upload WHERE workspace_id = ? ORDER BY id LIMIT 1", [ws]);
    if (upload === null) break;
    await abortUpload(d, ws, upload.id);
  }

  if (!room(1)) return "more";
  await d.db.run("UPDATE media SET state = 'closing' WHERE workspace_id = ? AND state <> 'closing'", [ws]);
  for (;;) {
    if (!room(4)) return "more";
    // As the sweep does: an item a send still holds a young claim on is left for later, so it
    // cannot keep the others waiting.
    const items = await d.db.all<{ id: string }>(
      `SELECT m.id FROM media m WHERE m.workspace_id = ? AND m.state = 'closing'
          AND NOT EXISTS (SELECT 1 FROM media_object o WHERE o.media_id = m.id AND o.stored_at IS NULL AND o.claimed_at >= ?)
        ORDER BY m.id LIMIT ?`,
      [ws, d.now() - CLAIM_LIFETIME_MS, ITEMS_PER_LOOK],
    );
    if (items.length === 0) break;
    for (const item of items) {
      if (!room(3)) return "more";
      await removeClosing(d, ws, item.id);
    }
  }

  // The rate-counter keys need the open email change's address: one read, kept out of the
  // calls at the end, so it needs room of its own.
  if (!room(1)) return "more";
  try {
    await d.db.batch(await finalStatements(d, t, adminId));
  } catch (err) {
    // Something is left (an item a send still holds), or the account changed meanwhile:
    // nothing of the batch was kept, and a later request tries again.
    if (!isNotNullViolation(err)) throw err;
    return "more";
  }
  return "deleted";
}

/** The delete body: `{"username": "<text>"}` and nothing else, or null. */
async function confirmationOf(req: Request): Promise<string | null> {
  const raw = await readCapped(req, MAX_BODY_BYTES);
  if (raw === "too_large") return null;
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw));
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "username") return null;
  const value = (body as Record<string, unknown>).username;
  return typeof value === "string" ? value : null;
}

export function accountRemovalRoutes(app: Hono, deps: Deps): void {
  /**
   * Disables an account. 204 also for an account that is already disabled, which changes
   * nothing. Refused: the caller's own account (409 own_account), and the last active admin
   * (409 last_admin). One read, then one batch: the status (only while the account is
   * active, and for an admin only while another active admin remains, else the batch
   * fails), the audit row `account_disabled` as the batch's guard, every live session of
   * the account ended, its unused sign-in codes and its open email change spent. The
   * workspace's tokens are not touched: they are refused while the account is disabled and
   * work again once it is enabled.
   */
  app.post("/api/v1/admin/accounts/:id/disable", async (c) => {
    const auth = await requireAuth(c.req.raw, deps, { admin: true });
    if (auth instanceof Response) return auth;
    const adminId = adminOf(auth);
    if (adminId === null) return notFound();
    const id = c.req.param("id");
    if (!USER_ID.test(id)) return notFound();
    if (id === adminId) return ownAccount();
    const t = await readTarget(deps, id);
    if (t === null) return notFound();
    if (t.status === "disabled") return noContent();
    if (t.is_admin === 1 && t.other_admins === 0) return lastAdmin();
    const now = deps.now();
    try {
      await deps.db.batch([
        {
          sql: `UPDATE user SET status = CASE WHEN is_admin = 1 AND NOT EXISTS (SELECT 1 FROM user a WHERE a.is_admin = 1 AND a.status = 'active' AND a.id <> user.id) THEN NULL ELSE 'disabled' END
                 WHERE id = ? AND status = 'active'`,
          params: [id],
        },
        auditStatement(deps, { event: "account_disabled", userId: adminId, workspaceId: t.workspace_id, subject: id }, { onlyAfterOneChange: true }),
        { sql: "UPDATE session SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", params: [now, id] },
        { sql: "UPDATE signin_code SET used_at = ? WHERE user_id = ? AND used_at IS NULL", params: [now, id] },
        { sql: "UPDATE email_change SET used_at = ? WHERE user_id = ? AND used_at IS NULL", params: [now, id] },
      ]);
    } catch (err) {
      if (!isNotNullViolation(err)) throw err;
      // Changed since the read: disabled by another request (nothing more to do), or the
      // other active admins are gone.
      const now2 = await readTarget(deps, id);
      if (now2 === null) return notFound();
      if (now2.status === "disabled") return noContent();
      if (now2.is_admin === 1 && now2.other_admins === 0) return lastAdmin();
      throw err;
    }
    return noContent();
  });

  /**
   * Enables a disabled account again. 204 also for an account that is already active. Only
   * the status changes: its workspace's tours, pictures, items and tokens work as before,
   * and the person signs in again for the dashboard (disabling ended every session).
   * Refused: the caller's own account (409 own_account), and an account whose delete has
   * started (409 deleting), whose workspace is partly removed. One read, then one batch: the
   * status, only while disabled and not being deleted, and the audit row `account_enabled`
   * as its guard.
   */
  app.post("/api/v1/admin/accounts/:id/enable", async (c) => {
    const auth = await requireAuth(c.req.raw, deps, { admin: true });
    if (auth instanceof Response) return auth;
    const adminId = adminOf(auth);
    if (adminId === null) return notFound();
    const id = c.req.param("id");
    if (!USER_ID.test(id)) return notFound();
    if (id === adminId) return ownAccount();
    const t = await readTarget(deps, id);
    if (t === null) return notFound();
    if (t.removing === 1) return deleting();
    if (t.status === "active") return noContent();
    try {
      await deps.db.batch([
        { sql: "UPDATE user SET status = 'active' WHERE id = ? AND status = 'disabled' AND NOT EXISTS (SELECT 1 FROM account_removal r WHERE r.user_id = ?)", params: [id, id] },
        auditStatement(deps, { event: "account_enabled", userId: adminId, workspaceId: t.workspace_id, subject: id }, { onlyAfterOneChange: true }),
      ]);
    } catch (err) {
      if (!isNotNullViolation(err)) throw err;
      const now = await readTarget(deps, id);
      if (now === null) return notFound();
      if (now.removing === 1) return deleting();
      if (now.status === "active") return noContent();
      throw err;
    }
    return noContent();
  });

  /**
   * Undoes a delete that has removed nothing yet (0.1.61): an admin's delete records the removal
   * first and then asks Stripe to cancel, so a Stripe that never gives a definite answer left the
   * account disabled with a removal recorded, neither finished nor undone. 204 once the removal
   * record is gone: the account is disabled, as before the delete, and can be enabled again. Only
   * while nothing of the workspace has been removed: the record is not marked as begun (`work`
   * marks it before its first removal) and the workspace still holds every file it held when the
   * delete started. Refused: the caller's own account (409 own_account), an account with no
   * delete recorded (409 not_deleting), and a delete that has begun removing (409
   * removal_started: send the delete again to finish it). One read, then one batch: the record's
   * delete under those conditions, and the audit row `account_removal_undone` as its guard. What
   * the delete's preparation did at Stripe (a subscription cancelled, checkouts expired) is not
   * undone; it is in the audit record already.
   */
  app.post("/api/v1/admin/accounts/:id/undo-removal", async (c) => {
    const auth = await requireAuth(c.req.raw, deps, { admin: true });
    if (auth instanceof Response) return auth;
    const adminId = adminOf(auth);
    if (adminId === null) return notFound();
    const id = c.req.param("id");
    if (!USER_ID.test(id)) return notFound();
    if (id === adminId) return ownAccount();
    const t = await readTarget(deps, id);
    if (t === null) return notFound();
    if (t.removing === 0) return notDeleting();
    // A removal the billing sweep started: its warnings are cleared with it (0.1.61), so an account
    // enabled again is warned afresh before the sweep may remove it, and the audit row says so. A
    // removal the sweep STOPPED (second review N3) may be undone even after files went: nothing is
    // restored, and the answer and the audit row give how many files had been removed.
    const record = await deps.db.first<{ by_sweep: number; stopped: number; removed: number }>(
      `SELECT started_by = ? AS by_sweep, stopped_at IS NOT NULL AS stopped, max(0, total - (${FILES_SQL})) AS removed FROM account_removal WHERE user_id = ? AND workspace_id = ?`,
      [SWEEP_ACTOR, ...filesParams(t.workspace_id), id, t.workspace_id],
    );
    if (record === null) return notDeleting();
    const bySweep = record.by_sweep === 1;
    const stopped = record.stopped === 1;
    const detail = { ...(bySweep ? { by: "billing_sweep" } : {}), ...(stopped ? { files_removed: record.removed } : {}) };
    try {
      await deps.db.batch([
        stopped
          ? { sql: "DELETE FROM account_removal WHERE user_id = ? AND workspace_id = ? AND stopped_at IS NOT NULL", params: [id, t.workspace_id] }
          : {
              sql: `DELETE FROM account_removal WHERE user_id = ? AND workspace_id = ? AND work_started_at IS NULL AND total = (${FILES_SQL})`,
              params: [id, t.workspace_id, ...filesParams(t.workspace_id)],
            },
        auditStatement(deps, { event: "account_removal_undone", userId: adminId, workspaceId: t.workspace_id, subject: id, ...(Object.keys(detail).length > 0 ? { detail } : {}) }, { onlyAfterOneChange: true }),
        ...(bySweep ? [{ sql: "DELETE FROM billing_warning WHERE workspace_id = ?", params: [t.workspace_id] }] : []),
      ]);
    } catch (err) {
      if (!isNotNullViolation(err)) throw err;
      const again = await readTarget(deps, id);
      if (again === null) return notFound();
      // Undone by another request a moment before.
      if (again.removing === 0) return noContent();
      return removalStarted();
    }
    // A stopped removal undone: what was removed stays removed, which the answer says in fields.
    if (stopped) return json(200, { restored: false, files_removed: record.removed });
    return noContent();
  });

  /**
   * What deleting the account would remove, for the question the admin is asked: its
   * username, its email address (which the list of accounts shows the admin already), its
   * tours, its shared images and clips that are online, the workspace's tokens that are not
   * revoked, and the bytes it uses, counted as GET /api/v1/usage counts them. Two reads.
   */
  app.get("/api/v1/admin/accounts/:id/removal", async (c) => {
    const auth = await requireAuth(c.req.raw, deps, { admin: true });
    if (auth instanceof Response) return auth;
    const t = await readTarget(deps, c.req.param("id"));
    if (t === null) return notFound();
    const u = await usageOf(deps, t.workspace_id);
    return json(200, { username: t.username, email: t.email, tours: u.tours, items: u.images + u.gifs, connections: t.connections, used_bytes: u.used });
  });

  /**
   * Deletes a disabled account and everything of its workspace, in bounded steps (see
   * `work`). Request: DELETE with `{"username": "<the account's username>"}`, or, for an
   * account with no username, `{"username": "<its email address>"}`, exactly as stored;
   * sent again until done. Answers 202 {status: "in_progress", done, total} (files removed
   * so far, of how many the workspace held when the delete started) while anything is
   * left, and 200 {deleted: true} once the account is gone; after that the id is unknown
   * (404). Refused, before anything is changed: 400 bad_request for another body, 409
   * own_account, 409 not_disabled, 400 username_mismatch, 409 last_admin for the site's last
   * admin, 409 shared_workspace when another account belongs to its workspace, and 409
   * site_owner for the account whose workspace the setup record names. 500
   * cleanup_pending when a store or the database failed part way: nothing is lost, send it
   * again. Every request stays within SUBREQUEST_BUDGET calls, whatever the workspace holds.
   */
  app.delete("/api/v1/admin/accounts/:id", async (c) => {
    const meter = metered(deps);
    const d = meter.deps;
    const auth = await requireAuth(c.req.raw, d, { admin: true });
    if (auth instanceof Response) return auth;
    const adminId = adminOf(auth);
    if (adminId === null) return notFound();
    const id = c.req.param("id");
    if (!USER_ID.test(id)) return notFound();
    const confirmation = await confirmationOf(c.req.raw);
    if (confirmation === null) return apiError(400, "bad_request", NEEDS_BODY);
    if (id === adminId) return ownAccount();
    const t = await readTarget(d, id);
    if (t === null) return notFound();
    if (t.status !== "disabled") return notDisabled();
    if (confirmation !== (t.username ?? t.email)) return wrongName();
    if (t.is_admin === 1 && t.other_admins === 0) return lastAdmin();
    if (t.shared === 1) return sharedWorkspace();
    if (t.site_workspace === 1) return siteOwner();

    if (t.removing === 0) {
      // Recorded only while the account is still disabled and no delete of it is recorded,
      // with the workspace's file count for the progress. From then on it cannot be enabled
      // (enable refuses while this row exists), so it stays disabled until the last batch.
      const started = await d.db.run(
        `INSERT INTO account_removal (user_id, workspace_id, started_by, total, created_at)
         SELECT u.id, m.workspace_id, ?, ${FILES_SQL}, ? FROM user u JOIN membership m ON m.user_id = u.id
          WHERE u.id = ? AND m.workspace_id = ? AND u.status = 'disabled' AND NOT EXISTS (SELECT 1 FROM account_removal r WHERE r.user_id = u.id)
            AND ${aloneIn("m.workspace_id", "u.id")}`,
        [adminId, ...filesParams(t.workspace_id), d.now(), id, t.workspace_id],
      );
      if (started.changes === 0) {
        // Another delete request recorded it a moment before (go on), or the account was
        // enabled, or another account joined its workspace, since the read (then nothing may
        // be removed).
        const again = await readTarget(d, id);
        if (again === null) return notFound();
        if (again.removing === 0) return again.shared === 1 ? sharedWorkspace() : notDisabled();
      }
    }

    // Billing (src/billing.ts): with the removal recorded (so the account cannot be enabled
    // meanwhile and end up kept with its subscription cancelled), the workspace's subscription
    // is cancelled at Stripe and its open checkouts closed there, before anything of it is
    // deleted; without Stripe's definite answer nothing is. No call without billing.
    const prepared = await prepareDeletion(d, t.workspace_id, adminId, (cost) => meter.calls() + cost + CALLS_AT_THE_END <= SUBREQUEST_BUDGET);
    if (prepared === "failed") {
      return apiError(500, "cleanup_pending", "the account is being deleted, but some of its files could not be removed yet; delete it again to retry");
    }

    let outcome: "deleted" | "more" | "undone";
    try {
      outcome = prepared === "more" ? "more" : await work(d, meter.calls, t, adminId);
    } catch {
      // Fixed text only: the error could carry anything a back end put in its message.
      console.error("account delete: could not remove some of a deleted account's files or rows; the next delete call retries");
      return apiError(500, "cleanup_pending", "the account is being deleted, but some of its files could not be removed yet; delete it again to retry");
    }
    if (outcome === "deleted") return json(200, { deleted: true });
    // Undone while this request asked Stripe: nothing was removed, and nothing is recorded now.
    if (outcome === "undone") return notDeleting();
    const progress = await d.db.first<{ total: number; left: number }>(`SELECT r.total, ${FILES_SQL} AS left FROM account_removal r WHERE r.user_id = ?`, [
      ...filesParams(t.workspace_id),
      id,
    ]);
    // The record is gone only with the account: another delete request finished it meanwhile.
    if (progress === null) return notFound();
    return json(202, { status: "in_progress", done: Math.min(progress.total, Math.max(0, progress.total - progress.left)), total: progress.total });
  });
}
