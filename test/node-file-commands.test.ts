// The admin command's r2-check and files-copy (0.1.71, src/node/admin.ts and
// src/node/file-tools.ts), run in this process against the data folder of a scratch site and
// the stand-in for R2 (test/node-r2-standin.ts). Fixed lines and counts only, never a value;
// the private files only ever go to the private bucket and the public ones to the public
// bucket, in both directions. Node only; nothing leaves 127.0.0.1.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAdmin } from "../src/node/admin.ts";
import { NodeFileStore } from "../src/node/files.ts";
import { checkKey } from "../src/ports.ts";
import { startStandIn, type StandIn } from "./node-r2-standin.ts";

let st: StandIn;
let n = 0;
beforeAll(async () => {
  st = await startStandIn();
});
afterAll(async () => {
  await st.close();
});

/** A scratch site: a data folder with its two folders, two empty buckets, and the settings naming them. */
function site(over: Record<string, string> = {}) {
  n += 1;
  const dataDir = mkdtempSync(join(tmpdir(), "dp-file-commands-"));
  const privateBucket = `cmd-private-${n}`;
  const publicBucket = `cmd-public-${n}`;
  st.createBucket(privateBucket);
  st.createBucket(publicBucket);
  const env: Record<string, string> = {
    DATA_DIR: dataDir,
    R2_ACCOUNT_ID: st.accountId,
    R2_ACCESS_KEY_ID: st.accessKeyId,
    R2_SECRET_ACCESS_KEY: st.secret,
    R2_PRIVATE_BUCKET: privateBucket,
    R2_PUBLIC_BUCKET: publicBucket,
    ...over,
  };
  return {
    env,
    drafts: new NodeFileStore(join(dataDir, "drafts")),
    pub: new NodeFileStore(join(dataDir, "public")),
    priv: () => st.buckets.get(privateBucket)!,
    publ: () => st.buckets.get(publicBucket)!,
    privateBucket,
    publicBucket,
  };
}

async function run(env: Record<string, string>, argv: string[]): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runAdmin(argv, env, (l) => lines.push(l), { r2: { endpoint: st.url, retryPausesMs: [], timeoutMs: 3000 } });
  // No line of any run ever holds the secret or a bucket's name.
  for (const l of lines) {
    expect(l).not.toContain(env.R2_SECRET_ACCESS_KEY ?? "\u0000");
    expect(l).not.toContain(env.R2_ACCESS_KEY_ID ?? "\u0000");
    expect(l).not.toContain(env.R2_PRIVATE_BUCKET ?? "\u0000");
    expect(l).not.toContain(env.R2_PUBLIC_BUCKET ?? "\u0000");
  }
  return { code, lines };
}

const enc = (s: string) => new TextEncoder().encode(s);

