// The stylesheet and the script of the pages a shared link opens (src/media-page.ts),
// served as /s/share.css and /s/share.js. Colours and type are the dashboard's (src/dash/
// style.ts), in both colour schemes from the system. No url(), no import, nothing from
// another origin; the script only pauses and plays an MP4 clip when it is clicked.

/** Where the stylesheet is served. */
export const SHARE_CSS_PATH = "/s/share.css";
/** Where the script is served. */
export const SHARE_JS_PATH = "/s/share.js";

export const SHARE_CSS = `:root {
  color-scheme: light dark;
  --bg: #f3f1ec;
  --card: #fcfbf8;
  --text: #2a2926;
  --muted: #66625b;
  --line: #e2ded5;
  --accent: #3d6b5f;
  --accent-soft: rgba(61, 107, 95, 0.28);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #181a1c;
    --card: #212427;
    --text: #e6e3dc;
    --muted: #a39f97;
    --line: #353a3e;
    --accent: #8dc1af;
    --accent-soft: rgba(141, 193, 175, 0.3);
  }
}
* { box-sizing: border-box; }
html { background: var(--bg); }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, "Segoe UI", sans-serif; }
a { color: var(--accent); }
a:focus-visible, video:focus-visible { outline: 3px solid var(--accent-soft); outline-offset: 2px; }
.top { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 12px 18px; border-bottom: 1px solid var(--line); background: var(--card); }
.brand { font-weight: 650; }
.who { color: var(--muted); font-size: .9rem; }
main { padding: 0 0 22px; }
.stage { margin: 18px; border: 1px solid var(--line); border-radius: 12px; background: var(--card); overflow: hidden; display: flex; justify-content: center; align-items: center; }
.stage img, .stage video { display: block; max-width: 100%; height: auto; max-height: calc(100vh - 220px); object-fit: contain; }
.stage video { cursor: pointer; }
.meta { padding: 0 18px; display: flex; justify-content: space-between; align-items: flex-start; gap: 12px 18px; flex-wrap: wrap; }
.meta > div { min-width: 0; }
.meta h1 { font-size: 1.15rem; margin: 0 0 2px; overflow-wrap: anywhere; }
.d { color: var(--muted); font-size: .85rem; margin: 0; }
.acts { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.btn { display: inline-block; text-align: center; border-radius: 9px; padding: 5px 10px; font-weight: 600; font-size: .84rem; white-space: nowrap; color: var(--accent); border: 1px solid var(--line); text-decoration: none; }
.btn:hover { border-color: var(--accent); }
.foot { padding: 0 18px 22px; color: var(--muted); font-size: .85rem; }
.gone { text-align: center; padding: 46px 18px 30px; }
.gone h1 { font-size: 1.25rem; margin: 0 0 8px; }
.gone p { color: var(--muted); max-width: 44ch; margin: 0 auto; }
@media (max-width: 600px) {
  .stage { margin: 12px; }
  .stage img, .stage video { max-height: 70vh; }
  .acts { justify-content: flex-start; }
}
`;

export const SHARE_JS = `(function () {
  "use strict";
  var clip = document.getElementById("clip");
  if (!clip || clip.tagName !== "VIDEO") return;
  clip.muted = true;
  function toggle() {
    if (clip.paused) {
      var playing = clip.play();
      if (playing && typeof playing.catch === "function") playing.catch(function () {});
    } else {
      clip.pause();
    }
  }
  clip.addEventListener("click", toggle);
  clip.addEventListener("keydown", function (e) {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      toggle();
    }
  });
})();
`;
