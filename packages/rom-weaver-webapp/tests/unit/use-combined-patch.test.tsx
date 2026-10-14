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
});
