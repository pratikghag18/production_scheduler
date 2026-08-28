/**
 * Pure "who can get in" logic — the client half of migration 0021 (§19.51).
 *
 * Dependency-free: no runtime import of any kind, no React, no CSS, no
 * `supabase`, no snake_case leaking out. Runs under
 * `node --experimental-strip-types` with nothing to resolve.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AUTHORITATIVE. The DATABASE is, for every rule in this file.
 * `site_people`, `set_site_member` and `remove_site_member` decide who may be
 * seen, added, re-roled and removed; `48_site_membership_test.sql` is where
 * those rules are proved. This module computes PREVIEWS — which rows to show,
 * which roles to offer, whether to grey out Remove and what to say instead —
 * so the screen stops offering things the server will refuse.
 *
 * The invariant is one-way and it is the same one `shapePicker.ts` states:
 * **anything the client hides, the server must also refuse; never the
 * converse.** Getting the direction wrong in the other direction is not a
 * safety bug but it is a real one — hiding something the server permits is a
 * feature nobody can reach, and it looks exactly like a broken screen. Both
 * halves are pinned below.
 *
 * ---------------------------------------------------------------------------
 * ⚠️ THIS FILE OWNS THE SHAPE GUARD, WHICH IS A DEVIATION FROM
 * `src/lib/api/hierarchy.ts`'s `parseXResult` IDIOM, AND IT IS DELIBERATE.
 * Those parsers guard a SINGLE row whose absence is genuinely an error, so
 * throwing `shapeMismatch` is the right answer. `site_people` returns a LIST
 * that a screen renders: one malformed entry must not blank the panel, and
 * the guard has to be unit-testable without a network. So `buildAccessRows`
 * takes `unknown`, **never throws**, skips what it cannot read, and reports
 * how many it skipped. `fetchSitePeople` in `src/lib/api/access.ts` does the
 * RPC and the error mapping and nothing else.
 *
 * ---------------------------------------------------------------------------
 * WHITESPACE PARITY, SETTLED — do not re-derive it. The search box trims with
 * plain `.trim()`, matching `app_trim_ws`'s code-point-exact reimplementation
 * of `String.prototype.trim()` (migration 0011). No character class, no `\s`
 * regex; both have been tried in this project and both were wrong.
 */

/** The three roles `profile_grants.role` admits (migration 0019). */
export type GrantRole = "admin" | "supervisor" | "viewer";

export const GRANT_ROLES: readonly GrantRole[] = ["admin", "supervisor", "viewer"];

export interface AccessGrant {
  nodeId: string;
  nodeName: string;
  role: GrantRole;
}

/**
 * One person, as the screen needs them.
 *
 * `directRole` is the grant sitting on THE NODE THIS SCREEN IS ABOUT, and it
 * is the only one this screen can edit — `set_site_member` and
 * `remove_site_member` both take `p_node_id` and touch exactly that row.
 * `inheritedGrants` are the ones further down the subtree: they are why
 * somebody can already get in, they are shown, and they are NOT editable from
 * here. Collapsing the two into one "role" field is the most likely bug in
 * this module, and case A5 is what catches it — the person who holds a grant
 * on this node AND one below it. A3 and A4 are both green against a collapse.
 */
export interface AccessRow {
  profileId: string;
  /** `null` when the account has no address on file; never invented. */
  email: string | null;
  companyAdmin: boolean;
  directRole: GrantRole | null;
  inheritedGrants: readonly AccessGrant[];
  /** Can this person reach this place at all, by any route? */
  hasAccess: boolean;
  /** Is this the person looking at the screen? */
  isSelf: boolean;
}

export interface AccessView {
  nodeId: string | null;
  nodeName: string | null;
  rows: readonly AccessRow[];
  /**
   * How many entries the payload carried that could not be read. Reported
   * rather than swallowed: a silently shortened list is indistinguishable
   * from a company with fewer people in it.
   */
  skipped: number;
}

const EMPTY_VIEW: AccessView = { nodeId: null, nodeName: null, rows: [], skipped: 0 };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asRole(v: unknown): GrantRole | null {
  return v === "admin" || v === "supervisor" || v === "viewer" ? v : null;
}

/**
 * ⭐ AN UNKNOWN ROLE IS DROPPED, NOT COERCED. If a future migration adds a
 * fourth role, a grant carrying it must not silently render as `viewer` — the
 * screen would then offer to "change" a role it is misreporting. Dropping the
 * grant makes the person show as having no access here, which is wrong in the
 * safe direction and visible.
 */
