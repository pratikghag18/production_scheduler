/**
 * The one place the raw `BoardWindow` becomes something renderable (brief
 * P1-4a §4.3, extended by P1-4c D45 for density). `boardIndex.ts` is the
 * only file in the board feature that calls `parseTstzRange` or
 * `fromEfficiency` — components downstream read plain numbers.
 *
 * Import note (see the agent report's "assumptions" section): this file
 * necessarily has two real (non-type) runtime dependencies —
 * `parseTstzRange`/`fromEfficiency` from `@/lib/api` (per `docs/api-client.md`'s
 * single-import-path rule and this brief's own §4.3) and `packLanes` /
 * `trackRowHeight` from the sibling `./geometry` module. Both are
 * unavoidable value imports, not type imports, and so do not "vanish"
 * under `--experimental-strip-types` the way `import type` does. The
 * harness copy of this file (never the delivered file) rewrites both
 * import specifiers to relative `.ts` paths so it can still run
 * standalone — see the harness `run.ts` and the agent report.
 */
import type {
  BoardWindow,
  BoardNode,
  Run,
  Assignment,
  BoardOperator,
  Product,
  Skill,
  ShiftTemplate,
  Json,
} from "@/lib/api";
import { parseTstzRange, fromEfficiency } from "@/lib/api";
import { packLanes, trackRowHeight, type Density } from "./geometry";
import { buildCycleTimeIndex, cycleTimeKey, standardTargetQty } from "./standardTarget";

export interface BoardRow {
  node: BoardNode;
  /** Path segment count relative to the root node's own depth (D18). */
  depth: number;
  /** D18: a node is a track row iff its level is schedulable. */
  isTrack: boolean;
  height: number;
  /** 0 for group rows. */
  laneCount: number;
}

export type IndexedRun = Run & { startMin: number; endMin: number };

export type IndexedAssignment = Assignment & {
  startMin: number;
  endMin: number;
  efficiencyPercent: number;
  /** Lane index within the packed lanes of its own node's track (rule 3). */
  lane: number;
  /**
   * R-316: what the cell's standard cycle time says this window is worth, or
   * null when the cell has no cycle time for this product — which is the normal
   * case, since cycle times are optional everywhere.
   *
   * This NEVER overrides `targetQty`. It is what the chip shows when the human
   * typed no target, and it is computed even when they did, so that clearing
   * the field falls straight back to the standard.
   */
  defaultTargetQty: number | null;
};

export interface BoardIndex {
  windowStart: Date;
  windowMinutes: number;
  dayCount: number;
  rows: BoardRow[];
  runsByNode: Map<string, IndexedRun[]>;
  assignmentsByNode: Map<string, IndexedAssignment[]>;
  assignmentsByRun: Map<string, IndexedAssignment[]>;
  assignmentsByOperator: Map<string, IndexedAssignment[]>;
  /** P1-4e §9 debt 1: the same rows as `runsByNode`/`assignmentsByNode`,
   *  keyed by the row's own id instead of by node — for popover-fired
   *  mutations that only ever receive an id (`saveRunFields`,
   *  `deleteRunWithMode`, `saveAssignmentFields`, `removeAssignment`) to
   *  resolve a revert label from. */
  runById: Map<string, IndexedRun>;
  assignmentById: Map<string, IndexedAssignment>;
  templateForNode: Map<string, ShiftTemplate | null>;
  /** R-315: standard seconds-per-unit, keyed by `cycleTimeKey(nodeId, productId)`.
   *  The popovers derive a candidate range's target from this. */
  cycleTimeByKey: Map<string, number>;
  skillsForNode: Map<string, Skill[]>;
  productById: Map<string, Product>;
  operatorById: Map<string, BoardOperator>;
  skillById: Map<string, Skill>;
  nodeById: Map<string, BoardNode>;
  capacityCap: number;
  /** P1-4e D64: `org.settings.eligibility_policy`, defensively read. */
  eligibilityPolicy: "warn" | "block";
  droppedRanges: number;
  /** D45: the density every row in `rows` was laid out at. */
  density: Density;
}

