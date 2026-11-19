// The first admin, and a sign-in link made for a person to open rather than mailed. No
// platform API and no web framework: the server command in src/node/admin.ts is the one
// caller, and no route reaches this file.
//
// A site has no admin until somebody with access to the server says who it is. Until
// then no sign-in link is sent or accepted, so a site that was updated behaves as it did
// before accounts. The claim below is the one place an account becomes an admin.
import { healMemberships, parseEmail } from "./accounts.ts";
import { auditStatement } from "./audit.ts";
import { originOf } from "./hosts.ts";
import { linkOrigin, signInLink } from "./mail.ts";
import { isNotNullViolation, isUniqueViolation, type Deps } from "./ports.ts";
import { createSignInCode } from "./sessions.ts";
import { parseUsername } from "./usernames.ts";

export type ClaimProblem = "has_admin" | "not_set_up" | "bad_email" | "bad_username" | "reserved" | "email_taken" | "username_taken";
export type ClaimResult = { ok: true; userId: string } | { ok: false; problem: ClaimProblem };

/** What a claim needs to know of the site, read in one call. */
type SiteState = { owner_id: string | null; workspace_id: string | null; admins: number; email_owner: string | null; username_owner: string | null };

/**
 * The owner is the account whose own row names the workspace the setup row names. It is
 * not looked for through `membership`: a site that was rolled back to the version before
 * accounts and set up there has an owner without one. A workspace has one account today;
 * should it ever have several, the oldest is its owner.
 */
const OWNER = "SELECT u.id FROM setup s JOIN user u ON u.workspace_id = s.workspace_id WHERE s.id = 1 ORDER BY u.created_at, u.id LIMIT 1";

function readSite(deps: Deps, email: string, username: string): Promise<SiteState | null> {
  return deps.db.first<SiteState>(
    `SELECT (${OWNER}) AS owner_id,
            (SELECT workspace_id FROM setup WHERE id = 1) AS workspace_id,
            (SELECT count(*) FROM user WHERE is_admin = 1) AS admins,
            (SELECT id FROM user WHERE email = ?) AS email_owner,
            (SELECT id FROM user WHERE username = ?) AS username_owner`,
    [email, username],
  );
}

/** Why the site as read refuses the claim, or null when it does not. */
function refusal(site: SiteState | null): ClaimProblem | null {
  if (site === null || site.admins > 0) return site === null ? "not_set_up" : "has_admin";
  if (site.owner_id === null || site.workspace_id === null) return "not_set_up";
  if (site.email_owner !== null && site.email_owner !== site.owner_id) return "email_taken";
  if (site.username_owner !== null && site.username_owner !== site.owner_id) return "username_taken";
  return null;
}

/**
 * Makes the site's owner its admin, with the address and the username given. It takes
 * effect only while the site has no admin, so it works once: a second claim, whatever it
 * asks for, is told `has_admin` and changes nothing. An admin that is disabled still
 * counts.
 *
 * The address goes through `parseEmail` and the name through `parseUsername`; neither
 * reaches the database otherwise. The address replaces the one typed at setup, which was
 * never confirmed and may not even be an address. `email_taken` and `username_taken`
 * mean another account has it.
 *
 * One read, then one batch: every account that lacks its membership or its sign-in
 * method is given them (see `healMemberships`), the owner's row is changed, and the
 * audit row is written. The change to the owner's row fails when the site got an admin
 * since the read, and when the address or the name was taken since, and then nothing of
 * the batch is kept. A refused claim writes nothing at all.
 */
export async function claimFirstAdmin(deps: Deps, input: { email: string; username: string }): Promise<ClaimResult> {
  const email = parseEmail(input?.email);
  if (email === null) return { ok: false, problem: "bad_email" };
  const name = parseUsername(input.username);
  if (!name.ok) return { ok: false, problem: name.problem === "reserved" ? "reserved" : "bad_username" };

  const site = await readSite(deps, email, name.username);
  const problem = refusal(site);
  if (problem !== null) return { ok: false, problem };
  const owner = site!.owner_id!;

  try {
    await deps.db.batch([
      ...healMemberships(deps),
      {
        // With an admin already there, is_admin would become NULL, which the column
        // refuses: the whole batch is then undone. So of two claims that both read a
        // site without an admin, the second to be written fails here.
        sql: "UPDATE user SET email = ?, username = ?, is_admin = CASE WHEN EXISTS (SELECT 1 FROM user WHERE is_admin = 1) THEN NULL ELSE 1 END WHERE id = ?",
        params: [email, name.username, owner],
      },
      auditStatement(deps, { event: "first_admin", userId: owner, workspaceId: site!.workspace_id, subject: owner }),
    ]);
  } catch (err) {
    if (!isNotNullViolation(err) && !isUniqueViolation(err)) throw err;
    // Something changed between the read and the batch. Read again to say what.
    const now = refusal(await readSite(deps, email, name.username));
    if (now === null) throw err;
    return { ok: false, problem: now };
  }
  return { ok: true, userId: owner };
}

/**
 * A link, or without a configured address a path, and the account it signs in.
 * `whole` is false for a path: the person puts the site's address in front of it.
 */
export type PrintedLink = { ok: true; link: string; whole: boolean; userId: string } | { ok: false };

/** Any origin `signInLink` takes: it is cut off again to leave the path. */
const PATH_ONLY = originOf("localhost");

/**
 * A sign-in link for the account with this address, to be shown to the person who asked
 * on the server, never mailed. It is a link like a mailed one: it works once and for 15
 * minutes, only its digest is stored, and opening it signs in through the same request
 * as any other link.
 *
 * There is one refusal, `{ ok: false }`, whatever the reason: the text is not an
 * address, nobody has it, the account is disabled, has no membership or may not sign in
 * by link, or the site has no admin yet. Nothing is written then.
 *
 * The address the link starts with comes from the configuration only (`linkOrigin`).
 * Without one the result is the path alone, `/signin/link#c=<code>`.
 *
 * One read, then the code, then the audit row `signin_link_printed`, which holds ids
 * only. The row is written after the code and before the link is returned: a link that
 * was shown is always on record, and a code whose record could not be written is never
 * shown and ends by itself.
 */
export async function signInLinkFor(deps: Deps, emailInput: string): Promise<PrintedLink> {
  const email = parseEmail(emailInput);
  if (email === null) return { ok: false };
  const account = await deps.db.first<{ id: string; workspace_id: string }>(
    `SELECT u.id, m.workspace_id
       FROM user u
       JOIN membership m ON m.user_id = u.id
      WHERE u.email = ? AND u.status = 'active'
        AND EXISTS (SELECT 1 FROM signin_method s WHERE s.user_id = u.id AND s.kind = 'email_link')
        AND EXISTS (SELECT 1 FROM user WHERE is_admin = 1)`,
    [email],
  );
  if (account === null) return { ok: false };

  const code = await createSignInCode(deps, account.id);
  const record = auditStatement(deps, { event: "signin_link_printed", userId: account.id, workspaceId: account.workspace_id, subject: account.id });
  await deps.db.run(record.sql, record.params);

  const origin = linkOrigin(deps.config);
  if (origin === null) return { ok: true, link: signInLink(PATH_ONLY, code).slice(PATH_ONLY.length), whole: false, userId: account.id };
  return { ok: true, link: signInLink(origin, code), whole: true, userId: account.id };
}
