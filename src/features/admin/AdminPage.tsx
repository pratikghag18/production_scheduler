import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
// `fetchHierarchyTree` moved to src/lib/api/hierarchy.ts by the design session:
// `src/lib/api/` is the only place allowed to touch supabase, snake_case or
// database.types.ts (docs/conventions.md). The brief's file table authorised no
// file for it, which is why it landed here; the boundary is the rule.
import { fetchHierarchyTree } from "@/lib/api";
import { useSession } from "@/features/auth/useSession";
import { adminSectionsFor, canQueryAsUser, resolveAdminSection } from "@/features/auth/session";
import { hierarchyKeys } from "./hooks/useHierarchyMutations";
import { buildShapeSummaries, filterEditableShapes, resolveSelectedShape } from "./lib/shapePicker";
import { nodesInPlant } from "./lib/plantFilter";
import { usePlantFilter } from "./hooks/usePlantFilter";
import { useAdminViewStore } from "./store/adminView";
import { LevelEditor } from "./components/LevelEditor";
import { NodeTreeEditor } from "./components/NodeTreeEditor";
import { ShapePicker } from "./components/ShapePicker";
import { SiteAccessPanel } from "./components/SiteAccessPanel";
// §19.62 — the four queued sections, PRE-SEATED. Each panel owns its own
// `_PANEL_READY` flag, so the lane that builds one turns it on by editing its
// OWN file and never this one. See any of the four for why.
import { ShiftsPanel, SHIFTS_PANEL_READY } from "./components/ShiftsPanel";
import { OperatorsPanel, OPERATORS_PANEL_READY } from "./components/OperatorsPanel";
import { TrainingsPanel, TRAININGS_PANEL_READY } from "./components/TrainingsPanel";
import { MatrixPanel, MATRIX_PANEL_READY } from "./components/MatrixPanel";
import { ProductsPanel, PRODUCTS_PANEL_READY } from "./components/ProductsPanel";
import { CycleTimesPanel, CYCLE_TIMES_PANEL_READY } from "./components/CycleTimesPanel";
import { ImportPanel, IMPORT_PANEL_READY } from "./components/ImportPanel";
import { SettingsPanel, SETTINGS_PANEL_READY } from "./components/SettingsPanel";
import { PanelToggle } from "@/components/PanelToggle";
import styles from "./AdminPage.module.css";

/**
 * The sectioned shell (brief P1-5d §6.1/§7.1). `/admin` grows to hold
 * Hierarchy, Shifts, Operators, Products and Import; only Hierarchy is
 * built here. A LEFT RAIL, not tabs (§6.1's call): the board already
 * spends a left rail on org structure (`--rail-w`), so this keeps that
 * idiom instead of introducing a second navigation pattern, and a rail
 * has room to grow -- five sections today, and each of Shifts/Operators/
 * Products is itself likely to grow sub-navigation later, which a tab
 * strip has no natural place for.
 *
 * Levels and nodes are read ONCE, here, and passed down: the tree needs
 * levels for `canDropOn` (§6.3 debt 2 -- always the COMPLETE array), and
 * the shell needs one shared loading state even though the level editor
 * itself has no use for `nodes`.
 */

type SectionId =
  | "hierarchy"
  | "access"
  | "shifts"
  | "operators"
  | "trainings"
  | "matrix"
  | "products"
  | "cycletimes"
  | "import"
  | "settings";

/*
 * ⭐ §19.62 — `enabled` IS NOT A LITERAL FOR THE QUEUED SECTIONS, AND THAT IS
 * THE POINT. It reads the flag exported by each section's own panel, so a
 * section can only be switched on by the file that holds the panel behind it —
 * you cannot turn on a screen that does not exist, and the lane that builds one
 * never edits this array. Group H in `scaleAudit.test.ts` guards the other
 * direction: every id below has a branch rendering it.
 */
