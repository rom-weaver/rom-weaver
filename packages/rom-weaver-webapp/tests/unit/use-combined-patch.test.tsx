// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserCreateResult } from "../../src/platform/browser/browser-api.ts";
import { useCombinedPatch } from "../../src/public/react/use-combined-patch.tsx";

vi.mock("../../src/public/react/settings-context.tsx", () => ({
  useUiLocalizer: () => ({ message: (key: string) => key }),
}));

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const createdPatch = () => {
  const bytes = new Uint8Array([66, 80, 83, 49, 7, 8]);
  const blob = new Blob([bytes]);
  const downloaded: number[][] = [];
  const result: BrowserCreateResult = {
    original: { id: "rom", fileName: "original.nes", kind: "rom", size: 16 },
    type: "bps",
    output: {
      id: "patch",
      fileName: "combined.bps",
      storage: "blob",
      size: bytes.length,
      getBlob: vi.fn(async () => blob),
      dispose: vi.fn(async () => undefined),
      prepareDownload: vi.fn(async () => undefined),
      saveAs: vi.fn(async () => {
        downloaded.push([...new Uint8Array(await blob.arrayBuffer())]);
      }),
    },
  };
  return { result, downloaded, bytes };
};

type Options = Parameters<typeof useCombinedPatch>[0];
const options = (run: Options["run"], overrides: Partial<Options> = {}): Options => ({
  run,
  revision: "patch-a,cheat-b",
  name: "game.nes",
  ready: true,
  disabled: false,
  ...overrides,
});

afterEach(cleanup);

