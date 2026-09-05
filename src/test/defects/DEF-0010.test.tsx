import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * DEF-0010 — THE ADMIN OF A LINE IS OFFERED THE SETTINGS TAB AND THEN OFFERED
 * NOTHING ON IT, WHILE THE SERVER TAKES THEIR WRITE ON THEIR OWN LINE.
 *
 * ⭐ THIS IS DEF-0007 ONE LEVEL DEEPER. DEF-0007 was a PLANT admin refused the
 * tab the server would have taken her writes on. The tab is now reachable, and
 * the scope it can be put on is still a PLANT ROOT — so the person whose admin
 * grant sits on a line, or on a cell, has a tab with three states and reaches
 * none of them.
 *
 * ⚠️⚠️ MEASURED ON THE SERVER, NOT REASONED TO. `set_node_setting` takes ANY
 * node in the org — `app_node_exists_in_org(p_node_id)` and then
 * `app_is_admin() OR app_is_admin_for(p_node_id)` — and 0050's resolver says
 * so out loud: *"a line's override beats its plant's"*. Over the session of a
 * person holding an ADMIN grant on `plant_a.area_1.line_1` and nothing else,
 * against the local stack, with the row read back from the database rather
 * than trusting a 200:
 *
 *     set_node_setting(line_1, 'eligibility_policy', 'block')
 *       -> 200 {"value":"block","effective":"block","is_override":true}
 *       row back: [{"node_id":"d3555515-…","key":"eligibility_policy","value":"block"}]
 *
 *     set_node_setting(cell_1, 'date_format', 'iso')
 *       -> 200 {"value":"iso","effective":"iso","is_override":true}
 *       row back: [{"node_id":"ce0d946d-…","key":"date_format","value":"iso"}]
 *
 *     set_node_setting(plant_a, 'eligibility_policy', 'block')
 *       -> 403 PT403 not_permitted / not_admin      <- correctly refused
 *
 * And it is not a rule nothing reads: `board_window` emits `node_policies`,
 * one row PER NODE in the window, from that same resolver (0051), so a line's
 * override is what the board and `check_eligibility` actually enforce there.
 *
 * ⛔ WHAT THE SCREEN DOES INSTEAD, read off `http://localhost:5173/admin` as
 * that person: the rail carries Settings, the pane says "Company defaults",
 * both controls are `disabled`, and the words under them are "Only a system
 * admin can change the date format" and "Only a system admin can change this".
 * There is no plant control, because a line grant does not make the plant root
 * readable, so `readablePlants` is empty — and `settingsScope` sends a reader
 * who cannot write the company to the company anyway.
 *
 * That is R-239 backwards: *"A client control is never hidden for something the
 * server permits."*
 *
 * ⚠️ THE ASSERTION IS THE WEAKEST ONE THAT IS CERTAINLY RIGHT, because the
 * SHAPE of the fix is the developer's. It does not demand a node picker, and it
 * does not demand any particular wording. It demands only that a person the
 * server would accept a setting from is not shown a tab on which every control
 * is dead and every sentence says the answer belongs to somebody else. Widening
 * the scope to the node they administer satisfies it; so does telling them
 * which place is theirs and how to reach it; so does not offering them the tab.
 */

const h = vi.hoisted(() => ({
  setOrgFormat: vi.fn(),
  setOrgPolicy: vi.fn(),
  setPlant: vi.fn(),
  usePlantFilterSpy: vi.fn(),
  state: {
    /**
     * ⭐ NOT THE COMPANY ADMIN, AND NOT EVEN A SITE ADMIN. The org-wide role is
     * `supervisor`; the admin-ness is entirely in one grant, and that grant is
     * BELOW a plant root. `adminAnywhere` is what `app_is_admin_anywhere()`
     * returns for them — measured `true` against the live stack — which is why
     * `adminSectionsFor` gives them the whole rail and the tab is reachable.
     */
    profile: {
      id: "u9",
      orgId: "10000000-0000-0000-0000-000000000001",
      userId: "u9",
      role: "supervisor" as string,
      defaultCreateMode: "run",
      adminAnywhere: true,
    },
    /**
     * Empty, and that is the measured value rather than a convenience.
     * `readablePlants` keeps only `parentId === null`; a line grant leaves Line
     * 1's `parentId` pointing at an Area this reader cannot read, so the line is
     * NOT promoted to a root (`plantFilter.ts` says so deliberately). No roots
     * means no control, which is `plantControlVisible`'s decision 2.
     */
    plantFilter: {
      choice: null as string | null,
      plants: [] as Array<{ id: string; name: string; path: string }>,
      visible: false,
      label: "All plants",
    },
    tree: {
      data: {
        nodes: [
          {
            id: "line1",
            name: "Line 1",
            parentId: "area1",
            path: "plant_a.area_1.line_1",
          },
          {
            id: "cell1",
            name: "Cell 1",
            parentId: "line1",
            path: "plant_a.area_1.line_1.cell_1",
          },
        ],
      },
      isError: false,
    },
    /** `app_grant_paths_for(['admin'])` for this person: one line, no plant. */
    rights: {
      role: "supervisor" as string | null,
      adminPaths: ["plant_a.area_1.line_1"] as string[],
      writablePaths: ["plant_a.area_1.line_1"] as string[],
      known: true,
    },
    companyFormat: "d_mon_yyyy" as string,
    companyPolicy: "warn" as string,
    own: {
      dateFormat: null as string | null,
      policy: null as string | null,
      isLoading: false,
      error: null as unknown,
    },
    orgFormatPending: false,
    orgFormatError: null as unknown,
    orgPolicyPending: false,
    orgPolicyError: null as unknown,
    plantPendingKey: null as string | null,
    plantErrorKey: null as string | null,
    plantError: null as unknown,
  },
}));

