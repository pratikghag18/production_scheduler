/**
 * S66-a (R-441/R-442/R-443, migration 0082): the client-side halves of "a
 * person belongs to a shift" -- both directions, per the brief's own words.
 *
 * Three parsers, three files:
 *   - `parseOperatorRecord`/`OPERATOR_COLUMNS` (src/lib/api/operators.ts):
 *     the admin-screen operator row gains `homeShiftId`.
 *   - `parseBoardWindow` (src/lib/api/shapes.ts): the board operator gains
 *     `homeShiftId`, and the payload gains a top-level `me` (the caller's
 *     own effective shift-planning restriction).
 *   - `buildAccessRows` (src/features/admin/lib/siteAccess.ts): `AccessRow`
 *     gains `plansShiftId`/`outsideShift`, read leniently since the
 *     `site_people` RPC does not emit them yet (a later lane's wiring).
 *
 * Not covered here (S66-b..e, not this lane): the rail, the pop-ups, the
 * bar, and the admin screens that will actually READ these fields.
 */
import { describe, expect, it } from "vitest";
import { parseBoardWindow, type Json } from "@/lib/api";
import { OPERATOR_COLUMNS, parseOperatorRecord } from "@/lib/api/operators";
import { buildAccessRows } from "@/features/admin/lib/siteAccess";

// ===========================================================================
// operators.ts: OperatorRecord / OPERATOR_COLUMNS / parseOperatorRecord
// ===========================================================================

/** `"id, ..., home_shift_id"` -> the column list, split and trimmed. */
function selectedOperatorColumns(): string[] {
  return OPERATOR_COLUMNS.split(",").map((c) => c.trim());
}

/**
 * A row shaped the way PostgREST returns one for exactly OPERATOR_COLUMNS --
 * built FROM the constant, never a hand-written literal (apiShiftShape.test.ts's
 * own reasoning: a fixture derived from the read cannot drift from it).
 */
function operatorRowFromSelect(over: Record<string, unknown> = {}): Record<string, unknown> {
  const sample: Record<string, unknown> = {
    id: "50000000-0000-0000-0000-000000000004",
    display_name: "Elena",
    employee_ref: null,
    active: true,
    site_node_id: "30000000-0000-0000-0000-000000000002",
    source: "manual",
    external_id: null,
    home_shift_id: null,
  };
  const row: Record<string, unknown> = {};
  for (const col of selectedOperatorColumns()) row[col] = sample[col];
  return { ...row, ...over };
}

