// Mail as the core sees it: one port, the mailer that is off, the texts of the sign-in and
// email-change mails, and the address their links start with. No platform API here: the
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

/**
 * The link of one invite code: like a sign-in link, the code sits after the `#`, on the
 * page that lets the invited person choose a username: `<origin>/invite#<code>`. The same
 * rules for the origin and the code as `signInLink`, and the same two errors.
 */
export function inviteLink(origin: string, code: string): string {
  if (!isOrigin(origin)) throw new Error("bad origin");
  if (typeof code !== "string" || !CODE_CHARS.test(code)) throw new Error("bad code");
  return `${origin}/invite#${code}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** A day as a mail writes it: the day of the month, the month's abbreviation and the year, in UTC, such as "27 Nov 2026". */
export function mailDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** A username as `src/usernames.ts` stores one; anything else is not put in a mail. */
const STORED_USERNAME = /^[a-z][a-z0-9-]{2,29}$/;

/**
 * The invite mail, in the words of the approved mockup. It names the admin who sent it by
 * username, or, for an inviter without one (or one whose account is gone), says nothing of
 * who sent it. The link is on a line of its own, once. `expiresAt` is when the link stops
 * working, written as `mailDate` writes it.
 */
export function inviteMail(to: string, inviter: string | null, link: string, expiresAt: number, siteName: string = DEFAULT_SITE_NAME): Mail {
  const name = siteNameOf(siteName);
  const who = typeof inviter === "string" && STORED_USERNAME.test(inviter) ? `${inviter} invited you` : "You are invited";
  return {
    to,
    subject: `You are invited to ${name}`,
    text: [
      `${who} to ${name}, a tool for sharing screenshots, clips and click-through tours.`,
      "",
      "Open this link to choose a username and get started:",
      "",
      link,
      "",
      `It works once and until ${mailDate(expiresAt)}. If you were not expecting this, ignore this mail: nothing happens without the link.`,
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
