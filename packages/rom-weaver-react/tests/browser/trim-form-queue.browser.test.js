import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const workflowMockState = {
  inputDeferred: null,
  inputStateOverrides: {},
  instances: [],
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

const importMockedTrimPatchForm = async () => {
  vi.resetModules();
  vi.doMock("../../src/platform/browser/browser-api.ts", async (importOriginal) => {
    const actual = await importOriginal();

    class MockTrimWorkflow {
      constructor(options = {}) {
        this.id = options.id || "mock-trim";
        this.input = null;
        this.listeners = new Map();
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

      getInput() {
        return this.input;
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

      setInput(source) {
        this.emitProgress("Preparing ROM...");
        return workflowMockState.inputDeferred.promise.then(() => {
          this.input = {
            fileName: source?.name || "game.bin",
            selectedCandidateId: "input",
            size: source?.size || 4,
            status: "ready",
            warnings: [],
            ...workflowMockState.inputStateOverrides,
          };
        });
      }

      setOutputFormat(outputFormat) {
        this.outputFormat = outputFormat;
        return Promise.resolve();
      }

      setOutputName(outputName) {
        this.outputName = outputName;
        return Promise.resolve();
      }
    }

    return {
      ...actual,
      TrimWorkflow: MockTrimWorkflow,
    };
  });

  return import("../../src/public/react/trim-form.tsx");
};

const getOutputWaitingText = () => document.querySelector(".outcard > .fileprog")?.textContent || "";

const confirmTrim = async () => {
  await expect.poll(() => document.querySelector(".confirm-card")?.textContent || "").toContain("Trim ROM");
  const confirmButton = Array.from(document.querySelectorAll(".confirm-card button")).find((button) =>
    button.textContent?.includes("Trim ROM"),
  );
  expect(confirmButton).toBeInstanceOf(HTMLButtonElement);
  confirmButton.click();
};

const queueTrim = async () => {
  const trimButton = document.getElementById("trim-builder-button-run");
  expect(trimButton).toBeInstanceOf(HTMLButtonElement);
  expect(trimButton.disabled).toBe(false);
  trimButton.click();
  await confirmTrim();
  await expect.poll(getOutputWaitingText).toContain("Waiting for other actions");
};

beforeEach(() => {
  mountedRoot?.unmount?.();
  mountedRoot = null;
  document.body.innerHTML = '<div id="app"></div>';
  workflowMockState.inputDeferred = createDeferred();
  workflowMockState.inputStateOverrides = {};
  workflowMockState.instances = [];
  workflowMockState.runCalls = 0;
});

afterEach(() => {
  mountedRoot?.unmount?.();
  mountedRoot = null;
  vi.doUnmock("../../src/platform/browser/browser-api.ts");
});

test("trim output edits stay enabled while queued and cancel the queued run", async () => {
  const { TrimPatchForm } = await importMockedTrimPatchForm();
  mount(createElement(TrimPatchForm, { defaultSource: new File([new Uint8Array([0, 1, 2, 3])], "game.bin") }));

  await expect.poll(() => document.querySelectorAll(".fileprog").length).toBeGreaterThan(0);

  const outputName = document.getElementById("trim-builder-output-file");
  const outputFormat = document.getElementById("trim-builder-select-output-format");
  const outputCompression = document.getElementById("trim-builder-select-output-compression");
  expect(outputName).toBeInstanceOf(HTMLTextAreaElement);
  expect(outputFormat).toBeInstanceOf(HTMLSelectElement);
  expect(outputCompression).toBeInstanceOf(HTMLSelectElement);

  await queueTrim();
  expect(outputName.disabled).toBe(false);
  setFormControlValue(outputName, "trimmed-name");
  await expect.poll(getOutputWaitingText).toBe("");

  await queueTrim();
  expect(outputFormat.disabled).toBe(false);
  setFormControlValue(outputFormat, "zip");
  await expect.poll(getOutputWaitingText).toBe("");

  await queueTrim();
  expect(outputCompression.disabled).toBe(false);
  setFormControlValue(outputCompression, "7z");
  await expect.poll(getOutputWaitingText).toBe("");

  workflowMockState.inputDeferred.resolve();
  await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
  expect(workflowMockState.runCalls).toBe(0);
});

test("trim queued run cancels when source preparation warns", async () => {
  const { TrimPatchForm } = await importMockedTrimPatchForm();
  mount(createElement(TrimPatchForm, { defaultSource: new File([new Uint8Array([0, 1, 2, 3])], "game.bin") }));

  await expect.poll(() => document.querySelectorAll(".fileprog").length).toBeGreaterThan(0);
  await queueTrim();
  workflowMockState.inputStateOverrides = {
    warnings: [{ code: "SOURCE_WARNING", message: "Source warning" }],
  };
  workflowMockState.inputDeferred.resolve();
  await expect.poll(getOutputWaitingText).toBe("");
  await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
  expect(workflowMockState.runCalls).toBe(0);
});

test("trim queued default format follows unambiguous special compression input", async () => {
  const { TrimPatchForm } = await importMockedTrimPatchForm();
  mount(
    createElement(TrimPatchForm, {
      defaultSettings: {
        defaultArchive: "zip",
      },
      defaultSource: new File([new Uint8Array([0, 1, 2, 3])], "game.gcm"),
    }),
  );

  await expect
    .poll(() => document.getElementById("trim-builder-select-output-format") instanceof HTMLSelectElement)
    .toBe(true);
  const outputFormat = document.getElementById("trim-builder-select-output-format");
  expect(outputFormat).toBeInstanceOf(HTMLSelectElement);
  await expect.poll(() => outputFormat.value).toBe("rvz");

  await queueTrim();
  workflowMockState.inputDeferred.resolve();
  await expect.poll(() => workflowMockState.runCalls).toBe(1);
  expect(workflowMockState.instances[0]?.outputFormat).toBe("rvz");
  expect(workflowMockState.instances[0]?.outputName).toMatch(/\.rvz$/);
});

test("trim queued default format does not guess for iso input", async () => {
  const { TrimPatchForm } = await importMockedTrimPatchForm();
  mount(
    createElement(TrimPatchForm, {
      defaultSettings: {
        defaultArchive: "zip",
      },
      defaultSource: new File([new Uint8Array([0, 1, 2, 3])], "game.iso"),
    }),
  );

  await expect
    .poll(() => document.getElementById("trim-builder-select-output-format") instanceof HTMLSelectElement)
    .toBe(true);
  const outputFormat = document.getElementById("trim-builder-select-output-format");
  expect(outputFormat).toBeInstanceOf(HTMLSelectElement);
  await expect.poll(() => outputFormat.value).toBe("zip");

  await queueTrim();
  workflowMockState.inputDeferred.resolve();
  await expect.poll(() => workflowMockState.runCalls).toBe(1);
  expect(workflowMockState.instances[0]?.outputFormat).toBe("zip");
});
