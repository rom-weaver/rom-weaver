import { expect, test } from "vitest";
import { TrimWorkflow } from "../../src/platform/browser/browser-api.ts";
import { warmupBrowserRuntimeExtraction } from "../../src/platform/browser/browser-runtime-warmup.ts";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";

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
      workerThreads: 1,
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

    const result = await workflow.run();
    expect(result.output.fileName).toBe("game (trimmed).nds");
    expect(result.output.size).toBe(0x3000);
    expect(result.sizeSummary?.inputSize).toBe(0x5000);
    expect(result.sizeSummary?.outputSize).toBe(0x3000);
    expect(result.sizeSummary?.rawSize).toBe(0x3000);
    await result.output.dispose();

    const trimDispatch = logs.find((entry) => String(entry?.message || "") === "runJson trim dispatch");
    const trimSource = trimDispatch?.details?.command?.args?.source?.[0] || "";
    const trimOutput = trimDispatch?.details?.command?.args?.output || "";
    expect(trimSource).toMatch(/game\.nds$/i);
    expect(trimSource).not.toMatch(/\.zip$/i);
    expect(trimOutput).toMatch(/game \(trimmed\)\.nds$/i);
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
