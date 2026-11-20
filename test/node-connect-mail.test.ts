// The mail when the desktop app has collected its token, on the Node target's real path:
// the route, the job after the answer, and the SMTP client talking to a scripted mail
// server in memory (no socket, no name looked up, nothing contacted). What arrives is
// checked as a mail server would store it: its headers and its text.
import { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
import { makeDeps, seedAccount } from "#harness";
import { POLL_GAP_MS } from "../src/connect.ts";
import { smtpMailer, type SmtpSettings } from "../src/node/smtp.ts";
import type { Deps } from "../src/ports.ts";
import { SESSION_COOKIE, createSignInCode, csrfFor, redeemSignInCode } from "../src/sessions.ts";
import { ORIGIN, send } from "./bundle.ts";

const NOW = 1_800_000_000_000;
const SETTINGS: SmtpSettings = { host: "mail.test", port: 465, user: "no-reply@example.com", password: "pw-test-only", from: "no-reply@example.com", helo: "app.example.com" };

/** A mail server in memory that takes every mail and keeps what it was sent. */
function memoryServer() {
  const sessions: { commands: string[]; bodies: string[] }[] = [];
  const connect = async (): Promise<Duplex> => {
    const session = { commands: [] as string[], bodies: [] as string[] };
    sessions.push(session);
    let pending = "";
    let inData = false;
    const stream: Duplex = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, done) {
        pending += chunk.toString("latin1");
        for (;;) {
          if (inData) {
            const end = pending.indexOf("\r\n.\r\n");
            if (end < 0) break;
            session.bodies.push(pending.slice(0, end + 2));
            pending = pending.slice(end + 5);
            inData = false;
            stream.push("250 2.0.0 queued\r\n", "latin1");
            continue;
          }
          const end = pending.indexOf("\r\n");
          if (end < 0) break;
          const line = pending.slice(0, end);
          pending = pending.slice(end + 2);
          session.commands.push(line);
          const verb = line.toUpperCase();
          if (verb.startsWith("EHLO ")) stream.push("250-mail.test\r\n250 AUTH PLAIN LOGIN\r\n", "latin1");
          else if (verb.startsWith("AUTH PLAIN ")) stream.push("235 2.7.0 accepted\r\n", "latin1");
          else if (verb.startsWith("MAIL FROM:")) stream.push("250 2.1.0 ok\r\n", "latin1");
          else if (verb.startsWith("RCPT TO:")) stream.push("250 2.1.5 ok\r\n", "latin1");
          else if (verb === "DATA") {
            inData = true;
            stream.push("354 end with a dot\r\n", "latin1");
          } else if (verb === "QUIT") {
            stream.push("221 2.0.0 bye\r\n", "latin1");
            stream.push(null);
          } else stream.push("500 what\r\n", "latin1");
        }
        done();
      },
    });
    queueMicrotask(() => stream.push("220 mail.test ESMTP ready\r\n", "latin1"));
    return stream;
  };
  return { sessions, connect };
}

/** A stored message split into its headers (as name and value) and its text, dots unstuffed and base64 read. */
function stored(wire: string): { headers: [string, string][]; text: string } {
  const message = wire
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? line.slice(1) : line))
    .join("\r\n");
  const cut = message.indexOf("\r\n\r\n");
  const headers = message
    .slice(0, cut)
    .split("\r\n")
    .map((line): [string, string] => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]);
  const raw = message.slice(cut + 4);
  const base64 = headers.some(([name, value]) => name === "Content-Transfer-Encoding" && value === "base64");
  return { headers, text: base64 ? Buffer.from(raw.replace(/\r\n/g, ""), "base64").toString("utf8") : raw };
}

/** A site on the Node target whose mail goes through the SMTP client to the server in memory, with an admin and one account. */
async function site() {
  const { deps } = await makeDeps({ siteHost: "demo.example.com" });
  const clock = { now: NOW };
  deps.now = () => clock.now;
  const server = memoryServer();
  deps.mail = smtpMailer(SETTINGS, server.connect);
  await seedAccount(deps, { admin: true, username: "boss" });
  const a = await seedAccount(deps, { username: "alice" });
  return { deps, clock, server, a };
}

