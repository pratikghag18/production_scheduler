/**
 * DEF-0069 (R-465, migration 0087): the rail's "elsewhere" read passes the board's own
 * root to `operator_blocks_elsewhere`, so the server can leave out the blocks that are ON
 * the board and return the ones that are not -- on a place the caller cannot read, or on
 * one she can read outside the board. A client that forgot the root would get 0085's
 * answer (unreadable places only) and the rail would say "free" for a person booked on a
 * readable place off the board.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sb = vi.hoisted(() => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    client: {
      rpc: (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        return Promise.resolve({ data: [], error: null });
      },
    },
  };
});

vi.mock("@/lib/supabase", () => ({ supabase: sb.client }));

import { fetchBlocksElsewhere } from "@/lib/api/board";

describe("fetchBlocksElsewhere (DEF-0069)", () => {
  beforeEach(() => {
    sb.calls.length = 0;
  });

  it("BR-1: asks operator_blocks_elsewhere with the window AND the board's root path", async () => {
    const from = new Date("2099-03-02T00:00:00Z");
    const to = new Date("2099-03-05T00:00:00Z");
    await expect(fetchBlocksElsewhere(from, to, "plant_1.area_1.line_1")).resolves.toEqual([]);
    expect(sb.calls).toEqual([
      {
        fn: "operator_blocks_elsewhere",
        args: {
          p_from: from.toISOString(),
          p_to: to.toISOString(),
          p_root_path: "plant_1.area_1.line_1",
        },
      },
    ]);
  });

  it("BR-2: a different root is a different question (the plant's root, not Line 1's)", async () => {
    const d = new Date("2099-03-02T00:00:00Z");
    await fetchBlocksElsewhere(d, d, "plant_1");
    await fetchBlocksElsewhere(d, d, "plant_1.area_1.line_1");
    expect(sb.calls.map((c) => c.args.p_root_path)).toEqual(["plant_1", "plant_1.area_1.line_1"]);
  });
});
