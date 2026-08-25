# P1-5f — `create_node` learns which hierarchy shape, and the admin gets a shape picker

**Status:** written by the design session, Aug 25 2026. Not yet built.
**Implements:** design plan **§19.19 (D87)** and the client half §19.18 left unbuilt.
**Depends on:** migrations 0010–0014, `src/features/admin/**`, `src/lib/api/hierarchy.ts`.
**Model:** fresh Sonnet agent. Read §2 before touching anything.

---

## 1. What this brief is for, in one paragraph

Migration 0014 (D86) gave each **site** its own hierarchy shape: `hierarchy_levels` now
belong to a named `hierarchy_templates` row, and level identity moved from
`(org_id, position)` to `(template_id, position)`. It did not move the two places
`create_node` resolves a level, so the write path still asks the old question. The
consequence is not cosmetic: **with two shapes in one org there is no way through the API
to build a tree in the second one** — the root branch has no parameter to name a shape and
the child branch fails closed. This brief adds `p_template_id` to `create_node`, scopes the
child lookup to the parent's template, and builds the screen half: a shape picker that lets
an admin choose which vocabulary they are editing, create/rename/delete shapes, and say
which shape a new root node belongs to. They are one feature seen from two sides, which is
why they are one brief.

---

## 2. Environment, and how to deliver files

Read this before writing anything. It is the same environment every P1-5 brief ran in.

### 2.1 What you can and cannot run

- **You CANNOT run `npm`.** The container's registry access is blocked by policy. Do not
  try, and do not add or change a dependency.
- **You CAN run SQL, fully.** `scripts/verify-db.sh` builds a scratch PostgreSQL 16
  database from the migrations + seed and runs every file in `supabase/tests/`. It takes
  about two minutes. **Part A(i) of this brief is entirely executable and you must execute
  it.**
- **You CAN run pure TypeScript**, via `node --experimental-strip-types file.ts`, provided
  the file has no runtime imports (`import type` is fine — it is erased). `node:` builtins
  resolve. **Part A(ii) is such a module and you must execute it.**
- **Part B is author-only.** It imports React, React Query and the Supabase client. Write
  it carefully, do not pretend you ran it, and say so in your report.

### 2.2 Delivery is specified BY OPERATION, not by file (D82 / brief-writing rule 13)

P1-5c cost 370k against P1-5b's 243k for half the assertions, entirely because it EDITED
eight files where P1-5b CREATED five, and the blanket "always heredoc" rule made every
three-line edit cost a full read-transcribe-write cycle. **This brief is mostly edits.**

- **A NEW file** → a single `device_bash` heredoc (`cat > path <<'EOF' … EOF`).
- **AN EDIT to an existing file** → a targeted in-place `python3` read-modify-write over
  `device_bash`: read the file, `assert old in s` (the assert IS your integrity check),
  `s.replace(old, new)`, write it back. This never brings the untouched parts of the file
  through your context.
- **Never** a tarball, `SendUserFile`, or base64. All three have failed here before.
- After each edit, re-read only the changed region to confirm it landed.

### 2.3 The measuring instrument is the code nobody tests

Fifteen logged instances in this project, including one on Aug 25 where the SQL harness
reported `PASS: 70_hierarchy_test.sql` while eight of that file's cases printed `FAIL`,
hiding a shipped regression that had killed `create_node` outright. `scripts/verify-db.sh`
is fixed — it now greps each file's output for `NOTICE:  FAIL` as well as reading the exit
code — but the habit is the point:

- Evaluate every assertion inside `try`/`except`; a crash is CRASHED, not "not caught".
- A mutation runner must assert its anchor string is **present and unique** and report
  `ANCHOR NOT FOUND` / `ANCHOR NOT UNIQUE` distinctly from `NOT CAUGHT`.
- **Restoring a mutated source file does not restore the database.** Rebuild before
  re-measuring.
- **When a new case passes immediately, ask whether it can fail at all.** §8.4 tells you
  exactly which of this brief's cases must fail against the unfixed build, and why most of
  them failing proves less than it looks like it does.

---

## 3. Files

Every file this brief touches, with its operation. **The two test files are named here on
purpose** (D78): P1-5b's suite ran once in a scratch container and vanished, leaving the
most thoroughly validated module in the codebase as the only one with no regression test,
while CI reported green.

| # | File | Operation | Part |
|---|---|---|---|
| F1 | `supabase/migrations/20260825000015_create_node_template.sql` | **NEW** (heredoc) | A(i) |
| F2 | `supabase/tests/90_hierarchy_template_test.sql` | **EDIT** — append 11 cases | A(i) |
| F3 | `src/features/admin/lib/shapePicker.ts` | **NEW** (heredoc) | A(ii) |
| F4 | `src/test/shapePicker.test.ts` | **NEW** (heredoc) | A(ii) |
| F5 | `src/lib/api/hierarchy.ts` | **EDIT** — 3 wrappers, `createNode`, `fetchHierarchyTree` | B |
| F6 | `src/features/admin/hooks/useHierarchyMutations.ts` | **EDIT** — 3 hooks, `CreateNodeInput` | B |
| F7 | `src/features/admin/components/ShapePicker.tsx` | **NEW** (heredoc) | B |
| F8 | `src/features/admin/components/ShapePicker.module.css` | **NEW** (heredoc) | B |
| F9 | `src/features/admin/components/LevelEditor.tsx` | **EDIT** — takes a template id | B |
| F10 | `src/features/admin/components/NodeTreeEditor.tsx` | **EDIT** — add-root gains a shape | B |
| F11 | `src/features/admin/AdminPage.tsx` | **EDIT** — holds the selection | B |
| F12 | `docs/api.md` | **EDIT** — §3.5 `create_node` signature | — |
| F13 | `docs/roadmap.md` | **EDIT** — mark P1-5f built, add your report row | — |

