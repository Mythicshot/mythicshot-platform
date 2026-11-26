// The admin API: the site's storage in all, how each account uses its storage, and the allowance of one workspace.
// No platform API.
//
// The site's admin needs an overview of how every account's storage allowance is used,
// and must not be able to open any account's links or content. So these routes are the one
// place a caller sees beyond its own workspace. The summary answers three numbers: the
// number of accounts, the bytes all workspaces use together and the site's standard
// allowance. The list answers only this, per account: its
// id, username, email, status, whether it is the admin, when it was made, whether its delete
// has started, its workspace's id and name (the admin page's Workspace column), its tour count, the bytes it uses with the breakdown GET /api/v1/usage gives the
// account itself (the shared images' and GIFs' bytes as two totals), and its allowance (the workspace's own number or null for the site's,
// and the number in force), and its newest agreement to the site's terms (the version's label and the time, or null). Never a tour's id, title, slug or link, a chapter or step, a
// picture's address or file name, a shared item's id, title or link, a token, a session, or anything a tour's address could
// be built from; and the one change they take is a number.
//
// What holds for every route here:
// - The caller is learnt from `requireAuth(..., { admin: true })` alone: only the session
//   of a site admin passes. A member's session, any token (the admin's own workspace's
//   too), no credential, a session on the tours address, a token sent with a cookie, and a
//   change without the anti-forgery header or from another origin all get the one 404
//   `not_found`, with the same status, headers and body, and nothing is changed.
// - Each answers on the app address only (in one-address mode, on the one address): the
//   host gate keeps them there, and a session counts nowhere else.
// - Every answer is `cache-control: no-store`.
// - The numbers are read with the SQL of the account's own usage answer (USAGE_COLUMNS
//   and usageFromRow in src/usage.ts), so the two can never disagree.
import type { Hono } from "hono";
import { billingProblems, priceCheckOf } from "./billing.ts";
import { billingConfigured } from "./billing-rules.ts";
import { auditStatement } from "./audit.ts";
import { requireAuth } from "./auth.ts";
import { apiError, json, readCapped } from "./http.ts";
import { isNotNullViolation, type Deps } from "./ports.ts";
import { isBeforeTerms } from "./sessions.ts";
import { storageMailSoon } from "./storage-alert.ts";
import { allowanceSqlFor, USAGE_COLUMNS, usageFromRow, usageOf, type Usage } from "./usage.ts";

/** The most accounts one page of the list holds. */
export const ADMIN_PAGE = 100;

/** The largest allowance there is: the largest whole number a JSON number keeps exactly. */
export const MAX_ALLOWANCE_BYTES = Number.MAX_SAFE_INTEGER;

/** The longest body a change reads: `{"storage_allowance_bytes": 9007199254740991}` is 46 bytes. */
const MAX_BODY_BYTES = 1024;

/** How often a change is tried when another change of the same workspace lands between its read and its write. */
const SET_TRIES = 3;

/**
 * The list's cursor: the creation time and the id of the last account of a page, as
 * base64url text, so the next page starts after those values whether or not that account
 * still exists (it may have been deleted since, src/account-removal.ts). Opaque to a client.
 */
