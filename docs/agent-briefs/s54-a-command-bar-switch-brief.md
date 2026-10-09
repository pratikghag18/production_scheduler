# Brief S54-a: the command bar switch — a plant setting with three positions

Stage S54, requirement R-403 (read it in `docs/plan.yaml`; its claim is the contract), design
§19.100 (D129). No other lane is running. This is a migration plus a client change; read
CLAUDE.md section 4 first, every line of it applies here (a nullable column, `tsc` inconclusive
until `db:types`, extract never retype, the definer resolver, the role walk).

## 1. What exists (read first)

- Migration `supabase/migrations/20260904000050_plant_settings.sql` (the `node_settings` table,
  its two CHECK constraints, §3 the definer resolver), `20260907000063_plant_timezone.sql`
  (the LAST text of: the two constraints dropped and re-added, `set_node_setting` with its
  per-key `CASE`, `clear_node_setting`, and `board_window` — the whole function, with
  `'date_format'` resolved for `p_root_path` through `app_resolve_node_setting` and COALESCEd
  to the client's default), `20260904000049_org_eligibility_policy.sql`
  (`set_org_eligibility_policy`: the company-wide writer pattern, its grants), and
  `20260907000068_…` (the resolver's current text; unchanged here).
- `supabase/tests/73_plant_settings_test.sql` (P1–P17; P16/P17 the fail-open cases),
  `63_org_date_format_test.sql` (the company writer cases, the file's shape: one BEGIN, a
  savepoint per case, `PASS`/`FAIL` notices). `scripts/run-sql-test.sh` runs one file on a
  scratch database (`bash scripts/run-sql-test.sh --rebuild` first, then `bash
  scripts/run-sql-test.sh <file>`); `node scripts/tester-run.mjs --sql` runs them all.
- The client: `src/lib/api/access.ts` (`NodeSettingKey`, `NODE_SETTING_KEYS`,
  `fetchPlantSettings`, `setNodeSetting`/`clearNodeSetting`, `setOrgEligibilityPolicy`),
  `src/features/admin/hooks/useOrgSettings.ts` (`ELIGIBILITY_POLICIES`, `coerce…`,
  `useCompany…`, `useSet…`, `PlantOverrides`, `usePlantOverrides`, the one mutation for every
  row), `src/features/admin/components/SettingsPanel.tsx` (the eligibility row ~line 520: the
  select with `INHERIT_CHOICE`, the consequence line, `write(key, value)`), `src/lib/api/shapes.ts`
  (`BoardWindow`'s parse: `date_format` read into a closed enum with a default),
  `src/features/board/BoardPage.tsx` (~line 807: `{canPlace && commandCtx !== null && (<CommandLauncher … recognizer={BOARD_RECOGNIZER} …/>)}`),
  `CommandBar.tsx` ~line 1444 (`{recognizer && (` — the microphone renders only when a
  recogniser is given). `src/lib/database.types.ts` is generated: `npm run db:types` after the
  migration is applied, never edited by hand.
- Tests: `src/test/apiPlantSettingsShape.test.ts`, `src/test/settingsPanel.test.tsx` if it
  exists (Glob for `settingsPanel*`), `src/test/commandLauncher.test.tsx`, the board's own
  tests (Glob `src/test/boardPage*`), `e2e/roleWalk.spec.ts` (asserts the launcher for placing
  roles and none for viewers — the default stays `voice`, so it must stay green unchanged).
- How a migration reaches the running stack here: NEVER `supabase migration up` and NEVER
  `npm run db:reset`; apply the file with
  `docker exec -i supabase_db_production_scheduler psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/migrations/<file>`
  from PowerShell (`Get-Content <file> | docker exec -i … psql …` if `<` is refused), then
  `npm run db:types`, then `npx tsc --noEmit -p .` is conclusive.

## 2. What to build

1. **Migration `20260914000081_command_bar_setting.sql`.** In this order, each with a comment
   saying why (copy the register of 0063):
   - Drop and re-add `node_settings_key_check` (keys: the three plus `command_bar`) and
     `node_settings_value_check` (one more `WHEN 'command_bar' THEN value IN ('off','typed','voice')`).
   - `set_node_setting`: re-emit 0063's text with ONE more key in the `NOT IN` list and ONE more
     `WHEN`; nothing else moves. `clear_node_setting`: re-emit only if it names the keys
     (read it; if it is generic, leave it).
   - `set_org_command_bar(p_value text) returns jsonb`: `set_org_eligibility_policy`'s body
     with the key and the value list swapped; the same `api_raise` shapes (`field:
     'command_bar'`); REVOKE from public, GRANT to authenticated, a `comment on function`.
   - `board_window`: re-emit 0063's text with one key added right after `'date_format'`:
     `'command_bar', COALESCE(app_resolve_node_setting(<the same root subquery>, 'command_bar'), 'voice')`.
     **Assemble it with a script** (`scripts/migrations/assemble-0081.mjs` or under
     `C:\Users\prati\.claude\jobs\0586b6d2\tmp\` — say which): slice `board_window` out of 0063
     between its `create or replace function` line and the closing `$$;`, assert the sliced
     text contains the guards you expect (`can_place`, `date_format`, `app_resolve_node_setting`,
     `p_root_path`, `node_policies`), insert the one line, assert the result differs from the
     source by exactly that insertion (a diff of one hunk), and write the migration from the
     assembled text. Report the script and the assertion output. The migration's header says
     which migration's text is live for each re-emitted function (0063 for both).
   - The `comment on constraint`/`comment on column` lines 0063 carries for the key: update
     to name the fourth key.
2. **Apply it** to the running stack (the command above), then `npm run db:types`; confirm
   `set_org_command_bar` appears in `database.types.ts` and `board_window`'s return type is
   unchanged (it is `jsonb`). Then `tsc` is conclusive.
3. **SQL cases**, new `supabase/tests/98_command_bar_setting_test.sql` (the next free number when built; 74 to 97 were taken) (check the highest
   existing number first with Glob and take the next), C0–C9: C0 the roles fixture as 63/73
   do; C1 the value check accepts the three and refuses `on`, `''` and a JSON-null-style empty
   (23514), and NOT NULL refuses a null (23502); C2 `set_node_setting(plant, 'command_bar',
   'typed')` by the plant's admin stores and returns `effective = 'typed'`; C3 a supervisor is
   refused `not_permitted`; C4 `clear_node_setting` removes the row and `effective` falls to
   the company's or `NULL`; C5 `set_org_command_bar('off')` by a1 stores it and the settings bag's
   siblings survive, a2 refused; C6 `app_resolve_node_setting(line, 'command_bar')` answers the
   PLANT's override for a line under it; C7 (the fail-open case, as P16) a SUPERVISOR whose board
   is rooted at a line she may read, under a plant root she may NOT read that is set to `off`,
   calls `board_window` for her root and gets `command_bar = 'off'`; C8 with no row anywhere
   `board_window` gives `'voice'`; C9 an unknown value through `set_node_setting` is
   `invalid_argument` naming `command_bar`. Run `--rebuild`, then this file, 73, 63 and 40,
   and report each file's PASS/FAIL tally.
4. **The client.**
   - `access.ts`: `NodeSettingKey` and `NODE_SETTING_KEYS` gain `"command_bar"`;
     `setOrgCommandBar(value)` beside `setOrgEligibilityPolicy` (same error mapping);
     `COMMAND_BAR_MODES = ["off","typed","voice"] as const`, `type CommandBarMode`.
   - `shapes.ts`: `BoardWindow` gains `commandBar: CommandBarMode`; the parse reads
     `command_bar`, defaults a MISSING key to `"voice"` (an older window) and maps an
     unrecognised string to `"off"` (fails safe) — with the comment saying why each way.
   - `useOrgSettings.ts`: `coerceCommandBar`, `useCompanyCommandBar`, `useSetCommandBar`,
     `asCommandBar`, `PlantOverrides.commandBar`, the fourth query in `usePlantOverrides`.
   - `SettingsPanel.tsx`: a row "The command bar" in the Scheduling card under the eligibility
     row: label `Telling the board what to do by typing or by voice`, hint `The button in the
     lower right of the board. Switch it off while a plant gets used to the board, or allow
     typing only.`, options `Off — no button`, `Typed only — the button and the bar, no
     microphone`, `Typed and voice — everything` (values off/typed/voice), the inherit option
     and the consequence line exactly like the eligibility row (`inheritingNote`/`setHereNote`
     with the short labels `off` / `typed only` / `typed and voice`), the same busy/error
     handling through `write("command_bar", …)`.
   - `BoardPage.tsx`: the launcher renders when `canPlace && commandCtx !== null &&
     window.commandBar !== "off"`, and gets `recognizer={window.commandBar === "voice" ?
     BOARD_RECOGNIZER : null}` (find where the window's `dateFormat` is read and read
     `commandBar` beside it). Nothing else.
5. **Tests.** `apiPlantSettingsShape.test.ts`: the parse of `command_bar` (present, missing →
   voice, unknown → off). The settings panel test (or a new `src/test/settingsPanelCommandBar.test.tsx`
   if none exists — read how `shiftsPanel.test.tsx` renders with a query client and mocked
   fetches): SP-cb-1 the row shows the company value and the three options; SP-cb-2 choosing
   `typed` on a plant calls `set_node_setting` with `command_bar`/`typed`; SP-cb-3 choosing
   inherit calls `clear_node_setting`; SP-cb-4 the consequence line names what is in force.
   The board gate: a small pure helper `launcherFor(mode, canPlace)` in
   `src/features/board/lib/commandBarGate.ts` returning `{ show, voice }` with a test
   `commandBarGate.test.ts` (G1–G4: off/typed/voice/unknown × canPlace), used by BoardPage so
   the rule is pinned without rendering the whole board. Run `npx vitest run <your test files>
   src/test/commandLauncher.test.tsx src/test/commandBar.test.tsx src/test/commandPurity.test.ts`,
   `npx tsc --noEmit -p .` (after db:types), eslint and prettier on your files, then
   `npx playwright test e2e/roleWalk.spec.ts --workers=1`.

## 3. Rules

- Files you own: the new migration and its assembly script, the new SQL test file, `access.ts`,
  `shapes.ts`, `useOrgSettings.ts`, `SettingsPanel.tsx` (and its CSS module only if a new
  class is unavoidable), `BoardPage.tsx` (the gate only), the new `commandBarGate.ts`, the test
  files named, `database.types.ts` only through `npm run db:types`. Not `CommandBar.tsx`, not
  `CommandLauncher.tsx`, not `docs/plan.yaml`.
- Migrations are append-only; never edit an existing one. Never `npm run db:reset`; never
  `supabase migration up`. If applying the migration fails half-way, say exactly which
  statement and stop; do not "fix forward" by hand in the database.
- Re-emit, never retype: the assembled `board_window` and `set_node_setting` must be 0063's
  bytes plus the named insertions; the reviewer will diff them.
- No new dependencies. Do not run the full `npm run test`. Do not commit.
- Report: the files with a line each; the assembly script's assertion output and the one-hunk
  diff; the SQL tally per file; the `db:types` diff summary (`git diff --stat
  src/lib/database.types.ts`); every test title; vitest/tsc/lint/roleWalk summaries;
  `git diff --stat`.
