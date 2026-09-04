import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { CycleTimesPanel } from "@/features/admin/components/CycleTimesPanel";
import { useAdminViewStore } from "@/features/admin/store/adminView";

/**
 * THE CYCLE-TIMES GRID AT THE LEVEL A PERSON READS IT (R-317, R-319).
 *
 * ⭐ WHY THIS FILE EXISTS AT ALL. `cycleTimes.test.ts` case G3 already pins that
 * `buildCycleGrid` counts `contributors` and `total` correctly, and it stayed
 * green the whole time the screen was wrong — because the clause it is verifying
 * is about the ROW ("cells with no number contribute nothing... and the row
 * reports how many contributed") and a model test cannot see a row. Every other
 * admin panel had a render suite; this one had none, and DEF-0004 lived in
 * exactly that gap: a line that made the part but had none of its cells timed
 * drew the same bare dash as a line that did not make the part at all, so the
 * row with the most to report reported nothing and a supervisor scanning for
 * work that still needed timing saw nothing to do.
 *
 * ⭐ THE THREE STATES ARE THE SUBJECT, and the fixture is shaped so a reader can
 * see all three ON ONE SCREEN, differing only in what is measured:
 *
 *   Line 2 / PN-1003   the part is made nowhere below     -> "—"
 *   Line 2 / PN-1004   made at two cells, neither timed   -> "0 of 2 measured"
 *   Line 1 / PN-1003   made at two cells, one timed       -> "1 min" + "1/2"
 *
 * ⚠️ ASSERTED ON WHAT A PERSON CAN PERCEIVE — the text and the accessible name —
 * never on a CSS class. The class and the words come out of the same branch, so
 * a class assertion would pass on a screen showing the right colour with the
 * wrong character in it. The accessible name is half of what DEF-0004 was about:
 * the `na` cell was named "not made here" while the untimed sum was named by its
 * own contents, one dash against another, one state in both directions.
 *
 * ⚠️⚠️ THE MOCKS STOP AT THE NETWORK BOUNDARY, and every field they return is
 * there because the panel reads it. The cautionary tale is `productsPanel.test.tsx`,
 * green for its entire life while running the wrong branch, because its
 * `useQuery` stand-in omitted `isSuccess`. **A stand-in that omits a field does
 * not fail; it silently picks a branch.** So `../lib/cycleTimes`, `../lib/scope`,
 * `../lib/plantFilter`, `usePlantFilter`, `adminView` and `InlineEdit` all run
 * for real — mocking any of them would pin that the panel CALLS something, which
 * is the shape of assertion that passed while the screen was wrong.
 */

