/**
 * Copy text to the clipboard with a fallback for contexts where
 * navigator.clipboard is unavailable or rejects — a non-secure context (a
 * self-signed LAN cert on iOS) or a browser that gates the async Clipboard
 * API. Selection + execCommand still copies in those cases. Resolves on
 * success; rejects only when no method works.
 */

const execCommandCopy = (value: string): boolean => {
  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.cssText = "position:fixed;top:-1000px;left:0;opacity:0;";
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(textarea);
  return ok;
};

const copyToClipboard = async (text: string): Promise<void> => {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return;
    } catch {
      // fall through to the execCommand path below
    }
  }
  if (!execCommandCopy(text)) throw new Error("Clipboard unavailable");
};

export { copyToClipboard };
