// The dashboard's billing screens (0.1.57, Plan 2l), served only on a site with billing switched
// on (src/dash/routes.ts registers them only then; without the settings each is the app's own
// 404 and no page, script or request of billing exists). Every sentence is from the approved
// mockups (Files/Mythicshot billing/billing-mockups.html), sections 2, 3 and 5; the Subscribe
// page's three sentences are the owner's approved embedded-checkout wording, and the run-out
// trial's two (TRIAL_OVER_WORDS) the owner approved on 2026-11-23, each one constant.
//
// - BILLING_JS, /dash/billing.js: loaded by the shared script (src/dash/script.ts) on every
//   dashboard page when the session answer says `billing: true`. It asks GET /api/v1/billing
//   once and draws, through createElement and textContent only, the one notice strip at the
//   top of the page where one applies (section 2) and, on the Account page, the Billing card
//   under the account's details in one of its four states (section 3). Subscribe is a link to
//   the Subscribe page; Manage subscription asks POST /api/v1/billing/portal and sends the
//   browser to the address Stripe answered (a top-level navigation), only when it is on
//   billing.stripe.com.
// - The Subscribe page, /billing/subscribe: the plan's summary, then the box Stripe's own
//   embedded checkout mounts in. Its script asks POST /api/v1/billing/checkout for the
//   checkout's client secret and the site's publishable key (no key is written in any script),
//   and mounts Stripe's form with Stripe's script, the one page that loads one (STRIPE_JS_URL)
//   under the one loosened policy (SUBSCRIBE_CSP, src/dash/routes.ts).
// - The return page, /billing/return: where Stripe sends a person back, with the checkout's id.
//   It grants nothing: it asks GET /api/v1/billing (with that id) until the workspace's own
//   record says it is subscribed, which only Stripe's signed notice makes so.
// A failure shows the dashboard's one failure sentence (Dash.failure) and nothing new.
import { RETURN_PATH, SUBSCRIBE_PATH } from "../billing-rules.ts";
import { DOWNLOAD_ALL_BUILT } from "../removal-rules.ts";
import { STRIPE_JS_URL } from "../stripe.ts";
import { dashHtml } from "./shell.ts";

/** The Subscribe page's wording (approved by the owner), one sentence each. */
export const SUBSCRIBE_WORDS = {
  heading: "Subscribe to Mythicshot Essentials",
  summary: "$7 a month, plus tax where it applies. 5 GB for tours, images and clips. Cancel any time.",
  seller: "The payment form below is run by Stripe. The seller is Link, a Stripe company, so your receipt and card statement show Link, not Mythicshot. We never see your card.",
  back: "Back to your account",
} as const;

/**
 * A trial that has run out (wording approved by the owner on 2026-11-23): the notice strip's sentences
 * (the first in bold, as every notice's lead) and the Billing card's row in place of "Trial ends".
 */
export const TRIAL_OVER_WORDS = {
  strip: "Your trial has ended. You can view, download and delete, but not publish. Subscribe to keep your tours, images and clips.",
  row: "Trial ended",
} as const;

/** Section 7's sentence, added to the trial-ending and ended notices once the download exists. */
export const DOWNLOAD_SENTENCE = "You can download everything from your Account page.";

/**
 * The line of the notice script that adds DOWNLOAD_SENTENCE to the notice of a trial ending within
 * 7 days, a trial that has ended and an ended subscription: only in a build with the download
 * (DOWNLOAD_ALL_BUILT, src/removal-rules.ts); without it the script is the one before, byte for byte.
 */
const DOWNLOAD_LINE = DOWNLOAD_ALL_BUILT
  ? `    if (s.state === "ended" || s.state === "trial_over" || (s.state === "trial" && kind === "warn")) text.push([${JSON.stringify(" " + DOWNLOAD_SENTENCE)}, false]);
`
  : "";

