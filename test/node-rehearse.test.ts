// The comparisons of the upgrade rehearsal (scripts/rehearse-compare.ts), without starting
// any build: the allow-list lets through the date header, the version value and (from the
// old build to the new one only) fields a JSON answer adds and the player's file names in a
// tour page, and every kind of real difference fails. The address modes are checked on build folders made here and against a
// stand-in server on 127.0.0.1. The full rehearsal starts the builds themselves and is run
// on its own: npm run rehearse:upgrade.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import {
  checkAccountsBackfill,
  compareAnswers,
  onlyAddedFields,
  compareRows,
  compareStores,
  identityProblems,
  migrationProblems,
  playerFileProblems,
  playerFilesIn,
  playerNamesOnly,
  storesSame,
  usageFromRows,
  usageProblems,
  type Answer,
  type DbSnapshot,
  type Recorded,
  type StoreListing,
} from "../scripts/rehearse-compare.ts";
import {
  buildModes,
  checkPlayerFiles,
  CLIENT_ADDRESS,
  errorLineProblems,
  fetchAnswer,
  freePort,
  healthHosts,
  healthRoles,
  KNOWN_ERROR_LINES,
  knowsImgRole,
  modeSettings,
  parseArgs,
  pictureAddresses,
  PROXY_SETTINGS,
  readTokens,
  recordSite,
  refusalLine,
  resultLine,
  spawnBuild,
  startPair,
  stopBuild,
  waitReady,
  type Mode,
  type Running,
} from "../scripts/rehearse-upgrade.ts";
import { configFromEnv, mailFromEnv, PROXY_HINT } from "../src/node/config.ts";
import { linkOrigin, NO_MAIL } from "../src/mail.ts";
import { NOT_FOUND_HTML, pageHtml, type PageTour } from "../src/page.ts";
import { PLAYER_CSS_PATH, PLAYER_JS_PATH } from "../src/player/assets.ts";
import { RESTRICT_SETTINGS, scratchSession } from "../scripts/rehearse-upgrade.ts";
import { createApp } from "../src/app.ts";
import { NodeDb } from "../src/node/db.ts";
import { NodeFileStore } from "../src/node/files.ts";
import { migrate } from "../src/node/migrate.ts";
import { createWorkspace } from "../src/workspaces.ts";

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
    expect(c).toEqual({ identical: 6, allowed: 0, playerNames: 0, addedFields: 0, addedFieldsByRoute: {}, added: [], problems: [] });
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

