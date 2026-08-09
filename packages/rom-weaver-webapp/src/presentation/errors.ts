import type { MessageId } from "./localization/catalog.ts";
import { createLocalizer, type Localizer } from "./localization/index.ts";
import { sanitizeUrlText } from "../lib/url-text.ts";

type CodedErrorLike = Error & {
  code?: unknown;
  details?: Record<string, unknown>;
};

type NoticeError = {
  message: string;
  technicalDetails?: string;
};

const isCodedError = (error: unknown): error is CodedErrorLike =>
  error instanceof Error && typeof (error as { code?: unknown }).code === "string";

const getErrorCode = (error: unknown): string => (isCodedError(error) ? String(error.code) : "");

const getErrorDetails = (error: unknown): Record<string, unknown> | undefined =>
  isCodedError(error) && error.details && typeof error.details === "object" ? error.details : undefined;

const getErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const OUT_OF_MEMORY_MESSAGE_REGEX =
  /\b(out of memory|cannot enlarge memory|memory allocation|not enough memory|bad alloc|ENOMEM|OOM)\b/i;

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

const getErrorTechnicalDetails = (error: unknown, displayedMessage = ""): string => {
  const details: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    const sanitized = sanitizeUrlText(value).trim();
    if (!sanitized || seen.has(sanitized)) return;
    seen.add(sanitized);
    details.push(sanitized);
  };
  let current: unknown = error;
  let depth = 0;
  while (current !== undefined && current !== null && depth < 8) {
    if (typeof current === "object") {
      const record = current as {
        code?: unknown;
        details?: unknown;
        kind?: unknown;
        status?: unknown;
        url?: unknown;
      };
      if (typeof record.code === "string" && record.code) add(`code=${record.code}`);
      if (typeof record.kind === "string" && record.kind) add(`kind=${record.kind}`);
      if (typeof record.status === "number" && Number.isFinite(record.status)) add(`status=${record.status}`);
      if (typeof record.url === "string" && record.url) add(`url=${record.url}`);
      if (record.details && typeof record.details === "object") {
        const structured = getStructuredErrorDetail(current);
        if (structured) add(structured);
      }
    }
    const message = getErrorMessage(current).trim();
    if (message && normalizeComparableErrorMessage(message) !== normalizeComparableErrorMessage(displayedMessage))
      add(message);
    current = getErrorCause(current);
    depth += 1;
  }
  return details.join("\n");
};

const formatNoticeError = (
  error: unknown,
  localizer: Localizer = createLocalizer(),
  fallbackMessage?: string,
): NoticeError => {
  const code = getErrorCode(error);
  const message =
    (fallbackMessage && sanitizeUrlText(fallbackMessage)) ||
    (code ? getUserFacingErrorMessage(error, localizer) : sanitizeUrlText(getErrorMessage(error)));
  const technicalDetails = getErrorTechnicalDetails(error, message);
  return technicalDetails ? { message, technicalDetails } : { message };
};

const formatNoticeWarningDetails = (warnings: readonly string[]): string =>
  warnings
    .map((warning) => sanitizeUrlText(warning).trim())
    .filter(Boolean)
    .map((warning) => `- ${warning}`)
    .join("\n");

const getUserFacingErrorMessage = (error: unknown, localizer: Localizer = createLocalizer()): string => {
  const code = getErrorCode(error);
  if (!code) return getErrorMessage(error);
  const message = getErrorMessage(error);
  if (code === "INVALID_INPUT" && message.toLowerCase().includes("multi-file output")) return message;
  if ((code === "WORKER_FAILED" || code === "COMPRESSION_FAILED") && OUT_OF_MEMORY_MESSAGE_REGEX.test(message))
    return message;
  const messageId = `error.${code}` as MessageId;
  const localized = localizer.message(messageId, getErrorDetails(error));
  return localized === messageId ? getErrorMessage(error) : localized;
};

const formatCodedErrorForDisplay = (error: unknown, localizer: Localizer = createLocalizer()): string => {
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

export {
  formatCodedErrorForDisplay,
  formatNoticeError,
  formatNoticeWarningDetails,
  getErrorCode,
  getErrorTechnicalDetails,
};
