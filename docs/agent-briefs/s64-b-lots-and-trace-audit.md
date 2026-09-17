# S64-b — the audit R-432 and R-434 trigger: what a lot does when a step is refused, and every path through the bar that leaves no trace

Read R-432, R-434, R-421, R-427, F-154, F-164 and F-165 in `docs/plan.yaml` and CLAUDE.md §7. This
file is the audit itself (read-only pass, 17 Sept, session 178, at 3e5a7b0; line numbers drift with
S63 — grep the message text). A fix lane takes each list, fixes or queues every row, and pins each fix.

## R-432 — a lot is all or nothing

**Where lots come from.** `Lot` (`commandConversation.ts` ~186) is filled only through `startLot`
(`CommandBar.tsx` ~1412) when `runCommand` sees `intent === "several"` (~1339); steps resolve one at
a time (`resolveLotStep` ~1426), the yes is `run_lot` (~2499, spoken/typed ~2751), and `runLotNow`
(~1639) calls the writer `runLot` (`useDragGesture.ts` ~2730, wired `BoardPage.tsx` ~1236). Every
`Lot.commands` list is built in `resolve.ts` by `expandCommand` (~4809) through `wrapMany` (~3411),
capped at `LOT_CEILING = 100`: `expandEveryoneUnassign` ~3538, `expandEveryoneMove` ~3639,
`expandReplace` ~3755, `expandSwap` ~3907 (its four steps at ~4063: unassign A, unassign B, assign
A→B, assign B→A), `expandCopy` ~4306, `expandAbsence` ~4472 (an "until" span → one unassign per
block), `expandSplit` ~4594, `expandRepeatDay` ~4778; a typed comma list arrives as `several` from
`parse.ts`.

**What happens today when step k of n is refused.** `runLot` writes in order, one await each, and
returns at the first throw (~2733–2805): no rollback, no compensating write; its own doc (~2699)
says the writes are not one transaction. The bar prints "Did k of n; the next failed: … The k done
stayed: …" (~1689, F-154), the trace `outcome` gets the same sentence (~1670) and `ran` the readouts
that landed. A swap refused on its third step leaves both people unassigned. The F-165 fix moved the
certificate and area gates to expansion time (~4044) so those cannot strike mid-lot; capacity, RLS,
overlap and races still can. Pre-yes guards that are not reverts: `LotStepRefused`
(`useDragGesture.ts` ~457, thrown ~2794), `lot_too_big`, the duplicate-block pair check (~1557).

**Why a client-side revert cannot be built honestly** (writer by writer):

| step | writer | inverse? |
|---|---|---|
| create assignment | `createFromCommand` ~1876 → `create_assignment` | `deleteAssignment` exists, but the new id is discarded (`.then(() => undefined)` ~1907). |
| create run (book) | `createRunFromCommand` ~2071 → `create_run` | `deleteRun(id, cascade|detach)`, id discarded (~2088); cascade would also delete crew placed in between. |
| unassign | `deleteAssignment` ~2736 | No inverse: a re-create gets a new id and loses attachment, efficiency, targets, overrides; and the re-create itself can be refused by the triggers. The before-image is in `index.assignmentById` but never snapshotted. |
| move to another cell | `submitMove` ~2745 → `move_assignment` (`20260911000080_move_assignment.sql` ~61) | Same RPC back, but `ResolvedMove` carries only the target; the source must be captured at write time. |
| retime a block | `retimeAssignmentForLot` ~1128 → `updateAssignmentFields` | Same call with the old range from a snapshot; `planAssignmentRetime` (~482) can also change `run_id`/`product_id`, so both must be restored. |
| retime a run | `retimeRunForLot` ~1207 → `updateRunFields` | Same, plus a run resize can keep/scale crew (R-031), each with its own inverse. |
| headcount | never in a lot by type (~392; refused ~2794) | trivial, single path only. |
| absence | the bar writes no absence row; "off until Friday" is N unassigns | the delete problem × N. |

**The audit log** (`20260821000007_audit_log.sql` ~8–80, never redefined; triggers on runs,
assignments, products, operators, skills, shift_templates, absences, week_templates) stores the
whole OLD row on update/delete and the whole NEW row on insert — content enough to reconstruct any
single write (R-436's undo can read it). But its RLS is admin-only (`20260821000008_rls_policies.sql`
~302), so a line supervisor at the bar cannot read a row; and no restore/undo function exists in any
migration.

**The fix shape (a decision for the maintainer, then a migration).** A server RPC
`apply_command_lot(p_steps jsonb)` in the mould of `apply_copy_week` (`20260905000055_copy_week.sql`
~419, "the answers, applied in one transaction through the existing writers") and
`apply_split_coverage` (`20260828000030_area_override.sql` ~515): validate every step, then apply
them in one plpgsql body, so a refusal at step k rolls 1..k-1 back on the server and the bar renders
"Refused: <reason>. Nothing changed." `runLot` becomes one call. This is the only honest way to meet
R-432; a client-side revert would be the second implementation of every writer's inverse.

