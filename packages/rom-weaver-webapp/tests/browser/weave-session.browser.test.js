import { createElement } from "react";
import { expect, test, vi } from "vitest";
import { loadLocalWeaveSession } from "../../src/lib/weave/local-weave-session.ts";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { browserVfs } from "../../src/platform/browser/workflow-runtime-vfs-cleanup.ts";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import { loadWeaveUrlSession } from "../../src/webapp/url-session/weave-url-session.ts";
import {
  clickApplyButton,
  getOutputFileNameValue,
  getPatchStackFileNames,
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

installPatcherTestHooks();

const ALTERNATE_PATCH = "tests/fixtures/archive_sources/multi-patch/alternate.ips";
const WEAVE_URL = `${location.origin}/virtual/weave/rom-weaver-weave.json`;

// The weave's sources are real same-origin fixture URLs (only the rom-weaver-weave.json itself is virtual, so
// fetch is stubbed for that one URL and passed through for everything else).
const WEAVE_JSON = {
  output: { name: "weave-output" },
  patches: [
    {
      description: "Required core patch",
      label: "stable",
      name: "Core",
      url: `${location.origin}/${RAW_PATCH}`,
    },
    { name: "Alternate", optional: true, url: `${location.origin}/${ALTERNATE_PATCH}` },
  ],
  rom: { url: `${location.origin}/${RAW_ROM}` },
  version: 1,
};

const withWeaveFetchStub = async (weave, run) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input?.url || String(input);
    if (url === WEAVE_URL) {
      return Promise.resolve(
        new Response(JSON.stringify(weave), { headers: { "content-type": "application/json" }, status: 200 }),
      );
    }
    return originalFetch(input, init);
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const getPatchToggles = () => Array.from(document.querySelectorAll("#rom-weaver-list-patch-stack .patch-enable input"));

// Pack files into a zip through the real compression runtime (what a patch
// distributor would publish as a without-ROM weave).
const buildZip = async (entries, outputName) => {
  const create = browserRuntime.compression.create;
  if (!create) throw new Error("Runtime compression create capability is unavailable");
  const result = await create({
    entries,
    format: "zip",
    options: { outputName, threads: 1 },
  });
  const output = result?.output;
  if (!output) throw new Error("Zip compression did not return output");
  try {
    // Materialize the bytes before dispose() deletes the backing OPFS file - a
    // File built straight from the blob references that file lazily, and reads
    // during the later drop intermittently fail once it is gone.
    const blob = await browserRuntime.publicOutput.getBlob(output);
    const bytes = await blob.arrayBuffer();
    return new File([bytes], outputName, { type: "application/zip" });
  } finally {
    await output.dispose().catch(() => undefined);
  }
};

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

// RAW_ROM (game.bin) is 13 bytes: crc32 c6fb1252, sha1 1d73a56886d4cd676b771bca857cf64b227e3677.
const RAW_ROM_CHECKS = {
  checksums: { crc32: "c6fb1252", sha1: "1d73a56886d4cd676b771bca857cf64b227e3677" },
  size: 13,
};

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

// The guided Apply sample (first-weave.zip): a headered NES ROM whose weave declares `basis: base`
// on both patches and full rom.checks including size. The IPS bytes match the shipped sample.
const SAMPLE_ROM = "tests/fixtures/cheats/hello-world.nes";
const SAMPLE_ROM_CHECKS = {
  checksums: {
    crc32: "3e30b9b3",
    md5: "df0e55e0f744b2d9734ef90e4454aa8f",
    sha1: "22f56591eb4dbb85fbb6398cd0c4554558f70603",
  },
  size: 24592,
};
const ipsFile = (fileName, bytes) => new File([new Uint8Array(bytes)], fileName, { type: "application/octet-stream" });
const IPS_EOF = [0x45, 0x4f, 0x46];
const IPS_HEADER = [0x50, 0x41, 0x54, 0x43, 0x48];
const SAMPLE_PATCHES = [
  ipsFile("hello-to-rom.ips", [...IPS_HEADER, 0, 0, 0xa8, 0, 5, 0x12, 0x0f, 0x0d, 0, 0, ...IPS_EOF]),
  ipsFile("world-to-weaver.ips", [...IPS_HEADER, 0, 0, 0xaf, 0, 5, 0x05, 0x01, 0x16, 0x05, 0x12, ...IPS_EOF]),
];

const buildSampleWeave = async ({ patches } = {}) => {
  const weaveFile = new File(
    [
      JSON.stringify({
        output: { name: "rom-weaver.nes" },
        patches: patches || [
          { basis: "base", name: "Hello to ROM", path: "hello-to-rom.ips" },
          { basis: "base", name: "World to WEAVER", path: "world-to-weaver.ips" },
        ],
        rom: { checks: SAMPLE_ROM_CHECKS, name: "hello-world.nes" },
        version: 1,
      }),
    ],
    "rom-weaver-weave.json",
    { type: "application/json" },
  );
  return buildZip(
    [
      { file: weaveFile, fileName: "rom-weaver-weave.json" },
      ...SAMPLE_PATCHES.map((file) => ({ file, fileName: file.name })),
    ],
    "sample-weave.zip",
  );
};

// Same size as the sample ROM, one byte changed outside the patched range.
const loadWrongSampleRom = async () => {
  const bytes = new Uint8Array(await (await loadFixtureFile(SAMPLE_ROM)).arrayBuffer());
  bytes[0x2000] ^= 0xff;
  return new File([bytes], "hello-world.nes", { type: "application/octet-stream" });
};

const getChecksumOverride = () => {
  const checkbox = document.getElementById("rom-weaver-checkbox-checksum-override");
  return checkbox instanceof HTMLInputElement ? checkbox : null;
};

const mountStrict = (files) =>
  mount(
    createElement(ApplyPatchForm, {
      defaultSettings: { validation: { requireInputChecksumMatch: true } },
      pageDrop: { files, id: 1 },
    }),
  );

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

for (const romKind of ["matching", "wrong"]) {
  test(`expected-ROM checks follow an optional first patch switched on (${romKind} ROM)`, async () => {
    const [weaveArchive, romFile] = await Promise.all([
      buildSampleWeave({
        patches: [
          { name: "Hello to ROM", optional: true, path: "hello-to-rom.ips" },
          { name: "World to WEAVER", path: "world-to-weaver.ips" },
        ],
      }),
      romKind === "matching" ? loadFixtureFile(SAMPLE_ROM) : loadWrongSampleRom(),
    ]);
    const applySpy = vi.spyOn(browserRuntime.patch, "applyPatch");
    try {
      mountStrict([weaveArchive, romFile]);
      await expect
        .poll(() => getPatchToggles().map((toggle) => toggle.checked), { timeout: 30000 })
        .toEqual([false, true]);
      await expect.poll(() => getOutputFileNameValue(), { timeout: 30000 }).toContain("rom-weaver");
      getPatchToggles()[0]?.click();
      await expect
        .poll(() => getPatchToggles().map((toggle) => toggle.checked), { timeout: 30000 })
        .toEqual([true, true]);
      if (romKind === "wrong") {
        const override = await waitForState(getChecksumOverride, 60000);
        expect(applySpy).not.toHaveBeenCalled();
        override.click();
      }
      await waitForApplyButtonEnabled();
      if (romKind === "matching") expect(getChecksumOverride()).toBeNull();
      await clickApplyButton();
      expect(await waitForApplyOutcome()).toEqual({ kind: "download" });
      const options = applySpy.mock.calls.at(-1)?.[0]?.options;
      expect(options?.patchInputChecks).toBeUndefined();
      expect(options?.validateWithChecksums).toBeUndefined();
    } finally {
      applySpy.mockRestore();
    }
  });
}

test("expected-ROM checks follow a reordered sample weave", async () => {
  const [weaveArchive, romFile] = await Promise.all([buildSampleWeave(), loadFixtureFile(SAMPLE_ROM)]);
  const applySpy = vi.spyOn(browserRuntime.patch, "applyPatch");
  try {
    mountStrict([weaveArchive, romFile]);
    await expect
      .poll(() => getPatchStackFileNames(), { timeout: 30000 })
      .toEqual(["hello-to-rom.ips", "world-to-weaver.ips"]);
    await expect.poll(() => getOutputFileNameValue(), { timeout: 30000 }).toContain("rom-weaver");
    document.querySelector("#rom-weaver-list-patch-stack .handle")?.click();
    const positionInput = await waitForState(
      () => document.querySelector("#rom-weaver-list-patch-stack .phandle-input"),
      30000,
    );
    setFormControlValue(positionInput, "2");
    positionInput.blur();
    await expect
      .poll(() => getPatchStackFileNames(), { timeout: 30000 })
      .toEqual(["world-to-weaver.ips", "hello-to-rom.ips"]);
    await waitForApplyButtonEnabled();
    expect(getChecksumOverride()).toBeNull();
    await clickApplyButton();
    expect(await waitForApplyOutcome()).toEqual({ kind: "download" });
    const options = applySpy.mock.calls.at(-1)?.[0]?.options;
    expect(options?.validateWithChecksums).toBeUndefined();
    expect(options?.patchInputChecks).toBeUndefined();
  } finally {
    applySpy.mockRestore();
  }
});

// Header and N64 byte-order cases: rom.checks describe the file as supplied (as weave export and
// `weave create` write them), while the patch targets headerless or big-endian bytes. The checks
// must neither block the matching ROM nor change the engine's automatic header decision.
const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const crc32 = (bytes) => {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};
const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const fileChecks = async (bytes) => ({
  checksums: {
    crc32: crc32(bytes).toString(16).padStart(8, "0"),
    sha1: hex(new Uint8Array(await crypto.subtle.digest("SHA-1", bytes))),
  },
  size: bytes.length,
});
// Deterministic pseudo-random bytes (xorshift32), so the ROM has no accidental structure.
const noiseBytes = (length, seed) => {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
};
const withBytes = (source, offset, replacement) => {
  const bytes = new Uint8Array(source);
  bytes.set(replacement, offset);
  return bytes;
};
const vlq = (value) => {
  const out = [];
  let rest = value;
  for (;;) {
    const low = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest === 0) {
      out.push(0x80 | low);
      return out;
    }
    out.push(low);
    rest -= 1;
  }
};
const u32le = (value) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
// A same-size BPS: SourceRead the unchanged prefix, TargetRead the changed span, SourceRead the rest.
const createBps = (source, target) => {
  let start = 0;
  while (start < source.length && source[start] === target[start]) start += 1;
  let end = source.length;
  while (end > start && source[end - 1] === target[end - 1]) end -= 1;
  const bytes = [0x42, 0x50, 0x53, 0x31, ...vlq(source.length), ...vlq(target.length), ...vlq(0)];
  if (start > 0) bytes.push(...vlq((start - 1) * 4));
  bytes.push(...vlq((end - start - 1) * 4 + 1), ...target.subarray(start, end));
  if (end < source.length) bytes.push(...vlq((source.length - end - 1) * 4));
  bytes.push(...u32le(crc32(source)), ...u32le(crc32(target)));
  bytes.push(...u32le(crc32(bytes)));
  return new Uint8Array(bytes);
};
// One-byte IPS records: [offset, value].
const createIps = (records) =>
  new Uint8Array([
    ...IPS_HEADER,
    ...records.flatMap(([offset, value]) => [
      (offset >>> 16) & 0xff,
      (offset >>> 8) & 0xff,
      offset & 0xff,
      0,
      1,
      value,
    ]),
    ...IPS_EOF,
  ]);
