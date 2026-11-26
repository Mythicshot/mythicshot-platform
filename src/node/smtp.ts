// Sends one mail through a mail server: SMTP over TLS from the first byte (port 465),
// signed in as one mailbox. Written against node:tls only; the connection can be handed
// in, which is how the tests run it without a socket.
//
// Rules this file keeps, each with a test in test/node-smtp.test.ts:
// - Nothing is said before TLS is up and the certificate was checked against the host.
// - The password leaves only after the server offered a sign-in this client speaks.
// - Every wait has an end: the connection, each reply, and the whole conversation.
// - One send is one try. Nothing is retried here, so nothing can be sent twice by this
//   file. A caller that retries may send twice: once the message itself was written,
//   a failure (`refused` or `timeout`) does not tell whether the server took the mail.
//   Only `connect`, `tls` and `auth` are certain non-sends, as is any failure whose
//   `bodyWritten` is false.
// - Every failure of a send is an SmtpError, whatever was handed in.
// - A failure is one of five fixed reasons. The server's words, the password, the
//   recipient and the mail's text never enter an error, and this file writes no log.
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import * as tls from "node:tls";
import type { Mail, Mailer } from "../mail.ts";

/** `host` and `port` of the mail server, the mailbox's sign-in, the sender address, and the name this site gives in EHLO. */
export type SmtpSettings = { host: string; port: number; user: string; password: string; from: string; helo: string };

/**
 * Why a mail was not handed over. `connect`: the server could not be reached. `tls`:
 * it was reached but did not prove who it is over TLS 1.2 or later. `auth`: it did not
 * accept the mailbox's sign-in, or offers none this client speaks. `refused`: it, or
 * this client's own check, turned the mail down, or the conversation broke. `timeout`:
 * a wait ran out.
 *
 * What a reason says about the mail: `connect`, `tls` and `auth` always mean it was not
 * sent. `refused` and `timeout` mean that only while SmtpError.bodyWritten is false;
 * after the message was written (after DATA) neither tells whether the server took it.
 */
export type SmtpReason = "connect" | "tls" | "auth" | "refused" | "timeout";

/**
 * The only error this file throws. Its text is `smtp: <reason>` and nothing else.
 * `bodyWritten` is true when the message itself had been written to the server before
 * the failure: the mail may then have been taken, and sending it again may deliver it
 * twice. False means the mail was certainly not sent. It is a yes or no and holds no text.
 */
export class SmtpError extends Error {
  readonly reason: SmtpReason;
  readonly bodyWritten: boolean;
  constructor(reason: SmtpReason, bodyWritten: boolean = false) {
    super(`smtp: ${reason}`);
    this.name = "SmtpError";
    this.reason = reason;
    // The other three end the conversation before any message, whatever the caller says.
    this.bodyWritten = bodyWritten === true && (reason === "refused" || reason === "timeout");
  }
}

/** The longest waits: for the connection with TLS up, for one reply, and for one whole send. */
export const SMTP_LIMITS = Object.freeze({ connectMs: 10_000, replyMs: 15_000, totalMs: 30_000 } as const);

/** The largest text one mail may carry, in UTF-8 bytes. A subject is at most 255 characters. */
export const MAX_TEXT_BYTES = 100_000;

/** The most one reply may hold before the conversation is ended. */
const MAX_REPLY_BYTES = 65_536;
const MAX_REPLY_LINES = 100;

/**
 * How the connection is made, as data: the certificate must be valid for the host
 * (never switched off, whatever the environment says), the host's name is sent so the
 * server can pick its certificate, and nothing older than TLS 1.2 is spoken. An IP
 * address has no name to send; the certificate is then checked against the address.
 */
export function tlsOptions(s: SmtpSettings): tls.ConnectionOptions {
  const options: tls.ConnectionOptions = { host: s.host, port: s.port, rejectUnauthorized: true, minVersion: "TLSv1.2" };
  if (isIP(s.host) === 0) options.servername = s.host;
  return options;
}

