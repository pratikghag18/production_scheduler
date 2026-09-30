/**
 * Types for `loopbackNetwork.mjs`, so `src/test/localToolsListenLocally.test.ts`
 * can import the real module under `strict` without `allowJs`. Keep in step
 * with the exports there; the test file is what notices when they drift.
 */
export function publishesBeyondLoopback(dockerPsText: string, projectId: string): string[];
export function beyondLoopbackWarning(script: string, beyond: string[]): string;
