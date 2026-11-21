// The comparisons of the upgrade rehearsal (scripts/rehearse-upgrade.ts), kept apart from
// starting servers so that test/node-rehearse.test.ts can hold them to their word: the
// allow-list below is the only thing that may differ between two answers, and nothing in
// it can hide a changed byte, a missing picture, a changed row, a missing backfill row or
// an unexpected admin.
//
// Pure: no file, no process and no network. Every problem is written as a label and a
// count, never as a value from the data, because the report is printed and the data holds
// an email address, token hashes and private pictures.

/** One HTTP answer as a client sees it: the status, every header (lowercased) and every byte. */
export type Answer = { status: number; headers: Record<string, string>; body: Uint8Array };

/** One recorded request: a label for the report (never holding data), its route and the answer. */
export type Recorded = { key: string; route: string; answer: Answer };

/**
 * The allow-list, all of it:
 * - the `date` header of every answer, which says when the answer was made;
 * - in the body of `GET /api/v1/me`, the value of `"version"`, which names the build.
 *   Only that one value is swapped before the bytes are compared, and `content-length`
 *   is let follow the swap; every other byte must be the same.
 * - from the old build to the new one only (never on the way back): a JSON answer whose
 *   new body is the old body plus new object keys, every old value unchanged
 *   (onlyAddedFields: byte for byte, keys in their order, and every added key shaped like
 *   a field name), with `content-length` let follow the longer body. Such answers are
 *   counted apart, with the added field paths named once per route and no value.
 * - from the old build to the new one only (never on the way back, never between two
 *   runs of the same build): in a tour page answer (route `GET /t/:slug`, HTML by its
 *   content type), the content-hashed names of the player's own two files, which change
 *   whenever the player's script or stylesheet does (playerNamesOnly). Only the name inside
 *   the page's own two tags, written exactly as src/page.ts writes them, is swapped for a
 *   fixed stand-in on both sides; the bodies must be the same length and every other byte
 *   the same, and the `etag` header (a hash of the body) is let follow only then. Such
 *   answers are counted apart, and no file name is ever printed.
 * The API description's ETags would be a further entry, but the rehearsal records no
 * description answer: its text changes with every version by design.
 */
export const IGNORED_HEADERS: readonly string[] = ["date"];
export const VERSION_ROUTE = "GET /api/v1/me";
export const PAGE_ROUTE = "GET /t/:slug";

/**
 * Routes a newer build may answer that an older one did not have. When the older build
 * answered such a route with its plain not-found answer, the newer answer is not compared
 * here; the rehearsal checks it another way (the usage against its own sum of the rows).
 */
export const ADDED_ROUTES: readonly string[] = ["GET /api/v1/usage"];

const NOT_FOUND_BODY = '{"error":"not_found"}';
const VERSION_FIELD = /"version":"(\d+\.\d+\.\d+)"/g;

export type AnswerComparison = {
  /** Answers byte-identical in status, headers (but the ignored ones) and body. */
  identical: number;
  /** Answers that differ only in the version value of GET /api/v1/me. */
  allowed: number;
  /** Tour pages that differ only in the player's file names (playerNamesOnly), when the comparison allows it. */
  playerNames: number;
  /**
   * Answers whose newer JSON body only adds object keys (see onlyAddedFields), when the
   * comparison allows it: the count, and per route the added field paths, each once.
   */
  addedFields: number;
  addedFieldsByRoute: Record<string, string[]>;
  /** Keys whose route the older build did not have. */
  added: string[];
  /** One line per answer that differs, naming the key and what differs, never a value. */
  problems: string[];
};

const decoder = new TextDecoder("utf-8", { fatal: false });
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

function headerProblems(before: Record<string, string>, after: Record<string, string>): string[] {
  const out: string[] = [];
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const name of [...names].sort()) {
    if (IGNORED_HEADERS.includes(name)) continue;
    if (!(name in after)) out.push(`header ${name} missing`);
    else if (!(name in before)) out.push(`header ${name} added`);
    else if (before[name] !== after[name]) out.push(`header ${name} differs`);
  }
  return out;
}

