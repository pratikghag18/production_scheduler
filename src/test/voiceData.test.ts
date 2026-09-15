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
  JOB_HOURS,
} from "@/lib/command/parse";
import type { Command, SingleCommand } from "@/lib/command/parse";
import { mulberry32 } from "../../scripts/voice/lib/rng.mjs";
import { TEMPLATES, templateById } from "../../scripts/voice/lib/templates.mjs";
import {
  CATALOG,
  PERTURBATION_IDS,
  perturbedRowForm,
  perturbAll,
} from "../../scripts/voice/lib/perturb.mjs";
import { canonical, equalForms } from "../../scripts/voice/lib/form.mjs";
import {
  score,
  rate,
  scorePredictions,
  formatSentencesNotCheckedLine,
} from "../../scripts/voice/lib/score.mjs";
import { generateTrainingRows } from "../../scripts/voice/lib/rows.mjs";
import type { VoiceRow } from "../../scripts/voice/lib/rows.mjs";
import { buildTimePair, resolveLoneTime } from "../../scripts/voice/lib/time.mjs";

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

  it("V4: data/voice/heldout.jsonl is valid, 1000 rows, 100/intent, half clean/intent, clean rows parse today", () => {
    // S58 (D132/S58-a brief, R-412 to R-416, S56-b data brief §1): re-pinned
    // again -- two more intents (split/headcount) join the eight, and the
    // whole set is regenerated on the SAME seed (20260915, the README's own
    // rule: a template/grammar widening, not a deliberate drift, keeps the
    // seed and just re-runs the generation) the same way S56's own
    // regeneration was: the old file could not contain sentences its
    // grammar could not yet parse (design §19.97/D126). Still 100 rows per
    // intent, now across ten intents instead of eight.
    expect(HELDOUT.length).toBe(1000);

    const counts: Record<string, { total: number; clean: number }> = {};
    for (const row of HELDOUT) {
      const bucket = (counts[row.intent] ??= { total: 0, clean: 0 });
      bucket.total++;
      if (row.clean) bucket.clean++;
    }
    expect(Object.keys(counts).sort()).toEqual([
      "assign",
      "book",
      "copy",
      "headcount",
      "move",
      "replace",
      "several",
      "split",
      "swap",
      "unassign",
    ]);
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
        // S58 (R-412, D132 item 1): every `MoveCommand` now carries `adjust`
        // -- `null` here is this row's own pre-S58 shape, an ordinary move
        // in time, not an edge adjust.
        adjust: null,
      };
      const moveRows: VoiceRow[] = [
        { id: "m1", intent: "move", sentence: "n/a", form: moveForm, clean: true, source: "x" },
      ];
      // Every object's keys reversed in insertion order, plus an invented
      // key ("meridiem") inside `span.start` -- a fine-tuned model's shape.
      const predicted = {
        existing: null,
        shift: null,
        // S58 (R-412, D132 item 1): the reference form's own `adjust: null`
        // (added above) must be matched here too, or this "structurally
        // equivalent, keys reordered" fixture stops being equivalent.
        adjust: null,
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
        // S58 (R-412, D132 item 1): every `MoveCommand` now carries `adjust`
        // -- `null` here is this row's own pre-S58 shape, an ordinary move
        // in time, not an edge adjust.
        adjust: null,
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
    // S58 (S56-b data brief §1/§5): re-pinned again -- split/headcount join
    // the ten intents and the held-out set was regenerated on the SAME seed
    // 20260915 (`data/voice/README.md`'s own rule: a grammar widening, not a
    // deliberate drift, keeps the seed). Read from `node scripts/voice/score.mjs
    // --heldout data/voice/heldout.jsonl --rule-parser --bar 0.95`: clean
    // 500/500 (1.0), perturbed 43/500 (0.086) -- up from the prior 19/400
    // (0.0475) mostly because two of the two NEW intents' own templates
    // (split/headcount) happen to land on a perturbable keyword/name more
    // often than the eight-intent average did, not because anything
    // stopped perturbing (V6 below still checks that directly).
    const predict = (row: VoiceRow) => {
      const result = parseCommand(row.sentence);
      return result.ok ? result.command : null;
    };
    const result = score(HELDOUT, predict);
    expect(rate(result.clean)).toBe(1);
    expect(result.clean).toEqual({ n: 500, correct: 500 });
    expect(result.perturbed).toEqual({ n: 500, correct: 43 });
    // Pinned with a tolerance around the number this generator actually
    // produces (~8.6%) -- a perturbation catalogue that stopped perturbing
    // (every function became a no-op) would push this toward 1.0, and that
    // is exactly the drift this pin exists to catch.
    expect(rate(result.perturbed)).toBeGreaterThan(0);
    expect(rate(result.perturbed)).toBeLessThan(0.5);
    expect(rate(result.perturbed)).toBeCloseTo(0.086, 2);
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
    // S58: re-pinned alongside V6, same regeneration, same reason.
    const predict = (row: VoiceRow) => {
      const result = parseCommand(row.sentence);
      return result.ok ? result.command : null;
    };
    const result = score(HELDOUT, predict);
    expect(rate(result.clean)).toBe(1);
    expect(result.clean).toEqual({ n: 500, correct: 500 });
    expect(result.perturbed).toEqual({ n: 500, correct: 43 });
    expect(rate(result.perturbed)).toBeGreaterThan(0);
    expect(rate(result.perturbed)).toBeLessThan(0.5);
    expect(rate(result.perturbed)).toBeCloseTo(0.086, 2);
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
        expect(
          // S58: `SplitCommand` carries neither `shift` nor `span` at all
          // (R-413's own four fields, `at` instead) -- narrowed out here
          // alongside `copy`, which never had either either.
          (c as Exclude<typeof c, { intent: "copy" } | { intent: "split" }>).shift,
          `${id}: "${sentence}"`,
        ).not.toBeNull();
        if (c.intent === "assign" || c.intent === "book") {
          expect(c.start, `${id}: "${sentence}"`).toBeNull();
          expect(c.end, `${id}: "${sentence}"`).toBeNull();
        } else {
          expect(
            (c as Exclude<typeof c, { intent: "copy" } | { intent: "split" }>).span,
            `${id}: "${sentence}"`,
          ).toBeNull();
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

  describe("V18 (F-145): scorePredictions checks a prediction row's sentence against the held-out row of the same id", () => {
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
      {
        id: "r1",
        intent: "assign",
        sentence: "assign Sam Patel to Housing A in Cell 1 from 10am to 2pm",
        form,
        clean: true,
        source: "x",
      },
    ];

    it("V18a: a predictions row whose sentence differs from the held-out row's throws, naming F-145 and the id", () => {
      const predictionRows = [{ id: "r1", sentence: "a completely different sentence", form }];
      expect(() => scorePredictions(rows, predictionRows)).toThrow(/F-145/);
      expect(() => scorePredictions(rows, predictionRows)).toThrow(/r1/);
      expect(() => scorePredictions(rows, predictionRows)).toThrow(/different held-out file/);
    });

    it("V18b: a predictions row with the right sentence scores normally", () => {
      const predictionRows = [{ id: "r1", sentence: rows[0].sentence, form }];
      const result = scorePredictions(rows, predictionRows);
      expect(rate(result.clean)).toBe(1);
      expect(result.sentencesNotChecked).toBe(0);
    });

    it("V18c: a predictions row with no sentence field scores and is counted in the not-checked line", () => {
      const predictionRows = [{ id: "r1", form }];
      const result = scorePredictions(rows, predictionRows);
      expect(rate(result.clean)).toBe(1);
      expect(result.sentencesNotChecked).toBe(1);
      expect(formatSentencesNotCheckedLine(result.sentencesNotChecked)).toBe(
        "sentences not checked: 1 rows (predictions from before F-145)",
      );
    });
  });

  describe("V19-V20 (S56): the scorer on the two board-answered intents with a `with`/`other` field", () => {
    const copyForm: Command = {
      intent: "copy",
      place: ["Cell 1"],
      from: { kind: "yesterday" },
      to: { kind: "today" },
    };
    const replaceForm: Command = {
      intent: "replace",
      operator: "Sam Patel",
      with: "Ana Silva",
      place: ["Cell 1"],
      day: null,
      span: null,
      shift: null,
    };

    it("V19: an exact copy prediction scores correct; a wrong `to` field is wrong and tallied, `from` still right", () => {
      const rows: VoiceRow[] = [
        { id: "c1", intent: "copy", sentence: "n/a", form: copyForm, clean: true, source: "x" },
      ];
      const exact = score(rows, () => copyForm);
      expect(rate(exact.clean)).toBe(1);

      const wrongTo: Command = { ...copyForm, to: { kind: "tomorrow" } };
      const wrong = score(rows, () => wrongTo);
      expect(rate(wrong.clean)).toBe(0);
      expect(wrong.byField.to).toEqual({ n: 1, correct: 0 });
      expect(wrong.byField.from).toEqual({ n: 1, correct: 1 });
    });

    it("V20: an exact replace prediction scores correct; a wrong `with` field is wrong and tallied, `operator` still right", () => {
      const rows: VoiceRow[] = [
        {
          id: "r1",
          intent: "replace",
          sentence: "n/a",
          form: replaceForm,
          clean: true,
          source: "x",
        },
      ];
      const exact = score(rows, () => replaceForm);
      expect(rate(exact.clean)).toBe(1);

      const wrongWith: Command = { ...replaceForm, with: "Someone Else" };
      const wrong = score(rows, () => wrongWith);
      expect(rate(wrong.clean)).toBe(0);
      expect(wrong.byField.with).toEqual({ n: 1, correct: 0 });
      expect(wrong.byField.operator).toEqual({ n: 1, correct: 1 });
    });
  });

  it("V21: a prediction missing `until` on an absence row is wrong -- missing is not an implicit null", () => {
    const form: Command = {
      intent: "unassign",
      operator: "Sam Patel",
      place: [],
      day: { kind: "today" },
      span: null,
      existing: null,
      shift: null,
      until: { kind: "weekday", day: 5 },
    };
    const rows: VoiceRow[] = [
      { id: "u1", intent: "unassign", sentence: "n/a", form, clean: true, source: "x" },
    ];
    const predicted = { ...form } as Record<string, unknown>;
    delete predicted.until;
    const result = score(rows, () => predicted);
    expect(rate(result.clean)).toBe(0);
    expect(result.byField.until).toEqual({ n: 1, correct: 0 });
    // A field the prediction OMITS is missing, never counted as an invented
    // extra (V12's own rule, re-exercised here for `until` specifically).
    expect(result.extraKeys).toEqual({ n: 0, keys: {} });
  });

  it("V22 (R-409): a perturbed absence row keeps the clean sentence's own form", () => {
    const t = templateById("U19-absence-until");
    const rng = mulberry32(seedFrom("U19-absence-until", "V22"));
    const slots = t.genSlots(rng);
    const sentence = t.sentence(slots);
    const form = t.form(slots) as Command;
    const perturbedResult = perturbAll(
      sentence,
      mulberry32(seedFrom("U19-absence-until", "V22p")),
      3,
    );
    expect(perturbedResult.sentence).not.toBe(sentence); // the perturbation actually did something
    const rowForm = perturbedRowForm(form, perturbedResult.ids) as Command;
    expect(equalForms(rowForm, form)).toBe(true);

    // The same guarantee holds end to end for every perturbed absence row
    // the committed held-out set actually carries (U18/U19's own source ids).
    const absenceRows = HELDOUT.filter(
      (r) =>
        (r.source.startsWith("U18-absence-day") || r.source.startsWith("U19-absence-until")) &&
        !r.clean,
    );
    expect(absenceRows.length).toBeGreaterThan(0);
    for (const row of absenceRows) {
      expect((row.form as { intent: string }).intent).toBe("unassign");
      expect((row.form as { place: string[] }).place).toEqual([]);
    }
  });

  it("V23: the system prompt mentions every new intent's word and the new vocabulary (a guard against prompt drift)", () => {
    const prompt = readFileSync("scripts/voice/train/system_prompt.txt", "utf8").toLowerCase();
    // The three new intents (D130 item 2).
    for (const word of ["replace", "swap", "copy"]) {
      expect(prompt, word).toContain(word);
    }
    // The four day words (R-404, D130 item 3's own "yesterday" addition).
    for (const word of ["today", "tomorrow", "yesterday", "weekday"]) {
      expect(prompt, word).toContain(word);
    }
    // The three reserved shift names, and that the two "end of" ones may
    // carry a start.
    expect(prompt).toContain("all day");
    expect(prompt).toContain("end of shift");
    expect(prompt).toContain("end of day");
    expect(prompt).toContain("may still carry a start");
    // "everyone" and "clear <place>".
    expect(prompt).toContain("everyone");
    expect(prompt).toContain("clear <place>");
    // An absence and its own field.
    expect(prompt).toContain("absence");
    expect(prompt).toContain("until");
    // "several" never holds the three new intents.
    expect(prompt).toContain("a several never holds");
  });

  it('V24 (S56 review): A20-time-of-day and U13-pull-time-of-day never say "this night" -- nobody says that, they say "tonight"', () => {
    // Bug: both templates picked `word` from the full `TIME_OF_DAY_WORDS`
    // pool (morning/afternoon/evening/night) for their "this <word>"
    // phrasing without excluding "night" -- parse.ts's own comment already
    // calls "this night" out as the irregular case "tonight" exists for
    // (src/lib/command/parse.ts's TIME_OF_DAY_WORDS doc comment), so the
    // sentence is grammatically valid but not something a plant scheduler
    // would ever type or say. Found sampling 150 held-out and 300 train
    // rows by hand (the review brief's attack step 1) and confirmed by
    // grepping the generated corpus for the literal phrase. Fixed by
    // drawing from `TIME_OF_DAY_WORDS_THIS` (night excluded) for exactly
    // the "this" branch; "tonight" itself, and "tomorrow night"/"for the
    // night", are untouched and still cover "night" naturally.
    const a20 = templateById("A20-time-of-day");
    const u13 = templateById("U13-pull-time-of-day");
    for (let i = 1; i <= 500; i++) {
      const a20Slots = a20.genSlots(mulberry32(seedFrom("A20-time-of-day", `V24-${i}`)));
      expect(a20.sentence(a20Slots), `A20 draw ${i}`).not.toContain("this night");
      const u13Slots = u13.genSlots(mulberry32(seedFrom("U13-pull-time-of-day", `V24-${i}`)));
      expect(u13.sentence(u13Slots), `U13 draw ${i}`).not.toContain("this night");
    }
    // The same guarantee over the committed corpus, not just fresh draws.
    for (const row of HELDOUT) {
      expect(row.sentence, row.id).not.toContain("this night");
    }
  });

  it('V25 (S56 review): A14-duration covers DU6\'s "half an hour" and DU4\'s decimal "N.N hours", not just the word forms', () => {
    // Bug: the S55-a grammar brief's own DU1-DU6 list (parseDurationMinutes)
    // has five duration SPELLINGS -- "N hours", "an hour", "N and a half
    // hours", "N minutes", "half an hour", and separately a decimal spelling
    // ("1.5 hours", DU4, the SAME value as DU3's word form but a different
    // surface) -- but A14-duration's `genSlots` only ever produced four of
    // those six shapes; the S56-a data brief's own bullet for A14 happens to
    // repeat only four of them too, so the gap was silent. Found doing the
    // review brief's attack step 7 (every S55-a-brief sentence checked
    // against what a template actually emits). Sampled over many draws
    // (never asserted "on the first try") because `kind` is one pick among
    // several.
    const t = templateById("A14-duration");
    let sawHalfAnHour = false;
    let sawDecimal = false;
    for (let i = 1; i <= 300; i++) {
      const slots = t.genSlots(mulberry32(seedFrom("A14-duration", `V25-${i}`)));
      const sentence = t.sentence(slots);
      const form = t.form(slots) as Command;
      const result = parseCommand(sentence);
      expect(result.ok, `"${sentence}" did not parse`).toBe(true);
      if (result.ok) expect(equalForms(result.command, form), sentence).toBe(true);
      if (sentence.includes("half an hour")) sawHalfAnHour = true;
      if (/for \d+\.\d+ h(ou)?rs?\b/.test(sentence)) sawDecimal = true;
    }
    expect(sawHalfAnHour, 'never drew "half an hour" in 300 tries').toBe(true);
    expect(sawDecimal, "never drew a decimal duration in 300 tries").toBe(true);
  });

  it("V26 (S56 review): the system prompt says swap's place may be [] too, matching replace's own annotation", () => {
    // Bug: replace's own line already said "place (or [])"; swap's did not,
    // even though two of swap's own three templates (W1-swap-and,
    // W3-exchange) never name a place at all -- a model reading the prompt
    // literally could conclude swap always needs one. Found reading the
    // prompt against `form.schema.json` (both allow `minItems: 0` for
    // swap's `place`, D130 item 2).
    const prompt = readFileSync("scripts/voice/train/system_prompt.txt", "utf8");
    const swapLine = prompt.split("\n").find((l) => l.startsWith("swap:"));
    expect(swapLine, "no swap: line in the prompt").toBeTruthy();
    expect(swapLine).toContain("place (or [])");
  });

  // -------------------------------------------------------------------------
  // S58 (docs/agent-briefs/s58-a-grammar-brief.md, R-412 to R-416, design
  // §19.103/D132; S56-b data brief §6): group 2's own template families.
  // -------------------------------------------------------------------------

  it("V27 (S58, R-412): every M13-M15 draw sets adjust and clears span/shift/toPlace -- the invariant D132 item 1 states", () => {
    const ids = ["M13-extend-by", "M14-end-at", "M15-edge-tail"];
    for (const id of ids) {
      const t = templateById(id);
      for (let i = 1; i <= 200; i++) {
        const rng = mulberry32(seedFrom(id, `V27-${i}`));
        const slots = t.genSlots(rng);
        const sentence = t.sentence(slots);
        const form = t.form(slots) as Command;
        const result = parseCommand(sentence);
        expect(result.ok, `${id}: "${sentence}" did not parse`).toBe(true);
        if (!result.ok) continue;
        expect(equalForms(result.command, form), `${id}: "${sentence}"`).toBe(true);
        expect(form.intent, id).toBe("move");
        if (form.intent !== "move") continue;
        expect(form.adjust, `${id}: "${sentence}"`).not.toBeNull();
        expect(form.span, `${id}: "${sentence}"`).toBeNull();
        expect(form.shift, `${id}: "${sentence}"`).toBeNull();
        expect(form.toPlace, `${id}: "${sentence}"`).toBeNull();
        if (form.adjust) {
          const hasBy = "by" in form.adjust;
          const hasAt = "at" in form.adjust;
          expect(hasBy !== hasAt, `${id}: "${sentence}" adjust has both or neither of by/at`).toBe(
            true,
          );
        }
      }
    }
  });

  it("V28 (S58, R-413): every X1-split-at draw is a SplitCommand -- no shift/span key, operator/place/day/at all present", () => {
    const t = templateById("X1-split-at");
    for (let i = 1; i <= 200; i++) {
      const rng = mulberry32(seedFrom("X1-split-at", `V28-${i}`));
      const slots = t.genSlots(rng);
      const sentence = t.sentence(slots);
      const form = t.form(slots) as Command;
      const result = parseCommand(sentence);
      expect(result.ok, `"${sentence}" did not parse`).toBe(true);
      if (!result.ok) continue;
      expect(equalForms(result.command, form), sentence).toBe(true);
      expect(form.intent).toBe("split");
      expect(Object.keys(form).sort()).toEqual(["at", "day", "intent", "operator", "place"]);
      if (form.intent === "split") {
        expect(form.at.hour).toBeGreaterThanOrEqual(0);
        expect(form.at.hour).toBeLessThanOrEqual(23);
      }
    }
  });

  it("V29 (S58, R-415): every H1-H3 draw's headcount is 1-99", () => {
    const ids = ["H1-make-job-people", "H2-set-job-to", "H3-with-hours-or-shift"];
    for (const id of ids) {
      const t = templateById(id);
      for (let i = 1; i <= 200; i++) {
        const rng = mulberry32(seedFrom(id, `V29-${i}`));
        const slots = t.genSlots(rng);
        const sentence = t.sentence(slots);
        const form = t.form(slots) as Command;
        const result = parseCommand(sentence);
        expect(result.ok, `${id}: "${sentence}" did not parse`).toBe(true);
        if (!result.ok) continue;
        expect(equalForms(result.command, form), `${id}: "${sentence}"`).toBe(true);
        expect(form.intent, id).toBe("headcount");
        if (form.intent !== "headcount") continue;
        expect(form.headcount).toBeGreaterThanOrEqual(1);
        expect(form.headcount).toBeLessThanOrEqual(99);
      }
    }
    // D132 item 4 ("never part of a lot"): headcount sits outside
    // `severalTemplates` altogether -- there is no H-series id anywhere in
    // that array for a several to have drawn from in the first place.
    for (const t of TEMPLATES) {
      if (t.id.startsWith("H") && t.intent === "headcount") continue;
      expect(t.intent, t.id).not.toBe("headcount");
    }
  });

  it("V30 (S58, R-414): every A21-add-to-job draw carries shift JOB_HOURS and start/end null", () => {
    const t = templateById("A21-add-to-job");
    for (let i = 1; i <= 200; i++) {
      const rng = mulberry32(seedFrom("A21-add-to-job", `V30-${i}`));
      const slots = t.genSlots(rng);
      const sentence = t.sentence(slots);
      const form = t.form(slots) as Command;
      const result = parseCommand(sentence);
      expect(result.ok, `"${sentence}" did not parse`).toBe(true);
      if (!result.ok) continue;
      expect(equalForms(result.command, form), sentence).toBe(true);
      expect(form.intent).toBe("assign");
      if (form.intent === "assign") {
        expect(form.shift).toBe(JOB_HOURS);
        expect(form.start).toBeNull();
        expect(form.end).toBeNull();
      }
    }
  });

  it("V31 (S58, R-416): every A22/B11 draw's day is a repeat kind, on the one shape (assign/book) that may carry it", () => {
    const ids: Array<[string, "assign" | "book"]> = [
      ["A22-every-weekday", "assign"],
      ["B11-every-day", "book"],
    ];
    for (const [id, intent] of ids) {
      const t = templateById(id);
      for (let i = 1; i <= 200; i++) {
        const rng = mulberry32(seedFrom(id, `V31-${i}`));
        const slots = t.genSlots(rng);
        const sentence = t.sentence(slots);
        const form = t.form(slots) as Command;
        const result = parseCommand(sentence);
        expect(result.ok, `${id}: "${sentence}" did not parse`).toBe(true);
        if (!result.ok) continue;
        expect(equalForms(result.command, form), `${id}: "${sentence}"`).toBe(true);
        expect(form.intent, id).toBe(intent);
        const day = (form as { day: { kind: string; week: string } }).day;
        expect(["weekdays", "every_day"]).toContain(day.kind);
        expect(["this_week", "next_week"]).toContain(day.week);
      }
    }
  });

  it("V32 (F-146): time.mjs's buildTimePair/resolveLoneTime write DAY_END for an END of midnight, never a START", () => {
    const endMidnight = buildTimePair(
      { kind: "24h", hour: 20, minute: 0 },
      { kind: "midnight" },
      "to",
    );
    expect(endMidnight).not.toBeNull();
    expect(endMidnight!.start).toEqual({ hour: 20, minute: 0 });
    expect(endMidnight!.end).toEqual({ hour: 23, minute: 59 });
    expect(endMidnight!.text).toBe("20 to midnight");

    // The S58 brief's own rule: "a START of midnight stays {0,0}".
    const startMidnight = buildTimePair(
      { kind: "midnight" },
      { kind: "24h", hour: 9, minute: 0 },
      "to",
    );
    expect(startMidnight).not.toBeNull();
    expect(startMidnight!.start).toEqual({ hour: 0, minute: 0 });
    expect(startMidnight!.end).toEqual({ hour: 9, minute: 0 });

    expect(resolveLoneTime({ kind: "midnight" }, { allowDayEnd: true })).toMatchObject({
      hour: 23,
      minute: 59,
    });
    // The same spec with no `allowDayEnd` (a START's own door) stays literal.
    expect(resolveLoneTime({ kind: "midnight" })).toMatchObject({ hour: 0, minute: 0 });

    // The lone-edge workday rule (AJ7/SP3): an hour 1-6 with no explicit
    // meridiem reads as pm; 7 and up are unchanged.
    expect(resolveLoneTime({ kind: "24h", hour: 3, minute: 0 })).toMatchObject({
      hour: 15,
      minute: 0,
    });
    expect(resolveLoneTime({ kind: "24h", hour: 9, minute: 0 })).toMatchObject({
      hour: 9,
      minute: 0,
    });
  });

  describe("V33 (S58): the scorer on the two new intents' own fields", () => {
    const splitForm: Command = {
      intent: "split",
      operator: "Sam Patel",
      place: ["Cell 1"],
      day: null,
      at: { hour: 12, minute: 0 },
    };
    const headcountForm: Command = {
      intent: "headcount",
      product: "Housing A",
      place: ["Cell 1"],
      day: null,
      span: null,
      shift: null,
      headcount: 4,
    };

    it("V33a: an exact split prediction scores correct; a wrong `at` field is wrong and tallied, `place` still right", () => {
      const rows: VoiceRow[] = [
        { id: "sp1", intent: "split", sentence: "n/a", form: splitForm, clean: true, source: "x" },
      ];
      const exact = score(rows, () => splitForm);
      expect(rate(exact.clean)).toBe(1);

      const wrongAt: Command = { ...splitForm, at: { hour: 13, minute: 0 } };
      const wrong = score(rows, () => wrongAt);
      expect(rate(wrong.clean)).toBe(0);
      expect(wrong.byField.at).toEqual({ n: 1, correct: 0 });
      expect(wrong.byField.place).toEqual({ n: 1, correct: 1 });
    });

    it("V33b: an exact headcount prediction scores correct; a wrong `headcount` field is wrong and tallied, `product` still right", () => {
      const rows: VoiceRow[] = [
        {
          id: "hc1",
          intent: "headcount",
          sentence: "n/a",
          form: headcountForm,
          clean: true,
          source: "x",
        },
      ];
      const exact = score(rows, () => headcountForm);
      expect(rate(exact.clean)).toBe(1);

      const wrongCount: Command = { ...headcountForm, headcount: 5 };
      const wrong = score(rows, () => wrongCount);
      expect(rate(wrong.clean)).toBe(0);
      expect(wrong.byField.headcount).toEqual({ n: 1, correct: 0 });
      expect(wrong.byField.product).toEqual({ n: 1, correct: 1 });
    });
  });

  it("V34 (S58): the system prompt mentions every new S58 word (a guard against prompt drift)", () => {
    const prompt = readFileSync("scripts/voice/train/system_prompt.txt", "utf8").toLowerCase();
    for (const word of [
      "split",
      "headcount",
      "adjust",
      "the job",
      "every weekday",
      "every day",
      "weekdays",
    ]) {
      expect(prompt, word).toContain(word);
    }
    expect(prompt).toContain("make it n people");
    expect(prompt).toContain("this_week");
  });

  it("V35 (S56-b brief §4's own flag): the perturber's speech-digit-as-word never mangles a digit inside an ISO date", () => {
    const sentence = "assign Sam to Housing A on Cell 1 on 2026-09-04";
    let sawAChange = false;
    for (let i = 1; i <= 300; i++) {
      const rng = mulberry32(seedFrom("speech-digit-as-word-V35", `${i}`));
      const result = CATALOG["speech-digit-as-word"](sentence, rng);
      expect(result, `draw ${i}`).toContain("2026-09-04");
      if (result !== sentence) sawAChange = true;
    }
    // The guard must not have disabled the perturbation altogether -- "Cell
    // 1"'s own bare "1" is still fair game.
    expect(sawAChange, "never perturbed the non-ISO bare number in 300 tries").toBe(true);
  });
});
