// The site's terms: the file a site operator publishes them from, the versions the database
// keeps, and the three session requests of the terms screen. No platform API.
//
// How it fits together:
// - The operator publishes terms with the server command, `terms publish <file>`
//   (src/node/admin.ts). parseTerms reads the file (plain text in the strict format below,
//   docs/terms-example.txt) and publishTerms adds it as a new version. A version is never
//   changed or deleted (migration 0018's triggers refuse both); the current terms are the
//   newest version. Identical content is refused (its SHA-256 is unique).
// - Until a signed-in account has agreed to the current version, `requireAuth`
//   (src/auth.ts) answers every session request 403 `terms_required`, but for the routes
//   here and the two sign-outs, which ask it with `terms: "open"`. resolveSession
//   (src/sessions.ts) reads whether the account has agreed in the same one query that finds
//   the session, so the gate costs no database call. A token is never asked: its requests
//   are exactly as before. A site with no version has no terms: nobody is asked anything.
// - POST /api/v1/terms/agree records the agreement to the version the person was shown,
//   and only while that is still the current version. It stores the account, the version
//   and the time, and writes the audit row `terms_agreed` with ids only. Never an address,
//   a browser or an email.
//
// The terms are text the operator supplied, and still treated as untrusted: the format has
// no markup at all, every answer is JSON, and the pages put each text in the page through
// textContent alone (src/dash/terms.ts). A link is only an explicit `link:` line, an https
// address of the strict shape DOWNLOAD_URL has (src/https-address.ts).
//
// The file format (parseTerms), line by line; spaces at the start and end of a line are
// ignored, and blank lines are allowed between the header lines:
//
//   title: <the terms' title>                    first, once
//   version: <the version's label>               second, once (free text, such as a date)
//   link: <label> | <https address>              optional, at most 3
//   main points:                                 then at least 1 and at most 12 lines of
//   - <one main point>                             "- " and the point
//   terms:                                       then the full terms, to the end of the file:
//   # <a heading>                                  a line starting with "# " is a heading,
//   - <a bullet>                                   lines starting with "- " are a list,
//   <text>                                         other lines are text, joined into one
//                                                  paragraph until a blank line.
//
// The file is UTF-8. A line may not hold a control character (but the line end), a line or
// paragraph separator, a character that changes the direction of text around it (U+202A to
// U+202E, U+2066 to U+2069) or U+FEFF (one at the very start of the file is skipped). A file
// that breaks a rule is refused with one line that names the line.
import type { Hono } from "hono";
import { auditStatement } from "./audit.ts";
import { requireAuth } from "./auth.ts";
import { apiError, json, noContent } from "./http.ts";
import { httpsAddressFrom } from "./https-address.ts";
import { isNotNullViolation, type Deps } from "./ports.ts";
import { csrfFor, readSessionCookie } from "./sessions.ts";
import { ownJsonBody } from "./signin.ts";

/** The caps of a terms file, all checked by parseTerms. Characters are Unicode code points. */
export const TERMS_LIMITS = {
  /** The most bytes of a file that are read at all. */
  fileBytes: 262_144,
  /** The full terms (the part after `terms:`), in bytes as stored. */
  bodyBytes: 200_000,
  titleChars: 200,
  versionChars: 100,
  points: 12,
  pointChars: 300,
  links: 3,
  linkLabelChars: 60,
  /** A link's address, as URL writes it: the cap DOWNLOAD_URL has. */
  linkUrlChars: 300,
  headingChars: 300,
} as const;

export type TermsLink = { label: string; url: string };
/** One block of the full terms: a heading, a paragraph, or a list of bullets. */
export type TermsBlock = { kind: "heading"; text: string } | { kind: "paragraph"; text: string } | { kind: "list"; items: string[] };
/** A file as parseTerms read it. `body` is the full terms as stored; `blocks` is how they read. */
export type TermsFile = { title: string; version: string; links: TermsLink[]; points: string[]; body: string; blocks: TermsBlock[] };

/**
 * Why a file is refused: every sentence the command can print for a file, each one line. The
 * line number goes in front ("line 4: ..."), from lineSays.
 */
