import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDeps, seedWorkspace } from "#harness";
import { createApp } from "../src/app.ts";
import { hashToken, requireAuth } from "../src/auth.ts";
import { sameSecret, setupCodeFromEnv } from "../src/setup.ts";
import type { Deps } from "../src/ports.ts";

const ORIGIN = "https://tours.example.com";
const CODE = "correct-horse-battery-staple"; // 28 characters
const NOT_FOUND = '{"error":"not_found"}';

/** Zero-width characters and marks, bidi embeddings, overrides and isolates, line and paragraph separators, the BOM. */
const HIDDEN_CHARS = [
  ...[0x200b, 0x200c, 0x200d, 0x200e, 0x200f],
  ...[0x202a, 0x202b, 0x202c, 0x202d, 0x202e],
  ...[0x2066, 0x2067, 0x2068, 0x2069],
  ...[0x2028, 0x2029, 0xfeff],
].map((c) => String.fromCharCode(c));

type Call = { status: number; text: string; headers: Headers };

async function send(deps: Deps, path: string, init: RequestInit = {}): Promise<Call> {
  const res = await createApp(deps).fetch(new Request(ORIGIN + path, init));
  return { status: res.status, text: await res.text(), headers: res.headers };
}

function post(deps: Deps, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Call> {
  return send(deps, path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const claimBody = (code = CODE, workspace = "Acme Tours", email = "owner@example.com") => ({ code, workspace, email });

async function count(deps: Deps, table: string): Promise<number> {
  const row = await deps.db.first<{ n: number }>(`SELECT count(*) AS n FROM ${table}`);
  return row!.n;
}

async function counts(deps: Deps): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of ["workspace", "user", "api_token", "setup"]) out[t] = await count(deps, t);
  return out;
}

const EMPTY = { workspace: 0, user: 0, api_token: 0, setup: 0 };

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

function connected(deps: Deps, token?: string): Promise<Call> {
  return send(deps, "/api/v1/setup/connected", token ? { headers: { authorization: "Bearer " + token } } : {});
}

/** Every setup route, as the browser would call it. */
function everySetupRoute(deps: Deps, code: string): Promise<Call>[] {
  return [
    send(deps, "/setup"),
    send(deps, "/setup/setup.css"),
    send(deps, "/setup/setup.js"),
    post(deps, "/setup/check", { code }),
    post(deps, "/setup/claim", claimBody(code)),
  ];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sameSecret", () => {
  it("sameSecret is true for equal strings and false for a prefix, a longer string and an empty one", async () => {
    expect(await sameSecret(CODE, CODE)).toBe(true);
    expect(await sameSecret(CODE, CODE.slice(0, -1))).toBe(false);
    expect(await sameSecret(CODE, CODE + "x")).toBe(false);
    expect(await sameSecret(CODE, "")).toBe(false);
    expect(await sameSecret("", CODE)).toBe(false);
    expect(await sameSecret(CODE, CODE.toUpperCase())).toBe(false);
  });
});

