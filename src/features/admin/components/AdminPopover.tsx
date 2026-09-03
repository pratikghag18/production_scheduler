/**
 * `AdminPopover` is now the shared `Popover` (`src/components/Popover.tsx`).
 *
 * This file used to be a DELIBERATE line-for-line clone of the board's popover
 * shell, because `docs/conventions.md` forbids cross-feature imports — its old
 * header called a `src/lib/` promotion "overdue". That promotion happened: the
 * shell lives in `src/components/` (a shared home, not a feature), so admin and
 * board now use ONE implementation and ONE stylesheet, and the placement helper
 * is imported there rather than reached across features. Kept as the name the
 * admin popovers already import; `src/test/popoverStandard.test.ts` enforces
 * that nothing hand-rolls a floating dialog again.
 */
export { Popover as AdminPopover } from "@/components/Popover";
