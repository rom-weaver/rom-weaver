import { createElement } from "react";
import { expect, test, vi } from "vitest";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import {
  clickApplyButton,
  getOutputFileNameValue,
  getPatchStackFileNames,
  getRuntimeErrorText,
  installPatcherTestHooks,
  loadFixtureFile,
  mount,
  RAW_PATCH,
  RAW_ROM,
  setFormControlValue,
  WRONG_INPUT_BPS,
  waitForApplyButtonEnabled,
  waitForApplyOutcome,
  waitForState,
} from "./patcher-test-shared.js";
import {
  getPatchToggles,
  buildZip,
  RAW_ROM_CHECKS,
  SAMPLE_ROM,
  buildSampleWeave,
  loadWrongSampleRom,
  getChecksumOverride,
  mountStrict,
  sha256Hex,
  captureDownloads,
  fileChecks,
  noiseBytes,
  withBytes,
  createIps,
  applyRecords,
  byteSwap16,
  applyWeaveAndReadOutput,
  buildWeaveArchive,
} from "./weave-session-shared.js";

installPatcherTestHooks();

test("local without-rom weave drop seeds optional patches off", async () => {
  const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
  const alternateFile = new File([await patchFile.arrayBuffer()], "alternate.ips", {
    type: "application/octet-stream",
  });
  const weaveJson = {
    output: { name: "bundled-output" },
    patches: [
      { name: "Core", path: "change.ips" },
      { name: "Alternate", optional: true, path: "alternate.ips" },
    ],
    rom: {
      checks: { checksums: { crc32: "c6fb1252" } },
      name: "game.bin",
    },
    version: 1,
  };
  const weaveFile = new File([JSON.stringify(weaveJson)], "rom-weaver-weave.json", { type: "application/json" });
  const weaveArchive = await buildZip(
    [
      { file: weaveFile, fileName: "rom-weaver-weave.json" },
      { file: patchFile, fileName: "change.ips" },
      { file: alternateFile, fileName: "alternate.ips" },
    ],
    "without-rom.zip",
  );

  // A user drop: the checks-only weave plus their own ROM in one gesture.
  mount(createElement(ApplyPatchForm, { pageDrop: { files: [weaveArchive, romFile], id: 1 } }));

  await expect.poll(() => getPatchStackFileNames(), { timeout: 30000 }).toEqual(["change.ips", "alternate.ips"]);
  await expect.poll(() => getPatchToggles().length, { timeout: 30000 }).toBe(2);
  // The optional patch must seed OFF; the core patch stays on.
  await expect.poll(() => getPatchToggles().map((toggle) => toggle.checked), { timeout: 30000 }).toEqual([true, false]);

  await waitForApplyButtonEnabled();
  await clickApplyButton();
  expect(await waitForApplyOutcome()).toEqual({ kind: "download" });

  // A completed run must be invalidated without starting another run when an optional weave patch
  // is turned back on. The patch file stays in the stack, so its extracted source cannot be released
  // with the first run.
  getPatchToggles()[1]?.click();
  await expect.poll(() => getPatchToggles()[1]?.checked, { timeout: 30000 }).toBe(true);
  await waitForApplyButtonEnabled();
  await expect
    .poll(() => document.getElementById("rom-weaver-button-apply")?.textContent || "", { timeout: 30000 })
    .toContain("Apply");
  expect(document.getElementById("rom-weaver-error-message")?.textContent || "").toBe("");

  await clickApplyButton();
  expect(await waitForApplyOutcome()).toEqual({ kind: "download" });

  // Reusing the same weave output name must remain valid across repeated
  // invalidation, validation, and apply cycles.
  for (let cycle = 0; cycle < 8; cycle += 1) {
    getPatchToggles()[1]?.click();
    await expect.poll(() => getPatchToggles()[1]?.checked, { timeout: 30000 }).toBe(cycle % 2 === 1);
    await waitForApplyButtonEnabled();
    expect(document.getElementById("rom-weaver-error-message")?.textContent || "").toBe("");
    await clickApplyButton();
    expect(await waitForApplyOutcome(), `cycle ${cycle}`).toEqual({ kind: "download" });
  }
});

