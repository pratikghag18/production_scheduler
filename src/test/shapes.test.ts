import { describe, expect, it } from "vitest";
import {
  parseBoardWindow,
  parseCapacityProbe,
  parseCreateAssignmentResult,
  parseCreateRunResult,
  parseDeleteRunResult,
  parseEligibilityResult,
  parseMoveRunResult,
  parseSplitCoverageResult,
  type Json,
} from "@/lib/api";

// Fixtures built from docs/api.md's worked examples and
// supabase/migrations/20260821000009_api_surface.sql's jsonb_build_object
// calls (raw snake_case, as PostgREST actually returns it) — not guessed
// from prose alone (brief §8).

const run: Json = {
  id: "80000000-0000-0000-0000-000000000001",
  org_id: "10000000-0000-0000-0000-000000000001",
  node_id: "30000000-0000-0000-0000-000000000007",
  product_id: "60000000-0000-0000-0000-000000000001",
  // D110/0029: the snapshot a run keeps once its product is deleted. NULL here
  // because this product still exists — but the keys must be PRESENT, because
  // `isStrOrNull` rejects `undefined` and `board_window` sends every column.
  // ⚠️ `tsc` cannot see a JSON fixture, so nothing but a run would have caught
  // a missing key here.
  product_sku: null,
  product_name: null,
  product_color_token: null,
  timerange: '["2026-08-18 06:00:00+00","2026-08-18 14:00:00+00")',
  planned_headcount: 3,
  notes: null,
  status: "planned",
  created_by: null,
  created_at: "2026-08-17T00:00:00.000Z",
  updated_at: "2026-08-17T00:00:00.000Z",
};

const assignment: Json = {
  id: "90000000-0000-0000-0000-000000000001",
  org_id: "10000000-0000-0000-0000-000000000001",
  node_id: "30000000-0000-0000-0000-000000000007",
  operator_id: "50000000-0000-0000-0000-000000000004",
  operator_display_name: null,
  run_id: "80000000-0000-0000-0000-000000000001",
  product_id: null,
  product_sku: null,
  product_name: null,
  product_color_token: null,
  timerange: '["2026-08-18 06:00:00+00","2026-08-18 14:00:00+00")',
  efficiency: 1.0,
  eligibility_override: false,
  override_reason: null,
  // D113/0030. `isBool` rejects `undefined`, so a missing key here would fail
  // every case in this file at runtime and none of them at compile time.
  area_override: false,
  area_override_reason: null,
  target_qty: null,
  target_unit: null,
  status: "planned",
  created_by: null,
  created_at: "2026-08-17T00:00:00.000Z",
  updated_at: "2026-08-17T00:00:00.000Z",
};

const boardWindowJson: Json = {
  org: {
    id: "10000000-0000-0000-0000-000000000001",
    name: "Northwind Manufacturing",
    settings: { capacity_cap: 1.0 },
  },
  // D86 (migration 0014): board_window emits `template_id` on every level, and
  // `parseLevel` requires it. A payload without one is now correctly rejected —
  // this fixture failed for exactly that reason on the first run after 0014.
  levels: [{ id: "l1", template_id: "tpl-a", position: 0, name: "Site", is_schedulable: false }],
  nodes: [
    {
      id: "30000000-0000-0000-0000-000000000001",
      parent_id: null,
      level_id: "l1",
      name: "Plant 1",
      path: "plant_1",
      sort_order: 0,
      active: true,
    },
  ],
  runs: [run],
  assignments: [assignment],
  operators: [
    {
      id: "50000000-0000-0000-0000-000000000001",
      home_node_id: "30000000-0000-0000-0000-000000000003",
      display_name: "Maria",
      employee_ref: "EMP-001",
      active: true,
      // D109/0028, and D113 is what made the client read it: the part of the
      // structure this person belongs to. `board_window` has emitted it since
      // 0025 and `parseOperator` dropped it, so the board could not tell
      // whether somebody belonged at the cell being scheduled. REQUIRED now.
      site_node_id: "30000000-0000-0000-0000-000000000001",
      skill_ids: ["40000000-0000-0000-0000-000000000001"],
    },
  ],
  products: [
    {
      id: "60000000-0000-0000-0000-000000000001",
      sku: "WX",
      name: "Widget X",
      active: true,
      // §19.64: the server has sent this since 0023 and `parseProduct` reads it
      // now. The fixture carries it so the happy path matches the real payload
      // rather than the subset the parser happens to tolerate.
      color_token: "product-2",
      // D108/0028: `products.site_node_id` is NOT NULL and `board_window` has
      // emitted it since 0025 — the node this product BELONGS TO. REQUIRED by
      // `parseProduct`; the last describe in this file pins that. It names the
      // node in `nodes` above, as the real payload's foreign key does.
      site_node_id: "30000000-0000-0000-0000-000000000001",
    },
  ],
  skills: [{ id: "40000000-0000-0000-0000-000000000001", name: "CNC" }],
  node_skill_requirements: [
    {
      node_id: "30000000-0000-0000-0000-000000000006",
      skill_id: "40000000-0000-0000-0000-000000000001",
    },
  ],
  shift_templates: [
    {
      id: "70000000-0000-0000-0000-000000000001",
      name: "3 × 8h",
      shifts: [
        {
          id: "71000000-0000-0000-0000-000000000001",
          name: "Shift 1",
          start_min: 360,
          end_min: 840,
          breaks: [{ id: "b1", name: "Break 1", start_min: 480, end_min: 495 }],
        },
      ],
    },
  ],
  node_shift_map: [
    {
      node_id: "30000000-0000-0000-0000-000000000007",
      template_id: "70000000-0000-0000-0000-000000000001",
    },
  ],
};

