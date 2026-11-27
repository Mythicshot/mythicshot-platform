// A small stand-in for R2's S3-compatible API, for tests only (0.1.71): an HTTP server on
// 127.0.0.1 on a port the system picks, holding objects in memory per bucket. It checks the
// Signature Version 4 of every request with its own code, written apart from the app's signer
// (src/node/sigv4.ts) and importing nothing of it, so a signing mistake cannot pass by agreeing
// with itself. It refuses what R2 refuses in the cases the store meets: a wrong key or
// signature, a wrong region or service, no payload hash or a wrong one, an unsigned x-amz-*
// header, a clock off by more than 15 minutes, a DeleteObjects without its Content-MD5 or with a
// wrong one, an unknown bucket or key, answering in S3's XML error format.
//
// It implements PutObject, GetObject, HeadObject, DeleteObjects and ListObjectsV2 (with pages
// of a size a test may lower), path-style only. What it does not model of the real service is
// listed in the report of this step and in test/node-r2-files.test.ts. `fault` lets a test make
// one request fail in a chosen way. Nothing here reaches any other host.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type StandInObject = { body: Buffer; contentType: string; cacheControl: string | null; etag: string };

/** What a fault does to the one request it is returned for. */
export type Fault =
  | { kind: "status"; status: number; code: string }
  | { kind: "hang" }
  | { kind: "reset" }
  | { kind: "truncate"; send: number }
  /** Sends the headers and the first `send` bytes, then nothing more, leaving the answer open. */
  | { kind: "stall"; send: number }
  | { kind: "redirect" }
  | { kind: "delete-error"; key: string; code: string };

export type SeenRequest = { method: string; path: string; query: string; headers: Record<string, string | string[] | undefined>; body: Buffer };

export type StandIn = {
  /** http://127.0.0.1:<port>, the endpoint the store is pointed at. */
  url: string;
  accountId: string;
  accessKeyId: string;
  secret: string;
  buckets: Map<string, Map<string, StandInObject>>;
  createBucket(name: string): void;
  /** Every request that reached it, verified or not, in order. */
  requests: SeenRequest[];
  /** Asked for every request before anything else; a fault it returns is what that request gets. */
  fault: ((req: SeenRequest, n: number) => Fault | null) | null;
  /** The keys a ListObjectsV2 answers per page at most (S3: 1,000). */
  pageSize: number;
  /** The stand-in's clock, for the skew check. */
  now: () => number;
  close(): Promise<void>;
};

const SKEW_MS = 15 * 60 * 1000;

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function unxml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${xml(message)}</Message></Error>`;
  res.writeHead(status, { "content-type": "application/xml", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

/** S3's encoding of one path segment or query part: every byte but A-Z a-z 0-9 - . _ ~ as %XX. Written apart from the app's. */
function s3Encode(s: string, slash: boolean): string {
  return encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%2F/g, slash ? "/" : "%2F");
}

/** The signature the request should carry, worked out from what arrived. Throws a [status, code] on a malformed request. */
function expected(req: IncomingMessage, rawPath: string, rawQuery: string, signedNames: string[], scope: { date: string; region: string; service: string }, amzDate: string, secret: string): string {
  const path = rawPath
    .split("/")
    .map((seg) => s3Encode(decodeURIComponent(seg), false))
    .join("/");
  const params = rawQuery === "" ? [] : rawQuery.split("&").map((part) => {
    const eq = part.indexOf("=");
    const name = decodeURIComponent(eq < 0 ? part : part.slice(0, eq));
    const value = eq < 0 ? "" : decodeURIComponent(part.slice(eq + 1));
    return [s3Encode(name, false), s3Encode(value, false)] as const;
  });
  // By name, then by value.
  params.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  const headerLines = signedNames.map((name) => {
    const v = req.headers[name];
    const value = Array.isArray(v) ? v.join(",") : (v ?? "");
    return `${name}:${String(value).trim().split(/ +/).join(" ")}\n`;
  });
  const canonical = `${req.method}\n${path}\n${params.map(([k, v]) => `${k}=${v}`).join("&")}\n${headerLines.join("")}\n${signedNames.join(";")}\n${String(req.headers["x-amz-content-sha256"])}`;
  const hash = createHash("sha256").update(canonical, "utf8").digest("hex");
  const toSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope.date}/${scope.region}/${scope.service}/aws4_request\n${hash}`;
  let key: Buffer = createHmac("sha256", "AWS4" + secret).update(scope.date).digest();
  for (const part of [scope.region, scope.service, "aws4_request"]) key = createHmac("sha256", key).update(part).digest();
  return createHmac("sha256", key).update(toSign).digest("hex");
}

