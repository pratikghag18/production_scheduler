import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteWeekTemplate,
  fetchHierarchyTree,
  listWeekTemplates,
  listWeekTemplateItems,
  renameWeekTemplate,
  describeSchedulerError,
  type SchedulerError,
  type WeekTemplate,
  type WeekTemplateItem,
} from "@/lib/api";
import { useSession } from "@/features/auth/useSession";
import { canQueryAsUser } from "@/features/auth/session";
import { useEditRights } from "../hooks/useEditRights";
import { type EditRights } from "../lib/editRights";
import { canAdministerPlant, useDateFormat } from "../hooks/useOrgSettings";
import { hierarchyKeys } from "../hooks/useHierarchyMutations";
import { usePlantFilter } from "../hooks/usePlantFilter";
import { type PlantOption } from "../lib/plantFilter";
import { formatCalendarDay, type DateFormat } from "@/lib/format/dates";
import styles from "./TemplatesPanel.module.css";

/** Ready flag, like every other admin section's. */
export const TEMPLATES_PANEL_READY = true;

export const templateKeys = {
  forPlant: (plantId: string) => ["week-templates", plantId] as const,
};

/** `day_offset` 0-6, Monday first — the same convention migration 0067 stores. */
const DAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

/**
 * Minutes from a day's midnight -> `H:MM`. An overnight item's `endMin`
 * exceeds 1440 (migration 0067 §1): shown wrapped onto its own clock face
 * with a `+1d` mark, so 1320-1800 (22:00 Wed -> 06:00 Thu) reads "22:00–6:00
 * (+1d)" rather than a nonsensical "27:00".
 */
function formatDayTime(min: number): string {
  const wrapped = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  const clock = `${h}:${String(m).padStart(2, "0")}`;
  return min >= 1440 ? `${clock} (+1d)` : clock;
}

/** One run item, grouped with the assignment items whose `runRef` names it. */
interface DayRun {
  run: WeekTemplateItem;
  crew: WeekTemplateItem[];
}

/**
 * One node's runs (and standalone assignments) within a day --- the
 * maintainer, 10 Sept: "Show contents" must say WHICH line/cell each run is
 * on, adapting to the plant's dynamic hierarchy. `label` is the node's full
 * path relative to the plant (`nodePath`), falling back to the leaf
 * (`nodeName`) and then "(removed)" --- the same fallback order the node no
 * longer resolving already forces on every `*Name` field (0067 D110).
 */
interface NodeGroup {
  nodeId: string;
  label: string;
  runs: DayRun[];
  /** Assignments with no `runRef`, on this node --- not attached to any run. */
  standalone: WeekTemplateItem[];
}

/** One day's worth of a template's contents, in the shape the list renders. */
interface DayGroup {
  dayOffset: number;
  nodes: NodeGroup[];
}

/** `nodePath` (0077), else the leaf `nodeName`, else "(removed)" — one place. */
function nodeGroupLabel(item: WeekTemplateItem): string {
  return item.nodePath ?? item.nodeName ?? "(removed)";
}

/**
 * Group a flat item list (server order: day, node, start, kind) into one
 * section per day, and within each day one section per NODE (line/cell) ---
 * each run paired with its crew (assignments whose `runRef === run.itemRef`)
 * and that node's standalone assignments listed alongside. Read-only view;
 * nothing here writes or re-orders what the server sent beyond bucketing it.
 */
