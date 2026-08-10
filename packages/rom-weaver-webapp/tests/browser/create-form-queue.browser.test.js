import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CreatePatchForm } from "../../src/public/react/create-patch-form.tsx";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";

const workflowMockState = {
  instances: [],
  modifiedDeferred: null,
  modifiedSetCalls: 0,
  modifiedStateOverrides: {},
  originalDeferred: null,
  originalSetCalls: 0,
  originalStateOverrides: {},
  runCalls: 0,
  runDeferred: null,
};

let mountedRoot = null;
const originalFetch = globalThis.fetch;

const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return {
    promise,
    reject: (error) => reject(error),
    resolve: (value) => resolve(value),
  };
};

const getRoot = () => {
  const existing = document.getElementById("app");
  if (existing) return existing;
  const element = document.createElement("div");
  element.id = "app";
  document.body.appendChild(element);
  return element;
};

const mount = (element) => {
  mountedRoot?.unmount?.();
  mountedRoot = null;
  const root = createRoot(getRoot());
  root.render(element);
  mountedRoot = root;
  return root;
};

const setFormControlValue = (element, value) => {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
  descriptor?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
};

const selectFileInput = (input, file) => {
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  Object.defineProperty(input, "files", {
    configurable: true,
    value: dataTransfer.files,
  });
  input.dispatchEvent(new Event("change", { bubbles: true }));
};

const getOutputWaitingText = () => document.querySelector(".outcard > .fileprog")?.textContent || "";

class MockCreateWorkflow {
  constructor(options = {}) {
    this.id = options.id || "mock-create";
    this.listeners = new Map();
    this.modified = null;
    this.original = null;
    this.settings = options.settings || {};
    workflowMockState.instances.push(this);
  }

  abort() {
    this.aborted = true;
    const error = Object.assign(new Error("Workflow was cancelled"), { code: "CANCELLED" });
    this.runReject?.(error);
  }

  dispose() {
    return Promise.resolve();
  }

  emitProgress(label) {
    for (const handler of this.listeners.get("progress") || []) {
      handler({
        details: {
          role: "input",
          stage: "input",
        },
        hasProgress: true,
        label,
        message: label,
        percent: null,
        role: "input",
        stage: "input",
      });
    }
  }

  getModified() {
    return this.modified;
  }

  getOriginal() {
    return this.original;
  }

  off(event, handler) {
    this.listeners.get(event)?.delete(handler);
  }

  on(event, handler) {
    const handlers = this.listeners.get(event) || new Set();
    handlers.add(handler);
    this.listeners.set(event, handlers);
  }

  run() {
    workflowMockState.runCalls += 1;
    return new Promise((resolve, reject) => {
      this.runReject = reject;
      workflowMockState.runDeferred.promise.then(() => {
        resolve({
          output: {
            dispose: () => Promise.resolve(),
            fileName: this.outputName || "change.bps",
            saveAs: () => Promise.resolve(),
            size: 4,
          },
          sizeSummary: {
            createTimeMs: 1,
            outputSize: 4,
            rawSize: 4,
          },
        });
      });
    });
  }

  setModified(source) {
    workflowMockState.modifiedSetCalls += 1;
    this.emitProgress("Preparing modified ROM...");
    return workflowMockState.modifiedDeferred.promise.then(() => {
      this.modified = {
        fileName: source?.name || "modified.bin",
        selectedCandidateId: "modified",
        size: source?.size || 4,
        status: "ready",
        warnings: [],
        ...workflowMockState.modifiedStateOverrides,
      };
    });
  }

  setOriginal(source) {
    workflowMockState.originalSetCalls += 1;
    this.emitProgress("Preparing original ROM...");
    return workflowMockState.originalDeferred.promise.then(() => {
      this.original = {
        fileName: source?.name || "original.bin",
        selectedCandidateId: "original",
        size: source?.size || 4,
        status: "ready",
        warnings: [],
        ...workflowMockState.originalStateOverrides,
      };
    });
  }

  setOutputName(outputName) {
    this.outputName = outputName;
    return Promise.resolve();
  }

  setPatchType(patchType) {
    this.patchType = patchType;
    return Promise.resolve();
  }

