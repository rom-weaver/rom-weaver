// @vitest-environment happy-dom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import { listDroppedArchiveEntryNames } from "../../src/lib/input/input-preparation-archive.ts";
import type { BinarySource } from "../../src/public/react/patcher-form.ts";

vi.mock("../../src/public/react/apply-patch-form.tsx", async () => {
  const { useEffect, useState } = await import("react");
  return {
    ApplyPatchForm: (props: import("../../src/public/react/public-types.ts").ApplyPatchFormProps) => {
      const [stack, setStack] = useState<string[]>([]);
      useEffect(() => {
        const files = props.pageDrop?.files;
        if (files) setStack((current) => [...current, ...files.map((file) => file.name)]);
      }, [props.pageDrop]);
      return (
        <section data-testid="aggregate-create" data-active={props.active}>
          {props.createModeControls}
          <output data-testid="aggregate-original">{props.inputs?.[0]?.name}</output>
          <output data-testid="aggregate-stack">{stack.join(",")}</output>
          <button type="button" onClick={() => setStack((current) => [...current, "manual cheat"])}>
            Add test cheat
          </button>
        </section>
      );
    },
  };
});

vi.mock("../../src/lib/input/input-preparation-archive.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/input/input-preparation-archive.ts")>()),
  listDroppedArchiveEntryNames: vi.fn(async () => ["fix.ips"]),
}));

type FakeEventListener = (payload: unknown) => void;

type FakeSource = {
  candidates: Array<{ id: string; label: string }>;
  checksums: { crc32: string; md5: string; sha1: string };
  fileName: string;
  id: string;
  identification?: {
    matches: Array<{ algorithm: string; database: string; name: string; platform: string; variant: string }>;
    status: "matched";
  };
  parentCompressions: [];
  selectedCandidateId: string;
  size: number;
  status: "ready";
  warnings: [];
};

const sourceState = (fileName: string, role: "original" | "modified"): FakeSource => ({
  candidates: [{ id: `${role}-candidate`, label: `${role} candidate` }],
  checksums: { crc32: "C6FB1252", md5: "0123456789abcdef", sha1: "0123456789012345678901234567890123456789" },
  fileName,
  id: `${role}-1`,
  identification:
    role === "original"
      ? {
          matches: [
            {
              algorithm: "crc32",
              database: "No-Intro",
              name: "Example Game (USA)",
              platform: "Nintendo Entertainment System",
              variant: "raw",
            },
          ],
          status: "matched",
        }
      : undefined,
  parentCompressions: [],
  selectedCandidateId: `${role}-candidate`,
  size: 128,
  status: "ready",
  warnings: [],
});

const makeFakeWorkflow = () => {
  let original: FakeSource | null = null;
  let modified: FakeSource | null = null;
  let disposed = false;
  const listeners = new Map<string, Set<FakeEventListener>>();
  const output = {
    dispose: vi.fn(async () => undefined),
    fileName: "example.bps",
    prepareDownload: vi.fn(async () => undefined),
    saveAs: vi.fn(async () => undefined),
    size: 64,
  };
  const workflow = {
    abort: vi.fn(),
    dispose: vi.fn(async () => {
      disposed = true;
    }),
    getModified: vi.fn(() => modified),
    getOriginal: vi.fn(() => original),
    isDisposed: () => disposed,
    off: vi.fn((event: string, listener: FakeEventListener) => listeners.get(event)?.delete(listener)),
    on: vi.fn((event: string, listener: FakeEventListener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)?.add(listener);
    }),
    run: vi.fn(async () => ({
      modified,
      original,
      output,
      sizeSummary: { createTimeMs: 12, outputSize: 64, rawSize: 128 },
      type: "bps",
    })),
    setModified: vi.fn(async (source: BinarySource) => {
      if (nextModifiedError) {
        const error = nextModifiedError;
        nextModifiedError = null;
        throw error;
      }
      modified =
        source instanceof File ? sourceState(source.name, "modified") : sourceState("modified.nes", "modified");
    }),
    setOriginal: vi.fn(async (source: BinarySource) => {
      if (nextOriginalError) {
        const error = nextOriginalError;
        nextOriginalError = null;
        throw error;
      }
      original =
        source instanceof File ? sourceState(source.name, "original") : sourceState("original.nes", "original");
    }),
    setOutputName: vi.fn(async () => undefined),
    setCheatCodes: vi.fn(async () => undefined),
    setPatchType: vi.fn(async () => undefined),
    setSettings: vi.fn(async () => undefined),
    swap: vi.fn(async () => {
      const previous = original;
      original = modified;
      modified = previous;
    }),
  };
  return { output, workflow };
};