**Do not touch** anything under `src/features/board/`, `package.json`, or any migration
0001–0014. Migrations are append-only: anything wrong in one is fixed by a new migration.

---

## 4. The defect, measured

Read design plan §19.19 for the narrative. What follows is what the design session actually
executed against a scratch PostgreSQL 16 built from all fourteen migrations and the
two-org seed. **Assert symptoms, not diagnoses** is brief-writing rule 6; these are
symptoms, and each has a probe you can re-run.

### 4.1 The live `create_node` is in migration **0011**, not 0010

§19.19 and the memory both say "migration 0010, untouched by 0014". 0014 indeed does not
mention `create_node` — but **0011 re-created it** to route its name handling through
`app_trim_ws` (the D80 whitespace-parity fix). So:

```
0010: create function create_node(...)             <- superseded
0011: create or replace function create_node(...)  <- THIS is the live body
0014: (does not mention create_node)
```

**Extracting the body from 0010 would silently revert the whitespace fix.** Verify before
you start:

```bash
grep -c 'function create_node(' supabase/migrations/20260825000011_trim_whitespace.sql   # 1
grep -c 'create_node'           supabase/migrations/20260825000014_hierarchy_templates.sql # 0
```

The design session's programmatic extraction of 0011's body (from
`create or replace function create_node(` up to the `-- rename_node` banner comment) is
**73 lines, md5 `a94c96336a0c942fc7624908410b1119`**. If your extraction does not match
that, stop and say so rather than proceeding.

### 4.2 What the two branches do today

```sql
-- root:
select id into v_level_id from hierarchy_levels where org_id = v_org_id and position = 0;
-- child:
select id into v_level_id from hierarchy_levels
 where org_id = v_org_id and position = v_parent_position + 1;
```

Both predicates were UNIQUE until 0014. Measured, with a second shape ("Compact Plant":
Site › Line) added to org 1 alongside the seeded "Standard Plant" (Site › Department › Line
› Work Cell):

| probe | result |
|---|---|
| `create_node(NULL, 'Plant 9')` ×10 | **SUCCEEDS every time**, silently, landing in Standard Plant 10/10. No error. |
| `create_node(<compact root>, 'Line A')` | **REFUSED**, `level_mismatch`: "uses a different hierarchy template from its parent" |
| fresh org, shape A created before shape B, `create_node(NULL, …)` ×5 | 5/5 land in A; **B is unreachable** |
| after re-saving Standard's own level list, then `create_node(NULL, …)` ×5 | **0/5 Standard, 5/5 Compact — the answer flipped** |

### 4.3 Severity, stated precisely — and one correction to §19.19

§19.19 says the root branch "picked the seeded template in all three trials" and concludes
this is "unspecified behaviour that will pass testing… **not** something measured going
wrong." The first half is confirmed at n=13. **The conclusion needs correcting, and the
correction cuts both ways.**

`SELECT … INTO` over a multi-row result takes an arbitrary row, and the row it takes tracks
**physical heap order**. Re-saving the *other* shape's level list — an ordinary, supported
admin action, e.g. renaming a level — rewrites its rows and **flips which template an
unqualified root create lands in**. Measured: 5/5 Standard before, 5/5 Compact after.

So the honest statement, which is what should go in any writeup:

- It is **not a race** and not a concurrency bug. It is deterministic for a given heap
  state.
- It is **not stable either**, and "the seeded one always wins" is a coincidence of a
  freshly-loaded database, not a property.
- **The root branch writes a wrong-but-legal row with no error.** A root node at position 0
  of *any* template satisfies `nodes_check_level_adjacency` — parent is NULL, position is 0
  — so the trigger cannot catch it. The admin gets a node in the wrong shape and no
  indication.
- **The child branch fails closed** with `level_mismatch`, so the second shape cannot grow
  children either.
- **No existing row is corrupted, and nothing already in the database is at risk.** With
  one shape per org — which is every org today, in the seed and in any deployment — the
  behaviour is unchanged and correct.
- The provable defect remains what §19.19 says it is: **a correct request cannot be
  expressed.**

### 4.4 The shape of the hole in the tests

**`supabase/tests/90_hierarchy_template_test.sql` has eighteen cases about hierarchy
templates and never calls `create_node` once.** That is how D87 survived: not a wrong
assertion, an entirely absent one. T6 in that file even builds its second-shape root with a
direct `INSERT INTO nodes` and says why in a comment —

> `-- A root node in the new shape. create_node picks the position-0 level by`
> `-- org, so the second root is built directly here;`

— which is the bug, written down, in the test file, as a workaround. This is verification
standard **rule 5** (record what you did NOT verify, and treat that list as work) as much as
rule 7.

### 4.5 Why it survived review — the rule this brief exists to apply

Verification standard **rule 7**: when a constraint moves, the question is not "is this
statement guarded" but **"what else in this schema is conditioned on the same fact."** D86
updated `save_hierarchy_levels`, `board_window` and the adjacency trigger, and stopped. A
two-minute grep for every level lookup keyed on org and position would have found
`create_node` immediately.

The design session has since run that grep across all fourteen migrations and the whole
client. **`create_node` was the only remaining site**, and the client side was already
correct (P1-5e fixed `canDropOn` to compare template as well as position). You are not
expected to find a fifth — but if you do, report it rather than fixing it silently.


---

## 5. Part A(i) — migration 0015

### 5.1 Signature

```sql
drop function create_node(uuid, text, int);

create function create_node(p_parent_id uuid, p_name text, p_sort_order int default 0,
                            p_template_id uuid default null)
returns jsonb
language plpgsql security invoker
set search_path = public, pg_temp
```

