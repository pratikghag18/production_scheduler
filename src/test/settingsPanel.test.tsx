import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { SettingsPanel } from "@/features/admin/components/SettingsPanel";
import { DATE_FORMATS, formatCalendarDay } from "@/lib/format/dates";
import rowStyles from "@/components/SettingRow.module.css";

/**
 * THE SETTINGS TAB IS ONE ROW PER SETTING (R-320).
 *
 * The maintainer, 3 Sept: *"the date format should be a dropdown option... I
 * think we're going to fill up the settings tab with more options and this
 * could get crowded."* The screen offered eight formats as eight radio rows —
 * most of a pane spent on one preference, and the second setting to land would
 * have been pushed below the fold by the first one's options.
 *
 * ⭐ THE CASE THAT MATTERS IS THE SAMPLE, not the control type. The radio list
 * showed a live sample of today's date beside every format, which is how a
 * person picks one — by what they will actually see, not by a token's name.
 * Collapsing to a dropdown is only free if the samples come with it, so the
 * option text is asserted to carry the format's own rendering of today.
 *
 * ⚠️ THE SAMPLES ARE COMPUTED, NEVER TYPED. `formatCalendarDay` runs for real
 * against today's date, so this suite cannot start failing on the day the month
 * rolls over — which a hard-coded "3 Sep 2026" would.
 *
 * ⚠️ THE SEAM IS NOT MOCKED. `src/lib/format/dates.ts` is pure and is what
 * decides every string here; standing in for it would pin that the panel calls
 * something rather than that a reader can see the format they are choosing.
 */

const h = vi.hoisted(() => ({
  setMutate: vi.fn(),
  state: {
    profile: {
      id: "u1",
      orgId: "10000000-0000-0000-0000-000000000001",
      userId: "u1",
      role: "admin" as string,
      defaultCreateMode: "run",
      adminAnywhere: true,
    },
    format: "d_mon_yyyy" as string,
    pending: false,
    error: null as unknown,
    policy: "warn" as string,
    policyPending: false,
    policyError: null as unknown,
    /**
     * ⛔ THREE STATES PER PLANT, NOT TWO. `override: null` is "this plant
     * inherits" and it is NOT the same row as `override: "warn"` while the
     * company happens to be on warn — the second survives the company changing
     * its mind. `effective` is what the server will actually apply there.
     */
    plants: [
      { nodeId: "a", name: "Plant A", override: null, effective: "warn", editable: true },
      { nodeId: "b", name: "Plant B", override: "block", effective: "block", editable: true },
    ] as Array<{
      nodeId: string;
      name: string;
      override: string | null;
      effective: string;
      editable: boolean;
    }>,
    plantsLoading: false,
    plantsError: null as unknown,
    plantPending: null as string | null,
    plantError: null as unknown,
  },
  setPolicyMutate: vi.fn(),
  setPlantMutate: vi.fn(),
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
}));

/**
 * ⚠️ EVERY FIELD HERE IS READ BY THE PANEL, and `isPending`/`isError` are the
 * pair `operatorsPanel.test.tsx`'s header is about: omitted, they are
 * `undefined`, the control never disables and the failure line never renders —
 * and the cases below would pass for a reason that has nothing to do with what
 * they claim.
 */
vi.mock("@/features/admin/hooks/useOrgSettings", () => ({
  // ⚠️ A VALUE, NOT A TYPE: the panel puts it in an `<option value>` and
  // compares against it, so a mock that left it out would render `value={undefined}`
  // and every three-state case below would fail for the wrong reason.
  INHERIT_CHOICE: "inherit",
  useDateFormat: () => h.state.format,
  useSetDateFormat: () => ({
    mutate: h.setMutate,
    isPending: h.state.pending,
    isError: h.state.error !== null,
    error: h.state.error,
  }),
  useEligibilityPolicy: () => h.state.policy,
  useSetEligibilityPolicy: () => ({
    mutate: h.setPolicyMutate,
    isPending: h.state.policyPending,
    isError: h.state.policyError !== null,
    error: h.state.policyError,
  }),
  usePlantPolicies: () => ({
    rows: h.state.plants,
    isLoading: h.state.plantsLoading,
    isError: h.state.plantsError !== null,
    error: h.state.plantsError,
  }),
  useSetPlantPolicy: () => ({
    mutate: h.setPlantMutate,
    isPending: h.state.plantPending !== null,
    isError: h.state.plantError !== null,
    error: h.state.plantError,
    // React Query hands the in-flight variables back; the panel uses them to
    // tell WHICH row is saving, so one shared mutation does not put "Saving…"
    // under every plant at once.
    variables: h.state.plantPending === null ? undefined : { nodeId: h.state.plantPending },
  }),
}));

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

