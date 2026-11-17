import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "#harness": fileURLToPath(new URL("./test/harness.node.ts", import.meta.url)) },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
