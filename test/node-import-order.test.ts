// The modules can be loaded in any order (Node only: it loads the Node target's own
// config module). src/usage.ts is used by the settings (which load first in the real
// entry) and by the upload routes; if it imported the routes back, whichever loaded
// second would read a constant of the other before it exists.
import { afterEach, describe, expect, it, vi } from "vitest";

const SOURCES = import.meta.glob("../src/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const importsOf = (file: string) => [...(SOURCES[`../src/${file}`] ?? "").matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gms)].map((m) => m[1]);

afterEach(() => vi.resetModules());

describe("module load order", () => {
  it("the usage module and the limits module import no route module", () => {
    expect(typeof SOURCES["../src/limits.ts"], "src/limits.ts was not read").toBe("string");
    expect(importsOf("limits.ts")).toEqual([]);
    const usage = importsOf("usage.ts");
    expect(usage.length).toBeGreaterThan(2);
    for (const from of ["./uploads.ts", "./replace.ts", "./tours.ts", "./publish.ts", "./app.ts"]) expect(usage, from).not.toContain(from);
    // And none of what it imports leads back to it, or to the upload routes.
    const seen = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const from of importsOf(file)) if (/^\.\/[a-z-]+\.ts$/.test(from)) walk(from.slice(2));
    };
    for (const from of usage) if (/^\.\/[a-z-]+\.ts$/.test(from)) walk(from.slice(2));
    expect([...seen], "src/usage.ts is imported by something it imports").not.toContain("usage.ts");
    expect([...seen]).not.toContain("uploads.ts");
  });

  it("the upload limit is one constant, wherever it is imported from", async () => {
    const limits = await import("../src/limits.ts");
    const uploads = await import("../src/uploads.ts");
    expect(limits.UPLOAD_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
    expect(uploads.UPLOAD_MAX_AGE_MS).toBe(limits.UPLOAD_MAX_AGE_MS);
  });

  const load: Record<string, () => Promise<unknown>> = {
    config: () => import("../src/node/config.ts"),
    app: () => import("../src/app.ts"),
    usage: () => import("../src/usage.ts"),
    uploads: () => import("../src/uploads.ts"),
    replace: () => import("../src/replace.ts"),
  };
  const ORDERS: [string, string[]][] = [
    ["the settings, then the routes", ["config", "app"]],
    ["the routes, then the settings", ["app", "config"]],
    ["usage, then uploads and replace", ["usage", "uploads", "replace"]],
    ["replace and uploads, then usage", ["replace", "uploads", "usage"]],
  ];
  for (const [label, order] of ORDERS) {
    it(`loading ${label} raises no ReferenceError and gives working modules`, async () => {
      vi.resetModules();
      for (const name of order) await load[name]();
      const usage = await import("../src/usage.ts");
      const uploads = await import("../src/uploads.ts");
      const app = await import("../src/app.ts");
      expect(typeof usage.USED_SQL).toBe("string");
      expect(usage.USED_SQL).not.toContain("undefined");
      expect(typeof usage.usageRoutes).toBe("function");
      expect(uploads.UPLOAD_MAX_AGE_MS).toBe(86_400_000);
      // The route table builds, with the usage route in it.
      const routes = app.createApp({ config: { publicImageBase: "", setupCode: null } } as never).routes.map((r) => `${r.method} ${r.path}`);
      expect(routes).toContain("GET /api/v1/usage");
      expect(routes).toContain("POST /api/v1/uploads");
    });
  }
});
