/// <reference types="node" />
/**
 * THE DATE-SEAM GUARDRAIL.
 *
 * The maintainer, Sep 3: *"can we make sure we add something so any new date
 * displayed on the app in future automatically adopts this?"*
 *
 * A single display seam (`src/lib/format/dates.ts`) is only kept single if new
 * code is FORCED through it — this app had already grown two independent date
 * formatters and one of them was about to become a third. So this is a
 * file-content audit, the same shape as `scaleAudit`'s REM_SURFACES guard: it
 * fails the build when a calendar date is formatted anywhere it should not be.
 *
 * ⭐⭐ S62-a (R-426) WIDENED IT FROM A DISPLAY SEAM TO THE ONE-CLOCK STANDARD.
 * The maintainer, 17 Sept: *"can we make sure the time set by the settings for
 * the plant is the standard the whole board should use for any further
 * development happening here on after?"* Formatting was only ever half the
 * problem — a screen that renders through the seam but decides WHICH DAY an
 * instant falls on with `getDate()` is wrong in the plant's evening and right
 * every afternoon, which is why F-159 and F-161 both survived months of walks.
 * So the audit now refuses the READING as well as the rendering.
 *
 * Five anti-patterns, each with its own allowlist:
 *
 *  - `Intl.DateTimeFormat` / `.toLocaleDateString` / `.toLocaleTimeString` —
 *    what a developer reaches for to render a date. Allowed ONLY in the two
 *    seams: `dates.ts` (calendar dates, this feature) and `board/lib/time.ts`
 *    (the board's instants, `BOARD_ZONE` / R-D88). Everything else must call
 *    `formatCalendarDay` and take its token from `useDateFormat`.
 *
 *  - a MONTH-NAME ARRAY literal (`"Jan","Feb",…`) — the hand-rolled formatter
 *    this app actually shipped. Allowed ONLY in `dates.ts` (the seam) and
 *    `operators.ts` (the dependency-free logic layer, which cannot import the
 *    seam under strip-types and so keeps the DEFAULT rendering for the reason
 *    strings it builds — `dateFormat.test.ts` pins the two defaults equal).
 *
 *  - a MACHINE-LOCAL GETTER (`.getHours(`, `.getDate(`, `.getMonth(`, …,
 *    `.toLocaleString(`) — reading a real instant against whatever zone the
 *    browser's operating system is set to. F-161's shape: the audit log
 *    stamped every change with the reader's laptop clock, and said so on the
 *    screen as though it were a feature. The UTC twins (`getUTCDate`,
 *    `getUTCDay`, …) are NOT needles: they are how a which-day MARKER is
 *    decoded, which is a calendar operation with no zone in it. Allowed only
 *    in the seams.
 *
 *  - `startOfUtcDay(new Date(` / `utcMondayOfWeek(new Date(` — taking the UTC
 *    date to BE today. F-159's shape, and unlike the getters it reads as
 *    careful code: it is deliberate, zone-free, and wrong, because the UTC date
 *    is tomorrow for the evening hours west of Greenwich. Allowed in `time.ts`
 *    (which defines them) and on exactly ONE allowlisted line in `boardView.ts`
 *    — the store's documented FIRST GUESS, made before any payload has carried
 *    the plant's zone and corrected by `BoardPage` the moment it does.
 *
 *  - a RAW `T00:00:00` LITERAL — building a midnight instant by hand, whether
 *    to do day arithmetic on a `YYYY-MM-DD`, to validate one, or to make a
 *    which-day marker. Six copies of that arithmetic had grown, each with its
 *    own correct paragraph about why UTC was safe there; the seventh is the one
 *    that gets it wrong. `dates.ts` owns all three jobs now
 *    (`isoPlusDays`/`weekdayOfIso`/`isoMondayOfWeek`/`isoWeekDays`,
 *    `isCalendarDay`, `dayMarker`/`isoOfDayMarker`), and this needle is what
 *    stops a screen growing its own again.
 *
 * ⚠️ `toLocaleString` (no Date/Time suffix) IS a needle now, and it was not
 * before. The old note read: *"it is the number-formatting call too, and banning
 * it would flag a legitimate future `n.toLocaleString()`"* — true, and the wrong
 * trade once the rule became the CLOCK rather than the rendering. On a `Date` it
 * is the machine's zone, which is precisely what F-161 was; the tree holds no
 * number call spelled that way today, and if one arrives it is allowlisted with
 * its reason like any other exception. A bug that has already shipped twice
 * outranks a hypothetical inconvenience.
 *
 * ⚠️ COMMENTS ARE STRIPPED BEFORE MATCHING — this file and `time.ts` both name
 * `Intl.DateTimeFormat` in prose, and a matcher that reads comments flags the
 * documentation. That mistake has been made repeatedly on this project
 * (`scaleAudit.ts` records three times). STRING LITERALS are kept, because the
 * month array lives in strings.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";

/** Date-render calls allowed only in the two seams. */
export const INTL_NEEDLES: readonly string[] = [
  "Intl.DateTimeFormat",
  ".toLocaleDateString",
  ".toLocaleTimeString",
];