/**
 * `path` split into itself-then-ancestors, nearest first, root last —
 * e.g. `"plant_1.assembly.line_1.cell_1"` ->
 * `["plant_1.assembly.line_1.cell_1", "plant_1.assembly.line_1",
 *   "plant_1.assembly", "plant_1"]`. Walking this array in order is
 * "nearest-ancestor-wins" resolution (rule 4/5) — a node's parent may sit
 * outside the loaded window, but its path always works.
 */
function ancestorPaths(path: string): string[] {
  const segments = path.split(".");
  const out: string[] = [];
  for (let i = segments.length; i >= 1; i--) {
    out.push(segments.slice(0, i).join("."));
  }
  return out;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Rule 6: `capacityCap` reads `org.settings.capacity_cap` defensively; never throws. */
function readCapacityCap(settings: Json): number {
  if (typeof settings === "object" && settings !== null && !Array.isArray(settings)) {
    const v = (settings as Record<string, Json | undefined>).capacity_cap;
    if (isFiniteNumber(v)) return v;
  }
  return 1.0;
}

/** P1-4e: `eligibilityPolicy` reads `org.settings.eligibility_policy`
 *  defensively; never throws — same pattern as `readCapacityCap` above.
 *  D64's override UI needs this client-side to decide whether an
 *  ineligible drop offers an override checkbox (`warn`) or is refused
 *  outright (`block`); design-plan §6's stated default is `warn`. The
 *  server remains the actual authority regardless of what this reads —
 *  `check_eligibility`'s own `policy` field, returned per-call, is what
 *  `create_assignment`/`move_run` actually enforce. */
function readEligibilityPolicy(settings: Json): "warn" | "block" {
  if (typeof settings === "object" && settings !== null && !Array.isArray(settings)) {
    const v = (settings as Record<string, Json | undefined>).eligibility_policy;
    if (v === "warn" || v === "block") return v;
  }
  return "warn";
}

/**
 * The calendar day an instant falls on IN THE BOARD'S OWN FRAME —
 * `"YYYY-MM-DD"`, the same text a Postgres `date` arrives as.
 *
 * ⚠️ THIS IS A SEAM, NOT A CONVENIENCE. `check_eligibility` compares
 * `expires_at < upper(p_timerange)::date`, and that cast happens in the
 * database session's timezone, which is UTC. The board renders in UTC too
 * (`BOARD_ZONE`, `./time.ts`). So the client's day must be the UTC day, and
 * `toISOString().slice(0, 10)` is exactly that — where a local-time
 * `getFullYear()/getMonth()/getDate()` would put every window that ends near
 * midnight on the wrong day for anybody west of Greenwich, and would disagree
 * with the server on precisely the shifts that run to the end of a day.
 */
export function boardDay(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/**
 * One reason a person is not eligible at a cell — and WHICH of the two reasons
 * it is, because they are different problems with different fixes.
 *
 * ⛔ `never-trained` NEEDS A COURSE BOOKED. `lapsed` NEEDS A RENEWAL. Collapsing
 * them into "not eligible" is most of what made the old screen unhelpful: it
 * sent a planner looking for a training slot for somebody who only had to
 * re-sign a ticket, and it said nothing at all about the person whose ticket
 * ran out last month.
 */
export type CertificateGap =
  { skill: Skill; state: "never-trained" } | { skill: Skill; state: "lapsed"; expiresAt: string };

/**
 * F-087 — `check_eligibility`'s verdict, reached on the client, for the window
 * the planner is actually about to write. An EMPTY result means eligible.
 *
 * ⭐ THE SERVER'S RULE, TRANSCRIBED RATHER THAN APPROXIMATED (migration 0009,
 * unchanged since):
 *
 *     missing  = required AND NOT held
 *     expiring = required AND held AND expires_at IS NOT NULL
 *                AND (upper_inf(window) OR expires_at < upper(window)::date)
 *     eligible = no missing AND no expiring
 *
 * Four things about that rule are load-bearing here:
 *
 *  1. `missing` and `expiring` are DISJOINT in the server too — `missing` is a
 *     `NOT EXISTS` against the held rows and `expiring` is a JOIN onto them —
 *     so a training never held is never also reported as lapsed. The `continue`
 *     below is that, not a shortcut.
 *  2. The comparison is STRICT. A certificate that expires ON the window's last
 *     day is still valid; `<=` here would refuse the final legal shift, which
 *     is a screen refusing what the server allows (CLAUDE.md §4).
 *  3. An OPEN-ENDED window counts EVERY dated certificate as lapsed —
 *     `upper_inf`. There is no finite day to compare against, so any real
 *     expiry falls inside it. `windowEnd === null` is that case.
 *  4. Only REQUIRED trainings are judged. A stale ticket for something this
 *     cell never asks for is not this cell's problem, and warning about it
 *     would make every warning worth ignoring.
 *
 * The dates are compared AS TEXT: `expires_at` is a Postgres `date`, so both
 * sides are fixed-width zero-padded `"YYYY-MM-DD"`, for which lexicographic
 * order IS chronological order — and no `Date` is constructed from a
 * timezone-less day, which is the bug `src/lib/format/dates.ts` was written to
 * end.
 *
 * `windowEnd` is the END of the range being created — `addMinutes(windowStart,
 * range.endMin)`, the same instant `submitCreateDirect` puts in the tstzrange's
 * upper bound. It is asked per render, because the drag handles and the shift
 * chips move it while the popover is open.
 */
export function certificateGaps(
  operator: Pick<BoardOperator, "skillIds" | "skillExpiries">,
  requiredSkills: readonly Skill[],
  windowEnd: Date | null,
): CertificateGap[] {
  if (requiredSkills.length === 0) return [];
  const endDay = windowEnd === null ? null : boardDay(windowEnd);
  const gaps: CertificateGap[] = [];
  for (const skill of requiredSkills) {
    if (!operator.skillIds.includes(skill.id)) {
      gaps.push({ skill, state: "never-trained" });
      continue;
    }
    const dated = operator.skillExpiries.find((e) => e.skillId === skill.id);
    // No date on the row: the certificate does not expire. `expires_at IS NOT
    // NULL` is the server's first condition, and 0048 sends only dated rows,
    // so "absent" and "NULL" are the same statement here.
    if (dated === undefined) continue;
    if (endDay === null || dated.expiresAt < endDay) {
      gaps.push({ skill, state: "lapsed", expiresAt: dated.expiresAt });
    }
  }
  return gaps;
}

export function buildBoardIndex(
  data: BoardWindow,
  windowStart: Date,
  windowEnd: Date,
  density: Density,
): BoardIndex {
  const windowMinutes = (windowEnd.getTime() - windowStart.getTime()) / 60_000;
  const dayCount = windowMinutes / 1440;

  const nodeById = new Map<string, BoardNode>();
  for (const n of data.nodes) nodeById.set(n.id, n);

  const levelById = new Map(data.levels.map((l) => [l.id, l] as const));
  const productById = new Map(data.products.map((p) => [p.id, p] as const));
  const operatorById = new Map(data.operators.map((o) => [o.id, o] as const));
  const skillById = new Map(data.skills.map((s) => [s.id, s] as const));
  const templateById = new Map(data.shiftTemplates.map((t) => [t.id, t] as const));

  // Rule 7: unparseable ranges must not white-screen the board. Every
  // `parseTstzRange` call goes through this one wrapper, which drops the
  // offending row (never throws) and counts it.
  let droppedRanges = 0;
  function parseRangeSafe(timerange: string): { startMin: number; endMin: number } | null {
    try {
      const { start, end } = parseTstzRange(timerange);
      return {
        startMin: (start.getTime() - windowStart.getTime()) / 60_000,
        endMin: (end.getTime() - windowStart.getTime()) / 60_000,
      };
    } catch {
      droppedRanges += 1;
      return null;
    }
  }

  // ⭐ NOTHING IS FILTERED HERE ANY MORE (R-323, R-324). Two lines used to sit
  // here dropping rows whose status was 'cancelled' — case 17, the client half
  // of a soft delete. Neither table has a status now: a deleted run and a
  // deleted assignment are both gone from the database, so every row that
  // arrives in the window is live by construction. Keeping a filter would mean
  // keeping a way for the board to hide work that really exists.
  const activeRuns = data.runs;
  const activeAssignments = data.assignments;

  const runsByNode = new Map<string, IndexedRun[]>();
  const runById = new Map<string, IndexedRun>();
  for (const r of activeRuns) {
    const clipped = parseRangeSafe(r.timerange);
    if (clipped === null) continue;
    const ir: IndexedRun = { ...r, startMin: clipped.startMin, endMin: clipped.endMin };
    const list = runsByNode.get(r.nodeId) ?? [];
    list.push(ir);
    runsByNode.set(r.nodeId, list);
    runById.set(ir.id, ir);
  }

  // Rule 4: nearest-ancestor template resolution over ltree paths, never parentId.
  //
  // ⚠️ This block runs BEFORE the assignment loop below, where it used to run
  // after. R-316's derived target needs each cell's resolved shift pattern to
  // know which breaks fall inside an assignment, and the assignment loop is
  // where that is computed. Nothing here reads the assignment maps, so the move
  // is order-only.
  const pathToTemplateId = new Map<string, string>();
  for (const entry of data.nodeShiftMap) {
    if (entry.templateId === null) continue;
    const node = nodeById.get(entry.nodeId);
    if (!node) continue;
    pathToTemplateId.set(node.path, entry.templateId);
  }
  function resolveTemplateForPath(path: string): ShiftTemplate | null {
    for (const p of ancestorPaths(path)) {
      const tid = pathToTemplateId.get(p);
      if (tid) return templateById.get(tid) ?? null;
    }
    return null;
  }
  const templateForNode = new Map<string, ShiftTemplate | null>();
  for (const n of data.nodes) {
    templateForNode.set(n.id, resolveTemplateForPath(n.path));
  }

  // R-315: the standard seconds-per-unit for each (cell, product) in scope.
  // Usually empty — a cycle time is optional everywhere.
  const cycleTimeByKey = buildCycleTimeIndex(data.cycleTimes);

  // Rule 2: an assignment belongs to the row named by `assignment.nodeId`,
  // never by its run's node.
  const rawByNode = new Map<string, Assignment[]>();
  for (const a of activeAssignments) {
    const list = rawByNode.get(a.nodeId) ?? [];
    list.push(a);
    rawByNode.set(a.nodeId, list);
  }

  const assignmentsByNode = new Map<string, IndexedAssignment[]>();
  const assignmentsByRun = new Map<string, IndexedAssignment[]>();
  const assignmentsByOperator = new Map<string, IndexedAssignment[]>();
  const assignmentById = new Map<string, IndexedAssignment>();
  const laneCountByNode = new Map<string, number>();

  for (const [nodeId, list] of rawByNode) {
    const withRanges: (Assignment & { startMin: number; endMin: number })[] = [];
    for (const a of list) {
      const clipped = parseRangeSafe(a.timerange);
      if (clipped === null) continue;
      withRanges.push({ ...a, startMin: clipped.startMin, endMin: clipped.endMin });
    }
    // Rule 3: sort by start then end before packing; packLanes does not sort.
    withRanges.sort((x, y) => x.startMin - y.startMin || x.endMin - y.endMin);
    const { laneOf, laneCount } = packLanes(withRanges);
    laneCountByNode.set(nodeId, laneCount);

    const template = templateForNode.get(nodeId) ?? null;

    const indexed: IndexedAssignment[] = withRanges.map((w) => {
      const efficiencyPercent = fromEfficiency(w.efficiency);
      // R-316: a run-attached chip carries no product of its own (D5 — exactly
      // one of run_id and product_id), so its part is the run's.
      const productId = w.productId ?? (w.runId ? (runById.get(w.runId)?.productId ?? null) : null);
      // The derived default is computed for EVERY row, including one that
      // already carries an explicit target. `targetQty` still wins wherever it
      // is displayed; keeping both means clearing the field falls straight back
      // to the standard without a refetch.
      const defaultTargetQty =
        productId === null
          ? null
          : standardTargetQty({
              range: { startMin: w.startMin, endMin: w.endMin },
              template,
              efficiencyPercent,
              secondsPerUnit: cycleTimeByKey.get(cycleTimeKey(nodeId, productId)),
            });
      return {
        ...w,
        efficiencyPercent,
        lane: laneOf.get(w) ?? 0,
        defaultTargetQty,
      };
    });
    assignmentsByNode.set(nodeId, indexed);

    for (const ia of indexed) {
      assignmentById.set(ia.id, ia);
      if (ia.runId) {
        const rl = assignmentsByRun.get(ia.runId) ?? [];
        rl.push(ia);
        assignmentsByRun.set(ia.runId, rl);
      }
      // D110: a row whose person has been deleted has no operator to index by.
      // It is still drawn — `operatorViewFor` names them from the snapshot —
      // but it belongs in nobody's roster, and an `""` key would collect every
      // departed person into one imaginary operator.
      if (ia.operatorId !== null) {
        const ol = assignmentsByOperator.get(ia.operatorId) ?? [];
        ol.push(ia);
        assignmentsByOperator.set(ia.operatorId, ol);
      }
    }
  }

  // Rule 5: skillsForNode unions ancestor-attached requirements, deduped, ordered by name.
  const reqSkillIdsByPath = new Map<string, Set<string>>();
  for (const req of data.nodeSkillRequirements) {
    const node = nodeById.get(req.nodeId);
    if (!node) continue;
    const set = reqSkillIdsByPath.get(node.path) ?? new Set<string>();
    set.add(req.skillId);
    reqSkillIdsByPath.set(node.path, set);
  }
  const skillsForNode = new Map<string, Skill[]>();
  for (const n of data.nodes) {
    const seen = new Map<string, Skill>();
    for (const p of ancestorPaths(n.path)) {
      const set = reqSkillIdsByPath.get(p);
      if (!set) continue;
      for (const skillId of set) {
        if (seen.has(skillId)) continue;
        const skill = skillById.get(skillId);
        if (skill) seen.set(skillId, skill);
      }
    }
    skillsForNode.set(
      n.id,
      [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)),
    );
  }

  // Rule 1: rows, in full tree order, before collapse filtering. D18: a
  // node is a track row iff its level is schedulable; a node whose
  // level id is missing from `levels` is treated as a group row (T8).
  // D44/D45: row heights are computed here, at exactly this one place, from
  // the `density` argument — never from a module-level constant.
  const rootDepthSegments =
    data.nodes.length > 0 ? Math.min(...data.nodes.map((n) => n.path.split(".").length)) : 0;
  const rows: BoardRow[] = data.nodes.map((n) => {
    const level = levelById.get(n.levelId);
    const isTrack = level ? level.isSchedulable : false;
    const depth = n.path.split(".").length - rootDepthSegments;
    if (isTrack) {
      const laneCount = laneCountByNode.get(n.id) ?? 0;
      return {
        node: n,
        depth,
        isTrack: true,
        height: trackRowHeight(laneCount, density),
        laneCount,
      };
    }
    return { node: n, depth, isTrack: false, height: density.groupRowHeight, laneCount: 0 };
  });

  return {
    windowStart,
    windowMinutes,
    dayCount,
    rows,
    runsByNode,
    assignmentsByNode,
    assignmentsByRun,
    assignmentsByOperator,
    runById,
    assignmentById,
    templateForNode,
    cycleTimeByKey,
    skillsForNode,
    productById,
    operatorById,
    skillById,
    nodeById,
    capacityCap: readCapacityCap(data.org.settings),
    eligibilityPolicy: readEligibilityPolicy(data.org.settings),
    droppedRanges,
    density,
  };
}