/**
 * The older answer with its version value replaced by the newer one, or null when the
 * swap does not apply: not the version route, not a 200, or not exactly one version value
 * in each body.
 */
export function withVersionOf(route: string, before: Answer, after: Answer): Answer | null {
  if (route !== VERSION_ROUTE || before.status !== 200 || after.status !== 200) return null;
  const oldText = decoder.decode(before.body);
  const newText = decoder.decode(after.body);
  const oldMatches = [...oldText.matchAll(VERSION_FIELD)];
  const newMatches = [...newText.matchAll(VERSION_FIELD)];
  if (oldMatches.length !== 1 || newMatches.length !== 1) return null;
  const swapped = oldText.replace(VERSION_FIELD, () => `"version":"${newMatches[0][1]}"`);
  const body = new TextEncoder().encode(swapped);
  // The swap must not have changed anything but that value: decoding and encoding again
  // gives back the very bytes everywhere else.
  if (!sameBytes(new TextEncoder().encode(oldText), before.body)) return null;
  const headers = { ...before.headers };
  if (headers["content-length"] === String(before.body.length)) headers["content-length"] = String(body.length);
  return { status: before.status, headers, body };
}

/** What differs between two answers, after the allow-list. Empty when they are the same. */
export function answerProblems(before: Answer, after: Answer): string[] {
  const out: string[] = [];
  if (before.status !== after.status) out.push(`status ${before.status} became ${after.status}`);
  out.push(...headerProblems(before.headers, after.headers));
  if (!sameBytes(before.body, after.body)) out.push(`body differs (${before.body.length} and ${after.body.length} bytes)`);
  return out;
}

/**
 * The page's own two tags naming the player's files, exactly as src/page.ts writes them
 * (pageHtml, and the not-found page's stylesheet tag): the name is `/player.` and 16
 * lowercase hex digits, then `.css` or `.js`. Nothing a customer writes can make such a
 * tag: the title is escaped for HTML (escapeHtml turns `<` and `"` into entities) and the
 * tour's data is JSON with `<` written as < (scriptJson), so a title or step text
 * holding `/player.0123456789abcdef.js` is never inside one of these tags and is compared
 * byte for byte like the rest of the page. Only the whole tag is matched, never the bare name.
 */
const PLAYER_CSS_TAG = /<link rel="stylesheet" href="\/player\.[0-9a-f]{16}\.css">/g;
const PLAYER_JS_TAG = /<script src="\/player\.[0-9a-f]{16}\.js" defer><\/script>/g;
/** The fixed stand-ins both sides' tags are swapped for: no hash, so neither build's name survives. */
const PLAYER_CSS_STAND_IN = '<link rel="stylesheet" href="/player.(name).css">';
const PLAYER_JS_STAND_IN = '<script src="/player.(name).js" defer></script>';
const HTML_TYPE = /^text\/html\s*(?:;|$)/i;

/** The page's text with its player tags swapped for the stand-ins, or null when it is not exact UTF-8 or names either file more than once. */
function withPlayerStandIns(body: Uint8Array): { text: string; css: number; js: number } | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    return null;
  }
  const css = text.match(PLAYER_CSS_TAG)?.length ?? 0;
  const js = text.match(PLAYER_JS_TAG)?.length ?? 0;
  if (css > 1 || js > 1) return null;
  return { text: text.replace(PLAYER_CSS_TAG, PLAYER_CSS_STAND_IN).replace(PLAYER_JS_TAG, PLAYER_JS_STAND_IN), css, js };
}

