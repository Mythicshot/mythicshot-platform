import { newWorkspaceStatement } from "./billing-rules.ts";
import { hashToken, isBeforeTokenAccount, newId, newToken } from "./auth.ts";
import type { Deps, Stmt } from "./ports.ts";

/** The name given to a workspace's first token. */
const FIRST_TOKEN_NAME = "First token";

/**
 * The statements that create a workspace, its owner and one API token, for a caller
 * that runs them in its own batch together with statements of its own (the setup
 * claim). Nothing is written until that batch runs. The returned token is shown to
 * the caller once and never stored; only its hash is in the statements. The email is
 * stored lowercased, which makes the unique email constraint case-insensitive.
 *
 * The owner is an account: an active one that is no admin and has no username yet. The
 * same batch writes its membership of the workspace, which is how later code finds an
 * account's workspace, and its one way to sign in, a link sent by mail.
 */
export async function workspaceStatements(
  deps: Deps,
  name: string,
  email: string,
): Promise<{ workspaceId: string; userId: string; token: string; stmts: Stmt[] }> {
  const workspaceId = newId("ws");
  const userId = newId("usr");
  const token = newToken();
  const hash = await hashToken(token);
  const now = deps.now();
  const stmts: Stmt[] = [
    newWorkspaceStatement(deps, workspaceId, name, now),
    {
      sql: "INSERT INTO user (id, workspace_id, email, created_at) VALUES (?, ?, ?, ?)",
      params: [userId, workspaceId, email.toLowerCase(), now],
    },
    {
      sql: "INSERT INTO membership (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
      params: [workspaceId, userId, now],
    },
    {
      sql: "INSERT INTO signin_method (user_id, kind, created_at) VALUES (?, 'email_link', ?)",
      params: [userId, now],
    },
    // The token is the owner's: it names the account (migration 0023), so GET /api/v1/me can.
    {
      sql: "INSERT INTO api_token (id, workspace_id, name, hash, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?)",
      params: [newId("tok"), workspaceId, FIRST_TOKEN_NAME, hash, now, userId],
    },
  ];
  return { workspaceId, userId, token, stmts };
}

/**
 * The same statements for a database migration 0023 has not reached (isBeforeTokenAccount):
 * the token's row without the account, as every version before it wrote it.
 */
export function withoutTokenAccount(stmts: Stmt[]): Stmt[] {
  return stmts.map((s) =>
    s.sql.startsWith("INSERT INTO api_token ")
      ? { sql: "INSERT INTO api_token (id, workspace_id, name, hash, created_at) VALUES (?, ?, ?, ?, ?)", params: (s.params ?? []).slice(0, 5) }
      : s,
  );
}

/** One batch: a workspace, its owner and one token. Returns the token, which is not stored. */
export async function createWorkspace(
  deps: Deps,
  name: string,
  email: string,
): Promise<{ workspaceId: string; token: string }> {
  const { workspaceId, token, stmts } = await workspaceStatements(deps, name, email);
  try {
    await deps.db.batch(stmts);
  } catch (err) {
    if (!isBeforeTokenAccount(err)) throw err;
    await deps.db.batch(withoutTokenAccount(stmts));
  }
  return { workspaceId, token };
}
