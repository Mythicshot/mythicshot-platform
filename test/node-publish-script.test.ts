import { describe, expect, it } from "vitest";
import { makeDeps, seedWorkspace } from "#harness";
import { createApp } from "../src/app.ts";
import { checkServer, runPublish, type Io } from "../scripts/publish.ts";
import { fixtures, uploadTour, type Json } from "./bundle.ts";

async function setup() {
  const ctx = await makeDeps();
  const a = await seedWorkspace(ctx.deps, "A");
  const t = await uploadTour(ctx.deps, a.token, fixtures.v2 as Json);
  const app = createApp(ctx.deps);
  const seen: { url: string; auth: string | null }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const io = (env: Record<string, string | undefined>, prompted = ""): Io => ({
    env,
    prompt: async () => prompted,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      seen.push({ url: req.url, auth: req.headers.get("authorization") });
      return app.fetch(req);
    }) as typeof fetch,
  });
  return { ...ctx, a, t, io, seen, out, err };
}

describe("the publish script", () => {
  it("publishes and unpublishes with the token from the environment", async () => {
    const s = await setup();
    expect(await runPublish(["https://tours.example.com/", s.t.tour_id], s.io({ DEMO_PLATFORM_TOKEN: s.a.token }))).toBe(0);
    expect(s.seen[0]).toEqual({ url: `https://tours.example.com/api/v1/tours/${s.t.tour_id}/publish`, auth: "Bearer " + s.a.token });
    expect(s.out[0]).toMatch(/^Published 3 steps: https:\/\/tours\.example\.com\/t\/[a-z2-7]{10}$/);
    expect(await s.deps.db.first("SELECT status FROM tour")).toEqual({ status: "published" });
    expect(await runPublish(["https://tours.example.com", s.t.tour_id, "--unpublish"], s.io({ DEMO_PLATFORM_TOKEN: s.a.token }))).toBe(0);
    expect(s.out[1]).toBe(`Unpublished ${s.t.tour_id}.`);
    expect(await s.deps.db.first("SELECT status FROM tour")).toEqual({ status: "draft" });
    expect(await s.publicKeys()).toEqual([]);
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
