import { expect, test } from "vitest";
import { createArchiveOutput } from "../../src/lib/output/archive-output-service.ts";
import { runTrimWorkflow } from "../../src/lib/trim/workflow.ts";
import { TrimWorkflow } from "../../src/platform/browser/browser-api.ts";
import { warmupBrowserRuntimeExtraction } from "../../src/platform/browser/browser-runtime-warmup.ts";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { readRuntimeOutputBytes } from "../../src/storage/vfs/runtime-output.ts";
import { xisoFixture } from "../fixtures/synthetic-patch-containers.mjs";

const ndsCrc16 = (bytes) => {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      const carry = (crc & 1) !== 0;
      crc >>>= 1;
      if (carry) crc ^= 0xa001;
    }
  }
  return crc & 0xffff;
};

// The webapp appends a revert footer to every NDS, GBA, and 3DS trim it can later restore.
const REVERT_FOOTER_BYTES = 12;

const writeLe32 = (bytes, offset, value) => {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
};

const writeLe16 = (bytes, offset, value) => {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
};

const buildTestNdsRom = () => {
  const headerBytes = 0x1000;
  const ntrRomSize = 0x3000;
  const fileSize = 0x5000;
  const rom = new Uint8Array(fileSize);
  const header = rom.subarray(0, headerBytes);
  header.set(new TextEncoder().encode("RW-TRIM-TEST"), 0);
  header[0x12] = 0x00;
  writeLe32(header, 0x80, ntrRomSize);
  writeLe32(header, 0x84, headerBytes);
  writeLe32(header, 0x210, ntrRomSize);
  for (let index = 0; index < 156; index++) header[0x0c0 + index] = (index * 37 + 11) % 251;
  writeLe16(header, 0x15c, ndsCrc16(header.subarray(0x0c0, 0x0c0 + 156)));
  writeLe16(header, 0x15e, ndsCrc16(header.subarray(0, 0x15e)));
  for (let index = headerBytes; index < rom.length; index++) rom[index] = (index * 13 + 5) % 251;
  return rom;
};

const createZipFile = async (entryName, bytes, outputName) => {
  const result = await browserRuntime.compression.create?.({
    entries: [
      {
        data: bytes,
        fileName: entryName,
        filename: entryName,
      },
    ],
    format: "zip",
    options: {
      outputName,
      threads: 1,
    },
  });
  const output = result?.output;
  if (!output) throw new Error("Failed to create trim archive fixture");
  try {
    const blob = await browserRuntime.publicOutput.getBlob(output);
    return new File([blob], outputName, { type: "application/zip" });
  } finally {
    await output.cleanup?.().catch(() => undefined);
  }
};

test.each(["zip", "7z"])("trim %s output matches byte-backed archive creation", async (compression) => {
  const source = new File([buildTestNdsRom()], "game.nds");
  const options = {
    output: { container: { profile: "fast" }, outputName: `trimmed.${compression}`, compression },
    workers: { threads: 4 },
  };
  const raw = await runTrimWorkflow(
    { source, options: { output: { compression: "none", outputName: "trimmed.nds" }, workers: { threads: 4 } } },
    browserRuntime,
  );
  try {
    const data = await readRuntimeOutputBytes(raw.output);
    expect(data).toEqual(buildTestNdsRom().subarray(0, 0x3000));
    const byteBacked = await createArchiveOutput({
      compression,
      entries: [{ data, fileName: "trimmed.nds", filename: "trimmed.nds" }],
      options,
      outputName: options.output.outputName,
      runtime: browserRuntime,
    });
    try {
      const trimmed = await runTrimWorkflow({ source, options }, browserRuntime);
      try {
        const baseHash = await crypto.subtle.digest("SHA-256", await readRuntimeOutputBytes(byteBacked));
        const candidateHash = await crypto.subtle.digest("SHA-256", await readRuntimeOutputBytes(trimmed.output));
        expect(new Uint8Array(candidateHash)).toEqual(new Uint8Array(baseHash));
        expect(trimmed.output.fileName).toBe(options.output.outputName);
        expect(trimmed.sizeSummary.rawSize).toBe(data.byteLength);
      } finally {
        await trimmed.output.cleanup?.();
      }
    } finally {
      await byteBacked.cleanup?.();
    }
  } finally {
    await raw.output.cleanup?.();
  }
});

