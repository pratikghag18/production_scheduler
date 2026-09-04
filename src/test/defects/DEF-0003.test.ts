/**
 * Pin for DEF-0003 — a product scope refusal reaches the user as "Something
 * went wrong. Please try again."
 *
 * R-046: "Clients read the JSON error field; raw constraint violations are
 * never part of the contract."
 *
 * WHY IT FAILS. `parseDetail`'s `not_offered_here` branch requires FOUR keys:
 * `kind`, `id`, `owner_node_id` and `node_id`. Migration 0034 (D115, "a product
 * belongs to a list of plants") stopped sending `owner_node_id` for the two
 * PRODUCT guards — a part now has many places, so there is no single owner node
 * to name — while leaving it on the operator guard. Migration 0040 copied the
 * new product shape for cycle times. The parser was not changed with them, so
 * the branch never matches, `toSchedulerError` falls through to `Unknown`, and
 * `describeSchedulerError`'s carefully worded sentence for `NotOfferedHere` is
 * unreachable for every product.
 *
 * The payload below is PASTED, not composed: it is the body PostgREST returned
 * for `create_run` on 2026-09-04 when the company admin put Housing B (a Plant B
 * part) on Plant A / Cell 1.
 *
 * The operator case is here as the control. It still carries `owner_node_id`,
 * so it still parses — which is what shows the defect is the drift between the
 * two payload shapes and not the parser being broken outright.
 */
import { describe, it, expect } from "vitest";
import { toSchedulerError, describeSchedulerError } from "@/lib/api/errors";

/** Verbatim from the wire — `create_run`, HTTP 409. */
const PRODUCT_REFUSAL = {
  code: "PT409",
  details:
    '{"id": "b30f1677-e8b4-4465-bf3d-58caf2c9c4b0", "kind": "product", "error": "not_offered_here", "node_id": "ce0d946d-d104-4c2e-be48-869220e3bad4"}',
  hint: null,
  message: "That product does not belong to this part of the structure.",
};

/** The operator guard (0028/0034) still names an owner, so this one parses. */
const OPERATOR_REFUSAL = {
  code: "PT409",
  details:
    '{"id": "0f1c1d6e-1111-4444-8888-aaaaaaaaaaaa", "kind": "operator", "error": "not_offered_here", "owner_node_id": "22222222-3333-4444-5555-666666666666", "node_id": "ce0d946d-d104-4c2e-be48-869220e3bad4"}',
  hint: null,
  message: "That operator does not belong to this part of the structure.",
};

describe("DEF-0003: a product scope refusal is a typed error, not Unknown", () => {
  it("classifies the product refusal as NotOfferedHere", () => {
    expect(toSchedulerError(PRODUCT_REFUSAL).kind).toBe("NotOfferedHere");
  });

  it("says which kind of row was in the wrong place, not 'Something went wrong'", () => {
    const sentence = describeSchedulerError(toSchedulerError(PRODUCT_REFUSAL));
    expect(sentence).not.toBe("Something went wrong. Please try again.");
  });

  it("still classifies the operator refusal, which kept its owner_node_id", () => {
    expect(toSchedulerError(OPERATOR_REFUSAL).kind).toBe("NotOfferedHere");
  });
});