test("weave keeps same-name apply usable after enabling several optional patches", async () => {
  const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
  const patchEntries = Array.from({ length: 8 }, (_, index) => ({
    name: `Patch ${index + 1}`,
    optional: index > 1,
    path: `patch-${index + 1}.ips`,
  }));
  const patchFiles = await Promise.all(
    patchEntries.map(async (entry) => new File([await patchFile.arrayBuffer()], entry.path)),
  );
  const weaveFile = new File(
    [
      JSON.stringify({
        output: { name: "same-output-name" },
        patches: patchEntries,
        rom: { path: "game.bin" },
        version: 1,
      }),
    ],
    "rom-weaver-weave.json",
    { type: "application/json" },
  );
  const weaveArchive = await buildZip(
    [
      { file: weaveFile, fileName: "rom-weaver-weave.json" },
      { file: romFile, fileName: "game.bin" },
      ...patchFiles.map((file) => ({ file, fileName: file.name })),
    ],
    "many-optional.zip",
  );

  mount(createElement(ApplyPatchForm, { pageDrop: { files: [weaveArchive], id: 1 } }));
  await expect.poll(() => getPatchToggles().length, { timeout: 30000 }).toBe(8);
  await expect
    .poll(() => getPatchToggles().map((toggle) => toggle.checked), { timeout: 30000 })
    .toEqual([true, true, false, false, false, false, false, false]);
  await expect.poll(() => getOutputFileNameValue(), { timeout: 30000 }).toBe("same-output-name");

  await waitForApplyButtonEnabled();
  await clickApplyButton();
  expect(await waitForApplyOutcome()).toEqual({ kind: "download" });

  for (const toggle of getPatchToggles().slice(2)) toggle.click();
  await expect
    .poll(
      () =>
        getPatchToggles()
          .slice(2)
          .every((toggle) => toggle.checked),
      { timeout: 30000 },
    )
    .toBe(true);
  await waitForApplyButtonEnabled();
  await clickApplyButton();
  expect(await waitForApplyOutcome()).toEqual({ kind: "download" });

  for (const toggle of getPatchToggles().slice(2)) toggle.click();
  await expect
    .poll(
      () =>
        getPatchToggles()
          .slice(2)
          .every((toggle) => !toggle.checked),
      { timeout: 30000 },
    )
    .toBe(true);
  await waitForApplyButtonEnabled();
  await clickApplyButton();
  expect(await waitForApplyOutcome()).toEqual({ kind: "download" });
});

const createIpsPatch = (fileName, offset, value) => {
  const bytes = new Uint8Array(14);
  bytes.set(new TextEncoder().encode("PATCH"));
  bytes.set([(offset >>> 16) & 0xff, (offset >>> 8) & 0xff, offset & 0xff, 0, 1, value], 5);
  bytes.set(new TextEncoder().encode("EOF"), 11);
  return new File([bytes], fileName, { type: "application/octet-stream" });
};

test("weave checks after a switched-off optional patch are not enforced; switched on they are sent", async () => {
  // 64 zero bytes; first.ips sets byte 0, second.ips sets byte 10. The authored chain declares the
  // second patch's output as both edits (crc32 f9f31dcf), which the bytes only match with first.ips on.
  const romFile = new File([new Uint8Array(64)], "game.bin", { type: "application/octet-stream" });
  const weaveFile = new File(
    [
      JSON.stringify({
        output: { name: "chain-check-output" },
        patches: [
          { name: "First", optional: true, path: "first.ips" },
          { name: "Second", outputChecks: { checksums: { crc32: "f9f31dcf" } }, path: "second.ips" },
        ],
        rom: { path: "game.bin" },
        version: 1,
      }),
    ],
    "rom-weaver-weave.json",
    { type: "application/json" },
  );
  const weaveArchive = await buildZip(
    [
      { file: weaveFile, fileName: "rom-weaver-weave.json" },
      { file: romFile, fileName: "game.bin" },
      { file: createIpsPatch("first.ips", 0, 1), fileName: "first.ips" },
      { file: createIpsPatch("second.ips", 10, 2), fileName: "second.ips" },
    ],
    "chain-checks.zip",
  );
  const applySpy = vi.spyOn(browserRuntime.patch, "applyPatch");
  const lastOutputChecks = () => applySpy.mock.calls.at(-1)?.[0]?.options?.patchOutputChecks;
  try {
    mount(createElement(ApplyPatchForm, { pageDrop: { files: [weaveArchive], id: 1 } }));
    await expect
      .poll(() => getPatchToggles().map((toggle) => toggle.checked), { timeout: 30000 })
      .toEqual([false, true]);

    await waitForApplyButtonEnabled();
    await clickApplyButton();
    expect(await waitForApplyOutcome()).toEqual({ kind: "download" });
    expect(lastOutputChecks()).toBeUndefined();

    getPatchToggles()[0]?.click();
    await expect.poll(() => getPatchToggles()[0]?.checked, { timeout: 30000 }).toBe(true);
    await waitForApplyButtonEnabled();
    await clickApplyButton();
    expect(await waitForApplyOutcome()).toEqual({ kind: "download" });
    expect(lastOutputChecks()).toEqual(["", "crc32=f9f31dcf"]);
  } finally {
    applySpy.mockRestore();
  }
});

