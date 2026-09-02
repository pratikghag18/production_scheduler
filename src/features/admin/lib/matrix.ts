/**
 * matrix.ts — the pure core of the Operator Training Matrix.
 *
 * Dependency-free by design: no React, no `supabase`, no snake_case. Everything
 * load-bearing about the matrix that can be decided from plain values lives
 * here, the same contract `scope.ts` and `operators.ts` keep, so it is
 * unit-testable under vitest with no browser and no network.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT PRODUCES, from the records `fetchOperatorsAdmin` already returns:
 *   1. `cellStateFor` — one cell's state (trained / expiring / expired /
 *      missing / na) from a holding and its expiry against a "today".
 *   2. `buildColumns` — the NESTED hierarchy header: each training's owner
 *      walked up to the common root, grouped into header bands with the right
 *      colspans and rowspans, and a node's OWN trainings bucketed as
 *      "<node> · <level>-wide" beside its child nodes.
 *   3. `buildMatrix` — the whole model for a scope: the visible operators
 *      (rows, grouped into teams), the visible trainings (columns + header),
 *      and a `cellState(opId, skillId)` lookup.
 *
 * ---------------------------------------------------------------------------
 * ⭐ THE ONE RULE (§19.72, the read regression): anything the grid SHOWS as a
 * tick, the server must ALLOW. Applicability is `isAtOrBelow` on ltree paths —
 * the SAME test the server runs — never a hand-walked parent chain and never a
 * `startsWith`. A training applies to a person when the training's owner is an
 * ancestor-or-self of the person's node; that is exactly when the person is at
 * or below the owner. Reaching for the opposite direction would tick cells the
 * database refuses.
 *
 * ⚠️ Ancestry for the DISPLAY tree (labels, levels, ordering) is walked through
 * `parentId` with a cycle guard, because that is where the node OBJECTS live —
 * `operators.ts` already carries that guard for the same reason. Ancestry for
 * the RULE (who sees/holds what) is always the path test. Two different jobs,
 * deliberately kept apart.
 */

import type { BoardNode, HierarchyLevel } from "@/lib/api/shapes";
import type { OperatorRecord, OperatorSkillRecord, SkillRecord } from "@/lib/api/operators";
import { isAtOrBelow } from "./scope";

/* ===========================================================================
 * 1. CELL STATE.
 * ======================================================================== */

export type CellState = "trained" | "expiring" | "expired" | "missing" | "na";

