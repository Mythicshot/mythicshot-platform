// The admin command's r2-check and files-copy (0.1.71, src/node/admin.ts and
// src/node/file-tools.ts), run in this process against the data folder of a scratch site and
// the stand-in for R2 (test/node-r2-standin.ts). Fixed lines and counts only, never a value;
// the private files only ever go to the private bucket and the public ones to the public
// bucket, in both directions; both buckets carry a role marker, so swapped names are found;
// nothing is removed at the destination unless --remove-extra says so; and nothing is ever
// written to the side FILE_STORE serves from. Node only; nothing leaves 127.0.0.1.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

const MARKER = "r2-check/role.txt";

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
    dataDir,
    drafts: new NodeFileStore(join(dataDir, "drafts")),
    pub: new NodeFileStore(join(dataDir, "public")),
    priv: () => st.buckets.get(env.R2_PRIVATE_BUCKET)!,
    publ: () => st.buckets.get(env.R2_PUBLIC_BUCKET)!,
    /** The bucket's keys without r2-check's marker. */
    privKeys: () => [...st.buckets.get(env.R2_PRIVATE_BUCKET)!.keys()].filter((k) => k !== MARKER).sort(),
    publKeys: () => [...st.buckets.get(env.R2_PUBLIC_BUCKET)!.keys()].filter((k) => k !== MARKER).sort(),
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
const COPY = ["files-copy", "--from", "disk", "--to", "r2", "--app-is-stopped"];
const BACK = ["files-copy", "--from", "r2", "--to", "disk", "--app-is-stopped"];
const PASSED = "R2 check passed: both buckets are marked with their roles and can be written, read and deleted with this key.";
const FAILED = "R2 check failed: put the settings or the token right before setting FILE_STORE=r2.";
const DONE = "Done: every file of the source is at the destination, checked by size and SHA-256.";

type Extra = "left in place" | "removed" | "to be left in place" | "to be removed";
/** The counts line of one pair: copied, already there, failed, never copyable, extra. */
const counts = (name: string, c: [number, number, number, number, number], extra: Extra = "left in place") =>
  `${name} files: ${c[0]} ${extra.startsWith("to be") ? "to copy" : "copied"}, ${c[1]} already there, ${c[2]} failed, ${c[3]} that can never be copied; extra at the destination: ${c[4]}, ${extra}.`;

