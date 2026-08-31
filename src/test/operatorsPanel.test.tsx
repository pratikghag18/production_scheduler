import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, within } from "@testing-library/react";
import { OperatorsPanel } from "@/features/admin/components/OperatorsPanel";
import { useAdminViewStore } from "@/features/admin/store/adminView";

/**
 * ⭐ THE SECOND SUITE IN THIS REPO THAT MOUNTS AN ADMIN PANEL, and it exists
 * because the two most recent changes to this screen are pinned by nothing at
 * the screen's own level. `operators.test.ts` covers the rules and
 * `plantFilter.test.ts` covers the cut; between "the library decides correctly"
 * and "a person sees the right thing" sits the whole of `OperatorsPanel.tsx` —
 * which is exactly the span §19.77's own audit did not measure while the screen
 * was ticking cells in plants nobody could be booked into.
 *
 * Two changes are under test here:
 *
 *   §19.77  "Where X can work" has THREE states, not two: ✓ can work here,
 *           ✕ missing the training, ⚠ outside their area. The third one is the
 *           defect — the old screen ticked a cell on trainings alone, and the
 *           server refuses it (`app_guard_assignment_scope`, 0028 / D109). The
 *           list is also trimmed to the selected person's OWN ROOT, with the
 *           trim counted, and the count line's denominator became their own
 *           area rather than every schedulable cell in the company.
 *
 *   §19.79  A shared plant filter the reader chooses once for the whole admin
 *           screen. It trims the people list, the ticket types and both
 *           "Belongs to" pickers — each counted — and de-stales `selectedId`,
 *           `draftSite` and `editSite`.
 *
 * ⚠️⚠️ THE CAUTIONARY TALE THIS FILE IS WRITTEN AGAINST is `productsPanel.test.tsx`,
 * which was green from the day it was written and passed through the WRONG
 * BRANCH for its entire life: its `useQuery` stand-in omitted `isSuccess`, so
 * every case ran the "we could not read the structure" path. Eight cases named
 * behaviour they never reached. **A stand-in that omits a field does not fail;
 * it silently picks a branch, and the suite then reports coverage it never
 * had.** So the mocks below stop at the NETWORK boundary and list, in a
 * comment, every field the panel actually reads off them. `operators.ts`,
 * `scope.ts`, `plantFilter.ts`, `usePlantFilter.ts` and `adminView.ts` all run
 * for real: mocking any of them would pin that the panel CALLS something, which
 * is the shape of assertion that passed while the screen was wrong.
 *
 * ⚠️ AND THE ASSERTIONS ARE ON WHAT A PERSON CAN PERCEIVE — the mark, the
 * sentence, the accessible name — never on a CSS class. `PlaceRow` picks a
 * class AND a mark from the same verdict, so asserting the class would pass on
 * a screen that showed the right colour with the wrong character in it.
 */

