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
        <section data-testid="aggregate-create" data-active={props.active} data-cheats-page={props.cheatsPage}>
          {props.createModeControls}
          <output data-testid="aggregate-original">{props.inputs?.[0]?.name}</output>
          <output data-testid="aggregate-stack">{stack.join(",")}</output>
          <button type="button" onClick={() => setStack((current) => [...current, "manual cheat"])}>
            Add test cheat
          </button>
          <button type="button" onClick={() => props.onCreateRomDrop?.([new File(["chosen"], "chosen.nes")], true)}>
            Choose test ROM as Modified
          </button>
          <button
            type="button"
            onClick={() => props.onCreateRomDrop?.([new File(["modified"], "modified.nes", { lastModified: 1 })], true)}
          >
            Choose loaded Modified again
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
    setModified: vi.fn(async (input: BinarySource | BinarySource[]) => {
      const source = Array.isArray(input) ? input[0] : input;
      if (nextModifiedError) {
        const error = nextModifiedError;
        nextModifiedError = null;
        throw error;
      }
      modified =
        source instanceof File
          ? { ...sourceState(source.name, "modified"), size: source.size }
          : sourceState("modified.nes", "modified");
    }),
    setOriginal: vi.fn(async (input: BinarySource | BinarySource[]) => {
      const source = Array.isArray(input) ? input[0] : input;
      if (nextOriginalError) {
        const error = nextOriginalError;
        nextOriginalError = null;
        throw error;
      }
      original =
        source instanceof File
          ? { ...sourceState(source.name, "original"), size: source.size }
          : sourceState("original.nes", "original");
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
  window.history.replaceState(null, "", "/create-rom-patch");
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
  createWorkflow: FakeCreateWorkflow,
  getCreatePatchFormatCandidates: vi.fn(async () => ({ defaultFormat: "bps", formats: ["bps", "ips"] })),
  ...props,
});