function parseGrant(v: unknown): AccessGrant | null {
  if (!isRecord(v)) return null;
  const nodeId = asString(v.nodeId);
  const nodeName = asString(v.nodeName);
  const role = asRole(v.role);
  if (nodeId === null || nodeName === null || role === null) return null;
  return { nodeId, nodeName, role };
}

/**
 * Turn `site_people`'s payload into rows. NEVER THROWS, for any input.
 *
 * `viewerProfileId` may be `null` (the session has not resolved), in which
 * case no row is `isSelf` — and every self-rule below therefore stays OFF.
 * That is the right default: the self-rules only ever REMOVE options, so an
 * unresolved session offers the full set and the server refuses the one case
 * that matters. Case A9.
 */
export function buildAccessRows(payload: unknown, viewerProfileId: string | null): AccessView {
  if (!isRecord(payload)) return EMPTY_VIEW;
  const nodeId = asString(payload.nodeId);
  const nodeName = asString(payload.nodeName);
  const people = payload.people;
  if (!Array.isArray(people)) {
    return { nodeId, nodeName, rows: [], skipped: 0 };
  }

  const rows: AccessRow[] = [];
  let skipped = 0;
  for (const entry of people) {
    if (!isRecord(entry)) {
      skipped += 1;
      continue;
    }
    const profileId = asString(entry.profileId);
    if (profileId === null) {
      skipped += 1;
      continue;
    }
    const rawGrants = Array.isArray(entry.grants) ? entry.grants : [];
    const grants: AccessGrant[] = [];
    for (const g of rawGrants) {
      const parsed = parseGrant(g);
      if (parsed !== null) grants.push(parsed);
    }
    // ⛔ THERE WAS A `nodeId === null ? undefined : …` GUARD HERE AND THE
    // MUTATION RUN DELETED IT (B9, NOT CAUGHT). The behaviour it was written
    // to protect is real and case A16 still pins it — when the payload never
    // said which place this is about, nothing is a direct grant, every grant
    // reports as inherited, and the screen offers no edits. But the guard was
    // not what produced it: `parseGrant` only admits a grant whose `nodeId` is
    // a string, so `find` against `null` can never match, guard or no guard.
    // A second copy of a check that always holds cannot be mutation-tested
    // (gotcha 17), so it is gone rather than kept with an unfalsifiable
    // justification.
    const direct = grants.find((g) => g.nodeId === nodeId);
    const companyAdmin = entry.companyAdmin === true;

    rows.push({
      profileId,
      email: asString(entry.email),
      companyAdmin,
      directRole: direct ? direct.role : null,
      inheritedGrants: grants.filter((g) => g !== direct),
      hasAccess: companyAdmin || grants.length > 0,
      isSelf: viewerProfileId !== null && profileId === viewerProfileId,
    });
  }
  return { nodeId, nodeName, rows, skipped };
}

/**
 * ⭐ THE SELF-RULE, MIRRORED FROM MIGRATION 0021 §4/§5, AND NARROW FOR THE
 * REASON THE MIGRATION GIVES.
 *
 * Only the grant that currently makes you an `admin` OF THIS EXACT NODE is
 * protected. Adding yourself as a viewer on a node you do not already
 * administer directly takes nothing away, because the stronger covering grant
 * above still decides (0019), and refusing it would refuse a harmless thing
 * with a frightening message.
 *
 * A company admin is exempt: they can always reach the row again.
 */
function selfLocked(row: AccessRow, viewerIsCompanyAdmin: boolean): boolean {
  return row.isSelf && !viewerIsCompanyAdmin && row.directRole === "admin";
}

/**
 * ⭐ A COMPANY ADMIN'S ROW IS NOT A SITE ADMIN'S TO EDIT (migration 0022).
 *
 * Found on the running screen: signed in as a site admin, the company admin's
 * row offered a role control and a Remove button, and **the server allowed
 * both.** Measured, it was not an escalation and took nothing away — a company
 * admin's authority is `user_profiles.role`, which a site admin cannot write
 * — but it is a role inversion, and a button that appears to remove somebody's
 * access and removes nothing.
 *
 * ⚠️ THE SERVER WAS FIXED FIRST, AND THAT ORDER IS THE POINT. Hiding a
 * permitted action would have broken this file's own invariant — anything the
 * client hides, the server must also refuse. 0022 refuses it; this mirrors it.
 * `49_company_admin_rows_test.sql` X41/X42 are the server-side twins of the
 * two cases below.
 *
 * Two company admins are peers, so the viewer's own flag is half the test.
 */
