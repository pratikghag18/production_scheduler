# P1-6a — "Who can get in": the site access panel

**You are building the on-screen half only.** The database side (migration
`20260826000021_site_membership.sql`), the API wrappers and the entire pure
logic layer are already written, applied, green and mutation-tested. Your job
is the components, the CSS, the hooks and the wiring.

---

## §1. What this is, in the product's words

A site admin runs one plant. They can already, in the database, give somebody
access to that plant, change what that person can do there, and take it away.
**There is no screen for any of it** — and there is no screen anywhere in this
app that shows a person at all. This is the first one.

The panel answers one question for one plant: *who can get in here, and what
can they do?* It lists the people who already have access, lets the admin
change what each of them can do or take their access away, and lets them add
somebody who does not have access yet.

People show as their **sign-in email address**, because that is genuinely all
the system knows about a person: `user_profiles` has no name column and the
seed sets `raw_user_meta_data` to `{}`.

---

## §2. ⛔ WHAT IS ALREADY DONE, AND WHAT YOU MUST NOT EDIT

**Do not edit these files. If you believe one of them is wrong, say so in your
report and work around it — do not change it.**

| File | What it gives you |
|---|---|
| `src/features/admin/lib/siteAccess.ts` | Every rule this panel obeys. Pure, no imports, 57 committed cases, 32 deliberate breakages all caught. |
| `src/test/siteAccess.test.ts` | Those 57 cases. |
| `src/lib/api/access.ts` | `fetchSitePeople`, `setSiteMember`, `removeSiteMember`. |
| `src/lib/api/hierarchy.ts` | `fetchHierarchyTree`, which now also returns `siteNodeIds`. |
| `supabase/**` | The whole database. |

`siteAccess.ts` exports, and **you must use these rather than re-deriving any
of them**:

- `buildAccessRows(payload: unknown, viewerProfileId: string | null): AccessView`
  — turns `site_people`'s payload into `{ nodeId, nodeName, rows, skipped }`.
  Never throws. `skipped` counts entries it could not read.
- `partitionAccess(rows, query): { members, candidates }` — the two lists,
  already filtered by the search box. **It does not sort and you must not
  either**; the server's order is `email COLLATE "C"` and is deterministic.
- `allowedRoles(row, viewerIsCompanyAdmin): readonly GrantRole[]` — which
  options the role control may offer for that person.
- `canRemoveAccess(row, viewerIsCompanyAdmin): boolean`
- `removalNote(row, viewerIsCompanyAdmin): string | null` — **why** there is no
  Remove button. `null` means there IS one; rendering it unconditionally puts
  an explanation next to a live button.
- `describeAccess(row, nodeName): string` — the sentence under the address.
- `accessPanelState(treeLoading, siteNodeId, peopleLoading, peopleError)` —
  `"pending" | "no-place" | "error" | "ready"`. **Use this for the panel's
  top-level branch. Do not write your own.**
- `GRANT_ROLES`, and the types `AccessRow`, `AccessView`, `AccessGrant`,
  `GrantRole`.

### The three rules the panel exists to respect

1. **Only the grant sitting on THIS node is editable here.** `AccessRow` splits
   `directRole` (this node) from `inheritedGrants` (further down the subtree).
   Somebody who administers a department inside the plant shows in the list with
   real access and **no editable role** — `removalNote` returns the sentence
   pointing at the place their access actually sits on.
2. **A company admin reaches every plant with no grant at all.** They appear
   with access and nothing to remove.
3. **You cannot take away your own admin access here.** Narrow: only your own
   `admin` grant on this exact node is protected, a company admin is exempt,
   and everything else about your own row is editable.

---

## §3. Files

**Add:**

- `src/features/admin/components/SiteAccessPanel.tsx`
- `src/features/admin/components/SiteAccessPanel.module.css`
- `src/features/admin/hooks/useSiteAccess.ts`

**Change:**

- `src/features/admin/AdminPage.tsx` — a new section.
- `src/test/scaleAudit.ts` — **one line, and the suite fails without it.** See §7.

**Do not add a component test.** There is no precedent in this repo: all 19
test files are pure logic plus one hook test, and `src/test/` contains no
`.tsx` and no `render(` anywhere. The tooling exists (`jsdom`,
`@testing-library/react`) and is deliberately unused for components. Verification
here is the pure layer (done), `tsc`, `eslint`, and a rendered screenshot.

---

## §4. The server contract

All three raise `SchedulerError`; surface every one through
`describeSchedulerError`, never a raw message.

```
fetchSitePeople(nodeId: string): Promise<unknown>
```
Hand the result straight to `buildAccessRows`. **Do not parse it yourself** —
that is what `buildAccessRows` is, and it is the tested half.
Raises: `invalid_argument` (no such node), `not_permitted` (you do not
administer this place).

