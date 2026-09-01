import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, within } from "@testing-library/react";
import { TrainingsPanel, TRAININGS_PANEL_READY } from "@/features/admin/components/TrainingsPanel";
import { useAdminViewStore } from "@/features/admin/store/adminView";
import { notManagedNote } from "@/features/admin/lib/editRights";

/**
 * The Trainings section, asked the questions only a rendered screen can answer
 * (roadmap stage 22). `src/test/trainings.test.ts` covers the pure module; this
 * file covers what the pure module cannot see.
 *
 * ⭐ IT ASKS THE USER'S QUESTION, NOT THE MODULE'S — the same instrument
 * `productsPanel.test.tsx` records: controls are found BY ACCESSIBLE NAME, the
 * way a person looks for them. That is stricter than an attribute selector, and
 * on this screen it is load-bearing rather than stylistic: since migration 0031
 * two trainings may share a name, so `getByRole("button", { name: "Retire" })`
 * against a real company throws on ambiguity — which is exactly what a
 * screen-reader user hits.
 *
 * ⚠️ THE PLANT FILTER CASES DRIVE THE REAL STORE, not a mock of it.
 * `usePlantFilter`, `plantFilter.ts` and `adminView.ts` are under test as much
 * as the panel is; mocking the hook would pin that the panel calls something,
 * which is the shape of assertion §19.77's own audit passed while the screen
 * was broken. `../lib/trainings`, `../lib/operators`, `../lib/scope` and
 * `../lib/deletion` are the REAL modules, because they are what the panel
 * renders.
 *
 * THE FIXTURE — one plant, and the pair that only 0031 makes possible:
 *
 *   Forklift   Line A   live      <- two rows, one name, two owners: LEGAL
 *   Forklift   Line B   live
 *   Welding    Line A   RETIRED
 *
 * ⭐⭐ AND THE EDIT-RIGHTS CASES DRIVE THE **REAL** PREDICATE. Only the fetch is
 * mocked out: `h.state.rights` is handed to the real `canEditNode`, so T24-T28
 * are asking `../lib/editRights.ts` the same question the screen asks it. A mock
 * that returned a canned boolean would pin that the panel calls something —
 * which is the shape of assertion §19.77's own audit passed while the screen was
 * broken.
 */

const PLANT1 = "30000000-0000-0000-0000-000000000001";
const PLANT2 = "30000000-0000-0000-0000-000000000002";
const LINE_A = "40000000-0000-0000-0000-00000000000a";
const LINE_B = "40000000-0000-0000-0000-00000000000b";
const LINE_9 = "40000000-0000-0000-0000-000000000009";
const ORG = "10000000-0000-0000-0000-000000000001";

const h = vi.hoisted(() => {
  const P1 = "30000000-0000-0000-0000-000000000001";
  const A = "40000000-0000-0000-0000-00000000000a";
  const B = "40000000-0000-0000-0000-00000000000b";
  const node = (id: string, name: string, parentId: string | null, path: string) => ({
    id,
    name,
    parentId,
    levelId: "L",
    path,
    sortOrder: 1,
    active: true,
  });
  const skill = (id: string, name: string, siteNodeId: string, active = true) => ({
    id,
    name,
    siteNodeId,
    active,
  });
  // ⭐ FACTORIES, NOT LITERALS, AND `beforeEach` RESTORES FROM THEM — the call
  // `productsPanel.test.tsx` records after three cases mutated a shared fixture
  // in place and nothing put it back. The two-plant cases below add a whole
  // second plant, which the cases above must not see.
  const baseNodes = () => [
    node(P1, "Plant 1", null, "plant_1"),
    node(A, "Line A", P1, "plant_1.line_a"),
    node(B, "Line B", P1, "plant_1.line_b"),
  ];
  const baseSkills = () => [
    skill("s1", "Forklift", A),
    skill("s2", "Forklift", B),
    skill("s3", "Welding", A, false),
  ];
  // The move fixture (D105). ⚠️ NOT in the base state — holders would give
  // every case above something to warn about.
  const operator = (id: string, displayName: string, siteNodeId: string) => ({
    id,
    displayName,
    employeeRef: null,
    active: true,
    siteNodeId,
    source: "manual",
    externalId: null,
  });
  const held = (operatorId: string, skillId: string) => ({
    operatorId,
    skillId,
    expiresAt: null,
    certifiedAt: null,
    signedOffBy: null,
  });
  const req = (nodeId: string, skillId: string) => ({ nodeId, skillId });
  return {
    createMutate: vi.fn(),
    updateMutate: vi.fn(),
    activeMutate: vi.fn(),
    deleteMutate: vi.fn(),
    node,
    skill,
    operator,
    held,
    req,
    baseNodes,
    baseSkills,
    state: {
      sessionLoading: false,
      // ⭐ A COMPANY ADMIN BY DEFAULT, so arm (1) carries every case above and
      // none of them has to know this preview exists. Each edit-rights case
      // narrows it to exactly the person it is about.
      rights: {
        role: "admin",
        adminPaths: [] as readonly string[],
        writablePaths: [] as readonly string[],
        known: true,
      },
      profile: {
        id: "u1",
        orgId: "10000000-0000-0000-0000-000000000001",
        userId: "u1",
        role: "admin",
        defaultCreateMode: "run",
        adminAnywhere: true,
      },
      data: {
        // ⚠️ TYPED THROUGH THE FACTORIES rather than left as `never[]`. A bare
        // `[]` in a `vi.hoisted` literal infers `never[]`, and the move cases
        // below could then not put a person in it without a cast — which is how
        // a fixture ends up asserting against a shape the panel never sees.
        operators: [] as ReturnType<typeof operator>[],
        skills: baseSkills(),
        operatorSkills: [] as ReturnType<typeof held>[],
        requirements: [] as ReturnType<typeof req>[],
        nodes: baseNodes(),
        levels: [],
        skipped: 0,
      },
      isLoading: false,
      isError: false,
      error: null as unknown,
    },
  };
});