const h = vi.hoisted(() => {
  const id = {
    PLANT: "n-plant-a",
    L1: "n-line-1",
    C1: "n-cell-1",
    C2: "n-cell-2",
    L2: "n-line-2",
    C3: "n-cell-3",
    C4: "n-cell-4",
    P1003: "pr-1003",
    P1004: "pr-1004",
  };

  const node = (
    nodeId: string,
    name: string,
    parentId: string | null,
    path: string,
    levelId: string,
  ) => ({ id: nodeId, name, parentId, levelId, path, sortOrder: 1, active: true });

  // ⭐ ONLY THE BOTTOM LEVEL IS SCHEDULABLE. That is what makes a node a place
  // work is booked at, which is what makes its cell editable and every row above
  // it a roll-up — the whole three-state question hangs off this flag.
  const levels = () => [
    { id: "lv-plant", templateId: "tpl-1", position: 0, name: "Plant", isSchedulable: false },
    { id: "lv-line", templateId: "tpl-1", position: 1, name: "Line", isSchedulable: false },
    { id: "lv-cell", templateId: "tpl-1", position: 2, name: "Cell", isSchedulable: true },
  ];

  /**
   * One plant, two lines, two cells each — the shape DEF-0004 was filed against.
   *
   * ⚠️ THE SECOND LINE IS NOT A SPARE ROW. Each line makes a different part, so
   * every column carries a "not made here" as well as a roll-up, and the two
   * states sit one above the other in the same column. That is the comparison a
   * reader actually makes, and the one the defect says the screen failed.
   */
  const baseNodes = () => [
    node(id.PLANT, "Plant A", null, "plant_a", "lv-plant"),
    node(id.L1, "Line 1", id.PLANT, "plant_a.line_1", "lv-line"),
    node(id.C1, "Cell 1", id.L1, "plant_a.line_1.cell_1", "lv-cell"),
    node(id.C2, "Cell 2", id.L1, "plant_a.line_1.cell_2", "lv-cell"),
    node(id.L2, "Line 2", id.PLANT, "plant_a.line_2", "lv-line"),
    node(id.C3, "Cell 3", id.L2, "plant_a.line_2.cell_3", "lv-cell"),
    node(id.C4, "Cell 4", id.L2, "plant_a.line_2.cell_4", "lv-cell"),
  ];

  // ⚠️ `siteNodeIds` IS A LIST AND IT NAMES A LINE, NOT THE PLANT (D115). A part
  // offered at the plant root would be offered at every cell in it and no column
  // could ever hold a "not made here". `active` is not optional either:
  // `buildCycleGrid` drops an inactive part, and the grid would come out empty.
  const product = (
    productId: string,
    sku: string,
    name: string,
    siteNodeIds: string[],
    active = true,
  ) => ({
    id: productId,
    sku,
    name,
    active,
    source: "manual",
    externalId: null as string | null,
    siteNodeIds,
    colorToken: "product-1",
  });

  const baseProducts = () => [
    product(id.P1003, "PN-1003", "Subassembly A", [id.L1]),
    product(id.P1004, "PN-1004", "Subassembly B", [id.L2]),
  ];

  /**
   * ⚠️ AN ENTRY PER NODE, ALL `null`, BECAUSE THAT IS WHAT THE READ RETURNS.
   * `fetchHierarchyTree` writes `sumsChildren[id] = sums_children ?? null` for
   * every node, and `null` means "nobody has said", which `resolveSumsChildren`
   * then answers per node: Line 1's own children are the places work is booked,
   * so it adds up; the plant's children are lines, which are alternative routes,
   * so it does not. Handing over `{}` would exercise the same defaults by
   * accident rather than the shape the server actually sends.
   */
  const baseTree = () => ({
    templates: [] as unknown[],
    levels: levels(),
    nodes: baseNodes(),
    editableShapeIds: ["tpl-1"] as string[] | null,
    siteNodeIds: { "tpl-1": id.PLANT } as Record<string, string | null>,
    sumsChildren: Object.fromEntries(baseNodes().map((n) => [n.id, null])) as Record<
      string,
      boolean | null
    >,
  });

  return {
    id,
    baseProducts,
    baseTree,
    setMutate: vi.fn(),
    clearMutate: vi.fn(),
    rollupMutate: vi.fn(),
    state: {
      profile: {
        id: "u1",
        orgId: "10000000-0000-0000-0000-000000000001",
        userId: "u1",
        role: "admin",
        defaultCreateMode: "run",
        adminAnywhere: true,
      },
      products: baseProducts() as unknown[],
      tree: baseTree(),
      // Nothing measured. That is the grid's OPENING state, not an unusual one,
      // and it is the state DEF-0004 is about.
      values: [] as { nodeId: string; productId: string; secondsPerUnit: number }[],
    },
  };
});

/**
 * The hierarchy read, which this panel makes directly rather than through a
 * hook. `isLoading` and `isError` are both read — they gate the loading line and
 * the failure line — and `data` is destructured five ways: `nodes`, `levels`,
 * `editableShapeIds`, `siteNodeIds` and `sumsChildren`.
 */
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: h.state.tree,
    isLoading: false,
    isError: false,
    isSuccess: true,
    error: null,
  }),
}));

vi.mock("@/lib/api", () => ({
  describeSchedulerError: (e: unknown) => String(e),
  // Named because the panel imports it to hand `useQuery` a `queryFn`; never
  // called, since the stand-in above answers without running one.
  fetchHierarchyTree: vi.fn(),
  isSchedulerError: () => false,
}));

vi.mock("@/features/auth/useSession", () => ({
  useSession: () => ({
    session: { user: { id: h.state.profile.userId } },
    profile: h.state.profile,
    loading: false,
  }),
}));

// Only the query key is imported from here; cutting the module keeps its
// `useMutation` and `@/lib/api` imports out of the closed factories above.
vi.mock("@/features/admin/hooks/useHierarchyMutations", () => ({
  hierarchyKeys: { all: ["hierarchy"] },
}));

vi.mock("@/features/admin/hooks/useProducts", () => ({
  useAdminProducts: () => ({
    data: h.state.products,
    isLoading: false,
    isError: false,
    error: null,
  }),
}));

/**
 * ⚠️ THE WRITES ARE `mutateAsync`, NOT `mutate` — the panel awaits each one so it
 * can put the server's refusal on the cell or on the row. A stand-in offering
 * `mutate` would leave `mutateAsync` undefined, and a save would throw where the
 * screen is meant to show a refusal.
 */
