// A mail with an HTML part (0.1.66, the storage mail is the first): the SMTP client sends it as
// multipart/alternative (the plain text first, then the HTML) and, with pictures, the HTML in a
// multipart/related part with each picture under its Content-ID; a mail without HTML goes out
// byte for byte as it did in 0.1.65; and the mail thread carries the HTML and the pictures to the
// worker. Node only. No mail server is contacted.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Mail } from "../src/mail.ts";
import { serveMail, workerMailer, type ClosableMailer, type MailAnswer, type MailReady } from "../src/node/mail-thread.ts";
import { MAX_INLINE, MAX_INLINE_BYTES, MAX_TEXT_BYTES, SmtpError, buildMessage, type SmtpSettings } from "../src/node/smtp.ts";
import { MARK_CID, WORDMARK_CID, storageMail } from "../src/storage-mail.ts";

const FROM = "no-reply@example.com";
const NOW = 1_800_000_000_000;
const ID = "abc123";
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The parts of a MIME body split on one boundary: each part's headers and body. */
function partsOf(body: string, boundary: string): { headers: string[]; body: string }[] {
  const pieces = body.split(`--${boundary}`);
  // Before the first boundary nothing; after the closing one ("--" then CRLF) nothing.
  expect(pieces[0]).toBe("");
  expect(pieces.at(-1)).toBe("--\r\n");
  return pieces.slice(1, -1).map((piece) => {
    expect(piece.startsWith("\r\n")).toBe(true);
    const at = piece.indexOf("\r\n\r\n");
    const headers = piece.slice(2, at).split("\r\n");
    // The CRLF before the next boundary belongs to the boundary.
    expect(piece.endsWith("\r\n")).toBe(true);
    return { headers, body: piece.slice(at + 4, -2) };
  });
}
const unbase64 = (body: string): Buffer => {
  for (const line of body.split("\r\n")) expect(line.length).toBeLessThanOrEqual(76);
  return Buffer.from(body.replace(/\r\n/g, ""), "base64");
};

describe("a mail without HTML", () => {
  it("is byte for byte the message of 0.1.65", () => {
    const signIn: Mail = { to: "ada@example.com", subject: "Your Mythicshot sign-in link", text: "Open this link:\n\nhttps://app.example.com/signin/link#c=abc\n\n.leading dot\n" };
    expect(buildMessage(signIn, FROM, NOW, ID)).toBe(
      "From: no-reply@example.com\r\nTo: ada@example.com\r\nSubject: Your Mythicshot sign-in link\r\nDate: Fri, 15 Jan 2027 08:00:00 +0000\r\nMessage-ID: <abc123@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\nAuto-Submitted: auto-generated\r\nX-Auto-Response-Suppress: All\r\n\r\nOpen this link:\r\n\r\nhttps://app.example.com/signin/link#c=abc\r\n\r\n.leading dot\r\n",
    );
    // Digests of what 0.1.65's buildMessage made of these (a UTF-8 subject and text with long and mixed lines; a line that looks like a boundary).
    const digest = (m: Mail) => createHash("sha256").update(buildMessage(m, FROM, NOW, ID)).digest("hex");
    expect(digest(signIn)).toBe("da3d2fa6f6e8b6dc2959f6796c8b661d9def36a74ad203391dba1726dd9c84e6");
    expect(digest({ to: "ada@example.com", subject: "Grüße — ünïcode subject that is long enough to fold into several encoded words", text: "Zeile eins: ä ö ü\r\nZeile zwei\rline three\n" + "x".repeat(1200) })).toBe(
      "96f028971e0d241789cdcf9a3b8375d4ea3182eaf520e036b3211f4e06848f54",
    );
    expect(digest({ to: "b@example.com", subject: "No newline", text: "--=_alt_abc looks like a boundary" })).toBe("fa6d6afa24452908b6641bb587deb21090768ae1278f6eadaa3dcec779cfc902");
  });
});

