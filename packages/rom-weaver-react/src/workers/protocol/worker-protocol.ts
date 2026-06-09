import type { WorkflowErrorCode } from "../../types/errors.ts";
import type { JsonValue } from "../../types/runtime.ts";
import type { WorkerKind } from "../../types/worker-messages.ts";

type WorkerRequestId = string;
type WorkerPayloadValue = JsonValue | Blob | FileSystemFileHandle | Transferable[] | object | undefined;
type WorkerMessagePayload = Record<string, WorkerPayloadValue> | string | number | boolean | null | undefined;

type BrowserWorkerFile = Blob & {
  name?: string;
  type?: string;
};

type WorkerSuccessMessage<TAction extends string, TPayload extends object = object> = {
  action: TAction;
  requestId?: WorkerRequestId;
  success: true;
  timestamp?: number;
} & TPayload;

type WorkerReadyMessage = {
  action: "ready";
  requestId?: WorkerRequestId;
  timestamp?: number;
};

type WorkerFatalMessage = {
  action: "fatal";
  error?: { code?: WorkflowErrorCode; message?: string; details?: Record<string, unknown> };
  requestId?: WorkerRequestId;
  success?: false;
  type?: "error";
  timestamp?: number;
  workerKind: WorkerKind;
};

type WorkerProgressMessage<TProgress = object> = {
  action: "progress";
  progress: TProgress;
  requestId?: WorkerRequestId;
  type?: "progress";
  timestamp?: number;
  workerKind: WorkerKind;
};

type WorkerScopeEventMap<TRequest> = {
  message: MessageEvent<TRequest>;
  error: ErrorEvent;
  unhandledrejection: PromiseRejectionEvent;
};

type WorkerScopeLike<TRequest = object> = {
  onmessage: ((event: MessageEvent<TRequest>) => void) | null;
  postMessage(message: WorkerMessagePayload, options?: { transfer?: Transferable[] }): void;
  addEventListener<TKey extends keyof WorkerScopeEventMap<TRequest>>(
    type: TKey,
    listener: (event: WorkerScopeEventMap<TRequest>[TKey]) => void,
  ): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
};

type CompressionWorkerKind = "rom-weaver";
type CompressionWorkerOperation = "warmup" | "list" | "extract" | "create" | "cleanup";

export type {
  BrowserWorkerFile,
  CompressionWorkerKind,
  CompressionWorkerOperation,
  WorkerFatalMessage,
  WorkerProgressMessage,
  WorkerReadyMessage,
  WorkerRequestId,
  WorkerScopeEventMap,
  WorkerScopeLike,
  WorkerSuccessMessage,
};
