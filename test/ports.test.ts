import { describe, expect, it } from "vitest";
import { makeDeps } from "#harness";
import { createApp } from "../src/app.ts";
import { checkKey } from "../src/ports.ts";
import { dbContract } from "./contract/db.contract.ts";
import { fileStoreContract } from "./contract/files.contract.ts";

dbContract(async () => (await makeDeps()).deps.db);

describe("drafts store", () => {
  fileStoreContract(async () => {
    const h = await makeDeps();
    return { store: h.deps.drafts, keys: h.draftKeys };
  });
});

describe("public store", () => {
  fileStoreContract(async () => {
    const h = await makeDeps();
    return { store: h.deps.pub, keys: h.publicKeys };
  });
});

describe("checkKey", () => {
  it.each(["a", "a.png", "u1/step-001.png", "0/1/2", "a-b_c.d/e"])("accepts %j", (k) => {
    expect(() => checkKey(k)).not.toThrow();
  });
  it.each(["", ".", "..", "-a", "_a", "a/", "/a", "a//b", "a/../b", "A", "a b", "a\\b", "a\0b", "ä", "a\n"])(
    "refuses %j",
    (k) => {
      expect(() => checkKey(k)).toThrow("bad key");
    },
  );
  it("refuses a value that is not a string", () => {
    expect(() => checkKey(undefined as unknown as string)).toThrow("bad key");
  });
});

describe("app", () => {
  it("healthz answers ok", async () => {
    const { deps } = await makeDeps();
    const res = await createApp(deps).request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("an unknown route answers 404 as JSON", async () => {
    const { deps } = await makeDeps();
    const res = await createApp(deps).request("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("migrations have run", async () => {
    const { deps } = await makeDeps();
    expect(await deps.db.all("SELECT * FROM workspace")).toEqual([]);
  });
});

describe("harness", () => {
  it("starts empty and counts every Db and FileStore call", async () => {
    const h = await makeDeps();
    expect(h.calls()).toBe(0);
    expect(await h.draftKeys()).toEqual([]);
    expect(await h.publicKeys()).toEqual([]);
    await h.deps.db.first("SELECT 1");
    await h.deps.drafts.put("x.png", new Uint8Array([1]), { contentType: "image/png" });
    await h.deps.pub.get("x.png");
    expect(h.calls()).toBe(3);
    expect(await h.draftKeys()).toEqual(["x.png"]);
    expect(await h.publicKeys()).toEqual([]);
  });

  it("applies config overrides", async () => {
    const h = await makeDeps({ setupCode: "0123456789abcdef" });
    expect(h.deps.config).toEqual({ publicImageBase: "", setupCode: "0123456789abcdef" });
    expect(typeof h.deps.now()).toBe("number");
  });
});