describe("parseBoardWindow", () => {
  it("accepts a valid BoardWindow payload and converts to camelCase", () => {
    const parsed = parseBoardWindow(boardWindowJson);
    expect(parsed).not.toBeNull();
    expect(parsed?.org.id).toBe("10000000-0000-0000-0000-000000000001");
    expect(parsed?.nodes[0]?.parentId).toBeNull();
    expect(parsed?.runs[0]?.nodeId).toBe("30000000-0000-0000-0000-000000000007");
    expect(parsed?.assignments[0]?.operatorId).toBe("50000000-0000-0000-0000-000000000004");
    expect(parsed?.operators[0]?.skillIds).toEqual(["40000000-0000-0000-0000-000000000001"]);
    expect(parsed?.shiftTemplates[0]?.shifts[0]?.breaks[0]?.startMin).toBe(480);
    expect(parsed?.nodeShiftMap[0]?.templateId).toBe("70000000-0000-0000-0000-000000000001");
    expect(parsed?.levels[0]?.templateId).toBe("tpl-a");
  });

  /**
   * D86. `template_id` on a level is not decoration: with two shapes in one
   * org it is the only thing that says which vocabulary a level belongs to,
   * and `canDropOn` refuses a cross-template parent on the strength of it.
   * A payload without it must fail the parse rather than arrive with the
   * field quietly `undefined`.
   *
   * This is a real regression guard, not a hypothetical: the fixture above
   * lacked `template_id` on the first run after migration 0014 and this suite
   * caught it — the parser was right and the fixture was stale.
   */
  it("rejects a level with no template_id (D86)", () => {
    const levels = [{ id: "l1", position: 0, name: "Site", is_schedulable: false }];
    expect(parseBoardWindow({ ...boardWindowJson, levels } as Json)).toBeNull();
  });

  it("rejects a payload missing a required top-level key", () => {
    const { org: _org, ...withoutOrg } = boardWindowJson as Record<string, Json>;
    expect(parseBoardWindow(withoutOrg as Json)).toBeNull();
  });

  it("rejects an array where an object belongs", () => {
    expect(parseBoardWindow([1, 2, 3])).toBeNull();
    expect(parseBoardWindow({ ...boardWindowJson, org: [] } as Json)).toBeNull();
  });

  it("rejects null", () => {
    expect(parseBoardWindow(null)).toBeNull();
  });
});

describe("parseCapacityProbe", () => {
  const valid: Json = {
    fits: false,
    peak: 1.5,
    cap: 1.0,
    overlapping: [
      {
        assignment_id: "9000000a-0000-0000-0000-00000000000a",
        node_id: "3000000a-0000-0000-0000-00000000000a",
        node_name: "Cell 4",
        product_name: "Widget Y",
        timerange: '["2026-08-18 06:00:00+00","2026-08-18 12:00:00+00")',
        efficiency: 0.5,
      },
    ],
  };

  it("accepts a valid payload and converts to camelCase", () => {
    const parsed = parseCapacityProbe(valid);
    expect(parsed).toEqual({
      fits: false,
      peak: 1.5,
      cap: 1.0,
      overlapping: [
        {
          assignmentId: "9000000a-0000-0000-0000-00000000000a",
          nodeId: "3000000a-0000-0000-0000-00000000000a",
          nodeName: "Cell 4",
          productName: "Widget Y",
          timerange: '["2026-08-18 06:00:00+00","2026-08-18 12:00:00+00")',
          efficiency: 0.5,
        },
      ],
    });
  });

  it("rejects a payload missing a required top-level key", () => {
    const { fits: _fits, ...withoutFits } = valid as Record<string, Json>;
    expect(parseCapacityProbe(withoutFits as Json)).toBeNull();
  });

  it("rejects an array where an object belongs", () => {
    expect(parseCapacityProbe({ ...valid, overlapping: {} } as Json)).toBeNull();
    expect(parseCapacityProbe([1, 2, 3])).toBeNull();
  });

  it("rejects null", () => {
    expect(parseCapacityProbe(null)).toBeNull();
  });
});

