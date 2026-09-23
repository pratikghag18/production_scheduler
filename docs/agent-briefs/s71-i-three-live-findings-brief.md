# S71-i — three things the third spoken pass showed (F-206, F-207, F-208)

All three are from the maintainer's walk on 23 Sept, after the clip capture (S71-f, dce9e7a)
landed. Read the three finding cards in `docs/plan.yaml` if they exist yet (`grep -n "id: F-20[678]"`);
if not, this brief is the card.

## F-208 — the bar's clips were never kept, because the fallback wrapper drops `onClip`

`src/lib/voice/localRecognizer.ts` ~781 `withFallback(primary, fallback, onEngine)` wraps the
local recogniser so a dead Whisper falls back to the browser's engine. It rebuilds the events
object it hands the inner recogniser with exactly `onInterim`, `onFinal`, `onError`, `onEnd`
(~793-816) and so the optional `onClip` added in S71-f never reaches the bar. `BoardPage.tsx`
~122 builds `BOARD_RECOGNIZER` through `withFallback`, so on the real board no clip was ever
posted: `data/voice/trace/clips/manifest.jsonl` stayed empty through two walks and a browser
probe, while the unit pins passed because they hand a bare recogniser to `CommandBar`.

Fix: forward `onClip` in BOTH places the wrapper builds an events object (the primary's and the
fallback's), as `onClip: events.onClip` (optional stays optional). Pin LREC-31 in
`src/test/localRecognizer.test.ts`: `withFallback` over a fake primary that fires `onClip` —
the outer `onClip` receives the same object; and the fallback path (primary errors "other")
forwards it too. Then a pin that guards the SHAPE: a test that lists every key of
`RecognizerEvents` (`src/lib/voice/recognizer.ts`) and asserts the wrapper forwards each one —
so the next event added is not silently dropped (build the list from the type via a
`satisfies Record<keyof RecognizerEvents, true>` object in the test, so tsc fails when a key is
missing).

## F-206 — "Listening…" left in the input after the mic is stopped

`CommandBar.tsx` ~3414 `onInterim(interimText)` does `setText(interimText)`: the recogniser's
first interim is the literal "Listening…" (`localRecognizer.ts` ~694), and later interims are
partial transcripts. `stopListening()` (~3360) keeps the text on purpose ("Text is kept") — right
for a half-typed sentence, wrong for a status word the person never typed. The maintainer's
screenshot: the mic pressed a second time to stop, the input reading "Listening…" as if it were
still on.

Fix: remember that the input's current text came from an interim (a ref set in `onInterim`,
cleared in `handleChange` when the person types and in `submitText`), and on `stopListening()`
clear the text if it is still the interim's. Keep a genuinely typed text. Pins in
`src/test/commandBar.test.tsx` (the `CB-mic-` series): CB-mic-13 mic on, interim "Listening…",
mic off → input "" ; CB-mic-14 the person typed "clear cell 3" then pressed mic, interim
arrives, mic off → the interim is gone and the typed text is NOT restored (say in the report
whether the typed text survives the interim today; if an interim overwrites typed text, that is
the existing behaviour, keep it and pin what is true); CB-mic-15 a real final transcript is
unaffected.

## F-207 — a spoken answer does not show in the thread, so the person answers again

When a standing question is answered by pressing a button, the chosen chip is ticked in the
turn (~3695-3705 `turn.answered === label`). When it is answered by VOICE — a spoken "yes" to a
"say or type yes" question, or a spoken "Housing A" — the heard word is folded into the
question's own turn as `answered` and there is no bubble for it; a "yes" question has no chips
at all, so nothing on screen changes until the result line lands, and the person says yes again
and gets "Nothing to say yes to." (trace 20:01:17 → 20:01:49 on 23 Sept). Typed answers have the
same gap.

Fix: a turn whose `answered` is non-null and not "auto" renders the answer as the person's own
bubble (`data-side="you"`) under the board's question bubble and above the result, in the
thread — the literal answered text (the chip label or the spoken/typed word) — and keeps the
chip tick as it is. If `answered` equals a chip label, the tick alone is NOT enough: show the
bubble too, so voice and button read the same. Read `commandConversation.ts`'s turn shape
(`answered: string | null`, ~247) — if "auto" is the sentinel for "no question was asked", skip
it; find the exact sentinel in the code, do not guess. Pins in `commandBar.test.tsx` (the `CH-`
series): CH-answer-1 a spoken/typed "yes" to a confirm question shows a "you" bubble reading
"yes" between the question and the result; CH-answer-2 a button press shows the same bubble
plus the tick; CH-answer-3 a turn with no question shows no such bubble; CH-answer-4 the thread
scroll pin (CH-scroll) still passes.

## Files you own / must not touch

Own: `src/lib/voice/localRecognizer.ts` (the `withFallback` function only), `src/test/localRecognizer.test.ts`,
`src/features/board/components/CommandBar.tsx`, `CommandBar.module.css` if the bubble needs a
rule (it should reuse `.bubble` with `data-side="you"`), `src/test/commandBar.test.tsx`.
Do not touch `CreatePopover*`, `Popover*` (another lane is being reviewed there), `clipServer.ts`,
`trace.ts`, `score.mjs`, `BoardPage.tsx`, `docs/plan.yaml`. Do not run the full `npm run test`;
run `npx vitest run src/test/localRecognizer.test.ts src/test/commandBar.test.tsx
src/test/commandLauncher.test.tsx`. Prettier, eslint, tsc on your files. Do not commit.

## Report

Under 30 lines: the two forwarding sites; the shape guard and how tsc catches a missing key;
the interim ref's three sites; the answer bubble's condition and the sentinel; pin ids; totals.
