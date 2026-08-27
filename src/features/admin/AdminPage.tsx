import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
// `fetchHierarchyTree` moved to src/lib/api/hierarchy.ts by the design session:
// `src/lib/api/` is the only place allowed to touch supabase, snake_case or
// database.types.ts (docs/conventions.md). The brief's file table authorised no
// file for it, which is why it landed here; the boundary is the rule.
import { fetchHierarchyTree } from "@/lib/api";
import { useSession } from "@/features/auth/useSession";
import { canQueryAsUser } from "@/features/auth/session";
import { hierarchyKeys } from "./hooks/useHierarchyMutations";
import {
  buildShapeSummaries,
  filterEditableShapes,
  resolveSelectedShape,
} from "./lib/shapePicker";
import { LevelEditor } from "./components/LevelEditor";
import { NodeTreeEditor } from "./components/NodeTreeEditor";
import { ShapePicker } from "./components/ShapePicker";
import { SiteAccessPanel } from "./components/SiteAccessPanel";
import styles from "./AdminPage.module.css";

/**
 * The sectioned shell (brief P1-5d §6.1/§7.1). `/admin` grows to hold
 * Hierarchy, Shifts, Operators, Products and Import; only Hierarchy is
 * built here. A LEFT RAIL, not tabs (§6.1's call): the board already
 * spends a left rail on org structure (`--rail-w`), so this keeps that
 * idiom instead of introducing a second navigation pattern, and a rail
 * has room to grow -- five sections today, and each of Shifts/Operators/
 * Products is itself likely to grow sub-navigation later, which a tab
 * strip has no natural place for.
 *
 * Levels and nodes are read ONCE, here, and passed down: the tree needs
 * levels for `canDropOn` (§6.3 debt 2 -- always the COMPLETE array), and
 * the shell needs one shared loading state even though the level editor
 * itself has no use for `nodes`.
 */

type SectionId = "hierarchy" | "access" | "shifts" | "operators" | "products" | "import";

const SECTIONS: ReadonlyArray<{ id: SectionId; label: string; enabled: boolean }> = [
  { id: "hierarchy", label: "Hierarchy", enabled: true },
  { id: "access", label: "Access", enabled: true },
  { id: "shifts", label: "Shifts", enabled: false },
  { id: "operators", label: "Operators", enabled: false },
  { id: "products", label: "Products", enabled: false },
  { id: "import", label: "Import", enabled: false },
];


/**
 * §6.3 debt 1, CONFIRMED: keys under `hierarchyKeys.all` exactly as that
 * file's own comment proposed (`[...hierarchyKeys.all, "tree"]`) for the
 * read hook it was written waiting on. Every mutation in
 * `useHierarchyMutations.ts` already invalidates the `hierarchyKeys.all`
 * prefix, so this query is covered without either file knowing the
 * other's exact shape.
 */
function useHierarchyTree(enabled: boolean) {
  return useQuery({
    queryKey: [...hierarchyKeys.all, "tree"],
    queryFn: fetchHierarchyTree,
    // See useBoardWindow: REQUIRED, not defaulted. `fetchHierarchyTree` reads
    // `hierarchy_templates`, `hierarchy_levels` and `nodes`, all RLS-scoped to
    // the caller, so before the session resolves this can only be a 401.
    enabled,
  });
}

