/**
 * R-D66 — a chip can be re-parented between runs or detached to direct.
 * `updateAssignmentFields` (`src/lib/api/mutations.ts`) is the write this row
 * claims: patching `run_id`/`product_id` through the existing field-edit path,
 * "with no second write path" (the interface's own P1-4e D66 comment).
 *
 * `dragGesture.test.ts` mocks this function entirely to test the gesture
 * layer that calls it; nothing exercises the real implementation's actual
 * write shape for these two fields. This file is that.
 */
import { beforeEach, expect, it, vi } from "vitest";

const sb = vi.hoisted(() => {
  const calls: unknown[][] = [];
  let reply: { data: unknown; error: unknown } = { data: null, error: null };

  function builderFor(table: string): Record<string, unknown> {
    const builder: Record<string, unknown> = {};
    const record =
      (name: string) =>
      (...args: unknown[]) => {
        calls.push([table, name, ...args]);
        return builder;
      };
    for (const method of ["update", "eq", "select", "single"]) {
      builder[method] = record(method);
    }
    builder.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(reply).then(onFulfilled);
    return builder;
  }

  return {
    calls,
    reset() {
      calls.length = 0;
      reply = { data: null, error: null };
    },
    setReply(data: unknown, error: unknown = null) {
      reply = { data, error };
    },
    client: {
      from(table: string) {
        calls.push([table, "from"]);
        return builderFor(table);
      },
    },
    on(table: string): unknown[][] {
      return calls
        .filter((c) => c[0] === table)
        .map((c) => c.slice(1))
        .filter(([method]) => method !== "from");
    },
  };
});

vi.mock("@/lib/supabase", () => ({ supabase: sb.client }));

const { updateAssignmentFields } = await import("@/lib/api/mutations");

const BASE_ROW = {
  id: "a1",
  org_id: "org-1",
  node_id: "node-1",
  operator_id: "op-1",
  operator_display_name: "Bob",
  run_id: null,
  product_id: "prod-1",
  product_sku: "WX-1",
  product_name: "Widget X",
  product_color_token: "product-1",
  timerange: "[2099-01-01,2099-01-01)",
  efficiency: 1,
  eligibility_override: false,
  override_reason: null,
  area_override: false,
  area_override_reason: null,
  target_qty: null,
  target_unit: null,
  created_by: null,
  created_at: "2099-01-01T00:00:00Z",
  updated_at: "2099-01-01T00:00:00Z",
};

beforeEach(() => sb.reset());

it("F1: re-parenting to another run patches run_id and clears product_id, filtered to the one id", async () => {
  sb.setReply({ ...BASE_ROW, run_id: "run-2", product_id: null });
  const result = await updateAssignmentFields("a1", { runId: "run-2", productId: null });

  const [updateCall, eqCall] = sb.on("assignments");
  expect(updateCall).toEqual(["update", { run_id: "run-2", product_id: null }]);
  expect(eqCall).toEqual(["eq", "id", "a1"]);
  expect(result.runId).toBe("run-2");
});

it("F2: detaching to direct clears run_id and sets product_id, in the same single call", async () => {
  sb.setReply({ ...BASE_ROW, run_id: null, product_id: "prod-1" });
  const result = await updateAssignmentFields("a1", { runId: null, productId: "prod-1" });

  const [updateCall] = sb.on("assignments");
  expect(updateCall).toEqual(["update", { run_id: null, product_id: "prod-1" }]);
  expect(result.runId).toBeNull();
  expect(result.productId).toBe("prod-1");
});

it("F3: no second write path -- only the assignments table is ever touched", async () => {
  sb.setReply({ ...BASE_ROW, run_id: "run-2", product_id: null });
  await updateAssignmentFields("a1", { runId: "run-2", productId: null });
  expect([...new Set(sb.calls.map((c) => c[0]))]).toEqual(["assignments"]);
});

it("F4: a field left out of the edit is left out of the patch entirely (undefined, not null)", async () => {
  sb.setReply({ ...BASE_ROW, run_id: "run-2" });
  await updateAssignmentFields("a1", { runId: "run-2" });

  const [updateCall] = sb.on("assignments");
  expect(updateCall).toEqual(["update", { run_id: "run-2" }]);
});
