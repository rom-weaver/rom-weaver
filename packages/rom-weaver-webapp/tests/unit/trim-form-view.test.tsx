// @vitest-environment happy-dom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TrimPatchFormView } from "../../src/public/react/trim-form-view.tsx";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";

const model = () => ({
  warning: {
    body: "The original file is not changed.",
    dismissLabel: "Got it",
    onDismiss: vi.fn(),
    open: false,
    title: "Trimming this ROM",
  },
  dialog: <div data-testid="candidate-dialog">candidate selection</div>,
  dropZone: {
    addLabel: "Replace ROM",
    big: true,
    heroLabel: "Drop ROM",
    heroLabelCoarse: "Tap to add ROM",
    id: "trim-builder-row-unified-drop",
    inputId: "trim-builder-input-file-unified",
    onFiles: vi.fn(),
    supported: [],
  },
  output: {
    fileName: "trimmed.nes",
    format: "nes",
    formatOptions: [],
    id: "trim-builder-row-output",
    num: "0x03",
    title: "Trim",
  },
  sourceEmpty: true,
  sourceStep: { id: "trim-builder-row-source", items: [], num: "0x02", title: "ROM" },
});

const renderView = (overrides: Record<string, unknown> = {}) =>
  render(
    <RomWeaverSettingsProvider settings={{}}>
      <TrimPatchFormView {...({ ...model(), ...overrides } as never)} />
    </RomWeaverSettingsProvider>,
  );

describe("TrimPatchFormView", () => {
  it("renders the empty trim hero and ghost steps", () => {
    const { container } = renderView();
    expect(container.querySelector("#trim-builder-container")).toBeTruthy();
    expect(container.querySelector(".unified-drop-step--hero")).toBeTruthy();
    expect(container.querySelectorAll(".ghost-next-step")).toHaveLength(2);
    expect(container.querySelector("[data-testid=candidate-dialog]")).toBeTruthy();
    expect(container.querySelector("#trim-builder-row-output")).toBeNull();
  });

  it("renders staged source/output steps and an informational warning with a single dismiss action", () => {
    const warning = {
      ...model().warning,
      open: true,
    };
    const { container } = renderView({
      sourceEmpty: false,
      warning,
    });
    expect(container.querySelectorAll(".step-num")).toHaveLength(3);
    expect(container.querySelector("#trim-builder-row-output")).toBeTruthy();
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(document.getElementById(dialog.getAttribute("aria-labelledby") as string)?.textContent).toContain(
      "Trimming this ROM",
    );
    const buttons = Array.from(dialog.querySelectorAll(".c-actions button"));
    expect(buttons.map((button) => button.textContent)).toEqual(["Got it"]);
    fireEvent.click(buttons[0] as HTMLButtonElement);
    expect(warning.onDismiss).toHaveBeenCalledOnce();
  });
});
