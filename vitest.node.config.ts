import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The suites that run a second time with the files in the stand-in for R2 (0.1.71): the
 * harness (test/harness.node.ts) then builds the stores through the app's own factory with
 * FILE_STORE=r2, so publishing, who may view a tour or an item, uploads,
 * replacing and deleting are all checked on the R2 store too, and test/node-r2-isolation.test.ts
 * looks into the two buckets themselves. test/isolation.test.ts (one workspace against
 * another) is left out: over HTTP it takes more than ten minutes, and what it guards is in the
 * database queries, which do not change with the store. test/ports.test.ts is left out too: the
 * site's R2 stores refuse keys of the other bucket's kind, which the shared contract uses on both
 * stores; the contract runs unchanged on the R2 store without that guard in
 * test/node-r2-files.test.ts.
 */
export const R2_SUITES = [
  "test/publish.test.ts",
  "test/access.test.ts",
  "test/restricted.test.ts",
  "test/media.test.ts",
  "test/media-access.test.ts",
  "test/tours-manage.test.ts",
  "test/uploads.test.ts",
  "test/replace.test.ts",
  "test/account-removal.test.ts",
  "test/node-r2-isolation.test.ts",
];

export default defineConfig({
  resolve: {
    alias: { "#harness": fileURLToPath(new URL("./test/harness.node.ts", import.meta.url)) },
  },
  test: {
    // The suite runs its files side by side, and with some two thousand tests a slow one
    // crossed the default five seconds on a busy machine: a timeout, not a failure. A test
    // that needs longer than this still names its own limit.
    testTimeout: 20_000,
    projects: [
      { extends: true, test: { name: "node", include: ["test/**/*.test.ts"], exclude: ["test/node-r2-isolation.test.ts", "node_modules/**"] } },
      { extends: true, test: { name: "node-r2", include: R2_SUITES, env: { DP_TEST_FILE_STORE: "r2" } } },
    ],
  },
});
