// "Download all my data": a plan that fails after the ticket was claimed releases the
// workspace's download row at once and answers the refusal page, so the next ask is not held
// up for RUNNING_MS. The failure is made by replacing the publish's buildSnapshot for this
// file only (vi.mock), which only the download's plan calls here; Node only, where vi.mock of a
// source module is plain.
import { describe, expect, it, vi } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { EXPORT_PATH, FAILURE_SENTENCE, exportInProgress } from "../src/export.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import { ORIGIN, fixtures, send, uploadTour, type Json } from "./bundle.ts";

vi.mock("../src/publish.ts", async (original) => ({
  ...(await original<typeof import("../src/publish.ts")>()),
  buildSnapshot: () => {
    throw new Error("a plan that cannot be made");
  },
}));

describe("Download all my data: a plan that fails", () => {
  it("releases the row and answers the refusal page, and the workspace may ask again at once", async () => {
    const { deps } = await makeDeps();
    await seedAccount(deps, { admin: true });
    const a = await seedAccount(deps);
    const made = await redeemSignInCode(deps, await createSignInCode(deps, a.userId), null, null);
    const cookie = `${SESSION_COOKIE}=${made!.secret}`;
    const page = { cookie, "x-csrf-token": await csrfFor(made!.secret), origin: ORIGIN, "sec-fetch-site": "same-origin" };
    await uploadTour(deps, a.token, fixtures.v3 as Json);
    const asked = await send(deps, "POST", EXPORT_PATH, { headers: page });
    expect(asked.status).toBe(200);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const file = await send(deps, "GET", asked.json.url, { headers: { cookie } });
    expect([file.status, file.text, file.headers.get("content-type"), file.headers.get("content-disposition")]).toEqual([500, FAILURE_SENTENCE, "text/plain; charset=utf-8", null]);
    expect(errors.mock.calls.map((c) => c[0])).toEqual(["export: a download could not be planned; nothing was sent"]);
    errors.mockRestore();
    expect(await exportInProgress(deps, a.workspaceId, deps.now())).toBe(false);
    expect((await send(deps, "POST", EXPORT_PATH, { headers: page })).status).toBe(200);
  });
});
