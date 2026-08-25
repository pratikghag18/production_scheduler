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
  it("R10: REM_SURFACES is exactly the four admin stylesheets", () => {
    expect([...REM_SURFACES].sort()).toEqual(
      [
        "src/features/admin/AdminPage.module.css",
        "src/features/admin/components/AdminPopover.module.css",
        "src/features/admin/components/LevelEditor.module.css",
        "src/features/admin/components/NodeTreeEditor.module.css",
      ].sort(),
    );
  });
});