const applyRecords = (source, records) => {
  const bytes = new Uint8Array(source);
  for (const [offset, value] of records) bytes[offset] = value;
  return bytes;
};
// A LoROM internal header ("TEST GAME", map mode 0x20, 1 MiB) at 0x7fc0 of the headerless image.
const SNES_INTERNAL_HEADER = [
  0x54,
  0x45,
  0x53,
  0x54,
  0x20,
  0x47,
  0x41,
  0x4d,
  0x45,
  ...Array.from({ length: 13 }, () => 0x20),
  0x00,
  0x0a,
  0x00,
  0x01,
  0x33,
  0x00,
  0x12,
  0x4b,
  0xfb,
  0x9f,
];
const byteSwap16 = (source) => {
  const bytes = new Uint8Array(source.length);
  for (let index = 0; index + 1 < source.length; index += 2) {
    bytes[index] = source[index + 1];
    bytes[index + 1] = source[index];
  }
  return bytes;
};

const buildTransformWeave = async (romChecks, patchName, patchBytes, romName) => {
  const weaveFile = new File(
    [
      JSON.stringify({
        output: { name: "transform-output" },
        patches: [{ name: "Hack", path: patchName }],
        rom: { checks: romChecks, name: romName },
        version: 1,
      }),
    ],
    "rom-weaver-weave.json",
    { type: "application/json" },
  );
  return buildZip(
    [
      { file: weaveFile, fileName: "rom-weaver-weave.json" },
      { file: new File([patchBytes], patchName), fileName: patchName },
    ],
    "transform-weave.zip",
  );
};

