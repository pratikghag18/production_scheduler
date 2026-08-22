# Agent Brief: Mockup v2.3 — Shift Template CRUD

**Executor:** the Sonnet agent that built v2.2 (context assumed). Modify `/home/claude/mockups/model-hybrid.html` IN PLACE. Small, contained change — touch only the ⚙ Shifts editor and whatever re-render plumbing it needs. No design decisions; note assumptions; don't ask.

## Changes (all inside the ⚙ Shifts editor)

1. **New template:** a `+ new template` button beside the template tabs. Click → inline name input (default `New template`); creates a template with one shift (`Shift 1`, 06:00–14:00) carrying the standard 3 breaks (08:00–08:15, 10:00–10:30, 12:00–12:15); switches the editor to its tab. Duplicate names get a ` 2` suffix.
2. **Rename template:** the active tab's name becomes an editable text input inside the panel (keep the tabs themselves as plain buttons).
3. **Delete template:** a `delete template` button (danger styling, existing `.del` conventions). Blocked with an inline red message if any line currently uses the template; otherwise removes it and switches to the first remaining tab. At least one template must always exist (block deleting the last one).
4. **Add/remove shifts:** `+ add shift` button per template (new shift named `Shift N`, 06:00–14:00, standard 3 breaks — user edits times); a remove `×` per shift, blocked when it's the template's last shift. Existing validation (non-overlap within template, breaks inside shift) applies to added shifts too.
5. **Line → template selects** list all templates dynamically, including new ones. Deleting a template never orphans a line (blocked per #3).
6. Save/Cancel semantics unchanged: all of the above stages in the editor's working copy and commits only on Save (Cancel discards new templates too).

## Acceptance

1. Create `1 × 12h`, edit its shift to 06:00–18:00, assign to Line 2, Save → Line 2 rows re-stripe with one boundary pattern and 3 breaks; full-shift chips on Line 2 show the single 12h shift.
2. Deleting a template in use shows the inline error; unassigning it from all lines then deleting works; deleting the last template is blocked.
3. Add + remove shift works with validation; removing the last shift of a template is blocked.
4. Cancel after creating a template discards it entirely.
5. All v2.2 checks still pass; zero console errors.

## Verification

Extend `verify-v2.js`; screenshots `hy4-*.png`; exercise acceptance 1, 2, 4 programmatically; read screenshots; iterate to zero errors.

## Required final step

Update `/home/claude/roadmap.md`: add and tick a `Mockup v2.3 — shift template CRUD` line under Phase 0, refresh Last updated, hybrid artifact row → `v2.3`. Usual report format.