/**
 * Whether two answers of a tour page differ only in the names of the player's files:
 * - the route is GET /t/:slug and both answers are HTML by their content type;
 * - the same status, and every header the same but the ignored ones and `etag`, which is
 *   present in both or in neither;
 * - the bodies differ, are the same length, and are each exact UTF-8 naming each player
 *   file at most once, in the same tags on both sides;
 * - with each player tag swapped for its fixed stand-in, the two texts are the same.
 * Identical bodies with a differing etag are not this case: that stays a difference.
 */
export function playerNamesOnly(route: string, before: Answer, after: Answer): boolean {
  if (route !== PAGE_ROUTE || before.status !== after.status) return false;
  if (!HTML_TYPE.test(before.headers["content-type"] ?? "") || !HTML_TYPE.test(after.headers["content-type"] ?? "")) return false;
  const strip = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).filter(([k]) => k !== "etag"));
  if (headerProblems(strip(before.headers), strip(after.headers)).length > 0) return false;
  if (("etag" in before.headers) !== ("etag" in after.headers)) return false;
  if (before.body.length !== after.body.length || sameBytes(before.body, after.body)) return false;
  const b = withPlayerStandIns(before.body);
  const a = withPlayerStandIns(after.body);
  if (b === null || a === null || b.css !== a.css || b.js !== a.js) return false;
  return b.text === a.text;
}

/**
 * An added key counts as a field only when it is shaped like the API's own field names:
 * lowercase words joined by single underscores, at most 40 characters, no digit and no
 * capital. An item id (`med_...`), a token (`dp_...`), a slug or any other key that could
 * hold data is not one: such an added key fails the answer, and is never printed.
 */
const FIELD_NAME = /^[a-z]+(?:_[a-z]+)*$/;
const FIELD_MAX_CHARS = 40;
export const isFieldName = (key: string) => key.length <= FIELD_MAX_CHARS && FIELD_NAME.test(key);
/** The problem written for an answer that adds a key of another shape: fixed text, never the key. */
export const NOT_A_FIELD_NAME = "an added key that is not shaped like a field name";
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
/** A key as a path shows it: its name when it is shaped like a field name, else `*`, so an existing key that is data (an id used as a key) is never printed either. */
const shown = (key: string) => (isFieldName(key) ? key : "*");
const joined = (path: string, key: string) => (path === "" ? shown(key) : `${path}.${shown(key)}`);

export type AddedKeys = {
  /** `after` with every key `before` lacks taken out, every other key kept in its order. */
  stripped: unknown;
  /** The paths of the added keys shaped like field names, each once, sorted. */
  paths: string[];
  /** How many added keys are not shaped like field names. */
  notFieldNames: number;
};

/**
 * The keys `after` adds to `before`, at any depth, and `after` without them. Objects are
 * walked key by key (a key `before` has is kept and walked into; one it lacks is an added
 * key) and arrays element by element (an element past the end of `before`'s array is kept
 * as it is); anything else is kept as it is. Whether the rest is unchanged is not decided
 * here: onlyAddedFields compares `stripped`, written as JSON, with the old body's bytes.
 *
 * A path is the keys from the top joined by dots, with `[]` for "every element of an
 * array", so the same field in every element is one path: `counted.images`,
 * `largest[].kind`. It never holds a value.
 */
export function addedKeys(before: unknown, after: unknown): AddedKeys {
  const found = new Set<string>();
  let notFieldNames = 0;
  const walk = (b: unknown, a: unknown, path: string): unknown => {
    if (Array.isArray(a)) return Array.isArray(b) ? a.map((x, i) => (i < b.length ? walk(b[i], x, `${path}[]`) : x)) : a;
    if (!isObject(a) || !isObject(b)) return a;
    // No prototype, so that a key named __proto__ is kept as a key like any other.
    const out: Record<string, unknown> = Object.create(null);
    for (const k of Object.keys(a)) {
      if (Object.hasOwn(b, k)) out[k] = walk(b[k], a[k], joined(path, k));
      else if (isFieldName(k)) found.add(joined(path, k));
      else notFieldNames++;
    }
    return out;
  };
  const stripped = walk(before, after, "");
  return { stripped, paths: [...found].sort(), notFieldNames };
}

