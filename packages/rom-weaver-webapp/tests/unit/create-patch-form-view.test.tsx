// @vitest-environment happy-dom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CreatePatchFormView } from "../../src/public/react/create-patch-form-view.tsx";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";

const step = (num: string, title: string) => ({
  id: `step-${num}`,
  items: [],
  num,
  title,
});

const baseModel = () => ({
  dialog: <div data-testid="dialog">candidate dialog</div>,
  dropZone: {
    addLabel: "Add ROMs",
    big: true,
    heroLabel: "Drop ROMs",
    heroLabelCoarse: "Tap to add ROMs",
    id: "patch-builder-row-unified-drop",
    inputId: "patch-builder-input-file-unified",
    onFiles: vi.fn(),
    supported: [],
  },
  modifiedStep: step("0x03", "Modified"),
  originalStep: step("0x02", "Original"),
  output: {
    fileName: "game.bps",
    format: "bps",
    formatOptions: [],
    id: "patch-builder-row-output",
    num: "0x04",
    title: "Patch",
  },
  sourcesEmpty: true,
  swap: null,
});

const renderView = (overrides: Record<string, unknown> = {}) =>
  render(
    <RomWeaverSettingsProvider settings={{}}>
      <CreatePatchFormView {...({ ...baseModel(), ...overrides } as never)} />
    </RomWeaverSettingsProvider>,
  );

describe("CreatePatchFormView", () => {
  it("renders the empty create hero and ghost steps", () => {
    const { container } = renderView();
    expect(container.querySelector("#patch-builder-container")).toBeTruthy();
    expect(container.querySelector(".unified-drop-step--hero")).toBeTruthy();
    expect(container.querySelectorAll(".ghost-next-step")).toHaveLength(3);
    expect(container.querySelector("[data-testid=dialog]")).toBeTruthy();
    expect(container.querySelector("#patch-builder-row-output")).toBeNull();
  });

  it("renders staged source and output steps and forwards swap clicks", () => {
    const onSwap = vi.fn();
    const { container } = renderView({
      sourcesEmpty: false,
      swap: { disabled: false, onSwap },
    });
    expect(container.querySelectorAll(".step-num")).toHaveLength(4);
    expect(container.querySelector("#patch-builder-row-output")).toBeTruthy();
    fireEvent.click(container.querySelector("#patch-builder-button-swap-sources") as HTMLButtonElement);
    expect(onSwap).toHaveBeenCalledOnce();
  });

  it("hides the swap control when no swap model is supplied", () => {
    const { container } = renderView({
      sourcesEmpty: false,
      swap: null,
    });
    expect(container.querySelector("#patch-builder-button-swap-sources")).toBeNull();
  });
});
