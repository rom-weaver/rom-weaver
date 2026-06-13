// @vitest-environment happy-dom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Drawer, DrawerMark, DrawerReadout } from "../../../src/public/react/components/ds/drawer.tsx";

/**
 * Loom drawer contract: the `.cks` collapsible the whole card system is built
 * on. The open/close mechanics (is-open class + aria-expanded) are what the
 * browser tests and CSS animations key off, so they are pinned here.
 */

describe("Drawer", () => {
  it("renders the header label, readout chips, and collapsed body", () => {
    const { container } = render(
      <Drawer label="Checksums" readouts={<DrawerReadout time>1.2s</DrawerReadout>}>
        <div>rows</div>
      </Drawer>,
    );
    const root = container.querySelector(".cks");
    const head = container.querySelector("button.cks-head");
    expect(root).toBeTruthy();
    expect(root?.classList.contains("is-open")).toBe(false);
    expect(head?.getAttribute("aria-expanded")).toBe("false");
    expect(head?.textContent).toContain("Checksums");
    expect(container.querySelector(".readouts .rb.time")?.textContent).toBe("1.2s");
    // body stays in the DOM (CSS grid-rows collapse), wired via aria-controls
    const bodyId = head?.getAttribute("aria-controls") || "";
    expect(bodyId).toBeTruthy();
    expect(container.querySelector(".cks-body")?.id).toBe(bodyId);
  });

  it("toggles is-open + aria-expanded on header clicks (uncontrolled)", () => {
    const { container } = render(
      <Drawer label="Info">
        <div>rows</div>
      </Drawer>,
    );
    const head = container.querySelector("button.cks-head") as HTMLButtonElement;
    fireEvent.click(head);
    expect(container.querySelector(".cks")?.classList.contains("is-open")).toBe(true);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(head);
    expect(container.querySelector(".cks")?.classList.contains("is-open")).toBe(false);
  });

  it("respects a controlled open prop and reports toggles", () => {
    const onToggle = vi.fn();
    const { container, rerender } = render(
      <Drawer label="Info" onToggle={onToggle} open={false}>
        <div>rows</div>
      </Drawer>,
    );
    const head = container.querySelector("button.cks-head") as HTMLButtonElement;
    fireEvent.click(head);
    expect(onToggle).toHaveBeenCalledWith(true);
    // still closed until the owner flips the prop
    expect(container.querySelector(".cks")?.classList.contains("is-open")).toBe(false);
    rerender(
      <Drawer label="Info" onToggle={onToggle} open>
        <div>rows</div>
      </Drawer>,
    );
    expect(container.querySelector(".cks")?.classList.contains("is-open")).toBe(true);
  });

  it("marks verdicts with the ok/bad rb-mark", () => {
    const { container } = render(
      <Drawer label="Verify" readouts={<DrawerMark ok={false}>x</DrawerMark>}>
        <div />
      </Drawer>,
    );
    expect(container.querySelector(".rb-mark.bad")).toBeTruthy();
    expect(container.querySelector(".rb-mark.ok")).toBeNull();
  });
});