beforeEach(() => {
  h.setMutate.mockClear();
  h.setPolicyMutate.mockClear();
  h.state.profile.role = "admin";
  h.state.profile.adminAnywhere = true;
  h.state.format = "d_mon_yyyy";
  h.state.pending = false;
  h.state.error = null;
  h.state.policy = "warn";
  h.state.policyPending = false;
  h.state.policyError = null;
  h.setPlantMutate.mockClear();
  h.state.plants = [
    { nodeId: "a", name: "Plant A", override: null, effective: "warn", editable: true },
    { nodeId: "b", name: "Plant B", override: "block", effective: "block", editable: true },
  ];
  h.state.plantsLoading = false;
  h.state.plantsError = null;
  h.state.plantPending = null;
  h.state.plantError = null;
});

/** One plant's picker, found by the name a reader sees on the row. */
function plantPicker(name: string): HTMLSelectElement {
  return screen.getByRole("combobox", { name }) as HTMLSelectElement;
}

describe("R-320: the settings tab is one row per setting", () => {
  /**
   * ⚠️ THIS CASE WAS AMENDED WHEN THE SECOND SETTING LANDED, and the amendment
   * is a contract change rather than a wrong case being quietly relaxed
   * (CLAUDE.md §4). As written it ended `getAllByRole("combobox")` `.toHaveLength(1)`
   * — true of R-320 at the time only because the pane held exactly ONE setting,
   * and the claim R-320 actually makes is "one control per SETTING", not "one
   * control on the screen". Left alone it would have failed the moment the
   * second setting arrived, which is the outcome R-320 exists to make possible.
   * What it pins now is the same thing in a form that survives a third setting:
   * the eight formats are one control, nothing is a radio, and no setting is
   * rendered twice.
   */
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

  it("shows the org's current format, so the closed control is its own sample", () => {
    h.state.format = "mdy_slash";
    render(<SettingsPanel />);
    const select = picker();
    expect(select.value).toBe("mdy_slash");
    const shown = within(select).getAllByRole("option")[DATE_FORMATS.indexOf("mdy_slash")];
    expect(shown.textContent).toContain(formatCalendarDay(todayIso(), "mdy_slash"));
  });

  it("saves the token that was chosen", () => {
    render(<SettingsPanel />);
    fireEvent.change(picker(), { target: { value: "iso" } });
    expect(h.setMutate).toHaveBeenCalledWith("iso");
  });

  it("disables the picker while the write is in flight", () => {
    h.state.pending = true;
    render(<SettingsPanel />);
    expect(picker().disabled).toBe(true);
    expect(screen.getByText("Saving…")).toBeTruthy();
  });

  it("shows a refused write rather than leaving the old choice looking saved", () => {
    h.state.error = "you are not a system admin";
    render(<SettingsPanel />);
    expect(screen.getByText("you are not a system admin")).toBeTruthy();
  });

  /**
   * ⚠️ A SITE ADMIN SEES THE SETTING AND CANNOT MOVE IT. The RPC
   * (`set_org_date_format`, migration 0037) refuses them regardless, so a live
   * control here would be one that silently does nothing — the failure mode
   * `CLAUDE.md` §4 names. Disabled, with the reason in words, is the contract.
   */
  it("a site admin gets the picker disabled and told why", () => {
    h.state.profile.role = "supervisor";
    render(<SettingsPanel />);
    const select = picker();
    expect(select.disabled).toBe(true);
    expect(select.value).toBe("d_mon_yyyy");
    expect(screen.getByText("Only a system admin can change the date format.")).toBeTruthy();
    fireEvent.change(select, { target: { value: "iso" } });
    expect(h.setMutate).not.toHaveBeenCalled();
  });
});

