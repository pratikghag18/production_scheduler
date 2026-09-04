/**
 * The shared editable box, driven (R-318).
 *
 * Each case here is one of the things the maintainer reported on the
 * cycle-times grid, asserted on the shared control rather than on the screen
 * that prompted it — a standard tested only through its first caller stops
 * being a standard the moment there is a second.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { InlineEdit } from "@/components/InlineEdit";

describe("R-318: an editable cell is a box, and it can always be left", () => {
  it("an empty cell renders a BOX inviting a value, not a dash", () => {
    render(<InlineEdit value="" ariaLabel="Cycle time" onSave={vi.fn()} />);
    const box = screen.getByRole("button", { name: "Cycle time" });
    expect(box).toBeTruthy();
    // The thing the maintainer asked for: an empty box reading as somewhere to
    // type, rather than a dash reading as missing data. Blank by default across
    // a grid of unset cells, and still named for a screen reader.
    expect(box.textContent).toBe("");
    expect(box.textContent).not.toBe("—");
    expect(box.getAttribute("aria-label")).toBe("Cycle time");
  });

  it("a word can be put in the empty box where one cell needs the nudge", () => {
    render(<InlineEdit value="" ariaLabel="Cycle time" emptyLabel="Set" onSave={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Cycle time" }).textContent).toBe("Set");
  });

  it("a filled cell shows its value at rest", () => {
    render(<InlineEdit value="1.5 min" ariaLabel="Cycle time" onSave={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Cycle time" }).textContent).toBe("1.5 min");
  });

  it("opening seeds the box with the current value, so an untouched save is a no-op", () => {
    render(<InlineEdit value="1.5 min" ariaLabel="Cycle time" onSave={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Cycle time" }));
    expect(screen.getByRole("textbox", { name: "Cycle time" })).toHaveProperty("value", "1.5 min");
  });

  it("⭐ where the resting text carries a unit, the box opens with the NUMBER only", () => {
    // "1.5 min" at rest, beside a select already saying "min": the box must
    // hold "1.5". Otherwise the unit is stated twice, and clearing the box to
    // type a bare number reinterprets it against whatever the select says.
    render(
      <InlineEdit
        value="1.5 min"
        editValue="1.5"
        ariaLabel="Cycle time"
        onSave={vi.fn()}
        adornment={<span>min</span>}
      />,
    );
    expect(screen.getByRole("button", { name: "Cycle time" }).textContent).toBe("1.5 min");
    fireEvent.click(screen.getByRole("button", { name: "Cycle time" }));
    expect(screen.getByRole("textbox", { name: "Cycle time" })).toHaveProperty("value", "1.5");
  });

  it("⭐ Cancel is VISIBLE and closes without saving", () => {
    // The report: "if I open a box to enter a value and don't want to enter it
    // anymore, there is no way to close the box."
    const onSave = vi.fn();
    render(<InlineEdit value="90 s" ariaLabel="Cycle time" onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Cycle time" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Cycle time" }), {
      target: { value: "999" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSave).not.toHaveBeenCalled();
    // Back to rest, still showing the original value.
    expect(screen.getByRole("button", { name: "Cycle time" }).textContent).toBe("90 s");
  });

  it("Escape does the same, for anyone who reaches for it", () => {
    const onSave = vi.fn();
    render(<InlineEdit value="90 s" ariaLabel="Cycle time" onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Cycle time" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Cycle time" }), { key: "Escape" });
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cycle time" }).textContent).toBe("90 s");
  });

  it("Save commits what was typed, and Enter is the same as Save", () => {
    const onSave = vi.fn();
    const { rerender } = render(<InlineEdit value="" ariaLabel="Cycle time" onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Cycle time" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Cycle time" }), {
      target: { value: "90" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith("90");

    rerender(<InlineEdit value="" ariaLabel="Cycle time" onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Cycle time" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Cycle time" }), {
      target: { value: "120" },
    });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Cycle time" }), { key: "Enter" });
    expect(onSave).toHaveBeenLastCalledWith("120");
  });

  it("an emptied box saves the empty string — clearing is a real act", () => {
    const onSave = vi.fn();
    render(<InlineEdit value="90 s" ariaLabel="Cycle time" onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Cycle time" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Cycle time" }), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith("");
  });

  it("a cell nobody may edit offers no editor at all", () => {
    render(<InlineEdit value="" ariaLabel="Cycle time" disabled onSave={vi.fn()} />);
    const box = screen.getByRole("button", { name: "Cycle time" });
    expect(box).toHaveProperty("disabled", true);
    fireEvent.click(box);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("onOpen fires as the editor opens, so an adornment can be seeded", () => {
    const onOpen = vi.fn();
    render(
      <InlineEdit
        value="1.5 min"
        ariaLabel="Cycle time"
        onOpen={onOpen}
        onSave={vi.fn()}
        adornment={<span data-testid="unit">min</span>}
      />,
    );
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cycle time" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("unit")).toBeTruthy();
  });

  it("an error shows in both states, since a refused save closes the editor", () => {
    render(
      <InlineEdit value="" ariaLabel="Cycle time" error="Nothing was saved." onSave={vi.fn()} />,
    );
    expect(screen.getByText("Nothing was saved.")).toBeTruthy();
  });
});
