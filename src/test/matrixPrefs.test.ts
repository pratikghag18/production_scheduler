/**
 * Acceptance suite for `src/features/admin/lib/matrixPrefs.ts` — what the
 * training matrix remembers per viewer (the "expiring soon" window and the
 * area / line scope), and the honest empty state it shows when there is nothing
 * to draw. Stage M5.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE IS DEFENDING. Like `plantFilter.test.ts`, none of this mirrors
 * a server rule — it is a convenience stored in `localStorage`. So the invariant
 * is not correctness against the database; it is that the convenience can NEVER
 * take the screen down or bring a reader back to a grid that lies about being
 * empty. A blocked / corrupt / hand-edited store must land on the default, a
 * value outside the offered set must fold back onto it, and the empty state must
 * name which of three different absences it is.
 */
import { afterEach, expect, it, vi } from "vitest";
import {
  DEFAULT_EXPIRY_WINDOW,
  DEFAULT_MATRIX_VIEW,
  MATRIX_EMPTY_TEXT,
  cascadeBaseId,
  coerceWindow,
  loadMatrixView,
  matrixEmptyReason,
  readableRootIds,
  saveMatrixView,
  type MatrixView,
} from "../features/admin/lib/matrixPrefs.ts";

const ORG = "10000000-0000-0000-0000-000000000001";
const ORG_2 = "10000000-0000-0000-0000-000000000002";
const AREA = "20000000-0000-0000-0000-00000000000b";
const LINE = "20000000-0000-0000-0000-00000000000c";

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

/* ===========================================================================
 * coerceWindow — a stored window is only ever one of the offered three.
 * =========================================================================== */

it("MP1: the three offered windows survive coercion unchanged", () => {
  expect(coerceWindow(30)).toBe(30);
  expect(coerceWindow(60)).toBe(60);
  expect(coerceWindow(90)).toBe(90);
});

it("MP2 ⭐: anything else folds onto the 30-day default, never crashes", () => {
  // A hand-edited or older value can only ever widen the "clear" band.
  expect(coerceWindow(45)).toBe(DEFAULT_EXPIRY_WINDOW);
  expect(coerceWindow("60")).toBe(DEFAULT_EXPIRY_WINDOW); // a string, not the number
  expect(coerceWindow(null)).toBe(DEFAULT_EXPIRY_WINDOW);
  expect(coerceWindow(undefined)).toBe(DEFAULT_EXPIRY_WINDOW);
  expect(coerceWindow({})).toBe(DEFAULT_EXPIRY_WINDOW);
});

/* ===========================================================================
 * load / save — remembered per org, guarded at every access.
 * =========================================================================== */

it("MP3: with nothing stored, the default view comes back", () => {
  expect(loadMatrixView(ORG)).toEqual(DEFAULT_MATRIX_VIEW);
});

it("MP4: a saved view comes back whole", () => {
  const view: MatrixView = { window: 90, areaId: AREA, lineId: LINE };
  saveMatrixView(ORG, view);
  expect(loadMatrixView(ORG)).toEqual(view);
});

it("MP5 ⭐: the DEFAULT view removes the key rather than storing a blob", () => {
  // The absence of a key and an explicit default mean the same thing; one
  // representation cannot drift from the other.
  saveMatrixView(ORG, { window: 60, areaId: AREA, lineId: null });
  saveMatrixView(ORG, DEFAULT_MATRIX_VIEW);
  expect(loadMatrixView(ORG)).toEqual(DEFAULT_MATRIX_VIEW);
  expect(window.localStorage.length).toBe(0);
});

it("MP6 ⭐: the key is scoped per ORG — a view in one org is unseen in another", () => {
  saveMatrixView(ORG, { window: 90, areaId: AREA, lineId: null });
  expect(loadMatrixView(ORG_2)).toEqual(DEFAULT_MATRIX_VIEW);
});

it("MP7: no org yet (the profile has not loaded) reads and writes nothing", () => {
  saveMatrixView(null, { window: 90, areaId: AREA, lineId: LINE });
  expect(loadMatrixView(null)).toEqual(DEFAULT_MATRIX_VIEW);
  expect(window.localStorage.length).toBe(0);
});

it("MP8 ⭐: a window stored out of range folds back onto the default on load", () => {
  window.localStorage.setItem("ps.admin.matrix." + ORG, JSON.stringify({ window: 45, areaId: AREA }));
  const view = loadMatrixView(ORG);
  expect(view.window).toBe(DEFAULT_EXPIRY_WINDOW);
  expect(view.areaId).toBe(AREA);
  expect(view.lineId).toBe(null);
});

it("MP9 ⭐⭐: a CORRUPT stored value lands on the default, it does not throw", () => {
  // Some other version, or a fat-fingered dev tools edit, can leave a value
  // `JSON.parse` rejects. That must degrade the convenience, not the screen.
  window.localStorage.setItem("ps.admin.matrix." + ORG, "{not json");
  expect(loadMatrixView(ORG)).toEqual(DEFAULT_MATRIX_VIEW);
});

