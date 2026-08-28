/**
 * Acceptance suite for `src/features/admin/lib/siteAccess.ts` — the client
 * half of migration 0021's "who can get in".
 *
 * A VITEST suite, because `npm run test` is what guards this permanently and
 * vitest collects every `src/test/*.test.ts`. (P1-5f shipped a standalone
 * strip-types script that printed 42 passing assertions and contributed ZERO
 * of them to the run — brief-writing rule 11.)
 *
 * Every case runs inside its own try/catch via `check`, so a mutation that
 * makes the module throw fails its case BY NAME rather than aborting the
 * file. Instrument 33 is the same lesson from the probe side.
 *
 * THE FIXTURE mirrors `48_site_membership_test.sql`'s, deliberately, so the
 * two halves of this feature are reasoning about the same shapes:
 *
 *   Plant 1 (PLANT) is the place the screen is about.
 *     Assembly (DEPT) is inside it.
 *
 *   boss@   company admin, NO grant anywhere  -- the only state that tells
 *                                                `companyAdmin` from `grants`
 *   dana@   admin ON Plant 1                  -- the viewer, in most cases
 *   raj@    admin on Assembly                 -- access from BELOW: visible
 *                                                here, not editable here
 *   sam@    supervisor ON Plant 1
 *   mixed@  admin ON Plant 1 *and* viewer on Assembly -- the row that catches
 *                                                a direct/inherited collapse
 *   nobody@ no grants at all                  -- the person the picker exists
 *                                                for
 *   ghost   no email                          -- an account with no address
 */
import { expect, it } from "vitest";
import {
  allowedRoles,
  buildAccessRows,
  canRemoveAccess,
  canSetRole,
  describeAccess,
  accessPanelState,
  matchesQuery,
  partitionAccess,
  removalNote,
  removalReason,
  resolvePlace,
  type AccessPlace,
  type AccessRow,
  type GrantRole,
} from "../features/admin/lib/siteAccess.ts";

const PLANT = "30000000-0000-0000-0000-000000000001";
const DEPT = "30000000-0000-0000-0000-000000000002";

const P_BOSS = "e0000000-0000-0000-0000-000000000001";
const P_DANA = "d0000000-0000-0000-0000-000000000001";
const P_RAJ = "d0000000-0000-0000-0000-000000000003";
const P_SAM = "d0000000-0000-0000-0000-000000000004";
const P_MIX = "d0000000-0000-0000-0000-000000000005";
const P_NONE = "d0000000-0000-0000-0000-000000000006";
const P_GHOST = "d0000000-0000-0000-0000-000000000007";

const grant = (nodeId: string, nodeName: string, role: GrantRole) => ({ nodeId, nodeName, role });

const PAYLOAD = {
  nodeId: PLANT,
  nodeName: "Plant 1",
  people: [
    {
      profileId: P_BOSS,
      email: "boss@example.test",
      orgRole: "admin",
      companyAdmin: true,
      grants: [],
    },
    {
      profileId: P_DANA,
      email: "dana@example.test",
      orgRole: "viewer",
      companyAdmin: false,
      grants: [grant(PLANT, "Plant 1", "admin")],
    },
    { profileId: P_GHOST, email: null, orgRole: "viewer", companyAdmin: false, grants: [] },
    {
      profileId: P_MIX,
      email: "mixed@example.test",
      orgRole: "viewer",
      companyAdmin: false,
      grants: [grant(PLANT, "Plant 1", "admin"), grant(DEPT, "Assembly", "viewer")],
    },
    {
      profileId: P_NONE,
      email: "nobody@example.test",
      orgRole: "viewer",
      companyAdmin: false,
      grants: [],
    },
    {
      profileId: P_RAJ,
      email: "raj@example.test",
      orgRole: "viewer",
      companyAdmin: false,
      grants: [grant(DEPT, "Assembly", "admin")],
    },
    {
      profileId: P_SAM,
      email: "sam@example.test",
      orgRole: "viewer",
      companyAdmin: false,
      grants: [grant(PLANT, "Plant 1", "supervisor")],
    },
  ],
};

/**
 * `check` reports a STRING as the diff so a failure names what was actually
 * seen without every case needing its own matcher — the shapePicker suite's
 * helper, copied deliberately rather than invented.
 */
function check(id: string, fn: () => true | string): void {
  it(id, () => {
    let outcome: true | string;
    try {
      outcome = fn();
    } catch (e) {
      outcome = `THREW: ${e instanceof Error ? e.message : String(e)}`;
    }
    expect(outcome).toBe(true);
  });
}

const VIEW = buildAccessRows(PAYLOAD, P_DANA);
const byId = (id: string): AccessRow =>
  VIEW.rows.find((r) => r.profileId === id) ?? {
    // A distinguishable SENTINEL, never `.find(...)!` — instrument 17 was a
    // fixture accessor that THREW on a mutated build and scored CRASHED where
    // a named failure belonged.
    profileId: "(missing)",
    email: null,
    companyAdmin: false,
    directRole: null,
    inheritedGrants: [],
    hasAccess: false,
    isSelf: false,
  };

