import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SiteAccessPanel } from "@/features/admin/components/SiteAccessPanel";

/**
 * R-442 (S66-b): the Access tab's own two controls, beside the role —
 * "Plans" (whole day, or a band of the place's pattern) and "May place
 * outside their shift" (on by default). SA-1..SA-4 from the brief:
 *
 *   SA1  the defaults: Whole day, checked
 *   SA2  a supervisor viewing an admin's grant sees no controls at all —
 *        the same `canSetRole` gate the role dropdown already uses, so the
 *        two behave identically rather than one being a new kind of hole
 *   SA3  a save writes BOTH fields, with the CURRENT role unchanged
 *   SA4  a viewer's row is unchanged by another row's save
 *
 * `useSitePeople` / `useSetSiteMember` are mocked at the hook boundary, the
 * same shape `siteAccessNodePicker.test.tsx` uses; `useShiftPatterns` is
 * mocked with a real pattern attached to the plant, so "Plans" has bands to
 * offer.
 *
 * ⚠️⚠️ CORRECTED 18 Sept (session 179), the maintainer on the S66-b build:
 * "it should have been a new column, not a new row with the same column."
 * The two controls first shipped as a full-width line under the row
 * (`.shiftPlanRow`); they are two headed COLUMNS on the grant's own row now,
 * right after Access level, under the same `canSetRole` test the role
 * dropdown runs. SA1-SA4 (and their sub-cases) query by accessible name, so
 * they kept passing unchanged through the move — a query by role and name
 * cannot see WHERE on the row a control sits. `SA-columns` below is the case
 * that pins the correction itself: the two controls are direct children of
 * the same `<li>` the role control sits on (a sibling grid cell, not a
 * wrapper's grandchild), and the header names both, right after "Access
 * level". Rewritten to say so, per the maintainer's words (R-442).
 */

const peopleData = vi.hoisted(() => ({ current: null as unknown }));
const spies = vi.hoisted(() => ({ set: vi.fn() }));