export const TERMS_FILE_SAYS = {
  empty: "the file is empty.",
  tooLarge: `the file is larger than ${TERMS_LIMITS.fileBytes.toLocaleString("en-US")} bytes.`,
  notUtf8: "the file is not UTF-8 text.",
  badCharacter: "this line has a character that is not allowed: a control character, a line or paragraph separator, or a character that changes the direction of text.",
  needTitle: 'the file must start with the line "title: <the title of the terms>".',
  emptyTitle: "the title is empty.",
  longTitle: `the title is longer than ${TERMS_LIMITS.titleChars} characters.`,
  needVersion: 'the line after the title must be "version: <the label of this version>".',
  emptyVersion: "the version's label is empty.",
  longVersion: `the version's label is longer than ${TERMS_LIMITS.versionChars} characters.`,
  needPointsOrLink: 'expected "link: <label> | https://…" or "main points:".',
  badLink: 'a link is written "link: <label> | https://…".',
  emptyLinkLabel: "the link's label is empty.",
  longLinkLabel: `the link's label is longer than ${TERMS_LIMITS.linkLabelChars} characters.`,
  badLinkUrl: `the link's address must be an https address of at most ${TERMS_LIMITS.linkUrlChars} characters, with a host name, no user name or password, and no # part.`,
  tooManyLinks: `there can be at most ${TERMS_LIMITS.links} links.`,
  needPoint: 'under "main points:" each line starts with "- ", until the line "terms:".',
  emptyPoint: "this main point is empty.",
  longPoint: `this main point is longer than ${TERMS_LIMITS.pointChars} characters.`,
  tooManyPoints: `there can be at most ${TERMS_LIMITS.points} main points.`,
  noPoints: 'there must be at least one main point before "terms:".',
  noTermsLine: 'the file ends before the line "terms:".',
  emptyHeading: "this heading is empty.",
  longHeading: `this heading is longer than ${TERMS_LIMITS.headingChars} characters.`,
  emptyBullet: "this bullet is empty.",
  noBody: 'there are no terms after "terms:".',
  longBody: `the full terms pass ${TERMS_LIMITS.bodyBytes.toLocaleString("en-US")} bytes on this line.`,
} as const;

/** One refusal of a file, naming the line (counted from 1). */
export function lineSays(line: number, says: string): string {
  return `line ${line}: ${says}`;
}

/**
 * The characters no line may hold: C0 controls (the line end is not part of a line), DEL and
 * C1 controls, the line and paragraph separators, the direction embeddings, overrides and
 * isolates, and U+FEFF and the two noncharacters U+FFFE and U+FFFF.
 */
const NOT_ALLOWED = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff\ufffe\uffff]/u;

/** A line without the spaces (U+0020 only) at its start and end. */
function stripSpaces(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && s.charCodeAt(a) === 32) a++;
  while (b > a && s.charCodeAt(b - 1) === 32) b--;
  return s.slice(a, b);
}