// Apply under strict validation and return the bytes the engine produced.
const applyWeaveAndReadOutput = async (files) => {
  const original = browserRuntime.patch.applyPatch;
  let outputBytes = null;
  const applySpy = vi.spyOn(browserRuntime.patch, "applyPatch").mockImplementation(async (input) => {
    const output = await original.call(browserRuntime.patch, input);
    outputBytes = new Uint8Array(await (await browserRuntime.publicOutput.getBlob(output)).arrayBuffer());
    return output;
  });
  try {
    mountStrict(files);
    await expect.poll(() => getOutputFileNameValue(), { timeout: 30000 }).toContain("transform-output");
    await waitForApplyButtonEnabled();
    expect(getChecksumOverride()).toBeNull();
    await clickApplyButton();
    expect(await waitForApplyOutcome()).toEqual({ kind: "download" });
    if (!outputBytes) throw new Error("apply produced no output");
    return { options: applySpy.mock.calls.at(-1)?.[0]?.options, output: outputBytes };
  } finally {
    applySpy.mockRestore();
  }
};

test("weave rom.checks of a headered ROM accept it for a headerless BPS", async () => {
  const headered = new Uint8Array(await (await loadFixtureFile(SAMPLE_ROM)).arrayBuffer());
  const headerless = headered.subarray(16);
  const modified = withBytes(headerless, 0x98, [0x12, 0x0f, 0x0d, 0x00, 0x00]);
  const weaveArchive = await buildTransformWeave(
    SAMPLE_ROM_CHECKS,
    "hack.bps",
    createBps(headerless, modified),
    "hello-world.nes",
  );
  const { options, output } = await applyWeaveAndReadOutput([weaveArchive, await loadFixtureFile(SAMPLE_ROM)]);
  // The patched headerless bytes, with or without the copier header put back.
  expect(hex(output.subarray(output.length - modified.length))).toBe(hex(modified));
  // Never the engine's --expect-in, which checks the transformed bytes and steers the header choice.
  expect(options?.validateWithChecksums).toBeUndefined();
});

