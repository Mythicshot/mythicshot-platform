// The R2 file store (src/node/r2-files.ts, 0.1.71), against the stand-in for R2's S3 API in
// test/node-r2-standin.ts: an HTTP server on 127.0.0.1 that checks every signature with its own
// code. The shared FileStore contract runs unchanged on both buckets; then the failures: a
// wrong secret or key, a wrong bucket, a clock that is off, answers that never come, server
// errors once and for good, a body cut short, a per-key error from DeleteObjects, a hostile
// key, a redirect; and no error or log line carries the secret or the Authorization header.
// Node only. No request leaves 127.0.0.1: the one test of the real address hands the store a
// fetch that records the address and answers nothing.
//
// What the stand-in does not model of the real service: TLS, R2's own limits and rate
// limiting, eventual behaviours under load, multipart uploads, conditional requests,
// versioning, R2's exact wording of errors beyond their codes, and anything about a token's
// permissions other than right or wrong. r2-check on the live server is the first real proof.
import { inspect } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { R2Error, R2Secret, r2Endpoint, r2Stores, type R2Options, type R2Settings } from "../src/node/r2-files.ts";
import { amzDate, EMPTY_SHA256, sha256Hex, sign } from "../src/node/sigv4.ts";
import { fileStoreContract } from "./contract/files.contract.ts";
import { startStandIn, type StandIn } from "./node-r2-standin.ts";

let st: StandIn;
let counter = 0;

beforeAll(async () => {
  st = await startStandIn();
});
afterAll(async () => {
  await st.close();
});

/** Two new buckets in the stand-in and the pair of stores on them. */
function made(over: Partial<R2Settings> & { secretText?: string } = {}, opts: R2Options = {}) {
  counter += 1;
  const privateBucket = over.privateBucket ?? `private-${counter}`;
  const publicBucket = over.publicBucket ?? `public-${counter}`;
  st.createBucket(`private-${counter}`);
  st.createBucket(`public-${counter}`);
  const settings: R2Settings = {
    accountId: st.accountId,
    accessKeyId: over.accessKeyId ?? st.accessKeyId,
    secret: new R2Secret(over.secretText ?? st.secret),
    privateBucket,
    publicBucket,
  };
  const stores = r2Stores(settings, { endpoint: st.url, retryPausesMs: [1, 1], timeoutMs: 2000, ...opts });
  return { ...stores, privateBucket, publicBucket, settings };
}

const enc = (s: string) => new TextEncoder().encode(s);
const PNG = { contentType: "image/png" };

describe("drafts store on R2", () => {
  fileStoreContract(async () => {
    const s = made();
    return { store: s.drafts, keys: () => s.drafts.keys() };
  });
});

describe("public store on R2", () => {
  fileStoreContract(async () => {
    const s = made();
    return { store: s.pub, keys: () => s.pub.keys() };
  });
});

