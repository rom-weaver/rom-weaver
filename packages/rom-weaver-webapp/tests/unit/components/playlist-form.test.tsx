// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { planBrowserPlaylist } from "../../../src/platform/browser/browser-playlist-api.ts";
import { preloadCatalog } from "../../../src/presentation/localization/index.ts";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";
import { PlaylistForm } from "../../../src/webapp/components/playlist-form.tsx";
import { isFilePickerOpen } from "../../../src/webapp/file-picker-state.ts";

const support = vi.hoisted(() => ({
  canWrite: false,
  renameFolder: vi.fn(async () => undefined),
  writeZip: vi.fn(),
}));

const PLAN = {
  bundle: [],
  discs: [
    { game: "Game", path: "Game (Disc 1).cue" },
    { game: "Game", path: "Game (Disc 2).cue" },
  ],
  entries: ["Game (Disc 1).cue", "Game (Disc 2).cue"],
  file_name: "Game.m3u",
  renames: [],
  text: "Game (Disc 1).cue\nGame (Disc 2).cue\n",
};

vi.mock("../../../src/platform/browser/browser-playlist-api.ts", () => ({
  planBrowserPlaylist: vi.fn(async () => PLAN),
  writeBrowserPlaylistZip: support.writeZip,
}));
vi.mock("../../../src/storage/browser/playlist-folder-write.ts", () => ({
  renamePlaylistFolder: support.renameFolder,
  requestPlaylistFolderAccess: vi.fn(async () => undefined),
}));
vi.mock("../../../src/storage/browser/playlist-folder-support.ts", () => ({
  canWritePlaylistFolders: () => support.canWrite,
}));

const dropDiscs = async () => {
  fireEvent.change(screen.getByLabelText("Drop the discs of one game"), {
    target: {
      files: [new File(["two"], "Game (Disc 2).cue"), new File(["one"], "Game (Disc 1).cue")],
    },
  });
  const download = await screen.findByRole("button", { name: "Download Game.zip" });
  await waitFor(() => expect((download as HTMLButtonElement).disabled).toBe(false));
  return download;
};

type FolderTree = { [name: string]: string | FolderTree };

/** A folder from the directory picker; each string is a file's text. */
const folderHandle = (name: string, tree: FolderTree): FileSystemDirectoryHandle =>
  ({
    kind: "directory",
    name,
    values: async function* () {
      for (const [entry, value] of Object.entries(tree)) {
        yield typeof value === "string"
          ? { getFile: async () => new File([value], entry), kind: "file", name: entry }
          : folderHandle(entry, value);
      }
    },
  }) as unknown as FileSystemDirectoryHandle;

beforeEach(() => {
  vi.mocked(planBrowserPlaylist).mockImplementation(async () => PLAN);
  support.canWrite = false;
  support.writeZip.mockReset();
  support.renameFolder.mockClear();
});

const zipOutput = () => ({ dispose: vi.fn(async () => undefined), saveAs: vi.fn(async () => undefined) });