test("weave rom.checks of a headered SNES ROM keep the automatic headerless IPS basis", async () => {
  const headerless = withBytes(noiseBytes(1024 * 1024, 0x5eed), 0x7fc0, SNES_INTERNAL_HEADER);
  const headered = new Uint8Array(512 + headerless.length);
  headered.set(headerless, 512);
  const records = [
    [0x100, 0xf2],
    [0x8000, 0x09],
    [0x9001, 0x7e],
    [0xffff0, 0x78],
  ];
  const modified = applyRecords(headerless, records);
  // A hand-written weave may carry only a CRC32 and size for its ROM.
  const { checksums, size } = await fileChecks(headered);
  const weaveArchive = await buildTransformWeave(
    { checksums: { crc32: checksums.crc32 }, size },
    "hack.ips",
    createIps(records),
    "game.smc",
  );
  const { options, output } = await applyWeaveAndReadOutput([weaveArchive, new File([headered], "game.smc")]);
  // With the header wrongly kept, every IPS record would land 512 bytes early.
  expect(hex(output.subarray(output.length - modified.length))).toBe(hex(modified));
  // Never the engine's --expect-in, which checks the transformed bytes and steers the header choice.
  expect(options?.validateWithChecksums).toBeUndefined();
});

test("weave rom.checks of a byte-swapped N64 ROM accept it for a big-endian BPS", async () => {
  const bigEndian = withBytes(noiseBytes(1024 * 1024, 0x64), 0, [0x80, 0x37, 0x12, 0x40]);
  const modified = withBytes(bigEndian, 0x1000, [0xde, 0xad, 0xbe, 0xef]);
  const byteSwapped = byteSwap16(bigEndian);
  const weaveArchive = await buildTransformWeave(
    await fileChecks(byteSwapped),
    "hack.bps",
    createBps(bigEndian, modified),
    "game.v64",
  );
  const { options, output } = await applyWeaveAndReadOutput([weaveArchive, new File([byteSwapped], "game.v64")]);
  const normalized = output[0] === 0x37 && output[1] === 0x80 ? byteSwap16(output) : output;
  expect(hex(normalized)).toBe(hex(modified));
  // Never the engine's --expect-in, which checks the transformed bytes and steers the header choice.
  expect(options?.validateWithChecksums).toBeUndefined();
});

const buildWeaveArchive = async (weave, patchFiles) =>
  buildZip(
    [
      {
        file: new File([JSON.stringify(weave)], "rom-weaver-weave.json", { type: "application/json" }),
        fileName: "rom-weaver-weave.json",
      },
      ...patchFiles.map((file) => ({ file, fileName: file.name })),
    ],
    "rom-check-weave.zip",
  );

