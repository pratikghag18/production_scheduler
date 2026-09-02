import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, within } from "@testing-library/react";
import { ShiftsPanel } from "@/features/admin/components/ShiftsPanel";
import { useAdminViewStore } from "@/features/admin/store/adminView";

/**
 * ⭐⭐ THE SECOND SUITE IN THIS REPO THAT MOUNTS AN ADMIN PANEL, and it exists
 * because `ShiftsPanel` has just grown the shared plant filter (§19.79) and
 * nothing at the SCREEN level pinned it. Every other test here is
 * library-level: `plantFilter.test.ts` proves the rule, `shiftDraft.test.ts`
 * proves the row assembly, and neither can see whether the panel ever asks
 * them the right question with the right array.
 *
 * ⚠️⚠️ AND IT IS WRITTEN AGAINST `productsPanel.test.tsx`'s CAUTIONARY TALE.
 * That suite was green from the day it was written and was passing through the
 * WRONG BRANCH for its whole life: its `useQuery` stand-in omitted `isSuccess`,
 * so every case ran the "we could not read the structure" path — no site names,
 * every row labelled "Another site", the count line unreachable. Eight cases
 * named behaviour they never exercised. **A stand-in that omits a field does
 * not fail; it silently picks a branch, and the suite reports coverage it never
 * had.**
 *
 * Two things follow, and they are the design of this file:
 *
 *  1. **Only the network boundary is mocked.** `../hooks/useShifts` (React
 *     Query over Supabase), `useSession`, `@/lib/api` and `useDeletion` are
 *     stand-ins. `shiftDraft.ts`, `scope.ts`, `plantFilter.ts`,
 *     `usePlantFilter.ts` and `adminView.ts` are the REAL modules and are under
 *     test here as much as the panel is. Mocking `usePlantFilter` would pin
 *     that the panel calls something, which is exactly the shape of assertion
 *     that let the products suite pass while the screen was broken.
 *  2. **S1 exists to prove the panel rendered at all.** `panelState` folds the
 *     session gate into the pending branch (D91), so a stand-in that forgot
 *     `session` would render nothing but "Loading shift patterns…" — and every
 *     `queryByText(...).toBeNull()` below would still pass, cheerfully, forever.
 */

const PLANT1 = "40000000-0000-0000-0000-000000000001";
const PLANT2 = "40000000-0000-0000-0000-000000000002";
const ASM = "n-asm";
const L9 = "n-l9";
const T_DAYS = "t-days";
const T_EVE = "t-eve";
const T_ZULU = "t-zulu";

const h = vi.hoisted(() => {
  const P1 = "40000000-0000-0000-0000-000000000001";
  const ASM_ID = "n-asm";
  const T_DAYS_ID = "t-days";
  const T_EVE_ID = "t-eve";
  const node = (id: string, name: string, parentId: string | null, path: string) => ({
    id,
    name,
    parentId,
    path,
  });
  const template = (id: string, name: string, siteNodeId: string) => ({ id, name, siteNodeId });

  /**
   * ⭐ FACTORIES, NOT LITERALS, and `beforeEach` rebuilds from them — the
   * lesson `productsPanel.test.tsx` learned the expensive way. Half the cases
   * below add a second plant, a third pattern or a deliberately malformed row,
   * and none of that may leak into the case after it.
   *
   * ⭐ ONE ROOT IN THE BASE FIXTURE, deliberately. `readablePlants` counts
   * roots and `plantControlVisible` needs two, so with one plant the filter is
   * a no-op whatever the store remembers (decision 2) — which is what lets the
   * first group of cases describe the unfiltered screen without a `showPlant`
   * call, and what S7 pins.
   */
  const basePayload = () => ({
    templates: [template(T_DAYS_ID, "Days", P1), template(T_EVE_ID, "Evenings", ASM_ID)],
    // One shift, so the pattern detail has something to draw when S13 opens it.
    shifts: [
      { id: "s-morning", templateId: T_DAYS_ID, name: "Morning", startMin: 360, endMin: 840 },
    ],
    breaks: [] as unknown[],
    attachments: [{ nodeId: P1, templateId: T_DAYS_ID }],
    nodes: [node(P1, "Plant 1", null, "plant_1"), node(ASM_ID, "Assembly", P1, "plant_1.assembly")],
  });

  return {
    node,
    template,
    basePayload,
    createMutate: vi.fn(),
    renameMutate: vi.fn(),
    attachMutate: vi.fn(),
    detachMutate: vi.fn(),
    state: {
      profile: {
        id: "u1",
        orgId: "10000000-0000-0000-0000-000000000001",
        userId: "u1",
        role: "admin",
        defaultCreateMode: "run",
        adminAnywhere: true,
      },
      payload: basePayload() as {
        templates: unknown[];
        shifts: unknown[];
        breaks: unknown[];
        attachments: unknown[];
        nodes: unknown[];
      },
    },
  };
});

