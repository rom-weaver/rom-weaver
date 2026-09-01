// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmulatorSavesPanel } from "../../src/webapp/components/emulator-saves-panel.tsx";
import type { EmulatorSaveRecord } from "../../src/storage/browser/emulator-saves.ts";

const mocks = vi.hoisted(() => ({
  compressEmulatorSaveExport: vi.fn(),
  createEmulatorSaveExport: vi.fn(),
  deleteEmulatorSave: vi.fn(),
  extractEmulatorSaveExport: vi.fn(),
  importEmulatorSave: vi.fn(),
  importEmulatorSavePart: vi.fn(),
  listEmulatorSaves: vi.fn(),
  triggerBrowserDownload: vi.fn(),
}));

vi.mock("../../src/storage/browser/emulator-saves.ts", () => ({
  createEmulatorSaveExport: mocks.createEmulatorSaveExport,
  deleteEmulatorSave: mocks.deleteEmulatorSave,
  importEmulatorSave: mocks.importEmulatorSave,
  importEmulatorSavePart: mocks.importEmulatorSavePart,
  listEmulatorSaves: mocks.listEmulatorSaves,
}));

vi.mock("../../src/storage/browser/emulator-save-export.ts", () => ({
  compressEmulatorSaveExport: mocks.compressEmulatorSaveExport,
  extractEmulatorSaveExport: mocks.extractEmulatorSaveExport,
}));

vi.mock("../../src/platform/browser/browser-download.ts", () => ({
  triggerBrowserDownload: mocks.triggerBrowserDownload,
}));

const SAVE: EmulatorSaveRecord = {
  gameId: "0123456789abcdef0123456789abcdef01234567",
  gameName: "0123456789abcdef0123456789abcdef01234567",
  label: "Sample Game",
  sram: new Uint8Array(2000),
  state: new Uint8Array(4000),
  updatedAt: 1,
};

const EXPORT_BLOB = { blob: new Blob(["export"]), fileName: "sample-game.rwsave.zip" };

const fileInput = () => document.querySelector<HTMLInputElement>('input[type="file"]');

const selectFile = (file: File) => {
  const input = fileInput();
  if (!input) throw new Error("The panel rendered no file input");
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  fireEvent.change(input);
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.listEmulatorSaves.mockResolvedValue([SAVE]);
  mocks.createEmulatorSaveExport.mockReturnValue(EXPORT_BLOB);
  mocks.compressEmulatorSaveExport.mockResolvedValue(EXPORT_BLOB);
  mocks.triggerBrowserDownload.mockResolvedValue(undefined);
  mocks.deleteEmulatorSave.mockResolvedValue(undefined);
  mocks.importEmulatorSave.mockResolvedValue(SAVE);
  mocks.importEmulatorSavePart.mockResolvedValue(SAVE);
});

describe("EmulatorSavesPanel listing", () => {
  it("lists the stored saves with their fingerprint and part sizes", async () => {
    const { container } = render(<EmulatorSavesPanel />);

    await screen.findByText("Sample Game");
    expect(screen.getByText(`ROM fingerprint · SHA-1 ${SAVE.gameId}`)).toBeTruthy();
    expect(container.querySelector(".emulator-save-sizes")?.textContent).toBe("State: 4.0 KB · SRAM: 2.0 KB");
  });

  it("reports 'none' for a save that is missing a part", async () => {
    mocks.listEmulatorSaves.mockResolvedValue([{ ...SAVE, sram: undefined }]);
    const { container } = render(<EmulatorSavesPanel />);

    await screen.findByText("Sample Game");
    expect(container.querySelector(".emulator-save-sizes")?.textContent).toBe("State: 4.0 KB · SRAM: none");
  });

  it("does not load anything while the panel is inactive", () => {
    render(<EmulatorSavesPanel active={false} />);

    expect(mocks.listEmulatorSaves).not.toHaveBeenCalled();
    expect(screen.getByText("No emulator saves yet")).toBeTruthy();
  });

  it("shows the empty state when nothing is stored", async () => {
    mocks.listEmulatorSaves.mockResolvedValue([]);
    render(<EmulatorSavesPanel />);

    await screen.findByText("No emulator saves yet");
  });

  it("surfaces a listing failure as an alert", async () => {
    mocks.listEmulatorSaves.mockRejectedValue(new Error("IndexedDB is blocked"));
    render(<EmulatorSavesPanel />);

    expect((await screen.findByRole("alert")).textContent).toBe("IndexedDB is blocked");
  });

  it("reloads the list when refresh is pressed", async () => {
    render(<EmulatorSavesPanel />);
    await screen.findByText("Sample Game");

    fireEvent.click(screen.getByLabelText("Refresh emulator saves"));

    await waitFor(() => expect(mocks.listEmulatorSaves).toHaveBeenCalledTimes(2));
  });
});

describe("EmulatorSavesPanel export", () => {
  it("compresses and downloads the save", async () => {
    render(<EmulatorSavesPanel />);
    await screen.findByText("Sample Game");

    fireEvent.click(screen.getByRole("button", { name: /Export/ }));

    await waitFor(() => expect(mocks.triggerBrowserDownload).toHaveBeenCalledTimes(1));
    expect(mocks.createEmulatorSaveExport).toHaveBeenCalledWith(SAVE);
    expect(mocks.triggerBrowserDownload).toHaveBeenCalledWith(EXPORT_BLOB.blob, EXPORT_BLOB.fileName, {
      interactive: true,
    });
  });

  it("keeps the compressed export for a retry when the download is refused", async () => {
    mocks.triggerBrowserDownload.mockRejectedValueOnce(new Error("Download was blocked"));
    render(<EmulatorSavesPanel />);
    await screen.findByText("Sample Game");

    fireEvent.click(screen.getByRole("button", { name: /Export/ }));

    expect((await screen.findByRole("alert")).textContent).toBe("Download was blocked");
    const retry = await screen.findByRole("button", { name: /Download/ });

    fireEvent.click(retry);

    await waitFor(() => expect(mocks.triggerBrowserDownload).toHaveBeenCalledTimes(2));
    expect(mocks.compressEmulatorSaveExport).toHaveBeenCalledTimes(1);
  });
});