function protectedRow(row: AccessRow, viewerIsCompanyAdmin: boolean): boolean {
  return row.companyAdmin && !viewerIsCompanyAdmin;
}

/**
 * May this screen offer a role control for this person at all?
 *
 * Distinct from `allowedRoles`, which narrows WHICH roles: this answers
 * whether the control belongs on the row. A control that offers exactly one
 * option and writes nothing is worse than no control — it looks live.
 */
export function canSetRole(row: AccessRow, viewerIsCompanyAdmin: boolean): boolean {
  return !protectedRow(row, viewerIsCompanyAdmin);
}

/**
 * Which roles this screen may offer for this person, in `GRANT_ROLES` order.
 *
 * `['admin']` alone when the self-rule is locked — NOT an empty list. An empty
 * list would leave the control with nothing selected while the person is, in
 * fact, an admin here; the honest rendering is a control showing `admin` with
 * no other option.
 */
export function allowedRoles(row: AccessRow, viewerIsCompanyAdmin: boolean): readonly GrantRole[] {
  return selfLocked(row, viewerIsCompanyAdmin) ? (["admin"] as const) : GRANT_ROLES;
}

/**
 * `remove_site_member` refuses three things and this mirrors two of them: no
 * grant on this exact node to remove, and your own admin access.
 *
 * The third — "you do not administer this place" — is NOT mirrored here, on
 * purpose. This screen only ever opens for a place the viewer administers
 * (the panel is scoped by `editable_shape_ids`), so a client copy of that
 * check could never be false and would be untestable (gotcha 17). If the
 * panel ever opens for a place the viewer does not administer, the whole
 * `site_people` call fails first with `not_permitted`, which is a screen-level
 * error and not a row-level one.
 */
export function canRemoveAccess(row: AccessRow, viewerIsCompanyAdmin: boolean): boolean {
  if (row.directRole === null) return false;
  if (protectedRow(row, viewerIsCompanyAdmin)) return false;
  return !selfLocked(row, viewerIsCompanyAdmin);
}

/**
 * The one-line explanation under a person's address. Pure, and here rather
 * than in the component for D90's reason: a sentence a screen shows is a
 * behaviour, and a behaviour a test cannot reach is a behaviour nobody checks.
 *
 * Ordering matters and is the assertion of A20–A24: the MOST powerful route
 * in wins, because that is the one that decides what the person can actually
 * do. A company admin who also holds a grant here is described as a company
 * admin, because removing the grant would change nothing.
 */
export function describeAccess(row: AccessRow, nodeName: string | null): string {
  const place = nodeName ?? "this place";
  if (row.companyAdmin) {
    // ⭐ A COMPANY ADMIN CAN ALSO HOLD A GRANT HERE, AND THE ROW HAS TO SAY
    // SO. Found by the maintainer on the real screen: the seeded company admin holds
    // an admin grant on Plant 1 as well as the org-wide flag, so the row read
    // "Company admin — reaches every plant" beside a role control that was
    // editing something else entirely. Set that control to `viewer` and the
    // sentence would not change — because it would still be true — and the
    // change would look like it had done nothing. Case A50.
    return row.directRole === null
      ? "Company admin — reaches every plant"
      : `Company admin — and ${roleWord(row.directRole).toLowerCase()} of ${place}`;
  }
  if (row.directRole === "admin") return `Admin of ${place}`;
  if (row.directRole === "supervisor") return `Supervisor on ${place}`;
  if (row.directRole === "viewer") return `Can view ${place}`;
  if (row.inheritedGrants.length === 1) {
    const g = row.inheritedGrants[0];
    return `${roleWord(g.role)} on ${g.nodeName}`;
  }
  if (row.inheritedGrants.length > 1) {
    return `Access to ${row.inheritedGrants.length} places inside ${place}`;
  }
  return "No access";
}

function roleWord(role: GrantRole): string {
  if (role === "admin") return "Admin";
  if (role === "supervisor") return "Supervisor";
  return "Viewer";
}

