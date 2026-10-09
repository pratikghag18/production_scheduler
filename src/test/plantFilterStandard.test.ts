/// <reference types="node" />
/**
 * THE PLANT-FILTER STANDARD GUARDRAIL.
 *
 * The maintainer, on the Activity tab: *"the filter to select the plant is not
 * doing anything, can you please check that as well? And please ensure that any
 * future tabs created honor the filter."*
 *
 * The second sentence is the requirement. The first is only the instance that
 * exposed it — `AuditPanel` had simply never called `usePlantFilter`, so
 * `AdminPage`'s one plant control sat above a tab that could not see it, and
 * the header chip said "Plant A" over a list of the whole company. Fixing that
 * one panel fixes one panel. This file is what stops the eleventh.
 *
 * ⭐⭐ WHY AN AUDIT AND NOT A CODE REVIEW. The plant choice is read, never
 * passed. `plantFilter.ts` says why in its own header — six per-panel controls
 * would drift apart, so the state lives ONCE on `AdminPage` and every section
 * reads it off the store. That is what makes the feature coherent, and it is
 * also what makes ignoring it INVISIBLE: a panel that never calls
 * `usePlantFilter` compiles, renders, and is wrong only in the sense that it
 * quietly answers a question nobody asked it. `tsc` cannot see a hook that was
 * not called. Nothing else in the tree can either.
 *
 * ⚠️ AND THE FAILURE IT PREVENTS IS THE SILENT ONE. `AdminPage`'s own header
 * records what it cost the last time one tab's selection scoped another *"with
 * no control and nothing explaining why"* — **"Where is Plant 1?", reported
 * from the running app.** A control that names a plant above a list that
 * ignores it is that bug with the sign flipped: the reader is told they are
 * looking at one plant and shown all of them.
 *
 * ---------------------------------------------------------------------------
 * ⭐ THE RULE, IN ONE LINE: every `*Panel.tsx` under `features/admin/components`
 * either READS the shared choice, or is NAMED HERE with a reason in prose.
 * There is no third state and no silence.
 *
 * ⚠️⚠️ "READS" MEANS READS THE CHOICE, NOT IMPORTS THE HOOK. An import that is
 * never consumed is exactly what a copy-pasted panel would carry, and it is the
 * cheapest possible way to pass an audit without honouring anything. So the
 * matcher takes the NAME the hook's result is bound to and requires that name
 * to be read for `.choice` — the only field on `PlantFilter` that narrows
 * anything. `plants`, `visible` and `label` describe the control; `choice` is
 * the answer.
 *
 * ⚠️ THE LIST OF PANELS IS THE DIRECTORY, NOT A CONSTANT. CLAUDE.md §4: adding
 * a file to a directory an audit walks must not mean editing the audit's list
 * in two places. `*Panel.tsx` is the naming convention a new tab already
 * follows (`AdminPage`'s rail renders exactly these), so a twelfth tab is in
 * scope the moment it is created and cannot be added without answering this
 * question.
 * --------------------------------------------------------------------------- */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = process.cwd();

/** Where the admin sections live. */
export const PANEL_DIR = "src/features/admin/components";

/** The one hook that answers "which plant am I showing". */
export const PLANT_HOOK = "usePlantFilter";

/**
 * The panels that do not narrow by plant AND SHOULD NOT, each with the reason
 * spelled out.
 *
 * ⭐⭐ AN EXEMPTION IS AN ARGUMENT, NOT A NAME ON A LIST. The entry has to say
 * what the panel is about and why a plant cannot narrow it, because the whole
 * point of the audit is to force the decision to be MADE rather than skipped.
 * A reason that could be written about any panel at all is not a reason.
 *
 * ⚠️ IT IS EMPTY TODAY, AND THAT IS A FINDING RATHER THAN AN OVERSIGHT. Both
 * candidates were looked at and neither is plant-agnostic — see
 * `PLANT_FILTER_DEBT` below, which is where they went instead.
 */
export const PLANT_AGNOSTIC: ReadonlyMap<string, string> = new Map<string, string>([]);

/**
 * The panels that SHOULD narrow by plant and do not yet.
 *
 * ⭐⭐ THIS IS A DEBT LIST AND IT MAY ONLY EVER SHRINK — the same contract
 * `FIELD_LEGACY` keeps, and for the same reason. The alternative was to write
 * these two into `PLANT_AGNOSTIC`, which would have recorded a bug as a design
 * decision and left nothing to come back to. A count is pinned below so that a
 * third name cannot be added quietly; a new panel has to honour the filter or
 * argue itself onto `PLANT_AGNOSTIC`, and neither route is silent.
 *
 * ⚠️ NOTHING HERE WAS CHANGED WHILE WRITING THIS FILE. Both are separate work,
 * and both would change what somebody sees on a screen; recording the judgement
 * is what this commit is for.
 */
