import { createApp } from "../app.ts";
import type { Deps } from "../ports.ts";
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
      publicImageBase: env.PUBLIC_IMAGE_BASE ?? "",
      setupCode: env.SETUP_CODE ? env.SETUP_CODE : null,
    },
    now: () => Date.now(),
  };
}

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Response | Promise<Response> {
    return createApp(depsFromEnv(env)).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<WorkerEnv>;