describe("parseEligibilityResult", () => {
  const valid: Json = {
    eligible: false,
    policy: "warn",
    missing_skills: [{ id: "40000000-0000-0000-0000-000000000001", name: "CNC" }],
    expiring_skills: [],
  };

  it("accepts a valid payload and converts to camelCase", () => {
    expect(parseEligibilityResult(valid)).toEqual({
      eligible: false,
      policy: "warn",
      missingSkills: [{ id: "40000000-0000-0000-0000-000000000001", name: "CNC" }],
      expiringSkills: [],
    });
  });

  it("rejects a payload missing a required top-level key", () => {
    const { policy: _policy, ...withoutPolicy } = valid as Record<string, Json>;
    expect(parseEligibilityResult(withoutPolicy as Json)).toBeNull();
  });

  it("rejects an array where an object belongs", () => {
    expect(parseEligibilityResult([1, 2, 3])).toBeNull();
    expect(parseEligibilityResult({ ...valid, missing_skills: {} } as Json)).toBeNull();
  });

  it("rejects null", () => {
    expect(parseEligibilityResult(null)).toBeNull();
  });
});

describe("parseCreateRunResult", () => {
  const valid: Json = { run };

  it("accepts a valid payload", () => {
    expect(parseCreateRunResult(valid)?.run.id).toBe(run && (run as Record<string, Json>).id);
  });

  it("rejects a payload missing the run key", () => {
    expect(parseCreateRunResult({} as Json)).toBeNull();
  });

  it("rejects an array where an object belongs", () => {
    expect(parseCreateRunResult({ run: [1, 2, 3] } as Json)).toBeNull();
  });

  it("rejects null", () => {
    expect(parseCreateRunResult(null)).toBeNull();
  });
});

describe("parseCreateAssignmentResult", () => {
  const valid: Json = {
    assignment,
    eligibility: { eligible: true, policy: "warn", missing_skills: [], expiring_skills: [] },
  };

  it("accepts a valid payload", () => {
    const parsed = parseCreateAssignmentResult(valid);
    expect(parsed?.assignment.id).toBe("90000000-0000-0000-0000-000000000001");
    expect(parsed?.eligibility.eligible).toBe(true);
  });

  it("rejects a payload missing the eligibility key", () => {
    expect(parseCreateAssignmentResult({ assignment } as Json)).toBeNull();
  });

  it("rejects an array where an object belongs", () => {
    expect(parseCreateAssignmentResult({ assignment: [], eligibility: {} } as Json)).toBeNull();
  });

  it("rejects null", () => {
    expect(parseCreateAssignmentResult(null)).toBeNull();
  });
});

describe("parseMoveRunResult", () => {
  const valid: Json = {
    run,
    assignments: [assignment],
    eligibility_warnings: [
      {
        operator_id: "50000000-0000-0000-0000-000000000002",
        missing_skills: [{ id: "s1", name: "CNC" }],
      },
    ],
  };

  it("accepts a valid payload and converts to camelCase", () => {
    const parsed = parseMoveRunResult(valid);
    expect(parsed?.eligibilityWarnings[0]?.operatorId).toBe("50000000-0000-0000-0000-000000000002");
  });

  it("rejects a payload missing a required top-level key", () => {
    expect(parseMoveRunResult({ run, assignments: [assignment] } as Json)).toBeNull();
  });

  it("rejects an array where an object belongs", () => {
    expect(
      parseMoveRunResult({ ...(valid as Record<string, Json>), assignments: {} } as Json),
    ).toBeNull();
  });

  it("rejects null", () => {
    expect(parseMoveRunResult(null)).toBeNull();
  });
});