/** Add `days` to a `YYYY-MM-DD` string, returning `YYYY-MM-DD`. UTC so a DST
 *  boundary can never shift the date. */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * The state of one operator×training cell.
 *
 * @param holding    the `operator_skills` row, or `undefined` if none exists.
 * @param applies    does this training apply to this person (owner ancestor-or-self)?
 * @param today      `YYYY-MM-DD`.
 * @param windowDays how many days ahead counts as "expiring soon".
 *
 * ⚠️ The states, in order — the order is the whole point of the split the
 * maintainer asked for: `×` (missing) and `↻` (expired) are DIFFERENT states,
 * because "never trained" and "was trained, now lapsed" are different problems.
 *   not applicable      -> "na"       (owner not on this person's branch)
 *   no holding          -> "missing"  (the gap: never trained)
 *   no expiry date      -> "trained"  (held, never expires)
 *   expires_at < today  -> "expired"  (held, lapsed — needs renewal)
 *   within the window   -> "expiring" (held, renewal coming due)
 *   otherwise           -> "trained"
 *
 * ⚠️ "Held" is EXISTENCE of the row, not `certified_at`: `operator_skills` has
 * no boolean, and a row with a null `certified_at` is still a holding. Expiry
 * strictly BEFORE today is expired; expiring on today is treated as expiring
 * (its last valid day), which is the reading a supervisor expects.
 */
export function cellStateFor(
  holding: Pick<OperatorSkillRecord, "expiresAt"> | undefined,
  applies: boolean,
  today: string,
  windowDays: number,
): CellState {
  if (!applies) return "na";
  if (holding === undefined) return "missing";
  const exp = holding.expiresAt;
  if (exp === null) return "trained";
  if (exp < today) return "expired";
  if (exp <= addDays(today, windowDays)) return "expiring";
  return "trained";
}

/**
 * Does a training owned at `ownerPath` apply to a person whose node is
 * `operatorPath`? True when the person is at or below the owner — i.e. the
 * owner is an ancestor-or-self of the person. THE path test, never `startsWith`.
 */
export function trainingApplies(ownerPath: string, operatorPath: string): boolean {
  return isAtOrBelow(operatorPath, ownerPath);
}

/** Comparable in EITHER direction — used to decide whether a training is in
 *  scope: a scope node's own trainings, its ancestors' (which apply to everyone
 *  under it), and its descendants' all belong on the grid. */
function comparable(aPath: string, bPath: string): boolean {
  return isAtOrBelow(aPath, bPath) || isAtOrBelow(bPath, aPath);
}

/* ===========================================================================
 * 2. THE NESTED HEADER.
 * ======================================================================== */

/** A cell in the grouped header (a hierarchy node, or a "…-wide" own-bucket). */
export interface HeaderCell {
  label: string;
  colspan: number;
  rowspan: number;
}

export interface MatrixColumns {
  /** The trainings in left-to-right column order. */
  cols: SkillRecord[];
  /** Header rows, top band first. The training-name row is rendered separately. */
  bands: HeaderCell[][];
  /** Number of group bands (not counting the training-name row). */
  maxBands: number;
}

/** Walk `parentId` from a node up to its root, returning ids self-first. Cycle
 *  guarded (a malformed chain stops rather than looping — `operators.ts`'s
 *  `rootIdFor` carries the same guard). */
function chainOf(nodeId: string, byId: ReadonlyMap<string, BoardNode>): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = nodeId;
  while (cur !== null && byId.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    chain.push(cur);
    cur = byId.get(cur)!.parentId;
  }
  return chain;
}

/** Deepest node common to every chain — the top of the header tree. */
function lowestCommonAncestor(
  ownerIds: readonly string[],
  byId: ReadonlyMap<string, BoardNode>,
): string {
  if (ownerIds.length === 0) return "";
  let common = chainOf(ownerIds[0], byId);
  for (let i = 1; i < ownerIds.length; i++) {
    const set = new Set(chainOf(ownerIds[i], byId));
    common = common.filter((id) => set.has(id));
  }
  return common[0] ?? ownerIds[0];
}

/** The "…-wide" word for a node's own trainings, from its level name. */
function wideWord(node: BoardNode, levelsById: ReadonlyMap<string, HierarchyLevel>): string {
  const level = levelsById.get(node.levelId);
  const word = level ? level.name.trim().toLowerCase() : "";
  return word.length > 0 ? `${word}-wide` : "direct";
}

/**
 * Build the nested column header for a set of trainings.
 *
 * The header climbs from the common root down to each training's owner. A node
 * that has BOTH its own trainings AND child nodes with trainings shows its own
 * ones under a "<node> · <level>-wide" bucket sitting beside its children, so a
 * plant-wide training lands under "Plant A · plant-wide" while a line's training
 * lands under "Line 1" — both under the same "Plant A" / "Area 1" ancestors.
 *
 * Columns are ordered depth-first by node `sortOrder`, with a node's own
 * trainings before its child nodes (so "area-wide" reads left of the lines).
 */
