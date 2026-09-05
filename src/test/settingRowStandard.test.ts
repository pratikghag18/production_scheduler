/// <reference types="node" />
/**
 * THE SETTINGS-ROW STANDARD GUARDRAIL (R-332).
 *
 * The maintainer, on the Settings tab: *"the drop down options are not aligned
 * in different options. It does not look professional. Please create a standard
 * for it."*
 *
 * They were right, and — as with R-318 — the cause was structural rather than
 * careless. `SettingsPanel.module.css` laid a setting out as a flex row with
 * `justify-content: space-between`, a text column of `flex: 1 1 16rem` and a
 * control column of **`flex: 0 0 auto`**. A `flex: 0 0 auto` column is sized by
 * its OWN content, so the eligibility picker (whose longest option reads "Allow
 * it, with a reason on record") and the date picker (whose longest option is a
 * format name plus a sample) computed two different widths. Two rows could only
 * line up by coincidence, and they did not.
 *
 * R-318 made the BOX one definition. This makes the ROW one:
 * `src/components/SettingRow.module.css` declares the two-column grid and the
 * ONE control-track width every settings row uses, and this audit fails the
 * build when a twelfth row is hand-rolled instead of imported.
 *
 * ⭐ WHY A NAME-SHAPED MATCHER RATHER THAN A GEOMETRY-SHAPED ONE. `fieldOffences`
 * can look for the field SKIN because a skin is a set of declarations. A row is
 * a RELATIONSHIP between two columns, and the same declarations that build one
 * (`display: flex`, `justify-content`) build a toolbar, a card header and a
 * legend — matching on them alone would flag half the repo. What is unmistakable
 * is a stylesheet that names a rule after the thing and then lays it out: a
 * `.setting`, `.settingRow` or `.settingControl` that declares a grid, a flex
 * box, a track list or a flex ratio is somebody re-deriving this standard in
 * their own file, which is exactly the copy-and-paste R-318 was about.
 *
 * ⚠️ COMMENTS ARE STRIPPED FIRST — this file and the shared module both describe
 * the rule in prose that names the very declarations being matched, and a
 * matcher that read comments would flag its own documentation. CLAUDE.md §4 and
 * `fieldStandard.test.ts` both record that this mistake has been made here more
 * than once.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = process.cwd();

/** The one module allowed to define what a settings row looks like. */
export const SETTING_ROW_MODULE = "src/components/SettingRow.module.css";

/** The panel the maintainer was looking at. */
export const SETTINGS_PANEL_TSX = "src/features/admin/components/SettingsPanel.tsx";

/**
 * The custom property that carries the control track's width.
 *
 * It exists so the width is a NAMED CONSTANT rather than a number retyped in
 * two places, and so this audit has something specific to count: declared once,
 * in the shared module, and nowhere else. A second declaration anywhere in the
 * tree is a screen giving its own settings a different column, which is the
 * defect with a delay on it.
 */
export const CONTROL_WIDTH_TOKEN = "--setting-control-w";

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** `selector { body }` pairs, ignoring at-rule preludes so `@media` wrappers do
 *  not swallow the rules inside them. */