/**
 * R-014 GETS ITS SWITCH — and the switch has to be readable.
 *
 * `orgs.settings.eligibility_policy` has decided since P1-4e whether an
 * uncertified person can be scheduled at all, and until migration 0049 there
 * was no way to change it from the app: every org sat on the 0001 default.
 * The control is the easy half. The hard half is the WORDS.
 *
 * ⛔ THE CASE THIS BLOCK EXISTS FOR IS "no bare warn/block". The two stored
 * tokens are the database's vocabulary and they mislead in the one direction
 * that matters: "warn" sounds like the careful choice and is in fact the
 * PERMISSIVE one — an uncertified person can be scheduled, on a typed reason.
 * A reader picking "Warn" off a settings page because it sounded cautious would
 * have chosen the opposite of what they meant, and would not find out until
 * somebody was on a machine they are not trained for. So the assertions here
 * are about what a person can read, not about which token is posted: each
 * option must describe its consequence, neither may be the bare word, and the
 * current choice's full consequence must be on the page WITHOUT opening the
 * control — because a closed `<select>` shows one line and that line is a
 * summary.
 *
 * ⚠️ THE HOOK IS MOCKED, THE PANEL IS NOT. `isPending`/`isError` are supplied
 * for the reason `operatorsPanel.test.tsx` records: omitted, they are
 * `undefined`, the control never disables, the failure line never renders, and
 * two cases below would pass for a reason unrelated to what they claim.
 */
describe("R-014: choosing what happens when someone is not certified for the job", () => {
  it("offers the choice as one dropdown on the Settings screen", () => {
    render(<SettingsPanel />);
    const select = policyPicker();
    expect(select).toBeTruthy();
    expect(within(select).getAllByRole("option")).toHaveLength(2);
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
    // The tokens the server stores must not be what a reader is asked to
    // choose between: "Warn" reads as the cautious option and is the
    // permissive one.
    for (const t of texts) {
      expect(t.toLowerCase()).not.toBe("warn");
      expect(t.toLowerCase()).not.toBe("block");
    }
  });

  it("spells out what the current choice does, without opening the control", () => {
    render(<SettingsPanel />);
    expect(policyPicker().value).toBe("warn");
    // The permissive reading, in full: allowed, but only on a reason that is
    // kept. Nothing here is behind a click.
    expect(
      screen.getByText(/only by ticking an override and typing why/i, { exact: false }),
    ).toBeTruthy();
    expect(screen.getByText(/saved with the assignment/i, { exact: false })).toBeTruthy();
    expect(screen.queryByText(/no override to tick/i)).toBeNull();
  });

  it("says something different, and stricter, when the org is on the refusing choice", () => {
    h.state.policy = "block";
    render(<SettingsPanel />);
    expect(policyPicker().value).toBe("block");
    expect(screen.getByText(/no override to tick and no reason that gets past it/i)).toBeTruthy();
    expect(screen.getByText(/until their training is on record/i)).toBeTruthy();
    // And the permissive sentence is gone — the two consequences are not a
    // single paragraph that stays put whichever is chosen.
    expect(screen.queryByText(/only by ticking an override and typing why/i)).toBeNull();
  });

  it("saves the token the server accepts, not the words on screen", () => {
    render(<SettingsPanel />);
    fireEvent.change(policyPicker(), { target: { value: "block" } });
    expect(h.setPolicyMutate).toHaveBeenCalledWith("block");
  });

  it("disables the picker while the write is in flight", () => {
    h.state.policyPending = true;
    render(<SettingsPanel />);
    expect(policyPicker().disabled).toBe(true);
    expect(screen.getByText("Saving…")).toBeTruthy();
  });

  it("shows a refused write rather than leaving the new choice looking saved", () => {
    h.state.policyError = "only a system admin may change site settings";
    render(<SettingsPanel />);
    expect(screen.getByText("only a system admin may change site settings")).toBeTruthy();
  });

  /**
   * ⚠️ A NON-SYSTEM-ADMIN GETS IT DISABLED AND IS TOLD WHY. `set_org_eligibility_policy`
   * (0049) refuses them with `not_permitted`, and a plain `orgs` UPDATE would
   * have changed zero rows and raised nothing — so a live control here would be
   * one that silently does nothing about how the whole plant is scheduled. The
   * `disabled` attribute is not the guard: the change handler refuses too, which
   * is what the last two lines check.
   */
  it("a site admin gets the picker disabled, told why, and cannot post through it", () => {
    h.state.profile.role = "supervisor";
    render(<SettingsPanel />);
    const select = policyPicker();
    expect(select.disabled).toBe(true);
    expect(screen.getByText("Only a system admin can change this.")).toBeTruthy();
    fireEvent.change(select, { target: { value: "block" } });
    expect(h.setPolicyMutate).not.toHaveBeenCalled();
  });
});

