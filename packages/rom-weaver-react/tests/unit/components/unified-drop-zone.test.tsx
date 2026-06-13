// @vitest-environment happy-dom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
        formats={["ips", "zip"]}
        inputId="rom-weaver-input-file-unified"
        label="Drop a ROM or patches"
        onFiles={() => undefined}
        patchHint="patches (.ips)"
        romHint="roms (.sfc)"
      />,
    );
    const step = container.querySelector("section.step.is-input.is-empty");
    expect(step).toBeTruthy();
    expect(step?.querySelector(".step-num")?.textContent).toBe("0x01");
    expect(step?.querySelector(".step-title")?.textContent).toBe("Inputs");
    expect(step?.querySelector(".drop.hero.bare")).toBeTruthy();
    expect(step?.querySelector(".hint")?.textContent).toBe("roms (.sfc) or patches (.ips)");
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
});