describe("CreatePatchForm", () => {
  it("renders the empty hero and handles a failed sample download", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
    const { container } = renderForm(withSeams());

    expect(container.querySelector("#patch-builder-input-file-unified")).toBeTruthy();
    expect(container.querySelectorAll(".step-num")).toHaveLength(1);

    const chip = container.querySelector(".sample-tutorial-start-chip") as HTMLButtonElement;
    expect(chip.textContent).toBe("Make a patch from practice ROMs");
    await act(async () => {
      fireEvent.click(chip);
    });
    const start = Array.from(container.querySelectorAll("a")).find((link) =>
      link.textContent?.includes("Start a practice run"),
    );
    expect(start).toBeTruthy();
    await act(async () => {
      fireEvent.click(start as HTMLAnchorElement);
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Couldn't load the practice files. Check your connection and try again."),
    );
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

  it.each(["cheats", "rom", undefined] as const)("opens the %s entry in its requested mode", async (entry) => {
    const { container } = renderForm(withSeams({ entry }));
    expect(activeButton(container, "Patches & cheats").getAttribute("aria-pressed")).toBe(String(entry === "cheats"));
    const aggregate = container.querySelector('[data-testid="aggregate-create"]');
    expect(aggregate?.getAttribute("data-cheats-page") ?? null).toBe(entry === "cheats" ? "true" : null);
    // The hidden Modified ROM form leaves the page heading to the visible form.
    expect(container.querySelectorAll("h1")).toHaveLength(entry === "cheats" ? 0 : 1);
  });

  it("switches mode once per entry request while keeping staged ROMs", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    const seams = withSeams({
      entry: "rom",
      defaultOriginal: new File(["original"], "original.nes"),
      defaultModified: new File(["modified"], "modified.nes"),
    });
    const { container, rerender } = renderForm(seams);
    await vi.waitFor(() => expect(latest?.workflow.setModified).toHaveBeenCalled());
    const workflow = latest?.workflow;
    const changeEntry = async (entry: "cheats" | "rom" | undefined, disabled = false) => {
      await act(async () =>
        rerender(
          <RomWeaverSettingsProvider settings={{}}>
            <CreatePatchFormForTest {...seams} entry={entry} disabled={disabled} />
          </RomWeaverSettingsProvider>,
        ),
      );
    };
    const pressed = (label: string) => activeButton(container, label).getAttribute("aria-pressed");
    await changeEntry("cheats");
    expect(pressed("Patches & cheats")).toBe("true");
    await changeEntry(undefined);
    expect(pressed("Patches & cheats")).toBe("true");
    await changeEntry("rom", true);
    expect(pressed("Patches & cheats")).toBe("true");
    await changeEntry("rom");
    expect(pressed("Modified ROM")).toBe("true");
    expect(container.textContent).toContain("modified.nes");
    expect(latest?.workflow).toBe(workflow);
    expect(workflow?.setOriginal).toHaveBeenCalledTimes(1);
    expect(workflow?.setModified).toHaveBeenCalledTimes(1);
    await act(async () => fireEvent.click(activeButton(container, "Patches & cheats")));
    await changeEntry("rom");
    expect(pressed("Patches & cheats")).toBe("true");
    // A later request for the same mode, after the first one cleared, applies again.
    await changeEntry(undefined);
    await changeEntry("rom");
    expect(pressed("Modified ROM")).toBe("true");
  });

  it("keeps Patches & cheats active for a ROM dropped on the page", async () => {
    const props = withSeams();
    const view = (pageDrop?: { files: File[]; id: number }) => (
      <RomWeaverSettingsProvider settings={{}}>
        <CreatePatchFormForTest {...props} pageDrop={pageDrop} />
      </RomWeaverSettingsProvider>
    );
    const { container, rerender } = render(view());
    await act(async () => fireEvent.click(activeButton(container, "Patches & cheats")));
    const rom = new File(["rom"], "other.nes");
    await act(async () => rerender(view({ files: [rom], id: 1 })));
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="aggregate-stack"]')?.textContent).toBe("other.nes"),
    );
    expect(activeButton(container, "Patches & cheats").getAttribute("aria-pressed")).toBe("true");
  });

  it("replaces a filled Modified ROM with a ROM chosen as Modified in Patches & cheats", async () => {
    const { container } = await stageOriginalOnly({});
    await upload(container, [new File(["modified"], "modified.nes")]);
    await vi.waitFor(() => expect(latest?.workflow.setModified).toHaveBeenCalledOnce());
    await act(async () => fireEvent.click(activeButton(container, "Patches & cheats")));
    await act(async () => fireEvent.click(activeButton(container, "Choose test ROM as Modified")));
    await vi.waitFor(() =>
      expect(latest?.workflow.setModified).toHaveBeenLastCalledWith(expect.objectContaining({ name: "chosen.nes" })),
    );
    expect(activeButton(container, "Modified ROM").getAttribute("aria-pressed")).toBe("true");
  });

  it("does not call a re-chosen Modified ROM a duplicate of the one it replaces", async () => {
    const { container } = await stageOriginalOnly({});
    await upload(container, [new File(["modified"], "modified.nes", { lastModified: 1 })]);
    await vi.waitFor(() => expect(latest?.workflow.setModified).toHaveBeenCalledOnce());
    await act(async () => fireEvent.click(activeButton(container, "Patches & cheats")));
    await act(async () => fireEvent.click(activeButton(container, "Choose loaded Modified again")));
    await vi.waitFor(() => expect(activeButton(container, "Modified ROM").getAttribute("aria-pressed")).toBe("true"));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(container.querySelector("#patch-builder-row-modified")?.textContent).toContain("modified.nes");
    expect(container.ownerDocument.body.textContent).not.toContain("Use duplicate ROMs");
  });

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

  it("defers new original staging until Modified ROM is active again", async () => {
    const initial = new File(["original"], "original.nes");
    const archive = new File(["archive"], "multiple-roms.zip");
    const props = withSeams();
    const view = (original: File) => (
      <RomWeaverSettingsProvider settings={{}}>
        <CreatePatchFormForTest {...props} original={original} />
      </RomWeaverSettingsProvider>
    );
    const { container, rerender } = render(view(initial));
    await vi.waitFor(() => expect(latest?.workflow.setOriginal).toHaveBeenCalledWith(initial));
    const workflow = latest?.workflow;
    if (!workflow) throw new Error("Expected a staged create workflow");
    await act(async () => fireEvent.click(activeButton(container, "Patches & cheats")));
    await act(async () => rerender(view(archive)));

    expect(workflow.setOriginal).toHaveBeenCalledTimes(1);
    await act(async () => fireEvent.click(activeButton(container, "Modified ROM")));
    await vi.waitFor(() => expect(workflow.setOriginal).toHaveBeenLastCalledWith(archive));
    expect(workflow.setOriginal).toHaveBeenCalledTimes(2);
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

  it.each(["original", "modified"] as const)("keeps NFS companions when assigning %s automatically", async (role) => {
    vi.mocked(listDroppedArchiveEntryNames).mockResolvedValue(["disc.iso"]);
    const nfs = new File(["header"], "hif_000000.nfs");
    const key = new File(["synthetic-key"], "htk.bin");
    const part = new File(["segment"], "hif_000001.nfs");
    const other = new File(["other"], "other.iso");
    const files = role === "original" ? [key, nfs, other, part] : [other, part, key, nfs];
    const { container } = renderForm(withSeams());
    const input = container.querySelector("#patch-builder-input-file-unified") as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: files });
      fireEvent.change(input);
    });
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    const setter = () => (role === "original" ? latest?.workflow.setOriginal : latest?.workflow.setModified);
    await vi.waitFor(() =>
      expect(setter()).toHaveBeenCalledWith([nfs, ...files.filter((file) => file === key || file === part)]),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).not.toContain("htk.bin");
    await act(async () => {
      fireEvent.click(container.querySelector("#patch-builder-button-swap-sources") as HTMLButtonElement);
    });
    expect(latest?.workflow.swap).toHaveBeenCalledOnce();
    expect(setter()).toHaveBeenCalledTimes(1);
  });

  it.each(["original", "modified"] as const)("keeps the NFS group through the %s candidate picker", async (role) => {
    vi.mocked(listDroppedArchiveEntryNames).mockResolvedValue(["disc.iso"]);
    const nfs = new File(["header"], "hif_000000.nfs");
    const key = new File(["synthetic-key"], "htk.bin");
    const other = new File(["other"], "other.iso");
    const extra = new File(["extra"], "extra.iso");
    const { container } = renderForm(withSeams());
    const input = container.querySelector("#patch-builder-input-file-unified") as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: [key, nfs, other, extra] });
      fireEvent.change(input);
    });
    const choose = async (name: string) => {
      await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeTruthy());
      const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
      expect(dialog.textContent).not.toContain("htk.bin");
      const button = Array.from(dialog.querySelectorAll("button")).find((item) => item.textContent?.includes(name));
      expect(button).toBeTruthy();
      await act(async () => fireEvent.click(button as HTMLButtonElement));
    };
    await choose(role === "original" ? nfs.name : other.name);
    await choose(role === "original" ? other.name : nfs.name);
    await vi.waitFor(() =>
      expect(role === "original" ? latest?.workflow.setOriginal : latest?.workflow.setModified).toHaveBeenCalledWith([
        nfs,
        key,
      ]),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("reports ambiguous NFS sets without crashing or assigning a source", async () => {
    vi.mocked(listDroppedArchiveEntryNames).mockResolvedValue(["disc.iso"]);
    const onError = vi.fn();
    const { container } = renderForm(withSeams({ onError }));
    const input = container.querySelector("#patch-builder-input-file-unified") as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, "files", {
        configurable: true,
        value: [
          new File(["first"], "hif_000000.nfs"),
          new File(["first-key"], "htk.bin"),
          new File(["second"], "hif_000000.nfs"),
          new File(["second-key"], "htk.bin"),
        ],
      });
      fireEvent.change(input);
    });
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "More than one NFS set was supplied; add one set (hif_*.nfs and htk.bin) at a time.",
        }),
      ),
    );
    expect(latest).toBeNull();
    expect(container.querySelector("#patch-builder-input-error")?.textContent).toContain(
      "More than one NFS set was supplied",
    );
    expect(container.querySelector("#patch-builder-input-file-unified")).toBeTruthy();
  });

  it.each([true, false])("refreshes directional formats after Swap (starts shrinking: %s)", async (shrinking) => {
    const small = new File([new Uint8Array(2048)], "small.bin");
    const large = new File([new Uint8Array(4096)], "large.bin");
    const getCandidates = vi.fn(async ({ original, modified }: { original: File; modified: File }) => ({
      defaultFormat: "bps",
      formats: original.size > modified.size ? ["bps", "ips"] : ["bps", "ips", "ebp", "ppf"],
    }));
    const { container } = renderForm(withSeams({ getCreatePatchFormatCandidates: getCandidates }));
    const input = container.querySelector("#patch-builder-input-file-unified") as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: shrinking ? [large, small] : [small, large] });
      fireEvent.change(input);
    });
    const formats = () =>
      Array.from(container.querySelectorAll<HTMLSelectElement>("#patch-builder-select-patch-type option")).map(
        (option) => option.value,
      );
    await vi.waitFor(() => expect(latest?.workflow.getModified()?.status).toBe("ready"));
    await vi.waitFor(() => expect(getCandidates).toHaveBeenCalledTimes(1));
    expect(formats().includes("ppf")).toBe(!shrinking);
    if (!shrinking) {
      await act(async () =>
        fireEvent.change(container.querySelector("#patch-builder-select-patch-type") as HTMLSelectElement, {
          target: { value: "ppf" },
        }),
      );
    }
    await act(async () =>
      fireEvent.click(container.querySelector("#patch-builder-button-swap-sources") as HTMLButtonElement),
    );
    await vi.waitFor(() => expect(getCandidates).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(formats().includes("ppf")).toBe(shrinking));
    expect(formats().includes("ebp")).toBe(shrinking);
    if (!shrinking)
      expect((container.querySelector("#patch-builder-select-patch-type") as HTMLSelectElement).value).toBe("bps");
    expect(latest?.workflow.setOriginal).toHaveBeenCalledTimes(1);
    expect(latest?.workflow.setModified).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("rechecks PMSR eligibility and invalid selection (starts eligible: %s)", async (eligible) => {
    const qualified = new File(["qualified"], "qualified.z64");
    const modified = new File(["modified!"], "modified.z64");
    const getCandidates = vi.fn(async ({ original }: { original: File }) => ({
      defaultFormat: "bps",
      formats: original === qualified ? ["bps", "pmsr"] : ["bps"],
    }));
    const { container } = renderForm(withSeams({ getCreatePatchFormatCandidates: getCandidates }));
    const input = container.querySelector("#patch-builder-input-file-unified") as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, "files", {
        configurable: true,
        value: eligible ? [qualified, modified] : [modified, qualified],
      });
      fireEvent.change(input);
    });
    const select = () => container.querySelector("#patch-builder-select-patch-type") as HTMLSelectElement;
    const hasPmsr = () => !!select()?.querySelector('option[value="pmsr"]');
    const swap = async () =>
      act(async () =>
        fireEvent.click(container.querySelector("#patch-builder-button-swap-sources") as HTMLButtonElement),
      );
    await vi.waitFor(() => expect(latest?.workflow.getModified()?.status).toBe("ready"));
    await vi.waitFor(() => expect(getCandidates).toHaveBeenCalledTimes(1));
    expect(hasPmsr()).toBe(eligible);
    if (!eligible) {
      await swap();
      await vi.waitFor(() => expect(hasPmsr()).toBe(true));
    }
    await act(async () => fireEvent.change(select(), { target: { value: "pmsr" } }));
    expect(select().value).toBe("pmsr");
    await swap();
    await vi.waitFor(() => expect(getCandidates).toHaveBeenCalledTimes(eligible ? 2 : 3));
    expect(hasPmsr()).toBe(false);
    expect(select().value).toBe("bps");
    await act(async () =>
      fireEvent.click(container.querySelector("#patch-builder-button-create") as HTMLButtonElement),
    );
    await vi.waitFor(() => expect(latest?.workflow.setPatchType).toHaveBeenLastCalledWith("bps"));
  });

  it("ignores format results from the old direction when Swap overtakes a probe", async () => {
    let resolveOld: (value: { defaultFormat: string; formats: string[] }) => void = () => undefined;
    const oldProbe = new Promise<{ defaultFormat: string; formats: string[] }>((resolve) => {
      resolveOld = resolve;
    });
    const getCandidates = vi
      .fn()
      .mockReturnValueOnce(oldProbe)
      .mockResolvedValue({ defaultFormat: "bps", formats: ["bps"] });
    const { container } = renderForm(
      withSeams({
        defaultOriginal: new File(["qualified"], "qualified.z64"),
        defaultModified: new File(["modified!"], "modified.z64"),
        getCreatePatchFormatCandidates: getCandidates,
      }),
    );
    await vi.waitFor(() => expect(latest?.workflow.getModified()?.status).toBe("ready"));
    await vi.waitFor(() => expect(getCandidates).toHaveBeenCalledTimes(1));
    await act(async () =>
      fireEvent.click(container.querySelector("#patch-builder-button-swap-sources") as HTMLButtonElement),
    );
    await vi.waitFor(() => expect(getCandidates).toHaveBeenCalledTimes(2));
    await act(async () => resolveOld({ defaultFormat: "bps", formats: ["bps", "pmsr"] }));
    expect(container.querySelector('option[value="pmsr"]')).toBeNull();
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
