// Sends mail from a worker thread, so nothing of a send runs on the main thread but
// posting one small message and taking one small answer. The TLS handshake and the SMTP
// conversation (src/node/smtp.ts, unchanged) run in the worker (./mail-worker.ts).
//
// Why: an address with an account gets a mail and one without does not. Run on the main
// thread, the handshake kept the event loop busy for a few milliseconds after the answer,
// so a request sent just after it was slower for an account than for a stranger, and a
// stranger could tell which addresses have accounts. In the worker it costs the main
// thread only the post and the answer.
//
// Rules this file keeps, each with a test in test/node-mail-thread.test.ts:
// - The settings, the password with them, go to the worker once, when it is made, in its
//   workerData. A message to the worker holds an id and the mail (to, subject, text); a
//   message back holds the id and either ok or a fixed reason and a yes or no, except the
//   worker's first, `{ ready: true }`, which says it loaded and serves mail. Nothing a
//   server said, no setting and no password ever comes back, and an error the worker
//   raises is never read: only that it happened.
// - Failures are the client's own SmtpError, with the same five fixed reasons and the
//   same `bodyWritten`. What this file adds maps onto them (see workerMailer).
// - Nothing is retried, here or in the worker. One mail is handed to the worker at a time;
//   the others wait in a bounded queue on this side, so a mail that never left the queue
//   is known not to have been sent.
// - Every wait has an end, from SMTP_LIMITS: in the queue, and in the worker.
// - The worker is made on the first send, never at the start, and made again on a later
//   send after it died, at most MAIL_WORKER_STARTS_PER_MINUTE times a minute. It holds the
//   event loop only while a mail is on its way, so an idle worker never keeps the process.
// - The worker writes nowhere: its standard output and error are taken here and never read.
// - A worker that cannot start (it cannot be made, was made too often in the last minute,
//   or stopped before it said it was ready) is said in one fixed line on this side,
//   startFailedLine, so the log never makes it look as if a mail server refused.
import { Worker } from "node:worker_threads";
import type { Mail, Mailer } from "../mail.ts";
import { SMTP_LIMITS, SmtpError, type SmtpReason, type SmtpSettings } from "./smtp.ts";

/** The most mails that wait for the one being sent. One more is refused at once, and not sent. */
export const MAIL_QUEUE_MAX = 16;

/** How often the worker may be made in any 60 s, the first time included. A send beyond it is refused, and not sent. */
export const MAIL_WORKER_STARTS_PER_MINUTE = 5;

/**
 * How long a mail may wait in the queue before it is refused, not sent: as long as one
 * whole send may take. A mail handed to the worker gets SMTP_LIMITS.totalMs, the client's
 * own limit, plus MAIL_WORKER_GRACE_MS for the thread to start and answer; a worker that
 * has not answered by then is stopped. So no send waits longer than about twice totalMs.
 */
export const MAIL_QUEUE_WAIT_MS = SMTP_LIMITS.totalMs;
export const MAIL_WORKER_GRACE_MS = 2_000;

/**
 * The worker's module, found next to this one: ./mail-worker.ts beside the source (tests,
 * and Node running the source), ./mail-worker.js beside the build (dist/node/, also in
 * the cPanel archive). Relative to this module, never to the working folder.
 */
export const MAIL_WORKER_URL = new URL(`./mail-worker${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`, import.meta.url);

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";

/** What goes to the worker: an id and one mail. */
export type MailRequest = { id: number; to: string; subject: string; text: string };

/** What comes back: the id, and ok or one of the client's fixed reasons with whether the message had left. */
export type MailAnswer = { id: number; ok: true } | { id: number; ok: false; reason: SmtpReason; bodyWritten: boolean };

/** The data the worker is made with. */
export type MailWorkerData = { settings: SmtpSettings };

/** The worker's first message, once it has loaded and serves mail. It holds nothing else. */
export type MailReady = { ready: true };

/** True for exactly the worker's ready message. */
function isReady(message: unknown): boolean {
  return isRecord(message) && message.ready === true && Object.keys(message).length === 1;
}

/** Why the mail thread could not start: the only words that reach its line. */
export const START_REASONS = {
  notMade: "it could not be made",
  tooOften: `it was started ${MAIL_WORKER_STARTS_PER_MINUTE} times in the last minute`,
  notReady: "it stopped before it was ready",
} as const;

/**
 * The one line written when the mail thread cannot start, with one of the fixed reasons
 * above. It never holds a setting, an address or anything the thread said.
 */
export function startFailedLine(reason: (typeof START_REASONS)[keyof typeof START_REASONS]): string {
  return `mail: the mail thread could not start (${reason}); no mail was sent`;
}

const REASONS: readonly SmtpReason[] = ["connect", "tls", "auth", "refused", "timeout"];

/**
 * The worker's answer for a failed send. Only the reason and the yes or no are taken from
 * an SmtpError; anything else thrown becomes `refused` with `bodyWritten` true, since
 * nothing then says the message had not left.
 */
