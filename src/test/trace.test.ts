/**
 * S59-e (R-421, brief docs/agent-briefs/s59-e-trace-brief.md §1) --
 * `src/lib/voice/trace.ts`'s own tests: pure, no DOM, no network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderLine, postClip, type TraceEntry } from "@/lib/voice/trace";

function baseEntry(over: Partial<TraceEntry> = {}): TraceEntry {
  return {
    at: "2026-09-15T12:00:00.000Z",
    heard: "assign Sam to Housing A on Cell 1 from 10 to 2",
    by: "typed",
    model: { skipped: "no reader" },
    read: 'assign "Sam" to "Housing A" on "Cell 1" from 10:00 to 14:00',
    asked: null,
    answered: null,
    ran: [],
    // F-164: the entry's last word -- `null` until a writer has answered.
    outcome: null,
    ...over,
  };
}

describe("trace: renderLine (S59-e, R-421)", () => {
  it("T-1: renders one line of JSON -- every field, in order, no trailing newline", () => {
    const entry = baseEntry({
      asked: "Which Sam?",
      answered: "Sam Patel",
      ran: ["Sam Patel assigned to Housing A on Cell 1, 10:00-14:00"],
    });
    const line = renderLine(entry);
    expect(line.endsWith("\n")).toBe(false);
    expect(line.includes("\n")).toBe(false);
    expect(JSON.parse(line)).toEqual(entry);
  });

  it("T-2: a model raw answer round-trips", () => {
    const entry = baseEntry({ model: { raw: '{"intent":"assign"}' } });
    expect(JSON.parse(renderLine(entry))).toEqual(entry);
  });

  it("T-3: a model skipped reason round-trips", () => {
    const entry = baseEntry({ model: { skipped: "timeout" } });
    expect(JSON.parse(renderLine(entry))).toEqual(entry);
  });

  it("T-4: a raw answer over 600 characters is trimmed to exactly 600", () => {
    const raw = "x".repeat(1000);
    const entry = baseEntry({ model: { raw } });
    const parsed = JSON.parse(renderLine(entry)) as TraceEntry;
    expect("raw" in parsed.model && parsed.model.raw.length).toBe(600);
    expect("raw" in parsed.model && parsed.model.raw).toBe("x".repeat(600));
  });

  it("T-5: a raw answer at or under 600 characters is untouched", () => {
    const raw = "y".repeat(600);
    const entry = baseEntry({ model: { raw } });
    const parsed = JSON.parse(renderLine(entry)) as TraceEntry;
    expect("raw" in parsed.model && parsed.model.raw).toBe(raw);

    const short = "z".repeat(10);
    const parsedShort = JSON.parse(renderLine(baseEntry({ model: { raw: short } }))) as TraceEntry;
    expect("raw" in parsedShort.model && parsedShort.model.raw).toBe(short);
  });

  // F-164 (the maintainer's swap, 17 Sept): the entry's LAST WORD -- what
  // became of the write, in the writer's own words. `asked` already holds
  // the question or the readout that STOOD; without a field of its own,
  // neither a lot's failure text nor a single's refusal had anywhere to go,
  // which is why the trace of the swap said nothing about why the fourth
  // step stopped and why a sentence that never wrote a row read exactly like
  // one that did.
  it("T-7: outcome round-trips -- written, a refusal, a pop-up, and a lot's own last line", () => {
    for (const outcome of [
      "written",
      "refused: That person does not belong to this part of the structure.",
      "popup: the create pop-up",
      "Did 3 of 4; the next failed: That person does not belong to this part of the structure.",
    ]) {
      const entry = baseEntry({ outcome });
      expect((JSON.parse(renderLine(entry)) as TraceEntry).outcome).toBe(outcome);
    }
  });

  it("T-8: outcome is null when nothing was ever attempted, and survives the round trip as null", () => {
    const entry = baseEntry({ asked: "Which person?", answered: null });
    const parsed = JSON.parse(renderLine(entry)) as TraceEntry;
    expect(parsed.outcome).toBeNull();
    expect(parsed).toEqual(entry);
  });

  it("T-6: ran lists several readouts, in order", () => {
    const entry = baseEntry({
      ran: ["first readout", "second readout", "third readout"],
    });
    expect((JSON.parse(renderLine(entry)) as TraceEntry).ran).toEqual([
      "first readout",
      "second readout",
      "third readout",
    ]);
  });

  // S71-f (R-453, R-434, brief docs/agent-briefs/s71-f-clip-capture-brief.md
  // §1.E): a clip's numbers round-trip through the same JSON line as every
  // other field, and are absent (never `null`) on an entry no clip was ever
  // posted for -- a typed sentence, or a bare confirm/cancel word.
  it("T-9: clip numbers serialise and round-trip; absent on an entry with no clip", () => {
    const withClip = baseEntry({
      by: "local",
      clip: {
        durationMs: 1512,
        recordedMs: 1512,
        endedBy: "silence",
        speechStarted: true,
        peakRms: 0.31,
        meanRms: 0.09,
        framesAboveFloor: 4,
      },
    });
    expect(JSON.parse(renderLine(withClip))).toEqual(withClip);

    const noClip = baseEntry();
    const parsedNoClip = JSON.parse(renderLine(noClip)) as TraceEntry;
    expect(parsedNoClip.clip).toBeUndefined();
    expect("clip" in JSON.parse(renderLine(noClip))).toBe(false);
  });
});

describe("trace: postClip (S71-f, R-453, R-434)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const clip: NonNullable<TraceEntry["clip"]> = {
    durationMs: 1500.4,
    recordedMs: 1500.4,
    endedBy: "silence",
    speechStarted: true,
    peakRms: 0.31,
    meanRms: 0.09,
    framesAboveFloor: 4,
  };

  it("PC-1: posts the exact wav bytes to /__clip, at and the numbers as query params, rounded ms", () => {
    const fetchMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);
    const wav = new ArrayBuffer(48);

    postClip("2026-09-23T00:00:00.000Z", wav, clip, null);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(wav);
    const parsed = new URL(url, "http://localhost");
    expect(parsed.pathname).toBe("/__clip");
    expect(parsed.searchParams.get("at")).toBe("2026-09-23T00:00:00.000Z");
    expect(parsed.searchParams.get("durationMs")).toBe("1500");
    expect(parsed.searchParams.get("endedBy")).toBe("silence");
    expect(parsed.searchParams.get("speechStarted")).toBe("true");
    expect(parsed.searchParams.get("framesAboveFloor")).toBe("4");
  });

  it("PC-2: a synchronous throw from fetch is swallowed, never escapes", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("boom");
      }),
    );
    expect(() =>
      postClip("2026-09-23T00:00:00.000Z", new ArrayBuffer(4), clip, null),
    ).not.toThrow();
  });

  it("PC-3: a rejected fetch promise is swallowed, never an unhandled rejection", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    expect(() =>
      postClip("2026-09-23T00:00:00.000Z", new ArrayBuffer(4), clip, null),
    ).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });

  it("PC-4: a no-op outside dev -- fetch is never called", () => {
    vi.stubEnv("DEV", false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    postClip("2026-09-23T00:00:00.000Z", new ArrayBuffer(4), clip, "assign, cell, sam patel");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // S71-h (R-453, brief docs/agent-briefs/s71-h-replay-uses-the-apps-hint-
  // brief.md §2): the hint travels as a header, URL-encoded (headers are
  // Latin-1 -- the hint is free text with names, commas and punctuation),
  // and is omitted entirely when there was none to send.
  it("PC-5: sends the hint header, URL-encoded, and omits it when null", () => {
    const fetchMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);

    postClip(
      "2026-09-23T00:00:00.000Z",
      new ArrayBuffer(4),
      clip,
      "assign, cell, put on, Sam Patel, café",
    );
    const [, initWithHint] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headersWithHint = initWithHint.headers as Record<string, string>;
    expect(headersWithHint["x-clip-hint"]).toBe(
      encodeURIComponent("assign, cell, put on, Sam Patel, café"),
    );
    expect(decodeURIComponent(headersWithHint["x-clip-hint"])).toBe(
      "assign, cell, put on, Sam Patel, café",
    );
    expect(headersWithHint["Content-Type"]).toBe("audio/wav");

    fetchMock.mockClear();
    postClip("2026-09-23T00:00:00.000Z", new ArrayBuffer(4), clip, null);
    const [, initNoHint] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headersNoHint = initNoHint.headers as Record<string, string>;
    expect("x-clip-hint" in headersNoHint).toBe(false);
  });
});
