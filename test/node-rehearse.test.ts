// The comparisons of the upgrade rehearsal (scripts/rehearse-compare.ts), without starting
// any server: the allow-list lets through the date header and the version value and
// nothing else, and every kind of real difference fails. The full rehearsal starts the
// builds themselves and is run on its own: npm run rehearse:upgrade.
import { describe, expect, it } from "vitest";
import {
  checkAccountsBackfill,
  compareAnswers,
  compareRows,
  compareStores,
  migrationProblems,
  storesSame,
  usageFromRows,
  usageProblems,
  type Answer,
  type DbSnapshot,
  type Recorded,
  type StoreListing,
} from "../scripts/rehearse-compare.ts";
import { pictureAddresses, readTokens } from "../scripts/rehearse-upgrade.ts";

const enc = new TextEncoder();

function answer(status: number, body: string, headers: Record<string, string> = {}): Answer {
  const bytes = enc.encode(body);
  return { status, body: bytes, headers: { "content-type": "application/json", "content-length": String(bytes.length), date: "Thu, 19 Nov 2026 10:00:00 GMT", ...headers } };
}

const rec = (key: string, route: string, a: Answer): Recorded => ({ key, route, answer: a });

/** A small recording: the workspace, the tour list, the usage, a page and two pictures. */
function site(opts: { version?: string; date?: string; usage?: Answer; picture?: Uint8Array; pictures?: number } = {}): Recorded[] {
  const date = { date: opts.date ?? "Thu, 19 Nov 2026 10:00:00 GMT" };
  const pic = (fill: number) => ({ status: 200, headers: { "content-type": "image/png", "content-length": "4", ...date }, body: opts.picture && fill === 1 ? opts.picture : new Uint8Array([0x89, 0x50, fill, 7]) });
  const out = [
    rec("token 1: workspace (one address)", "GET /api/v1/me", answer(200, `{"workspace":"Acme","version":"${opts.version ?? "0.1.7"}"}`, date)),
    rec("token 1: tour list (one address)", "GET /api/v1/tours", answer(200, '{"tours":[{"id":"tour_1","slug":"abcdefghij"}]}', date)),
    rec("token 1: usage (one address)", "GET /api/v1/usage", opts.usage ?? answer(404, '{"error":"not_found"}', date)),
    rec("token 1: tour 1 page", "GET /t/:slug", answer(200, "<!doctype html><title>Acme</title>", { ...date, "content-type": "text/html; charset=utf-8", etag: '"abc"' })),
  ];
  for (let k = 1; k <= (opts.pictures ?? 2); k++) out.push(rec(`token 1: tour 1 picture ${k}`, "GET /p/:name", pic(k)));
  return out;
}

