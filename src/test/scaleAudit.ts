/// <reference types="node" />
// `node:fs` and `process` RESOLVE at runtime under both vitest and
// `node --experimental-strip-types` -- that was verified in-container. What was
// NOT verified, and what broke the first `tsc -b` after this file landed, is that
// resolving is not the same as TYPECHECKING: the app tsconfig sets
// `"types": ["vite/client"]`, so @types/node is not auto-included and both
// `node:fs` and `process` were TS2307/TS2591 errors.
//
// A triple-slash reference is used rather than adding "node" to the app
// tsconfig's `types`, deliberately: this is a browser app, and pulling node
// globals into every file under src/ would let app code reach for `fs` or
// `process` without a type error. Scope it to the two files that genuinely
// need it.
//
// @types/node is already a direct devDependency (22.20.1), and tsconfig.node.json
// already sets `"types": ["node"]` for the config files — so the package resolves;
// only the APP tsconfig's `types` array excluded it. Nothing needs installing.
/**
 * The `--ui-scale` file audit (design plan §19.6/§19.7 D76, brief P1-5c §4.3).
 *
 * The rule being guarded: anything outside the fitted scroll container that
 * consumes vertical space must not use `--ui-scale`, because its height
 * feeds `computeFitScale`, whose output IS `--ui-scale` -- and `.header`
 * wraps, so the coupling is a step function with no fixed point.
 *
 * This is a file-content audit, not a rendering test, and that is
 * deliberate: the rule was written down correctly in global.css and violated
 * the next day because nothing ever checked the files against it.
 *
 * node:fs is the one value import strip-types resolves natively (verified
 * in-container, brief §2.1); no other value import is used here, so no
 * node:path -- root/file are joined with a plain string join that tolerates
 * a trailing slash on root.
 */
import * as fs from "node:fs";

export const CHROME_FILES: readonly string[] = [
  "src/components/AppShell.module.css",
  "src/components/HealthPill.module.css",
  "src/features/auth/DevProfileSwitcher.module.css",
  "src/features/board/components/BoardToolbar.module.css",
  "src/features/board/BoardPage.module.css",
];

/**
 * Strips /* ... *\/ comments first, then counts matches of
 * /var\(\s*--ui-scale\s*[,)]/g.
 *
 * Both details are load-bearing:
 *  - comments are stripped first, because BoardToolbar.module.css mentions
 *    `--ui-scale` in a comment explaining why it does NOT use it.
 *  - the trailing [,)] stops `var(--ui-scaled)` (or any future token with
 *    this as a prefix) from counting as a use of `--ui-scale`.
 */
export function countUiScaleUses(css: string): number {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const matches = withoutComments.match(/var\(\s*--ui-scale\s*[,)]/g);
  return matches === null ? 0 : matches.length;
}

function joinPath(root: string, file: string): string {
  const trimmedRoot = root.endsWith("/") ? root.slice(0, -1) : root;
  return `${trimmedRoot}/${file}`;
}

export function auditChromeFiles(
  root: string,
  files: readonly string[] = CHROME_FILES,
): Array<{ file: string; uses: number }> {
  return files.map((file) => {
    const css = fs.readFileSync(joinPath(root, file), "utf8");
    return { file, uses: countUiScaleUses(css) };
  });
}

/**
 * D84 — the rem surfaces.
 *
 * These stylesheets size in `rem` and scale through the root font-size
 * (`global.css`). A raw pixel dimension in one of them does not scale, and that
 * is exactly how the admin screens shipped at 1x on a 4K display while the
 * board scaled to 1.35x: nothing checked, so nothing stopped it.
 *
 * This is the enforcement half of D84. The scaled root font-size makes scaling
 * the DEFAULT; this makes forgetting it a test failure rather than something
 * noticed on someone's monitor three briefs later.
 */