// ⚠️ `companyAdminOnly` IS A SEPARATE AXIS FROM `adminSectionsFor`. That helper
// returns "all" for a site admin too (adminAnywhere), so it cannot express
// "system admin ONLY" — and Settings is exactly that: an org-wide preference set
// once for the whole company (0037). The flag is filtered on `profile.role`
// below, and the server RPC refuses a non-admin regardless, so this only hides a
// tab that could tell a site admin nothing but no.
const SECTIONS: ReadonlyArray<{
  id: SectionId;
  label: string;
  enabled: boolean;
  companyAdminOnly?: boolean;
}> = [
  { id: "hierarchy", label: "Hierarchy", enabled: true },
  { id: "access", label: "Access", enabled: true },
  { id: "shifts", label: "Shifts", enabled: SHIFTS_PANEL_READY },
  { id: "operators", label: "Operators", enabled: OPERATORS_PANEL_READY },
  // ⭐⭐ TRAININGS IS ITS OWN SECTION, AND IT SITS BESIDE OPERATORS BECAUSE
  // THAT IS WHERE IT USED TO LIVE. It was a "Ticket types" toggle INSIDE the
  // Operators panel, reachable only after picking a person — so managing the
  // catalogue meant choosing somebody arbitrary first. The maintainer, 31 Aug:
  // *"I thought we were going to create a trainings tab like
  // operator/shifts/products."*
  //
  // ⚠️ THE SPLIT IS THE TYPE VS THE HOLDING, and it is worth stating because
  // the two look alike: creating, renaming and retiring a TRAINING happens
  // here; GRANTING one to a person stays on Operators, where the person is.
  { id: "trainings", label: "Trainings", enabled: TRAININGS_PANEL_READY },
  // ⭐ THE OPERATOR TRAINING MATRIX — its own buildout. It reads the SAME
  // `useOperatorsAdmin` query Operators and Trainings do, so it adds no fetch;
  // it sits beside them because it is a third view of the same people-and-
  // trainings data. `MATRIX_PANEL_READY` lives in the panel, like the others.
  { id: "matrix", label: "Matrix", enabled: MATRIX_PANEL_READY },
  { id: "products", label: "Products", enabled: PRODUCTS_PANEL_READY },
  // ⭐ CYCLE TIMES SIT BESIDE PRODUCTS BECAUSE A CYCLE TIME IS A FACT ABOUT A
  // PART AT A PLACE, and both halves of that are managed on the screens either
  // side of it: which plants make a part is on Products, where the places are
  // is on Hierarchy. It is a section of its own rather than a panel inside
  // Products because the grid is hierarchy-shaped across every part at once —
  // inside a product row the tree would be repeated once per part, with nowhere
  // to show a line's roll-up (R-317).
  { id: "cycletimes", label: "Cycle times", enabled: CYCLE_TIMES_PANEL_READY },
  { id: "import", label: "Import", enabled: IMPORT_PANEL_READY },
  // System-admin only (see `companyAdminOnly` note above). Org-wide preferences,
  // the first being the date-display format (0037 / `src/lib/format/dates.ts`).
  { id: "settings", label: "Settings", enabled: SETTINGS_PANEL_READY, companyAdminOnly: true },
];

/**
 * §6.3 debt 1, CONFIRMED: keys under `hierarchyKeys.all` exactly as that
 * file's own comment proposed (`[...hierarchyKeys.all, "tree"]`) for the
 * read hook it was written waiting on. Every mutation in
 * `useHierarchyMutations.ts` already invalidates the `hierarchyKeys.all`
 * prefix, so this query is covered without either file knowing the
 * other's exact shape.
 */
function useHierarchyTree(enabled: boolean) {
  return useQuery({
    queryKey: [...hierarchyKeys.all, "tree"],
    queryFn: fetchHierarchyTree,
    // See useBoardWindow: REQUIRED, not defaulted. `fetchHierarchyTree` reads
    // `hierarchy_templates`, `hierarchy_levels` and `nodes`, all RLS-scoped to
    // the caller, so before the session resolves this can only be a 401.
    enabled,
  });
}

/**
 * ⭐ THE RAIL COLLAPSES SO A WIDE SECTION GETS THE WHOLE WIDTH. The maintainer,
 * 1 Sept: the Trainings table (and Products, and Import) can run to four columns
 * plus a fixed action strip, and the rail is spending width a reader on a wide
 * table would rather give the table. Collapsing it leaves a thin strip with the
 * one control that brings it back.
 *
 * ⚠️ REMEMBERED PER VIEWER, and every read and write is wrapped: a private
 * window or blocked storage throws on access rather than returning null, and the
 * screen must open with the rail SHOWN in that case, never crash. It is a
 * convenience, not state anything depends on.
 */
