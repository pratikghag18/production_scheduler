import { describe, expect, it, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  hasRealBackend,
  NO_BACKEND_REASON,
  supabaseUrl,
  supabaseAnonKey,
  liveBackendGone,
  LIVE_PIN_TIMEOUT_MS,
} from "../../../e2e/env";
import type { Database } from "@/lib/database.types";

/**
 * DEF-0022: the SQL suite's own boundary case for a part-day absence (R-359,
 * migration 0069) does not test the boundary it claims to. `absence_overlap`'s
 * part-day branch is `timerange && p_timerange` on two `'[)'` ranges, so a
 * shift starting the EXACT INSTANT a part-day absence ends must NOT clash
 * (half-open: touching is not overlapping) -- `src/lib/absence.ts`'s
 * `absenceGaps` is pinned on exactly this case
 * (`src/test/absence.test.ts`, "a shift ending exactly when the absence ends
 * does not clash"), and the requirement's own `verified_by` entry for
 * `src/test/absence.test.ts` claims this is proven "by the same names the SQL
 * cases carry". It is not: `88_absences_test.sql`'s AB15 tests a MISS at
 * 14:00-16:00, a full hour clear of the absence's 13:00 end, never the
 * touching instant.
 *
 * Measured by mutation, not suspicion: changing `set_absence`'s
 * `tstzrange(p_starts_at, p_ends_at, '[)')` to `'[]'` (closing the upper
 * bound) is a live, wrong behaviour change -- a shift starting exactly when
 * someone's part-day absence ends would be wrongly blocked -- and every one
 * of 88_absences_test.sql's 27 cases (AB0-AB22) still passes. Reproduction:
 *
 *   1. `sed -i "s/tstzrange(p_starts_at, p_ends_at, '\[)')/tstzrange(p_starts_at, p_ends_at, '[]')/" \
 *        supabase/migrations/20260907000069_absence_by_the_hour.sql`
 *   2. `bash scripts/run-sql-test.sh --rebuild && bash scripts/run-sql-test.sh 88_absences_test.sql`
 *      -> `---- 88_absences_test.sql : 27 passed, 0 failed, 0 hard-errors ----`
 *      (unchanged from a clean run: the mutation is invisible to the suite).
 *   3. Revert the file. A direct call on the mutated database --
 *      `set_absence` a part-day 09:00-13:00 absence, then
 *      `absence_overlap(operator, tstzrange('...13:00','...15:00'))` -- answers
 *      `absent: true`; on the unmutated code the same call answers
 *      `absent: false`. Confirmed live both ways.
 *
 * This pin proves the LIVE behaviour directly (over PostgREST, the same way
 * DEF-0020's pin does, not by reading migration text): it is not evidence the
 * SQL suite gained the case, only that the server the suite is supposed to be
 * guarding still gets the boundary right today. Filed `test-cannot-fail`
 * because the gap is in the proof, not (currently) in the product: the code
 * is correct, and the suite that is supposed to say so does not exercise the
 * one clause a maintainer would actually change by accident.
 *
 * ⚠️ ONE SKIP, AND IT IS THE FIRST GATE ONLY. `hasRealBackend` false means this
 * run was never pointed at a stack, which is an honest skip. Everything after
 * it — Dana cannot sign in, Operator A2 is not there — means the stack IS
 * configured and is broken or unseeded, and those go red (`liveBackendGone`).
 * They used to `console.warn` and `return`, which vitest counts as PASSED: this
 * file could report a green boundary check having never called `set_absence`
 * at all. The measurement that found it is in e2e/env.ts beside
 * `liveBackendGone`.
 */

const ORG1_ADMIN = { email: "dana@example.test", password: "devpassword" };

function client(): SupabaseClient<Database> {
  return createClient<Database>(supabaseUrl, supabaseAnonKey);
}

describe("DEF-0022: the part-day absence boundary is right live, though 88_absences_test.sql cannot tell", () => {
  let createdAbsenceId: string | null = null;
  let sb: SupabaseClient<Database> | null = null;

  afterAll(async () => {
    if (sb && createdAbsenceId) {
      await sb.rpc("remove_absence", { p_id: createdAbsenceId });
    }
  });

  it(
    "a shift starting the instant a part-day absence ends is not a clash; one overlapping it is",
    async () => {
      if (!hasRealBackend) {
        console.warn(`DEF-0022 pin skipped: ${NO_BACKEND_REASON}`);
        return;
      }
      const db = client();
      sb = db;
      const { data: signIn, error: signInErr } = await db.auth.signInWithPassword(ORG1_ADMIN);
      if (signInErr || !signIn.session) {
        liveBackendGone(
          `DEF-0022: could not sign in as Dana (${ORG1_ADMIN.email}): ${signInErr?.message ?? "no session"}.`,
        );
      }

      const { data: operators, error: opErr } = await db
        .from("operators")
        .select("id, display_name")
        .eq("display_name", "Operator A2")
        .limit(1);
      if (opErr || !operators || operators.length === 0) {
        liveBackendGone(
          `DEF-0022: Operator A2 not found (${opErr?.message ?? "no rows"}). ` +
            "Dana signed in, so the stack is up and it is the FIXTURE that is missing or " +
            "unreadable -- reload it with `npm run db:reset` (never while the app is in use).",
        );
      }
      const operatorId = operators[0].id;

      // A far-future date so this never collides with a real fixture's own absence.
      const day = "2099-06-10";
      const { data: setResult, error: setErr } = await db.rpc("set_absence", {
        p_operator_id: operatorId,
        p_from: day,
        p_to: day,
        p_reason: "DEF-0022 boundary probe",
        p_starts_at: `${day}T09:00:00.000Z`,
        p_ends_at: `${day}T13:00:00.000Z`,
      });
      expect(setErr, JSON.stringify(setErr)).toBeNull();
      createdAbsenceId = (setResult as { id?: string } | null)?.id ?? null;
      expect(createdAbsenceId, "set_absence did not return an id").not.toBeNull();

      const { data: touching, error: touchErr } = await db.rpc("absence_overlap", {
        p_operator_id: operatorId,
        p_timerange: `[${day}T13:00:00.000Z,${day}T15:00:00.000Z)`,
      });
      expect(touchErr, JSON.stringify(touchErr)).toBeNull();
      expect(
        (touching as { absent?: boolean } | null)?.absent,
        `a shift starting exactly when the part-day absence ends must not clash (half-open ranges) -- got ${JSON.stringify(touching)}`,
      ).toBe(false);

      const { data: overlapping, error: overlapErr } = await db.rpc("absence_overlap", {
        p_operator_id: operatorId,
        p_timerange: `[${day}T12:00:00.000Z,${day}T14:00:00.000Z)`,
      });
      expect(overlapErr, JSON.stringify(overlapErr)).toBeNull();
      expect(
        (overlapping as { absent?: boolean } | null)?.absent,
        `the reader on the case above is not blind: a genuinely overlapping shift must still clash -- got ${JSON.stringify(overlapping)}`,
      ).toBe(true);
    },
    LIVE_PIN_TIMEOUT_MS,
  );
});
