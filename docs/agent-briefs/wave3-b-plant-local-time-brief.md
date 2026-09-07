# Wave 3, lane B — plant-local time (D88, §19.21): the board's axis follows the plant

You are one of two parallel lanes. Another agent is editing this repo at the same time
(invitations: an Edge Function, the Access panel, `src/lib/api/access.ts`, `session.ts`,
`ResetPasswordPage.tsx`, migration 0064). **Touch only the files listed under "You own".** Ignore
`tsc`/ESLint errors in files you do not own. Do not run the full `npm run test`; run only your own
test files. Do not commit; do not edit `docs/plan.yaml` — report your plan additions as YAML in
your final message. **Never `npm run db:reset`, `supabase stop` or `supabase start`.** Your
migration is **0063** (`supabase/migrations/20260907000063_*.sql`); apply it with `psql` against
the running container (`supabase_db_production_scheduler`) as session 83 did, then
`npm run db:types`, and say so.

Read first: `CLAUDE.md` (all of it), `docs/plan-format.md`, `docs/design-plan.md` §19.21 (D88,
the decision — read it in full, it is short and it names the exact cost), the queue entry
"Per-site timezone (D10 / D88)" and requirements R-333 and R-039 in `docs/plan.yaml`; migrations
0050 (`node_settings`, `app_resolve_node_setting`, `set_node_setting`), 0052 (the second key),
0062 (how `board_window` carries the resolved `date_format` — the exact shape to copy);
`src/features/board/lib/time.ts` (whole file), `geometry.ts` (`shiftInstances` and everything that
multiplies by `MINUTES_PER_DAY`), `boardIndex.ts` (its `BOARD_ZONE` note), `src/lib/format/dates.ts`,
`src/lib/api/shapes.ts` (`BoardWindow`, `dateFormat`), `SettingsPanel.tsx` (the one `<select>`, two
option lists pattern and its row audit), and `src/test/defects/DEF-0017.test.ts` for the shape of a
"resolved upward as a definer" pin.

## The decision, already made (do not re-ask)

- **D88a: the board's axis is the plant's local time.** A 06:00 shift reads 06:00 to the people
  working it.
- **D88b: a shift keeps its posted wall-clock start across a DST change.** On the changeover day
  that shift is 7 or 9 hours long.
- The zone hangs off a NODE and resolves nearest-ancestor, with a company-level fallback — the
  same mechanic as `date_format` (0052/0062). Not a column on `nodes`: the third key of
  `node_settings`, `timezone`, an IANA name validated against `pg_timezone_names`. Company
  fallback: `orgs.settings.timezone`, default `'UTC'` so nothing shipped changes for a
  single-zone customer until somebody sets it.

## What to build

1. **Migration 0063.** `set_node_setting` gains the `timezone` key in its value CASE (extract the
   last definition — 0052 — with a script, assert the existing guards on the assembled text, add
   the case; CLAUDE.md §4). A `set_org_timezone(p_tz)` beside `set_org_date_format`, same shape and
   grants. `board_window` carries `timezone`, resolved for the board's own root through
   `app_resolve_node_setting` exactly as 0062 carries `date_format` (a definer, so a line
   supervisor's board resolves the plant's zone above her grant — DEF-0016 and DEF-0017 were both
   this). SQL cases in `supabase/tests/87_plant_timezone_test.sql`: an invalid name refused
   `invalid_argument`, a plant override beats the company default, an untouched plant follows it,
   the board payload as Ana carries Plant A's zone, a supervisor refused on the write.
