// @vitest-environment happy-dom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import type { BinarySource } from "../../src/public/react/patcher-form.ts";

const makeTrimSource = (fileName: string) => ({
  candidates: [{ id: "rom-candidate", label: "ROM" }],
  checksums: { crc32: "C6FB1252", md5: "0123456789abcdef", sha1: "0123456789012345678901234567890123456789" },
  fileName,
  id: "trim-input-1",
  identification: {
    matches: [
      {
        algorithm: "crc32",
        database: "No-Intro",
        name: "Trim Example (USA)",
        platform: "Nintendo Entertainment System",
        variant: "raw",
      },
    ],
    status: "matched",
  },
  parentCompressions: [],
  romProbe: { trim: { detected: true, trimmedInputBytes: 96 } },
  selectedCandidateId: "rom-candidate",
  size: 128,
  status: "ready",
  warnings: [],
});

const makeFakeTrimWorkflow = () => {
  let input: ReturnType<typeof makeTrimSource> | null = null;
  let disposed = false;
  const output = {
    dispose: vi.fn(async () => undefined),
    fileName: "trimmed.nes",
    prepareDownload: vi.fn(async () => undefined),
    saveAs: vi.fn(async () => undefined),
    size: 80,
  };
  const workflow = {
    abort: vi.fn(),
    dispose: vi.fn(async () => {
      disposed = true;
    }),
    getInput: vi.fn(() => input),
    id: "fake-trim-workflow",
    isDisposed: () => disposed,
    off: vi.fn(),
    on: vi.fn(),
    run: vi.fn(async () => ({
      input,
      output,
      sizeSummary: { compressionTimeMs: 4, inputSize: 128, outputSize: 80, rawSize: 96, trimTimeMs: 8 },
    })),
    setInput: vi.fn(async (source: BinarySource) => {
      input = makeTrimSource(source instanceof File ? source.name : "game.nes");
    }),
    setOutputFormat: vi.fn(async () => undefined),
    setOutputName: vi.fn(async () => undefined),
  };
  return { output, workflow };
};

let latest: ReturnType<typeof makeFakeTrimWorkflow> | null = null;

class FakeTrimWorkflow {
  constructor() {
    latest = makeFakeTrimWorkflow();
    Object.assign(this, latest.workflow);
  }
}

const { TrimPatchForm } = await import("../../src/public/react/trim-form.tsx");

const renderForm = (props: Record<string, unknown> = {}) =>
  render(
    <RomWeaverSettingsProvider settings={{}}>
      <TrimPatchForm {...({ trimWorkflow: FakeTrimWorkflow, ...props } as never)} />
    </RomWeaverSettingsProvider>,
  );

beforeEach(() => {
  window.history.replaceState(null, "", "/trim");
  latest = null;
});

afterEach(() => {
  vi.restoreAllMocks();
  latest = null;
});

