// Small helpers the API routes share: JSON answers and reading a request body with a
// hard byte cap.

const API_HEADERS: Record<string, string> = {
  "content-type": "application/json",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

/** A JSON answer. Never put a request header, a token or a stored secret in `body`. */
export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: API_HEADERS });
}

/** `{"error":"<code>","detail":"<text>"}`. The detail is fixed text or a field path, never request content. */
export function apiError(status: number, error: string, detail: string): Response {
  return json(status, { error, detail });
}

export function noContent(): Response {
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

/**
 * The request body's bytes, or "too_large" as soon as more than `max` bytes would be
 * read. A declared Content-Length over the cap is refused before reading anything; a
 * body without one is read only until it passes the cap, and the rest of the stream is
 * cancelled, so a hostile client can never make the server hold more than `max` bytes.
 */
export async function readCapped(req: Request, max: number): Promise<Uint8Array | "too_large"> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > max) {
    await req.body?.cancel().catch(() => {});
    return "too_large";
  }
  if (req.body === null) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return "too_large";
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
