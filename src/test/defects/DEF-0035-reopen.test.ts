import { describe, expect, it } from "vitest";
import { canEditNode, type EditRights } from "@/features/admin/lib/editRights";

/**
 * DEF-0035 — REOPENED (tester, 21 Sept, session 183t). RED until the Absences create form offers a
 * line supervisor only the people set_absence would accept.
 *
 * The session-182 fix filters the Person list with
 *   `visiblePeople.filter((p) => canEdit(nodesById.get(p.homeNodeId ?? p.siteNodeId)?.path ?? null))`
 * (AbsencesPanel.tsx). `canEditNode` FAILS OPEN — a null path answers TRUE (by design, so controls are
 * never silently stripped). The developer's own pin, `DEF-0035.test.tsx`, MOCKS `useEditRights` with a
 * known result and so never exercises the fail-open path; it passes while the app is broken.
 *
 * Measured live as Ana (a Line 1 supervisor) on a fresh `supabase db reset`:
 *   adminPaths    = []
 *   writablePaths = ["plant_a.area_1.line_1"]
 *   operators + the nodes she can READ (reads scope up/at her grant, never sideways):
 *     Sam Patel    home cell_1  -> path plant_a.area_1.line_1.cell_1   app_can_edit_node = true
 *     Maria Lopez  home cell_2  -> path plant_a.area_1.line_1.cell_2   app_can_edit_node = true
 *     John Kim     home <other line>  -> NOT in nodesById -> path null  app_can_edit_node = false
 *     Lena Novak   home <other line>  -> NOT in nodesById -> path null  app_can_edit_node = false
 *     Priya Shah   home <other line>  -> NOT in nodesById -> path null  app_can_edit_node = false
 *     Tom Baker    home <other line>  -> NOT in nodesById -> path null  app_can_edit_node = false
 *
 * So the four off-line people resolve to a null path (their owning node is not one Ana may read), and
 * `canEditNode(null)` fails open, so the create form offers all six — exactly the four the server then
 * refuses PT403 ("you cannot record an absence for someone at that place"). This pin reproduces that
 * with the REAL `canEditNode`, no mock: it runs the same filter over the same data shape and asserts
 * the form offers only the people the server accepts. It stays RED while the client offers people it
 * cannot resolve a path for; it is not asking the developer to break fail-open, but to offer only the
 * people set_absence accepts (resolve the owning path for these people, or filter by the server's own
 * answer). See docs/defects/DEF-0035.md.
 */

const ANA_RIGHTS: EditRights = {
  role: "supervisor",
  adminPaths: [],
  writablePaths: ["plant_a.area_1.line_1"],
  known: true, // her grant DID land — the bug is not a pending read
};

// The operators Ana is shown, and the path her client can resolve for each from the nodes she may
// read. The four off-line people's owning node is absent (null), exactly as measured live.
const OFFERED_OPERATORS: ReadonlyArray<{
  name: string;
  resolvedPath: string | null;
  serverAccepts: boolean;
}> = [
  { name: "Sam Patel", resolvedPath: "plant_a.area_1.line_1.cell_1", serverAccepts: true },
  { name: "Maria Lopez", resolvedPath: "plant_a.area_1.line_1.cell_2", serverAccepts: true },
  { name: "John Kim", resolvedPath: null, serverAccepts: false },
  { name: "Lena Novak", resolvedPath: null, serverAccepts: false },
  { name: "Priya Shah", resolvedPath: null, serverAccepts: false },
  { name: "Tom Baker", resolvedPath: null, serverAccepts: false },
];

describe("DEF-0035 (reopened): the Absences form offers a supervisor only people set_absence accepts", () => {
  it("offers exactly the server-editable people — not the ones whose node the client cannot resolve", () => {
    // The SAME predicate AbsencesPanel's create form applies.
    const offered = OFFERED_OPERATORS.filter((p) => canEditNode(p.resolvedPath, ANA_RIGHTS)).map(
      (p) => p.name,
    );
    const serverAccepts = OFFERED_OPERATORS.filter((p) => p.serverAccepts).map((p) => p.name);
    // RED today: `offered` is all six (the four null-path people slip through fail-open), while the
    // server accepts only Sam Patel and Maria Lopez.
    expect(offered).toEqual(serverAccepts);
  });
});
