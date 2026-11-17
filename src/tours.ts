// The workspace name, the tour list the recorder's picker shows, and draft step images.
// Every query is scoped by the workspace of the authenticated token; another
// workspace's tour or step answers 404.
import type { Hono } from "hono";
import { requireAuth } from "./auth.ts";
import { apiError, json } from "./http.ts";
import type { Deps } from "./ports.ts";

const TOUR_ID = /^tour_[0-9a-f]{24}$/;
const STEP_ID = /^st_[0-9a-f]{24}$/;

/**
 * Headers for a draft image. The type comes from the step row, which holds the type
 * sniffed from the file's own bytes at upload; the stored object's metadata and the
 * uploader's Content-Type are never used. Nothing may cache it but the browser that
 * asked, and only for this response.
 */
function draftImageHeaders(type: "png" | "jpg", size: number): Record<string, string> {
  return {
    "content-type": type === "png" ? "image/png" : "image/jpeg",
    "content-length": String(size),
    "content-disposition": `inline; filename="step.${type}"`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "referrer-policy": "no-referrer",
  };
}

export function tourRoutes(app: Hono, deps: Deps): void {
  app.get("/api/v1/me", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    const row = await deps.db.first<{ name: string }>("SELECT name FROM workspace WHERE id = ?", [auth.workspaceId]);
    if (row === null) return apiError(404, "not_found", "no such workspace");
    return json(200, { workspace: row.name });
  });

  app.get("/api/v1/tours", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    const tours = await deps.db.all<{ id: string; title: string; status: string; chapters: number; steps: number; updated_at: number }>(
      `SELECT t.id, t.title, t.status,
              (SELECT count(*) FROM chapter c WHERE c.tour_id = t.id) AS chapters,
              (SELECT count(*) FROM step s WHERE s.tour_id = t.id) AS steps,
              t.updated_at
         FROM tour t WHERE t.workspace_id = ? ORDER BY t.updated_at DESC, t.id`,
      [auth.workspaceId],
    );
    return json(200, { tours });
  });

  app.get("/api/v1/tours/:id/steps/:step_id/image", async (c) => {
    const auth = await requireAuth(c.req.raw, deps);
    if (auth instanceof Response) return auth;
    const tourId = c.req.param("id");
    const stepId = c.req.param("step_id");
    if (!TOUR_ID.test(tourId) || !STEP_ID.test(stepId)) return apiError(404, "not_found", "no such step");
    const step = await deps.db.first<{ image_key: string; image_type: "png" | "jpg" }>(
      "SELECT s.image_key, s.image_type FROM step s JOIN tour t ON t.id = s.tour_id WHERE s.id = ? AND s.tour_id = ? AND t.workspace_id = ?",
      [stepId, tourId, auth.workspaceId],
    );
    if (step === null) return apiError(404, "not_found", "no such step");
    const file = await deps.drafts.get(step.image_key);
    if (file === null) return apiError(404, "not_found", "no such step");
    return new Response(file.body, { status: 200, headers: draftImageHeaders(step.image_type, file.size) });
  });
}
