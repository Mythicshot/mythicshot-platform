/// <reference types="vite/client" />
// The client address of a request, the mailer and the deferred work every route reaches
// through `deps`, and what the Cloudflare entry gives each. Nothing here sends a mail or
// opens a connection: the mailer is the fake one or the one that is off.
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDeps } from "#harness";
import { clientAddressOf, setClientAddress } from "../src/client.ts";
import type { Hosts } from "../src/hosts.ts";
import { linkOrigin, MailOff, NO_MAIL, type Mail } from "../src/mail.ts";
import { DEFER_FAILED, deferOf, deferTracker, mailOf, type Deps } from "../src/ports.ts";
import { FakeMailer } from "./fake-mail.ts";

type Entry = {
  depsFromEnv(env: Record<string, unknown>, hosts: Hosts | null, storageAllowanceBytes?: number | null, ctx?: { waitUntil(work: Promise<unknown>): void }): Deps;
  default: { fetch(request: Request, env: Record<string, unknown>, ctx: unknown): Response | Promise<Response> };
};

// src/cloudflare is outside the Node type check (it uses the Workers types), so the
// module is loaded through a glob and given its shape here. It runs under both configs.
const load = import.meta.glob("../src/cloudflare/entry.ts");
const entry = (await load["../src/cloudflare/entry.ts"]()) as Entry;

/** Stand-ins for the bindings: any use of one fails the request. */
const untouched = (name: string) =>
  new Proxy(
    {},
    {
      get() {
        throw new Error(`the ${name} binding was used`);
      },
    },
  );
const bindings = () => ({ DB: untouched("DB"), DRAFTS: untouched("DRAFTS"), PUB: untouched("PUB"), PUBLIC_IMAGE_BASE: "" });

const MAIL: Mail = { to: "someone@example.com", subject: "A subject", text: "A text\n" };
/** A full mail block, as a Node install would write it. The Cloudflare target reads none of it. */
const MAIL_BLOCK = { MAIL_MODE: "smtp", MAIL_FROM: "no-reply@example.com", SMTP_HOST: "mail.example.com", SMTP_PORT: "465", SMTP_USER: "no-reply@example.com", SMTP_PASSWORD: "made-up-password" };

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the client address of a request", () => {
  it("a request without a set address has none", () => {
    const req = new Request("https://app.example.com/healthz", { headers: { "x-forwarded-for": "203.0.113.7", "cf-connecting-ip": "203.0.113.8", "x-real-ip": "203.0.113.9" } });
    // Core reads no header: only what an entry set counts.
    expect(clientAddressOf(req)).toBeNull();
    expect(clientAddressOf(req.clone())).toBeNull();
  });

  it("the address an entry set is the one read, for that request only", () => {
    const one = new Request("https://app.example.com/healthz");
    const two = new Request("https://app.example.com/healthz");
    setClientAddress(one, "203.0.113.7");
    expect(clientAddressOf(one)).toBe("203.0.113.7");
    expect(clientAddressOf(two)).toBeNull();
    // A copy of the request is another request.
    expect(clientAddressOf(one.clone())).toBeNull();
    setClientAddress(two, "2001:db8::1");
    expect(clientAddressOf(two)).toBe("2001:db8::1");
    // Set again: the last one stands. Null, empty or not text: none.
    setClientAddress(one, "203.0.113.99");
    expect(clientAddressOf(one)).toBe("203.0.113.99");
    for (const none of [null, "", "   ", undefined, 7] as unknown as (string | null)[]) {
      setClientAddress(one, none);
      expect(clientAddressOf(one), String(none)).toBeNull();
    }
    // Outer spaces are dropped, and something far too long to be an address is none.
    setClientAddress(one, "  203.0.113.7 ");
    expect(clientAddressOf(one)).toBe("203.0.113.7");
    setClientAddress(one, "1".repeat(101));
    expect(clientAddressOf(one)).toBeNull();
  });

  it("on Workers the address is the connecting one and mail is off", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // A route that answers without a binding: no credential, so 401 before anything is read.
    const req = new Request("https://app.example.com/api/v1/me", { headers: { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1, 198.51.100.2", "x-real-ip": "198.51.100.3" } });
    const res = await entry.default.fetch(req, { ...bindings(), ...MAIL_BLOCK }, {});
    expect(res.status).toBe(401);
    expect(clientAddressOf(req)).toBe("203.0.113.7");
    // Without the header there is no address, whatever other headers say.
    const bare = new Request("https://app.example.com/api/v1/me", { headers: { "x-forwarded-for": "198.51.100.1", "x-real-ip": "198.51.100.3" } });
    expect((await entry.default.fetch(bare, { ...bindings(), ...MAIL_BLOCK }, {})).status).toBe(401);
    expect(clientAddressOf(bare)).toBeNull();

    // Mail is off on this target in this phase, also with a full mail block in the vars.
    for (const env of [bindings(), { ...bindings(), ...MAIL_BLOCK }, { ...bindings(), ...MAIL_BLOCK, SITE_HOST: "tours.example.com" }]) {
      const deps = entry.depsFromEnv(env, null);
      expect(deps.mail).toBeUndefined();
      expect(mailOf(deps)).toBe(NO_MAIL);
      await expect(mailOf(deps).send(MAIL)).rejects.toBeInstanceOf(MailOff);
    }
    // The answer says nothing about mail, and nothing was logged.
    expect(await res.text()).toBe('{"error":"unauthorized"}');
    expect(errors).not.toHaveBeenCalled();
  });

  it("on Workers SITE_HOST is the link host of a one-address install, and is ignored with two addresses", () => {
    const hosts = { tours: "tours.example.com", app: "app.example.com" };
    expect(entry.depsFromEnv({ ...bindings(), SITE_HOST: " Tours.Example.com. " }, null).config).toEqual({ publicImageBase: "", setupCode: null, hosts: null, siteHost: "tours.example.com" });
    expect(linkOrigin(entry.depsFromEnv({ ...bindings(), SITE_HOST: "tours.example.com" }, null).config)).toBe("https://tours.example.com");
    expect(Object.keys(entry.depsFromEnv({ ...bindings(), SITE_HOST: "site.example.com" }, hosts).config).sort()).toEqual(["hosts", "publicImageBase", "setupCode"]);
    expect(linkOrigin(entry.depsFromEnv({ ...bindings(), SITE_HOST: "site.example.com" }, hosts).config)).toBe("https://app.example.com");
    // Unset, empty, not a host name or not text: no link host, and the config is as before.
    for (const value of [undefined, "", "  ", "https://made-up.example.com", "made-up.example.com/path", 7, { name: "made-up" }]) {
      const config = entry.depsFromEnv({ ...bindings(), SITE_HOST: value }, null).config;
      expect(Object.keys(config).sort(), String(value)).toEqual(["hosts", "publicImageBase", "setupCode"]);
      expect(linkOrigin(config), String(value)).toBeNull();
    }
  });

  it("on Workers deferred work is handed to the runtime, and its failure is one fixed line", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const handed: Promise<unknown>[] = [];
    const deps = entry.depsFromEnv(bindings(), null, null, { waitUntil: (work) => void handed.push(work) });
    deferOf(deps)(Promise.resolve("done"));
    deferOf(deps)(Promise.reject(new Error("made-up-secret")));
    expect(handed.length).toBe(2);
    // What the runtime waits for never rejects.
    await expect(Promise.all(handed)).resolves.toBeDefined();
    expect(errors.mock.calls).toEqual([[DEFER_FAILED]]);
    // Without a context there is nothing to hand to: the default takes over.
    expect(entry.depsFromEnv(bindings(), null).defer).toBeUndefined();
  });
});