describe("r2-check", () => {
  it("marks each bucket with its role the first time, checks the marks after, and probes both, with FILE_STORE disk or r2, and without a data folder", async () => {
    for (const mode of ["disk", "r2", ""]) {
      const s = site({ FILE_STORE: mode });
      st.requests.length = 0;
      const first = await run(s.env, ["r2-check"]);
      expect(first.lines).toEqual([
        mode === "r2" ? "The files are kept on R2 now (FILE_STORE=r2). Checking the two R2 buckets with the key in the settings file." : "The files are kept on disk now. Checking the two R2 buckets with the key in the settings file.",
        "private bucket: marked as the private bucket (r2-check/role.txt).",
        "private bucket: a probe file was written, read back the same and deleted.",
        "public bucket: marked as the public bucket (r2-check/role.txt).",
        "public bucket: a probe file was written, read back the same and deleted.",
        PASSED,
      ]);
      expect(first.code).toBe(0);
      expect([...s.priv().keys()]).toEqual([MARKER]);
      expect(s.priv().get(MARKER)!.body.toString()).toBe("demo-platform bucket role: private\n");
      expect(s.publ().get(MARKER)!.body.toString()).toBe("demo-platform bucket role: public\n");
      const probe = st.requests.find((q) => q.method === "PUT" && q.path.includes("/r2-check/probe-"))!;
      const key = decodeURIComponent(probe.path.split("/").slice(2).join("/"));
      expect(key).toMatch(/^r2-check\/probe-[0-9a-f]{32}\.txt$/);
      expect(() => checkKey(key)).not.toThrow();
      const again = await run(s.env, ["r2-check"]);
      expect(again.lines.slice(1)).toEqual([
        "private bucket: its marker says private, as it should.",
        "private bucket: a probe file was written, read back the same and deleted.",
        "public bucket: its marker says public, as it should.",
        "public bucket: a probe file was written, read back the same and deleted.",
        PASSED,
      ]);
    }
    const s = site();
    const { DATA_DIR: _d, ...noData } = s.env;
    expect((await run(noData, ["r2-check"])).code).toBe(0);
  });

  it("swapped bucket names, after the buckets were marked: both buckets say so, nothing is written, exit 1", async () => {
    const s = site();
    await run(s.env, ["r2-check"]);
    st.requests.length = 0;
    const swapped = { ...s.env, R2_PRIVATE_BUCKET: s.publicBucket, R2_PUBLIC_BUCKET: s.privateBucket };
    const r = await run(swapped, ["r2-check"]);
    expect(r.code).toBe(1);
    expect(r.lines.slice(1)).toEqual([
      "the private bucket is marked as the public one: R2_PRIVATE_BUCKET and R2_PUBLIC_BUCKET are swapped.",
      "the public bucket is marked as the private one: R2_PRIVATE_BUCKET and R2_PUBLIC_BUCKET are swapped.",
      FAILED,
    ]);
    expect(st.requests.filter((q) => q.method !== "GET")).toEqual([]);
  });

  it("swapped names before any mark, on buckets that hold files: no marker is written to a bucket holding the other kind", async () => {
    const s = site();
    s.priv().set("u/a/step-001.png", { body: Buffer.from("d"), contentType: "image/png", cacheControl: null, etag: '"d"' });
    s.publ().set("p/0123456789abcdef0123456789abcdef.png", { body: Buffer.from("p"), contentType: "image/png", cacheControl: null, etag: '"p"' });
    const swapped = { ...s.env, R2_PRIVATE_BUCKET: s.publicBucket, R2_PUBLIC_BUCKET: s.privateBucket };
    const r = await run(swapped, ["r2-check"]);
    expect(r.code).toBe(1);
    expect(r.lines.slice(1)).toEqual([
      "private bucket: it holds public pictures (p/), so it may be the public bucket: check that R2_PRIVATE_BUCKET and R2_PUBLIC_BUCKET are not swapped. No marker was written.",
      "public bucket: it holds files that are not public pictures, so it may be the private bucket: check that R2_PRIVATE_BUCKET and R2_PUBLIC_BUCKET are not swapped. No marker was written.",
      FAILED,
    ]);
    expect(s.priv().has(MARKER) || s.publ().has(MARKER)).toBe(false);
  });

  it("a marker r2-check never writes is left alone and fails the check", async () => {
    const s = site();
    s.priv().set(MARKER, { body: Buffer.from("something else"), contentType: "text/plain", cacheControl: null, etag: '"m"' });
    const r = await run(s.env, ["r2-check"]);
    expect(r.code).toBe(1);
    expect(r.lines[1]).toBe("private bucket: its marker r2-check/role.txt holds something r2-check never writes. Nothing was changed; look at that bucket before going on.");
    expect(s.priv().get(MARKER)!.body.toString()).toBe("something else");
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
      "private bucket: its marker could not be read: R2 refused the access key or its signature.",
      "public bucket: its marker could not be read: R2 refused the access key or its signature.",
      FAILED,
    ]);
  });

  it("a bucket that does not exist fails alone", async () => {
    const s = site({ R2_PUBLIC_BUCKET: "no-such-public-bucket" });
    const r = await run(s.env, ["r2-check"]);
    expect(r.code).toBe(1);
    expect(r.lines.slice(3)).toEqual(["public bucket: its marker could not be read: R2 has no such bucket.", FAILED]);
  });

  it("a probe that comes back cut short fails at reading it back, and is still removed", async () => {
    const s = site();
    st.fault = (q) => (q.method === "GET" && q.path.startsWith(`/${s.privateBucket}/r2-check/probe-`) ? { kind: "truncate", send: 3 } : null);
    try {
      const r = await run(s.env, ["r2-check"]);
      expect(r.code).toBe(1);
      expect(r.lines[2]).toBe("private bucket: failed to read back: R2's answer ended before the whole file.");
      expect([...s.priv().keys()]).toEqual([MARKER]);
    } finally {
      st.fault = null;
    }
  });

  it("takes no option", async () => {
    expect((await run(site().env, ["r2-check", "--dry-run"])).code).toBe(2);
  });
});