describe("when setup is unavailable", () => {
  it.each([
    ["no setup code", null],
    ["an empty setup code", ""],
    ["a 15-character setup code", "a".repeat(15)],
  ])("with %s, every setup route is 404", async (_label, setupCode) => {
    const { deps } = await makeDeps({ setupCode });
    for (const code of [setupCode ?? "", "a".repeat(15), CODE]) {
      for (const p of everySetupRoute(deps, code)) {
        const r = await p;
        expect(r.status).toBe(404);
        expect(r.text).toBe(NOT_FOUND);
      }
    }
    expect(await counts(deps)).toEqual(EMPTY);
  });

  it.each([
    ["16 spaces", " ".repeat(16)],
    ["16 tabs and newlines", "\t\n".repeat(8)],
    ["15 characters padded with spaces", "  " + "c".repeat(15) + "  "],
    ["15 characters and a carriage return", "c".repeat(15) + "\r"],
    ["15 characters spread out by spaces", "c c c c c c c c c c c c c c c"],
    ["a code with a control character inside", "c".repeat(10) + "\u0000" + "c".repeat(10)],
  ])("a configured code of %s leaves setup unavailable", async (_label, setupCode) => {
    const { deps } = await makeDeps({ setupCode });
    for (const p of everySetupRoute(deps, setupCode)) {
      const r = await p;
      expect(r.status).toBe(404);
      expect(r.text).toBe(NOT_FOUND);
    }
    expect(await counts(deps)).toEqual(EMPTY);
  });

  it("a configured code with a trailing carriage return or spaces is trimmed and still unlocks", async () => {
    for (const setupCode of [CODE + "\r", CODE + "\r\n", "  " + CODE + "  "]) {
      const { deps } = await makeDeps({ setupCode });
      expect((await post(deps, "/setup/check", { code: CODE })).status).toBe(204);
      expect((await post(deps, "/setup/check", { code: setupCode })).status).toBe(204);
    }
  });

  it("the typed code is trimmed the same way before it is compared", async () => {
    const { deps } = await makeDeps({ setupCode: CODE });
    for (const typed of [" " + CODE, CODE + " ", "\t" + CODE + "\r\n"]) {
      expect((await post(deps, "/setup/check", { code: typed })).status).toBe(204);
    }
    expect((await post(deps, "/setup/claim", claimBody(CODE + "  "))).status).toBe(201);
  });

  it("setupCodeFromEnv trims the configured value and treats an empty one as unset", () => {
    expect(setupCodeFromEnv(undefined)).toBeNull();
    expect(setupCodeFromEnv("")).toBeNull();
    expect(setupCodeFromEnv(" \r\n")).toBeNull();
    expect(setupCodeFromEnv(CODE + "\r")).toBe(CODE);
    expect(setupCodeFromEnv("  " + CODE + "\n")).toBe(CODE);
  });

  it("a 16-character setup code is enough", async () => {
    const { deps } = await makeDeps({ setupCode: "b".repeat(16) });
    expect((await send(deps, "/setup")).status).toBe(200);
    expect((await post(deps, "/setup/check", { code: "b".repeat(16) })).status).toBe(204);
  });

  it("setup is closed when a workspace already exists, even without a setup row", async () => {
    const { deps } = await makeDeps({ setupCode: CODE });
    await seedWorkspace(deps, "Existing");
    for (const p of everySetupRoute(deps, CODE)) expect((await p).status).toBe(404);
    expect(await count(deps, "workspace")).toBe(1);
  });
});

describe("checking the code", () => {
  it("the right code is 204 on check and writes nothing", async () => {
    const { deps } = await makeDeps({ setupCode: CODE });
    const r = await post(deps, "/setup/check", { code: CODE });
    expect(r.status).toBe(204);
    expect(r.text).toBe("");
    expect(await counts(deps)).toEqual(EMPTY);
  });

  it("a wrong code is 403 on check and on claim and creates no rows", async () => {
    const { deps } = await makeDeps({ setupCode: CODE });
    for (const wrong of ["", "  ", "wrong", CODE.slice(0, -1), CODE + "x", "x" + CODE, CODE.toUpperCase()]) {
      const check = await post(deps, "/setup/check", { code: wrong });
      expect(check.status).toBe(403);
      expect(check.text).toBe('{"error":"wrong_code"}');
      const claim = await post(deps, "/setup/claim", claimBody(wrong));
      expect(claim.status).toBe(403);
      expect(claim.text).toBe('{"error":"wrong_code"}');
    }
    expect(await counts(deps)).toEqual(EMPTY);
    // Setup is still open afterwards.
    expect((await send(deps, "/setup")).status).toBe(200);
  });

  it("a missing or non-string code, a non-object body and bad JSON are 400 and create nothing", async () => {
    const { deps } = await makeDeps({ setupCode: CODE });
    for (const body of [{}, { code: 123 }, { code: null }, [CODE], '"' + CODE + '"', "{not json"]) {
      for (const path of ["/setup/check", "/setup/claim"]) {
        const r = await post(deps, path, body);
        expect(r.status).toBe(400);
        expect(r.text).toBe('{"error":"bad_request"}');
      }
    }
    expect(await counts(deps)).toEqual(EMPTY);
  });
});