test("a drawer output check on the chain output stands down when an earlier patch is switched off", async () => {
  const romFile = new File([new Uint8Array(64)], "game.bin", { type: "application/octet-stream" });
  const weaveArchive = await buildZip(
    [
      {
        file: new File(
          [
            JSON.stringify({
              output: { name: "drawer-output" },
              patches: [
                { name: "First", optional: true, path: "first.ips" },
                { name: "Second", path: "second.ips" },
              ],
              rom: { path: "game.bin" },
              version: 1,
            }),
          ],
          "rom-weaver-weave.json",
          { type: "application/json" },
        ),
        fileName: "rom-weaver-weave.json",
      },
      { file: romFile, fileName: "game.bin" },
      { file: createIpsPatch("first.ips", 0, 1), fileName: "first.ips" },
      { file: createIpsPatch("second.ips", 10, 2), fileName: "second.ips" },
    ],
    "drawer-output.zip",
  );
  mountStrict([weaveArchive]);
  await expect.poll(() => getPatchToggles().map((toggle) => toggle.checked), { timeout: 30000 }).toEqual([false, true]);
  getPatchToggles()[0]?.click();
  await expect.poll(() => getPatchToggles()[0]?.checked, { timeout: 30000 }).toBe(true);
  await waitForApplyButtonEnabled();
  document.querySelectorAll("#rom-weaver-list-patch-stack .cks-head")[1]?.click();
  const addCheck = await vi.waitFor(() => {
    const element = document.getElementById("rom-weaver-patch-output-add-check-1");
    if (!element) throw new Error("output add-check missing");
    return element;
  });
  addCheck.value = "crc32";
  addCheck.dispatchEvent(new Event("change", { bubbles: true }));
  const crcInput = await vi.waitFor(() => {
    const element = document.getElementById("rom-weaver-patch-output-crc32-1");
    if (!element) throw new Error("output crc32 input missing");
    return element;
  });
  setFormControlValue(crcInput, "f9f31dcf");
  crcInput.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 500));
  await clickApplyButton();
  expect(await waitForApplyOutcome()).toEqual({ kind: "download" });
  getPatchToggles()[0]?.click();
  await expect.poll(() => getPatchToggles()[0]?.checked, { timeout: 30000 }).toBe(false);
  await waitForApplyButtonEnabled();
  await clickApplyButton();
  expect(await waitForApplyOutcome()).toEqual({ kind: "download" });
});

