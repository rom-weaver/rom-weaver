import { createElement } from "react";
import { expect, test } from "vitest";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import {
  installPatcherTestHooks,
  loadFixtureFile,
  mount,
  RAW_PATCH,
  waitForApplyButtonEnabled,
  waitForState,
} from "./patcher-test-shared.js";

installPatcherTestHooks();

/** A minimal iNES ROM (16-byte header + 2×16K PRG + 8K CHR) so the header
 * checkbox ("Strip 16-byte ROM header before patching") is offered. */
const buildInesRom = () => {
  const header = new Uint8Array(16);
  header.set([0x4e, 0x45, 0x53, 0x1a, 0x02, 0x01, 0x01, 0x00]);
  const payload = new Uint8Array(2 * 16384 + 8192).fill(0x11);
  const bytes = new Uint8Array(header.length + payload.length);
  bytes.set(header);
  bytes.set(payload, header.length);
  return new File([bytes], "game.nes", { type: "application/octet-stream" });
};

test("strip-header toggle settles inside an everything archive bundle session", async () => {
  const patchFile = await loadFixtureFile(RAW_PATCH);
  const romFile = buildInesRom();
  const bundleJson = {
    output: { name: "hack.nes" },
    patches: [{ name: "Core", path: "change.ips" }],
    rom: {
      checks: { checksums: { crc32: await crc32Hex(romFile) }, size: romFile.size },
      path: "game.nes",
    },
    version: 1,
  };
  const bundleArchive = await buildZip(
    [
      {
        file: new File([JSON.stringify(bundleJson)], "rom-weaver-bundle.json", { type: "application/json" }),
        fileName: "rom-weaver-bundle.json",
      },
      { file: romFile, fileName: "game.nes" },
      { file: patchFile, fileName: "change.ips" },
    ],
    "with-rom.zip",
  );
  mount(createElement(ApplyPatchForm, { pageDrop: { files: [bundleArchive], id: 2 } }));
  await waitForApplyButtonEnabled();

  const headerSelect = await waitForState(() => document.getElementById("rom-weaver-patch-header-mode-0"));
  expect(headerSelect).not.toBeNull();
  headerSelect.value = "strip";
  headerSelect.dispatchEvent(new Event("change", { bubbles: true }));

  await expect
    .poll(
      () =>
        document.querySelectorAll(
          "#rom-weaver-list-patch-stack progress, #rom-weaver-list-patch-stack .fileprog, #rom-weaver-list-patch-stack [role=progressbar]",
        ).length,
      { timeout: 30000 },
    )
    .toBe(0);
  await waitForApplyButtonEnabled();
});

const buildZip = async (entries, outputName) => {
  const create = browserRuntime.compression.create;
  if (!create) throw new Error("Runtime compression create capability is unavailable");
  const result = await create({ entries, format: "zip", options: { outputName, workerThreads: 1 } });
  const output = result?.output;
  if (!output) throw new Error("Zip compression did not return output");
  try {
    const blob = await browserRuntime.publicOutput.getBlob(output);
    return new File([blob], outputName, { type: "application/zip" });
  } finally {
    await output.dispose().catch(() => undefined);
  }
};

const crc32Hex = async (file) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
};

test("toggling the strip-header option settles instead of loading forever", async () => {
  const patchFile = await loadFixtureFile(RAW_PATCH);
  const romFile = buildInesRom();
  mount(createElement(ApplyPatchForm, { pageDrop: { files: [romFile, patchFile], id: 1 } }));
  await waitForApplyButtonEnabled();

  // Pin the header mode to strip via the meta-line select.
  const headerSelect = await waitForState(() => document.getElementById("rom-weaver-patch-header-mode-0"));
  expect(headerSelect).not.toBeNull();
  headerSelect.value = "strip";
  headerSelect.dispatchEvent(new Event("change", { bubbles: true }));

  // The re-validation must finish: no lingering progress bar on the patch
  // card and the apply button re-arms.
  await expect
    .poll(
      () =>
        document.querySelectorAll(
          "#rom-weaver-list-patch-stack progress, #rom-weaver-list-patch-stack .fileprog, #rom-weaver-list-patch-stack [role=progressbar]",
        ).length,
      {
        timeout: 30000,
      },
    )
    .toBe(0);
  await waitForApplyButtonEnabled();
});