describe("r2-check", () => {
  it("writes, reads back and deletes one probe file in each bucket, with FILE_STORE disk or r2, and without a data folder", async () => {
    for (const mode of ["disk", "r2", ""]) {
      const s = site({ FILE_STORE: mode });
      st.requests.length = 0;
      const r = await run(s.env, ["r2-check"]);
      expect(r.lines).toEqual([
        mode === "r2" ? "The files are kept on R2 now (FILE_STORE=r2). Checking the two R2 buckets with the key in the settings file." : "The files are kept on disk now. Checking the two R2 buckets with the key in the settings file.",
        "private bucket: a probe file was written, read back the same and deleted.",
        "public bucket: a probe file was written, read back the same and deleted.",
        "R2 check passed: both buckets can be written, read and deleted with this key.",
      ]);
      expect(r.code).toBe(0);
      expect(s.priv().size + s.publ().size).toBe(0);
      expect(st.requests.map((q) => `${q.method} ${q.path.split("/")[1]}`)).toEqual([
        `PUT ${s.privateBucket}`, `GET ${s.privateBucket}`, `POST ${s.privateBucket}`, `GET ${s.privateBucket}`,
        `PUT ${s.publicBucket}`, `GET ${s.publicBucket}`, `POST ${s.publicBucket}`, `GET ${s.publicBucket}`,
      ]);
      const key = decodeURIComponent(st.requests[0].path.split("/").slice(2).join("/"));
      expect(key).toMatch(/^r2-check\/probe-[0-9a-f]{32}\.txt$/);
      expect(() => checkKey(key)).not.toThrow();
    }
    const s = site();
    const { DATA_DIR: _d, ...noData } = s.env;
    expect((await run(noData, ["r2-check"])).code).toBe(0);
  });

  it("says so, and exits 1, when the R2 settings are not written; nothing is sent", async () => {
    st.requests.length = 0;
    const r = await run({ DATA_DIR: tmpdir() }, ["r2-check"]);
    expect(r).toEqual({ code: 1, lines: ["R2 is not set up: write the five R2 settings in the settings file first. Nothing was checked."] });
    expect(st.requests).toEqual([]);
  });

  it("a wrong secret: each bucket fails with the reason, the verdict is a failure, exit 1", async () => {
    const s = site({ R2_SECRET_ACCESS_KEY: "c".repeat(64) });
    const r = await run(s.env, ["r2-check"]);
    expect(r.code).toBe(1);
    expect(r.lines.slice(1)).toEqual([
      "private bucket: failed to write: R2 refused the access key or its signature.",
      "public bucket: failed to write: R2 refused the access key or its signature.",
      "R2 check failed: put the settings or the token right before setting FILE_STORE=r2.",
    ]);
  });

  it("a bucket that does not exist fails alone", async () => {
    const s = site({ R2_PUBLIC_BUCKET: "no-such-public-bucket" });
    const r = await run(s.env, ["r2-check"]);
    expect(r.code).toBe(1);
    expect(r.lines.slice(1)).toEqual([
      "private bucket: a probe file was written, read back the same and deleted.",
      "public bucket: failed to write: R2 has no such bucket.",
      "R2 check failed: put the settings or the token right before setting FILE_STORE=r2.",
    ]);
  });

  it("a probe that comes back cut short fails at reading it back, and is still removed", async () => {
    const s = site();
    st.fault = (q) => (q.method === "GET" && q.path.startsWith(`/${s.privateBucket}/r2-check/`) ? { kind: "truncate", send: 3 } : null);
    try {
      const r = await run(s.env, ["r2-check"]);
      expect(r.code).toBe(1);
      expect(r.lines[1]).toBe("private bucket: failed to read back: R2's answer ended before the whole file.");
      expect(s.priv().size).toBe(0);
    } finally {
      st.fault = null;
    }
  });

  it("takes no option", async () => {
    expect((await run(site().env, ["r2-check", "--dry-run"])).code).toBe(2);
  });
});

