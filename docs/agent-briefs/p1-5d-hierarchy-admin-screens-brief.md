# Brief P1-5d — the hierarchy admin screens

**You are a build agent.** Every decision here is already made. Where something is left to you it
says so. **If you find an error in this brief, flag it in your report** — every previous brief on
this project contained at least one real one, and the deviations list is the most valuable part of
what you write.

**This brief ships NO drag-and-drop.** Re-parenting is done through a "Move to…" picker. Drag is
P1-5e and will be layered on top of exactly the same data path. If you find yourself writing a
`dragstart` handler, stop.

**This brief ships NO CSV import.** That is P1-5f.

What it builds: `/admin` becomes a real page with sections, and the first section — Hierarchy —
contains the two editors the whole onboarding story depends on. A **level editor** (the vocabulary:
Site → Department → Line → Work Cell) and a **node tree editor** (the actual plant).

---

## 1. Read these first

| File | Why |
| --- | --- |
| `docs/design-plan.md` **§19.1–§19.4** | D67–D74. What migration 0010 enforces and why. **§19.4's brief numbering is superseded — read its banner.** |
| `docs/design-plan.md` **§19.12, §19.15** | What P1-5b left owed (§6.3 here), and the tenant-scope rule you must not undo. |
| `src/features/admin/lib/hierarchy.ts` | **P1-5b's pure lib. You are building on it and must not duplicate it.** `canDropOn`, `buildHierarchyTree`, `validateLevelDraft`, `slugify`. |
| `src/lib/api/hierarchy.ts` + `src/features/admin/hooks/useHierarchyMutations.ts` | The five typed wrappers and the React Query hooks. Already written; you are their first caller. |
| `supabase/migrations/20260825000010_hierarchy_admin.sql` | The RPCs' validation ORDER and the DETAIL payload of each error. |
| `docs/mockups/model-hybrid.html`, the `#shiftModal` editor (~line 1563) | **The signed-off editor idiom**: a local draft, inline `×` and `+ add` rows, an error line, Cancel/Save. Match it. |
| `src/features/board/components/BoardPopover.tsx` | The popover shell — and §7.4 on why you cannot import it. |
| `src/test/hierarchy.test.ts`, `src/test/placement.test.ts` | House style for a pure-module vitest file. Copy their shape. |

---

## 2. Environment

Cowork cloud container. **No Docker, no npm/pip/apt network.** Do not attempt `supabase start` or
any install.

### 2.1 Part A runs; Part B does not

`node --experimental-strip-types file.ts` executes TypeScript by erasing annotations. **All three §4
modules are mandatory-executable** — you will run them and mutation-test them with real output.

- every import is `import type`, except `node:` builtins, which do resolve
- relative imports carry an explicit `.ts` extension
- no `enum`, `namespace`, parameter properties, or decorators

**Executing a module in-container proves its RUNTIME behaviour and says nothing about the TYPE
layer.** P1-5c shipped a module that ran correctly under both strip-types and vitest and then failed
`tsc -b` with three errors, because the app tsconfig's `types` array excluded what it needed. Do not
report Part A as "verified" without that qualifier.

**§7's Part B cannot be compiled here.** It is author-only. Say so plainly.

### 2.2 Delivery: by OPERATION, not by file

- **A NEW file** → one `device_bash` heredoc:
  ```bash
  cat > "$HOME/mnt/production_scheduler/<path>" <<'ENDOFFILE'
  ...file content...
  ENDOFFILE
  ```
- **An EDIT to an existing file** → a targeted in-place `python3` read-modify-write over
  `device_bash`: read it, `assert old in s`, replace, write. **Do not read a whole file into context
  and retype it with your change applied.** The previous brief did that for eight files and cost
  370k against the previous brief's 243k for twice the assertions. The `assert` is your integrity
  check; you do not need to md5-verify a transcription you never made.
- **Never** a tarball, `SendUserFile`, or base64.

Iterate in `/tmp` **inside your own container** first — that is free — and write to the repo only
when a file is finished.

Three mount hazards:

- **`device_bash` cannot delete or move files.** Scratch stays in `/tmp` in your own container. If
  you strand one in the repo, report its full path.
