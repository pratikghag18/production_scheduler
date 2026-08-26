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
  "src/features/admin/components/LevelEditor.module.css",
  "src/features/admin/components/NodeTreeEditor.module.css",
  "src/features/admin/components/AdminPopover.module.css",
  "src/features/admin/components/ShapePicker.module.css",
  "src/features/admin/components/SiteAccessPanel.module.css",
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
export const RESET_CONTROLS: readonly string[] = [
  "input",
  "button",
  "select",
  "textarea",
];

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
  // Split on `;` and braces as well as newlines, so the matcher does not depend
  // on Prettier's formatting at all. A line-oriented version reports ZERO
  // offenders the moment a selector and a declaration share a line — and zero
  // offenders reads exactly like a pass. A guard must not be able to fail
  // silently, so it is split down to individual declarations.
  for (const rawLine of withoutComments.split(/[\n;{}]/)) {
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