// One mailbox address as this client writes it: plain ASCII, one @, no spaces, no
// angle brackets, no quotes, no control character. Stricter than the mail standards,
// so that nothing in an address can end a line or an envelope argument.
const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}$/;
const DOMAIN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const SUBJECT = /^[^\p{Cc}\p{Zl}\p{Zp}]{1,255}$/u;
const HELO = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[(?:IPv6:)?[0-9A-Fa-f:.]{2,45}\])$/;
const HOST = /^[A-Za-z0-9.:-]{1,255}$/;
const MESSAGE_ID = /^[A-Za-z0-9._-]{1,64}$/;

function isAddress(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 254) return false;
  const at = value.indexOf("@");
  if (at < 1 || at !== value.lastIndexOf("@")) return false;
  return LOCAL_PART.test(value.slice(0, at)) && DOMAIN.test(value.slice(at + 1));
}

/** The most pictures one mail may carry inline, and the most bytes each may have. */
export const MAX_INLINE = 4;
export const MAX_INLINE_BYTES = 100_000;

// A Content-ID as this client writes it, between angle brackets: an id, one @, a domain-like
// part, nothing that could end a header line. A picture's file name: lower case, short.
const CONTENT_ID = /^[A-Za-z0-9._-]{1,64}@[A-Za-z0-9.-]{1,64}$/;
const PICTURE_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;

const tooLong = (text: unknown): boolean => typeof text !== "string" || text.length > MAX_TEXT_BYTES || Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES;

function checkEnvelope(mail: Mail, from: string): void {
  if (mail === null || typeof mail !== "object") throw new SmtpError("refused");
  if (!isAddress(mail.to) || !isAddress(from)) throw new SmtpError("refused");
  if (typeof mail.subject !== "string" || !SUBJECT.test(mail.subject)) throw new SmtpError("refused");
  if (tooLong(mail.text)) throw new SmtpError("refused");
  // The designed part (0.1.66): text like the plain part, and pictures only beside it.
  if (mail.html !== undefined && tooLong(mail.html)) throw new SmtpError("refused");
  if (mail.inline !== undefined) {
    if (mail.html === undefined || !Array.isArray(mail.inline) || mail.inline.length > MAX_INLINE) throw new SmtpError("refused");
    const ids = new Set<string>();
    for (const p of mail.inline) {
      if (p === null || typeof p !== "object" || typeof p.cid !== "string" || !CONTENT_ID.test(p.cid) || ids.has(p.cid)) throw new SmtpError("refused");
      if (p.contentType !== "image/png" || typeof p.name !== "string" || !PICTURE_NAME.test(p.name)) throw new SmtpError("refused");
      if (!(p.bytes instanceof Uint8Array) || p.bytes.length === 0 || p.bytes.length > MAX_INLINE_BYTES) throw new SmtpError("refused");
      ids.add(p.cid);
    }
  }
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dateHeader(now: number): string {
  const d = new Date(now);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]}, ${two(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} +0000`;
}

/** A subject as a header value: as it is when plain ASCII, else as UTF-8 encoded words on folded lines. */
function subjectHeader(subject: string): string {
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  const words: string[] = [];
  let piece = "";
  for (const char of subject) {
    if (Buffer.byteLength(piece + char, "utf8") > 39) {
      words.push(piece);
      piece = "";
    }
    piece += char;
  }
  words.push(piece);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`).join("\r\n ");
}

/**
 * The whole message, headers and text, every line ending in CRLF, in ASCII only. Text
 * that is plain ASCII in lines of at most 998 characters travels as it is; any other
 * text travels as base64. Line breaks of any kind in the text become CRLF, so no line
 * of the text can pass for the end of the message. Dots are doubled later, on the wire.
 * `messageId` is the part before the @; the sender's domain follows it. Throws
 * SmtpError("refused") for an address, subject, id or time that is not usable.
 */