/**
 * R-332 — EVERY SETTING'S CONTROL LINES UP WITH EVERY OTHER SETTING'S.
 *
 * The maintainer, on this tab: *"the drop down options are not aligned in
 * different options. It does not look professional. Please create a standard
 * for it."*
 *
 * The cause was structural, the same shape as R-318's. A setting was a flex row
 * whose control column was `flex: 0 0 auto` — sized by its own content. The
 * eligibility picker's longest option ("Allow it, with a reason on record") is
 * not the date picker's, so the two columns computed two widths and the pickers
 * could only line up by coincidence. The fix is one shared definition of the
 * ROW, `src/components/SettingRow.module.css`, with a control track that is a
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
   * ⚠️ AMENDED FOR R-331, and the amendment is a contract change rather than a
   * relaxed case. It read `toHaveLength(2)` — true only while the pane held
   * exactly the two org-wide settings. R-332's claim is "every setting is one
   * shared row", and a per-plant setting is a setting: the count is now the two
   * company rows PLUS one row per plant, which is what fails if a plant row is
   * hand-rolled or given its own container.
   */
  it("every setting, company-wide or per-plant, is the same shared row", () => {
    const { container } = render(<SettingsPanel />);
    const rows = container.querySelectorAll(`.${rowStyles.row}`);
    expect(rows).toHaveLength(2 + h.state.plants.length);
    const texts = container.querySelectorAll(`.${rowStyles.text}`);
    expect(texts).toHaveLength(2 + h.state.plants.length);
    for (const row of Array.from(rows)) {
      expect(row.querySelectorAll(`.${rowStyles.text}`)).toHaveLength(1);
      expect(row.querySelectorAll(`.${rowStyles.control}`)).toHaveLength(1);
    }
  });

  it("a plant's picker sits on the same shared column as the company's", () => {
    render(<SettingsPanel />);
    const plantCell = cellOf(plantPicker("Plant A"));
    const policyCell = cellOf(policyPicker());
    expect(plantCell).not.toBeNull();
    expect(plantCell).not.toBe(policyCell);
    expect(plantCell!.className).toBe(policyCell!.className);
    expect(plantPicker("Plant A").classList.contains(rowStyles.controlField)).toBe(true);
  });

  /**
   * ⚠️ THE ROW WITH TWO THINGS IN ITS CONTROL AREA IS THE ONE THAT BREAKS RULES.
   * Eligibility carries a consequence paragraph under its picker and the date
   * format does not. The paragraph must live INSIDE the control cell — a sibling
   * of the cell would be a third grid item and would land in the wrong column —
   * and it must not be the thing that decides the column's width, which is what
   * its hand-tuned `max-width: 20rem` used to be doing.
   */
  it("a control area two elements tall is one cell, and does not set the width", () => {
    render(<SettingsPanel />);
    const cell = cellOf(policyPicker())!;
    const consequence = screen.getByText(/only by ticking an override and typing why/i);
    expect(cell.contains(consequence)).toBe(true);
    // The date row's control cell holds one element; the eligibility row's holds
    // two. Same class, so the same width regardless.
    expect(cellOf(picker())!.children.length).toBe(1);
    expect(cell.children.length).toBe(2);
  });

  it("the picker fills the shared track rather than sizing itself", () => {
    render(<SettingsPanel />);
    for (const select of [picker(), policyPicker()]) {
      expect(select.classList.contains(rowStyles.controlField)).toBe(true);
    }
  });
});

/* ===========================================================================
 * R-331 — A SETTING IS ANSWERED FOR A PLACE, NOT ONLY FOR THE COMPANY.
 *
 * The maintainer, session 62: *"These settings I think cannot be applied plant
 * wise which defeats the purpose of both options. Lets make it possible to
 * assign settings individually for each plant."*
 *
 * ⛔⛔ THREE STATES, NOT TWO, AND THE FIRST ONE IS THE REASON MIGRATION 0050
 * SPENT A TABLE. A plant is INHERITING (no `node_settings` row), SET TO ALLOW,
 * or SET TO REFUSE. A two-option picker cannot express the first, and a plant
 * nobody has ever touched must not read as though somebody chose its current
 * behaviour — because the two behave differently the day the company changes
 * its mind: an inheriting plant follows, a set one does not.
 *
 * So the control has THREE options and the first is "use the company setting",
 * which is also how a plant is returned to inheriting: choosing it calls
 * `clear_node_setting`, the separate verb, never `set` with a null.
 *
 * ⚠️ AND ONLY PLANTS THE READER CAN ACTUALLY WRITE GET A CONTROL. The server's
 * test is `app_is_admin() or app_is_admin_for(node)`; `src/test/plantSettings.test.ts`
 * pins the client mirror of it. Here we pin what the screen DOES with the
 * answer: a picker where it is true, a sentence naming the place where it is
 * false — D106's rule that a disabled control is a control named after
 * something it does not do.
 * ======================================================================== */