describe("OPERATOR_COLUMNS / parseOperatorRecord: home_shift_id", () => {
  it("OPERATOR_COLUMNS asks for home_shift_id", () => {
    expect(selectedOperatorColumns()).toContain("home_shift_id");
  });

  it("a row with no home band (home_shift_id: null) parses, homeShiftId: null", () => {
    const parsed = parseOperatorRecord(operatorRowFromSelect());
    expect(parsed).not.toBeNull();
    expect(parsed?.homeShiftId).toBeNull();
  });

  it("a row WITH a home band parses, homeShiftId carries the id", () => {
    const parsed = parseOperatorRecord(
      operatorRowFromSelect({ home_shift_id: "71000000-0000-0000-0000-000000000002" }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.homeShiftId).toBe("71000000-0000-0000-0000-000000000002");
  });

  it("a row missing the key outright is rejected, not coerced to null", () => {
    const row = operatorRowFromSelect();
    delete row.home_shift_id;
    expect(parseOperatorRecord(row)).toBeNull();
  });

  it("a non-string, non-null home_shift_id is rejected", () => {
    expect(parseOperatorRecord(operatorRowFromSelect({ home_shift_id: 42 }))).toBeNull();
    expect(parseOperatorRecord(operatorRowFromSelect({ home_shift_id: true }))).toBeNull();
  });
});

// ===========================================================================
// shapes.ts: parseBoardWindow -- operators[].home_shift_id and top-level `me`
// ===========================================================================

/** The smallest payload parseBoardWindow accepts, one operator, no `me`. */
function minimalBoardWindow(over: Record<string, unknown> = {}): Json {
  return {
    org: { id: "org1", name: "Northwind", settings: {} },
    levels: [],
    nodes: [],
    runs: [],
    assignments: [],
    operators: [
      {
        id: "50000000-0000-0000-0000-000000000004",
        home_node_id: null,
        home_shift_id: null,
        display_name: "Elena",
        employee_ref: null,
        active: true,
        site_node_id: "n-plant",
        site_path: "plant_1",
        skill_ids: [],
        skill_expiries: [],
      },
    ],
    products: [],
    skills: [],
    node_skill_requirements: [],
    shift_templates: [],
    node_shift_map: [],
    cycle_times: [],
    can_place: true,
    node_policies: [],
    date_format: "d_mon_yyyy",
    ...over,
  } as Json;
}

describe("parseBoardWindow: operators[].home_shift_id", () => {
  it("null (no home band) parses through", () => {
    const parsed = parseBoardWindow(minimalBoardWindow());
    expect(parsed).not.toBeNull();
    expect(parsed?.operators[0]?.homeShiftId).toBeNull();
  });

  it("a set home band parses through", () => {
    const json = minimalBoardWindow();
    const payload = json as { operators: Record<string, unknown>[] };
    payload.operators[0].home_shift_id = "71000000-0000-0000-0000-000000000002";
    const parsed = parseBoardWindow(json);
    expect(parsed?.operators[0]?.homeShiftId).toBe("71000000-0000-0000-0000-000000000002");
  });

  it("a missing key rejects the WHOLE payload (R-441 is required, like home_node_id beside it)", () => {
    const json = minimalBoardWindow();
    const payload = json as { operators: Record<string, unknown>[] };
    delete payload.operators[0].home_shift_id;
    expect(parseBoardWindow(json)).toBeNull();
  });
});

describe("parseBoardWindow: `me` (R-442, the caller's own planning restriction)", () => {
  it("an absent `me` key (an older payload, predating 0082) reads as null -- unrestricted", () => {
    const parsed = parseBoardWindow(minimalBoardWindow());
    expect(parsed).not.toBeNull();
    expect(parsed?.me).toBeNull();
  });

  it("a present `me` with no covering grant (server sends null) reads as null", () => {
    const parsed = parseBoardWindow(minimalBoardWindow({ me: null }));
    expect(parsed?.me).toBeNull();
  });

  it("a `me` that plans no shift (plansShiftId: null) parses, outsideShift carried", () => {
    const parsed = parseBoardWindow(
      minimalBoardWindow({ me: { plans_shift_id: null, outside_shift: true } }),
    );
    expect(parsed?.me).toEqual({ plansShiftId: null, outsideShift: true });
  });

  it("a `me` bound to a shift with outside_shift=false parses both fields", () => {
    const parsed = parseBoardWindow(
      minimalBoardWindow({
        me: { plans_shift_id: "71000000-0000-0000-0000-000000000001", outside_shift: false },
      }),
    );
    expect(parsed?.me).toEqual({
      plansShiftId: "71000000-0000-0000-0000-000000000001",
      outsideShift: false,
    });
  });

  it("a malformed `me` (wrong types) reads as null rather than blanking the board", () => {
    const parsed = parseBoardWindow(
      minimalBoardWindow({ me: { plans_shift_id: 42, outside_shift: "yes" } }),
    );
    expect(parsed).not.toBeNull(); // the rest of the board still parses
    expect(parsed?.me).toBeNull();
  });
});

// ===========================================================================
// siteAccess.ts: buildAccessRows -- AccessRow.plansShiftId / .outsideShift
// ===========================================================================

const BASE_PAYLOAD = {
  nodeId: "n1",
  nodeName: "Assembly",
  people: [
    {
      profileId: "p-ana",
      email: "ana@example.test",
      companyAdmin: false,
      grants: [{ nodeId: "n1", nodeName: "Assembly", role: "supervisor" }],
    },
  ],
};

describe("buildAccessRows: AccessRow.plansShiftId / .outsideShift", () => {
  it("a grant that omits both keys (site_people has not been wired yet) reads as unrestricted", () => {
    const view = buildAccessRows(BASE_PAYLOAD, null);
    const ana = view.rows.find((r) => r.profileId === "p-ana");
    expect(ana?.plansShiftId).toBeNull();
    expect(ana?.outsideShift).toBe(true);
  });

  it("a direct grant carrying both keys is read onto the row", () => {
    const payload = {
      ...BASE_PAYLOAD,
      people: [
        {
          profileId: "p-ana",
          email: "ana@example.test",
          companyAdmin: false,
          grants: [
            {
              nodeId: "n1",
              nodeName: "Assembly",
              role: "supervisor",
              plansShiftId: "71000000-0000-0000-0000-000000000001",
              outsideShift: false,
            },
          ],
        },
      ],
    };
    const view = buildAccessRows(payload, null);
    const ana = view.rows.find((r) => r.profileId === "p-ana");
    expect(ana?.plansShiftId).toBe("71000000-0000-0000-0000-000000000001");
    expect(ana?.outsideShift).toBe(false);
  });

  it("a person with no DIRECT grant (only inherited) reads unrestricted regardless of the inherited grant's own fields", () => {
    const payload = {
      nodeId: "n2",
      nodeName: "Line 1",
      people: [
        {
          profileId: "p-ana",
          email: "ana@example.test",
          companyAdmin: false,
          grants: [
            {
              nodeId: "n1",
              nodeName: "Assembly",
              role: "supervisor",
              plansShiftId: "71000000-0000-0000-0000-000000000001",
              outsideShift: false,
            },
          ],
        },
      ],
    };
    const view = buildAccessRows(payload, null);
    const ana = view.rows.find((r) => r.profileId === "p-ana");
    expect(ana?.directRole).toBeNull(); // n1 is inherited, not direct, here
    expect(ana?.plansShiftId).toBeNull();
    expect(ana?.outsideShift).toBe(true);
  });
});