export function buildMessage(mail: Mail, from: string, now: number, messageId: string): string {
  checkEnvelope(mail, from);
  if (typeof messageId !== "string" || !MESSAGE_ID.test(messageId)) throw new SmtpError("refused");
  if (typeof now !== "number" || !Number.isFinite(now) || Number.isNaN(new Date(now).getTime())) throw new SmtpError("refused");
  // A designed mail has its own shape; a mail without `html` is built below exactly as before it existed.
  if (mail.html !== undefined) return designedMessage(mail, mail.html, from, now, messageId);
  const lines = mail.text.split(/\r\n|\r|\n/);
  const plain = lines.every((line) => /^[\t\x20-\x7e]{0,998}$/.test(line));
  let body = lines.join("\r\n");
  if (!body.endsWith("\r\n")) body += "\r\n";
  if (!plain) body = Buffer.from(body, "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n");
  return [
    `From: ${from}`,
    `To: ${mail.to}`,
    `Subject: ${subjectHeader(mail.subject)}`,
    `Date: ${dateHeader(now)}`,
    `Message-ID: <${messageId}@${from.slice(from.indexOf("@") + 1)}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    `Content-Transfer-Encoding: ${plain ? "7bit" : "base64"}`,
    // Tells vacation responders and list software that no person wrote this.
    "Auto-Submitted: auto-generated",
    "X-Auto-Response-Suppress: All",
    "",
    body,
  ].join("\r\n");
}

/** Bytes as base64 in lines of 76 characters, each ending in CRLF. */
const base64Lines = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64").replace(/.{1,76}/g, "$&\r\n");

/**
 * A mail with an HTML part (0.1.66), as multipart/alternative: the plain text first, then the
 * HTML, so a client that shows only text shows the text. With pictures, the HTML part is a
 * multipart/related part holding the HTML and each picture under its Content-ID, so the mail
 * shows them with no request anywhere. The headers are those of a plain mail but the content
 * type. The text travels as a plain mail's does (as it is when plain ASCII in short lines, else
 * base64), the HTML and the pictures always as base64, so no line of them can pass for a
 * boundary or for the end of the message. The boundaries are made from the message id; a text
 * line that starts as a boundary does sends the text as base64 too.
 */
function designedMessage(mail: Mail, html: string, from: string, now: number, messageId: string): string {
  const alternative = `=_alt_${messageId}`;
  const related = `=_rel_${messageId}`;
  const lines = mail.text.split(/\r\n|\r|\n/);
  const plain = lines.every((line) => /^[\t\x20-\x7e]{0,998}$/.test(line) && !line.startsWith("--=_"));
  let text = lines.join("\r\n");
  if (!text.endsWith("\r\n")) text += "\r\n";
  if (!plain) text = base64Lines(new TextEncoder().encode(text));
  const htmlPart = ["Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", base64Lines(new TextEncoder().encode(html))].join("\r\n");
  const pictures = mail.inline ?? [];
  const second =
    pictures.length === 0
      ? htmlPart
      : [
          `Content-Type: multipart/related; boundary="${related}"; type="text/html"`,
          "",
          `--${related}`,
          htmlPart,
          ...pictures.map((p) =>
            [`--${related}`, `Content-Type: ${p.contentType}`, "Content-Transfer-Encoding: base64", `Content-ID: <${p.cid}>`, `Content-Disposition: inline; filename="${p.name}"`, "", base64Lines(p.bytes)].join("\r\n"),
          ),
          `--${related}--`,
        ].join("\r\n");
  return [
    `From: ${from}`,
    `To: ${mail.to}`,
    `Subject: ${subjectHeader(mail.subject)}`,
    `Date: ${dateHeader(now)}`,
    `Message-ID: <${messageId}@${from.slice(from.indexOf("@") + 1)}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${alternative}"`,
    "Auto-Submitted: auto-generated",
    "X-Auto-Response-Suppress: All",
    "",
    `--${alternative}`,
    "Content-Type: text/plain; charset=utf-8",
    `Content-Transfer-Encoding: ${plain ? "7bit" : "base64"}`,
    "",
    text,
    `--${alternative}`,
    second,
    `--${alternative}--`,
    "",
  ].join("\r\n");
}

