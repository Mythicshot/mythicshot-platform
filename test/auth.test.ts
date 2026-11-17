import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDeps, seedWorkspace } from "#harness";
import { constantTimeEqual, hashToken, newId, newSlug, newToken, requireAuth } from "../src/auth.ts";
import { createWorkspace } from "../src/workspaces.ts";
import type { Deps } from "../src/ports.ts";

function req(authorization?: string): Request {
  const headers = new Headers();
  if (authorization !== undefined) headers.set("Authorization", authorization);
  return new Request("https://tours.example.com/api/tours", { headers });
}

/** Every value in every column of every app table, as strings. */
async function everyStoredValue(deps: Deps): Promise<string[]> {
  const tables = await deps.db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_*' AND name NOT GLOB 'd1_*'",
  );
  const out: string[] = [];
  for (const { name } of tables) {
    const rows = await deps.db.all<Record<string, unknown>>(`SELECT * FROM "${name}"`);
    for (const row of rows) for (const v of Object.values(row)) out.push(String(v));
  }
  return out;
}

const UNAUTHORIZED = '{"error":"unauthorized"}';

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tokens and ids", () => {
  it("a token is dp_ plus 40 hex and hashes to 64 hex", async () => {
    const t = newToken();
    expect(t).toMatch(/^dp_[0-9a-f]{40}$/);
    expect(await hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashToken(t)).not.toContain(t.slice(3));
  });

  it("hashToken is SHA-256 of the whole token", async () => {
    // SHA-256("abc"), the FIPS 180-2 test vector.
    expect(await hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("tokens, ids and slugs do not repeat", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => newToken()));
    const ids = new Set(Array.from({ length: 200 }, () => newId("tour")));
    const slugs = new Set(Array.from({ length: 200 }, () => newSlug()));
    expect(tokens.size).toBe(200);
    expect(ids.size).toBe(200);
    expect(slugs.size).toBe(200);
  });

  it.each(["ws", "usr", "tok", "tour", "ch", "st", "up"] as const)("an id with prefix %s is prefix_ plus 24 hex", (p) => {
    expect(newId(p)).toMatch(new RegExp(`^${p}_[0-9a-f]{24}$`));
  });

  it("a slug is 10 characters from a-z and 2-7", () => {
    for (let i = 0; i < 50; i++) expect(newSlug()).toMatch(/^[a-z2-7]{10}$/);
  });

  it("constantTimeEqual compares whole strings", () => {
    expect(constantTimeEqual("a".repeat(64), "a".repeat(64))).toBe(true);
    expect(constantTimeEqual("a".repeat(64), "a".repeat(63) + "b")).toBe(false);
    expect(constantTimeEqual("b" + "a".repeat(63), "a".repeat(64))).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("", "a")).toBe(false);
  });
});