describe("answers", () => {
  it("the same answers at another moment are identical: only the date header differs", () => {
    const c = compareAnswers(site(), site({ date: "Fri, 20 Nov 2026 11:11:11 GMT" }));
    expect(c).toEqual({ identical: 6, allowed: 0, added: [], problems: [] });
  });

  it("a newer version in the workspace answer is the one allowed body difference, and content-length follows it", () => {
    const c = compareAnswers(site({ version: "0.1.8" }), site({ version: "0.1.10" }));
    expect(c.problems).toEqual([]);
    expect(c.allowed).toBe(1);
    expect(c.identical).toBe(5);
  });

  it("a changed body byte fails, in a picture and in a page", () => {
    const pic = compareAnswers(site(), site({ picture: new Uint8Array([0x89, 0x50, 1, 8]) }));
    expect(pic.problems).toEqual(["token 1: tour 1 picture 1: body differs (4 and 4 bytes)"]);
    const after = site();
    after[3] = rec("token 1: tour 1 page", "GET /t/:slug", answer(200, "<!doctype html><title>Acmf</title>", { "content-type": "text/html; charset=utf-8", etag: '"abc"' }));
    expect(compareAnswers(site(), after).problems).toEqual(["token 1: tour 1 page: body differs (34 and 34 bytes)"]);
  });

  it("the version allowance hides nothing else: another byte of the workspace answer, or a version anywhere else, fails", () => {
    const after = site({ version: "0.1.8" });
    after[0] = rec("token 1: workspace (one address)", "GET /api/v1/me", answer(200, '{"workspace":"Acmf","version":"0.1.8"}'));
    expect(compareAnswers(site(), after).problems).toHaveLength(1);
    const list = (v: string) => [rec("token 1: tour list (one address)", "GET /api/v1/tours", answer(200, `{"tours":[],"version":"${v}"}`))];
    expect(compareAnswers(list("0.1.7"), list("0.1.8")).problems).toHaveLength(1);
    // Two version values in one body: the swap does not apply.
    const two = (v: string) => [rec("w", "GET /api/v1/me", answer(200, `{"version":"${v}","x":{"version":"${v}"}}`))];
    expect(compareAnswers(two("0.1.7"), two("0.1.8")).problems).toHaveLength(1);
  });

  it("a header other than the date that changes, appears or goes fails", () => {
    const changed = site();
    changed[3] = rec("token 1: tour 1 page", "GET /t/:slug", answer(200, "<!doctype html><title>Acme</title>", { "content-type": "text/html; charset=utf-8", etag: '"abd"' }));
    expect(compareAnswers(site(), changed).problems).toEqual(["token 1: tour 1 page: header etag differs"]);
    const added = site();
    added[1] = rec("token 1: tour list (one address)", "GET /api/v1/tours", answer(200, '{"tours":[{"id":"tour_1","slug":"abcdefghij"}]}', { "set-cookie": "x=1" }));
    expect(compareAnswers(site(), added).problems).toEqual(["token 1: tour list (one address): header set-cookie added"]);
    const gone = site();
    delete gone[3].answer.headers.etag;
    expect(compareAnswers(site(), gone).problems).toEqual(["token 1: tour 1 page: header etag missing"]);
  });

  it("a changed status fails", () => {
    const after = site();
    after[3] = rec("token 1: tour 1 page", "GET /t/:slug", answer(404, "<!doctype html><title>Acme</title>", { "content-type": "text/html; charset=utf-8", etag: '"abc"' }));
    expect(compareAnswers(site(), after).problems).toEqual(["token 1: tour 1 page: status 200 became 404"]);
  });

  it("a missing picture fails, and so does one more than before", () => {
    expect(compareAnswers(site(), site({ pictures: 1 })).problems).toEqual(["token 1: tour 1 picture 2: missing after"]);
    expect(compareAnswers(site(), site({ pictures: 3 })).problems).toEqual(["token 1: tour 1 picture 3: unexpected after"]);
  });

  it("the usage a newer build adds is set aside only when the older build had no such route at all", () => {
    const added = compareAnswers(site(), site({ usage: answer(200, '{"used_bytes":1}') }));
    expect(added.added).toEqual(["token 1: usage (one address)"]);
    expect(added.problems).toEqual([]);
    // The route was there and is gone, or answered something else before: compared, and it fails.
    expect(compareAnswers(site({ usage: answer(200, '{"used_bytes":1}') }), site()).problems).toHaveLength(1);
    expect(compareAnswers(site({ usage: answer(404, '{"error":"not_found","detail":"no such workspace"}') }), site({ usage: answer(200, '{"used_bytes":1}') })).problems).toHaveLength(1);
    expect(compareAnswers(site({ usage: answer(200, '{"used_bytes":1}') }), site({ usage: answer(200, '{"used_bytes":2}') })).problems).toHaveLength(1);
  });
});