vi.mock("@/features/admin/hooks/useSiteAccess", async (importActual) => {
  const actual = await importActual<typeof import("@/features/admin/hooks/useSiteAccess")>();
  return {
    ...actual,
    useSitePeople: () => ({
      data: peopleData.current,
      isLoading: false,
      isError: false,
      error: null,
    }),
    useSetSiteMember: () => ({ mutate: spies.set, isPending: false }),
    useRemoveSiteMember: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

vi.mock("@/features/auth/useSession", () => ({
  useSession: () => ({ session: { user: { id: "viewer-1" } }, profile: null, loading: false }),
}));

const SHIFT_PATTERNS = {
  templates: [{ id: "tpl-1", name: "Standard", siteNodeId: "plantA", active: true }],
  shifts: [
    { id: "sh-1", templateId: "tpl-1", name: "Shift 1", startMin: 360, endMin: 840 },
    { id: "sh-2", templateId: "tpl-1", name: "Shift 2", startMin: 840, endMin: 1320 },
  ],
  breaks: [],
  attachments: [{ nodeId: "plantA", templateId: "tpl-1" }],
  nodes: [{ id: "plantA", name: "Plant A", parentId: null, path: "plant_a" }],
};

vi.mock("@/features/admin/hooks/useShifts", () => ({
  useShiftPatterns: () => ({ data: SHIFT_PATTERNS, isLoading: false, isError: false, error: null }),
}));

const PAYLOAD = {
  nodeId: "plantA",
  nodeName: "Plant A",
  people: [
    {
      profileId: "sam",
      email: "sam@example.test",
      companyAdmin: false,
      grants: [
        {
          nodeId: "plantA",
          nodeName: "Plant A",
          role: "supervisor",
          plansShiftId: null,
          outsideShift: true,
        },
      ],
    },
    {
      profileId: "dana",
      email: "dana@example.test",
      companyAdmin: false,
      grants: [
        {
          nodeId: "plantA",
          nodeName: "Plant A",
          role: "supervisor",
          plansShiftId: "sh-1",
          outsideShift: false,
        },
      ],
    },
    {
      profileId: "boss",
      email: "boss@example.test",
      companyAdmin: true,
      grants: [],
    },
  ],
};

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function panel(over: { companyAdmin?: boolean; adminAnywhere?: boolean } = {}) {
  return (
    <SiteAccessPanel
      places={[{ nodeId: "plantA", name: "Plant A" }]}
      nodes={[{ nodeId: "plantA", name: "Plant A", path: "plant_a" }]}
      treeLoading={false}
      viewerProfileId="viewer-1"
      viewerIsCompanyAdmin={over.companyAdmin ?? true}
      viewerAdminAnywhere={over.adminAnywhere ?? false}
    />
  );
}

beforeEach(() => {
  peopleData.current = PAYLOAD;
  spies.set.mockReset();
});

function plansSelectFor(email: string): HTMLSelectElement {
  return screen.getByRole("combobox", { name: `Plans for ${email}` }) as HTMLSelectElement;
}
function outsideCheckboxFor(email: string): HTMLInputElement {
  return screen.getByRole("checkbox", {
    name: `${email} may place outside their shift`,
  }) as HTMLInputElement;
}

describe("SiteAccessPanel — the shift plan controls (R-442)", () => {
  it("SA1: the defaults are Whole day and the checkbox on", () => {
    render(panel(), { wrapper: wrapper() });
    expect(plansSelectFor("sam@example.test").value).toBe("");
    expect(within(plansSelectFor("sam@example.test")).getAllByRole("option")[0].textContent).toBe(
      "Whole day",
    );
    expect(outsideCheckboxFor("sam@example.test").checked).toBe(true);
  });

  it("SA1b: the picker lists exactly the plant's own bands", () => {
    render(panel(), { wrapper: wrapper() });
    const options = within(plansSelectFor("sam@example.test"))
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toEqual(["Whole day", "Shift 1", "Shift 2"]);
  });

  it("SA1c: a grant already restricted reads its own band and unchecked box", () => {
    render(panel(), { wrapper: wrapper() });
    expect(plansSelectFor("dana@example.test").value).toBe("sh-1");
    expect(outsideCheckboxFor("dana@example.test").checked).toBe(false);
  });

  it("SA2 ⭐⭐ a site admin (not company admin) sees no shift-plan controls on a company admin's row — the same test the role control uses", () => {
    render(panel({ companyAdmin: false, adminAnywhere: true }), { wrapper: wrapper() });
    // sam's row (an ordinary supervisor) still gets the controls...
    expect(plansSelectFor("sam@example.test")).toBeTruthy();
    // ...but boss (a company admin) does not: canSetRole refuses the whole
    // row, exactly as it already refuses the role dropdown.
    expect(screen.queryByRole("combobox", { name: "Plans for boss@example.test" })).toBeNull();
    expect(
      screen.queryByRole("checkbox", { name: "boss@example.test may place outside their shift" }),
    ).toBeNull();
  });

  it("SA3 ⭐⭐ choosing a band writes both fields, with the CURRENT role unchanged", () => {
    render(panel(), { wrapper: wrapper() });
    fireEvent.change(plansSelectFor("sam@example.test"), { target: { value: "sh-2" } });
    expect(spies.set).toHaveBeenCalledTimes(1);
    const sent = spies.set.mock.calls[0][0] as {
      nodeId: string;
      profileId: string;
      role: string;
      plansShiftId: string | null;
      outsideShift: boolean;
    };
    expect(sent.profileId).toBe("sam");
    expect(sent.role).toBe("supervisor");
    expect(sent.plansShiftId).toBe("sh-2");
    expect(sent.outsideShift).toBe(true);
  });

  it("SA3b: unchecking 'may place outside their shift' writes outsideShift false, plansShiftId unchanged", () => {
    render(panel(), { wrapper: wrapper() });
    // sam starts unrestricted (Whole day, checked) — unchecking the box must
    // not also invent a band nobody chose.
    fireEvent.click(outsideCheckboxFor("sam@example.test"));
    const sent = spies.set.mock.calls[0][0] as {
      plansShiftId: string | null;
      outsideShift: boolean;
    };
    expect(sent.plansShiftId).toBeNull();
    expect(sent.outsideShift).toBe(false);
  });

  it("SA3c: choosing 'Whole day' writes null, not the empty string", () => {
    render(panel(), { wrapper: wrapper() });
    fireEvent.change(plansSelectFor("dana@example.test"), { target: { value: "" } });
    const sent = spies.set.mock.calls[0][0] as { plansShiftId: string | null };
    expect(sent.plansShiftId).toBeNull();
  });

  it("SA4: saving one row's shift plan does not touch another row's controls", () => {
    render(panel(), { wrapper: wrapper() });
    fireEvent.change(plansSelectFor("sam@example.test"), { target: { value: "sh-1" } });
    // dana's own row is untouched — the mock does not re-render with new
    // server data, so her control still reads what the fixture gave her.
    expect(plansSelectFor("dana@example.test").value).toBe("sh-1");
    expect(outsideCheckboxFor("dana@example.test").checked).toBe(false);
    expect(spies.set).toHaveBeenCalledTimes(1);
    expect((spies.set.mock.calls[0][0] as { profileId: string }).profileId).toBe("sam");
  });

  it("SA-columns ⭐⭐ CORRECTED 18 Sept: Plans and 'may place outside their shift' are columns on the grant's own row, headed, right after Access level — never a second row under the person", () => {
    render(panel(), { wrapper: wrapper() });
    // ⚠️ THE STRUCTURAL PROOF, NOT JUST THE ACCESSIBLE NAME. The old shape —
    // a `<div className={shiftPlanRow}>` wrapping both controls as their own
    // full-width line — would still answer `plansSelectFor` truthfully, so a
    // query by role and name alone cannot tell the two shapes apart. A direct
    // child of the same `<li>` the Access level select sits on (a sibling
    // grid cell, not a grandchild inside a wrapper) is what "a column on the
    // row" actually means in the DOM.
    const li = plansSelectFor("sam@example.test").closest("li");
    expect(li).not.toBeNull();
    expect(plansSelectFor("sam@example.test").parentElement).toBe(li);
    const outsideLabel = outsideCheckboxFor("sam@example.test").closest("label");
    expect(outsideLabel?.parentElement).toBe(li);
    // And the header names both columns, in that order, right after "Access
    // level" and before "Place" — the maintainer's own placement.
    const heading = screen.getByText("Access level").parentElement;
    expect(heading && [...heading.children].map((c) => c.textContent)).toEqual([
      "Person",
      "Access level",
      "Plans",
      "May place outside their shift",
      "Place",
      "",
      "",
    ]);
  });
});
