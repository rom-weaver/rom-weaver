import { createElement } from "react";
import { expect, test, vi } from "vitest";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import {
  clickApplyButton,
  installPatcherTestHooks,
  loadFixtureFile,
  mount,
  selectFileInputs,
  waitForApplyButtonEnabled,
  waitForApplyOutcome,
} from "./patcher-test-shared.js";

installPatcherTestHooks();

const NES_ROM = "tests/fixtures/cheats/hello-world.nes";
const GREETING = "Make the greeting start with M";
const BACKGROUND = "Change the background color";

const clickButton = async (label) => {
  const find = () =>
    [...document.querySelectorAll("button")].find(
      (button) =>
        !button.disabled && (button.textContent?.includes(label) || button.getAttribute("aria-label") === label),
    );
  await expect.poll(() => Boolean(find())).toBe(true);
  find().click();
};

const toggles = () => [...document.querySelectorAll("#rom-weaver-list-patch-stack .patch-enable input")];

const exportCheats = async (rom, patches, descriptions, patchEnabled = true) => {
  window.history.replaceState(null, "", "/apply-rom-patches?guide=apply");
  let result = null;
  let archive = null;
  const saveAs = browserRuntime.publicOutput.saveAs;
  const saveSpy = vi.spyOn(browserRuntime.publicOutput, "saveAs").mockImplementation(async (output, destination) => {
    const blob = await browserRuntime.publicOutput.getBlob(output);
    archive = new File([await blob.arrayBuffer()], output.fileName, { type: "application/zip" });
    return saveAs.call(browserRuntime.publicOutput, output, destination);
  });
  try {
    mount(
      createElement(ApplyPatchForm, {
        defaultSettings: { output: { compression: "none" } },
        onWeaveExportComplete: (value) => {
          result = value;
        },
      }),
    );
    await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();
    await expect.poll(() => document.querySelector('[aria-label="Practice run steps"]')).not.toBeNull();
    selectFileInputs(document.getElementById("rom-weaver-input-file-unified"), [rom, ...patches]);
    await clickButton("Add cheats to the patch order");
    for (const description of descriptions) await clickButton(`Add ${description}`);
    await clickButton("Close");
    if (!patchEnabled) {
      await expect.poll(() => toggles()[0]?.checked).toBe(true);
      toggles()[0].click();
      await expect.poll(() => toggles()[0]?.checked).toBe(false);
    }
    await waitForApplyButtonEnabled();
    await expect.poll(() => document.querySelector("#rom-weaver-weave-job .cks-head")).not.toBeNull();
    const drawer = document.querySelector("#rom-weaver-weave-job .cks-head");
    if (drawer.getAttribute("aria-expanded") !== "true") drawer.click();
    expect(document.querySelector("#rom-weaver-weave-job .patch-off-note")?.textContent).toBe(
      "Each enabled cheat becomes a separate patch. Recipients can switch cheats on or off.",
    );
    await expect.poll(() => document.getElementById("rom-weaver-button-export-weave")?.disabled).toBe(false);
    document.getElementById("rom-weaver-button-export-weave").click();
    await expect.poll(() => archive, { timeout: 60000 }).not.toBeNull();
    expect(result).not.toBeNull();
    expect(archive.name).toMatch(/\.zip$/);
    expect(result.weave.rom?.path ?? null).toBeNull();
    await expect.poll(() => document.getElementById("rom-weaver-button-export-weave")?.disabled).toBe(false);
    return { archive, weave: result.weave };
  } finally {
    saveSpy.mockRestore();
  }
};

const captureAppliedBytes = () => {
  const outputs = [];
  const applyPatch = browserRuntime.patch.applyPatch;
  const spy = vi.spyOn(browserRuntime.patch, "applyPatch").mockImplementation(async (input) => {
    const output = await applyPatch.call(browserRuntime.patch, input);
    outputs.push(new Uint8Array(await (await browserRuntime.publicOutput.getBlob(output)).arrayBuffer()));
    return output;
  });
  return { outputs, restore: () => spy.mockRestore() };
};

