import { Hono } from "hono";
import type { Deps } from "./ports.ts";
import { setupRoutes } from "./setup.ts";
import { tourRoutes } from "./tours.ts";
import { uploadRoutes } from "./uploads.ts";

/** The route table and error handling. Routes reach data only through `deps`. */
export function createApp(deps: Deps): Hono {
  const app = new Hono();

  app.get("/healthz", async (c) => {
    await deps.db.first("SELECT 1 AS ok");
    return c.json({ ok: true });
  });

  setupRoutes(app, deps);
  uploadRoutes(app, deps);
  tourRoutes(app, deps);

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  // Never echo the error: it could carry a request header or a stored value.
  app.onError((_err, c) => c.json({ error: "internal" }, 500));

  return app;
}
