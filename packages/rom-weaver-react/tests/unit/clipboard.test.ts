// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "../../src/lib/clipboard.ts";

/**
 * The execCommand fallback (used when navigator.clipboard is unavailable, e.g.
 * a non-secure LAN context) must mount its scratch <textarea> inside an open
 * <dialog>. A modal dialog makes document.body inert, so a textarea appended
 * there cannot be selected and the copy silently fails - the log dialog bug.
 */

const stubNoAsyncClipboard = () => {
  vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
};

const stubAsyncClipboard = (impl: (text: string) => Promise<void>) => {
  const writeText = vi.fn(impl);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  return writeText;
};

// happy-dom does not implement document.execCommand, so install a mock the
// fallback path can call and return its result.
const stubExecCommand = (impl: () => boolean) => {
  const exec = vi.fn(impl);
  Object.defineProperty(document, "execCommand", { configurable: true, value: exec });
  return exec;
};

const stubDocumentFocus = (focused: boolean) => {
  Object.defineProperty(document, "hasFocus", { configurable: true, value: vi.fn(() => focused) });
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // hasFocus is defined as an own property in the focus tests; drop it so the
  // prototype implementation is restored for the next test.
  delete (document as { hasFocus?: () => boolean }).hasFocus;
  document.body.replaceChildren();
});

describe("copyToClipboard execCommand fallback host", () => {
  it("mounts the scratch textarea inside an open dialog, not the inert body", async () => {
    stubNoAsyncClipboard();
    const dialog = document.createElement("dialog");
    document.body.appendChild(dialog);
    dialog.showModal();

    let host: Node | null = null;
    stubExecCommand(() => {
      host = document.querySelector("textarea")?.parentNode ?? null;
      return true;
    });

    await expect(copyToClipboard("payload")).resolves.toBeUndefined();
    expect(host).toBe(dialog);
  });

  it("falls back to document.body when no dialog is open", async () => {
    stubNoAsyncClipboard();
    let host: Node | null = null;
    stubExecCommand(() => {
      host = document.querySelector("textarea")?.parentNode ?? null;
      return true;
    });

    await expect(copyToClipboard("payload")).resolves.toBeUndefined();
    expect(host).toBe(document.body);
  });

  it("rejects when execCommand reports failure", async () => {
    stubNoAsyncClipboard();
    stubExecCommand(() => false);
    await expect(copyToClipboard("payload")).rejects.toThrow("Clipboard unavailable");
  });

  it("removes the scratch textarea after copying", async () => {
    stubNoAsyncClipboard();
    stubExecCommand(() => true);
    await copyToClipboard("payload");
    expect(document.querySelector("textarea")).toBeNull();
  });
});

/**
 * The async Clipboard API rejects when the document is not focused (DevTools or
 * another window focused, or a focus handoff). Recovering by awaiting that
 * rejection and then calling execCommand is too late - the user gesture is gone
 * - so copy failed intermittently. When unfocused, skip the async API and copy
 * synchronously inside the live gesture instead.
 */
describe("copyToClipboard focus handling", () => {
  it("uses the async clipboard API when the document is focused", async () => {
    stubDocumentFocus(true);
    const writeText = stubAsyncClipboard(() => Promise.resolve());
    const exec = stubExecCommand(() => true);
    await expect(copyToClipboard("payload")).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledWith("payload");
    expect(exec).not.toHaveBeenCalled();
  });

  it("skips the async API and copies synchronously when the document is not focused", async () => {
    stubDocumentFocus(false);
    const writeText = stubAsyncClipboard(() => Promise.resolve());
    const exec = stubExecCommand(() => true);
    await expect(copyToClipboard("payload")).resolves.toBeUndefined();
    expect(writeText).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalled();
  });

  it("falls back to execCommand when a focused async write rejects", async () => {
    stubDocumentFocus(true);
    const writeText = stubAsyncClipboard(() => Promise.reject(new Error("Document is not focused")));
    const exec = stubExecCommand(() => true);
    await expect(copyToClipboard("payload")).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledWith("payload");
    expect(exec).toHaveBeenCalled();
  });
});