/** The approved words of the notices and the Billing card (mockup sections 2 and 3). */
const WORDS = {
  trialLead: "Trial:",
  daysLeft: " days left. You're using ",
  dayLeft: " day left. You're using ",
  of: " of ",
  stop: ".",
  endsIn: "Your trial ends in ",
  endsInDays: " days.",
  endsInDay: " day.",
  keep: " Subscribe to keep your tours, images and clips. On ",
  removed: " they are removed.",
  lastPayment: "Your last payment didn't go through.",
  tryAgain: " We'll try again. Update your card to keep your subscription.",
  ended: "Your subscription has ended.",
  endedRest: " You can view, download and delete, but not publish. Your links stay up until ",
  endedAnd: ", and everything is removed on ",
  subscribe: "Subscribe",
  subscribeAgain: "Subscribe again",
  manage: "Manage subscription",
  trial: "Trial",
  used: " used",
  trialEnds: "Trial ends",
  afterThat: "After that",
  contentRemovedAfter: "Your content is removed",
  trialText: "Subscribe for $7 a month to get 5 GB and keep everything.",
  planTitle: "Mythicshot Essentials, $7 a month",
  nextPayment: "Next payment",
  soldBy: "Sold by",
  link: "Link, a Stripe company",
  subscribedText: "Receipts come from Link by email. Change your card or cancel on Stripe's page.",
  ends: "Ends",
  linksUntil: "Links stay up until",
  contentRemoved: "Content removed",
  endingText: "You cancelled. Nothing changes until the end date, and you can keep the subscription from Stripe's page.",
  noSubscription: "No subscription",
  endedRow: "Ended",
  endedText: "Subscribe again before then and everything comes back as it was.",
} as const;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * The shared part of the billing scripts: dates as "21 February 2027", and making elements. A
 * date is the UTC day (0.1.61), as the warning mails write it and the removal sweep counts it, so
 * the day shown is the day acted on wherever the person is.
 */
const COMMON = `  var MONTHS = ${JSON.stringify(MONTHS)};
  var $ = function (id) { return document.getElementById(id); };
  function dateOf(ms) {
    if (typeof ms !== "number" || !isFinite(ms)) return "";
    var d = new Date(ms);
    return d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear();
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function num(v) { return typeof v === "number" && isFinite(v) ? v : null; }`;

