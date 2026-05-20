import type { CompressionWorkerKind, CompressionWorkerOperation } from "../../protocol/worker-protocol.ts";
import type { WorkerRequestData } from "../../protocol/worker-runtime-payloads.ts";
import { workerScope } from "../worker-compression-types.ts";
import { attachWorkerDispatcher } from "../worker-dispatcher.ts";
import { getWorkerErrorMessage, postCloneSafeWorkerMessage } from "../worker-message-utils.ts";
import { createWorkerRequestId } from "../worker-request-id.ts";
import { cleanupOpfsOutputManagers } from "../worker-storage/compression-output.ts";
import { cleanupMaterializedOutputs } from "../worker-storage/worker-output-materialization.ts";

type CompressionWorkerHandler = (request: WorkerRequestData) => Promise<void> | void;
type CompressionWorkerKindHandlers = Partial<Record<CompressionWorkerOperation, CompressionWorkerHandler>>;
type CompressionOperationRequest = WorkerRequestData & {
  action?: string;
  kind?: string;
  operation?: string;
};
type AttachCompressionWorkerOptions = {
  handlers: CompressionWorkerKindHandlers;
  kind: CompressionWorkerKind;
};
type CreateStandardCompressionWorkerHandlersOptions = {
  cleanupOpfsOutput?: boolean;
  create: CompressionWorkerHandler;
  extract: CompressionWorkerHandler;
  kind: CompressionWorkerKind;
  waitForModule: (threads: WorkerRequestData["threads"]) => Promise<unknown> | unknown;
};

const getConcreteCompressionWorkerKind = (kind: CompressionWorkerKind) => {
  return kind;
};

const getCompressionOperation = (request: CompressionOperationRequest) => {
  let operation = "";
  if (typeof request.operation === "string") operation = request.operation;
  else if (typeof request.action === "string") operation = request.action;
  if (
    operation === "warmup" ||
    operation === "list" ||
    operation === "create" ||
    operation === "extract" ||
    operation === "cleanup"
  )
    return operation;
  throw new Error(`Unsupported compression worker operation: ${operation || "(none)"}`);
};

const normalizeCompressionOperation = (request: CompressionOperationRequest) => {
  if (typeof request.operation === "string") return request.operation;
  if (typeof request.action === "string") return request.action;
  return "";
};

const assertCompressionWorkerKind = (expectedKind: CompressionWorkerKind, request: CompressionOperationRequest) => {
  const requestedKind = typeof request.kind === "string" ? request.kind : "";
  if (requestedKind && requestedKind !== expectedKind)
    throw new Error(`Compression worker kind mismatch: requested ${requestedKind}, worker is ${expectedKind}`);
};

const completeCompressionOperation = (
  kind: CompressionWorkerKind,
  data: WorkerRequestData,
  operation: CompressionWorkerOperation,
  fields?: Record<string, RuntimeValue>,
) => {
  postCloneSafeWorkerMessage(workerScope, {
    action: "complete",
    kind,
    operation,
    requestId: data.requestId,
    success: true,
    type: "result",
    workerKind: getConcreteCompressionWorkerKind(kind),
    ...(fields || {}),
  });
};

const createStandardCompressionWorkerHandlers = ({
  cleanupOpfsOutput = false,
  create,
  extract,
  kind,
  waitForModule,
}: CreateStandardCompressionWorkerHandlersOptions): CompressionWorkerKindHandlers => ({
  cleanup: async (data) => {
    if (cleanupOpfsOutput) await cleanupOpfsOutputManagers(data.filePaths || []).catch(() => undefined);
    await cleanupMaterializedOutputs(data.filePaths || []).catch(() => undefined);
    completeCompressionOperation(kind, data, "cleanup");
  },
  create,
  extract,
  warmup: async (data) => {
    await waitForModule(data.threads);
    completeCompressionOperation(kind, data, "warmup");
  },
});

const attachCompressionWorker = ({ handlers, kind }: AttachCompressionWorkerOptions) => {
  (
    workerScope as typeof workerScope & {
      __romWeaverCompressionWorkerKind?: CompressionWorkerKind;
      __romWeaverWorkerKind?: ReturnType<typeof getConcreteCompressionWorkerKind>;
    }
  ).__romWeaverCompressionWorkerKind = kind;
  (
    workerScope as typeof workerScope & {
      __romWeaverWorkerKind?: ReturnType<typeof getConcreteCompressionWorkerKind>;
    }
  ).__romWeaverWorkerKind = getConcreteCompressionWorkerKind(kind);
  const runCompressionOperation = (data: WorkerRequestData) => {
    const request = data as CompressionOperationRequest;
    assertCompressionWorkerKind(kind, request);
    const operation = getCompressionOperation(request);
    data.kind = kind;
    data.operation = operation;
    data.action = operation;
    data.workerKind = getConcreteCompressionWorkerKind(kind);
    const handler = handlers[operation as CompressionWorkerOperation];
    if (!handler) throw new Error(`Unsupported ${kind} compression worker operation: ${operation}`);
    return handler(data);
  };

  attachWorkerDispatcher(workerScope, {
    getErrorAction: () => "complete",
    getErrorFields: (data) => ({
      fileName: data.outputName || data.fileName || data.rvzFileName || data.chdFileName || data.z3dsFileName,
      kind,
      operation: data.operation,
      sourceAction: data.action,
    }),
    getErrorMessage: getWorkerErrorMessage,
    handlers: {
      cleanup: runCompressionOperation,
      create: runCompressionOperation,
      extract: runCompressionOperation,
      list: runCompressionOperation,
      warmup: runCompressionOperation,
    },
    normalizeRequest: (rawData) => {
      const operation = normalizeCompressionOperation(rawData as CompressionOperationRequest);
      return {
        ...rawData,
        action: operation,
        kind,
        operation,
        requestId: rawData.requestId ?? createWorkerRequestId("compression-request"),
        workerKind: getConcreteCompressionWorkerKind(kind),
      } as WorkerRequestData;
    },
    unsupportedActionMessage: (data) =>
      `Unsupported ${kind || "unknown"} compression worker operation: ${data.action || "(none)"}`,
  });
};

export type { CompressionWorkerHandler, CompressionWorkerKindHandlers };
export { attachCompressionWorker, completeCompressionOperation, createStandardCompressionWorkerHandlers };
