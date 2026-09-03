// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setActiveSelectionForm, useInputSelectionHandler } from "../../src/public/react/input-selection-handler.ts";

type HostSelectionHandler = (request: string) => Promise<number[]>;

const handlerState = vi.hoisted(() => ({ current: undefined as HostSelectionHandler | undefined }));
const { setInputSelectionHandler } = vi.hoisted(() => ({
  setInputSelectionHandler: vi.fn((handler: HostSelectionHandler | undefined) => {
    handlerState.current = handler;
  }),
}));

vi.mock("../../src/workers/rom-weaver/runner-control.ts", () => ({ setInputSelectionHandler }));

const registeredHandler = (): HostSelectionHandler => {
  const handler = handlerState.current;
  expect(handler).toEqual(expect.any(Function));
  if (!handler) throw new Error("host selection handler was not registered");
  return handler;
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("useInputSelectionHandler", () => {
  it("routes a single selection and derives the source name from the heading path", async () => {
    const selectFile = vi.fn().mockResolvedValue({ id: "1" });
    const { unmount } = renderHook(() => useInputSelectionHandler("apply", selectFile));
    const handler = registeredHandler();

    await expect(
      handler(
        JSON.stringify({
          candidates: [
            { label: "ignored.ips", size: 12 },
            { value: "chosen.bps", size: 34 },
          ],
          heading: "extract input payload selection for `/work/patches.zip` is ambiguous",
        }),
      ),
    ).resolves.toEqual([1]);
    expect(selectFile).toHaveBeenCalledWith({
      candidates: [
        { fileName: "ignored.ips", id: "0", kind: "rom", patchable: true, selectable: true, size: 12, type: "file" },
        { fileName: "chosen.bps", id: "1", kind: "rom", patchable: true, selectable: true, size: 34, type: "file" },
      ],
      multiSelect: false,
      role: "input",
      sourceName: "patches.zip",
      warnings: [],
    });

    unmount();
    await expect(handler(JSON.stringify({ candidates: [{ value: "later.bin" }] }))).resolves.toEqual([]);
  });

  it("supports ordered multi-selection and the last registered fallback handler", async () => {
    const firstSelect = vi.fn().mockResolvedValue({ ids: ["2", "0"] });
    const secondSelect = vi.fn().mockResolvedValue({ id: "0" });
    const first = renderHook(() => useInputSelectionHandler("first", firstSelect));
    renderHook(() => useInputSelectionHandler("second", secondSelect));
    const handler = registeredHandler();

    act(() => setActiveSelectionForm("first"));
    await expect(
      handler(
        JSON.stringify({
          candidates: [{}, { label: "middle.bin" }, { value: "last.bin", size: Number.NaN }],
          mode: "many",
        }),
      ),
    ).resolves.toEqual([2, 0]);
    expect(firstSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: [
          expect.objectContaining({ fileName: "Entry 1" }),
          expect.objectContaining({ fileName: "middle.bin" }),
          expect.objectContaining({ fileName: "last.bin" }),
        ],
        multiSelect: true,
      }),
    );
    expect(secondSelect).not.toHaveBeenCalled();

    act(() => setActiveSelectionForm(undefined));
    first.unmount();
    await expect(handler(JSON.stringify({ candidates: [{ label: "remaining.bin" }] }))).resolves.toEqual([0]);
    expect(secondSelect).toHaveBeenCalledOnce();
  });

  it("honors the active form, cancels malformed or empty requests, and handles rejected choices", async () => {
    const selectFile = vi.fn().mockResolvedValue({ id: "0" });
    const otherSelect = vi.fn().mockResolvedValue({ id: "0" });
    const first = renderHook(() => useInputSelectionHandler("first", selectFile));
    renderHook(() => useInputSelectionHandler("other", otherSelect));
    const handler = registeredHandler();

    await expect(handler("not json")).resolves.toEqual([]);
    await expect(handler(JSON.stringify({ candidates: [] }))).resolves.toEqual([]);

    act(() => setActiveSelectionForm("first"));
    await expect(handler(JSON.stringify({ candidates: [{ value: "first.bin" }] }))).resolves.toEqual([0]);
    expect(selectFile).toHaveBeenCalledOnce();
    expect(otherSelect).not.toHaveBeenCalled();

    selectFile.mockResolvedValueOnce({ id: "missing" });
    await expect(handler(JSON.stringify({ candidates: [{ value: "first.bin" }] }))).resolves.toEqual([]);
    selectFile.mockRejectedValueOnce(new Error("dialog closed"));
    await expect(handler(JSON.stringify({ candidates: [{ value: "first.bin" }] }))).resolves.toEqual([]);

    act(() => setActiveSelectionForm("missing"));
    await expect(handler(JSON.stringify({ candidates: [{ value: "fallback.bin" }] }))).resolves.toEqual([0]);
    expect(otherSelect).toHaveBeenCalledOnce();

    first.unmount();
  });

  it("does not let an older same-id cleanup remove the replacement handler", async () => {
    const oldSelect = vi.fn().mockResolvedValue({ id: "0" });
    const newSelect = vi.fn().mockResolvedValue({ id: "0" });
    const old = renderHook(() => useInputSelectionHandler("same", oldSelect));
    const replacement = renderHook(() => useInputSelectionHandler("same", newSelect));
    const handler = registeredHandler();

    old.unmount();
    await expect(handler(JSON.stringify({ candidates: [{ value: "replacement.bin" }] }))).resolves.toEqual([0]);
    expect(newSelect).toHaveBeenCalledOnce();
    expect(oldSelect).not.toHaveBeenCalled();

    replacement.unmount();
    await expect(handler(JSON.stringify({ candidates: [{ value: "none.bin" }] }))).resolves.toEqual([]);
  });
});
