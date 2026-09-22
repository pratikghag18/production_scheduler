/**
 * R-447 (the audit lane, S69-a): every button in one group is the same size.
 * `docs/agent-briefs/s69-a-button-width-audit-brief.md` is the walk; this file
 * is TB-13's shape carried to the hits that walk found — jsdom does not
 * compute layout, so this cannot measure pixels (a real-browser screenshot is
 * what `verified_by` in `docs/plan.yaml` would record for that). What IS
 * honestly testable is that each cluster still carries the class, or sits
 * inside the wrapper, that gives its buttons one width, so a future edit
 * cannot quietly drop it without a test noticing.
 *
 * Three fixes, three groups of cases (a fourth hit, MatrixPanel's All/None
 * picker, is fixed the same way but left unpinned here -- see the note above
 * its own section below):
 *
 *   1. OperatorsPanel  — the detail header's Edit/Deactivate/Delete (or
 *      Save/Cancel) cluster, CLAUDE.md's own example of a per-row admin
 *      action cluster. It could not become a grid track the way a dedicated
 *      `.actions` wrapper can (`ProductsPanel`, `TrainingsPanel`) — the same
 *      row also carries the name, a select and inputs — so the fix is a
 *      shared `min-width` reaching every `<button>` in `.renameRow`.
 *   2. NodeTreeEditor  — two footers with no cluster wrapper other than the
 *      form/div itself: "+ add root node"'s own Add/Cancel (no class on
 *      either button) and the row menu's Cancel/Rename|Add and
 *      Cancel/Deactivate|Delete footers (`.popActions`).
 *   3. InlineEdit       — the one edit-in-place control's own Save/Cancel
 *      (`Field.module.css`'s `.editor`), composed into every editable cell in
 *      the app (the cycle-times grid is its first caller).
 */
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { render as rtlRender, screen, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NodeTreeEditor } from "@/features/admin/components/NodeTreeEditor";
import { InlineEdit } from "@/components/InlineEdit";
import operatorsStyles from "@/features/admin/components/OperatorsPanel.module.css";
import nodeTreeStyles from "@/features/admin/components/NodeTreeEditor.module.css";
import fieldStyles from "@/components/Field.module.css";