const stranger = (over: Partial<AccessRow> = {}): AccessRow => ({
  profileId: "x",
  email: "x@example.test",
  companyAdmin: false,
  directRole: null,
  inheritedGrants: [],
  hasAccess: false,
  isSelf: false,
  ...over,
});

// ---------------------------------------------------------------------------
// A1–A17 — buildAccessRows. The shape guard.
// ---------------------------------------------------------------------------

check("A1: fixture is well-formed — every person parsed, nothing skipped", () => {
  // Rule 3's corollary (D86): assert the fixture in its own case. An id typo
  // here is indistinguishable from the behaviour under test, because every
  // lookup below can honestly return nothing.
  return (
    (VIEW.rows.length === PAYLOAD.people.length &&
      VIEW.skipped === 0 &&
      VIEW.nodeId === PLANT &&
      VIEW.nodeName === "Plant 1" &&
      byId(P_DANA).profileId === P_DANA) ||
    `rows=${VIEW.rows.length} skipped=${VIEW.skipped} node=${VIEW.nodeId}`
  );
});

check("A2: rows keep the order the server sent", () => {
  const got = VIEW.rows.map((r) => r.profileId).join(",");
  const want = PAYLOAD.people.map((p) => p.profileId).join(",");
  return got === want || `${got} != ${want}`;
});

check("A3: a grant ON this node is the direct role", () => {
  const r = byId(P_SAM);
  return (
    (r.directRole === "supervisor" && r.inheritedGrants.length === 0) ||
    `direct=${r.directRole} inherited=${r.inheritedGrants.length}`
  );
});

check("A4: a grant BELOW this node is inherited, never direct", () => {
  // raj administers Assembly. From Plant 1's screen that is real access and
  // it is NOT editable here — `set_site_member(p_node_id)` would write a
  // second grant on Plant 1 rather than change the one raj has.
  const r = byId(P_RAJ);
  return (
    (r.directRole === null &&
      r.inheritedGrants.length === 1 &&
      r.inheritedGrants[0].nodeName === "Assembly" &&
      r.hasAccess) ||
    `direct=${r.directRole} inherited=${JSON.stringify(r.inheritedGrants)}`
  );
});

check("A5 ⭐: both at once — direct is the one on this node, inherited holds only the rest", () => {
  // THE CASE THAT CATCHES A COLLAPSE. A module that takes `grants[0]`, or the
  // strongest grant, or any grant at all, passes A3 and A4 and fails here.
  const r = byId(P_MIX);
  return (
    (r.directRole === "admin" &&
      r.inheritedGrants.length === 1 &&
      r.inheritedGrants[0].nodeId === DEPT &&
      r.inheritedGrants[0].role === "viewer") ||
    `direct=${r.directRole} inherited=${JSON.stringify(r.inheritedGrants)}`
  );
});

check("A6: a company admin has no grant and still has access", () => {
  const r = byId(P_BOSS);
  return (
    (r.companyAdmin && r.hasAccess && r.directRole === null && r.inheritedGrants.length === 0) ||
    JSON.stringify(r)
  );
});

check("A7: no grants and no flag is no access", () => {
  const r = byId(P_NONE);
  return (!r.hasAccess && !r.companyAdmin && r.directRole === null) || JSON.stringify(r);
});

check("A8: exactly one row is the viewer", () => {
  const selves = VIEW.rows.filter((r) => r.isSelf).map((r) => r.profileId);
  return (selves.length === 1 && selves[0] === P_DANA) || `selves=${JSON.stringify(selves)}`;
});

check("A9: an unresolved session makes nobody the viewer", () => {
  const v = buildAccessRows(PAYLOAD, null);
  return v.rows.every((r) => !r.isSelf) || "someone was marked as self";
});

check("A10 ⭐: an unknown role drops that grant rather than coercing it", () => {
  // If a later migration adds a fourth role, a grant carrying it must not
  // render as `viewer` — the screen would offer to "change" a role it is
  // misreporting. Dropped means the person shows as having no access here,
  // which is wrong in the safe direction and visible.
  const v = buildAccessRows(
    {
      nodeId: PLANT,
      nodeName: "Plant 1",
      people: [
        {
          profileId: "z",
          email: "z@example.test",
          companyAdmin: false,
          grants: [{ nodeId: PLANT, nodeName: "Plant 1", role: "owner" }],
        },
      ],
    },
    null,
  );
  const r = v.rows[0];
  return (
    (v.rows.length === 1 &&
      r.directRole === null &&
      r.inheritedGrants.length === 0 &&
      !r.hasAccess) ||
    JSON.stringify(v)
  );
});