export const REM_SURFACES: readonly string[] = [
  "src/features/admin/AdminPage.module.css",
  "src/features/admin/components/dragSurface.module.css",
  "src/features/admin/components/LevelEditor.module.css",
  "src/features/admin/components/NodeTreeEditor.module.css",
  "src/features/admin/components/ShapePicker.module.css",
  "src/features/admin/components/SiteAccessPanel.module.css",
  // §19.62 — the four queued sections, pre-seated. Listed here AND in R10's
  // copy of this list in the same commit, which is the two-place edit this
  // pre-seat exists to spend once instead of four times.
  "src/features/admin/components/ShiftsPanel.module.css",
  "src/features/admin/components/OperatorsPanel.module.css",
  "src/features/admin/components/TrainingsPanel.module.css",
  "src/features/admin/components/ProductsPanel.module.css",
  "src/features/admin/components/ImportPanel.module.css",
  // The Operator Training Matrix (its own buildout). Same two-place edit.
  "src/features/admin/components/MatrixPanel.module.css",
  // The shared matrix cell visual — chip, legend and record popover, drawn the
  // same by the team matrix and the single-operator matrix (D100).
  "src/features/admin/components/matrixCells.module.css",
  // 0029 / D110. ⚠️ NOT PRE-SEATED, AND THAT IS HOW IT WAS MISSED: the
  // pre-seat above covered the four sections §19.62 knew were coming, and
  // `DeleteDialog` is a shared surface none of them predicted. The audit
  // caught it on the maintainer's run — `missingRemSurfaces` walks the
  // directory, so an admin stylesheet that exists and is not listed here is a
  // test failure and not something spotted on a 4K monitor later. **Adding a
  // file under src/features/admin means editing this list and R10's copy in
  // the same commit.**
  "src/features/admin/components/DeleteDialog.module.css",
  // 0037 / the Settings section (org-wide date format). A new admin surface, so
  // it is listed here AND in R10's copy in `scaleAudit.test.ts`, the two-place
  // edit `missingRemSurfaces` exists to force.
  "src/features/admin/components/SettingsPanel.module.css",
  // 0040 / R-315, the Cycle times section. Another surface the §19.62 pre-seat
  // did not predict, so it is listed here AND in R10's copy in
  // `scaleAudit.test.ts` — the two-place edit `missingRemSurfaces` forces.
  "src/features/admin/components/CycleTimesPanel.module.css",
];

/**
 * D89 — THE LIST ABOVE IS ITSELF UNTESTED UNLESS SOMETHING ASSERTS IT.
 *
 * `ShapePicker.module.css` shipped in P1-5f and was not added here, so a whole
 * new admin surface sat outside the D84 audit while the audit reported green.
 * That is the same failure shape as brief-writing rule 5's "a list that drives
 * a test is itself untested": the guard cannot fail for a file it never reads.
 *
 * This walks the admin feature directory and reports any `*.module.css` that
 * REM_SURFACES does not name, so adding a surface without auditing it is a
 * test failure rather than something noticed on a 4K monitor three briefs
 * later.
 */
/**
 * §19.62 — A SECTION IN THE NAV WITH NOTHING BEHIND IT.
 *
 * `AdminPage.tsx` holds two lists that have to agree and never referred to each
 * other: the `SECTIONS` array the left rail renders, and the chain of
 * `{section === "x" && …}` branches that decide what the content pane shows.
 * A section present in the first and absent from the second is a rail button
 * that opens onto nothing — and until the pre-seat commit that was FOUR waiting
 * to happen, one per queued lane.
 *
 * This is a file-content audit for the same reason the rest of this file is:
 * the rule is easy to state, invisible to `tsc`, and would otherwise be checked
 * by someone clicking every item in the rail.
 *
 * ⚠️ COMMENTS ARE STRIPPED BEFORE PARSING, and that is not decoration. This
 * file's own prose mentions `section === "x"`, and `AdminPage.tsx`'s comments
 * name section ids; a parser that reads comments finds branches that do not
 * exist and reports a clean bill of health. Instrument 37 on this project was
 * exactly that mistake in a CSS extractor.
 */
export const ADMIN_PAGE = "src/features/admin/AdminPage.tsx";

function stripTsComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * The section ids the left rail renders, in source order.
 *
 * Returns `[]` when there is no `SECTIONS` array to read — a missing list is
 * reported as "no sections", never as an exception, because this runs inside a
 * test whose failure message should say what is wrong with the repo rather than
 * a stack trace from a regex.
 */
export function parseSectionIds(tsx: string): string[] {
  const src = stripTsComments(tsx);
  const block = /const SECTIONS[^=]*=\s*\[([\s\S]*?)\]\s*;/.exec(src);
  if (block === null) return [];
  const ids: string[] = [];
  const entry = /id:\s*"([^"]+)"/g;
  let m = entry.exec(block[1]);
  while (m !== null) {
    ids.push(m[1]);
    m = entry.exec(block[1]);
  }
  return ids;
}

