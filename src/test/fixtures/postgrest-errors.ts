/**
 * Realistic PostgREST/Postgres error shapes for errors.test.ts (brief §8).
 * supabase-js surfaces a PostgREST error as `{ message, details, hint,
 * code }`, where `details` is the raised exception's DETAIL — the
 * `api_raise`-produced JSON (docs/api.md §1) — as a STRING. All six machine
 * codes, plus the seven edge cases the parser must survive without
 * throwing: missing `details`, non-JSON `details`, an unrecognised `error`
 * value, a bare `23P01`, a 401 (permission-denied), a plain `Error`, and
 * `null`.
 *
 * SQLSTATEs below follow migration 0009's `api_raise` CASE mapping exactly:
 * PT400 for invalid_argument, PT403 for not_permitted, PT409 for
 * everything else (capacity_exceeded, not_eligible, run_overlap,
 * run_node_mismatch).
 */

export const capacityExceeded = {
  message:
    "capacity exceeded: operator 50000000-0000-0000-0000-000000000003 would reach 1.5 (cap 1)",
  details: JSON.stringify({
    error: "capacity_exceeded",
    operator_id: "50000000-0000-0000-0000-000000000003",
    peak: 1.5,
    cap: 1.0,
    timerange: '["2026-08-18 08:00:00+00","2026-08-18 12:00:00+00")',
  }),
  hint: null,
  code: "PT409",
};

export const notEligible = {
  message: "operator is not eligible for this node/window; override required under warn policy",
  details: JSON.stringify({
    error: "not_eligible",
    operator_id: "50000000-0000-0000-0000-000000000004",
    node_id: "30000000-0000-0000-0000-000000000006",
    missing_skills: [{ id: "40000000-0000-0000-0000-000000000001", name: "CNC" }],
    expiring_skills: [],
    policy: "warn",
  }),
  hint: null,
  code: "PT409",
};

export const notEligibleExpiring = {
  message: "operator is not eligible for this node/window; override required under warn policy",
  details: JSON.stringify({
    error: "not_eligible",
    operator_id: "50000000-0000-0000-0000-000000000004",
    node_id: "30000000-0000-0000-0000-000000000006",
    missing_skills: [],
    expiring_skills: [
      { id: "40000000-0000-0000-0000-000000000001", name: "CNC", expires_at: "2099-06-15" },
    ],
    policy: "warn",
  }),
  hint: null,
  code: "PT409",
};

export const runOverlap = {
  message: "an active run already overlaps this node/window",
  details: JSON.stringify({
    error: "run_overlap",
    node_id: "30000000-0000-0000-0000-000000000007",
    timerange: '["2026-08-18 06:00:00+00","2026-08-18 14:00:00+00")',
    conflicting_run_id: "80000000-0000-0000-0000-000000000001",
  }),
  hint: null,
  code: "PT409",
};

export const runNodeMismatch = {
  message: "assignment node_id does not match run node_id",
  details: JSON.stringify({
    error: "run_node_mismatch",
    assignment_node_id: "30000000-0000-0000-0000-000000000007",
    run_node_id: "30000000-0000-0000-0000-000000000008",
    run_id: "80000000-0000-0000-0000-000000000001",
  }),
  hint: null,
  code: "PT409",
};

export const notPermitted = {
  message: "no edit rights on node",
  details: JSON.stringify({
    error: "not_permitted",
    node_id: "30000000-0000-0000-0000-000000000002",
  }),
  hint: null,
  code: "PT403",
};

export const invalidArgument = {
  message: "p_timerange must be a non-empty range",
  details: JSON.stringify({
    error: "invalid_argument",
    field: "p_timerange",
    reason: "null or empty",
  }),
  hint: null,
  code: "PT400",
};

/** `details` absent entirely (e.g. a non-api_raise Postgres error). */
export const missingDetails = {
  message: 'relation "widgets" does not exist',
  hint: null,
  code: "42P01",
};

/** `details` present but not JSON (a plain-text Postgres DETAIL). */
export const nonJsonDetails = {
  message: 'update or delete on table "runs" violates foreign key constraint',
  details:
    'Key (id)=(80000000-0000-0000-0000-000000000001) is still referenced from table "assignments".',
  hint: null,
  code: "23503",
};

/** Valid JSON `details`, but an `error` value outside the closed set. */
export const unrecognisedErrorValue = {
  message: "something new the client doesn't know about yet",
  details: JSON.stringify({ error: "something_new", foo: "bar" }),
  hint: null,
  code: "PT409",
};

/** The bare exclusion-constraint violation on `runs` (docs/api.md §1) — never routed through api_raise. */
export const bareExclusionViolation = {
  message: 'conflicting key value violates exclusion constraint "runs_no_overlap_on_node"',
  details:
    'Key (node_id, timerange)=(30000000-0000-0000-0000-000000000007, ["2026-08-18 06:00:00+00","2026-08-18 14:00:00+00")) conflicts with existing key.',
  hint: null,
  code: "23P01",
};

/** Permission denied on a revoked function (docs/api.md: anon has EXECUTE revoked). */
export const permissionDenied401 = {
  message: "permission denied for function board_window",
  details: "",
  hint: null,
  code: "42501",
};

export const plainError = new Error("network request failed");

export const nullError = null;
