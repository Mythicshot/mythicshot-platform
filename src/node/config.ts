// The Node target's settings, read from the environment, and the guard it puts in front
// of the app. Pure: no file, no network and no listener, so all of it can be tested
// without starting the app.
import { misdirected } from "../host-gate.ts";
import { resolveHosts, type Hosts } from "../hosts.ts";
import type { Config } from "../ports.ts";
import { setupCodeFromEnv } from "../setup.ts";

/**
 * The app's configuration from the environment: PUBLIC_IMAGE_BASE, SETUP_CODE and the two
 * optional addresses, TOURS_HOST and APP_HOST. With neither address set, `hosts` is null
 * and the app serves one address as before. A pair that cannot be used (one without the
 * other, a value that is not a host name, the same name twice) throws an Error whose
 * message is the one fixed line to show; it names the settings and never repeats a value.
 */
export function configFromEnv(env: NodeJS.ProcessEnv): Config {
  const hosts = resolveHosts({ tours: env.TOURS_HOST, app: env.APP_HOST });
  if (!hosts.ok) throw new Error(hosts.problem);
  return {
    publicImageBase: env.PUBLIC_IMAGE_BASE ?? "",
    setupCode: setupCodeFromEnv(env.SETUP_CODE),
    hosts: hosts.hosts,
  };
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
