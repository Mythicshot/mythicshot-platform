// The worker mailer (src/node/mail-thread.ts and src/node/mail-worker.ts): mail sent from
// a worker thread. The real worker runs against a fake mail server this file starts on
// 127.0.0.1; a stand-in worker, written to a scratch folder, plays the failures a real
// server cannot be made to play on cue (a crash, a hang, a slow send). No real mail server
// is ever contacted and no name is looked up.
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import * as tls from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { signInMail, type Mail } from "../src/mail.ts";
import { deferTracker } from "../src/ports.ts";
import {
  answerFor,
  failureOf,
  MAIL_QUEUE_MAX,
  MAIL_QUEUE_WAIT_MS,
  MAIL_WORKER_GRACE_MS,
  MAIL_WORKER_STARTS_PER_MINUTE,
  MAIL_WORKER_URL,
  workerMailer,
  type ClosableMailer,
} from "../src/node/mail-thread.ts";
import { SMTP_LIMITS, SmtpError, smtpMailer, type SmtpReason, type SmtpSettings } from "../src/node/smtp.ts";
import { STOP_DEADLINE_MS, stopSequence } from "../src/node/stop.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PASSWORD = "pw-W0rker/S3cret+chars=";
const USER = "no-reply@example.com";
const SETTINGS: SmtpSettings = { host: "127.0.0.1", port: 465, user: USER, password: PASSWORD, from: "no-reply@example.com", helo: "app.example.com" };
const CODE = "dpl_" + "fedcba9876543210".repeat(2) + "76543210";
const LINK = `https://app.example.com/signin/link#c=${CODE}`;
const MAIL = signInMail("ada@example.com", LINK, "Mythicshot");
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const PLAIN_TOKEN = b64(`\0${USER}\0${PASSWORD}`);
const SECRETS = [PASSWORD, b64(PASSWORD), PLAIN_TOKEN];

const outcome = (work: Promise<void>): Promise<unknown> =>
  work.then(
    () => "sent",
    (e: unknown) => e,
  );

/** The reason and yes or no of a failure, and proof that it is the client's own error with no secret and nothing else in it. */
function failure(value: unknown, alsoAbsent: string[] = []): [string, boolean] {
  expect(value).toBeInstanceOf(SmtpError);
  const error = value as SmtpError;
  expect(error.name).toBe("SmtpError");
  expect(error.message).toBe(`smtp: ${error.reason}`);
  expect(error.cause).toBeUndefined();
  const seen = [error.message, String(error.stack), JSON.stringify(error), inspect(error, { depth: 6, showHidden: true })].join("\n");
  for (const secret of [...SECRETS, ...alsoAbsent]) expect(seen).not.toContain(secret);
  return [error.reason, error.bodyWritten];
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await pause(5);
  expect(check()).toBe(true);
}

// ---------------------------------------------------------------------------------
// Scratch folder: stand-in workers, the trusted certificate, a log of what was sent.
// ---------------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), "mail-thread-test-"));
const THREAD_URL = pathToFileURL(join(ROOT, "src", "node", "mail-thread.ts")).href;
const SMTP_URL = pathToFileURL(join(ROOT, "src", "node", "smtp.ts")).href;
let wrappers = 0;

/** A stand-in worker: serveMail from the real module over a mailer that acts on the subject. Each subject it is given is logged. */
function fakeWorker(): { url: URL; sent: () => string[] } {
  wrappers += 1;
  const log = join(scratch, `sent-${wrappers}.log`);
  writeFileSync(log, "");
  const file = join(scratch, `fake-worker-${wrappers}.mjs`);
  writeFileSync(
    file,
    `import { appendFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { serveMail } from ${JSON.stringify(THREAD_URL)};
import { SmtpError } from ${JSON.stringify(SMTP_URL)};
const burn = (ms) => { const end = Date.now() + ms; while (Date.now() < end); };
serveMail(parentPort, {
  async send(mail) {
    appendFileSync(${JSON.stringify(log)}, mail.subject + "\\n");
    const [what, a, b] = mail.subject.split(" ");
    const secret = workerData.settings.password;
    if (what === "ok") return;
    if (what === "fail") throw new SmtpError(a, b === "1");
    if (what === "leak") throw new Error("the server said no to " + secret);
    if (what === "odd") throw Object.assign(new SmtpError("auth"), { reason: "made-up " + secret });
    if (what === "crash") { setTimeout(() => { throw new Error("crashed holding " + secret); }); return new Promise(() => {}); }
    if (what === "exit") process.exit(3);
    if (what === "hang") return new Promise(() => {});
    if (what === "burn") { burn(Number(a)); return; }
    if (what === "slow") return new Promise((done) => setTimeout(done, Number(a)));
    if (what === "print") { console.log("out " + secret); console.error("err " + secret); process.stdout.write("raw " + secret); return; }
    throw new Error("unknown " + secret);
  },
});
`,
  );
  return { url: pathToFileURL(file), sent: () => readFileSync(log, "utf8").split("\n").filter((l) => l !== "") };
}