function rules(css: string): Array<{ selector: string; body: string }> {
  const src = stripComments(css)
    .replace(/@media[^{]*\{/g, "")
    .replace(/@supports[^{]*\{/g, "");
  const out: Array<{ selector: string; body: string }> = [];
  const block = /([^{}]+)\{([^{}]*)\}/g;
  let m = block.exec(src);
  while (m !== null) {
    out.push({ selector: m[1].trim().replace(/\s+/g, " "), body: m[2] });
    m = block.exec(src);
  }
  return out;
}

/** Does this rule name itself a setting? `.setting`, `.settingRow`,
 *  `.settingControl`, `.settingsRow` — the names a copy would pick. */
function namesASetting(selector: string): boolean {
  return /\.setting/i.test(selector);
}

/**
 * Does this rule LAY SOMETHING OUT, as opposed to merely styling text?
 *
 * `display: block` on a label and `font-weight: 600` are typography and are not
 * this rule's business. A flex or grid container, an explicit track list, a flex
 * ratio or a main-axis distribution is a two-column layout being built by hand.
 */
function laysOut(body: string): boolean {
  return (
    /display\s*:\s*(inline-)?(flex|grid)/.test(body) ||
    /grid-template-columns\s*:/.test(body) ||
    /(^|;|\s)flex\s*:/.test(body) ||
    /justify-content\s*:/.test(body)
  );
}

/** Selectors in this stylesheet that hand-roll a settings row. Pure, so it is
 *  falsifiable against synthetic input as well as against the tree. */
export function settingRowOffences(css: string): string[] {
  return rules(css)
    .filter((r) => namesASetting(r.selector) && laysOut(r.body))
    .map((r) => r.selector);
}

/** Every value this stylesheet gives the control-width token. */
export function controlWidthDeclarations(css: string): string[] {
  const out: string[] = [];
  const decl = new RegExp(`${CONTROL_WIDTH_TOKEN}\\s*:\\s*([^;}]+)`, "g");
  let m = decl.exec(stripComments(css));
  while (m !== null) {
    out.push(m[1].trim());
    m = decl.exec(stripComments(css));
  }
  return out;
}

function stripTsComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** The local name `SettingsPanel.tsx` (or anyone) imports the shared module as,
 *  or `null` when the file does not import it at all. */
export function sharedRowImportName(tsx: string): string | null {
  const m = /import\s+(\w+)\s+from\s+["']@\/components\/SettingRow\.module\.css["']/.exec(
    stripTsComments(tsx),
  );
  return m === null ? null : m[1];
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Uses of `styles.<name>`, not counting a LONGER class that starts with it.
 *  `rowStyles.control` must not be found inside `rowStyles.controlField`, and
 *  `rowStyles.row` must not be found inside a future `rowStyles.rows` — a
 *  prefix match here would silently double every count. */
function countClassUse(src: string, module: string, cls: string): number {
  const uses = src.match(new RegExp(`\\b${module}\\.${cls}(?![A-Za-z0-9_])`, "g"));
  return uses === null ? 0 : uses.length;
}

/**
 * How a component uses the standard: one shared row, one shared text cell and
 * one shared control cell per setting, and one control per control cell.
 *
 * The counts are the audit's teeth. A third setting added by copying the JSX and
 * dropping the wrapper — or by giving the new control its own div — makes them
 * disagree, and disagreeing is the whole failure the maintainer reported.
 */
export function rowUsage(tsx: string): {
  imported: boolean;
  rows: number;
  texts: number;
  controls: number;
  controlElements: number;
} {
  const src = stripTsComments(tsx);
  const name = sharedRowImportName(src);
  if (name === null) {
    return { imported: false, rows: 0, texts: 0, controls: 0, controlElements: 0 };
  }
  return {
    imported: true,
    rows: countClassUse(src, name, "row"),
    texts: countClassUse(src, name, "text"),
    controls: countClassUse(src, name, "control"),
    // Every control a settings row can hold. A checkbox or a number input is
    // the same slot as a `<select>`; all of them are counted so the balance
    // below holds for the toggle R-320 says will land in this slot next.
    controlElements: countOf(src, "<select") + countOf(src, "<input") + countOf(src, "<textarea"),
  };
}

function allStylesheets(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) allStylesheets(rel, acc);
    else if (entry.name.endsWith(".module.css")) acc.push(rel);
  }
  return acc;
}

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

describe("R-332: the matcher fires on a hand-rolled row and not on ordinary layout", () => {
  it("flags the exact shape that caused the report", () => {
    // This IS the pre-R-332 SettingsPanel.module.css, verbatim in structure.
    const handRolled = `
      .setting { display: flex; flex-wrap: wrap; justify-content: space-between; }
      .settingText { flex: 1 1 16rem; min-width: 0; }
      .settingControl { flex: 0 0 auto; max-width: 100%; }`;
    expect(settingRowOffences(handRolled)).toEqual([".setting", ".settingText", ".settingControl"]);
  });

  it("does not flag typography on a setting's label", () => {
    const label = `.settingName { display: block; font-size: 0.8125rem; font-weight: 600; }`;
    expect(settingRowOffences(label)).toEqual([]);
  });

  it("does not flag a toolbar, a card or a grid that is not a settings row", () => {
    const toolbar = `.toolbar { display: flex; justify-content: space-between; gap: 0.5rem; }`;
    expect(settingRowOffences(toolbar)).toEqual([]);
    const grid = `.hierarchyGrid { display: grid; grid-template-columns: 20rem 1fr; }`;
    expect(settingRowOffences(grid)).toEqual([]);
  });

  it("does not read its own prose", () => {
    const commented = `/* .settingControl { flex: 0 0 auto; } */ .x { color: red; }`;
    expect(settingRowOffences(commented)).toEqual([]);
  });

  it("sees a rule that lives inside a media query", () => {
    const responsive = `@media (max-width: 900px) { .settingRow { grid-template-columns: 1fr; } }`;
    expect(settingRowOffences(responsive)).toEqual([".settingRow"]);
  });

  it("counts the width token wherever it is set, and not in a comment", () => {
    expect(controlWidthDeclarations(`.row { --setting-control-w: 20rem; }`)).toEqual(["20rem"]);
    expect(
      controlWidthDeclarations(`/* --setting-control-w: 20rem; */ .x { color: red; }`),
    ).toEqual([]);
  });
});

describe("R-332: a settings row is defined once", () => {
  it("the shared module exists and defines the two-column row", () => {
    const css = stripComments(read(SETTING_ROW_MODULE));
    // A grid, not a flex box. The control track has to be a CONSTANT, and a
    // flex basis is a negotiation with the row's own content.
    expect(/\.row\s*\{[^}]*display\s*:\s*grid/.test(css)).toBe(true);
    expect(
      new RegExp(
        `\\.row\\s*\\{[^}]*grid-template-columns\\s*:[^;]*var\\(${CONTROL_WIDTH_TOKEN}`,
      ).test(css),
    ).toBe(true);
  });

  it("the control track is one named width, in rem so it scales with the root (D84)", () => {
    const declared = controlWidthDeclarations(read(SETTING_ROW_MODULE));
    expect(declared).toHaveLength(1);
    expect(declared[0]).toMatch(/^[\d.]+rem$/);
  });

  it("nothing else in the tree declares that width", () => {
    const offenders = allStylesheets("src")
      .filter((f) => f !== SETTING_ROW_MODULE)
      .filter((f) => controlWidthDeclarations(read(f)).length > 0);
    expect(offenders).toEqual([]);
  });

  /**
   * ⚠️ A CONTROL AREA CAN BE TWO ELEMENTS TALL. The eligibility row carries a
   * consequence paragraph under its picker and the date row does not. On the
   * old flex row that paragraph would have sized the column, which is why it
   * carried a hand-tuned `max-width: 20rem` — a second copy of the column width,
   * kept in step by hand. The cell is capped by the SAME token as the track, so
   * a paragraph, a second control or an error line cannot widen it.
   */
  it("the control cell is capped by the same token, so a tall control cannot stretch it", () => {
    const css = stripComments(read(SETTING_ROW_MODULE));
    expect(
      new RegExp(`\\.control\\s*\\{[^}]*max-width\\s*:\\s*var\\(${CONTROL_WIDTH_TOKEN}`).test(css),
    ).toBe(true);
    // Top-aligned: a two-element control must not drag the label down to meet
    // it, and must not stretch its neighbour.
    expect(/\.row\s*\{[^}]*align-items\s*:\s*start/.test(css)).toBe(true);
  });

  /**
   * A fixed track that never yields overflows a phone. The row collapses to one
   * column below a breakpoint — in `px`, deliberately: `AdminPage.module.css`
   * records why (a `rem` breakpoint resolves against the root font-size, which
   * scales with `--chrome-scale`, so the breakpoint itself would move).
   */
  it("collapses to one column on a narrow viewport, at a px breakpoint", () => {
    const css = stripComments(read(SETTING_ROW_MODULE));
    const media = /@media\s*\(max-width:\s*(\d+)px\)\s*\{([\s\S]*?\n\})/.exec(css);
    expect(media, "no px max-width media query in the shared row module").not.toBeNull();
    expect(media![2]).toMatch(/grid-template-columns\s*:\s*(minmax\(0,\s*)?1fr/);
  });

  it("no stylesheet outside the shared module hand-rolls a settings row", () => {
    const offenders: Array<{ file: string; selectors: string[] }> = [];
    for (const file of allStylesheets("src").filter((f) => f !== SETTING_ROW_MODULE)) {
      const selectors = settingRowOffences(read(file));
      if (selectors.length > 0) offenders.push({ file, selectors });
    }
    expect(offenders).toEqual([]);
  });

  /**
   * ⭐ THERE IS NO LEGACY LIST, AND THAT IS THE DIFFERENCE FROM R-318. The field
   * skin was hand-copied into thirty stylesheets before the standard existed, so
   * naming them was the only honest option. A settings ROW existed in exactly
   * one file, so the debt is zero and an exemption list would be a hole dug in
   * advance. If a second surface ever needs rows, it imports this module.
   */
  it("the panel that prompted this imports the standard and rolls nothing of its own", () => {
    expect(
      settingRowOffences(read("src/features/admin/components/SettingsPanel.module.css")),
    ).toEqual([]);
    expect(sharedRowImportName(read(SETTINGS_PANEL_TSX))).not.toBeNull();
  });

  /**
   * The counting prong. A twelfth row added by copying the JSX and leaving off a
   * wrapper — or by giving a new control its own container — makes these
   * disagree, and a control that is not inside a shared control cell is a
   * control that is not on the shared column.
   */
  it("every setting on the panel is one shared row, one text cell and one control cell", () => {
    const use = rowUsage(read(SETTINGS_PANEL_TSX));
    expect(use.imported).toBe(true);
    expect(use.rows).toBeGreaterThanOrEqual(2);
    expect(use.texts).toBe(use.rows);
    expect(use.controls).toBe(use.rows);
    expect(use.controlElements).toBe(use.controls);
  });
});