vi.mock("@/features/auth/useSession", () => ({
  useSession: () => ({
    session: { user: { id: h.state.profile.userId } },
    profile: h.state.profile,
    loading: false,
  }),
}));

vi.mock("@/lib/api", () => ({
  describeSchedulerError: (e: unknown) => String(e),
  fetchHierarchyTree: vi.fn(),
  fetchOrgSettings: vi.fn(),
  setOrgDateFormat: vi.fn(),
  setOrgEligibilityPolicy: vi.fn(),
  fetchPlantSettings: vi.fn(),
  setPlantSetting: vi.fn(),
  clearPlantSetting: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => h.state.tree,
  useMutation: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/features/admin/hooks/useHierarchyMutations", () => ({
  hierarchyKeys: { all: ["hierarchy"] },
}));

vi.mock("@/features/admin/hooks/useEditRights", () => ({
  useEditRights: () => ({ rights: h.state.rights }),
}));

vi.mock("@/features/admin/hooks/usePlantFilter", () => ({
  usePlantFilter: (nodes: unknown) => {
    h.usePlantFilterSpy(nodes);
    return h.state.plantFilter;
  },
}));

/**
 * ⭐ `settingsScope` AND `canAdministerPlant` STAY REAL — only the hooks that
 * would reach a network are stood in for. The rule under test here IS the scope
 * decision, so mocking the module whole would let this pass for nothing.
 */
vi.mock("@/features/admin/hooks/useOrgSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/admin/hooks/useOrgSettings")>();
  return {
    ...actual,
    useCompanyDateFormat: () => h.state.companyFormat,
    useCompanyEligibilityPolicy: () => h.state.companyPolicy,
    usePlantOverrides: (_enabled: boolean, nodeId: string | null) =>
      nodeId === null
        ? { dateFormat: null, policy: null, isLoading: false, error: null }
        : {
            dateFormat: h.state.own.dateFormat,
            policy: h.state.own.policy,
            isLoading: h.state.own.isLoading,
            error: h.state.own.error,
          },
    useSetDateFormat: () => ({
      mutate: h.setOrgFormat,
      isPending: h.state.orgFormatPending,
      isError: h.state.orgFormatError !== null,
      error: h.state.orgFormatError,
    }),
    useSetEligibilityPolicy: () => ({
      mutate: h.setOrgPolicy,
      isPending: h.state.orgPolicyPending,
      isError: h.state.orgPolicyError !== null,
      error: h.state.orgPolicyError,
    }),
    useSetPlantSetting: () => ({
      mutate: h.setPlant,
      isPending: h.state.plantPendingKey !== null,
      isError: h.state.plantErrorKey !== null,
      error: h.state.plantError,
      variables: undefined,
    }),
  };
});

const { SettingsPanel } = await import("@/features/admin/components/SettingsPanel");

function show(): void {
  render(<SettingsPanel />);
}

/** Every `<select>` the tab renders, whatever it is named. */
function controls(): HTMLSelectElement[] {
  return screen.queryAllByRole("combobox") as HTMLSelectElement[];
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.plantFilter.choice = null;
});

describe("DEF-0010: the admin of a line reaches the Settings tab and nothing on it", () => {
  /**
   * ⛔ THE CASE. Not "is the wording right" — is there anything here this person
   * can do, given the server would take their write on the place they run?
   */
  it("is not shown a tab whose every control is disabled, when the server takes their write", () => {
    show();
    const all = controls();
    // The guard on the guard: a pane that rendered no controls at all would
    // satisfy "not every control is disabled" vacuously.
    expect(all.length).toBeGreaterThan(0);
    const enabled = all.filter((c) => !c.disabled).map((c) => c.id);
    expect(enabled).not.toEqual([]);
  });

  /**
   * ⚠️ AND THE SENTENCE IS THE OTHER HALF OF IT. "Only a system admin can change
   * this" is true ABOUT THE COMPANY DEFAULTS and false about the place this
   * person administers; shown to them with no other scope reachable, it is the
   * screen telling them they may change nothing, which the server contradicts.
   */
  it("is not told the answer belongs to a system admin with no other scope to reach", () => {
    show();
    const systemAdminOnly = screen.queryAllByText(/Only a system admin can change/i);
    const namesTheirPlace = screen.queryAllByText(/Line 1/);
    expect(
      systemAdminOnly.length === 0 || namesTheirPlace.length > 0,
      "the pane says only a system admin may change these settings and never names the place this person does administer",
    ).toBe(true);
  });
});