**DROP, never overload.** Two `create_node` signatures visible through PostgREST is exactly
the ambiguity D86 removed for `save_hierarchy_levels`, and an un-updated client would keep
calling the old one. This is also why F2 needs a case asserting the 3-arg version is gone.

### 5.2 `p_template_id` HAS a default here, and `save_hierarchy_levels`'s does not

This looks inconsistent and is not. Say so in a comment in the migration, because the next
person to read both will otherwise "fix" one of them.

- `save_hierarchy_levels` edits an **existing** list. "The org's only template" is a guess
  about *which list the admin meant*, and guessing is the failure D86 removed. No default.
- `create_node` at the root **creates** something new. When the org holds exactly one
  template, that template is not a guess — it is the only possible answer, and every
  existing caller (which passes three arguments) stays correct. When it holds zero or more
  than one, the function refuses rather than picking. This is the same reasoning
  `LevelEditor` already uses, and §19.19 states it explicitly.

### 5.3 Required behaviour

Build the body by **extracting 0011's** (§4.1) and applying hunks by string replacement.
Do not retype it: a 129-line function reconstructed from memory during D86 silently lost
six subqueries and its `STABLE` marker (verification standard rule 12). Diff your result
against the extraction and say in the migration's header comment that this is what you did.

**Root branch** (`p_parent_id is null`):

1. If `p_template_id is null`: count the org's templates.
   - exactly 1 → use it.
   - otherwise → `invalid_argument`, detail
     `{field: 'p_template_id', reason: <'no templates' if count=0 else 'ambiguous'>, template_count: <n>}`.
2. If `p_template_id is not null`: look it up **`where id = p_template_id and org_id = v_org_id`**.
   Not found → `invalid_argument`, detail `{field: 'p_template_id', reason: 'not found'}`.
   The `and org_id = v_org_id` is load-bearing and is **not** made redundant by RLS — see
   §8.3.
3. Resolve the level: `where template_id = <resolved> and position = 0`.
4. If that returns nothing → `level_mismatch`, detail `{template_id: <resolved>}`, message
   naming that the shape has no levels yet. **This case is ordinary, not exotic**:
   `create_hierarchy_template` creates an EMPTY template on purpose. Without this guard the
   insert reaches `nodes_check_level_adjacency` with a NULL `level_id` and is refused with
   *"node … has no parent but its level is not position 0"* — a true statement about a level
   that does not exist, and a baffling thing for an admin to read. (Measured: the error code
   today is already inside the closed set. This guard improves the message and the detail
   payload, it does not close a leak.)

**Child branch** (`p_parent_id is not null`):

1. Select the parent's level **position AND `template_id`** in the existing single query.
2. If `p_template_id is not null and p_template_id is distinct from <parent's template>` →
   `invalid_argument`, detail
   `{field: 'p_template_id', reason: "not the parent's template", parent_template_id: <…>}`.
   A child's shape is fixed by its parent, so `p_template_id` is not a choice here;
   accepting a contradicting one silently would let a caller believe it had chosen.
3. Resolve the level: **`where template_id = <parent's template> and position = v_parent_position + 1`**.
4. Leave the existing `if v_level_id is null then … level_mismatch … {node_id: p_parent_id}`
   exactly as it is.

Everything else in the function — the admin check, `app_trim_ws`, the blank-name raise, the
path-collision check, the `coalesce(p_sort_order, 0)` that closes D2, the returned jsonb —
is unchanged.

### 5.4 No new error codes

The closed set stays at **twelve**. D86 deliberately added none and neither does this.
`invalid_argument` and `level_mismatch` carry every new failure, distinguished by their
DETAIL payload — the same call D86 made for the template RPCs. **Do not touch**
`src/lib/api/errors.ts`.

### 5.5 The trap this migration inherits: dropping a function drops its grants

Migration 0010 ends with an explicit `REVOKE EXECUTE … FROM PUBLIC` plus a guarded
`GRANT … TO authenticated` for each of its five functions, because Postgres grants EXECUTE
on new functions to **PUBLIC** by default and a bare `REVOKE … FROM anon` is not enough.
`drop function create_node(uuid,text,int)` takes those grants with it, and the new 4-arg
function arrives with the PUBLIC default.

**Migration 0015 must carry its own guarded grant block** for
`create_node(uuid,text,int,uuid)`, in exactly 0010's idiom (guarded on `pg_roles`, so the
file still applies on a scratch Postgres that lacks the Supabase roles). This is the
function-shaped version of D86's "every migration that creates a table needs its own GRANT
block" — where sixteen cases failed with `permission denied` before a policy was ever
consulted. **Case T30 exists to catch you forgetting.**

---

## 6. Part A(ii) — `src/features/admin/lib/shapePicker.ts`

Pure, dependency-free, `import type`-only, runnable under
`node --experimental-strip-types`. No React, no CSS, no `supabase`, no snake_case.

### 6.1 What is authoritative, and why this duplicates anything at all

Brief-writing rule 4: name the authority. **The database is the authority for every rule
here.** This module computes *previews* — what to show, what to pre-select, which button to
grey out. It must never be the thing that enforces anything:

| rule | authority | this module's job |
|---|---|---|
| which shape a node belongs to | `create_node` + `nodes_check_level_adjacency` | offer the choice |
| a shape with nodes cannot be deleted | `delete_hierarchy_template` → `level_in_use` | disable the button |
| blank / duplicate shape name | `create_/rename_hierarchy_template` → `invalid_argument` | disable Save, show why |

The duplication exists because a disabled button is a better experience than a round trip
to an error, **not** because the client is trusted. The invariant is one-way (verification
standard rule 8): **anything the client rejects, the server must also reject.** Never the
converse. Every server failure must still surface through `describeSchedulerError`.

