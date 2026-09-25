import { useEffect, useState } from "react";
import type { WebappView } from "./webapp-state-types.ts";

const hasDataTransferType = (types: readonly string[], type: string) => types.includes(type);

const hasFileDataTransferItem = (items: DataTransferItemList) => Array.from(items).some((item) => item.kind === "file");

const isFileDragTransfer = (dataTransfer: DataTransfer | null) =>
  !!dataTransfer && (hasDataTransferType(dataTransfer.types, "Files") || hasFileDataTransferItem(dataTransfer.items));

const isInsideLocalDropZone = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest(".rw-app .drop");

// Arm the dropzones while a file is dragged anywhere over the page. `dragover`
// fires continuously, so a short debounce clears the flag once it stops (drag
// left the window or dropped) - `dragleave`/`dragend` are unreliable here.
const usePageDragging = (notFound: boolean, state: { currentView: WebappView }) => {
  const [pageDragging, setPageDragging] = useState(false);
  useEffect(() => {
    if (notFound || state.currentView === "docs" || state.currentView === "whats-new") {
      setPageDragging(false);
      return undefined;
    }
    let clearTimer: ReturnType<typeof setTimeout> | undefined;
    const onDragOver = (event: DragEvent) => {
      if (!isFileDragTransfer(event.dataTransfer)) return;
      setPageDragging(true);
      clearTimeout(clearTimer);
      clearTimer = setTimeout(() => setPageDragging(false), 140);
    };
    const stop = () => {
      clearTimeout(clearTimer);
      setPageDragging(false);
    };
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", stop);
    return () => {
      clearTimeout(clearTimer);
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", stop);
    };
  }, [notFound, state.currentView]);

  return pageDragging;
};

export { isFileDragTransfer, isInsideLocalDropZone, usePageDragging };
