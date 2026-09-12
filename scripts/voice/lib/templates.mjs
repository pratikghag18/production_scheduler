// scripts/voice/lib/templates.mjs — the sentence templates, one per named id,
// covering the four intents `src/lib/command/parse.ts` reads (S42-a §4).
//
// Each template is `{ id, intent, genSlots(rng), sentence(slots), form(slots) }`:
// `genSlots` is a pure function of an rng (S42-a §3, "a function of a filled
// slot set"; here the slot set itself is produced by a pure function of the
// rng so a fixed seed gives a fixed, reproducible slot set for V2). `sentence`
// and `form` are both built from the SAME slots independently of the parser --
// neither calls `parseCommand` -- so `generate.mjs`'s assertion that
// `parseCommand(sentence(slots))` equals `form(slots)` is a real check, not a
// tautology (brief §2).
import { pick, randInt, chance } from "./rng.mjs";
import { buildTimePair, TIME_SEPARATORS } from "./time.mjs";
import {
  PEOPLE_ALL,
  PARTS_ALL,
  CELLS_ALL,
  LINES_ALL,
  AREAS_ALL,
  WEEKDAY_FULL,
  WEEKDAY_ABBR,
  ISO_DATES,
} from "./pools.mjs";
// R-391: the four verb lists are the one export from parse.ts (this is the
// oracle's own import path, `rows.mjs`'s), so a template's verb is drawn from
// the SAME list the parser reads its intent from -- never retyped here. A
// template whose id names a verb on purpose (say which in the report) keeps
// that verb hard-coded instead, so its own mechanic (a dash separator, an
// "off" separator, a comma list) stays pinned to a known word.
import {
  ASSIGN_VERBS,
  BOOK_VERBS,
  UNASSIGN_VERBS,
  MOVE_VERBS,
} from "../../../src/lib/command/parse.ts";

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

// ---------------------------------------------------------------------------
// Shared helpers -- mirror parse.ts's own quoting rule (needsQuoting /
// quoteIfNeeded) so a pool name that contains a separator word round-trips
// through the sentence exactly as a person using the real bar would have to
// type it (quoted), never by accident breaking the split it sits in.
// ---------------------------------------------------------------------------

function needsQuoting(word) {
  return /\b(to|on|at|in)\b/i.test(word) || word.includes(",");
}

function qw(word) {
  return needsQuoting(word) ? `"${word}"` : word;
}

/** Names built on purpose to need quoting -- exercises the parser's quoted-
 *  segment path (brief §4, P17; p1-7a's own worked example, "Lin On"). */
const TRICKY_OPERATORS = ["Lin On", "Jo To", "Ann At Bay", "Cy In Field"];
const TRICKY_CELLS = ["Cell in 2", "Bay on 3", "Dock at 5", "Line, North"];

function randomDay(rng) {
  const kind = pick(rng, ["today", "tomorrow", "weekday", "iso"]);
  if (kind === "today") {
    const withOn = chance(rng, 0.5);
    return { text: withOn ? "on today" : "today", day: { kind: "today" } };
  }
  if (kind === "tomorrow") {
    const withOn = chance(rng, 0.5);
    return { text: withOn ? "on tomorrow" : "tomorrow", day: { kind: "tomorrow" } };
  }
  if (kind === "weekday") {
    const idx = randInt(rng, 0, 6);
    const word = chance(rng, 0.5) ? WEEKDAY_FULL[idx] : WEEKDAY_ABBR[idx];
    const withOn = chance(rng, 0.5);
    return { text: withOn ? `on ${word}` : word, day: { kind: "weekday", day: idx } };
  }
  const iso = pick(rng, ISO_DATES);
  return { text: `on ${iso}`, day: { kind: "date", iso } };
}

function randomHeadcount(rng) {
  const n = randInt(rng, 1, 12);
  const word = pick(rng, ["people", "persons", "operators", "heads"]);
  return { text: `for ${n} ${word}`, headcount: n };
}

/** A random `from <t1> <sep> <t2>` pair, in one of the styles the grammar
 *  accepts: plain 24h, am/pm, noon/midnight, and -- when the end hour allows
 *  it -- the bare small number that only the afternoon rule turns into an
 *  afternoon hour ("from 10 to 2"). Retries (extremely rarely) on the one
 *  combination that cannot produce end-after-start. */