/** Section ids with no `section === "id"` branch to render them. */
export function sectionsWithoutPanels(tsx: string): string[] {
  const src = stripTsComments(tsx);
  // ⚠⚠ MATCHES EITHER SPELLING ON PURPOSE. This looked for `section === "x"`
  // and went blind the moment D114 renamed the render branches to
  // `activeSection === "x"` (a supervisor cannot see every tab, so the
  // chosen section has to be resolved against the ones they can). It
  // reported ALL SEVEN sections as unrendered, which is the honest failure
  // — but it is also the third time in this project a string-matching audit
  // has gone quiet on a reword, so it now anchors on the part that carries
  // the meaning rather than the variable that happens to hold it.
  return parseSectionIds(tsx).filter((id) => !new RegExp(`ection === "${id}"`).test(src));
}

/** `sectionsWithoutPanels` against the file on disk. */
export function auditAdminSections(root: string, file: string = ADMIN_PAGE): string[] {
  return sectionsWithoutPanels(fs.readFileSync(joinPath(root, file), "utf8"));
}

export const REM_SURFACE_DIR = "src/features/admin";

export function missingRemSurfaces(
  root: string,
  dir: string = REM_SURFACE_DIR,
  known: readonly string[] = REM_SURFACES,
): string[] {
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  const found: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of fs.readdirSync(`${base}/${rel}`, { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".module.css")) found.push(child);
    }
  };
  walk(dir);
  const knownSet = new Set(known);
  return found.filter((f) => !knownSet.has(f)).sort();
}

/**
 * D89 — the control-font reset in `global.css`.
 *
 * `input` / `button` / `select` / `textarea` do NOT inherit fonts. The UA gives
 * them an absolute one, so they are immune to D84's scaled root font-size AND
 * to anything inherited from `body`. Measured in headless Chromium before the
 * fix: an unstyled control computed to 13.3333px Arial at 1440, 2560 and 3840
 * CSS px, beside a rem-sized sibling that went 13 -> 15.53 -> 17.55px system-ui.
 *
 * Every stylesheet involved was fully D84-compliant. `unscaledPxLengths` cannot
 * see this class of defect at all, because the defect is an ABSENT declaration.
 * This asserts the presence of the one rule that makes it impossible.
 *
 * Returns the control selectors that are NOT covered by a `font: inherit`
 * block; empty means the reset is intact.
 */
export const RESET_CONTROLS: readonly string[] = ["input", "button", "select", "textarea"];

export function missingControlFontReset(globalCss: string): string[] {
  const withoutComments = globalCss.replace(/\/\*[\s\S]*?\*\//g, "");
  // Find every rule whose body declares `font: inherit`, and collect the
  // element selectors in its prelude. Comment-stripped first for the same
  // reason every other matcher here is: global.css explains this rule in prose
  // that names all four controls, and a matcher that reads comments would pass
  // on the documentation alone.
  const covered = new Set<string>();
  for (const m of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const prelude = m[1];
    const body = m[2];
    if (!/\bfont\s*:\s*inherit\b/.test(body)) continue;
    for (const sel of prelude.split(",")) covered.add(sel.trim().toLowerCase());
  }
  return RESET_CONTROLS.filter((c) => !covered.has(c));
}

/**
 * Pixel lengths that are legitimately NOT scaled:
 *   - hairlines on a border/outline (a 1px rule at 1.35x renders blurry)
 *   - `box-shadow` offsets and blur (decorative; scaling them is noise)
 *   - anything inside a `@media` prelude — a breakpoint is about the DEVICE,
 *     and in `rem` it would resolve against the scaled root and move with the
 *     scale. This was a real bug in the first conversion pass.
 *   - `0px`
 *
 * Comments are stripped first, for the same reason `countUiScaleUses` strips
 * them: these files explain themselves in prose that mentions `16px` and
 * `1.35px`, and a matcher that reads comments flags the very file documenting
 * the rule. That mistake has now been made twice on this project.
 */
export function unscaledPxLengths(css: string): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  // Split on `;` and braces ONLY — the boundaries of a CSS declaration. Not on
  // newlines: a declaration's VALUE may span lines, and Prettier wraps a
  // multi-value one as soon as it is long enough.
  //
  // Both halves of that were learned the hard way. An earlier LINE-oriented
  // version reported ZERO offenders the moment a selector and a declaration
  // shared a line, and zero offenders reads exactly like a pass. Splitting on
  // `;{}` fixes that. But this function then kept `\n` in the split as well,
  // which claimed in a comment to make the matcher independent of Prettier and
  // did the opposite: on 28 Aug a repo-wide `prettier --write` wrapped three
  // `box-shadow` values in ProductsPanel.module.css onto three lines each, the
  // continuation lines no longer carried the `box-shadow:` property that
  // exempts them, and R1 failed on CSS whose meaning had not changed.
  // R5b pins it. A declaration ends at `;` or a brace — never at a newline.
  for (const rawLine of withoutComments.split(/[;{}]/)) {
    const line = rawLine.trim();
    if (line.startsWith("@media")) continue;
    const prop = line.split(":")[0].trim().toLowerCase();
    if (prop === "box-shadow") continue;
    // Exempt by VALUE, not by property family. An earlier version exempted
    // anything matching /^(border|outline)/, which also swallowed
    // `border-radius: 20px` — a radius is a real dimension and must scale.
    // Only a genuine hairline WIDTH (<=2px) on a border/outline is exempt.
    const isHairlineContext = /^(border|outline)/.test(prop) && !prop.includes("radius");
    for (const m of line.matchAll(/\b(\d+(?:\.\d+)?)px\b/g)) {
      const v = parseFloat(m[1]);
      if (v === 0) continue;
      if (isHairlineContext && v <= 2) continue;
      out.push(line);
    }
  }
  return out;
}