describe("useCombinedPatch", () => {
  it("creates and downloads the patch bytes, guards duplicate clicks, and reports the result once", async () => {
    const pending = deferred<BrowserCreateResult>();
    const patch = createdPatch();
    const run = vi.fn<Options["run"]>(() => pending.promise);
    const onComplete = vi.fn();
    const { result } = renderHook(() => useCombinedPatch(options(run, { onComplete })));
    let first!: Promise<void>;
    await act(async () => {
      first = result.current.run();
      await result.current.run();
    });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0].settings).toMatchObject({
      format: "bps",
      output: { outputName: "game-combined.bps", compression: "none" },
    });
    await act(async () => {
      pending.resolve(patch.result);
      await first;
    });
    expect(patch.downloaded).toEqual([[...patch.bytes]]);
    expect(onComplete).toHaveBeenCalledExactlyOnceWith(patch.result);
    await act(async () => result.current.run());
    expect(run).toHaveBeenCalledOnce();
    expect(patch.result.output.saveAs).toHaveBeenLastCalledWith({ interactive: true });
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("disposes a late cancelled result and permits a fresh run", async () => {
    const pending = deferred<BrowserCreateResult>();
    const late = createdPatch();
    const fresh = createdPatch();
    const run = vi.fn<Options["run"]>().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(fresh.result);
    const onComplete = vi.fn();
    const { result } = renderHook(() => useCombinedPatch(options(run, { onComplete })));
    let running!: Promise<void>;
    await act(async () => {
      running = result.current.run();
    });
    act(() => result.current.cancel());
    expect(run.mock.calls[0][0].signal.aborted).toBe(true);
    await act(async () => {
      pending.resolve(late.result);
      await running;
    });
    expect(late.result.output.dispose).toHaveBeenCalledOnce();
    expect(late.result.output.saveAs).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    await act(async () => result.current.run());
    expect(fresh.result.output.saveAs).toHaveBeenCalledOnce();
  });

  it.each(["revision", "name", "settings"] as const)("invalidates cached output when %s changes", async (field) => {
    const patch = createdPatch();
    const run = vi.fn<Options["run"]>().mockResolvedValue(patch.result);
    const initial = options(run);
    const { result, rerender } = renderHook((props: Options) => useCombinedPatch(props), { initialProps: initial });
    await act(async () => result.current.run());
    const next = {
      ...initial,
      [field]: field === "settings" ? { patch: { metadata: { description: "changed" } } } : "changed",
    };
    rerender(next);
    expect(patch.result.output.dispose).toHaveBeenCalledOnce();
    await act(async () => result.current.run());
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("finishes a run when the default name changes while it prepares", async () => {
    const pending = deferred<BrowserCreateResult>();
    const patch = createdPatch();
    const run = vi.fn<Options["run"]>().mockReturnValue(pending.promise);
    const initial = options(run);
    const { result, rerender } = renderHook((props: Options) => useCombinedPatch(props), { initialProps: initial });
    let running!: Promise<void>;
    await act(async () => {
      running = result.current.run();
    });
    rerender({ ...initial, name: "game [patch].nes" });
    expect(run.mock.calls[0][0].signal.aborted).toBe(false);
    await act(async () => {
      pending.resolve(patch.result);
      await running;
    });
    expect(patch.downloaded).toEqual([[...patch.bytes]]);
  });

  it("keeps a created patch after download failure and retries without creating it again", async () => {
    const patch = createdPatch();
    vi.mocked(patch.result.output.saveAs).mockRejectedValueOnce(new Error("download failed"));
    const run = vi.fn<Options["run"]>().mockResolvedValue(patch.result);
    const onComplete = vi.fn();
    const onError = vi.fn();
    const { result } = renderHook(() => useCombinedPatch(options(run, { onComplete, onError })));
    await act(async () => result.current.run());
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "download failed" }));
    expect(onComplete).not.toHaveBeenCalled();
    expect(patch.result.output.dispose).not.toHaveBeenCalled();
    await act(async () => result.current.run());
    expect(run).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledExactlyOnceWith(patch.result);
    expect(patch.downloaded).toEqual([[...patch.bytes]]);
  });

  it("cleans a stale result after revision changes and after unmount", async () => {
    const pending = deferred<BrowserCreateResult>();
    const patch = createdPatch();
    const run = vi.fn<Options["run"]>().mockReturnValue(pending.promise);
    const { result, rerender, unmount } = renderHook(
      (revision: string) => useCombinedPatch(options(run, { revision })),
      { initialProps: "first" },
    );
    let running!: Promise<void>;
    await act(async () => {
      running = result.current.run();
    });
    rerender("second");
    expect(run.mock.calls[0][0].signal.aborted).toBe(true);
    unmount();
    await act(async () => {
      pending.resolve(patch.result);
      await running;
    });
    expect(patch.result.output.dispose).toHaveBeenCalledOnce();
    expect(patch.result.output.saveAs).not.toHaveBeenCalled();
  });

  it("retries a failed creation and disposes its cached result on unmount", async () => {
    const patch = createdPatch();
    const run = vi
      .fn<Options["run"]>()
      .mockRejectedValueOnce(new Error("create failed"))
      .mockResolvedValueOnce(patch.result);
    const onError = vi.fn();
    const { result, unmount } = renderHook(() => useCombinedPatch(options(run, { onError })));
    await act(async () => result.current.run());
    expect(result.current.busy).toBe(false);
    expect(onError).toHaveBeenCalledOnce();
    await act(async () => result.current.run());
    expect(run).toHaveBeenCalledTimes(2);
    unmount();
    expect(patch.result.output.dispose).toHaveBeenCalledOnce();
  });

  it("offers only formats that fit the ROM and patch output sizes", async () => {
    const patch = createdPatch();
    const run = vi.fn<Options["run"]>().mockResolvedValue(patch.result);
    const formatValues = (current: ReturnType<typeof useCombinedPatch>) =>
      current.outputProps.formatOptions?.map((option) => option.value);
    const { result, rerender } = renderHook((sizes: Partial<Options>) => useCombinedPatch(options(run, sizes)), {
      initialProps: { patchType: "ips" },
    });
    expect(formatValues(result.current)).toContain("ips");
    expect(result.current.outputProps.format).toBe("ips");

    // IPS stops at 16 MiB, so a larger declared patch output drops it and the choice falls back to BPS.
    rerender({ patchType: "ips", romSize: 1024, patchTargetSize: 20 * 1024 * 1024 });
    expect(formatValues(result.current)).not.toContain("ips");
    expect(result.current.outputProps.format).toBe("bps");
    await act(async () => result.current.run());
    expect(run.mock.calls[0][0].settings).toMatchObject({
      format: "bps",
      output: { outputName: "game-combined.bps" },
    });

    rerender({ patchType: "bps", romSize: 300 * 1024 * 1024 });
    expect(formatValues(result.current)).toEqual(["xdelta", "ppf"]);
    expect(result.current.outputProps.format).toBe("xdelta");
  });

  it("withholds IPS32 unless the combined output is known not to shrink", () => {
    const run = vi.fn<Options["run"]>();
    const formatValues = (current: ReturnType<typeof useCombinedPatch>) =>
      current.outputProps.formatOptions?.map((option) => option.value);
    const { result, rerender } = renderHook((sizes: Partial<Options>) => useCombinedPatch(options(run, sizes)), {
      initialProps: { patchType: "bps", romSize: 2048, patchTargetSize: 0 } as Partial<Options>,
    });
    // IPS reports no target size, so a truncating patch is indistinguishable from a growing one.
    expect(formatValues(result.current)).not.toContain("ips32");
    rerender({ patchType: "ips32", romSize: 2048, patchTargetSize: 0 });
    expect(result.current.outputProps.format).not.toBe("ips32");
    rerender({ patchType: "bps", romSize: 2048, patchTargetSize: 1024 });
    expect(formatValues(result.current)).not.toContain("ips32");
    rerender({ patchType: "bps", romSize: 2048, patchTargetSize: 4096 });
    expect(formatValues(result.current)).toEqual(expect.arrayContaining(["ips32"]));
  });

  it("keeps a running job's sizes while preparing the run clears them", async () => {
    const pending = deferred<BrowserCreateResult>();
    const patch = createdPatch();
    const run = vi.fn<Options["run"]>(() => pending.promise);
    const onError = vi.fn();
    const large = { patchType: "ips", romSize: 8 * 1024 * 1024, patchTargetSize: 64 * 1024 * 1024 };
    const { result, rerender } = renderHook((sizes: Partial<Options>) => useCombinedPatch(options(run, sizes)), {
      initialProps: large,
    });
    expect(result.current.outputProps.format).toBe("bps");
    let running!: Promise<void>;
    await act(async () => {
      running = result.current.run();
    });
    // Re-staging the enabled patches drops their declared sizes until they parse again.
    rerender({ ...large, patchTargetSize: 0 });
    expect(run.mock.calls[0][0].signal.aborted).toBe(false);
    expect(result.current.outputProps.format).toBe("bps");
    rerender(large);
    await act(async () => {
      pending.resolve(patch.result);
      await running;
    });
    expect(patch.result.output.saveAs).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(patch.result.output.dispose).not.toHaveBeenCalled();
  });
});
