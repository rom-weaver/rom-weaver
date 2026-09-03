// @vitest-environment happy-dom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TrimPatchFormView } from "../../src/public/react/trim-form-view.tsx";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";

const model = () => ({
  confirm: {
    body: "The original file is not changed.",
    cancelLabel: "Cancel",
    confirmLabel: "Trim ROM",
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
    open: false,
    title: "Trim this ROM?",
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

  it("renders staged source/output steps and opens the confirmation modal", () => {
    const confirm = {
      ...model().confirm,
      open: true,
    };
    const { container } = renderView({
      confirm,
      sourceEmpty: false,
    });
    expect(container.querySelectorAll(".step-num")).toHaveLength(3);
    expect(container.querySelector("#trim-builder-row-output")).toBeTruthy();
    expect(document.body.textContent).toContain("Trim this ROM?");
    const cancel = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Cancel"),
    );
    expect(cancel).toBeTruthy();
    fireEvent.click(cancel as HTMLButtonElement);
    expect(confirm.onCancel).toHaveBeenCalledOnce();
  });
});