export const INTL_ALLOWLIST: readonly string[] = [
  "src/lib/format/dates.ts",
  "src/features/board/lib/time.ts",
  // R-353 / D88a: the zone vocabulary is a time-formatting seam module — it
  // validates IANA names and labels them with their offset through `Intl`, the
  // one legitimate use outside `time.ts` (which resolves the zoned instants).
  "src/lib/format/timezones.ts",
];

export const MONTH_ALLOWLIST: readonly string[] = [
  "src/lib/format/dates.ts",
  "src/features/admin/lib/operators.ts",
];

/* ---------------------------------------------------------------------------
   R-426 — THE ONE-CLOCK NEEDLES.
   ------------------------------------------------------------------------ */

/**
 * Reading a real instant in the MACHINE's zone.
 *
 * ⚠️ EACH NEEDLE CARRIES ITS LEADING DOT AND ITS OPEN PAREN, and both matter.
 * The dot is what keeps `getUTCDate(` out of `getDate(`'s way — `".getDate("`
 * does not occur inside `".getUTCDate("` — so the UTC twins, which are how a
 * which-day marker is decoded, stay legal. The paren keeps a property or a
 * variable called `getDate` from reading as a call.
 *
 * ⚠️ `.toLocaleString(` IS HERE BUT `.toLocaleDateString(`/`.toLocaleTimeString(`
 * ARE NOT — they are already `INTL_NEEDLES`, and listing a needle twice would
 * report one offence as two. The bare `toLocaleString` was deliberately left
 * out of `INTL_NEEDLES` because it is also the NUMBER formatter; it is in this
 * list because on a `Date` it is the machine's zone, and the audit reports the
 * one hit rather than nothing. A legitimate `n.toLocaleString()` on a number
 * would be allowlisted with its reason, like any other exception.
 */
export const LOCAL_GETTER_NEEDLES: readonly string[] = [
  ".getHours(",
  ".getMinutes(",
  ".getDate(",
  ".getDay(",
  ".getMonth(",
  ".getFullYear(",
  ".toLocaleString(",
];

/** The seams, which resolve zones for everyone else and so must be able to
 *  read a clock. Nothing else in `src/` may. */
export const LOCAL_GETTER_ALLOWLIST: readonly string[] = [
  // The calendar-arithmetic half of the date seam. It uses `Date` as a
  // calendar machine at explicit UTC and reads every part back with `getUTC*`,
  // so it holds none of these needles today; it is listed because that is where
  // a future day-string helper belongs if one ever needs a getter at all.
  "src/lib/format/dates.ts",
  // The board's instant seam — `formatClock`/`formatDayLabel`/the day axis.
  "src/features/board/lib/time.ts",
  // The zone vocabulary: `partsInZone` is the primitive that makes every OTHER
  // file's "which day / which hour" question answerable without a getter.
  "src/lib/format/timezones.ts",
];

/**
 * Taking the UTC date to be TODAY (F-159).
 *
 * ⚠️ THE NEEDLE INCLUDES `new Date(`, ON PURPOSE. `startOfUtcDay(marker)` on a
 * which-day MARKER is correct and common — that is what the marker is for. It
 * is only `startOfUtcDay(new Date())`, the real clock, that names the wrong day.
 */
export const UTC_TODAY_NEEDLES: readonly string[] = [
  "startOfUtcDay(new Date(",
  "utcMondayOfWeek(new Date(",
];

export const UTC_TODAY_ALLOWLIST: readonly string[] = [
  // Defines them, and its own doc carries the whole warning.
  "src/features/board/lib/time.ts",
  // ⭐ THE ONE ALLOWED FIRST GUESS (F-159). `defaultWindowStart()` runs at
  // store-init, before any board payload has landed, and the plant's zone rides
  // on that payload — so there is no zone to ask and the UTC date is the
  // closest guess available. What makes it legal is that it is CORRECTED:
  // `BoardPage`'s `anchorToZone` effect compares the marker against
  // `partsInZone(new Date(), payloadZone)` the moment the zone arrives and
  // re-anchors if nobody has moved the window. A guess that is never corrected
  // is the bug; this one is pinned by `boardViewToday.test.ts` at 18:30 and
  // 19:30 Chicago and in a zone east of UTC.
  "src/features/board/store/boardView.ts",
];

