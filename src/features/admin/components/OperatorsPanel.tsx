/* ---------------------------------------------------------------------------
   Operators — PRE-SEATED PLACEHOLDER (§19.62).

   This file exists before the section is built, and that is the whole point.
   Four admin sections are queued and every one of them would otherwise edit the
   same five shared files: `AdminPage.tsx`'s `SECTIONS` array AND its JSX child
   list, `REM_SURFACES`, R10's hardcoded copy of that list, and
   `src/lib/api/index.ts`. Measured across four concurrent surveys (§19.57):
   the collisions are all mechanical and all knowable in advance. So they are
   made ONCE, here, and after this commit each section's lane creates and edits
   only its own files.

   ⭐ `OPERATORS_PANEL_READY` LIVES HERE, NOT IN `AdminPage.tsx`. The nav entry
   reads it, so turning this section on is a one-line edit to THIS file — the
   lane that builds the panel is the lane that flips it, and a section cannot be
   switched on without a panel behind it because the switch is part of the
   panel. Group H in `scaleAudit.test.ts` asserts the other half: every id in
   `SECTIONS` has a branch rendering it.
   --------------------------------------------------------------------------- */
import { useMemo, useState } from "react";
import { canQueryAsUser } from "@/features/auth/session";
import { useSession } from "@/features/auth/useSession";
import { describeSchedulerError, type SchedulerError } from "@/lib/api";
import {
  deletePrecheck,
  describeSkillNameClash,
  findExistingSkillByName,
  formatDay,
  operatorRows,
  summarisePlaces,
  ticketsFor,
  validateOperatorDraft,
  workPlacesFor,
  type OperatorLike,
  type WorkPlace,
} from "../lib/operators";
import { indentedLabel, scopeOptions } from "../lib/scope";
import {
  useCreateOperator,
  useCreateSkill,
  useDeleteOperator,
  useDeleteSkill,
  useGrantSkill,
  useOperatorsAdmin,
  useRenameSkill,
  useRevokeSkill,
  useSetOperatorActive,
  useUpdateOperator,
  useUpdateSkillExpiry,
} from "../hooks/useOperators";
import styles from "./OperatorsPanel.module.css";

/**
 * ⭐ THE SHAPE OF THIS SCREEN, IN THE USER'S OWN WORDS:
 *
 *     "The essence of this is simply: is the operator trained to work in this
 *      particular work cell — a simple yes/no."
 *
 * So this panel LEADS WITH WHERE A PERSON CAN WORK. Pick somebody; see the
 * schedulable places, each with a tick, or a cross and the reason for it
 * ("missing Forklift", "Welding expires 3 Sep 2026"). Tickets are the second
 * section, not the first, because they are how you CHANGE that answer rather
 * than the vocabulary the screen speaks — granting one turns several crosses
 * green at once, and nobody has to touch a cell to do it.
 *
 * ⚠️ EVERY TICK IS AN INDICATION, NOT A PROMISE. `check_eligibility` on the
 * server is the authority and is re-asked at assignment time against the real
 * shift window; `../lib/operators` is a mirror of it and its header says so at
 * length. That is why the date control at the top of the list is worded as a
 * question about a window ("qualified for work booked up to"), and why a place
 * this screen cannot resolve shows a CROSS with an honest reason rather than a
 * tick it has not earned.
 *
 * NO PROPS, deliberately: the section is reached from `AdminPage`'s rail and
 * owns its own read, its own gating (`canQueryAsUser`) and its own selection.
 * `useOperatorsAdmin` fetches everything it needs — including `nodes` and
 * `hierarchy_levels`, because "where can this person work" is half made of the
 * tree — in ONE round trip, so there is exactly one loading state to fold in.
 *
 * StrictMode: every mutation fires from an event handler, never from inside a
 * `useState` updater, so React's development double-invocation of updaters
 * cannot double-fire a write.
 *
 * NO OPTIMISTIC UPDATES anywhere in here: the hooks invalidate and the refetch
 * redraws. See `useOperators.ts` for why that matters more on this screen than
 * on most.
 */

/** Flip to `true` in the same commit that gives this panel a real body. */
export const OPERATORS_PANEL_READY = true;

/**
 * Today, as a `YYYY-MM-DD` LOCAL day.
 *
 * Not `toISOString().slice(0, 10)`, which is the UTC day and is a day out for
 * anybody west of Greenwich for part of every evening. `expires_at` is a
 * Postgres `date` with no timezone at all, so the honest comparison is against
 * the day the person at the screen is actually having.
 */
