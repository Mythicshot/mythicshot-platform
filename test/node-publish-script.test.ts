import { describe, expect, it } from "vitest";
import { makeDeps, seedWorkspace } from "#harness";
import { createApp } from "../src/app.ts";
import { checkServer, runPublish, type Io } from "../scripts/publish.ts";
import { clone, fixtures, uploadTour, type Json } from "./bundle.ts";

async function setup(manifest: Json = fixtures.v2 as Json) {
  const ctx = await makeDeps();
  const a = await seedWorkspace(ctx.deps, "A");
  const t = await uploadTour(ctx.deps, a.token, manifest);
  const app = createApp(ctx.deps);
  const seen: { url: string; auth: string | null; body: string }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const pauses: number[] = [];
  /** Lets a test step in before a call reaches the server: return a Response to answer it instead. */
  let before: ((n: number) => Promise<Response | void>) | null = null;
  const io = (env: Record<string, string | undefined>, prompted = ""): Io => ({
    env,
    prompt: async () => prompted,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      const body = await req.clone().text();
      seen.push({ url: req.url, auth: req.headers.get("authorization"), body });
      const instead = before ? await before(seen.length) : undefined;
      return instead ?? app.fetch(req);
    }) as typeof fetch,
    sleep: async (ms) => {
      pauses.push(ms);
    },
  });
  return { ...ctx, a, t, io, seen, out, err, pauses, intercept: (f: typeof before) => (before = f) };
}

/** A manifest of `n` small steps. */
function manySteps(n: number): Json {
  const m = clone(fixtures.v2 as Json);
  const base = m.steps[1];
  m.steps = Array.from({ length: n }, (_, i) => ({ ...clone(base), image: `step-${String(i + 1).padStart(3, "0")}.png`, width: 64, height: 64, bytes: 120 }));
  return m;
}

