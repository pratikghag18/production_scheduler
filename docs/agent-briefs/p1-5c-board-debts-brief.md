# Brief P1-5c — the three board debts

**You are a build agent.** Every decision here is already made. Where something is left to you it
says so. **If you find an error in this brief, flag it in your report** — every previous brief on
this project contained at least one real one, and the deviations list is the most valuable part of
what you write.

**This brief ships NO admin screens.** The hierarchy level editor and node tree editor are P1-5d.
CSV import is P1-5e. If you find yourself building UI for the hierarchy, stop.

This is a small, focused brief by design. It closes three debts that were left behind on Aug 25:

1. **The popover has never scaled** — an inline `width` has been overriding its CSS all along
   (design plan §19.11).
2. **§19.6 has no regression test** — the fit-to-height oscillation was fixed by hand, and the rule
   it restored is guarded by nothing.
3. **§19.8 has no regression test** — `useSession` blanking the board on every token refresh was
   also fixed by hand, also unguarded.

---

## 1. Read these first

| File | Why |
| --- | --- |
| `docs/design-plan.md` **§19.11** | The popover defect, measured. Read it before touching `BoardPopover`. |
| `docs/design-plan.md` **§19.6** | The fit loop. The *rule* it establishes is what §4.3 guards. |
| `docs/design-plan.md` **§19.8** | The `useSession` bug. Note carefully that the guard **existed** — only one of the two statements written for it was using it. |
| `docs/design-plan.md` **§18.10, §19.7, §19.10** | `--ui-scale` vs `--chrome-scale`, and D75/D76/D77. |
| `src/features/board/components/BoardPopover.tsx` | The component you are fixing. |
| `src/features/board/components/BoardPopover.module.css` | Its stylesheet — which has never taken effect for `width`. |
| `src/features/board/components/BoardGrid.tsx`, the `railProbeRef` block (~line 150) | D47's probe pattern, and **§5 explains why you are NOT using it here**. |
| `src/features/auth/useSession.ts` | The hook you are refactoring in §4.2. |
| `src/test/boardGeometry.test.ts` | The house style for a pure-module vitest file. Copy its shape. |

---

## 2. Environment

Cowork cloud container. **No Docker, no npm/pip/apt network.** Do not attempt `supabase start` or
any install. Available without installing anything: PostgreSQL 16, Node v22, Chromium at
`/opt/pw-browsers`.

### 2.1 Part A runs; Part B does not

`node --experimental-strip-types file.ts` executes TypeScript by erasing annotations. **All three
§4 modules are therefore mandatory-executable** — you will run them and mutation-test them with
real reported output. Constraints, all load-bearing:

- every import is `import type`, **with one deliberate exception**: `node:fs` is a Node builtin and
  resolves natively under strip-types. §4.3 uses it. This was verified in-container, not assumed.
  No other value import will resolve — the `@/` alias never does.
- relative imports carry an explicit `.ts` extension
- no `enum`, `namespace`, parameter properties, or decorators — strip-types erases, it does not transform

**§7's Part B cannot be compiled here** (React, `useLayoutEffect`, CSS Modules). It is author-only.
Say so plainly in your report rather than implying it was verified.

### 2.2 Delivery: write files directly. No tarball. No `SendUserFile`.

Author each file straight into the repo with a `device_bash` heredoc:

```bash
cat > "$HOME/mnt/production_scheduler/<path>" <<'ENDOFFILE'
...file content...
ENDOFFILE
```

**Do not build a tarball, do not call `SendUserFile`, do not base64 anything.** Iterate in `/tmp`
**inside your own container** first — that is free and fast — and write to the repo only when a file
is finished.

Three mount hazards:

- **`device_bash` cannot delete or move files.** Keep every scratch file in `/tmp` inside your own
  container, never under the repo. If you strand one anyway, report its full path.
- **Do not run `git` at all.** Every git command through `device_bash` leaves a `.git/index.lock`
  you cannot remove, which then warns on all of Pratik's git commands. Do not commit or push.
- Files may land read-only; `chmod u+w <path>` before overwriting one in place.