const h = vi.hoisted(() => {
  const id = {
    P1: "n-plant-1",
    LA: "n-line-a",
    CA1: "n-cell-a1",
    CA2: "n-cell-a2",
    LB: "n-line-b",
    CB1: "n-cell-b1",
    P2: "n-plant-2",
    LZ: "n-line-z",
    CZ1: "n-cell-z1",
    LX: "n-line-x",
    ANN: "op-ann",
    ZOE: "op-zoe",
    ORA: "op-ora",
    FORK: "sk-fork",
    WELD: "sk-weld",
    CRANE: "sk-crane",
  };

  const node = (
    nodeId: string,
    name: string,
    parentId: string | null,
    path: string,
    levelId: string,
    active = true,
  ) => ({ id: nodeId, name, parentId, levelId, path, sortOrder: 1, active });

  const operator = (
    opId: string,
    displayName: string,
    employeeRef: string | null,
    siteNodeId: string,
    active = true,
  ) => ({ id: opId, displayName, employeeRef, active, siteNodeId });

  // ⭐ ONLY THE BOTTOM LEVEL IS SCHEDULABLE, which is what makes a node a place
  // work can be booked into (`workPlacesFor` filters on exactly this). Plants
  // and lines are structure; the four cells are the only rows the places list
  // can ever contain, and that number is load-bearing for the count line below.
  const levels = () => [
    { id: "lv-plant", templateId: "tpl", position: 0, name: "Plant", isSchedulable: false },
    { id: "lv-line", templateId: "tpl", position: 1, name: "Line", isSchedulable: false },
    { id: "lv-cell", templateId: "tpl", position: 2, name: "Cell", isSchedulable: true },
  ];

  /**
   * Two plants, and Ann belongs to a LINE inside one of them — not to a root.
   *
   * ⭐ THE THREE MARKS FALL OUT OF THIS SHAPE WITH NOTHING ELSE ARRANGED:
   *
   *   Cell A1  in her line, requires Forklift, she holds it       → ✓
   *   Cell A2  in her line, requires Welding, she does not        → ✕
   *   Cell B1  same PLANT, different line, requires Forklift      → ⚠
   *   Cell Z1  another plant entirely, requires nothing           → trimmed
   *
   * ⚠️ CELL B1 REQUIRES A TICKET SHE HOLDS, DELIBERATELY. A ⚠ row whose
   * trainings were also missing would be indistinguishable from a ✕ that had
   * simply been recoloured — and "we ticked it because the trainings were fine"
   * is the §19.77 defect verbatim.
   *
   * ⚠️ CELL B1 IS UNDER HER OWN ROOT AND MUST STAY VISIBLE. `placesUnderSameRoot`
   * cuts at the ROOT, not at her area, because lending somebody one line over is
   * what D113's recorded-reason override exists for. Cutting at her area would
   * delete the third state from this screen altogether.
   */
  const baseNodes = () => [
    node(id.P1, "Plant 1", null, "plant_1", "lv-plant"),
    node(id.LA, "Line A", id.P1, "plant_1.line_a", "lv-line"),
    node(id.CA1, "Cell A1", id.LA, "plant_1.line_a.cell_a1", "lv-cell"),
    node(id.CA2, "Cell A2", id.LA, "plant_1.line_a.cell_a2", "lv-cell"),
    node(id.LB, "Line B", id.P1, "plant_1.line_b", "lv-line"),
    node(id.CB1, "Cell B1", id.LB, "plant_1.line_b.cell_b1", "lv-cell"),
    node(id.P2, "Plant 2", null, "plant_2", "lv-plant"),
    node(id.LZ, "Line Z", id.P2, "plant_2.line_z", "lv-line"),
    node(id.CZ1, "Cell Z1", id.LZ, "plant_2.line_z.cell_z1", "lv-cell"),
  ];

  const baseOperators = () => [
    operator(id.ANN, "Ann Adams", "A-1", id.LA),
    operator(id.ZOE, "Zoe Zhang", "Z-9", id.LZ),
  ];

  // Owned per 0028: every training belongs somewhere, and Crane belongs to the
  // other plant — which is what the ticket-types footnote counts.
  const baseSkills = () => [
    { id: id.FORK, name: "Forklift", siteNodeId: id.P1 },
    { id: id.WELD, name: "Welding", siteNodeId: id.P1 },
    { id: id.CRANE, name: "Crane", siteNodeId: id.P2 },
  ];

  const baseRequirements = () => [
    { nodeId: id.CA1, skillId: id.FORK },
    { nodeId: id.CA2, skillId: id.WELD },
    { nodeId: id.CB1, skillId: id.FORK },
  ];

  // ⚠️ NO EXPIRY ANYWHERE. `asOf` defaults to today, so a dated fixture would
  // make this suite's answers depend on the day it is run — and the lapse rules
  // already have their own cases in `operators.test.ts`.
  const baseOperatorSkills = () => [
    { operatorId: id.ANN, skillId: id.FORK, expiresAt: null as string | null },
  ];

  const baseData = () => ({
    operators: baseOperators(),
    skills: baseSkills(),
    operatorSkills: baseOperatorSkills(),
    requirements: baseRequirements(),
    nodes: baseNodes(),
    levels: levels(),
    // Read by the panel to warn about rows that did not parse. Absent, the
    // comparison is against `undefined` and quietly false — the omitted-field
    // failure this file's header is about, in miniature.
    skipped: 0,
  });

  return {
    id,
    node,
    operator,
    baseData,
    createMutate: vi.fn(),
    updateMutate: vi.fn(),
    state: {
      profile: {
        id: "u1",
        orgId: "10000000-0000-0000-0000-000000000001",
        userId: "u1",
        role: "admin",
        defaultCreateMode: "run",
        adminAnywhere: true,
      },
      data: baseData(),
    },
  };
});