// Apply under strict validation: a matching ROM applies with no override; a wrong one shows the
// override and reaches the engine only once it is checked.
const expectStrictApply = async (files, { outputName, romMatches }) => {
  const applySpy = vi.spyOn(browserRuntime.patch, "applyPatch");
  try {
    mountStrict(files);
    if (romMatches) {
      await expect.poll(() => getOutputFileNameValue(), { timeout: 30000 }).toContain(outputName);
      await waitForApplyButtonEnabled();
      expect(getChecksumOverride()).toBeNull();
    } else {
      const override = await waitForState(getChecksumOverride, 60000);
      // The weave's output-name defaults land after staging and reset the override, so let them settle.
      await expect.poll(() => getOutputFileNameValue(), { timeout: 30000 }).toContain(outputName);
      expect(applySpy).not.toHaveBeenCalled();
      override.click();
      await waitForApplyButtonEnabled();
    }
    await clickApplyButton();
    expect(await waitForApplyOutcome()).toEqual({ kind: "download" });
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(applySpy.mock.calls[0]?.[0]?.options?.validateWithChecksums).toBeUndefined();
  } finally {
    applySpy.mockRestore();
  }
};

// The browser export writes `target: {rom: true}` on every patch, version 2 and patchBasis auto.
for (const romMatches of [true, false]) {
  test(`exported-shape weave verifies rom.checks (${romMatches ? "matching" : "wrong"} ROM)`, async () => {
    const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
    const checks = romMatches
      ? RAW_ROM_CHECKS
      : { checksums: { crc32: "a1cecd74", sha1: "96ff406466d366276a84a48947ae14cac4065e1c" }, size: 14 };
    const weaveArchive = await buildWeaveArchive(
      {
        output: { name: "exported-output" },
        patchBasis: "auto",
        patches: [{ name: "Core", path: patchFile.name, target: { rom: true } }],
        rom: { checks, name: "game.bin" },
        version: 2,
      },
      [patchFile],
    );
    await expectStrictApply([weaveArchive, romFile], { outputName: "exported-output", romMatches });
  });
}

// `weave create --checksum sha256` writes algorithms staging does not compute; they are hashed on demand.
for (const romMatches of [true, false]) {
  test(`sha256-only rom.checks are computed and verified (${romMatches ? "matching" : "wrong"} ROM)`, async () => {
    const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
    const sha256 = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", await romFile.arrayBuffer())));
    const weaveArchive = await buildWeaveArchive(
      {
        output: { name: "sha256-output" },
        patchBasis: "auto",
        patches: [{ name: "Core", path: patchFile.name }],
        rom: { checks: { checksums: { sha256: romMatches ? sha256 : "0".repeat(64) } }, name: "game.bin" },
        version: 2,
      },
      [patchFile],
    );
    await expectStrictApply([weaveArchive, romFile], { outputName: "sha256-output", romMatches });
  });
}

// A member-lane weave: rom.member names the disc track the weave's ROM checks describe.
for (const romMatches of [true, false]) {
  test(`member-lane weave verifies rom.checks on rom.member (${romMatches ? "matching" : "wrong"} ROM)`, async () => {
    const trackOneName = "member-lane-track01.bin";
    const trackTwoName = "member-lane-track02.bin";
    const trackOne = noiseBytes(2352 * 40, 0x01);
    const trackTwo = noiseBytes(2352 * 40, 0x02);
    const cue = new File(
      [
        `FILE "${trackOneName}" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n` +
          `FILE "${trackTwoName}" BINARY\n  TRACK 02 MODE1/2352\n    INDEX 01 00:00:00\n`,
      ],
      "member-lane.cue",
      { type: "application/x-cue" },
    );
    const patchFile = new File([createIps([[0, 0xd4]])], "track.ips");
    const target = { member: trackTwoName, rom: true };
    // The weave bundles the disc as one ROM archive. The wrong case declares track 1's checks for
    // track 2, as a weave made from another disc would.
    const disc = await buildZip(
      [
        { file: cue, fileName: cue.name },
        { file: new File([trackOne], trackOneName), fileName: trackOneName },
        { file: new File([trackTwo], trackTwoName), fileName: trackTwoName },
      ],
      "member-lane.zip",
    );
    const weaveArchive = await buildWeaveArchive(
      {
        output: { name: "member-lane-output" },
        patchBasis: "auto",
        patches: [{ name: "Track", path: patchFile.name, target }],
        rom: {
          checks: await fileChecks(romMatches ? trackTwo : trackOne),
          member: trackTwoName,
          name: disc.name,
          path: disc.name,
        },
        version: 2,
      },
      [patchFile, disc],
    );
    await expectStrictApply([weaveArchive], { outputName: "member-lane-output", romMatches });
  });
}

