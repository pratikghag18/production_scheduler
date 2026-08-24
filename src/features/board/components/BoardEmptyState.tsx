/**
 * T8: zero nodes (a viewer with no grants) renders this, not an empty grid.
 */
export function BoardEmptyState() {
  return (
    <div style={{ padding: "32px 16px", color: "var(--ink-2)", fontSize: 13 }}>
      <p style={{ margin: 0, fontWeight: 650, color: "var(--ink)" }}>Nothing to show here.</p>
      <p style={{ margin: "6px 0 0" }}>
        No hierarchy nodes were returned for this window — you may not have a grant on any node, or
        this org has not been set up yet.
      </p>
    </div>
  );
}