check("A11: a malformed person is skipped AND counted", () => {
  // Counted, not swallowed: a silently shortened list is indistinguishable
  // from a company with fewer people in it.
  const v = buildAccessRows(
    {
      nodeId: PLANT,
      nodeName: "P",
      people: [
        null,
        { profileId: "a", email: "a@x", companyAdmin: false, grants: [] },
        7,
        { email: "no-id@x" },
      ],
    },
    null,
  );
  return (v.rows.length === 1 && v.skipped === 3) || `rows=${v.rows.length} skipped=${v.skipped}`;
});

check("A12: a payload that is not an object gives an empty view", () => {
  for (const bad of [null, undefined, 42, "x", [], true]) {
    const v = buildAccessRows(bad, null);
    if (v.rows.length !== 0 || v.nodeId !== null || v.skipped !== 0) return JSON.stringify(bad);
  }
  return true;
});

check("A13: people missing or not an array keeps the node, drops the list", () => {
  const v = buildAccessRows({ nodeId: PLANT, nodeName: "Plant 1" }, null);
  return (
    (v.nodeId === PLANT && v.nodeName === "Plant 1" && v.rows.length === 0) || JSON.stringify(v)
  );
});

check("A14: a person with no grants key is read as having none", () => {
  const v = buildAccessRows({ nodeId: PLANT, nodeName: "P", people: [{ profileId: "a" }] }, null);
  return (v.rows.length === 1 && v.skipped === 0 && !v.rows[0].hasAccess) || JSON.stringify(v);
});

check("A15: a missing address stays null and is never invented", () => {
  return byId(P_GHOST).email === null || `got ${byId(P_GHOST).email}`;
});

check("A49 ⭐: a non-string address is dropped, never stringified", () => {
  // ⭐ ADDED BY THE MUTATION RUN (B27). `asString` returning `String(v)`
  // instead of `null` was NOT CAUGHT: every address in the fixture is either a
  // real string or already null, so the coercion had nothing to bite on. A
  // number arriving here would render as the text "12345" beside a person's
  // row — an address the screen invented, which is worse than a blank.
  const v = buildAccessRows(
    {
      nodeId: PLANT,
      nodeName: "Plant 1",
      people: [
        { profileId: "n", email: 12345, companyAdmin: false, grants: [] },
        { profileId: "o", email: { at: "x" }, companyAdmin: false, grants: [] },
      ],
    },
    null,
  );
  return (
    (v.rows.length === 2 && v.rows.every((r) => r.email === null)) ||
    JSON.stringify(v.rows.map((r) => r.email))
  );
});

check("A16 ⭐: with no node in the payload, NOTHING is a direct grant", () => {
  // Wrong in the safe direction: every grant reports as inherited, so the
  // screen offers no edits rather than editing an unknown place.
  const v = buildAccessRows({ nodeName: "P", people: PAYLOAD.people }, null);
  const bad = v.rows.filter((r) => r.directRole !== null).map((r) => r.profileId);
  return bad.length === 0 || `direct grants without a node: ${JSON.stringify(bad)}`;
});

check("A17: a malformed sweep never throws", () => {
  const bits: unknown[] = [null, undefined, 0, "", NaN, [], {}, true, { profileId: 1 }];
  for (const a of bits) {
    for (const b of bits) {
      for (const c of bits) {
        buildAccessRows(
          { nodeId: a, nodeName: b, people: [c, { profileId: "p", grants: c }] },
          typeof a === "string" ? a : null,
        );
      }
    }
  }
  return true;
});

// ---------------------------------------------------------------------------
// A18–A27 — allowedRoles / canRemoveAccess. The mirror of 0021 §4/§5.
// ---------------------------------------------------------------------------

check("A18: a stranger's row offers all three roles", () => {
  const got = allowedRoles(stranger({ directRole: "viewer" }), false).join(",");
  return got === "admin,supervisor,viewer" || got;
});

check("A19 ⭐: your OWN admin grant on this node locks the control to admin", () => {
  const got = allowedRoles(stranger({ isSelf: true, directRole: "admin" }), false).join(",");
  return got === "admin" || got;
});

check("A20 ⭐: ...and a company admin is exempt", () => {
  const got = allowedRoles(stranger({ isSelf: true, directRole: "admin" }), true).join(",");
  return got === "admin,supervisor,viewer" || got;
});

check("A21 ⭐: your own SUPERVISOR grant is not locked", () => {
  // The narrowing. A broad "never your own row" rule passes A19 and fails
  // here — and it is the rule migration 0021 shipped first, contradicting its
  // own comment (§19.51, rule 17).
  const got = allowedRoles(stranger({ isSelf: true, directRole: "supervisor" }), false).join(",");
  return got === "admin,supervisor,viewer" || got;
});

check("A22 ⭐: adding YOURSELF where you hold no direct grant is not locked", () => {
  // The other half of the narrowing: it takes nothing away, because the
  // stronger covering grant above still decides.
  const got = allowedRoles(stranger({ isSelf: true, directRole: null }), false).join(",");
  return got === "admin,supervisor,viewer" || got;
});

