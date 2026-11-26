// The low storage mail (0.1.66): its rules and its words, in the owner-approved mockup's words
// and look. Pure: no platform API, no database. When it is sent, to whom and how it is recorded
// is src/storage-alert.ts.
//
// The rules (approved by the owner, not to be changed here):
// - Two mails at most per fill-up of a workspace: one when what it uses reaches 80% of its
//   allowance ("running low"), one when it reaches 100% ("full"). A workspace that goes from
//   under 80% straight to 100% or more gets the "full" mail alone.
// - Neither repeats until what it uses is below 70% of its allowance; then both are armed again.
// - Only a workspace with an allowance gets it (stageOf answers null without one).
//
// This is the platform's first designed mail: a plain-text part and an HTML part, the HTML built
// of tables with inline styles so it holds in the common mail apps (a width of at most 520
// pixels, a light look with every background and colour written out, the brand's colours from
// src/brand-tokens.ts, Manrope first and then the system's fonts), the storage bar two table
// cells rather than a CSS width, and the logo two pictures carried inside the mail (the mark and
// the wordmark, PNG, referred to by Content-ID): no remote picture, font, script or tracking, so
// opening the mail makes no request anywhere. Every value put into the HTML is escaped; the
// workspace's name goes through lineName (src/mail.ts) first, as a device's name does in the
// connection mail, so it cannot leave its line, close its quotes or become a link.
import { MARK_MAIL_PNG, MARK_MAIL_SIZE, WORDMARK_HEIGHT, WORDMARK_LIGHT_PNG, WORDMARK_WIDTH } from "./brand-assets.ts";
import { PLAN_BYTES, SUBSCRIBE_PATH } from "./billing-rules.ts";
import { COLOR_TOKENS } from "./brand-tokens.ts";
import { DEFAULT_SITE_NAME, isOrigin, lineName, siteNameOf, type Mail } from "./mail.ts";
import { formatBytes } from "./usage.ts";

/** The two mails: running low at 80%, full at 100%. */
export type StorageStage = 80 | 100;

/** The share of the allowance, in percent, at which each mail goes, and below which both are armed again. */
export const LOW_PERCENT = 80;
export const REARM_PERCENT = 70;

/** The dashboard's Storage page (src/dash/storage.ts), where the button leads. */
export const STORAGE_PATH = "/storage";

/**
 * Where a workspace stands for the mail: the mail due (100 when it uses its whole allowance or
 * more, 80 from 80% of it), "rearm" below 70% (both mails armed again), or null in between, and
 * always null without an allowance. An allowance of 0 is no allowance for this mail: nothing can
 * be stored there at all, so "full" would only say what the admin chose. Exact, in whole numbers:
 * 79.9% is not 80%.
 */
export function stageOf(used: number, allowance: number | null): StorageStage | "rearm" | null {
  if (allowance === null || !Number.isSafeInteger(allowance) || allowance <= 0 || !Number.isSafeInteger(used) || used < 0) return null;
  if (used >= allowance) return 100;
  const u = BigInt(used) * 100n;
  if (u >= BigInt(allowance) * BigInt(LOW_PERCENT)) return 80;
  if (u < BigInt(allowance) * BigInt(REARM_PERCENT)) return "rearm";
  return null;
}

/** The share of the allowance used, in percent, rounded down to a whole number (exact, in whole numbers). */
export function percentOf(used: number, allowance: number): number {
  if (!Number.isSafeInteger(allowance) || allowance <= 0 || !Number.isSafeInteger(used) || used < 0) return 0;
  return Number((BigInt(used) * 100n) / BigInt(allowance));
}

/** What the mail says of one workspace. Sizes in bytes, as the Storage page counts them (GET /api/v1/usage). */
export type StorageFacts = {
  stage: StorageStage;
  /** The workspace's name, as stored; it is made safe here. */
  workspaceName: string;
  used: number;
  allowance: number;
  /** The pictures of the workspace's tours (`counted.pictures`), its GIFs (`counted.gifs`) and its images (`counted.images`). */
  tours: number;
  gifs: number;
  images: number;
  /** linkOrigin of the site, or null: then the mail says where to go in words and has no button. */
  origin: string | null;
  /** True only on a site with billing for a workspace on its trial: the line about a subscription is added. */
  trial: boolean;
  /** The footer line of the operator (MAIL_FOOTER), or null for none. */
  footer: string | null;
  siteName?: string;
};

/** The longest footer line a mail shows, in characters. */
export const MAIL_FOOTER_MAX = 200;
const FOOTER_LINE = /^[^\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]+$/u;

/** The MAIL_FOOTER setting as a mail shows it: one line of at most MAIL_FOOTER_MAX characters, trimmed; anything else is no footer line (null). */
export function mailFooterOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text === "" || [...text].length > MAIL_FOOTER_MAX || !FOOTER_LINE.test(text)) return null;
  return text;
}

