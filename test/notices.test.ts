/// <reference types="vite/client" />
// The licence (LICENSE) and the notices of the code the platform includes
// (THIRD-PARTY-NOTICES.md) go with every package of it: the cPanel archive (its own test,
// test/node-cpanel-package.test.ts, compares them byte for byte), the app folder that
// cpanel.sh installs and its backups (test/node-cpanel-script.test.ts), and the container
// image, checked here by reading the Dockerfile, the build context's ignore file and the
// container test. The image itself is built only by deploy/test-container.sh, which
// needs a Docker engine.
//
// Files are read through Vite's ?raw imports, which work under both Vitest configs.
import { describe, expect, it } from "vitest";
import dockerfile from "../Dockerfile?raw";
import dockerignore from "../.dockerignore?raw";
import containerTest from "../deploy/test-container.sh?raw";
import readme from "../README.md?raw";

const NOTICE_FILES = ["LICENSE", "THIRD-PARTY-NOTICES.md"];

/** The Dockerfile's instructions, with continued lines joined and comments left out. */
function instructions(text: string): string[] {
  return text
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
}

/** The instructions of each stage, by its name. */
function stages(text: string): { name: string; lines: string[] }[] {
  const out: { name: string; lines: string[] }[] = [];
  for (const line of instructions(text)) {
    const from = /^FROM\s+\S+(?:\s+AS\s+(\S+))?$/i.exec(line);
    if (from) out.push({ name: from[1] ?? "", lines: [] });
    else if (out.length > 0) out[out.length - 1].lines.push(line);
  }
  return out;
}

/** Whether a .dockerignore pattern leaves out a file at the top of the build context. */
function ignores(pattern: string, file: string): boolean {
  const re = pattern
    .replace(/^\/+/, "")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "(?:.*/)?")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${re}(?:/.*)?$`).test(file);
}

describe("the README", () => {
  it("says where the licence and the notices are in each package", () => {
    expect(readme).toContain(
      "Every copy that is built to be installed carries the licence and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) unchanged: the container image holds both in `/app`, beside `package.json`, and the shared cPanel archive (`npm run package:cpanel`) holds both at its top level, from where `cpanel.sh` copies them into the app folder and the archive of the app files in each backup.",
    );
  });
});

describe("the container image", () => {
  const all = stages(dockerfile);
  const runner = all[all.length - 1];

  it("the runner is the last stage, so it is the image", () => {
    expect(runner.name).toBe("runner");
    expect(all.filter((s) => s.name === "runner")).toHaveLength(1);
  });

  it("the runner copies both files from the build context into /app, beside package.json", () => {
    const workdirs = runner.lines.filter((l) => /^WORKDIR /.test(l));
    expect(workdirs).toEqual(["WORKDIR /app"]);
    const copies = runner.lines.filter((l) => /^COPY /.test(l));
    // One line copies package.json and the two files to the same place, from the build
    // context (no --from), so they are the committed files, unchanged.
    const line = copies.find((l) => l.split(/\s+/).includes("package.json"));
    expect(line).toBe("COPY package.json LICENSE THIRD-PARTY-NOTICES.md ./");
    // After WORKDIR, so ./ is /app; before USER, which changes nothing about the copy.
    const at = (l: string) => runner.lines.indexOf(l);
    expect(at(line!)).toBeGreaterThan(at("WORKDIR /app"));
    expect(at(line!)).toBeLessThan(runner.lines.findIndex((l) => /^USER /.test(l)));
    // No later step removes or replaces them.
    for (const l of runner.lines.slice(at(line!) + 1)) for (const f of NOTICE_FILES) expect(l, l).not.toContain(f);
  });

  it("the build context keeps both files: no line of .dockerignore leaves them out", () => {
    const patterns = dockerignore
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"));
    expect(patterns.length).toBeGreaterThan(5);
    // The matcher works: it leaves out what the file is there to leave out.
    expect(patterns.some((p) => !p.startsWith("!") && ignores(p, "node_modules"))).toBe(true);
    expect(patterns.some((p) => !p.startsWith("!") && ignores(p, "test/docs.test.ts"))).toBe(true);
    expect(patterns.some((p) => !p.startsWith("!") && ignores(p, "app.log"))).toBe(true);
    for (const f of NOTICE_FILES) {
      expect(patterns.filter((p) => !p.startsWith("!") && ignores(p, f)), f).toEqual([]);
    }
  });

  it("the container test checks both files in the built image against the repository's", () => {
    expect(containerTest).toContain("for f in LICENSE THIRD-PARTY-NOTICES.md; do");
    expect(containerTest).toContain(
      `check "$f is in /app beside package.json, unchanged" test "$(docker run --rm --entrypoint sh "$IMAGE" -c "sha256sum < /app/$f" | cut -c1-64)" = "$(sha256sum <"$f" | cut -c1-64)"`,
    );
    // It runs from the repository's root, where the files are, and it builds the image first.
    expect(containerTest).toContain('cd "$(dirname "$0")/.."');
    expect(containerTest.indexOf("docker build")).toBeLessThan(containerTest.indexOf("for f in LICENSE THIRD-PARTY-NOTICES.md; do"));
  });
});
