// The dashboard's one stylesheet, served as /dash/dash.css: the Mythicshot brand's tokens and
// fonts (src/brand-css.ts), then the shared parts (the bar across the top, buttons, fields,
// dialogs, tags, tables, notices), then each page's own part under its heading. Both colour
// schemes follow the system. Every colour is a token: no colour is written in this file
// (test/brand-tokens.test.ts). The only url()s are the brand's two fonts, on this address.
import { PAGE_BASE_CSS, WORDMARK_CSS } from "../brand-css.ts";

/**
 * A caution box's warning sign, drawn in CSS (the pages load no picture for it): an orange
 * triangle in the caution border colour with an exclamation mark, before the box's text.
 * The mark is hidden from screen readers; the box's words say what it is.
 */
export const CAUTION_ICON_CSS = `content: "!"; content: "!" / ""; position: absolute; left: 12px; top: 11px; width: 18px; height: 16px; padding-top: 3px; clip-path: polygon(50% 0, 100% 100%, 0 100%); background: var(--caution-border); color: var(--surface); font: 800 10px/13px var(--font-sans); text-align: center;`;

export const DASH_CSS = `${PAGE_BASE_CSS}*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  min-height: 100vh;
  background: var(--ground);
  color: var(--text);
  font: 15px/22px var(--font-sans);
  overflow-wrap: anywhere;
}
::selection { background: var(--selection); color: var(--text); }
a { color: var(--accent-text); text-underline-offset: 2px; }
a:hover { text-decoration-thickness: 2px; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
a:focus-visible { border-radius: var(--radius-sm); }
h1:focus, h2:focus { outline: none; }

/* The bar across the top. */
.top { display: flex; align-items: center; gap: 6px 18px; flex-wrap: wrap; padding: 12px 18px; border-bottom: 1px solid var(--border); background: var(--surface); }
.brand { display: flex; align-items: center; gap: 8px; margin: 0 8px 0 0; font-weight: 700; }
.brand a { display: inline-flex; align-items: center; gap: 8px; color: inherit; text-decoration: none; }
.brand a:hover { text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 4px; }
.brand img { display: block; flex: none; }
${WORDMARK_CSS}.nav { display: flex; gap: 4px; flex-wrap: wrap; flex: 1 1 auto; }
.nav a { display: inline-flex; align-items: center; min-height: var(--control-dense); padding: 6px 12px; border-radius: var(--radius-md); color: var(--text-muted); font-size: 14px; font-weight: 600; text-decoration: none; }
.nav a:hover { color: var(--text); text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 4px; }
.nav a[aria-current="page"] { background: var(--selection); color: var(--text); font-weight: 700; }
.who { margin: 0; color: var(--text-muted); font-size: 14px; }

/* The page. */
.page { max-width: 1040px; margin: 0 auto; padding: 24px 18px 32px; }
h1 { font-size: 20px; line-height: 28px; font-weight: 700; margin: 0 0 4px; }
.sub { margin: 0 0 16px; color: var(--text-muted); font-size: 14px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 18px; margin: 0 0 16px; min-width: 0; }
.load { margin: 0; color: var(--danger-text); font-size: 14px; }
.load:empty { display: none; }
.message { margin: 0 0 8px; color: var(--danger-text); font-size: 14px; line-height: 20px; }
.hint { margin: 6px 0 0; color: var(--text-muted); font-size: 13px; line-height: 18px; }
.tag { display: inline-block; border: 1px solid var(--border); border-radius: var(--radius-pill); font-size: 12px; font-weight: 600; line-height: 16px; padding: 1px 8px; background: var(--ground); color: var(--text-muted); white-space: nowrap; }
.tag.ok { border-color: var(--success-border); background: var(--success-tint); color: var(--success-text); }
.tag.warn { border-color: var(--caution-border); background: var(--caution-tint); color: var(--caution-text); }
.empty { text-align: center; padding: 32px 12px; color: var(--text-muted); }
.empty p { margin: 0; }
.empty .empty-title { color: var(--text); font-size: 16px; font-weight: 700; margin-bottom: 6px; }

/* Buttons, and links that look like them: purple for the main action, an edge for the others. */
.btn {
  display: inline-block;
  min-height: var(--control-dense);
  text-align: center;
  background: var(--primary);
  color: var(--on-primary);
  border: 1px solid var(--primary);
  border-radius: var(--radius-md);
  padding: 8px 14px;
  font: inherit;
  font-weight: 600;
  font-size: 13px;
  line-height: 18px;
  white-space: nowrap;
  text-decoration: none;
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}
.btn:hover:not(:disabled) { background: var(--primary-hover); border-color: var(--primary-hover); }
.btn.quiet { background: var(--surface); color: var(--text); border-color: var(--border-strong); }
.btn.quiet:hover:not(:disabled) { background: var(--ground); border-color: var(--text-muted); }
.btn.danger { background: var(--danger-fill); color: var(--on-primary); border-color: var(--danger-fill); }
.btn.danger:hover:not(:disabled) { background: var(--danger-fill); border-color: var(--danger-fill); text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 3px; }
.btn.sm { min-height: var(--control-dense); padding: 8px 12px; }
.btn.sm.danger { background: var(--surface); color: var(--danger-text); border-color: var(--border-strong); }
.btn.sm.danger:hover:not(:disabled) { background: var(--danger-tint); border-color: var(--danger-border); text-decoration: none; }
.btn:disabled, .btn[aria-disabled="true"] { opacity: 0.45; cursor: not-allowed; }
.btn[aria-busy="true"] { cursor: progress; }

/* A question asked in the page. */
.backdrop { position: fixed; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center; padding: 16px; background: var(--scrim); }
.dialog { width: 100%; max-width: 440px; background: var(--surface-raised); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-raised); padding: 24px; }
.dialog h2 { font-size: 20px; line-height: 28px; font-weight: 700; margin: 0 0 8px; }
.dialog .sub { margin: 0 0 8px; }
.two { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.two .btn { flex: 1 1 130px; min-height: var(--control-roomy); font-size: 14px; }

/* A caution: an orange box with an edge and a warning sign. Gold is never a box. */
.warn-box, .over-box { position: relative; padding: 10px 12px 10px 40px; border: 1px solid var(--caution-border); border-radius: var(--radius-md); background: var(--caution-tint); color: var(--caution-text); font-size: 14px; line-height: 20px; }
.warn-box::before, .over-box::before { ${CAUTION_ICON_CSS} }

@media (prefers-reduced-motion: reduce) {
  .btn { transition: none; }
}
@media (max-width: 720px) {
  .top { padding: 12px 16px; }
  .who { order: 1; margin-left: auto; }
  .nav { order: 2; flex-basis: 100%; }
  .page { padding: 18px 16px 26px; }
}

/* The Tours page. */
.tours { width: 100%; border-collapse: collapse; font-size: 15px; }
.tours th { text-align: left; font-size: 13px; line-height: 18px; color: var(--text-muted); font-weight: 600; padding: 0 10px 8px 0; white-space: nowrap; }
.tours td { padding: 10px 10px 10px 0; border-top: 1px solid var(--border); vertical-align: middle; }
.tours .n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.tours .t { font-weight: 600; }
.tours .d { color: var(--text-muted); font-size: 13px; }
.tours .status .tag + .tag { margin-left: 4px; }
.acts { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; align-items: center; }
.narrow-only { display: none; }
.vh { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.more { position: relative; display: inline-block; }
.menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 10; min-width: 180px; padding: 4px; background: var(--surface-raised); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-raised); }
.menu button { display: block; width: 100%; min-height: 40px; padding: 8px 12px; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--text); font: inherit; font-size: 14px; text-align: left; white-space: nowrap; cursor: pointer; }
.menu button:hover { background: var(--selection); }
.menu button:focus-visible { background: var(--selection); outline: 2px solid var(--focus); outline-offset: -2px; }
.menu button.danger { color: var(--danger-text); }
.copy { flex: 1 1 100%; min-width: 0; min-height: var(--control-dense); padding: 6px 12px; border: 1px solid var(--border-strong); border-radius: var(--radius-md); background: var(--surface); color: var(--text); font: 13px/20px var(--font-mono); }
/* Its Sharing box (the restricted tours set's mockups 2 and 3). */
#share-box { max-width: 480px; max-height: 100%; overflow-y: auto; }
.opts { margin: 0 0 4px; padding: 0; border: 0; min-width: 0; }
.dialog label.opt { display: flex; gap: 12px; align-items: flex-start; margin: 0 0 8px; padding: 12px; border: 1px solid var(--border-strong); border-radius: var(--radius-md); font-weight: 400; font-size: inherit; cursor: pointer; }
.opt:has(input:checked) { border-color: var(--primary); box-shadow: inset 0 0 0 1px var(--primary); background: var(--selection); }
.opt:has(input:disabled) { opacity: 0.55; cursor: not-allowed; }
.opt input { flex: 0 0 auto; width: 16px; height: 16px; margin: 3px 0 0; accent-color: var(--primary); }
.opt-text { min-width: 0; }
.opt-name { display: block; font-weight: 600; }
.opt-d { display: block; color: var(--text-muted); font-size: 14px; }
.chips { display: flex; gap: 8px; flex-wrap: wrap; margin: 0 0 12px; padding: 0; list-style: none; }
.chips:empty { display: none; }
.chip { display: inline-flex; align-items: center; gap: 2px; max-width: 100%; min-width: 0; padding: 2px 3px 2px 10px; border: 1px solid var(--border); border-radius: var(--radius-pill); background: var(--ground); color: var(--text); font-size: 13px; }
.chip .name { min-width: 0; }
.chip button { flex: 0 0 auto; min-width: 28px; min-height: 28px; padding: 0; border: 0; border-radius: var(--radius-pill); background: transparent; color: inherit; font: inherit; cursor: pointer; }
.chip button:hover:not(:disabled) { background: var(--selection); }
.chip button:disabled { opacity: 0.45; cursor: not-allowed; }
#share-add-message { margin: 8px 0 0; }
.progress { display: block; width: 100%; height: 10px; margin: 8px 0 6px; border: 0; border-radius: var(--radius-pill); background: var(--border); color: var(--primary); appearance: none; overflow: hidden; }
.progress::-webkit-progress-bar { background: var(--border); border-radius: var(--radius-pill); }
.progress::-webkit-progress-value { background: var(--primary); border-radius: var(--radius-pill); }
.progress::-moz-progress-bar { background: var(--primary); border-radius: var(--radius-pill); }
/* Its Chapters box (the chapters mockup): one row per chapter, its buttons after its words, under them on a phone. */
#chapters-box { max-width: 520px; max-height: 100%; overflow-y: auto; }
.chapters { margin: 4px 0 8px; padding: 0; list-style: none; }
.ch { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 10px 0; border-top: 1px solid var(--border); }
.ch:last-child { border-bottom: 1px solid var(--border); }
.ch-text { flex: 1 1 200px; min-width: 0; }
.ch-name { font-weight: 600; }
.ch.gone .ch-name { color: var(--text-muted); font-weight: 400; }
.ch-d { color: var(--text-muted); font-size: 13px; line-height: 18px; }
.ch-moved { margin-left: 6px; }
.ch-acts { display: flex; gap: 6px; flex: 0 0 auto; }
.ch-move { min-width: var(--control-dense); padding: 8px 10px; }
#chapters-warn { margin: 0 0 8px; }
/* On a phone "Who can view" joins the details line, on the Tours page and the Images and GIFs pages alike. */
@media (max-width: 720px) {
  .tours td.view, .media td.view { display: none; }
}
@media (max-width: 720px) {
  .tours, .tours tbody, .tours tr, .tours td { display: block; }
  .tours thead, .tours td.size, .tours td.when { display: none; }
  .tours tr { padding: 12px 0; border-top: 1px solid var(--border); }
  .tours tr:first-child { border-top: 0; padding-top: 0; }
  .tours tr:last-child { padding-bottom: 0; }
  .tours td { padding: 0; border-top: 0; }
  .tours td.status { margin: 8px 0; }
  .acts { justify-content: flex-start; }
  .menu { left: 0; right: auto; }
  .wide-only { display: none; }
  .narrow-only { display: inline; }
}

/* The Images and GIFs pages. */
.media { width: 100%; border-collapse: collapse; font-size: 15px; }
.media th { text-align: left; font-size: 13px; line-height: 18px; color: var(--text-muted); font-weight: 600; padding: 0 10px 8px 0; white-space: nowrap; }
.media td { padding: 10px 10px 10px 0; border-top: 1px solid var(--border); vertical-align: middle; }
.media .n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.media .t { font-weight: 600; }
.media .d { color: var(--text-muted); font-size: 13px; }
.media .thumb-cell { width: 66px; }
.thumb { position: relative; display: block; width: 56px; height: 36px; overflow: hidden; border-radius: var(--radius-sm); border: 1px solid var(--border); background: linear-gradient(135deg, var(--selection) 0 55%, var(--border) 55% 100%); }
.thumb img { display: block; width: 100%; height: 100%; object-fit: cover; }
.thumb.play::after { content: ""; position: absolute; left: 50%; top: 50%; transform: translate(-35%, -50%); border-left: 10px solid var(--text-muted); border-top: 6px solid transparent; border-bottom: 6px solid transparent; filter: drop-shadow(0 0 1px var(--surface)); }
@media (max-width: 720px) {
  .media, .media tbody { display: block; }
  .media thead, .media td.size, .media td.when { display: none; }
  .media tr { display: grid; grid-template-columns: 56px minmax(0, 1fr); gap: 0 12px; align-items: start; padding: 12px 0; border-top: 1px solid var(--border); }
  .media tr:first-child { border-top: 0; padding-top: 0; }
  .media tr:last-child { padding-bottom: 0; }
  .media td { display: block; padding: 0; border-top: 0; }
  .media td.thumb-cell { width: auto; }
  .media td.acts-cell { grid-column: 1 / -1; margin-top: 8px; }
}

/* The Storage page. */
.total { margin: 0; }
.meter { height: 10px; margin: 0 0 8px; border-radius: var(--radius-pill); background: var(--border); overflow: hidden; }
.meter-fill { width: 0; height: 100%; border-radius: inherit; background: var(--primary); }
.meter.over .meter-fill { background: var(--caution-border); }
.over-box { margin: 12px 0 0; }
.card-title { font-size: 16px; line-height: 22px; font-weight: 700; margin: 0 0 8px; }
.room { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; padding: 10px 0; border-top: 1px solid var(--border); font-size: 15px; }
.room:first-of-type { border-top: 0; }
.room .r { color: var(--text-muted); font-variant-numeric: tabular-nums; }
.largest { width: 100%; border-collapse: collapse; font-size: 15px; }
.largest th { text-align: left; font-size: 13px; line-height: 18px; color: var(--text-muted); font-weight: 600; padding: 0 10px 8px 0; white-space: nowrap; }
.largest td { padding: 10px 10px 10px 0; border-top: 1px solid var(--border); vertical-align: middle; }
.largest .t { font-weight: 600; }
.largest .t .tag { margin-left: 6px; font-weight: 600; }
.largest .n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.largest .mini-cell { width: 30%; }
.largest .del { text-align: right; padding-right: 0; }
.mini { height: 6px; border-radius: var(--radius-pill); background: var(--border); overflow: hidden; }
.mini-fill { width: 0; height: 100%; border-radius: inherit; background: var(--primary); }
@media (max-width: 720px) {
  .largest .mini-cell { display: none; }
}

/* The Admin page. */
.accounts { width: 100%; border-collapse: collapse; font-size: 15px; }
.accounts th { text-align: left; font-size: 13px; line-height: 18px; color: var(--text-muted); font-weight: 600; padding: 0 10px 8px 0; white-space: nowrap; }
.accounts td { padding: 10px 10px 10px 0; border-top: 1px solid var(--border); vertical-align: middle; }
.accounts .n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.accounts .bar { width: 16%; }
.accounts .t { font-weight: 600; }
.accounts .t .tag { margin-left: 6px; font-weight: 600; }
.accounts .d { color: var(--text-muted); font-size: 13px; }
.accounts td.used .tag { margin-left: 6px; }
.accounts td.joined { white-space: nowrap; font-variant-numeric: tabular-nums; }
.accounts .terms .d { white-space: nowrap; }
/* Room for an account's name and address, and for the terms' version, before any of them wraps: a
   long address still wraps inside its column, and a date stays on one line. */
.accounts td.who-cell { min-width: 13em; }
.accounts td.terms { min-width: 9em; }
.accounts .terms .name { white-space: nowrap; }
.accounts.no-terms th.terms, .accounts.no-terms td.terms { display: none; }
.accounts .mini { min-width: 80px; }
.accounts .mini i { display: block; width: 0; height: 100%; border-radius: inherit; background: var(--primary); }
.accounts .mini.over i { background: var(--caution-border); }
.show-more { margin: 0 0 16px; }
.dialog label { display: block; font-weight: 600; font-size: 13px; line-height: 18px; margin: 12px 0 4px; }
.field { width: 100%; min-height: var(--control-roomy); padding: 10px 12px; border: 1px solid var(--border-strong); border-radius: var(--radius-md); background: var(--surface); color: var(--text); font: inherit; }
.field::placeholder { color: var(--text-muted); opacity: 1; }
.field[aria-invalid="true"] { border-color: var(--danger-border); box-shadow: inset 0 0 0 1px var(--danger-border); }
.warn-box { margin: 12px 0 0; }
.dialog .message { margin: 8px 0 0; }
@media (max-width: 720px) {
  .accounts, .accounts tbody, .accounts tr, .accounts td { display: block; }
  .accounts thead { display: none; }
  .accounts tr { padding: 12px 0; border-top: 1px solid var(--border); }
  .accounts tr:first-child { border-top: 0; padding-top: 0; }
  .accounts tr:last-child { padding-bottom: 0; }
  .accounts td { padding: 2px 0; border-top: 0; }
  .accounts .n { text-align: left; }
  .accounts .bar { width: auto; padding: 6px 0; }
  .accounts td[data-label]::before { content: attr(data-label); display: inline-block; min-width: 6.5em; color: var(--text-muted); font-size: 13px; }
  .accounts .acts-cell { padding-top: 8px; }
  .accounts td.who-cell, .accounts td.terms { min-width: 0; }
}
.invite-text { margin: 0 0 12px; }
.invite-message { margin: 8px 0 0; }
.invites { width: 100%; border-collapse: collapse; font-size: 15px; }
.invites th { text-align: left; font-size: 13px; line-height: 18px; color: var(--text-muted); font-weight: 600; padding: 0 10px 8px 0; white-space: nowrap; }
.invites td { padding: 10px 10px 10px 0; border-top: 1px solid var(--border); vertical-align: middle; }
.invites td.when { white-space: nowrap; font-variant-numeric: tabular-nums; }
.invites .t { font-weight: 400; }
.invites .d { color: var(--text-muted); font-size: 13px; }
.invites .d .tag { margin-left: 2px; }
#cancel-box, #disable-box, #delete-box { max-height: 100%; overflow-y: auto; }
#delete-progress .meter { margin: 8px 0 6px; }
@media (max-width: 720px) {
  .invites, .invites tbody, .invites tr, .invites td { display: block; }
  .invites thead, .invites td.when { display: none; }
  .invites tr { padding: 12px 0; border-top: 1px solid var(--border); }
  .invites tr:first-child { border-top: 0; padding-top: 0; }
  .invites tr:last-child { padding-bottom: 0; }
  .invites td { padding: 0; border-top: 0; }
  .invites td.acts-cell { margin-top: 8px; }
}

/* The Account page. */
.row { display: flex; justify-content: space-between; align-items: center; gap: 6px 12px; flex-wrap: wrap; padding: 10px 0; border-top: 1px solid var(--border); font-size: 15px; }
.row:first-of-type { border-top: 0; }
.row .r { color: var(--text-muted); display: flex; gap: 10px; align-items: center; flex-wrap: wrap; min-width: 0; }
.row .tag { margin-right: 8px; }
.sessions { list-style: none; margin: 0 0 8px; padding: 0; }
.address { color: var(--text); font-weight: 600; }
.field-label { display: block; font-weight: 600; font-size: 13px; line-height: 18px; margin: 12px 0 4px; }
.dialog .hint { margin: 6px 0 8px; }
.terms-agreed { margin: 0; padding: 10px 0 0; border-top: 1px solid var(--border); font-size: 15px; }
.terms-check { color: var(--success-text); font-weight: 700; }
.lone { max-width: 440px; margin: 24px auto 0; }
.lone h1 { font-size: 20px; margin: 0 0 8px; }
.lone .sub { margin: 0 0 8px; }
.two a.btn { display: inline-flex; align-items: center; justify-content: center; }

/* The Connections page. */
.connections { width: 100%; border-collapse: collapse; font-size: 15px; }
.connections th { text-align: left; font-size: 13px; line-height: 18px; color: var(--text-muted); font-weight: 600; padding: 0 10px 8px 0; white-space: nowrap; }
.connections td { padding: 10px 10px 10px 0; border-top: 1px solid var(--border); vertical-align: middle; }
.connections td.when { white-space: nowrap; font-variant-numeric: tabular-nums; }
.connections .t { font-weight: 600; }
.connections .d { color: var(--text-muted); font-size: 13px; }
.name { unicode-bidi: isolate; overflow-wrap: anywhere; }
.note { margin: 0 0 16px; padding: 10px 12px; border: 1px solid var(--success-border); border-radius: var(--radius-md); background: var(--success-tint); color: var(--success-text); font-size: 14px; line-height: 20px; }
.note.plain { border-color: var(--border); background: var(--ground); color: var(--text); }
.note a { color: inherit; text-decoration: underline; }
.connect-text { margin: 0 0 12px; }
.inline { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.inline .field { flex: 1 1 180px; width: auto; min-width: 0; }
.code-field { font: 600 18px/22px var(--font-mono); letter-spacing: 0.1em; }
.connect-message { margin: 8px 0 0; }
.kv { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 16px; margin: 12px 0 0; font-size: 15px; }
.kv dt { color: var(--text-muted); }
.kv dd { margin: 0; min-width: 0; }
#confirm-box, #rename-box, #disconnect-box { max-height: 100%; overflow-y: auto; }
@media (max-width: 720px) {
  .connections, .connections tbody, .connections tr, .connections td { display: block; }
  .connections thead, .connections td.when { display: none; }
  .connections tr { padding: 12px 0; border-top: 1px solid var(--border); }
  .connections tr:first-child { border-top: 0; padding-top: 0; }
  .connections tr:last-child { padding-bottom: 0; }
  .connections td { padding: 0; border-top: 0; }
  .connections td.acts-cell { margin-top: 8px; }
}

/* The terms screen and the read-only terms (src/dash/terms.ts): one card on its own page. */
.terms-page { max-width: 680px; margin: 0 auto; padding: 32px 16px; }
.terms-page > .brand { margin: 0 0 16px; }
.terms-card { padding: 24px; }
.terms-kicker { margin: 0 0 4px; color: var(--text-muted); font-size: 13px; }
.terms-kicker:empty { display: none; }
.terms-title { margin: 0 0 16px; }
.terms-label { margin: 16px 0 6px; font-size: 15px; line-height: 22px; font-weight: 700; }
.terms-version { color: var(--text-muted); font-weight: 400; }
.terms-points { margin: 0 0 8px; padding-left: 1.3em; }
.terms-points li { margin: 0 0 4px; }
.terms-note { margin: 0; color: var(--text-muted); font-size: 14px; }
.terms-box { height: 320px; max-height: 50vh; overflow-y: auto; overscroll-behavior: contain; border: 1px solid var(--border-strong); border-radius: var(--radius-md); background: var(--ground); padding: 12px 14px; font-size: 14px; line-height: 21px; }
.terms-box h3 { margin: 14px 0 6px; font-size: 15px; font-weight: 700; }
.terms-box h3:first-child { margin-top: 0; }
.terms-box p { margin: 0 0 10px; }
.terms-box ul { margin: 0 0 10px; padding-left: 1.3em; }
.terms-box li { margin: 0 0 4px; }
.terms-links { margin: 8px 0 0; font-size: 14px; color: var(--text-muted); }
.terms-card .message { margin: 12px 0 0; }
.terms-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; margin-top: 24px; }
.terms-actions .btn { min-height: var(--control-roomy); font-size: 14px; padding: 10px 18px; }
.terms-back { margin: 18px 0 0; font-size: 15px; }
@media (max-width: 480px) {
  .terms-page { padding: 16px; }
  .terms-card { padding: 16px; }
  .terms-actions .btn { flex: 1 1 auto; }
}

/* Billing (src/dash/billing.ts), on a site with billing switched on: the notice at the top of a page, and the Subscribe page's box for Stripe's form. */
.billing-strip { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; justify-content: space-between; margin: 0 0 16px; padding: 10px 14px; border: 1px solid var(--border); border-left-width: 4px; background: var(--surface); color: var(--text); }
.billing-strip.warn { border-color: var(--caution-border); background: var(--caution-tint); color: var(--caution-text); }
.billing-strip.bad { border-color: var(--danger-border); background: var(--danger-tint); color: var(--danger-text); }
.billing-strip-text { flex: 1 1 300px; min-width: 0; }
.billing-strip .btn { flex: 0 0 auto; }
.billing-strip .message { flex: 1 1 100%; margin: 0; }
.checkout { min-height: 320px; margin: 0 0 16px; }
/* Once Stripe's form is mounted (the script adds "mounted"): a centred card at the width Stripe's form takes one column, its corners clipped to the radius. No fill of its own: Stripe's form paints the whole box in the colours set in Stripe's Branding settings, dark or light, and a fill here would flash before it loads. No height of its own: the form grows it. Narrower than 480px it takes the page's width inside its gutter. */
.checkout.mounted { width: 100%; max-width: 480px; margin-block: 16px; margin-inline: auto; border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; }
`;
