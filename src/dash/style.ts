// The dashboard's one stylesheet, served as /dash/dash.css: the sign-in pages' colours
// and type (src/signin/page.ts) with the approved mockups' additions (tags, tables, the
// bar across the top), in both colour schemes from the system. The shared part comes
// first; each page's own part follows under its heading. No url(), no import, nothing
// from another origin.
export const DASH_CSS = `:root {
  color-scheme: light dark;
  --bg: #f3f1ec;
  --card: #fcfbf8;
  --text: #2a2926;
  --muted: #66625b;
  --line: #e2ded5;
  --field: #ffffff;
  --accent: #3d6b5f;
  --accent-text: #ffffff;
  --accent-soft: rgba(61, 107, 95, 0.28);
  --ok-bg: #e3efe8;
  --ok-text: #2b5a47;
  --warn-bg: #f8eedb;
  --warn-text: #66450d;
  --warn-bar: #c98a1b;
  --error: #a33a2c;
  --tag-bg: #ece8df;
  --tag-text: #5a564f;
  --backdrop: rgba(40, 36, 28, 0.35);
  --shadow: 0 1px 2px rgba(40, 36, 28, 0.05), 0 8px 28px rgba(40, 36, 28, 0.07);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #181a1c;
    --card: #212427;
    --text: #e6e3dc;
    --muted: #a39f97;
    --line: #353a3e;
    --field: #1a1c1f;
    --accent: #8dc1af;
    --accent-text: #13221d;
    --accent-soft: rgba(141, 193, 175, 0.3);
    --ok-bg: #1d3128;
    --ok-text: #a8d7c2;
    --warn-bg: #362c1b;
    --warn-text: #efd19a;
    --warn-bar: #d9a441;
    --error: #f0a093;
    --tag-bg: #2a2e31;
    --tag-text: #b9b5ad;
    --backdrop: rgba(0, 0, 0, 0.55);
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 10px 30px rgba(0, 0, 0, 0.25);
  }
}
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  min-height: 100vh;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  overflow-wrap: anywhere;
}
a { color: var(--accent); text-underline-offset: 2px; }
a:focus-visible { outline: 3px solid var(--accent-soft); outline-offset: 2px; border-radius: 4px; }
h1:focus, h2:focus { outline: none; }

/* The bar across the top. */
.top { display: flex; align-items: center; gap: 6px 18px; flex-wrap: wrap; padding: 12px 18px; border-bottom: 1px solid var(--line); background: var(--card); }
.brand { margin: 0 8px 0 0; font-weight: 650; }
.nav { display: flex; gap: 4px; flex-wrap: wrap; flex: 1 1 auto; }
.nav a { padding: 5px 10px; border-radius: 8px; color: var(--muted); font-size: 0.93rem; text-decoration: none; }
.nav a:hover { color: var(--text); }
.nav a[aria-current="page"] { background: var(--tag-bg); color: var(--text); font-weight: 600; }
.who { margin: 0; color: var(--muted); font-size: 0.9rem; }

/* The page. */
.page { max-width: 1040px; margin: 0 auto; padding: 22px 18px 32px; }
h1 { font-size: 1.25rem; line-height: 1.3; font-weight: 650; margin: 0 0 4px; }
.sub { margin: 0 0 16px; color: var(--muted); font-size: 0.93rem; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); padding: 18px; margin: 0 0 14px; min-width: 0; }
.load { margin: 0; color: var(--error); font-size: 0.9rem; }
.load:empty { display: none; }
.message { margin: 0 0 8px; color: var(--error); font-size: 0.9rem; line-height: 1.45; }
.hint { margin: 6px 0 0; color: var(--muted); font-size: 0.86rem; }
.tag { display: inline-block; border-radius: 6px; font-size: 0.76rem; padding: 2px 7px; background: var(--tag-bg); color: var(--tag-text); white-space: nowrap; }
.tag.ok { background: var(--ok-bg); color: var(--ok-text); }
.tag.warn { background: var(--warn-bg); color: var(--warn-text); }
.empty { text-align: center; padding: 30px 10px; color: var(--muted); }
.empty p { margin: 0; }
.empty .empty-title { color: var(--text); font-size: 1.05rem; font-weight: 600; margin-bottom: 6px; }

/* Buttons, and links that look like them. */
.btn {
  display: inline-block;
  min-height: 36px;
  text-align: center;
  background: var(--accent);
  color: var(--accent-text);
  border: 1px solid transparent;
  border-radius: 9px;
  padding: 8px 13px;
  font: inherit;
  font-weight: 600;
  font-size: 0.9rem;
  line-height: 1.2;
  white-space: nowrap;
  text-decoration: none;
  cursor: pointer;
  transition: background-color 0.15s ease, opacity 0.15s ease;
}
.btn:hover:not(:disabled) { opacity: 0.9; }
.btn:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-soft); }
.btn.quiet { background: transparent; color: var(--accent); border-color: var(--line); }
.btn.danger { background: transparent; color: var(--error); border-color: var(--line); }
.btn.quiet:hover:not(:disabled), .btn.danger:hover:not(:disabled) { background: var(--bg); opacity: 1; }
.btn.sm { min-height: 32px; padding: 6px 10px; font-size: 0.84rem; }
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
.btn[aria-busy="true"] { cursor: progress; }

/* A question asked in the page. */
.backdrop { position: fixed; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center; padding: 16px; background: var(--backdrop); }
.dialog { width: 100%; max-width: 440px; background: var(--card); border: 1px solid var(--line); border-radius: 16px; box-shadow: var(--shadow); padding: 22px; }
.dialog h2 { font-size: 1.15rem; line-height: 1.3; margin: 0 0 8px; }
.dialog .sub { margin: 0 0 8px; }
.two { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 8px; }
.two .btn { flex: 1 1 130px; min-height: 44px; }

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
.tours { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
.tours th { text-align: left; font-size: 0.76rem; letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted); font-weight: 600; padding: 0 10px 8px 0; white-space: nowrap; }
.tours td { padding: 11px 10px 11px 0; border-top: 1px solid var(--line); vertical-align: middle; }
.tours .n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.tours .t { font-weight: 600; }
.tours .d { color: var(--muted); font-size: 0.85rem; }
.tours .status .tag + .tag { margin-left: 4px; }
.acts { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; align-items: center; }
.narrow-only { display: none; }
.vh { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.more { position: relative; display: inline-block; }
.menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 10; min-width: 180px; padding: 4px; background: var(--card); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow); }
.menu button { display: block; width: 100%; min-height: 40px; padding: 8px 12px; border: 0; border-radius: 6px; background: transparent; color: var(--text); font: inherit; font-size: 0.9rem; text-align: left; white-space: nowrap; cursor: pointer; }
.menu button:hover, .menu button:focus-visible { background: var(--tag-bg); outline: none; }
.menu button.danger { color: var(--error); }
.copy { flex: 1 1 100%; min-width: 0; min-height: 36px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 9px; background: var(--field); color: var(--text); font: inherit; font-size: 0.85rem; }
.copy:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
@media (max-width: 720px) {
  .tours, .tours tbody, .tours tr, .tours td { display: block; }
  .tours thead, .tours td.size, .tours td.when { display: none; }
  .tours tr { padding: 12px 0; border-top: 1px solid var(--line); }
  .tours tr:first-child { border-top: 0; padding-top: 0; }
  .tours tr:last-child { padding-bottom: 0; }
  .tours td { padding: 0; border-top: 0; }
  .tours td.status { margin: 8px 0; }
  .acts { justify-content: flex-start; }
  .menu { left: 0; right: auto; }
  .wide-only { display: none; }
  .narrow-only { display: inline; }
}

/* The Storage page. */
.total { margin: 0; }
.meter { height: 10px; margin: 0 0 8px; border-radius: 8px; background: var(--line); overflow: hidden; }
.meter-fill { width: 0; height: 100%; border-radius: inherit; background: var(--accent); }
.meter.over .meter-fill { background: var(--warn-bar); }
.over-box { margin: 12px 0 0; padding: 10px 12px; border-radius: 10px; background: var(--warn-bg); color: var(--warn-text); font-size: 0.9rem; }
.card-title { font-size: 1rem; line-height: 1.3; font-weight: 650; margin: 0 0 8px; }
.room { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; padding: 11px 0; border-top: 1px solid var(--line); font-size: 0.93rem; }
.room:first-of-type { border-top: 0; }
.room .r { color: var(--muted); font-variant-numeric: tabular-nums; }
.largest { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
.largest th { text-align: left; font-size: 0.76rem; letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted); font-weight: 600; padding: 0 10px 8px 0; white-space: nowrap; }
.largest td { padding: 11px 10px 11px 0; border-top: 1px solid var(--line); vertical-align: middle; }
.largest .t { font-weight: 600; }
.largest .t .tag { margin-left: 6px; font-weight: 400; }
.largest .n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.largest .mini-cell { width: 30%; }
.largest .del { text-align: right; padding-right: 0; }
.mini { height: 6px; border-radius: 6px; background: var(--line); overflow: hidden; }
.mini-fill { width: 0; height: 100%; border-radius: inherit; background: var(--accent); }
@media (max-width: 720px) {
  .largest .mini-cell { display: none; }
}

/* The Admin page. */
.accounts { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
.accounts th { text-align: left; font-size: 0.76rem; letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted); font-weight: 600; padding: 0 10px 8px 0; white-space: nowrap; }
.accounts td { padding: 11px 10px 11px 0; border-top: 1px solid var(--line); vertical-align: middle; }
.accounts .n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.accounts .bar { width: 16%; }
.accounts .t { font-weight: 600; }
.accounts .t .tag { margin-left: 6px; font-weight: 400; }
.accounts .d { color: var(--muted); font-size: 0.85rem; }
.accounts td.used .tag { margin-left: 6px; }
.accounts .mini { min-width: 80px; }
.accounts .mini i { display: block; width: 0; height: 100%; border-radius: inherit; background: var(--accent); }
.accounts .mini.over i { background: var(--warn-bar); }
.show-more { margin: 0 0 14px; }
.dialog label { display: block; font-weight: 600; font-size: 0.9rem; margin: 12px 0 6px; }
.field { width: 100%; min-height: 40px; padding: 9px 11px; border: 1px solid var(--line); border-radius: 9px; background: var(--field); color: var(--text); font: inherit; }
.field:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.field[aria-invalid="true"] { border-color: var(--error); }
.warn-box { background: var(--warn-bg); color: var(--warn-text); border-radius: 10px; padding: 10px 12px; font-size: 0.9rem; margin: 12px 0 0; }
.dialog .message { margin: 8px 0 0; }
@media (max-width: 720px) {
  .accounts, .accounts tbody, .accounts tr, .accounts td { display: block; }
  .accounts thead { display: none; }
  .accounts tr { padding: 12px 0; border-top: 1px solid var(--line); }
  .accounts tr:first-child { border-top: 0; padding-top: 0; }
  .accounts tr:last-child { padding-bottom: 0; }
  .accounts td { padding: 2px 0; border-top: 0; }
  .accounts .n { text-align: left; }
  .accounts .bar { width: auto; padding: 6px 0; }
  .accounts td[data-label]::before { content: attr(data-label); display: inline-block; min-width: 6.5em; color: var(--muted); font-size: 0.85rem; }
  .accounts .acts-cell { padding-top: 8px; }
}

/* The Account page. */
.row { display: flex; justify-content: space-between; align-items: center; gap: 6px 12px; flex-wrap: wrap; padding: 11px 0; border-top: 1px solid var(--line); font-size: 0.93rem; }
.row:first-of-type { border-top: 0; }
.row .r { color: var(--muted); display: flex; gap: 10px; align-items: center; flex-wrap: wrap; min-width: 0; }
.row .tag { margin-right: 8px; }
.sessions { list-style: none; margin: 0 0 8px; padding: 0; }
.address { color: var(--text); font-weight: 600; }
.field-label { display: block; font-weight: 600; font-size: 0.9rem; margin: 12px 0 6px; }
.dialog .hint { margin: 6px 0 8px; }
.lone { max-width: 440px; margin: 26px auto 0; }
.lone h1 { font-size: 1.15rem; margin: 0 0 8px; }
.lone .sub { margin: 0 0 8px; }
.two a.btn { display: inline-flex; align-items: center; justify-content: center; }
`;