- **Do not run `git` at all.** Every git command leaves a `.git/index.lock` you cannot remove.
- Files may land read-only; `chmod u+w <path>` before editing one in place.

After writing each file, verify with `wc -l` and `md5sum` and report both.

---

## 3. What you are building

| Path | Kind | Verified? |
| --- | --- | --- |
| `src/features/admin/lib/levelDraft.ts` | new — pure level-draft reducer (§4.1) | **yes, by you, in-container** |
| `src/features/admin/lib/treeView.ts` | new — pure tree rows + legal parents (§4.2) | **yes, by you** |
| `src/features/admin/lib/errorText.ts` | new — the six codes as sentences (§4.3) | **yes, by you** |
| `src/test/levelDraft.test.ts` | new — vitest, §8 group L | authored; the maintainer runs |
| `src/test/treeView.test.ts` | new — vitest, §8 groups T and P | authored; the maintainer runs |
| `src/test/errorText.test.ts` | new — vitest, §8 group E | authored; the maintainer runs |
| `src/features/admin/AdminPage.tsx` | **edit** — becomes the sectioned shell (§7.1) | no — author-only |
| `src/features/admin/AdminPage.module.css` | new | no |
| `src/features/admin/components/LevelEditor.tsx` + `.module.css` | new (§7.2) | no |
| `src/features/admin/components/NodeTreeEditor.tsx` + `.module.css` | new (§7.3) | no |
| `src/features/admin/components/AdminPopover.tsx` + `.module.css` | new (§7.4) | no |
| `src/routes.tsx` | **edit** — lazy-load `/admin` (§7.5) | no |
| `docs/roadmap.md` | **edit** — final step, §12 | n/a |

**The three `.test.ts` files are deliverables, not scratch.** A suite that runs once in your
container guards nothing: P1-5b specified 76 assertions, never named a repo path for them, and the
module shipped with no regression test while CI reported green. Every pure module in `src/` has a
peer in `src/test/`.

---

## 4. Part A — three pure modules

All `import type` only. `treeView.ts` imports from `hierarchy.ts` — **type-only for the types, and
`canDropOn`/`buildHierarchyTree` as real value imports via a relative `./hierarchy.ts` path**, which
strip-types resolves because it is a relative path with an explicit extension.

### 4.1 `levelDraft.ts`

```ts
export interface LevelDraft { id: string | null; name: string; isSchedulable: boolean }
export type LevelAction =
  | { kind: "rename"; index: number; name: string }
  | { kind: "moveUp"; index: number }
  | { kind: "moveDown"; index: number }
  | { kind: "add" }
  | { kind: "remove"; index: number }
  | { kind: "setSchedulable"; index: number };
export const MAX_LEVELS = 64;
export function applyLevelAction(draft: readonly LevelDraft[], action: LevelAction): readonly LevelDraft[];
export function invalidNameIndices(draft: readonly LevelDraft[]): number[];
```

`save_hierarchy_levels` takes the whole ordered array and **the array index IS the position** (D70),
so "positions must be contiguous" is not a rule this editor enforces — a payload cannot express a
gap. Every action is an array edit.

Rules, all load-bearing:

