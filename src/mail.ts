// Mail as the core sees it: one port, the mailer that is off, the sign-in mail's text
// and the address a sign-in link starts with. No platform API here: the SMTP client
// lives in src/node/smtp.ts, and tests use test/fake-mail.ts.
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
 * What linkOrigin reads. `siteHost` is the SITE_HOST setting of a one-address site; it
 * joins `Config` itself with the settings task, and is declared here until then.
 */
export type LinkConfig = Config & { siteHost?: string | null };

/**
 * The origin every sign-in link starts with, or null when the site has no configured
 * address. It comes from configuration only, never from a request: the app address in
 * two-address mode, else SITE_HOST. Either goes through normaliseHost, so the origin is
 * always one signInLink takes; an app address that is not a plain host name gives null
 * rather than falling back. With null, no mail may be sent.
 */
export function linkOrigin(config: LinkConfig): string | null {
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