it("MP10 ⭐: a non-string areaId / lineId is dropped to null", () => {
  window.localStorage.setItem(
    "ps.admin.matrix." + ORG,
    JSON.stringify({ window: 60, areaId: 42, lineId: { x: 1 } }),
  );
  expect(loadMatrixView(ORG)).toEqual({ window: 60, areaId: null, lineId: null });
});

it("MP11 ⭐⭐: a localStorage that THROWS degrades the feature, not the screen", () => {
  vi.spyOn(window.localStorage.__proto__, "getItem").mockImplementation(() => {
    throw new Error("SecurityError: access is denied for this document");
  });
  vi.spyOn(window.localStorage.__proto__, "setItem").mockImplementation(() => {
    throw new Error("SecurityError: access is denied for this document");
  });
  expect(loadMatrixView(ORG)).toEqual(DEFAULT_MATRIX_VIEW);
  expect(() => saveMatrixView(ORG, { window: 90, areaId: AREA, lineId: null })).not.toThrow();
});

/* ===========================================================================
 * matrixEmptyReason — which absence, named widest-first.
 * =========================================================================== */

it("MP12: with trainings, operators and a selection, the grid draws", () => {
  expect(matrixEmptyReason(3, 5, 5)).toBe("ok");
});

it("MP13 ⭐: no trainings in scope wins over everything below it", () => {
  // The outermost thing to widen is named first: no columns at all, whatever
  // the operator counts say.
  expect(matrixEmptyReason(0, 5, 5)).toBe("no-trainings");
  expect(matrixEmptyReason(0, 0, 0)).toBe("no-trainings");
});

it("MP14: trainings but no operators in scope reads as no-operators", () => {
  expect(matrixEmptyReason(3, 0, 0)).toBe("no-operators");
});

it("MP15 ⭐: operators in scope but none selected is its OWN state, not 'no people'", () => {
  // "You unchecked everyone" has a different fix (pick All) than "there is
  // nobody here" (widen the scope), so it must not be collapsed into it.
  expect(matrixEmptyReason(3, 5, 0)).toBe("none-selected");
});

it("MP16: every non-ok reason has a sentence, and each names a fix", () => {
  for (const reason of ["no-trainings", "no-operators", "none-selected"] as const) {
    expect(MATRIX_EMPTY_TEXT[reason]).toMatch(/\S/);
  }
});

/* ===========================================================================
 * readableRootIds / cascadeBaseId — the maintainer's bug: site admins and
 * supervisors had no hierarchy filters because the cascade hung off the plant
 * CHOOSER, which they never see. These are the fix, and its proof.
 *
 *   Plant A   a          (site admin reads this whole subtree)
 *   ├─ Area 1   a.ar1    (supervisor's TOP — its plant is unreadable above it)
 *   │   └─ Line 1  a.ar1.l1
 *   Plant B   b          (a second root, for the system-admin case)
 * =========================================================================== */

const N_A = { id: "a", parentId: null };
const N_A_AR1 = { id: "a-ar1", parentId: "a" };
const N_A_L1 = { id: "a-l1", parentId: "a-ar1" };
const N_B = { id: "b", parentId: null };

it("MP17: a true root is the topmost readable node", () => {
  expect(readableRootIds([N_A, N_A_AR1, N_A_L1])).toEqual(["a"]);
});

it("MP18 ⭐: a node whose PARENT is unreadable is a readable root — the supervisor case", () => {
  // A supervisor granted Area 1 reads it and Line 1 but NOT Plant A above. Area
  // 1's parent id is absent from what they can see, so Area 1 is their top —
  // and must anchor the cascade, or they get no filter at all.
  expect(readableRootIds([N_A_AR1, N_A_L1])).toEqual(["a-ar1"]);
});

it("MP19: with two visible plants, both are roots", () => {
  expect(readableRootIds([N_A, N_B, N_A_AR1]).sort()).toEqual(["a", "b"]);
});

it("MP20 ⭐⭐: a chosen plant always wins — it is what the system admin picked", () => {
  expect(cascadeBaseId("b", ["a", "b"])).toBe("b");
});

it("MP21 ⭐: NO choice and ONE readable root anchors on it — the site-admin fix", () => {
  // This is the whole bug: `choice` is null because the chooser is hidden at one
  // root, and the cascade must still find that root.
  expect(cascadeBaseId(null, ["a"])).toBe("a");
});

it("MP22 ⭐: NO choice and SEVERAL roots stays null — 'Area 1' in which plant?", () => {
  // The multi-plant system admin at All plants gets no area cascade until they
  // pick a plant — unchanged behaviour, and the reason this is not just
  // `rootIds[0]`.
  expect(cascadeBaseId(null, ["a", "b"])).toBe(null);
});

it("MP23: no readable roots at all resolves to null rather than throwing", () => {
  expect(cascadeBaseId(null, [])).toBe(null);
});
