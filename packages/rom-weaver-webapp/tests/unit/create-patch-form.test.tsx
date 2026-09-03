// @vitest-environment happy-dom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import type { BinarySource } from "../../src/public/react/patcher-form.ts";

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
      modified =
        source instanceof File ? sourceState(source.name, "modified") : sourceState("modified.nes", "modified");
    }),
    setOriginal: vi.fn(async (source: BinarySource) => {
      original =
        source instanceof File ? sourceState(source.name, "original") : sourceState("original.nes", "original");
    }),
    setOutputName: vi.fn(async () => undefined),
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

class FakeCreateWorkflow {
  constructor() {
    latest = makeFakeWorkflow();
    Object.assign(this, latest.workflow);
  }
}

const renderForm = (props: Record<string, unknown> = {}) =>
  render(
    <RomWeaverSettingsProvider settings={{}}>
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
  window.history.replaceState(null, "", "/create");
  latest = null;
});

afterEach(() => {
  vi.restoreAllMocks();
  latest = null;
  createPatchFormModule = null;
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
    expect(chip).toBeTruthy();
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
});
