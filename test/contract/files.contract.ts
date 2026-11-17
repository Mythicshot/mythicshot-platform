import { describe, expect, it } from "vitest";
import type { FileStore } from "../../src/ports.ts";

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
  });
}
