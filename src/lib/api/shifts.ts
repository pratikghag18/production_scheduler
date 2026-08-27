/**
 * Shifts — PRE-SEATED, EMPTY ON PURPOSE (§19.62).
 *
 * The RPC wrappers for shift patterns go here. The file exists before they do so
 * that the lane which writes them never has to append a line to
 * `src/lib/api/index.ts` — measured across four concurrent surveys (§19.57),
 * that one line was a shared anchor every queued section would have edited.
 *
 * The house rules for what goes in here, so the lane does not have to go
 * looking: every wrapper calls one RPC, throws `toSchedulerError(error)` on
 * failure, and parses `data` through a runtime guard that returns `null` on a
 * shape mismatch rather than trusting the generated types — see
 * `hierarchy.ts` for the pattern. `src/lib/api/` is the ONLY place allowed to
 * touch `supabase.rpc`, snake_case field names, or `database.types.ts`.
 */
export {};
