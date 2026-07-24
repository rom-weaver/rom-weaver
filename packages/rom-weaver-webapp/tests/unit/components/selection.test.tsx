// @vitest-environment happy-dom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SelectionCheckList, type SelectionItem } from "../../../src/public/react/components/ds/selection.tsx";

const items: SelectionItem[] = [
  { id: "patch-a", name: "patch-a.ips", selectable: true },
  { id: "patch-b", name: "patch-b.ips", selectable: true },
];

/** A fresh array carrying the same candidates - what the host form hands down on every progress tick. */
const sameItems = (): SelectionItem[] => items.map((item) => ({ ...item }));

const countChecked = (checkboxes: HTMLElement[]) =>
  checkboxes.filter((checkbox) => (checkbox as HTMLInputElement).checked).length;

const submitLabel = (count: number) => `Add ${count} patches`;

describe("SelectionCheckList", () => {
  it("selects all patches by default and can clear or restore them", () => {
    const onSubmit = vi.fn();
    const { getAllByRole, getByRole } = render(
      <SelectionCheckList items={items} onSubmit={onSubmit} submitLabel={submitLabel} />,
    );

    expect(getAllByRole("checkbox").every((checkbox) => (checkbox as HTMLInputElement).checked)).toBe(true);
    fireEvent.click(getByRole("button", { name: "Clear all" }));
    expect(getAllByRole("checkbox").every((checkbox) => !(checkbox as HTMLInputElement).checked)).toBe(true);

    fireEvent.click(getByRole("button", { name: "Select all" }));
    fireEvent.click(getByRole("button", { name: "Add 2 patches" }));
    expect(onSubmit).toHaveBeenCalledWith(["patch-a", "patch-b"]);
  });

  it("keeps unchecked patches unchecked while the host re-renders with an equivalent list", () => {
    const onSubmit = vi.fn();
    const { getAllByRole, getByRole, rerender } = render(
      <SelectionCheckList items={sameItems()} onSubmit={onSubmit} submitLabel={submitLabel} />,
    );

    fireEvent.click(getAllByRole("checkbox")[0] as HTMLElement);
    expect(countChecked(getAllByRole("checkbox"))).toBe(1);

    // Background work keeps ticking: same candidates, brand-new array identity every time.
    for (let tick = 0; tick < 3; tick += 1) {
      rerender(<SelectionCheckList items={sameItems()} onSubmit={onSubmit} submitLabel={submitLabel} />);
    }

    expect((getAllByRole("checkbox")[0] as HTMLInputElement).checked).toBe(false);
    expect(countChecked(getAllByRole("checkbox"))).toBe(1);
    fireEvent.click(getByRole("button", { name: "Add 1 patches" }));
    expect(onSubmit).toHaveBeenCalledWith(["patch-b"]);
  });

  it("re-seeds the selection when the candidate set itself changes", () => {
    const onSubmit = vi.fn();
    const { getAllByRole, rerender } = render(
      <SelectionCheckList items={sameItems()} onSubmit={onSubmit} submitLabel={submitLabel} />,
    );

    fireEvent.click(getAllByRole("checkbox")[0] as HTMLElement);
    expect(countChecked(getAllByRole("checkbox"))).toBe(1);

    rerender(
      <SelectionCheckList
        items={[...sameItems(), { id: "patch-c", name: "patch-c.ips", selectable: true }]}
        onSubmit={onSubmit}
        submitLabel={submitLabel}
      />,
    );

    expect(countChecked(getAllByRole("checkbox"))).toBe(3);
  });
});
