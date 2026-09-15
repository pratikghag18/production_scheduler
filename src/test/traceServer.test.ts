/**
 * S59-e (R-421, brief docs/agent-briefs/s59-e-trace-brief.md §3/§4) --
 * `src/lib/voice/traceServer.ts`'s own handler, driven with a fake request
 * and response (no Vite, no real HTTP -- exactly why the brief has the
 * plugin's `configureServer` call out to this small module instead of
 * holding the logic itself).
 */
import { describe, expect, it, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Buffer } from "node:buffer";
import {
  handleTraceRequest,
  type TraceRequestLike,
  type TraceResponseLike,
} from "@/lib/voice/traceServer";

/** A fake `http.IncomingMessage`/`ServerResponse` pair -- just enough of
 *  each for `handleTraceRequest` (brief §4: "a fake request and response"). */
function fakeReqRes(
  method: string,
  body: string,
): { req: TraceRequestLike; res: TraceResponseLike & { ended: boolean } } {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = { data: [], end: [] };
  const reqImpl = {
    method,
    // Cast to `TraceRequestLike` below rather than typed as one directly --
    // this single implementation stands in for both of that interface's
    // overloads (`"data"`/`(chunk: Buffer) => void` and `"end"`/`() => void`).
    on(event: "data" | "end", listener: (...args: unknown[]) => void) {
      listeners[event].push(listener);
      // `handleTraceRequest` registers "data" then "end" in that order, so
      // by the time "end" is registered both are ready to fire.
      if (event === "end") {
        for (const dataListener of listeners.data) dataListener(Buffer.from(body, "utf8"));
        for (const endListener of listeners.end) endListener();
      }
      return reqImpl;
    },
  };
  const req = reqImpl as unknown as TraceRequestLike;
  const res: TraceResponseLike & { ended: boolean } = {
    statusCode: 200,
    ended: false,
    end() {
      this.ended = true;
    },
  };
  return { req, res };
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-server-test-"));
const tmpFile = path.join(tmpDir, "trace", "bar.jsonl");

afterEach(() => {
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
});

describe("traceServer: handleTraceRequest (S59-e, R-421)", () => {
  it("TS-1: POST appends the body plus a newline, creating the directory, and answers 204", async () => {
    const line = JSON.stringify({ heard: "assign Sam" });
    const { req, res } = fakeReqRes("POST", line);
    await handleTraceRequest(req, res, tmpFile);

    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
    const written = fs.readFileSync(tmpFile, "utf8");
    expect(written).toBe(`${line}\n`);
  });

  it("TS-2: a second POST appends a second line -- both readable back", async () => {
    const first = JSON.stringify({ heard: "first" });
    const second = JSON.stringify({ heard: "second" });
    const call1 = fakeReqRes("POST", first);
    const call2 = fakeReqRes("POST", second);
    await handleTraceRequest(call1.req, call1.res, tmpFile);
    await handleTraceRequest(call2.req, call2.res, tmpFile);

    const lines = fs
      .readFileSync(tmpFile, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    expect(lines).toEqual([first, second]);
  });

  it("TS-3: anything but POST answers 405 and writes nothing", async () => {
    const { req, res } = fakeReqRes("GET", "");
    await handleTraceRequest(req, res, tmpFile);

    expect(res.statusCode).toBe(405);
    expect(res.ended).toBe(true);
    expect(fs.existsSync(tmpFile)).toBe(false);
  });

  it("TS-4: PUT also answers 405", async () => {
    const { req, res } = fakeReqRes("PUT", "{}");
    await handleTraceRequest(req, res, tmpFile);
    expect(res.statusCode).toBe(405);
  });

  // Reviewer follow-up: the brief's own §3 says "decide and pin" for a body
  // that is not JSON. Live-browser confirmation (against the real dev
  // server): a POST of "not json at all {{{" answers 204 and the literal
  // text lands as the file's line, unvalidated. Pinned here so that
  // decision -- store verbatim, never reject -- cannot drift silently: the
  // handler trusts every caller to have already rendered valid JSON
  // (`trace.ts`'s `renderLine`, the bar's own only caller), and does no
  // parsing of its own, on purpose (brief: "append one JSON line per body"
  // -- the appending is this handler's job, not the validating).
  it("TS-5: a non-JSON body is stored verbatim, not refused -- decided, not inferred", async () => {
    const body = "not json at all {{{";
    const { req, res } = fakeReqRes("POST", body);
    await handleTraceRequest(req, res, tmpFile);
    expect(res.statusCode).toBe(204);
    expect(fs.readFileSync(tmpFile, "utf8")).toBe(`${body}\n`);
  });
});