After writing each file, verify it with `wc -l` and `md5sum` and report both.

---

## 3. What you are building

| Path | Kind | Verified? |
| --- | --- | --- |
| `src/features/board/lib/placement.ts` | new — pure popover placement (§4.1) | **yes, by you, in-container** |
| `src/features/auth/session.ts` | new — pure session-update decision (§4.2) | **yes, by you, in-container** |
| `src/test/scaleAudit.ts` | new — the `--ui-scale` file audit (§4.3) | **yes, by you, in-container** |
| `src/test/placement.test.ts` | new — vitest, §8 group P | authored; Pratik runs |
| `src/test/session.test.ts` | new — vitest, §8 group S | authored; Pratik runs |
| `src/test/scaleAudit.test.ts` | new — vitest, §8 group A | authored; Pratik runs |
| `src/features/board/components/BoardPopover.tsx` | edit — §7.1 | no — author-only |
| `src/features/board/components/BoardPopover.module.css` | edit — §7.2 | no |
| `AssignmentPopover.tsx`, `ConfirmPopover.tsx`, `CreatePopover.tsx`, `RunPopover.tsx`, `SplitCoveragePopover.tsx` | edit — drop `width={272}` (§7.3) | no |
| `src/features/auth/useSession.ts` | edit — call §4.2's decision (§7.4) | no |
| `docs/roadmap.md` | edit — final step, §12 | n/a |

**The three `.test.ts` files are deliverables, not scratch.** A suite you run once in this container
and do not commit guards nothing: the previous brief specified 76 assertions, never named a repo
path for them, and the module shipped with no regression test while CI reported green. Every pure
module in `src/` has a peer in `src/test/`.

Note the split: `scaleAudit.ts` lives in `src/test/` rather than `src/`, because it is test
infrastructure with no runtime caller. The other two are real app modules.

---

## 4. Part A — the three pure modules

### 4.1 `src/features/board/lib/placement.ts`

Pure, `import type` only.

```ts
export interface PlacementInput {
  anchorX: number;
  anchorY: number;
  /** MEASURED rendered width, already scaled. Never a hardcoded constant. */
  width: number;
  /** MEASURED rendered height, already scaled. Replaces the hardcoded 420. */
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;  // default DEFAULT_MARGIN
  gap?: number;     // default DEFAULT_GAP
}
export interface Placement { left: number; top: number }
export const DEFAULT_MARGIN = 10;
export const DEFAULT_GAP = 8;
export function resolvePopoverPlacement(input: PlacementInput): Placement;
```

Rules, in this order:

1. `desiredTop = anchorY + gap`. `desiredLeft = anchorX` (no horizontal gap).
2. **Unknown viewport** — either dimension not finite, or `<= 0` — return `{ left: anchorX, top:
   desiredTop }` **unclamped**. This is the SSR path and the before-first-measurement path. Do not
   invent a position from a zero viewport.
3. Treat a non-finite or non-positive `width`/`height` as `0` (an unmeasured box), so it clamps to
   the far edge rather than past it.
4. On each axis independently: `max = viewport - size - margin`. **If `max <= margin` the box cannot
   fit between the margins at all — pin to `margin`.** Otherwise
   `Math.min(Math.max(desired, margin), max)`.

**Both ends of the clamp are load-bearing.** The shipped code is `Math.min(anchor.x, innerWidth -
width - 10)` — a one-sided clamp that returns a **negative** `left` whenever the viewport is
narrower than the popover plus its margins, putting the popover off the left edge. Step 4's low
clamp and its degenerate branch are what §8's P3, P4, P7 and P8 exist for.

### 4.2 `src/features/auth/session.ts`

Pure, `import type` only. **Do not import `@supabase/supabase-js`** — take the user id, never the
session object.

```ts
export type AuthEventKind = "initial" | "change";
export interface AuthEvent { kind: AuthEventKind; nextUserId: string | null }
export interface SessionDecision { resetCache: boolean; setLoading: boolean; reloadProfile: boolean }
export interface SessionStep { decision: SessionDecision; nextLastUserId: string | null }
export function decideSessionUpdate(lastUserId: string | null, event: AuthEvent): SessionStep;
```

