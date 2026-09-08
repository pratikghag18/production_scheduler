import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteWeekTemplate,
  fetchHierarchyTree,
  listWeekTemplates,
  renameWeekTemplate,
  describeSchedulerError,
  type SchedulerError,
  type WeekTemplate,
} from "@/lib/api";
import { useSession } from "@/features/auth/useSession";
import { canQueryAsUser } from "@/features/auth/session";
import { useEditRights } from "../hooks/useEditRights";
import { canAdministerPlant, useDateFormat } from "../hooks/useOrgSettings";
import { hierarchyKeys } from "../hooks/useHierarchyMutations";
import { usePlantFilter } from "../hooks/usePlantFilter";
import { formatCalendarDay, type DateFormat } from "@/lib/format/dates";
import styles from "./TemplatesPanel.module.css";

/** Ready flag, like every other admin section's. */
export const TEMPLATES_PANEL_READY = true;

export const templateKeys = {
  forPlant: (plantId: string) => ["week-templates", plantId] as const,
};

/**
 * Templates (R-356). Lists the chosen plant's named week templates and lets the
 * plant's ADMINS rename and delete them. It is offered only to admins
 * (`adminSectionsFor` keeps it out of a supervisor's list); saving and applying
 * a template live on the board, where the week is.
 *
 * ⚠️ RENAME/DELETE ARE GATED BY THE SAME PREDICATE THE SERVER RUNS
 * (`canAdministerPlant` on the plant's path = `app_is_admin_for`), so the panel
 * never offers a control the server would refuse (CLAUDE.md section 4). On "All
 * plants", or a plant the reader may only view, it lists and offers nothing.
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
  const mayAdminister = plant !== null && canAdministerPlant(plant.path, rights);
  // Same seam every admin panel reads a calendar date through (dateSeam.test.ts):
  // the plant's own override, or the company's, never a re-derived format.
  const dateFormat = useDateFormat(canQuery, plant?.id ?? null);

  const templatesQuery = useQuery<WeekTemplate[], SchedulerError>({
    queryKey: templateKeys.forPlant(plant?.id ?? ""),
    queryFn: () => listWeekTemplates(plant?.id ?? ""),
    enabled: canQuery && plant !== null,
  });

  if (plant === null) {
    return (
      <p className={styles.empty}>Choose a plant in “Showing”, at the top, to see its templates.</p>
    );
  }

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
    </div>
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
  const [name, setName] = useState(template.name);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: templateKeys.forPlant(plantId) });

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
    </li>
  );
}
