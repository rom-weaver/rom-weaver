import {
  type BrowserStorageEstimateState,
  type BrowserStorageManagerLike,
  formatBrowserStorageEstimateState,
  formatByteCount,
  getBrowserStorageEstimateState,
  requestBrowserStoragePersistence,
} from "./browser-storage-estimate.ts";

type BrowserOutputStorageGuardOptions = {
  operationLabel: string;
  requiredBytes?: number | null;
  storage?: BrowserStorageManagerLike | null;
};

type CodedOutputStorageError = Error & {
  cause?: unknown;
  code: "OUTPUT_WRITE_FAILED";
  details?: Record<string, unknown>;
};

const BROWSER_OUTPUT_STORAGE_FAILURE_REGEX = /\b(no space left|quota|nospc|enospc)\b/i;
const BROWSER_OUTPUT_STORAGE_CONTEXT_REGEX = /\[storage:/i;

const toNonNegativeByteCount = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
};

const createOutputStorageError = (
  message: string,
  details: Record<string, unknown>,
  cause?: unknown,
): CodedOutputStorageError => {
  const error = new Error(message) as CodedOutputStorageError;
  error.name = "OutputStorageError";
  error.code = "OUTPUT_WRITE_FAILED";
  error.details = details;
  if (cause !== undefined) error.cause = cause;
  return error;
};

const getStorageDetails = (
  state: BrowserStorageEstimateState,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  ...extra,
  availableBytes: state.availableBytes,
  persisted: state.persisted,
  quotaBytes: state.quotaBytes,
  usageBytes: state.usageBytes,
});

const formatStorageShortfallMessage = (
  operationLabel: string,
  requiredBytes: number,
  state: BrowserStorageEstimateState,
  persistenceRequested: boolean,
  persistenceGranted: boolean | undefined,
) => {
  const persistenceMessage =
    persistenceRequested && persistenceGranted === false ? " Persistent browser storage was not granted." : "";
  return `Not enough browser storage to ${operationLabel}. Required at least ${formatByteCount(
    requiredBytes,
  )}, but only ${formatByteCount(
    state.availableBytes,
  )} is available.${persistenceMessage} Free disk space or clear this site's storage, then try again.`;
};

const ensureBrowserStorageAvailableForOutput = async ({
  operationLabel,
  requiredBytes,
  storage,
}: BrowserOutputStorageGuardOptions): Promise<void> => {
  const requiredByteCount = toNonNegativeByteCount(requiredBytes);
  if (!(requiredByteCount && requiredByteCount > 0)) return;

  let estimate = await getBrowserStorageEstimateState(storage);
  if (typeof estimate.availableBytes !== "number") return;
  if (requiredByteCount <= estimate.availableBytes) return;

  let persistenceRequested = false;
  let persistenceGranted: boolean | undefined;
  if (estimate.persisted !== true) {
    persistenceRequested = true;
    persistenceGranted = await requestBrowserStoragePersistence(storage);
    estimate = await getBrowserStorageEstimateState(storage);
    if (typeof estimate.availableBytes !== "number" || requiredByteCount <= estimate.availableBytes) return;
  }

  throw createOutputStorageError(
    formatStorageShortfallMessage(
      operationLabel,
      requiredByteCount,
      estimate,
      persistenceRequested,
      persistenceGranted,
    ),
    getStorageDetails(estimate, {
      operationLabel,
      persistenceGranted,
      persistenceRequested,
      requiredBytes: requiredByteCount,
    }),
  );
};

const withBrowserOutputStorageFailureContext = async (
  error: unknown,
  { operationLabel, requiredBytes, storage }: BrowserOutputStorageGuardOptions,
): Promise<unknown> => {
  const message = error instanceof Error ? error.message : String(error || "");
  if (BROWSER_OUTPUT_STORAGE_CONTEXT_REGEX.test(message)) return error;
  if (!BROWSER_OUTPUT_STORAGE_FAILURE_REGEX.test(message)) return error;

  const estimate = await getBrowserStorageEstimateState(storage);
  const requiredByteCount = toNonNegativeByteCount(requiredBytes);
  const context = `${message} [storage: ${formatBrowserStorageEstimateState(estimate)}]`;
  return createOutputStorageError(
    context,
    getStorageDetails(estimate, {
      operationLabel,
      ...(requiredByteCount === null ? {} : { requiredBytes: requiredByteCount }),
    }),
    error,
  );
};

export {
  ensureBrowserStorageAvailableForOutput,
  formatStorageShortfallMessage,
  withBrowserOutputStorageFailureContext,
};
