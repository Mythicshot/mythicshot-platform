// The Node target's third file store (0.1.71): one R2 bucket, reached through R2's
// S3-compatible API with plain HTTPS requests that the app signs itself (src/node/sigv4.ts).
// fetch only; no package. Endpoint https://<ACCOUNT_ID>.r2.cloudflarestorage.com, path-style
// /<bucket>/<key>, Signature Version 4 with region `auto` and service `s3`, and the payload's
// hash in x-amz-content-sha256 on every request.
//
// It keeps the FileStore contract (src/ports.ts) the folder store and the R2 binding keep:
// - put replaces the whole object, its content type and its cache control with it, so a
//   replace without a cache control clears the one before (S3's PUT replaces the metadata).
// - get answers null for a key that is not there (404 NoSuchKey) and streams the body, never
//   reading it whole first; a body that ends short of its Content-Length errors the stream.
// - delete checks every key before it deletes any, and deletes at most 1,000 per call with
//   DeleteObjects; a key already gone is success, an error reported for one key is a failure.
//
// Every request has a deadline, is never redirected, and is tried again a few times, with
// a growing pause, when no answer came or the answer was a server error: every call here is
// idempotent. A failure is an R2Error with a fixed message, `r2: <reason>` from REASONS:
// never the secret, the Authorization header, the signed request, a key, a bucket or a body.
// Keys are kept out of errors as the folder store keeps them out ("bad key", "corrupt object
// file"). Nothing here logs.
//
// The two buckets are made as a pair only, by r2Stores, which refuses one bucket for both.
import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { checkKey, type FileStore, type StoredFile } from "../ports.ts";
import { amzDate, canonicalQuery, sha256Hex, sign, uriEncode } from "./sigv4.ts";

/** R2 deletes at most 1,000 keys per DeleteObjects call. */
export const DELETE_CHUNK = 1000;

/** The region and service every request is signed for. */
export const R2_REGION = "auto";
export const R2_SERVICE = "s3";

/** The account's S3 address. The only one this store ever talks to outside the tests. */
export function r2Endpoint(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

/**
 * The secret access key, kept where it cannot be printed by accident: JSON, String() and
 * util.inspect all give "[hidden]". Only the signer reads it, through reveal().
 */
export class R2Secret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toJSON(): string {
    return "[hidden]";
  }
  toString(): string {
    return "[hidden]";
  }
  [inspect.custom](): string {
    return "[hidden]";
  }
}

/** The five R2 settings, checked (src/node/file-stores.ts). */
export type R2Settings = { accountId: string; accessKeyId: string; secret: R2Secret; privateBucket: string; publicBucket: string };

/** Why a call failed, in words a terminal may show: fixed, and never a value. */
export const REASONS = {
  unreachable: "no answer from R2",
  timedOut: "R2 did not answer in time",
  serverError: "R2 answered with a server error",
  keyRefused: "R2 refused the access key or its signature",
  accessDenied: "R2 refused access to the bucket",
  noSuchBucket: "R2 has no such bucket",
  clock: "R2 says this server's clock is wrong",
  refused: "R2 refused the request",
  badAnswer: "R2's answer could not be read",
  truncated: "R2's answer ended before the whole file",
  deleteFailed: "R2 could not delete every file",
} as const;
export type R2Reason = keyof typeof REASONS;

/** A failed call. The message is fixed: `r2: ` and the reason's words. */
export class R2Error extends Error {
  readonly reason: R2Reason;
  constructor(reason: R2Reason) {
    super(`r2: ${REASONS[reason]}`);
    this.name = "R2Error";
    this.reason = reason;
  }
}

/** A store on one bucket, with the lister the folder store also has. */
export interface R2Store extends FileStore {
  /** Which of the two buckets this is. */
  readonly role: "private" | "public";
  /** Every key in the bucket, sorted, through ListObjectsV2 page by page. For tests and the admin command's tools only. */
  keys(): Promise<string[]>;
}

/**
 * What a test may change. Nothing here is read from a setting: the site's own stores are
 * made without options, and so talk to r2Endpoint(accountId) with the target's fetch.
 */
