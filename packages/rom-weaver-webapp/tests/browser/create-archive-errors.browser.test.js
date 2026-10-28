import { createElement } from "react";
import { expect, test, vi } from "vitest";
import { CreateWorkflow } from "../../src/platform/browser/browser-api.ts";
import { CreatePatchForm } from "../../src/public/react/create-patch-form.tsx";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import {
  installPatcherTestHooks,
  loadFixtureFile,
  mount,
  selectFileInput,
  selectFileInputs,
  setFormControlValue,
} from "./patcher-test-shared.js";
import { commands } from "vitest/browser";

installPatcherTestHooks();

test.each(["original", "modified"])(
  "Create explains a damaged %s archive and recovers after replacement",
  async (role) => {
    mount(createElement(CreatePatchForm));
    await expect.poll(() => document.getElementById("patch-builder-input-file-unified")).not.toBeNull();
    const original = new File([new Uint8Array([1, 2, 3, 4])], "original.bin");
    const modified = new File([new Uint8Array([1, 2, 8, 4])], "modified.bin");
    const broken = new File(
      [new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode("not a zip archive")])],
      "broken.zip",
    );
    selectFileInputs(
      document.getElementById("patch-builder-input-file-unified"),
      role === "original" ? [broken, modified] : [original, broken],
    );
    const notice = () => document.getElementById(`patch-builder-${role}-error-message`);
    await expect
      .poll(() => notice()?.textContent || "")
      .toContain("This archive is damaged or unsupported. Choose another archive or extract it on your device first.");
    const details = notice().querySelector("details");
    expect(details.open).toBe(false);
    expect(details.textContent).toMatch(/Truncated ZIP file header|unknown libarchive failure/);
    details.querySelector("summary").click();
    expect(details.open).toBe(true);
    const run = vi.spyOn(CreateWorkflow.prototype, "run");
    try {
      document.getElementById("patch-builder-button-create").click();
      // Create reaches workflow.run() only after several awaits, so let them settle before asserting.
      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(run).not.toHaveBeenCalled();
      expect(notice().textContent).toContain("This archive is damaged or unsupported.");
    } finally {
      run.mockRestore();
    }
    document.querySelector(`button[aria-label="Clear ${role} ROM"]`).click();
    await expect.poll(() => document.querySelector(`button[aria-label="Clear ${role} ROM"]`)).toBeNull();
    const otherRole = role === "original" ? "modified" : "original";
    await expect.poll(() => document.querySelector(`#patch-builder-row-${otherRole} .card.ok`)).not.toBeNull();
    selectFileInput(
      document.getElementById("patch-builder-input-file-unified"),
      role === "original" ? original : modified,
    );
    await expect.poll(() => notice()).toBeNull();
    await expect.poll(() => document.querySelector(`#patch-builder-row-${role} .card.ok`)).not.toBeNull();
    await expect.poll(() => document.getElementById("patch-builder-button-create")?.disabled).toBe(false);
    setFormControlValue(document.getElementById("patch-builder-select-output-compression"), "none");
    await expect.poll(() => document.getElementById("patch-builder-select-output-compression")?.value).toBe("none");
    const download = await commands.clickAndReadDownload("#patch-builder-button-create");
    expect(atob(download.contentBase64).slice(0, 4)).toBe("BPS1");
  },
);

test.each(["none", "zip", "7z"])(
  "Create downloads %s output after showing accurate default help",
  async (compression) => {
    mount(
      createElement(
        RomWeaverSettingsProvider,
        { settings: { defaultCompression: "zip/special", detailedViewEnabled: true } },
        createElement(CreatePatchForm),
      ),
    );
    await expect.poll(() => document.getElementById("patch-builder-input-file-unified")).not.toBeNull();
    selectFileInputs(document.getElementById("patch-builder-input-file-unified"), [
      new File([new Uint8Array([1, 2, 3, 4])], "original.bin"),
      new File([new Uint8Array([1, 2, 8, 4])], "modified.bin"),
    ]);
    await expect.poll(() => document.getElementById("patch-builder-button-create")?.disabled).toBe(false);
    const selector = document.getElementById("patch-builder-select-output-compression");
    expect(selector.value).toBe("none");
    document.querySelector('button[aria-label="Output options"]').click();
    await expect
      .poll(() => document.body.textContent)
      .toContain(
        "Options → Type sets the download: None gives the raw patch file, and ZIP or 7z packages it in an archive. New settings start on None.",
      );
    document.querySelector('button[aria-label="Output options"]').click();
    if (compression !== "none") setFormControlValue(selector, compression);
    await expect.poll(() => selector.value).toBe(compression);
    const download = await commands.clickAndReadDownload("#patch-builder-button-create");
    const bytes = Uint8Array.from(atob(download.contentBase64), (character) => character.charCodeAt(0));
    const magic = {
      none: [0x42, 0x50, 0x53, 0x31],
      zip: [0x50, 0x4b, 0x03, 0x04],
      "7z": [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
    }[compression];
    expect([...bytes.subarray(0, magic.length)]).toEqual(magic);
    expect(download.suggestedFilename.endsWith(compression === "none" ? ".bps" : `.${compression}`)).toBe(true);
  },
);

test("Create rejects documentation-only archives with browser recovery advice", async () => {
  mount(createElement(CreatePatchForm));
  await expect.poll(() => document.getElementById("patch-builder-input-file-unified")).not.toBeNull();
  selectFileInput(
    document.getElementById("patch-builder-input-file-unified"),
    await loadFixtureFile("tests/fixtures/archives/readme-only.zip", "application/zip"),
  );
  const notice = () => document.getElementById("patch-builder-original-error-message");
  await expect.poll(() => notice()?.textContent || "", { timeout: 30000 }).not.toBe("");
  expect(notice()?.textContent).toContain("No usable ROM found");
  expect(notice()?.textContent).toContain("Choose an archive containing a ROM, or extract it and add the ROM file.");
  expect(notice()?.textContent).not.toMatch(/--no-ignore|--select|\/work\//);
  expect(document.getElementById("patch-builder-button-create")?.disabled).toBe(true);
});
