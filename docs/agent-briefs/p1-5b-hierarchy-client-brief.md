# Brief P1-5b — hierarchy client layer (typed API + pure lib)

**You are a build agent.** Every decision here is already made. Where something is left to you it
says so. **If you find an error in this brief, flag it in your report** — every previous brief on
this project contained at least one real one, and the deviations list is the most valuable part of
what you write.

**This brief ships NO React.** The admin screens are P1-5c. If you find yourself designing UI, stop.

**Read §2.2 before you write a single file.** The previous brief in this series cost 329k tokens and
roughly a third of that was spent moving finished files around. §2.2 is how that does not happen again.

---

## 1. Read these first

| File | Why |
| --- | --- |
| `docs/design-plan.md` **§19** (all of it, incl. §19.5) | D67–D76: what migration 0010 enforces and why. §19.5 records three defects found *after* delivery — read them, they shape §5. |
| `supabase/migrations/20260825000010_hierarchy_admin.sql` | The five RPCs you are wrapping. Their validation ORDER is part of the contract you mirror. |
| `supabase/migrations/20260821000001_extensions_and_core.sql` | `slugify()` — **the authoritative implementation**. Yours must match it (§6). |
| `src/lib/api/` — all of it | `shapes.ts`, `errors.ts`, `serde.ts`, `mutations.ts`, `index.ts`. You are extending an existing, working layer; copy its shape exactly. |
| `docs/api-client.md` | The client contract: `SchedulerError`, the parser that must never throw, the serde boundary. |
| `docs/conventions.md` | Feature-first layout; `src/lib/api/` is the only place that touches `supabase.rpc`, snake_case, or `database.types.ts`. |

---

## 2. Environment

Cowork cloud container. **No Docker, no npm/pip/apt network.** Do not attempt `supabase start` or
any install. Available without installing anything: PostgreSQL 16 at `/usr/lib/postgresql/16/bin/`,
Node v22, Chromium at `/opt/pw-browsers`.

### 2.1 Part A runs; Part B does not

`node --experimental-strip-types file.ts` executes TypeScript by erasing annotations. **§4's module
is therefore mandatory-executable** — you will run it and mutation-test it with real reported output.
Constraints it must satisfy, all load-bearing:

- every import is `import type` (a value import needs resolution strip-types does not do, and the
  `@/` alias never resolves)
- relative imports carry an explicit `.ts` extension
- no `enum`, `namespace`, parameter properties, or decorators — strip-types erases, it does not transform

**§7's Part B cannot be compiled here** (it imports React Query and `database.types.ts`). It is
author-only. Say so plainly in your report rather than implying it was verified.

### 2.2 Delivery: write files directly. No tarball. No `SendUserFile`.

Author each file straight into the repo with a `device_bash` heredoc:

```bash
cat > "$HOME/mnt/production_scheduler/<path>" <<'ENDOFFILE'
...file content...
ENDOFFILE
```

**Do not build a tarball, do not call `SendUserFile`, do not base64 anything.** On the previous brief
`SendUserFile` became unavailable mid-run and the fallback was a chunked base64 transfer with
per-chunk checksums — ~94KB of source became ~125KB of base64, each chunk appearing twice in context
(command and echoed result). Writing directly costs one pass and cannot fail that way.

Two mount hazards that still apply:

- **`device_bash` cannot delete or move files** (`unlink` is not permitted). Keep every scratch file
  in `/tmp` **inside your own container**, never under the repo. If you strand one anyway, report its
  full path so Pratik can remove it.
- **Do not run `git` at all.** Every git command through `device_bash` leaves a `.git/index.lock` you
  cannot remove, which then warns on all of Pratik's git commands. Do not commit or push.

After writing each file, verify it with `wc -l` and `md5sum` and report both.

---

## 3. What you are building

