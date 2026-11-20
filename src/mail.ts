// Mail as the core sees it: one port, the mailer that is off, the texts of the sign-in,
// email-change and new-connection mails, and the address their links start with. No platform API here: the
// SMTP client lives in src/node/smtp.ts, and tests use test/fake-mail.ts.
import { normaliseHost, originOf } from "./hosts.ts";
import type { Config } from "./ports.ts";

/** One plain-text mail to one recipient. The sender is the mailer's own setting. */
export type Mail = { to: string; subject: string; text: string };

/**
 * Hands one mail to whatever delivers it. Resolves when it was handed over, rejects
 * when it was not. A rejection never carries the mail, the recipient or a secret.
 */
export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** Thrown by the mailer of a site whose mail is off. Its text is fixed. */
export class MailOff extends Error {
  constructor() {
    super("mail is off");
    this.name = "MailOff";
  }
}

/** The mailer of a site without mail: it sends nothing and says so. */
export const NO_MAIL: Mailer = {
  send(): Promise<void> {
    return Promise.reject(new MailOff());
  },
};

/** The name the sign-in mail uses when none is given. */
export const DEFAULT_SITE_NAME = "Mythicshot";

// A name that could break out of the subject line or the first line is not used.
const PLAIN_NAME = /^[^\p{Cc}\p{Zl}\p{Zp}]{1,60}$/u;

/**
 * The sign-in mail, in the owner-approved words. It names the site and holds the link
 * on a line of its own, once; it says nothing about the account, so the same text goes
 * to everyone. An empty or unusable site name falls back to the default.
 */
export function signInMail(to: string, link: string, siteName: string = DEFAULT_SITE_NAME): Mail {
  const trimmed = typeof siteName === "string" ? siteName.trim() : "";
  const name = PLAIN_NAME.test(trimmed) ? trimmed : DEFAULT_SITE_NAME;
  return {
    to,
    subject: `Your ${name} sign-in link`,
    text: [
      `Open this link to sign in to ${name}:`,
      "",
      link,
      "",
      "It works once and for 15 minutes. If you did not ask for it, ignore this mail: nobody can sign in without the link.",
      "",
    ].join("\n"),
  };
}

/**
 * The origin every sign-in link starts with, or null when the site has no configured
 * address. It comes from configuration only, never from a request: the app address in
 * two-address mode, else SITE_HOST. Either goes through normaliseHost, so the origin is
 * always one signInLink takes; an app address that is not a plain host name gives null
 * rather than falling back. With null, no mail may be sent.
 */
export function linkOrigin(config: Config): string | null {
  const app = config.hosts?.app;
  const raw = typeof app === "string" && app !== "" ? app : config.siteHost;
  const host = typeof raw === "string" ? normaliseHost(raw) : null;
  return host === null ? null : originOf(host);
}

const CODE_CHARS = /^[A-Za-z0-9_-]{1,200}$/;

