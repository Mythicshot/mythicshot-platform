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
 * two-address mode, else SITE_HOST. With null, no mail may be sent.
 */
export function linkOrigin(config: LinkConfig): string | null {
  const app = config.hosts?.app;
  if (typeof app === "string" && app !== "") return originOf(app);
  const site = typeof config.siteHost === "string" ? normaliseHost(config.siteHost) : null;
  return site === null ? null : originOf(site);
}

const CODE_CHARS = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * The link for one sign-in code. The code sits after the `#`, which a browser sends to
 * no server, so it reaches no log and no referrer. Throws Error("bad code"), without
 * the code, for anything that could change the link's shape.
 */
export function signInLink(origin: string, code: string): string {
  if (typeof code !== "string" || !CODE_CHARS.test(code)) throw new Error("bad code");
  return `${origin}/signin/link#c=${code}`;
}