test("archive whose index is named rw.json (not canonical) is content-probed and seeds enablement", async () => {
  // A pre-rename weave: its index is `rw.json`, not `rom-weaver-weave.json`.
  // Detection must fall back to content-probing so it still auto-selects. A
  // decoy `metadata.json` that is not a weave sits alongside to prove the
  // probe is gated on a successful parse, not on the `.json` extension.
  const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
  const alternateFile = new File([await patchFile.arrayBuffer()], "alternate.ips", {
    type: "application/octet-stream",
  });
  const legacyIndex = {
    output: { name: "bundled-output" },
    patches: [
      { name: "Core", path: "change.ips" },
      { name: "Alternate", optional: true, path: "alternate.ips" },
    ],
    rom: { checks: { checksums: { crc32: "c6fb1252" } }, name: "game.bin" },
    version: 1,
  };
  const decoy = new File([JSON.stringify({ title: "not a weave" })], "metadata.json", { type: "application/json" });
  const indexFile = new File([JSON.stringify(legacyIndex)], "rw.json", { type: "application/json" });
  const weaveArchive = await buildZip(
    [
      { file: decoy, fileName: "metadata.json" },
      { file: indexFile, fileName: "rw.json" },
      { file: patchFile, fileName: "change.ips" },
      { file: alternateFile, fileName: "alternate.ips" },
    ],
    "legacy-rw.zip",
  );

  mount(createElement(ApplyPatchForm, { pageDrop: { files: [weaveArchive, romFile], id: 1 } }));

  await expect.poll(() => getPatchStackFileNames(), { timeout: 30000 }).toEqual(["change.ips", "alternate.ips"]);
  await expect.poll(() => getPatchToggles().length, { timeout: 30000 }).toBe(2);
  await expect.poll(() => getPatchToggles().map((toggle) => toggle.checked), { timeout: 30000 }).toEqual([true, false]);
});

test("local v2 weave keeps a per-patch input override", async () => {
  const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
  const weaveFile = new File(
    [
      JSON.stringify({
        patchBasis: "base",
        patches: [{ basis: "previous", path: patchFile.name }],
        rom: { path: romFile.name },
        version: 2,
      }),
    ],
    "rom-weaver-weave.json",
    { type: "application/json" },
  );

  const loaded = await loadLocalWeaveSession(weaveFile, [romFile, patchFile]);
  try {
    expect(loaded.session.patchBasis).toBe("base");
    expect(loaded.session.entries[0]?.basis).toBe("previous");
  } finally {
    await loaded.cleanup();
  }
});

test("local weave remote sources remain live until the workflow owner is disposed", async () => {
  const truncateSpy = vi.spyOn(browserVfs, "truncate");
  const weaveFile = new File(
    [
      JSON.stringify({
        patches: [{ name: "Core", url: `${location.origin}/${RAW_PATCH}` }],
        rom: { url: `${location.origin}/${RAW_ROM}` },
        version: 1,
      }),
    ],
    "rom-weaver-weave.json",
    { type: "application/json" },
  );
  try {
    mount(createElement(ApplyPatchForm, { pageDrop: { files: [weaveFile], id: 1 } }));
    await expect.poll(() => getPatchStackFileNames(), { timeout: 30000 }).toEqual(["change.ips"]);
    await waitForApplyButtonEnabled();
    const remotePaths = truncateSpy.mock.calls
      .map(([filePath]) => filePath)
      .filter((filePath) => filePath.includes("/remote-fetch/"));
    expect(remotePaths).toHaveLength(2);
    expect(await Promise.all(remotePaths.map((filePath) => browserVfs.stat(filePath)))).not.toContain(null);

    mount(createElement("div"));
    await expect
      .poll(async () => Promise.all(remotePaths.map((filePath) => browserVfs.stat(filePath))))
      .toEqual([null, null]);
  } finally {
    truncateSpy.mockRestore();
  }
});

