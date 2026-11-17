import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "../app.ts";
import type { Deps } from "../ports.ts";
import { setupCodeFromEnv } from "../setup.ts";
import { APP_UID, prepareDataDir } from "./datadir.ts";
import { NodeDb } from "./db.ts";
import { NodeFileStore } from "./files.ts";
import { migrate } from "./migrate.ts";

// src/node/entry.ts and dist/node/entry.js both sit two folders below the repo root.
const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

/** How long open requests may run after SIGTERM before their connections are cut. */
const STOP_GRACE_MS = 5000;

async function main(): Promise<void> {
  // Everything the app creates (the database, its WAL, draft and published files) is
  // readable by the app user only. Set before any file is opened.
  process.umask(0o077);
  const dataDir = process.env.DATA_DIR;
  if (!dataDir) throw new Error("DATA_DIR is not set");
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT is not a valid port");

  const root = prepareDataDir(dataDir);
  const dbPath = join(root, "db.sqlite");
  let db: NodeDb;
  try {
    db = new NodeDb(dbPath);
  } catch {
    const uid = typeof process.getuid === "function" ? process.getuid() : APP_UID;
    throw new Error(`cannot open ${dbPath}: it and its folder must be writable by uid ${uid}`);
  }
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
  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`listening on port ${info.port}`);
  });

  // `docker stop` sends SIGTERM, and Node running as PID 1 has no default handler for
  // it. Stop taking requests, let open ones finish, then close the database so SQLite
  // checkpoints its WAL into db.sqlite and the file is whole on the volume. If requests
  // are still open after the grace period they are cut, before Docker's own 10 s kill.
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, stopping`);
    const finish = () => {
      db.close();
      console.log("stopped");
      process.exit(0);
    };
    server.close(finish);
    if ("closeIdleConnections" in server) server.closeIdleConnections();
    setTimeout(() => {
      if ("closeAllConnections" in server) server.closeAllConnections();
    }, STOP_GRACE_MS).unref();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "startup failed");
  process.exit(1);
});