**Whitespace parity, settled — do not re-derive it.** `app_trim_ws` (migration 0011) is a
code-point-exact reimplementation of JavaScript's `String.trim()` — ECMA-262 WhiteSpace +
LineTerminator, including U+FEFF, excluding U+200B, named by code point so it is
collation-independent. **The client mirror is therefore plain `String(x ?? "").trim()`.**
Do not invent a character class in TypeScript; do not use a `\s` regex. Both have been
tried in this project and both were wrong.

### 6.2 Exported surface

```ts
import type { BoardNode, HierarchyLevel } from "@/lib/api";   // type-only: erased at runtime

export interface HierarchyTemplateRef { id: string; name: string; }

export interface ShapeSummary {
  id: string;
  name: string;
  levelCount: number;
  /** level names in ascending position order; [] for a template with no levels */
  levelNames: readonly string[];
  /** null when the shape has no levels yet, or none is marked schedulable */
  schedulableLevelName: string | null;
  /** true when any node sits on one of this shape's levels — a PREVIEW of level_in_use */
  hasNodes: boolean;
}

export function buildShapeSummaries(
  templates: readonly HierarchyTemplateRef[],
  levels: readonly HierarchyLevel[],
  nodes: readonly BoardNode[],
): ShapeSummary[];

export function resolveSelectedShape(
  summaries: readonly ShapeSummary[],
  selectedId: string | null,
): string | null;

export function levelsForShape(
  levels: readonly HierarchyLevel[],
  templateId: string | null,
): HierarchyLevel[];

export type ShapeNameProblem = "blank_name" | "duplicate_name";
export function validateShapeName(
  name: unknown,
  summaries: readonly ShapeSummary[],
  currentId: string | null,
): { ok: true } | { ok: false; reason: ShapeNameProblem };
```

### 6.3 Behaviour, and the three traps

**`buildShapeSummaries` is driven by `templates`, NOT by `levels`.** This is the single most
likely bug in this brief. Deriving the shape list from the distinct `templateId`s present in
`levels` is the cheap path, it works for every seeded org, and it makes a **newly created
shape vanish the instant it is created** — because `create_hierarchy_template` returns an
EMPTY template on purpose (0014 says so in a comment, and explains why seeding a starter
level would decide the site's shape on the admin's behalf). A shape with zero levels must
appear in the picker with `levelCount: 0`, or the create flow looks broken and the admin
has no way to give it levels. **Case S3 asserts exactly this.**

**Ordering must be deterministic and locale-independent.** Sort by `name` using plain code
unit comparison (`a.name < b.name ? -1 : …`), tie-broken by `id`. Do **not** use
`localeCompare` — this project has already been burned once by a collation-dependent
comparison producing different answers on two machines (migration 0011's header records
it).

**`resolveSelectedShape` must fall back, not stick.** Return `selectedId` when a summary
with that id still exists; otherwise the first summary's id; otherwise `null`. The case
that matters is deleting the shape you are looking at: the selection must move to a
surviving shape, not leave the editor pointed at nothing. **Case S8.**

`levelsForShape(levels, null)` returns `[]`. Otherwise filter by `templateId` and sort by
`position` ascending.

`validateShapeName` trims per §6.1, rejects `blank_name` for empty-after-trim **and for any
non-string input** (`null`, `undefined`, a number, a missing key) — it must **never throw**.
P1-5b shipped `validateLevelDraft` throwing on exactly those four inputs where the server
returns a typed reason; that was found by a probe, not by the brief's own table.
`duplicate_name` compares **trimmed** names, case-sensitively (the server's uniqueness is a
plain `=` on the trimmed name), excluding `currentId` so renaming a shape to its own name is
allowed.


### 6.4 The fixture, and why its shape is prescribed

Verification standard rule 3, three times over. Build **one** fixture module inside
`src/test/shapePicker.test.ts` and use it everywhere:

- **Two shapes whose level names COLLIDE.** Shape A = Site › Department › Line › Work Cell
  (schedulable: Work Cell). Shape B = Site › Line (schedulable: Line). Both have a level
  named `Site` at position 0 and a level named `Line`. If your fixture gives them distinct
  names, a filter accidentally keyed on `name` or on `position` passes and you have tested
  nothing. *When two fields could each explain the same output, make them disagree.*
- **A third shape with NO levels at all** ("New Shape"), so §6.3's trap has a case.
- **Template ids must not resemble level ids**, and level ids must not encode their
  template. An id typo in a fixture is indistinguishable from the behaviour under test
  whenever the honest answer can be `[]` — during D86, `legalParentsFor` returned `[]` for
  an entire `describe` block because a fixture used `l0..l3` while its level table declared
  `L0..L3`, and only two cases caught it because both asserted a **positive** count.
- **Nodes on shape A only**, so `hasNodes` differs across shapes rather than being uniformly
  true or false.
- **B1 asserts the fixture is well-formed in its own case**: every level's `templateId`
  appears in `templates`, every node's `levelId` appears in `levels`, no duplicate ids. A
  list that drives a test is itself untested unless something asserts the list.

---

## 7. Part B — the screens (author-only)

Do not claim any of §7 was run. Write it, quote what it depends on (§10.2), and hand it off.

### 7.1 `src/lib/api/hierarchy.ts` (F5, EDIT)

Three new wrappers, in this file's existing style — `supabase.rpc`, `toSchedulerError` on a
PostgREST error, a hand-rolled runtime guard, `shapeMismatch` if the guard fails, camelCase
out:

- `createHierarchyTemplate(name: string): Promise<{ id: string; name: string; levels: [] }>`
- `renameHierarchyTemplate(templateId: string, name: string): Promise<{ id: string; name: string }>`
- `deleteHierarchyTemplate(templateId: string): Promise<{ id: string; deleted: boolean }>`

