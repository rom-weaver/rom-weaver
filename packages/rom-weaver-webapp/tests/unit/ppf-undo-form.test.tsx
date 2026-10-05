// @vitest-environment happy-dom
import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PpfUndoForm } from "../../src/webapp/components/ppf-undo-form.tsx";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";

const mocks = vi.hoisted(() => ({ ingest: vi.fn(), undo: vi.fn() }));
vi.mock("../../src/platform/browser/workflow-runtime.ts", () => ({
  browserRuntime: { ingest: { run: mocks.ingest } },
}));
vi.mock("../../src/platform/browser/browser-api.ts", () => ({ undoPpf: mocks.undo }));
vi.mock("../../src/webapp/compress-service.ts", () => ({ getCompressFormats: async () => ["zip", "7z"] }));

describe("PPF Undo input replacement", () => {
  beforeEach(() => vi.clearAllMocks());
  it.each([
    {
      name: "cartridge",
      filename: "game.bin",
      recommendedFormat: undefined,
      discFormat: undefined,
      group: false,
      formats: ["none", "zip", "7z"],
    },
    {
      name: "grouped CUE",
      filename: "disc.zip",
      recommendedFormat: undefined,
      discFormat: "CD",
      group: true,
      formats: ["none", "zip", "7z", "chd"],
    },
    {
      name: "content-detected GameCube",
      filename: "game.bin",
      recommendedFormat: "rvz",
      discFormat: "DVD",
      group: false,
      formats: ["none", "zip", "7z", "rvz"],
    },
  ])(
    "uses ingest metadata and the shared compression policy for $name",
    async ({ filename, recommendedFormat, discFormat, group, formats }) => {
      const source = new File(["sixteenbyteinput!"], filename);
      const stored = (path: string, content: string) => ({
        path,
        fileName: path.split("/").pop(),
        dispose: vi.fn(),
        vfs: { getFile: async () => new File([content], "stored") },
      });
      const sheet = stored("/disc.cue", 'FILE "track.bin" BINARY');
      const track = stored("/track.bin", "track");
      mocks.ingest.mockResolvedValue({
        result: {
          assets: group
            ? [
                { path: sheet.path, fileName: sheet.fileName, kind: "cue", discGroupId: "disc", discFormat },
                { path: track.path, fileName: track.fileName, kind: "bin", discGroupId: "disc", discFormat },
              ]
            : [{ fileName: filename, recommendedFormat, discFormat }],
          patches: [],
        },
        outputs: group ? [sheet, track] : [],
        patchOutputs: [],
      });
      const view = render(<PpfUndoForm onSessionChange={vi.fn()} />);
      const picker = view.container.querySelector("#ppf-undo-input-picker");
      if (!picker) throw new Error("Missing input picker");
      fireEvent.change(picker, { target: { files: [source] } });
      await waitFor(() => {
        const options = view.container.querySelectorAll("#ppf-undo-output-compression option");
        expect([...options].map((option) => (option as HTMLOptionElement).value)).toEqual(formats);
      });
    },
  );

  it("clears a prior patch after invalid replacement, stays disabled after filename editing, and recovers", async () => {
    mocks.ingest.mockImplementation(async ({ fileName }) => ({
      outputs: [],
      patchOutputs: [],
      result: fileName.endsWith(".bin")
        ? { assets: [{ fileName }], patches: [] }
        : { assets: [], patches: [{ fileName, format: "ppf", isValidPatch: fileName !== "invalid.ppf" }] },
    }));
    const output = { fileName: "patched-restored.bin", saveAs: vi.fn(), dispose: vi.fn(), size: 16 };
    mocks.undo.mockResolvedValue(output);
    const view = render(
      <RomWeaverSettingsProvider settings={{ defaultCompression: "none" }}>
        <PpfUndoForm onSessionChange={vi.fn()} />
      </RomWeaverSettingsProvider>,
    );
    const picker = view.container.querySelector("#ppf-undo-input-picker");
    if (!picker) throw new Error("Missing input picker");
    const rom = new File(["ROM"], "patched.bin");
    const valid = new File(["PPF"], "valid.ppf");
    fireEvent.change(picker, { target: { files: [rom, valid] } });
    await waitFor(() =>
      expect((view.getByRole("button", { name: "Restore original ROM" }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.change(picker, { target: { files: [new File(["invalid"], "invalid.ppf")] } });
    await waitFor(() => expect(view.queryByText("valid.ppf")).toBeNull());
    fireEvent.change(view.getByRole("textbox", { name: "Output filename" }), { target: { value: "edited" } });
    expect((view.getByRole("button", { name: "Restore original ROM" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.undo).not.toHaveBeenCalled();
    fireEvent.change(picker, { target: { files: [valid] } });
    await waitFor(() =>
      expect((view.getByRole("button", { name: "Restore original ROM" }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(view.getByRole("button", { name: "Restore original ROM" }));
    await waitFor(() => expect(output.saveAs).toHaveBeenCalledOnce());
    expect(mocks.undo).toHaveBeenCalledWith(
      expect.objectContaining({ patch: valid, rom, outputName: "edited.bin", compression: "none" }),
    );
  });
});
