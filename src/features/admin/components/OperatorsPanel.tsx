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
  describeSkillNameClash,
  findExistingSkillByName,
  formatDay,
  operatorRows,
  placeVerdict,
  placesUnderSameRoot,
  resolveSelectedOperator,
  rootIdFor,
  summarisePlaces,
  ticketsFor,
  validateOperatorDraft,
  workPlacesFor,
  type OperatorLike,
  type WorkPlace,
} from "../lib/operators";
import { indentedLabel, scopeOptions } from "../lib/scope";
import { nodesInPlant, rowsInPlant } from "../lib/plantFilter";
import { usePlantFilter } from "../hooks/usePlantFilter";
import {
  useCreateOperator,
  useCreateSkill,
  useGrantSkill,
  useOperatorsAdmin,
  useRenameSkill,
  useRevokeSkill,
  useSetOperatorActive,
  useUpdateOperator,
  useUpdateSkillExpiry,
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
 * ("missing Forklift", "Welding expires 3 Sep 2026"). Tickets are the second
 * section, not the first, because they are how you CHANGE that answer rather
 * than the vocabulary the screen speaks — granting one turns several crosses
 * green at once, and nobody has to touch a cell to do it.
 *
 * ⭐⭐ THREE MARKS, NOT TWO, AND THE THIRD ONE IS WHY THIS LIST IS HONEST.
 * There are two server rules behind this answer, not one: the trainings
 * (`check_eligibility`) and the AREA a person belongs to
 * (`app_guard_assignment_scope`, 0028 / D109). Until this was fixed the list
 * asked only about trainings, so it ticked cells in plants the person cannot
 * be booked into at all — a stale PERMISSION, the screen saying yes where the
 * server says no. `../lib/operators` carries the full account.
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
 * (`usePlantFilter`) and applies it to the people list, the ticket types and
 * both "Belongs to" pickers. It renders no control of its own — six per-panel
 * filters would be six controls that drift apart.
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
 * One place, with the mark its verdict earns.
 *
 * ⚠️ THE VERDICT IS NOT DERIVED HERE. `placeVerdict` is in `../lib/operators`
 * beside the rule it reads, so this component and `operators.test.ts` cannot
 * drift apart — which is exactly how the screen came to disagree with the
 * server in the first place.
 *
 * ⚠️ The mark is `aria-hidden` and carries no meaning on its own: a tick's
 * meaning is spoken by the visually-hidden hint, and the other two are spoken
 * by the reason sentence, which every non-tick row has. Colour is never the
 * only signal (D100).
 */
function PlaceRow({ place }: { place: WorkPlace }) {
  const verdict = placeVerdict(place);
  const rowClass =
    verdict === "can-work"
      ? styles.placeYes
      : verdict === "outside-area"
        ? styles.placeWarn
        : styles.placeNo;
  const mark = verdict === "can-work" ? "✓" : verdict === "outside-area" ? "⚠" : "✕";
  return (
    <li className={rowClass}>
      <span className={styles.mark} aria-hidden="true">
        {mark}
      </span>
      <span className={styles.placeLabel}>
        {place.label}
        {!place.active && <span className={styles.badge}>inactive place</span>}
      </span>
      <span className={styles.placeWhy}>
        {verdict === "can-work" ? (
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
  const [skillDeleteId, setSkillDeleteId] = useState<string | null>(null);
  const [skillEditName, setSkillEditName] = useState("");
  const [showSkillAdmin, setShowSkillAdmin] = useState(false);

  const createOperator = useCreateOperator();
  const updateOperator = useUpdateOperator();
  const setActive = useSetOperatorActive();
  const createSkill = useCreateSkill();
  const renameSkill = useRenameSkill();
  const grantSkill = useGrantSkill();
  const updateExpiry = useUpdateSkillExpiry();
  const revokeSkill = useRevokeSkill();

  // ⚠️ MEMOISED, not inlined `?? []`. A fresh `[]` on every render is a new
  // identity, so every `useMemo` below it recomputes every time and the
  // dependency lint says so. `data` itself is stable between refetches.
  const operators = useMemo<readonly OperatorLike[]>(() => data?.operators ?? [], [data]);
  const skills = useMemo(() => data?.skills ?? [], [data]);
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

  // ⭐ THE TICKET TYPES ARE NARROWED LIKE THE PEOPLE ARE — decision 3: what you
  // see is what you can grant. `skills` itself stays whole for the two other
  // questions this screen asks of it, because neither of them is "what is on
  // offer here" — see `tickets` just below and `clash` further down.
  const skillsInPlant = useMemo(
    () => rowsInPlant(skills, plant.choice, plant.plants, nodesById),
    [skills, plant.choice, plant.plants, nodesById],
  );
  const hiddenSkills = skills.length - skillsInPlant.length;

  // ⚠️ `skills`, NOT `skillsInPlant`. These are the tickets this person ACTUALLY
  // HOLDS — rows in `operator_skills`, not a list of what is on offer. Filtering
  // them would hide a real grant from the only screen that can revoke it: the
  // plant filter reaching past a view and into the record.
  const tickets = selected === null ? [] : ticketsFor(selected, skills, operatorSkills, asOf);
  const heldIds = new Set(tickets.map((t) => t.skillId));
  const grantable = skillsInPlant.filter((s) => !heldIds.has(s.id));

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

  // ⚠️ THE CLASH CHECK IS NOT FILTERED, AND MUST NOT BE. Skill names are unique
  // per ORG (`unique (org_id, name)`), so the question "does this name already
  // exist" is company-wide whatever the reader is looking at. Asking it of
  // `skillsInPlant` would let the screen offer to create a name the database
  // then refuses — a view choice deciding a uniqueness rule.
  const clash = findExistingSkillByName(skills, newSkill);
  const busy =
    createOperator.isPending ||
    updateOperator.isPending ||
    setActive.isPending ||
    createSkill.isPending ||
    renameSkill.isPending ||
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
    // Needed since 0028: the new training is owned by whoever is being
    // ticketed, so there is no training to make without a person selected.
    if (selected === null) {
      setNotice("Pick a person first — a new training belongs where they do.");
      return;
    }
    const name = newSkill.trim();
    if (name === "") return;
    // ⭐ THE CLASH IS NOT AN ERROR (the maintainer's decision: skill names stay
    // company-wide). An exact clash never reaches the database at all — the
    // screen offers the existing ticket instead, one click away, above.
    if (clash !== null && clash.exact) {
      setNotice(describeSkillNameClash(clash));
      return;
    }
    // ⭐⭐ 0028 CHANGED WHO OWNS A TRAINING MADE HERE, AND THERE IS ONLY ONE
    // ANSWER LEFT. It used to be created company-wide (`site_node_id: null`),
    // which a site admin was then refused by `skills_insert` — honest, but it
    // meant a supervisor could never make a ticket from this screen at all.
    // D108 removed company-wide, and D109 says the training must be owned at or
    // above wherever it is used. The person being ticketed is the only place
    // this screen knows about, so the training belongs where THEY belong: the
    // `operator_skills` guard added in 0028 requires the two to be on one
    // branch, and this is the choice that satisfies it by construction.
    createSkill.mutate(
      { orgId, name, siteNodeId: selected.siteNodeId },
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

          <button
            type="button"
            className={styles.link}
            onClick={() => setShowSkillAdmin((on) => !on)}
          >
            {showSkillAdmin ? "Hide ticket types" : "Ticket types"}
          </button>
          {showSkillAdmin && (
            <ul className={styles.ticketTypes}>
              {skillsInPlant.map((s) => (
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
                      {/* ⚠️ THIS BUTTON HAD NO CONFIRMATION AT ALL. One click
                          deleted a ticket type outright — and under 0029 that
                          now also un-qualifies everyone holding it and drops it
                          from every cell that requires it, by cascade. The
                          screen that most needed the dialog was the one
                          without even a "are you sure". */}
                      <button
                        type="button"
                        className={styles.small}
                        disabled={busy || skillDeleteId === s.id}
                        onClick={() => {
                          setNotice(null);
                          setSkillDeleteId(s.id);
                        }}
                      >
                        Delete
                      </button>
                    </>
                  )}
                  {skillDeleteId === s.id && (
                    <DeleteDialog
                      kind="skill"
                      id={s.id}
                      name={s.name}
                      onCancel={() => setSkillDeleteId(null)}
                      onDeleted={(message) => {
                        setSkillDeleteId(null);
                        setNotice(message);
                      }}
                      onFailed={(message) => {
                        setSkillDeleteId(null);
                        setNotice(message);
                      }}
                    />
                  )}
                </li>
              ))}
              {skillsInPlant.length === 0 && (
                <li className={styles.status}>No ticket types yet.</li>
              )}
              {/* ⚠️ COUNTED, like every other trim on this screen. This list
                  carries a Delete that cascades (0029), so "it isn't there" and
                  "you can't see it from here" are answers a reader must not be
                  left to confuse. */}
              {hiddenSkills > 0 && (
                <li className={styles.footnote}>
                  {hiddenSkills === 1
                    ? `1 ticket type outside ${plant.label} is not shown.`
                    : `${hiddenSkills} ticket types outside ${plant.label} are not shown.`}
                </li>
              )}
            </ul>
          )}
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
                    {/* ⭐ 0029 REPLACED A CLIENT-SIDE PRECHECK WITH THE
                        SERVER'S OWN ANSWER. This used to run `deletePrecheck`
                        and REFUSE to delete anybody still holding a ticket
                        ("remove them first"). Migration 0029 makes
                        `operator_skills` cascade from `operators`, so that
                        refusal became a rule the client enforced and the
                        database did not — the worst kind, because the way out
                        it names is work that no longer needs doing. The dialog
                        asks `deletion_preview` and NAMES the tickets instead. */}
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
                tickets, requirements and areas imply. A place marked &ldquo;⚠&rdquo; is outside the
                area this person belongs to — whoever schedules there can still put them on it, but
                has to record a reason for it.
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

              <h3 className={styles.h3}>Tickets</h3>
              <p className={styles.footnote}>
                A ticket is what changes the answer above. Adding one can turn several crosses green
                at once — requirements sit on places and inherit downward.
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
                {tickets.length === 0 && <li className={styles.status}>No tickets yet.</li>}
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
                  (`unique (org_id, name)`), and the maintainer's decision is that they
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
