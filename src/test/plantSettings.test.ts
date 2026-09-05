/**
 * R-331 / R-333 — THE THREE PURE DECISIONS THE SETTINGS TAB RESTS ON.
 *
 *   1. WHO may set a place's answer (`canAdministerPlant`).
 *   2. WHICH SCOPE the tab is editing (`settingsScope`).
 *   3. WHETHER A PLANT HAS AN ANSWER AT ALL (`asDateFormat` /
 *      `asEligibilityPolicy` — the null-returning twins of the `coerce*` pair).
 *
 * ⛔ (1) THE WRITE GATE IS **NOT** `canEditNode`. `node_settings`' three write
 * policies are
 *
 *     org_id = app_current_org() and (app_is_admin() or app_is_admin_for(node_id))
 *
 * and `app_is_admin_for` is `app_is_admin() or app_is_admin_on_path(n.path)` —
 * arms (1) and (2) of `app_can_edit_node` and NOT arm (3). `canEditNode` also
 * carries arm (3), `app_can_write() and covered by a WRITABLE grant`, which is
 * true of an org-wide supervisor holding a supervisor grant on a plant. Reusing
 * it here would put a live picker in front of exactly that person, and the
 * server would refuse every move of it — `CLAUDE.md` §4's "a screen that shows
 * what the server will refuse".
 *
 * ⭐ AND IT FAILS **OPEN**, like every other permission mirror in this tree
 * (`editRights.ts`'s header is the standing argument): an unlanded grant read
 * or an unresolvable path answers "offer it", so the server does the refusing
 * out loud rather than the screen hiding a control in silence.
 *
 * ⛔ (3) `coerceDateFormat` AND `coerceEligibilityPolicy` ARE THE WRONG TOOL
 * FOR A PLANT'S ROW, and using them would be a silent bug rather than a
 * near-miss. They turn anything unrecognised into the DEFAULT, which is right
 * for a company bag that has never had the key set — a date must render
 * somehow. For a plant, "absent" and "unrecognised" must both come back as
 * `null`, because `null` IS the third state: a plant read as "set to the
 * default" would show as OVERRIDING when it is not, and would keep that
 * appearance on the day the company changed its mind.
 */
import { describe, it, expect, vi } from "vitest";

// `useOrgSettings.ts` reaches `@/lib/api`, which constructs a Supabase client at
// import time. Nothing here calls a query function, so a stub is enough.
vi.mock("@/lib/api", () => ({
  fetchOrgSettings: vi.fn(),
  setOrgDateFormat: vi.fn(),
  setOrgEligibilityPolicy: vi.fn(),
  fetchPlantSettings: vi.fn(),
  setPlantSetting: vi.fn(),
  clearPlantSetting: vi.fn(),
}));

import {
  asDateFormat,
  asEligibilityPolicy,
  canAdministerPlant,
  settingsScope,
} from "@/features/admin/hooks/useOrgSettings";
import type { EditRights } from "@/features/admin/lib/editRights";
import type { PlantOption } from "@/features/admin/lib/plantFilter";

const KNOWN = (over: Partial<EditRights> = {}): EditRights => ({
  role: "viewer",
  adminPaths: [],
  writablePaths: [],
  known: true,
  ...over,
});

const A: PlantOption = { id: "a", name: "Plant A", path: "plant_a" };
const B: PlantOption = { id: "b", name: "Plant B", path: "plant_b" };

describe("R-331: which plants a reader is offered mirrors app_is_admin_for", () => {
  it("a company admin may set every plant", () => {
    expect(canAdministerPlant("plant_a", KNOWN({ role: "admin" }))).toBe(true);
    expect(canAdministerPlant("plant_b", KNOWN({ role: "admin" }))).toBe(true);
  });

  it("a site admin may set their own plant and no other", () => {
    const dana = KNOWN({ role: "viewer", adminPaths: ["plant_a"] });
    expect(canAdministerPlant("plant_a", dana)).toBe(true);
    expect(canAdministerPlant("plant_b", dana)).toBe(false);
  });

  /**
   * ⛔ THE CASE THAT SEPARATES THIS FROM `canEditNode`. An org-wide supervisor
   * with a SUPERVISOR grant on a plant passes `app_can_edit_node` arm (3) and
   * is refused by `node_settings_update`, which never consults arm (3).
   */
  it("a supervisor with a writable-but-not-admin grant is NOT offered the plant", () => {
    const marco = KNOWN({ role: "supervisor", adminPaths: [], writablePaths: ["plant_a"] });
    expect(canAdministerPlant("plant_a", marco)).toBe(false);
  });

  it("an admin grant on a LINE does not reach the plant above it", () => {
    const line = KNOWN({ role: "viewer", adminPaths: ["plant_a.area_1.line_1"] });
    expect(canAdministerPlant("plant_a", line)).toBe(false);
  });

  it("compares ltree labels, so plant_1 is not an ancestor of plant_10", () => {
    const p1 = KNOWN({ role: "viewer", adminPaths: ["plant_1"] });
    expect(canAdministerPlant("plant_10", p1)).toBe(false);
  });

  it("fails OPEN before the grant read lands, and on a path it cannot resolve", () => {
    const unknown: EditRights = { role: null, adminPaths: [], writablePaths: [], known: false };
    expect(canAdministerPlant("plant_b", unknown)).toBe(true);
    expect(canAdministerPlant(null, KNOWN({ role: "viewer" }))).toBe(true);
  });
});