/**
 * ⭐ ONE SMALL LINE ICON PER SECTION, so the rail reads as icons+labels open and
 * as icons alone when collapsed — the maintainer, 1 Sept, asked for icons on the
 * tabs and specifically for the collapsed strip. Inline SVG rather than a new
 * dependency: there is no icon library in the tree and seven simple glyphs do not
 * justify one. `stroke="currentColor"` so each icon takes its button's colour —
 * white on the active row, muted on a "soon" one — with nothing per-state to set.
 * `aria-hidden` because the button already carries the name (its label when open,
 * an `aria-label` when collapsed); the icon is decoration a reader never needs
 * announced.
 */
function SectionIcon({ id }: { id: SectionId }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {sectionIconBody(id)}
    </svg>
  );
}

function sectionIconBody(id: SectionId) {
  switch (id) {
    case "hierarchy": // an org chart: a parent node bracketed down to two children
      return (
        <>
          <rect x="6.25" y="1.75" width="3.5" height="3" rx="0.6" />
          <rect x="1.75" y="11.25" width="3.5" height="3" rx="0.6" />
          <rect x="10.75" y="11.25" width="3.5" height="3" rx="0.6" />
          <path d="M8 4.75V9.25M3.5 11.25V9.25H12.5V11.25" />
        </>
      );
    case "access": // a shield with a tick — permission granted
      return (
        <>
          <path d="M8 1.75 3.25 3.6V8c0 3 2.1 4.9 4.75 6.25C10.65 12.9 12.75 11 12.75 8V3.6Z" />
          <path d="M6.1 7.9 7.4 9.2 10 6.3" />
        </>
      );
    case "shifts": // a clock
      return (
        <>
          <circle cx="8" cy="8" r="6" />
          <path d="M8 4.6V8l2.4 1.6" />
        </>
      );
    case "operators": // a person
      return (
        <>
          <circle cx="8" cy="5.25" r="2.75" />
          <path d="M3.4 13.5c0-2.6 2.05-4.15 4.6-4.15s4.6 1.55 4.6 4.15" />
        </>
      );
    case "trainings": // a mortarboard — the training catalogue
      return (
        <>
          <path d="M8 3 1.5 6l6.5 3 6.5-3L8 3Z" />
          <path d="M4.6 7.6v3c0 .9 1.5 1.7 3.4 1.7s3.4-.8 3.4-1.7v-3" />
          <path d="M14 6v3" />
        </>
      );
    case "matrix": // a grid — rows and columns of cells
      return (
        <>
          <rect x="2" y="2" width="12" height="12" rx="1" />
          <path d="M2 6.5h12M2 10h12M6.5 2v12M10 2v12" />
        </>
      );
    case "products": // a box
      return (
        <>
          <path d="M8 1.9 2.6 5v6L8 14.1 13.4 11V5Z" />
          <path d="M2.6 5 8 8.05 13.4 5M8 8.05V14.1" />
        </>
      );
    case "cycletimes": // a stopwatch: crown, stem and a hand at the quarter
      return (
        <>
          <circle cx="8" cy="9.1" r="5.15" />
          <path d="M6.35 1.75h3.3M8 1.75v2.2M8 9.1V6.5M8 9.1h2.1" />
        </>
      );
    case "import": // a down-arrow into a tray
      return (
        <>
          <path d="M8 2v6.6" />
          <path d="M5.3 6 8 8.7 10.7 6" />
          <path d="M2.75 10.6v1.9c0 .66.5 1.2 1.15 1.2h8.2c.65 0 1.15-.54 1.15-1.2v-1.9" />
        </>
      );
    // ⚠️ A GEAR HAS TEETH ON ITS RIM; EIGHT DETACHED RAYS AROUND A CIRCLE IS A
    // SUN. This case was commented "a gear" and drew the second one — the
    // maintainer read it off the rail as a mini sun, which is a weather or a
    // brightness control, not settings. The outline below is a real six-tooth
    // cog: one closed path alternating a tip arc at r=5.9 with a root arc at
    // r=4.3, and a hub. Six teeth, not eight — at 16px eight tips and their
    // gaps fall below a stroke's width apart and silt up into a ring.
    case "settings": // a gear: six teeth on the rim, and a hub
      return (
        <>
          <path d="M13.77 6.77 A5.90 5.90 0 0 1 13.77 9.23 L12.04 9.47 A4.30 4.30 0 0 1 11.29 10.76 L11.95 12.38 A5.90 5.90 0 0 1 9.82 13.61 L8.75 12.23 A4.30 4.30 0 0 1 7.25 12.23 L6.18 13.61 A5.90 5.90 0 0 1 4.05 12.38 L4.71 10.76 A4.30 4.30 0 0 1 3.96 9.47 L2.23 9.23 A5.90 5.90 0 0 1 2.23 6.77 L3.96 6.53 A4.30 4.30 0 0 1 4.71 5.24 L4.05 3.62 A5.90 5.90 0 0 1 6.18 2.39 L7.25 3.77 A4.30 4.30 0 0 1 8.75 3.77 L9.82 2.39 A5.90 5.90 0 0 1 11.95 3.62 L11.29 5.24 A4.30 4.30 0 0 1 12.04 6.53 L13.77 6.77 Z" />
          <circle cx="8" cy="8" r="1.85" />
        </>
      );
  }
}

