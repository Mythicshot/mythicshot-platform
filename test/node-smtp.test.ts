// The SMTP client, first against a scripted in-memory connection (no socket), then
// against a fake mail server this file starts on 127.0.0.1. No real mail server is
// ever contacted and no real name is looked up: every name here is a placeholder.
import { generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";
import * as net from "node:net";
import { Duplex } from "node:stream";
import * as tls from "node:tls";
import { inspect } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { signInMail } from "../src/mail.ts";
import { SMTP_LIMITS, SmtpError, buildMessage, smtpMailer, tlsOptions, type SmtpSettings } from "../src/node/smtp.ts";

const PASSWORD = "pw-S3cret/with+chars=";
const USER = "no-reply@example.com";
const SETTINGS: SmtpSettings = {
  host: "mail.test",
  port: 465,
  user: USER,
  password: PASSWORD,
  from: "no-reply@example.com",
  helo: "app.example.com",
};
const CODE = "dpl_" + "0123456789abcdef".repeat(2) + "01234567";
const LINK = `https://app.example.com/signin/link#c=${CODE}`;
const MAIL = signInMail("ada@example.com", LINK, "Mythicshot");

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const PLAIN_TOKEN = b64(`\0${USER}\0${PASSWORD}`);
/** Every form a secret could take in a text. */
const SECRETS = [PASSWORD, b64(PASSWORD), PLAIN_TOKEN, CODE, LINK, MAIL.to, USER, b64(USER)];

/** "sent", or the failure itself. */
const outcome = (work: Promise<void>): Promise<unknown> =>
  work.then(
    () => "sent",
    (e: unknown) => e,
  );

/** The fixed reason of a failure, and proof that it carries no secret and none of the server's words. */
function reasonOf(failure: unknown, alsoAbsent: string[] = []): string {
  expect(failure).toBeInstanceOf(SmtpError);
  const error = failure as SmtpError;
  expect(error.message).toBe(`smtp: ${error.reason}`);
  expect(error.name).toBe("SmtpError");
  expect(error.cause).toBeUndefined();
  const seen = [error.message, String(error.stack), JSON.stringify(error), inspect(error, { depth: 6, showHidden: true }), String(error)].join("\n");
  for (const secret of [...SECRETS, ...alsoAbsent]) expect(seen).not.toContain(secret);
  return error.reason;
}

// ---------------------------------------------------------------------------------
// The fake mail server's side of the conversation, used in memory and over a socket.
// ---------------------------------------------------------------------------------

type Step = "greeting" | "ehlo" | "auth" | "mail" | "rcpt" | "data" | "body" | "quit";
/** What the server answers at each step instead of the usual; null is silence. */
type Script = Partial<Record<Step, string | null>> & { hangUpAt?: Step; chop?: boolean };

class Session {
  /** Every line the client sent outside the message, in order. */
  readonly commands: string[] = [];
  /** Every message received, as it was on the wire, without the final dot line. */
  readonly bodies: string[] = [];
  /** Every byte the client sent. */
  raw = "";
  private pending = "";
  private inData = false;
  private login = 0;

  constructor(
    private readonly script: Script,
    private readonly out: (text: string) => void,
    private readonly hangUp: () => void,
  ) {}

  start(): void {
    this.say("greeting", "220 mail.test ESMTP ready");
  }

  private say(step: Step, usual: string): void {
    if (this.script.hangUpAt === step) return this.hangUp();
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
        this.say("body", "250 2.0.0 queued as 4F9A1");
        continue;
      }
      const end = this.pending.indexOf("\r\n");
      if (end < 0) return;
      const line = this.pending.slice(0, end);
      this.pending = this.pending.slice(end + 2);
      this.commands.push(line);
      this.handle(line);
    }
  }

  private handle(line: string): void {
    if (this.login === 1) {
      this.login = 2;
      return this.out("334 UGFzc3dvcmQ6\r\n");
    }
    if (this.login === 2) {
      this.login = 0;
      return this.say("auth", "235 2.7.0 accepted");
    }
    const verb = line.toUpperCase();
    if (verb.startsWith("EHLO ")) return this.say("ehlo", "250-mail.test\r\n250-SIZE 35882577\r\n250-8BITMIME\r\n250 AUTH PLAIN LOGIN");
    if (verb === "AUTH LOGIN") {
      this.login = 1;
      return this.out("334 VXNlcm5hbWU6\r\n");
    }
    if (verb.startsWith("AUTH PLAIN ")) return this.say("auth", "235 2.7.0 accepted");
    if (verb.startsWith("MAIL FROM:")) return this.say("mail", "250 2.1.0 ok");
    if (verb.startsWith("RCPT TO:")) return this.say("rcpt", "250 2.1.5 ok");
    if (verb === "DATA") {
      const reply = "data" in this.script ? this.script.data : "354 end with a dot";
      if (typeof reply === "string" && reply.startsWith("354") && this.script.hangUpAt !== "data") this.inData = true;
      return this.say("data", "354 end with a dot");
    }
    if (verb === "QUIT") {
      this.say("quit", "221 2.0.0 bye");
      if (this.script.quit !== null) this.hangUp();
      return;
    }
    this.out("500 5.5.1 what\r\n");
  }
}

/** A connection that exists only in memory, with the fake server on its other end. */
function memory(script: Script = {}) {
  let opened = 0;
  const stream: Duplex = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, done) {
      session.feed(chunk.toString("latin1"));
      done();
    },
  });
  const session: Session = new Session(
    script,
    (text) => {
      if (script.chop) for (const one of text) stream.push(one, "latin1");
      else stream.push(text, "latin1");
    },
    () => stream.push(null),
  );
  const connect = async (): Promise<Duplex> => {
    opened += 1;
    session.start();
    return stream;
  };
  return { stream, session, connect, opened: () => opened };
}

/** A message as the receiving server would store it: dots unstuffed. */
const unstuffed = (wire: string) =>
  wire
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? line.slice(1) : line))
    .join("\r\n");

/** The body of a message: everything after the first empty line. */
const bodyOf = (message: string) => message.slice(message.indexOf("\r\n\r\n") + 4);

afterEach(() => {
  vi.useRealTimers();
});