describe("answers that only add fields", () => {
  const ADD = { allowAddedFields: true };
  const usage = (body: unknown, headers: Record<string, string> = {}) => [rec("token 1: usage (one address)", "GET /api/v1/usage", answer(200, JSON.stringify(body), headers))];
  const OLD = { used_bytes: 1500, tours: 2, counted: { pictures: 1000, logos: 500 } };
  const compare = (before: unknown, after: unknown) => compareAnswers(usage(before), usage(after), ADD);

  it("an added top-level key is allowed, counted apart and named by its path, and content-length follows it", () => {
    const c = compare(OLD, { ...OLD, images: 3 });
    expect(c).toEqual({ identical: 0, allowed: 0, playerNames: 0, addedFields: 1, addedFieldsByRoute: { "GET /api/v1/usage": ["images"] }, added: [], problems: [] });
  });

  it("an added nested key is allowed, named by its full path", () => {
    const c = compare(OLD, { ...OLD, counted: { ...OLD.counted, images: 10, gifs: 20 }, gifs: 1 });
    expect(c.problems).toEqual([]);
    expect(c.addedFieldsByRoute).toEqual({ "GET /api/v1/usage": ["counted.gifs", "counted.images", "gifs"] });
  });

  it("a key added inside every element of an array is allowed and named once, and once per route across answers", () => {
    const tours = (extra: (i: number) => Record<string, unknown>) => ({ tours: [1, 2, 3].map((i) => ({ id: `tour_${i}`, slug: `slug${i}`, meta: { n: i }, ...extra(i) })) });
    const before = [rec("token 1: tour list (app address)", "GET /api/v1/tours", answer(200, JSON.stringify(tours(() => ({}))))), rec("token 1: tour list (tours address)", "GET /api/v1/tours", answer(200, JSON.stringify(tours(() => ({})))))];
    const after = [rec("token 1: tour list (app address)", "GET /api/v1/tours", answer(200, JSON.stringify(tours((i) => ({ views: i * 7 }))))), rec("token 1: tour list (tours address)", "GET /api/v1/tours", answer(200, JSON.stringify(tours((i) => (i === 2 ? { views: 1, kind: "tour" } : { views: 0 })))))];
    const c = compareAnswers(before, after, ADD);
    expect(c.problems).toEqual([]);
    expect(c.addedFields).toBe(2);
    expect(c.addedFieldsByRoute).toEqual({ "GET /api/v1/tours": ["tours[].kind", "tours[].views"] });
  });

  it("the paths never hold a value, and an existing key that is not shaped like a field name is written as *", () => {
    const secret = "owner@example.com";
    const ID = "med_" + "1".repeat(24);
    const c = compare({ by_id: { [ID]: { title: "Acme" } } }, { by_id: { [ID]: { title: "Acme", note: secret } } });
    expect(c.problems).toEqual([]);
    expect(c.addedFieldsByRoute).toEqual({ "GET /api/v1/usage": ["by_id.*.note"] });
    expect(JSON.stringify(c)).not.toContain("example.com");
    expect(JSON.stringify(c)).not.toContain(ID);
  });

  it("an added key that is not shaped like a field name fails the answer and is never printed: an item id, a token, a slug, digits, capitals, too long", () => {
    const keys = {
      item: "med_" + "a1".repeat(12),
      token: "dp_" + "0123456789abcdef0123456789abcdef01234567",
      slug: "q8d2abcdefghijklmnop",
      digits: "images2",
      capitals: "Images",
      dashed: "used-bytes",
      long: "a".repeat(41),
      email: "owner@example.com",
    };
    for (const [what, key] of Object.entries(keys)) {
      // At the top, nested, and inside the elements of an array.
      for (const [before, after] of [
        [OLD, { ...OLD, [key]: 1 }],
        [OLD, { ...OLD, counted: { ...OLD.counted, [key]: { bytes: 1 } } }],
        [{ items: [{ id: "a" }] }, { items: [{ id: "a", [key]: true }] }],
      ] as [unknown, unknown][]) {
        const c = compare(before, after);
        expect(c.addedFields, what).toBe(0);
        expect(c.problems, what).toHaveLength(1);
        expect(c.problems[0], what).toMatch(/, an added key that is not shaped like a field name$/);
        const report = JSON.stringify(c);
        expect(report, what).not.toContain(key);
        if (what !== "digits" && what !== "capitals") expect(report, what).not.toContain(key.slice(0, 8));
      }
    }
    // One bad key fails the answer even beside good ones; a field name of 40 characters is still one.
    expect(compare(OLD, { ...OLD, images: 1, [keys.item]: 1 }).problems).toHaveLength(1);
    expect(compare(OLD, { ...OLD, ["a_" + "b".repeat(38)]: 1 }).problems).toEqual([]);
  });

  it("the bytes must be the plain JSON of their values: a number written another way, -0, a duplicate key, a BOM, spaces or reordered old keys fail even beside an added key", () => {
    const raw = (before: string, after: string) => compareAnswers([rec("u", "GET /api/v1/usage", answer(200, before))], [rec("u", "GET /api/v1/usage", answer(200, after))], ADD);
    // The plain cases pass.
    expect(raw('{"a":1,"b":"x"}', '{"a":1,"b":"x","c":2}').problems).toEqual([]);
    expect(raw('{"a":1,"b":"x"}', '{"c":2,"a":1,"b":"x"}').problems).toEqual([]);
    // A big integer that changed past what a double holds, and one that cannot be held at all.
    expect(raw('{"n":9007199254740993}', '{"n":9007199254740992,"c":1}').problems).toHaveLength(1);
    expect(raw('{"n":9007199254740993}', '{"n":9007199254740993,"c":1}').problems).toHaveLength(1);
    // 1 and 1.0, 0 and -0, 100 and 1e2.
    expect(raw('{"n":1}', '{"n":1.0,"c":1}').problems).toHaveLength(1);
    expect(raw('{"n":0}', '{"n":-0,"c":1}').problems).toHaveLength(1);
    expect(raw('{"n":100}', '{"n":1e2,"c":1}').problems).toHaveLength(1);
    // A duplicate key in the raw text, old or new.
    expect(raw('{"a":1}', '{"a":2,"a":1,"c":1}').problems).toHaveLength(1);
    expect(raw('{"a":2,"a":1}', '{"a":1,"c":1}').problems).toHaveLength(1);
    // A byte order mark, and spaces.
    expect(raw('{"a":1}', '\uFEFF{"a":1,"c":1}').problems).toHaveLength(1);
    expect(raw('{"a":1}', '{"a": 1,"c":1}').problems).toHaveLength(1);
    // Old keys in another order.
    expect(raw('{"a":1,"b":2}', '{"b":2,"a":1,"c":1}').problems).toHaveLength(1);
    expect(raw('{"o":{"a":1,"b":2}}', '{"o":{"b":2,"a":1},"c":1}').problems).toHaveLength(1);
    // A string written with an escape it does not need.
    expect(raw('{"s":"a"}', '{"s":"\\u0061","c":1}').problems).toHaveLength(1);
  });

  it("a changed value beside an added key fails, and the problem names no value", () => {
    const c = compare(OLD, { ...OLD, used_bytes: 1501, images: 3 });
    expect(c.addedFields).toBe(0);
    expect(c.problems).toHaveLength(1);
    expect(c.problems[0]).toMatch(/^token 1: usage \(one address\): header content-length differs, body differs \(\d+ and \d+ bytes\)$/);
    // Deeper, and a changed type (a number that became a string) fails too.
    expect(compare(OLD, { ...OLD, counted: { pictures: 1000, logos: 499, images: 1 } }).problems).toHaveLength(1);
    expect(compare(OLD, { ...OLD, tours: "2", images: 1 }).problems).toHaveLength(1);
    expect(compare({ a: null }, { a: {}, b: 1 }).problems).toHaveLength(1);
    expect(compare({ a: [1] }, { a: { 0: 1 }, b: 1 }).problems).toHaveLength(1);
  });

  it("a removed key fails, even beside an added one", () => {
    const { tours: _gone, ...rest } = OLD;
    expect(compare(OLD, rest).problems).toHaveLength(1);
    expect(compare(OLD, { ...rest, images: 1 }).problems).toHaveLength(1);
    expect(compare(OLD, { ...OLD, counted: { pictures: 1000, images: 1 } }).problems).toHaveLength(1);
  });

  it("an array whose length changes fails, and so does a changed element", () => {
    expect(compare({ tours: [{ id: "a" }, { id: "b" }] }, { tours: [{ id: "a", x: 1 }] }).problems).toHaveLength(1);
    expect(compare({ tours: [{ id: "a" }] }, { tours: [{ id: "a" }, { id: "b" }] }).problems).toHaveLength(1);
    expect(compare({ tours: [{ id: "a" }, { id: "b" }] }, { tours: [{ id: "b", x: 1 }, { id: "a", x: 1 }] }).problems).toHaveLength(1);
  });

  it("a changed status or another header fails, and content-length may differ only with an allowed body", () => {
    const b = usage(OLD);
    const status = [rec(b[0].key, b[0].route, { ...answer(201, JSON.stringify({ ...OLD, images: 1 })) })];
    expect(compareAnswers(b, status, ADD).problems).toHaveLength(1);
    expect(compareAnswers(b, usage({ ...OLD, images: 1 }, { etag: '"x"' }), ADD).problems).toHaveLength(1);
    // The same body with another content-length is not an added field.
    const sameBody = usage(OLD);
    sameBody[0].answer.headers["content-length"] = "9999";
    expect(compareAnswers(b, sameBody, ADD).problems).toEqual(["token 1: usage (one address): header content-length differs"]);
  });

  it("a non-JSON answer stays byte-exact, even when its text would parse as JSON with an added key", () => {
    const page = (body: string) => [rec("token 1: tour 1 page", "GET /t/:slug", answer(200, body, { "content-type": "text/html; charset=utf-8" }))];
    expect(compareAnswers(page('{"a":1}'), page('{"a":1,"b":2}'), ADD).problems).toHaveLength(1);
    expect(compareAnswers(page("<p>a</p>"), page("<p>a</p><p>b</p>"), ADD).problems).toHaveLength(1);
    // A JSON content type whose body is not JSON: compared byte for byte, and it fails.
    expect(compareAnswers(usage(OLD), [rec("token 1: usage (one address)", "GET /api/v1/usage", answer(200, "{not json"))], ADD).problems).toHaveLength(1);
  });

  it("the version swap and added fields together on the workspace answer are allowed", () => {
    const me = (v: string, extra = "") => [rec("token 1: workspace (one address)", "GET /api/v1/me", answer(200, `{"workspace":"Acme","version":"${v}"${extra}}`))];
    const c = compareAnswers(me("0.1.24"), me("0.1.25", ',"region":"eu"'), ADD);
    expect(c.problems).toEqual([]);
    expect(c.addedFieldsByRoute).toEqual({ "GET /api/v1/me": ["region"] });
  });

  it("without the allowance (the way back, the same build twice) an added field is a difference like any other", () => {
    const c = compareAnswers(usage(OLD), usage({ ...OLD, images: 3 }));
    expect(c.addedFields).toBe(0);
    expect(c.problems).toHaveLength(1);
  });
});

