import type { BrowserDownload, CleanupCallback } from "../../types/runtime.ts";

type BrowserDownloadTriggerOptions = {
  retainCleanupDelayMs?: number;
};

const isBrowserDownload = (value: BrowserDownload | BlobPart): value is BrowserDownload =>
  !!value && typeof value === "object" && "data" in value && "fileName" in value;

const releaseBlobDownload = (url: string, cleanup?: CleanupCallback) => {
  URL.revokeObjectURL(url);
  cleanup?.();
};

const triggerBrowserDownload = (
  download: BrowserDownload | BlobPart,
  fileName?: string,
  cleanup?: CleanupCallback,
  options: BrowserDownloadTriggerOptions = {},
) => {
  const data = isBrowserDownload(download) ? download.data : download;
  const resolvedFileName = isBrowserDownload(download) ? download.fileName : fileName;
  const releaseCleanup = isBrowserDownload(download) ? download.cleanup : cleanup;
  const retainDelay = typeof releaseCleanup === "function" ? Math.max(0, options.retainCleanupDelayMs || 0) : 0;
  const blob = data instanceof Blob ? data : new Blob([data], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = resolvedFileName || "download";
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => {
    if (retainDelay <= 0) releaseBlobDownload(url, releaseCleanup);
    anchor.remove();
  }, 0);
  if (retainDelay > 0) {
    setTimeout(() => {
      releaseBlobDownload(url, releaseCleanup);
    }, retainDelay);
  }
};

export { triggerBrowserDownload };
