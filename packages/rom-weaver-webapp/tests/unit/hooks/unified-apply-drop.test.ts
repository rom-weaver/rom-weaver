// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadLocalWeaveSession } from "../../../src/lib/weave/local-weave-session.ts";
import {
  listDroppedArchiveEntryNames,
  probeDroppedInputKind,
} from "../../../src/lib/input/input-preparation-archive.ts";
import { useUnifiedApplyDrop } from "../../../src/public/react/use-unified-apply-drop.ts";

// The drop router classifies a dropped archive by its entry names (a cheap content listing) to pick
// its bucket before staging; stub that listing so routing is tested without the wasm runtime.
vi.mock("../../../src/lib/input/input-preparation-archive.ts", () => ({
  listDroppedArchiveEntryNames: vi.fn(),
  probeDroppedInputKind: vi.fn(),
}));
vi.mock("../../../src/lib/weave/local-weave-session.ts", () => ({
  loadLocalWeaveSession: vi.fn(),
}));
const mockedList = vi.mocked(listDroppedArchiveEntryNames);
const mockedProbe = vi.mocked(probeDroppedInputKind);
const mockedLoadWeave = vi.mocked(loadLocalWeaveSession);

const file = (name: string) => new File([new Uint8Array([0])], name);

const makeController = () => ({
  providePatchInputFiles: vi.fn(),
  provideRomInputFiles: vi.fn(),
});

beforeEach(() => {
  mockedList.mockReset();
  mockedProbe.mockReset();
  mockedLoadWeave.mockReset();
});