  setSettings(settings) {
    this.settings = settings;
    return Promise.resolve();
  }

  swap() {
    const original = this.original;
    this.original = this.modified;
    this.modified = original;
    return Promise.resolve();
  }
}

const getMockCreatePatchFormatCandidates = async () => ({
  defaultFormat: "bps",
  formats: ["bps", "xdelta"],
});

const withCreateWorkflowMock = (props = {}) => ({
  createWorkflow: MockCreateWorkflow,
  getCreatePatchFormatCandidates: getMockCreatePatchFormatCandidates,
  ...props,
});

const queueCreate = async () => {
  const createButton = document.getElementById("patch-builder-button-create");
  expect(createButton).toBeInstanceOf(HTMLButtonElement);
  expect(createButton.disabled).toBe(false);
  createButton.click();
  await expect.poll(getOutputWaitingText).toContain("Waiting for other actions");
};

beforeEach(() => {
  mountedRoot?.unmount?.();
  mountedRoot = null;
  document.body.innerHTML = '<div id="app"></div>';
  workflowMockState.instances = [];
  workflowMockState.modifiedDeferred = createDeferred();
  workflowMockState.modifiedSetCalls = 0;
  workflowMockState.modifiedStateOverrides = {};
  workflowMockState.originalDeferred = createDeferred();
  workflowMockState.originalSetCalls = 0;
  workflowMockState.originalStateOverrides = {};
  workflowMockState.runDeferred = createDeferred();
  workflowMockState.runCalls = 0;
  window.history.replaceState(null, "", "/create");
});

afterEach(() => {
  mountedRoot?.unmount?.();
  mountedRoot = null;
  globalThis.fetch = originalFetch;
});

test("guided Create URL starts and loads the sample tutorial", async () => {
  window.history.replaceState(null, "", "/create?guide=create");
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return new Response(new Uint8Array([0, 1, 2, 3]));
  };

  mount(createElement(CreatePatchForm, withCreateWorkflowMock()));

  await expect
    .poll(() => document.querySelector(".sample-tutorial-dialog")?.textContent || "")
    .toContain("loading two tiny ROMs");
  await expect.poll(() => requested.length).toBe(2);
  expect(requested).toEqual(["/hello-world.nes", "/modified-world.nes"]);
});

test("Create explains that dropped patches belong in Apply", async () => {
  mount(
    createElement(
      CreatePatchForm,
      withCreateWorkflowMock({
        pageDrop: { files: [new File([], "hack.ips")], id: 1 },
      }),
    ),
  );

  await expect
    .poll(() => document.getElementById("patch-builder-input-notice")?.textContent || "")
    .toContain("Patches belong in Apply");
  expect(document.querySelector("#patch-builder-row-original .file")).toBeNull();
  expect(document.querySelector("#patch-builder-row-modified .file")).toBeNull();
});

test("Create preserves simultaneous drop order regardless of filename length", async () => {
  mount(
    createElement(
      CreatePatchForm,
      withCreateWorkflowMock({
        pageDrop: {
          files: [new File([], "original-with-a-long-name.bin"), new File([], "m.bin")],
          id: 1,
        },
      }),
    ),
  );

  await expect
    .poll(() => document.querySelector("#patch-builder-row-original .card")?.textContent || "")
    .toContain("original-with-a-long-name.bin");
  await expect
    .poll(() => document.querySelector("#patch-builder-row-modified .card")?.textContent || "")
    .toContain("m.bin");
});

test("Create asks before using duplicate ROMs", async () => {
  const duplicateOptions = { lastModified: 1700000000000 };
  mount(
    createElement(
      CreatePatchForm,
      withCreateWorkflowMock({
        pageDrop: {
          files: [new File([], "same.sfc", duplicateOptions), new File([], "same.sfc", duplicateOptions)],
          id: 1,
        },
      }),
    ),
  );

  await expect.poll(() => document.querySelector(".confirm-card")?.textContent || "").toContain("Use duplicate ROMs");
  expect(document.querySelector("#patch-builder-row-original .file")).toBeNull();
  expect(document.querySelector("#patch-builder-row-modified .file")).toBeNull();

  document.querySelector(".confirm-card button.btn.primary")?.click();
  await expect
    .poll(() => document.querySelector("#patch-builder-row-original .card")?.textContent || "")
    .toContain("same.sfc");
  await expect
    .poll(() => document.querySelector("#patch-builder-row-modified .card")?.textContent || "")
    .toContain("same.sfc");
});