/**
 * Building a midnight instant by hand — the raw literal, in any of the
 * spellings that reached the tree (`T00:00:00Z`, `T00:00:00.000Z`).
 *
 * ⚠️ MATCHED ON THE BARE `T00:00:00`, so a new spelling (`T00:00:00+00:00`)
 * cannot slip past by being novel. It is specific enough not to collide with
 * prose about times, and comments are stripped before matching anyway.
 */
export const RAW_MIDNIGHT_NEEDLES: readonly string[] = ["T00:00:00"];

export const RAW_MIDNIGHT_ALLOWLIST: readonly string[] = [
  // Owns day arithmetic, day validation and the which-day marker (R-426).
  "src/lib/format/dates.ts",
  // The instant seam. Holds none today; listed so that the pair of seams is
  // named consistently across all four rules rather than one rule having its
  // own shorter list for no stated reason.
  "src/features/board/lib/time.ts",
];

/** Strip block and line comments; keep string literals. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** A month-name array literal — `"Jan","Feb"` or `"January","February"`,
 *  in that order, tolerant of whitespace. The signature of a hand-rolled date
 *  formatter. */
function hasMonthArray(src: string): boolean {
  return (
    /"Jan"\s*,\s*"Feb"/.test(src) ||
    /"January"\s*,\s*"February"/.test(src) ||
    /'Jan'\s*,\s*'Feb'/.test(src) ||
    /'January'\s*,\s*'February'/.test(src)
  );
}

/**
 * The offences in one file, given its repo-relative path (which decides the
 * allowlist). Pure — takes the source, so it is falsifiable against synthetic
 * input as well as the tree (rule 3).
 */
export function dateSeamOffences(relPath: string, source: string): string[] {
  const src = stripComments(source);
  const norm = relPath.replace(/\\/g, "/");
  const out: string[] = [];
  if (!INTL_ALLOWLIST.includes(norm)) {
    for (const needle of INTL_NEEDLES) {
      if (src.includes(needle))
        out.push(`${norm}: ${needle} — format dates through formatCalendarDay`);
    }
  }
  if (!MONTH_ALLOWLIST.includes(norm) && hasMonthArray(src)) {
    out.push(`${norm}: a month-name array — format dates through formatCalendarDay`);
  }
  if (!LOCAL_GETTER_ALLOWLIST.includes(norm)) {
    for (const needle of LOCAL_GETTER_NEEDLES) {
      if (src.includes(needle))
        out.push(
          `${norm}: ${needle} — the machine's zone. Read the instant in the plant's zone (partsInZone / formatClock / todayIsoInZone), or its calendar day off a marker with getUTC* (R-426)`,
        );
    }
  }
  if (!UTC_TODAY_ALLOWLIST.includes(norm)) {
    for (const needle of UTC_TODAY_NEEDLES) {
      if (src.includes(needle))
        out.push(
          `${norm}: ${needle}) — the UTC date is not today; it is tomorrow west of Greenwich all evening (F-159). Ask the plant's zone (R-426)`,
        );
    }
  }
  if (!RAW_MIDNIGHT_ALLOWLIST.includes(norm)) {
    for (const needle of RAW_MIDNIGHT_NEEDLES) {
      if (src.includes(needle))
        out.push(
          `${norm}: a raw ${needle} literal — day arithmetic, day validation and which-day markers all belong to src/lib/format/dates.ts (isoPlusDays / isCalendarDay / dayMarker, R-426)`,
        );
    }
  }
  return out;
}

/** Walk `src/`, skipping test files, declarations and the seam audit itself. */
function walkSources(root: string): string[] {
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of fs.readdirSync(`${base}/${rel}`, { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(child);
      } else if (
        (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".test.tsx") &&
        !entry.name.endsWith(".d.ts")
      ) {
        out.push(child);
      }
    }
  };
  walk("src");
  return out;
}

export function auditDateSeam(root: string): string[] {
  const out: string[] = [];
  for (const rel of walkSources(root)) {
    out.push(...dateSeamOffences(rel, fs.readFileSync(`${root}/${rel}`, "utf8")));
  }
  return out;
}