describe("files-copy", () => {
  /** A data folder with drafts of every private kind and public pictures, with their metadata. */
  async function filled() {
    const s = site();
    await s.drafts.put("u/up1/step-001.png", enc("draft one"), { contentType: "image/png" });
    await s.drafts.put("v/0123456789abcdef0123456789abcdef.jpg", enc("restricted live"), { contentType: "image/jpeg", cacheControl: "private, no-store" });
    await s.drafts.put("m/med1/part-000.claim", enc("shared clip part"), { contentType: "video/mp4" });
    await s.pub.put("p/fedcba9876543210fedcba9876543210.png", enc("public picture"), { contentType: "image/png", cacheControl: "public, max-age=31536000, immutable" });
    return s;
  }

  const lines = (verb: "copy" | "dry", priv: [number, number, number, number], pub: [number, number, number, number]) => {
    const one = (name: string, c: number[]) => (verb === "dry" ? `${name} files: ${c[0]} to copy, ${c[1]} already there, ${c[2]} to remove, ${c[3]} failed.` : `${name} files: ${c[0]} copied, ${c[1]} already there, ${c[2]} removed, ${c[3]} failed.`);
    return [one("private", priv), one("public", pub)];
  };

  it("refuses without --app-is-stopped, and changes nothing", async () => {
    const s = await filled();
    st.requests.length = 0;
    const r = await run(s.env, ["files-copy", "--from", "disk", "--to", "r2"]);
    expect(r).toEqual({
      code: 1,
      lines: ["files-copy runs only while the app is stopped or idle: a copy while files are being written can leave a deleted file, or a picture of a tour just made restricted, behind at the destination. Stop the app, then run it again with --app-is-stopped. Nothing was copied."],
    });
    expect(st.requests).toEqual([]);
  });

  it("takes exactly --from and --to, disk and r2 one each way, with --dry-run and --app-is-stopped", async () => {
    const env = site().env;
    for (const argv of [
      ["files-copy"],
      ["files-copy", "--from", "disk"],
      ["files-copy", "--from", "disk", "--to", "disk", "--app-is-stopped"],
      ["files-copy", "--from", "r2", "--to", "r2", "--app-is-stopped"],
      ["files-copy", "--from", "s3", "--to", "r2", "--app-is-stopped"],
      ["files-copy", "--from", "disk", "--to", "r2", "--app-is-stopped", "--app-is-stopped"],
      ["files-copy", "--from", "disk", "--to", "r2", "--now"],
      ["files-copy", "--from", "disk", "--from", "r2", "--to", "r2"],
    ]) {
      expect((await run(env, argv)).code, argv.join(" ")).toBe(2);
    }
  });

  it("disk to R2: every file with its type and cache control, the private ones to the private bucket only and the public ones to the public bucket only", async () => {
    const s = await filled();
    st.requests.length = 0;
    const r = await run(s.env, ["files-copy", "--from", "disk", "--to", "r2", "--app-is-stopped"]);
    expect(r.lines).toEqual([
      "Copying the files from the data folder to R2: the private files to the private bucket, the public files to the public bucket.",
      ...lines("copy", [3, 0, 0, 0], [1, 0, 0, 0]),
      "Done: every file at the destination is the source's, checked by size and SHA-256.",
    ]);
    expect(r.code).toBe(0);
    expect([...s.priv().keys()].sort()).toEqual(await s.drafts.keys());
    expect([...s.publ().keys()].sort()).toEqual(await s.pub.keys());
    expect(s.priv().get("v/0123456789abcdef0123456789abcdef.jpg")).toMatchObject({ contentType: "image/jpeg", cacheControl: "private, no-store" });
    expect(s.priv().get("u/up1/step-001.png")).toMatchObject({ contentType: "image/png", cacheControl: null });
    expect(s.publ().get("p/fedcba9876543210fedcba9876543210.png")).toMatchObject({ contentType: "image/png", cacheControl: "public, max-age=31536000, immutable" });
    expect(s.publ().get("p/fedcba9876543210fedcba9876543210.png")!.body.toString()).toBe("public picture");
    // Isolation, request by request: nothing private was ever written to the public bucket, nor the other way round.
    for (const q of st.requests.filter((x) => x.method === "PUT")) {
      const [bucket, ...rest] = q.path.slice(1).split("/");
      const key = rest.join("/");
      if (bucket === s.publicBucket) expect(key.startsWith("p/"), key).toBe(true);
      else expect(bucket === s.privateBucket && !key.startsWith("p/"), key).toBe(true);
    }
  });

  it("run again, it changes nothing: every file is already there, and nothing is written", async () => {
    const s = await filled();
    await run(s.env, ["files-copy", "--from", "disk", "--to", "r2", "--app-is-stopped"]);
    st.requests.length = 0;
    const r = await run(s.env, ["files-copy", "--from", "disk", "--to", "r2", "--app-is-stopped"]);
    expect(r.lines.slice(1, 3)).toEqual(lines("copy", [0, 3, 0, 0], [0, 1, 0, 0]));
    expect(r.code).toBe(0);
    expect(st.requests.filter((q) => q.method !== "GET")).toEqual([]);
  });

  it("mirrors: a file the source does not hold is removed from the destination, and a changed one copied again", async () => {
    const s = await filled();
    await run(s.env, ["files-copy", "--from", "disk", "--to", "r2", "--app-is-stopped"]);
    await s.drafts.delete(["u/up1/step-001.png"]);
    await s.pub.put("p/fedcba9876543210fedcba9876543210.png", enc("public picture"), { contentType: "image/png" });
    const r = await run(s.env, ["files-copy", "--from", "disk", "--to", "r2", "--app-is-stopped"]);
    expect(r.lines.slice(1, 3)).toEqual(lines("copy", [0, 2, 1, 0], [1, 0, 0, 0]));
    expect(s.priv().has("u/up1/step-001.png")).toBe(false);
    expect(s.publ().get("p/fedcba9876543210fedcba9876543210.png")!.cacheControl).toBeNull();
  });

  it("a dry run counts what it would do and changes nothing, without the flag too", async () => {
    const s = await filled();
    s.publ().set("p/old.png", { body: Buffer.from("x"), contentType: "image/png", cacheControl: null, etag: '"x"' });
    st.requests.length = 0;
    const r = await run(s.env, ["files-copy", "--from", "disk", "--to", "r2", "--dry-run"]);
    expect(r.lines).toEqual([
      "Dry run: nothing is written or removed. Copying the files from the data folder to R2: the private files to the private bucket, the public files to the public bucket.",
      ...lines("dry", [3, 0, 0, 0], [1, 0, 1, 0]),
      "Dry run: nothing was changed.",
    ]);
    expect(r.code).toBe(0);
    expect(st.requests.filter((q) => q.method !== "GET")).toEqual([]);
    expect(s.priv().size).toBe(0);
    expect([...s.publ().keys()]).toEqual(["p/old.png"]);
  });

  it("R2 to disk: the way back, into the data folder's two folders, each from its own bucket", async () => {
    const s = await filled();
    await run(s.env, ["files-copy", "--from", "disk", "--to", "r2", "--app-is-stopped"]);
    // The disk copies are gone or stale; R2 holds the truth, with one more private file than the folder.
    const fresh = site({ R2_PRIVATE_BUCKET: s.privateBucket, R2_PUBLIC_BUCKET: s.publicBucket });
    await fresh.drafts.put("u/stale/step-001.png", enc("not on R2"), { contentType: "image/png" });
    s.priv().set("m/med2/preview.claim.png", { body: Buffer.from("new on R2"), contentType: "image/png", cacheControl: "private, max-age=60", etag: '"n"' });
    const r = await run(fresh.env, ["files-copy", "--from", "r2", "--to", "disk", "--app-is-stopped"]);
    expect(r.lines).toEqual([
      "Copying the files from R2 to the data folder: the private bucket to the private files, the public bucket to the public files.",
      ...lines("copy", [4, 0, 1, 0], [1, 0, 0, 0]),
      "Done: every file at the destination is the source's, checked by size and SHA-256.",
    ]);
    expect(await fresh.drafts.keys()).toEqual([...s.priv().keys()].sort());
    expect(await fresh.pub.keys()).toEqual(["p/fedcba9876543210fedcba9876543210.png"]);
    const back = await fresh.drafts.get("m/med2/preview.claim.png");
    expect(back).toMatchObject({ contentType: "image/png", cacheControl: "private, max-age=60", size: 9 });
    expect((await fresh.pub.get("p/fedcba9876543210fedcba9876543210.png"))!.cacheControl).toBe("public, max-age=31536000, immutable");
    // Nothing of a bucket went into the other folder.
    expect((await fresh.pub.keys()).every((k) => k.startsWith("p/"))).toBe(true);
    expect((await fresh.drafts.keys()).some((k) => k.startsWith("p/"))).toBe(false);
  });

  it("a copy that does not read back the same counts as failed, the run goes on, exit 1; the next run puts it right", async () => {
    const s = await filled();
    st.fault = (q) => (q.method === "GET" && q.path === `/${s.privateBucket}/u/up1/step-001.png` ? { kind: "truncate", send: 2 } : null);
    try {
      const r = await run(s.env, ["files-copy", "--from", "disk", "--to", "r2", "--app-is-stopped"]);
      expect(r.lines.slice(1)).toEqual([
        ...lines("copy", [2, 0, 0, 1], [1, 0, 0, 0]),
        "Not done: 1 file failed. Run the command again, and do not change FILE_STORE until it ends with 0 failed.",
      ]);
      expect(r.code).toBe(1);
    } finally {
      st.fault = null;
    }
    const again = await run(s.env, ["files-copy", "--from", "disk", "--to", "r2", "--app-is-stopped"]);
    expect(again.code).toBe(0);
    expect(again.lines.at(-1)).toBe("Done: every file at the destination is the source's, checked by size and SHA-256.");
  });

  it("a bucket that cannot be listed: that pair is not touched, the run fails", async () => {
    const s = await filled();
    const r = await run({ ...s.env, R2_PUBLIC_BUCKET: "no-such-public-bucket" }, ["files-copy", "--from", "disk", "--to", "r2", "--app-is-stopped"]);
    expect(r.lines.slice(1)).toEqual([
      "private files: 3 copied, 0 already there, 0 removed, 0 failed.",
      "public files: not copied, the files could not be listed: R2 has no such bucket.",
      "Not done: the public files could not be listed. Put that right and run the command again; do not change FILE_STORE until it ends with 0 failed.",
    ]);
    expect(r.code).toBe(1);
  });

  it("says so, and exits 1, when the R2 settings are not written", async () => {
    const r = await run({ DATA_DIR: tmpdir() }, ["files-copy", "--from", "disk", "--to", "r2", "--app-is-stopped"]);
    expect(r).toEqual({ code: 1, lines: ["R2 is not set up: write the five R2 settings in the settings file first. Nothing was copied."] });
  });

  it("is named, with its warning, in the command's help", async () => {
    const help = await run({}, ["--help"]);
    const text = help.lines.join("\n");
    expect(text).toContain("  r2-check");
    expect(text).toContain("  files-copy --from disk --to r2 --app-is-stopped [--dry-run]");
    expect(text).toContain("  files-copy --from r2 --to disk --app-is-stopped [--dry-run]");
    expect(text).toContain("Run it only with the app stopped or idle");
  });
});
