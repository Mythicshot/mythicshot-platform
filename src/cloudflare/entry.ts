import { createApp } from "../app.ts";
import { withBudget } from "../budget.ts";
import type { Deps } from "../ports.ts";
import { setupCodeFromEnv } from "../setup.ts";
import { D1Db } from "./db.ts";
import { R2FileStore } from "./files.ts";

/** SETUP_CODE is a Worker secret, so `wrangler types` does not list it. */
type WorkerEnv = Env & { SETUP_CODE?: string };

export function depsFromEnv(env: WorkerEnv): Deps {
  return {
    db: new D1Db(env.DB),
    drafts: new R2FileStore(env.DRAFTS),
    pub: new R2FileStore(env.PUB),
    config: {
      // Empty by default: the app serves published images on /p/<name> through the PUB
      // binding. When set, the public bucket serves them itself on its own custom domain,
      // so the app cannot add headers to them, and that domain MUST carry a response-header
      // rule adding `X-Content-Type-Options: nosniff` and
      // `Content-Security-Policy: default-src 'none'; sandbox` (see wrangler.jsonc).
      publicImageBase: env.PUBLIC_IMAGE_BASE ?? "",
      setupCode: setupCodeFromEnv(env.SETUP_CODE),
    },
    now: () => Date.now(),
  };
}

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Response | Promise<Response> {
    // Each request gets its own metered ports, so one that goes over the call budget is logged.
    return withBudget(depsFromEnv(env), request.method, async (deps) => createApp(deps).fetch(request, env, ctx));
  },
} satisfies ExportedHandler<WorkerEnv>;
