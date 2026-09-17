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
});
