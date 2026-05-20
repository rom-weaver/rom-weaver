import type {
  ArchiveExtractionResult,
  BrowserFileLike,
  NormalizedArchiveExtractionResult,
  ProgressCallback,
} from "../../types/runtime.ts";
import { createTiming, now } from "../shared/timing.ts";
import { extractArchiveFileEntryToFile } from "./archive-input.ts";

type BrowserArchiveSource = BrowserFileLike | FileSystemFileHandle | string;
type WorkerFallbackError = Error | object | string | number | boolean | null | undefined;
type CompressionWorkerPayload = {
  file: BrowserArchiveSource;
  entryName: string;
  threads?: number;
};

type ArchiveExtractionOptions = {
  ArchiveManager: {
    configure?: (options: { threads?: number }) => void;
    extractEntryToFile: (
      file: BrowserArchiveSource,
      entryName: string,
      options?: { onProgress?: ProgressCallback },
    ) => Promise<ArchiveExtractionResult>;
  };
  cleanupWorkerFiles?: (filePaths: string[]) => void | Promise<void>;
  entryName: string;
  file: BrowserArchiveSource;
  onProgress?: ProgressCallback;
  onWorkerFallback?: (action: string, err: WorkerFallbackError) => void;
  resetWorker?: () => void;
  runWorker?: (
    action: "extract",
    data: CompressionWorkerPayload,
    onProgress?: ProgressCallback,
  ) => Promise<ArchiveExtractionResult>;
  threads?: number;
};

const isBrowserBlob = (value: Blob | ArrayBufferLike | Uint8Array | File | undefined): value is BrowserFileLike =>
  !!(
    value &&
    typeof value === "object" &&
    "size" in value &&
    typeof value.size === "number" &&
    "slice" in value &&
    typeof value.slice === "function"
  );

const toUint8Array = (
  value: ArchiveExtractionResult["u8array"] | ArchiveExtractionResult["data"],
): Uint8Array | undefined => (value instanceof Uint8Array ? value : undefined);

const getEntry = (value: ArchiveExtractionResult["entry"]): { filename?: string } | null =>
  value && typeof value === "object" ? { filename: value.filename } : null;

const normalizeArchiveExtractionResult = ({
  result,
  entryName,
  cleanupWorkerFiles,
}: {
  result?: ArchiveExtractionResult | null;
  entryName: string;
  cleanupWorkerFiles?: (filePaths: string[]) => void | Promise<void>;
}): NormalizedArchiveExtractionResult => {
  const cleanupPaths = result?.cleanupPaths || null;
  const file = isBrowserBlob(result?.file)
    ? result.file
    : (() => {
        if (isBrowserBlob(result?.blob)) {
          return result.blob;
        }
        return undefined;
      })();
  const data = toUint8Array(result?.u8array) || toUint8Array(result?.data);
  const cleanup =
    typeof result?.cleanup === "function"
      ? () => {
          result.cleanup?.();
        }
      : (() => {
          if (cleanupPaths?.length && typeof cleanupWorkerFiles === "function") {
            return () => {
              cleanupWorkerFiles(cleanupPaths);
            };
          }
          return undefined;
        })();
  return {
    blob: file,
    cleanup,
    cleanupPaths,
    data,
    entry: getEntry(result?.entry),
    file,
    fileName: result?.fileName || entryName,
    filename: entryName,
    size: result?.size,
    timing: result?.timing || null,
    u8array: data,
  };
};

const assertFileBackedExtractionResult = (result: NormalizedArchiveExtractionResult) => {
  if (result.file || result.blob) return result;
  throw new Error("Archive extraction must return a File or OPFS-backed output");
};

const extractBrowserArchiveEntry = async ({
  ArchiveManager,
  file,
  entryName,
  threads,
  onProgress,
  runWorker,
  onWorkerFallback,
  resetWorker,
  cleanupWorkerFiles,
}: ArchiveExtractionOptions) => {
  const runDirect = async () => {
    const startedAt = now();
    if (typeof ArchiveManager.configure === "function") ArchiveManager.configure({ threads });
    const result = await extractArchiveFileEntryToFile({
      ArchiveManager,
      entryName,
      file,
      onProgress,
    });
    const directResult = (result || {}) as ArchiveExtractionResult;
    return normalizeArchiveExtractionResult({
      cleanupWorkerFiles,
      entryName,
      result: Object.assign({}, directResult, {
        timing: directResult.timing || createTiming(now() - startedAt),
      }),
    });
  };

  if (typeof runWorker === "function") {
    try {
      const result = await runWorker(
        "extract",
        {
          entryName,
          file,
          threads,
        },
        onProgress,
      );
      return assertFileBackedExtractionResult(
        normalizeArchiveExtractionResult({ cleanupWorkerFiles, entryName, result }),
      );
    } catch (err) {
      if (typeof onWorkerFallback === "function") onWorkerFallback("extract", err instanceof Error ? err : String(err));
      if (typeof resetWorker === "function") resetWorker();
    }
  }

  return runDirect().then(assertFileBackedExtractionResult);
};

export { extractBrowserArchiveEntry };
