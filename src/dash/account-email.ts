// The page an email-change link opens, /account/email#c=dpe_<40 hex>, on the app address.
// Like the page a sign-in link opens (src/signin/page.ts), opening it changes nothing, so a
// mail scanner that follows the link does no harm: the person presses Confirm, and only that
// press sends the code, in the JSON body of POST /api/v1/account/email/confirm.
//
// The code is after `#`, which a browser sends to no server. The script's first two
// statements read that part of the address and take it out of the address bar, before the
// script does anything else, so this tab's back, forward and reload no longer show it. A
// browser may still keep the address it opened, code and all, in its own history: what
// limits that is the code itself, which works once, for 15 minutes, and only with a session
// of the account that asked for the change. In the page the code lives in one variable of
// the script's own function and leaves it only in the confirm request's body; it is never
// written to the page, a store, a log or an address.
//
// The states, one shown at a time, each in the look of mockup 8's boxes:
// - Confirm: the person is signed in (the confirm route takes only the session of the
//   account that asked for the change). Proposed wording.
// - Sign in first: the visitor is not signed in. The code is not carried across the sign-in:
//   the person opens the link from the mail again afterwards. Proposed wording.
// - Done: mockup 8's third box, naming the new and the previous address the confirm answer
//   returns.
// - Dead link: the server refused the code (400 bad_code), or the address held no code of
//   the right shape, in which case nothing is asked at all. Its sentence is the server's own
//   (EMAIL_CHANGE_SAYS.badCode), then a line for a person with more than one account
//   (proposed), with the way back to the account page.
//
// A confirm whose answer never came (a network failure) may still have changed the address.
// The code is kept and the general sentence shown, so the person can press again; when that
// press is refused (bad_code), the page reads the session once more, and if its address is no
// longer the one the page started with, the change went through: the page shows Done with the
// new address rather than the dead link.
import { dashHtml } from "./shell.ts";

const EMAIL_MAIN = `  <div class="lone">
  <section class="dialog" id="confirm" aria-labelledby="h-confirm" hidden>
    <h1 id="h-confirm" tabindex="-1">Confirm your new email address</h1>
    <p class="sub">Press the button to make this your Mythicshot email address.</p>
    <p class="message" id="confirm-message" role="status" aria-live="polite" hidden></p>
    <div class="two"><button type="button" class="btn" id="confirm-button">Confirm</button></div>
  </section>
  <section class="dialog" id="first" aria-labelledby="h-first" hidden>
    <h1 id="h-first" tabindex="-1">Sign in first</h1>
    <p class="sub">Sign in with your current email address, then open the link from your mail again.</p>
    <div class="two"><button type="button" class="btn" id="first-button">Sign in</button></div>
  </section>
  <section class="dialog" id="done" aria-labelledby="h-done" hidden>
    <h1 id="h-done" tabindex="-1"></h1>
    <p class="sub">Sign-in links go to this address from now on. We sent a notice to <span class="address" id="done-old"></span>.</p>
    <div class="two"><a class="btn" href="/account" id="done-back">Back to your account</a></div>
  </section>
  <section class="dialog" id="dead" aria-labelledby="h-dead" hidden>
    <h1 id="h-dead" tabindex="-1">Confirm your new email address</h1>
    <p class="sub">This link no longer works. Ask for a new one from your account page.</p>
    <p class="sub">If you have more than one account, sign in to the one that asked for the change and open the link again.</p>
    <div class="two"><a class="btn quiet" href="/account">Back to your account</a></div>
  </section>
  </div>`;

/** The page an email-change link opens: the shell, with the Account tab current. */
export const ACCOUNT_EMAIL_HTML = dashHtml({ title: "Confirm your new email address", active: "account", main: EMAIL_MAIN, script: "/dash/account-email.js" });

export const ACCOUNT_EMAIL_JS = `(function () {
  "use strict";
  var fragment = location.hash;
  if (fragment !== "") history.replaceState(null, "", location.pathname + location.search);
  // Above, first, before anything else: the part of the address after # (the link's code)
  // was read and taken out of the address bar, so it stays in no history entry.

  var TEXT = {
    confirming: "Confirming…",
    nowBefore: "Your email address is now ",
  };
  var STATES = ["confirm", "first", "done", "dead"];

  var $ = function (id) { return document.getElementById(id); };
  // The code, only in the shape a link carries; anything else is no code.
  var match = /^#c=(dpe_[0-9a-f]{40})$/.exec(fragment);
  var code = match === null ? "" : match[1];
  fragment = "";
  match = null;

  function sayIn(line, text) {
    line.textContent = text;
    line.hidden = text === "";
  }

  function busy(btn, on, label) {
    if (on) {
      btn.setAttribute("data-label", btn.textContent);
      btn.textContent = label;
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
    } else {
      btn.textContent = btn.getAttribute("data-label") || btn.textContent;
      btn.removeAttribute("aria-busy");
      btn.disabled = false;
    }
  }

  // Shows one state and moves the focus to its heading.
  function only(id, heading) {
    STATES.forEach(function (s) { $(s).hidden = s !== id; });
    if (heading) $("h-" + id).focus();
  }

  // The link no longer works: the code is forgotten.
  function dead() {
    code = "";
    only("dead", true);
  }

  // Nobody is signed in: the code is forgotten; the mail still holds the link.
  function first() {
    code = "";
    only("first", true);
  }

  var btn = $("confirm-button");
  var message = $("confirm-message");
  // The account's address when the page started, and whether a confirm's answer was lost.
  var started = "";
  var lost = false;

  // Done: mockup 8's third box, with the new and the previous address.
  function done(now, before) {
    code = "";
    $("h-done").textContent = TEXT.nowBefore + now;
    $("done-old").textContent = before;
    only("done", true);
  }

  // A refusal after a lost answer: done when the session's address has changed since the
  // page started, else the dead link.
  function refused() {
    if (!lost) { dead(); return; }
    Dash.api("GET", "/api/v1/session").then(function (res) {
      var d = res.data;
      var now = res.status === 200 && d !== null && typeof d === "object" && d.account !== null && typeof d.account === "object" && typeof d.account.email === "string" ? d.account.email : "";
      if (now !== "" && started !== "" && now !== started) done(now, started);
      else dead();
    }, function () { dead(); });
  }
  $("first-button").addEventListener("click", function () { Dash.signedOut(); });

  if (code === "") {
    dead();
    return;
  }

  $("confirm-button").addEventListener("click", function () {
    if (code === "" || btn.disabled) return;
    sayIn(message, "");
    busy(btn, true, TEXT.confirming);
    function failed(res) {
      busy(btn, false);
      sayIn(message, Dash.failure(res));
      btn.focus();
    }
    Dash.api("POST", "/api/v1/account/email/confirm", { code: code }).then(function (res) {
      var d = res.data;
      if (res.status === 200 && d !== null && typeof d === "object" && typeof d.email === "string" && typeof d.previous_email === "string") {
        busy(btn, false);
        done(d.email, d.previous_email);
        return;
      }
      if (res.status === 401) { busy(btn, false); first(); return; }
      if (res.status === 400 && Dash.errorOf(res) === "bad_code") { busy(btn, false); refused(); return; }
      failed(res);
    }, function () {
      // No answer came: the change may or may not have been made.
      lost = true;
      failed(null);
    });
  });

  Dash.start(function (who) {
    started = who.email;
    only("confirm", false);
  }, first);
})();
`;
