import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "../app.ts";
import type { Deps } from "../ports.ts";
import { setupCodeFromEnv } from "../setup.ts";
import { NodeDb } from "./db.ts";
import { NodeFileStore } from "./files.ts";
import { migrate } from "./migrate.ts";

// src/node/entry.ts and dist/node/entry.js both sit two folders below the repo root.
const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

async function main(): Promise<void> {
  const dataDir = process.env.DATA_DIR;
  if (!dataDir) throw new Error("DATA_DIR is not set");
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT is not a valid port");

  const root = resolve(dataDir);
  mkdirSync(root, { recursive: true });
  const db = new NodeDb(join(root, "db.sqlite"));
  await migrate(db, MIGRATIONS_DIR);

  const deps: Deps = {
    db,
    drafts: new NodeFileStore(join(root, "drafts")),
    pub: new NodeFileStore(join(root, "public")),
    config: {
      publicImageBase: process.env.PUBLIC_IMAGE_BASE ?? "",
      setupCode: setupCodeFromEnv(process.env.SETUP_CODE),
    },
    now: () => Date.now(),
  };

  const app = createApp(deps);
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`listening on port ${info.port}`);
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "startup failed");
  process.exit(1);
});
