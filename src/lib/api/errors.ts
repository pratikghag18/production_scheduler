/**
 * The error contract (brief P1-3b §4).
 *
 * P1-3a raises typed failures with a machine code embedded in the
 * PostgREST error's `details` field, as JSON-encoded text (docs/api.md
 * §1): `{"error": "capacity_exceeded", "operator_id": "...", ...}`.
 *
 * `toSchedulerError` is the ONLY place in this codebase that touches that
 * raw shape. Every other file — hooks, components, mutations.ts, board.ts —
 * works with the `SchedulerError` union below and never re-parses a raw
 * PostgREST/Postgres error itself.
 *
 * docs/api.md §0: the SQLSTATE -> HTTP status mapping is unverified (no
 * PostgREST in the build container). The contract therefore never switches
 * on an HTTP status; it switches on the `error` field of the parsed
 * `DETAIL` JSON, which is the one thing every test in
 * supabase/tests/60_api_test.sql actually asserts on. A `status` field is
 * consulted only as a defensive secondary signal for the 401 case (see
 * below), never as the primary discriminant.
 */

/** A skill reference as it appears inside an error payload. */
export interface SkillRef {
  id: string;
  name: string;
}

/** A skill reference with its expiry, as returned for `expiring_skills`. */
export interface ExpiringSkillRef extends SkillRef {
  expiresAt: string;
}

/** The closed set of machine error codes P1-3a can raise (docs/api.md §1). */
export type SchedulerErrorCode =
  | "capacity_exceeded"
  | "not_eligible"
  | "run_overlap"
  | "run_node_mismatch"
  | "not_permitted"
  | "invalid_argument";

export type SchedulerError =
  | {
      kind: "CapacityExceeded";
      operatorId: string;
      peak: number;
      cap: number;
      timerange: string;
    }
  | {
      kind: "NotEligible";
      operatorId: string;
      nodeId: string;
      missingSkills: SkillRef[];
      expiringSkills: ExpiringSkillRef[];
      policy: "warn" | "block";
    }
  | {
      kind: "RunOverlap";
      nodeId: string;
      timerange: string;
      conflictingRunId: string;
    }
  | {
      kind: "RunNodeMismatch";
      assignmentNodeId: string;
      runNodeId: string;
      runId: string;
    }
  | {
      kind: "NotPermitted";
      nodeId: string;
    }
  | {
      kind: "InvalidArgument";
      field: string;
      reason: string;
    }
  /**
   * The bare `23P01` exclusion-constraint violation on `runs`
   * (docs/api.md §1: "you lost the race"). Not routed through `api_raise`
   * — a trigger cannot intercept an exclusion-constraint violation before
   * it fires — so it never carries a parsed DETAIL payload. The client
   * should refetch and retry once (see useMoveRun).
   */
  | { kind: "RaceLost" }
  /** PostgREST 401 / Postgres permission-denied (SQLSTATE 42501) on a function. */
  | { kind: "Unauthenticated" }
  /** Everything else. Carries the original error verbatim. */
  | { kind: "Unknown"; raw: unknown };

const SCHEDULER_ERROR_KINDS: ReadonlySet<SchedulerError["kind"]> = new Set([
  "CapacityExceeded",
  "NotEligible",
  "RunOverlap",
  "RunNodeMismatch",
  "NotPermitted",
  "InvalidArgument",
  "RaceLost",
  "Unauthenticated",
  "Unknown",
]);

function hasStringProp<K extends string>(
  obj: Record<string, unknown>,
  key: K,
): obj is Record<K, string> & Record<string, unknown> {
  return typeof obj[key] === "string";
}

