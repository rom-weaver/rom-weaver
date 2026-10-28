import { createElement } from "react";
import { expect, test } from "vitest";
import { commands } from "vitest/browser";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import {
  clickApplyButton,
  getInputStackRows,
  installPatcherTestHooks,
  mount,
  selectFileInput,
  setFormControlValue,
  waitForApplyButtonEnabled,
  waitForApplyOutcome,
} from "./patcher-test-shared.js";

installPatcherTestHooks();

const makePatch = async (format) => {
  const original = Uint8Array.from({ length: 1024 }, (_, index) => (index * 37 + 11) % 256);
  const modified = original.slice();
  modified[200] ^= 0xff;
  const rom = new File([original], "original.bin");
  const result = await browserRuntime.patch.createPatch({
    original: rom,
    modified: new File([modified], "modified.bin"),
    format,
    metadata: {},
    outputName: `change.${format}`,
    threads: 1,
  });
  try {
    const blob = await browserRuntime.publicOutput.getBlob(result.output);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { bytes, modified, original, rom };
  } finally {
    await result.output.dispose();
  }
};

for (const format of ["bps", "ups"]) {
  test(`${format.toUpperCase()} patch-file CRC damage advises patch replacement and keeps Apply blocked`, async () => {
    const { bytes, modified, rom } = await makePatch(format);
    const damaged = bytes.slice();
    damaged[damaged.length - 1] ^= 1;
    expect(damaged.slice(-12, -4)).toEqual(bytes.slice(-12, -4));
    mount(
      createElement(ApplyPatchForm, {
        defaultSettings: { output: { compression: "none" }, validation: { requireInputChecksumMatch: true } },
        pageDrop: { files: [rom, new File([damaged], `damaged.${format}`)], id: 1 },
        threads: 1,
      }),
    );
    const fault = () => document.querySelector("#rom-weaver-list-patch-stack .pfault");
    await expect.poll(() => fault()?.textContent, { timeout: 60000 }).toContain("Patch checksum invalid;");
    expect(fault().textContent).toContain("Obtain a fresh copy and replace this patch.");
    const row = document.querySelector("#rom-weaver-list-patch-stack .file.bad");
    expect(row.textContent).toContain("Patch file is damaged");
    expect(row.textContent).not.toContain("different ROM");
    expect(row.textContent).not.toContain("Choose the ROM");
    expect(fault().textContent).not.toContain("Apply anyway");
    const inputRow = getInputStackRows()[0];
    const button = document.getElementById("rom-weaver-button-apply");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    button.click();
    expect(button.textContent).not.toContain("Download");
    expect(fault()).not.toBeNull();

    document.getElementById("rom-weaver-patch-menu-0").click();
    document.getElementById("rom-weaver-patch-replace-0").click();
    selectFileInput(document.getElementById("rom-weaver-patch-replace-input-0"), new File([bytes], `valid.${format}`));
    await expect
      .poll(() => document.querySelector("#rom-weaver-list-patch-stack .file.ok"), { timeout: 60000 })
      .not.toBeNull();
    expect(getInputStackRows()[0]).toBe(inputRow);
    expect(fault()).toBeNull();
    await waitForApplyButtonEnabled();
    await clickApplyButton();
    expect((await waitForApplyOutcome()).kind).toBe("download");
    const download = await commands.clickAndReadDownload("#rom-weaver-button-apply");
    const output = Uint8Array.from(atob(download.contentBase64), (character) => character.charCodeAt(0));
    expect(output).toEqual(modified);
  });

  test(`${format.toUpperCase()} source-ROM mismatch keeps ROM guidance and its override`, async () => {
    const { bytes, original } = await makePatch(format);
    original[900] ^= 1;
    mount(
      createElement(ApplyPatchForm, {
        defaultSettings: { output: { compression: "none" }, validation: { requireInputChecksumMatch: true } },
        pageDrop: {
          files: [
            new File([original], "wrong.bin"),
            new File([new TextEncoder().encode("PATCHEOF")], "unchanged.ips"),
            new File([bytes], `valid.${format}`),
          ],
          id: 1,
        },
        threads: 1,
      }),
    );
    const row = () => document.querySelector("#rom-weaver-list-patch-stack .file.bad");
    await expect
      .poll(() => row()?.textContent, { timeout: 60000 })
      .toContain("Choose the ROM that this patch was made for");
    setFormControlValue(document.getElementById("rom-weaver-select-patch-target-1"), "rom");
    await expect.poll(() => row()?.textContent).toContain("expected a different ROM");
    expect(row().textContent).not.toContain("Patch file is damaged");
    expect(document.getElementById("rom-weaver-button-apply").getAttribute("aria-disabled")).toBe("true");
    document.getElementById("rom-weaver-checkbox-checksum-override").click();
    await waitForApplyButtonEnabled();
    await clickApplyButton();
    expect((await waitForApplyOutcome()).kind).toBe("download");
  });
}
