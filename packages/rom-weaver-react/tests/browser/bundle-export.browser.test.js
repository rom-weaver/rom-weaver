import { createElement } from "react";
import { expect, test, vi } from "vitest";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import {
  installPatcherTestHooks,
  loadFixtureFile,
  mount,
  RAW_PATCH,
  RAW_ROM,
  setFormControlValue,
  waitForApplyButtonEnabled,
  waitForState,
} from "./patcher-test-shared.js";

installPatcherTestHooks();

// Pack files into a zip through the real compression runtime (what a patch
// distributor would publish).
const buildZip = async (entries, outputName) => {
  const create = browserRuntime.compression.create;
  if (!create) throw new Error("Runtime compression create capability is unavailable");
  const result = await create({
    entries,
    format: "zip",
    options: { outputName, workerThreads: 1 },
  });
  const output = result?.output;
  if (!output) throw new Error("Zip compression did not return output");
  try {
    const blob = await browserRuntime.publicOutput.getBlob(output);
    return new File([blob], outputName, { type: "application/zip" });
  } finally {
    await output.dispose().catch(() => undefined);
  }
};

test("export bundle bundles the session from main-page options with a checks-only rom entry", async () => {
  const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
  let exported = null;
  const saveAs = vi.spyOn(browserRuntime.publicOutput, "saveAs");
  mount(
    createElement(ApplyPatchForm, {
      onBundleExportComplete: (result) => {
        exported = result;
      },
      pageDrop: { files: [romFile, patchFile], id: 1 },
    }),
  );
  await waitForApplyButtonEnabled();

  // Bundle creation stays opt-in even after a ROM and patch are staged.
  expect(document.getElementById("rom-weaver-button-export-bundle")).toBeNull();
  const formatSelect = document.getElementById("rom-weaver-bundle-export-format");
  expect(formatSelect).not.toBeNull();
  expect(formatSelect.value).toBe("");
  expect(Array.from(formatSelect.options, (option) => option.textContent)).toEqual([
    "Hide bundle creation",
    "Bundle + patches (.zip)",
    "Bundle + ROM + patches (.zip)",
    "Bundle + patches (.7z)",
    "Bundle + ROM + patches (.7z)",
  ]);
  setFormControlValue(formatSelect, "zip:patches");
  formatSelect.dispatchEvent(new Event("change", { bubbles: true }));

  // Selecting a bundle reveals and arms the secondary action.
  const exportButton = await waitForState(() => {
    const button = document.getElementById("rom-weaver-button-export-bundle");
    return button instanceof HTMLButtonElement && !button.disabled ? button : null;
  });
  expect(exportButton).not.toBeNull();
  const nameInput = document.getElementById("rom-weaver-input-output-file-name");
  expect(nameInput).not.toBeNull();
  setFormControlValue(nameInput, "Exported Hack");

  document.querySelector("#rom-weaver-list-patch-stack .optsblock .cks-head")?.click();
  const patchNameInput = await waitForState(() => document.getElementById("rom-weaver-patch-name-0"));
  expect(patchNameInput).not.toBeNull();
  setFormControlValue(patchNameInput, "Core change");
  patchNameInput.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  const descriptionInput = document.getElementById("rom-weaver-patch-description-0");
  expect(descriptionInput).not.toBeNull();
  setFormControlValue(descriptionInput, "Adds the change");
  descriptionInput.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  await expect
    .poll(() => document.getElementById("rom-weaver-patch-card-description-0")?.textContent)
    .toBe("Adds the change");
  const checksInput = document.getElementById("rom-weaver-patch-input-crc32-0");
  expect(checksInput).not.toBeNull();
  setFormControlValue(checksInput, "deadbeef");
  checksInput.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  await expect.poll(() => document.getElementById("rom-weaver-patch-input-crc32-0")?.value).toBe("deadbeef");

  // The selected output is a .zip bundle with the ROM left out.
  expect(formatSelect.value).toBe("zip:patches");
  expect(document.getElementById("rom-weaver-bundle-export-bundle-rom")).toBeNull();

  exportButton.click();

  // The runtime create call resolves with the canonical bundle - assert on it directly rather
  // than intercepting the browser download.
  const result = await waitForState(() => exported, 60000);
  expect(result).not.toBeNull();
  expect(result.bundle.version).toBe(1);
  // Bundles carry no display name; the export name feeds output naming only.
  expect(result.bundle.name).toBeUndefined();
  expect(result.bundle.output?.name).toBe("Exported Hack");
  expect(result.bundlePath.endsWith("rom-weaver-bundle.json")).toBe(true);
  // The bundle download is named from the export name.
  expect(result.archivePath?.endsWith("Exported-Hack.zip")).toBe(true);
  // The ROM stays out of the bundle: its entry carries checks but no source.
  expect(result.bundle.rom?.path ?? null).toBeNull();
  expect(result.bundle.rom?.url ?? null).toBeNull();
  expect(Object.keys(result.bundle.rom?.checks?.checksums || {}).length).toBeGreaterThan(0);
  expect(result.bundle.patches).toHaveLength(1);
  const patchEntry = result.bundle.patches[0];
  expect(patchEntry.path).toBe("change.ips");
  expect(patchEntry.optional).toBeUndefined();
  expect(patchEntry.name).toBe("Core change");
  expect(patchEntry.description).toBe("Adds the change");
  // The hand-typed crc32 differs from the rom checks, so the entry keeps its
  // own inputChecks instead of relying on rom.checks.
  expect(patchEntry.inputChecks?.checksums?.crc32).toBe("deadbeef");
  // Export does not invent a final output check; only explicit/user-entered
  // checks are retained.
  expect(patchEntry.outputChecks).toBeUndefined();
  expect(result.bundle.output?.checks).toBeUndefined();
  // Patch entries carry no file hashes - the format has no integrity field.
  expect(patchEntry.integrity).toBeUndefined();

  const downloadButton = document.getElementById("rom-weaver-button-export-bundle");
  expect(downloadButton?.textContent).toContain("Download");
  downloadButton?.click();
  await expect.poll(() => saveAs.mock.calls.length).toBe(2);
  saveAs.mockRestore();
});

test("export bundles the extracted patch leaf, not the archive it arrived in", async () => {
  const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
  const patchZip = await buildZip([{ file: patchFile, fileName: "change.ips" }], "patch-pack.zip");
  let exported = null;
  mount(
    createElement(ApplyPatchForm, {
      defaultSettings: { bundlePackage: "zip:rom" },
      onBundleExportComplete: (result) => {
        exported = result;
      },
      pageDrop: { files: [romFile, patchZip], id: 1 },
    }),
  );
  await waitForApplyButtonEnabled();

  const formatSelect = document.getElementById("rom-weaver-bundle-export-format");
  expect(formatSelect?.value).toBe("zip:rom");
  const exportButton = await waitForState(() => {
    const button = document.getElementById("rom-weaver-button-export-bundle");
    return button instanceof HTMLButtonElement && !button.disabled ? button : null;
  });
  exportButton.click();
  const result = await waitForState(() => exported, 60000);
  expect(result).not.toBeNull();
  // The bundle references (and the bundle carries) the .ips leaf.
  expect(result.bundle.patches).toHaveLength(1);
  expect(result.bundle.patches[0].path).toBe("change.ips");
  expect(result.bundle.rom?.path).toBe(RAW_ROM.split("/").pop());
  await expect.poll(() => exportButton.disabled).toBe(false);
});