| Path | Kind | Verified? |
| --- | --- | --- |
| `src/features/admin/lib/hierarchy.ts` | new — the pure module (§4) | **yes, by you, in-container** |
| `src/lib/api/hierarchy.ts` | new — five typed RPC wrappers (§7) | no — author-only |
| `src/lib/api/errors.ts` | edit — six error codes into the union + parser (§7.1) | no |
| `src/lib/api/index.ts` | edit — re-export the new wrappers | no |
| `src/features/admin/hooks/useHierarchyMutations.ts` | new — React Query hooks (§7.3) | no |
| `docs/api-client.md` | edit — document the additions | n/a |
| `docs/roadmap.md` | edit — final step, §11 | n/a |

---

## 4. Part A — `src/features/admin/lib/hierarchy.ts`

Pure, dependency-free, `import type` only. Exports exactly these.

```ts
export interface LevelRow  { id: string; position: number; name: string; isSchedulable: boolean }
export interface NodeRow   { id: string; name: string; path: string; parentId: string | null;
                             levelId: string; sortOrder: number; active: boolean }
export interface TreeNode  { node: NodeRow; depth: number; children: TreeNode[] }
export interface LevelDraft { id: string | null; name: string; isSchedulable: boolean }
```

**`slugify(input: string): string`** — lowercase; collapse every run of characters outside `[a-z0-9]`
into a single `_`; trim leading and trailing `_`; if the result is empty return `"n_"`; if it starts
with a digit prefix `"n_"`. §6 is the contract.

**`pathDepth(path: string): number`** — label count. `""` → 0, `"a"` → 1, `"a.b.c"` → 3.

**`prospectivePath(parentPath: string | null, name: string): string`** — the path a node would get.
A `null` **or empty** parent path yields the bare slug.

**`buildHierarchyTree(nodes: NodeRow[], levels: LevelRow[]): TreeNode[]`** — nested tree, roots first.

- **Parent linkage comes from `path`, never from `parentId`.** A node whose path-parent is absent
  from the input becomes a root (this is what makes a mid-tree slice render correctly).
- `depth` is `pathDepth(path) - 1`, so a root is 0.
- Siblings sort by `sortOrder`, then `name`, then `id`. **The `id` tie-break is required** — the order
  must be total, or the tree reshuffles between renders on equal keys.

**`canDropOn(draggedId, targetParentId, nodes, levels)`** → `{ ok: true; noop: boolean }` or
`{ ok: false; reason: string }`. **Mirror `move_node`'s checks in the same order**, so the reason the
UI previews is the reason the server would give:

1. dragged node unknown, or its level id absent from `levels` → `"invalid_argument"`
2. `targetParentId === null`: allowed only when the node's level position is 0, else
   `"level_mismatch"`; then still check collision
3. `targetParentId === draggedId` → `"node_cycle"`
4. target unknown → `"invalid_argument"`
5. **target is the node or one of its descendants → `"node_cycle"`**
6. node's level position is not target's + 1 → `"level_mismatch"`
7. another node already holds `prospectivePath(target.path, dragged.name)` → `"path_collision"`

**5 must precede 6** — every move beneath one's own descendant also skips a level, so with the order
reversed a genuine cycle reports `level_mismatch` (design plan §19.6 / §6.4 of the P1-5a brief).

`noop` is `true` when the drop would not change anything (`dragged.parentId === targetParentId`).
It is **not** a rejection — the server accepts a same-parent move and does nothing. Keeping it out of
the rejection set is what preserves §5's subset invariant.

**`validateLevelDraft(draft: LevelDraft[])`** → `{ ok: true }` or `{ ok: false; reason: string }`,
mirroring `save_hierarchy_levels`' order: not an array → `"not_an_array"`; empty → `"empty"`;
more than 64 → `"too_many"`; schedulable count ≠ 1 → `"schedulable_count"`; any blank/whitespace name
→ `"blank_name"`.

---

## 5. The authority rule (brief-writing rule 4)

**The database is authoritative for every rule in §4. Without exception.** These client copies exist
only so the admin UI can grey out an illegal drop target and show inline validation before a round
trip. Every write still goes through the RPC, and the RPC's answer always wins.