test("browser runtime warmup leaves sibling OPFS entries untouched", async () => {
  const root = await navigator.storage.getDirectory();
  const siblingName = `warmup-sibling-${crypto.randomUUID()}`;
  const sibling = await root.getDirectoryHandle(siblingName, { create: true });
  const fileName = "live-rom-weaver-warmup.bin";
  const file = await sibling.getFileHandle(fileName, { create: true });
  const writable = await file.createWritable();
  await writable.write(new Uint8Array([4, 5, 6]));
  await writable.close();

  try {
    await warmupBrowserRuntimeExtraction();

    const survivingDirectory = await root.getDirectoryHandle(siblingName);
    const survivingFile = await survivingDirectory.getFileHandle(fileName);
    await expect(survivingFile.getFile()).resolves.toMatchObject({ size: 3 });
  } finally {
    await root.removeEntry(siblingName, { recursive: true }).catch(() => undefined);
  }
});

test("trim workflow sends extracted archive payload to the trim worker", async () => {
  await warmupBrowserRuntimeExtraction();
  const logs = [];
  const workflow = new TrimWorkflow({
    settings: {
      logging: {
        level: "trace",
        sink: (record) => logs.push(record || {}),
      },
      output: {
        compression: "none",
        outputName: "game.nds",
      },
      workers: {
        threads: 1,
      },
    },
  });
  try {
    const archive = await createZipFile("game.nds", buildTestNdsRom(), "game.zip");
    await workflow.setInput(archive);

    const input = workflow.getInput();
    expect(input?.fileName).toBe("game.nds");
    expect(input?.wasDecompressed).toBe(true);
    // The staging probe dry-runs the extracted member, not the archive.
    expect(input?.trimSupported).toBe(true);

    const result = await workflow.run();
    expect(result.output.fileName).toBe("game (trimmed).nds");
    expect(result.output.size).toBe(0x3000 + REVERT_FOOTER_BYTES);
    expect(result.sizeSummary?.inputSize).toBe(0x5000);
    expect(result.sizeSummary?.outputSize).toBe(0x3000 + REVERT_FOOTER_BYTES);
    expect(result.sizeSummary?.rawSize).toBe(0x3000 + REVERT_FOOTER_BYTES);
    await result.output.dispose();

    // The run starts the engine's trim once (the staging probe passes no log sink).
    const trimDispatches = logs.filter((entry) => String(entry?.message || "").startsWith("runJson trim "));
    expect(trimDispatches.map((entry) => entry?.details?.command?.args?.dry_run)).toEqual([false]);
    const trimDispatch = trimDispatches.at(-1);
    const trimSource = trimDispatch?.details?.command?.args?.input?.[0] || "";
    const trimOutput = trimDispatch?.details?.command?.args?.output || "";
    expect(trimSource).toMatch(/game\.nds$/i);
    expect(trimSource).not.toMatch(/\.zip$/i);
    // The engine runs once, writing to an extensionless path; the output is named afterwards.
    expect(trimOutput).toMatch(/\/[^./]+$/);
    expect(trimOutput).not.toMatch(/\/work\/game\.nds$/i);

    const ingestDispatches = logs.filter((entry) => String(entry?.message || "") === "runJson ingest dispatch");
    expect(ingestDispatches).toHaveLength(1);

    await workflow.setOutputFormat("zip");
    await workflow.setOutputName("custom-trim.zip");
    const secondResult = await workflow.run();
    expect(secondResult.output.fileName).toBe("custom-trim.zip");
    await secondResult.output.dispose();
    expect(logs.filter((entry) => String(entry?.message || "") === "runJson ingest dispatch")).toHaveLength(1);
  } finally {
    await workflow.dispose();
  }
});

const buildAlignedGameCubeRom = () => {
  const bytes = new Uint8Array(65536);
  bytes.set(new TextEncoder().encode("RWTEST"));
  bytes.set([0xc2, 0x33, 0x9f, 0x3d], 0x1c);
  bytes.set(new TextEncoder().encode("rom-weaver-test"), 0x20);
  for (let index = 0x440; index < bytes.length; index++) bytes[index] = index % 251;
  return bytes;
};

