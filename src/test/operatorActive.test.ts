/**
 * R-017 — deactivation is `active=false`, never a delete. `setOperatorActive`
 * (`src/lib/api/operators.ts`) is the write this row's claim is about: a plain
 * PATCH on the `active` column, so `operator_skills` and `assignments` (both
 * FK'd to `operators` with no `ON DELETE`) keep their history intact.
 *
 * A recording PostgREST client, same shape as `apiPlantSettingsShape.test.ts`,
 * extended with an `update` method — that file's builder only needed reads.
 */
import { beforeEach, expect, it, vi } from "vitest";

const sb = vi.hoisted(() => {
  const calls: unknown[][] = [];
  let reply: { data: unknown; error: unknown } = { data: [], error: null };

  function builderFor(table: string): Record<string, unknown> {
    const builder: Record<string, unknown> = {};
    const record =
      (name: string) =>
      (...args: unknown[]) => {
        calls.push([table, name, ...args]);
        return builder;
      };
    for (const method of ["update", "eq", "select"]) {
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
      reply = { data: [], error: null };
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

const { setOperatorActive } = await import("@/lib/api/operators");
const { setProductActive } = await import("@/lib/api/products");

const OPERATOR_ROW = {
  id: "op-1",
  display_name: "Bob",
  employee_ref: null,
  active: false,
  site_node_id: "node-1",
  source: "manual",
  external_id: null,
};

beforeEach(() => sb.reset());

it("A1: deactivating writes active:false, filtered to the one id, and reads the row back", async () => {
  sb.setReply([OPERATOR_ROW]);
  const result = await setOperatorActive({ id: "op-1", active: false });

  const [updateCall, eqCall] = sb.on("operators");
  expect(updateCall).toEqual(["update", { active: false }]);
  expect(eqCall).toEqual(["eq", "id", "op-1"]);
  expect(result.active).toBe(false);
});

it("A2: bringing someone back writes active:true, the same call shape with the flag flipped", async () => {
  sb.setReply([{ ...OPERATOR_ROW, active: true }]);
  const result = await setOperatorActive({ id: "op-1", active: true });

  const [updateCall] = sb.on("operators");
  expect(updateCall).toEqual(["update", { active: true }]);
  expect(result.active).toBe(true);
});

it("A3: never a delete — no delete method is ever called on the table", async () => {
  sb.setReply([OPERATOR_ROW]);
  await setOperatorActive({ id: "op-1", active: false });
  expect(sb.on("operators").some(([method]) => method === "delete")).toBe(false);
});

it("A4: a filtered-away row (RLS or already gone) writes nothing and is refused, not silently accepted", async () => {
  sb.setReply([]);
  await expect(setOperatorActive({ id: "op-1", active: false })).rejects.toThrow();
});

const PRODUCT_ROW = {
  id: "prod-1",
  sku: "WX-1",
  name: "Widget X",
  active: false,
  source: "manual",
  external_id: null,
  color_token: "product-1",
  product_sites: [],
};

it("B1: deactivating a product writes active:false, filtered to the one id, and reads the row back", async () => {
  sb.setReply([PRODUCT_ROW]);
  const result = await setProductActive({ id: "prod-1", active: false });

  const [updateCall, eqCall] = sb.on("products");
  expect(updateCall).toEqual(["update", { active: false }]);
  expect(eqCall).toEqual(["eq", "id", "prod-1"]);
  expect(result.active).toBe(false);
});

it("B2: bringing a product back writes active:true", async () => {
  sb.setReply([{ ...PRODUCT_ROW, active: true }]);
  const result = await setProductActive({ id: "prod-1", active: true });

  const [updateCall] = sb.on("products");
  expect(updateCall).toEqual(["update", { active: true }]);
  expect(result.active).toBe(true);
});

it("B3: never a delete on the products table either", async () => {
  sb.setReply([PRODUCT_ROW]);
  await setProductActive({ id: "prod-1", active: false });
  expect(sb.on("products").some(([method]) => method === "delete")).toBe(false);
});