- **Never mutate the input.** The editor keeps the original for Cancel, and React needs a new
  reference. Clone the row OBJECTS too, not just the array (§9's M5).
- **An inapplicable action returns the SAME array reference**, so a caller can detect a no-op
  cheaply and React bails out. Inapplicable means: index out of range, index not an integer,
  `moveUp` at 0, `moveDown` at the end, `rename` to the current value, `add` at `MAX_LEVELS`,
  `remove` when only one row is left, `setSchedulable` on the row that is already the only one.
- **`remove` refuses to empty the list.** `save_hierarchy_levels` rejects an empty array, so an
  editor that let you empty it could only offer a Save that always fails.
- **Removing the schedulable level leaves NONE, and that is deliberate.** Do not auto-promote
  another row. Silently choosing where all scheduled work lives (D72) is the single most
  consequential decision in this editor and it is not yours to make. `validateLevelDraft` reports
  `schedulable_count` and Save stays disabled until the user picks.
- **`setSchedulable` is radio semantics enforced in the reducer**, not by the markup: it sets one
  and clears every other.
- `invalidNameIndices` says WHERE to put error styling. `validateLevelDraft` (P1-5b) remains the
  authority on WHETHER the draft is valid. It must tolerate a malformed row rather than throw.

### 4.2 `treeView.ts`

```ts
export interface TreeRow { node: NodeRow; depth: number; hasChildren: boolean; collapsed: boolean }
export interface ParentChoice { id: string | null; label: string }
export const ROOT_LABEL = "(root)";
export function flattenTree(tree: readonly TreeNode[], collapsedIds: ReadonlySet<string>): TreeRow[];
export function legalParentsFor(nodeId: string, nodes: readonly NodeRow[], levels: readonly LevelRow[]): ParentChoice[];
export function buildTreeRows(nodes: NodeRow[], levels: LevelRow[], collapsedIds: ReadonlySet<string>): TreeRow[];
```

- `flattenTree` is a depth-first flatten that **skips the descendants of a collapsed node**. A flat
  list is what makes the tree keyboard-navigable (up/down is index ±1). `collapsedIds` is a Set, so
  an unknown id simply means "expanded" — there is no lookup table to keep in sync with the node
  list, which is what stops a stale collapse state from hiding rows after a refetch.
- **`legalParentsFor` is built by asking `canDropOn` about every candidate.** Do not reimplement the
  rules. There is one implementation of "is this legal" and it will shortly have three consumers —
  this picker, P1-5e's drag preview, and the server.
- **A `noop` result is excluded.** Dropping onto the current parent is accepted by the server and
  does nothing; offering "move to where it already is" is noise, not an error.
- Sort by label so the picker is stable between renders.
- **`(root)` needs no special-casing and cannot have any.** A root move requires the node's level
  position to be 0; a move under a node requires the target's position to be one *less* than the
  node's, i.e. −1, which no level has. So `(root)` is either the only entry or absent. §8's P8
  proves it. An earlier draft of this module sorted `(root)` explicitly to the front; that branch
  was unreachable for any list longer than one, and an unreachable branch is one no mutation can
  catch.

### 4.3 `errorText.ts`

```ts
export const HIERARCHY_ERROR_CODES = [...] as const;   // the six from D74
export type HierarchyErrorCode = (typeof HIERARCHY_ERROR_CODES)[number];
export const FALLBACK_MESSAGE: string;
export function hierarchyErrorMessage(code: string | null | undefined): string;
```

The six codes are a **closed set** (D74) and every one is reachable by ordinary use of these two
editors, so every one needs a sentence. Without this, `path_collision` reaches the user as
`path_collision`.

- **Never throws, never returns empty.** An unrecognised code — one added server-side before this
  map catches up — still yields something a person can read. Same rule as the `SchedulerError`
  parser.
- The wording is yours to draft; §8's E-group only requires that all six are present, distinct,
  non-trivial, and never the raw code. **the maintainer will edit the copy; write it so that is a one-line
  change per message.**
- This lives with the screens, not in `src/lib/api/`: that layer owns the error *contract*, this is
  presentation.

---

## 5. The authority rule

**The database is authoritative for every rule these screens preview.** The client copies exist so
the UI can grey out an illegal move and show inline validation before a round trip. Every write goes
through one of the five RPCs, and the RPC's answer always wins.

The invariant is one-way: **anything the client rejects, the server must also reject.** The reverse
does not hold, deliberately — the client cannot see `level_in_use`, `node_in_use` or
`schedulable_level_locked`, because all three need server-side row counts.

**A direct consequence you must build for, not around: some actions will fail on Save rather than
being disabled in advance.** Removing a level that still has nodes, deleting a node with children or
scheduled work, moving the schedulable level while work exists — all are refused by the server and
cannot be predicted here. **Do not disable those controls speculatively, and do not pre-fetch counts
to try.** Surface the error inline, keep the user's draft intact, and let them fix it. §4.3 is why
that error is readable.

---

## 6. Decisions already made

### 6.1 `/admin` is a page with sections, not a stack of modals

It currently holds four words. It will grow to hold Hierarchy, Shifts, Operators, Products and
Import. Build the shell now: a section nav (left rail or tabs — your call, say which and why) with
**Hierarchy** populated and the other four present as visibly disabled "coming in a later brief"
placeholders. The placeholders are not filler: they are what makes the information architecture
legible to the person reviewing this, and they cost four lines each.

### 6.2 Re-parenting is a picker in this brief

Every node row gets a `⋮` menu: **Rename**, **Add child**, **Move to…**, **Delete**. "Move to…"
opens a picker listing exactly `legalParentsFor`'s result. Illegal targets never appear, so there is
nothing to explain and nothing to grey out.

Drag lands in P1-5e on the same `canDropOn` call. Building the picker first is not a compromise —
it is the keyboard-accessible path, and it means drag arrives as a pure interaction layer over a
data path that already works.

### 6.3 Three debts P1-5b left, which land here

1. **`hierarchyKeys.all = ["hierarchy"]`** was invented by P1-5b for a read hook that did not exist
   yet. You are writing that read hook. **Confirm the convention or override it deliberately, and
   say which in your report.**
2. **Always pass `canDropOn` the COMPLETE level array.** A partial one makes the client reject a
   move the server would accept — the forbidden direction of §5's invariant.
3. **`create_node`'s `level_mismatch` DETAIL carries the PARENT's id under the key `node_id`**,
   because the node being created has no id yet. Do not assume that field identifies the subject of
   the error.

### 6.4 Delete offers both modes

`delete_node(mode)` is `'deactivate' | 'delete'` (D73). The confirm step offers both, with
deactivate as the default and safer choice, and says what each does: deactivate cascades to the
whole subtree; delete is refused the moment the node has children, runs or assignments.

---

## 7. Part B — the React (author-only, not compilable here)

### 7.1 `AdminPage.tsx`

The sectioned shell of §6.1. Reads levels and nodes once, at this level, and passes them down —
both editors need both (the tree needs levels for `canDropOn`; the level editor needs nodes for
nothing, but the shell needs one loading state).

### 7.2 `LevelEditor.tsx`

An ordered list over the `LevelDraft[]` state, one row per level: name input, ↑/↓ buttons, a
**radio** for schedulable, `×` to remove. `+ add level` below. `Cancel` restores the server state;
`Save` calls `saveHierarchyLevels` with the whole array.

Save is disabled while `validateLevelDraft` is not ok, with the reason shown inline; rows in
`invalidNameIndices` get the error styling. The mockup's `#shiftModal` is the visual reference.

### 7.3 `NodeTreeEditor.tsx`

Rows from `buildTreeRows`. Disclosure triangle where `hasChildren`; indent by `depth`. The `⋮` menu
of §6.2. Collapse state is component state keyed by node id — a `Set<string>`, per §4.2.

### 7.4 `AdminPopover.tsx`

The Move-to picker, the delete confirm and the rename field need a popover. **`BoardPopover` lives
in `src/features/board/` and `docs/conventions.md` forbids cross-feature imports** (`src/features/auth/`
is the only named exception). So this feature gets its own.

**Reuse the mechanism, not the file.** `BoardPopover` was fixed in P1-5c and the fix is
non-obvious — read it and carry it over: CSS owns the width, `useLayoutEffect` +
`getBoundingClientRect()` measures the rendered box, the measured numbers feed
`resolvePopoverPlacement` (`src/features/board/lib/placement.ts`) for the edge clamp, and **the
viewport is state behind a `window` resize listener**, because `--chrome-scale` is pinned flat at
1.0 below 1440px and a `ResizeObserver` alone therefore never fires on an ordinary laptop. Both
effects need a change-guard or they re-render forever.

`resolvePopoverPlacement` is pure geometry in `board/lib/`. **Importing it would breach the
convention; duplicating it would breach §5's spirit.** Flag this in your report and say which you
did — this is a real collision between two rules and I would rather see your reasoning than
pre-empt it. (If it helps: a shared `src/lib/` home is the obvious third option.)

### 7.5 `routes.tsx` — lazy-load `/admin`

`/admin` grows substantially here and is the natural first `React.lazy` split; the roadmap has said
so since Aug 24. Wrap the `/admin` element in `React.lazy` + `Suspense` with a minimal fallback.

**You cannot measure the result** — no npm. Say so, and state in your report what you expect to
happen to the bundle so the maintainer's build output can confirm or refute it. The current app chunk is
100.38 kB raw / 30.20 kB gzipped.

---

## 8. Acceptance — 47 assertions, all of which pass against a reference implementation

**Table-driven** where the cases are uniform. **Every assertion inside try/catch**, and your mutation
runner must treat **non-zero exit with zero failures** as CRASHED, distinct from passing.

| group | count | covers |
| --- | --- | --- |
| **L1–L20** | 20 | rename; moveUp/moveDown; **both no-op-at-the-boundary cases return the SAME REFERENCE (L4, L5)**; add appends a blank non-schedulable row; remove; **removing the schedulable level leaves NONE (L8)**; **remove refuses to empty (L9)**; radio semantics (L10); **the 64 cap is `>` not `>=` (L12, L13)**; **PROPERTY: input never mutated (L14)**; **PROPERTY: row objects cloned, not shared (L15)**; rename-to-same is a no-op; out-of-range and **non-integer** indices are no-ops (L17, L18); `invalidNameIndices` on blank/whitespace, and **on a malformed row without throwing (L20)** |
| **T1–T10** | 10 | depth-first order; depths; `hasChildren`; **collapsing hides the whole subtree (T4)**; the collapsed flag; collapsing a leaf changes nothing; an unknown collapsed id is ignored; **collapsing the root leaves just the root (T8)**; empty tree; **PROPERTY: no mutation** |
| **P2–P12** | 11 | a Cell's legal parents; a Line may move under the other Department; a Department with no options; the root node; an unknown node; a second candidate appearing; **PROPERTY: `(root)` never co-occurs with node parents, at any level (P8)**; a level-0 non-root CAN move to `(root)` (P9); choices carry the id, not just the label; **PROPERTY: no mutation**; **two legal parents come back SORTED (P12)** |
| **E1–E6** | 6 | every code has its own message; **all six are distinct (E2)**; **the closed set is exactly D74's six (E3)**; an unknown code falls back; **null/undefined/non-string never throw (E5)**; **no message is trivial or leaks the raw code (E6)** |

The bolded ones exist because they are the only case separating two plausible implementations, or
because a mutation slipped past everything else.

**P12 is not decoration.** Every other P case yields 0 or 1 entries, so without a two-choice fixture
the sort is untestable and deleting it breaks nothing. Build the fixture with the candidates
inserted in an order that is *not* the sorted one.

**L4 and L5 assert reference identity (`===`), not deep equality.** The no-op contract is what lets
the editor skip a re-render; a version that returns a fresh equal array passes a deep-equality
check and fails the contract.

---

## 9. Mutations — all 17 were executed against a reference implementation

Each applied on its own, whole suite re-run, then restored. **These mappings are recorded
observations.** Apply each to *your* implementation, confirm the named case fails, restore. Mutate a
copy in `/tmp`, never the delivered file.

**If a mutation does not break its named case in your build, that is a finding — report it.**

| # | Mutation | Must fail | Also fails |
| --- | --- | --- | --- |
| M1 | the add cap uses `>` instead of `>=` | **L12** | — |
| M2 | `remove` is allowed to empty the list | **L9** | — |
| M3 | `remove` auto-promotes a new schedulable level | **L8** | — |
| M4 | `setSchedulable` does not clear the others | **L10** | — |
| M5 | `clone()` is shallow (`[...draft]`) | **L15** | — |
| M6 | `moveUp` drops its index-0 guard | **L4** | — |
| M7 | `inRange` drops the `Number.isInteger` check | **L18** | — |
| M8 | `invalidNameIndices` drops its null guard | **L20** | — |
| M9 | `flattenTree` recurses into collapsed nodes | **T4** | T8 |
| M10 | `hasChildren` is always true | **T3** | — |
| M11 | `legalParentsFor` keeps `noop` choices | **P2** | P3, P4, P7, P10, P12 |
| M12 | `legalParentsFor` omits the `(root)` candidate | **P9** | — |
| M13 | the sort is removed | **P12** | — |
| M14 | an unknown code returns the code itself | **E4** | — |
| M15 | two codes share one message | **E2** | — |
| M16 | a code is dropped from the closed set | **E2** | E3 |
| M17 | a message is just the raw code | **E6** | — |

M11 is over-broad by design — it names P2 as primary and the rest is collateral, so a later reader
does not think those five cases are *about* the `noop` exclusion.

---

## 10. Traps, all hit for real while writing this brief

1. **An unreachable branch is one no mutation can catch.** The `(root)`-sorts-first special case in
   the first draft of `legalParentsFor` could never fire. If you find yourself writing a branch you
   cannot construct a failing input for, delete it and say so.
2. **A one-element result set makes a sort untestable.** Hence P12.
3. **Reference identity is part of the no-op contract.** Hence `===` in L4/L5.
4. **A fixture's `path` must be slug-consistent with its `name`**, because the database derives one
   from the other. A hand-written path made a P1-5b mutation invisible.
5. **`--chrome-scale` is pinned flat at 1.0 below 1440px.** §7.4 — a `ResizeObserver` alone does not
   see a viewport change on an ordinary laptop.
6. **`measure → setState → render` needs a change-guard** or it never settles. Same family as the
   §19.6 fit-loop oscillation.
7. **The seed now has TWO orgs** (§19.15). If you exercise anything against the database, org 1 is
   Northwind. Org 2's node paths are deliberately identical to org 1's — that is a fixture, not a
   bug, and `Cell Z` belongs to org 2.
8. **The seed is anchored to the week it was run.** Irrelevant to every case here, but do not "fix"
   a board that looks empty.

---

## 11. Report

1. Part A: your harness output for all three modules, every §8 assertion with PASS/FAIL, and your
   own total. If it is not 47, say which group differs and why.
2. The 17 mutations: which case actually failed for each, and **flag any that broke nothing or
   crashed**.
3. `wc -l` and `md5sum` for every file you wrote.
4. **Which generated or third-party artifacts does your Part B code depend on, and what does each
   one actually say — quote the line.** Do not predict what a compiler would say; open the file and
   quote it. **And where the thing you quote is an expression — a `clamp()`, a media query, a
   breakpoint — evaluate it across the range this app runs in and say where it stops changing.**
   Quoting `--chrome-scale`'s definition correctly and still getting its behaviour wrong is what
   cost the previous brief a defect. At minimum: the `React.lazy`/`Suspense` signatures, the
   `useHierarchyMutations` hook signatures you call, and the current props of anything you edit.
5. Explicitly: that Part B was never compiled, what you expect `tsc`/`eslint` to complain about, and
   **what you expect to happen to the bundle** from §7.5.
6. **Your assumptions and deviations** — the highest-signal part. Say what you did about §7.4's
   `resolvePopoverPlacement` collision and about §6.3's query-key convention. Assume this brief has
   at least one error and tell me what it is.
7. Anything left undone and why.

---

## 12. Scope fence — properties, not a file list

- **No drag-and-drop** (P1-5e) and **no CSV import** (P1-5f).
- **No reimplementation of the tree rules.** `canDropOn`, `validateLevelDraft`, `buildHierarchyTree`
  and `slugify` are P1-5b's and are authoritative. If you need a rule they do not express, that is a
  finding, not a licence to write a second copy.
- **No client-side check with no server counterpart**, and **no pre-fetching row counts** to
  pre-empt `level_in_use` / `node_in_use` / `schedulable_level_locked` (§5).
- **No new write path.** Every write goes through the five RPCs via `useHierarchyMutations`.
- **No changes to `supabase/`, to any migration, or to `src/features/board/`.** In particular **do
  not touch the tenant-scope predicates in migration 0012** — see §19.15.
- **No optimistic updates.** Invalidate and refetch; a move re-paths a whole subtree.
- **No `package.json` change.**

If a requirement here collides with this fence — and §7.4 contains one on purpose — breach it
deliberately and say so in §11 item 6.

---

## 13. Final step

Update `docs/roadmap.md`: mark P1-5d built with your actual numbers and add the new files to the
artifact index. **Do not** mark the browser acceptance done — that is the maintainer's, and it is the only
thing that can confirm §7.
