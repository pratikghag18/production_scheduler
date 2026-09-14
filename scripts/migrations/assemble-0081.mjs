#!/usr/bin/env node
/**
 * Assembles migration 20260914000081_command_bar_setting.sql's re-emitted
 * halves -- board_window, set_node_setting and clear_node_setting -- by
 * SLICING them out of 20260907000063_plant_timezone.sql's own bytes, never
 * retyping them (CLAUDE.md §4, DEF-0011's lesson: 0053 re-emitted a function
 * from the wrong migration and silently dropped a rule).
 *
 * For each function this script:
 *   1. slices it out of 0063's text between its own start anchor and its own
 *      end anchor;
 *   2. asserts the sliced text contains the guards a correct extraction must
 *      still carry (so a wrong start/end anchor is caught here, not in review);
 *   3. applies ONE OR TWO anchored, uniqueness-checked textual edits (the same
 *      discipline an Edit-tool old_str/new_str pair uses) -- never a blind
 *      string rewrite;
 *   4. computes a line-level diff between the original slice and the edited
 *      one and asserts the number of contiguous changed regions ("hunks")
 *      matches what the edit is supposed to be: board_window is a pure
 *      insertion (one hunk, nothing removed); set_node_setting and
 *      clear_node_setting each get two edits in two separate places (two
 *      hunks).
 *
 * Run: `node scripts/migrations/assemble-0081.mjs`. Prints every assertion's
 * PASS/FAIL and each hunk's before/after text, then writes the finished
 * migration file. Exits non-zero on the first failed assertion, before
 * writing anything.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const SOURCE_PATH = join(ROOT, "supabase", "migrations", "20260907000063_plant_timezone.sql");
const OUT_PATH = join(ROOT, "supabase", "migrations", "20260914000081_command_bar_setting.sql");

const source = readFileSync(SOURCE_PATH, "utf8");

let failures = 0;
function assert(label, cond) {
  const line = `${cond ? "PASS" : "FAIL"} -- ${label}`;
  console.log(line);
  if (!cond) failures++;
}

/** Slice `source` between the first line containing `startNeedle` and the
 *  first line containing `endNeedle` AT OR AFTER it (inclusive of both). */
function slice(text, startNeedle, endNeedle, label) {
  const startIdx = text.indexOf(startNeedle);
  assert(`${label}: start anchor found`, startIdx !== -1);
  const endIdx = text.indexOf(endNeedle, startIdx);
  assert(`${label}: end anchor found after start`, endIdx !== -1);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error(`${label}: could not slice -- fix the anchors before trusting anything else`);
  }
  return text.slice(startIdx, endIdx + endNeedle.length);
}

/** Exactly-once anchored replace, the Edit-tool discipline: refuses to touch
 *  text it cannot uniquely locate. */
function replaceOnce(text, oldStr, newStr, label) {
  const first = text.indexOf(oldStr);
  const last = text.lastIndexOf(oldStr);
  assert(`${label}: anchor occurs exactly once`, first !== -1 && first === last);
  if (first === -1 || first !== last) {
    throw new Error(`${label}: anchor not unique -- refusing to edit blindly`);
  }
  return text.slice(0, first) + newStr + text.slice(first + oldStr.length);
}

/** Longest-common-subsequence line diff -> contiguous hunks (remove/add runs
 *  between stretches of identical lines), the same shape `diff -u` groups
 *  changes into. Small inputs (a few hundred lines), so the O(n*m) table is
 *  cheap. */
