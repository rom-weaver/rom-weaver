import type { MessageId } from "./localization/catalog.ts";
import { createLocalizer, type Localizer } from "./localization/index.ts";
import { getEngineError, isWorkflowErrorCode } from "../lib/errors.ts";
import { isPatchFileChecksumFailure } from "../public/react/patch-validation-failure.ts";

type CodedErrorLike = Error & {
  code?: unknown;
  details?: Record<string, unknown>;
};

const isCodedError = (error: unknown): error is CodedErrorLike =>
  error instanceof Error && typeof (error as { code?: unknown }).code === "string";

const getErrorCode = (error: unknown): string => (isCodedError(error) ? String(error.code) : "");

const getErrorDetails = (error: unknown): Record<string, unknown> | undefined =>
  isCodedError(error) && error.details && typeof error.details === "object" ? error.details : undefined;

const getErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const DISPLAYED_ERROR_CODE_REGEX = /^([A-Z_]+): /;

const normalizeComparableErrorMessage = (message: string): string =>
  String(message || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "")
    .toLowerCase();

const getErrorCause = (error: unknown): unknown =>
  error instanceof Error && "cause" in error ? (error as Error & { cause?: unknown }).cause : undefined;

const getDistinctErrorMessages = (error: unknown): string[] => {
  const messages: string[] = [];
  const seen = new Set<string>();
  let current: unknown = error;
  let depth = 0;
  while (current !== undefined && current !== null && depth < 8) {
    const message = getErrorMessage(current).trim();
    const comparable = normalizeComparableErrorMessage(message);
    if (comparable && !seen.has(comparable)) {
      seen.add(comparable);
      messages.push(message);
    }
    current = getErrorCause(current);
    depth += 1;
  }
  return messages;
};

const getStructuredErrorDetail = (error: unknown): string => {
  const details = getErrorDetails(error);
  if (!details) return "";
  const detailParts: string[] = [];
  if (typeof details.phase === "string" && details.phase) detailParts.push(`phase=${details.phase}`);
  if (typeof details.workerName === "string" && details.workerName) detailParts.push(`worker=${details.workerName}`);
  if (typeof details.fileName === "string" && details.fileName) detailParts.push(`script=${details.fileName}`);
  else if (typeof details.workerScriptUrl === "string" && details.workerScriptUrl)
    detailParts.push(`script=${details.workerScriptUrl}`);
  if (typeof details.lineNumber === "number" && Number.isFinite(details.lineNumber))
    detailParts.push(`line=${details.lineNumber}`);
  if (typeof details.columnNumber === "number" && Number.isFinite(details.columnNumber))
    detailParts.push(`column=${details.columnNumber}`);
  if (typeof details.requestId === "string" && details.requestId) detailParts.push(`requestId=${details.requestId}`);
  return detailParts.join(", ");
};

const ENGINE_ERROR_MESSAGE_IDS = new Map<string, MessageId>([["container.not_3ds", "error.NOT_3DS_INPUT"]]);

/** The localized wording for an engine failure that has its own message, or `undefined` for any other error. */
const getLocalizedEngineErrorMessage = (
  error: unknown,
  localizer: Localizer = createLocalizer(),
): string | undefined => {
  const messageId = ENGINE_ERROR_MESSAGE_IDS.get(getEngineError(error)?.code ?? "");
  return messageId ? localizer.message(messageId) : undefined;
};

const getUserFacingErrorMessage = (error: unknown, localizer: Localizer = createLocalizer()): string => {
  const code = getErrorCode(error);
  if (!code) return getErrorMessage(error);
  const message = getErrorMessage(error);
  if (code === "INVALID_INPUT" && message.toLowerCase().includes("multi-file output")) return message;
  if (code === "OUT_OF_MEMORY") return message;
  if (isPatchFileChecksumFailure(getEngineError(error)?.code)) return localizer.message("error.PATCH_FILE_DAMAGED");
  const messageId = `error.${code}` as MessageId;
  const localized = localizer.message(messageId, getErrorDetails(error));
  return localized === messageId ? getErrorMessage(error) : localized;
};

const getNoRomInArchiveMessage = (error: unknown): string => {
  const engine = getEngineError(error);
  const path = typeof engine?.fields.path === "string" ? engine.fields.path : "";
  const fileName = path.split(/[\\/]/).pop() || path;
  if (!fileName) return "";
  if (engine?.code === "extract.all_entries_ignored")
    return `No usable ROM found in ${fileName}. Choose an archive containing a ROM, or extract it and add the ROM file.`;
  if (
    engine?.code === "extract.no_matching_entries" &&
    String(engine.fields.filter).split("/").includes("--filter rom")
  )
    return `No ROM found in ${fileName}.`;
  return "";
};

const formatCodedErrorForDisplay = (error: unknown, localizer: Localizer = createLocalizer()): string => {
  const noRomMessage = getNoRomInArchiveMessage(error);
  if (noRomMessage) return noRomMessage;
  const engineMessage = getLocalizedEngineErrorMessage(error, localizer);
  if (engineMessage) return engineMessage;
  const code = getErrorCode(error);
  const message = getUserFacingErrorMessage(error, localizer);
  if (!code) return message;
  const structuredDetail = getStructuredErrorDetail(error);
  const detail = getDistinctErrorMessages(error).find(
    (candidate) => normalizeComparableErrorMessage(candidate) !== normalizeComparableErrorMessage(message),
  );
  if (detail) return `${code}: ${message} Details: ${detail}`;
  if (structuredDetail) return `${code}: ${message} Details: ${structuredDetail}`;
  return `${code}: ${message}`;
};

/**
 * The workflow code of a displayed message: `code` when given, else the `CODE: ` prefix `formatCodedErrorForDisplay`
 * writes. A prefix that is not a workflow code is ordinary text.
 */
const getDisplayedErrorCode = (message: string, code?: string): string | undefined => {
  if (code) return code;
  const prefix = DISPLAYED_ERROR_CODE_REGEX.exec(message)?.[1];
  return isWorkflowErrorCode(prefix) ? prefix : undefined;
};

export { formatCodedErrorForDisplay, getDisplayedErrorCode, getErrorCode, getLocalizedEngineErrorMessage };
