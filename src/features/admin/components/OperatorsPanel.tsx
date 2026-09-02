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
  operatorRows,
  placeVerdict,
  placesUnderSameRoot,
  resolveSelectedOperator,
  rootIdFor,
  summarisePlaces,
  validateOperatorDraft,
  workPlacesFor,
  type OperatorLike,
  type PlaceVerdict,
} from "../lib/operators";
import { buildColumns, buildOperatorMatrix, type CellState } from "../lib/matrix";
import {
  EXPIRING_WINDOW_DAYS,
  MatrixChip,
  MatrixLegend,
  RecordPopover,
  STATE_LABEL,
  type RecordFields,
} from "./matrixCells";
import type { OperatorSkillRecord } from "@/lib/api";
// ⚠️ THE SCOPE HELPERS ARE IMPORTED HERE AND NOT INTO `../lib/operators`. That
// module is dependency-free by design — its header says so, and that is what
// lets `operators.test.ts` run it under `node --experimental-strip-types`. An
// id becomes a node NAME on this side of the line, in the one place that
// already owns `nodesById`.
import { indentedLabel, scopeLabel, scopeOptions, scopePathLabel } from "../lib/scope";
import { nodesInPlant, rowsInPlant } from "../lib/plantFilter";
import { usePlantFilter } from "../hooks/usePlantFilter";
import {
  useCreateOperator,
  useGrantSkill,
  useOperatorsAdmin,
  useRevokeSkill,
  useSetOperatorActive,
  useUpdateOperator,
  useUpdateSkillRecord,
} from "../hooks/useOperators";
import { DeleteDialog } from "./DeleteDialog";
import styles from "./OperatorsPanel.module.css";

