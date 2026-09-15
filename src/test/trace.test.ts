/**
 * S59-e (R-421, brief docs/agent-briefs/s59-e-trace-brief.md §1) --
 * `src/lib/voice/trace.ts`'s own tests: pure, no DOM, no network.
 */
import { describe, expect, it } from "vitest";
import { renderLine, type TraceEntry } from "@/lib/voice/trace";

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
});