/** The approved words. */
export const STORAGE_WORDS = {
  lowSentence: "When it is full, new uploads are refused. Everything that is already online keeps working, and nothing is deleted.",
  fullSentence: "New uploads are refused until there is room again. Everything that is already online keeps working, and nothing is deleted.",
  once: "You get this mail once. A second one follows only if the storage fills up completely.",
  button: "See what takes the room",
  linkLead: "See what takes the room, and delete what you no longer need:",
  // Proposed (not in the mockup): a site without an address for links, as the connection mail does.
  noLink: "To see what takes the room, and delete what you no longer need, open the Storage page of your dashboard.",
  nothingLeft: "Nothing left",
} as const;

/** The colours of the mail, from the brand's light tokens (src/brand-tokens.ts). */
function token(name: string): string {
  const t = COLOR_TOKENS.find((c) => c.name === name);
  if (t === undefined) throw new Error(`no colour token ${name}`);
  return t.light;
}
const C = {
  ground: token("ground"),
  card: token("surface-raised"),
  border: token("border"),
  text: token("text"),
  muted: token("text-muted"),
  purple: token("primary"),
  onPurple: token("on-primary"),
  gold: token("gold"),
  red: token("danger-fill"),
  // The bar's empty part, as the approved mockup draws it: not one of the brand's tokens.
  track: "#ece7f6",
} as const;

/** The font stack: the brand's (FIXED_TOKENS' font-sans), with single quotes so it can stand in a style attribute. */
const FONT = "Manrope,system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

/** The Content-IDs of the two pictures. `.invalid` is a name that never reaches anything. */
export const MARK_CID = "mark@storage-mail.invalid";
export const WORDMARK_CID = "wordmark@storage-mail.invalid";

/** Text for HTML: the five characters that could open markup or close an attribute, escaped. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * The storage mail to `to`. The subject names the site; the first line names the workspace,
 * made safe by lineName. The 80% mail's percent is rounded down and never 100. Links start with
 * `facts.origin` alone (linkOrigin, from the settings): the Storage page, and for a trial on a
 * site with billing the Subscribe page. Without an origin there is no link and no button.
 */
