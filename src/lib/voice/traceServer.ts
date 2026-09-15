/**
 * S59-e (R-421, brief docs/agent-briefs/s59-e-trace-brief.md §3) -- the dev
 * server's own side of the bar's trace. `vite.config.ts` gains a small
 * plugin whose `configureServer` routes POST `/__trace` here; the handler
 * itself lives in this ordinary module (not inline in the plugin, and not
 * in `trace.ts`, which stays pure and browser-safe) so `traceServer.test.ts`
 * can call it directly with a fake request and response -- no Vite, no real
 * HTTP.
 *
 * Node-only (`node:fs/promises`, `node:path`, `node:buffer`): never imported
 * by `CommandBar.tsx` or anything else that reaches the client bundle.
 */
import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
// Explicit, not the global `Buffer` -- this file's own tsconfig (the main
// `tsconfig.json`, `"types": ["vite/client"]`) never pulls in @types/node's
// global augmentations, only what a module is explicitly imported from
// (the same reason `node:fs`/`node:path` above need no separate config).
import { Buffer } from "node:buffer";

/** Gitignored (`.gitignore`'s own new line) -- the bar's `POST /__trace`
 *  body, one already-rendered JSON line (`trace.ts`'s `renderLine`) per
 *  call, appended here. */
export const TRACE_FILE = "data/voice/trace/bar.jsonl";

/** The minimal shape this handler reads off a request -- satisfied
 *  structurally by Node's own `http.IncomingMessage` (what
 *  `configureServer`'s middleware actually hands it) and by a test's fake. */
export interface TraceRequestLike {
  method?: string;
  on(event: "data", listener: (chunk: Buffer) => void): void;
  on(event: "end", listener: () => void): void;
}

/** Likewise, satisfied structurally by `http.ServerResponse`. */
export interface TraceResponseLike {
  statusCode: number;
  end(): void;
}

/** Reads the whole request body into one string -- Node's raw
 *  `IncomingMessage` carries no parsed body of its own. */
function readBody(req: TraceRequestLike): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

/**
 * POST appends the body plus a newline to `filePath` (default `TRACE_FILE`),
 * creating its directory as needed, and answers 204. Anything else answers
 * 405. Never throws -- `vite.config.ts`'s plugin calls this from
 * `configureServer`, where an uncaught error would take the dev server down
 * for every other request too, not only this one (the bar's own POST is
 * already fire-and-forget; this side owes it the same courtesy).
 */
export async function handleTraceRequest(
  req: TraceRequestLike,
  res: TraceResponseLike,
  filePath: string = TRACE_FILE,
): Promise<void> {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end();
    return;
  }
  try {
    const body = await readBody(req);
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, `${body}\n`, "utf8");
  } catch {
    // Swallowed -- see the doc above.
  }
  res.statusCode = 204;
  res.end();
}