**Found on the way (a defect, not a standard):** on the SINGLE path, four writer props answer
`void` — `onRetime`, `onRetimeRun`, `onUnassign`, `onMove`'s retime branch (`BoardPage.tsx`
~1152–1194) — and `settleWrite` (~1284) reads `undefined` as `written`, while the underlying
`removeAssignment` (~2685) and `retimeAssignmentFromCommand` (~1841) are fire-and-forget `.mutate`
with a toast on error. A refused unassign or retime is recorded as Written in the trace and the
thread. Filed as F-168.

## R-434 — every bar feature traces

An entry opens in two places only — `startTrace` (~930) from ~2845 (F-166's bare confirm/cancel)
and ~2911 (a sentence) — and closes through `finishTrace` (~922), `settleTurn`, or teardown.

**A. Ends a sentence's life with no entry, or an open entry never touched**

| # | path | where |
|---|---|---|
| 1 | recogniser errors: mic refused, "Nothing was heard", "The recogniser stopped: …" | ~3006–3020; no entry at all |
| 2 | `submitText` no-op while a lot is writing (Enter or a spoken final during `runningLot`) | ~2627; the heard text is discarded untraced |
| 3 | `runCommand` null-ctx early return | ~1310; entry open with `read: ""` |
| 4 | `resolveLotStep` null-ctx early return | ~1436; lot frozen |
| 5 | `runLotNow` with no lot (a stale "Do all N") | ~1642; `answered` set, nothing closed |
| 6 | `runLotNow` stale-generation return | ~1651; documented unreachable |
| 7 | `onRunLot` REJECTING: `.then` with no rejection handler | ~1648; "Working…" forever, `runningLot` stuck true, so Enter, typing and Escape are all no-ops — the bar is wedged. `runLot` catches its own throws (~2797), so this is a guard to add, not a defect seen. |
| 8 | the reader rejecting: `.then` with no rejection handler | ~1786; "Reading…" forever (`readSentence` never throws today; `Reader` is a prop) |

**B. The status the person sees is never recorded** (`asked` not updated, `answered` not set,
entry not closed): the lot dropped for a headcount step (~1460), the lot dropped for a duplicate
block (~1586), "Say the reason, not yes." (~2695), "That is a lot of N commands…" (~2764), "Which
one?" on a bare confirm (~2787), the kind-mismatched confirm (~2804), F-166's floor (~2886),
`onConfirmWord` → created (~2815; the word itself untraced) and → needs-decision (~2819),
`onCancelWord` → true (~2824; the cancel word never `answered`), a typed edit dropping a question,
a lot or a block question (~2542, ~2584, ~2592; `answered`/`outcome` null, entry open until the next
sentence), a typed edit aborting a reading (~2555; unlike Escape, no `answered = "escape"`), a mic
press aborting a reading or clearing a question (~2974, ~2986), `nothing_to_do` (~1991 → ~1153;
closed but `outcome` null so the thread's last line is blank), `cancelStanding` (~1224; same blank
line), every shape hint (~2927, ~1729, ~1872, ~1910; deliberate per S59-e, closed by the next
sentence), `popupReporterFor(traceRef.current)` capturing null (~1365, ~1194: a pop-up's answer
silently dropped when no entry is open).

**C. A write traced under the wrong sentence.** `pendingRerun` (set ~2496) is cleared on a typed
edit (~2548), a cancel (~2657) and Escape (~3052) but NOT in `submitText` (~2905). A SPOKEN new
sentence never passes `handleChange`, so a pending "Show that day" rerun survives it; when the new
window lands the effect at ~1084 runs the OLD command and overwrites the NEW sentence's `read`, `ran`
and `outcome`. Filed as F-169.

**`HistoryTurn` fields left empty on some path.** `outcome` is set only by `settleWrite`,
`popupReporterFor` and `runLotNow`, so most turns (questions left standing, shape hints, Escape,
`nothing_to_do`, `cancelStanding`) render a blank result line; `answered` is null for shape hints,
dropped questions and the in-place re-asks; `read` is `""` on the null-ctx returns and when a reading
is still in flight at the next sentence; `offered` is never cleared when a question is dropped, so a
filed turn can advertise buttons that were withdrawn; and `TraceEntry.model` and `revises` have no
`HistoryTurn` counterpart, so the thread cannot show a skipped or garbled model read or a corrected
line. The fix shape: one `endTurn(reason)` in the store that every life-ending path calls with
`answered`/`outcome` named ("dropped by typing", "mic pressed", "nothing to do", …), and the thread
rendering an outcome for every turn — no blank last line.