test("imported weave whose optional patch is off applies without touching the toggle", async () => {
  // The off patch does not match the ROM (wrong-input BPS), so its preflight verdict is a
  // checksum mismatch. That verdict belongs to a patch that never runs and must not block Apply.
  const [romFile, patchFile, offBps] = await Promise.all([
    loadFixtureFile(RAW_ROM),
    loadFixtureFile(RAW_PATCH),
    loadFixtureFile(WRONG_INPUT_BPS),
  ]);
  const weaveFile = new File(
    [
      JSON.stringify({
        output: { name: "off-optional-output" },
        patches: [
          { name: "Core", path: "change.ips" },
          { name: "Off", optional: true, path: "wrong-input-same-size.bps" },
        ],
        rom: { checks: { checksums: { crc32: "c6fb1252" } }, name: "game.bin" },
        version: 1,
      }),
    ],
    "rom-weaver-weave.json",
    { type: "application/json" },
  );
  const weaveArchive = await buildZip(
    [
      { file: weaveFile, fileName: "rom-weaver-weave.json" },
      { file: patchFile, fileName: "change.ips" },
      { file: offBps, fileName: "wrong-input-same-size.bps" },
    ],
    "off-optional.zip",
  );
  const applySpy = vi.spyOn(browserRuntime.patch, "applyPatch");
  try {
    mount(
      createElement(ApplyPatchForm, {
        defaultSettings: { validation: { requireInputChecksumMatch: true } },
        pageDrop: { files: [weaveArchive, romFile], id: 1 },
      }),
    );
    await expect
      .poll(() => getPatchToggles().map((toggle) => toggle.checked), { timeout: 30000 })
      .toEqual([true, false]);
    await waitForApplyButtonEnabled();
    await clickApplyButton();
    expect(await waitForApplyOutcome()).toEqual({ kind: "download" });
    expect(applySpy).toHaveBeenCalledTimes(1);
  } finally {
    applySpy.mockRestore();
  }
});

const buildExpectedRomWeave = async (checks, patchFile) => {
  const weaveFile = new File(
    [
      JSON.stringify({
        output: { name: "expected-rom-output" },
        patches: [{ name: "Core", path: "change.ips" }],
        rom: { checks, name: "game.bin" },
        version: 1,
      }),
    ],
    "rom-weaver-weave.json",
    { type: "application/json" },
  );
  return buildZip(
    [
      { file: weaveFile, fileName: "rom-weaver-weave.json" },
      { file: patchFile, fileName: "change.ips" },
    ],
    "expected-rom.zip",
  );
};

test("weave expected-ROM checks accept the matching ROM", async () => {
  const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
  const weaveArchive = await buildExpectedRomWeave(RAW_ROM_CHECKS, patchFile);
  mount(
    createElement(ApplyPatchForm, {
      defaultSettings: { validation: { requireInputChecksumMatch: true } },
      pageDrop: { files: [weaveArchive, romFile], id: 1 },
    }),
  );
  await waitForApplyButtonEnabled();
  expect(document.getElementById("rom-weaver-checkbox-checksum-override")).toBeNull();
  await clickApplyButton();
  expect(await waitForApplyOutcome()).toEqual({ kind: "download" });
});

for (const { checks, label } of [
  { checks: { checksums: { crc32: "a1cecd74", sha1: RAW_ROM_CHECKS.checksums.sha1 }, size: 13 }, label: "checksum" },
  { checks: { checksums: { sha1: "96ff406466d366276a84a48947ae14cac4065e1c" } }, label: "sha-1 only" },
  { checks: { checksums: { crc32: "c6fb1252" }, size: 14 }, label: "size" },
]) {
  test(`weave expected-ROM ${label} mismatch blocks apply until override is checked`, async () => {
    const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
    const weaveArchive = await buildExpectedRomWeave(checks, patchFile);
    const applySpy = vi.spyOn(browserRuntime.patch, "applyPatch");
    try {
      mount(
        createElement(ApplyPatchForm, {
          defaultSettings: { validation: { requireInputChecksumMatch: true } },
          pageDrop: { files: [weaveArchive, romFile], id: 1 },
        }),
      );
      const override = await waitForState(() => {
        const checkbox = document.getElementById("rom-weaver-checkbox-checksum-override");
        return checkbox instanceof HTMLInputElement ? checkbox : null;
      }, 60000);
      await expect
        .poll(() => document.querySelector("#rom-weaver-list-patch-stack .file.bad .cks-match.bad"), {
          timeout: 60000,
        })
        .not.toBeNull();
      // The weave's output-name defaults land after staging and reset the override, so let them settle.
      await expect.poll(() => getOutputFileNameValue(), { timeout: 30000 }).toContain("expected-rom-output");
      expect(applySpy).not.toHaveBeenCalled();

      override.click();
      await waitForApplyButtonEnabled();
      await clickApplyButton();
      expect(await waitForApplyOutcome()).toEqual({ kind: "download" });
      expect(applySpy).toHaveBeenCalledTimes(1);
    } finally {
      applySpy.mockRestore();
    }
  });
}

