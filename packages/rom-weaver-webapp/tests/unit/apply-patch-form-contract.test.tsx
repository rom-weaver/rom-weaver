// @vitest-environment happy-dom
import { act, fireEvent, render } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Container-level contract for `ApplyPatchForm`: the piece above
 * `apply-workflow-view-contract.test.tsx` that wires a real `ApplyWorkflow`
 * session (via `useLocalApplyPatchFormSession` + `workflow-loader.ts`) into
 * `ApplyWorkflowFormView`. `../../src/platform/browser/browser-api.ts` is the
 * single dynamic-import boundary `workflow-loader.ts` calls through
 * (`loadBrowserApi`), so mocking it here swaps the whole wasm-backed workflow
 * for an in-memory fake and keeps this file wasm-free, unlike the heavy
 * `tests/browser/patcher-apply-flow.browser.test.js` suite that drives the
 * real thing.
 */

type FakeApplyWorkflowEvents = Record<string, Set<(payload: unknown) => void>>;

const createFakeApplyWorkflow = () => {
  let input: {
    id: string;
    fileName: string;
    status: string;
    candidates: unknown[];
    checksums?: Record<string, string>;
    selectedCandidateId?: string;
    size?: number;
  } | null = null;
  const patches: Array<{
    id: string;
    fileName: string;
    status: string;
    candidates: unknown[];
    targetInputId?: string;
    targetInputFileName?: string;
  }> = [];
  const listeners: FakeApplyWorkflowEvents = {};
  let runError: Error | null = null;
  let saveError: Error | null = null;
  let disposed = false;
  let busy = false;

  const workflow = {
    abort: vi.fn(),
    addPatch: vi.fn(async (source: { fileName?: string; name?: string }) => {
      patches.push({
        candidates: [],
        fileName: source?.fileName || source?.name || `Patch ${patches.length + 1}`,
        id: `patch-${patches.length + 1}`,
        status: "ready",
        targetInputFileName: input?.fileName,
        targetInputId: input?.id,
      });
    }),
    clearInput: vi.fn(async () => {
      input = null;
    }),
    clearPatches: vi.fn(async () => {
      patches.length = 0;
    }),
    dispose: vi.fn(async () => {
      disposed = true;
    }),
    getBundleExportSources: vi.fn(() => ({ patches: [], rom: null })),
    getInput: vi.fn(() => input),
    getPatches: vi.fn(() => patches.slice()),
    getPatchSources: vi.fn(() => [] as unknown[]),
    getSnapshot: vi.fn(() => ({
      chainPlans: new Map(),
      busy,
      id: "fake-apply-workflow",
      input,
      output: {
        manualOutputFormat: false,
        manualOutputName: false,
        outputFormat: "zip",
        outputName: input ? `${input.fileName.replace(/\.[^.]+$/, "")}-patched.zip` : "",
      },
      patches: patches.slice(),
      ready: !!input && input.status === "ready" && patches.every((patch) => patch.status === "ready"),
    })),
    isDisposed: () => disposed,
    latestChainPlans: new Map(),
    off: vi.fn((event: string, listener: (payload: unknown) => void) => {
      listeners[event]?.delete(listener);
    }),
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      if (!listeners[event]) listeners[event] = new Set();
      listeners[event].add(listener);
    }),
    subscribe: vi.fn((listener: () => void) => {
      if (!listeners.change) listeners.change = new Set();
      listeners.change.add(listener);
      return () => listeners.change?.delete(listener);
    }),
    replacePatchAt: vi.fn(async () => undefined),
    run: vi.fn(async () => {
      if (runError) throw runError;
      return {
        inputs: [{ fileName: input?.fileName || "game.bin", size: input?.size || 13 }],
        outputs: [
          {
            dispose: async () => undefined,
            fileName: "game-patched.bin",
            getBlob: async () => new Blob(["patched"]),
            id: "output-1",
            prepareDownload: async () => undefined,
            saveAs: async () => {
              if (saveError) {
                const error = saveError;
                saveError = null;
                throw error;
              }
            },
            size: 128,
          },
        ],
        patches: patches.slice(),
        sizeSummary: { applyTimeMs: 3, outputSize: 128 },
        timings: {},
      };
    }),
    setInput: vi.fn(
      async (
        sources: Array<{ fileName?: string; name?: string }>,
        handlers?: { onPrepared?: (state: unknown) => void; onFinalized?: (state: unknown) => void },
      ) => {
        const source = sources[0];
        input = {
          candidates: [],
          checksums: { crc32: "C6FB1252" },
          fileName: source?.fileName || source?.name || "rom.bin",
          id: "input-1",
          selectedCandidateId: "input-1",
          size: 13,
          status: "ready",
        };
        handlers?.onPrepared?.(input);
        handlers?.onFinalized?.(input);
      },
    ),
    setDefaultPatchBasis: vi.fn(async () => undefined),
    setOutputFormat: vi.fn(async () => undefined),
    setOutputName: vi.fn(async () => undefined),
    setPatchOption: vi.fn(async () => undefined),
    setPatchTarget: vi.fn(async () => undefined),
    setSettings: vi.fn(async () => undefined),
    validatePatches: vi.fn(async () => undefined),
  };
  return {
    ...workflow,
    // Test-only helpers, not part of the ApplyWorkflow surface.
    __setRunError: (error: Error | null) => {
      runError = error;
    },
    __setSaveError: (error: Error | null) => {
      saveError = error;
    },
    __setBusy: (value: boolean) => {
      busy = value;
      for (const listener of listeners.change || []) listener(undefined);
    },
    __emitProgress: () => {
      for (const listener of listeners.progress || []) listener(undefined);
    },
  };
};

