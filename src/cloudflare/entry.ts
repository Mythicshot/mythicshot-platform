import { createApp } from "../app.ts";
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
      // The public bucket serves these images itself, so the app cannot add headers to
      // them. Its custom domain MUST carry a response-header rule adding
      // `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`
      // (see the note in wrangler.jsonc); the Cloudflare runbook and deploy task set it up.
      publicImageBase: env.PUBLIC_IMAGE_BASE ?? "",
      setupCode: setupCodeFromEnv(env.SETUP_CODE),
    },
    now: () => Date.now(),
  };
}

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Response | Promise<Response> {
    return createApp(depsFromEnv(env)).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<WorkerEnv>;