test("sample weave applies on its matching ROM under strict validation", async () => {
  const [weaveArchive, romFile] = await Promise.all([buildSampleWeave(), loadFixtureFile(SAMPLE_ROM)]);
  const applySpy = vi.spyOn(browserRuntime.patch, "applyPatch");
  try {
    mountStrict([weaveArchive, romFile]);
    await expect
      .poll(() => getPatchStackFileNames(), { timeout: 30000 })
      .toEqual(["hello-to-rom.ips", "world-to-weaver.ips"]);
    await expect.poll(() => getOutputFileNameValue(), { timeout: 30000 }).toContain("rom-weaver");
    await waitForApplyButtonEnabled();
    expect(getChecksumOverride()).toBeNull();
    await clickApplyButton();
    expect(await waitForApplyOutcome()).toEqual({ kind: "download" });
    const options = applySpy.mock.calls.at(-1)?.[0]?.options;
    // The weave's ROM checks are compared with the supplied file in the browser; they are neither
    // the engine's --expect-in nor patch 0's own input declaration.
    expect(options?.validateWithChecksums).toBeUndefined();
    expect(options?.patchInputChecks).toBeUndefined();
  } finally {
    applySpy.mockRestore();
  }
});

// The shipped sample declares output.checks of the finished headered woven ROM (first-sample-assets.mjs).
test("sample weave with the shipped headered output.checks applies under strict validation", async () => {
  const [weaveArchive, romFile] = await Promise.all([
    buildSampleWeave({
      outputChecks: {
        checksums: {
          crc32: "abfab88e",
          md5: "fe0d2d115770f4edb7543b3f03ba58ae",
          sha1: "844b844c845dc99aa4f13a83b6c9cf639684ae8a",
        },
      },
    }),
    loadFixtureFile(SAMPLE_ROM),
  ]);
  mountStrict([weaveArchive, romFile]);
  await expect
    .poll(() => getPatchStackFileNames(), { timeout: 30000 })
    .toEqual(["hello-to-rom.ips", "world-to-weaver.ips"]);
  await waitForApplyButtonEnabled();
  await clickApplyButton();
  const outcome = await waitForApplyOutcome();
  expect(outcome?.kind, outcome && "errorText" in outcome ? outcome.errorText : "").toBe("download");
});

test("sample weave rejects a wrong ROM until the override is checked", async () => {
  const [weaveArchive, romFile] = await Promise.all([buildSampleWeave(), loadWrongSampleRom()]);
  const applySpy = vi.spyOn(browserRuntime.patch, "applyPatch");
  try {
    mountStrict([weaveArchive, romFile]);
    const override = await waitForState(getChecksumOverride, 60000);
    await expect.poll(() => getOutputFileNameValue(), { timeout: 30000 }).toContain("rom-weaver");
    expect(applySpy).not.toHaveBeenCalled();
    override.click();
    await waitForApplyButtonEnabled();
    await clickApplyButton();
    expect(await waitForApplyOutcome()).toEqual({ kind: "download" });
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(applySpy.mock.calls[0]?.[0]?.options?.validateWithChecksums).toBeUndefined();
  } finally {
    applySpy.mockRestore();
  }
});

test.each(["deadbeef", "2cccfa33"])("v1 IPS weave enforces final-output CRC32 %s", async (crc32) => {
  const romFile = new File(["ORIGINAL-ROM\n"], "game.bin");
  const weaveFile = new File(
    [
      JSON.stringify({
        output: { checks: { checksums: { crc32 } }, name: "audit" },
        patches: [{ name: "Core", path: "change.ips" }],
        rom: { checks: { checksums: { crc32: "c6fb1252" } }, name: "game.bin" },
        version: 1,
      }),
    ],
    "rom-weaver-weave.json",
    { type: "application/json" },
  );
  const weaveArchive = await buildZip(
    [
      { file: weaveFile, fileName: "rom-weaver-weave.json" },
      { file: createIpsPatch("change.ips", 1, 0x58), fileName: "change.ips" },
    ],
    "final-output-check.zip",
  );
  const capture = captureDownloads();
  try {
    mount(
      createElement(ApplyPatchForm, {
        defaultSettings: { output: { compression: "none" }, validation: { requireInputChecksumMatch: true } },
        pageDrop: { files: [romFile, weaveArchive], id: 1 },
      }),
    );
    await expect.poll(() => getOutputFileNameValue()).toBe("audit");
    await waitForApplyButtonEnabled();
    await clickApplyButton();
    const outcome = await waitForApplyOutcome();
    if (crc32 === "deadbeef") {
      expect(outcome?.kind).toBe("error");
      expect(outcome?.errorText).toContain("checksum mismatch for crc32; expected deadbeef, actual 2cccfa33");
      expect(capture.getDownloads()).toEqual([]);
      return;
    }
    expect(outcome).toEqual({ kind: "download" });
    await expect.poll(() => capture.getDownloads().length).toBe(1);
    const download = capture.getDownloads()[0];
    expect(download.name).toBe("audit.bin");
    expect(new TextDecoder().decode(await download.blob.arrayBuffer())).toBe("OXIGINAL-ROM\n");
    expect(await sha256Hex(download.blob)).toBe("43b1cc171d0b795e224072752effd13400f6392d0fab8d0793373cce4b4f46fb");
  } finally {
    capture.restore();
  }
});

