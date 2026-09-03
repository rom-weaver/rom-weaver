import { describe, expect, it, vi } from "vitest";
import { parseBundleCreateResult, parseBundleParseResult } from "../../src/lib/runtime/bundle-result.ts";
import {
  assignApplyPatchTarget,
  clearApplyPatchTarget,
  composeApplyPatchValidationKey,
  evaluateApplyPatchReadiness,
} from "../../src/lib/workflow/apply-patch-readiness-state-machine.ts";

describe("bundle result parsing", () => {
  it("coerces the complete bundle parse wire shape", () => {
    const result = parseBundleParseResult({
      bundle: {
        bundle: {
          output: {
            checks: { checksums: { CRC32: "out-crc", empty: "" }, size: 99 },
            header: "strip",
            name: "Patched Game",
          },
          patches: [
            {
              author: "Author",
              basis: "base",
              description: "Description",
              header: "keep",
              id: "fix-1",
              inputChecks: { checksums: { MD5: "in-md5" }, size: 10 },
              label: "stable",
              name: "Fix",
              optional: true,
              outputChecks: { checksums: { SHA1: "out-sha" }, size: 11 },
              path: "patches/fix.ips",
              url: "https://example.com/fix.ips",
              version: "1.2.3",
            },
          ],
          rom: {
            checks: { checksums: { CRC32: "rom-crc" }, size: 10 },
            name: "Game.bin",
            path: "roms/Game.bin",
            url: "https://example.com/Game.bin",
          },
          version: 1,
        },
        archive_member: "rom-weaver-bundle.json",
        patch_sources: [
          {
            descriptor: {
              file_name: "fix.ips",
              filename_checksums: { CRC32: "patch-crc" },
              filename_size: 8,
              format: "ips",
              is_valid_patch: true,
              leaf_path: "patches/fix.ips",
              minimum_source_size: 10,
              patch_crc32: 123,
              record_count: 2,
              sidecar_order: 1,
              size_bytes: 4,
              source_checksum_variants: [{ CRC32: "source-crc" }, { empty: "" }],
              source_size: 10,
              target_crc32: 456,
              target_size: 11,
            },
            source: { extracted_path: "/work/patches/fix.ips" },
          },
          { source: { path: "patches/other.ips" } },
          { source: { url: "https://example.com/other.ips" } },
          { source: { path: "" } },
        ],
        rom_source: { path: "roms/Game.bin" },
        source_kind: "archive",
        warnings: ["warning", "", null, 0],
      },
    });
    expect(result).toEqual({
      archiveMember: "rom-weaver-bundle.json",
      bundle: {
        output: {
          checks: { checksums: { crc32: "out-crc" }, size: 99 },
          header: "strip",
          name: "Patched Game",
        },
        patches: [
          {
            author: "Author",
            basis: "base",
            description: "Description",
            header: "keep",
            id: "fix-1",
            inputChecks: { checksums: { md5: "in-md5" }, size: 10 },
            label: "stable",
            name: "Fix",
            optional: true,
            outputChecks: { checksums: { sha1: "out-sha" }, size: 11 },
            path: "patches/fix.ips",
            url: "https://example.com/fix.ips",
            version: "1.2.3",
          },
        ],
        rom: {
          checks: { checksums: { crc32: "rom-crc" }, size: 10 },
          name: "Game.bin",
          path: "roms/Game.bin",
          url: "https://example.com/Game.bin",
        },
        version: 1,
      },
      patchSources: [
        {
          descriptor: {
            fileName: "fix.ips",
            filenameChecksums: { crc32: "patch-crc" },
            filenameSize: 8,
            format: "ips",
            isValidPatch: true,
            leafPath: "patches/fix.ips",
            minimumSourceSize: 10,
            patchCrc32: 123,
            recordCount: 2,
            sidecarOrder: 1,
            sizeBytes: 4,
            sourceChecksumVariants: [{ crc32: "source-crc" }],
            sourceSize: 10,
            targetCrc32: 456,
            targetSize: 11,
          },
          source: { extractedPath: "/work/patches/fix.ips", kind: "extracted" },
        },
        { source: { path: "patches/other.ips", kind: "path" } },
        { source: { kind: "url", url: "https://example.com/other.ips" } },
      ],
      romSource: { kind: "path", path: "roms/Game.bin" },
      sourceKind: "archive",
      warnings: ["warning"],
    });
  });

  it("parses bundle creation results and rejects malformed boundaries", () => {
    expect(
      parseBundleCreateResult({
        bundle_create: {
          archive_path: "bundle.zip",
          bundle_path: "rom-weaver-bundle.json",
          bundle: { patches: [], version: 2n },
          warnings: ["created"],
        },
      }),
    ).toEqual({
      bundle: { patches: [], version: 2 },
      bundlePath: "rom-weaver-bundle.json",
      archivePath: "bundle.zip",
      warnings: ["created"],
    });
    expect(parseBundleParseResult(undefined)).toBeUndefined();
    expect(parseBundleParseResult({ bundle: {} })).toBeUndefined();
    expect(parseBundleCreateResult({ bundle_create: { bundle_path: "", bundle: { version: 1 } } })).toBeUndefined();
    expect(parseBundleCreateResult({})).toBeUndefined();
  });
});