/** The message as it goes after DATA: a leading dot doubled on every line, then the dot that ends it. */
function onTheWire(message: string): string {
  return (
    message
      .split("\r\n")
      .map((line) => (line.startsWith(".") ? "." + line : line))
      .join("\r\n") + ".\r\n"
  );
}

type Reply = { code: number; lines: string[] };

/** One open connection: writes lines, reads whole replies, and ends on the first thing that goes wrong. */
class Wire {
  private buffer = "";
  private failure: SmtpReason | null = null;
  private over = false;
  private waiter: { resolve: (reply: Reply) => void; reject: (error: SmtpError) => void; timer: ReturnType<typeof setTimeout> } | null = null;

  private readonly stream: Duplex;

  constructor(stream: Duplex) {
    this.stream = stream;
    stream.on("data", (chunk: Buffer | string) => {
      if (this.over || this.failure !== null) return;
      this.buffer += typeof chunk === "string" ? chunk : chunk.toString("latin1");
      if (this.buffer.length > MAX_REPLY_BYTES) return this.fail("refused");
      this.deliver();
    });
    // These stay for the life of the stream, so a late error is never left unheard.
    stream.on("error", () => this.fail("refused"));
    stream.on("end", () => this.fail("refused"));
    stream.on("close", () => this.fail("refused"));
  }

  /** Ends the conversation for `reason`, unless it already ended. The first reason stands. */
  fail(reason: SmtpReason): void {
    if (this.over) return;
    if (this.failure === null) this.failure = reason;
    this.buffer = "";
    this.stream.destroy();
    const waiter = this.waiter;
    if (waiter !== null) {
      this.waiter = null;
      clearTimeout(waiter.timer);
      waiter.reject(new SmtpError(this.failure));
    }
  }

  /** Closes the connection. Always called, whatever happened before. */
  close(): void {
    this.over = true;
    this.buffer = "";
    const waiter = this.waiter;
    if (waiter !== null) {
      this.waiter = null;
      clearTimeout(waiter.timer);
      waiter.reject(new SmtpError(this.failure ?? "refused"));
    }
    this.stream.destroy();
  }

  /** A whole reply taken off the buffer, null when its last line is still to come. */
  private take(): Reply | null {
    const lines: string[] = [];
    let code = "";
    let at = 0;
    for (;;) {
      const end = this.buffer.indexOf("\n", at);
      if (end < 0) return null;
      let line = this.buffer.slice(at, end);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      at = end + 1;
      const match = /^([2-5][0-9]{2})(?:([ -])(.*))?$/.exec(line);
      if (match === null || (code !== "" && match[1] !== code) || lines.length >= MAX_REPLY_LINES) throw new SmtpError("refused");
      code = match[1];
      lines.push(match[3] ?? "");
      if (match[2] !== "-") {
        this.buffer = this.buffer.slice(at);
        return { code: Number(code), lines };
      }
    }
  }

  private deliver(): void {
    if (this.waiter === null) return;
    let reply: Reply | null;
    try {
      reply = this.take();
    } catch {
      return this.fail("refused");
    }
    if (reply === null) return;
    const waiter = this.waiter;
    this.waiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(reply);
  }

  /** The server's next reply, whole. Waits at most SMTP_LIMITS.replyMs. */
  reply(): Promise<Reply> {
    return new Promise<Reply>((resolve, reject) => {
      if (this.over || this.failure !== null) return reject(new SmtpError(this.failure ?? "refused"));
      const timer = setTimeout(() => this.fail("timeout"), SMTP_LIMITS.replyMs);
      this.waiter = { resolve, reject, timer };
      this.deliver();
    });
  }