export function auditRemSurfaces(
  root: string,
  files: readonly string[] = REM_SURFACES,
): Array<{ file: string; offenders: string[] }> {
  return files.map((f) => ({
    file: f,
    offenders: unscaledPxLengths(fs.readFileSync(`${root}/${f}`, "utf8")),
  }));
}

/* ---------------------------------------------------------------------------
   D100 — THE DRAG AUDIT. "MATCH THE COLOURS" MADE INTO A PROPERTY OF THE FILES.

   The maintainer, Aug 27: *"Can we make sure we match the colors on drag selection in
   all areas, shouldn't this be done by default? It seems we're reinventing
   stuff vs reusing it."*

   Matching them by hand is the thing that failed: the node tree and the level
   list each grew their own grip block, their own ghost opacity and their own
   row hover — and the two hovers were DIFFERENT COLOURS, one of which
   (`--page` on `--surface`, three units) had already been measured as
   rendering nothing. Every declaration in both files was correct. The defect
   was that there were two of them.

   So the shared rules live in ONE file and both surfaces `composes:` them, and
   this audit makes that a property the suite checks rather than a habit:

     - `missingDragCompose`  — a drag surface that does not compose from the
                               shared file has quietly started its own copy.
     - `unsharedDragRules`   — the drag mechanics (`cursor: grab`,
                               `user-select: none`, `touch-action: none`) and
                               the shared tokens may be written in the shared
                               file and NOWHERE else.
     - `rawDragColours`      — a drag surface must reach a colour through a
                               `--drag-*` / `--drop-*` token, never through the
                               raw semantic one, so the two surfaces cannot
                               diverge one edit at a time.

   Same shape as `missingControlFontReset` (D89): the fix is a default, and the
   audit is what stops the default being forgotten.

   ⚠️ COMMENTS ARE STRIPPED FIRST, and this is not a nicety — these files
   explain themselves in prose that quotes the very declarations being looked
   for, and a matcher that reads comments flags the file documenting the rule.
   That mistake has now been made three times on this project.
   --------------------------------------------------------------------------- */

/** The one file allowed to declare a shared drag rule. */
export const DRAG_SHARED_SURFACE = "src/features/admin/components/dragSurface.module.css";

/** Every stylesheet that participates in an admin drag gesture. */
export const DRAG_SURFACES: readonly string[] = [
  "src/features/admin/components/NodeTreeEditor.module.css",
  "src/features/admin/components/LevelEditor.module.css",
];

/**
 * Declarations that belong to `DRAG_SHARED_SURFACE` and to nothing else.
 * Written whitespace-free because that is how they are compared.
 */
export const SHARED_DRAG_DECLARATIONS: readonly string[] = [
  "cursor:grab",
  "cursor:grabbing",
  "user-select:none",
  "touch-action:none",
  "var(--drag-row-hover)",
  "var(--drag-grip)",
  "var(--drag-grip-hover)",
  "var(--drag-ghost-opacity)",
];

/**
 * Raw semantic colours a drag surface must not name directly. `--signal-ok` is
 * the whole drag vocabulary's green; it is reached as `--drag-caret` (the
 * insertion line) or `--drop-ok` (the chosen target), which is what lets the
 * two be re-pointed at once.
 */
