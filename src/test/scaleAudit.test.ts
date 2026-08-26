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
  it("R10: REM_SURFACES is exactly the six admin stylesheets", () => {
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
