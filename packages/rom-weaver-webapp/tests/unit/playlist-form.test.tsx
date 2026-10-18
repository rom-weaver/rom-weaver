// @vitest-environment happy-dom
import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setPlaylistHandoff } from "../../src/lib/playlist-handoff.ts";
import { PlaylistForm } from "../../src/webapp/components/playlist-form.tsx";

const mocks = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock("../../src/platform/browser/browser-api.ts", () => ({ buildPlaylist: mocks.build }));

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
    mocks.build.mockImplementation(async ({ archive, files, sort }) => ({
      entries: sort
        ? ["Game (Disc 1).cue", "Game (Disc 2).cue"]
        : files.map((file: File) => file.name).filter((name: string) => name.endsWith(".cue")),
      output: output(archive ? "x.zip" : "x.m3u"),
    }));
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
    mocks.build.mockResolvedValue({ entries: ["a.chd", "b.chd"], output: output("order.m3u") });
    setPlaylistHandoff([
      { name: "a.chd", size: 1, source: new File(["a"], "a.chd") },
      { name: "b.chd", size: 1, source: new File(["b"], "b.chd") },
    ]);
    const view = render(<PlaylistForm />);
    await waitFor(() => expect(cardNames(view.container)).toEqual(["a.chd", "b.chd"]));
    view.unmount();
  });
});
