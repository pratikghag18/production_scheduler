/**
 * Acceptance suite for `src/features/admin/lib/editRights.ts` — the client's
 * mirror of `app_can_edit_node`.
 *
 * A VITEST suite, because `npm run test` is what guards this permanently. One
 * plain `it()` per case, never `it.each`: a table-driven case that fails names
 * the table, not the rule that broke, and this file exists to name the rule.
 *
 * ⭐⭐ WHAT IT IS REALLY PINNING IS THE THREE ARMS **SEPARATELY**. Every arm of
 * `app_can_edit_node` is satisfied by a company admin, so a suite that only ever
 * asks about one would pass against a mirror that had collapsed to
 * `role === "admin"`. Each case below is therefore built so that exactly ONE arm
 * can carry it, and E3/E4/E5 are the three ways the containment test can be
 * wrong while still looking right.
 *
 * ⚠️ THE SERVER IS THE AUTHORITY AND THIS SUITE DOES NOT REPLACE IT.
 * `supabase/tests/59_training_record_test.sql` case V14 is what proves the
 * database refuses a line supervisor's rename of a plant-owned training; these
 * cases prove the SCREEN agrees with it in advance.
 *
 * THE WORLD — one plant, one area, two lines, and a tenth line that exists only
 * to make the label boundary bite:
 *
 *   plant_1
 *   plant_1.area_1
 *   plant_1.area_1.line_1
 *   plant_1.area_1.line_10   <- `line_1` is a STRING prefix of this and not its ancestor
 *   plant_1.area_2
 */
import { parseGrantPaths } from "@/lib/api";
import { describe, expect, it } from "vitest";
import {
  UNKNOWN_EDIT_RIGHTS,
  canEditNode,
  canWriteOrgWide,
  coveredByAnyGrant,
  isCompanyAdmin,
  notManagedNote,
  type EditRights,
} from "../features/admin/lib/editRights.ts";

const PLANT = "plant_1";
const AREA = "plant_1.area_1";
const LINE_1 = "plant_1.area_1.line_1";
const LINE_10 = "plant_1.area_1.line_10";
const AREA_2 = "plant_1.area_2";

/** A landed answer. Every field must be stated — see `known`'s own comment. */
function rights(over: Partial<EditRights> = {}): EditRights {
  return { role: "viewer", adminPaths: [], writablePaths: [], known: true, ...over };
}

/* ===========================================================================
 * Arm (1) — `app_is_admin()`.
 * ======================================================================== */

describe("editRights — arm (1), the company admin", () => {
  it("E1: a company admin edits everything, holding no grants at all", () => {
    // ⭐ NO GRANTS ON PURPOSE. `app_is_admin()` stands alone in the SQL, so a
    // mirror that required a grant as well would lock out the one person who
    // is never given one.
    const r = rights({ role: "admin" });
    expect(canEditNode(PLANT, r)).toBe(true);
    expect(canEditNode(LINE_10, r)).toBe(true);
    expect(isCompanyAdmin("admin")).toBe(true);
    expect(isCompanyAdmin("supervisor")).toBe(false);
  });
});

/* ===========================================================================
 * Arm (2) — `app_is_admin_on_path()`. The trap in the file.
 * ======================================================================== */