describe("smtp client, scripted connection", () => {
  it("a mail is sent in the order the protocol asks", async () => {
    const { session, connect, opened } = memory();
    await smtpMailer(SETTINGS, connect).send(MAIL);
    expect(opened()).toBe(1);
    expect(session.commands).toEqual([
      "EHLO app.example.com",
      `AUTH PLAIN ${PLAIN_TOKEN}`,
      "MAIL FROM:<no-reply@example.com>",
      "RCPT TO:<ada@example.com>",
      "DATA",
      "QUIT",
    ]);
    // One message, and it is the mail.
    expect(session.bodies).toHaveLength(1);
    const message = unstuffed(session.bodies[0]);
    expect(message).toContain("\r\nSubject: Your Mythicshot sign-in link\r\n");
    expect(message).toContain("\r\nTo: ada@example.com\r\n");
    expect(message.startsWith("From: no-reply@example.com\r\n")).toBe(true);
    expect(bodyOf(message)).toBe(MAIL.text.replaceAll("\n", "\r\n"));
    expect(bodyOf(message).split("\r\n")).toContain(LINK);
    // Nothing is said before the server greeted: the first bytes follow the greeting.
    const silent = memory({ greeting: null });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const waiting = outcome(smtpMailer(SETTINGS, silent.connect).send(MAIL));
    await vi.advanceTimersByTimeAsync(SMTP_LIMITS.replyMs - 1);
    expect(silent.session.raw).toBe("");
    await vi.advanceTimersByTimeAsync(1);
    expect(reasonOf(await waiting)).toBe("timeout");
    expect(silent.session.raw).toBe("");
  });

  it("the password is sent only after the server offered AUTH, and never appears in an error", async () => {
    // No AUTH offered: the password never leaves, in any form.
    const none = memory({ ehlo: "250-mail.test\r\n250 SIZE 1000" });
    expect(reasonOf(await outcome(smtpMailer(SETTINGS, none.connect).send(MAIL)))).toBe("auth");
    expect(none.session.commands).toEqual(["EHLO app.example.com"]);
    for (const secret of [PASSWORD, b64(PASSWORD), PLAIN_TOKEN, b64(USER)]) expect(none.session.raw).not.toContain(secret);

    // Only a way this client does not speak: the same.
    const other = memory({ ehlo: "250-mail.test\r\n250 AUTH CRAM-MD5 XOAUTH2" });
    expect(reasonOf(await outcome(smtpMailer(SETTINGS, other.connect).send(MAIL)))).toBe("auth");
    expect(other.session.raw).not.toContain(PLAIN_TOKEN);
    expect(other.session.raw).not.toContain(b64(PASSWORD));

    // A server that refuses the greeting or the EHLO never sees it either.
    for (const script of [{ greeting: "554 5.3.2 go away" }, { ehlo: "502 5.5.1 no" }, { ehlo: null }] as Script[]) {
      const refusing = memory(script);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const waiting = outcome(smtpMailer(SETTINGS, refusing.connect).send(MAIL));
      await vi.advanceTimersByTimeAsync(SMTP_LIMITS.totalMs);
      vi.useRealTimers();
      expect(["refused", "timeout"]).toContain(reasonOf(await waiting));
      expect(refusing.session.raw).not.toContain(PLAIN_TOKEN);
      expect(refusing.session.raw).not.toContain(b64(PASSWORD));
    }

    // AUTH offered: PLAIN is used, in one line, right after EHLO.
    const plain = memory();
    await smtpMailer(SETTINGS, plain.connect).send(MAIL);
    expect(plain.session.commands[1]).toBe(`AUTH PLAIN ${PLAIN_TOKEN}`);
    expect(plain.session.raw.split(PLAIN_TOKEN)).toHaveLength(2);

    // Only LOGIN offered: the name, then the password, each when asked.
    const login = memory({ ehlo: "250-mail.test\r\n250 AUTH=LOGIN" });
    await smtpMailer(SETTINGS, login.connect).send(MAIL);
    expect(login.session.commands.slice(0, 5)).toEqual([
      "EHLO app.example.com",
      "AUTH LOGIN",
      b64(USER),
      b64(PASSWORD),
      "MAIL FROM:<no-reply@example.com>",
    ]);

    // A server that repeats the password in its refusal: the failure holds none of it.
    const echo = memory({ auth: `535 5.7.8 bad password ${PASSWORD} ${PLAIN_TOKEN} for ${USER}` });
    const failure = await outcome(smtpMailer(SETTINGS, echo.connect).send(MAIL));
    expect(reasonOf(failure, ["bad password", "5.7.8"])).toBe("auth");
    // After a refused sign-in nothing more is asked.
    expect(echo.session.commands).toHaveLength(2);

    // A name or password that could not be framed is not sent at all.
    for (const broken of [{ password: "" }, { user: "" }, { password: "a\0b" }, { user: "a\0b" }]) {
      const unused = memory();
      expect(reasonOf(await outcome(smtpMailer({ ...SETTINGS, ...broken }, unused.connect).send(MAIL)))).toBe("auth");
      expect(unused.opened()).toBe(0);
    }
  });

  it("a line that starts with a dot is doubled, and every line ends with CRLF", async () => {
    const text = [".hidden", "..two dots", "plain", ".", "after the lone dot", "bare\rreturn", "\r.\r", "end"].join("\n");
    const { session, connect } = memory();
    await smtpMailer(SETTINGS, connect).send({ to: "ada@example.com", subject: "Dots", text });
    expect(session.commands).toHaveLength(6);
    expect(session.bodies).toHaveLength(1);
    const wire = session.bodies[0];
    // On the wire: every dot line doubled, so the message cannot end early.
    expect(wire).toContain("\r\n..hidden\r\n...two dots\r\nplain\r\n..\r\nafter the lone dot\r\n");
    expect(wire).toContain("\r\nbare\r\nreturn\r\n\r\n..\r\nend\r\n");
    for (const line of wire.split("\r\n")) expect(line === "." || /^\.[^.]/.test(line)).toBe(false);
    // No line break is anything but CRLF, in the message or in a command.
    expect(session.raw.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
    expect(wire.endsWith("\r\n")).toBe(true);
    // The receiving side reads back the text, with its line breaks made uniform.
    expect(bodyOf(unstuffed(wire))).toBe(
      [".hidden", "..two dots", "plain", ".", "after the lone dot", "bare", "return", "", ".", "end", ""].join("\r\n"),
    );
    // The server saw one message and then QUIT: nothing in the text became a command.
    expect(session.commands.at(-1)).toBe("QUIT");
  });

  it("an address or subject with a line break is refused before anything is written", async () => {
    const badAddresses = [
      "ada@example.com\r\nRCPT TO:<eve@example.org>",
      "ada@example.com\nBcc: eve@example.org",
      "ada@example.com\r",
      "\nada@example.com",
      ".\r\nada@example.com",
      "ada@example.com>\r\nDATA",
      "<ada@example.com>",
      "ada@example.com> SIZE=1",
      "Ada <ada@example.com>",
      "ada @example.com",
      "ada@exa mple.com",
      "ada@example.com,eve@example.org",
      "ada@@example.com",
      "ada@example.com@example.org",
      "ada\0@example.com",
      "ada\t@example.com",
      "adä@example.com",
      "ada@exämple.com",
      "ada",
      "@example.com",
      "ada@",
      "",
      "a".repeat(65) + "@example.com",
      "ada@" + "a".repeat(254) + ".com",
    ];
    const badSubjects = ["Hello\r\nBcc: eve@example.org", "Hello\nthere", "Hello\rthere", "Hello\0", `Hello${String.fromCharCode(0x2028)}there`, `Hello${String.fromCharCode(0x2029)}there`, `Hello${String.fromCharCode(0x85)}there`, "x".repeat(999)];
    const cases: Array<{ settings: SmtpSettings; mail: typeof MAIL }> = [
      ...badAddresses.map((to) => ({ settings: SETTINGS, mail: { ...MAIL, to } })),
      ...badSubjects.map((subject) => ({ settings: SETTINGS, mail: { ...MAIL, subject } })),
      ...badAddresses.map((from) => ({ settings: { ...SETTINGS, from }, mail: MAIL })),
      ...["app.example.com\r\nMAIL FROM:<x@example.org>", "app example", "", "app\0"].map((helo) => ({ settings: { ...SETTINGS, helo }, mail: MAIL })),
    ];
    expect(cases.length).toBeGreaterThan(50);
    for (const { settings, mail } of cases) {
      const { session, connect, opened } = memory();
      expect(reasonOf(await outcome(smtpMailer(settings, connect).send(mail)))).toBe("refused");
      // Not one byte, and not even a connection.
      expect(opened()).toBe(0);
      expect(session.raw).toBe("");
    }
    // Settings or a mail that are not there at all end the same way, not as a stray error.
    const absent = memory();
    expect(reasonOf(await outcome(smtpMailer(null as unknown as SmtpSettings, absent.connect).send(MAIL)))).toBe("refused");
    expect(reasonOf(await outcome(smtpMailer(SETTINGS, absent.connect).send(null as unknown as typeof MAIL)))).toBe("refused");
    expect(absent.opened()).toBe(0);
    // A text or subject beyond the size a mail of this site can have is refused the same way.
    for (const mail of [
      { ...MAIL, text: "x".repeat(100_001) },
      { ...MAIL, text: "é".repeat(50_001) },
      { ...MAIL, subject: "x".repeat(256) },
      { ...MAIL, text: 5 as unknown as string },
      { ...MAIL, subject: undefined as unknown as string },
    ]) {
      const big = memory();
      const failure = await outcome(smtpMailer(SETTINGS, big.connect).send(mail));
      expect(reasonOf(failure)).toBe("refused");
      expect((failure as SmtpError).bodyWritten).toBe(false);
      expect(big.opened()).toBe(0);
      expect(() => buildMessage(mail, SETTINGS.from, 0, "abc")).toThrow(SmtpError);
    }
    // The largest text still goes.
    const largest = memory();
    await smtpMailer(SETTINGS, largest.connect).send({ ...MAIL, text: "x".repeat(99_999) + "\n" });
    expect(largest.session.bodies).toHaveLength(1);
    // Whatever is handed in, a failure is this client's own error and nothing else.
    const hostile = {
      get to(): string {
        throw new Error(`boom ${PASSWORD}`);
      },
      subject: "s",
      text: "t",
    };
    for (const [settings, mail] of [
      [SETTINGS, hostile],
      [{ ...SETTINGS, port: "465" as unknown as number }, MAIL],
      [{ ...SETTINGS, from: 7 as unknown as string }, MAIL],
      [SETTINGS, "mail" as unknown as typeof MAIL],
      [undefined as unknown as SmtpSettings, MAIL],
    ] as Array<[SmtpSettings, typeof MAIL]>) {
      const unused = memory();
      let thrown: unknown = null;
      let failure: unknown = null;
      try {
        failure = await outcome(smtpMailer(settings, unused.connect).send(mail));
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeNull();
      expect(["refused", "connect"]).toContain(reasonOf(failure, ["boom"]));
      expect(unused.opened()).toBe(0);
    }
    // The message builder refuses the same on its own.
    for (const to of badAddresses) expect(() => buildMessage({ ...MAIL, to }, SETTINGS.from, 0, "abc")).toThrow(SmtpError);
    for (const subject of badSubjects) expect(() => buildMessage({ ...MAIL, subject }, SETTINGS.from, 0, "abc")).toThrow(SmtpError);
    for (const from of badAddresses) expect(() => buildMessage(MAIL, from, 0, "abc")).toThrow(SmtpError);
    for (const id of ["a\r\nb", "a b", "a@b", "<a>", ""]) expect(() => buildMessage(MAIL, SETTINGS.from, 0, id)).toThrow(SmtpError);
    // Ordinary addresses and a subject with angle brackets pass.
    const fine = memory();
    await smtpMailer(SETTINGS, fine.connect).send({ to: "ada.lovelace+tours@mail.example.co.uk", subject: "A <b> & c", text: "x" });
    expect(fine.session.commands[3]).toBe("RCPT TO:<ada.lovelace+tours@mail.example.co.uk>");
    expect(fine.session.bodies[0]).toContain("\r\nSubject: A <b> & c\r\n");
  });

  it("a multi-line reply is read whole", async () => {
    // Every reply arrives one byte at a time, and the long ones span lines; AUTH is
    // offered in the middle of one.
    const { session, connect } = memory({
      chop: true,
      greeting: "220-mail.test ESMTP\r\n220-no spam please\r\n220 ready",
      ehlo: "250-mail.test greets you\r\n250-PIPELINING\r\n250-AUTH LOGIN PLAIN\r\n250-SIZE 1000\r\n250 HELP",
      auth: "235-2.7.0 welcome\r\n235 2.7.0 accepted",
      body: "250-2.0.0 thanks\r\n250 2.0.0 queued",
    });
    await smtpMailer(SETTINGS, connect).send(MAIL);
    expect(session.commands).toEqual([
      "EHLO app.example.com",
      `AUTH PLAIN ${PLAIN_TOKEN}`,
      "MAIL FROM:<no-reply@example.com>",
      "RCPT TO:<ada@example.com>",
      "DATA",
      "QUIT",
    ]);
    // A reply whose first line says yes and whose last line is still to come is not
    // acted on: a first line alone moves nothing.
    const half = memory({ greeting: "220-mail.test ESMTP" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const waiting = outcome(smtpMailer(SETTINGS, half.connect).send(MAIL));
    await vi.advanceTimersByTimeAsync(SMTP_LIMITS.replyMs);
    expect(reasonOf(await waiting)).toBe("timeout");
    expect(half.session.raw).toBe("");
    vi.useRealTimers();
    // What is not a reply at all ends the conversation, as does one without end.
    for (const greeting of ["hello there", "22 short", "2200 long", "220-a\r\n250 b", "220 " + "x".repeat(70_000), "220-a\r\n".repeat(200) + "220 b"]) {
      const odd = memory({ greeting });
      expect(reasonOf(await outcome(smtpMailer(SETTINGS, odd.connect).send(MAIL)))).toBe("refused");
      expect(odd.session.raw).toBe("");
    }
    // A reply whose code changes from one line to the next is not a reply, at any step.
    const shifting = memory({ ehlo: "250-a\r\n220 b" });
    expect(reasonOf(await outcome(smtpMailer(SETTINGS, shifting.connect).send(MAIL)))).toBe("refused");
    expect(shifting.session.commands).toEqual(["EHLO app.example.com"]);
    // Two replies that arrive together to one command: the second is not taken for the
    // answer to the next command, which is never written.
    const eager = memory({ ehlo: "250-mail.test\r\n250 AUTH PLAIN\r\n235 2.7.0 accepted" });
    expect(reasonOf(await outcome(smtpMailer(SETTINGS, eager.connect).send(MAIL)))).toBe("refused");
    expect(eager.session.raw).not.toContain(PLAIN_TOKEN);
    // "Go ahead" and "taken" arriving together, before the message was written: refused,
    // and the message never leaves.
    const hasty = memory({ data: "354 go ahead\r\n250 2.0.0 queued" });
    const hastyFailure = await outcome(smtpMailer(SETTINGS, hasty.connect).send(MAIL));
    expect(reasonOf(hastyFailure)).toBe("refused");
    expect((hastyFailure as SmtpError).bodyWritten).toBe(false);
    expect(hasty.session.commands.at(-1)).toBe("DATA");
    expect(hasty.session.raw).not.toContain("Subject:");
    expect(hasty.session.raw).not.toContain(CODE);
    // "Taken" said twice to the final dot: the mail is sent, once.
    const twice = memory({ body: "250 2.0.0 queued\r\n250 2.0.0 queued" });
    expect(await outcome(smtpMailer(SETTINGS, twice.connect).send(MAIL))).toBe("sent");
    expect(twice.opened()).toBe(1);
    expect(twice.session.bodies).toHaveLength(1);
    expect(twice.session.commands.filter((c) => c === "DATA")).toHaveLength(1);
  });

  it("a refused recipient, a refused sign-in and a silent server each end as their own fixed reason", async () => {
    const run = async (script: Script, words: string[] = []) => {
      const { session, connect, stream } = memory(script);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const waiting = outcome(smtpMailer(SETTINGS, connect).send(MAIL));
      await vi.advanceTimersByTimeAsync(SMTP_LIMITS.totalMs);
      vi.useRealTimers();
      const result = await waiting;
      expect(stream.destroyed).toBe(true);
      return { reason: result === "sent" ? "sent" : reasonOf(result, words), session };
    };
    const recipient = await run({ rcpt: "550 5.1.1 no such user ada here" }, ["no such user", "5.1.1"]);
    expect(recipient.reason).toBe("refused");
    expect(recipient.session.commands).not.toContain("DATA");
    expect(recipient.session.bodies).toHaveLength(0);

    expect((await run({ auth: "535 5.7.8 authentication failed" }, ["authentication failed"])).reason).toBe("auth");
    expect((await run({ auth: "454 4.7.0 try later" })).reason).toBe("auth");
    expect((await run({ rcpt: "451 4.3.0 greylisted, come back" }, ["greylisted"])).reason).toBe("refused");
    expect((await run({ greeting: "421 4.3.2 too busy" })).reason).toBe("refused");
    expect((await run({ mail: "550 5.7.1 sender not allowed" }, ["sender not allowed"])).reason).toBe("refused");
    expect((await run({ data: "554 5.5.1 no" })).reason).toBe("refused");
    expect((await run({ body: "552 5.3.4 too big" }, ["too big"])).reason).toBe("refused");
    expect((await run({ hangUpAt: "mail" })).reason).toBe("refused");
    expect((await run({ hangUpAt: "greeting" })).reason).toBe("refused");
    // Only 250 to the final dot means the mail was taken.
    for (const body of ["251 2.1.5 will forward", "354 go on", "220 ready", "200 ok", "252 cannot verify", "235 2.7.0 accepted"]) {
      const odd = await run({ body });
      expect(odd.reason).toBe("refused");
      expect(odd.session.commands).not.toContain("QUIT");
    }

    // Whether the mail may have been taken: only once the message itself was written.
    const flagOf = async (script: Script) => {
      const { session, connect } = memory(script);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const waiting = outcome(smtpMailer(SETTINGS, connect).send(MAIL));
      await vi.advanceTimersByTimeAsync(SMTP_LIMITS.totalMs);
      vi.useRealTimers();
      const failure = (await waiting) as SmtpError;
      expect(failure).toBeInstanceOf(SmtpError);
      expect(typeof failure.bodyWritten).toBe("boolean");
      return { reason: failure.reason, bodyWritten: failure.bodyWritten, bodies: session.bodies.length };
    };
    // The server hangs up, or says nothing, or says no, after the whole message arrived.
    expect(await flagOf({ hangUpAt: "body" })).toEqual({ reason: "refused", bodyWritten: true, bodies: 1 });
    expect(await flagOf({ body: null })).toEqual({ reason: "timeout", bodyWritten: true, bodies: 1 });
    expect(await flagOf({ body: "554 5.6.0 no" })).toEqual({ reason: "refused", bodyWritten: true, bodies: 1 });
    // Before that, the mail was certainly not sent.
    expect(await flagOf({ hangUpAt: "data" })).toEqual({ reason: "refused", bodyWritten: false, bodies: 0 });
    expect(await flagOf({ data: null })).toEqual({ reason: "timeout", bodyWritten: false, bodies: 0 });
    expect(await flagOf({ rcpt: "550 no" })).toEqual({ reason: "refused", bodyWritten: false, bodies: 0 });
    expect(await flagOf({ auth: "535 no" })).toEqual({ reason: "auth", bodyWritten: false, bodies: 0 });
    expect(await flagOf({ greeting: null })).toEqual({ reason: "timeout", bodyWritten: false, bodies: 0 });
    expect(new SmtpError("connect").bodyWritten).toBe(false);
    expect(new SmtpError("tls").bodyWritten).toBe(false);
    expect(new SmtpError("refused", true).bodyWritten).toBe(true);
    // The three reasons that come before any message can never claim it was written.
    for (const reason of ["connect", "tls", "auth"] as const) expect(new SmtpError(reason, true).bodyWritten).toBe(false);
    // The waits cannot be changed by other code.
    expect(Object.isFrozen(SMTP_LIMITS)).toBe(true);

    // Silence at each step is a timeout, and the mail is never written twice.
    for (const step of ["greeting", "ehlo", "auth", "mail", "rcpt", "data", "body"] as Step[]) {
      const silent = await run({ [step]: null });
      expect(silent.reason).toBe("timeout");
      expect(silent.session.bodies.length).toBeLessThanOrEqual(1);
      expect(silent.session.commands.filter((c) => c === "DATA").length).toBeLessThanOrEqual(1);
    }
    // Once the server took the mail it is sent, whatever happens to the goodbye.
    for (const script of [{ quit: null }, { hangUpAt: "quit" }, { quit: "500 5.5.1 what" }] as Script[]) {
      const done = await run(script);
      expect(done.reason).toBe("sent");
      expect(done.session.bodies).toHaveLength(1);
    }

    // The waits are bounded as stated: one reply 15 s, the whole 30 s, the connection 10 s.
    expect(SMTP_LIMITS).toEqual({ connectMs: 10_000, replyMs: 15_000, totalMs: 30_000 });
    const slow = memory({ ehlo: null });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled: unknown = null;
    void outcome(smtpMailer(SETTINGS, slow.connect).send(MAIL)).then((r) => (settled = r));
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(reasonOf(settled)).toBe("timeout");

    // A server that answers each step just in time is cut off at 30 s in all.
    const dripStream: Duplex = new Duplex({
      read() {},
      write(_chunk, _encoding, done) {
        setTimeout(() => dripStream.push("250-mail.test\r\n250 AUTH PLAIN\r\n"), 14_000);
        done();
      },
    });
    settled = null;
    void outcome(
      smtpMailer(SETTINGS, async () => {
        setTimeout(() => dripStream.push("220 ready\r\n"), 14_000);
        return dripStream;
      }).send(MAIL),
    ).then((r) => (settled = r));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(reasonOf(settled)).toBe("timeout");
    expect(dripStream.destroyed).toBe(true);

    // A connection that never comes is given up after 10 s, and closed if it comes late.
    let late: ((stream: Duplex) => void) | null = null;
    settled = null;
    void outcome(smtpMailer(SETTINGS, () => new Promise<Duplex>((resolve) => (late = resolve))).send(MAIL)).then((r) => (settled = r));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(reasonOf(settled)).toBe("timeout");
    const straggler = memory();
    late!(straggler.stream);
    await vi.advanceTimersByTimeAsync(0);
    expect(straggler.stream.destroyed).toBe(true);
    expect(straggler.session.raw).toBe("");
  });

  it("the connection is always closed", async () => {
    const scripts: Script[] = [
      {},
      { greeting: "554 no" },
      { ehlo: "250 nothing offered" },
      { auth: "535 no" },
      { mail: "550 no" },
      { rcpt: "550 no" },
      { data: "554 no" },
      { body: "554 no" },
      { hangUpAt: "rcpt" },
      { greeting: "nonsense" },
    ];
    for (const script of scripts) {
      const { stream, connect } = memory(script);
      await outcome(smtpMailer(SETTINGS, connect).send(MAIL));
      expect(stream.destroyed).toBe(true);
    }
    // A connection that fails later does not bring the process down.
    const { stream, connect } = memory();
    await smtpMailer(SETTINGS, connect).send(MAIL);
    stream.emit("error", new Error("late"));

    // A connection that cannot be made is its own reason, and its error's text is not kept.
    const failing = () => Promise.reject(new Error(`could not reach mail.test with ${PASSWORD}`));
    expect(reasonOf(await outcome(smtpMailer(SETTINGS, failing).send(MAIL)), ["could not reach"])).toBe("connect");
    const throwing = () => {
      throw new Error(`boom ${PASSWORD}`);
    };
    expect(reasonOf(await outcome(smtpMailer(SETTINGS, throwing).send(MAIL)), ["boom"])).toBe("connect");
    // A connection opener's own reason is kept.
    const tlsFailure = () => Promise.reject(new SmtpError("tls"));
    expect(reasonOf(await outcome(smtpMailer(SETTINGS, tlsFailure).send(MAIL)))).toBe("tls");
    // A write that fails mid-way closes the connection too.
    const broken: Duplex = new Duplex({
      read() {},
      write(_chunk, _encoding, done) {
        done(new Error(`EPIPE ${PASSWORD}`));
      },
    });
    const result = outcome(
      smtpMailer(SETTINGS, async () => {
        broken.push("220 ready\r\n");
        return broken;
      }).send(MAIL),
    );
    expect(reasonOf(await result, ["EPIPE"])).toBe("refused");
    expect(broken.destroyed).toBe(true);
  });

  it("certificates are checked and the server name is sent", () => {
    expect(tlsOptions(SETTINGS)).toEqual({
      host: "mail.test",
      port: 465,
      servername: "mail.test",
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    });
    // An address has no name to send; the certificate is then checked against the address.
    expect(tlsOptions({ ...SETTINGS, host: "127.0.0.1", port: 2465 })).toEqual({
      host: "127.0.0.1",
      port: 2465,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    });
    // The options hold no secret and nothing that turns checking off.
    const text = JSON.stringify(tlsOptions(SETTINGS));
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(USER);
    expect(Object.keys(tlsOptions(SETTINGS))).not.toContain("checkServerIdentity");
    expect(Object.keys(tlsOptions(SETTINGS))).not.toContain("ca");
  });

  it("the message has a date, a message id on the sender's domain, and is marked as automatic", async () => {
    const now = Date.UTC(2026, 10, 19, 8, 5, 9);
    const message = buildMessage(MAIL, "no-reply@mail.example.com", now, "0123abcd");
    const [head, ...rest] = message.split("\r\n\r\n");
    const body = rest.join("\r\n\r\n");
    expect(head.split("\r\n")).toEqual([
      "From: no-reply@mail.example.com",
      "To: ada@example.com",
      "Subject: Your Mythicshot sign-in link",
      "Date: Thu, 19 Nov 2026 08:05:09 +0000",
      "Message-ID: <0123abcd@mail.example.com>",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 7bit",
      "Auto-Submitted: auto-generated",
      "X-Auto-Response-Suppress: All",
    ]);
    expect(body).toBe(MAIL.text.replaceAll("\n", "\r\n"));
    expect(message.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
    // The link is on a line of its own, whole, so no mail program has to rejoin it.
    expect(body.split("\r\n")).toContain(LINK);
    // A date that is not a time is refused.
    expect(() => buildMessage(MAIL, SETTINGS.from, Number.NaN, "abc")).toThrow(SmtpError);

    // Text beyond ASCII travels as base64 in short lines; a subject as encoded words.
    const text = "Grüße aus Zürich ✓\n.\nEnde";
    const subject = "Ihr Anmeldelink für Mythicshot – gültig für fünfzehn Minuten, nur einmal verwendbar";
    const encoded = buildMessage({ to: "ada@example.com", subject, text }, SETTINGS.from, now, "abc");
    expect(encoded).toMatch(/^[\t\r\n\x20-\x7e]*$/);
    for (const line of encoded.split("\r\n")) expect(line.length).toBeLessThanOrEqual(78);
    expect(encoded).toContain("\r\nContent-Transfer-Encoding: base64\r\n");
    expect(Buffer.from(bodyOf(encoded).replaceAll("\r\n", ""), "base64").toString("utf8")).toBe("Grüße aus Zürich ✓\r\n.\r\nEnde\r\n");
    const subjectLines = encoded.slice(encoded.indexOf("Subject: ") + 9, encoded.indexOf("\r\nDate: ")).split("\r\n ");
    expect(subjectLines.length).toBeGreaterThan(1);
    const decoded = subjectLines
      .map((word) => {
        const match = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/.exec(word);
        expect(match).not.toBeNull();
        return Buffer.from(match![1], "base64").toString("utf8");
      })
      .join("");
    expect(decoded).toBe(subject);
    // A very long line also travels as base64, so no line passes the protocol's limit.
    const long = buildMessage({ ...MAIL, text: "x".repeat(2000) }, SETTINGS.from, now, "abc");
    for (const line of long.split("\r\n")) expect(line.length).toBeLessThanOrEqual(78);

    // Each send makes its own message id and takes the date from the clock.
    const first = memory();
    const second = memory();
    const before = Date.now();
    await smtpMailer(SETTINGS, first.connect).send(MAIL);
    await smtpMailer(SETTINGS, second.connect).send(MAIL);
    const idOf = (wire: string) => /\r\nMessage-ID: <([0-9a-f]{32})@example\.com>\r\n/.exec(wire)?.[1];
    expect(idOf(first.session.bodies[0])).toBeDefined();
    expect(idOf(second.session.bodies[0])).toBeDefined();
    expect(idOf(first.session.bodies[0])).not.toBe(idOf(second.session.bodies[0]));
    const date = /\r\nDate: ([^\r]+)\r\n/.exec(first.session.bodies[0])![1];
    expect(Math.abs(Date.parse(date) - before)).toBeLessThan(5000);
    expect(first.session.bodies[0]).toContain("\r\nAuto-Submitted: auto-generated\r\n");
  });
});

// ---------------------------------------------------------------------------------
// The same client over real sockets, to a fake server on 127.0.0.1 only.
// ---------------------------------------------------------------------------------

// TEST ONLY: a throwaway key and a self-signed certificate, made anew on every run and
// never written to disk. Node has no call that makes a certificate, so the few DER
// pieces one needs are put together here.
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
function utcTime(ms: number): Buffer {
  return der(0x17, Buffer.from(new Date(ms).toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z", "ascii"));
}
function testCertificate(names: { dns: string[]; ip: string[] }): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const sequence = (...parts: Buffer[]) => der(0x30, ...parts);
  const ecdsaSha256 = sequence(oid("1.2.840.10045.4.3.2"));
  // Each certificate has its own name, so one is never taken for another's issuer.
  const serial = randomBytes(8);
  const name = sequence(der(0x31, sequence(oid("2.5.4.3"), der(0x0c, Buffer.from(`test only, not a real server ${serial.toString("hex")}`, "utf8")))));
  const now = Date.now();
  const altNames = sequence(
    ...names.dns.map((dns) => der(0x82, Buffer.from(dns, "ascii"))),
    ...names.ip.map((ip) => der(0x87, Buffer.from(ip.split(".").map(Number)))),
  );
  const extensions = sequence(
    sequence(oid("2.5.29.19"), der(0x01, Buffer.from([0xff])), der(0x04, sequence(der(0x01, Buffer.from([0xff]))))),
    sequence(oid("2.5.29.17"), der(0x04, altNames)),
  );
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([0x01, ...serial])),
    ecdsaSha256,
    name,
    sequence(utcTime(now - 3_600_000), utcTime(now + 86_400_000)),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    der(0xa3, extensions),
  );
  const signature = sign("sha256", tbs, privateKey);
  const certificate = sequence(tbs, ecdsaSha256, der(0x03, Buffer.from([0]), signature));
  const pem = `-----BEGIN CERTIFICATE-----\n${certificate.toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----\n`;
  return { key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), cert: pem };
}

type FakeServer = {
  port: number;
  sessions: Session[];
  /** The server name each client asked for, false when it sent none. */
  names: Array<string | false>;
  protocols: Array<string | null>;
  closed: () => number;
  stop: () => Promise<void>;
};

const running: Array<() => Promise<void>> = [];

async function listening(server: net.Server, sockets: Set<net.Socket>): Promise<{ port: number; stop: () => Promise<void> }> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const stop = () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    });
  running.push(stop);
  return { port: (server.address() as net.AddressInfo).port, stop };
}

