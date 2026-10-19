// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentWorkflow } from "../../../src/webapp/agent/workflow-registry.ts";
import { ExtractForm } from "../../../src/webapp/components/extract-form.tsx";

const runtime = vi.hoisted(() => ({ create: vi.fn(), extract: vi.fn(), probe: vi.fn() }));

vi.mock("../../../src/platform/browser/workflow-runtime.ts", () => ({
  browserRuntime: { compression: runtime },
}));

const output = (relativePath: string, path = `/ops/1/${relativePath}`) => ({
  dispose: vi.fn(async () => undefined),
  fileName: relativePath.split("/").at(-1),
  path,
  relativePath,
  saveAs: vi.fn(async () => undefined),
  size: 4,
});

const addFile = (file: File) =>
  fireEvent.change(screen.getByLabelText("Drop an archive or disc image to extract it"), {
    target: { files: [file] },
  });

describe("ExtractForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps NFS parts and their key together, including on retry", async () => {
    runtime.extract.mockRejectedValue(new Error("try again"));
    const key = new File([new Uint8Array(16)], "htk.bin");
    const first = new File(["EGGS"], "hif_000000.nfs");
    const second = new File(["part"], "hif_000001.nfs");
    render(<ExtractForm />);

    const picker = screen.getByLabelText("Drop an archive or disc image to extract it") as HTMLInputElement;
    expect(picker.multiple).toBe(true);
    fireEvent.change(picker, { target: { files: [key, second, first] } });

    await screen.findByText("try again");
    expect(runtime.extract).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: first, companionFiles: [key, second], extractAll: true }),
    );
    expect(getAgentWorkflow("extract")?.getState().skippedFiles).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Extract again" }));
    await waitFor(() => expect(runtime.extract).toHaveBeenCalledTimes(2));
    expect(runtime.extract).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: first, companionFiles: [key, second] }),
    );
  });

  it("opens a split WBFS set from its .wbfs part and skips files from another set", async () => {
    runtime.extract.mockResolvedValue({ outputs: [output("Game.iso")] });
    const first = new File(["WBFS"], "Game.wbfs");
    const second = new File(["part"], "Game.WBF1");
    const third = new File(["part"], "game.wbf2");
    const other = new File(["part"], "Other.wbf1");
    render(<ExtractForm pageDrop={{ files: [third, other, first, second], id: 1 }} />);

    await waitFor(() => expect(runtime.extract).toHaveBeenCalledTimes(1));
    expect(runtime.extract).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: first, companionFiles: [third, second], extractAll: true }),
    );
    expect(getAgentWorkflow("extract")?.getState().skippedFiles).toEqual(["Other.wbf1"]);
  });

  it.each([
    [
      1398102,
      "Game.wbfs is shorter than its WBFS header says. If it is split, add it together with every .wbf1, .wbf2, ... part; otherwise the file is incomplete.",
    ],
    [
      5592405,
      "Game.wbfs and its parts are longer than its WBFS header says. Remove any .wbf part that does not belong to this set.",
    ],
  ])("explains a WBFS of %i bytes against a 4 MiB header instead of the raw size error", async (size, text) => {
    runtime.extract.mockRejectedValue(
      new Error(
        `failed to open wbfs source \`/work/Game.wbfs\`: Invalid WBFS file size: 2097152, expected 4194304; path fallback failed: disc format error: Invalid WBFS file size: ${size}, expected 4194304`,
      ),
    );
    render(<ExtractForm />);

    addFile(new File(["WBFS"], "Game.wbfs"));

    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByText(/\/work\//)).toBeNull();
  });

  it("extracts the first of several dropped files and names the ones it did not use", async () => {
    runtime.extract.mockResolvedValue({ outputs: [output("a.sfc")] });
    render(
      <ExtractForm
        pageDrop={{ files: [new File(["1"], "a.zip"), new File(["2"], "b.zip"), new File(["3"], "c.zip")], id: 1 }}
      />,
    );

    await waitFor(() => expect(runtime.extract).toHaveBeenCalledTimes(1));
    expect((runtime.extract.mock.calls[0]?.[0] as { source: File } | undefined)?.source.name).toBe("a.zip");
    expect(
      await screen.findByText("Extract opens one archive per run: only a.zip was used; b.zip, c.zip were skipped."),
    ).toBeTruthy();
    expect(screen.queryByText("Add one file at a time.")).toBeNull();
    expect(getAgentWorkflow("extract")?.getState().skippedFiles).toEqual(["b.zip", "c.zip"]);
  });

  it("names a file that is not an archive instead of the internal storage path", async () => {
    runtime.extract.mockRejectedValue(new Error("no registered container matched `/work/notes.txt`"));
    const view = render(<ExtractForm />);

    addFile(new File(["hello"], "notes.txt"));

    expect(await screen.findByText("notes.txt is not an archive or disc image that Extract can open.")).toBeTruthy();
    expect(screen.queryByText(/\/work\//)).toBeNull();
    view.unmount();
  });

  it("extracts the first of several dropped files and names the ones it did not use", async () => {
    runtime.extract.mockResolvedValue({ outputs: [output("a.sfc")] });
    render(
      <ExtractForm
        pageDrop={{ files: [new File(["1"], "a.zip"), new File(["2"], "b.zip"), new File(["3"], "c.zip")], id: 1 }}
      />,
    );

    await waitFor(() => expect(runtime.extract).toHaveBeenCalledTimes(1));
    expect((runtime.extract.mock.calls[0]?.[0] as { source: File } | undefined)?.source.name).toBe("a.zip");
    expect(
      await screen.findByText("Extract opens one archive per run: only a.zip was used; b.zip, c.zip were skipped."),
    ).toBeTruthy();
    expect(screen.queryByText("Add one file at a time.")).toBeNull();
    expect(getAgentWorkflow("extract")?.getState().skippedFiles).toEqual(["b.zip", "c.zip"]);
  });

  it("extracts on add, then downloads one file as itself and several as one ZIP", async () => {
    const outputs = [output("game.sfc"), output("docs/readme.txt")];
    const archive = output("game.zip");
    runtime.extract.mockResolvedValue({ outputs });
    runtime.create.mockResolvedValue({ output: archive });
    render(<ExtractForm />);

    addFile(new File(["zip"], "game.zip"));

    expect(await screen.findByText("docs › readme.txt")).toBeTruthy();
    expect(runtime.extract).toHaveBeenCalledWith(expect.objectContaining({ extractAll: true }));
    expect(runtime.probe).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Download 2 files as ZIP" }));
    await waitFor(() => expect(archive.saveAs).toHaveBeenCalledWith({ fileName: "game.zip", interactive: true }));
    // The ZIP MUST outlive saveAs: the browser reads it after saveAs returns.
    expect(archive.dispose).not.toHaveBeenCalled();
    expect(runtime.create).toHaveBeenCalledWith(
      expect.objectContaining({
        entries: [
          { filePath: "/ops/1/game.sfc", filename: "game.sfc" },
          { filePath: "/ops/1/docs/readme.txt", filename: "docs/readme.txt" },
        ],
      }),
    );

    fireEvent.click(screen.getByLabelText(/docs › readme\.txt/));
    fireEvent.click(await screen.findByRole("button", { name: "Download 1 file" }));
    await waitFor(() => expect(outputs[0]?.saveAs).toHaveBeenCalledWith({ fileName: "game.sfc", interactive: true }));
    expect(runtime.create).toHaveBeenCalledTimes(1);
  });

  it("shows ZIP progress with a readable label and the runtime percent", async () => {
    runtime.extract.mockResolvedValue({ outputs: [output("a.bin"), output("b.bin")] });
    let finish: (value: unknown) => void = () => undefined;
    runtime.create.mockImplementation(
      ({ options }: { options: { onProgress: (event: object) => void } }) =>
        new Promise((resolve) => {
          options.onProgress({ label: "creating `zip`", percent: 40, stage: "output" });
          options.onProgress({ label: "finalizing `zip` archive", percent: null, stage: "output" });
          finish = resolve;
        }),
    );
    render(<ExtractForm />);

    addFile(new File(["zip"], "set.zip"));
    fireEvent.click(await screen.findByRole("button", { name: "Download 2 files as ZIP" }));

    expect(await screen.findByText("Creating set.zip…")).toBeTruthy();
    expect(screen.getByText("40%")).toBeTruthy();
    expect(screen.queryByText(/finalizing/)).toBeNull();
    finish({ output: output("set.zip") });
    await waitFor(() => expect(screen.queryByText("Creating set.zip…")).toBeNull());
  });

  it("cancels a ZIP without an error or a save and lets the user try again", async () => {
    runtime.extract.mockResolvedValue({ outputs: [output("a.bin"), output("b.bin")] });
    const late = output("set.zip");
    let finish: (value: unknown) => void = () => undefined;
    runtime.create.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    render(<ExtractForm />);

    addFile(new File(["zip"], "set.zip"));
    fireEvent.click(await screen.findByRole("button", { name: "Download 2 files as ZIP" }));
    fireEvent.click(await screen.findByRole("button", { name: /cancel/i }));
    finish({ output: late });

    await waitFor(() => expect(late.dispose).toHaveBeenCalled());
    expect(late.saveAs).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: "Download 2 files as ZIP" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("asks how to write a multi-track CD CHD before it extracts", async () => {
    runtime.probe.mockImplementation(async ({ options }: { options: { chdSplitBin?: boolean } }) => ({
      entries: options.chdSplitBin
        ? [{ filename: "disc (Track 1).bin" }, { filename: "disc (Track 2).bin" }]
        : [{ filename: "disc.bin" }],
    }));
    runtime.extract.mockResolvedValue({ outputs: [output("disc (Track 1).bin")] });
    render(<ExtractForm />);

    addFile(new File(["chd"], "disc.chd"));

    fireEvent.click(await screen.findByRole("button", { name: /One BIN file per track/ }));
    expect(await screen.findByText("disc (Track 1).bin")).toBeTruthy();
    expect(runtime.extract).toHaveBeenCalledWith(
      expect.objectContaining({ options: expect.objectContaining({ chdSplitBin: true }) }),
    );
  });
});
