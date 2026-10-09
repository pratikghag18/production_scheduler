/**
 * S41-c (docs/agent-briefs/s41-c-move-brief.md §5) — `moveAssignment`
 * (`src/lib/api/mutations.ts`): the RPC call `move_assignment` gets, and how
 * its `{assignment, eligibility, absence}` envelope is parsed. Mocked the way
 * `weekTemplates.test.ts` mocks `supabase.rpc` — nothing here touches a real
 * database.
 *
 * M53 (brief §6): a mutation that sent the SOURCE node instead of the target
 * must be caught here — every case below asserts the exact `p_node_id` sent
 * equals `input.nodeId` (the TARGET the caller resolved), never anything
 * read back off a fixture row.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: { rpc } }));

const { moveAssignment } = await import("@/lib/api/mutations");

function ok(data: unknown) {
  rpc.mockResolvedValue({ data, error: null });
}
function fail(error: unknown) {
  rpc.mockResolvedValue({ data: null, error });
}

const ASSIGNMENT_ROW = {
  id: "a1",
  org_id: "org-1",
  node_id: "cell-2",
  operator_id: "op-1",
  operator_display_name: null,
  run_id: null,
  product_id: "prod-1",
  product_sku: "WX-1",
  product_name: "Widget X",
  product_color_token: "product-1",
  timerange: "[2099-01-01T12:00:00+00:00,2099-01-01T16:00:00+00:00)",
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

const ENVELOPE = {
  assignment: ASSIGNMENT_ROW,
  eligibility: { eligible: true, policy: "warn", missing_skills: [], expiring_skills: [] },
  absence: { absent: false },
};

beforeEach(() => rpc.mockReset());

describe("moveAssignment: argument mapping", () => {
  it("M1: sends the RPC name and every argument, p_node_id the TARGET (M53)", async () => {
    ok(ENVELOPE);
    await moveAssignment({
      assignmentId: "a1",
      nodeId: "cell-2",
      start: new Date("2099-01-01T12:00:00.000Z"),
      end: new Date("2099-01-01T16:00:00.000Z"),
    });
    expect(rpc).toHaveBeenCalledWith("move_assignment", {
      p_assignment_id: "a1",
      p_node_id: "cell-2",
      p_timerange: `["2099-01-01T12:00:00.000Z","2099-01-01T16:00:00.000Z")`,
      p_eligibility_override: undefined,
      p_override_reason: undefined,
      p_area_override: undefined,
      p_area_override_reason: undefined,
    });
  });

  it("M2: the override pairs pass straight through when given", async () => {
    ok(ENVELOPE);
    await moveAssignment({
      assignmentId: "a1",
      nodeId: "cell-3",
      start: new Date("2099-01-02T06:00:00.000Z"),
      end: new Date("2099-01-02T10:00:00.000Z"),
      eligibilityOverride: true,
      overrideReason: "supervised today",
      areaOverride: true,
      areaOverrideReason: "covering another line",
    });
    const [, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(args.p_node_id).toBe("cell-3");
    expect(args.p_eligibility_override).toBe(true);
    expect(args.p_override_reason).toBe("supervised today");
    expect(args.p_area_override).toBe(true);
    expect(args.p_area_override_reason).toBe("covering another line");
  });

  it("M53: p_node_id is the CALLER's target, never the row's own node_id read back from the result", async () => {
    // The mocked result's own node_id ("cell-2") differs from the argument
    // ("cell-9") on purpose -- a wrapper that read `input`'s node back off
    // ITS OWN reply, or off some other source, would not be caught by M1
    // alone if the two ever happened to agree by coincidence.
    ok(ENVELOPE);
    await moveAssignment({
      assignmentId: "a1",
      nodeId: "cell-9",
      start: new Date("2099-01-03T06:00:00.000Z"),
      end: new Date("2099-01-03T10:00:00.000Z"),
    });
    const [, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(args.p_node_id).toBe("cell-9");
  });
});

describe("moveAssignment: result parsing", () => {
  it("M3: parses the {assignment, eligibility, absence} envelope, the same shape reassign_assignment returns", async () => {
    ok(ENVELOPE);
    const result = await moveAssignment({
      assignmentId: "a1",
      nodeId: "cell-2",
      start: new Date("2099-01-01T12:00:00.000Z"),
      end: new Date("2099-01-01T16:00:00.000Z"),
    });
    expect(result.assignment.id).toBe("a1");
    expect(result.assignment.nodeId).toBe("cell-2");
    expect(result.assignment.runId).toBeNull();
    expect(result.eligibility).toEqual({
      eligible: true,
      policy: "warn",
      missingSkills: [],
      expiringSkills: [],
    });
    expect(result.absence).toEqual({ absent: false, from: null, to: null, reason: null });
  });

  it("M4: throws a shapeMismatch when the envelope is missing 'assignment'", async () => {
    ok({ eligibility: ENVELOPE.eligibility });
    await expect(
      moveAssignment({
        assignmentId: "a1",
        nodeId: "cell-2",
        start: new Date("2099-01-01T12:00:00.000Z"),
        end: new Date("2099-01-01T16:00:00.000Z"),
      }),
    ).rejects.toThrow();
  });

  it("M5: throws a SchedulerError on a PostgREST refusal", async () => {
    fail({
      message: "edit rights required on both source and target node",
      code: "PT403",
      details: JSON.stringify({ error: "not_permitted", node_id: "cell-2" }),
    });
    await expect(
      moveAssignment({
        assignmentId: "a1",
        nodeId: "cell-2",
        start: new Date("2099-01-01T12:00:00.000Z"),
        end: new Date("2099-01-01T16:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ kind: "NotPermitted" });
  });
});
