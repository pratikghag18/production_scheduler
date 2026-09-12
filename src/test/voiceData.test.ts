/**
 * S42-a (docs/agent-briefs/s42-a-training-set-brief.md §6) — the voice
 * training/test-set generator, scored against the rule parser as the
 * baseline every later model must beat. Mirrors how `testerStack.test.ts`
 * imports `scripts/lib/testerStack.mjs`: these cases import the `.mjs` libs
 * under `scripts/voice/lib/` directly, and pin the COMMITTED
 * `data/voice/heldout.jsonl` against the CURRENT `parseCommand` (V4) so a
 * grammar drift goes red here, not silently.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  parseCommand,
  ASSIGN_VERBS,
  BOOK_VERBS,
  UNASSIGN_VERBS,
  MOVE_VERBS,
} from "@/lib/command/parse";
import type { Command } from "@/lib/command/parse";
import { mulberry32 } from "../../scripts/voice/lib/rng.mjs";
import { TEMPLATES } from "../../scripts/voice/lib/templates.mjs";
import { CATALOG, PERTURBATION_IDS, perturbedRowForm } from "../../scripts/voice/lib/perturb.mjs";
import { canonical, equalForms } from "../../scripts/voice/lib/form.mjs";
import { score, rate } from "../../scripts/voice/lib/score.mjs";
import { generateTrainingRows } from "../../scripts/voice/lib/rows.mjs";
import type { VoiceRow } from "../../scripts/voice/lib/rows.mjs";

const HELDOUT: VoiceRow[] = readFileSync("data/voice/heldout.jsonl", "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as VoiceRow);

/** A deterministic per-(a,b) seed for a fresh `mulberry32`, so V3 can give
 *  every (template, perturbation) pair its own reproducible rng without
 *  templates and perturbations fighting over one shared stream. */
function seedFrom(a: string, b: string): number {
  let h = 0;
  for (const ch of `${a}|${b}`) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
  return h || 1;
}