  /**
   * Writes `text` and returns the reply to it. Refuses to write while something the
   * server sent is still unread: an extra reply that arrived together with the last one
   * (or before this call) ends the conversation instead of being taken for the answer
   * to this command. It cannot catch an extra reply that arrives after `text` was
   * written; that one is read as the answer. `written` is called just before the write.
   */
  ask(text: string, written?: () => void): Promise<Reply> {
    if (this.over || this.failure !== null) return Promise.reject(new SmtpError(this.failure ?? "refused"));
    if (this.buffer !== "") {
      this.fail("refused");
      return Promise.reject(new SmtpError("refused"));
    }
    try {
      written?.();
      this.stream.write(text, "latin1");
    } catch {
      this.fail("refused");
      return Promise.reject(new SmtpError("refused"));
    }
    return this.reply();
  }
}

/** The connection this client makes itself: TLS from the first byte, checked, within the time allowed. */
function openTls(s: SmtpSettings): Promise<Duplex> {
  return new Promise<Duplex>((resolve, reject) => {
    let reached = false;
    let settled = false;
    let socket: tls.TLSSocket;
    try {
      socket = tls.connect(tlsOptions(s));
    } catch {
      return reject(new SmtpError("connect"));
    }
    const fail = (reason: SmtpReason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(new SmtpError(reason));
    };
    const timer = setTimeout(() => fail("timeout"), SMTP_LIMITS.connectMs);
    socket.once("connect", () => {
      reached = true;
    });
    socket.once("secureConnect", () => {
      if (settled) return;
      // rejectUnauthorized already ends an unchecked connection; this is the second lock.
      if (socket.authorized !== true || socket.encrypted !== true) return fail("tls");
      settled = true;
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on("error", () => fail(reached ? "tls" : "connect"));
    socket.once("close", () => fail(reached ? "tls" : "connect"));
  });
}

/** `connect`, held to SMTP_LIMITS.connectMs. A connection that arrives after that is closed unused. */
function openWithin(connect: (s: SmtpSettings) => Promise<Duplex>, s: SmtpSettings): Promise<Duplex> {
  return new Promise<Duplex>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new SmtpError("timeout"));
    }, SMTP_LIMITS.connectMs);
    let pending: Promise<Duplex>;
    try {
      pending = Promise.resolve(connect(s));
    } catch {
      pending = Promise.reject(new SmtpError("connect"));
    }
    pending.then(
      (stream) => {
        if (settled) {
          stream.on("error", () => {});
          stream.destroy();
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(stream);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Only the reason is taken from a connector's failure, never its text.
        reject(new SmtpError(error instanceof SmtpError ? error.reason : "connect"));
      },
    );
  });
}

/** The sign-in ways the server offered that this client speaks. Nothing else of the reply is kept. */
function offered(lines: string[]): { plain: boolean; login: boolean } {
  const found = { plain: false, login: false };
  for (const line of lines.slice(1)) {
    const match = /^AUTH[ =](.*)$/i.exec(line);
    if (match === null) continue;
    for (const way of match[1].toUpperCase().split(/\s+/)) {
      if (way === "PLAIN") found.plain = true;
      if (way === "LOGIN") found.login = true;
    }
  }
  return found;
}

const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

async function expectCode(pending: Promise<Reply>, codes: number[], otherwise: SmtpReason): Promise<Reply> {
  const reply = await pending;
  if (!codes.includes(reply.code)) throw new SmtpError(otherwise);
  return reply;
}