describe("stores", () => {
  const listing = (entries: [string, number, string][]): StoreListing => new Map(entries.map(([p, size, sha256]) => [p, { size, sha256 }]));
  const base = listing([["drafts/ab/ab1", 10, "a"], ["public/cd/cd1", 20, "b"]]);

  it("the same files are the same", () => {
    expect(storesSame(compareStores(base, listing([["public/cd/cd1", 20, "b"], ["drafts/ab/ab1", 10, "a"]])))).toBe(true);
  });

  it("a missing, an extra and a changed file each fail", () => {
    expect(compareStores(base, listing([["drafts/ab/ab1", 10, "a"]]))).toEqual({ files: 2, missing: 1, extra: 0, changed: 0 });
    expect(compareStores(base, listing([["drafts/ab/ab1", 10, "a"], ["public/cd/cd1", 20, "b"], ["public/ef/ef1", 1, "c"]]))).toEqual({ files: 2, missing: 0, extra: 1, changed: 0 });
    expect(compareStores(base, listing([["drafts/ab/ab1", 10, "a"], ["public/cd/cd1", 20, "B"]]))).toEqual({ files: 2, missing: 0, extra: 0, changed: 1 });
    for (const after of [listing([["drafts/ab/ab1", 10, "a"]]), listing([["drafts/ab/ab1", 11, "a"], ["public/cd/cd1", 20, "b"]])]) expect(storesSame(compareStores(base, after))).toBe(false);
  });
});

const WS = "ws_" + "a".repeat(24);
const USR = "usr_" + "a".repeat(24);

/** A database as 0.1.7 leaves it, cut down to what the checks read. */
function oldDb(): DbSnapshot {
  return {
    workspace: { columns: ["id", "name", "created_at"], rows: [[WS, "Acme", 1]] },
    user: { columns: ["id", "workspace_id", "email", "created_at"], rows: [[USR, WS, "owner@example.com", 1]] },
    tour: { columns: ["id", "workspace_id", "title"], rows: [["tour_1", WS, "Send an invoice"], ["tour_2", WS, "Draft"]] },
  };
}

/** The same after migration 0008: the new columns and tables, and the backfill. */
function migratedDb(): DbSnapshot {
  const db = oldDb();
  return {
    ...db,
    user: { columns: [...db.user.columns, "username", "status", "is_admin"], rows: [[USR, WS, "owner@example.com", 1, null, "active", 0]] },
    tour: { columns: [...db.tour.columns, "logo_bytes"], rows: [["tour_2", WS, "Draft", null], ["tour_1", WS, "Send an invoice", null]] },
    membership: { columns: ["workspace_id", "user_id", "role", "created_at"], rows: [[WS, USR, "owner", 1]] },
    signin_method: { columns: ["user_id", "kind", "created_at"], rows: [[USR, "email_link", 1]] },
    signin_code: { columns: ["id"], rows: [] },
    session: { columns: ["id"], rows: [] },
    rate_counter: { columns: ["bucket"], rows: [] },
    audit: { columns: ["id"], rows: [] },
  };
}

describe("rows", () => {
  it("every old row in the columns it had, in any order and beside new columns and tables, is the same", () => {
    expect(compareRows(oldDb(), migratedDb())).toEqual({ tables: 3, rows: 4, problems: [] });
  });

  it("a changed row fails and the problem names the table, never a value", () => {
    const after = migratedDb();
    after.user.rows[0][2] = "someone@example.com";
    const c = compareRows(oldDb(), after);
    expect(c.problems).toEqual(["table user: 1 row(s) missing or changed, 1 row(s) not there before"]);
    expect(c.problems.join(" ")).not.toContain("example.com");
  });

  it("a missing row, an added row, a duplicated row, a missing column and a missing table each fail", () => {
    const missing = migratedDb();
    missing.tour.rows.pop();
    expect(compareRows(oldDb(), missing).problems).toEqual(["table tour: 1 row(s) missing or changed, 0 row(s) not there before"]);
    const added = migratedDb();
    added.tour.rows.push(["tour_3", WS, "New", null]);
    expect(compareRows(oldDb(), added).problems).toEqual(["table tour: 0 row(s) missing or changed, 1 row(s) not there before"]);
    const doubled = migratedDb();
    doubled.workspace.rows.push([...doubled.workspace.rows[0]]);
    expect(compareRows(oldDb(), doubled).problems).toHaveLength(1);
    const column = migratedDb();
    column.tour = { columns: ["id", "workspace_id", "logo_bytes"], rows: column.tour.rows.map((r) => [r[0], r[1], r[3]]) };
    expect(compareRows(oldDb(), column).problems).toEqual(["table tour: 1 column(s) missing after: title"]);
    const table = migratedDb();
    delete (table as Partial<DbSnapshot>).tour;
    expect(compareRows(oldDb(), table).problems).toEqual(["table tour: missing after"]);
  });
});

