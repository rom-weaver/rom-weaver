// @vitest-environment happy-dom
import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InfoToggle } from "../../../src/presentation/react/info-toggle.tsx";

/**
 * The portaled (position:fixed) popover lives inside scrollable panels, so it must
 * recompute its position on scroll/resize. Scroll events don't bubble, hence the
 * capture-phase listener — and both listeners must be torn down when it closes.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe("InfoToggle portaled popover repositioning", () => {
  it("registers capture-phase scroll + resize listeners while open and removes them on close", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { container } = render(
      <InfoToggle ariaLabel="More info" portalPanel title="info">
        body copy
      </InfoToggle>,
    );

    const trigger = container.querySelector("button.info-btn") as HTMLButtonElement;
    fireEvent.click(trigger);

    const scrollAdd = addSpy.mock.calls.find(([type, , opts]) => type === "scroll" && opts === true);
    const resizeAdd = addSpy.mock.calls.find(([type]) => type === "resize");
    expect(scrollAdd).toBeTruthy();
    expect(resizeAdd).toBeTruthy();

    fireEvent.click(trigger);
    const scrollRemove = removeSpy.mock.calls.find(([type, , opts]) => type === "scroll" && opts === true);
    const resizeRemove = removeSpy.mock.calls.find(([type]) => type === "resize");
    expect(scrollRemove).toBeTruthy();
    expect(resizeRemove).toBeTruthy();
  });

  it("does not register window repositioning listeners for the non-portaled popover", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const { container } = render(
      <InfoToggle ariaLabel="More info" title="info">
        body copy
      </InfoToggle>,
    );
    fireEvent.click(container.querySelector("button.info-btn") as HTMLButtonElement);
    expect(addSpy.mock.calls.some(([type]) => type === "scroll")).toBe(false);
    expect(addSpy.mock.calls.some(([type]) => type === "resize")).toBe(false);
  });
});