describe("what goes to R2", () => {
  it("each store writes to its own bucket only, path-style, signed for region auto and service s3", async () => {
    const s = made();
    st.requests.length = 0;
    await s.drafts.put("u/abc/step-001.png", enc("draft"), PNG);
    await s.pub.put("p/0123456789abcdef0123456789abcdef.png", enc("public"), PNG);
    expect([...st.buckets.get(s.privateBucket)!.keys()]).toEqual(["u/abc/step-001.png"]);
    expect([...st.buckets.get(s.publicBucket)!.keys()]).toEqual(["p/0123456789abcdef0123456789abcdef.png"]);
    expect(st.requests.map((r) => `${r.method} ${r.path}`)).toEqual([`PUT /${s.privateBucket}/u/abc/step-001.png`, `PUT /${s.publicBucket}/p/0123456789abcdef0123456789abcdef.png`]);
    for (const r of st.requests) {
      expect(r.headers.authorization).toMatch(new RegExp(`^AWS4-HMAC-SHA256 Credential=${st.accessKeyId}/\\d{8}/auto/s3/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$`));
      expect(r.headers["x-amz-content-sha256"]).toBe(sha256Hex(r.body));
      expect(r.headers["content-length"]).toBe(String(r.body.byteLength));
    }
  });

  it("a put sends the content type, the cache control only when given, and the whole body", async () => {
    const s = made();
    st.requests.length = 0;
    await s.drafts.put("a.png", enc("x"), { contentType: "image/png", cacheControl: "public, max-age=60" });
    await s.drafts.put("a.png", enc("yy"), { contentType: "image/jpeg" });
    expect(st.requests[0].headers["content-type"]).toBe("image/png");
    expect(st.requests[0].headers["cache-control"]).toBe("public, max-age=60");
    expect(st.requests[1].headers["cache-control"]).toBeUndefined();
    expect(st.buckets.get(s.privateBucket)!.get("a.png")).toMatchObject({ contentType: "image/jpeg", cacheControl: null });
    expect(st.buckets.get(s.privateBucket)!.get("a.png")!.body.toString()).toBe("yy");
  });

  it("a get falls back to application/octet-stream for an object without a content type", async () => {
    const s = made();
    st.buckets.get(s.privateBucket)!.set("raw.bin", { body: Buffer.from("raw"), contentType: "", cacheControl: null, etag: '"x"' });
    const got = await s.drafts.get("raw.bin");
    expect(got!.contentType).toBe("application/octet-stream");
    expect(got!.cacheControl).toBeNull();
  });

  it("a get answers before the body has arrived, and streams it as it comes", async () => {
    const s = made({}, { bodyTimeoutMs: 1500 });
    const big = Buffer.alloc(300_000, 7);
    st.buckets.get(s.privateBucket)!.set("big.bin", { body: big, contentType: "application/octet-stream", cacheControl: null, etag: '"b"' });
    st.fault = (r) => (r.method === "GET" && r.path.endsWith("/big.bin") ? { kind: "stall", send: 1000 } : null);
    try {
      const got = await s.drafts.get("big.bin");
      expect(got!.size).toBe(300_000);
      const reader = got!.body.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(first.value!.byteLength).toBeGreaterThan(0);
      expect(first.value!.byteLength).toBeLessThanOrEqual(1000);
      // The rest never comes: the body's deadline ends the stream with the fixed error.
      let err: unknown = null;
      try {
        for (;;) if ((await reader.read()).done) break;
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(R2Error);
      expect((err as R2Error).message).toBe("r2: R2 did not answer in time");
    } finally {
      st.fault = null;
    }
  });

  it("deletes in calls of at most 1,000 keys, each with the Content-MD5 DeleteObjects requires, and an empty list sends nothing", async () => {
    const s = made();
    const bucket = st.buckets.get(s.privateBucket)!;
    const keys = Array.from({ length: 2500 }, (_, i) => `k/${String(i).padStart(4, "0")}`);
    for (const k of keys) bucket.set(k, { body: Buffer.from("1"), contentType: "x/y", cacheControl: null, etag: '"1"' });
    bucket.set("keep", { body: Buffer.from("1"), contentType: "x/y", cacheControl: null, etag: '"1"' });
    st.requests.length = 0;
    await s.drafts.delete([...keys, "never/was"]);
    expect(st.requests.map((r) => `${r.method} ${r.query}`)).toEqual(["POST delete", "POST delete", "POST delete"]);
    expect(st.requests.map((r) => [...r.body.toString().matchAll(/<Key>/g)].length)).toEqual([1000, 1000, 501]);
    for (const r of st.requests) expect(typeof r.headers["content-md5"]).toBe("string");
    expect([...bucket.keys()]).toEqual(["keep"]);
    st.requests.length = 0;
    await s.drafts.delete([]);
    expect(st.requests).toEqual([]);
  });

  it("lists every key across pages, sorted", async () => {
    const s = made();
    st.pageSize = 3;
    try {
      const want = ["a", "b/c", "b", "z/z/z", "m.png", "c", "d", "e", "f", "g"];
      for (const k of want) await s.pub.put(k, enc(k), PNG);
      st.requests.length = 0;
      expect(await s.pub.keys()).toEqual([...want].sort());
      expect(st.requests.filter((r) => r.method === "GET")).toHaveLength(4);
    } finally {
      st.pageSize = 1000;
    }
  });

  it("the site's own stores talk to the account's address and nothing else, never following a redirect", async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const settings: R2Settings = { accountId: "0123456789abcdef0123456789abcdef", accessKeyId: "id", secret: new R2Secret("secret-value"), privateBucket: "mythic-private", publicBucket: "mythic-public" };
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init });
      throw new TypeError("no network in this test");
    }) as typeof fetch;
    const { drafts, pub } = r2Stores(settings, { fetchFn, retryPausesMs: [] });
    await expect(drafts.get("u/a.png")).rejects.toThrow("r2: no answer from R2");
    await expect(pub.put("p/b.png", enc("b"), PNG)).rejects.toThrow("r2: no answer from R2");
    expect(r2Endpoint(settings.accountId)).toBe("https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
    expect(seen.map((s) => s.url)).toEqual(["https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/mythic-private/u/a.png", "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/mythic-public/p/b.png"]);
    for (const s of seen) {
      expect(s.init?.redirect).toBe("error");
      expect(s.init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("refuses one bucket for both the private and the public files", () => {
    const settings: R2Settings = { accountId: st.accountId, accessKeyId: st.accessKeyId, secret: new R2Secret(st.secret), privateBucket: "same-one", publicBucket: "same-one" };
    expect(() => r2Stores(settings, { endpoint: st.url })).toThrow("r2: the private and the public files must be in two different buckets");
  });
});

describe("the stand-in checks the signature itself", () => {
  /** A request signed with the app's signer but with the scope or headers a test chooses, sent straight to the stand-in. */
  async function raw(o: { region?: string; service?: string; omitHash?: boolean; at?: number; unsigned?: Record<string, string> }): Promise<{ status: number; text: string }> {
    st.createBucket("raw-bucket");
    const url = new URL(`${st.url}/raw-bucket/x.txt`);
    const date = amzDate(o.at ?? Date.now());
    const headers: Record<string, string> = { host: url.host, "x-amz-date": date };
    if (!o.omitHash) headers["x-amz-content-sha256"] = EMPTY_SHA256;
    const { authorization } = sign({ method: "GET", path: url.pathname, query: [], headers, payloadHash: EMPTY_SHA256 }, { amzDate: date, region: o.region ?? "auto", service: o.service ?? "s3" }, { accessKeyId: st.accessKeyId, secret: st.secret });
    const { host: _h, ...sent } = headers;
    const res = await fetch(url, { headers: { ...sent, ...o.unsigned, authorization } });
    return { status: res.status, text: await res.text() };
  }

  it("takes a well-signed request", async () => {
    expect((await raw({})).text).toContain("<Code>NoSuchKey</Code>");
  });
  it("refuses another region or service", async () => {
    expect(await raw({ region: "us-east-1" })).toMatchObject({ status: 400 });
    expect((await raw({ service: "iam" })).text).toContain("AuthorizationHeaderMalformed");
  });
  it("refuses a request without the payload hash", async () => {
    expect((await raw({ omitHash: true })).text).toContain("Missing required header for this request: x-amz-content-sha256");
  });
  it("refuses a request from a clock more than 15 minutes off, and takes one 14 minutes off", async () => {
    expect((await raw({ at: Date.now() - 16 * 60_000 })).text).toContain("RequestTimeTooSkewed");
    expect((await raw({ at: Date.now() + 14 * 60_000 })).text).toContain("NoSuchKey");
  });
  it("refuses an x-amz-* header that was not signed", async () => {
    expect((await raw({ unsigned: { "x-amz-meta-extra": "1" } })).text).toContain("were not signed");
  });
});

describe("failures", () => {
  /** Runs `fn` and gives back its error, checked to be an R2Error with a fixed message holding neither the secret nor any Authorization header sent. */
  async function failure(fn: () => Promise<unknown>, secret = st.secret): Promise<R2Error> {
    let err: unknown = null;
    try {
      await fn();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(R2Error);
    const e = err as R2Error;
    const shown = [e.message, String(e.stack), JSON.stringify(e), inspect(e)].join("\n");
    expect(shown).not.toContain(secret);
    for (const r of st.requests) if (typeof r.headers.authorization === "string") expect(shown).not.toContain(r.headers.authorization.slice(-64));
    expect(e.message).toMatch(/^r2: [A-Za-z0-9' ]+$/);
    return e;
  }

  it("a wrong secret: the key is refused, once, without a retry", async () => {
    const s = made({ secretText: "a".repeat(64) });
    st.requests.length = 0;
    const e = await failure(() => s.drafts.put("a.png", enc("x"), PNG), "a".repeat(64));
    expect(e.message).toBe("r2: R2 refused the access key or its signature");
    expect(st.requests).toHaveLength(1);
    expect([...st.buckets.get(s.privateBucket)!.keys()]).toEqual([]);
  });

  it("a wrong access key id: refused the same way", async () => {
    const s = made({ accessKeyId: "f".repeat(32) });
    expect((await failure(() => s.drafts.get("a.png"))).reason).toBe("keyRefused");
  });

  it("a wrong bucket: every call fails, and a get never answers a missing picture for it", async () => {
    const s = made({ privateBucket: "no-such-bucket-here" });
    expect((await failure(() => s.drafts.get("a.png"))).message).toBe("r2: R2 has no such bucket");
    expect((await failure(() => s.drafts.put("a.png", enc("x"), PNG))).reason).toBe("noSuchBucket");
    expect((await failure(() => s.drafts.delete(["a.png"]))).reason).toBe("noSuchBucket");
    expect((await failure(() => s.drafts.keys())).reason).toBe("noSuchBucket");
  });

  it("a clock more than 15 minutes off: R2 says so", async () => {
    const s = made({}, { now: () => Date.now() - 20 * 60_000 });
    expect((await failure(() => s.pub.put("a.png", enc("x"), PNG))).message).toBe("r2: R2 says this server's clock is wrong");
  });

  it("no answer in time: tried three times in all, then the fixed line", async () => {
    const s = made({}, { timeoutMs: 150 });
    st.requests.length = 0;
    st.fault = () => ({ kind: "hang" });
    try {
      expect((await failure(() => s.drafts.put("a.png", enc("x"), PNG))).message).toBe("r2: R2 did not answer in time");
      expect(st.requests).toHaveLength(3);
      expect((await failure(() => s.drafts.get("a.png"))).reason).toBe("timedOut");
    } finally {
      st.fault = null;
    }
  });

  it("a server error, then success: the call succeeds on a later try", async () => {
    const s = made();
    let errors = 2;
    st.requests.length = 0;
    st.fault = () => (errors-- > 0 ? { kind: "status", status: 503, code: "ServiceUnavailable" } : null);
    try {
      await s.drafts.put("a.png", enc("x"), PNG);
      expect(st.requests).toHaveLength(3);
      expect(st.buckets.get(s.privateBucket)!.get("a.png")!.body.toString()).toBe("x");
    } finally {
      st.fault = null;
    }
  });

  it("server errors for good: the fixed line after the last try, and the pauses grow", async () => {
    const pauses: number[] = [];
    const s = made({}, { retryPausesMs: [5, 20], sleep: async (ms) => void pauses.push(ms) });
    st.requests.length = 0;
    st.fault = () => ({ kind: "status", status: 500, code: "InternalError" });
    try {
      expect((await failure(() => s.drafts.delete(["a.png"]))).message).toBe("r2: R2 answered with a server error");
      expect(st.requests).toHaveLength(3);
      expect(pauses).toEqual([5, 20]);
    } finally {
      st.fault = null;
    }
  });

  it("a connection broken off: no answer, after the retries", async () => {
    const s = made();
    st.requests.length = 0;
    st.fault = () => ({ kind: "reset" });
    try {
      expect((await failure(() => s.drafts.get("a.png"))).message).toBe("r2: no answer from R2");
      expect(st.requests).toHaveLength(3);
    } finally {
      st.fault = null;
    }
  });

  it("a body cut short of its Content-Length: reading it fails with the fixed line", async () => {
    const s = made();
    await s.drafts.put("a.bin", new Uint8Array(5000).fill(1), PNG);
    st.fault = (r) => (r.method === "GET" ? { kind: "truncate", send: 100 } : null);
    try {
      const got = await s.drafts.get("a.bin");
      expect(got!.size).toBe(5000);
      expect((await failure(() => new Response(got!.body).arrayBuffer())).message).toBe("r2: R2's answer ended before the whole file");
    } finally {
      st.fault = null;
    }
  });

  it("DeleteObjects reports an error for one key: the delete fails", async () => {
    const s = made();
    await s.drafts.put("a.png", enc("a"), PNG);
    await s.drafts.put("b.png", enc("b"), PNG);
    st.fault = (r) => (r.method === "POST" ? { kind: "delete-error", key: "b.png", code: "InternalError" } : null);
    try {
      expect((await failure(() => s.drafts.delete(["a.png", "b.png"]))).message).toBe("r2: R2 could not delete every file");
      expect(await s.drafts.keys()).toEqual(["b.png"]);
    } finally {
      st.fault = null;
    }
  });

  it("a hostile key is refused before anything is sent", async () => {
    const s = made();
    st.requests.length = 0;
    for (const key of ["../other-bucket/x", "a/../../b", "%2e%2e/x", "a?delete", "a#b", "A.png", "a b", "a\r\nx-amz-date: 1"]) {
      await expect(s.drafts.put(key, enc("x"), PNG)).rejects.toThrow("bad key");
      await expect(s.drafts.get(key)).rejects.toThrow("bad key");
      await expect(s.drafts.delete(["ok.png", key])).rejects.toThrow("bad key");
    }
    expect(st.requests).toEqual([]);
  });

  it("a redirect is never followed: no answer, and nothing reaches where it points", async () => {
    const s = made();
    st.requests.length = 0;
    st.fault = () => ({ kind: "redirect" });
    try {
      expect((await failure(() => s.pub.get("a.png"))).message).toBe("r2: no answer from R2");
      expect(st.requests.every((r) => r.path.startsWith(`/${s.publicBucket}/`))).toBe(true);
    } finally {
      st.fault = null;
    }
  });

  it("nothing is logged, and printing the settings or the stores never shows the secret", async () => {
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((m) => vi.spyOn(console, m));
    try {
      const s = made({ secretText: "b".repeat(64) });
      await failure(() => s.drafts.put("a.png", enc("x"), PNG), "b".repeat(64));
      const good = made();
      await good.drafts.put("a.png", enc("x"), PNG);
      await good.drafts.get("a.png");
      await good.drafts.delete(["a.png"]);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      const printed = [inspect(good.settings), JSON.stringify(good.settings), String(good.settings.secret), inspect(good.drafts), JSON.stringify(good.pub), inspect(good, { depth: 10 })].join("\n");
      expect(printed).not.toContain(st.secret);
      expect(printed).toContain("[hidden]");
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