test("local weave cleans acquired remote siblings when another source fails", async () => {
  const originalFetch = globalThis.fetch;
  const truncateSpy = vi.spyOn(browserVfs, "truncate");
  const missingPatchUrl = `${location.origin}/virtual/missing.ips`;
  const slowPatchUrl = `${location.origin}/virtual/slow.ips`;
  let slowPatchAborted = false;
  const weaveFile = new File(
    [
      JSON.stringify({
        patches: [
          { name: "Core", url: `${location.origin}/${RAW_PATCH}` },
          { name: "Missing", url: missingPatchUrl },
          { name: "Slow", url: slowPatchUrl },
        ],
        rom: { url: `${location.origin}/${RAW_ROM}` },
        version: 1,
      }),
    ],
    "rom-weaver-weave.json",
    { type: "application/json" },
  );
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input?.url || String(input);
    if (url === missingPatchUrl) {
      return new Promise((resolve) => setTimeout(() => resolve(new Response("missing", { status: 404 })), 25));
    }
    if (url === slowPatchUrl) {
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
              init?.signal?.addEventListener(
                "abort",
                () => {
                  slowPatchAborted = true;
                  controller.error(new DOMException("download aborted", "AbortError"));
                },
                { once: true },
              );
            },
          }),
        ),
      );
    }
    if (url === `${location.origin}/${RAW_ROM}` || url === `${location.origin}/${RAW_PATCH}`) {
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3])));
    }
    return originalFetch(input, init);
  };
  try {
    const error = await loadLocalWeaveSession(weaveFile, []).catch((reason) => reason);
    expect(error).toMatchObject({ kind: "http", status: 404 });
    expect(slowPatchAborted).toBe(true);

    const remotePaths = truncateSpy.mock.calls
      .map(([filePath]) => filePath)
      .filter((filePath) => filePath.includes("/remote-fetch/"));
    expect(remotePaths).toHaveLength(3);
    await expect
      .poll(async () => Promise.all(remotePaths.map((filePath) => browserVfs.stat(filePath))))
      .toEqual([null, null, null]);
  } finally {
    globalThis.fetch = originalFetch;
    truncateSpy.mockRestore();
  }
});

test("local weave cancellation aborts active remote acquisition and removes its partial OPFS file", async () => {
  const originalFetch = globalThis.fetch;
  const truncateSpy = vi.spyOn(browserVfs, "truncate");
  const controller = new AbortController();
  const remoteRomUrl = `${location.origin}/virtual/never-finishes.bin`;
  let fetchStarted = false;
  const weaveFile = new File(
    [JSON.stringify({ patches: [{ path: "change.ips" }], rom: { url: remoteRomUrl }, version: 1 })],
    "rom-weaver-weave.json",
    { type: "application/json" },
  );
  const localPatch = new File([new Uint8Array([1])], "change.ips");
  globalThis.fetch = (_input, init) =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(streamController) {
            fetchStarted = true;
            streamController.enqueue(new Uint8Array([1, 2, 3]));
            init?.signal?.addEventListener(
              "abort",
              () => streamController.error(new DOMException("download aborted", "AbortError")),
              { once: true },
            );
          },
        }),
      ),
    );
  try {
    const loading = loadLocalWeaveSession(weaveFile, [localPatch], { signal: controller.signal }).catch(
      (reason) => reason,
    );
    await expect.poll(() => fetchStarted, { timeout: 30000 }).toBe(true);
    controller.abort();
    const error = await loading;
    expect(error).toMatchObject({ kind: "aborted" });

    const remotePaths = truncateSpy.mock.calls
      .map(([filePath]) => filePath)
      .filter((filePath) => filePath.includes("/remote-fetch/"));
    expect(remotePaths).toHaveLength(1);
    await expect.poll(async () => browserVfs.stat(remotePaths[0])).toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
    truncateSpy.mockRestore();
  }
});

