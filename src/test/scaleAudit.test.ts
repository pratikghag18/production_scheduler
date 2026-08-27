/// <reference types="node" />
// See the note in scaleAudit.ts: node types are referenced per-file rather
// than added to the app tsconfig, because this is a browser app.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CHROME_FILES,
  countUiScaleUses,
  auditChromeFiles,
  REM_SURFACES,
  unscaledPxLengths,
  auditRemSurfaces,
  missingRemSurfaces,
  missingControlFontReset,
  RESET_CONTROLS,
  DRAG_SHARED_SURFACE,
  DRAG_SURFACES,
  SHARED_DRAG_DECLARATIONS,
  RAW_DRAG_COLOURS,
  missingDragCompose,
  unsharedDragRules,
  rawDragColours,
  undefinedDragTokens,
  ADMIN_PAGE,
  parseSectionIds,
  sectionsWithoutPanels,
  auditAdminSections,
} from "./scaleAudit";

/**
 * Brief P1-5c §8 group A (10 assertions) for the `--ui-scale` file audit
 * (design plan §19.6/§19.7 D76). The rule: anything outside the fitted
 * scroll container that consumes vertical space must not use `--ui-scale`,
 * because its height feeds `computeFitScale`, whose output IS `--ui-scale`
 * -- and `.header` wraps, so the coupling is a step function with no fixed
 * point (§19.6's two-cycle: lane-h alternating 28px/31px forever).
 *
 * Group A needs a repo root; vitest runs from the repo root, so it is
 * taken from `process.cwd()` here rather than hardcoded.
 *
 * Authored, not run in this container (no npm) -- the /tmp harness copy of
 * this exact module was executed against the real repo CSS files (staged
 * in, not fixtures) and mutation-tested against all of the brief's §9
 * mutations (N1-N4) before this file was written. See the agent report.
 */

const repoRoot = process.cwd();

describe("scaleAudit.ts: countUiScaleUses", () => {
  it("A4: a fitted file DOES use it — the matcher is not vacuous", () => {
    const fitted = `.foo { width: calc(190px * var(--ui-scale, 1)); }`;
    expect(countUiScaleUses(fitted)).toBeGreaterThan(0);
  });

  it("A5: a var(--ui-scale...) snippet inside a comment is not a use", () => {
    // The comment body contains the literal pattern the regex looks for
    // (documentation showing example code) -- distinct from A2's
    // prose-only mention below. This is what actually distinguishes
    // "comments are stripped first" from a naive regex over the raw file.
    const css = `/* example: width: var(--ui-scale, 1); */\n.foo { color: red; }`;
    expect(countUiScaleUses(css)).toBe(0);
  });

  it("A6: real use counts", () => {
    const css = `.foo { width: calc(20px * var(--ui-scale, 1)); }`;
    expect(countUiScaleUses(css)).toBe(1);
  });

  it("A7: whitespace inside var() counts", () => {
    const css = `.foo { width: var( --ui-scale , 1 ); }`;
    expect(countUiScaleUses(css)).toBe(1);
  });

  it("A8: a prefix token is not a false positive", () => {
    const css = `.foo { width: var(--ui-scaled, 1); }`;
    expect(countUiScaleUses(css)).toBe(0);
  });

  it("A9: the var(--x, fallback) form counts", () => {
    const css = `.foo { width: var(--ui-scale, 1); }`;
    expect(countUiScaleUses(css)).toBe(1);
  });
});

describe("scaleAudit.ts: auditChromeFiles against the real repo", () => {
  it.each(auditChromeFiles(repoRoot))("A1: $file has zero --ui-scale uses", ({ uses }) => {
    expect(uses).toBe(0);
  });

  it("A2: BoardToolbar really does mention the token in prose", () => {
    const css = readFileSync(
      `${repoRoot}/src/features/board/components/BoardToolbar.module.css`,
      "utf8",
    );
    expect(css.includes("--ui-scale")).toBe(true);
  });

  it("A3: BoardToolbar has zero real uses", () => {
    const report = auditChromeFiles(repoRoot, [
      "src/features/board/components/BoardToolbar.module.css",
    ]);
    expect(report[0].uses).toBe(0);
  });

  it("A10: CHROME_FILES is exactly the five files", () => {
    expect(CHROME_FILES).toEqual([
      "src/components/AppShell.module.css",
      "src/components/HealthPill.module.css",
      "src/features/auth/DevProfileSwitcher.module.css",
      "src/features/board/components/BoardToolbar.module.css",
      "src/features/board/BoardPage.module.css",
    ]);
  });
});

