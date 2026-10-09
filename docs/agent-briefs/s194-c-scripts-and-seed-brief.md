# Lane brief: S194-C, scripts and seed -- DEF-0039, DEF-0050, DEF-0045 (seed and spec), DEF-0042, DEF-0044 item 3

You are a build lane. Two other lanes run at the same time: lane A owns the absence screens,
`BoardPage.tsx`, the pop-ups and `OperatorPanel.tsx` (it adds the rail's "Nobody on Shift 1"
sentence); lane B owns `src/lib/command/resolve.ts` and `src/test/commandResolve.test.ts` (it is
changing some of the bar's words: "for 1 person", the spoken day in the Done line). Do not touch
their files. Ignore `tsc` errors in files you do not own. Do not run the full `npm run test`. Do not
commit. Do not edit `docs/defects/*.md`, `docs/plan.yaml` or `CLAUDE.md`.

## Hard rules for this machine

- **NEVER run `npm run db:reset`, and never write to the running local database**
  (container `supabase_db_production_scheduler`): the maintainer is using the app on it. Read-only
  `psql` queries against it are fine. Everything that needs a seeded database is proved on the
  SCRATCH database: `bash scripts/run-sql-test.sh --demo` (read the script's header for how it builds
  it and which env it needs, `SUPABASE_DB_CONTAINER` among them).
- **Do not start or stop Docker containers** other than what `run-sql-test.sh` does itself. Do not
  start `npm run voice:serve`; the Docker VM's memory is tight and the maintainer manages it.
- The shell for npm and npx is PowerShell (no `&&`; separate with `;`). The Bash tool is for the
  `.sh` scripts. Never patch a file with `Get-Content`/`Set-Content`; use your edit tool or node.
- Never `git checkout -- <file>` to undo a deliberate breakage; copy the file first, restore from
  the copy.

## Files you own, and no others

- `scripts/voice/clips/record.mjs`, `scripts/voice/clips/score.mjs`, `scripts/voice/serve/serve.mjs`,
  and the READMEs beside them
- `supabase/dev_demo.sql`, `supabase/tests/dev_demo_test.sql`
- `e2e/walk/time.ts`, `e2e/typedWalk.spec.ts`, `e2e/touch.spec.ts`
- any existing vitest file that tests the three scripts (grep `src/test` for `record.mjs`,
  `score.mjs`, `serve.mjs`); add cases only

## Read first

1. `CLAUDE.md` §4 and §7 (R-433 a walk is a spec first; the new R-460, a local tool listens locally).
2. `docs/defects/DEF-0039.md`, `DEF-0050.md`, `DEF-0045.md`, `DEF-0042.md`, `DEF-0044.md` (item 3).
3. `e2e/walk/time.ts` whole, and the top hundred lines of `e2e/typedWalk.spec.ts`.
4. `supabase/dev_demo.sql` around the home-shift assignment and the block loop (the tester cites
   about l.472 and l.519), and `supabase/tests/dev_demo_test.sql` D13 and D14.

## Piece 1 -- DEF-0039 and R-460: listen on this machine only

1. `record.mjs` l.443: `server.listen(args.port, "127.0.0.1", cb)`. The banner already prints
   127.0.0.1; now it is true.
2. `serve.mjs` about l.295 publishes the model container as `-p ${HOST_PORT}:${CONTAINER_PORT}`,
   which Docker binds on every interface; the Whisper container above it (l.216) uses
   `127.0.0.1:${...}:${...}`. Make the model container the same. Read, do not run.
3. R-460's duty: grep `scripts/` and the Vite config for every other `listen(`, `createServer`,
   `-p ` publish and `host:` and list each with its binding in your report. Fix any you own that
   binds wide; name any you do not own.
4. Proof: start `record.mjs` on a free port with a scratch `--out` folder under your temp
   directory, run `netstat -ano | findstr :<port>` and paste the line (it must read `127.0.0.1:<port>`,
   not `0.0.0.0`), then stop the server. If a test file for the scripts exists, add a case that
   asserts on the source text that `listen` is called with the loopback host and that every `-p`
   publish in `serve.mjs` begins `127.0.0.1:`; if none exists, create
   `src/test/localToolsListenLocally.test.ts` for it (this one new file is yours).

## Piece 2 -- DEF-0050: one failed clip does not lose the run

In `score.mjs`: catch per clip and record the row as failed with its status or message; write the
results file so that what was scored survives a later failure (incrementally, or in a `finally`);
give the fetch a timeout through `AbortSignal.timeout` (a flag with a sensible default, say 60 s,
since small.en took about 4 s a clip on this machine); print "N of M scored, K missing, F failed"
beside the mean. The means are computed over scored clips only, and the line says so. Exit code is
non-zero when any clip failed or was missing, AFTER the table and the file are written.
Proof: a fake Whisper (a tiny node http server you start on a loopback port, answering chosen text,
one 500, one that never answers) over synthetic 16 kHz mono WAVs in a scratch folder, the way the
tester's lane did. Paste the scorer's output. Do not touch `data/voice/**`.

## Piece 3 -- DEF-0045 and R-462: people on every shift in the demo, and a spec that holds at any hour

The maintainer decided on 28 Sept: the seed spreads Plant A's people across all three shifts.
1. In `dev_demo.sql`, change how home shifts are given so Plant A has at least one person homed on
   each of Shift 1, 2 and 3, AND Line 1 (Ana's line) has at least one person on Shift 1, so the rail
   she sees in the working day is not empty. Keep Plant B's spread sensible the same way. Keep the
   choice deterministic (no `random()`). Every seeded block must still sit inside its person's own
   band (R-452; D13 and D14 hold that).
2. Add a check to `dev_demo_test.sql`: every shift of every seeded plant has at least one person
   homed on it. Name it in the file's own style (the next free D number).
3. `e2e/touch.spec.ts` T3 must not depend on the hour it runs. Two defences, use both: the seed now
   has someone on every shift, and T3 presses the rail's shift chips first if the list is empty, the
   way `e2e/absenceOnBoard.spec.ts` already does (read it, copy its approach).
4. **Tell me in the report every e2e spec and every vitest file that names a seeded person's shift or
   expects a particular person on a particular cell at a particular hour** (grep `e2e/` and
   `src/test` for the demo names: Sam Patel, Maria Lopez, John Kim, Priya Shah, Tom Baker, Lena
   Novak). Changing home shifts moves seeded blocks; a spec that expected "Maria Lopez 22:00" will
   notice. Fix the ones in files you own; list the rest.

## Piece 4 -- DEF-0044 item 3: the seed's end edge is held

D13 checks a block's START minute against the home shift; D14 checks no minute falls outside the
band. A block that stops an hour short passes both. Extend D13 (or add the next D) to compare the
END: the upper bound's wall-clock minute in the plant's zone against the shift's end minute, modulo
1440 for the night shift. Prove it can fail: on a COPY of `dev_demo.sql`, make the tester's mutation
(`v_to := v_from + interval '7 hours';`), run `bash scripts/run-sql-test.sh --demo`, see the new check
FAIL by name, restore, see it PASS. Paste both tally lines.

## Piece 5 -- DEF-0042: the typed walk is green on a fresh seed

What is wrong: the walk's day is the Monday of next week; the seed writes the current week; since
R-452 the seed's Sunday night blocks (22:00 to 06:00) run into that Monday. The walk's first
sentence expects an empty Cell 4 and finds Priya's block. The comment on `walkDayInZone` ("the demo
seed ... never writes here") is no longer true.

Constraints that narrow the fix:
- The walk's "next week" repeat entry relies on the walk day being the Monday of next week
  (`e2e/walk/sentences.ts` l.159, F-182). Moving the walk day breaks that; do not move it unless you
  can show every sentence that depends on it and carry them all.
- The cleanup window deliberately touches nothing before the walk day, because the walk also runs
  against a database a person is using.
- R-461 (decided 28 Sept, NOT yet built, lane D's) says a night shift is split at midnight: the part
  after midnight belongs to the next day.

Preferred fix: the spec's setup, before the first sentence, TRIMS every block and job on the walk's
places that starts before the walk day's midnight and ends after it, so it ends AT that midnight
(Sunday keeps its 22:00 to 24:00; the walk's Monday starts empty), through the same database path the
spec's existing cleanup uses. Rewrite the comment on `walkDayInZone` and on `cleanupWindow` to say
what is true now. If the existing cleanup cannot trim (only delete), say so and propose the smallest
alternative in your report BEFORE building something larger.

Also fix the count the spec failed on ("the two areas' listings together should name every block and
every job the walk left on the walk day", expected 10, received 14) only by removing the spill, never
by changing the expected number to fit.

Proof (R-433, green TWICE over the same data): you cannot reset the maintainer's database, so ask
the scratch route first: read `scripts/tester-stack.mjs` and `scripts/tester-run.mjs` headers. If the
tester's stack can be brought up from this worktree without touching the running stack's ports or
data, run the typed walk on it twice and paste both result lines. If it cannot, or you are unsure it
is safe, DO NOT run it: say so, and hand back the exact command for the main session to run. A walk
you did not run is reported as not run.
Lane B is changing words the walk may assert on ("for 1 person", the spoken day in the Done line).
Grep the walk's expectations for "people" and for a raw ISO date in an expected Done line and list
them; do not pre-empt lane B's strings, the main session reconciles them after both lanes land.

## Report

Plain prose. Include, per piece: what changed, file by file; the proof output COPIED from the
runner or the terminal (netstat line, scorer output, the SQL tally lines red then green, the e2e
result lines, or "not run" with the command); the R-460 inventory of every listener; the list from
piece 3 step 4; anything you found that you did not fix. Include a draft commit message in the
repo's style: plain ASCII, reasoning in prose, no bullet lists.