describe("tour pages that differ only in the player's file names", () => {
  // Two builds' names: the player's script changed between them, its stylesheet did not.
  const JS_A = "/player.7ddc1a5921f8bd94.js";
  const JS_B = "/player.399e3f2c7b7c723a.js";
  const CSS_A = "/player.b5cf31940e7c03b2.css";
  const CSS_B = "/player.00112233445566ff.css";
  const NEW = { allowAddedFields: true, allowPlayerNames: true };
  const IMAGE = "p/" + "a".repeat(32) + ".png";
  type PageOpts = { js?: string; css?: string; title?: string; image?: string; text?: string; etag?: string | null; headers?: Record<string, string>; status?: number; route?: string; type?: string };

  /** A tour page as the server writes it (pageHtml), with the player's names of the given build in its two tags, and the etag a hash of the body as the server's is. */
  function pageBody(o: PageOpts = {}): string {
    const tour = { title: o.title ?? "Send an invoice", chapters: [{ steps: [{ image: o.image ?? IMAGE, text: o.text ?? "Click New" }] }] } as unknown as PageTour;
    const html = pageHtml(tour, "");
    expect(html).toContain(`<script src="${PLAYER_JS_PATH}" defer></script>`);
    return html.replace(`<script src="${PLAYER_JS_PATH}" defer>`, `<script src="${o.js ?? JS_A}" defer>`).replace(`<link rel="stylesheet" href="${PLAYER_CSS_PATH}">`, `<link rel="stylesheet" href="${o.css ?? CSS_A}">`);
  }
  const etagOf = (body: string) => `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
  function page(o: PageOpts = {}, body = pageBody(o)): Recorded[] {
    const headers: Record<string, string> = { "content-type": o.type ?? "text/html; charset=utf-8", "cache-control": "public, max-age=60", "content-security-policy": "default-src 'none'", ...o.headers };
    if (o.etag !== null) headers.etag = o.etag ?? etagOf(body);
    return [rec("token 1: tour 1 page", o.route ?? "GET /t/:slug", answer(o.status ?? 200, body, headers))];
  }
  const fails = (before: Recorded[], after: Recorded[]) => {
    const c = compareAnswers(before, after, NEW);
    expect(c.playerNames).toBe(0);
    expect(c.problems).toHaveLength(1);
    return c.problems[0];
  };

  it("a page whose script name (or both names) changed is allowed, counted apart, its etag let follow, and no name is printed", () => {
    const c = compareAnswers(page(), page({ js: JS_B }), NEW);
    expect(c).toEqual({ identical: 0, allowed: 0, playerNames: 1, addedFields: 0, addedFieldsByRoute: {}, added: [], problems: [] });
    expect(page()[0].answer.headers.etag).not.toBe(page({ js: JS_B })[0].answer.headers.etag);
    expect(compareAnswers(page(), page({ js: JS_B, css: CSS_B }), NEW).playerNames).toBe(1);
    expect(compareAnswers(page(), page({ css: CSS_B }), NEW).playerNames).toBe(1);
    for (const name of [JS_A, JS_B, CSS_A, CSS_B]) expect(JSON.stringify(c)).not.toContain(name.slice(8, 24));
    // The not-found page names the stylesheet in the same tag.
    const notFound = (css: string) => [rec("token 1: tour 2 page", "GET /t/:slug", answer(404, NOT_FOUND_HTML.replace(PLAYER_CSS_PATH, css), { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }))];
    expect(compareAnswers(notFound(CSS_A), notFound(CSS_B), NEW).playerNames).toBe(1);
  });

  it("without the allowance (the way back, two runs of the same build) a changed name is a difference like any other", () => {
    for (const opts of [{}, { allowAddedFields: true }]) {
      const c = compareAnswers(page(), page({ js: JS_B }), opts);
      expect(c.playerNames).toBe(0);
      const n = new TextEncoder().encode(pageBody()).length;
      expect(c.problems).toEqual([`token 1: tour 1 page: header etag differs, body differs (${n} and ${n} bytes)`]);
    }
  });

  it("identical bodies with a differing etag still fail, allowance or not", () => {
    expect(fails(page({ etag: '"a"' }), page({ etag: '"b"' }))).toBe("token 1: tour 1 page: header etag differs");
    expect(fails(page({ etag: '"a"' }), page({ etag: null }))).toBe("token 1: tour 1 page: header etag missing");
    // An etag on one side only, beside changed names.
    expect(fails(page(), page({ js: JS_B, etag: null }))).toMatch(/header etag missing/);
  });

  it("with changed names, each side's etag must be its own page's, by the server's rule (a quoted SHA-256 of the page, 32 hex digits)", () => {
    const oldPage = page();
    const oldEtag = oldPage[0].answer.headers.etag;
    // The correct pair: each etag the hash of its own body.
    expect(oldEtag).toBe(etagOf(pageBody()));
    expect(compareAnswers(oldPage, page({ js: JS_B }), NEW).playerNames).toBe(1);
    // A stale etag on the new side: the old page's, kept for a changed page.
    expect(fails(oldPage, page({ js: JS_B, etag: oldEtag }))).toMatch(/^token 1: tour 1 page: body differs/);
    // A fixed etag on both sides, the same or not.
    expect(fails(page({ etag: '"x"' }), page({ js: JS_B, etag: '"x"' }))).toMatch(/body differs/);
    expect(fails(page({ etag: '"x"' }), page({ js: JS_B, etag: '"y"' }))).toMatch(/header etag differs/);
    // A wrong etag on the old side only (here the new page's), the new one right.
    expect(fails(page({ etag: etagOf(pageBody({ js: JS_B })) }), page({ js: JS_B }))).toMatch(/^token 1: tour 1 page: body differs/);
    expect(fails(page({ etag: '"x"' }), page({ js: JS_B }))).toMatch(/header etag differs/);
    // The same hash written another way: weak, unquoted, capitals, or the whole 64 digits.
    const hex = etagOf(pageBody({ js: JS_B })).slice(1, -1);
    const full = createHash("sha256").update(pageBody({ js: JS_B })).digest("hex");
    for (const etag of [`W/"${hex}"`, hex, `"${hex.toUpperCase()}"`, `"${full}"`]) expect(fails(oldPage, page({ js: JS_B, etag })), etag).toMatch(/body differs/);
  });

  it("a changed picture address, title or step text fails, with or without a changed player name", () => {
    const other = "p/" + "b".repeat(32) + ".png";
    for (const js of [JS_A, JS_B]) {
      expect(fails(page(), page({ js, image: other }))).toMatch(/^token 1: tour 1 page: header etag differs, body differs/);
      expect(fails(page(), page({ js, title: "Send an invoicf" }))).toMatch(/body differs/);
      expect(fails(page(), page({ js, text: "Click Old" }))).toMatch(/body differs/);
    }
  });

  it("any other header that changes, appears or goes fails, and so does a status, a content type or a route other than a tour page's", () => {
    expect(fails(page(), page({ js: JS_B, headers: { "cache-control": "no-store" } }))).toMatch(/header cache-control differs/);
    expect(fails(page(), page({ js: JS_B, headers: { "content-security-policy": "default-src *" } }))).toMatch(/header content-security-policy differs/);
    expect(fails(page(), page({ js: JS_B, headers: { "set-cookie": "a=1" } }))).toMatch(/header set-cookie added/);
    expect(fails(page({ headers: { "x-extra": "1" } }), page({ js: JS_B }))).toMatch(/header x-extra missing/);
    expect(fails(page(), page({ js: JS_B, status: 404 }))).toMatch(/status 200 became 404/);
    expect(fails(page({ type: "text/plain" }), page({ js: JS_B, type: "text/plain" }))).toMatch(/body differs/);
    expect(fails(page({ route: "GET /p/:name" }), page({ js: JS_B, route: "GET /p/:name" }))).toMatch(/body differs/);
    expect(playerNamesOnly("GET /t/:slug", page()[0].answer, page({ js: JS_B })[0].answer)).toBe(true);
    expect(playerNamesOnly("GET /api/v1/me", page()[0].answer, page({ js: JS_B })[0].answer)).toBe(false);
  });

  it("customer text shaped like a player name is never swapped: changed, it fails; the same on both sides, it stays the same", () => {
    const shaped = (h: string) => `/player.${h}.js`;
    const tag = (h: string) => `<script src="${shaped(h)}" defer></script>`;
    const h1 = "0123456789abcdef";
    const h2 = "fedcba9876543210";
    // In the title (escaped in the page) and in a step's text (inside the page's JSON), bare or as a whole tag.
    for (const [x, y] of [[shaped(h1), shaped(h2)], [tag(h1), tag(h2)]]) {
      for (const js of [JS_A, JS_B]) {
        expect(fails(page({ title: x }), page({ js, title: y }))).toMatch(/body differs/);
        expect(fails(page({ text: x }), page({ js, text: y }))).toMatch(/body differs/);
      }
      // Unchanged customer text of that shape: only the server's own tag differs, which is allowed.
      expect(compareAnswers(page({ title: x, text: x }), page({ js: JS_B, title: x, text: x }), NEW).playerNames).toBe(1);
    }
    // The escaping that keeps it so: no customer text makes a tag of the server's.
    expect(pageBody({ title: tag(h1), text: tag(h1) }).split(tag(h1)).length).toBe(1);
  });

  it("only the page's own tags exactly as the server writes them are swapped: the name in another tag, a second tag or other markup fails", () => {
    const html = (head: string) => `<!doctype html>\n<head>\n${head}\n</head>\n`;
    const raw = (head: string) => page({}, html(head));
    // A bare name in another attribute or tag.
    expect(fails(raw(`<a href="${JS_A}">x</a>`), raw(`<a href="${JS_B}">x</a>`))).toMatch(/body differs/);
    // The tag written another way (no defer, other quotes, another attribute order).
    expect(fails(raw(`<script src="${JS_A}"></script>`), raw(`<script src="${JS_B}"></script>`))).toMatch(/body differs/);
    expect(fails(raw(`<script src='${JS_A}' defer></script>`), raw(`<script src='${JS_B}' defer></script>`))).toMatch(/body differs/);
    expect(fails(raw(`<link href="${CSS_A}" rel="stylesheet">`), raw(`<link href="${CSS_B}" rel="stylesheet">`))).toMatch(/body differs/);
    // A name of another shape: capitals, or 15 hex digits and a letter more elsewhere.
    expect(fails(raw(`<script src="/player.7DDC1A5921F8BD94.js" defer></script>`), raw(`<script src="/player.399E3F2C7B7C723A.js" defer></script>`))).toMatch(/body differs/);
    expect(fails(raw(`<script src="/player.7ddc1a5921f8bd9.js" defer></script>x`), raw(`<script src="/player.399e3f2c7b7c723.js" defer></script>x`))).toMatch(/body differs/);
    // The same tag twice.
    const two = (a: string, b: string) => `<script src="${a}" defer></script><script src="${b}" defer></script>`;
    expect(fails(raw(two(JS_A, JS_A)), raw(two(JS_B, JS_B)))).toMatch(/body differs/);
    // One side has the tag, the other has it in a form the server does not write.
    expect(fails(raw(`<script src="${JS_A}" defer></script>`), raw(`<script src="${JS_B}" async></script>`))).toMatch(/body differs/);
    // The one allowed form, on its own, passes.
    expect(compareAnswers(raw(`<script src="${JS_A}" defer></script>`), raw(`<script src="${JS_B}" defer></script>`), NEW).playerNames).toBe(1);
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
      media_object: { columns: ["media_id", "n", "bytes", "current"], rows: [["m1", -1, 5, 1], ["m1", 0, 50, 1], ["m1", 0, 40, 0], ["m3", -1, 9, 0], ["m4", -1, 3, 1]] },
    };
    // Items count until their rows go, closing ones too, with every claim but a current part's (the item's bytes hold those).
    expect(usageFromRows(withItems, WS)).toEqual({ pictures: 30, logos: 100, uploads: 7, media: 1024, used: 1161, tours: 2 });
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

describe("the report's last line", () => {
  it("a pass with added fields says how many there are to read; a plain pass and a failure are as before", () => {
    expect(resultLine(0, 0)).toBe("RESULT: PASS");
    expect(resultLine(0, 4)).toBe("RESULT: PASS, with 4 added fields to read above");
    expect(resultLine(0, 1)).toBe("RESULT: PASS, with 1 added field to read above");
    expect(resultLine(2, 4)).toBe("RESULT: FAIL (2 checks failed)");
    expect(resultLine(1, 0)).toBe("RESULT: FAIL (1 check failed)");
  });
});

describe("the address modes", () => {
  it("one, two or three, from --mode or REHEARSE_MODE; anything else is refused", () => {
    const pos = ["data", "old", "new"];
    expect(parseArgs([...pos], {}).mode).toBe("one");
    expect(parseArgs([...pos, "--mode", "three"], {}).mode).toBe("three");
    expect(parseArgs([...pos, "--mode=three"], {}).mode).toBe("three");
    expect(parseArgs([...pos], { REHEARSE_MODE: " three " }).mode).toBe("three");
    expect(parseArgs([...pos, "--mode", "two"], { REHEARSE_MODE: "three" }).mode).toBe("two");
    expect(() => parseArgs([...pos, "--mode", "four"], {})).toThrow("the mode is one, two or three");
  });

  it("three sets the img address beside the two, and every address of a mode is checked for health", () => {
    expect(modeSettings("one")).toEqual({});
    expect(modeSettings("two")).toEqual({ TOURS_HOST: "tours.example.com", APP_HOST: "app.example.com" });
    expect(modeSettings("three")).toEqual({ TOURS_HOST: "tours.example.com", APP_HOST: "app.example.com", IMG_HOST: "img.example.com" });
    expect(healthHosts("one")).toEqual(["localhost"]);
    expect(healthHosts("two")).toEqual(["tours.example.com", "app.example.com"]);
    expect(healthHosts("three")).toEqual(["tours.example.com", "app.example.com", "img.example.com"]);
  });

  describe("whether a build knows the img address, from its compiled files", () => {
    /** A build folder holding only the two files knowsImgRole reads, compiled from the given TypeScript as tsc would emit them. */
    function buildWith(hostsTs: string | null, configTs: string | null): string {
      const dir = mkdtempSync(join(tmpdir(), "rehearse-build-"));
      mkdirSync(join(dir, "dist", "node"), { recursive: true });
      const js = (ts: string) => transformSync(ts, { loader: "ts", format: "esm" }).code;
      if (hostsTs !== null) writeFileSync(join(dir, "dist", "hosts.js"), js(hostsTs));
      if (configTs !== null) writeFileSync(join(dir, "dist", "node", "config.js"), js(configTs));
      return dir;
    }
    const today = { hosts: readFileSync(new URL("../src/hosts.ts", import.meta.url), "utf8"), config: readFileSync(new URL("../src/node/config.ts", import.meta.url), "utf8") };
    // What 0.1.18 had: two roles, and settings that do not read IMG_HOST.
    const before = {
      hosts: 'export const HOST_ROLES = ["tours", "app"] as const;\nexport type HostRole = (typeof HOST_ROLES)[number];\n// IMG_HOST is not a setting here; "img" is no role.\n',
      config: 'const ALLOWED = ["DATA_DIR", "PORT", "TOURS_HOST", "APP_HOST", "INVITE_CONTACT"];\nexport const allowed = ALLOWED;\n',
    };

    it("this checkout's build knows it; one shaped like 0.1.18 does not", () => {
      const dirs = [buildWith(today.hosts, today.config), buildWith(before.hosts, before.config)];
      try {
        expect(knowsImgRole(dirs[0])).toBe(true);
        expect(knowsImgRole(dirs[1])).toBe(false);
      } finally {
        for (const d of dirs) rmSync(d, { recursive: true, force: true });
      }
    });

    it("both are needed: the img role and the setting read on Node; a missing file means it does not", () => {
      const dirs = [buildWith(today.hosts, before.config), buildWith(before.hosts, today.config), buildWith(null, today.config), buildWith(today.hosts, null)];
      try {
        for (const d of dirs) expect(knowsImgRole(d)).toBe(false);
        expect(knowsImgRole(join(tmpdir(), "no-such-build-folder-for-the-rehearsal"))).toBe(false);
      } finally {
        for (const d of dirs) rmSync(d, { recursive: true, force: true });
      }
    });
  });

  it("with three, an old build that does not know the img address runs with two, and the report says so in one line", () => {
    const knows = (version: string) => ({ version, knowsImg: true });
    const not = (version: string) => ({ version, knowsImg: false });
    expect(buildModes("three", knows("0.1.24"), knows("0.1.25"))).toEqual({ old: "three", next: "three", note: null });
    const mixed = buildModes("three", not("0.1.18"), knows("0.1.25"));
    expect(mixed).toEqual({ old: "two", next: "three", note: "the old build 0.1.18 does not know the img address, which came in 0.1.19: it runs with two addresses, the new build with three" });
    expect(mixed.note).not.toContain("\n");
    expect(() => buildModes("three", knows("0.1.24"), not("0.1.18"))).toThrow("the new build 0.1.18 does not know the img address (IMG_HOST, from 0.1.19); rehearse it with --mode two");
    // The other modes are as asked, whatever the builds know.
    for (const m of ["one", "two"] as Mode[]) expect(buildModes(m, not("0.1.7"), not("0.1.8"))).toEqual({ old: m, next: m, note: null });
  });

  describe("against a stand-in server on 127.0.0.1", () => {
    const TOKEN_1 = "dp_" + "1".repeat(40);
    type Seen = { method: string; path: string; host: string };

    /**
     * Answers every route the rehearsal asks, the same on every address: one listed tour whose
     * page names one picture. Its health answer reports, for each host, the address `roles`
     * gives (none when it gives none), as a build reports the role it sees a host in.
     */
    async function standIn(roles: Record<string, string> = {}): Promise<{ server: Server; port: number; seen: Seen[] }> {
      const seen: Seen[] = [];
      const server = createServer((req, res) => {
        seen.push({ method: req.method ?? "", path: req.url ?? "", host: req.headers.host ?? "" });
        const json = (body: unknown) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (req.url === "/healthz") return json(roles[req.headers.host ?? ""] === undefined ? { ok: true } : { ok: true, address: roles[req.headers.host ?? ""] });
        if (req.url === "/api/v1/tours") return json({ tours: [{ id: "tour_1", slug: "abcdefghij" }] });
        if (req.url === "/t/abcdefghij") {
          res.writeHead(200, { "content-type": "text/html" });
          return res.end(`<script type="application/json" id="tour">${JSON.stringify({ base: "", tour: { chapters: [{ steps: [{ image: "p/a.png" }] }] } })}</script>`);
        }
        json({ ok: true });
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      const a = server.address();
      return { server, port: typeof a === "object" && a !== null ? a.port : 0, seen };
    }

    it("three asks the very requests of two, on the tours and app addresses, and the img address only for its health", async () => {
      const { server, port, seen } = await standIn();
      try {
        const two = await recordSite(port, "two", [TOKEN_1]);
        const twoSeen = seen.splice(0);
        const three = await recordSite(port, "three", [TOKEN_1]);
        const threeSeen = seen.splice(0);
        expect(three.map((r) => [r.key, r.route])).toEqual(two.map((r) => [r.key, r.route]));
        expect(threeSeen).toEqual(twoSeen);
        expect(new Set(threeSeen.map((s) => s.host))).toEqual(new Set(["tours.example.com", "app.example.com"]));
        expect(three.map((r) => r.key)).toContain("health (tours address)");
        expect(three.map((r) => r.key)).toContain("health (app address)");
        expect(three.map((r) => r.key)).toContain("token 1: tour 1 page (app address)");
        // Starting: health on each of the three addresses.
        const r = { port, out: [`rehearse-bound 127.0.0.1 ${port}`], err: [], exited: new Promise<number | null>(() => {}), startedAt: Date.now() } as unknown as Running;
        await waitReady(r, healthHosts("three"));
        expect(seen.map((s) => [s.path, s.host])).toEqual([["/healthz", "tours.example.com"], ["/healthz", "app.example.com"], ["/healthz", "img.example.com"]]);
      } finally {
        server.close();
      }
    });

    /** A started build as waitReady sees it, on the stand-in's port. */
    const started = (port: number) => ({ port, out: [`rehearse-bound 127.0.0.1 ${port}`], err: [], exited: new Promise<number | null>(() => {}), startedAt: Date.now() }) as unknown as Running;
    const RIGHT = { "tours.example.com": "tours", "app.example.com": "app", "img.example.com": "img" };

    it("with two or three addresses, each host must answer health as its own address; with one, the answer is taken as today", async () => {
      expect(healthRoles("one")).toEqual([null]);
      expect(healthRoles("two")).toEqual(["tours", "app"]);
      expect(healthRoles("three")).toEqual(["tours", "app", "img"]);
      const { server, port } = await standIn(RIGHT);
      try {
        for (const m of ["two", "three"] as Mode[]) await waitReady(started(port), healthHosts(m), healthRoles(m));
      } finally {
        server.close();
      }
      // One address: a build answers no address, as every build does today.
      const plain = await standIn();
      try {
        await waitReady(started(plain.port), healthHosts("one"), healthRoles("one"));
      } finally {
        plain.server.close();
      }
    });

    it("a build given IMG_HOST that does not answer as the img address there fails to start with a clear line, and so does a swapped role", async () => {
      const cases: [Record<string, string>, Mode, string][] = [
        // A build that ignores IMG_HOST: the img host is no address of the site.
        [{ "tours.example.com": "tours", "app.example.com": "app" }, "three", "the build answers health on img.example.com as no address of the site, not as the img address"],
        // Answering as the tours address there (an img address it does not know falls back to nothing, but a wrong role is caught too).
        [{ ...RIGHT, "img.example.com": "tours" }, "three", "the build answers health on img.example.com as the tours address, not as the img address"],
        [{ ...RIGHT, "tours.example.com": "app" }, "two", "the build answers health on tours.example.com as the app address, not as the tours address"],
        // A role the rehearsal does not know is never repeated.
        [{ ...RIGHT, "app.example.com": "owner@example.com" }, "two", "the build answers health on app.example.com as something else, not as the app address"],
      ];
      for (const [roles, m, line] of cases) {
        const { server, port } = await standIn(roles);
        try {
          await expect(waitReady(started(port), healthHosts(m), healthRoles(m))).rejects.toThrow(line);
        } finally {
          server.close();
        }
      }
    });
  });
});

describe("the race check and the client address", () => {
  /**
   * A stand-in build: a dist/node/entry.js that answers every request with 200 and an empty
   * JSON object on 127.0.0.1 (through the rehearsal's own preload) and, as the Node entry does
   * since 0.1.26, writes PROXY_HINT once to its error output when CLIENT_ADDRESS_HEADER is not
   * set and a request comes in. `alsoSays` is one more line it writes on its first request.
   */
  function standInBuild(alsoSays: string | null = null): string {
    const dir = mkdtempSync(join(tmpdir(), "rehearse-standin-"));
    mkdirSync(join(dir, "dist", "node"), { recursive: true });
    mkdirSync(join(dir, "migrations"));
    writeFileSync(join(dir, "package.json"), '{"version":"9.9.9","type":"module"}');
    writeFileSync(
      join(dir, "dist", "node", "entry.js"),
      `import { createServer } from "node:http";
const HINT = ${JSON.stringify(PROXY_HINT)};
const ALSO = ${JSON.stringify(alsoSays)};
let said = false;
createServer((req, res) => {
  if (!said) {
    said = true;
    if ((process.env.CLIENT_ADDRESS_HEADER ?? "").trim() === "") console.error(HINT);
    if (ALSO !== null) console.error(ALSO);
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(req.url === "/healthz" ? JSON.stringify({ ok: true, seen: req.headers["x-forwarded-for"] ?? null }) : "{}");
}).listen(Number(process.env.PORT));
`,
    );
    return dir;
  }

  async function race(build: string, extra: Record<string, string> = {}) {
    const work = mkdtempSync(join(tmpdir(), "rehearse-work-"));
    const data = join(work, "data");
    mkdirSync(data);
    try {
      return await startPair(build, data, "one", work, [], extra);
    } finally {
      rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }

  it("the builds run as behind a proxy: CLIENT_ADDRESS_HEADER is set, and every request carries a documentation address in it", () => {
    expect(PROXY_SETTINGS).toEqual({ CLIENT_ADDRESS_HEADER: "X-Forwarded-For" });
    expect(CLIENT_ADDRESS).toBe("203.0.113.7");
  });

  it("without the setting each build writes the proxy hint, which the check names; with it (as the rehearsal runs) there is none", async () => {
    const build = standInBuild();
    try {
      // Today's failure, reproduced: the setting left empty, as before this fix.
      const without = await race(build, { CLIENT_ADDRESS_HEADER: "" });
      expect(without.startProblems).toEqual([]);
      expect(without.errors).toEqual([PROXY_HINT, PROXY_HINT]);
      expect(errorLineProblems(without.errors)).toEqual([`a known message: ${PROXY_HINT}`]);
      // As the rehearsal runs the builds now.
      const fixed = await race(build);
      expect(fixed.startProblems).toEqual([]);
      expect(fixed.errors).toEqual([]);
    } finally {
      rmSync(build, { recursive: true, force: true });
    }
  });

  it("the requests carry the documentation address in X-Forwarded-For", async () => {
    const build = standInBuild();
    const work = mkdtempSync(join(tmpdir(), "rehearse-work-"));
    try {
      const port = await freePort();
      const r = spawnBuild(build, work, "one", work, port);
      try {
        await waitReady(r, healthHosts("one"), healthRoles("one"));
        const a = await fetchAnswer(port, "GET", "/healthz", "localhost");
        expect(JSON.parse(new TextDecoder().decode(a.body))).toEqual({ ok: true, seen: "203.0.113.7" });
      } finally {
        await stopBuild(r);
      }
    } finally {
      rmSync(build, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("an unexpected error line still fails the check, and is named by its length only, never its text", async () => {
    const secret = "upload failed for owner@example.com, token dp_" + "1".repeat(40);
    const build = standInBuild(secret);
    try {
      const got = await race(build);
      expect(got.errors).toEqual([secret, secret]);
      const problems = errorLineProblems(got.errors);
      expect(problems).toEqual([`an error line that is not one of the known messages (${secret.length} characters)`]);
      expect(problems.join(" ")).not.toContain("example.com");
      expect(problems.join(" ")).not.toContain("dp_");
    } finally {
      rmSync(build, { recursive: true, force: true });
    }
  });

  it("each distinct line is named once; the known messages are the app's own, word for word", () => {
    expect(errorLineProblems([])).toEqual([]);
    expect(errorLineProblems([PROXY_HINT, "x", PROXY_HINT, "yy", "x"])).toEqual([`a known message: ${PROXY_HINT}`, "an error line that is not one of the known messages (1 character)", "an error line that is not one of the known messages (2 characters)"]);
    // A known message with anything added is not one of them.
    expect(errorLineProblems([PROXY_HINT + " 127.0.0.1"])).toEqual([`an error line that is not one of the known messages (${PROXY_HINT.length + 10} characters)`]);
    expect(KNOWN_ERROR_LINES).toContain(PROXY_HINT);
    // Every known message is a fixed line of the app's own source, word for word, so none can hold a value.
    const source = (dir: string): string => readdirSync(dir, { withFileTypes: true }).map((e) => (e.isDirectory() ? source(join(dir, e.name)) : e.name.endsWith(".ts") && !e.name.endsWith("-assets.ts") ? readFileSync(join(dir, e.name), "utf8") : "")).join(" ");
    const src = source(fileURLToPath(new URL("../src", import.meta.url)));
    for (const line of KNOWN_ERROR_LINES) expect(src.includes(JSON.stringify(line)) || src.includes(`"${line}"`), line).toBe(true);
  });
});

describe("the way back with a restricted tour", () => {
  it("the session written into the scratch copy is one the new build takes for a change of who views a tour, and the token's own account's", async () => {
    const root = mkdtempSync(join(tmpdir(), "rehearse-session-"));
    const file = join(root, "db.sqlite");
    const db = new NodeDb(file);
    try {
      await migrate(db, fileURLToPath(new URL("../migrations/", import.meta.url)));
      const deps = { db, drafts: new NodeFileStore(join(root, "drafts")), pub: new NodeFileStore(join(root, "public")), config: { publicImageBase: "", setupCode: null, siteHost: "localhost" }, now: () => Date.now() };
      const a = await createWorkspace(deps, "Acme", "owner@example.com");
      await createWorkspace(deps, "Other", "other@example.com");
      expect(await scratchSession(file, "dp_" + "0".repeat(40))).toBeNull(); // a token nobody has: no session
      const session = await scratchSession(file, a.token);
      expect(session).not.toBeNull();
      const tour = "tour_" + "1".repeat(24);
      await db.run("INSERT INTO tour (id, workspace_id, title, slug, status, created_at, updated_at) VALUES (?, ?, 'T', 'abcdefghij', 'draft', 1, 1)", [tour, a.workspaceId]);
      const put = await createApp(deps).fetch(
        new Request(`http://localhost/api/v1/tours/${tour}/access`, {
          method: "PUT",
          headers: { cookie: session!.cookie, "x-csrf-token": session!.csrf, origin: "http://localhost", "sec-fetch-site": "same-origin", "content-type": "application/json" },
          body: JSON.stringify({ access: "me" }),
        }),
      );
      // This deps object has no mailer, so the change is refused for want of mail, after the session was taken.
      expect([put.status, ((await put.json()) as { error: string }).error]).toEqual([409, "cannot_restrict"]);
      expect((await db.first<{ n: number }>("SELECT count(*) AS n FROM session"))!.n).toBe(1);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("the new build restricts with one address, an address for links and a mail setting whose server is never contacted", () => {
    expect(RESTRICT_SETTINGS).toEqual({ SITE_HOST: "localhost", MAIL_MODE: "smtp", MAIL_FROM: "rehearsal@example.com", SMTP_HOST: "127.0.0.1", SMTP_PORT: "9", SMTP_USER: "rehearsal", SMTP_PASSWORD: "not-a-real-password" });
  });

  it("the app's own settings parser takes those settings as mail on, with an address for links, and contacts nothing", () => {
    const config = configFromEnv(RESTRICT_SETTINGS);
    expect(linkOrigin(config)).not.toBeNull();
    const made: unknown[] = [];
    const mail = mailFromEnv(RESTRICT_SETTINGS, config, (settings) => {
      made.push(settings);
      return NO_MAIL;
    });
    expect([mail.mode, mail.problem, mail.setting]).toEqual(["smtp", null, null]);
    expect(made).toEqual([expect.objectContaining({ host: "127.0.0.1", port: 9, from: "rehearsal@example.com" })]);
    // Without a user and a password (the settings before this fix) mail stays off, so a restriction is refused.
    const { SMTP_USER: _u, SMTP_PASSWORD: _p, ...incomplete } = RESTRICT_SETTINGS;
    expect(mailFromEnv(incomplete, configFromEnv(incomplete), () => NO_MAIL).mode).toBe("off");
  });

  it("a refused change names its error code when it is shaped like one, and never any other part of the answer", () => {
    expect(refusalLine(answer(409, '{"error":"cannot_restrict"}'))).toBe("the change answered 409 (cannot_restrict)");
    expect(refusalLine(answer(409, '{"error":"cannot_restrict","detail":"owner@example.com"}'))).toBe("the change answered 409 (cannot_restrict)");
    for (const body of ['{"error":"owner@example.com"}', '{"error":"Cannot"}', '{"error":"a1"}', `{"error":"${"a".repeat(41)}"}`, '{"error":7}', '{"message":"cannot_restrict"}', '["cannot_restrict"]', "cannot_restrict", ""]) {
      expect(refusalLine(answer(409, body)), body).toBe("the change answered 409");
    }
    expect(refusalLine(answer(500, "<html>"))).toBe("the change answered 500");
  });
});