describe("parseSplitCoverageResult", () => {
  const valid: Json = { adjusted: [assignment], assignment };

  it("accepts a valid payload with a new assignment", () => {
    expect(parseSplitCoverageResult(valid)?.assignment?.id).toBe(
      "90000000-0000-0000-0000-000000000001",
    );
  });

  it("accepts a valid payload for a pure rebalance (assignment: null)", () => {
    expect(parseSplitCoverageResult({ adjusted: [assignment], assignment: null })).toEqual({
      adjusted: [expect.objectContaining({ id: "90000000-0000-0000-0000-000000000001" })],
      assignment: null,
    });
  });

  it("rejects a payload missing the adjusted key", () => {
    expect(parseSplitCoverageResult({ assignment } as Json)).toBeNull();
  });

  it("rejects an array where an object belongs", () => {
    expect(parseSplitCoverageResult({ adjusted: {}, assignment } as Json)).toBeNull();
  });

  it("rejects null", () => {
    expect(parseSplitCoverageResult(null)).toBeNull();
  });
});

describe("parseDeleteRunResult", () => {
  const valid: Json = {
    deleted_run_id: "80000000-0000-0000-0000-000000000004",
    detached_assignment_ids: [],
  };

  it("accepts a valid payload and converts to camelCase", () => {
    expect(parseDeleteRunResult(valid)).toEqual({
      deletedRunId: "80000000-0000-0000-0000-000000000004",
      detachedAssignmentIds: [],
    });
  });

  it("rejects a payload missing the deleted_run_id key", () => {
    expect(parseDeleteRunResult({ detached_assignment_ids: [] } as Json)).toBeNull();
  });

  it("rejects an array where an object belongs", () => {
    expect(
      parseDeleteRunResult({ deleted_run_id: "x", detached_assignment_ids: {} } as Json),
    ).toBeNull();
  });

  it("rejects null", () => {
    expect(parseDeleteRunResult(null)).toBeNull();
  });
});

/*
 * §19.64 — the one field in `parseProduct` that does not reject the row.
 *
 * `color_token` is presentation, and `parseBoardWindow` fails TOTALLY: one bad
 * product nulls the whole window, which `board.ts` turns into a thrown
 * `shapeMismatch` and an empty board. Blanking a plant's schedule because a
 * swatch is missing is not a trade worth making, so an absent value degrades to
 * `""` and the board falls back to the first palette token.
 *
 * Both halves of that trade are pinned here, because a leniency nobody asserts
 * is indistinguishable from a parser that forgot the field.
 */
describe("parseProduct — the colour is presentation, not identity", () => {
  it("reads the colour the server actually sends", () => {
    const win = parseBoardWindow(boardWindowJson);
    expect(win?.products[0]?.colorToken).toBe("product-2");
  });

  it("degrades a missing colour to empty rather than nulling the whole window", () => {
    const raw = JSON.parse(JSON.stringify(boardWindowJson)) as {
      products: { color_token?: string }[];
    };
    delete raw.products[0].color_token;
    const win = parseBoardWindow(raw as unknown as Json);
    expect(win).not.toBe(null);
    expect(win?.products[0]?.colorToken).toBe("");
  });
});

/*
 * D108 / migration 0028 — the OWNER, and why it is the opposite trade from the
 * colour directly above.
 *
 * `products.site_node_id` is NOT NULL and says where the product belongs;
 * `app_guard_run_scope` / `app_guard_assignment_scope` refuse a run or
 * assignment whose product is not owned by an ancestor-or-self of the target
 * cell (`not_offered_here`), and there is NO override for products. So it is
 * identity, like `sku`, not presentation like `color_token`.
 *
 * ⚠️ And a coerced `""` would not be the cautious choice it looks like:
 * `offeredAt` FAILS OPEN on an owner it cannot resolve, so an empty owner
 * reads as "cannot tell" and the product would be offered at EVERY cell and
 * refused at all of them. Rejecting the row is the honest answer to a payload
 * this client does not understand.
 */
describe("parseProduct — the owner is identity, and has no degraded value", () => {
  it("keeps the owner the server actually sends", () => {
    const win = parseBoardWindow(boardWindowJson);
    expect(win?.products[0]?.siteNodeId).toBe("30000000-0000-0000-0000-000000000001");
  });

  it("rejects a product with no site_node_id rather than coercing it to empty", () => {
    const raw = JSON.parse(JSON.stringify(boardWindowJson)) as {
      products: { site_node_id?: string | null }[];
    };
    delete raw.products[0].site_node_id;
    expect(parseBoardWindow(raw as unknown as Json)).toBeNull();
  });

  it("rejects a product whose site_node_id is null — 0028 removed that option", () => {
    const raw = JSON.parse(JSON.stringify(boardWindowJson)) as {
      products: { site_node_id?: string | null }[];
    };
    raw.products[0].site_node_id = null;
    expect(parseBoardWindow(raw as unknown as Json)).toBeNull();
  });
});