const JSON_TYPE = /^application\/(?:[a-z0-9.+-]+\+)?json\s*(?:;|$)/i;

/**
 * The body as text and its value, when the answer says it is JSON and its bytes are exactly
 * the plain JSON of that value (JSON.stringify of JSON.parse gives the same text): no byte
 * order mark, no space, no number written another way (1.0, 1e2, -0, an integer past what
 * a double holds), no duplicate key, no escape a string does not need. Null otherwise.
 */
function plainJson(a: Answer): { text: string; value: unknown } | null {
  if (!JSON_TYPE.test(a.headers["content-type"] ?? "")) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(a.body);
    const value: unknown = JSON.parse(text);
    return JSON.stringify(value) === text ? { text, value } : null;
  } catch {
    return null;
  }
}

/** Whether the newer answer only adds fields (`paths`), or why not (`problem`: fixed text to report, or null for a plain difference). */
export type OnlyAdded = { ok: true; paths: string[] } | { ok: false; problem: string | null };

/**
 * Whether the newer answer is the older one plus new fields, and nothing else:
 * - the same status, and every header the same but the ignored ones and `content-length`,
 *   which may follow the longer body (present in both or in neither);
 * - both bodies JSON by their content type, each exactly the plain JSON of its value
 *   (plainJson);
 * - the newer value with its added keys taken out, keeping its key order (addedKeys),
 *   written as JSON, is the older body byte for byte: so every old key is there, in its
 *   order, with the same value, and every array has the same length;
 * - at least one key added, and every added key shaped like a field name (isFieldName).
 *   An added key of any other shape fails, with NOT_A_FIELD_NAME as the problem.
 * A non-JSON answer is never let through here.
 */
export function onlyAddedFields(before: Answer, after: Answer): OnlyAdded {
  const no: OnlyAdded = { ok: false, problem: null };
  if (before.status !== after.status) return no;
  const strip = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).filter(([k]) => k !== "content-length"));
  if (headerProblems(strip(before.headers), strip(after.headers)).length > 0) return no;
  if (("content-length" in before.headers) !== ("content-length" in after.headers)) return no;
  const b = plainJson(before);
  const a = plainJson(after);
  if (b === null || a === null) return no;
  const added = addedKeys(b.value, a.value);
  if (JSON.stringify(added.stripped) !== b.text) return no;
  if (added.notFieldNames > 0) return { ok: false, problem: NOT_A_FIELD_NAME };
  return added.paths.length > 0 ? { ok: true, paths: added.paths } : no;
}

/** How many added field paths a comparison names, over all its routes (each route's list counted whole). */
export function addedFieldCount(c: AnswerComparison): number {
  return Object.values(c.addedFieldsByRoute).reduce((n, paths) => n + paths.length, 0);
}

/** Whether `a` is the plain not-found answer every build gives a route it does not have. */
export function isPlainNotFound(a: Answer): boolean {
  return a.status === 404 && decoder.decode(a.body) === NOT_FOUND_BODY;
}

/**
 * Compares two recordings of the same requests. Every key must be in both (a picture the
 * newer page no longer names is a missing key; one it names in addition is an unexpected
 * key), and every pair must be the same but for the allow-list.
 *
 * With `allowAddedFields` (the old build against the new one only), a JSON answer whose
 * newer body only adds object keys is let through too (onlyAddedFields), after the version
 * swap on GET /api/v1/me, and counted apart with its added paths. Without it (the way back,
 * the same build twice) such an answer is a difference like any other.
 *
 * With `allowPlayerNames` (the old build against the new one only), a tour page that
 * differs only in the player's file names is let through (playerNamesOnly) and counted
 * apart. Without it, such a page is a difference like any other.
 */