const id = h.id;

vi.mock("@/features/auth/useSession", () => ({
  useSession: () => ({
    session: { user: { id: h.state.profile.userId } },
    profile: h.state.profile,
    loading: false,
  }),
}));

vi.mock("@/lib/api", () => ({
  describeSchedulerError: (e: unknown) => String(e),
}));

/**
 * ⚠️ THE ONE MOCK THAT COULD SILENTLY PICK A BRANCH, so every field it returns
 * is here because the panel reads it, and none is here for decoration:
 *
 *   `data`       every list on the screen, plus `data === undefined` → the
 *                "couldn't be loaded" pane.
 *   `isLoading`  folded with `!canQuery` into `loading` (D91: `enabled: false`
 *                leaves `isLoading` FALSE, so gating on it alone renders an
 *                empty company as though it were the answer).
 *   `isError`    the same pane.
 *   `isPending`  on EVERY mutation — they are or'd into `busy`, which disables
 *                Add, Save, Attach and Remove. Omit it and `busy` is `undefined`,
 *                every control stays live, and the cases that click them pass
 *                for a reason that has nothing to do with what they claim.
 */
vi.mock("@/features/admin/hooks/useOperators", () => ({
  useOperatorsAdmin: () => ({
    data: h.state.data,
    isLoading: false,
    isError: false,
    error: null,
  }),
  useCreateOperator: () => ({ mutate: h.createMutate, isPending: false }),
  useUpdateOperator: () => ({ mutate: h.updateMutate, isPending: false }),
  useSetOperatorActive: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateSkill: () => ({ mutate: vi.fn(), isPending: false }),
  useRenameSkill: () => ({ mutate: vi.fn(), isPending: false }),
  useGrantSkill: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateSkillExpiry: () => ({ mutate: vi.fn(), isPending: false }),
  useRevokeSkill: () => ({ mutate: vi.fn(), isPending: false }),
}));

/**
 * ⚠️ NOT OPTIONAL, and for the reason `productsPanel.test.tsx` records: the
 * panel imports `DeleteDialog`, which imports `useDeletion`, which imports
 * `useMutation`/`useQueryClient` and `previewDeletion`/`deleteOwnedRow` from
 * `@/lib/api` — and a `vi.mock` factory is a CLOSED object, so importing a name
 * it does not define throws while the module graph is being built and the whole
 * FILE fails to load rather than any case failing. Cutting the chain at its
 * head keeps the `@/lib/api` factory above down to the one name this screen
 * genuinely uses.
 */
vi.mock("@/features/admin/hooks/useDeletion", () => ({
  useDeletionPreview: () => ({ data: undefined, isPending: true, isError: false, error: null }),
  useDeleteOwnedRow: () => ({ mutate: vi.fn(), isPending: false }),
}));

/* ===========================================================================
 * Finding things the way a reader finds them.
 * =========================================================================== */

/** The left-hand column: the people list, the Add card and the ticket types. */
function aside(): HTMLElement {
  return screen.getByRole("complementary");
}

/**
 * One place's row, found by the place's own name.
 *
 * The label is the whole chain — `"Plant 1 › Line A › Cell A1"` — because two
 * lines in one company really can both have a "Cell 1", and that is what
 * `labelFor` builds it for.
 */
