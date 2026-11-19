// The client address of a request: the network address the request came from, as the
// target's entry knows it. Each entry sets it once, before the app sees the request (the
// Node entry from the socket or one named header, the Cloudflare entry from the
// connecting address); nothing in the core reads a header for it, so a visitor cannot
// choose it. It is used for rate limits only and is never logged or stored as it is.
//
// Whatever an entry hands in is kept only when it is one bare IP address, and then in one
// form, so two spellings of an address are never two addresses.

/** Longer than any way to write one address (an IPv6 address with a zone is under 100). */
const MAX_ADDRESS_CHARS = 100;

const V4_PART = /^(?:0|[1-9][0-9]{0,2})$/;
const V6_GROUP = /^[0-9a-f]{1,4}$/;
const ZONE = /^[A-Za-z0-9._~-]{1,32}$/;

/** The four numbers of a dotted IPv4 address, or null. No leading zeros, nothing above 255. */
function parseV4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!V4_PART.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** Colon-separated groups as numbers; an IPv4 tail, allowed only at the very end, counts as two. Null when any is malformed. */
function parseGroups(text: string, tailAllowed: boolean): number[] | null {
  if (text === "") return [];
  const parts = text.split(":");
  const out: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (tailAllowed && i === parts.length - 1 && part.includes(".")) {
      const v4 = parseV4(part);
      if (v4 === null) return null;
      out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
    } else if (V6_GROUP.test(part)) {
      out.push(parseInt(part, 16));
    } else {
      return null;
    }
  }
  return out;
}

/** The eight groups of an IPv6 address written in lower case without a zone, or null. */
function parseV6(text: string): number[] | null {
  const gap = text.indexOf("::");
  if (gap < 0) {
    const all = parseGroups(text, true);
    return all !== null && all.length === 8 ? all : null;
  }
  if (text.indexOf("::", gap + 1) >= 0) return null;
  const head = parseGroups(text.slice(0, gap), false);
  const tail = parseGroups(text.slice(gap + 2), true);
  // The gap stands for at least one group of zeros.
  if (head === null || tail === null || head.length + tail.length > 7) return null;
  return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

/** Eight groups as text: lower case, no leading zeros, the longest run of two or more zero groups (the first of equals) as `::`. */
function writeV6(groups: number[]): string {
  let best = -1;
  let bestLength = 1;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLength) {
      best = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = (from: number, to: number) => groups.slice(from, to).map((n) => n.toString(16)).join(":");
  return best < 0 ? hex(0, 8) : `${hex(0, best)}::${hex(best + bestLength, 8)}`;
}

/**
 * `text` as one IP address in its one form, or null when it is not a bare IP address.
 * Outer spaces are dropped. IPv4 is four numbers without leading zeros. IPv6 is written
 * in lower case in its shortest standard form, without the zone (`%eth0`) that names an
 * interface of this machine; an IPv4 address written as IPv6 (`::ffff:192.0.2.1`, in any
 * spelling) is the IPv4 address. Brackets, a port, a list, a label such as `for=` or a
 * host name are not an address. Never throws.
 */
export function canonicalAddress(text: unknown): string | null {
  if (typeof text !== "string" || text.length > MAX_ADDRESS_CHARS) return null;
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const v4 = parseV4(trimmed);
  if (v4 !== null) return v4.join(".");
  let address = trimmed;
  const percent = address.indexOf("%");
  if (percent >= 0) {
    if (!ZONE.test(address.slice(percent + 1))) return null;
    address = address.slice(0, percent);
  }
  if (!address.includes(":")) return null;
  const groups = parseV6(address.toLowerCase());
  if (groups === null) return null;
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join(".");
  }
  return writeV6(groups);
}

// Keyed by the request itself, so an address lives exactly as long as its request and a
// copy of a request has none.
const addresses = new WeakMap<Request, string>();

/**
 * Records where `req` came from, in the one form canonicalAddress gives. Called by a
 * target's entry only. Null, or anything that is not one bare IP address, records that
 * the address is unknown.
 */
export function setClientAddress(req: Request, address: string | null): void {
  const canonical = canonicalAddress(address);
  if (canonical === null) addresses.delete(req);
  else addresses.set(req, canonical);
}

/** The address an entry recorded for `req`, or null when none was: unknown, never a guess. */
export function clientAddressOf(req: Request): string | null {
  return addresses.get(req) ?? null;
}
