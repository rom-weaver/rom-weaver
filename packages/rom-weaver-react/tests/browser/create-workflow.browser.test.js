import { expect, test } from "vitest";
import {
  CREATE_IPS_SIZE_LIMIT_BYTES,
  CREATE_LEGACY_PATCH_SIZE_LIMIT_BYTES,
} from "../../src/lib/create/patch-format-limits.ts";
import { CreateWorkflow } from "../../src/platform/browser/browser-api.ts";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";

const makeOriginalBytes = () => new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

const makeModifiedBytes = () => {
  const bytes = makeOriginalBytes();
  bytes[3] = 0xaa;
  bytes[9] = 0xbb;
  bytes[15] = 0xcc;
  return bytes;
};
const ORIGINAL_CHECKSUMS = {
  crc32: "cecee288",
  md5: "1ac1ef01e96caf1be0d329331a4fc2a8",
  sha1: "56178b86a57fac22899a9964185c2cc96e7da589",
};
const MODIFIED_CHECKSUMS = {
  crc32: "efc84b01",
  md5: "9417a3d9e55d8c586b3b750d64b2f9ec",
  sha1: "63dec8064d395c1ca14b482ea8055ca77ee6cda1",
};

const createSizeOnlyFile = (name, size) => {
  const file = new File([new Uint8Array([0])], name, { type: "application/octet-stream" });
  Object.defineProperty(file, "size", { configurable: true, value: size });
  return file;
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
  if (!output) throw new Error("Failed to create archive fixture");
  try {
    const blob = await browserRuntime.publicOutput.getBlob(output);
    return new File([blob], outputName, { type: "application/zip" });
  } finally {
    await output.cleanup?.().catch(() => undefined);
  }
};

const createTraceWorkflow = (output, workerThreads = 1) => {
  const logs = [];
  const workflow = new CreateWorkflow({
    settings: {
      format: "ips",
      logging: {
        level: "trace",
        sink: (record) => logs.push(record || {}),
      },
      output,
      workers: {
        threads: workerThreads,
      },
    },
  });
  return { logs, workflow };
};

test("create workflow extracts archived original and modified inputs before patch create", async () => {
  const { logs, workflow } = createTraceWorkflow({
    compression: "none",
    outputName: "change.ips",
  });
  try {
    const originalArchive = await createZipFile("original.bin", makeOriginalBytes(), "original.zip");
    const modifiedArchive = await createZipFile("modified.bin", makeModifiedBytes(), "modified.zip");

    await workflow.setOriginal(originalArchive);
    await workflow.setModified(modifiedArchive);

    expect(workflow.getOriginal()?.fileName).toBe("original.bin");
    expect(workflow.getOriginal()?.wasDecompressed).toBe(true);
    expect(workflow.getModified()?.fileName).toBe("modified.bin");
    expect(workflow.getModified()?.wasDecompressed).toBe(true);

    const result = await workflow.run();
    expect(result.type).toBe("ips");
    expect(result.output.fileName).toBe("change.ips");
    expect(result.sizeSummary?.rawSize).toBe(result.output.size);
    await result.output.dispose();

    const createDispatch = logs.find((entry) => String(entry?.message || "") === "runJson patch-create dispatch");
    expect(createDispatch?.details?.originalFilePath).toMatch(/original\.bin$/i);
    expect(createDispatch?.details?.originalFilePath).not.toMatch(/\.zip$/i);
    expect(createDispatch?.details?.modifiedFilePath).toMatch(/modified\.bin$/i);
    expect(createDispatch?.details?.modifiedFilePath).not.toMatch(/\.zip$/i);
  } finally {
    await workflow.dispose();
  }
});

test("create workflow supports raw and zip output compression", async () => {
  const original = new File([makeOriginalBytes()], "original.bin", { type: "application/octet-stream" });
  const modified = new File([makeModifiedBytes()], "modified.bin", { type: "application/octet-stream" });
  const rawWorkflow = createTraceWorkflow({
    compression: "none",
    outputName: "change.ips",
  }).workflow;
  try {
    await rawWorkflow.setOriginal(original);
    await rawWorkflow.setModified(modified);
    expect(rawWorkflow.getOriginal()?.checksums).toEqual(ORIGINAL_CHECKSUMS);
    expect(rawWorkflow.getModified()?.checksums).toEqual(MODIFIED_CHECKSUMS);
    expect(rawWorkflow.getOriginal()?.checksumTimeMs).toEqual(expect.any(Number));
    expect(rawWorkflow.getModified()?.checksumTimeMs).toEqual(expect.any(Number));
    const rawResult = await rawWorkflow.run();
    expect(rawResult.output.fileName).toBe("change.ips");
    expect(rawResult.sizeSummary?.rawSize).toBe(rawResult.output.size);
    await rawResult.output.dispose();
  } finally {
    await rawWorkflow.dispose();
  }

  const zipWorkflow = createTraceWorkflow({
    compression: "zip",
    outputName: "change.zip",
  }).workflow;
  try {
    await zipWorkflow.setOriginal(original);
    await zipWorkflow.setModified(modified);
    const zipResult = await zipWorkflow.run();
    expect(zipResult.output.fileName).toBe("change.zip");
    expect(zipResult.sizeSummary?.rawSize).toBeGreaterThan(0);
    expect(zipResult.output.size).toBeGreaterThan(zipResult.sizeSummary?.rawSize || 0);
    const blob = await zipResult.output.getBlob?.();
    const header = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    expect([...header]).toEqual([0x50, 0x4b]);
    await zipResult.output.dispose();
  } finally {
    await zipWorkflow.dispose();
  }
});