describe("the date-seam guardrail catches a bypass (synthetic — rule 3)", () => {
  const stray = "src/features/admin/components/Somewhere.tsx";

  it("flags Intl.DateTimeFormat outside the seams", () => {
    expect(dateSeamOffences(stray, `new Intl.DateTimeFormat("en-US").format(d)`)).toHaveLength(1);
  });

  it("flags toLocaleDateString / toLocaleTimeString outside the seams", () => {
    expect(dateSeamOffences(stray, `d.toLocaleDateString()`)).toHaveLength(1);
    expect(dateSeamOffences(stray, `d.toLocaleTimeString()`)).toHaveLength(1);
  });

  it("flags a hand-rolled month array outside the seams", () => {
    expect(
      dateSeamOffences(stray, `const M = ["Jan","Feb","Mar","Apr","May","Jun"];`),
    ).toHaveLength(1);
  });

  it("does NOT read the needle out of a comment", () => {
    expect(dateSeamOffences(stray, `// we deliberately avoid Intl.DateTimeFormat here`)).toEqual(
      [],
    );
  });

  it("allows the two seams their tools", () => {
    expect(
      dateSeamOffences("src/features/board/lib/time.ts", `new Intl.DateTimeFormat("en-US")`),
    ).toEqual([]);
    expect(dateSeamOffences("src/lib/format/dates.ts", `const M = ["Jan","Feb"];`)).toEqual([]);
    expect(
      dateSeamOffences("src/features/admin/lib/operators.ts", `const M = ["Jan","Feb"];`),
    ).toEqual([]);
  });

  it("passes a clean file", () => {
    expect(dateSeamOffences(stray, `formatCalendarDay(day, fmt)`)).toEqual([]);
  });
});

describe("R-426 — the one-clock needles (synthetic, both directions)", () => {
  const stray = "src/features/admin/components/Somewhere.tsx";

  /* -- machine-local getters ------------------------------------------- */

  it("flags every machine-local getter outside the seams", () => {
    for (const needle of LOCAL_GETTER_NEEDLES) {
      const call = `const v = d${needle});`;
      expect(dateSeamOffences(stray, call), needle).toHaveLength(1);
    }
  });

  it("does NOT flag the UTC twins — a marker is decoded with getUTC*", () => {
    expect(
      dateSeamOffences(
        stray,
        `const y = m.getUTCFullYear(); const mo = m.getUTCMonth(); const d = m.getUTCDate();
         const w = m.getUTCDay(); const h = m.getUTCHours(); const mi = m.getUTCMinutes();`,
      ),
    ).toEqual([]);
  });

  it("does not read a getter out of a comment", () => {
    expect(dateSeamOffences(stray, `// never d.getHours() here — ask the zone`)).toEqual([]);
  });

  it("allows the three seams their clock reads", () => {
    for (const seam of LOCAL_GETTER_ALLOWLIST) {
      expect(dateSeamOffences(seam, `d.getHours(); d.getDate();`), seam).toEqual([]);
    }
  });

  /* -- the UTC date as today ------------------------------------------- */

  it("flags startOfUtcDay(new Date()) / utcMondayOfWeek(new Date()) outside the allowlist", () => {
    expect(dateSeamOffences(stray, `const t = startOfUtcDay(new Date());`)).toHaveLength(1);
    expect(dateSeamOffences(stray, `const m = utcMondayOfWeek(new Date());`)).toHaveLength(1);
  });

  it("does NOT flag startOfUtcDay on a MARKER, which is what it is for", () => {
    expect(dateSeamOffences(stray, `const t = startOfUtcDay(windowStartDate);`)).toEqual([]);
  });

  it("allows time.ts and boardView.ts's documented first guess (F-159)", () => {
    expect(dateSeamOffences("src/features/board/lib/time.ts", `startOfUtcDay(new Date())`)).toEqual(
      [],
    );
    expect(
      dateSeamOffences("src/features/board/store/boardView.ts", `startOfUtcDay(new Date())`),
    ).toEqual([]);
  });

  /* -- a hand-built midnight ------------------------------------------- */

  it("flags a raw midnight literal outside the seams, in either spelling", () => {
    expect(dateSeamOffences(stray, 'const d = new Date(iso + "T00:00:00Z");')).toHaveLength(1);
    expect(dateSeamOffences(stray, 'const d = new Date(iso + "T00:00:00.000Z");')).toHaveLength(1);
  });

  it("does NOT flag the helpers that replaced it", () => {
    expect(
      dateSeamOffences(stray, `const next = isoPlusDays(iso, 1); const m = dayMarker(iso);`),
    ).toEqual([]);
  });

  it("allows the two seams their own midnight", () => {
    for (const seam of RAW_MIDNIGHT_ALLOWLIST) {
      expect(dateSeamOffences(seam, "new Date(`${iso}T00:00:00.000Z`)"), seam).toEqual([]);
    }
  });

  /* -- one offence per rule, not one per file --------------------------- */

  it("reports each rule a file breaks, and names the rule", () => {
    const offences = dateSeamOffences(
      stray,
      `d.getHours(); const t = startOfUtcDay(new Date()); new Date(iso + "T00:00:00Z");`,
    );
    expect(offences).toHaveLength(3);
    expect(offences.join("\n")).toContain("R-426");
  });
});

describe("the real source tree goes through the seam", () => {
  it("has no date formatted, and no clock read, outside the seams (R-426)", () => {
    const offences = auditDateSeam(process.cwd());
    expect(offences).toEqual([]);
  });
});
