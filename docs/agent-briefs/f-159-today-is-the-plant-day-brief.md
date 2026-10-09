# F-159 — the board's "today" is the plant's calendar day, not the UTC one

Reproduced 16 Sept, 19:09 America/Chicago (00:09Z on the 17th), in a fresh browser: a day-less
sentence in the bar answered "today is not on the board. Move the board to that day first."
with a Show that day button that changed nothing. The page's own context, logged once:

    now 2026-09-17T00:12Z · zone America/Chicago · dayStarts 17 05:00Z, 18 05:00Z, 19 05:00Z ·
    windowStart 2026-09-17T05:00Z · todayIndex -1

Cause: `src/features/board/store/boardView.ts`'s `defaultWindowStart()` (and `goToToday`) is
`startOfUtcDay(new Date())`, a "which day" marker whose CALENDAR DAY is the UTC date;
`buildBoardIndex` then anchors that calendar day at the plant zone's midnight. After 19:00
Chicago the UTC date is tomorrow, so the board opens on tomorrow and today is off it. Before
F-156 the bar fell back to the window's first day and wrote onto tomorrow silently; now it
asks, and the button computes today the same wrong way. Every walk and the typed spec ran in
the afternoon, when the two dates agree. The hours drawn on the board are right (the axis is
in the zone); only the choice of day was wrong.

You own `src/features/board/store/boardView.ts`, `src/features/board/BoardPage.tsx` (the
window/`goToToday` wiring and the Today button's call; nothing else), their tests
(`src/test/boardView*.test.ts` if one exists, else a new `src/test/boardViewToday.test.ts`),
and `src/test/commandBar.test.tsx` only if a Show-that-day pin needs the zone.

1. **The marker is built from the plant's date.** `defaultWindowStart(zone?: string)`: with a
   zone, `partsInZone(new Date(), zone)` gives year/month/day and the marker is
   `Date.UTC(year, month - 1, day)` — the same "UTC-midnight which-day marker" shape the store
   already uses, only the DAY is the plant's. Without a zone (store init, zone unknown) keep
   the UTC date as a first guess. `goToToday(zone?)` the same. No other store field changes.
2. **The board re-anchors once it knows the zone, if nobody has moved it.** Add
   `windowMovedByUser: boolean` to the store (false at init; `setWindowStartDate`,
   `shiftWindowByDays`, `setWindowDayCount` and `goToToday` set it true — `goToToday` is a
   deliberate move too). In `BoardPage`, when `zone` becomes known (the payload's timezone)
   and `windowMovedByUser` is false and the store's marker day differs from
   `partsInZone(now, zone)`'s day, call `goToToday(zone)` once, then treat the window as
   moved by the page (a flag in the store, `anchoredToZone`, so it never loops). The Today
   button and `handleShowDay("today")` call `goToToday(zone)`.
3. **Pins with a fixed clock.** `vi.setSystemTime` at 2026-09-16T23:30:00Z (18:30 Chicago) and
   at 2026-09-17T00:30:00Z (19:30 Chicago): TD-1 `defaultWindowStart("America/Chicago")` is
   the marker for 2026-09-16 at both clocks; TD-2 `defaultWindowStart("Asia/Tokyo")` at
   2026-09-16T16:00Z is the marker for 2026-09-17 (east of UTC, the other direction); TD-3
   with no zone the UTC date (documented as the first guess); TD-4 the re-anchor effect: a
   store at the UTC-date marker, zone arriving as Chicago at 19:30 Chicago → marker moves to
   the 16th once and `windowMovedByUser` stays false but `anchoredToZone` is true; TD-5 a
   store the user moved (`shiftWindowByDays(2)`) is NOT re-anchored when the zone arrives;
   TD-6 the board's `todayIndex` computed from `buildDayAxis(marker, 3, "America/Chicago")` at
   19:30 Chicago is 0, not -1 (the exact failure).
4. **The typed walk spec is clock-blind**: say in your report how the spec could pin this
   (Playwright's `page.clock`) without changing it now.

Run the store's tests, `npx vitest run src/test/commandBar.test.tsx`, `npx tsc -b`,
`npx eslint src/features/board`, `npx prettier --check` on your files, then
`npx playwright test e2e/roleWalk.spec.ts --workers=1`. No commits, no plan edits. Report the
pins, the totals, and the exact behaviour of the Today button afterwards.
