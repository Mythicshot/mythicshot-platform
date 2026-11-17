import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeDb } from "../src/node/db.ts";
import { NodeFileStore } from "../src/node/files.ts";
import { migrate } from "../src/node/migrate.ts";
import type { Config, Deps } from "../src/ports.ts";
import { createWorkspace } from "../src/workspaces.ts";
import { counted } from "./counting.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

/** A fresh database file and two empty folders in a new temporary directory. */
export async function makeDeps(config?: Partial<Config>) {
  const root = await mkdtemp(join(tmpdir(), "demo-platform-test-"));
  const db = new NodeDb(join(root, "db.sqlite"));
  await migrate(db, MIGRATIONS_DIR);
  const drafts = new NodeFileStore(join(root, "drafts"));
  const pub = new NodeFileStore(join(root, "public"));
  const c = counted(db, drafts, pub);
  const deps: Deps = {
    db: c.db,
    drafts: c.drafts,
    pub: c.pub,
    config: { publicImageBase: "", setupCode: null, ...config },
    now: () => Date.now(),
  };
  return {
    deps,
    draftKeys: () => drafts.keys(),
    publicKeys: () => pub.keys(),
    calls: c.calls,
  };
}

/** A workspace with its owner and one token, made through createWorkspace. */
export async function seedWorkspace(deps: Deps, name: string): Promise<{ workspaceId: string; token: string }> {
  return createWorkspace(deps, name, "owner@example.com");
}