/**
 * Why a row offers no Remove button — as a REASON rather than a sentence.
 *
 * ⭐ THIS EXISTS BECAUSE ONE OF THOSE REASONS NEEDS A BUTTON, NOT PROSE.
 * "Their access sits further down the tree — open that place to change it"
 * was the first version, and the maintainer hit it on the real screen within minutes:
 * **there was no way to open that place.** The panel was pinned to the site
 * root, so the sentence instructed the user to do something the app could not
 * do. Correct in the model, useless on the screen — the D99 family.
 *
 * The component switches on this and renders a way IN for `"inherited"`,
 * using `row.inheritedGrants` for the places. `removalNote` below is the prose
 * for the other reasons and is DERIVED from this one, so the branch order
 * lives in exactly one place and the two cannot drift.
 */
export type RemovalReason = "removable" | "self" | "company-admin" | "inherited" | "none";

export function removalReason(row: AccessRow, viewerIsCompanyAdmin: boolean): RemovalReason {
  if (canRemoveAccess(row, viewerIsCompanyAdmin)) return "removable";
  if (selfLocked(row, viewerIsCompanyAdmin)) return "self";
  // Before `inherited`, and D7 is the case: a company admin who also holds a
  // grant below still reads as a company admin, because that is the route that
  // decides what they reach.
  if (row.companyAdmin) return "company-admin";
  if (row.inheritedGrants.length > 0) return "inherited";
  return "none";
}

/**
 * Why a row offers no Remove button. `null` when it does offer one — a caller
 * that renders this unconditionally would print an explanation next to a live
 * button, so the null is the signal and not an oversight.
 */
export function removalNote(row: AccessRow, viewerIsCompanyAdmin: boolean): string | null {
  const reason = removalReason(row, viewerIsCompanyAdmin);
  if (reason === "removable") return null;
  if (reason === "self") {
    return "You can't take away your own admin access here.";
  }
  if (reason === "company-admin") {
    // ⭐ SHORT, AND THE RENDER IS WHY. The first version read "Company admins
    // reach every plant; there's no access here to take away." — which is
    // word-for-word what `describeAccess` already says two columns to the
    // left, so the row printed the same sentence twice. A green suite cannot
    // see that; a screenshot can (rule 2c). This note's only job is to explain
    // the ABSENCE of the button, and the reason is already on the row.
    // ⚠️ TWO ROWS REACH THIS AND THEY ARE NOT THE SAME SENTENCE. A company
    // admin with no grant here genuinely has nothing to take away. One who
    // ALSO holds a grant has something — the viewer is simply not the person
    // who may touch it (0022). Saying "nothing" to the second would be the
    // same lie the button used to tell.
    return row.directRole === null
      ? "Nothing to take away here."
      : "Company admins aren't managed from a site.";
  }
  if (reason === "inherited") {
    // The component turns each place in `row.inheritedGrants` into a way in,
    // so this sentence is now FOLLOWABLE rather than an instruction with no
    // handle. Short for that reason — the places are buttons, not prose.
    return "Their access sits further down the tree:";
  }
  return "No access here to take away.";
}

/**
 * Search. Matches the address only, because the address is the only thing
 * this system knows about a person (migration 0021's header says why).
 *
 * Case-insensitive and substring, not prefix: an admin looking for somebody
 * types the part they remember. An empty or whitespace-only query matches
 * EVERYTHING — a search box that has been cleared must not hide the list.
 *
 * ⚠️ A row with no address matches ONLY the empty query. It cannot be typed
 * for, and dropping it from every non-empty search is better than having it
 * appear under arbitrary text.
 */
export function matchesQuery(row: AccessRow, query: string): boolean {
  const q = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (q === "") return true;
  if (row.email === null) return false;
  return row.email.toLowerCase().includes(q);
}

