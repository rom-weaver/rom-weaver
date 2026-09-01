// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EmulatorSavesPanel } from "../../../src/webapp/components/emulator-saves-panel.tsx";

vi.mock("../../../src/storage/browser/emulator-saves.ts", () => ({
  createEmulatorSaveExport: vi.fn(),
  deleteEmulatorSave: vi.fn(),
  importEmulatorSave: vi.fn(),
  importEmulatorSavePart: vi.fn(),
  listEmulatorSaves: vi.fn(async () => []),
}));
vi.mock("../../../src/storage/browser/emulator-save-export.ts", () => ({
  compressEmulatorSaveExport: vi.fn(),
  extractEmulatorSaveExport: vi.fn(),
}));
vi.mock("../../../src/platform/browser/browser-download.ts", () => ({ triggerBrowserDownload: vi.fn() }));

const stageImport = (container: HTMLElement, fileName: string) => {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(["save"], fileName)] } });
};

describe("EmulatorSavesPanel", () => {
  it("keeps the panel mounted when the file-type dropdown changes", () => {
    const { container } = render(<EmulatorSavesPanel />);
    stageImport(container, "game.srm");

    const kind = screen.getByLabelText("File type") as HTMLSelectElement;
    expect(kind.value).toBe("sram");

    // The handler used to read `event.currentTarget` inside the lazy state
    // updater, which React had already nulled by the time it ran.
    fireEvent.change(kind, { target: { value: "state" } });

    expect((screen.getByLabelText("File type") as HTMLSelectElement).value).toBe("state");
    expect(screen.getByText("Import game.srm")).toBeTruthy();
    expect(screen.queryByLabelText("ROM SHA-1")).toBeTruthy();
  });

  it("drops the ROM SHA-1 field once the type is the combined export", () => {
    const { container } = render(<EmulatorSavesPanel />);
    stageImport(container, "game.srm");

    fireEvent.change(screen.getByLabelText("File type"), { target: { value: "combined" } });

    expect((screen.getByLabelText("File type") as HTMLSelectElement).value).toBe("combined");
    expect(screen.queryByLabelText("ROM SHA-1")).toBeNull();
  });
});