test("create workflow caps zip zstd max output to one browser thread before dispatch", async () => {
  const original = new File([makeOriginalBytes()], "original.bin", { type: "application/octet-stream" });
  const modified = new File([makeModifiedBytes()], "modified.bin", { type: "application/octet-stream" });
  const { logs, workflow } = createTraceWorkflow(
    {
      compression: "zip",
      container: {
        zipCodec: "zstd",
        zipLevel: 22,
      },
      outputName: "change.zip",
    },
    4,
  );
  try {
    await workflow.setOriginal(original);
    await workflow.setModified(modified);
    const result = await workflow.run();
    expect(result.output.fileName).toBe("change.zip");
    await result.output.dispose();

    const capLog = logs.find(
      (entry) => String(entry?.message || "") === "runJson compress normalized browser thread cap",
    );
    expect(capLog?.details).toMatchObject({
      format: "zip",
      requestedThreadArg: 4,
      threadArg: 1,
      threadCap: 1,
      zipZstdLevel: 22,
    });

    const compressDispatch = logs.find((entry) => String(entry?.message || "") === "runJson compress dispatch");
    expect(compressDispatch?.details).toMatchObject({
      command: {
        args: {
          threads: 1,
        },
        type: "compress",
      },
      format: "zip",
      threadArg: 1,
    });
  } finally {
    await workflow.dispose();
  }
});

test("create workflow supports 7z output compression with auto browser threads", async () => {
  const original = new File([makeOriginalBytes()], "original.bin", { type: "application/octet-stream" });
  const modified = new File([makeModifiedBytes()], "modified.bin", { type: "application/octet-stream" });
  const workflow = createTraceWorkflow(
    {
      compression: "7z",
      outputName: "change.7z",
    },
    "auto",
  ).workflow;
  try {
    await workflow.setOriginal(original);
    await workflow.setModified(modified);
    const result = await workflow.run();
    expect(result.output.fileName).toBe("change.7z");
    expect(result.sizeSummary?.rawSize).toBeGreaterThan(0);
    const blob = await result.output.getBlob?.();
    const header = new Uint8Array(await blob.slice(0, 6).arrayBuffer());
    expect([...header]).toEqual([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
    await result.output.dispose();
  } finally {
    await workflow.dispose();
  }
});

test("create workflow defaults output names to the modified source", async () => {
  const original = new File([makeOriginalBytes()], "original.bin", { type: "application/octet-stream" });
  const modified = new File([makeModifiedBytes()], "modified.bin", { type: "application/octet-stream" });
  const rawWorkflow = createTraceWorkflow({
    compression: "none",
  }).workflow;
  try {
    await rawWorkflow.setOriginal(original);
    await rawWorkflow.setModified(modified);
    const rawResult = await rawWorkflow.run();
    expect(rawResult.output.fileName).toBe("modified.ips");
    await rawResult.output.dispose();
  } finally {
    await rawWorkflow.dispose();
  }

  const zipWorkflow = createTraceWorkflow({
    compression: "zip",
  }).workflow;
  try {
    await zipWorkflow.setOriginal(original);
    await zipWorkflow.setModified(modified);
    const zipResult = await zipWorkflow.run();
    expect(zipResult.output.fileName).toBe("modified.ips.zip");
    await zipResult.output.dispose();
  } finally {
    await zipWorkflow.dispose();
  }
});

test("create workflow steers IPS-family formats away from 16.8 MB and larger inputs", async () => {
  const workflow = createTraceWorkflow({
    compression: "none",
    outputName: "change.ips",
  }).workflow;
  try {
    await workflow.setOriginal(createSizeOnlyFile("large-original.nds", CREATE_IPS_SIZE_LIMIT_BYTES));
    await workflow.setModified(createSizeOnlyFile("large-modified.nds", 1));
    await workflow.setPatchType("ips");

    await expect(workflow.run()).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
      message: expect.stringContaining("at or above 16.8 MB"),
    });
  } finally {
    await workflow.dispose();
  }
});

test("create workflow limits over-268.4 MB inputs to xdelta and ppf", async () => {
  const workflow = createTraceWorkflow({
    compression: "none",
    outputName: "change.bps",
  }).workflow;
  try {
    await workflow.setOriginal(createSizeOnlyFile("large-original.nds", CREATE_LEGACY_PATCH_SIZE_LIMIT_BYTES + 1));
    await workflow.setModified(createSizeOnlyFile("large-modified.nds", 1));
    await workflow.setPatchType("bps");

    await expect(workflow.run()).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
      message: expect.stringContaining("xdelta or PPF"),
    });
  } finally {
    await workflow.dispose();
  }
});