check("A23: no grant on this node, nothing to remove", () => {
  return (
    canRemoveAccess(stranger({ inheritedGrants: [grant(DEPT, "Assembly", "admin")] }), false) ===
      false || "offered a Remove for a grant that is not here"
  );
});

check("A24: you cannot remove your own admin access here", () => {
  return (
    canRemoveAccess(stranger({ isSelf: true, directRole: "admin" }), false) === false || "offered"
  );
});

check("A25 ⭐: but you CAN drop a non-admin grant of your own", () => {
  return (
    canRemoveAccess(stranger({ isSelf: true, directRole: "viewer" }), false) === true || "hidden"
  );
});

check("A26 ⭐: and a COMPANY admin can remove their own admin grant", () => {
  // ⭐ THE DIRECTION CHECK, and the half that is easy to get wrong. Hiding
  // something the server ALLOWS is not a safety bug, it is a feature nobody
  // can reach, and it looks exactly like a broken screen. 48's X36 is the
  // server-side twin of this case.
  return (
    canRemoveAccess(stranger({ isSelf: true, directRole: "admin" }), true) === true || "hidden"
  );
});

check("A27: somebody else's grant on this node is removable", () => {
  return canRemoveAccess(stranger({ directRole: "supervisor" }), false) === true || "hidden";
});

check("A48 ⭐: somebody ELSE's admin grant here is fully editable", () => {
  // ⭐ THIS CASE WAS ADDED BY WRITING THE MUTATION TABLE, BEFORE RUNNING IT.
  // Dropping `row.isSelf` from the self-rule makes it fire on everybody, and
  // every other case in this group either uses a non-admin role or IS the
  // viewer — so the mutant would have been green. A21/A22/A25 walk the
  // narrowing, A20/A26 walk the exemption, and nothing walked "not me".
  const other = stranger({ isSelf: false, directRole: "admin" });
  return (
    (allowedRoles(other, false).join(",") === "admin,supervisor,viewer" &&
      canRemoveAccess(other, false) === true) ||
    `roles=${allowedRoles(other, false).join(",")} remove=${canRemoveAccess(other, false)}`
  );
});

// ---------------------------------------------------------------------------
// A28–A34 — describeAccess. The sentence under the address.
// ---------------------------------------------------------------------------

check("A28: a company admin with no grant here reads as a company admin", () => {
  // The most powerful route in wins, because that is the one deciding what
  // the person can do.
  const r = stranger({ companyAdmin: true });
  return (
    describeAccess(r, "Plant 1") === "Company admin — reaches every plant" ||
    describeAccess(r, "Plant 1")
  );
});

check("A50 ⭐: ...but a company admin who ALSO holds a grant here must say both", () => {
  // ⭐ FOUND ON THE REAL SCREEN, NOT BY A TEST. The seeded company admin holds
  // an admin grant on Plant 1 as well as the org-wide flag, so the row read
  // "Company admin — reaches every plant" beside a role control that was
  // editing the GRANT. Setting that control to `viewer` would leave the
  // sentence unchanged — it is still true — and the change would look like it
  // had done nothing at all.
  //
  // A28 stays: precedence is unchanged, the flag still leads. What changed is
  // that the row now names what the control is editing.
  const r = stranger({ companyAdmin: true, directRole: "admin" });
  const s = describeAccess(r, "Plant 1");
  return (
    (s === "Company admin — and admin of Plant 1" &&
      s !== describeAccess(stranger({ companyAdmin: true }), "Plant 1")) ||
    s
  );
});

check("A51: and it names the role the control is actually showing", () => {
  // `viewer` reads "and viewer of", not a hardcoded "admin" — the specific
  // way a copy-paste of A50 would be wrong.
  const s = describeAccess(stranger({ companyAdmin: true, directRole: "viewer" }), "Plant 1");
  return s === "Company admin — and viewer of Plant 1" || s;
});

check("A29: a direct admin names the place", () => {
  return (
    describeAccess(stranger({ directRole: "admin" }), "Plant 1") === "Admin of Plant 1" ||
    describeAccess(stranger({ directRole: "admin" }), "Plant 1")
  );
});

check("A30: supervisor and viewer read differently", () => {
  // ⚠️ The obvious third clause, `s !== v`, is NOT here: `tsc` rejects it as a
  // comparison between two string LITERAL types that provably cannot overlap
  // (TS2367). It was written, and the compiler proved it inert before any run
  // did — rule 0 earning its place, since strip-types had been green on it.
  const s = describeAccess(stranger({ directRole: "supervisor" }), "Plant 1");
  const v = describeAccess(stranger({ directRole: "viewer" }), "Plant 1");
  return (s === "Supervisor on Plant 1" && v === "Can view Plant 1") || `${s} / ${v}`;
});

check("A31: one inherited grant names the place it actually sits on", () => {
  const r = stranger({ inheritedGrants: [grant(DEPT, "Assembly", "admin")], hasAccess: true });
  return describeAccess(r, "Plant 1") === "Admin on Assembly" || describeAccess(r, "Plant 1");
});

