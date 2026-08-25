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
