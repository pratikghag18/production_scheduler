/**
 * S71-c (brief docs/agent-briefs/s71-c-clip-harness-brief.md §1.G, R-453):
 * pins the pure half of the clip scorer alone -- the normaliser (am/pm,
 * spelled numbers, ordinal dates), word error rate, and name hits --
 * imported straight from the `.mjs` lib the same way `voiceData.test.ts`
 * imports `scripts/voice/lib/score.mjs`. `scripts/voice/clips/score.mjs`
 * itself is all I/O (a whisper.cpp POST and two file writes) and is proved
 * by hand against the running container instead (brief §2).
 */
import { describe, expect, it } from "vitest";
import { normalizeText, wordErrorRate, nameHits } from "../../scripts/voice/clips/lib/score.mjs";

describe("VCLIP: scripts/voice/clips/lib/score.mjs (S71-c brief §1.G)", () => {
  it("VCLIP-1: a.m., dotted, normalises to am", () => {
    expect(normalizeText("Assign at 8 a.m. today")).toBe("assign at 8 am today");
  });

  it("VCLIP-2: a m, spaced, normalises to am", () => {
    expect(normalizeText("meet at 8 a m today")).toBe("meet at 8 am today");
  });

  it("VCLIP-3: p.m., dotted, and pm glued to a digit, both normalise to a spaced pm", () => {
    expect(normalizeText("end at 2 p.m.")).toBe("end at 2 pm");
    // Reviewer finding: "2pm" is one run of word characters (digits and
    // letters are both \w), so no \b ever sat between them -- the dotted
    // rule above never fired and "2pm" was left glued, scoring a WER of
    // 2.0 against "2 p.m.". It must split and normalise the same way.
    expect(normalizeText("end at 2pm")).toBe("end at 2 pm");
  });

  it("VCLIP-4: spelled numbers one..twelve become digits", () => {
    expect(normalizeText("book three people on cell two for eleven hours")).toBe(
      "book 3 people on cell 2 for 11 hours",
    );
  });

  it("VCLIP-5: a hyphenated ordinal word (twenty-eighth) becomes a digit", () => {
    expect(normalizeText("on September twenty-eighth")).toBe("on september 28");
  });

  it("VCLIP-6: a digit ordinal (28th) drops its suffix", () => {
    expect(normalizeText("move it to the 28th")).toBe("move it to the 28");
  });

  it("VCLIP-7: WER of an exact match is 0", () => {
    expect(wordErrorRate("clear Cell 4 today", "clear Cell 4 today")).toBe(0);
  });

  it("VCLIP-8: WER of an empty hypothesis against a non-empty reference is 1", () => {
    expect(wordErrorRate("clear Cell 4 today", "")).toBe(1);
  });

  it("VCLIP-9: WER counts one deleted word out of the reference's length", () => {
    expect(wordErrorRate("the quick brown fox", "the quick fox")).toBeCloseTo(0.25);
  });

  it("VCLIP-10: name hits count only names present in the reference, missing one misheard", () => {
    const reference = "Assign Sam Patel to Housing A. End John Kim's block at 2pm.";
    const hypothesis = "Assign Sam Patel to Housing A. End Jon Kim's block at 2pm.";
    const result = nameHits(reference, hypothesis, ["Sam Patel", "John Kim"]);
    expect(result).toEqual({ hits: 1, total: 2, missed: ["John Kim"] });
  });

  it("VCLIP-11: 8am, 8 a.m., 8 AM and eight am all normalise the same", () => {
    const forms = ["8am", "8 a.m.", "8 AM", "eight am"];
    for (const form of forms) expect(normalizeText(form)).toBe("8 am");
    for (const form of forms) expect(wordErrorRate("8am", form)).toBe(0);
  });

  it("VCLIP-12: 12pm and 12 p.m. normalise the same", () => {
    expect(normalizeText("12pm")).toBe("12 pm");
    expect(normalizeText("12 p.m.")).toBe("12 pm");
    expect(wordErrorRate("12pm", "12 p.m.")).toBe(0);
  });

  it("VCLIP-13: Sam Patel's and Sam Patels normalise the same (no dangling word)", () => {
    expect(normalizeText("Sam Patel's")).toBe("sam patels");
    expect(normalizeText("Sam Patels")).toBe("sam patels");
    expect(wordErrorRate("Sam Patel's", "Sam Patels")).toBe(0);
  });
});