function diffHunks(a, b) {
  const A = a.split("\n");
  const B = b.split("\n");
  const n = A.length;
  const m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      ops.push({ kind: "eq", line: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "del", line: A[i] });
      i++;
    } else {
      ops.push({ kind: "add", line: B[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "del", line: A[i++] });
  while (j < m) ops.push({ kind: "add", line: B[j++] });

  // Group consecutive non-"eq" ops into hunks.
  const hunks = [];
  let cur = null;
  for (const op of ops) {
    if (op.kind === "eq") {
      cur = null;
      continue;
    }
    if (cur === null) {
      cur = { removed: [], added: [] };
      hunks.push(cur);
    }
    if (op.kind === "del") cur.removed.push(op.line);
    else cur.added.push(op.line);
  }
  return hunks;
}

function printHunks(label, hunks) {
  console.log(`--- ${label}: ${hunks.length} hunk(s) ---`);
  for (const [idx, h] of hunks.entries()) {
    console.log(`  hunk ${idx + 1}: -${h.removed.length} +${h.added.length}`);
    for (const l of h.removed) console.log(`    - ${l}`);
    for (const l of h.added) console.log(`    + ${l}`);
  }
}

// ===========================================================================
// 1. board_window -- pure insertion, one key added right after date_format.
// ===========================================================================
const boardWindowOriginal = slice(
  source,
  "CREATE OR REPLACE FUNCTION public.board_window(",
  "$function$;",
  "board_window",
);
for (const guard of [
  "can_place",
  "date_format",
  "app_resolve_node_setting",
  "p_root_path",
  "node_policies",
]) {
  assert(`board_window guard present: ${guard}`, boardWindowOriginal.includes(guard));
}

const DATE_FORMAT_BLOCK =
  "    'date_format', COALESCE(\n" +
  "      app_resolve_node_setting((SELECT sn.id FROM scoped_nodes sn WHERE sn.path = p_root_path),\n" +
  "                               'date_format'), 'd_mon_yyyy'),\n";
const COMMAND_BAR_INSERT =
  DATE_FORMAT_BLOCK +
  "\n" +
  "    -- THE KEY THIS MIGRATION EXISTS FOR (R-403, D129). The command bar mode\n" +
  "    -- RESOLVED for the board's own root, the same COALESCE-at-the-call-site\n" +
  "    -- twin as date_format and timezone above: 'voice' is the key's own\n" +
  "    -- default, and the behaviour every board had before this setting\n" +
  "    -- existed, so a board with no override anywhere is unchanged.\n" +
  "    'command_bar', COALESCE(\n" +
  "      app_resolve_node_setting((SELECT sn.id FROM scoped_nodes sn WHERE sn.path = p_root_path),\n" +
  "                               'command_bar'), 'voice'),\n";

const boardWindowEdited = replaceOnce(
  boardWindowOriginal,
  DATE_FORMAT_BLOCK,
  COMMAND_BAR_INSERT,
  "board_window: insert command_bar key after date_format",
);

const boardWindowHunks = diffHunks(boardWindowOriginal, boardWindowEdited);
printHunks("board_window", boardWindowHunks);
assert("board_window: exactly one hunk", boardWindowHunks.length === 1);
assert(
  "board_window: the hunk is a pure insertion (nothing removed)",
  boardWindowHunks[0]?.removed.length === 0,
);

// ===========================================================================
// 2. set_node_setting -- one key in the NOT IN list, one WHEN branch.
// ===========================================================================
const setNodeSettingOriginal = slice(
  source,
  "create or replace function set_node_setting(p_node_id uuid, p_key text, p_value text)",
  "\nEND $$;",
  "set_node_setting",
);
for (const guard of [
  "'eligibility_policy', 'date_format', 'timezone'",
  "app_is_admin_for",
  "ON CONFLICT (node_id, key)",
]) {
  assert(`set_node_setting guard present: ${guard}`, setNodeSettingOriginal.includes(guard));
}

const SNS_KEY_LIST_OLD =
  "  IF p_key IS NULL OR p_key NOT IN ('eligibility_policy', 'date_format', 'timezone') THEN";
const SNS_KEY_LIST_NEW =
  "  IF p_key IS NULL OR p_key NOT IN ('eligibility_policy', 'date_format', 'timezone', 'command_bar') THEN";

const SNS_CASE_OLD =
  "                               WHEN 'timezone' THEN\n" +
  "                                    EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_value)\n" +
  "                               ELSE false\n";
const SNS_CASE_NEW =
  "                               WHEN 'timezone' THEN\n" +
  "                                    EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_value)\n" +
  "                               WHEN 'command_bar' THEN p_value IN ('off', 'typed', 'voice')\n" +
  "                               ELSE false\n";

let setNodeSettingEdited = replaceOnce(
  setNodeSettingOriginal,
  SNS_KEY_LIST_OLD,
  SNS_KEY_LIST_NEW,
  "set_node_setting: widen the key list",
);
setNodeSettingEdited = replaceOnce(
  setNodeSettingEdited,
  SNS_CASE_OLD,
  SNS_CASE_NEW,
  "set_node_setting: add the command_bar WHEN branch",
);

const setNodeSettingHunks = diffHunks(setNodeSettingOriginal, setNodeSettingEdited);
printHunks("set_node_setting", setNodeSettingHunks);
assert(
  "set_node_setting: exactly two hunks (the key list, the WHEN branch)",
  setNodeSettingHunks.length === 2,
);

// ===========================================================================
// 3. clear_node_setting -- it NAMES the keys (not generic), so it is
//    re-emitted too, with the same widened key list. Its body is otherwise
//    untouched -- it does not branch on the value at all.
// ===========================================================================
const clearNodeSettingOriginal = slice(
  source,
  "create or replace function clear_node_setting(p_node_id uuid, p_key text)",
  "\nEND $$;",
  "clear_node_setting",
);
for (const guard of [
  "'eligibility_policy', 'date_format', 'timezone'",
  "app_is_admin_for",
  "ROW_COUNT WOULD BE A LIE",
]) {
  assert(`clear_node_setting guard present: ${guard}`, clearNodeSettingOriginal.includes(guard));
}

const CNS_KEY_LIST_OLD =
  "  IF p_key IS NULL OR p_key NOT IN ('eligibility_policy', 'date_format', 'timezone') THEN";
const CNS_KEY_LIST_NEW =
  "  IF p_key IS NULL OR p_key NOT IN ('eligibility_policy', 'date_format', 'timezone', 'command_bar') THEN";

const clearNodeSettingEdited = replaceOnce(
  clearNodeSettingOriginal,
  CNS_KEY_LIST_OLD,
  CNS_KEY_LIST_NEW,
  "clear_node_setting: widen the key list",
);

const clearNodeSettingHunks = diffHunks(clearNodeSettingOriginal, clearNodeSettingEdited);
printHunks("clear_node_setting", clearNodeSettingHunks);
assert("clear_node_setting: exactly one hunk (the key list)", clearNodeSettingHunks.length === 1);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed. Nothing written.`);
  process.exit(1);
}

console.log(`\nAll assertions passed. Writing ${OUT_PATH}`);

// ===========================================================================
// The finished migration file.
// ===========================================================================
const migration = `-- ============================================================================
-- Migration 0081: the FOURTH key -- a plant's COMMAND BAR mode (D129, R-403).
--
-- The maintainer, session 164, 14 Sept: "Is there a way we can enable and
-- disable the chatbot from the settings? I'm thinking if I want to limit the
-- feature during the initial getting used to period." Shown the three values
-- (off, typed, voice): "Yes, go."
--
-- Exactly 0063's shape, one key later: a company-wide value in orgs.settings,
-- a per-place override in node_settings, resolved by the same
-- app_resolve_node_setting (SECURITY DEFINER) walk the other three keys use,
-- so a line supervisor whose board is rooted below a plant that switched the
-- bar off still gets 'off' even though the plant's row sits above her grant
-- (DEF-0016/DEF-0017's lesson, CLAUDE.md §4). The default, when nothing is
-- set anywhere, is 'voice' -- the board's behaviour before this migration --
-- so board_window's COALESCE keeps every existing board answering exactly as
-- it did yesterday until somebody touches the switch.
--
-- ⭐ THIS PAYS 0052's PRICED FIVE EDITS IN FOUR PLACES, PLUS A SIXTH: a
-- company-scope writer (set_org_command_bar, beside set_org_eligibility_policy)
-- because unlike timezone/date_format this key is a THIRD kind -- not a
-- display convention (date_format, timezone) and not a server-enforced
-- eligibility rule (eligibility_policy), but a CLIENT FEATURE GATE the board
-- reads and hides behind. Nothing on the server refuses a write because of it;
-- board_window is the only reader.
--   1. node_settings_key_check      -- DROP/re-add (append-only: no ALTER CHECK).
--   2. node_settings_value_check    -- DROP/re-add, one WHEN.
--   3. set_node_setting key list    -- re-emitted from 0063 (extract, not retype).
--   4. set_node_setting value CASE  -- one WHEN, same re-emission.
--   5. clear_node_setting key list  -- it NAMES the keys, so it is re-emitted too.
--   +  set_org_command_bar          -- the company-scope writer, set_org_eligibility_policy's
--                                       shape with the key and the value list swapped.
--   +  board_window                 -- the resolved key the client reads, one line
--                                       beside date_format, re-emitted from 0063.
--
-- ⭐ RE-EMITTED, NEVER RETYPED (CLAUDE.md §4, DEF-0011). board_window,
-- set_node_setting and clear_node_setting below are 0063's own bytes plus the
-- named insertions, assembled and guard-asserted by
-- scripts/migrations/assemble-0081.mjs -- run it to see the assertions and the
-- diff for yourself; it refuses to write this file if any assertion fails.
--
-- ⛔ THE VALUE CHECK IS TIGHT, UNLIKE timezone's. Three literal tokens
-- ('off', 'typed', 'voice'), not an open vocabulary a CHECK cannot validate --
-- so, unlike timezone, the table CHECK here is a real backstop and not merely
-- a loose one, exactly like eligibility_policy and date_format.
--
-- ⭐ NO BACKFILL, NO UPGRADE CHECK, for 0063's exact reason: adds no column,
-- table, policy or trigger; widens two CHECKs rather than narrowing them, so
-- every existing node_settings row (an eligibility_policy, date_format or
-- timezone row) satisfies the widened expressions unchanged. No row in
-- verify-db.sh's UPGRADE_CHECKS and no upgrade_0081_*.sql.
--
-- Proved by supabase/tests/98_command_bar_setting_test.sql.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. THE KEY CONSTRAINT. Dropped and re-added, not altered -- append-only.
-- ----------------------------------------------------------------------------
alter table node_settings drop constraint if exists node_settings_key_check;
alter table node_settings add constraint node_settings_key_check
  check (key in ('eligibility_policy', 'date_format', 'timezone', 'command_bar'));

-- ----------------------------------------------------------------------------
-- 2. THE VALUE CONSTRAINT. One more WHEN, still \`else false\` so an unknown
-- key can never store an unvalidated value. Unlike timezone's loose branch,
-- command_bar's three tokens are a closed, literal vocabulary a CHECK CAN
-- validate in full -- this is a real backstop, the same as eligibility_policy
-- and date_format's branches.
-- ----------------------------------------------------------------------------
alter table node_settings drop constraint if exists node_settings_value_check;
alter table node_settings add constraint node_settings_value_check
  check (case key
           when 'eligibility_policy' then value in ('warn', 'block')
           when 'date_format' then value in (
                'd_mon_yyyy', 'dmy_slash', 'mdy_slash', 'iso',
                'dmy_dash_mon', 'd_month_yyyy', 'month_d_yyyy', 'ymd_slash')
           when 'timezone' then value is not null and char_length(value) between 1 and 64
           when 'command_bar' then value in ('off', 'typed', 'voice')
           else false
         end);

comment on table node_settings is
  'R-331/R-333/R-353/R-403: a setting given an answer at ONE place in the structure, overriding the company''s. The row IS the override -- no row means this place inherits, which is why the value column is NOT NULL and clearing is a DELETE rather than a magic value (F-088). Resolved by app_resolve_node_setting: nearest ancestor-or-self with an answer, else orgs.settings, else the reader''s coded default. Four keys since 0081: eligibility_policy (read by the server, which enforces it), date_format (how a date reads, read only by the client), timezone (the IANA zone the board''s axis renders in, read only by the client; the value CHECK is loose because pg_timezone_names cannot be a CHECK subquery -- the writers validate it) and command_bar (off/typed/voice, read only by the client to decide whether the board offers the launcher and whether it offers the microphone; 0081, D129). A fifth key is five edits in four places, plus a company writer if it is not itself company-scoped already.';

comment on column node_settings.key is
  'Which setting: eligibility_policy, date_format, timezone or command_bar. Constrained to the keys this schema knows how to validate (node_settings_key_check).';

-- ----------------------------------------------------------------------------
-- 3. THE WRITERS. Re-emitted from 0063 by scripts/migrations/assemble-0081.mjs
-- (see its assertion output), with the key lists widened and one WHEN added to
-- set_node_setting's value CASE. Everything else -- SECURITY INVOKER, the
-- app_is_admin_for pre-check, the read-back after the DELETE -- is 0063's own
-- text, unchanged, and its reasoning stands in 0050/0063.
-- ----------------------------------------------------------------------------
${setNodeSettingEdited}

${clearNodeSettingEdited}

comment on function set_node_setting(uuid, text, text) is
  'R-331/R-333/R-353/R-403: give ONE place its own answer for ONE setting, overriding whatever it inherits. Keys: eligibility_policy, date_format (0052), timezone (0063), command_bar (0081). Admin-gated by app_is_admin_for -- the plant''s own admin, not only the company''s -- and refuses with not_permitted rather than being the silent zero-row write a plain UPSERT would be. Validates the key and the value itself, per key, so the refusal is invalid_argument/PT400 naming the key. Clearing is clear_node_setting, a different verb.';

comment on function clear_node_setting(uuid, text) is
  'R-331/R-333/R-353/R-403: return ONE place to inheriting for ONE setting, by deleting its override row. Keys: eligibility_policy, date_format (0052), timezone (0063), command_bar (0081). A separate verb from set_node_setting on purpose (F-088). Reads the row back after the DELETE because an RLS-filtered DELETE removes zero rows and raises nothing. The primary key is (node_id, key), so clearing one key at a place leaves the others alone.';

-- ----------------------------------------------------------------------------
-- 4. THE COMPANY-SCOPE WRITER. set_org_command_bar, beside
-- set_org_eligibility_policy (0049) and set_org_timezone (0063): the same
-- shape, the same grants, the same SECURITY INVOKER + app_is_admin gate, the
-- same \`||\` shallow merge and read-back. Three literal tokens, so (unlike the
-- timezone writer) there is no external vocabulary to check against -- the IN
-- list is the whole validation, same as set_org_eligibility_policy's.
-- ----------------------------------------------------------------------------
create or replace function set_org_command_bar(p_value text) returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
DECLARE
  v_settings jsonb;
BEGIN
  -- Permission first: a non-admin never learns anything about the value, and
  -- the refusal is the same whether the value was legal or not.
  IF NOT app_is_admin() THEN
    PERFORM api_raise('not_permitted', 'only a system admin may change site settings',
                      jsonb_build_object('reason', 'not_admin'));
  END IF;

  IF p_value IS NULL OR p_value NOT IN ('off', 'typed', 'voice') THEN
    PERFORM api_raise('invalid_argument', 'unknown command bar mode',
                      jsonb_build_object('field', 'command_bar', 'value', p_value));
  END IF;

  UPDATE orgs
     SET settings = settings || jsonb_build_object('command_bar', p_value)
   WHERE id = app_current_org();

  SELECT settings INTO v_settings FROM orgs WHERE id = app_current_org();
  RETURN v_settings;
END $$;

comment on function set_org_command_bar(text) is
  'R-403: set the org-wide (company fallback) command bar mode in orgs.settings.command_bar, beside set_org_eligibility_policy (0049) and set_org_timezone (0063). One of off/typed/voice; anything else is invalid_argument naming the field. Refuses a non-admin with not_permitted -- a plain UPDATE would be a silent zero-row no-op under orgs_update. Merges the one key with || so the rest of the settings bag survives; returns the stored settings.';

-- ----------------------------------------------------------------------------
-- Grants. REVOKE FROM PUBLIC first, every time (api.md §6.2). set_node_setting
-- and clear_node_setting keep the grants 0050 already gave them -- CREATE OR
-- REPLACE does not touch privileges. Only the new function needs one.
-- ----------------------------------------------------------------------------
revoke execute on function set_org_command_bar(text) from public;

do $do$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function set_org_command_bar(text) to authenticated';
  end if;
end $do$;

-- ----------------------------------------------------------------------------
-- 5. THE BOARD CARRIES ITS COMMAND BAR MODE. board_window re-emitted WHOLE
-- from 0063 by scripts/migrations/assemble-0081.mjs, the ONLY edit being one
-- new top-level key, \`command_bar\`, resolved for the board's own root through
-- app_resolve_node_setting (SECURITY DEFINER, 0050) and COALESCEd to 'voice'
-- -- the twin of date_format and timezone. A line supervisor cannot read the
-- override on her plant root, so a browser-side walk would fall through to the
-- company default; the resolver is DEFINER so the walk happens where the
-- authority is (DEF-0016/DEF-0017).
-- ----------------------------------------------------------------------------
${boardWindowEdited}

comment on function board_window(ltree, timestamptz, timestamptz) is
  'Unchanged from 0063 apart from ONE new top-level key, command_bar (D129, R-403): the mode (off/typed/voice) RESOLVED for the board''s own root through app_resolve_node_setting (SECURITY DEFINER, 0050), COALESCEd to voice (the key''s own default -- the board''s behaviour before this setting existed) so the payload always carries a token. It is the twin of the date_format and timezone keys: a line supervisor cannot read the override on her plant root, so a browser-side walk would fall through to the company default and show or hide the launcher wrongly. Everything else is 0063''s text.';
`;

writeFileSync(OUT_PATH, migration, "utf8");
console.log(`Wrote ${OUT_PATH} (${migration.split("\n").length} lines).`);
