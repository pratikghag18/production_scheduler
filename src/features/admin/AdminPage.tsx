import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
// `fetchHierarchyTree` moved to src/lib/api/hierarchy.ts by the design session:
// `src/lib/api/` is the only place allowed to touch supabase, snake_case or
// database.types.ts (docs/conventions.md). The brief's file table authorised no
// file for it, which is why it landed here; the boundary is the rule.
import { fetchHierarchyTree } from "@/lib/api";
import { hierarchyKeys } from "./hooks/useHierarchyMutations";
import { LevelEditor } from "./components/LevelEditor";
import { NodeTreeEditor } from "./components/NodeTreeEditor";
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
              <div className={styles.hierarchyGrid}>
                <LevelEditor levels={data.levels} />
                <NodeTreeEditor nodes={data.nodes} levels={data.levels} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
