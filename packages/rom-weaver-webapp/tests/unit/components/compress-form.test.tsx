// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CompressForm } from "../../../src/webapp/components/compress-form.tsx";
import type { ApplyWorkflowOptions } from "../../../src/types/workflow-runtime-types.ts";

const service = vi.hoisted(() => ({ compressFiles: vi.fn() }));
vi.mock("../../../src/webapp/compress-service.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/webapp/compress-service.ts")>()),
  compressFiles: service.compressFiles,
}));
vi.mock("../../../src/platform/browser/workflow-runtime.ts", () => ({ browserRuntime: {} }));

const makeOutput = () => ({
  dispose: vi.fn(async () => undefined),
  fileName: "release.zip",
  saveAs: vi.fn(async () => undefined),
  size: 100,
});
const addFiles = (files: File[]) => {
  const picker = document.getElementById("compress-input-picker");
  if (!picker) throw new Error("Compress file picker is missing");
  fireEvent.change(picker, { target: { files } });
};
const ready = async () =>
  waitFor(() =>
    expect((screen.getByRole("button", { name: "Compress", exact: true }) as HTMLButtonElement).disabled).toBe(false),
  );

describe("CompressForm", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stages files, uses the shared options, and retains output until the input changes", async () => {
    const output = makeOutput();
    service.compressFiles.mockResolvedValue(output);
    const onSessionChange = vi.fn();
    const { unmount } = render(<CompressForm onSessionChange={onSessionChange} />);
    addFiles([new File(["rom"], "game.sfc"), new File(["patch"], "fix.bps")]);
    await ready();
    expect(service.compressFiles).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "Output filename (no extension)" }), {
      target: { value: "release" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Options / }));
    fireEvent.change(screen.getByRole("combobox", { name: "Level", exact: true }), {
      target: { value: "low" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Compress", exact: true }));
    fireEvent.click(await screen.findByRole("button", { name: /Download release.zip/ }));
    await waitFor(() => expect(output.saveAs).toHaveBeenCalledWith({ fileName: "release.zip", interactive: true }));
    expect(service.compressFiles).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: "fix.bps" })]),
      expect.objectContaining({
        output: expect.objectContaining({
          compression: "zip",
          outputName: "release",
          container: expect.objectContaining({ profile: "low" }),
        }),
      }),
      expect.anything(),
    );
    expect(output.dispose).not.toHaveBeenCalled();
    expect(onSessionChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove fix.bps", exact: true }));
    await waitFor(() => expect(output.dispose).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: /Download/ })).toBeNull();
    unmount();
  });

  it("discards a result that completes after cancellation and allows a retry", async () => {
    const late = makeOutput();
    let finish: (value: unknown) => void = () => undefined;
    let signal: AbortSignal | undefined;
    service.compressFiles.mockImplementation((_files: File[], options: ApplyWorkflowOptions) => {
      signal = options.signal;
      options.onProgress?.({ stage: "output", label: "runtime details", percent: 40 });
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    render(<CompressForm />);
    addFiles([new File(["rom"], "game.sfc")]);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Compress", exact: true }));
    expect(await screen.findByText("40%")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(signal?.aborted).toBe(true);
    await act(async () => finish(late));
    await ready();
    expect(late.dispose).toHaveBeenCalledOnce();
    expect(late.saveAs).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("aborts unmounted work and disposes its late result", async () => {
    const late = makeOutput();
    let finish: (value: unknown) => void = () => undefined;
    service.compressFiles.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { unmount } = render(<CompressForm />);
    addFiles([new File(["rom"], "game.sfc")]);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Compress", exact: true }));
    await waitFor(() => expect(service.compressFiles).toHaveBeenCalledOnce());
    const signal = service.compressFiles.mock.calls[0]?.[1].signal as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => finish(late));
    expect(late.dispose).toHaveBeenCalledOnce();
  });

  it("handles each page drop once and resets an unsupported format after adding a file", async () => {
    const first = new File([new Uint8Array(2048)], "disc.iso");
    const pageDrop = { id: 1, files: [first] };
    const { rerender } = render(<CompressForm pageDrop={pageDrop} />);
    await ready();
    fireEvent.change(screen.getByRole("combobox", { name: "Output format" }), { target: { value: "chd" } });
    rerender(<CompressForm pageDrop={pageDrop} />);
    expect(screen.getAllByRole("button", { name: "Remove disc.iso" })).toHaveLength(1);
    addFiles([new File(["readme"], "readme.txt")]);
    await ready();
    expect((screen.getByRole("combobox", { name: "Output format" }) as HTMLSelectElement).value).toBe("zip");
    expect(screen.queryByRole("option", { name: ".chd" })).toBeNull();
  });
});
