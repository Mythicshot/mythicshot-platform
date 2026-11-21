// Who can view, for the dashboard pages that share things: the Tours page (src/dash/tours.ts)
// and the Images and GIFs pages (src/dash/media.ts). The Sharing box was built for tours (the
// restricted tours set's mockups 1 to 3) and is reused as it is for images and clips, so its
// markup and its script are made here, once, and each page puts them in its own document and
// script. Every function returns text; nothing here runs in this process.
//
// The Tours page's document and script are exactly what they were before this module existed
// (the tours page's tests run against them unchanged): each fragment below is the tour's own
// text, with the few places where an item differs chosen by the page's SharePage.
//
// What differs for an image or a clip (SharePage.moves false):
// - Nothing moves. A tour's pictures are moved between stores when it is restricted or made
//   public, so its box can show a move's progress, a move that stopped, and the refusals that
//   belong to a move; an item's files were always private and served through the app, so a
//   change is in force at once (src/media-access.ts). The item's box has no move: no progress,
//   no stopped move, no 202 loop, no pagehide stop, and an item's state never has a move
//   (switching is always null, so the paths that read it never run).
// - 409 too_large_to_restrict, which only an item answers, is told as a plain sentence.
// - A line under the options, shown while a restricted setting is chosen for an item that is
//   public now, says that restricting takes effect at once on this site but that anyone who
//   already opened or saved the item keeps their copy.
// The words that name the thing ("tour", "image", "clip") are the page's own.

/** What one page's Sharing box is about. */
export type SharePage = {
  /** Whether a change moves pictures (a tour), with the progress, the stopped move and their refusals; false for an image or a clip. */
  moves: boolean;
  /** The thing the box is about, in the singular and the plural: "tour", "image", "clip". */
  noun: string;
  nouns: string;
  /** The name of the page script's variable holding the pattern of the API's ids. */
  idVar: string;
  /** The API path the id follows: "/api/v1/tours/" or "/api/v1/media/". */
  api: string;
  /** The JavaScript expression for the title of `t`, the row's thing, as the box's heading shows it. */
  title: string;
  /** The page's own words of the box (in the document and the script) that are not shared. */
  words: {
    /** The button that confirms restricting: "Restrict tour". */
    restrict: string;
    /** On the question before restricting, under its sentence. */
    askWarn: string;
    /** For an item only: the line shown while a restricted setting is chosen for a public item. */
    copies?: string;
    /** For an item only: the refusal 409 too_large_to_restrict. */
    tooLarge?: string;
  };
};

/** The Sharing box's markup, put after the page's other dialogs. */
export function shareHtml(p: SharePage): string {
  const w = p.words;
  const M = (tours: string, item = "") => (p.moves ? tours : item);
  return `  <div class="backdrop" id="share-dialog" hidden>
    <div class="dialog" id="share-box" role="dialog" aria-modal="true" aria-labelledby="share-title">
      <h2 id="share-title" tabindex="-1"></h2>
      <div id="share-form">
        <fieldset class="opts">
          <legend class="vh">Who can view</legend>
          <label class="opt" for="share-public"><input type="radio" name="share-access" id="share-public" value="public"><span class="opt-text"><span class="opt-name">Anyone with the link</span><span class="opt-d">No sign-in. Fastest for viewers.</span></span></label>
          <label class="opt" for="share-people"><input type="radio" name="share-access" id="share-people" value="people"><span class="opt-text"><span class="opt-name">Only people I choose</span><span class="opt-d">They prove their email address with a link we send them.</span></span></label>
          <label class="opt" for="share-me"><input type="radio" name="share-access" id="share-me" value="me"><span class="opt-text"><span class="opt-name">Only me</span><span class="opt-d" id="share-me-text"></span></span></label>
        </fieldset>
        <p class="warn-box" id="share-nomail" hidden>This site cannot send mail, so only "Anyone with the link" can be chosen here.</p>
${M("", `        <p class="warn-box" id="share-copies" hidden>${w.copies}</p>\n`)}        <div id="share-people-part" hidden>
          <label for="share-input" id="share-count"></label>
          <ul class="chips" id="share-chips"></ul>
          <div class="inline">
            <input class="field" id="share-input" type="text" placeholder="name@example.com" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="share-add-message share-hint">
            <button type="button" class="btn quiet" id="share-add">Add</button>
          </div>
          <p class="message" id="share-add-message" role="status" aria-live="polite" hidden></p>
          <p class="hint" id="share-hint">You can always view your own ${p.nouns}. People on the list are not told they were added: send them the link yourself.</p>
        </div>
      </div>
      <div id="share-ask" hidden>
        <p class="sub" id="share-ask-text"></p>
        <p class="warn-box" id="share-ask-warn" hidden>${w.askWarn}</p>
      </div>
${M(`      <p class="sub" id="share-resume" hidden></p>\n`)}      <p class="warn-box" id="share-nomail-kept" hidden>This site cannot send mail, so once this ${p.noun} is public it cannot be restricted again here.</p>
${M(`      <div id="share-moving" hidden>
        <progress class="progress" id="share-progress" max="1" value="0" aria-hidden="true"></progress>
        <p class="hint" id="share-moving-text"></p>
      </div>
`)}      <p class="message" id="share-message" role="status" aria-live="polite" hidden></p>
      <div class="two" id="share-form-buttons">
        <button type="button" class="btn quiet" id="share-cancel">Cancel</button>
        <button type="button" class="btn" id="share-save">Save</button>
      </div>
      <div class="two" id="share-ask-buttons" hidden>
        <button type="button" class="btn quiet" id="share-keep"></button>
        <button type="button" class="btn" id="share-go"></button>
      </div>
${M(`      <div class="two" id="share-resume-buttons" hidden>
        <button type="button" class="btn quiet" id="share-close">Cancel</button>
        <button type="button" class="btn quiet" id="share-restricted">Keep it restricted</button>
        <button type="button" class="btn" id="share-make-public">Make public</button>
      </div>
`)}    </div>
  </div>`;
}

