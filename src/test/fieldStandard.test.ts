/// <reference types="node" />
/**
 * THE EDITABLE-BOX STANDARD GUARDRAIL (R-318).
 *
 * The maintainer, 3 Sept, on the cycle-times grid: *"does this save button and
 * font seem like it is different than what we're using for the rest of the
 * app?... we should make the editable boxes a standard for the app."*
 *
 * They were right, and the cause was structural. The app HAD a field look — a
 * 1px `--axis` border, a small radius, a `--page` background — but it lived only
 * as a block hand-copied into eleven admin stylesheets. The twelfth screen had
 * nothing to import, so it got the user agent's controls. Nothing could have
 * caught that, because there was no single definition to be inconsistent WITH.
 *
 * Now there is: `src/components/Field.module.css`. This audit stops a
 * thirteenth copy. Same shape as `popoverStandard.test.ts` (which bans
 * `role="dialog"` outside the shared shell) and `iconStandard.test.ts`.
 *
 * ⭐ THE LEGACY LIST IS THE HONEST PART. The eleven stylesheets that predate the
 * standard still carry their own copies; migrating them is a separate piece of
 * work and pretending otherwise would mean either a failing suite or a rule
 * that exempts everything. So they are NAMED. A file on the list may keep its
 * copy; a file NOT on the list that declares a field border is a build failure,
 * and the list may only ever get shorter. That makes the debt bounded and
 * visible instead of quietly growing, which is the same trade `REM_SURFACES`
 * makes for the rem audit.
 *
 * ⚠️ COMMENTS ARE STRIPPED FIRST — this file and the shared module both describe
 * the rule in prose that names the very declaration being matched, and a
 * matcher that read comments would flag its own documentation. That mistake has
 * been made twice on this project already.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = process.cwd();

/** The one module allowed to define what an editable box looks like. */
export const FIELD_MODULE = "src/components/Field.module.css";

/**
 * Stylesheets that carried their own copy of the field look before the standard
 * existed. They are grandfathered, not blessed. ⚠️ THIS LIST MAY ONLY SHRINK —
 * adding to it means a new screen hand-rolled a field, which is the thing the
 * audit exists to prevent.
 */
export const FIELD_LEGACY: readonly string[] = [
  "src/features/admin/components/ImportPanel.module.css",
  "src/features/admin/components/NodeTreeEditor.module.css",
  "src/features/admin/components/OperatorsPanel.module.css",
  "src/features/admin/components/ProductsPanel.module.css",
  "src/features/admin/components/ShapePicker.module.css",
  "src/features/admin/components/ShiftsPanel.module.css",
  "src/features/admin/components/SiteAccessPanel.module.css",
  "src/features/admin/components/TrainingsPanel.module.css",
  "src/features/admin/components/matrixCells.module.css",
  "src/features/admin/components/MatrixPanel.module.css",
  "src/features/admin/AdminPage.module.css",
  "src/features/admin/components/LevelEditor.module.css",
  "src/features/admin/components/DeleteDialog.module.css",
  "src/features/admin/components/dragSurface.module.css",
  // ⚠️ THE BOARD AND THE SHELL CARRY COPIES TOO, and finding that out is what
  // this audit was for. The maintainer's report named the admin grid, and the
  // eleven admin stylesheets were the obvious suspects; running the matcher
  // over the whole tree turned up fourteen more. Thirty files hand-declare the
  // same control skin. That is the size of the thing the standard replaces, and
  // it is written down rather than rounded off.
  "src/features/board/components/TargetField.module.css",
  "src/features/board/components/AssignmentPopover.module.css",
  "src/features/board/components/BoardToolbar.module.css",
  "src/features/board/components/ConfirmPopover.module.css",
  "src/features/board/components/CreatePopover.module.css",
  "src/features/board/components/OperatorPanel.module.css",
  "src/features/board/components/RunBand.module.css",
  "src/features/board/components/RunPopover.module.css",
  "src/features/board/components/SplitCoveragePopover.module.css",
  "src/features/board/components/TrackRow.module.css",
  "src/components/HealthPill.module.css",
  "src/components/PanelToggle.module.css",
  "src/features/auth/DevProfileSwitcher.module.css",
  "src/features/auth/SignInPage.module.css",
  "src/features/auth/SignOutButton.module.css",
];

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Does this stylesheet define its own editable box?
 *
 * The signal is a declaration block that sets BOTH a `--axis` border and a
 * `border-radius` — the two halves of the app's field skin. A file that merely
 * borders a card or a table is not hand-rolling a control, and flagging those
 * would make the rule noise rather than a rule.
 */
