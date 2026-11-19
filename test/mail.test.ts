import { describe, expect, it } from "vitest";
import { MailOff, NO_MAIL, linkOrigin, signInLink, signInMail } from "../src/mail.ts";
import { FakeMailer } from "./fake-mail.ts";

const CODE = "dpl_" + "0123456789abcdef".repeat(2) + "01234567";
const LINK = `https://app.example.com/signin/link#c=${CODE}`;

describe("mail", () => {
  it("the sign-in mail holds the link once, says how long it lasts and nothing about the account", () => {
    const mail = signInMail("ada@example.com", LINK, "Mythicshot");
    expect(mail.to).toBe("ada@example.com");
    expect(mail.subject).toBe("Your Mythicshot sign-in link");
    // The owner-approved text, to the letter, with the link on a line of its own.
    expect(mail.text).toBe(
      [
        "Open this link to sign in to Mythicshot:",
        "",
        LINK,
        "",
        "It works once and for 15 minutes. If you did not ask for it, ignore this mail: nobody can sign in without the link.",
        "",
      ].join("\n"),
    );
    expect(mail.text.split(LINK)).toHaveLength(2);
    expect(mail.text.split("\n")).toContain(LINK);
    expect(mail.text).toContain("once and for 15 minutes");
    // Nothing about the account: not the address, not a name, and not in the subject.
    for (const part of [mail.subject, mail.text]) {
      expect(part).not.toContain("ada");
      expect(part).not.toContain("@");
    }
    expect(mail.subject).not.toContain(CODE);
    expect(mail.subject).not.toContain("http");
    // The site's name is "Mythicshot" unless another is given.
    expect(signInMail("ada@example.com", LINK)).toEqual(mail);
    expect(signInMail("ada@example.com", LINK, "")).toEqual(mail);
    expect(signInMail("ada@example.com", LINK, "Tours\r\nBcc: x@example.com")).toEqual(mail);
    const other = signInMail("ada@example.com", LINK, "Example Tours");
    expect(other.subject).toBe("Your Example Tours sign-in link");
    expect(other.text.split("\n")[0]).toBe("Open this link to sign in to Example Tours:");
  });

  it("the link carries the code only after the #", () => {
    const link = signInLink("https://app.example.com", CODE);
    expect(link).toBe(LINK);
    const url = new URL(link);
    expect(url.origin).toBe("https://app.example.com");
    expect(url.pathname).toBe("/signin/link");
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#c=${CODE}`);
    // What a server, a proxy log or a referrer sees holds no code.
    expect(link.slice(0, link.indexOf("#"))).not.toContain(CODE);
    // A code that could change the link is refused, and the refusal does not repeat it.
    for (const bad of ["", "a b", "x#y", "x/../y", "x?y=1", "x\r\ny", "x&y", "é"]) {
      let message = "";
      try {
        signInLink("https://app.example.com", bad);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toBe("bad code");
    }
  });

  it("the link's host comes from the app address, else from SITE_HOST, else there is none", () => {
    const base = { publicImageBase: "", setupCode: null };
    const hosts = { tours: "tours.example.com", app: "app.example.com" };
    expect(linkOrigin({ ...base, hosts })).toBe("https://app.example.com");
    // SITE_HOST is ignored when the app address is set.
    expect(linkOrigin({ ...base, hosts, siteHost: "other.example.com" })).toBe("https://app.example.com");
    expect(linkOrigin({ ...base, hosts: null, siteHost: "tours.example.org" })).toBe("https://tours.example.org");
    expect(linkOrigin({ ...base, siteHost: "Tours.Example.org:8443" })).toBe("https://tours.example.org:8443");
    expect(linkOrigin({ ...base, siteHost: "localhost:8787" })).toBe("http://localhost:8787");
    // Neither: no origin, so no mail can carry a link.
    expect(linkOrigin(base)).toBeNull();
    expect(linkOrigin({ ...base, hosts: null })).toBeNull();
    expect(linkOrigin({ ...base, hosts: null, siteHost: null })).toBeNull();
    expect(linkOrigin({ ...base, siteHost: "" })).toBeNull();
    // A SITE_HOST that is not a plain host name gives none either.
    for (const bad of ["https://tours.example.org", "tours.example.org/x", "a b", "evil.example\r\nx", "user@host"]) {
      expect(linkOrigin({ ...base, siteHost: bad })).toBeNull();
    }
  });

  it("the off mailer sends nothing and says it is off", async () => {
    const mail = signInMail("ada@example.com", LINK, "Mythicshot");
    const failure = await NO_MAIL.send(mail).then(
      () => null,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(MailOff);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("mail is off");
    expect((failure as Error).name).toBe("MailOff");
    // The refusal repeats nothing of the mail.
    expect(String((failure as Error).stack)).not.toContain(CODE);
    expect(JSON.stringify(failure)).not.toContain("ada");
  });

  it("the fake mailer keeps what it was handed, and fails once when told to", async () => {
    const fake = new FakeMailer();
    const first = signInMail("ada@example.com", LINK, "Mythicshot");
    await fake.send(first);
    expect(fake.sent).toEqual([first]);
    fake.failNext();
    await expect(fake.send(first)).rejects.toThrow();
    expect(fake.sent).toHaveLength(1);
    await fake.send({ ...first, to: "bob@example.com" });
    expect(fake.sent.map((m) => m.to)).toEqual(["ada@example.com", "bob@example.com"]);
  });
});