describe("TrimPatchForm", () => {
  it("renders the empty hero and forwards a page drop into staging", async () => {
    const file = new File(["rom"], "game.nes", { type: "application/octet-stream" });
    const { container } = renderForm({ pageDrop: { files: [file], id: 1 } });
    expect(container.querySelector("#trim-builder-input-file-unified")).toBeTruthy();
    expect(container.querySelectorAll(".step-num")).toHaveLength(1);
    await vi.waitFor(() => expect(latest?.workflow.setInput).toHaveBeenCalled());
    await vi.waitFor(() => expect(container.querySelector("#trim-builder-button-run")).toBeTruthy());
    expect(container.querySelectorAll(".step-num")).toHaveLength(3);
    await vi.waitFor(() => expect(container.textContent).toContain("Trim Example (USA)"));
    expect(container.textContent).toContain("Detected (96 B)");
  });

  it("requires confirmation, runs the trim, and exposes a completed download", async () => {
    const onComplete = vi.fn();
    const file = new File(["rom"], "game.nes", { type: "application/octet-stream" });
    const { container } = renderForm({ onTrimComplete: onComplete });
    const input = container.querySelector("#trim-builder-input-file-unified") as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
      fireEvent.change(input);
    });
    await vi.waitFor(() => expect(container.querySelector("#trim-builder-button-run")).toBeTruthy());
    const run = container.querySelector("#trim-builder-button-run") as HTMLButtonElement;
    await act(async () => fireEvent.click(run));
    expect(document.body.textContent).toContain("Trim this ROM?");
    const confirm = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Trim ROM"),
    );
    expect(confirm).toBeTruthy();
    await act(async () => fireEvent.click(confirm as HTMLButtonElement));
    await vi.waitFor(() => expect(latest?.workflow.run).toHaveBeenCalled());
    await vi.waitFor(() => expect(latest?.output.saveAs).toHaveBeenCalled());
    expect(onComplete).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Trimmed .nes");
    expect(container.textContent).toContain("32 B raw");
  });

  it("surfaces a trim failure and supports canceling the confirmation", async () => {
    const file = new File(["rom"], "game.nes", { type: "application/octet-stream" });
    const { container } = renderForm();
    const input = container.querySelector("#trim-builder-input-file-unified") as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
      fireEvent.change(input);
    });
    await vi.waitFor(() => expect(container.querySelector("#trim-builder-button-run")).toBeTruthy());
    await act(async () => fireEvent.click(container.querySelector("#trim-builder-button-run") as HTMLButtonElement));
    const cancel = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Cancel"),
    );
    expect(cancel).toBeTruthy();
    await act(async () => fireEvent.click(cancel as HTMLButtonElement));
    expect(document.body.textContent).not.toContain("Trim this ROM?");

    latest?.workflow.run.mockRejectedValueOnce(new Error("trim failed for the test"));
    await act(async () => fireEvent.click(container.querySelector("#trim-builder-button-run") as HTMLButtonElement));
    const confirm = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Trim ROM"),
    );
    await act(async () => fireEvent.click(confirm as HTMLButtonElement));
    await vi.waitFor(() => expect(container.textContent).toContain("trim failed for the test"));
  });

  it("reports ignored patches and unused extra ROMs from a unified drop", async () => {
    const { container } = renderForm();
    const input = container.querySelector("#trim-builder-input-file-unified") as HTMLInputElement;
    const rom = new File(["rom"], "game.nes", { type: "application/octet-stream" });
    const extra = new File(["extra"], "extra.nes", { type: "application/octet-stream" });
    const patch = new File(["patch"], "change.ips", { type: "application/octet-stream" });
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: [rom, extra, patch] });
      fireEvent.change(input);
    });
    await vi.waitFor(() => expect(document.querySelector(".seltree button")).toBeTruthy());
    await act(async () => fireEvent.click(document.querySelector(".seltree button") as HTMLButtonElement));
    await vi.waitFor(() => expect(container.textContent).toContain("Patches belong in Apply"));
  });

  it("downloads a completed trim again and reports a download failure", async () => {
    const file = new File(["rom"], "game.nes", { type: "application/octet-stream" });
    const { container } = renderForm();
    const input = container.querySelector("#trim-builder-input-file-unified") as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
      fireEvent.change(input);
    });
    await vi.waitFor(() => expect(container.querySelector("#trim-builder-button-run")).toBeTruthy());
    await act(async () => fireEvent.click(container.querySelector("#trim-builder-button-run") as HTMLButtonElement));
    await act(async () =>
      fireEvent.click(
        Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Trim ROM"),
        ) as HTMLButtonElement,
      ),
    );
    await vi.waitFor(() => expect(latest?.workflow.run).toHaveBeenCalled());

    latest?.output.saveAs.mockRejectedValueOnce(new Error("download failed"));
    await act(async () => fireEvent.click(container.querySelector("#trim-builder-button-run") as HTMLButtonElement));
    await vi.waitFor(() => expect(container.textContent).toContain("download failed"));
    expect(latest?.output.saveAs).toHaveBeenCalledWith({ interactive: true });
  });

  it("updates the trim output name and format controls", async () => {
    const file = new File(["rom"], "game.nes", { type: "application/octet-stream" });
    const onSettingsChange = vi.fn();
    const { container } = renderForm({ onSettingsChange });
    const input = container.querySelector("#trim-builder-input-file-unified") as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
      fireEvent.change(input);
    });
    await vi.waitFor(() => expect(container.querySelector("#trim-builder-output-file")).toBeTruthy());
    const outputName = container.querySelector("#trim-builder-output-file") as HTMLInputElement;
    fireEvent.change(outputName, { target: { value: "trimmed-copy" } });
    fireEvent.change(container.querySelector("#trim-builder-select-output-format") as HTMLSelectElement, {
      target: { value: "zip" },
    });

    expect(onSettingsChange).toHaveBeenCalled();
    expect(outputName.value).toBe("trimmed-copy");
    expect(latest?.workflow.setOutputFormat).not.toHaveBeenCalled();
  });
});