/** A fake mail server speaking TLS from the first byte, on 127.0.0.1 and a free port. */
async function fakeServer(pair: { key: string; cert: string }, script: Script = {}, options: tls.TlsOptions = {}): Promise<FakeServer> {
  const sessions: Session[] = [];
  const names: Array<string | false> = [];
  const protocols: Array<string | null> = [];
  const sockets = new Set<net.Socket>();
  let closed = 0;
  const server = tls.createServer({ key: pair.key, cert: pair.cert, ...options }, (socket) => {
    const session = new Session(
      script,
      (text) => void socket.write(text, "latin1"),
      () => socket.end(),
    );
    sessions.push(session);
    names.push((socket as tls.TLSSocket & { servername?: string | false }).servername ?? false);
    protocols.push(socket.getProtocol());
    socket.on("data", (chunk: Buffer) => session.feed(chunk.toString("latin1")));
    socket.on("error", () => {});
    socket.on("close", () => (closed += 1));
    session.start();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("tlsClientError", () => {});
  const { port, stop } = await listening(server, sockets);
  return { port, sessions, names, protocols, closed: () => closed, stop };
}

// The real clock, kept for the tests that replace setTimeout.
const realSetTimeout = globalThis.setTimeout;
const pause = (ms: number) => new Promise<void>((resolve) => void realSetTimeout(resolve, ms));

/** Waits, on the real clock, until `check` holds. */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 600 && !check(); i++) await pause(5);
  expect(check()).toBe(true);
}