describe("EmulatorSavesPanel delete", () => {
  it("deletes the save and refreshes the list", async () => {
    render(<EmulatorSavesPanel />);
    await screen.findByText("Sample Game");

    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));

    await waitFor(() => expect(mocks.listEmulatorSaves).toHaveBeenCalledTimes(2));
    expect(mocks.deleteEmulatorSave).toHaveBeenCalledWith(SAVE.gameId);
  });

  it("surfaces a delete failure as an alert", async () => {
    mocks.deleteEmulatorSave.mockRejectedValue(new Error("Save is locked"));
    render(<EmulatorSavesPanel />);
    await screen.findByText("Sample Game");

    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));

    expect((await screen.findByRole("alert")).textContent).toBe("Save is locked");
  });
});

describe("EmulatorSavesPanel import", () => {
  it("opens the hidden file picker from the import button", async () => {
    render(<EmulatorSavesPanel />);
    await screen.findByText("Sample Game");
    const input = fileInput();
    if (!input) throw new Error("The panel rendered no file input");
    const click = vi.spyOn(input, "click").mockImplementation(() => undefined);

    fireEvent.click(screen.getByRole("button", { name: /Import save/ }));

    expect(click).toHaveBeenCalledTimes(1);
  });

  it("classifies a zip as a rom-weaver export and unpacks it before importing", async () => {
    mocks.extractEmulatorSaveExport.mockResolvedValue(new Blob(["json"]));
    render(<EmulatorSavesPanel />);
    await screen.findByText("Sample Game");

    selectFile(new File(["zip"], "backup.zip", { type: "application/zip" }));
    await screen.findByText("backup.zip", { exact: false });
    expect(screen.queryByLabelText("ROM SHA-1")).toBeNull();

    fireEvent.submit(screen.getByRole("button", { name: "Import" }).closest("form") as HTMLFormElement);

    await waitFor(() => expect(mocks.importEmulatorSave).toHaveBeenCalledTimes(1));
    expect(mocks.extractEmulatorSaveExport).toHaveBeenCalledTimes(1);
    expect(mocks.listEmulatorSaves).toHaveBeenCalledTimes(2);
  });

  it("imports a json export without unpacking it", async () => {
    render(<EmulatorSavesPanel />);
    await screen.findByText("Sample Game");
    const file = new File(["{}"], "backup.json", { type: "application/json" });

    selectFile(file);
    fireEvent.submit(screen.getByRole("button", { name: "Import" }).closest("form") as HTMLFormElement);

    await waitFor(() => expect(mocks.importEmulatorSave).toHaveBeenCalledWith(file));
    expect(mocks.extractEmulatorSaveExport).not.toHaveBeenCalled();
  });

  it("classifies a save state and requires the ROM SHA-1 before importing", async () => {
    render(<EmulatorSavesPanel />);
    await screen.findByText("Sample Game");
    const file = new File(["state"], "game.state");

    selectFile(file);
    const submit = await screen.findByRole("button", { name: "Import" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("File type") as HTMLSelectElement).value).toBe("state");

    fireEvent.change(screen.getByLabelText("ROM SHA-1"), { target: { value: "abc123" } });
    expect((screen.getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.submit(submit.closest("form") as HTMLFormElement);

    await waitFor(() =>
      expect(mocks.importEmulatorSavePart).toHaveBeenCalledWith({ data: file, part: "state", sha1: "abc123" }),
    );
  });

  it("defaults an unrecognized extension to SRAM", async () => {
    render(<EmulatorSavesPanel />);
    await screen.findByText("Sample Game");

    selectFile(new File(["sram"], "game.srm"));

    expect(((await screen.findByLabelText("File type")) as HTMLSelectElement).value).toBe("sram");
    expect(screen.getByLabelText("ROM SHA-1")).toBeTruthy();
  });

  it("closes the import form on cancel", async () => {
    render(<EmulatorSavesPanel />);
    await screen.findByText("Sample Game");

    selectFile(new File(["sram"], "game.srm"));
    fireEvent.change(await screen.findByLabelText("ROM SHA-1"), { target: { value: "abc123" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByLabelText("File type")).toBeNull();
  });

  it("keeps the import form open and reports the reason when the import fails", async () => {
    mocks.importEmulatorSavePart.mockRejectedValue("sha1 does not match any ROM");
    render(<EmulatorSavesPanel />);
    await screen.findByText("Sample Game");

    selectFile(new File(["sram"], "game.srm"));
    fireEvent.change(await screen.findByLabelText("ROM SHA-1"), { target: { value: "abc123" } });
    fireEvent.submit(screen.getByRole("button", { name: "Import" }).closest("form") as HTMLFormElement);

    expect((await screen.findByRole("alert")).textContent).toBe("sha1 does not match any ROM");
    expect(screen.getByLabelText("File type")).toBeTruthy();
  });

  it("ignores a change event that selected no file", async () => {
    render(<EmulatorSavesPanel />);
    await screen.findByText("Sample Game");
    const input = fileInput();
    if (!input) throw new Error("The panel rendered no file input");

    fireEvent.change(input);

    expect(screen.queryByLabelText("File type")).toBeNull();
  });
});
