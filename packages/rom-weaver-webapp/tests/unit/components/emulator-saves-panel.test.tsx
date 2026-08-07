// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EmulatorSavesPanel } from "../../../src/webapp/components/emulator-saves-panel.tsx";

const mocks = vi.hoisted(() => ({
  createEmulatorSaveExport: vi.fn(),
  deleteEmulatorSave: vi.fn(),
  importEmulatorSave: vi.fn(),
  listEmulatorSaves: vi.fn(),
  readEmulatorSave: vi.fn(),
  subscribeEmulatorSaves: vi.fn(() => () => undefined),
}));

vi.mock("../../../src/storage/browser/emulator-saves.ts", () => ({
  ...mocks,
}));

vi.mock("../../../src/platform/browser/browser-download.ts", () => ({
  triggerBrowserDownload: vi.fn(),
}));

const save = {
  gameId: "rom-weaver-nes",
  gameName: "rom-weaver-nes",
  label: "game.nes",
  sram: new Uint8Array([1, 2]),
  state: new Uint8Array([3, 4, 5]),
  updatedAt: 1,
};

describe("EmulatorSavesPanel", () => {
  it("renders a game and exports its state and SRAM as one file", async () => {
    mocks.listEmulatorSaves.mockResolvedValue([save]);
    mocks.readEmulatorSave.mockResolvedValue(save);
    mocks.createEmulatorSaveExport.mockReturnValue({ blob: new Blob(["save"]), fileName: "game.json" });

    render(<EmulatorSavesPanel />);

    expect(await screen.findByText("game.nes")).toBeTruthy();
    expect(screen.getByText("State: 3 B · SRAM: 2 B")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /export/i }));

    await waitFor(() => expect(mocks.createEmulatorSaveExport).toHaveBeenCalledWith(save));
  });

  it("shows an empty state when storage has no games", async () => {
    mocks.listEmulatorSaves.mockResolvedValue([]);

    render(<EmulatorSavesPanel />);

    expect(await screen.findByText("No saved states or SRAM yet.")).toBeTruthy();
  });
});