describe("files-copy", () => {
  /** A data folder with drafts of every private kind and public pictures, with their metadata, and both buckets marked. */
  async function filled(over: Record<string, string> = {}) {
    const s = site(over);
    await s.drafts.put("u/up1/step-001.png", enc("draft one"), { contentType: "image/png" });
    await s.drafts.put("v/0123456789abcdef0123456789abcdef.jpg", enc("restricted live"), { contentType: "image/jpeg", cacheControl: "private, no-store" });
    await s.drafts.put("m/med1/part-000.claim", enc("shared clip part"), { contentType: "video/mp4" });
    await s.pub.put("p/fedcba9876543210fedcba9876543210.png", enc("public picture"), { contentType: "image/png", cacheControl: "public, max-age=31536000, immutable" });
    expect((await run(s.env, ["r2-check"])).code).toBe(0);
    return s;
  }

  it("refuses without --app-is-stopped, and changes nothing", async () => {
    const s = await filled();
    st.requests.length = 0;
    const r = await run(s.env, ["files-copy", "--from", "disk", "--to", "r2"]);
    expect(r).toEqual({
      code: 1,
      lines: ["files-copy runs only while the app is stopped: a copy while files are being written can leave a deleted file, or a picture of a tour just made restricted, behind at the destination. Stop the app, then run it again with --app-is-stopped. Nothing was copied."],
    });
    expect(st.requests).toEqual([]);
  });

  it("refuses, whatever the flags, to write to the side FILE_STORE serves from", async () => {
    const s = await filled();
    st.requests.length = 0;
    const cases: [string, string[]][] = [["r2", COPY], ["r2", [...COPY, "--dry-run", "--remove-extra"]], ["disk", BACK], ["", BACK], ["disk", ["files-copy", "--from", "r2", "--to", "disk", "--dry-run"]]];
    for (const [mode, argv] of cases) {
      const r = await run({ ...s.env, FILE_STORE: mode }, argv);
      expect(r.code, `${mode} ${argv.join(" ")}`).toBe(1);
      expect(r.lines).toEqual([
        mode === "r2"
          ? "files-copy does not write to the files the site serves from now: FILE_STORE says r2, so the two buckets. Copy to the other side first, and change FILE_STORE only after the copy. Nothing was copied."
          : "files-copy does not write to the files the site serves from now: FILE_STORE says disk, so the data folder. Copy to the other side first, and change FILE_STORE only after the copy. Nothing was copied.",
      ]);
    }
    expect(st.requests).toEqual([]);
  });

  it("refuses until r2-check has marked both buckets, and when the marks say the names are swapped, in either direction", async () => {
    const s = site();
    await s.drafts.put("u/a.png", enc("a"), { contentType: "image/png" });
    st.requests.length = 0;
    const unmarked = await run(s.env, COPY);
    expect(unmarked).toEqual({ code: 1, lines: ["files-copy needs both buckets marked first: the private bucket has no role marker. Run r2-check first. Nothing was copied."] });
    expect(st.requests.filter((q) => q.method !== "GET")).toEqual([]);
    await run(s.env, ["r2-check"]);
    const swapped = await run({ ...s.env, R2_PRIVATE_BUCKET: s.publicBucket, R2_PUBLIC_BUCKET: s.privateBucket }, COPY);
    expect(swapped).toEqual({ code: 1, lines: ["the private bucket is marked as the public one: R2_PRIVATE_BUCKET and R2_PUBLIC_BUCKET are swapped. Nothing was copied."] });
    const back = await run({ ...s.env, FILE_STORE: "r2", R2_PRIVATE_BUCKET: s.publicBucket, R2_PUBLIC_BUCKET: s.privateBucket }, BACK);
    expect(back).toEqual(swapped);
    expect(s.privKeys()).toEqual([]);
    expect(s.publKeys()).toEqual([]);
    expect(await s.drafts.keys()).toEqual(["u/a.png"]);
  });

  it("takes exactly --from and --to, disk and r2 one each way, with --dry-run, --app-is-stopped and --remove-extra", async () => {
    const env = site().env;
    for (const argv of [
      ["files-copy"],
      ["files-copy", "--from", "disk"],
      ["files-copy", "--from", "disk", "--to", "disk", "--app-is-stopped"],
      ["files-copy", "--from", "r2", "--to", "r2", "--app-is-stopped"],
      ["files-copy", "--from", "s3", "--to", "r2", "--app-is-stopped"],
      ["files-copy", "--from", "disk", "--to", "r2", "--app-is-stopped", "--app-is-stopped"],
      ["files-copy", "--from", "disk", "--to", "r2", "--remove-extra", "--remove-extra"],
      ["files-copy", "--from", "disk", "--to", "r2", "--now"],
      ["files-copy", "--from", "disk", "--from", "r2", "--to", "r2"],
    ]) {
      expect((await run(env, argv)).code, argv.join(" ")).toBe(2);
    }
  });

  it("disk to R2: every file with its type and cache control, the private ones to the private bucket only and the public ones to the public bucket only, with what each now holds by key prefix", async () => {
    const s = await filled();
    st.requests.length = 0;
    const r = await run(s.env, COPY);
    expect(r.lines).toEqual([
      "Copying the files from the data folder to R2: the private files to the private bucket, the public files to the public bucket.",
      counts("private", [3, 0, 0, 0, 0]),
      "private files at the destination, by key prefix: m/ 1, u/ 1, v/ 1.",
      counts("public", [1, 0, 0, 0, 0]),
      "public files at the destination, by key prefix: p/ 1.",
      DONE,
    ]);
    expect(r.code).toBe(0);
    expect(s.privKeys()).toEqual(await s.drafts.keys());
    expect(s.publKeys()).toEqual(await s.pub.keys());
    expect(s.priv().get("v/0123456789abcdef0123456789abcdef.jpg")).toMatchObject({ contentType: "image/jpeg", cacheControl: "private, no-store" });
    expect(s.priv().get("u/up1/step-001.png")).toMatchObject({ contentType: "image/png", cacheControl: null });
    expect(s.publ().get("p/fedcba9876543210fedcba9876543210.png")).toMatchObject({ contentType: "image/png", cacheControl: "public, max-age=31536000, immutable" });
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
    await run(s.env, COPY);
    st.requests.length = 0;
    const r = await run(s.env, COPY);
    expect([r.lines[1], r.lines[3]]).toEqual([counts("private", [0, 3, 0, 0, 0]), counts("public", [0, 1, 0, 0, 0])]);
    expect(r.code).toBe(0);
    expect(st.requests.filter((q) => q.method !== "GET")).toEqual([]);
  });

  it("by default nothing is removed: a file the source does not hold is counted and left in place; a changed one is copied again", async () => {
    const s = await filled();
    await run(s.env, COPY);
    await s.drafts.delete(["u/up1/step-001.png"]);
    await s.pub.put("p/fedcba9876543210fedcba9876543210.png", enc("public picture"), { contentType: "image/png" });
    st.requests.length = 0;
    const r = await run(s.env, COPY);
    expect([r.lines[1], r.lines[3]]).toEqual([counts("private", [0, 2, 0, 0, 1]), counts("public", [1, 0, 0, 0, 0])]);
    expect(r.code).toBe(0);
    expect(s.priv().has("u/up1/step-001.png")).toBe(true);
    expect(st.requests.filter((q) => q.method === "POST")).toEqual([]);
    expect(s.publ().get("p/fedcba9876543210fedcba9876543210.png")!.cacheControl).toBeNull();
  });

  it("after the disk copies were deleted, a copy without --remove-extra leaves the buckets whole", async () => {
    const s = await filled();
    await run(s.env, COPY);
    await s.drafts.delete(await s.drafts.keys());
    await s.pub.delete(await s.pub.keys());
    const r = await run(s.env, COPY);
    expect([r.lines[1], r.lines[3]]).toEqual([counts("private", [0, 0, 0, 0, 3]), counts("public", [0, 0, 0, 0, 1])]);
    expect(r.code).toBe(0);
    expect(s.privKeys()).toHaveLength(3);
    expect(s.publKeys()).toHaveLength(1);
  });

  it("with --remove-extra, a file the source does not hold is removed; the marker is never removed nor copied", async () => {
    const s = await filled();
    await run(s.env, COPY);
    await s.drafts.delete(["u/up1/step-001.png"]);
    const r = await run(s.env, [...COPY, "--remove-extra"]);
    expect(r.lines[1]).toBe(counts("private", [0, 2, 0, 0, 1], "removed"));
    expect(s.priv().has("u/up1/step-001.png")).toBe(false);
    expect(s.priv().has(MARKER) && s.publ().has(MARKER)).toBe(true);
    const back = await run({ ...s.env, FILE_STORE: "r2" }, [...BACK, "--remove-extra"]);
    expect(back.code).toBe(0);
    expect((await s.drafts.keys()).some((k) => k.startsWith("r2-check/"))).toBe(false);
  });

  it("with --remove-extra, refuses a source that is empty while its destination is not, and a data folder without its folders; nothing changes", async () => {
    const s = await filled();
    await run(s.env, COPY);
    await s.drafts.delete(await s.drafts.keys());
    st.requests.length = 0;
    const empty = await run(s.env, [...COPY, "--remove-extra"]);
    expect(empty).toEqual({ code: 1, lines: ["files-copy --remove-extra stops: the private files at the source are empty while the destination holds 3. Nothing was copied or removed."] });
    expect(st.requests.filter((q) => q.method !== "GET")).toEqual([]);
    // DATA_DIR pointing at a fresh folder: no drafts or public folder at all.
    const fresh = mkdtempSync(join(tmpdir(), "dp-file-commands-fresh-"));
    const wrong = await run({ ...s.env, DATA_DIR: fresh }, [...COPY, "--remove-extra"]);
    expect(wrong).toEqual({ code: 1, lines: ["files-copy --remove-extra stops: the data folder has no drafts folder, so DATA_DIR may name the wrong folder. Nothing was copied or removed."] });
    expect(s.privKeys()).toHaveLength(3);
    expect(s.publKeys()).toHaveLength(1);
  });

  it("DATA_DIR pointing at a fresh folder, without --remove-extra: says there is nothing to copy, and leaves the buckets as they are", async () => {
    const s = await filled();
    await run(s.env, COPY);
    const fresh = mkdtempSync(join(tmpdir(), "dp-file-commands-fresh-"));
    const r = await run({ ...s.env, DATA_DIR: fresh }, COPY);
    expect(r.lines.slice(1)).toEqual([
      "the data folder has no drafts folder: there is nothing to copy from it.",
      counts("private", [0, 0, 0, 0, 3]),
      "private files at the destination, by key prefix: m/ 1, u/ 1, v/ 1.",
      "the data folder has no public folder: there is nothing to copy from it.",
      counts("public", [0, 0, 0, 0, 1]),
      "public files at the destination, by key prefix: p/ 1.",
      DONE,
    ]);
    expect(s.privKeys()).toHaveLength(3);
  });

  it("a rerun after the switch is refused: FILE_STORE=r2 serves from the buckets", async () => {
    const s = await filled();
    await run(s.env, COPY);
    const r = await run({ ...s.env, FILE_STORE: "r2" }, COPY);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toContain("FILE_STORE says r2, so the two buckets");
  });

  it("a dry run counts what it would do and changes nothing, without the flag too", async () => {
    const s = await filled();
    s.publ().set("p/old.png", { body: Buffer.from("x"), contentType: "image/png", cacheControl: null, etag: '"x"' });
    st.requests.length = 0;
    const r = await run(s.env, ["files-copy", "--from", "disk", "--to", "r2", "--dry-run"]);
    expect(r.lines).toEqual([
      "Dry run: nothing is written or removed. Copying the files from the data folder to R2: the private files to the private bucket, the public files to the public bucket.",
      counts("private", [3, 0, 0, 0, 0], "to be left in place"),
      "private files at the destination, by key prefix: m/ 1, u/ 1, v/ 1.",
      counts("public", [1, 0, 0, 0, 1], "to be left in place"),
      "public files at the destination, by key prefix: p/ 2.",
      "Dry run: nothing was changed.",
    ]);
    expect(r.code).toBe(0);
    expect(st.requests.filter((q) => q.method !== "GET")).toEqual([]);
    expect(s.privKeys()).toEqual([]);
    const removing = await run(s.env, ["files-copy", "--from", "disk", "--to", "r2", "--dry-run", "--remove-extra"]);
    expect(removing.lines[3]).toBe(counts("public", [1, 0, 0, 0, 1], "to be removed"));
    expect(removing.lines[4]).toBe("public files at the destination, by key prefix: p/ 1.");
  });

  it("the prefix line shows what does not belong in the public bucket", async () => {
    const s = await filled();
    await run(s.env, COPY);
    s.publ().set("u/stray/step-001.png", { body: Buffer.from("x"), contentType: "image/png", cacheControl: null, etag: '"x"' });
    const r = await run(s.env, COPY);
    expect(r.lines[4]).toBe("public files at the destination, by key prefix: p/ 1, u/ 1.");
  });

  it("R2 to disk: the way back, while FILE_STORE is still r2, into the data folder's two folders, each from its own bucket", async () => {
    const s = await filled();
    await run(s.env, COPY);
    const fresh = site({ FILE_STORE: "r2", R2_PRIVATE_BUCKET: s.privateBucket, R2_PUBLIC_BUCKET: s.publicBucket });
    await fresh.drafts.put("u/stale/step-001.png", enc("not on R2"), { contentType: "image/png" });
    s.priv().set("m/med2/preview.claim.png", { body: Buffer.from("new on R2"), contentType: "image/png", cacheControl: "private, max-age=60", etag: '"n"' });
    const r = await run(fresh.env, BACK);
    expect(r.lines).toEqual([
      "Copying the files from R2 to the data folder: the private bucket to the private files, the public bucket to the public files.",
      counts("private", [4, 0, 0, 0, 1]),
      "private files at the destination, by key prefix: m/ 2, u/ 2, v/ 1.",
      counts("public", [1, 0, 0, 0, 0]),
      "public files at the destination, by key prefix: p/ 1.",
      DONE,
    ]);
    expect(await fresh.drafts.get("m/med2/preview.claim.png")).toMatchObject({ contentType: "image/png", cacheControl: "private, max-age=60", size: 9 });
    expect((await fresh.pub.keys()).every((k) => k.startsWith("p/"))).toBe(true);
    expect((await fresh.drafts.keys()).some((k) => k.startsWith("p/") || k.startsWith("r2-check/"))).toBe(false);
  });

  it("a copy that does not read back the same counts as failed, the run goes on, exit 1; the next run puts it right", async () => {
    const s = await filled();
    st.fault = (q) => (q.method === "GET" && q.path === `/${s.privateBucket}/u/up1/step-001.png` ? { kind: "truncate", send: 2 } : null);
    try {
      const r = await run(s.env, COPY);
      expect(r.lines.slice(1)).toEqual([
        counts("private", [2, 0, 1, 0, 0]),
        "private files at the destination, by key prefix: m/ 1, u/ 1, v/ 1.",
        counts("public", [1, 0, 0, 0, 0]),
        "public files at the destination, by key prefix: p/ 1.",
        "Not done: 1 file failed. Run the command again, and do not change FILE_STORE until it ends with 0 failed.",
      ]);
      expect(r.code).toBe(1);
    } finally {
      st.fault = null;
    }
    const again = await run(s.env, COPY);
    expect(again.code).toBe(0);
    expect(again.lines.at(-1)).toBe(DONE);
  });

  it("object files that can never be copied are counted and named by store and file; the rest is copied; exit 1", async () => {
    const s = await filled();
    const shard = join(s.dataDir, "drafts", "ab");
    mkdirSync(shard, { recursive: true });
    writeFileSync(join(shard, "ab" + "0".repeat(62)), "not an object file at all");
    // A well-formed object file whose header names a key that is not the one its name is made from.
    const moved = join(s.dataDir, "drafts", "cd");
    mkdirSync(moved, { recursive: true });
    const header = Buffer.from(JSON.stringify({ key: "u/elsewhere.png", contentType: "image/png", cacheControl: null }));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(header.byteLength);
    writeFileSync(join(moved, "cd" + "1".repeat(62)), Buffer.concat([Buffer.from("DPF1"), len, header, Buffer.from("x")]));
    // A key in the public bucket the app never writes.
    s.publ().set("p/Bad Key.png", { body: Buffer.from("x"), contentType: "image/png", cacheControl: null, etag: '"x"' });
    const r = await run(s.env, COPY);
    expect(r.code).toBe(1);
    expect(r.lines.slice(1)).toEqual([
      counts("private", [3, 0, 0, 2, 0]),
      `private files: can never be copied: drafts/ab/ab${"0".repeat(62)}.`,
      `private files: can never be copied: drafts/cd/cd${"1".repeat(62)}.`,
      "private files at the destination, by key prefix: m/ 1, u/ 1, v/ 1.",
      counts("public", [1, 0, 0, 1, 0]),
      "public files: can never be copied: key p/Bad Key.png.",
      "public files at the destination, by key prefix: p/ 1.",
      "Not done: 3 files can never be copied (named above): a damaged object file in the data folder, or a key the app never writes in a bucket. Restore each from a backup or remove it by hand, then run the command again.",
    ]);
    expect(s.privKeys()).toEqual(["m/med1/part-000.claim", "u/up1/step-001.png", "v/0123456789abcdef0123456789abcdef.jpg"]);
  });

  it("a bucket that cannot be listed: nothing is copied at all, the run fails", async () => {
    const s = await filled();
    st.fault = (q) => (q.method === "GET" && q.path === `/${s.publicBucket}` ? { kind: "status", status: 403, code: "AccessDenied" } : null);
    try {
      const r = await run(s.env, COPY);
      expect(r).toEqual({
        code: 1,
        lines: [
          "public files: not copied, the files could not be listed: R2 refused access to the bucket.",
          "Not done: the public files could not be listed. Put that right and run the command again; do not change FILE_STORE until it ends with 0 failed.",
        ],
      });
      expect(s.privKeys()).toEqual([]);
    } finally {
      st.fault = null;
    }
  });

  it("says so, and exits 1, when the R2 settings are not written", async () => {
    const r = await run({ DATA_DIR: tmpdir() }, COPY);
    expect(r).toEqual({ code: 1, lines: ["R2 is not set up: write the five R2 settings in the settings file first. Nothing was copied."] });
  });

  it("is named, with its warnings, in the command's help", async () => {
    const help = await run({}, ["--help"]);
    const text = help.lines.join("\n");
    expect(text).toContain("  r2-check");
    expect(text).toContain("  files-copy --from disk --to r2 --app-is-stopped [--dry-run] [--remove-extra]");
    expect(text).toContain("  files-copy --from r2 --to disk --app-is-stopped [--dry-run] [--remove-extra]");
    expect(text).toContain("Run it only with the app stopped");
    expect(text).toContain("R2 has no bin: a file deleted there cannot be brought back.");
  });
});