test("Create asks before pairing a dropped duplicate with an existing ROM", async () => {
  const duplicateOptions = { lastModified: 1700000000000 };
  mount(
    createElement(
      RomWeaverSettingsProvider,
      { settings: { language: "es" } },
      createElement(
        CreatePatchForm,
        withCreateWorkflowMock({
          defaultOriginal: new File([], "same.sfc", duplicateOptions),
          pageDrop: {
            files: [new File([], "same.sfc", duplicateOptions)],
            id: 1,
          },
        }),
      ),
    ),
  );

  await expect.poll(() => document.querySelector(".confirm-card")?.textContent || "").toContain("Usar ROM duplicadas");
  expect(document.querySelector("#patch-builder-row-modified .file")).toBeNull();

  document.querySelector(".confirm-card button.btn.primary")?.click();
  await expect
    .poll(() => document.querySelector("#patch-builder-row-modified .card")?.textContent || "")
    .toContain("same.sfc");
});

test("create output edits stay enabled while queued and cancel the queued run", async () => {
  mount(
    createElement(
      CreatePatchForm,
      withCreateWorkflowMock({
        defaultModified: new File([new Uint8Array([0, 1, 2, 4])], "modified.bin"),
        defaultOriginal: new File([new Uint8Array([0, 1, 2, 3])], "original.bin"),
      }),
    ),
  );

  await expect.poll(() => document.querySelectorAll(".stage-status").length).toBeGreaterThan(0);

  const outputName = document.getElementById("patch-builder-output-file");
  const patchFormat = document.getElementById("patch-builder-select-patch-type");
  const outputCompression = document.getElementById("patch-builder-select-output-compression");
  expect(outputName).toBeInstanceOf(HTMLTextAreaElement);
  expect(patchFormat).toBeInstanceOf(HTMLSelectElement);
  expect(outputCompression).toBeInstanceOf(HTMLSelectElement);

  await queueCreate();
  expect(outputName.disabled).toBe(false);
  setFormControlValue(outputName, "changed-name");
  await expect.poll(getOutputWaitingText).toBe("");

  await queueCreate();
  expect(patchFormat.disabled).toBe(false);
  setFormControlValue(patchFormat, "ips");
  await expect.poll(getOutputWaitingText).toBe("");

  await queueCreate();
  expect(outputCompression.disabled).toBe(false);
  setFormControlValue(outputCompression, "7z");
  await expect.poll(getOutputWaitingText).toBe("");

  workflowMockState.originalDeferred.resolve();
  workflowMockState.modifiedDeferred.resolve();
  await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
  expect(workflowMockState.runCalls).toBe(0);
});

test("create queued output cancel button clears the queued run", async () => {
  mount(
    createElement(
      CreatePatchForm,
      withCreateWorkflowMock({
        defaultModified: new File([new Uint8Array([0, 1, 2, 4])], "modified.bin"),
        defaultOriginal: new File([new Uint8Array([0, 1, 2, 3])], "original.bin"),
      }),
    ),
  );

  await expect.poll(() => document.querySelectorAll(".stage-status").length).toBeGreaterThan(0);
  await queueCreate();

  const cancelButton = document.querySelector("button[aria-label='Cancel queued create']");
  expect(cancelButton).toBeInstanceOf(HTMLButtonElement);
  expect(cancelButton.textContent).toBe("");
  cancelButton.click();
  await expect.poll(getOutputWaitingText).toBe("");

  workflowMockState.originalDeferred.resolve();
  workflowMockState.modifiedDeferred.resolve();
  await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
  expect(workflowMockState.runCalls).toBe(0);
});