/* ===========================================================================
 * D110 (migration 0029) and D113 (0030) — the nullable columns, and the case
 * that would have taken the whole board down.
 *
 * ⚠️ NONE OF THIS IS VISIBLE TO `tsc`. The fixtures above are `Json`, so a
 * missing key is `undefined` at runtime and nothing at compile time — the same
 * shape as §19.72a's "a compiler cannot see a string expectation", one costume
 * along. The three keys added to `run` and the five added to `assignment` were
 * put there because these cases demanded them, not because anything complained.
 * =========================================================================== */

describe("a run whose product has been deleted", () => {
  function withRun(over: Record<string, unknown>): Json {
    const raw = JSON.parse(JSON.stringify(boardWindowJson)) as { runs: Record<string, unknown>[] };
    raw.runs[0] = { ...raw.runs[0], ...over };
    return raw as unknown as Json;
  }

  it("⭐⭐ parses AT ALL — one row that does not is the whole board gone", () => {
    // `parseArrayOf` returns null for the WHOLE ARRAY on the first item that
    // fails, so `parseBoardWindow` would return null and `fetchBoardWindow`
    // would throw `shapeMismatch`. Before this change `productId` was typed
    // `string` and guarded with `isStr`, so the first deleted product with
    // history stopped the board loading for everyone, with an error about a
    // shape rather than about a product.
    expect(
      parseBoardWindow(withRun({ product_id: null, product_sku: "WX", product_name: "Widget X" })),
    ).not.toBeNull();
  });

  it("keeps the remembered sku and releases the id", () => {
    const win = parseBoardWindow(
      withRun({ product_id: null, product_sku: "WX", product_name: "Widget X" }),
    );
    expect(win?.runs[0]?.productId).toBeNull();
    expect(win?.runs[0]?.productSku).toBe("WX");
  });

  it("rejects a payload with the snapshot keys ABSENT rather than null", () => {
    // `isStrOrNull` rejects `undefined`, and `board_window` emits every column
    // via `to_jsonb(r)` — so an absent key means a database older than 0029,
    // not a legal shape.
    const raw = JSON.parse(JSON.stringify(boardWindowJson)) as {
      runs: Record<string, unknown>[];
    };
    delete raw.runs[0].product_sku;
    expect(parseBoardWindow(raw as unknown as Json)).toBeNull();
  });
});

describe("an assignment whose operator has been deleted", () => {
  it("⭐ parses, and keeps the name remembered at the moment they went", () => {
    const raw = JSON.parse(JSON.stringify(boardWindowJson)) as {
      assignments: Record<string, unknown>[];
    };
    raw.assignments[0].operator_id = null;
    raw.assignments[0].operator_display_name = "Dana Departing";
    const win = parseBoardWindow(raw as unknown as Json);
    expect(win?.assignments[0]?.operatorId).toBeNull();
    expect(win?.assignments[0]?.operatorDisplayName).toBe("Dana Departing");
  });

  it("D113: carries the area override, and rejects a payload without it", () => {
    expect(parseBoardWindow(boardWindowJson)?.assignments[0]?.areaOverride).toBe(false);
    const raw = JSON.parse(JSON.stringify(boardWindowJson)) as {
      assignments: Record<string, unknown>[];
    };
    delete raw.assignments[0].area_override;
    expect(parseBoardWindow(raw as unknown as Json)).toBeNull();
  });
});

describe("an operator carries the part of the structure they belong to", () => {
  it("D109/D113: parseOperator keeps site_node_id — it was sent and dropped", () => {
    expect(parseBoardWindow(boardWindowJson)?.operators[0]?.siteNodeId).toBe(
      "30000000-0000-0000-0000-000000000001",
    );
  });

  it("and rejects a row without one, rather than coercing it to empty", () => {
    // `""` would be worse than rejecting: `offeredAt` FAILS OPEN on an owner it
    // cannot resolve, so an empty owner reads as "belongs everywhere" and the
    // popover would annotate nobody.
    const raw = JSON.parse(JSON.stringify(boardWindowJson)) as {
      operators: Record<string, unknown>[];
    };
    delete raw.operators[0].site_node_id;
    expect(parseBoardWindow(raw as unknown as Json)).toBeNull();
  });
});