function todayIso(): string {
  const now = new Date();
  const mm = `${now.getMonth() + 1}`.padStart(2, "0");
  const dd = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${mm}-${dd}`;
}

function PlaceRow({ place }: { place: WorkPlace }) {
  return (
    <li className={place.eligible ? styles.placeYes : styles.placeNo}>
      <span className={styles.mark} aria-hidden="true">
        {place.eligible ? "✓" : "✕"}
      </span>
      <span className={styles.placeLabel}>
        {place.label}
        {!place.active && <span className={styles.badge}>inactive place</span>}
      </span>
      <span className={styles.placeWhy}>
        {place.eligible ? (
          <span className={styles.srHint}>can work here</span>
        ) : (
          place.reasons.join(" · ")
        )}
      </span>
    </li>
  );
}

export function OperatorsPanel() {
  const { session, profile, loading: sessionLoading } = useSession();
  const canQuery = canQueryAsUser(session?.user.id ?? null, sessionLoading);
  const orgId = profile?.orgId ?? null;

  const { data, isLoading, isError } = useOperatorsAdmin(canQuery);
  // `!canQuery || isLoading` — NOT `isLoading` alone. D91: `enabled: false`
  // leaves `isLoading` FALSE, so gating on it alone renders an empty company
  // as though it were the answer.
  const loading = !canQuery || isLoading;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [asOf, setAsOf] = useState<string>(todayIso);
  const [notice, setNotice] = useState<string | null>(null);

  const [draftName, setDraftName] = useState("");
  const [draftRef, setDraftRef] = useState("");
  const [draftSite, setDraftSite] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [editName, setEditName] = useState("");
  const [editRef, setEditRef] = useState("");
  const [editSite, setEditSite] = useState<string>("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [grantId, setGrantId] = useState("");
  const [grantExpiry, setGrantExpiry] = useState("");
  const [newSkill, setNewSkill] = useState("");
  const [skillEditId, setSkillEditId] = useState<string | null>(null);
  const [skillEditName, setSkillEditName] = useState("");
  const [showSkillAdmin, setShowSkillAdmin] = useState(false);

  const createOperator = useCreateOperator();
  const updateOperator = useUpdateOperator();
  const setActive = useSetOperatorActive();
  const deleteOperator = useDeleteOperator();
  const createSkill = useCreateSkill();
  const renameSkill = useRenameSkill();
  const deleteSkill = useDeleteSkill();
  const grantSkill = useGrantSkill();
  const updateExpiry = useUpdateSkillExpiry();
  const revokeSkill = useRevokeSkill();

  // ⚠️ MEMOISED, not inlined `?? []`. A fresh `[]` on every render is a new
  // identity, so every `useMemo` below it recomputes every time and the
  // dependency lint says so. `data` itself is stable between refetches.
  const operators = useMemo<readonly OperatorLike[]>(() => data?.operators ?? [], [data]);
  const skills = useMemo(() => data?.skills ?? [], [data]);
  const operatorSkills = useMemo(() => data?.operatorSkills ?? [], [data]);

  const rows = useMemo(
    () => operatorRows(operators, operatorSkills, { query, includeInactive }),
    [operators, operatorSkills, query, includeInactive],
  );
  const selected = operators.find((o) => o.id === selectedId) ?? null;

  const places = useMemo(() => {
    if (selected === null || data === undefined) return [];
    return workPlacesFor(
      selected,
      {
        nodes: data.nodes,
        levels: data.levels,
        requirements: data.requirements,
        skills: data.skills,
        operatorSkills: data.operatorSkills,
      },
      asOf,
    );
  }, [selected, data, asOf]);

  // The headline counts the places the LIST ACTUALLY SHOWS. Summarising all of
  // `places` put "2 of 6 places" above five rows whenever a place was
  // deactivated — the reader has no way to reconcile the two numbers, and the
  // hidden ones are already accounted for by the footnote below.
  const visiblePlaces = places.filter((p) => p.active);
  const summary = summarisePlaces(visiblePlaces);
  const hiddenPlaces = places.length - visiblePlaces.length;

  const tickets = selected === null ? [] : ticketsFor(selected, skills, operatorSkills, asOf);
  const heldIds = new Set(tickets.map((t) => t.skillId));
  const grantable = skills.filter((s) => !heldIds.has(s.id));

  // ⭐ EVERY NODE, NOT JUST ROOTS (0025 / D103). Pratik, Aug 27: *"I do want to
  // be able to assign operators to a specific hierarchy level, there are
  // facilities where certain people can only work in certain areas."* Until
  // 0025 `operators_check_site` refused anything but a root, so this filtered
  // to `parentId === null`.
  //
  // ⚠️ IN THIS RELEASE THE AREA IS PRESENTATION ONLY — it says where a person
  // belongs and filters the roster; it does NOT refuse an assignment. Refusing
  // one, with a supervisor override that records a reason, is his call of the
  // same day and is a change to `check_eligibility` and `assign_operator` in
  // its own migration. Until that lands, nothing here may imply the server is
  // enforcing it.
  const scopeNodes = data?.nodes ?? [];
  const scopeChoices = scopeOptions(scopeNodes);

  const clash = findExistingSkillByName(skills, newSkill);
  const deleteCheck = selected === null ? null : deletePrecheck(selected, operatorSkills);
  const busy =
    createOperator.isPending ||
    updateOperator.isPending ||
    setActive.isPending ||
    deleteOperator.isPending ||
    createSkill.isPending ||
    renameSkill.isPending ||
    deleteSkill.isPending ||
    grantSkill.isPending ||
    updateExpiry.isPending ||
    revokeSkill.isPending;

  function onErr(err: SchedulerError) {
    setNotice(describeSchedulerError(err));
  }

  function addOperator() {
    setNotice(null);
    if (orgId === null) {
      setNotice("Your profile hasn't loaded yet — try again in a moment.");
      return;
    }
    const draft = validateOperatorDraft({ displayName: draftName, employeeRef: draftRef }, operators);
    if (!draft.ok) {
      setNotice(draft.message);
      return;
    }
    createOperator.mutate(
      {
        orgId,
        displayName: draft.displayName,
        employeeRef: draft.employeeRef,
        siteNodeId: draftSite === "" ? null : draftSite,
      },
      {
        onSuccess: (created) => {
          setDraftName("");
          setDraftRef("");
          setSelectedId(created.id);
          if (draft.duplicateNameOf !== null) {
            // A WARNING after the fact, not a refusal before it: `operators`
            // has no unique constraint on `display_name`, and two people
            // really can share one.
            setNotice(`Added. Note there was already somebody called ${draft.displayName}.`);
          }
        },
        onError: onErr,
      },
    );
  }

  function saveRename() {
    if (selected === null) return;
    setNotice(null);
    const draft = validateOperatorDraft(
      { displayName: editName, employeeRef: editRef },
      operators,
      selected.id,
    );
    if (!draft.ok) {
      setNotice(draft.message);
      return;
    }
    // ⭐ THE AREA IS PART OF THE EDIT NOW, and it is the third time Pratik has
    // had to ask. People move between areas — that is the whole reason an area
    // is worth recording — and until this line the picker existed only on the
    // "Add someone" form, so where somebody belonged was frozen at the moment
    // they were created. **The edit path is the other half of the create path,
    // not a smaller version of it.**
    updateOperator.mutate(
      {
        id: selected.id,
        displayName: draft.displayName,
        employeeRef: draft.employeeRef,
        siteNodeId: editSite === "" ? null : editSite,
      },
      { onSuccess: () => setRenaming(false), onError: onErr },
    );
  }

  function removeOperator() {
    if (selected === null || deleteCheck === null) return;
    setNotice(null);
    if (!deleteCheck.allowed) {
      setNotice(deleteCheck.blockedBy);
      return;
    }
    deleteOperator.mutate(
      { id: selected.id },
      {
        onSuccess: () => {
          setConfirmDelete(false);
          setSelectedId(null);
        },
        // `{kind:"StillInUse", usedBy}` arrives here for anybody who has ever
        // been scheduled — `assignments` is not read by this screen, so the
        // precheck above could not have known. The message names the table.
        onError: (err) => {
          setConfirmDelete(false);
          onErr(err);
        },
      },
    );
  }

  function attachSkill(skillId: string, expiresAt: string | null) {
    if (selected === null) return;
    setNotice(null);
    if (orgId === null) {
      setNotice("Your profile hasn't loaded yet — try again in a moment.");
      return;
    }
    grantSkill.mutate(
      { orgId, operatorId: selected.id, skillId, expiresAt },
      {
        onSuccess: () => {
          setGrantId("");
          setGrantExpiry("");
          setNewSkill("");
        },
        onError: onErr,
      },
    );
  }

  function createAndAttach() {
    setNotice(null);
    if (orgId === null) {
      setNotice("Your profile hasn't loaded yet — try again in a moment.");
      return;
    }
    const name = newSkill.trim();
    if (name === "") return;
    // ⭐ THE CLASH IS NOT AN ERROR (Pratik's decision: skill names stay
    // company-wide). An exact clash never reaches the database at all — the
    // screen offers the existing ticket instead, one click away, above.
    if (clash !== null && clash.exact) {
      setNotice(describeSkillNameClash(clash));
      return;
    }
    // `site_node_id: null` — company-wide, by that same decision. A site admin
    // is refused here by `skills_insert`, and that refusal is honest: they may
    // still ATTACH any company-wide ticket to their own people, because
    // `operator_skills` follows the OPERATOR, not the skill.
    createSkill.mutate(
      { orgId, name, siteNodeId: null },
      {
        onSuccess: (skill) => attachSkill(skill.id, grantExpiry === "" ? null : grantExpiry),
        // The race: somebody else created it between the check and the insert.
        onError: (err) =>
          setNotice(
            err.kind === "DuplicateValue"
              ? `Somebody just created ${name}. Reopen this person to attach it.`
              : describeSchedulerError(err),
          ),
      },
    );
  }

  if (loading) {
    return (
      <div className={styles.panel}>
        <p className={styles.status}>Loading…</p>
      </div>
    );
  }
  if (isError || data === undefined) {
    return (
      <div className={styles.panel}>
        <p className={styles.status}>
          The operators list couldn&rsquo;t be loaded. Nothing has been changed.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      {notice !== null && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      {data.skipped > 0 && (
        <p className={styles.skipped}>
          {data.skipped === 1
            ? "1 row couldn’t be read and is not shown below."
            : `${data.skipped} rows couldn’t be read and are not shown below.`}
        </p>
      )}

      <div className={styles.split}>
        {/* ---------------- who ---------------- */}
        <aside className={styles.people}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Find someone</span>
            <input
              className={styles.input}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name or reference"
            />
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => setIncludeInactive(e.target.checked)}
            />
            <span>Show deactivated people</span>
          </label>

          <ul className={styles.peopleList}>
            {rows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  className={row.id === selectedId ? styles.personOn : styles.person}
                  onClick={() => {
                    setSelectedId(row.id);
                    setRenaming(false);
                    setConfirmDelete(false);
                    setNotice(null);
                  }}
                >
                  <span className={styles.personName}>{row.displayName}</span>
                  <span className={styles.personMeta}>
                    {row.employeeRef ?? "no reference"} ·{" "}
                    {row.ticketCount === 1 ? "1 ticket" : `${row.ticketCount} tickets`}
                    {!row.active && <span className={styles.badge}>deactivated</span>}
                  </span>
                </button>
              </li>
            ))}
            {rows.length === 0 && <li className={styles.status}>Nobody matches that.</li>}
          </ul>

          <h3 className={styles.h3}>Add someone</h3>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Name</span>
            <input
              className={styles.input}
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Employee reference (optional)</span>
            <input
              className={styles.input}
              value={draftRef}
              onChange={(e) => setDraftRef(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Belongs to</span>
            <select
              className={styles.input}
              value={draftSite}
              onChange={(e) => setDraftSite(e.target.value)}
            >
              {scopeChoices.map((o) => (
                <option key={o.value ?? "company"} value={o.value ?? ""}>
                  {indentedLabel(o)}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className={styles.primary} onClick={addOperator} disabled={busy}>
            Add
          </button>

          <button
            type="button"
            className={styles.link}
            onClick={() => setShowSkillAdmin((on) => !on)}
          >
            {showSkillAdmin ? "Hide ticket types" : "Ticket types"}
          </button>
          {showSkillAdmin && (
            <ul className={styles.ticketTypes}>
              {skills.map((s) => (
                <li key={s.id} className={styles.ticketType}>
                  {skillEditId === s.id ? (
                    <>
                      <input
                        className={styles.input}
                        value={skillEditName}
                        onChange={(e) => setSkillEditName(e.target.value)}
                      />
                      <button
                        type="button"
                        className={styles.small}
                        disabled={busy}
                        onClick={() => {
                          const name = skillEditName.trim();
                          if (name === "") return;
                          setNotice(null);
                          renameSkill.mutate(
                            { id: s.id, name },
                            { onSuccess: () => setSkillEditId(null), onError: onErr },
                          );
                        }}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className={styles.small}
                        onClick={() => setSkillEditId(null)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <span className={styles.ticketTypeName}>{s.name}</span>
                      {s.siteNodeId === null && <span className={styles.badge}>company-wide</span>}
                      <button
                        type="button"
                        className={styles.small}
                        onClick={() => {
                          setSkillEditId(s.id);
                          setSkillEditName(s.name);
                        }}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        className={styles.small}
                        disabled={busy}
                        onClick={() => {
                          setNotice(null);
                          deleteSkill.mutate({ id: s.id }, { onError: onErr });
                        }}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </li>
              ))}
              {skills.length === 0 && <li className={styles.status}>No ticket types yet.</li>}
            </ul>
          )}
        </aside>

        {/* ---------------- where they can work ---------------- */}
        <section className={styles.detail}>
          {selected === null ? (
            <p className={styles.status}>
              Pick someone on the left to see where they can work.
            </p>
          ) : (
            <>
              <header className={styles.head}>
                {renaming ? (
                  <div className={styles.renameRow}>
                    <input
                      className={styles.input}
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      aria-label="Name"
                    />
                    <input
                      className={styles.input}
                      value={editRef}
                      onChange={(e) => setEditRef(e.target.value)}
                      aria-label="Employee reference"
                    />
                    {/* ⭐ WHERE THEY BELONG, EDITABLE. See `saveRename`.
                        ⚠️ It filters the roster and nothing else in this
                        release — the server does not yet refuse an assignment
                        outside it, and no label here may imply that it does. */}
                    <select
                      className={styles.input}
                      aria-label="Belongs to"
                      value={editSite}
                      onChange={(e) => setEditSite(e.target.value)}
                    >
                      {scopeChoices.map((o) => (
                        <option key={o.value ?? "company"} value={o.value ?? ""}>
                          {indentedLabel(o)}
                        </option>
                      ))}
                    </select>
                    <button type="button" className={styles.small} disabled={busy} onClick={saveRename}>
                      Save
                    </button>
                    <button type="button" className={styles.small} onClick={() => setRenaming(false)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className={styles.renameRow}>
                    <h2 className={styles.h2}>{selected.displayName}</h2>
                    <span className={styles.headMeta}>
                      {selected.employeeRef ?? "no reference"} ·{" "}
                      {selected.siteNodeId === null ? "company-wide" : "owned by a site"}
                      {!selected.active && <span className={styles.badge}>deactivated</span>}
                    </span>
                    <button
                      type="button"
                      className={styles.small}
                      onClick={() => {
                        setEditName(selected.displayName);
                        setEditRef(selected.employeeRef ?? "");
                        setEditSite(selected.siteNodeId ?? "");
                        setRenaming(true);
                      }}
                    >
                      Edit
                    </button>
                    {/* ⭐ DEACTIVATE IS THE MAIN ACTION (Pratik's decision):
                        it keeps every assignment, ticket and audit row intact
                        and simply takes the person off the board. */}
                    <button
                      type="button"
                      className={styles.primary}
                      disabled={busy}
                      onClick={() => {
                        setNotice(null);
                        setActive.mutate(
                          { id: selected.id, active: !selected.active },
                          { onError: onErr },
                        );
                      }}
                    >
                      {selected.active ? "Deactivate" : "Reactivate"}
                    </button>
                    {confirmDelete ? (
                      <>
                        <button
                          type="button"
                          className={styles.danger}
                          disabled={busy}
                          onClick={removeOperator}
                        >
                          Delete for good
                        </button>
                        <button
                          type="button"
                          className={styles.small}
                          onClick={() => setConfirmDelete(false)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className={styles.small}
                        onClick={() => {
                          setNotice(
                            deleteCheck !== null && !deleteCheck.allowed ? deleteCheck.blockedBy : null,
                          );
                          setConfirmDelete(true);
                        }}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                )}
              </header>

              <h3 className={styles.h3}>Where {selected.displayName} can work</h3>
              <div className={styles.asOfRow}>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Qualified for work booked up to</span>
                  <input
                    className={styles.input}
                    type="date"
                    value={asOf}
                    onChange={(e) => setAsOf(e.target.value)}
                  />
                </label>
                <p className={styles.summary}>
                  {summary.eligible} of {summary.total}{" "}
                  {summary.total === 1 ? "place" : "places"}
                  {summary.unresolved > 0 &&
                    ` · ${summary.unresolved} couldn’t be answered in full`}
                </p>
              </div>
              {/* ⚠️ An INDICATION, not a promise — the server re-asks
                  `check_eligibility` against the real shift window when the
                  assignment is actually made. See `../lib/operators`. */}
              <p className={styles.footnote}>
                The scheduler checks this again when work is assigned; this is what
                today&rsquo;s tickets and requirements imply.
              </p>
              <ul className={styles.places}>
                {visiblePlaces.map((p) => (
                  <PlaceRow key={p.nodeId} place={p} />
                ))}
                {visiblePlaces.length === 0 && (
                  <li className={styles.status}>
                    There are no schedulable places in the hierarchy yet.
                  </li>
                )}
              </ul>
              {hiddenPlaces > 0 && (
                <p className={styles.footnote}>
                  {hiddenPlaces === 1
                    ? "1 deactivated place is not shown."
                    : `${hiddenPlaces} deactivated places are not shown.`}
                </p>
              )}

              <h3 className={styles.h3}>Tickets</h3>
              <p className={styles.footnote}>
                A ticket is what changes the answer above. Adding one can turn several
                crosses green at once — requirements sit on places and inherit downward.
              </p>
              <ul className={styles.tickets}>
                {tickets.map((t) => (
                  <li key={t.skillId} className={styles.ticket}>
                    <span className={styles.ticketName}>
                      {t.name}
                      {t.lapsed && <span className={styles.badge}>lapsed</span>}
                    </span>
                    <label className={styles.inlineField}>
                      <span className={styles.fieldLabel}>Expires</span>
                      <input
                        className={styles.input}
                        type="date"
                        value={t.expiresAt ?? ""}
                        disabled={busy}
                        onChange={(e) => {
                          setNotice(null);
                          updateExpiry.mutate(
                            {
                              operatorId: selected.id,
                              skillId: t.skillId,
                              expiresAt: e.target.value === "" ? null : e.target.value,
                            },
                            { onError: onErr },
                          );
                        }}
                      />
                    </label>
                    <span className={styles.ticketWhen}>
                      {t.expiresAt === null ? "never expires" : formatDay(t.expiresAt)}
                    </span>
                    <button
                      type="button"
                      className={styles.small}
                      disabled={busy}
                      onClick={() => {
                        setNotice(null);
                        revokeSkill.mutate(
                          { operatorId: selected.id, skillId: t.skillId },
                          { onError: onErr },
                        );
                      }}
                    >
                      Remove
                    </button>
                  </li>
                ))}
                {tickets.length === 0 && (
                  <li className={styles.status}>No tickets yet.</li>
                )}
              </ul>

              <h3 className={styles.h3}>Add a ticket</h3>
              <div className={styles.grantRow}>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Existing ticket</span>
                  <select
                    className={styles.input}
                    value={grantId}
                    onChange={(e) => setGrantId(e.target.value)}
                  >
                    <option value="">Choose…</option>
                    {grantable.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Expires (blank = never)</span>
                  <input
                    className={styles.input}
                    type="date"
                    value={grantExpiry}
                    onChange={(e) => setGrantExpiry(e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className={styles.primary}
                  disabled={busy || grantId === ""}
                  onClick={() => attachSkill(grantId, grantExpiry === "" ? null : grantExpiry)}
                >
                  Attach
                </button>
              </div>

              <div className={styles.grantRow}>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>…or a new one</span>
                  <input
                    className={styles.input}
                    value={newSkill}
                    onChange={(e) => setNewSkill(e.target.value)}
                    placeholder="Forklift"
                  />
                </label>
                <button
                  type="button"
                  className={styles.primary}
                  disabled={busy || newSkill.trim() === "" || (clash !== null && clash.exact)}
                  onClick={createAndAttach}
                >
                  Create &amp; attach
                </button>
              </div>
              {/* ⭐ THE CLASH THAT IS NOT AN ERROR. Skill names are company-wide
                  (`unique (org_id, name)`), and Pratik's decision is that they
                  stay that way — so typing a name that already exists is not a
                  mistake, it is finding the ticket you were about to make. The
                  screen says so and attaches it in one click; a raw
                  duplicate-key error reaching the user would be a defect. */}
              {clash !== null && (
                <p className={styles.reuse}>
                  {describeSkillNameClash(clash)}{" "}
                  {heldIds.has(clash.skill.id) ? (
                    <span>They already hold it.</span>
                  ) : (
                    <button
                      type="button"
                      className={styles.link}
                      disabled={busy}
                      onClick={() =>
                        attachSkill(clash.skill.id, grantExpiry === "" ? null : grantExpiry)
                      }
                    >
                      Attach {clash.skill.name}
                    </button>
                  )}
                </p>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