describe("the mailer and the deferred work of deps", () => {
  it("without a mailer, mail is off; with one, that one is used", async () => {
    const { deps, mail } = await makeDeps();
    // The harness hands every test the fake mailer.
    expect(mail).toBeInstanceOf(FakeMailer);
    expect(mailOf(deps)).toBe(mail);
    await mailOf(deps).send(MAIL);
    expect(mail.sent).toEqual([MAIL]);
    const bare: Deps = { db: deps.db, drafts: deps.drafts, pub: deps.pub, config: deps.config, now: deps.now };
    expect(mailOf(bare)).toBe(NO_MAIL);
    await expect(mailOf(bare).send(MAIL)).rejects.toBeInstanceOf(MailOff);
    expect(mail.sent.length).toBe(1);
  });

  it("the harness awaits deferred work in settle", async () => {
    const h = await makeDeps();
    let done = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    deferOf(h.deps)(gate.then(() => void done++));
    // Work that defers more work is awaited too.
    deferOf(h.deps)(
      (async () => {
        await gate;
        deferOf(h.deps)(tick().then(() => void done++));
      })(),
    );
    await tick();
    expect(done).toBe(0);
    const settled = h.settle();
    release();
    await settled;
    expect(done).toBe(2);
    // With nothing open it resolves at once.
    await h.settle();
  });

  it("deferred work is awaited on stop and its failure is one fixed line", async () => {
    const lines: string[] = [];
    const background = deferTracker(() => lines.push(DEFER_FAILED));
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    background.defer(gate.then(() => void order.push("slow work")));
    background.defer(Promise.reject(new Error("made-up-secret dp_" + "a".repeat(40))));
    background.defer(Promise.resolve("quick"));
    let stopped = false;
    const stop = background.settle().then(() => {
      stopped = true;
      order.push("stopped");
    });
    await tick();
    // The stop waits for the work that is still open.
    expect(stopped).toBe(false);
    release();
    await stop;
    expect(order).toEqual(["slow work", "stopped"]);
    // One line for the one failure, fixed: nothing of the error is in it.
    expect(lines).toEqual([DEFER_FAILED]);
    expect(DEFER_FAILED).toBe("background: work after an answer failed");
    // A failure handler that throws does not break the tracker or leave a rejection behind.
    const fragile = deferTracker(() => {
      throw new Error("the handler failed");
    });
    fragile.defer(Promise.reject(new Error("first")));
    await fragile.settle();
    // What is not a promise is taken as done.
    fragile.defer("not a promise" as unknown as Promise<unknown>);
    await fragile.settle();
  });

  it("without a defer of its own, deferred work still runs and its failure is the fixed line", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = await makeDeps();
    const bare: Deps = { db: deps.db, drafts: deps.drafts, pub: deps.pub, config: deps.config, now: deps.now };
    let done = false;
    deferOf(bare)(tick().then(() => void (done = true)));
    deferOf(bare)(Promise.reject(new Error("made-up-secret")));
    await tick();
    await tick();
    expect(done).toBe(true);
    expect(errors.mock.calls).toEqual([[DEFER_FAILED]]);
  });
});