describe("body size", () => {
  it("a body over 4096 bytes is 413 on both POST routes and creates nothing", async () => {
    const { deps } = await makeDeps({ setupCode: CODE });
    const big = JSON.stringify({ code: CODE, workspace: "w".repeat(5000), email: "owner@example.com" });
    for (const path of ["/setup/check", "/setup/claim"]) {
      const r = await post(deps, path, big);
      expect(r.status).toBe(413);
      expect(r.text).toBe('{"error":"too_large"}');
    }
    expect(await counts(deps)).toEqual(EMPTY);
  });

  it("a streamed body with no Content-Length stops being read at the cap and is 413", async () => {
    const { deps } = await makeDeps({ setupCode: CODE });
    for (const path of ["/setup/check", "/setup/claim"]) {
      let pulled = 0;
      const chunk = new TextEncoder().encode('{"code":"' + "x".repeat(1000));
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled++;
          if (pulled > 1000) controller.close();
          else controller.enqueue(chunk);
        },
      });
      const req = new Request(ORIGIN + path, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body,
        duplex: "half",
      } as RequestInit);
      expect(req.headers.get("content-length")).toBeNull();
      const res = await createApp(deps).fetch(req);
      expect(res.status).toBe(413);
      expect(await res.text()).toBe('{"error":"too_large"}');
      // About 1 MB was on offer; only a few chunks past the cap may have been pulled.
      expect(pulled).toBeLessThan(50);
    }
    expect(await counts(deps)).toEqual(EMPTY);
  });

  it("a body of exactly 4096 bytes is read", async () => {
    const { deps } = await makeDeps({ setupCode: CODE });
    const base = JSON.stringify({ code: CODE, pad: "" });
    const exact = JSON.stringify({ code: CODE, pad: "p".repeat(4096 - base.length) });
    expect(new TextEncoder().encode(exact).length).toBe(4096);
    expect((await post(deps, "/setup/check", exact)).status).toBe(204);
  });
});

describe("same-origin rule", () => {
  it("a POST with no Origin, another origin or a non-JSON content type is refused and creates nothing", async () => {
    const { deps } = await makeDeps({ setupCode: CODE });
    const body = JSON.stringify(claimBody());
    const cases: RequestInit[] = [
      { method: "POST", headers: { "content-type": "application/json" }, body },
      { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example.net" }, body },
      { method: "POST", headers: { "content-type": "application/json", origin: "null" }, body },
      { method: "POST", headers: { "content-type": "application/json", origin: "https://tours.example.com.evil.example.net" }, body },
      { method: "POST", headers: { "content-type": "text/plain", origin: ORIGIN }, body },
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN }, body: "code=" + CODE },
    ];
    for (const path of ["/setup/check", "/setup/claim"]) {
      for (const init of cases) {
        const r = await send(deps, path, init);
        expect(r.status).toBe(403);
        expect(r.text).toBe('{"error":"cross_origin"}');
      }
    }
    expect(await counts(deps)).toEqual(EMPTY);
  });

  it("the origin's host is compared, so a TLS-terminating proxy in front of plain HTTP still works", async () => {
    const { deps } = await makeDeps({ setupCode: CODE });
    const res = await createApp(deps).fetch(
      new Request("http://tours.example.com/setup/check", {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ code: CODE }),
      }),
    );
    expect(res.status).toBe(204);
  });

  it("GET on a POST route is 404", async () => {
    const { deps } = await makeDeps({ setupCode: CODE });
    expect((await send(deps, "/setup/check")).status).toBe(404);
    expect((await send(deps, "/setup/claim")).status).toBe(404);
  });
});

