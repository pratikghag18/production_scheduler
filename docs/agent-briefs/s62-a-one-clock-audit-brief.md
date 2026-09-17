# S62-a — the plant's zone is the one clock: the audit that enforces it, and the sites that predate it (R-426, F-161)

The maintainer, 17 Sept (session 177): "can we make sure the time set by the settings for the
plant is the standard the whole board should use for any further development happening here on
after? And any kind of development we do going forward will also check if a standard exists or
a prior code should change based on new standard?" Read R-426 and F-161 in `docs/plan.yaml`,
CLAUDE.md §7, F-159 (the board's today was the UTC date), and `src/test/dateSeam.test.ts` (the
existing audit: Intl/toLocale/month arrays outside the seams).

You own `src/test/dateSeam.test.ts`, `src/lib/format/dates.ts` (a new helper or two), and every
file the audit makes you touch, listed below; nothing else. Do not run the full `npm run test`.

1. **The grep, as the standard's first audit.** Run it and keep the output for your report:
   `grep -rn "startOfUtcDay\|utcMondayOfWeek\|getUTCDate()\|getUTCDay()\|T00:00:00Z\|T00:00:00.000Z\|getHours()\|getMinutes()\|getDate()\|getDay()\|getMonth()\|getFullYear()\|toLocale\|Date.now()\|new Date()" src --include=*.ts --include=*.tsx | grep -v "/test/"`.
   Classify every hit into exactly one of: (a) an instant read as a calendar day or clock by the
   MACHINE's zone (`getHours`, `getDate`, `toLocale*`… on a real instant) — a violation; (b) an
   instant read as a calendar day by the UTC date (`startOfUtcDay(new Date())`, `getUTCDate()`
   on `now`) — a violation unless it is the store's documented first guess (F-159); (c) pure
   calendar arithmetic on a `YYYY-MM-DD` string (`new Date(iso + "T00:00:00Z")` then `setUTCDate`
   then back to a string) — allowed, but must go through one named helper; (d) validation of a
   date string — allowed; (e) a seam (`dates.ts`, `time.ts`, `timezones.ts`) — allowed.
2. **The helper.** In `src/lib/format/dates.ts` add `isoPlusDays(iso, days)` and
   `weekdayOfIso(iso)` (0–6) if they do not already exist there (the board and the bar each have
   their own copies — `BoardPage.tsx`'s `isoPlusDays`, `CommandBar.tsx`'s week helpers,
   `absence.ts`'s `nextDay`, `matrix.ts`'s day shift): one implementation, documented as calendar
   arithmetic on a day string, never an instant. Replace every (c) site with it. `BoardToolbar`
   and `CopyWeekDialog` building a marker from a typed date (`new Date(v + "T00:00:00.000Z")`)
   use a `dayMarker(iso)` helper in the same file whose doc says what a marker is (a which-day
   value whose calendar day is read back with `getUTC*`, anchored in the plant's zone by
   `buildBoardIndex`), and `startOfUtcDay`/`utcMondayOfWeek` in `time.ts` gain the same doc.
3. **F-161, the audit view.** `src/features/admin/lib/auditView.ts` formats a row's day and
   time with the machine's getters. Find how that screen (and the admin pages beside it) obtain
   the plant's or company's zone today (the board's payload carries `timezone`; the admin side
   may read the site setting — grep `timezone` under `src/features/admin`), and format through
   `formatClock`/`formatDayLabel` in that zone. If the admin side has no zone at hand, say so and
   route the company fallback (`orgs.settings.timezone`) the way the board's payload does — a
   small read, not a new query, if one already carries settings. Pin: a row stamped
   2026-09-17T00:30:00Z shows 16 Sept 19:30 under America/Chicago and 17 Sept 09:30 under
   Asia/Tokyo.
4. **The audit grows.** `dateSeam.test.ts` gains: `LOCAL_GETTER_NEEDLES` (`.getHours(`,
   `.getMinutes(`, `.getDate(`, `.getDay(`, `.getMonth(`, `.getFullYear(`, `.toLocaleString(`)
   banned outside the seams; `UTC_TODAY_NEEDLES` (`startOfUtcDay(new Date(`, `utcMondayOfWeek(new
   Date(`) banned outside `time.ts` and the ONE allowlisted line in `boardView.ts` (the first
   guess, with F-159 named in the allowlist entry); and the raw `T00:00:00` pattern banned
   outside `dates.ts`/`time.ts` once every site goes through the helpers. Each needle is read
   out of comment-stripped source as the existing ones are. Pin each needle with a positive and
   a negative case, and the allowlist entries with their reasons.
5. **Report** the classified grep (every hit, its class, what you did), the helper's callers,
   the audit's new needles and allowlist, and the totals of `npx vitest run src/test/dateSeam.test.ts
   src/test/dateFormat.test.ts src/test/commandBar.test.tsx src/test/commandResolve.test.ts
   src/test/boardViewToday.test.ts src/test/absence*.test.ts` plus any test file of a module you
   touched, `npx tsc -b`, `npx eslint src`, `npx prettier --check` on your files. No commits, no
   plan edits.