export function answerFor(id: number, error: unknown): MailAnswer {
  if (error instanceof SmtpError && REASONS.includes(error.reason)) {
    return { id, ok: false, reason: error.reason, bodyWritten: error.bodyWritten === true };
  }
  return { id, ok: false, reason: "refused", bodyWritten: true };
}

/**
 * The failure an answer stands for: null for ok, else a new SmtpError made here from the
 * reason and the yes or no alone. An answer that is not one this file writes is `refused`
 * with `bodyWritten` true: it does not say the message had not left.
 */
export function failureOf(answer: unknown): SmtpError | null {
  if (isRecord(answer) && answer.ok === true) return null;
  if (isRecord(answer) && answer.ok === false && typeof answer.reason === "string" && (REASONS as readonly string[]).includes(answer.reason) && typeof answer.bodyWritten === "boolean") {
    return new SmtpError(answer.reason as SmtpReason, answer.bodyWritten);
  }
  return new SmtpError("refused", true);
}

/** The side of a message port the worker serves: messages in, answers out. */
export type MailPort = { on(event: "message", listener: (message: unknown) => void): unknown; postMessage(message: MailAnswer | MailReady): void };

/**
 * The worker's loop: first `{ ready: true }`, once the loop listens; then each message is
 * one mail for `mailer`, sent one after the other, and answered with its id. A message
 * that is not a mail is answered `refused`, not sent. Never retries, and never throws into
 * the port.
 */
export function serveMail(port: MailPort, mailer: Mailer): void {
  let chain: Promise<void> = Promise.resolve();
  const one = async (message: unknown): Promise<void> => {
    const id = isRecord(message) && Number.isSafeInteger(message.id) ? (message.id as number) : -1;
    let answer: MailAnswer;
    if (!isRecord(message) || id < 0 || typeof message.to !== "string" || typeof message.subject !== "string" || typeof message.text !== "string") {
      answer = { id, ok: false, reason: "refused", bodyWritten: false };
    } else {
      try {
        await mailer.send({ to: message.to, subject: message.subject, text: message.text });
        answer = { id, ok: true };
      } catch (error) {
        answer = answerFor(id, error);
      }
    }
    try {
      port.postMessage(answer);
    } catch {
      // A port that is gone has nobody to tell.
    }
  };
  port.on("message", (message) => {
    chain = chain.then(() => one(message));
  });
  try {
    port.postMessage({ ready: true });
  } catch {
    // A port that is gone has nobody to tell.
  }
}

/** A mailer whose work can be ended: `close` refuses what waits, ends what is on its way, and stops the worker. */
export type ClosableMailer = Mailer & {
  close(): Promise<void>;
  /** For tests and checks: how often the worker was made, whether one is there, and what waits. */
  stats(): { starts: number; running: boolean; busy: boolean; queued: number };
};

export type WorkerMailerOptions = {
  /** The worker's module; tests hand in one of their own. */
  workerUrl?: URL;
  /** Limits in place of the defaults above (tests). */
  queueWaitMs?: number;
  runLimitMs?: number;
  now?: () => number;
  /** Where the line for a thread that cannot start goes (tests); the error log by default. */
  log?: (line: string) => void;
};

type Pending = { request: MailRequest; resolve: () => void; reject: (error: SmtpError) => void; timer: ReturnType<typeof setTimeout> | null };

/**
 * A mailer that sends each mail through the SMTP client in a worker thread made with `s`.
 * Making it starts nothing and contacts nothing; the worker is made by the first send.
 *
 * A send resolves when the server took the mail and rejects with an SmtpError, as the
 * client's own. Beyond the client's failures:
 * - Refused at once, not sent (`refused`, `bodyWritten` false): a mail that is not three
 *   strings, a full queue (MAIL_QUEUE_MAX waiting), a worker that could not be made or was
 *   made too often in the last minute, a mailer that was closed, and a mail still in the
 *   queue after MAIL_QUEUE_WAIT_MS or when the worker died or was stopped.
 * - The mail that was with the worker when it died, or when its answer was not one this
 *   file writes: `refused`, `bodyWritten` true (it may have been taken).
 * - The mail that was with the worker when its time ran out (SMTP_LIMITS.totalMs plus
 *   MAIL_WORKER_GRACE_MS), or when the mailer was closed: `timeout`, `bodyWritten` true.
 *   The worker is stopped then, and made again by the next send.
 */