export function compareAnswers(before: Recorded[], after: Recorded[], opts: { allowAddedFields?: boolean; allowPlayerNames?: boolean } = {}): AnswerComparison {
  const result: AnswerComparison = { identical: 0, allowed: 0, playerNames: 0, addedFields: 0, addedFieldsByRoute: {}, added: [], problems: [] };
  const later = new Map(after.map((r) => [r.key, r]));
  const earlier = new Set(before.map((r) => r.key));
  for (const b of before) {
    const a = later.get(b.key);
    if (a === undefined) {
      result.problems.push(`${b.key}: missing after`);
      continue;
    }
    if (a.route !== b.route) {
      result.problems.push(`${b.key}: a different route was recorded`);
      continue;
    }
    if (ADDED_ROUTES.includes(b.route) && isPlainNotFound(b.answer) && !isPlainNotFound(a.answer)) {
      result.added.push(b.key);
      continue;
    }
    const direct = answerProblems(b.answer, a.answer);
    if (direct.length === 0) {
      result.identical++;
      continue;
    }
    const swapped = withVersionOf(b.route, b.answer, a.answer);
    if (swapped !== null && answerProblems(swapped, a.answer).length === 0) {
      result.allowed++;
      continue;
    }
    if (opts.allowPlayerNames === true && playerNamesOnly(b.route, b.answer, a.answer)) {
      result.playerNames++;
      continue;
    }
    const only = opts.allowAddedFields === true ? onlyAddedFields(swapped ?? b.answer, a.answer) : null;
    if (only !== null && only.ok) {
      result.addedFields++;
      const seen = new Set([...(result.addedFieldsByRoute[b.route] ?? []), ...only.paths]);
      result.addedFieldsByRoute[b.route] = [...seen].sort();
      continue;
    }
    const why = only !== null && !only.ok && only.problem !== null ? [only.problem] : [];
    result.problems.push(`${b.key}: ${[...direct, ...why].join(", ")}`);
  }
  for (const a of after) if (!earlier.has(a.key)) result.problems.push(`${a.key}: unexpected after`);
  return result;
}

/** A store listing: one entry per file under drafts/ and public/, by its path in the data folder. */
export type StoreListing = Map<string, { size: number; sha256: string }>;

export type StoreComparison = { files: number; missing: number; extra: number; changed: number };

/** How two listings differ, in counts only (file names are hashes of private keys). */
export function compareStores(before: StoreListing, after: StoreListing): StoreComparison {
  let missing = 0;
  let changed = 0;
  for (const [path, f] of before) {
    const g = after.get(path);
    if (g === undefined) missing++;
    else if (g.size !== f.size || g.sha256 !== f.sha256) changed++;
  }
  let extra = 0;
  for (const path of after.keys()) if (!before.has(path)) extra++;
  return { files: before.size, missing, extra, changed };
}

export const storesSame = (c: StoreComparison) => c.missing === 0 && c.extra === 0 && c.changed === 0;

/** The values a row can hold, as read and normalised by the rehearsal. */
export type Cell = string | number | null;
/** One table: its columns in order and its rows, each a list in that order. */
export type Table = { columns: string[]; rows: Cell[][] };
/** Every table of a database but SQLite's own and the migrations record. */
export type DbSnapshot = Record<string, Table>;

export type RowComparison = { tables: number; rows: number; problems: string[] };

/**
 * Checks that every row of `before` is in `after`, unchanged in every column `before`
 * had, and that `after` holds no other row in those tables. Rows are compared as a
 * multiset, so order does not matter and a duplicated row is caught. A table or a column
 * that is gone is a problem; columns and tables `after` has in addition are not looked at
 * here.
 */
