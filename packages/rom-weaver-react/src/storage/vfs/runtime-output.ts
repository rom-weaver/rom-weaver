import { getPathBaseName } from "../../lib/path-utils.ts";
import type { SourceRef } from "../../types/source.ts";
import type { PublicOutput } from "../../types/workflow-runtime.ts";
import { copySourceToWriter } from "../shared/binary/binary-source-utils.ts";
import { getNamedSource } from "../shared/binary/source-file-utils.ts";
import { createCleanupOnce } from "../shared/disposal.ts";
import { joinVfsPath } from "./path.ts";
import { isVfsFileRef } from "./source-ref.ts";

const OUTPUT_CHUNK_SIZE = 8 * 1024 * 1024;

const attachRuntimeCleanup = (
  output: Omit<PublicOutput, "cleanup">,
  cleanup?: () => Promise<void> | void,
): PublicOutput => {
  const baseDispose = output.dispose.bind(output);
  const dispose = createCleanupOnce(async () => {
    await baseDispose();
    await Promise.resolve(cleanup?.());
  });
  return Object.assign(output, {
    cleanup: dispose,
    dispose,
  });
};

const getOutputFileName = (fileName: string, fallback = "output.bin") => {
  return getPathBaseName(fileName, fallback);
};

const createRuntimeOutputPath = (rootPath: string, fileName: string, _pathPrefix = "runtime-output") => {
  return joinVfsPath(rootPath, getOutputFileName(fileName));
};

const createOutputPathCleanup =
  (vfs: PublicOutput["vfs"], filePath: string, cleanup?: () => Promise<void> | void) => async () => {
    await Promise.resolve(cleanup?.()).catch(() => undefined);
    await vfs.remove(filePath).catch(() => undefined);
  };

const createRuntimeOutputRef = async (
  outputRefPromise: Promise<Omit<PublicOutput, "cleanup">> | Omit<PublicOutput, "cleanup">,
  cleanup?: () => Promise<void> | void,
): Promise<PublicOutput> => {
  const output = await outputRefPromise;
  return attachRuntimeCleanup(output, cleanup);
};

const createRuntimeOutputFromVfs = async (
  vfs: PublicOutput["vfs"],
  filePath: string,
  fileName: string,
  options: {
    checksums?: Record<string, string>;
    cleanup?: () => Promise<void> | void;
    mediaType?: string;
    size?: number;
  } = {},
): Promise<PublicOutput> => createRuntimeOutputRef(vfs.createOutputRef(filePath, fileName, options), options.cleanup);

const createRuntimeOutputFromBytes = async (
  vfs: PublicOutput["vfs"],
  bytes: Uint8Array,
  fileName: string,
  options: {
    cleanup?: () => Promise<void> | void;
    mediaType?: string;
    pathPrefix?: string;
  } = {},
): Promise<PublicOutput> => {
  const outputPath = createRuntimeOutputPath(vfs.rootPath, fileName, options.pathPrefix);
  await vfs.truncate(outputPath, 0);
  if (bytes.byteLength) await vfs.write(outputPath, bytes, { fileOffset: 0 });
  return createRuntimeOutputFromVfs(vfs, outputPath, fileName, {
    cleanup: createOutputPathCleanup(vfs, outputPath, options.cleanup),
    mediaType: options.mediaType,
    size: bytes.byteLength,
  });
};

const createRuntimeOutputFromSource = async (
  vfs: PublicOutput["vfs"],
  source: SourceRef,
  fallbackFileName: string,
  options: {
    cleanup?: () => Promise<void> | void;
    mediaType?: string;
    pathPrefix?: string;
  } = {},
): Promise<PublicOutput> => {
  const directSource = getNamedSource(source as Parameters<typeof getNamedSource>[0]);
  const vfsSource = isVfsFileRef(directSource) ? directSource : isVfsFileRef(source) ? source : null;
  if (vfsSource && vfsSource.vfs === vfs) {
    const fileName = vfsSource.fileName || fallbackFileName;
    return createRuntimeOutputFromVfs(vfs, vfsSource.path, fileName, {
      cleanup: createOutputPathCleanup(vfs, vfsSource.path, options.cleanup),
      mediaType: options.mediaType || vfsSource.mediaType,
    });
  }
  const outputPath = createRuntimeOutputPath(vfs.rootPath, fallbackFileName, options.pathPrefix);
  await vfs.truncate(outputPath, 0);
  const size = vfsSource
    ? await (async () => {
        const stat = await vfsSource.vfs.stat(vfsSource.path);
        const total = Math.max(0, Math.floor(stat?.size || 0));
        const buffer = new Uint8Array(OUTPUT_CHUNK_SIZE);
        let offset = 0;
        while (offset < total) {
          const bytesRead = await vfsSource.vfs.read(vfsSource.path, buffer, {
            fileOffset: offset,
            length: Math.min(buffer.byteLength, total - offset),
          });
          if (!bytesRead) break;
          await vfs.write(outputPath, buffer.subarray(0, bytesRead), { fileOffset: offset });
          offset += bytesRead;
        }
        return offset;
      })()
    : await copySourceToWriter(
        source,
        async (bytes, offset) => {
          await vfs.write(outputPath, bytes, { fileOffset: offset });
        },
        {
          chunkSize: OUTPUT_CHUNK_SIZE,
        },
      );
  return createRuntimeOutputFromVfs(vfs, outputPath, fallbackFileName, {
    cleanup: createOutputPathCleanup(vfs, outputPath, options.cleanup),
    mediaType: options.mediaType,
    size,
  });
};

const readRuntimeOutputBytes = async (output: Pick<PublicOutput, "path" | "size" | "vfs">): Promise<Uint8Array> => {
  const size = Math.max(0, Math.floor(output.size || 0));
  if (!size) return new Uint8Array(0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const nextLength = Math.min(OUTPUT_CHUNK_SIZE, size - offset);
    const bytesRead = await output.vfs.read(output.path, bytes, {
      bufferOffset: offset,
      fileOffset: offset,
      length: nextLength,
    });
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return offset === bytes.byteLength ? bytes : bytes.subarray(0, offset);
};

const readRuntimeOutputBlob = async (
  output: Pick<PublicOutput, "mediaType" | "path" | "size" | "vfs">,
): Promise<Blob> => {
  const bytes = await readRuntimeOutputBytes(output);
  const blobBytes = new Uint8Array(bytes.byteLength);
  blobBytes.set(bytes);
  return new Blob([blobBytes.buffer], {
    type: output.mediaType || "application/octet-stream",
  });
};

const getRuntimeOutputStorage = (output: Pick<PublicOutput, "vfs">) =>
  output.vfs.hostKind === "browser-opfs" ? "opfs" : "file";

export {
  createRuntimeOutputFromBytes,
  createRuntimeOutputFromSource,
  createRuntimeOutputFromVfs,
  createRuntimeOutputPath,
  getRuntimeOutputStorage,
  readRuntimeOutputBlob,
  readRuntimeOutputBytes,
};