/** The number of Unicode code points. */
function chars(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

const utf8 = (s: string) => new TextEncoder().encode(s).byteLength;

/** The value after `key:` on a line that starts with exactly `key:`, trimmed; null for another line. */
function valueOf(line: string, key: string): string | null {
  return line.startsWith(key + ":") ? stripSpaces(line.slice(key.length + 1)) : null;
}

/**
 * The blocks of the full terms, from its lines (already checked for characters and trimmed),
 * or the refusal. `first` is the file's line number of lines[0].
 */
function blocksOf(lines: readonly string[], first: number, stored = false): { ok: true; blocks: TermsBlock[] } | { ok: false; reason: string } {
  const blocks: TermsBlock[] = [];
  let paragraph: string[] | null = null;
  let list: string[] | null = null;
  const close = () => {
    if (paragraph !== null) blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    if (list !== null) blocks.push({ kind: "list", items: list });
    paragraph = null;
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const at = first + i;
    if (line === "") {
      close();
      continue;
    }
    // A stored body was checked when it was published; read back, nothing in it is refused: a
    // line a later rule would refuse (an empty heading or bullet) is text, and no length counts.
    const emptyMark = stripSpaces(line.slice(1)) === "";
    if ((line === "#" || line.startsWith("# ")) && !(stored && emptyMark)) {
      const text = stripSpaces(line.slice(1));
      if (text === "") return { ok: false, reason: lineSays(at, TERMS_FILE_SAYS.emptyHeading) };
      if (!stored && chars(text) > TERMS_LIMITS.headingChars) return { ok: false, reason: lineSays(at, TERMS_FILE_SAYS.longHeading) };
      close();
      blocks.push({ kind: "heading", text });
      continue;
    }
    if ((line === "-" || line.startsWith("- ")) && !(stored && emptyMark)) {
      const text = stripSpaces(line.slice(1));
      if (text === "") return { ok: false, reason: lineSays(at, TERMS_FILE_SAYS.emptyBullet) };
      if (paragraph !== null) close();
      (list ??= []).push(text);
      continue;
    }
    if (list !== null) close();
    (paragraph ??= []).push(line);
  }
  close();
  return { ok: true, blocks };
}

/**
 * The blocks of a stored body (TermsFile.body). Never refuses: a version is kept as it was
 * published and checked then, so a line a later, stricter rule would refuse is read as text
 * (the pages write every text with textContent alone). A body that reads as nothing is one
 * paragraph of its own text.
 */
export function termsBlocks(body: string): TermsBlock[] {
  const read = blocksOf(body.split("\n").map(stripSpaces), 1, true);
  if (read.ok && read.blocks.length > 0) return read.blocks;
  return [{ kind: "paragraph", text: body }];
}

/**
 * The file in its canonical form, which is what is hashed: the five kinds of line in their
 * order, each value trimmed, each link's address as URL writes it, and the full terms with
 * their own line breaks, trimmed lines, one blank line between blocks at most, and no blank
 * line at either end. Two files that read the same have the same canonical form.
 */
export function canonicalTerms(t: Pick<TermsFile, "title" | "version" | "links" | "points" | "body">): string {
  return [`title: ${t.title}`, `version: ${t.version}`, ...t.links.map((l) => `link: ${l.label} | ${l.url}`), "main points:", ...t.points.map((p) => `- ${p}`), "terms:", t.body, ""].join("\n");
}

/** The SHA-256 hex digest of the canonical form, as stored. */
export async function termsDigest(canonical: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  let s = "";
  for (const b of digest) s += b.toString(16).padStart(2, "0");
  return s;
}

/**
 * Reads a terms file, strictly: the file, its canonical form and its digest, or the one line
 * that says why it is refused (TERMS_FILE_SAYS, with the line's number where there is one).
 * Nothing in it is ever taken as markup.
 */
export async function parseTerms(bytes: Uint8Array): Promise<{ ok: true; terms: TermsFile; canonical: string; sha256: string } | { ok: false; reason: string }> {
  if (bytes.byteLength === 0) return { ok: false, reason: TERMS_FILE_SAYS.empty };
  if (bytes.byteLength > TERMS_LIMITS.fileBytes) return { ok: false, reason: TERMS_FILE_SAYS.tooLarge };
  let text: string;
  try {
    // ignoreBOM false: one byte order mark at the very start is skipped, and only there.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return { ok: false, reason: TERMS_FILE_SAYS.notUtf8 };
  }
  const raw = text.split("\n");
  // A file that ends with a line end has nothing after it.
  if (raw.length > 1 && raw[raw.length - 1] === "") raw.pop();
  const lines: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    // A line may end CR LF; any other CR is a control character.
    const line = raw[i].endsWith("\r") ? raw[i].slice(0, -1) : raw[i];
    if (NOT_ALLOWED.test(line)) return { ok: false, reason: lineSays(i + 1, TERMS_FILE_SAYS.badCharacter) };
    lines.push(stripSpaces(line));
  }
  if (lines.every((l) => l === "")) return { ok: false, reason: TERMS_FILE_SAYS.empty };

  let i = 0;
  const next = () => {
    while (i < lines.length && lines[i] === "") i++;
    return i < lines.length ? lines[i] : null;
  };

  // title:
  const titleLine = next();
  const title = titleLine === null ? null : valueOf(titleLine, "title");
  if (title === null) return { ok: false, reason: lineSays(i + 1, TERMS_FILE_SAYS.needTitle) };
  if (title === "") return { ok: false, reason: lineSays(i + 1, TERMS_FILE_SAYS.emptyTitle) };
  if (chars(title) > TERMS_LIMITS.titleChars) return { ok: false, reason: lineSays(i + 1, TERMS_FILE_SAYS.longTitle) };
  i++;

  // version:
  const versionLine = next();
  const version = versionLine === null ? null : valueOf(versionLine, "version");
  if (version === null) return { ok: false, reason: versionLine === null ? lineSays(lines.length, TERMS_FILE_SAYS.noTermsLine) : lineSays(i + 1, TERMS_FILE_SAYS.needVersion) };
  if (version === "") return { ok: false, reason: lineSays(i + 1, TERMS_FILE_SAYS.emptyVersion) };
  if (chars(version) > TERMS_LIMITS.versionChars) return { ok: false, reason: lineSays(i + 1, TERMS_FILE_SAYS.longVersion) };
  i++;

  // link: lines, then main points:
  const links: TermsLink[] = [];
  for (;;) {
    const line = next();
    if (line === null) return { ok: false, reason: lineSays(lines.length, TERMS_FILE_SAYS.noTermsLine) };
    if (line === "main points:") {
      i++;
      break;
    }
    const value = valueOf(line, "link");
    if (value === null) return { ok: false, reason: lineSays(i + 1, TERMS_FILE_SAYS.needPointsOrLink) };
    if (links.length === TERMS_LIMITS.links) return { ok: false, reason: lineSays(i + 1, TERMS_FILE_SAYS.tooManyLinks) };
    const bar = value.indexOf("|");
    if (bar < 0) return { ok: false, reason: lineSays(i + 1, TERMS_FILE_SAYS.badLink) };
    const label = stripSpaces(value.slice(0, bar));
    const written = stripSpaces(value.slice(bar + 1));
    if (label === "") return { ok: false, reason: lineSays(i + 1, TERMS_FILE_SAYS.emptyLinkLabel) };
    if (chars(label) > TERMS_LIMITS.linkLabelChars) return { ok: false, reason: lineSays(i + 1, TERMS_FILE_SAYS.longLinkLabel) };
    // The strict rule: https, a plain host name (no IP address), no user name or password, no
    // fragment, nothing URL would mend, and as URL writes it at most the cap.
    const url = httpsAddressFrom(written, { maxChars: TERMS_LIMITS.linkUrlChars, strict: true });
    if (url === null) return { ok: false, reason: lineSays(i + 1, TERMS_FILE_SAYS.badLinkUrl) };
    links.push({ label, url });
    i++;
  }

  // - points, then terms:
  const points: string[] = [];
  for (;;) {
    const line = next();
    if (line === null) return { ok: false, reason: lineSays(lines.length, TERMS_FILE_SAYS.noTermsLine) };
    if (line === "terms:") {
      if (points.length === 0) return { ok: false, reason: lineSays(i + 1, TERMS_FILE_SAYS.noPoints) };
      i++;
      break;
    }
    if (line !== "-" && !line.startsWith("- ")) return { ok: false, reason: lineSays(i + 1, TERMS_FILE_SAYS.needPoint) };
    const point = stripSpaces(line.slice(1));
    if (point === "") return { ok: false, reason: lineSays(i + 1, TERMS_FILE_SAYS.emptyPoint) };
    if (chars(point) > TERMS_LIMITS.pointChars) return { ok: false, reason: lineSays(i + 1, TERMS_FILE_SAYS.longPoint) };
    if (points.length === TERMS_LIMITS.points) return { ok: false, reason: lineSays(i + 1, TERMS_FILE_SAYS.tooManyPoints) };
    points.push(point);
    i++;
  }

  // The full terms: from here to the end, blank lines at either end dropped and runs of them made one.
  const start = i;
  let end = lines.length;
  let from = start;
  while (from < end && lines[from] === "") from++;
  while (end > from && lines[end - 1] === "") end--;
  // Named by the line "terms:" itself, which is line `start` counted from 1.
  if (from === end) return { ok: false, reason: lineSays(start, TERMS_FILE_SAYS.noBody) };
  const kept: string[] = [];
  const numbers: number[] = [];
  let bytesSoFar = 0;
  for (let k = from; k < end; k++) {
    if (lines[k] === "" && kept[kept.length - 1] === "") continue;
    bytesSoFar += utf8(lines[k]) + (kept.length > 0 ? 1 : 0);
    if (bytesSoFar > TERMS_LIMITS.bodyBytes) return { ok: false, reason: lineSays(k + 1, TERMS_FILE_SAYS.longBody) };
    kept.push(lines[k]);
    numbers.push(k + 1);
  }
  // blocksOf names a line by its place in `kept`; map it back to the file's own line.
  const read = blocksOf(kept, 1);
  if (!read.ok) {
    const m = /^line (\d+): /.exec(read.reason);
    const at = m === null ? from + 1 : numbers[Number(m[1]) - 1];
    return { ok: false, reason: lineSays(at, read.reason.slice(m === null ? 0 : m[0].length)) };
  }
  const terms: TermsFile = { title, version, links, points, body: kept.join("\n"), blocks: read.blocks };
  const canonical = canonicalTerms(terms);
  return { ok: true, terms, canonical, sha256: await termsDigest(canonical) };
}

