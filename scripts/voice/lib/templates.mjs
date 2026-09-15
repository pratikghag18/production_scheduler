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
import { buildTimePair, TIME_SEPARATORS, resolveLoneTime, resolveLoneStart } from "./time.mjs";
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
  ABSENCE_WORDS,
  TIME_OF_DAY_WORDS,
  EVERYONE,
  ALL_DAY,
  END_OF_SHIFT,
  END_OF_DAY,
  DAY_END,
  // S58 (docs/agent-briefs/s58-a-grammar-brief.md, R-412/413/414/415/416,
  // design §19.103/D132): the group-2 shapes' own exports -- the S56-b
  // brief's same rule as S56-a's own comment above, never retyped here.
  ADJUST_VERBS,
  HEADCOUNT_VERBS,
  REPEAT_WORDS,
  JOB_HOURS,
} from "../../../src/lib/command/parse.ts";

// R-407 (S55): the raw words that canonicalize to `EVERYONE` on a removal or
// a move -- parse.ts's own `EVERYONE_ALIASES` is private (only the canonical
// spelling `EVERYONE` is exported), so this is the same three words, spelled
// out here the way `SHIFT_QUOTING_STOP_WORDS` above already mirrors a
// private regex's own word set rather than importing it.
const EVERYONE_ALIASES = ["everyone", "everybody", "all"];

// Reviewer fix (S56 review): "this night" is not a sentence a scheduler
// says -- the irregular case parse.ts's own comment already calls out
// ("tonight" (irregular for "this night")) -- so "this <word>"/"pull ...
// this <word>" templates draw from this NIGHT-EXCLUDED pool; "night" still
// gets its own natural coverage through the "tonight" branch (A20) and
// through "tomorrow night"/"for the night" (both templates already draw
// the unfiltered TIME_OF_DAY_WORDS for those branches, where "night" reads
// fine). Found running the sampled-row check the S56-a data-brief attack
// step asks for (`for word of ["this X"]`), the same way U8-U10's "clear"
// exclusion (S55) was found while doing an unrelated migration.
const TIME_OF_DAY_WORDS_THIS = TIME_OF_DAY_WORDS.filter((w) => w !== "night");

/** S58 (R-412, brief §2 M13/M14): `ADJUST_VERBS`'s own two shapes, split
 *  by which clause each half reads -- extend/lengthen/shorten always a
 *  distance ("by <duration>"), end/finish a time or a distance (M14's own
 *  three kinds). Derived from the export (R-391: never retype a word the
 *  grammar owns), not two new hard-coded lists. */
const ADJUST_DISTANCE_VERBS = ADJUST_VERBS.filter((v) => v !== "end" && v !== "finish");
const ADJUST_AT_VERBS = ADJUST_VERBS.filter((v) => v === "end" || v === "finish");

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

/** S58 (R-412, brief §2 M13/M14): a duration shape restricted to the three
 *  spellings those two ids' own bullets name -- "N minutes" / "an hour" /
 *  "N hours" -- a NARROWER set than A14-duration's own six DU-numbered
 *  shapes (this is an adjust's DISTANCE, never an assign's whole span; the
 *  wider set stays A14's own job). Always a positive value -- the sign
 *  (extend/shorten, earlier/later) is decided by the caller. */
function randomAdjustDuration(rng) {
  const kind = pick(rng, ["minutes", "anHour", "hours"]);
  if (kind === "anHour") return { text: "an hour", minutes: 60 };
  if (kind === "hours") {
    const n = randInt(rng, 1, 6);
    return { text: `${n} hours`, minutes: n * 60 };
  }
  const n = pick(rng, [15, 30, 45, 90]);
  return { text: `${n} minutes`, minutes: n };
}

/** S58 (R-412/R-413, brief §2 M14/M15/X1): one time SPEC for a lone edge
 *  (never a `from`/`to` pair -- `randomSpan`/`randomBareSpan` own that), fed
 *  to `resolveLoneTime` (`time.mjs`) by every caller. `allowMidnight` draws
 *  an occasional "midnight" (F-146) -- callers pass it only for an END
 *  edge, never a START (the S58 brief's own "a START of midnight stays
 *  {0,0}" rule -- there is nothing DAY_END-shaped about a START, so a
 *  caller that never asks for it never has to filter one back out). */
function randomLoneTimeSpec(rng, allowMidnight) {
  if (allowMidnight && chance(rng, 0.12)) return { kind: "midnight" };
  if (chance(rng, 0.15)) return { kind: "noon" };
  return chance(rng, 0.5)
    ? {
        kind: "ampm",
        hour: randInt(rng, 1, 22),
        minute: pick(rng, [0, 15, 30, 45]),
        spaced: chance(rng, 0.5),
      }
    : { kind: "24h", hour: randInt(rng, 1, 22), minute: pick(rng, [0, 15, 30, 45]) };
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
  // F-146 (S56-b brief §4, the first pass's own flag): draw an END of
  // "midnight" sometimes, on top of the ordinary 24h/ampm/ambiguous styles
  // below -- `buildTimePair` now knows to write DAY_END for it (this file's
  // own change, above), so every template that calls `randomSpan` (book's
  // own included) gets a little of that coverage for free, not just
  // A23-to-midnight's own dedicated rows.
  if (chance(rng, 0.08)) {
    endSpec = { kind: "midnight" };
  } else {
    const endStyle = pick(rng, ["24h", "ampm", "ambiguous"]);
    if (endStyle === "ambiguous" && endHour > 12 && endHour <= 23) {
      endSpec = { kind: "24h", hour: endHour - 12, minute: endMinute }; // relies on the afternoon rule
    } else if (endStyle === "ampm") {
      endSpec = { kind: "ampm", hour: endHour, minute: endMinute, spaced: chance(rng, 0.5) };
    } else {
      endSpec = { kind: "24h", hour: endHour, minute: endMinute };
    }
  }

  const sep = forcedSep ?? pick(rng, TIME_SEPARATORS);
  const pair = buildTimePair(startSpec, endSpec, sep);
  if (!pair) return randomSpan(rng, forcedSep);
  return pair;
}

/** S56: like `randomSpan`, but never emits a "noon"/"midnight" START -- the
 *  bare-pair grammar (no leading "from" at all, `BARE_PAIR_TRAILING_RE`
 *  inside `parseTimeAndDayOrBare`) only accepts numeric/am-pm time tokens,
 *  never the synthetic noon/midnight words `parseTimeToken` otherwise reads.
 *  Used by the word-order templates (A18/A19, B8) whose sentences carry no
 *  "from" at all -- found by `voice:generate --heldout` throwing an ORACLE
 *  MISMATCH on a "noon" bare-pair start (`no_time`, since the bare-pair
 *  regex never matched it in the first place). */
function randomBareSpan(rng, forcedSep) {
  const startHour = randInt(rng, 6, 18);
  let duration = pick(rng, [2, 3, 4, 6, 8]);
  if (startHour + duration > 22) duration = Math.max(1, 22 - startHour);
  const endHour = startHour + duration;
  const startMinute = pick(rng, [0, 0, 0, 15, 30, 45]);
  const endMinute = pick(rng, [0, 0, 0, 15, 30, 45]);

  const startSpec = chance(rng, 0.5)
    ? { kind: "ampm", hour: startHour, minute: startMinute, spaced: chance(rng, 0.5) }
    : { kind: "24h", hour: startHour, minute: startMinute };

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
  if (!pair) return randomBareSpan(rng, forcedSep);
  return pair;
}

