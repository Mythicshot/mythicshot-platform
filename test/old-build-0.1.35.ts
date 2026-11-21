// What the build before tours could be restricted (0.1.35, commit a0a2370) serves of a tour,
// with that build's own lookups, vendored here word for word so a test can run them against a
// database this build wrote: the one statement of the tour page (PAGE_SQL in src/page.ts, with
// the disabled-account condition of src/accounts.ts as it wrote it) and of the picture route
// (the lookup in GET /p/:name of src/publish.ts). The page then parses the row with
// `pageTour`, which this build has not changed since then (only comments and PAGE_SQL differ
// in src/page.ts), and answers 404 for anything it refuses. Going back to 0.1.35 on a database
// where a tour is restricted must find nothing of that tour to serve.
import { pageTour } from "../src/page.ts";
import type { Deps, Stmt } from "../src/ports.ts";

const NO_DISABLED_ACCOUNT_0_1_35 =
  "NOT EXISTS (SELECT 1 FROM user du WHERE du.workspace_id = t.workspace_id AND du.status = 'disabled')" +
  " AND NOT EXISTS (SELECT 1 FROM membership dm JOIN user du ON du.id = dm.user_id WHERE dm.workspace_id = t.workspace_id AND du.status = 'disabled')";
const PAGE_SQL_0_1_35 = `SELECT s.data FROM snapshot s JOIN tour t ON t.id = s.tour_id WHERE t.slug = ? AND t.status = 'published' AND ${NO_DISABLED_ACCOUNT_0_1_35}`;
const PICTURE_SQL_0_1_35 = `SELECT 1 AS x FROM snapshot_object o JOIN tour t ON t.id = o.tour_id WHERE o.image_key = ? AND ${NO_DISABLED_ACCOUNT_0_1_35}
         UNION ALL SELECT 1 AS x FROM public_object o JOIN tour t ON t.id = o.tour_id
                    WHERE o.image_key = ? AND o.state = 'retired' AND o.delete_after > ? AND ${NO_DISABLED_ACCOUNT_0_1_35} LIMIT 1`;
const SLUG = /^[a-z2-7]{10}$/;
const PUBLIC_NAME = /^[0-9a-f]{32}\.(png|jpg)$/;

/** The tour 0.1.35 would put on the page at /t/<slug>, or null for its 404. */
export async function oldPage(deps: Deps, slug: string): Promise<unknown> {
  const row = await deps.db.first<{ data: string }>(PAGE_SQL_0_1_35, [SLUG.test(slug) ? slug : ""]);
  if (row === null) return null;
  try {
    return pageTour(JSON.parse(row.data));
  } catch {
    return null; // a malformed snapshot: the same 404
  }
}

/** Whether 0.1.35 would serve the picture at /p/<name> (`key` is the stored key, as in rows). */
export async function oldPicture(deps: Deps, key: string): Promise<boolean> {
  const name = key.startsWith("p/") ? key.slice(2) : key;
  if (!PUBLIC_NAME.test(name)) return false;
  const live = await deps.db.first(PICTURE_SQL_0_1_35, ["p/" + name, "p/" + name, deps.now()]);
  if (live === null) return false;
  const file = await deps.pub.get("p/" + name);
  if (file === null) return false;
  await file.body.cancel();
  return true;
}

/**
 * The commit batch of 0.1.35's publish (commitStatements in src/publish.ts at a0a2370), word
 * for word: what that build runs once the pictures of a publish are copied. On a tour this
 * build restricted it must fail as a whole (the triggers of migration 0014).
 */
export function oldCommitStatements(workspaceId: string, tourId: string, publishId: string, justCopied: string[], now: number, graceMs: number): Stmt[] {
  const keyList = (keys: string[]) => JSON.stringify(keys);
  return [
    {
      sql: `INSERT INTO snapshot (tour_id, data, published_at, publish_id, steps, draft_version)
            VALUES (?, (SELECT j.data FROM publish_job j
                         WHERE j.publish_id = ? AND j.tour_id = ?
                           AND (SELECT count(*) FROM public_object o
                                 WHERE o.publish_id = ? AND o.state = 'pending' AND o.tour_id = ?
                                   AND (o.copied = 1 OR o.image_key IN (SELECT value FROM json_each(?)))) = j.total
                           AND EXISTS (SELECT 1 FROM tour WHERE id = ? AND workspace_id = ?)),
                    ?, ?, (SELECT steps FROM publish_job WHERE publish_id = ?), (SELECT draft_version FROM publish_job WHERE publish_id = ?))
            ON CONFLICT (tour_id) DO UPDATE SET data = excluded.data, published_at = excluded.published_at, publish_id = excluded.publish_id, steps = excluded.steps,
                                                draft_version = excluded.draft_version`,
      params: [tourId, publishId, tourId, publishId, tourId, keyList(justCopied), tourId, workspaceId, now, publishId, publishId, publishId],
    },
    {
      sql: "INSERT INTO public_object (image_key, tour_id, publish_id, state, created_at, delete_after) SELECT image_key, tour_id, ?, 'retired', ?, ? FROM snapshot_object WHERE tour_id = ?",
      params: [publishId, now, now + graceMs, tourId],
    },
    { sql: "DELETE FROM snapshot_object WHERE tour_id = ?", params: [tourId] },
    {
      sql: "INSERT INTO snapshot_object (tour_id, image_key) SELECT tour_id, image_key FROM public_object WHERE publish_id = ? AND state = 'pending' AND tour_id = ?",
      params: [publishId, tourId],
    },
    { sql: "DELETE FROM public_object WHERE publish_id = ? AND state = 'pending'", params: [publishId] },
    { sql: "DELETE FROM publish_job WHERE publish_id = ?", params: [publishId] },
    { sql: "UPDATE tour SET status = 'published', published_at = ? WHERE id = ? AND workspace_id = ?", params: [now, tourId, workspaceId] },
  ];
}
