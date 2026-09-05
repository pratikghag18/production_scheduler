import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { DATE_FORMATS, formatCalendarDay } from "@/lib/format/dates";
import rowStyles from "@/components/SettingRow.module.css";

/**
 * THE SETTINGS TAB: ONE ROW PER SETTING (R-320), ONE SHARED ROW (R-332), AND
 * ONE SCOPE DECIDED BY THE CONTROL AT THE TOP (R-333).
 *
 * ⭐⭐ THE CASE THIS FILE NOW TURNS ON IS THE SCOPE. The maintainer, session 62:
 * *"There is a filter at the top for selecting plants. Once we select the plant
 * at the top we should be able to assign the settings to that particular plant,
 * and it should be all types of settings on the settings tab, not just this
 * one."* The tab used to render the company's settings AND a card listing every
 * plant, which was a second answer to a question `AdminPage`'s plant control
 * already answers for every other panel. It now follows that control: a plant
 * chosen at the top and the tab edits that plant; "All plants" and it edits the
 * company defaults.
 *
 * ⚠️ SO THE FIRST THING EVERY CASE HERE ASSERTS IS WHICH SCOPE IS ON SCREEN,
 * because a screen that silently edits a different scope depending on a control
 * somewhere else is worse than one that lists everything. The scope is named in
 * words at the top of the tab, and the cases below read those words.
 *
 * ⭐ THE SAMPLE STILL MATTERS. The eight formats were once eight radio rows
 * (R-320); collapsing to a dropdown is only free if the live sample of today's
 * date comes with it, because that is how a person picks a format — by what
 * they will actually see, not by a token's name.
 *
 * ⚠️ THE SAMPLES ARE COMPUTED, NEVER TYPED. `formatCalendarDay` runs for real
 * against today's date, so this suite cannot start failing on the day the month
 * rolls over — which a hard-coded "3 Sep 2026" would.
 *
 * ⚠️ AND `settingsScope` IS NOT MOCKED. The hooks around it are (they reach a
 * network), but the rule that decides which scope the tab edits is the pure
 * function under test everywhere below — `importOriginal` keeps it real, so a
 * case here fails if the panel stops asking it.
 */

