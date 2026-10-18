// @vitest-environment happy-dom
import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setPlaylistHandoff } from "../../src/lib/playlist-handoff.ts";
import { PlaylistForm } from "../../src/webapp/components/playlist-form.tsx";

const mocks = vi.hoisted(() => ({ build: vi.fn(), copy: vi.fn(), wrap: vi.fn() }));
vi.mock("../../src/platform/browser/browser-api.ts", () => ({ buildPlaylist: mocks.build }));
vi.mock("../../src/storage/vfs/runtime-output.ts", () => ({
  copyRuntimeOutputToPath: mocks.copy,
  createRuntimeOutputFromVfs: mocks.wrap,
}));

const output = (fileName: string) => ({
  dispose: vi.fn(),
  fileName,
  saveAs: vi.fn(async () => undefined),
  size: 10,
});

const pick = (container: HTMLElement, files: File[]) => {
  const picker = container.querySelector("#playlist-input-picker");
  if (!picker) throw new Error("Missing input picker");
  fireEvent.change(picker, { target: { files } });
};
const cardNames = (container: HTMLElement) =>
  [...container.querySelectorAll("ol[aria-label='Discs in playlist order'] .nm")].map((node) => node.textContent);

describe("Playlist form", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the order the playlist command returns and builds from the reordered list", async () => {
    mocks.build.mockImplementation(async ({ archive, files, sort }) => {
      const names = files.map((file: File) => file.name);
      const discIndexes = names.flatMap((name: string, index: number) => (name.endsWith(".cue") ? [index] : []));
      if (sort) discIndexes.sort((a: number, b: number) => names[a].localeCompare(names[b]));
      return {
        discIndexes,
        entries: discIndexes.map((index: number) => names[index]),
        output: output(archive ? "x.zip" : "x.m3u"),
      };
    });
    const view = render(<PlaylistForm />);
    pick(view.container, [
      new File(["2"], "Game (Disc 2).cue"),
      new File(["1"], "Game (Disc 1).cue"),
      new File(["b"], "Game (Disc 1).bin"),
    ]);
    await waitFor(() => expect(cardNames(view.container)).toEqual(["Game (Disc 1).cue", "Game (Disc 2).cue"]));
    expect(view.container.querySelector(".playlist-extras")?.textContent).toContain("Game (Disc 1).bin");
    expect(mocks.build.mock.calls[0]?.[0]).toMatchObject({ archive: false, sort: true });

    fireEvent.click(view.getByLabelText("Move Game (Disc 1).cue down"));
    expect(cardNames(view.container)).toEqual(["Game (Disc 2).cue", "Game (Disc 1).cue"]);

    fireEvent.click(view.getByRole("button", { name: /Build playlist/ }));
    await waitFor(() => expect(mocks.build).toHaveBeenCalledTimes(2));
    const final = mocks.build.mock.calls[1]?.[0];
    expect(final).toMatchObject({ archive: false, outputName: "Game.m3u", sort: false });
    expect(final.files.map((file: File) => file.name)).toEqual([
      "Game (Disc 2).cue",
      "Game (Disc 1).cue",
      "Game (Disc 1).bin",
    ]);
    view.unmount();
  });

  it("takes discs handed over from Extract", async () => {
    mocks.build.mockResolvedValue({ discIndexes: [0, 1], entries: ["a.chd", "b.chd"], output: output("order.m3u") });
    setPlaylistHandoff([
      { name: "a.chd", size: 1, source: new File(["a"], "a.chd") },
      { name: "b.chd", size: 1, source: new File(["b"], "b.chd") },
    ]);
    const view = render(<PlaylistForm />);
    await waitFor(() => expect(cardNames(view.container)).toEqual(["a.chd", "b.chd"]));
    view.unmount();
  });

  it("keeps the user's names, order and remove buttons when staging renamed the files", async () => {
    // The command reports staged names; the build maps them back to the dropped files by position.
    mocks.build.mockImplementation(async ({ files }) => {
      const discIndexes = files.map((_: File, index: number) => index).reverse();
      return { discIndexes, entries: discIndexes.map((i: number) => files[i].name), output: output("order.m3u") };
    });
    const view = render(<PlaylistForm />);
    pick(view.container, [new File(["2"], "Pokémon (Disc 2).iso"), new File(["1"], "Pokémon (Disc 1).iso")]);
    await waitFor(() => expect(cardNames(view.container)).toEqual(["Pokémon (Disc 1).iso", "Pokémon (Disc 2).iso"]));
    expect(view.container.querySelector(".playlist-extras")).toBeNull();
    mocks.build.mockClear();
    fireEvent.click(view.getByLabelText("Remove Pokémon (Disc 1).iso"));
    await waitFor(() => expect(cardNames(view.container)).toEqual(["Pokémon (Disc 2).iso"]));
    view.unmount();
  });

  it("removes the track files of a removed sheet with it", async () => {
    mocks.build.mockImplementation(async ({ files, sort }) => {
      const names = files.map((file: File) => file.name);
      // `Disc 2.cue` names `Disc 2.bin`; `Disc 1.bin` is only claimed when its own sheet is present.
      const claimed = (name: string) => names.includes(name.replace(".bin", ".cue"));
      const discIndexes = names.flatMap((name: string, index: number) =>
        name.endsWith(".cue") || !claimed(name) ? [index] : [],
      );
      if (sort) discIndexes.sort((a: number, b: number) => names[a].localeCompare(names[b]));
      return { discIndexes, entries: discIndexes.map((i: number) => names[i]), output: output("x.m3u") };
    });
    const view = render(<PlaylistForm />);
    pick(view.container, [
      new File(["1"], "Game (Disc 1).cue"),
      new File(["b"], "Game (Disc 1).bin"),
      new File(["2"], "Game (Disc 2).cue"),
      new File(["b"], "Game (Disc 2).bin"),
    ]);
    await waitFor(() => expect(cardNames(view.container)).toHaveLength(2));
    fireEvent.click(view.getByLabelText("Remove Game (Disc 2).cue"));
    await waitFor(() => expect(cardNames(view.container)).toEqual(["Game (Disc 1).cue"]));
    expect(view.container.querySelector(".playlist-extras")?.textContent).toContain("Game (Disc 1).bin");
    expect(view.container.querySelector(".playlist-extras")?.textContent).not.toContain("Game (Disc 2).bin");
    view.unmount();
  });

  it("refuses a different file that shares a name, and ignores the same file dropped again", async () => {
    mocks.build.mockImplementation(async ({ files }) => ({
      discIndexes: files.map((_: File, index: number) => index),
      entries: files.map((file: File) => file.name),
      output: output("order.m3u"),
    }));
    const view = render(<PlaylistForm />);
    const first = new File(["aaaa"], "track01.bin", { lastModified: 5 });
    pick(view.container, [first]);
    await waitFor(() => expect(cardNames(view.container)).toEqual(["track01.bin"]));
    pick(view.container, [new File(["aaaa"], "track01.bin", { lastModified: 5 })]);
    pick(view.container, [new File(["different"], "track01.bin", { lastModified: 9 })]);
    await waitFor(() => expect(view.container.textContent).toContain("A different file named track01.bin"));
    expect(cardNames(view.container)).toEqual(["track01.bin"]);
    view.unmount();
  });

  it("keeps its own copy of handed-over outputs and tells outputs apart by source, not name", async () => {
    const created: Array<{ dispose: ReturnType<typeof vi.fn>; fileName: string }> = [];
    mocks.copy.mockImplementation(async (source: { fileName: string }) => ({
      dispose: vi.fn(async () => undefined),
      fileName: source.fileName,
      path: "/copy",
      size: 4,
      vfs: {},
    }));
    mocks.wrap.mockImplementation(async (_vfs: unknown, _path: string, fileName: string) => {
      const copy = { dispose: vi.fn(async () => undefined), fileName, saveAs: vi.fn(), size: 4 };
      created.push(copy);
      return copy;
    });
    mocks.build.mockImplementation(async ({ files }) => ({
      discIndexes: files.map((_: unknown, index: number) => index),
      entries: files.map((file: { fileName?: string; name?: string }) => file.fileName ?? file.name),
      output: output("order.m3u"),
    }));
    const extracted = (fileName: string) => ({ ...output(fileName), path: `/out/${fileName}` });
    const first = extracted("EBOOT.PBP");
    const view = render(<PlaylistForm />);
    setPlaylistHandoff([{ name: "EBOOT.PBP", size: 4, source: first as never }]);
    await waitFor(() => expect(cardNames(view.container)).toEqual(["EBOOT.PBP"]));
    // The handed-over output is Extract's to delete; the playlist asks for files it still owns.
    expect(mocks.build.mock.calls.at(-1)?.[0].files[0]).toBe(created[0]);
    expect(first.dispose).not.toHaveBeenCalled();
    // The same output handed over again is the same file: no second copy.
    setPlaylistHandoff([{ name: "EBOOT.PBP", size: 4, source: first as never }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(created).toHaveLength(1);
    // A later extraction with the same output name is a different file: surfaced, not dropped silently.
    setPlaylistHandoff([{ name: "EBOOT.PBP", size: 4, source: extracted("EBOOT.PBP") as never }]);
    await waitFor(() => expect(view.container.textContent).toContain("A different file named EBOOT.PBP"));
    expect(created).toHaveLength(2);
    expect(created[1]?.dispose).toHaveBeenCalled();
    view.unmount();
    expect(created[0]?.dispose).toHaveBeenCalled();
  });

  it("copies one handoff into one folder and shows a status while it copies", async () => {
    const folders: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.copy.mockImplementation(async (source: { fileName: string }, _name: string, _prefix: string, id: string) => {
      folders.push(id);
      await gate;
      return { dispose: vi.fn(async () => undefined), fileName: source.fileName, path: "/copy", size: 4, vfs: {} };
    });
    mocks.wrap.mockImplementation(async (_vfs: unknown, _path: string, fileName: string) => ({
      dispose: vi.fn(async () => undefined),
      fileName,
      saveAs: vi.fn(),
      size: 4,
    }));
    mocks.build.mockImplementation(async ({ files }) => ({
      discIndexes: [0, 2],
      entries: files.map((file: { fileName: string }) => file.fileName),
      output: output("order.m3u"),
    }));
    const view = render(<PlaylistForm />);
    const extracted = (fileName: string) => ({ ...output(fileName), path: `/out/${fileName}` });
    setPlaylistHandoff(
      ["Game (Disc 1).cue", "Game (Disc 1).bin", "Game (Disc 2).cue"].map((name) => ({
        name,
        size: 4,
        source: extracted(name) as never,
      })),
    );
    await waitFor(() => expect(view.container.querySelector("[role='status']")?.textContent).toContain("Copying"));
    release();
    await waitFor(() => expect(cardNames(view.container)).toHaveLength(2));
    expect(folders).toHaveLength(3);
    expect(new Set(folders).size).toBe(1);
    expect(view.container.querySelector("[role='status']")).toBeNull();
    view.unmount();
  });

  it("waits for the ordering pass before removing, and blocks Build until the removal ends", async () => {
    let probeRelease: () => void = () => undefined;
    const probeGate = new Promise<void>((resolve) => {
      probeRelease = resolve;
    });
    mocks.build.mockImplementation(async ({ files, sort }) => {
      const names = files.map((file: File) => file.name);
      if (sort === false && names.length > 1) await probeGate;
      const discIndexes = names.flatMap((name: string, index: number) => (name.endsWith(".cue") ? [index] : []));
      return { discIndexes, entries: discIndexes.map((i: number) => names[i]), output: output("x.m3u") };
    });
    const view = render(<PlaylistForm />);
    pick(view.container, [
      new File(["1"], "Game (Disc 1).cue"),
      new File(["b"], "Game (Disc 1).bin"),
      new File(["2"], "Game (Disc 2).cue"),
    ]);
    await waitFor(() => expect(cardNames(view.container)).toHaveLength(2));
    fireEvent.click(view.getByLabelText("Remove Game (Disc 2).cue"));
    await waitFor(() =>
      expect(view.getByRole("button", { name: /Build playlist/ }).hasAttribute("disabled")).toBe(true),
    );
    expect(view.queryByLabelText("Remove Game (Disc 1).cue")).toBeNull();
    probeRelease();
    await waitFor(() => expect(cardNames(view.container)).toEqual(["Game (Disc 1).cue"]));
    await waitFor(() =>
      expect(view.getByRole("button", { name: /Build playlist/ }).hasAttribute("disabled")).toBe(false),
    );
    view.unmount();
  });
});
