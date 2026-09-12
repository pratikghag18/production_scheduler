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
 * A `from <t1> <sep> <t2>`-shaped pair: the text (without the leading "from")
 * and the parsed `{ start, end }`, the end already carrying parse.ts's
 * afternoon rule ("from 10 to 2" -> 10:00-14:00). Returns null when even
 * after the rule the end does not follow the start (an invalid pair --
 * callers must not emit it as a clean row).
 */
export function buildTimePair(startSpec, endSpec, sep) {
  const start = resolveTimeSpec(startSpec);
  let end = resolveTimeSpec(endSpec);
  if (!end.hasMeridiem && totalMinutes(end) <= totalMinutes(start)) {
    end = { ...end, hour: (end.hour + 12) % 24 };
  }
  if (totalMinutes(end) <= totalMinutes(start)) return null;
  return {
    text: `${start.text} ${sep} ${end.text}`,
    start: { hour: start.hour, minute: start.minute },
    end: { hour: end.hour, minute: end.minute },
  };
}

export const TIME_SEPARATORS = ["to", "-", "–", "until", "till"];
