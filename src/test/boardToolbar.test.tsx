/**
 * S67 (R-445, F-170): the board toolbar as one row plus "Show more".
 *
 * TB-1..TB-4: the three demo roles' rights, cascaded to the BAND'S LAYOUT --
 * not just which buttons are offered inside "Week plan", but whether the
 * group itself renders at all (CLAUDE.md §4/§7: whatever a client offers is
 * decided by the same test the server runs, extended here to whether a whole
 * labelled group is worth drawing). "Key" is the control-free group: it never
 * disappears, because the two status swatches are not gated on any rights
 * check.
 *
 * TB-5/TB-6: the key (R-445 DECIDED) -- filtered to products with a run in
 * the shown window, sorted by name, locale-aware.
 *
 * TB-7/TB-8: F-170 -- the snap note is gone outright (the finding's own
 * default), and the end-of-window note renders only at the edge of the
 * loaded window, with no brief id in its text.
 *
 * ⚠️ THE MOCKS STOP AT THE NETWORK BOUNDARY, same rule `copyWeek.test.tsx`
 * and `copyWeekDialogTemplate.test.tsx` already follow: `@/lib/api` is the
 * real module with only the two rights RPCs replaced.
 */
import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Product } from "@/lib/api";
import { BoardToolbar } from "@/features/board/components/BoardToolbar";

const h = vi.hoisted(() => ({
  isAdminFor: vi.fn(),
  canPlace: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchIsAdminFor: h.isAdminFor,
  fetchCanPlaceInPlant: h.canPlace,
}));

const PLANT = { id: "plant-a", name: "Plant A", path: "plant_a" };
const WINDOW_START = new Date("2026-09-07T00:00:00.000Z");

function product(id: string, name: string, colorToken = "product-1"): Product {
  return {
    id,
    sku: id,
    name,
    active: true,
    siteNodeIds: [],
    offeredNodeIds: [],
    colorToken,
  };
}

/** The three demo roles this toolbar's rights actually branch on -- an
 *  admin (both RPCs true), a placing supervisor (canPlace only), and a
 *  viewer (neither), the same three `e2e/roleWalk.spec.ts` walks. */
type Role = "admin" | "supervisor" | "viewer";

function mockRole(role: Role) {
  h.isAdminFor.mockResolvedValue(role === "admin");
  h.canPlace.mockResolvedValue(role === "admin" || role === "supervisor");
}

function renderToolbar(over: Partial<React.ComponentProps<typeof BoardToolbar>> = {}) {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <BoardToolbar
        roots={[PLANT]}
        rootPath={PLANT.path}
        onRootChange={() => {}}
        zoomIndex={1}
        onZoomChange={() => {}}
        windowStartDate={WINDOW_START}
        windowDayCount={3}
        onWindowChange={() => {}}
        onShiftWindowByDays={() => {}}
        onGoToToday={() => {}}
        products={[]}
        isFetching={false}
        {...over}
      />
    </QueryClientProvider>,
  );
}

function showMoreButton() {
  return screen.getByRole("button", { name: /^Show (more|less)$/ });
}

beforeEach(() => {
  h.isAdminFor.mockReset();
  h.canPlace.mockReset();
});

describe("S67: one row, closed on a fresh board", () => {
  it("never shows the band's contents in the row -- Show more starts closed", async () => {
    mockRole("admin");
    renderToolbar();
    // The toggle itself is always in the row.
    const toggle = showMoreButton();
    expect(toggle.textContent).toBe("Show more");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // Even for the highest-rights role, nothing the band holds has leaked
    // into the row before it is opened.
    await screen.findByRole("button", { name: "Prev day" }); // sanity: row rendered
    expect(screen.queryByText("Week plan")).toBeNull();
    expect(screen.queryByText("Key")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy week" })).toBeNull();
  });

  it("the button toggles, and remembers aria-expanded/aria-controls in step", async () => {
    mockRole("viewer");
    renderToolbar();
    const toggle = showMoreButton();
    const bandId = toggle.getAttribute("aria-controls");
    expect(bandId).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.textContent).toBe("Show less");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(bandId!)).not.toBeNull();
    fireEvent.click(toggle);
    expect(toggle.textContent).toBe("Show more");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(bandId!)).toBeNull();
  });

  it("Escape inside the band closes it; the band is a layer, not a dropdown that closes on any outside click", async () => {
    mockRole("admin");
    renderToolbar();
    fireEvent.click(showMoreButton());
    expect(showMoreButton().textContent).toBe("Show less");
    const band = document.getElementById(showMoreButton().getAttribute("aria-controls")!)!;
    fireEvent.keyDown(band, { key: "Escape" });
    expect(showMoreButton().textContent).toBe("Show more");
  });

  /** TR-2 (reviewer, S67-a review): Escape used to close the band without
   *  moving focus anywhere -- fine from the toggle itself, but a keyboard
   *  user tabbed onto a button INSIDE the band (which unmounts on the same
   *  render) lost focus outright (it falls back to `<body>`), the same
   *  failure mode `CommandLauncher`'s own panel already guards against for
   *  its own Escape/close ("close always returns focus to the launcher
   *  button"). This band gets the same rule. */
  it("TR-2: Escape from a button inside the band returns focus to the toggle", async () => {
    mockRole("admin");
    renderToolbar();
    const toggle = showMoreButton();
    fireEvent.click(toggle);
    const copyWeek = await screen.findByRole("button", { name: "Copy week" });
    copyWeek.focus();
    expect(document.activeElement).toBe(copyWeek);
    fireEvent.keyDown(copyWeek, { key: "Escape" });
    expect(showMoreButton().textContent).toBe("Show more");
    expect(document.activeElement).toBe(showMoreButton());
  });
});