describe("useUnifiedApplyDrop", () => {
  it("keeps directly dropped NFS parts and the key together beside another ROM", async () => {
    mockedList.mockResolvedValue([]);
    const controller = makeController();
    const selectFile = vi.fn(async (_request: import("../../../src/types/selection.ts").CandidateSelectionRequest) => ({
      id: "dropped-rom-0",
    }));
    const { result } = renderHook(() => useUnifiedApplyDrop(controller, undefined, undefined, selectFile));
    const source = file("hif_000000.nfs");
    const part = file("hif_000001.nfs");
    const key = file("htk.bin");
    act(() => result.current.onDrop([key, part, source, file("other.nes")]));
    await waitFor(() => expect(controller.provideRomInputFiles).toHaveBeenCalledOnce());
    expect(controller.provideRomInputFiles).toHaveBeenCalledWith([source, key, part]);
    expect(mockedList).not.toHaveBeenCalled();
    expect(
      selectFile.mock.calls[0]?.[0].candidates.map((candidate: { fileName: string }) => candidate.fileName),
    ).toEqual(["hif_000000.nfs", "other.nes"]);
  });

  it("routes an archive whose contents are a ROM to the ROM bucket", async () => {
    mockedList.mockResolvedValue(["disc.cue", "game.bin"]);
    const controller = makeController();
    const { result } = renderHook(() => useUnifiedApplyDrop(controller));

    act(() => result.current.onDrop([file("weave.zip")]));

    expect(result.current.pendingDrops).toHaveLength(1);
    expect(result.current.pendingDrops[0]).toMatchObject({ extracting: true, kind: "patch", name: "weave.zip" });
    await waitFor(() => expect(controller.provideRomInputFiles).toHaveBeenCalledTimes(1));
    expect(result.current.pendingDrops[0]).toMatchObject({ kind: "rom", sheet: "CUE" });
    await waitFor(() => expect(result.current.pendingDrops).toHaveLength(0));
    expect(controller.provideRomInputFiles.mock.calls[0]?.[0].map((entry: File) => entry.name)).toEqual(["weave.zip"]);
    expect(controller.providePatchInputFiles).not.toHaveBeenCalled();
  });

  it("stages a mixed ROM and patch archive once so extracted sidecars are not ingested again", async () => {
    mockedList.mockResolvedValue(["game.nes", "first.ips", "second.bps"]);
    const controller = makeController();
    const { result } = renderHook(() => useUnifiedApplyDrop(controller));
    const archive = file("mixed.zip");
    const directPatch = file("third.ips");

    act(() => result.current.onDrop([archive, directPatch]));

    await waitFor(() => expect(controller.provideRomInputFiles).toHaveBeenCalledExactlyOnceWith([archive]));
    await waitFor(() => expect(controller.providePatchInputFiles).toHaveBeenCalledExactlyOnceWith([directPatch]));
    await waitFor(() => expect(result.current.pendingDrops).toHaveLength(0));
    expect(mockedList).toHaveBeenCalledExactlyOnceWith(archive);
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

    act(() => result.current.onDrop([file("weave.zip")]));

    expect(result.current.pendingDrops).toHaveLength(1);
    await waitFor(() => expect(controller.provideRomInputFiles).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.pendingDrops).toHaveLength(0));
    expect(controller.provideRomInputFiles.mock.calls[0]?.[0].map((entry: File) => entry.name)).toEqual(["weave.zip"]);
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

  it("keeps a loose GDI and all referenced tracks together alongside a patch", async () => {
    const controller = makeController();
    const selectFile = vi.fn(async () => ({ id: "dropped-rom-0" }));
    const { result } = renderHook(() => useUnifiedApplyDrop(controller, undefined, undefined, selectFile));
    const gdi = new File(['2\n1 0 0 2352 track01.bin 0\n2 45000 4 2352 "track 02.bin" 0\n'], "disc.gdi");
    const tracks = [file("track01.bin"), file("track 02.bin")];
    const patch = file("change.ips");

    act(() => result.current.onDrop([tracks[0], gdi, tracks[1], patch]));

    await waitFor(() => expect(controller.provideRomInputFiles).toHaveBeenCalledOnce());
    expect(controller.provideRomInputFiles).toHaveBeenCalledWith([gdi, ...tracks]);
    expect(controller.providePatchInputFiles).toHaveBeenCalledWith([patch]);
    expect(selectFile).not.toHaveBeenCalled();
  });

  it("offers a GDI and its track as one choice beside an unrelated ROM", async () => {
    const controller = makeController();
    const selectFile = vi.fn(async () => ({ id: "dropped-rom-0" }));
    const { result } = renderHook(() => useUnifiedApplyDrop(controller, undefined, undefined, selectFile));
    const gdi = new File(["1\n1 45000 4 2352 track01.bin 0\n"], "disc.gdi");
    const track = file("track01.bin");

    act(() => result.current.onDrop([gdi, track, file("other.nes")]));

    await waitFor(() => expect(controller.provideRomInputFiles).toHaveBeenCalledOnce());
    expect(controller.provideRomInputFiles).toHaveBeenCalledWith([gdi, track]);
    expect(selectFile).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: [
          expect.objectContaining({ fileName: "disc.gdi", size: gdi.size + track.size }),
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

    act(() => result.current.onDrop([file("weave.zip")], () => true));

    await waitFor(() => expect(result.current.pendingDrops).toHaveLength(0));
    expect(controller.provideRomInputFiles).not.toHaveBeenCalled();
    expect(controller.providePatchInputFiles).not.toHaveBeenCalled();
  });

  it("aborts an in-flight weave load when a newer drop replaces it", async () => {
    let weaveSignal: AbortSignal | undefined;
    mockedLoadWeave.mockImplementation((_weave, _files, options) => {
      weaveSignal = options?.signal;
      return new Promise((_resolve, reject) => {
        weaveSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const controller = makeController();
    const onError = vi.fn();
    const { result } = renderHook(() => useUnifiedApplyDrop(controller, undefined, onError));

    act(() => result.current.onDrop([file("rom-weaver-weave.json")]));
    await waitFor(() => expect(weaveSignal).toBeDefined());
    act(() => result.current.onDrop([file("game.nes")]));

    await waitFor(() => expect(weaveSignal?.aborted).toBe(true));
    await waitFor(() => expect(controller.provideRomInputFiles).toHaveBeenCalledOnce());
    expect(onError).not.toHaveBeenCalled();
  });

  it("treats an unknown bare input as a ROM replacement", async () => {
    let weaveSignal: AbortSignal | undefined;
    mockedLoadWeave.mockImplementation((_weave, _files, options) => {
      weaveSignal = options?.signal;
      return new Promise((_resolve, reject) => {
        weaveSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const controller = makeController();
    const onError = vi.fn();
    const { result } = renderHook(() => useUnifiedApplyDrop(controller, undefined, onError));

    act(() => result.current.onDrop([file("rom-weaver-weave.json")]));
    await waitFor(() => expect(weaveSignal).toBeDefined());
    act(() => result.current.onDrop([file("headerless-dump.mystery")]));

    await waitFor(() => expect(weaveSignal?.aborted).toBe(true));
    await waitFor(() => expect(controller.provideRomInputFiles).toHaveBeenCalledOnce());
    expect(controller.provideRomInputFiles.mock.calls[0]?.[0].map((entry: File) => entry.name)).toEqual([
      "headerless-dump.mystery",
    ]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps ROM-container overlaps such as RVZ on the ROM replacement path", async () => {
    let weaveSignal: AbortSignal | undefined;
    mockedLoadWeave.mockImplementation((_weave, _files, options) => {
      weaveSignal = options?.signal;
      return new Promise((_resolve, reject) => {
        weaveSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    mockedList.mockResolvedValue(["game.iso"]);
    const controller = makeController();
    const { result } = renderHook(() => useUnifiedApplyDrop(controller));

    act(() => result.current.onDrop([file("rom-weaver-weave.json")]));
    await waitFor(() => expect(weaveSignal).toBeDefined());
    act(() => result.current.onDrop([file("game.rvz")]));

    await waitFor(() => expect(weaveSignal?.aborted).toBe(true));
  });

  it("promotes a content-probed JSON weave and supersedes an earlier in-flight archive", async () => {
    let finishListing: ((entries: string[]) => void) | undefined;
    mockedList.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishListing = resolve;
        }),
    );
    const weavePatch = file("weave.ips");
    mockedLoadWeave.mockResolvedValue({
      cleanup: vi.fn(async () => undefined),
      patchFiles: [weavePatch],
      romFile: null,
      session: { key: "weave-session" },
    } as never);
    const controller = makeController();
    const onWeaveSession = vi.fn();
    const { result } = renderHook(() => useUnifiedApplyDrop(controller, onWeaveSession));

    act(() => result.current.onDrop([file("earlier-patches.zip")]));
    await waitFor(() => expect(finishListing).toBeDefined());
    act(() => result.current.onDrop([file("rw.json")]));

    await waitFor(() => expect(onWeaveSession).toHaveBeenCalledOnce());
    await waitFor(() => expect(controller.providePatchInputFiles).toHaveBeenCalledOnce());
    expect(controller.providePatchInputFiles).toHaveBeenCalledWith([weavePatch]);
    act(() => finishListing?.(["earlier.ips"]));
    await waitFor(() => expect(result.current.pendingDrops).toHaveLength(0));
    expect(controller.providePatchInputFiles).toHaveBeenCalledOnce();
  });

  it("keeps a newer patch queued after an older archive is promoted to a weave", async () => {
    let finishListing: ((entries: string[]) => void) | undefined;
    mockedList.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishListing = resolve;
        }),
    );
    const weavePatch = file("weave.ips");
    mockedLoadWeave.mockResolvedValue({
      cleanup: vi.fn(async () => undefined),
      patchFiles: [weavePatch],
      romFile: null,
      session: { key: "weave-session" },
    } as never);
    const delivered: string[] = [];
    const controller = makeController();
    controller.providePatchInputFiles.mockImplementation((files: File[]) => {
      delivered.push(...files.map((entry) => entry.name));
    });
    const { result } = renderHook(() => useUnifiedApplyDrop(controller));

    act(() => result.current.onDrop([file("possible-weave.zip")]));
    await waitFor(() => expect(finishListing).toBeDefined());
    act(() => result.current.onDrop([file("later.ips")]));
    act(() => finishListing?.(["rom-weaver-weave.json"]));

    await waitFor(() => expect(delivered).toEqual(["weave.ips", "later.ips"]));
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

  it.each([
    ["cue", 'FILE "disc.bin" BINARY\n  TRACK 01 MODE1/2352'],
    ["gdi", "1\n1 45000 4 2352 disc.bin 0\n"],
  ])(
    "stages a directly dropped %s and its track as the companion ROM of a checks-only weave",
    async (extension, text) => {
      mockedLoadWeave.mockResolvedValue({
        cleanup: vi.fn(async () => undefined),
        patchFiles: [file("weave.ips")],
        romFile: null,
        session: { key: "weave-session" },
      } as never);
      const controller = makeController();
      const onWeaveSession = vi.fn();
      const selectFile = vi.fn();
      const { result } = renderHook(() => useUnifiedApplyDrop(controller, onWeaveSession, undefined, selectFile));
      const cue = new File([text], `disc.${extension}`);
      const track = file("disc.bin");

      act(() => result.current.onDrop([file("rom-weaver-weave.json"), cue, track]));

      await waitFor(() => expect(controller.provideRomInputFiles).toHaveBeenCalledExactlyOnceWith([cue, track]));
      expect(onWeaveSession).toHaveBeenCalledOnce();
      expect(selectFile).not.toHaveBeenCalled();
    },
  );

  it("asks which companion ROM to use when a checks-only weave arrives with several", async () => {
    mockedList.mockResolvedValue(["game.nes"]);
    mockedLoadWeave.mockResolvedValue({
      cleanup: vi.fn(async () => undefined),
      patchFiles: [file("weave.ips")],
      romFile: null,
      session: { key: "weave-session" },
    } as never);
    const controller = makeController();
    const selectFile = vi.fn(async () => ({ id: "dropped-rom-1" }));
    const { result } = renderHook(() => useUnifiedApplyDrop(controller, undefined, undefined, selectFile));
    const archivedRom = file("rom.zip");

    act(() => result.current.onDrop([file("rom-weaver-weave.json"), file("other.nes"), archivedRom]));

    await waitFor(() => expect(controller.provideRomInputFiles).toHaveBeenCalledExactlyOnceWith([archivedRom]));
    expect(
      selectFile.mock.calls[0]?.[0].candidates.map((candidate: { fileName: string }) => candidate.fileName),
    ).toEqual(["other.nes", "rom.zip"]);
  });

  it("aborts an in-flight weave load when the drop router unmounts", async () => {
    let weaveSignal: AbortSignal | undefined;
    mockedLoadWeave.mockImplementation((_weave, _files, options) => {
      weaveSignal = options?.signal;
      return new Promise((_resolve, reject) => {
        weaveSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const controller = makeController();
    const { result, unmount } = renderHook(() => useUnifiedApplyDrop(controller));

    act(() => result.current.onDrop([file("rom-weaver-weave.json")]));
    await waitFor(() => expect(weaveSignal).toBeDefined());
    unmount();

    expect(weaveSignal?.aborted).toBe(true);
  });

  describe("held-back drops", () => {
    const setup = () => {
      const controller = makeController();
      const onRejected = vi.fn();
      const selectFile = vi.fn(
        async (_request: import("../../../src/types/selection.ts").CandidateSelectionRequest) => ({
          id: "dropped-rom-0",
        }),
      );
      const { result } = renderHook(() =>
        useUnifiedApplyDrop(controller, undefined, undefined, selectFile, onRejected),
      );
      return { controller, onRejected, result, selectFile };
    };

    it("rejects split WBFS parts instead of offering them as alternative ROMs", async () => {
      const { controller, onRejected, result, selectFile } = setup();
      const patch = file("flip.bps");
      act(() => result.current.onDrop([file("Disc.wbfs"), file("Disc.wbf1"), file("Disc.wbf2"), patch]));
      await waitFor(() => expect(controller.providePatchInputFiles).toHaveBeenCalledExactlyOnceWith([patch]));
      expect(onRejected).toHaveBeenCalledExactlyOnceWith({
        kind: "splitWbfs",
        names: ["Disc.wbfs", "Disc.wbf1", "Disc.wbf2"],
      });
      expect(mockedList).not.toHaveBeenCalled();
      expect(selectFile).not.toHaveBeenCalled();
      expect(controller.provideRomInputFiles).not.toHaveBeenCalled();
    });

    it("keeps a lone .wbfs routable", async () => {
      mockedList.mockResolvedValue(["disc.iso"]);
      const { controller, onRejected, result } = setup();
      act(() => result.current.onDrop([file("Disc.wbfs")]));
      await waitFor(() => expect(controller.provideRomInputFiles).toHaveBeenCalledOnce());
      expect(onRejected).not.toHaveBeenCalled();
    });

    it("holds back an archive with only unrecognised entries instead of offering it as a second ROM", async () => {
      mockedList.mockResolvedValue(["readme.txt"]);
      const { controller, onRejected, result, selectFile } = setup();
      const rom = file("base.bin");
      act(() => result.current.onDrop([rom, file("mystery.zip"), file("flip.bps")]));
      await waitFor(() => expect(controller.provideRomInputFiles).toHaveBeenCalledExactlyOnceWith([rom]));
      expect(onRejected).toHaveBeenCalledExactlyOnceWith({ kind: "unsupportedPatch", names: ["mystery.zip"] });
      expect(selectFile).not.toHaveBeenCalled();
    });

    it("routes an extension-less compressed payload that ingest reports as a patch to the patch bucket", async () => {
      mockedList.mockResolvedValue(["patch"]);
      mockedProbe.mockResolvedValue("patch");
      const { controller, onRejected, result, selectFile } = setup();
      const rom = file("base.bin");
      const wrapped = file("patch.gz");
      const flip = file("flip.bps");
      act(() => result.current.onDrop([rom, wrapped, flip]));
      await waitFor(() => expect(controller.provideRomInputFiles).toHaveBeenCalledExactlyOnceWith([rom]));
      expect(mockedProbe).toHaveBeenCalledExactlyOnceWith(wrapped, expect.any(AbortSignal));
      expect(controller.providePatchInputFiles).toHaveBeenCalledExactlyOnceWith([flip, wrapped]);
      expect(onRejected).not.toHaveBeenCalled();
      expect(selectFile).not.toHaveBeenCalled();
    });

    it("offers an extension-less compressed payload that ingest reports as a ROM as a second ROM", async () => {
      mockedList.mockResolvedValue(["rom"]);
      mockedProbe.mockResolvedValue("rom");
      const { controller, result, selectFile } = setup();
      const rom = file("base.bin");
      const wrapped = file("rom.gz");
      act(() => result.current.onDrop([rom, wrapped]));
      await waitFor(() => expect(selectFile).toHaveBeenCalledOnce());
      expect(selectFile.mock.calls[0]?.[0].candidates.map((candidate) => candidate.fileName)).toEqual([
        "base.bin",
        "rom.gz",
      ]);
      await waitFor(() => expect(controller.provideRomInputFiles).toHaveBeenCalledExactlyOnceWith([rom]));
      expect(controller.providePatchInputFiles).not.toHaveBeenCalled();
    });

    it("routes a bare extension-less patch by ingest verdict, and keeps a bare dump a ROM candidate", async () => {
      mockedProbe.mockImplementation(async (probed) => (probed.name === "patch" ? "patch" : "rom"));
      const withPatch = setup();
      const rom = file("base.bin");
      const bare = file("patch");
      act(() => withPatch.result.current.onDrop([rom, bare]));
      await waitFor(() => expect(withPatch.controller.provideRomInputFiles).toHaveBeenCalledExactlyOnceWith([rom]));
      expect(withPatch.controller.providePatchInputFiles).toHaveBeenCalledExactlyOnceWith([bare]);
      expect(withPatch.selectFile).not.toHaveBeenCalled();

      const withDump = setup();
      act(() => withDump.result.current.onDrop([file("base.bin"), file("dump")]));
      await waitFor(() => expect(withDump.selectFile).toHaveBeenCalledOnce());
      expect(withDump.controller.providePatchInputFiles).not.toHaveBeenCalled();
    });

    it("keeps an extension-less candidate a ROM when the ingest probe is unavailable", async () => {
      mockedProbe.mockResolvedValue(undefined);
      const { controller, result, selectFile } = setup();
      act(() => result.current.onDrop([file("base.bin"), file("dump")]));
      await waitFor(() => expect(selectFile).toHaveBeenCalledOnce());
      expect(controller.providePatchInputFiles).not.toHaveBeenCalled();
    });

    it("does not probe a lone extension-less candidate or named files", async () => {
      mockedList.mockResolvedValue(["patch"]);
      const lone = setup();
      const wrapped = file("patch.gz");
      act(() => lone.result.current.onDrop([wrapped]));
      await waitFor(() => expect(lone.controller.provideRomInputFiles).toHaveBeenCalledExactlyOnceWith([wrapped]));

      const named = setup();
      act(() => named.result.current.onDrop([file("base.bin"), file("other.sfc")]));
      await waitFor(() => expect(named.selectFile).toHaveBeenCalledOnce());
      expect(mockedProbe).not.toHaveBeenCalled();
    });

    it("holds back a bare file with an unknown extension next to a recognised ROM", async () => {
      const { controller, onRejected, result, selectFile } = setup();
      const rom = file("base.bin");
      act(() => result.current.onDrop([rom, file("ninja1.rnp")]));
      await waitFor(() => expect(controller.provideRomInputFiles).toHaveBeenCalledExactlyOnceWith([rom]));
      expect(onRejected).toHaveBeenCalledExactlyOnceWith({ kind: "unsupportedPatch", names: ["ninja1.rnp"] });
      expect(selectFile).not.toHaveBeenCalled();
    });

    it("keeps tracks with unlisted extensions that a dropped GDI or CUE sheet references", async () => {
      const gdi = new File(["2\n1 0 4 2352 track01.bin 0\n2 600 0 2352 track02.raw 0\n"], "disc.gdi");
      const gdiTracks = [file("track01.bin"), file("track02.raw")];
      const gdiDrop = setup();
      act(() => gdiDrop.result.current.onDrop([gdi, ...gdiTracks]));
      await waitFor(() => expect(gdiDrop.controller.provideRomInputFiles).toHaveBeenCalledOnce());
      expect(gdiDrop.controller.provideRomInputFiles.mock.calls[0]?.[0].map((f: File) => f.name).sort()).toEqual([
        "disc.gdi",
        "track01.bin",
        "track02.raw",
      ]);
      expect(gdiDrop.onRejected).not.toHaveBeenCalled();

      const cue = new File(
        [
          'FILE "a.img" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\nFILE "b.raw" BINARY\n  TRACK 02 AUDIO\n    INDEX 01 00:00:00\n',
        ],
        "disc.cue",
      );
      const cueDrop = setup();
      act(() => cueDrop.result.current.onDrop([cue, file("a.img"), file("b.raw")]));
      await waitFor(() => expect(cueDrop.controller.provideRomInputFiles).toHaveBeenCalledOnce());
      expect(cueDrop.controller.provideRomInputFiles.mock.calls[0]?.[0].map((f: File) => f.name).sort()).toEqual([
        "a.img",
        "b.raw",
        "disc.cue",
      ]);
      expect(cueDrop.onRejected).not.toHaveBeenCalled();
    });

    it("sends an archive with an extension-less entry plus ignorable files to the ingest probe", async () => {
      mockedList.mockResolvedValue(["hack", "readme.txt"]);
      mockedProbe.mockResolvedValue("patch");
      const { controller, onRejected, result } = setup();
      const rom = file("base.sfc");
      const zip = file("hack.zip");
      act(() => result.current.onDrop([rom, zip]));
      await waitFor(() => expect(controller.providePatchInputFiles).toHaveBeenCalledExactlyOnceWith([zip]));
      expect(mockedProbe).toHaveBeenCalledExactlyOnceWith(zip, expect.any(AbortSignal));
      expect(controller.provideRomInputFiles).toHaveBeenCalledExactlyOnceWith([rom]);
      expect(onRejected).not.toHaveBeenCalled();
    });

    it("still stages a lone extension-less compressed ROM or patch and offers extension-less bare files", async () => {
      mockedList.mockResolvedValue(["rom"]);
      const lone = setup();
      const wrapped = file("rom.gz");
      act(() => lone.result.current.onDrop([wrapped, file("flip.bps")]));
      await waitFor(() => expect(lone.controller.provideRomInputFiles).toHaveBeenCalledExactlyOnceWith([wrapped]));
      expect(lone.onRejected).not.toHaveBeenCalled();

      mockedList.mockResolvedValue(["patch"]);
      const loneWrappedPatch = setup();
      const wrappedPatch = file("patch.gz");
      act(() => loneWrappedPatch.result.current.onDrop([wrappedPatch]));
      await waitFor(() =>
        expect(loneWrappedPatch.controller.provideRomInputFiles).toHaveBeenCalledExactlyOnceWith([wrappedPatch]),
      );
      expect(loneWrappedPatch.onRejected).not.toHaveBeenCalled();

      const bare = setup();
      act(() => bare.result.current.onDrop([file("base.bin"), file("dump")]));
      await waitFor(() => expect(bare.selectFile).toHaveBeenCalledOnce());
      expect(bare.selectFile.mock.calls[0]?.[0].candidates.map((candidate) => candidate.fileName)).toEqual([
        "base.bin",
        "dump",
      ]);
      expect(bare.onRejected).not.toHaveBeenCalled();
    });
  });
});
