import { useState } from "react";
import { describeSchedulerError, type SchedulerError } from "@/lib/api";
import {
  accessPanelState,
  allowedRoles,
  buildAccessRows,
  canRemoveAccess,
  describeAccess,
  GRANT_ROLES,
  partitionAccess,
  removalNote,
  type AccessRow,
  type GrantRole,
} from "../lib/siteAccess";
import { useRemoveSiteMember, useSetSiteMember, useSitePeople } from "../hooks/useSiteAccess";
import styles from "./SiteAccessPanel.module.css";

/**
 * "Who can get in" (brief P1-6a). The screen for one plant's access list:
 * who already has it, what they can do, and who does not have it yet.
 *
 * Renders nothing of its own past `accessPanelState`'s four branches
 * (§6 table) -- that function is the single source of truth for which of
 * pending / no-place / error / ready this is, precisely because D91 means
 * `peopleLoading` alone lies while the query is disabled.
 *
 * StrictMode (brief §6): every mutation is fired from an event handler
 * (`onChange`/`onClick`), never from inside a `useState` updater, so
 * React's development double-invocation of updaters cannot double-fire a
 * write. Nothing here reads a "previous" value from a ref for that reason --
 * the only functional state updates in this file
 * (`setPendingProfileId((cur) => ...)`) are idempotent no-ops when replayed,
 * not side effects.
 */

export interface SiteAccessPanelProps {
  /** The site node this screen is about, or `null` (accessPanelState -> "no-place"). */
  siteNodeId: string | null;
  /** Whether the hierarchy tree read (which `siteNodeId` is derived from) is still resolving. */
  treeLoading: boolean;
  /** `user_profiles.id` of whoever is looking at the screen, or `null` before the session resolves. */
  viewerProfileId: string | null;
  /** Org-wide `role === "admin"` -- reaches every plant with no grant at all. */
  viewerIsCompanyAdmin: boolean;
}

function labelFor(row: AccessRow): string {
  return row.email ?? "this person";
}

