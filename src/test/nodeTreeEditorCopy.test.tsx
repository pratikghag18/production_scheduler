import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NodeTreeEditor } from "@/features/admin/components/NodeTreeEditor";

/**
 * The starter-library half of the add-root form (0035): a new plant can start
 * EMPTY from a shape (the established path, `useCreateNode`) or COPY an existing
 * plant's structure (`useCopyPlantStructure`). This suite drives the REAL tree
 * libs (`buildTreeRows`, `groupRowsByShape`, …) and mocks only the mutation
 * hooks — at their boundary, `useHierarchyMutations` — each to its FULL shape.
 *
 * ⚠️ EACH HOOK IS MOCKED TO ITS FULL SHAPE. The component reads `.mutate`,
 * `.mutateAsync`, `.isPending`, `.isError`, `.error`, `.reset`, `.isSuccess`,
 * `.data`; an omitted field would silently pick a branch (a disabled button, a
 * phantom error line) and the fire-events below would do nothing.
 */

const PLANT_A = "30000000-0000-0000-0000-000000000001";
const PLANT_B = "30000000-0000-0000-0000-000000000002";

const h = vi.hoisted(() => ({
  createMutate: vi.fn(),
  copyMutate: vi.fn(),
}));

// One full react-query mutation shape, reused for every hook. The two paths we
// exercise get a captured `mutate`; the rest get their own spy.
function mutation(mutate: () => void) {
  return {
    mutate,
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    isSuccess: false,
    error: null as unknown,
    data: null as unknown,
    reset: vi.fn(),
  };
}

vi.mock("@/features/admin/hooks/useHierarchyMutations", () => ({
  hierarchyKeys: { all: ["hierarchy"] },
  useCreateNode: () => mutation(h.createMutate),
  useCopyPlantStructure: () => mutation(h.copyMutate),
  useRenameNode: () => mutation(vi.fn()),
  useMoveNode: () => mutation(vi.fn()),
  usePlaceNode: () => mutation(vi.fn()),
  usePromoteNode: () => mutation(vi.fn()),
  useDemoteNode: () => mutation(vi.fn()),
  useDeleteNode: () => mutation(vi.fn()),
}));

const LEVELS = [{ id: "L1", templateId: "tpl-1", position: 0, name: "Plant", isSchedulable: true }];

// Two existing ROOT plants — the copy sources — plus nothing else.
const NODES = [
  {
    id: PLANT_A,
    parentId: null,
    levelId: "L1",
    name: "Plant A",
    path: "a",
    sortOrder: 1,
    active: true,
  },
  {
    id: PLANT_B,
    parentId: null,
    levelId: "L1",
    name: "Plant B",
    path: "b",
    sortOrder: 2,
    active: true,
  },
];

// One shape in the org -> `requiresShapeChoice` is false, so the shape picker
// never renders and cannot interfere with the mode/source controls under test.
const SHAPES = [
  {
    id: "tpl-1",
    name: "Standard",
    levelCount: 1,
    levelNames: ["Plant"],
    schedulableLevelName: "Plant",
    hasNodes: true,
  },
];

function renderEditor() {
  return render(
    <NodeTreeEditor
      nodes={NODES}
      levels={LEVELS}
      shapeSummaries={SHAPES}
      selectedTemplateId="tpl-1"
    />,
  );
}

describe("NodeTreeEditor — start a new plant by copying an existing one", () => {
  beforeEach(() => {
    h.createMutate.mockClear();
    h.copyMutate.mockClear();
  });

  it("copies the chosen source plant with the typed name, and gates submit on both", () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "+ add root node" }));

    // Switch the mode to "Copy an existing plant".
    fireEvent.change(screen.getByLabelText("How the new root node starts"), {
      target: { value: "copy" },
    });

    const submit = screen.getByRole("button", { name: "Add" }) as HTMLButtonElement;
    // No source, no name -> disabled.
    expect(submit.disabled).toBe(true);

    // Name alone is not enough — a source is still required.
    fireEvent.change(screen.getByPlaceholderText("Root node name"), {
      target: { value: "New Plant" },
    });
    expect(submit.disabled).toBe(true);

    // Pick a source plant -> now both are set, submit enabled.
    fireEvent.change(screen.getByLabelText("Plant to copy the structure from"), {
      target: { value: PLANT_B },
    });
    expect(submit.disabled).toBe(false);

    fireEvent.click(submit);
    expect(h.copyMutate).toHaveBeenCalledTimes(1);
    expect(h.copyMutate.mock.calls[0][0]).toEqual({
      sourceRootId: PLANT_B,
      newName: "New Plant",
    });
    // The empty path was never touched.
    expect(h.createMutate).not.toHaveBeenCalled();
  });

  it("leaves the empty-create path unchanged (default mode)", () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "+ add root node" }));

    // Default mode is "empty": no source picker, and the shape picker is absent
    // because there is only one shape.
    expect(screen.queryByLabelText("Plant to copy the structure from")).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("Root node name"), {
      target: { value: "Fresh Plant" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(h.createMutate).toHaveBeenCalledTimes(1);
    expect(h.createMutate.mock.calls[0][0]).toEqual({
      parentId: null,
      name: "Fresh Plant",
      templateId: undefined,
    });
    expect(h.copyMutate).not.toHaveBeenCalled();
  });
});