export type R2Options = {
  /** The S3 address, without a trailing slash (tests: the stand-in on 127.0.0.1). */
  endpoint?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The deadline for an answer's headers, and for a whole request that is not a streamed get. */
  timeoutMs?: number;
  /** The deadline for a get's whole body. */
  bodyTimeoutMs?: number;
  /** Pauses before the tries after the first: their count is the number of retries. */
  retryPausesMs?: readonly number[];
};

const TIMEOUT_MS = 30_000;
const BODY_TIMEOUT_MS = 120_000;
const RETRY_PAUSES_MS = [200, 800] as const;
/** At most this many pages of a listing (a million keys), so a server that never ends a listing cannot hold the caller forever. */
const MAX_LIST_PAGES = 1000;

/** The pair of stores of the R2 settings. Refuses one bucket for both, whatever the caller. */
export function r2Stores(settings: R2Settings, opts: R2Options = {}): { drafts: R2Store; pub: R2Store } {
  if (settings.privateBucket === settings.publicBucket) throw new Error("r2: the private and the public files must be in two different buckets");
  const client = new R2Client(settings, opts);
  return { drafts: new R2BucketStore(client, settings.privateBucket, "private"), pub: new R2BucketStore(client, settings.publicBucket, "public") };
}

type Query = readonly (readonly [string, string])[];

class R2Client {
  readonly #settings: R2Settings;
  readonly #endpoint: string;
  readonly #host: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #timeoutMs: number;
  readonly #bodyTimeoutMs: number;
  readonly #pauses: readonly number[];

  constructor(settings: R2Settings, opts: R2Options) {
    this.#settings = settings;
    this.#endpoint = opts.endpoint ?? r2Endpoint(settings.accountId);
    this.#host = new URL(this.#endpoint).host;
    this.#fetch = opts.fetchFn ?? ((input, init) => fetch(input, init));
    this.#now = opts.now ?? (() => Date.now());
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    this.#bodyTimeoutMs = opts.bodyTimeoutMs ?? BODY_TIMEOUT_MS;
    this.#pauses = opts.retryPausesMs ?? RETRY_PAUSES_MS;
  }

  toJSON(): string {
    return "[R2 client]";
  }
  [inspect.custom](): string {
    return "[R2 client]";
  }