describe("TB-1..TB-4: the band's labelled groups, cascaded from the three demo roles' rights", () => {
  it("TB-1: an admin sees every Week plan control, and Key, once opened", async () => {
    mockRole("admin");
    renderToolbar();
    fireEvent.click(showMoreButton());
    await screen.findByText("Week plan");
    expect(screen.getByRole("button", { name: "Copy week" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply a template" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save this week as a template" })).toBeTruthy();
    expect(screen.getByText("Key")).toBeTruthy();
  });

  it("TB-2: a placing supervisor sees Apply and Save, but not Copy week (S35 stays admin-only)", async () => {
    mockRole("supervisor");
    renderToolbar();
    fireEvent.click(showMoreButton());
    await screen.findByText("Week plan");
    expect(screen.getByRole("button", { name: "Apply a template" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save this week as a template" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy week" })).toBeNull();
  });

  it("TB-3: a viewer gets no Week plan controls -- the GROUP itself is not rendered, only Key is", async () => {
    mockRole("viewer");
    renderToolbar();
    fireEvent.click(showMoreButton());
    await screen.findByText("Key");
    // Not just the buttons absent -- the heading itself never renders, the
    // rights cascade reaching the layout (R-445), not merely the controls.
    expect(screen.queryByText("Week plan")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy week" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply a template" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save this week as a template" })).toBeNull();
  });

  it("TB-4: a viewer's toolbar is shorter -- no Week plan group, in either the row or the band", async () => {
    mockRole("viewer");
    renderToolbar();
    // Closed:
    expect(screen.queryByText("Week plan")).toBeNull();
    // Open:
    fireEvent.click(showMoreButton());
    await screen.findByText("Key");
    expect(screen.queryByText("Week plan")).toBeNull();
  });
});

describe("TB-5/TB-6: the key -- only products with a run in the shown window, sorted by name", () => {
  const products: Product[] = [
    product("p-zed", "Zed Widget"),
    product("p-apple", "Apple Widget"),
    product("p-none", "No-run Gadget"),
    product("p-mid", "Midway Part"),
  ];

  it("TB-5: a product with no run in the window is absent from the key", async () => {
    mockRole("viewer");
    renderToolbar({
      products,
      productIdsInWindow: new Set(["p-zed", "p-apple"]),
    });
    fireEvent.click(showMoreButton());
    await screen.findByText("Key");
    expect(screen.getByText("Zed Widget")).toBeTruthy();
    expect(screen.getByText("Apple Widget")).toBeTruthy();
    expect(screen.queryByText("No-run Gadget")).toBeNull();
    expect(screen.queryByText("Midway Part")).toBeNull();
  });

  it("TB-6: the key is ordered by name, not by the order runs happen to list products", async () => {
    mockRole("viewer");
    renderToolbar({
      products,
      productIdsInWindow: new Set(["p-zed", "p-apple", "p-mid"]),
    });
    fireEvent.click(showMoreButton());
    const key = document.getElementById(showMoreButton().getAttribute("aria-controls")!)!;
    await within(key).findByText("Apple Widget");
    const names = within(key)
      .getAllByText(/Widget|Part/)
      .map((el) => el.textContent);
    expect(names).toEqual(["Apple Widget", "Midway Part", "Zed Widget"]);
  });
});

describe("TB-7/TB-8: F-170 -- no brief id shipped as a label, and the edge note is conditional", () => {
  it("TB-7: the snap note is gone outright, in the row and in the band", async () => {
    mockRole("admin");
    renderToolbar();
    expect(screen.queryByText(/snap/i)).toBeNull();
    expect(screen.queryByText(/P1-4b/)).toBeNull();
    fireEvent.click(showMoreButton());
    await screen.findByText("Key");
    expect(screen.queryByText(/snap/i)).toBeNull();
    expect(screen.queryByText(/P1-4b/)).toBeNull();
  });

  it("TB-8: the end-of-window note is absent by default and appears only when atWindowEnd is true, with no brief id in its title", async () => {
    mockRole("viewer");
    const queryClient = new QueryClient();
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <BoardToolbar
          roots={[PLANT]}
          rootPath={PLANT.path}
          onRootChange={() => {}}
          zoomIndex={1}
          onZoomChange={() => {}}
          windowStartDate={WINDOW_START}
          windowDayCount={3}
          onWindowChange={() => {}}
          onShiftWindowByDays={() => {}}
          onGoToToday={() => {}}
          products={[]}
          isFetching={false}
          atWindowEnd={false}
        />
      </QueryClientProvider>,
    );
    expect(screen.queryByText(/widen/i)).toBeNull();

    rerender(
      <QueryClientProvider client={queryClient}>
        <BoardToolbar
          roots={[PLANT]}
          rootPath={PLANT.path}
          onRootChange={() => {}}
          zoomIndex={1}
          onZoomChange={() => {}}
          windowStartDate={WINDOW_START}
          windowDayCount={3}
          onWindowChange={() => {}}
          onShiftWindowByDays={() => {}}
          onGoToToday={() => {}}
          products={[]}
          isFetching={false}
          atWindowEnd={true}
        />
      </QueryClientProvider>,
    );
    const note = await screen.findByText(/widen/i);
    expect(note).toBeTruthy();
    expect(note.getAttribute("title") ?? "").not.toMatch(/P1-4a/);
  });
});
