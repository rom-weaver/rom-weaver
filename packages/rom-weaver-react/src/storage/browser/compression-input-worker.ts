import type { ProgressCallback } from "../../types/runtime.ts";
import { createBrowserOpfsSourceRef } from "../../workers/protocol/browser-opfs-source-ref.ts";
import { getManagedOpfsFileHandle } from "../../workers/protocol/opfs-path.ts";
import { WORKER_OPFS_MOUNTPOINT } from "../../workers/shared/worker-storage/storage-layout.ts";

type Timing = {
  elapsedMs: number;
  elapsedSeconds: number;
};

type CompressionInputKind = "chd" | "rvz" | "z3ds";

type BrowserCompressionDecompressWorkerInput = {
  file: File | FileSystemFileHandle;
  fileName: string;
  kind: CompressionInputKind;
  onProgress?: ProgressCallback;
  threads?: string | number | null;
};

type BrowserCompressionDecompressWorkerResult = {
  cleanup: () => Promise<void>;
  file: Blob;
  fileName: string;
  timing?: Partial<Timing> | null;
};

type WorkerDecompressionResult = {
  cleanup?: () => Promise<void> | void;
  fileName?: string;
  filePath?: string;
  outputRef?: {
    fileName: string;
    filePath?: string;
    kind?: "file" | "opfs";
  };
  timing?: Partial<Timing> | null;
};

const decompressInputInBrowserWorker = async (
  input: BrowserCompressionDecompressWorkerInput,
): Promise<BrowserCompressionDecompressWorkerResult> => {
  const source = await createBrowserOpfsSourceRef(input.file, input.fileName, {
    mountPoint: WORKER_OPFS_MOUNTPOINT,
    pathPrefix: "decompress-input",
  });
  let result: WorkerDecompressionResult;
  try {
    if (input.kind === "rvz") {
      result = await (await import("../../workers/protocol/rvz-worker.ts")).extractRvzInWorker(
        {
          fileName: source.fileName,
          source: source.filePath,
          threads: input.threads,
        },
        input.onProgress,
      );
    } else if (input.kind === "z3ds") {
      result = await (await import("../../workers/protocol/z3ds-worker.ts")).extractZ3dsInWorker(
        {
          fileName: source.fileName,
          source: source.filePath,
          threads: input.threads,
        },
        input.onProgress,
      );
    } else {
      result = await (await import("../../workers/protocol/chd-worker.ts")).extractChdInWorker(
        {
          fileName: source.fileName,
          mode: "auto",
          source: source.filePath,
          threads: input.threads,
        },
        input.onProgress,
      );
    }
    const outputFilePath = result.outputRef?.filePath || result.filePath;
    if ((result as { file?: Blob | null }).file instanceof Blob)
      throw new Error("Compression worker returned a binary payload");
    if (!(outputFilePath && result.outputRef?.kind === "opfs"))
      throw new Error("Compression decompression worker did not return browser output");
    const outputFile = (await getManagedOpfsFileHandle(outputFilePath, { navigatorObject: navigator }))?.getFile();
    if (!outputFile) throw new Error("Compression decompression worker did not return browser output");
    return {
      cleanup: async () => {
        await Promise.resolve(result.cleanup?.());
        await source.cleanup().catch(() => undefined);
      },
      file: await outputFile,
      fileName: result.outputRef?.fileName || result.fileName || input.fileName,
      timing: result.timing || null,
    };
  } catch (error) {
    await source.cleanup().catch(() => undefined);
    throw error;
  }
};

export { decompressInputInBrowserWorker };
