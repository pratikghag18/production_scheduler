import { useState } from "react";
import { describeSchedulerError, type SchedulerError } from "@/lib/api";
import {
  accessPanelState,
  allowedRoles,
  buildAccessRows,
  canRemoveAccess,
  canSetRole,
  describeAccess,
  GRANT_ROLES,
  partitionAccess,
  removalNote,
  removalReason,
  resolvePlace,
  type AccessPlace,
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
  /**
   * The places this person may manage access for — one per structure they may
   * edit. Empty means there is none, which `accessPanelState` turns into
   * `"no-place"`.
   *
   * ⭐ THE PANEL OWNS ITS OWN SELECTION, and it did not before. It was scoped
   * by the structure picker on the HIERARCHY tab, so a company admin standing
   * here was shown whichever plant that other tab had selected, with no
   * control and nothing explaining why. "Where is Plant 1?" — reported from
   * the running app, and there was no answer on the screen.
   */
  places: readonly AccessPlace[];
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
  places,
  treeLoading,
  viewerProfileId,
  viewerIsCompanyAdmin,
}: SiteAccessPanelProps) {
  // Gated on `!treeLoading` rather than a raw `true`: the query becomes
  // askable only once the hierarchy read (and therefore `siteNodeId`) has
  // settled. `useSitePeople` itself further gates on `nodeId !== null`, so a
  // resolved tree with no site for this structure still asks nothing.
  // ⭐ THE PANEL CAN FOLLOW A GRANT DOWN, AND THAT IS NOT A CONVENIENCE.
  // Only the grant sitting on the node being shown is editable here, so
  // somebody whose access sits on a department inside the plant is read-only
  // from the plant's view — with a note that used to say "open that place to
  // change it" and no way to open it. The maintainer hit that within minutes of the
  // screen going up. `site_people` already accepts any node the caller
  // administers, so following the grant is the whole fix.
  //
  // Held with the root it was opened FROM, so switching structures makes it
  // stale by comparison rather than needing an effect to clear it — one less
  // thing for StrictMode's double-invocation to fire twice.
  const [placeId, setPlaceId] = useState<string | null>(null);
  const siteNodeId = resolvePlace(places, placeId);

  const [focus, setFocus] = useState<{ root: string; rootName: string; nodeId: string } | null>(
    null,
  );
  const activeFocus = focus !== null && focus.root === siteNodeId ? focus : null;
  const activeNodeId = activeFocus?.nodeId ?? siteNodeId;

  const peopleQuery = useSitePeople(activeNodeId, !treeLoading);
  const setMemberMutation = useSetSiteMember();
  const removeMemberMutation = useRemoveSiteMember();

  const [query, setQuery] = useState("");
  const [confirmingProfileId, setConfirmingProfileId] = useState<string | null>(null);
  const [pendingProfileId, setPendingProfileId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ profileId: string; message: string } | null>(null);
  const [addRoles, setAddRoles] = useState<Readonly<Record<string, GrantRole>>>({});

  const state = accessPanelState(
    treeLoading,
    activeNodeId,
    peopleQuery.isLoading,
    peopleQuery.isError,
  );

  function clearRowError(profileId: string) {
    setRowError((cur) => (cur !== null && cur.profileId === profileId ? null : cur));
  }

  function runSetMember(row: AccessRow, role: GrantRole) {
    if (activeNodeId === null) return;
    clearRowError(row.profileId);
    setPendingProfileId(row.profileId);
    setMemberMutation.mutate(
      { nodeId: activeNodeId, profileId: row.profileId, role },
      {
        onError: (err: SchedulerError) =>
          setRowError({ profileId: row.profileId, message: describeSchedulerError(err) }),
        onSettled: () => setPendingProfileId((cur) => (cur === row.profileId ? null : cur)),
      },
    );
  }

  function runRemoveMember(row: AccessRow) {
    if (activeNodeId === null) return;
    clearRowError(row.profileId);
    setPendingProfileId(row.profileId);
    removeMemberMutation.mutate(
      { nodeId: activeNodeId, profileId: row.profileId },
      {
        onSuccess: () => setConfirmingProfileId((cur) => (cur === row.profileId ? null : cur)),
        onError: (err: SchedulerError) =>
          setRowError({ profileId: row.profileId, message: describeSchedulerError(err) }),
        onSettled: () => setPendingProfileId((cur) => (cur === row.profileId ? null : cur)),
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
      <p className={styles.status}>There&apos;s no plant here for you to manage access for.</p>
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

      {/* Only when there is a choice to make. A site admin administers one
          plant, and a one-item dropdown is a control that answers nothing. */}
      {places.length > 1 && activeFocus === null && (
        <label className={styles.placeRow}>
          <span className={styles.placeLabel}>Plant</span>
          <select
            className={styles.placeSelect}
            value={siteNodeId ?? ""}
            onChange={(e) => {
              setPlaceId(e.target.value);
              setConfirmingProfileId(null);
              setRowError(null);
            }}
          >
            {places.map((p) => (
              <option key={p.nodeId} value={p.nodeId}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {activeFocus !== null && (
        <button type="button" className={styles.backBtn} onClick={() => setFocus(null)}>
          ← Back to {activeFocus.rootName}
        </button>
      )}

      <input
        type="search"
        aria-label="Find someone here, or search the company by email address to add them"
        className={styles.search}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Find someone here, or search to add"
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
      {/* The header carries the same grid template as every row, so the
          columns are labelled AND aligned by construction. `aria-hidden`
          because each control already names itself and its row — a screen
          reader reading "Person" before every address would be noise. */}
      {/* A column header with nothing under it is a table pretending to have
          rows. Same treatment as the Add-someone header below. */}
      {members.length === 0 && (
        <p className={styles.skippedLine}>
          {query.trim() === ""
            ? `Nobody has access to ${view.nodeName ?? "this place"} yet.`
            : `Nobody with access here matches “${query.trim()}”.`}
        </p>
      )}
      <div className={styles.head} aria-hidden="true" hidden={members.length === 0}>
        <span>Person</span>
        <span>Access here</span>
        <span>Role</span>
        <span />
      </div>
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
                  {/* 0022: a company admin's row is not a site admin's to
                      edit, and the SERVER refuses it — this mirrors that
                      rather than leading it. `canSetRole` is separate from
                      `allowedRoles` on purpose: one decides whether the
                      control belongs on the row at all, the other narrows
                      which options it offers. */}
                  {row.directRole !== null && canSetRole(row, viewerIsCompanyAdmin) && (
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
                      {/* The one reason that needs a way in rather than
                          prose. Switching on the REASON, not on the sentence,
                          so the two cannot drift — case D6. */}
                      {removalReason(row, viewerIsCompanyAdmin) === "inherited" &&
                        row.inheritedGrants.map((g) => (
                          <button
                            key={g.nodeId}
                            type="button"
                            className={styles.linkBtn}
                            aria-label={`Open ${g.nodeName} to change access for ${label}`}
                            onClick={() =>
                              siteNodeId !== null &&
                              setFocus({
                                root: siteNodeId,
                                rootName: view.nodeName ?? "the plant",
                                nodeId: g.nodeId,
                              })
                            }
                          >
                            {g.nodeName}
                          </button>
                        ))}
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

      {/* ⭐ ADDING IS AN ACTION, NOT A STANDING LIST. Everyone in the company
          used to sit here permanently, under the people who actually have
          access — which asserts a relationship that does not exist and, in a
          real company, buries the member list under hundreds of strangers.
          `partitionAccess` returns candidates only for a non-blank search, so
          this section is empty until somebody goes looking. */}
      <h3 className={styles.h3}>Add someone</h3>
      {query.trim() === "" ? (
        <p className={styles.skippedLine}>
          Search above by email address to give someone access to {view.nodeName}.
        </p>
      ) : candidates.length === 0 ? (
        <p className={styles.skippedLine}>Nobody else in the company matches “{query.trim()}”.</p>
      ) : null}
      <div className={styles.head} aria-hidden="true" hidden={candidates.length === 0}>
        <span>Person</span>
        <span>Access here</span>
        <span>Role to give</span>
        <span />
      </div>
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
              {/* Rendered for candidates too — it reads "No access", which is
                  true and keeps column 2 from being a hole that makes the two
                  lists look like different tables. */}
              <span className={styles.desc}>{describeAccess(row, view.nodeName)}</span>
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