/** The box's words, as lines of the page script's TEXT object (each line ends with a comma). */
export function shareText(p: SharePage): string {
  const n = p.noun;
  const M = (tours: string, item = "") => (p.moves ? tours : item);
  return `    anyone: "Anyone with the link",
    onePerson: "1 person",
    people: " people",
    nobody: "Nobody yet",
    onlyMe: "Only me",
    noSetting: "—",
    sharing: "Sharing…",
    shareBefore: 'Who can view "',
    meBefore: "You prove your own address, ",
    meAfter: ", the same way.",
    countBefore: "People who can view · ",
    of: " of ",
    removeBefore: "Remove ",
    removeMark: "✕",
    quote: '"',
    notEmailAfter: '" does not look like an email address. Nothing was added.',
    fullBefore: "The list is full at ",
    fullAfter: " people. Remove someone first.",
    wouldBefore: "That would make ",
    wouldMiddle: " people, and the list holds ",
    wouldAfter: ". Nothing was added.",
    saving: "Saving…",
    restrictBefore: 'Restrict "',
    restrictPeople: "From now on only the people you chose can open the link. The link itself stays the same.",
    restrictMe: "From now on only you can open the link. The link itself stays the same.",
    keepPublic: "Keep it public",
    restrictTour: ${JSON.stringify(p.words.restrict)},
    publicBefore: 'Let anyone with the link view "',
    publicText: "Nobody will be asked to sign in any more. Anyone who has or gets the link can open it. Your list of people is kept in case you restrict it again.",
    keepRestricted: "Keep it restricted",
    makePublic: "Make public",
${M(`    movingBefore: "Moving the pictures, ",
    movingAfter: ". Keep this page open.",
    stoppedBefore: "Moving this tour's pictures stopped at ",
    resumeBoth: '. "Keep it restricted" leaves it as it is now; "Make public" finishes making it public.',
    resumeRestrict: '. Choose "Keep it restricted" to finish restricting it.',
`)}    cannotRestrict: "This site cannot send mail, so this ${n} cannot be restricted. Nothing was changed.",
${M(`    switching: "This tour's pictures are still being moved. Open Sharing again to finish that first.",
    cancelled: "The tour was unpublished or deleted while its pictures were being moved, so the change did not finish.",
`, `    tooLarge: ${JSON.stringify(p.words.tooLarge)},
`)}    busyAgain: "The ${n} changed while this was being saved. Press Save again.",
${M(`    changedMove: "This tour changed meanwhile. It is shown as it is now: choose again.",
    republish: "This tour's pictures could not be moved. Unpublish it, publish it again from Mythicshot, then set who can view it.",
`)}    badViewerAfter: '" is not accepted as an email address. Remove it and press Save again.',
    tooManyBefore: "The list holds at most ",
    tooManyAfter: " people. Remove some and press Save again.",
`;
}

/** The box's constants, as lines of the page script. */
export function shareConstants(p: SharePage): string {
  const M = (tours: string, item = "") => (p.moves ? tours : item);
  return `${M(`  // A change of who can view is sent again after this pause while it answers 202, at most
  // SHARE_ROUNDS times in all; after a lost answer or 500 access_failed after MISS_PAUSES_MS,
  // at most MAX_MISSES times in a row. Then it stops, whatever the answers.
  var PAUSE_MS = 300;
`, `  // A change of who can view is sent again after a lost answer or 500 access_failed, after
  // MISS_PAUSES_MS, at most MAX_MISSES times in a row and SHARE_ROUNDS times in all. Then it
  // stops, whatever the answers.
`)}  var MISS_PAUSES_MS = [1000, 3000];
  var MAX_MISSES = 3;
  var SHARE_ROUNDS = 5000;
  // How long the button that confirms a change between public and restricted stays inert (aria-disabled, still focusable) before it works.
  var ARM_MS = 600;
  // The settings, the most addresses a list holds when the API does not say, and how much of a refused entry is shown.
  var SETTINGS = ["public", "people", "me"];
  var LIMIT = 200;
  var ENTRY_SHOWN = 60;
`;
}

/** The box as a Dash.question, after the page's own question (`question`) and BEHIND. */
export function shareQuestion(p: SharePage): string {
  const M = (tours: string, item = "") => (p.moves ? tours : item);
  return `  // The Sharing box: its controls change while it is open, so it gives Tab its own order and
  // goes back a step from the question before a change between public and restricted.
  var shareQ = Dash.question({
    backdrop: "share-dialog",
    box: "share-box",
    role: "dialog",
    title: "share-title",
    message: "share-message",
    behind: BEHIND,
    fields: ["share-public", "share-people", "share-me", "share-input"],
    buttons: ["share-add", "share-cancel", "share-save", "share-keep", "share-go"${M(`, "share-close", "share-restricted", "share-make-public"`)}],
    lock: "disabled",
    order: shareOrder,
    beforeDismiss: shareBack,
  });
`;
}

/** The box's state, among the page script's variables. */
export function shareState(p: SharePage): string {
  const M = (tours: string, item = "") => (p.moves ? tours : item);
  return `  // The signed-in account's address, for "Only me".
  var myEmail = "";
${M(`  // The Sharing box's subject while it is open: { id, title, st (the state GET .../access
  // gave), choice, list (the addresses as edited here), view ("form", "ask", "resume" or
  // "moving"), pending (the body the question before a change is about), from (the view the
  // question came from), armed }.
  var share = null;
  // The page was left (pagehide): a change of who can view stops before its next send, so a
  // page restored from the back/forward cache never carries on by itself.
  var pageLeft = false;
`, `  // The Sharing box's subject while it is open: { id, title, st (the state GET .../access
  // gave), choice, list (the addresses as edited here), view ("form" or "ask"), pending (the
  // body the question before a change is about), from (the view the question came from),
  // armed }.
  var share = null;
`)}`;
}

