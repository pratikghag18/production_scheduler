# Brief S44-b: the command bar reads through the model service, and falls back to the rules and says so

Stage S44, requirement R-393, design §19.92 (D121). You are lane B. Lane A is writing the
serving side (`scripts/voice/serve/*`, `vite.config.ts`, `package.json`, `.gitignore`,
`.env.example`) at the same time; you never touch those. The contract between you is §2 and is
not yours to change; if it cannot work, stop and say why.

## 1. What exists (read these first)

- `src/features/board/components/CommandBar.tsx` (480 lines): `handleKeyDown` on Enter calls
  `parseCommand(text)` (the rules, `src/lib/command/parse.ts`) and then `runCommand(command)`,
  which resolves through `resolveCommand` and either sets a status (a question, a readout via
  `renderReadout`) or calls one of the `onOpen`/`onBook`/... callbacks that open the pop-up.
  `heldRef` keeps the last command for the candidate buttons. `status` is a `Status` union
  rendered in the `aria-live="polite"` status line.
- `src/test/commandBar.test.tsx` (653 lines): how the bar is rendered with a `ctx` and the
  callbacks, and how Enter and the status line are asserted. Add to it; do not restructure it.
- `src/test/commandPurity.test.ts`: U1 walks every `.ts` file in `src/lib/command/` and fails on
  any runtime import, `require(`, `new Date(` or `Intl.`; U2 fails if `CommandBar.tsx` contains
  `createAssignment`, `useCreateAssignment`, `supabase` or `@/lib/api/mutations`. Both stay
  green. This is why your new modules live in `src/lib/voice/`, not `src/lib/command/`.
- `scripts/voice/train/system_prompt.txt`: the prompt the model was trained on. The app must
  send this file's bytes, imported as text (`?raw`), never a copy.
- `src/lib/command/parse.ts` exports `Command` (`AssignCommand | BookCommand | UnassignCommand |
  MoveCommand`), `parseCommand`, `formatCommand`. Read the four interfaces; the decoder in §3
  mirrors them exactly. Every field is required; `attach` and `existing` are `null` from a
  reader (the app fills them later), as `parseCommand` returns them.
- `src/vite-env.d.ts` declares `ImportMetaEnv`; add `readonly VITE_VOICE_URL?: string`.

## 2. The contract (fixed; lane A builds the service against the same text)

- Base URL: `import.meta.env.VITE_VOICE_URL`. Unset or empty means NO service: the bar behaves
  exactly as today and makes no request. In development the value is `/voice` (a Vite proxy
  lane A adds; you do not need it running to build or test).
- Request: `POST ${base}/v1/chat/completions`, `Content-Type: application/json`, body exactly:

  ```json
  {
    "messages": [
      {"role": "system", "content": "<system_prompt.txt bytes>"},
      {"role": "user", "content": "<the typed sentence>"}
    ],
    "temperature": 0,
    "max_tokens": 256,
    "cache_prompt": true,
    "chat_template_kwargs": {"enable_thinking": false}
  }
  ```

- Answer: `choices[0].message.content` is text; the form is the first complete top-level
  `{...}` in it (scan braces, honour strings and escapes; port the notebook's
  `extract_first_json_object` idea from `scripts/voice/train/train_qwen3.ipynb`), parsed as
  JSON, then decoded (§3). Anything else is "garbled".

## 3. What to build

