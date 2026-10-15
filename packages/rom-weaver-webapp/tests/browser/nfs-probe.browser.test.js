import { expect, test } from "vitest";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { resetRomWeaverRunner, warmupRomWeaverRunner } from "../../src/workers/rom-weaver/rom-weaver-runner.ts";

const syntheticNfs = async () => {
  const sectorSize = 0x8000;
  const sectorCount = 4;
  const plain = Uint8Array.from({ length: sectorSize * sectorCount }, (_, index) => (index * 7 + 19) & 0xff);
  plain.fill(0, 0, 0x440);
  plain.set(new TextEncoder().encode("GAUE01"));
  plain.set([0xc2, 0x33, 0x9f, 0x3d], 0x1c);
  plain.set(new TextEncoder().encode("Synthetic NFS browser regression"), 0x20);
  const keyBytes = Uint8Array.from({ length: 16 }, (_, index) => (index * 17 + 17) & 0xff);
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-CBC", false, ["encrypt"]);
  const nfs = new Uint8Array(0x200 + plain.length);
  const header = new DataView(nfs.buffer);
  nfs.set(new TextEncoder().encode("EGGS"));
  header.setUint32(4, 1);
  header.setUint32(16, 1);
  header.setUint32(20, 0);
  header.setUint32(24, sectorCount);
  nfs.set(new TextEncoder().encode("SGGE"), 0x1fc);
  for (let sector = 0; sector < sectorCount; sector++) {
    const iv = new Uint8Array(16);
    new DataView(iv.buffer).setUint32(12, sector);
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-CBC", iv },
        key,
        plain.subarray(sector * sectorSize, (sector + 1) * sectorSize),
      ),
    );
    // NFS sectors MUST omit WebCrypto's trailing PKCS#7 padding block.
    nfs.set(ciphertext.subarray(0, sectorSize), 0x200 + sector * sectorSize);
  }
  return {
    source: new File([nfs], "hif_000000.nfs"),
    key: new File([keyBytes], "htk.bin"),
  };
};

test("WASM probes the decrypted NFS header with a grouped synthetic htk.bin", async () => {
  await resetRomWeaverRunner();
  try {
    await warmupRomWeaverRunner();
    const { source, key } = await syntheticNfs();
    const probe = browserRuntime.compression.probe;
    if (!probe) throw new Error("Runtime compression probe capability is unavailable");
    expect(source.size).toBe(0x20200);
    const result = await probe({ source, companionFiles: [key], format: "nfs", options: { threads: 1 } });
    expect(result.platform).toBe("Nintendo GameCube");
    expect(result.entries.map((entry) => entry.filename)).toEqual(["hif_000000.iso"]);
    await expect(
      probe({
        source,
        companionFiles: [new File([new Uint8Array(16)], "htk.bin")],
        format: "nfs",
        options: { threads: 1 },
      }),
    ).rejects.toThrow(/Invalid disc header/i);
  } finally {
    await resetRomWeaverRunner();
  }
});
