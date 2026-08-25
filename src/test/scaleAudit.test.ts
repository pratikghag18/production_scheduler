/// <reference types="node" />
// See the note in scaleAudit.ts: node types are referenced per-file rather
// than added to the app tsconfig, because this is a browser app.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CHROME_FILES, countUiScaleUses, auditChromeFiles } from "./scaleAudit";

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
