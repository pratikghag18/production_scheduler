/**
 * editRights.ts — "may this reader CHANGE this row?", mirrored from the server
 * so a screen stops offering controls the database will refuse.
 *
 * ---------------------------------------------------------------------------
 * ⭐⭐ WHY IT EXISTS, AND IT IS ONE SENTENCE: READING AND WRITING ARE SCOPED IN
 * OPPOSITE DIRECTIONS.
 *
 *   READ   `app_can_read_owned(site_node_id)`  (0026) — you see rows owned at
 *          or **above** your grant.
 *   WRITE  `app_can_edit_node(site_node_id)`   (0032) — you may change rows
 *          owned at your grant and **below**.
 *
 * Migration 0032 let a line supervisor keep the training record and D114 let
 * them through the admin door — so the Trainings tab now correctly lists the
 * PLANT's trainings to somebody whose grant is one LINE, and every Rename and
 * Retire on those rows is a button the server refuses.
 * `supabase/tests/59_training_record_test.sql` case V14 pins that, in its own
 * words, as *"the exact shape 19.77 is about, arriving from the other
 * direction"* — a known debt with a case behind it. This module is the payment.
 *
 * ---------------------------------------------------------------------------
 * ⚠️⚠️ THIS IS A PREVIEW, NOT A PERMISSION. THE SERVER IS THE AUTHORITY. ⚠️⚠️
 *
 * Nothing here authorises anything. The RLS policies in 0032 decide, on every
 * write, and if this module and the database ever disagree **the database is
 * right and this is the bug** — the same standing rule `adminSectionsFor`
 * carries.
 *
 * ⭐⭐ AND SO IT FAILS **OPEN**: when the grant read has not landed, failed, or
 * the row's owning node cannot be resolved to a path, `canEditNode` answers
 * TRUE and the controls stay on screen. `scope.ts`'s header is the standing
 * argument and it applies verbatim: *hiding is invisible and permanent*, and a
 * Rename that silently stopped existing looks exactly like a screen that was
 * always like that. Offering something the server then refuses is loud and
 * recoverable, and lands on §19.63's write-error contract, which was built for
 * exactly this.
 *
 * ⚠️ NOTE THE DIRECTION THIS RUNS. `operators.ts` mirrors `check_eligibility`
 * and must never show a tick the server would refuse — a false PROMISE. This
 * mirrors a permission, where the dangerous direction is the other one: a
 * client that hides a control the server would have allowed stops somebody
 * doing their job, quietly, with nothing on screen to argue with. So every
 * unresolvable case here resolves to "offer it", never to "hide it".
 *
 * ---------------------------------------------------------------------------
 * ⭐⭐ THE RULE, CLAUSE BY CLAUSE. `app_can_edit_node(p_node uuid)` —
 * `supabase/migrations/20260826000019_scoped_roles.sql:273-287`, quoted rather
 * than paraphrased so the two can be read side by side:
 *
 *     SELECT EXISTS (
 *       SELECT 1
 *       FROM nodes n
 *       WHERE n.id = p_node
 *         AND n.org_id = app_current_org()                     -- (0)
 *         AND (
 *           app_is_admin()                                     -- (1)
 *           OR app_is_admin_on_path(n.path)                    -- (2)
 *           OR (app_can_write()                                -- (3a)
 *               AND EXISTS (SELECT 1 FROM app_grant_paths(true) gp
 *                            WHERE n.path <@ gp))              -- (3b)
 *         )
 *     );
 *
 * (0) NOT MIRRORED, DELIBERATELY. Every row this client holds arrived through
 *     an RLS-filtered read of one org, so a cross-tenant path cannot be in
 *     hand to ask about. Re-testing it here would be a second tenant check
 *     that can only ever disagree with the first.
 *
 * (1) `app_is_admin()` — `user_profiles.role = 'admin'`, the ORG-WIDE role
 *     (0018 §85-91). `isCompanyAdmin` below.
 *
 * (2) `app_is_admin_on_path(n.path)` — `EXISTS (SELECT 1 FROM
 *     app_grant_paths_for(ARRAY['admin']) gp WHERE p_path <@ gp)`. Reached
 *     here as `adminPaths`.
 *
 * (3a) `app_can_write()` — `user_profiles.role IN ('admin','supervisor')`,
 *      again the ORG-WIDE role (0018 §97-103). `canWriteOrgWide` below.
 * (3b) `app_grant_paths(true)` — the caller's grants whose role is `'admin'`
 *      or `'supervisor'` (0019 §166-175). Reached here as `writablePaths`.
 *
 * ---------------------------------------------------------------------------
 * ⚠️⚠️ ARM (2) HAS NO ORG-ROLE TEST, AND THAT IS THE TRAP IN THIS FILE.
 *
 * It reads like an oversight in the SQL and it is not. The demo's three site
 * admins — `dana`, `quinn`, `rosa` — carry the org-wide role **'viewer'** and
 * hold **admin GRANTS** on their sites; `session.ts` records the same fact
 * about why `adminAccess` had to be widened. A mirror that ANDed
 * `canWriteOrgWide` into every arm would agree with the server about
 * everybody except those three, and would lock all three out of the section
 * they run. Arm (2) stands alone on purpose.
 *
 * ⚠️ "COVERING" IS `path <@ grantPath`, WHICH IS DOWNWARD ONLY. A grant reaches
 * its node and everything BELOW it, never above — which is the whole reason the
 * plant supervisor's rows are read-only to a line supervisor. It is the same
 * containment `scope.ts` asks for offering, so it is the same function:
 * `isAtOrBelow`, imported rather than re-implemented. ⚠️ A second prefix test
 * would be a second chance to write `startsWith`, and `plant1.line1` is a
 * string prefix of `plant1.line10` without being its ancestor.
 *
 * ---------------------------------------------------------------------------
 * DEPENDENCY-FREE at runtime apart from `./scope`, which is itself dependency-
 * free: no React, no CSS, no `supabase`. Runs under
 * `node --experimental-strip-types`, which is what lets
 * `src/test/editRights.test.ts` cover it without a network.
 * `useEditRights.ts` fetches; this decides.
 */