export const BILLING_JS = `(function () {
  "use strict";
  var W = ${JSON.stringify(WORDS)};
  var OVER = ${JSON.stringify(TRIAL_OVER_WORDS)};
${COMMON}

  // A link to the Subscribe page, as a button.
  function subscribeLink(text) {
    var a = el("a", "btn", text);
    a.setAttribute("href", "${SUBSCRIBE_PATH}");
    return a;
  }

  // Manage subscription: Stripe's own page for the customer on record, in this tab.
  function manageButton(line) {
    var b = el("button", "btn quiet", W.manage);
    b.type = "button";
    b.addEventListener("click", function () {
      b.disabled = true;
      Dash.api("POST", "/api/v1/billing/portal").then(function (res) {
        var url = res.status === 200 && res.data !== null && typeof res.data === "object" ? res.data.url : null;
        if (typeof url === "string" && url.indexOf("https://billing.stripe.com/") === 0) {
          location.assign(url);
          return;
        }
        b.disabled = false;
        line.textContent = Dash.failure(res);
        line.hidden = false;
      }, function () {
        b.disabled = false;
        line.textContent = Dash.failure(null);
        line.hidden = false;
      });
    });
    return b;
  }

  function message() {
    var line = el("p", "message");
    line.setAttribute("role", "status");
    line.setAttribute("aria-live", "polite");
    line.hidden = true;
    return line;
  }

  // ---- The notice at the top of every page (section 2) ----
  function strip(s) {
    var kind = "";
    var text = [];
    var action = null;
    var line = message();
    var days = num(s.days_left);
    if (s.state === "trial" && days !== null && days > 7) {
      text = [[W.trialLead, true], [" " + days + (days === 1 ? W.dayLeft : W.daysLeft) + Dash.formatBytes(s.used_bytes) + W.of + Dash.formatBytes(s.allowance_bytes) + W.stop, false]];
      action = subscribeLink(W.subscribe);
    } else if (s.state === "trial" && days !== null) {
      kind = "warn";
      text = [[W.endsIn + days + (days === 1 ? W.endsInDay : W.endsInDays), true], [W.keep + dateOf(s.removed_at) + W.removed, false]];
      action = subscribeLink(W.subscribe);
    } else if (s.state === "trial_over") {
      kind = "bad";
      var cut = OVER.strip.indexOf(". ") + 1;
      text = [[OVER.strip.slice(0, cut), true], [OVER.strip.slice(cut), false]];
      action = subscribeLink(W.subscribe);
    } else if (s.state === "past_due") {
      kind = "warn";
      text = [[W.lastPayment, true], [W.tryAgain, false]];
      action = s.manage === true ? manageButton(line) : null;
    } else if (s.state === "ended") {
      kind = "bad";
      // An ended workspace on no removal clock (an allowance set by hand) has no dates: the
      // sentence ends before them (0.1.61), in the same approved words.
      text = num(s.links_until) !== null && num(s.removed_at) !== null
        ? [[W.ended, true], [W.endedRest + dateOf(s.links_until) + W.endedAnd + dateOf(s.removed_at) + W.stop, false]]
        : [[W.ended, true], [W.endedRest.slice(0, W.endedRest.indexOf(" Your links")), false]];
      action = subscribeLink(W.subscribeAgain);
    } else {
      return;
    }
${DOWNLOAD_LINE}    var bar = el("div", kind === "" ? "billing-strip" : "billing-strip " + kind);
    bar.id = "billing-strip";
    var span = el("span", "billing-strip-text");
    text.forEach(function (part) { span.appendChild(part[1] ? el("b", "", part[0]) : document.createTextNode(part[0])); });
    bar.appendChild(span);
    if (action !== null) bar.appendChild(action);
    bar.appendChild(line);
    var main = document.querySelector("main.page");
    if (main !== null) main.insertBefore(bar, main.firstChild);
  }

  // ---- The Billing card on the Account page (section 3) ----
  function row(label, value) {
    var r = el("div", "row");
    r.appendChild(el("span", "", label));
    r.appendChild(el("span", "r", value));
    return r;
  }

  function meter(card, s) {
    var used = num(s.used_bytes);
    var allowance = num(s.allowance_bytes);
    if (used === null || allowance === null || allowance <= 0) return;
    var bar = el("div", "meter");
    bar.setAttribute("aria-hidden", "true");
    var fill = el("div", "meter-fill");
    fill.style.width = Math.min(100, Math.max(0, Math.round(used / allowance * 100))) + "%";
    bar.appendChild(fill);
    card.appendChild(bar);
    card.appendChild(el("p", "hint", Dash.formatBytes(used) + W.of + Dash.formatBytes(allowance) + W.used));
  }

  function card(s) {
    var details = $("h-details");
    var after = details !== null ? details.parentNode : null;
    if (after === null || after.parentNode === null) return;
    var c = el("div", "card billing-card");
    c.id = "billing-card";
    var line = message();
    var acts = el("div", "two");
    var title = el("h2", "card-title");
    title.id = "h-billing";
    c.appendChild(title);
    if (s.state === "trial" || s.state === "trial_over") {
      title.textContent = W.trial;
      meter(c, s);
      c.appendChild(row(s.state === "trial_over" ? OVER.row : W.trialEnds, dateOf(s.trial_ends_at)));
      c.appendChild(row(W.afterThat, W.contentRemovedAfter));
      c.appendChild(el("p", "hint", W.trialText));
      acts.appendChild(subscribeLink(W.subscribe));
    } else if (s.state === "subscribed" || s.state === "past_due") {
      title.textContent = W.planTitle;
      meter(c, s);
      c.appendChild(row(W.nextPayment, dateOf(s.next_payment_at)));
      c.appendChild(row(W.soldBy, W.link));
      c.appendChild(el("p", "hint", W.subscribedText));
      if (s.manage === true) acts.appendChild(manageButton(line));
    } else if (s.state === "ending") {
      title.textContent = W.planTitle;
      c.appendChild(row(W.ends, dateOf(s.ends_at)));
      c.appendChild(row(W.linksUntil, dateOf(s.links_until)));
      c.appendChild(row(W.contentRemoved, dateOf(s.removed_at)));
      c.appendChild(el("p", "hint", W.endingText));
      if (s.manage === true) acts.appendChild(manageButton(line));
    } else if (s.state === "ended") {
      title.textContent = W.noSubscription;
      c.appendChild(row(W.endedRow, dateOf(s.ended_at)));
      // Without the removal's dates (no clock: an allowance set by hand) the two rows are left out.
      if (num(s.links_until) !== null) c.appendChild(row(W.linksUntil, dateOf(s.links_until)));
      if (num(s.removed_at) !== null) c.appendChild(row(W.contentRemoved, dateOf(s.removed_at)));
      c.appendChild(el("p", "hint", W.endedText));
      acts.appendChild(subscribeLink(W.subscribeAgain));
    } else {
      return;
    }
    c.appendChild(line);
    c.appendChild(acts);
    after.parentNode.insertBefore(c, after.nextSibling);
  }

  // The two billing pages draw their own content.
  if (location.pathname === "${SUBSCRIBE_PATH}" || location.pathname === "${RETURN_PATH}") return;
  Dash.api("GET", "/api/v1/billing").then(function (res) {
    var s = res.data;
    if (res.status !== 200 || s === null || typeof s !== "object" || typeof s.state !== "string") return;
    strip(s);
    if (document.body.getAttribute("data-page") === "account") card(s);
  }, function () {});
})();
`;

