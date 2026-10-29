// @vitest-environment happy-dom
import { act, fireEvent, render } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as weaveApplySession from "../../src/public/react/use-weave-apply-session.ts";

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
    getWeaveExportSources: vi.fn(() => ({ patches: [], rom: null })),
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
    validatePatches: vi.fn(async () => {
      await validationBarrier;
    }),
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
let validationBarrier: Promise<void> | null = null;
let latestWorkflowOptions: { retainUncompressedOutput?: (request: unknown) => Promise<void> } | null = null;
const bootCleanup = vi.hoisted(() => ({ wait: vi.fn<() => Promise<void>>() }));
vi.mock("../../src/storage/browser/browser-opfs-cleanup.ts", () => ({
  waitForBrowserOpfsBootCleanup: bootCleanup.wait,
}));

vi.mock("../../src/platform/browser/browser-api.ts", () => ({
  ApplyWorkflow: class {
    constructor(options?: typeof latestWorkflowOptions) {
      latestWorkflowOptions = options ?? null;
      latestFakeWorkflow = createFakeApplyWorkflow();
      // Instances of this fake class delegate every call to the shared fake
      // workflow object so test code can drive it via `latestFakeWorkflow`.
      Object.assign(this, latestFakeWorkflow);
    }
  },
}));

const { ApplyPatchForm } = await import("../../src/public/react/apply-patch-form.tsx");
const { RomWeaverSettingsProvider, toApplyWorkflowSettings, useApplySettings } =
  await import("../../src/public/react/settings-context.tsx");

const renderForm = (props: Parameters<typeof ApplyPatchForm>[0] = {}) =>
  render(
    <RomWeaverSettingsProvider settings={{}}>
      <ApplyPatchForm {...props} />
    </RomWeaverSettingsProvider>,
  );

describe("legacy package settings normalization", () => {
  const normalize = (settings: unknown) =>
    toApplyWorkflowSettings(settings as Parameters<typeof toApplyWorkflowSettings>[0]);
  it.each([{ bundlePackage: "rom" }, { output: { bundlePackage: "rom" } }])(
    "normalizes legacy settings %j",
    (settings) => {
      const normalized = normalize(settings);
      expect(normalized.output?.weavePackage).toBe("rom");
      expect(normalized).not.toHaveProperty("bundlePackage");
      expect(normalized.output).not.toHaveProperty("bundlePackage");
      expect(JSON.stringify(settings)).toContain("bundlePackage");
    },
  );
  it.each([
    { weavePackage: "patches", bundlePackage: "rom" },
    { output: { weavePackage: "patches", bundlePackage: "rom" } },
    { weavePackage: "patches", output: { bundlePackage: "rom" } },
  ])("prefers canonical settings %j", (settings) => {
    expect(normalize(settings).output?.weavePackage).toBe("patches");
  });
  it("normalizes legacy provider settings", () => {
    const Choice = () => <output>{useApplySettings().output?.weavePackage}</output>;
    const { container } = render(
      <RomWeaverSettingsProvider
        settings={{ bundlePackage: "rom" } as unknown as Parameters<typeof RomWeaverSettingsProvider>[0]["settings"]}
      >
        <Choice />
      </RomWeaverSettingsProvider>,
    );
    expect(container.querySelector("output")?.textContent).toBe("rom");
  });
});