import { isAtOrBelow } from "./scope";

/* ===========================================================================
 * §1. What the answer is computed from.
 * ======================================================================== */

/**
 * Everything the three arms need, as one value.
 *
 * ⚠️ `known` IS NOT A CONVENIENCE. It is the difference between "your grants
 * do not reach this" and "we have not been told what your grants are", and
 * those two must never collapse into one `false`. The second is the fail-open
 * case — see the header — and there is no way to spot it from the path arrays
 * alone, because "no grants at all" is a legitimate, fully-loaded answer for a
 * company admin (arm (1) carries them) and the arrays are empty either way.
 */
export interface EditRights {
  /** `user_profiles.role` — the ORG-WIDE role. Arms (1) and (3a). */
  role: string | null;
  /** `app_grant_paths_for(['admin'])`. Arm (2). */
  adminPaths: readonly string[];
  /** `app_grant_paths(true)`. Arm (3b). */
  writablePaths: readonly string[];
  /** Has the grant read landed? `false` -> every answer below is TRUE. */
  known: boolean;
}

/** The value to hold before the read lands, or after it fails. Fails open. */
export const UNKNOWN_EDIT_RIGHTS: EditRights = {
  role: null,
  adminPaths: [],
  writablePaths: [],
  known: false,
};

/* ===========================================================================
 * §2. The three arms, one function each.
 *
 * Split rather than inlined so each one can be named in a failing test, and so
 * the file reads in the same order as the SQL it quotes.
 * ======================================================================== */

/** Arm (1) — `app_is_admin()`. The org-wide role, and nothing else. */
export function isCompanyAdmin(role: string | null): boolean {
  return role === "admin";
}

/**
 * Arm (3a) — `app_can_write()`. `role IN ('admin','supervisor')`.
 *
 * ⚠️ ON ITS OWN THIS AUTHORISES NOTHING, and reading it as though it did is
 * the mistake this split exists to prevent: an org-wide supervisor with no
 * grants anywhere may edit nothing at all, because (3b) has nothing to match.
 * `session.ts` records that such a person can reach this screen deliberately,
 * and will find two empty lists.
 */