vi.mock("@/features/admin/hooks/useCycleTimes", () => ({
  useCycleTimes: () => ({
    data: h.state.values,
    isLoading: false,
    isError: false,
    error: null,
  }),
  useSetCycleTime: () => ({ mutateAsync: h.setMutate }),
  useClearCycleTime: () => ({ mutateAsync: h.clearMutate }),
  useSetNodeRollup: () => ({ mutateAsync: h.rollupMutate }),
}));

/* ===========================================================================
 * Finding a cell the way a reader finds one: down from a part, across from a place.
 * ======================================================================== */

function grid(): HTMLElement {
  return screen.getByRole("table");
}

/** Which column a part is in. Column 0 is the place names, so it is never a hit. */
function columnOf(sku: string): number {
  const heads = within(grid()).getAllByRole("columnheader");
  const i = heads.findIndex((head) => within(head).queryByText(sku) !== null);
  if (i < 1) throw new Error(`no column for ${sku}`);
  return i;
}

/**
 * ⚠️ FOUND AMONG THE ROW HEADERS, NOT BY TEXT ANYWHERE ON THE PAGE. A plant's
 * name appears TWICE — once as the block's heading and once as its own top row —
 * and a plain text search finds both, which is a failure with nothing wrong
 * behind it.
 */
function rowOf(place: string): HTMLElement {
  const head = within(grid())
    .getAllByRole("rowheader")
    .find((th) => within(th).queryByText(place) !== null);
  const row = head?.closest("tr") ?? null;
  if (row === null) throw new Error(`no row for ${place}`);
  return row;
}

/**
 * The value cell where a place's row meets a part's column. A row's first column
 * is a `rowheader`, not a `cell`, so the value cells run one behind the header
 * list.
 */
function cellAt(place: string, sku: string): HTMLElement {
  const cells = within(rowOf(place)).getAllByRole("cell");
  const cell = cells[columnOf(sku) - 1];
  if (cell === undefined) throw new Error(`no ${sku} cell in the ${place} row`);
  return cell;
}

/**
 * That the cell a reader REACHES BY THAT NAME is the one where this place meets
 * this part. Goes through `getByRole(..., { name })` rather than reading the
 * attribute, so it is the computed accessible name being asserted — which is
 * what a screen reader announces, and what an `aria-label` on a `<td>` replaces
 * the cell's own text with.
 */
function expectNamed(place: string, sku: string, name: string | RegExp): void {
  expect(within(rowOf(place)).getByRole("cell", { name })).toBe(cellAt(place, sku));
}

function show(): void {
  render(<CycleTimesPanel />);
}

beforeEach(() => {
  h.setMutate.mockClear();
  h.clearMutate.mockClear();
  h.rollupMutate.mockClear();
  h.state.products = h.baseProducts();
  h.state.tree = h.baseTree();
  h.state.values = [];
  // The grid is plant-filtered like every admin panel; `null` is All plants.
  useAdminViewStore.setState({ plantChoice: null, hydratedOrgId: null });
});

