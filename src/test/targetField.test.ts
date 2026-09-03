/**
 * The shared Target/unit normaliser (`src/features/board/components/TargetField.tsx`).
 *
 * The recurring "units" bug: an assignment got the literal unit "units" even
 * with no target, because the create and edit popovers each hand-rolled the
 * field and coerced `targetUnit || "units"`. `normalizeTarget` is now the ONE
 * place the rule lives; these cases pin it so it cannot regress.
 */
import { describe, it, expect } from "vitest";
import { normalizeTarget } from "@/features/board/components/TargetField";

describe("normalizeTarget", () => {
  it("⭐ no quantity means NO unit — never the literal 'units'", () => {
    expect(normalizeTarget("", "units")).toEqual({ qty: null, unit: null });
    expect(normalizeTarget("", "")).toEqual({ qty: null, unit: null });
    expect(normalizeTarget("   ", "boxes")).toEqual({ qty: null, unit: null });
  });

  it("keeps the unit only when a quantity is set", () => {
    expect(normalizeTarget("500", "boxes")).toEqual({ qty: 500, unit: "boxes" });
    expect(normalizeTarget("12", "kg")).toEqual({ qty: 12, unit: "kg" });
  });

  it("a set quantity with a blank unit is null unit, not 'units'", () => {
    expect(normalizeTarget("500", "")).toEqual({ qty: 500, unit: null });
    expect(normalizeTarget("500", "   ")).toEqual({ qty: 500, unit: null });
  });

  it("clamps quantity to at least 1 and trims/caps the unit to 8 chars", () => {
    expect(normalizeTarget("0", "u")).toEqual({ qty: 1, unit: "u" });
    expect(normalizeTarget("-4", "u")).toEqual({ qty: 1, unit: "u" });
    expect(normalizeTarget("3", "  pallets  ")).toEqual({ qty: 3, unit: "pallets" });
    expect(normalizeTarget("3", "kilograms")).toEqual({ qty: 3, unit: "kilogram" }); // 9 chars -> 8-char cap
  });

  it("a non-numeric quantity falls back to 1 (matches the old inputs)", () => {
    expect(normalizeTarget("abc", "kg")).toEqual({ qty: 1, unit: "kg" });
  });
});
