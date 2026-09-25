// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