let latest: ReturnType<typeof makeFakeWorkflow> | null = null;
let nextOriginalError: Error | null = null;
let nextModifiedError: Error | null = null;

class FakeCreateWorkflow {
  constructor() {
    latest = makeFakeWorkflow();
    Object.assign(this, latest.workflow);
  }
}

const renderForm = (props: Record<string, unknown> = {}, settings: { betaToolsEnabled?: boolean } = {}) =>
  render(
    <RomWeaverSettingsProvider settings={settings}>
      <CreatePatchFormForTest {...props} />
    </RomWeaverSettingsProvider>,
  );

// The stateful form intentionally accepts these test-only seams internally;
// keep the public props type in production unchanged.
const CreatePatchFormForTest = (props: Record<string, unknown>) => {
  const { CreatePatchForm } = requireCreatePatchForm();
  return <CreatePatchForm {...(props as never)} />;
};

let createPatchFormModule: typeof import("../../src/public/react/create-patch-form.tsx") | null = null;
const requireCreatePatchForm = () => {
  if (!createPatchFormModule) throw new Error("CreatePatchForm module was not loaded");
  return createPatchFormModule;
};

beforeEach(async () => {
  createPatchFormModule = await import("../../src/public/react/create-patch-form.tsx");
  window.history.replaceState(null, "", "/create-patch");
  latest = null;
  nextOriginalError = null;
  nextModifiedError = null;
});

afterEach(() => {
  vi.restoreAllMocks();
  latest = null;
  createPatchFormModule = null;
  nextOriginalError = null;
  nextModifiedError = null;
});

const withSeams = (props: Record<string, unknown> = {}) => ({
  ...props,
  createWorkflow: FakeCreateWorkflow,
  getCreatePatchFormatCandidates: vi.fn(async () => ({ defaultFormat: "bps", formats: ["bps", "ips"] })),
});

