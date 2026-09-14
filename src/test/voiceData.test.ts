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
import type { Command, SingleCommand } from "@/lib/command/parse";
import { mulberry32 } from "../../scripts/voice/lib/rng.mjs";
import { TEMPLATES, templateById } from "../../scripts/voice/lib/templates.mjs";
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

  it("V4: data/voice/heldout.jsonl is valid, 500 rows, 100/intent, half clean/intent, clean rows parse today", () => {
    // S50 (R-398/R-399): "several" joins the four -- the held-out set is
    // regenerated (a NEW reference set; the old one could not contain
    // sentences its grammar could not yet parse, design §19.97/D126), still
    // 100 rows per intent, now across five intents instead of four.
    expect(HELDOUT.length).toBe(500);

    const counts: Record<string, { total: number; clean: number }> = {};
    for (const row of HELDOUT) {
      const bucket = (counts[row.intent] ??= { total: 0, clean: 0 });
      bucket.total++;
      if (row.clean) bucket.clean++;
    }
    expect(Object.keys(counts).sort()).toEqual(["assign", "book", "move", "several", "unassign"]);
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
      shift: null,
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
      shift: null,
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

    it("V5c (F-143): a per-field tally is not fooled by key order or an invented key inside a nested time object", () => {
      const moveForm: Command = {
        intent: "move",
        operator: "Sam Patel",
        place: ["Cell 1"],
        toPlace: ["Cell 2"],
        day: { kind: "weekday", day: 3 },
        span: { start: { hour: 10, minute: 0 }, end: { hour: 14, minute: 0 } },
        shift: null,
        existing: null,
      };
      const moveRows: VoiceRow[] = [
        { id: "m1", intent: "move", sentence: "n/a", form: moveForm, clean: true, source: "x" },
      ];
      // Every object's keys reversed in insertion order, plus an invented
      // key ("meridiem") inside `span.start` -- a fine-tuned model's shape.
      const predicted = {
        existing: null,
        shift: null,
        span: {
          end: { minute: 0, hour: 14 },
          start: { minute: 0, hour: 10, meridiem: "am" },
        },
        day: { day: 3, kind: "weekday" },
        toPlace: ["Cell 2"],
        place: ["Cell 1"],
        operator: "Sam Patel",
        intent: "move",
      } as unknown as Command;
      const result = score(moveRows, () => predicted);
      expect(rate(result.clean)).toBe(1); // the row is correct despite key order and the extra key
      expect(result.byField.day).toEqual({ n: 1, correct: 1 });
      expect(result.byField.span).toEqual({ n: 1, correct: 1 });
    });

    it("V5d (F-143): the tally still discriminates -- a span END off by one minute is wrong in span but right in day", () => {
      const moveForm: Command = {
        intent: "move",
        operator: "Sam Patel",
        place: ["Cell 1"],
        toPlace: ["Cell 2"],
        day: { kind: "weekday", day: 3 },
        span: { start: { hour: 10, minute: 0 }, end: { hour: 14, minute: 0 } },
        shift: null,
        existing: null,
      };
      const moveRows: VoiceRow[] = [
        { id: "m1", intent: "move", sentence: "n/a", form: moveForm, clean: true, source: "x" },
      ];
      const predicted: Command = {
        ...moveForm,
        span: { start: { hour: 10, minute: 0 }, end: { hour: 14, minute: 1 } },
      };
      const result = score(moveRows, () => predicted);
      expect(rate(result.clean)).toBe(0); // the row itself is wrong (span differs)
      expect(result.byField.day).toEqual({ n: 1, correct: 1 });
      expect(result.byField.span).toEqual({ n: 1, correct: 0 });
    });
  });

  it("V6: the rule parser's own baseline on held-out is 1.0 clean, well below 0.5 perturbed", () => {
    // S52-c: re-pinned on the regenerated 500-row set (read from
    // `node scripts/voice/score.mjs --heldout data/voice/heldout.jsonl
    // --rule-parser --bar 0.95`, after the shift templates and M10's
    // possessive-timing move were added): clean 250/250 (1.0), perturbed
    // 13/250 (0.052) -- up from S50's 8/250 (0.032) because the new
    // templates give the SAME perturbation catalogue more surface (a shift
    // name's own spelling can now be perturbed too), not because anything
    // stopped perturbing.
    const predict = (row: VoiceRow) => {
      const result = parseCommand(row.sentence);
      return result.ok ? result.command : null;
    };
    const result = score(HELDOUT, predict);
    expect(rate(result.clean)).toBe(1);
    expect(result.clean).toEqual({ n: 250, correct: 250 });
    expect(result.perturbed).toEqual({ n: 250, correct: 13 });
    // Pinned with a tolerance around the number this generator actually
    // produces (~5.2%) -- a perturbation catalogue that stopped perturbing
    // (every function became a no-op) would push this toward 1.0, and that
    // is exactly the drift this pin exists to catch.
    expect(rate(result.perturbed)).toBeGreaterThan(0);
    expect(rate(result.perturbed)).toBeLessThan(0.5);
    expect(rate(result.perturbed)).toBeCloseTo(0.052, 2);
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

  describe("V10-V12 (extra keys): a fine-tuned model's invented field does not fail a row", () => {
    const form: Command = {
      intent: "assign",
      operator: "Sam Patel",
      product: "Housing A",
      place: ["Cell 1"],
      day: null,
      start: { hour: 10, minute: 0 },
      end: { hour: 14, minute: 0 },
      attach: null,
      shift: null,
      existing: null,
    };
    const rows: VoiceRow[] = [
      { id: "r1", intent: "assign", sentence: "n/a", form, clean: true, source: "x" },
    ];

    it("V10: a prediction equal to the form plus an extra top-level key scores correct and is counted once under extraKeys", () => {
      const predicted = { ...form, type: "assign" };
      const result = score(rows, () => predicted);
      expect(rate(result.clean)).toBe(1);
      expect(result.extraKeys).toEqual({ n: 1, keys: { type: 1 } });
    });

    it("V11: an extra key inside `start` is ignored the same way", () => {
      const predicted = { ...form, start: { ...form.start, explicitMeridiem: true } };
      const result = score(rows, () => predicted);
      expect(rate(result.clean)).toBe(1);
      expect(result.extraKeys).toEqual({ n: 1, keys: { explicitMeridiem: 1 } });
    });

    it("V12: a prediction missing `product` is still wrong (missing is not extra)", () => {
      const predicted = { ...form } as Record<string, unknown>;
      delete predicted.product;
      const result = score(rows, () => predicted);
      expect(rate(result.clean)).toBe(0);
      expect(result.extraKeys).toEqual({ n: 0, keys: {} });
    });
  });

  it("V17 (re-pinned, S52-c): now that every held-out row carries `shift`, a `shift: null` prediction against a shift-LESS expected form IS an extra key", () => {
    // The tolerance V17 used to pin (S52-a, reviewer should-fix 2) existed
    // only because the committed held-out set predated the `shift` field.
    // `data/voice/heldout.jsonl` has since been regenerated (S52-c) with
    // `shift` on every row, so `collectExtraKeys` (score.mjs) no longer
    // special-cases it -- this is a raw stand-in for what a row's `form`
    // looked like BEFORE that regeneration, kept only to prove the old
    // special case is gone, not to describe any row in the committed set
    // any more.
    const shiftlessForm = {
      intent: "assign",
      operator: "Sam Patel",
      product: "Housing A",
      place: ["Cell 1"],
      day: null,
      start: { hour: 10, minute: 0 },
      end: { hour: 14, minute: 0 },
      attach: null,
      existing: null,
    } as unknown as Command;
    const rows: VoiceRow[] = [
      {
        id: "r1",
        intent: "assign",
        sentence: "n/a",
        form: shiftlessForm,
        clean: true,
        source: "x",
      },
    ];

    const predicted = { ...shiftlessForm, shift: null };
    const result = score(rows, () => predicted);
    // The row itself still scores correct -- `normalizeToKnownKeys` strips
    // `shift` off the prediction before the whole-row compare runs, exactly
    // as it would strip any other key `expected` lacks. `extraKeys` is the
    // separate, un-normalised diagnostic, and it now counts `shift` like
    // any other invented field.
    expect(rate(result.clean)).toBe(1);
    expect(result.extraKeys).toEqual({ n: 1, keys: { shift: 1 } });

    // A genuinely invented key is still counted right alongside it.
    const withRealExtra = { ...shiftlessForm, shift: null, type: "assign" };
    const result2 = score(rows, () => withRealExtra);
    expect(result2.extraKeys).toEqual({ n: 1, keys: { shift: 1, type: 1 } });
  });

  it("V13: the rule parser's held-out baseline is unchanged by the extra-key normalisation (re-pins V6)", () => {
    const predict = (row: VoiceRow) => {
      const result = parseCommand(row.sentence);
      return result.ok ? result.command : null;
    };
    const result = score(HELDOUT, predict);
    expect(rate(result.clean)).toBe(1);
    expect(result.clean).toEqual({ n: 250, correct: 250 });
    expect(result.perturbed).toEqual({ n: 250, correct: 13 });
    expect(rate(result.perturbed)).toBeGreaterThan(0);
    expect(rate(result.perturbed)).toBeLessThan(0.5);
    expect(rate(result.perturbed)).toBeCloseTo(0.052, 2);
  });

  it("V15 (S52-c, R-402): a shift template's form has start/end null and a name -- the oracle holds", () => {
    const shiftTemplateIds = [
      "A11-shift",
      "A12-shift-product-last",
      "A13-the-x-shift",
      "B7-shift",
      "U11-shift",
      "M11-shift",
      "S7-several-shift",
    ];
    for (const id of shiftTemplateIds) {
      const t = templateById(id);
      const rng = mulberry32(seedFrom(id, "V15"));
      const slots = t.genSlots(rng);
      const sentence = t.sentence(slots);
      const form = t.form(slots) as Command;
      const result = parseCommand(sentence);
      expect(result.ok, `${id}: "${sentence}" did not parse`).toBe(true);
      if (!result.ok) continue;
      expect(equalForms(result.command, form), `${id}: "${sentence}"`).toBe(true);
      const commands = form.intent === "several" ? form.commands : [form];
      for (const c of commands) {
        expect(c.shift, `${id}: "${sentence}"`).not.toBeNull();
        if (c.intent === "assign" || c.intent === "book") {
          expect(c.start, `${id}: "${sentence}"`).toBeNull();
          expect(c.end, `${id}: "${sentence}"`).toBeNull();
        } else {
          expect(c.span, `${id}: "${sentence}"`).toBeNull();
        }
      }
    }
  });

  it("V16 (S52-c, R-401/F-144): the apostrophe-less possessive parses to the same move as the apostrophe form", () => {
    const t = templateById("M10-change-timing");
    // Fixed slots, forced to each spelling in turn: same everything else,
    // only `noApostrophe` differs, and the resulting FORM (in particular
    // `operator`, the whole point of the possessive-tail strip) must agree.
    const rng = mulberry32(seedFrom("M10-change-timing", "V16"));
    const slots = t.genSlots(rng) as { op: string };
    const withApostrophe = { ...slots, noApostrophe: false };
    const withoutApostrophe = { ...slots, noApostrophe: true, op: "Operator A3" };
    withApostrophe.op = "Operator A3"; // digit-ending, so both spellings are legal for this op

    const sentenceA = t.sentence(withApostrophe);
    const sentenceB = t.sentence(withoutApostrophe);
    expect(sentenceA).not.toBe(sentenceB);
    expect(sentenceA).toContain("'s");
    expect(sentenceB).not.toContain("'");

    const resultA = parseCommand(sentenceA);
    const resultB = parseCommand(sentenceB);
    expect(resultA.ok, sentenceA).toBe(true);
    expect(resultB.ok, sentenceB).toBe(true);
    if (!resultA.ok || !resultB.ok) return;
    expect(equalForms(resultA.command, resultB.command)).toBe(true);
    expect(resultA.command.intent).toBe("move");
    if (resultA.command.intent === "move") {
      expect(resultA.command.operator).toBe("Operator A3");
    }
  });

  describe("V14 (S50, R-398): the scorer tallies a several's inner fields", () => {
    const innerA: SingleCommand = {
      intent: "assign",
      operator: "A2",
      product: "Housing A",
      place: ["Cell 1"],
      day: null,
      start: { hour: 10, minute: 0 },
      end: { hour: 14, minute: 0 },
      attach: null,
      shift: null,
      existing: null,
    };
    const innerB: SingleCommand = {
      intent: "assign",
      operator: "A3",
      product: "Housing A",
      place: ["Cell 2"],
      day: null,
      start: { hour: 10, minute: 0 },
      end: { hour: 14, minute: 0 },
      attach: null,
      shift: null,
      existing: null,
    };
    const severalForm: Command = { intent: "several", commands: [innerA, innerB] };
    const rows: VoiceRow[] = [
      { id: "s1", intent: "several", sentence: "n/a", form: severalForm, clean: true, source: "x" },
    ];

    it("V14a: an exact match scores the row correct", () => {
      const result = score(rows, () => severalForm);
      expect(rate(result.clean)).toBe(1);
    });

    it("V14b: one inner field wrong is wrong for the row, tallied under that field", () => {
      const predicted: Command = {
        intent: "several",
        commands: [innerA, { ...innerB, place: ["Cell 9"] } as SingleCommand],
      };
      const result = score(rows, () => predicted);
      expect(rate(result.clean)).toBe(0);
      // Two inner commands each carry `place` -- innerA's is right, the
      // mutated innerB's is wrong.
      expect(result.byField.place).toEqual({ n: 2, correct: 1 });
      // Every other inner field the two commands carry is still right.
      expect(result.byField.operator).toEqual({ n: 2, correct: 2 });
      expect(result.byField.product).toEqual({ n: 2, correct: 2 });
    });

    it("V14c: a different inner count is wrong for the row and tallies nothing inner", () => {
      const predicted: Command = { intent: "several", commands: [innerA] };
      const result = score(rows, () => predicted);
      expect(rate(result.clean)).toBe(0);
      // No inner tally ran at all -- "place"/"operator"/"product" (fields
      // that ONLY a several's inner commands could contribute here, since
      // no plain assign/book/unassign/move row is in this row set) never
      // appear in byField.
      expect(result.byField.place).toBeUndefined();
      expect(result.byField.operator).toBeUndefined();
      expect(result.byField.product).toBeUndefined();
      // The row's own top-level keys (commands, intent) are still tallied.
      expect(result.byField.intent).toEqual({ n: 1, correct: 1 });
      expect(result.byField.commands.n).toBe(1);
    });
  });
});
