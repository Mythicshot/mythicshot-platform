import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { unstable_readConfig } from "wrangler";
import { defineConfig } from "vitest/config";

const WRANGLER_CONFIG = fileURLToPath(new URL("./wrangler.jsonc", import.meta.url));

/** The marker test/harness.cloudflare.ts requires before it empties the database and buckets. */
const LOCAL_STORAGE_MARKER = "local-simulated-storage";

/** True if any value anywhere under `node` is a `remote` setting other than false. */
function asksForRemote(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(asksForRemote);
  if (node === null || typeof node !== "object") return false;
  return Object.entries(node).some(([k, v]) => (k === "remote" && v !== false && v !== undefined) || asksForRemote(v));
}

export default defineConfig(async () => {
  const migrations = await readD1Migrations(fileURLToPath(new URL("./migrations", import.meta.url)));
  // The harness drops every table and empties both buckets before each test. That is
  // only safe on the local simulated bindings, so remote bindings are switched off
  // below, and the marker is only handed over if the Wrangler config asks for no
  // remote binding either.
  const config = unstable_readConfig({ config: WRANGLER_CONFIG });
  const local = !asksForRemote(config);
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        remoteBindings: false,
        miniflare: {
          bindings: {
            // Test-only bindings: migrations for applyD1Migrations, and the marker.
            TEST_MIGRATIONS: migrations,
            ...(local ? { TEST_STORAGE_IS_LOCAL: LOCAL_STORAGE_MARKER } : {}),
          },
        },
      }),
    ],
    resolve: {
      alias: { "#harness": fileURLToPath(new URL("./test/harness.cloudflare.ts", import.meta.url)) },
    },
    test: {
      include: ["test/**/*.test.ts"],
      // Tests of the Node adapters' internals run only under the Node config.
      exclude: ["test/node-*.test.ts", "node_modules/**"],
      // As in the Node config: with the suite this size a slow test crossed the default five
      // seconds on a busy machine, which is a timeout and not a failure.
      testTimeout: 20_000,
    },
  };
});
