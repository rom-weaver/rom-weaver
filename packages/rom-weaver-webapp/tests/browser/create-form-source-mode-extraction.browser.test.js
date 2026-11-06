import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CreatePatchForm } from "../../src/public/react/create-patch-form.tsx";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import {
  clickCandidateSelectionOption,
  getCandidateSelectionCloseButton,
  getCandidateSelectionList,
  loadFixtureFile,
  MULTI_ROM_ZIP,
} from "./patcher-test-shared.js";

let mountedRoot = null;

const createZipFile = async (entryName, bytes, outputName) => {
  const result = await browserRuntime.compression.create?.({
    entries: [{ data: bytes, fileName: entryName, filename: entryName }],
    format: "zip",
    options: { outputName, threads: 1 },
  });
  const output = result?.output;
  if (!output) throw new Error("Failed to create archive fixture");
  try {
    const blob = await browserRuntime.publicOutput.getBlob(output);
    return new File([blob], outputName, { type: "application/zip" });
  } finally {
    await output.cleanup?.().catch(() => undefined);
  }
};

const getVisibleSourceModeButton = (label) =>
  Array.from(document.querySelectorAll(".seg-btn")).find(
    (button) => button.textContent?.trim() === label && !button.closest("[hidden]"),
  );

const clickSourceMode = async (label, pressedLabel = label) => {
  await expect.poll(() => getVisibleSourceModeButton(label)).toBeInstanceOf(HTMLButtonElement);
  getVisibleSourceModeButton(label).click();
  await expect.poll(() => getVisibleSourceModeButton(pressedLabel)?.getAttribute("aria-pressed")).toBe("true");
};

const selectFileInput = (input, file) => {
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  Object.defineProperty(input, "files", { configurable: true, value: dataTransfer.files });
  input.dispatchEvent(new Event("change", { bubbles: true }));
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 3000));

beforeEach(() => {
  mountedRoot?.unmount?.();
  mountedRoot = null;
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, "", "/create-rom-patch");
});

afterEach(() => {
  mountedRoot?.unmount?.();
  mountedRoot = null;
});

test("Create extracts a zipped Original once across source mode switches", async () => {
  const logs = [];
  const logging = { level: "trace", sink: (record) => logs.push(record || {}) };
  const original = await createZipFile("original.bin", new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]), "original.zip");
  const countPreparations = () => logs.filter((entry) => entry?.message === "input.assets.prepare.start").length;

  mountedRoot = createRoot(document.getElementById("app"));
  mountedRoot.render(
    createElement(
      RomWeaverSettingsProvider,
      { settings: { logging } },
      createElement(CreatePatchForm, { defaultOriginal: original, settings: { logging } }),
    ),
  );

  await expect
    .poll(() => document.querySelector("#patch-builder-row-original .card")?.textContent || "", { timeout: 60_000 })
    .toContain("original.bin");
  await expect.poll(countPreparations).toBe(1);

  await clickSourceMode("Patches & cheats");
  await expect
    .poll(() => document.querySelector("#rom-weaver-list-input-stack")?.textContent || "", { timeout: 60_000 })
    .toContain("original.bin");
  await clickSourceMode("Modified ROM");
  await clickSourceMode("Patches & cheats");

  // Absence check: give a duplicate preparation time to start before asserting there is none.
  await settle();
  expect(countPreparations()).toBe(1);
});

test("Create extracts a zipped Original once when it is added in Patches & cheats first", async () => {
  const logs = [];
  const logging = { level: "trace", sink: (record) => logs.push(record || {}) };
  const original = await createZipFile("original.bin", new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]), "original.zip");
  const countPreparations = () => logs.filter((entry) => entry?.message === "input.assets.prepare.start").length;

  mountedRoot = createRoot(document.getElementById("app"));
  mountedRoot.render(
    createElement(
      RomWeaverSettingsProvider,
      { settings: { logging } },
      createElement(CreatePatchForm, { entry: "cheats", settings: { logging } }),
    ),
  );

  await expect.poll(() => getVisibleSourceModeButton("Patches & cheats")?.getAttribute("aria-pressed")).toBe("true");
  selectFileInput(document.getElementById("rom-weaver-input-file-unified-create"), original);
  await expect.poll(countPreparations, { timeout: 60_000 }).toBe(1);
  await expect
    .poll(() => document.querySelector("#rom-weaver-list-input-stack")?.textContent || "", { timeout: 60_000 })
    .toContain("original.bin");

  await clickSourceMode("Modified ROM");
  await expect
    .poll(() => document.querySelector("#patch-builder-row-original .card")?.textContent || "", { timeout: 60_000 })
    .toContain("original.bin");
  await settle();
  expect(countPreparations()).toBe(1);
});

test("Create asks for a new archive entry choice after a source mode switch", async () => {
  const original = await loadFixtureFile(MULTI_ROM_ZIP, "application/zip");

  mountedRoot = createRoot(document.getElementById("app"));
  mountedRoot.render(createElement(CreatePatchForm, { defaultOriginal: original }));

  await expect.poll(() => !!getCandidateSelectionList(), { timeout: 20_000, message: "first prompt" }).toBe(true);
  await clickCandidateSelectionOption("game.bin");
  await expect
    .poll(() => document.querySelector("#patch-builder-row-original .card")?.textContent || "", {
      message: "picked entry shown",
      timeout: 20_000,
    })
    .toContain("game.bin");
  expect(getCandidateSelectionList()).toBeNull();

  await clickSourceMode("Patches & cheats");
  await expect
    .poll(() => !!getCandidateSelectionList(), { message: "prompt after mode switch", timeout: 20_000 })
    .toBe(true);
  await clickCandidateSelectionOption("bonus.sfc");
  await expect
    .poll(() => document.querySelector("#rom-weaver-list-input-stack")?.textContent || "", { timeout: 20_000 })
    .toContain("bonus.sfc");
});

test("Create asks for a new archive entry choice when the Original is removed and added again", async () => {
  const original = await loadFixtureFile(MULTI_ROM_ZIP, "application/zip");

  mountedRoot = createRoot(document.getElementById("app"));
  mountedRoot.render(createElement(CreatePatchForm, { defaultOriginal: original }));

  await expect.poll(() => !!getCandidateSelectionList(), { message: "first prompt", timeout: 20_000 }).toBe(true);
  await clickCandidateSelectionOption("game.bin");
  await expect
    .poll(() => document.querySelector("#patch-builder-row-original .card")?.textContent || "", { timeout: 20_000 })
    .toContain("game.bin");

  const remove = document.querySelector(
    "#patch-builder-row-original button[title='Clear original ROM'], #patch-builder-row-original button[aria-label='Clear original ROM']",
  );
  if (!(remove instanceof HTMLButtonElement)) throw new Error("Missing remove Original button");
  remove.click();
  await expect
    .poll(() => document.querySelector("#patch-builder-row-original .card")?.textContent || "", { timeout: 20_000 })
    .not.toContain("game.bin");

  selectFileInput(document.getElementById("patch-builder-input-file-unified"), original);
  await expect
    .poll(() => !!getCandidateSelectionList(), { message: "prompt after re-adding", timeout: 20_000 })
    .toBe(true);
  getCandidateSelectionCloseButton()?.click();
});
