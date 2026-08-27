/* ---------------------------------------------------------------------------
   Shift patterns — PRE-SEATED PLACEHOLDER (§19.62).

   This file exists before the section is built, and that is the whole point.
   Four admin sections are queued and every one of them would otherwise edit the
   same five shared files: `AdminPage.tsx`'s `SECTIONS` array AND its JSX child
   list, `REM_SURFACES`, R10's hardcoded copy of that list, and
   `src/lib/api/index.ts`. Measured across four concurrent surveys (§19.57):
   the collisions are all mechanical and all knowable in advance. So they are
   made ONCE, here, and after this commit each section's lane creates and edits
   only its own files.

   ⭐ `SHIFTS_PANEL_READY` LIVES HERE, NOT IN `AdminPage.tsx`. The nav entry
   reads it, so turning this section on is a one-line edit to THIS file — the
   lane that builds the panel is the lane that flips it, and a section cannot be
   switched on without a panel behind it because the switch is part of the
   panel. Group H in `scaleAudit.test.ts` asserts the other half: every id in
   `SECTIONS` has a branch rendering it.
   --------------------------------------------------------------------------- */
import styles from "./ShiftsPanel.module.css";

/** Flip to `true` in the same commit that gives this panel a real body. */
export const SHIFTS_PANEL_READY = false;

export function ShiftsPanel() {
  return (
    <div className={styles.panel}>
      <p>Not built yet.</p>
    </div>
  );
}