function randomSpan(rng) {
  const startHour = randInt(rng, 6, 18);
  let duration = pick(rng, [2, 3, 4, 6, 8]);
  if (startHour + duration > 22) duration = Math.max(1, 22 - startHour);
  const endHour = startHour + duration;
  const startMinute = pick(rng, [0, 0, 0, 15, 30, 45]);
  const endMinute = pick(rng, [0, 0, 0, 15, 30, 45]);

  let startSpec;
  if (startHour === 12 && startMinute === 0 && chance(rng, 0.2)) {
    startSpec = { kind: "noon" };
  } else if (chance(rng, 0.5)) {
    startSpec = { kind: "ampm", hour: startHour, minute: startMinute, spaced: chance(rng, 0.5) };
  } else {
    startSpec = { kind: "24h", hour: startHour, minute: startMinute };
  }

  let endSpec;
  const endStyle = pick(rng, ["24h", "ampm", "ambiguous"]);
  if (endStyle === "ambiguous" && endHour > 12 && endHour <= 23) {
    endSpec = { kind: "24h", hour: endHour - 12, minute: endMinute }; // relies on the afternoon rule
  } else if (endStyle === "ampm") {
    endSpec = { kind: "ampm", hour: endHour, minute: endMinute, spaced: chance(rng, 0.5) };
  } else {
    endSpec = { kind: "24h", hour: endHour, minute: endMinute };
  }

  const sep = pick(rng, TIME_SEPARATORS);
  const pair = buildTimePair(startSpec, endSpec, sep);
  if (!pair) return randomSpan(rng);
  return pair;
}

function baseCommand(intent, extra) {
  return { intent, ...extra };
}

// ---------------------------------------------------------------------------
// Assign (A1-A10)
// ---------------------------------------------------------------------------

