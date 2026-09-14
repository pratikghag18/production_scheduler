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
  PEOPLE_DEMO,
  PARTS_ALL,
  CELLS_ALL,
  LINES_ALL,
  AREAS_ALL,
  WEEKDAY_FULL,
  WEEKDAY_ABBR,
  ISO_DATES,
  SHIFTS_ALL,
  SHIFTS_REALISTIC,
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

/** S52-a (R-402): mirrors parse.ts's own `needsShiftQuoting`/`quoteShiftIfNeeded`
 *  (the shift grammar's own stop-word set, spelled out here since that file
 *  exports no quoting helper -- same reason `needsQuoting`/`qw` above mirror
 *  the place-name quoting rule instead of importing it). A shift name of more
 *  than one word, containing a comma, or equal (case-insensitively) to one of
 *  the shift clause's own keywords ("Shift 1" starts with the word "shift"
 *  itself) must be quoted so the NAMED form ("for shift X") reads it back as
 *  one name rather than mis-splitting on its own syntax. */
const SHIFT_QUOTING_STOP_WORDS = new Set([
  "on",
  "at",
  "in",
  "for",
  "during",
  "to",
  "from",
  "and",
  "shift",
]);

function needsShiftQuoting(name) {
  if (name.includes(",")) return true;
  const words = name.trim().split(/\s+/);
  if (words.length > 1) return true;
  return SHIFT_QUOTING_STOP_WORDS.has(words[0].toLowerCase());
}

function qwShift(name) {
  return needsShiftQuoting(name) ? `"${name}"` : name;
}

/** Names built on purpose to need quoting -- exercises the parser's quoted-
 *  segment path (brief §4, P17; p1-7a's own worked example, "Lin On"). */
const TRICKY_OPERATORS = ["Lin On", "Jo To", "Ann At Bay", "Cy In Field"];
const TRICKY_CELLS = ["Cell in 2", "Bay on 3", "Dock at 5", "Line, North"];

/** S50: `n` DISTINCT items from `pool`, in draw order -- a several's list
 *  slots must never repeat an item ("no A2 and A2"). */
function pickDistinct(rng, pool, n) {
  const remaining = pool.slice();
  const out = [];
  for (let i = 0; i < n; i++) {
    const idx = randInt(rng, 0, remaining.length - 1);
    out.push(remaining[idx]);
    remaining.splice(idx, 1);
  }
  return out;
}

/** S50 (brief §2 item 1, M8): a day word with NO "on " prefix -- for the
 *  MOVE grammar's place-less branch specifically, where (unlike unassign)
 *  the day is read off the OPERATOR segment only AFTER `splitMoveOperatorPlaces`
 *  has already looked for an on/at/from separator in the whole remaining
 *  text; an "on today"-style day would be misread as a (fake) place clause
 *  before the day ever gets a chance to be recognised. Every kind
 *  `randomDay` can produce, just never prefixed. */
function randomBareDay(rng) {
  const kind = pick(rng, ["today", "tomorrow", "weekday", "iso"]);
  if (kind === "today") return { text: "today", day: { kind: "today" } };
  if (kind === "tomorrow") return { text: "tomorrow", day: { kind: "tomorrow" } };
  if (kind === "weekday") {
    const idx = randInt(rng, 0, 6);
    const word = chance(rng, 0.5) ? WEEKDAY_FULL[idx] : WEEKDAY_ABBR[idx];
    return { text: word, day: { kind: "weekday", day: idx } };
  }
  const iso = pick(rng, ISO_DATES);
  return { text: iso, day: { kind: "date", iso } };
}

/** S50: joins already-quoted (`qw`) items as an operator/place LIST would be
 *  said -- two items as "a and b", three as "a, b and c" (an operator list
 *  only; a place list is always exactly two items here, so the comma form
 *  never applies to one, per the parser's own rule that a FIRST PLACE
 *  segment lists on " and " alone). */
function joinAnd(items) {
  if (items.length < 2) throw new Error("joinAnd: needs at least two items");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

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
 *  combination that cannot produce end-after-start.
 *
 * `forcedSep`, when given, is used instead of a random pick from
 * `TIME_SEPARATORS` (S50 fix: M7-no-place-hours's own outer clause word is
 * itself "to" or "from" -- picking the PAIR's separator independently of
 * that produces a sentence that stacks two different prepositions, "move X
 * to 2:15pm until 16:30", which nothing in the grammar rejects (the parsed
 * MEANING is identical either way, so the oracle never flags it) but which
 * no one would actually say). */