export const RAW_DRAG_COLOURS: readonly string[] = ["var(--signal-ok)"];

function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Comment-free and whitespace-free, so `cursor : grab` and `cursor:grab` match. */
function squeezed(css: string): string {
  return withoutComments(css).replace(/\s+/g, "").toLowerCase();
}

/** True when a drag surface never composes from the shared file at all. */
export function missingDragCompose(css: string): boolean {
  return !squeezed(css).includes('from"./dragsurface.module.css"');
}

/** Shared drag rules a surface has re-declared locally. Empty is the pass. */
export function unsharedDragRules(
  css: string,
  needles: readonly string[] = SHARED_DRAG_DECLARATIONS,
): string[] {
  const flat = squeezed(css);
  return needles.filter((n) => flat.includes(n.replace(/\s+/g, "").toLowerCase()));
}

/** Raw semantic colours a surface reached past its drag tokens to name. */
export function rawDragColours(
  css: string,
  needles: readonly string[] = RAW_DRAG_COLOURS,
): string[] {
  const flat = squeezed(css);
  return needles.filter((n) => flat.includes(n.replace(/\s+/g, "").toLowerCase()));
}

/**
 * Every `--drag-*` / `--drop-*` custom property READ anywhere in the given
 * stylesheets that `tokens.css` does not DEFINE. A token nobody defines
 * silently resolves to nothing, which for a colour means "transparent" and for
 * an opacity means the declaration is dropped -- both of which look like a
 * design choice rather than a typo.
 */
