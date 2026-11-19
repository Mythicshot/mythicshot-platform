// The username rule. Pure: no platform API, no database and no web framework. Whether a
// name is already taken is the database's question (a unique index), not this file's.
//
// A username is fixed once chosen and never appears in a tour link. It is shown beside
// what a person makes, so the rule keeps out every name that could be read as another
// name: only ASCII lowercase letters, digits and single inner hyphens can be stored.

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;

/** A letter first, then letters, digits and hyphens, where a hyphen is always followed by a letter or digit. */
const SHAPE = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){2,29}$/;

/** Checked before lowercasing: some non-ASCII letters lowercase to ASCII ones. */
const ASCII_LETTERS_DIGITS_HYPHENS = /^[A-Za-z0-9-]+$/;

/**
 * Names nobody can choose: they read as staff or as the site itself, or they are a route,
 * a host label or a mailbox. Sorted, lowercase, and each one passes the shape rule, so a
 * name is only here if it could otherwise be chosen (`me` is refused by its length).
 * A name cannot be freed for someone later without the owner's say.
 */
const RESERVED_NAMES = [
  "abuse", "account", "accounts", "admin", "administrator", "anonymous", "api", "app", "assets",
  "billing", "blog", "cdn", "contact", "dashboard", "demo", "docs", "email", "everyone",
  "example", "hello", "help", "hostmaster", "img", "info", "invite", "invites", "login",
  "logout", "mail", "media", "mod", "moderator", "mythic", "mythic-lab", "mythiclab",
  "mythicshot", "no-reply", "none", "noreply", "null", "official", "owner", "postmaster",
  "register", "root", "security", "settings", "setup", "sign-in", "sign-out", "sign-up",
  "signin", "signout", "signup", "staff", "static", "status", "support", "system", "team",
  "teams", "test", "tour", "tours", "undefined", "user", "users", "web", "webmaster",
  "workspace", "workspaces", "www", "you",
] as const;

export const RESERVED: ReadonlySet<string> = new Set<string>(RESERVED_NAMES);

export type UsernameResult = { ok: true; username: string } | { ok: false; problem: "shape" | "reserved" };

/**
 * The one stored form of a username, or why `v` cannot be one. Trims outer white space
 * and lowercases A to Z, then asks for 3 to 30 characters matching the shape rule and
 * for a name that is not reserved. Anything that is not a string, and any character
 * outside ASCII letters, digits and the hyphen, is a shape problem. Never throws.
 */
export function parseUsername(v: unknown): UsernameResult {
  if (typeof v !== "string") return { ok: false, problem: "shape" };
  const trimmed = v.trim();
  if (trimmed.length < USERNAME_MIN || trimmed.length > USERNAME_MAX) return { ok: false, problem: "shape" };
  if (!ASCII_LETTERS_DIGITS_HYPHENS.test(trimmed)) return { ok: false, problem: "shape" };
  const username = trimmed.toLowerCase();
  if (!SHAPE.test(username)) return { ok: false, problem: "shape" };
  if (RESERVED.has(username)) return { ok: false, problem: "reserved" };
  return { ok: true, username };
}
