import { expect, test } from "vitest";
import { resolveSidecarPatchEntries } from "../../src/lib/input/sidecar-patch-resolution.ts";
import { ApplyWorkflow } from "../../src/platform/browser/browser-api.ts";

const RAW_ROM = "tests/fixtures/archive_sources/game.bin";
const RAW_PATCH = "tests/fixtures/archive_sources/change.ips";
const encoder = new TextEncoder();

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

const crc32 = (bytes) => {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};

const writeU16Le = (bytes, offset, value) => {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
};

const writeU32Le = (bytes, offset, value) => {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
};

const concatenateBytes = (parts) => {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};

const loadFixtureBytes = async (filePath) => {
  const response = await fetch(`/${filePath}`);
  if (!response.ok) throw new Error(`Failed to load fixture ${filePath}`);
  return new Uint8Array(await response.arrayBuffer());
};

const createZipFile = (entries, outputName) => {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = entry.filename || entry.fileName;
    const nameBytes = encoder.encode(name);
    const data = entry.data;
    const checksum = crc32(data);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    writeU32Le(localHeader, 0, 0x04034b50);
    writeU16Le(localHeader, 4, 20);
    writeU16Le(localHeader, 8, 0);
    writeU32Le(localHeader, 14, checksum);
    writeU32Le(localHeader, 18, data.length);
    writeU32Le(localHeader, 22, data.length);
    writeU16Le(localHeader, 26, nameBytes.length);
    localHeader.set(nameBytes, 30);
    localParts.push(localHeader, data);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    writeU32Le(centralHeader, 0, 0x02014b50);
    writeU16Le(centralHeader, 4, 20);
    writeU16Le(centralHeader, 6, 20);
    writeU16Le(centralHeader, 10, 0);
    writeU32Le(centralHeader, 16, checksum);
    writeU32Le(centralHeader, 20, data.length);
    writeU32Le(centralHeader, 24, data.length);
    writeU16Le(centralHeader, 28, nameBytes.length);
    writeU32Le(centralHeader, 42, offset);
    centralHeader.set(nameBytes, 46);
    centralParts.push(centralHeader);
    offset += localHeader.length + data.length;
  }

  const centralDirectory = concatenateBytes(centralParts);
  const end = new Uint8Array(22);
  writeU32Le(end, 0, 0x06054b50);
  writeU16Le(end, 8, entries.length);
  writeU16Le(end, 10, entries.length);
  writeU32Le(end, 12, centralDirectory.length);
  writeU32Le(end, 16, offset);
  return new File([...localParts, centralDirectory, end], outputName, { type: "application/zip" });
};

// Delegates to ingest's Rust sidecar preflight (the single source of truth); the matcher itself is
// also covered natively in `crates/rom-weaver-app/src/tests.rs` with the same golden cases.
test("sidecar resolver matches RetroArch patch basename and numeric order (via ingest preflight)", async () => {
  const entries = [
    { filename: "bundle/other.ips" },
    { filename: "bundle/game [Hack].ips2" },
    { filename: "bundle/game.bspatch3" },
    { filename: "bundle/game.ips" },
    { filename: "bundle/game.bin.ips1" },
    { filename: "elsewhere/game.ips" },
  ];

  const resolved = await resolveSidecarPatchEntries("bundle/game.bin", entries);
  expect(resolved.map((entry) => entry.fileName)).toEqual([
    "bundle/game.ips",
    "bundle/game.bin.ips1",
    "bundle/game [Hack].ips2",
    "bundle/game.bspatch3",
  ]);
});

test("apply workflow discovers matching sidecar patches inside input archives", async () => {
  const romBytes = await loadFixtureBytes(RAW_ROM);
  const patchBytes = await loadFixtureBytes(RAW_PATCH);
  const archive = createZipFile(
    [
      {
        data: romBytes,
        fileName: "bundle/game.bin",
        filename: "bundle/game.bin",
      },
      {
        data: patchBytes,
        fileName: "bundle/game [Hack].ips",
        filename: "bundle/game [Hack].ips",
      },
      {
        data: patchBytes,
        fileName: "bundle/other.ips",
        filename: "bundle/other.ips",
      },
    ],
    "softpatch.zip",
  );
  const logs = [];
  const workflow = new ApplyWorkflow({
    settings: {
      logging: {
        level: "trace",
        sink: (record) => logs.push(record || {}),
      },
      output: {
        compression: "none",
      },
      workers: {
        threads: 1,
      },
    },
  });

  try {
    await workflow.setInput(archive);

    const patches = workflow.getPatches();
    const patchSources = workflow.getPatchSources();
    if (patches.length !== 1) {
      console.log(
        "sidecar discovery trace",
        JSON.stringify(
          logs
            .filter((entry) => /implicit|archive|extract|patch/i.test(String(entry?.message || "")))
            .map((entry) => ({ details: entry.details, message: entry.message })),
          null,
          2,
        ),
      );
    }
    expect(patches).toHaveLength(1);
    expect(patches[0]?.fileName).toBe("game [Hack].ips");
    expect(patches[0]?.status).toBe("ready");
    expect(patchSources).toHaveLength(1);
    expect(patchSources[0]).toBeInstanceOf(File);
    expect(patchSources[0]?.name).toBe("game [Hack].ips");

    const result = await workflow.run();
    try {
      const outputBlob = await result.output.getBlob?.();
      expect(outputBlob).toBeInstanceOf(Blob);
      expect(new TextDecoder().decode(await outputBlob.arrayBuffer())).toBe("OXIGINAL-ROM\n");
    } finally {
      await result.output.dispose();
    }
  } finally {
    await workflow.dispose();
  }
});
