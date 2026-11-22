// The stylesheet and the script of the pages a shared link opens (src/media-page.ts),
// served as /s/share.css and /s/share.js. Colours and type are the brand's tokens and
// Manrope (src/brand-css.ts), in both colour schemes from the system. The only url() is the
// font, on this address; nothing from another origin. The script only pauses and plays an
// MP4 clip when it is clicked.
import { PAGE_BASE_CSS } from "./brand-css.ts";

/** Where the stylesheet is served. */
export const SHARE_CSS_PATH = "/s/share.css";
/** Where the script is served. */
export const SHARE_JS_PATH = "/s/share.js";

export const SHARE_CSS = `${PAGE_BASE_CSS}* { box-sizing: border-box; }
html { background: var(--ground); }
body { margin: 0; background: var(--ground); color: var(--text); font: 15px/22px var(--font-sans); }
::selection { background: var(--selection); color: var(--text); }
a { color: var(--accent-text); text-underline-offset: 2px; }
a:hover { text-decoration-thickness: 2px; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.top { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 12px 18px; border-bottom: 1px solid var(--border); background: var(--surface); }
.brand { font-weight: 700; }
.who { color: var(--text-muted); font-size: 14px; }
main { padding: 0 0 24px; }
.stage { margin: 18px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); overflow: hidden; display: flex; justify-content: center; align-items: center; }
.stage img, .stage video { display: block; max-width: 100%; height: auto; max-height: calc(100vh - 220px); object-fit: contain; }
.stage video { cursor: pointer; }
.meta { padding: 0 18px; display: flex; justify-content: space-between; align-items: flex-start; gap: 12px 18px; flex-wrap: wrap; }
.meta > div { min-width: 0; }
.meta h1 { font-size: 20px; line-height: 28px; font-weight: 700; margin: 0 0 2px; overflow-wrap: anywhere; }
.d { color: var(--text-muted); font-size: 13px; line-height: 18px; margin: 0; }
.acts { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.btn { display: inline-flex; align-items: center; justify-content: center; min-height: var(--control-dense); text-align: center; border-radius: var(--radius-md); padding: 7px 14px; font-weight: 600; font-size: 13px; line-height: 18px; white-space: nowrap; color: var(--text); background: var(--surface); border: 1px solid var(--border-strong); text-decoration: none; }
.btn:hover { background: var(--ground); border-color: var(--text-muted); text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 3px; }
.foot { padding: 0 18px 24px; color: var(--text-muted); font-size: 13px; }
.gone { text-align: center; padding: 48px 18px 32px; }
.gone h1 { font-size: 24px; line-height: 32px; font-weight: 700; margin: 0 0 8px; }
.gone p { color: var(--text-muted); max-width: 44ch; margin: 0 auto; }
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
