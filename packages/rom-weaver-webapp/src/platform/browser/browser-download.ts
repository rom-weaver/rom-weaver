import { createLogger } from "../../lib/logging.ts";
import { isAppleMobileWebKit } from "../shared/webkit-runtime.ts";

const logger = createLogger("browser-download");

type BrowserDownloadOptions = {
  /** True when the download was triggered by a direct user tap (live user activation). Share
   * failures are surfaced to the caller instead of being swallowed, except user cancellation. */
  interactive?: boolean;
};

// An installed iOS/iPadOS PWA (standalone display mode). Only there do we take
// the share path - a normal Safari tab keeps the anchor download (its Quick Look
// preview at least carries a share button), and a standalone PWA has no such
// affordance, so the blob would otherwise dead-end. `navigator.standalone` is
// the legacy iOS signal; the `display-mode` query is the modern cross-browser
// one - check both so old and new iOS PWAs are covered.
const isIosStandalonePwa = (): boolean => {
  if (typeof navigator === "undefined" || !isAppleMobileWebKit(navigator)) return false;
  if ((navigator as { standalone?: boolean }).standalone === true) return true;
  return typeof window !== "undefined" && !!window.matchMedia?.("(display-mode: standalone)").matches;
};

// The share sheet was dismissed by the user - not a failure.
const isShareCancellation = (error: unknown): boolean =>
  typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError";

// Inside a standalone iOS PWA the `<a download>` anchor can't save - WebKit has
// no Files integration for it there. The Web Share API's native sheet ("Save to
// Files") is the only path that writes to a real location; `showSaveFilePicker`
// isn't implemented on iOS at all. So in that context we share exclusively and
// NEVER fall back to the anchor: this returns `true` for every share outcome so
// the caller skips the anchor path, and only returns `false` elsewhere (regular
// Safari tab, desktop, Android) → anchor download.
//
// `navigator.share` needs live user activation. The armed "Download output" tap
// supplies it (`interactive`). The automatic post-apply download does NOT - its
// activation from the original "Weave & download" tap has expired by the time
// apply finishes - so there it throws `NotAllowedError`, which we swallow and
// leave the armed button for a real tap. Fast ops whose apply completes within
// the activation window will still pop the sheet automatically. On the
// interactive path a share failure (other than the user cancelling the sheet)
// is rethrown so the UI can surface it instead of silently doing nothing.
const tryWebKitShare = async (blob: Blob, fileName?: string, options?: BrowserDownloadOptions): Promise<boolean> => {
  if (!isIosStandalonePwa()) return false;
  if (typeof navigator.share !== "function") {
    if (options?.interactive) throw new Error("This iOS installation cannot open a share sheet to save the file.");
    logger.warn("iOS standalone PWA cannot save because navigator.share is unavailable");
    return true;
  }
  const file = new File([blob], fileName || "download", { type: blob.type || "application/octet-stream" });
  if (typeof navigator.canShare === "function" && !navigator.canShare({ files: [file] })) {
    if (options?.interactive) throw new Error("iOS cannot share this output file. Try a smaller or different format.");
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
    if (options?.interactive && !isShareCancellation(error)) {
      logger.error("iOS share sheet failed on interactive download", {
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        fileName: file.name,
      });
      throw new Error("Could not open the iOS share sheet to save the file. Tap the download button again.", {
        cause: error,
      });
    }
    // Swallow: cancel, expired activation (auto path), or any non-interactive share
    // error. On iOS the anchor fallback only previews, never saves, so there is
    // nothing better to do - the armed "Download output" button remains for a real tap.
    logger.debug("iOS share sheet dismissed or unavailable", {
      error: error instanceof Error ? error.name : String(error),
      interactive: !!options?.interactive,
    });
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