describe("PlaylistForm", () => {
  it("downloads the discs as they are in a ZIP, in a browser that cannot change folders", async () => {
    const output = zipOutput();
    support.writeZip.mockResolvedValue(output);
    render(<PlaylistForm onSessionChange={vi.fn()} />);
    const download = await dropDiscs();

    expect(screen.getByText("Game (Disc 1).cue")).toBeTruthy();
    expect(screen.getByText("Game (Disc 2).cue")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save into folder" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: /Rename the discs/ }) as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByText(/In any browser, you can download a ZIP/)).toBeTruthy();

    expect(screen.queryByRole("button", { name: /\.m3u$/ })).toBeNull();

    fireEvent.click(download);
    await screen.findByText("Downloaded Game.zip");
    expect(support.writeZip).toHaveBeenCalledWith(
      expect.objectContaining({ zip: { chd: false, layout: "flat", rename: false } }),
    );
    expect(output.saveAs).toHaveBeenCalledWith({ fileName: "Game.zip", interactive: true });
  });

  it("asks for the game's folder before saving into it or renaming in Chrome and Edge", async () => {
    support.canWrite = true;
    render(<PlaylistForm onSessionChange={vi.fn()} />);
    await dropDiscs();

    expect(screen.getByText("Open the game's folder to save the playlist into it or rename its discs.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save into folder" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/In any browser, you can download a ZIP/)).toBeNull();
  });

  it("waits for the new plan before offering the ZIP after the name changes", async () => {
    render(<PlaylistForm onSessionChange={vi.fn()} />);
    const download = await dropDiscs();

    fireEvent.change(screen.getByLabelText("Game name"), { target: { value: "Final Fantasy VII" } });
    expect((download as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect((download as HTMLButtonElement).disabled).toBe(false));
  });

  it("goes back to the ZIP when the next folder keeps its discs in subfolders", async () => {
    support.canWrite = true;
    const folders = [
      folderHandle("A", { "Game (Disc 1).cue": "one", "Game (Disc 2).cue": "two" }),
      folderHandle("B", { "Disc 1": { "Game (Disc 1).cue": "one" }, "Disc 2": { "Game (Disc 2).cue": "two" } }),
    ];
    Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: async () => folders.shift() });
    vi.mocked(planBrowserPlaylist).mockImplementation(async ({ files }) => ({
      ...PLAN,
      discs: files.map((entry) => ({ game: "Game", path: entry.path })),
      entries: files.map((entry) => entry.path),
    }));
    try {
      render(<PlaylistForm onSessionChange={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: "Open game folder" }));
      const renameDiscs = await screen.findByRole("checkbox", { name: /Rename the discs/ });
      await waitFor(() => expect((renameDiscs as HTMLInputElement).disabled).toBe(false));
      fireEvent.click(renameDiscs);
      await screen.findByRole("button", { name: "Rename discs and save playlist" });

      fireEvent.click(screen.getByRole("button", { name: "Open game folder" }));
      await screen.findByText("Disc 2/Game (Disc 2).cue");
      await waitFor(() => expect(screen.queryByRole("button", { name: "Rename discs and save playlist" })).toBeNull());
      expect(screen.getByRole("button", { name: "Download Game.zip" })).toBeTruthy();
      expect((screen.getByRole("checkbox", { name: /Rename the discs/ }) as HTMLInputElement).checked).toBe(false);
    } finally {
      Reflect.deleteProperty(window, "showDirectoryPicker");
    }
  });

  it.each([
    [1, "Renamed 1 file and saved Game.m3u in A"],
    [2, "Renamed 2 files and saved Game.m3u in A"],
  ])("renames the discs where they are and counts %i changed file(s)", async (count, message) => {
    support.canWrite = true;
    const folder = folderHandle("A", { "Game (Disc 1).cue": "one", "Game (Disc 2).cue": "two" });
    Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: async () => folder });
    const renames = [
      { from: "Game CD1.cue", to: "Game (Disc 1).cue" },
      { from: "Game CD2.cue", to: "Game (Disc 2).cue" },
    ].slice(0, count);
    vi.mocked(planBrowserPlaylist).mockImplementation(async ({ renameInPlace }) =>
      renameInPlace ? { ...PLAN, renames } : PLAN,
    );
    try {
      render(<PlaylistForm onSessionChange={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: "Open game folder" }));
      const renameDiscs = await screen.findByRole("checkbox", { name: /Rename the discs/ });
      await waitFor(() => expect((renameDiscs as HTMLInputElement).disabled).toBe(false));
      fireEvent.click(renameDiscs);
      const rename = await screen.findByRole("button", { name: "Rename discs and save playlist" });
      await waitFor(() => expect((rename as HTMLButtonElement).disabled).toBe(false));

      fireEvent.click(rename);
      await screen.findByText(message);
      expect(support.renameFolder).toHaveBeenCalledWith(expect.objectContaining({ renames }));
    } finally {
      Reflect.deleteProperty(window, "showDirectoryPicker");
    }
  });

  it("renames into a ZIP instead when the chosen game keeps its discs in subfolders", async () => {
    support.canWrite = true;
    const discs = [
      { game: "X", path: "X (Disc 1).cue" },
      { game: "X", path: "X (Disc 2).cue" },
      { game: "Y", path: "Y/Y (Disc 1).cue" },
      { game: "Y", path: "Y/Y (Disc 2).cue" },
    ];
    const folder = folderHandle("A", {
      "X (Disc 1).cue": "one",
      "X (Disc 2).cue": "two",
      Y: { "Y (Disc 1).cue": "one", "Y (Disc 2).cue": "two" },
    });
    Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: async () => folder });
    vi.mocked(planBrowserPlaylist).mockImplementation(async ({ discs: chosen }) => {
      const picked = chosen ? discs.filter((disc) => chosen.includes(disc.path)) : discs;
      return { ...PLAN, discs: picked, entries: picked.map((disc) => disc.path) };
    });
    try {
      render(<PlaylistForm onSessionChange={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: "Open game folder" }));
      const renameDiscs = await screen.findByRole("checkbox", { name: /Rename the discs/ });
      await waitFor(() => expect((renameDiscs as HTMLInputElement).disabled).toBe(false));
      fireEvent.click(renameDiscs);
      await screen.findByRole("button", { name: "Rename discs and save playlist" });

      fireEvent.change(screen.getAllByRole("combobox")[0] as HTMLElement, { target: { value: "Y" } });
      await screen.findByText("Y/Y (Disc 2).cue");
      await screen.findByRole("button", { name: "Download Game.zip" });
      expect(screen.queryByRole("button", { name: "Rename discs and save playlist" })).toBeNull();
      const checkbox = screen.getByRole("checkbox", { name: /Rename the discs/ }) as HTMLInputElement;
      expect(checkbox.checked).toBe(true);
    } finally {
      Reflect.deleteProperty(window, "showDirectoryPicker");
    }
  });

  it("downloads a ZIP with the discs renamed and arranged as chosen, and keeps it for the download", async () => {
    const output = zipOutput();
    support.writeZip.mockResolvedValue(output);
    vi.mocked(planBrowserPlaylist).mockImplementation(async ({ zip }) =>
      zip
        ? {
            ...PLAN,
            bundle: [{ path: "Game.m3u/Game.m3u" }, { path: "Game.m3u/Game (Disc 1).cue", source: "Game CD1.cue" }],
          }
        : PLAN,
    );
    const { unmount } = render(<PlaylistForm onSessionChange={vi.fn()} />);
    await dropDiscs();

    fireEvent.click(screen.getByRole("checkbox", { name: /Rename the discs/ }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "m3u-folder" } });
    expect(await screen.findByText("Game.m3u/Game (Disc 1).cue")).toBeTruthy();
    await waitFor(() =>
      expect(planBrowserPlaylist).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Game", zip: { chd: false, layout: "m3u-folder", rename: true } }),
      ),
    );
    expect(screen.getByText("← Game CD1.cue")).toBeTruthy();
    const download = screen.getByRole("button", { name: "Download Game.zip" });
    await waitFor(() => expect((download as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(download);
    await screen.findByText("Downloaded Game.zip");
    expect(support.writeZip).toHaveBeenCalledWith(
      expect.objectContaining({
        discs: ["Game (Disc 1).cue", "Game (Disc 2).cue"],
        name: "Game",
        zip: { chd: false, layout: "m3u-folder", rename: true },
      }),
    );
    expect(output.saveAs).toHaveBeenCalledWith({ fileName: "Game.zip", interactive: true });
    // The browser reads the saved file while it downloads. The ZIP stays until the page lets go of it.
    expect(output.dispose).not.toHaveBeenCalled();
    unmount();
    expect(output.dispose).toHaveBeenCalledTimes(1);
  });

  it("compresses the discs to CHD in a ZIP, even where the discs could be renamed in place", async () => {
    support.canWrite = true;
    support.writeZip.mockResolvedValue(zipOutput());
    const folder = folderHandle("Game", { "Game (Disc 1).cue": "one", "Game (Disc 2).cue": "two" });
    Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: async () => folder });
    vi.mocked(planBrowserPlaylist).mockImplementation(async ({ zip }) =>
      zip?.chd
        ? {
            ...PLAN,
            bundle: [{ path: "Game.m3u" }, { path: "Game (Disc 1).chd", source: "Game (Disc 1).cue" }],
            entries: ["Game (Disc 1).chd", "Game (Disc 2).chd"],
          }
        : PLAN,
    );
    try {
      render(<PlaylistForm onSessionChange={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: "Open game folder" }));
      const chd = await screen.findByRole("checkbox", { name: "Compress the discs to CHD" });
      await screen.findByRole("button", { name: "Save into folder" });

      fireEvent.click(chd);
      expect(await screen.findByText("Game (Disc 2).chd")).toBeTruthy();
      expect(screen.getByText("← Game (Disc 1).cue")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Save into folder" })).toBeNull();
      fireEvent.click(screen.getByRole("checkbox", { name: /Rename the discs/ }));
      const download = await screen.findByRole("button", { name: "Download Game.zip" });
      await waitFor(() => expect((download as HTMLButtonElement).disabled).toBe(false));
      expect(screen.queryByRole("button", { name: "Rename discs and save playlist" })).toBeNull();

      fireEvent.click(download);
      await screen.findByText("Downloaded Game.zip");
      expect(support.writeZip).toHaveBeenCalledWith(
        expect.objectContaining({ zip: { chd: true, layout: "flat", rename: true } }),
      );
    } finally {
      Reflect.deleteProperty(window, "showDirectoryPicker");
    }
  });

  it("frees the earlier ZIP before the next one is written, so storage holds one", async () => {
    const first = zipOutput();
    const second = zipOutput();
    const secondWrite: { finish: (() => void) | null } = { finish: null };
    support.writeZip.mockResolvedValueOnce(first).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          secondWrite.finish = () => resolve(second);
        }),
    );
    render(<PlaylistForm onSessionChange={vi.fn()} />);
    const download = await dropDiscs();

    fireEvent.click(download);
    await screen.findByText("Downloaded Game.zip");
    expect(first.dispose).not.toHaveBeenCalled();

    fireEvent.click(download);
    await waitFor(() => expect(first.dispose).toHaveBeenCalledTimes(1));
    expect(second.saveAs).not.toHaveBeenCalled();
    secondWrite.finish?.();
    await waitFor(() => expect(second.saveAs).toHaveBeenCalled());
    expect(second.dispose).not.toHaveBeenCalled();
  });

  it("frees the ZIP when other discs replace the discs on the page", async () => {
    const output = zipOutput();
    support.writeZip.mockResolvedValue(output);
    render(<PlaylistForm onSessionChange={vi.fn()} />);
    const download = await dropDiscs();

    fireEvent.click(download);
    await screen.findByText("Downloaded Game.zip");
    fireEvent.change(document.getElementById("playlist-input-picker") as HTMLInputElement, {
      target: { files: [new File(["x"], "Other (Disc 1).cue")] },
    });
    expect(output.dispose).toHaveBeenCalledTimes(1);
  });

  it("says why the discs cannot be renamed into a ZIP, and holds the download", async () => {
    vi.mocked(planBrowserPlaylist).mockImplementation(async ({ zip }) => {
      if (zip?.rename) throw new Error("`Game.mds` cannot be renamed");
      return PLAN;
    });
    render(<PlaylistForm onSessionChange={vi.fn()} />);
    await dropDiscs();

    fireEvent.click(screen.getByRole("checkbox", { name: /Rename the discs/ }));
    await screen.findByText("Can't rename these discs: `Game.mds` cannot be renamed");
    expect((screen.getByRole("button", { name: "Download Game.zip" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("names the ZIP, not the rename, when renamed discs cannot become CHDs", async () => {
    vi.mocked(planBrowserPlaylist).mockImplementation(async ({ zip }) => {
      if (zip?.chd) throw new Error("Cannot compress `Game (Disc 2).pbp`");
      return PLAN;
    });
    render(<PlaylistForm onSessionChange={vi.fn()} />);
    await dropDiscs();

    fireEvent.click(screen.getByRole("checkbox", { name: /Rename the discs/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Compress the discs to CHD" }));
    await screen.findByText("Can't make the ZIP: Cannot compress `Game (Disc 2).pbp`");
    expect(screen.queryByText(/Can't rename/)).toBeNull();
  });

  it("names the ZIP when it cannot be built with nothing renamed, and holds the download", async () => {
    vi.mocked(planBrowserPlaylist).mockImplementation(async ({ zip }) => {
      if (zip) throw new Error("two files would both be written as `disc.gdi`");
      return PLAN;
    });
    render(<PlaylistForm onSessionChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Drop the discs of one game"), {
      target: { files: [new File(["one"], "Game (Disc 1).cue"), new File(["two"], "Game (Disc 2).cue")] },
    });

    await screen.findByText("Can't make the ZIP: two files would both be written as `disc.gdi`");
    expect((screen.getByRole("button", { name: "Download Game.zip" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/Can't rename/)).toBeNull();
  });

  it("keeps the warning's wording with the plan that failed while the next plan runs", async () => {
    const renamePlan: { release: (() => void) | null } = { release: null };
    vi.mocked(planBrowserPlaylist).mockImplementation(async ({ zip }) => {
      if (zip?.rename) {
        await new Promise<void>((resolve) => {
          renamePlan.release = resolve;
        });
        throw new Error("`Game.mds` cannot be renamed");
      }
      if (zip) throw new Error("two files would both be written as `disc.gdi`");
      return PLAN;
    });
    render(<PlaylistForm onSessionChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Drop the discs of one game"), {
      target: { files: [new File(["one"], "Game (Disc 1).cue"), new File(["two"], "Game (Disc 2).cue")] },
    });
    await screen.findByText("Can't make the ZIP: two files would both be written as `disc.gdi`");

    fireEvent.click(screen.getByRole("checkbox", { name: /Rename the discs/ }));
    await waitFor(() => expect(vi.mocked(planBrowserPlaylist).mock.calls.at(-1)?.[0].zip?.rename).toBe(true));
    expect(screen.queryByText(/Can't rename/)).toBeNull();
    expect(screen.getByText(/Can't make the ZIP: two files/)).toBeTruthy();

    renamePlan.release?.();
    await screen.findByText("Can't rename these discs: `Game.mds` cannot be renamed");
  });

  it("drops the ZIP warning when the next plan fails for another reason", async () => {
    const planFailure = { error: null as Error | null };
    vi.mocked(planBrowserPlaylist).mockImplementation(async ({ zip }) => {
      if (planFailure.error) throw planFailure.error;
      if (zip) throw new Error("two files would both be written as `disc.gdi`");
      return PLAN;
    });
    render(<PlaylistForm onSessionChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Drop the discs of one game"), {
      target: { files: [new File(["one"], "Game (Disc 1).cue"), new File(["two"], "Game (Disc 2).cue")] },
    });
    await screen.findByText("Can't make the ZIP: two files would both be written as `disc.gdi`");

    planFailure.error = new Error("Type a game name");
    fireEvent.change(screen.getByLabelText("Game name"), { target: { value: "FF7" } });

    await screen.findByText("Type a game name");
    expect(screen.queryByText(/Can't make the ZIP/)).toBeNull();
  });

  it("lists the ZIP's own lines when the browser cannot save the playlist into a folder", async () => {
    vi.mocked(planBrowserPlaylist).mockImplementation(async ({ zip }) =>
      zip ? PLAN : { ...PLAN, entries: ["CD1/Game (Disc 1).cue", "CD2/Game (Disc 2).cue"] },
    );
    render(<PlaylistForm onSessionChange={vi.fn()} />);
    await dropDiscs();

    expect(screen.getByText("Game (Disc 1).cue")).toBeTruthy();
    expect(screen.queryByText("CD1/Game (Disc 1).cue")).toBeNull();
  });

  it("says why a game name cannot be used, and holds the ZIP", async () => {
    render(<PlaylistForm onSessionChange={vi.fn()} />);
    const download = await dropDiscs();

    fireEvent.change(screen.getByLabelText("Game name"), { target: { value: "CON" } });
    await screen.findByText('Windows reserves the name "CON".');
    expect((download as HTMLButtonElement).disabled).toBe(true);
  });

  it("frees a ZIP that finishes after the page was left, without saving it", async () => {
    const output = zipOutput();
    const write: { signal: AbortSignal | null; finish: ((value: unknown) => void) | null } = {
      finish: null,
      signal: null,
    };
    support.writeZip.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          write.signal = signal;
          write.finish = resolve;
        }),
    );
    const { unmount } = render(<PlaylistForm onSessionChange={vi.fn()} />);
    await dropDiscs();
    fireEvent.click(screen.getByRole("button", { name: "Download Game.zip" }));
    await waitFor(() => expect(write.finish).not.toBeNull());

    unmount();
    write.finish?.(output);

    await waitFor(() => expect(output.dispose).toHaveBeenCalled());
    expect(write.signal?.aborted).toBe(true);
    expect(output.saveAs).not.toHaveBeenCalled();
  });

  it("cancels a ZIP being written without an error or a saved file", async () => {
    const output = zipOutput();
    let signal: AbortSignal | undefined;
    support.writeZip.mockImplementation(
      ({ signal: given }: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          signal = given;
          // A runtime may finish after the abort. The page MUST still free what it made.
          given.addEventListener("abort", () => resolve(output));
        }),
    );
    render(<PlaylistForm onSessionChange={vi.fn()} />);
    await dropDiscs();

    fireEvent.click(screen.getByRole("button", { name: "Download Game.zip" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull());
    expect(signal?.aborted).toBe(true);
    expect(output.saveAs).not.toHaveBeenCalled();
    expect(output.dispose).toHaveBeenCalled();
    expect(screen.queryByText(/Downloaded/)).toBeNull();
    expect((screen.getByRole("button", { name: "Download Game.zip" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("warns before leaving while a ZIP is being written", async () => {
    support.writeZip.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")))),
    );
    const onSessionChange = vi.fn();
    render(<PlaylistForm onSessionChange={onSessionChange} />);
    await dropDiscs();
    expect(onSessionChange).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByRole("button", { name: "Download Game.zip" }));
    await waitFor(() => expect(onSessionChange).toHaveBeenLastCalledWith(true));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onSessionChange).toHaveBeenLastCalledWith(false));
  });

  it("keeps warning before leaving while the ZIP is kept for its download", async () => {
    support.writeZip.mockResolvedValue(zipOutput());
    const onSessionChange = vi.fn();
    render(<PlaylistForm onSessionChange={onSessionChange} />);
    const download = await dropDiscs();

    fireEvent.click(download);
    await screen.findByText("Downloaded Game.zip");
    await waitFor(() => expect((download as HTMLButtonElement).disabled).toBe(false));
    expect(onSessionChange).toHaveBeenLastCalledWith(true);
    fireEvent.change(document.getElementById("playlist-input-picker") as HTMLInputElement, {
      target: { files: [new File(["x"], "Other (Disc 1).cue")] },
    });
    await waitFor(() => expect(onSessionChange).toHaveBeenLastCalledWith(false));
  });

  it("shows no error when the engine fails because the ZIP write was cancelled", async () => {
    support.writeZip.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("The playlist run was cancelled by the engine.")));
        }),
    );
    render(<PlaylistForm onSessionChange={vi.fn()} />);
    await dropDiscs();

    fireEvent.click(screen.getByRole("button", { name: "Download Game.zip" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull());
    expect(screen.queryByText(/cancelled by the engine/)).toBeNull();
  });

  it("shows its labels in the chosen language", async () => {
    await preloadCatalog("de");
    render(
      <RomWeaverSettingsProvider settings={{ language: "de" }}>
        <PlaylistForm onSessionChange={vi.fn()} />
      </RomWeaverSettingsProvider>,
    );
    fireEvent.change(screen.getByLabelText("Discs eines Spiels hier ablegen"), {
      target: { files: [new File(["two"], "Game (Disc 2).cue"), new File(["one"], "Game (Disc 1).cue")] },
    });

    expect(await screen.findByRole("button", { name: "Game.zip herunterladen" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Spielordner öffnen" })).toBeTruthy();
    expect(screen.getByLabelText("Spielname")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Anordnung" })).toBeTruthy();
    expect(screen.getByText("Speichern")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /Discs umbenennen in/ })).toBeTruthy();
    expect(screen.getByText(/In jedem Browser kannst du eine ZIP-Datei/)).toBeTruthy();
  });

  it("opens the folder picker when the button is clicked before the page has checked for support", async () => {
    render(<PlaylistForm onSessionChange={vi.fn()} />);
    support.canWrite = true;
    const picker = vi.fn(async () => {
      throw new DOMException("The user aborted a request.", "AbortError");
    });
    Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: picker });
    try {
      fireEvent.click(screen.getByRole("button", { name: "Open game folder" }));
      await waitFor(() => expect(picker).toHaveBeenCalledWith({ id: "rom-weaver-playlist", mode: "read" }));
    } finally {
      Reflect.deleteProperty(window, "showDirectoryPicker");
    }
  });

  it("reports a file picker open while the folder picker is, and closed once the pick is cancelled", async () => {
    render(<PlaylistForm onSessionChange={vi.fn()} />);
    support.canWrite = true;
    let cancelPick: (cause: DOMException) => void = () => undefined;
    const picker = () =>
      new Promise<FileSystemDirectoryHandle>((_resolve, reject) => {
        cancelPick = reject;
      });
    Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: picker });
    try {
      fireEvent.click(screen.getByRole("button", { name: "Open game folder" }));
      await waitFor(() => expect(isFilePickerOpen()).toBe(true));
      cancelPick(new DOMException("The user aborted a request.", "AbortError"));
      await waitFor(() => expect(isFilePickerOpen()).toBe(false));
    } finally {
      Reflect.deleteProperty(window, "showDirectoryPicker");
    }
  });
});