/**
 * The screen's two lists, in one pass and in the order the server sent —
 * which is `email COLLATE "C"`, ascending, and asserted server-side by 48's
 * X34. **This function must not re-sort.** Two sorts of the same list by
 * different rules is how the picker and the member list end up disagreeing
 * about where somebody is, and the server's order is already deterministic
 * and collation-independent.
 *
 * ⭐ CANDIDATES ARE RETURNED ONLY FOR A NON-BLANK QUERY, AND THAT IS THE
 * SHAPE OF THE SCREEN, NOT AN OPTIMISATION.
 *
 * The first version listed everybody in the company permanently, underneath
 * the people who actually have access. The maintainer, on the running screen:
 * *"Shouldn't Quinn not be visible here at all since he's not assigned to
 * Plant 1? Why show people if they're not assigned to a plant?"*
 *
 * He is right, and the reason is not length. A standing list of everyone,
 * sitting under the member list, ASSERTS A RELATIONSHIP THAT DOES NOT EXIST —
 * it reads as "these people are somehow associated with this plant" when the
 * only thing true of them is that they work at the company. The member list
 * is the screen; adding somebody is an ACTION, and an action's subject
 * appears when you go looking for it.
 *
 * It also retires the unbounded-list limit 0021 §3 recorded: a company of ten
 * thousand no longer renders ten thousand rows, because nothing renders until
 * a query narrows it. The server still returns everyone — the honest place to
 * bound that is `site_people` with a documented limit, not a client that
 * quietly drops people.
 *
 * ⚠️ MEMBERS ARE STILL FILTERED BY THE QUERY, AND STILL LISTED WHEN IT IS
 * BLANK. The two lists answer different questions: "who can get in here" is
 * the default view, "who could I add" is a search.
 */
export function partitionAccess(
  rows: readonly AccessRow[],
  query: string,
): { members: AccessRow[]; candidates: AccessRow[] } {
  const searching = typeof query === "string" && query.trim() !== "";
  const members: AccessRow[] = [];
  const candidates: AccessRow[] = [];
  for (const row of rows) {
    if (!matchesQuery(row, query)) continue;
    if (row.hasAccess) members.push(row);
    else if (searching) candidates.push(row);
  }
  return { members, candidates };
}

/**
 * What the panel should be showing, as one value.
 *
 * ⭐ THIS EXISTS BECAUSE THE PANEL NEEDS TWO READS AND THE SECOND DEPENDS ON
 * THE FIRST. `site_people` takes a node id, and the node id comes from the
 * structure the admin has selected — which arrives with the hierarchy read. So
 * unlike §19.47's admin gate, the two windows genuinely cannot be folded into
 * one `Promise.all`; what can be folded is the ANSWER, and this is it.
 *
 * ⚠️ D91 IS THE WHOLE REASON FOR THE ORDER OF THESE BRANCHES. React Query v5
 * reports `isPending` with `fetchStatus: "idle"` for a disabled query, so
 * `isLoading` is **FALSE** while there is no node to ask about — a caller
 * passing `peopleLoading` straight through would fall to `"ready"` and render
 * an empty people list as though the company had nobody in it. `"no-place"` is
 * checked BEFORE `peopleLoading` for exactly that reason, and case C4 is what
 * pins it.
 *
 * `"no-place"` is not an error. It is the honest state for a mid-tree admin:
 * a structure is owned by a ROOT (migration 0020 §1), so somebody who
 * administers a department administers no structure, `editable_shape_ids`
 * returns `[]` for them, and there is no site for this panel to be about.
 * That limitation is named in 0021 §7 and it needs a sentence on screen, not
 * a spinner that never resolves.
 */
export type AccessPanelState = "pending" | "no-place" | "error" | "ready";

export function accessPanelState(
  treeLoading: boolean,
  siteNodeId: string | null,
  peopleLoading: boolean,
  peopleError: boolean,
): AccessPanelState {
  if (treeLoading) return "pending";
  if (siteNodeId === null) return "no-place";
  if (peopleError) return "error";
  if (peopleLoading) return "pending";
  return "ready";
}

/** One place this panel can be about: a site the viewer administers. */
export interface AccessPlace {
  nodeId: string;
  name: string;
}

/**
 * Which place the panel is showing. Falls back, never sticks.
 *
 * ⭐ THIS EXISTS BECAUSE THE PANEL HAD NO CONTROL OF ITS OWN. It was scoped by
 * the structure picker — which lives on the Hierarchy tab — so a company admin
 * standing on the Access tab was shown whichever plant that other tab happened
 * to have selected, with no way to change it and nothing on screen explaining
 * why. The maintainer's words: "Where is Plant 1?" The panel now owns its selection.
 *
 * Same shape and the same reason as `resolveSelectedShape`: the case that
 * matters is the selection pointing at something that is no longer in the
 * list — after switching companies, or after losing a grant — where the honest
 * answer is the first surviving place rather than a blank screen.
 */
export function resolvePlace(
  places: readonly AccessPlace[],
  selectedId: string | null,
): string | null {
  if (!Array.isArray(places) || places.length === 0) return null;
  if (selectedId !== null && places.some((p) => p.nodeId === selectedId)) {
    return selectedId;
  }
  return places[0].nodeId;
}
