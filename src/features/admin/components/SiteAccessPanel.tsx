import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { describeSchedulerError, invite, type InviteResult, type SchedulerError } from "@/lib/api";
import {
  accessPanelState,
  buildAccessRows,
  canManageAccess,
  canRemoveAccess,
  canRemoveGrant,
  canSetRole,
  describeAccess,
  grantRoleOptions,
  moveTargets,
  partitionAccess,
  removalNote,
  removalReason,
  resolvePlace,
  rolesForNode,
  rowGrant,
  sortMembers,
  subtreeOptions,
  type AccessNode,
  type AccessPlace,
  type AccessRow,
  type GrantRole,
} from "../lib/siteAccess";
import {
  buildInviteBody,
  canOfferInvite,
  describeInviteRefusal,
  inviteRoles,
  inviteSuccessMessage,
  normaliseEmail,
  readInvitedPending,
} from "../lib/invite";
import {
  siteAccessKeys,
  useRemoveSiteMember,
  useSetSiteMember,
  useSitePeople,
} from "../hooks/useSiteAccess";
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
  /**
   * Every node the viewer may read (`data.nodes`, already filtered by
   * `nodes_select`), as `{ nodeId, name, path }`. The picker slices the plant's
   * subtree out of this by path prefix (`subtreeOptions`), so a person can be
   * assigned to a line or a cell, not only the plant root (R-367).
   */
  nodes: readonly AccessNode[];
  /** Whether the hierarchy tree read (which `siteNodeId` is derived from) is still resolving. */
  treeLoading: boolean;
  /** `user_profiles.id` of whoever is looking at the screen, or `null` before the session resolves. */
  viewerProfileId: string | null;
  /** Org-wide `role === "admin"` -- reaches every plant with no grant at all. */
  viewerIsCompanyAdmin: boolean;
  /**
   * `app_is_admin_anywhere()` (`profile.adminAnywhere`) -- true for a SITE
   * admin, the person who holds an admin grant on some plant root. With
   * `viewerIsCompanyAdmin` it decides `canManageAccess`: only these two may
   * pick or move a person's node (R-367), never a plain supervisor.
   */
  viewerAdminAnywhere: boolean;
}

function labelFor(row: AccessRow): string {
  return row.email ?? "this person";
}