`createNode` gains `templateId?: string | null` on `CreateNodeInput` and passes
`p_template_id`. **Omit the key entirely when the caller did not supply one** (as
`deleteNode` already does for `p_mode`) so the RPC's own `DEFAULT null` stays the single
source of that default.

`fetchHierarchyTree` must additionally read `hierarchy_templates`:

```ts
supabase.from("hierarchy_templates").select("id, name").order("name")
```

and return `{ templates, levels, nodes }`. **This read is not optional and cannot be
replaced by deriving templates from `levels`** — §6.3 explains why. RLS scopes the table to
the caller's org; do not add a redundant `org_id` filter (the database owns that rule).

### 7.2 `useHierarchyMutations.ts` (F6, EDIT)

`useCreateHierarchyTemplate`, `useRenameHierarchyTemplate`, `useDeleteHierarchyTemplate` —
same shape as the five existing hooks: no optimistic update, invalidate the
`hierarchyKeys.all` prefix on success. `useCreateNode`'s variables type widens with
`CreateNodeInput`'s new field; nothing else changes.

### 7.3 `ShapePicker.tsx` / `.module.css` (F7/F8, NEW)

A card above `LevelEditor` in the Hierarchy section. Renders `buildShapeSummaries` output:

- A selector — a `<select>` when there are more than two shapes, a radio group otherwise
  — labelled by name, with the shape summary (`Site › Department › Line › Work Cell`, or
  *"no levels yet"*) as secondary text.
- `+ new shape` → a name input → `useCreateHierarchyTemplate`; on success, **select the new
  shape**, so the admin lands in the empty editor they now need to fill.
- Rename, on the selected shape, via `AdminPopover` (the existing component).
- Delete, on the selected shape, **disabled when `hasNodes`** with the reason shown; the
  server's `level_in_use` is still surfaced if it fires anyway.
- Save/Delete disabled per `validateShapeName`; every server failure rendered through
  `describeSchedulerError` — **do not** write a second error-message map. P1-5d built one
  (`errorText.ts`) that duplicated `describeSchedulerError` for all six codes and it has no
  live caller to this day.

**Sizing (D84, §19.16): scaling is the DEFAULT.** New surfaces size in `rem`, never raw
`px`. `:root` already carries `font-size: calc(100% * var(--chrome-scale))`. Do **not** use
`--ui-scale` — that is fitted board content only, and `src/test/scaleAudit.ts` will fail you
for it. Do **not** convert any media query to `rem`.

### 7.4 `LevelEditor.tsx` (F9, EDIT)

Today this component computes `soleTemplateId(levels)` itself and **fails closed** whenever
an org holds more than one shape — that guard is the thing this brief exists to remove.

- New required prop `templateId: string | null`. Delete `soleTemplateId` and the
  "more than one hierarchy shape" error paragraph.
- Build the draft from `levelsForShape(levels, templateId)`, not from all `levels`. Today it
  drafts every level in the org, so with two shapes it renders both vocabularies interleaved
  as one ordered list — `fetchHierarchyTree` orders levels by `position` alone, so an org
  with two shapes shows `Site, Site, Department, Line, Line, Work Cell`.
- **Reset the draft when `templateId` changes**, or switching shapes leaves the previous
  shape's rows on screen and Save writes them into the newly selected template. Use a
  `key={templateId}` on the element so React remounts it — simpler and harder to get wrong
  than an effect, and it cannot drift out of sync with the state it guards.
- Save stays disabled while `templateId === null`.
- Its file header comment says the picker is "P1-5e's job". The queue was renumbered; it is
  this brief, P1-5f. Fix the comment.

### 7.5 `NodeTreeEditor.tsx` (F10, EDIT)

The `+ add root node` form (currently `createMutation.mutate({ parentId: null, name })`)
gains a shape choice:

- **One shape in the org** → no control; pass `templateId` implicitly by omitting it. Do not
  make an admin with one plant answer a question with one possible answer.
- **More than one** → a required shape `<select>`, defaulting to the currently selected
  shape from the picker, passed as `templateId`.
- A shape with `levelCount === 0` must be **offered but not selectable for a root** — a root
  needs a position-0 level, and the server will return `level_mismatch`. Disable that option
  with the reason, rather than letting the admin discover it.
- The **Add child** path is unchanged and must stay unchanged: a child's shape comes from its
  parent, and passing a template there is now an `invalid_argument` (§5.3).

### 7.6 `AdminPage.tsx` (F11, EDIT)

Holds `const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null)`, derives
`summaries` and `resolveSelectedShape(...)`, and passes the resolved id down to all three
children. Keep the single shared read — `fetchHierarchyTree` is called once, here, and its
result passed down; `NodeTreeEditor` still receives the **complete** `levels` array, because
`canDropOn` needs every level to answer honestly.

---

## 8. Acceptance

### 8.1 SQL — append 11 cases to `supabase/tests/90_hierarchy_template_test.sql` (F2)

Same conventions as the file's existing cases, without exception: one `SAVEPOINT` + `DO`
block each, an outer `EXCEPTION WHEN OTHERS` turning any unexpected error into
`RAISE NOTICE 'FAIL …'`, `ROLLBACK TO SAVEPOINT` at the end, and assertions on the machine
`error` parsed from `DETAIL` — **never** on SQLSTATE or message text.

The file's existing ids run T1–T18. Use **T20–T28, T30, T31** and confirm no collision
before you write. There is deliberately **no T29** — see §8.2.