export function buildColumns(
  trainings: readonly SkillRecord[],
  byId: ReadonlyMap<string, BoardNode>,
  levelsById: ReadonlyMap<string, HierarchyLevel>,
): MatrixColumns {
  if (trainings.length === 0) return { cols: [], bands: [], maxBands: 0 };

  const root = lowestCommonAncestor(
    trainings.map((t) => t.siteNodeId),
    byId,
  );

  // Node ids from the root down to the owner, inclusive.
  const pathFromRoot = (ownerId: string): string[] => {
    const chain = chainOf(ownerId, byId); // owner..root
    const cut = chain.indexOf(root);
    const seg = cut >= 0 ? chain.slice(0, cut + 1) : chain;
    return seg.reverse(); // root..owner
  };

  // A node is "internal" if it is a non-terminal ancestor on some path — i.e.
  // it has descendants that own trainings, so its own trainings need a bucket.
  const internal = new Set<string>();
  for (const t of trainings) {
    const p = pathFromRoot(t.siteNodeId);
    for (let i = 0; i < p.length - 1; i++) internal.add(p[i]);
  }

  const orderOf = (id: string): number => byId.get(id)?.sortOrder ?? 0;
  const nameOf = (id: string): string => byId.get(id)?.name ?? "(unknown)";

  interface Ann {
    t: SkillRecord;
    p: string[]; // node ids, root..owner
    bp: { key: string; label: string }[]; // header bands top..bottom
  }

  const ann: Ann[] = trainings.map((t) => {
    const p = pathFromRoot(t.siteNodeId);
    const bp: { key: string; label: string }[] = [];
    for (let i = 0; i < p.length - 1; i++) {
      bp.push({ key: p.slice(0, i + 1).join(">"), label: nameOf(p[i]) });
    }
    const ownerId = t.siteNodeId;
    const owner = byId.get(ownerId);
    const full = p.join(">");
    bp.push({ key: full, label: owner ? owner.name : "(unknown)" });
    if (internal.has(ownerId) && owner) {
      bp.push({ key: `${full}:own`, label: `${owner.name} · ${wideWord(owner, levelsById)}` });
    }
    return { t, p, bp };
  });

  // Depth-first order by sortOrder; own-trainings (shorter path) before deeper
  // children; then by training name for a stable order within one owner.
  ann.sort((a, b) => {
    const n = Math.min(a.p.length, b.p.length);
    for (let i = 0; i < n; i++) {
      if (a.p[i] !== b.p[i]) return orderOf(a.p[i]) - orderOf(b.p[i]);
    }
    if (a.p.length !== b.p.length) return a.p.length - b.p.length;
    return a.t.name.localeCompare(b.t.name);
  });

  const cols = ann.map((a) => a.t);
  const maxBands = Math.max(1, ...ann.map((a) => a.bp.length));

  const bands: HeaderCell[][] = [];
  for (let b = 0; b < maxBands; b++) {
    const row: HeaderCell[] = [];
    let i = 0;
    while (i < ann.length) {
      if (ann[i].bp.length <= b) {
        i++;
        continue; // covered by a rowspan from a shallower band
      }
      const prefix = ann[i].bp
        .slice(0, b + 1)
        .map((x) => x.key)
        .join("||");
      let j = i;
      while (
        j < ann.length &&
        ann[j].bp.length > b &&
        ann[j].bp
          .slice(0, b + 1)
          .map((x) => x.key)
          .join("||") === prefix
      ) {
        j++;
      }
      const allTerminal = ann.slice(i, j).every((a) => a.bp.length === b + 1);
      row.push({ label: ann[i].bp[b].label, colspan: j - i, rowspan: allTerminal ? maxBands - b : 1 });
      i = j;
    }
    bands.push(row);
  }

  return { cols, bands, maxBands };
}

/* ===========================================================================
 * 3. THE WHOLE MODEL FOR A SCOPE.
 * ======================================================================== */

/** One row group — the operators under a single branch node. */
export interface MatrixTeam {
  branchId: string;
  /** The branch's ancestor names under the root, e.g. "Area 1 › Line 1". */
  label: string;
  operators: OperatorRecord[];
}

export interface MatrixInput {
  nodes: readonly BoardNode[];
  levels: readonly HierarchyLevel[];
  operators: readonly OperatorRecord[];
  skills: readonly SkillRecord[];
  operatorSkills: readonly OperatorSkillRecord[];
  /** The node to scope to, or `null` for everything readable. */
  scopeNodeId: string | null;
  /** `YYYY-MM-DD`. */
  today: string;
  /** Days ahead that count as "expiring soon". */
  windowDays: number;
  /** Include retired trainings / inactive operators? Default false. */
  includeInactive?: boolean;
}

export interface MatrixModel {
  columns: MatrixColumns;
  teams: MatrixTeam[];
  /** Every visible operator, flattened (teams already hold them grouped). */
  operators: OperatorRecord[];
  cellState: (operatorId: string, skillId: string) => CellState;
  counts: { people: number; trainings: number; gaps: number; needRenewal: number };
}