**The invariant that keeps them honest: anything the client REJECTS, the server must also reject.**
The reverse does not hold, and deliberately so — the client cannot see `level_in_use` or
`schedulable_level_locked` (both need server-side row counts), and it may be looking at a stale node
list. So:

- `validateLevelDraft` checks **four** of `save_hierarchy_levels`' eight validations. It must never
  claim a draft is invalid for a reason the server would accept.
- The UI must still surface the RPC's error even when the client said "ok". Never let a client-side
  check suppress a server error.
- **Do not add a client-side check that has no server counterpart.** If you think one is needed, say
  so in your report rather than adding it.

---

## 6. `slugify` parity — the corpus IS the contract

`slugify` is duplicated logic, knowingly. This corpus is what stops the two drifting. **Every
expectation below was produced by running the SQL `slugify()` from migration 0001 against a scratch
PostgreSQL 16** — they are observations, not predictions.

| input | expected | | input | expected |
| --- | --- | --- | --- | --- |
| `Cell 1` | `cell_1` | | `_lead_` | `lead` |
| `Cell-1` | `cell_1` | | `  padded  ` | `padded` |
| `CNC Line` | `cnc_line` | | `Multi   Space` | `multi_space` |
| `3 × 8h` | `n_3_8h` | | `dash-dash--dash` | `dash_dash_dash` |
| `  ` | `n_` | | `dot.dot` | `dot_dot` |
| `2nd Shift` | `n_2nd_shift` | | `slash/slash` | `slash_slash` |
| `Plant 1` | `plant_1` | | `paren(1)` | `paren_1` |
| `Assembly` | `assembly` | | `100%` | `n_100` |
| `Line 2` | `line_2` | | `#4` | `n_4` |
| `Work Cell` | `work_cell` | | `4#` | `n_4` |
| `` (empty) | `n_` | | `9` | `n_9` |
| `___` | `n_` | | `0900 shift` | `n_0900_shift` |
| `A` | `a` | | `Ω` | `n_` |
| `a` | `a` | | `emoji 🙂 here` | `emoji_here` |
| `ÀÉÎÕÜ` | `n_` | | `tab\tsep` (tab) | `tab_sep` |
| `Ünïcödé Zoné` | `n_c_d_zon` | | `new\nline` (newline) | `new_line` |
| `cell__1` | `cell_1` | | | |

**The two that will catch a plausible-looking wrong implementation:**

- `ÀÉÎÕÜ` → `n_`, **not** `aeiou`. Postgres does not transliterate. An implementation that reaches
  for `.normalize("NFD").replace(/[̀-ͯ]/g, "")` to "handle accents" is wrong, and it is the
  first thing a reasonable person writes.
- `Ünïcödé Zoné` → `n_c_d_zon`. The leading `n` is the letter from "ünïcödé", not the `n_` empty
  prefix. Getting this right falls out of doing the simple thing.

All 33 rows must be assertions in your suite.

---

## 7. Part B — the typed API layer (author-only, not compilable here)

### 7.1 Six error codes

Add to `SchedulerError`'s union and its parser, following exactly what the existing codes do:
`path_collision`, `node_cycle`, `level_mismatch`, `level_in_use`, `node_in_use`,
`schedulable_level_locked`.

**The parser must never throw** — that rule already exists in `errors.ts` and applies unchanged. An
unrecognised code must still yield a usable `SchedulerError`, not an exception.

Carry each code's `DETAIL` payload through as typed fields. Migration 0010 is the source of truth for
which keys each raise carries — read it, do not guess.

### 7.2 Five wrappers — `src/lib/api/hierarchy.ts`

`saveHierarchyLevels`, `createNode`, `renameNode`, `moveNode`, `deleteNode`. Same shape as the
existing wrappers in `mutations.ts`: camelCase in and out, snake_case confined to this file, RPC
argument names exactly as the migration declares them (PostgREST binds by name).