const assignTemplates = [
  {
    id: "A1-maintainer",
    intent: "assign",
    genSlots: (rng) => ({
      verb: pick(rng, ASSIGN_VERBS),
      op: pick(rng, PEOPLE_ALL),
      part: pick(rng, PARTS_ALL),
      cell: pick(rng, CELLS_ALL),
      line: pick(rng, LINES_ALL),
      span: randomSpan(rng),
    }),
    sentence: (s) =>
      `${capitalize(s.verb)} ${qw(s.op)} to work on ${qw(s.part)} on ${qw(s.cell)} in ${qw(s.line)} from ${s.span.text}`,
    form: (s) =>
      baseCommand("assign", {
        operator: s.op,
        product: s.part,
        place: [s.cell, s.line],
        day: null,
        start: s.span.start,
        end: s.span.end,
        attach: null,
        existing: null,
      }),
  },
  {
    id: "A2-put-dash",
    intent: "assign",
    genSlots: (rng) => {
      const startHour = randInt(rng, 6, 16);
      const endHour = startHour + pick(rng, [2, 4, 6]);
      const span = buildTimePair(
        { kind: "24h", hour: startHour, minute: 0 },
        { kind: "24h", hour: endHour, minute: 0 },
        "-",
      );
      return {
        op: pick(rng, PEOPLE_ALL),
        part: pick(rng, PARTS_ALL),
        cell: pick(rng, CELLS_ALL),
        span,
      };
    },
    sentence: (s) => `put ${qw(s.op)} on ${qw(s.part)} at ${qw(s.cell)} from ${s.span.text}`,
    form: (s) =>
      baseCommand("assign", {
        operator: s.op,
        product: s.part,
        place: [s.cell],
        day: null,
        start: s.span.start,
        end: s.span.end,
        attach: null,
        existing: null,
      }),
  },
  {
    id: "A3-no-verb-commas",
    intent: "assign",
    genSlots: (rng) => ({
      op: pick(rng, PEOPLE_ALL),
      part: pick(rng, PARTS_ALL),
      cell: pick(rng, CELLS_ALL),
      line: pick(rng, LINES_ALL),
      area: pick(rng, AREAS_ALL),
      span: randomSpan(rng),
    }),
    sentence: (s) =>
      `${qw(s.op)} to ${qw(s.part)} on ${qw(s.cell)}, ${qw(s.line)}, ${qw(s.area)} from ${s.span.text}`,
    form: (s) =>
      baseCommand("assign", {
        operator: s.op,
        product: s.part,
        place: [s.cell, s.line, s.area],
        day: null,
        start: s.span.start,
        end: s.span.end,
        attach: null,
        existing: null,
      }),
  },
  {
    id: "A4-day-today",
    intent: "assign",
    genSlots: (rng) => ({
      verb: pick(rng, ASSIGN_VERBS),
      op: pick(rng, PEOPLE_ALL),
      part: pick(rng, PARTS_ALL),
      cell: pick(rng, CELLS_ALL),
      span: randomSpan(rng),
    }),
    sentence: (s) =>
      `${s.verb} ${qw(s.op)} to ${qw(s.part)} on ${qw(s.cell)} today from ${s.span.text}`,
    form: (s) =>
      baseCommand("assign", {
        operator: s.op,
        product: s.part,
        place: [s.cell],
        day: { kind: "today" },
        start: s.span.start,
        end: s.span.end,
        attach: null,
        existing: null,
      }),
  },
  {
    id: "A5-day-tomorrow-on",
    intent: "assign",
    genSlots: (rng) => ({
      verb: pick(rng, ASSIGN_VERBS),
      op: pick(rng, PEOPLE_ALL),
      part: pick(rng, PARTS_ALL),
      cell: pick(rng, CELLS_ALL),
      span: randomSpan(rng),
    }),
    sentence: (s) =>
      `${s.verb} ${qw(s.op)} to ${qw(s.part)} on ${qw(s.cell)} on tomorrow from ${s.span.text}`,
    form: (s) =>
      baseCommand("assign", {
        operator: s.op,
        product: s.part,
        place: [s.cell],
        day: { kind: "tomorrow" },
        start: s.span.start,
        end: s.span.end,
        attach: null,
        existing: null,
      }),
  },
  {
    id: "A6-day-weekday",
    intent: "assign",
    genSlots: (rng) => {
      const idx = randInt(rng, 0, 6);
      const word = chance(rng, 0.5) ? WEEKDAY_FULL[idx] : WEEKDAY_ABBR[idx];
      return {
        verb: pick(rng, ASSIGN_VERBS),
        op: pick(rng, PEOPLE_ALL),
        part: pick(rng, PARTS_ALL),
        cell: pick(rng, CELLS_ALL),
        line: pick(rng, LINES_ALL),
        dayWord: word,
        dayIdx: idx,
        span: randomSpan(rng),
      };
    },
    sentence: (s) =>
      `${s.verb} ${qw(s.op)} to ${qw(s.part)} on ${qw(s.cell)} in ${qw(s.line)} ${s.dayWord} from ${s.span.text}`,
    form: (s) =>
      baseCommand("assign", {
        operator: s.op,
        product: s.part,
        place: [s.cell, s.line],
        day: { kind: "weekday", day: s.dayIdx },
        start: s.span.start,
        end: s.span.end,
        attach: null,
        existing: null,
      }),
  },
  {
    id: "A7-day-iso",
    intent: "assign",
    genSlots: (rng) => ({
      verb: pick(rng, ASSIGN_VERBS),
      op: pick(rng, PEOPLE_ALL),
      part: pick(rng, PARTS_ALL),
      cell: pick(rng, CELLS_ALL),
      iso: pick(rng, ISO_DATES),
      span: randomSpan(rng),
    }),
    sentence: (s) =>
      `${s.verb} ${qw(s.op)} to ${qw(s.part)} on ${qw(s.cell)} on ${s.iso} from ${s.span.text}`,
    form: (s) =>
      baseCommand("assign", {
        operator: s.op,
        product: s.part,
        place: [s.cell],
        day: { kind: "date", iso: s.iso },
        start: s.span.start,
        end: s.span.end,
        attach: null,
        existing: null,
      }),
  },
  {
    id: "A8-quoted-until",
    intent: "assign",
    genSlots: (rng) => {
      const startHour = randInt(rng, 6, 16);
      const endHour = startHour + pick(rng, [2, 4, 6]);
      const span = buildTimePair(
        { kind: "24h", hour: startHour, minute: 0 },
        { kind: "24h", hour: endHour, minute: 0 },
        "until",
      );
      return {
        verb: pick(rng, ASSIGN_VERBS),
        op: pick(rng, TRICKY_OPERATORS),
        part: pick(rng, PARTS_ALL),
        cell: pick(rng, TRICKY_CELLS),
        span,
      };
    },
    sentence: (s) => `${s.verb} "${s.op}" to ${qw(s.part)} on "${s.cell}" from ${s.span.text}`,
    form: (s) =>
      baseCommand("assign", {
        operator: s.op,
        product: s.part,
        place: [s.cell],
        day: null,
        start: s.span.start,
        end: s.span.end,
        attach: null,
        existing: null,
      }),
  },
  {
    id: "A9-noon",
    intent: "assign",
    genSlots: (rng) => {
      const startHour = randInt(rng, 6, 11);
      const span = buildTimePair(
        { kind: "24h", hour: startHour, minute: 0 },
        { kind: "noon" },
        "to",
      );
      return {
        verb: pick(rng, ASSIGN_VERBS),
        op: pick(rng, PEOPLE_ALL),
        part: pick(rng, PARTS_ALL),
        cell: pick(rng, CELLS_ALL),
        span,
      };
    },
    sentence: (s) => `${s.verb} ${qw(s.op)} to ${qw(s.part)} on ${qw(s.cell)} from ${s.span.text}`,
    form: (s) =>
      baseCommand("assign", {
        operator: s.op,
        product: s.part,
        place: [s.cell],
        day: null,
        start: s.span.start,
        end: s.span.end,
        attach: null,
        existing: null,
      }),
  },
  {
    id: "A10-24h-dash-two-places",
    intent: "assign",
    genSlots: (rng) => {
      const startHour = randInt(rng, 6, 15);
      const endHour = startHour + pick(rng, [2, 4, 6]);
      const span = buildTimePair(
        { kind: "24h", hour: startHour, minute: 30 },
        { kind: "24h", hour: endHour, minute: 0 },
        "-",
      );
      return {
        verb: pick(rng, ASSIGN_VERBS),
        op: pick(rng, PEOPLE_ALL),
        part: pick(rng, PARTS_ALL),
        cell: pick(rng, CELLS_ALL),
        line: pick(rng, LINES_ALL),
        span,
      };
    },
    sentence: (s) =>
      `${s.verb} ${qw(s.op)} to ${qw(s.part)} on ${qw(s.cell)} in ${qw(s.line)} from ${s.span.text}`,
    form: (s) =>
      baseCommand("assign", {
        operator: s.op,
        product: s.part,
        place: [s.cell, s.line],
        day: null,
        start: s.span.start,
        end: s.span.end,
        attach: null,
        existing: null,
      }),
  },
];