/** Build the whole matrix model for one scope. */
export function buildMatrix(input: MatrixInput): MatrixModel {
  const byId = new Map(input.nodes.map((n) => [n.id, n] as const));
  const levelsById = new Map(input.levels.map((l) => [l.id, l] as const));
  const includeInactive = input.includeInactive ?? false;

  const pathOf = (nodeId: string): string | undefined => byId.get(nodeId)?.path;
  const scopePath = input.scopeNodeId !== null ? pathOf(input.scopeNodeId) : null;

  // A resolvable, in-scope, (active) operator.
  const operators = input.operators.filter((o) => {
    if (!includeInactive && !o.active) return false;
    const p = pathOf(o.siteNodeId);
    if (p === undefined) return false; // node not readable -> cannot place them
    if (scopePath == null) return true;
    return isAtOrBelow(p, scopePath);
  });

  // A resolvable, in-scope, (active) training.
  const skills = input.skills.filter((s) => {
    if (!includeInactive && !s.active) return false;
    const p = pathOf(s.siteNodeId);
    if (p === undefined) return false;
    if (scopePath == null) return true;
    return comparable(p, scopePath);
  });

  const columns = buildColumns(skills, byId, levelsById);

  // Holdings keyed for O(1) cell lookup.
  const holdings = new Map<string, OperatorSkillRecord>();
  for (const h of input.operatorSkills) holdings.set(`${h.operatorId}:${h.skillId}`, h);

  const skillById = new Map(skills.map((s) => [s.id, s] as const));

  const cellState = (operatorId: string, skillId: string): CellState => {
    const op = byId.get(operators.find((o) => o.id === operatorId)?.siteNodeId ?? "");
    const skill = skillById.get(skillId);
    if (op === undefined || skill === undefined) return "na";
    const ownerPath = pathOf(skill.siteNodeId);
    if (ownerPath === undefined) return "na";
    const applies = trainingApplies(ownerPath, op.path);
    return cellStateFor(holdings.get(`${operatorId}:${skillId}`), applies, input.today, input.windowDays);
  };

  // Group operators into teams by their branch node, ordered by the branch's
  // path, and label each by its ancestor names UNDER the header root.
  const root = columns.cols.length > 0 ? lowestCommonAncestor(skills.map((s) => s.siteNodeId), byId) : null;
  const teamLabel = (branchId: string): string => {
    if (root === null) return byId.get(branchId)?.name ?? "";
    const chain = chainOf(branchId, byId); // branch..root
    const cut = chain.indexOf(root);
    const seg = (cut >= 0 ? chain.slice(0, cut) : chain).reverse(); // under-root .. branch, excl root
    if (seg.length === 0) return byId.get(branchId)?.name ?? "";
    return seg.map((id) => byId.get(id)?.name ?? "").join(" › ");
  };

  const branchIds: string[] = [];
  for (const o of operators) if (!branchIds.includes(o.siteNodeId)) branchIds.push(o.siteNodeId);
  branchIds.sort((a, b) => (byId.get(a)?.path ?? "").localeCompare(byId.get(b)?.path ?? ""));

  const teams: MatrixTeam[] = branchIds.map((branchId) => ({
    branchId,
    label: teamLabel(branchId),
    operators: operators
      .filter((o) => o.siteNodeId === branchId)
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
  }));

  let gaps = 0;
  let needRenewal = 0;
  for (const o of operators) {
    for (const s of columns.cols) {
      const st = cellState(o.id, s.id);
      if (st === "missing") gaps++;
      else if (st === "expiring" || st === "expired") needRenewal++;
    }
  }

  return {
    columns,
    teams,
    operators,
    cellState,
    counts: { people: operators.length, trainings: columns.cols.length, gaps, needRenewal },
  };
}

/* The Operators tab does not draw a per-person trainings matrix any more — the
 * maintainer merged it into the places matrix ("an operator cannot work in an
 * area unless they're trained on it"), so a training is recorded from the place
 * that needs it. `buildColumns` + `trainingApplies` are what that screen reuses;
 * there is no single-operator model to build here. */
