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
