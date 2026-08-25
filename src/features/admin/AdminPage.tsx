import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
// `fetchHierarchyTree` moved to src/lib/api/hierarchy.ts by the design session:
// `src/lib/api/` is the only place allowed to touch supabase, snake_case or
// database.types.ts (docs/conventions.md). The brief's file table authorised no
// file for it, which is why it landed here; the boundary is the rule.
import { fetchHierarchyTree } from "@/lib/api";
import { hierarchyKeys } from "./hooks/useHierarchyMutations";
import { buildShapeSummaries, resolveSelectedShape } from "./lib/shapePicker";
import { LevelEditor } from "./components/LevelEditor";
import { NodeTreeEditor } from "./components/NodeTreeEditor";
import { ShapePicker } from "./components/ShapePicker";
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

type SectionId = "hierarchy" | "shifts" | "operators" | "products" | "import";

const SECTIONS: ReadonlyArray<{ id: SectionId; label: string; enabled: boolean }> = [
  { id: "hierarchy", label: "Hierarchy", enabled: true },
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
function useHierarchyTree() {
  return useQuery({
    queryKey: [...hierarchyKeys.all, "tree"],
    queryFn: fetchHierarchyTree,
  });
}

export default function AdminPage() {
  const [section, setSection] = useState<SectionId>("hierarchy");
  const { data, isLoading, isError } = useHierarchyTree();

  // D87 (brief P1-5f §7.6): this component owns the shape SELECTION; every
  // other fact about a shape (its levels, whether it has nodes) is derived
  // from the one shared `fetchHierarchyTree` read via `buildShapeSummaries`,
  // never refetched or recomputed per child. `resolveSelectedShape` is what
  // keeps the selection from pointing at a shape that no longer exists
  // (e.g. right after deleting the one currently selected).
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null);
  const summaries = data ? buildShapeSummaries(data.templates, data.levels, data.nodes) : [];
  const resolvedShapeId = resolveSelectedShape(summaries, selectedShapeId);

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
            {isLoading && <p className={styles.status}>Loading…</p>}
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
                <div style={{ gridColumn: 1, gridRow: 1 }}>
                  <ShapePicker
                    summaries={summaries}
                    selectedId={resolvedShapeId}
                    onSelect={setSelectedShapeId}
                  />
                </div>
                <div style={{ gridColumn: 1, gridRow: 2 }}>
                  {/* key={resolvedShapeId}: remounts the editor on every
                      shape switch (§7.4) so a previous shape's draft rows
                      can never be left on screen and saved into the newly
                      selected template -- simpler and harder to get wrong
                      than an effect that has to stay in sync by hand. */}
                  <LevelEditor
                    key={resolvedShapeId}
                    levels={data.levels}
                    templateId={resolvedShapeId}
                  />
                </div>
                <div style={{ gridColumn: 2, gridRow: "1 / span 2" }}>
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
      </div>
    </div>
  );
}