describe("the accounts backfill", () => {
  it("one owner membership and one email_link method per user, nobody an admin, nothing else: passes", () => {
    expect(checkAccountsBackfill(migratedDb())).toEqual({ users: 1, memberships: 1, methods: 1, admins: 0, problems: [] });
  });

  it("a missing membership row fails", () => {
    const db = migratedDb();
    db.membership.rows = [];
    expect(checkAccountsBackfill(db).problems).toEqual(["1 user(s) lack exactly one owner membership of their own workspace", "0 membership row(s) for 1 user(s)"]);
  });

  it("a membership of another workspace or another role fails", () => {
    const other = migratedDb();
    other.membership.rows = [["ws_" + "b".repeat(24), USR, "owner", 1]];
    expect(checkAccountsBackfill(other).problems).toEqual(["1 user(s) lack exactly one owner membership of their own workspace"]);
    const role = migratedDb();
    role.membership.rows = [[WS, USR, "member", 1]];
    expect(checkAccountsBackfill(role).problems).toHaveLength(1);
  });

  it("a missing sign-in method fails", () => {
    const db = migratedDb();
    db.signin_method.rows = [];
    expect(checkAccountsBackfill(db).problems).toEqual(["1 user(s) lack exactly one email_link sign-in method", "0 sign-in method row(s) for 1 user(s)"]);
  });

  it("an unexpected admin fails", () => {
    const db = migratedDb();
    db.user.rows[0][6] = 1;
    const r = checkAccountsBackfill(db);
    expect(r.admins).toBe(1);
    expect(r.problems).toEqual(["1 user(s) are admins; an upgrade makes nobody an admin"]);
  });

  it("a session, a code, a counter or an audit row from the migration fails, and so does a missing table or column", () => {
    for (const t of ["session", "signin_code", "rate_counter", "audit"]) {
      const db = migratedDb();
      db[t].rows.push(["x"]);
      expect(checkAccountsBackfill(db).problems, t).toEqual([`table ${t} holds 1 row(s); it must start empty`]);
    }
    const noTable = migratedDb();
    delete (noTable as Partial<DbSnapshot>).session;
    expect(checkAccountsBackfill(noTable).problems).toEqual(["table session is missing"]);
    const noColumn = migratedDb();
    noColumn.user = { columns: noColumn.user.columns.slice(0, 6), rows: noColumn.user.rows.map((r) => r.slice(0, 6)) };
    expect(checkAccountsBackfill(noColumn).problems).toContain("column user.is_admin is missing");
  });

  it("a username or a status other than active fails", () => {
    const db = migratedDb();
    db.user.rows[0][4] = "owner";
    db.user.rows[0][5] = "disabled";
    expect(checkAccountsBackfill(db).problems).toEqual(["1 user(s) are not active", "1 user(s) have a username"]);
  });
});