/** Helpers the box and the rows use: other people's text in a line, a held key, the open question, a pause. */
export function shareHelpers(): string {
  return `  // A line made of fixed text and other people's text, alternately: each of theirs (at the odd
  // places) in its own bidi-isolated element, so its letters cannot reorder the words around it.
  function fill(line, parts) {
    line.textContent = "";
    for (var i = 0; i < parts.length; i++) line.appendChild(el("span", i % 2 === 1 ? "name" : "", parts[i]));
  }

  // As sayIn, with other people's text in it isolated as fill does.
  function sayParts(line, parts) {
    fill(line, parts);
    line.hidden = parts.join("") === "";
  }

  // A held key's repeats never press a button.
  function noRepeat(b) {
    b.addEventListener("keydown", function (ev) {
      if (ev.repeat === true && (ev.key === "Enter" || ev.key === " ")) ev.preventDefault();
    });
  }

  function anyOpen() {
    return question.isOpen() || shareQ.isOpen();
  }

  function pause(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }
`;
}

/**
 * The More menu of a row: openTheMenu, closeMenu and moreMenu(t, i, items, titleId), whose
 * items are { text, kind, danger }. "delete" asks the page's ask(t), "share" opens the box;
 * on the Tours page any other kind is a change the page runs (change).
 */
export function shareMenu(p: SharePage): string {
  const M = (tours: string, item = "") => (p.moves ? tours : item);
  return `  // ---- The More menu ----

  function openTheMenu(m, index) {
    closeMenu(false);
    m.menu.hidden = false;
    m.button.setAttribute("aria-expanded", "true");
    openMenu = m;
    m.entries[index].focus();
  }

  function closeMenu(refocus) {
    if (openMenu === null) return;
    var m = openMenu;
    openMenu = null;
    m.menu.hidden = true;
    m.button.setAttribute("aria-expanded", "false");
    if (refocus) m.button.focus();
  }

  function moreMenu(t, i, items, titleId) {
    var wrap = el("div", "more");
    var btn = el("button", "btn sm quiet", TEXT.more);
    btn.type = "button";
    btn.setAttribute("aria-haspopup", "true");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", "menu-" + i);
    btn.setAttribute("aria-describedby", titleId);
    rowButtons.push(btn);
    moreOf[t.id] = btn;
    var menu = el("div", "menu");
    menu.setAttribute("id", "menu-" + i);
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-labelledby", titleId);
    menu.hidden = true;
    var m = { wrap: wrap, button: btn, menu: menu, entries: [] };
    items.forEach(function (item) {
      var entry = el("button", item.danger ? "danger" : "", item.text);
      entry.type = "button";
      entry.setAttribute("role", "menuitem");
      entry.setAttribute("tabindex", "-1");
      noRepeat(entry);
      entry.addEventListener("click", function () {
        if (openMenu !== m) return;
        closeMenu(true);
        if (item.kind === "delete") ask(t);
        else if (item.kind === "share") askShare(t);
${M(`        else change(t, item.kind, btn);
`)}      });
      menu.appendChild(entry);
      m.entries.push(entry);
      rowButtons.push(entry);
    });
    btn.addEventListener("click", function () {
      if (openMenu === m) closeMenu(true);
      else openTheMenu(m, 0);
    });
    btn.addEventListener("keydown", function (ev) {
      if (ev.key === "ArrowDown") { ev.preventDefault(); openTheMenu(m, 0); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); openTheMenu(m, m.entries.length - 1); }
    });
    menu.addEventListener("keydown", function (ev) {
      var n = m.entries.length;
      var at = m.entries.indexOf(document.activeElement);
      if (ev.key === "ArrowDown") { ev.preventDefault(); m.entries[(at + 1) % n].focus(); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); m.entries[(at - 1 + n) % n].focus(); }
      else if (ev.key === "Home") { ev.preventDefault(); m.entries[0].focus(); }
      else if (ev.key === "End") { ev.preventDefault(); m.entries[n - 1].focus(); }
      else if (ev.key === "Escape") { ev.preventDefault(); closeMenu(true); }
      else if (ev.key === "Tab") closeMenu(false);
    });
    wrap.appendChild(btn);
    wrap.appendChild(menu);
    return wrap;
  }
`;
}