describe("claiming the site", () => {
  it("the right code claims once: one workspace, one user, one token hash, one setup row", async () => {
    const { deps } = await makeDeps({ setupCode: CODE });
    deps.now = () => 1_700_000_000_000;
    const r = await post(deps, "/setup/claim", claimBody(CODE, "  Acme Tours  ", "Owner@Example.com"));
    expect(r.status).toBe(201);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = JSON.parse(r.text) as { token: string; workspace: string };
    expect(Object.keys(body).sort()).toEqual(["token", "workspace"]);
    expect(body.token).toMatch(/^dp_[0-9a-f]{40}$/);
    expect(body.workspace).toBe("Acme Tours");

    expect(await counts(deps)).toEqual({ workspace: 1, user: 1, api_token: 1, setup: 1 });
    const ws = await deps.db.first<{ id: string; name: string }>("SELECT id, name FROM workspace");
    expect(ws!.name).toBe("Acme Tours");
    expect(await deps.db.first("SELECT email FROM user")).toEqual({ email: "owner@example.com" });
    expect(await deps.db.first("SELECT id, workspace_id, completed_at FROM setup")).toEqual({
      id: 1,
      workspace_id: ws!.id,
      completed_at: 1_700_000_000_000,
    });
    expect(await deps.db.first("SELECT hash FROM api_token")).toEqual({ hash: await hashToken(body.token) });
  });

  it("the returned token authenticates and its text is stored nowhere", async () => {
    const { deps } = await makeDeps({ setupCode: CODE });
    const { token } = JSON.parse((await post(deps, "/setup/claim", claimBody())).text) as { token: string };
    const auth = await requireAuth(new Request(ORIGIN + "/api/v1/me", { headers: { authorization: "Bearer " + token } }), deps);
    expect(auth).toMatchObject({ workspaceId: expect.stringMatching(/^ws_/) });
    for (const v of await everyStoredValue(deps)) {
      expect(v).not.toContain(token);
      expect(v).not.toContain(token.slice(3));
      expect(v).not.toContain(CODE);
    }
  });

  it("after a claim, every setup route answers 404, with the right code too, and the token is never shown again", async () => {
    const { deps } = await makeDeps({ setupCode: CODE });
    const { token } = JSON.parse((await post(deps, "/setup/claim", claimBody())).text) as { token: string };
    for (const p of everySetupRoute(deps, CODE)) {
      const r = await p;
      expect(r.status).toBe(404);
      expect(r.text).toBe(NOT_FOUND);
      expect(r.text).not.toContain(token);
    }
    const c = await connected(deps, token);
    expect(c.text).not.toContain(token);
    expect(await counts(deps)).toEqual({ workspace: 1, user: 1, api_token: 1, setup: 1 });
  });

  it("setup stays closed on a fresh process, whose app knows only the database", async () => {
    const { deps } = await makeDeps({ setupCode: CODE });
    expect((await post(deps, "/setup/claim", claimBody())).status).toBe(201);
    // A new process builds new deps and a new app over the same database and config.
    const fresh: Deps = { ...deps, config: { ...deps.config } };
    for (const p of everySetupRoute(fresh, CODE)) expect((await p).status).toBe(404);
  });

  it("two claims at the same moment create exactly one workspace", async () => {
    const { deps } = await makeDeps({ setupCode: CODE });
    const results = await Promise.all([
      post(deps, "/setup/claim", claimBody(CODE, "First", "first@example.com")),
      post(deps, "/setup/claim", claimBody(CODE, "Second", "second@example.com")),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 404]);
    const loser = results.find((r) => r.status === 404)!;
    expect(loser.text).toBe(NOT_FOUND);
    expect(await counts(deps)).toEqual({ workspace: 1, user: 1, api_token: 1, setup: 1 });
    const winner = JSON.parse(results.find((r) => r.status === 201)!.text) as { workspace: string };
    expect(await deps.db.first("SELECT name FROM workspace")).toEqual({ name: winner.workspace });
  });

  it("when both claims pass the open check before either writes, the one-row claim lets only one batch commit", async () => {
    const { deps } = await makeDeps({ setupCode: CODE });
    // Hold every batch until two are waiting, so both claims have already seen setup open.
    const waiting: (() => void)[] = [];
    const gated: Deps = {
      ...deps,
      db: {
        all: deps.db.all.bind(deps.db),
        first: deps.db.first.bind(deps.db),
        run: deps.db.run.bind(deps.db),
        batch: async (stmts) => {
          await new Promise<void>((resolve) => {
            waiting.push(resolve);
            if (waiting.length === 2) for (const r of waiting) r();
          });
          return deps.db.batch(stmts);
        },
      },
    };
    const results = await Promise.all([
      post(gated, "/setup/claim", claimBody(CODE, "First", "first@example.com")),
      post(gated, "/setup/claim", claimBody(CODE, "Second", "second@example.com")),
    ]);
    expect(waiting).toHaveLength(2);
    expect(results.map((r) => r.status).sort()).toEqual([201, 404]);
    expect(await counts(deps)).toEqual({ workspace: 1, user: 1, api_token: 1, setup: 1 });
  });

  it("five claims at once, with the same email, still create exactly one workspace", async () => {
    const { deps } = await makeDeps({ setupCode: CODE });
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => post(deps, "/setup/claim", claimBody(CODE, "W" + i))));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 404)).toHaveLength(4);
    expect(await counts(deps)).toEqual({ workspace: 1, user: 1, api_token: 1, setup: 1 });
  });

  it.each([
    ["a blank workspace name", claimBody(CODE, "   "), "bad_workspace"],
    ["an 81-character workspace name", claimBody(CODE, "w".repeat(81)), "bad_workspace"],
    ["a workspace name with a control character", claimBody(CODE, "Acme\u0000Tours"), "bad_workspace"],
    ...HIDDEN_CHARS.flatMap((ch) => {
      const u = "U+" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0");
      return [
        ["a workspace name with " + u, claimBody(CODE, "Acme" + ch + "Tours"), "bad_workspace"],
        ["an email with " + u, claimBody(CODE, "Acme", "own" + ch + "er@example.com"), "bad_email"],
      ] as [string, unknown, string][];
    }),
    ["a workspace name that is not a string", { code: CODE, workspace: 5, email: "owner@example.com" }, "bad_workspace"],
    ["an email without @", claimBody(CODE, "Acme", "owner.example.com"), "bad_email"],
    ["an email with two @", claimBody(CODE, "Acme", "a@b@example.com"), "bad_email"],
    ["an email with nothing before @", claimBody(CODE, "Acme", "@example.com"), "bad_email"],
    ["an email with nothing after @", claimBody(CODE, "Acme", "owner@"), "bad_email"],
    ["an email with a space", claimBody(CODE, "Acme", "own er@example.com"), "bad_email"],
    ["a 255-character email", claimBody(CODE, "Acme", "o".repeat(243) + "@example.com"), "bad_email"],
    ["an email that is not a string", { code: CODE, workspace: "Acme", email: ["owner@example.com"] }, "bad_email"],
  ])("%s is 400 and leaves setup open", async (_label, body, error) => {
    const { deps } = await makeDeps({ setupCode: CODE });
    const r = await post(deps, "/setup/claim", body);
    expect(r.status).toBe(400);
    expect(r.text).toBe(JSON.stringify({ error }));
    expect(await counts(deps)).toEqual(EMPTY);
    expect((await send(deps, "/setup")).status).toBe(200);
  });

  it("an 80-character name and a 254-character email are accepted", async () => {
    const { deps } = await makeDeps({ setupCode: CODE });
    const r = await post(deps, "/setup/claim", claimBody(CODE, "w".repeat(80), "o".repeat(242) + "@example.com"));
    expect(r.status).toBe(201);
  });

  it("a workspace name of markup is stored and returned as plain text", async () => {
    const { deps } = await makeDeps({ setupCode: CODE });
    const name = "<img src=x onerror=alert(1)>";
    const r = await post(deps, "/setup/claim", claimBody(CODE, name));
    expect(r.status).toBe(201);
    expect(r.headers.get("content-type")).toMatch(/^application\/json/);
    expect((JSON.parse(r.text) as { workspace: string }).workspace).toBe(name);
    expect(await deps.db.first("SELECT name FROM workspace")).toEqual({ name });
  });
});