export const PLANT_FILTER_DEBT: ReadonlyMap<string, string> = new Map<string, string>([
  [
    "ImportPanel.tsx",
    "Its four children (ProductsImport, OperatorsImport, TrainingsImport) each call " +
      "`readablePlants` on the raw tree and offer EVERY plant as an import target, so an " +
      "import started while the header reads 'Plant A' can write rows into Plant B. That " +
      "breaks decision 3 of plantFilter.ts — the filter narrows the FORMS too, because what " +
      "you see is what you can create in — and it is the silent direction: the rows land " +
      "somewhere the reader has filtered away and then do not appear. The panel itself is a " +
      "tab strip, so the fix belongs in the three *Import.tsx children and is left for them.",
  ],
  [
    "SiteAccessPanel.tsx",
    "It owns its own place picker on purpose: it used to be scoped by the Hierarchy tab's " +
      "structure selection 'with no control and nothing explaining why', which produced " +
      "'Where is Plant 1?' from the running app. So this is NOT the silent failure — the " +
      "place is named on screen. It is still a contradiction: the header can read 'Plant A' " +
      "while this tab shows Plant B's access list. The fix is to narrow the `places` prop " +
      "AdminPage hands it, keeping the picker; that is a behaviour change and is separate work.",
  ],
]);

/** A reason has to be an argument about THIS panel, not a shrug. */
const MIN_REASON = 80;

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

/**
 * Comments out first — this file, and every panel header in the tree, discusses
 * `usePlantFilter` and `.choice` in prose. A matcher that read comments would
 * pass a panel whose only mention of the filter is a note explaining that it
 * does not have one. CLAUDE.md §4 records that this mistake has been made here
 * more than once.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * The name a file binds the hook's result to, or `null` when it never calls it.
 *
 * `const plant = usePlantFilter(nodes)` -> `"plant"`.
 */
export function plantFilterBinding(src: string): string | null {
  const m = new RegExp(`\\b(?:const|let|var)\\s+(\\w+)\\s*=\\s*${PLANT_HOOK}\\s*\\(`).exec(
    stripComments(src),
  );
  return m === null ? null : m[1];
}

/**
 * Does this source actually narrow by the shared choice?
 *
 * Both halves are required: the hook is called, AND the value it returns is
 * read for `.choice`. Calling and discarding is the shape a copy-paste leaves
 * behind, and it is indistinguishable from not calling at all as far as what
 * lands on the screen.
 */
export function honoursPlantFilter(src: string): boolean {
  const name = plantFilterBinding(src);
  if (name === null) return false;
  return new RegExp(`\\b${name}\\.choice\\b`).test(stripComments(src));
}

/** Every admin panel, taken from the directory rather than from a list. */
export function adminPanels(): string[] {
  return fs
    .readdirSync(path.join(repoRoot, PANEL_DIR))
    .filter((f) => f.endsWith("Panel.tsx"))
    .sort();
}

/* ===========================================================================
 * THE MATCHER, HELD AGAINST SOURCES WRITTEN TO BREAK IT.
 *
 * ⭐ A guardrail that has only ever been run against a tree that passes is a
 * guardrail nobody has seen work. Each case below is a panel somebody could
 * plausibly write.
 * ======================================================================== */

describe("the matcher can tell honouring from ignoring", () => {
  it("passes a panel that reads the choice", () => {
    const good = `
      import { usePlantFilter } from "../hooks/usePlantFilter";
      export function ThingsPanel() {
        const plant = usePlantFilter(nodes);
        const rows = rowsInPlant(all, plant.choice, plant.plants, byId);
        return <Table rows={rows} />;
      }`;
    expect(honoursPlantFilter(good)).toBe(true);
  });

  it("⭐ FAILS a NEW panel that simply never asks — the case this file exists for", () => {
    const fresh = `
      import { useQuery } from "@tanstack/react-query";
      export function WidgetsPanel() {
        const rows = useQuery({ queryKey: ["widgets"], queryFn: fetchWidgets });
        return <Table rows={rows.data ?? []} />;
      }`;
    expect(honoursPlantFilter(fresh)).toBe(false);
  });

  it("⭐⭐ FAILS a panel that imports the hook and throws the answer away", () => {
    const cargoCult = `
      import { usePlantFilter } from "../hooks/usePlantFilter";
      export function WidgetsPanel() {
        const plant = usePlantFilter(nodes);
        return <Header label={plant.label} visible={plant.visible} />;
      }`;
    expect(plantFilterBinding(cargoCult)).toBe("plant");
    expect(honoursPlantFilter(cargoCult)).toBe(false);
  });

  it("⚠️ FAILS a panel whose only mention of the filter is a comment about not having one", () => {
    const excuse = `
      /* This panel is company-wide, so const plant = usePlantFilter(nodes) and
         plant.choice would mean nothing here. */
      export function WidgetsPanel() { return <Table />; }`;
    expect(honoursPlantFilter(excuse)).toBe(false);
  });

  it("does not care what the binding is called", () => {
    const named = `
      const plantFilter = usePlantFilter(nodes);
      const scope = settingsScope(plantFilter.choice, plantFilter.plants, isSystemAdmin);`;
    expect(plantFilterBinding(named)).toBe("plantFilter");
    expect(honoursPlantFilter(named)).toBe(true);
  });

  it("⚠️ is not fooled by another binding's `.choice`", () => {
    const decoy = `
      const plant = usePlantFilter(nodes);
      const shape = useShapePicker();
      return <List id={shape.choice} />;`;
    expect(honoursPlantFilter(decoy)).toBe(false);
  });
});

