import { useEffect, useState } from "react";

const hasDataTransferType = (types: readonly string[], type: string) => types.includes(type);

const hasFileDataTransferItem = (items: DataTransferItemList) => Array.from(items).some((item) => item.kind === "file");

const isFileDragTransfer = (dataTransfer: DataTransfer | null) =>
  !!dataTransfer && (hasDataTransferType(dataTransfer.types, "Files") || hasFileDataTransferItem(dataTransfer.items));

// A zone's own drop handler re-renders it before this document listener runs, which can detach the
// dropped-on child (hero title, bead, copy). A detached `target.closest()` no longer reaches the
// zone, so the dispatch-time `composedPath()` is checked as well.
const isInsideLocalDropZone = (event: Pick<Event, "composedPath" | "target">) => {
  const { target } = event;
  if (target instanceof Element && target.closest(".rw-app .drop")) return true;
  const path = event.composedPath();
  const zoneIndex = path.findIndex((node) => node instanceof Element && node.matches(".drop"));
  return zoneIndex >= 0 && path.slice(zoneIndex + 1).some((node) => node instanceof Element && node.matches(".rw-app"));
};

// Arm the dropzones while a file is dragged anywhere over the page. `dragover`
// fires continuously, so a short debounce clears the flag once it stops (drag
// left the window or dropped) - `dragleave`/`dragend` are unreliable here.
const usePageDragging = () => {
  const [pageDragging, setPageDragging] = useState(false);
  useEffect(() => {
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
  }, []);

  return pageDragging;
};

export { isFileDragTransfer, isInsideLocalDropZone, usePageDragging };