describe("the app's check of the role markers at its start (FILE_STORE=r2)", () => {
  /** The site's own pair of stores on the scratch site's buckets, as the entry makes them for its check. */
  async function check(env: Record<string, string>) {
    const { fileStoreFromEnv } = await import("../src/node/config.ts");
    const { makeFileStores } = await import("../src/node/file-stores.ts");
    const { startMarkerCheck } = await import("../src/node/file-tools.ts");
    return startMarkerCheck(makeFileStores("r2", fileStoreFromEnv({ ...env, FILE_STORE: "r2" }), "", { endpoint: st.url, timeoutMs: 500, retryPausesMs: [] }));
  }

  it("both markers right: nothing to say", async () => {
    const s = site();
    await run(s.env, ["r2-check"]);
    expect(await check(s.env)).toBeNull();
  });

  it("a missing marker, swapped names, or a marker r2-check never writes: the start stops with one line", async () => {
    const s = site();
    expect(await check(s.env)).toEqual({ stop: "files: the private bucket has no role marker. Run the admin command r2-check before setting FILE_STORE=r2." });
    await run(s.env, ["r2-check"]);
    expect(await check({ ...s.env, R2_PRIVATE_BUCKET: s.publicBucket, R2_PUBLIC_BUCKET: s.privateBucket })).toEqual({ stop: "files: the private bucket is marked as the public one: R2_PRIVATE_BUCKET and R2_PUBLIC_BUCKET are swapped." });
    s.publ().set(MARKER, { body: Buffer.from("x"), contentType: "text/plain", cacheControl: null, etag: '"x"' });
    expect(await check(s.env)).toEqual({ stop: "files: the public bucket's role marker holds something r2-check never writes. Run the admin command r2-check." });
  });

  it("R2 not answering: one line, and the start goes on", async () => {
    const s = site();
    await run(s.env, ["r2-check"]);
    for (const fault of [{ kind: "hang" as const }, { kind: "reset" as const }, { kind: "status" as const, status: 503, code: "ServiceUnavailable" }]) {
      st.fault = () => fault;
      try {
        const r = await check(s.env);
        expect(r, fault.kind).toMatchObject({ warn: expect.stringMatching(/^files: the role markers of the two R2 buckets could not be checked at the start \((?:no answer from R2|R2 did not answer in time|R2 answered with a server error)\)\. The site starts; run the admin command r2-check\.$/) });
      } finally {
        st.fault = null;
      }
    }
  });
});
