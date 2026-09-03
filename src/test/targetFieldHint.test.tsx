/**
 * What the target field says about the number it derives (R-316).
 *
 * The maintainer, 3 Sept, on the edit popover, which read "Standard for this
 * cell: 12": *"it is not a standard, it is the target based on the standard. It
 * is very misleading."*
 *
 * They are two different quantities and the screen has both. The STANDARD is
 * the cycle time — seconds per unit, set once per cell on the Cycle times
 * screen, and it does not move. The TARGET is what that standard works out to
 * for one assignment's window, and it changes every time the block is resized
 * or its efficiency is edited. Calling the second one "the standard" invites
 * someone to type a cycle time into a target box, which would be accepted and
 * wrong.
 *
 * `normalizeTarget`'s own rules are pinned in `targetField.test.ts`; this file
 * only guards the wording, because a string is exactly what `tsc` cannot see.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TargetField } from "@/features/board/components/TargetField";

function renderField(derivedQty: number | null) {
  return render(
    <TargetField
      idPrefix="t"
      qty=""
      unit=""
      onQtyChange={vi.fn()}
      onUnitChange={vi.fn()}
      derivedQty={derivedQty}
    />,
  );
}

describe("R-316: the field names the derived number a target, never a standard", () => {
  it("⭐ the hint does not call the quantity a standard", () => {
    const { container } = renderField(12);
    const hint = container.querySelector("p");
    expect(hint).not.toBeNull();
    expect(hint!.textContent).not.toMatch(/^Standard for this cell/);
    // It must still name where the number came from, or "12" is unexplained.
    expect(hint!.textContent).toMatch(/cycle time/i);
    expect(hint!.textContent).toMatch(/12/);
  });

  it("it says that leaving the box blank is what uses the number", () => {
    const { container } = renderField(12);
    expect(container.querySelector("p")!.textContent).toMatch(/blank/i);
  });

  it("the derived number is the PLACEHOLDER, never a filled-in value", () => {
    renderField(12);
    const qty = screen.getByLabelText("Target (optional)") as HTMLInputElement;
    // Pre-filling would silently turn the derived target into an explicit
    // override that then stopped following a resize.
    expect(qty.value).toBe("");
    expect(qty.placeholder).toBe("12");
  });

  it("with no cycle time there is no hint and no placeholder number", () => {
    const { container } = renderField(null);
    expect(container.querySelector("p")).toBeNull();
    const qty = screen.getByLabelText("Target (optional)") as HTMLInputElement;
    expect(qty.placeholder).toBe("—");
  });
});