// ---- The versions the database keeps ----

/** A version's row as the routes and the command read it. */
type VersionRow = { id: string; seq: number; title: string; version_label: string; points: string; links: string; body: string; sha256: string; published_at: number };
const VERSION_COLUMNS = "id, seq, title, version_label, points, links, body, sha256, published_at";

/** One version as the API answers it: its id, title, label, main points, links, the full terms as blocks, and when it was published. */
export type TermsAnswer = { id: string; title: string; version: string; points: string[]; links: TermsLink[]; body: TermsBlock[]; published_at: number };

/** A stored JSON list, or an empty one for text that is not one (only a changed database holds such text). */
function storedList(raw: string): unknown[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** The stored main points: every text as it was published; anything that is not text is left out. */
function listOfText(raw: string): string[] {
  return storedList(raw).filter((x): x is string => typeof x === "string");
}

/**
 * The stored links, each checked again on the way out by today's rule: only an address of the
 * strict shape is ever handed on. A link that fails it (a later release may tighten the rule,
 * and a version is never changed) is left out, never an error: the rest of the version is still
 * served and can still be agreed to.
 */
function listOfLinks(raw: string): TermsLink[] {
  const out: TermsLink[] = [];
  for (const x of storedList(raw)) {
    const l = x as { label?: unknown; url?: unknown } | null;
    if (l === null || typeof l !== "object" || typeof l.label !== "string" || l.label === "" || typeof l.url !== "string") continue;
    const url = httpsAddressFrom(l.url, { maxChars: TERMS_LIMITS.linkUrlChars, strict: true });
    if (url !== null) out.push({ label: l.label, url });
  }
  return out;
}

function answerOf(row: VersionRow): TermsAnswer {
  return { id: row.id, title: row.title, version: row.version_label, points: listOfText(row.points), links: listOfLinks(row.links), body: termsBlocks(row.body), published_at: row.published_at };
}

/** A new version id: "trm_" and 24 lowercase hex characters, the form every row id has. */
function newTermsId(): string {
  let s = "trm_";
  for (const b of crypto.getRandomValues(new Uint8Array(12))) s += b.toString(16).padStart(2, "0");
  return s;
}

/** True for the database's refusal of a second version with the same content. */
function isSameContent(err: unknown): boolean {
  return refusedFor(err, "sha256");
}

/** True for the database's refusal of a second version with the same number: two publishes at the same moment. */
function isSameNumber(err: unknown): boolean {
  return refusedFor(err, "seq");
}

function refusedFor(err: unknown, column: string): boolean {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 3; e = e.cause, depth++) {
    if (new RegExp(`\\bUNIQUE constraint failed: terms_version\\.${column}\\b`).test(e.message)) return true;
  }
  return false;
}