test("a root-lane {rom: true} target still enforces the final-output CRC32", async () => {
  const romFile = new File(["ORIGINAL-ROM\n"], "game.bin");
  const weaveArchive = await buildFinalCheckWeave({
    files: [createIpsPatch("change.ips", 1, 0x58)],
    outputChecks: { checksums: { crc32: "deadbeef" } },
    patches: [{ name: "Core", path: "change.ips", target: { rom: true } }],
  });
  const capture = await mountWeaveWithCapture(
    (files) =>
      createElement(ApplyPatchForm, {
        defaultSettings: { output: { compression: "none" }, validation: { requireInputChecksumMatch: true } },
        pageDrop: { files, id: 1 },
      }),
    [romFile, weaveArchive],
  );
  try {
    await waitForApplyButtonEnabled();
    await clickApplyButton();
    const outcome = await waitForApplyOutcome();
    expect(outcome?.kind).toBe("error");
    expect(outcome?.errorText).toContain("deadbeef");
    expect(capture.getDownloads()).toEqual([]);
  } finally {
    capture.restore();
  }
});

test("weave final-output CRC32 stands down for a partial chain and returns for the full chain", async () => {
  const weaveFile = new File(
    [
      JSON.stringify({
        output: { checks: { checksums: { crc32: "deadbeef" } }, name: "partial-output" },
        patches: [
          { name: "Optional", optional: true, path: "optional.ips" },
          { name: "Core", path: "change.ips" },
        ],
        rom: { checks: { checksums: { crc32: "c6fb1252" } }, name: "game.bin" },
        version: 1,
      }),
    ],
    "rom-weaver-weave.json",
    { type: "application/json" },
  );
  const weaveArchive = await buildZip(
    [
      { file: weaveFile, fileName: "rom-weaver-weave.json" },
      { file: createIpsPatch("optional.ips", 0, 0x59), fileName: "optional.ips" },
      { file: createIpsPatch("change.ips", 1, 0x58), fileName: "change.ips" },
    ],
    "partial-final-output-check.zip",
  );
  const capture = captureDownloads();
  try {
    mount(
      createElement(ApplyPatchForm, {
        defaultSettings: { output: { compression: "none" }, validation: { requireInputChecksumMatch: true } },
        pageDrop: { files: [new File(["ORIGINAL-ROM\n"], "game.bin"), weaveArchive], id: 1 },
      }),
    );
    await expect.poll(() => getPatchToggles().map((toggle) => toggle.checked)).toEqual([false, true]);
    await waitForApplyButtonEnabled();
    await clickApplyButton();
    expect(await waitForApplyOutcome()).toEqual({ kind: "download" });
    await expect.poll(() => capture.getDownloads().length).toBe(1);

    getPatchToggles()[0].click();
    await expect.poll(() => getPatchToggles()[0].checked).toBe(true);
    await waitForApplyButtonEnabled();
    await clickApplyButton();
    const outcome = await waitForApplyOutcome();
    expect(outcome?.kind).toBe("error");
    expect(outcome?.errorText).toContain("checksum mismatch for crc32; expected deadbeef");
    expect(capture.getDownloads()).toHaveLength(1);
  } finally {
    capture.restore();
  }
});

