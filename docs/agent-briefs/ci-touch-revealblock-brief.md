# Lane brief: CI's last red step — `revealBlock` stops scrolling too early (touch T2, T5)

You own exactly one file: `e2e/touch.spec.ts`. Nothing else. Do not touch `src/`, do not write a
migration, do not commit, do not edit `docs/plan.yaml` or `docs/defects/*.md`. Never run
`npm run db:reset` — the maintainer is using the app.

## What is wrong, already diagnosed — confirm it, then fix it

CI's only red step is `bash scripts/ci-e2e.sh`, and inside it exactly two browser cases fail, both in
the `touch` project and both deterministically (all three attempts, `retries: 2`):

- `T2: a finger drags a block along its track`
- `T5: a viewer's finger neither drags a block nor creates on empty track`

Both die in `grabBlockTouch` with, verbatim from this machine:

    no block with a touchable slice: cont.x=24 w=1090 railW=232 safe=[268,1102] n=8
      blocks(x,w)=[1461,832 | 1461,832 | ... ]
    no block with a touchable slice: cont.x=357 w=758 railW=406 safe=[775,1102] n=4
      blocks(x,w)=[1845,832 | 1845,832 | ... ]

Read those numbers before you change anything. Eight blocks exist, all at x≈1461 with width 832,
while the safe zone ends at 1102 — every block sits entirely to the RIGHT of the zone
`grabBlockTouch` will accept.

**The cause is `revealBlock`.** It scrolls the board until `anyBlock(page).first().isVisible()` and
then returns. Playwright's `isVisible()` only means the element has a non-empty box and is not
`display:none` — inside a horizontally overflowing scroll container a block far outside the viewport
still satisfies it. So `revealBlock` returns happy, and `grabBlockTouch` — which needs a slice of at
least 70px between `safeLeft` (past the row label rail) and `safeRight` — finds nothing and throws.

**This is a test-helper bug, not an app bug, and that matters.** The behaviour under test (a finger
drags a block; a viewer's finger is refused) is unrelated to where the board happens to be scrolled.
The helper's own contract — "leave the board scrolled so a block is grabbable" — is what is broken.
It is latent rather than new: whether the first visible block lands in the safe zone depends on where
the board auto-scrolls (it brings "now" into view) relative to where the demo world's runs sit, so it
passes on a stale local world and fails on the freshly seeded one CI builds every run. Do not "fix"
it by loosening `grabBlockTouch`'s 70px requirement or by widening the safe zone; those are the
assertion, not the bug.

## The fix

Make `revealBlock` scan for what the caller actually needs instead of for mere visibility. The
cleanest shape is to have it share `grabBlockTouch`'s own notion of a usable slice: compute
`safeLeft`/`safeRight` the same way (one helper, not a second copy of that arithmetic — a rule this
project has paid for more than once), and step the scroll position until some block has a slice of
at least the same threshold `grabBlockTouch` demands, rather than until one is merely visible. Scan
the whole scroll width before giving up, and when you do give up, keep a dump as informative as the
current one.

Both functions must agree on the threshold and the zone by construction, so that one cannot pass
while the other refuses.

## Proving it

1. **Reproduce first.** `npx playwright test --project=touch --workers=1 --retries=2` and show T2 and
   T5 failing with that message. Report it verbatim. If they pass on your run, the world has drifted
   — force the condition by scrolling the board fully left/right before the helper runs, or by moving
   the board window to a day whose runs sit off-screen, and say exactly what you did.
2. **Fix, then re-run the same command.** All touch cases green.
3. **The whole suite, as CI runs it**: `npx playwright test --workers=1 --retries=2` — every project,
   not just one. The measured state on this tree is 41 passed, 2 failed; yours must be 43 passed, 0
   failed. Copy the runner's own summary line.
4. **Run it twice more** and report both totals. A helper that scrolls to find something is exactly
   the kind of fix that passes once by luck; two more green runs is the minimum evidence.
5. `npm run format:check` — CI dies on it before the tests, and a pre-commit hook now refuses
   unformatted staged files. Run `npx prettier --write e2e/touch.spec.ts` if needed.

`npm run dev` is expected on http://localhost:5173; start it in the background if it is not, and say
so. The local Supabase stack is up and the demo world was reseeded this morning.

## Report

Plain prose, no bullet lists. Lead with the failure message before your change and the summary line
after it. Then: what `revealBlock` now scans for, how you kept it and `grabBlockTouch` from carrying
two copies of the zone arithmetic, all three full-suite totals, and anything you noticed and did not
fix.
