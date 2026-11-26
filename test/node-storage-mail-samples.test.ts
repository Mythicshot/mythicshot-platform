// The two low storage mails as samples for a person to look at (0.1.66): the 80% mail of a
// workspace on its trial and the full mail of a subscribed one. Every run builds and checks both;
// only with STORAGE_MAIL_SAMPLES=1 in the environment are they also written, each as the plain
// text (.txt), the whole message as the SMTP client sends it (.eml, which a mail app opens), and
// the HTML (.html) with its two pictures put in as data addresses so a browser shows them from the
// file (the mail itself carries them by Content-ID), into a folder of the system's temporary
// folder, never the repository. A normal run writes nothing. Node only; nothing is sent.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PLAN_BYTES } from "../src/billing-rules.ts";
import type { Mail } from "../src/mail.ts";
import { buildMessage } from "../src/node/smtp.ts";
import { storageMail } from "../src/storage-mail.ts";

/** Where the samples go: the same folder every run, so the newest are always there. */
export const SAMPLES_DIR = join(tmpdir(), "demo-platform-storage-mail-samples");
/** The setting that asks this test to write the files: exactly "1". */
export const SAMPLES_SETTING = "STORAGE_MAIL_SAMPLES";

const MB = 1024 * 1024;
const GB = 1024 * MB;
// The footer line as a site would set it in MAIL_FOOTER: a neutral example.
const FOOTER = "Example Co · Sometown";
const AT = Date.UTC(2026, 10, 26, 9, 0);

/** The HTML with each cid: picture replaced by a data: address of its bytes, for a browser opening the file. */
function previewHtml(mail: Mail): string {
  let html = mail.html ?? "";
  for (const p of mail.inline ?? []) html = html.split(`cid:${p.cid}`).join(`data:${p.contentType};base64,${Buffer.from(p.bytes).toString("base64")}`);
  return html;
}

const messageId = (name: string) => "sample0" + name.replace(/[^a-z0-9]/g, "");

function write(name: string, mail: Mail): string[] {
  const files = [join(SAMPLES_DIR, `${name}.txt`), join(SAMPLES_DIR, `${name}.html`), join(SAMPLES_DIR, `${name}.eml`)];
  writeFileSync(files[0], `Subject: ${mail.subject}\n\n${mail.text}`);
  writeFileSync(files[1], previewHtml(mail));
  writeFileSync(files[2], buildMessage(mail, "no-reply@app.example", AT, messageId(name)));
  return files;
}

describe("the storage mail samples", () => {
  it("builds the 80% mail of a trial and the full mail of a subscribed workspace, and writes them only when asked", () => {
    const low = storageMail("owner@example.com", { stage: 80, workspaceName: "Acme Demos", used: 81 * MB, allowance: 100 * MB, tours: 52 * MB, gifs: 21 * MB, images: 8 * MB, origin: "https://app.example", trial: true, footer: FOOTER });
    const full = storageMail("owner@example.com", {
      stage: 100,
      workspaceName: "Acme Demos",
      used: PLAN_BYTES,
      allowance: PLAN_BYTES,
      tours: Math.round(3.1 * GB),
      gifs: Math.round(1.4 * GB),
      images: PLAN_BYTES - Math.round(3.1 * GB) - Math.round(1.4 * GB),
      origin: "https://app.example",
      trial: false,
      footer: FOOTER,
    });
    expect(low.subject).toBe("Your Mythicshot storage is 81% full");
    expect(low.text).toContain("A subscription raises the allowance to 5 GB:");
    expect(full.subject).toBe("Your Mythicshot storage is full");
    for (const [name, m] of [["storage-80-trial", low], ["storage-100-subscribed", full]] as const) {
      expect(previewHtml(m)).not.toContain("cid:");
      expect(previewHtml(m)).toContain(FOOTER);
      expect(m.html).toContain(">See your storage page</a>");
      expect(buildMessage(m, "no-reply@app.example", AT, messageId(name)).length).toBeGreaterThan(2000);
    }
    if (process.env[SAMPLES_SETTING] !== "1") return;
    mkdirSync(SAMPLES_DIR, { recursive: true });
    const files = [...write("storage-80-trial", low), ...write("storage-100-subscribed", full)];
    for (const f of files) expect(readFileSync(f).length).toBeGreaterThan(200);
    console.log(`storage mail samples:\n${files.join("\n")}`);
  });
});