export function SiteAccessPanel({
  siteNodeId,
  treeLoading,
  viewerProfileId,
  viewerIsCompanyAdmin,
}: SiteAccessPanelProps) {
  // Gated on `!treeLoading` rather than a raw `true`: the query becomes
  // askable only once the hierarchy read (and therefore `siteNodeId`) has
  // settled. `useSitePeople` itself further gates on `nodeId !== null`, so a
  // resolved tree with no site for this structure still asks nothing.
  const peopleQuery = useSitePeople(siteNodeId, !treeLoading);
  const setMemberMutation = useSetSiteMember();
  const removeMemberMutation = useRemoveSiteMember();

  const [query, setQuery] = useState("");
  const [confirmingProfileId, setConfirmingProfileId] = useState<string | null>(null);
  const [pendingProfileId, setPendingProfileId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ profileId: string; message: string } | null>(null);
  const [addRoles, setAddRoles] = useState<Readonly<Record<string, GrantRole>>>({});

  const state = accessPanelState(
    treeLoading,
    siteNodeId,
    peopleQuery.isLoading,
    peopleQuery.isError,
  );

  function clearRowError(profileId: string) {
    setRowError((cur) => (cur !== null && cur.profileId === profileId ? null : cur));
  }

  function runSetMember(row: AccessRow, role: GrantRole) {
    if (siteNodeId === null) return;
    clearRowError(row.profileId);
    setPendingProfileId(row.profileId);
    setMemberMutation.mutate(
      { nodeId: siteNodeId, profileId: row.profileId, role },
      {
        onError: (err: SchedulerError) =>
          setRowError({ profileId: row.profileId, message: describeSchedulerError(err) }),
        onSettled: () =>
          setPendingProfileId((cur) => (cur === row.profileId ? null : cur)),
      },
    );
  }

  function runRemoveMember(row: AccessRow) {
    if (siteNodeId === null) return;
    clearRowError(row.profileId);
    setPendingProfileId(row.profileId);
    removeMemberMutation.mutate(
      { nodeId: siteNodeId, profileId: row.profileId },
      {
        onSuccess: () =>
          setConfirmingProfileId((cur) => (cur === row.profileId ? null : cur)),
        onError: (err: SchedulerError) =>
          setRowError({ profileId: row.profileId, message: describeSchedulerError(err) }),
        onSettled: () =>
          setPendingProfileId((cur) => (cur === row.profileId ? null : cur)),
      },
    );
  }

  if (state === "pending") {
    return <p className={styles.status}>Loading…</p>;
  }

  if (state === "no-place") {
    // 0021 §7 / brief §6's named limitation: a department admin administers
    // no structure (a structure is owned by a ROOT, migration 0020 §1), so
    // this is the honest sentence, not a spinner that never resolves.
    return (
      <p className={styles.status}>
        There&apos;s no plant here for you to manage access for.
      </p>
    );
  }

  if (state === "error") {
    return (
      <p className={styles.status} role="alert">
        {peopleQuery.error
          ? describeSchedulerError(peopleQuery.error)
          : "Couldn't load who has access."}
      </p>
    );
  }

  const view = buildAccessRows(peopleQuery.data, viewerProfileId);
  const { members, candidates } = partitionAccess(view.rows, query);

  // ⭐ FOUND BY LOOKING AT THE RENDER, NOT BY A TEST. `matchesQuery` drops a
  // person with no address on file from every non-empty search — correct, and
  // pinned by case A43: an address is the only thing that can be typed for, so
  // an address-less row appearing under arbitrary text would be worse. But on
  // screen those people simply VANISH with nothing said, which is the same
  // failure `skipped` is reported to avoid one line up. Counted and named.
  const hiddenNoAddress =
    query.trim() === "" ? 0 : view.rows.filter((r) => r.email === null).length;

  return (
    <section className={styles.card}>
      <h2 className={styles.h2}>Who can get in — {view.nodeName}</h2>

      <input
        type="search"
        aria-label="Search people by email address"
        className={styles.search}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by email"
      />

      {/* §6: `skipped > 0` is shown, never swallowed -- a silently shortened
          list is indistinguishable from a company with fewer people in it. */}
      {view.skipped > 0 && (
        <p className={styles.skippedLine}>
          {view.skipped} {view.skipped === 1 ? "entry" : "entries"} couldn&apos;t be read.
        </p>
      )}

      {hiddenNoAddress > 0 && (
        <p className={styles.skippedLine}>
          {hiddenNoAddress === 1
            ? "1 person has no address on file and can't be searched for."
            : `${hiddenNoAddress} people have no address on file and can't be searched for.`}
        </p>
      )}

      <h3 className={styles.h3}>Has access ({members.length})</h3>
      <ul className={styles.list}>
        {members.map((row) => {
          const label = labelFor(row);
          const isConfirming = confirmingProfileId === row.profileId;
          const isPending = pendingProfileId === row.profileId;
          const error =
            rowError !== null && rowError.profileId === row.profileId ? rowError.message : null;

          return (
            <li key={row.profileId} className={styles.row}>
              <span className={styles.email}>{row.email ?? "(no address on file)"}</span>
              <span className={styles.desc}>{describeAccess(row, view.nodeName)}</span>

              {isConfirming ? (
                <div className={styles.confirm}>
                  <span>Remove {label}&apos;s access?</span>
                  <button
                    type="button"
                    className={styles.dangerBtn}
                    disabled={isPending}
                    onClick={() => runRemoveMember(row)}
                  >
                    Remove
                  </button>
                  <button
                    type="button"
                    className={styles.cancelBtn}
                    disabled={isPending}
                    onClick={() => setConfirmingProfileId(null)}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  {row.directRole !== null && (
                    <select
                      aria-label={`Role for ${label}`}
                      className={styles.select}
                      value={row.directRole}
                      disabled={isPending}
                      onChange={(e) => runSetMember(row, e.target.value as GrantRole)}
                    >
                      {allowedRoles(row, viewerIsCompanyAdmin).map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  )}

                  {canRemoveAccess(row, viewerIsCompanyAdmin) ? (
                    <button
                      type="button"
                      aria-label={`Remove access for ${label}`}
                      className={styles.removeBtn}
                      disabled={isPending}
                      onClick={() => setConfirmingProfileId(row.profileId)}
                    >
                      Remove
                    </button>
                  ) : (
                    <span className={styles.note}>
                      {removalNote(row, viewerIsCompanyAdmin)}
                    </span>
                  )}
                </>
              )}

              {error && (
                <p className={styles.errorLine} role="alert">
                  {error}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      <h3 className={styles.h3}>Everyone else ({candidates.length})</h3>
      <ul className={styles.list}>
        {candidates.map((row) => {
          const label = labelFor(row);
          const isPending = pendingProfileId === row.profileId;
          const error =
            rowError !== null && rowError.profileId === row.profileId ? rowError.message : null;
          const selectedRole = addRoles[row.profileId] ?? "supervisor";

          return (
            <li key={row.profileId} className={styles.row}>
              <span className={styles.email}>{row.email ?? "(no address on file)"}</span>
              <select
                aria-label={`Role to give ${label}`}
                className={styles.select}
                value={selectedRole}
                disabled={isPending}
                onChange={(e) =>
                  setAddRoles((prev) => ({ ...prev, [row.profileId]: e.target.value as GrantRole }))
                }
              >
                {GRANT_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <button
                type="button"
                aria-label={`Give ${label} access`}
                className={styles.addBtn}
                disabled={isPending}
                onClick={() => runSetMember(row, selectedRole)}
              >
                Add
              </button>

              {error && (
                <p className={styles.errorLine} role="alert">
                  {error}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