/** The real worker, in a thread that trusts `cert` as well (the trust of a thread is its own). */
function trustingWorker(cert: string): URL {
  wrappers += 1;
  const file = join(scratch, `trusting-worker-${wrappers}.mjs`);
  writeFileSync(
    file,
    `import * as tls from "node:tls";
tls.setDefaultCACertificates([...tls.getCACertificates("default"), ${JSON.stringify(cert)}]);
await import(${JSON.stringify(MAIL_WORKER_URL.href)});
`,
  );
  return pathToFileURL(file);
}

const mail = (subject: string): Mail => ({ to: "ada@example.com", subject, text: "x\n" });

const made: ClosableMailer[] = [];
function mailer(url: URL, options: Parameters<typeof workerMailer>[1] = {}, settings: SmtpSettings = SETTINGS): ClosableMailer {
  const m = workerMailer(settings, { workerUrl: url, ...options });
  made.push(m);
  return m;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(made.splice(0).map((m) => m.close()));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------
// A fake mail server over TLS on 127.0.0.1, with a certificate made here.
// ---------------------------------------------------------------------------------

type Step = "greeting" | "ehlo" | "auth" | "mail" | "rcpt" | "data" | "body" | "quit";
type Script = Partial<Record<Step, string | null>>;

class Session {
  readonly commands: string[] = [];
  readonly bodies: string[] = [];
  raw = "";
  private pending = "";
  private inData = false;
  constructor(
    private readonly script: Script,
    private readonly out: (text: string) => void,
    private readonly hangUp: () => void,
  ) {}
  start(): void {
    this.say("greeting", "220 mail.test ESMTP ready");
  }
  private say(step: Step, usual: string): void {
    const text = step in this.script ? this.script[step] : usual;
    if (text === null || text === undefined) return;
    this.out(text + "\r\n");
  }
  feed(text: string): void {
    this.raw += text;
    this.pending += text;
    for (;;) {
      if (this.inData) {
        const end = this.pending.indexOf("\r\n.\r\n");
        if (end < 0) return;
        this.bodies.push(this.pending.slice(0, end + 2));
        this.pending = this.pending.slice(end + 5);
        this.inData = false;
        this.say("body", "250 2.0.0 queued");
        continue;
      }
      const end = this.pending.indexOf("\r\n");
      if (end < 0) return;
      const line = this.pending.slice(0, end);
      this.pending = this.pending.slice(end + 2);
      this.commands.push(line);
      const verb = line.toUpperCase();
      if (verb.startsWith("EHLO ")) this.say("ehlo", "250-mail.test\r\n250 AUTH PLAIN LOGIN");
      else if (verb.startsWith("AUTH PLAIN ")) this.say("auth", "235 2.7.0 accepted");
      else if (verb.startsWith("MAIL FROM:")) this.say("mail", "250 2.1.0 ok");
      else if (verb.startsWith("RCPT TO:")) this.say("rcpt", "250 2.1.5 ok");
      else if (verb === "DATA") {
        this.inData = true;
        this.say("data", "354 end with a dot");
      } else if (verb === "QUIT") {
        this.say("quit", "221 2.0.0 bye");
        this.hangUp();
      } else this.out("500 what\r\n");
    }
  }
}

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  if (body.length < 0x80) return Buffer.concat([Buffer.from([tag, body.length]), body]);
  const size: number[] = [];
  for (let n = body.length; n > 0; n = Math.floor(n / 256)) size.unshift(n % 256);
  return Buffer.concat([Buffer.from([tag, 0x80 | size.length, ...size]), body]);
}
function oid(dotted: string): Buffer {
  const arcs = dotted.split(".").map(Number);
  const bytes = [40 * arcs[0] + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const group = [arc & 0x7f];
    for (let n = arc >>> 7; n > 0; n >>>= 7) group.unshift((n & 0x7f) | 0x80);
    bytes.push(...group);
  }
  return der(0x06, Buffer.from(bytes));
}
const utcTime = (ms: number) => der(0x17, Buffer.from(new Date(ms).toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z", "ascii"));
/** A self-signed certificate for 127.0.0.1, test only, never written anywhere but the scratch folder. */
function testCertificate(): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const seq = (...parts: Buffer[]) => der(0x30, ...parts);
  const alg = seq(oid("1.2.840.10045.4.3.2"));
  const serial = randomBytes(8);
  const name = seq(der(0x31, seq(oid("2.5.4.3"), der(0x0c, Buffer.from(`test only ${serial.toString("hex")}`, "utf8")))));
  const now = Date.now();
  const ext = seq(seq(oid("2.5.29.19"), der(0x01, Buffer.from([0xff])), der(0x04, seq(der(0x01, Buffer.from([0xff]))))), seq(oid("2.5.29.17"), der(0x04, seq(der(0x87, Buffer.from([127, 0, 0, 1]))))));
  const tbs = seq(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.from([1, ...serial])), alg, name, seq(utcTime(now - 3_600_000), utcTime(now + 86_400_000)), name, publicKey.export({ type: "spki", format: "der" }), der(0xa3, ext));
  const cert = seq(tbs, alg, der(0x03, Buffer.from([0]), sign("sha256", tbs, privateKey)));
  return { key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), cert: `-----BEGIN CERTIFICATE-----\n${cert.toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----\n` };
}