export function fieldOffences(css: string): string[] {
  const src = stripComments(css);
  const out: string[] = [];
  // Split into `selector { body }` pairs.
  const block = /([^{}]+)\{([^{}]*)\}/g;
  let m = block.exec(src);
  while (m !== null) {
    const selector = m[1].trim();
    const body = m[2];
    const hasAxisBorder = /border(-[a-z]+)?\s*:\s*[^;]*var\(--axis\)/.test(body);
    const hasRadius = /border-radius\s*:/.test(body);
    const looksLikeControl = /padding\s*:/.test(body) && /font-size\s*:/.test(body);
    if (hasAxisBorder && hasRadius && looksLikeControl) {
      out.push(selector.replace(/\s+/g, " "));
    }
    m = block.exec(src);
  }
  return out;
}

function allStylesheets(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) allStylesheets(rel, acc);
    else if (entry.name.endsWith(".module.css")) acc.push(rel);
  }
  return acc;
}

describe("R-318: the editable box is defined once", () => {
  it("the shared module exists and defines the box", () => {
    const css = fs.readFileSync(path.join(repoRoot, FIELD_MODULE), "utf8");
    expect(fieldOffences(css).length).toBeGreaterThan(0);
    // The resting box and the open box must share the geometry, or a cell jumps
    // on click and a column of them looks indented. `composes` is what makes
    // that true by construction rather than by two numbers kept in step.
    expect(/\.resting\s*\{[^}]*composes:\s*field/.test(stripComments(css))).toBe(true);
    expect(/\.readonly\s*\{[^}]*composes:\s*field/.test(stripComments(css))).toBe(true);
    expect(/\.editorInput\s*\{[^}]*composes:\s*field/.test(stripComments(css))).toBe(true);
  });

  it("no stylesheet outside the shared module and the legacy list rolls its own field", () => {
    const sheets = allStylesheets("src").filter(
      (f) => f !== FIELD_MODULE && !FIELD_LEGACY.includes(f),
    );
    const offenders: Array<{ file: string; selectors: string[] }> = [];
    for (const file of sheets) {
      const selectors = fieldOffences(fs.readFileSync(path.join(repoRoot, file), "utf8"));
      if (selectors.length > 0) offenders.push({ file, selectors });
    }
    expect(offenders).toEqual([]);
  });

  it("the cycle-times panel — the screen that prompted this — rolls none of its own", () => {
    const css = fs.readFileSync(
      path.join(repoRoot, "src/features/admin/components/CycleTimesPanel.module.css"),
      "utf8",
    );
    expect(fieldOffences(css)).toEqual([]);
    expect(FIELD_LEGACY).not.toContain("src/features/admin/components/CycleTimesPanel.module.css");
  });

  it("every legacy entry still exists — the list may only shrink", () => {
    for (const file of FIELD_LEGACY) {
      expect(fs.existsSync(path.join(repoRoot, file)), `${file} is listed but missing`).toBe(true);
    }
  });

  it("the matcher fires on a hand-rolled control and not on a card or a table", () => {
    const handRolled = `.input { border: 1px solid var(--axis); border-radius: 0.375rem;
      padding: 0.3125rem 0.5rem; font-size: 0.8125rem; }`;
    expect(fieldOffences(handRolled)).toEqual([".input"]);

    // A bordered card has no font-size and is not a control.
    const card = `.card { border: 1px solid var(--axis); border-radius: 0.625rem;
      padding: 0.875rem 1rem; }`;
    expect(fieldOffences(card)).toEqual([]);

    // A table cell borders without a radius.
    const cell = `.cell { border-bottom: 1px solid var(--grid); padding: 0.3125rem;
      font-size: 0.875rem; }`;
    expect(fieldOffences(cell)).toEqual([]);

    // And it does not read its own prose.
    const commented = `/* .input { border: 1px solid var(--axis); border-radius: 0.375rem;
      padding: 1rem; font-size: 1rem; } */ .x { color: red; }`;
    expect(fieldOffences(commented)).toEqual([]);
  });
});
