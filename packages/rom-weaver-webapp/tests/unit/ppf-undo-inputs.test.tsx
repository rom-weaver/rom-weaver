// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePpfUndoInputs } from "../../src/webapp/components/ppf-undo-inputs.tsx";

const mocks = vi.hoisted(() => ({ ingest: vi.fn(), select: vi.fn() }));
vi.mock("../../src/platform/browser/workflow-runtime.ts", () => ({
  browserRuntime: { ingest: { run: mocks.ingest } },
}));
vi.mock("../../src/public/react/candidate-selection.tsx", () => ({
  useCandidateSelection: () => ({ candidateSelectionDialog: null, selectFile: mocks.select }),
}));

const output = (path: string, bytes: string) => ({
  fileName: path.split("/").pop(),
  path,
  dispose: vi.fn().mockResolvedValue(undefined),
  vfs: { getFile: vi.fn().mockResolvedValue(new File([bytes], "stored")) },
});
const asset = (path: string) => ({ path, fileName: path.split("/").pop() });
const patch = (leafPath: string, format = "ppf", isValidPatch = true) => ({
  leafPath,
  fileName: leafPath.split("/").pop(),
  format,
  isValidPatch,
});

describe("PPF Undo ingestion", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses full output paths when archive members share a basename and disposes unpicked outputs", async () => {
    const first = output("/a/game.bin", "first");
    const second = output("/b/game.bin", "second");
    const ppf = output("/update.ppf", "patch");
    mocks.ingest.mockResolvedValue({
      result: { assets: [asset(first.path), asset(second.path)], patches: [patch(ppf.path)] },
      outputs: [first, second],
      patchOutputs: [ppf],
    });
    mocks.select.mockResolvedValue({ id: "1" });
    const onInputs = vi.fn();
    const { result, unmount } = renderHook(() => usePpfUndoInputs(onInputs, vi.fn()));
    await act(async () => result.current.stage([new File(["zip"], "input.zip")]));
    expect(mocks.ingest).toHaveBeenCalledWith(expect.objectContaining({ select: ["**"] }));
    const [rom, selectedPatch] = onInputs.mock.calls[0];
    expect(result.current.getPrepared(rom)?.output).toBe(second);
    expect(result.current.getPrepared(selectedPatch)?.output).toBe(ppf);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.dispose).not.toHaveBeenCalled();
    expect(result.current.warnings).toContain("Choose one patched ROM; the other inputs will be ignored.");
    act(() => result.current.release(rom));
    expect(second.dispose).toHaveBeenCalledOnce();
    unmount();
    expect(ppf.dispose).toHaveBeenCalledOnce();
  });

  it("rejects unsupported and malformed patches without handing them to the undo action", async () => {
    mocks.ingest.mockResolvedValue({
      result: { assets: [], patches: [patch("/valid.ips", "ips"), patch("/bad.ppf", "ppf", false)] },
      outputs: [],
      patchOutputs: [],
    });
    const onInputs = vi.fn();
    const onError = vi.fn();
    const { result } = renderHook(() => usePpfUndoInputs(onInputs, onError));
    await act(async () => result.current.stage([new File(["archive"], "patches.zip")]));
    expect(onInputs).toHaveBeenCalledWith(undefined, null);
    expect(onError).toHaveBeenCalledWith("No valid PPF patch was selected. Replace the invalid input to continue.");
    expect(result.current.warnings).toEqual([
      "Ignored valid.ips: PPF Undo requires a valid PPF patch.",
      "Ignored bad.ppf: PPF Undo requires a valid PPF patch.",
    ]);
  });

  it.each([
    { sheetPath: "/disc/disc.cue", trackPath: "/disc/tracks/track.bin", target: "tracks/track.bin" },
    { sheetPath: "/disc/sheets/disc.cue", trackPath: "/disc/tracks/track.bin", target: "../tracks/track.bin" },
    { sheetPath: "/disc.cue", trackPath: "/track.bin", target: "track.bin" },
  ])(
    "retains disc companions and selects the track relative to $sheetPath",
    async ({ sheetPath, trackPath, target }) => {
      const sheet = output(sheetPath, `FILE ${target} BINARY`);
      const track = output(trackPath, "track");
      const audio = output("/disc/audio.bin", "audio");
      mocks.ingest.mockResolvedValue({
        result: {
          assets: [
            { ...asset(sheet.path), kind: "cue", discGroupId: "disc" },
            { ...asset(track.path), kind: "bin", discGroupId: "disc" },
            { ...asset(audio.path), kind: "bin", discGroupId: "disc" },
          ],
          patches: [],
        },
        outputs: [sheet, track, audio],
        patchOutputs: [],
      });
      mocks.select.mockResolvedValue({ id: "0" });
      const onInputs = vi.fn();
      const { result } = renderHook(() => usePpfUndoInputs(onInputs, vi.fn()));
      await act(async () => result.current.stage([new File(["zip"], "disc.zip")]));
      const [rom] = onInputs.mock.calls[0];
      expect(rom.name).toBe("track.bin");
      expect(
        mocks.select.mock.calls[0][0].candidates.map((candidate: { fileName: string }) => candidate.fileName),
      ).toEqual(["track.bin", "audio.bin"]);
      expect(result.current.getPrepared(rom)?.output).toBe(sheet);
      expect(result.current.getPrepared(rom)?.target).toBe(target);
      expect(result.current.getPrepared(rom)?.companions).toEqual([track, audio]);
      expect(audio.dispose).not.toHaveBeenCalled();
      act(() => result.current.release(rom));
      for (const entry of [sheet, track, audio]) expect(entry.dispose).toHaveBeenCalledOnce();
    },
  );

  it("disposes extracted files when candidate selection is cancelled and permits a later replacement", async () => {
    const first = output("/one.bin", "one");
    const second = output("/two.bin", "two");
    mocks.ingest.mockResolvedValueOnce({
      result: { assets: [asset(first.path), asset(second.path)], patches: [] },
      outputs: [first, second],
      patchOutputs: [],
    });
    mocks.select.mockRejectedValue(new Error("Selection skipped"));
    const onInputs = vi.fn();
    const onError = vi.fn();
    const { result } = renderHook(() => usePpfUndoInputs(onInputs, onError));
    await act(async () => result.current.stage([new File(["archive"], "two.zip")]));
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.dispose).toHaveBeenCalledOnce();
    expect(onInputs).toHaveBeenCalledWith(null, null);
    expect(onError).toHaveBeenCalledWith("Selection skipped");
    mocks.ingest.mockResolvedValueOnce({
      result: { assets: [], patches: [patch("/replacement.ppf")] },
      outputs: [],
      patchOutputs: [],
    });
    const replacement = new File(["ppf"], "replacement.ppf");
    await act(async () => result.current.stage([replacement]));
    expect(onInputs).toHaveBeenCalledWith(undefined, replacement);
    expect(result.current.opening).toBe(false);
  });
});
