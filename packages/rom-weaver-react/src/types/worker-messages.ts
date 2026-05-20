import type { RomWeaverErrorDetails, WorkflowErrorCode } from "./errors.ts";
import type { LogRecord } from "./logging.ts";
import type { WorkflowProgress } from "./progress.ts";

type WorkerKind = "7zip-zstd" | "azahar-z3ds" | "chdman" | "dolphin-rvz" | "patch-checksum";

type WorkerOperation =
  | "apply"
  | "checksum"
  | "cleanup"
  | "create"
  | "create-patch"
  | "extract"
  | "list"
  | "parse-patch"
  | "warmup";

type WorkerTransportPostMessageOptions = StructuredSerializeOptions | Transferable[];

type WorkerTransportMessageData = {
  action?: string;
  error?: {
    code?: WorkflowErrorCode;
    details?: RomWeaverErrorDetails;
    message?: string;
  };
  requestId?: string;
  type?: string;
  timestamp?: number;
  workerKind?: WorkerKind;
  [key: string]: unknown;
};

type WorkerTransport<TMessage extends WorkerTransportMessageData = WorkerTransportMessageData> = {
  onerror: ((event: ErrorEvent) => void) | null;
  onmessage: ((event: MessageEvent<TMessage>) => void) | null;
  onmessageerror: ((event: MessageEvent<TMessage>) => void) | null;
  postMessage: (message: WorkerTransportMessageData, transferList?: WorkerTransportPostMessageOptions) => void;
  terminate: () => void;
};

type WorkerTransportFactory<TMessage extends WorkerTransportMessageData = WorkerTransportMessageData> =
  () => WorkerTransport<TMessage>;

type WorkerRequestContext = {
  operation: string;
  operationId?: string;
  requestId: string;
  signal?: AbortSignal;
  startedAt: number;
  workerKind: WorkerKind;
  workflowId?: string;
};

type WorkerBaseMessage = {
  operation?: WorkerOperation;
  requestId: string;
  workerKind: WorkerKind;
};

type WorkerRequestMessage<TPayload extends Record<string, unknown> = Record<string, unknown>> = WorkerBaseMessage & {
  payload?: TPayload;
  type: "request";
};

type WorkerLogMessage = WorkerBaseMessage & {
  log: LogRecord;
  type: "log";
};

type WorkerProgressMessage = WorkerBaseMessage & {
  progress: WorkflowProgress;
  type: "progress";
};

type WorkerErrorMessage = WorkerBaseMessage & {
  code: WorkflowErrorCode;
  details?: RomWeaverErrorDetails;
  error: RomWeaverErrorDetails & {
    code: WorkflowErrorCode;
    message: string;
  };
  message: string;
  type: "error";
};

type WorkerReadyMessage = {
  capabilities?: WorkerKind[];
  type: "ready";
  timestamp?: number;
  workerKind: WorkerKind;
};

type WorkerResultMessage<TResult = unknown> = WorkerBaseMessage & {
  result: TResult;
  type: "complete" | "result";
};

type WorkerCleanupMessage = WorkerBaseMessage & {
  cleanupRef?: WorkerCleanupRef;
  success: boolean;
  type: "cleanup";
};

type WorkerOutputRef = {
  fileName: string;
  filePath?: string;
  kind: "file" | "opfs";
  size?: number;
};

type WorkerCleanupRef = {
  paths: string[];
};

type WorkerMessage<TResult = unknown> =
  | WorkerCleanupMessage
  | WorkerErrorMessage
  | WorkerLogMessage
  | WorkerProgressMessage
  | WorkerReadyMessage
  | WorkerRequestMessage
  | WorkerResultMessage<TResult>;

type WorkerProtocolMessage<TResult = unknown> = WorkerMessage<TResult> | WorkerReadyMessage;

export type {
  WorkerBaseMessage,
  WorkerCleanupMessage,
  WorkerCleanupRef,
  WorkerErrorMessage,
  WorkerKind,
  WorkerLogMessage,
  WorkerMessage,
  WorkerOperation,
  WorkerOutputRef,
  WorkerProgressMessage,
  WorkerProtocolMessage,
  WorkerReadyMessage,
  WorkerRequestContext,
  WorkerRequestMessage,
  WorkerResultMessage,
  WorkerTransport,
  WorkerTransportFactory,
  WorkerTransportMessageData,
  WorkerTransportPostMessageOptions,
};