/**
 * D84 — scaling is the DEFAULT, and this is what enforces it.
 *
 * The admin screens shipped with 129 raw pixel values and zero uses of
 * `--chrome-scale`, so on a 4K display the board scaled to 1.35x and the admin
 * page stayed at 1x. Nothing checked, so nothing stopped it. The root font-size
 * now scales and these surfaces size in `rem`; these cases make forgetting that
 * a test failure instead of something noticed on a monitor three briefs later.
 *
 * All seven mutations of the audit were executed and each is caught by a named
 * case below. One of them, Z2, initially reported NOT CAUGHT for a reason worth
 * recording: `countUiScaleUses` and `unscaledPxLengths` contain the IDENTICAL
 * comment-stripping line, so a single-occurrence replace mutated the wrong
 * function entirely. A mutation must be anchored on something unique to the
 * function under test.
 */
describe("D84: rem surfaces contain no unscaled pixel dimensions", () => {
  it("R1: every rem surface is clean", () => {
    const offenders = auditRemSurfaces(repoRoot).filter((r) => r.offenders.length > 0);
    expect(offenders).toEqual([]);
  });

  // NOT VACUOUS: an audit that never matches anything reports success just as
  // loudly as one with nothing to find.
  it("R2: the matcher fires on a px-based declaration", () => {
    expect(unscaledPxLengths(".a {\n  padding: 12px 8px;\n}").length).toBeGreaterThan(0);
  });

  it("R3: a hairline border is exempt", () => {
    expect(unscaledPxLengths(".a { border: 1px solid red; }")).toEqual([]);
  });

  it("R4: a NON-hairline border width is flagged", () => {
    expect(unscaledPxLengths(".a { border: 4px solid red; }").length).toBe(1);
  });

  it("R5: box-shadow offsets are exempt", () => {
    expect(unscaledPxLengths(".a { box-shadow: 0 10px 40px #000; }")).toEqual([]);
  });

  // A breakpoint is about the DEVICE. In `rem` it would resolve against the
  // scaled root and move with the scale — a real bug in the first conversion.
  it("R6: a @media prelude is exempt", () => {
    expect(unscaledPxLengths("@media (max-width: 900px) {\n  .a { color: red; }\n}")).toEqual([]);
  });

  it("R7: a comment mentioning 16px is not flagged", () => {
    expect(unscaledPxLengths("/* 1rem = 16px at the default */\n.a { color: red; }")).toEqual([]);
  });

  it("R8: 0px is exempt", () => {
    expect(unscaledPxLengths(".a { margin: 0px; }")).toEqual([]);
  });

  it("R12: border-radius is NOT exempt — a radius is a real dimension", () => {
    expect(unscaledPxLengths(".a { border-radius: 20px; }").length).toBe(1);
  });

  it("R13: 3px border flagged, 2px border exempt", () => {
    expect(unscaledPxLengths(".a { border: 3px solid red; }").length).toBe(1);
    expect(unscaledPxLengths(".a { border: 2px solid red; }")).toEqual([]);
  });

  // The hairline exemption is border-only. Without this, widening it to every
  // property goes unnoticed.
  it("R14: a 2px non-border dimension is flagged", () => {
    expect(unscaledPxLengths(".a { gap: 2px; }").length).toBe(1);
  });

  // The LIST is part of the guard: drop a file and it silently stops being
  // guarded while every other case still passes.
  //
  // D89: ShapePicker.module.css was added here after it shipped in P1-5f
  // WITHOUT being listed — this case is what caught the omission, which is
  // exactly what it exists for. Adding a sixth admin surface means updating
  // this literal AND nothing else: `missingRemSurfaces` (below) now walks the
  // directory, so it catches a surface that exists on disk and is not listed,
  // while this case catches the list drifting for any other reason.
  it("R10: REM_SURFACES is exactly the eleven admin stylesheets", () => {
    // Brief P1-6a §7: updated per this describe block's own comment above --
    // "Adding a sixth admin surface means updating this literal AND nothing
    // else" -- when `SiteAccessPanel.module.css` was added to REM_SURFACES.
    // Not in the P1-6a brief's own file table (which named only
    // `src/test/scaleAudit.ts`), but leaving this hardcoded five-file list
    // unchanged would fail this case the moment the required sixth entry
    // landed -- see the delivery report's deviations section.
    expect([...REM_SURFACES].sort()).toEqual(
      [
        "src/features/admin/AdminPage.module.css",
        "src/features/admin/components/AdminPopover.module.css",
        "src/features/admin/components/LevelEditor.module.css",
        "src/features/admin/components/NodeTreeEditor.module.css",
        "src/features/admin/components/ShapePicker.module.css",
        "src/features/admin/components/SiteAccessPanel.module.css",
        // D100: the shared drag rules. Seventh surface, same two-place edit.
        "src/features/admin/components/dragSurface.module.css",
        // §19.62: the four queued sections, pre-seated. Spending the two-place
        // edit ONCE, up front, is the whole point of that commit — four lanes
        // each doing it later is four chances to do what P1-6a's brief did and
        // update one place of the two.
        "src/features/admin/components/ShiftsPanel.module.css",
        "src/features/admin/components/OperatorsPanel.module.css",
        "src/features/admin/components/ProductsPanel.module.css",
        "src/features/admin/components/ImportPanel.module.css",
      ].sort(),
    );
  });
});