/**
 * ⭐ THE SHAPE OF THIS SCREEN, IN THE USER'S OWN WORDS:
 *
 *     "The essence of this is simply: is the operator trained to work in this
 *      particular work cell — a simple yes/no."
 *
 * So this panel LEADS WITH WHERE A PERSON CAN WORK. Pick somebody; see the
 * schedulable places, each with a tick, or a cross and the reason for it
 * ("missing Forklift", "Welding expires 3 Sep 2026"). Trainings are the second
 * section, not the first, because they are how you CHANGE that answer rather
 * than the vocabulary the screen speaks — granting one turns several crosses
 * green at once, and nobody has to touch a cell to do it.
 *
 * ⭐⭐ THE TRAINING CATALOGUE IS NOT MANAGED HERE ANY MORE — roadmap stage 22.
 * Creating, renaming and deleting a training TYPE moved to `TrainingsPanel`,
 * its own admin tab beside Operators, Shifts and Products. What stayed is
 * GIVING one to the person on screen: the list of what they hold, its expiry,
 * Attach and Remove. The distinction is the whole of the split — a type is a
 * thing the company owns and a grant is a fact about a person, and only the
 * second one belongs on a screen headed with somebody's name.
 *
 * ⭐⭐ AND THE ADD FORM RECORDS THE SAME THREE FACTS THE LIST ABOVE IT SHOWS.
 * The maintainer, after using the screen: *"for adding a training, there is no
 * option to add a signed off by and trained on which the section above it has,
 * this is a loss of continuity which needs to be fixed."* Attaching used to
 * record the expiry alone, so the ordinary gesture was attach-then-correct: the
 * supervisor typed the date and the signer into the row that appeared, entering
 * one record in two goes, with the form and the list disagreeing about what a
 * training record even IS. `GrantSkillInput` has carried both fields since 0032
 * / D114 and nothing passed them.
 *
 * ⚠️ THE TWO STAY OPTIONAL AND INDEPENDENT, exactly as they are on a held row.
 * 0032 deliberately writes no CHECK tying the date to the signer, because a
 * half-known record is the ORDINARY case — a spreadsheet arrives with one
 * column filled in. So neither box enables the other, neither clears the other,
 * and Attach goes on asking only for a training to attach.
 *
 * ⚠️ THE MAINTAINER'S WORD IS "TRAINING", AND IT WINS OVER BOTH OF THE OTHERS.
 * The database calls these rows `skills` / `operator_skills` and this screen
 * used to call them "tickets". What a user READS says training, everywhere;
 * what the code calls itself still mirrors the api (`useGrantSkill`,
 * `skillId`, `SkillLike`), because renaming the database's vocabulary is a
 * different and much larger change.
 *
 * ⭐⭐ THREE MARKS, NOT TWO, AND THE THIRD ONE IS WHY THIS LIST IS HONEST.
 * There are two server rules behind this answer, not one: the trainings
 * (`check_eligibility`) and the AREA a person belongs to
 * (`app_guard_assignment_scope`, 0028 / D109). Until this was fixed the list
 * asked only about trainings, so it ticked cells in plants the person cannot
 * be booked into at all — a stale PERMISSION, the screen saying yes where the
 * server says no. `../lib/operators` carries the full account.
 *
 * ⭐⭐ AND THE HEADER SAYS WHERE THE PERSON BELONGS, WITHOUT AN EDIT MODE. The
 * maintainer: *"does not show where they belong until you hit edit, not the end
 * of the world but breaks the info flow."* It looks cosmetic and is not: since
 * 0028 / D109 where somebody belongs decides WHERE THEY CAN BE BOOKED, and the
 * places list directly under the header — including its "0 of 2 places in their
 * own area" — is computed from that one field. A reader who cannot see the area
 * has no way to check the number the screen just gave them.
 *
 * ⚠️ THE LEAF NAME IS SHOWN AND THE FULL PATH IS THE `title`, which is
 * `scope.ts`'s pair (`scopeLabel` / `scopePathLabel`) doing the same job it does
 * on every other admin screen. Three plants can all hold a "Line 1", so the leaf
 * alone is ambiguous and the path alone is too long to sit in a header.
 *
 * ⭐⭐ AND THE LIST STOPS AT THE PERSON'S OWN PLANT — THE MAINTAINER, 31 AUG,
 * AFTER SEEING THE THREE STATES: *"I see all plants not just Plant A for him,
 * it does say that he's not from this area for other plants, but those
 * locations should not be visible at all is my point."* A system admin can
 * read every node in the org, so this list was every schedulable cell in the
 * company — eighteen across three plants for somebody who works on one line.
 * **Annotating them was not enough.** `placesUnderSameRoot` trims to the root
 * the selected person's own area sits under, and it does so for EVERY
 * operator, not just the one who found it.
 *
 * ⚠️ THE CUT IS THE ROOT, NOT THEIR OWN AREA, AND THAT IS WHY THE ⚠ STATE
 * SURVIVES. Lending somebody from Line 1 to Line 2 in the same plant is a
 * thing supervisors do and D113 exists for it, so those places stay, annotated
 * the same way `CreatePopover` annotates them ("not from this area
 * (override)"). Cutting at their own area instead would have deleted the third
 * state from this screen and made D113's door invisible here.
 *
 * ⭐⭐ AND THE READER'S OWN PLANT FILTER IS A SECOND CUT OF A DIFFERENT KIND —
 * roadmap 1(c). The maintainer, 31 Aug: *"for the system admin, may be we need
 * a filter for plants in all the sub tabs."* `AdminPage` owns the one control
 * and names the chosen plant in its header; this panel only READS the choice
 * (`usePlantFilter`) and applies it to the people list, the trainings on offer
 * and both "Belongs to" pickers. It renders no control of its own — six
 * per-panel filters would be six controls that drift apart.
 *
 * ⚠️⚠️ IT DOES NOT REPLACE `placesUnderSameRoot` AND THE TWO MUST NOT BE
 * MERGED. They answer different questions: the filter is a CHOICE THE READER
 * MADE about which plant this screen is about, and `placesUnderSameRoot` is
 * derived from the SELECTED PERSON'S own root with no input at all. They
 * COMPOSE — somebody appears in the left list only when they are in the chosen
 * plant, and their places are then trimmed to their own root. Folding either
 * into the other reads as identical on the day they agree and deletes one of
 * them on the day they do not, which is every reader sitting on "All plants".
 *
 * ⚠️ WHAT IS TRIMMED IS COUNTED, in a footnote under the list — both trims,
 * separately. `scope.ts`'s header records the reason: hiding is invisible and
 * permanent, and a list that quietly shrank looks exactly like a person with no
 * options, or like a company nobody has added anybody to yet.
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

/**
 * The three place verdicts, as chips that borrow the matrix chip's SHAPE and
 * colour but name their own answers. `placeVerdict` stays in `../lib/operators`
 * beside the rule it reads (this and `operators.test.ts` cannot drift), and the
 * mark is decorative here — the visually-hidden reason beside each chip is what
 * a screen reader speaks, and colour is never the only signal (D100).
 *
 * ⚠️ THE COLOUR ROLES ARE BORROWED, NOT THE MEANINGS. A `missing-training`
 * place reuses the "missing" chip because both are a red gap; `outside-area`
 * reuses the amber "expiring" colour because both are a warning, not a refusal
 * (D113 lets somebody be scheduled there with a recorded reason). The glyph and
 * the legend name the PLACE verdict, so the two are never read as the training
 * states they borrow their paint from.
 */