```
setSiteMember({ nodeId, profileId, role }): Promise<void>
```
Adds the person **or** changes the role they already hold there — one row
either way. Raises `invalid_argument` (unknown node / unknown person / unknown
or null role) and `not_permitted` (not your place; your own admin access).

```
removeSiteMember({ nodeId, profileId }): Promise<void>
```
Removes the grant on this exact node. Raises `invalid_argument` (no such node;
nothing here to remove) and `not_permitted`.

---

## §5. The hooks — `src/features/admin/hooks/useSiteAccess.ts`

Follow `useHierarchyMutations.ts` exactly: `useMutation<TResult, SchedulerError,
TVars>`, `onSuccess` invalidates, **no optimistic updates anywhere** (that file's
header explains why and it applies here verbatim).

- `siteAccessKeys = { all: ["site-access"] as const }`
- `useSitePeople(nodeId: string | null, enabled: boolean)` — a `useQuery` keyed
  `[...siteAccessKeys.all, nodeId]`, `enabled: enabled && nodeId !== null`.

  ⚠️ `fetchSitePeople` takes `string`, and `enabled` does not narrow the type
  for the `queryFn` — TypeScript has no way to know the query cannot run with
  `nodeId === null`. Narrow it inside the `queryFn` and throw if it is somehow
  null (it cannot be, and an unreachable throw is honest where a `!` is a
  lie). Do NOT widen `fetchSitePeople`'s parameter to accept null: that would
  make an unasked question look like a legitimate call.
- `useSetSiteMember()` and `useRemoveSiteMember()` — both invalidate
  `siteAccessKeys.all` on success.

⚠️ **`enabled: false` leaves `isLoading` FALSE** (D91). Do not compute the
panel's state yourself from `isLoading` — pass the flags into
`accessPanelState` and branch on its answer. Case C4 in the committed suite is
the bug this prevents: an unasked query rendering as an empty list of
colleagues, as though the company had nobody in it.

---

## §6. The panel

### Which plant is it about?

`AdminPage` already owns the structure selection (`resolvedShapeId`). A
structure is owned by a site root, so:

```ts
const siteNodeId =
  data && resolvedShapeId !== null ? (data.siteNodeIds[resolvedShapeId] ?? null) : null;
```

⚠️ Written out rather than `data.siteNodeIds[resolvedShapeId] ?? null`, because
`resolvedShapeId` is `string | null` and `data` is `undefined` until the query
resolves — indexing a `Record<string, …>` with `string | null` does not
compile. This is the shape that does.

`siteNodeIds` is a new field on `fetchHierarchyTree`'s result, keyed by template
id. `null` means the structure is unowned, and `accessPanelState` turns that
into `"no-place"`.

📌 **A limitation, named rather than discovered:** a *department* admin
administers no structure (a structure is owned by a ROOT — migration 0020 §1),
so `editable_shape_ids` returns `[]` for them and this panel says
`"no-place"`. That is correct for now and it is written down in migration 0021
§7. It needs a real sentence on screen, not a spinner.

### The four states, from `accessPanelState`

| state | render |
|---|---|
| `pending` | the same `Loading…` line the hierarchy section uses |
| `no-place` | a plain sentence: there is no plant here for you to manage access for. Do not render a spinner and do not render an empty list. |
| `error` | one `role="alert"` paragraph, text from `describeSchedulerError` |
| `ready` | the panel below |

If `view.skipped > 0`, show a quiet line saying how many entries could not be
read. **Do not swallow it** — a silently shortened list is indistinguishable
from a company with fewer people in it.

### Markup — shape, not text

This is the structure to build, not code to paste. Class names are yours.

```
<section>
  <h2>Who can get in — {view.nodeName}</h2>

  <input type="search" aria-label="Search people by email address" ... />

  <h3>Has access ({members.length})</h3>
  <ul>
    <li> for each member:
      <span>{row.email ?? "(no address on file)"}</span>
      <span>{describeAccess(row, view.nodeName)}</span>

      if row.directRole !== null:
        <select aria-label={`Role for ${label}`}
                value={row.directRole}
                disabled={pending}>
          one <option> per allowedRoles(row, isCompanyAdmin)
        </select>

      if canRemoveAccess(row, isCompanyAdmin):
        <button aria-label={`Remove access for ${label}`}>Remove</button>
      else:
        <span>{removalNote(row, isCompanyAdmin)}</span>
    </li>
  </ul>

  <h3>Everyone else ({candidates.length})</h3>
  <ul>
    <li> for each candidate:
      <span>{row.email ?? "(no address on file)"}</span>
      <select aria-label={`Role to give ${label}`}>  <!-- GRANT_ROLES -->
      <button aria-label={`Give ${label} access`}>Add</button>
    </li>
  </ul>
</section>
```

`label` is `row.email ?? "this person"` — **never the raw profile id**, and
never an empty string, or the accessible name of the button disappears.

### The three interactions

