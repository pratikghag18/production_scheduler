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

// Re-exported so callers that need the raw `Json` type (e.g. shapes.test.ts
// building RPC-payload fixtures) never have to import database.types.ts
// themselves (self-review §9 item 5: nothing outside src/lib imports it).
export type { Json } from "@/lib/database.types";