/** Checks the request's authentication as S3 does; answers the error and returns false when it fails. */
function verify(st: StandIn, req: IncomingMessage, res: ServerResponse, rawPath: string, rawQuery: string, body: Buffer): boolean {
  const auth = req.headers.authorization;
  const m = typeof auth === "string" ? /^AWS4-HMAC-SHA256 Credential=([^/,\s]+)\/(\d{8})\/([^/,\s]+)\/([^/,\s]+)\/aws4_request, ?SignedHeaders=([a-z0-9;-]+), ?Signature=([0-9a-f]{64})$/.exec(auth) : null;
  if (m === null) {
    sendError(res, 400, "AuthorizationHeaderMalformed", "The authorization header is malformed.");
    return false;
  }
  const [, keyId, date, region, service, signed, signature] = m;
  if (keyId !== st.accessKeyId) {
    sendError(res, 403, "InvalidAccessKeyId", "The AWS Access Key Id you provided does not exist in our records.");
    return false;
  }
  if (region !== "auto" || service !== "s3") {
    sendError(res, 400, "AuthorizationHeaderMalformed", "The authorization header is malformed; the region or service is wrong.");
    return false;
  }
  const sha = req.headers["x-amz-content-sha256"];
  if (typeof sha !== "string") {
    sendError(res, 400, "InvalidRequest", "Missing required header for this request: x-amz-content-sha256");
    return false;
  }
  if (sha !== createHash("sha256").update(body).digest("hex")) {
    sendError(res, 400, "XAmzContentSHA256Mismatch", "The provided 'x-amz-content-sha256' header does not match what was computed.");
    return false;
  }
  const amzDate = req.headers["x-amz-date"];
  if (typeof amzDate !== "string" || !/^\d{8}T\d{6}Z$/.test(amzDate) || amzDate.slice(0, 8) !== date) {
    sendError(res, 403, "AccessDenied", "The x-amz-date header is missing or does not match the credential's date.");
    return false;
  }
  const at = Date.UTC(+amzDate.slice(0, 4), +amzDate.slice(4, 6) - 1, +amzDate.slice(6, 8), +amzDate.slice(9, 11), +amzDate.slice(11, 13), +amzDate.slice(13, 15));
  if (Math.abs(at - st.now()) > SKEW_MS) {
    sendError(res, 403, "RequestTimeTooSkewed", "The difference between the request time and the current time is too large.");
    return false;
  }
  const names = signed.split(";");
  const sorted = [...names].sort();
  if (names.join(";") !== sorted.join(";") || new Set(names).size !== names.length) {
    sendError(res, 400, "AuthorizationHeaderMalformed", "The signed headers are not in order.");
    return false;
  }
  for (const required of ["host", "x-amz-content-sha256", "x-amz-date"]) {
    if (!names.includes(required)) {
      sendError(res, 403, "AccessDenied", `There were headers present in the request which were not signed: ${required}`);
      return false;
    }
  }
  for (const name of Object.keys(req.headers)) {
    if (name.startsWith("x-amz-") && !names.includes(name)) {
      sendError(res, 403, "AccessDenied", `There were headers present in the request which were not signed: ${name}`);
      return false;
    }
  }
  for (const name of names) {
    if (req.headers[name] === undefined) {
      sendError(res, 403, "SignatureDoesNotMatch", "A signed header is missing.");
      return false;
    }
  }
  const want = Buffer.from(expected(req, rawPath, rawQuery, names, { date, region, service }, amzDate, st.secret), "hex");
  const got = Buffer.from(signature, "hex");
  if (want.length !== got.length || !timingSafeEqual(want, got)) {
    sendError(res, 403, "SignatureDoesNotMatch", "The request signature we calculated does not match the signature you provided.");
    return false;
  }
  return true;
}

