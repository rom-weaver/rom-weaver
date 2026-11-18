import { createElement } from "react";
import { expect, vi } from "vitest";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import {
  clickApplyButton,
  getOutputFileNameValue,
  loadFixtureFile,
  mount,
  waitForApplyButtonEnabled,
  waitForApplyOutcome,
  waitForState,
} from "./patcher-test-shared.js";

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

// RAW_ROM (game.bin) is 13 bytes: crc32 c6fb1252, sha1 1d73a56886d4cd676b771bca857cf64b227e3677.
export const RAW_ROM_CHECKS = {
  checksums: { crc32: "c6fb1252", sha1: "1d73a56886d4cd676b771bca857cf64b227e3677" },
  size: 13,
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