1. **Change a role** — `<select>` `onChange` calls `setSiteMember` with the new
   role. No separate Save button: it is one field, it is reversible, and a Save
   button for a single control is worse than the write. Disable the control
   while that row's mutation is pending.
2. **Add somebody** — a role `<select>` defaulting to `supervisor`, plus an Add
   button that calls `setSiteMember`.
3. **Remove** — **a two-step inline confirm, not a popover and not
   `window.confirm`.** Clicking Remove replaces that row's controls with
   `Remove {email}'s access? [Remove] [Cancel]`. State is one
   `confirmingProfileId: string | null` on the panel.

   *Why inline rather than `AdminPopover`:* the popover exists for a context
   menu on a tree row, where there is no space to put the question. Here there
   is a row with a visible button, and an inline confirm needs no anchor
   geometry, no portal and no focus trap. `window.confirm` is out — this repo
   already replaced it once (`ConfirmPopover`'s header says why).

   ⛔ **Do not import anything from `src/features/board/`.** Cross-feature
   imports are forbidden by `docs/conventions.md`. `ConfirmPopover` there is
   precedent to read, not a component to reuse.

### Errors and pending

One mutation error at a time, rendered as a `role="alert"` paragraph **on the
row that caused it**, text from `describeSchedulerError`. Track which row is
pending so only that row's controls disable — a panel-wide freeze on one
person's role change is wrong.

### ⚠️ StrictMode

Side effects go in event handlers, never inside a state updater. React
`<StrictMode>` double-invokes updaters in development, and P1-5g shipped a
`move_node` that fired twice per drop for exactly this reason. If you need the
previous value, read it from a `useRef` mirror.

---

## §7. CSS — and the one line that fails the suite if you forget it

⭐ **`src/test/scaleAudit.ts` has a `REM_SURFACES` array listing every admin
stylesheet, and a second check (`missingRemSurfaces`) that walks
`src/features/admin` on disk and FAILS if a `*.module.css` there is not in the
list.** Adding `SiteAccessPanel.module.css` without adding its path to
`REM_SURFACES` turns `npm run test` red. This is D89: a whole surface once
shipped outside the audit while the audit reported green.

Every file in `REM_SURFACES` must satisfy all four:

1. **No raw pixel dimension.** Sizes are `rem`, so they scale with the root
   font size. This includes `border-radius`, which is a real dimension.
2. **Exempt: `border` / `outline` widths of 2px or less.** Hairlines only.
3. **Exempt: `box-shadow` offsets and blur.**
4. **Exempt: anything inside an `@media (...)` prelude** — a breakpoint
   describes the device viewport and must stay raw px.

`0px` is fine, and comments are stripped before matching. `global.css` already
declares `font: inherit` for `input, button, select, textarea`; do not restate
it and do not fight it.

Match the visual language of `LevelEditor.module.css` and
`ShapePicker.module.css` — same token variables, same spacing scale. Do not
invent new colours; use the existing custom properties.

---

## §8. What NOT to do

- Do not edit anything in §2's table.
- Do not re-sort either list.
- Do not parse `site_people`'s payload yourself.
- Do not add optimistic updates.
- Do not add a component test, or a new testing-library pattern.
- Do not import across features.
- Do not put a raw server error string on screen.
- Do not use `window.confirm` / `alert` / `prompt`.
- Do not change the predicted test count: **this brief adds no test cases.**
  If you believe a case is missing, name it in your report rather than writing
  it.

---

## §9. Acceptance

Run these yourself, from the repo root, and paste the real output:

1. `node node_modules/typescript/lib/tsc.js -b --force` — exit 0.
   **Instrument-check it once**: inject a deliberate type error into a file you
   actually changed, confirm the expected `TS####` at the expected line,
   restore, re-run. A clean run prints nothing and exits 0, which is
   indistinguishable from not having run.
   ⚠️ Never pipe it into `head` — `cmd | head` reports *head's* exit code.
   Redirect to a file and echo `$?`.
2. `node node_modules/eslint/bin/eslint.js .` — exit 0.
3. **Render the panel and LOOK at it.** A green suite cannot see a screen.
   Produce at least these four states and attach the images:
   - a plant with several people, including one company admin, one department
     admin whose access sits below, and one candidate;
   - the same panel with a search term typed;
   - a row mid-confirm;
   - the `no-place` state.
   ⭐ Choose fixtures that can actually show what you claim. Do not render every
   state with one person in the list — the bug lives in the seam between rows.
4. Report the **predicted** `npm run test` count. It must be **652 in 19
   files**, unchanged by your work, and say so explicitly. A different number
   means a test file stopped loading, which is how a broken suite once looked
   green.

## §10. Your report

Say, in this order: what you built; **every place this brief was wrong,
ambiguous or would not compile as written** (expected — the last brief in this
project had four such errors and the agent found all of them); anything you
changed outside §3's file list, and why; what you did NOT verify; and the four
screenshots.
