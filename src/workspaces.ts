import { hashToken, newId, newToken } from "./auth.ts";
import type { Deps, Stmt } from "./ports.ts";

/** The name given to a workspace's first token. */
const FIRST_TOKEN_NAME = "First token";

/**
 * The statements that create a workspace, its owner and one API token, for a caller
 * that runs them in its own batch together with statements of its own (the setup
 * claim). Nothing is written until that batch runs. The returned token is shown to
 * the caller once and never stored; only its hash is in the statements. The email is
 * stored lowercased, which makes the unique email constraint case-insensitive.
 */
export async function workspaceStatements(
  deps: Deps,
  name: string,
  email: string,
): Promise<{ workspaceId: string; token: string; stmts: Stmt[] }> {
  const workspaceId = newId("ws");
  const token = newToken();
  const hash = await hashToken(token);
  const now = deps.now();
  const stmts: Stmt[] = [
    { sql: "INSERT INTO workspace (id, name, created_at) VALUES (?, ?, ?)", params: [workspaceId, name, now] },
    {
      sql: "INSERT INTO user (id, workspace_id, email, created_at) VALUES (?, ?, ?, ?)",
      params: [newId("usr"), workspaceId, email.toLowerCase(), now],
    },
    {
      sql: "INSERT INTO api_token (id, workspace_id, name, hash, created_at) VALUES (?, ?, ?, ?, ?)",
      params: [newId("tok"), workspaceId, FIRST_TOKEN_NAME, hash, now],
    },
  ];
  return { workspaceId, token, stmts };
}

/** One batch: a workspace, its owner and one token. Returns the token, which is not stored. */
export async function createWorkspace(
  deps: Deps,
  name: string,
  email: string,
): Promise<{ workspaceId: string; token: string }> {
  const { workspaceId, token, stmts } = await workspaceStatements(deps, name, email);
  await deps.db.batch(stmts);
  return { workspaceId, token };
}