describe("R-317: a row says how many of the places below it are measured", () => {
  /**
   * The state that really is nothing to do: the part is made nowhere under this
   * row. A dash is right here — there is no work to time — and this case exists
   * so the next one cannot be satisfied by changing every cell at once.
   */
  it("a place that does not make the part shows a dash, named as such", () => {
    show();
    expect(cellAt("Line 2", "PN-1003").textContent).toBe("—");
    expectNamed("Line 2", "PN-1003", "not made here");
  });

  /**
   * ⭐ THE DEFECT ITSELF (DEF-0004). Line 1 makes PN-1003 at two cells and
   * neither is timed. On the old rendering this cell was `<span>—</span>`, the
   * same glyph as the row below it in the same column, so this case fails there
   * on its first assertion: the text was "—", never "0 of 2 measured".
   */
  it("a line that makes the part with nothing timed says so in words, not a dash", () => {
    show();
    const cell = cellAt("Line 1", "PN-1003");
    expect(cell.textContent).toBe("0 of 2 measured");
    expect(cell.textContent).not.toContain("—");
  });

  /**
   * ⭐ AND THE OTHER HALF OF IT, ON ONE SCREEN. The `na` cell carried
   * `aria-label="not made here"` and the sum cell carried nothing at all, so a
   * screen reader announced a bare dash for the row with two places waiting to
   * be timed. On the old rendering the untimed cell's computed name is its own
   * contents, "—", which matches none of the three expectations below.
   */
  it("the three states are three different things to a screen reader", () => {
    h.state.values = [{ nodeId: h.id.C1, productId: h.id.P1003, secondsPerUnit: 60 }];
    show();

    expectNamed("Line 2", "PN-1003", "not made here");
    expectNamed("Line 1", "PN-1003", "1 min, summed over 1 of 2 places below");
    expectNamed("Line 2", "PN-1004", "Nothing measured yet: 0 of 2 places below have a cycle time");
  });

  /**
   * ⚠️ THE COUNT IS SPOKEN AS A COUNT. The on-screen annotation is "1/2" because
   * the cell is 9.5rem wide and a sentence would wrap the row to twice the
   * height of the ones it totals — but "one slash two" is not a count, so the
   * name says "1 of 2". Same clause of R-317, in the audio channel.
   */
  it("names a partial sum as a count rather than as a fraction", () => {
    h.state.values = [{ nodeId: h.id.C1, productId: h.id.P1003, secondsPerUnit: 60 }];
    show();
    expectNamed("Line 1", "PN-1003", /1 of 2 places below$/);
    expect(within(rowOf("Line 1")).queryAllByRole("cell", { name: /1\/2/ })).toEqual([]);
  });

  /**
   * The state that already worked, pinned so the fix above cannot swallow it: a
   * partly measured line shows the total AND how much of the line it covers.
   * 60 s at one of two cells is one minute of KNOWN labour content, not the
   * line's full labour content, and a reader who cannot tell those apart plans
   * against the smaller number.
   */
  it("a partly measured line shows its total and how many contributed", () => {
    h.state.values = [{ nodeId: h.id.C1, productId: h.id.P1003, secondsPerUnit: 60 }];
    show();
    const cell = cellAt("Line 1", "PN-1003");
    expect(cell.textContent).toContain("1 min");
    expect(cell.textContent).toContain("1/2");
  });

  /**
   * A COMPLETE total wears no annotation — nothing is missing to warn about, and
   * a "2/2" on every finished row is noise that would make the partial ones
   * harder to spot. 60 s + 90 s is 150 s, which `displayCycle` writes exactly as
   * 2.5 min.
   */
  it("a fully measured line shows the total alone", () => {
    h.state.values = [
      { nodeId: h.id.C1, productId: h.id.P1003, secondsPerUnit: 60 },
      { nodeId: h.id.C2, productId: h.id.P1003, secondsPerUnit: 90 },
    ];
    show();
    const cell = cellAt("Line 1", "PN-1003");
    expect(cell.textContent).toBe("2.5 min");
    expect(cell.textContent).not.toContain("/");
  });

  /**
   * ⭐ "MADE HERE" HAS TO BE TRUE FOR THE ROW ABOVE IT TO BE WRONG. The two
   * places Line 1's count is about are real boxes a reader can type into, which
   * is what makes "0 of 2 measured" work still to be done rather than a fact
   * about an empty part of the tree.
   */
  it("the places a count is about are editable boxes", () => {
    show();
    expect(screen.getByRole("button", { name: "Cycle time for PN-1003 at Cell 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cycle time for PN-1003 at Cell 2" })).toBeTruthy();
    // ...and Cell 3 makes the other part, so PN-1003 is not typeable there.
    expect(screen.queryByRole("button", { name: "Cycle time for PN-1003 at Cell 3" })).toBeNull();
  });
});

describe("R-319: a row that does not add up says so instead of drawing a dash", () => {
  /**
   * The plant's children are LINES — alternative routes, since a unit goes down
   * one line or the other — so the plant row deliberately does not add. It has
   * always said "not added" in words, and this case sits beside the ones above
   * to prove the states did not collapse into one another: on a single screen a
   * reader sees "not added", "0 of 2 measured" and "—", three different things.
   */
  it("the plant row says 'not added' while the line below it counts", () => {
    show();
    expect(cellAt("Plant A", "PN-1003").textContent).toBe("not added");
    expect(cellAt("Line 1", "PN-1003").textContent).toBe("0 of 2 measured");
    expect(cellAt("Line 2", "PN-1003").textContent).toBe("—");
  });

  /**
   * ⭐ THE ROW BESIDE THE DEFECT, ADDED IN REVIEW. R-319's "not added" cell told
   * its counts only through a `title`, which a screen reader does not speak, so
   * it said what it was NOT doing and never how much of it is measured — the
   * same half-told story DEF-0004 is about, one state over.
   */
  it("names the not-added row with its counts, not just the words", () => {
    show();
    // Every one of them, not a chosen cell: the counts differ per column and
    // the point is that none of these cells is named by its words alone.
    const words = within(rowOf("Plant A")).getAllByText("not added");
    expect(words.length).toBeGreaterThan(0);
    for (const span of words) {
      expect(span.closest("td")?.getAttribute("aria-label")).toMatch(
        /^Not added up: \d+ of \d+ places below are measured$/,
      );
    }
  });
});
