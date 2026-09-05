/**
 * R-331 — THE CLIENT'S MIRROR OF "WHO MAY SET A PLANT'S RULE", AND THE THREE
 * STATES A PLANT CAN BE IN.
 *
 * The maintainer, session 62: *"These settings I think cannot be applied plant
 * wise which defeats the purpose of both options. Lets make it possible to
 * assign settings individually for each plant."* Migration 0050 answers the
 * server half. This file pins the two pure decisions the screen has to get
 * right before any of it renders.
 *
 * ⛔ THE WRITE GATE IS **NOT** `canEditNode`, AND THIS IS THE WHOLE POINT OF
 * THE FILE. `node_settings`' three write policies are
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
 */
import { describe, it, expect, vi } from "vitest";

// `useOrgSettings.ts` reaches `@/lib/api`, which constructs a Supabase client at
// import time. Nothing here calls a query function, so a stub is enough.
vi.mock("@/lib/api", () => ({
  fetchOrgSettings: vi.fn(),
  setOrgDateFormat: vi.fn(),
  setOrgEligibilityPolicy: vi.fn(),
  fetchHierarchyTree: vi.fn(),
  fetchPlantEligibilityPolicies: vi.fn(),
  setPlantEligibilityPolicy: vi.fn(),
  clearPlantEligibilityPolicy: vi.fn(),
}));

import {
  buildPlantPolicyRows,
  canAdministerPlant,
  type PlantPolicyRow,
} from "@/features/admin/hooks/useOrgSettings";
import type { EditRights } from "@/features/admin/lib/editRights";

const KNOWN = (over: Partial<EditRights> = {}): EditRights => ({
  role: "viewer",
  adminPaths: [],
  writablePaths: [],
  known: true,
  ...over,
});

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

/**
 * ⛔ THREE STATES, NOT TWO. A row exists (`override`) or it does not (`null`),
 * and "inheriting, currently refuse" is not the same thing as "set to refuse":
 * the second survives the company changing its mind and the first does not.
 * `buildPlantPolicyRows` must carry both numbers through untouched.
 */
describe("R-331: a plant row keeps 'inheriting' apart from 'set to the same value'", () => {
  const plants = [
    { nodeId: "a", name: "Plant A", override: null, effective: "warn" as const },
    { nodeId: "b", name: "Plant B", override: "warn" as const, effective: "warn" as const },
    { nodeId: "c", name: "Plant C", override: "block" as const, effective: "block" as const },
  ];
  const paths = new Map([
    ["a", "plant_a"],
    ["b", "plant_b"],
    ["c", "plant_c"],
  ]);

  it("does not collapse an absent override into the value it resolves to", () => {
    const rows = buildPlantPolicyRows(plants, paths, KNOWN({ role: "admin" }));
    expect(rows.map((r: PlantPolicyRow) => r.override)).toEqual([null, "warn", "block"]);
    expect(rows.map((r: PlantPolicyRow) => r.effective)).toEqual(["warn", "warn", "block"]);
    // Plant A and Plant B look identical today and are not the same state.
    expect(rows[0].override).not.toBe(rows[1].override);
    expect(rows[0].effective).toBe(rows[1].effective);
  });

  it("marks only the plants this reader may actually write", () => {
    const dana = KNOWN({ role: "viewer", adminPaths: ["plant_b"] });
    const rows = buildPlantPolicyRows(plants, paths, dana);
    expect(rows.map((r) => [r.name, r.editable])).toEqual([
      ["Plant A", false],
      ["Plant B", true],
      ["Plant C", false],
    ]);
  });

  it("offers a plant whose path it could not resolve, rather than hiding it", () => {
    const rows = buildPlantPolicyRows(plants, new Map(), KNOWN({ role: "viewer" }));
    expect(rows.every((r) => r.editable)).toBe(true);
  });

  it("keeps every plant it was given, in the order it was given them", () => {
    const rows = buildPlantPolicyRows(plants, paths, KNOWN({ role: "viewer" }));
    expect(rows.map((r) => r.nodeId)).toEqual(["a", "b", "c"]);
  });
});
