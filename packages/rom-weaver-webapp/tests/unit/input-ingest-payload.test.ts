import { crc32 } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  getPatchFileBlob,
  getPatchFileCleanup,
  getPatchFileExternalSource,
} from "../../src/lib/input/binary-service.ts";
import { prepareInputAssets } from "../../src/lib/input/input-preparation-service.ts";
import { RomWeaverError } from "../../src/lib/errors.ts";
import { patchContainerFixtures, xisoFixture } from "../fixtures/synthetic-patch-containers.mjs";
import type { InputPreparationRuntime } from "../../src/lib/input/input-preparation-compression.ts";

const checksum = (bytes: Uint8Array) => ({ crc32: crc32(bytes).toString(16).padStart(8, "0") });

describe("ingest resolves the selected payload before staging", () => {
  const fixtures = patchContainerFixtures();
  for (const extension of ["gcz", "wia", "z3ds", "chd", "rvz"]) {
    fixtures.push({
      extension,
      payloadExtension: "iso",
      container: new Uint8Array(92),
      payload: new Uint8Array(32768),
    });
  }
  for (const offset of [1234, 69632]) {
    const payload = xisoFixture();
    const container = payload.slice();
    container[offset] ^= 1;
    if (offset === 69632) payload[offset] ^= 1;
    fixtures.push({ extension: `xiso-${offset}.iso`, payloadExtension: "iso", container, payload });
  }
  it.each(fixtures)(
    "uses emitted bytes, size, name and checksums for $extension in both source roles",
    async ({ extension, payloadExtension, payload, container }) => {
      const source = new File([container], `source.${extension}`);
      const payloadName = `disc.${payloadExtension}`;
      const run = vi.fn(async () => ({
        result: {
          isRom: true,
          assets: [{ copiedInPlace: false, fileName: payloadName, checksums: checksum(payload) }],
          patches: [],
        },
        outputs: [
          { fileName: payloadName, blob: new Blob([payload]), size: payload.length, checksums: checksum(payload) },
        ],
        patchOutputs: [],
      }));
      const runtime = {
        name: "browser",
        workerIo: {},
        compression: {},
        ingest: { run },
      } as unknown as InputPreparationRuntime;
      for (const sourceIndex of [0, 1]) {
        const assets = await prepareInputAssets(source, undefined, sourceIndex, runtime);
        expect(assets).toHaveLength(1);
        const [asset] = assets;
        if (!asset) throw new Error("expected one prepared asset");
        expect(asset.fileName).toBe(payloadName);
        expect(asset.size).toBe(payload.length);
        expect((asset.file as typeof asset.file & { checksums?: Record<string, string> }).checksums).toEqual(
          checksum(payload),
        );
        const blob = getPatchFileBlob(asset.file);
        if (!blob) throw new Error("expected a patch file blob");
        const bytes = new Uint8Array(await blob.arrayBuffer());
        expect(bytes.length).toBe(payload.length);
        expect(bytes.findIndex((value, index) => value !== payload[index])).toBe(-1);
        expect(asset.preparation).toMatchObject({ sourceSize: container.length, wasDecompressed: true });
      }
      expect(run).toHaveBeenCalledTimes(2);
    },
  );

  it("retains a worker payload lazily with its cleanup, selection, and extraction tree", async () => {
    const cleanup = vi.fn(async () => undefined);
    const output = {
      fileName: "chosen.iso",
      path: "/work/chosen.iso",
      size: 32768,
      checksums: { crc32: "12345678" },
      vfs: { normalizePath: (path: string) => path },
      cleanup,
    };
    const run = vi.fn(async ({ onProgress }: { onProgress: (progress: unknown) => void }) => {
      onProgress({
        details: {
          extract_step: {
            status: "succeeded",
            source_name: "bundle.pbp",
            source: "/input/bundle.pbp",
            format: "pbp",
            depth: 0,
            out_dir: "/work",
            extract_time_ms: 5,
            outputs: [{ size_bytes: 32768 }],
          },
        },
      });
      return {
        result: { isRom: true, assets: [{ copiedInPlace: false }], patches: [] },
        outputs: [output],
        patchOutputs: [],
      };
    });
    const runtime = {
      name: "browser",
      workerIo: {},
      compression: {},
      ingest: { run },
    } as unknown as InputPreparationRuntime;
    const assets = await prepareInputAssets(new File(["pbp"], "bundle.pbp"), undefined, 7, runtime, "disc2.bin");
    const [prepared] = assets;
    if (!prepared) throw new Error("expected one prepared asset");
    const file = prepared.file;
    expect(getPatchFileBlob(file)).toBeNull();
    expect(getPatchFileExternalSource(file)).toMatchObject({ source: { path: "/work/chosen.iso" } });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ select: ["disc2.bin"] }));
    expect(prepared.preparation?.parentCompressions).toMatchObject([
      { fileName: "bundle.pbp", kind: "pbp", decompressionTimeMs: 5 },
      { fileName: "chosen.iso", kind: "rom" },
    ]);
    expect(cleanup).not.toHaveBeenCalled();
    await getPatchFileCleanup(file)?.();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("does not attach extracted checksums when the payload is unavailable", async () => {
    const run = vi.fn(async () => ({
      result: { isRom: true, assets: [{ copiedInPlace: false, checksums: { crc32: "12345678" } }] },
      outputs: [],
      patchOutputs: [],
    }));
    const runtime = {
      name: "browser",
      workerIo: {},
      compression: {},
      ingest: { run },
    } as unknown as InputPreparationRuntime;
    const [asset] = await prepareInputAssets(new File(["raw"], "game.iso"), undefined, 0, runtime);
    if (!asset) throw new Error("expected one prepared asset");
    expect((asset.file as typeof asset.file & { checksums?: unknown }).checksums).toBeUndefined();
  });

  it("releases outputs and propagates adoption failures", async () => {
    const dispose = vi.fn(async () => undefined);
    const run = vi.fn(async () => ({
      result: { isRom: true, assets: [{ copiedInPlace: false }], patches: [] },
      outputs: [{ fileName: "broken.iso", size: 4, dispose }],
      patchOutputs: [],
    }));
    const runtime = {
      name: "browser",
      workerIo: {},
      compression: {},
      ingest: { run },
    } as unknown as InputPreparationRuntime;
    await expect(prepareInputAssets(new File(["cso"], "game.cso"), undefined, 0, runtime)).rejects.toThrow(
      "Public output is not readable",
    );
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("propagates ingest cancellation rather than staging the raw container", async () => {
    const error = new RomWeaverError("CANCELLED", "Workflow was cancelled");
    const run = vi.fn().mockRejectedValue(error);
    const runtime = {
      name: "browser",
      workerIo: {},
      compression: {},
      ingest: { run },
    } as unknown as InputPreparationRuntime;
    await expect(prepareInputAssets(new File(["cso"], "game.cso"), undefined, 0, runtime)).rejects.toBe(error);
  });
});
