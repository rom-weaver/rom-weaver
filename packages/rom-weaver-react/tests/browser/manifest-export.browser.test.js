import { createElement } from "react";
import { expect, test } from "vitest";
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

test("export manifest bundles the session with per-patch metadata and a checks-only rom entry", async () => {
  const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
  let exported = null;
  mount(
    createElement(ApplyPatchForm, {
      onManifestExportComplete: (result) => {
        exported = result;
      },
      pageDrop: { files: [romFile, patchFile], id: 1 },
    }),
  );
  await waitForApplyButtonEnabled();

  // The output-card secondary action arms once a ROM and a patch are staged.
  const exportButton = await waitForState(() => {
    const button = document.getElementById("rom-weaver-button-export-manifest");
    return button instanceof HTMLButtonElement && !button.disabled ? button : null;
  });
  expect(exportButton).not.toBeNull();
  exportButton.click();

  // The manifest name auto-fills from the ROM file name (extension stripped).
  const nameInput = await waitForState(() => document.getElementById("rom-weaver-manifest-export-name"));
  expect(nameInput).not.toBeNull();
  expect(nameInput.value).toBe("game");
  setFormControlValue(nameInput, "Exported Hack");

  const statusSelect = document.getElementById("rom-weaver-manifest-export-status-0");
  expect(statusSelect).not.toBeNull();
  expect(statusSelect.value).toBe("default");
  setFormControlValue(statusSelect, "required");

  // Per-patch description and pre-apply ROM checksum requirement.
  const descriptionInput = document.getElementById("rom-weaver-manifest-export-desc-0");
  expect(descriptionInput).not.toBeNull();
  setFormControlValue(descriptionInput, "Adds the change");
  const checksInput = document.getElementById("rom-weaver-manifest-export-checks-0");
  expect(checksInput).not.toBeNull();
  setFormControlValue(checksInput, "crc32=deadbeef");

  // Default output is a .zip bundle with the ROM left out.
  const formatSelect = document.getElementById("rom-weaver-manifest-export-format");
  expect(formatSelect).not.toBeNull();
  expect(formatSelect.value).toBe("zip");
  const bundleRomToggle = document.getElementById("rom-weaver-manifest-export-bundle-rom");
  expect(bundleRomToggle).not.toBeNull();
  expect(bundleRomToggle.checked).toBe(false);

  const runButton = document.getElementById("rom-weaver-manifest-export-run");
  expect(runButton).not.toBeNull();
  runButton.click();

  // The runtime create call resolves with the canonical manifest — assert on it directly rather
  // than intercepting the browser download.
  const result = await waitForState(() => exported, 60000);
  expect(result).not.toBeNull();
  expect(result.manifest.version).toBe(1);
  expect(result.manifest.name).toBe("Exported Hack");
  expect(result.manifestPath.endsWith("rw.json")).toBe(true);
  // The bundle download is named from the manifest name.
  expect(result.bundlePath.endsWith("Exported-Hack.zip")).toBe(true);
  // The ROM stays out of the bundle: its entry carries checks but no source.
  expect(result.manifest.rom?.path ?? null).toBeNull();
  expect(result.manifest.rom?.url ?? null).toBeNull();
  expect(Object.keys(result.manifest.rom?.checks?.checksums || {}).length).toBeGreaterThan(0);
  expect(result.manifest.patches).toHaveLength(1);
  const patchEntry = result.manifest.patches[0];
  expect(patchEntry.path).toBe("change.ips");
  expect(patchEntry.status).toBe("required");
  expect(patchEntry.description).toBe("Adds the change");
  expect(patchEntry.checks?.checksums?.crc32).toBe("deadbeef");
  expect(Object.keys(patchEntry.integrity || {}).length).toBeGreaterThan(0);

  // The dialog closes after a successful export.
  await expect.poll(() => document.getElementById("rom-weaver-manifest-export-run")).toBeNull();
});

test("export bundles the extracted patch leaf, not the archive it arrived in", async () => {
  const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
  const patchZip = await buildZip([{ file: patchFile, fileName: "change.ips" }], "patch-pack.zip");
  let exported = null;
  mount(
    createElement(ApplyPatchForm, {
      onManifestExportComplete: (result) => {
        exported = result;
      },
      pageDrop: { files: [romFile, patchZip], id: 1 },
    }),
  );
  await waitForApplyButtonEnabled();

  const exportButton = await waitForState(() => {
    const button = document.getElementById("rom-weaver-button-export-manifest");
    return button instanceof HTMLButtonElement && !button.disabled ? button : null;
  });
  exportButton.click();
  await waitForState(() => document.getElementById("rom-weaver-manifest-export-run"));

  document.getElementById("rom-weaver-manifest-export-run").click();
  const result = await waitForState(() => exported, 60000);
  expect(result).not.toBeNull();
  // The manifest references (and the bundle carries) the .ips leaf.
  expect(result.manifest.patches).toHaveLength(1);
  expect(result.manifest.patches[0].path).toBe("change.ips");
  expect(Object.keys(result.manifest.patches[0].integrity || {}).length).toBeGreaterThan(0);
  await expect.poll(() => document.getElementById("rom-weaver-manifest-export-run")).toBeNull();
});