function groupItemsByDay(items: WeekTemplateItem[]): DayGroup[] {
  const byDay = new Map<number, WeekTemplateItem[]>();
  for (const item of items) {
    const bucket = byDay.get(item.dayOffset);
    if (bucket) bucket.push(item);
    else byDay.set(item.dayOffset, [item]);
  }
  return Array.from(byDay.keys())
    .sort((a, b) => a - b)
    .map((dayOffset) => {
      const dayItems = byDay.get(dayOffset) ?? [];

      // One bucket per node, in first-seen (server) order.
      const nodeIds: string[] = [];
      const byNode = new Map<string, WeekTemplateItem[]>();
      for (const item of dayItems) {
        const bucket = byNode.get(item.nodeId);
        if (bucket) bucket.push(item);
        else {
          byNode.set(item.nodeId, [item]);
          nodeIds.push(item.nodeId);
        }
      }

      const nodes: NodeGroup[] = nodeIds
        .map((nodeId) => {
          const nodeItems = byNode.get(nodeId) ?? [];
          const runs: DayRun[] = nodeItems
            .filter((i) => i.kind === "run")
            .map((run) => ({
              run,
              // Crew is looked up across the whole day, not just this node's
              // bucket: nothing guarantees an assignment shares its run's node.
              crew: dayItems.filter((i) => i.kind === "assignment" && i.runRef === run.itemRef),
            }));
          const standalone = nodeItems.filter((i) => i.kind === "assignment" && i.runRef === null);
          return { nodeId, label: nodeGroupLabel(nodeItems[0]), runs, standalone };
        })
        // A node bucket holding only OTHER nodes' crew (kind "assignment"
        // with a runRef, filtered out of both runs and standalone above)
        // would otherwise render as an empty, label-only group.
        .filter((g) => g.runs.length > 0 || g.standalone.length > 0);

      return { dayOffset, nodes };
    });
}

/**
 * Templates (R-356). Lists the chosen plant's named week templates and lets the
 * plant's ADMINS rename and delete them. It is offered only to admins
 * (`adminSectionsFor` keeps it out of a supervisor's list); saving and applying
 * a template live on the board, where the week is.
 *
 * ⚠️ RENAME/DELETE ARE GATED BY THE SAME PREDICATE THE SERVER RUNS
 * (`canAdministerPlant` on the plant's path = `app_is_admin_for`), so the panel
 * never offers a control the server would refuse (CLAUDE.md section 4). On a
 * plant the reader may only view, it lists and offers nothing.
 *
 * ⭐ "ALL PLANTS" (R-358, the maintainer 10 Sept: "For all plants, show all
 * templates.") is not one absent plant, it is EVERY readable plant: one
 * section per plant (`PlantTemplates`, the same component and markup the
 * single-plant path uses), each still gated on `canAdministerPlant` for that
 * plant's own path --- an admin of Plant A and only a viewer of Plant B sees
 * rename/delete on the first section and not the second.
 */