/**
 * Adds a file parseTerms read as the newest version, or says why not: "same" when a version
 * with the same canonical content exists, with its number and id when it can be read; "busy"
 * when another version took the next number at the same moment. Nothing is written either way.
 * One read and one write; the write takes the next seq in the same statement, and the
 * database's unique digest and number decide between two publishes at once.
 */
export async function publishTerms(
  deps: Deps,
  file: { terms: TermsFile; sha256: string },
): Promise<{ ok: true; id: string; seq: number } | { ok: false; problem: "same"; version: { seq: number; id: string } | null } | { ok: false; problem: "busy" }> {
  const same = await deps.db.first<{ id: string; seq: number }>("SELECT id, seq FROM terms_version WHERE sha256 = ?", [file.sha256]);
  if (same !== null) return { ok: false, problem: "same", version: { seq: same.seq, id: same.id } };
  const id = newTermsId();
  const t = file.terms;
  try {
    await deps.db.run(`INSERT INTO terms_version (${VERSION_COLUMNS}) SELECT ?, coalesce(max(seq), 0) + 1, ?, ?, ?, ?, ?, ?, ? FROM terms_version`, [
      id,
      t.title,
      t.version,
      JSON.stringify(t.points),
      JSON.stringify(t.links),
      t.body,
      file.sha256,
      deps.now(),
    ]);
  } catch (err) {
    if (isSameContent(err)) return { ok: false, problem: "same", version: null };
    if (isSameNumber(err)) return { ok: false, problem: "busy" };
    throw err;
  }
  const row = await deps.db.first<{ seq: number }>("SELECT seq FROM terms_version WHERE id = ?", [id]);
  return { ok: true, id, seq: row?.seq ?? 0 };
}

