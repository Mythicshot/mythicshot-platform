// The way back to the Connections page after its "Use a different account" (src/dash/connections.ts).
//
// Pressing it signs this browser out and goes to the sign-in page. Just before it leaves, the
// Connections page keeps one small record in this browser's localStorage, so that a sign-in link
// opened in another tab of the same browser still finds it:
//
//   {"to":"connections","user_code":"K7QM2HXD","until":<ms since 1970>}
//
// `to` is a fixed marker, never an address: the record can only switch the sign-in pages between
// their two fixed destinations, /tours and /connections. `user_code` is the code that was looked
// up (8 characters of the code's alphabet, src/connect.ts), left out when there is none. `until`
// is the end of the code's own lifetime (CONNECT_MS) measured from when the page looked the code
// up, never later than CONNECT_MS from now. A record that is not exactly of this shape, longer
// than RETURN_MAX_CHARS, expired, or that ends later than CONNECT_MS from now, is removed and
// ignored.
//
// Nothing of it travels with a sign-in link or a request: it stays in the browser that pressed
// the button. So a sign-in started for someone's address by someone else can never land that
// person on a filled-in question; and the person still presses Connect themself. Every use of
// localStorage is in try/catch: where the browser keeps no data, everything is as without it.
//
// The sign-in pages (src/signin/page.ts) only read the record after a sign-in worked, and leave a
// valid one for the Connections page, which takes it once (removes it before using it) when it
// loads signed in, fills in the code and looks it up as if it had been typed.
import { CONNECT_MS, USER_CODE_ALPHABET } from "../connect.ts";

/** The localStorage key of the record. */
export const RETURN_KEY = "dp_connect_return";
/** The longest record read, in characters: a valid one is about 70. */
export const RETURN_MAX_CHARS = 128;

/**
 * The part of the record both scripts share, as script text: its key, the check of a stored
 * record, and reading and removing it. `returnCheck(text)` answers { user_code } (null when the
 * record holds none) for a valid, unexpired record, and null for anything else.
 */
export const RETURN_SHARED_JS = String.raw`  // ---- The way back to Connections (src/dash/connect-return.ts) ----
  var RETURN_KEY = "${RETURN_KEY}";
  var RETURN_MS = ${CONNECT_MS};
  var RETURN_MAX_CHARS = ${RETURN_MAX_CHARS};
  var RETURN_USER_CODE = /^[${USER_CODE_ALPHABET}]{8}$/;

  // A stored record, checked: { user_code } for a valid, unexpired one, else null.
  function returnCheck(text) {
    if (typeof text !== "string" || text.length === 0 || text.length > RETURN_MAX_CHARS) return null;
    var r = null;
    try { r = JSON.parse(text); } catch (e) { return null; }
    if (r === null || typeof r !== "object" || Array.isArray(r)) return null;
    var keys = Object.keys(r).sort().join(",");
    if (keys !== "to,until,user_code" && keys !== "to,until") return null;
    if (r.to !== "connections") return null;
    var now = Date.now();
    if (typeof r.until !== "number" || !isFinite(r.until) || r.until <= now || r.until > now + RETURN_MS) return null;
    if (keys === "to,until") return { user_code: null };
    if (typeof r.user_code !== "string" || !RETURN_USER_CODE.test(r.user_code)) return null;
    return { user_code: r.user_code };
  }

  // The stored record as text, or null (none, or no storage in this browser).
  function returnRead() {
    try { return localStorage.getItem(RETURN_KEY); } catch (e) { return null; }
  }

  function returnClear() {
    try { localStorage.removeItem(RETURN_KEY); } catch (e) { /* no storage in this browser */ }
  }
`;
