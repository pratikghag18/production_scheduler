// scripts/voice/lib/time.mjs — builds a time-clause TEXT and its parsed
// `ClockTime` pair independently of `src/lib/command/parse.ts` (S42-a §2: the
// generator records the form itself; it does not ask the parser for it and
// then call that "checked" — `generate.mjs` asserts the two agree, which is
// only a real check if this side is built without looking at the parser's
// code path). The afternoon rule is mirrored here on purpose, in the same
// shape parse.ts states it, so a drift between the two sides is a red V2/V4,
// per the brief's own rule ("a template the parser cannot read is a template
// bug").

/**
 * One time token, built from a `{ kind, hour, minute }` spec.
 * `kind`: "24h" (no am/pm, hour 0-23), "ampm" (hour still given 0-23; the
 * 12-hour label and am/pm are derived), "noon", "midnight".
 */
export function resolveTimeSpec(spec) {
  if (spec.kind === "noon") return { text: "noon", hour: 12, minute: 0, hasMeridiem: true };
  if (spec.kind === "midnight") return { text: "midnight", hour: 0, minute: 0, hasMeridiem: true };

  const minute = spec.minute ?? 0;
  const mm = minute === 0 ? "" : `:${String(minute).padStart(2, "0")}`;

  if (spec.kind === "24h") {
    return { text: `${spec.hour}${mm}`, hour: spec.hour, minute, hasMeridiem: false };
  }
  if (spec.kind === "ampm") {
    let hour12 = spec.hour % 12;
    if (hour12 === 0) hour12 = 12;
    let meridiem = spec.hour < 12 ? "am" : "pm";
    if (spec.upper) meridiem = meridiem.toUpperCase();
    const sep = spec.spaced ? " " : "";
    return { text: `${hour12}${mm}${sep}${meridiem}`, hour: spec.hour, minute, hasMeridiem: true };
  }
  throw new Error(`resolveTimeSpec: unknown kind "${spec.kind}"`);
}

function totalMinutes(t) {
  return t.hour * 60 + t.minute;
}

/**
 * F-146 (S58 review, R-412/R-413; flagged for this data lane by the S56-b
 * brief §4): true when `spec` spells "the end of the day" the way
 * parse.ts's own `isDayEndSpelling` does -- "midnight", or an explicit
 * "12 am" (an `ampm` spec whose 24h `hour` is 0). This file never imports
 * parse.ts (the header comment's own rule: the oracle in `rows.mjs` is only
 * a real check if this side is built without looking at the parser's code
 * path), so the spelling is read off the SPEC here, independently, rather
 * than off parse.ts's own regex. The literal "24:00" surface is not
 * produced by this generator (nothing here builds a `24h` spec with hour
 * 24) -- the grammar accepts it, but "midnight"/"12 am" already exercise
 * the DAY_END path this file owes a check.
 */
function isDayEndSpec(spec) {
  if (spec.kind === "midnight") return true;
  if (spec.kind === "ampm" && spec.hour === 0) return true;
  return false;
}

/**
 * Mirrors parse.ts's own `applyLoneEdgeRule`: a SINGLE clock read with no
 * explicit meridiem, hour 1-6, reads as the afternoon/evening (+12) -- the
 * workday rule AJ7/SP3 pin ("end Sam early at 3" -> 15:00). Distinct from
 * `buildTimePair`'s own two-clock ambiguity guess below, which only ever
 * touches the END of a `from`/`to` PAIR; this is for a single lone time --
 * the split grammar's "at <time>" and the adjust grammar's "to <time>"/
 * "at <time>" clauses (R-412/R-413, templates M13-M15 and X1).
 */
export function applyLoneEdgeRule(resolved) {
  if (!resolved.hasMeridiem && resolved.hour >= 1 && resolved.hour < 7) {
    return { hour: resolved.hour + 12, minute: resolved.minute };
  }
  return { hour: resolved.hour, minute: resolved.minute };
}

/**
 * A single time token -- `text` plus the CLOCK it actually reads as, the
 * lone-edge workday rule (above) always applied, and -- only when the
 * caller says `allowDayEnd` (an END edge, never a START -- R-412's own
 * rule, AJ16/the S58 brief §2's "A START of midnight stays {0,0}") -- the
 * same F-146 DAY_END override `buildTimePair` gives a pair's END below.
 */
export function resolveLoneTime(spec, { allowDayEnd = false } = {}) {
  const resolved = resolveTimeSpec(spec);
  if (allowDayEnd && isDayEndSpec(spec)) {
    return { text: resolved.text, hour: 23, minute: 59 };
  }
  const clock = applyLoneEdgeRule(resolved);
  return { text: resolved.text, hour: clock.hour, minute: clock.minute };
}

/**
 * A `from <t1> <sep> <t2>`-shaped pair: the text (without the leading "from")
 * and the parsed `{ start, end }`, the end already carrying parse.ts's
 * afternoon rule ("from 10 to 2" -> 10:00-14:00). Returns null when even
 * after the rule the end does not follow the start (an invalid pair --
 * callers must not emit it as a clean row).
 *
 * F-134 (independently written, per the brief -- this file must never
 * import parse.ts): the +12h guess only fires when the START itself is
 * still ambiguous about which half of the day it names -- a bare "24h"
 * spec whose hour is under 13. A START given as "ampm" (explicit am/pm) or
 * as a "24h" spec of 13 or more already pins the day down; guessing at the
 * END on top of that is the bug this rule exists to fix ("17:15 till
 * 10:30" must not silently become 17:15-22:30). "noon"/"midnight" starts
 * are NOT pinned by this rule (parse.ts's own `explicitMeridiem` excludes
 * them too, so "noon to 3" -> 12:00-15:00 keeps working on both sides).
 *
 * F-146 (S58 review; the first pass's own flag, S56-b brief §4): an END
 * spelled "midnight" or "12 am" must write parse.ts's own `DAY_END`
 * ({ hour: 23, minute: 59 }), never the literal { 0, 0 } "midnight"
 * resolves to everywhere else -- and, since DAY_END is the day's OWN LAST
 * minute (1440), the end-after-start check just below must treat it that
 * way too, or "8 pm to midnight" fails as an invalid (end-before-start)
 * pair before it ever reaches the parser. A START spelled the same way is
 * untouched (the same rule `resolveLoneTime` states above).
 */
export function buildTimePair(startSpec, endSpec, sep) {
  const start = resolveTimeSpec(startSpec);
  let end = resolveTimeSpec(endSpec);
  const endIsDayEnd = isDayEndSpec(endSpec);
  const endMinutesForOrder = endIsDayEnd ? 24 * 60 : totalMinutes(end);
  const startPinned = start.hour >= 13 || startSpec.kind === "ampm";
  if (!startPinned && !end.hasMeridiem && endMinutesForOrder <= totalMinutes(start)) {
    end = { ...end, hour: (end.hour + 12) % 24 };
  }
  if (endMinutesForOrder <= totalMinutes(start)) return null;
  const endClock = endIsDayEnd ? { hour: 23, minute: 59 } : { hour: end.hour, minute: end.minute };
  return {
    text: `${start.text} ${sep} ${end.text}`,
    start: { hour: start.hour, minute: start.minute },
    end: endClock,
  };
}

export const TIME_SEPARATORS = ["to", "-", "–", "until", "till"];