// R-402 (S52-a): every form gains `shift` -- every template's own form is
// still hours-only (`shift: null`); the shift-grammar's own training rows
// are the data lane's job (docs/agent-briefs/s52-a-shift-grammar-brief.md
// §2 item 5).
// S58 (R-412, design §19.103/D132 item 1): every `MoveCommand` now carries
// `adjust: Adjust | null` -- defaulted here to `null` so every move
// template (M1-M12 unchanged, the new M13-M15 override it) gets the field
// without retyping it at each call site; every other intent is untouched.
function baseCommand(intent, extra) {
  const defaults =
    intent === "move" ? { intent, shift: null, adjust: null } : { intent, shift: null };
  return { ...defaults, ...extra };
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
  // -------------------------------------------------------------------------
  // S56 (D130/S55-a brief §3, DU/BD/TD series): durations, the two "end of"
  // boundaries, and the time-of-day shift words -- every shape the S55-a
  // brief's assign sentences cover that A1-A13 did not yet template.
  // -------------------------------------------------------------------------
  {
    // DU1-DU6: "from T for N hours / an hour / N and a half hours / N
    // minutes / half an hour / N.N hours" -- the end computed here,
    // mirroring `parseDurationMinutes` (never `parseCommand`'s own
    // arithmetic, brief §2: "never from `parseCommand`" -- the oracle check
    // in `rows.mjs` is only real if this side never looks at the parser's
    // code path).
    //
    // Reviewer fix (S56 review): two of DU1-DU6's own literal phrases had no
    // `kind` here at all -- "half an hour" (DU6, `parseDurationMinutes`'s
    // `t === "half an hour"` branch) and the DECIMAL spelling "1.5 hours"
    // (DU4, its `\d+(?:\.\d+)?` branch, the same VALUE as DU3's "N and a
    // half hours" word form but a different surface a typed command bar
    // sees often). The S56-a brief's own A14 bullet lists "N hours / an
    // hour / N and a half hours / N minutes" and never either of these --
    // only the S55-a grammar brief's own DU-numbered list does -- so the
    // data generator silently never produced either even though the
    // grammar has parsed both since S55. Found doing the S56-a-brief attack
    // step this review's own brief asks for (every DU-numbered sentence
    // checked against what a template actually emits).
    id: "A14-duration",
    intent: "assign",
    genSlots: (rng) => {
      const startHour = randInt(rng, 6, 16); // headroom under every kind's max minutes below
      const kind = pick(rng, ["hours", "anHour", "halfHour", "andHalf", "decimal", "minutes"]);
      let durationText;
      let minutes;
      if (kind === "anHour") {
        durationText = "an hour";
        minutes = 60;
      } else if (kind === "halfHour") {
        durationText = "half an hour";
        minutes = 30;
      } else if (kind === "andHalf") {
        const n = randInt(rng, 1, 4);
        const unit = pick(rng, ["hours", "hrs"]);
        durationText = `${n} and a half ${unit}`;
        minutes = n * 60 + 30;
      } else if (kind === "decimal") {
        const n = pick(rng, [1.5, 2.5, 3.5]);
        const unit = pick(rng, ["hours", "hrs"]);
        durationText = `${n} ${unit}`;
        minutes = Math.round(n * 60);
      } else if (kind === "minutes") {
        const n = pick(rng, [15, 30, 45, 90]);
        const unit = pick(rng, ["minutes", "mins"]);
        durationText = `${n} ${unit}`;
        minutes = n;
      } else {
        const n = randInt(rng, 1, 6);
        const unit = pick(rng, ["hours", "hrs"]);
        durationText = `${n} ${unit}`;
        minutes = n * 60;
      }
      // F-151: this start stands alone (a duration names only a LENGTH), so
      // it is computed by `resolveLoneStart`, the same START rule parse.ts's
      // `applyLoneStartRule` now gives it -- never the raw literal hour.
      const start = resolveLoneStart({ kind: "24h", hour: startHour, minute: 0 });
      const endTotal = start.hour * 60 + start.minute + minutes;
      return {
        verb: pick(rng, ASSIGN_VERBS),
        op: pick(rng, PEOPLE_ALL),
        part: pick(rng, PARTS_ALL),
        cell: pick(rng, CELLS_ALL),
        startHour,
        durationText,
        start: { hour: start.hour, minute: start.minute },
        end: { hour: Math.floor(endTotal / 60), minute: endTotal % 60 },
      };
    },
    sentence: (s) =>
      `${s.verb} ${qw(s.op)} on ${qw(s.part)} on ${qw(s.cell)} from ${s.startHour} for ${s.durationText}`,
    form: (s) =>
      baseCommand("assign", {
        operator: s.op,
        product: s.part,
        place: [s.cell],
        day: null,
        start: s.start,
        end: s.end,
        attach: null,
        existing: null,
      }),
  },
  {
    // BD1: "all day" -- shift ALL_DAY, start/end null.
    id: "A15-all-day",
    intent: "assign",
    genSlots: (rng) => ({
      verb: pick(rng, ASSIGN_VERBS),
      op: pick(rng, PEOPLE_ALL),
      part: pick(rng, PARTS_ALL),
      cell: pick(rng, CELLS_ALL),
      dayWord: pick(rng, ["today", "tomorrow"]),
    }),
    sentence: (s) => `${s.verb} ${qw(s.op)} to ${qw(s.part)} on ${qw(s.cell)} all day ${s.dayWord}`,
    form: (s) =>
      baseCommand("assign", {
        operator: s.op,
        product: s.part,
        place: [s.cell],
        day: s.dayWord === "today" ? { kind: "today" } : { kind: "tomorrow" },
        start: null,
        end: null,
        attach: null,
        existing: null,
        shift: ALL_DAY,
      }),
  },
  {
    // BD2: "from T until end of shift" -- start set, end null, the ONE
    // boundary shift that may carry a start (D130 item 3's amendment).
    id: "A16-from-until-end-of-shift",
    intent: "assign",
    genSlots: (rng) => {
      const startHour = randInt(rng, 6, 20);
      // F-151: the boundary clause's own captured start is a LONE START --
      // `resolveLoneStart` (time.mjs), the same rule parse.ts's own
      // `applyLoneStartRule` gives it, never the raw literal hour.
      const start = resolveLoneStart({ kind: "24h", hour: startHour, minute: 0 });
      return {
        verb: pick(rng, ASSIGN_VERBS),
        op: pick(rng, PEOPLE_ALL),
        part: pick(rng, PARTS_ALL),
        cell: pick(rng, CELLS_ALL),
        startHour,
        start,
        phrase: pick(rng, [
          "until end of shift",
          "till end of shift",
          "to the end of the shift",
          "until the end of shift",
          "for the rest of the shift",
        ]),
      };
    },
    sentence: (s) =>
      `${s.verb} ${qw(s.op)} to ${qw(s.part)} on ${qw(s.cell)} from ${s.startHour} ${s.phrase}`,
    form: (s) =>
      baseCommand("assign", {
        operator: s.op,
        product: s.part,
        place: [s.cell],
        day: null,
        start: { hour: s.start.hour, minute: s.start.minute },
        end: null,
        attach: null,
        existing: null,
        shift: END_OF_SHIFT,
      }),
  },
  {
    // BD3/BD4: "for the rest of the day" (with and without a leading
    // "from T") -- shift END_OF_DAY.
    id: "A17-rest-of-day",
    intent: "assign",
    genSlots: (rng) => {
      const withStart = chance(rng, 0.5);
      const startHour = withStart ? randInt(rng, 6, 20) : null;
      // F-151: same LONE START reading as A16 above, only when there is one.
      const start = withStart
        ? resolveLoneStart({ kind: "24h", hour: startHour, minute: 0 })
        : null;
      return {
        verb: pick(rng, ASSIGN_VERBS),
        op: pick(rng, PEOPLE_ALL),
        part: pick(rng, PARTS_ALL),
        cell: pick(rng, CELLS_ALL),
        withStart,
        startHour,
        start,
        phrase: pick(rng, [
          "for the rest of the day",
          "until end of day",
          "till the end of the day",
        ]),
      };
    },
    sentence: (s) =>
      s.withStart
        ? `${s.verb} ${qw(s.op)} to ${qw(s.part)} on ${qw(s.cell)} from ${s.startHour} ${s.phrase}`
        : `${s.verb} ${qw(s.op)} to ${qw(s.part)} on ${qw(s.cell)} ${s.phrase}`,
    form: (s) =>
      baseCommand("assign", {
        operator: s.op,
        product: s.part,
        place: [s.cell],
        day: null,
        start: s.withStart ? { hour: s.start.hour, minute: s.start.minute } : null,
        end: null,
        attach: null,
        existing: null,
        shift: END_OF_DAY,
      }),
  },
  {
    // WO1: "<op> works on <part> on <cell> <bare pair>" -- the word-order
    // grammar's operator-first marker, rewritten internally to an ordinary
    // assign.
    id: "A18-works-on",
    intent: "assign",
    genSlots: (rng) => ({
      op: pick(rng, PEOPLE_ALL),
      part: pick(rng, PARTS_ALL),
      cell: pick(rng, CELLS_ALL),
      span: randomBareSpan(rng),
    }),
    sentence: (s) => `${qw(s.op)} works on ${qw(s.part)} on ${qw(s.cell)} ${s.span.text}`,
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
    // WO3: "<cell> gets <op> on <part> <bare pair>" -- the word-order
    // grammar's place-first marker.
    id: "A19-cell-gets",
    intent: "assign",
    genSlots: (rng) => ({
      op: pick(rng, PEOPLE_ALL),
      part: pick(rng, PARTS_ALL),
      cell: pick(rng, CELLS_ALL),
      span: randomBareSpan(rng),
    }),
    sentence: (s) => `${qw(s.cell)} gets ${qw(s.op)} on ${qw(s.part)} ${s.span.text}`,
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
    // TD1-TD4: a time-of-day word read as a shift NAME -- "this <word>"/
    // "tonight" (day today), "tomorrow <word>" (day tomorrow), "for the
    // <word>" (day left as whatever else was said -- null here, nothing
    // else says one).
    id: "A20-time-of-day",
    intent: "assign",
    genSlots: (rng) => {
      const kind = pick(rng, ["this", "tonight", "tomorrow", "forThe"]);
      // "this night" is never said (see `TIME_OF_DAY_WORDS_THIS`'s own
      // comment) -- only the "this" branch needs the narrower pool.
      const word = pick(rng, kind === "this" ? TIME_OF_DAY_WORDS_THIS : TIME_OF_DAY_WORDS);
      let phrase;
      let shift;
      let day;
      if (kind === "tonight") {
        phrase = "tonight";
        shift = "night";
        day = { kind: "today" };
      } else if (kind === "this") {
        phrase = `this ${word}`;
        shift = word;
        day = { kind: "today" };
      } else if (kind === "tomorrow") {
        phrase = `tomorrow ${word}`;
        shift = word;
        day = { kind: "tomorrow" };
      } else {
        phrase = `for the ${word}`;
        shift = word;
        day = null;
      }
      return {
        verb: pick(rng, ASSIGN_VERBS),
        op: pick(rng, PEOPLE_ALL),
        part: pick(rng, PARTS_ALL),
        cell: pick(rng, CELLS_ALL),
        phrase,
        shift,
        day,
      };
    },
    sentence: (s) => `${s.verb} ${qw(s.op)} to ${qw(s.part)} on ${qw(s.cell)} ${s.phrase}`,
    form: (s) =>
      baseCommand("assign", {
        operator: s.op,
        product: s.part,
        place: [s.cell],
        day: s.day,
        start: null,
        end: null,
        attach: null,
        existing: null,
        shift: s.shift,
      }),
  },
  // -------------------------------------------------------------------------
  // S58 (design §19.103/D132): group 2's assign-side shapes -- the job's
  // hours (R-414), an assign repeated every weekday (R-416), and F-146's own
  // "to midnight" case (the first pass's own flag, S56-b brief §4).
  // -------------------------------------------------------------------------
  {
    // JB1-JB3: "add/put X to|on the <part> job|run on <cell> [day]" -- the
    // block takes the job's OWN hours, never a clock; start/end stay null.
    // JB3's own case (a quoted part containing a keyword) is exercised for
    // free by drawing `part` from the whole PARTS_ALL pool -- several of
    // `PARTS_REALISTIC`'s own entries need `qw`'s quoting (`pools.mjs`'s own
    // comment: "on"/"at"/"in"/"," on purpose).
    id: "A21-add-to-job",
    intent: "assign",
    genSlots: (rng) => {
      const withDay = chance(rng, 0.5);
      return {
        verb: pick(rng, ASSIGN_VERBS),
        prep: pick(rng, ["to", "on"]),
        noun: pick(rng, ["job", "run"]),
        op: pick(rng, PEOPLE_ALL),
        part: pick(rng, PARTS_ALL),
        cell: pick(rng, CELLS_ALL),
        withDay,
        day: withDay ? randomDay(rng) : null,
      };
    },
    sentence: (s) => {
      const dayText = s.withDay ? ` ${s.day.text}` : "";
      return `${s.verb} ${qw(s.op)} ${s.prep} the ${qw(s.part)} ${s.noun} on ${qw(s.cell)}${dayText}`;
    },
    form: (s) =>
      baseCommand("assign", {
        operator: s.op,
        product: s.part,
        place: [s.cell],
        day: s.withDay ? s.day.day : null,
        start: null,
        end: null,
        attach: null,
        existing: null,
        shift: JOB_HOURS,
      }),
  },
  {
    // RW1/RW3/RW4: "every weekday"/"weekdays"/"every day", with or without
    // "this week"/"next week" (defaults to this week), narrowed by hours (a
    // BARE trailing pair, RW1's own shape -- no "from") or a shift (RW3).
    // The repeat-day clause is stripped from the WHOLE sentence before any
    // verb dispatch runs (parse.ts's own `extractRepeatDayClause`), so its
    // position relative to the hours/shift clause is not load-bearing to
    // the parser -- kept here right after the place, matching every RW
    // case in the brief verbatim.
    id: "A22-every-weekday",
    intent: "assign",
    genSlots: (rng) => {
      const repeatWord = pick(rng, REPEAT_WORDS);
      const kind = repeatWord === "every day" ? "every_day" : "weekdays";
      const withWeek = chance(rng, 0.7);
      const week = withWeek ? pick(rng, ["this_week", "next_week"]) : "this_week";
      const weekText = withWeek ? (week === "this_week" ? " this week" : " next week") : "";
      const withShift = chance(rng, 0.3);
      return {
        verb: pick(rng, ASSIGN_VERBS),
        prep: pick(rng, ["to", "on"]),
        op: pick(rng, PEOPLE_ALL),
        part: pick(rng, PARTS_ALL),
        cell: pick(rng, CELLS_ALL),
        repeatWord,
        kind,
        week,
        weekText,
        withShift,
        span: withShift ? null : randomBareSpan(rng),
        shiftName: withShift ? pick(rng, SHIFTS_ALL) : null,
        shiftPrep: withShift ? pick(rng, ["for", "during"]) : null,
      };
    },
    sentence: (s) => {
      const tail = s.withShift ? `${s.shiftPrep} shift ${qwShift(s.shiftName)}` : s.span.text;
      return `${s.verb} ${qw(s.op)} ${s.prep} ${qw(s.part)} on ${qw(s.cell)} ${s.repeatWord}${s.weekText} ${tail}`;
    },
    form: (s) =>
      baseCommand("assign", {
        operator: s.op,
        product: s.part,
        place: [s.cell],
        day: { kind: s.kind, week: s.week },
        start: s.withShift ? null : s.span.start,
        end: s.withShift ? null : s.span.end,
        attach: null,
        existing: null,
        shift: s.withShift ? s.shiftName : null,
      }),
  },
  {
    // F-146 (the first pass's own flag, S56-b brief §4): an evening start
    // to midnight, said explicitly ("from 8 pm to midnight") or through a
    // duration that lands exactly on minute 1440 ("from 20 for 4 hours") --
    // both must write DAY_END, never the literal {0,0} midnight resolves to
    // everywhere else. `randomSpan`'s own occasional midnight draw (above,
    // time.mjs) gives every OTHER span-bearing template -- book included --
    // the same coverage without a dedicated id for each; this id's own job
    // is just an evening start, where the shape is unmistakable.
    id: "A23-to-midnight",
    intent: "assign",
    genSlots: (rng) => {
      const op = pick(rng, PEOPLE_ALL);
      const part = pick(rng, PARTS_ALL);
      const cell = pick(rng, CELLS_ALL);
      const verb = pick(rng, ASSIGN_VERBS);
      const startHour = randInt(rng, 18, 22); // an evening start
      const useDuration = chance(rng, 0.5);
      if (useDuration) {
        const minutes = (24 - startHour) * 60;
        return {
          verb,
          op,
          part,
          cell,
          useDuration,
          startHour,
          durationText: `${minutes / 60} hours`,
          start: { hour: startHour, minute: 0 },
          end: { hour: 23, minute: 59 },
        };
      }
      const startSpec = chance(rng, 0.5)
        ? { kind: "ampm", hour: startHour, minute: 0, spaced: chance(rng, 0.5) }
        : { kind: "24h", hour: startHour, minute: 0 };
      const span = buildTimePair(startSpec, { kind: "midnight" }, "to");
      return { verb, op, part, cell, useDuration, span };
    },
    sentence: (s) =>
      s.useDuration
        ? `${s.verb} ${qw(s.op)} on ${qw(s.part)} on ${qw(s.cell)} from ${s.startHour} for ${s.durationText}`
        : `${s.verb} ${qw(s.op)} on ${qw(s.part)} on ${qw(s.cell)} from ${s.span.text}`,
    form: (s) =>
      baseCommand("assign", {
        operator: s.op,
        product: s.part,
        place: [s.cell],
        day: null,
        start: s.useDuration ? s.start : s.span.start,
        end: s.useDuration ? s.end : s.span.end,
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
  {
    // WO5/WO6: "<cell> runs <part> <bare pair> [with N people]" -- the
    // word-order grammar's booking marker; "with" joins "for" as a
    // headcount preposition for every book form (R-405).
    id: "B8-cell-runs",
    intent: "book",
    genSlots: (rng) => {
      const withHeadcount = chance(rng, 0.5);
      return {
        cell: pick(rng, CELLS_ALL),
        part: pick(rng, PARTS_ALL),
        span: randomBareSpan(rng),
        withHeadcount,
        n: withHeadcount ? randInt(rng, 1, 12) : null,
      };
    },
    sentence: (s) =>
      s.withHeadcount
        ? `${qw(s.cell)} runs ${qw(s.part)} ${s.span.text} with ${s.n} people`
        : `${qw(s.cell)} runs ${qw(s.part)} ${s.span.text}`,
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
  {
    // DU9: a duration clause AND a headcount clause together -- the second
    // "for" clause is a headcount, never swallowed by the duration's own
    // "for" (the unit word disambiguates them, `DURATION_CLAUSE_RE`'s own
    // bound).
    id: "B9-duration-headcount",
    intent: "book",
    genSlots: (rng) => {
      const startHour = randInt(rng, 6, 16);
      const durHours = randInt(rng, 1, 6);
      // F-151: this start stands alone (a duration names only a LENGTH), so
      // it is computed by `resolveLoneStart`, the same START rule parse.ts's
      // `applyLoneStartRule` now gives it -- never the raw literal hour.
      const start = resolveLoneStart({ kind: "24h", hour: startHour, minute: 0 });
      const endTotal = start.hour * 60 + start.minute + durHours * 60;
      return {
        verb: pick(rng, BOOK_VERBS),
        part: pick(rng, PARTS_ALL),
        cell: pick(rng, CELLS_ALL),
        startHour,
        durHours,
        n: randInt(rng, 1, 12),
        start: { hour: start.hour, minute: start.minute },
        end: { hour: Math.floor(endTotal / 60), minute: endTotal % 60 },
      };
    },
    sentence: (s) =>
      `${s.verb} ${qw(s.part)} on ${qw(s.cell)} from ${s.startHour} for ${s.durHours} hours for ${s.n} people`,
    form: (s) =>
      baseCommand("book", {
        product: s.part,
        place: [s.cell],
        headcount: s.n,
        day: null,
        start: s.start,
        end: s.end,
        existing: null,
      }),
  },
  {
    // BD1's own shape for a booking -- "all day" -- shift ALL_DAY, start/end
    // null.
    id: "B10-all-day",
    intent: "book",
    genSlots: (rng) => ({
      verb: pick(rng, BOOK_VERBS),
      part: pick(rng, PARTS_ALL),
      cell: pick(rng, CELLS_ALL),
      dayWord: pick(rng, ["today", "tomorrow"]),
    }),
    sentence: (s) => `${s.verb} ${qw(s.part)} on ${qw(s.cell)} all day ${s.dayWord}`,
    form: (s) =>
      baseCommand("book", {
        product: s.part,
        place: [s.cell],
        headcount: null,
        day: s.dayWord === "today" ? { kind: "today" } : { kind: "tomorrow" },
        start: null,
        end: null,
        existing: null,
        shift: ALL_DAY,
      }),
  },
  {
    // RW2 (R-416): "every day"/"weekdays" narrowing a booking, "this
    // week"/"next week" (defaults to this week), a bare trailing pair (RW2's
    // own shape -- no "from"), sometimes with a headcount clause the same
    // way B6 already exercises one alongside plain hours.
    id: "B11-every-day",
    intent: "book",
    genSlots: (rng) => {
      const repeatWord = pick(rng, REPEAT_WORDS);
      const kind = repeatWord === "every day" ? "every_day" : "weekdays";
      const withWeek = chance(rng, 0.7);
      const week = withWeek ? pick(rng, ["this_week", "next_week"]) : "this_week";
      const weekText = withWeek ? (week === "this_week" ? " this week" : " next week") : "";
      const withHeadcount = chance(rng, 0.5);
      return {
        verb: pick(rng, BOOK_VERBS),
        part: pick(rng, PARTS_ALL),
        cell: pick(rng, CELLS_ALL),
        repeatWord,
        kind,
        week,
        weekText,
        withHeadcount,
        hc: withHeadcount ? randomHeadcount(rng) : null,
        span: randomBareSpan(rng),
      };
    },
    sentence: (s) => {
      const hcText = s.withHeadcount ? ` ${s.hc.text}` : "";
      return `${s.verb} ${qw(s.part)} on ${qw(s.cell)}${hcText} ${s.repeatWord}${s.weekText} ${s.span.text}`;
    },
    form: (s) =>
      baseCommand("book", {
        product: s.part,
        place: [s.cell],
        headcount: s.withHeadcount ? s.hc.headcount : null,
        day: { kind: s.kind, week: s.week },
        start: s.span.start,
        end: s.span.end,
        existing: null,
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
  // -------------------------------------------------------------------------
  // S56 (D130/S55-a brief §3, RM/EV/AB series): "take" as a removal verb,
  // the lone-edge span, EVERYONE, and the absence grammar's own day/until
  // shape -- every removal sentence the S55-a brief covers that U1-U11 did
  // not yet template.
  // -------------------------------------------------------------------------
  {
    // RM1: "take" joined UNASSIGN_VERBS at R-405 -- "take <op> off <cell>".
    id: "U12-take-off",
    intent: "unassign",
    genSlots: (rng) => ({
      op: pick(rng, PEOPLE_ALL),
      cell: pick(rng, CELLS_ALL),
    }),
    sentence: (s) => `take ${qw(s.op)} off ${qw(s.cell)}`,
    form: (s) =>
      baseCommand("unassign", {
        operator: s.op,
        place: [s.cell],
        day: null,
        span: null,
        existing: null,
        until: null,
      }),
  },
  {
    // TD5: "pull <op> off <cell> this <word>" -- a removal's own shift NAME
    // reading of a time-of-day word, day fixed to today.
    id: "U13-pull-time-of-day",
    intent: "unassign",
    genSlots: (rng) => ({
      op: pick(rng, PEOPLE_ALL),
      cell: pick(rng, CELLS_ALL),
      // Reviewer fix (S56 review): this template only ever says "this
      // <word>" (never "tonight"), so it draws from the NIGHT-EXCLUDED pool
      // the same way A20's own "this" branch does -- see
      // `TIME_OF_DAY_WORDS_THIS`'s comment.
      word: pick(rng, TIME_OF_DAY_WORDS_THIS),
    }),
    sentence: (s) => `pull ${qw(s.op)} off ${qw(s.cell)} this ${s.word}`,
    form: (s) =>
      baseCommand("unassign", {
        operator: s.op,
        place: [s.cell],
        day: { kind: "today" },
        span: null,
        existing: null,
        shift: s.word,
        until: null,
      }),
  },
  {
    // RM5: "after T" -- 14:00 to DAY_END (D130 item 3: the resolver reads
    // DAY_END as midnight).
    id: "U14-after-edge",
    intent: "unassign",
    genSlots: (rng) => ({
      verb: pick(rng, UNASSIGN_VERBS),
      op: pick(rng, PEOPLE_ALL),
      cell: pick(rng, CELLS_ALL),
      hour: randInt(rng, 1, 11), // explicit pm, 1-11 so hour+12 never touches noon/midnight
    }),
    sentence: (s) => `${s.verb} ${qw(s.op)} from ${qw(s.cell)} after ${s.hour} pm`,
    form: (s) =>
      baseCommand("unassign", {
        operator: s.op,
        place: [s.cell],
        day: null,
        span: { start: { hour: s.hour + 12, minute: 0 }, end: DAY_END },
        existing: null,
        until: null,
      }),
  },
  {
    // RM6/RM7: "before T"/"until T" -- 00:00 to the edge; a bare hour under
    // 7 with no am/pm reads as pm (the same "workday" rule the paired
    // afternoon reading already uses, `applyLoneEdgeRule`).
    id: "U15-before-until-edge",
    intent: "unassign",
    genSlots: (rng) => ({
      verb: pick(rng, UNASSIGN_VERBS),
      op: pick(rng, PEOPLE_ALL),
      cell: pick(rng, CELLS_ALL),
      word: pick(rng, ["before", "until"]),
      hour: pick(rng, [1, 2, 3, 4, 5, 6]),
    }),
    sentence: (s) => `${s.verb} ${qw(s.op)} from ${qw(s.cell)} ${s.word} ${s.hour}`,
    form: (s) =>
      baseCommand("unassign", {
        operator: s.op,
        place: [s.cell],
        day: null,
        span: { start: { hour: 0, minute: 0 }, end: { hour: s.hour + 12, minute: 0 } },
        existing: null,
        until: null,
      }),
  },
  {
    // EV1: "clear <place> <day>" -- the implicit-place reading only "clear"
    // gets (R-407): operator EVERYONE, place the word that followed the
    // verb, no separator at all.
    id: "U16-clear-cell",
    intent: "unassign",
    genSlots: (rng) => ({
      cell: pick(rng, CELLS_ALL),
      day: randomBareDay(rng),
    }),
    sentence: (s) => `clear ${qw(s.cell)} ${s.day.text}`,
    form: (s) =>
      baseCommand("unassign", {
        operator: EVERYONE,
        place: [s.cell],
        day: s.day.day,
        span: null,
        existing: null,
        until: null,
      }),
  },
  {
    // EV4-EV6: an EXPLICIT everyone/everybody/all word with a from-place and
    // an edge -- canonical EVERYONE regardless of which alias was said.
    id: "U17-everyone-after",
    intent: "unassign",
    genSlots: (rng) => ({
      verb: pick(rng, UNASSIGN_VERBS),
      alias: pick(rng, EVERYONE_ALIASES),
      cell: pick(rng, CELLS_ALL),
      hour: randInt(rng, 1, 11),
    }),
    sentence: (s) => `${s.verb} ${s.alias} from ${qw(s.cell)} after ${s.hour} pm`,
    form: (s) =>
      baseCommand("unassign", {
        operator: EVERYONE,
        place: [s.cell],
        day: null,
        span: { start: { hour: s.hour + 12, minute: 0 }, end: DAY_END },
        existing: null,
        until: null,
      }),
  },
  {
    // AB1-AB3: "<op> is <absence word> [today|tomorrow]" -- a bare absence
    // (no day at all) reads as today (AB2's own explicit default); place [],
    // until null.
    id: "U18-absence-day",
    intent: "unassign",
    genSlots: (rng) => {
      const withDay = chance(rng, 0.5);
      return {
        op: pick(rng, PEOPLE_ALL),
        word: pick(rng, ABSENCE_WORDS),
        withDay,
        dayWord: withDay ? pick(rng, ["today", "tomorrow"]) : null,
      };
    },
    sentence: (s) =>
      s.withDay ? `${qw(s.op)} is ${s.word} ${s.dayWord}` : `${qw(s.op)} is ${s.word}`,
    form: (s) =>
      baseCommand("unassign", {
        operator: s.op,
        place: [],
        day: s.withDay && s.dayWord === "tomorrow" ? { kind: "tomorrow" } : { kind: "today" },
        span: null,
        existing: null,
        shift: null,
        until: null,
      }),
  },
  {
    // AB4-AB6: "<op> is <absence word> [from <day>] till/until <weekday>" --
    // the absence grammar's own `until`; a from-day sets `day`, its absence
    // leaves `day` as today (AB4's own default).
    id: "U19-absence-until",
    intent: "unassign",
    genSlots: (rng) => {
      const withFromDay = chance(rng, 0.5);
      const untilIdx = randInt(rng, 0, 6);
      const fromDayIdx = withFromDay ? randInt(rng, 0, 6) : null;
      return {
        op: pick(rng, PEOPLE_ALL),
        word: pick(rng, ABSENCE_WORDS),
        untilWord: pick(rng, ["till", "until"]),
        untilIdx,
        untilWeekday: chance(rng, 0.5) ? WEEKDAY_FULL[untilIdx] : WEEKDAY_ABBR[untilIdx],
        withFromDay,
        fromDayIdx,
        fromDayWeekday:
          fromDayIdx !== null
            ? chance(rng, 0.5)
              ? WEEKDAY_FULL[fromDayIdx]
              : WEEKDAY_ABBR[fromDayIdx]
            : null,
      };
    },
    sentence: (s) =>
      s.withFromDay
        ? `${qw(s.op)} is ${s.word} from ${s.fromDayWeekday} ${s.untilWord} ${s.untilWeekday}`
        : `${qw(s.op)} is ${s.word} ${s.untilWord} ${s.untilWeekday}`,
    form: (s) =>
      baseCommand("unassign", {
        operator: s.op,
        place: [],
        day: s.withFromDay ? { kind: "weekday", day: s.fromDayIdx } : { kind: "today" },
        span: null,
        existing: null,
        shift: null,
        until: { kind: "weekday", day: s.untilIdx },
      }),
  },
  {
    // BD5: "for the rest of the day" on a removal -- shift END_OF_DAY, span
    // null (a removal still means "the whole day", D130 item 3).
    id: "U20-rest-of-day",
    intent: "unassign",
    genSlots: (rng) => ({
      verb: pick(rng, UNASSIGN_VERBS),
      op: pick(rng, PEOPLE_ALL),
      cell: pick(rng, CELLS_ALL),
      phrase: pick(rng, ["for the rest of the day", "until end of day", "till the end of the day"]),
    }),
    sentence: (s) => `${s.verb} ${qw(s.op)} from ${qw(s.cell)} ${s.phrase}`,
    form: (s) =>
      baseCommand("unassign", {
        operator: s.op,
        place: [s.cell],
        day: null,
        span: null,
        existing: null,
        shift: END_OF_DAY,
        until: null,
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
  {
    // EV7/EV8: "move everyone (on|from) <place> to <cell> [<day>]" -- the
    // move grammar's own EVERYONE reading (R-407), with and without a day.
    id: "M12-move-everyone",
    intent: "move",
    genSlots: (rng) => {
      const withDay = chance(rng, 0.5);
      return {
        verb: pick(rng, MOVE_VERBS),
        alias: pick(rng, EVERYONE_ALIASES),
        sep: pick(rng, ["on", "from"]),
        place: pick(rng, LINES_ALL.concat(CELLS_ALL)),
        toPlace: pick(rng, CELLS_ALL),
        withDay,
        day: withDay ? randomDay(rng) : null,
      };
    },
    sentence: (s) =>
      s.withDay
        ? `${s.verb} ${s.alias} ${s.sep} ${qw(s.place)} to ${qw(s.toPlace)} ${s.day.text}`
        : `${s.verb} ${s.alias} ${s.sep} ${qw(s.place)} to ${qw(s.toPlace)}`,
    form: (s) =>
      baseCommand("move", {
        operator: EVERYONE,
        place: [s.place],
        toPlace: [s.toPlace],
        day: s.withDay ? s.day.day : null,
        span: null,
        existing: null,
      }),
  },
  // -------------------------------------------------------------------------
  // S58 (design §19.103/D132 item 1, R-412): a re-time by ONE edge --
  // `adjust` set, `span`/`shift`/`toPlace` all null (`baseCommand`'s own
  // `adjust: null` default, above, overridden by every template here).
  // M13/M14 are the dedicated-verb door (`ADJUST_VERBS`); M15 is the
  // possessive-edge-tail door (`MOVE_VERBS`' own "'s start|end|finish"
  // tail). The reviewer's own later rule (S58 review): a place clause may
  // come BEFORE or AFTER the distance/time clause (AJ3 vs AJ20) -- both
  // orderings are drawn here, not just one.
  // -------------------------------------------------------------------------
  {
    // AJ1-AJ4: extend/lengthen (add) or shorten (subtract) "by <duration>".
    id: "M13-extend-by",
    intent: "move",
    genSlots: (rng) => {
      const verb = pick(rng, ADJUST_DISTANCE_VERBS);
      const op = pick(rng, PEOPLE_ALL);
      const withBlock = chance(rng, 0.4); // AJ1's own "'s block" is optional (AJ2 has none)
      const dur = randomAdjustDuration(rng);
      const withPlace = chance(rng, 0.6);
      const cell = withPlace ? pick(rng, CELLS_ALL) : null;
      const placeBefore = withPlace ? chance(rng, 0.5) : false;
      const withDay = chance(rng, 0.5);
      const day = withDay ? randomDay(rng) : null;
      return { verb, op, withBlock, dur, withPlace, cell, placeBefore, withDay, day };
    },
    sentence: (s) => {
      const opText = s.withBlock ? `${qw(s.op)}'s block` : qw(s.op);
      const byClause = `by ${s.dur.text}`;
      const mid = !s.withPlace
        ? byClause
        : s.placeBefore
          ? `on ${qw(s.cell)} ${byClause}`
          : `${byClause} on ${qw(s.cell)}`;
      const dayText = s.withDay ? ` ${s.day.text}` : "";
      return `${s.verb} ${opText} ${mid}${dayText}`;
    },
    form: (s) =>
      baseCommand("move", {
        operator: s.op,
        place: s.withPlace ? [s.cell] : [],
        toPlace: null,
        day: s.withDay ? s.day.day : null,
        span: null,
        existing: null,
        adjust: { edge: "end", by: s.verb === "shorten" ? -s.dur.minutes : s.dur.minutes },
      }),
  },
  {
    // AJ7-AJ10: end/finish "(early) at <time>" or "<duration> earlier|later".
    id: "M14-end-at",
    intent: "move",
    genSlots: (rng) => {
      const verb = pick(rng, ADJUST_AT_VERBS);
      const op = pick(rng, PEOPLE_ALL);
      const withBlock = chance(rng, 0.4);
      const withPlace = chance(rng, 0.6);
      const cell = withPlace ? pick(rng, CELLS_ALL) : null;
      const placeBefore = withPlace ? chance(rng, 0.5) : false;
      const withDay = chance(rng, 0.5);
      const day = withDay ? randomDay(rng) : null;
      const kind = pick(rng, ["at", "earlyAt", "elapsed"]);

      let clauseText;
      let adjust;
      if (kind === "elapsed") {
        const dur = randomAdjustDuration(rng);
        const word = pick(rng, ["earlier", "later"]);
        clauseText = `${dur.text} ${word}`;
        adjust = { edge: "end", by: word === "earlier" ? -dur.minutes : dur.minutes };
      } else {
        // F-146 (AJ22): an END spelled "midnight" writes DAY_END here too.
        const spec = randomLoneTimeSpec(rng, /* allowMidnight */ true);
        const resolved = resolveLoneTime(spec, { allowDayEnd: true });
        clauseText = `${kind === "earlyAt" ? "early at" : "at"} ${resolved.text}`;
        adjust = { edge: "end", at: { hour: resolved.hour, minute: resolved.minute } };
      }
      return {
        verb,
        op,
        withBlock,
        withPlace,
        cell,
        placeBefore,
        withDay,
        day,
        clauseText,
        adjust,
      };
    },
    sentence: (s) => {
      const opText = s.withBlock ? `${qw(s.op)}'s block` : qw(s.op);
      const mid = !s.withPlace
        ? s.clauseText
        : s.placeBefore
          ? `on ${qw(s.cell)} ${s.clauseText}`
          : `${s.clauseText} on ${qw(s.cell)}`;
      const dayText = s.withDay ? ` ${s.day.text}` : "";
      return `${s.verb} ${opText} ${mid}${dayText}`;
    },
    form: (s) =>
      baseCommand("move", {
        operator: s.op,
        place: s.withPlace ? [s.cell] : [],
        toPlace: null,
        day: s.withDay ? s.day.day : null,
        span: null,
        existing: null,
        adjust: s.adjust,
      }),
  },
  {
    // AJ12-AJ15: the possessive-edge-tail door -- "move/shift/change X's
    // start|end|finish to T / by D / D earlier|later". Place, when said, is
    // ALWAYS after the clause on this door (AJ21's own reviewer fix; there
    // is no "before" reading here the way M13/M14's dedicated-verb door
    // has, since the operator segment ends right at "'s <edge>").
    id: "M15-edge-tail",
    intent: "move",
    genSlots: (rng) => {
      const edgeWord = pick(rng, ["start", "end", "finish"]);
      const edge = edgeWord === "start" ? "start" : "end";
      // S52-c's own half-and-half apostrophe coverage (M10-change-timing),
      // exercised here too -- the apostrophe-less spelling only parses right
      // after a DIGIT (`POSSESSIVE_EDGE_TAIL_RE`), so that half draws its
      // operator from `PEOPLE_DEMO` instead of the full pool.
      const noApostrophe = chance(rng, 0.3);
      const op = noApostrophe ? pick(rng, PEOPLE_DEMO) : pick(rng, PEOPLE_ALL);
      const verb = pick(rng, ["move", "shift", "change"]);
      const withPlace = chance(rng, 0.5);
      const cell = withPlace ? pick(rng, CELLS_ALL) : null;
      const withDay = chance(rng, 0.5);
      const day = withDay ? randomDay(rng) : null;
      const kind = pick(rng, ["to", "by", "elapsed"]);

      let clauseText;
      let adjust;
      if (kind === "to") {
        // F-146: only an END edge ever draws "midnight" here -- a START
        // stays the literal {0,0} the S58 brief's own rule keeps.
        const spec = randomLoneTimeSpec(rng, /* allowMidnight */ edge === "end");
        // F-151: which workday rule applies depends on WHICH edge this is --
        // parse.ts's `tryMoveEdgeAdjust` reads a START through
        // `applyLoneStartRule` (hours 1-5 read pm, 6-12 stay as said) and an
        // END through `applyLoneEdgeRule` (1-6) unchanged, so this template
        // mirrors that split rather than always using the END resolver.
        const resolved =
          edge === "start" ? resolveLoneStart(spec) : resolveLoneTime(spec, { allowDayEnd: true });
        clauseText = `to ${resolved.text}`;
        adjust = { edge, at: { hour: resolved.hour, minute: resolved.minute } };
      } else if (kind === "by") {
        const dur = randomAdjustDuration(rng);
        clauseText = `by ${dur.text}`;
        adjust = { edge, by: dur.minutes };
      } else {
        const dur = randomAdjustDuration(rng);
        const word = pick(rng, ["earlier", "later"]);
        clauseText = `${dur.text} ${word}`;
        adjust = { edge, by: word === "earlier" ? -dur.minutes : dur.minutes };
      }
      return {
        edgeWord,
        edge,
        noApostrophe,
        op,
        verb,
        withPlace,
        cell,
        withDay,
        day,
        clauseText,
        adjust,
      };
    },
    sentence: (s) => {
      const possessive = s.noApostrophe ? `${qw(s.op)}s` : `${qw(s.op)}'s`;
      const placeText = s.withPlace ? ` on ${qw(s.cell)}` : "";
      const dayText = s.withDay ? ` ${s.day.text}` : "";
      return `${s.verb} ${possessive} ${s.edgeWord} ${s.clauseText}${placeText}${dayText}`;
    },
    form: (s) =>
      baseCommand("move", {
        operator: s.op,
        place: s.withPlace ? [s.cell] : [],
        toPlace: null,
        day: s.withDay ? s.day.day : null,
        span: null,
        existing: null,
        adjust: s.adjust,
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

// ---------------------------------------------------------------------------
// Replace (R1-R4) -- S56 (D130/S55-a brief §3 RP series, R-406): "cover"/
// "replace" the operator with someone else. Never appears inside a
// `several` (D130 item 2) -- these forms are top-level only.
// ---------------------------------------------------------------------------

const replaceTemplates = [
  {
    // RP1: "cover <op> with <name> on <place> <day>".
    id: "R1-cover-place-day",
    intent: "replace",
    genSlots: (rng) => {
      const [op, withOp] = pickDistinct(rng, PEOPLE_ALL, 2);
      return { op, withOp, cell: pick(rng, CELLS_ALL), day: randomBareDay(rng) };
    },
    sentence: (s) => `cover ${qw(s.op)} with ${qw(s.withOp)} on ${qw(s.cell)} ${s.day.text}`,
    form: (s) => ({
      intent: "replace",
      operator: s.op,
      with: s.withOp,
      place: [s.cell],
      day: s.day.day,
      span: null,
      shift: null,
    }),
  },
  {
    // RP2: "replace <op> with <name>" -- no place said, place [].
    id: "R2-replace-bare",
    intent: "replace",
    genSlots: (rng) => {
      const [op, withOp] = pickDistinct(rng, PEOPLE_ALL, 2);
      return { op, withOp };
    },
    sentence: (s) => `replace ${qw(s.op)} with ${qw(s.withOp)}`,
    form: (s) => ({
      intent: "replace",
      operator: s.op,
      with: s.withOp,
      place: [],
      day: null,
      span: null,
      shift: null,
    }),
  },
  {
    // RP3: "cover <op> with <name> from <t1> to <t2>" -- hours, no place.
    id: "R3-cover-hours",
    intent: "replace",
    genSlots: (rng) => {
      const [op, withOp] = pickDistinct(rng, PEOPLE_ALL, 2);
      return { op, withOp, span: randomSpan(rng) };
    },
    sentence: (s) => `cover ${qw(s.op)} with ${qw(s.withOp)} from ${s.span.text}`,
    form: (s) => ({
      intent: "replace",
      operator: s.op,
      with: s.withOp,
      place: [],
      day: null,
      span: { start: s.span.start, end: s.span.end },
      shift: null,
    }),
  },
  {
    // RP4: "replace <op> with <name> for shift <name> on <place>" -- a shift
    // clause instead of hours.
    id: "R4-replace-shift",
    intent: "replace",
    genSlots: (rng) => {
      const [op, withOp] = pickDistinct(rng, PEOPLE_ALL, 2);
      return {
        op,
        withOp,
        cell: pick(rng, CELLS_ALL),
        prep: pick(rng, ["for", "during"]),
        name: pick(rng, SHIFTS_ALL),
      };
    },
    sentence: (s) =>
      `replace ${qw(s.op)} with ${qw(s.withOp)} ${s.prep} shift ${qwShift(s.name)} on ${qw(s.cell)}`,
    form: (s) => ({
      intent: "replace",
      operator: s.op,
      with: s.withOp,
      place: [s.cell],
      day: null,
      span: null,
      shift: s.name,
    }),
  },
];

// ---------------------------------------------------------------------------
// Swap (W1-W3) -- S56 (D130/S55-a brief §3 SW series, R-406): "swap"/
// "exchange" two operators. Never appears inside a `several` (D130 item 2).
// ---------------------------------------------------------------------------

const swapTemplates = [
  {
    // SW1: "swap <op> and <other>" -- no place, no hours.
    id: "W1-swap-and",
    intent: "swap",
    genSlots: (rng) => {
      const [op, other] = pickDistinct(rng, PEOPLE_ALL, 2);
      return { op, other };
    },
    sentence: (s) => `swap ${qw(s.op)} and ${qw(s.other)}`,
    form: (s) => ({
      intent: "swap",
      operator: s.op,
      other: s.other,
      place: [],
      day: null,
      span: null,
      shift: null,
    }),
  },
  {
    // SW2: "swap <op> with <other> on <place> <day>".
    id: "W2-swap-with-place-day",
    intent: "swap",
    genSlots: (rng) => {
      const [op, other] = pickDistinct(rng, PEOPLE_ALL, 2);
      return { op, other, cell: pick(rng, CELLS_ALL), day: randomBareDay(rng) };
    },
    sentence: (s) => `swap ${qw(s.op)} with ${qw(s.other)} on ${qw(s.cell)} ${s.day.text}`,
    form: (s) => ({
      intent: "swap",
      operator: s.op,
      other: s.other,
      place: [s.cell],
      day: s.day.day,
      span: null,
      shift: null,
    }),
  },
  {
    // SW3: "exchange" -- the SWAP_VERBS synonym.
    id: "W3-exchange",
    intent: "swap",
    genSlots: (rng) => {
      const [op, other] = pickDistinct(rng, PEOPLE_ALL, 2);
      return { op, other };
    },
    sentence: (s) => `exchange ${qw(s.op)} and ${qw(s.other)}`,
    form: (s) => ({
      intent: "swap",
      operator: s.op,
      other: s.other,
      place: [],
      day: null,
      span: null,
      shift: null,
    }),
  },
];

// ---------------------------------------------------------------------------
// Copy (C1-C5) -- S56 (D130/S55-a brief §3 CP series, R-408): "same as
// <day|week>" or "copy/repeat <a> [to] <b>". Never appears inside a
// `several` (D130 item 2).
// ---------------------------------------------------------------------------

const copyTemplates = [
  {
    // CP1/CP2: "same as yesterday [for <place>]" -- day source copies to
    // today; place [] when unstated.
    id: "C1-same-as-yesterday",
    intent: "copy",
    // S56 (found running `voice:generate --n 6000`, the same collision
    // shape as C3-week/C4's own reports): the bare "same as yesterday"
    // sentence has exactly one spelling, so this template's WHOLE clean
    // sentence space used to be 1 (bare) + 28 (one cell) = 29 -- far short
    // of what a template drawn ~60-70 times across 6000 rows needs once
    // held-out has already claimed some of the 29. Widened to cells AND
    // lines, with an optional second "in <line>" qualifier on a cell (the
    // same widening C4 already uses), and the bare branch's own weight
    // lowered so it is drawn less often relative to the now much larger
    // placed space.
    genSlots: (rng) => {
      const withPlace = chance(rng, 0.8);
      if (!withPlace) return { withPlace };
      const place = pick(rng, CELLS_ALL.concat(LINES_ALL));
      const withLine = CELLS_ALL.includes(place) && chance(rng, 0.5);
      return { withPlace, place, withLine, line: withLine ? pick(rng, LINES_ALL) : null };
    },
    sentence: (s) => {
      if (!s.withPlace) return "same as yesterday";
      return s.withLine
        ? `same as yesterday for ${qw(s.place)} in ${qw(s.line)}`
        : `same as yesterday for ${qw(s.place)}`;
    },
    form: (s) => ({
      intent: "copy",
      place: s.withPlace ? (s.withLine ? [s.place, s.line] : [s.place]) : [],
      from: { kind: "yesterday" },
      to: { kind: "today" },
    }),
  },
  {
    // CP3/CP4: "copy <weekday> to <weekday> [for <cell> [in <line>]]".
    id: "C2-copy-weekday-to-weekday",
    intent: "copy",
    genSlots: (rng) => {
      const fromIdx = randInt(rng, 0, 6);
      let toIdx = randInt(rng, 0, 6);
      while (toIdx === fromIdx) toIdx = randInt(rng, 0, 6);
      const withPlace = chance(rng, 0.5);
      const withLine = withPlace && chance(rng, 0.5);
      return {
        fromIdx,
        toIdx,
        withPlace,
        withLine,
        cell: pick(rng, CELLS_ALL),
        line: pick(rng, LINES_ALL),
      };
    },
    sentence: (s) => {
      const base = `copy ${WEEKDAY_FULL[s.fromIdx]} to ${WEEKDAY_FULL[s.toIdx]}`;
      if (!s.withPlace) return base;
      return s.withLine
        ? `${base} for ${qw(s.cell)} in ${qw(s.line)}`
        : `${base} for ${qw(s.cell)}`;
    },
    form: (s) => ({
      intent: "copy",
      place: s.withPlace ? (s.withLine ? [s.cell, s.line] : [s.cell]) : [],
      from: { kind: "weekday", day: s.fromIdx },
      to: { kind: "weekday", day: s.toIdx },
    }),
  },
  {
    // CP5/CP6: "repeat <week> <week>" (no "to") / "copy <week> to <week>" --
    // any two DISTINCT week phrases (not just this/next), plus an optional
    // place, so the template carries enough entropy for the training
    // generator's disjointness retries (a fixed "repeat this week next
    // week"/"copy this week to next week" pair, with no other varying slot,
    // exhausted its 20 non-colliding retries at n=6000 -- found running V9).
    id: "C3-week",
    intent: "copy",
    genSlots: (rng) => {
      const weeks = ["this_week", "next_week", "last_week"];
      const fromWeek = pick(rng, weeks);
      let toWeek = pick(rng, weeks);
      while (toWeek === fromWeek) toWeek = pick(rng, weeks);
      const withPlace = chance(rng, 0.5);
      const withLine = withPlace && chance(rng, 0.5);
      return {
        style: pick(rng, ["repeatNoTo", "copyWithTo"]),
        fromWeek,
        toWeek,
        withPlace,
        withLine,
        cell: pick(rng, CELLS_ALL),
        line: pick(rng, LINES_ALL),
      };
    },
    sentence: (s) => {
      const words = { this_week: "this week", next_week: "next week", last_week: "last week" };
      const verb = s.style === "repeatNoTo" ? "repeat" : "copy";
      const base =
        s.style === "repeatNoTo"
          ? `${verb} ${words[s.fromWeek]} ${words[s.toWeek]}`
          : `${verb} ${words[s.fromWeek]} to ${words[s.toWeek]}`;
      if (!s.withPlace) return base;
      return s.withLine
        ? `${base} for ${qw(s.cell)} in ${qw(s.line)}`
        : `${base} for ${qw(s.cell)}`;
    },
    form: (s) => ({
      intent: "copy",
      place: s.withPlace ? (s.withLine ? [s.cell, s.line] : [s.cell]) : [],
      from: { kind: s.fromWeek },
      to: { kind: s.toWeek },
    }),
  },
  {
    // CP7: "same as last week for <line>" -- a week source copies to
    // this_week.
    id: "C4-same-as-last-week",
    intent: "copy",
    // S56 (found running `voice:generate --n 6000`): a `LINES_ALL`-only pool
    // (24 entries) ran out of non-colliding clean sentences well before
    // 6000 draws -- widened to lines AND cells (52), with an optional
    // second "in <line>" qualifier for far more headroom, the same fix
    // C3-week's own report already covers for a different low-entropy shape.
    genSlots: (rng) => {
      const withLine = chance(rng, 0.5);
      return {
        place: pick(rng, LINES_ALL.concat(CELLS_ALL)),
        withLine,
        line: withLine ? pick(rng, LINES_ALL) : null,
      };
    },
    sentence: (s) =>
      s.withLine
        ? `same as last week for ${qw(s.place)} in ${qw(s.line)}`
        : `same as last week for ${qw(s.place)}`,
    form: (s) => ({
      intent: "copy",
      place: s.withLine ? [s.place, s.line] : [s.place],
      from: { kind: "last_week" },
      to: { kind: "this_week" },
    }),
  },
  {
    // CP10: "copy <iso> to <iso> on <cell>" -- explicit dates.
    id: "C5-dates",
    intent: "copy",
    genSlots: (rng) => {
      const [fromIso, toIso] = pickDistinct(rng, ISO_DATES, 2);
      return { fromIso, toIso, cell: pick(rng, CELLS_ALL) };
    },
    sentence: (s) => `copy ${s.fromIso} to ${s.toIso} on ${qw(s.cell)}`,
    form: (s) => ({
      intent: "copy",
      place: [s.cell],
      from: { kind: "date", iso: s.fromIso },
      to: { kind: "date", iso: s.toIso },
    }),
  },
];

// ---------------------------------------------------------------------------
// Split (X1) -- S58 (design §19.103/D132 item 2, R-413): "split Sam's block
// at noon" -- a shorten plus an assign, written by the board (`resolve.ts`'s
// own `expandCommand`); the grammar's own four fields are all this template
// ever needs. Never appears inside a `several` (the same D130/D132 rule
// `replace`/`swap`/`copy` already follow).
// ---------------------------------------------------------------------------

const splitTemplates = [
  {
    // SP1-SP3: "split X['s block] [on <cell>] at <time> [<day>]" -- the "at"
    // clause is found ANYWHERE (SP2: the place can follow it), so both
    // orders are exercised (`withBlock` mirrors AJ1/AJ2's own optional "'s
    // block").
    id: "X1-split-at",
    intent: "split",
    genSlots: (rng) => {
      const op = pick(rng, PEOPLE_ALL);
      const withBlock = chance(rng, 0.5);
      const withPlace = chance(rng, 0.5);
      const cell = withPlace ? pick(rng, CELLS_ALL) : null;
      const withDay = chance(rng, 0.5);
      const day = withDay ? randomDay(rng) : null;
      const spec = randomLoneTimeSpec(rng, /* allowMidnight */ false);
      const resolved = resolveLoneTime(spec);
      return { op, withBlock, withPlace, cell, withDay, day, resolved };
    },
    sentence: (s) => {
      const opText = s.withBlock ? `${qw(s.op)}'s block` : qw(s.op);
      const placeText = s.withPlace ? ` on ${qw(s.cell)}` : "";
      const dayText = s.withDay ? ` ${s.day.text}` : "";
      return `split ${opText}${placeText} at ${s.resolved.text}${dayText}`;
    },
    form: (s) => ({
      intent: "split",
      operator: s.op,
      place: s.withPlace ? [s.cell] : [],
      day: s.withDay ? s.day.day : null,
      at: { hour: s.resolved.hour, minute: s.resolved.minute },
    }),
  },
];

// ---------------------------------------------------------------------------
// Headcount (H1-H3) -- S58 (design §19.103/D132 item 4, R-415): "make"/"set"
// a job's planned headcount -- one existing write, never a create, never
// part of a lot (never inside a `several`, same rule as the board-answered
// group). `HEADCOUNT_VERBS[0]`/`[1]` are "make"/"set" -- read off the export
// rather than retyped (R-391), each id naming its own verb on purpose the
// same way `templates.mjs`'s header comment already allows.
// ---------------------------------------------------------------------------

const headcountTemplates = [
  {
    // HC1: "make the <part> job on <cell> N people" -- no "to".
    id: "H1-make-job-people",
    intent: "headcount",
    genSlots: (rng) => ({
      part: pick(rng, PARTS_ALL),
      cell: pick(rng, CELLS_ALL),
      n: randInt(rng, 1, 99),
    }),
    sentence: (s) => `${HEADCOUNT_VERBS[0]} the ${qw(s.part)} job on ${qw(s.cell)} ${s.n} people`,
    form: (s) =>
      baseCommand("headcount", {
        product: s.part,
        place: [s.cell],
        day: null,
        span: null,
        shift: null,
        headcount: s.n,
      }),
  },
  {
    // HC2: "set the <part> job on <cell> to N people" -- "set" keeps its
    // own "to" the way HC2 says it.
    id: "H2-set-job-to",
    intent: "headcount",
    genSlots: (rng) => ({
      part: pick(rng, PARTS_ALL),
      cell: pick(rng, CELLS_ALL),
      n: randInt(rng, 1, 99),
    }),
    sentence: (s) =>
      `${HEADCOUNT_VERBS[1]} the ${qw(s.part)} job on ${qw(s.cell)} to ${s.n} people`,
    form: (s) =>
      baseCommand("headcount", {
        product: s.part,
        place: [s.cell],
        day: null,
        span: null,
        shift: null,
        headcount: s.n,
      }),
  },
  {
    // HC3/HC4: a span (WITH "from", HC3's own shape) or a shift narrowing
    // which run, an optional day before either -- always right before the
    // trailing count, which is always the sentence's very last words (the
    // reviewer's own later rule: a day AFTER the count is not a sentence).
    id: "H3-with-hours-or-shift",
    intent: "headcount",
    genSlots: (rng) => {
      const withShift = chance(rng, 0.5);
      const withDay = chance(rng, 0.5);
      return {
        part: pick(rng, PARTS_ALL),
        cell: pick(rng, CELLS_ALL),
        n: randInt(rng, 1, 99),
        withDay,
        day: withDay ? randomDay(rng) : null,
        withShift,
        span: withShift ? null : randomSpan(rng),
        shiftName: withShift ? pick(rng, SHIFTS_ALL) : null,
        shiftPrep: withShift ? pick(rng, ["for", "during"]) : null,
      };
    },
    sentence: (s) => {
      const dayText = s.withDay ? ` ${s.day.text}` : "";
      const narrowText = s.withShift
        ? ` ${s.shiftPrep} shift ${qwShift(s.shiftName)}`
        : ` from ${s.span.text}`;
      return `${HEADCOUNT_VERBS[0]} the ${qw(s.part)} job on ${qw(s.cell)}${dayText}${narrowText} ${s.n} people`;
    },
    form: (s) =>
      baseCommand("headcount", {
        product: s.part,
        place: [s.cell],
        day: s.withDay ? s.day.day : null,
        span: s.withShift ? null : { start: s.span.start, end: s.span.end },
        shift: s.withShift ? s.shiftName : null,
        headcount: s.n,
      }),
  },
];

export const TEMPLATES = [
  ...assignTemplates,
  ...bookTemplates,
  ...unassignTemplates,
  ...moveTemplates,
  ...severalTemplates,
  ...replaceTemplates,
  ...swapTemplates,
  ...copyTemplates,
  ...splitTemplates,
  ...headcountTemplates,
];

export function templateById(id) {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`templateById: unknown id "${id}"`);
  return t;
}
