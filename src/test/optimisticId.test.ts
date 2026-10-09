/**
 * F-233 (S194-G) -- `src/features/board/lib/optimisticId.ts`. The one place
 * a row's id is built with, or checked against, the "optimistic-" prefix.
 */
import { describe, it, expect } from "vitest";
import {
  makePlaceholderId,
  isPlaceholderId,
  hasPendingPlaceholder,
} from "@/features/board/lib/optimisticId";

describe("optimisticId.ts (F-233)", () => {
  it("O1: makePlaceholderId always starts with the placeholder prefix", () => {
    const id = makePlaceholderId();
    expect(id.startsWith("optimistic-")).toBe(true);
  });

  it("O2: makePlaceholderId never repeats -- each call is a fresh uuid", () => {
    const a = makePlaceholderId();
    const b = makePlaceholderId();
    expect(a).not.toBe(b);
  });

  it("O3: isPlaceholderId is true for exactly what makePlaceholderId produces", () => {
    expect(isPlaceholderId(makePlaceholderId())).toBe(true);
  });

  it("O4: isPlaceholderId is false for a real (server-issued) id", () => {
    expect(isPlaceholderId("a1b2c3d4-0000-4000-8000-000000000000")).toBe(false);
  });

  it("O5: isPlaceholderId is false for the empty string", () => {
    expect(isPlaceholderId("")).toBe(false);
  });

  it("O6: hasPendingPlaceholder is false when neither list holds one", () => {
    expect(hasPendingPlaceholder(["asg-1", "asg-2"], ["run-1"])).toBe(false);
  });

  it("O7: hasPendingPlaceholder is true when an ASSIGNMENT id is a placeholder", () => {
    expect(hasPendingPlaceholder(["asg-1", makePlaceholderId()], ["run-1"])).toBe(true);
  });

  it("O8: hasPendingPlaceholder is true when a JOB (run) id is a placeholder -- the same rule for a job", () => {
    expect(hasPendingPlaceholder(["asg-1"], ["run-1", makePlaceholderId()])).toBe(true);
  });

  it("O9: hasPendingPlaceholder is false for two empty lists", () => {
    expect(hasPendingPlaceholder([], [])).toBe(false);
  });
});
