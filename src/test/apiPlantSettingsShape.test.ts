/**
 * The per-plant settings API (migrations 0050 and 0052; R-331, R-333), held
 * against the shape the server actually offers.
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
 * ⭐ THE WRAPPERS ARE KEYED BY THE SETTING, NOT NAMED AFTER ONE (R-333). They
 * shipped as `fetchPlantEligibilityPolicies` / `setPlantEligibilityPolicy` /
 * `clearPlantEligibilityPolicy`, three functions that hard-coded
 * `'eligibility_policy'` in their RPC bodies — so the second setting would have
 * meant three more saying the same thing about a different string. The server
 * was already generic; this layer now is too, and the cases below drive both
 * keys through the same three functions.
 *
 * ⚠️ THE RESOLUTION SHORTCUT IS ONLY LEGAL FOR ROOTS. The server's rule is "the
 * nearest ancestor-or-self carrying an answer, else the company's"; a root has
 * no ancestors, so for a root it reduces to "its own override, else the
 * company's". The read must therefore ask for ROOTS ONLY, and one case below
 * pins the `parent_id is null` filter that makes the shortcut true.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/* ---------------------------------------------------------------------------
   A RECORDING POSTGREST CLIENT, keyed by table — `fetchPlantSettings` fires two
   reads in one Promise.all and they must not be able to answer each other's
   question.
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

const { NODE_SETTING_KEYS, fetchPlantSettings, setPlantSetting, clearPlantSetting } =
  await import("@/lib/api/access");

const PLANTS = [
  { id: "n1", name: "Plant 1" },
  { id: "n2", name: "Plant 2" },
];

beforeEach(() => sb.reset());

describe("R-331/R-333: reading what each plant has said for itself", () => {
  it("tells a plant that is SET apart from a plant that is INHERITING, even when both read warn", async () => {
    sb.reply("nodes", PLANTS);
    sb.reply("node_settings", [{ node_id: "n1", value: "warn" }]);

    const rows = await fetchPlantSettings("eligibility_policy");

    // Only one of these would still be on `warn` tomorrow if the company
    // switched to `block`, and that is the difference the screen has to render.
    expect(rows).toEqual([
      { nodeId: "n1", name: "Plant 1", override: "warn" },
      { nodeId: "n2", name: "Plant 2", override: null },
    ]);
  });

  it("reads the date format through the very same function", async () => {
    sb.reply("nodes", PLANTS);
    sb.reply("node_settings", [{ node_id: "n2", value: "iso" }]);

    const rows = await fetchPlantSettings("date_format");

    expect(rows.map((r) => [r.nodeId, r.override])).toEqual([
      ["n1", null],
      ["n2", "iso"],
    ]);
    // ⛔ THE KEY IS THE ARGUMENT, and the read must ask the server for it. A
    // wrapper that filtered on a hard-coded key would return the eligibility
    // rows here and the screen would show `warn` as a date format.
    expect(sb.on("node_settings")).toContainEqual(["eq", "key", "date_format"]);
  });

  /**
   * ⛔ THIS LAYER RETURNS THE RAW TEXT AND COERCES NOTHING, which is a decision
   * rather than an omission. What a legal value IS differs per key, so a parser
   * here would carry a second copy of both vocabularies — CLAUDE.md §4's
   * "column list that appears twice". `asDateFormat` / `asEligibilityPolicy` in
   * `useOrgSettings.ts` are where junk becomes `null`, and
   * `src/test/plantSettings.test.ts` drives them.
   *
   * What this layer DOES owe is that a non-string never reaches the caller as
   * one: `node_settings.value` is NOT NULL text on the server, so anything else
   * is a row that should not exist, and it must read as "no override" rather
   * than take the screen down.
   */
  it("passes the stored text through untouched, and reads a non-string as no override", async () => {
    sb.reply("nodes", [PLANTS[0]]);
    for (const junk of [null, undefined, 0, true, [], {}]) {
      sb.reply("node_settings", [{ node_id: "n1", value: junk }]);
      expect((await fetchPlantSettings("date_format"))[0].override).toBeNull();
    }
    // A value from a future migration this build predates is still a string and
    // is carried, not swallowed — the coercer one layer up decides about it.
    sb.reply("node_settings", [{ node_id: "n1", value: "some_future_token" }]);
    expect((await fetchPlantSettings("date_format"))[0].override).toBe("some_future_token");
  });

  it("asks for ROOTS only, which is what makes the one-line resolution correct", async () => {
    sb.reply("nodes", PLANTS);
    sb.reply("node_settings", []);
    await fetchPlantSettings("eligibility_policy");

    // ⛔ Without this filter the list would contain deeper nodes, and
    // "own override, else the company's" would be the WRONG rule for them: the
    // server resolves through every ancestor, and an override on an ancestor
    // this caller cannot read would silently drop out of the client's answer.
    expect(sb.on("nodes")).toContainEqual(["is", "parent_id", null]);
    expect(sb.on("node_settings")).toContainEqual(["eq", "key", "eligibility_policy"]);
  });

  /**
   * ⚠️ NO COMPANY VALUE IS FETCHED OR FOLDED IN. The eligibility-only version
   * took an `orgPolicy` argument and returned a resolved `effective` field,
   * which meant the CACHE KEY had to carry the company's answer or a stale list
   * would keep showing the old company value against every inheriting plant.
   * Resolving one layer up deletes both the argument and the hazard.
   */
  it("reads two tables and no more — the company's answer is not this read's business", async () => {
    sb.reply("nodes", PLANTS);
    sb.reply("node_settings", []);
    await fetchPlantSettings("date_format");
    expect(new Set(sb.calls.map((c) => c[0]))).toEqual(new Set(["nodes", "node_settings"]));
    expect(sb.rpcCalls).toEqual([]);
  });
});