describe("smtp client, fake server on 127.0.0.1", () => {
  // Trusted for this file only: the certificate of the fake server on 127.0.0.1.
  const trusted = testCertificate({ dns: ["mail.test"], ip: ["127.0.0.1"] });
  // Never trusted.
  const stranger = testCertificate({ dns: ["mail.test"], ip: ["127.0.0.1"] });
  // Trusted, but made out to another name and to no address.
  const misnamed = testCertificate({ dns: ["other.test"], ip: [] });
  let defaults: string[] | null = null;
  const local = (port: number): SmtpSettings => ({ ...SETTINGS, host: "127.0.0.1", port });

  // The package allows any Node from 24.0, and tls.setDefaultCACertificates came with
  // 24.5. Without it this file cannot make its certificate trusted for the client's own
  // connection, so the tests that need a trusted certificate are skipped, with a line
  // that says so. The tests that need none still run.
  const canTrust = typeof tls.setDefaultCACertificates === "function" && typeof tls.getCACertificates === "function";
  const trustedIt = canTrust ? it : it.skip;
  const SKIP_REASON = `node-smtp: this Node (${process.version}) has no tls.setDefaultCACertificates; the tests that need a trusted test certificate are skipped.`;

  beforeAll(() => {
    if (!canTrust) {
      // Written straight to stderr, so the reason shows whatever the reporter does with console output.
      process.stderr.write(SKIP_REASON + "\n");
      return;
    }
    // Read first, before anything that can throw, so afterAll always has them to put back.
    defaults = tls.getCACertificates("default");
    tls.setDefaultCACertificates([...defaults, trusted.cert, misnamed.cert]);
    expect(new X509Certificate(trusted.cert).subjectAltName).toContain("IP Address:127.0.0.1");
  });
  afterAll(() => {
    if (canTrust && defaults !== null) tls.setDefaultCACertificates(defaults);
  });
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(running.splice(0).map((stop) => stop()));
  });

  trustedIt("a mail goes over TLS to the fake server, once, and the connection is closed", async () => {
    const server = await fakeServer(trusted);
    await smtpMailer(local(server.port)).send(MAIL);
    expect(server.sessions).toHaveLength(1);
    const [session] = server.sessions;
    expect(session.commands).toEqual([
      "EHLO app.example.com",
      `AUTH PLAIN ${PLAIN_TOKEN}`,
      "MAIL FROM:<no-reply@example.com>",
      "RCPT TO:<ada@example.com>",
      "DATA",
      "QUIT",
    ]);
    expect(session.bodies).toHaveLength(1);
    expect(bodyOf(unstuffed(session.bodies[0]))).toBe(MAIL.text.replaceAll("\n", "\r\n"));
    expect(["TLSv1.2", "TLSv1.3"]).toContain(server.protocols[0]);
    await until(() => server.closed() === 1);
    // Three mails are three conversations, each with one message.
    await Promise.all([1, 2, 3].map(() => smtpMailer(local(server.port)).send(MAIL)));
    expect(server.sessions).toHaveLength(4);
    for (const each of server.sessions) expect(each.bodies).toHaveLength(1);
    await until(() => server.closed() === 4);
  });

  trustedIt("the server's name is sent and the certificate must be made out to it", async () => {
    const server = await fakeServer(trusted);
    // The settings name mail.test; only the address dialled is swapped for 127.0.0.1,
    // so no name is looked up. Everything else is the client's own TLS options.
    const refusals: unknown[] = [];
    const dial = (s: SmtpSettings) =>
      new Promise<Duplex>((resolve, reject) => {
        const socket = tls.connect({ ...tlsOptions(s), host: "127.0.0.1", port: server.port });
        socket.once("secureConnect", () => resolve(socket));
        socket.once("error", (error: NodeJS.ErrnoException) => {
          refusals.push(error.code);
          reject(new SmtpError("tls"));
        });
      });
    await smtpMailer(SETTINGS, dial).send(MAIL);
    expect(server.names).toEqual(["mail.test"]);
    expect(server.sessions[0].bodies).toHaveLength(1);
    expect(refusals).toEqual([]);
    // Asked for under another name, the same certificate is refused before a byte of SMTP,
    // and for that reason: the name check is the client's own option, not the test's.
    expect(reasonOf(await outcome(smtpMailer({ ...SETTINGS, host: "elsewhere.test" }, dial).send(MAIL)))).toBe("tls");
    expect(refusals).toEqual(["ERR_TLS_CERT_ALTNAME_INVALID"]);
    expect(server.sessions.filter((s) => s.raw !== "")).toHaveLength(1);
  });

  trustedIt("a certificate that is not trusted, or made out to another name, ends as tls and nothing is said", async () => {
    const unknown = await fakeServer(stranger);
    expect(reasonOf(await outcome(smtpMailer(local(unknown.port)).send(MAIL)))).toBe("tls");
    const other = await fakeServer(misnamed);
    expect(reasonOf(await outcome(smtpMailer(local(other.port)).send(MAIL)))).toBe("tls");
    // The environment switch that turns checking off for other code does not turn it off here.
    const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
      expect(reasonOf(await outcome(smtpMailer(local(unknown.port)).send(MAIL)))).toBe("tls");
    } finally {
      if (before === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = before;
    }
    for (const server of [unknown, other]) {
      for (const session of server.sessions) expect(session.raw).toBe("");
    }
  });

  it("a server that does not speak TLS is refused, and sees no command and no password", async () => {
    const sockets = new Set<net.Socket>();
    let seen = "";
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("data", (chunk: Buffer) => (seen += chunk.toString("latin1")));
      socket.write("220 mail.test ESMTP ready\r\n250-mail.test\r\n250 AUTH PLAIN LOGIN\r\n");
    });
    const { port } = await listening(server, sockets);
    expect(reasonOf(await outcome(smtpMailer(local(port)).send(MAIL)))).toBe("tls");
    for (const text of ["EHLO", "AUTH", "MAIL FROM", PLAIN_TOKEN, b64(PASSWORD), PASSWORD, CODE]) expect(seen).not.toContain(text);
    await until(() => [...sockets].every((socket) => socket.destroyed));
  });

  trustedIt("a server that offers only an old TLS version is refused", async () => {
    const old = { minVersion: "TLSv1.1", maxVersion: "TLSv1.1", ciphers: "DEFAULT@SECLEVEL=0" } as const;
    const server = await fakeServer(trusted, { greeting: null }, old);
    // The control: a client told to accept the old version does get through, so the
    // refusal below is the client's own floor and not a server that cannot serve.
    const reached = await new Promise<string | null>((resolve) => {
      const socket = tls.connect({ host: "127.0.0.1", port: server.port, ...old });
      socket.once("secureConnect", () => {
        resolve(socket.getProtocol());
        socket.destroy();
      });
      socket.once("error", () => resolve(null));
    });
    expect(reached).toBe("TLSv1.1");
    await until(() => server.sessions.length === 1);
    expect(reasonOf(await outcome(smtpMailer(local(server.port)).send(MAIL)))).toBe("tls");
    expect(server.sessions).toHaveLength(1);
  });

  it("nothing listening ends as connect", async () => {
    // A port that is taken and has no listener: the local end of an open connection.
    // While that connection stays open nobody else can be given the port, so this does
    // not lean on a port that was just closed staying free.
    const sockets = new Set<net.Socket>();
    const holder = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
    });
    const held = await listening(holder, sockets);
    const client = net.connect({ host: "127.0.0.1", port: held.port });
    client.on("error", () => {});
    sockets.add(client);
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    const port = client.localPort!;
    expect(port).not.toBe(held.port);
    expect(reasonOf(await outcome(smtpMailer(local(port)).send(MAIL)))).toBe("connect");
    expect(client.destroyed).toBe(false);
    // A port that cannot exist is the same reason, not a crash.
    expect(reasonOf(await outcome(smtpMailer(local(0)).send(MAIL)))).toBe("connect");
    expect(reasonOf(await outcome(smtpMailer(local(70_000)).send(MAIL)))).toBe("connect");
    expect(reasonOf(await outcome(smtpMailer({ ...local(port), host: "" }).send(MAIL)))).toBe("connect");
    expect(reasonOf(await outcome(smtpMailer({ ...local(port), host: "mail.test\r\nx" }).send(MAIL)))).toBe("connect");
  });

  trustedIt("a server that accepts and then never answers is given up on, and the socket is closed", async () => {
    // It takes the connection and never starts TLS.
    const sockets = new Set<net.Socket>();
    const mute = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      // Reads and drops what arrives, so that it notices the client hanging up.
      socket.resume();
    });
    const { port } = await listening(mute, sockets);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled: unknown = null;
    void outcome(smtpMailer(local(port)).send(MAIL)).then((r) => (settled = r));
    await until(() => sockets.size === 1);
    vi.advanceTimersByTime(SMTP_LIMITS.connectMs - 1);
    await pause(20);
    expect(settled).toBeNull();
    vi.advanceTimersByTime(1);
    await until(() => settled !== null);
    expect(reasonOf(settled)).toBe("timeout");
    await until(() => [...sockets].every((socket) => socket.destroyed));

    // It speaks TLS, greets, and goes quiet after EHLO.
    const quiet = await fakeServer(trusted, { ehlo: null });
    settled = null;
    void outcome(smtpMailer(local(quiet.port)).send(MAIL)).then((r) => (settled = r));
    await until(() => quiet.sessions.length === 1 && quiet.sessions[0].commands.length === 1);
    vi.advanceTimersByTime(SMTP_LIMITS.replyMs - 1);
    await pause(20);
    expect(settled).toBeNull();
    vi.advanceTimersByTime(1);
    await until(() => settled !== null);
    expect(reasonOf(settled)).toBe("timeout");
    await until(() => quiet.closed() === 1);
    expect(quiet.sessions[0].raw).not.toContain(PLAIN_TOKEN);
  });

  trustedIt("a mail the server did not confirm is not sent a second time", async () => {
    // The server takes the whole message and never says so: the client reports a
    // timeout and leaves it there. One connection, one message, no second try.
    const server = await fakeServer(trusted, { body: null });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled: unknown = null;
    void outcome(smtpMailer(local(server.port)).send(MAIL)).then((r) => (settled = r));
    await until(() => server.sessions.length === 1 && server.sessions[0].bodies.length === 1);
    vi.advanceTimersByTime(SMTP_LIMITS.totalMs);
    await until(() => settled !== null);
    expect(reasonOf(settled)).toBe("timeout");
    await until(() => server.closed() === 1);
    vi.advanceTimersByTime(120_000);
    await pause(50);
    vi.useRealTimers();
    expect(server.sessions).toHaveLength(1);
    expect(server.sessions[0].bodies).toHaveLength(1);

    // The server drops the line in the middle: refused, one connection, nothing resent.
    const dropping = await fakeServer(trusted, { hangUpAt: "rcpt" });
    expect(reasonOf(await outcome(smtpMailer(local(dropping.port)).send(MAIL)))).toBe("refused");
    await pause(50);
    expect(dropping.sessions).toHaveLength(1);
    expect(dropping.sessions[0].bodies).toHaveLength(0);

    // The server takes the mail and hangs up without a goodbye: it is sent, once.
    const curt = await fakeServer(trusted, { hangUpAt: "quit" });
    await smtpMailer(local(curt.port)).send(MAIL);
    expect(curt.sessions).toHaveLength(1);
    expect(curt.sessions[0].bodies).toHaveLength(1);
  });
});
