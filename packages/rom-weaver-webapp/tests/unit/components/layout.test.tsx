// @vitest-environment happy-dom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DropZone, InfoPopover, NeedsInput, StepSection } from "../../../src/public/react/components/ds/layout.tsx";

/**
 * Layout primitive contract: the numbered loom step head, the info popover
 * toggle, the needs-input directive, and the drop zone variants (hero with
 * format pills vs the compact add-row) over a hidden file input.
 */

describe("StepSection", () => {
  it("renders the hex step number, title, and meta chips", () => {
    const { container } = render(
      <StepSection meta={<span className="rb mono">1 file</span>} num="0x03" title="Patches">
        <div>body</div>
      </StepSection>,
    );
    const head = container.querySelector(".step .step-head");
    expect(head?.querySelector(".step-num")?.textContent).toBe("0x03");
    expect(head?.querySelector(".step-title")?.textContent).toBe("Patches");
    expect(head?.querySelector(".step-meta .rb")?.textContent).toBe("1 file");
    expect(container.querySelector(".step-body")?.textContent).toBe("body");
  });

  it("flags woven and faulted stages", () => {
    const { container } = render(
      <StepSection fault num="0x04" title="Weave" woven>
        <div />
      </StepSection>,
    );
    const step = container.querySelector(".step");
    expect(step?.classList.contains("is-woven")).toBe(true);
    expect(step?.classList.contains("is-fault")).toBe(true);
  });
});

describe("InfoPopover", () => {
  it("keeps the popover open until its info button is clicked again", () => {
    const { container } = render(
      <InfoPopover title="Input handling">
        <ul className="info-list">
          <li>point</li>
        </ul>
      </InfoPopover>,
    );
    const button = container.querySelector(".info .info-btn") as HTMLButtonElement;
    expect(document.body.querySelector(".info-pop")).toBeNull();
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(document.body.querySelector(".info-pop")).toBeTruthy();
    fireEvent.click(document.body);
    expect(document.body.querySelector(".info-pop")).toBeTruthy();
    fireEvent.click(button);
    expect(document.body.querySelector(".info-pop")).toBeNull();
  });
});

describe("NeedsInput", () => {
  it("is a quiet directive button", () => {
    const onClick = vi.fn();
    const { container } = render(<NeedsInput onClick={onClick}>Add a ROM in 0x01 above</NeedsInput>);
    const button = container.querySelector("button.needs-input") as HTMLButtonElement;
    expect(button.textContent).toContain("Add a ROM in 0x01 above");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("DropZone", () => {
  it("renders the hero variant with format pills and the hidden input", () => {
    const { container } = render(
      <DropZone
        big
        formats={["sfc", "nes", "ips", "bps"]}
        inputId="unit-drop-input"
        label="Drop a ROM or patches"
        onFiles={() => undefined}
      />,
    );
    const drop = container.querySelector("label.drop.hero");
    expect(drop).toBeTruthy();
    const lanes = Array.from(container.querySelectorAll(".formats-lane"));
    expect(lanes).toHaveLength(2);
    expect(
      lanes.map((lane) =>
        Array.from(lane.querySelectorAll(".formats-set:first-child .fmt")).map((pill) => pill.textContent),
      ),
    ).toEqual([
      ["sfc", "nes"],
      ["ips", "bps"],
    ]);
    expect(lanes.every((lane) => lane.querySelectorAll(".formats-set").length === 2)).toBe(true);
    const input = container.querySelector("input[type=file]") as HTMLInputElement;
    expect(input.id).toBe("unit-drop-input");
    expect(input.classList.contains("sr-only")).toBe(true);
  });

  it("renders the compact add-row (btnish) when not big and forwards picked files", () => {
    const onFiles = vi.fn();
    const { container } = render(<DropZone inputId="unit-add-input" label="Add more" onFiles={onFiles} />);
    expect(container.querySelector(".drop:not(.hero) .main.btnish")).toBeTruthy();
    const input = container.querySelector("input[type=file]") as HTMLInputElement;
    const file = new File(["x"], "a.ips");
    fireEvent.change(input, { target: { files: [file] } });
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles.mock.calls[0]?.[0]?.[0]?.name).toBe("a.ips");
  });

  it("repeats a short format list so its ticker cannot scroll fully out of view", () => {
    const { container } = render(
      <DropZone big formats={["rom", "ppf3"]} label="Drop files" onFiles={() => undefined} />,
    );
    const lanes = container.querySelectorAll(".formats-lane");
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.querySelectorAll(".formats-set:first-child .fmt")).toHaveLength(12);
    expect(lanes[0]?.querySelectorAll(".formats-set")).toHaveLength(2);
  });
});