/** Every version, oldest first, without its text: for the command's list. */
export async function listTerms(deps: Deps): Promise<{ id: string; seq: number; title: string; version: string; sha256: string; published_at: number; agreed: number }[]> {
  const rows = await deps.db.all<{ id: string; seq: number; title: string; version_label: string; sha256: string; published_at: number; agreed: number }>(
    "SELECT t.id, t.seq, t.title, t.version_label, t.sha256, t.published_at, (SELECT count(*) FROM terms_agreement a WHERE a.terms_id = t.id) AS agreed FROM terms_version t ORDER BY t.seq",
  );
  return rows.map((r) => ({ id: r.id, seq: r.seq, title: r.title, version: r.version_label, sha256: r.sha256, published_at: r.published_at, agreed: r.agreed }));
}

/** One version, with everything it holds and its canonical form, or null: for the command's show. */
export async function showTerms(deps: Deps, id: string): Promise<{ answer: TermsAnswer; canonical: string; sha256: string; seq: number } | null> {
  if (!/^trm_[0-9a-f]{24}$/.test(id)) return null;
  const row = await deps.db.first<VersionRow>(`SELECT ${VERSION_COLUMNS} FROM terms_version WHERE id = ?`, [id]);
  if (row === null) return null;
  const answer = answerOf(row);
  return { answer, canonical: canonicalTerms({ title: row.title, version: row.version_label, links: answer.links, points: answer.points, body: row.body }), sha256: row.sha256, seq: row.seq };
}

// ---- The session requests of the terms screen ----

const TERMS_ID = /^trm_[0-9a-f]{24}$/;
const NEEDS_TERMS = 'the body must be JSON such as {"terms": "trm_…"}, the id of the terms shown, with nothing else in it';

/** The details of the refusals here, besides the guard's (src/auth.ts). Plain words, fixed text. */
export const TERMS_DETAILS = {
  changed: "these are not the current terms: read the new version and agree to it",
} as const;