/** viewOf(t): who can view the row's thing, as the list says it. */
export function shareViewOf(p: SharePage): string {
  const M = (tours: string, item = "") => (p.moves ? tours : item);
  return `${M(`  // Who can view a published tour, as the list says it: { text, tag } (an amber tag for a
  // restricted tour), or null for a tour that is not published, or a setting the page does not know.
  function viewOf(t) {
    if (t.status !== "published") return null;
`, `  // Who can view an item, as the list says it: { text, tag } (an amber tag for a restricted
  // one), or null for a setting the page does not know.
  function viewOf(t) {
`)}    if (t.access === "public") return { text: TEXT.anyone, tag: false };
    if (t.access === "me") return { text: TEXT.onlyMe, tag: true };
    if (t.access !== "people" || typeof t.viewers !== "number" || !isFinite(t.viewers) || t.viewers < 0) return null;
    return { text: t.viewers === 0 ? TEXT.nobody : t.viewers === 1 ? TEXT.onePerson : t.viewers + TEXT.people, tag: true };
  }
`;
}

/**
 * The box itself: reading who can view, the box and its options, the list and its field, the
 * question before a change between public and restricted, sending and deciding. It uses the
 * page's $, el, say, working, rowsDisabled, moreOf, reload() (the list read again: true when
 * shown, false when sent to sign in, else the failed answer or null) and Dash.
 */
export function shareScript(p: SharePage): string {
  // The thing as the comments name it (the words a person reads are in TEXT).
  const n = p.moves ? "tour" : "item";
  const M = (tours: string, item = "") => (p.moves ? tours : item);
  return `  // ---- Who can view: the Sharing box ----

  // The ${n}'s access path: only for an id of the API's shape, and escaped.
  function accessPath(id) {
    if (typeof id !== "string" || !${p.idVar}.test(id)) throw new TypeError("id");
    return "${p.api}" + encodeURIComponent(id) + "/access";
  }

${M(`  function isCount(n) {
    return typeof n === "number" && isFinite(n) && n >= 0;
  }

  // An answer of GET .../access (or a final PUT) as the page uses it, or null when it is not of the API's shape.
  function stateOf(d) {
    if (d === null || typeof d !== "object" || SETTINGS.indexOf(d.access) < 0 || !Array.isArray(d.viewers) || typeof d.can_restrict !== "boolean") return null;
    for (var i = 0; i < d.viewers.length; i++) if (typeof d.viewers[i] !== "string") return null;
    var sw = d.switching;
    if (sw !== null && (sw === undefined || typeof sw !== "object" || !isCount(sw.done) || !isCount(sw.total) || (sw.target !== "public" && sw.target !== "restricted"))) return null;
    return { access: d.access, viewers: d.viewers.slice(), limit: typeof d.limit === "number" && d.limit > 0 ? d.limit : LIMIT, canRestrict: d.can_restrict, switching: sw === null ? null : { done: sw.done, total: sw.total, target: sw.target } };
  }
`, `  // An answer of GET .../access (or of PUT) as the page uses it, or null when it is not of the
  // API's shape. Nothing of an ${n} moves, so its state never has a move (switching is null).
  function stateOf(d) {
    if (d === null || typeof d !== "object" || SETTINGS.indexOf(d.access) < 0 || !Array.isArray(d.viewers) || typeof d.can_restrict !== "boolean") return null;
    for (var i = 0; i < d.viewers.length; i++) if (typeof d.viewers[i] !== "string") return null;
    return { access: d.access, viewers: d.viewers.slice(), limit: typeof d.limit === "number" && d.limit > 0 ? d.limit : LIMIT, canRestrict: d.can_restrict, switching: null };
  }
`)}
  // Reads who can view the ${n}: { status (0 when no answer came), res, state (null unless a usable 200) }.
  function readAccess(id) {
    return Dash.api("GET", accessPath(id)).then(function (res) {
      return { status: res.status, res: res, state: res.status === 200 ? stateOf(res.data) : null };
    }, function () {
      return { status: 0, res: null, state: null };
    });
  }

  // Making a public ${n} restricted needs a site that can mail; a restricted one may always move between the two restricted settings.
  function mayRestrict(st) {
    return st.canRestrict || st.access !== "public";
  }

  function crosses(from, to) {
    return (from === "public") !== (to === "public");
  }

  function sameList(a, b) {
    if (a.length !== b.length) return false;
    var x = a.slice().sort();
    var y = b.slice().sort();
    for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }

  // An entry as a sentence shows it: at most ENTRY_SHOWN characters.
  function cut(text) {
    var chars = Array.from(String(text));
    return chars.length > ENTRY_SHOWN ? chars.slice(0, ENTRY_SHOWN).join("") + TEXT.cut : String(text);
  }

  // Shaped like an address (the server's check is stricter, and has the last word): visible
  // characters, one @ with something before it, and a host name of two or more labels whose
  // last is not all digits.
  function shaped(e) {
    if (e.length < 3 || e.length > 254 || !/^[\\x21-\\x7e]+$/.test(e)) return false;
    var at = e.indexOf("@");
    if (at < 1 || at !== e.lastIndexOf("@")) return false;
    var labels = e.slice(at + 1).split(".");
    if (labels.length < 2) return false;
    for (var i = 0; i < labels.length; i++) if (labels[i] === "") return false;
    return !/^[0-9]+$/.test(labels[labels.length - 1]);
  }

  function focusTour(id) {
    var b = moreOf[id];
    if (b !== undefined) b.focus();
    else $("h-page").focus();
  }

  // The remove buttons of the chips, in order, for Tab and for the focus after a removal.
  var chipButtons = [];

  // The box as \`share\` says it is: its view, the options, the list and the buttons.
  function renderShare() {
    var s = share;
    if (s === null) return;
    var st = s.st;
    var busy = shareQ.isWorking();
    var form = s.view === "form";
    $("share-form").hidden = !form;
    $("share-ask").hidden = s.view !== "ask";
${M(`    $("share-resume").hidden = s.view !== "resume";
    $("share-moving").hidden = s.view !== "moving";
`)}    $("share-form-buttons").hidden = !form;
    $("share-ask-buttons").hidden = s.view !== "ask";
${M(`    $("share-resume-buttons").hidden = s.view !== "resume";
    // On a site that cannot mail, a restricted tour made public cannot be restricted again
    // here: said with the options, on the question before making it public, and with a stopped move.
    var kept = !st.canRestrict && st.access !== "public" && (form || s.view === "resume" || (s.view === "ask" && s.pending !== null && s.pending.access === "public"));
    $("share-nomail-kept").hidden = !kept;
    var described = s.view === "ask" ? ["share-ask-text"].concat($("share-ask-warn").hidden ? [] : ["share-ask-warn"]) : s.view === "resume" ? ["share-resume"] : s.view === "moving" ? ["share-moving-text"] : [];
`, `    // On a site that cannot mail, a restricted ${n} made public cannot be restricted again
    // here: said with the options, and on the question before making it public.
    var kept = !st.canRestrict && st.access !== "public" && (form || (s.view === "ask" && s.pending !== null && s.pending.access === "public"));
    $("share-nomail-kept").hidden = !kept;
    var described = s.view === "ask" ? ["share-ask-text"].concat($("share-ask-warn").hidden ? [] : ["share-ask-warn"]) : [];
`)}    if (kept && s.view !== "form") described.push("share-nomail-kept");
    if (described.length > 0) $("share-box").setAttribute("aria-describedby", described.join(" "));
    else $("share-box").removeAttribute("aria-describedby");
    SETTINGS.forEach(function (a) {
      var radio = $("share-" + a);
      radio.checked = s.choice === a;
      radio.disabled = busy || (a !== "public" && !mayRestrict(st));
    });
    $("share-nomail").hidden = st.canRestrict || st.access !== "public";
${M("", `    // Restricting a public ${n} is in force at once here, and cannot take back a copy already made.
    $("share-copies").hidden = st.access !== "public" || s.choice === "public";
`)}    var people = s.choice === "people";
    $("share-people-part").hidden = !people;
    $("share-count").textContent = TEXT.countBefore + s.list.length + TEXT.of + st.limit;
    var chips = $("share-chips");
    chips.textContent = "";
    chipButtons = [];
    s.list.forEach(function (address) {
      var chip = el("li", "chip");
      chip.appendChild(el("span", "name", address));
      var x = el("button", "", TEXT.removeMark);
      x.type = "button";
      x.setAttribute("aria-label", TEXT.removeBefore + address);
      x.disabled = busy;
      noRepeat(x);
      x.addEventListener("click", function () { removeAddress(address); });
      chip.appendChild(x);
      chips.appendChild(chip);
      chipButtons.push(x);
    });
    $("share-input").disabled = busy || !people;
    $("share-add").disabled = busy || !people;
    [${M(`"share-cancel", "share-save", "share-keep", "share-close", "share-restricted", "share-make-public"`, `"share-cancel", "share-save", "share-keep"`)}].forEach(function (id) { $(id).disabled = busy; });
    // Until it is armed the button is inert but stays focusable and in the Tab order, so a
    // keyboard or screen reader user meets it, announced as unavailable, rather than finding
    // it missing; a press then does nothing (confirmAsk).
    $("share-go").disabled = busy;
    if (s.armed) $("share-go").removeAttribute("aria-disabled");
    else $("share-go").setAttribute("aria-disabled", "true");
${M(`    var sw = st.switching;
    $("share-make-public").hidden = sw === null || sw.target !== "public";
    $("share-resume").textContent = sw === null ? "" : TEXT.stoppedBefore + Math.min(sw.done, sw.total) + TEXT.of + sw.total + (sw.target === "public" ? TEXT.resumeBoth : TEXT.resumeRestrict);
`)}  }

  // The order Tab goes round the box in, as a browser would: the checked option alone of the
  // three, then the chips, the field and Add while the list shows, then the view's buttons.
  function shareOrder() {
    var s = share;
    if (s === null) return [];
    if (s.view === "ask") return [$("share-keep"), $("share-go")];
${M(`    if (s.view === "resume") return [$("share-close"), $("share-restricted"), $("share-make-public")].filter(function (b) { return !b.hidden; });
`)}    if (s.view !== "form") return [];
    var radios = SETTINGS.map(function (a) { return $("share-" + a); }).filter(function (r) { return !r.disabled; });
    var checked = radios.filter(function (r) { return r.checked; });
    var list = radios.length === 0 ? [] : [checked.length > 0 ? checked[0] : radios[0]];
    if (s.choice === "people") list = list.concat(chipButtons, [$("share-input"), $("share-add")]);
    return list.concat([$("share-cancel"), $("share-save")]);
  }

  function titleShare() {
    fill($("share-title"), [TEXT.shareBefore, share.title, TEXT.askAfter]);
  }

  // The field's own message line (a refused entry, a full list); addSays([]) hides it.
  function addSays(parts) {
    sayParts($("share-add-message"), parts);
    if (parts.length > 0) $("share-input").setAttribute("aria-invalid", "true");
    else $("share-input").removeAttribute("aria-invalid");
  }

  // Sharing… in ${M("a published tour", "an item")}'s More: who can view it is read first, then the box opens.
  function askShare(t) {
    if (working || anyOpen() || !${p.idVar}.test(t.id)) return;
    var id = t.id;
    working = true;
    say("");
    rowsDisabled(true);
    readAccess(id).then(function (got) {
      if (got.status === 401) { Dash.signedOut(); return; }
      if (got.state !== null) {
        working = false;
        rowsDisabled(false);
        openShare(t, got.state);
        return;
      }
      // Gone, or not readable: the list read again shows what is true.
      return reload().then(function (r) {
        working = false;
        if (r === false) return;
        if (r !== true) rowsDisabled(false);
        var gone = got.status === 404 && r === true && moreOf[id] === undefined;
        if (!gone) say(got.status === 0 ? Dash.TEXT.failed : Dash.failure(got.res));
        focusTour(id);
      });
    });
  }

  function openShare(t, st) {
    if (anyOpen()) return;
    var id = t.id;
    share = { id: id, title: ${p.title}, st: st, choice: st.access, list: st.viewers.slice(), view: st.switching !== null ? "resume" : "form", pending: null, from: "form", armed: false };
    $("share-input").value = "";
    addSays([]);
    titleShare();
    fill($("share-me-text"), [TEXT.meBefore, myEmail, TEXT.meAfter]);
    renderShare();
    var opened = shareQ.open({
      focus: share.view === "resume" ? "share-restricted" : "share-" + share.choice,
      // Back to the ${n}'s More, as the list shows it by then.
      back: function () { return moreOf[id]; },
      fallback: "h-page",
      onClose: function () {
        share = null;
        $("share-input").value = "";
      },
    });
    if (!opened) share = null;
  }

  // An option chosen (with the mouse, or the arrow keys as a browser moves between them).
  function choose(a) {
    var s = share;
    if (s === null) return;
    if (s.view === "form" && !shareQ.isWorking() && $("share-" + a).checked && (a === "public" || mayRestrict(s.st))) {
      s.choice = a;
      addSays([]);
    }
    renderShare();
  }

  // Add: one or several addresses, separated by commas, spaces, semicolons or line ends;
  // trimmed, lower-cased, without duplicates. Any entry not shaped like an address refuses
  // the whole of it, and so does a list that would grow past the limit. True when nothing
  // was refused (an empty field adds nothing and refuses nothing).
  function addEntries() {
    var s = share;
    if (s === null || shareQ.isWorking() || s.view !== "form" || s.choice !== "people") return false;
    var input = $("share-input");
    var entries = input.value.split(/[\\s,;]+/).filter(function (e) { return e !== ""; });
    var fresh = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i].toLowerCase();
      if (!shaped(e)) {
        addSays([TEXT.quote, cut(entries[i]), TEXT.notEmailAfter]);
        input.focus();
        return false;
      }
      if (s.list.indexOf(e) < 0 && fresh.indexOf(e) < 0) fresh.push(e);
    }
    var limit = s.st.limit;
    if (fresh.length > 0 && s.list.length >= limit) {
      addSays([TEXT.fullBefore + limit + TEXT.fullAfter]);
      input.focus();
      return false;
    }
    if (s.list.length + fresh.length > limit) {
      addSays([TEXT.wouldBefore + (s.list.length + fresh.length) + TEXT.wouldMiddle + limit + TEXT.wouldAfter]);
      input.focus();
      return false;
    }
    s.list = s.list.concat(fresh);
    input.value = "";
    addSays([]);
    renderShare();
    input.focus();
    return true;
  }

  function removeAddress(address) {
    var s = share;
    if (s === null || shareQ.isWorking() || s.view !== "form") return;
    var at = s.list.indexOf(address);
    if (at < 0) return;
    s.list = s.list.slice(0, at).concat(s.list.slice(at + 1));
    addSays([]);
    renderShare();
    if (chipButtons.length > 0) chipButtons[Math.min(at, chipButtons.length - 1)].focus();
    else $("share-input").focus();
  }

  // Save: the chosen setting and the whole list as edited. A change between public and
  // restricted asks first.
  function save() {
    var s = share;
    if (s === null || shareQ.isWorking() || s.view !== "form") return;
    if (s.choice !== "public" && !mayRestrict(s.st)) return;
    // An address typed and not added yet is added first; when it cannot be, nothing is sent.
    if (s.choice === "people" && $("share-input").value.trim() !== "" && !addEntries()) return;
    var body = { access: s.choice, viewers: s.list.slice() };
    if (crosses(s.st.access, body.access)) askFirst(body, "form");
    else sendShare(body, "share-save");
  }

  // The question before a change between public and restricted, in the same box. The focus
  // goes to the button that keeps the ${n} as it is; the one that changes it works only after
  // ARM_MS, so the second click of a double click on Save, which lands where it is, does nothing.
  function askFirst(body, from) {
    var s = share;
    var toPublic = body.access === "public";
    s.view = "ask";
    s.pending = body;
    s.from = from;
    s.armed = false;
    fill($("share-title"), [toPublic ? TEXT.publicBefore : TEXT.restrictBefore, s.title, TEXT.askAfter]);
    $("share-ask-text").textContent = toPublic ? TEXT.publicText : body.access === "me" ? TEXT.restrictMe : TEXT.restrictPeople;
    $("share-ask-warn").hidden = toPublic;
    $("share-keep").textContent = toPublic ? TEXT.keepRestricted : TEXT.keepPublic;
    $("share-go").textContent = toPublic ? TEXT.makePublic : TEXT.restrictTour;
    shareQ.say("");
    renderShare();
    $("share-keep").focus();
    pause(ARM_MS).then(function () {
      if (share !== s || s.view !== "ask" || s.pending !== body) return;
      s.armed = true;
      renderShare();
    });
  }

  // Keep it public / Keep it restricted, Escape and the backdrop while asking: back to where
  // the question came from, with nothing sent and the edits kept.
  function backFromAsk() {
    var s = share;
    if (s === null || s.view !== "ask" || shareQ.isWorking()) return;
    s.view = s.from;
    s.pending = null;
    s.armed = false;
    titleShare();
    renderShare();
    ${M(`$(s.view === "resume" ? "share-restricted" : "share-save").focus();`, `$("share-save").focus();`)}
  }

  function shareBack() {
    if (share === null || share.view !== "ask") return true;
    backFromAsk();
    return false;
  }

  function confirmAsk() {
    var s = share;
    if (s === null || s.view !== "ask" || !s.armed || s.pending === null || shareQ.isWorking()) return;
    sendShare(s.pending, "share-go");
  }

${M(`  // A move that stopped: "Keep it restricted" sends the setting the tour has now (which
  // finishes a move to restricted and cancels a move to public), "Make public" asks first and
  // then sends public (which finishes a move to public). Either with the list as it is.
  function keepRestricted() {
    var s = share;
    // Only a restricted setting is kept: a public one here would be a change, never asked about.
    if (s === null || s.view !== "resume" || shareQ.isWorking() || s.st.access === "public") return;
    sendShare({ access: s.st.access, viewers: s.st.viewers.slice() }, "share-restricted");
  }

  function makePublicAgain() {
    var s = share;
    if (s === null || s.view !== "resume" || shareQ.isWorking() || s.st.switching === null || s.st.switching.target !== "public") return;
    askFirst({ access: "public", viewers: s.st.viewers.slice() }, "resume");
  }

  // The move's progress, from a 202.
  function showMoving(s, d) {
    var total = d !== null && typeof d === "object" && isCount(d.total) ? d.total : 0;
    var done = d !== null && typeof d === "object" && isCount(d.done) ? Math.min(d.done, total) : 0;
    if (s.view !== "moving") {
      s.view = "moving";
      titleShare();
      renderShare();
      $("share-title").focus();
    }
    var bar = $("share-progress");
    bar.max = total > 0 ? total : 1;
    bar.value = total > 0 ? done : 0;
    $("share-moving-text").textContent = TEXT.movingBefore + done + TEXT.of + total + TEXT.movingAfter;
  }

  // Sends the body to the tour whose box is open, again while it answers 202, and decides.
`, `  // Sends the body to the ${n} whose box is open, and decides.
`)}  function sendShare(body, button) {
    var s = share;
    var path = accessPath(s.id);
    var fromResume = s.view === "resume" || (s.view === "ask" && s.from === "resume");
    var rounds = 0;
    var misses = 0;
${M(`    // The last 202's progress, for a loop that stops while the setting cannot be read again.
    var last = null;
`)}    working = true;
${M(`    // Pressed by the person: a stop from leaving the page earlier is over.
    pageLeft = false;
`)}    shareQ.say("");
    shareQ.busy(true, button, TEXT.saving);
    renderShare();
${M(`    // The setting read again first: the server may have finished or cancelled a move, or the
    // tour may have been changed elsewhere, since the box showed it.
`, `    // The setting read again first: the ${n} may have been changed elsewhere since the box showed it.
`)}    readAccess(s.id).then(function (got) {
      if (got.status === 401) { Dash.signedOut(); return; }
      if (share !== s) return;
      if (got.state !== null && sameState(got.state, s.st)) {
        s.st = got.state;
        return next();
      }
      working = false;
      shareQ.busy(false, button);
      if (got.status === 404) return gone(s, "");
      if (got.state === null) {
        renderShare();
        sayParts($("share-message"), [got.status === 0 ? Dash.TEXT.failed : Dash.failure(got.res)]);
        ${M(`$(s.view === "resume" ? "share-restricted" : s.view === "ask" ? "share-keep" : "share-save").focus();`, `$(s.view === "ask" ? "share-keep" : "share-save").focus();`)}
        return;
      }
${M(`      // Changed: nothing is sent, and the box shows the tour as it is now, with the list the
      // site has (another tab may have changed it). Only when that is exactly the setting the
      // person chose (a move to restricted the site finished by itself) is nothing said.
      var fresh = got.state;
      var listChanged = !sameList(fresh.viewers, s.st.viewers);
      if (listChanged) s.list = fresh.viewers.slice();
      var asked = fromResume && fresh.switching === null && fresh.access === body.access && !listChanged;
      if (fromResume && fresh.switching === null && !asked) {
        // What was confirmed is chosen again, for the person to save once more.
        s.choice = body.access;
        s.list = fresh.viewers.slice();
        showState(s, fresh, false, [TEXT.busyAgain]);
        return;
      }
      showState(s, fresh, fromResume && !listChanged, asked ? [] : fresh.switching !== null ? [TEXT.changedMove] : [TEXT.busyAgain]);
`, `      // Changed: nothing is sent, and the box shows the ${n} as it is now, with the list the
      // site has (another tab may have changed it), and the person's choice kept.
      var fresh = got.state;
      if (!sameList(fresh.viewers, s.st.viewers)) s.list = fresh.viewers.slice();
      showState(s, fresh, false, [TEXT.busyAgain]);
`)}    });
    function next() {
      if (share !== s) return;
${M(`      // The page was left (and may come back from the back/forward cache): nothing more is sent by itself.
      if (pageLeft) return finishShare(s, body, button, fromResume, { kind: "stopped", last: last });
`)}      rounds++;
      return Dash.api("PUT", path, body).then(step, function () { return step(null); });
    }
    function step(res) {
      if (res !== null && res.status === 401) { Dash.signedOut(); return; }
      if (share !== s) return;
${M(`      if (res !== null && res.status === 202) {
        misses = 0;
        last = res.data;
        showMoving(s, res.data);
        return rounds < SHARE_ROUNDS ? pause(PAUSE_MS).then(next) : finishShare(s, body, button, fromResume, { kind: "stopped", last: last });
      }
`)}      if (res !== null && res.status === 200) {
        var st = stateOf(res.data);
        // A 200 the page cannot read is decided by reading the setting again.
        return finishShare(s, body, button, fromResume, st !== null ? { kind: "done", state: st } : { kind: "lost", res: res });
      }
      if (res === null || (res.status === 500 && Dash.errorOf(res) === "access_failed")) {
        misses++;
        if (misses < MAX_MISSES && rounds < SHARE_ROUNDS) return pause(MISS_PAUSES_MS[misses - 1]).then(next);
        return finishShare(s, body, button, fromResume, { kind: "lost", res: res });
      }
      return finishShare(s, body, button, fromResume, { kind: "refused", res: res });
    }
  }

  // Whether the setting read now is still what the box shows: the same setting, the same list
  // as the site had when the box read it, the same site mail, and the same move (or none),
  // whatever its progress.
  function sameState(a, b) {
    if (a.access !== b.access || a.canRestrict !== b.canRestrict || (a.switching === null) !== (b.switching === null) || !sameList(a.viewers, b.viewers)) return false;
    return a.switching === null || a.switching.target === b.switching.target;
  }

  // The ${n} is gone: the box closes, and the list read again shows it.
  function gone(s, text) {
    shareQ.close(false);
    return reload().then(function (r) {
      if (r === false) return;
      say(text);
      focusTour(s.id);
    });
  }

  // The box shows the ${n} as \`st\` says it is now: a move that stopped, or the options (with
  // the person's edits kept, unless they came from a stopped move), and the sentence in \`parts\`.
  function showState(s, st, fromResume, parts) {
    s.st = st;
    if (st.switching !== null) s.view = "resume";
    else {
      if (fromResume) {
        s.choice = st.access;
        s.list = st.viewers.slice();
      }
      if (s.choice !== "public" && !mayRestrict(st)) s.choice = st.access;
      s.view = "form";
    }
    s.pending = null;
    s.armed = false;
    titleShare();
    renderShare();
    sayParts($("share-message"), parts);
    ${M(`$(s.view === "resume" ? "share-restricted" : "share-save").focus();`, `$("share-save").focus();`)}
  }

  // The sentence for a change of who can view that did not happen, as parts for sayParts.
  function refusalParts(res, body, fromResume) {
    var code = Dash.errorOf(res);
    var status = res !== null && typeof res === "object" ? res.status : 0;
    if (status === 409) {
      if (code === "cannot_restrict") return [TEXT.cannotRestrict];
${M(`      if (code === "access_switching") return [TEXT.switching];
      if (code === "switch_cancelled") return [TEXT.cancelled];
`, `      if (code === "too_large_to_restrict") return [TEXT.tooLarge];
`)}      if (code === "access_busy") return [TEXT.busyAgain];
${M(`      if (code === "republish_needed") return [TEXT.republish];
`)}    }
    if (status === 400 && code === "bad_viewer") {
      // The server names a position only; the entry is the page's own, from the body it sent.
      var detail = res.data !== null && typeof res.data === "object" && typeof res.data.detail === "string" ? res.data.detail : "";
      var m = /^viewers\\[([0-9]{1,4})\\]/.exec(detail);
      var i = m === null ? -1 : Number(m[1]);
      if (i >= 0 && i < body.viewers.length) return [TEXT.quote, cut(body.viewers[i]), TEXT.badViewerAfter];
    }
    if (status === 400 && code === "too_many_viewers") return [TEXT.tooManyBefore + (share !== null ? share.st.limit : LIMIT) + TEXT.tooManyAfter];
    return [Dash.failure(res)];
  }

  // However a change ends, the list is read again, and so is the setting unless the answer
  // was the final 200: the change is done when the setting now is the one sent, with the list
  // sent${M(" and no move left")}. Otherwise the box stays, says why, and shows the ${n} as it is now.
  function finishShare(s, body, button, fromResume, o) {
    var reread = o.kind === "done" ? Promise.resolve(null) : readAccess(s.id);
    return Promise.all([reload(), reread]).then(function (got) {
      var listed = got[0];
      var fresh = got[1];
      if (listed === false) return;
      if (fresh !== null && fresh.status === 401) { Dash.signedOut(); return; }
      if (share !== s) return;
      working = false;
      shareQ.busy(false, button);
      var now = o.kind === "done" ? o.state : fresh.state;
      var done = o.kind === "done" || (now !== null && now.switching === null && now.access === body.access && sameList(now.viewers, body.viewers));
      if (done) {
        shareQ.close(false);
        say(listed === true ? "" : TEXT.notReloaded);
        focusTour(s.id);
        return;
      }
      if (fresh !== null && fresh.status === 404) {
        // The ${n} is gone: the list read again shows it.
        shareQ.close(false);
        say(o.kind === "refused" && o.res.status === 409 ? refusalParts(o.res, body, fromResume).join("") : "");
        focusTour(s.id);
        return;
      }
${M(`      if (o.kind === "stopped") {
        // Left, or at the request cap: the stopped move alone says what is going on. When the
        // setting could not be read again, the last progress the site gave stands for it.
        var st = now;
        var p = o.last;
        if (st === null && p !== null && typeof p === "object" && isCount(p.done) && isCount(p.total) && (p.target === "public" || p.target === "restricted")) {
          st = { access: s.st.access, viewers: s.st.viewers, limit: s.st.limit, canRestrict: s.st.canRestrict, switching: { done: p.done, total: p.total, target: p.target } };
          if (p.target === "restricted" && st.access === "public") st.access = body.access;
        }
        showState(s, st !== null ? st : s.st, fromResume, []);
        return;
      }
`)}      var parts = o.kind === "refused" ? refusalParts(o.res, body, fromResume) : o.kind === "lost" && o.res !== null ? [Dash.failure(o.res)] : [Dash.TEXT.failed];
      showState(s, now !== null ? now : s.st, fromResume, parts);
    });
  }
`;
}

/** The box's listeners, at the start of the page's startPage. */
export function shareListeners(p: SharePage): string {
  const M = (tours: string, item = "") => (p.moves ? tours : item);
  return `${M(`    // The page's own window: leaving the page stops a change of who can view that is running.
    addEventListener("pagehide", function () { pageLeft = true; });
`)}    $("share-cancel").addEventListener("click", function () { if (share !== null && share.view === "form") shareQ.dismiss(); });
${M(`    $("share-close").addEventListener("click", function () { if (share !== null && share.view === "resume") shareQ.dismiss(); });
`)}    $("share-save").addEventListener("click", save);
    $("share-keep").addEventListener("click", backFromAsk);
    $("share-go").addEventListener("click", confirmAsk);
${M(`    $("share-restricted").addEventListener("click", keepRestricted);
    $("share-make-public").addEventListener("click", makePublicAgain);
`)}    $("share-add").addEventListener("click", function () { addEntries(); });
    // Enter in the field is Add, never Save; a held Enter's repeats do nothing.
    $("share-input").addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      if (ev.repeat === true) return;
      addEntries();
    });
    $("share-input").addEventListener("input", function () { addSays([]); });
    SETTINGS.forEach(function (a) {
      $("share-" + a).addEventListener("change", function () { choose(a); });
    });
`;
}

/** The box's buttons whose held keys press nothing, as items of the page's list of ids. */
export function shareRepeatIds(p: SharePage): string {
  return p.moves ? `"share-cancel", "share-save", "share-keep", "share-go", "share-close", "share-restricted", "share-make-public", "share-add"` : `"share-cancel", "share-save", "share-keep", "share-go", "share-add"`;
}