2. **The client seam.** `BOARD_ZONE` stops being a constant. `time.ts` functions take the zone
   (`formatClock(d, zone)`, `formatDayLabel(d, fmt, zone)`, `startOfDay(d, zone)`,
   `mondayOfWeek(d, zone)`); `BoardWindow` gains `timezone` (parsed, defaulting to `'UTC'` when
   absent, like `dateFormat`); `BoardPage` hands it down. Find every reader of the UTC helpers
   with `grep -rn "startOfUtcDay\|utcMondayOfWeek\|BOARD_ZONE" src` and convert each — including
   `boardIndex.ts`'s certificate-expiry day, whose note explains why the day must be the SERVER's
   day: read it, and decide with the server (`expires_at < upper(p_timerange)::date` in the
   session's zone) whether that comparison must now be done in the plant zone on both sides or
   stay UTC on both sides. Write the answer down in the code and in your report; do not leave the
   two sides in different zones.
3. **The DST cost, in geometry.** Under D88a a local day is 1380 or 1500 minutes twice a year.
   The board's x-axis is minutes from the window's local midnight; `shiftInstances` must place
   each day's shifts at that DAY's local midnight plus `startMin` (D88b: wall-clock kept), not at
   `day * 1440`. Introduce a per-window array of day starts (as instants) computed with the zone,
   and derive offsets from it; every `MINUTES_PER_DAY` multiplication in the board's geometry and
   hit-testing goes through it. Pin the two changeover days of a real zone (`America/Chicago`,
   2026-03-08 and 2026-11-01) in `src/test/geometryDst.test.ts`: the day is 1380/1500 minutes
   wide, a 22:00–06:00 shift on the short night is 7 hours of pixels, the day labels stay on
   their days, and a window that does not cross a changeover is pixel-identical to today's output
   (a regression case against the current numbers, measured BEFORE you change anything).
4. **The Settings panel.** A third row, "Time zone", under the same one-`<select>`-two-option-lists
   rule the panel audits; the option list is the IANA names (a curated list of ~60 common zones
   in `src/lib/format/timezones.ts` with the browser's `Intl.supportedValuesOf("timeZone")` as
   the full list when available), company scope and plant scope like the other two rows.
5. **What a person sees.** Set Plant A to `America/Chicago` as Dana: the axis labels move, the
   06:00 shift band sits at 06:00 Chicago, the create form's default times are Chicago times,
   and a run saved at 06:00 reads 06:00 after reload. Ana's board (Line 1, no override) shows the
   same. Plant B, untouched, still reads UTC. Then set it back.

## The rules

- **Anything resolved by walking up the tree is a definer** (CLAUDE.md §4). The client never
  resolves the zone; it reads it off the board payload.
- **A column list that appears twice is a bug with a delay on it.** `BoardWindow`'s parser and its
  fixtures: build from the constant.
- **A green case can be pinning the bug.** When a fix makes existing geometry or time cases fail,
  read them before touching the fix; say whether the case was wrong or the contract changed. The
  existing `time.test.ts` / geometry cases were written for UTC; most should pass unchanged with
  `'UTC'` passed in.
- **Walk it as Ana** before you say done, and run `e2e/roleWalk.spec.ts`: Ana's shift chips and
  date format must still equal Dana's, and now their axis too. Extend `roleWalk` only if you
  need a new fact asserted across people; do not restructure it.

## You own (exclusive)

- `supabase/migrations/20260907000063_*.sql`, `supabase/tests/87_plant_timezone_test.sql`, `src/lib/database.types.ts` (via `db:types`)
- Everything under `src/features/board/`
- `src/lib/api/shapes.ts`, `src/lib/api/board.ts` (or wherever `fetchBoardWindow` lives), `src/lib/api/settings.ts` if it exists, `src/lib/api/index.ts` (exports only), `src/lib/format/dates.ts`, `src/lib/format/timezones.ts` (new)
- `src/features/admin/components/SettingsPanel.tsx` and its CSS Module; `src/features/admin/lib/settings*.ts` if any
- Tests: `src/test/geometryDst.test.ts` (new), and the existing board time/geometry/shape/settings test files, adding cases; `e2e/roleWalk.spec.ts` (additions only)

You do NOT own `src/lib/api/access.ts` (the other lane; if you need `setNodeSetting` widened for
the new key, it lives there — write the exact change you need in your report and, if it is one
line in the key union, make it and say so in your report, since the other lane was told about it).
Not `SiteAccessPanel.tsx`, `session.ts`, `ResetPasswordPage.tsx`, anything under `supabase/functions/`,
or migration 0064.

## Finish

1. `npx prettier --write` and `npx eslint` on your files; `npx vitest run` on your files; the SQL file via the repo's runner; `npx playwright test e2e/roleWalk.spec.ts`. Paste the runners' total lines verbatim.
2. Report, in order: what a person sees, plant by plant; files from `git status`; the runner lines; the certificate-day decision and why; the DST measurements (minutes per day and pixels for the two changeover days); the walk as Ana; then YAML: `requirements` rows **R-353** (the board's axis is the plant's local time, resolved upward as a definer and carried in the payload), **R-354** (a shift keeps its posted wall-clock start across a DST change and the geometry follows), **R-355** (a plant's time zone is set in Settings under the same rules as its date format), `stated_by: maintainer`, `source: [D88 §19.21, queue item "Per-site timezone (D10 / D88)", session 85 conversation]`; a `findings` card **F-109** only if something went wrong. Anything unfinished, said plainly.
