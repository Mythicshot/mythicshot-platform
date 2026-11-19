// The mail worker: a thread made by workerMailer (./mail-thread.ts) that sends each mail
// it is given through the SMTP client (./smtp.ts) and answers with the outcome. The
// settings come once, in workerData; a message holds only a mail. Loaded any other way
// than as that worker, it does nothing.
//
// It writes nothing, anywhere: its standard output and error are switched off here, first,
// so not even a stray warning can carry a setting out. (The mailer also takes both
// streams and never reads them; a write that reached one unread would hold the process.)
import { parentPort, workerData } from "node:worker_threads";
import { serveMail, type MailWorkerData } from "./mail-thread.ts";
import { smtpMailer } from "./smtp.ts";

if (parentPort !== null) {
  for (const stream of [process.stdout, process.stderr]) stream.write = (() => true) as typeof stream.write;
  serveMail(parentPort, smtpMailer((workerData as MailWorkerData | null)?.settings as MailWorkerData["settings"]));
}
