// The Node target's settings, read from the environment. Pure: no file, no network and
// no listener, so every setting can be tested without starting the app.
import { resolveHosts } from "../hosts.ts";
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
