import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "#harness": fileURLToPath(new URL("./test/harness.node.ts", import.meta.url)) },
  },
  test: {
    include: ["test/**/*.test.ts"],
    // The suite runs its files side by side, and with some two thousand tests a slow one
    // crossed the default five seconds on a busy machine: a timeout, not a failure. A test
    // that needs longer than this still names its own limit.
    testTimeout: 20_000,
  },
});