function queryOf(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  if (raw === "") return out;
  for (const part of raw.split("&")) {
    const eq = part.indexOf("=");
    out.set(decodeURIComponent(eq < 0 ? part : part.slice(0, eq)), eq < 0 ? "" : decodeURIComponent(part.slice(eq + 1)));
  }
  return out;
}

function handle(st: StandIn, req: IncomingMessage, res: ServerResponse, body: Buffer, n: number): void {
  const raw = req.url ?? "/";
  const q = raw.indexOf("?");
  const rawPath = q < 0 ? raw : raw.slice(0, q);
  const rawQuery = q < 0 ? "" : raw.slice(q + 1);
  const seen: SeenRequest = { method: req.method ?? "", path: rawPath, query: rawQuery, headers: { ...req.headers }, body };
  st.requests.push(seen);
  const fault = st.fault?.(seen, n) ?? null;
  if (fault !== null) {
    if (fault.kind === "hang") return;
    if (fault.kind === "reset") {
      req.socket.destroy();
      return;
    }
    if (fault.kind === "redirect") {
      res.writeHead(307, { location: "http://127.0.0.1:9/elsewhere" });
      res.end();
      return;
    }
    if (fault.kind === "status") {
      sendError(res, fault.status, fault.code, "A fault the test asked for.");
      return;
    }
  }
  if (!verify(st, req, res, rawPath, rawQuery, body)) return;

  const declared = req.headers["content-length"];
  if (declared !== undefined && Number(declared) !== body.byteLength) {
    sendError(res, 400, "IncompleteBody", "You did not provide the number of bytes specified by the Content-Length HTTP header.");
    return;
  }
  const segments = rawPath.split("/").slice(1);
  const bucketName = decodeURIComponent(segments[0] ?? "");
  const key = segments.slice(1).map(decodeURIComponent).join("/");
  const bucket = st.buckets.get(bucketName);
  if (bucketName === "" || bucket === undefined) {
    sendError(res, 404, "NoSuchBucket", "The specified bucket does not exist.");
    return;
  }
  const query = queryOf(rawQuery);

  if (key === "" && req.method === "POST" && query.has("delete")) {
    const md5 = req.headers["content-md5"];
    if (typeof md5 !== "string") {
      sendError(res, 400, "InvalidRequest", "Missing required header for this request: Content-Md5");
      return;
    }
    if (md5 !== createHash("md5").update(body).digest("base64")) {
      sendError(res, 400, "BadDigest", "The Content-MD5 you specified did not match what we received.");
      return;
    }
    const text = body.toString("utf8");
    if (!/^<\?xml[^>]*\?>\s*<Delete[\s>]/.test(text)) {
      sendError(res, 400, "MalformedXML", "The XML you provided was not well-formed.");
      return;
    }
    const keys = [...text.matchAll(/<Object>\s*<Key>([\s\S]*?)<\/Key>\s*<\/Object>/g)].map((x) => unxml(x[1]));
    if (keys.length === 0 || keys.length > 1000) {
      sendError(res, 400, "MalformedXML", "The XML you provided was not well-formed.");
      return;
    }
    const quiet = /<Quiet>true<\/Quiet>/.test(text);
    let out = '<?xml version="1.0" encoding="UTF-8"?>\n<DeleteResult>';
    for (const k of keys) {
      if (fault?.kind === "delete-error" && fault.key === k) {
        out += `<Error><Key>${xml(k)}</Key><Code>${fault.code}</Code><Message>A fault the test asked for.</Message></Error>`;
        continue;
      }
      bucket.delete(k);
      if (!quiet) out += `<Deleted><Key>${xml(k)}</Key></Deleted>`;
    }
    out += "</DeleteResult>";
    res.writeHead(200, { "content-type": "application/xml", "content-length": Buffer.byteLength(out) });
    res.end(out);
    return;
  }

  if (key === "" && req.method === "GET" && query.get("list-type") === "2") {
    const all = [...bucket.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const max = Math.min(Number(query.get("max-keys") ?? "1000"), st.pageSize);
    const after = query.has("continuation-token") ? Buffer.from(query.get("continuation-token") ?? "", "base64url").toString("utf8") : null;
    const from = after === null ? all : all.filter((k) => Buffer.compare(Buffer.from(k), Buffer.from(after)) > 0);
    const page = from.slice(0, max);
    const truncated = from.length > page.length;
    let out = `<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult><Name>${xml(bucketName)}</Name><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${truncated}</IsTruncated>`;
    for (const k of page) out += `<Contents><Key>${xml(k)}</Key><Size>${bucket.get(k)!.body.byteLength}</Size><ETag>${xml(bucket.get(k)!.etag)}</ETag></Contents>`;
    if (truncated) out += `<NextContinuationToken>${Buffer.from(page[page.length - 1]).toString("base64url")}</NextContinuationToken>`;
    out += "</ListBucketResult>";
    res.writeHead(200, { "content-type": "application/xml", "content-length": Buffer.byteLength(out) });
    res.end(out);
    return;
  }

  if (key !== "" && req.method === "PUT") {
    const etag = `"${createHash("md5").update(body).digest("hex")}"`;
    const ct = req.headers["content-type"];
    const cc = req.headers["cache-control"];
    // A PUT replaces the object and all of its metadata.
    bucket.set(key, { body: Buffer.from(body), contentType: typeof ct === "string" ? ct : "application/octet-stream", cacheControl: typeof cc === "string" ? cc : null, etag });
    res.writeHead(200, { etag, "content-length": 0 });
    res.end();
    return;
  }

  if (key !== "" && (req.method === "GET" || req.method === "HEAD")) {
    const obj = bucket.get(key);
    if (obj === undefined) {
      sendError(res, 404, "NoSuchKey", "The specified key does not exist.");
      return;
    }
    // An object stored without a type (set so by a test) is answered without the header.
    const headers: Record<string, string | number> = { "content-length": obj.body.byteLength, etag: obj.etag };
    if (obj.contentType !== "") headers["content-type"] = obj.contentType;
    if (obj.cacheControl !== null) headers["cache-control"] = obj.cacheControl;
    if (fault?.kind === "stall") {
      res.writeHead(200, headers);
      res.write(obj.body.subarray(0, fault.send));
      return;
    }
    if (fault?.kind === "truncate") {
      res.writeHead(200, headers);
      res.write(obj.body.subarray(0, fault.send), () => req.socket.destroy());
      return;
    }
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : obj.body);
    return;
  }

  sendError(res, 501, "NotImplemented", "A header you provided implies functionality that is not implemented.");
}

/** Starts a stand-in with fresh credentials and no bucket. */
export async function startStandIn(): Promise<StandIn> {
  let n = 0;
  const hex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const st: StandIn = {
    url: "",
    accountId: hex(16),
    accessKeyId: hex(16),
    secret: hex(32),
    buckets: new Map(),
    createBucket(name) {
      if (!st.buckets.has(name)) st.buckets.set(name, new Map());
    },
    requests: [],
    fault: null,
    pageSize: 1000,
    now: () => Date.now(),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => handle(st, req, res, Buffer.concat(chunks), n++));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  // Never keeps a test process alive on its own.
  server.unref();
  st.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = st.close;
  st.close = async () => {
    server.closeAllConnections();
    await close();
  };
  return st;
}
