import { describe, expect, it } from "vitest";
import { type FileStore, MAX_KEY_BYTES } from "../../src/ports.ts";

type Made = { store: FileStore; keys(): Promise<string[]> };

async function text(body: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(body).text();
}

const BAD_KEYS = ["../db.sqlite", "a/../../x", "/etc/passwd", "a\\b", "a//b", "", "A.png", "a/.hidden/..", "a/b/"];

export function fileStoreContract(make: () => Promise<Made>): void {
  describe("FileStore contract", () => {
    it("put then get returns the bytes, size, content type and cache control", async () => {
      const { store } = await make();
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 10]);
      await store.put("u1/step-001.png", bytes, { contentType: "image/png", cacheControl: "public, max-age=60" });
      const got = await store.get("u1/step-001.png");
      expect(got).not.toBeNull();
      expect(got!.size).toBe(7);
      expect(got!.contentType).toBe("image/png");
      expect(got!.cacheControl).toBe("public, max-age=60");
      expect(new Uint8Array(await new Response(got!.body).arrayBuffer())).toEqual(bytes);

      await store.put("plain.txt", new TextEncoder().encode("hi"), { contentType: "text/plain" });
      const plain = await store.get("plain.txt");
      expect(plain!.cacheControl).toBeNull();
      expect(await text(plain!.body)).toBe("hi");
    });

    it("get of a missing key is null", async () => {
      const { store } = await make();
      expect(await store.get("nothing/here.png")).toBeNull();
    });

    it("put replaces an existing key", async () => {
      const { store, keys } = await make();
      await store.put("a.png", new TextEncoder().encode("first"), { contentType: "image/png", cacheControl: "no-store" });
      await store.put("a.png", new TextEncoder().encode("second!"), { contentType: "image/jpeg" });
      const got = await store.get("a.png");
      expect(got!.size).toBe(7);
      expect(got!.contentType).toBe("image/jpeg");
      expect(got!.cacheControl).toBeNull();
      expect(await text(got!.body)).toBe("second!");
      expect(await keys()).toEqual(["a.png"]);
    });

    it("delete removes exactly the named keys and ignores missing ones", async () => {
      const { store, keys } = await make();
      const meta = { contentType: "image/png" };
      for (const k of ["a.png", "b.png", "dir/c.png", "dir/d.png"]) await store.put(k, new Uint8Array([1]), meta);
      await store.delete(["a.png", "dir/c.png", "never/was.png"]);
      expect((await keys()).sort()).toEqual(["b.png", "dir/d.png"]);
      await store.delete([]);
      expect((await keys()).sort()).toEqual(["b.png", "dir/d.png"]);
      expect(await store.get("a.png")).toBeNull();
    });

    it.each(BAD_KEYS)("refuses the key %j on put, get and delete", async (key) => {
      const { store, keys } = await make();
      await store.put("keep.png", new Uint8Array([1]), { contentType: "image/png" });
      const before = await keys();
      await expect(store.put(key, new Uint8Array([2]), { contentType: "image/png" })).rejects.toThrow("bad key");
      await expect(store.get(key)).rejects.toThrow("bad key");
      await expect(store.delete([key])).rejects.toThrow("bad key");
      // A bad key anywhere in the list refuses the whole call before anything is deleted.
      await expect(store.delete(["keep.png", key])).rejects.toThrow("bad key");
      expect(await keys()).toEqual(before);
    });

    it("a key can be both an object and a prefix of other keys, in either order", async () => {
      const { store, keys } = await make();
      const m = { contentType: "text/plain" };
      await store.put("a/b", enc("ab"), m);
      await store.put("a", enc("a"), m);
      await store.delete(["a/b"]);
      await store.put("a", enc("a2"), m);
      await store.put("c", enc("c"), m);
      await store.put("c/d", enc("cd"), m);
      await store.put("c/d/e", enc("cde"), m);
      expect(await text((await store.get("a"))!.body)).toBe("a2");
      expect(await store.get("a/b")).toBeNull();
      expect(await text((await store.get("c"))!.body)).toBe("c");
      expect(await text((await store.get("c/d"))!.body)).toBe("cd");
      expect(await text((await store.get("c/d/e"))!.body)).toBe("cde");
      expect((await keys()).sort()).toEqual(["a", "c", "c/d", "c/d/e"]);
    });

    it("accepts keys that look like internal file names as ordinary keys", async () => {
      const { store, keys } = await make();
      const m = { contentType: "text/plain" };
      await store.put("a.png", enc("img"), m);
      await store.put("a.png.meta.json", enc("not meta"), m);
      await store.put("a.png.tmp", enc("not tmp"), m);
      expect(await text((await store.get("a.png"))!.body)).toBe("img");
      expect(await text((await store.get("a.png.meta.json"))!.body)).toBe("not meta");
      expect((await store.get("a.png"))!.contentType).toBe("text/plain");
      await store.delete(["a.png.meta.json"]);
      expect(await text((await store.get("a.png"))!.body)).toBe("img");
      expect((await keys()).sort()).toEqual(["a.png", "a.png.tmp"]);
    });

    it(`accepts a key of exactly ${MAX_KEY_BYTES} bytes and refuses one byte more`, async () => {
      const { store, keys } = await make();
      const atLimit = `${"a".repeat(MAX_KEY_BYTES - 6)}/b.png`;
      const over = `a${atLimit}`;
      expect(atLimit.length).toBe(MAX_KEY_BYTES);
      await store.put(atLimit, enc("x"), { contentType: "image/png" });
      expect(await text((await store.get(atLimit))!.body)).toBe("x");
      await expect(store.put(over, enc("y"), { contentType: "image/png" })).rejects.toThrow("bad key");
      await expect(store.get(over)).rejects.toThrow("bad key");
      await expect(store.delete([over])).rejects.toThrow("bad key");
      expect(await keys()).toEqual([atLimit]);
      await store.delete([atLimit]);
      expect(await keys()).toEqual([]);
    });

    it("overlapping puts to one key end with a matching content type and body", async () => {
      const { store } = await make();
      for (let round = 0; round < 5; round++) {
        await Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            store.put("race.bin", enc(`body-${i}-${"x".repeat(i * 5000)}`), { contentType: `application/x-${i}`, cacheControl: `c${i}` }),
          ),
        );
        const got = (await store.get("race.bin"))!;
        const body = await text(got.body);
        const i = Number(body.split("-")[1]);
        expect(got.contentType).toBe(`application/x-${i}`);
        expect(got.cacheControl).toBe(`c${i}`);
        expect(got.size).toBe(body.length);
      }
    });
  });
}

const enc = (s: string) => new TextEncoder().encode(s);