export function storageMail(to: string, f: StorageFacts): Mail {
  const site = siteNameOf(f.siteName ?? DEFAULT_SITE_NAME);
  const full = f.stage === 100;
  const percent = Math.min(99, percentOf(f.used, f.allowance));
  const name = lineName(f.workspaceName);
  const used = formatBytes(f.used);
  const allowance = formatBytes(f.allowance);
  const left = full ? STORAGE_WORDS.nothingLeft : `${formatBytes(Math.max(0, f.allowance - f.used))} left`;
  const origin = isOrigin(f.origin) ? f.origin : null;
  const storageLink = origin === null ? null : `${origin}${STORAGE_PATH}`;
  const subscribeLink = origin === null || !f.trial ? null : `${origin}${SUBSCRIBE_PATH}`;
  const plan = formatBytes(PLAN_BYTES);
  const footer = mailFooterOf(f.footer);
  const subject = full ? `Your ${site} storage is full` : `Your ${site} storage is ${percent}% full`;
  const headline = full ? "Your storage is full" : `Your storage is ${percent}% full`;
  const sentence = full ? STORAGE_WORDS.fullSentence : STORAGE_WORDS.lowSentence;

  const text = [
    full ? `Your workspace "${name}" has used all ${allowance} of its storage.` : `Your workspace "${name}" has used ${used} of its ${allowance} of storage (${percent}%).`,
    "",
    sentence,
    "",
    ...(storageLink === null ? [STORAGE_WORDS.noLink, ""] : [STORAGE_WORDS.linkLead, "", storageLink, ""]),
    ...(subscribeLink === null ? [] : [`A subscription raises the allowance to ${plan}:`, "", subscribeLink, ""]),
    ...(full ? [] : [STORAGE_WORDS.once, ""]),
  ].join("\n");

  const e = escapeHtml;
  const cell = (style: string) => `style="${style}"`;
  // The bar: two cells, the used part and the rest; full, one red cell.
  const bar = full
    ? `<td height="12" bgcolor="${C.red}" ${cell(`height:12px;line-height:12px;font-size:0;background-color:${C.red};border-radius:6px;`)}>&nbsp;</td>`
    : `<td width="${percent}%" height="12" bgcolor="${C.gold}" ${cell(`width:${percent}%;height:12px;line-height:12px;font-size:0;background-color:${C.gold};border-radius:6px 0 0 6px;`)}>&nbsp;</td>` +
      `<td width="${100 - percent}%" height="12" bgcolor="${C.track}" ${cell(`width:${100 - percent}%;height:12px;line-height:12px;font-size:0;background-color:${C.track};border-radius:0 6px 6px 0;`)}>&nbsp;</td>`;
  const row = (label: string, bytes: number, last: boolean) => {
    const edge = `border-top:1px solid ${C.border};${last ? `border-bottom:1px solid ${C.border};` : ""}`;
    return (
      `<tr><td ${cell(`padding:9px 0;${edge}font-family:${FONT};font-size:14px;color:${C.text};`)}>${label}</td>` +
      `<td align="right" ${cell(`padding:9px 0;${edge}font-family:${FONT};font-size:14px;color:${C.muted};text-align:right;`)}>${e(formatBytes(bytes))}</td></tr>`
    );
  };
  const button =
    storageLink === null
      ? `<p ${cell(`margin:0;font-family:${FONT};font-size:15px;line-height:1.6;color:${C.text};`)}>${e(STORAGE_WORDS.noLink)}</p>`
      : `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${C.purple}" ${cell(`background-color:${C.purple};border-radius:8px;`)}>` +
        `<a href="${e(storageLink)}" ${cell(`display:inline-block;padding:11px 22px;font-family:${FONT};font-size:15px;font-weight:600;line-height:1.2;color:${C.onPurple};text-decoration:none;border-radius:8px;`)}>${e(STORAGE_WORDS.button)}</a>` +
        "</td></tr></table>";
  const subscribe =
    subscribeLink === null
      ? ""
      : `<tr><td ${cell("padding:16px 0 0;")}><p ${cell(`margin:0;font-family:${FONT};font-size:14px;line-height:1.6;color:${C.muted};`)}>Need more room? ` +
        `<a href="${e(subscribeLink)}" ${cell(`color:${C.purple};text-decoration:underline;`)}>${e(`A subscription raises the allowance to ${plan}`)}</a>.</p></td></tr>`;
  const footerLines = [...(full ? [] : [STORAGE_WORDS.once]), ...(footer === null ? [] : [footer])].map(e);
  const html = [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">',
    `<title>${e(subject)}</title></head>`,
    `<body ${cell(`margin:0;padding:0;background-color:${C.ground};color:${C.text};`)}>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.ground}" ${cell(`background-color:${C.ground};`)}><tr><td align="center" ${cell("padding:20px 12px;")}>`,
    `<table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" ${cell("width:100%;max-width:520px;")}>`,
    `<tr><td bgcolor="${C.card}" ${cell(`background-color:${C.card};border:1px solid ${C.border};border-radius:12px;padding:28px 28px 24px;color:${C.text};font-family:${FONT};`)}>`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">',
    // The logo: the mark and the wordmark, pictures carried inside the mail.
    `<tr><td ${cell("padding:0 0 24px;")}><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
      `<td valign="middle" ${cell("padding:0 10px 0 0;")}><img src="cid:${MARK_CID}" width="${MARK_MAIL_SIZE}" height="${MARK_MAIL_SIZE}" alt="Mythicshot mark" ${cell(`display:block;border:0;width:${MARK_MAIL_SIZE}px;height:${MARK_MAIL_SIZE}px;`)}></td>` +
      `<td valign="middle"><img src="cid:${WORDMARK_CID}" width="${WORDMARK_WIDTH}" height="${WORDMARK_HEIGHT}" alt="Mythicshot" ${cell(`display:block;border:0;width:${WORDMARK_WIDTH}px;height:${WORDMARK_HEIGHT}px;`)}></td>` +
      "</tr></table></td></tr>",
    `<tr><td ${cell(`padding:0 0 6px;font-family:${FONT};font-size:22px;font-weight:600;line-height:1.3;color:${C.text};`)}>${e(headline)}</td></tr>`,
    `<tr><td ${cell(`padding:0 0 18px;font-family:${FONT};font-size:14px;line-height:1.5;color:${C.muted};`)}>Workspace "${e(name)}"</td></tr>`,
    `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${bar}</tr></table></td></tr>`,
    `<tr><td ${cell("padding:8px 0 22px;")}><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
      `<td ${cell(`font-family:${FONT};font-size:13px;line-height:1.5;color:${C.muted};`)}><b ${cell(`color:${C.text};`)}>${e(used)}</b> of ${e(allowance)} used</td>` +
      `<td align="right" ${cell(`font-family:${FONT};font-size:13px;line-height:1.5;color:${C.muted};text-align:right;`)}>${e(left)}</td>` +
      "</tr></table></td></tr>",
    `<tr><td ${cell("padding:0 0 22px;")}><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ${cell("border-collapse:collapse;")}>` +
      row("Tours", f.tours, false) +
      row("GIFs", f.gifs, false) +
      row("Images", f.images, true) +
      "</table></td></tr>",
    `<tr><td ${cell(`padding:0 0 22px;font-family:${FONT};font-size:15px;line-height:1.6;color:${C.text};`)}>${e(sentence)}</td></tr>`,
    `<tr><td>${button}</td></tr>`,
    subscribe,
    "</table>",
    "</td></tr>",
    footerLines.length === 0 ? "" : `<tr><td align="center" ${cell(`padding:16px 8px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${C.muted};text-align:center;`)}>${footerLines.join("<br>")}</td></tr>`,
    "</table>",
    "</td></tr></table>",
    "</body></html>",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");

  return {
    to,
    subject,
    text,
    html: html + "\n",
    inline: [
      { cid: MARK_CID, contentType: "image/png", name: "mark.png", bytes: MARK_MAIL_PNG() },
      { cid: WORDMARK_CID, contentType: "image/png", name: "wordmark.png", bytes: WORDMARK_LIGHT_PNG() },
    ],
  };
}
