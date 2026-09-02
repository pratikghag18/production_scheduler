/* ---------------------------------------------------------------------------
   The Operator Training Matrix — who on a team holds which training, at a glance.

   THE MAINTAINER, 2 September:
     "a matrix which lets the supervisor see who on his team is trained on what
      vs reading through individual teams... very visual, status at a glance."

   ⭐ THE COLUMN HEADER IS THE HIERARCHY ITSELF. Each training sits under the
   exact node that owns it, and the header climbs from the highest level in view
   down to that owner — an area spans across the top, then splits into its lines,
   with a node's own trainings bucketed as "… area-wide" beside its children.
   All of that shaping is in the pure `../lib/matrix.ts`, which is what
   `src/test/matrix.test.ts` tests; this file renders what `buildMatrix` returns.

   ⭐ NO NEW SERVER WORK. It reads `useOperatorsAdmin` — the same one query the
   Operators and Trainings sections already make — so React Query serves all
   three from one request. A cell is trained when a holding row exists, and
   expiring/expired is read off its expiry date; nothing here fetches.

   ⭐ FILTERS AT EVERY LEVEL, SCOPED BY WHAT YOU CAN READ. The plant chooser is
   `AdminPage`'s shared one (read here through `usePlantFilter`); this panel adds
   the area and line below it and a multi-select over operators. The node set is
   already RLS-scoped to the reader, so there is no per-role special-casing — a
   supervisor simply sees fewer nodes to filter by.

   TAKES NO PROPS, like the panels beside it. `MATRIX_PANEL_READY` lives here so
   the section cannot be switched on without a panel behind it.

   ⚠️ Record-in-place (clicking a cell to record or edit a training) is the next
   stage; this is the read-only view. --------------------------------------- */
import { Fragment, useMemo, useState } from "react";
import { useSession } from "@/features/auth/useSession";
import { canQueryAsUser } from "@/features/auth/session";
import {
  useGrantSkill,
  useOperatorsAdmin,
  useRevokeSkill,
  useUpdateSkillRecord,
} from "../hooks/useOperators";
import { useEditRights } from "../hooks/useEditRights";
import { usePlantFilter } from "../hooks/usePlantFilter";
import { buildMatrix } from "../lib/matrix";
import {
  EXPIRING_WINDOW_DAYS,
  MatrixChip,
  MatrixLegend,
  RecordPopover,
  STATE_LABEL,
  type RecordFields,
} from "./matrixCells";
import type { OperatorRecord, OperatorSkillRecord, SkillRecord } from "@/lib/api";
import styles from "./MatrixPanel.module.css";

