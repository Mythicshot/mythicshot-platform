// The Node target's settings, read from the environment, and the guard it puts in front
// of the app. Pure: no file, no network and no listener, so all of it can be tested
// without starting the app. (The SMTP client it makes for a usable mail block opens its
// first connection only when a mail is sent.)
import { canonicalAddress } from "../client.ts";
import { parseEmail } from "../accounts.ts";
import { misdirected } from "../host-gate.ts";
import { normaliseHost, resolveHosts, type Hosts } from "../hosts.ts";
import { linkOrigin, NO_MAIL, type Mailer } from "../mail.ts";
import type { Config } from "../ports.ts";
import { setupCodeFromEnv } from "../setup.ts";
import { allowanceFromSetting } from "../usage.ts";
import { smtpMailer, type SmtpSettings } from "./smtp.ts";

/**
 * Every setting the Node target reads from the environment, here and in entry.ts. A test
 * holds this list equal to what the two files read, so a new setting cannot be left out:
 * the admin command's startup clears each of them before it reads the settings file.
 */
export const NODE_SETTINGS: readonly string[] = [
  "APP_HOST", "CLIENT_ADDRESS_HEADER", "DATA_DIR", "MAIL_FROM", "MAIL_MODE", "PORT", "PUBLIC_IMAGE_BASE", "SETUP_CODE",
  "SITE_HOST", "SMTP_HOST", "SMTP_PASSWORD", "SMTP_PORT", "SMTP_USER", "STORAGE_ALLOWANCE_BYTES", "TOURS_HOST",
  "INVITE_CONTACT",
];

/**
 * The app's configuration from the environment: PUBLIC_IMAGE_BASE, SETUP_CODE and the two
 * optional addresses, TOURS_HOST and APP_HOST. With neither address set, `hosts` is null
 * and the app serves one address as before. A pair that cannot be used (one without the
 * other, a value that is not a host name, the same name twice) throws an Error whose
 * message is the one fixed line to show; it names the settings and never repeats a value.
 *
 * STORAGE_ALLOWANCE_BYTES is the site's default storage allowance per workspace. Unset or
 * empty, the config has no such key and nothing is limited, as before the setting
 * existed. A value that is not digits only throws its own fixed line the same way: a
 * mistyped limit stops the start rather than quietly lifting the limit.
 *
 * SITE_HOST is the host name sign-in links use on a one-address site. It is read only
 * when the two addresses are not set (with them, links use the app address and SITE_HOST
 * is ignored), and it never stops the start: unset, empty or not a host name, the config
 * has no such key and the site has no address for links. mailFromEnv says so when mail
 * is switched on.
 */
export function configFromEnv(env: NodeJS.ProcessEnv): Config {
  const hosts = resolveHosts({ tours: env.TOURS_HOST, app: env.APP_HOST });
  if (!hosts.ok) throw new Error(hosts.problem);
  const allowance = allowanceFromSetting(env.STORAGE_ALLOWANCE_BYTES);
  if (!allowance.ok) throw new Error(allowance.problem);
  const siteHost = hosts.hosts === null && typeof env.SITE_HOST === "string" ? normaliseHost(env.SITE_HOST) : null;
  // Who to ask for an invite: passed on as written, checked by the sign-in page, never a reason to stop.
  const inviteContact = typeof env.INVITE_CONTACT === "string" ? env.INVITE_CONTACT.trim() : "";
  return {
    publicImageBase: env.PUBLIC_IMAGE_BASE ?? "",
    setupCode: setupCodeFromEnv(env.SETUP_CODE),
    hosts: hosts.hosts,
    ...(allowance.bytes === null ? {} : { storageAllowanceBytes: allowance.bytes }),
    ...(siteHost === null ? {} : { siteHost }),
    ...(inviteContact === "" ? {} : { inviteContact }),
  };
}

/** The line for a mail setting that is missing or cannot be used. It names the setting and never repeats a value. */
function mailOffBecause(setting: string): string {
  return `mail: off, because ${setting} is missing or not usable. The site runs; sign-in mails are not sent.`;
}

/** The line for mail switched on at a site that has no address to put in a sign-in link. */
const NO_LINK_HOST = "mail: off, because no address for sign-in links is set. Set APP_HOST and TOURS_HOST, or SITE_HOST.";

