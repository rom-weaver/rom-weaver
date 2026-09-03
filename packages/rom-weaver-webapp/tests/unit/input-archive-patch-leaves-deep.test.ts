import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attachIngestPatchRequirements: vi.fn(),
  createPatchFileFromPublicOutput: vi.fn(),
  getCompressionFormat: vi.fn(() => "zip"),
  getCompressionRuntimeSource: vi.fn((file) => file),
  isCompressionFile: vi.fn((file: { fileName?: string }) => file.fileName?.endsWith(".zip") === true),
  patchProbeRequirementsFromDescriptor: vi.fn((descriptor) => ({ format: descriptor.format })),
  resolveInputPreparationRuntime: vi.fn(async (runtime) => runtime),
  traceArchivePreparation: vi.fn(),
}));

vi.mock("../../src/lib/apply/patch-apply-service.ts", () => ({
  attachIngestPatchRequirements: mocks.attachIngestPatchRequirements,
  patchProbeRequirementsFromDescriptor: mocks.patchProbeRequirementsFromDescriptor,
}));
vi.mock("../../src/lib/runtime/public-output-bin-file.ts", () => ({
  createPatchFileFromPublicOutput: mocks.createPatchFileFromPublicOutput,
}));
vi.mock("../../src/lib/input/input-preparation-archive.ts", () => ({
  describeArchiveFileForTrace: vi.fn((file) => ({ fileName: file.fileName })),
  getCompressionFormat: mocks.getCompressionFormat,
  getCompressionRuntimeSource: mocks.getCompressionRuntimeSource,
  isCompressionFile: mocks.isCompressionFile,
  traceArchivePreparation: mocks.traceArchivePreparation,
}));
vi.mock("../../src/lib/input/input-preparation-compression.ts", () => ({
  resolveInputPreparationRuntime: mocks.resolveInputPreparationRuntime,
}));

import {
  buildPatchArchiveLeaves,
  getPatchLeafFileForSelection,
  getPatchLeafParentCompressionsForSelection,
  matchPreferredPatchLeaf,
  resolvePatchArchiveLeaf,
} from "../../src/lib/input/input-archive-patch-leaves.ts";
import type { CandidateSelectionRequest } from "../../src/types/selection.ts";

const archiveFile = (fileName = "patches.zip") => ({ fileName, fileSize: 20, _u8array: new Uint8Array(20) }) as never;

const descriptor = (leafPath: string, fileName: string, extras: Record<string, unknown> = {}) => ({
  fileName,
  format: "IPS",
  isValidPatch: true,
  leafPath,
  sizeBytes: 10,
  ...extras,
});

const output = (path: string) => ({ fileName: path.split("/").at(-1), path, size: 10 });

