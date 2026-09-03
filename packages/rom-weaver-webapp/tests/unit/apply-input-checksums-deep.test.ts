import { describe, expect, it, vi } from "vitest";
import { finalizeApplyInputChecksums } from "../../src/lib/workflow/apply-input-checksums.ts";

const file = (fileName: string, extras: Record<string, unknown> = {}) =>
  ({
    _sourceRef: { fileName, size: 8, source: `/work/${fileName}` },
    fileName,
    fileSize: 8,
    ...extras,
  }) as never;

const asset = (id: string, inputFile: unknown, extras: Record<string, unknown> = {}) => ({
  file: inputFile,
  fileName: `${id}.sfc`,
  id,
  kind: "rom",
  patchable: true,
  size: 8,
  ...extras,
});

const state = (id: string, status: string = "ready") => ({
  candidates: [],
  fileName: `${id}.zip`,
  id,
  order: 0,
  parentCompressions: [{ depth: 0, fileName: "outer.zip", kind: "archive" }],
  role: "input",
  sourceSize: 18,
  status,
  warnings: [],
  wasDecompressed: true,
});

const adapters = (runtime: unknown, selected: unknown, synthetic = false) => ({
  emitProgress: vi.fn(),
  getSelectedInputOwner: vi.fn(() => selected),
  runtime,
  settings: { logging: { level: "debug", sink: vi.fn() } },
  syncInputSessionView: vi.fn(),
  workflowId: synthetic ? "apply-synthetic" : "apply",
});

describe("apply input checksum finalization", () => {
  it("reuses precomputed metadata and checksums each remaining ROM asset", async () => {
    const precomputedFile = file("precomputed.sfc", {
      _precomputedChecksumMs: 7,
      checksums: { crc32: " A1B2C3D4 ", md5: "00112233445566778899AABBCCDDEEFF", sha1: "abc" },
      checksumVariants: [{ checksums: { crc32: "variant" }, id: "raw", label: "Raw", transforms: { trim: true } }],
      identification: { matches: [{ name: "Demo" }], status: "identified" },
      romType: { platform: "SNES", recommendedFormat: "sfc" },
    });
    const calculatedFile = file("calculated.sfc");
    const cueFile = file("disc.cue");
    const calculated = asset("calculated", calculatedFile, {
      preparation: {
        decompressionTimeMs: 4,
        parentCompressions: [{ depth: 2, fileName: "inner.7z", kind: "archive" }],
        sourceSize: 21,
        wasDecompressed: false,
      },
    });
    const first = asset("precomputed", precomputedFile, { patchable: false });
    const cue = { ...asset("cue", cueFile), kind: "cue", patchable: false };
    const ingest = vi.fn(async (input: Record<string, unknown>) => {
      (input.onProgress as (progress: Record<string, unknown>) => void)({ label: "Hashing", percent: 25 });
      return {
        identifyUnavailable: "database unavailable",
        result: {
          assets: [
            {
              checksums: { crc32: "D4C3B2A1", md5: "FFEEDDCCBBAA99887766554433221100", sha1: "DEF" },
              checksumVariants: [{ checksums: { crc32: "other" }, id: "other", label: "Other" }],
              isRom: true,
              platform: "Nintendo",
              recommendedFormat: "sfc",
            },
          ],
          isRom: true,
        },
      };
    });
    const selected = { parentCompressions: [], preparedInputAssets: [first, calculated, cue], state: state("source") };
    const session = { stages: [selected], synthetic: false, view: selected };
    const progress = adapters({ ingest: { run: ingest } }, selected);

    await expect(finalizeApplyInputChecksums(session as never, progress as never)).resolves.toBe(true);

    expect(first.checksums).toEqual({ crc32: "a1b2c3d4", md5: "00112233445566778899aabbccddeeff", sha1: "abc" });
    expect(first.checksumTimeMs).toBe(7);
    expect(first.checksumVariants).toEqual([
      { checksums: { crc32: "variant" }, id: "raw", label: "Raw", transforms: { trim: true } },
    ]);
    expect(calculated).toMatchObject({
      checksums: { crc32: "d4c3b2a1", md5: "ffeeddccbbaa99887766554433221100", sha1: "def" },
      checksumTimeMs: expect.any(Number),
      identification: { matches: [], status: "unavailable" },
      romType: { platform: "Nintendo", recommendedFormat: "sfc" },
    });
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        checksumAlgorithms: ["crc32", "md5", "sha1"],
        fileName: "calculated.sfc",
        source: { fileName: "calculated.sfc", size: 8, source: "/work/calculated.sfc" },
      }),
    );
    expect(ingest.mock.calls[0]?.[0]).toMatchObject({
      onLog: progress.settings.logging.sink,
    });
    expect(progress.emitProgress).toHaveBeenCalledWith(expect.objectContaining({ stage: "checksum", percent: null }));
    expect(progress.emitProgress).toHaveBeenCalledWith(expect.objectContaining({ label: "Hashing", percent: 25 }));
    expect(selected.state).toMatchObject({
      checksums: calculated.checksums,
      checksumTimeMs: calculated.checksumTimeMs,
      identification: { matches: [], status: "unavailable" },
      romType: calculated.romType,
    });
  });

  it("checks every stage in a synthetic session and synchronizes its view", async () => {
    const firstFile = file("one.sfc", { checksums: { crc32: "1", md5: "2", sha1: "3" } });
    const secondFile = file("two.sfc", { checksums: { crc32: "4", md5: "5", sha1: "6" } });
    const first = { parentCompressions: [], preparedInputAssets: [asset("one", firstFile)], state: state("one") };
    const second = { parentCompressions: [], preparedInputAssets: [asset("two", secondFile)], state: state("two") };
    const selected = { ...second, state: { ...second.state, status: "ready" } };
    const progress = adapters({}, selected, true);
    const session = { stages: [first, second], synthetic: true, view: selected };

    await expect(finalizeApplyInputChecksums(session as never, progress as never)).resolves.toBe(true);

    expect(first.state).toMatchObject({ checksums: first.preparedInputAssets[0].checksums, checksumTimeMs: 0 });
    expect(second.state).toMatchObject({ checksums: second.preparedInputAssets[0].checksums, checksumTimeMs: 0 });
    expect(progress.syncInputSessionView).toHaveBeenCalledOnce();
  });

  it("returns false when there is no session or no ready selected source", async () => {
    const progress = adapters({}, undefined);
    await expect(finalizeApplyInputChecksums(undefined, progress as never)).resolves.toBe(false);

    const notReady = { parentCompressions: [], preparedInputAssets: [], state: state("pending", "pending") };
    const session = { stages: [notReady], synthetic: false, view: notReady };
    const pending = adapters({}, notReady);
    await expect(finalizeApplyInputChecksums(session as never, pending as never)).resolves.toBe(false);
    expect(pending.syncInputSessionView).not.toHaveBeenCalled();
  });
});
