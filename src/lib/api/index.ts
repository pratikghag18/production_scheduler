/**
 * The only path features import from (brief P1-3b §3/§6 — conventions.md's
 * feature-import rule stops at `src/lib`; within `src/lib/api/`, this file
 * is the public surface, so nothing outside this folder should reach past
 * it into errors.ts/shapes.ts/serde.ts/board.ts/mutations.ts/hierarchy.ts
 * directly).
 */
export * from "./errors";
export * from "./shapes";
export * from "./serde";
export * from "./board";
export * from "./mutations";
export * from "./hierarchy";
export * from "./access";

// §19.62 — pre-seated for the four queued admin sections. Each is empty
// today; the point is that the lane which fills it does not have to edit
// THIS file, which every one of them would otherwise have appended to.
export * from "./shifts";
export * from "./operators";
export * from "./products";
export * from "./imports";

// 0040 / R-315. Not pre-seated either: standard cycle times are a section of
// their own, added after the four above were laid out.
export * from "./cycleTimes";

// The audit log (0007 / 0029 §6), read for the first time by the Activity
// section. Not pre-seated either — §19.62 laid out four sections and this is
// none of them; it is a READ-ONLY surface over a table with no write policy at
// all, so the export is one function wide on purpose.
export * from "./audit";

// 0029 / D110. Not pre-seated — the delete that keeps the past did not exist
// when §19.62 laid the four admin sections out, and it belongs to none of
// them: one dialog serves products, people, trainings and shift patterns.
export * from "./deletion";

// R-339 / S35. Copy Week: the plan-then-apply pair over migration 0055. Not
// pre-seated either -- it belongs to the board, not to an admin section.
export * from "./copyWeek";

// The 1000-row pager. Every table/view read in this folder runs through
// `fetchAll` so `max_rows = 1000` cannot silently truncate a catalogue; see
// paging.ts's header and `apiReadPaging.test.ts`.
export * from "./paging";

// Re-exported so callers that need the raw `Json` type (e.g. shapes.test.ts
// building RPC-payload fixtures) never have to import database.types.ts
// themselves (self-review §9 item 5: nothing outside src/lib imports it).
export type { Json } from "@/lib/database.types";

// R-357 / migration 0066. Absences: read a plant's, record one, remove one,
// import a file. The pure predicate `absenceGaps` lives at src/lib/absence.ts.
export * from "./absences";

// R-356 / migration 0067. Named week templates: list, save, rename, delete. A
// template is APPLIED through Copy Week (copyWeek.ts with a templateId), so its
// clash rules and preview are shared with the week source, not copied here.
export * from "./weekTemplates";
