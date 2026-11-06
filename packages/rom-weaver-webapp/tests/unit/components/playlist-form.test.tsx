// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlaylistForm } from "../../../src/webapp/components/playlist-form.tsx";

const support = vi.hoisted(() => ({
  canWrite: false,
  download: vi.fn(async (_blob: Blob, _name: string, _options: unknown) => undefined),
  interrupted: null as null | { folderName: string },
  undo: vi.fn(async (_record: unknown) => undefined),
}));

const PLAN = {
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
}));
vi.mock("../../../src/platform/browser/browser-download.ts", () => ({ triggerBrowserDownload: support.download }));
vi.mock("../../../src/storage/browser/playlist-folder-support.ts", () => ({
  canWritePlaylistFolders: () => support.canWrite,
}));
vi.mock("../../../src/storage/browser/playlist-folder-write.ts", () => ({
  readInterruptedPlaylistRename: async () => support.interrupted,
  undoInterruptedPlaylistRename: async (record: unknown) => {
    await support.undo(record);
    support.interrupted = null;
  },
}));

const dropDiscs = async () => {
  fireEvent.change(screen.getByLabelText("Drop the discs of one game"), {
    target: {
      files: [new File(["two"], "Game (Disc 2).cue"), new File(["one"], "Game (Disc 1).cue")],
    },
  });
  const download = await screen.findByRole("button", { name: "Download Game.m3u" });
  await waitFor(() => expect((download as HTMLButtonElement).disabled).toBe(false));
  return download;
};

beforeEach(() => {
  support.canWrite = false;
  support.interrupted = null;
  support.download.mockClear();
  support.undo.mockClear();
});

describe("PlaylistForm", () => {
  it("downloads the playlist in a browser that cannot change folders, and points renaming at the CLI", async () => {
    render(<PlaylistForm onSessionChange={vi.fn()} />);
    const download = await dropDiscs();

    expect(screen.getByText("Game (Disc 1).cue")).toBeTruthy();
    expect(screen.getByText("Game (Disc 2).cue")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save into folder" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: /Rename the discs/ }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole("link", { name: "rename the discs with the command line" }).getAttribute("href")).toContain(
      "docs/cli-playlist#rename-the-discs",
    );

    fireEvent.click(download);
    await screen.findByText("Downloaded Game.m3u");
    expect(support.download).toHaveBeenCalledWith(expect.any(Blob), "Game.m3u", { interactive: true });
    expect(await support.download.mock.calls[0]?.[0].text()).toBe(PLAN.text);
  });

  it("asks for the game's folder before saving into it or renaming in Chrome and Edge", async () => {
    support.canWrite = true;
    render(<PlaylistForm onSessionChange={vi.fn()} />);
    await dropDiscs();

    expect(screen.getByText("Open the game's folder to save the playlist into it or rename its discs.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "rename the discs with the command line" })).toBeNull();
    expect((screen.getByRole("button", { name: "Save into folder" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: /Rename the discs/ }) as HTMLInputElement).disabled).toBe(true);
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

  it("offers to put back the files of an interrupted rename", async () => {
    support.canWrite = true;
    support.interrupted = { folderName: "FF7" };
    render(<PlaylistForm onSessionChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Put the files back" }));
    await screen.findByText("Put back the files in FF7");
    expect(support.undo).toHaveBeenCalledWith({ folderName: "FF7" });
    expect(screen.queryByRole("button", { name: "Put the files back" })).toBeNull();
  });
});
