import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { SettingsPanel } from "@/features/admin/components/SettingsPanel";
import { DATE_FORMATS, formatCalendarDay } from "@/lib/format/dates";

/**
 * THE SETTINGS TAB IS ONE ROW PER SETTING (R-310).
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
}));

function picker(): HTMLSelectElement {
  return screen.getByRole("combobox", { name: "Date format" }) as HTMLSelectElement;
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
  h.state.profile.role = "admin";
  h.state.profile.adminAnywhere = true;
  h.state.format = "d_mon_yyyy";
  h.state.pending = false;
  h.state.error = null;
});

describe("R-310: the settings tab is one row per setting", () => {
  it("offers the date format as one dropdown, not a row per format", () => {
    render(<SettingsPanel />);
    expect(picker()).toBeTruthy();
    // The eight formats used to be eight controls in the pane; now they are
    // eight options inside one. Anything else is the crowding this replaced.
    expect(screen.queryAllByRole("radio")).toEqual([]);
    expect(screen.queryAllByRole("radiogroup")).toEqual([]);
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
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
