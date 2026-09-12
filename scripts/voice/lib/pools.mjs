// scripts/voice/lib/pools.mjs — name pools for the sentence generator
// (S42-a §3). No database, no app: every string here is shaped like a name a
// person or a plant might actually carry, but none of them resolve to a real
// record (brief §2: "the resolver, not the model, matches names to
// records"). Two families per kind -- DEMO (the shapes the demo world and the
// parser's own worked examples use: "Operator A1", "Housing A", "Cell 1") and
// REALISTIC (fifty or so, so a model does not learn one plant's names) -- are
// exported separately and also pooled together for templates that do not
// care which family a name came from.

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export const PEOPLE_DEMO = [
  "Operator A1",
  "Operator A2",
  "Operator A3",
  "Operator A4",
  "Operator A5",
  "Operator B1",
  "Operator B2",
  "Operator B3",
  "Operator C1",
  "Operator C2",
];

const FIRST_NAMES = [
  "Sam",
  "Alex",
  "Jordan",
  "Priya",
  "Wei",
  "Fatima",
  "Carlos",
  "Elena",
  "Marcus",
  "Aisha",
  "Diego",
  "Ingrid",
  "Kenji",
  "Layla",
  "Noah",
  "Sofia",
  "Tariq",
  "Yuki",
  "Zara",
  "Amara",
  "Boris",
  "Chidi",
  "Dana",
  "Ewa",
  "Felix",
  "Grace",
  "Hassan",
  "Ines",
  "Jamal",
  "Katya",
  "Liam",
  "Mei",
  "Nadia",
  "Omar",
  "Petra",
  "Quinn",
  "Rosa",
  "Sven",
  "Talia",
  "Umar",
  "Vera",
  "Walter",
  "Ximena",
  "Yusuf",
  "Zelda",
  "Anders",
  "Bianca",
  "Cyrus",
  "Deja",
  "Emeka",
];

const LAST_NAMES = [
  "Patel",
  "Nguyen",
  "Kim",
  "Garcia",
  "Silva",
  "Kowalski",
  "Haddad",
  "Ibrahim",
  "Novak",
  "Santos",
  "Okafor",
  "Larsen",
  "Fischer",
  "Rossi",
  "Dubois",
  "Sato",
  "Petrov",
  "Costa",
  "Meyer",
  "Cohen",
  "Osei",
  "Hoang",
  "Reyes",
  "Adebayo",
  "Lindgren",
  "Moreau",
  "Sharma",
  "Kaur",
  "Volkov",
  "Nakamura",
  "Torres",
  "Bakker",
  "Andersen",
  "Popescu",
  "Diallo",
  "Yamamoto",
  "Castillo",
  "Horvath",
  "Mensah",
  "Ferreira",
  "Kobayashi",
  "Vukovic",
  "Nilsson",
  "Choudhury",
  "Aguilar",
  "Berger",
  "Osman",
  "Delgado",
  "Weiss",
  "Bello",
];

/** Fifty realistic "First Last" names -- paired by index, both lists shuffled
 *  by different seeds so the pairing is not alphabetic-with-alphabetic. */
export const PEOPLE_REALISTIC = FIRST_NAMES.map((f, i) => `${f} ${LAST_NAMES[i]}`);

export const PEOPLE_ALL = [...PEOPLE_DEMO, ...PEOPLE_REALISTIC];

// ---------------------------------------------------------------------------
// Parts / products
// ---------------------------------------------------------------------------

export const PARTS_DEMO = ["Housing A", "Housing B", "Housing C", "Housing D"];

/** Fifty realistic part names: plain, some with digits, some with a slash,
 *  some containing a separator word ("on"/"at"/"in"/",") so templates that
 *  exercise the parser's quoting rule (`needsQuoting`, parse.ts) have real
 *  material to quote. */
export const PARTS_REALISTIC = [
  "Bracket 204",
  "Widget 17",
  "Cover Plate",
  "Housing A/Cover",
  "Frame Assembly",
  "Bearing 305",
  "Gasket Set",
  "Sensor Mount",
  "Panel B/12",
  "Latch Kit",
  "Spindle 88",
  "Clamp Assembly",
  "Rotor 6",
  "Valve Body",
  "Bushing 41",
  "Bracket on Rail",
  "Cable Harness",
  "Piston 12",
  "Manifold C/2",
  "Seal Ring",
  "Terminal Block",
  "Bolt Kit 9",
  "Housing at Bay 2",
  "Motor Mount",
  "Sleeve 22",
  "Plate Assembly",
  "Coupling 15",
  "Filter Housing",
  "Shaft 300",
  "Bracket Set A",
  "Nozzle 4",
  "Guard Rail",
  "Cover in Line",
  "Hinge Kit",
  "Actuator 71",
  "Pulley Assembly",
  "Sensor 9/B",
  "Bracket, Left",
  "Insert 55",
  "Flange Plate",
  "Wire Harness",
  "Retainer 3",
  "Cover on Deck",
  "Adapter Kit",
  "Roller 19",
  "Housing Set B",
  "Bushing at Hub",
  "Damper 6",
  "Support Bracket",
  "Grommet Kit",
];