const servers: Array<() => Promise<void>> = [];
async function fakeServer(pair: { key: string; cert: string }, script: Script = {}): Promise<{ port: number; sessions: Session[] }> {
  const sessions: Session[] = [];
  const sockets = new Set<net.Socket>();
  const server = tls.createServer({ key: pair.key, cert: pair.cert }, (socket) => {
    const session = new Session(script, (text) => void socket.write(text, "latin1"), () => socket.end());
    sessions.push(session);
    socket.on("data", (chunk: Buffer) => session.feed(chunk.toString("latin1")));
    socket.on("error", () => {});
    session.start();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("tlsClientError", () => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  );
  return { port: (server.address() as net.AddressInfo).port, sessions };
}

/** A port on 127.0.0.1 with nothing listening: the local end of a connection held open. */
async function deadPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const holder = net.createServer((s) => {
    sockets.add(s);
    s.on("error", () => {});
  });
  await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
  const client = net.connect({ host: "127.0.0.1", port: (holder.address() as net.AddressInfo).port });
  client.on("error", () => {});
  await new Promise<void>((resolve) => client.once("connect", () => resolve()));
  return {
    port: client.localPort as number,
    release: () =>
      new Promise<void>((resolve) => {
        client.destroy();
        for (const s of sockets) s.destroy();
        holder.close(() => resolve());
      }),
  };
}

/** A message as the server got it, with the two lines that differ on every send (the time and the random id) blanked. */
const steady = (raw: string) => raw.replace(/^Date: .*$/m, "Date: -").replace(/^Message-ID: <[^@]+@/m, "Message-ID: <-@");

// ---------------------------------------------------------------------------------

describe("the worker mailer with the real worker, fake server on 127.0.0.1", () => {
  const trusted = testCertificate();
  let defaults: string[] = [];
  let realWorker: URL;
  beforeAll(() => {
    // The direct client, in this thread, trusts the same certificate as the worker.
    defaults = tls.getCACertificates("default");
    tls.setDefaultCACertificates([...defaults, trusted.cert]);
    realWorker = trustingWorker(trusted.cert);
  });
  afterAll(() => tls.setDefaultCACertificates(defaults));
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((stop) => stop()));
  });

  it("delivers a mail through the worker with the same bytes on the wire as the direct client", async () => {
    const server = await fakeServer(trusted);
    const s = { ...SETTINGS, port: server.port };
    await smtpMailer(s).send(MAIL);
    const m = mailer(realWorker, {}, s);
    await m.send(MAIL);
    expect(server.sessions).toHaveLength(2);
    const [direct, threaded] = server.sessions;
    expect(threaded.commands).toEqual(["EHLO app.example.com", `AUTH PLAIN ${PLAIN_TOKEN}`, "MAIL FROM:<no-reply@example.com>", "RCPT TO:<ada@example.com>", "DATA", "QUIT"]);
    expect(threaded.bodies).toHaveLength(1);
    expect(steady(threaded.raw)).toBe(steady(direct.raw));
    expect(threaded.raw).toContain(LINK);
    expect(m.stats()).toMatchObject({ starts: 1, running: true, busy: false, queued: 0 });
    // A second mail uses the same worker, on a connection of its own.
    await m.send(MAIL);
    expect(server.sessions).toHaveLength(3);
    expect(m.stats().starts).toBe(1);
  });

  it("the client's own failures come back with the same reason and bodyWritten", async () => {
    const refusing = await fakeServer(trusted, { auth: "535 5.7.8 no such mailbox " + PASSWORD });
    expect(failure(await outcome(mailer(realWorker, {}, { ...SETTINGS, port: refusing.port }).send(MAIL)), ["no such mailbox"])).toEqual(["auth", false]);
    const afterBody = await fakeServer(trusted, { body: "554 5.6.0 message rejected, spam" });
    expect(failure(await outcome(mailer(realWorker, {}, { ...SETTINGS, port: afterBody.port }).send(MAIL)), ["spam"])).toEqual(["refused", true]);
    expect(afterBody.sessions[0].bodies).toHaveLength(1);
    const beforeBody = await fakeServer(trusted, { rcpt: "550 5.1.1 no such user" });
    expect(failure(await outcome(mailer(realWorker, {}, { ...SETTINGS, port: beforeBody.port }).send(MAIL)), ["no such user"])).toEqual(["refused", false]);
    const dead = await deadPort();
    try {
      expect(failure(await outcome(mailer(realWorker, {}, { ...SETTINGS, port: dead.port }).send(MAIL)))).toEqual(["connect", false]);
    } finally {
      await dead.release();
    }
    // A certificate this thread trusts but the worker does not: the worker's own check.
    const stranger = await fakeServer(testCertificate());
    expect(failure(await outcome(mailer(realWorker, {}, { ...SETTINGS, port: stranger.port }).send(MAIL)))).toEqual(["tls", false]);
    for (const session of stranger.sessions) expect(session.raw).toBe("");
  });
});