/* ===========================================================================
 * R-333 — THE TAB FOLLOWS THE CONTROL AT THE TOP.
 *
 * The maintainer, session 62: *"There is a filter at the top for selecting
 * plants. Once we select the plant at the top we should be able to assign the
 * settings to that particular plant."*
 *
 * ⚠️⚠️ THE HARD CASE IS "THERE IS NO CONTROL". `plantControlVisible` is false
 * below two readable roots, and `resolvePlantChoice` then collapses the stored
 * choice to `null`. Following that mechanically would send every such reader to
 * the company defaults, which is right for one of them and wrong for the other
 * — the two are the last four cases below, and `settingsScope`'s own header
 * carries the argument.
 * ======================================================================== */
describe("R-333: which scope the Settings tab is editing", () => {
  it("edits the chosen plant when a plant is chosen", () => {
    expect(settingsScope("b", [A, B], true)).toEqual({
      kind: "plant",
      nodeId: "b",
      name: "Plant B",
      path: "plant_b",
    });
  });

  it("edits the company defaults on All plants", () => {
    expect(settingsScope(null, [A, B], true)).toEqual({ kind: "company" });
    expect(settingsScope(null, [A, B], false)).toEqual({ kind: "company" });
  });

  /**
   * ⚠️ A stored id naming a plant this reader can no longer see is already
   * widened to `null` by `resolvePlantChoice`. Widening here too, rather than
   * throwing or rendering a plant that is not on offer, means the tab lands on
   * the scope every reader can at least SEE if that ever stops being true.
   */
  it("widens to the company defaults if the chosen plant is not on offer", () => {
    expect(settingsScope("gone", [A, B], true)).toEqual({ kind: "company" });
  });

  /**
   * ⛔ THE CASE THAT DECIDES THE NO-CONTROL RULE. A company admin of a
   * one-plant org must edit the COMPANY's values. Sending them to the plant
   * would look identical on the board — every node is under that one root — and
   * would leave `orgs.settings` untouched, so the ACTIVITY screen, which spans
   * plants and therefore reads the company value, would go on showing the old
   * date format. A setting that applies everywhere except one screen is worse
   * than one that applies nowhere.
   */
  it("sends a company admin with one plant to the company defaults", () => {
    expect(settingsScope(null, [A], true)).toEqual({ kind: "company" });
  });

  /**
   * ⛔ AND ITS OPPOSITE, WHICH IS THE WHOLE OF R-331. A site admin granted one
   * plant cannot write `orgs.settings` at all (`set_org_date_format` and
   * `set_org_eligibility_policy` are both `app_is_admin()`), so the company
   * scope would hand them two disabled controls and nothing to do.
   */
  it("sends a site admin with one readable plant to that plant", () => {
    expect(settingsScope(null, [A], false)).toEqual({
      kind: "plant",
      nodeId: "a",
      name: "Plant A",
      path: "plant_a",
    });
  });

  /**
   * ⚠️ FAILS OPEN ON A FAILED STRUCTURE READ. No readable roots is what the
   * panel sees while the hierarchy read is in flight or after it failed;
   * inventing a plant scope out of that would edit nothing at all.
   */
  it("falls back to the company defaults when no plant is readable", () => {
    expect(settingsScope(null, [], false)).toEqual({ kind: "company" });
    expect(settingsScope(null, [], true)).toEqual({ kind: "company" });
  });
});

/* ===========================================================================
 * R-331 — "INHERITING" IS A STATE, AND ONLY A NULL CAN SAY IT.
 * ======================================================================== */
describe("R-331: a plant's own answer is told apart from having none", () => {
  it("reads a stored token as an override", () => {
    expect(asDateFormat("iso")).toBe("iso");
    expect(asDateFormat("ymd_slash")).toBe("ymd_slash");
    expect(asEligibilityPolicy("warn")).toBe("warn");
    expect(asEligibilityPolicy("block")).toBe("block");
  });

  /**
   * ⛔ THE CASE THAT SEPARATES THESE FROM `coerceDateFormat`. Every value here
   * would come back as the DEFAULT from the coercer — `d_mon_yyyy`, `warn` —
   * and the screen would then show a plant as having chosen the default when it
   * has chosen nothing at all.
   */
  it("reads absent, empty and unrecognised as no override at all", () => {
    for (const junk of [null, undefined, "", "ISO", "iso ", "not_a_format", 0, true, [], {}]) {
      expect(asDateFormat(junk)).toBeNull();
      expect(asEligibilityPolicy(junk)).toBeNull();
    }
  });

  /** ⛔ And the two keys' vocabularies do not leak into each other — the same
   *  thing migration 0052's `else false` holds on the server side. */
  it("does not accept one setting's value for the other setting", () => {
    expect(asDateFormat("warn")).toBeNull();
    expect(asDateFormat("block")).toBeNull();
    expect(asEligibilityPolicy("iso")).toBeNull();
    expect(asEligibilityPolicy("d_mon_yyyy")).toBeNull();
  });
});
