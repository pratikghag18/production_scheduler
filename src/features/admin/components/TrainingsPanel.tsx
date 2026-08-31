/* ---------------------------------------------------------------------------
   Trainings — the section trainings finally got (roadmap stage 22, first half).

   THE MAINTAINER, 31 August:
     "I thought we were going to create a trainings tab like operator/shifts/
      products. These should be editable and we're still calling them tickets."

   ⭐⭐ HE IS DESCRIBING TWO DEFECTS AND THEY HAVE THE SAME CAUSE. Trainings
   lived INSIDE the Operators tab, behind a "Ticket types" toggle, reachable
   only after picking a person — so a training nobody held was unreachable, and
   renaming the forklift course meant first finding somebody who happened to
   hold it. A list that is only ever reached through one of its consumers ends
   up borrowing that consumer's vocabulary too, which is where "ticket" came
   from. Giving trainings a section of their own fixes both at once.

   ⭐ `TRAININGS_PANEL_READY` LIVES HERE, NOT IN `AdminPage.tsx`, exactly as
   `PRODUCTS_PANEL_READY` does. The nav entry reads it, so turning this section
   on is a one-line edit to THIS file — the lane that builds the panel is the
   lane that flips it, and a section cannot be switched on without a panel
   behind it because the switch is part of the panel.

   TAKES NO PROPS, deliberately, like the three panels beside it. Everything it
   needs it asks for itself — and it asks with `useOperatorsAdmin`, which is the
   read the Operators section already makes, so React Query serves both from one
   request rather than two. That is also what keeps the two screens honest with
   each other: retiring a training here changes what the Operators screen offers
   to grant, and it is the same cache entry that redraws.

   DECIDES NOTHING ITSELF. What to show, what to say, what a draft must look
   like, what to call the primary action — every one of those is a function in
   `../lib/trainings.ts`, which is pure and is what `src/test/trainings.test.ts`
   tests. This file renders what those functions return.

   ⚠️ THE WORD IS "TRAINING" EVERYWHERE A READER CAN SEE. The table is `skills`
   and the api layer says `skill`, so the identifiers do too — but no string
   this file renders says "ticket" or "skill". See `../lib/trainings.ts`'s
   header, and the one known leak recorded against `describeSkillNameClash`
   below.

   ⭐⭐ AND SINCE 0032 IT SHOWS ROWS IT CANNOT WRITE, which is why
   `../lib/editRights.ts` exists. Reading is scoped UPWARD (`app_can_read_owned`
   — rows owned at or above your grant) and writing DOWNWARD (`app_can_edit_node`
   — your grant and below), so a line supervisor's list legitimately includes the
   plant's trainings and the server refuses every Rename and Retire on them.
   Case V14 in `supabase/tests/59_training_record_test.sql` pins it and calls the
   missing preview a known debt. ⚠️ The preview FAILS OPEN and authorises
   nothing — see that module's header. --------------------------------------- */
import { useEffect, useMemo, useState } from "react";
import { describeSchedulerError, type SchedulerError } from "@/lib/api";
import { useSession } from "@/features/auth/useSession";
import { canQueryAsUser } from "@/features/auth/session";
import {
  useCreateSkill,
  useOperatorsAdmin,
  useRenameSkill,
  useSetSkillActive,
} from "../hooks/useOperators";
import { useEditRights } from "../hooks/useEditRights";
import { describeSkillNameClash, findExistingSkillByName } from "../lib/operators";
import { notManagedNote } from "../lib/editRights";
import {
  describeTrainingWriteRefusal,
  hiddenByPlantNote,
  matchesTrainingQuery,
  partitionTrainings,
  retireActionLabel,
  retiredClashNote,
  skippedRowsNote,
  trainingHandle,
  validateTrainingDraft,
  type TrainingRow,
} from "../lib/trainings";
import { DeleteDialog } from "./DeleteDialog";
import { usePlantFilter } from "../hooks/usePlantFilter";
import { nodesInPlant, rowsInPlant } from "../lib/plantFilter";
import { indentedLabel, scopeLabel, scopeOptions, scopePathLabel } from "../lib/scope";
import styles from "./TrainingsPanel.module.css";