describe("migrations, usage, pages and tokens", () => {
  const all = ["0001_init.sql", "0002_guide_cards.sql", "0008_accounts.sql"];

  it("the applied list must be exactly the expected one, each once", () => {
    expect(migrationProblems(all, all)).toEqual([]);
    expect(migrationProblems([...all, "0008_accounts.sql"], all)).toEqual(["0008_accounts.sql is recorded 2 times"]);
    expect(migrationProblems(all.slice(0, 2), all)).toEqual(["0008_accounts.sql is not recorded"]);
    expect(migrationProblems([...all, "0009_x.sql"], all)).toEqual(["0009_x.sql is recorded but not expected"]);
  });

  it("the usage must equal the sum of the rows, part by part", () => {
    const db: DbSnapshot = {
      tour: { columns: ["id", "workspace_id", "logo_bytes"], rows: [["t1", WS, 100], ["t2", WS, null], ["t3", "ws_other", 5]] },
      step: { columns: ["id", "tour_id", "bytes"], rows: [["s1", "t1", 10], ["s2", "t2", 20], ["s3", "t3", 999]] },
      upload: { columns: ["id", "workspace_id", "closing_at", "reserved_bytes"], rows: [["u1", WS, null, 7], ["u2", WS, 5, 1000], ["u3", "ws_other", null, 3]] },
    };
    const sum = usageFromRows(db, WS);
    expect(sum).toEqual({ pictures: 30, logos: 100, uploads: 7, media: 0, used: 137, tours: 2 });
    // Shared items that are not closing count in used_bytes, with their previews.
    const withItems: DbSnapshot = {
      ...db,
      media: { columns: ["id", "workspace_id", "state", "bytes"], rows: [["m1", WS, "online", 50], ["m2", WS, "uploading", 20], ["m3", WS, "closing", 900], ["m4", "ws_other", "online", 7]] },
      media_object: { columns: ["media_id", "n", "bytes"], rows: [["m1", -1, 5], ["m1", 0, 50], ["m3", -1, 9], ["m4", -1, 3]] },
    };
    // Items count until their rows go, closing ones too, with every preview claim; parts are in the item's bytes.
    expect(usageFromRows(withItems, WS)).toEqual({ pictures: 30, logos: 100, uploads: 7, media: 984, used: 1121, tours: 2 });
    const good = answer(200, JSON.stringify({ used_bytes: 137, allowance_bytes: null, over: false, tours: 2, counted: { pictures: 30, logos: 100, uploads_in_progress: 7 } }));
    expect(usageProblems(good, sum)).toEqual([]);
    const off = answer(200, JSON.stringify({ used_bytes: 136, allowance_bytes: null, over: false, tours: 2, counted: { pictures: 29, logos: 100, uploads_in_progress: 7 } }));
    expect(usageProblems(off, sum)).toEqual(["used_bytes differs from the sum of the rows", "counted.pictures differs from the sum of step sizes"]);
    expect(usageProblems(answer(404, '{"error":"not_found"}'), sum)).toEqual(["usage answered 404"]);
  });

  it("a page's pictures are every step image and the cover logo, after the page's base", () => {
    const data = { base: "", tour: { cover: { logo: "p/logo.png" }, chapters: [{ steps: [{ image: "p/a.png" }, { image: "p/b.jpg" }] }, { steps: [{ image: "p/c.png" }] }] } };
    const html = `<html><body><script type="application/json" id="tour">${JSON.stringify(data).replace(/</g, "\\u003c")}</script></body></html>`;
    expect(pictureAddresses(html)).toEqual(["/p/a.png", "/p/b.jpg", "/p/c.png", "/p/logo.png"]);
    expect(pictureAddresses("<html>no tour</html>")).toBeNull();
  });

  it("tokens come from the environment and a malformed one is refused without being repeated", () => {
    const t1 = "dp_" + "1".repeat(40);
    const t2 = "dp_" + "a".repeat(40);
    expect(readTokens({ REHEARSE_TOKENS: `${t1}, ${t2}\n` }, null)).toEqual([t1, t2]);
    expect(() => readTokens({}, null)).toThrow(/at least one token/);
    let message = "";
    try {
      readTokens({ REHEARSE_TOKENS: `${t1} dp_secretvalue` }, null);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe("token 2 is not a token (dp_ and 40 lowercase hex characters)");
  });
});
