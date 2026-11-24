// The username rule. Pure: no platform API, no database and no web framework. Whether a
// name is already taken is the database's question (a unique index), not this file's.
//
// A username is fixed once chosen and never appears in a tour link. It is shown beside
// what a person makes, so the rule keeps out every name that could be read as another
// name: only ASCII lowercase letters, digits and single inner hyphens can be stored.
// A held-back name can be freed later and a registered one cannot be taken back, so
// where the rule has a choice it holds more.

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;

/** A letter first, then letters, digits and hyphens, where a hyphen is always followed by a letter or digit. */
const SHAPE = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){2,29}$/;

/** Checked before lowercasing: some non-ASCII letters lowercase to ASCII ones. */
const ASCII_LETTERS_DIGITS_HYPHENS = /^[A-Za-z0-9-]+$/;

/**
 * Names nobody can choose: they read as staff or as the site itself, or they are a route,
 * a host label, a mailbox or a word a program prints for "no one". Every top-level path of
 * the app is here too (test/usernames.test.ts reads them from HOST_RULES), so no name can be
 * read as a page of the site. Sorted, lowercase, and
 * each one passes the shape rule, so a name is only here if it could otherwise be chosen
 * (`me` is refused by its length). A name cannot be freed for someone later without the
 * owner's say.
 */
const RESERVED_NAMES = [
  "abuse", "account", "accounts", "admin", "administrator", "admins", "anonymous", "api", "app",
  "assets", "auth", "autoconfig", "autodiscover", "beta", "billing", "blog", "bot", "cdn",
  "connect", "connections", "contact", "copyright", "cpanel", "dash", "dashboard", "deleted",
  "demo", "dev", "dmca", "docs", "email", "embed", "ember", "everyone", "example", "false", "favicon",
  "feedback", "fonts", "ftp", "gifs", "guest", "healthz", "hello", "help", "helpdesk", "home", "hostmaster",
  "images", "imap", "img", "info", "invite", "invites", "legal", "localhost", "login", "logout",
  "mail", "media", "media-view", "mod", "moderator", "moderators", "mods", "mythic", "mythic-lab", "mythiclab",
  "mythicshot", "nan", "new", "no-reply", "nobody", "none", "noreply", "notifications", "null",
  "oauth", "official", "openapi", "owner", "player", "postmaster", "press", "pricing", "privacy",
  "public", "register", "removed", "report", "root", "safety", "sales", "search", "security",
  "service", "session", "sessions", "settings", "setup", "share", "sign-in", "sign-out", "sign-up",
  "signin", "signout", "signup", "smtp", "staff", "staging", "static", "status", "storage",
  "superuser", "support", "sysadmin", "system", "team", "teams", "terms", "test", "token", "tokens", "tour",
  "tours", "true", "trust", "undefined", "unknown", "upload", "uploads", "usage", "user", "users",
  "view", "web", "webmail", "webmaster", "workspace", "workspaces", "www", "you",
] as const;

export const RESERVED: ReadonlySet<string> = new Set<string>(RESERVED_NAMES);

/** A name with its hyphens taken out: `ad-min` and `admin` read as one name. */
function squash(name: string): string {
  return name.replaceAll("-", "");
}

/** Every reserved name without its hyphens, from the same list. Not exported, so no caller can change it. */
const RESERVED_SQUASHED: ReadonlySet<string> = new Set<string>(RESERVED_NAMES.map(squash));

/** The product's name. No username may hold it, with or without hyphens, whatever stands around it. */
const PRODUCT_NAME = "mythicshot";

export type UsernameResult = { ok: true; username: string } | { ok: false; problem: "shape" | "reserved" };

/** Space, tab, line feed and carriage return: the only outer characters `parseUsername` drops. */
function isOuterSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

/**
 * The one stored form of a username, or why `v` cannot be one. Drops outer spaces, tabs,
 * carriage returns and line feeds (no other white space) and lowercases A to Z, then
 * asks for 3 to 30 characters matching the shape rule. Anything that is not a string,
 * and any character outside ASCII letters, digits and the hyphen, is a shape problem.
 * A name of the right shape is reserved when, with hyphens taken out, it equals a
 * reserved name with its hyphens taken out, or holds the product's name. Never throws.
 */
export function parseUsername(v: unknown): UsernameResult {
  if (typeof v !== "string") return { ok: false, problem: "shape" };
  // Two walks from the ends: one pass, whatever the length.
  let start = 0;
  let end = v.length;
  while (start < end && isOuterSpace(v.charCodeAt(start))) start++;
  while (end > start && isOuterSpace(v.charCodeAt(end - 1))) end--;
  if (end - start < USERNAME_MIN || end - start > USERNAME_MAX) return { ok: false, problem: "shape" };
  const trimmed = v.slice(start, end);
  if (!ASCII_LETTERS_DIGITS_HYPHENS.test(trimmed)) return { ok: false, problem: "shape" };
  const username = trimmed.toLowerCase();
  if (!SHAPE.test(username)) return { ok: false, problem: "shape" };
  const squashed = squash(username);
  if (RESERVED.has(username) || RESERVED_SQUASHED.has(squashed) || squashed.includes(PRODUCT_NAME)) {
    return { ok: false, problem: "reserved" };
  }
  return { ok: true, username };
}
