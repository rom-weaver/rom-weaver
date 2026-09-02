import { describe, expect, it, vi } from "vitest";
import {
  attachIngestPatchRequirements,
  getPatchProbeRequirements,
  inheritIngestPatchRequirements,
  parsePatchForApply,
  patchProbeRequirementsFromDescriptor,
  resolvePatchTargets,
} from "../../src/lib/apply/patch-apply-service.ts";
import type { InputAsset } from "../../src/lib/input/input-assets.ts";
import { createLazyExternalPatchFile } from "../../src/lib/input/binary-service.ts";

const asset = (id: string, fileName: string): InputAsset =>
  ({
    file: { fileName, fileSize: 1 },
    fileName,
    id,
    kind: "rom",
    patchable: true,
    size: 1,
  }) as unknown as InputAsset;

const patch = (matches: string[]) => ({
  apply: vi.fn(),
  validateSourceAsync: vi.fn(async (file: { fileName: string }) => matches.includes(file.fileName)),
});

describe("resolvePatchTargets checksum auto-targeting", () => {
  it("selects the only matching patchable input", async () => {
    const first = asset("first", "first.bin");
    const second = asset("second", "second.bin");
    await expect(resolvePatchTargets([first, second], [patch(["second.bin"])], undefined)).resolves.toEqual([second]);
  });

  it("rejects an ambiguous checksum match", async () => {
    const first = asset("first", "first.bin");
    const second = asset("second", "second.bin");
    await expect(resolvePatchTargets([first, second], [patch(["first.bin", "second.bin"])], undefined)).rejects.toThrow(
      "matches multiple inputs",
    );
  });

  it("rejects when no input matches", async () => {
    const first = asset("first", "first.bin");
    const second = asset("second", "second.bin");
    await expect(resolvePatchTargets([first, second], [patch([])], undefined)).rejects.toThrow(
      "does not match exactly one input",
    );
  });
});

describe("bundle patch requirements", () => {
  it("reuses requirements after a bundle file is wrapped", async () => {
    const source = {};
    const wrapped = createLazyExternalPatchFile("patch.ips", { filePath: "/work/patch.ips", size: 18 });
    attachIngestPatchRequirements(
      source,
      patchProbeRequirementsFromDescriptor({ fileName: "patch.ips", format: "ips", sizeBytes: 18 }),
    );
    inheritIngestPatchRequirements(source, wrapped);
    const ingest = vi.fn();

    const parsed = await parsePatchForApply(wrapped as never, { ingest: { run: ingest } } as never);

    expect(getPatchProbeRequirements(parsed)).toMatchObject({ format: "IPS" });
    expect(ingest).not.toHaveBeenCalled();
  });

  it("parses a bare patch without loading ROM identify data", async () => {
    const ingest = vi.fn().mockResolvedValue({
      result: {
        patches: [{ fileName: "patch.ips", format: "ips", sizeBytes: 18 }],
      },
    });

    const patchFile = createLazyExternalPatchFile("patch.ips", { filePath: "/work/patch.ips", size: 18 });

    await parsePatchForApply(patchFile, { ingest: { run: ingest } } as never);

    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ identify: false }));
  });
});
