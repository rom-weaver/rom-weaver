import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicOutput } from "../types/workflow-runtime-types.ts";

/**
 * Holds the last ZIP a form wrote. `saveAs` returns once the browser starts reading the file.
 * The ZIP MUST stay in storage until it is replaced. Disposing it early cancels a large download
 * mid-transfer. Unmounting aborts the write in `zipAbortRef` and frees the kept ZIP.
 */
export function useKeptZip() {
  const zipAbortRef = useRef<AbortController | null>(null);
  const keptZipRef = useRef<PublicOutput | null>(null);
  const [zipKept, setZipKept] = useState(false);

  const disposeZip = useCallback(() => {
    const old = keptZipRef.current;
    keptZipRef.current = null;
    setZipKept(false);
    void old?.dispose();
  }, []);

  /** Keeps a finished ZIP. Frees it instead when a cancel or an unmount aborted the write first. Returns whether it was kept. */
  const keepZip = useCallback((output: PublicOutput, signal: AbortSignal) => {
    if (signal.aborted) {
      void output.dispose();
      return false;
    }
    keptZipRef.current = output;
    setZipKept(true);
    return true;
  }, []);

  useEffect(
    () => () => {
      zipAbortRef.current?.abort();
      disposeZip();
    },
    [disposeZip],
  );

  return { disposeZip, keepZip, zipAbortRef, zipKept };
}
