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
  run_id: "80000000-0000-0000-0000-000000000001",
  product_id: null,
  timerange: '["2026-08-18 06:00:00+00","2026-08-18 14:00:00+00")',
  efficiency: 1.0,
  eligibility_override: false,
  override_reason: null,
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
  levels: [{ id: "l1", position: 0, name: "Site", is_schedulable: false }],
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
      skill_ids: ["40000000-0000-0000-0000-000000000001"],
    },
  ],
  products: [
    { id: "60000000-0000-0000-0000-000000000001", sku: "WX", name: "Widget X", active: true },
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
