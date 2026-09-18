/**
 * S67-b (R-445 CORRECTED 18 Sept, F-170): the board toolbar as the
 * maintainer's mock, not the 17 Sept build's own reading of the row's
 * words -- "the product keys are missing from show more, the position of
 * the buttons is also not correct."
 *
 * TB-1..TB-4: the three demo roles' rights, cascaded to the BAND'S LAYOUT --
 * not just which buttons are offered inside "Week plan", but whether the
 * group itself renders at all (CLAUDE.md §4/§7: whatever a client offers is
 * decided by the same test the server runs, extended here to whether a whole
 * labelled group is worth drawing). "Key" is the control-free group: it never
 * disappears, because the two status swatches are not gated on any rights
 * check. ⚠️ THE CONTRACT CHANGED, not these cases' own logic: the Key's
 * heading now carries the catalogue's count ("Key — N products", R-445
 * CORRECTED), so the exact-string `getByText("Key")` these four used has
 * been widened to a `/^Key/` prefix match -- the assertions being made
 * (a group renders, or does not) are unchanged.
 *
 * TB-5/TB-6: the key. TB-5 is REWRITTEN, not merely touched up -- the 17
 * Sept build's own contract ("only products with a run in the shown
 * window") is exactly what the maintainer withdrew ("the product keys are
 * missing from show more" -- the filter left the key empty on a week with
 * no runs), so the case that pinned the old filter was pinning the bug
 * (CLAUDE.md §4). It now pins the opposite: every product in the readable
 * catalogue is listed, whether or not it has a run in the window, with the
 * count in the heading. TB-6 keeps its order pin (name order, locale-aware)
 * unchanged in substance, only widened to the full catalogue since
 * `productIdsInWindow` no longer exists to narrow it.
 *
 * TB-7/TB-8: F-170 -- the snap note is gone outright (the finding's own
 * default), and the end-of-window note renders only at the edge of the
 * loaded window, with no brief id in its text. Both stayed in the ROW in
 * the S67-b rebuild (the mock's "nothing else is in the row" describes its
 * six controls, not these two quiet, non-interactive notes, which are the
 * same shape as the mock's own named exception for "refreshing…").
 *
 * TB-9..TB-12 are new (S67-b): TB-9 pins the row's control order by
 * accessible name; TB-10 pins the range control's pop-over and its Escape
 * contract; TB-11 pins the band's two columns against the three demo
 * roles; TB-12 pins the toggle's visible text against its accessible name.
 *
 * ⚠️ REVIEWER, 18 Sept, SAME DAY: the lane's own build here read the mock's
 * plain "More" word literally -- a constant visible text with the
 * open/closed fact carried only in `aria-label`, which is why TB-12 and the
 * first `describe` below originally read `aria-expanded`/`aria-label`
 * rather than `textContent`. The maintainer, looking at the shipped band:
 * "The unexpanded view should show the Show More button and expanded view
 * should show the Show Less button. Just more button is meaningless." That
 * WITHDRAWS the aria-only reading, not the button's other behaviour: the
 * visible text goes back to naming the state ("Show more"/"Show less") and
 * IS the accessible name again, so these cases and TB-12 now assert
 * `textContent` directly, and also that `aria-label` is absent.
 * `e2e/toolbarShowMore.ts` needed no change -- it already read
 * `aria-expanded`, never the text.
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
/** TB-9: a second root so `shouldOfferRootPicker` renders the `<select>`
 *  the control-order pin looks for as the row's first interactive element. */