const SUBSCRIBE_MAIN = `  <section class="billing-page" aria-labelledby="h-page">
  <h1 id="h-page" tabindex="-1">${SUBSCRIBE_WORDS.heading}</h1>
  <p class="sub" id="subscribe-summary">${SUBSCRIBE_WORDS.summary}</p>
  <p class="hint" id="subscribe-seller">${SUBSCRIBE_WORDS.seller}</p>
  <p class="message" id="subscribe-message" role="status" aria-live="polite" hidden></p>
  <div class="checkout" id="checkout"></div>
  <p><a href="/account" id="subscribe-back">${SUBSCRIBE_WORDS.back}</a></p>
  </section>`;

/**
 * The Subscribe page: the shell with Stripe's script loaded before the page's own (both
 * deferred, so in order), and nothing else of Stripe's in the document.
 */
export const SUBSCRIBE_HTML = dashHtml({ title: "Account", active: "account", main: SUBSCRIBE_MAIN, script: "/dash/billing-subscribe.js" }).replace(
  '<script src="/dash/dash.js" defer></script>',
  `<script src="${STRIPE_JS_URL}" defer></script>\n<script src="/dash/dash.js" defer></script>`,
);

export const SUBSCRIBE_JS = `(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  function failed(res) {
    var line = $("subscribe-message");
    line.textContent = Dash.failure(res);
    line.hidden = false;
  }
  Dash.start(function () {
    // Stripe's script did not load: nothing is asked of the server.
    if (typeof window.Stripe !== "function") {
      failed(null);
      return;
    }
    Dash.api("POST", "/api/v1/billing/checkout").then(function (res) {
      var d = res.data;
      if (res.status !== 200 || d === null || typeof d !== "object" || typeof d.client_secret !== "string" || typeof d.publishable_key !== "string") {
        failed(res);
        return;
      }
      var secret = d.client_secret;
      try {
        var stripe = window.Stripe(d.publishable_key);
        Promise.resolve(stripe.createEmbeddedCheckoutPage({ clientSecret: secret })).then(function (checkout) {
          checkout.mount("#checkout");
        }, function () { failed(null); });
      } catch (e) {
        failed(null);
      }
    }, function () { failed(null); });
  });
})();
`;