// ---------------------------------------------------------------------------
// Book (B1-B6)
// ---------------------------------------------------------------------------

const bookTemplates = [
  {
    id: "B1-plain",
    intent: "book",
    genSlots: (rng) => ({
      verb: pick(rng, BOOK_VERBS),
      part: pick(rng, PARTS_ALL),
      cell: pick(rng, CELLS_ALL),
      line: pick(rng, LINES_ALL),
      span: randomSpan(rng),
    }),
    sentence: (s) =>
      `${capitalize(s.verb)} ${qw(s.part)} on ${qw(s.cell)} in ${qw(s.line)} from ${s.span.text}`,
    form: (s) =>
      baseCommand("book", {
        product: s.part,
        place: [s.cell, s.line],
        headcount: null,
        day: null,
        start: s.span.start,
        end: s.span.end,
        existing: null,
      }),
  },
  {
    id: "B2-run-headcount-people",
    intent: "book",
    genSlots: (rng) => ({
      part: pick(rng, PARTS_ALL),
      cell: pick(rng, CELLS_ALL),
      hc: randomHeadcount(rng),
      span: randomSpan(rng),
    }),
    sentence: (s) => `run ${qw(s.part)} at ${qw(s.cell)} ${s.hc.text} from ${s.span.text}`,
    form: (s) =>
      baseCommand("book", {
        product: s.part,
        place: [s.cell],
        headcount: s.hc.headcount,
        day: null,
        start: s.span.start,
        end: s.span.end,
        existing: null,
      }),
  },
  {
    id: "B3-headcount-tomorrow",
    intent: "book",
    genSlots: (rng) => ({
      verb: pick(rng, BOOK_VERBS),
      part: pick(rng, PARTS_ALL),
      cell: pick(rng, CELLS_ALL),
      hc: randomHeadcount(rng),
      span: randomSpan(rng),
    }),
    sentence: (s) =>
      `${s.verb} ${qw(s.part)} on ${qw(s.cell)} ${s.hc.text} tomorrow from ${s.span.text}`,
    form: (s) =>
      baseCommand("book", {
        product: s.part,
        place: [s.cell],
        headcount: s.hc.headcount,
        day: { kind: "tomorrow" },
        start: s.span.start,
        end: s.span.end,
        existing: null,
      }),
  },
  {
    id: "B4-day-only",
    intent: "book",
    genSlots: (rng) => ({
      verb: pick(rng, BOOK_VERBS),
      part: pick(rng, PARTS_ALL),
      cell: pick(rng, CELLS_ALL),
      day: randomDay(rng),
      span: randomSpan(rng),
    }),
    sentence: (s) => `${s.verb} ${qw(s.part)} on ${qw(s.cell)} ${s.day.text} from ${s.span.text}`,
    form: (s) =>
      baseCommand("book", {
        product: s.part,
        place: [s.cell],
        headcount: null,
        day: s.day.day,
        start: s.span.start,
        end: s.span.end,
        existing: null,
      }),
  },
  {
    id: "B5-commas",
    intent: "book",
    genSlots: (rng) => ({
      verb: pick(rng, BOOK_VERBS),
      part: pick(rng, PARTS_ALL),
      cell: pick(rng, CELLS_ALL),
      line: pick(rng, LINES_ALL),
      area: pick(rng, AREAS_ALL),
      span: randomSpan(rng),
    }),
    sentence: (s) =>
      `${s.verb} ${qw(s.part)} on ${qw(s.cell)}, ${qw(s.line)}, ${qw(s.area)} from ${s.span.text}`,
    form: (s) =>
      baseCommand("book", {
        product: s.part,
        place: [s.cell, s.line, s.area],
        headcount: null,
        day: null,
        start: s.span.start,
        end: s.span.end,
        existing: null,
      }),
  },
  {
    id: "B6-headcount-operators-word",
    intent: "book",
    genSlots: (rng) => ({
      verb: pick(rng, BOOK_VERBS),
      part: pick(rng, PARTS_ALL),
      cell: pick(rng, CELLS_ALL),
      n: randInt(rng, 1, 12),
      span: randomSpan(rng),
    }),
    sentence: (s) =>
      `${s.verb} ${qw(s.part)} on ${qw(s.cell)} for ${s.n} operators from ${s.span.text}`,
    form: (s) =>
      baseCommand("book", {
        product: s.part,
        place: [s.cell],
        headcount: s.n,
        day: null,
        start: s.span.start,
        end: s.span.end,
        existing: null,
      }),
  },
];

