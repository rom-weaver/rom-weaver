import { useEffect, useRef, useState } from "preact/hooks";
import { copyToClipboard } from "../../../../lib/clipboard.ts";
import { createLogger } from "../../../../lib/logging.ts";

/**
 * Copy-to-clipboard hook with a brief "copied" confirmation. Shared by the
 * checksum rows and the CUE section so the copy behaviour (including the
 * non-secure-context fallback) lives in one place.
 */

const logger = createLogger("clipboard-copy");
const COPIED_RESET_MS = 1100;

const useClipboardCopy = (text: string, resetMs = COPIED_RESET_MS) => {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      if (timeoutRef.current !== undefined) window.clearTimeout(timeoutRef.current);
    },
    [],
  );

  const markCopied = () => {
    setCopied(true);
    if (timeoutRef.current !== undefined) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => setCopied(false), resetMs);
  };

  const copy = () => {
    if (!text) return;
    copyToClipboard(text).then(markCopied, (error) =>
      logger.trace("Clipboard copy failed", { message: String(error) }),
    );
  };

  return { copied, copy };
};

export { useClipboardCopy };
