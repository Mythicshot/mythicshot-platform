// The documentation page's script: the token box, the page's own address in the examples,
// the copy buttons, the viewer's dark look, and the start of the reference viewer.
//
// The token a visitor pastes is held in the one variable below and nowhere else: it is
// not written to any of the browser's stores, to a cookie, or into the address, and a
// reload forgets it. It is sent only by this page's own check of it and by "Try it", both
// to this site's API, both without cookies (see intercept in rules.ts, which every request
// of the viewer passes).
//
// Every text reaches the page as a text node. Nothing is styled from here but by class
// names and the hidden attribute, so the page's policy needs no inline style for it.
//
// Browser code: bundled by scripts/docs-bundle.ts into src/docs/site-assets.ts, and
// type-checked on its own with the DOM library (tsconfig.docs.json).
import { intercept, looksLikeToken } from "./rules.ts";

/** Where the viewer draws the reference. */
const MOUNT = "#reference";
/** The address the page's examples carry until this script puts the page's own in. */
const PLACEHOLDER_ORIGIN = "https://YOUR-SITE";
/** The class the viewer's stylesheet keys its dark look on. */
const DARK = "dark-mode";

const TEXT = {
  notAToken: "That does not look like a token. A token starts with dp_ and is 43 characters long.",
  checking: "Checking…",
  connected: (workspace: string) => `Connected to ${workspace}. The calls on this page now use this token.`,
  unknown: "The server does not know this token. Check that you pasted all of it.",
  unreachable: "The server could not be reached. Try again.",
  forgotten: "Token forgotten.",
  copy: "Copy",
  copied: "Copied",
  noViewer: "The reference could not be loaded. Reload the page, or read the description as JSON or YAML.",
};

/** The token in use, or "". The only place it is kept. */
let token = "";
/** The running viewer, once started. */
let viewer: ViewerSystem | null = null;

/** Asks the API whose token this is. Never sends a cookie, follows no redirect, leaves nothing in a cache. */
async function whoIs(candidate: string): Promise<{ kind: "ok"; workspace: string } | { kind: "unknown" } | { kind: "unreachable" }> {
  try {
    const res = await fetch("/api/v1/me", { credentials: "omit", headers: { Authorization: `Bearer ${candidate}` }, cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" });
    if (res.status === 401 || res.status === 404) return { kind: "unknown" };
    if (res.status !== 200) return { kind: "unreachable" };
    const body: unknown = await res.json();
    const workspace = typeof body === "object" && body !== null ? (body as { workspace?: unknown }).workspace : undefined;
    return typeof workspace === "string" ? { kind: "ok", workspace } : { kind: "unreachable" };
  } catch {
    return { kind: "unreachable" };
  }
}

/**
 * Takes what the viewer still shows of earlier calls off the page: after "Execute" it
 * shows the request it sent as a command, token included. The viewer's own "Clear" does
 * the same for one request.
 */
function clearCalls(): void {
  try {
    const operations = viewer?.specSelectors?.operations?.();
    if (operations === undefined) return;
    for (const op of operations) {
      viewer?.specActions?.clearResponse?.(op.get("path"), op.get("method"));
      viewer?.specActions?.clearRequest?.(op.get("path"), op.get("method"));
    }
  } catch {
    // The viewer is not what this was written for; a reload clears everything.
  }
}

function tokenBox(): void {
  const box = document.getElementById("token-box");
  const input = document.getElementById("token") as HTMLInputElement | null;
  const use = document.getElementById("use-token") as HTMLButtonElement | null;
  const forget = document.getElementById("forget-token") as HTMLButtonElement | null;
  const status = document.getElementById("token-status");
  if (box === null || input === null || use === null || forget === null || status === null) return;

  const say = (text: string, kind: "" | "ok" | "bad") => {
    status.textContent = text;
    status.className = kind === "" ? "status" : `status ${kind}`;
  };
  /** Counts the attempts, so an answer that arrives after a newer click is dropped. */
  let round = 0;

  const check = async () => {
    const candidate = input.value.trim();
    const mine = ++round;
    // A new attempt replaces the token in use, whatever comes of it.
    token = "";
    forget.hidden = true;
    if (!looksLikeToken(candidate)) {
      say(TEXT.notAToken, "bad");
      return;
    }
    say(TEXT.checking, "");
    const answer = await whoIs(candidate);
    if (mine !== round) return;
    if (answer.kind === "unreachable") {
      say(TEXT.unreachable, "bad");
      return;
    }
    input.value = "";
    if (answer.kind === "unknown") {
      say(TEXT.unknown, "bad");
      return;
    }
    token = candidate;
    forget.hidden = false;
    say(TEXT.connected(answer.workspace), "ok");
  };

  use.addEventListener("click", () => void check());
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void check();
  });
  forget.addEventListener("click", () => {
    round++;
    token = "";
    input.value = "";
    forget.hidden = true;
    clearCalls();
    say(TEXT.forgotten, "");
    input.focus();
  });
  box.hidden = false;
}

/** Puts this site's address into every example, and gives each a copy button where the browser can copy. */
function examples(): void {
  for (const block of Array.from(document.querySelectorAll(".command"))) {
    const code = block.querySelector("code");
    const button = block.querySelector("button");
    if (code === null) continue;
    code.textContent = (code.textContent ?? "").split(PLACEHOLDER_ORIGIN).join(location.origin);
    if (button === null || typeof navigator.clipboard?.writeText !== "function") continue;
    let timer: ReturnType<typeof setTimeout> | undefined;
    button.addEventListener("click", () => {
      navigator.clipboard.writeText(code.textContent ?? "").then(
        () => {
          button.textContent = TEXT.copied;
          clearTimeout(timer);
          timer = setTimeout(() => {
            button.textContent = TEXT.copy;
          }, 2000);
        },
        () => undefined,
      );
    });
    button.hidden = false;
  }
}

/** The viewer's dark look follows the system's, as the rest of the page does through its stylesheet. */
function followColourScheme(): void {
  if (typeof matchMedia !== "function") return;
  const dark = matchMedia("(prefers-color-scheme: dark)");
  const apply = () => document.documentElement.classList.toggle(DARK, dark.matches);
  apply();
  dark.addEventListener("change", apply);
}

/** A link to a guide scrolled before the reference above it was drawn; go there again once it is. */
function backToGuide(): void {
  const id = location.hash.slice(1);
  if (id.startsWith("guide-")) document.getElementById(id)?.scrollIntoView();
}

function startViewer(): void {
  const mount = document.querySelector(MOUNT);
  if (mount === null) return;
  try {
    if (typeof SwaggerUIBundle === "undefined") throw new Error("no viewer");
    viewer = SwaggerUIBundle({
      url: "/api/v1/openapi.json",
      dom_id: MOUNT,
      layout: "BaseLayout",
      presets: [SwaggerUIBundle.presets.apis],
      // The viewer would otherwise load a badge from its maker's validator site.
      validatorUrl: null,
      // Nothing a visitor enters is written to the browser's storage.
      persistAuthorization: false,
      deepLinking: true,
      docExpansion: "list",
      defaultModelsExpandDepth: -1,
      requestSnippetsEnabled: true,
      withCredentials: false,
      requestInterceptor: (req) => intercept(req, location.href, token),
      onComplete: backToGuide,
    });
  } catch {
    const line = document.createElement("p");
    line.className = "status bad";
    line.textContent = TEXT.noViewer;
    mount.replaceChildren(line);
  }
}

followColourScheme();
examples();
tokenBox();
startViewer();