describe("the way back and the two new builds demand identity", () => {
  const me = (v: string) => [rec("token 1: workspace (one address)", "GET /api/v1/me", answer(200, `{"workspace":"Acme","version":"${v}"}`))];
  const usage = (a: Answer) => [rec("token 1: usage (one address)", "GET /api/v1/usage", a)];

  it("the same answers but the date pass", () => {
    expect(identityProblems(compareAnswers(site(), site({ date: "Fri, 20 Nov 2026 11:11:11 GMT" })))).toEqual([]);
  });

  it("a route answered by one side only, another version or any other difference fails", () => {
    const added = compareAnswers(usage(answer(404, '{"error":"not_found"}')), usage(answer(200, '{"used_bytes":1}')));
    expect(added.problems).toEqual([]);
    expect(identityProblems(added)).toEqual(["token 1: usage (one address): answered by one side only"]);
    expect(identityProblems(compareAnswers(me("0.1.45"), me("0.1.46")))).toEqual(["1 answer(s) differ in the version"]);
    expect(identityProblems(compareAnswers(site(), site({ pictures: 1 })))).toEqual(["token 1: tour 1 picture 2: missing after"]);
  });
});

describe("the new build's player files", () => {
  const JS = "/player.399e3f2c7b7c723a.js";
  const CSS = "/player.b5cf31940e7c03b2.css";
  const html = (head: string) => enc.encode(`<!doctype html>\n<head>\n${head}\n</head>\n`);
  const tags = `<link rel="stylesheet" href="${CSS}">\n<script src="${JS}" defer></script>`;

  it("the names come from the page's own two tags only, each once", () => {
    expect(playerFilesIn(html(tags))).toEqual([CSS, JS]);
    expect(playerFilesIn(enc.encode(NOT_FOUND_HTML))).toEqual([PLAYER_CSS_PATH]);
    // A name outside the server's tags, or in a tag written another way, is not one.
    expect(playerFilesIn(html(`<a href="${JS}">x</a><script src="${JS}"></script>`))).toEqual([]);
    expect(playerFilesIn(new Uint8Array([0xff, 0xfe]))).toEqual([]);
  });

  it("each file must answer 200 with its own type", () => {
    const file = (status: number, type: string): Answer => ({ status, headers: { "content-type": type }, body: new Uint8Array() });
    expect(playerFileProblems(JS, file(200, "text/javascript; charset=utf-8"))).toEqual([]);
    expect(playerFileProblems(CSS, file(200, "text/css; charset=utf-8"))).toEqual([]);
    expect(playerFileProblems(JS, file(404, "application/json"))).toEqual(["answered 404", "content type is not the script's"]);
    expect(playerFileProblems(CSS, file(200, "text/javascript"))).toEqual(["content type is not the stylesheet's"]);
    expect(playerFileProblems(JS, file(200, "text/javascriptx"))).toEqual(["content type is not the script's"]);
  });

  it("asks each distinct file the new build's tour pages name, on the tours address, and names none in its problems", async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(`${req.headers.host} ${req.url}`);
      if (req.url === JS) {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        return res.end("x");
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":"not_found"}');
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const a = server.address();
    const port = typeof a === "object" && a !== null ? a.port : 0;
    const pageRec = (key: string, body: Uint8Array, status = 200) => rec(key, "GET /t/:slug", { status, headers: { "content-type": "text/html; charset=utf-8" }, body });
    try {
      const answers = [pageRec("token 1: tour 1 page", html(tags)), pageRec("token 1: tour 2 page", html(tags)), pageRec("token 1: tour 3 page", enc.encode(NOT_FOUND_HTML), 404), rec("x", "GET /p/:name", answer(200, tags, { "content-type": "text/html" }))];
      const r = await checkPlayerFiles(port, "tours.example.com", answers);
      expect(r.files).toBe(2);
      expect(r.problems).toEqual(["stylesheet 1: answered 404, content type is not the stylesheet's"]);
      expect(seen.sort()).toEqual([`tours.example.com ${CSS}`, `tours.example.com ${JS}`].sort());
      expect(JSON.stringify(r)).not.toContain("b5cf3194");
      expect((await checkPlayerFiles(port, "tours.example.com", [])).files).toBe(0);
    } finally {
      server.close();
    }
  });
});