describe("the worker mailer, stand-in worker", () => {
  it("making it starts no thread and contacts nothing; the first send makes the worker", async () => {
    const fake = fakeWorker();
    const m = mailer(fake.url);
    await pause(50);
    expect(m.stats()).toEqual({ starts: 0, running: false, busy: false, queued: 0 });
    await m.send(mail("ok"));
    expect(m.stats()).toEqual({ starts: 1, running: true, busy: false, queued: 0 });
    expect(fake.sent()).toEqual(["ok"]);
  });

  it("each reason and bodyWritten crosses the thread boundary intact", async () => {
    const m = mailer(fakeWorker().url);
    const reasons: SmtpReason[] = ["connect", "tls", "auth", "refused", "timeout"];
    for (const reason of reasons) {
      for (const written of [false, true]) {
        const got = failure(await outcome(m.send(mail(`fail ${reason} ${written ? 1 : 0}`))));
        // The client's own rule: only refused and timeout can have a written body.
        expect(got).toEqual([reason, written && (reason === "refused" || reason === "timeout")]);
      }
    }
    // Anything but the client's own error: refused, and it may have been sent.
    expect(failure(await outcome(m.send(mail("leak"))), ["the server said"])).toEqual(["refused", true]);
    expect(failure(await outcome(m.send(mail("odd"))), ["made-up"])).toEqual(["refused", true]);
    expect(m.stats().starts).toBe(1);
  });

  it("an answer that is not one the worker writes is refused, and it may have been sent", () => {
    expect(failureOf({ id: 1, ok: true })).toBeNull();
    for (const odd of [null, undefined, "ok", { ok: false, reason: "made-up", bodyWritten: false }, { ok: false, reason: "auth" }, { ok: false, reason: "auth", bodyWritten: "no" }, { ok: "true" }]) {
      expect(failure(failureOf(odd))).toEqual(["refused", true]);
    }
    expect(answerFor(4, new SmtpError("timeout", true))).toEqual({ id: 4, ok: false, reason: "timeout", bodyWritten: true });
    expect(answerFor(4, new Error(PASSWORD))).toEqual({ id: 4, ok: false, reason: "refused", bodyWritten: true });
  });

  it("nothing secret is in any message either way, in any error, or on the output", async () => {
    const posted: unknown[] = [];
    const answers: unknown[] = [];
    const post = Worker.prototype.postMessage;
    vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, message: unknown, ...rest: unknown[]) {
      posted.push(message);
      return (post as (...a: unknown[]) => void).call(this, message, ...rest);
    });
    const emit = Worker.prototype.emit;
    vi.spyOn(Worker.prototype, "emit").mockImplementation(function (this: Worker, event: string | symbol, ...args: unknown[]) {
      if (event === "message" || event === "error") answers.push(args[0]);
      return (emit as (...a: unknown[]) => boolean).call(this, event, ...args);
    });
    const written: string[] = [];
    for (const stream of [process.stdout, process.stderr]) {
      const real = stream.write.bind(stream);
      vi.spyOn(stream, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
        written.push(String(chunk));
        return (real as (...a: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write);
    }
    const m = mailer(fakeWorker().url);
    await m.send(mail("print"));
    await m.send(mail("ok"));
    failure(await outcome(m.send(mail("fail auth 0"))));
    failure(await outcome(m.send(mail("leak"))));
    failure(await outcome(m.send(mail("crash"))), ["crashed"]);
    await m.send(mail("ok"));
    await pause(100);
    // To the worker: an id and the mail, nothing else.
    expect(posted.length).toBe(6);
    for (const message of posted) expect(Object.keys(message as object).sort()).toEqual(["id", "subject", "text", "to"]);
    // Back: an id and the outcome. The crash's error is raised in this thread, and only noted.
    const back = answers.filter((a) => !(a instanceof Error));
    expect(back.length).toBe(5);
    for (const answer of back) expect(Object.keys(answer as object).sort()).toEqual(expect.arrayContaining(["id", "ok"]));
    for (const answer of back) expect(Object.keys(answer as object).length === 2 || Object.keys(answer as object).length === 4).toBe(true);
    const all = JSON.stringify([posted, back]) + written.join("");
    for (const secret of SECRETS) expect(all).not.toContain(secret);
    expect(written.join("")).not.toContain("out ");
  });

  it("a worker that crashes or exits rejects what is pending, and the next send makes a new one", async () => {
    const fake = fakeWorker();
    const m = mailer(fake.url);
    await m.send(mail("ok"));
    const crashing = outcome(m.send(mail("crash")));
    const waiting = [outcome(m.send(mail("ok"))), outcome(m.send(mail("ok")))];
    expect(failure(await crashing, ["crashed"])).toEqual(["refused", true]);
    for (const w of waiting) expect(failure(await w)).toEqual(["refused", false]);
    expect(m.stats()).toMatchObject({ running: false, busy: false, queued: 0 });
    // The two that waited never reached the worker.
    expect(fake.sent()).toEqual(["ok", "crash"]);
    await m.send(mail("ok"));
    expect(m.stats()).toMatchObject({ starts: 2, running: true });
    expect(failure(await outcome(m.send(mail("exit"))))).toEqual(["refused", true]);
    await m.send(mail("ok"));
    expect(m.stats().starts).toBe(3);
    expect(fake.sent()).toEqual(["ok", "crash", "ok", "exit", "ok"]);
  });

  it(`the worker is made at most ${MAIL_WORKER_STARTS_PER_MINUTE} times a minute; beyond that a send is refused, not sent`, async () => {
    let now = 1_000_000;
    const fake = fakeWorker();
    const m = mailer(fake.url, { now: () => now });
    for (let i = 0; i < MAIL_WORKER_STARTS_PER_MINUTE; i++) expect(failure(await outcome(m.send(mail("exit"))))).toEqual(["refused", true]);
    expect(failure(await outcome(m.send(mail("ok"))))).toEqual(["refused", false]);
    expect(m.stats()).toMatchObject({ starts: MAIL_WORKER_STARTS_PER_MINUTE, running: false });
    expect(fake.sent().filter((s) => s === "ok")).toEqual([]);
    now += 59_999;
    expect(failure(await outcome(m.send(mail("ok"))))).toEqual(["refused", false]);
    now += 1;
    await m.send(mail("ok"));
    expect(m.stats().starts).toBe(MAIL_WORKER_STARTS_PER_MINUTE + 1);
  });

  it(`at most ${MAIL_QUEUE_MAX} mails wait; one more is refused at once and never sent`, async () => {
    expect(MAIL_QUEUE_MAX).toBe(16);
    const fake = fakeWorker();
    const m = mailer(fake.url);
    const first = outcome(m.send(mail("slow 400")));
    const queued = Array.from({ length: MAIL_QUEUE_MAX }, (_, i) => outcome(m.send(mail(`ok ${i}`))));
    expect(m.stats()).toMatchObject({ busy: true, queued: MAIL_QUEUE_MAX });
    const started = Date.now();
    expect(failure(await outcome(m.send(mail("ok over"))))).toEqual(["refused", false]);
    expect(Date.now() - started).toBeLessThan(100);
    expect(await first).toBe("sent");
    for (const q of queued) expect(await q).toBe("sent");
    expect(fake.sent()).toHaveLength(1 + MAIL_QUEUE_MAX);
    expect(fake.sent()).not.toContain("ok");
    expect(fake.sent().some((s) => s.includes("over"))).toBe(false);
    // Room again: the next one goes.
    await m.send(mail("ok after"));
  });

  it("a mail that waited longer than its limit is refused, not sent; the default limit is one whole send", async () => {
    expect(MAIL_QUEUE_WAIT_MS).toBe(SMTP_LIMITS.totalMs);
    const fake = fakeWorker();
    const m = mailer(fake.url, { queueWaitMs: 100 });
    const slow = outcome(m.send(mail("slow 500")));
    const late = outcome(m.send(mail("ok late")));
    const started = Date.now();
    expect(failure(await late)).toEqual(["refused", false]);
    expect(Date.now() - started).toBeLessThan(400);
    expect(await slow).toBe("sent");
    expect(fake.sent()).toEqual(["slow 500"]);
  });

  it("a worker that stops answering is stopped when the time runs out: timeout, maybe sent; the next send works", async () => {
    const fake = fakeWorker();
    const m = mailer(fake.url, { runLimitMs: 300 });
    const started = Date.now();
    const hung = outcome(m.send(mail("hang")));
    const behind = outcome(m.send(mail("ok behind")));
    expect(failure(await hung)).toEqual(["timeout", true]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(failure(await behind)).toEqual(["refused", false]);
    expect(m.stats()).toMatchObject({ running: false, busy: false });
    await m.send(mail("ok"));
    expect(fake.sent()).toEqual(["hang", "ok"]);
    // The default: the client's whole send, and a little for the thread.
    expect(MAIL_WORKER_GRACE_MS).toBeGreaterThan(0);
    expect(MAIL_WORKER_GRACE_MS).toBeLessThanOrEqual(5000);
  });

  it("a mail that is not three strings is refused before it reaches the worker", async () => {
    const fake = fakeWorker();
    const m = mailer(fake.url);
    for (const bad of [null, undefined, "mail", { to: "a@example.com", subject: "ok" }, { to: 1, subject: "ok", text: "x" }]) {
      expect(failure(await outcome(m.send(bad as unknown as Mail)))).toEqual(["refused", false]);
    }
    expect(m.stats().starts).toBe(0);
  });

  it("the main thread keeps running on time while the worker is busy", async () => {
    const m = mailer(fakeWorker().url);
    await m.send(mail("ok"));
    /** The longest the main thread's event loop was held up, in ms, while `work` ran. */
    const longestStall = async (work: () => Promise<unknown>) => {
      const h = monitorEventLoopDelay({ resolution: 5 });
      let worst = 0;
      let last = performance.now();
      let ticking = true;
      const tick = () => {
        const at = performance.now();
        worst = Math.max(worst, at - last);
        last = at;
        if (ticking) setImmediate(tick);
      };
      h.enable();
      setImmediate(tick);
      await work();
      ticking = false;
      h.disable();
      return { worst, p99: h.percentile(99) / 1e6, max: h.max / 1e6 };
    };
    // 400 ms of work in the worker: the main thread never stalls for long.
    const threaded = await longestStall(() => m.send(mail("burn 400")));
    expect(threaded.worst).toBeLessThan(150);
    expect(threaded.max).toBeLessThan(150);
    // The control: the same work on the main thread is seen as one long stall.
    const inline = await longestStall(async () => {
      await pause(10);
      const end = Date.now() + 400;
      while (Date.now() < end);
      await pause(10);
    });
    expect(inline.worst).toBeGreaterThan(350);
  });

  it("close refuses what waits, ends what is on its way, stops the worker; later sends are refused", async () => {
    const fake = fakeWorker();
    const m = mailer(fake.url);
    const hung = outcome(m.send(mail("hang")));
    const waiting = outcome(m.send(mail("ok")));
    await until(() => fake.sent().length === 1);
    await m.close();
    expect(failure(await hung)).toEqual(["timeout", true]);
    expect(failure(await waiting)).toEqual(["refused", false]);
    expect(m.stats()).toMatchObject({ running: false, busy: false, queued: 0 });
    expect(failure(await outcome(m.send(mail("ok"))))).toEqual(["refused", false]);
    expect(fake.sent()).toEqual(["hang"]);
    // Closing twice, or a mailer that never sent, is fine.
    await m.close();
    await mailer(fakeWorker().url).close();
  });

  it("in the stop sequence, a send in flight gets the time left and the stop still ends by the deadline", async () => {
    // The real sequence, with every timer it sets run 35 times faster: 7 s become 200 ms.
    const SCALE = 35;
    const run = async (subject: string) => {
      const fake = fakeWorker();
      const m = mailer(fake.url);
      const background = deferTracker(() => {});
      const sending = outcome(m.send(mail(subject)));
      background.defer(sending.then((r) => (r === "sent" ? undefined : Promise.reject(r))));
      await until(() => fake.sent().length === 1);
      const events: string[] = [];
      const started = Date.now();
      let exited: (code: number) => void = () => {};
      const exit = new Promise<number>((resolve) => (exited = resolve));
      const stop = stopSequence({
        server: { close: (done) => setTimeout(done, 5) },
        settle: () => background.settle(),
        closeMail: () => {
          events.push("mail closed");
          return m.close();
        },
        closeDb: () => void events.push("db closed"),
        setTimeout: (fn, ms) => setTimeout(fn, ms / SCALE),
        log: () => {},
        error: (line) => void events.push(line),
        exit: (code) => exited(code),
      });
      stop("SIGTERM");
      const code = await exit;
      return { code, took: Date.now() - started, events, result: await sending, m };
    };

    const hung = await run("hang");
    expect(hung.code).toBe(0);
    expect(hung.events).toEqual(["mail closed", "db closed"]);
    expect(hung.took).toBeGreaterThanOrEqual(STOP_DEADLINE_MS / 35 - 10);
    expect(hung.took).toBeLessThan(STOP_DEADLINE_MS / 35 + 500);
    expect(failure(hung.result)).toEqual(["timeout", true]);
    expect(hung.m.stats().running).toBe(false);

    // A send that ends in time is waited for, and the stop ends early.
    const quick = await run("slow 50");
    expect(quick.code).toBe(0);
    expect(quick.result).toBe("sent");
    expect(quick.events).toEqual(["mail closed", "db closed"]);
    expect(quick.took).toBeLessThan(STOP_DEADLINE_MS / 35);
  }, 15_000);
});

// ---------------------------------------------------------------------------------
// Child processes: the worker must not keep a process alive, and must be found in
// every layout the app runs from.
// ---------------------------------------------------------------------------------

/** Runs a module in a fresh Node process and gives what it printed and how it ended, or "timeout". */
function runNode(source: string, env: Record<string, string> = {}, ms = 20_000): Promise<{ code: number | null; out: string; err: string; took: number } | "timeout"> {
  wrappers += 1;
  const file = join(scratch, `child-${wrappers}.mjs`);
  writeFileSync(file, source);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    const timer = setTimeout(() => {
      child.kill();
      resolve("timeout");
    }, ms);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, took: Date.now() - started });
    });
  });
}

