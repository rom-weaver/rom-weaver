import { isAppleMobileWebKit } from "../shared/webkit-runtime.ts";

// An installed iOS/iPadOS PWA (standalone display mode). Only there do we take
// the share path — a normal Safari tab keeps the anchor download (its Quick Look
// preview at least carries a share button), and a standalone PWA has no such
// affordance, so the blob would otherwise dead-end. `navigator.standalone` is
// the legacy iOS signal; the `display-mode` query is the modern cross-browser
// one — check both so old and new iOS PWAs are covered.
const isIosStandalonePwa = (): boolean => {
  if (typeof navigator === "undefined" || !isAppleMobileWebKit(navigator)) return false;
  if ((navigator as { standalone?: boolean }).standalone === true) return true;
  return typeof window !== "undefined" && !!window.matchMedia?.("(display-mode: standalone)").matches;
};

// Inside a standalone iOS PWA the `<a download>` anchor can't save — WebKit has
// no Files integration for it there. The Web Share API's native sheet ("Save to
// Files") is the only path that writes to a real location; `showSaveFilePicker`
// isn't implemented on iOS at all. So in that context we share exclusively and
// NEVER fall back to the anchor: this returns `true` for every share outcome so
// the caller skips the anchor path, and only returns `false` elsewhere (regular
// Safari tab, desktop, Android) → anchor download.
//
// `navigator.share` needs live user activation. The armed "Download output" tap
// supplies it. The automatic post-apply download does NOT — its activation from
// the original "Apply & download" tap has expired by the time apply finishes —
// so there it throws `NotAllowedError`, which we swallow and leave the armed
// button for a real tap. Fast ops whose apply completes within the activation
// window will still pop the sheet automatically.
const tryWebKitShare = async (blob: Blob, fileName?: string): Promise<boolean> => {
  if (!isIosStandalonePwa()) return false;
  if (typeof navigator.share !== "function") return false;
  const file = new File([blob], fileName || "download", { type: blob.type || "application/octet-stream" });
  if (typeof navigator.canShare === "function" && !navigator.canShare({ files: [file] })) return false;
  try {
    await navigator.share({ files: [file] });
  } catch {
    // Swallow: cancel, expired activation (auto path), or any share error. On
    // iOS the anchor fallback only previews, never saves, so there is nothing
    // better to do — the armed "Download output" button remains for a real tap.
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

const triggerBrowserDownload = async (data: BlobPart, fileName?: string): Promise<void> => {
  const blob = data instanceof Blob ? data : new Blob([data], { type: "application/octet-stream" });
  if (await tryWebKitShare(blob, fileName)) return;
  triggerAnchorDownload(blob, fileName);
};

export { triggerBrowserDownload };
