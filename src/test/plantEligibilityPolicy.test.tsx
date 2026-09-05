/**
 * R-331 — THE BOARD ASKS THE CELL WHAT THE RULE IS, NOT THE COMPANY.
 *
 * Migration 0050 made `eligibility_policy` answerable per node and taught every
 * server writer to resolve it, so a plant set to `block` really is blocked.
 * ⛔ THE BOARD WAS NOT TOLD. `board_window` sent `org.settings` and nothing
 * else, `boardIndex` read `eligibility_policy` out of that one bag, and
 * `CreatePopover` applied the company's answer to every cell on the screen — so
 * on a strict plant the popover still drew an override tick and a reason box,
 * and Create then failed with a message about an override the server would never
 * accept. A dead end, the same shape as F-087.
 *
 * ⭐ SO THE HEADLINE HERE IS `two cells, one board, two answers`, AND IT IS
 * DRIVEN THROUGH THE WHOLE CHAIN — raw `board_window` JSON -> `parseBoardWindow`
 * -> `buildBoardIndex` -> `policyForNode` -> the popover a planner actually
 * reads. A case that called `policyForNode` alone would pass against a
 * `BoardPage` still handing the popover `index.eligibilityPolicy`, which is the
 * bug; a case that rendered the popover alone would pass against a board that
 * never looked the value up. Both ends have to be in one case.
 *
 * ⚠️ NOTHING HERE RESOLVES AN ANCESTRY, and that absence is the design. The
 * value arrives ALREADY RESOLVED because `node_settings` is RLS-scoped: a
 * supervisor granted a line cannot read the override on their own plant's root,
 * so a browser-side walk would find nothing, fall through to the company's
 * `warn`, and offer an override on a plant deliberately set to refuse — the
 * safety rule failing open for the people who use it most. The SQL half of that
 * argument is `supabase/tests/74_board_plant_policy_test.sql`, cases N5/N5b.
 */
import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { render, screen, cleanup } from "@testing-library/react";
import { parseBoardWindow, type Json } from "@/lib/api";
import { buildBoardIndex, policyForNode } from "@/features/board/lib/boardIndex";
import { DENSITIES } from "@/features/board/lib/geometry";
import { CreatePopover } from "@/features/board/components/CreatePopover";

const WINDOW_START = new Date("2026-10-01T00:00:00Z");
const WINDOW_END = new Date("2026-10-02T00:00:00Z");

function node(id: string, parentId: string | null, path: string, levelId: string): Json {
  return {
    id,
    parent_id: parentId,
    level_id: levelId,
    name: id,
    path,
    sort_order: 0,
    active: true,
  } as Json;
}

/**
 * ONE COMPANY, ONE BOARD, TWO BRANCHES. `n-strict-cell` sits under a department
 * somebody set to `block`; `n-open-cell` sits under one left on the company's
 * `warn`. Everything else about the two cells is identical, so the only thing a
 * case below can be measuring is the policy.
 *
 * ⚠️ `node_policies` carries the answer the SERVER reached — `plant`'s own
 * `block` is already spread onto its descendants, exactly as `board_window`
 * emits it. The absence of `n-orphan-cell` from this list is deliberate and
 * `B-EP-orphan` is what it is for.
 */
function rawPayload(): Json {
  return {
    org: { id: "org1", name: "Northwind", settings: { eligibility_policy: "warn" } },
    levels: [
      { id: "lvl-plant", template_id: "tpl", position: 0, name: "Plant", is_schedulable: false },
      { id: "lvl-dept", template_id: "tpl", position: 1, name: "Dept", is_schedulable: false },
      { id: "lvl-cell", template_id: "tpl", position: 2, name: "Cell", is_schedulable: true },
    ],
    nodes: [
      node("n-plant", null, "plant_1", "lvl-plant"),
      node("n-strict", "n-plant", "plant_1.strict", "lvl-dept"),
      node("n-strict-cell", "n-strict", "plant_1.strict.cell_a", "lvl-cell"),
      node("n-open", "n-plant", "plant_1.open", "lvl-dept"),
      node("n-open-cell", "n-open", "plant_1.open.cell_b", "lvl-cell"),
      node("n-orphan-cell", "n-open", "plant_1.open.cell_c", "lvl-cell"),
    ],
    runs: [],
    assignments: [],
    operators: [
      {
        id: "op-untrained",
        home_node_id: null,
        display_name: "Elena",
        employee_ref: null,
        active: true,
        site_node_id: "n-plant",
        skill_ids: [],
        skill_expiries: [],
      },
    ],
    products: [
      {
        id: "p1",
        sku: "WX",
        name: "Widget X",
        active: true,
        color_token: "product-1",
        site_node_ids: ["n-plant"],
        offered_node_ids: ["n-strict-cell", "n-open-cell"],
      },
    ],
    skills: [{ id: "sk-cnc", name: "CNC", site_node_id: "n-plant" }],
    node_skill_requirements: [
      { node_id: "n-strict-cell", skill_id: "sk-cnc" },
      { node_id: "n-open-cell", skill_id: "sk-cnc" },
    ],
    shift_templates: [],
    node_shift_map: [],
    cycle_times: [],
    node_policies: [
      { node_id: "n-plant", eligibility_policy: "warn" },
      { node_id: "n-strict", eligibility_policy: "block" },
      { node_id: "n-strict-cell", eligibility_policy: "block" },
      { node_id: "n-open", eligibility_policy: "warn" },
      { node_id: "n-open-cell", eligibility_policy: "warn" },
    ],
  } as Json;
}