describe("the worker in a process of its own", () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((stop) => stop()));
  });

  it("an idle worker does not keep the process alive, and one with a mail on its way does until it is done", async () => {
    const fake = fakeWorker();
    const result = await runNode(`
import { workerMailer } from ${JSON.stringify(THREAD_URL)};
const m = workerMailer({}, { workerUrl: new URL(${JSON.stringify(fake.url.href)}) });
await m.send({ to: "a@example.com", subject: "ok", text: "x" });
console.log("first sent");
// Nothing holds the process but this send.
m.send({ to: "a@example.com", subject: "slow 300", text: "x" }).then(() => console.log("second sent"));
`);
    expect(result).not.toBe("timeout");
    if (result === "timeout") return;
    expect(result.out).toBe("first sent\nsecond sent\n");
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(fake.sent()).toEqual(["ok", "slow 300"]);
  }, 30_000);

  it("the worker module sits next to the mailer, in the source and in the build", () => {
    expect(fileURLToPath(MAIL_WORKER_URL)).toBe(join(ROOT, "src", "node", "mail-worker.ts"));
    expect(existsSync(MAIL_WORKER_URL)).toBe(true);
  });

  describe("found and run from each layout, with the process's own trust store", () => {
    const trusted = testCertificate();
    const caFile = join(scratch, "ca.pem");
    let build = "";
    beforeAll(() => {
      writeFileSync(caFile, trusted.cert);
      // The Node build, as npm run build:node and the cPanel packager make it, in a scratch folder.
      build = join(scratch, "build");
      const tsc = join(ROOT, "node_modules", "typescript", "bin", "tsc");
      const made = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json", "--outDir", build], { cwd: ROOT, encoding: "utf8", windowsHide: true });
      expect(made.status, made.stdout + made.stderr).toBe(0);
      // Beside dist/ there is always the package's own package.json, which makes the build ES modules.
      writeFileSync(join(build, "package.json"), JSON.stringify({ type: "module" }));
    }, 120_000);

    const sendFrom = async (moduleUrl: string, cwd: string) => {
      const server = await fakeServer(trusted);
      const result = await runNode(
        `
process.chdir(${JSON.stringify(cwd)});
const { workerMailer, MAIL_WORKER_URL } = await import(${JSON.stringify(moduleUrl)});
const m = workerMailer(${JSON.stringify({ ...SETTINGS, port: server.port })});
try { await m.send(${JSON.stringify(MAIL)}); console.log("sent " + MAIL_WORKER_URL.pathname.split("/").slice(-3).join("/")); }
catch (e) { console.log("failed " + e.reason + " " + e.bodyWritten); }
`,
        { NODE_EXTRA_CA_CERTS: caFile },
      );
      return { result, server };
    };

    it("the build: dist/node/mail-worker.js, from any working folder", async () => {
      expect(existsSync(join(build, "node", "mail-worker.js"))).toBe(true);
      const { result, server } = await sendFrom(pathToFileURL(join(build, "node", "mail-thread.js")).href, tmpdir());
      expect(result).not.toBe("timeout");
      if (result === "timeout") return;
      expect(result.out).toBe("sent build/node/mail-worker.js\n");
      expect(result.err).toBe("");
      expect(server.sessions).toHaveLength(1);
      expect(server.sessions[0].bodies).toHaveLength(1);
    }, 30_000);

    it("the source, run by Node itself: src/node/mail-worker.ts", async () => {
      const { result, server } = await sendFrom(THREAD_URL, tmpdir());
      expect(result).not.toBe("timeout");
      if (result === "timeout") return;
      expect(result.out).toBe("sent src/node/mail-worker.ts\n");
      expect(server.sessions[0].bodies).toHaveLength(1);
    });
  });
});