/**
 * ⚠️ THE READ'S FLAGS ARE PART OF THE CONTRACT AND ARE ALL SUPPLIED. `pending`
 * is `!canQuery || query.isLoading` and the error line is `query.isError`; an
 * omitted flag reads as `undefined`, which is falsy, which means the panel
 * would render the happy path for the wrong reason and this file would never
 * know. Spelled out rather than inferred — that omission is the whole reason
 * the products suite spent its life in the failure branch.
 */
vi.mock("@/features/admin/hooks/useShifts", () => ({
  useShiftPatterns: () => ({
    data: h.state.payload,
    isLoading: false,
    isError: false,
    error: null,
  }),
  useCreatePattern: () => ({ mutate: h.createMutate, isPending: false }),
  useRenamePattern: () => ({ mutate: h.renameMutate, isPending: false }),
  useCreateShift: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateShift: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteShift: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateBreak: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateBreak: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteBreak: () => ({ mutate: vi.fn(), isPending: false }),
  useAttachPattern: () => ({ mutate: h.attachMutate, isPending: false }),
  useDetachPattern: () => ({ mutate: h.detachMutate, isPending: false }),
}));

vi.mock("@/lib/api", () => ({
  describeSchedulerError: (e: unknown) => String(e),
  isSchedulerError: () => false,
}));

vi.mock("@/features/auth/useSession", () => ({
  useSession: () => ({
    session: { user: { id: h.state.profile.userId } },
    profile: h.state.profile,
    loading: false,
  }),
}));

/**
 * ⚠️ MOCKING THIS IS NOT OPTIONAL, for the reason `productsPanel.test.tsx`
 * records: `DeleteDialog` imports `useDeletion`, which imports `useMutation` /
 * `useQueryClient` and two names from `@/lib/api`. A `vi.mock` factory is a
 * CLOSED object — importing a name it does not define throws while the module
 * graph is built, so the whole file would fail to load rather than any case
 * failing. Cutting the chain at its head keeps the `@/lib/api` stand-in above
 * down to the two functions this panel actually calls.
 *
 * `isPending: true` leaves the dialog in its "still asking the server" state,
 * which is all S14 needs: it asserts the box is THERE, by the accessible name
 * it carries from the moment it opens.
 */
vi.mock("@/features/admin/hooks/useDeletion", () => ({
  useDeletionPreview: () => ({ data: undefined, isPending: true, isError: false, error: null }),
  useDeleteOwnedRow: () => ({ mutate: vi.fn(), isPending: false }),
}));

/* ---------------------------------------------------------------------------
   Reading the screen the way a person does.
   --------------------------------------------------------------------------- */

/**
 * Every pattern row's opener, in list order.
 *
 * ⚠️ `aria-expanded` is the filter because ONLY the pattern openers carry it —
 * and that is a fact about the screen, not a convenience: the caret button was
 * once indistinguishable from the text beside it, and `aria-expanded` is half
 * of the fix that made "there is more under here" sayable at all.
 */
function patternOpeners(): HTMLElement[] {
  return screen.queryAllByRole("button").filter((b) => b.getAttribute("aria-expanded") !== null);
}

/**
 * The name a row SHOWS.
 *
 * ⚠️ Read from the visible text rather than the computed accessible name: the
 * opener also holds a caret (aria-hidden) and a "show shifts" hint, and whether
 * a name computation puts spaces between three inline spans is a detail of the
 * DOM library rather than of this screen. The two decorations are stripped by
 * what they are.
 */
function patternNameOf(opener: HTMLElement): string {
  return (opener.textContent ?? "").replace(/^[▸▾]/u, "").replace(/(show|hide) shifts$/u, "");
}

function patternNames(): string[] {
  return patternOpeners().map(patternNameOf);
}

