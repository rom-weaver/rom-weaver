// @vitest-environment happy-dom
import { act, fireEvent, render } from "@testing-library/react";
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
  let disposed = false;

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
      busy: false,
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
    replacePatchAt: vi.fn(async () => undefined),
    run: vi.fn(async () => {
      if (runError) throw runError;
      return {
        outputs: [
          {
            dispose: async () => undefined,
            fileName: "game-patched.bin",
            saveAs: async () => undefined,
            size: 128,
          },
        ],
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
  beforeEach(() => window.history.replaceState(null, "", "/apply"));
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
});

describe("ApplyPatchForm - staging a dropped ROM", () => {
  beforeEach(() => window.history.replaceState(null, "", "/apply"));
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

    await vi.waitFor(() => {
      expect(container.querySelector("section.step.is-input.is-empty")).toBeNull();
    });
    expect(container.querySelector("#rom-weaver-list-input-stack .card.file")).toBeTruthy();
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
});
