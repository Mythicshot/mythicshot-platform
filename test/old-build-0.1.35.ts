// What the build before tours could be restricted (0.1.35, commit a0a2370) serves of a tour,
// with that build's own lookups, vendored here word for word so a test can run them against a
// database this build wrote: the one statement of the tour page (PAGE_SQL in src/page.ts, with
// the disabled-account condition of src/accounts.ts as it wrote it) and of the picture route
// (the lookup in GET /p/:name of src/publish.ts). The page then parses the row with
// `pageTour`, which this build has not changed since then (only comments and PAGE_SQL differ
// in src/page.ts), and answers 404 for anything it refuses. Going back to 0.1.35 on a database
// where a tour is restricted must find nothing of that tour to serve.
import { pageTour } from "../src/page.ts";
import type { Deps } from "../src/ports.ts";

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
