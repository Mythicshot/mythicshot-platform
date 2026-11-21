// An https address from a setting, checked one way for every setting that takes one:
// INVITE_CONTACT's https form (src/signin/invite.ts) and DOWNLOAD_URL, the public page the
// desktop app is downloaded from. A value that cannot be used is never an error here: the
// caller leaves the feature out.
import { normaliseHost } from "./hosts.ts";

/** The longest DOWNLOAD_URL used, in characters, as written and as handed on. */
export const DOWNLOAD_URL_MAX = 300;

/**
 * The shape of an address the strict rule keeps, as URL writes it: https, a plain host name
 * (letters, digits and hyphens in dot-separated labels, no label starting or ending with a
 * hyphen, and a last label that is not digits alone, so no IP address in any form), an
 * optional port, then a path of characters that need no escaping anywhere and
 * an optional query; no fragment, no user name, no space, quote, angle bracket or backslash.
 * The dashboard's shared script checks the address it is handed against this same
 * expression (DOWNLOAD_URL in src/dash/script.ts; a test holds the two equal).
 */
export const STRICT_HTTPS_SHAPE = /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*(?![0-9]+(?::|\/))[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?::[0-9]{1,5})?\/[A-Za-z0-9._~!$&'()*+,;=:@%\/?-]*$/;

/**
 * The same shape for the text as written, before URL reads it: any case, and the path may
 * be left out. Checked first, so that nothing URL would quietly mend or escape (a backslash,
 * a quote, an escaped letter in the host name) is taken.
 */
const STRICT_WRITTEN = /^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?(?:[\/?][A-Za-z0-9._~!$&'()*+,;=:@%\/?-]*)?$/i;

/**
 * The address a setting names, as URL writes it, or null. Trimmed first; then it must be at
 * most `maxChars` of visible ASCII, start with `https://` (any case), parse as a URL, use
 * https, name a host and carry no user name or password. With `strict` it must also be
 * written in the shape STRICT_HTTPS_SHAPE describes (so no fragment, user name, backslash,
 * quote or escaped host), name a host normaliseHost keeps as it is (no empty label, label
 * edge hyphen or trailing dot), name the host URL reads as written, lower-cased (URL turns
 * `0x7f.1` or `2130706433` into `127.0.0.1`, another host than the one written), have a
 * last label that is not digits alone (no IP address in any form), and, as URL writes it
 * back, be at most `maxChars` long and of STRICT_HTTPS_SHAPE.
 */
export function httpsAddressFrom(raw: unknown, opts: { maxChars: number; strict?: boolean }): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text === "" || text.length > opts.maxChars || !/^[\x21-\x7e]+$/.test(text)) return null;
  if (!/^https:\/\//i.test(text)) return null;
  if (opts.strict === true && !STRICT_WRITTEN.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname === "" || url.username !== "" || url.password !== "") return null;
  if (opts.strict !== true) return url.href;
  if (normaliseHost(url.host) !== url.host) return null;
  // The host as written: from after `https://` to the port, path or query.
  const written = text.slice("https://".length).split(/[:/?]/)[0].toLowerCase();
  if (url.hostname !== written || /^[0-9]+$/.test(url.hostname.split(".").pop() ?? "")) return null;
  const href = url.href;
  return href.length <= opts.maxChars && STRICT_HTTPS_SHAPE.test(href) ? href : null;
}

/** The one line for a DOWNLOAD_URL that cannot be used. It names the setting and never repeats the value. */
export const DOWNLOAD_URL_UNUSABLE = "download page: off, because DOWNLOAD_URL is not a usable https address. The site runs; the dashboard shows no download link.";

/**
 * The address of the app's download page from the DOWNLOAD_URL setting, on either target.
 * Unset, null or empty (spaces only included): off, and nothing to say. A usable address
 * (httpsAddressFrom, strict, at most DOWNLOAD_URL_MAX characters): `url`. Anything else,
 * text or not: off, and `problem` is the one fixed line for the target to write. It never
 * stops the start.
 */
export function downloadUrlSetting(raw: unknown): { url: string | null; problem: string | null } {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return { url: null, problem: null };
  const url = httpsAddressFrom(raw, { maxChars: DOWNLOAD_URL_MAX, strict: true });
  return url === null ? { url: null, problem: DOWNLOAD_URL_UNUSABLE } : { url, problem: null };
}
