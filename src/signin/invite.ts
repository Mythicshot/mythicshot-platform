// Who to ask for an invite, from the optional INVITE_CONTACT setting: an email address or
// an https address. The sign-in page shows it after "Mythicshot is invite-only for now."
// Anything else, unset included, is no contact: the sentence stands alone. A value that
// cannot be used never stops the site; it is only left out.
import { parseEmail } from "../accounts.ts";

export type InviteContact = { kind: "email"; address: string } | { kind: "url"; href: string };

/** The longest INVITE_CONTACT used. */
const MAX_CHARS = 2000;

/** An address that also reads as a mailto link with nothing after it: no `?`, `%`, `#` or anything else a mailto link would act on. */
const PLAIN_ADDRESS = /^[a-z0-9._+-]+@[a-z0-9.-]+$/;

/**
 * The contact a setting names, or null. An email address must pass parseEmail and be
 * plain letters, digits and `._+-`; an address must parse as a URL, use https, carry no
 * user name or password and be visible ASCII with no space. Trimmed first.
 */
export function inviteContactFrom(raw: unknown): InviteContact | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text === "" || text.length > MAX_CHARS || !/^[\x21-\x7e]+$/.test(text)) return null;
  if (/^https:\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" || url.hostname === "" || url.username !== "" || url.password !== "") return null;
    return { kind: "url", href: url.href };
  }
  if (text.includes(":") || text.includes("/")) return null;
  const email = parseEmail(text);
  if (email === null || !PLAIN_ADDRESS.test(email)) return null;
  return { kind: "email", address: email };
}

/** Text made safe for HTML, in an element or inside a double-quoted attribute. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
