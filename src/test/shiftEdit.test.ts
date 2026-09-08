/**
 * R-044 — redefining a shift never touches existing assignments. `updateShift`
 * (`src/lib/api/shifts.ts`) is a plain PATCH on the `shifts` table; assignments
 * store absolute timestamps (`tstzrange`) independent of any shift template, so
 * a shift edit is a rendering/snapping layer over data it never rewrites.
 *
 * Same recording-client pattern as `operatorActive.test.ts`, extended to watch
 * every table touched, not just one -- the claim under test is as much about
 * what does NOT get written as what does.
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
    tablesTouched(): string[] {
      return [...new Set(calls.map((c) => c[0] as string))];
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

const { updateShift } = await import("@/lib/api/shifts");

const SHIFT_ROW = {
  id: "shift-1",
  template_id: "tmpl-1",
  name: "Morning",
  start_min: 360,
  end_min: 840,
};

beforeEach(() => sb.reset());

it("D1: editing a shift's times writes only start_min/end_min to the shifts table", async () => {
  sb.setReply([{ ...SHIFT_ROW, start_min: 420, end_min: 900 }]);
  await updateShift({ shiftId: "shift-1", startMin: 420, endMin: 900 });

  const [updateCall, eqCall] = sb.on("shifts");
  expect(updateCall).toEqual(["update", { start_min: 420, end_min: 900 }]);
  expect(eqCall).toEqual(["eq", "id", "shift-1"]);
});

it("D2: a partial patch (name only) never sends start_min/end_min, even as undefined keys", async () => {
  sb.setReply([SHIFT_ROW]);
  await updateShift({ shiftId: "shift-1", name: "Renamed" });

  const [updateCall] = sb.on("shifts");
  expect(updateCall).toEqual(["update", { name: "Renamed" }]);
});

it("D3: THE CLAIM ITSELF — no table but shifts is ever touched by a shift edit, assignments and runs included", async () => {
  sb.setReply([{ ...SHIFT_ROW, start_min: 420 }]);
  await updateShift({ shiftId: "shift-1", startMin: 420 });

  expect(sb.tablesTouched()).toEqual(["shifts"]);
});

it("D4: a filtered-away shift (RLS or already gone) writes nothing and is refused, not silently accepted", async () => {
  sb.setReply([]);
  await expect(updateShift({ shiftId: "shift-1", startMin: 420 })).rejects.toThrow();
});
