import { createElement } from "react";
import { expect, vi } from "vitest";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import {
  clickApplyButton,
  getOutputFileNameValue,
  loadFixtureFile,
  mount,
  RAW_PATCH,
  RAW_ROM,
  setFormControlValue,
  waitForApplyButtonEnabled,
  waitForApplyOutcome,
  waitForState,
} from "./patcher-test-shared.js";

const ALTERNATE_PATCH = "tests/fixtures/archive_sources/multi-patch/alternate.ips";

export const WEAVE_URL = `${location.origin}/virtual/weave/rom-weaver-weave.json`;

// The weave's sources are real same-origin fixture URLs (only the rom-weaver-weave.json itself is virtual, so
// fetch is stubbed for that one URL and passed through for everything else).
export const WEAVE_JSON = {
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

export const withWeaveFetchStub = async (weave, run) => {
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

export const getPatchToggles = () =>
  Array.from(document.querySelectorAll("#rom-weaver-list-patch-stack .patch-enable input"));

// Pack files into a zip through the real compression runtime (what a patch
// distributor would publish as a without-ROM weave).
export const buildZip = async (entries, outputName) => {
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

export const createIpsPatch = (fileName, offset, value) => {
  const bytes = new Uint8Array(14);
  bytes.set(new TextEncoder().encode("PATCH"));
  bytes.set([(offset >>> 16) & 0xff, (offset >>> 8) & 0xff, offset & 0xff, 0, 1, value], 5);
  bytes.set(new TextEncoder().encode("EOF"), 11);
  return new File([bytes], fileName, { type: "application/octet-stream" });
};

// RAW_ROM (game.bin) is 13 bytes: crc32 c6fb1252, sha1 1d73a56886d4cd676b771bca857cf64b227e3677.
export const RAW_ROM_CHECKS = {
  checksums: { crc32: "c6fb1252", sha1: "1d73a56886d4cd676b771bca857cf64b227e3677" },
  size: 13,
};

export const buildExpectedRomWeave = async (checks, patchFile) => {
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

// The guided Apply sample (first-weave.zip): a headered NES ROM whose weave declares `basis: base`
// on both patches and full rom.checks including size. The IPS bytes match the shipped sample.
export const SAMPLE_ROM = "tests/fixtures/cheats/hello-world.nes";

export const SAMPLE_ROM_CHECKS = {
  checksums: {
    crc32: "3e30b9b3",
    md5: "df0e55e0f744b2d9734ef90e4454aa8f",
    sha1: "22f56591eb4dbb85fbb6398cd0c4554558f70603",
  },
  size: 24592,
};

export const ipsFile = (fileName, bytes) =>
  new File([new Uint8Array(bytes)], fileName, { type: "application/octet-stream" });

export const IPS_EOF = [0x45, 0x4f, 0x46];

export const IPS_HEADER = [0x50, 0x41, 0x54, 0x43, 0x48];

const SAMPLE_PATCHES = [
  ipsFile("hello-to-rom.ips", [...IPS_HEADER, 0, 0, 0xa8, 0, 5, 0x12, 0x0f, 0x0d, 0, 0, ...IPS_EOF]),
  ipsFile("world-to-weaver.ips", [...IPS_HEADER, 0, 0, 0xaf, 0, 5, 0x05, 0x01, 0x16, 0x05, 0x12, ...IPS_EOF]),
];

export const buildSampleWeave = async ({ outputName = "rom-weaver.nes", outputChecks, patches } = {}) => {
  const weaveFile = new File(
    [
      JSON.stringify({
        output: { ...(outputChecks ? { checks: outputChecks } : {}), name: outputName },
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
export const loadWrongSampleRom = async () => {
  const bytes = new Uint8Array(await (await loadFixtureFile(SAMPLE_ROM)).arrayBuffer());
  bytes[0x2000] ^= 0xff;
  return new File([bytes], "hello-world.nes", { type: "application/octet-stream" });
};

export const getChecksumOverride = () => {
  const checkbox = document.getElementById("rom-weaver-checkbox-checksum-override");
  return checkbox instanceof HTMLInputElement ? checkbox : null;
};

export const mountStrict = (files) =>
  mount(
    createElement(ApplyPatchForm, {
      defaultSettings: { validation: { requireInputChecksumMatch: true } },
      pageDrop: { files, id: 1 },
    }),
  );

// Woven output of the two sample patches (scripts/first-sample-assets.mjs `wovenRom`).
export const SAMPLE_WOVEN_SHA256 = "7ac8001dcbcbff45cd5cebb5b0655192021fbbdf27533aa961347194ab3e836e";

export const sha256Hex = async (blob) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

/** Records each download anchor's file name with the blob its object URL points at. */
export const captureDownloads = () => {
  const blobsByUrl = new Map();
  const createObjectUrl = URL.createObjectURL.bind(URL);
  const urlSpy = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    const url = createObjectUrl(blob);
    blobsByUrl.set(url, blob);
    return url;
  });
  // Calls through; `mock.contexts` holds each clicked anchor.
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click");
  return {
    getDownloads: () =>
      clickSpy.mock.contexts
        .filter((anchor) => anchor.download)
        .map((anchor) => ({ blob: blobsByUrl.get(anchor.href), name: anchor.download })),
    restore: () => {
      clickSpy.mockRestore();
      urlSpy.mockRestore();
    },
  };
};

export const buildFinalCheckWeave = async ({ outputChecks, romChecks = { crc32: "c6fb1252" }, patches, files }) =>
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

export const mountWeaveWithCapture = async (element, files) => {
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

export const applyDottedSampleWeave = async ({
  compression,
  typedName,
  weaveOutputName = "Practice 3.5.1.nes",
  expectedFieldName = "Practice 3.5.1",
}) => {
  const capture = captureDownloads();
  try {
    const [weaveArchive, romFile] = await Promise.all([
      buildSampleWeave({ outputName: weaveOutputName }),
      loadFixtureFile(SAMPLE_ROM),
    ]);
    mount(
      createElement(ApplyPatchForm, {
        defaultSettings: { output: { compression } },
        pageDrop: { files: [weaveArchive, romFile], id: 1 },
      }),
    );
    // The name field carries the stem; the manifest's `.nes` belongs to the format.
    await expect.poll(() => getOutputFileNameValue(), { timeout: 30000 }).toBe(expectedFieldName);
    if (typedName) setFormControlValue(document.getElementById("rom-weaver-input-output-file-name"), typedName);
    await waitForApplyButtonEnabled();
    await clickApplyButton();
    const outcome = await waitForApplyOutcome();
    expect(outcome?.kind, outcome && "errorText" in outcome ? outcome.errorText : "").toBe("download");
    await expect.poll(() => capture.getDownloads().length, { timeout: 30000 }).toBeGreaterThan(0);
    return capture.getDownloads().at(-1);
  } finally {
    capture.restore();
  }
};

// The weave's rom.checks follow the bench like its output checks: once the patch list diverges
// from the weave they stand down, and they apply again when it matches the weave.
export const movePatchToPosition = async (position) => {
  document.querySelector("#rom-weaver-list-patch-stack .handle")?.click();
  const positionInput = await waitForState(
    () => document.querySelector("#rom-weaver-list-patch-stack .phandle-input"),
    30000,
  );
  setFormControlValue(positionInput, String(position));
  positionInput.blur();
};

// Mount a strict form, then drop `files` onto the bench it already holds.
export const dropOntoBench = (root, files) =>
  root.render(
    createElement(
      RomWeaverSettingsProvider,
      { settings: { detailedViewEnabled: true } },
      createElement(ApplyPatchForm, {
        defaultSettings: { validation: { requireInputChecksumMatch: true } },
        pageDrop: { files, id: 2 },
      }),
    ),
  );

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

export const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const fileChecks = async (bytes) => ({
  checksums: {
    crc32: crc32(bytes).toString(16).padStart(8, "0"),
    sha1: hex(new Uint8Array(await crypto.subtle.digest("SHA-1", bytes))),
  },
  size: bytes.length,
});

// Deterministic pseudo-random bytes (xorshift32), so the ROM has no accidental structure.
export const noiseBytes = (length, seed) => {
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

export const withBytes = (source, offset, replacement) => {
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
export const createBps = (source, target) => {
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
export const createIps = (records) =>
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

export const applyRecords = (source, records) => {
  const bytes = new Uint8Array(source);
  for (const [offset, value] of records) bytes[offset] = value;
  return bytes;
};

// A LoROM internal header ("TEST GAME", map mode 0x20, 1 MiB) at 0x7fc0 of the headerless image.
export const SNES_INTERNAL_HEADER = [
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

export const byteSwap16 = (source) => {
  const bytes = new Uint8Array(source.length);
  for (let index = 0; index + 1 < source.length; index += 2) {
    bytes[index] = source[index + 1];
    bytes[index + 1] = source[index];
  }
  return bytes;
};

export const buildTransformWeave = async (romChecks, patchName, patchBytes, romName) => {
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
export const applyWeaveAndReadOutput = async (files) => {
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

export const buildWeaveArchive = async (weave, patchFiles) =>
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

// A patch's own source checks, of any algorithm, decide its layout even when rom.checks match only
// the header-stripped ROM: declared inputChecks, or a checksum embedded in the patch (a RUP's MD5).
export const applyOwnEvidenceWeave = async (patchEntry, patchFile, headered) => {
  const weaveArchive = await buildWeaveArchive(
    {
      output: { name: "transform-output" },
      patches: [{ name: "Hack", path: patchFile.name, ...patchEntry }],
      rom: { checks: await fileChecks(headered.subarray(16)), name: "hello-world.nes" },
      version: 1,
    },
    [patchFile],
  );
  return applyWeaveAndReadOutput([weaveArchive, new File([headered], "hello-world.nes")]);
};

// Apply under strict validation: a matching ROM applies with no override; a wrong one shows the
// override and reaches the engine only once it is checked.
export const expectStrictApply = async (files, { outputName, romMatches }) => {
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

// `weave create --checksum sha256` from the headerless or big-endian ROM: staging hashes no SHA-256,
// so the header-stripped and byte-swapped variants are hashed on demand, once per file.
export const sha256Checks = async (bytes) => ({
  checksums: { sha256: hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))) },
  size: bytes.length,
});

export const withSha256HashCount = async (run) => {
  const original = browserRuntime.ingest.run;
  const ingestSpy = vi
    .spyOn(browserRuntime.ingest, "run")
    .mockImplementation((input) => original.call(browserRuntime.ingest, input));
  try {
    const result = await run();
    return {
      result,
      sha256Hashes: ingestSpy.mock.calls.filter(([input]) => input.checksumAlgorithms?.join(",") === "sha256").length,
    };
  } finally {
    ingestSpy.mockRestore();
  }
};