describe("the connected check", () => {
  it("connected is false until another route is called with the token, and polling does not flip it", async () => {
    const { deps } = await makeDeps({ setupCode: CODE });
    const { token } = JSON.parse((await post(deps, "/setup/claim", claimBody())).text) as { token: string };
    for (let i = 0; i < 3; i++) {
      const r = await connected(deps, token);
      expect(r.status).toBe(200);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(JSON.parse(r.text)).toEqual({ connected: false });
    }
    expect(await deps.db.first("SELECT last_used_at FROM api_token")).toEqual({ last_used_at: null });

    // The recorder's first call goes through the same guard every API route uses.
    await requireAuth(new Request(ORIGIN + "/api/v1/me", { headers: { authorization: "Bearer " + token } }), deps);
    expect(JSON.parse((await connected(deps, token)).text)).toEqual({ connected: true });
  });

  it("connected needs the token", async () => {
    const { deps } = await makeDeps({ setupCode: CODE });
    await post(deps, "/setup/claim", claimBody());
    for (const r of [await connected(deps), await connected(deps, "dp_" + "0".repeat(40))]) {
      expect(r.status).toBe(401);
      expect(r.text).toBe('{"error":"unauthorized"}');
    }
  });

  it("connected reports only the calling token's own use", async () => {
    const { deps } = await makeDeps({ setupCode: CODE });
    const { token } = JSON.parse((await post(deps, "/setup/claim", claimBody())).text) as { token: string };
    const other = await seedWorkspace(deps, "Other");
    await requireAuth(new Request(ORIGIN + "/x", { headers: { authorization: "Bearer " + other.token } }), deps);
    expect(JSON.parse((await connected(deps, token)).text)).toEqual({ connected: false });
    expect(JSON.parse((await connected(deps, other.token)).text)).toEqual({ connected: true });
  });
});

