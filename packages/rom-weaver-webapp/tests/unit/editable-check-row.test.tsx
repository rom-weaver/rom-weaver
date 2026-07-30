// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EditableCheckRow } from "../../src/public/react/apply-patch-list-step.tsx";

/**
 * The row is edit-in-place so iOS never focuses a sub-16px text field (Safari zooms the
 * page in when that happens, and a 40-character SHA-1 does not fit at 16px on a phone).
 * These assert the arrangement that buys that: no field until the user asks for one, and
 * focus arriving only after it is mounted.
 */

const SHA1 = "7B2A68E28BEB293F2680317EF71D9531AB0C0DE1";

const renderRow = (overrides: Partial<Parameters<typeof EditableCheckRow>[0]> = {}) => {
  const onCommit = vi.fn();
  const onRemove = vi.fn();
  const utils = render(
    <EditableCheckRow
      field="sha1"
      id="check-sha1"
      invalid={false}
      onCommit={onCommit}
      onRemove={onRemove}
      value={SHA1}
      {...overrides}
    />,
  );
  return { onCommit, onRemove, ...utils };
};

describe("EditableCheckRow", () => {
  it("shows the value without mounting a field", () => {
    const { container } = renderRow();
    expect(container.querySelector("input")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit SHA-1 check" }).textContent).toBe(SHA1);
  });

  it("mounts the field only once the user opens it, and hands it focus", () => {
    const { container } = renderRow();
    fireEvent.click(screen.getByRole("button", { name: "Edit SHA-1 check" }));
    const input = container.querySelector("input");
    expect(input).not.toBeNull();
    expect(input?.value).toBe(SHA1);
    // Focus must land after the mount - a field focused before it exists at the floor
    // is exactly the case that zooms iOS.
    expect(document.activeElement).toBe(input);
  });

  it("keeps the field out of the iOS floor's exemptions", () => {
    const { container } = renderRow();
    fireEvent.click(screen.getByRole("button", { name: "Edit SHA-1 check" }));
    expect(container.querySelector("input")?.className).not.toContain("meta-target-select");
  });

  it("commits and returns to text on blur", () => {
    const { container, onCommit } = renderRow();
    fireEvent.click(screen.getByRole("button", { name: "Edit SHA-1 check" }));
    const input = container.querySelector("input");
    if (!input) throw new Error("the field did not mount");
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith("abc");
    expect(container.querySelector("input")).toBeNull();
  });

  it("opens as a field when there is no value to show", () => {
    const { container } = renderRow({ value: "" });
    expect(container.querySelector("input")).not.toBeNull();
  });

  it("stays open when a blur leaves the value empty", () => {
    const { container, onCommit } = renderRow({ value: "" });
    const input = container.querySelector("input");
    if (!input) throw new Error("the field did not mount");
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith("");
    expect(container.querySelector("input")).not.toBeNull();
  });

  it("does not steal focus for a row it did not just open", () => {
    const { container } = renderRow({ value: "" });
    expect(document.activeElement).not.toBe(container.querySelector("input"));
  });
});

describe("EditableCheckRow, malformed value", () => {
  it("keeps the field so the value can be corrected", () => {
    const { container } = render(
      <EditableCheckRow field="crc32" id="c" invalid onCommit={vi.fn()} onRemove={vi.fn()} value="nothex!!" />,
    );
    const input = container.querySelector("input");
    expect(input).not.toBeNull();
    expect(input?.getAttribute("aria-invalid")).toBe("true");
  });
});