const RAIL_COLLAPSED_KEY = "admin.railCollapsed";

function readRailCollapsed(): boolean {
  try {
    return localStorage.getItem(RAIL_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export default function AdminPage() {
  const [section, setSection] = useState<SectionId>("hierarchy");
  const [railCollapsed, setRailCollapsed] = useState<boolean>(readRailCollapsed);
  const toggleRail = () =>
    setRailCollapsed((collapsed) => {
      const next = !collapsed;
      try {
        localStorage.setItem(RAIL_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // A viewer with storage blocked still gets the toggle for this visit;
        // it simply is not remembered into the next one.
      }
      return next;
    });
  const { session, profile, loading: sessionLoading } = useSession();
  // ⭐⭐ D114: THE RAIL IS FILTERED, NOT THE PANELS. A supervisor gets the same
  // Operators and Trainings screens everybody else does — they simply show what
  // that person's grants reach, which those screens already know how to do.
  // Building narrowed variants would be two of each to keep in step, and §19.77
  // is the standing lesson about a screen's idea of the rules drifting from the
  // server's.
  //
  // ⚠️ A MENU, NOT A PERMISSION. Nothing here authorises anything; the database
  // refuses on its own terms. This only stops somebody being offered a tab that
  // could never do anything but tell them no.
  const allowedSections = adminSectionsFor(profile?.role, profile?.adminAnywhere);
  // ⚠️ `companyAdminOnly` is the SECOND gate, and it is NOT redundant with
  // `allowedSections`: that returns "all" for a site admin (adminAnywhere), so
  // without this a site admin would be offered Settings — an org-wide screen the
  // server then refuses. Only the org-wide role 'admin' is a system admin.
  const isCompanyAdmin = profile?.role === "admin";
  const visibleSections = SECTIONS.filter(
    (s) =>
      (allowedSections === "all" || allowedSections.includes(s.id)) &&
      (s.companyAdminOnly !== true || isCompanyAdmin),
  );
  // ⚠️ RESOLVED, not merely filtered. The screen opens on "hierarchy", which a
  // supervisor cannot see — without this they would land on a heading with no
  // rail button beside it and an empty pane, and nothing would say why.
  const activeSection =
    resolveAdminSection(
      visibleSections.map((s) => s.id),
      section,
    ) ?? section;
  const orgId = profile?.orgId ?? null;
  const canQuery = canQueryAsUser(session?.user.id ?? null, sessionLoading);
  const { data, isLoading, isError } = useHierarchyTree(canQuery);
  // Shared by the Hierarchy section's own "Loading..." branch below and by
  // `SiteAccessPanel`'s `treeLoading` prop (brief P1-6a §6/§9): one boolean,
  // not two call sites independently re-deriving the same D91-shaped
  // condition (`!canQuery || isLoading`) and risking them drifting apart.
  const hierarchyLoading = !canQuery || isLoading;

  /* ---------------------------------------------------------------------
   * ⭐⭐ WHICH PLANT THIS SCREEN IS SHOWING — roadmap 1(c).
   *
   * The maintainer, 31 Aug: *"for the system admin, may be we need a filter
   * for plants in all the sub tabs."* A system admin can read every node in
   * the org, so every section below shows three plants' worth of everything.
   *
   * ⚠️ ONE CONTROL, HERE, NOT SIX. Six per-panel filters would drift apart,
   * and a reader who set one would have no way to know the other five were
   * still wide open. The panels read the choice off `useAdminViewStore` and
   * take no new prop for it, so `ShiftsPanel`, `OperatorsPanel` and
   * `ProductsPanel` keep the "NO PROPS" invariant each of them documents.
   *
   * ⚠️⚠️ AND THE CONTROL IS ALWAYS VISIBLE WHEN IT APPLIES. That is not
   * decoration: `SiteAccessPanel`'s own header records what happened the last
   * time one tab's selection scoped another *"with no control and nothing
   * explaining why"* — **"Where is Plant 1?", reported from the running app.**
   * A remembered filter with nothing on screen naming it is that bug again.
   * ------------------------------------------------------------------- */
  const plantFilter = usePlantFilter(data?.nodes ?? []);
  const hydratePlantChoice = useAdminViewStore((s) => s.hydratePlantChoice);
  const setPlantChoice = useAdminViewStore((s) => s.setPlantChoice);
  const hydratedOrgId = useAdminViewStore((s) => s.hydratedOrgId);

  // ⭐ HYDRATION IS THIS PAGE'S JOB, ONCE. `loadPlantChoice` needs an org id,
  // which lives behind `useSession()` — already called in five components, a
  // cost recorded against P1-6b. Doing it here keeps every panel out of the
  // session entirely.
  //
  // ⚠️ Keyed on the ORG, not on "have we run yet": the dev switcher changes
  // identity with no reload, and `user_profiles` is unique on
  // `(org_id, user_id)`, so a choice remembered in one org must not survive
  // into another.
  useEffect(() => {
    if (orgId !== null && hydratedOrgId !== orgId) hydratePlantChoice(orgId);
  }, [orgId, hydratedOrgId, hydratePlantChoice]);

  // The node ids inside the chosen plant. `null` (All plants) yields every
  // node, so nothing below has to special-case it.
  const plantNodeIds = useMemo(
    () =>
      new Set(
        nodesInPlant(data?.nodes ?? [], plantFilter.choice, plantFilter.plants).map((n) => n.id),
      ),
    [data, plantFilter.choice, plantFilter.plants],
  );

  // D87 (brief P1-5f §7.6): this component owns the shape SELECTION; every
  // other fact about a shape (its levels, whether it has nodes) is derived
  // from the one shared `fetchHierarchyTree` read via `buildShapeSummaries`,
  // never refetched or recomputed per child. `resolveSelectedShape` is what
  // keeps the selection from pointing at a shape that no longer exists
  // (e.g. right after deleting the one currently selected).
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null);
  // 0021 §2: the picker offers the structures this person may actually edit.
  // A company admin sees every one; a site admin sees their own site's. The
  // filter runs BEFORE `resolveSelectedShape`, so the selection can never
  // land on a structure the list no longer shows — the same reason that
  // function exists at all (D87).
  const allSummaries = data ? buildShapeSummaries(data.templates, data.levels, data.nodes) : [];
  const summaries = filterEditableShapes(allSummaries, data?.editableShapeIds ?? null);

  // Brief P1-6a §6: written out rather than
  // `data?.siteNodeIds[resolvedShapeId] ?? null`, because `resolvedShapeId`
  // is `string | null` and `data` is `undefined` until the query resolves --
  // indexing a `Record<string, ...>` with `string | null` does not compile.
  // The places the Access panel may be about: one per structure this person
  // may edit, named by the SITE that owns it rather than by the structure.
  //
  // ⚠️ THE REASON THIS COMMENT USED TO GIVE WAS FALSE, and it mattered: it
  // said the structure would otherwise read "Standard Plant (copy)". Migration
  // 0020 §10 names a copied structure after the NODE
  // (`v_copy_name := v_name`, where `v_name` is `p_name`), so a plant's
  // structure is already called "Plant 2" — which is exactly why the Hierarchy
  // tab ended up showing a structure picker that read like a plant picker.
  // The rule here is still right, for a better reason: the two names coincide
  // only at the moment of creation, and renaming either one leaves the other
  // alone. Reading the SITE is what keeps this list true after a rename.
  //
  // ⚠️ Derived from `summaries` (already filtered to what they may edit) and
  // NOT from the Hierarchy tab's current selection. The panel used to follow
  // that selection, which meant a company admin on the Access tab was shown
  // whichever plant a different tab had chosen, with no way to change it.
  const accessPlaces = data
    ? summaries
        .map((shape) => {
          const nodeId = data.siteNodeIds[shape.id] ?? null;
          if (nodeId === null) return null;
          const node = data.nodes.find((n) => n.id === nodeId);
          return node ? { nodeId, name: node.name } : null;
        })
        .filter((p): p is { nodeId: string; name: string } => p !== null)
    : [];

  /**
   * ⭐ THE FILTER NARROWS THE ACCESS PLACES; THE PANEL STILL OWNS WHICH ONE
   * IT IS SHOWING. Those are different decisions and the difference is the
   * whole history here — the panel took ownership of its selection precisely
   * because another tab used to drive it. Trimming the LIST it chooses from
   * is the shared filter doing its job; choosing WITHIN that list stays the
   * panel's, and `resolvePlace` already drops a selection the list no longer
   * contains. If the filter leaves one place, the panel's own picker hides
   * itself (it renders only above one), which is the same rule the header
   * above applies to itself.
   */
  const visibleAccessPlaces = accessPlaces.filter((p) => plantNodeIds.has(p.nodeId));

  /* ---------------------------------------------------------------------
   * ⭐⭐ THE STRUCTURE PICKER IS NARROWED BY THE PLANT FILTER TOO, AND
   * WITHOUT THIS THE HIERARCHY TAB CARRIES TWO CONTROLS THAT DO THE SAME JOB.
   *
   * `create_node` COPIES the structure whenever a root is created (0020 §10),
   * precisely so renaming a level in one plant does not rename it in the
   * others — `dev_demo.sql` puts it as *"one copied structure per plant, plus
   * the original the copies came from"*. So in practice a structure IS a
   * plant, and the picker was a plant picker wearing structure names. The
   * ⚠️ And the copy is named after the NODE (`v_copy_name := v_name`), so the
   * picker was literally listing "Plant A / Plant B / Plant C" underneath a
   * header reading "Showing: Plant A". Two controls, near-identical labels.
   *
   * ⚠️ A STRUCTURE OWNED BY NOBODY IS KEPT AT EVERY PLANT. `site_node_id` is
   * still nullable on `hierarchy_templates` — D108 removed company-wide for
   * products, operators, trainings and shift patterns, and deliberately not
   * for structures, because the unowned one is the seed corn every new root
   * copies from. Dropping it under a filter would hide the only structure a
   * brand-new plant can be built out of. This is `offeredAt`'s pre-0028 shape
   * and the one place it survives.
   *
   * ⚠️ THE TREE STILL GETS THE COMPLETE LIST (`summaries`, below).
   * `groupRowsByShape` buckets rows by each node's LEVEL and uses this list
   * only for the NAME, so handing it the narrowed one would leave a group
   * rendered and merely unnamed — the failure that made row-filtering the
   * right seam in the first place.
   * ------------------------------------------------------------------- */
  const plantSummaries =
    plantFilter.choice === null
      ? summaries
      : summaries.filter((s) => {
          const site = data?.siteNodeIds[s.id] ?? null;
          return site === null || plantNodeIds.has(site);
        });
  const hiddenShapes = summaries.length - plantSummaries.length;

  // Resolved against what the picker actually OFFERS, never against every
  // editable structure: the selection must not outlive the list it was made
  // from. Same reason `resolveSelectedShape` exists at all (D87), now with a
  // second way for the list to shrink.
  const resolvedShapeId = resolveSelectedShape(plantSummaries, selectedShapeId);

  return (
    <div className={styles.page}>
      <nav
        className={railCollapsed ? `${styles.rail} ${styles.railCollapsed}` : styles.rail}
        aria-label="Admin sections"
      >
        {/* ⭐ THE ONE CONTROL THAT SURVIVES A COLLAPSE. When the rail is shut it
            is the only thing in it, so it must always be reachable — the section
            buttons are the thing being hidden, never this. `aria-expanded` names
            the state a chevron only hints at. */}
        <PanelToggle
          collapsed={railCollapsed}
          onToggle={toggleRail}
          label="admin sections"
          className={styles.railToggle}
        />
        {/* ⭐ ICON-ONLY WHILE COLLAPSED, NOT HIDDEN. Each section keeps its
            button in the thin strip, shown as its icon, so a reader can still
            switch section without reopening the rail — the icons are what make
            that legible. The label is hidden by CSS, and an `aria-label` carries
            the name for a screen reader in its place; a `title` gives the sighted
            reader the same tooltip over an icon that no longer sits beside its
            word. */}
        {visibleSections.map((s) => (
          <button
            key={s.id}
            type="button"
            className={activeSection === s.id ? styles.railItemActive : styles.railItem}
            disabled={!s.enabled}
            aria-current={activeSection === s.id ? "page" : undefined}
            // ⚠️ NAMED FOR THE SR ONLY WHEN THE WORD IS GONE. Open, the visible
            // label is the name; collapsed, it is hidden, so the name moves to
            // `aria-label` — set in only one state so the two never double up.
            aria-label={railCollapsed ? s.label : undefined}
            title={!s.enabled ? "Coming in a later brief" : railCollapsed ? s.label : undefined}
            onClick={() => setSection(s.id)}
          >
            <span className={styles.railIcon} aria-hidden="true">
              <SectionIcon id={s.id} />
            </span>
            <span className={styles.railLabel}>{s.label}</span>
            {!s.enabled && <span className={styles.soon}>soon</span>}
          </button>
        ))}
      </nav>

      <div className={styles.content}>
        {/* ⭐ SPELLED OUT, ALWAYS, WHENEVER IT APPLIES — see the block above.
            The `<select>` IS the chip: it names the plant in the header of
            every section rather than hiding the state behind a menu.
            ⚠️ Rendered only above two readable plants (`plantFilter.visible`).
            A greyed-out control for somebody with one plant reads as "you lack
            permission" rather than "there is only one", which is D106's shape,
            so there is no row at all. The test is READABLE ROOTS, never the
            role — a company admin of a one-plant org correctly gets none. */}
        {plantFilter.visible && (
          <div className={styles.plantRow}>
            <label className={styles.plantLabel} htmlFor="admin-plant">
              Showing
            </label>
            <select
              id="admin-plant"
              className={styles.plantSelect}
              value={plantFilter.choice ?? ""}
              onChange={(e) => setPlantChoice(orgId, e.target.value === "" ? null : e.target.value)}
            >
              {/* ⭐ "All plants" is a real choice and is named as one, not an
                  empty first entry. It is how a reader widens back out, and a
                  blank option would make the header go silent in exactly the
                  state where it most needs to speak. */}
              <option value="">All plants</option>
              {plantFilter.plants.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {activeSection === "hierarchy" && (
          <>
            <h1 className={styles.h1}>Hierarchy</h1>
            {/* `!canQuery || isLoading` — NOT `isLoading` alone. With
                `enabled: false` React Query v5 reports `isPending` with
                `fetchStatus: "idle"`, so `isLoading` is FALSE while the
                session is still resolving: gating the query without widening
                this condition renders a blank card instead of a spinner.
                That is §19.8's exact mistake — guarding the cache but not the
                loading flag — and it is why `decideSessionUpdate` exists. */}
            {(!canQuery || isLoading) && <p className={styles.status}>Loading…</p>}
            {isError && (
              <p className={styles.status} role="alert">
                Couldn't load the hierarchy. Try refreshing the page.
              </p>
            )}
            {data && (
              // `ShapePicker` renders above `LevelEditor` in the left
              // column (§7.3); `NodeTreeEditor` still spans the full right
              // column as before. Placed by explicit grid position (no
              // px, nothing but integers/strings) rather than a new
              // wrapper class, since `AdminPage.module.css` is not in this
              // brief's file table — flagged in the delivery report.
              <div className={styles.hierarchyGrid}>
                {/* D90b (design plan §19.24): ONE card. The level editor is a
                    child of the Site Structure card because it only ever edits
                    the structure selected there — they were peers while being
                    parent and child, and nothing on screen said so. */}
                <div style={{ gridColumn: 1, gridRow: 1 }}>
                  <ShapePicker
                    summaries={plantSummaries}
                    selectedId={resolvedShapeId}
                    onSelect={setSelectedShapeId}
                  >
                    {/* key={resolvedShapeId}: remounts the editor on every
                        structure switch (§7.4) so a previous structure's draft
                        rows can never be left on screen and saved into the newly
                        selected template -- simpler and harder to get wrong
                        than an effect that has to stay in sync by hand. */}
                    <LevelEditor
                      key={resolvedShapeId}
                      levels={data.levels}
                      /* D92's client mirror (§19.30): the level editor cannot
                         say whether an order would strand anything without
                         knowing where the nodes sit. Same COMPLETE array the
                         tree gets -- `findLevelOrderProblems` scopes by
                         template itself, as the RPC does. */
                      nodes={data.nodes}
                      templateId={resolvedShapeId}
                    />
                  </ShapePicker>
                  {/* ⚠️ COUNTED, LIKE EVERY OTHER TRIM ON THESE SCREENS. A
                      structure list that quietly shrank looks exactly like a
                      company with fewer structures than it has — and this one
                      is the list somebody goes to when they cannot find the
                      structure they meant to edit. */}
                  {hiddenShapes > 0 && (
                    <p className={styles.plantNote}>
                      {hiddenShapes === 1
                        ? `1 structure outside ${plantFilter.label} is not shown.`
                        : `${hiddenShapes} structures outside ${plantFilter.label} are not shown.`}
                    </p>
                  )}
                </div>
                <div style={{ gridColumn: 2, gridRow: 1 }}>
                  {/* `levels` here is the COMPLETE array, never filtered by
                      shape (§7.6/§6.3 debt 2 carried forward) -- `canDropOn`
                      and `legalParentsFor` need every level to answer
                      honestly about a move across shapes. */}
                  <NodeTreeEditor
                    nodes={data.nodes}
                    levels={data.levels}
                    shapeSummaries={summaries}
                    selectedTemplateId={resolvedShapeId}
                    /* Roadmap 1(c). DISPLAY ONLY — `nodes` above stays the
                       complete array so no legality check is ever answered
                       from a filtered tree. `null` when nothing is narrowed,
                       so the unfiltered case draws exactly what it always did. */
                    visibleNodeIds={plantFilter.choice === null ? null : plantNodeIds}
                    plantLabel={plantFilter.choice === null ? null : plantFilter.label}
                  />
                </div>
              </div>
            )}
          </>
        )}

        {activeSection === "access" && (
          <>
            <h1 className={styles.h1}>Access</h1>
            <SiteAccessPanel
              places={visibleAccessPlaces}
              treeLoading={hierarchyLoading}
              viewerProfileId={profile?.id ?? null}
              viewerIsCompanyAdmin={profile?.role === "admin"}
            />
          </>
        )}

        {/* §19.62 — the four queued sections. Unreachable until their panels
            set `_PANEL_READY`, because the rail button stays disabled; they are
            wired now so that the four lanes never edit this file. The heading
            stays HERE, next to the two above it, so every section has the same
            chrome without four copies of it (D100). */}
        {activeSection === "shifts" && (
          <>
            <h1 className={styles.h1}>Shifts</h1>
            <ShiftsPanel />
          </>
        )}

        {activeSection === "operators" && (
          <>
            <h1 className={styles.h1}>Operators</h1>
            <OperatorsPanel />
          </>
        )}

        {activeSection === "trainings" && (
          <>
            <h1 className={styles.h1}>Trainings</h1>
            <TrainingsPanel />
          </>
        )}

        {activeSection === "matrix" && (
          <>
            <h1 className={styles.h1}>Training matrix</h1>
            <MatrixPanel />
          </>
        )}

        {activeSection === "products" && (
          <>
            <h1 className={styles.h1}>Products</h1>
            <ProductsPanel />
          </>
        )}

        {activeSection === "cycletimes" && (
          <>
            <h1 className={styles.h1}>Cycle times</h1>
            <CycleTimesPanel />
          </>
        )}

        {activeSection === "import" && (
          <>
            <h1 className={styles.h1}>Import</h1>
            <ImportPanel />
          </>
        )}

        {activeSection === "settings" && (
          <>
            <h1 className={styles.h1}>Settings</h1>
            <SettingsPanel />
          </>
        )}
      </div>
    </div>
  );
}