test("weave url session seeds enablement + output defaults and applies to a download", async () => {
  // The REAL boot flow: fetch → wasm weave parse → plan → source acquisition (same code the
  // use-url-session-boot hook runs).
  const { cleanup, files, session } = await withWeaveFetchStub(WEAVE_JSON, () => loadWeaveUrlSession(WEAVE_URL));
  expect(files.map((file) => file.name)).toEqual(["game.bin", "change.ips", "alternate.ips"]);
  // The display name derives from the output naming now that weaves carry no name field.
  expect(session.name).toBe("weave-output");
  expect(session.entries.map((entry) => entry.optional)).toEqual([false, true]);
  expect(session.outputDefaults).toEqual({ name: "weave-output" });

  // Deliver exactly like WebappRoot does: one pageDrop plus the decorated session prop.
  mount(
    createElement(ApplyPatchForm, {
      weaveSession: session,
      pageDrop: { files, id: 1 },
    }),
  );

  // Patches land in weave order.
  await expect.poll(() => getPatchStackFileNames(), { timeout: 30000 }).toEqual(["change.ips", "alternate.ips"]);
  await expect.poll(() => getPatchToggles().length, { timeout: 30000 }).toBe(2);
  // Default-on patch stays toggleable.
  await expect.poll(() => getPatchToggles()[0]?.disabled, { timeout: 30000 }).toBe(false);
  expect(getPatchToggles()[0]?.checked).toBe(true);
  // Default-off patch starts Off and stays toggleable.
  await expect.poll(() => getPatchToggles()[1]?.checked, { timeout: 30000 }).toBe(false);
  expect(getPatchToggles()[1]?.disabled).toBe(false);
  getPatchToggles()[1]?.click();
  await expect.poll(() => getPatchToggles()[1]?.checked).toBe(true);
  getPatchToggles()[1]?.click();
  await expect.poll(() => getPatchToggles()[1]?.checked).toBe(false);
  // Weave metadata reaches the patch cards; the plain view shows the weave
  // description as static card text.
  const patchStackText = () => document.getElementById("rom-weaver-list-patch-stack")?.textContent || "";
  expect(patchStackText()).toContain("stable");
  expect(document.getElementById("rom-weaver-patch-card-description-0")?.textContent).toBe("Required core patch");
  // The pencil on the patch card swaps the static description for the inline
  // editable fields.
  document.getElementById("rom-weaver-patch-meta-edit-0")?.click();
  const descriptionInput = await waitForState(() => document.getElementById("rom-weaver-patch-description-0"));
  expect(descriptionInput?.value).toBe("Required core patch");
  expect(descriptionInput?.tagName).toBe("TEXTAREA");
  expect(document.querySelector(".weave-banner")).toBeNull();
  expect(document.getElementById("rom-weaver-patch-card-description-0")).toBeNull();
  // Output defaults applied once through the output controller.
  await expect.poll(() => getOutputFileNameValue(), { timeout: 30000 }).toBe("weave-output");

  await waitForApplyButtonEnabled();
  await clickApplyButton();
  const outcome = await waitForApplyOutcome();
  expect(outcome).toEqual({ kind: "download" });
  await cleanup();
});

test("a rom extracted from the weave archive shows the weave -> rom extract chain", async () => {
  // A ROM shipped inside the weave archive is pulled out out-of-band by the weave parse, so it reaches
  // the ROM card as a bare file. It must still render the same "Extract" section (weave archive -> rom)
  // a ROM dropped inside a plain archive shows, rather than appearing as a chainless input.
  const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
  const romInWeave = new File([await romFile.arrayBuffer()], "game.bin", { type: "application/octet-stream" });
  const weaveJson = {
    output: { name: "bundled-output" },
    patches: [{ name: "Core", path: "change.ips" }],
    rom: { path: "game.bin" },
    version: 1,
  };
  const weaveFile = new File([JSON.stringify(weaveJson)], "rom-weaver-weave.json", { type: "application/json" });
  const weaveArchive = await buildZip(
    [
      { file: weaveFile, fileName: "rom-weaver-weave.json" },
      { file: romInWeave, fileName: "game.bin" },
      { file: patchFile, fileName: "change.ips" },
    ],
    "with-rom.zip",
  );

  mount(createElement(ApplyPatchForm, { pageDrop: { files: [weaveArchive], id: 1 } }));

  const extractTreeNames = (listId) => () => {
    const drawer = document.querySelector(`#${listId} .card.file .extract-d`);
    if (!drawer) return null;
    return Array.from(drawer.querySelectorAll(".tree-name")).map((node) => node.textContent || "");
  };
  // The ROM extracted from the weave archive shows the full weave -> rom chain.
  await expect
    .poll(extractTreeNames("rom-weaver-list-input-stack"), { timeout: 30000 })
    .toEqual(expect.arrayContaining([expect.stringContaining("with-rom.zip"), expect.stringContaining("game.bin")]));
  // A patch extracted from the same weave archive keeps the parent breadcrumb, not just its bare leaf.
  await expect
    .poll(extractTreeNames("rom-weaver-list-patch-stack"), { timeout: 30000 })
    .toEqual(expect.arrayContaining([expect.stringContaining("with-rom.zip"), expect.stringContaining("change.ips")]));
});