/* ===========================================================================
 * THE TREE.
 * ======================================================================== */

describe("every admin panel has answered the plant question", () => {
  it("the directory is what is walked, and it holds the panels the rail renders", () => {
    const panels = adminPanels();
    expect(panels).toContain("AuditPanel.tsx");
    expect(panels).toContain("SettingsPanel.tsx");
    // Ten sections today. The number is not asserted — a new tab must be
    // ALLOWED to appear; what it may not do is appear without an answer.
    expect(panels.length).toBeGreaterThanOrEqual(10);
  });

  it("⭐⭐ no panel ignores the shared plant filter without saying why", () => {
    const silent = adminPanels().filter(
      (f) =>
        !honoursPlantFilter(read(`${PANEL_DIR}/${f}`)) &&
        !PLANT_AGNOSTIC.has(f) &&
        !PLANT_FILTER_DEBT.has(f),
    );
    expect(silent).toEqual([]);
  });

  it("⭐ the Activity tab honours it — the report that prompted this rule", () => {
    expect(honoursPlantFilter(read(`${PANEL_DIR}/AuditPanel.tsx`))).toBe(true);
  });

  it("the panels measured as honouring still do", () => {
    const expected = [
      "CycleTimesPanel.tsx",
      "MatrixPanel.tsx",
      "OperatorsPanel.tsx",
      "ProductsPanel.tsx",
      "SettingsPanel.tsx",
      "ShiftsPanel.tsx",
      "TrainingsPanel.tsx",
    ];
    const failing = expected.filter((f) => !honoursPlantFilter(read(`${PANEL_DIR}/${f}`)));
    expect(failing).toEqual([]);
  });

  it("a named panel is a panel that exists, so a rename cannot orphan a reason", () => {
    const panels = new Set(adminPanels());
    const missing = [...PLANT_AGNOSTIC.keys(), ...PLANT_FILTER_DEBT.keys()].filter(
      (f) => !panels.has(f),
    );
    expect(missing).toEqual([]);
  });

  it("⚠️ a panel that has started honouring is off both lists, so neither can go stale", () => {
    const stale = [...PLANT_AGNOSTIC.keys(), ...PLANT_FILTER_DEBT.keys()].filter((f) =>
      honoursPlantFilter(read(`${PANEL_DIR}/${f}`)),
    );
    expect(stale).toEqual([]);
  });

  it("every reason is an argument about that panel, not a shrug", () => {
    const thin = [...PLANT_AGNOSTIC.entries(), ...PLANT_FILTER_DEBT.entries()]
      .filter(([, why]) => why.trim().length < MIN_REASON)
      .map(([f]) => f);
    expect(thin).toEqual([]);
  });

  /**
   * ⭐⭐ THE DEBT LIST MAY ONLY SHRINK. Without this the audit is a form to
   * fill in: anybody could add a panel and a sentence and be green. Growing the
   * list has to be a deliberate edit to this number, in a commit that says why
   * a new screen is shipping already knowing it is wrong.
   */
  it("the debt list may only ever shrink", () => {
    expect([...PLANT_FILTER_DEBT.keys()].sort()).toEqual([
      "ImportPanel.tsx",
      "SiteAccessPanel.tsx",
    ]);
  });

  /**
   * ⚠️ THE SECOND PRONG, AND IT IS WHERE `ImportPanel`'s DEBT ACTUALLY LIVES.
   * `readablePlants` is how the plant list is built. `usePlantFilter` is the
   * only place allowed to call it, because anywhere else it is a panel building
   * its own list of plants out of the raw tree and never learning which one the
   * reader picked — which is exactly what the three import forms do.
   */
  it("only the shared hook builds a plant list from the raw tree", () => {
    const KNOWN = ["OperatorsImport.tsx", "ProductsImport.tsx", "TrainingsImport.tsx"];
    const callers = fs
      .readdirSync(path.join(repoRoot, PANEL_DIR))
      .filter((f) => f.endsWith(".tsx"))
      .filter((f) => /\breadablePlants\s*\(/.test(stripComments(read(`${PANEL_DIR}/${f}`))))
      .sort();
    expect(callers).toEqual(KNOWN.sort());
  });
});
