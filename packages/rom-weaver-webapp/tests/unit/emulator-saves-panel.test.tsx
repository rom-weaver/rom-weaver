// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { preloadCatalog } from "../../src/presentation/localization/index.ts";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
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
  parseEmulatorSaveFile: vi.fn(),
  readEmulatorSave: vi.fn(),
  triggerBrowserDownload: vi.fn(),
}));

vi.mock("../../src/storage/browser/emulator-saves.ts", () => ({
  createEmulatorSaveExport: mocks.createEmulatorSaveExport,
  deleteEmulatorSave: mocks.deleteEmulatorSave,
  importEmulatorSave: mocks.importEmulatorSave,
  importEmulatorSavePart: mocks.importEmulatorSavePart,
  listEmulatorSaves: mocks.listEmulatorSaves,
  parseEmulatorSaveFile: mocks.parseEmulatorSaveFile,
  readEmulatorSave: mocks.readEmulatorSave,
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
  mocks.parseEmulatorSaveFile.mockResolvedValue(SAVE);
  mocks.readEmulatorSave.mockResolvedValue(undefined);
});

const submitImportForm = () =>
  fireEvent.submit(screen.getByRole("button", { name: "Import" }).closest("form") as HTMLFormElement);

describe("EmulatorSavesPanel listing", () => {
  it("lists the stored saves with their fingerprint and part sizes", async () => {
    const { container } = render(<EmulatorSavesPanel />);

    await screen.findByText("Sample Game");
    expect(screen.getByText(`ROM SHA-1 ${SAVE.gameId}`)).toBeTruthy();
    expect(container.querySelector(".emulator-save-sizes")?.textContent).toBe("Save state 4.0 KB, in-game save 2.0 KB");
  });

  it("reports 'none' for a save that is missing a part", async () => {
    mocks.listEmulatorSaves.mockResolvedValue([{ ...SAVE, sram: undefined }]);
    const { container } = render(<EmulatorSavesPanel />);

    await screen.findByText("Sample Game");
    expect(container.querySelector(".emulator-save-sizes")?.textContent).toBe("Save state 4.0 KB, in-game save none");
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

describe("EmulatorSavesPanel dropped backups", () => {
  it("asks before importing each dropped backup, one at a time", async () => {
    const extracted = new Blob(["json"]);
    mocks.extractEmulatorSaveExport.mockResolvedValue(extracted);
    const zip = new File(["zip"], "a.rw-emulator-save.zip");
    const json = new File(["{}"], "b.rw-emulator-save.json");
    const request = { files: [zip, json], id: 1 };
    const onImportStarted = vi.fn();
    const view = render(<EmulatorSavesPanel importRequest={request} onImportStarted={onImportStarted} />);

    await screen.findByText("Import a.rw-emulator-save.zip");
    expect(onImportStarted).toHaveBeenCalledTimes(1);
    expect(mocks.importEmulatorSave).not.toHaveBeenCalled();
    expect((screen.getByLabelText("File type") as HTMLSelectElement).value).toBe("combined");

    submitImportForm();
    await waitFor(() => expect(mocks.importEmulatorSave).toHaveBeenCalledWith(extracted));
    await screen.findByText("Import b.rw-emulator-save.json");
    expect(mocks.importEmulatorSave).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("File type")).toBeNull();
    expect(mocks.importEmulatorSave).toHaveBeenCalledTimes(1);

    view.rerender(<EmulatorSavesPanel importRequest={request} onImportStarted={vi.fn()} />);
    expect(screen.queryByLabelText("File type")).toBeNull();
  });

  it("names the stored save a dropped backup would replace", async () => {
    mocks.readEmulatorSave.mockResolvedValue({ ...SAVE, label: "Stored Game" });
    const json = new File(["{}"], "b.rw-emulator-save.json");
    render(<EmulatorSavesPanel importRequest={{ files: [json], id: 1 }} />);

    expect(await screen.findByText(/replaces the stored save for Stored Game/)).toBeTruthy();
    expect(mocks.parseEmulatorSaveFile).toHaveBeenCalledWith(json);
    expect(mocks.readEmulatorSave).toHaveBeenCalledWith(SAVE.gameId);
  });

  it("shows no replace warning for a new game or an unreadable backup", async () => {
    mocks.parseEmulatorSaveFile.mockRejectedValue(new Error("Invalid save export"));
    render(<EmulatorSavesPanel importRequest={{ files: [new File(["x"], "bad.rw-emulator-save.json")], id: 1 }} />);
    await screen.findByText("Import bad.rw-emulator-save.json");
    await waitFor(() => expect(mocks.parseEmulatorSaveFile).toHaveBeenCalled());

    expect(screen.queryByText(/replaces the stored save/)).toBeNull();
    mocks.importEmulatorSave.mockRejectedValue(new Error("Invalid save export"));
    submitImportForm();
    expect((await screen.findByRole("alert")).textContent).toBe("Invalid save export");
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
    // Once to check which stored save it replaces, once to import it.
    expect(mocks.extractEmulatorSaveExport).toHaveBeenCalledTimes(2);
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

  it("warns when a raw part would replace the stored part for that SHA-1", async () => {
    mocks.readEmulatorSave.mockResolvedValue(SAVE);
    render(<EmulatorSavesPanel />);
    await screen.findByText("Sample Game");

    selectFile(new File(["sram"], "game.srm"));
    fireEvent.change(await screen.findByLabelText("ROM SHA-1"), { target: { value: "abc123" } });
    expect(screen.queryByText(/replaces the stored save/)).toBeNull();
    fireEvent.change(screen.getByLabelText("ROM SHA-1"), { target: { value: SAVE.gameId.toUpperCase() } });

    expect(await screen.findByText(/replaces the stored save for Sample Game/)).toBeTruthy();
    expect(mocks.readEmulatorSave).toHaveBeenCalledWith(SAVE.gameId);
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

describe("EmulatorSavesPanel in German", () => {
  it("translates the heading, row details, and actions", async () => {
    await preloadCatalog("de");
    render(
      <RomWeaverSettingsProvider settings={{ language: "de" }}>
        <EmulatorSavesPanel />
      </RomWeaverSettingsProvider>,
    );
    expect(await screen.findByText("Emulator-Spielstände")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Exportieren/u })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Löschen/u })).toBeTruthy();
    expect(screen.getByText(/Savestate: .* · SRAM: /u)).toBeTruthy();
  });
});