function hasNumberProp<K extends string>(
  obj: Record<string, unknown>,
  key: K,
): obj is Record<K, number> & Record<string, unknown> {
  return typeof obj[key] === "number";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isSkillRefArray(v: unknown): v is SkillRef[] {
  if (!Array.isArray(v)) return false;
  return v.every(
    (item) => isPlainObject(item) && hasStringProp(item, "id") && hasStringProp(item, "name"),
  );
}

function isExpiringSkillRefArray(v: unknown): v is ExpiringSkillRef[] {
  if (!Array.isArray(v)) return false;
  return v.every(
    (item) =>
      isPlainObject(item) &&
      hasStringProp(item, "id") &&
      hasStringProp(item, "name") &&
      // expires_at is a Postgres `date`; JSON-encodes as a plain string.
      typeof item.expires_at === "string",
  );
}

function toExpiringSkillRefs(v: unknown): ExpiringSkillRef[] {
  return (v as Array<{ id: string; name: string; expires_at: string }>).map((s) => ({
    id: s.id,
    name: s.name,
    expiresAt: s.expires_at,
  }));
}

/**
 * Parses one raised error's `DETAIL` JSON (already JSON.parse'd) into the
 * matching SchedulerError, or returns `undefined` if the shape does not
 * match what that `error` code is documented to carry (docs/api.md §1).
 * An unrecognised `error` value, or a recognised one with a malformed
 * payload, both fall through to the caller's Unknown branch.
 */
function parseDetail(detail: Record<string, unknown>): SchedulerError | undefined {
  const code = detail.error;
  if (typeof code !== "string") return undefined;

  switch (code) {
    case "capacity_exceeded": {
      if (
        hasStringProp(detail, "operator_id") &&
        hasNumberProp(detail, "peak") &&
        hasNumberProp(detail, "cap") &&
        hasStringProp(detail, "timerange")
      ) {
        return {
          kind: "CapacityExceeded",
          operatorId: detail.operator_id,
          peak: detail.peak,
          cap: detail.cap,
          timerange: detail.timerange,
        };
      }
      return undefined;
    }
    case "not_eligible": {
      if (
        hasStringProp(detail, "operator_id") &&
        hasStringProp(detail, "node_id") &&
        isSkillRefArray(detail.missing_skills) &&
        isExpiringSkillRefArray(detail.expiring_skills) &&
        (detail.policy === "warn" || detail.policy === "block")
      ) {
        return {
          kind: "NotEligible",
          operatorId: detail.operator_id,
          nodeId: detail.node_id,
          missingSkills: detail.missing_skills,
          expiringSkills: toExpiringSkillRefs(detail.expiring_skills),
          policy: detail.policy,
        };
      }
      return undefined;
    }
    case "run_overlap": {
      if (
        hasStringProp(detail, "node_id") &&
        hasStringProp(detail, "timerange") &&
        hasStringProp(detail, "conflicting_run_id")
      ) {
        return {
          kind: "RunOverlap",
          nodeId: detail.node_id,
          timerange: detail.timerange,
          conflictingRunId: detail.conflicting_run_id,
        };
      }
      return undefined;
    }
    case "run_node_mismatch": {
      if (
        hasStringProp(detail, "assignment_node_id") &&
        hasStringProp(detail, "run_node_id") &&
        hasStringProp(detail, "run_id")
      ) {
        return {
          kind: "RunNodeMismatch",
          assignmentNodeId: detail.assignment_node_id,
          runNodeId: detail.run_node_id,
          runId: detail.run_id,
        };
      }
      return undefined;
    }
    case "not_permitted": {
      if (hasStringProp(detail, "node_id")) {
        return { kind: "NotPermitted", nodeId: detail.node_id };
      }
      return undefined;
    }
    case "invalid_argument": {
      if (hasStringProp(detail, "field") && hasStringProp(detail, "reason")) {
        return { kind: "InvalidArgument", field: detail.field, reason: detail.reason };
      }
      return undefined;
    }
    default:
      // Unrecognised `error` value in an otherwise well-formed DETAIL —
      // falls through to Unknown in the caller.
      return undefined;
  }
}

/**
 * The one function allowed to touch a raw PostgREST/Postgres error shape.
 *
 * Must survive, without throwing, every one of: `details` absent; `details`
 * present but not JSON; `details` valid JSON with an unrecognised `error`
 * value; a plain `Error`; a network failure with no `code`; `null` /
 * `undefined`; an arbitrary non-object value. Every one of those falls
 * through to `Unknown` with the original error preserved verbatim.
 *
 * Walking every branch below: the entry checks (null/undefined, non-object)
 * cannot throw — they are typeof/property checks only. The `23P01` and
 * `42501`/401 checks read one optional string/number property each via
 * plain member access, which cannot throw on an arbitrary object.
 * `JSON.parse` is the only call in this function that can throw, and it is
 * wrapped in its own try/catch with the failure mapped straight to
 * `undefined` (handled explicitly, not left to the outer catch). Every
 * `parseDetail` branch only reads properties and compares primitives — no
 * throwing operations. The outer try/catch is a second, redundant backstop
 * so that even a future edit that adds a throwing branch by mistake still
 * cannot turn a handled failure into a crash.
 */
export function toSchedulerError(err: unknown): SchedulerError {
  try {
    if (err === null || err === undefined) {
      return { kind: "Unknown", raw: err };
    }
    if (!isPlainObject(err)) {
      return { kind: "Unknown", raw: err };
    }

    const code = typeof err.code === "string" ? err.code : undefined;

    // The exclusion-constraint race loss (docs/api.md §1) — never routed
    // through api_raise, so it carries no parsed DETAIL. Checked first so
    // a coincidental JSON `details` string on some other 23P01-coded error
    // can never mask it.
    if (code === "23P01") {
      return { kind: "RaceLost" };
    }

    // Permission denied: Postgres SQLSTATE 42501 (insufficient_privilege)
    // is the reliable signal, since the SQLSTATE -> HTTP mapping itself is
    // unverified (docs/api.md §0). A `status: 401` property is honoured
    // too, defensively, in case a caller ever passes the full PostgREST
    // response (which does carry `status`) instead of just its `error`.
    const status = typeof err.status === "number" ? err.status : undefined;
    if (code === "42501" || status === 401) {
      return { kind: "Unauthenticated" };
    }

    const details = err.details;
    if (typeof details === "string" && details.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(details);
      } catch {
        parsed = undefined;
      }
      if (isPlainObject(parsed)) {
        const matched = parseDetail(parsed);
        if (matched) return matched;
      }
    }

    return { kind: "Unknown", raw: err };
  } catch {
    // Belt-and-suspenders per the file header: this function must never
    // throw, no matter what future edit might slip past the branches above.
    return { kind: "Unknown", raw: err };
  }
}

