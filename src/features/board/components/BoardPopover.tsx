/**
 * `BoardPopover` is now the shared `Popover` (`src/components/Popover.tsx`).
 *
 * It used to be the board's own popover shell; the admin feature carried a
 * line-for-line clone and the matrix a hand-rolled third. They were consolidated
 * into ONE primitive in `src/components/`, and this file is kept only as the
 * name the board's popovers already import — so nothing here re-implements the
 * shell, and `src/test/popoverStandard.test.ts` enforces that no one does.
 */
export { Popover as BoardPopover } from "@/components/Popover";