const PLANT2 = { id: "plant-b", name: "Plant B", path: "plant_b" };
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
  return render(
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

describe("S67-b: one row, closed on a fresh board", () => {
  it("never shows the band's contents in the row -- Show more starts closed", async () => {
    mockRole("admin");
    renderToolbar();
    // The toggle itself is always in the row.
    const toggle = showMoreButton();
    // TR-4 (reviewer, 18 Sept): "More" (state carried only in `aria-label`) is
    // withdrawn -- the maintainer called it meaningless. The visible text
    // names the state again and IS the accessible name; nothing splits them.
    expect(toggle.textContent).toBe("Show more");
    expect(toggle.getAttribute("aria-label")).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // Even for the highest-rights role, nothing the band holds has leaked
    // into the row before it is opened.
    await screen.findByRole("button", { name: "Prev day" }); // sanity: row rendered
    expect(screen.queryByText("Week plan")).toBeNull();
    expect(screen.queryByText(/^Key/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy week" })).toBeNull();
  });

  it("the button toggles, and remembers aria-expanded/aria-controls/its own text in step", async () => {
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
    expect(showMoreButton().getAttribute("aria-expanded")).toBe("true");
    const band = document.getElementById(showMoreButton().getAttribute("aria-controls")!)!;
    fireEvent.keyDown(band, { key: "Escape" });
    expect(showMoreButton().getAttribute("aria-expanded")).toBe("false");
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
    expect(showMoreButton().getAttribute("aria-expanded")).toBe("false");
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
    expect(screen.getByText(/^Key/)).toBeTruthy();
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
    await screen.findByText(/^Key/);
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
    await screen.findByText(/^Key/);
    expect(screen.queryByText("Week plan")).toBeNull();
  });
});

describe("TB-5/TB-6: the key -- the WHOLE readable catalogue, sorted by name, with its count", () => {
  const products: Product[] = [
    product("p-zed", "Zed Widget"),
    product("p-apple", "Apple Widget"),
    product("p-none", "No-run Gadget"),
    product("p-mid", "Midway Part"),
  ];

  /**
   * REWRITTEN (S67-b, R-445 CORRECTED 18 Sept) -- this used to pin
   * "a product with no run in the window is absent from the key" against
   * `productIdsInWindow`. That was the 17 Sept build's own contract, and
   * it is exactly what the maintainer withdrew: "the product keys are
   * missing from show more" was this filter leaving the key empty on a
   * week with no runs. The case was pinning the bug, not a fact worth
   * keeping (CLAUDE.md §4) -- there is no `productIdsInWindow` prop left
   * to filter by, and the new contract is the opposite of the old one.
   */
  it("TB-5: the key lists the WHOLE catalogue -- a product with no run in the window is still shown, with the count in the heading", async () => {
    mockRole("viewer");
    renderToolbar({ products });
    fireEvent.click(showMoreButton());
    const heading = await screen.findByText(/^Key/);
    expect(heading.textContent).toBe("Key — 4 products");
    expect(screen.getByText("Zed Widget")).toBeTruthy();
    expect(screen.getByText("Apple Widget")).toBeTruthy();
    expect(screen.getByText("No-run Gadget")).toBeTruthy();
    expect(screen.getByText("Midway Part")).toBeTruthy();
  });

  it("TB-6: the key is ordered by name, not by the order `products` happens to list them", async () => {
    mockRole("viewer");
    renderToolbar({ products });
    fireEvent.click(showMoreButton());
    const key = document.getElementById(showMoreButton().getAttribute("aria-controls")!)!;
    await within(key).findByText("Apple Widget");
    const names = within(key)
      .getAllByText(/Widget|Part|Gadget/)
      .map((el) => el.textContent);
    expect(names).toEqual(["Apple Widget", "Midway Part", "No-run Gadget", "Zed Widget"]);
  });
});

describe("TB-7/TB-8: F-170 -- no brief id shipped as a label, and the edge note is conditional", () => {
  it("TB-7: the snap note is gone outright, in the row and in the band", async () => {
    mockRole("admin");
    renderToolbar();
    expect(screen.queryByText(/snap/i)).toBeNull();
    expect(screen.queryByText(/P1-4b/)).toBeNull();
    fireEvent.click(showMoreButton());
    await screen.findByText(/^Key/);
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

describe("TB-9: the row's controls, in the mock's order, by accessible name", () => {
  it("plant picker, prev/Today/next, the range control, the three zoom levels, then Show more", async () => {
    mockRole("admin");
    const { container } = renderToolbar({ roots: [PLANT, PLANT2], rootPath: PLANT.path });
    // Sanity: the band is closed, so nothing it holds is in this list.
    expect(screen.queryByText("Week plan")).toBeNull();
    const names = Array.from(container.querySelectorAll<HTMLElement>("button, select")).map(
      (el) => el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "",
    );
    expect(names).toHaveLength(9);
    expect(names[0]).toBe("Which place to show");
    expect(names[1]).toBe("Prev day");
    expect(names[2]).toBe("Today");
    expect(names[3]).toBe("Next day");
    // The range control's own accessible name is the date label it draws
    // (no `aria-label`) -- the en dash it joins the two dates with is
    // enough to tell it apart from every other control without coupling
    // this pin to the exact date format.
    expect(names[4]).toMatch(/–/);
    expect(names[5]).toBe("Compact");
    expect(names[6]).toBe("Standard");
    expect(names[7]).toBe("Fine");
    expect(names[8]).toBe("Show more");
  });
});

describe("TB-10: the range control is a dropdown -- a pop-over with From/Days, closed by Escape", () => {
  it("opens the pop-over on click, holds the From/Days fields, and Escape returns focus to the control", async () => {
    mockRole("viewer");
    renderToolbar();
    expect(screen.queryByLabelText("From:")).toBeNull();
    const rangeButton = screen.getByRole("button", { name: /–/ });
    fireEvent.click(rangeButton);
    const fromInput = await screen.findByLabelText("From:");
    expect(fromInput).toBeTruthy();
    expect(screen.getByLabelText("Days:")).toBeTruthy();
    const popoverId = rangeButton.getAttribute("aria-controls");
    expect(popoverId).toBeTruthy();
    const popover = document.getElementById(popoverId!)!;
    fireEvent.keyDown(popover, { key: "Escape" });
    expect(screen.queryByLabelText("From:")).toBeNull();
    expect(document.activeElement).toBe(rangeButton);
  });
});

describe("TB-11: the band is two columns for the admin, and Key alone for a viewer", () => {
  it("an admin sees Week plan (left) and Key (right); a viewer sees only Key, across the full width", async () => {
    mockRole("admin");
    const { unmount } = renderToolbar();
    fireEvent.click(showMoreButton());
    const adminBand = document.getElementById(showMoreButton().getAttribute("aria-controls")!)!;
    await within(adminBand).findByText("Week plan");
    expect(within(adminBand).getByText(/^Key/)).toBeTruthy();
    unmount();

    mockRole("viewer");
    renderToolbar();
    fireEvent.click(showMoreButton());
    const viewerBand = document.getElementById(showMoreButton().getAttribute("aria-controls")!)!;
    expect(within(viewerBand).queryByText("Week plan")).toBeNull();
    expect(within(viewerBand).getByText(/^Key/)).toBeTruthy();
  });
});

/**
 * TB-12 REWRITTEN (reviewer, 18 Sept): the lane's own pin asserted a
 * constant visible word ("More") with the open/closed fact carried only in
 * `aria-label`. The maintainer, looking at the shipped band the same day:
 * "The unexpanded view should show the Show More button and expanded view
 * should show the Show Less button. Just more button is meaningless." So
 * this now pins the opposite: the visible text names the state, and IS the
 * accessible name -- there is no `aria-label` left to diverge from it.
 */
describe("TB-12: the toggle's visible text names the state, and is its own accessible name", () => {
  it("reads 'Show more' closed and 'Show less' open, with no aria-label splitting the two", async () => {
    mockRole("viewer");
    renderToolbar();
    const toggle = screen.getByRole("button", { name: "Show more" });
    expect(toggle.textContent).toBe("Show more");
    expect(toggle.getAttribute("aria-label")).toBeNull();
    fireEvent.click(toggle);
    const stillTheSameButton = screen.getByRole("button", { name: "Show less" });
    expect(stillTheSameButton).toBe(toggle);
    expect(stillTheSameButton.textContent).toBe("Show less");
    expect(stillTheSameButton.getAttribute("aria-label")).toBeNull();
  });
});