test.each(["game.iso", "game.gcm"])(
  "trim flags the GameCube/Wii disc %s as unsupported at staging and points to Compress",
  async (fileName) => {
    const workflow = new TrimWorkflow({
      settings: { output: { compression: "none", outputName: "trimmed.iso" }, workers: { threads: 1 } },
    });
    try {
      await workflow.setInput(new File([buildAlignedGameCubeRom()], fileName));
      expect(workflow.getInput().trimSupported).toBe(false);
      const warning = workflow.getInput().warnings.find((entry) => entry.code === "TRIM_UNSUPPORTED");
      expect(warning?.message).toContain("Use Compress to convert GameCube and Wii discs to RVZ");
      await expect(workflow.run()).rejects.toThrow("This input does not support trimming");
    } finally {
      await workflow.dispose();
    }
  },
);

test("trim flags an archive that holds a GameCube/Wii disc as unsupported and points to Compress", async () => {
  await warmupBrowserRuntimeExtraction();
  const workflow = new TrimWorkflow({
    settings: { output: { compression: "none", outputName: "trimmed.iso" }, workers: { threads: 1 } },
  });
  try {
    const archive = await createZipFile("Kururin Squash! (Japan).iso", buildAlignedGameCubeRom(), "kururin.zip");
    await workflow.setInput(archive);
    expect(workflow.getInput().trimSupported).toBe(false);
    const warning = workflow.getInput().warnings.find((entry) => entry.code === "TRIM_UNSUPPORTED");
    expect(warning?.message).toContain("Use Compress to convert GameCube and Wii discs to RVZ");
    // The disc is recognized from its header, so the archive itself is the staged input.
    expect(workflow.getInput().fileName).toBe("kururin.zip");
    expect(workflow.getInput().parentCompressions).toEqual([]);
    await expect(workflow.run()).rejects.toThrow("This input does not support trimming");
  } finally {
    await workflow.dispose();
  }
});

test("trim flags an archive of only a GameCube/Wii disc without extracting the disc", async () => {
  await warmupBrowserRuntimeExtraction();
  const workflow = new TrimWorkflow({
    settings: { output: { compression: "none", outputName: "trimmed.gcm" }, workers: { threads: 1 } },
  });
  try {
    const archive = await createZipFile("Kururin Squash! (Japan).gcm", buildAlignedGameCubeRom(), "kururin.zip");
    await workflow.setInput(archive);
    const input = workflow.getInput();
    expect(input.trimSupported).toBe(false);
    expect(input.warnings.find((entry) => entry.code === "TRIM_UNSUPPORTED")?.message).toContain(
      "Use Compress to convert GameCube and Wii discs to RVZ",
    );
    // The archive itself is the staged input: the disc was never extracted from it.
    expect(input.fileName).toBe("kururin.zip");
    expect(input.parentCompressions).toEqual([]);
  } finally {
    await workflow.dispose();
  }
});

test("trim flags a GameCube/Wii disc inside a nested archive without extracting either", async () => {
  await warmupBrowserRuntimeExtraction();
  const workflow = new TrimWorkflow({
    settings: { output: { compression: "none", outputName: "trimmed.iso" }, workers: { threads: 1 } },
  });
  try {
    const inner = await createZipFile("Kururin Squash! (Japan).iso", buildAlignedGameCubeRom(), "inner.zip");
    const archive = await createZipFile("inner.zip", new Uint8Array(await inner.arrayBuffer()), "outer.zip");
    await workflow.setInput(archive);
    const input = workflow.getInput();
    expect(input.trimSupported).toBe(false);
    expect(input.warnings.find((entry) => entry.code === "TRIM_UNSUPPORTED")?.message).toContain(
      "Use Compress to convert GameCube and Wii discs to RVZ",
    );
    expect(input.fileName).toBe("outer.zip");
    expect(input.parentCompressions).toEqual([]);
  } finally {
    await workflow.dispose();
  }
});

