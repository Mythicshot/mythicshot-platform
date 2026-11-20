// Which host names this install serves, and in which role. Pure: no platform API and no
// web framework. A host is only ever taken from configuration or from the address a
// request was sent to, never from a request header such as X-Forwarded-Host.

/**
 * The roles an address can have. A further role is a new entry here and a `<ROLE>_HOST`
 * setting; one an install may leave out is also listed in OPTIONAL_HOST_ROLES. `tours`
 * holds what users publish, `app` the session and the dashboard, and `img` shared images
 * and clips.
 */
export const HOST_ROLES = ["tours", "app", "img"] as const;
export type HostRole = (typeof HOST_ROLES)[number];

/**
 * The roles an install with addresses may leave unset. Each is only ever set beside
 * every other role: without its own address, what it would serve answers on the tours
 * address (mediaRole).
 */
export const OPTIONAL_HOST_ROLES = ["img"] as const satisfies readonly HostRole[];
export type OptionalHostRole = (typeof OPTIONAL_HOST_ROLES)[number];
export type RequiredHostRole = Exclude<HostRole, OptionalHostRole>;

/**
 * The configured address of every role, each as a normalised `name` or `name:port`. An
 * optional role that is not set has no key at all.
 */
export type Hosts = Readonly<Record<RequiredHostRole, string> & Partial<Record<OptionalHostRole, string>>>;

/** `hosts: null` is one-address mode: no host is configured and none is checked. */
export type HostsResult = { ok: true; hosts: Hosts | null } | { ok: false; problem: string };

const MAX_NAME_CHARS = 253;
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const PORT = /^[1-9][0-9]{0,4}$/;

/**
 * A host as `name` or `name:port` in its one comparable form, or null when `raw` is not
 * a plain host name. Trims, lowercases, drops one trailing dot and a port of 80 or 443.
 * The name is at most 253 characters of dot-separated labels of letters, digits and
 * inner hyphens, each at most 63 long, so `localhost`, `*.localhost` names and dotted
 * IPv4 pass. A scheme, a path, a user name, a wildcard, an underscore, a bracketed IPv6
 * address, a non-ASCII character, an empty name and a port outside 1 to 65535 are refused.
 */
export function normaliseHost(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  // Checked before lowercasing: some non-ASCII letters lowercase to ASCII ones.
  if (!/^[\x21-\x7e]+$/.test(trimmed)) return null;
  const parts = trimmed.toLowerCase().split(":");
  if (parts.length > 2) return null;
  let name = parts[0];
  if (name.endsWith(".")) name = name.slice(0, -1);
  if (name.length === 0 || name.length > MAX_NAME_CHARS) return null;
  for (const label of name.split(".")) if (!LABEL.test(label)) return null;
  if (parts.length === 1) return name;
  const port = parts[1];
  if (!PORT.test(port) || Number(port) > 65535) return null;
  return port === "80" || port === "443" ? name : `${name}:${port}`;
}

/** The setting that holds a role's address, such as `TOURS_HOST`. */
function settingOf(role: HostRole): string {
  return `${role.toUpperCase()}_HOST`;
}

/** A host without its port. */
function nameOf(host: string): string {
  return host.split(":")[0];
}

/** True for a role an install may leave unset. */
function isOptional(role: HostRole): boolean {
  return (OPTIONAL_HOST_ROLES as readonly HostRole[]).includes(role);
}

/**
 * The configured addresses from the raw settings. None set (unset, empty or only spaces)
 * is one-address mode. Otherwise every required role needs a valid host name, an
 * optional role is either unset or a valid host name too, and no two roles may share a
 * name: cookies are not separated by port, so two ports of one name are one address. An
 * optional role set without the required ones is refused, never read as one-address
 * mode. A problem is fixed text that names the settings and never repeats a value.
 */
export function resolveHosts(raw: Partial<Record<HostRole, string | undefined>>): HostsResult {
  const values = HOST_ROLES.map((role) => {
    const v = raw[role];
    return { role, value: typeof v === "string" ? v.trim() : "" };
  });
  const set = values.filter((v) => v.value !== "");
  if (set.length === 0) return { ok: true, hosts: null };
  const required = values.filter((v) => !isOptional(v.role));
  const missing = required.find((v) => v.value === "");
  if (missing !== undefined) {
    const setRequired = set.find((v) => !isOptional(v.role));
    if (setRequired !== undefined) {
      return {
        ok: false,
        problem: `${settingOf(setRequired.role)} is set but ${settingOf(missing.role)} is not. Set both for two addresses, or neither for one.`,
      };
    }
    const extra = settingOf(set[0].role);
    const needed = required.map((v) => settingOf(v.role)).join(" and ");
    return {
      ok: false,
      problem: `${extra} is set but ${needed} are not. ${extra} is an extra address beside those two: set them too, or leave ${extra} empty.`,
    };
  }
  const hosts: Partial<Record<HostRole, string>> = {};
  for (const { role, value } of set) {
    const host = normaliseHost(value);
    if (host === null) {
      return {
        ok: false,
        problem: `${settingOf(role)} is not a host name. Write it like ${role}.example.com, without https:// and without a path.`,
      };
    }
    hosts[role] = host;
  }
  for (let i = 0; i < set.length; i++) {
    for (let j = i + 1; j < set.length; j++) {
      const a = set[i].role;
      const b = set[j].role;
      if (nameOf(hosts[a]!) === nameOf(hosts[b]!)) {
        return {
          ok: false,
          problem: `${settingOf(a)} and ${settingOf(b)} name the same host. Two addresses need two different host names.`,
        };
      }
    }
  }
  return { ok: true, hosts: hosts as Hosts };
}

/**
 * The host the request was sent to, normalised, or null when it is not a plain host
 * name. Reads only the request's own address: no header, so a visitor cannot choose it.
 */
export function requestHost(req: Request): string | null {
  try {
    return normaliseHost(new URL(req.url).host);
  } catch {
    return null;
  }
}

/** The role of a normalised host, or null when it is not one of the configured addresses (an optional role that is not set never matches). An exact match only. */
export function roleOf(hosts: Hosts, host: string | null): HostRole | null {
  if (host === null) return null;
  for (const role of HOST_ROLES) if (hosts[role] === host) return role;
  return null;
}

/** The origin of a configured host: `https://`, and `http://` only for localhost, `*.localhost` and 127.0.0.1. */
export function originOf(host: string): string {
  const name = nameOf(host);
  const local = name === "localhost" || name.endsWith(".localhost") || name === "127.0.0.1";
  return `${local ? "http" : "https"}://${host}`;
}

/**
 * The role whose address serves shared media (images and clips): the img address when it
 * is set, else the tours address.
 */
export function mediaRole(hosts: Hosts): "img" | "tours" {
  return hosts.img !== undefined ? "img" : "tours";
}

/**
 * The origin an item's public address starts with, without a trailing slash: the img
 * address when it is set, else the tours address. In one-address mode (`hosts` null or
 * absent) it is the host the request was sent to, with the scheme originOf gives a
 * configured host (so an install behind a proxy that ends HTTPS still gets https), or,
 * for a host that is not a plain name, the request's own origin. Never a header.
 */
export function mediaOrigin(hosts: Hosts | null | undefined, req: Request): string {
  if (hosts !== null && hosts !== undefined) return originOf(hosts.img ?? hosts.tours);
  const host = requestHost(req);
  return host === null ? new URL(req.url).origin : originOf(host);
}