vi.mock("@/lib/api", () => ({
  describeSchedulerError: (e: unknown) => String(e),
}));
vi.mock("@/features/auth/useSession", () => ({
  useSession: () => ({
    session: { user: { id: h.state.profile.userId } },
    profile: h.state.profile,
    loading: h.state.sessionLoading,
  }),
}));
vi.mock("@/features/admin/hooks/useOperators", () => ({
  useOperatorsAdmin: () => ({
    data: h.state.data,
    isLoading: h.state.isLoading,
    isError: h.state.isError,
    error: h.state.error,
  }),
  useCreateSkill: () => ({ mutate: h.createMutate, isPending: false }),
  useUpdateSkill: () => ({ mutate: h.updateMutate, isPending: false }),
  useSetSkillActive: () => ({ mutate: h.activeMutate, isPending: false }),
}));

/**
 * ⚠️ MOCKING THIS IS NOT OPTIONAL, and the reason is the one 0029 left in
 * `productsPanel.test.tsx`. `TrainingsPanel` imports `DeleteDialog`, which
 * imports `useDeletion`, which imports React Query and `previewDeletion` /
 * `deleteOwnedRow` from `@/lib/api` — and a `vi.mock` factory is a CLOSED
 * object, so importing a name it does not define throws while the module graph
 * is built and the whole FILE fails to load rather than any case failing.
 * Mocking `useDeletion` cuts the chain at its head.
 *
 * ⭐ `isPending: true` KEEPS THE DIALOG IN ITS "still asking the server" STATE,
 * which is the state T15 asserts on: both destructive buttons stay disabled
 * until the counts land.
 */
/**
 * ⭐⭐ THE FETCH IS MOCKED; THE RULE IS NOT. `useEditRights` imports
 * `@/lib/supabase` and React Query, neither of which belongs in a render test —
 * but the thing worth asserting is `canEditNode`, so the mock delegates to the
 * REAL one and only the two RPC calls disappear.
 *
 * ⚠️ THE FACTORY IS ASYNC AND IMPORTS INSIDE ITSELF. `vi.mock` is hoisted above
 * every `import` in this file, so reaching for a top-level binding from the
 * factory body is a temporal-dead-zone error; `h` is safe because it comes from
 * `vi.hoisted`.
 */
vi.mock("@/features/admin/hooks/useEditRights", async () => {
  const { canEditNode } = await import("@/features/admin/lib/editRights");
  return {
    useEditRights: () => ({
      rights: h.state.rights,
      canEdit: (path: string | null) => canEditNode(path, h.state.rights),
    }),
  };
});

vi.mock("@/features/admin/hooks/useDeletion", () => ({
  useDeletionPreview: () => ({ data: undefined, isPending: true, isError: false, error: null }),
  useDeleteOwnedRow: () => ({ mutate: h.deleteMutate, isPending: false }),
}));

/** The two-plant world the filter exists for. ⚠️ NOT in the base fixture: */
/*  `readablePlants` counts roots, so a second root would give every case above
    a live plant control and a fourth row. */
function withTwoPlants() {
  h.state.data = {
    ...h.state.data,
    nodes: [
      ...h.baseNodes(),
      h.node(PLANT2, "Plant 2", null, "plant_2"),
      h.node(LINE_9, "Line 9", PLANT2, "plant_2.line_9"),
    ],
    skills: [...h.baseSkills(), h.skill("s4", "Rigging", PLANT2)],
  };
}

/**
 * The V14 world: a training owned by the PLANT, which read-scoping shows to
 * somebody whose grant is one line and write-scoping refuses them.
 *
 * ⚠️ NOT in the base fixture — it would give every case above a fourth row.
 */
function withPlantOwnedTraining() {
  h.state.data = {
    ...h.state.data,
    skills: [...h.baseSkills(), h.skill("s5", "Housekeeping", PLANT1)],
  };
}

/**
 * The world the move preview is about (D105).
 *
 * ⭐⭐ "Forklift at Line A" (s1) is held by TWO people who sit on different
 * branches, and that pair is the whole fixture:
 *
 *   Ana  owned by Line A   -> moving the training to Line B STRANDS her
 *   Bo   owned by Line B   -> moving it to Line B leaves her comparable
 *
 * A fixture with only Ana would pass with the comparability test replaced by
 * "warn about everybody", which is the assertion this has to be able to fail.
 */
function withHolders() {
  h.state.data = {
    ...h.state.data,
    operators: [h.operator("o1", "Ana", LINE_A), h.operator("o2", "Bo", LINE_B)],
    operatorSkills: [h.held("o1", "s1"), h.held("o2", "s1")],
  };
}