const materializedFile = (fileName: string, cleanup?: () => Promise<void>) =>
  ({
    _cleanup: cleanup,
    _u8array: new Uint8Array([1, 2]),
    fileName,
    fileSize: 2,
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("nested patch archive leaf resolution", () => {
  it("builds, caches, and describes materialized leaves with archive breadcrumbs", async () => {
    const archive = archiveFile();
    const first = materializedFile("first.ips");
    const second = materializedFile("second.bps");
    mocks.createPatchFileFromPublicOutput.mockReset();
    mocks.createPatchFileFromPublicOutput.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const leaves = await buildPatchArchiveLeaves(
      archive,
      [
        descriptor("/work/operations/123e4567-e89b-12d3-a456-426614174000/nested/first.ips", "first.ips", {
          sidecarOrder: 2,
        }),
        descriptor("/work/nested/second.bps", "second.bps", { sidecarOrder: 1 }),
      ] as never,
      [
        output("/work/operations/123e4567-e89b-12d3-a456-426614174000/nested/first.ips"),
        output("/work/nested/second.bps"),
      ] as never,
      12,
      {} as never,
      3,
    );

    expect(leaves).toHaveLength(2);
    expect(leaves[0]).toMatchObject({
      candidate: {
        breadcrumbs: ["patches.zip", "nested"],
        fileName: "first.ips",
        id: expect.stringContaining("input-3-"),
        path: "/work/operations/123e4567-e89b-12d3-a456-426614174000/nested/first.ips",
        size: 10,
      },
      file: first,
      parentCompressions: [
        { depth: 0, decompressionTimeMs: 12, fileName: "patches.zip", kind: "archive" },
        { depth: 1, fileName: "nested", kind: "archive" },
      ],
      sidecarOrder: 2,
    });
    expect(leaves[1]?.parentCompressions).toEqual([
      { depth: 0, decompressionTimeMs: 12, fileName: "patches.zip", kind: "archive" },
      { depth: 1, fileName: "nested", kind: "archive" },
    ]);
    expect(mocks.attachIngestPatchRequirements).toHaveBeenCalledTimes(2);

    const cached = await buildPatchArchiveLeaves(
      archive,
      [descriptor("/work/nested/second.bps", "second.bps")] as never,
      [output("/work/nested/second.bps")] as never,
      undefined,
      {} as never,
      3,
    );
    expect(cached[0]?.file).toBe(second);
    expect(mocks.createPatchFileFromPublicOutput).toHaveBeenCalledTimes(2);
  });

  it("skips missing outputs and nested compression leaves, cleaning rejected files", async () => {
    const rejectedCleanup = vi.fn(async () => undefined);
    const rejected = materializedFile("nested.zip", rejectedCleanup);
    mocks.createPatchFileFromPublicOutput.mockReset();
    mocks.createPatchFileFromPublicOutput.mockResolvedValue(rejected);
    const leaves = await buildPatchArchiveLeaves(
      archiveFile("outer.7z"),
      [descriptor("/work/nested.zip", "nested.zip"), descriptor("/work/missing.ips", "missing.ips")] as never,
      [output("/work/nested.zip")] as never,
      undefined,
      {} as never,
      0,
    );
    expect(leaves).toEqual([]);
    expect(rejectedCleanup).toHaveBeenCalledTimes(1);
    expect(mocks.attachIngestPatchRequirements).not.toHaveBeenCalled();
  });

  it("preselects exact or extension-insensitive preferred leaves", () => {
    const leaves = [
      { candidate: { fileName: "folder/change.bps" } },
      { candidate: { fileName: "change.ips" } },
      { candidate: { fileName: "other.ips" } },
    ];
    expect(matchPreferredPatchLeaf(leaves, "CHANGE.IPS")).toBe(leaves[1]);
    expect(matchPreferredPatchLeaf(leaves, "change.xdelta")).toBe(leaves[0]);
    expect(matchPreferredPatchLeaf(leaves, "missing.ips")).toBeUndefined();
    expect(matchPreferredPatchLeaf(leaves, undefined)).toBeUndefined();
  });

  it("resolves cached, lone, and explicitly selected leaves without re-extracting", async () => {
    const archive = archiveFile("cached.zip");
    const file = materializedFile("cached.ips");
    mocks.createPatchFileFromPublicOutput.mockReset();
    mocks.createPatchFileFromPublicOutput.mockResolvedValue(file);
    const patch = descriptor("/work/cached.ips", "cached.ips");
    await buildPatchArchiveLeaves(archive, [patch] as never, [output("/work/cached.ips")] as never, 4, {} as never, 1);
    const runtime = { ingest: { run: vi.fn() } };
    await expect(resolvePatchArchiveLeaf(archive, {} as never, runtime as never, "/work/cached.ips", 1)).resolves.toBe(
      file,
    );
    expect(runtime.ingest.run).not.toHaveBeenCalled();

    const fresh = archiveFile("fresh.zip");
    const freshFile = materializedFile("fresh.ips");
    const freshPath = "/work/fresh.ips";
    mocks.createPatchFileFromPublicOutput.mockResolvedValue(freshFile);
    const freshPatch = descriptor(freshPath, "fresh.ips");
    const ingest = vi.fn(async (request: { onProgress: (event: unknown) => void }) => {
      request.onProgress({ details: { extract_step: { extract_time_ms: 5, status: "succeeded" } } });
      return { patchOutputs: [output(freshPath)], result: { patches: [freshPatch], isRom: false } };
    });
    const freshRuntime = { ingest: { run: ingest } };
    await expect(resolvePatchArchiveLeaf(fresh, {} as never, freshRuntime as never, undefined, 1)).resolves.toBe(
      freshFile,
    );
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it("prompts for multiple leaves, registers their files, and reports invalid selections", async () => {
    const archive = archiveFile("multi.zip");
    const first = materializedFile("first.ips");
    const second = materializedFile("second.ips");
    mocks.createPatchFileFromPublicOutput.mockReset();
    mocks.createPatchFileFromPublicOutput.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const firstPath = "/work/first.ips";
    const secondPath = "/work/second.ips";
    const patches = [descriptor(firstPath, "first.ips"), descriptor(secondPath, "second.ips")];
    const ingest = vi.fn(async () => ({
      patchOutputs: [output(firstPath), output(secondPath)],
      result: { patches, isRom: false },
    }));
    const requests: CandidateSelectionRequest[] = [];
    await expect(
      resolvePatchArchiveLeaf(
        archive,
        {
          onCandidatesFound: (request: CandidateSelectionRequest) => requests.push(request),
          patchLeafPreference: { preferredName: "second.ips" },
        } as never,
        { ingest: { run: ingest } } as never,
        undefined,
        4,
      ),
    ).rejects.toMatchObject({ code: "AMBIGUOUS_SELECTION" });
    expect(requests[0]).toMatchObject({
      candidates: [{ defaultSelected: true, fileName: "second.ips" }, { fileName: "first.ips" }],
      multiSelect: true,
      role: "patch",
      sourceIndex: 4,
    });
    const request = requests[0] as CandidateSelectionRequest;
    expect(getPatchLeafFileForSelection(request, request.candidates[0]?.id || "")).toBe(second);
    expect(getPatchLeafParentCompressionsForSelection(request, request.candidates[1]?.id || "")).toEqual([
      { depth: 0, decompressionTimeMs: undefined, fileName: "multi.zip", kind: "archive" },
    ]);

    const invalidArchive = archiveFile("invalid.zip");
    mocks.createPatchFileFromPublicOutput.mockResolvedValue(first);
    await expect(
      resolvePatchArchiveLeaf(
        invalidArchive,
        {} as never,
        {
          ingest: {
            run: vi.fn(async () => ({ patchOutputs: [output(firstPath)], result: { patches, isRom: false } })),
          },
        } as never,
        "/work/not-found.ips",
        0,
      ),
    ).rejects.toMatchObject({ code: "SELECTION_NOT_FOUND" });
  });
});