/** One pattern's row, found the way a person finds it — by the name on it. */
function patternRow(name: string): HTMLElement {
  const opener = patternOpeners().find((b) => patternNameOf(b) === name);
  if (opener === undefined) throw new Error(`no pattern row named ${name}`);
  const li = opener.closest("li");
  if (li === null) throw new Error("the pattern opener is not inside a row");
  return li;
}

/** The places in "Where patterns apply", in list order. */
function placeNames(): string[] {
  return screen
    .queryAllByRole("combobox", { name: /^Shift pattern for / })
    .map((c) => (c.getAttribute("aria-label") ?? "").replace("Shift pattern for ", ""));
}

function attachSelect(place: string): HTMLSelectElement {
  return screen.getByRole("combobox", { name: `Shift pattern for ${place}` }) as HTMLSelectElement;
}

function optionTexts(select: HTMLSelectElement): string[] {
  return [...select.options].map((o) => o.text);
}

/**
 * The indent `indentedLabel` puts on a child option: two U+2007 FIGURE SPACES
 * per level. Ordinary leading spaces are collapsed by every browser's `<option>`
 * rendering, which is why they are not ordinary spaces — and why an expectation
 * written with the space bar would fail against a screen that is correct.
 */
const IN = "  ";

/** What a `<select>` is SHOWING — the option a person reads, not its id. */
function shownOption(select: HTMLSelectElement): string {
  return select.selectedOptions[0]?.text ?? "";
}

/* ---------------------------------------------------------------------------
   The worlds these cases run in.
   --------------------------------------------------------------------------- */

/**
 * The two-plant world the filter exists for: a system admin who reads Plant 1
 * and Plant 2, with a pattern owned in each.
 *
 * ⭐ THE ATTACHMENTS ARE DELIBERATELY CROSSED. Assembly (in Plant 1) runs
 * "Days" (owned in Plant 1), and Plant 1 itself runs "Zulu" (owned in PLANT 2).
 * Attaching needs `app_is_admin_for(node_id)` and says NOTHING about who owns
 * the pattern, so a company admin can and does put one plant's pattern on
 * another's node — that is not an exotic fixture, it is the case S10 and S11
 * pull apart: one row whose stale draft must fall back, one row whose real
 * attachment must survive the trim.
 */
function withTwoPlants() {
  h.state.payload = {
    ...h.basePayload(),
    templates: [
      h.template(T_DAYS, "Days", PLANT1),
      h.template(T_EVE, "Evenings", ASM),
      h.template(T_ZULU, "Zulu", PLANT2),
    ],
    attachments: [
      { nodeId: PLANT1, templateId: T_ZULU },
      { nodeId: ASM, templateId: T_DAYS },
    ],
    nodes: [
      h.node(PLANT1, "Plant 1", null, "plant_1"),
      h.node(ASM, "Assembly", PLANT1, "plant_1.assembly"),
      h.node(PLANT2, "Plant 2", null, "plant_2"),
      h.node(L9, "Line 9", PLANT2, "plant_2.line_9"),
    ],
  };
}

/** Choose a plant the way `AdminPage`'s one control does, and re-render on it. */
function showPlant(choice: string | null) {
  act(() => useAdminViewStore.setState({ plantChoice: choice }));
}

beforeEach(() => {
  h.createMutate.mockClear();
  h.renameMutate.mockClear();
  h.attachMutate.mockClear();
  h.detachMutate.mockClear();
  h.state.payload = h.basePayload();
  // ⚠️ THE STORE IS A MODULE SINGLETON AND OUTLIVES A RENDER. Left set, one
  // case's chosen plant filters the next case's screen — the cross-section leak
  // this whole feature exists to make visible, arriving inside the test file.
  useAdminViewStore.setState({ plantChoice: null, hydratedOrgId: null });
});