check("A32: several inherited grants are counted, not listed", () => {
  const r = stranger({
    inheritedGrants: [grant(DEPT, "Assembly", "admin"), grant("n3", "Machining", "viewer")],
    hasAccess: true,
  });
  return (
    describeAccess(r, "Plant 1") === "Access to 2 places inside Plant 1" ||
    describeAccess(r, "Plant 1")
  );
});

check("A33: no access says so", () => {
  return (
    describeAccess(stranger(), "Plant 1") === "No access" || describeAccess(stranger(), "Plant 1")
  );
});

check("A34: an unknown place name falls back rather than printing null", () => {
  const s = describeAccess(stranger({ directRole: "admin" }), null);
  return (s === "Admin of this place" && !s.includes("null")) || s;
});

// ---------------------------------------------------------------------------
// A35–A39 — removalNote. Why there is no button.
// ---------------------------------------------------------------------------

check("A35 ⭐: a removable row has NO note", () => {
  // The null is the signal. A caller rendering this unconditionally would
  // print an explanation next to a live button.
  return (
    removalNote(stranger({ directRole: "supervisor" }), false) === null ||
    String(removalNote(stranger({ directRole: "supervisor" }), false))
  );
});

check("A36: your own admin access explains itself", () => {
  const n = removalNote(stranger({ isSelf: true, directRole: "admin" }), false);
  return n === "You can't take away your own admin access here." || String(n);
});

check("A37: a company admin's note explains the missing button, and nothing else", () => {
  // ⭐ REWRITTEN AFTER LOOKING AT THE RENDER. It used to assert the note
  // repeated "Company admins reach every plant" — which `describeAccess`
  // already prints two columns to the left, so the row said the same thing
  // twice. The note's job is the ABSENCE of the button; the reason is already
  // on the row. Asserted as an inequality with `describeAccess` so the
  // duplication cannot come back.
  const row = stranger({ companyAdmin: true, hasAccess: true });
  const n = removalNote(row, false);
  return (n === "Nothing to take away here." && n !== describeAccess(row, "Plant 1")) || String(n);
});

check("A38: access from below points at the place it sits on", () => {
  const n = removalNote(
    stranger({ inheritedGrants: [grant(DEPT, "Assembly", "admin")], hasAccess: true }),
    false,
  );
  return (n !== null && n.includes("further down the tree")) || String(n);
});

check("A39: and a stranger with nothing gets the plain sentence", () => {
  return (
    removalNote(stranger(), false) === "No access here to take away." ||
    String(removalNote(stranger(), false))
  );
});

// ---------------------------------------------------------------------------
// A40–A47 — search and the two lists.
// ---------------------------------------------------------------------------

check("A40: an empty query matches everyone", () => {
  return VIEW.rows.every((r) => matchesQuery(r, "")) || "someone was filtered out";
});

check("A41 ⭐: a whitespace-only query matches everyone", () => {
  // A search box that has been cleared to spaces must not hide the list.
  // `.trim()` and nothing else — the character class and the `\\s` regex have
  // both been tried in this project and both were wrong (migration 0011).
  return VIEW.rows.every((r) => matchesQuery(r, "   \t\n ")) || "someone was filtered out";
});

check("A42: matching is case-insensitive and matches inside the address", () => {
  const r = byId(P_SAM);
  return (
    (matchesQuery(r, "SAM") && matchesQuery(r, "am@ex") && !matchesQuery(r, "zzz")) || "wrong match"
  );
});

check("A43 ⭐: a person with no address survives an empty query and no other", () => {
  const g = byId(P_GHOST);
  return (matchesQuery(g, "") && !matchesQuery(g, "a")) || "wrong match for a missing address";
});

check("A44: with no search, the screen is the member list and nothing else", () => {
  // ⭐ REWRITTEN WHEN THE CONTRACT CHANGED (rule 1b-ii, not 1b): the old case
  // asserted that a blank query lists every candidate, which was correct for
  // the shape that shipped first and is exactly what the maintainer pushed back on —
  // a standing list of everyone in the company, sitting under the people who
  // actually have access, asserts a relationship that does not exist.
  const { members, candidates } = partitionAccess(VIEW.rows, "");
  const m = members
    .map((r) => r.profileId)
    .sort()
    .join(",");
  const wantM = [P_BOSS, P_DANA, P_MIX, P_RAJ, P_SAM].sort().join(",");
  return (
    (m === wantM && candidates.length === 0) ||
    `members=${m} candidates=${candidates.length} (want 0)`
  );
});

check("A44b ⭐: a search is what produces candidates", () => {
  // The other half. A rule that returned candidates never would pass A44 and
  // break the only reason this screen exists — 0020 §9's named gap was that a
  // site admin could grant access to somebody they could not find.
  const { candidates } = partitionAccess(VIEW.rows, "nobody");
  return (
    (candidates.length === 1 && candidates[0].profileId === P_NONE) ||
    JSON.stringify(candidates.map((r) => r.email))
  );
});

