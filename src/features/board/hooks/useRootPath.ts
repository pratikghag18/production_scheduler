/**
 * Brief P1-4a §9: "keep P1-3b's existing behaviour... if it is currently a
 * hardcoded constant, keep the constant and mark it in your report as
 * inherited." `BoardProof`'s predecessor, `BoardPage.tsx` (pre-P1-4a),
 * resolved the root path as a hardcoded constant:
 *
 *   const ORG_ROOT_PATH = "plant_1";
 *
 * (supabase/seed.sql: Plant 1 -> `plant_1`). That resolution rule is
 * unchanged here — it is not derived from the session/profile in any way
 * yet. See the agent report's "assumptions" section.
 */

const ORG_ROOT_PATH = "plant_1";

export function useRootPath(): string {
  return ORG_ROOT_PATH;
}