/** True for exactly what originOf gives for a normalised host: a scheme and a host, nothing after. */
function isOrigin(origin: unknown): origin is string {
  if (typeof origin !== "string") return false;
  const match = /^https?:\/\/([^/?#\s]+)$/.exec(origin);
  if (match === null) return false;
  const host = normaliseHost(match[1]);
  return host !== null && originOf(host) === origin;
}

/**
 * The link for one sign-in code. The code sits after the `#`, which a browser sends to
 * no server, so it reaches no log and no referrer. The origin must be what linkOrigin
 * gives: `https://` and a host, or `http://` for localhost, a `.localhost` name and
 * 127.0.0.1, with no path, query or fragment. Throws Error("bad origin") or
 * Error("bad code"), neither with the value, for anything else.
 */
export function signInLink(origin: string, code: string): string {
  if (!isOrigin(origin)) throw new Error("bad origin");
  if (typeof code !== "string" || !CODE_CHARS.test(code)) throw new Error("bad code");
  return `${origin}/signin/link#c=${code}`;
}

/** The site name a mail uses: the one given when it is plain, else the default. */
function siteNameOf(siteName: unknown): string {
  const trimmed = typeof siteName === "string" ? siteName.trim() : "";
  return PLAIN_NAME.test(trimmed) ? trimmed : DEFAULT_SITE_NAME;
}

/**
 * The link for one email-change code: like a sign-in link, the code sits after the `#`,
 * on the account page that finishes the change. The same rules for the origin and the
 * code as `signInLink`, and the same two errors.
 */
export function emailChangeLink(origin: string, code: string): string {
  if (!isOrigin(origin)) throw new Error("bad origin");
  if (typeof code !== "string" || !CODE_CHARS.test(code)) throw new Error("bad code");
  return `${origin}/account/email#c=${code}`;
}

/**
 * The mail to the new address of an email change, holding the link on a line of its own,
 * once. It names neither the account nor its present address: whoever has the mailbox the
 * address was typed for (a typo included) learns nothing of the account from it.
 */
export function emailChangeMail(to: string, link: string, siteName: string = DEFAULT_SITE_NAME): Mail {
  const name = siteNameOf(siteName);
  return {
    to,
    subject: `Confirm your new ${name} email address`,
    text: [
      `Open this link to make this the email address of your ${name} account:`,
      "",
      link,
      "",
      `It works once and for 15 minutes, and you need to be signed in to that ${name} account when you open it. Until you confirm it there, nothing changes. If you did not ask for this, ignore this mail.`,
      "",
    ].join("\n"),
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The longest device name a mail shows, in characters, as the API takes it. */
const MAIL_NAME_MAX = 60;

// Control characters (CR, LF, NEL and the rest), formatting characters, lone surrogates and
// the line and paragraph separators: anything that could end a line or hide in one.
const NOT_IN_A_LINE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

// Every quotation mark that could close the quoted name: the ASCII double quote, Unicode's
// opening and closing quotation punctuation (Pi, Pf), the low quotation marks (which are Ps),
// and the marks that look like a double quote or an apostrophe (fullwidth forms, double
// primes, modifier letters, ditto marks, quotation ornaments).
const QUOTE_LIKE = /["\p{Pi}\p{Pf}\u201a\u201e\u2e42\uff02\uff07\u2033\u2036\u02ba\u02dd\u02ee\u3003\u301d\u301e\u301f\u275d\u275e]/gu;

/** The at sign and its fullwidth and small forms: any of them could start an address a client links. */
const AT_SIGNS = /[@\uff20\ufe6b]/gu;

/**
 * A device name as it may stand inside the quotes of one line of a mail. The API takes only
 * names without such characters, but this does not rely on it: each character that could
 * break or hide in a line becomes U+FFFD, so the name stays on its line and nothing of it is
 * lost from sight. The name is also made inert, so it can neither pass for the site's own
 * words nor become a link: every quotation mark becomes an apostrophe, so the name cannot
 * close its quotes; `://` becomes `:/ /`, `www.` becomes `www .` and an at sign becomes
 * ` at `, so no mail client links an address or a mail address in it. Only then is a name
 * longer than MAIL_NAME_MAX characters cut there and marked "…". An empty name, or one that
 * is not text, is "(no name)". This is for the mail alone: the dashboard shows a name as it is.
 */
function lineName(name: unknown): string {
  const inert = (typeof name === "string" ? name : "")
    .replace(NOT_IN_A_LINE, "\ufffd")
    .replace(QUOTE_LIKE, "'")
    .replace(/:\/\//g, ":/ /")
    .replace(/(www)\./gi, "$1 .")
    .replace(AT_SIGNS, " at ");
  const chars = [...inert.trim()];
  if (chars.length === 0) return "(no name)";
  return chars.length > MAIL_NAME_MAX ? chars.slice(0, MAIL_NAME_MAX).join("") + "…" : chars.join("");
}

/** A moment as the mail says it, in UTC: `15 Jan 2027 at 08:00 UTC`. Throws Error("bad time") for anything but a time. */
function mailTime(ms: number): string {
  const d = new Date(typeof ms === "number" ? ms : Number.NaN);
  if (Number.isNaN(d.getTime())) throw new Error("bad time");
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} at ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}

/**
 * The mail to an account once Mythicshot on a computer has collected its token, in the words
 * of the approved mockup: which computer (its name inside quotes, on the first line, made
 * safe by `lineName`), when, in UTC, what it can do, and where to disconnect it. `origin` is
 * what linkOrigin gives; with null, or anything that is not such an origin, the last lines say
 * where to go in words and hold no link. The site name is in the subject only: the app on the
 * computer is always Mythicshot.
 */
export function connectedMail(to: string, deviceName: string, at: number, origin: string | null, siteName: string = DEFAULT_SITE_NAME): Mail {
  const name = siteNameOf(siteName);
  const where = isOrigin(origin)
    ? ["If it was not, disconnect it here and it stops working at once:", "", `${origin}/connections`]
    : ["If it was not, open the Connections page of your dashboard and disconnect it there: it stops working at once."];
  return {
    to,
    subject: `A computer was connected to your ${name} account`,
    text: [
      `Mythicshot on the computer "${lineName(deviceName)}" was connected to your account on ${mailTime(at)}. It can publish, change and delete everything in your workspace.`,
      "",
      "If that was you, nothing needs to be done.",
      "",
      ...where,
      "",
    ].join("\n"),
  };
}

/**
 * An address with most of it hidden: the first character of the part before the @, "…",
 * and the @ with everything after it, so `new@example.com` is `n…@example.com`. A part
 * before the @ of one or two characters is not shown at all (`jo@example.com` is
 * `…@example.com`), since its first character would be half of it or all of it. Takes
 * what parseEmail returned; anything without an @ after its first character is all "…".
 */
export function maskEmail(email: string): string {
  const at = typeof email === "string" ? email.lastIndexOf("@") : -1;
  if (at < 1) return "…";
  return `${at < 3 ? "" : email[0]}…${email.slice(at)}`;
}

/**
 * The notice to the old address once an email change has taken effect, in the words of the
 * approved mockup. The new address is shown partly hidden (`maskEmail`), so the notice does
 * not hand it to whoever reads the old mailbox. `username` is the account's, or null for an
 * account that has none yet, which is then called "your account".
 */
export function emailChangedMail(to: string, username: string | null, newEmail: string, siteName: string = DEFAULT_SITE_NAME): Mail {
  const name = siteNameOf(siteName);
  const account = typeof username === "string" && /^[a-z0-9-]{1,30}$/.test(username) ? `The email address of the ${name} account "${username}"` : `The email address of your ${name} account`;
  return {
    to,
    subject: `Your ${name} email address was changed`,
    text: [
      `${account} was changed to ${maskEmail(newEmail)}.`,
      "",
      "If this was you, there is nothing to do.",
      "If it was not, answer this mail or contact the person who runs this site.",
      "",
    ].join("\n"),
  };
}