check("A44c: a whitespace-only search is still no search", () => {
  // Ties to A41: `.trim()` decides both "does this match everyone" and "is
  // this a search at all", so the two can never disagree about a box the user
  // has cleared to spaces.
  const { members, candidates } = partitionAccess(VIEW.rows, "   \t ");
  return (
    (members.length === 5 && candidates.length === 0) ||
    `members=${members.length} candidates=${candidates.length}`
  );
});

check("A45 ⭐: neither list is re-sorted — the server's order survives", () => {
  // The server orders by `email COLLATE "C"` and 48's X34 pins it. A second
  // sort here by a different rule is how the picker and the member list end
  // up disagreeing about where somebody is.
  const { members } = partitionAccess(VIEW.rows, "");
  const serverOrder = VIEW.rows
    .filter((r) => r.hasAccess)
    .map((r) => r.profileId)
    .join(",");
  return members.map((r) => r.profileId).join(",") === serverOrder || "the list was re-sorted";
});

check("A46: the query applies to both lists at once", () => {
  const { members, candidates } = partitionAccess(VIEW.rows, "o");
  // boss@ and nobody@ both contain "o"; dana@, raj@, sam@, mixed@ do not.
  return (
    (members.map((r) => r.profileId).join(",") === P_BOSS &&
      candidates.map((r) => r.profileId).join(",") === P_NONE) ||
    `members=${members.map((r) => r.email)} candidates=${candidates.map((r) => r.email)}`
  );
});

check("A47: a query that is not a string does not throw and hides nobody", () => {
  for (const bad of [null, undefined, 7, {}, []]) {
    if (!matchesQuery(byId(P_SAM), bad as unknown as string)) return JSON.stringify(bad);
  }
  return true;
});

// ---------------------------------------------------------------------------
// C1–C8 — accessPanelState. Two reads, one answer.
// ---------------------------------------------------------------------------

check("C1: while the tree is still loading, nothing else is known yet", () => {
  const s = accessPanelState(true, null, false, true);
  return s === "pending" || s;
});

check("C2: a place and a finished read is ready", () => {
  const s = accessPanelState(false, PLANT, false, false);
  return s === "ready" || s;
});

check("C3: no place to be about is its own state, not an error", () => {
  // The mid-tree admin. A structure is owned by a ROOT, so a department admin
  // administers no structure and there is no site for this panel to show.
  const s = accessPanelState(false, null, false, false);
  return s === "no-place" || s;
});

check("C4 ⭐: a null place is NEVER ready, whatever the loading flags say", () => {
  // ⭐ THIS CASE WAS REWRITTEN AFTER THE MUTATION RUN, BECAUSE ITS FIRST NAME
  // CLAIMED MORE THAN IT GUARDED. It said it pinned the D91 branch order, and
  // the mutation that swaps those branches (B29) is caught by C5, not by this.
  // With a DISABLED query `peopleLoading` is false, so both orders answer
  // "no-place" and this case cannot tell them apart.
  //
  // What it does guard is the mutation that actually ships the D91 bug: a
  // null place resolving to "ready", which renders an empty list of colleagues
  // as though the company had nobody in it. Both loading flags are swept
  // because the trap is precisely that the flag you would rely on is false.
  for (const loading of [true, false]) {
    for (const err of [true, false]) {
      const s = accessPanelState(false, null, loading, err);
      if (s === "ready") return `no place, loading=${loading}, error=${err} -> ready`;
    }
  }
  return true;
});

check("C5: an error outranks a still-loading refetch", () => {
  // React Query keeps `isLoading` true on a retry; showing a spinner over a
  // read that has already failed is how a screen hangs forever.
  const s = accessPanelState(false, PLANT, true, true);
  return s === "error" || s;
});

check("C6: loading with a place is a spinner", () => {
  const s = accessPanelState(false, PLANT, true, false);
  return s === "pending" || s;
});

check("C7: the tree wins over everything, including an error", () => {
  const s = accessPanelState(true, PLANT, true, true);
  return s === "pending" || s;
});

check("C8: every combination returns one of the four, and none throws", () => {
  const vals = ["pending", "no-place", "error", "ready"];
  for (const a of [true, false]) {
    for (const b of [PLANT, null]) {
      for (const c of [true, false]) {
        for (const d of [true, false]) {
          const s = accessPanelState(a, b, c, d);
          if (!vals.includes(s)) return `${a},${b},${c},${d} -> ${s}`;
        }
      }
    }
  }
  return true;
});