`deleteNode`'s mode is `"deactivate" | "delete"` — a union type, not `string`.

### 7.3 Hooks — `src/features/admin/hooks/useHierarchyMutations.ts`

React Query mutations wrapping §7.2. Invalidate whatever query key the admin tree will read.

**No optimistic updates in this brief.** A node move changes the paths of an entire subtree, and
reproducing that trigger cascade client-side is exactly the duplicated logic §5 forbids. Invalidate
and refetch. If that turns out to feel slow in P1-5c, it becomes a decision then.

---

## 8. Acceptance — the group table below is AUTHORITATIVE (it sums to 76 assertions)

> **Count correction, 2026-08-25 (design session).** This section shipped headlined "74 assertions";
> the group table sums to **76**. The table is right and the headline was stale — T10b, D15 and D16
> were added after the total was written. **Implement and report against the group table, not against
> any total.** Report your own count; if it is not 76, say which group differs and why — a mismatch is
> a finding about this brief, not a defect in your work.

**Your suite must be table-driven.** A case is a row in a table the harness loops over, not a
copy-pasted block. The reference suite is ~200 lines for ~75 assertions; the previous brief's SQL
suite was 1,453 lines for 43 cases, and that difference is real tokens.

**Every assertion must be evaluated inside a try/catch** — see §10's trap. A harness helper of this
shape is enough:

```ts
function check(name: string, got: unknown | (() => unknown), want: unknown): void
```

where a thunk is called inside `try`, and a throw is recorded as a named failure rather than
aborting the file.

| group | count | covers |
| --- | --- | --- |
| **S1–S33** | 33 | the §6 corpus, one assertion per row |
| **T1–T11** | 13 | one root; root depth 0; sibling order; grandchildren; leaf depth; `pathDepth` on `""`/`"a"`/`"a.b.c"`; a mid-tree slice roots at its shallowest node; empty input; total order when `sortOrder` AND `name` tie; **`parentId` and `path` disagreeing (T10/T10b)**; **`sortOrder` and `name` disagreeing (T11)** |
| **P1–P4** | 4 | under a parent; at the root; empty-string parent behaves as root; a name that collides on slug |
| **D1–D16** | 17 | legal same-depth move; no-op onto current parent; onto itself; beneath own descendant; level skip; onto a deeper node; cross-subtree legal; unknown dragged; unknown target; non-root to `null` parent; root to `null` parent is a no-op; destination already holds the slug; **a cycle that also skips a level reports `node_cycle` (D13)**; unknown level id; **PROPERTY: inputs are not mutated (D15)**; **a sibling whose path is a prefix without a dot boundary (D16)** |
| **V1–V9** | 9 | happy; empty; zero schedulable; two schedulable; blank name; 65 levels; **exactly 64 is fine (V7)**; **`too_many` precedes `schedulable_count` (V8)**; **`schedulable_count` precedes `blank_name` (V9)** |

The bolded ones exist because a mutation slipped past everything else. Do not drop them for looking
redundant — three of them were added *after* the table below was executed and found holes.

**T10/T10b and T11 need fixtures where the two signals disagree.** A tree fixture copied from the seed
has `parentId` consistent with `path` and `sortOrder` consistent with `name`, so it cannot see either
mutation. Build them deliberately: a node with a deliberately wrong `parentId` but a correct `path`,
and siblings named "Zulu" (sortOrder 0) and "Alpha" (sortOrder 1).

**D16 needs `line_10` alongside `line_1`.** Correct answer is `level_mismatch` (both at the same
level); a descendant test missing the dot separator answers `node_cycle`.

---

## 9. Mutations — all 12 were executed against a reference implementation

Each was applied on its own and the whole suite re-run. **These mappings are recorded observations.**
Apply each to *your* implementation, confirm the named case fails, restore. Mutate a copy in `/tmp`,
never the delivered file.

**If a mutation does not break its named case in your build, that is a finding — report it.** Three of
these caught nothing on the first pass here, which is why T10/T11/D16 exist.

