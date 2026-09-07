# Wave 3 — the reviewer's brief

You did not write any of this. Your one job is to **break it**: find what a person using the app
would see go wrong, or what the tester will file as a defect, before it is committed. You may edit
nothing in the repo except scratch files under your job's tmp directory; you report, and the
developer session decides. Read `CLAUDE.md` section 4 first, and section 2's rule that a defect is
fixed when its reproduction passes, not when the code looks right.

Five lanes worked from five briefs in `docs/agent-briefs/`:

- `wave3-a-invitations-brief.md` — the first Edge Function (`supabase/functions/invite`), migration 0064, the Access panel's invite control, the "Set your password" landing, "invited" until first sign-in.
- `wave3-b-plant-local-time-brief.md` — migration 0063, `timezone` on the board payload, the zone-aware time seam, DST geometry, the Settings row.
- `wave3-c-named-templates-brief.md` — migration 0065, week templates saved and applied through Copy Week, the board controls, a Templates admin tab, and the `absent` clash sentence in the Copy Week dialog.
- `wave3-d-absence-brief.md` — migration 0066, absences recorded and imported, the writers consulting `absence_overlap`, the Absences tab.
- `wave3-e-absence-on-the-board-brief.md` — the board's surfacing of an absence before and after a save, possibly migration 0067.

Take the changed file list from `git status` and `git diff --stat`, never from the reports. The
lanes' final reports are in the message that launched you. Four migrations (0063, 0064, 0066 and
maybe 0065/0067) have re-emitted overlapping functions on the live stack this session; the file
you read may not be what the database runs. **Read every function you reason about with
`pg_get_functiondef` from the live container** (`docker exec supabase_db_production_scheduler
psql -U postgres -c ...`), and say for each re-emitted function which migration's text is live.

## Walk in through the other door

Drive every changed screen in the running app at `http://localhost:5173` as the LEAST-privileged
person it touches. Demo people, all `devpassword`: Ana `ana@example.test` (Line 1 supervisor),
Marco (Area 1 supervisor), Viva `viva@example.test` (Plant A viewer), Vina (Plant C viewer), Dana
`dana@example.test` (Plant A site admin), Quinn (Plant B site admin), `admin@example.test`
(company admin). Put back every setting and password you change, delete every row you add, and
say that you did. **Never `db:reset`, `supabase stop` or `supabase start`.**

## What to try, lane by lane

**A, invitations.** Is the function actually served (`supabase/functions/README.md`)? If not,
serve it and say so. Invite as Dana with each of the three roles at Plant A and at Line 1: is
admin refused below a plant root, exactly as the Add control refuses it? Invite an email that
already belongs to the demo org; one that belongs to no org twice in a row; a malformed one; as
Ana by calling the function directly with her token; with a forged `Origin` header. Does the
function ever answer ok when the grant did not land? Does the profile row survive a refused
grant? Is the service role's new grant (F-108) the narrowest it could be? Open the invited
person's link in a fresh browser context: "Set your password", then the board of the granted
place, nothing else. Then F5 on the reset screen and go to `/`: still gated? Is the "invited"
mark right for each demo person (none of them should show it)?

**B, plant-local time.** Set Plant A to `America/Chicago` as Dana. As Ana: the axis, the shift
bands, the create form's default times, a run saved at 06:00 reads 06:00 after reload; the
toolbar's date range agrees with the header (F-109 was exactly this). As Quinn: Plant B untouched.
Set the window to the week of 2026-11-01 and read the fall-back day: 25 hours wide, the overnight
shift 9 hours, no gap and no overlap at 01:00–02:00. Then 2026-03-08. Then the edge the lane
itself flagged: with Chicago set, scroll to the last hours of the window and create a run at
22:00 on the last day; reload; is it drawn? The lane says the fetch window is still keyed on
the UTC marker, so runs in the last ~5 hours may be missing until scrolled. Confirm or refute
with a concrete run, and say what a person would see. Certificate-day: the lane kept `boardDay`
in UTC to match the server's cast; make a certificate expire on a Chicago day that is still the
previous UTC day and check the pop-up and the server agree. Set Plant A back to inherit.

**C, templates.** As Ana: save this week as a template, apply it to a scratch week (the one
`e2e/copyWeek.spec.ts` uses), read the preview counts against Copy Week from the same source
week, settle a clash each way, confirm, and compare the rows written with what Copy Week writes
from the week (the lane claims row equality; check it in SQL). Apply a template saved on Plant A
to Plant B as Quinn: refused? Save a template whose week has an overnight shift and apply it
across a Chicago DST week with Plant A set to Chicago (B and C interact here: relative minutes
from Monday versus wall-clock days). Delete a template that has been applied. Try to delete as
Ana. Duplicate names, case-folded. A template with zero items.

**D and E, absence.** As Ana: record an absence for a Line 1 person for tomorrow; open the board;
the person is marked in the panel; the create pop-up says on leave; save under warn (reason
box?) then under block (refused in place, and the server refuses too if you bypass the screen
with a direct RPC); move a run whose crew includes them across the absence; reassign; Copy Week
a week that contains their assignment into the absence (`absent` clash in the dialog, the right
choices under warn and block). Boundary days: an absence ending today and a shift starting
00:00 tomorrow; a shift ending 24:00 today. Import a CSV as Dana with a row for a Plant B person:
refused? Record for someone homed at the plant as Ana (above her grant): refused, and does the
screen say so or hide it? As Viva: no tab, and the board still shows the mark (she can read the
person). Remove everything you recorded.

**Across lanes.**
- `npm run typecheck`, `npm run lint`, `npm run format:check` on the whole tree; `npm run db:types` and diff against the committed file (CRLF aside): zero lines or say what differs.
- The SQL suite, every file, via the repo's runner; paste the summed line. The unit suite is the developer's job; do not run it.
- `npx playwright test` (every project) against the live stack; paste the totals.
- Files touched by two lanes: `git diff --stat` against the five "You own" lists; `access.ts`, `session.ts`, `index.ts`, `AdminPage.tsx`, `database.types.ts` and the shared test audits were shared by design, so read those diffs whole.
- Anything a lane reported as "could not finish", "needs a change in a file I do not own" or "for the reviewer".

## Report

For each real thing you broke: what a person would see, which lane, the file and line, the exact
steps, and whether a direct RPC reproduces it without the screen. Then the runner lines. Then a
one-line verdict per lane: ship, ship after a named fix, or hold. Three real findings beat ten
cosmetic ones; "nothing found" for a lane is a valid answer when you drove it and tried.
