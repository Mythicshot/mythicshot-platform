import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(fileURLToPath(new URL("./migrations", import.meta.url)));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        // Test-only binding: the harness applies these with applyD1Migrations.
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    resolve: {
      alias: { "#harness": fileURLToPath(new URL("./test/harness.cloudflare.ts", import.meta.url)) },
    },
    test: {
      include: ["test/**/*.test.ts"],
      // Tests of the Node adapters' internals run only under the Node config.
      exclude: ["test/node-*.test.ts", "node_modules/**"],
    },
  };
});
