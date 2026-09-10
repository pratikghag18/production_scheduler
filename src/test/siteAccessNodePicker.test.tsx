import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SiteAccessPanel } from "@/features/admin/components/SiteAccessPanel";

/**
 * R-367 on the screen: the node picker in the Add flow, and the Move control on
 * a member row, reach the DOM and call `set_site_member` / `remove_site_member`
 * with the NODE the admin chose. The pure decisions (`subtreeOptions`,
 * `rolesForNode`, `moveTargets`, `canManageAccess`) are proved in
 * `siteAccess.test.ts`; this asserts they are wired.
 *
 * The three membership hooks are mocked at the boundary. The set spy invokes
 * its `onSuccess` so a MOVE's second call (remove the old node) actually fires,
 * which is the only way to prove the two-step compose from the outside.
 */

const peopleData = vi.hoisted(() => ({ current: null as unknown }));
const spies = vi.hoisted(() => ({
  set: vi.fn(),
  remove: vi.fn(),
}));

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
    useRemoveSiteMember: () => ({ mutate: spies.remove, isPending: false }),
  };
});

const NODES = [
  { nodeId: "plantA", name: "Plant A", path: "plant_a" },
  { nodeId: "lineA1", name: "Line 1", path: "plant_a.line_1" },
  { nodeId: "lineA2", name: "Line 2", path: "plant_a.line_2" },
];

const PAYLOAD = {
  nodeId: "plantA",
  nodeName: "Plant A",
  people: [
    {
      profileId: "sam",
      email: "sam@example.test",
      companyAdmin: false,
      grants: [{ nodeId: "plantA", nodeName: "Plant A", role: "supervisor" }],
    },
    {
      profileId: "boss",
      email: "boss@example.test",
      companyAdmin: false,
      grants: [{ nodeId: "plantA", nodeName: "Plant A", role: "admin" }],
    },
    {
      profileId: "nobody",
      email: "nobody@example.test",
      companyAdmin: false,
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
      nodes={NODES}
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
  spies.remove.mockReset();
  // The set spy resolves so a move's second (remove) call fires.
  spies.set.mockImplementation((_vars, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.());
});

function searchFor(text: string) {
  fireEvent.change(screen.getByLabelText(/Find someone here/i), { target: { value: text } });
}

describe("R-367 Add flow: the node picker", () => {
  it("offers the plant root and every node beneath it", () => {
    render(panel(), { wrapper: wrapper() });
    searchFor("nobody@example.test");
    const place = screen.getByLabelText(/Place to give nobody@example.test access/i);
    const options = within(place as HTMLElement)
      .getAllByRole("option")
      .map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(["plantA", "lineA1", "lineA2"]);
  });

  it("drops the admin role once a node below the root is chosen", () => {
    render(panel(), { wrapper: wrapper() });
    searchFor("nobody@example.test");
    const roleAtRoot = within(
      screen.getByText("nobody@example.test").closest("li")!,
    ).getByLabelText(/Role to give/i);
    // At the plant root the admin role is on offer...
    expect(
      within(roleAtRoot as HTMLElement)
        .getAllByRole("option")
        .map((o) => (o as HTMLOptionElement).value),
    ).toContain("admin");
    // ...and gone the moment a line is chosen.
    fireEvent.change(screen.getByLabelText(/Place to give nobody@example.test access/i), {
      target: { value: "lineA1" },
    });
    expect(
      within(roleAtRoot as HTMLElement)
        .getAllByRole("option")
        .map((o) => (o as HTMLOptionElement).value),
    ).not.toContain("admin");
  });

  it("grants at the chosen node, not the plant root", () => {
    render(panel(), { wrapper: wrapper() });
    searchFor("nobody@example.test");
    fireEvent.change(screen.getByLabelText(/Place to give nobody@example.test access/i), {
      target: { value: "lineA2" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Give nobody@example.test access/i }));
    expect(spies.set).toHaveBeenCalledTimes(1);
    expect(spies.set.mock.calls[0][0]).toMatchObject({ nodeId: "lineA2", profileId: "nobody" });
  });

  it("is hidden from someone who is neither a system admin nor a site admin", () => {
    render(panel({ companyAdmin: false, adminAnywhere: false }), { wrapper: wrapper() });
    searchFor("nobody@example.test");
    expect(screen.queryByLabelText(/Place to give nobody@example.test access/i)).toBeNull();
  });
});

describe("R-367 Move flow: an existing member", () => {
  it("shows a Move control for a supervisor and composes set-new then remove-old", () => {
    render(panel(), { wrapper: wrapper() });
    const move = screen.getByLabelText(/Move sam@example.test to a different place/i);
    fireEvent.change(move, { target: { value: "lineA1" } });
    // set at the NEW node, carrying the role...
    expect(spies.set).toHaveBeenCalledTimes(1);
    expect(spies.set.mock.calls[0][0]).toMatchObject({
      nodeId: "lineA1",
      profileId: "sam",
      role: "supervisor",
    });
    // ...then remove the OLD node.
    expect(spies.remove).toHaveBeenCalledTimes(1);
    expect(spies.remove.mock.calls[0][0]).toMatchObject({ nodeId: "plantA", profileId: "sam" });
  });

  it("offers no Move for an admin, whose only valid node is the plant root", () => {
    render(panel(), { wrapper: wrapper() });
    expect(screen.queryByLabelText(/Move boss@example.test to a different place/i)).toBeNull();
  });

  it("is hidden from someone who is neither a system admin nor a site admin", () => {
    render(panel({ companyAdmin: false, adminAnywhere: false }), { wrapper: wrapper() });
    expect(screen.queryByLabelText(/Move sam@example.test to a different place/i)).toBeNull();
  });
});