async function collect({ deps, clock }: { deps: Deps; clock: { now: number } }, userId: string, name: string, renameTo?: string): Promise<void> {
  const made = await redeemSignInCode(deps, await createSignInCode(deps, userId), null, null);
  if (made === null) throw new Error("the sign-in was refused");
  const headers = { "content-type": "application/json" };
  const r = await send(deps, "POST", "/api/v1/connect/start", { body: JSON.stringify({ device_name: name }), headers });
  // The API refuses such a name; it is written straight to the database to show the mail is safe by itself.
  if (renameTo !== undefined) await deps.db.run("UPDATE connect_request SET device_name = ?", [renameTo]);
  const c = await send(deps, "POST", "/api/v1/connect/confirm", {
    body: JSON.stringify({ user_code: r.json.user_code }),
    headers: { ...headers, cookie: `${SESSION_COOKIE}=${made.secret}`, origin: ORIGIN, "x-csrf-token": await csrfFor(made.secret), "sec-fetch-site": "same-origin" },
  });
  expect(c.status, c.text).toBe(204);
  clock.now += POLL_GAP_MS;
  const got = await send(deps, "POST", "/api/v1/connect/token", { body: JSON.stringify({ device_code: r.json.device_code }), headers });
  expect([got.status, got.json.status]).toEqual([200, "connected"]);
}

describe("the connection mail through the SMTP client", () => {
  it("arrives with the approved subject and text, to the confirming account alone", async () => {
    const made = await site();
    const { server, a } = made;
    await collect(made, a.userId, "ALEX-DESKTOP");
    expect(server.sessions).toHaveLength(1);
    expect(server.sessions[0].commands.filter((c) => c.startsWith("RCPT TO:"))).toEqual([`RCPT TO:<${a.email}>`]);
    const mail = stored(server.sessions[0].bodies[0]);
    expect(mail.headers.find(([n]) => n === "Subject")).toEqual(["Subject", "A computer was connected to your Mythicshot account"]);
    expect(mail.headers.find(([n]) => n === "To")).toEqual(["To", a.email]);
    expect(mail.text).toBe(
      [
        'Mythicshot on the computer "ALEX-DESKTOP" was connected to your account on 15 Jan 2027 at 08:00 UTC. It can publish, change and delete everything in your workspace.',
        "",
        "If that was you, nothing needs to be done.",
        "",
        "If it was not, disconnect it here and it stops working at once:",
        "",
        "https://demo.example.com/connections",
        "",
      ].join("\r\n"),
    );
  });

  it("a name that tries to add headers or lines adds none: the same headers, one recipient, the name on its one line", async () => {
    for (const hostile of ["Laptop\r\nBcc: victim@example.com", "Laptop\nSubject: changed\n\nHello", "Laptop\r\n.\r\nMAIL FROM:<x@example.com>"]) {
      const made = await site();
      const { server, a } = made;
      await collect(made, a.userId, "Laptop", hostile);
      expect(server.sessions, JSON.stringify(hostile)).toHaveLength(1);
      const { commands, bodies } = server.sessions[0];
      expect(bodies).toHaveLength(1);
      expect(commands.filter((c) => /^(MAIL FROM|RCPT TO):/i.test(c))).toEqual(["MAIL FROM:<no-reply@example.com>", `RCPT TO:<${a.email}>`]);
      const mail = stored(bodies[0]);
      expect(mail.headers.map(([n]) => n)).toEqual(["From", "To", "Subject", "Date", "Message-ID", "MIME-Version", "Content-Type", "Content-Transfer-Encoding", "Auto-Submitted", "X-Auto-Response-Suppress"]);
      expect(mail.headers.find(([n]) => n === "Subject")?.[1]).toBe("A computer was connected to your Mythicshot account");
      const lines = mail.text.split("\r\n");
      expect(lines).toHaveLength(8);
      expect(lines[0]).toMatch(/^Mythicshot on the computer "Laptop\ufffd+[^"]*" was connected to your account on 15 Jan 2027 at 08:00 UTC\. It can publish/);
      expect(lines.slice(1)).toEqual(["", "If that was you, nothing needs to be done.", "", "If it was not, disconnect it here and it stops working at once:", "", "https://demo.example.com/connections", ""]);
    }
  });
});