// A trim is the heavy engine pass (an XISO rebuild), so each real trim must start
// the engine's `trim` command exactly once, with the output named after what that one run wrote.
test.each([
  ["game.nds", () => buildTestNdsRom(), "none", "trimmed.nds"],
  ["game.nds", () => buildTestNdsRom(), "zip", "trimmed.zip"],
])("trim %s with %s output runs the engine trim once", async (sourceName, buildBytes, compression, outputName) => {
  const traces = [];
  const workflow = new TrimWorkflow({
    settings: {
      logging: { level: "trace", sink: (log) => traces.push(log) },
      output: {
        compression,
        outputName: "trimmed.nds",
      },
      workers: { threads: 1 },
    },
  });
  try {
    await workflow.setInput(new File([buildBytes()], sourceName));
    if (compression !== "none") await workflow.setOutputName(outputName);
    traces.length = 0;
    const result = await workflow.run();
    try {
      expect(result.output.fileName).toBe(outputName);
      expect(result.output.size).toBeGreaterThan(0);
      const dispatches = traces.filter((log) => String(log?.message || "").startsWith("runJson trim "));
      expect(dispatches.map((log) => log.details?.command?.args?.dry_run)).toEqual([false]);
    } finally {
      await result.output.dispose();
    }
  } finally {
    await workflow.dispose();
  }
});

// An Xbox XISO cannot be stored as CHD in a useful way, so the engine refuses it and the workflow
// surfaces that error instead of producing a file - whatever CHD layout the caller asks for.
test.each([
  ["default", {}],
  ["chdOutputMode cd", { container: { chdOutputMode: "cd" } }],
])("trim of an XISO into CHD is rejected (%s)", async (_label, extra) => {
  const xiso = new Uint8Array(xisoFixture().length + 65536);
  xiso.set(xisoFixture());
  const workflow = new TrimWorkflow({
    settings: {
      output: { compression: "chd", outputName: "game (trimmed).chd", ...extra },
      workers: { threads: 1 },
    },
  });
  try {
    await workflow.setInput(new File([xiso], "game.iso"));
    expect(workflow.getInput()?.trimSupported).toBe(true);
    await expect(workflow.run()).rejects.toThrow(/XISO/);
  } finally {
    await workflow.dispose();
  }
});

// A plain `.iso` XISO is staged as raw bytes, so the Xbox platform must be tagged on the input itself: it is
// what keeps CHD out of the format lists of every workflow that reads the staged input.
test("a staged XISO carries the Xbox platform", async () => {
  const xiso = new Uint8Array(xisoFixture().length + 65536);
  xiso.set(xisoFixture());
  const workflow = new TrimWorkflow({ settings: { workers: { threads: 1 } } });
  try {
    await workflow.setInput(new File([xiso], "game.iso"));
    expect(workflow.getInput()?.romType?.platform).toBe("Microsoft Xbox");
  } finally {
    await workflow.dispose();
  }
});

test("trim of an XISO into ZIP still works", async () => {
  const xiso = new Uint8Array(xisoFixture().length + 65536);
  xiso.set(xisoFixture());
  const workflow = new TrimWorkflow({
    settings: { output: { compression: "zip", outputName: "game (trimmed).zip" }, workers: { threads: 1 } },
  });
  try {
    await workflow.setInput(new File([xiso], "game.iso"));
    const result = await workflow.run();
    try {
      expect(result.output.fileName).toBe("game (trimmed).zip");
      expect(result.sizeSummary.rawSize).toBeLessThan(xiso.length);
      const header = new DataView(await (await result.output.getBlob()).slice(0, 4).arrayBuffer());
      expect(header.getUint32(0, true)).toBe(0x04034b50);
    } finally {
      await result.output.dispose();
    }
  } finally {
    await workflow.dispose();
  }
});

test("trim applies edited ZIP Store settings to an already staged input", async () => {
  const workflow = new TrimWorkflow({
    settings: { output: { compression: "zip", outputName: "trimmed.zip" }, workers: { threads: 1 } },
  });
  try {
    await workflow.setInput(new File([buildTestNdsRom()], "game.nds"));
    await workflow.setSettings({ output: { container: { zipCodec: "store", zipLevel: 0 } }, workers: { threads: 1 } });
    const result = await workflow.run();
    try {
      const blob = await result.output.getBlob();
      const header = new DataView(await blob.slice(0, 30).arrayBuffer());
      expect(header.getUint32(0, true)).toBe(0x04034b50);
      expect(header.getUint16(8, true)).toBe(0);
    } finally {
      await result.output.dispose();
    }
  } finally {
    await workflow.dispose();
  }
});