export function workerMailer(s: SmtpSettings, options: WorkerMailerOptions = {}): ClosableMailer {
  const workerUrl = options.workerUrl ?? MAIL_WORKER_URL;
  const queueWaitMs = options.queueWaitMs ?? MAIL_QUEUE_WAIT_MS;
  const runLimitMs = options.runLimitMs ?? SMTP_LIMITS.totalMs + MAIL_WORKER_GRACE_MS;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((line: string) => console.error(line));
  // Copied once: what the caller does to its object later changes nothing here.
  const settings: SmtpSettings = isRecord(s) ? { host: s.host, port: s.port, user: s.user, password: s.password, from: s.from, helo: s.helo } : (s as SmtpSettings);

  let worker: Worker | null = null;
  let current: Pending | null = null;
  let runTimer: ReturnType<typeof setTimeout> | null = null;
  const queue: Pending[] = [];
  const startedAt: number[] = [];
  let starts = 0;
  let closed = false;
  let lastId = 0;

  const notSent = () => new SmtpError("refused", false);

  const settle = (p: Pending, failure: SmtpError | null) => {
    if (p.timer !== null) clearTimeout(p.timer);
    p.timer = null;
    if (failure === null) p.resolve();
    else p.reject(failure);
  };

  /** Ends the one on its way with `failure`, refuses everything waiting, and stops the worker. */
  const drop = (failure: SmtpError): Promise<void> => {
    const gone = worker;
    worker = null;
    if (runTimer !== null) clearTimeout(runTimer);
    runTimer = null;
    const was = current;
    current = null;
    if (was !== null) settle(was, failure);
    for (const waiting of queue.splice(0)) settle(waiting, notSent());
    if (gone === null) return Promise.resolve();
    gone.removeAllListeners("message");
    return gone.terminate().then(
      () => {},
      () => {},
    );
  };

  const make = (): Worker | null => {
    const at = now();
    while (startedAt.length > 0 && at - startedAt[0] >= 60_000) startedAt.shift();
    if (startedAt.length >= MAIL_WORKER_STARTS_PER_MINUTE) {
      log(startFailedLine(START_REASONS.tooOften));
      return null;
    }
    startedAt.push(at);
    starts += 1;
    // Set by the worker's first message: until then, a worker that stops never started.
    let ready = false;
    let made: Worker;
    try {
      const workerData: MailWorkerData = { settings };
      // No environment: the worker needs none, so it holds no other setting. Its output
      // is taken here and never read, so nothing it could print reaches a log. (Reading
      // it would keep the process alive: a stream that flows holds the event loop. The
      // worker prints nothing, so nothing piles up unread.) None of the flags this process
      // was started with either: one meant for it (such as --input-type) can stop a worker
      // from loading at all.
      made = new Worker(workerUrl, { workerData, env: {}, execArgv: [], stdout: true, stderr: true, name: "mail" });
    } catch {
      log(startFailedLine(START_REASONS.notMade));
      return null;
    }
    made.on("message", (answer: unknown) => {
      if (made !== worker) return;
      if (isReady(answer)) {
        ready = true;
        return;
      }
      if (current === null) return;
      if (!isRecord(answer) || answer.id !== current.request.id) {
        void drop(new SmtpError("refused", true));
        return;
      }
      const done = current;
      current = null;
      if (runTimer !== null) clearTimeout(runTimer);
      runTimer = null;
      settle(done, failureOf(answer));
      if (queue.length === 0) made.unref();
      pump();
    });
    // The error itself is never read: it could hold anything.
    const died = () => {
      if (made !== worker) return;
      if (!ready) log(startFailedLine(START_REASONS.notReady));
      void drop(new SmtpError("refused", true));
    };
    made.on("error", died);
    made.on("messageerror", died);
    made.on("exit", died);
    made.unref();
    return made;
  };

  const pump = (): void => {
    while (current === null && queue.length > 0) {
      const next = queue.shift() as Pending;
      if (next.timer !== null) clearTimeout(next.timer);
      next.timer = null;
      if (closed) {
        settle(next, notSent());
        continue;
      }
      worker ??= make();
      const w = worker;
      if (w === null) {
        settle(next, notSent());
        continue;
      }
      current = next;
      // Held while a mail is on its way, so the process does not end in the middle of one.
      w.ref();
      runTimer = setTimeout(() => void drop(new SmtpError("timeout", true)), runLimitMs);
      try {
        w.postMessage(next.request);
      } catch {
        current = null;
        if (runTimer !== null) clearTimeout(runTimer);
        runTimer = null;
        if (queue.length === 0) w.unref();
        settle(next, notSent());
      }
    }
  };

  return {
    send(mail: Mail): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        if (closed) return reject(notSent());
        if (!isRecord(mail) || typeof mail.to !== "string" || typeof mail.subject !== "string" || typeof mail.text !== "string") return reject(notSent());
        if (queue.length >= MAIL_QUEUE_MAX) return reject(notSent());
        lastId += 1;
        const pending: Pending = { request: { id: lastId, to: mail.to, subject: mail.subject, text: mail.text }, resolve, reject, timer: null };
        pending.timer = setTimeout(() => {
          const at = queue.indexOf(pending);
          if (at < 0) return;
          queue.splice(at, 1);
          settle(pending, notSent());
        }, queueWaitMs);
        queue.push(pending);
        pump();
      });
    },
    close(): Promise<void> {
      closed = true;
      return drop(new SmtpError("timeout", true));
    },
    stats() {
      return { starts, running: worker !== null, busy: current !== null, queued: queue.length };
    },
  };
}