describe("secrets and headers", () => {
  it("no console output and no response contains the setup code", async () => {
    const spies = (["log", "info", "warn", "error", "debug", "trace"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const { deps } = await makeDeps({ setupCode: CODE });
    const responses: Call[] = [];
    const wrong = CODE.slice(0, -1) + "!";
    for (const code of [wrong, CODE]) {
      for (const p of everySetupRoute(deps, code)) responses.push(await p);
      responses.push(await post(deps, "/setup/claim", claimBody(code, "")));
    }
    responses.push(await post(deps, "/setup/claim", claimBody()));
    for (const r of responses) {
      expect(r.text).not.toContain(CODE);
      expect(r.text).not.toContain(wrong);
      for (const [, v] of r.headers) {
        expect(v).not.toContain(CODE);
        expect(v).not.toContain(wrong);
      }
    }
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it("the wizard page sets no cookie, forbids framing and is not cached", async () => {
    const { deps } = await makeDeps({ setupCode: CODE });
    const r = await send(deps, "/setup");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-security-policy")).toBe(
      "default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
  });

  it("the page loads only its own script and stylesheet and holds the approved wording", async () => {
    const { deps } = await makeDeps({ setupCode: CODE });
    const page = (await send(deps, "/setup")).text;
    expect(page).toContain('<script src="/setup/setup.js" defer></script>');
    expect(page).toContain('<link rel="stylesheet" href="/setup/setup.css">');
    expect(page).not.toMatch(/https?:\/\//);
    expect(page).not.toMatch(/<script>|<style>|\son[a-z]+=/i);
    const order = [
      "Set up your tour site",
      "Enter the setup code you chose when you installed. It stops anyone else from claiming this site.",
      "Setup code",
      "Name your workspace",
      "Your tours, chapters and viewing data belong to this workspace.",
      "Workspace name",
      "Owner email",
      "Copy your API token",
      "Mythicshot uses this to upload tours. It is shown once and can&#39;t be recovered.",
      "Anyone with this token can upload to and unpublish your tours.",
      "I&#39;ve saved the token",
      "Connect Mythicshot",
      "In Mythicshot, open Settings › Output › Tour publishing and paste these, then press Test connection.",
      "Waiting for Mythicshot to connect…",
      "Finish",
    ];
    let at = 0;
    for (const s of order) {
      const i = page.indexOf(s, at);
      expect(i, s).toBeGreaterThanOrEqual(at);
      at = i + s.length;
    }
    // Inputs carry no name, so a form submitted before the script runs sends nothing.
    expect(page).not.toMatch(/<input[^>]*\sname=/);
    expect(page).toMatch(/<input id="code" type="password"/);
  });

  it("the script and stylesheet are served with their types and the same no-store rule", async () => {
    const { deps } = await makeDeps({ setupCode: CODE });
    const js = await send(deps, "/setup/setup.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(js.headers.get("cache-control")).toBe("no-store");
    expect(js.headers.get("x-content-type-options")).toBe("nosniff");
    expect(js.text).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|localStorage|sessionStorage|document\.cookie/);
    const css = await send(deps, "/setup/setup.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(css.text).not.toMatch(/@import|url\(/);
    expect(css.text).toContain("prefers-color-scheme: dark");
  });
});