const RETURN_MAIN = `  <section class="billing-page" aria-live="polite">
  <div class="card" id="return-waiting" hidden>
    <h1 class="card-title">Confirming your payment</h1>
    <p class="sub">This usually takes a few seconds. You can leave this page; your account updates by itself.</p>
  </div>
  <div class="card" id="return-done" hidden>
    <h1 class="card-title">You're subscribed</h1>
    <p class="sub">You now have 5 GB. Your receipt is on its way by email from Link.</p>
    <div class="two"><a class="btn" href="/tours">Go to your tours</a></div>
  </div>
  <div class="card" id="return-left" hidden>
    <h1 class="card-title">No payment was made</h1>
    <p class="sub">Nothing has changed. You can subscribe whenever you're ready.</p>
    <div class="two"><a class="btn quiet" href="/account">Back to your account</a></div>
  </div>
  </section>`;

export const RETURN_HTML = dashHtml({ title: "Account", active: "account", main: RETURN_MAIN, script: "/dash/billing-return.js" });

/**
 * How the return page waits, within LIMITS_BILLING.checkoutState: it asks Stripe about the
 * checkout (with session_id) at most CHECKOUT_ASKS times, and otherwise reads the workspace's
 * own stored state, which asks Stripe nothing, with a wait that grows from POLL_FIRST_MS to
 * POLL_MOST_MS, at most POLLS times in all.
 */
const CHECKOUT_ASKS = 3;
const POLL_FIRST_MS = 2000;
const POLL_MOST_MS = 15000;
const POLLS = 60;

export const RETURN_JS = `(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var SUBSCRIBED = ["subscribed", "past_due", "ending"];
  function show(id) {
    ["return-waiting", "return-done", "return-left"].forEach(function (x) { $(x).hidden = x !== id; });
  }
  // The checkout's id Stripe put in the address, when it is of a checkout's shape; else none.
  var match = /(?:^|&)session_id=(cs_[A-Za-z0-9_]{1,250})(?:&|$)/.exec(location.search.slice(1));
  var CHECKOUT_ASKS = ${CHECKOUT_ASKS};
  var asks = 0;
  var tries = 0;
  var wait = ${POLL_FIRST_MS};
  // The checkout's state is asked only while it may tell something new: first, and after Stripe could not be asked.
  var askCheckout = match !== null;
  function later() {
    if (tries >= ${POLLS}) return;
    setTimeout(look, wait);
    wait = Math.min(Math.round(wait * 1.5), ${POLL_MOST_MS});
  }
  function look() {
    tries += 1;
    var withCheckout = askCheckout && asks < CHECKOUT_ASKS;
    if (withCheckout) asks += 1;
    Dash.api("GET", "/api/v1/billing" + (withCheckout ? "?session_id=" + match[1] : "")).then(function (res) {
      var s = res.data;
      if (res.status === 429) { show("return-waiting"); askCheckout = false; later(); return; }
      if (res.status !== 200 || s === null || typeof s !== "object") {
        $("dash-load").textContent = Dash.failure(res);
        return;
      }
      if (SUBSCRIBED.indexOf(s.state) >= 0) {
        show("return-done");
        return;
      }
      // Stripe is still confirming the payment: wait for its notice.
      if (s.confirming === true) {
        show("return-waiting");
        askCheckout = false;
        later();
        return;
      }
      if (withCheckout) {
        // Paid at Stripe and the notice not taken yet, or Stripe could not be asked: wait.
        if (s.checkout === "complete" || s.checkout === "unknown") {
          show("return-waiting");
          askCheckout = s.checkout === "unknown";
          later();
          return;
        }
        // Still open, expired, or no checkout of this workspace: nothing was paid.
        show("return-left");
        return;
      }
      // Waiting on the workspace's own state only.
      if (!$("return-waiting").hidden) { later(); return; }
      show("return-left");
    }, function () {
      $("dash-load").textContent = Dash.failure(null);
    });
  }
  Dash.start(function () { look(); });
})();
`;
