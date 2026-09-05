/**
 * The per-plant settings API (migration 0050, R-331), held against the shape
 * the server actually offers.
 *
 * ⛔ THE CASE THIS FILE EXISTS FOR IS "SET TO WARN" VERSUS "INHERITING WARN".
 * They render the same word and they are different states: a plant somebody
 * deliberately set to `warn` stays on `warn` when the company moves to `block`,
 * and a plant that is merely inheriting moves with it. Collapsing them is the
 * exact hole F-088 found in the jsonb bag — `settings->>'k'` reads back null for
 * a missing key AND for a key holding a JSON null — and it is why 0050 stores
 * overrides as ROWS. If `override` ever came back as `null` for a plant that has
 * a row, the Settings screen could no longer say which plant is overriding,
 * which is the one thing that screen exists to say.
 *
 * ⛔ AND "CLEAR" MUST NOT BE "SET TO NULL". They are two different RPCs on the
 * server for that reason, and a client that sent `set_node_setting(node, key,
 * null)` would be refused (`invalid_argument`) rather than clearing — so a
 * screen wired that way would look broken instead of quietly wrong, but only if
 * the two calls stay distinct HERE. `tsc` cannot see an RPC name; this file can.
 *
 * ⚠️ THE RESOLUTION SHORTCUT IS ONLY LEGAL FOR ROOTS. The server's rule is "the
 * nearest ancestor-or-self carrying an answer, else the company's"; a root has
 * no ancestors, so for a root it reduces to "its own override, else the
 * company's". The read must therefore ask for ROOTS ONLY, and the last case
 * pins the `parent_id is null` filter that makes the shortcut true.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/* ---------------------------------------------------------------------------
   A RECORDING POSTGREST CLIENT, keyed by table — `fetchPlantEligibilityPolicies`
   fires two reads in one Promise.all and they must not be able to answer each
   other's question.
   ------------------------------------------------------------------------ */
const sb = vi.hoisted(() => {
  const calls: unknown[][] = [];
  const replies = new Map<string, { data: unknown; error: unknown }>();
  const rpcCalls: unknown[][] = [];

  function builderFor(table: string): Record<string, unknown> {
    const builder: Record<string, unknown> = {};
    const record =
      (name: string) =>
      (...args: unknown[]) => {
        calls.push([table, name, ...args]);
        return builder;
      };
    for (const method of ["select", "order", "eq", "is", "in", "limit"]) {
      builder[method] = record(method);
    }
    builder.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(replies.get(table) ?? { data: [], error: null }).then(onFulfilled);
    return builder;
  }

  return {
    calls,
    rpcCalls,
    reset() {
      calls.length = 0;
      rpcCalls.length = 0;
      replies.clear();
    },
    reply(table: string, data: unknown, error: unknown = null) {
      replies.set(table, { data, error });
    },
    client: {
      from(table: string) {
        calls.push([table, "from"]);
        return builderFor(table);
      },
      rpc(...args: unknown[]) {
        rpcCalls.push(args);
        return Promise.resolve({ data: null, error: null });
      },
    },
    /** Every call recorded against one table, as `[method, ...args]`. */
    on(table: string): unknown[][] {
      return calls.filter((c) => c[0] === table).map((c) => c.slice(1));
    },
  };
});

vi.mock("@/lib/supabase", () => ({ supabase: sb.client }));

const { fetchPlantEligibilityPolicies, setPlantEligibilityPolicy, clearPlantEligibilityPolicy } =
  await import("@/lib/api/access");

const PLANTS = [
  { id: "n1", name: "Plant 1" },
  { id: "n2", name: "Plant 2" },
];

beforeEach(() => sb.reset());

describe("R-331: reading what each plant's eligibility rule actually is", () => {
  it("tells a plant that is SET apart from a plant that is INHERITING, even when both read warn", async () => {
    sb.reply("nodes", PLANTS);
    sb.reply("node_settings", [{ node_id: "n1", value: "warn" }]);

    const rows = await fetchPlantEligibilityPolicies("warn");

    // Both are on `warn` today. Only one of them would still be on `warn`
    // tomorrow if the company switched to `block`, and that is the difference
    // the screen has to render.
    expect(rows).toEqual([
      { nodeId: "n1", name: "Plant 1", override: "warn", effective: "warn" },
      { nodeId: "n2", name: "Plant 2", override: null, effective: "warn" },
    ]);
  });

  it("lets a plant's own answer beat the company's, in both directions", async () => {
    sb.reply("nodes", PLANTS);
    sb.reply("node_settings", [{ node_id: "n2", value: "warn" }]);

    // The company is strict; Plant 2 has been let off. This is the half of the
    // maintainer's sentence — "one strict plant and one permissive one" — that a
    // stricter-only implementation would quietly drop.
    const rows = await fetchPlantEligibilityPolicies("block");

    expect(rows.map((r) => [r.nodeId, r.override, r.effective])).toEqual([
      ["n1", null, "block"],
      ["n2", "warn", "warn"],
    ]);
  });

  it("treats anything that is not one of the two values as no override at all", async () => {
    sb.reply("nodes", [PLANTS[0]]);
    // A hand-edited row, a value from a future migration this build predates.
    // None of these may be reported as an override, and none may take the
    // screen down — the same defensive stance `coerceEligibilityPolicy` takes
    // over the org bag.
    for (const junk of [null, "", "Block", "BLOCK", "strict", 0, true, [], {}]) {
      sb.reply("node_settings", [{ node_id: "n1", value: junk }]);
      const rows = await fetchPlantEligibilityPolicies("warn");
      expect(rows[0].override).toBeNull();
      expect(rows[0].effective).toBe("warn");
    }
  });

  it("asks for ROOTS only, which is what makes the one-line resolution correct", async () => {
    sb.reply("nodes", PLANTS);
    sb.reply("node_settings", []);
    await fetchPlantEligibilityPolicies("warn");

    // ⛔ Without this filter the list would contain deeper nodes, and
    // `override ?? orgPolicy` would be the WRONG rule for them: the server
    // resolves through every ancestor, and an override on an ancestor this
    // caller cannot read would silently drop out of the client's answer.
    expect(sb.on("nodes")).toContainEqual(["is", "parent_id", null]);
    expect(sb.on("node_settings")).toContainEqual(["eq", "key", "eligibility_policy"]);
  });
});

describe("R-331: writing one plant's rule, and taking it back off", () => {
  it("sets through set_node_setting, naming the key the server validates", async () => {
    await setPlantEligibilityPolicy("n2", "block");
    expect(sb.rpcCalls).toEqual([
      ["set_node_setting", { p_node_id: "n2", p_key: "eligibility_policy", p_value: "block" }],
    ]);
  });

  it("clears through clear_node_setting — a different verb, never a null value", async () => {
    await clearPlantEligibilityPolicy("n2");

    expect(sb.rpcCalls).toEqual([
      ["clear_node_setting", { p_node_id: "n2", p_key: "eligibility_policy" }],
    ]);
    // The failure this pins: `set_node_setting(node, key, null)` is refused by
    // the server with invalid_argument, so a client that "cleared" that way
    // would leave a strict plant strict while telling the person it had been
    // returned to inheriting.
    expect(JSON.stringify(sb.rpcCalls)).not.toContain("set_node_setting");
  });
});