const h = vi.hoisted(() => ({
  setOrgFormat: vi.fn(),
  setOrgPolicy: vi.fn(),
  setPlant: vi.fn(),
  usePlantFilterSpy: vi.fn(),
  state: {
    profile: {
      id: "u1",
      orgId: "10000000-0000-0000-0000-000000000001",
      userId: "u1",
      role: "admin" as string,
      defaultCreateMode: "run",
      adminAnywhere: true,
    },
    /** What `AdminPage`'s one plant control currently says. */
    plantFilter: {
      choice: null as string | null,
      plants: [
        { id: "a", name: "Plant A", path: "plant_a" },
        { id: "b", name: "Plant B", path: "plant_b" },
      ],
      visible: true,
      label: "All plants",
    },
    /** The shared hierarchy read the plant control is built from. */
    tree: {
      data: {
        nodes: [
          { id: "a", name: "Plant A", parentId: null, path: "plant_a" },
          { id: "b", name: "Plant B", parentId: null, path: "plant_b" },
        ],
      },
      isError: false,
    },
    rights: {
      role: "admin" as string | null,
      adminPaths: [] as string[],
      writablePaths: [] as string[],
      known: true,
    },
    companyFormat: "d_mon_yyyy" as string,
    companyPolicy: "warn" as string,
    /**
     * ⛔ `null` IS "INHERITING" AND IS NOT THE SAME AS THE COMPANY'S VALUE.
     * A plant deliberately set to `warn` while the company is on `warn` keeps
     * `warn` when the company moves to `block`; an inheriting plant moves.
     */
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
    /** Which SETTING a per-plant write is in flight for, if any. */
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

/** Everything the panel and `useOrgSettings` reach for; none of it is called. */
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
  // The panel's ONE query is the shared hierarchy read.
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

/**
 * ⭐ THE SEAM THIS WHOLE REQUIREMENT IS ABOUT. The panel must ask THIS hook
 * which plant it is showing — the same one `ProductsPanel`, `ShiftsPanel` and
 * `OperatorsPanel` ask — rather than listing plants of its own. The spy records
 * what it was handed, so a case below can pin that the panel feeds it the
 * shared hierarchy read.
 */
vi.mock("@/features/admin/hooks/usePlantFilter", () => ({
  usePlantFilter: (nodes: unknown) => {
    h.usePlantFilterSpy(nodes);
    return h.state.plantFilter;
  },
}));

/**
 * ⚠️ EVERY FIELD HERE IS READ BY THE PANEL, and `isPending`/`isError` are the
 * pair `operatorsPanel.test.tsx`'s header is about: omitted, they are
 * `undefined`, the control never disables and the failure line never renders —
 * and the cases below would pass for a reason that has nothing to do with what
 * they claim.
 *
 * ⭐ `importOriginal` KEEPS `settingsScope`, `canAdministerPlant` AND
 * `INHERIT_CHOICE` REAL. Only the hooks that would reach a network are stood
 * in for. A whole-module mock here would have let the panel stop consulting the
 * scope rule without a single case noticing.
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
      // React Query hands the in-flight variables back; the panel uses them to
      // tell WHICH setting is saving, so one shared mutation does not put
      // "Saving…" under both rows at once.
      variables:
        h.state.plantPendingKey !== null
          ? { key: h.state.plantPendingKey }
          : h.state.plantErrorKey !== null
            ? { key: h.state.plantErrorKey }
            : undefined,
    }),
  };
});

const { SettingsPanel } = await import("@/features/admin/components/SettingsPanel");

function picker(): HTMLSelectElement {
  return screen.getByRole("combobox", { name: "Date format" }) as HTMLSelectElement;
}

/** The eligibility control, found the same way — by the words a reader sees. */
function policyPicker(): HTMLSelectElement {
  return screen.getByRole("combobox", {
    name: "Putting someone on a job they are not certified for",
  }) as HTMLSelectElement;
}

/** Today the way the panel builds it: LOCAL, not the UTC day. */
function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
}

/** The option value that means "no row -- follow the company". Never sent. */
const INHERIT = "inherit";

/** Put the tab on one plant, the way a reader does: by moving the control. */
function choosePlant(id: string): void {
  h.state.plantFilter.choice = id;
  h.state.plantFilter.label = h.state.plantFilter.plants.find((p) => p.id === id)?.name ?? "";
}

beforeEach(() => {
  h.setOrgFormat.mockClear();
  h.setOrgPolicy.mockClear();
  h.setPlant.mockClear();
  h.usePlantFilterSpy.mockClear();
  h.state.profile.role = "admin";
  h.state.profile.adminAnywhere = true;
  h.state.plantFilter = {
    choice: null,
    plants: [
      { id: "a", name: "Plant A", path: "plant_a" },
      { id: "b", name: "Plant B", path: "plant_b" },
    ],
    visible: true,
    label: "All plants",
  };
  h.state.tree = {
    data: {
      nodes: [
        { id: "a", name: "Plant A", parentId: null, path: "plant_a" },
        { id: "b", name: "Plant B", parentId: null, path: "plant_b" },
      ],
    },
    isError: false,
  };
  h.state.rights = { role: "admin", adminPaths: [], writablePaths: [], known: true };
  h.state.companyFormat = "d_mon_yyyy";
  h.state.companyPolicy = "warn";
  h.state.own = { dateFormat: null, policy: null, isLoading: false, error: null };
  h.state.orgFormatPending = false;
  h.state.orgFormatError = null;
  h.state.orgPolicyPending = false;
  h.state.orgPolicyError = null;
  h.state.plantPendingKey = null;
  h.state.plantErrorKey = null;
  h.state.plantError = null;
});

/* ===========================================================================
 * R-333 — THE TAB FOLLOWS THE PLANT FILTER.
 * ======================================================================== */
describe("R-333: the Settings tab edits the scope the plant control names", () => {
  it("asks the shared plant filter which plant it is showing, and feeds it the shared tree read", () => {
    render(<SettingsPanel />);
    expect(h.usePlantFilterSpy).toHaveBeenCalledWith(h.state.tree.data.nodes);
  });

  it("says it is editing the company defaults on All plants, and how to reach a plant", () => {
    render(<SettingsPanel />);
    expect(screen.getByText("Company defaults")).toBeTruthy();
    expect(
      screen.getByText(/the answers every plant follows unless it has been given its own/i),
    ).toBeTruthy();
    expect(screen.getByText(/Choose a plant in Showing, at the top/)).toBeTruthy();
    expect(screen.queryByText(/Plant A.s own answers/)).toBeNull();
  });

  it("names the plant it is editing once one is chosen, and how to get back", () => {
    choosePlant("b");
    render(<SettingsPanel />);
    expect(screen.getByRole("heading", { name: "Plant B" })).toBeTruthy();
    expect(screen.getByText(/These are Plant B.s own answers/)).toBeTruthy();
    expect(screen.getByText(/Choose .All plants. in Showing, at the top/)).toBeTruthy();
    expect(screen.queryByText("Company defaults")).toBeNull();
  });

  /**
   * ⛔ THE CASE THE MAINTAINER'S SECOND SENTENCE IS ABOUT: "it should be all
   * types of settings on the settings tab, not just this one." Both settings
   * move with the scope, and both grow the third state on a plant.
   */
  it("gives BOTH settings the three states on a plant, not just the eligibility rule", () => {
    choosePlant("a");
    render(<SettingsPanel />);
    expect(
      within(picker())
        .getAllByRole("option")
        .map((o) => o.getAttribute("value")),
    ).toEqual([INHERIT, ...DATE_FORMATS]);
    expect(
      within(policyPicker())
        .getAllByRole("option")
        .map((o) => o.getAttribute("value")),
    ).toEqual([INHERIT, "warn", "block"]);
  });

  it("offers no inheriting option on the company defaults — there is nothing above them", () => {
    render(<SettingsPanel />);
    for (const select of [picker(), policyPicker()]) {
      const values = within(select)
        .getAllByRole("option")
        .map((o) => o.getAttribute("value"));
      expect(values).not.toContain(INHERIT);
    }
  });

  /**
   * ⚠️⚠️ THE NO-CONTROL CASE, HALF ONE. A company admin of a one-plant org has
   * no plant control (`plantFilter.visible` is false below two readable roots),
   * and must edit the COMPANY's values: sending them to the plant would leave
   * `orgs.settings` untouched, and the Activity screen — which spans plants and
   * therefore reads the company value — would go on showing the old format.
   */
  it("a company admin with one plant edits the company defaults, and is not told to use a control that is not there", () => {
    h.state.plantFilter = {
      choice: null,
      plants: [{ id: "a", name: "Plant A", path: "plant_a" }],
      visible: false,
      label: "All plants",
    };
    render(<SettingsPanel />);
    expect(screen.getByText("Company defaults")).toBeTruthy();
    expect(picker().disabled).toBe(false);
    expect(screen.queryByText(/at the top/)).toBeNull();
  });

  /**
   * ⚠️⚠️ THE NO-CONTROL CASE, HALF TWO, AND IT IS THE WHOLE OF R-331. A site
   * admin granted ONE plant has no plant control either, and cannot write
   * `orgs.settings` at all — both org-wide RPCs are `app_is_admin()`. The
   * company scope would hand them two disabled controls and nothing to do, so
   * the tab edits their plant.
   */
  it("a site admin with one readable plant edits that plant, with live controls", () => {
    h.state.profile.role = "viewer";
    h.state.rights = { role: "viewer", adminPaths: ["plant_a"], writablePaths: [], known: true };
    h.state.plantFilter = {
      choice: null,
      plants: [{ id: "a", name: "Plant A", path: "plant_a" }],
      visible: false,
      label: "Plant A",
    };
    render(<SettingsPanel />);
    expect(screen.getByRole("heading", { name: "Plant A" })).toBeTruthy();
    expect(picker().disabled).toBe(false);
    fireEvent.change(picker(), { target: { value: "iso" } });
    expect(h.setPlant).toHaveBeenCalledWith({ nodeId: "a", key: "date_format", choice: "iso" });
  });

  /**
   * ⚠️ FAILS OPEN ON A FAILED STRUCTURE READ, and says so. No readable roots
   * means no plant to edit; the tab lands on the company defaults rather than
   * on nothing, and does not pretend the failure did not happen.
   */
  it("falls back to the company defaults when the plant list could not be read, and says so", () => {
    h.state.plantFilter = { choice: null, plants: [], visible: false, label: "All plants" };
    h.state.tree = { data: { nodes: [] }, isError: true };
    render(<SettingsPanel />);
    expect(screen.getByText("Company defaults")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/Couldn.t load which plants you can see/);
  });
});

/* ===========================================================================
 * R-320 — ONE ROW PER SETTING, AND THE SAMPLE CAME WITH IT.
 * ======================================================================== */
describe("R-320: the settings tab is one row per setting", () => {
  it("offers the date format as one dropdown, not a row per format", () => {
    render(<SettingsPanel />);
    expect(picker()).toBeTruthy();
    // The eight formats used to be eight controls in the pane; now they are
    // eight options inside one. Anything else is the crowding this replaced.
    expect(screen.queryAllByRole("radio")).toEqual([]);
    expect(screen.queryAllByRole("radiogroup")).toEqual([]);
    const boxes = screen.getAllByRole("combobox");
    expect(boxes.filter((b) => b.id === "settings-date-format")).toHaveLength(1);
    const ids = boxes.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("shows a live sample of today's date for every format it offers", () => {
    render(<SettingsPanel />);
    const today = todayIso();
    const options = within(picker()).getAllByRole("option");
    expect(options).toHaveLength(DATE_FORMATS.length);
    options.forEach((option, i) => {
      const fmt = DATE_FORMATS[i];
      expect(option.getAttribute("value")).toBe(fmt);
      expect(option.textContent).toContain(formatCalendarDay(today, fmt));
    });
  });

  it("shows the company's current format, so the closed control is its own sample", () => {
    h.state.companyFormat = "mdy_slash";
    render(<SettingsPanel />);
    const select = picker();
    expect(select.value).toBe("mdy_slash");
    const shown = within(select).getAllByRole("option")[DATE_FORMATS.indexOf("mdy_slash")];
    expect(shown.textContent).toContain(formatCalendarDay(todayIso(), "mdy_slash"));
  });

  it("saves the token that was chosen", () => {
    render(<SettingsPanel />);
    fireEvent.change(picker(), { target: { value: "iso" } });
    expect(h.setOrgFormat).toHaveBeenCalledWith("iso");
  });

  it("disables the picker while the write is in flight", () => {
    h.state.orgFormatPending = true;
    render(<SettingsPanel />);
    expect(picker().disabled).toBe(true);
    expect(screen.getByText("Saving…")).toBeTruthy();
  });

  it("shows a refused write rather than leaving the old choice looking saved", () => {
    h.state.orgFormatError = "you are not a system admin";
    render(<SettingsPanel />);
    expect(screen.getByText("you are not a system admin")).toBeTruthy();
  });

  /**
   * ⚠️ A SITE ADMIN SEES THE COMPANY SETTING AND CANNOT MOVE IT. The RPC
   * (`set_org_date_format`, migration 0037) refuses them regardless, so a live
   * control here would be one that silently does nothing — the failure mode
   * `CLAUDE.md` §4 names. Disabled, with the reason in words, is the contract —
   * and it is deliberately NOT the same shape as a plant they cannot administer
   * (see the D106 case further down), because here the setting exists and
   * somebody can change it, just not them.
   */
  it("a site admin gets the company picker disabled and told why", () => {
    h.state.profile.role = "supervisor";
    render(<SettingsPanel />);
    const select = picker();
    expect(select.disabled).toBe(true);
    expect(select.value).toBe("d_mon_yyyy");
    expect(screen.getByText("Only a system admin can change the date format.")).toBeTruthy();
    fireEvent.change(select, { target: { value: "iso" } });
    expect(h.setOrgFormat).not.toHaveBeenCalled();
  });
});

/**
 * R-014 GETS ITS SWITCH — and the switch has to be readable.
 *
 * ⛔ THE CASE THIS BLOCK EXISTS FOR IS "no bare warn/block". The two stored
 * tokens are the database's vocabulary and they mislead in the one direction
 * that matters: "warn" sounds like the careful choice and is in fact the
 * PERMISSIVE one — an uncertified person can be scheduled, on a typed reason.
 * A reader picking "Warn" off a settings page because it sounded cautious would
 * have chosen the opposite of what they meant, and would not find out until
 * somebody was on a machine they are not trained for. So the assertions here
 * are about what a person can read, not about which token is posted.
 */
describe("R-014: choosing what happens when someone is not certified for the job", () => {
  it("offers the choice as one dropdown on the Settings screen", () => {
    render(<SettingsPanel />);
    const select = policyPicker();
    expect(select).toBeTruthy();
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.getAttribute("value")),
    ).toEqual(["warn", "block"]);
  });

  it("labels each option by what happens, never by the stored word alone", () => {
    render(<SettingsPanel />);
    const options = within(policyPicker()).getAllByRole("option");
    const texts = options.map((o) => (o.textContent ?? "").trim());
    expect(texts).toEqual(["Allow it, with a reason on record", "Refuse it — no exceptions"]);
    for (const t of texts) {
      expect(t.toLowerCase()).not.toBe("warn");
      expect(t.toLowerCase()).not.toBe("block");
    }
  });

  it("spells out what the current choice does, without opening the control", () => {
    render(<SettingsPanel />);
    expect(policyPicker().value).toBe("warn");
    expect(
      screen.getByText(/only by ticking an override and typing why/i, { exact: false }),
    ).toBeTruthy();
    expect(screen.getByText(/saved with the assignment/i, { exact: false })).toBeTruthy();
    expect(screen.queryByText(/no override to tick/i)).toBeNull();
  });

  it("says something different, and stricter, when the company is on the refusing choice", () => {
    h.state.companyPolicy = "block";
    render(<SettingsPanel />);
    expect(policyPicker().value).toBe("block");
    expect(screen.getByText(/no override to tick and no reason that gets past it/i)).toBeTruthy();
    expect(screen.getByText(/until their training is on record/i)).toBeTruthy();
    expect(screen.queryByText(/only by ticking an override and typing why/i)).toBeNull();
  });

  it("saves the token the server accepts, not the words on screen", () => {
    render(<SettingsPanel />);
    fireEvent.change(policyPicker(), { target: { value: "block" } });
    expect(h.setOrgPolicy).toHaveBeenCalledWith("block");
  });

  it("disables the picker while the write is in flight", () => {
    h.state.orgPolicyPending = true;
    render(<SettingsPanel />);
    expect(policyPicker().disabled).toBe(true);
    expect(screen.getByText("Saving…")).toBeTruthy();
  });

  it("shows a refused write rather than leaving the new choice looking saved", () => {
    h.state.orgPolicyError = "only a system admin may change site settings";
    render(<SettingsPanel />);
    expect(screen.getByText("only a system admin may change site settings")).toBeTruthy();
  });

  it("a site admin gets the company picker disabled, told why, and cannot post through it", () => {
    h.state.profile.role = "supervisor";
    render(<SettingsPanel />);
    const select = policyPicker();
    expect(select.disabled).toBe(true);
    expect(screen.getByText("Only a system admin can change this.")).toBeTruthy();
    fireEvent.change(select, { target: { value: "block" } });
    expect(h.setOrgPolicy).not.toHaveBeenCalled();
  });
});

/* ===========================================================================
 * R-331 — A SETTING IS ANSWERED FOR A PLACE, AND "INHERITING" IS A STATE.
 *
 * ⛔⛔ THREE STATES, NOT TWO. A plant is INHERITING (no `node_settings` row) or
 * SET to one of the values. A two-option picker cannot express the first, and a
 * plant nobody has ever touched must not read as though somebody chose its
 * current behaviour — because the two behave differently the day the company
 * changes its mind: an inheriting plant follows, a set one does not.
 * ======================================================================== */
describe("R-331: a plant's own answers, kept apart from the company's", () => {
  beforeEach(() => choosePlant("a"));

  /**
   * ⛔ THE CASE THE WHOLE FEATURE TURNS ON. Plant A has no row and the company
   * is on `warn`. The closed control must NOT read as though somebody chose
   * warn here — it must say the plant is inheriting, and what that currently
   * means.
   */
  it("an untouched plant reads as inheriting, on both settings, and says what it gets", () => {
    render(<SettingsPanel />);
    expect(picker().value).toBe(INHERIT);
    expect(policyPicker().value).toBe(INHERIT);
    // ⭐ The option carries the company's current answer in its own label, so a
    // closed control says both the state and its consequence without opening.
    expect(within(picker()).getAllByRole("option")[0].textContent).toContain(
      `Use the company setting (currently Day Month Year — ${formatCalendarDay(todayIso(), "d_mon_yyyy")})`,
    );
    expect(within(policyPicker()).getAllByRole("option")[0].textContent).toBe(
      "Use the company setting (currently Allowed with a reason)",
    );
    expect(screen.getByText(/Inheriting from the company — currently Day Month Year/)).toBeTruthy();
    expect(
      screen.getByText(/Inheriting from the company — currently Allowed with a reason/),
    ).toBeTruthy();
    expect(screen.getAllByText(/this plant follows/i)).toHaveLength(2);
  });

  it("an inheriting plant tracks the company's answer rather than a stored one", () => {
    h.state.companyPolicy = "block";
    h.state.companyFormat = "iso";
    render(<SettingsPanel />);
    expect(within(policyPicker()).getAllByRole("option")[0].textContent).toMatch(/Refused/);
    expect(screen.getByText(/Inheriting from the company — currently Refused/)).toBeTruthy();
    expect(
      screen.getByText(/Inheriting from the company — currently ISO \(Year-Month-Day\)/),
    ).toBeTruthy();
  });

  it("a plant with its own answers says so, and says it will not follow the company", () => {
    h.state.own.dateFormat = "iso";
    h.state.own.policy = "block";
    render(<SettingsPanel />);
    expect(picker().value).toBe("iso");
    expect(policyPicker().value).toBe("block");
    expect(screen.getByText(/Set for this plant — ISO \(Year-Month-Day\)/)).toBeTruthy();
    expect(screen.getByText(/Set for this plant — Refused/)).toBeTruthy();
    expect(screen.getAllByText(/does not follow the company/i)).toHaveLength(2);
  });

  /**
   * ⛔ "SET TO THE SAME VALUE" IS NOT "INHERITING". Plant A below is set to
   * exactly what the company says; the screen must not show it as inheriting,
   * because the day the company moves this plant stays.
   */
  it("does not show a plant set to the company's current value as inheriting", () => {
    h.state.own.dateFormat = "d_mon_yyyy";
    h.state.own.policy = "warn";
    render(<SettingsPanel />);
    expect(picker().value).toBe("d_mon_yyyy");
    expect(policyPicker().value).toBe("warn");
    expect(screen.queryByText(/Inheriting from the company/)).toBeNull();
    expect(screen.getByText(/Set for this plant — Day Month Year/)).toBeTruthy();
    expect(screen.getByText(/Set for this plant — Allowed with a reason/)).toBeTruthy();
  });

  it("labels a plant's options by consequence, never by the stored word", () => {
    render(<SettingsPanel />);
    const texts = within(policyPicker())
      .getAllByRole("option")
      .map((o) => (o.textContent ?? "").trim());
    expect(texts[1]).toBe("Allow it, with a reason on record");
    expect(texts[2]).toBe("Refuse it — no exceptions");
    for (const t of texts) {
      expect(t.toLowerCase()).not.toBe("warn");
      expect(t.toLowerCase()).not.toBe("block");
    }
  });

  it("gives a plant its own answer through set_node_setting's value", () => {
    render(<SettingsPanel />);
    fireEvent.change(policyPicker(), { target: { value: "block" } });
    expect(h.setPlant).toHaveBeenCalledWith({
      nodeId: "a",
      key: "eligibility_policy",
      choice: "block",
    });
  });

  /**
   * ⛔ RETURNING TO INHERITING IS ITS OWN VERB. `useSetPlantSetting` dispatches
   * `inherit` to `clear_node_setting`, never `set_node_setting(..., null)` —
   * "set to nothing" is precisely the state migration 0050 spent a table
   * avoiding.
   */
  it("returns a setting to inheriting by choosing the company option", () => {
    h.state.own.dateFormat = "iso";
    render(<SettingsPanel />);
    fireEvent.change(picker(), { target: { value: INHERIT } });
    expect(h.setPlant).toHaveBeenCalledWith({ nodeId: "a", key: "date_format", choice: INHERIT });
  });

  /**
   * ⚠️ ONE MUTATION SERVES BOTH ROWS, so an in-flight write has to be
   * attributed to the SETTING it belongs to. Without that, saving the date
   * format would put "Saving…" under the eligibility rule too.
   */
  it("shows saving on the setting being written and not on its neighbour", () => {
    h.state.plantPendingKey = "date_format";
    render(<SettingsPanel />);
    expect(picker().disabled).toBe(true);
    expect(policyPicker().disabled).toBe(false);
    expect(screen.getAllByText("Saving…")).toHaveLength(1);
  });

  it("shows a refused plant write against the setting it was refused for", () => {
    h.state.plantErrorKey = "eligibility_policy";
    h.state.plantError = "you are not an admin of that plant";
    render(<SettingsPanel />);
    expect(screen.getAllByText("you are not an admin of that plant")).toHaveLength(1);
  });

  it("says so plainly when the plant's settings could not be read", () => {
    h.state.own.error = "could not read this plant";
    render(<SettingsPanel />);
    expect(screen.getByText("could not read this plant")).toBeTruthy();
  });

  /**
   * ⚠️ A PLANT THE READER MAY NOT WRITE GETS NO PICKER AT ALL — not a disabled
   * one. The server refuses `set_node_setting` for it (`app_is_admin_for`), and
   * D106's rule is that a greyed control is a control named after something it
   * does not do. What is in force there is still readable, because silently
   * blanking the tab is `scope.ts`'s invisible-and-permanent failure.
   *
   * ⭐ THIS IS THE ANSWER TO "what does a site admin see when the filter is on
   * a plant they cannot administer": the plant's name, its real settings, one
   * sentence saying whose place it is, and nothing to touch.
   */
  it("a plant the reader cannot administer: no controls, the reason once, the values still shown", () => {
    h.state.profile.role = "viewer";
    h.state.rights = { role: "viewer", adminPaths: ["plant_b"], writablePaths: [], known: true };
    h.state.own.policy = "block";
    render(<SettingsPanel />);
    expect(screen.queryAllByRole("combobox")).toEqual([]);
    expect(screen.getByRole("heading", { name: "Plant A" })).toBeTruthy();
    expect(screen.getByText(/Plant A isn’t a place you manage/)).toBeTruthy();
    expect(screen.getByText(/Set for this plant — Refused/)).toBeTruthy();
    expect(h.setPlant).not.toHaveBeenCalled();
  });

  /**
   * ⭐ AND THE SAME READER ON THE PLANT THEY DO ADMINISTER GETS LIVE CONTROLS.
   * A site admin is the whole point of R-331: they cannot move the company
   * setting, and they can move their own plant's.
   */
  it("a site admin on their own plant gets both settings, live", () => {
    choosePlant("b");
    h.state.profile.role = "viewer";
    h.state.rights = { role: "viewer", adminPaths: ["plant_b"], writablePaths: [], known: true };
    render(<SettingsPanel />);
    expect(picker().disabled).toBe(false);
    expect(policyPicker().disabled).toBe(false);
    fireEvent.change(picker(), { target: { value: "ymd_slash" } });
    expect(h.setPlant).toHaveBeenCalledWith({
      nodeId: "b",
      key: "date_format",
      choice: "ymd_slash",
    });
  });
});

/**
 * R-332 — EVERY SETTING'S CONTROL LINES UP WITH EVERY OTHER SETTING'S.
 *
 * The cause was structural, the same shape as R-318's. A setting was a flex row
 * whose control column was `flex: 0 0 auto` — sized by its OWN content. The
 * eligibility picker's longest option is not the date picker's, so the two
 * columns computed two widths and the pickers could only line up by
 * coincidence. The fix is one shared definition of the ROW,
 * `src/components/SettingRow.module.css`, with a control track that is a
 * constant.
 *
 * ⚠️ JSDOM DOES NOT LAY OUT, so nothing here can measure two widths and compare
 * them — a case that claimed to would be a case that passes on a stylesheet that
 * does nothing. What is checkable, and what actually carries the guarantee, is
 * that both rows are the SAME definition: the class names below are hashed per
 * module, so `rowStyles.control` in the DOM is proof the element took its width
 * from the shared file rather than from a copy in the panel's own. The width
 * itself is pinned by `src/test/settingRowStandard.test.ts`, which reads the
 * CSS: one track, one named `rem` width, declared nowhere else in the tree.
 */
describe("R-332: every setting's control is the same column", () => {
  /** The nearest ancestor carrying the shared control-cell class. */
  function cellOf(el: HTMLElement): HTMLElement | null {
    return el.closest(`.${rowStyles.control}`);
  }

  it("both pickers sit in a control cell from the one shared module", () => {
    render(<SettingsPanel />);
    const dateCell = cellOf(picker());
    const policyCell = cellOf(policyPicker());
    expect(dateCell).not.toBeNull();
    expect(policyCell).not.toBeNull();
    // Two different cells — one per setting — built from one definition.
    expect(dateCell).not.toBe(policyCell);
    expect(dateCell!.className).toBe(policyCell!.className);
  });

  /**
   * ⚠️ AMENDED FOR R-333, and the amendment is a contract change rather than a
   * relaxed case. It read `2 + one row per plant` — true only while the pane
   * held a card listing every plant. The tab now edits ONE scope, so it holds
   * exactly one row per setting whichever scope that is, which is what fails if
   * a row is hand-rolled or a control is given its own container.
   */
  it("every setting is one shared row, in both scopes", () => {
    for (const choice of [null, "a"]) {
      h.state.plantFilter.choice = choice;
      const { container, unmount } = render(<SettingsPanel />);
      const rows = container.querySelectorAll(`.${rowStyles.row}`);
      expect(rows).toHaveLength(2);
      expect(container.querySelectorAll(`.${rowStyles.text}`)).toHaveLength(2);
      for (const row of Array.from(rows)) {
        expect(row.querySelectorAll(`.${rowStyles.text}`)).toHaveLength(1);
        expect(row.querySelectorAll(`.${rowStyles.control}`)).toHaveLength(1);
      }
      unmount();
    }
  });

  /**
   * ⚠️ THE ROW WITH TWO THINGS IN ITS CONTROL AREA IS THE ONE THAT BREAKS RULES.
   * Eligibility carries a consequence paragraph under its picker. The paragraph
   * must live INSIDE the control cell — a sibling of the cell would be a third
   * grid item and would land in the wrong column — and it must not be the thing
   * that decides the column's width, which is what its hand-tuned
   * `max-width: 20rem` used to be doing.
   */
  it("a control area two elements tall is one cell, and does not set the width", () => {
    render(<SettingsPanel />);
    const cell = cellOf(policyPicker())!;
    const consequence = screen.getByText(/only by ticking an override and typing why/i);
    expect(cell.contains(consequence)).toBe(true);
    expect(cellOf(picker())!.children.length).toBe(1);
    expect(cell.children.length).toBe(2);
  });

  it("the picker fills the shared track rather than sizing itself", () => {
    render(<SettingsPanel />);
    for (const select of [picker(), policyPicker()]) {
      expect(select.classList.contains(rowStyles.controlField)).toBe(true);
    }
  });

  it("a plant's pickers sit on the same shared column as the company's", () => {
    choosePlant("a");
    render(<SettingsPanel />);
    expect(cellOf(picker())!.className).toBe(cellOf(policyPicker())!.className);
    expect(picker().classList.contains(rowStyles.controlField)).toBe(true);
    expect(policyPicker().classList.contains(rowStyles.controlField)).toBe(true);
  });
});