export function TemplatesPanel() {
  const { session, profile, loading: sessionLoading } = useSession();
  const canQuery = canQueryAsUser(session?.user.id ?? null, sessionLoading);
  const treeQuery = useQuery({
    queryKey: [...hierarchyKeys.all, "tree"],
    queryFn: fetchHierarchyTree,
    enabled: canQuery,
  });
  const plantFilter = usePlantFilter(treeQuery.data?.nodes ?? []);
  const { rights } = useEditRights(canQuery, profile?.role ?? null);

  // A single plant is needed: the chosen one, or the only readable one.
  const plant =
    plantFilter.choice !== null
      ? (plantFilter.plants.find((p) => p.id === plantFilter.choice) ?? null)
      : plantFilter.plants.length === 1
        ? plantFilter.plants[0]
        : null;

  if (plant !== null) {
    return (
      <div className={styles.body}>
        <p className={styles.plant}>{plant.name}</p>
        {/* R-358: the panel lists, renames and deletes; it says nothing about
            applying. Name the plant, what a template is, and the one route back
            to the board. */}
        <p className={styles.about}>
          A template is a whole week's runs and their people, saved from {plant.name}. It is applied
          from the board's toolbar, with “Apply a template”.
        </p>
        <PlantTemplates plant={plant} canQuery={canQuery} rights={rights} />
      </div>
    );
  }

  // "All plants" (the maintainer: "For all plants, show all templates.") ---
  // no single plant resolved, but there IS more than one readable plant: a
  // section per plant, each rendering with the exact same PlantTemplates
  // markup the single-plant path above uses, so the two never drift apart.
  // Fewer than two readable plants and no chosen one means the reader has
  // nothing to see yet (loading, or none at all) --- the prompt below.
  if (plantFilter.plants.length > 1) {
    return (
      <div className={styles.body}>
        <p className={styles.about}>
          A template is a whole week's runs and their people, saved from its plant. It is applied
          from the board's toolbar, with “Apply a template”.
        </p>
        {plantFilter.plants.map((p) => (
          <div key={p.id} className={styles.plantSection}>
            <p className={styles.plant}>{p.name}</p>
            <PlantTemplates plant={p} canQuery={canQuery} rights={rights} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <p className={styles.empty}>Choose a plant in “Showing”, at the top, to see its templates.</p>
  );
}

/**
 * One plant's template list --- the query, loading/error/empty states, and
 * the `<ul>` of `TemplateRow`s. Factored out (R-358 / "All plants") so the
 * single-plant path and every "All plants" section render this identically;
 * neither may drift into its own copy of the query or the markup.
 */
function PlantTemplates({
  plant,
  canQuery,
  rights,
}: {
  plant: PlantOption;
  canQuery: boolean;
  rights: EditRights;
}) {
  const mayAdminister = canAdministerPlant(plant.path, rights);
  // Same seam every admin panel reads a calendar date through (dateSeam.test.ts):
  // the plant's own override, or the company's, never a re-derived format.
  const dateFormat = useDateFormat(canQuery, plant.id);

  const templatesQuery = useQuery<WeekTemplate[], SchedulerError>({
    queryKey: templateKeys.forPlant(plant.id),
    queryFn: () => listWeekTemplates(plant.id),
    enabled: canQuery,
  });

  return (
    <>
      {templatesQuery.isLoading && <p className={styles.empty}>Loading templates…</p>}
      {templatesQuery.isError && (
        <p role="alert" className={styles.error}>
          {describeSchedulerError(templatesQuery.error)}
        </p>
      )}
      {templatesQuery.data && templatesQuery.data.length === 0 && (
        <p className={styles.empty}>
          No templates saved for this plant yet. Save one from the board with “Save this week as a
          template”.
        </p>
      )}
      {templatesQuery.data && templatesQuery.data.length > 0 && (
        <ul className={styles.list} aria-label="Templates">
          {templatesQuery.data.map((t) => (
            <TemplateRow
              key={t.id}
              template={t}
              plantId={plant.id}
              mayAdminister={mayAdminister}
              dateFormat={dateFormat}
            />
          ))}
        </ul>
      )}
    </>
  );
}

function TemplateRow({
  template,
  plantId,
  mayAdminister,
  dateFormat,
}: {
  template: WeekTemplate;
  plantId: string;
  mayAdminister: boolean;
  dateFormat: DateFormat;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState(template.name);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: templateKeys.forPlant(plantId) });

  // Read only, offered to everyone who can see the row (not gated on
  // mayAdminister — Rename/Delete are the admin-only controls; this is a
  // view). Fetches only once expanded, and only the once (React Query keeps
  // it cached under its own key, distinct from the list's).
  const itemsQuery = useQuery<WeekTemplateItem[], SchedulerError>({
    queryKey: [...templateKeys.forPlant(plantId), template.id, "items"],
    queryFn: () => listWeekTemplateItems(template.id),
    enabled: expanded,
  });

  const rename = useMutation<void, SchedulerError, string>({
    mutationFn: (next: string) => renameWeekTemplate(template.id, next),
    onSuccess: () => {
      setEditing(false);
      setError(null);
      void invalidate();
    },
    onError: (err) => setError(describeSchedulerError(err)),
  });

  const remove = useMutation<void, SchedulerError, void>({
    mutationFn: () => deleteWeekTemplate(template.id),
    onSuccess: () => {
      setConfirming(false);
      void invalidate();
    },
    onError: (err) => setError(describeSchedulerError(err)),
  });

  return (
    <li className={styles.row}>
      <div className={styles.rowMain}>
        {editing ? (
          <input
            className={styles.nameInput}
            value={name}
            autoFocus
            aria-label={`Rename ${template.name}`}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim() !== "") rename.mutate(name.trim());
              if (e.key === "Escape") {
                setEditing(false);
                setName(template.name);
              }
            }}
          />
        ) : (
          <span className={styles.name}>{template.name}</span>
        )}
        <span className={styles.meta}>
          saved from {formatCalendarDay(template.savedFrom, dateFormat)} · {template.runs}{" "}
          {template.runs === 1 ? "run" : "runs"}, {template.assignments}{" "}
          {template.assignments === 1 ? "assignment" : "assignments"}
        </span>
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Hide contents" : "Show contents"}
        </button>
      </div>

      {mayAdminister && (
        <div className={styles.actions}>
          {editing ? (
            <>
              <button
                type="button"
                disabled={name.trim() === "" || rename.isPending}
                onClick={() => rename.mutate(name.trim())}
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setName(template.name);
                  setError(null);
                }}
              >
                Cancel
              </button>
            </>
          ) : confirming ? (
            <>
              <span className={styles.confirmText}>Delete?</span>
              <button type="button" disabled={remove.isPending} onClick={() => remove.mutate()}>
                Yes, delete
              </button>
              <button type="button" onClick={() => setConfirming(false)}>
                Keep
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => setEditing(true)}>
                Rename
              </button>
              <button type="button" onClick={() => setConfirming(true)}>
                Delete
              </button>
            </>
          )}
        </div>
      )}
      {error !== null && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}

      {expanded && (
        <div className={styles.contents}>
          {itemsQuery.isLoading && <p className={styles.empty}>Loading contents…</p>}
          {itemsQuery.isError && (
            <p role="alert" className={styles.error}>
              {describeSchedulerError(itemsQuery.error)}
            </p>
          )}
          {itemsQuery.data && itemsQuery.data.length === 0 && (
            <p className={styles.empty}>This template is empty.</p>
          )}
          {itemsQuery.data && itemsQuery.data.length > 0 && (
            <TemplateContents items={itemsQuery.data} />
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The grouped, per-day read of a template's snapshot. `items` is non-empty.
 * Reading order: Day -> Line/cell (`node.label`, prominent) -> the runs there
 * -> their crew --- the maintainer, 10 Sept: "show contents don't [show] what
 * line or sub-hierarchy level the template is for ... it should adapt to the
 * plant hierarchy."
 */
function TemplateContents({ items }: { items: WeekTemplateItem[] }) {
  return (
    <div className={styles.days}>
      {groupItemsByDay(items).map((day) => (
        <div key={day.dayOffset} className={styles.day}>
          <p className={styles.dayLabel}>{DAY_NAMES[day.dayOffset]}</p>
          {day.nodes.map((node) => (
            <div key={node.nodeId} className={styles.node}>
              <p className={styles.nodePath}>{node.label}</p>
              <ul className={styles.runList}>
                {node.runs.map(({ run, crew }) => (
                  <li key={run.itemRef} className={styles.runItem}>
                    <div className={styles.runHeader}>
                      <span
                        className={run.productName === null ? styles.removed : styles.runProduct}
                      >
                        {run.productName ?? "(removed product)"}
                      </span>
                      <span className={styles.runTime}>
                        {formatDayTime(run.startMin)}–{formatDayTime(run.endMin)}
                      </span>
                      {run.plannedHeadcount !== null && (
                        <span className={styles.runHeadcount}>{run.plannedHeadcount} planned</span>
                      )}
                    </div>
                    {crew.length > 0 && (
                      <ul className={styles.crewList}>
                        {crew.map((a) => (
                          <li key={a.itemRef} className={styles.crewItem}>
                            <span className={a.operatorName === null ? styles.removed : undefined}>
                              {a.operatorName ?? "(removed operator)"}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
                {node.standalone.map((a) => (
                  <li key={a.itemRef} className={styles.standaloneItem}>
                    <span className={a.operatorName === null ? styles.removed : undefined}>
                      {a.operatorName ?? "(removed operator)"}
                    </span>
                    {a.productId !== null && (
                      <span className={a.productName === null ? styles.removed : undefined}>
                        {a.productName ?? "(removed product)"}
                      </span>
                    )}
                    <span className={styles.runTime}>
                      {formatDayTime(a.startMin)}–{formatDayTime(a.endMin)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