export function canWriteOrgWide(role: string | null): boolean {
  return role === "admin" || role === "supervisor";
}

/**
 * Arms (2) and (3b) — `EXISTS (... WHERE p_path <@ gp)`.
 *
 * ⚠️ `isAtOrBelow(path, grant)`, NOT the other way round. The grant is the
 * ancestor; the row's owner is the descendant. Swapping the arguments gives a
 * plant admin no rights over the plant's own lines and gives a line supervisor
 * rights over the whole plant, and BOTH directions still pass a test that only
 * ever asks about a grant sitting exactly on the node.
 */
export function coveredByAnyGrant(path: string, grantPaths: readonly string[]): boolean {
  return grantPaths.some((grant) => isAtOrBelow(path, grant));
}

/* ===========================================================================
 * §3. The predicate.
 * ======================================================================== */

/**
 * May this reader change a row owned by the node at `path`?
 *
 * @param path  the OWNING node's ltree path — the same value the server
 *              compares. `null` means the client cannot resolve the owner
 *              (outside its readable set, or dropped by a truncated response),
 *              and the honest answer is then "I cannot tell" -> TRUE.
 *
 * ⭐ THE TWO FAIL-OPEN BRANCHES COME FIRST AND THEY ARE THE POINT OF THE
 * FUNCTION. Everything after them is the mirror; those two are the promise
 * that a mirror which cannot see is not allowed to say no.
 */
export function canEditNode(path: string | null, rights: EditRights): boolean {
  if (!rights.known) return true; // not asked, or the ask failed -> let the server answer
  if (path === null) return true; // owner unreadable -> cannot tell -> offer it
  if (isCompanyAdmin(rights.role)) return true; // (1)
  if (coveredByAnyGrant(path, rights.adminPaths)) return true; // (2)
  // (3) — and it is ONE arm with two halves, never two independent tests.
  return canWriteOrgWide(rights.role) && coveredByAnyGrant(path, rights.writablePaths);
}

/* ===========================================================================
 * §4. Reading the wire.
 * ======================================================================== */

/* ⚠⚠ `readGrantPaths` LIVED HERE AND WAS DELETED THE SAME DAY IT WAS WRITTEN.
 *
 * It narrowed the RPC's `unknown[]` to strings. When `fetchGrantPaths` moved to
 * `@/lib/api/access.ts` — where reads belong, and where a second caller needed
 * it — the narrowing went with it as `parseGrantPaths`, because parsing belongs
 * at the boundary that does the reading.
 *
 * ⭐ It is DELETED rather than left exported-but-unused, and that is the point.
 * Twice today a column list existed in two places, drifted, and emptied a screen
 * in silence. A three-line helper with two homes is the same defect waiting for
 * its turn — and the dead one is always the one somebody edits.
 */

/* ===========================================================================
 * §5. What the row says instead.
 * ======================================================================== */

/**
 * The one line a read-only row carries in place of its controls.
 *
 * ⭐⭐ IT NAMES THE PLACE, WHICH IS THE WHOLE INFORMATION. "You can't edit
 * this" invites a support ticket; *"Plant 1 isn't a place you manage"* tells a
 * line supervisor exactly why the plant's trainings look different from their
 * own line's, and it is the same column already on screen beside it.
 *
 * ⚠️ D106 IS WHY THIS EXISTS AT ALL RATHER THAN A DISABLED BUTTON. A disabled
 * "Rename" is a control named after something it does not do; the honest move
 * is not to offer it and to say why. A `title` on a greyed button would also be
 * unreachable by keyboard and unannounced.
 *
 * ⚠️ THE OWNER LABEL IS PASSED IN, NEVER RESOLVED HERE — `scope.ts`'s
 * `scopeLabel` stays the one place a node id becomes a name, exactly as
 * `trainingHandle` requires of its caller. It is the LEAF name, matching the
 * "Belongs to" column the reader is looking at.
 */
export function notManagedNote(ownerLabel: string): string {
  return `${ownerLabel} isn’t a place you manage — you can see this, but not change it.`;
}
