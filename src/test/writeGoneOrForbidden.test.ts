/**
 * S195-A (DEF-0052, tester 30 Sept): "a write that reports success can have
 * changed nothing" (CLAUDE.md §4) -- and a write that changed nothing has TWO
 * causes the person must not hear as one. A row the caller can still read but
 * the policy filtered is FORBIDDEN ("You don't have permission to change
 * that."); a row the caller reads nothing of is GONE (someone removed it
 * first: "That block is no longer on the board."). The writers read the row
 * back by id, as the caller, after a write that changed nothing, and say
 * which; the bar's rewriter (`CommandBar.tsx`'s `rewriteRefusal`) turns each
 * into the plant's words, the single sentence and the lot alike (CB-gone-1,
 * CB-gone-2 in `commandBar.test.tsx`).
 *
 * No database here: the supabase client is a scripted double that answers each
 * call in order and records which table and which method it was asked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invalidArgument } from "./fixtures/postgrest-errors";

const sb = vi.hoisted(() => {
  type Reply = { data: unknown; error: unknown };
  const calls: string[] = [];
  const queue: Reply[] = [];
  const next = (): Reply => queue.shift() ?? { data: null, error: null };

  function builderFor(table: string): Record<string, unknown> {
    const builder: Record<string, unknown> = {};
    for (const method of ["delete", "update", "select", "eq"]) {
      builder[method] = (...args: unknown[]) => {
        calls.push(`${table}.${method}(${args.map((a) => JSON.stringify(a)).join(",")})`);
        return builder;
      };
    }
    for (const terminal of ["single", "maybeSingle"]) {
      builder[terminal] = () => {
        calls.push(`${table}.${terminal}()`);
        return Promise.resolve(next());
      };
    }
    builder.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(next()).then(onFulfilled);
    return builder;
  }

  return {
    calls,
    reset() {
      calls.length = 0;
      queue.length = 0;
    },
    reply(data: unknown, error: unknown = null) {
      queue.push({ data, error });
    },
    client: {
      from: (table: string) => builderFor(table),
      rpc: (name: string) => {
        calls.push(`rpc.${name}`);
        return Promise.resolve(next());
      },
    },
  };
});

vi.mock("@/lib/supabase", () => ({ supabase: sb.client }));

const { deleteAssignment, deleteRun, updateAssignmentFields } = await import("@/lib/api/mutations");
const { describeSchedulerError, isSchedulerError } = await import("@/lib/api/errors");

beforeEach(() => sb.reset());

async function thrown(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected the write to throw");
}

describe("deleteAssignment: gone or forbidden", () => {
  it("WG-1: the delete removed no row and the block still reads -- FORBIDDEN, the permission sentence", async () => {
    sb.reply([]); // the delete: RLS filtered it, zero rows, no error
    sb.reply({ id: "a1" }); // the read-back: the caller can still see it
    const err = await thrown(deleteAssignment("a1"));
    expect(isSchedulerError(err)).toBe(true);
    expect(err).toEqual({ kind: "WriteRefused" });
    expect(describeSchedulerError(err as never)).toBe("You don't have permission to change that.");
  });

  it("WG-2: the delete removed no row and the block reads nothing -- GONE, 'That block is no longer on the board.'", async () => {
    sb.reply([]);
    sb.reply(null); // the read-back finds nothing
    const err = await thrown(deleteAssignment("a1"));
    expect(err).toEqual({ kind: "WriteRefused", gone: "block" });
    expect(describeSchedulerError(err as never)).toBe("That block is no longer on the board.");
    // the read-back is by id, on the same table, as the caller
    expect(sb.calls).toContain('assignments.eq("id","a1")');
    expect(sb.calls).toContain("assignments.maybeSingle()");
  });

  it("WG-3: a delete that removed the row never reads back and never throws", async () => {
    sb.reply([{ id: "a1" }]);
    await deleteAssignment("a1");
    expect(sb.calls.some((c) => c.includes("maybeSingle"))).toBe(false);
  });

  it("WG-4: the read-back itself failing is not read as 'gone' -- the refusal stays the permission sentence", async () => {
    sb.reply([]);
    sb.reply(null, { message: "boom" });
    const err = await thrown(deleteAssignment("a1"));
    expect(err).toEqual({ kind: "WriteRefused" });
  });
});

describe("updateAssignmentFields: gone or forbidden", () => {
  it("WG-5: an update that matched no row (PostgREST's no-rows answer) on a vanished block is GONE", async () => {
    sb.reply(null, { code: "PGRST116", message: "no rows" });
    sb.reply(null);
    const err = await thrown(updateAssignmentFields("a1", { efficiencyPercent: 100 }));
    expect(err).toEqual({ kind: "WriteRefused", gone: "block" });
  });

  it("WG-6: the same answer with the block still readable is not 'gone'", async () => {
    sb.reply(null, { code: "PGRST116", message: "no rows" });
    sb.reply({ id: "a1" });
    const err = await thrown(updateAssignmentFields("a1", { efficiencyPercent: 100 }));
    expect((err as { gone?: string }).gone).toBeUndefined();
  });
});

describe("deleteRun: gone or forbidden", () => {
  it("WG-7: delete_run's 'run not found' is GONE -- 'That job is no longer on the board.'", async () => {
    sb.reply(null, {
      message: "run not found",
      details: JSON.stringify({
        error: "invalid_argument",
        field: "p_run_id",
        reason: "not found",
      }),
      hint: null,
      code: "PT400",
    });
    const err = await thrown(deleteRun("r1", "cascade"));
    expect(err).toEqual({ kind: "WriteRefused", gone: "job" });
    expect(describeSchedulerError(err as never)).toBe("That job is no longer on the board.");
  });

  it("WG-8: any other refusal from delete_run is unchanged (another invalid argument stays an invalid argument)", async () => {
    sb.reply(null, invalidArgument);
    const err = await thrown(deleteRun("r1", "cascade"));
    expect((err as { kind: string }).kind).toBe("InvalidArgument");
  });
});