export default function AdminPage() {
  const [section, setSection] = useState<SectionId>("hierarchy");
  const { session, profile, loading: sessionLoading } = useSession();
  const canQuery = canQueryAsUser(session?.user.id ?? null, sessionLoading);
  const { data, isLoading, isError } = useHierarchyTree(canQuery);
  // Shared by the Hierarchy section's own "Loading..." branch below and by
  // `SiteAccessPanel`'s `treeLoading` prop (brief P1-6a §6/§9): one boolean,
  // not two call sites independently re-deriving the same D91-shaped
  // condition (`!canQuery || isLoading`) and risking them drifting apart.
  const hierarchyLoading = !canQuery || isLoading;

  // D87 (brief P1-5f §7.6): this component owns the shape SELECTION; every
  // other fact about a shape (its levels, whether it has nodes) is derived
  // from the one shared `fetchHierarchyTree` read via `buildShapeSummaries`,
  // never refetched or recomputed per child. `resolveSelectedShape` is what
  // keeps the selection from pointing at a shape that no longer exists
  // (e.g. right after deleting the one currently selected).
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null);
  // 0021 §2: the picker offers the structures this person may actually edit.
  // A company admin sees every one; a site admin sees their own site's. The
  // filter runs BEFORE `resolveSelectedShape`, so the selection can never
  // land on a structure the list no longer shows — the same reason that
  // function exists at all (D87).
  const allSummaries = data
    ? buildShapeSummaries(data.templates, data.levels, data.nodes)
    : [];
  const summaries = filterEditableShapes(allSummaries, data?.editableShapeIds ?? null);
  const resolvedShapeId = resolveSelectedShape(summaries, selectedShapeId);

  // Brief P1-6a §6: written out rather than
  // `data?.siteNodeIds[resolvedShapeId] ?? null`, because `resolvedShapeId`
  // is `string | null` and `data` is `undefined` until the query resolves --
  // indexing a `Record<string, ...>` with `string | null` does not compile.
  // The places the Access panel may be about: one per structure this person
  // may edit, named by the SITE that owns it rather than by the structure —
  // "Plant 2" is what an admin is looking for, not "Standard Plant (copy)".
  //
  // ⚠️ Derived from `summaries` (already filtered to what they may edit) and
  // NOT from the Hierarchy tab's current selection. The panel used to follow
  // that selection, which meant a company admin on the Access tab was shown
  // whichever plant a different tab had chosen, with no way to change it.
  const accessPlaces = data
    ? summaries
        .map((shape) => {
          const nodeId = data.siteNodeIds[shape.id] ?? null;
          if (nodeId === null) return null;
          const node = data.nodes.find((n) => n.id === nodeId);
          return node ? { nodeId, name: node.name } : null;
        })
        .filter((p): p is { nodeId: string; name: string } => p !== null)
    : [];

  return (
    <div className={styles.page}>
      <nav className={styles.rail} aria-label="Admin sections">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={section === s.id ? styles.railItemActive : styles.railItem}
            disabled={!s.enabled}
            aria-current={section === s.id ? "page" : undefined}
            title={s.enabled ? undefined : "Coming in a later brief"}
            onClick={() => setSection(s.id)}
          >
            {s.label}
            {!s.enabled && <span className={styles.soon}>soon</span>}
          </button>
        ))}
      </nav>

      <div className={styles.content}>
        {section === "hierarchy" && (
          <>
            <h1 className={styles.h1}>Hierarchy</h1>
            {/* `!canQuery || isLoading` — NOT `isLoading` alone. With
                `enabled: false` React Query v5 reports `isPending` with
                `fetchStatus: "idle"`, so `isLoading` is FALSE while the
                session is still resolving: gating the query without widening
                this condition renders a blank card instead of a spinner.
                That is §19.8's exact mistake — guarding the cache but not the
                loading flag — and it is why `decideSessionUpdate` exists. */}
            {(!canQuery || isLoading) && <p className={styles.status}>Loading…</p>}
            {isError && (
              <p className={styles.status} role="alert">
                Couldn't load the hierarchy. Try refreshing the page.
              </p>
            )}
            {data && (
              // `ShapePicker` renders above `LevelEditor` in the left
              // column (§7.3); `NodeTreeEditor` still spans the full right
              // column as before. Placed by explicit grid position (no
              // px, nothing but integers/strings) rather than a new
              // wrapper class, since `AdminPage.module.css` is not in this
              // brief's file table — flagged in the delivery report.
              <div className={styles.hierarchyGrid}>
                {/* D90b (design plan §19.24): ONE card. The level editor is a
                    child of the Site Structure card because it only ever edits
                    the structure selected there — they were peers while being
                    parent and child, and nothing on screen said so. */}
                <div style={{ gridColumn: 1, gridRow: 1 }}>
                  <ShapePicker
                    summaries={summaries}
                    selectedId={resolvedShapeId}
                    onSelect={setSelectedShapeId}
                  >
                    {/* key={resolvedShapeId}: remounts the editor on every
                        structure switch (§7.4) so a previous structure's draft
                        rows can never be left on screen and saved into the newly
                        selected template -- simpler and harder to get wrong
                        than an effect that has to stay in sync by hand. */}
                    <LevelEditor
                      key={resolvedShapeId}
                      levels={data.levels}
                      /* D92's client mirror (§19.30): the level editor cannot
                         say whether an order would strand anything without
                         knowing where the nodes sit. Same COMPLETE array the
                         tree gets -- `findLevelOrderProblems` scopes by
                         template itself, as the RPC does. */
                      nodes={data.nodes}
                      templateId={resolvedShapeId}
                    />
                  </ShapePicker>
                </div>
                <div style={{ gridColumn: 2, gridRow: 1 }}>
                  {/* `levels` here is the COMPLETE array, never filtered by
                      shape (§7.6/§6.3 debt 2 carried forward) -- `canDropOn`
                      and `legalParentsFor` need every level to answer
                      honestly about a move across shapes. */}
                  <NodeTreeEditor
                    nodes={data.nodes}
                    levels={data.levels}
                    shapeSummaries={summaries}
                    selectedTemplateId={resolvedShapeId}
                  />
                </div>
              </div>
            )}
          </>
        )}

        {section === "access" && (
          <>
            <h1 className={styles.h1}>Access</h1>
            <SiteAccessPanel
              places={accessPlaces}
              treeLoading={hierarchyLoading}
              viewerProfileId={profile?.id ?? null}
              viewerIsCompanyAdmin={profile?.role === "admin"}
            />
          </>
        )}
      </div>
    </div>
  );
}