// ---------------------------------------------------------------------------
// D1–D6 — removalReason. The reason, not the sentence.
//
// ⭐ THIS SPLIT EXISTS BECAUSE ONE REASON NEEDS A BUTTON. "Their access sits
// further down the tree — open that place to change it" was correct and
// unfollowable: the panel was pinned to the site root and there was no way to
// open that place. The component now switches on the reason and renders a way
// in. `removalNote` is derived from `removalReason`, so the branch order lives
// in one place — D6 is what stops them drifting.
// ---------------------------------------------------------------------------

check("D1: a removable row's reason is removable", () => {
  const r = removalReason(stranger({ directRole: "supervisor" }), false);
  return r === "removable" || r;
});

check("D2: your own admin access here", () => {
  const r = removalReason(stranger({ isSelf: true, directRole: "admin" }), false);
  return r === "self" || r;
});

check("D3: a company admin with nothing to remove", () => {
  const r = removalReason(stranger({ companyAdmin: true, hasAccess: true }), false);
  return r === "company-admin" || r;
});

check("D4 ⭐: access from below is its own reason, because it gets a button", () => {
  const row = stranger({ inheritedGrants: [grant(DEPT, "Assembly", "admin")], hasAccess: true });
  return removalReason(row, false) === "inherited" || removalReason(row, false);
});

check("D7 ⭐: a company admin who ALSO holds a grant below still reads as a company admin", () => {
  // ⭐ ADDED BY THE MUTATION RUN (B37). Swapping the `inherited` and
  // `company-admin` branches was NOT CAUGHT: no fixture row held both, so the
  // order was untested. The state is real — a company admin can perfectly well
  // also be named on a department — and the order matters, because
  // "access from below" would offer them a way in they do not need while
  // hiding the reason they actually reach everything.
  const row = stranger({
    companyAdmin: true,
    inheritedGrants: [grant(DEPT, "Assembly", "admin")],
    hasAccess: true,
  });
  return removalReason(row, false) === "company-admin" || removalReason(row, false);
});

check("D5: a stranger with nothing at all", () => {
  const r = removalReason(stranger(), false);
  return r === "none" || r;
});

check("D6 ⭐: removalNote and removalReason cannot disagree", () => {
  // Every combination that reaches this module: the note is null exactly when
  // the reason is "removable", and non-null otherwise. Two independent branch
  // ladders is how a row ends up with an explanation beside a live button.
  const rows: AccessRow[] = [
    stranger({ directRole: "supervisor" }),
    stranger({ directRole: "admin" }),
    stranger({ isSelf: true, directRole: "admin" }),
    stranger({ isSelf: true, directRole: "viewer" }),
    stranger({ companyAdmin: true, hasAccess: true }),
    stranger({ companyAdmin: true, directRole: "admin", hasAccess: true }),
    stranger({ inheritedGrants: [grant(DEPT, "Assembly", "admin")], hasAccess: true }),
    stranger(),
  ];
  for (const row of rows) {
    for (const isCA of [true, false]) {
      const reason = removalReason(row, isCA);
      const note = removalNote(row, isCA);
      if ((reason === "removable") !== (note === null)) {
        return `${reason} / ${String(note)} (companyAdminViewer=${isCA})`;
      }
      if (reason !== "removable" && (note === null || note.trim() === "")) {
        return `${reason} produced an empty note`;
      }
    }
  }
  return true;
});

// ---------------------------------------------------------------------------
// E1–E6 — resolvePlace. The panel's own control.
//
// ⭐ It had none: the Access tab was scoped by the structure picker on the
// HIERARCHY tab, so a company admin was shown whichever plant that other tab
// had selected and could not change it. "Where is Plant 1?" — and there was no
// answer on the screen.
// ---------------------------------------------------------------------------

const PLACES = [
  { nodeId: PLANT, name: "Plant 1" },
  { nodeId: "n-p2", name: "Plant 2" },
];

check("E1: a live selection is kept", () => {
  return resolvePlace(PLACES, "n-p2") === "n-p2" || String(resolvePlace(PLACES, "n-p2"));
});

check("E2: no selection yet falls to the first place", () => {
  return resolvePlace(PLACES, null) === PLANT || String(resolvePlace(PLACES, null));
});

check("E3 ⭐: a selection that is no longer in the list falls back, it does not stick", () => {
  // The case that matters: a plant you administered and no longer do. Sticking
  // leaves the panel asking the server about a place it will refuse, and the
  // screen shows an error where a working list belongs.
  return resolvePlace(PLACES, "gone") === PLANT || String(resolvePlace(PLACES, "gone"));
});

check("E4: no places at all is null, not a crash", () => {
  return resolvePlace([], "anything") === null || String(resolvePlace([], "anything"));
});

check("E5: a single place needs no selection", () => {
  const one = [{ nodeId: PLANT, name: "Plant 1" }];
  return resolvePlace(one, null) === PLANT || String(resolvePlace(one, null));
});

check("E6: a malformed list is treated as empty and never throws", () => {
  for (const bad of [null, undefined, "x", 7, {}]) {
    if (resolvePlace(bad as unknown as AccessPlace[], null) !== null) return JSON.stringify(bad);
  }
  return true;
});