/**
 * D89 — the two holes D84's enforcement left, both found the hard way.
 *
 * (1) Form controls do not inherit fonts, so a fully D84-compliant stylesheet
 *     still renders 13.3333px Arial controls that never scale. Measured in
 *     headless Chromium at 1440 / 2560 / 3840 CSS px before the fix.
 * (2) `REM_SURFACES` is a hand-maintained list, and `ShapePicker.module.css`
 *     shipped without being added to it — so a whole new admin surface sat
 *     outside the audit while the audit reported green.
 */
describe("D89: the control-font reset in global.css", () => {
  const root = process.cwd();
  const globalCss = readFileSync(`${root}/src/styles/global.css`, "utf8");

  it("covers every control that does not inherit a font by default", () => {
    expect(missingControlFontReset(globalCss)).toEqual([]);
  });

  it("names all four controls — a reset that forgets one is the bug itself", () => {
    expect([...RESET_CONTROLS].sort()).toEqual(["button", "input", "select", "textarea"]);
  });

  it("does not pass on the PROSE that documents the rule", () => {
    // global.css explains this rule in a comment naming all four controls. A
    // matcher that reads comments would pass on the documentation alone —
    // which is exactly the mistake `countUiScaleUses` was written to avoid.
    const commentOnly = `/* input, button, select, textarea { font: inherit; } */\nbody { margin: 0; }`;
    expect(missingControlFontReset(commentOnly).sort()).toEqual([
      "button",
      "input",
      "select",
      "textarea",
    ]);
  });

  it("reports exactly the control a partial reset leaves out", () => {
    const partial = `input, button, select { font: inherit; }`;
    expect(missingControlFontReset(partial)).toEqual(["textarea"]);
  });

  it("body sizes in rem, so inherited text scales with the root", () => {
    // An absolute `font: 13px` on body overrides D84's scaled root for
    // everything that merely inherits — measured: body stayed 13px at 3840
    // CSS px while a rem-sized sibling reached 17.55px.
    const bodyRule = globalCss.slice(globalCss.indexOf("body {"));
    const decl = bodyRule.slice(0, bodyRule.indexOf("}"));
    expect(decl).toMatch(/font:\s*[\s\S]*?\d*\.?\d+rem\//);
  });
});

describe("D89: REM_SURFACES names every admin stylesheet on disk", () => {
  const root = process.cwd();

  it("has no unaudited *.module.css under src/features/admin", () => {
    expect(missingRemSurfaces(root)).toEqual([]);
  });

  it("would report a surface that exists but is not listed", () => {
    // The guard must be able to FAIL — a list-completeness check that always
    // returns [] is the same silent pass it was written to prevent.
    const short = REM_SURFACES.filter(
      (f) => f !== "src/features/admin/components/ShapePicker.module.css",
    );
    expect(missingRemSurfaces(root, undefined, short)).toEqual([
      "src/features/admin/components/ShapePicker.module.css",
    ]);
  });
});

/**
 * D100 group G (11 cases) — the drag audit.
 *
 * Pratik, Aug 27: *"Can we make sure we match the colors on drag selection in
 * all areas, shouldn't this be done by default? It seems we're reinventing
 * stuff vs reusing it."*
 *
 * The two admin drag surfaces had each grown their own grip block, their own
 * ghost opacity and their own row hover — and the two hovers were different
 * colours, one of which (`--page` on `--surface`, three units) had already been
 * measured as rendering nothing. Every declaration in both files was correct;
 * the defect was that there were two of them. These cases make "one copy" a
 * property the suite checks rather than a habit somebody keeps.
 *
 * Half the group runs against synthetic CSS, on purpose: a case that only ever
 * looks at the repo passes for as long as the repo is clean and says nothing
 * about whether the matcher can fail at all (verification-standard rule 3).
 */
describe("scaleAudit.ts: the drag audit (D100)", () => {
  const read = (f: string): string => readFileSync(`${repoRoot}/${f}`, "utf8");

  it("G1: every drag surface composes from the shared file", () => {
    expect(DRAG_SURFACES.filter((f) => missingDragCompose(read(f)))).toEqual([]);
  });

  it("G2: the compose matcher can fail — a surface with no compose is flagged", () => {
    expect(missingDragCompose(`.row { display: flex; }`)).toBe(true);
  });

  it("G3: the compose matcher tolerates whitespace and case", () => {
    expect(missingDragCompose(`.row { composes: dragRow from "./dragSurface.module.css"; }`)).toBe(
      false,
    );
  });

  it("G4: no drag surface re-declares a shared drag rule", () => {
    const offenders = DRAG_SURFACES.flatMap((f) =>
      unsharedDragRules(read(f)).map((rule) => `${f}: ${rule}`),
    );
    expect(offenders).toEqual([]);
  });

  it("G5: the shared file declares every one of them — the list is not vacuous", () => {
    // Without this, deleting a needle from SHARED_DRAG_DECLARATIONS would make
    // G4 greener rather than redder. A list that drives a test is itself
    // untested unless something asserts the list.
    const shared = read(DRAG_SHARED_SURFACE);
    const absent = SHARED_DRAG_DECLARATIONS.filter((n) => unsharedDragRules(shared, [n]).length === 0);
    expect(absent).toEqual([]);
  });

  it("G6: the rule matcher fires on a locally re-declared grab cursor", () => {
    expect(unsharedDragRules(`.row { cursor : GRAB ; }`)).toEqual(["cursor:grab"]);
  });

  it("G7: a shared rule quoted inside a comment is not a re-declaration", () => {
    // Instrument 37's family: these files explain themselves in prose that
    // quotes the very declarations being looked for.
    expect(unsharedDragRules(`/* the shared file sets cursor: grab here */\n.row{gap:1rem}`)).toEqual(
      [],
    );
  });

  it("G8: no drag surface reaches past its tokens to a raw semantic colour", () => {
    const offenders = DRAG_SURFACES.flatMap((f) =>
      rawDragColours(read(f)).map((c) => `${f}: ${c}`),
    );
    expect(offenders).toEqual([]);
  });

  it("G9: the raw-colour matcher fires, and RAW_DRAG_COLOURS is not empty", () => {
    expect(RAW_DRAG_COLOURS.length).toBeGreaterThan(0);
    expect(rawDragColours(`.caret { border-top: 2px solid var(--signal-ok); }`)).toEqual([
      "var(--signal-ok)",
    ]);
  });

  it("G10: every --drag-*/--drop-* token the surfaces read is defined in tokens.css", () => {
    const sheets = [DRAG_SHARED_SURFACE, ...DRAG_SURFACES].map(read);
    expect(undefinedDragTokens(read("src/styles/tokens.css"), sheets)).toEqual([]);
  });

  // ⭐ G12 EXISTS BECAUSE A MUTATION ESCAPED. Quietly deleting a needle from
  // SHARED_DRAG_DECLARATIONS was caught by NOTHING: G4 finds one fewer thing to
  // complain about and G5 has one fewer thing to require, so both go greener.
  // Same hole R10 exists to close one level up — a list that drives a test is
  // itself untested unless something asserts the list.
  it("G12: SHARED_DRAG_DECLARATIONS is exactly these eight", () => {
    expect([...SHARED_DRAG_DECLARATIONS].sort()).toEqual(
      [
        "cursor:grab",
        "cursor:grabbing",
        "user-select:none",
        "touch-action:none",
        "var(--drag-row-hover)",
        "var(--drag-grip)",
        "var(--drag-grip-hover)",
        "var(--drag-ghost-opacity)",
      ].sort(),
    );
  });

  it("G11: the token matcher fires on one nobody defined", () => {
    // A token nobody defines resolves to nothing: for a colour that is
    // transparent, for an opacity the whole declaration is dropped. Both look
    // like a design choice rather than a typo.
    expect(
      undefinedDragTokens(`:root { --drag-grip: red; }`, [`.x { color: var(--drag-invented); }`]),
    ).toEqual(["--drag-invented"]);
  });
});

/**
 * Group H (§19.62) — a rail button with nothing behind it.
 *
 * `AdminPage.tsx` holds two lists that must agree and never referred to each
 * other: `SECTIONS`, which the left rail renders, and the `{section === "x"}`
 * branches that decide what the content pane shows. The pre-seat commit put
 * four new ids in the first; this is what stops the fifth from arriving without
 * the second half.
 *
 * Half of these run against SYNTHETIC source, deliberately: a case that only
 * ever reads the repo passes for as long as the repo is clean and says nothing
 * about whether the matcher can fail at all (rule 3).
 */
describe("scaleAudit — every section in the rail has a panel (§19.62)", () => {
  it("H1: every section the rail renders has a branch that renders it", () => {
    expect(auditAdminSections(repoRoot)).toEqual([]);
  });

  it("H2: the six ids are exactly these, in rail order", () => {
    // The list that drives H1 is itself untested unless something asserts it —
    // deleting an entry from SECTIONS makes H1 *greener*, which is the shape
    // R10 and G12 both exist to close.
    const tsx = readFileSync(`${repoRoot}/${ADMIN_PAGE}`, "utf8");
    expect(parseSectionIds(tsx)).toEqual([
      "hierarchy",
      "access",
      "shifts",
      "operators",
      "products",
      "import",
    ]);
  });

  it("H3: a section with no branch is reported", () => {
    const tsx = `
      const SECTIONS: X = [
        { id: "alpha", label: "Alpha", enabled: true },
        { id: "beta", label: "Beta", enabled: false },
      ];
      function P() { return <>{section === "alpha" && <A />}</>; }
    `;
    expect(sectionsWithoutPanels(tsx)).toEqual(["beta"]);
  });

  it("H4: a COMMENTED-OUT branch does not count as a panel", () => {
    // Instrument 37: a parser that reads comments finds branches that do not
    // exist. `AdminPage.tsx`'s own comments name section ids, so this is the
    // exact way this audit would report a clean bill of health over a hole.
    const tsx = `
      const SECTIONS: X = [{ id: "beta", label: "Beta", enabled: false }];
      /* one day: {section === "beta" && <B />} */
      // or maybe {section === "beta" && <B />}
      function P() { return null; }
    `;
    expect(sectionsWithoutPanels(tsx)).toEqual(["beta"]);
  });

  it("H6: only the SECTIONS array is read, not every `id:` in the file", () => {
    // Written because a mutation escaped: making the array match GREEDY runs it
    // to the LAST `];` in the file, which today captures exactly the same ids
    // and is therefore invisible — until the day someone writes another object
    // with an `id` after it. This is the fixture that makes that difference
    // observable, so the boundary cannot quietly re-open.
    const tsx = `
      const SECTIONS: X = [
        { id: "alpha", label: "Alpha", enabled: true },
      ];
      const OTHER_THINGS = [
        { id: "ghost", label: "Ghost" },
      ];
      function P() { return <>{section === "alpha" && <A />}</>; }
    `;
    expect(parseSectionIds(tsx)).toEqual(["alpha"]);
  });

  it("H5: a file with no SECTIONS array reports no sections rather than throwing", () => {
    expect(parseSectionIds("export function P() { return null; }")).toEqual([]);
    expect(sectionsWithoutPanels("export function P() { return null; }")).toEqual([]);
  });
});