export function compareRows(before: DbSnapshot, after: DbSnapshot): RowComparison {
  const result: RowComparison = { tables: 0, rows: 0, problems: [] };
  for (const name of Object.keys(before).sort()) {
    const b = before[name];
    const a = after[name];
    result.tables++;
    result.rows += b.rows.length;
    if (a === undefined) {
      result.problems.push(`table ${name}: missing after`);
      continue;
    }
    const at = b.columns.map((c) => a.columns.indexOf(c));
    const gone = b.columns.filter((_, i) => at[i] === -1);
    if (gone.length > 0) {
      result.problems.push(`table ${name}: ${gone.length} column(s) missing after: ${gone.join(", ")}`);
      continue;
    }
    const counts = new Map<string, number>();
    for (const row of b.rows) {
      const k = JSON.stringify(row);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    let extra = 0;
    for (const row of a.rows) {
      const k = JSON.stringify(at.map((i) => row[i]));
      const n = counts.get(k) ?? 0;
      if (n === 0) extra++;
      else counts.set(k, n - 1);
    }
    let missing = 0;
    for (const n of counts.values()) missing += n;
    if (missing > 0 || extra > 0) result.problems.push(`table ${name}: ${missing} row(s) missing or changed, ${extra} row(s) not there before`);
  }
  return result;
}

/** The tables the accounts migration (0008) adds. */
export const ACCOUNT_TABLES: readonly string[] = ["audit", "membership", "rate_counter", "session", "signin_code", "signin_method"];
/** The columns it adds to `user`. */
export const ACCOUNT_USER_COLUMNS: readonly string[] = ["username", "status", "is_admin"];

export type BackfillResult = { users: number; memberships: number; methods: number; admins: number; problems: string[] };

function rowsOf(t: Table | undefined): Record<string, Cell>[] {
  if (t === undefined) return [];
  return t.rows.map((r) => Object.fromEntries(t.columns.map((c, i) => [c, r[i]])));
}

/**
 * What the accounts migration must leave behind on an existing site: its tables and
 * columns; one `owner` membership and one `email_link` sign-in method per existing user,
 * each pointing at that user and its workspace, and no other; every user active, without
 * a username and not an admin; and nobody signed in, nothing counted and nothing recorded.
 */
export function checkAccountsBackfill(after: DbSnapshot): BackfillResult {
  const problems: string[] = [];
  for (const t of ACCOUNT_TABLES) if (after[t] === undefined) problems.push(`table ${t} is missing`);
  const userTable = after.user;
  if (userTable === undefined) problems.push("table user is missing");
  else for (const c of ACCOUNT_USER_COLUMNS) if (!userTable.columns.includes(c)) problems.push(`column user.${c} is missing`);

  const users = rowsOf(userTable);
  const memberships = rowsOf(after.membership);
  const methods = rowsOf(after.signin_method);
  const admins = users.filter((u) => u.is_admin !== 0).length;
  if (admins > 0) problems.push(`${admins} user(s) are admins; an upgrade makes nobody an admin`);
  const notActive = users.filter((u) => u.status !== "active").length;
  if (notActive > 0) problems.push(`${notActive} user(s) are not active`);
  const named = users.filter((u) => u.username !== null).length;
  if (named > 0) problems.push(`${named} user(s) have a username`);

  let unmatched = 0;
  for (const u of users) {
    const own = memberships.filter((m) => m.user_id === u.id);
    if (own.length !== 1 || own[0].workspace_id !== u.workspace_id || own[0].role !== "owner") unmatched++;
  }
  if (unmatched > 0) problems.push(`${unmatched} user(s) lack exactly one owner membership of their own workspace`);
  if (memberships.length !== users.length) problems.push(`${memberships.length} membership row(s) for ${users.length} user(s)`);

  let noMethod = 0;
  for (const u of users) if (methods.filter((m) => m.user_id === u.id && m.kind === "email_link").length !== 1) noMethod++;
  if (noMethod > 0) problems.push(`${noMethod} user(s) lack exactly one email_link sign-in method`);
  if (methods.length !== users.length) problems.push(`${methods.length} sign-in method row(s) for ${users.length} user(s)`);

  for (const t of ["session", "signin_code", "rate_counter", "audit"]) {
    const n = after[t]?.rows.length ?? 0;
    if (n > 0) problems.push(`table ${t} holds ${n} row(s); it must start empty`);
  }
  return { users: users.length, memberships: memberships.length, methods: methods.length, admins, problems };
}

/** Problems with the list of applied migrations: it must be exactly `expected`, each once. */
export function migrationProblems(applied: string[], expected: string[]): string[] {
  const out: string[] = [];
  const seen = new Map<string, number>();
  for (const n of applied) seen.set(n, (seen.get(n) ?? 0) + 1);
  for (const [n, k] of seen) if (k > 1) out.push(`${n} is recorded ${k} times`);
  for (const n of expected) if (!seen.has(n)) out.push(`${n} is not recorded`);
  for (const n of seen.keys()) if (!expected.includes(n)) out.push(`${n} is recorded but not expected`);
  return out;
}

export type UsageSum = { pictures: number; logos: number; uploads: number; media: number; used: number; tours: number };

/**
 * The storage use of one workspace, summed here from the rows themselves rather than by
 * the server's query: the bytes of every step of its tours, the recorded logo sizes of its
 * tours, the room held by its uploads that are not closing, and the bytes of its shared
 * items (closing ones too, until their rows go) and of every claim of theirs but a current part's
 * (none on a database before migration 0010). The items are in used_bytes only: the usage
 * answer names no part of its own for them yet.
 */
export function usageFromRows(db: DbSnapshot, workspaceId: string): UsageSum {
  const tours = rowsOf(db.tour).filter((t) => t.workspace_id === workspaceId);
  const ids = new Set(tours.map((t) => t.id));
  const num = (v: Cell) => (typeof v === "number" ? v : 0);
  const pictures = rowsOf(db.step).filter((s) => ids.has(s.tour_id as string)).reduce((n, s) => n + num(s.bytes), 0);
  const logos = tours.reduce((n, t) => n + num(t.logo_bytes ?? null), 0);
  const uploads = rowsOf(db.upload).filter((u) => u.workspace_id === workspaceId && u.closing_at === null).reduce((n, u) => n + num(u.reserved_bytes ?? null), 0);
  const items = rowsOf(db.media).filter((m) => m.workspace_id === workspaceId);
  const itemIds = new Set(items.map((m) => m.id));
  // Every claim but a current part's, which the item's bytes already hold.
  const previews = rowsOf(db.media_object).filter((o) => itemIds.has(o.media_id as string) && (o.current === 0 || o.n === -1));
  const media = items.reduce((n, m) => n + num(m.bytes), 0) + previews.reduce((n, o) => n + num(o.bytes), 0);
  return { pictures, logos, uploads, media, used: pictures + logos + uploads + media, tours: tours.length };
}

/** Problems with a usage answer against the sum of the rows. */
export function usageProblems(answer: Answer, sum: UsageSum): string[] {
  if (answer.status !== 200) return [`usage answered ${answer.status}`];
  let body: { used_bytes?: unknown; tours?: unknown; counted?: { pictures?: unknown; logos?: unknown; uploads_in_progress?: unknown } };
  try {
    body = JSON.parse(decoder.decode(answer.body));
  } catch {
    return ["usage is not JSON"];
  }
  const out: string[] = [];
  if (body.used_bytes !== sum.used) out.push("used_bytes differs from the sum of the rows");
  if (body.tours !== sum.tours) out.push("tours differs from the count of the rows");
  if (body.counted?.pictures !== sum.pictures) out.push("counted.pictures differs from the sum of step sizes");
  if (body.counted?.logos !== sum.logos) out.push("counted.logos differs from the sum of logo sizes");
  if (body.counted?.uploads_in_progress !== sum.uploads) out.push("counted.uploads_in_progress differs from the sum of reservations");
  return out;
}