function randomSpan(rng, forcedSep) {
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

  const sep = forcedSep ?? pick(rng, TIME_SEPARATORS);
  const pair = buildTimePair(startSpec, endSpec, sep);
  if (!pair) return randomSpan(rng, forcedSep);
  return pair;
}

// R-402 (S52-a): every form gains `shift` -- every template's own form is
// still hours-only (`shift: null`); the shift-grammar's own training rows
// are the data lane's job (docs/agent-briefs/s52-a-shift-grammar-brief.md
// §2 item 5).
function baseCommand(intent, extra) {
  return { intent, shift: null, ...extra };
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
  // -------------------------------------------------------------------------
  // S52-a (R-402, brief §2 item 2): a sentence may name a shift instead of
  // hours. `A9`/`A10` are already taken (A9-noon, A10-24h-dash-two-places),
  // so these pick up the numbering where assign's own list actually left
  // off -- the brief's own A9/A10/A11 ids are renumbered here, said in the
  // lane report.
  // -------------------------------------------------------------------------
  {
    id: "A11-shift",
    intent: "assign",
    genSlots: (rng) => ({
      verb: pick(rng, ASSIGN_VERBS),
      op: pick(rng, PEOPLE_ALL),
      part: pick(rng, PARTS_ALL),
      cell: pick(rng, CELLS_ALL),
      line: pick(rng, LINES_ALL),
      prep: pick(rng, ["for", "during"]),
      name: pick(rng, SHIFTS_ALL),
    }),
    sentence: (s) =>
      `${capitalize(s.verb)} ${qw(s.op)} to work on ${qw(s.part)} on ${qw(s.cell)} in ${qw(s.line)} ${s.prep} shift ${qwShift(s.name)}`,
    form: (s) =>
      baseCommand("assign", {
        operator: s.op,
        product: s.part,
        place: [s.cell, s.line],
        day: null,
        start: null,
        end: null,
        attach: null,
        existing: null,
        shift: s.name,
      }),
  },
  {
    // The maintainer's own word order (design §19.99/D128, session 163):
    // "Assign operator to work for shift X on cell Y, line Z for product A"
    // -- the product comes LAST, as a trailing "for <product>" the grammar
    // reads only once a shift clause has already been read out of the
    // sentence (parse.ts's `parseAssignRest`, brief item 2/4).
    id: "A12-shift-product-last",
    intent: "assign",
    genSlots: (rng) => ({
      verb: pick(rng, ASSIGN_VERBS),
      op: pick(rng, PEOPLE_ALL),
      part: pick(rng, PARTS_ALL),
      cell: pick(rng, CELLS_ALL),
      line: pick(rng, LINES_ALL),
      name: pick(rng, SHIFTS_ALL),
    }),
    sentence: (s) =>
      `${capitalize(s.verb)} ${qw(s.op)} to work for shift ${qwShift(s.name)} on ${qw(s.cell)} in ${qw(s.line)} for ${qw(s.part)}`,
    form: (s) =>
      baseCommand("assign", {
        operator: s.op,
        product: s.part,
        place: [s.cell, s.line],
        day: null,
        start: null,
        end: null,
        attach: null,
        existing: null,
        shift: s.name,
      }),
  },
  {
    // "on the night shift" -- the TRAILING-WORD form (parse.ts's
    // `SHIFT_TRAILING_WORD_RE`): the name PRECEDES the literal word "shift",
    // which is unambiguous, so no quoting is needed even for a two-word
    // realistic name ("late turn shift" reads back as one name).
    id: "A13-the-x-shift",
    intent: "assign",
    genSlots: (rng) => ({
      verb: pick(rng, ASSIGN_VERBS),
      op: pick(rng, PEOPLE_ALL),
      part: pick(rng, PARTS_ALL),
      cell: pick(rng, CELLS_ALL),
      // A name ENDING in a single letter reads oddly in this form -- "on
      // the a shift" ("A"), and just as oddly "on the day a shift" ("Day
      // A") -- SHIFT_NAME parses either fine (the trailing form's own
      // comment above), but no one would say it that way, so this template
      // excludes any name whose LAST word is one letter (never by the
      // whole name's string length, which "Day A"/"Day B" would slip past).
      word: pick(
        rng,
        SHIFTS_REALISTIC.filter((n) => {
          const words = n.split(/\s+/);
          return words[words.length - 1].length > 1;
        }),
      ).toLowerCase(),
    }),
    sentence: (s) =>
      `${capitalize(s.verb)} ${qw(s.op)} to work on ${qw(s.part)} on ${qw(s.cell)} on the ${s.word} shift`,
    form: (s) =>
      baseCommand("assign", {
        operator: s.op,
        product: s.part,
        place: [s.cell],
        day: null,
        start: null,
        end: null,
        attach: null,
        existing: null,
        shift: s.word,
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
  // -------------------------------------------------------------------------
  // S52-a (R-402, brief §2 item 2): a shift name in place of the hours --
  // book has no operator field to worry about product-last ordering.
  // -------------------------------------------------------------------------
  {
    id: "B7-shift",
    intent: "book",
    genSlots: (rng) => ({
      verb: pick(rng, BOOK_VERBS),
      part: pick(rng, PARTS_ALL),
      cell: pick(rng, CELLS_ALL),
      line: pick(rng, LINES_ALL),
      prep: pick(rng, ["for", "during"]),
      name: pick(rng, SHIFTS_ALL),
    }),
    sentence: (s) =>
      `${capitalize(s.verb)} ${qw(s.part)} on ${qw(s.cell)} in ${qw(s.line)} ${s.prep} shift ${qwShift(s.name)}`,
    form: (s) =>
      baseCommand("book", {
        product: s.part,
        place: [s.cell, s.line],
        headcount: null,
        day: null,
        start: null,
        end: null,
        existing: null,
        shift: s.name,
      }),
  },
];

// ---------------------------------------------------------------------------
// Unassign (U1-U7)
// ---------------------------------------------------------------------------

// S55 (R-407, found while fixing R-409): "clear" excluded -- see the comment
// above U8-U10 below, the only templates that put the operator right after
// the verb with no place separator at all (the one shape R-407's EVERYONE
// reading now claims).
const NO_PLACE_UNASSIGN_VERBS = UNASSIGN_VERBS.filter((v) => v !== "clear");

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
        until: null, // S55/R-409: an ordinary removal, no absence end-day
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
        until: null, // S55/R-409: an ordinary removal, no absence end-day
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
        until: null, // S55/R-409: an ordinary removal, no absence end-day
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
        until: null, // S55/R-409: an ordinary removal, no absence end-day
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
        until: null, // S55/R-409: an ordinary removal, no absence end-day
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
        until: null, // S55/R-409: an ordinary removal, no absence end-day
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
        until: null, // S55/R-409: an ordinary removal, no absence end-day
      }),
  },
  // -------------------------------------------------------------------------
  // S50 (R-398, brief §2 item 1): a removal need not name a place at all --
  // `place: []`, "wherever the person is" (S49).
  //
  // S55 (R-407, found while fixing R-409): NEVER "clear" here -- these three
  // templates put the operator right after the verb with no place separator
  // at all ("clear Marcus Novak sunday"), and that is now exactly the shape
  // `parseUnassignRest`'s R-407 rule reads as EVERYONE clearing a PLACE
  // named "Marcus Novak" (operator/place swapped), not a person's removal.
  // Every other UNASSIGN_VERBS word is unaffected (R-407 special-cases
  // "clear" alone); U1-U7's own sentences always have a place separator
  // ("from"/"on"/"off" before a place word) so they were never ambiguous.
  // -------------------------------------------------------------------------
  {
    id: "U8-no-place-day",
    intent: "unassign",
    genSlots: (rng) => ({
      verb: pick(rng, NO_PLACE_UNASSIGN_VERBS),
      op: pick(rng, PEOPLE_ALL),
      // Reviewer fix: `randomBareDay` (as M8 uses), never `randomDay` -- the
      // "on " prefix `randomDay` sometimes adds is harmless for the UNASSIGN
      // grammar's own day extraction (it strips the whole "on <day>" tail
      // before place-splitting ever runs, see `extractDayWord`/`DAY_TAIL_RE`)
      // but "unassign Layla Rossi on today" still reads oddly next to every
      // other bare-day sentence this template produces ("remove X today").
      day: randomBareDay(rng),
    }),
    sentence: (s) => `${s.verb} ${qw(s.op)} ${s.day.text}`,
    form: (s) =>
      baseCommand("unassign", {
        operator: s.op,
        place: [],
        day: s.day.day,
        span: null,
        existing: null,
        until: null, // S55/R-409: an ordinary removal, no absence end-day
      }),
  },
  {
    id: "U9-no-place-hours",
    intent: "unassign",
    genSlots: (rng) => ({
      verb: pick(rng, NO_PLACE_UNASSIGN_VERBS),
      op: pick(rng, PEOPLE_ALL),
      span: randomSpan(rng),
    }),
    sentence: (s) => `${s.verb} ${qw(s.op)} from ${s.span.text}`,
    form: (s) =>
      baseCommand("unassign", {
        operator: s.op,
        place: [],
        day: null,
        span: { start: s.span.start, end: s.span.end },
        existing: null,
        until: null, // S55/R-409: an ordinary removal, no absence end-day
      }),
  },
  {
    id: "U10-no-place-bare",
    intent: "unassign",
    genSlots: (rng) => ({
      verb: pick(rng, NO_PLACE_UNASSIGN_VERBS),
      op: pick(rng, PEOPLE_ALL),
    }),
    sentence: (s) => `${s.verb} ${qw(s.op)}`,
    form: (s) =>
      baseCommand("unassign", {
        operator: s.op,
        place: [],
        day: null,
        span: null,
        existing: null,
        until: null, // S55/R-409: an ordinary removal, no absence end-day
      }),
  },
  // -------------------------------------------------------------------------
  // S52-a (R-402, brief §2 item 2): a shift name in place of the hours -- a
  // removal still means "the whole day", `span` stays null (the shift's
  // name is not the resolver's concern yet).
  // -------------------------------------------------------------------------
  {
    id: "U11-shift",
    intent: "unassign",
    genSlots: (rng) => ({
      verb: pick(rng, UNASSIGN_VERBS),
      op: pick(rng, PEOPLE_ALL),
      cell: pick(rng, CELLS_ALL),
      prep: pick(rng, ["for", "during"]),
      name: pick(rng, SHIFTS_ALL),
    }),
    sentence: (s) => `${s.verb} ${qw(s.op)} from ${qw(s.cell)} ${s.prep} shift ${qwShift(s.name)}`,
    form: (s) =>
      baseCommand("unassign", {
        operator: s.op,
        place: [s.cell],
        day: null,
        span: null,
        existing: null,
        shift: s.name,
        until: null, // S55/R-409: an ordinary removal, no absence end-day
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
  // -------------------------------------------------------------------------
  // S50 (R-398, brief §2 item 2): a move need not name a place at all --
  // `place: []`, "wherever the person is" (S49).
  // -------------------------------------------------------------------------
  {
    id: "M7-no-place-hours",
    intent: "move",
    genSlots: (rng) => {
      // brief §2 item 1 (M7): the hours clause reads as either "to <time> to
      // <time>" (parseMoveRest's own extractToTimeClause, tried once
      // `extractOptionalTimeClause` finds no "from" at all) or "from <time>
      // to <time>" (extractOptionalTimeClause itself) -- both parse to the
      // same place-less move, so both are exercised here.
      const clause = pick(rng, ["to", "from"]);
      // Reviewer fix: when the OUTER clause word is "to", the pair's own
      // separator is forced to "to" as well -- a "from" clause may keep any
      // separator (TIME_SEPARATORS), since "from 2pm until 4pm" reads fine,
      // but "to 2:15pm until 16:30" stacks two different prepositions no one
      // would say (`randomSpan`'s own doc comment).
      const span = randomSpan(rng, clause === "to" ? "to" : undefined);
      return { verb: pick(rng, MOVE_VERBS), op: pick(rng, PEOPLE_ALL), clause, span };
    },
    sentence: (s) => `${s.verb} ${qw(s.op)} ${s.clause} ${s.span.text}`,
    form: (s) =>
      baseCommand("move", {
        operator: s.op,
        place: [],
        toPlace: null,
        day: null,
        span: { start: s.span.start, end: s.span.end },
        existing: null,
      }),
  },
  {
    id: "M8-no-place-day-hours",
    intent: "move",
    genSlots: (rng) => ({
      verb: pick(rng, MOVE_VERBS),
      op: pick(rng, PEOPLE_ALL),
      // `randomBareDay`, never `randomDay`: an "on <day>" prefix would be
      // misread as a (fake) place clause by `splitMoveOperatorPlaces`, which
      // runs BEFORE day extraction on this branch (see that function's own
      // comment) -- unlike unassign, where the day is stripped off the
      // whole remaining text first.
      day: randomBareDay(rng),
      span: randomSpan(rng),
    }),
    sentence: (s) => `${s.verb} ${qw(s.op)} ${s.day.text} from ${s.span.text}`,
    form: (s) =>
      baseCommand("move", {
        operator: s.op,
        place: [],
        toPlace: null,
        day: s.day.day,
        span: { start: s.span.start, end: s.span.end },
        existing: null,
      }),
  },
  {
    id: "M9-no-place-cell",
    intent: "move",
    genSlots: (rng) => ({
      verb: pick(rng, MOVE_VERBS),
      op: pick(rng, PEOPLE_ALL),
      cell2: pick(rng, CELLS_ALL),
    }),
    sentence: (s) => `${s.verb} ${qw(s.op)} to ${qw(s.cell2)}`,
    form: (s) =>
      baseCommand("move", {
        operator: s.op,
        place: [],
        toPlace: [s.cell2],
        day: null,
        span: null,
        existing: null,
      }),
  },
  // -------------------------------------------------------------------------
  // S52-a (R-401, brief §2 item 1): "change" and "shift" join `MOVE_VERBS`
  // (nothing new to add there -- V9 already proves every verb opens a clean
  // row), and a possessive timing tail on the operator segment ("A3's
  // timing", "A3s timing") reads as the person, a move in time only. Half
  // the draws write the possessive WITHOUT the apostrophe, the way the
  // browser's speech recogniser does (F-144) -- `parse.ts`'s
  // `POSSESSIVE_TIMING_TAIL_RE` only accepts the bare-`s` spelling right
  // after a DIGIT, so that half draws its operator from `PEOPLE_DEMO`
  // ("Operator A3", every name ending in a digit) rather than `PEOPLE_ALL`.
  // -------------------------------------------------------------------------
  {
    id: "M10-change-timing",
    intent: "move",
    genSlots: (rng) => {
      const noApostrophe = chance(rng, 0.5);
      const op = noApostrophe ? pick(rng, PEOPLE_DEMO) : pick(rng, PEOPLE_ALL);
      return {
        verb: pick(rng, ["change", "shift"]),
        op,
        noApostrophe,
        tail: pick(rng, ["timing", "hours", "time"]),
        // Same reviewer fix `randomSpan` documents for M7: the outer clause
        // word is itself "to" ("... timing to 8 pm to 11 pm"), so the
        // pair's own separator is forced to "to" too -- otherwise a random
        // "until"/"till" pick stacks two different prepositions no one
        // would actually say.
        span: randomSpan(rng, "to"),
      };
    },
    sentence: (s) => {
      const possessive = s.noApostrophe ? `${qw(s.op)}s` : `${qw(s.op)}'s`;
      return `${s.verb} ${possessive} ${s.tail} to ${s.span.text}`;
    },
    form: (s) =>
      baseCommand("move", {
        operator: s.op,
        place: [],
        toPlace: null,
        day: null,
        span: { start: s.span.start, end: s.span.end },
        existing: null,
      }),
  },
  // -------------------------------------------------------------------------
  // S52-a (R-402, brief §2 item 2): a shift name stands in for new hours --
  // a move in time only, `toPlace` and `span` both null, no current place
  // named either (matches M7-M9's own place-less shape).
  // -------------------------------------------------------------------------
  {
    id: "M11-shift",
    intent: "move",
    genSlots: (rng) => ({
      // S52-c (reviewer fix): never the verb "shift" itself here -- "shift
      // Sven Horvath for shift Day" reads as the clause's own noun doubled
      // up with the verb. Every OTHER move verb still exercises this shape.
      verb: pick(
        rng,
        MOVE_VERBS.filter((v) => v !== "shift"),
      ),
      op: pick(rng, PEOPLE_ALL),
      prep: pick(rng, ["for", "during"]),
      name: pick(rng, SHIFTS_ALL),
    }),
    sentence: (s) => `${s.verb} ${qw(s.op)} ${s.prep} shift ${qwShift(s.name)}`,
    form: (s) =>
      baseCommand("move", {
        operator: s.op,
        place: [],
        toPlace: null,
        day: null,
        span: null,
        existing: null,
        shift: s.name,
      }),
  },
];

// ---------------------------------------------------------------------------
// Several (S1-S7) -- S50 (R-398, brief §2 item 3): the OPERATOR segment
// (assign, unassign, move) or the FIRST PLACE segment (assign, book) names
// more than one thing, joined by " and " (an operator list also accepts a
// ", "-joined run before the final " and "). Every `form` here is
// `{intent:"several", commands:[...]}`, one complete `SingleCommand` per
// item, in the sentence's order -- exactly what `combineLists` in parse.ts
// builds (brief's own worked example, L10). `pickDistinct` guarantees no
// list ever repeats a name or a cell.
// ---------------------------------------------------------------------------

const severalTemplates = [
  {
    id: "S1-two-people-one-cell",
    intent: "several",
    genSlots: (rng) => {
      const [op1, op2] = pickDistinct(rng, PEOPLE_ALL, 2);
      return {
        verb: pick(rng, ASSIGN_VERBS),
        op1,
        op2,
        part: pick(rng, PARTS_ALL),
        cell: pick(rng, CELLS_ALL),
        span: randomSpan(rng),
      };
    },
    sentence: (s) =>
      `${capitalize(s.verb)} ${joinAnd([qw(s.op1), qw(s.op2)])} to ${qw(s.part)} on ${qw(s.cell)} from ${s.span.text}`,
    form: (s) => ({
      intent: "several",
      commands: [s.op1, s.op2].map((op) =>
        baseCommand("assign", {
          operator: op,
          product: s.part,
          place: [s.cell],
          day: null,
          start: s.span.start,
          end: s.span.end,
          attach: null,
          existing: null,
        }),
      ),
    }),
  },
  {
    id: "S2-one-person-two-cells",
    intent: "several",
    genSlots: (rng) => {
      const [cell1, cell2] = pickDistinct(rng, CELLS_ALL, 2);
      return {
        verb: pick(rng, ASSIGN_VERBS),
        op: pick(rng, PEOPLE_ALL),
        part: pick(rng, PARTS_ALL),
        cell1,
        cell2,
        span: randomSpan(rng),
      };
    },
    sentence: (s) =>
      `${capitalize(s.verb)} ${qw(s.op)} to ${qw(s.part)} on ${joinAnd([qw(s.cell1), qw(s.cell2)])} from ${s.span.text}`,
    form: (s) => ({
      intent: "several",
      commands: [s.cell1, s.cell2].map((cell) =>
        baseCommand("assign", {
          operator: s.op,
          product: s.part,
          place: [cell],
          day: null,
          start: s.span.start,
          end: s.span.end,
          attach: null,
          existing: null,
        }),
      ),
    }),
  },
  {
    id: "S3-pairs",
    intent: "several",
    // The maintainer's own sentence shape (docs/design-plan.md §19.97):
    // "assign A2 and A3 to Housing A on Cell 1 and Cell 2 in Line 1 today
    // from 3 to 5" -- two people, two cells, a line qualifier (applies to
    // every pair), a day, hours.
    genSlots: (rng) => {
      const [op1, op2] = pickDistinct(rng, PEOPLE_ALL, 2);
      const [cell1, cell2] = pickDistinct(rng, CELLS_ALL, 2);
      return {
        verb: pick(rng, ASSIGN_VERBS),
        op1,
        op2,
        part: pick(rng, PARTS_ALL),
        cell1,
        cell2,
        line: pick(rng, LINES_ALL),
        day: randomDay(rng),
        span: randomSpan(rng),
      };
    },
    sentence: (s) =>
      `${capitalize(s.verb)} ${joinAnd([qw(s.op1), qw(s.op2)])} to ${qw(s.part)} on ${joinAnd([qw(s.cell1), qw(s.cell2)])} in ${qw(s.line)} ${s.day.text} from ${s.span.text}`,
    form: (s) => ({
      intent: "several",
      commands: [
        [s.op1, s.cell1],
        [s.op2, s.cell2],
      ].map(([op, cell]) =>
        baseCommand("assign", {
          operator: op,
          product: s.part,
          place: [cell, s.line],
          day: s.day.day,
          start: s.span.start,
          end: s.span.end,
          attach: null,
          existing: null,
        }),
      ),
    }),
  },
  {
    id: "S4-three-people-one-cell",
    intent: "several",
    genSlots: (rng) => {
      const [op1, op2, op3] = pickDistinct(rng, PEOPLE_ALL, 3);
      return {
        verb: pick(rng, ASSIGN_VERBS),
        op1,
        op2,
        op3,
        part: pick(rng, PARTS_ALL),
        cell: pick(rng, CELLS_ALL),
        span: randomSpan(rng),
      };
    },
    sentence: (s) =>
      `${capitalize(s.verb)} ${joinAnd([qw(s.op1), qw(s.op2), qw(s.op3)])} to ${qw(s.part)} on ${qw(s.cell)} from ${s.span.text}`,
    form: (s) => ({
      intent: "several",
      commands: [s.op1, s.op2, s.op3].map((op) =>
        baseCommand("assign", {
          operator: op,
          product: s.part,
          place: [s.cell],
          day: null,
          start: s.span.start,
          end: s.span.end,
          attach: null,
          existing: null,
        }),
      ),
    }),
  },
  {
    id: "S5-remove-two",
    intent: "several",
    genSlots: (rng) => {
      const [op1, op2] = pickDistinct(rng, PEOPLE_ALL, 2);
      return {
        verb: pick(rng, UNASSIGN_VERBS),
        op1,
        op2,
        cell: pick(rng, CELLS_ALL),
      };
    },
    sentence: (s) => `${s.verb} ${joinAnd([qw(s.op1), qw(s.op2)])} from ${qw(s.cell)}`,
    form: (s) => ({
      intent: "several",
      commands: [s.op1, s.op2].map((op) =>
        baseCommand("unassign", {
          operator: op,
          place: [s.cell],
          day: null,
          span: null,
          existing: null,
          until: null, // S55/R-409: an ordinary removal, no absence end-day
        }),
      ),
    }),
  },
  {
    id: "S6-book-two-cells",
    intent: "several",
    genSlots: (rng) => {
      const [cell1, cell2] = pickDistinct(rng, CELLS_ALL, 2);
      return {
        verb: pick(rng, BOOK_VERBS),
        part: pick(rng, PARTS_ALL),
        cell1,
        cell2,
        span: randomSpan(rng),
      };
    },
    sentence: (s) =>
      `${capitalize(s.verb)} ${qw(s.part)} on ${joinAnd([qw(s.cell1), qw(s.cell2)])} from ${s.span.text}`,
    form: (s) => ({
      intent: "several",
      commands: [s.cell1, s.cell2].map((cell) =>
        baseCommand("book", {
          product: s.part,
          place: [cell],
          headcount: null,
          day: null,
          start: s.span.start,
          end: s.span.end,
          existing: null,
        }),
      ),
    }),
  },
  // -------------------------------------------------------------------------
  // S52-a (R-402, brief §2 item 2): two people, one cell, a shift name in
  // place of the hours -- the same product-first path `parseAssignRest`'s
  // list branch takes when there is no leftover "for" text after the shift
  // clause is already stripped.
  // -------------------------------------------------------------------------
  {
    id: "S7-several-shift",
    intent: "several",
    genSlots: (rng) => {
      const [op1, op2] = pickDistinct(rng, PEOPLE_ALL, 2);
      return {
        verb: pick(rng, ASSIGN_VERBS),
        op1,
        op2,
        part: pick(rng, PARTS_ALL),
        cell: pick(rng, CELLS_ALL),
        prep: pick(rng, ["for", "during"]),
        name: pick(rng, SHIFTS_ALL),
      };
    },
    sentence: (s) =>
      `${capitalize(s.verb)} ${joinAnd([qw(s.op1), qw(s.op2)])} to ${qw(s.part)} on ${qw(s.cell)} ${s.prep} shift ${qwShift(s.name)}`,
    form: (s) => ({
      intent: "several",
      commands: [s.op1, s.op2].map((op) =>
        baseCommand("assign", {
          operator: op,
          product: s.part,
          place: [s.cell],
          day: null,
          start: null,
          end: null,
          attach: null,
          existing: null,
          shift: s.name,
        }),
      ),
    }),
  },
];

export const TEMPLATES = [
  ...assignTemplates,
  ...bookTemplates,
  ...unassignTemplates,
  ...moveTemplates,
  ...severalTemplates,
];

export function templateById(id) {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`templateById: unknown id "${id}"`);
  return t;
}