| # | Mutation | Must fail |
| --- | --- | --- |
| M1 | `slugify` strips accents via `normalize("NFD")` before lowercasing | S(`ÀÉÎÕÜ`), S(`Ünïcödé Zoné`) |
| M2 | `slugify` drops the leading-digit `n_` prefix | 7 S rows |
| M3 | `slugify` replaces single chars instead of collapsing runs (`+` dropped from the regex) | 6 S rows |
| M4 | `slugify` trims only leading underscores | 6 S rows |
| M5 | `slugify` returns `""` instead of `"n_"` for empty | 5 S rows |
| M6 | `buildHierarchyTree` links by `parentId` instead of `path` | **T10, T10b** |
| M7 | `buildHierarchyTree` ignores `sortOrder` | **T11** |
| M8 | `canDropOn` checks level adjacency before the cycle | D4, D6, **D13** |
| M9 | `canDropOn`'s descendant test omits the `.` separator | **D16** |
| M10 | `canDropOn`'s collision check forgets to exclude the node itself | D2 |
| M11 | `validateLevelDraft` checks `blank_name` before `schedulable_count` | **V9** |
| M12 | `validateLevelDraft` caps at `>= 64` instead of `> 64` | **V7** |

---

## 10. Traps, all hit for real while writing this brief

1. **A mutation can CRASH your harness instead of failing a case, and a naive runner scores that as
   "not caught".** M6 changes the shape of the tree, so an assertion that indexes into it throws; the
   uncaught throw aborts the file, no `FAIL` line is printed, and every later case silently never
   runs. Two defences, use both: evaluate assertions inside try/catch (§8), and make your mutation
   runner treat **non-zero exit with no failures** as CRASHED, distinct from passing.
2. **`.normalize("NFD")` is the wrong instinct for `slugify`** — §6.
3. **A sibling's path can be a string prefix of another's** — `line_10` vs `line_1`. Ancestry tests
   need the separator.
4. **Sorting must be total.** Two siblings with equal `sortOrder` and equal `name` will reorder
   between renders without an `id` tie-break.
5. **`prospectivePath` gets `""` as well as `null`** for a root parent, depending on the caller.
6. **The seed is anchored to the week it was run** — irrelevant to these cases (none depend on the
   date), but do not "fix" a board that looks empty; that is a seed anchor, not a bug.

---

## 11. Report

1. Part A: your harness output, every assertion in the §8 group table with PASS/FAIL, plus your total
2. The 12 mutations: which case actually failed for each, and **flag any that broke nothing or
   crashed**
3. `wc -l` and `md5sum` for every file you wrote
4. Explicitly: that Part B was never compiled, and what you would expect `tsc` to complain about
5. **Your assumptions and deviations** — the highest-signal part. Previous briefs contained an
   impossible acceptance case, an impossible scenario, mutations whose named case could not
   distinguish them, a scope fence that contradicted the brief's own feature, and three defects found
   only after delivery. Assume this one has at least one error and tell me what it is.
6. Anything left undone and why

---

## 12. Scope fence — properties, not a file list

- **No React, no CSS, no admin screens.** That is P1-5c.
- **No new write path.** Every write goes through one of the five RPCs from migration 0010. No new
  RPC, no direct table write, no second implementation of a rule §4 already mirrors.
- **No client-side rule without a server counterpart** (§5).
- **`src/lib/api/` stays the only place** that touches `supabase.rpc`, snake_case, or
  `database.types.ts`. `src/features/admin/lib/hierarchy.ts` imports none of them — it is pure.
- **No changes to migrations, to the board feature, or to `src/features/board/`.**
- **No `package.json` change.**

If a requirement here collides with this fence, breach it deliberately and say so in §11 item 5 —
the last brief's fence contradicted its own headline feature and the agent was right to break it.

---

## 13. Final step

Update `docs/roadmap.md`: mark P1-5b built with your actual numbers, and add the new files to the
artifact index.
