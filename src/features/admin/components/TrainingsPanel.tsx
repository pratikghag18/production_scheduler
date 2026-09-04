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

   ⭐⭐ AND SINCE D105 THE EDIT FORM MOVES A TRAINING AS WELL AS RENAMING IT.
   The api layer had `renameSkill` and nothing else, so where a training
   belonged was a create-only choice; the control was honestly called "Rename"
   and the hint under the list admitted the gap out loud. `updateSkill` closes
   it, and the button is renamed in the same change because D106 forbids a
   control named after LESS than it does exactly as firmly as one named after
   more.

   ⚠️⚠️ MOVING ONE IS NOT FREE, AND THE DATABASE WILL NOT SAY SO.
   `app_guard_operator_skill_scope` (0028 §4) requires a training's owner and a
   HOLDER's owner to be comparable, and it is a trigger on `operator_skills`
   fired on INSERT or on an UPDATE of `operator_id`/`skill_id` — so nothing
   re-checks it when `skills` moves out from under those rows. Measured on the
   running stack: the move is ALLOWED, the holder rows survive and still count
   in `check_eligibility`, and they are left in a state a re-grant of the same
   pair would be refused. `app_guard_skill_rehome` (§5) guards this column and
   counts `node_skill_requirements` ONLY. So the count, the names and the
   confirmation below are the whole of the protection — see
   `previewTrainingMove` in `../lib/trainings.ts`.

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
  useSetSkillActive,
  useSetSkillDocumentNumber,
  useUpdateSkill,
} from "../hooks/useOperators";
import { useEditRights } from "../hooks/useEditRights";
import { describeSkillNameClash, findExistingSkillByName } from "../lib/operators";
import { notManagedNote } from "../lib/editRights";
import {
  describeDocumentNumberRefusal,
  describeTrainingWriteRefusal,
  documentNumberLabel,
  hiddenByPlantNote,
  listStrandedHolders,
  matchesTrainingQuery,
  moveCosts,
  partitionTrainings,
  previewTrainingMove,
  retireActionLabel,
  retiredClashNote,
  skippedRowsNote,
  summariseTrainingMove,
  trainingHandle,
  validateTrainingDraft,
  type TrainingMovePreview,
  type TrainingRow,
} from "../lib/trainings";
import { DeleteDialog } from "./DeleteDialog";
import { usePlantFilter } from "../hooks/usePlantFilter";
import { nodesInPlant, rowsInPlant } from "../lib/plantFilter";
import { indentedLabel, isAtOrBelow, scopeLabel, scopeOptions, scopePathLabel } from "../lib/scope";
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
  // ⭐⭐ `useUpdateSkill`, NOT `useRenameSkill`, AND THAT IS D105 CLOSING. The
  // api layer had `renameSkill` and nothing else, so where a training belonged
  // was settable once and never again — which is what the hint under this list
  // used to admit to. `updateSkill` patches either field or both, and an ABSENT
  // key means "leave it alone", so a rename still sends only a name.
  const updateMutation = useUpdateSkill();
  const activeMutation = useSetSkillActive();
  // ⭐ THE DOCUMENT NUMBER IS ITS OWN WRITE, not a field on the edit form. It is
  // a nullable column with a real "clear it" state (`setSkillDocumentNumber`
  // takes `null` to mean cleared), which the name/owner edit — two NOT-NULL
  // columns — has no room for; folding it in would force the two contracts into
  // one patch. A separate affordance keeps them apart, exactly as the api layer
  // keeps the two calls apart.
  const docMutation = useSetSkillDocumentNumber();

  const [query, setQuery] = useState("");
  const [newName, setNewName] = useState("");
  const [newOwner, setNewOwner] = useState("");
  // ⭐ OPTIONAL ON CREATE. A training with no document number is ordinary — most
  // are, on a young company — so this is never required, and `createSkill`
  // normalises a blank to `null` rather than storing an empty string in the
  // per-owner unique index.
  const [newDocNumber, setNewDocNumber] = useState("");
  const [newErrors, setNewErrors] = useState<{ name: string | null; owner: string | null }>({
    name: null,
    owner: null,
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editOwner, setEditOwner] = useState("");
  // ⭐ THE DOCUMENT-NUMBER EDITOR IS INDEPENDENT of the name/owner one — its own
  // open-row id and its own draft — so changing a number never opens the move
  // machinery and a half-typed rename never carries a number with it.
  const [editingDocId, setEditingDocId] = useState<string | null>(null);
  const [docDraft, setDocDraft] = useState("");
  // ⭐⭐ THE MOVE ASKS BEFORE IT ACTS, AND ONLY WHEN IT COSTS SOMEBODY
  // SOMETHING. Set by Save when the owner really changed and
  // `previewTrainingMove` found holders or places in the way; the write does not
  // happen until the button in that box is pressed. `DeleteDialog`'s second
  // decision is why it is conditional rather than always: a confirmation shown
  // for a move that costs nothing is how people learn to click past the one
  // that matters.
  const [movingId, setMovingId] = useState<string | null>(null);
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
  // ⭐⭐ THE THREE READS THE MOVE PREVIEW IS MADE OF, AND `fetchOperatorsAdmin`
  // ALREADY RETURNS ALL THREE. That is the whole reason this screen can warn
  // about a move without a second round trip: `DeleteDialog` must ask
  // `deletion_preview` and disable its buttons until the answer lands, whereas
  // the answer here is already in the same cache entry the list came from. No
  // new read, no new spinner, and no window in which the box is on screen not
  // yet knowing what it is confirming.
  const operators = useMemo(() => data?.operators ?? [], [data]);
  const operatorSkills = useMemo(() => data?.operatorSkills ?? [], [data]);
  const requirements = useMemo(() => data?.requirements ?? [], [data]);

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
  const operatorsById = useMemo(() => new Map(operators.map((o) => [o.id, o])), [operators]);

  /* -- what names a row, when the owner's own name is not enough (R-258) --- */

  // ⭐⭐ THE LEAF NAME IS NOT A DISAMBIGUATOR AND `trainings.ts` SAYS SO OUT
  // LOUD: *"it is the LEAF name, so two 'Line 1's in different plants still
  // collide here."* That was recorded as a known edge and it is not one — it is
  // the ordinary shape of a company. `nodes` carries `unique (org_id,
  // parent_id, name)` (0001), which makes SIBLING names unique and says nothing
  // about names across the tree, so two plants each calling their first line
  // "Line A" is legal; `skills_owner_name_unique` (0031) then lets each of them
  // own a "Forklift". Both rows are legal, permanent, and — named by the leaf —
  // present a screen-reader user with two "Retire Forklift at Line A" buttons.
  //
  // ⭐ SO THE OWNER IS NAMED BY WHAT IS ACTUALLY UNIQUE: its PATH of names.
  // Sibling names being unique per parent is exactly what makes the whole path
  // unique within the org, which is the property `trainingHandle` needs of the
  // label it is handed — and handing it in is what that function's header asks
  // for ("THE OWNER LABEL IS PASSED IN, NEVER RESOLVED HERE"), so this fix is a
  // choice of label rather than a second naming rule in the pure module.
  //
  // ⚠️ AND ONLY WHERE IT BUYS SOMETHING. `trainings.ts`'s objection to the path
  // — "read out in full on every button" — is right, so a leaf nothing else
  // answers to stays short and only an ambiguous one is spelled out. Ambiguity
  // is measured over EVERY READABLE NODE, not over the rows on screen: a name
  // that grew a path because the search box was typed in would be an accessible
  // name that moves under the reader, and the plant filter is a reversible view
  // choice that must not change what a control is called.
  //
  // ⚠️ CASE-FOLDED, because "Line A" and "line A" are two rows to the database
  // and one sound to a screen reader.
  //
  // ⚠️⚠️ IT CAN STILL COLLIDE IN ONE PLACE: an owner this client cannot resolve.
  // `scopeLabel` and `scopePathLabel` both answer "Somewhere else" for it, so
  // two same-named trainings owned by two DIFFERENT unreadable nodes remain
  // indistinguishable. There is nothing truthful left to say about a node we
  // cannot see, and inventing an id would name it after nothing; recorded here
  // rather than papered over.
  const ownerHandleLabels = useMemo(() => {
    const perName = new Map<string, number>();
    for (const n of nodes) {
      const key = n.name.trim().toLowerCase();
      perName.set(key, (perName.get(key) ?? 0) + 1);
    }
    return new Map(
      nodes.map((n) => [
        n.id,
        (perName.get(n.name.trim().toLowerCase()) ?? 0) > 1
          ? scopePathLabel(n.id, nodesById)
          : n.name,
      ]),
    );
  }, [nodes, nodesById]);

  /**
   * How a row's OWNER is spelled inside an accessible name — the leaf on its
   * own where that is unambiguous, the full path where it is not.
   *
   * ⚠️ FALLS BACK TO `scopeLabel`, which answers "Somewhere else" for a node
   * this client never received. Same string, same fail-open reading as
   * everywhere else on this screen.
   */
  function ownerHandleLabel(nodeId: string): string {
    return ownerHandleLabels.get(nodeId) ?? scopeLabel(nodeId, nodesById);
  }

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
  const editingGone = editingId !== null && !inPlantIds.has(editingId);
  const confirmingGone = confirmingId !== null && !inPlantIds.has(confirmingId);
  // ⚠️ THE MOVE CONFIRMATION IS CLOSED BY THE SAME RULE AND FOR A SHARPER
  // REASON. It carries a COUNT computed against a destination the reader picked
  // from a list the filter has just changed; leaving it up would be a sentence
  // about a move that can no longer be made, over a button that would make a
  // different one.
  const movingGone = movingId !== null && !inPlantIds.has(movingId);
  // ⚠️ THE DOCUMENT-NUMBER EDITOR CLOSES BY THE SAME RULE. It is an open box on
  // a row, so widening back to a plant that no longer holds the row must not
  // leave it up to be saved against a row that has gone.
  const docGone = editingDocId !== null && !inPlantIds.has(editingDocId);
  useEffect(() => {
    // Booleans, not the id set, as the dependencies: a fresh `Set` every render
    // would make this an effect that runs every render and clears nothing.
    if (editingGone) setEditingId(null);
    if (confirmingGone) setConfirmingId(null);
    if (movingGone) setMovingId(null);
    if (docGone) setEditingDocId(null);
  }, [editingGone, confirmingGone, movingGone, docGone]);

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

  /**
   * Save a document number — trimmed, and a blank CLEARS it to `null`.
   *
   * ⚠️ ITS ERRORS GO THROUGH `describeDocumentNumberRefusal`, NEVER
   * `onRowError`. `onRowError` describes a name/owner refusal, and a
   * `DuplicateValue` here is the NUMBER clashing, not the name — sending it
   * through the shared row-error path would tell the reader to rename a training
   * whose name was never in the way.
   */
  function saveDocNumber(row: TrainingRow) {
    const trimmed = docDraft.trim();
    clearRowError(row.id);
    setRowNotice(null);
    docMutation.mutate(
      { id: row.id, externalId: trimmed === "" ? null : trimmed },
      {
        onSuccess: () => setEditingDocId((cur) => (cur === row.id ? null : cur)),
        onError: (err: SchedulerError) =>
          setRowError({
            id: row.id,
            message: describeDocumentNumberRefusal(err, describeSchedulerError(err)),
          }),
      },
    );
  }

  /**
   * ⚠️⚠️ `siteNodeId` IS SENT ONLY WHEN IT REALLY CHANGED, and that is the
   * absent-key contract in `updateSkill` earning its keep rather than a
   * micro-optimisation. Under 0028 the owner is one side of the comparability
   * test every holder is measured against, so a rename that helpfully resent
   * the current owner would be a MOVE — same value, same trigger, and one day
   * the same value arriving from a stale render.
   */
  function commitEdit(row: TrainingRow, name: string, siteNodeId: string | null) {
    updateMutation.mutate(
      siteNodeId === null ? { id: row.id, name } : { id: row.id, name, siteNodeId },
      {
        onSuccess: () => {
          setEditingId((cur) => (cur === row.id ? null : cur));
          setMovingId((cur) => (cur === row.id ? null : cur));
        },
        onError: onRowError(row.id),
      },
    );
  }

  /**
   * Save the edit — or, when the owner changed and somebody is in the way, stop
   * and ask first.
   *
   * ⚠️ VALIDATED THROUGH THE SAME FUNCTION THE ADD FORM USES, owner included. A
   * second, laxer rule for the same field is how two forms end up disagreeing
   * about what a legal name is — and since 0031 the owner decides whether the
   * name is legal at all, so an edit that moves the row is asking a different
   * uniqueness question from the one the reader typed under.
   */
  function saveEdit(row: TrainingRow, move: { to: string; preview: TrainingMovePreview } | null) {
    const result = validateTrainingDraft({
      name: editName,
      siteNodeId: move === null ? row.siteNodeId : move.to,
    });
    if (!result.ok) {
      setRowError({ id: row.id, message: result.nameError ?? result.ownerError ?? "" });
      return;
    }
    clearRowError(row.id);
    if (move === null) {
      commitEdit(row, result.value.name, null);
      return;
    }
    // ⭐ THE ONE PLACE THE WARNING IS ENFORCED. A costly move never reaches the
    // api layer from here; it reaches `movingId`, which draws the box.
    if (moveCosts(move.preview)) {
      setMovingId(row.id);
      return;
    }
    commitEdit(row, result.value.name, move.to);
  }

  /** The button inside the confirmation. Re-validates: the name box is still live. */
  function confirmMove(row: TrainingRow, to: string) {
    const result = validateTrainingDraft({ name: editName, siteNodeId: to });
    if (!result.ok) {
      setMovingId(null);
      setRowError({ id: row.id, message: result.nameError ?? result.ownerError ?? "" });
      return;
    }
    commitEdit(row, result.value.name, to);
  }

  /**
   * Everybody this client can see who holds `skillId`.
   *
   * ⚠️ AN UNRESOLVABLE PERSON OR NODE BECOMES `ownerPath: null`, WHICH
   * `previewTrainingMove` COUNTS AS STRANDED. That is the one fail-CLOSED door
   * in this feature and that function's header argues it: the output is a
   * sentence and blocks nothing, so a name too many costs a sentence and a name
   * too few hides a consequence nobody will connect to this press.
   */
  function holdersOf(skillId: string) {
    return operatorSkills
      .filter((os) => os.skillId === skillId)
      .map((os) => {
        const person = operatorsById.get(os.operatorId);
        return {
          operatorId: os.operatorId,
          name: person?.displayName ?? "Someone you can’t see",
          ownerPath: person === undefined ? null : (nodesById.get(person.siteNodeId)?.path ?? null),
        };
      });
  }

  /** Every place that requires `skillId` — the half the SERVER refuses over. */
  function placesRequiring(skillId: string) {
    return requirements
      .filter((r) => r.skillId === skillId)
      .map((r) => {
        const node = nodesById.get(r.nodeId);
        return { nodeId: r.nodeId, name: node?.name ?? "Somewhere else", path: node?.path ?? null };
      });
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
    // ⭐ THE NUMBER RIDES ALONG ONLY WHEN ONE WAS TYPED. `createSkill` maps `""`
    // and an absent key alike to `null`, so an untouched box adds nothing to the
    // payload rather than storing a blank in the per-owner unique index.
    const doc = newDocNumber.trim();
    createMutation.mutate(
      {
        // `skills.org_id` has no default — it comes from the session profile on
        // every insert, never from a database default that is not there.
        orgId,
        name: result.value.name,
        siteNodeId: result.value.siteNodeId,
        ...(doc === "" ? {} : { externalId: doc }),
      },
      {
        onSuccess: () => {
          setNewName("");
          setNewDocNumber("");
        },
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
    //
    // ⚠️ NAMED WITH `ownerHandleLabel`, NOT `owner`. The COLUMN shows the leaf
    // (with the path as its tooltip) because a sighted reader has the column
    // beside it to compare; a spoken name has nothing beside it, so where the
    // leaf is shared it is spelled out in full. See `ownerHandleLabels`.
    const handle = trainingHandle(row.name, ownerHandleLabel(row.siteNodeId));
    // ⭐⭐ THE PREVIEW, AND IT IS ASKED WITH THE OWNER'S **PATH**, never its id.
    // `app_can_edit_node` compares `n.path <@ gp`, and the path is the same
    // value the server compares — walking parents to rebuild it would be a
    // second implementation of ancestry that can disagree with the first
    // (`scope.ts`'s call). ⚠️ `?? null` IS THE FAIL-OPEN DOOR: an owner this
    // client cannot resolve means "I cannot tell", and `canEditNode` answers
    // yes so the server gets to refuse out loud.
    const editable = canEdit(nodesById.get(row.siteNodeId)?.path ?? null);
    // ⚠️ `editable` OVERRIDES EVERY OPEN STATE rather than sitting beside them.
    // The grant read lands AFTER the list, so an edit box, a move confirmation
    // or a delete dialog can already be open on a row that turns out to be
    // read-only; leaving them up would be a Save button on a row whose Edit has
    // just been withdrawn.
    const isEditing = editable && editingId === row.id;
    const isConfirming = editable && confirmingId === row.id;
    // ⚠️ GATED ON `editable` TOO — `skills` document-number writes ride the same
    // `app_can_edit_node` policy as rename and retire, so a box open on a row
    // that turns out read-only closes with the rest of the controls rather than
    // becoming the one live write on a row that has just said no.
    const isEditingDoc = editable && editingDocId === row.id;

    /* -- where the edit form would send it ------------------------------- */

    // ⚠️⚠️ THE ROW'S OWN HOME MUST BE ONE OF THE OPTIONS OR THERE IS NO PICKER.
    // A `<select>` handed a value none of its options carries renders its FIRST
    // option and reports nothing — which here would not be a cosmetic slip: the
    // reader would open Edit to fix a typo, press Save, and silently move the
    // training to whatever happened to sort first. The add form documents the
    // same trap; there the cost is a create in the wrong place, here it is a
    // move nobody asked for.
    const ownerOffered = owners.some((o) => o.value === row.siteNodeId);
    // Falls back to the ROW'S OWN OWNER, never to `owners[0]` — see above. The
    // draft is shared across rows, so this is also what stops a value left
    // behind on one row leaking into the next one opened.
    const editOwnerValue = owners.some((o) => o.value === editOwner) ? editOwner : row.siteNodeId;
    // ⚠️ A DESTINATION THIS CLIENT CANNOT PLACE IS NOT A DESTINATION. Without
    // the node we have no path, so `previewTrainingMove` cannot say who it
    // strands — and moving on an unanswerable question is exactly what this
    // whole section exists to stop. Unreachable by construction (`owners` is
    // built from nodes we hold), and kept because "unreachable" is a claim
    // about a read.
    const nextOwnerNode = ownerOffered ? (nodesById.get(editOwnerValue) ?? null) : null;
    const move =
      nextOwnerNode === null || nextOwnerNode.id === row.siteNodeId
        ? null
        : {
            to: nextOwnerNode.id,
            label: scopeLabel(nextOwnerNode.id, nodesById),
            preview: previewTrainingMove(
              {
                newOwnerPath: nextOwnerNode.path,
                holders: holdersOf(row.id),
                requiredAt: placesRequiring(row.id),
              },
              // ⭐ THE REAL `isAtOrBelow`, injected. `trainings.ts` has no
              // runtime imports, and a second ancestry test living there could
              // disagree with the one the rest of the client — and the server —
              // compares with.
              isAtOrBelow,
            ),
          };
    const isMoving = isEditing && move !== null && movingId === row.id;
    const summary =
      isMoving && move !== null ? summariseTrainingMove(move.preview, move.label) : null;
    const stranded = isMoving && move !== null ? listStrandedHolders(move.preview) : null;
    const err = rowError !== null && rowError.id === row.id ? rowError.message : null;
    const notice = rowNotice !== null && rowNotice.id === row.id ? rowNotice.message : null;

    return (
      <li key={row.id} className={row.active ? styles.row : `${styles.row} ${styles.retired}`}>
        {isEditing ? (
          <input
            className={styles.input}
            value={editName}
            /* ⚠️ NAMED FOR ITS ROW, not just for its field. The Add card one
               card up has a box whose visible label is also "Name". */
            aria-label={`Name for ${handle}`}
            onChange={(e) => setEditName(e.target.value)}
          />
        ) : (
          <span className={styles.name}>{row.name}</span>
        )}

        {/* ⭐ THE DOCUMENT NUMBER IS ITS OWN COLUMN — a distinct fact from the
            name (the maintainer, 1 Sept), lifted out of the full-width line it
            used to take under the name, which "could get messy and long very
            easily". It sits SECOND, between the name and the owner, because that
            is the order the maintainer asked for: a reader scans a name and its
            number together. The VALUE shows on every row, read-only ones
            included: it is worth reading whether or not this reader may change it.
            The EDITOR is gated on `editable`, so no refused control survives.
            ⚠️ NO PER-ROW VISIBLE LABEL — the column header names it, exactly as
            the owner column carries none. The editor's controls still name their
            row (0031 lets two share a name), so a screen-reader user is never left
            choosing between identical fields. ⚠️ THE EDITOR WRAPS WITHIN THE CELL
            (`.docCell`), never onto the name column: only this row grows. */}
        <span className={styles.docCell}>
          {isEditingDoc ? (
            <>
              <input
                className={styles.input}
                value={docDraft}
                aria-label={`Document number for ${handle}`}
                onChange={(e) => setDocDraft(e.target.value)}
              />
              <button
                type="button"
                className={styles.primary}
                aria-label={`Save the document number for ${handle}`}
                onClick={() => saveDocNumber(row)}
              >
                Save
              </button>
              <button
                type="button"
                className={styles.quiet}
                aria-label={`Stop editing the document number for ${handle}`}
                onClick={() => setEditingDocId(null)}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              {documentNumberLabel(row.externalId)}
              {editable && (
                <button
                  type="button"
                  className={styles.quiet}
                  aria-label={`Edit the document number for ${handle}`}
                  onClick={() => {
                    clearRowError(row.id);
                    setRowNotice(null);
                    setEditingDocId(row.id);
                    // Seeded to what is there so a change is an edit, not a
                    // retype; `null` seeds a blank box that clears on save.
                    setDocDraft(row.externalId ?? "");
                  }}
                >
                  Edit
                </button>
              )}
            </>
          )}
        </span>

        {/* ⭐ THE OWNER IS A COLUMN, NEVER PART OF THE NAME. The demo seed used
            to spell the plant into the text (`A-Welding`); read from the column
            instead it follows a node rename for free, and 0031 drops the prefix.
            ⚠️ THE FULL PATH IS THE TOOLTIP, because `scopeLabel` gives the
            leaf's own name and two plants can each have a "Line 1".

            ⭐⭐ AND WHILE EDITING IT IS THE PICKER — THE SAME ONE THE ADD FORM
            USES, narrowed by the plant filter in exactly the same way. Where a
            training belongs was a create-only choice until now (D105), and the
            column that DISPLAYED it is the honest place for the control that
            changes it: the reader edits the answer where they read it, and the
            two can never show different things. */}
        {isEditing && ownerOffered ? (
          <select
            className={styles.input}
            value={editOwnerValue}
            /* ⚠️ NAMED FOR ITS ROW. The Add card's picker is visibly labelled
               "Belongs to" and is on screen at the same time. */
            aria-label={`Where ${handle} belongs`}
            onChange={(e) => {
              // ⚠️ A NEW DESTINATION VOIDS THE OLD CONFIRMATION. The count in
              // that box is about the place they just stopped choosing.
              setMovingId(null);
              setEditOwner(e.target.value);
            }}
          >
            {owners.map((o) => (
              <option key={o.value} value={o.value}>
                {ownerLabels.get(o.value)}
              </option>
            ))}
          </select>
        ) : (
          <span className={styles.owner} title={scopePathLabel(row.siteNodeId, nodesById)}>
            {owner}
          </span>
        )}

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
            {isEditing ? (
              <>
                <button
                  type="button"
                  className={styles.primary}
                  aria-label={`Save changes to ${handle}`}
                  onClick={() => saveEdit(row, move)}
                >
                  Save
                </button>
                <button
                  type="button"
                  className={styles.quiet}
                  aria-label={`Stop editing ${handle}`}
                  onClick={() => {
                    setEditingId(null);
                    setMovingId(null);
                  }}
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
                {/* ⭐⭐ IT SAID "RENAME", AND THE COMMENT HERE ARGUED FOR IT:
                  *"narrower than `ProductsPanel`'s 'Edit' on purpose: the form
                  behind it changes the name and NOTHING ELSE, because the api
                  layer has no write that moves a training to another owner."*
                  That was true and it was D105's gap wearing an honest label.
                  `updateSkill` is the missing write, so the form behind this
                  now changes the name AND where it belongs — and D106 forbids a
                  control named after LESS than it does just as firmly as one
                  named after more. The button had to be renamed the moment the
                  write landed, which is why it is renamed in the same change. */}
                <button
                  type="button"
                  className={styles.quiet}
                  aria-label={`Edit ${handle}`}
                  onClick={() => {
                    clearRowError(row.id);
                    setConfirmingId(null);
                    setMovingId(null);
                    setEditingId(row.id);
                    setEditName(row.name);
                    setEditOwner(row.siteNodeId);
                  }}
                >
                  Edit
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

        {/* ⚠️ THE PICKER IS ABSENT, SO SAY SO. Reachable only when the row's
            own home is not among the offered nodes — `rowsInPlant` fails open on
            an owner it cannot resolve and shows the row anyway. A control that
            silently is not there looks exactly like a screen that never had
            one, which is `scope.ts`'s rule about hiding, one control down. */}
        {isEditing && !ownerOffered && (
          <span className={styles.readOnly}>
            Where this belongs can&rsquo;t be changed here &mdash; we can&rsquo;t place its current
            home. The name still can.
          </span>
        )}

        {/* ⭐⭐ WHAT THE MOVE COSTS, BEFORE THE MOVE. Measured on the running
            database, 31 August: `app_guard_operator_skill_scope` is a trigger on
            `operator_skills` and NOTHING re-checks it when `skills` moves out
            from under those rows, so a move that strands holders is allowed and
            silent. `previewTrainingMove`'s header carries all five observations.
            This box is the only thing that stands between that and a person
            finding out months later.
            ⚠️ IT IS NOT A DIALOG AND IT IS NOT MODAL. The name box and the
            picker above stay live on purpose — the answer to "3 people?" is
            often "then send it somewhere else", and a modal would make changing
            the destination require dismissing the thing that explained why. */}
        {isMoving && summary !== null && move !== null && stranded !== null && (
          <div className={styles.confirm} role="group" aria-label={`Move ${handle}`}>
            <p className={styles.headline}>{summary.headline}</p>
            {summary.costs.map((line) => (
              <p key={line} className={styles.cost}>
                {line}
              </p>
            ))}
            {/* ⭐ THE NAMES, NOT ONLY THE COUNT. "3 people" is a number to
                accept; three names are three people to go and ask. */}
            {stranded.names.length > 0 && (
              <ul className={styles.names}>
                {stranded.names.map((n) => (
                  <li key={n}>{n}</li>
                ))}
                {stranded.more !== null && <li>{stranded.more}</li>}
              </ul>
            )}
            <span className={styles.actions}>
              {/* ⚠️⚠️ NO CONFIRM BUTTON AT ALL WHEN THE SERVER WILL REFUSE.
                  `app_guard_skill_rehome` (0028 §5) really does raise on a
                  stranded requirement, so this is the same call `clashBlocks`
                  makes on the add form — the client withholds only what the
                  database also refuses, never the converse. */}
              {!summary.refused && (
                <button
                  type="button"
                  className={styles.primary}
                  aria-label={`${summary.confirmLabel} — ${handle}`}
                  onClick={() => confirmMove(row, move.to)}
                >
                  {summary.confirmLabel}
                </button>
              )}
              <button
                type="button"
                className={styles.quiet}
                aria-label={`Leave ${handle} where it is`}
                onClick={() => setMovingId(null)}
              >
                Keep it where it is
              </button>
            </span>
          </div>
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
            {/* ⭐ OPTIONAL, AND A DISTINCT FIELD FROM THE NAME. Most trainings
                carry a document number (the maintainer, 1 Sept) but a new one
                need not — a blank is normalised to `null` in `createSkill`, so an
                untouched box never sits in the per-owner unique index. Visibly
                labelled apart from "Name" so the two boxes are told apart. */}
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Document number</span>
              <input
                className={styles.input}
                value={newDocNumber}
                onChange={(e) => setNewDocNumber(e.target.value)}
              />
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
                // The SAME label the row's own controls use, so this button and
                // that row name one thing in one way.
                ownerHandleLabel(clashRow.siteNodeId),
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
              <span>Document number</span>
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

        {/* ⭐ THIS PARAGRAPH USED TO SAY WHERE A TRAINING BELONGS *"can't be
            moved afterwards yet"*, which was D105's gap recorded on screen
            rather than hidden. `updateSkill` closes it, so the sentence had to
            go with it — a hint that describes a limit the screen no longer has
            is worse than no hint, because it stops people looking for a control
            that is right there. What replaces it is the thing the reader cannot
            see from the button: a move is not free. */}
        <p className={styles.hint}>
          Edit changes a training&rsquo;s name, where it belongs, or both. Moving one can leave
          people holding it from somewhere it no longer reaches &mdash; you&rsquo;ll be told how
          many, and who, before anything happens. Retiring one keeps it on everyone who already
          holds it; deleting one takes it off them.
        </p>
      </section>
    </div>
  );
}