/** Read by `AdminPage`'s rail, the same way `PRODUCTS_PANEL_READY` is. */
export const TRAININGS_PANEL_READY = true;

export function TrainingsPanel() {
  const { session, profile, loading: sessionLoading } = useSession();
  const canQuery = canQueryAsUser(session?.user.id ?? null, sessionLoading);
  const orgId = profile?.orgId ?? null;

  const { data, isLoading, isError, error } = useOperatorsAdmin(canQuery);
  // ⚠️ `!canQuery || isLoading`, NEVER `isLoading` ALONE (D91). `enabled: false`
  // leaves `isLoading` FALSE, so gating on it alone renders "no trainings yet"
  // as though it were the answer to a question nobody asked.
  const loading = !canQuery || isLoading;

  // ⭐⭐ WHICH ROWS THIS READER MAY ACTUALLY CHANGE (V14). A SEPARATE READ from
  // the list, deliberately: `fetchOperatorsAdmin` is the Operators section's
  // query too and belongs to `src/lib/api`, which this lane does not own —
  // folding two grant paths into it would have been an edit to a shared read for
  // one screen's preview. ⚠️ It is NOT gated on the list having landed: a slow
  // grant read must never hold up the list, because the fail-open answer while
  // it is in flight is exactly today's behaviour.
  const { canEdit } = useEditRights(canQuery, profile?.role ?? null);

  const createMutation = useCreateSkill();
  const renameMutation = useRenameSkill();
  const activeMutation = useSetSkillActive();

  const [query, setQuery] = useState("");
  const [newName, setNewName] = useState("");
  const [newOwner, setNewOwner] = useState("");
  const [newErrors, setNewErrors] = useState<{ name: string | null; owner: string | null }>({
    name: null,
    owner: null,
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  // ⭐ SEPARATE FROM `rowError`, and the separation is the point — the same call
  // `ProductsPanel` makes. A delete that SUCCEEDS still has something to say
  // (what went, what stayed), and saying it in the row's error slot would style
  // an outcome as a failure.
  const [rowNotice, setRowNotice] = useState<{ id: string; message: string } | null>(null);

  /* -- the read ---------------------------------------------------------- */

  // ⚠️ MEMOISED, not inlined `?? []`. A fresh `[]` every render is a new
  // identity, so `usePlantFilter` — which memoises on the array it is handed —
  // would hand every derivation below a brand new `plant` object every time.
  const trainings = useMemo(() => data?.skills ?? [], [data]);
  const nodes = useMemo(() => data?.nodes ?? [], [data]);

  // ⭐ BUILT FROM EVERY READABLE NODE, NEVER FROM THE PLANT-FILTERED SET.
  // `rowsInPlant` has to resolve the owner of a row it is about to EXCLUDE and
  // fails open on one it cannot find — so a map built from the filtered nodes
  // would fail open on precisely the rows the filter exists to drop, and the
  // filter would appear to do nothing at all.
  //
  // ⚠️ NOT `scopeIndex(nodes)`, which types its values as `ScopeNode` and so
  // drops `levelId`/`active`. `findExistingSkillByName` wants `NodeLike`. One
  // map of `BoardNode` satisfies both interfaces; two maps of the same nodes
  // would be D100's defect in miniature.
  const nodesById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  /* -- which plant this screen is showing (roadmap 1(c)) ------------------ */

  // ⭐ THE CHOICE IS MADE ONE SCREEN UP AND THIS PANEL ONLY READS IT. The
  // control and the header chip live on `AdminPage`, once, for the whole admin
  // screen — six per-panel filters would be six controls that drift apart, and
  // a reader who set one would have no way to know the other five were still
  // wide open.
  //
  // ⚠️ IT FAILS OPEN WHEN THE READ FAILED, for free: `nodes` is then `[]`, so
  // there are no readable roots, `resolvePlantChoice` collapses a remembered id
  // to `null`, and every trim below is the identity.
  const plant = usePlantFilter(nodes);

  // ⭐⭐ THE FILTER NARROWS THE OWNER PICKER TOO — decision 3, "what you see is
  // what you can create in". The rejected alternative lets somebody create a
  // training into a plant they have filtered away and then watch it not appear,
  // which is `scope.ts`'s silent hiding in a new costume.
  //
  // ⚠️⚠️ IT GOES IN AS THE NODE ARRAY AND NEVER AS A PERMISSION. The filter is
  // a VIEW CHOICE and is reversible; a permission narrowing would not be, and
  // the day somebody widens back to All plants it would silently widen what
  // this form claims they may write. `scopeOptions`' own header records that
  // its `canEdit` parameter was deleted for exactly this confusion.
  const owners = useMemo(
    () => scopeOptions(nodesInPlant(nodes, plant.choice, plant.plants)),
    [nodes, plant.choice, plant.plants],
  );
  const ownerLabels = useMemo(
    () => new Map(owners.map((o) => [o.value, indentedLabel(o)])),
    [owners],
  );

  // Kept legal by construction: falls back to the first owner on offer.
  //
  // ⭐ THE FILTER IS WHY THIS EARNS ITS KEEP. Narrowing `owners` can strand a
  // half-typed draft on a node that is no longer offered; because the value is
  // resolved on every render rather than stored, the picker moves to the chosen
  // plant's first node instead of DISPLAYING option 0 while holding another
  // plant's id — a `<select>` handed a value none of its options carries
  // renders its first option and reports nothing. ⚠️ `newOwner` is deliberately
  // NOT rewritten: widening back to All plants restores what they picked, which
  // is the reversibility a view choice is supposed to have.
  //
  // `""` survives only when there is nothing to offer at all — the read did not
  // land — and `submitNew` refuses it with a sentence rather than sending a
  // null the database rejects.
  const ownerValue = owners.some((o) => o.value === newOwner) ? newOwner : (owners[0]?.value ?? "");

  /* -- the list ---------------------------------------------------------- */

  const inPlant = useMemo(
    () => rowsInPlant(trainings, plant.choice, plant.plants, nodesById),
    [trainings, plant.choice, plant.plants, nodesById],
  );
  // ⚠️ THE PLANT CUT COMES BEFORE THE SEARCH, so this number is a fact about
  // the control in the header and does not move while somebody types. Counting
  // after the search would make it read as a statement about the box being
  // typed in.
  const hiddenByPlant = trainings.length - inPlant.length;
  const visible = inPlant.filter((r) => matchesTrainingQuery(r, query));
  const { live, retired } = partitionTrainings(visible);

  /* -- the name clash ----------------------------------------------------- */

  // ⭐⭐ ASKED ABOUT `trainings`, NOT `inPlant`, AND THE OWNER IS THE PICKER'S
  // VALUE. Since 0031 a name is unique per OWNER, so the narrowing that decides
  // the answer is the owner — passed as the third argument — and never the
  // plant the reader happens to be looking at. Asking `inPlant` would let a
  // reversible view choice silently change which names the screen believes are
  // free.
  //
  // ⚠️ `nodesById` IS HANDED IN SO THE PLANT-WIDE PASS CAN RUN AT ALL. Without
  // it the finder answers about this owner only and says nothing about the rest
  // of the plant — which is silence, not a clean bill of health, and would
  // leave 0031's *"the database refuses per owner; the screen warns per plant"*
  // promise unkept.
  const clash = findExistingSkillByName(
    trainings,
    newName,
    ownerValue === "" ? null : ownerValue,
    nodesById,
  );
  // ⭐⭐ ONLY A CLASH UNDER THIS OWNER BLOCKS. A `"this-plant"` one is LEGAL —
  // 0031's constraint is per owner, so Line A and Line B may each hold a
  // "Forklift" — and refusing it here would be the client enforcing a rule the
  // database does not have: §19.74's stale-refusal defect, the quiet kind that
  // never fails and just stops people working.
  const clashBlocks = clash !== null && clash.exact && clash.where === "here";
  // The row the clash found, re-read from the live list so its `active` is
  // current — `SkillLike` (what the finder returns) does not carry it.
  const clashRow = clash === null ? null : (trainings.find((t) => t.id === clash.skill.id) ?? null);

  /* -- id-keyed state, when the filter takes its row away ----------------- */

  // ⚠️ A FORM IS NOT A SENTENCE. Resolve-or-fall-back is reversible by
  // construction, so widening back to All plants would re-open a rename box —
  // or a delete confirmation — the reader left behind two plants ago. Clearing
  // is the only thing that closes a door. `rowError` and `rowNotice` are
  // deliberately left alone: a sentence about a row simply stops being rendered
  // when the row goes, which is the honest lifetime for "here is what just
  // happened to a thing that is no longer here".
  //
  // ⚠️ MEASURED AGAINST `inPlant`, NOT `visible`: the search box is on this
  // card and one keystroke from being cleared, so a row it hides is out of view
  // rather than out of scope. The plant choice persists across visits and
  // across sections.
  const inPlantIds = useMemo(() => new Set(inPlant.map((r) => r.id)), [inPlant]);
  const renamingGone = renamingId !== null && !inPlantIds.has(renamingId);
  const confirmingGone = confirmingId !== null && !inPlantIds.has(confirmingId);
  useEffect(() => {
    // Booleans, not the id set, as the dependencies: a fresh `Set` every render
    // would make this an effect that runs every render and clears nothing.
    if (renamingGone) setRenamingId(null);
    if (confirmingGone) setConfirmingId(null);
  }, [renamingGone, confirmingGone]);

  /* -- writes ------------------------------------------------------------- */

  function clearRowError(id: string) {
    setRowError((cur) => (cur !== null && cur.id === id ? null : cur));
  }

  function onRowError(id: string) {
    return (err: SchedulerError) =>
      setRowError({ id, message: describeTrainingWriteRefusal(err, describeSchedulerError(err)) });
  }

  /**
   * ⭐⭐ THE PRIMARY ACTION, AND IT IS NOT A DELETE. Retiring changes nothing
   * anybody holds — everyone qualified stays qualified, every record keeps it —
   * it stops the training being offered for new work. "We don't run that course
   * any more" was unreachable from any screen until this one.
   */
  function toggleActive(row: TrainingRow) {
    clearRowError(row.id);
    setRowNotice(null);
    activeMutation.mutate({ id: row.id, active: !row.active }, { onError: onRowError(row.id) });
  }

  function saveRename(row: TrainingRow) {
    // ⚠️ VALIDATED THROUGH THE SAME FUNCTION THE ADD FORM USES, owner included.
    // A rename cannot change the owner (see the hint under the list), so the
    // row's own owner goes in — a second, laxer rule for the same field is how
    // two forms end up disagreeing about what a legal name is.
    const result = validateTrainingDraft({ name: renameDraft, siteNodeId: row.siteNodeId });
    if (!result.ok) {
      setRowError({ id: row.id, message: result.nameError ?? result.ownerError ?? "" });
      return;
    }
    clearRowError(row.id);
    renameMutation.mutate(
      { id: row.id, name: result.value.name },
      {
        onSuccess: () => setRenamingId((cur) => (cur === row.id ? null : cur)),
        onError: onRowError(row.id),
      },
    );
  }

  function submitNew() {
    if (orgId === null) return;
    const result = validateTrainingDraft({ name: newName, siteNodeId: ownerValue });
    if (!result.ok) {
      setNewErrors({ name: result.nameError, owner: result.ownerError });
      setFormError(null);
      return;
    }
    setNewErrors({ name: null, owner: null });
    setFormError(null);
    createMutation.mutate(
      {
        // `skills.org_id` has no default — it comes from the session profile on
        // every insert, never from a database default that is not there.
        orgId,
        name: result.value.name,
        siteNodeId: result.value.siteNodeId,
      },
      {
        onSuccess: () => setNewName(""),
        onError: (err: SchedulerError) =>
          setFormError(describeTrainingWriteRefusal(err, describeSchedulerError(err))),
      },
    );
  }

  /* -- render ------------------------------------------------------------- */

  function renderRow(row: TrainingRow) {
    const owner = scopeLabel(row.siteNodeId, nodesById);
    // ⭐⭐ EVERY CONTROL ON THIS ROW IS NAMED FOR THE ROW **AND ITS OWNER**, and
    // that is 0031 arriving in the accessibility layer rather than a style
    // preference. Names are unique per owner now, so this list can legitimately
    // hold two rows both called "Forklift" — each with its own Retire, Rename
    // and cascading Delete. Six buttons named "Retire" is `OperatorsPanel`'s
    // real "Belongs to" defect in a list where the ambiguity is guaranteed
    // rather than accidental. The visible label stays the plain verb, so the
    // accessible name still contains it.
    const handle = trainingHandle(row.name, owner);
    // ⭐⭐ THE PREVIEW, AND IT IS ASKED WITH THE OWNER'S **PATH**, never its id.
    // `app_can_edit_node` compares `n.path <@ gp`, and the path is the same
    // value the server compares — walking parents to rebuild it would be a
    // second implementation of ancestry that can disagree with the first
    // (`scope.ts`'s call). ⚠️ `?? null` IS THE FAIL-OPEN DOOR: an owner this
    // client cannot resolve means "I cannot tell", and `canEditNode` answers
    // yes so the server gets to refuse out loud.
    const editable = canEdit(nodesById.get(row.siteNodeId)?.path ?? null);
    // ⚠️ `editable` OVERRIDES BOTH OPEN STATES rather than sitting beside them.
    // The grant read lands AFTER the list, so a rename box or a delete dialog
    // can already be open on a row that turns out to be read-only; leaving them
    // up would be a Save button on a row whose Rename has just been withdrawn.
    const isRenaming = editable && renamingId === row.id;
    const isConfirming = editable && confirmingId === row.id;
    const err = rowError !== null && rowError.id === row.id ? rowError.message : null;
    const notice = rowNotice !== null && rowNotice.id === row.id ? rowNotice.message : null;

    return (
      <li key={row.id} className={row.active ? styles.row : `${styles.row} ${styles.retired}`}>
        {isRenaming ? (
          <input
            className={styles.input}
            value={renameDraft}
            /* ⚠️ NAMED FOR ITS ROW, not just for its field. The Add card one
               card up has a box whose visible label is also "Name". */
            aria-label={`Name for ${handle}`}
            onChange={(e) => setRenameDraft(e.target.value)}
          />
        ) : (
          <span className={styles.name}>{row.name}</span>
        )}

        {/* ⭐ THE OWNER IS A COLUMN, NEVER PART OF THE NAME. The demo seed used
            to spell the plant into the text (`A-Welding`); read from the column
            instead it follows a node rename for free, and 0031 drops the prefix.
            ⚠️ THE FULL PATH IS THE TOOLTIP, because `scopeLabel` gives the
            leaf's own name and two plants can each have a "Line 1". */}
        <span className={styles.owner} title={scopePathLabel(row.siteNodeId, nodesById)}>
          {owner}
        </span>

        {/* ⭐⭐ NO CONTROLS AT ALL ON A ROW THE SERVER WILL REFUSE, AND THE
            REASON IN THEIR PLACE. D106 forbids a control named after more than
            it does, and a disabled "Rename" is exactly that — plus it is
            unreachable by keyboard, so whatever explanation hangs off it is
            never announced. ⚠️ DELETE GOES WITH THEM even though V14 names only
            Rename and Retire: `skills_delete` is the same `app_can_edit_node`
            policy, so keeping it would leave one live button on a row that has
            just said it cannot be changed. */}
        {!editable && <span className={styles.readOnly}>{notManagedNote(owner)}</span>}

        {editable && (
          <span className={styles.actions}>
            {isRenaming ? (
              <>
                <button
                  type="button"
                  className={styles.primary}
                  aria-label={`Save the name of ${handle}`}
                  onClick={() => saveRename(row)}
                >
                  Save
                </button>
                <button
                  type="button"
                  className={styles.quiet}
                  aria-label={`Stop renaming ${handle}`}
                  onClick={() => setRenamingId(null)}
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                {/* ⭐ RETIRE FIRST AND DELETE SECOND, and the order on screen is
                  the decision. Retiring keeps everyone's qualification;
                  deleting cascades the training off every one of them (0029). */}
                <button
                  type="button"
                  className={styles.primary}
                  aria-label={`${retireActionLabel(row.active)} ${handle}`}
                  title={
                    row.active
                      ? "Stop offering it for new work. Everyone who holds it keeps it."
                      : "Offer it for new work again."
                  }
                  onClick={() => toggleActive(row)}
                >
                  {retireActionLabel(row.active)}
                </button>
                {/* ⚠️ "RENAME" IS THE HONEST NAME FOR WHAT THIS OPENS, and it is
                  narrower than `ProductsPanel`'s "Edit" on purpose: the form
                  behind it changes the name and NOTHING ELSE, because the api
                  layer has no write that moves a training to another owner.
                  D106 forbids a control named after LESS than it does; naming
                  it "Edit" would be the opposite error, and the missing write
                  is recorded in the hint under the list rather than hidden
                  behind a button that cannot deliver it. */}
                <button
                  type="button"
                  className={styles.quiet}
                  aria-label={`Rename ${handle}`}
                  onClick={() => {
                    clearRowError(row.id);
                    setConfirmingId(null);
                    setRenamingId(row.id);
                    setRenameDraft(row.name);
                  }}
                >
                  Rename
                </button>
                {/* ⭐ ONE CONTROL, AND IT OPENS A DIALOG THAT ASKS THE SERVER
                  FIRST. The screen this replaces deleted a training outright on
                  one click — with no confirmation at all — and under 0029 that
                  also un-qualifies everyone holding it and drops it from every
                  cell that requires it, by cascade. */}
                <button
                  type="button"
                  className={styles.quiet}
                  disabled={isConfirming}
                  aria-label={`Delete ${handle}`}
                  onClick={() => {
                    clearRowError(row.id);
                    setRowNotice(null);
                    setConfirmingId(row.id);
                  }}
                >
                  Delete
                </button>
              </>
            )}
          </span>
        )}

        {!row.active && <span className={styles.tag}>Retired</span>}
        {err !== null && <span className={styles.error}>{err}</span>}
        {notice !== null && <span className={styles.note}>{notice}</span>}
        {isConfirming && (
          <DeleteDialog
            kind="skill"
            id={row.id}
            name={row.name}
            /* ⭐ THE DIALOG'S "DEACTIVATE INSTEAD" IS REACHABLE FOR THE FIRST
               TIME HERE. §19.74 recorded it as owed — *"no screen reads or
               writes them, so `DeleteDialog` offers no 'Deactivate instead' for
               those two kinds"* — because `skills.active` shipped in 0029 with
               no UI. This panel is the UI, so the offer can be made. */
            alreadyInactive={!row.active}
            onDeactivate={() => {
              setConfirmingId(null);
              toggleActive(row);
            }}
            onCancel={() => setConfirmingId(null)}
            onDeleted={(message) => {
              setConfirmingId(null);
              setRowNotice({ id: row.id, message });
            }}
            onFailed={(message) => {
              setConfirmingId(null);
              setRowError({ id: row.id, message });
            }}
          />
        )}
      </li>
    );
  }

  if (loading) {
    return (
      <div className={styles.panel}>
        <p className={styles.status}>Loading trainings…</p>
      </div>
    );
  }

  if (isError) {
    return (
      <div className={styles.panel}>
        <p className={styles.error} role="alert">
          {error ? describeSchedulerError(error) : "Something went wrong. Please try again."}
        </p>
      </div>
    );
  }

  const skipped = skippedRowsNote(data?.skipped ?? 0);
  const hiddenNote = hiddenByPlantNote(hiddenByPlant, plant.label);
  const clashNote =
    clash === null
      ? null
      : describeSkillNameClash(clash, scopeLabel(clash.skill.siteNodeId, nodesById));
  const retiredNote = clashRow === null ? null : retiredClashNote(clashRow.active);
  // ⚠️ THE SECOND PLACE `active` IS FLIPPED, and it needs the same preview as
  // the first. The row this note points at can easily be one the reader cannot
  // touch — 0031 makes the clash a per-owner question, and the owner it names
  // may sit above their grant — so an unguarded "Bring back" here would be the
  // one refused button left on a screen that had removed all the others.
  const clashRowEditable =
    clashRow !== null && canEdit(nodesById.get(clashRow.siteNodeId)?.path ?? null);

  return (
    <div className={styles.panel}>
      <section className={styles.card}>
        <h2 className={styles.h2}>Add a training</h2>
        {owners.length === 0 ? (
          <p className={styles.status}>
            We couldn&rsquo;t read your plant structure, so there&rsquo;s nowhere to add a training.
            Reload to try again.
          </p>
        ) : (
          <div className={styles.form}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Name</span>
              <input
                className={styles.input}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
              {newErrors.name !== null && <span className={styles.error}>{newErrors.name}</span>}
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Belongs to</span>
              {/* ⭐ THE TREE, INDENTED (0025 / D103, D109) — the WHOLE tree on
                  "All plants", the chosen plant's subtree otherwise. Every node
                  is offered to anyone who administers anywhere and the server
                  has the final say: `scopeOptions`' header records that
                  narrowing this to a client-derived permission set left a site
                  admin with no options at all, and that offering a node the
                  server then refuses costs one clear sentence under §19.63's
                  write-error contract.
                  ⚠️⚠️ AND IT IS DELIBERATELY **NOT** NARROWED BY `canEdit`,
                  even though the grant paths are now in hand and `skills_insert`
                  asks the same `app_can_edit_node` this preview mirrors. The
                  ROW preview removes controls whose only outcome is an error;
                  narrowing this picker would remove the only way to say where a
                  new training goes, and `scopeOptions`' header records what that
                  cost the last time it was tried. A refused create already lands
                  as a sentence under the form. Recorded as the next question to
                  ask the maintainer rather than half-built. */}
              <select
                className={styles.input}
                value={ownerValue}
                onChange={(e) => setNewOwner(e.target.value)}
              >
                {owners.map((o) => (
                  <option key={o.value} value={o.value}>
                    {ownerLabels.get(o.value)}
                  </option>
                ))}
              </select>
              {newErrors.owner !== null && <span className={styles.error}>{newErrors.owner}</span>}
            </label>
            <button
              type="button"
              className={styles.primary}
              /* ⚠️⚠️ DISABLED ONLY BY `clashBlocks` — a clash under THIS owner,
                 which the database really will refuse. A `"this-plant"` clash
                 leaves this button live on purpose; see `clashBlocks`. */
              disabled={clashBlocks}
              onClick={submitNew}
            >
              Add
            </button>
          </div>
        )}

        {/* ⭐ THE CLASH, IN ONE OF ITS THREE VOICES. `findExistingSkillByName`
            decides which; `describeSkillNameClash` says it, and is given the
            other place's NAME so the reader is not sent hunting through a list.
            Rendered as a note rather than an error even when it blocks, because
            two of the three answers are not refusals at all. */}
        {clashNote !== null && <p className={styles.hint}>{clashNote}</p>}
        {/* ⭐ AND THE HALF THE SHARED FINDER CANNOT KNOW: whether the row it
            found is RETIRED. "Use that one" is advice a reader cannot follow
            for a retired training, so the way out is offered here, as a
            control, rather than described. */}
        {retiredNote !== null && clashRow !== null && !clashRowEditable && (
          /* ⚠️ THE ADVICE STILL GETS SAID, because it is still the reason the
             name is taken — what changes is that the way out is somebody
             else's to take, and saying whose is more use than a button that
             fails. */
          <p className={styles.hint}>
            {retiredNote} {notManagedNote(scopeLabel(clashRow.siteNodeId, nodesById))}
          </p>
        )}
        {retiredNote !== null && clashRow !== null && clashRowEditable && (
          <p className={styles.hint}>
            {retiredNote}{" "}
            <button
              type="button"
              className={styles.quiet}
              /* ⚠️ NAMED APART FROM THE ROW'S OWN BRING-BACK BUTTON, which is on
                 screen at the same time and carries the same handle. Two
                 controls with one accessible name is the `OperatorsPanel`
                 "Belongs to" defect, and here it would be guaranteed rather
                 than occasional — this note only appears when that row exists.
                 The visible label stays the plain verb so the accessible name
                 still contains it. */
              aria-label={`Bring back ${trainingHandle(
                clashRow.name,
                scopeLabel(clashRow.siteNodeId, nodesById),
              )} instead of creating a second`}
              onClick={() => toggleActive(clashRow)}
            >
              Bring back
            </button>
          </p>
        )}
        {formError !== null && <p className={styles.error}>{formError}</p>}

        {/* ⭐ THE FORM'S OWN "COUNT WHAT YOU HIDE". The list below says how many
            trainings the filter keeps back; this says what it keeps back from
            the picker, because "why can't I choose Plant 2 here?" is the
            question decision 3 creates and an absent option looks exactly like
            a missing permission. */}
        {plant.choice !== null && owners.length > 0 && (
          <p className={styles.hint}>
            You&rsquo;re showing {plant.label}, so a new training can only go there. Switch to
            &ldquo;All plants&rdquo; above to add it somewhere else.
          </p>
        )}
      </section>

      <section className={styles.card}>
        <h2 className={styles.h2}>Trainings</h2>
        <input
          className={styles.search}
          value={query}
          placeholder="Search by name"
          aria-label="Search trainings"
          onChange={(e) => setQuery(e.target.value)}
        />

        {skipped !== null && <p className={styles.skippedLine}>{skipped}</p>}

        {/* ⭐ COUNT WHAT YOU HIDE — `scope.ts`'s rule, and the reason the plant
            choice may persist at all: hiding is invisible and permanent, and a
            list that quietly shrank looks exactly like a list of things nobody
            created. So it names the way back out too. */}
        {hiddenNote !== null && <p className={styles.skippedLine}>{hiddenNote}</p>}

        <h3 className={styles.h3}>In use</h3>
        {live.length === 0 ? (
          <p className={styles.status}>Nothing here yet.</p>
        ) : (
          <ul className={styles.list}>
            <li className={styles.head}>
              <span>Name</span>
              <span>Belongs to</span>
              <span />
            </li>
            {live.map(renderRow)}
          </ul>
        )}

        {/* Retired trainings are an ordinary, populated part of this screen —
            retiring is the main action, so what has been retired has to be
            somewhere you can find it and bring back. */}
        <h3 className={styles.h3}>Retired</h3>
        {retired.length === 0 ? (
          <p className={styles.status}>Nothing retired.</p>
        ) : (
          <ul className={styles.list}>{retired.map(renderRow)}</ul>
        )}

        {/* ⚠️ SAYING WHAT THIS SCREEN CANNOT DO, rather than leaving a reader to
            hunt for a control that is not there. Where a training belongs is
            settable at creation and not changeable afterwards — the api layer
            has no write for it — which is D105's gap, recorded on screen
            instead of hidden behind a button named after more than it does. */}
        <p className={styles.hint}>
          Where a training belongs is set when it&rsquo;s created and can&rsquo;t be moved
          afterwards yet. Retiring one keeps it on everyone who already holds it; deleting one takes
          it off them.
        </p>
      </section>
    </div>
  );
}