function indexFor(payload: Json = rawPayload()) {
  const parsed = parseBoardWindow(payload);
  // Not a nicety: `parseBoardWindow` returning null is how a board that cannot
  // be judged refuses to draw at all, and a case that silently skipped past it
  // would be measuring nothing.
  expect(parsed).not.toBeNull();
  return buildBoardIndex(parsed!, WINDOW_START, WINDOW_END, DENSITIES[1]);
}

/** The popover exactly as `BoardPage` opens it — including how it gets the
 *  policy, which is the line this whole file is about. */
function openPopoverOn(nodeId: string, index: ReturnType<typeof indexFor>) {
  render(
    <CreatePopover
      nodeId={nodeId}
      anchor={{ x: 10, y: 10 }}
      initialRange={{ startMin: 360, endMin: 840 }}
      shiftChips={[]}
      defaultCreateMode="direct"
      products={[...index.productById.values()]}
      operators={[...index.operatorById.values()]}
      windowStart={WINDOW_START}
      requiredSkills={index.skillsForNode.get(nodeId) ?? []}
      outsideAreaOperatorIds={new Set<string>()}
      eligibilityPolicy={policyForNode(index, nodeId)}
      presetOperatorId="op-untrained"
      onCancel={vi.fn()}
      onSubmitRun={vi.fn()}
      onSubmitDirect={vi.fn()}
    />,
  );
}

function overrideTick(): HTMLElement | null {
  return screen.queryByRole("checkbox", { name: /Override/ });
}

function createButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
}

describe("R-331: the eligibility rule follows the cell, not the company", () => {
  it("the payload's per-node answers survive the parser and reach the index", () => {
    const idx = indexFor();
    expect(idx.eligibilityPolicyByNode.get("n-strict-cell")).toBe("block");
    expect(idx.eligibilityPolicyByNode.get("n-open-cell")).toBe("warn");
    // The company's own value is still read — it is what a node INHERITS, and
    // what an unloaded board falls back to — but it is no longer the answer.
    expect(idx.eligibilityPolicy).toBe("warn");
  });

  it("⭐ THE HEADLINE: the same untrained person, on ONE board, is refused at one cell and offered an override at the other", () => {
    const idx = indexFor();

    // The strict branch: no tick to fill in, Create refused, and the popover
    // says why. Before 0051 this cell showed the tick below instead, and the
    // server then refused the write — a dead end with a form in it.
    openPopoverOn("n-strict-cell", idx);
    expect(overrideTick()).toBeNull();
    expect(createButton().disabled).toBe(true);
    expect(document.body.textContent).toContain("no override");

    // `setup.ts` only cleans up BETWEEN tests, and both halves have to be in
    // ONE test — a company-wide value would make each half pass on its own.
    cleanup();

    // The permissive branch of the SAME company, the SAME person, the SAME
    // missing certificate.
    openPopoverOn("n-open-cell", idx);
    expect(overrideTick()).not.toBeNull();
    expect(document.body.textContent).not.toContain("no override");
  });

  it("⛔ B-EP-orphan: a cell the payload gave no answer for is REFUSED, not quietly allowed", () => {
    // `n-orphan-cell` is in `nodes` and not in `node_policies` — a state
    // `board_window` cannot produce (both come from one CTE) and therefore a
    // state we do not understand. The two ways to be wrong are not symmetric:
    // guessing the company's `warn` draws a tick the server may refuse, which
    // is the defect this work removes; guessing `block` refuses something the
    // server might have allowed, which is visible, complainable, and safe.
    const idx = indexFor();
    expect(policyForNode(idx, "n-orphan-cell")).toBe("block");
    // ...and it is NOT simply that everything unknown looks like the company's
    // value here — the company says `warn`.
    expect(idx.eligibilityPolicy).toBe("warn");
  });

  it("a fully eligible person is unaffected by a strict cell — the policy only decides what happens to a GAP", () => {
    // ⚠️ Half of getting this wrong is a screen that refuses everybody on a
    // strict plant. `blocked` is `ineligible && policy === "block"`, and this
    // case is what holds the first half of that conjunction in place.
    const payload = rawPayload() as unknown as { operators: Record<string, unknown>[] };
    payload.operators[0]!.skill_ids = ["sk-cnc"];
    const idx = indexFor(payload as unknown as Json);
    openPopoverOn("n-strict-cell", idx);
    expect(overrideTick()).toBeNull();
    expect(document.body.textContent).not.toContain("no override");
    expect(createButton().disabled).toBe(false);
  });

  it("⭐ BoardPage hands the popover the CELL's policy, and never the company scalar", () => {
    // ⚠️ THE ONE JOIN THE CASES ABOVE CANNOT SEE. `openPopoverOn` reproduces
    // `BoardPage`'s wiring; it is not `BoardPage`. Rendering the real page needs
    // a session, a router and a query client, so the join is asserted at the
    // source instead — the same device `dateSeam` and `scaleAudit` use, and
    // enough to catch the exact regression: someone putting
    // `index.eligibilityPolicy` back on this prop.
    const src = fs.readFileSync(`${process.cwd()}/src/features/board/BoardPage.tsx`, "utf8");
    const withoutComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(withoutComments).toContain("eligibilityPolicy={policyForNode(index, popover.nodeId)}");
    // ...and the company-wide value reaches no popover prop anywhere on the page.
    expect(withoutComments).not.toContain("eligibilityPolicy={index");
  });

  it("⛔ a payload with no node_policies key at all does not draw a board", () => {
    // The alternative — defaulting to [] — would put every cell back on the
    // company's answer and look exactly like a working board.
    const raw = rawPayload() as unknown as Record<string, unknown>;
    delete raw.node_policies;
    expect(parseBoardWindow(raw as unknown as Json)).toBeNull();
  });
});
