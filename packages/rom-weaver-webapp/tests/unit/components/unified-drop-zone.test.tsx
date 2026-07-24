// @vitest-environment happy-dom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UnifiedDropZone } from "../../../src/public/react/components/ds/unified-drop-zone.tsx";

/**
 * The 0x01 INPUTS step contract: hero vs add-row state classes, the composed
 * hint line, and the stable unified input id every workflow's tests upload
 * through.
 */

describe("UnifiedDropZone", () => {
  it("renders the empty-state hero as the 0x01 Inputs step", () => {
    const { container } = render(
      <UnifiedDropZone
        big
        inputId="rom-weaver-input-file-unified"
        label="Drop a ROM or patches"
        onFiles={() => undefined}
        supported={[
          { extensions: ["sfc", "nes"], label: "ROMs" },
          { extensions: ["ips", "zip"], label: "Patches and archives" },
        ]}
      />,
    );
    const step = container.querySelector("section.step.is-input.is-empty");
    expect(step).toBeTruthy();
    expect(step?.querySelector(".step-num")?.textContent).toBe("0x01");
    expect(step?.querySelector(".step-title")?.textContent).toBe("Inputs");
    expect(step?.querySelector(".drop.hero.bare")).toBeTruthy();
    expect(
      Array.from(step?.querySelectorAll(".formats-set:first-child .fmt") || []).map((pill) => pill.textContent),
    ).toEqual(["sfc", "nes", "ips", "zip"]);
    expect(step?.querySelector(".hint")).toBeNull();
    expect(step?.querySelector("input[type=file]")?.id).toBe("rom-weaver-input-file-unified");
  });

  it("shrinks to the add-row once content is staged", () => {
    const { container } = render(
      <UnifiedDropZone inputId="rom-weaver-input-file-unified" label="Add more" onFiles={() => undefined} />,
    );
    const step = container.querySelector("section.step.is-input");
    expect(step?.classList.contains("is-empty")).toBe(false);
    expect(step?.querySelector(".drop.hero")).toBeNull();
    expect(step?.querySelector(".drop .main.btnish")).toBeTruthy();
  });

  it("can omit the hero accent", () => {
    const { container } = render(
      <UnifiedDropZone
        big
        inputId="rom-weaver-input-file-unified"
        label="Drop files"
        onFiles={() => undefined}
        showLeadAccent={false}
      />,
    );
    expect(container.querySelector(".lead-accent")).toBeNull();
  });

  it("opens the existing file input from the Inputs heading action", () => {
    const { container } = render(
      <UnifiedDropZone inputId="rom-weaver-input-file-unified" label="Add more" onFiles={() => undefined} />,
    );
    const input = container.querySelector("input[type=file]") as HTMLInputElement;
    const click = vi.spyOn(input, "click");
    fireEvent.click(container.querySelector(".step-head-action") as HTMLButtonElement);
    expect(click).toHaveBeenCalledTimes(1);
  });
});
