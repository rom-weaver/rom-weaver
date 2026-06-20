/**
 * Copy text to the clipboard with a fallback for contexts where
 * navigator.clipboard is unavailable or rejects — a non-secure context (a
 * self-signed LAN cert on iOS) or a browser that gates the async Clipboard
 * API. Selection + execCommand still copies in those cases. Resolves on
 * success; rejects only when no method works.
 */

// A modal <dialog> (showModal) lives in the top layer and makes everything
// outside it inert, so a textarea appended to document.body cannot be focused
// or selected and execCommand("copy") silently fails. Mount the scratch
// textarea inside the open dialog instead. Prefer a :modal match (the truly
// inert-inducing one); fall back to any [open] dialog — a non-modal dialog is
// not inert, so mounting inside it is harmless when :modal is unavailable.
const modalMatch = (dialog: HTMLDialogElement): boolean => {
  try {
    return dialog.matches(":modal");
  } catch {
    return false;
  }
};

const copyHost = (): HTMLElement => {
  const dialogs = Array.from(document.querySelectorAll("dialog"));
  let openFallback: HTMLDialogElement | undefined;
  for (let index = dialogs.length - 1; index >= 0; index -= 1) {
    const dialog = dialogs[index];
    if (!dialog) continue;
    if (modalMatch(dialog)) return dialog;
    if (!openFallback && dialog.open) openFallback = dialog;
  }
  return openFallback ?? document.body;
};

// iOS Safari ignores textarea.select() for copy and refuses to select a
// readonly field, so the plain "appendChild + select()" recipe copies nothing
// there. Select via an explicit Range + setSelectionRange with readOnly off —
// the combination WebKit actually honours. font-size:16px avoids the iOS
// focus-zoom. Keep the element non-readonly only during selection.
const selectTextareaContents = (textarea: HTMLTextAreaElement): void => {
  textarea.contentEditable = "true";
  textarea.readOnly = false;
  try {
    const range = document.createRange();
    range.selectNodeContents(textarea);
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    textarea.setSelectionRange(0, textarea.value.length);
  } catch {
    textarea.select();
  }
};

const execCommandCopy = (value: string): boolean => {
  if (typeof document === "undefined") return false;
  const host = copyHost();
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.cssText = "position:fixed;top:-1000px;left:0;opacity:0;font-size:16px;";
  host.appendChild(textarea);
  textarea.focus();
  selectTextareaContents(textarea);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  window.getSelection()?.removeAllRanges();
  host.removeChild(textarea);
  return ok;
};

const copyToClipboard = async (text: string): Promise<void> => {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  // The async Clipboard API rejects (NotAllowedError: "Document is not focused")
  // whenever the page lacks focus — DevTools or another window is focused, or the
  // click landed during a focus handoff — which made copy fail intermittently. And
  // recovering by awaiting that rejection then calling execCommand is too late: the
  // await defers it to a microtask where the user gesture is gone, so execCommand
  // fails too. When the document is focused, use the clean modern API; otherwise go
  // straight to the synchronous execCommand path, which still runs inside the live
  // gesture and copies the current selection regardless of window focus.
  const documentFocused = typeof document === "undefined" || document.hasFocus();
  if (clipboard?.writeText && documentFocused) {
    try {
      await clipboard.writeText(text);
      return;
    } catch {
      // fall through to the execCommand path below
    }
  }
  if (!execCommandCopy(text)) {
    throw new Error("Clipboard unavailable: copy was blocked (the page may not have had focus)");
  }
};

export { copyToClipboard };
