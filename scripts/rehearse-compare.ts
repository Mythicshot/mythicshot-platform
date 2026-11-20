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
 * The API description's ETags would be a third entry, but the rehearsal records no
 * description answer: its text changes with every version by design.
 */
export const IGNORED_HEADERS: readonly string[] = ["date"];
export const VERSION_ROUTE = "GET /api/v1/me";

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

/** Whether `a` is the plain not-found answer every build gives a route it does not have. */
export function isPlainNotFound(a: Answer): boolean {
  return a.status === 404 && decoder.decode(a.body) === NOT_FOUND_BODY;
}

/**
 * Compares two recordings of the same requests. Every key must be in both (a picture the
 * newer page no longer names is a missing key; one it names in addition is an unexpected
 * key), and every pair must be the same but for the allow-list.
 */
export function compareAnswers(before: Recorded[], after: Recorded[]): AnswerComparison {
  const result: AnswerComparison = { identical: 0, allowed: 0, added: [], problems: [] };
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
    result.problems.push(`${b.key}: ${direct.join(", ")}`);
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
 * tours, the room held by its uploads that are not closing, and the bytes and preview of
 * its shared items that are not closing (none on a database before migration 0010). The
 * items are in used_bytes only: the usage answer names no part of its own for them yet.
 */
export function usageFromRows(db: DbSnapshot, workspaceId: string): UsageSum {
  const tours = rowsOf(db.tour).filter((t) => t.workspace_id === workspaceId);
  const ids = new Set(tours.map((t) => t.id));
  const num = (v: Cell) => (typeof v === "number" ? v : 0);
  const pictures = rowsOf(db.step).filter((s) => ids.has(s.tour_id as string)).reduce((n, s) => n + num(s.bytes), 0);
  const logos = tours.reduce((n, t) => n + num(t.logo_bytes ?? null), 0);
  const uploads = rowsOf(db.upload).filter((u) => u.workspace_id === workspaceId && u.closing_at === null).reduce((n, u) => n + num(u.reserved_bytes ?? null), 0);
  const media = rowsOf(db.media).filter((m) => m.workspace_id === workspaceId && m.state !== "closing").reduce((n, m) => n + num(m.bytes) + num(m.preview_bytes ?? null), 0);
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