// ---------------------------------------------------------------------------
// G1–G7 — a company admin's row is not a site admin's to edit (0022).
//
// ⭐ FOUND ON THE RUNNING SCREEN: signed in as a site admin, the company
// admin's row offered a role control and a Remove button, and the SERVER
// allowed both. Measured — no escalation, nothing taken away, because a
// company admin's authority is `user_profiles.role` and a site admin cannot
// write it. Still a role inversion, and a button that removes nothing.
//
// ⚠️ The server was fixed FIRST (migration 0022). Hiding a permitted action
// would have broken this file's own invariant. `49_`'s X41/X42 are the
// server-side twins of G1 and G2.
// ---------------------------------------------------------------------------

const companyAdminHere = (over: Partial<AccessRow> = {}) =>
  stranger({ companyAdmin: true, directRole: "admin", hasAccess: true, ...over });

check("G1 ⭐: a site admin is offered no Remove on a company admin's row", () => {
  return (
    canRemoveAccess(companyAdminHere(), false) === false ||
    "the screen offered to remove a company admin"
  );
});

check("G2 ⭐: ...and no role control either", () => {
  // A control that offers one option and writes nothing is worse than no
  // control: it looks live.
  return canSetRole(companyAdminHere(), false) === false || "the screen offered a role control";
});

check("G3 ⭐: two company admins are peers — the flag is HALF the test", () => {
  // The half a `row.companyAdmin`-only rule would fail. 49's X44 is the
  // server-side twin, and 48's X36 catches the same mutation from the
  // self-rule side.
  const row = companyAdminHere();
  return (
    (canRemoveAccess(row, true) === true && canSetRole(row, true) === true) ||
    `remove=${canRemoveAccess(row, true)} setRole=${canSetRole(row, true)}`
  );
});

check("G4: an ordinary person is still fully editable by a site admin", () => {
  // The other half: a guard that fired on everybody would pass G1 and G2 and
  // break the entire feature. 49's X43.
  const row = stranger({ directRole: "supervisor", hasAccess: true });
  return (
    (canSetRole(row, false) === true && canRemoveAccess(row, false) === true) ||
    `remove=${canRemoveAccess(row, false)} setRole=${canSetRole(row, false)}`
  );
});

check("G5 ⭐: the two company-admin rows do NOT get the same sentence", () => {
  // One genuinely has nothing to take away. The other HAS something — the
  // viewer is simply not the person who may touch it. Saying "nothing" to the
  // second would be the same lie the button used to tell.
  //
  // ⚠️ AND THE OBVIOUS `withGrant !== without` IS NOT HERE. `tsc` rejects it as
  // TS2367 — two string literal types that provably cannot overlap. This is
  // the SECOND time a "so it cannot come back" inequality has turned out to be
  // vacuous (A30 was the first), and the pattern is now clear: once both sides
  // narrow to literals the compiler has already proved the claim, and writing
  // it costs a red build rather than buying coverage. Rule 0, twice.
  const withGrant = removalNote(companyAdminHere(), false);
  const without = removalNote(stranger({ companyAdmin: true, hasAccess: true }), false);
  return (
    (withGrant === "Company admins aren't managed from a site." &&
      without === "Nothing to take away here.") ||
    `${String(withGrant)} / ${String(without)}`
  );
});

check("G6: the reason behind both is company-admin", () => {
  const a = removalReason(companyAdminHere(), false);
  const b = removalReason(stranger({ companyAdmin: true, hasAccess: true }), false);
  return (a === "company-admin" && b === "company-admin") || `${a} / ${b}`;
});

check("G7 ⭐: whatever else is true of a protected row, it is never removable", () => {
  // ⭐ THIS CASE STARTED AS AN ORDERING ASSERTION AND THE FIRST RUN KILLED IT.
  // It claimed "the protection outranks the self-rule", and `removalReason`
  // answers "self" — because `selfLocked` is checked first. Both refuse, so
  // nothing unsafe turns on the order, and the state it described (a row that
  // is BOTH you and a company admin, seen by a viewer who is not one) is a
  // contradiction: if that row is you and it is a company admin, you are one.
  // It is reachable only as a transient artefact while the session's own
  // profile is still resolving.
  //
  // Pinning an arbitrary order on an input nobody can produce deliberately is
  // rule 3b's trap. The PROPERTY is what matters and it holds on every
  // combination, so that is what is asserted.
  for (const isSelf of [true, false]) {
    for (const directRole of ["admin", "supervisor", "viewer", null] as const) {
      const row = stranger({ companyAdmin: true, hasAccess: true, isSelf, directRole });
      if (canRemoveAccess(row, false) || canSetRole(row, false)) {
        return `isSelf=${isSelf} directRole=${String(directRole)} was editable`;
      }
      if (removalNote(row, false) === null) {
        return `isSelf=${isSelf} directRole=${String(directRole)} had no explanation`;
      }
    }
  }
  return true;
});