export const PARTS_ALL = [...PARTS_DEMO, ...PARTS_REALISTIC];

// ---------------------------------------------------------------------------
// Places: cells, lines, areas, plants -- demo shapes plus twenty more each.
// ---------------------------------------------------------------------------

export const CELLS_DEMO = Array.from({ length: 8 }, (_, i) => `Cell ${i + 1}`);
export const CELLS_REALISTIC = [
  "Weld Bay 1",
  "Weld Bay 2",
  "Paint Booth A",
  "Paint Booth B",
  "Assembly Bench 1",
  "Assembly Bench 2",
  "Test Stand 1",
  "Test Stand 2",
  "Pack Station 1",
  "Pack Station 2",
  "Grinding Cell",
  "Deburr Station",
  "Inspection Bay",
  "Wash Station",
  "Kit Bench",
  "Press Cell 1",
  "Press Cell 2",
  "Stamping Bay",
  "Trim Station",
  "Load Dock 1",
];
export const CELLS_ALL = [...CELLS_DEMO, ...CELLS_REALISTIC];

export const LINES_DEMO = Array.from({ length: 4 }, (_, i) => `Line ${i + 1}`);
export const LINES_REALISTIC = [
  "Subassembly Line",
  "Final Assembly",
  "Weld Line 1",
  "Weld Line 2",
  "Paint Line",
  "Pack Line",
  "Test Line",
  "Kitting Line",
  "Press Line",
  "Trim Line",
  "Chassis Line",
  "Drivetrain Line",
  "Cab Line",
  "Frame Line",
  "Body Line",
  "Interior Line",
  "Electrical Line",
  "Fluid Fill Line",
  "Torque Line",
  "Ship Line",
];
export const LINES_ALL = [...LINES_DEMO, ...LINES_REALISTIC];

export const AREAS_DEMO = ["Area 1", "Area 2", "Area 3"];
export const AREAS_REALISTIC = [
  "Assembly",
  "Machining",
  "Paint",
  "Weld",
  "Packaging",
  "Receiving",
  "Shipping",
  "Quality",
  "Fabrication",
  "Kitting",
  "Subassembly",
  "Finishing",
  "Warehouse",
  "Tooling",
  "Maintenance",
  "Staging",
  "Chassis",
  "Body Shop",
  "Powertrain",
  "Final Line",
];
export const AREAS_ALL = [...AREAS_DEMO, ...AREAS_REALISTIC];

export const PLANTS_DEMO = ["Plant A", "Plant B", "Plant C"];
export const PLANTS_REALISTIC = [
  "Riverside Plant",
  "Northgate Plant",
  "Eastwood Plant",
  "Fairview Plant",
  "Summit Plant",
  "Harborview Plant",
  "Cedarbrook Plant",
  "Lakeside Plant",
  "Ridgeway Plant",
  "Millbrook Plant",
  "Ashford Plant",
  "Brightwater Plant",
  "Clearview Plant",
  "Dunmore Plant",
  "Elmhurst Plant",
  "Foxhollow Plant",
  "Greenfield Plant",
  "Highcrest Plant",
  "Ironwood Plant",
  "Juniper Plant",
];
export const PLANTS_ALL = [...PLANTS_DEMO, ...PLANTS_REALISTIC];

// ---------------------------------------------------------------------------
// Day words
// ---------------------------------------------------------------------------

/** Index matches parse.ts's WEEKDAY_MAP values: 0 = Sunday .. 6 = Saturday. */
export const WEEKDAY_FULL = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];
export const WEEKDAY_ABBR = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** A pool of plausible ISO dates in 2026, built from real calendar days so
 *  every one of them is a date `Date.UTC` accepts (no Feb-30s to filter). */
export const ISO_DATES = (() => {
  const out = [];
  const base = Date.UTC(2026, 0, 1); // 2026-01-01
  for (let i = 0; i < 40; i++) {
    const d = new Date(base + i * 9 * 24 * 60 * 60 * 1000); // spread across the year
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    out.push(`${y}-${m}-${day}`);
  }
  return out;
})();

// ---------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------

/** Plausible shift-hour starting points, 24h. */
export const TIME_HOURS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
export const TIME_MINUTES = [0, 0, 0, 15, 30, 45]; // weighted toward :00