/** The 401 of `requireAuth`, for a session that resolved without its part (never, in practice). */
function unauthorized(): Response {
  return new Response('{"error":"unauthorized"}', { status: 401, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/**
 * The account's newest agreement (the version and when), or null. By the time it was made,
 * and by the version's order for two at the same moment.
 */
const NEWEST_AGREEMENT = `SELECT a.terms_id, a.agreed_at, t.version_label FROM terms_agreement a JOIN terms_version t ON t.id = a.terms_id
  WHERE a.user_id = ? ORDER BY a.agreed_at DESC, t.seq DESC LIMIT 1`;

export function termsRoutes(app: Hono, deps: Deps): void {
  /**
   * The current terms, the account's newest agreement, whether the account still has to agree
   * (`required`), and the session's anti-forgery value, which the terms screen sends with
   * "I agree" (GET /api/v1/session is closed until then). Open before agreeing. Two reads.
   */
  app.get("/api/v1/terms", async (c) => {
    const req = c.req.raw;
    const auth = await requireAuth(req, deps, { only: "session", terms: "open" });
    if (auth instanceof Response) return auth;
    const secret = readSessionCookie(req);
    if (auth.session === undefined || secret === null) return unauthorized();
    const current = await deps.db.first<VersionRow & { agreed: number }>(
      `SELECT ${VERSION_COLUMNS}, EXISTS (SELECT 1 FROM terms_agreement a WHERE a.user_id = ? AND a.terms_id = terms_version.id) AS agreed FROM terms_version ORDER BY seq DESC LIMIT 1`,
      [auth.session.userId],
    );
    const agreed = await deps.db.first<{ terms_id: string; agreed_at: number; version_label: string }>(NEWEST_AGREEMENT, [auth.session.userId]);
    return json(200, {
      terms: current === null ? null : answerOf(current),
      agreed: agreed === null ? null : { terms_id: agreed.terms_id, version: agreed.version_label, agreed_at: agreed.agreed_at },
      required: current !== null && current.agreed !== 1,
      csrf: await csrfFor(secret),
    });
  });

  /**
   * The version the account agreed to most recently, with the time, for the read-only page;
   * `terms` is null when the account has agreed to none. Open before agreeing. One read and,
   * with an agreement, one more.
   */
  app.get("/api/v1/terms/agreed", async (c) => {
    const auth = await requireAuth(c.req.raw, deps, { only: "session", terms: "open" });
    if (auth instanceof Response) return auth;
    if (auth.session === undefined) return unauthorized();
    const agreed = await deps.db.first<{ terms_id: string; agreed_at: number }>(NEWEST_AGREEMENT, [auth.session.userId]);
    if (agreed === null) return json(200, { terms: null, agreed_at: null });
    const row = await deps.db.first<VersionRow>(`SELECT ${VERSION_COLUMNS} FROM terms_version WHERE id = ?`, [agreed.terms_id]);
    if (row === null) return json(200, { terms: null, agreed_at: null });
    return json(200, { terms: answerOf(row), agreed_at: agreed.agreed_at });
  });

  /**
   * "I agree": `{"terms": "<the id of the version shown>"}` and nothing else, sent as
   * application/json (ownJsonBody, the rule every session change's JSON body has). Records, for the
   * caller's own account only, that it agreed to that version now, only while it is still the
   * current one: a version that is not (a newer one was published meanwhile, an older or
   * unknown id, a site with none) is 409 `terms_changed` and nothing is written. Agreeing again
   * to a version already agreed to answers 204 and writes nothing. A session request that
   * changes something: the guard's origin and anti-forgery checks apply (src/auth.ts).
   *
   * One read, then one batch: the row, only while the version is the newest and the account has
   * not agreed to it, and the audit row `terms_agreed` (the account, its workspace and the
   * version, ids only) as the batch's guard, so the two are written together or not at all.
   * When the batch writes nothing (a version published, or the same agreement made, between
   * the read and the batch), one more read decides between 204 and 409.
   */
  app.post("/api/v1/terms/agree", async (c) => {
    const req = c.req.raw;
    const auth = await requireAuth(req, deps, { only: "session", terms: "open" });
    if (auth instanceof Response) return auth;
    if (auth.session === undefined) return unauthorized();
    const userId = auth.session.userId;

    // The shared rule of a session change's body (src/signin.ts): this address, a page of it,
    // labelled application/json, a JSON object of at most MAX_BODY_BYTES.
    const body = await ownJsonBody(req, deps, NEEDS_TERMS);
    if (body instanceof Response) return body;
    // The one field and nothing else: no account, no time, nothing the server takes from the session.
    if (Object.keys(body).some((k) => k !== "terms")) return apiError(400, "bad_request", NEEDS_TERMS);
    const shown = (body as Record<string, unknown>).terms;
    if (typeof shown !== "string" || !TERMS_ID.test(shown)) return apiError(400, "bad_request", NEEDS_TERMS);

    const state = async () =>
      deps.db.first<{ current: string | null; agreed: number }>(
        "SELECT (SELECT id FROM terms_version ORDER BY seq DESC LIMIT 1) AS current, EXISTS (SELECT 1 FROM terms_agreement WHERE user_id = ? AND terms_id = ?) AS agreed",
        [userId, shown],
      );
    const before = await state();
    if (before === null || before.current !== shown) return apiError(409, "terms_changed", TERMS_DETAILS.changed);
    if (before.agreed === 1) return noContent();
    try {
      await deps.db.batch([
        {
          sql: `INSERT INTO terms_agreement (user_id, terms_id, agreed_at)
                SELECT ?, t.id, ? FROM terms_version t
                 WHERE t.id = ? AND t.seq = (SELECT max(seq) FROM terms_version)
                   AND NOT EXISTS (SELECT 1 FROM terms_agreement a WHERE a.user_id = ? AND a.terms_id = t.id)`,
          params: [userId, deps.now(), shown, userId],
        },
        auditStatement(deps, { event: "terms_agreed", userId, workspaceId: auth.workspaceId, subject: shown }, { onlyAfterOneChange: true }),
      ]);
    } catch (err) {
      if (!isNotNullViolation(err)) throw err;
      const after = await state();
      return after !== null && after.agreed === 1 ? noContent() : apiError(409, "terms_changed", TERMS_DETAILS.changed);
    }
    return noContent();
  });
}
