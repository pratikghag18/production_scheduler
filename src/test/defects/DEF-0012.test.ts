import { describe, expect, it } from "vitest";
import { allowedRoles, type AccessRow } from "@/features/admin/lib/siteAccess";

/**
 * DEF-0012 — THE ACCESS SCREEN SHOWS A BELOW-ROOT ADMIN AS "supervisor".
 *
 * Migration 0053 narrowed `admin` to a plant root and `allowedRoles` mirrors it,
 * which is right. What neither of them decided is what to draw for a row that
 * ALREADY holds `admin` below a root — a grant 0053 deliberately leaves alone
 * ("no backfill"), or one made by a direct write, which is still possible
 * because only the RPC enforces the rule.
 *
 * The row is rendered as
 *
 *     <select value={row.directRole}>          // "admin"
 *       {allowedRoles(row, viewerIsCompanyAdmin, atPlantRoot).map(...)}
 *     </select>                                 // ["supervisor", "viewer"]
 *
 * and a `<select>` whose value is not among its options shows the FIRST option.
 * Read off the running app as the company admin, with a grant on Area 1:
 *
 *     ana@example.test | Admin of Area 1 | [ supervisor ▾ ]
 *
 * One row, two answers. The sentence is right and the control is wrong, and the
 * control is the half somebody will act on.
 *
 * ⛔ R-340 SAYS THIS CANNOT HAPPEN, IN ITS OWN WORDS: *"`allowedRoles`
 * therefore still returns `["admin"]` for such a row under the self-rule, so no
 * control is ever rendered with nothing selected."* The self-rule is
 * `row.isSelf && !viewerIsCompanyAdmin && row.directRole === "admin"` — it is
 * about the viewer's OWN row. It says nothing about anybody else's, and
 * everybody else's is the case an administrator spends their time in.
 *
 * ⚠️ WHY THIS IS THE ASSERTION AND NOT A RENDER. `allowedRoles` is the whole
 * decision; the `<select>` only obeys it. `siteAccess.test.ts` A30 already
 * covers the self case with the same helper, so a fix that satisfies this file
 * satisfies the screen, and a render here would be testing React's
 * value-not-in-options behaviour rather than this app's.
 *
 * ⭐ WHAT WOULD MAKE IT GREEN is not decided here and is the developer's: a
 * control that offers `admin` when the person already holds it (the honest
 * rendering the function's own first paragraph argues for), or a row that
 * renders no control at all with a sentence saying why. What must not happen is
 * a control showing a role its subject does not hold.
 */

function row(over: Partial<AccessRow> = {}): AccessRow {
  return {
    profileId: "p-ana",
    email: "ana@example.test",
    companyAdmin: false,
    directRole: "admin",
    inheritedGrants: [],
    hasAccess: true,
    isSelf: false,
    active: true,
    ...over,
  };
}

describe("DEF-0012: a role control never shows a role its subject does not hold", () => {
  /**
   * ⛔ THE DEFECT. Somebody ELSE's admin grant below a plant root, seen by the
   * company admin — the ordinary way an administrator meets this row.
   */
  it("someone else's below-root admin grant can still be shown as admin", () => {
    const got = allowedRoles(row(), true, false);
    expect(
      got,
      `the control would render options ${JSON.stringify(got)} with value "admin", so the browser shows "${got[0]}"`,
    ).toContain("admin");
  });

  /**
   * ⚠️ THE GUARD ON THE GUARD. The case above passes trivially if the narrowing
   * was simply reverted, which is NOT the fix — 0053 refuses `admin` below a
   * root and the picker must go on saying so for a person who does not hold it.
   * A row with no grant here must still be offered only supervisor and viewer.
   */
  it("...while a row that holds nothing there is still offered neither admin", () => {
    expect(allowedRoles(row({ directRole: null }), true, false)).toEqual(["supervisor", "viewer"]);
    expect(allowedRoles(row({ directRole: "viewer" }), true, false)).toEqual([
      "supervisor",
      "viewer",
    ]);
  });

  /**
   * ⚠️ AND THE SAME PERSON AT A PLANT ROOT IS UNCHANGED, so a fix cannot pass
   * by widening everything back. A48 in `siteAccess.test.ts` says the same
   * thing; it is repeated here so this file fails for one reason at a time.
   */
  it("...and nothing about the plant-root answer moves", () => {
    expect(allowedRoles(row(), true, true)).toEqual(["admin", "supervisor", "viewer"]);
  });
});
