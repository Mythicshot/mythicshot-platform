// The publish housekeeping that rides on ordinary requests reaches a workspace's rows
// through its tours and an index, never by scanning every workspace's public_object rows.
// Checked on the SQLite adapter, whose query planner is the one D1 runs too.
import { describe, expect, it } from "vitest";
import { makeDeps } from "#harness";
import { DROP_ABANDONED_JOBS_SQL, RETIRE_ABANDONED_SQL } from "../src/publish.ts";

async function plan(deps: Awaited<ReturnType<typeof makeDeps>>["deps"], sql: string, params: (string | number)[]): Promise<string> {
  const rows = await deps.db.all<{ detail: string }>("EXPLAIN QUERY PLAN " + sql, params);
  return rows.map((r) => r.detail).join("\n");
}

describe("the housekeeping query plans", () => {
  it("retiring abandoned pending rows searches public_object by tour through an index", async () => {
    const { deps } = await makeDeps();
    const p = await plan(deps, RETIRE_ABANDONED_SQL, [1, "ws_x", 1, 1]);
    expect(p).toMatch(/SEARCH public_object USING (COVERING )?INDEX public_object_tour_pending \(tour_id=\? AND state=\? AND created_at<\?\)/);
    expect(p).not.toMatch(/SCAN public_object\b/);
  });

  it("dropping abandoned jobs searches publish_job by tour", async () => {
    const { deps } = await makeDeps();
    const p = await plan(deps, DROP_ABANDONED_JOBS_SQL, ["ws_x", 1]);
    expect(p).not.toMatch(/SCAN publish_job\b/);
    expect(p).not.toMatch(/SCAN public_object\b/);
  });
});
