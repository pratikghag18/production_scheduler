# Review brief: S194-C, scripts and seed -- one job: break it

You are a reviewer, not the author. Lane C changed `scripts/voice/clips/record.mjs`,
`scripts/voice/clips/score.mjs`, `scripts/voice/serve/serve.mjs`, `supabase/dev_demo.sql`,
`supabase/tests/dev_demo_test.sql`, `e2e/touch.spec.ts`, `e2e/typedWalk.spec.ts`, `e2e/walk/time.ts`
and added `src/test/localToolsListenLocally.test.ts`, for DEF-0039, DEF-0050, DEF-0045, DEF-0042 and
DEF-0044 item 3. Its brief is `docs/agent-briefs/s194-c-scripts-and-seed-brief.md`; read it, the
five defect files, then `git diff -- scripts supabase e2e` and the new test file.

Two other reviewers are working in `src/lib/command/resolve.ts` and in the absence screens and
board components. Leave those alone; ignore `tsc` errors in them.

## Hard rules

- **Write nothing to the running databases.** Two Supabase stacks are up on this machine: the
  maintainer's (`supabase_db_production_scheduler`) and the tester's
  (`supabase_db_production_scheduler_tester`). Read-only `psql` against either is fine. Do not run
  `npm run db:reset`, do not run `node scripts/tester-stack.mjs up` or `down`, do not start or stop
  any container, do not start the voice servers.
- **Do not run any Playwright spec.** `typedWalk.spec.ts` writes to the database it is pointed at.
  The main session decides where and when it runs.
- Seeded-database proofs go through `bash scripts/run-sql-test.sh --demo` (the scratch database).
- Do not commit. Do not run the full `npm run test`. Do not edit `docs/defects/*.md`,
  `docs/plan.yaml`, `CLAUDE.md`. Do not write under `data/voice/`. PowerShell runs npm and npx (no
  `&&`); the Bash tool runs the `.sh` scripts. Never `git checkout -- <file>` (copy first, restore
  from the copy, confirm afterwards your mutations are gone); never patch with
  `Get-Content`/`Set-Content`.

## What you may write

New cases in `src/test/localToolsListenLocally.test.ts`, new checks in `dev_demo_test.sql`, and a
small fix in a file lane C owned when the finding is clear and a few lines. Anything larger you
report. Say which you did.

## The main session's doubts -- test these first

1. **The scorer was rewritten, 218 lines.** The failure path was proved; the NORMAL path was not
   re-proved. Find everything that READS the scorer's output: grep `scripts/`, `src/test/`, `docs/`
   and `package.json` for the results file's field names and for `score.mjs`. Did a field get
   renamed, did a row gain a `status` that a reader does not expect, did the summary line change in
   a way a parser of it depends on (the old line began `mean WER`)? Run every vitest file that names
   the scorer (`src/test/voiceClips.test.ts` and any other). Run the scorer in-process the way lane C
   did, over a fake Whisper that answers every clip correctly, and compare its table and JSON with
   what the README beside it documents; the README must match what the script now prints and its
   `--timeout` flag.
2. **Exit code and the `--from-trace` path.** Lane C says both loops catch per clip. Read the
   `--from-trace` loop: does it write its results in a `finally` too, does it print the N of M line,
   does it set the exit code? A half-converted second path is the likely miss.
3. **The seed is now a round-robin by `employee_ref`.** (a) Is it stable when a person is added:
   does adding one operator to a plant move everyone else's shift? Say so plainly; it is a demo seed
   and that may be acceptable, but the maintainer should know. (b) The seed's BLOCKS follow home
   shifts. Read-only, on the scratch database after `--demo`: list Plant A's seeded blocks for one
   day by person, cell and hours in America/Chicago. Is every cell that had daytime cover before
   still covered; is Line 1 (Ana's line) populated in the day shift; does any person now sit on a
   cell whose certificates they lack (the seed's eligibility policy is `warn`, so nothing refuses)?
   (c) Compare against what the specs expect: grep `e2e/*.spec.ts` for a clock hour beside a demo
   person's name or a cell ("14:00", "22:00", "2 pm", "10 pm") and for `roleWalk`'s assertions; list
   any spec that assumed the old hours. Lane C found only one stale comment
   (`e2e/absenceOnBoard.spec.ts:105`); check that claim.
4. **D16 and the night shift.** D16 compares end minutes modulo 1440. Would it pass a night block
   that ends at 06:00 on the WRONG day (a block 22:00 to 06:00 two days later)? Would D13 to D16
   together pass a block of zero length or one spanning 24 hours plus its band? Mutate a COPY of the
   seed for each, run `--demo`, report the tally lines. Restore.
5. **The trim in `typedWalk.spec.ts`.** Read `trimSpillIntoWalkDay`. (a) It updates rows whose
   range STARTS before the walk day, on whatever database the walk is pointed at, which can be the
   maintainer's. The old contract in `e2e/walk/time.ts` said nothing before the walk day is touched.
   State exactly which rows on the maintainer's database it would change today: run the equivalent
   SELECT read-only against `supabase_db_production_scheduler` and paste the rows (person, cell,
   range). (b) It trims a run and its crew blocks separately with plain UPDATEs; is there an
   exclusion constraint, a trigger or a guard that refuses one of them or fires a side effect
   (`grep -in` the migrations for triggers on `assignments` and `runs`; take the LAST definition of
   each function)? (c) It runs for ALL of Plant A's nodes, not only the walk's cells; is that wider
   than the walk needs? (d) The second walk list (`e2e/walk/sentences2.ts`): does whatever spec runs
   it have the same spill and did lane C leave it untrimmed? Find the spec that runs it.
6. **`serve.mjs` was read, not run.** Check the edited `-p` argument is well formed in the argument
   ARRAY it is part of (a template string inside an array element, not split wrongly), and that the
   URL the script later prints or probes still matches.

## Then break it your own way

- `localToolsListenLocally.test.ts` asserts on source text. Mutate `record.mjs` back to a host-less
  `listen` and `serve.mjs` back to a bare `-p`: red by name? Then try the evasions a text check
  misses: `listen(port, "0.0.0.0", cb)`, `listen({ port })`, a `--publish` spelled long. Tighten the
  test if one gets through.
- `touch.spec.ts` T3 clicks every off chip. Read how the rail's chips toggle: if "now" is in no band
  and ALL chips are off, does it still end with chips on and people listed?

## Report

Plain prose. For each of the six doubts: confirmed or refuted, with the evidence (rows pasted, tally
lines copied, the case name and the runner's line). Every finding: what goes wrong for a person, what
shows it, whether you fixed it. Every mutation and whether a check caught it by name. What you did
not examine, and everything not run.