test("create active output cancel button aborts the workflow without an error notice", async () => {
  mount(
    createElement(
      CreatePatchForm,
      withCreateWorkflowMock({
        defaultModified: new File([new Uint8Array([0, 1, 2, 4])], "modified.bin"),
        defaultOriginal: new File([new Uint8Array([0, 1, 2, 3])], "original.bin"),
      }),
    ),
  );

  workflowMockState.originalDeferred.resolve();
  workflowMockState.modifiedDeferred.resolve();
  await expect.poll(() => workflowMockState.instances[0]?.getOriginal()?.status).toBe("ready");
  await expect.poll(() => workflowMockState.instances[0]?.getModified()?.status).toBe("ready");

  const createButton = document.getElementById("patch-builder-button-create");
  expect(createButton).toBeInstanceOf(HTMLButtonElement);
  createButton.click();
  await expect.poll(() => workflowMockState.runCalls).toBe(1);

  const cancelButton = document.querySelector("button[aria-label='Cancel patch creation']");
  expect(cancelButton).toBeInstanceOf(HTMLButtonElement);
  cancelButton.click();

  await expect.poll(() => workflowMockState.instances[0]?.aborted).toBe(true);
  await expect.poll(getOutputWaitingText).toBe("");
  expect(document.getElementById("patch-builder-output-error-message")).toBeNull();
});

test("an overflow ROM is reported without replacing the prepared sources", async () => {
  mount(
    createElement(
      CreatePatchForm,
      withCreateWorkflowMock({
        defaultModified: new File([new Uint8Array([0, 1, 2, 4])], "modified.bin"),
        defaultOriginal: new File([new Uint8Array([0, 1, 2, 3])], "original.bin"),
      }),
    ),
  );

  await expect.poll(() => document.querySelectorAll(".stage-status").length).toBeGreaterThan(0);
  workflowMockState.originalDeferred.resolve();
  workflowMockState.modifiedDeferred.resolve();
  await expect.poll(() => document.body.textContent || "").toContain("original.bin");
  await expect.poll(() => document.body.textContent || "").toContain("modified.bin");
  await expect.poll(() => document.querySelectorAll(".stage-status").length).toBe(0);

  workflowMockState.modifiedDeferred = createDeferred();
  // With both slots filled, a ROM dropped on the unified surface is unused. It
  // must not silently replace either prepared source.
  const unifiedInput = document.getElementById("patch-builder-input-file-unified");
  expect(unifiedInput).toBeInstanceOf(HTMLInputElement);
  selectFileInput(unifiedInput, new File([new Uint8Array([0, 1, 2, 5])], "modified-v2.bin"));

  await expect.poll(() => document.body.textContent || "").toContain("original.bin");
  await expect.poll(() => document.body.textContent || "").toContain("modified.bin");
  await expect.poll(() => document.body.textContent || "").toContain("Unused inputs: modified-v2.bin.");
  expect(document.getElementById("patch-builder-input-notice")?.classList.contains("error")).toBe(true);
  expect(workflowMockState.originalSetCalls).toBe(1);
  expect(workflowMockState.modifiedSetCalls).toBe(1);
});

test("swapping prepared sources reuses them without re-extraction", async () => {
  mount(
    createElement(
      CreatePatchForm,
      withCreateWorkflowMock({
        defaultModified: new File([new Uint8Array([0, 1, 2, 4])], "modified.bin"),
        defaultOriginal: new File([new Uint8Array([0, 1, 2, 3])], "original.bin"),
      }),
    ),
  );

  workflowMockState.originalDeferred.resolve();
  workflowMockState.modifiedDeferred.resolve();
  await expect.poll(() => workflowMockState.instances[0]?.getOriginal()?.status).toBe("ready");
  await expect.poll(() => workflowMockState.instances[0]?.getModified()?.status).toBe("ready");
  await expect.poll(() => document.body.textContent || "").toContain("original.bin");
  await expect.poll(() => document.body.textContent || "").toContain("modified.bin");
  expect(workflowMockState.originalSetCalls).toBe(1);
  expect(workflowMockState.modifiedSetCalls).toBe(1);

  const swapButton = document.getElementById("patch-builder-button-swap-sources");
  expect(swapButton).toBeInstanceOf(HTMLButtonElement);
  expect(swapButton.disabled).toBe(false);
  swapButton.click();

  // The swap is an in-place slot exchange; the staging effect must treat the
  // swapped keys as unchanged and NOT re-run setOriginal/setModified (which is
  // what re-extracts the sources). Give the effect time to (wrongly) re-run.
  await new Promise((resolve) => globalThis.setTimeout(resolve, 150));
  expect(document.body.textContent || "").toContain("modified.bin");
  expect(document.body.textContent || "").toContain("original.bin");
  expect(workflowMockState.originalSetCalls).toBe(1);
  expect(workflowMockState.modifiedSetCalls).toBe(1);
});

