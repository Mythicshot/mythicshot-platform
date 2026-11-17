import { hashToken, newId, newToken } from "./auth.ts";
import type { Deps } from "./ports.ts";

/** The name given to a workspace's first token. */
const FIRST_TOKEN_NAME = "First token";

/**
 * One batch: a workspace, its owner and one API token. Returns the token, which is
 * shown to the caller once and never stored; only its hash is written.
 */
export async function createWorkspace(
  deps: Deps,
  name: string,
  email: string,
): Promise<{ workspaceId: string; token: string }> {
  const workspaceId = newId("ws");
  const token = newToken();
  const hash = await hashToken(token);
  const now = deps.now();
  await deps.db.batch([
    { sql: "INSERT INTO workspace (id, name, created_at) VALUES (?, ?, ?)", params: [workspaceId, name, now] },
    {
      sql: "INSERT INTO user (id, workspace_id, email, created_at) VALUES (?, ?, ?, ?)",
      params: [newId("usr"), workspaceId, email, now],
    },
    {
      sql: "INSERT INTO api_token (id, workspace_id, name, hash, created_at) VALUES (?, ?, ?, ?, ?)",
      params: [newId("tok"), workspaceId, FIRST_TOKEN_NAME, hash, now],
    },
  ]);
  return { workspaceId, token };
}
