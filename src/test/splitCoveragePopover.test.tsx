/**
 * R-035: exceeding capacity opens a split-coverage popover, not a dead end.
 *
 * `SplitCoveragePopover` is a pure, props-driven presentational component (no
 * hooks, no data fetching) -- the peak readout is arithmetic over `participants`
 * (D63), never a recomputation, and every write (Split evenly, Confirm, Cancel)
 * is a callback the caller owns. So this file proves exactly what belongs to the
 * component: the participants render with editable efficiencies, the peak is the
 * live sum, Confirm is disabled while the peak exceeds the cap, and each button
 * fires its own callback and no other. What "cancelling reverts" means is a
 * caller-level claim (BoardPage owns the state Cancel walks away from) and is
 * not this file's to prove.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  SplitCoveragePopover,
  type SplitCoverageParticipant,
} from "@/features/board/components/SplitCoveragePopover";

function participants(): SplitCoverageParticipant[] {
  return [
    { assignmentId: "a-1", label: "Cell 1, 06:00-14:00", efficiencyPercent: 60 },
    { assignmentId: null, label: "Cell 2, 08:00-12:00 (incoming)", efficiencyPercent: 60 },
  ];
}

function renderPopover(
  over: {
    participants?: SplitCoverageParticipant[];
    fits?: boolean;
    capPercent?: number;
    onChangeParticipant?: (index: number, efficiencyPercent: number) => void;
    onSplitEvenly?: () => void;
    onConfirm?: () => void;
    onCancel?: () => void;
  } = {},
) {
  const props = {
    operatorName: "Ana",
    capPercent: over.capPercent ?? 100,
    participants: over.participants ?? participants(),
    anchor: { x: 0, y: 0 },
    onChangeParticipant: over.onChangeParticipant ?? vi.fn(),
    onSplitEvenly: over.onSplitEvenly ?? vi.fn(),
    onConfirm: over.onConfirm ?? vi.fn(),
    onCancel: over.onCancel ?? vi.fn(),
    fits: over.fits ?? true,
  };
  render(<SplitCoveragePopover {...props} />);
  return props;
}

describe("SplitCoveragePopover", () => {
  it("P1: lists the operator's overlapping assignments plus the incoming one, each with an editable efficiency", () => {
    renderPopover();
    expect(screen.getByText("Cell 1, 06:00-14:00")).toBeTruthy();
    expect(screen.getByText("Cell 2, 08:00-12:00 (incoming)")).toBeTruthy();
    expect(
      (screen.getByLabelText("Cell 1, 06:00-14:00 efficiency percent") as HTMLInputElement).value,
    ).toBe("60");
    expect(
      (
        screen.getByLabelText(
          "Cell 2, 08:00-12:00 (incoming) efficiency percent",
        ) as HTMLInputElement
      ).value,
    ).toBe("60");
  });

  it("P2: the peak readout is the live sum of the participants' own efficiencies (D63: arithmetic, not recomputed)", () => {
    renderPopover({
      participants: [
        { assignmentId: "a-1", label: "Cell 1", efficiencyPercent: 60 },
        { assignmentId: "a-2", label: "Cell 2", efficiencyPercent: 45 },
      ],
    });
    expect(screen.getByText(/Peak load: 105%/)).toBeTruthy();
  });

  it("P3: Confirm is disabled while the peak exceeds the cap", () => {
    renderPopover({ fits: false });
    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("P3b: Confirm is enabled once the peak fits", () => {
    renderPopover({ fits: true });
    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("P4: the cap is named beside the peak only while it is exceeded", () => {
    renderPopover({ fits: false, capPercent: 100 });
    expect(screen.getByText(/\(cap 100%\)/)).toBeTruthy();
  });

  it("P4b: the cap is not named once the peak fits", () => {
    renderPopover({ fits: true, capPercent: 100 });
    expect(screen.queryByText(/cap 100%/)).toBeNull();
  });

  it("P5: editing a participant's efficiency calls onChangeParticipant with its index and the typed value", () => {
    const onChangeParticipant = vi.fn();
    renderPopover({ onChangeParticipant });
    fireEvent.change(screen.getByLabelText("Cell 2, 08:00-12:00 (incoming) efficiency percent"), {
      target: { value: "80" },
    });
    expect(onChangeParticipant).toHaveBeenCalledWith(1, 80);
  });

  it("P6: Split evenly, Confirm and Cancel each fire their own callback and no other", () => {
    const onSplitEvenly = vi.fn();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    renderPopover({ onSplitEvenly, onConfirm, onCancel, fits: true });
    fireEvent.click(screen.getByRole("button", { name: "Split evenly" }));
    expect(onSplitEvenly).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
