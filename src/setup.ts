// The first-run setup routes. Setup is open only while the install has a configured
// setup code of at least 16 characters, no setup row and no workspace. The code comes
// only from configuration; it is compared through SHA-256 digests in constant time and
// is never logged, echoed, stored or put in a URL.
import type { Context, Hono } from "hono";
import { constantTimeEqual, requireAuth } from "./auth.ts";
import { isUniqueViolation, type Deps } from "./ports.ts";
import { SETUP_CSS, SETUP_HTML, SETUP_JS } from "./setup/page.ts";
import { workspaceStatements } from "./workspaces.ts";

/** The shortest setup code that opens setup. A shorter one leaves setup unavailable. */
export const MIN_SETUP_CODE_LENGTH = 16;

/** The largest JSON body a setup POST reads. */
const MAX_BODY_CHARS = 4096;
const MAX_CODE_CHARS = 1024;
const MAX_WORKSPACE_CHARS = 80;
const MAX_EMAIL_CHARS = 254;

// C0 controls, DEL and C1 controls.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

async function sha256(s: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  let out = "";
  for (const b of digest) out += b.toString(16).padStart(2, "0");
  return out;
}

/** True when both strings are equal, comparing their SHA-256 digests byte by byte without an early exit. */
export async function sameSecret(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256(a), sha256(b)]);
  return constantTimeEqual(da, db);
}

/** Headers on every setup response. The wizard page may not be framed or cached. */
const BASE_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const PAGE_HEADERS: Record<string, string> = {
  ...BASE_HEADERS,
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, "content-type": "application/json" },
  });
}

/** The same answer as an unknown path, so a closed setup looks like no setup at all. */
function notFound(): Response {
  return new Response('{"error":"not_found"}', { status: 404, headers: { "content-type": "application/json" } });
}

/** True when setup can still be claimed: a long enough code is configured and nothing is set up yet. */
async function setupOpen(deps: Deps): Promise<boolean> {
  const code = deps.config.setupCode;
  if (typeof code !== "string" || code.length < MIN_SETUP_CODE_LENGTH) return false;
  const row = await deps.db.first<{ n: number }>(
    "SELECT (SELECT count(*) FROM setup) + (SELECT count(*) FROM workspace) AS n",
  );
  return row !== null && row.n === 0;
}

/**
 * True when a state-changing request comes from this site's own page: a JSON body and
 * an Origin header whose host is the request's host. Only the host is compared, so the
 * check also holds behind a proxy that ends HTTPS and forwards plain HTTP.
 */
function sameOrigin(req: Request): boolean {
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  if (type.split(";")[0].trim() !== "application/json") return false;
  const origin = req.headers.get("origin");
  if (origin === null || origin === "null") return false;
  let originHost: string;
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    originHost = u.host;
  } catch {
    return false;
  }
  return originHost === new URL(req.url).host;
}

type Body = Record<string, unknown>;

/** The request's JSON object with a string `code`, or null for anything else. */
async function readBody(req: Request): Promise<Body | null> {
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_CHARS) return null;
  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const code = (body as Body).code;
  if (typeof code !== "string" || code.length > MAX_CODE_CHARS) return null;
  return body as Body;
}

/** The trimmed workspace name, or null when it is not 1 to 80 characters of text. */
function workspaceName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const name = v.trim();
  if (name.length < 1 || name.length > MAX_WORKSPACE_CHARS || CONTROL.test(name)) return null;
  return name;
}

/** The trimmed email, or null unless it has one @ with text on both sides, no spaces and at most 254 characters. */
function ownerEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const email = v.trim();
  if (email.length > MAX_EMAIL_CHARS || /\s/.test(email) || CONTROL.test(email)) return null;
  const parts = email.split("@");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") return null;
  return email;
}

/**
 * Runs the checks every setup POST shares, in this order: setup open (else 404), same
 * origin (else 403), a readable body (else 400), the right code (else 403).
 */
async function guardPost(c: Context, deps: Deps): Promise<Body | Response> {
  if (!(await setupOpen(deps))) return notFound();
  if (!sameOrigin(c.req.raw)) return json(403, { error: "cross_origin" });
  const body = await readBody(c.req.raw);
  if (body === null) return json(400, { error: "bad_request" });
  if (!(await sameSecret(body.code as string, deps.config.setupCode as string))) return json(403, { error: "wrong_code" });
  return body;
}

/** Adds the setup routes to the app. */
export function setupRoutes(app: Hono, deps: Deps): void {
  const page = (body: string, headers: Record<string, string>) => async () =>
    (await setupOpen(deps)) ? new Response(body, { status: 200, headers }) : notFound();

  app.get("/setup", page(SETUP_HTML, PAGE_HEADERS));
  app.get("/setup/setup.css", page(SETUP_CSS, { ...BASE_HEADERS, "content-type": "text/css; charset=utf-8" }));
  app.get("/setup/setup.js", page(SETUP_JS, { ...BASE_HEADERS, "content-type": "text/javascript; charset=utf-8" }));

  app.post("/setup/check", async (c) => {
    const body = await guardPost(c, deps);
    if (body instanceof Response) return body;
    return new Response(null, { status: 204, headers: BASE_HEADERS });
  });

  app.post("/setup/claim", async (c) => {
    const body = await guardPost(c, deps);
    if (body instanceof Response) return body;
    const name = workspaceName(body.workspace);
    if (name === null) return json(400, { error: "bad_workspace" });
    const email = ownerEmail(body.email);
    if (email === null) return json(400, { error: "bad_email" });

    // One batch: the workspace, its owner, its token and the one-row claim. The setup
    // table's primary key lets only one claim commit; any other loses the whole batch.
    const w = await workspaceStatements(deps, name, email);
    try {
      await deps.db.batch([
        ...w.stmts,
        { sql: "INSERT INTO setup (id, workspace_id, completed_at) VALUES (1, ?, ?)", params: [w.workspaceId, deps.now()] },
      ]);
    } catch (err) {
      if (isUniqueViolation(err)) return notFound();
      throw err;
    }
    return json(201, { token: w.token, workspace: name });
  });

  // Whether the recorder has used the token yet. Authenticates without touching
  // last_used_at, so the wizard's own polling never counts as a connection.
  app.get("/api/v1/setup/connected", async (c) => {
    const auth = await requireAuth(c.req.raw, deps, { touch: false });
    if (auth instanceof Response) return auth;
    const row = await deps.db.first<{ last_used_at: number | null }>(
      "SELECT last_used_at FROM api_token WHERE id = ? AND workspace_id = ?",
      [auth.tokenId, auth.workspaceId],
    );
    return json(200, { connected: row !== null && row.last_used_at !== null });
  });
}