describe("a mail with HTML", () => {
  const designed = storageMail("ada@example.com", { stage: 80, workspaceName: "Acme Demos", used: 81, allowance: 100, tours: 52, gifs: 21, images: 8, origin: "https://app.example", trial: false, footer: null });

  it("is multipart/alternative, text first, then the HTML with its pictures in multipart/related", () => {
    const message = buildMessage(designed, FROM, NOW, ID);
    const [head, ...rest] = message.split("\r\n\r\n");
    expect(head.split("\r\n")).toEqual([
      "From: no-reply@example.com",
      "To: ada@example.com",
      "Subject: Your Mythicshot storage is 81% full",
      "Date: Fri, 15 Jan 2027 08:00:00 +0000",
      "Message-ID: <abc123@example.com>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/alternative; boundary="=_alt_abc123"',
      "Auto-Submitted: auto-generated",
      "X-Auto-Response-Suppress: All",
    ]);
    const outer = partsOf(rest.join("\r\n\r\n"), "=_alt_abc123");
    expect(outer).toHaveLength(2);
    expect(outer[0].headers).toEqual(["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 7bit"]);
    expect(outer[0].body).toBe(designed.text.replace(/\n/g, "\r\n"));
    expect(outer[1].headers).toEqual(['Content-Type: multipart/related; boundary="=_rel_abc123"; type="text/html"']);
    const inner = partsOf(outer[1].body + "\r\n", "=_rel_abc123");
    expect(inner).toHaveLength(3);
    expect(inner[0].headers).toEqual(["Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64"]);
    expect(unbase64(inner[0].body).toString("utf8")).toBe(designed.html);
    for (const [i, cid, name] of [[1, MARK_CID, "mark.png"], [2, WORDMARK_CID, "wordmark.png"]] as const) {
      expect(inner[i].headers).toEqual(["Content-Type: image/png", "Content-Transfer-Encoding: base64", `Content-ID: <${cid}>`, `Content-Disposition: inline; filename="${name}"`]);
      expect(new Uint8Array(unbase64(inner[i].body))).toEqual(designed.inline![i - 1].bytes);
    }
    // No line of the message is longer than SMTP allows, and every line ends in CRLF.
    for (const line of message.split("\r\n")) expect(line.length).toBeLessThanOrEqual(998);
    expect(message.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("without pictures, the HTML part stands directly in multipart/alternative", () => {
    const message = buildMessage({ to: "ada@example.com", subject: "S", text: "Plain\n", html: "<p>Désigné</p>" }, FROM, NOW, ID);
    const body = message.slice(message.indexOf("\r\n\r\n") + 4);
    const parts = partsOf(body, "=_alt_abc123");
    expect(parts.map((p) => p.headers[0])).toEqual(["Content-Type: text/plain; charset=utf-8", "Content-Type: text/html; charset=utf-8"]);
    expect(unbase64(parts[1].body).toString("utf8")).toBe("<p>Désigné</p>");
  });

  it("a text that is not plain ASCII, or has a line that starts like a boundary, travels as base64", () => {
    for (const text of ["Grüße\n", "fine\n--=_alt_abc123\nmore\n"]) {
      const message = buildMessage({ to: "ada@example.com", subject: "S", text, html: "<p>x</p>" }, FROM, NOW, ID);
      const parts = partsOf(message.slice(message.indexOf("\r\n\r\n") + 4), "=_alt_abc123");
      expect(parts).toHaveLength(2);
      expect(parts[0].headers[1]).toBe("Content-Transfer-Encoding: base64");
      expect(unbase64(parts[0].body).toString("utf8")).toBe(text.replace(/\n/g, "\r\n"));
    }
  });

  it("refuses pictures without HTML, too many or too large ones, other types, bad ids, and an HTML part over the limit", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const pic = { cid: "a@b.invalid", contentType: "image/png" as const, name: "a.png", bytes: png };
    const base: Mail = { to: "ada@example.com", subject: "S", text: "T\n", html: "<p>x</p>" };
    const bad: Mail[] = [
      { to: "ada@example.com", subject: "S", text: "T\n", inline: [pic] },
      { ...base, inline: Array.from({ length: MAX_INLINE + 1 }, (_, i) => ({ ...pic, cid: `p${i}@b.invalid` })) },
      { ...base, inline: [pic, pic] },
      { ...base, inline: [{ ...pic, bytes: new Uint8Array(MAX_INLINE_BYTES + 1) }] },
      { ...base, inline: [{ ...pic, bytes: new Uint8Array(0) }] },
      { ...base, inline: [{ ...pic, contentType: "image/svg+xml" as "image/png" }] },
      { ...base, inline: [{ ...pic, cid: "a@b>\r\nX-Evil: 1" }] },
      { ...base, inline: [{ ...pic, name: 'a".png' }] },
      { ...base, html: "x".repeat(MAX_TEXT_BYTES + 1) },
      { ...base, html: 5 as unknown as string },
    ];
    for (const m of bad) expect(() => buildMessage(m, FROM, NOW, ID)).toThrow(SmtpError);
    expect(() => buildMessage({ ...base, inline: [pic] }, FROM, NOW, ID)).not.toThrow();
  });
});

describe("the mail thread", () => {
  const made: ClosableMailer[] = [];
  afterEach(async () => {
    await Promise.all(made.splice(0).map((m) => m.close()));
  });

  it("serveMail hands the mailer a plain mail as its three strings, and a designed one with its HTML and pictures", async () => {
    const got: Mail[] = [];
    const answers: (MailAnswer | MailReady)[] = [];
    let listener: (m: unknown) => void = () => {};
    serveMail({ on: (_e, l) => (listener = l), postMessage: (a) => answers.push(a) }, { send: async (m) => void got.push(m) });
    listener({ id: 1, to: "a@example.com", subject: "S", text: "T\n" });
    listener({ id: 2, ...designedMail() });
    await new Promise((r) => setTimeout(r, 20));
    expect(answers).toEqual([{ ready: true }, { id: 1, ok: true }, { id: 2, ok: true }]);
    expect(Object.keys(got[0])).toEqual(["to", "subject", "text"]);
    expect(got[1]).toEqual(designedMail());
  });

  it("a real worker thread receives the HTML part and the pictures", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "mail-html-test-"));
    const log = join(scratch, "got.json");
    const file = join(scratch, "worker.mjs");
    writeFileSync(
      file,
      `import { writeFileSync } from "node:fs";
import { parentPort } from "node:worker_threads";
import { serveMail } from ${JSON.stringify(pathToFileURL(join(ROOT, "src", "node", "mail-thread.ts")).href)};
serveMail(parentPort, { async send(m) { writeFileSync(${JSON.stringify(log)}, JSON.stringify({ keys: Object.keys(m), html: m.html, inline: (m.inline ?? []).map((p) => ({ cid: p.cid, type: p.contentType, name: p.name, bytes: Array.from(p.bytes) })) })); } });
`,
    );
    const settings: SmtpSettings = { host: "mail.test", port: 465, user: "u", password: "p", from: FROM, helo: "app.example" };
    const m = workerMailer(settings, { workerUrl: pathToFileURL(file) });
    made.push(m);
    const designed = designedMail();
    await m.send(designed);
    const seen = JSON.parse(readFileSync(log, "utf8"));
    expect(seen.keys).toEqual(["to", "subject", "text", "html", "inline"]);
    expect(seen.html).toBe(designed.html);
    expect(seen.inline).toEqual(designed.inline!.map((p) => ({ cid: p.cid, type: p.contentType, name: p.name, bytes: Array.from(p.bytes) })));
  });
});

function designedMail(): Mail {
  return storageMail("ada@example.com", { stage: 100, workspaceName: "Acme", used: 100, allowance: 100, tours: 1, gifs: 1, images: 1, origin: "https://app.example", trial: false, footer: null });
}