// ---------------------------------------------------------------------------
// Unassign (U1-U7)
// ---------------------------------------------------------------------------

const unassignTemplates = [
  {
    id: "U1-with-hours-two-places",
    intent: "unassign",
    genSlots: (rng) => ({
      verb: pick(rng, UNASSIGN_VERBS),
      op: pick(rng, PEOPLE_ALL),
      cell: pick(rng, CELLS_ALL),
      line: pick(rng, LINES_ALL),
      span: randomSpan(rng),
    }),
    sentence: (s) =>
      `${s.verb} ${qw(s.op)} from ${qw(s.cell)} in ${qw(s.line)} from ${s.span.text}`,
    form: (s) =>
      baseCommand("unassign", {
        operator: s.op,
        place: [s.cell, s.line],
        day: null,
        span: { start: s.span.start, end: s.span.end },
        existing: null,
      }),
  },
  {
    id: "U2-remove-with-hours",
    intent: "unassign",
    genSlots: (rng) => ({
      op: pick(rng, PEOPLE_ALL),
      cell: pick(rng, CELLS_ALL),
      span: randomSpan(rng),
    }),
    sentence: (s) => `remove ${qw(s.op)} from ${qw(s.cell)} from ${s.span.text}`,
    form: (s) =>
      baseCommand("unassign", {
        operator: s.op,
        place: [s.cell],
        day: null,
        span: { start: s.span.start, end: s.span.end },
        existing: null,
      }),
  },
  {
    id: "U3-clear-off-with-hours",
    intent: "unassign",
    genSlots: (rng) => ({
      op: pick(rng, PEOPLE_ALL),
      cell: pick(rng, CELLS_ALL),
      span: randomSpan(rng),
    }),
    sentence: (s) => `clear ${qw(s.op)} off ${qw(s.cell)} from ${s.span.text}`,
    form: (s) =>
      baseCommand("unassign", {
        operator: s.op,
        place: [s.cell],
        day: null,
        span: { start: s.span.start, end: s.span.end },
        existing: null,
      }),
  },
  {
    id: "U4-no-hours-two-places",
    intent: "unassign",
    genSlots: (rng) => ({
      verb: pick(rng, UNASSIGN_VERBS),
      op: pick(rng, PEOPLE_ALL),
      cell: pick(rng, CELLS_ALL),
      line: pick(rng, LINES_ALL),
    }),
    sentence: (s) => `${s.verb} ${qw(s.op)} from ${qw(s.cell)} in ${qw(s.line)}`,
    form: (s) =>
      baseCommand("unassign", {
        operator: s.op,
        place: [s.cell, s.line],
        day: null,
        span: null,
        existing: null,
      }),
  },
  {
    id: "U5-remove-no-hours-day",
    intent: "unassign",
    genSlots: (rng) => ({
      op: pick(rng, PEOPLE_ALL),
      cell: pick(rng, CELLS_ALL),
      day: randomDay(rng),
    }),
    sentence: (s) => `remove ${qw(s.op)} from ${qw(s.cell)} ${s.day.text}`,
    form: (s) =>
      baseCommand("unassign", {
        operator: s.op,
        place: [s.cell],
        day: s.day.day,
        span: null,
        existing: null,
      }),
  },
  {
    id: "U6-clear-off-commas",
    intent: "unassign",
    genSlots: (rng) => ({
      op: pick(rng, PEOPLE_ALL),
      cell: pick(rng, CELLS_ALL),
      line: pick(rng, LINES_ALL),
      area: pick(rng, AREAS_ALL),
    }),
    sentence: (s) => `clear ${qw(s.op)} off ${qw(s.cell)}, ${qw(s.line)}, ${qw(s.area)}`,
    form: (s) =>
      baseCommand("unassign", {
        operator: s.op,
        place: [s.cell, s.line, s.area],
        day: null,
        span: null,
        existing: null,
      }),
  },
  {
    id: "U7-on-separator-day-and-hours",
    intent: "unassign",
    genSlots: (rng) => ({
      verb: pick(rng, UNASSIGN_VERBS),
      op: pick(rng, PEOPLE_ALL),
      cell: pick(rng, CELLS_ALL),
      day: randomDay(rng),
      span: randomSpan(rng),
    }),
    sentence: (s) => `${s.verb} ${qw(s.op)} on ${qw(s.cell)} ${s.day.text} from ${s.span.text}`,
    form: (s) =>
      baseCommand("unassign", {
        operator: s.op,
        place: [s.cell],
        day: s.day.day,
        span: { start: s.span.start, end: s.span.end },
        existing: null,
      }),
  },
];