const buildFinalCheckWeave = async ({ outputChecks, romChecks = { crc32: "c6fb1252" }, patches, files }) =>
  buildZip(
    [
      {
        file: new File(
          [
            JSON.stringify({
              output: { checks: outputChecks, name: "audit" },
              patches,
              rom: { checks: { checksums: romChecks }, name: "game.bin" },
              version: 1,
            }),
          ],
          "rom-weaver-weave.json",
          { type: "application/json" },
        ),
        fileName: "rom-weaver-weave.json",
      },
      ...files.map((file) => ({ file, fileName: file.name })),
    ],
    "final-output-check.zip",
  );

const mountWeaveWithCapture = async (element, files) => {
  const capture = captureDownloads();
  try {
    mount(element(files));
    await expect.poll(() => getOutputFileNameValue(), { timeout: 30000 }).toBe("audit");
    return capture;
  } catch (error) {
    capture.restore();
    throw error;
  }
};

test("Apply anyway bypasses the weave final-output check like every other check", async () => {
  const romFile = new File(["ORIGINAL-ROM\n"], "game.bin");
  const weaveArchive = await buildFinalCheckWeave({
    files: [createIpsPatch("change.ips", 1, 0x58)],
    outputChecks: { checksums: { crc32: "deadbeef" } },
    patches: [{ name: "Core", path: "change.ips" }],
    romChecks: { crc32: "00000001" },
  });
  const capture = await mountWeaveWithCapture(
    (files) =>
      createElement(ApplyPatchForm, {
        defaultSettings: { output: { compression: "none" }, validation: { requireInputChecksumMatch: true } },
        pageDrop: { files, id: 1 },
      }),
    [romFile, weaveArchive],
  );
  try {
    const override = await waitForState(getChecksumOverride, 60000);
    await expect.poll(() => getOutputFileNameValue(), { timeout: 30000 }).toBe("audit");
    override.click();
    await waitForApplyButtonEnabled();
    await clickApplyButton();
    expect(await waitForApplyOutcome()).toEqual({ kind: "download" });
    await expect.poll(() => capture.getDownloads().length).toBe(1);
  } finally {
    capture.restore();
  }
});

test("a rejected apply's error clears when a patch is turned off", async () => {
  const romFile = new File(["ORIGINAL-ROM\n"], "game.bin");
  const weaveArchive = await buildFinalCheckWeave({
    files: [createIpsPatch("a.ips", 1, 0x58), createIpsPatch("b.ips", 2, 0x59)],
    outputChecks: { checksums: { crc32: "deadbeef" } },
    patches: [
      { name: "A", path: "a.ips" },
      { name: "B", path: "b.ips" },
    ],
  });
  const capture = await mountWeaveWithCapture(
    (files) =>
      createElement(ApplyPatchForm, {
        defaultSettings: { output: { compression: "none" }, validation: { requireInputChecksumMatch: true } },
        pageDrop: { files, id: 1 },
      }),
    [romFile, weaveArchive],
  );
  try {
    await waitForApplyButtonEnabled();
    await clickApplyButton();
    expect((await waitForApplyOutcome())?.kind).toBe("error");
    getPatchToggles()[0]?.click();
    await expect.poll(() => getPatchToggles().map((toggle) => toggle.checked)).toEqual([false, true]);
    await expect
      .poll(
        () => getRuntimeErrorText() || document.getElementById("rom-weaver-output-notice-message")?.textContent?.trim(),
        {
          timeout: 30000,
        },
      )
      .toBeFalsy();
  } finally {
    capture.restore();
  }
});

test("non-strict mode does not enforce the weave final-output check", async () => {
  const romFile = new File(["ORIGINAL-ROM\n"], "game.bin");
  const weaveArchive = await buildFinalCheckWeave({
    files: [createIpsPatch("change.ips", 1, 0x58)],
    outputChecks: { checksums: { crc32: "deadbeef" } },
    patches: [{ name: "Core", path: "change.ips" }],
  });
  const capture = await mountWeaveWithCapture(
    (files) =>
      createElement(ApplyPatchForm, {
        defaultSettings: { output: { compression: "none" }, validation: { requireInputChecksumMatch: false } },
        pageDrop: { files, id: 1 },
      }),
    [romFile, weaveArchive],
  );
  try {
    await waitForApplyButtonEnabled();
    await clickApplyButton();
    expect(await waitForApplyOutcome()).toEqual({ kind: "download" });
    await expect.poll(() => capture.getDownloads().length).toBe(1);
  } finally {
    capture.restore();
  }
});