describe("ShiftsPanel — the screen is really on (the stand-in guard)", () => {
  it("S1: both cards draw, with every pattern and every place — not the loading branch", () => {
    render(<ShiftsPanel />);
    // ⚠️ THE CASE THAT MAKES THE REST OF THE FILE MEAN ANYTHING. `pending` is
    // `!canQuery || query.isLoading`, and `canQuery` needs a session id AND
    // `loading: false`. A stand-in missing either renders one status line, and
    // every "this is not on screen" assertion below passes against it.
    expect(screen.queryByText("Loading shift patterns…")).toBeNull();
    expect(screen.getByRole("heading", { name: "Shift patterns" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Where patterns apply" })).toBeTruthy();
    expect(patternNames()).toEqual(["Days", "Evenings"]);
    expect(placeNames()).toEqual(["Plant 1", "Assembly"]);
    // And the owner column resolved through `nodes` rather than falling back:
    // "Another site" here would mean the fifth read never reached `patternRows`.
    expect(within(patternRow("Evenings")).getByText("Assembly")).toBeTruthy();
    expect(screen.queryByText("Another site")).toBeNull();
  });
});

/**
 * ⭐⭐ ROADMAP 1(c)/§19.79 — "which plant am I looking at", on this panel.
 *
 * The control and the header chip belong to `AdminPage`; what is pinned here is
 * the half a panel owns — that the choice reaches BOTH LISTS and BOTH FORMS,
 * that the id-keyed state left behind is de-staled, and that everything the
 * choice removes is COUNTED underneath the list it was removed from.
 */
describe("ShiftsPanel — the plant filter trims three things, and counts each (§19.79)", () => {
  it("S2: the pattern list is cut to the chosen plant, and what it hid is counted by name", () => {
    withTwoPlants();
    render(<ShiftsPanel />);
    // All plants first, so this cannot pass against a panel that simply never
    // had the third pattern.
    expect(patternNames()).toEqual(["Days", "Evenings", "Zulu"]);
    expect(screen.queryByText(/is not shown\.|are not shown\./)).toBeNull();

    showPlant(PLANT1);
    expect(patternNames()).toEqual(["Days", "Evenings"]);
    // ⚠️ NAMED, not "another plant". The top level of the hierarchy is whatever
    // this company called it, and the count is `scope.ts`'s rule made visible:
    // a list that quietly shrank looks exactly like a list of things nobody
    // created.
    expect(screen.getByText("1 pattern outside Plant 1 is not shown.")).toBeTruthy();
  });

  it("S3: 'Where patterns apply' is cut the same way, with its own counted footnote", () => {
    withTwoPlants();
    render(<ShiftsPanel />);
    expect(placeNames()).toEqual(["Plant 1", "Assembly", "Plant 2", "Line 9"]);

    showPlant(PLANT1);
    expect(placeNames()).toEqual(["Plant 1", "Assembly"]);
    // The plural arm; S2 covers the singular one. This is the largest
    // node-derived table on the admin screen and therefore the one where a
    // quiet cut would be hardest to notice.
    expect(screen.getByText("2 places outside Plant 1 are not shown.")).toBeTruthy();

    showPlant(PLANT2);
    expect(placeNames()).toEqual(["Plant 2", "Line 9"]);
    expect(screen.getByText("2 places outside Plant 2 are not shown.")).toBeTruthy();
  });

  it("S4: the create form's 'Owning site' offers only the chosen plant's subtree", () => {
    // Decision 3: what you see is what you can create in. The alternative lets
    // somebody create a pattern into a plant they have filtered away and then
    // watch it not appear — silent hiding in a new costume.
    withTwoPlants();
    render(<ShiftsPanel />);
    showPlant(PLANT2);
    const owning = screen.getByRole("combobox", { name: "Owning site" }) as HTMLSelectElement;
    // `indentedLabel` pads a child with two U+2007 figure spaces per level.
    expect(optionTexts(owning)).toEqual(["Plant 2", `${IN}Line 9`]);
    expect(shownOption(owning)).toBe("Plant 2");
  });

  it("S5: the row editor's 'Owned by' narrows too, and still opens on the row's real owner", () => {
    withTwoPlants();
    render(<ShiftsPanel />);
    showPlant(PLANT1);
    fireEvent.click(within(patternRow("Evenings")).getByRole("button", { name: "Edit" }));
    const owned = screen.getByRole("combobox", { name: "Owned by" }) as HTMLSelectElement;
    expect(optionTexts(owned)).toEqual(["Plant 1", `${IN}Assembly`]);
    // ⚠️ ASSEMBLY, not Plant 1. Opening on the plant would make this pass
    // against a picker that ignored the row entirely and took its own first
    // option — which is the defect the case exists to catch.
    expect(shownOption(owned)).toBe(`${IN}Assembly`);
  });

  it("S6: 'All plants' trims nothing and says nothing", () => {
    withTwoPlants();
    render(<ShiftsPanel />);
    expect(patternNames()).toHaveLength(3);
    expect(placeNames()).toHaveLength(4);
    expect(screen.queryByText(/outside/)).toBeNull();
    const owning = screen.getByRole("combobox", { name: "Owning site" }) as HTMLSelectElement;
    expect(optionTexts(owning)).toEqual(["Plant 1", `${IN}Assembly`, "Plant 2", `${IN}Line 9`]);
  });

  it("S7: one readable root makes the filter a no-op, whatever is remembered", () => {
    // Decision 2 from the panel's side. The base fixture has ONE root, so
    // `resolvePlantChoice` collapses a stored id to "All plants" rather than
    // leaving somebody filtered by a control `AdminPage` does not even render.
    showPlant(PLANT2);
    render(<ShiftsPanel />);
    expect(patternNames()).toEqual(["Days", "Evenings"]);
    expect(placeNames()).toEqual(["Plant 1", "Assembly"]);
    expect(screen.queryByText(/is not shown\.|are not shown\./)).toBeNull();
  });

  it("S17: a plant with no patterns says WHICH plant, rather than 'none yet'", () => {
    // ⚠️ TWO EMPTY LISTS, TWO SENTENCES. "No shift patterns yet." over a list
    // the filter emptied is a false statement about the company, and it is
    // exactly `scope.ts`'s failure — the shrunk list reading as a list nobody
    // filled.
    withTwoPlants();
    h.state.payload = {
      ...h.state.payload,
      templates: [h.template(T_DAYS, "Days", PLANT1), h.template(T_EVE, "Evenings", ASM)],
      attachments: [],
    };
    render(<ShiftsPanel />);
    showPlant(PLANT2);
    expect(screen.getByText("No shift patterns in Plant 2.")).toBeTruthy();
    expect(screen.queryByText("No shift patterns yet.")).toBeNull();
    expect(screen.getByText("2 patterns outside Plant 2 are not shown.")).toBeTruthy();
  });
});

/**
 * ⚠️⚠️ THE SHAPE TRAP, and it is specific to THIS panel.
 *
 * `usePlantFilter` is fed the RAW `ShiftNodeRow[]` from the read, never the
 * `NodeAttachmentView` rows `patternRows` returns: that reshape DROPS
 * `parentId` entirely, and the panel then fabricates `parentId: null` on the
 * way into `scopeOptions`. Handing those to `readablePlants` — which decides a
 * root by that very column — would make EVERY node a plant.
 */
describe("ShiftsPanel — the filter is fed the raw rows (the shape trap)", () => {
  it("S8: a stored choice naming a node that is not a ROOT widens back to All plants", () => {
    // ⭐ THE OBSERVABLE FORM OF THE TRAP. Assembly is a child, so
    // `readablePlants` must not offer it and `resolvePlantChoice` must throw
    // the stored id away. Fed the reshaped rows instead — every `parentId`
    // fabricated to `null` — Assembly WOULD resolve, and this screen would trim
    // to one node and one pattern with two footnotes underneath.
    withTwoPlants();
    showPlant(ASM);
    render(<ShiftsPanel />);
    expect(patternNames()).toEqual(["Days", "Evenings", "Zulu"]);
    expect(placeNames()).toEqual(["Plant 1", "Assembly", "Plant 2", "Line 9"]);
    expect(screen.queryByText(/outside/)).toBeNull();
  });

  it("S9: a row the guard refused is COUNTED, and never becomes a plant or an owner", () => {
    // ⚠️ `ShiftPatternsPayload.nodes` is `readonly (ShiftNodeRow | null)[]`.
    // `fetchShiftPatterns` leaves the rejects in the array ON PURPOSE so
    // `patternRows` can count them into `view.skipped`; the panel drops them
    // before the filter sees them. Not coerced — a node that could not be read
    // is not a plant. Passed through, `readablePlants` reads `parentId` off
    // `null` and the whole screen throws.
    withTwoPlants();
    h.state.payload = { ...h.state.payload, nodes: [...h.state.payload.nodes, null] };
    render(<ShiftsPanel />);
    expect(screen.getByText("1 row couldn't be read and isn't shown.")).toBeTruthy();
    // And the reject changed nothing about the choice that remains available.
    showPlant(PLANT1);
    expect(placeNames()).toEqual(["Plant 1", "Assembly"]);
    expect(patternNames()).toEqual(["Days", "Evenings"]);
  });
});

/**
 * ⭐⭐ THE DE-STALING. Every one of these was a real defect found while the
 * filter was being built, and every one has the same shape: a piece of state
 * keyed or valued by an id, still holding an id the filter has taken off
 * screen. A `<select>` handed a value none of its options carries renders its
 * FIRST option and reports nothing — so the control says one thing while the
 * write sends another.
 */
describe("ShiftsPanel — nothing is left holding an id the filter removed", () => {
  it("S10 ⭐ an attach draft naming a filtered-away pattern falls back to what the place runs", () => {
    // `attachDraft` is keyed by NODE id and holds a PATTERN id — the two can be
    // de-synchronised by a control that touches neither. Draft "Zulu" onto
    // Assembly while both plants are showing, then filter Zulu away: the row
    // must read "Days" (what Assembly actually runs), Apply must go dead
    // because nothing has changed, and the invisible id must never be sent.
    withTwoPlants();
    render(<ShiftsPanel />);
    fireEvent.change(attachSelect("Assembly"), { target: { value: T_ZULU } });
    expect(shownOption(attachSelect("Assembly"))).toBe("Zulu");

    showPlant(PLANT1);
    const row = attachSelect("Assembly");
    expect(optionTexts(row)).toEqual(["Inherit from above", "Days", "Evenings"]);
    expect(shownOption(row)).toBe("Days");
    const apply = within(row.closest("li") as HTMLElement).getByRole("button", { name: "Apply" });
    expect((apply as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(apply);
    expect(h.attachMutate).not.toHaveBeenCalled();
  });

  it("S11 ⭐ a place keeps the pattern it is ACTUALLY running, even once the filter hid it", () => {
    // The other half of S10, and the reason the fallback cannot be "just drop
    // what is not visible": Plant 1 runs Zulu, which Plant 2 owns. A row that
    // dropped its own attachment from the list would render "Inherit from
    // above" — a positive claim about this place that is false, and one click
    // from becoming true.
    withTwoPlants();
    render(<ShiftsPanel />);
    showPlant(PLANT1);
    expect(patternNames()).not.toContain("Zulu");
    const row = attachSelect("Plant 1");
    expect(optionTexts(row)).toEqual(["Inherit from above", "Days", "Evenings", "Zulu"]);
    expect(shownOption(row)).toBe("Zulu");
  });

  it("S12 ⭐ the create form's owner can never show one site and CREATE in another", () => {
    // `newOwner` had no resolve-or-fall-back guard at all. Choose Line 9, then
    // filter to Plant 1: the control falls back to Plant 1 while the state
    // still holds Line 9, and Create used to send the site the reader can no
    // longer see. `ownerValue` is the house idiom that fixes it — the picker's
    // value is legal by construction rather than repaired by an effect.
    withTwoPlants();
    render(<ShiftsPanel />);
    const owning = screen.getByRole("combobox", { name: "Owning site" }) as HTMLSelectElement;
    fireEvent.change(owning, { target: { value: L9 } });
    showPlant(PLANT1);

    expect(shownOption(screen.getByRole("combobox", { name: "Owning site" }))).toBe("Plant 1");
    fireEvent.change(screen.getByRole("textbox", { name: "New pattern name" }), {
      target: { value: "Twilight" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(h.createMutate).toHaveBeenCalledTimes(1);
    expect(h.createMutate.mock.calls[0][0]).toEqual({
      orgId: h.state.profile.orgId,
      name: "Twilight",
      siteNodeId: PLANT1,
    });
  });

  it("S13 ⭐ an open editor goes away with its row and COMES BACK with it", () => {
    // ⚠️ RESOLVED, NOT CLEARED, and that is the difference that matters — it is
    // also where this panel deliberately parts company with `ProductsPanel`,
    // whose product editor is dropped outright. The plant choice is a VIEW
    // choice and reversible; throwing away a half-typed rename because somebody
    // glanced at another plant would make a reversible control destructive.
    //
    // ⚠️ MEASURED, AND WORTH RECORDING: deleting the `openPatternId` /
    // `activeRename` / `activeConfirmId` resolutions outright changes NOTHING
    // on this screen — `renderPattern` only ever runs over `visiblePatterns`,
    // so a hidden row's editor has no chance to draw. That resolution is
    // defence-in-depth against the filter and the list disagreeing for a
    // render, exactly as the panel says. What this case can therefore catch is
    // the OTHER implementation: a reset that nulls the drafts when their row
    // goes away, which passes the first half and fails the last three lines.
    withTwoPlants();
    render(<ShiftsPanel />);
    // ⭐ CONTRACT CHANGE (maintainer, 2 Sept): Edit now opens the WHOLE pattern —
    // the name/owner editor AND the shifts — in one click, so there is no longer
    // a separate expand step here. (This case used to click the name opener too;
    // now that would TOGGLE the just-expanded shifts shut.) What S13 defends is
    // unchanged: both editors survive the row leaving and re-entering the filter.
    fireEvent.click(within(patternRow("Zulu")).getByRole("button", { name: "Edit" }));
    expect((screen.getByRole("textbox", { name: "Pattern name" }) as HTMLInputElement).value).toBe(
      "Zulu",
    );
    expect(screen.getByRole("heading", { name: "Shifts in this pattern" })).toBeTruthy();

    showPlant(PLANT1);
    expect(patternNames()).not.toContain("Zulu");
    expect(screen.queryByRole("textbox", { name: "Pattern name" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Shifts in this pattern" })).toBeNull();

    showPlant(null);
    expect((screen.getByRole("textbox", { name: "Pattern name" }) as HTMLInputElement).value).toBe(
      "Zulu",
    );
    expect(screen.getByRole("heading", { name: "Shifts in this pattern" })).toBeTruthy();
  });

  it("S13b ⭐ Cancel closes EVERYTHING Edit opened — the editor and the shifts", () => {
    // The maintainer, 2 Sept: Cancel was leaving the expanded shifts open after
    // Edit had opened them. Edit is one door in (name/owner AND shifts), so its
    // Cancel is one door out — both go away together.
    withTwoPlants();
    render(<ShiftsPanel />);
    const row = patternRow("Zulu");
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("textbox", { name: "Pattern name" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Shifts in this pattern" })).toBeTruthy();
    fireEvent.click(within(patternRow("Zulu")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox", { name: "Pattern name" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Shifts in this pattern" })).toBeNull();
  });

  it("S14 ⭐ an armed delete confirmation is not left open over a row nobody can see", () => {
    // The worst version of S13's defect: `confirmId` holds a pattern id and the
    // dialog it opens deletes. Left unresolved, the box floats over a list that
    // no longer contains its row — and the reader's only clue to WHAT it is
    // about is the name in its own accessible label.
    withTwoPlants();
    render(<ShiftsPanel />);
    fireEvent.click(
      within(patternRow("Zulu")).getByRole("button", { name: "Delete this pattern" }),
    );
    expect(screen.getByRole("group", { name: "Delete Zulu" })).toBeTruthy();

    showPlant(PLANT1);
    expect(screen.queryByRole("group", { name: "Delete Zulu" })).toBeNull();

    showPlant(null);
    expect(screen.getByRole("group", { name: "Delete Zulu" })).toBeTruthy();
  });
});

/**
 * ⭐ THE ONE PLACE THE FILTER DELIBERATELY DOES NOT APPLY.
 *
 * `shift_templates` carries `unique (org_id, name)` with no `site_node_id` in
 * it, so a name is TAKEN whether or not the plant filter is currently showing
 * its owner. Both checks read `view.patterns`, never `visiblePatterns` —
 * checking the trimmed list would let two patterns be given the same name from
 * two different plant views and leave the server to refuse it with a less
 * useful sentence, at the far end of a round trip.
 */
describe("ShiftsPanel — uniqueness reads the UNTRIMMED list", () => {
  const TAKEN = "Another shift pattern in this company already uses that name.";

  it("S15: creating a pattern named after a filtered-away one is refused here, not by the server", () => {
    withTwoPlants();
    render(<ShiftsPanel />);
    showPlant(PLANT1);
    expect(patternNames()).not.toContain("Zulu");
    fireEvent.change(screen.getByRole("textbox", { name: "New pattern name" }), {
      target: { value: "Zulu" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByText(TAKEN)).toBeTruthy();
    expect(h.createMutate).not.toHaveBeenCalled();
  });

  it("S16: renaming onto a filtered-away pattern's name is refused the same way", () => {
    withTwoPlants();
    render(<ShiftsPanel />);
    showPlant(PLANT1);
    const row = patternRow("Days");
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Pattern name" }), {
      target: { value: "Zulu" },
    });
    fireEvent.click(within(patternRow("Days")).getByRole("button", { name: "Save" }));
    expect(screen.getByText(TAKEN)).toBeTruthy();
    expect(h.renameMutate).not.toHaveBeenCalled();
  });
});
