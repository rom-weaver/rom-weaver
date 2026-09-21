// @vitest-environment happy-dom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RomInputPanels } from "../../../src/public/react/components/ds/rom-input-panels.tsx";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";

const identification = {
  matches: [
    {
      algorithm: "crc32",
      name: "Game",
      platform: "Nintendo - Game Boy Advance",
      variant: "raw",
    },
  ],
  status: "matched",
} as never;

const renderPanels = (detailedViewEnabled: boolean) =>
  render(
    <RomWeaverSettingsProvider settings={{ detailedViewEnabled }}>
      <RomInputPanels
        cue={{ cueText: 'FILE "game.bin" BINARY' }}
        identification={identification}
        info={{ bytes: 4, checksums: { crc32: "1234abcd" } }}
        platformTag="GBA"
      />
    </RomWeaverSettingsProvider>,
  );

describe("RomInputPanels view detail", () => {
  it("defaults to one Checks drawer with identification in its heading", () => {
    const { container } = renderPanels(false);
    expect(container.querySelectorAll(".cks")).toHaveLength(1);
    expect(container.querySelector(".identify-drawer")).toBeNull();
    expect(container.querySelector(".rw-cue-section")).toBeNull();
    expect(container.querySelector(".cks-head")?.textContent).toContain("Checks");
    expect(container.querySelector(".cks-head")?.textContent).toContain("GBA");
    expect(container.querySelector(".cks-head")?.textContent).toContain("Identified");
  });

  it("restores the separate identification and disc drawers in detailed view", () => {
    const { container } = renderPanels(true);
    expect(container.querySelector(".identify-drawer")).not.toBeNull();
    expect(container.querySelector(".rw-cue-section")).not.toBeNull();
    expect(container.querySelectorAll(".cks")).toHaveLength(3);
  });
});
