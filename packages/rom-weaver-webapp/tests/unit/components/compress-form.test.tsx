// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CompressForm } from "../../../src/webapp/components/compress-form.tsx";
import type { ApplyWorkflowOptions } from "../../../src/types/workflow-runtime-types.ts";

const service = vi.hoisted(() => ({ compressFiles: vi.fn(), openCompressInput: vi.fn() }));
vi.mock("../../../src/webapp/compress-service.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/webapp/compress-service.ts")>()),
  compressFiles: service.compressFiles,
  openCompressInput: service.openCompressInput,
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
    expect(screen.getByText("runtime details")).toBeTruthy();
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

  describe("opened archives", () => {
    const opened = (path: string, contents: string) => ({
      file: new File([contents], path.split("/").pop() || path),
      output: { dispose: vi.fn(async () => undefined), size: contents.length },
      path,
    });

    it("stages only the picked entries and disposes the rest and removed entries", async () => {
      const entries = [opened("disc/game.iso", "iso"), opened("disc/readme.txt", "notes")];
      service.openCompressInput.mockResolvedValue(entries);
      render(<CompressForm />);
      addFiles([new File(["zip"], "disc.zip")]);

      const [iso, readme] = (await screen.findAllByRole("checkbox")) as HTMLInputElement[];
      expect(iso?.checked && readme?.checked).toBe(true);
      expect(screen.getByRole("dialog").textContent).toContain("disc.zip");
      expect(document.querySelector("#compress-container .pending-card")?.textContent).toContain("disc.zip");
      if (readme) fireEvent.click(readme);
      fireEvent.click(screen.getByRole("button", { name: "Add 1 file" }));

      await ready();
      expect(screen.getByRole("button", { name: "Remove game.iso", exact: true })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Remove readme.txt", exact: true })).toBeNull();
      expect(screen.queryByRole("button", { name: "Remove disc.zip", exact: true })).toBeNull();
      await waitFor(() => expect(entries[1]?.output.dispose).toHaveBeenCalledOnce());
      expect(entries[0]?.output.dispose).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Remove game.iso", exact: true }));
      await waitFor(() => expect(entries[0]?.output.dispose).toHaveBeenCalledOnce());
    });

    it("adds a single entry without asking and keeps plain files beside it", async () => {
      const entries = [opened("game.sfc", "rom")];
      service.openCompressInput.mockResolvedValue(entries);
      render(<CompressForm />);
      addFiles([new File(["zip"], "game.zip"), new File(["patch"], "fix.bps")]);

      await ready();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByRole("button", { name: "Remove game.sfc", exact: true })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Remove fix.bps", exact: true })).toBeTruthy();
    });

    it("cancels an archive that is still opening when its card is removed", async () => {
      const late = [opened("a.bin", "a"), opened("b.bin", "b")];
      let finish: (value: unknown) => void = () => undefined;
      service.openCompressInput.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      render(<CompressForm />);
      addFiles([new File(["zip"], "slow.zip")]);
      fireEvent.click(await screen.findByRole("button", { name: "Remove slow.zip", exact: true }));
      const signal = service.openCompressInput.mock.calls[0]?.[2]?.signal as AbortSignal;
      expect(signal.aborted).toBe(true);
      await act(async () => finish(late));
      await waitFor(() => expect(late.every((entry) => entry.output.dispose.mock.calls.length === 1)).toBe(true));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.querySelector("#compress-container .pending-card")).toBeNull();
    });

    it("disposes every extracted entry when the picker is cancelled or the form unmounts", async () => {
      const cancelled = [opened("a.bin", "a"), opened("b.bin", "b")];
      const abandoned = [opened("c.bin", "c"), opened("d.bin", "d")];
      service.openCompressInput.mockResolvedValueOnce(cancelled).mockResolvedValueOnce(abandoned);
      const { unmount } = render(<CompressForm />);
      addFiles([new File(["zip"], "first.zip")]);
      fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(cancelled.every((entry) => entry.output.dispose.mock.calls.length === 1)).toBe(true));
      expect(screen.queryByRole("alert")).toBeNull();

      addFiles([new File(["zip"], "second.zip")]);
      await screen.findByRole("button", { name: "Add 2 files" });
      unmount();
      await waitFor(() => expect(abandoned.every((entry) => entry.output.dispose.mock.calls.length === 1)).toBe(true));
    });
  });
});
