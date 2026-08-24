/**
 * The one place the raw `BoardWindow` becomes something renderable (brief
 * P1-4a §4.3). `boardIndex.ts` is the only file in the board feature that
 * calls `parseTstzRange` or `fromEfficiency` — components downstream read
 * plain numbers.
 *
 * Import note (see the agent report's "assumptions" section): this file
 * necessarily has two real (non-type) runtime dependencies —
 * `parseTstzRange`/`fromEfficiency` from `@/lib/api` (per `docs/api-client.md`'s
 * single-import-path rule and this brief's own §4.3) and `packLanes` /
 * `trackRowHeight` / `GROUP_ROW_HEIGHT` from the sibling `./geometry`
 * module. Both are unavoidable value imports, not type imports, and so do
 * not "vanish" under `--experimental-strip-types` the way `import type`
 * does. The harness copy of this file (never the delivered file) rewrites
 * both import specifiers to relative `.ts` paths so it can still run
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
import { packLanes, trackRowHeight, GROUP_ROW_HEIGHT } from "./geometry";

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
  templateForNode: Map<string, ShiftTemplate | null>;
  skillsForNode: Map<string, Skill[]>;
  productById: Map<string, Product>;
  operatorById: Map<string, BoardOperator>;
  skillById: Map<string, Skill>;
  nodeById: Map<string, BoardNode>;
  capacityCap: number;
  droppedRanges: number;
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

export function buildBoardIndex(data: BoardWindow, windowStart: Date, windowEnd: Date): BoardIndex {
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

  // Cancelled rows are dropped from every map (rule/case 17).
  const activeRuns = data.runs.filter((r) => r.status !== "cancelled");
  const activeAssignments = data.assignments.filter((a) => a.status !== "cancelled");

  const runsByNode = new Map<string, IndexedRun[]>();
  for (const r of activeRuns) {
    const clipped = parseRangeSafe(r.timerange);
    if (clipped === null) continue;
    const ir: IndexedRun = { ...r, startMin: clipped.startMin, endMin: clipped.endMin };
    const list = runsByNode.get(r.nodeId) ?? [];
    list.push(ir);
    runsByNode.set(r.nodeId, list);
  }

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

    const indexed: IndexedAssignment[] = withRanges.map((w) => ({
      ...w,
      efficiencyPercent: fromEfficiency(w.efficiency),
      lane: laneOf.get(w) ?? 0,
    }));
    assignmentsByNode.set(nodeId, indexed);

    for (const ia of indexed) {
      if (ia.runId) {
        const rl = assignmentsByRun.get(ia.runId) ?? [];
        rl.push(ia);
        assignmentsByRun.set(ia.runId, rl);
      }
      const ol = assignmentsByOperator.get(ia.operatorId) ?? [];
      ol.push(ia);
      assignmentsByOperator.set(ia.operatorId, ol);
    }
  }

  // Rule 4: nearest-ancestor template resolution over ltree paths, never parentId.
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
  const rootDepthSegments =
    data.nodes.length > 0 ? Math.min(...data.nodes.map((n) => n.path.split(".").length)) : 0;
  const rows: BoardRow[] = data.nodes.map((n) => {
    const level = levelById.get(n.levelId);
    const isTrack = level ? level.isSchedulable : false;
    const depth = n.path.split(".").length - rootDepthSegments;
    if (isTrack) {
      const laneCount = laneCountByNode.get(n.id) ?? 0;
      return { node: n, depth, isTrack: true, height: trackRowHeight(laneCount), laneCount };
    }
    return { node: n, depth, isTrack: false, height: GROUP_ROW_HEIGHT, laneCount: 0 };
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
    templateForNode,
    skillsForNode,
    productById,
    operatorById,
    skillById,
    nodeById,
    capacityCap: readCapacityCap(data.org.settings),
    droppedRanges,
  };
}