// OperatorsPanel renders OperatorAbsences, which reads/writes through real
// `@tanstack/react-query` hooks (the same reason `operatorsPanel.test.tsx`
// shadows `render` this way -- see that file's own header).
function render(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

/* =============================================================================
 * 1. OperatorsPanel — the detail header's own cluster (`.renameRow`).
 * ========================================================================= */

const oh = vi.hoisted(() => ({
  createMutate: vi.fn(),
  updateMutate: vi.fn(),
  state: {
    profile: {
      id: "u1",
      orgId: "10000000-0000-0000-0000-000000000001",
      userId: "u1",
      role: "admin",
      defaultCreateMode: "run",
      adminAnywhere: true,
    },
    data: {
      operators: [
        {
          id: "op-ann",
          displayName: "Ann Adams",
          employeeRef: "A-1",
          active: true,
          siteNodeId: "n-line-a",
          homeShiftId: null,
        },
      ],
      skills: [] as unknown[],
      operatorSkills: [] as unknown[],
      requirements: [] as unknown[],
      nodes: [
        {
          id: "n-plant-1",
          name: "Plant 1",
          parentId: null,
          levelId: "lv-plant",
          path: "plant_1",
          sortOrder: 1,
          active: true,
        },
        {
          id: "n-line-a",
          name: "Line A",
          parentId: "n-plant-1",
          levelId: "lv-line",
          path: "plant_1.line_a",
          sortOrder: 1,
          active: true,
        },
      ],
      levels: [
        { id: "lv-plant", templateId: "tpl", position: 0, name: "Plant", isSchedulable: false },
        { id: "lv-line", templateId: "tpl", position: 1, name: "Line", isSchedulable: true },
      ],
      skipped: 0,
    },
    shiftPatterns: {
      templates: [] as unknown[],
      shifts: [] as unknown[],
      breaks: [] as unknown[],
      attachments: [] as unknown[],
      nodes: [] as unknown[],
    },
  },
}));

vi.mock("@/features/auth/useSession", () => ({
  useSession: () => ({
    session: { user: { id: oh.state.profile.userId } },
    profile: oh.state.profile,
    loading: false,
  }),
}));

vi.mock("@/lib/api", () => ({
  describeSchedulerError: (e: unknown) => String(e),
  fetchAbsences: () => Promise.resolve({ absences: [], skipped: 0 }),
  fetchNodeSetting: () => Promise.resolve(null),
  setAbsence: vi.fn(),
  removeAbsence: vi.fn(),
}));

vi.mock("@/features/admin/components/AbsencesImport", () => ({
  absenceKeys: { all: ["absences"] as const },
}));

vi.mock("@/features/admin/hooks/useOrgSettings", () => ({
  useDateFormat: () => "d_mon_yyyy",
  useTimezone: () => "America/Chicago",
}));

vi.mock("@/features/admin/hooks/useOperators", () => ({
  useOperatorsAdmin: () => ({
    data: oh.state.data,
    isLoading: false,
    isError: false,
    error: null,
  }),
  useCreateOperator: () => ({ mutate: oh.createMutate, isPending: false }),
  useUpdateOperator: () => ({ mutate: oh.updateMutate, isPending: false }),
  useSetOperatorActive: () => ({ mutate: vi.fn(), isPending: false }),
  useGrantSkill: () => ({ mutate: vi.fn(), isPending: false, error: null, reset: vi.fn() }),
  useUpdateSkillRecord: () => ({ mutate: vi.fn(), isPending: false, error: null, reset: vi.fn() }),
  useRevokeSkill: () => ({ mutate: vi.fn(), isPending: false, error: null, reset: vi.fn() }),
}));

vi.mock("@/features/admin/hooks/useDeletion", () => ({
  useDeletionPreview: () => ({ data: undefined, isPending: true, isError: false, error: null }),
  useDeleteOwnedRow: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/features/admin/hooks/useShifts", () => ({
  useShiftPatterns: () => ({
    data: oh.state.shiftPatterns,
    isLoading: false,
    isError: false,
    error: null,
  }),
}));

describe("R-447: OperatorsPanel's detail-header cluster is one width", () => {
  it("Edit/Deactivate/Delete all carry .renameRow's shared min-width", async () => {
    // Imported after the mocks above so the module graph sees them.
    const { OperatorsPanel } = await import("@/features/admin/components/OperatorsPanel");
    render(<OperatorsPanel />);
    fireEvent.click(
      within(screen.getByRole("complementary")).getByRole("button", { name: /Ann Adams/ }),
    );
    const edit = screen.getByRole("button", { name: "Edit" });
    const deactivate = screen.getByRole("button", { name: "Deactivate" });
    const del = screen.getByRole("button", { name: "Delete" });
    for (const btn of [edit, deactivate, del]) {
      expect(btn.parentElement?.className).toContain(operatorsStyles.renameRow);
    }
  });

  it("Save/Cancel while editing carry the same class", async () => {
    const { OperatorsPanel } = await import("@/features/admin/components/OperatorsPanel");
    render(<OperatorsPanel />);
    fireEvent.click(
      within(screen.getByRole("complementary")).getByRole("button", { name: /Ann Adams/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const save = screen.getByRole("button", { name: "Save" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(save.parentElement?.className).toContain(operatorsStyles.renameRow);
    expect(cancel.parentElement?.className).toContain(operatorsStyles.renameRow);
  });
});

/* =============================================================================
 * 2. NodeTreeEditor — the add-root footer and the row-menu footers.
 * ========================================================================= */

vi.mock("@/features/admin/hooks/useHierarchyMutations", () => {
  const mutation = () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    isSuccess: false,
    error: null as unknown,
    data: null as unknown,
    reset: vi.fn(),
  });
  return {
    hierarchyKeys: { all: ["hierarchy"] },
    useCreateNode: mutation,
    useCopyPlantStructure: mutation,
    useRenameNode: mutation,
    useMoveNode: mutation,
    usePlaceNode: mutation,
    usePromoteNode: mutation,
    useDemoteNode: mutation,
    useDeleteNode: mutation,
  };
});

const NT_NODES = [
  {
    id: "n-plant-a",
    parentId: null,
    levelId: "L1",
    name: "Plant A",
    path: "a",
    sortOrder: 1,
    active: true,
  },
];
const NT_LEVELS = [
  { id: "L1", templateId: "tpl-1", position: 0, name: "Plant", isSchedulable: true },
];
const NT_SHAPES = [
  {
    id: "tpl-1",
    name: "Standard",
    levelCount: 1,
    levelNames: ["Plant"],
    schedulableLevelName: "Plant",
    hasNodes: true,
  },
];

function renderTreeEditor() {
  return render(
    <NodeTreeEditor
      nodes={NT_NODES}
      levels={NT_LEVELS}
      shapeSummaries={NT_SHAPES}
      selectedTemplateId="tpl-1"
    />,
  );
}

describe("R-447: NodeTreeEditor's footers are one width", () => {
  it("the add-root form's Add/Cancel sit inside .addRootForm's shared min-width", () => {
    renderTreeEditor();
    fireEvent.click(screen.getByRole("button", { name: "+ add root node" }));
    const add = screen.getByRole("button", { name: "Add" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(add.closest(`.${nodeTreeStyles.addRootForm}`)).not.toBeNull();
    expect(cancel.closest(`.${nodeTreeStyles.addRootForm}`)).not.toBeNull();
  });

  it("the rename footer's Cancel/Rename sit inside .popActions", () => {
    renderTreeEditor();
    fireEvent.click(screen.getByRole("button", { name: "Actions for Plant A" }));
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const rename = screen.getByRole("button", { name: "Rename" });
    expect(cancel.parentElement?.className).toContain(nodeTreeStyles.popActions);
    expect(rename.parentElement?.className).toContain(nodeTreeStyles.popActions);
  });

  it("the delete-confirm footer's Cancel/Deactivate sit inside .popActions", () => {
    renderTreeEditor();
    fireEvent.click(screen.getByRole("button", { name: "Actions for Plant A" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const deactivate = screen.getByRole("button", { name: "Deactivate" });
    expect(cancel.parentElement?.className).toContain(nodeTreeStyles.popActions);
    expect(deactivate.parentElement?.className).toContain(nodeTreeStyles.popActions);
  });
});

/* =============================================================================
 * 3. InlineEdit — the shared edit-in-place control's own Save/Cancel.
 *
 * (MatrixPanel's own All/None pair got the same fix -- `.opActions`, a grid
 * track exactly like `BoardToolbar.module.css`'s `.zoom` -- but is left
 * unpinned here: its picker sits inside a native `<details>`/`<summary>`,
 * and jsdom does not implement the UA stylesheet rule that hides a closed
 * `<details>`'s content, so a test cannot honestly tell "open" from "closed"
 * the way a browser reader would. Verified by reading the rendered CSS
 * instead; a real-browser screenshot is the honest pin for it, the same
 * exemption TB-13's own header claims for pixel measurement.)
 * ========================================================================= */

describe("R-447: InlineEdit's Save/Cancel share .editor's min-width", () => {
  it("both buttons carry the shared class", () => {
    render(
      <InlineEdit value="1.5 min" ariaLabel="Cycle time" onSave={vi.fn()} onCancel={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cycle time" }));
    const save = screen.getByRole("button", { name: "Save" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(save.className).toContain(fieldStyles.primaryBtn);
    expect(cancel.className).toContain(fieldStyles.btn);
    // The fix itself: `.editor .btn`/`.editor .primaryBtn` both carry the
    // shared min-width, reached through the wrapper rather than a class
    // unique to this pair.
    expect(save.parentElement?.className).toContain(fieldStyles.editor);
    expect(cancel.parentElement?.className).toContain(fieldStyles.editor);
  });
});
