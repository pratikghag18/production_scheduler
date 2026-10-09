/**
 * Types for `testerStack.mjs`, so `src/test/testerStack.test.ts` can import
 * the real module under `strict` without `allowJs`. Keep in step with the
 * exports there; the test file is what notices when they drift.
 */
export function resolveWorkdir(repoRoot: string): string;
export function statusFilePath(workdir: string): string;
export function isInside(parent: string, child: string): boolean;
export function extractProjectId(text: string): string | null;
export function transformConfig(repoConfigText: string, testerPort: number): string;
export function assertGeneratedConfig(
  text: string,
  testerPort: number,
  repoProjectId: string | null,
): void;
