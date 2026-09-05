/**
 * F-087 — THE BOARD MUST REACH `check_eligibility`'S OWN VERDICT, AND SAY WHICH
 * OF THE TWO PROBLEMS IT FOUND.
 *
 * The defect: somebody whose certification lapsed a year ago could be dragged
 * onto a cell, drew as eligible, raised no warning, and was offered no override
 * tick — so Create failed with "override required under warn policy" and the box
 * that would supply one was not on screen. A dead end, not a warning.
 *
 * ⭐ THE SERVER'S RULE, WRITTEN OUT ONCE, because every case below is a reading
 * of it (`check_eligibility`, migration 0009, unchanged since):
 *
 *     missing  = required AND NOT held
 *     expiring = required AND held AND expires_at IS NOT NULL
 *                AND (upper_inf(window) OR expires_at < upper(window)::date)
 *     eligible = no missing AND no expiring
 *
 * Three things in that rule are easy to get wrong and each has a case here:
 * the comparison is STRICT (`<`, so expiring ON the last day is still fine),
 * an OPEN-ENDED window makes any real date count as expired, and `missing` and
 * `expiring` are DISJOINT — a training never held cannot also be lapsed.
 *
 * ⚠️ AND THE COMPARISON IS A DAY COMPARISON, NOT AN INSTANT ONE. The server
 * casts the window's upper bound to a `date` in the session timezone, which is
 * UTC here, and `expires_at` is a `date` that arrives as `"YYYY-MM-DD"`. The
 * client therefore takes the window end's UTC calendar day — the board's own
 * frame (`BOARD_ZONE`, `time.ts`) — and compares the two as TEXT: for a
 * fixed-width zero-padded date, lexicographic order is chronological order.
 * `certificateGaps` is where that lives, and `boardDay` is the seam.
 *
 * ⛔ THE HALF THAT IS NOT ARITHMETIC. "Never trained" and "training lapsed" are
 * different problems with different fixes — one needs a course booked, the other
 * a renewal — and the screen that collapsed them into "not eligible" is most of
 * what made this unhelpful. The last describe reads the popover the way a
 * planner does and insists the two never print the same words.
 */
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { parseBoardWindow, type BoardOperator, type Json, type Skill } from "@/lib/api";
import { boardDay, certificateGaps } from "@/features/board/lib/boardIndex";
import { CreatePopover } from "@/features/board/components/CreatePopover";

const CNC: Skill = { id: "sk-cnc", name: "CNC" };
const WELDING: Skill = { id: "sk-weld", name: "Welding" };

function operator(
  id: string,
  skillIds: string[],
  skillExpiries: { skillId: string; expiresAt: string }[] = [],
): BoardOperator {
  return {
    id,
    homeNodeId: null,
    displayName: id,
    employeeRef: null,
    active: true,
    siteNodeId: "n-plant",
    skillIds,
    skillExpiries,
  };
}

// The window every arithmetic case below is judged against, unless it says
// otherwise: 06:00–14:00 UTC on 1 Oct 2026, so the day the server compares
// against is "2026-10-01".
const END = new Date("2026-10-01T14:00:00Z");

describe("F-087: the day the window ends on, in the board's own frame", () => {
  it("is the UTC calendar day of the window's upper bound", () => {
    expect(boardDay(new Date("2026-10-01T14:00:00Z"))).toBe("2026-10-01");
  });

  /**
   * ⚠️ THE CASE THAT PINS THE FRAME. `upper(timerange)::date` runs in the
   * database session's timezone, which is UTC, and the board renders in UTC
   * (`BOARD_ZONE`). An instant one minute before midnight UTC belongs to the
   * day that is ending, and an instant at midnight to the day that is starting
   * — which is what a local-time `getDate()` would get wrong for anybody west
   * of Greenwich, on every assignment that runs to the end of a day.
   */
  it("rolls at midnight UTC, not at the reader's local midnight", () => {
    expect(boardDay(new Date("2026-10-02T23:59:00Z"))).toBe("2026-10-02");
    expect(boardDay(new Date("2026-10-03T00:00:00Z"))).toBe("2026-10-03");
  });
});