/** Read by `AdminPage`'s rail, the same way `TRAININGS_PANEL_READY` is. */
export const MATRIX_PANEL_READY = true;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function MatrixPanel() {
  const { session, profile, loading: sessionLoading } = useSession();
  const canQuery = canQueryAsUser(session?.user.id ?? null, sessionLoading);
  const orgId = profile?.orgId ?? null;
  const { data, isLoading, isError } = useOperatorsAdmin(canQuery);
  // ⭐ Record-in-place is gated by whether this reader may edit the OPERATOR's
  // node (`app_can_edit_operator` = `app_can_edit_node(operator.site_node_id)`),
  // not the training's owner. Fails OPEN, like `editRights` itself — a cell the
  // client is unsure about is offered and the server's write-error contract
  // answers, never hidden. A slow grant read must not hold up the grid.
  const { canEdit } = useEditRights(canQuery, profile?.role ?? null);
  const grant = useGrantSkill();
  const updateRecord = useUpdateSkillRecord();
  const revoke = useRevokeSkill();
  // ⚠️ `!canQuery || isLoading`, never `isLoading` alone (D91): a gated query
  // leaves `isLoading` FALSE, so this is what tells a spinner from an empty grid.
  const loading = !canQuery || isLoading;

  const nodes = useMemo(() => data?.nodes ?? [], [data]);
  const plantFilter = usePlantFilter(nodes);

  // The area / line cascade below the shared plant chooser, plus the operator
  // multi-select. Kept local — a view choice, not shared state.
  const [areaId, setAreaId] = useState<string | null>(null);
  const [lineId, setLineId] = useState<string | null>(null);
  const [pickedOps, setPickedOps] = useState<ReadonlySet<string> | null>(null); // null = all

  // Record-in-place: which cell's popover is open (the popover owns its fields).
  const [editing, setEditing] = useState<{
    operatorId: string;
    skillId: string;
    top: number;
    left: number;
  } | null>(null);

  const childrenOf = useMemo(() => {
    return (parentId: string | null): typeof nodes => {
      if (parentId === null) return [];
      return [...nodes]
        .filter((n) => n.parentId === parentId && n.active)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    };
  }, [nodes]);

  // Resolve the cascade against what is actually available now, so a stale
  // selection (after the plant changed) collapses to "All" rather than sticking.
  const plantId = plantFilter.choice;
  const areas = plantId ? childrenOf(plantId) : [];
  const effectiveAreaId = areas.some((a) => a.id === areaId) ? areaId : null;
  const lines = effectiveAreaId ? childrenOf(effectiveAreaId) : [];
  const effectiveLineId = lineId !== null && lines.some((l) => l.id === lineId) ? lineId : null;

  const scopeNodeId = effectiveLineId ?? effectiveAreaId ?? plantId ?? null;

  const model = useMemo(() => {
    if (!data) return null;
    return buildMatrix({
      nodes: data.nodes,
      levels: data.levels,
      operators: data.operators,
      skills: data.skills,
      operatorSkills: data.operatorSkills,
      scopeNodeId,
      today: todayIso(),
      windowDays: EXPIRING_WINDOW_DAYS,
    });
  }, [data, scopeNodeId]);

  const nodesById = useMemo(() => new Map(nodes.map((n) => [n.id, n] as const)), [nodes]);
  const holdings = useMemo(() => {
    const m = new Map<string, OperatorSkillRecord>();
    for (const h of data?.operatorSkills ?? []) m.set(`${h.operatorId}:${h.skillId}`, h);
    return m;
  }, [data]);

  // Every operator in scope, for the multi-select checklist.
  const opsInScope = model?.operators ?? [];
  const pickedCount = pickedOps ? opsInScope.filter((o) => pickedOps.has(o.id)).length : opsInScope.length;
  const allPicked = pickedOps === null || pickedCount === opsInScope.length;

  const isPicked = (id: string) => pickedOps === null || pickedOps.has(id);
  const toggleOp = (id: string) => {
    setPickedOps((prev) => {
      const base = new Set(prev ?? opsInScope.map((o) => o.id));
      if (base.has(id)) base.delete(id);
      else base.add(id);
      return base.size === opsInScope.length ? null : base;
    });
  };

  if (loading) {
    return <p className={styles.status}>Loading…</p>;
  }
  if (isError || !data || !model) {
    return (
      <p className={styles.status} role="alert">
        Couldn't load the training matrix. Try refreshing the page.
      </p>
    );
  }

  const { columns } = model;
  const headerRows = columns.maxBands + 1;
  const teams = model.teams
    .map((t) => ({ ...t, operators: t.operators.filter((o) => isPicked(o.id)) }))
    .filter((t) => t.operators.length > 0);
  const shownOps = teams.reduce((n, t) => n + t.operators.length, 0);
  const showTeams = teams.length > 1;

  const scopeName = scopeNodeId ? (nodes.find((n) => n.id === scopeNodeId)?.name ?? "") : "everything you can see";

  // ---- record-in-place ----
  const operatorEditable = (o: OperatorRecord) =>
    orgId !== null && canEdit(nodesById.get(o.siteNodeId)?.path ?? null);
  const openEditor = (o: OperatorRecord, t: SkillRecord, target: HTMLElement) => {
    const r = target.getBoundingClientRect();
    setEditing({ operatorId: o.id, skillId: t.id, top: r.bottom + 4, left: r.left });
  };
  const closeEditor = () => {
    setEditing(null);
    grant.reset();
    updateRecord.reset();
    revoke.reset();
  };
  const held = editing !== null && holdings.has(`${editing.operatorId}:${editing.skillId}`);
  const saveRecord = (fields: RecordFields) => {
    if (editing === null || orgId === null) return;
    const vars = { operatorId: editing.operatorId, skillId: editing.skillId };
    if (held) updateRecord.mutate({ ...vars, ...fields }, { onSuccess: closeEditor });
    else grant.mutate({ orgId, ...vars, ...fields }, { onSuccess: closeEditor });
  };
  const doRevoke = () => {
    if (editing === null) return;
    revoke.mutate({ operatorId: editing.operatorId, skillId: editing.skillId }, { onSuccess: closeEditor });
  };
  const saving = grant.isPending || updateRecord.isPending || revoke.isPending;
  const saveError = grant.error ?? updateRecord.error ?? revoke.error ?? null;
  const editingOp = editing !== null ? (opsInScope.find((o) => o.id === editing.operatorId) ?? null) : null;
  const editingSkill = editing !== null ? (columns.cols.find((c) => c.id === editing.skillId) ?? null) : null;

  return (
    <div className={styles.panel}>
      <p className={styles.lead}>
        Who on the team holds which training, at a glance. Showing <b>{scopeName}</b> — {shownOps}{" "}
        {shownOps === 1 ? "person" : "people"}, {columns.cols.length} trainings.
      </p>

      {/* Filters: the plant chooser lives on AdminPage above; area and line and
          the operator picker are here. */}
      <div className={styles.filters}>
        {plantId && areas.length > 0 && (
          <label className={styles.filter}>
            <span className={styles.filterLabel}>Area</span>
            <select
              className={styles.select}
              value={effectiveAreaId ?? ""}
              onChange={(e) => {
                setAreaId(e.target.value === "" ? null : e.target.value);
                setLineId(null);
              }}
            >
              <option value="">All areas</option>
              {areas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {effectiveAreaId && lines.length > 0 && (
          <label className={styles.filter}>
            <span className={styles.filterLabel}>Line</span>
            <select
              className={styles.select}
              value={effectiveLineId ?? ""}
              onChange={(e) => setLineId(e.target.value === "" ? null : e.target.value)}
            >
              <option value="">All lines</option>
              {lines.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {opsInScope.length > 0 && (
          <details className={styles.opFilter}>
            <summary className={styles.opSummary}>
              {allPicked ? "All operators" : "Selected operators"}
              <span className={styles.opCount}>
                {allPicked ? opsInScope.length : `${pickedCount} of ${opsInScope.length}`}
              </span>
            </summary>
            <div className={styles.opMenu}>
              <div className={styles.opActions}>
                <button type="button" onClick={() => setPickedOps(null)}>
                  All
                </button>
                <button type="button" onClick={() => setPickedOps(new Set())}>
                  None
                </button>
              </div>
              {opsInScope.map((o) => (
                <label key={o.id} className={styles.opRow}>
                  <input type="checkbox" checked={isPicked(o.id)} onChange={() => toggleOp(o.id)} />
                  <span className={styles.opName}>{o.displayName}</span>
                </label>
              ))}
            </div>
          </details>
        )}
      </div>

      {/* Legend — shared with the single-operator matrix on the Operators tab. */}
      <MatrixLegend />

      {teams.length === 0 || columns.cols.length === 0 ? (
        <p className={styles.status}>Nothing in scope — widen a filter above.</p>
      ) : (
        <div className={styles.scroll}>
          <table className={styles.mx}>
            <thead>
              {columns.bands.map((band, b) => (
                <tr key={b} className={styles.groupRow}>
                  {b === 0 && (
                    <th className={styles.op} rowSpan={headerRows} scope="col">
                      Operator
                    </th>
                  )}
                  {band.map((cell, i) => (
                    <th key={i} className={styles.owner} colSpan={cell.colspan} rowSpan={cell.rowspan}>
                      {cell.label}
                    </th>
                  ))}
                </tr>
              ))}
              <tr className={styles.nameRow}>
                {columns.cols.map((t) => (
                  <th key={t.id} className={styles.colName} scope="col">
                    {t.name}
                    {t.externalId && <span className={styles.doc}>{t.externalId}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {teams.map((team) => (
                <Fragment key={team.branchId}>
                  {showTeams && (
                    <tr className={styles.teamRow}>
                      <td className={styles.op} colSpan={columns.cols.length + 1}>
                        {team.label}
                      </td>
                    </tr>
                  )}
                  {team.operators.map((o) => {
                    const canEditRow = operatorEditable(o);
                    return (
                      <tr key={o.id}>
                        <td className={styles.op}>
                          <span className={styles.opNm}>{o.displayName}</span>
                          {o.employeeRef && <span className={styles.opRef}>{o.employeeRef}</span>}
                        </td>
                        {columns.cols.map((t) => {
                          const st = model.cellState(o.id, t.id);
                          const clickable = st !== "na" && canEditRow;
                          const title = `${o.displayName} — ${t.name}: ${STATE_LABEL[st]}${
                            clickable ? " (click to record)" : ""
                          }`;
                          return (
                            <td key={t.id} className={styles.cell}>
                              <MatrixChip
                                state={st}
                                title={title}
                                onClick={clickable ? (e) => openEditor(o, t, e.currentTarget) : undefined}
                              />
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className={styles.count}>
        {model.counts.people} people · {model.counts.trainings} trainings ·{" "}
        <b className={styles.gap}>{model.counts.gaps} gaps</b> ·{" "}
        <b className={styles.warn}>{model.counts.needRenewal} need renewal</b>
      </p>

      {editing !== null && editingOp !== null && editingSkill !== null && (
        <RecordPopover
          key={`${editing.operatorId}:${editing.skillId}`}
          who={editingOp.displayName}
          what={editingSkill.name}
          whatRef={editingSkill.externalId}
          held={held}
          initial={{
            certifiedAt: holdings.get(`${editing.operatorId}:${editing.skillId}`)?.certifiedAt ?? null,
            expiresAt: holdings.get(`${editing.operatorId}:${editing.skillId}`)?.expiresAt ?? null,
            signedOffBy: holdings.get(`${editing.operatorId}:${editing.skillId}`)?.signedOffBy ?? null,
          }}
          position={{ top: editing.top, left: editing.left }}
          saving={saving}
          error={saveError}
          onSave={saveRecord}
          onRemove={doRevoke}
          onClose={closeEditor}
        />
      )}
    </div>
  );
}
