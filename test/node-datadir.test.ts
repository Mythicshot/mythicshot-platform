import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareDataDir } from "../src/node/datadir.ts";

describe("data folder check", () => {
  it("creates a missing folder and returns its absolute path", async () => {
    const root = await mkdtemp(join(tmpdir(), "dp-datadir-"));
    expect(prepareDataDir(join(root, "data"))).toBe(join(root, "data"));
  });

  it("a folder that cannot be made gives one line naming the folder and the uid", async () => {
    const root = await mkdtemp(join(tmpdir(), "dp-datadir-"));
    const blocker = join(root, "file");
    await writeFile(blocker, "not a folder");
    const target = join(blocker, "data");
    let message = "";
    try {
      prepareDataDir(target);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(target);
    expect(message).toMatch(/writable by uid \d+$/);
    expect(message).not.toContain("\n");
  });
});
