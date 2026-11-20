import { Hono } from "hono";
import { adminRoutes } from "./admin-api.ts";
import { dashRoutes } from "./dash/routes.ts";
import { docsRoutes } from "./docs/page.ts";
import { emailChangeRoutes } from "./email-change.ts";
import { hostGate } from "./host-gate.ts";
import { requestHost, roleOf } from "./hosts.ts";
import { mediaRoutes } from "./media.ts";
import type { Deps } from "./ports.ts";
import { pageRoutes } from "./page.ts";
import { pageRoutesForAccounts } from "./pages.ts";
import { publishRoutes } from "./publish.ts";
import { setupRoutes } from "./setup.ts";
import { signinRoutes } from "./signin.ts";
import { tourRoutes } from "./tours.ts";
import { uploadRoutes } from "./uploads.ts";
import { usageRoutes } from "./usage.ts";

/** The route table and error handling. Routes reach data only through `deps`. */
export function createApp(deps: Deps): Hono {
  const app = new Hono();
  // First, so that in two-address mode nothing runs before the host is known.
  app.use("*", hostGate(deps.config));

  // Answers on any host. To a configured address it also reports the role the app sees
  // it in, which is how an install checks that each address reaches it under its own name.
  app.get("/healthz", async (c) => {
    await deps.db.first("SELECT 1 AS ok");
    const hosts = deps.config.hosts ?? null;
    const address = hosts === null ? null : roleOf(hosts, requestHost(c.req.raw));
    return c.json(address === null ? { ok: true } : { ok: true, address });
  });

  setupRoutes(app, deps);
  docsRoutes(app, deps);
  uploadRoutes(app, deps);
  mediaRoutes(app, deps);
  tourRoutes(app, deps);
  usageRoutes(app, deps);
  signinRoutes(app, deps);
  emailChangeRoutes(app, deps);
  adminRoutes(app, deps);
  pageRoutesForAccounts(app, deps);
  dashRoutes(app);
  publishRoutes(app, deps);
  pageRoutes(app, deps);

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  // Never echo the error: it could carry a request header or a stored value.
  app.onError((_err, c) => c.json({ error: "internal" }, 500));

  return app;
}
