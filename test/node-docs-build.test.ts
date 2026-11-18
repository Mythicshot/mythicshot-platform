// The documentation page's two generated modules: that they are current, that the viewer
// inside is the pinned package's files and does what the page's policy allows, that its
// licence notices travel with it, and that the Worker stays small enough to deploy.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { descriptionFiles, SITE_MODULE, siteModule, VIEWER_MODULE, VIEWER_NOTICE_FILES, VIEWER_PACKAGE, viewerModule } from "../scripts/docs-bundle.ts";
import { packageCpanel } from "../scripts/package-cpanel.ts";
import { openapi } from "../src/docs/openapi.ts";
import * as site from "../src/docs/site-assets.ts";
import * as viewer from "../src/docs/viewer-assets.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p));
const pkg = JSON.parse(read("package.json").toString("utf8")) as { devDependencies: Record<string, string>; dependencies: Record<string, string>; allowScripts?: Record<string, boolean>; scripts: Record<string, string> };
const inPackage = (name: string) => read(`node_modules/${VIEWER_PACKAGE}/${name}`);
const count = (text: string, part: string) => text.split(part).length - 1;

describe("the documentation build", () => {
  it("the committed viewer module is the pinned package's files", () => {
    expect(readFileSync(VIEWER_MODULE, "utf8"), "run npm run build:docs").toBe(viewerModule());
    // Pinned to one exact version, as a development dependency only.
    expect(pkg.devDependencies[VIEWER_PACKAGE]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.dependencies[VIEWER_PACKAGE]).toBeUndefined();
    expect(viewer.VIEWER_VERSION).toBe(pkg.devDependencies[VIEWER_PACKAGE]);
    expect(viewer.VIEWER_VERSION).toBe((JSON.parse(inPackage("package.json").toString("utf8")) as { version: string }).version);
    // The strings are the files, byte for byte.
    expect(Buffer.from(viewer.VIEWER_JS, "utf8").equals(inPackage("swagger-ui-bundle.js"))).toBe(true);
    expect(Buffer.from(viewer.VIEWER_CSS, "utf8").equals(inPackage("swagger-ui.css"))).toBe(true);
    expect(viewer.VIEWER_JS.startsWith("/*! For license information please see swagger-ui-bundle.js.LICENSE.txt */")).toBe(true);
    expect(viewer.VIEWER_JS_PATH).toMatch(/^\/docs\/viewer\.[0-9a-f]{16}\.js$/);
    expect(viewer.VIEWER_CSS_PATH).toMatch(/^\/docs\/viewer\.[0-9a-f]{16}\.css$/);
    for (const tag of [viewer.VIEWER_JS_ETAG, viewer.VIEWER_CSS_ETAG]) expect(tag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(viewer.VIEWER_JS_ETAG).not.toBe(viewer.VIEWER_CSS_ETAG);
    // Its dependency's install script reports the install to its maker: it is never allowed to run.
    for (const name of Object.keys(pkg.allowScripts ?? {})) expect(name).toMatch(/^(esbuild|workerd)@/);
    // And should it ever run, it is told not to report: the package's own off switch, beside the block above.
    expect((pkg as { scarfSettings?: unknown }).scarfSettings).toEqual({ enabled: false });
  });

  it("the committed site module is what the sources build to", async () => {
    expect(readFileSync(SITE_MODULE, "utf8"), "run npm run build:docs").toBe(await siteModule());
    expect(site.DOCS_JS_PATH).toMatch(/^\/docs\/docs\.[0-9a-f]{16}\.js$/);
    expect(site.DOCS_CSS_PATH).toMatch(/^\/docs\/docs\.[0-9a-f]{16}\.css$/);
    for (const tag of [site.DOCS_JS_ETAG, site.DOCS_CSS_ETAG, site.OPENAPI_JSON_ETAG, site.OPENAPI_YAML_ETAG]) expect(tag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(new Set([site.DOCS_JS_ETAG, site.DOCS_CSS_ETAG, site.OPENAPI_JSON_ETAG, site.OPENAPI_YAML_ETAG]).size).toBe(4);
    // The page script is one self-contained function that leaves no global behind.
    expect(site.DOCS_JS.startsWith('"use strict";\n(() => {') || site.DOCS_JS.startsWith("(() => {")).toBe(true);
    expect(pkg.scripts["build:docs"]).toBe("node scripts/build-docs.ts");
    expect(pkg.scripts.build).toBe("npm run build:player && npm run build:docs && npm run build:node");
    expect(pkg.scripts.typecheck).toContain("tsc -p tsconfig.docs.json");
  }, 30_000);

  it("the viewer never evaluates text as code", () => {
    const js = viewer.VIEWER_JS;
    expect(js).not.toContain("eval(");
    expect(js).not.toMatch(/\bimport\(/);
    expect(js).not.toMatch(/set(Timeout|Interval)\(["'`]/);
    expect(js).not.toContain("WebAssembly.");
    // Exactly one `new Function`: the bundler's lookup of the global object, reached only
    // where globalThis does not exist, and inside a try.
    expect(count(js, "new Function")).toBe(1);
    expect(js).toContain('if("object"==typeof globalThis)return globalThis;try{return this||new Function("return this")()}catch');
    // Function called without `new` builds code from text just the same. Every such call
    // is either the last resort of a global-object lookup, after `||`, or the stand-in for
    // Function.prototype.bind that its own module uses only where bind is missing. None
    // runs in a browser that has globalThis, self and bind. A new one fails here.
    const calls = [...js.matchAll(/[^.\w$]Function\(/g)].map((m) => js.slice(m.index + 1, m.index + 40));
    const lookups = calls.filter((c) => c.startsWith('Function("return this")()'));
    const others = calls.filter((c) => !c.startsWith('Function("return this")()'));
    expect(lookups).toHaveLength(4);
    expect(count(js, '||Function("return this")()')).toBe(3);
    expect(others).toHaveLength(1);
    expect(others[0].startsWith('Function("binder","return function ("')).toBe(true);
    expect(js).toMatch(/Function\.prototype\.bind\|\|/);
  });

  it("the viewer's stylesheet loads nothing from anywhere", () => {
    const css = viewer.VIEWER_CSS;
    const urls = [...css.matchAll(/url\(\s*["']?([^"')]{0,12})/gi)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u.startsWith("data:image/"), u).toBe(true);
    expect(css).not.toMatch(/@import/i);
    expect(css).not.toMatch(/@font-face/i);
    expect(css).not.toMatch(/image-set\(|src\s*:/i);
  });

  it("the notices travel with the viewer", () => {
    const lf = (b: Buffer) => b.toString("utf8").replace(/\r\n/g, "\n").trimEnd();
    expect([...VIEWER_NOTICE_FILES]).toEqual(["NOTICE", "LICENSE", "swagger-ui-bundle.js.LICENSE.txt"]);
    const repoNotices = read("THIRD-PARTY-NOTICES.md").toString("utf8").replace(/\r\n/g, "\n");
    for (const name of VIEWER_NOTICE_FILES) {
      const text = lf(inPackage(name));
      expect(text.length, name).toBeGreaterThan(40);
      expect(viewer.VIEWER_LICENCES.includes(text), `VIEWER_LICENCES lacks ${name}`).toBe(true);
      expect(repoNotices.includes(text), `THIRD-PARTY-NOTICES.md lacks ${name}; copy it from node_modules/${VIEWER_PACKAGE}`).toBe(true);
    }
    expect(viewer.VIEWER_LICENCES).toContain(`${VIEWER_PACKAGE} ${viewer.VIEWER_VERSION}`);
    expect(viewer.VIEWER_LICENCES).toContain("Apache License");
    expect(repoNotices).toContain(VIEWER_PACKAGE);
    expect(repoNotices).toContain(viewer.VIEWER_VERSION);
    expect(repoNotices).toContain("Apache License 2.0");
    expect(repoNotices).toContain("/docs/licences.txt");
  });

  it("the YAML and the JSON say the same", () => {
    const doc = openapi();
    expect(JSON.parse(site.OPENAPI_JSON)).toEqual(doc);
    expect(parse(site.OPENAPI_YAML)).toEqual(doc);
    expect(JSON.stringify(parse(site.OPENAPI_YAML))).toBe(JSON.stringify(doc));
    expect(descriptionFiles()).toEqual({ json: site.OPENAPI_JSON, yaml: site.OPENAPI_YAML });
    expect(site.OPENAPI_YAML.startsWith("openapi: 3.1.0\n")).toBe(true);
    expect(site.OPENAPI_JSON.endsWith("}\n")).toBe(true);
    for (const text of [site.OPENAPI_JSON, site.OPENAPI_YAML]) expect(text).not.toContain("\r");
  });

  it("the Worker stays far under the script size limit", async () => {
    const out = await build({
      absWorkingDir: ROOT,
      entryPoints: ["src/cloudflare/entry.ts"],
      bundle: true,
      minify: true,
      format: "esm",
      target: "es2022",
      platform: "browser",
      conditions: ["workerd", "worker"],
      external: ["cloudflare:*", "node:*"],
      write: false,
      logLevel: "silent",
    });
    const bytes = out.outputFiles[0].contents;
    const gzipped = gzipSync(bytes, { level: 9 }).length;
    console.log(`Worker bundle: ${bytes.length} bytes, ${gzipped} gzipped`);
    expect(gzipped).toBeGreaterThan(10_000);
    expect(gzipped).toBeLessThan(1_000_000);
  }, 60_000);

  it("the standalone preset and the source maps are not shipped", () => {
    const names = Object.keys(viewer).sort();
    expect(names).toEqual(["VIEWER_CSS", "VIEWER_CSS_ETAG", "VIEWER_CSS_PATH", "VIEWER_JS", "VIEWER_JS_ETAG", "VIEWER_JS_PATH", "VIEWER_LICENCES", "VIEWER_VERSION"]);
    expect(Object.keys(site).sort()).toEqual(["DOCS_CSS", "DOCS_CSS_ETAG", "DOCS_CSS_PATH", "DOCS_JS", "DOCS_JS_ETAG", "DOCS_JS_PATH", "OPENAPI_JSON", "OPENAPI_JSON_ETAG", "OPENAPI_YAML", "OPENAPI_YAML_ETAG"]);
    const module = readFileSync(VIEWER_MODULE, "utf8");
    // The preset's layout is in no shipped text, and no source map is: a map is JSON with a "mappings" key.
    const preset = inPackage("swagger-ui-standalone-preset.js").toString("utf8");
    expect(preset).toContain("StandaloneLayout");
    expect(module).not.toContain("StandaloneLayout");
    expect(inPackage("swagger-ui-bundle.js.map").toString("utf8")).toContain('"mappings"');
    for (const text of [module, readFileSync(SITE_MODULE, "utf8")]) {
      expect(text).not.toContain('\\"mappings\\"');
      expect(text).not.toContain("sourceMappingURL=data:");
    }
    expect(viewer.VIEWER_JS).not.toContain("sourceMappingURL");
    // Nothing of the package is copied into the repository as a file.
    const files = readdirSync(join(ROOT, "src", "docs"), { recursive: true }).map(String);
    for (const f of files) expect(f, f).not.toMatch(/\.map$|swagger|standalone/i);
  });

  it("packaging refuses a stale generated module, and names the command that fixes it", async () => {
    const root = mkdtempSync(join(tmpdir(), "dp-docs-stale-"));
    try {
      const put = (path: string, text: string | Buffer) => {
        mkdirSync(join(root, path, ".."), { recursive: true });
        writeFileSync(join(root, path), text);
      };
      put("package.json", JSON.stringify({ version: "0.0.1" }));
      put("src/player/assets.ts", read("src/player/assets.ts"));
      put("src/docs/viewer-assets.ts", "// stale\n");
      put("src/docs/site-assets.ts", read("src/docs/site-assets.ts"));
      await expect(packageCpanel({ root, log: () => {} })).rejects.toThrow("src/docs/viewer-assets.ts is out of date; run npm run build:docs, commit the result and package again");
      put("src/docs/viewer-assets.ts", read("src/docs/viewer-assets.ts"));
      put("src/docs/site-assets.ts", "// stale\n");
      await expect(packageCpanel({ root, log: () => {} })).rejects.toThrow("src/docs/site-assets.ts is out of date; run npm run build:docs, commit the result and package again");
      expect(existsSync(join(root, "dist"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
