---
# Copy this file to DEF-NNNN.md (next free number, four digits). The file name IS the id.
# Every field below is validated by `npm run plan -- --check`; the render fails if one is wrong.
id: DEF-0000
title: "One sentence naming what the product does wrong, in the maintainer's words"
severity: major # blocker | major | minor | cosmetic
# The CLASS names the family the defect belongs to. Use the project's own names, because each one
# has a known shape and a known way of hiding:
#   stale-permission   the client SHOWS something the server will REFUSE (the dangerous direction)
#   stale-refusal      the client refuses something the server allows (quiet, annoying)
#   silent-empty       a read parses to nothing and a screen renders empty with every test green
#   cross-tenant       one company can see or touch another's rows
#   write-no-op        a write reports success and changed nothing (RLS USING filter, ROW_COUNT)
#   count-drift        the test count moved without a reason
#   doc-drift          the code does one thing and the plan / a comment / a label says another
#   test-cannot-fail   a green case that passes with and without the behaviour it names
#   visual             wrong on the screen (contrast, layout, a glyph that renders as an emoji)
#   other
class: stale-permission
violates: [R-D109] # requirement ids from docs/plan.yaml — at least one, all must exist
status: open # open → fix-claimed (developer) → verified | reopened (tester only) · wontfix
filed: 2026-09-02
filed_by: tester # tester | maintainer | developer
fix_commit: # the developer writes the short hash here when setting fix-claimed
pin: # src/test/defects/DEF-0000.test.ts — the reproduction test, when one could be written
---

## Reproduction

The exact command, or the exact click path as a role in the running app. Somebody who has never
seen the code must be able to repeat it.

## Expected

What the requirement says should happen, quoting its `claim`.

## Actual

What happened. **Runner output pasted verbatim** — never a number or a message reasoned to.

## Lead

Where the tester suspects it lives, and why. **A lead, not a fact** — the obvious fix for the last
cross-tenant finding was measured wrong. The developer decides.
