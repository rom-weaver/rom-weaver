// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadLocalBundleSession } from "../../../src/lib/bundle/local-bundle-session.ts";
import { listDroppedArchiveEntryNames } from "../../../src/lib/input/input-preparation-archive.ts";
import { useUnifiedApplyDrop } from "../../../src/public/react/use-unified-apply-drop.ts";

// The drop router classifies a dropped archive by its entry names (a cheap content listing) to pick
// its bucket before staging; stub that listing so routing is tested without the wasm runtime.
vi.mock("../../../src/lib/input/input-preparation-archive.ts", () => ({
  listDroppedArchiveEntryNames: vi.fn(),
}));
vi.mock("../../../src/lib/bundle/local-bundle-session.ts", () => ({
  loadLocalBundleSession: vi.fn(),
}));
const mockedList = vi.mocked(listDroppedArchiveEntryNames);
const mockedLoadBundle = vi.mocked(loadLocalBundleSession);

const file = (name: string) => new File([new Uint8Array([0])], name);

const makeController = () => ({
  providePatchInputFiles: vi.fn(),
  provideRomInputFiles: vi.fn(),
});

beforeEach(() => {
  mockedList.mockReset();
  mockedLoadBundle.mockReset();
});

describe("useUnifiedApplyDrop", () => {
  it("routes an archive whose contents are a ROM to the ROM bucket", async () => {
    mockedList.mockResolvedValue(["disc.cue", "game.bin"]);
    const controller = makeController();
    const { result } = renderHook(() => useUnifiedApplyDrop(controller));

    act(() => result.current.onDrop([file("bundle.zip")]));

    expect(result.current.pendingDrops).toHaveLength(1);
    expect(result.current.pendingDrops[0]).toMatchObject({ extracting: true, kind: "patch", name: "bundle.zip" });
    await waitFor(() => expect(controller.provideRomInputFiles).toHaveBeenCalledTimes(1));
    expect(result.current.pendingDrops[0]).toMatchObject({ kind: "rom", sheet: "CUE" });
    await waitFor(() => expect(result.current.pendingDrops).toHaveLength(0));
    expect(controller.provideRomInputFiles.mock.calls[0]?.[0].map((entry: File) => entry.name)).toEqual(["bundle.zip"]);
    expect(controller.providePatchInputFiles).not.toHaveBeenCalled();
  });

  it("routes a patch-only archive straight to the patch bucket (no ROM-bucket detour)", async () => {
    mockedList.mockResolvedValue(["hack.ips"]);
    const controller = makeController();
    const { result } = renderHook(() => useUnifiedApplyDrop(controller));

    act(() => result.current.onDrop([file("patches.zip")]));

    expect(result.current.pendingDrops).toHaveLength(1);
    await waitFor(() => expect(controller.providePatchInputFiles).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.pendingDrops[0]?.name).toBe("hack.ips"));
    await waitFor(() => expect(result.current.pendingDrops).toHaveLength(0));
    expect(controller.providePatchInputFiles.mock.calls[0]?.[0].map((entry: File) => entry.name)).toEqual([
      "patches.zip",
    ]);
    expect(controller.provideRomInputFiles).not.toHaveBeenCalled();
  });

  it("defaults a no-ROM/no-patch archive to the ROM bucket (is_rom = has_rom || !has_patch)", async () => {
    mockedList.mockResolvedValue(["readme.txt"]);
    const controller = makeController();
    const { result } = renderHook(() => useUnifiedApplyDrop(controller));

    act(() => result.current.onDrop([file("bundle.zip")]));

    expect(result.current.pendingDrops).toHaveLength(1);
    await waitFor(() => expect(controller.provideRomInputFiles).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.pendingDrops).toHaveLength(0));
    expect(controller.provideRomInputFiles.mock.calls[0]?.[0].map((entry: File) => entry.name)).toEqual(["bundle.zip"]);
    expect(controller.providePatchInputFiles).not.toHaveBeenCalled();
  });

  it("routes bare ROMs to the ROM bucket and bare patches to the patch bucket (no listing needed)", async () => {
    const controller = makeController();
    const { result } = renderHook(() => useUnifiedApplyDrop(controller));

    act(() => result.current.onDrop([file("game.nes"), file("hack.ips")]));

    expect(result.current.pendingDrops).toHaveLength(0);
    await waitFor(() => expect(controller.provideRomInputFiles).toHaveBeenCalledTimes(1));
    expect(controller.provideRomInputFiles.mock.calls[0]?.[0].map((entry: File) => entry.name)).toEqual(["game.nes"]);
    expect(controller.providePatchInputFiles).toHaveBeenCalledTimes(1);
    expect(controller.providePatchInputFiles.mock.calls[0]?.[0].map((entry: File) => entry.name)).toEqual(["hack.ips"]);
    expect(mockedList).not.toHaveBeenCalled();
  });

  it("keeps a directly dropped CUE and its track together as one ROM", async () => {
    const controller = makeController();
    const selectFile = vi.fn();
    const { result } = renderHook(() => useUnifiedApplyDrop(controller, undefined, undefined, selectFile));
    const cue = new File(['FILE "disc.bin" BINARY\n  TRACK 01 MODE1/2352'], "disc.cue");
    const track = file("disc.bin");

    act(() => result.current.onDrop([cue, track]));

    await waitFor(() => expect(controller.provideRomInputFiles).toHaveBeenCalledOnce());
    expect(controller.provideRomInputFiles).toHaveBeenCalledWith([cue, track]);
    expect(selectFile).not.toHaveBeenCalled();
  });

  it("offers a directly dropped CUE group as one choice beside another ROM", async () => {
    const controller = makeController();
    const selectFile = vi.fn(async () => ({ id: "dropped-rom-0" }));
    const { result } = renderHook(() => useUnifiedApplyDrop(controller, undefined, undefined, selectFile));
    const cue = new File(['FILE "disc.bin" BINARY\n  TRACK 01 MODE1/2352'], "disc.cue");
    const track = file("disc.bin");

    act(() => result.current.onDrop([cue, track, file("other.nes")]));

    await waitFor(() => expect(controller.provideRomInputFiles).toHaveBeenCalledOnce());
    expect(controller.provideRomInputFiles).toHaveBeenCalledWith([cue, track]);
    expect(selectFile).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: [
          expect.objectContaining({ fileName: "disc.cue" }),
          expect.objectContaining({ fileName: "other.nes" }),
        ],
      }),
    );
  });

  it("keeps a CUE selectable when a sibling GDI cannot be read", async () => {
    const controller = makeController();
    const selectFile = vi.fn(async () => ({ id: "dropped-rom-0" }));
    const { result } = renderHook(() => useUnifiedApplyDrop(controller, undefined, undefined, selectFile));
    const cue = new File(['FILE "disc.bin" BINARY\n  TRACK 01 MODE1/2352'], "disc.cue");
    const gdi = file("disc.gdi");
    vi.spyOn(gdi, "text").mockRejectedValue(new Error("NotReadableError"));

    act(() => result.current.onDrop([cue, gdi]));

    await waitFor(() => expect(controller.provideRomInputFiles).toHaveBeenCalledOnce());
    expect(
      selectFile.mock.calls[0]?.[0].candidates.map((candidate: { fileName: string }) => candidate.fileName),
    ).toEqual(["disc.cue", "disc.gdi"]);
    expect(controller.provideRomInputFiles).toHaveBeenCalledWith([cue]);
  });

  it("ignores a ROM choice from a drop that a later ROM drop replaced", async () => {
    const controller = makeController();
    let answerFirstPrompt: (choice: { id: string }) => void = () => undefined;
    const selectFile = vi.fn(
      () =>
        new Promise<{ id: string }>((resolve) => {
          answerFirstPrompt = resolve;
        }),
    );
    const { result } = renderHook(() => useUnifiedApplyDrop(controller, undefined, undefined, selectFile));
    const replacement = file("replacement.nes");

    act(() => result.current.onDrop([file("first.nes"), file("second.nes")]));
    await waitFor(() => expect(selectFile).toHaveBeenCalledOnce());
    act(() => result.current.onDrop([replacement]));
    await waitFor(() => expect(controller.provideRomInputFiles).toHaveBeenCalledWith([replacement]));
    await act(async () => answerFirstPrompt({ id: "dropped-rom-0" }));

    expect(controller.provideRomInputFiles).toHaveBeenCalledOnce();
  });

  it("does not stage anything when the drop is cancelled", async () => {
    const controller = makeController();
    const { result } = renderHook(() => useUnifiedApplyDrop(controller));

    act(() => result.current.onDrop([file("bundle.zip")], () => true));

    await waitFor(() => expect(result.current.pendingDrops).toHaveLength(0));
    expect(controller.provideRomInputFiles).not.toHaveBeenCalled();
    expect(controller.providePatchInputFiles).not.toHaveBeenCalled();
  });

  it("aborts an in-flight bundle load when a newer drop replaces it", async () => {
    let bundleSignal: AbortSignal | undefined;
    mockedLoadBundle.mockImplementation((_bundle, _files, options) => {
      bundleSignal = options?.signal;
      return new Promise((_resolve, reject) => {
        bundleSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const controller = makeController();
    const onError = vi.fn();
    const { result } = renderHook(() => useUnifiedApplyDrop(controller, undefined, onError));

    act(() => result.current.onDrop([file("rom-weaver-bundle.json")]));
    await waitFor(() => expect(bundleSignal).toBeDefined());
    act(() => result.current.onDrop([file("game.nes")]));

    await waitFor(() => expect(bundleSignal?.aborted).toBe(true));
    await waitFor(() => expect(controller.provideRomInputFiles).toHaveBeenCalledOnce());
    expect(onError).not.toHaveBeenCalled();
  });

  it("treats an unknown bare input as a ROM replacement", async () => {
    let bundleSignal: AbortSignal | undefined;
    mockedLoadBundle.mockImplementation((_bundle, _files, options) => {
      bundleSignal = options?.signal;
      return new Promise((_resolve, reject) => {
        bundleSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const controller = makeController();
    const onError = vi.fn();
    const { result } = renderHook(() => useUnifiedApplyDrop(controller, undefined, onError));

    act(() => result.current.onDrop([file("rom-weaver-bundle.json")]));
    await waitFor(() => expect(bundleSignal).toBeDefined());
    act(() => result.current.onDrop([file("headerless-dump.mystery")]));

    await waitFor(() => expect(bundleSignal?.aborted).toBe(true));
    await waitFor(() => expect(controller.provideRomInputFiles).toHaveBeenCalledOnce());
    expect(controller.provideRomInputFiles.mock.calls[0]?.[0].map((entry: File) => entry.name)).toEqual([
      "headerless-dump.mystery",
    ]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps ROM-container overlaps such as RVZ on the ROM replacement path", async () => {
    let bundleSignal: AbortSignal | undefined;
    mockedLoadBundle.mockImplementation((_bundle, _files, options) => {
      bundleSignal = options?.signal;
      return new Promise((_resolve, reject) => {
        bundleSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    mockedList.mockResolvedValue(["game.iso"]);
    const controller = makeController();
    const { result } = renderHook(() => useUnifiedApplyDrop(controller));

    act(() => result.current.onDrop([file("rom-weaver-bundle.json")]));
    await waitFor(() => expect(bundleSignal).toBeDefined());
    act(() => result.current.onDrop([file("game.rvz")]));

    await waitFor(() => expect(bundleSignal?.aborted).toBe(true));
  });

  it("promotes a content-probed JSON bundle and supersedes an earlier in-flight archive", async () => {
    let finishListing: ((entries: string[]) => void) | undefined;
    mockedList.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishListing = resolve;
        }),
    );
    const bundlePatch = file("bundle.ips");
    mockedLoadBundle.mockResolvedValue({
      cleanup: vi.fn(async () => undefined),
      patchFiles: [bundlePatch],
      romFile: null,
      session: { key: "bundle-session" },
    } as never);
    const controller = makeController();
    const onBundleSession = vi.fn();
    const { result } = renderHook(() => useUnifiedApplyDrop(controller, onBundleSession));

    act(() => result.current.onDrop([file("earlier-patches.zip")]));
    await waitFor(() => expect(finishListing).toBeDefined());
    act(() => result.current.onDrop([file("rw.json")]));

    await waitFor(() => expect(onBundleSession).toHaveBeenCalledOnce());
    await waitFor(() => expect(controller.providePatchInputFiles).toHaveBeenCalledOnce());
    expect(controller.providePatchInputFiles).toHaveBeenCalledWith([bundlePatch]);
    act(() => finishListing?.(["earlier.ips"]));
    await waitFor(() => expect(result.current.pendingDrops).toHaveLength(0));
    expect(controller.providePatchInputFiles).toHaveBeenCalledOnce();
  });

  it("keeps a newer patch queued after an older archive is promoted to a bundle", async () => {
    let finishListing: ((entries: string[]) => void) | undefined;
    mockedList.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishListing = resolve;
        }),
    );
    const bundlePatch = file("bundle.ips");
    mockedLoadBundle.mockResolvedValue({
      cleanup: vi.fn(async () => undefined),
      patchFiles: [bundlePatch],
      romFile: null,
      session: { key: "bundle-session" },
    } as never);
    const delivered: string[] = [];
    const controller = makeController();
    controller.providePatchInputFiles.mockImplementation((files: File[]) => {
      delivered.push(...files.map((entry) => entry.name));
    });
    const { result } = renderHook(() => useUnifiedApplyDrop(controller));

    act(() => result.current.onDrop([file("possible-bundle.zip")]));
    await waitFor(() => expect(finishListing).toBeDefined());
    act(() => result.current.onDrop([file("later.ips")]));
    act(() => finishListing?.(["rom-weaver-bundle.json"]));

    await waitFor(() => expect(delivered).toEqual(["bundle.ips", "later.ips"]));
  });

  it("keeps an in-flight ROM archive drop when a patch-only drop is added", async () => {
    let finishListing: ((entries: string[]) => void) | undefined;
    mockedList.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishListing = resolve;
        }),
    );
    const controller = makeController();
    const { result } = renderHook(() => useUnifiedApplyDrop(controller));

    act(() => result.current.onDrop([file("game.rvz")]));
    await waitFor(() => expect(finishListing).toBeDefined());
    act(() => result.current.onDrop([file("change.ips")]));
    expect(controller.providePatchInputFiles).not.toHaveBeenCalled();
    act(() => finishListing?.(["game.iso"]));

    await waitFor(() => expect(controller.provideRomInputFiles).toHaveBeenCalledOnce());
    await waitFor(() => expect(controller.providePatchInputFiles).toHaveBeenCalledOnce());
    expect(controller.provideRomInputFiles.mock.calls[0]?.[0].map((entry: File) => entry.name)).toEqual(["game.rvz"]);
  });

  it("preserves patch-chain order when an archive listing is slower than the next bare patch", async () => {
    let finishListing: ((entries: string[]) => void) | undefined;
    mockedList.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishListing = resolve;
        }),
    );
    const delivered: string[] = [];
    const controller = makeController();
    controller.providePatchInputFiles.mockImplementation((files: File[]) => {
      delivered.push(...files.map((entry) => entry.name));
    });
    const { result } = renderHook(() => useUnifiedApplyDrop(controller));

    act(() => result.current.onDrop([file("first-patches.zip")]));
    await waitFor(() => expect(finishListing).toBeDefined());
    act(() => result.current.onDrop([file("second.ips")]));
    expect(delivered).toEqual([]);
    act(() => finishListing?.(["first.ips"]));

    await waitFor(() => expect(delivered).toEqual(["first-patches.zip", "second.ips"]));
  });

  it("keeps an earlier patch archive ahead of a later replacement ROM", async () => {
    let finishListing: ((entries: string[]) => void) | undefined;
    mockedList.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishListing = resolve;
        }),
    );
    const delivered: string[] = [];
    const controller = makeController();
    controller.providePatchInputFiles.mockImplementation((files: File[]) => {
      delivered.push(...files.map((entry) => `patch:${entry.name}`));
    });
    controller.provideRomInputFiles.mockImplementation((files: File[]) => {
      delivered.push(...files.map((entry) => `rom:${entry.name}`));
    });
    const { result } = renderHook(() => useUnifiedApplyDrop(controller));

    act(() => result.current.onDrop([file("first-patches.zip")]));
    await waitFor(() => expect(finishListing).toBeDefined());
    act(() => result.current.onDrop([file("game.nes")]));
    expect(delivered).toEqual([]);
    act(() => finishListing?.(["first.ips"]));

    await waitFor(() => expect(delivered).toEqual(["patch:first-patches.zip", "rom:game.nes"]));
  });

  it("aborts an in-flight bundle load when the drop router unmounts", async () => {
    let bundleSignal: AbortSignal | undefined;
    mockedLoadBundle.mockImplementation((_bundle, _files, options) => {
      bundleSignal = options?.signal;
      return new Promise((_resolve, reject) => {
        bundleSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const controller = makeController();
    const { result, unmount } = renderHook(() => useUnifiedApplyDrop(controller));

    act(() => result.current.onDrop([file("rom-weaver-bundle.json")]));
    await waitFor(() => expect(bundleSignal).toBeDefined());
    unmount();

    expect(bundleSignal?.aborted).toBe(true);
  });
});