let latestFakeWorkflow: ReturnType<typeof createFakeApplyWorkflow> | null = null;

vi.mock("../../src/platform/browser/browser-api.ts", () => ({
  ApplyWorkflow: class {
    constructor() {
      latestFakeWorkflow = createFakeApplyWorkflow();
      // Instances of this fake class delegate every call to the shared fake
      // workflow object so test code can drive it via `latestFakeWorkflow`.
      Object.assign(this, latestFakeWorkflow);
    }
  },
}));

const { ApplyPatchForm } = await import("../../src/public/react/apply-patch-form.tsx");
const { RomWeaverSettingsProvider } = await import("../../src/public/react/settings-context.tsx");

const renderForm = (props: Parameters<typeof ApplyPatchForm>[0] = {}) =>
  render(
    <RomWeaverSettingsProvider settings={{}}>
      <ApplyPatchForm {...props} />
    </RomWeaverSettingsProvider>,
  );

describe("ApplyPatchForm - empty mount", () => {
  beforeEach(() => window.history.replaceState(null, "", "/apply-patch"));
  afterEach(() => {
    vi.unstubAllGlobals();
    latestFakeWorkflow = null;
  });

  it("mounts to the 0x01 hero without touching the real workflow loader", () => {
    const { container } = renderForm();

    expect(container.querySelector("section.step.is-input.is-empty")).toBeTruthy();
    expect(container.querySelector("#rom-weaver-input-file-unified")).toBeTruthy();
    const numbers = Array.from(container.querySelectorAll(".step-num")).map((el) => el.textContent);
    expect(numbers).toEqual(["0x01"]);
    // Nothing has staged yet, so the fake workflow class is never constructed.
    expect(latestFakeWorkflow).toBeNull();
  });

  it("renders a startup error before constructing an ApplyWorkflow", () => {
    const { container } = renderForm({ startup: { message: "WASM boot failed", status: "error" } });

    expect(container.textContent).toContain("WASM boot failed");
    expect(latestFakeWorkflow).toBeNull();
  });
});