| id | case | must observe |
|---|---|---|
| T20 | root, two shapes, `p_template_id` omitted | `invalid_argument`, `field=p_template_id`, `reason=ambiguous`, `template_count=2` |
| T21 | root, two shapes, **one root created in EACH**, each naming its own template | both land in the template they named; `plant_a`/`plant_b`; both `parent_id` null; exactly 2 rows at position 0 in the org |
| T22 | root + **org 2's** template id, run with **`RESET ROLE`** | `invalid_argument`, `reason=not found` |
| T23 | root + an unknown template id | `invalid_argument`, `reason=not found` |
| T24 | root, org has exactly ONE template, `p_template_id` omitted | succeeds, uses the seeded template — the backward-compatibility case |
| T25 | root into a template with **no levels** | `level_mismatch`, detail `template_id` = that template |
| T26 | a child under **EACH** shape's root, neither naming a template | each child gets its own parent's template at position 1; paths `plant_a.dept_one` / `plant_b.line_one`; exactly 2 rows at position 1 in the org |
| T27 | child + `p_template_id` equal to the parent's | accepted |
| T28 | child + a **contradicting** `p_template_id` | `invalid_argument`, `field=p_template_id`, `parent_template_id` = the parent's |
| T30 | grants after the drop/recreate | `authenticated` has EXECUTE; `anon` and `PUBLIC` do not |
| T31 | overloads | exactly one `create_node` in `pg_proc`; `create_node(uuid,text,int)` is `NULL` via `to_regprocedure`, the 4-arg one is not |

**T21 and T26 assert BOTH shapes on purpose, and that is not padding.** A first draft
asserted only the second shape and was **order-dependent**: any lookup scoped by org returns
one arbitrary row for both calls, so whether it happens to be right or wrong depends on
physical row layout. Asserting both sides means that whichever row an org-scoped lookup
picks, one of the two assertions fails — deterministically, on any heap state. This is what
makes M1 and M2 reliably catchable.

**T22 runs as the table owner for a measured reason.** `create_node` is `SECURITY INVOKER`,
so under the `authenticated` role the `hierarchy_templates` SELECT policy silently supplies
the org scope and the function's own `and org_id = v_org_id` is never the thing under test.
Measured: with T22 running as `authenticated`, deleting that clause (mutation M5) was **NOT
CAUGHT by any case**; with `RESET ROLE`, M5 breaks T22 and only T22. Same reasoning as this
file's own T18 and `80_cross_org_test`'s C19 — and any future `SECURITY DEFINER` wrapper,
service-role script or bulk import gets no RLS at all.

### 8.2 There is deliberately no T29

The design session wrote one and deleted it. It asserted that re-saving one shape's level
list makes the *other* shape's position-0 row physically first (§4.3's flip), and that an
explicitly-named template still wins. The behaviour half was right. The **precondition** half
was a heap-order assertion, and heap order depends on what free space earlier savepoint
rollbacks happened to leave behind: it passed standalone and failed inside a full-file run
**against the unmutated build** — which meant it appeared to be "broken by" all ten
mutations, including one independently proved inert. That is the signature of a broken
instrument, not a caught defect.

Put a comment in its place in F2 saying so. The flip itself is a real measurement and
belongs in design plan §19.19, not in a committed case.

### 8.3 TypeScript — `src/test/shapePicker.test.ts` (F4)

Run it with `node --experimental-strip-types src/test/shapePicker.test.ts`. **This group
table is authoritative; report your own assertion count and reconcile any difference rather
than matching a number in a headline.** (P1-5b shipped headlined "74" while its own table
summed to 76.)

| group | covers | cases |
|---|---|---|
| **B** | `buildShapeSummaries` | B1 fixture well-formed (§6.4) · B2 every template appears, none invented · B3 **the zero-level template appears, `levelCount: 0`, `levelNames: []`, `schedulableLevelName: null`** · B4 `levelNames` in ascending position order · B5 `schedulableLevelName` picks the flagged level · B6 `null` when no level is flagged · B7 `hasNodes` true for shape A, false for B and the empty one · B8 ordering by name then id, and stable under a shuffled input |
| **R** | `resolveSelectedShape` | R1 a live selection is kept · R2 a deleted selection falls back to the first summary · R3 `null` selection → first summary · R4 empty summaries → `null` |
| **L** | `levelsForShape` | L1 returns only the named template's levels, on the name-colliding fixture · L2 ascending by position · L3 `null` → `[]` · L4 an unknown id → `[]` |
| **V** | `validateShapeName` | V1 a fresh name is ok · V2 `""` → `blank_name` · V3 whitespace-only (space, tab, NBSP U+00A0, U+FEFF) → `blank_name` · V4 `null`, `undefined`, `42`, a missing key → `blank_name` **and no throw** · V5 an existing name → `duplicate_name` · V6 duplicate detection is trim-aware (`" Shape A "`) · V7 the shape's own name under its own `currentId` → ok · V8 `"shape a"` vs `"Shape A"` → **not** a duplicate |

### 8.4 Run the cases against the UNFIXED build, and read the result honestly

Before trusting a green run: apply your F2 cases to a database built from migrations
0001–**0014** only (move 0015 aside, re-run `scripts/verify-db.sh`).

Measured by the design session: **T24 passes on both builds** — correct, it is the
backward-compatibility case and must. The other ten fail. **But eight of them fail with
`function create_node(…, uuid) does not exist (42883)`** — a *signature* failure that any
signature change would produce, which proves far less than it looks like it does.

Exactly one case demonstrates the defect itself: **T20, which on the unfixed build reports
`caught=f`** — `create_node(NULL, 'Plant 2')` with two shapes present **succeeds silently**,
with no error, creating a root in an arbitrary shape. That single line is the whole of D87.
The mutation table in §9 is what proves the rest of the cases have teeth against the
*logic*.


---

## 9. Mutation tables — both EXECUTED by the design session, not reasoned