  /**
   * One signed request, tried again after a pause when no answer came or the answer was a
   * server error (5xx), at most as many times as there are pauses. `streamed`: the answer's
   * body is read later by the caller, so only its headers are bound by the short deadline,
   * and the whole body by the long one. Throws R2Error only.
   */
  async send(method: "GET" | "PUT" | "POST", bucket: string, key: string | null, query: Query, body: Uint8Array | null, headers: Record<string, string>, streamed = false): Promise<Response> {
    const path = `/${bucket}${key === null ? "" : `/${key}`}`;
    // The query as the server will read it back: the canonical form, a name without a value written bare.
    const search = canonicalQuery(query)
      .split("&")
      .filter((p) => p !== "")
      .map((p) => (p.endsWith("=") ? p.slice(0, -1) : p))
      .join("&");
    const url = `${this.#endpoint}${uriEncode(path, true)}${search === "" ? "" : `?${search}`}`;
    const payloadHash = sha256Hex(body ?? new Uint8Array(0));
    for (let attempt = 0; ; attempt++) {
      const date = amzDate(this.#now());
      const signedHeaders: Record<string, string> = {
        ...headers,
        host: this.#host,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": date,
      };
      if (body !== null) signedHeaders["content-length"] = String(body.byteLength);
      const { authorization } = sign(
        { method, path, query, headers: signedHeaders, payloadHash },
        { amzDate: date, region: R2_REGION, service: R2_SERVICE },
        { accessKeyId: this.#settings.accessKeyId, secret: this.#settings.secret.reveal() },
      );
      // fetch sets Host itself, from the address: the same value as the one signed.
      const { host: _host, ...sent } = signedHeaders;
      const headerTimer = new AbortController();
      const timer = setTimeout(() => headerTimer.abort(new DOMException("timed out", "TimeoutError")), this.#timeoutMs);
      const signal = streamed ? AbortSignal.any([headerTimer.signal, AbortSignal.timeout(this.#bodyTimeoutMs)]) : AbortSignal.any([headerTimer.signal, AbortSignal.timeout(this.#timeoutMs)]);
      let res: Response | null = null;
      let failure: R2Reason = "unreachable";
      try {
        res = await this.#fetch(url, {
          method,
          headers: { ...sent, authorization, ...(method === "GET" ? { "accept-encoding": "identity" } : {}) },
          ...(body === null ? {} : { body }),
          redirect: "error",
          signal,
        });
      } catch (err) {
        // Fixed reasons only: the error of a failed fetch could carry the request it was making.
        failure = isTimeout(err) || signal.aborted ? "timedOut" : "unreachable";
        res = null;
      }
      // The headers are in (or never came): from here only the deadline of the whole request
      // holds, the long one for a streamed get's body, the short one for everything else.
      clearTimeout(timer);
      if (res !== null && res.status < 500) return res;
      if (res !== null) {
        failure = "serverError";
        await discard(res);
      }
      if (attempt >= this.#pauses.length) throw new R2Error(failure);
      await this.#sleep(this.#pauses[attempt]);
    }
  }
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/** Reads and drops an answer's body, whatever happens. */
async function discard(res: Response): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch {
    // Nothing to keep.
  }
}

/** An answer's body as text, or null when it could not be read in full. */
async function textOf(res: Response): Promise<string | null> {
  try {
    return await res.text();
  } catch {
    return null;
  }
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** The text of an XML element's content, with entities and character references decoded. */
export function xmlUnescape(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (m, ref: string) => {
    if (ref.startsWith("#x")) return String.fromCodePoint(Number.parseInt(ref.slice(2), 16));
    if (ref.startsWith("#")) return String.fromCodePoint(Number.parseInt(ref.slice(1), 10));
    return XML_ENTITIES[ref] ?? m;
  });
}

/** Text an XML element may hold: the five characters that must be written as entities are. */
export function xmlEscape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&${Object.entries(XML_ENTITIES).find(([, v]) => v === c)![0]};`);
}

/** Every element `<tag>…</tag>` directly holding text, in order. */
function elements(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]);
}

/** The S3 error code of an answer's body (such as NoSuchKey), or null. */
function errorCode(xml: string | null): string | null {
  if (xml === null) return null;
  const code = /<Error>[\s\S]*?<Code>([A-Za-z0-9.]{1,64})<\/Code>/.exec(xml)?.[1];
  return code ?? null;
}

/** The fixed reason of an answer that is not a success. */
function reasonOf(status: number, code: string | null): R2Reason {
  if (code === "NoSuchBucket") return "noSuchBucket";
  if (code === "SignatureDoesNotMatch" || code === "InvalidAccessKeyId" || code === "AuthorizationHeaderMalformed") return "keyRefused";
  if (code === "RequestTimeTooSkewed") return "clock";
  if (code === "AccessDenied" || status === 403) return "accessDenied";
  if (status === 401) return "keyRefused";
  return "refused";
}

async function failed(res: Response): Promise<R2Error> {
  return new R2Error(reasonOf(res.status, errorCode(await textOf(res))));
}

class R2BucketStore implements R2Store {
  readonly #client: R2Client;
  readonly #bucket: string;
  readonly role: "private" | "public";

  constructor(client: R2Client, bucket: string, role: "private" | "public") {
    this.#client = client;
    this.#bucket = bucket;
    this.role = role;
  }

  toJSON(): string {
    return `[R2 ${this.role} store]`;
  }
  [inspect.custom](): string {
    return `[R2 ${this.role} store]`;
  }

  async put(key: string, body: Uint8Array, meta: { contentType: string; cacheControl?: string }): Promise<void> {
    checkKey(key);
    const headers: Record<string, string> = { "content-type": meta.contentType };
    if (meta.cacheControl !== undefined) headers["cache-control"] = meta.cacheControl;
    const res = await this.#client.send("PUT", this.#bucket, key, [], body, headers);
    if (res.status !== 200) throw await failed(res);
    await discard(res);
  }

  async get(key: string): Promise<StoredFile | null> {
    checkKey(key);
    const res = await this.#client.send("GET", this.#bucket, key, [], null, {}, true);
    if (res.status === 404) {
      const code = errorCode(await textOf(res));
      // Only a missing key is "not there": a missing bucket must never look like a missing picture.
      if (code === "NoSuchKey") return null;
      throw new R2Error(reasonOf(404, code));
    }
    if (res.status !== 200) throw await failed(res);
    const length = res.headers.get("content-length");
    if (length === null || !/^[0-9]{1,15}$/.test(length) || res.body === null) {
      await discard(res);
      throw new R2Error("badAnswer");
    }
    const size = Number(length);
    return {
      body: exactly(res.body, size),
      size,
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
      cacheControl: res.headers.get("cache-control"),
    };
  }

  async delete(keys: string[]): Promise<void> {
    // Check every key before deleting any.
    for (const k of keys) checkKey(k);
    for (let i = 0; i < keys.length; i += DELETE_CHUNK) {
      const chunk = keys.slice(i, i + DELETE_CHUNK);
      const xml = `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>${chunk.map((k) => `<Object><Key>${xmlEscape(k)}</Key></Object>`).join("")}</Delete>`;
      const body = new TextEncoder().encode(xml);
      // DeleteObjects requires a checksum of its body; Content-MD5 is the one every S3 API takes.
      const md5 = createHash("md5").update(body).digest("base64");
      const res = await this.#client.send("POST", this.#bucket, null, [["delete", ""]], body, { "content-type": "application/xml", "content-md5": md5 });
      if (res.status !== 200) throw await failed(res);
      const answer = await textOf(res);
      if (answer === null || !/<DeleteResult[\s>/]/.test(answer)) throw new R2Error("badAnswer");
      // Quiet: only the keys that could not be deleted are listed. A key that was not there is deleted.
      if (/<Error>/.test(answer)) throw new R2Error("deleteFailed");
    }
  }

  async keys(): Promise<string[]> {
    const out: string[] = [];
    let token: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const query: [string, string][] = [["list-type", "2"], ["max-keys", "1000"]];
      if (token !== null) query.push(["continuation-token", token]);
      const res = await this.#client.send("GET", this.#bucket, null, query, null, {});
      if (res.status !== 200) throw await failed(res);
      const xml = await textOf(res);
      if (xml === null || !/<ListBucketResult[\s>]/.test(xml)) throw new R2Error("badAnswer");
      for (const contents of elements(xml, "Contents")) {
        const key = /<Key>([\s\S]*?)<\/Key>/.exec(contents)?.[1];
        if (key === undefined) throw new R2Error("badAnswer");
        out.push(xmlUnescape(key));
      }
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      if (!truncated) return out.sort();
      const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
      if (next === undefined || next === "" || seen.has(next)) throw new R2Error("badAnswer");
      seen.add(next);
      token = xmlUnescape(next);
    }
    throw new R2Error("badAnswer");
  }
}

/**
 * The body as it streams, checked to be exactly `size` bytes: one that ends short or runs
 * long, or breaks off, errors the stream with R2Error("truncated") (or "timedOut" past the
 * body's deadline), never with the transport's own error.
 */
function exactly(body: ReadableStream<Uint8Array>, size: number): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let seen = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (err) {
        controller.error(new R2Error(isTimeout(err) ? "timedOut" : "truncated"));
        return;
      }
      if (chunk.done) {
        if (seen !== size) controller.error(new R2Error("truncated"));
        else controller.close();
        return;
      }
      seen += chunk.value.byteLength;
      if (seen > size) {
        controller.error(new R2Error("truncated"));
        await reader.cancel().catch(() => {});
        return;
      }
      controller.enqueue(chunk.value);
    },
    async cancel() {
      await reader.cancel().catch(() => {});
    },
  });
}