test("every declared weave output algorithm is enforced, not just one", async () => {
  const romFile = new File(["ORIGINAL-ROM\n"], "game.bin");
  const patched = new TextEncoder().encode("OXIGINAL-ROM\n");
  const correct = await fileChecks(patched);
  const weaveArchive = await buildFinalCheckWeave({
    files: [createIpsPatch("change.ips", 1, 0x58)],
    outputChecks: { checksums: { crc32: "deadbeef", sha1: correct.checksums.sha1 } },
    patches: [{ name: "Core", path: "change.ips" }],
  });
  const capture = await mountWeaveWithCapture(
    (files) =>
      createElement(ApplyPatchForm, {
        defaultSettings: { output: { compression: "none" }, validation: { requireInputChecksumMatch: true } },
        pageDrop: { files, id: 1 },
      }),
    [romFile, weaveArchive],
  );
  try {
    await waitForApplyButtonEnabled();
    await clickApplyButton();
    const outcome = await waitForApplyOutcome();
    expect(outcome?.kind).toBe("error");
    expect(outcome?.errorText).toContain("crc32");
    expect(outcome?.errorText).toContain("deadbeef");
    expect(capture.getDownloads()).toEqual([]);
  } finally {
    capture.restore();
  }
});

test("a weave output check declared only in output.checks accepts a byte-swapped N64 dump", async () => {
  const body = withBytes(noiseBytes(1024 * 1024, 0x64), 0, [0x80, 0x37, 0x12, 0x40]);
  const records = [[0x100, 0xf2]];
  const patches = [new File([createIps(records)], "first.ips")];
  const weaveArchive = await buildWeaveArchive(
    {
      output: { checks: await fileChecks(applyRecords(body, records)), name: "transform-output" },
      patches: [{ path: patches[0].name }],
      rom: { checks: await fileChecks(body), name: "game.v64" },
      version: 1,
    },
    patches,
  );
  await applyWeaveAndReadOutput([weaveArchive, new File([byteSwap16(body)], "game.v64")]);
});

test("a disc-level weave output check is not compared with a single track", async () => {
  const track = (seed) => Uint8Array.from({ length: 2352 * 40 }, (_, index) => (index * seed) & 0xff);
  const trackOne = new File([track(19)], "disc-track01.bin");
  const trackTwo = new File([track(29)], "disc-track02.bin");
  const cue = new File(
    [
      'FILE "disc-track01.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n' +
        'FILE "disc-track02.bin" BINARY\n  TRACK 02 MODE1/2352\n    INDEX 01 00:00:00\n',
    ],
    "disc.cue",
  );
  const weaveArchive = await buildZip(
    [
      {
        file: new File(
          [
            JSON.stringify({
              output: { checks: { checksums: { crc32: "deadbeef" } }, name: "audit" },
              patches: [
                { path: "a.ips", target: { member: "disc-track01.bin", rom: true } },
                { path: "b.ips", target: { member: "disc-track02.bin", rom: true } },
              ],
              rom: { name: "disc.cue" },
              version: 1,
            }),
          ],
          "rom-weaver-weave.json",
          { type: "application/json" },
        ),
        fileName: "rom-weaver-weave.json",
      },
      { file: createIpsPatch("a.ips", 0, 0xa1), fileName: "a.ips" },
      { file: createIpsPatch("b.ips", 0, 0xb2), fileName: "b.ips" },
    ],
    "disc-weave.zip",
  );
  const capture = captureDownloads();
  try {
    mount(
      createElement(ApplyPatchForm, {
        defaultSettings: { output: { compression: "none" }, validation: { requireInputChecksumMatch: true } },
        pageDrop: { files: [weaveArchive, cue, trackOne, trackTwo], id: 1 },
      }),
    );
    await expect.poll(() => getOutputFileNameValue(), { timeout: 30000 }).toBe("audit");
    await waitForApplyButtonEnabled();
    await clickApplyButton();
    const outcome = await waitForApplyOutcome();
    expect(outcome, outcome && "errorText" in outcome ? outcome.errorText : "").toEqual({ kind: "download" });
  } finally {
    capture.restore();
  }
});