describe("editRights — arm (2), the site admin", () => {
  it("E2 ⚠️⚠️ a site admin is org-wide 'viewer', and arm (2) carries them alone", () => {
    // ⚠️⚠️ THIS IS THE CASE THE WHOLE FILE IS SHAPED AROUND. The demo's three
    // site admins (dana, quinn, rosa) hold `user_profiles.role = 'viewer'` and
    // an ADMIN GRANT on their site — `session.ts` records the same fact about
    // why `adminAccess` had to be widened. `app_is_admin_on_path` has no
    // org-role term, so a mirror that ANDed `app_can_write()` into every arm
    // would agree with the server about everybody except these three and lock
    // all three out of the section they run.
    const dana = rights({ role: "viewer", adminPaths: [AREA] });
    expect(canWriteOrgWide("viewer")).toBe(false);
    expect(canEditNode(AREA, dana)).toBe(true);
    expect(canEditNode(LINE_1, dana)).toBe(true);
  });

  it("E3: a grant reaches its own node and everything BELOW it", () => {
    // ⚠️ REFLEXIVE, and both directions are asserted from the SAME grant — a
    // mirror with `isAtOrBelow`'s arguments swapped passes the first line of
    // this and fails the second, which is why they are not two cases.
    const r = rights({ role: "viewer", adminPaths: [AREA] });
    expect(canEditNode(AREA, r)).toBe(true);
    expect(canEditNode(LINE_1, r)).toBe(true);
    expect(coveredByAnyGrant(LINE_1, [AREA])).toBe(true);
  });

  it("E4 ⭐⭐ V14: a grant NEVER reaches above itself, which is the whole defect", () => {
    // ⭐⭐ THE CASE THIS FEATURE EXISTS FOR. Read-scoping shows a line
    // supervisor the plant's trainings; `path <@ gp` refuses to write them.
    // A mirror with the containment inverted would call the plant editable and
    // reproduce exactly the screen V14 describes.
    const lineAdmin = rights({ role: "viewer", adminPaths: [LINE_1] });
    expect(canEditNode(PLANT, lineAdmin)).toBe(false);
    expect(canEditNode(AREA, lineAdmin)).toBe(false);
    expect(canEditNode(LINE_1, lineAdmin)).toBe(true);
  });

  it("E5 ⚠️ the containment is on LABELS, not characters: line_1 does not reach line_10", () => {
    // ⚠️ `startsWith(grant)` says yes here and is silently wrong. Ten lines is
    // all it takes, and nothing on screen looks broken — the buttons simply
    // appear on a row the server then refuses.
    const r = rights({ role: "viewer", adminPaths: [LINE_1] });
    expect(canEditNode(LINE_10, r)).toBe(false);
    expect(coveredByAnyGrant(LINE_10, [LINE_1])).toBe(false);
  });

  it("E6: a sibling branch is not covered, and several grants are a UNION", () => {
    const r = rights({ role: "viewer", adminPaths: [LINE_1, AREA_2] });
    expect(canEditNode(AREA_2, r)).toBe(true);
    expect(canEditNode(LINE_1, r)).toBe(true);
    expect(canEditNode(AREA, r)).toBe(false);
  });
});

/* ===========================================================================
 * Arm (3) — `app_can_write() AND app_grant_paths(true)`. ONE arm, two halves.
 * ======================================================================== */

describe("editRights — arm (3), the org-wide writer with a grant", () => {
  it("E7 ⭐ 0032: an org-wide supervisor edits their own branch and below", () => {
    const r = rights({ role: "supervisor", writablePaths: [LINE_1] });
    expect(canEditNode(LINE_1, r)).toBe(true);
    expect(canWriteOrgWide("supervisor")).toBe(true);
  });

  it("E8 ⚠️ the two halves are ANDed: an org-wide writer with no covering grant edits nothing", () => {
    // ⚠️ `app_can_write()` ALONE AUTHORISES NOTHING. `session.ts` records that
    // a supervisor with no grants can reach this screen deliberately and will
    // find two empty lists; an OR here would hand them the whole company.
    const r = rights({ role: "supervisor", writablePaths: [AREA_2] });
    expect(canEditNode(LINE_1, r)).toBe(false);
    expect(canEditNode(PLANT, r)).toBe(false);
  });

  it("E9 ⚠️ and the other half too: a writable grant without the org role is not enough", () => {
    // ⚠️ THE COMPLEMENT OF E2, AND THE REASON THAT ONE IS NOT A LICENCE TO DROP
    // THE ROLE TERM EVERYWHERE. A 'viewer' holding a SUPERVISOR grant is
    // refused by the server — only an ADMIN grant stands alone. Both cases have
    // to be present or the pair reads as an inconsistency to be tidied away.
    const r = rights({ role: "viewer", writablePaths: [LINE_1] });
    expect(canEditNode(LINE_1, r)).toBe(false);
  });

  it("E10: a company admin's supervisor-grant branch is still theirs, via arm (1)", () => {
    // The arms are ORed, so the answer must not depend on which one is asked
    // first. A mirror that returned early on a MISSING admin grant would fail.
    const r = rights({ role: "admin", writablePaths: [LINE_1] });
    expect(canEditNode(AREA_2, r)).toBe(true);
  });
});

