/**
 * Cross-feature pointer-interaction constants (brief P1-5l §4.1).
 *
 * `DRAG_THRESHOLD_PX` was defined at `src/features/board/lib/interaction.ts:17`
 * (D32) while the board was its only consumer. P1-5l gives the admin node tree
 * and the admin level list the same gesture, and `conventions.md`'s
 * feature-first rule forbids `src/features/admin/` importing from
 * `src/features/board/` — `src/features/auth/` is the only named exception, and
 * adding a second one requires a recorded decision, not a judgement call at the
 * import site.
 *
 * So the number moves UP into `src/lib`, exactly as `placement.ts` did the
 * moment it had two consumers in two features. The board's own file now
 * RE-EXPORTS it, so no board import changes and there is still only one `4` in
 * the repo. A duplicated constant is the thing this move exists to prevent:
 * two features that agree today and drift silently tomorrow.
 *
 * Deliberately dependency-free — no imports at all — so anything that needs the
 * number can have it without pulling in a module graph.
 */

/**
 * How far a pointer must travel from where it went down before the gesture
 * counts as a DRAG rather than a CLICK (D32).
 *
 * Applied as a EUCLIDEAN distance, never as two per-axis comparisons: see
 * `passedThreshold` in `src/features/admin/lib/dragPointer.ts`, whose case T5
 * pins the 3px-x-and-3px-y diagonal (4.24px) that a per-axis test refuses.
 */
export const DRAG_THRESHOLD_PX = 4;