describe("the publish script", () => {
  it("publishes and unpublishes with the token from the environment", async () => {
    const s = await setup();
    expect(await runPublish(["https://tours.example.com/", s.t.tour_id], s.io({ DEMO_PLATFORM_TOKEN: s.a.token }))).toBe(0);
    expect(s.seen[0]).toMatchObject({ url: `https://tours.example.com/api/v1/tours/${s.t.tour_id}/publish`, auth: "Bearer " + s.a.token });
    expect(s.out[0]).toMatch(/^Published 3 steps: https:\/\/tours\.example\.com\/t\/[a-z2-7]{10}$/);
    expect(await s.deps.db.first("SELECT status FROM tour")).toEqual({ status: "published" });
    expect(await runPublish(["https://tours.example.com", s.t.tour_id, "--unpublish"], s.io({ DEMO_PLATFORM_TOKEN: s.a.token }))).toBe(0);
    expect(s.out[1]).toBe(`Unpublished ${s.t.tour_id}.`);
    expect(await s.deps.db.first("SELECT status FROM tour")).toEqual({ status: "draft" });
    expect(await s.publicKeys()).toEqual([]);
  });

  it("publishes a large tour over several calls, naming the publish and showing progress", async () => {
    const s = await setup(manySteps(30));
    expect(await runPublish(["https://tours.example.com", s.t.tour_id], s.io({ DEMO_PLATFORM_TOKEN: s.a.token }))).toBe(0);
    expect(s.out).toEqual(["Copying images: 12 of 30 done", "Copying images: 24 of 30 done", expect.stringMatching(/^Published 30 steps: https:\/\/tours\.example\.com\/t\/[a-z2-7]{10}$/)]);
    expect(s.seen).toHaveLength(3);
    expect(s.seen[0].body).toBe("");
    const id = JSON.parse(s.seen[1].body).publish_id;
    expect(id).toMatch(/^pub_[0-9a-f]{24}$/);
    expect(JSON.parse(s.seen[2].body)).toEqual({ publish_id: id });
    for (const call of s.seen) expect(call.auth).toBe("Bearer " + s.a.token);
    expect(s.pauses).toEqual([250, 250]);
    expect(await s.deps.db.first("SELECT status FROM tour")).toEqual({ status: "published" });
    for (const line of [...s.out, ...s.err]) expect(line).not.toContain(s.a.token.slice(3));
  });

  it("an interrupted publish continues where it stopped when the command is run again", async () => {
    const s = await setup(manySteps(30));
    s.intercept(async (n) => {
      if (n === 2) throw new Error("connection reset");
    });
    expect(await runPublish(["https://tours.example.com", s.t.tour_id], s.io({ DEMO_PLATFORM_TOKEN: s.a.token }))).toBe(1);
    expect(s.err.at(-1)).toContain("Run the same command again");
    s.intercept(null);
    s.out.length = 0;
    expect(await runPublish(["https://tours.example.com", s.t.tour_id], s.io({ DEMO_PLATFORM_TOKEN: s.a.token }))).toBe(0);
    // The second run joined the publish in progress: 12 were already copied.
    expect(s.out[0]).toBe("Copying images: 24 of 30 done");
    expect(s.out.at(-1)).toMatch(/^Published 30 steps/);
  });

  it("stops with a clear message when the server stops making progress", async () => {
    const s = await setup(manySteps(30));
    const stuck = () => new Response(JSON.stringify({ status: "in_progress", publish_id: "pub_" + "1".repeat(24), done: 12, total: 30 }), { status: 202 });
    s.intercept(async () => stuck());
    expect(await runPublish(["https://tours.example.com", s.t.tour_id], s.io({ DEMO_PLATFORM_TOKEN: s.a.token }))).toBe(1);
    expect(s.seen).toHaveLength(4);
    expect(s.err.at(-1)).toBe("The server stopped making progress (12 of 30 after 4 calls). Run the same command again later to continue.");
  });

  it("reports a publish that was cancelled half-way", async () => {
    const s = await setup(manySteps(30));
    s.intercept(async (n) => {
      if (n === 2) await s.deps.db.run("UPDATE public_object SET state = 'retired', delete_after = 0 WHERE state = 'pending'");
    });
    expect(await runPublish(["https://tours.example.com", s.t.tour_id], s.io({ DEMO_PLATFORM_TOKEN: s.a.token }))).toBe(1);
    expect(s.err.at(-1)).toMatch(/^publish failed with HTTP 409 \(publish_cancelled\)/);
  });

  it("asks for the token when the environment has none", async () => {
    const s = await setup();
    expect(await runPublish(["http://localhost:3000", s.t.tour_id], s.io({}, s.a.token + "\n"))).toBe(0);
    expect(s.seen[0].auth).toBe("Bearer " + s.a.token);
  });

  it("refuses a token passed as an argument without repeating it", async () => {
    const s = await setup();
    expect(await runPublish(["https://tours.example.com", s.t.tour_id, s.a.token], s.io({ DEMO_PLATFORM_TOKEN: s.a.token }))).toBe(2);
    expect(s.seen).toEqual([]);
    expect(s.err.join("\n")).toContain("process list");
  });

  it("never prints the token, whatever goes wrong", async () => {
    const s = await setup();
    const wrong = "dp_" + "e".repeat(40);
    expect(await runPublish(["https://tours.example.com", s.t.tour_id], s.io({ DEMO_PLATFORM_TOKEN: wrong }))).toBe(1);
    expect(await runPublish(["https://tours.example.com", "tour_" + "0".repeat(24)], s.io({ DEMO_PLATFORM_TOKEN: s.a.token }))).toBe(1);
    expect(await runPublish(["https://tours.example.com", s.t.tour_id], s.io({ DEMO_PLATFORM_TOKEN: "not-a-token" }))).toBe(2);
    expect(s.err.join("\n")).toContain("rejected the API token");
    expect(s.err.join("\n")).toContain("HTTP 404 (not_found)");
    for (const line of [...s.out, ...s.err]) {
      expect(line).not.toContain(s.a.token.slice(3));
      expect(line).not.toContain(wrong.slice(3));
    }
  });

  it("refuses plain http to another machine and bad arguments", async () => {
    expect(checkServer("http://tours.example.com")).toBeNull();
    expect(checkServer("https://user:pw@tours.example.com")).toBeNull();
    expect(checkServer("https://tours.example.com/base/")).toBe("https://tours.example.com/base");
    expect(checkServer("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    const s = await setup();
    const env = { DEMO_PLATFORM_TOKEN: s.a.token };
    expect(await runPublish(["http://tours.example.com", s.t.tour_id], s.io(env))).toBe(2);
    expect(await runPublish(["https://tours.example.com"], s.io(env))).toBe(2);
    expect(await runPublish(["https://tours.example.com", "../x"], s.io(env))).toBe(2);
    expect(s.seen).toEqual([]);
  });
});