test("trim flags unsupported input at staging and clears the flag when the source changes", async () => {
  const workflow = new TrimWorkflow({ settings: { output: { compression: "none" }, workers: { threads: 1 } } });
  try {
    await workflow.setInput(new File([new Uint8Array(5000).fill(7)], "plain.bin"));
    expect(workflow.getInput().trimSupported).toBe(false);
    expect(workflow.getInput().warnings.map((warning) => warning.message)).toContain(
      "This input does not support trimming",
    );
    await workflow.setInput(new File([buildTestNdsRom()], "game.nds"));
    expect(workflow.getInput().trimSupported).toBe(true);
    expect(workflow.getInput().warnings).toEqual([]);
  } finally {
    await workflow.dispose();
  }
});

test("trim rejects unsupported input and allows a successful retry", async () => {
  const workflow = new TrimWorkflow({
    settings: { output: { compression: "none" }, workers: { threads: 1 } },
  });
  try {
    await workflow.setInput(new File(["abc"], "unsupported.bin"));
    await expect(workflow.run()).rejects.toThrow("This input does not support trimming");
    await workflow.setInput(new File([buildTestNdsRom()], "game.nds"));
    const result = await workflow.run();
    try {
      expect(result.output.size).toBe(0x3000 + REVERT_FOOTER_BYTES);
      const blob = await result.output.getBlob();
      expect(new Uint8Array(await blob.arrayBuffer()).subarray(0, 0x3000)).toEqual(
        buildTestNdsRom().subarray(0, 0x3000),
      );
    } finally {
      await result.output.dispose();
    }
    await workflow.setInput(new File([buildTestNdsRom().subarray(0, 0x3000)], "already-trimmed.nds"));
    // An already-trimmed ROM defaults to restoring its padding; trimming it again changes nothing.
    await workflow.setMode("trim");
    const unchanged = await workflow.run();
    try {
      expect(unchanged.output.size).toBe(0x3000);
    } finally {
      await unchanged.output.dispose();
    }
  } finally {
    await workflow.dispose();
  }
});

test("trim staging settles for an empty file and the next file", async () => {
  const workflow = new TrimWorkflow({
    settings: { output: { compression: "none" }, workers: { threads: 1 } },
  });
  try {
    await Promise.race([
      workflow.setInput(new File([], "empty.bin")),
      new Promise((_, reject) => setTimeout(() => reject(new Error("empty staging hung")), 20000)),
    ]);
    expect(workflow.getInput()?.size).toBe(0);
    await workflow.setInput(new File([buildTestNdsRom()], "game.nds"));
    expect(workflow.getInput()?.checksums).toBeTruthy();
  } finally {
    await workflow.dispose();
  }
}, 60000);