export function isSchedulerError(e: unknown): e is SchedulerError {
  return (
    typeof e === "object" &&
    e !== null &&
    "kind" in e &&
    typeof (e as { kind: unknown }).kind === "string" &&
    SCHEDULER_ERROR_KINDS.has((e as { kind: SchedulerError["kind"] }).kind)
  );
}

/**
 * A shape-mismatch failure: the RPC succeeded (no PostgREST error) but its
 * payload didn't match the documented shape in docs/api.md. Brief §5: "if
 * the guard fails, throw an Unknown SchedulerError naming the RPC and what
 * was missing — a shape mismatch is a real bug and must be loud, never
 * silently coerced." Distinct from `toSchedulerError`: there is no raw
 * PostgREST error to parse here, so this constructs a synthetic one.
 */
export function shapeMismatch(rpc: string, detail: string): SchedulerError {
  return {
    kind: "Unknown",
    raw: new Error(`${rpc}: response did not match the expected shape — ${detail}`),
  };
}

/**
 * A supervisor-readable sentence for a SchedulerError, so UI code never
 * assembles error prose itself (brief §4).
 *
 * NOTE / assumption: the brief's example phrasing is "Maria would reach
 * 150% of capacity (limit 100%)" — using the operator's name. The DB
 * contract (docs/api.md §1) only puts `operator_id` (a uuid) on the
 * capacity_exceeded/not_eligible payloads, never a display name, and
 * SchedulerError follows that literally (brief §4's field list). This
 * module has no access to the operators list to resolve a name, so the
 * id is used verbatim; a caller that has the board's operator list loaded
 * can build a nicer sentence itself from the typed fields instead of
 * calling this function, if it wants the name.
 */
export function describeSchedulerError(e: SchedulerError): string {
  switch (e.kind) {
    case "CapacityExceeded": {
      const peakPct = Math.round(e.peak * 100);
      const capPct = Math.round(e.cap * 100);
      return `Operator ${e.operatorId} would reach ${peakPct}% of capacity (limit ${capPct}%).`;
    }
    case "NotEligible": {
      const missing = e.missingSkills.map((s) => s.name);
      const expiring = e.expiringSkills.map((s) => s.name);
      const parts: string[] = [];
      if (missing.length > 0) parts.push(`missing ${missing.join(", ")}`);
      if (expiring.length > 0)
        parts.push(`${expiring.join(", ")} expiring before the end of this window`);
      const reason = parts.length > 0 ? ` (${parts.join("; ")})` : "";
      return e.policy === "block"
        ? `Operator ${e.operatorId} is not eligible for this cell${reason}.`
        : `Operator ${e.operatorId} is not eligible for this cell${reason} — override required.`;
    }
    case "RunOverlap":
      return "That window overlaps another active run on this cell.";
    case "RunNodeMismatch":
      return "This assignment's cell no longer matches its run's cell.";
    case "NotPermitted":
      return "You do not have edit rights on this cell.";
    case "InvalidArgument":
      return `Invalid ${e.field}: ${e.reason}.`;
    case "RaceLost":
      return "Someone else changed this run first — refetching and retrying.";
    case "Unauthenticated":
      return "You need to sign in to do that.";
    case "Unknown":
    default:
      return "Something went wrong. Please try again.";
  }
}