const applyAndRead = async (outputs) => {
  const count = outputs.length;
  await waitForApplyButtonEnabled();
  await clickApplyButton();
  expect(await waitForApplyOutcome()).toEqual({ kind: "download" });
  expect(outputs).toHaveLength(count + 1);
  return outputs.at(-1);
};

test.each([true, false])(
  "exported cheat preserves the neighboring IPS with original enabled=%s",
  async (patchEnabled) => {
    const rom = await loadFixtureFile(NES_ROM);
    const original = new Uint8Array(await rom.arrayBuffer());
    const neighbor = new File(
      [new Uint8Array([0x50, 0x41, 0x54, 0x43, 0x48, 0, 0, 0xa7, 0, 2, 0x66, 0x7f, 0x45, 0x4f, 0x46])],
      "neighbor.ips",
    );
    const { archive, weave } = await exportCheats(rom, [neighbor], [GREETING], patchEnabled);
    expect(weave.patches).toHaveLength(2);
    expect(weave.patches[1].name).toBe(GREETING);
    expect(Boolean(weave.patches[0].optional)).toBe(!patchEnabled);
    expect(weave.patches[0].path).toBe("neighbor.ips");
    expect(weave.patches[1]).toMatchObject({ header: "keep", basis: "previous" });
    expect(weave.patches[1].path).toMatch(/\.ips(?:32)?$/);

    const { outputs, restore } = captureAppliedBytes();
    try {
      mount(
        createElement(ApplyPatchForm, {
          defaultSettings: { output: { compression: "none" } },
          pageDrop: { files: [archive, rom], id: 2 },
        }),
      );
      await expect
        .poll(() => toggles().map((toggle) => toggle.checked), { timeout: 30000 })
        .toEqual([patchEnabled, true]);
      if (!patchEnabled) {
        const cheatOnly = original.slice();
        cheatOnly[0xa7] = 0x0d;
        expect(await applyAndRead(outputs)).toEqual(cheatOnly);
        toggles()[0].click();
        await expect.poll(() => toggles()[0]?.checked).toBe(true);
      }
      const both = original.slice();
      both[0xa7] = 0x0d;
      both[0xa8] = 0x7f;
      expect(await applyAndRead(outputs)).toEqual(both);

      toggles()[1].click();
      await expect.poll(() => toggles().map((toggle) => toggle.checked)).toEqual([true, false]);
      const patchOnly = original.slice();
      patchOnly[0xa7] = 0x66;
      patchOnly[0xa8] = 0x7f;
      expect(await applyAndRead(outputs)).toEqual(patchOnly);
    } finally {
      restore();
    }
  },
);

test("a cheats-only weave keeps each selected cheat as a separate patch in selection order", async () => {
  const rom = await loadFixtureFile(NES_ROM);
  const original = new Uint8Array(await rom.arrayBuffer());
  const { archive, weave } = await exportCheats(rom, [], [BACKGROUND, GREETING]);
  expect(weave.patches.map((patch) => patch.name)).toEqual([BACKGROUND, GREETING]);
  expect(new Set(weave.patches.map((patch) => patch.path)).size).toBe(2);
  for (const patch of weave.patches) expect(patch).toMatchObject({ header: "keep", basis: "previous" });

  const { outputs, restore } = captureAppliedBytes();
  try {
    mount(
      createElement(ApplyPatchForm, {
        defaultSettings: { output: { compression: "none" } },
        pageDrop: { files: [archive, rom], id: 2 },
      }),
    );
    await expect.poll(() => toggles().map((toggle) => toggle.checked), { timeout: 30000 }).toEqual([true, true]);
    const both = original.slice();
    both[0x87] = 0x30;
    both[0xa7] = 0x0d;
    expect(await applyAndRead(outputs)).toEqual(both);

    toggles()[1].click();
    await expect.poll(() => toggles().map((toggle) => toggle.checked)).toEqual([true, false]);
    const backgroundOnly = original.slice();
    backgroundOnly[0x87] = 0x30;
    expect(await applyAndRead(outputs)).toEqual(backgroundOnly);
  } finally {
    restore();
  }
});