/** Line A requires the Forklift training — the half the SERVER refuses over. */
function withRequirement() {
  h.state.data = { ...h.state.data, requirements: [h.req(LINE_A, "s1")] };
}

/** The picker inside an open edit row, as a person would look for it. */
function editOwnerPicker(handle: string): HTMLSelectElement {
  return screen.getByRole("combobox", { name: `Where ${handle} belongs` }) as HTMLSelectElement;
}

/** Open Edit on a row and hand back its owner picker. */
function openEdit(handle: string): HTMLSelectElement {
  fireEvent.click(screen.getByRole("button", { name: `Edit ${handle}` }));
  return editOwnerPicker(handle);
}

/** Choose a plant the way the header control on `AdminPage` does. */
function showPlant(choice: string | null) {
  act(() => useAdminViewStore.setState({ plantChoice: choice }));
}

function ownerPicker(): HTMLSelectElement {
  return screen.getByRole("combobox", { name: "Belongs to" }) as HTMLSelectElement;
}
function nameBox(): HTMLInputElement {
  return screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
}
function addButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Add" }) as HTMLButtonElement;
}
/** Type a draft into the Add card. */
function draft(name: string, owner: string) {
  fireEvent.change(ownerPicker(), { target: { value: owner } });
  fireEvent.change(nameBox(), { target: { value: name } });
}
/** The `<li>` a row's controls live in, found through one of them. */
function rowFor(handle: string): HTMLElement {
  const li = screen.getByRole("button", { name: `Edit ${handle}` }).closest("li");
  if (li === null) throw new Error("the row's controls are not inside a row");
  return li;
}
/** The list under a heading, so "In use" and "Retired" can be told apart. */
function sectionAfter(heading: string): HTMLElement {
  const h3 = screen.getByRole("heading", { name: heading });
  const next = h3.nextElementSibling;
  if (next === null) throw new Error(`nothing follows the "${heading}" heading`);
  return next as HTMLElement;
}

beforeEach(() => {
  h.createMutate.mockClear();
  h.updateMutate.mockClear();
  h.activeMutate.mockClear();
  h.deleteMutate.mockClear();
  h.state.sessionLoading = false;
  h.state.isLoading = false;
  h.state.isError = false;
  h.state.rights = { role: "admin", adminPaths: [], writablePaths: [], known: true };
  h.state.data = {
    operators: [],
    skills: h.baseSkills(),
    operatorSkills: [],
    requirements: [],
    nodes: h.baseNodes(),
    levels: [],
    skipped: 0,
  };
  // ⚠️ THE STORE IS A MODULE SINGLETON AND OUTLIVES A RENDER. Left set, one
  // case's chosen plant filters the next case's list — the cross-section leak
  // this feature exists to make visible, arriving in the test file.
  useAdminViewStore.setState({ plantChoice: null, hydratedOrgId: null });
});

/* ===========================================================================
 * The section exists, and it is about trainings.
 * ======================================================================== */

describe("TrainingsPanel — a section of its own (stage 22)", () => {
  it("T1: the panel declares itself ready, which is what turns the rail entry on", () => {
    // ⭐ The flag lives in the panel, not in `AdminPage`, so a section cannot be
    // switched on without a panel behind it — `PRODUCTS_PANEL_READY`'s shape.
    expect(TRAININGS_PANEL_READY).toBe(true);
  });

  it("T2: every training is listed with the place that OWNS it", () => {
    render(<TrainingsPanel />);
    const inUse = sectionAfter("In use");
    expect(within(inUse).getAllByText("Forklift")).toHaveLength(2);
    // ⭐ THE OWNER IS A SEPARATE ELEMENT, never appended to the name. Since 0031
    // it is the only thing telling these two rows apart, and concatenating
    // would put it inside the text a reader searches — the `A-Welding` mistake
    // one layer up.
    expect(within(inUse).getByText("Line A")).toBeTruthy();
    expect(within(inUse).getByText("Line B")).toBeTruthy();
  });

  it("T3 ⚠️ the full path is the row's tooltip, because a leaf name is ambiguous", () => {
    render(<TrainingsPanel />);
    expect(within(sectionAfter("In use")).getByText("Line A").getAttribute("title")).toBe(
      "Plant 1 › Line A",
    );
  });

  it("T4 ⭐⭐ two same-named trainings get controls a person can tell apart", () => {
    // 0031 made names unique per OWNER, so this pair is legal and permanent.
    // With the controls named "Retire" alone, `getByRole` throws on ambiguity —
    // which is precisely what a screen-reader user is left to guess through.
    render(<TrainingsPanel />);
    expect(screen.getByRole("button", { name: "Retire Forklift at Line A" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retire Forklift at Line B" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete Forklift at Line A" })).toBeTruthy();
    // ⚠️ AND THE VISIBLE LABEL IS STILL THE PLAIN VERB, so the accessible name
    // contains it (WCAG 2.5.3 — "label in name").
    expect(screen.getByRole("button", { name: "Retire Forklift at Line A" }).textContent).toBe(
      "Retire",
    );
  });

  it("T5 ⭐⭐ nothing on this screen says 'ticket' or 'skill'", () => {
    // THE MAINTAINER: *"we're still calling them tickets."* The database says
    // `skills` and the api layer says `skill`; the reader must see neither.
    //
    // ⚠️ SCOPED TO THE SCREEN'S OWN CHROME, and the exclusion is a FINDING
    // rather than a convenience: `describeSkillNameClash` in `../lib/operators`
    // — a module this lane does not own — ends two of its three sentences with
    // "…only if it is a different ticket". That sentence renders in T10/T11
    // below and is reported as owed, not silently tolerated here.
    render(<TrainingsPanel />);
    expect(document.body.textContent?.toLowerCase()).not.toContain("ticket");
    expect(document.body.textContent?.toLowerCase()).not.toContain("skill");
    // Accessible names and tooltips are text too, and they are the half a
    // `textContent` scan cannot see.
    for (const el of document.querySelectorAll("[aria-label],[title],[placeholder]")) {
      const attrs = ["aria-label", "title", "placeholder"]
        .map((a) => el.getAttribute(a) ?? "")
        .join(" ")
        .toLowerCase();
      expect(attrs).not.toContain("ticket");
      expect(attrs).not.toContain("skill");
    }
  });

  it("T6 ⚠️ D91: a read that has not been enabled reads as 'loading', never as an empty company", () => {
    // `enabled: false` leaves `isLoading` FALSE, so a panel gating on
    // `isLoading` alone renders "Nothing here yet." as though it were the
    // answer. The mocked query deliberately reports `isLoading: false` WITH
    // data, so only the `!canQuery` term can produce the right screen.
    h.state.sessionLoading = true;
    render(<TrainingsPanel />);
    expect(screen.getByText("Loading trainings…")).toBeTruthy();
    expect(screen.queryByText("Forklift")).toBeNull();
  });
});