/** The port of SMTP over TLS from the first byte, used when SMTP_PORT is not set. */
const SMTP_TLS_PORT = 465;

// A mailbox sign-in name or password: at least one character, at most 255, none of them a
// control character (a line break or a NUL could end the line or the field it is sent in).
const NO_CONTROL = /^[^\p{Cc}\p{Zl}\p{Zp}]{1,255}$/u;

/**
 * The mailer from the mail settings, and what to say at the start. Never throws and
 * writes nothing itself: a mail block that cannot be used leaves mail off and the site
 * running, and `problem` is then the one fixed line for the entry to write. It names the
 * first setting that is missing or not usable and never holds a value, so no address,
 * host name or password can reach a log through it.
 *
 * MAIL_MODE is `off` (also when unset or empty; nothing else is then read and nothing is
 * said) or `smtp`. For `smtp` every one of these must be usable, or mail stays off:
 * MAIL_FROM, one plain address; SMTP_HOST, a host name or IPv4 address without a port;
 * SMTP_PORT, 1 to 65535, 465 when unset or empty (the connection is TLS from the first
 * byte on whatever port is given; there is no STARTTLS); SMTP_USER and SMTP_PASSWORD,
 * the mailbox's sign-in; and an address for sign-in links from `config` (the app address,
 * else SITE_HOST), without which a mail would have no link to carry.
 *
 * The password is read here and handed to the SMTP client only. It is taken exactly as
 * written; the other values are trimmed. Making the mailer contacts nothing: the first
 * connection is made by the first send. `make` replaces how the client is made (tests).
 *
 * `setting` is the name of the setting that line names (such as SMTP_PORT), for a caller
 * that says it in words of its own; it is null when mail is on, is off by choice, or is
 * off because no address for links is set at all.
 */