function placeRow(label: string): HTMLElement {
  const li = screen.getByText(label).closest("li");
  if (li === null) throw new Error(`no place row labelled ${label}`);
  return li;
}

/**
 * The count line above the places, whitespace-normalised.
 *
 * ⚠️ READ AS ONE SENTENCE, not as three assertions about three numbers. The
 * defect it pins was a line whose halves each came from a different population
 * — a numerator counting trainings alone over a denominator counting every cell
 * in the company — and each half was individually defensible.
 */
function countLine(): string {
  const p = screen.getByText(/in their own area/);
  return (p.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** The Add card's "Belongs to". */
function belongsToInAdd(): HTMLSelectElement {
  return within(aside()).getByRole("combobox", { name: "Belongs to" }) as HTMLSelectElement;
}

function optionLabels(select: HTMLSelectElement): string[] {
  return [...select.options].map((o) => o.text);
}

/**
 * The detail pane's owner picker — the one on the open edit form.
 *
 * ⭐⭐ IT CAN BE ASKED FOR BY NAME, AND IT COULD NOT BE WHEN THIS SUITE WAS
 * WRITTEN. The edit form's three controls were named "Name", "Employee
 * reference" and "Belongs to" — the same three names the Add card carries, both
 * on screen at once. This helper used to fetch every combobox called "Belongs
 * to" and subtract the ones inside the roster, and its comment recorded that as
 * a FINDING rather than a test inconvenience: `within(...)` disambiguates for a
 * sighted reader and for a test, and does nothing at all for the person who
 * needs the accessible name. D106, and `productsPanel.test.tsx`'s T8 pins the
 * same collision on the other screen.
 *
 * The panel now names them for the person (`Where Ann Adams belongs`), so this
 * is a plain query — and it TAKES THE PERSON, which is the whole point: a name
 * that did not vary per person would leave the collision exactly where it was.
 * ⚠️ Keep it a query BY NAME. Reaching for the element any other way — by
 * position, or by subtracting the roster — would let the collision come back
 * with no case going red, which is how it survived this long.
 */
function belongsToInDetail(who: string): HTMLSelectElement {
  return screen.getByRole("combobox", { name: `Where ${who} belongs` }) as HTMLSelectElement;
}

/** Pick somebody, the way the list is clicked. */
function pick(name: string) {
  fireEvent.click(within(aside()).getByRole("button", { name: new RegExp(name) }));
}

/** Choose a plant the way `AdminPage`'s one control does, and re-render on it. */
function showPlant(choice: string | null) {
  act(() => useAdminViewStore.setState({ plantChoice: choice }));
}

/**
 * A world with ONE readable root — most people's world: a plant admin, or a
 * supervisor granted a single line.
 *
 * ⚠️ IT CARRIES AN ORPHAN, AND WITHOUT IT DECISION 2 IS UNOBSERVABLE HERE.
 * `resolvePlantChoice` collapses a remembered id to "All plants" when there is
 * only one root — but in a tree where every node hangs off that root, choosing
 * the root and choosing everything select exactly the same set, so a panel that
 * skipped the collapse would look identical. `Line X` is a node whose PARENT is
 * unreadable: `scope.ts` lists it at the depth its own path implies, and its
 * path is not under `plant_1`, so it is the one row that can tell a collapsed
 * choice from an applied one.
 */
function withOnePlant() {
  h.state.data = {
    ...h.baseData(),
    nodes: [
      h.node(id.P1, "Plant 1", null, "plant_1", "lv-plant"),
      h.node(id.LA, "Line A", id.P1, "plant_1.line_a", "lv-line"),
      h.node(id.CA1, "Cell A1", id.LA, "plant_1.line_a.cell_a1", "lv-cell"),
      h.node(id.CA2, "Cell A2", id.LA, "plant_1.line_a.cell_a2", "lv-cell"),
      h.node(id.LX, "Line X", "n-unreadable", "plant_9.line_x", "lv-line"),
    ],
    operators: [h.operator(id.ANN, "Ann Adams", "A-1", id.LA)],
  };
}

beforeEach(() => {
  h.createMutate.mockClear();
  h.updateMutate.mockClear();
  // ⚠️ FACTORIES, NOT A SHARED LITERAL. Several cases below mutate the fixture
  // in place — revoking Ann's ticket, adding an orphaned person — and a shared
  // object would leave every later case running against a world shaped by its
  // predecessors, which is the failure `productsPanel.test.tsx` had to fix once
  // its own fixtures grew a second plant.
  h.state.data = h.baseData();
  // ⚠️ THE STORE IS A MODULE SINGLETON AND OUTLIVES A RENDER. Left set, one
  // case's chosen plant filters the next case's people — the cross-section leak
  // this feature exists to make visible, arriving inside the test file.
  useAdminViewStore.setState({ plantChoice: null, hydratedOrgId: null });
});

/* ===========================================================================
 * §19.77 — the three states.
 * =========================================================================== */

describe("OperatorsPanel — where somebody can work has THREE answers (§19.77)", () => {
  it("O1: a place in their own area whose trainings they hold reads ✓ and says so", () => {
    render(<OperatorsPanel />);
    pick("Ann Adams");
    const row = placeRow("Plant 1 › Line A › Cell A1");
    expect(within(row).getByText("✓")).toBeTruthy();
    // ⚠️ THE MARK IS `aria-hidden` AND CARRIES NO MEANING ON ITS OWN (D100:
    // colour is never the only signal). The tick's meaning is spoken by this
    // visually-hidden sentence, so a ✓ without it is half a row.
    expect(within(row).getByText("can work here")).toBeTruthy();
  });

  it("O2: a place in their own area they are not trained for reads ✕ and names the training", () => {
    render(<OperatorsPanel />);
    pick("Ann Adams");
    const row = placeRow("Plant 1 › Line A › Cell A2");
    expect(within(row).getByText("✕")).toBeTruthy();
    // Named, not merely refused. "Not eligible" is a fact the reader can do
    // nothing with; "missing Welding" is one click from being fixed, and the
    // Tickets section below is where that click lives.
    expect(within(row).getByText("missing Welding")).toBeTruthy();
    expect(within(row).queryByText("can work here")).toBeNull();
  });

  it("O3 ⭐⭐ a place outside their area reads ⚠ and asks for a reason — even holding every ticket", () => {
    // ⚠️ THIS IS THE §19.77 DEFECT ITSELF. Cell B1 requires Forklift and Ann
    // holds Forklift, so on trainings alone this row is a clean yes — and the
    // old screen ticked it. The server does not: `app_guard_assignment_scope`
    // (0028 / D109) refuses an assignment outside the area somebody belongs to,
    // and D113 lets a supervisor through only by RECORDING A REASON. A tick
    // here is the screen saying yes where the server says no.
    render(<OperatorsPanel />);
    pick("Ann Adams");
    const row = placeRow("Plant 1 › Line B › Cell B1");
    expect(within(row).getByText("⚠")).toBeTruthy();
    expect(within(row).getByText("not from this area — needs a recorded reason")).toBeTruthy();
    expect(within(row).queryByText("✓")).toBeNull();
    expect(within(row).queryByText("can work here")).toBeNull();
    // And the row must not have arrived at ⚠ by way of a training failure — if
    // it had, this case would be O2 wearing a different mark.
    expect(within(row).queryByText(/missing/)).toBeNull();
  });

  it("O4: the list stops at their own root, and says how many places it dropped", () => {
    // The maintainer, 31 Aug, having seen the three states: *"I see all plants
    // not just Plant A for him… those locations should not be visible at all is
    // my point."* Annotating another plant's cells was not enough — a system
    // admin reads every node in the org, so the list was every cell in the
    // company. Cell Z1 is another root's; Cell B1 is the same root's and stays.
    render(<OperatorsPanel />);
    pick("Ann Adams");
    expect(screen.queryByText("Plant 2 › Line Z › Cell Z1")).toBeNull();
    expect(screen.queryByText("Plant 1 › Line B › Cell B1")).not.toBeNull();
    // ⚠️ COUNTED, NOT SILENT, and named by the ROOT rather than by a level word:
    // "plant" is this company's name for its top level and another company's
    // hierarchy may call it anything at all.
    expect(screen.getByText("1 place outside Plant 1 is not shown.")).toBeTruthy();
  });
});

/* ===========================================================================
 * §19.77 — the count line.
 * =========================================================================== */

describe("OperatorsPanel — the count line names what it counts (§19.77)", () => {
  it("O5: the denominator is their OWN AREA, and elsewhere is counted apart", () => {
    // There are FOUR schedulable cells in this fixture and Ann's trainings
    // satisfy three of them (A1, B1, Z1). The line that shipped read "3 of 4":
    // a numerator counting trainings alone over a denominator counting every
    // cell in the company. Two of those four are in her own area.
    render(<OperatorsPanel />);
    pick("Ann Adams");
    expect(countLine()).toBe(
      "1 of 2 places in their own area · 1 elsewhere, only with a recorded reason",
    );
    expect(countLine()).not.toContain(" of 4");
  });

  it("O6 ⭐⭐ the maintainer's own case: two cells, both refusals, reads '0 of 2'", () => {
    // *"12 of 18 places"* for somebody whose own line holds two, where the
    // eighteen were three plants' worth of cells and all twelve ticks were
    // refusals. Revoking Ann's only ticket reproduces it in miniature: both
    // cells in her line now refuse, and the honest sentence is "0 of 2".
    h.state.data.operatorSkills = [];
    render(<OperatorsPanel />);
    pick("Ann Adams");
    expect(countLine()).toBe(
      "0 of 2 places in their own area · 1 elsewhere, only with a recorded reason",
    );
    // The old shape would have read "1 of 4" — Cell Z1 needs no ticket at all.
    expect(countLine()).not.toContain(" of 4");
    // And the denominator is a real claim about two visible rows, not a number
    // the reader has no way to reconcile with the list under it.
    expect(
      within(placeRow("Plant 1 › Line A › Cell A1")).getByText("missing Forklift"),
    ).toBeTruthy();
    expect(
      within(placeRow("Plant 1 › Line A › Cell A2")).getByText("missing Welding"),
    ).toBeTruthy();
  });
});

/* ===========================================================================
 * §19.79 — the shared plant filter, on this panel.
 * =========================================================================== */

describe("OperatorsPanel — the plant filter (§19.79 / roadmap 1(c))", () => {
  it("O7: the people list is cut to the chosen plant, and the cut is counted", () => {
    render(<OperatorsPanel />);
    // All plants first, so the case cannot pass against a panel that simply
    // never listed Zoe.
    expect(within(aside()).queryByRole("button", { name: /Zoe Zhang/ })).not.toBeNull();
    showPlant(id.P1);
    expect(within(aside()).queryByRole("button", { name: /Zoe Zhang/ })).toBeNull();
    expect(within(aside()).queryByRole("button", { name: /Ann Adams/ })).not.toBeNull();
    // ⚠️ The footnote also rescues "Nobody matches that.", which would otherwise
    // blame the search box for a cut the search box did not make.
    expect(screen.getByText("1 person outside Plant 1 is not shown.")).toBeTruthy();
  });

  it("O8: the ticket types are cut the same way, and counted", () => {
    render(<OperatorsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Ticket types" }));
    expect(within(aside()).queryByText("Crane")).not.toBeNull();
    showPlant(id.P1);
    expect(within(aside()).queryByText("Crane")).toBeNull();
    expect(within(aside()).queryByText("Forklift")).not.toBeNull();
    // ⚠️ This list carries a Delete that CASCADES under 0029 — it un-qualifies
    // everyone holding the ticket and drops it from every cell requiring it. "It
    // isn't there" and "you can't see it from here" are answers a reader must
    // not be left to confuse on a list like that.
    expect(screen.getByText("1 ticket type outside Plant 1 is not shown.")).toBeTruthy();
  });

  it("O9: the Add card's 'Belongs to' offers only the chosen plant's subtree", () => {
    // Decision 3 — what you see is what you can create in. The alternative lets
    // somebody add a person into a plant they have filtered away and then watch
    // them not appear, which is silent hiding wearing a form's clothes.
    render(<OperatorsPanel />);
    showPlant(id.P2);
    const add = belongsToInAdd();
    // `indentedLabel` pads a child with two U+2007 figure spaces per level.
    expect(optionLabels(add)).toEqual(["Plant 2", "  Line Z", "    Cell Z1"]);
    // And the VALUE follows rather than pointing at a node the list no longer
    // carries — a `<select>` handed a value none of its options holds renders
    // its first option and reports nothing.
    expect(add.value).toBe(id.P2);
  });

  it("O10: the detail form's 'Belongs to' narrows too", () => {
    render(<OperatorsPanel />);
    showPlant(id.P2);
    pick("Zoe Zhang");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(optionLabels(belongsToInDetail("Zoe Zhang"))).toEqual([
      "Plant 2",
      "  Line Z",
      "    Cell Z1",
    ]);
  });

  it("O11: 'All plants' hides nothing, and says nothing", () => {
    render(<OperatorsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Ticket types" }));
    expect(within(aside()).queryByRole("button", { name: /Ann Adams/ })).not.toBeNull();
    expect(within(aside()).queryByRole("button", { name: /Zoe Zhang/ })).not.toBeNull();
    expect(within(aside()).queryByText("Crane")).not.toBeNull();
    expect(optionLabels(belongsToInAdd())).toHaveLength(9);
    // ⚠️ AND NO FOOTNOTE. A count of nothing is not a harmless zero: it tells a
    // reader on "All plants" that something is being kept from them.
    expect(within(aside()).queryByText(/is not shown\.|are not shown\./)).toBeNull();
  });

  it("O12: one readable root makes the filter a no-op, whatever is remembered", () => {
    // Decision 2, from this panel's side. `resolvePlantChoice` collapses a
    // stored id to "All plants" when there is nothing to choose, so nobody is
    // left filtered by a control `AdminPage` does not even render. See
    // `withOnePlant` for why the orphan is the only thing that can see it.
    withOnePlant();
    showPlant(id.P1);
    render(<OperatorsPanel />);
    expect(optionLabels(belongsToInAdd())).toContain("  Line X");
    expect(within(aside()).queryByRole("button", { name: /Ann Adams/ })).not.toBeNull();
    expect(within(aside()).queryByText(/is not shown\./)).toBeNull();
  });
});

/* ===========================================================================
 * §19.79 — the de-staling. These were the real bugs.
 * =========================================================================== */

describe("OperatorsPanel — the filter de-stales what it narrowed past (§19.79)", () => {
  it("O13 ⭐⭐ narrowing to a plant somebody is not in closes their detail pane", () => {
    // A selection outliving the list it was made from: Zoe read on the right
    // while the list on the left held only Plant 1. `selectedId` is a bare
    // string and survives anything, so the resolution has to be re-run against
    // the people the screen is actually showing.
    render(<OperatorsPanel />);
    pick("Zoe Zhang");
    expect(screen.getByRole("heading", { name: "Zoe Zhang" })).toBeTruthy();
    showPlant(id.P1);
    expect(screen.queryByRole("heading", { name: "Zoe Zhang" })).toBeNull();
    expect(screen.getByText("Pick someone on the left to see where they can work.")).toBeTruthy();
  });

  it("O14: the SEARCH box does not close it — the two narrowings are not the same kind", () => {
    // ⚠️ THE OTHER HALF OF O13, AND THE REASON THE SELECTION RESOLVES AGAINST
    // THE PLANT RATHER THAN AGAINST THE RENDERED ROWS. Typing in "Find someone"
    // narrows the LIST; it does not say the person being read is gone. Resolving
    // against `rows` would close the detail pane on the first keystroke.
    render(<OperatorsPanel />);
    pick("Ann Adams");
    fireEvent.change(screen.getByRole("searchbox", { name: "Find someone" }), {
      target: { value: "Zoe" },
    });
    expect(within(aside()).queryByRole("button", { name: /Ann Adams/ })).toBeNull();
    expect(screen.getByRole("heading", { name: "Ann Adams" })).toBeTruthy();
  });

  it("O15 ⭐ from a cold load the Add card submits the plant it is SHOWING, never ''", () => {
    // ⚠️ THIS SHIPPED as `site_node_id: ""` on Add, against a NOT NULL column.
    // `draftSite` starts `""` and nobody has to touch the picker, so the form
    // submitted nothing while the control read "Plant 1".
    //
    // ⚠️⚠️ AND THE CONTROL IS NOT WHERE THE DEFECT IS VISIBLE — WHICH IS THE
    // WHOLE REASON IT SHIPPED. A `<select>` whose value matches none of its
    // options has no selected option, and the DOM then reports its FIRST one
    // anyway: `belongsToInAdd().value` reads "Plant 1" whether the binding is
    // `draftSiteValue` or the raw `draftSite`. Verified by breaking the binding
    // — the reading below does not move. So the assertion that carries this
    // case is the PAYLOAD, tied to what the control is showing: the two being
    // the same value is the entire property, and only one of them can lie.
    render(<OperatorsPanel />);
    const showing = belongsToInAdd().value;
    expect(showing).toBe(id.P1);
    fireEvent.change(within(aside()).getByRole("textbox", { name: "Name" }), {
      target: { value: "New Person" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(h.createMutate).toHaveBeenCalledTimes(1);
    const sent = h.createMutate.mock.calls[0][0] as { displayName: string; siteNodeId: string };
    expect(sent.displayName).toBe("New Person");
    expect(sent.siteNodeId).toBe(showing);
    expect(sent.siteNodeId).not.toBe("");
  });

  it("O16: the detail picker opens on where they belong NOW, not on the first node", () => {
    // Ann belongs to a LINE (D109: an area need not be a root), so a picker
    // that ignored the person and opened on its own first option would read
    // "Plant 1" — and where somebody belongs decides where they can be booked.
    render(<OperatorsPanel />);
    pick("Ann Adams");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(belongsToInDetail("Ann Adams").value).toBe(id.LA);
  });

  it("O17 ⭐ an area the picker cannot offer shows 'Choose…' and Save REFUSES to move them", () => {
    // ⚠️ THE EDIT FORM FALLS BACK TO NOTHING, NEVER TO THE FIRST NODE. On the
    // Add card a default is a convenience; here it would silently MOVE somebody
    // to wherever the list happens to begin. Ora's area is a node this reader
    // cannot resolve — `rowsInPlant` fails open and still lists her (`scope.ts`:
    // "I cannot tell" must not become "hidden"), so the form really can be
    // opened on an area the picker does not carry.
    h.state.data.operators = [
      ...h.state.data.operators,
      h.operator(id.ORA, "Ora Orphan", "O-7", "n-gone"),
    ];
    render(<OperatorsPanel />);
    pick("Ora Orphan");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const picker = belongsToInDetail("Ora Orphan");
    expect(picker.value).toBe("");
    expect(optionLabels(picker)[0]).toBe("Choose where they belong…");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    // ⚠️ REFUSED, NOT SENT. `""` is not `null` and is not `undefined`: an absent
    // key means "leave it alone" and the screen would show a move that never
    // happened, and `""` against a NOT NULL column is a guaranteed round trip to
    // a database error.
    expect(h.updateMutate).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("Choose where this person belongs.");
  });
});
