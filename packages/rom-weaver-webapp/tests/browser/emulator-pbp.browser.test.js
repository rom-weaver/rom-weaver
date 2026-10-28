import { describe, expect, it, vi } from "vitest";
import { loadEmulatorRom } from "../../src/public/react/components/emulator-load-rom.ts";
import { getIngestOutputBlob } from "../../src/platform/browser/browser-api.ts";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { browserVfs } from "../../src/platform/browser/workflow-runtime-vfs-cleanup.ts";
import { getEmulatorJsCore } from "../../src/public/react/components/emulatorjs.ts";
import { buildPbp, buildPbpDiscBytes } from "../wasm/pbp-fixture.mjs";

const disc = { discId: "SLUS00001", iso: buildPbpDiscBytes(32, 7) };
const sha1 = async (blob) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-1", await blob.arrayBuffer())), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

// Synthetic containers prove loader routing and identity, not game boot or gameplay.
describe("Test loader with real PBP parsing and hashing", () => {
  it.each([1, 2, 5])("bundles every stored-block disc of a %i-disc PBP for PSX", async (count) => {
    const blob = new Blob([buildPbp(Array.from({ length: count }, () => disc))]);
    const stat = vi.spyOn(browserVfs, "stat");
    let loaded;
    try {
      loaded = await loadEmulatorRom(blob, "Synthetic v1.2 雨 #2.PBP");
      const archivePaths = stat.mock.calls.map(([path]) => path).filter((path) => path.endsWith(".zip"));
      expect(archivePaths.length).toBeGreaterThan(0);
      for (const path of new Set(archivePaths)) expect(await browserVfs.stat(path)).toBeNull();
    } finally {
      stat.mockRestore();
    }
    expect(loaded.fileName).toBe("Synthetic v1.2 雨 #2.zip");
    expect(loaded.platform).toBe("Sony PlayStation");
    expect(loaded.expandedSizeBytes).toBeGreaterThanOrEqual(count * disc.iso.length);
    expect(getEmulatorJsCore(loaded.platform, loaded.fileName)).toBe("psx");
    expect(loaded.checksum).toBe(await sha1(count === 1 ? new Blob([disc.iso]) : blob));
    const extracted = await browserRuntime.compression.extract({
      source: { source: loaded.blob, fileName: "prepared.zip" },
      extractAll: true,
    });
    try {
      const bins = extracted.outputs.filter((entry) => entry.fileName.endsWith(".bin"));
      const cues = extracted.outputs.filter((entry) => entry.fileName.endsWith(".cue"));
      const playlist = extracted.outputs.find((entry) => entry.fileName.endsWith(".m3u"));
      expect(bins).toHaveLength(count);
      expect(cues).toHaveLength(count);
      expect(playlist).toBeDefined();
      const lines = (await (await getIngestOutputBlob(playlist)).text())
        .trim()
        .split(/\r?\n/)
        .filter((line) => !line.startsWith("#"));
      expect(new Set(lines).size).toBe(count);
      expect(lines.slice().sort()).toEqual(cues.map((entry) => entry.fileName).sort());
      const discHash = await sha1(new Blob([disc.iso]));
      for (const bin of bins) expect(await sha1(await getIngestOutputBlob(bin))).toBe(discHash);
      for (const cue of cues)
        expect(await (await getIngestOutputBlob(cue)).text()).toContain(
          `FILE "${cue.fileName.replace(/\.cue$/, ".bin")}" BINARY`,
        );
    } finally {
      await Promise.all(extracted.outputs.map((entry) => entry.dispose()));
    }
    expect((await loadEmulatorRom(blob, "Renamed.pbp")).checksum).toBe(loaded.checksum);
  });

  it("keeps empty-PSAR PSP passthrough and whole-file identity", async () => {
    const bytes = new Uint8Array(40);
    bytes.set([0, 80, 66, 80]);
    for (let offset = 8; offset < 40; offset += 4) new DataView(bytes.buffer).setUint32(offset, 40, true);
    const blob = new Blob([bytes]);
    const loaded = await loadEmulatorRom(blob, "EBOOT.PBP");
    expect(loaded.blob).toBe(blob);
    expect(getEmulatorJsCore(loaded.platform, loaded.fileName)).toBe("psp");
    expect(loaded.checksum).toBe(await sha1(blob));
  });

  it.each([
    ["truncated header", (bytes) => bytes.slice(0, 20), /too small/],
    [
      "invalid signature",
      (bytes) => {
        bytes[0x100] = 0;
        return bytes;
      },
      /supported PS1 DATA.PSAR signature/,
    ],
    [
      "non-monotonic offsets",
      (bytes) => {
        new DataView(bytes.buffer).setUint32(12, 40, true);
        return bytes;
      },
      /non-monotonic/,
    ],
    [
      "out-of-range PSAR",
      (bytes) => {
        new DataView(bytes.buffer).setUint32(36, bytes.length + 1, true);
        return bytes;
      },
      /out-of-range/,
    ],
  ])("rejects %s before handing bytes to a core", async (_label, mutate, error) => {
    const blob = new Blob([mutate(buildPbp([disc]))]);
    await expect(loadEmulatorRom(blob, "Invalid.pbp")).rejects.toThrow(error);
  });
});
