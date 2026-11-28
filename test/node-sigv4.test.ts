// The request signer of the R2 file store (src/node/sigv4.ts, 0.1.71), checked step by step
// against AWS's published worked examples of Signature Version 4. Every expected value below
// is the one the example publishes; none was produced by this signer. Node only, no network.
import { describe, expect, it } from "vitest";
import { amzDate, canonicalQuery, canonicalRequest, EMPTY_SHA256, sha256Hex, sign, signingKey, stringToSign, uriEncode } from "../src/node/sigv4.ts";

/** The example credentials of AWS's generic Signature Version 4 pages and test suite. */
const GENERIC = { accessKeyId: "AKIDEXAMPLE", secret: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
/** The example credentials of the S3 page "Signature calculations for the Authorization header". */
const S3 = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
const S3_SCOPE = { amzDate: "20130524T000000Z", region: "us-east-1", service: "s3" };
const S3_HOST = "examplebucket.s3.amazonaws.com";

describe("the signing key", () => {
  it("is the one of AWS's example of deriving a signing key (secret ...EXAMPLEKEY, 20120215, us-east-1, iam)", () => {
    expect(signingKey(GENERIC.secret, "20120215", "us-east-1", "iam").toString("hex")).toBe("f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d");
  });
});

describe("the Signature Version 4 test suite, get-vanilla", () => {
  const req = { method: "GET", path: "/", query: [], headers: { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z" }, payloadHash: EMPTY_SHA256 };
  const scope = { amzDate: "20150830T123600Z", region: "us-east-1", service: "service" };

  it("has the published canonical request", () => {
    expect(canonicalRequest(req)).toBe(["GET", "/", "", "host:example.amazonaws.com", "x-amz-date:20150830T123600Z", "", "host;x-amz-date", EMPTY_SHA256].join("\n"));
    expect(sha256Hex(canonicalRequest(req))).toBe("bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63");
  });

  it("has the published string to sign", () => {
    expect(stringToSign(canonicalRequest(req), scope)).toBe(
      ["AWS4-HMAC-SHA256", "20150830T123600Z", "20150830/us-east-1/service/aws4_request", "bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63"].join("\n"),
    );
  });

  it("has the published signature and Authorization header", () => {
    const signed = sign(req, scope, GENERIC);
    expect(signed.signature).toBe("5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
    expect(signed.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });
});

describe("AWS's generic example, IAM ListUsers (the pages on creating a signed request)", () => {
  const req = {
    method: "GET",
    path: "/",
    query: [["Version", "2010-05-08"], ["Action", "ListUsers"]] as const,
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8", Host: "iam.amazonaws.com", "X-Amz-Date": "20150830T123600Z" },
    payloadHash: EMPTY_SHA256,
  };

  it("has the published hash of the canonical request, with the query sorted and the names in lower case", () => {
    expect(canonicalQuery(req.query)).toBe("Action=ListUsers&Version=2010-05-08");
    expect(sha256Hex(canonicalRequest(req))).toBe("f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59");
  });

  it("has the published signature", () => {
    expect(sign(req, { amzDate: "20150830T123600Z", region: "us-east-1", service: "iam" }, GENERIC).signature).toBe("5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7");
  });
});

describe("the S3 examples of signing with the Authorization header", () => {
  it("GET Object (test.txt, with a Range header): the published canonical request hash and signature", () => {
    const req = { method: "GET", path: "/test.txt", query: [], headers: { host: S3_HOST, range: "bytes=0-9", "x-amz-content-sha256": EMPTY_SHA256, "x-amz-date": S3_SCOPE.amzDate }, payloadHash: EMPTY_SHA256 };
    expect(sha256Hex(canonicalRequest(req))).toBe("7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972");
    const signed = sign(req, S3_SCOPE, S3);
    expect(signed.signature).toBe("f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    expect(signed.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("PUT Object (test$file.text, \"Welcome to Amazon S3.\"): the published payload hash, the path encoded once, and the signature", () => {
    const payload = "Welcome to Amazon S3.";
    expect(sha256Hex(payload)).toBe("44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
    const req = {
      method: "PUT",
      path: "/test$file.text",
      query: [],
      headers: { date: "Fri, 24 May 2013 00:00:00 GMT", host: S3_HOST, "x-amz-content-sha256": sha256Hex(payload), "x-amz-date": S3_SCOPE.amzDate, "x-amz-storage-class": "REDUCED_REDUNDANCY" },
      payloadHash: sha256Hex(payload),
    };
    expect(canonicalRequest(req).split("\n")[1]).toBe("/test%24file.text");
    expect(sign(req, S3_SCOPE, S3).signature).toBe("98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
  });

  it("GET Bucket Lifecycle (?lifecycle, a name without a value): the published signature", () => {
    const req = { method: "GET", path: "/", query: [["lifecycle", ""]] as const, headers: { host: S3_HOST, "x-amz-content-sha256": EMPTY_SHA256, "x-amz-date": S3_SCOPE.amzDate }, payloadHash: EMPTY_SHA256 };
    expect(canonicalRequest(req).split("\n")[2]).toBe("lifecycle=");
    expect(sign(req, S3_SCOPE, S3).signature).toBe("fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543");
  });

  it("Get Bucket, list objects (?max-keys=2&prefix=J): the published signature", () => {
    const req = { method: "GET", path: "/", query: [["prefix", "J"], ["max-keys", "2"]] as const, headers: { host: S3_HOST, "x-amz-content-sha256": EMPTY_SHA256, "x-amz-date": S3_SCOPE.amzDate }, payloadHash: EMPTY_SHA256 };
    expect(sign(req, S3_SCOPE, S3).signature).toBe("34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
  });
});

describe("the parts of the signer", () => {
  it("encodes every byte outside the unreserved set, keeping slashes in a path only", () => {
    expect(uriEncode("a-b_c.d~e/f g+h*%=&é", true)).toBe("a-b_c.d~e/f%20g%2Bh%2A%25%3D%26%C3%A9");
    expect(uriEncode("a/b", false)).toBe("a%2Fb");
  });

  it("sorts the query by name, then by value, and gives a name without a value an empty one", () => {
    expect(canonicalQuery([["b", "2"], ["a", "z"], ["a", "y"], ["delete", ""]])).toBe("a=y&a=z&b=2&delete=");
    expect(canonicalQuery([["continuation-token", "1/x+y="]])).toBe("continuation-token=1%2Fx%2By%3D");
  });

  it("trims header values and collapses inner runs of spaces", () => {
    const req = { method: "get", path: "/", query: [], headers: { "X-Amz-Date": "20150830T123600Z", Host: "  example.amazonaws.com ", "My-Header": "a   b  c" }, payloadHash: EMPTY_SHA256 };
    expect(canonicalRequest(req)).toBe(["GET", "/", "", "host:example.amazonaws.com", "my-header:a b c", "x-amz-date:20150830T123600Z", "", "host;my-header;x-amz-date", EMPTY_SHA256].join("\n"));
  });

  it("writes x-amz-date in UTC without separators or milliseconds", () => {
    expect(amzDate(Date.UTC(2015, 7, 30, 12, 36, 0, 789))).toBe("20150830T123600Z");
  });

  it("never puts the secret in what it returns", () => {
    const signed = sign({ method: "GET", path: "/", query: [], headers: { host: "h" }, payloadHash: EMPTY_SHA256 }, S3_SCOPE, S3);
    expect(JSON.stringify(signed)).not.toContain(S3.secret);
  });
});