describe("R-331: each plant's own answer, kept apart from the company's", () => {
  it("offers three states per plant, not two", () => {
    render(<SettingsPanel />);
    const select = plantPicker("Plant A");
    const options = within(select).getAllByRole("option");
    expect(options.map((o) => o.getAttribute("value"))).toEqual(["inherit", "warn", "block"]);
  });

  it("labels the plant's options by consequence, never by the stored word", () => {
    render(<SettingsPanel />);
    const texts = within(plantPicker("Plant A"))
      .getAllByRole("option")
      .map((o) => (o.textContent ?? "").trim());
    expect(texts[1]).toBe("Allow it, with a reason on record");
    expect(texts[2]).toBe("Refuse it — no exceptions");
    for (const t of texts) {
      expect(t.toLowerCase()).not.toBe("warn");
      expect(t.toLowerCase()).not.toBe("block");
    }
  });

  /**
   * ⛔ THE CASE THE WHOLE FEATURE TURNS ON. Plant A has no row and resolves to
   * "warn"; the company is on "warn". The closed control must NOT read as
   * though somebody chose warn here — it must say the plant is inheriting, and
   * say what that currently means.
   */
  it("an untouched plant reads as inheriting, and says what it currently gets", () => {
    render(<SettingsPanel />);
    const select = plantPicker("Plant A");
    expect(select.value).toBe("inherit");
    const shown = within(select).getAllByRole("option")[0];
    expect(shown.textContent).toMatch(/company/i);
    expect(shown.textContent).toMatch(/Allowed with a reason/);
    expect(
      screen.getByText(/Inheriting from the company — currently Allowed with a reason/),
    ).toBeTruthy();
  });

  it("says the inheriting plant will follow the company when the company moves", () => {
    render(<SettingsPanel />);
    expect(screen.getByText(/Inheriting from the company/)).toBeTruthy();
    expect(screen.getByText(/follows/i)).toBeTruthy();
  });

  it("an inheriting plant tracks the company's answer rather than a stored one", () => {
    h.state.policy = "block";
    h.state.plants = [
      { nodeId: "a", name: "Plant A", override: null, effective: "block", editable: true },
    ];
    render(<SettingsPanel />);
    expect(plantPicker("Plant A").value).toBe("inherit");
    expect(within(plantPicker("Plant A")).getAllByRole("option")[0].textContent).toMatch(/Refused/);
    expect(screen.getByText(/Inheriting from the company — currently Refused/)).toBeTruthy();
  });

  it("a plant with its own answer says so, and says it will not follow the company", () => {
    render(<SettingsPanel />);
    const select = plantPicker("Plant B");
    expect(select.value).toBe("block");
    expect(screen.getByText(/Set for this plant — Refused/)).toBeTruthy();
    expect(screen.getByText(/does not follow the company/i)).toBeTruthy();
  });

  /**
   * ⛔ "SET TO THE SAME VALUE" IS NOT "INHERITING". Plant B below is set to
   * `warn` while the company is on `warn`; the screen must not show it as
   * inheriting, because the day the company moves to `block` this plant stays.
   */
  it("does not show a plant set to the company's current value as inheriting", () => {
    h.state.plants = [
      { nodeId: "b", name: "Plant B", override: "warn", effective: "warn", editable: true },
    ];
    render(<SettingsPanel />);
    expect(plantPicker("Plant B").value).toBe("warn");
    expect(screen.queryByText(/Inheriting from the company/)).toBeNull();
    expect(screen.getByText(/Set for this plant — Allowed with a reason/)).toBeTruthy();
  });

  it("gives a plant its own answer through set_node_setting's value", () => {
    render(<SettingsPanel />);
    fireEvent.change(plantPicker("Plant A"), { target: { value: "block" } });
    expect(h.setPlantMutate).toHaveBeenCalledWith({ nodeId: "a", choice: "block" });
  });

  /**
   * ⛔ RETURNING TO INHERITING IS ITS OWN VERB. `clear_node_setting`, never
   * `set_node_setting(..., null)` — "set to nothing" is precisely the state
   * migration 0050 spent a table avoiding.
   */
  it("returns a plant to inheriting by choosing the company option", () => {
    render(<SettingsPanel />);
    fireEvent.change(plantPicker("Plant B"), { target: { value: "inherit" } });
    expect(h.setPlantMutate).toHaveBeenCalledWith({ nodeId: "b", choice: "inherit" });
  });

  it("shows saving on the plant being written and not on its neighbour", () => {
    h.state.plantPending = "b";
    render(<SettingsPanel />);
    expect(plantPicker("Plant B").disabled).toBe(true);
    expect(plantPicker("Plant A").disabled).toBe(false);
    expect(screen.getAllByText("Saving…")).toHaveLength(1);
  });

  it("shows a refused plant write rather than leaving the choice looking saved", () => {
    h.state.plantPending = "b";
    h.state.plantError = "you are not an admin of that plant";
    render(<SettingsPanel />);
    expect(screen.getByText("you are not an admin of that plant")).toBeTruthy();
  });

  /**
   * ⚠️ A PLANT THE READER MAY NOT WRITE GETS NO PICKER AT ALL — not a disabled
   * one. The server refuses `set_node_setting` for it (`app_is_admin_for`), and
   * D106's rule is that a greyed control is a control named after something it
   * does not do. It is still LISTED, with what is in force there, because
   * silently dropping it is `scope.ts`'s invisible-and-permanent failure.
   */
  it("lists a plant the reader cannot administer, with no control and a reason", () => {
    h.state.plants = [
      { nodeId: "a", name: "Plant A", override: null, effective: "warn", editable: true },
      { nodeId: "c", name: "Plant C", override: "block", effective: "block", editable: false },
    ];
    render(<SettingsPanel />);
    expect(plantPicker("Plant A")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Plant C" })).toBeNull();
    expect(screen.getByText("Plant C")).toBeTruthy();
    expect(screen.getByText(/isn’t a place you manage/)).toBeTruthy();
    // and what is actually in force there is still readable
    expect(screen.getByText(/Set for this plant — Refused/)).toBeTruthy();
  });

  /**
   * ⚠️ A SITE ADMIN IS THE WHOLE POINT OF R-331. They reach this screen
   * (`adminSectionsFor` returns "all" for anyone with an admin grant anywhere),
   * cannot move the COMPANY setting — `set_org_eligibility_policy` is
   * `app_is_admin()` — and CAN move their own plant's.
   */
  it("a site admin cannot move the company setting but can move their own plant", () => {
    h.state.profile.role = "viewer";
    h.state.plants = [
      { nodeId: "a", name: "Plant A", override: null, effective: "warn", editable: true },
      { nodeId: "b", name: "Plant B", override: null, effective: "warn", editable: false },
    ];
    render(<SettingsPanel />);
    expect(policyPicker().disabled).toBe(true);
    expect(screen.getByText("Only a system admin can change this.")).toBeTruthy();
    const mine = plantPicker("Plant A");
    expect(mine.disabled).toBe(false);
    fireEvent.change(mine, { target: { value: "block" } });
    expect(h.setPlantMutate).toHaveBeenCalledWith({ nodeId: "a", choice: "block" });
    expect(screen.queryByRole("combobox", { name: "Plant B" })).toBeNull();
  });

  it("offers no control at all for a plant the reader was not offered", () => {
    h.state.plants = [
      { nodeId: "c", name: "Plant C", override: null, effective: "warn", editable: false },
    ];
    const { container } = render(<SettingsPanel />);
    expect(container.querySelectorAll("select[id^=settings-plant-policy]")).toHaveLength(0);
    expect(h.setPlantMutate).not.toHaveBeenCalled();
  });

  it("says so plainly when the plant list could not be read", () => {
    h.state.plantsError = "could not read plants";
    h.state.plants = [];
    render(<SettingsPanel />);
    expect(screen.getByText("could not read plants")).toBeTruthy();
  });

  it("says so when there is no plant to set, rather than showing an empty card", () => {
    h.state.plants = [];
    render(<SettingsPanel />);
    expect(screen.getByText(/no plants/i)).toBeTruthy();
  });
});