// `RW` revert footer: fill byte, 40-bit LE padding length, CRC-32 of the first 8 bytes.
const appendRevertFooter = (data, padLength, padByte) => {
  const footer = new Uint8Array(12);
  footer.set([0x52, 0x57, padByte], 0);
  for (let index = 0; index < 5; index++) footer[3 + index] = Math.floor(padLength / 256 ** index) & 0xff;
  let crc = 0xffffffff;
  for (const byte of footer.subarray(0, 8)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  writeLe32(footer, 8, ~crc >>> 0);
  const marked = new Uint8Array(data.length + footer.length);
  marked.set(data, 0);
  marked.set(footer, data.length);
  return marked;
};

const readOutputBytes = async (output) => new Uint8Array(await (await output.getBlob()).arrayBuffer());

test("trim stages an already-trimmed ROM for restore and pads it back", async () => {
  const workflow = new TrimWorkflow({ settings: { output: { compression: "none" }, workers: { threads: 1 } } });
  try {
    await workflow.setInput(new File([buildTestNdsRom()], "game.nds"));
    expect(workflow.getInput()).toMatchObject({ paddingTrimmed: false, restoreSupported: true });
    expect(workflow.getSnapshot().mode).toBe("trim");

    const trimmed = buildTestNdsRom().subarray(0, 0x3000);
    await workflow.setInput(new File([trimmed], "game (trimmed).nds"));
    expect(workflow.getInput()).toMatchObject({ paddingTrimmed: true, restoreSupported: true });
    expect(workflow.getSnapshot()).toMatchObject({ mode: "restore", outputName: "game.nds" });
    const result = await workflow.run();
    try {
      const bytes = await readOutputBytes(result.output);
      expect(result.output.fileName).toBe("game.nds");
      expect(bytes.length).toBe(0x4000);
      expect(bytes.subarray(0, 0x3000)).toEqual(trimmed);
      expect(bytes.subarray(0x3000).every((byte) => byte === 0xff)).toBe(true);
    } finally {
      await result.output.dispose();
    }

    await workflow.setMode("trim");
    const unchanged = await workflow.run();
    try {
      expect(unchanged.output.size).toBe(0x3000);
    } finally {
      await unchanged.output.dispose();
    }
  } finally {
    await workflow.dispose();
  }
});

test("trim restores a revert-marked ROM byte for byte", async () => {
  const original = buildTestNdsRom().subarray(0, 0x4000).slice();
  original.fill(0x00, 0x3000);
  const marked = appendRevertFooter(original.subarray(0, 0x3000), 0x1000, 0x00);
  const workflow = new TrimWorkflow({ settings: { output: { compression: "none" }, workers: { threads: 1 } } });
  try {
    await workflow.setInput(new File([marked], "game.nds"));
    expect(workflow.getInput()).toMatchObject({ paddingTrimmed: true, restoreSupported: true });
    expect(workflow.getSnapshot()).toMatchObject({ mode: "restore", outputName: "game (restored).nds" });
    const result = await workflow.run();
    try {
      expect(await readOutputBytes(result.output)).toEqual(original);
    } finally {
      await result.output.dispose();
    }
  } finally {
    await workflow.dispose();
  }
});

test("trim offers no restore for an XISO", async () => {
  const workflow = new TrimWorkflow({ settings: { output: { compression: "none" }, workers: { threads: 1 } } });
  try {
    const xiso = new Uint8Array(xisoFixture().length + 65536);
    xiso.set(xisoFixture());
    await workflow.setInput(new File([xiso], "game.iso"));
    expect(workflow.getInput()).toMatchObject({ paddingTrimmed: false, restoreSupported: false, trimSupported: true });
    expect(workflow.getSnapshot().mode).toBe("trim");
    await workflow.setMode("restore");
    await expect(workflow.run()).rejects.toThrow("This input does not support restoring padding");
  } finally {
    await workflow.dispose();
  }
});

test("trim writes a revert marker that a later restore uses to rebuild the original", async () => {
  // 0x00 padding: a restore without the marker would rebuild 0xFF and miss the original.
  const original = buildTestNdsRom().subarray(0, 0x4000).slice();
  original.fill(0x00, 0x3000);
  const workflow = new TrimWorkflow({ settings: { output: { compression: "none" }, workers: { threads: 1 } } });
  try {
    await workflow.setInput(new File([original], "game.nds"));
    expect(workflow.getSnapshot().mode).toBe("trim");
    const trimmed = await workflow.run();
    let trimmedBytes;
    try {
      trimmedBytes = await readOutputBytes(trimmed.output);
    } finally {
      await trimmed.output.dispose();
    }
    expect(trimmedBytes.length).toBe(0x3000 + REVERT_FOOTER_BYTES);
    expect(trimmedBytes.subarray(0, 0x3000)).toEqual(original.subarray(0, 0x3000));
    expect(new TextDecoder().decode(trimmedBytes.subarray(0x3000, 0x3002))).toBe("RW");

    await workflow.setInput(new File([trimmedBytes], "game (trimmed).nds"));
    expect(workflow.getInput()).toMatchObject({ paddingTrimmed: true, restoreSupported: true });
    expect(workflow.getSnapshot().mode).toBe("restore");
    const restored = await workflow.run();
    try {
      expect(await readOutputBytes(restored.output)).toEqual(original);
    } finally {
      await restored.output.dispose();
    }
  } finally {
    await workflow.dispose();
  }
});