export function undefinedDragTokens(tokensCss: string, sheets: readonly string[]): string[] {
  const defined = new Set(
    [...withoutComments(tokensCss).matchAll(/(--(?:drag|drop)-[a-z0-9-]+)\s*:/g)].map((m) => m[1]),
  );
  const used = new Set<string>();
  for (const sheet of sheets) {
    for (const m of withoutComments(sheet).matchAll(/var\(\s*(--(?:drag|drop)-[a-z0-9-]+)/g)) {
      used.add(m[1]);
    }
  }
  return [...used].filter((t) => !defined.has(t)).sort();
}

/* ===========================================================================
 * D105 — CREATE/EDIT PARITY. A FIELD YOU CAN SET ONCE AND NEVER CHANGE.
 *
 * The maintainer, three times across two days: *"No option to edit area for an existing
 * product either... I've talked about this a couple of times now."*
 *
 * ⭐⭐ THE MISTAKE WAS THE SAME EVERY TIME AND I DID NOT SEE THE PATTERN. Build
 * the CREATE path, wire its form, ship it — and leave the EDIT path with a
 * subset of the fields. The value is then frozen at the moment the row was
 * made, which is invisible from the create form (where everything works) and
 * only shows up the day somebody reorganises a line and their products cannot
 * follow. It had already happened once in a different costume: a break that
 * could only be deleted and retyped (§19.65), where the update call existed
 * and nothing on screen reached it.
 *
 * ⚠️ A CREATE FORM WITHOUT ITS MATCHING EDIT IS NOT A MISSING FEATURE, IT IS A
 * WRONG DATA MODEL SHIPPED. It says "this is a property of the row's birth",
 * which for where-something-belongs is simply false.
 *
 * So this stops being something I remember. For every table that carries
 * `site_node_id`, the API module must both INSERT it and UPDATE it — checked
 * from the source, in the runner that guards the repo.
 *
 * ⚠️ IT PARSES THE STATEMENT, NOT THE FILE. A file-wide `includes("site_node_id")`
 * passes on the INSERT alone, which is exactly the state this audit exists to
 * catch. Each `.from("table")` chain is sliced out and the column looked for
 * inside the chain that writes.
 * ======================================================================== */

/**
 * The API modules that own a scoped table, and the table each one writes.
 *
 * ⭐ D115 / migration 0034 REMOVED PRODUCTS from this audit. A product no longer
 * carries a single `site_node_id`; where it belongs is a LIST in `product_sites`,
 * written by `assignProductSite` / `unassignProductSite` — which are inherently a
 * set AND an un-set, so the "can you also change it after creation" hazard this
 * audit exists for cannot arise there. Operators and shift patterns keep the
 * single-owner column and the parity rule. (Adding products back here would
 * report the honest offence "nothing sets products.site_node_id" — J5's shape.)
 */
export const SCOPED_WRITE_SURFACES: ReadonlyArray<{ file: string; table: string }> = [
  { file: "src/lib/api/operators.ts", table: "operators" },
  { file: "src/lib/api/shifts.ts", table: "shift_templates" },
];

/** The column every one of them must be able to both set and change. */
export const SCOPE_COLUMN = "site_node_id";

interface WriteChain {
  op: "insert" | "upsert" | "update";
  body: string;
}

/**
 * Every write chain against `table` in `source`, as `(op, body)` pairs.
 *
 * A chain runs from the top of the ENCLOSING FUNCTION to the next `.from(`.
 *
 * ⚠️ NOT FROM THE NEAREST `{`, WHICH IS WHAT THIS FIRST DID — and it reported a
 * real-looking failure about correct code, which is instrument-failure 42. The
 * nearest brace before `.from("products")` is the `{ data, error }`
 * destructuring on the very same statement, so the slice began AFTER the
 * `patch` object three lines above and the audit could not see the column being
 * set. **A parser that finds fewer things than exist reads exactly like a file
 * that contains fewer things** (instrument 37, again). The function is the unit
 * that owns the write, so the function is the slice.
 */
export function writeChains(source: string, table: string): WriteChain[] {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const out: WriteChain[] = [];
  const from = new RegExp(`\\.from\\(\\s*["']${table}["']\\s*\\)`, "g");
  const fnStarts = [...clean.matchAll(/^export (?:async )?function |^(?:async )?function /gm)].map(
    (f) => f.index,
  );
  for (const m of clean.matchAll(from)) {
    const before = fnStarts.filter((i) => i < m.index);
    const start = before.length === 0 ? 0 : before[before.length - 1];
    const nextFrom = clean.indexOf(".from(", m.index + 1);
    const body = clean.slice(start, nextFrom === -1 ? clean.length : nextFrom);
    const op = /\.(insert|upsert|update)\s*\(/.exec(
      clean.slice(m.index, nextFrom === -1 ? clean.length : nextFrom),
    );
    if (op !== null) out.push({ op: op[1] as WriteChain["op"], body });
  }
  return out;
}

/**
 * Does this chain actually WRITE the column, as opposed to merely mentioning it?
 *
 * ⚠️ A TYPE ANNOTATION IS NOT A WRITE, and this audit's first version could not
 * tell the difference — so deleting the one line that assigns the column left
 * `site_node_id?: string | null` in the patch type three lines above, the
 * `includes` test still passed, and **the audit reported nothing for the exact
 * defect it was written to catch.** That is rule 3 arriving within the hour:
 * half an audit's cases must run against synthetic input, because one that only
 * ever looks at a clean repo passes for as long as the repo is clean and says
 * nothing about whether it can fail at all.
 */
export function writesScopeColumn(body: string): boolean {
  const withoutTypeDecls = body.replace(new RegExp(`${SCOPE_COLUMN}\\?\\s*:[^;,}]*`, "g"), "");
  return withoutTypeDecls.includes(SCOPE_COLUMN);
}

/**
 * Every scoped table whose API module cannot both SET and CHANGE its scope.
 *
 * ⭐ THE RULE IS UNCONDITIONAL, not "if it can set it, it must change it". The
 * conditional version had a second hole: rename the column away everywhere and
 * both halves go false, no offence is reported, and the audit sits green over a
 * module that cannot express where anything belongs at all.
 *
 * Returns one string per offence, ready to print in a failure message.
 */
export function scopeParityOffences(
  sources: ReadonlyMap<string, string>,
  surfaces: ReadonlyArray<{ file: string; table: string }> = SCOPED_WRITE_SURFACES,
): string[] {
  const out: string[] = [];
  for (const { file, table } of surfaces) {
    const src = sources.get(file);
    if (src === undefined) {
      out.push(`${file}: not read`);
      continue;
    }
    const chains = writeChains(src, table);
    const creates = chains.filter((c) => c.op === "insert" || c.op === "upsert");
    const updates = chains.filter((c) => c.op === "update");
    if (creates.length === 0) out.push(`${file}: no insert into ${table}`);
    if (updates.length === 0) out.push(`${file}: no update of ${table}`);
    if (!creates.some((c) => writesScopeColumn(c.body))) {
      out.push(`${file}: nothing sets ${table}.${SCOPE_COLUMN} at creation`);
    }
    if (!updates.some((c) => writesScopeColumn(c.body))) {
      out.push(`${file}: nothing can CHANGE ${table}.${SCOPE_COLUMN} after creation`);
    }
  }
  return out;
}
