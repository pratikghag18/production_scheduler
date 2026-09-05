import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { SettingsPanel } from "@/features/admin/components/SettingsPanel";
import { DATE_FORMATS, formatCalendarDay } from "@/lib/format/dates";

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
  },
  setPolicyMutate: vi.fn(),
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
});

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
