import type { LogRecord } from "../../types/logging.ts";
import type { ProgressCallback } from "../../types/runtime.ts";
import { getCompressionWorkerDescriptor, type NormalizedWorkerSource } from "./compression-worker-registry.ts";
import { createCompressionKindWorkerClient } from "./worker-clients.ts";
import type {
  CompressionWorkerKind,
  CompressionWorkerOperation,
  CompressionWorkerRequest,
  CompressionWorkerResult,
} from "./worker-protocol.ts";

type BinaryWorkerSource = string;

const kindClientCache = new Map<CompressionWorkerKind, ReturnType<typeof createCompressionKindWorkerClient>>();

const getPathSource = (source: BinaryWorkerSource) => (typeof source === "string" && source.trim() ? source : null);

const normalizeWorkerSource = (source: BinaryWorkerSource, unsupportedMessage: string): NormalizedWorkerSource => {
  const filePath = getPathSource(source);
  if (!filePath) throw new Error(unsupportedMessage);
  return { filePath };
};

const withPathSource = (
  request: Partial<CompressionWorkerRequest>,
  pathKey: keyof CompressionWorkerRequest | undefined,
  source: NormalizedWorkerSource | undefined,
): Partial<CompressionWorkerRequest> => {
  if (!(pathKey && source?.filePath)) return request;
  return {
    ...request,
    [pathKey]: source.filePath,
  };
};

const getCompressionKindClient = (kind: CompressionWorkerKind) => {
  const cachedClient = kindClientCache.get(kind);
  if (cachedClient) return cachedClient;
  const descriptor = getCompressionWorkerDescriptor(kind);
  const client = createCompressionKindWorkerClient(kind, descriptor.createWorker, descriptor.fallbackErrorMessage);
  kindClientCache.set(kind, client);
  return client;
};

const runCompressionWorkerOperation = (
  kind: CompressionWorkerKind,
  operation: CompressionWorkerOperation,
  request: Partial<CompressionWorkerRequest>,
  onProgress?: ProgressCallback,
  onLog?: (record: LogRecord) => void,
): Promise<CompressionWorkerResult> => {
  const descriptor = getCompressionWorkerDescriptor(kind);
  if (!descriptor.operations.includes(operation))
    throw new Error(`Unsupported ${kind} compression worker operation: ${operation}`);
  return getCompressionKindClient(kind).run(operation, request, onProgress, onLog);
};

const buildCompressionWorkerRequest = (
  kind: CompressionWorkerKind,
  operation: CompressionWorkerOperation,
  input: Record<string, RuntimeValue>,
  source?: NormalizedWorkerSource,
) => {
  const descriptor = getCompressionWorkerDescriptor(kind);
  const requestBuilder = descriptor.requestBuilders[operation];
  if (typeof requestBuilder !== "function")
    throw new Error(`Unsupported ${kind} compression worker operation: ${operation}`);
  return withPathSource(
    requestBuilder(input, source) as Partial<CompressionWorkerRequest>,
    descriptor.sourcePathKeys?.[operation],
    source,
  );
};

const primeCompressionWorker = (kind: CompressionWorkerKind): Promise<void> => getCompressionKindClient(kind).prime();

const warmupCompressionWorker = (kind: CompressionWorkerKind, request: Partial<CompressionWorkerRequest> = {}) =>
  getCompressionKindClient(kind).warmup(request);

const runCompressionWorkerSourceOperation = (
  kind: CompressionWorkerKind,
  operation: CompressionWorkerOperation,
  input: Record<string, RuntimeValue> & { source: BinaryWorkerSource },
  unsupportedMessage: string,
  onProgress?: ProgressCallback,
  onLog?: (record: LogRecord) => void,
) => {
  const source = normalizeWorkerSource(input.source, unsupportedMessage);
  return runCompressionWorkerOperation(
    kind,
    operation,
    buildCompressionWorkerRequest(kind, operation, input, source),
    onProgress,
    onLog,
  );
};

export type { BinaryWorkerSource };
export {
  buildCompressionWorkerRequest,
  getCompressionKindClient,
  normalizeWorkerSource,
  primeCompressionWorker,
  runCompressionWorkerOperation,
  runCompressionWorkerSourceOperation,
  warmupCompressionWorker,
};
