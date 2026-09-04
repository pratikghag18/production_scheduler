# `docs/plan.yaml` — the plan of record, and how to edit it

`docs/plan.yaml` is the **one document every session must read**. It replaced three
hand-maintained files on 2 September 2026: the roadmap's status paragraph, and the two
hand-written gameplan pages (`schedulerbuildout.html`, `operator-training-matrix.html`).
`docs/design-plan.md` stays as the archive of *why* each decision was made; the plan file
points into it by number (`D113`, `§19.76`) and nobody is required to open it.

`docs/plan.html` is **generated** from the plan file by `npm run plan` (which runs
`node scripts/render-plan.mjs`). Never edit the HTML. The renderer also **validates**: an
unknown id, a missing field, a session entry without a test count, or a stage that names a
requirement that does not exist all fail the render loudly and exit non-zero. `npm run plan
-- --check` validates without writing.

Defects are the one part that lives outside the file: **one Markdown file per defect** in
`docs/defects/`, with YAML front matter (see `docs/defects/TEMPLATE.md`). They are separate
files so the tester and the developer can each write without merge conflicts. The renderer
reads them and draws them as cards beside the findings.

## Top-level keys

| key | what it is |
| --- | --- |
| `meta` | title, `updated` date, `tip` (the commit the numbers were measured at), and `baseline` — the confirmed counts the tester compares against |
| `tracks` | the buildouts: `core` (the scheduler) and `matrix` (the operator training matrix). A stage belongs to one track |
| `stages` | the work, in the plan's own numbering. Renders as the stage cards |
| `requirements` | the ledger: one row per thing the product must do, with its source and what proves it |
| `findings` | the "things that weren't in the plan" — defects and discoveries made while building. Renders as the finding cards |
| `sessions` | one entry per working session, newest first. Replaces the roadmap's "Last updated" paragraph |
| `next` | the ordered queue of what comes next. **Order is a guess about priority, not a fact** — ask the maintainer when it has drifted |

## `stages[]`

```yaml
- id: S21                 # S + two digits for core; M + digit for matrix
  track: core
  num: 21                 # the number shown on the card
  title: "“No member from one plant should see info for other plants”"
  status: done            # done | now | open | parked
  owner: agent            # agent ("Mine — no input needed") | maintainer ("Your run")
  refs: [§19.68, §19.69, D107]     # design-plan sections and decisions; free text, not validated
  delivers: [R-107, R-108]          # requirement ids — VALIDATED, must exist
  what: >-               # plain language, the maintainer's register. Markdown allowed.
    ...
  state: >-              # one or two sentences on where it stands
    ...
  measure:                # optional, what was measured when it shipped
    app_tests: 1224
    db_checks: 468
    mutations: "13 of 15 caught, 2 explained"
```

## `requirements[]`

```yaml
- id: R-113
  title: "A person may be placed outside their area only with a recorded reason"
  source: [D113, §19.76]            # where the requirement was stated
  stated_by: maintainer             # maintainer | agent | brief
  claim: >-                         # one or two sentences: what must be true
    ...
  verified_by:                      # what proves it. Empty list = uncovered.
    - kind: sql                     # vitest | sql | e2e | mutation | manual | screen
      file: supabase/tests/57_area_override_test.sql
      cases: "P1–P17"
    - kind: vitest
      file: src/test/placement.test.ts
    - kind: manual
      steps: "Sign in as a Line 1 supervisor; open a Line 2 cell; the person appears with ⚠ and a reason box"
  status: covered                   # covered | uncovered | contradicted | superseded
  superseded_by: R-120              # only when status is superseded
  note: >-                          # optional
    ...
```

`status: covered` requires at least one `verified_by` entry that is not `manual`.
`status: contradicted` means the code was observed doing something else: a defect file must
name it under `violates`.

## `findings[]`

```yaml
- id: F-041
  title: "The Operators screen told you someone can work in plants they are not allowed to"
  tag: "A screen saying yes where the database says no"   # the card's eyebrow
  status: fixed          # fixed | open | owed | wontfix
  found_by: maintainer   # maintainer | agent | test | tester | reviewer
  stage: S20             # optional, the stage it fell out of — VALIDATED
  refs: [§19.77]
  violates: [R-109]      # optional requirement ids — VALIDATED
  story: >-              # the plain-language card body. Markdown; paragraphs separated by blank lines.
    ...
```

## `sessions[]`

```yaml
- id: 21
  date: 2026-09-02
  title: "The Operators tab becomes one matrix"
  shipped: [M4]          # stage ids — VALIDATED
  commits: [51c3d04, e82bfa7]
  numbers:               # REQUIRED: app_tests and app_test_files. The rest as measured.
    app_tests: 1591
    app_test_files: 44
    tsc: 0
    eslint: 0
    db_checks: 522
    migrations: 35
  confirmed: true        # true only when the counts were read off the runner's own total line
  summary: >-
    ...
```

The numbers band on the page is computed from the newest session with `confirmed: true`.
**Copy the runner's total line verbatim; never write a number you reasoned to.**

## `next[]`

```yaml
- stage: S23             # or a requirement id, or free text under `text:`
  why: "..."
```

## Defect files — `docs/defects/DEF-0001.md`

See `docs/defects/TEMPLATE.md`. Front matter fields: `id`, `title`, `severity`, `class`,
`violates` (requirement ids, validated), `status` (`open` → `fix-claimed` → `verified` |
`reopened` | `wontfix`), `filed` (date), `filed_by`, `fix_commit`, `pin` (the reproduction
test path under `src/test/defects/`). Body sections: **Reproduction**, **Expected**,
**Actual** (runner output verbatim), **Lead** (a suspicion, not a fact).

**Only the tester moves a defect to `verified`. Only the developer moves it to `fix-claimed`.**

## Ids never change

A stage, requirement or finding keeps its id for life. Retire by status
(`superseded`, `wontfix`, `parked`), never by deletion — a deleted id turns every reference
to it into a validation error, which is the point.