export function SiteAccessPanel({
  places,
  nodes,
  treeLoading,
  viewerProfileId,
  viewerIsCompanyAdmin,
  viewerAdminAnywhere,
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
  // ⭐ AT A PLANT ROOT, OR SOMEWHERE INSIDE ONE (0053 / R-340). `places` is
  // filtered to plant roots by `AdminPage`, so the unfocused view IS the root
  // and a focus is always a descendant. Derived from the state that already
  // exists rather than re-read from the tree: a second source for "which node
  // am I showing" is the thing `activeNodeId` was written to prevent.
  const atPlantRoot = activeFocus === null;
  // The Add control no longer reads a single per-screen role list: with the
  // node picker (R-367) the roles follow the CHOSEN node via `rolesForNode`,
  // computed per candidate row below. `atPlantRoot` still governs the existing
  // per-row role menu (`allowedRoles`) and the invite menu.

  const peopleQuery = useSitePeople(activeNodeId, !treeLoading);
  const setMemberMutation = useSetSiteMember();
  const removeMemberMutation = useRemoveSiteMember();

  const [query, setQuery] = useState("");
  const [confirmingProfileId, setConfirmingProfileId] = useState<string | null>(null);
  const [pendingProfileId, setPendingProfileId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ profileId: string; message: string } | null>(null);
  const [addRoles, setAddRoles] = useState<Readonly<Record<string, GrantRole>>>({});
  // ⭐ WHICH NODE A NEW PERSON GOES ON (R-367). Keyed by profile, defaulted to
  // the node the screen is on (`activeNodeId`) when a row has no choice yet, so
  // the old behaviour — grant here — is the untouched default and the picker is
  // an addition, not a change of what a click does.
  const [addNodes, setAddNodes] = useState<Readonly<Record<string, string>>>({});

  // Only a system admin or a site admin may pick or move a person's node
  // (R-367, the maintainer's boundary). Everyone who reaches the ready branch
  // already administers this plant, so this is the explicit statement of that
  // — and the guard on the supervisor `adminAccess` (D114) lets in.
  const canManage = canManageAccess(viewerIsCompanyAdmin, viewerAdminAnywhere);

  // ⭐ INVITE (P1-6c). Offered only when a search by email matches NOBODY in the
  // company (see `canOfferInvite`); the role menu is the SAME one the Add
  // control uses, so the two never disagree about admin-only-at-a-root. The
  // mutation reaches the `invite` Edge Function, which authorises the grant AS
  // THE CALLER through `set_site_member` — the panel offers, the database
  // decides. Fired from a click handler, never a state updater (StrictMode §6).
  const queryClient = useQueryClient();
  const [inviteRole, setInviteRole] = useState<GrantRole>("supervisor");
  const [inviteNotice, setInviteNotice] = useState<{ tone: "ok" | "err"; message: string } | null>(
    null,
  );
  const inviteMutation = useMutation<
    InviteResult,
    SchedulerError,
    { email: string; nodeId: string; role: GrantRole }
  >({
    mutationFn: (vars) => invite(buildInviteBody(vars.email, vars.nodeId, vars.role)),
    onSuccess: (result, vars) => {
      if (result.ok) {
        setInviteNotice({ tone: "ok", message: inviteSuccessMessage(vars.email, result.invited) });
        // The new (or newly granted) member shows on the next read.
        void queryClient.invalidateQueries({ queryKey: siteAccessKeys.all });
      } else {
        setInviteNotice({
          tone: "err",
          message: describeInviteRefusal(result.reason) ?? describeSchedulerError(result.error),
        });
      }
    },
    // invite() returns a handled outcome and does not throw; this is the crash
    // path only.
    onError: (err) => setInviteNotice({ tone: "err", message: describeSchedulerError(err) }),
  });

  const state = accessPanelState(
    treeLoading,
    activeNodeId,
    peopleQuery.isLoading,
    peopleQuery.isError,
  );

  function clearRowError(profileId: string) {
    setRowError((cur) => (cur !== null && cur.profileId === profileId ? null : cur));
  }

  // ⭐ GRANT AT A NAMED NODE (R-367), not only at the node the screen is on.
  // `set_site_member` has always taken any node the caller administers; this is
  // the Add control finally naming one. The node comes from the plant subtree
  // picker, so it is always a node the viewer can read AND inside this plant.
  function runSetMemberAt(row: AccessRow, nodeId: string, role: GrantRole) {
    clearRowError(row.profileId);
    setPendingProfileId(row.profileId);
    setMemberMutation.mutate(
      { nodeId, profileId: row.profileId, role },
      {
        onError: (err: SchedulerError) =>
          setRowError({ profileId: row.profileId, message: describeSchedulerError(err) }),
        onSettled: () => setPendingProfileId((cur) => (cur === row.profileId ? null : cur)),
      },
    );
  }

  // ⭐ MOVE A GRANT TO A DIFFERENT NODE (R-367). There is no `move_site_member`
  // RPC, so this composes the two that exist: grant at the NEW node first, then
  // drop the OLD one. The order is deliberate and it is the safe direction —
  // if the second call fails the person keeps access at both nodes (an extra
  // grant, visible and removable), never NEITHER. The role is carried across
  // unchanged; `moveTargets` has already excluded any node where that role
  // would be refused (an admin below a plant root), so the new grant cannot be
  // the thing that fails.
  function runMove(row: AccessRow, fromNodeId: string, role: GrantRole, toNodeId: string) {
    if (toNodeId === fromNodeId) return;
    clearRowError(row.profileId);
    setPendingProfileId(row.profileId);
    setMemberMutation.mutate(
      { nodeId: toNodeId, profileId: row.profileId, role },
      {
        onSuccess: () =>
          removeMemberMutation.mutate(
            { nodeId: fromNodeId, profileId: row.profileId },
            {
              onError: (err: SchedulerError) =>
                setRowError({
                  profileId: row.profileId,
                  message: `Moved, but couldn't remove the old place: ${describeSchedulerError(err)}`,
                }),
              onSettled: () => setPendingProfileId((cur) => (cur === row.profileId ? null : cur)),
            },
          ),
        onError: (err: SchedulerError) => {
          setRowError({ profileId: row.profileId, message: describeSchedulerError(err) });
          setPendingProfileId((cur) => (cur === row.profileId ? null : cur));
        },
      },
    );
  }

  // Removes the resolved grant's node (R-368), not only the viewed node: a
  // person whose single grant sits on a line is revoked from that line in
  // place, without opening it first.
  function runRemoveMember(row: AccessRow, nodeId: string) {
    clearRowError(row.profileId);
    setPendingProfileId(row.profileId);
    removeMemberMutation.mutate(
      { nodeId, profileId: row.profileId },
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
  const { members: unsortedMembers, candidates } = partitionAccess(view.rows, query);
  // R-369: highest access tier first, then email A–Z within the tier.
  const members = sortMembers(unsortedMembers);

  // ⭐ THE PLANT'S SUBTREE, for the Add picker and the Move control (R-367).
  // Sliced from `siteNodeId` (the plant root) rather than `activeNodeId`, so a
  // person can be placed or moved anywhere in the plant even while the screen
  // is focused on one branch of it. Empty for a viewer whose `nodes` did not
  // arrive, which the controls below treat as "no picker, grant here" — the
  // old behaviour, never a broken control.
  const plantSubtree = subtreeOptions(nodes, siteNodeId);
  const canPickNode = canManage && plantSubtree.length > 1;

  function nodeOptionLabel(depth: number, name: string): string {
    // A leading figure space per level of depth, so the tree reads as a tree
    // in a plain <option> (which cannot carry padding). U+2007 keeps its width.
    return `${"  ".repeat(depth)}${name}`;
  }

  // "Invited, not yet signed in" (0064). Read from the raw payload as an overlay
  // rather than folded into every AccessRow — see `invite.ts::readInvitedPending`.
  const invitedPending = readInvitedPending(peopleQuery.data);

  // Offer an invite only when a search by email matches nobody already in the
  // company. `activeNodeId` is non-null in the `ready` branch (the panel is
  // scoped to a place the viewer administers), which is exactly `canGrantHere`.
  const offerInvite =
    activeNodeId !== null &&
    canOfferInvite({
      query,
      memberMatches: members.length,
      candidateMatches: candidates.length,
      canGrantHere: true,
    });

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

      {/* ⭐ ADD-ABOVE-MEMBERS (R-369). The "Add someone" results and the invite
          used to sit at the BOTTOM, under every member — with a hundred people
          on the list nobody scrolled to reach them, and adding is driven from
          the search box at the TOP anyway. So the two blocks are ordered by
          flex: the add block (only rendered while a search is running) comes
          first, right under the search; the standing member list follows.
          The DOM keeps the member list first for a screen reader; `order`
          moves only the paint. */}
      <div className={styles.lists}>
        <div className={styles.membersBlock}>
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
          {/* ⭐ ACCESS LEVEL AND PLACE ARE EACH THEIR OWN COLUMN (R-368). The role
          used to be the only control on the row and only when the grant sat on
          the viewed node; a person granted a LINE (Ana) showed no control at
          all, just a link to open that line. Now `rowGrant` resolves the one
          grant the row edits — direct, or a single one below — and the role and
          the node sit on the row, editable in place. */}
          <div className={styles.head} aria-hidden="true" hidden={members.length === 0}>
            <span>Person</span>
            <span>Access level</span>
            <span>Place</span>
            <span />
          </div>
          <ul className={styles.list}>
            {members.map((row) => {
              const label = labelFor(row);
              const isConfirming = confirmingProfileId === row.profileId;
              const isPending = pendingProfileId === row.profileId;
              const error =
                rowError !== null && rowError.profileId === row.profileId ? rowError.message : null;
              // ⭐ THE ONE GRANT THIS ROW EDITS (R-368): the grant on the viewed
              // node, or a lone grant below it. `null` when there is nothing to
              // edit here (no grant) or too many below to pick without opening one.
              const g = rowGrant(row, activeNodeId);
              const editable = canManage && g !== null && canSetRole(row, viewerIsCompanyAdmin);
              const placeOpts =
                editable && g !== null ? moveTargets(nodes, siteNodeId, g.role) : [];
              const placeName =
                g === null
                  ? ""
                  : g.direct
                    ? (view.nodeName ?? "this plant")
                    : (row.inheritedGrants[0]?.nodeName ?? "");

              return (
                <li key={row.profileId} className={styles.row}>
                  <span className={styles.email}>
                    {row.email ?? "(no address on file)"}
                    {invitedPending.has(row.profileId) && (
                      <span className={styles.invitedTag} title="Invited — hasn't signed in yet">
                        invited
                      </span>
                    )}
                  </span>

                  {isConfirming ? (
                    <div className={styles.confirm}>
                      <span>Remove {label}&apos;s access?</span>
                      <button
                        type="button"
                        className={styles.dangerBtn}
                        disabled={isPending}
                        onClick={() => g !== null && runRemoveMember(row, g.nodeId)}
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
                  ) : editable && g !== null ? (
                    <>
                      {/* Access level — the grant's OWN node decides the menu, so an
                      inherited supervisor on a line is offered supervisor and
                      viewer, an admin on the root all three, and the self-rule
                      still forbids stripping your own admin. */}
                      <select
                        aria-label={`Access level for ${label}`}
                        className={`${styles.select} ${styles.roleCol}`}
                        value={g.role}
                        disabled={isPending}
                        onChange={(e) => runSetMemberAt(row, g.nodeId, e.target.value as GrantRole)}
                      >
                        {grantRoleOptions(row, viewerIsCompanyAdmin, g, siteNodeId).map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>

                      {/* Place — a picker when there is somewhere else in the plant
                      to move the grant to, the node's name in plain text when
                      there is not (an admin, who fits only the plant root). */}
                      {placeOpts.length > 1 ? (
                        <select
                          aria-label={`Place for ${label}`}
                          className={`${styles.select} ${styles.placeCol}`}
                          value={g.nodeId}
                          disabled={isPending}
                          onChange={(e) => runMove(row, g.nodeId, g.role, e.target.value)}
                        >
                          {placeOpts.map((o) => (
                            <option key={o.nodeId} value={o.nodeId}>
                              {nodeOptionLabel(o.depth, o.name)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className={styles.placeText}>{placeName}</span>
                      )}

                      {canRemoveGrant(row, viewerIsCompanyAdmin, g) ? (
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
                  ) : (
                    <>
                      {/* Not editable from here: a company admin's row (0022), a
                      viewer without the rights, or somebody with MORE than one
                      grant below the plant — the A5 case, where which grant to
                      change is genuinely ambiguous and opening the node is the
                      honest way to pick one. */}
                      <span className={styles.descWide}>{describeAccess(row, view.nodeName)}</span>

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
                          {/* Switching on the REASON, not the sentence, so the two
                          cannot drift — case D6. For a multi-grant person each
                          node is a way in to change that one grant. */}
                          {removalReason(row, viewerIsCompanyAdmin) === "inherited" &&
                            row.inheritedGrants.map((gr) => (
                              <button
                                key={gr.nodeId}
                                type="button"
                                className={styles.linkBtn}
                                aria-label={`Open ${gr.nodeName} to change access for ${label}`}
                                onClick={() =>
                                  siteNodeId !== null &&
                                  setFocus({
                                    root: siteNodeId,
                                    rootName: view.nodeName ?? "the plant",
                                    nodeId: gr.nodeId,
                                  })
                                }
                              >
                                {gr.nodeName}
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
        </div>

        {/* ⭐ ADDING IS AN ACTION, NOT A STANDING LIST (R-368), AND NOT ONE AT
            THE BOTTOM (R-369). Rendered only while a search is running — the
            search box above IS the way in, so an empty "Add someone" section
            standing under the member list was dead weight a hundred rows down.
            When it renders it is `order`ed above the member list, right under
            the search. */}
        {query.trim() !== "" && (
          <div className={styles.addBlock}>
            <h3 className={styles.h3}>Add someone</h3>
            {candidates.length === 0 && !offerInvite && (
              <p className={styles.skippedLine}>
                Nobody else in the company matches “{query.trim()}”.
              </p>
            )}
            <div className={styles.head} aria-hidden="true" hidden={candidates.length === 0}>
              <span>Person</span>
              <span>Access level</span>
              <span>Place</span>
              <span />
            </div>
            <ul className={styles.list}>
              {candidates.map((row) => {
                const label = labelFor(row);
                const isPending = pendingProfileId === row.profileId;
                const error =
                  rowError !== null && rowError.profileId === row.profileId
                    ? rowError.message
                    : null;
                // ⭐ WHICH NODE, WHICH ROLE (R-367). The node defaults to the one the
                // screen is on; the role list follows the CHOSEN node, so `admin`
                // disappears the moment a line is picked and reappears at the root —
                // the same rule `allowedRoles` and migration 0053 enforce. A role
                // that was legal at the old node but not the new one is coerced to
                // the first legal one rather than left selected-but-refused.
                const selectedNode = canPickNode
                  ? (addNodes[row.profileId] ?? activeNodeId ?? "")
                  : (activeNodeId ?? "");
                const nodeRoles = rolesForNode(
                  selectedNode === "" ? null : selectedNode,
                  siteNodeId,
                );
                const wanted = addRoles[row.profileId] ?? "supervisor";
                const selectedRole = nodeRoles.includes(wanted) ? wanted : nodeRoles[0];

                return (
                  <li key={row.profileId} className={styles.row}>
                    <span className={styles.email}>{row.email ?? "(no address on file)"}</span>

                    {/* Access level (col 2) — the roles `rolesForNode` allows on the
                  CHOSEN node, not `GRANT_ROLES`: two controls on one screen
                  disagreeing about admin-only-at-a-root is how DEF-0010 got
                  here. Below a plant root this is supervisor and viewer. */}
                    <select
                      aria-label={`Role to give ${label}`}
                      className={`${styles.select} ${styles.roleCol}`}
                      value={selectedRole}
                      disabled={isPending}
                      onChange={(e) =>
                        setAddRoles((prev) => ({
                          ...prev,
                          [row.profileId]: e.target.value as GrantRole,
                        }))
                      }
                    >
                      {nodeRoles.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>

                    {/* Place (col 3, R-367/R-368) — the node picker sits in its own
                  column like the members' does, an admin naming a line or cell.
                  A single-node plant, or a non-admin, gets the plant name in
                  plain text so the column is not a hole. */}
                    {canPickNode ? (
                      <select
                        aria-label={`Place to give ${label} access`}
                        className={`${styles.select} ${styles.placeCol}`}
                        value={selectedNode}
                        disabled={isPending}
                        onChange={(e) =>
                          setAddNodes((prev) => ({ ...prev, [row.profileId]: e.target.value }))
                        }
                      >
                        {plantSubtree.map((o) => (
                          <option key={o.nodeId} value={o.nodeId}>
                            {nodeOptionLabel(o.depth, o.name)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className={styles.placeText}>{view.nodeName ?? "this plant"}</span>
                    )}

                    <button
                      type="button"
                      aria-label={`Give ${label} access`}
                      className={styles.addBtn}
                      disabled={isPending}
                      onClick={() =>
                        selectedNode !== "" && runSetMemberAt(row, selectedNode, selectedRole)
                      }
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

            {/* ⭐ INVITE — offered only when the email search matched nobody already
          in the company. The role menu is `inviteRoles(atPlantRoot)`, the same
          list the Add control uses, so a person invited below a plant root can
          only be a supervisor or viewer, exactly as the server will allow. */}
            {offerInvite && activeNodeId !== null && (
              <div className={styles.inviteBox}>
                <p className={styles.inviteLead}>
                  Nobody in the company matches “{query.trim()}”. Invite them to{" "}
                  {view.nodeName ?? "this place"}?
                </p>
                <div className={styles.inviteRow}>
                  <span className={styles.inviteEmail}>{normaliseEmail(query)}</span>
                  <select
                    aria-label="Role to invite as"
                    className={styles.select}
                    value={inviteRole}
                    disabled={inviteMutation.isPending}
                    onChange={(e) => setInviteRole(e.target.value as GrantRole)}
                  >
                    {inviteRoles(atPlantRoot).map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={styles.inviteBtn}
                    disabled={inviteMutation.isPending}
                    onClick={() => {
                      setInviteNotice(null);
                      inviteMutation.mutate({
                        email: normaliseEmail(query),
                        nodeId: activeNodeId,
                        role: inviteRole,
                      });
                    }}
                  >
                    {inviteMutation.isPending ? "Inviting…" : `Invite as ${inviteRole}`}
                  </button>
                </div>
                {inviteNotice && (
                  <p
                    className={inviteNotice.tone === "ok" ? styles.inviteOk : styles.errorLine}
                    role={inviteNotice.tone === "ok" ? "status" : "alert"}
                  >
                    {inviteNotice.message}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
