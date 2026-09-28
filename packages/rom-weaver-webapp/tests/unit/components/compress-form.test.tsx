// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CompressForm } from "../../../src/webapp/components/compress-form.tsx";
import type { ApplyWorkflowOptions } from "../../../src/types/workflow-runtime-types.ts";

const service = vi.hoisted(() => ({
  compressFiles: vi.fn(),
  extractCompressEntries: vi.fn(),
  listCompressInput: vi.fn(),
}));
vi.mock("../../../src/webapp/compress-service.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/webapp/compress-service.ts")>()),
  compressFiles: service.compressFiles,
  extractCompressEntries: service.extractCompressEntries,
  listCompressInput: service.listCompressInput,
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
    type Opened = { file: File; output: { dispose: ReturnType<typeof vi.fn>; size: number }; path: string };
    // Lists the given entries and extracts only what the form asks for, recording every stored copy.
    const archive = (contents: Record<string, string>) => {
      const extracted: Opened[] = [];
      service.listCompressInput.mockResolvedValue(Object.keys(contents).map((path) => ({ path, size: 1 })));
      service.extractCompressEntries.mockImplementation(async (_file: File, paths: string[]) =>
        paths.map((path) => {
          const entry = {
            file: new File([contents[path] ?? ""], path.split("/").pop() || path),
            output: { dispose: vi.fn(async () => undefined), size: 1 },
            path,
          };
          extracted.push(entry);
          return entry;
        }),
      );
      return extracted;
    };

    it("extracts and stages only the picked entries and disposes removed entries", async () => {
      const extracted = archive({ "disc/game.iso": "iso", "disc/readme.txt": "notes" });
      render(<CompressForm />);
      addFiles([new File(["zip"], "disc.zip")]);

      const [iso, readme] = (await screen.findAllByRole("checkbox")) as HTMLInputElement[];
      expect(iso?.checked && readme?.checked).toBe(true);
      expect(screen.getByRole("dialog").textContent).toContain("disc.zip");
      expect(document.querySelector("#compress-container .pending-card")?.textContent).toContain("Reading");
      expect(service.extractCompressEntries).not.toHaveBeenCalled();
      if (readme) fireEvent.click(readme);
      fireEvent.click(screen.getByRole("button", { name: "Add 1 file" }));

      await ready();
      expect(service.extractCompressEntries.mock.calls[0]?.[1]).toEqual(["disc/game.iso"]);
      expect(screen.getByRole("button", { name: "Remove game.iso", exact: true })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Remove readme.txt", exact: true })).toBeNull();
      expect(screen.queryByRole("button", { name: "Remove disc.zip", exact: true })).toBeNull();
      expect(extracted[0]?.output.dispose).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Remove game.iso", exact: true }));
      await waitFor(() => expect(extracted[0]?.output.dispose).toHaveBeenCalledOnce());
    });

    it("names the output after the archive instead of its first entry", async () => {
      archive({ "readme.txt": "notes", "game.sfc": "rom" });
      render(<CompressForm />);
      addFiles([new File(["zip"], "Great Game.zip")]);
      fireEvent.click(await screen.findByRole("button", { name: "Add 2 files" }));

      await ready();
      expect((screen.getByRole("textbox", { name: "Output filename (no extension)" }) as HTMLInputElement).value).toBe(
        "Great Game",
      );
    });

    it("asks about a single entry too and keeps plain files beside it", async () => {
      archive({ "game.sfc": "rom" });
      render(<CompressForm />);
      addFiles([new File(["zip"], "game.zip"), new File(["patch"], "fix.bps")]);

      const keep = (await screen.findByRole("switch", { name: "Keep packed" })) as HTMLInputElement;
      expect(keep.checked).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "Add 1 file" }));
      await ready();
      expect(screen.getByRole("button", { name: "Remove game.sfc", exact: true })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Remove fix.bps", exact: true })).toBeTruthy();
    });

    it("adds the archive unchanged when Keep packed is on without extracting anything", async () => {
      archive({ "game.sfc": "rom", "readme.txt": "notes" });
      render(<CompressForm />);
      addFiles([new File(["zip"], "game.zip")]);

      fireEvent.click(await screen.findByRole("switch", { name: "Keep packed" }));
      fireEvent.click(screen.getByRole("button", { name: "Add archive" }));
      await ready();
      expect(screen.getByRole("button", { name: "Remove game.zip", exact: true })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Remove game.sfc", exact: true })).toBeNull();
      expect(service.extractCompressEntries).not.toHaveBeenCalled();
    });

    it.each([
      ["listed", () => service.listCompressInput.mockRejectedValue(new Error("Unsupported archive"))],
      [
        "extracted",
        () => {
          archive({ "a.bin": "a" });
          service.extractCompressEntries.mockRejectedValue(new Error("Unsupported archive"));
        },
      ],
    ])("adds an archive that cannot be %s unchanged and says why", async (stage, fail) => {
      fail();
      render(<CompressForm />);
      addFiles([new File(["broken"], "broken.zip")]);
      if (stage === "extracted") fireEvent.click(await screen.findByRole("button", { name: "Add 1 file" }));

      await ready();
      expect(screen.getByRole("button", { name: "Remove broken.zip", exact: true })).toBeTruthy();
      expect(screen.getByRole("alert").textContent).toContain(
        "broken.zip could not be opened, so it was added unchanged. Unsupported archive",
      );
    });

    it("cancels an archive that is still being read when its card is removed", async () => {
      let finish: (value: unknown) => void = () => undefined;
      service.listCompressInput.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      render(<CompressForm />);
      addFiles([new File(["zip"], "slow.zip")]);
      fireEvent.click(await screen.findByRole("button", { name: "Remove slow.zip", exact: true }));
      const signal = service.listCompressInput.mock.calls[0]?.[2]?.signal as AbortSignal;
      expect(signal.aborted).toBe(true);
      await act(async () => finish([{ path: "a.bin" }, { path: "b.bin" }]));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(service.extractCompressEntries).not.toHaveBeenCalled();
      expect(document.querySelector("#compress-container .pending-card")).toBeNull();
    });

    it("disposes entries that finish extracting after the form unmounts", async () => {
      const contents = { "c.bin": "c", "d.bin": "d" };
      archive(contents);
      let finish: () => void = () => undefined;
      const late: Opened[] = [];
      service.extractCompressEntries.mockImplementation(
        (_file: File, paths: string[]) =>
          new Promise((resolve) => {
            finish = () => {
              for (const path of paths)
                late.push({
                  file: new File([contents[path as keyof typeof contents]], path),
                  output: { dispose: vi.fn(async () => undefined), size: 1 },
                  path,
                });
              resolve(late);
            };
          }),
      );
      const { unmount } = render(<CompressForm />);
      addFiles([new File(["zip"], "second.zip")]);
      fireEvent.click(await screen.findByRole("button", { name: "Add 2 files" }));
      await waitFor(() => expect(service.extractCompressEntries).toHaveBeenCalledOnce());
      unmount();
      await act(async () => finish());
      await waitFor(() => expect(late.every((entry) => entry.output.dispose.mock.calls.length === 1)).toBe(true));
    });

    it("extracts nothing when the picker is cancelled", async () => {
      archive({ "a.bin": "a", "b.bin": "b" });
      render(<CompressForm />);
      addFiles([new File(["zip"], "first.zip")]);
      fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(document.querySelector("#compress-container .pending-card")).toBeNull());
      expect(service.extractCompressEntries).not.toHaveBeenCalled();
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });
});
