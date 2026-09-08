/**
 * R-070 — LevelEditor refuses to guess which structure it is editing.
 *
 * `LevelEditor`'s own file header names the bug this component exists to
 * not repeat: D86's `soleTemplateId` silently edited `levels[0]`'s template
 * whenever the loaded levels spanned more than one shape -- exactly the guess
 * the RPC was built to reject. D87 replaced the guess with a required
 * `templateId` prop: `null` means no shape is selected, and Save stays
 * disabled while it is, rather than the component picking one on its own.
 *
 * `levelDraft.test.ts`'s S12 already proves the pure function
 * (`findLevelOrderProblems`) is well-behaved for a null templateId; this file
 * is the one level up, proving the COMPONENT actually wires that into a
 * disabled Save button rather than rendering a form for a shape nobody chose.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LevelEditor } from "@/features/admin/components/LevelEditor";
import type { HierarchyLevel } from "@/lib/api/shapes";

vi.mock("@/features/admin/hooks/useHierarchyMutations", () => ({
  useSaveHierarchyLevels: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
}));

const TEMPLATE_A = "tmpl-a";
const TEMPLATE_B = "tmpl-b";

// Levels spanning TWO templates -- the "complete org list" LevelEditor's own
// comment says it receives, unfiltered.
const LEVELS: HierarchyLevel[] = [
  { id: "l1", templateId: TEMPLATE_A, position: 0, name: "Plant", isSchedulable: false },
  { id: "l2", templateId: TEMPLATE_A, position: 1, name: "Cell", isSchedulable: true },
  { id: "l3", templateId: TEMPLATE_B, position: 0, name: "Site", isSchedulable: false },
  { id: "l4", templateId: TEMPLATE_B, position: 1, name: "Line", isSchedulable: true },
];

describe("LevelEditor fails closed rather than guessing a template (R-070, D87)", () => {
  it("E1: templateId=null (no shape selected) disables Save, even though levels for two shapes are loaded", () => {
    render(<LevelEditor levels={LEVELS} nodes={[]} templateId={null} />);
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it("E2: templateId=null renders no rows from EITHER template -- it does not fall back to the first one", () => {
    render(<LevelEditor levels={LEVELS} nodes={[]} templateId={null} />);
    expect(screen.queryByDisplayValue("Plant")).toBeNull();
    expect(screen.queryByDisplayValue("Site")).toBeNull();
  });

  it("E3: naming a real templateId edits ONLY that template's levels, in position order", () => {
    render(<LevelEditor levels={LEVELS} nodes={[]} templateId={TEMPLATE_B} />);
    expect(screen.queryByDisplayValue("Site")).not.toBeNull();
    expect(screen.queryByDisplayValue("Line")).not.toBeNull();
    expect(screen.queryByDisplayValue("Plant")).toBeNull();
    expect(screen.queryByDisplayValue("Cell")).toBeNull();
  });

  it("E4: with a real templateId selected and a sound draft, Save is enabled -- E1 is the null case, not a permanently-disabled button", () => {
    render(<LevelEditor levels={LEVELS} nodes={[]} templateId={TEMPLATE_A} />);
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
  });
});