// ---------------------------------------------------------------------------
// Move (M1-M6)
// ---------------------------------------------------------------------------

const moveTemplates = [
  {
    id: "M1-cell-only",
    intent: "move",
    genSlots: (rng) => ({
      verb: pick(rng, MOVE_VERBS),
      op: pick(rng, PEOPLE_ALL),
      cell: pick(rng, CELLS_ALL),
      cell2: pick(rng, CELLS_ALL),
    }),
    sentence: (s) => `${s.verb} ${qw(s.op)} on ${qw(s.cell)} to ${qw(s.cell2)}`,
    form: (s) =>
      baseCommand("move", {
        operator: s.op,
        place: [s.cell],
        toPlace: [s.cell2],
        day: null,
        span: null,
        existing: null,
      }),
  },
  {
    id: "M2-cell-and-line",
    intent: "move",
    genSlots: (rng) => ({
      verb: pick(rng, MOVE_VERBS),
      op: pick(rng, PEOPLE_ALL),
      cell: pick(rng, CELLS_ALL),
      cell2: pick(rng, CELLS_ALL),
      line2: pick(rng, LINES_ALL),
    }),
    sentence: (s) => `${s.verb} ${qw(s.op)} on ${qw(s.cell)} to ${qw(s.cell2)} in ${qw(s.line2)}`,
    form: (s) =>
      baseCommand("move", {
        operator: s.op,
        place: [s.cell],
        toPlace: [s.cell2, s.line2],
        day: null,
        span: null,
        existing: null,
      }),
  },
  {
    id: "M3-hours-only",
    intent: "move",
    genSlots: (rng) => ({
      verb: pick(rng, MOVE_VERBS),
      op: pick(rng, PEOPLE_ALL),
      cell: pick(rng, CELLS_ALL),
      span: randomSpan(rng),
    }),
    sentence: (s) => `${s.verb} ${qw(s.op)} on ${qw(s.cell)} from ${s.span.text}`,
    form: (s) =>
      baseCommand("move", {
        operator: s.op,
        place: [s.cell],
        toPlace: null,
        day: null,
        span: { start: s.span.start, end: s.span.end },
        existing: null,
      }),
  },
  {
    id: "M4-cell-and-hours",
    intent: "move",
    genSlots: (rng) => ({
      verb: pick(rng, MOVE_VERBS),
      op: pick(rng, PEOPLE_ALL),
      cell: pick(rng, CELLS_ALL),
      cell2: pick(rng, CELLS_ALL),
      line2: pick(rng, LINES_ALL),
      span: randomSpan(rng),
    }),
    sentence: (s) =>
      `${s.verb} ${qw(s.op)} on ${qw(s.cell)} to ${qw(s.cell2)} in ${qw(s.line2)} from ${s.span.text}`,
    form: (s) =>
      baseCommand("move", {
        operator: s.op,
        place: [s.cell],
        toPlace: [s.cell2, s.line2],
        day: null,
        span: { start: s.span.start, end: s.span.end },
        existing: null,
      }),
  },
  {
    id: "M5-day-before-destination",
    intent: "move",
    genSlots: (rng) => ({
      verb: pick(rng, MOVE_VERBS),
      op: pick(rng, PEOPLE_ALL),
      cell: pick(rng, CELLS_ALL),
      cell2: pick(rng, CELLS_ALL),
      day: randomDay(rng),
    }),
    sentence: (s) => `${s.verb} ${qw(s.op)} at ${qw(s.cell)} ${s.day.text} to ${qw(s.cell2)}`,
    form: (s) =>
      baseCommand("move", {
        operator: s.op,
        place: [s.cell],
        toPlace: [s.cell2],
        day: s.day.day,
        span: null,
        existing: null,
      }),
  },
  {
    id: "M6-from-separator-comma-destination",
    intent: "move",
    genSlots: (rng) => ({
      verb: pick(rng, MOVE_VERBS),
      op: pick(rng, PEOPLE_ALL),
      cell: pick(rng, CELLS_ALL),
      cell2: pick(rng, CELLS_ALL),
      line2: pick(rng, LINES_ALL),
      span: randomSpan(rng),
    }),
    sentence: (s) =>
      `${s.verb} ${qw(s.op)} from ${qw(s.cell)} to ${qw(s.cell2)}, ${qw(s.line2)} from ${s.span.text}`,
    form: (s) =>
      baseCommand("move", {
        operator: s.op,
        place: [s.cell],
        toPlace: [s.cell2, s.line2],
        day: null,
        span: { start: s.span.start, end: s.span.end },
        existing: null,
      }),
  },
];

export const TEMPLATES = [
  ...assignTemplates,
  ...bookTemplates,
  ...unassignTemplates,
  ...moveTemplates,
];

export function templateById(id) {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`templateById: unknown id "${id}"`);
  return t;
}