export function encodeAccountCursor(createdAt: number, id: string): string {
  return btoa(`${createdAt}.${id}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The time and id of a cursor encodeAccountCursor made, or null for anything else (an account id alone, as before 0.1.33, included). */
export function decodeAccountCursor(cursor: string): { createdAt: number; id: string } | null {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(cursor)) return null;
  let text: string;
  try {
    text = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
  const m = /^(0|[1-9][0-9]{0,15})\.(usr_[0-9a-f]{24})$/.exec(text);
  if (m === null || !Number.isSafeInteger(Number(m[1]))) return null;
  return { createdAt: Number(m[1]), id: m[2] };
}
const WORKSPACE_ID = /^ws_[0-9a-f]{24}$/;

const NEEDS_BODY = 'the body must be JSON such as {"storage_allowance_bytes": 1073741824}, with nothing else in it';
const BAD_ALLOWANCE = "storage_allowance_bytes must be a whole number of bytes from 0 to 9007199254740991, or null for the site's default";

/** What an admin route answers to an unknown or malformed workspace id: the 404 every refusal here is, so it tells nothing more. */
function notFound(): Response {
  return json(404, { error: "not_found" });
}

/**
 * The account's newest agreement to the site's terms (src/terms.ts), as columns of the list's
 * one read: the version's label and when it was agreed to, both null for "Not yet", and whether
 * the account has agreed to the current version (1) or only to older ones (0).
 * Both pick the same row: by the time, then by the version's order. Only the label and the
 * time: never the terms' text, never anything of how the account agreed.
 */
const NEWEST_AGREEMENT_COLUMNS = `(SELECT t.version_label FROM terms_agreement a JOIN terms_version t ON t.id = a.terms_id WHERE a.user_id = p.id ORDER BY a.agreed_at DESC, t.seq DESC LIMIT 1) AS terms_version,
              (SELECT a.agreed_at FROM terms_agreement a JOIN terms_version t ON t.id = a.terms_id WHERE a.user_id = p.id ORDER BY a.agreed_at DESC, t.seq DESC LIMIT 1) AS terms_agreed_at,
              EXISTS (SELECT 1 FROM terms_agreement a WHERE a.user_id = p.id AND a.terms_id = (SELECT id FROM terms_version ORDER BY seq DESC LIMIT 1)) AS terms_current`;

/** The numbers of one workspace, in the shape GET /api/v1/usage gives them. */
function numbers(u: Usage) {
  return { tours: u.tours, used_bytes: u.used, allowance_bytes: u.allowance, over: u.over, counted: { pictures: u.pictures, logos: u.logos, uploads_in_progress: u.uploads, images: u.imageBytes, gifs: u.gifBytes } };
}

/**
 * The allowance a change asks for: a whole number of bytes from 0 to MAX_ALLOWANCE_BYTES,
 * or null for the site's own number. Anything else is undefined: a negative number, a
 * fraction, a number past that range (which JSON cannot carry exactly), text, true or
 * false, a list, an object, or no value at all.
 */
function allowanceOf(v: unknown): number | null | undefined {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > MAX_ALLOWANCE_BYTES) return undefined;
  // -0 is 0.
  return v + 0;
}

export function adminRoutes(app: Hono, deps: Deps): void {
  /**
   * The summary line of the admin's page: how many accounts there are, the bytes every
   * workspace uses in all (each counted with the account's own usage SQL, USAGE_COLUMNS, so
   * the sum is the sum of the list's used_bytes), and the site's standard allowance from
   * its settings, null when none is set. Three numbers, nothing of any workspace. One
   * statement, whatever the number of accounts. It only reads.
   */
  app.get("/api/v1/admin/summary", async (c) => {
    const auth = await requireAuth(c.req.raw, deps, { admin: true });
    if (auth instanceof Response) return auth;
    const row = await deps.db.first<{ accounts: number; used: number }>(
      `SELECT (SELECT count(*) FROM user) AS accounts,
              (SELECT coalesce(sum(w.pictures + w.logos + w.uploads + w.image_bytes + w.gif_bytes), 0) FROM (SELECT ${USAGE_COLUMNS} FROM (SELECT id AS ws FROM workspace) p) w) AS used`,
    );
    // On a site with billing: the billing problems for the admin to look at (a paid checkout no
    // workspace stored, a second paid subscription of one workspace), as the audit has them.
    const billing = billingConfigured(deps.config) ? { billing_problems: await billingProblems(deps), billing_price: priceCheckOf(deps.config) } : {};
    return json(200, { accounts: row?.accounts ?? 0, used_bytes: row?.used ?? 0, standard_allowance_bytes: deps.config.storageAllowanceBytes ?? null, ...billing });
  });

  /**
   * Every account, in the order they were made, ADMIN_PAGE at a time: who it is, its
   * workspace's id and name, its tour count, its usage and its allowance. `?after=<cursor>`
   * starts after the account the cursor was made from (encodeAccountCursor), by its creation
   * time and id, so an account deleted since does not cut the list short; `next` is the
   * cursor for the page after this one, or null when there is none. Anything that is not
   * such a cursor is refused with 400 bad_cursor. It only reads.
   */
  app.get("/api/v1/admin/accounts", async (c) => {
    const auth = await requireAuth(c.req.raw, deps, { admin: true });
    if (auth instanceof Response) return auth;
    const afterText = c.req.query("after") ?? null;
    const after = afterText === null ? null : decodeAccountCursor(afterText);
    if (afterText !== null && after === null) return apiError(400, "bad_cursor", "after must be the cursor next gave; start again without it");

    type Row = {
      id: string;
      username: string | null;
      email: string;
      status: string;
      is_admin: number;
      created_at: number;
      deleting: number;
      workspace_id: string;
      workspace_name: string;
      own: number | null;
      allowance: number | null;
      pictures: number;
      logos: number;
      uploads: number;
      image_bytes: number;
      gif_bytes: number;
      tours: number;
      images: number;
      gifs: number;
      terms_version: string | null;
      terms_agreed_at: number | null;
      terms_current: number | null;
    };
    // One read. The page of accounts is chosen first, one more than a page to tell whether
    // another follows; then each account's numbers, with the account's own usage SQL, over
    // its workspace (its one membership) as p.ws. An account belongs to a workspace by its
    // membership only, as everywhere else; every account has one (the migration and the
    // start of the server give it one).
    //
    // The page starts after the cursor's own (created_at, id) values, never by looking its
    // account up, so a cursor whose account was deleted since still gives the rest.
    const list = (agreements: string) =>
      deps.db.all<Row>(
      `SELECT p.id, p.username, p.email, p.status, p.is_admin, p.created_at, p.deleting, p.ws AS workspace_id, p.ws_name AS workspace_name, p.own, p.allowance, ${USAGE_COLUMNS}, ${agreements}
         FROM (SELECT u.id, u.username, u.email, u.status, u.is_admin, u.created_at, m.workspace_id AS ws, workspace.name AS ws_name,
                      EXISTS (SELECT 1 FROM account_removal r WHERE r.user_id = u.id) AS deleting,
                      workspace.storage_allowance_bytes AS own, ${allowanceSqlFor(deps)} AS allowance
                 FROM user u
                 JOIN membership m ON m.user_id = u.id
                 JOIN workspace ON workspace.id = m.workspace_id
                WHERE ? IS NULL OR (u.created_at, u.id) > (?, ?)
                ORDER BY u.created_at, u.id
                LIMIT ?) p
        ORDER BY p.created_at, p.id`,
      // In the order the placeholders stand in the text: the site's default, the cursor (whether there is one, its time, its id), the page.
      [deps.config.storageAllowanceBytes ?? null, after === null ? null : 1, after?.createdAt ?? null, after?.id ?? null, ADMIN_PAGE + 1],
    );
    let rows: Row[];
    try {
      rows = await list(NEWEST_AGREEMENT_COLUMNS);
    } catch (err) {
      // A database before the terms migration (0018) has no agreement: every account is "Not yet".
      if (!isBeforeTerms(err)) throw err;
      rows = await list("NULL AS terms_version, NULL AS terms_agreed_at, NULL AS terms_current");
    }
    // The site's current terms (the newest version), or null for a site that has published none.
    let current: { version_label: string } | null = null;
    try {
      current = await deps.db.first<{ version_label: string }>("SELECT version_label FROM terms_version ORDER BY seq DESC LIMIT 1");
    } catch (err) {
      if (!isBeforeTerms(err)) throw err;
    }
    const page = rows.slice(0, ADMIN_PAGE);
    const accounts = page.map((r) => ({
      id: r.id,
      username: r.username,
      email: r.email,
      status: r.status,
      admin: r.is_admin === 1,
      created_at: r.created_at,
      deleting: r.deleting === 1,
      workspace_id: r.workspace_id,
      workspace_name: r.workspace_name,
      ...numbers(usageFromRow(r)),
      storage_allowance_bytes: r.own,
      terms: r.terms_version === null || r.terms_agreed_at === null ? null : { version: r.terms_version, agreed_at: r.terms_agreed_at, current: r.terms_current === 1 },
    }));
    const last = page[page.length - 1];
    return json(200, { accounts, next: rows.length > ADMIN_PAGE ? encodeAccountCursor(last.created_at, last.id) : null, current_terms: current === null ? null : { version: current.version_label } });
  });

  /**
   * Sets one workspace's allowance: `{"storage_allowance_bytes": <whole number of bytes>}`,
   * or null to go back to the site's own number. The workspace is named by its id. The
   * change and its audit row (`allowance_set`, with the old and the new number) are one
   * batch. An allowance below what the workspace already uses is taken: nothing is deleted
   * or unpublished, and only an upload that needs more room is refused from then on.
   * Answers the workspace's numbers after the change.
   */
  app.patch("/api/v1/admin/workspaces/:id", async (c) => {
    const auth = await requireAuth(c.req.raw, deps, { admin: true });
    if (auth instanceof Response) return auth;
    // requireAuth with admin passes only a session; without one there is nobody to record.
    if (auth.session === undefined) return notFound();
    const adminId = auth.session.userId;

    const raw = await readCapped(c.req.raw, MAX_BODY_BYTES);
    if (raw === "too_large") return apiError(400, "bad_request", NEEDS_BODY);
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw));
    } catch {
      return apiError(400, "bad_request", NEEDS_BODY);
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) return apiError(400, "bad_request", NEEDS_BODY);
    // The one field and nothing else: this route takes no other value of any kind.
    if (Object.keys(body).some((k) => k !== "storage_allowance_bytes")) return apiError(400, "bad_request", NEEDS_BODY);
    const wanted = allowanceOf((body as Record<string, unknown>).storage_allowance_bytes);
    if (wanted === undefined) return apiError(400, "bad_allowance", BAD_ALLOWANCE);

    const id = c.req.param("id");
    if (!WORKSPACE_ID.test(id)) return notFound();

    // A workspace deleted between the read below and the batch (src/account-removal.ts) is
    // not updated, and then the audit row, which guards the batch, fails it too: the next
    // try reads no workspace and answers 404, so no change that never happened is recorded.
    for (let attempt = 1; ; attempt++) {
      const found = await deps.db.first<{ own: number | null }>("SELECT storage_allowance_bytes AS own FROM workspace WHERE id = ?", [id]);
      if (found === null) return notFound();
      const old = found.own;
      try {
        // The write takes effect only while the workspace still has the number just read,
        // so the audit row's old number is the one replaced. Otherwise the name is set to
        // null, which the database refuses, and the whole batch, audit row too, is undone
        // and read again.
        await deps.db.batch([
          {
            sql: "UPDATE workspace SET storage_allowance_bytes = ?, name = CASE WHEN storage_allowance_bytes IS ? THEN name ELSE NULL END WHERE id = ?",
            params: [wanted, old, id],
          },
          auditStatement(deps, { event: "allowance_set", userId: adminId, workspaceId: id, subject: id, detail: { old_bytes: old, new_bytes: wanted } }, { onlyAfterOneChange: true }),
        ]);
        break;
      } catch (err) {
        if (!isNotNullViolation(err) || attempt >= SET_TRIES) throw err;
      }
    }

    const u = await usageOf(deps, id);
    // A new allowance can cross a line of the low storage mail either way: that workspace's own
    // account is mailed, or its mails armed again, after the answer.
    storageMailSoon(deps, id);
    return json(200, { workspace_id: id, allowance_bytes: u.allowance, storage_allowance_bytes: wanted, used_bytes: u.used, over: u.over });
  });
}
