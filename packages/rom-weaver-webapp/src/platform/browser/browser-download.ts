import { createLogger } from "../../lib/logging.ts";
import { isAppleMobileWebKit } from "@rom-weaver/wasm";

const logger = createLogger("browser-download");

type BrowserDownloadOptions = {
  /** True when the download was triggered by a direct user tap (live user activation). Share
   * failures are surfaced to the caller instead of being swallowed, except user cancellation. */
  interactive?: boolean;
};

// Standalone iOS PWAs need the share path; Safari tabs retain anchor downloads.
// Check both the legacy and modern standalone signals.
const isIosStandalonePwa = (): boolean => {
  if (typeof navigator === "undefined" || !isAppleMobileWebKit(navigator)) return false;
  if ((navigator as { standalone?: boolean }).standalone === true) return true;
  return typeof window !== "undefined" && !!window.matchMedia?.("(display-mode: standalone)").matches;
};

// The share sheet was dismissed by the user - not a failure.
const isShareCancellation = (error: unknown): boolean =>
  typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError";

const throwInteractiveShareError = (message: string, options?: BrowserDownloadOptions): void => {
  if (options?.interactive) throw new Error(message);
};

const logShareFailure = (error: unknown, fileName: string, options?: BrowserDownloadOptions): void => {
  if (options?.interactive && !isShareCancellation(error)) {
    logger.error("iOS share sheet failed on interactive download", {
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      fileName,
    });
    throw new Error("Could not open the iOS share sheet to save the file. Tap the download button again.", {
      cause: error,
    });
  }
  logger.debug("iOS share sheet dismissed or unavailable", {
    error: error instanceof Error ? error.name : String(error),
    interactive: !!options?.interactive,
  });
};

// Standalone iOS cannot save through `<a download>`; use the share sheet and
// never fall back to the dead-end preview. Automatic downloads may lack live
// user activation, so non-interactive failures leave the download button armed;
// interactive failures surface to the UI unless the user cancelled.
const tryWebKitShare = async (blob: Blob, fileName?: string, options?: BrowserDownloadOptions): Promise<boolean> => {
  if (!isIosStandalonePwa()) return false;
  if (typeof navigator.share !== "function") {
    throwInteractiveShareError("This iOS installation cannot open a share sheet to save the file.", options);
    logger.warn("iOS standalone PWA cannot save because navigator.share is unavailable");
    return true;
  }
  const file = new File([blob], fileName || "download", { type: blob.type || "application/octet-stream" });
  if (typeof navigator.canShare === "function" && !navigator.canShare({ files: [file] })) {
    throwInteractiveShareError("iOS cannot share this output file. Try a smaller or different format.", options);
    logger.warn("navigator.canShare rejected the output file", {
      fileName: file.name,
      size: file.size,
      type: file.type,
    });
    return true;
  }
  logger.debug("opening iOS share sheet for output", {
    fileName: file.name,
    interactive: !!options?.interactive,
    size: file.size,
  });
  try {
    await navigator.share({ files: [file] });
    logger.debug("iOS share sheet completed", { fileName: file.name });
  } catch (error) {
    // Swallow: cancel, expired activation (auto path), or any non-interactive share
    // error. On iOS the anchor fallback only previews, never saves, so there is
    // nothing better to do - the armed "Download output" button remains for a real tap.
    logShareFailure(error, file.name, options);
  }
  return true;
};

const triggerAnchorDownload = (blob: Blob, resolvedFileName: string | undefined) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = resolvedFileName || "download";
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    anchor.remove();
  }, 0);
};

const triggerBrowserDownload = async (
  data: BlobPart,
  fileName?: string,
  options?: BrowserDownloadOptions,
): Promise<void> => {
  const blob = data instanceof Blob ? data : new Blob([data], { type: "application/octet-stream" });
  if (await tryWebKitShare(blob, fileName, options)) return;
  triggerAnchorDownload(blob, fileName);
};

export { triggerBrowserDownload };