Brief-writing rule 5: reasoning produces confident wrong answers; execution does not. Nine
prior mutation tables in this project shipped wrong. **Both tables below were run.** Apply
each mutation one at a time to a scratch copy, rebuild, re-run, restore, and confirm the
named case fails. Restore the source **and rebuild the database** — during D86 a runner
restored a mutated migration file while the database still held the mutated function, and
the next measurement was of a mutation that had already been reverted.

### 9.1 SQL (migration 0015 / F2). Ten designed, eight shipped, two proved inert.

| # | mutation | primary case | measured collateral |
|---|---|---|---|
| M1 | root level lookup: `template_id = <resolved>` → `org_id = v_org_id` | **T21** | T25, T26, T27, T28 |
| M2 | child level lookup: `template_id = <parent's>` → `org_id = v_org_id` | **T26** | T27 |
| M3 | ambiguity guard `if v_template_count <> 1` → `if false` | **T20** | — |
| M5 | explicit-template lookup drops `and org_id = v_org_id` | **T22** | — |
| M6 | empty-template guard `if v_level_id is null` → `if false` | **T25** | — |
| M7 | child contradiction guard: `is distinct from` → `=` | **T28** | T27 |
| M8 | delete the `REVOKE`/`GRANT` block | **T30** | — |
| M9 | delete `drop function create_node(uuid, text, int);` | **T31** | T20, T24, T26 |

Stable across two independent full runs.

**Executed, found inert, and deliberately left out** — so you do not hunt for a case that
cannot exist (rule 5's corollary):

- **M4**, `v_template_count <> 1` → `< 1`: breaks T20 and only T20, identical to M3. A
  redundant mutation, not an extra one.
- **M10**, the `case when v_template_count = 0 then 'no templates' else 'ambiguous' end`
  collapsed to a bare `'ambiguous'`: **breaks nothing.** No case reaches the root branch with
  zero templates — every org in the seed has one, and there is no supported way to reach that
  state through the API. The `reason` value for that branch is therefore unguarded, on
  purpose, and recorded here rather than papered over.

**M5 is the one to read twice.** In the first run T22 impersonated `authenticated` and M5
was **NOT CAUGHT by any case in the file** — the `hierarchy_templates` RLS policy was doing
the org scoping for a `SECURITY INVOKER` function, so the function's own clause could be
deleted with no observable effect. Moving T22 to `RESET ROLE` is what gave it teeth. This is
verification standard rule 10, and it is the third time this exact masking has happened
here.

### 9.2 TypeScript (`shapePicker.ts` / F4). Twelve designed, ten shipped.

| # | mutation | primary case | measured collateral |
|---|---|---|---|
| N1 | `buildShapeSummaries` iterates `levels`' distinct template ids instead of `templates` | **B3a** | B2, B2b, B3b, B3c, B6, B8a, B8b, B8c, R2, R3 |
| N2 | drop `.sort((a,b) => a.position - b.position)` on `levelNames` | **B4** | — |
| N3 | `schedulableLevelName` takes `mine[0]` instead of `find(isSchedulable)` | **B5** | B5b |
| N4 | `hasNodes` hard-coded `false` | **B7a** | — |
| N5 | drop the `id` tie-break from the summary sort | **B8c** | — |
| N6 | `resolveSelectedShape` returns `selectedId` without checking it still exists | **R2** | R4 |
| N8 | `validateShapeName` drops the `typeof name === "string"` guard | **V4a** | V4b, V4c, V4d |
| N9 | duplicate check drops `s.id !== currentId` | **V7** | — |
| N11 | duplicate check compares `toLowerCase()` on both sides | **V8** | — |
| N12 | drop the sort in `levelsForShape` | **L2** | — |

**Executed, found inert, left out:** **N7**, `if (templateId === null) return []` → `if (false)`
— the `filter` that follows compares `l.templateId === null` and returns `[]` anyway, so the
early return is genuinely redundant for that input; and **N10**, `s.name.trim() === trimmed`
→ `s.name === trimmed` — the stored summary names are already clean, so only the *candidate's*
trim (V6) is load-bearing.

### 9.3 Three defects the design session's first pass had, which you should expect to have too

All three were in **the test suite**, not the module, and all three were invisible until the
mutation table was actually run:

1. **N1 CRASHED instead of failing by name.** `S.find(...)!` returned `undefined` and the
   next property access threw, so the runner recorded a crash where a named failure belonged.
   The fixture accessor now falls back to a sentinel summary with distinguishable values.
   *A crash is CRASHED, never "not caught."*
2. **N2 and N12 were INERT because the `LEVELS` fixture was already in position order.**
   Deleting either sort changed nothing observable. The fixture is now deliberately shuffled
   — *a fixture that agrees with the field being derived cannot test the derivation.*
3. **N9's anchor matched zero lines** (wrong indentation) and would have been scored as a
   coverage hole. The runner reported `ANCHOR NOT UNIQUE (count=0)` distinctly instead —
   which is the only reason it was caught. **Your runner must do the same.**

---

## 10. What this brief cannot verify, and what would confirm it

Brief-writing rule 3: an unverifiable assumption that is written down is a task; one that is
silent is a bug.

### 10.1 `database.types.ts` will be stale the moment 0015 applies — and it is quotable now

Do not predict what `tsc` will say. **Read the file.** Today, `src/lib/database.types.ts`
line 931 says, verbatim:

```ts
create_node: {
  Args: { p_name: string; p_parent_id: string; p_sort_order?: number }
  Returns: Json
}
```

There is no `p_template_id`. So every `createNode` call passing one is a `tsc` error until
the file is regenerated, and **regeneration needs Docker + WSL, which you do not have.**
This is not a bug in your code and you must not work around it by loosening a type. Say so
in your report, and put it in the handoff.

Two things that *are* already correct and do not need regeneration: `hierarchy_templates` is
present as a table (line 216) and all three template RPCs are typed (lines 930, 945, 975),
so `fetchHierarchyTree`'s new read and the three wrappers typecheck against today's file.

**Also already known and unfixable by regeneration:** Postgres parameters carry no
nullability, so the generated `Args` will emit `p_template_id: string`, never
`string | null`. `create_node` branches on `p_template_id is null`. Cast at the single call
site with a comment, exactly as this file already does for `p_parent_id` and
`move_node`'s `p_new_parent_id`. Do not push it onto callers.

**P1-5b lost seven `tsc` errors to precisely this**, because the agent verified every
argument *name* by hand against the migration and then predicted "clean" without ever
opening the generated file (D79).

### 10.2 Required in your report: quote your dependencies AND evaluate them

For each generated or third-party artifact your code depends on, state **what it actually
says — quote the line** — and then **what it does across the range it operates in**. Quoting
is necessary and not sufficient: during P1-5c an agent quoted
`clamp(1, 0.75 + 0.25 * (100vw / 1440px), 1.35)` correctly and concluded a `ResizeObserver`
would fire on viewport change. True of the definition; false across the range, because the
clamp is **pinned flat at 1.0 for every viewport ≤ 1440px** — i.e. every ordinary laptop.
Ask of every expression: *at what input does this stop changing?*

### 10.3 Not verifiable here

- Anything in **Part B**. No npm, no browser. Author it, do not claim it ran.
- The **PostgREST HTTP-status mapping** for the new `invalid_argument` payloads. Unchanged
  from the existing contract, but no Docker here to prove it.
- **Real Supabase.** `scripts/verify-db.sh` proves the SQL cases pass on scratch PG16;
  `supabase db reset` on Pratik's machine proves the migration applies. **Keep those two
  claims separate in your report.** They have been conflated before.

---

## 11. Scope fence

Fenced by **property**, not by a blanket file list — a blanket prohibition eventually
collides with the feature it accompanies (rule 10). If a requirement here forces a breach,
**breach it deliberately and report it**; do not silently work around it.

- No `supabase.rpc`, no snake_case, and no `database.types.ts` import outside `src/lib/api/`.
- No React import, no CSS import, and no runtime import of any kind in
  `src/features/admin/lib/shapePicker.ts` — `import type` only, or Part A stops being
  executable.
- No new error code. The closed set stays at **twelve**.
- No second error-message map. `describeSchedulerError` is the one presentation layer.
- No raw `px` and no `--ui-scale` in new CSS (D84). `rem`, and `--chrome-scale` where a
  literal pixel value is unavoidable. Never convert a media query to `rem`.
- No edits to `src/features/board/**`, `package.json`, or migrations 0001–0014.
- No `git` commands of any kind. Reading `.git/HEAD` or `.git/refs/**` is a plain file read
  and is fine; **running git leaves a `.git/index.lock` you cannot delete**, which blocks
  every subsequent git command until Pratik removes it by hand.
- Do not commit or push. Pratik reviews and commits.

---

## 12. Final checklist — every line must be true before you report

1. [ ] `create_node`'s body was **extracted from migration 0011** (md5
       `a94c96336a0c942fc7624908410b1119`, 73 lines), edited by string replacement, and
       **diffed**; the migration header says so.
