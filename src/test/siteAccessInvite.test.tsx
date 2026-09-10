import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SiteAccessPanel } from "@/features/admin/components/SiteAccessPanel";

/**
 * The Access panel's INVITE surface (P1-6c) on the screen: the invite control
 * is offered when an email search matches nobody in the company and NOT when it
 * matches someone, and the "invited" mark shows on a member who has never
 * signed in (0064). The pure decisions live in `invite.ts`
 * (`inviteFlow.test.ts`); this asserts they reach the DOM.
 *
 * The data hooks are mocked at the network boundary so the panel renders a
 * fixed `site_people` payload; `buildAccessRows`, `partitionAccess`,
 * `canOfferInvite` and `readInvitedPending` all run for real. The invite
 * mutation is never fired here (offer/mark only), so `invite()` is not called.
 */

const peopleData = vi.hoisted(() => ({ current: null as unknown }));

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
    useSetSiteMember: () => ({ mutate: vi.fn(), isPending: false }),
    useRemoveSiteMember: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function panel() {
  return (
    <SiteAccessPanel
      places={[{ nodeId: "plantA", name: "Plant A" }]}
      nodes={[{ nodeId: "plantA", name: "Plant A", path: "plant_a" }]}
      treeLoading={false}
      viewerProfileId="viewer-1"
      viewerIsCompanyAdmin
      viewerAdminAnywhere={false}
    />
  );
}

const PAYLOAD = {
  nodeId: "plantA",
  nodeName: "Plant A",
  people: [
    {
      profileId: "p1",
      email: "ana@example.test",
      companyAdmin: false,
      invitedPending: false,
      grants: [{ nodeId: "plantA", nodeName: "Plant A", role: "viewer" }],
    },
    {
      profileId: "p2",
      email: "zoe@example.test",
      companyAdmin: false,
      invitedPending: true,
      grants: [{ nodeId: "plantA", nodeName: "Plant A", role: "viewer" }],
    },
  ],
};

beforeEach(() => {
  peopleData.current = PAYLOAD;
});

describe("SiteAccessPanel: the invited mark (0064)", () => {
  it("marks a member who has never signed in, and not one who has", () => {
    render(panel(), { wrapper: wrapper() });
    const zoe = screen.getByText("zoe@example.test").closest("li")!;
    const ana = screen.getByText("ana@example.test").closest("li")!;
    expect(within(zoe).getByText("invited")).toBeTruthy();
    expect(within(ana).queryByText("invited")).toBeNull();
  });
});

describe("SiteAccessPanel: the invite control", () => {
  it("is offered when an email search matches NOBODY in the company", () => {
    render(panel(), { wrapper: wrapper() });
    fireEvent.change(screen.getByLabelText(/search the company by email/i), {
      target: { value: "newcomer@example.test" },
    });
    // The invite lead names the address and the place; the button offers a role.
    expect(screen.getByText(/Invite them to Plant A/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Invite as/i })).toBeTruthy();
    expect(screen.getByText("newcomer@example.test")).toBeTruthy();
  });

  it("is NOT offered when the email search matches an existing person", () => {
    render(panel(), { wrapper: wrapper() });
    fireEvent.change(screen.getByLabelText(/search the company by email/i), {
      target: { value: "ana@example.test" },
    });
    expect(screen.queryByRole("button", { name: /Invite as/i })).toBeNull();
    expect(screen.queryByText(/Invite them to/i)).toBeNull();
  });

  it("is NOT offered for a name search that is not an email", () => {
    render(panel(), { wrapper: wrapper() });
    fireEvent.change(screen.getByLabelText(/search the company by email/i), {
      target: { value: "newcomer" },
    });
    expect(screen.queryByRole("button", { name: /Invite as/i })).toBeNull();
  });
});
