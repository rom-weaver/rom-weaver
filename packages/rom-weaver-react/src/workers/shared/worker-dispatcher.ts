import type { WorkerRequestId, WorkerScopeLike } from "../protocol/worker-protocol.ts";
import {
  attachWorkerFatalHandlers,
  getWorkerErrorMessage,
  postWorkerError,
  postWorkerReady,
} from "./worker-message-utils.ts";

type WorkerDispatchValue = object | string | number | boolean | null | undefined;
type WorkerDispatchRequest = Record<string, WorkerDispatchValue> & {
  action: string;
  requestId?: WorkerRequestId;
};
type WorkerDispatchIncomingRequest<TRequest extends WorkerDispatchRequest> = Partial<TRequest> & {
  action?: string;
  requestId?: WorkerRequestId;
};
type WorkerDispatchScope<TRequest extends WorkerDispatchRequest> = WorkerScopeLike<TRequest>;
type WorkerDispatchHandler<TRequest extends WorkerDispatchRequest> = (request: TRequest) => Promise<void> | void;
type WorkerDispatchOptions<TRequest extends WorkerDispatchRequest> = {
  getErrorAction?: (request: TRequest) => string;
  getErrorFields?: (request: TRequest) => Record<string, WorkerDispatchValue> | undefined;
  getErrorMessage?: (error: unknown) => string;
  handlers: Record<string, WorkerDispatchHandler<TRequest>>;
  normalizeRequest?: (request: WorkerDispatchIncomingRequest<TRequest>) => TRequest;
  unsupportedActionMessage?: (request: TRequest) => string;
};

const defaultNormalizeRequest = <TRequest extends WorkerDispatchRequest>(
  request: WorkerDispatchIncomingRequest<TRequest>,
) =>
  ({
    ...(request || {}),
    action: typeof request?.action === "string" ? request.action : "",
    requestId: request?.requestId === undefined ? undefined : String(request.requestId),
  }) as TRequest;

const attachWorkerDispatcher = <TRequest extends WorkerDispatchRequest>(
  scope: WorkerDispatchScope<TRequest>,
  {
    getErrorAction = (request) => `${request.action || "unknown"}-complete`,
    getErrorFields,
    getErrorMessage = getWorkerErrorMessage,
    handlers,
    normalizeRequest = defaultNormalizeRequest,
    unsupportedActionMessage = (request) => `Unsupported worker action: ${request.action || "(none)"}`,
  }: WorkerDispatchOptions<TRequest>,
) => {
  scope.onmessage = (event: MessageEvent<TRequest>) => {
    const request = normalizeRequest((event.data || {}) as WorkerDispatchIncomingRequest<TRequest>);
    const action = request.action;
    const handler = handlers[action];
    const promise = handler
      ? Promise.resolve().then(() => handler(request))
      : Promise.reject(unsupportedActionMessage(request));

    promise.catch((error) => {
      postWorkerError(
        scope,
        getErrorAction(request),
        getErrorMessage(error),
        request.requestId,
        getErrorFields?.(request),
      );
    });
  };

  attachWorkerFatalHandlers(scope, getErrorMessage);
  postWorkerReady(scope);
};

export type { WorkerDispatchHandler, WorkerDispatchRequest, WorkerDispatchScope };
export { attachWorkerDispatcher };