1. `src/lib/voice/decode.ts` — `decodeCommand(value: unknown): Command | null`. Accepts an
   object whose `intent` is one of the four; requires every field of that intent's interface
   with the right shape (`operator`/`product` non-empty strings; `place`/`toPlace` arrays of
   non-empty strings, `toPlace` may be null; `day` null or one of the four kinds with their
   fields; `start`/`end` `{hour 0-23, minute 0-59}` integers; `span` null or `{start, end}`;
   `headcount` null or a positive integer; `attach` and `existing` forced to `null` whatever
   the model wrote). Ignores extra keys at the top level and inside `day`, `start`, `end`,
   `span` (F-140's lesson). Returns a fresh object built field by field, never the input.
   Pure, no imports beyond `import type` from parse.ts.
2. `src/lib/voice/readSentence.ts` — the reader:

   ```ts
   export type Reading =
     | { ok: true; command: Command; by: "model" }
     | { ok: false; reason: "no-service" | "unavailable" | "timeout" | "garbled"; detail?: string };
   export type Reader = (text: string, signal: AbortSignal) => Promise<Reading>;
   export const SYSTEM_PROMPT: string;            // the ?raw import, re-exported
   export function voiceServiceUrl(): string | null; // VITE_VOICE_URL, trimmed, or null
   export function makeReader(opts?: { baseUrl?: string | null; fetch?: typeof fetch; timeoutMs?: number }): Reader;
   export const readSentence: Reader;             // makeReader() with the env and global fetch
   ```

   `no-service` when the base URL is null (no fetch call). `unavailable` on a network error or a
   non-2xx status. `timeout` when `timeoutMs` (default 20000, generous because the first call on
   a cold cache pays the 450-token prompt) elapses; combine the caller's signal and the timeout
   without `AbortSignal.any` (jsdom may lack it): one controller, listeners on both. `garbled`
   when the content has no object, is not JSON, or `decodeCommand` refuses. Never throws.
   The `?raw` import path is relative from `src/lib/voice/` to `scripts/voice/train/`; if tsc
   or eslint objects to the path, say so in the report rather than copying the file.
3. `CommandBar.tsx` — a new optional prop `reader?: Reader | null` (default `null`). Behaviour:
   - `reader` null: unchanged, byte for byte in behaviour; every existing test passes untouched.
   - `reader` set, Enter: set a pending status (`{ kind: "reading" }`, rendered as
     `Reading…`), keep the input editable, call `reader(text, signal)`. Keep a sequence number:
     when the promise settles and a newer Enter, Escape or edit has happened since, discard it.
     - `ok`: `runCommand(command)`; when that produces a readout status, append ` · read by the
       model` to the readout text. When it opens the pop-up, nothing more.
     - not ok, reason `no-service`: exactly the null-reader path (no suffix).
     - not ok otherwise: `parseCommand(text)`; on success `runCommand` and append ` · read by the
       rules (<why>)` to a readout, where `<why>` is `the model service is off` for
       `unavailable`, `the model took too long` for `timeout`, `the model's answer was not a
       form` for `garbled`. On failure, the existing failure status with its message prefixed by
       `The model service is off, so the rules read this: ` (and the other two whys likewise).
   - A second Enter while reading aborts the first reading and starts again with the current
     text. Escape while reading aborts and clears the status (then the existing Escape rules).
     Any edit aborts (the existing "any edit clears the held command" rule already runs here).
   - The candidate-button and attach/existing paths are unchanged: they re-read a canonical
     sentence through the rules, as now.
   - Keep the bar free of the U2 needles. One CSS class for the reading state if you need it,
     in `CommandBar.module.css`.
4. `src/features/board/BoardPage.tsx` — pass `reader={voiceServiceUrl() ? readSentence : null}`
   (compute once with `useMemo` or at module level; no request is made by computing it).
5. Tests:
   - New `src/test/voiceRead.test.ts`, cases named VR1–VR7 in the `it` titles:
     VR1 each of the four forms decodes: take a canonical sentence per intent, `parseCommand`
     it, `JSON.stringify` the command, `decodeCommand(JSON.parse(...))` equals it.
     VR2 a missing field and a mistyped field (`hour: "7"`) are refused.
     VR3 an invented key at the top level and inside `start` is ignored; `attach`/`existing`
     are null even if the model wrote something.
     VR4 fetch rejects → `unavailable`; a 503 → `unavailable`.
     VR5 a fetch that never resolves with `timeoutMs: 20` → `timeout`; content with no object,
     content with bad JSON, and a valid object that fails decoding → `garbled`.
     VR6 the request body's system message equals `fs.readFileSync("scripts/voice/train/system_prompt.txt", "utf8")`
     byte for byte, and the body carries the other four fields of §2 exactly.
     VR7 `makeReader({ baseUrl: null })` → `no-service` and the fake fetch is never called.
   - `src/test/commandBar.test.tsx`, a new `describe("CB-model: ...")` with a fake reader:
     the model's form opens the pop-up exactly as the typed fixed sentence would (compare the
     `onOpen` argument with the rules' own result for the canonical sentence); the reader
     answering `unavailable` falls back to the rules and the status says `read by the rules (the
     model service is off)`; `Reading…` shows while pending and a second Enter aborts the first
     (assert the first signal is aborted) and reads again; Escape aborts and clears; a null
     reader makes no call (one explicit case with a spy reader passed as `null`).
   - Run `npx vitest run src/test/voiceRead.test.ts src/test/commandBar.test.tsx src/test/commandPurity.test.ts`
     and paste the summary. Then `npx tsc --noEmit -p .` and `npx eslint` + `npx prettier --check`
     on every file you touched.

## 4. Rules

- Files you own: `src/lib/voice/*`, `src/features/board/components/CommandBar.tsx` and its
  `.module.css`, `src/features/board/BoardPage.tsx` (the one prop), `src/vite-env.d.ts`, the two
  test files. Nothing else; not `src/lib/command/*`, not `vite.config.ts`, not `docs/plan.yaml`.
- No new dependencies. Do not run the full `npm run test`. Do not commit.
- Report: the new modules' exports, the bar's changed paths in prose, the vitest summary
  lines, tsc/eslint/prettier results, `git diff --stat`.