describe("R-390 / S42-a: the voice-command training and held-out sets", () => {
  it("V1: the RNG is deterministic -- two mulberry32(7) generators agree for 100 picks", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    const seqA = Array.from({ length: 100 }, () => a());
    const seqB = Array.from({ length: 100 }, () => b());
    expect(seqA).toEqual(seqB);
    // and it is not a constant stream masquerading as "deterministic":
    expect(new Set(seqA).size).toBeGreaterThan(90);
  });

  it("V2: every template's fixed-slot sentence parses to the template's own recorded form", () => {
    for (const t of TEMPLATES) {
      const rng = mulberry32(42);
      const slots = t.genSlots(rng);
      const sentence = t.sentence(slots);
      const form = t.form(slots) as Command;
      const result = parseCommand(sentence);
      expect(result.ok, `${t.id}: "${sentence}" did not parse`).toBe(true);
      if (result.ok) {
        expect(equalForms(result.command, form), `${t.id}: "${sentence}"`).toBe(true);
      }
    }
  });

  it("V3: every perturbation leaves the recorded form unchanged and changes the sentence somewhere", () => {
    // "Every perturbation applied to every template" cannot mean every
    // (template, perturbation) PAIR fires -- "ten for 10" cannot fire on a
    // sentence with no literal 10, and that is by design, not a bug. What
    // must hold, and is asserted here: (a) whenever a perturbation DOES
    // change a sentence, the row's form is untouched (perturbedRowForm is
    // the one place that could fail to hold this -- see X2 in the report);
    // (b) every template is changed by at least one perturbation; (c) every
    // perturbation in the catalogue fires on at least one template (nothing
    // in the catalogue is dead code).
    const firedFor = new Map<string, number>(PERTURBATION_IDS.map((id) => [id, 0]));
    const DRAWS_PER_TEMPLATE = 8; // several fixed slot sets per template, not just one -- a
    // single draw can miss a low-probability pattern (a "Line N" pick, say) by chance; this
    // is still fully deterministic (fixed seeds), just not a single fixed seed per template.

    for (const t of TEMPLATES) {
      let anyChanged = false;
      for (let draw = 0; draw < DRAWS_PER_TEMPLATE; draw++) {
        const rng = mulberry32(seedFrom(t.id, `slots-${draw}`));
        const slots = t.genSlots(rng);
        const sentence = t.sentence(slots);
        const form = t.form(slots) as Command;

        for (const id of PERTURBATION_IDS) {
          const prng = mulberry32(seedFrom(t.id, `${id}-${draw}`));
          const perturbedSentence = CATALOG[id](sentence, prng);
          const rowForm = perturbedRowForm(form, [id]) as Command;
          expect(equalForms(rowForm, form), `${t.id}/${id}: form changed`).toBe(true);
          if (perturbedSentence !== sentence) {
            anyChanged = true;
            firedFor.set(id, (firedFor.get(id) ?? 0) + 1);
          }
        }
      }
      expect(
        anyChanged,
        `${t.id}: no perturbation changed any of its ${DRAWS_PER_TEMPLATE} clean sentences`,
      ).toBe(true);
    }

    for (const id of PERTURBATION_IDS) {
      expect(firedFor.get(id), `perturbation "${id}" never fired on any template`).toBeGreaterThan(
        0,
      );
    }
  });

  it("V4: data/voice/heldout.jsonl is valid, 400 rows, 100/intent, half clean/intent, clean rows parse today", () => {
    expect(HELDOUT.length).toBe(400);

    const counts: Record<string, { total: number; clean: number }> = {};
    for (const row of HELDOUT) {
      const bucket = (counts[row.intent] ??= { total: 0, clean: 0 });
      bucket.total++;
      if (row.clean) bucket.clean++;
    }
    expect(Object.keys(counts).sort()).toEqual(["assign", "book", "move", "unassign"]);
    for (const [intent, bucket] of Object.entries(counts)) {
      expect(bucket.total, intent).toBe(100);
      expect(bucket.clean, intent).toBe(50);
    }

    for (const row of HELDOUT) {
      if (!row.clean) continue;
      const result = parseCommand(row.sentence);
      expect(result.ok, `${row.id} (${row.source}): "${row.sentence}"`).toBe(true);
      if (result.ok) {
        expect(equalForms(result.command, row.form), `${row.id}: "${row.sentence}"`).toBe(true);
      }
    }
  });

  describe("V5: the scorer", () => {
    const assignForm: Command = {
      intent: "assign",
      operator: "Sam Patel",
      product: "Housing A",
      place: ["Cell 1"],
      day: null,
      start: { hour: 10, minute: 0 },
      end: { hour: 14, minute: 0 },
      attach: null,
      existing: null,
    };
    const bookForm: Command = {
      intent: "book",
      product: "Widget 17",
      place: ["Cell 2"],
      headcount: 3,
      day: null,
      start: { hour: 6, minute: 0 },
      end: { hour: 14, minute: 0 },
      existing: null,
    };
    const rows: VoiceRow[] = [
      { id: "r1", intent: "assign", sentence: "n/a", form: assignForm, clean: true, source: "x" },
      { id: "r2", intent: "book", sentence: "n/a", form: bookForm, clean: true, source: "x" },
    ];

    it("V5a: a predictor that returns the recorded form scores 1.0", () => {
      const result = score(rows, (row) => row.form);
      expect(rate(result.clean)).toBe(1);
    });

    it("V5b: a predictor with one field wrong scores the right fraction and names the field", () => {
      const predict = (row: VoiceRow): Command =>
        ({ ...row.form, day: { kind: "today" } }) as Command; // every row's real `day` is null
      const result = score(rows, predict);
      expect(rate(result.clean)).toBe(0); // the whole form is wrong on every row
      expect(result.byField.day.n).toBe(2);
      expect(result.byField.day.correct).toBe(0);
      // every OTHER field the two rows carry is still right:
      expect(result.byField.operator).toEqual({ n: 1, correct: 1 });
      expect(result.byField.headcount).toEqual({ n: 1, correct: 1 });
      expect(result.byField.place).toEqual({ n: 2, correct: 2 });
    });
  });

  it("V6: the rule parser's own baseline on held-out is 1.0 clean, well below 0.5 perturbed", () => {
    const predict = (row: VoiceRow) => {
      const result = parseCommand(row.sentence);
      return result.ok ? result.command : null;
    };
    const result = score(HELDOUT, predict);
    expect(rate(result.clean)).toBe(1);
    // Pinned with a tolerance around the number this generator actually
    // produces (~4%) -- a perturbation catalogue that stopped perturbing
    // (every function became a no-op) would push this toward 1.0, and that
    // is exactly the drift this pin exists to catch.
    expect(rate(result.perturbed)).toBeGreaterThan(0);
    expect(rate(result.perturbed)).toBeLessThan(0.5);
    expect(rate(result.perturbed)).toBeCloseTo(0.04, 1);
  });

  it("V7: a generated training set (n=200, seed 1) shares no sentence with held-out and is ~50% clean", () => {
    const forbidden = new Set(HELDOUT.map((r) => r.sentence));
    const rows = generateTrainingRows(1, 200, forbidden);
    expect(rows.length).toBe(200);

    const heldoutSentences = forbidden;
    for (const row of rows) {
      expect(heldoutSentences.has(row.sentence), row.sentence).toBe(false);
    }
    const uniqueSentences = new Set(rows.map((r) => r.sentence));
    expect(uniqueSentences.size).toBe(rows.length);

    const cleanFraction = rows.filter((r) => r.clean).length / rows.length;
    expect(cleanFraction).toBeGreaterThan(0.4);
    expect(cleanFraction).toBeLessThan(0.6);
  });

  it("V8: canonical(form) is stable under key order", () => {
    const a = {
      intent: "assign",
      operator: "Sam",
      place: ["Cell 1"],
      day: null,
      nested: { z: 1, a: 2 },
    };
    const b = {
      nested: { a: 2, z: 1 },
      day: null,
      place: ["Cell 1"],
      operator: "Sam",
      intent: "assign",
    };
    expect(canonical(a)).toBe(canonical(b));
    const c = { ...a, operator: "Someone Else" };
    expect(canonical(a)).not.toBe(canonical(c));
  });

  it("V9 (R-391): every verb in every exported list appears as the first word of at least one clean row (n=2000, seed 1)", () => {
    const rows = generateTrainingRows(1, 2000);
    const firstWords = new Set(
      rows.filter((r) => r.clean).map((r) => r.sentence.trim().split(/\s+/)[0].toLowerCase()),
    );
    const lists: readonly (readonly string[])[] = [
      ASSIGN_VERBS,
      BOOK_VERBS,
      UNASSIGN_VERBS,
      MOVE_VERBS,
    ];
    for (const list of lists) {
      for (const verb of list) {
        expect(firstWords.has(verb), verb).toBe(true);
      }
    }
  });
});