describe("CreatePatchForm", () => {
  it("renders the empty hero and handles a failed sample download", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
    const { container } = renderForm(withSeams());

    expect(container.querySelector("#patch-builder-input-file-unified")).toBeTruthy();
    expect(container.querySelectorAll(".step-num")).toHaveLength(1);

    const chip = container.querySelector(".sample-tutorial-start-chip") as HTMLButtonElement;
    expect(chip.textContent).toBe("Create a sample");
    await act(async () => {
      fireEvent.click(chip);
    });
    const start = Array.from(container.querySelectorAll("a")).find((link) =>
      link.textContent?.includes("Start guided Create"),
    );
    expect(start).toBeTruthy();
    await act(async () => {
      fireEvent.click(start as HTMLAnchorElement);
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await vi.waitFor(() => expect(container.textContent).toContain("Could not load the sample. Try again."));
  });

  it("stages both ROMs, exposes output controls, swaps sources, and creates a patch", async () => {
    const onComplete = vi.fn();
    const { container } = renderForm(withSeams({ onCreateComplete: onComplete }));
    const input = container.querySelector("#patch-builder-input-file-unified") as HTMLInputElement;
    const original = new File(["original"], "original.nes", { type: "application/octet-stream" });
    const modified = new File(["modified"], "modified.nes", { type: "application/octet-stream" });

    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: [original, modified] });
      fireEvent.change(input);
    });
    await vi.waitFor(() => expect(latest?.workflow.setOriginal).toHaveBeenCalled());
    await vi.waitFor(() => expect(latest?.workflow.setModified).toHaveBeenCalled());
    await vi.waitFor(() => expect(container.querySelector("#patch-builder-button-create")).toBeTruthy());

    expect(container.querySelectorAll(".step-num")).toHaveLength(4);
    expect(container.querySelector("#patch-builder-button-swap-sources")).toBeTruthy();
    expect(container.textContent).toContain("Example Game (USA)");

    const outputName = container.querySelector("#patch-builder-output-file") as HTMLInputElement;
    expect(outputName.value).toContain("Example Game (USA)");
    await act(async () => {
      fireEvent.change(outputName, { target: { value: "shareable-patch" } });
    });
    const patchType = container.querySelector("#patch-builder-select-patch-type") as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(patchType, { target: { value: "ips" } });
      fireEvent.click(container.querySelector("#patch-builder-button-swap-sources") as HTMLButtonElement);
    });
    expect(latest?.workflow.swap).toHaveBeenCalled();
    expect(latest?.workflow.setPatchType).not.toHaveBeenCalled();

    const create = container.querySelector("#patch-builder-button-create") as HTMLButtonElement;
    await vi.waitFor(() => expect(create.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(create);
    });
    await vi.waitFor(() => expect(latest?.workflow.run).toHaveBeenCalled());
    await vi.waitFor(() => expect(latest?.output.saveAs).toHaveBeenCalled());
    expect(onComplete).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Patch .ips");
  });

  const stageOriginalOnly = async (settings: { betaToolsEnabled?: boolean }) => {
    const original = new File(["original"], "original.nes", { type: "application/octet-stream" });
    const view = renderForm(withSeams(), settings);
    const input = view.container.querySelector("#patch-builder-input-file-unified") as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: [original] });
      fireEvent.change(input);
    });
    await vi.waitFor(() => expect(latest?.workflow.setOriginal).toHaveBeenCalled());
    await vi.waitFor(() => expect(view.container.querySelectorAll(".step-num")).toHaveLength(4));
    return view;
  };
  const activeButton = (container: HTMLElement, text: string) =>
    Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === text && !button.closest("[hidden]"),
    ) as HTMLButtonElement;
  const upload = async (container: HTMLElement, files: File[]) => {
    const input = container.querySelector("#patch-builder-input-file-unified") as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: files });
      fireEvent.change(input);
    });
  };

  it("defaults to Modified ROM and offers Patches & cheats without beta tools", async () => {
    const { container } = await stageOriginalOnly({});
    expect(activeButton(container, "Modified ROM").getAttribute("aria-pressed")).toBe("true");
    expect(activeButton(container, "Patches & cheats").disabled).toBe(false);
    expect(container.querySelector('[data-testid="aggregate-create"]')).toBeNull();
  });

  it("preserves original, modified ROM, and ordered patches and cheats across mode switches", async () => {
    const { container } = await stageOriginalOnly({});
    const modified = new File(["modified"], "modified.nes");
    await upload(container, [modified]);
    await vi.waitFor(() => expect(latest?.workflow.setModified).toHaveBeenCalledWith(modified));
    await act(async () => fireEvent.click(activeButton(container, "Patches & cheats")));
    expect(container.querySelector('[data-testid="aggregate-original"]')?.textContent).toBe("original.nes");
    await act(async () => fireEvent.click(activeButton(container, "Add test cheat")));
    await act(async () => fireEvent.click(activeButton(container, "Modified ROM")));
    expect(container.querySelector("#patch-builder-row-modified")?.textContent).toContain("modified.nes");
    await upload(container, [new File(["patch"], "first.ips"), new File(["patch"], "second.bps")]);
    await vi.waitFor(() =>
      expect(activeButton(container, "Patches & cheats").getAttribute("aria-pressed")).toBe("true"),
    );
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="aggregate-stack"]')?.textContent).toBe(
        "manual cheat,first.ips,second.bps",
      ),
    );
    await act(async () => fireEvent.click(activeButton(container, "Modified ROM")));
    expect(container.querySelector("#patch-builder-row-modified")?.textContent).toContain("modified.nes");
    await act(async () => fireEvent.click(activeButton(container, "Patches & cheats")));
    expect(container.querySelector('[data-testid="aggregate-stack"]')?.textContent).toBe(
      "manual cheat,first.ips,second.bps",
    );
  });

  it("detects patches from actual archive listings before routing to the stack", async () => {
    const { container } = renderForm(withSeams());
    await upload(container, [new File(["archive"], "release.zip")]);
    await vi.waitFor(() =>
      expect(activeButton(container, "Patches & cheats").getAttribute("aria-pressed")).toBe("true"),
    );
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="aggregate-stack"]')?.textContent).toBe("release.zip"),
    );
    expect(latest).toBeNull();
  });

  it("uses the aggregate mode when an archive contains both a ROM and patches", async () => {
    vi.mocked(listDroppedArchiveEntryNames).mockResolvedValueOnce(["game.nes", "fix.ips"]);
    const { container } = renderForm(withSeams());
    await upload(container, [new File(["archive"], "mixed.zip")]);
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="aggregate-stack"]')?.textContent).toBe("mixed.zip"),
    );
    expect(activeButton(container, "Patches & cheats").getAttribute("aria-pressed")).toBe("true");
  });

  it("switches to the aggregate mode for canonical weave drops", async () => {
    const { container } = renderForm(withSeams());
    await upload(container, [new File(["{}"], "rom-weaver-weave.json")]);
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="aggregate-stack"]')?.textContent).toBe("rom-weaver-weave.json"),
    );
    expect(activeButton(container, "Patches & cheats").getAttribute("aria-pressed")).toBe("true");
  });

  it("reports duplicate drops and allows the user to confirm them", async () => {
    const file = new File(["same"], "same.nes", { type: "application/octet-stream" });
    const { container } = renderForm(withSeams());
    const input = container.querySelector("#patch-builder-input-file-unified") as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
      fireEvent.change(input);
    });
    await vi.waitFor(() => expect(latest?.workflow.setOriginal).toHaveBeenCalled());
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
      fireEvent.change(input);
    });
    await vi.waitFor(() => expect(document.body.textContent).toContain("same ROM"));
    const confirm = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Use duplicate ROMs"),
    );
    expect(confirm).toBeTruthy();
    await act(async () => {
      fireEvent.click(confirm as HTMLButtonElement);
    });
    await vi.waitFor(() => expect(latest?.workflow.setOriginal).toHaveBeenCalled());
  });

  it("reports a source staging error and keeps the failed source visible", async () => {
    nextOriginalError = new Error("original staging failed");
    const onError = vi.fn();
    const file = new File(["original"], "original.nes", { type: "application/octet-stream" });
    const { container } = renderForm(withSeams({ onError }));
    const input = container.querySelector("#patch-builder-input-file-unified") as HTMLInputElement;

    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
      fireEvent.change(input);
    });
    await vi.waitFor(() => expect(container.textContent).toContain("original staging failed"));

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "original staging failed" }));
    expect(latest?.workflow.getOriginal()).toBeNull();
  });

  it("reports a modified-ROM staging error after the original is ready", async () => {
    nextModifiedError = new Error("modified staging failed");
    const onError = vi.fn();
    const original = new File(["original"], "original.nes", { type: "application/octet-stream" });
    const modified = new File(["modified"], "modified.nes", { type: "application/octet-stream" });
    const { container } = renderForm(withSeams({ onError }));
    const input = container.querySelector("#patch-builder-input-file-unified") as HTMLInputElement;

    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: [original, modified] });
      fireEvent.change(input);
    });
    await vi.waitFor(() => expect(container.textContent).toContain("modified staging failed"));

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "modified staging failed" }));
  });

  it("clears a completed create output and reports a second-download failure", async () => {
    const fileA = new File(["a"], "original.nes", { type: "application/octet-stream" });
    const fileB = new File(["b"], "modified.nes", { type: "application/octet-stream" });
    const { container } = renderForm(withSeams());
    const input = container.querySelector("#patch-builder-input-file-unified") as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: [fileA, fileB] });
      fireEvent.change(input);
    });
    await vi.waitFor(() => expect(container.querySelector("#patch-builder-button-create")).toBeTruthy());
    await act(async () =>
      fireEvent.click(container.querySelector("#patch-builder-button-create") as HTMLButtonElement),
    );
    await vi.waitFor(() => expect(latest?.output.saveAs).toHaveBeenCalled());

    latest?.output.saveAs.mockRejectedValueOnce(new Error("patch download failed"));
    await act(async () =>
      fireEvent.click(container.querySelector("#patch-builder-button-create") as HTMLButtonElement),
    );
    await vi.waitFor(() => expect(container.textContent).toContain("patch download failed"));
    expect(latest?.output.saveAs).toHaveBeenCalledWith({ interactive: true });
  });

  it("clears candidate format results when format probing fails", async () => {
    const getCandidates = vi.fn().mockRejectedValue(new Error("format probe failed"));
    const fileA = new File(["a"], "original.nes", { type: "application/octet-stream" });
    const fileB = new File(["b"], "modified.nes", { type: "application/octet-stream" });
    const seams = withSeams();
    seams.getCreatePatchFormatCandidates = getCandidates;
    const { container } = renderForm(seams);
    const input = container.querySelector("#patch-builder-input-file-unified") as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: [fileA, fileB] });
      fireEvent.change(input);
    });
    await vi.waitFor(() => expect(getCandidates).toHaveBeenCalled());
    expect(container.querySelector("#patch-builder-button-create")).toBeTruthy();
    expect(container.textContent).not.toContain("format probe failed");
  });
});