describe("requireAuth", () => {
  it("missing, malformed, unknown and revoked tokens all get the same 401", async () => {
    const { deps } = await makeDeps();
    const { workspaceId, token: revokedToken } = await seedWorkspace(deps, "Acme");
    await deps.db.run("UPDATE api_token SET revoked_at = ? WHERE workspace_id = ?", [deps.now(), workspaceId]);
    const cases = [
      undefined,
      "",
      "dp_" + "0".repeat(40),
      "Bearer nope",
      "Bearer dp_" + "0".repeat(40),
      "Bearer " + revokedToken.toUpperCase(),
      "Bearer " + revokedToken + " ",
      "Basic " + revokedToken,
      "Bearer " + revokedToken,
    ];
    for (const h of cases) {
      const r = await requireAuth(req(h), deps);
      expect(r).toBeInstanceOf(Response);
      expect((r as Response).status).toBe(401);
      expect(await (r as Response).text()).toBe(UNAUTHORIZED);
    }
  });

  it("a valid token resolves to its workspace and updates last_used_at", async () => {
    const { deps } = await makeDeps();
    let now = 1_700_000_000_000;
    deps.now = () => now;
    const { workspaceId, token } = await seedWorkspace(deps, "Acme");
    const before = await deps.db.first<{ id: string; last_used_at: number | null }>(
      "SELECT id, last_used_at FROM api_token WHERE workspace_id = ?",
      [workspaceId],
    );
    expect(before!.last_used_at).toBeNull();
    now += 5000;
    const auth = await requireAuth(req("Bearer " + token), deps);
    expect(auth).toEqual({ workspaceId, tokenId: before!.id });
    const after = await deps.db.first<{ last_used_at: number }>("SELECT last_used_at FROM api_token WHERE id = ?", [
      before!.id,
    ]);
    expect(after!.last_used_at).toBe(now);
  });

  it("accepts the scheme in any case", async () => {
    const { deps } = await makeDeps();
    const { workspaceId, token } = await seedWorkspace(deps, "Acme");
    const auth = await requireAuth(req("bearer " + token), deps);
    expect(auth).toMatchObject({ workspaceId });
  });

  it("each workspace's token resolves only to its own workspace and touches only its own row", async () => {
    const { deps } = await makeDeps();
    const a = await seedWorkspace(deps, "A");
    const b = await seedWorkspace(deps, "B");
    expect(a.workspaceId).not.toBe(b.workspaceId);
    const authB = await requireAuth(req("Bearer " + b.token), deps);
    expect(authB).toMatchObject({ workspaceId: b.workspaceId });
    const rowA = await deps.db.first<{ last_used_at: number | null; revoked_at: number | null }>(
      "SELECT last_used_at, revoked_at FROM api_token WHERE workspace_id = ?",
      [a.workspaceId],
    );
    expect(rowA).toEqual({ last_used_at: null, revoked_at: null });
    // Revoking B's token leaves A's token working.
    await deps.db.run("UPDATE api_token SET revoked_at = ? WHERE workspace_id = ?", [deps.now(), b.workspaceId]);
    expect(await requireAuth(req("Bearer " + b.token), deps)).toBeInstanceOf(Response);
    expect(await requireAuth(req("Bearer " + a.token), deps)).toMatchObject({ workspaceId: a.workspaceId });
  });

  it("never logs the token or its hash", async () => {
    const { deps } = await makeDeps();
    const spies = (["log", "info", "warn", "error", "debug", "trace"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const { token } = await seedWorkspace(deps, "Acme");
    await requireAuth(req("Bearer " + token), deps);
    await requireAuth(req("Bearer " + token.slice(0, -1) + "x"), deps);
    await requireAuth(req("Bearer dp_" + "0".repeat(40)), deps);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe("createWorkspace", () => {
  it("createWorkspace writes one workspace, one user and one token hash, and no token text", async () => {
    const { deps } = await makeDeps();
    deps.now = () => 1_700_000_000_000;
    const { workspaceId, token } = await createWorkspace(deps, "Acme Tours", "owner@example.com");
    expect(workspaceId).toMatch(/^ws_[0-9a-f]{24}$/);
    expect(token).toMatch(/^dp_[0-9a-f]{40}$/);

    expect(await deps.db.all("SELECT id, name, created_at FROM workspace")).toEqual([
      { id: workspaceId, name: "Acme Tours", created_at: 1_700_000_000_000 },
    ]);
    const users = await deps.db.all<{ id: string; workspace_id: string; email: string }>(
      "SELECT id, workspace_id, email FROM user",
    );
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ workspace_id: workspaceId, email: "owner@example.com" });
    expect(users[0].id).toMatch(/^usr_[0-9a-f]{24}$/);

    const tokens = await deps.db.all<Record<string, unknown>>("SELECT * FROM api_token");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      workspace_id: workspaceId,
      hash: await hashToken(token),
      created_at: 1_700_000_000_000,
      last_used_at: null,
      revoked_at: null,
    });
    expect(tokens[0].id).toMatch(/^tok_[0-9a-f]{24}$/);

    for (const v of await everyStoredValue(deps)) {
      expect(v).not.toContain(token);
      expect(v).not.toContain(token.slice(3));
    }
  });

  it("returns a token that authenticates", async () => {
    const { deps } = await makeDeps();
    const { workspaceId, token } = await createWorkspace(deps, "Acme", "owner@example.com");
    expect(await requireAuth(req("Bearer " + token), deps)).toMatchObject({ workspaceId });
  });

  it("writes nothing when the batch fails", async () => {
    const { deps } = await makeDeps();
    const failing: Deps = {
      ...deps,
      db: {
        ...deps.db,
        all: deps.db.all.bind(deps.db),
        first: deps.db.first.bind(deps.db),
        run: deps.db.run.bind(deps.db),
        // The last statement fails, so the whole batch must roll back.
        batch: (stmts) => deps.db.batch([...stmts, { sql: "INSERT INTO workspace (id) VALUES (NULL)" }]),
      },
    };
    await expect(createWorkspace(failing, "Acme", "owner@example.com")).rejects.toThrow();
    for (const t of ["workspace", "user", "api_token"]) {
      expect(await deps.db.first<{ n: number }>(`SELECT count(*) AS n FROM ${t}`)).toEqual({ n: 0 });
    }
  });
});