test("create output edits after completion reuse prepared sources", async () => {
  mount(
    createElement(
      CreatePatchForm,
      withCreateWorkflowMock({
        defaultModified: new File([new Uint8Array([0, 1, 2, 4])], "modified.bin"),
        defaultOriginal: new File([new Uint8Array([0, 1, 2, 3])], "original.bin"),
      }),
    ),
  );

  workflowMockState.originalDeferred.resolve();
  workflowMockState.modifiedDeferred.resolve();
  await expect.poll(() => document.body.textContent || "").toContain("original.bin");
  await expect.poll(() => document.body.textContent || "").toContain("modified.bin");
  await expect.poll(() => workflowMockState.originalSetCalls).toBe(1);
  await expect.poll(() => workflowMockState.modifiedSetCalls).toBe(1);

  const firstCreateButton = document.getElementById("patch-builder-button-create");
  expect(firstCreateButton).toBeInstanceOf(HTMLButtonElement);
  firstCreateButton.click();
  await expect.poll(() => workflowMockState.runCalls).toBe(1);
  workflowMockState.runDeferred.resolve();
  await expect
    .poll(() => document.getElementById("patch-builder-button-create")?.textContent.toUpperCase() || "")
    .toContain("DOWNLOAD");

  workflowMockState.runDeferred = createDeferred();
  const outputCompression = document.getElementById("patch-builder-select-output-compression");
  const patchFormat = document.getElementById("patch-builder-select-patch-type");
  expect(outputCompression).toBeInstanceOf(HTMLSelectElement);
  expect(patchFormat).toBeInstanceOf(HTMLSelectElement);
  setFormControlValue(outputCompression, "7z");
  setFormControlValue(patchFormat, "xdelta");
  await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
  expect(workflowMockState.originalSetCalls).toBe(1);
  expect(workflowMockState.modifiedSetCalls).toBe(1);

  const createButton = document.getElementById("patch-builder-button-create");
  expect(createButton).toBeInstanceOf(HTMLButtonElement);
  await expect.poll(() => createButton.textContent || "").toContain("CREATE");
  createButton.click();
  await expect.poll(() => workflowMockState.runCalls).toBe(2);
  expect(workflowMockState.originalSetCalls).toBe(1);
  expect(workflowMockState.modifiedSetCalls).toBe(1);
});

test("create queued run cancels when source preparation warns", async () => {
  mount(
    createElement(
      CreatePatchForm,
      withCreateWorkflowMock({
        defaultModified: new File([new Uint8Array([0, 1, 2, 4])], "modified.bin"),
        defaultOriginal: new File([new Uint8Array([0, 1, 2, 3])], "original.bin"),
      }),
    ),
  );

  await expect.poll(() => document.querySelectorAll(".stage-status").length).toBeGreaterThan(0);
  await queueCreate();
  workflowMockState.originalStateOverrides = {
    warnings: [{ code: "SOURCE_WARNING", message: "Source warning" }],
  };
  workflowMockState.originalDeferred.resolve();
  await expect
    .poll(() => document.getElementById("patch-builder-original-error-message")?.textContent || "")
    .toContain("Source warning");
  expect(document.querySelector("#patch-builder-original-error-message .notice-x")).toBeNull();
  expect(document.getElementById("patch-builder-row-error-message")).toBeNull();
  await expect.poll(getOutputWaitingText).toBe("");
  workflowMockState.modifiedDeferred.resolve();
  await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
  expect(workflowMockState.runCalls).toBe(0);
});
