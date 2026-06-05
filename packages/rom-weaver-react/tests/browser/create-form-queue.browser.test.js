import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const workflowMockState = {
  instances: [],
  modifiedDeferred: null,
  modifiedSetCalls: 0,
  modifiedStateOverrides: {},
  originalDeferred: null,
  originalSetCalls: 0,
  originalStateOverrides: {},
  runCalls: 0,
};

let mountedRoot = null;

const createDeferred = () => {
  let resolve;
  const promise = new Promise((promiseResolve) => {
    resolve = promiseResolve;
  });
  return {
    promise,
    resolve: () => resolve(),
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

const importMockedCreatePatchForm = async () => {
  vi.resetModules();
  vi.doMock("../../src/platform/browser/browser-api.ts", async (importOriginal) => {
    const actual = await importOriginal();

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
        return new Promise(() => undefined);
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
    }

    return {
      ...actual,
      CreateWorkflow: MockCreateWorkflow,
      getCreatePatchFormatCandidates: vi.fn().mockResolvedValue({
        defaultFormat: "bps",
        formats: ["bps", "xdelta"],
      }),
    };
  });

  return import("../../src/public/react/create-patch-form.tsx");
};

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
  workflowMockState.runCalls = 0;
});

afterEach(() => {
  mountedRoot?.unmount?.();
  mountedRoot = null;
  vi.doUnmock("../../src/platform/browser/browser-api.ts");
});

test("create output edits stay enabled while queued and cancel the queued run", async () => {
  const { CreatePatchForm } = await importMockedCreatePatchForm();
  mount(
    createElement(CreatePatchForm, {
      defaultModified: new File([new Uint8Array([0, 1, 2, 4])], "modified.bin"),
      defaultOriginal: new File([new Uint8Array([0, 1, 2, 3])], "original.bin"),
    }),
  );

  await expect.poll(() => document.querySelectorAll(".fileprog").length).toBeGreaterThan(0);

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

test("replacing the modified ROM keeps the prepared original ROM", async () => {
  const { CreatePatchForm } = await importMockedCreatePatchForm();
  mount(
    createElement(CreatePatchForm, {
      defaultModified: new File([new Uint8Array([0, 1, 2, 4])], "modified.bin"),
      defaultOriginal: new File([new Uint8Array([0, 1, 2, 3])], "original.bin"),
    }),
  );

  await expect.poll(() => document.querySelectorAll(".fileprog").length).toBeGreaterThan(0);
  workflowMockState.originalDeferred.resolve();
  workflowMockState.modifiedDeferred.resolve();
  await expect.poll(() => document.body.textContent || "").toContain("original.bin");
  await expect.poll(() => document.body.textContent || "").toContain("modified.bin");
  await expect.poll(() => document.querySelectorAll(".fileprog").length).toBe(0);

  workflowMockState.modifiedDeferred = createDeferred();
  const modifiedInput = Array.from(document.querySelectorAll("input[type='file']")).find(
    (input) => input.getAttribute("aria-label") === "Replace modified ROM · drop or browse",
  );
  expect(modifiedInput).toBeInstanceOf(HTMLInputElement);
  selectFileInput(modifiedInput, new File([new Uint8Array([0, 1, 2, 5])], "modified-v2.bin"));

  await expect.poll(() => document.body.textContent || "").toContain("original.bin");
  expect(document.body.textContent || "").not.toContain("Waiting for other actions");
  await expect.poll(() => workflowMockState.originalSetCalls).toBe(1);
  await expect.poll(() => workflowMockState.modifiedSetCalls).toBe(2);

  workflowMockState.modifiedDeferred.resolve();
  await expect.poll(() => document.body.textContent || "").toContain("modified-v2.bin");
});

test("create queued run cancels when source preparation warns", async () => {
  const { CreatePatchForm } = await importMockedCreatePatchForm();
  mount(
    createElement(CreatePatchForm, {
      defaultModified: new File([new Uint8Array([0, 1, 2, 4])], "modified.bin"),
      defaultOriginal: new File([new Uint8Array([0, 1, 2, 3])], "original.bin"),
    }),
  );

  await expect.poll(() => document.querySelectorAll(".fileprog").length).toBeGreaterThan(0);
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