/* ===========================================================================
 * Failing open — the half that is not a mirror.
 * ======================================================================== */

describe("editRights — it fails OPEN, always", () => {
  it("E11 ⭐⭐ an unlanded grant read offers everything, rather than refusing everything", () => {
    // ⭐⭐ `scope.ts`'s standing argument: hiding is invisible and permanent,
    // offering is loud and recoverable. Failing closed here would strip every
    // control off every row for the whole of the first render, and for good if
    // the RPC ever stopped working.
    expect(canEditNode(PLANT, UNKNOWN_EDIT_RIGHTS)).toBe(true);
    expect(canEditNode(LINE_1, { ...rights({ role: "viewer" }), known: false })).toBe(true);
  });

  it("E12 ⚠️ 'no grants' and 'we were not told' are different answers", () => {
    // ⚠️ THE DISTINCTION `known` EXISTS FOR. The path arrays are empty in both
    // cases, so dropping the flag makes an unanswered question indistinguishable
    // from a landed "you may edit nothing".
    expect(canEditNode(LINE_1, rights({ role: "viewer" }))).toBe(false);
    expect(canEditNode(LINE_1, rights({ role: "viewer", known: false }))).toBe(true);
  });

  it("E13 ⚠️ an owner the client cannot resolve to a path is offered, not hidden", () => {
    // A row whose owning node fell outside the readable set, or off a truncated
    // response. "I cannot tell" must never render as "no".
    const r = rights({ role: "viewer", adminPaths: [LINE_1] });
    expect(canEditNode(null, r)).toBe(true);
  });
});

/* ===========================================================================
 * The wire, and the sentence.
 * ======================================================================== */

// ⚠️ `parseGrantPaths` is imported from `@/lib/api` and not from the lib beside
// this one: the narrowing moved to the boundary that does the reading, and its
// old home was deleted rather than left as a second copy.
describe("editRights — reading the RPC and saying what it means", () => {
  it("E14 ⭐ the measured shape: `setof ltree` arrives as an array of plain strings", () => {
    // ⭐ MEASURED against the running local stack, not assumed — the generator
    // types both RPCs as `Returns: unknown[]`, so nothing but a call could say.
    expect(parseGrantPaths(["plant_a.area_1.line_1"])).toEqual(["plant_a.area_1.line_1"]);
    expect(parseGrantPaths([])).toEqual([]);
  });

  it("E15 ⚠️ a shape it cannot read degrades to fail-open, never to a locked screen", () => {
    // ⚠️ SKIPS RATHER THAN THROWS (`buildAccessRows`' call). An object-per-row
    // or a null is what a future `ltree` serialisation change would look like;
    // the cost must be extra buttons the server refuses, not a panel with none.
    expect(parseGrantPaths(null)).toEqual([]);
    expect(parseGrantPaths({ path: "plant_1" })).toEqual([]);
    expect(parseGrantPaths(["plant_1", null, 7, "", { p: "x" }])).toEqual(["plant_1"]);
  });

  it("E16: the read-only line names the PLACE, and says nothing about tickets or skills", () => {
    const note = notManagedNote("Line A");
    expect(note).toContain("Line A");
    // ⚠️ THE VOCABULARY RULE REACHES THIS FILE TOO. `trainings.test.ts` case T17
    // enumerates that module's sentences; this one is rendered on the same
    // screen and would be the one leak nothing was watching.
    expect(note.toLowerCase()).not.toContain("ticket");
    expect(note.toLowerCase()).not.toContain("skill");
    // And it explains rather than only refusing — "you can see this" is the
    // half that stops it reading as an error.
    expect(note.toLowerCase()).toContain("see this");
  });
});