describe("ApplyPatchForm - staging a dropped ROM", () => {
  beforeEach(() => window.history.replaceState(null, "", "/apply-patch"));
  afterEach(() => {
    vi.unstubAllGlobals();
    latestFakeWorkflow = null;
  });

  it("stages a dropped ROM through the fake workflow and discloses the rest of the bench", async () => {
    const { container } = renderForm();
    const fileInput = container.querySelector("#rom-weaver-input-file-unified") as HTMLInputElement;
    expect(fileInput).toBeTruthy();
    const romFile = new File(["rom-bytes"], "game.bin", { type: "application/octet-stream" });

    await act(async () => {
      Object.defineProperty(fileInput, "files", { configurable: true, value: [romFile] });
      fireEvent.change(fileInput);
    });

    await vi.waitFor(() => {
      expect(latestFakeWorkflow?.setInput).toHaveBeenCalled();
    });
    expect(latestFakeWorkflow?.setDefaultPatchBasis).toHaveBeenCalledWith("auto");

    await vi.waitFor(() => {
      expect(container.querySelector("section.step.is-input.is-empty")).toBeNull();
    });
    expect(container.querySelector("#rom-weaver-list-input-stack .card.file")).toBeTruthy();
    expect(container.querySelector("#rom-weaver-row-cheat-stack")).toBeTruthy();
    expect(container.querySelector("#rom-weaver-row-patch-stack .step-num")?.textContent).toBe("0x03");
    expect(container.querySelector("#rom-weaver-row-patch-stack #rom-weaver-row-cheat-stack")).toBeTruthy();
    expect(container.querySelector("#rom-weaver-row-patch-stack button.cheat-add")).toBeTruthy();
  });

  it("does not re-render for progress or snapshot changes outside readiness and output", async () => {
    const onRender = vi.fn();
    const rendered = render(
      <Profiler id="apply-form" onRender={onRender}>
        <RomWeaverSettingsProvider settings={{}}>
          <ApplyPatchForm />
        </RomWeaverSettingsProvider>
      </Profiler>,
    );
    const fileInput = rendered.container.querySelector("#rom-weaver-input-file-unified") as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(fileInput, "files", {
        configurable: true,
        value: [new File(["rom-bytes"], "game.bin", { type: "application/octet-stream" })],
      });
      fireEvent.change(fileInput);
    });
    await vi.waitFor(() => {
      expect((rendered.container.querySelector("#rom-weaver-button-apply") as HTMLButtonElement)?.disabled).toBe(false);
    });
    // Apply MAY enable before staging builds the workflow, and the cheat section loads its database
    // on its own schedule; both MUST settle before commits are counted.
    await vi.waitFor(() => expect(latestFakeWorkflow?.setInput).toHaveBeenCalled());
    await vi.waitFor(() => expect(rendered.container.textContent).toContain("The cheat database is unavailable"));
    await vi.waitFor(async () => {
      const commits = onRender.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(onRender).toHaveBeenCalledTimes(commits);
    });

    const commitsAfterStaging = onRender.mock.calls.length;
    await act(async () => latestFakeWorkflow?.__setBusy(true));
    expect(onRender).toHaveBeenCalledTimes(commitsAfterStaging);

    await act(async () => latestFakeWorkflow?.__emitProgress());
    expect(onRender).toHaveBeenCalledTimes(commitsAfterStaging);
  });

  it("surfaces an apply error from the fake workflow's run()", async () => {
    const { container } = renderForm();
    const fileInput = container.querySelector("#rom-weaver-input-file-unified") as HTMLInputElement;
    const romFile = new File(["rom-bytes"], "game.bin", { type: "application/octet-stream" });

    await act(async () => {
      Object.defineProperty(fileInput, "files", { configurable: true, value: [romFile] });
      fireEvent.change(fileInput);
    });

    await vi.waitFor(() => expect(latestFakeWorkflow?.setInput).toHaveBeenCalled());
    await vi.waitFor(() => expect(container.querySelector("#rom-weaver-button-apply")).toBeTruthy());

    latestFakeWorkflow?.__setRunError(new Error("apply failed for the test"));
    const applyButton = container.querySelector("#rom-weaver-button-apply") as HTMLButtonElement;

    await vi.waitFor(() => expect(applyButton.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(applyButton);
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain("apply failed for the test");
    });
  });

  it("refreshes automatic output names after patch metadata edits and preserves a manual name", async () => {
    const { container } = renderForm();
    const getControl = (selector: string) => {
      const element = container.querySelector(selector);
      if (!element) throw new Error(`Missing control: ${selector}`);
      return element;
    };
    const fileInput = container.querySelector("#rom-weaver-input-file-unified") as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(fileInput, "files", {
        configurable: true,
        value: [new File(["rom-bytes"], "game.bin"), new File(["patch-bytes"], "change.ips")],
      });
      fireEvent.change(fileInput);
    });
    const outputName = () => container.querySelector<HTMLTextAreaElement>("#rom-weaver-input-output-file-name")?.value;
    await vi.waitFor(() => expect(outputName()).toBe("game-patched.zip"));
    fireEvent.click(getControl("#rom-weaver-patch-menu-0"));
    fireEvent.click(getControl("#rom-weaver-patch-meta-edit-0"));

    for (const [field, value, expected] of [
      ["name", "Reviewed Name", "game [Reviewed Name]"],
      ["author", "Reviewer", "game [Reviewed Name Reviewer]"],
      ["version", "2.0", "game [Reviewed Name Reviewer 2.0]"],
    ]) {
      fireEvent.blur(getControl(`#rom-weaver-patch-${field}-0`), { target: { value } });
      await vi.waitFor(() => expect(outputName()).toBe(expected));
    }

    fireEvent.change(getControl("#rom-weaver-input-output-file-name"), {
      target: { value: "manual-output" },
    });
    fireEvent.blur(getControl("#rom-weaver-input-output-file-name"));
    fireEvent.blur(getControl("#rom-weaver-patch-name-0"), { target: { value: "Another Name" } });
    await vi.waitFor(() => expect(outputName()).toBe("manual-output"));
  });

  it("stages a ROM and patch together, applies them, and exposes output controls", async () => {
    const onApplyComplete = vi.fn();
    const { container } = renderForm({ onApplyComplete });
    const fileInput = container.querySelector("#rom-weaver-input-file-unified") as HTMLInputElement;
    const romFile = new File(["rom-bytes"], "game.bin", { type: "application/octet-stream" });
    const patchFile = new File(["patch-bytes"], "change.ips", { type: "application/octet-stream" });

    await act(async () => {
      Object.defineProperty(fileInput, "files", { configurable: true, value: [romFile, patchFile] });
      fireEvent.change(fileInput);
    });
    await vi.waitFor(() => expect(latestFakeWorkflow?.setInput).toHaveBeenCalled());
    await vi.waitFor(() => expect(latestFakeWorkflow?.addPatch).toHaveBeenCalled());
    await vi.waitFor(() => expect(container.querySelector("#rom-weaver-button-apply")).toBeTruthy());

    const outputName = container.querySelector("#rom-weaver-input-output-file-name") as HTMLInputElement;
    fireEvent.change(outputName, { target: { value: "custom-output" } });
    fireEvent.blur(outputName);
    expect(outputName.value).toBe("custom-output");

    const applyButton = container.querySelector("#rom-weaver-button-apply") as HTMLButtonElement;
    await vi.waitFor(() => expect(applyButton.disabled).toBe(false));
    await act(async () => fireEvent.click(applyButton));
    await vi.waitFor(() => expect(latestFakeWorkflow?.run).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(onApplyComplete).toHaveBeenCalledOnce());
    expect(latestFakeWorkflow?.setOutputName).toHaveBeenCalledWith("custom-output");
    expect(container.textContent).toContain("Download Patched");
    expect(container.textContent).toContain("custom-output.bin");
  });

  it("replaces a staged patch and clears the staged input through card actions", async () => {
    const { container } = renderForm();
    const fileInput = container.querySelector("#rom-weaver-input-file-unified") as HTMLInputElement;
    const romFile = new File(["rom-bytes"], "game.bin", { type: "application/octet-stream" });
    const patchFile = new File(["patch-bytes"], "change.ips", { type: "application/octet-stream" });

    await act(async () => {
      Object.defineProperty(fileInput, "files", { configurable: true, value: [romFile, patchFile] });
      fireEvent.change(fileInput);
    });
    await vi.waitFor(() => expect(latestFakeWorkflow?.addPatch).toHaveBeenCalled());
    await vi.waitFor(() => expect(container.querySelector("#rom-weaver-patch-menu-0")).toBeTruthy());

    fireEvent.click(container.querySelector("#rom-weaver-patch-menu-0") as HTMLButtonElement);
    fireEvent.click(container.querySelector("#rom-weaver-patch-replace-0") as HTMLButtonElement);
    const replacement = new File(["replacement"], "replacement.ips", { type: "application/octet-stream" });
    const replacementInput = container.querySelector("#rom-weaver-patch-replace-input-0") as HTMLInputElement;
    fireEvent.change(replacementInput, { target: { files: [replacement] } });
    expect(replacementInput.value).toBe("");

    const clear = container.querySelector('#rom-weaver-list-input-stack button.rm[title="Clear ROM input"]');
    expect(clear).toBeTruthy();
    fireEvent.click(clear as HTMLButtonElement);
    await vi.waitFor(() => expect(latestFakeWorkflow?.clearInput).toHaveBeenCalled());
  });

  it("downloads a completed Apply output again and reports the failure", async () => {
    const file = new File(["rom-bytes"], "game.bin", { type: "application/octet-stream" });
    const { container } = renderForm();
    const fileInput = container.querySelector("#rom-weaver-input-file-unified") as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
      fireEvent.change(fileInput);
    });
    await vi.waitFor(() => expect(container.querySelector("#rom-weaver-button-apply")).toBeTruthy());
    const applyButton = container.querySelector("#rom-weaver-button-apply") as HTMLButtonElement;
    await vi.waitFor(() => expect(applyButton.disabled).toBe(false));
    await act(async () => fireEvent.click(applyButton));
    await vi.waitFor(() => expect(latestFakeWorkflow?.run).toHaveBeenCalled());
    // The run replaces the primary action with the progress panel, which carries
    // the progress id and not the button id, so the button is only queryable
    // again once the output has landed.
    await vi.waitFor(() => expect(container.textContent).toContain("Download Patched"));

    latestFakeWorkflow?.__setSaveError(new Error("download failed"));
    const download = container.querySelector("#rom-weaver-button-apply") as HTMLButtonElement;
    await act(async () => fireEvent.click(download));
    await vi.waitFor(() => expect(container.textContent).toContain("download failed"));
  });
});