type Stage = {
  preparedPatchFile?: { fileName: string; fileSize: number };
  parsedPatch?: unknown;
  state: Record<string, unknown>;
};

const stage = (overrides: Partial<Stage["state"]> = {}): Stage => ({
  preparedPatchFile: { fileName: "fix.ips", fileSize: 4 },
  parsedPatch: { format: "ips" },
  state: {
    candidates: [],
    id: "patch-1",
    selectedCandidateId: "candidate-1",
    status: "ready",
    warnings: [],
    ...overrides,
  },
});

const asset = (id: string, fileName = "game.bin", size = 10) => ({
  checksums: { crc32: "a1b2c3d4" },
  file: { filePath: `/work/${fileName}` },
  fileName,
  id,
  kind: "rom",
  patchable: true,
  size,
});

const adapters = (assets: unknown[] = []) => ({
  getPatchableInputAssets: () => assets,
  notifyAwaitingInputTarget: vi.fn(),
  parsePatch: vi.fn(async () => undefined),
  prepareSelectedSource: vi.fn(async () => undefined),
  pushWarning: vi.fn(),
});

describe("apply patch readiness state machine", () => {
  it("assigns and clears target state and composes chain keys", () => {
    const current = stage({ checksumTimeMs: 2, targetInputId: "old", targetInputFileName: "old.bin" });
    const target = asset("new", "new.bin");
    assignApplyPatchTarget(current as never, target as never);
    expect(current.state).toMatchObject({ targetInputId: "new", targetInputFileName: "new.bin" });
    clearApplyPatchTarget(current as never);
    expect(current.state).toMatchObject({
      checksumTimeMs: undefined,
      targetInputId: undefined,
      targetInputFileName: undefined,
      checksumPreflight: undefined,
      patchValidation: undefined,
      headerResolution: undefined,
      n64Resolution: undefined,
    });
    expect(composeApplyPatchValidationKey("base")).toBe("base");
    expect(composeApplyPatchValidationKey("base", "fingerprint")).toBe("base|chain:fingerprint");
  });

  it("waits for candidates, prepares and parses selected sources, and reports missing targets", async () => {
    const waiting = {
      ...stage({ status: "loading", candidates: [] }),
      preparedPatchFile: undefined,
      parsedPatch: undefined,
    };
    const waitingAdapters = adapters();
    await expect(evaluateApplyPatchReadiness(waiting as never, waitingAdapters as never)).resolves.toBe(false);

    const selecting = stage({ selectedCandidateId: undefined });
    const selectingAdapters = adapters();
    await expect(evaluateApplyPatchReadiness(selecting as never, selectingAdapters as never)).resolves.toBe(true);
    expect(selecting.state.status).toBe("needsSelection");

    const noRom = { ...stage(), preparedPatchFile: undefined, parsedPatch: undefined };
    const noRomAdapters = adapters();
    noRomAdapters.prepareSelectedSource = vi.fn(async (current) => {
      current.preparedPatchFile = { fileName: "fix.ips", fileSize: 4 };
    });
    noRomAdapters.parsePatch = vi.fn(async (current) => {
      current.parsedPatch = { format: "ips" };
    });
    await expect(evaluateApplyPatchReadiness(noRom as never, noRomAdapters as never)).resolves.toBe(true);
    expect(noRomAdapters.prepareSelectedSource).toHaveBeenCalledWith(noRom);
    expect(noRomAdapters.parsePatch).toHaveBeenCalledWith(noRom);
    expect(noRomAdapters.notifyAwaitingInputTarget).toHaveBeenCalledWith(noRom);
    expect(noRom.state.status).toBe("needsSelection");
  });

  it("settles a valid target, keeps matching cached validation, and invalidates stale validation", async () => {
    const target = asset("asset-1");
    const ready = stage({ requirements: { sourceSize: 10, sourceCrc32: "a1b2c3d4" } });
    const readyAdapters = adapters([target]);
    await expect(evaluateApplyPatchReadiness(ready as never, readyAdapters as never)).resolves.toBe(false);
    expect(ready.state).toMatchObject({
      status: "ready",
      targetInputId: "asset-1",
      checksumPreflight: { status: "valid" },
    });
    expect(readyAdapters.pushWarning).not.toHaveBeenCalled();

    ready.state.patchValidation = { validationKey: "stale-key", valid: true };
    await evaluateApplyPatchReadiness(ready as never, readyAdapters as never);
    expect(ready.state.patchValidation).toBeUndefined();
  });

  it("selects a matching target among multiple assets and warns on ambiguity", async () => {
    const first = asset("first");
    const second = asset("second", "second.bin", 20);
    const selected = stage({ targetInputId: "second" });
    const selectedAdapters = adapters([first, second]);
    await evaluateApplyPatchReadiness(selected as never, selectedAdapters as never);
    expect(selected.state.targetInputId).toBe("second");

    const ambiguous = stage({ targetInputId: "missing" });
    const ambiguousAdapters = adapters([first, second]);
    await evaluateApplyPatchReadiness(ambiguous as never, ambiguousAdapters as never);
    expect(ambiguous.state.status).toBe("needsSelection");
    expect(ambiguousAdapters.pushWarning).toHaveBeenCalledWith(
      ambiguous,
      expect.objectContaining({ code: "AMBIGUOUS_SELECTION" }),
    );
  });

  it("preserves selection warnings for expected target errors and propagates real errors", async () => {
    const expected = stage();
    const expectedAssets = [asset("one"), asset("two")] as Array<Record<string, unknown>> & {
      find: (...args: never[]) => unknown;
    };
    expected.state.targetInputId = "missing";
    expectedAssets.find = () => {
      throw Object.assign(new Error("wrong target"), { code: "PATCH_TARGET_MISMATCH" });
    };
    const expectedAdapters = adapters(expectedAssets);
    await evaluateApplyPatchReadiness(expected as never, expectedAdapters as never);
    expect(expected.state.status).toBe("needsSelection");
    expect(expectedAdapters.pushWarning).toHaveBeenCalledWith(
      expected,
      expect.objectContaining({ code: "PATCH_TARGET_MISMATCH" }),
    );

    const failed = stage();
    const failedAdapters = adapters([asset("one")]);
    failedAdapters.prepareSelectedSource = vi.fn(async () => {
      throw new Error("prepare failed");
    });
    await expect(
      evaluateApplyPatchReadiness({ ...failed, preparedPatchFile: undefined } as never, failedAdapters as never),
    ).rejects.toThrow("prepare failed");
  });
});