describe("the added-fields rule and the sign-in lifetimes (Plan 2j)", () => {
  const answer = (value: unknown): Answer => ({ status: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(value)) });
  it("lets through the fields the tokens, sessions and session answers gain, by their paths, and nothing else", () => {
    const tok = { id: "tok_" + "1".repeat(24), name: "Laptop", created_at: 1, last_used_at: null, kind: "sign_in" };
    expect(onlyAddedFields(answer({ tokens: [tok] }), answer({ tokens: [{ ...tok, expires_at: 7776000001, expired: false }] }))).toEqual({ ok: true, paths: ["tokens[].expired", "tokens[].expires_at"] });
    const ses = { id: "ses_" + "1".repeat(24), label: "Firefox on Linux", created_at: 1, last_used_at: 1, expires_at: 2, current: true };
    expect(onlyAddedFields(answer({ sessions: [ses] }), answer({ sessions: [{ ...ses, ends_at: 3 }] }))).toEqual({ ok: true, paths: ["sessions[].ends_at"] });
    const who = { session: { id: ses.id, created_at: 1, expires_at: 2 }, csrf: "c" };
    expect(onlyAddedFields(answer(who), answer({ session: { ...who.session, ends_at: null }, csrf: "c", limits: { session_max_days: 90, connection_idle_days: 90, connection_max_days: null } }))).toEqual({
      ok: true,
      paths: ["limits", "session.ends_at"],
    });
    // A changed value is not an added field.
    expect(onlyAddedFields(answer({ tokens: [tok] }), answer({ tokens: [{ ...tok, last_used_at: 5, expired: true }] })).ok).toBe(false);
  });
});
