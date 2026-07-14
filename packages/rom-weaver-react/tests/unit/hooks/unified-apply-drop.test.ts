// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listDroppedArchiveEntryNames } from "../../../src/lib/input/input-preparation-archive.ts";
import { useUnifiedApplyDrop } from "../../../src/public/react/use-unified-apply-drop.ts";

// The drop router classifies a dropped archive by its entry names (a cheap content listing) to pick
// its bucket before staging; stub that listing so routing is tested without the wasm runtime.
vi.mock("../../../src/lib/input/input-preparation-archive.ts", () => ({
  listDroppedArchiveEntryNames: vi.fn(),
}));
const mockedList = vi.mocked(listDroppedArchiveEntryNames);

const file = (name: string) => new File([new Uint8Array([0])], name);

const makeController = () => ({
  providePatchInputFiles: vi.fn(),
  provideRomInputFiles: vi.fn(),
});

beforeEach(() => mockedList.mockReset());

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

  it("does not stage anything when the drop is cancelled", async () => {
    const controller = makeController();
    const { result } = renderHook(() => useUnifiedApplyDrop(controller));

    act(() => result.current.onDrop([file("bundle.zip")], () => true));

    await waitFor(() => expect(result.current.pendingDrops).toHaveLength(0));
    expect(controller.provideRomInputFiles).not.toHaveBeenCalled();
    expect(controller.providePatchInputFiles).not.toHaveBeenCalled();
  });
});
