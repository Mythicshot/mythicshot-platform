// The client address of a request: the network address the request came from, as the
// target's entry knows it. Each entry sets it once, before the app sees the request (the
// Node entry from the socket or one named header, the Cloudflare entry from the
// connecting address); nothing in the core reads a header for it, so a visitor cannot
// choose it. It is used for rate limits only and is never logged or stored as it is.

/** Longer than any address either entry can give (an IPv6 address with a zone is under 100). */
const MAX_ADDRESS_CHARS = 100;

// Keyed by the request itself, so an address lives exactly as long as its request and a
// copy of a request has none.
const addresses = new WeakMap<Request, string>();

/**
 * Records where `req` came from. Called by a target's entry only. Null, an empty text or
 * anything that is not text records that the address is unknown.
 */
export function setClientAddress(req: Request, address: string | null): void {
  const text = typeof address === "string" ? address.trim() : "";
  if (text === "" || text.length > MAX_ADDRESS_CHARS) addresses.delete(req);
  else addresses.set(req, text);
}

/** The address an entry recorded for `req`, or null when none was: unknown, never a guess. */
export function clientAddressOf(req: Request): string | null {
  return addresses.get(req) ?? null;
}