export function mailFromEnv(
  env: NodeJS.ProcessEnv,
  config: Config,
  make: (settings: SmtpSettings) => Mailer = smtpMailer,
): { mailer: Mailer; mode: "off" | "smtp"; problem: string | null; setting: string | null } {
  const off = (problem: string | null, setting: string | null = null) => ({ mailer: NO_MAIL, mode: "off" as const, problem, setting });
  const bad = (setting: string) => off(mailOffBecause(setting), setting);
  const text = (value: string | undefined) => (typeof value === "string" ? value.trim() : "");

  const mode = text(env.MAIL_MODE).toLowerCase();
  if (mode === "" || mode === "off") return off(null);
  if (mode !== "smtp") return bad("MAIL_MODE");

  const from = parseEmail(env.MAIL_FROM);
  if (from === null) return bad("MAIL_FROM");

  // No colon at all in what was written: a port belongs in SMTP_PORT, and one the host
  // rule would drop (`:443`) must not end as a quiet connection on the default port.
  const hostText = text(env.SMTP_HOST);
  const host = hostText.includes(":") ? null : normaliseHost(hostText);
  if (host === null) return bad("SMTP_HOST");

  const portText = text(env.SMTP_PORT);
  const port = portText === "" ? SMTP_TLS_PORT : /^[1-9][0-9]{0,4}$/.test(portText) ? Number(portText) : 0;
  if (port < 1 || port > 65535) return bad("SMTP_PORT");

  const user = text(env.SMTP_USER);
  if (!NO_CONTROL.test(user)) return bad("SMTP_USER");

  const password = env.SMTP_PASSWORD;
  if (typeof password !== "string" || !NO_CONTROL.test(password)) return bad("SMTP_PASSWORD");

  // Last: where a sign-in link points. A SITE_HOST that was written but is not a host
  // name is named as the setting to fix; with nothing written the line says what to set.
  const origin = linkOrigin(config);
  if (origin === null) {
    const written = (config.hosts ?? null) === null && text(env.SITE_HOST) !== "" && normaliseHost(text(env.SITE_HOST)) === null;
    return written ? bad("SITE_HOST") : off(NO_LINK_HOST);
  }
  // The name this site gives the mail server is its own link host, without a port.
  const helo = origin.replace(/^https?:\/\//, "").split(":")[0];

  return { mailer: make({ host, port, user, password, from, helo }), mode: "smtp", problem: null, setting: null };
}

/** The line for a CLIENT_ADDRESS_HEADER that cannot be used. It never repeats the value. */
const BAD_CLIENT_HEADER = "client address: unknown, because CLIENT_ADDRESS_HEADER is not a usable header name. The site runs; no request is counted by its network address.";

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Header names that cannot carry the client address, because of how Node hands them over.
 * For the first group Node keeps only the first occurrence and drops the rest, so the
 * "last value" would be the first one: the one a visitor sends, not the one the proxy
 * added. (The list is Node's own, from the documentation of `message.headers`.) Cookie
 * values are joined with `; `, and Set-Cookie is always a list.
 */
const UNUSABLE_HEADERS = new Set([
  "age", "authorization", "content-length", "content-type", "etag", "expires", "from", "host", "if-modified-since",
  "if-unmodified-since", "last-modified", "location", "max-forwards", "proxy-authorization", "referer", "retry-after",
  "server", "user-agent",
  "cookie", "set-cookie",
]);

/** What clientAddressFrom reads of an incoming request: its headers as Node gives them, and its socket. */
export type Incoming = { headers: Record<string, string | string[] | undefined>; socket: { remoteAddress?: string } };

/**
 * The client address of one incoming request, for rate limits only, or null when it is
 * not known. Without `headerName` it is the address of the socket, which is right when
 * clients connect to the app directly. Behind a proxy the socket's address is the
 * proxy's, so the install names the header its proxy writes: the address is then the
 * last value of that header (a proxy appends to what the client sent, so the last value
 * is the one the nearest proxy wrote, and anything before it is the client's own claim),
 * and never the socket's. With two proxies in a chain that both append, the last value is
 * the one the proxy next to the app wrote, which is the address of the outer proxy. A
 * header that is missing, or whose last value is not one bare IP address (no port, no
 * brackets, no `for=`), gives null: unknown, not a guess.
 *
 * The address comes back in the one form canonicalAddress gives: lower case, no zone, an
 * IPv4 address written as IPv6 as the IPv4 address.
 */
export function clientAddressFrom(headerName: string | undefined, incoming: Incoming): string | null {
  if (headerName === undefined) return canonicalAddress(incoming.socket.remoteAddress);
  const value = incoming.headers[headerName.toLowerCase()];
  const last = Array.isArray(value) ? value[value.length - 1] : value;
  if (typeof last !== "string") return null;
  return canonicalAddress(last.slice(last.lastIndexOf(",") + 1));
}

/**
 * How the Node entry reads the client address, from the CLIENT_ADDRESS_HEADER setting.
 * Unset or empty: the socket's address. A header name: that header's last value. Anything
 * else (not a header name, or one of UNUSABLE_HEADERS, of which Node does not hand over
 * the last value) never stops the start: every address is then unknown (reading the
 * socket instead could give every visitor the proxy's address, and so one shared limit),
 * and `problem` is the one fixed line for the entry to write.
 */
export function clientAddressReader(raw: string | undefined): { read: (incoming: Incoming) => string | null; problem: string | null } {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (name === "") return { read: (incoming) => clientAddressFrom(undefined, incoming), problem: null };
  if (!HEADER_NAME.test(name) || UNUSABLE_HEADERS.has(name.toLowerCase())) return { read: () => null, problem: BAD_CLIENT_HEADER };
  return { read: (incoming) => clientAddressFrom(name, incoming), problem: null };
}

/**
 * Whether a request target (the text after the method on the request line) is a path.
 * HTTP also allows a full address there, and the server library then takes the request's
 * host from it instead of from the Host header. In two-address mode the Node target
 * answers only path targets, so the Host header is the one place a host is read from.
 */
export function isPathTarget(target: string | undefined): boolean {
  return typeof target === "string" && target.startsWith("/");
}

/**
 * The guard the Node target puts in front of the app. With two addresses, a request whose
 * request line is not a path is answered as a host this install does not serve (an empty
 * 421) and never reaches `serveOne`. With one address (`hosts` null or absent) every
 * request is served, as before. `env` is what the server library hands over with each
 * request; only the request line of the incoming message is read from it.
 */
export function guardTarget(
  hosts: Hosts | null | undefined,
  serveOne: (req: Request) => Response | Promise<Response>,
): (req: Request, env: { incoming: { url?: string } }) => Response | Promise<Response> {
  if ((hosts ?? null) === null) return (req) => serveOne(req);
  return (req, env) => (isPathTarget(env.incoming.url) ? serveOne(req) : misdirected());
}