/** The conversation, from the greeting to the server taking the message. `bodyWritten` is called when the message leaves. */
async function converse(wire: Wire, s: SmtpSettings, mail: Mail, message: string, bodyWritten: () => void): Promise<void> {
  await expectCode(wire.reply(), [220], "refused");
  const hello = await expectCode(wire.ask(`EHLO ${s.helo}\r\n`), [250], "refused");
  const ways = offered(hello.lines);
  if (ways.plain) {
    await expectCode(wire.ask(`AUTH PLAIN ${base64(`\0${s.user}\0${s.password}`)}\r\n`), [235], "auth");
  } else if (ways.login) {
    await expectCode(wire.ask("AUTH LOGIN\r\n"), [334], "auth");
    await expectCode(wire.ask(`${base64(s.user)}\r\n`), [334], "auth");
    await expectCode(wire.ask(`${base64(s.password)}\r\n`), [235], "auth");
  } else {
    // No sign-in offered that this client speaks: the password stays here.
    throw new SmtpError("auth");
  }
  await expectCode(wire.ask(`MAIL FROM:<${s.from}>\r\n`), [250], "refused");
  await expectCode(wire.ask(`RCPT TO:<${mail.to}>\r\n`), [250, 251], "refused");
  await expectCode(wire.ask("DATA\r\n"), [354], "refused");
  // Only 250 means the server took the mail.
  await expectCode(wire.ask(onTheWire(message), bodyWritten), [250], "refused");
}

async function deliver(s: SmtpSettings, connect: (s: SmtpSettings) => Promise<Duplex>, mail: Mail): Promise<void> {
  let wire: Wire | null = null;
  let expired = false;
  let bodyWritten = false;
  let total: ReturnType<typeof setTimeout> | null = null;
  try {
    // Everything is checked before a connection exists, so a refusal writes nothing.
    if (s === null || typeof s !== "object") throw new SmtpError("refused");
    checkEnvelope(mail, s.from);
    if (typeof s.helo !== "string" || !HELO.test(s.helo)) throw new SmtpError("refused");
    for (const secret of [s.user, s.password]) {
      if (typeof secret !== "string" || secret === "" || secret.includes("\0")) throw new SmtpError("auth");
    }
    if (typeof s.host !== "string" || !HOST.test(s.host)) throw new SmtpError("connect");
    if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) throw new SmtpError("connect");
    const message = buildMessage(mail, s.from, Date.now(), randomBytes(16).toString("hex"));

    total = setTimeout(() => {
      expired = true;
      wire?.fail("timeout");
    }, SMTP_LIMITS.totalMs);
    const stream = await openWithin(connect, s);
    wire = new Wire(stream);
    if (expired) throw new SmtpError("timeout");
    await converse(wire, s, mail, message, () => {
      bodyWritten = true;
    });
    // The server has taken the mail. Whatever happens to the goodbye, it is sent, and
    // saying otherwise could make a caller send it again. The goodbye still falls
    // under the same waits.
    try {
      await wire.ask("QUIT\r\n");
    } catch {
      // Nothing to do: the mail is with the server.
    }
  } catch (error) {
    // Only this file's own fixed reasons leave it, with whether the message had left.
    throw new SmtpError(error instanceof SmtpError ? error.reason : "refused", bodyWritten);
  } finally {
    if (total !== null) clearTimeout(total);
    wire?.close();
  }
}

/**
 * A mailer that hands each mail to the mail server in `s`, one connection per mail.
 * `connect` replaces the way the connection is made (tests hand in one that lives in
 * memory); without it the connection is TLS as tlsOptions describes. A send rejects
 * with an SmtpError and nothing else, whatever was handed in.
 *
 * A send that resolves was taken by the server. One that rejects with `connect`, `tls`
 * or `auth`, or with `bodyWritten` false, was not sent. One that rejects with `refused`
 * or `timeout` and `bodyWritten` true may have been taken all the same: the server had
 * the whole message and did not confirm it. Sending that mail again can deliver it twice.
 */
export function smtpMailer(s: SmtpSettings, connect: (s: SmtpSettings) => Promise<Duplex> = openTls): Mailer {
  return {
    send(mail: Mail): Promise<void> {
      return deliver(s, connect, mail);
    },
  };
}
