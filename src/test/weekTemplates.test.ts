/**
 * Named week templates (R-356): the API boundary (`weekTemplates.ts`), the
 * template source threaded through `copyWeek.ts`, and the counts sentence that
 * names the template as the source.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: { rpc } }));

const {
  listWeekTemplates,
  listWeekTemplateItems,
  saveWeekTemplate,
  renameWeekTemplate,
  deleteWeekTemplate,
  fetchCopyWeekPlan,
  applyCopyWeek,
} = await import("@/lib/api");
const { describeCounts } = await import("@/features/board/components/CopyWeekDialog");
import type { CopyWeekPlan } from "@/lib/api";

function ok(data: unknown) {
  rpc.mockResolvedValue({ data, error: null });
}
function fail(error: unknown) {
  rpc.mockResolvedValue({ data: null, error });
}

beforeEach(() => rpc.mockReset());

describe("weekTemplates.ts: save", () => {
  it("parses the save result (counts nested) and sends the plant, week and name", async () => {
    ok({
      id: "t1",
      plant_id: "p1",
      name: "Day shift",
      saved_from: "2099-07-06",
      counts: { runs: 2, assignments: 4 },
    });
    const saved = await saveWeekTemplate({
      plantId: "p1",
      sourceStart: new Date("2099-07-06T00:00:00.000Z"),
      name: "Day shift",
    });
    expect(saved).toEqual({
      id: "t1",
      name: "Day shift",
      savedFrom: "2099-07-06",
      runs: 2,
      assignments: 4,
    });
    expect(rpc).toHaveBeenCalledWith("save_week_template", {
      p_plant_id: "p1",
      p_source_start: "2099-07-06",
      p_name: "Day shift",
    });
  });

  it("throws a shapeMismatch when the counts are missing", async () => {
    ok({ id: "t1", name: "x", saved_from: "2099-07-06" });
    await expect(
      saveWeekTemplate({ plantId: "p1", sourceStart: new Date(0), name: "x" }),
    ).rejects.toThrow();
  });

  it("throws a scheduler error on a PostgREST refusal", async () => {
    fail({ message: "nope", code: "P0001", details: JSON.stringify({ reason: "duplicate_name" }) });
    await expect(
      saveWeekTemplate({ plantId: "p1", sourceStart: new Date(0), name: "x" }),
    ).rejects.toThrow();
  });
});

describe("weekTemplates.ts: list / rename / delete", () => {
  it("parses a flat list, and an empty list is not an error", async () => {
    ok([
      { id: "a", name: "A", saved_from: "2099-07-06", runs: 1, assignments: 0 },
      { id: "b", name: "B", saved_from: "2099-07-13", runs: 3, assignments: 5 },
    ]);
    const rows = await listWeekTemplates("p1");
    expect(rows.map((r) => r.name)).toEqual(["A", "B"]);
    expect(rows[1]).toEqual({
      id: "b",
      name: "B",
      savedFrom: "2099-07-13",
      runs: 3,
      assignments: 5,
    });

    ok([]);
    expect(await listWeekTemplates("p1")).toEqual([]);
  });

  it("refuses a malformed list row", async () => {
    ok([{ id: "a", name: "A", saved_from: "2099-07-06", runs: "one", assignments: 0 }]);
    await expect(listWeekTemplates("p1")).rejects.toThrow();
  });

  it("rename and delete send their ids and surface a refusal", async () => {
    ok({ id: "t1", name: "New" });
    await renameWeekTemplate("t1", "New");
    expect(rpc).toHaveBeenCalledWith("rename_week_template", {
      p_template_id: "t1",
      p_name: "New",
    });

    ok({ id: "t1", deleted: true });
    await deleteWeekTemplate("t1");
    expect(rpc).toHaveBeenCalledWith("delete_week_template", { p_template_id: "t1" });

    fail({ message: "no", code: "P0001", details: JSON.stringify({ reason: "not_admin" }) });
    await expect(deleteWeekTemplate("t1")).rejects.toThrow();
  });
});

describe("weekTemplates.ts: list_week_template_items (R-356 surface)", () => {
  it("parses a multi-item payload, including a standalone assignment and every nullable field", async () => {
    ok([
      {
        item_ref: "e8000000-0000-0000-0000-000000000001",
        kind: "run",
        run_ref: null,
        day_offset: 0,
        start_min: 360,
        end_min: 840,
        planned_headcount: 2,
        node_id: "n1",
        node_name: "Line T1",
        product_id: "p1",
        product_name: "Widget T",
        operator_id: null,
        operator_name: null,
      },
      {
        item_ref: "e9000000-0000-0000-0000-000000000001",
        kind: "assignment",
        run_ref: "e8000000-0000-0000-0000-000000000001",
        day_offset: 0,
        start_min: 360,
        end_min: 840,
        planned_headcount: null,
        node_id: "n1",
        node_name: "Line T1",
        product_id: null,
        product_name: null,
        operator_id: "o1",
        operator_name: "Tara",
      },
      {
        // a standalone assignment (no run_ref), and a name that no longer
        // resolves (0067 D110): the node/product/operator were deleted since
        // the snapshot, so every *_name here is null though the ids remain.
        item_ref: "e9000000-0000-0000-0000-000000000003",
        kind: "assignment",
        run_ref: null,
        day_offset: 1,
        start_min: 480,
        end_min: 720,
        planned_headcount: null,
        node_id: "n1",
        node_name: null,
        product_id: "p-gone",
        product_name: null,
        operator_id: "o-gone",
        operator_name: null,
      },
    ]);
    const items = await listWeekTemplateItems("t1");
    expect(rpc).toHaveBeenCalledWith("list_week_template_items", { p_template_id: "t1" });
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({
      itemRef: "e8000000-0000-0000-0000-000000000001",
      kind: "run",
      runRef: null,
      dayOffset: 0,
      startMin: 360,
      endMin: 840,
      plannedHeadcount: 2,
      nodeId: "n1",
      nodeName: "Line T1",
      productId: "p1",
      productName: "Widget T",
      operatorId: null,
      operatorName: null,
    });
    expect(items[1]).toEqual({
      itemRef: "e9000000-0000-0000-0000-000000000001",
      kind: "assignment",
      runRef: "e8000000-0000-0000-0000-000000000001",
      dayOffset: 0,
      startMin: 360,
      endMin: 840,
      plannedHeadcount: null,
      nodeId: "n1",
      nodeName: "Line T1",
      productId: null,
      productName: null,
      operatorId: "o1",
      operatorName: "Tara",
    });
    expect(items[2]).toEqual({
      itemRef: "e9000000-0000-0000-0000-000000000003",
      kind: "assignment",
      runRef: null,
      dayOffset: 1,
      startMin: 480,
      endMin: 720,
      plannedHeadcount: null,
      nodeId: "n1",
      nodeName: null,
      productId: "p-gone",
      productName: null,
      operatorId: "o-gone",
      operatorName: null,
    });

    ok([]);
    expect(await listWeekTemplateItems("t1")).toEqual([]);
  });

  it("throws a shapeMismatch on a malformed item (an invalid kind)", async () => {
    ok([
      {
        item_ref: "x1",
        kind: "sometimes",
        run_ref: null,
        day_offset: 0,
        start_min: 0,
        end_min: 60,
        planned_headcount: null,
        node_id: "n1",
        node_name: "Line T1",
        product_id: null,
        product_name: null,
        operator_id: null,
        operator_name: null,
      },
    ]);
    await expect(listWeekTemplateItems("t1")).rejects.toThrow();
  });

  it("throws a shapeMismatch when a required field is missing", async () => {
    ok([{ item_ref: "x1", kind: "run", day_offset: 0, start_min: 0, end_min: 60 }]);
    await expect(listWeekTemplateItems("t1")).rejects.toThrow();
  });

  it("throws a scheduler error on a PostgREST refusal (no_such_template)", async () => {
    fail({ message: "no", code: "P0001", details: JSON.stringify({ reason: "no_such_template" }) });
    await expect(listWeekTemplateItems("bogus")).rejects.toThrow();
  });
});

describe("copyWeek.ts: a template source is threaded through both calls", () => {
  const plan = {
    plant_id: "p1",
    source_start: "2099-07-13",
    target_start: "2099-07-13",
    shift_days: 0,
    counts: { clean: 1, clash: 0 },
    history: { runs: 0, assignments: 0 },
    items: [],
  };

  it("copy_week_plan sends p_template_id and a null source when a template is chosen", async () => {
    ok(plan);
    await fetchCopyWeekPlan({
      plantId: "p1",
      sourceStart: null,
      targetStart: new Date("2099-07-13T00:00:00.000Z"),
      templateId: "t1",
    });
    expect(rpc).toHaveBeenCalledWith("copy_week_plan", {
      p_plant_id: "p1",
      p_source_start: null,
      p_target_start: "2099-07-13",
      p_template_id: "t1",
    });
  });

  it("apply_copy_week sends p_template_id, a null source, and the decisions", async () => {
    ok({ created: { runs: 1, assignments: 0 }, removed: { runs: 0, assignments: 0 }, skipped: 0 });
    await applyCopyWeek({
      plantId: "p1",
      sourceStart: null,
      targetStart: new Date("2099-07-13T00:00:00.000Z"),
      templateId: "t1",
      decisions: [{ key: "run:1", choice: "copied" }],
    });
    expect(rpc).toHaveBeenCalledWith("apply_copy_week", {
      p_plant_id: "p1",
      p_source_start: null,
      p_target_start: "2099-07-13",
      p_decisions: [{ key: "run:1", choice: "copied" }],
      p_template_id: "t1",
    });
  });

  it("a WEEK source still sends the source date and no template id", async () => {
    ok(plan);
    await fetchCopyWeekPlan({
      plantId: "p1",
      sourceStart: new Date("2099-07-06T00:00:00.000Z"),
      targetStart: new Date("2099-07-13T00:00:00.000Z"),
    });
    expect(rpc).toHaveBeenCalledWith("copy_week_plan", {
      p_plant_id: "p1",
      p_source_start: "2099-07-06",
      p_target_start: "2099-07-13",
      p_template_id: undefined,
    });
  });
});

describe("the counts sentence names the template as the source (R-356)", () => {
  const base: CopyWeekPlan = {
    plantId: "p1",
    sourceStart: "2099-07-13",
    targetStart: "2099-07-13",
    shiftDays: 0,
    counts: { clean: 3, clash: 1 },
    history: { runs: 0, assignments: 0 },
    items: [],
  };

  it("prefixes the template name where a week source would be implied", () => {
    expect(describeCounts(base, "Day shift")).toBe(
      "From the template Day shift: 3 items copy cleanly; 1 clashes with the prior plan and needs an answer.",
    );
  });

  it("says the template is empty rather than the week", () => {
    expect(describeCounts({ ...base, counts: { clean: 0, clash: 0 } }, "Day shift")).toBe(
      "The template Day shift is empty, so there is nothing to copy.",
    );
  });

  it("is unchanged for a week source", () => {
    expect(describeCounts({ ...base, counts: { clean: 3, clash: 0 } })).toBe(
      "3 items copy cleanly; nothing clashes with the prior plan.",
    );
  });
});
