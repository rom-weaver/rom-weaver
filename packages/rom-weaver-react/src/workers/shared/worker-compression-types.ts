import type { JsonValue } from "../../types/runtime.ts";
import type { EmscriptenWorkerModule } from "./wasm/emscripten-types.ts";
import { WORKER_OPFS_MOUNTPOINT } from "./worker-storage/storage-layout.ts";

type WorkerScalar = string | number | boolean | null | undefined;
type WorkerErrorLike = Error | string | object | Event | PromiseRejectionEvent | null | undefined;

type WorkerMessage = {
  action?: string;
  error?: { code?: string; details?: Record<string, unknown>; message?: string };
  requestId?: string;
  success?: boolean;
  type?: string;
  workerKind?: string;
  [key: string]: JsonValue | Blob | File | FileSystemFileHandle | string[] | object | null | undefined;
};

type ChdInfo = {
  type?: string;
  logicalSize?: number | null;
};

type CompressionProgressHandler = {
  bivarianceHack(progress: object): void;
}["bivarianceHack"];

type CompressionOperationOptions = {
  chdInfo?: ChdInfo | null;
  inputPath?: string | null;
  mode?: string;
  outputDirectory?: string;
  outputName?: string;
  outputPath?: string | null;
  threads?: string | number | null;
  compression?: string;
  compressionLevel?: string | number | null;
  blockSize?: string | number | null;
  scrub?: boolean | string | number | null;
  metadata?: Record<string, string | number | boolean | Uint8Array | null | undefined> | null;
  underlyingMagic?: string;
  inputSize?: number;
  workId?: string;
  onProgress?: CompressionProgressHandler;
  cueText?: string;
  cueInputPath?: string | null;
  compressionCodecs?: string | string[] | Record<string, string | number> | null;
  readOutput?: boolean;
  removeInput?: boolean;
};

type WorkerScope = typeof globalThis & {
  Module?: EmscriptenWorkerModule;
  __romWeaverCompressionWorkerKind?: "7zip-zstd" | "azahar-z3ds" | "chdman" | "dolphin-rvz";
  __romWeaverWorkerKind?: "7zip-zstd" | "azahar-z3ds" | "chdman" | "dolphin-rvz";
  navigator: Navigator;
  onmessage: ((event: MessageEvent<object>) => void) | null;
  postMessage: (message: WorkerMessage) => void;
};

const workerScope = self as object as WorkerScope;
const COMPRESSION_OPFS_MOUNTPOINT = WORKER_OPFS_MOUNTPOINT;

export type { ChdInfo, CompressionOperationOptions, WorkerErrorLike, WorkerMessage, WorkerScalar };
export { COMPRESSION_OPFS_MOUNTPOINT, workerScope };