describe("R-331/R-333: writing one place's answer, and taking it back off", () => {
  it("sets through set_node_setting, naming the key the server validates", async () => {
    await setPlantSetting("n2", "eligibility_policy", "block");
    await setPlantSetting("n2", "date_format", "iso");
    expect(sb.rpcCalls).toEqual([
      ["set_node_setting", { p_node_id: "n2", p_key: "eligibility_policy", p_value: "block" }],
      ["set_node_setting", { p_node_id: "n2", p_key: "date_format", p_value: "iso" }],
    ]);
  });

  it("clears through clear_node_setting — a different verb, never a null value", async () => {
    await clearPlantSetting("n2", "date_format");

    expect(sb.rpcCalls).toEqual([
      ["clear_node_setting", { p_node_id: "n2", p_key: "date_format" }],
    ]);
    // The failure this pins: `set_node_setting(node, key, null)` is refused by
    // the server with invalid_argument, so a client that "cleared" that way
    // would leave a strict plant strict while telling the person it had been
    // returned to inheriting.
    expect(JSON.stringify(sb.rpcCalls)).not.toContain("set_node_setting");
  });

  /**
   * ⛔ CLEARING IS PER KEY, NOT PER PLACE. The primary key is `(node_id, key)`.
   * A wrapper that sent only the node — the shape a "reset this plant" helper
   * takes — would have returning the date format to inheriting also throw away
   * the plant's eligibility rule, which is a safety setting silently unset by a
   * cosmetic one. Pinned on the server side by 73's P21.
   */
  it("names the key when clearing, so one setting cannot unset another", async () => {
    await clearPlantSetting("n2", "eligibility_policy");
    expect(sb.rpcCalls[0][1]).toEqual({ p_node_id: "n2", p_key: "eligibility_policy" });
  });

  /**
   * ⚠️ THE KEY LIST MIRRORS `node_settings_key_check`, and a member here
   * without a matching migration is a control the server refuses with
   * `invalid_argument`. Migration 0052's header carries what a third costs.
   */
  it("offers exactly the keys the server validates", () => {
    expect([...NODE_SETTING_KEYS]).toEqual(["eligibility_policy", "date_format"]);
  });
});