describe("F-087: the client reaches check_eligibility's verdict", () => {
  it("a training never held is MISSING", () => {
    const gaps = certificateGaps(operator("o", []), [CNC], END);
    expect(gaps).toEqual([{ skill: CNC, state: "never-trained" }]);
  });

  it("✅ a training held with NO expiry date is fine — it never runs out", () => {
    expect(certificateGaps(operator("o", ["sk-cnc"]), [CNC], END)).toEqual([]);
  });

  it("⭐ a certificate that ran out before the window ends is LAPSED, and carries its date", () => {
    const gaps = certificateGaps(
      operator("o", ["sk-cnc"], [{ skillId: "sk-cnc", expiresAt: "2026-09-01" }]),
      [CNC],
      END,
    );
    expect(gaps).toEqual([{ skill: CNC, state: "lapsed", expiresAt: "2026-09-01" }]);
  });

  it("✅ a certificate that runs out AFTER the window is fine", () => {
    expect(
      certificateGaps(
        operator("o", ["sk-cnc"], [{ skillId: "sk-cnc", expiresAt: "2026-12-31" }]),
        [CNC],
        END,
      ),
    ).toEqual([]);
  });

  /**
   * ⭐ THE PAIR THAT CATCHES A `<=` TYPED WHERE THE SERVER HAS `<`. One day
   * apart, opposite answers. Without both, an off-by-one refuses a shift on the
   * very last day a ticket is valid — which is a screen refusing what the
   * server allows, the mirror of the defect this whole change is about.
   */
  it("✅ expiring ON the window's last day is still valid (the server compares with <)", () => {
    expect(
      certificateGaps(
        operator("o", ["sk-cnc"], [{ skillId: "sk-cnc", expiresAt: "2026-10-01" }]),
        [CNC],
        END,
      ),
    ).toEqual([]);
  });

  it("expiring the day BEFORE the window's last day is lapsed", () => {
    expect(
      certificateGaps(
        operator("o", ["sk-cnc"], [{ skillId: "sk-cnc", expiresAt: "2026-09-30" }]),
        [CNC],
        END,
      ),
    ).toHaveLength(1);
  });

  it("an OPEN-ENDED window makes any expiry date count as lapsed (upper_inf)", () => {
    // "there is no finite date to compare against, so any real expiry falls
    // inside an open-ended window" — check_eligibility's own comment.
    expect(
      certificateGaps(
        operator("o", ["sk-cnc"], [{ skillId: "sk-cnc", expiresAt: "2099-01-01" }]),
        [CNC],
        null,
      ),
    ).toEqual([{ skill: CNC, state: "lapsed", expiresAt: "2099-01-01" }]);
  });

  it("✅ an open-ended window with no expiry date is still fine", () => {
    expect(certificateGaps(operator("o", ["sk-cnc"]), [CNC], null)).toEqual([]);
  });

  it("✅ a LAPSED certificate for a training this cell does not ask for is ignored", () => {
    // Otherwise every planner is warned about every stale ticket in the plant,
    // and the warning stops meaning anything.
    expect(
      certificateGaps(
        operator("o", ["sk-cnc", "sk-weld"], [{ skillId: "sk-weld", expiresAt: "2020-01-01" }]),
        [CNC],
        END,
      ),
    ).toEqual([]);
  });

  it("⛔ never-trained and lapsed are DISJOINT, and both are reported", () => {
    const gaps = certificateGaps(
      operator("o", ["sk-cnc"], [{ skillId: "sk-cnc", expiresAt: "2026-01-01" }]),
      [CNC, WELDING],
      END,
    );
    // CNC is held and stale; Welding was never held. A screen that printed one
    // sentence for both would send the planner to book a course for somebody
    // who only needs a renewal.
    expect(gaps).toEqual([
      { skill: CNC, state: "lapsed", expiresAt: "2026-01-01" },
      { skill: WELDING, state: "never-trained" },
    ]);
  });

  it("✅ a cell that requires nothing is eligible for anybody", () => {
    expect(certificateGaps(operator("o", []), [], END)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The payload has to carry the date, or none of the above can run at all.
// ---------------------------------------------------------------------------
function payload(operators: Json[]): Json {
  return {
    org: { id: "org1", name: "Northwind", settings: {} },
    levels: [],
    nodes: [],
    runs: [],
    assignments: [],
    operators,
    products: [],
    skills: [],
    node_skill_requirements: [],
    shift_templates: [],
    node_shift_map: [],
    cycle_times: [],
    node_policies: [],
  } as Json;
}

const RAW_OPERATOR = {
  id: "op1",
  home_node_id: null,
  display_name: "Maria",
  employee_ref: null,
  active: true,
  site_node_id: "n-plant",
  skill_ids: ["sk-cnc", "sk-weld"],
  skill_expiries: [{ skill_id: "sk-cnc", expires_at: "2026-09-01" }],
};

describe("F-087: board_window's payload carries the expiry (migration 0048)", () => {
  it("parses skill_expiries alongside skill_ids", () => {
    const parsed = parseBoardWindow(payload([RAW_OPERATOR as Json]));
    expect(parsed?.operators[0]?.skillIds).toEqual(["sk-cnc", "sk-weld"]);
    expect(parsed?.operators[0]?.skillExpiries).toEqual([
      { skillId: "sk-cnc", expiresAt: "2026-09-01" },
    ]);
  });

  it("⭐ the dated list is a SUBSET annotation, not a second copy of skill_ids", () => {
    // Two trainings held, one with a renewal date. Reading the dated list as
    // "what they hold" would strip a valid, permanent certificate off them.
    const parsed = parseBoardWindow(payload([RAW_OPERATOR as Json]));
    expect(parsed?.operators[0]?.skillIds).toHaveLength(2);
    expect(parsed?.operators[0]?.skillExpiries).toHaveLength(1);
  });

  it("⛔ REJECTS an operator with no skill_expiries key", () => {
    // The key arrives as `[]` on every operator since 0048 (SQL case E8), so
    // its absence means a payload from a database this client cannot judge
    // eligibility against. Tolerating it would quietly restore the defect:
    // "no dates sent" would read as "nothing has expired".
    const { skill_expiries: _dropped, ...stale } = RAW_OPERATOR;
    expect(parseBoardWindow(payload([stale as Json]))).toBeNull();
  });

  it("⛔ REJECTS an entry whose date is not a string", () => {
    const bad = { ...RAW_OPERATOR, skill_expiries: [{ skill_id: "sk-cnc", expires_at: null }] };
    expect(parseBoardWindow(payload([bad as Json]))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// What the planner actually sees.
// ---------------------------------------------------------------------------
const LAPSED = operator("op-lapsed", ["sk-cnc"], [{ skillId: "sk-cnc", expiresAt: "2026-09-01" }]);
const UNTRAINED = operator("op-untrained", []);
const CURRENT = operator("op-current", ["sk-cnc"]);
const LAST_DAY = operator(
  "op-lastday",
  ["sk-cnc"],
  [{ skillId: "sk-cnc", expiresAt: "2026-10-01" }],
);

/**
 * ⚠️ ONE PERSON IN THE LIST, ON PURPOSE, for every case that reads WORDS. The
 * operator picker labels each name with its own problem, so a popover holding
 * all four would put "Never trained" in the document while the LAPSED person is
 * selected — and a negative assertion about the warning box would pass or fail
 * on the picker's text instead. `openAll` below is for the one case that is
 * actually about the picker.
 */
type DirectSubmit = ComponentProps<typeof CreatePopover>["onSubmitDirect"];

function openPopover(
  who: BoardOperator,
  eligibilityPolicy: "warn" | "block" = "warn",
  onSubmitDirect = vi.fn<DirectSubmit>(),
) {
  renderPopover([who], who.id, eligibilityPolicy, onSubmitDirect);
  return onSubmitDirect;
}

function openAll(presetOperatorId: string) {
  renderPopover(
    [LAPSED, UNTRAINED, CURRENT, LAST_DAY],
    presetOperatorId,
    "warn",
    vi.fn<DirectSubmit>(),
  );
}

function renderPopover(
  operators: BoardOperator[],
  presetOperatorId: string,
  eligibilityPolicy: "warn" | "block",
  onSubmitDirect: DirectSubmit,
) {
  render(
    <CreatePopover
      nodeId="n-cell"
      anchor={{ x: 100, y: 100 }}
      // 06:00-14:00 on 1 Oct 2026, so the window ends on "2026-10-01".
      initialRange={{ startMin: 360, endMin: 840 }}
      shiftChips={[]}
      defaultCreateMode="direct"
      products={[
        {
          id: "p1",
          sku: "WX",
          name: "Widget X",
          active: true,
          siteNodeIds: ["n-plant"],
          offeredNodeIds: ["n-cell"],
          colorToken: "product-1",
        },
      ]}
      operators={operators}
      windowStart={new Date("2026-10-01T00:00:00Z")}
      requiredSkills={[CNC]}
      outsideAreaOperatorIds={new Set<string>()}
      eligibilityPolicy={eligibilityPolicy}
      presetOperatorId={presetOperatorId}
      onCancel={vi.fn()}
      onSubmitRun={vi.fn()}
      onSubmitDirect={onSubmitDirect}
    />,
  );
}

function body(): string {
  return document.body.textContent ?? "";
}

function createButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
}

describe("F-087: the popover names the certificate and its expiry date", () => {
  it("⭐ a LAPSED certificate is named, dated, and called expired — not 'not certified'", () => {
    openPopover(LAPSED);
    const text = body();
    expect(text).toContain("CNC");
    expect(text).toContain("expired");
    // Through the app's date seam, in the org's format — never toLocaleDateString.
    expect(text).toContain("1 Sep 2026");
    // ⛔ and NOT the sentence for somebody who was never trained.
    expect(text).not.toContain("Never trained");
  });

  it("⭐ someone NEVER TRAINED gets the other sentence, with no date", () => {
    openPopover(UNTRAINED);
    const text = body();
    expect(text).toContain("Never trained");
    expect(text).toContain("CNC");
    expect(text).not.toContain("expired");
  });

  it("the two problems name their own fixes, because they are not the same fix", () => {
    openPopover(LAPSED);
    expect(body().toLowerCase()).toContain("renew");
    cleanupAndOpen(UNTRAINED);
    expect(body().toLowerCase()).toContain("training");
  });

  it("✅ a current certificate raises nothing and Create is ready", () => {
    openPopover(CURRENT);
    expect(body()).not.toContain("expired");
    expect(body()).not.toContain("Never trained");
    expect(createButton().disabled).toBe(false);
  });

  it("✅ a certificate expiring ON the last day of the window raises nothing", () => {
    openPopover(LAST_DAY);
    expect(body()).not.toContain("expired");
    expect(createButton().disabled).toBe(false);
  });

  it("the operator list distinguishes the two in its own labels", () => {
    openAll("op-current");
    const options = Array.from(document.querySelectorAll("option")).map((o) => o.textContent ?? "");
    expect(options.some((t) => t.includes("op-lapsed") && t.includes("expired"))).toBe(true);
    expect(options.some((t) => t.includes("op-untrained") && t.includes("Never trained"))).toBe(
      true,
    );
    expect(options.some((t) => t.includes("op-current") && t.includes("("))).toBe(false);
  });
});

describe("F-087: a lapsed certificate gets the same override path a missing one gets", () => {
  it("⛔ THE DEFECT: Create is refused until the override is ticked AND reasoned", () => {
    openPopover(LAPSED);
    // Before the fix there was no tick at all, so this button was enabled and
    // the server refused the write with no way to answer it.
    expect(createButton().disabled).toBe(true);
    const tick = screen.getByRole("checkbox", { name: /Override/ }) as HTMLInputElement;
    fireEvent.click(tick);
    expect(createButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason (required)"), {
      target: { value: "Renewal booked for Friday" },
    });
    expect(createButton().disabled).toBe(false);
  });

  it("the override actually reaches the server call", () => {
    const onSubmitDirect = openPopover(LAPSED);
    fireEvent.click(screen.getByRole("checkbox", { name: /Override/ }));
    fireEvent.change(screen.getByLabelText("Reason (required)"), {
      target: { value: "Renewal booked" },
    });
    fireEvent.click(createButton());
    expect(onSubmitDirect).toHaveBeenCalledTimes(1);
    const args = onSubmitDirect.mock.calls[0] as unknown[];
    // `create_assignment(p_eligibility_override, p_override_reason)` — positions
    // 8 and 9 of the callback, the same pair a missing training sends.
    expect(args[7]).toBe(true);
    expect(args[8]).toBe("Renewal booked");
  });

  it("under BLOCK policy there is no tick and Create stays refused", () => {
    openPopover(LAPSED, "block");
    expect(screen.queryByRole("checkbox", { name: /Override/ })).toBeNull();
    expect(createButton().disabled).toBe(true);
    expect(body()).toContain("no override");
  });
});

/** Re-render inside one `it` — `setup.ts` only cleans up BETWEEN tests. */
function cleanupAndOpen(who: BoardOperator) {
  cleanup();
  openPopover(who);
}
