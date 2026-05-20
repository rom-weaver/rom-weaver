import { encodeText as encodeWorkerText } from "../../storage/shared/binary/text-encoding.ts";
import { getManagedOpfsFileHandle } from "../protocol/opfs-path.ts";
import { hasNodeWorkerRuntimePathReadSupport, readNodeWorkerFileChunk } from "./node-worker-runtime.ts";

const PATH_DIRECTORY_PREFIX_REGEX = /^.*[/\\]/;

const toWorkerUint8Array = (bytes: Uint8Array | ArrayBuffer | ArrayBufferView) => {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
};

const readWorkerBlobBytes = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

const CHUNK_SIZE = 8 * 1024 * 1024;

const concatChunks = (chunks: Uint8Array[], size: number) => {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const readWorkerPathBytes = (filePath: string) => {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (;;) {
    const chunk = toWorkerUint8Array(readNodeWorkerFileChunk(filePath, offset, CHUNK_SIZE));
    if (!chunk.byteLength) break;
    chunks.push(chunk);
    offset += chunk.byteLength;
    if (chunk.byteLength < CHUNK_SIZE) break;
  }
  return concatChunks(chunks, offset);
};

const readOpfsPathBytes = async (filePath: string) => {
  const fileHandle = await getManagedOpfsFileHandle(filePath, { navigatorObject: navigator });
  if (!fileHandle || typeof fileHandle.createSyncAccessHandle !== "function") return null;
  let accessHandle: FileSystemSyncAccessHandle;
  try {
    accessHandle = await fileHandle.createSyncAccessHandle();
  } catch (error) {
    throw new Error(
      `OPFS read createSyncAccessHandle failed for ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  try {
    const size = accessHandle.getSize();
    const bytes = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const chunkLength = Math.min(CHUNK_SIZE, size - offset);
      offset += accessHandle.read(bytes.subarray(offset, offset + chunkLength), { at: offset });
    }
    return bytes;
  } finally {
    accessHandle.close();
  }
};

const readWorkerPathBytesAsync = async (filePath: string) => {
  if (hasNodeWorkerRuntimePathReadSupport()) return readWorkerPathBytes(filePath);
  const opfsBytes = await readOpfsPathBytes(filePath);
  if (opfsBytes) return opfsBytes;
  throw new Error("Worker path reads are not available");
};

const getWorkerPathBaseName = (filePath: string) => filePath.replace(PATH_DIRECTORY_PREFIX_REGEX, "") || filePath;

export {
  encodeWorkerText,
  getWorkerPathBaseName,
  readWorkerBlobBytes,
  readWorkerPathBytes,
  readWorkerPathBytesAsync,
  toWorkerUint8Array,
};
