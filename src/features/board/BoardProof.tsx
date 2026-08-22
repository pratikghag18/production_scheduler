import { useMemo } from "react";
import type { BoardWindow } from "@/lib/api";
import styles from "./BoardProof.module.css";

/**
 * The counts-and-a-plain-list body of the temporary data-proof panel
 * (brief P1-3b §10) — split into its own file per docs/conventions.md's
 * "one React component per file" rule (BoardPage.tsx already has its own
 * default export for the route).
 */
export function BoardProof({ data }: { data: BoardWindow }) {
  const nodesByLevel = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of data.nodes) {
      counts.set(node.levelId, (counts.get(node.levelId) ?? 0) + 1);
    }
    return [...data.levels]
      .sort((a, b) => a.position - b.position)
      .map((level) => ({ level, count: counts.get(level.id) ?? 0 }));
  }, [data]);

  const schedulableLevelIds = useMemo(
    () => new Set(data.levels.filter((l) => l.isSchedulable).map((l) => l.id)),
    [data],
  );

  const templateNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const template of data.shiftTemplates) map.set(template.id, template.name);
    return map;
  }, [data]);

  const templateIdByNode = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const entry of data.nodeShiftMap) map.set(entry.nodeId, entry.templateId);
    return map;
  }, [data]);

  const schedulableCells = useMemo(
    () => data.nodes.filter((n) => schedulableLevelIds.has(n.levelId)),
    [data, schedulableLevelIds],
  );

  return (
    <>
      <ul className={styles.counts}>
        {nodesByLevel.map(({ level, count }) => (
          <li key={level.id}>
            {level.name}: {count}
          </li>
        ))}
        <li>Runs: {data.runs.length}</li>
        <li>Assignments: {data.assignments.length}</li>
        <li>Operators: {data.operators.length}</li>
      </ul>

      <table className={styles.table}>
        <thead>
          <tr>
            <th>Cell</th>
            <th>Path</th>
            <th>Shift template</th>
          </tr>
        </thead>
        <tbody>
          {schedulableCells.map((node) => {
            const templateId = templateIdByNode.get(node.id) ?? null;
            const templateName = templateId ? (templateNameById.get(templateId) ?? "—") : "—";
            return (
              <tr key={node.id}>
                <td>{node.name}</td>
                <td>{node.path}</td>
                <td>{templateName}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
