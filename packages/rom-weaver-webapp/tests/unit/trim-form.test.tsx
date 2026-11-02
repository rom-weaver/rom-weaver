// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import type { BinarySource } from "../../src/public/react/patcher-form.ts";

// The engine's verdict for an input trim cannot handle (such as a GameCube/Wii disc).
let trimUnsupportedMessage: string | undefined;
let stagingGate: Promise<void> | undefined;
let startUnidentified = false;
let paddingTrimmed: boolean | undefined;
// Models staging extracting the upload: the image's name and the containers it came out of.
let extracted: { fileName: string; parentKind: string } | undefined;
const changeListeners = new Set<() => void>();

const makeTrimSource = (fileName: string) => ({
  candidates: [{ id: "rom-candidate", label: "ROM" }],
  checksums: { crc32: "C6FB1252", md5: "0123456789abcdef", sha1: "0123456789012345678901234567890123456789" },
  fileName,
  id: "trim-input-1",
  identification: startUnidentified
    ? { matches: [], status: "unavailable" }
    : {
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
  parentCompressions: extracted ? [{ kind: extracted.parentKind }] : [],
  ...(paddingTrimmed === undefined ? {} : { paddingTrimmed, restoreSupported: true }),
  romProbe: { trim: { detected: true, trimmedInputBytes: 96 } },
  selectedCandidateId: "rom-candidate",
  size: 128,
  status: "ready",
  ...(trimUnsupportedMessage
    ? { trimSupported: false, warnings: [{ code: "TRIM_UNSUPPORTED", message: trimUnsupportedMessage }] }
    : { warnings: [] }),
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
    off: vi.fn((event: string, listener: () => void) => {
      if (event === "change") changeListeners.delete(listener);
    }),
    on: vi.fn((event: string, listener: () => void) => {
      if (event === "change") changeListeners.add(listener);
    }),
    reidentify: () => {
      startUnidentified = false;
      input = makeTrimSource(input?.fileName || "game.nes");
      for (const listener of changeListeners) listener();
    },
    emitChange: (patch?: { size: number }) => {
      if (patch) input = { ...makeTrimSource(input?.fileName || "game.nes"), ...patch };
      for (const listener of changeListeners) listener();
    },
    run: vi.fn(async () => ({
      input,
      output,
      sizeSummary: { compressionTimeMs: 4, inputSize: 128, outputSize: 80, rawSize: 96, trimTimeMs: 8 },
    })),
    setInput: vi.fn(async (source: BinarySource) => {
      await stagingGate;
      input = makeTrimSource(extracted?.fileName ?? (source instanceof File ? source.name : "game.nes"));
    }),
    setSettings: vi.fn(async () => undefined),
    setMode: vi.fn(async () => undefined),
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

// The form builds its workflow after an async import, so the run button can render before it exists.
const waitForWorkflow = () => vi.waitFor(() => expect(latest).not.toBeNull());

beforeEach(() => {
  window.history.replaceState(null, "", "/trim-rom");
  latest = null;
  trimUnsupportedMessage = undefined;
  stagingGate = undefined;
  startUnidentified = false;
  paddingTrimmed = undefined;
  extracted = undefined;
  changeListeners.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  latest = null;
});

describe("TrimPatchForm", () => {
  it("shows a late re-identification and runs with the upgraded automatic output name", async () => {
    startUnidentified = true;
    const file = new File(["rom"], "game.nes", { type: "application/octet-stream" });
    const { container } = renderForm({ pageDrop: { files: [file], id: 1 } });
    await vi.waitFor(() => expect(container.querySelector("#trim-builder-button-run")).toBeTruthy());
    await waitForWorkflow();
    expect(container.textContent).not.toContain("Trim Example (USA)");
    await act(async () => {
      ((latest as NonNullable<typeof latest>).workflow as unknown as { reidentify: () => void }).reidentify();
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Trim Example (USA)"));
    await act(async () => fireEvent.click(container.querySelector("#trim-builder-button-run") as HTMLButtonElement));
    const confirm = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Trim ROM"),
    );
    await act(async () => fireEvent.click(confirm as HTMLButtonElement));
    await vi.waitFor(() => expect(latest?.workflow.setOutputName).toHaveBeenCalled());
    expect(String(latest?.workflow.setOutputName.mock.calls[0]?.[0])).toContain("Trim Example (USA)");
  });

  it("does not replace the source state for a change with an identification equal by value", async () => {
    const file = new File(["rom"], "game.nes", { type: "application/octet-stream" });
    const { container } = renderForm({ pageDrop: { files: [file], id: 1 } });
    await vi.waitFor(() => expect(container.querySelector("#trim-builder-button-run")).toBeTruthy());
    await waitForWorkflow();
    await vi.waitFor(() => expect(container.textContent).toContain("Trim Example (USA)"));
    expect(container.textContent).toContain("BYTES 128");
    await act(async () => {
      // Fresh source and identification objects with the same identification value but another size.
      (latest as NonNullable<typeof latest>).workflow.emitChange({ size: 4096 });
    });
    expect(container.textContent).toContain("BYTES 128");
    expect(container.textContent).not.toContain("BYTES 4096");
  });

  it("keeps the output name consistent with the finished run when a late identification arrives", async () => {
    startUnidentified = true;
    const file = new File(["rom"], "game.nes", { type: "application/octet-stream" });
    const { container } = renderForm({ pageDrop: { files: [file], id: 1 } });
    await vi.waitFor(() => expect(container.querySelector("#trim-builder-button-run")).toBeTruthy());
    await waitForWorkflow();
    const nameField = () => container.querySelector("#trim-builder-output-file") as HTMLInputElement;
    const before = nameField().value;
    expect(before).not.toContain("Trim Example (USA)");
    await act(async () => fireEvent.click(container.querySelector("#trim-builder-button-run") as HTMLButtonElement));
    const confirm = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Trim ROM"),
    );
    await act(async () => fireEvent.click(confirm as HTMLButtonElement));
    await vi.waitFor(() =>
      expect(container.querySelector("#trim-builder-button-run")?.textContent).toContain("Download"),
    );
    await act(async () => {
      ((latest as NonNullable<typeof latest>).workflow as unknown as { reidentify: () => void }).reidentify();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(nameField().value).toBe(before);
    expect(container.querySelector("#trim-builder-button-run")?.textContent).toContain("Download");
  });

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
    const { container } = renderForm({ onTrimComplete: onComplete, settings: { zipCodec: "store", zipLevel: 0 } });
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
    expect(latest?.workflow.setSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        output: expect.objectContaining({ container: expect.objectContaining({ zipCodec: "store" }) }),
      }),
    );
    expect(onComplete).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Trimmed .nes");
    expect(container.textContent).toContain("32 B raw");
  });

  it("labels a ROM that was already at its trimmed size", async () => {
    const file = new File(["rom"], "game.nes", { type: "application/octet-stream" });
    const { container } = renderForm({ settings: { zipCodec: "store", zipLevel: 0 } });
    const input = container.querySelector("#trim-builder-input-file-unified") as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
      fireEvent.change(input);
    });
    await vi.waitFor(() => expect(container.querySelector("#trim-builder-button-run")).toBeTruthy());
    await waitForWorkflow();
    (latest as NonNullable<typeof latest>).workflow.run.mockResolvedValueOnce({
      input: latest.workflow.getInput(),
      output: { ...latest.output, size: 128 },
      sizeSummary: { compressionTimeMs: 0, inputSize: 128, outputSize: 128, rawSize: 128, trimTimeMs: 1 },
    } as never);
    await act(async () => fireEvent.click(container.querySelector("#trim-builder-button-run") as HTMLButtonElement));
    const confirm = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Trim ROM"),
    );
    await act(async () => fireEvent.click(confirm as HTMLButtonElement));
    await vi.waitFor(() => expect(latest?.output.saveAs).toHaveBeenCalled());
    expect(container.textContent).toContain("Already trimmed .nes");
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

  it("uses neutral confirmation while ROM metadata is pending and preserves queued execution", async () => {
    let release!: () => void;
    stagingGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { container } = renderForm({
      pageDrop: { files: [new File(["rom"], "game.nds")], id: 1 },
    });
    await vi.waitFor(() => expect(latest?.workflow.setInput).toHaveBeenCalled());
    await act(async () => fireEvent.click(container.querySelector("#trim-builder-button-run") as HTMLButtonElement));
    expect(document.body.textContent).toContain("A new copy of game.nds");
    expect(document.body.textContent).toContain("Supported padding is removed");
    expect(document.body.textContent).not.toContain("GameCube");
    expect(document.body.textContent).not.toContain("restored padding");
    await act(async () =>
      fireEvent.click(
        Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Trim ROM"),
        ) as HTMLButtonElement,
      ),
    );
    expect(latest?.workflow.run).not.toHaveBeenCalled();
    await act(async () => {
      release();
    });
    await vi.waitFor(() => expect(latest?.workflow.run).toHaveBeenCalledOnce());
  });

  it.each(["game.gcm", "game.iso", "game.wbfs", "game.rvz"])(
    "disables Trim and points to Compress for the GameCube/Wii disc %s",
    async (fileName) => {
      trimUnsupportedMessage =
        "This input does not support trimming. Use Compress to convert GameCube and Wii discs to RVZ.";
      const { container } = renderForm({ pageDrop: { files: [new File(["disc"], fileName)], id: 1 } });
      await vi.waitFor(() => expect(latest?.workflow.getInput()?.status).toBe("ready"));
      await vi.waitFor(() =>
        expect(container.querySelector("#trim-builder-source-error-message")?.textContent).toContain(
          "Use Compress to convert GameCube and Wii discs to RVZ",
        ),
      );
      const run = container.querySelector("#trim-builder-button-run") as HTMLButtonElement;
      expect(run.disabled).toBe(true);
      await act(async () => fireEvent.click(run));
      expect(document.querySelector(".confirm-card")).toBeNull();
      expect(latest?.workflow.run).not.toHaveBeenCalled();
    },
  );

  it("does not offer RVZ for a bare .iso the engine did not recognise as a GameCube or Wii disc", async () => {
    const { container } = renderForm({
      pageDrop: { files: [new File(["disc"], "dvd.iso")], id: 1 },
      outputFormat: "rvz",
      settings: { defaultCompression: "none" },
    });
    await vi.waitFor(() => expect(latest?.workflow.getInput()?.status).toBe("ready"));
    await vi.waitFor(() => {
      const format = container.querySelector("#trim-builder-select-output-format") as HTMLSelectElement;
      const offered = Array.from(format.options).map((option) => option.value);
      expect(offered).toContain("zip");
      expect(offered).not.toContain("rvz");
      expect(format.value).not.toBe("rvz");
    });
  });

  it("offers only raw, ZIP, and 7z outputs for a cartridge ROM", async () => {
    const { container } = renderForm({ pageDrop: { files: [new File(["rom"], "game.nds")], id: 1 } });
    await vi.waitFor(() => expect(latest?.workflow.getInput()?.status).toBe("ready"));
    await vi.waitFor(() => {
      const format = container.querySelector("#trim-builder-select-output-format") as HTMLSelectElement;
      expect(Array.from(format.options).map((option) => option.value)).toEqual(["nds", "zip", "7z"]);
    });
  });

  it.each([
    { fileName: "game.3ds", expected: ["3ds", "z3ds", "zip", "7z"], extra: {} },
    { fileName: "disc.cue", expected: ["cue", "chd", "zip", "7z"], extra: { chd: true } },
  ])("keeps matching container formats for $fileName", async ({ fileName, expected }) => {
    const { container } = renderForm({ pageDrop: { files: [new File(["rom"], fileName)], id: 1 } });
    await vi.waitFor(() => expect(latest?.workflow.getInput()?.status).toBe("ready"));
    await vi.waitFor(() => {
      const format = container.querySelector("#trim-builder-select-output-format") as HTMLSelectElement;
      expect(Array.from(format.options).map((option) => option.value)).toEqual(expected);
    });
  });

  it.each([
    { upload: "game.zip", parentKind: "zip", image: "game.3ds", format: "z3ds", extension: ".z3ds" },
    { upload: "game.7z", parentKind: "7z", image: "game.cci", format: "z3ds", extension: ".zcci" },
    { upload: "game.z3ds", parentKind: "z3ds", image: "game.cci", format: "z3ds", extension: ".z3ds" },
    { upload: "game.zcci", parentKind: "z3ds", image: "game.cci", format: "z3ds", extension: ".zcci" },
    { upload: "game.zip", parentKind: "zip", image: "game.nds", format: "zip", extension: ".zip" },
    { upload: "game.zip", parentKind: "zip", image: "game.3ds", format: "zip", extension: ".zip", mode: "auto" },
  ])(
    "repacks a ROM extracted from $upload as $extension",
    async ({ upload, parentKind, image, format, extension, mode }) => {
      extracted = { fileName: image, parentKind };
      const { container } = renderForm({
        pageDrop: { files: [new File(["rom"], upload)], id: 1 },
        settings: { defaultCompression: mode ?? "zip/special" },
      });
      await vi.waitFor(() => expect(latest?.workflow.getInput()?.status).toBe("ready"));
      await vi.waitFor(() =>
        expect((container.querySelector("#trim-builder-select-output-format") as HTMLSelectElement).value).toBe(format),
      );
      await act(async () => fireEvent.click(container.querySelector("#trim-builder-button-run") as HTMLButtonElement));
      const confirm = Array.from(document.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Trim ROM"),
      );
      await act(async () => fireEvent.click(confirm as HTMLButtonElement));
      await vi.waitFor(() => expect(latest?.workflow.run).toHaveBeenCalled());
      expect(latest?.workflow.setOutputName.mock.calls.at(-1)?.[0]).toMatch(new RegExp(`\\${extension}$`));
    },
  );

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

  it("appends the real output extension to a typed trim name with a dotted version", async () => {
    const file = new File(["rom"], "game.nes", { type: "application/octet-stream" });
    const { container } = renderForm({ settings: { zipCodec: "store", zipLevel: 0 } });
    const input = container.querySelector("#trim-builder-input-file-unified") as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
      fireEvent.change(input);
    });
    await vi.waitFor(() => expect(container.querySelector("#trim-builder-output-file")).toBeTruthy());
    const runWithTypedName = async (typedName: string) => {
      const nameField = container.querySelector("#trim-builder-output-file") as HTMLInputElement;
      fireEvent.change(nameField, { target: { value: typedName } });
      await act(async () => fireEvent.click(container.querySelector("#trim-builder-button-run") as HTMLButtonElement));
      const confirm = Array.from(document.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Trim ROM"),
      );
      await act(async () => fireEvent.click(confirm as HTMLButtonElement));
      await vi.waitFor(() => expect(latest?.workflow.run).toHaveBeenCalled());
      return latest?.workflow.setOutputName.mock.calls.at(-1)?.[0];
    };

    expect(await runWithTypedName("Hack v1.2")).toBe("Hack v1.2.zip");
  });

  it("keeps a typed dotted version that extends the source name", async () => {
    const file = new File(["rom"], "Hack v1.nds", { type: "application/octet-stream" });
    const { container } = renderForm();
    const input = container.querySelector("#trim-builder-input-file-unified") as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
      fireEvent.change(input);
    });
    await vi.waitFor(() => expect(container.querySelector("#trim-builder-output-file")).toBeTruthy());
    const nameField = container.querySelector("#trim-builder-output-file") as HTMLInputElement;
    fireEvent.change(nameField, { target: { value: "Hack v1.2" } });

    expect((container.querySelector("#trim-builder-output-file") as HTMLInputElement).value).toBe("Hack v1.2");
  });

  it("appends the real output extension to a typed trim name with a dotted version", async () => {
    const file = new File(["rom"], "game.nes", { type: "application/octet-stream" });
    const { container } = renderForm({ settings: { zipCodec: "store", zipLevel: 0 } });
    const input = container.querySelector("#trim-builder-input-file-unified") as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
      fireEvent.change(input);
    });
    await vi.waitFor(() => expect(container.querySelector("#trim-builder-output-file")).toBeTruthy());
    const runWithTypedName = async (typedName: string) => {
      const nameField = container.querySelector("#trim-builder-output-file") as HTMLInputElement;
      fireEvent.change(nameField, { target: { value: typedName } });
      await act(async () => fireEvent.click(container.querySelector("#trim-builder-button-run") as HTMLButtonElement));
      const confirm = Array.from(document.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Trim ROM"),
      );
      await act(async () => fireEvent.click(confirm as HTMLButtonElement));
      await vi.waitFor(() => expect(latest?.workflow.run).toHaveBeenCalled());
      return latest?.workflow.setOutputName.mock.calls.at(-1)?.[0];
    };

    expect(await runWithTypedName("Hack v1.2")).toBe("Hack v1.2.zip");
  });

  describe("restore padding", () => {
    const stageRom = async (fileName: string) => {
      const file = new File(["rom"], fileName, { type: "application/octet-stream" });
      const view = renderForm({ pageDrop: { files: [file], id: 1 } });
      await vi.waitFor(() => expect(view.container.querySelector("#trim-builder-button-run")).toBeTruthy());
      await waitForWorkflow();
      await vi.waitFor(() => expect(view.container.textContent).toContain("Trim Example (USA)"));
      return view;
    };
    const confirmRun = async (container: HTMLElement, confirmLabel: string) => {
      await act(async () => fireEvent.click(container.querySelector("#trim-builder-button-run") as HTMLButtonElement));
      const confirm = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === confirmLabel && !button.closest("#trim-builder-mode"),
      );
      expect(confirm).toBeTruthy();
      await act(async () => fireEvent.click(confirm as HTMLButtonElement));
      await vi.waitFor(() => expect(latest?.workflow.run).toHaveBeenCalled());
    };
    const modeButton = (container: HTMLElement, label: string) =>
      Array.from(container.querySelectorAll("#trim-builder-mode button")).find(
        (button) => button.textContent === label,
      ) as HTMLButtonElement;

    it("defaults an already-trimmed ROM to restoring its padding", async () => {
      paddingTrimmed = true;
      const { container } = await stageRom("game (trimmed).nes");
      await vi.waitFor(() =>
        expect(container.querySelector("#trim-builder-button-run")?.textContent).toContain("RESTORE & DOWNLOAD"),
      );
      expect(modeButton(container, "Restore padding").getAttribute("aria-pressed")).toBe("true");
      const nameField = container.querySelector("#trim-builder-output-file") as HTMLInputElement;
      expect(nameField.value).toBe("Trim Example (USA)");
      await confirmRun(container, "Restore padding");
      expect(latest?.workflow.setMode).toHaveBeenLastCalledWith("restore");
      expect(String(latest?.workflow.setOutputName.mock.calls.at(-1)?.[0])).not.toContain("(trimmed)");
    });

    it("names a restore of an unlabelled ROM so it differs from the input", async () => {
      paddingTrimmed = true;
      const { container } = await stageRom("game.nes");
      const nameField = container.querySelector("#trim-builder-output-file") as HTMLInputElement;
      fireEvent.change(nameField, { target: { value: "game" } });
      await confirmRun(container, "Restore padding");
      expect(String(latest?.workflow.setOutputName.mock.calls.at(-1)?.[0])).toMatch(/^game \(restored\)\./);
    });

    it("lets the user switch a trimmed ROM back to trimming", async () => {
      paddingTrimmed = true;
      const { container } = await stageRom("game.nes");
      await vi.waitFor(() => expect(modeButton(container, "Trim")).toBeTruthy());
      await act(async () => fireEvent.click(modeButton(container, "Trim")));
      expect(container.querySelector("#trim-builder-button-run")?.textContent).toContain("TRIM & DOWNLOAD");
      expect((container.querySelector("#trim-builder-output-file") as HTMLInputElement).value).toBe(
        "Trim Example (USA) (trimmed)",
      );
      await confirmRun(container, "Trim ROM");
      expect(latest?.workflow.setMode).toHaveBeenLastCalledWith("trim");
    });

    it("keeps trim selected for an untrimmed ROM that can be restored", async () => {
      paddingTrimmed = false;
      const { container } = await stageRom("game.nes");
      await vi.waitFor(() => expect(container.querySelector("#trim-builder-mode")).toBeTruthy());
      expect(modeButton(container, "Trim").getAttribute("aria-pressed")).toBe("true");
      await act(async () => fireEvent.click(container.querySelector("#trim-builder-button-run") as HTMLButtonElement));
      expect(document.body.textContent).toContain("A 12-byte revert marker at its end records the removed padding");
      await confirmRun(container, "Trim ROM");
      expect(latest?.workflow.setMode).toHaveBeenLastCalledWith("trim");
    });

    it("offers no mode switch when the input cannot be restored", async () => {
      const { container } = await stageRom("game.nes");
      expect(container.querySelector("#trim-builder-mode")).toBeNull();
      await confirmRun(container, "Trim ROM");
      expect(latest?.workflow.setMode).toHaveBeenLastCalledWith("trim");
    });
  });
});
