// The three warning mails before a workspace's content is removed (0.1.62), in the approved words
// of the mockup (Files/Mythicshot billing/billing-mockups.html, section 6), with section 7's
// sentence about the download added to each, in the 30-day mail in place of the line about
// recordings on the computer. The ended subscription's 30-day mail is the wording the owner gave
// for it. Plain text in the style of the sign-in mail (src/mail.ts): one paragraph a line, a blank
// line between, no tracking and no picture. Each link is the site's own app address from the
// settings (linkOrigin), never a request's: the Subscribe page, and the Account page for the
// download. Dates are UTC, written as fullDate writes them ("21 February 2027").
//
// Six mails, five distinct texts: the 30-day and the 7-day mail of a trial and of an ended
// subscription (the ended 7-day mail without "and the links to them stop working", approved by the
// owner on 2026-11-24), and the 1-day mail, the same for both.
import { DAY, SUBSCRIBE_PATH } from "./billing-rules.ts";
import type { Mail } from "./mail.ts";
import { fullDate, type WarningStage } from "./removal-rules.ts";

/** What a warning mail needs: which clock, which warning, the removal day it names, and for an ended subscription when it ended. */
export type WarningOf = { kind: "trial" | "ended"; stage: WarningStage; removalAt: number; endedAt: number | null };

/** The "Download all my data" card of the Account page (0.1.60, src/dash/account.ts), where everything can be downloaded. */
export const ACCOUNT_PATH = "/account#h-data";

/** True for an origin as linkOrigin gives it: a scheme and a host, nothing after. */
function isOrigin(origin: unknown): origin is string {
  return typeof origin === "string" && /^https?:\/\/[A-Za-z0-9.\-[\]:]+$/.test(origin);
}

/**
 * The warning mail to `to`. `origin` is what linkOrigin gives for the site; anything else throws
 * Error("bad origin"), and the sweep sends nothing then. For a trial the 30-day mail names the
 * day before the removal day as the trial's end ("If you haven't subscribed by then"): the
 * trial's own end when the mail went on time, and never a day the content is gone by.
 */
export function warningMail(to: string, w: WarningOf, origin: string): Mail {
  if (!isOrigin(origin)) throw new Error("bad origin");
  const subscribe = `${origin}${SUBSCRIBE_PATH}`;
  const download = `You can download everything in your account first: ${origin}${ACCOUNT_PATH}`;
  const removed = fullDate(w.removalAt);
  let subject: string;
  let lines: string[];
  if (w.stage === 30 && w.kind === "trial") {
    subject = "Your Mythicshot trial ends in 30 days";
    lines = [
      `Your trial ends on ${fullDate(w.removalAt - DAY)}. If you haven't subscribed by then, your tours, images and clips are removed and your account is closed.`,
      `To keep them, subscribe for $7 a month: ${subscribe}`,
      download,
    ];
  } else if (w.stage === 30) {
    if (w.endedAt === null) throw new Error("bad time");
    subject = "Your Mythicshot content is removed in 30 days";
    lines = [
      `Your subscription ended on ${fullDate(w.endedAt)}. On ${removed} your tours, images and clips are removed and your account is closed.`,
      `To keep them, subscribe for $7 a month: ${subscribe}`,
      download,
    ];
  } else if (w.stage === 7) {
    subject = "7 days left to keep your Mythicshot content";
    lines = [
      // An ended subscription's links came down 60 days earlier, so its mail drops that clause (owner, 2026-11-24).
      w.kind === "trial" ? `On ${removed} your tours, images and clips are removed and the links to them stop working.` : `On ${removed} your tours, images and clips are removed.`,
      `To keep them, subscribe for $7 a month: ${subscribe}`,
      "If you'd rather leave, there's nothing you need to do.",
      download,
    ];
  } else {
    subject = "Tomorrow your Mythicshot content is removed";
    lines = [`This is the last reminder. Tomorrow, ${removed}, your tours, images and clips are removed. This can't be undone.`, `To keep them, subscribe today: ${subscribe}`, download];
  }
  return { to, subject, text: lines.join("\n\n") + "\n" };
}