- `identityChanged = lastUserId !== event.nextUserId`.
- `kind === "initial"` → `{ resetCache: identityChanged, setLoading: true, reloadProfile: true }`.
  **`setLoading` is unconditionally true here** even when it resolves to signed-out (`null → null`),
  because `loading` starts `true` and something must clear it.
- `kind === "change"` → **all three flags are `identityChanged`.** A token refresh fires a change
  event with the same id; same person, same profile, same cache.
- `nextLastUserId` is always `event.nextUserId`.

**Why this is one value and not three booleans computed at three call sites.** §19.8 was not a
missing guard. The guard existed, returned the right answer, and **only one of the two statements
written for it was using it** — so the cache correctly survived a token refresh while the board
still flashed through the loading branch. Returning a single decision is what stops the two from
drifting apart again: there is one answer now, not two call sites that each have to remember to ask.
§8's S9 asserts that property directly.

### 4.3 `src/test/scaleAudit.ts`

**May import `node:fs`** (see §2.1).

```ts
export const CHROME_FILES: readonly string[];
export function countUiScaleUses(css: string): number;
export function auditChromeFiles(root: string, files?: readonly string[]):
  Array<{ file: string; uses: number }>;
```

`CHROME_FILES` is **exactly** these five, and the list is part of the guard (§8's A10):

```
src/components/AppShell.module.css
src/components/HealthPill.module.css
src/features/auth/DevProfileSwitcher.module.css
src/features/board/components/BoardToolbar.module.css
src/features/board/BoardPage.module.css
```

`countUiScaleUses` strips `/* … */` comments first, then counts matches of
`/var\(\s*--ui-scale\s*[,)]/g`. **Both details are load-bearing and both are traps:**

- `BoardToolbar.module.css` **mentions `--ui-scale` in a comment** explaining why it does not use it.
  A naive `css.includes("--ui-scale")` reports a violation on the very file the rule was written
  for, and the guard gets deleted as broken. Verified: that comment is really there today.
- The trailing `[,)]` stops `var(--ui-scaled)` — or any future token with this as a prefix — from
  counting. **A guard with a false-positive mode gets deleted the first time it fires wrongly.**

The rule being guarded is §19.6's: *anything outside the fitted scroll container that consumes
vertical space must not use `--ui-scale`*, because its height feeds `computeFitScale`, whose output
**is** `--ui-scale`, and `.header` wraps — so the coupling is a step function, which has no fixed
point and cannot settle.

**This is a file-content audit, not a rendering test, and that is deliberate.** The rule was written
down correctly in `global.css` and violated the next day, by the same session, because nothing ever
checked the files against it. A test that reads the files is the thing that was missing.

**`OperatorPanel.module.css` uses `--ui-scale` 24 times across 19 lines and is CORRECT** (the brief originally said "19 times" — that was a `grep -c` LINE count, corrected after the build agent measured it) — it sits *beside* the grid
inside `.body` (`display:flex; flex-direction:row; overflow:hidden`), so its width scales but it
cannot change the page's available height. Do not add it to the list. If you think the reasoning is
wrong, say so in your report rather than changing the list.

---

## 5. The measurement rule — and why NOT the railProbe here

**One source of truth for the popover's size, and it is the rendered element itself.**

§19.11 suggested D47's `railProbe` pattern. **This brief deliberately does not use it, and you
should not.** The probe exists in `BoardGrid` because `--rail-w` is needed as a *number* for layout
maths independently of any element that has that width. Here the popover element **is** the thing
with the width, so measuring it directly with `getBoundingClientRect()` is strictly better: no
second element, no second token, and the measured number cannot disagree with what the user sees.

What remains true from §19.11, and is not negotiable:

- **`getComputedStyle(el).getPropertyValue('--chrome-scale')` is not an option.** For an unregistered
  custom property it returns the raw `clamp(...)` token stream, not a number.
- **The number that sets the size and the number that feeds the edge clamp must be the same number.**
  That is the entire defect: CSS said `calc(260px * var(--chrome-scale))`, the inline style said a
  hard `272`, the inline style won, and the clamp used `272` as well — so the popover has never
  scaled and its edge clamp has been computing against a width it only coincidentally had.

**Base width: 272px, not 260px.** The CSS rule says `260px` and has never taken effect; every one of
the five callers passes `width={272}`; so `272` is what has actually been rendering and what was
accepted in the browser. Changing to `260` would be an unrequested visual change. Update the CSS to
`272px` and note in the comment that the `260` was inherited from the mockup and never applied.

---

## 6. What is already true, so you can check yourself against it

Facts verified against the repo while writing this brief. If any is false when you look, **that is a
finding — report it**, do not quietly work around it.

| Claim | Where |
| --- | --- |
| `BoardPopover` has `width = 272` as a default prop and applies it via `style={{ left, top, width }}` | `BoardPopover.tsx` |
| Its CSS sets `width: calc(260px * var(--chrome-scale, 1))` — overridden by the inline style | `BoardPopover.module.css` |
| The vertical clamp uses a hardcoded `const hMax = 420` regardless of real height | `BoardPopover.tsx` |
| **All five** callers pass `width={272}` explicitly, so the prop's default is dead | Assignment/Confirm/Create/Run/SplitCoverage popovers |
| All five chrome stylesheets currently have **zero** `var(--ui-scale)` uses | §4.3's list |
| `BoardToolbar.module.css` mentions `--ui-scale` **in prose only** | the §4.3 trap |
| `useSession`'s `clearCacheOnIdentityChange` already returns `boolean` and the change handler already early-returns on `!identityChanged` | `useSession.ts` |

That last row matters: **§19.8's bug is already fixed.** §4.2/§7.4 is a refactor that makes the fix
*testable* and hard to un-fix. You are not re-fixing it. If the current behaviour looks wrong to
you, re-read §19.8 before changing anything.

---

## 7. Part B — the React changes (author-only, not compilable here)

### 7.1 `BoardPopover.tsx`

- **Delete the `width` prop entirely** from the component's props. All five callers pass the same
  value; a prop with one value is a hardcoded constant with extra steps.
- Measure the rendered box in a **`useLayoutEffect`** with `getBoundingClientRect()`, storing
  `{ width, height }` in state. `useLayoutEffect` (not `useEffect`) runs after DOM mutation and
  **before paint**, so the corrected position is never painted wrong.
- **Only call the setter when a measured value actually differs** — see §10 trap 1.
- Compute `left`/`top` with `resolvePopoverPlacement`, passing `window.innerWidth`/`innerHeight`
  (or `0` when `typeof window === "undefined"`, which §4.1 step 2 handles).
- `style={{ left, top }}` — **no `width`**. Delete `hMax` entirely.
- Re-measure on viewport resize. A `ResizeObserver` on the popover element is the cheap way to catch
  both its own content changing and a `--chrome-scale` change; add a `window` `resize` listener only
  if you find the observer does not fire for viewport-driven token changes. Say which you did and why.

### 7.2 `BoardPopover.module.css`

`width: calc(272px * var(--chrome-scale, 1));` plus a comment recording that the previous `260px`
came from the mockup's `#pop` and never applied because an inline style outranked it.

### 7.3 The five callers

Remove `width={272}` from each. No other change.

### 7.4 `useSession.ts`

Replace the inline decision with `decideSessionUpdate`. The hook keeps `lastUserId` in a ref and
assigns `nextLastUserId` from the returned step. Both the `getSession()` path (`kind: "initial"`)
and the `onAuthStateChange` path (`kind: "change"`) go through it. **No behaviour change is
intended** — if you find one, that is a finding, report it.

---

## 8. Acceptance — 35 assertions, all of which pass against a reference implementation

**Your suites must be table-driven** where the cases are uniform (group P especially). A case is a
row in a table the harness loops over, not a copy-pasted block.

**Every assertion must be evaluated inside a try/catch** so a throw is recorded as a named failure
rather than aborting the file, and your mutation runner must treat **non-zero exit with zero
failures** as CRASHED, distinct from passing.

| group | count | covers |
| --- | --- | --- |
| **P1–P16** | 16 | well inside; right edge; left edge clamped up; **viewport narrower than the box pins to margin, never negative (P4)**; bottom edge uses the MEASURED height (P5); **a taller popover is pulled further up, proving height is not hardcoded (P6)**; viewport shorter than the box (P7); negative `anchorY` (P8); unknown viewport passes through unclamped (P9); NaN viewport (P10); **a scaled width changes the right-edge answer (P11)**; unmeasured width still clamps to the edge (P12); custom margin on both axes (P13); custom gap (P14); the two default constants (P15); **PROPERTY: input is not mutated (P16)** |
| **S1–S9** | 9 | initial signed-in; **initial signed-OUT still clears loading (S2)**; **TOKEN REFRESH — all three flags false (S3)**; sign-in from signed-out; switch identity; sign out; repeated signed-out change events stay inert (S7); `nextLastUserId` always advances (S8); **PROPERTY: on a change event the three flags never disagree (S9)** |
| **A1–A10** | 10 | every chrome file has zero uses (A1); **`BoardToolbar` really does mention the token in prose (A2)** and has zero real uses (A3); **a fitted file DOES use it, so the matcher is not vacuous (A4)**; comment-only mention is not a use (A5); real use counts (A6); whitespace inside `var()` counts (A7); **a prefix token is not a false positive (A8)**; the `var(--x, fallback)` form counts (A9); **`CHROME_FILES` is exactly the five files (A10)** |

The bolded ones exist because a mutation slipped past everything else, or because they are the only
case separating two plausible implementations. Do not drop them for looking redundant.

**A4 is not decoration.** An audit that reports "zero violations" is indistinguishable from an audit
whose matcher never matches anything. A4 points the same matcher at a file that *does* use the token
and requires a non-zero answer.

**A10 exists because a mutation was NOT caught without it.** Deleting a file from `CHROME_FILES`
silently stops guarding it while every other case still passes. The list is part of the guard.

**Group A needs a repo root.** Take it from `process.cwd()` in the vitest file (vitest runs from the
repo root) and pass it to `auditChromeFiles`. Do not hardcode an absolute path.

---

## 9. Mutations — all 15 were executed against a reference implementation

Each was applied on its own and the whole suite re-run. **These mappings are recorded observations.**
Apply each to *your* implementation, confirm the named case fails, restore. Mutate a copy in `/tmp`,
never the delivered file.

**If a mutation does not break its named case in your build, that is a finding — report it.**

| # | Mutation | Must fail | Also fails |
| --- | --- | --- | --- |
| M1 | `clampAxis` drops the LOW clamp (`Math.min` only) | **P3** | P8 |
| M2 | vertical clamp uses a hardcoded `420` instead of the measured height | **P5** | P6, P13 |
| M3 | `max = viewport - size` — the margin is forgotten | **P2** | P5, P6, P11, P13 |
| M4 | `desiredTop = anchorY` — the gap is dropped | **P1** | P2, P3, P9 |
| M5 | the degenerate branch returns `max` instead of `margin` | **P4** | P7 |
| M6 | the viewport-known guard accepts `0` (`>=` instead of `>`) | **P9** | — |
| M7 | an unmeasured `width` falls back to a hardcoded `272` | **P12** | — |
| M8 | `width` and `height` swapped between the two axes | **P2** | P5, P6, P11, P12, P13 |
| M9 | **the §19.8 bug itself**: the change branch sets `setLoading: true` unconditionally | **S3** | S7, S9 |
| M10 | the initial branch gates `setLoading` on `identityChanged` | **S2** | — |
| M11 | the change branch never resets the cache | **S4** | S5, S6, S9 |
| N1 | `countUiScaleUses` becomes a naive `css.includes("--ui-scale")` | **A3** | A1, A5, A8 |
| N2 | comments are no longer stripped before matching | **A5** | — |
| N3 | the trailing `[,)]` prefix guard is dropped | **A8** | — |
| N4 | `BoardToolbar.module.css` is removed from `CHROME_FILES` | **A10** | — |

**Note what is NOT in this table.** Changing `!==` to `!=` in `decideSessionUpdate` caught nothing
and is correctly redundant: the operands are typed `string | null`, and the two operators can only
differ for `undefined`. It was executed and confirmed inert rather than left for you to discover.

**M1's mapping was wrong on the first pass and is worth understanding.** It looks like it should
fail P4 and P7 — the "viewport narrower than the box" cases — because those are about the low clamp.
It does not: the `max <= margin` early return handles them *before* the clamp line, so M5 is what
covers them and M1 covers P3/P8. If you reason your way to a different table, run it.

---

## 10. Traps, all hit for real while writing this brief

1. **A measure→setState→render cycle is the same family of bug as §19.6.** `useLayoutEffect` that
   unconditionally calls a setter with a fresh object re-renders forever. Compare the measured
   numbers to the current state and bail when unchanged. §19.6's lesson generalises: any loop where
   the output feeds back into the input needs either a change-guard or a genuinely continuous
   coupling — and layout is full of discontinuities.
2. **A naive `includes("--ui-scale")` fails on a comment.** §4.3.
3. **A guard with a false-positive mode gets deleted.** Hence the `[,)]`. §4.3.
4. **An audit that never matches anything reports success.** Hence A4.
5. **The list is part of the guard.** Hence A10 — N4 was not caught without it.
6. **`getPropertyValue('--chrome-scale')` returns a token stream, not a number.** §5.
7. **A one-sided `Math.min` clamp goes negative** on a narrow viewport. That is shipped behaviour
   today, not hypothetical.
8. **The seed is anchored to the week it was run** — irrelevant to every case here, but do not
   "fix" a board that looks empty; that is a seed anchor, not a bug.

---

## 11. Report

1. Part A: your harness output for all three modules, every §8 assertion with PASS/FAIL, plus your
   own total. If it is not 35, say which group differs and why.
2. The 15 mutations: which case actually failed for each, and **flag any that broke nothing or
   crashed**.
3. `wc -l` and `md5sum` for every file you wrote.
4. **Which generated or third-party artifacts does your Part B code depend on, and what does each
   one actually say — quote the line.** Do not predict what a compiler would say; open the file and
   quote it. On the previous brief the agent verified every RPC argument name by hand, then
   predicted `tsc` would be clean and predicted a nullable signature, having never opened
   `database.types.ts`; both predictions were wrong and cost two acceptance rounds. For this brief
   that means at minimum: the exact `useLayoutEffect` and `ResizeObserver` signatures you rely on,
   and the current prop types of the five popover callers you are editing.
5. Explicitly: that Part B was never compiled, and what you expect `tsc`/`eslint` to complain about.
6. **Your assumptions and deviations** — the highest-signal part. Previous briefs contained an
   impossible acceptance case, an impossible scenario, mutations whose named case could not
   distinguish them, a scope fence that contradicted the brief's own feature, and a mutation table
   with a wrong mapping. Assume this one has at least one error and tell me what it is.
7. Anything left undone and why.

---

## 12. Scope fence — properties, not a file list

- **No admin screens, no hierarchy UI, no CSV.** Those are P1-5d and P1-5e.
- **No second source of truth for the popover's size.** One measured number feeds both the style and
  the clamp. No new width token, no probe element, no constant in TS mirroring one in CSS.
- **No new client-side rule with no server counterpart**, and no change to `src/lib/api/`,
  `supabase/`, or any migration.
- **No behaviour change in `useSession`** — §7.4 is a refactor to make §19.8 testable, not a re-fix.
- **`--ui-scale` must not be added to any file in §4.3's list.** If a requirement seems to need it,
  that is a finding, not a licence.
- **No `package.json` change.**

If a requirement here collides with this fence, breach it deliberately and say so in §11 item 6 —
a previous brief's fence contradicted its own headline feature and the agent was right to break it.

---

## 13. Final step

Update `docs/roadmap.md`: mark P1-5c built with your actual numbers, and add the new files to the
artifact index. **Do not** mark the browser acceptance done — that is Pratik's, and it is the only
thing that can confirm §7.