2. [ ] Migration 0015 `drop function create_node(uuid, text, int)` before creating the
       4-arg version, and carries **its own guarded REVOKE/GRANT block**.
3. [ ] `scripts/verify-db.sh` run cold: all migrations apply, seed applies, and **every**
       test file reports zero `NOTICE:  FAIL`. Quote the Summary block.
4. [ ] All eleven new SQL cases (T20–T28, T30, T31) live in
       `supabase/tests/90_hierarchy_template_test.sql` — the repo file, not a scratch
       container — and the absent-T29 comment is there with its reason.
5. [ ] The eight-row SQL mutation table re-run: each mutation breaks its named case.
       Report `ANCHOR NOT FOUND` / `ANCHOR NOT UNIQUE` distinctly from `NOT CAUGHT`.
       Report any collateral beyond §9.1's table as a table correction.
6. [ ] The new cases were run against a **0001–0014-only** build, and your report states
       which failed for a *signature* reason and which for a *behavioural* one (§8.4).
7. [ ] `src/features/admin/lib/shapePicker.ts` runs under
       `node --experimental-strip-types`; `src/test/shapePicker.test.ts` exists **in the
       repo**; report your own assertion count and reconcile it against §8.3's group table.
8. [ ] The ten-row TS mutation table re-run, same reporting rules.
9. [ ] The `LEVELS` fixture is **not** in position order and level names **collide** across
       shapes; B1 asserts the fixture is well-formed.
10. [ ] `LevelEditor` no longer contains `soleTemplateId`, drafts only the selected shape's
        levels, remounts on `templateId` change, and its stale "P1-5e" comment is fixed.
11. [ ] `fetchHierarchyTree` reads `hierarchy_templates` directly. A zero-level shape appears
        in the picker.
12. [ ] `docs/api.md` §3.5 shows `create_node`'s new signature and the new `invalid_argument`
        detail payloads.
13. [ ] `docs/roadmap.md` updated: P1-5f marked built, with your findings in its row.
14. [ ] Your report lists **every deviation from this brief**, and **every error you found in
        this brief**. Both are expected. Every P1-5 brief has contained at least one real
        error, and the agent finding it is the system working — but **a flagged deviation is a
        lead for the design session to check, not a fact to act on.**
15. [ ] Delivery followed §2.2: heredoc for new files, in-place `python3` for edits, no
        tarball, no `SendUserFile`, no base64.