describe("ApplyPatchForm - empty mount", () => {
  it("changes the entry heading and guide without loading a sample or replacing staged inputs", async () => {
    const { container, rerender } = renderForm({ cheatsPage: true });
    expect(container.querySelector("h1")?.textContent).toBe("Apply cheat codes to ROMs");
    expect(container.querySelector(".hero-guide")?.getAttribute("href")).toContain("docs/use-cheats");
    expect(container.querySelector("#rom-weaver-list-input-stack .card.file")).toBeNull();
    const input = container.querySelector("#rom-weaver-input-file-unified") as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: [new File(["rom-bytes"], "game.bin")] });
      fireEvent.change(input);
    });
    await vi.waitFor(() => expect(latestFakeWorkflow?.setInput).toHaveBeenCalledTimes(1));
    const workflow = latestFakeWorkflow;
    rerender(
      <RomWeaverSettingsProvider settings={{}}>
        <ApplyPatchForm cheatsPage={false} />
      </RomWeaverSettingsProvider>,
    );
    expect(latestFakeWorkflow).toBe(workflow);
    expect(workflow?.setInput).toHaveBeenCalledTimes(1);
    expect(container.querySelector("#rom-weaver-list-input-stack .card.file")).toBeTruthy();
  });

  it("gives the Create cheat entry its heading, description and guide", () => {
    const { container } = renderForm({ cheatsPage: true, mode: "create" });
    expect(container.querySelector("h1")?.textContent).toBe("Create ROM patches from cheat codes");
    expect(container.textContent).toContain(
      "Turn supported cheat codes into a patch for your ROM. Files stay on your device.",
    );
    expect(container.querySelector(".hero-guide")?.getAttribute("href")).toContain("docs/use-cheats");
  });

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

  it.each(["weave", "bundle"] as const)("uses legacy defaults for the rendered %s ROM choice", async (mode) => {
    const { container } = renderForm({
      mode,
      defaultSettings: { output: { bundlePackage: "rom" } } as unknown as Parameters<
        typeof ApplyPatchForm
      >[0]["defaultSettings"],
    });
    const fileInput = container.querySelector("#rom-weaver-input-file-unified-weave") as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(fileInput, "files", { configurable: true, value: [new File(["rom-bytes"], "game.bin")] });
      fireEvent.change(fileInput);
    });
    await vi.waitFor(() => {
      const choice = container.querySelector<HTMLInputElement>("#rom-weaver-weave-export-weave-rom");
      expect(choice).not.toBeNull();
      expect(choice?.checked).toBe(true);
    });
  });

  it.each(["apply", "create"] as const)("opts into sidecar appending only for %s mode", async (mode) => {
    const rom = new File(["rom"], "game.nes");
    renderForm({ mode, defaultInputs: [rom], defaultPatches: [new File(["patch"], "existing.ips")] });

    await vi.waitFor(() =>
      expect(latestFakeWorkflow?.setInput).toHaveBeenCalledWith(
        [rom],
        expect.objectContaining({ appendSidecarPatches: mode === "create" }),
      ),
    );
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

  it("keeps cancellation connected until the running workflow settles", async () => {
    const onApplyComplete = vi.fn();
    const { container, getByRole } = renderForm({
      defaultInputs: [new File(["rom"], "game.bin")],
      defaultPatches: [new File(["patch"], "change.ips")],
      onApplyComplete,
    });
    await vi.waitFor(() => expect(latestFakeWorkflow?.addPatch).toHaveBeenCalled());
    const workflow = latestFakeWorkflow;
    if (!workflow) throw new Error("Expected a staged apply workflow");
    let rejectRun: (reason: unknown) => void = () => undefined;
    workflow.run.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectRun = reject;
        }),
    );
    workflow.abort.mockImplementation(() => rejectRun(new DOMException("Cancelled", "AbortError")));
    const applyButton = container.querySelector("#rom-weaver-button-apply") as HTMLButtonElement;
    await vi.waitFor(() => expect(applyButton.disabled).toBe(false));
    await act(async () => fireEvent.click(applyButton));
    await vi.waitFor(() => expect(workflow.run).toHaveBeenCalledOnce());

    try {
      await act(async () => fireEvent.click(getByRole("button", { name: /cancel/i })));
      expect(workflow.abort).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(applyButton.disabled).toBe(false));
      expect(onApplyComplete).not.toHaveBeenCalled();
    } finally {
      await act(async () => rejectRun(new DOMException("Cancelled", "AbortError")));
    }
  });

  it("defers shared input staging while aggregate Create is inactive", async () => {
    const initial = new File(["rom"], "game.bin");
    const archive = new File(["archive"], "multiple-roms.zip");
    const patch = new File(["patch"], "change.ips");
    const view = (active: boolean, rom: File) => (
      <RomWeaverSettingsProvider settings={{}}>
        <ApplyPatchForm mode="create" active={active} inputs={[rom]} patches={[patch]} />
      </RomWeaverSettingsProvider>
    );
    const { rerender } = render(view(true, initial));
    await vi.waitFor(() => expect(latestFakeWorkflow?.setInput).toHaveBeenCalledOnce());
    const workflow = latestFakeWorkflow;
    if (!workflow) throw new Error("Expected a staged apply workflow");
    await act(async () => {
      rerender(view(false, archive));
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 150)));

    expect(latestFakeWorkflow).toBe(workflow);
    expect(workflow.setInput).toHaveBeenCalledOnce();
    await act(async () => rerender(view(true, archive)));
    await vi.waitFor(() => expect(workflow.setInput).toHaveBeenLastCalledWith([archive], expect.anything()));
    expect(workflow.setInput).toHaveBeenCalledTimes(2);
  });

  it("stages one ROM as the aggregate Create original without asking when none is loaded", async () => {
    const onCreateRomDrop = vi.fn();
    const onInputsChange = vi.fn();
    const { container, queryByRole } = renderForm({ mode: "create", inputs: [], onCreateRomDrop, onInputsChange });
    const rom = new File(["rom"], "game.bin");
    const fileInput = container.querySelector("#rom-weaver-input-file-unified-create") as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(fileInput, "files", { configurable: true, value: [rom] });
      fireEvent.change(fileInput);
    });
    await vi.waitFor(() => expect(onInputsChange).toHaveBeenCalledWith([rom]));
    expect(onCreateRomDrop).not.toHaveBeenCalled();
    expect(queryByRole("dialog")).toBeNull();
  });

  it.each([
    ["Replace the Original ROM", "original"],
    ["Use as the Modified ROM", "modified"],
  ] as const)("asks where one ROM goes over an aggregate Create original: %s", async (choice, slot) => {
    const onCreateRomDrop = vi.fn();
    const onInputsChange = vi.fn();
    const { container, findByRole } = renderForm({
      mode: "create",
      inputs: [new File(["rom"], "game.bin")],
      onCreateRomDrop,
      onInputsChange,
    });
    await vi.waitFor(() => expect(latestFakeWorkflow?.setInput).toHaveBeenCalled());
    onInputsChange.mockClear();
    const rom = new File(["other"], "other.bin");
    const fileInput = container.querySelector("#rom-weaver-input-file-unified-create") as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(fileInput, "files", { configurable: true, value: [rom] });
      fireEvent.change(fileInput);
    });
    const option = await findByRole("button", { name: new RegExp(choice) });
    expect(onCreateRomDrop).not.toHaveBeenCalled();
    expect(onInputsChange).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(option));
    if (slot === "modified") {
      expect(onCreateRomDrop).toHaveBeenCalledExactlyOnceWith([rom], true);
      expect(onInputsChange).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() => expect(onInputsChange).toHaveBeenCalledWith([rom]));
      expect(onCreateRomDrop).not.toHaveBeenCalled();
    }
  });

  it("cancels queued execution without aborting the reusable workflow", async () => {
    const onApplyComplete = vi.fn();
    const { container, getByRole } = renderForm({
      defaultInputs: [new File(["rom"], "game.bin")],
      defaultPatches: [new File(["patch"], "change.ips")],
      onApplyComplete,
    });
    await vi.waitFor(() => expect(latestFakeWorkflow?.addPatch).toHaveBeenCalled());
    const workflow = latestFakeWorkflow;
    if (!workflow) throw new Error("Expected a staged apply workflow");
    let finishOptions: () => void = () => undefined;
    workflow.setPatchOption.mockClear();
    workflow.setPatchOption.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishOptions = resolve;
        }),
    );
    const applyButton = container.querySelector("#rom-weaver-button-apply") as HTMLButtonElement;
    await vi.waitFor(() => expect(applyButton.disabled).toBe(false));
    await act(async () => fireEvent.click(applyButton));
    await vi.waitFor(() => expect(workflow.setPatchOption).toHaveBeenCalled());
    await act(async () => fireEvent.click(getByRole("button", { name: /cancel/i })));
    await act(async () => finishOptions());

    expect(workflow.abort).not.toHaveBeenCalled();
    expect(workflow.run).not.toHaveBeenCalled();
    expect(onApplyComplete).not.toHaveBeenCalled();
    const retryButton = () => getByRole("button", { name: /apply.*download/i }) as HTMLButtonElement;
    await vi.waitFor(() => expect(retryButton().disabled).toBe(false));
    await act(async () => fireEvent.click(retryButton()));
    await vi.waitFor(() => expect(onApplyComplete).toHaveBeenCalledOnce());
  });

  it("keeps combined creation disabled until patch validation settles", async () => {
    let finishValidation: () => void = () => undefined;
    validationBarrier = new Promise<void>((resolve) => {
      finishValidation = resolve;
    });
    try {
      const { getByRole } = renderForm({
        mode: "create",
        defaultInputs: [new File(["rom"], "game.bin")],
        defaultPatches: [new File(["patch"], "change.ips")],
      });
      await vi.waitFor(() => expect(latestFakeWorkflow?.validatePatches).toHaveBeenCalled());
      const createButton = getByRole("button", { name: /create patch.*download/i }) as HTMLButtonElement;
      expect(createButton.disabled).toBe(true);
      await act(async () => finishValidation());
      await vi.waitFor(() => expect(createButton.disabled).toBe(false));
    } finally {
      await act(async () => finishValidation());
      validationBarrier = null;
    }
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

  it("keeps Apply disabled until imported weave defaults settle, then uses the final output name", async () => {
    let pending = false;
    const useSession = weaveApplySession.useWeaveApplySession;
    const sessionSpy = vi.spyOn(weaveApplySession, "useWeaveApplySession").mockImplementation((options) => ({
      ...useSession(options),
      weaveDefaultsPending: pending,
    }));
    const form = () => (
      <RomWeaverSettingsProvider settings={{}}>
        <ApplyPatchForm />
      </RomWeaverSettingsProvider>
    );
    const rendered = render(form());
    try {
      const fileInput = rendered.container.querySelector("#rom-weaver-input-file-unified") as HTMLInputElement;
      await act(async () => {
        Object.defineProperty(fileInput, "files", {
          configurable: true,
          value: [
            new File(["rom-bytes"], "game.bin"),
            new File(["patch-bytes"], "change.ips"),
            new File(["patch-two"], "second.ips"),
          ],
        });
        fireEvent.change(fileInput);
      });
      await vi.waitFor(() => expect(latestFakeWorkflow?.addPatch).toHaveBeenCalled());
      const apply = () => rendered.container.querySelector("#rom-weaver-button-apply") as HTMLButtonElement;
      await vi.waitFor(() => expect(apply().disabled).toBe(false));
      pending = true;
      rendered.rerender(form());
      expect(apply().disabled).toBe(true);
      const handle = rendered.container.querySelector("#rom-weaver-list-patch-stack .handle") as HTMLButtonElement;
      expect(handle).not.toBeNull();
      expect(handle.disabled).toBe(false);
      fireEvent.click(apply());
      expect(latestFakeWorkflow?.run).not.toHaveBeenCalled();
      const outputName = rendered.container.querySelector("#rom-weaver-input-output-file-name") as HTMLInputElement;
      fireEvent.change(outputName, { target: { value: "weave-final-name" } });
      fireEvent.blur(outputName);
      pending = false;
      rendered.rerender(form());
      await vi.waitFor(() => expect(apply().disabled).toBe(false));
      expect(latestFakeWorkflow?.run).not.toHaveBeenCalled();
      await act(async () => fireEvent.click(apply()));
      await vi.waitFor(() => expect(latestFakeWorkflow?.run).toHaveBeenCalledOnce());
      expect(latestFakeWorkflow?.setOutputName).toHaveBeenCalledWith("weave-final-name");
    } finally {
      sessionSpy.mockRestore();
    }
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

    const clear = container.querySelector('#rom-weaver-list-input-stack button.rm[title="Remove ROM"]');
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

describe("ApplyPatchForm - emulator output retention", () => {
  it("still retains the output when the boot OPFS sweep failed", async () => {
    bootCleanup.wait.mockRejectedValue(new Error("quota exceeded"));
    renderForm({ defaultInputs: [new File(["rom"], "game.nes")] });
    await vi.waitFor(() => expect(latestWorkflowOptions?.retainUncompressedOutput).toBeTypeOf("function"));
    const retain = vi.fn(async () => ({ dispose: vi.fn(async () => undefined), size: 3 }));
    await latestWorkflowOptions?.retainUncompressedOutput?.({
      fileName: "game.nes",
      platform: "Nintendo Entertainment System",
      retain,
      size: 3,
    });
    expect(retain).toHaveBeenCalledTimes(1);
  });
});
