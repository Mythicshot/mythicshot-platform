// AWS Signature Version 4, as the S3 API takes it (0.1.71): the request signer the R2 file
// store (src/node/r2-files.ts) puts in front of every request. Pure: node:crypto only, no
// clock and no network, so each step can be checked on its own against the published worked
// examples (test/node-sigv4.test.ts). The secret only ever goes into the HMAC chain below; it
// is never put in a string that is returned, thrown or logged.
//
// S3's own rules, which differ from the generic service rules: the path is encoded once (each
// byte outside the unreserved set as %XX, slashes kept), never normalised and never encoded a
// second time; the hash of the payload is sent in x-amz-content-sha256 and is the last line of
// the canonical request.
import { createHash, createHmac } from "node:crypto";

/** The algorithm name, the first word of the Authorization header and of the string to sign. */
export const ALGORITHM = "AWS4-HMAC-SHA256";

/** The SHA-256 of an empty payload, in hex. */
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** One request to sign. `path` and the query are as written, not encoded: the signer encodes them. */
export type SignRequest = {
  method: string;
  /** The path, beginning with a slash, unencoded (such as /bucket/u/abc/step-001.png). */
  path: string;
  /** The query's names and values, unencoded; a name without a value has the value "". */
  query: readonly (readonly [string, string])[];
  /** Every header to sign, the host among them. Names in any case; values as sent. */
  headers: Readonly<Record<string, string>>;
  /** The hex SHA-256 of the payload, as sent in x-amz-content-sha256. */
  payloadHash: string;
};

export type SignScope = {
  /** YYYYMMDDTHHMMSSZ, the x-amz-date header's value. */
  amzDate: string;
  region: string;
  service: string;
};

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Uint8Array | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** RFC 3986 encoding of each UTF-8 byte outside A-Z a-z 0-9 - _ . ~, as %XX in upper case; `/` kept when asked. */
export function uriEncode(text: string, keepSlash: boolean): string {
  let out = "";
  for (const byte of new TextEncoder().encode(text)) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(c) || (keepSlash && c === "/")) out += c;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** The canonical query string: each name and value encoded, sorted by name and then by value, joined with &. */
export function canonicalQuery(query: SignRequest["query"]): string {
  const pairs = query.map(([k, v]) => [uriEncode(k, false), uriEncode(v, false)] as const);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

/** The headers in canonical form: names in lower case and sorted, values trimmed with inner runs of spaces as one. */
export function canonicalHeaders(headers: SignRequest["headers"]): { text: string; signed: string } {
  const entries = Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/ +/g, " ")] as const);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { text: entries.map(([k, v]) => `${k}:${v}\n`).join(""), signed: entries.map(([k]) => k).join(";") };
}

/** The canonical request, six parts joined by newlines. */
export function canonicalRequest(req: SignRequest): string {
  const h = canonicalHeaders(req.headers);
  return [req.method.toUpperCase(), uriEncode(req.path, true), canonicalQuery(req.query), h.text, h.signed, req.payloadHash].join("\n");
}

/** The credential scope: date/region/service/aws4_request. */
export function credentialScope(scope: SignScope): string {
  return `${scope.amzDate.slice(0, 8)}/${scope.region}/${scope.service}/aws4_request`;
}

/** The string to sign for a canonical request. */
export function stringToSign(canonical: string, scope: SignScope): string {
  return [ALGORITHM, scope.amzDate, credentialScope(scope), sha256Hex(canonical)].join("\n");
}

/** The signing key: HMAC of the date, region, service and "aws4_request", starting from "AWS4" and the secret. */
export function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), "aws4_request");
}

/** The request's signature and its Authorization header. Neither holds the secret. */
export function sign(req: SignRequest, scope: SignScope, credentials: { accessKeyId: string; secret: string }): { authorization: string; signature: string; signedHeaders: string } {
  const canonical = canonicalRequest(req);
  const key = signingKey(credentials.secret, scope.amzDate.slice(0, 8), scope.region, scope.service);
  const signature = createHmac("sha256", key).update(stringToSign(canonical, scope), "utf8").digest("hex");
  const signedHeaders = canonicalHeaders(req.headers).signed;
  return {
    authorization: `${ALGORITHM} Credential=${credentials.accessKeyId}/${credentialScope(scope)}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    signature,
    signedHeaders,
  };
}

/** The x-amz-date value of a moment: YYYYMMDDTHHMMSSZ in UTC. */
export function amzDate(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