/* ===========================================================================
 * Retiring — the primary action.
 * ======================================================================== */

describe("TrainingsPanel — retire and bring back", () => {
  it("T7: a retired training sits in its own section, tagged, and offers Bring back", () => {
    render(<TrainingsPanel />);
    const retiredList = sectionAfter("Retired");
    expect(within(retiredList).getByText("Welding")).toBeTruthy();
    expect(within(retiredList).getByText("Retired")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Bring back Welding at Line A" })).toBeTruthy();
    // ⭐ AND IT IS NOT IN "In use" — the partition is what makes retiring a
    // reversible action rather than a disappearance.
    expect(within(sectionAfter("In use")).queryByText("Welding")).toBeNull();
  });

  it("T8 ⭐⭐ Retire flips `active`, and is not a delete", () => {
    render(<TrainingsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Retire Forklift at Line A" }));
    expect(h.activeMutate).toHaveBeenCalledTimes(1);
    expect(h.activeMutate.mock.calls[0][0]).toEqual({ id: "s1", active: false });
    // ⚠️ THE WHOLE POINT OF THE PAIR. Retiring changes nothing anybody holds;
    // deleting cascades the training off every one of them (0029). A case that
    // only checked the button existed would not tell them apart.
    expect(h.deleteMutate).not.toHaveBeenCalled();
  });

  it("T9: Bring back flips it the other way", () => {
    render(<TrainingsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Bring back Welding at Line A" }));
    expect(h.activeMutate.mock.calls[0][0]).toEqual({ id: "s3", active: true });
  });

  it("T10: Delete opens the confirmation instead of deleting", () => {
    // The screen this replaces deleted a training on one click, with no
    // confirmation at all — under 0029 that also un-qualifies everyone holding
    // it, by cascade.
    render(<TrainingsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Delete Forklift at Line A" }));
    expect(screen.getByRole("group", { name: "Delete Forklift" })).toBeTruthy();
    expect(h.deleteMutate).not.toHaveBeenCalled();
  });

  it("T11 ⭐ the dialog offers 'Deactivate instead' for a live row — reachable for the first time", () => {
    // §19.74 recorded this as owed: `skills.active` shipped in 0029 with no UI,
    // so `DeleteDialog` had no `onDeactivate` to offer for this kind. This panel
    // is the UI, so the offer can be made — and it must NOT be made for a row
    // that is already retired, where it is not an alternative but a no-op.
    render(<TrainingsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Delete Forklift at Line A" }));
    expect(screen.getByRole("button", { name: "Deactivate instead" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Welding at Line A" }));
    expect(screen.queryByRole("button", { name: "Deactivate instead" })).toBeNull();
  });
});

/* ===========================================================================
 * Creating, renaming, and the clash that is not an error.
 * ======================================================================== */

describe("TrainingsPanel — create and rename", () => {
  it("T12: Add sends the org, the trimmed name and the owner the picker is SHOWING", () => {
    render(<TrainingsPanel />);
    draft("  Rigging  ", LINE_B);
    fireEvent.click(addButton());
    expect(h.createMutate.mock.calls[0][0]).toEqual({
      orgId: ORG,
      name: "Rigging",
      siteNodeId: LINE_B,
    });
  });

  it("T13: a blank name is refused beside its own field, and nothing is sent", () => {
    render(<TrainingsPanel />);
    draft("   ", LINE_B);
    fireEvent.click(addButton());
    expect(screen.getByText("A name is required.")).toBeTruthy();
    expect(h.createMutate).not.toHaveBeenCalled();
  });

  it("T14 ⭐ a clash under THIS owner blocks the create and points at the existing row", () => {
    // `skills_owner_name_unique` really will refuse this insert, so the screen
    // refuses first rather than letting it through to a 23505.
    render(<TrainingsPanel />);
    draft("Forklift", LINE_A);
    expect(screen.getByText(/This place already has a Forklift/)).toBeTruthy();
    expect(addButton().disabled).toBe(true);
  });

  it("T15 ⭐⭐ a clash in the same PLANT but a different owner WARNS and leaves Add live", () => {
    // ⚠️⚠️ THE CASE THAT MATTERS MOST HERE. 0031's constraint is per OWNER, so
    // Line A and the plant root may each hold a "Forklift". Blocking this would
    // be the client enforcing a rule the database does not have — §19.74's
    // stale-refusal defect, the quiet kind that never fails and just stops
    // people working.
    render(<TrainingsPanel />);
    draft("Forklift", PLANT1);
    // And it NAMES the other place: "somewhere else in this plant" sends a
    // reader hunting through a list.
    expect(screen.getByText(/Line A already has a Forklift/)).toBeTruthy();
    expect(addButton().disabled).toBe(false);
    fireEvent.click(addButton());
    expect(h.createMutate.mock.calls[0][0]).toEqual({
      orgId: ORG,
      name: "Forklift",
      siteNodeId: PLANT1,
    });
  });

  it("T16 ⭐ a clash with a RETIRED row offers to bring it back, rather than only refusing", () => {
    // The shared finder does not know about `active`, so "use that one" is
    // advice a reader cannot follow: a retired training is not offered for new
    // work. The way out is a control, not a sentence.
    render(<TrainingsPanel />);
    draft("Welding", LINE_A);
    expect(screen.getByText(/That one is retired/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Bring back Welding at Line A instead of creating a second",
      }),
    );
    expect(h.activeMutate.mock.calls[0][0]).toEqual({ id: "s3", active: true });
  });

  it("T17 ⭐⭐ Edit saves the trimmed name and sends NO owner, because the owner did not change", () => {
    render(<TrainingsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Forklift at Line A" }));
    const box = screen.getByRole("textbox", { name: "Name for Forklift at Line A" });
    // ⚠️ THE ADD CARD'S BOX IS STILL PLAINLY "Name", so the two are told apart —
    // `OperatorsPanel` had a real defect from two controls both called
    // "Belongs to", and an open editor is exactly when it bites.
    expect(screen.getAllByRole("textbox", { name: "Name" })).toHaveLength(1);
    fireEvent.change(box, { target: { value: "  Fork lift  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes to Forklift at Line A" }));
    // ⚠️⚠️ `toEqual` WITH NO `siteNodeId` IS THE ASSERTION, not a tidy shape.
    // `updateSkill`'s contract is that an ABSENT key means "leave it alone", and
    // under 0028 `skills.site_node_id` is one side of the comparability test
    // every holder is measured against — so a rename that helpfully resent the
    // current owner would be a MOVE, with the same trigger and the same silence.
    expect(h.updateMutate.mock.calls[0][0]).toEqual({ id: "s1", name: "Fork lift" });
  });

  it("T18: the search narrows on the name", () => {
    render(<TrainingsPanel />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search trainings" }), {
      target: { value: "weld" },
    });
    expect(screen.queryByText("Welding")).not.toBeNull();
    expect(screen.queryByText("Forklift")).toBeNull();
  });
});

/* ===========================================================================
 * The plant filter (roadmap 1(c)).
 * ======================================================================== */

describe("TrainingsPanel — the plant filter", () => {
  it("T19: the list is cut to the chosen plant, and what it hides is COUNTED", () => {
    withTwoPlants();
    render(<TrainingsPanel />);
    // All plants first, so the case cannot pass against a panel that simply
    // never had the fourth row.
    expect(screen.queryByText("Rigging")).not.toBeNull();
    expect(screen.queryByText(/isn't listed|aren't listed/)).toBeNull();
    showPlant(PLANT1);
    expect(screen.queryByText("Rigging")).toBeNull();
    // ⭐ NAMED BY THE PLANT'S OWN LABEL, never by the word "plant": the
    // hierarchy is user-defined. And it names the way back out, because hiding
    // is invisible and permanent.
    expect(screen.getByText(/1 training outside Plant 1 isn't listed\./)).toBeTruthy();
    expect(screen.getAllByText(/All plants/).length).toBeGreaterThan(0);
  });

  it("T20 ⭐ decision 3: the ADD form narrows too — what you see is what you can create in", () => {
    withTwoPlants();
    render(<TrainingsPanel />);
    showPlant(PLANT2);
    const picker = ownerPicker();
    expect([...picker.options].map((o) => o.text)).toEqual(["Plant 2", "  Line 9"]);
    // ⚠️ AND THE VALUE FOLLOWS. A `<select>` handed a value none of its options
    // carries renders its FIRST option and reports nothing — the control saying
    // one thing while the write does another.
    expect(picker.value).toBe(PLANT2);
  });

  it("T21 ⚠️ an edit box on a row the filter took away does not come back open", () => {
    // Resolve-or-fall-back is reversible by construction, so widening back to
    // All plants would re-open a form the reader left behind two plants ago.
    // Clearing is the only thing that closes a door.
    withTwoPlants();
    render(<TrainingsPanel />);
    showPlant(PLANT2);
    fireEvent.click(screen.getByRole("button", { name: "Edit Rigging at Plant 2" }));
    expect(screen.getAllByRole("textbox", { name: "Name for Rigging at Plant 2" })).toHaveLength(1);
    showPlant(PLANT1);
    showPlant(null);
    expect(screen.queryByText("Rigging")).not.toBeNull();
    expect(screen.queryAllByRole("textbox", { name: "Name for Rigging at Plant 2" })).toHaveLength(
      0,
    );
  });

  it("T22: one readable root means the filter is a no-op, whatever is remembered", () => {
    // Decision 2 from the panel's side: the base fixture has ONE root, so
    // `resolvePlantChoice` collapses a stored id rather than leaving somebody
    // filtered by a control `AdminPage` does not render.
    showPlant(PLANT2);
    render(<TrainingsPanel />);
    expect(rowFor("Forklift at Line A")).toBeTruthy();
    expect(screen.queryByText(/isn't listed|aren't listed/)).toBeNull();
  });

  it("T23 ⚠️ the clash check is asked about the OWNER, never about the filtered view", () => {
    // Since 0031 a name is unique per owner, so the narrowing that decides the
    // answer is the owner. Asking the plant-filtered list would let a
    // reversible VIEW CHOICE silently change which names the screen believes
    // are free — and the create would then go through to a 23505.
    withTwoPlants();
    render(<TrainingsPanel />);
    showPlant(PLANT2);
    // Line A is filtered off the screen entirely, and its Forklift still
    // refuses a Forklift created under Line A... which cannot be picked from
    // here. So the reachable half: Plant 2 holds "Rigging", and creating a
    // second "Rigging" under Plant 2 is refused even though nothing about
    // Plant 2's own subtree changed.
    draft("Rigging", PLANT2);
    expect(addButton().disabled).toBe(true);
    showPlant(null);
    // Widening the view does not make the name free either — the answer never
    // depended on the filter.
    expect(screen.getByText(/This place already has a Rigging/)).toBeTruthy();
  });
});

/* ===========================================================================
 * What the reader may actually CHANGE (V14, migration 0032).
 *
 * ⭐⭐ READING REACHES UP AND WRITING REACHES DOWN, so this list legitimately
 * holds rows the server will refuse. Case V14 in
 * `supabase/tests/59_training_record_test.sql` pins the server half; these pin
 * that the screen agrees with it before anybody clicks.
 * ======================================================================== */

/** Is there an Edit/Retire/Delete anywhere for this row? */
function controlsFor(handle: string): string[] {
  return ["Edit", "Retire", "Bring back", "Delete"].filter(
    (verb) => screen.queryByRole("button", { name: `${verb} ${handle}` }) !== null,
  );
}

describe("TrainingsPanel — the permission preview (V14 / D115)", () => {
  it("T24 ⭐⭐ a row owned above the reader's grant keeps NO controls, and says whose it is", () => {
    // The line supervisor of V14: an org-wide supervisor with one grant on
    // Line A. They can see the plant's "Housekeeping" and the server refuses
    // every write on it.
    withPlantOwnedTraining();
    h.state.rights = {
      role: "supervisor",
      adminPaths: [],
      writablePaths: ["plant_1.line_a"],
      known: true,
    };
    render(<TrainingsPanel />);

    // ⭐ IT IS STILL LISTED. Hiding it would be `scope.ts`'s invisible,
    // permanent failure, and the row is real — somebody runs that course.
    expect(screen.getByText("Housekeeping")).toBeTruthy();
    // ⚠️ NOT ONE OF THE FOUR, AND DELETE IS IN THE LIST DELIBERATELY:
    // `skills_delete` is the same `app_can_edit_node` policy, so a surviving
    // Delete would be the one live button on a row that has just said no.
    expect(controlsFor("Housekeeping at Plant 1")).toEqual([]);
    expect(screen.getByText(notManagedNote("Plant 1"))).toBeTruthy();

    // ...and their own line is untouched. A preview that took the controls off
    // everything would be indistinguishable from one that worked.
    expect(controlsFor("Forklift at Line A")).toEqual(["Edit", "Retire", "Delete"]);
    // ⚠️ AND THE SIBLING LINE IS NOT THEIRS EITHER — `path <@ gp` is downward
    // only, so Line B is no more reachable than the plant above.
    expect(controlsFor("Forklift at Line B")).toEqual([]);
  });

  it("T25 ⭐⭐ it FAILS OPEN: before the grant read lands, every control is offered", () => {
    // ⭐⭐ `scope.ts`'s standing argument. Failing closed would strip the whole
    // screen for the length of a round trip, and for good if the RPC broke —
    // silently. Offering a refused button costs one sentence under §19.63.
    withPlantOwnedTraining();
    h.state.rights = { role: "supervisor", adminPaths: [], writablePaths: [], known: false };
    render(<TrainingsPanel />);
    expect(controlsFor("Housekeeping at Plant 1")).toEqual(["Edit", "Retire", "Delete"]);
    expect(screen.queryByText(notManagedNote("Plant 1"))).toBeNull();
  });

  it("T26 ⚠️⚠️ a site admin is org-wide 'viewer', and keeps everything", () => {
    // ⚠️⚠️ THE DEMO'S dana/quinn/rosa. Their org-wide role is 'viewer' and
    // their standing comes from an ADMIN GRANT, which stands alone in
    // `app_can_edit_node`. A preview that required `app_can_write()` on every
    // arm would take this screen away from all three of them.
    withPlantOwnedTraining();
    h.state.rights = {
      role: "viewer",
      adminPaths: ["plant_1"],
      writablePaths: ["plant_1"],
      known: true,
    };
    render(<TrainingsPanel />);
    expect(controlsFor("Housekeeping at Plant 1")).toEqual(["Edit", "Retire", "Delete"]);
    expect(controlsFor("Forklift at Line B")).toEqual(["Edit", "Retire", "Delete"]);
  });

  it("T27 ⚠️ an edit box already open on a row that turns out read-only is closed", () => {
    // ⚠️ THE GRANT READ LANDS AFTER THE LIST, so this ordering is the normal
    // one and not an edge case. Leaving the editor up would leave a Save button
    // on a row whose Edit had just been withdrawn.
    const { rerender } = render(<TrainingsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Forklift at Line B" }));
    expect(screen.getByRole("textbox", { name: "Name for Forklift at Line B" })).toBeTruthy();

    h.state.rights = {
      role: "supervisor",
      adminPaths: [],
      writablePaths: ["plant_1.line_a"],
      known: true,
    };
    rerender(<TrainingsPanel />);
    expect(screen.queryByRole("textbox", { name: "Name for Forklift at Line B" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save changes to Forklift at Line B" })).toBeNull();
    expect(screen.getByText(notManagedNote("Line B"))).toBeTruthy();
  });

  it("T28 ⚠️ the clash note's 'Bring back' is withheld when that row is not theirs either", () => {
    // The retired row holding the name can easily sit outside the reader's
    // grant — 0031 makes the clash a per-owner question. An unguarded button
    // here would be the last refused control on a screen that had removed all
    // the others, in the one place nobody thinks to look.
    h.state.rights = {
      role: "supervisor",
      adminPaths: [],
      writablePaths: ["plant_1.line_b"],
      known: true,
    };
    render(<TrainingsPanel />);
    draft("Welding", LINE_A);
    // The reason the name is taken is still said — that is the reader's
    // problem to understand, and it does not depend on who may fix it.
    expect(screen.getByText(/That one is retired/)).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Bring back Welding at Line A instead of creating a second",
      }),
    ).toBeNull();
    // ⚠️ THE PICKER IS NOT NARROWED BY THE PREVIEW, and Line A is still on
    // offer — `scopeOptions`' header records that a client-derived permission
    // set left a site admin with nothing to choose at all.
    expect(ownerPicker().value).toBe(LINE_A);
  });
});

/* ===========================================================================
 * Moving a training (D105).
 *
 * ⭐⭐ MEASURED FIRST, ON THE RUNNING DATABASE, 31 August, and every case here
 * is pinned to one of those observations:
 *
 *   The move that strands a HOLDER is ALLOWED and silent — nothing re-checks
 *   `app_guard_operator_skill_scope` when `skills.site_node_id` changes, so the
 *   rows survive in a state a re-grant of the same pair would be refused. The
 *   client's job is to say so BEFORE the press, never to refuse.
 *
 *   The move that strands a REQUIREMENT is REFUSED — `app_guard_skill_rehome`
 *   counts `node_skill_requirements` and only those. The client's job there is
 *   the opposite: withhold the button, exactly as `clashBlocks` does.
 * ======================================================================== */

describe("TrainingsPanel — moving a training (D105)", () => {
  it("T29 ⭐ the owner column becomes the picker, seeded to where the row already is", () => {
    render(<TrainingsPanel />);
    const picker = openEdit("Forklift at Line A");
    // ⚠️ SEEDED TO THE ROW'S OWN OWNER, never to the first option. A `<select>`
    // handed a value none of its options carries renders option 0 and reports
    // nothing — which here would silently move the training on the next Save.
    expect(picker.value).toBe(LINE_A);
    // ⚠️ AND IT IS NAMED FOR ITS ROW: the Add card's picker is visibly labelled
    // "Belongs to" and is on screen at the same moment.
    expect(screen.getAllByRole("combobox", { name: "Belongs to" })).toHaveLength(1);
  });

  it("T30 ⭐ a move that costs nobody anything goes straight through, with no confirmation", () => {
    // `DeleteDialog`'s second decision: a warning shown every time is how people
    // learn to click past the one that matters. Both holders sit under Plant 1,
    // so moving the training up to Plant 1 strands neither.
    withHolders();
    render(<TrainingsPanel />);
    const picker = openEdit("Forklift at Line A");
    fireEvent.change(picker, { target: { value: PLANT1 } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes to Forklift at Line A" }));
    expect(h.updateMutate.mock.calls[0][0]).toEqual({
      id: "s1",
      name: "Forklift",
      siteNodeId: PLANT1,
    });
  });

  it("T31 ⭐⭐ a move that strands somebody WRITES NOTHING — it counts them, and names them", () => {
    // THE WHOLE POINT OF THIS CHANGE. The server allows this move and says
    // nothing; if the press went through, Ana's record would quietly stop
    // belonging where she works and nobody would connect it to this click.
    withHolders();
    render(<TrainingsPanel />);
    const picker = openEdit("Forklift at Line A");
    fireEvent.change(picker, { target: { value: LINE_B } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes to Forklift at Line A" }));

    expect(h.updateMutate).not.toHaveBeenCalled();
    const box = screen.getByRole("group", { name: "Move Forklift at Line A" });
    // ⭐ ONE person, not two: Bo is owned by Line B and stays comparable. A
    // preview that warned about everybody would pass without this half.
    expect(within(box).getByText(/1 person you can see holds it/)).toBeTruthy();
    expect(within(box).getByText("Ana")).toBeTruthy();
    expect(within(box).queryByText("Bo")).toBeNull();
  });

  it("T32 ⭐⭐ the confirm names the count (D106), and IT is what finally writes", () => {
    withHolders();
    render(<TrainingsPanel />);
    fireEvent.change(openEdit("Forklift at Line A"), { target: { value: LINE_B } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes to Forklift at Line A" }));

    const go = screen.getByRole("button", {
      name: "Move it and leave 1 person holding it — Forklift at Line A",
    });
    // ⚠️ THE VISIBLE LABEL IS THE WHOLE SENTENCE, so the accessible name
    // contains it (WCAG 2.5.3) and the count is not hidden in the aria-label.
    expect(go.textContent).toBe("Move it and leave 1 person holding it");
    fireEvent.click(go);
    expect(h.updateMutate.mock.calls[0][0]).toEqual({
      id: "s1",
      name: "Forklift",
      siteNodeId: LINE_B,
    });
  });

  it("T33 ⭐⭐ a stranded REQUIREMENT offers no confirm at all — the server refuses it", () => {
    // Measured: `UPDATE skills SET site_node_id = <Line B>` with a Line A
    // requirement still standing raises PT409 `owner_change_blocked`. This is
    // the same call `clashBlocks` makes on the add form — the client withholds
    // only what the database also refuses, never the converse.
    withHolders();
    withRequirement();
    render(<TrainingsPanel />);
    fireEvent.change(openEdit("Forklift at Line A"), { target: { value: LINE_B } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes to Forklift at Line A" }));

    const box = screen.getByRole("group", { name: "Move Forklift at Line A" });
    expect(within(box).getByText(/can’t move to Line B yet/)).toBeTruthy();
    expect(within(box).getByText(/1 place outside Line B still requires it/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Move it and leave/ })).toBeNull();
    // ⚠️ AND THE WAY OUT IS STILL A BUTTON, not just a dead end.
    fireEvent.click(screen.getByRole("button", { name: "Leave Forklift at Line A where it is" }));
    expect(screen.queryByRole("group", { name: "Move Forklift at Line A" })).toBeNull();
    expect(h.updateMutate).not.toHaveBeenCalled();
  });

  it("T34 ⚠️ picking a different destination voids the confirmation it was about", () => {
    // The count in that box is about the place they have just stopped choosing.
    // Leaving it up would put "1 person" over a button that now moves it
    // somewhere else entirely.
    withHolders();
    render(<TrainingsPanel />);
    const picker = openEdit("Forklift at Line A");
    fireEvent.change(picker, { target: { value: LINE_B } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes to Forklift at Line A" }));
    expect(screen.getByRole("group", { name: "Move Forklift at Line A" })).toBeTruthy();

    fireEvent.change(picker, { target: { value: PLANT1 } });
    expect(screen.queryByRole("group", { name: "Move Forklift at Line A" })).toBeNull();
    expect(h.updateMutate).not.toHaveBeenCalled();
  });

  it("T35 ⭐ the edit picker is narrowed by the plant filter, exactly as the ADD form is", () => {
    // Decision 3, applied to the control that moves a row rather than the one
    // that creates it: what you see is what you can move it into. The
    // alternative lets somebody send a training into a plant they have filtered
    // away and then watch it vanish from the list.
    withTwoPlants();
    render(<TrainingsPanel />);
    showPlant(PLANT1);
    const picker = openEdit("Forklift at Line A");
    const offered = Array.from(picker.options).map((o) => o.value);
    expect(offered).toContain(LINE_B);
    expect(offered).not.toContain(PLANT2);
    expect(offered).not.toContain(LINE_9);
  });

  it("T36 ⚠️ Cancel closes the confirmation with it, so it cannot be left armed", () => {
    withHolders();
    render(<TrainingsPanel />);
    fireEvent.change(openEdit("Forklift at Line A"), { target: { value: LINE_B } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes to Forklift at Line A" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop editing Forklift at Line A" }));

    expect(screen.queryByRole("group", { name: "Move Forklift at Line A" })).toBeNull();
    // ⚠️ AND RE-OPENING STARTS FROM THE ROW AGAIN, not from the draft that was
    // abandoned — the picker is shared across rows, so a destination left
    // behind here is one that would move the NEXT row opened.
    expect(openEdit("Forklift at Line A").value).toBe(LINE_A);
    expect(h.updateMutate).not.toHaveBeenCalled();
  });

  it("T37 ⚠️ a row the reader may not change offers no picker either", () => {
    // The new control is withheld by the same `useEditRights` preview as the
    // other three (V14). A picker surviving on a read-only row would be the one
    // live control on a row that has just said it cannot be changed — and this
    // one moves people's records.
    withPlantOwnedTraining();
    withHolders();
    h.state.rights = {
      role: "supervisor",
      adminPaths: [],
      writablePaths: ["plant_1.line_a"],
      known: true,
    };
    render(<TrainingsPanel />);
    expect(controlsFor("Housekeeping at Plant 1")).toEqual([]);
    expect(
      screen.queryByRole("combobox", { name: "Where Housekeeping at Plant 1 belongs" }),
    ).toBeNull();
  });
});