const PLACE_CHIP: Record<PlaceVerdict, { state: CellState; glyph: string; label: string }> = {
  "can-work": { state: "trained", glyph: "✓", label: "Can work here" },
  "missing-training": { state: "missing", glyph: "×", label: "Missing a training" },
  "outside-area": { state: "expiring", glyph: "⚠", label: "Outside their area" },
};

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

  /* ---------------------------------------------------------------------
   * ⭐⭐ RECORD-IN-PLACE, THE SAME GESTURE THE TEAM MATRIX USES. The trainings
   * a person holds are now a row of matrix cells; clicking one opens the shared
   * `RecordPopover`, which records the same three facts a held row always showed
   * — certified on, expires, signed off by — kept optional and independent (0032
   * / D114 writes no CHECK tying them). This state is only WHICH cell's popover
   * is open and where; the popover owns the three fields, keyed by the cell so a
   * fresh one never inherits the last cell's text.
   * ------------------------------------------------------------------- */
  const [editingCell, setEditingCell] = useState<{
    skillId: string;
    top: number;
    left: number;
  } | null>(null);

  const createOperator = useCreateOperator();
  const updateOperator = useUpdateOperator();
  const setActive = useSetOperatorActive();
  const grantSkill = useGrantSkill();
  const updateRecord = useUpdateSkillRecord();
  const revokeSkill = useRevokeSkill();

  // ⚠️ MEMOISED, not inlined `?? []`. A fresh `[]` on every render is a new
  // identity, so every `useMemo` below it recomputes every time and the
  // dependency lint says so. `data` itself is stable between refetches.
  const operators = useMemo<readonly OperatorLike[]>(() => data?.operators ?? [], [data]);
  const operatorSkills = useMemo(() => data?.operatorSkills ?? [], [data]);
  // Same reason, and one more: `usePlantFilter` memoises on the array it is
  // handed, so a fresh `[]` here would hand every derivation below a brand new
  // `plant` object on every single render.
  const nodes = useMemo(() => data?.nodes ?? [], [data]);

  // ⚠️ MEMOISED so the derivations below have a stable map identity, and
  // because `scopeChoices` rebuilds from the same array on every render today.
  //
  // ⭐ BUILT FROM EVERY READABLE NODE, NEVER FROM THE PLANT-FILTERED SET.
  // `rowsInPlant` has to resolve the owner of a row it is about to EXCLUDE, and
  // it fails open on an owner it cannot find — so a map built from the filtered
  // nodes would fail open on precisely the rows the filter exists to drop, and
  // the filter would appear to do nothing at all.
  const nodesById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  /* ---------------------------------------------------------------------
   * ⭐⭐ WHICH PLANT THIS SCREEN IS ABOUT — roadmap 1(c). See the header.
   * The control lives on `AdminPage`, which also names the choice in the
   * header of every section; this panel reads it and renders no control.
   * `choice === null` is "All plants" and every helper below is then a no-op,
   * so nothing here has to special-case it.
   * ------------------------------------------------------------------- */
  const plant = usePlantFilter(nodes);

  // ⭐ THE LIST AS IT WOULD BE WITH NO PLANT FILTER, KEPT SO THE TRIM CAN BE
  // COUNTED. `scope.ts`'s header is the reason it is not simply dropped:
  // hiding is invisible and permanent, and a list that quietly shrank looks
  // exactly like a company nobody has added anybody to.
  const allRows = useMemo(
    () => operatorRows(operators, operatorSkills, { query, includeInactive }),
    [operators, operatorSkills, query, includeInactive],
  );
  const rows = useMemo(
    () => rowsInPlant(allRows, plant.choice, plant.plants, nodesById),
    [allRows, plant.choice, plant.plants, nodesById],
  );
  // ⚠️ COUNTED AGAINST THE SAME SEARCH, not against the whole company. The
  // footnote sits under a list "Find someone" has already narrowed, and a
  // number ignoring the search would name people the reader cannot reach from
  // where they are standing — the same reason the places headline counts what
  // the list actually shows rather than all of `places`.
  const hiddenPeople = allRows.length - rows.length;

  // ⚠️ THE SELECTION IS RESOLVED AGAINST THE PLANT, NOT AGAINST `rows`. `rows`
  // is also narrowed by the search box and the deactivated toggle, and typing
  // in "Find someone" must not close the person being read: that narrows the
  // LIST, it does not say they are gone. The plant filter says exactly that.
  const peopleInPlant = useMemo(
    () => rowsInPlant(operators, plant.choice, plant.plants, nodesById),
    [operators, plant.choice, plant.plants, nodesById],
  );
  const selected = resolveSelectedOperator(peopleInPlant, selectedId);

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

  // ⭐ TWO TRIMS, IN THIS ORDER, AND THE ORDER IS THE POINT. First to the
  // person's own plant (see the header), then to the places that are active
  // inside it — so "1 deactivated place is not shown" refers to something in
  // their own plant, which is the only place a reader can act on it.
  //
  // ⚠️ THE READER'S PLANT FILTER IS NOT A THIRD TRIM HERE, AND MUST NOT BECOME
  // ONE. It has already decided WHETHER this person is on screen at all;
  // `placesUnderSameRoot` then trims THEIR places to THEIR OWN root, which on
  // "All plants" is a root the reader never chose. Running the filter over the
  // places as well would be a no-op whenever the two agree and would silently
  // re-cut the list to the reader's plant rather than the person's whenever
  // they do not. The two rules compose; neither is the other. See the header.
  const sitePlaces =
    selected === null ? places : placesUnderSameRoot(places, selected.siteNodeId, nodesById);
  const offSitePlaces = places.length - sitePlaces.length;
  const ownRootId = selected === null ? null : rootIdFor(selected.siteNodeId, nodesById);
  const ownRootName = ownRootId === null ? null : (nodesById.get(ownRootId)?.name ?? null);

  // The headline counts the places the LIST ACTUALLY SHOWS. Summarising all of
  // `places` put "2 of 6 places" above five rows whenever a place was
  // deactivated — the reader has no way to reconcile the two numbers, and the
  // hidden ones are already accounted for by the footnotes below.
  const visiblePlaces = sitePlaces.filter((p) => p.active);
  const summary = summarisePlaces(visiblePlaces);
  const hiddenPlaces = sitePlaces.length - visiblePlaces.length;

  // ⭐⭐ "WHERE THEY CAN WORK", AS THE MATRIX. The maintainer, 2 September: draw
  // the places the same nested-header way, reaching DOWN TO THE CELL where work
  // is booked — the level the flat list already reached. Each schedulable place
  // is a column OWNED BY ITS PARENT, so the header climbs plant → area → line and
  // the cell's own name lands on the leaf column row rather than doubling as an
  // owner band; the three-state verdict rides each cell as a ✓ / ✕ / ⚠ chip.
  const levelsById = useMemo(
    () => new Map((data?.levels ?? []).map((l) => [l.id, l] as const)),
    [data],
  );
  const placesColumns = useMemo(
    () =>
      buildColumns(
        visiblePlaces.map((p) => ({
          id: p.nodeId,
          name: p.name,
          siteNodeId: nodesById.get(p.nodeId)?.parentId ?? p.nodeId,
          active: true,
          externalId: null,
        })),
        nodesById,
        levelsById,
      ),
    [visiblePlaces, nodesById, levelsById],
  );
  const placeByNode = useMemo(
    () => new Map(visiblePlaces.map((p) => [p.nodeId, p] as const)),
    [visiblePlaces],
  );

  // ⭐ THE TRAININGS FOR THE PERSON ON SCREEN, AS A MATRIX — the same visual the
  // team matrix draws, for one person. Columns are the trainings that apply to
  // them (owner an ancestor-or-self of their node) plus any they already hold,
  // and the header climbs their own branch DOWN TO WHERE THEY WORK. All of that
  // shaping is the pure `../lib/matrix`, tested by `src/test/matrix.test.ts`.
  //
  // ⚠️ `data.skills` / `data.operatorSkills`, NOT a plant-filtered set. The apply
  // test already narrows to this person's own branch, and a held training is
  // never dropped for the plant filter reaching past a view into the record.
  //
  // ⚠️ NON-APPLICABLE TRAININGS ARE NO LONGER OFFERED. The old "Add a training"
  // picker let you attach any training in the plant, including one owned by a
  // branch this person is not on; the matrix shows only what genuinely applies
  // (plus what they already hold), so a cross is always a gap you can fill and
  // the server would accept — the §19.72 rule, drawn.
  const operatorMatrix = useMemo(() => {
    if (selected === null || data === undefined) return null;
    return buildOperatorMatrix({
      nodes: data.nodes,
      levels: data.levels,
      skills: data.skills,
      operatorSkills: data.operatorSkills,
      operator: selected,
      today: todayIso(),
      windowDays: EXPIRING_WINDOW_DAYS,
    });
  }, [selected, data]);

  // The selected person's holdings, keyed by training id, for the popover.
  const opHoldings = useMemo(() => {
    const m = new Map<string, OperatorSkillRecord>();
    if (selected !== null) {
      for (const h of operatorSkills) if (h.operatorId === selected.id) m.set(h.skillId, h);
    }
    return m;
  }, [operatorSkills, selected]);

  // ⭐ EVERY NODE, NOT JUST ROOTS (0025 / D103). The maintainer, Aug 27: *"I do want to
  // be able to assign operators to a specific hierarchy level, there are
  // facilities where certain people can only work in certain areas."* Until
  // 0025 `operators_check_site` refused anything but a root, so this filtered
  // to `parentId === null`.
  //
  // ⚠️ THIS COMMENT USED TO SAY THE AREA WAS "PRESENTATION ONLY" AND THAT THE
  // SERVER DID NOT REFUSE AN ASSIGNMENT OUTSIDE IT. That was true when it was
  // written and has been false since migration 0028 / D109, whose
  // `app_guard_assignment_scope` refuses exactly that — and migration 0030 /
  // D113 then gave it the supervisor override, `assignments.area_override`
  // plus a required reason. So the field is LOAD-BEARING: it decides where
  // this person can be booked, and the list above says so in three states.
  // [[decision-record-drift]] rule 10 — a conclusion outliving its premise.
  //
  // ⭐ AND THE LIST IS NARROWED BY THE PLANT FILTER — decision 3: what you see
  // is what you can create in. The alternative lets somebody add a person into
  // a plant they have filtered away and then watch them not appear, which is
  // silent hiding wearing a form's clothes.
  //
  // ⚠️⚠️ THE FILTER GOES IN AS THE NODE ARRAY AND NEVER AS `scopeOptions`'
  // `canEdit`, AND THAT IS NOT A DETAIL. The two narrowings are different
  // kinds: the filter is a VIEW CHOICE and reversible, `canEdit` is a
  // PERMISSION and is not. Collapsing them would make a preference look like a
  // right, and the day somebody widened the filter it would silently widen what
  // this form claims they may write.
  const scopeNodes = useMemo(
    () => nodesInPlant(nodes, plant.choice, plant.plants),
    [nodes, plant.choice, plant.plants],
  );
  const scopeChoices = useMemo(() => scopeOptions(scopeNodes), [scopeNodes]);

  // The "Belongs to" value on the ADD form, kept legal by construction — the
  // same shape as `ProductsPanel`'s `ownerValue`, and load-bearing here for a
  // second reason: the plant filter can take the held node out of the list
  // while the half-filled form is still on screen. Falling back to the first
  // node on offer is also what stops the select DISPLAYING option one while the
  // state holds `""`, which is what it did from a cold load. `""` now survives
  // only when there is nothing to offer at all, and `addOperator` says so.
  const draftSiteValue = scopeChoices.some((o) => o.value === draftSite)
    ? draftSite
    : (scopeChoices[0]?.value ?? "");

  // ⚠️ THE EDIT FORM FALLS BACK THE OTHER WAY — TO NOTHING, NEVER TO THE FIRST
  // NODE. On the add form a default is a convenience; here it would MOVE
  // somebody, silently, to wherever the list happens to begin — and where a
  // person belongs decides where they can be booked (0028 / D109). `saveRename`
  // already refuses `""` with a sentence, and the picker shows "Choose…" rather
  // than pointing at a node it will not save.
  const editSiteValue = scopeChoices.some((o) => o.value === editSite) ? editSite : "";

  const busy =
    createOperator.isPending ||
    updateOperator.isPending ||
    setActive.isPending ||
    grantSkill.isPending ||
    updateRecord.isPending ||
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
    const draft = validateOperatorDraft(
      { displayName: draftName, employeeRef: draftRef },
      operators,
    );
    if (!draft.ok) {
      setNotice(draft.message);
      return;
    }
    // ⭐ 0028: `""` used to mean company-wide. It now means "nothing chosen",
    // and `site_node_id` is NOT NULL, so sending it is a guaranteed round trip
    // to a database error. This guard is what the comment beside `siteNodeId`
    // used to CLAIM was here and was not — the same refusal `saveRename` makes,
    // and reachable only when the picker has nothing to offer, since
    // `draftSiteValue` otherwise falls back to the first node on the list.
    if (draftSiteValue === "") {
      setNotice("Choose where this person belongs.");
      return;
    }
    createOperator.mutate(
      {
        orgId,
        displayName: draft.displayName,
        employeeRef: draft.employeeRef,
        // ⚠️ THE RESOLVED VALUE, NOT `draftSite`. The raw state can name a node
        // the plant filter has taken out from under the form; what is submitted
        // has to be what the control is showing.
        siteNodeId: draftSiteValue,
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
    // ⭐ THE AREA IS PART OF THE EDIT NOW, and it is the third time the maintainer has
    // had to ask. People move between areas — that is the whole reason an area
    // is worth recording — and until this line the picker existed only on the
    // "Add someone" form, so where somebody belonged was frozen at the moment
    // they were created. **The edit path is the other half of the create path,
    // not a smaller version of it.**
    // ⚠️ 0028 / D108: `""` used to fold to `null` — company-wide. It now means
    // "nothing chosen", and the one thing it must NOT become is `undefined`,
    // because an absent key means "leave it alone" and the screen would show a
    // move that never happened. Refuse instead, with a sentence.
    // ⚠️ THE RESOLVED VALUE, NOT `editSite`. If the plant filter has taken the
    // held node out of the picker, `editSiteValue` is `""` and this refuses —
    // which is the point. The alternative is submitting a node the form is no
    // longer showing, and this field decides where somebody can be booked.
    if (editSiteValue === "") {
      setNotice("Choose where this person belongs.");
      return;
    }
    updateOperator.mutate(
      {
        id: selected.id,
        displayName: draft.displayName,
        employeeRef: draft.employeeRef,
        siteNodeId: editSiteValue,
      },
      { onSuccess: () => setRenaming(false), onError: onErr },
    );
  }

  /**
   * ⭐⭐ RECORD-IN-PLACE, the same gesture the team matrix uses. A cell click
   * opens the shared `RecordPopover`; Save writes the three facts at once —
   * GRANT (insert) when nothing is held yet, UPDATE when a holding exists. The
   * three facts stay optional and independent (0032 / D114 writes no CHECK tying
   * them): an empty box is a fact nobody recorded, never an error, and none
   * gates the others. Every column is being written on a grant, so an empty box
   * is simply unrecorded; on an update the popover sends all three from what the
   * reader left in the fields, which is exactly what they see.
   *
   * ⚠️ THE ERROR SHOWS IN THE POPOVER, beside the fields, not in the panel
   * notice — it is about the one record being entered, the way the team matrix
   * surfaces it. `closeCell` resets the mutation so a stale error never trails
   * onto the next cell opened.
   */
  const openCell = (skillId: string, target: HTMLElement) => {
    const r = target.getBoundingClientRect();
    setEditingCell({ skillId, top: r.bottom + 4, left: r.left });
  };
  const closeCell = () => {
    setEditingCell(null);
    grantSkill.reset();
    updateRecord.reset();
    revokeSkill.reset();
  };
  const matrixSave = (fields: RecordFields) => {
    if (selected === null || editingCell === null) return;
    setNotice(null);
    const vars = { operatorId: selected.id, skillId: editingCell.skillId };
    if (opHoldings.has(editingCell.skillId)) {
      updateRecord.mutate({ ...vars, ...fields }, { onSuccess: closeCell });
    } else if (orgId === null) {
      setNotice("Your profile hasn't loaded yet — try again in a moment.");
    } else {
      grantSkill.mutate({ orgId, ...vars, ...fields }, { onSuccess: closeCell });
    }
  };
  const matrixRemove = () => {
    if (selected === null || editingCell === null) return;
    setNotice(null);
    revokeSkill.mutate({ operatorId: selected.id, skillId: editingCell.skillId }, { onSuccess: closeCell });
  };
  const matrixSaving = grantSkill.isPending || updateRecord.isPending || revokeSkill.isPending;
  const matrixError = grantSkill.error ?? updateRecord.error ?? revokeSkill.error ?? null;
  const editingSkill =
    editingCell === null ? null : (operatorMatrix?.columns.cols.find((c) => c.id === editingCell.skillId) ?? null);

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
                    {row.ticketCount === 1 ? "1 training" : `${row.ticketCount} trainings`}
                    {!row.active && <span className={styles.badge}>deactivated</span>}
                  </span>
                </button>
              </li>
            ))}
            {rows.length === 0 && <li className={styles.status}>Nobody matches that.</li>}
          </ul>
          {/* ⚠️ TRIMMED, NOT SILENT — the same rule as the two footnotes under
              the places list, and the one the maintainer will look at first.
              Named by `plant.label`, which is the chosen plant's OWN NAME:
              "plant" is this company's word for its top level and another
              company's hierarchy may call it anything at all. The footnote also
              rescues "Nobody matches that." above it, which would otherwise
              blame the search box for a cut the search box did not make. */}
          {hiddenPeople > 0 && (
            <p className={styles.footnote}>
              {hiddenPeople === 1
                ? `1 person outside ${plant.label} is not shown.`
                : `${hiddenPeople} people outside ${plant.label} are not shown.`}
            </p>
          )}

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
            {/* ⭐ NARROWED TO THE CHOSEN PLANT (decision 3), and bound to the
                RESOLVED value so the control can never display one node while
                the state holds another — see `draftSiteValue`. */}
            <select
              className={styles.input}
              value={draftSiteValue}
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

          {/* ⭐⭐ THE TRAINING CATALOGUE USED TO SIT HERE AND IS NOW ITS OWN
              TAB — roadmap stage 22. A "Ticket types" toggle opened a list
              that CREATED, RENAMED and DELETED training types, from inside a
              screen headed with one person's name. Managing the type is a
              company-level job and `TrainingsPanel` does it beside Operators,
              Shifts and Products; GIVING a training to the person on screen
              stays, in the detail pane on the right. */}
        </aside>

        {/* ---------------- where they can work ---------------- */}
        <section className={styles.detail}>
          {selected === null ? (
            <p className={styles.status}>Pick someone on the left to see where they can work.</p>
          ) : (
            <>
              <header className={styles.head}>
                {renaming ? (
                  /* ⚠⚠ EVERY CONTROL HERE IS NAMED FOR THE PERSON IT IS ABOUT, AND
                     THAT IS A FIX, NOT A FLOURISH. While this form is open the
                     Add card is still on screen with its own "Name", "Employee
                     reference" and "Belongs to" — so a screen-reader user was
                     offered TWO boxes of each, identically named, with no way
                     to tell which one edits the person they just opened.
                     `within(...)` disambiguates for a sighted reader and for a
                     test; it does nothing for the person who needs the name.
                     This is D106's rule ("a control may not be named after less
                     than it does") and `ProductsPanel` already solved it the
                     same way — `Name for ${row.sku}`, `Where ${row.sku} belongs`.
                     ⚠️ Anchored on `selected.displayName`, the SAVED name, so the
                     accessible name does not change under the reader as they
                     type into the very field it names. */
                  <div className={styles.renameRow}>
                    <input
                      className={styles.input}
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      aria-label={`Name for ${selected.displayName}`}
                    />
                    <input
                      className={styles.input}
                      value={editRef}
                      onChange={(e) => setEditRef(e.target.value)}
                      aria-label={`Employee reference for ${selected.displayName}`}
                    />
                    {/* ⭐ WHERE THEY BELONG, EDITABLE. See `saveRename`.
                        ⚠️ CHANGING THIS CHANGES WHERE THEY CAN BE BOOKED. Since
                        0028 / D109 the server refuses an assignment outside it,
                        and since 0030 / D113 a supervisor may override that by
                        recording a reason. The list above is what moves. */}
                    <select
                      className={styles.input}
                      aria-label={`Where ${selected.displayName} belongs`}
                      value={editSiteValue}
                      onChange={(e) => setEditSite(e.target.value)}
                    >
                      {/* ⚠️ ONLY WHEN THE HELD NODE IS NO LONGER OFFERED — the
                          plant filter narrowed under an open form, or the node
                          is one this reader cannot resolve. Without it the
                          browser would show option one while the state holds
                          `""`, so the control would point at a node
                          `saveRename` then refuses: the value on screen and the
                          value in hand disagreeing, which is the trap
                          `editSiteValue` exists to close. */}
                      {editSiteValue === "" && <option value="">Choose where they belong…</option>}
                      {scopeChoices.map((o) => (
                        <option key={o.value ?? "company"} value={o.value ?? ""}>
                          {indentedLabel(o)}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className={styles.small}
                      disabled={busy}
                      onClick={saveRename}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className={styles.small}
                      onClick={() => setRenaming(false)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className={styles.renameRow}>
                    <h2 className={styles.h2}>{selected.displayName}</h2>
                    <span className={styles.headMeta}>
                      {selected.employeeRef ?? "no reference"}
                      {!selected.active && <span className={styles.badge}>deactivated</span>}
                    </span>
                    {/* ⭐⭐ WHERE THEY BELONG, READABLE WITHOUT OPENING THE
                        EDIT FORM — see the header. It is not decoration: this
                        field decides where they can be booked (0028 / D109) and
                        the count line under it is computed from it, so a reader
                        looking at "0 of 2 places in their own area" cannot check
                        that number without it.
                        ⚠️ THE LEAF NAME IS DRAWN AND THE FULL PATH IS THE
                        TOOLTIP. Three plants can each hold a "Line 1", so the
                        leaf alone is ambiguous; the whole chain in a header is
                        longer than the name it sits beside. `scope.ts` is the
                        one place an id becomes a name on this screen, and both
                        of its answers fall back to "Somewhere else" rather than
                        to a blank — an area this reader cannot resolve is a
                        fact worth saying, not a gap worth hiding. */}
                    <span
                      className={styles.headMeta}
                      title={scopePathLabel(selected.siteNodeId, nodesById)}
                    >
                      Belongs to {scopeLabel(selected.siteNodeId, nodesById)}
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
                    {/* ⭐ DEACTIVATE IS THE MAIN ACTION (the maintainer's decision):
                        it keeps every assignment, training and audit row intact
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
                    {/* ⭐ 0029 REPLACED A CLIENT-SIDE PRECHECK WITH THE
                        SERVER'S OWN ANSWER. This used to run `deletePrecheck`
                        and REFUSE to delete anybody still holding a training
                        ("remove them first"). Migration 0029 makes
                        `operator_skills` cascade from `operators`, so that
                        refusal became a rule the client enforced and the
                        database did not — the worst kind, because the way out
                        it names is work that no longer needs doing. The dialog
                        asks `deletion_preview` and NAMES the trainings instead. */}
                    <button
                      type="button"
                      className={styles.small}
                      disabled={confirmDelete}
                      onClick={() => {
                        setNotice(null);
                        setConfirmDelete(true);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </header>

              {confirmDelete && (
                <DeleteDialog
                  kind="operator"
                  id={selected.id}
                  name={selected.displayName}
                  alreadyInactive={!selected.active}
                  onDeactivate={() => {
                    setConfirmDelete(false);
                    setNotice(null);
                    setActive.mutate({ id: selected.id, active: false }, { onError: onErr });
                  }}
                  onCancel={() => setConfirmDelete(false)}
                  onDeleted={(message) => {
                    setConfirmDelete(false);
                    // The detail pane is about to be about nobody, so the
                    // selection is cleared and the sentence moves to the panel
                    // notice — the one place on this screen that outlives a row.
                    setSelectedId(null);
                    setNotice(message);
                  }}
                  onFailed={(message) => {
                    setConfirmDelete(false);
                    setNotice(message);
                  }}
                />
              )}

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
                {/* ⭐ THE LINE NAMES WHAT IT COUNTS. It used to read "12 of 18
                    places" for somebody whose own line holds two, because the
                    denominator was every schedulable cell in the company and
                    the numerator counted trainings alone. The denominator is
                    now their OWN AREA, and everywhere else is counted
                    separately rather than folded in. */}
                <p className={styles.summary}>
                  {summary.eligible} of {summary.ownArea}{" "}
                  {summary.ownArea === 1 ? "place" : "places"} in their own area
                  {summary.outsideArea > 0 &&
                    ` · ${summary.outsideArea} elsewhere, only with a recorded reason`}
                  {summary.unresolved > 0 &&
                    ` · ${summary.unresolved} couldn’t be answered in full`}
                </p>
              </div>
              {/* ⚠️ An INDICATION, not a promise — the server re-asks
                  `check_eligibility` against the real shift window when the
                  assignment is actually made. See `../lib/operators`. */}
              <p className={styles.footnote}>
                The scheduler checks this again when work is assigned; this is what today&rsquo;s
                trainings, requirements and areas imply. A place marked &ldquo;⚠&rdquo; is outside
                the area this person belongs to — whoever schedules there can still put them on it,
                but has to record a reason for it.
              </p>
              {visiblePlaces.length === 0 || placesColumns.cols.length === 0 ? (
                <p className={styles.status}>There are no schedulable places in the hierarchy yet.</p>
              ) : (
                <>
                  <div className={styles.placeLegend}>
                    {(Object.keys(PLACE_CHIP) as PlaceVerdict[]).map((v) => (
                      <span key={v} className={styles.placeLegendItem}>
                        <MatrixChip
                          state={PLACE_CHIP[v].state}
                          glyph={PLACE_CHIP[v].glyph}
                          title={PLACE_CHIP[v].label}
                          ariaHidden
                        />
                        {PLACE_CHIP[v].label}
                      </span>
                    ))}
                  </div>
                  <div className={styles.matrixScroll}>
                    <table className={styles.matrix}>
                      <thead>
                        {placesColumns.bands.map((band, b) => (
                          <tr key={b}>
                            {band.map((cell, i) => (
                              <th
                                key={i}
                                className={styles.matrixOwner}
                                colSpan={cell.colspan}
                                rowSpan={cell.rowspan}
                              >
                                {cell.label}
                              </th>
                            ))}
                          </tr>
                        ))}
                        <tr>
                          {placesColumns.cols.map((c) => (
                            <th key={c.id} className={styles.matrixColName} scope="col">
                              {c.name}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          {placesColumns.cols.map((c) => {
                            const place = placeByNode.get(c.id);
                            if (place === undefined) {
                              return <td key={c.id} className={styles.matrixCell} />;
                            }
                            const verdict = placeVerdict(place);
                            const chip = PLACE_CHIP[verdict];
                            // ⚠️ THE REASON MOVES FROM A VISIBLE COLUMN TO THE
                            // CELL'S HIDDEN HINT AND HOVER — the flat list spelled
                            // "missing Welding" beside every cross; a one-row grid
                            // cannot, so the chip is decorative and the sentence a
                            // screen reader speaks rides beside it, D100.
                            const why =
                              verdict === "can-work" ? "can work here" : place.reasons.join(" · ");
                            return (
                              <td key={c.id} className={styles.matrixCell}>
                                <MatrixChip
                                  state={chip.state}
                                  glyph={chip.glyph}
                                  title={`${place.label} — ${why}`}
                                  ariaHidden
                                />
                                <span className={styles.srHint}>
                                  {place.label}: {why}
                                </span>
                              </td>
                            );
                          })}
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              {/* ⚠️ TRIMMED, NOT SILENT. Named by the root rather than by a level
                  word: "plant" is this company's name for the top level and
                  another company's hierarchy may call it anything at all. */}
              {offSitePlaces > 0 && ownRootName !== null && (
                <p className={styles.footnote}>
                  {offSitePlaces === 1
                    ? `1 place outside ${ownRootName} is not shown.`
                    : `${offSitePlaces} places outside ${ownRootName} are not shown.`}
                </p>
              )}
              {hiddenPlaces > 0 && (
                <p className={styles.footnote}>
                  {hiddenPlaces === 1
                    ? "1 deactivated place is not shown."
                    : `${hiddenPlaces} deactivated places are not shown.`}
                </p>
              )}

              {/* ⭐⭐ WHAT THEY HOLD, AND THIS HALF STAYED WHEN THE CATALOGUE
                  LEFT. A grant is a fact about THIS PERSON — it belongs under
                  their name, beside the list of places it just turned green.
                  Creating, renaming and deleting the training TYPE is a
                  company-level job and lives on the Trainings tab. */}
              {/* ⭐⭐ THE SAME MATRIX VISUAL AS THE TEAM VIEW, FOR ONE PERSON.
                  The maintainer, 2 September: "copy this visual in the operator
                  tab as well instead of what we have in there right now for
                  individual operators", and "the hierarchy level should go the
                  lowest in this one where the operator works". So the header
                  climbs this person's own branch down to their line, each column
                  is a training they can hold, and a cell click records it. The
                  three facts a held row always showed — certified on, expires,
                  signed off by — live in the shared `RecordPopover` now, kept
                  optional and independent exactly as before (0032 / D114). */}
              <h3 className={styles.h3}>Trainings</h3>
              <p className={styles.footnote}>
                A training is what changes the answer above — requirements sit on places and inherit
                downward, so recording one can turn several crosses green at once. Each column is a
                training {selected.displayName} can hold; click a cell to record it, change its
                dates, or remove it. Who signed somebody off and when are optional.
              </p>
              {operatorMatrix === null || operatorMatrix.columns.cols.length === 0 ? (
                <p className={styles.status}>No trainings apply to {selected.displayName} yet.</p>
              ) : (
                <>
                  <MatrixLegend />
                  <div className={styles.matrixScroll}>
                    <table className={styles.matrix}>
                      <thead>
                        {operatorMatrix.columns.bands.map((band, b) => (
                          <tr key={b}>
                            {band.map((cell, i) => (
                              <th
                                key={i}
                                className={styles.matrixOwner}
                                colSpan={cell.colspan}
                                rowSpan={cell.rowspan}
                              >
                                {cell.label}
                              </th>
                            ))}
                          </tr>
                        ))}
                        <tr>
                          {operatorMatrix.columns.cols.map((t) => (
                            <th key={t.id} className={styles.matrixColName} scope="col">
                              {t.name}
                              {t.externalId && <span className={styles.matrixDoc}>{t.externalId}</span>}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          {operatorMatrix.columns.cols.map((t) => {
                            const st = operatorMatrix.cellState(t.id);
                            return (
                              <td key={t.id} className={styles.matrixCell}>
                                <MatrixChip
                                  state={st}
                                  title={`${t.name}: ${STATE_LABEL[st]} (click to record)`}
                                  ariaLabel={`${t.name}: ${STATE_LABEL[st]} — record`}
                                  onClick={(e) => openCell(t.id, e.currentTarget)}
                                />
                              </td>
                            );
                          })}
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <p className={styles.matrixCount}>
                    {operatorMatrix.counts.held} of {operatorMatrix.counts.trainings} held
                    {operatorMatrix.counts.gaps > 0 && (
                      <>
                        {" · "}
                        <b className={styles.matrixGap}>{operatorMatrix.counts.gaps} not trained</b>
                      </>
                    )}
                    {operatorMatrix.counts.needRenewal > 0 && (
                      <>
                        {" · "}
                        <b className={styles.matrixWarn}>
                          {operatorMatrix.counts.needRenewal} need renewal
                        </b>
                      </>
                    )}
                  </p>
                </>
              )}

              {/* ⭐ RECORD-IN-PLACE. A grant is no longer a separate "Add a
                  training" form — a training that applies but is not held shows
                  as a `×` cell above, and clicking it opens this same popover to
                  record it. New training TYPES are still created on the Trainings
                  tab; this only gives one to the person on screen. */}
              {editingCell !== null && editingSkill !== null && (
                <RecordPopover
                  key={editingCell.skillId}
                  who={selected.displayName}
                  what={editingSkill.name}
                  whatRef={editingSkill.externalId}
                  held={opHoldings.has(editingCell.skillId)}
                  initial={{
                    certifiedAt: opHoldings.get(editingCell.skillId)?.certifiedAt ?? null,
                    expiresAt: opHoldings.get(editingCell.skillId)?.expiresAt ?? null,
                    signedOffBy: opHoldings.get(editingCell.skillId)?.signedOffBy ?? null,
                  }}
                  position={{ top: editingCell.top, left: editingCell.left }}
                  saving={matrixSaving}
                  error={matrixError}
                  onSave={matrixSave}
                  onRemove={matrixRemove}
                  onClose={closeCell}
                />
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
