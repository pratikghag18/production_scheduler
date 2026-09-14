# Brief S47-a: the outline and the spoken yes — a sentence shows what it will do, a word does it

Stage S47, requirement R-395 (read it in `docs/plan.yaml` first; its claim is the contract).
S46 (the microphone) and S44 (the model reader) are committed; you build on them.

## 1. What exists (read first)

- `src/features/board/components/CommandBar.tsx`: `runCommand(command)` resolves through
  `resolveCommand(command, ctx)`; a resolution that is a question becomes a `Status` of kind
  `question` with `candidates` (buttons) via `questionToStatus`. The relevant questions:
  `remove_which` (one or more blocks; with one block the single button says "Remove it"),
  `move_which` (blocks to move), `block_exists` (R-385: a person's own block overlaps — the
  buttons offer to re-time it or make a separate block). Each button calls `pickExisting(...)`,
  which re-runs the command with `existing` set, and the resolved command then reaches the
  board through `onUnassign` / `onMove` / `onRetime`. Those callbacks are the ONLY writers;
  you add no other. `heldRef` holds the last command. Escape: first press clears the status,
  second clears the input. `submitText(text)` is what Enter and a final speech result call
  (S46). `reader` and `recognizer` props exist.
- `src/features/board/BoardPage.tsx` renders `<CommandBar ...>` with those callbacks and holds
  the create pop-up (`popover` state; `<CreatePopover key={popover.seq} ...>`). R-384: when the
  pop-up is clean, Enter creates. Read `CreatePopover`'s props to find how a submit is triggered
  from outside, or add a small imperative handle (`useImperativeHandle`) exposing
  `submitIfClean(): boolean`, whichever is smaller.
- The board draws blocks; find the component that renders an assignment block and its CSS
  module (grep for the assignment id in a `data-` attribute or a `key`). You add one visual
  state to it; reuse the existing outline/ring tokens (`--ring`, the danger colour already used
  by Delete) — no new colours.
- `src/test/commandBar.test.tsx` (`renderBar`, the CB-model and CB-mic describes) and the
  board tests under `src/test/` that render blocks (find the one that asserts a block's class
  or attribute; add beside it).
- `src/test/commandPurity.test.ts` U2: the bar must never contain `createAssignment`,
  `useCreateAssignment`, `supabase`, `@/lib/api/mutations`. Stays green.

## 2. What to build

1. **The bar tells the board what is in question.** A new optional prop on `CommandBar`:
   `onHighlight?: (h: Highlight | null) => void` where
   `type Highlight = { kind: "remove" | "move" | "retime"; assignmentIds: string[] }` (export
   the type from the bar's module or a tiny `src/features/board/lib/highlight.ts`). Call it
   with the candidates' ids whenever a `remove_which`, `move_which` or `block_exists`
   question is set as the status; call it with `null` whenever that status is replaced,
   cleared (Escape, edit, a new sentence, a candidate click), or the bar unmounts.
2. **The board draws it.** `BoardPage` keeps `highlight` state and passes it down so the
   assignment block with a matching id renders with a class: `.outlineRemove` (danger colour,
   2px solid, inset so layout does not move) or `.outlineMove` (the ring/accent colour). Blocks
   not in the set are unchanged. No animation.
3. **Yes and no.** In the bar, when the current status is a question whose candidates act on
   blocks (the three kinds above) and there is exactly ONE candidate, the message gets the
   suffix ` — say or type yes to do it, no to leave it.` and `submitText` recognises
   confirmation words before parsing: `yes`, `yes please`, `confirm`, `do it`, `remove it`,
   `move it`, `ok` (case-insensitive, trimmed, trailing punctuation ignored) run that single
   candidate's `onClick`; `no`, `cancel`, `leave it`, `stop` clear the status and the outline
   and leave the input empty. With SEVERAL candidates, a bare yes sets the status message to
   `Which one? ` followed by the candidates' labels joined with ", " (buttons stay); no/cancel
   clears as above. When no such question stands, these words are ordinary text and go through
   the normal path (the rules will refuse them with the usual shape hint).
4. **Yes for the pop-up.** `BoardPage` passes `onConfirmWord?: () => boolean` into the bar (the
   bar calls it when a yes arrives and no question stands): it returns true when a create
   pop-up opened by a sentence is showing and could create on Enter (R-384's clean condition)
   and it has submitted it; false otherwise (then the bar treats the word as text). `no` while
   such a pop-up is open closes it. Do not weaken R-384's condition; if the pop-up would show
   something to decide, yes does nothing and the bar says `The pop-up needs a decision first.`
5. **Tests.**
   - `commandBar.test.tsx`, `describe("CB-yes: ...")`: CB-yes-1 a remove sentence with one
     matching block calls `onHighlight({kind:"remove", assignmentIds:[id]})` and the message
     ends with the yes suffix; CB-yes-2 typing `yes` + Enter calls `onUnassign` with that block
     and `onHighlight(null)`; CB-yes-3 `no` clears status, outline and input, `onUnassign` never
     called; CB-yes-4 two matching blocks: both ids highlighted, no suffix, `yes` → the
     "Which one?" message and no write; CB-yes-5 a spoken final result `yes` (via the fake
     recogniser from CB-mic) confirms exactly like typing; CB-yes-6 Escape clears the highlight;
     CB-yes-7 a new sentence replaces the highlight; CB-yes-8 `yes` with no question and
     `onConfirmWord` returning false goes to the rules (shape hint) and returning true calls it
     once and clears the input; CB-yes-9 a move sentence highlights with kind "move" and yes
     reaches `onMove`.
   - A board-level test: the block with the highlighted id carries `.outlineRemove` and the
     others do not (find the existing block-rendering test to extend, or add a small one).
   - Run those files plus `commandPurity.test.ts`, then `npx tsc --noEmit -p .`, eslint and
     prettier on your files, then `npx playwright test e2e/roleWalk.spec.ts`.

## 3. Rules

- Files you own: `CommandBar.tsx` and its CSS module, `BoardPage.tsx`, the block component
  and its CSS module (name them in the report), an optional `src/features/board/lib/highlight.ts`,
  `CreatePopover.tsx` only if an imperative handle is needed, `src/test/commandBar.test.tsx`,
  and the one board test file you extend or add. Not `src/lib/command/*`, not `src/lib/voice/*`,
  not `docs/plan.yaml`.
- The bar stays free of the U2 needles; every write still goes through `onUnassign`,
  `onMove`, `onRetime` or the pop-up. No new dependencies. Do not run the full `npm run test`.
  Do not commit.
- Report: the files touched with a line each, the exact suffix and messages, each test's title,
  the vitest/tsc/lint/roleWalk summaries, `git diff --stat`.
