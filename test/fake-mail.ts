// Test only: the mailer every test uses in place of a real one. It keeps what it was
// asked to send and contacts nothing.
import type { Mail, Mailer } from "../src/mail.ts";

export class FakeMailer implements Mailer {
  /** Every mail handed over, oldest first. A send that was made to fail is not in it. */
  readonly sent: Mail[] = [];
  private failures = 0;

  /** The next send is refused, once, as a mail server that is down would refuse it. */
  failNext(): void {
    this.failures += 1;
  }

  async send(mail: Mail): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("the fake mailer was told to fail");
    }
    this.sent.push({ to: mail.to, subject: mail.subject, text: mail.text });
  }
}
