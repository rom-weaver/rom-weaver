import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createLogger } from "../../../../lib/logging.ts";

/** FLIP settle animation duration for rows gliding to their new slot after a commit. */
const FLIP_MS = 180;

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/**
 * Pointer + keyboard drag-to-reorder for a flow of variable-height
 * rows (used by the patch stack). Rows live directly in a relatively
 * positioned container; the dragged row lifts and follows the pointer while an
 * insertion line marks the drop slot. No row reflow happens until the pointer
 * is released, so the maths stays anchored to a single rect snapshot taken at
 * drag start. Works for mouse, touch, and pen via a single Pointer Events path;
 * arrow keys provide an accessible / keyboard fallback.
 */

const logger = createLogger("list-reorder");

/** Move `from` to `to`, returning a new array. Out-of-range / no-op moves copy unchanged. */
const reorder = <T>(list: readonly T[], from: number, to: number): T[] => {
  const next = list.slice();
  if (from === to || from < 0 || from >= list.length || to < 0 || to >= list.length) return next;
  const [item] = next.splice(from, 1);
  if (item === undefined) return list.slice();
  next.splice(to, 0, item);
  return next;
};

type RowSnapshot = {
  topRel: number;
  bottomRel: number;
  mid: number;
  midX: number;
  midY: number;
  width: number;
  height: number;
};

type DragState = { from: number; dx: number; dy: number; grid: boolean; to: number };

type UseListReorderArgs = {
  /** Number of reorderable rows currently rendered. */
  count: number;
  /** Disable all reordering while the stack is locked by another operation. */
  disabled?: boolean;
  /** Commit a reorder from one index to another. */
  onReorder: (from: number, to: number) => void;
};

const useListReorder = ({ count, disabled, onReorder }: UseListReorderArgs) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef<Map<number, HTMLElement>>(new Map());
  const snapshotRef = useRef<RowSnapshot[]>([]);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  // FLIP state: row top positions captured just before a commit, keyed by the DOM
  // node itself so the deltas survive React moving the (keyed) rows into new slots.
  const flipTopsRef = useRef<Map<HTMLElement, number>>(new Map());
  const flipOnlyRef = useRef<HTMLElement | null>(null);
  const flipPendingRef = useRef(false);
  const dragRef = useRef<DragState | null>(null);
  const activeHandleRef = useRef<HTMLElement | null>(null);
  const suppressClickRef = useRef(false);
  const cleanupPointerListenersRef = useRef<(() => void) | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  // Snap a row to its natural slot with no transition (the base `.file` transition
  // would otherwise animate the removal of its drag transform - a second, unwanted move).
  const settleRow = (element: HTMLElement) => {
    element.style.transition = "none";
    element.style.transform = "";
    void element.offsetHeight;
    element.style.transition = "";
  };

  // Record current row positions and arm a FLIP; called immediately before each
  // reorder commit. When `animateOnly` is set (a pointer drop), only that row glides
  // to its slot - every other row already moved during the drag and is settled flat.
  const captureFlip = (animateOnly?: HTMLElement | null) => {
    if (prefersReducedMotion()) return;
    const tops = new Map<HTMLElement, number>();
    for (const element of rowsRef.current.values()) tops.set(element, element.getBoundingClientRect().top);
    flipTopsRef.current = tops;
    flipOnlyRef.current = animateOnly ?? null;
    flipPendingRef.current = true;
  };

  // Play (First/Last/Invert/Play): the animated row is translated back to its old
  // position with transitions off, then released to glide forward; all others settle flat.
  useLayoutEffect(() => {
    if (!flipPendingRef.current) return;
    flipPendingRef.current = false;
    const previousTops = flipTopsRef.current;
    const animateOnly = flipOnlyRef.current;
    for (const element of rowsRef.current.values()) {
      const before = previousTops.get(element);
      if (before === undefined) continue;
      const delta = before - element.getBoundingClientRect().top;
      if ((animateOnly && element !== animateOnly) || Math.abs(delta) < 1) {
        settleRow(element);
        continue;
      }
      element.style.transition = "none";
      element.style.transform = `translateY(${delta}px)`;
      void element.offsetHeight;
      element.style.transition = `transform ${FLIP_MS}ms cubic-bezier(.2,.7,.3,1)`;
      element.style.transform = "";
      const clear = () => {
        element.style.transition = "";
        element.removeEventListener("transitionend", clear);
      };
      element.addEventListener("transitionend", clear);
    }
  });

  useEffect(() => () => cleanupPointerListenersRef.current?.(), []);

  const setRow = useCallback(
    (index: number) => (element: HTMLElement | null) => {
      if (element) rowsRef.current.set(index, element);
      else rowsRef.current.delete(index);
    },
    [],
  );

  // Target index for the grabbed row given its drag offset. The dragged card's
  // *leading* edge (its bottom when moving down, top when moving up) only has to
  // reach a neighbour's centre to claim that slot - about half a card of travel,
  // so reordering doesn't require dragging a full card past the next one.
  const targetFor = (from: number, dx: number, dy: number, grid: boolean): number => {
    const snapshot = snapshotRef.current;
    const row = snapshot[from];
    if (!row) return from;
    if (grid) {
      const projectedX = row.midX + dx;
      const projectedY = row.midY + dy;
      let target = from;
      let bestDistance = 0.7;
      for (let index = 0; index < snapshot.length; index += 1) {
        if (index === from) continue;
        const candidate = snapshot[index];
        if (!candidate) continue;
        const distance = Math.hypot(
          (projectedX - candidate.midX) / Math.max(row.width, candidate.width),
          (projectedY - candidate.midY) / Math.max(row.height, candidate.height),
        );
        if (distance < bestDistance) {
          bestDistance = distance;
          target = index;
        }
      }
      return target;
    }
    const half = (row.bottomRel - row.topRel) / 2;
    let to = from;
    if (dy > 0) {
      const lead = row.mid + half + dy;
      for (let index = from + 1; index < snapshot.length; index += 1) {
        const next = snapshot[index];
        if (!next || lead <= next.mid) break;
        to = index;
      }
    } else if (dy < 0) {
      const lead = row.mid - half + dy;
      for (let index = from - 1; index >= 0; index -= 1) {
        const next = snapshot[index];
        if (!next || lead >= next.mid) break;
        to = index;
      }
    }
    return to;
  };

  const updateDrag = (clientX: number, clientY: number) => {
    const current = dragRef.current;
    if (!current) return;
    const dx = clientX - startXRef.current;
    const dy = clientY - startYRef.current;
    if (Math.hypot(dx, dy) > 3) suppressClickRef.current = true;
    const to = targetFor(current.from, dx, dy, current.grid);
    if (to !== current.to) logger.trace("drag target", { from: current.from, to });
    const next = { ...current, dx, dy, to };
    dragRef.current = next;
    setDrag(next);
  };

  const finishDrag = (commit: boolean, pointerId: number) => {
    cleanupPointerListenersRef.current?.();
    cleanupPointerListenersRef.current = null;
    const handle = activeHandleRef.current;
    activeHandleRef.current = null;
    try {
      if (handle?.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    } catch {
      // The pointer may already have been released by the browser.
    }
    const current = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!current) return;
    if (Math.hypot(current.dx, current.dy) > 3 || current.to !== current.from) suppressClickRef.current = true;
    if (commit && current.to !== current.from && current.to >= 0 && current.to < count) {
      logger.debug("reorder commit", { from: current.from, to: current.to });
      captureFlip(rowsRef.current.get(current.from) ?? null);
      onReorder(current.from, current.to);
    } else if (!commit) {
      logger.trace("drag cancelled", { from: current.from });
    }
  };

  const begin = (from: number) => (event: ReactPointerEvent<HTMLElement>) => {
    if (disabled) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const container = containerRef.current;
    if (!container) return;
    const containerTop = container.getBoundingClientRect().top;
    const containerStyle = getComputedStyle(container);
    const grid = containerStyle.display === "grid" && containerStyle.gridTemplateColumns.split(" ").length > 1;
    const snapshot: RowSnapshot[] = [];
    for (let index = 0; index < count; index += 1) {
      const element = rowsRef.current.get(index);
      if (!element) {
        logger.warn("reorder aborted: row element missing", { count, index });
        return;
      }
      // Drop any in-flight FLIP transition so the grabbed stack tracks the pointer cleanly.
      element.style.transition = "";
      const rect = element.getBoundingClientRect();
      snapshot.push({
        bottomRel: rect.bottom - containerTop,
        height: rect.height,
        mid: rect.top + rect.height / 2,
        midX: rect.left + rect.width / 2,
        midY: rect.top + rect.height / 2,
        topRel: rect.top - containerTop,
        width: rect.width,
      });
    }
    snapshotRef.current = snapshot;
    startXRef.current = event.clientX;
    startYRef.current = event.clientY;
    suppressClickRef.current = false;
    activeHandleRef.current = event.currentTarget;
    // Some automation layers and browsers can deliver a late pointerdown after
    // the pointer has already been released. Keep the drag state alive in that
    // case; pointer capture is an enhancement, not a reason to abort the drag.
    let captured = false;
    try {
      if (event.pointerId !== undefined) {
        event.currentTarget.setPointerCapture(event.pointerId);
        captured = event.currentTarget.hasPointerCapture(event.pointerId);
      }
    } catch {
      // Fall back to document listeners below.
    }
    logger.trace("drag begin", { count, from });
    const next = { dx: 0, dy: 0, from, grid, to: from };
    dragRef.current = next;
    setDrag(next);
    if (!captured) {
      const pointerId = event.pointerId ?? -1;
      const onMove = (nativeEvent: PointerEvent) => {
        if (nativeEvent.pointerId === pointerId) updateDrag(nativeEvent.clientX, nativeEvent.clientY);
      };
      const onMouseMove = (nativeEvent: MouseEvent) => updateDrag(nativeEvent.clientX, nativeEvent.clientY);
      const onUp = (nativeEvent: PointerEvent) => {
        if (nativeEvent.pointerId === pointerId) finishDrag(true, pointerId);
      };
      const onMouseUp = () => finishDrag(true, pointerId);
      const onCancel = (nativeEvent: PointerEvent) => {
        if (nativeEvent.pointerId === pointerId) finishDrag(false, pointerId);
      };
      if (pointerId >= 0) {
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
        document.addEventListener("pointercancel", onCancel);
      } else {
        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
      }
      cleanupPointerListenersRef.current = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onCancel);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };
    }
  };

  const move = (event: ReactPointerEvent<HTMLElement>) => {
    updateDrag(event.clientX, event.clientY);
  };

  const finish = (commit: boolean) => (event: ReactPointerEvent<HTMLElement>) => {
    finishDrag(commit, event.pointerId ?? -1);
  };

  const beginMouse = (index: number) => (event: ReactMouseEvent<HTMLElement>) => {
    if (dragRef.current) return;
    begin(index)(event as unknown as ReactPointerEvent<HTMLElement>);
  };

  const moveMouse = (event: ReactMouseEvent<HTMLElement>) => {
    if (dragRef.current) updateDrag(event.clientX, event.clientY);
  };

  const finishMouse = (commit: boolean) => () => {
    if (dragRef.current) finishDrag(commit, -1);
  };

  const handleKeyDown = (index: number) => (event: ReactKeyboardEvent<HTMLElement>) => {
    if (disabled) return;
    if (event.key === "ArrowUp" && index > 0) {
      event.preventDefault();
      logger.debug("reorder via keyboard", { from: index, to: index - 1 });
      captureFlip();
      onReorder(index, index - 1);
    } else if (event.key === "ArrowDown" && index < count - 1) {
      event.preventDefault();
      logger.debug("reorder via keyboard", { from: index, to: index + 1 });
      captureFlip();
      onReorder(index, index + 1);
    }
  };

  const handleProps = (index: number) => ({
    onClick: (event: ReactMouseEvent<HTMLElement>) => {
      if (!suppressClickRef.current) return;
      suppressClickRef.current = false;
      event.preventDefault();
    },
    onKeyDown: handleKeyDown(index),
    onMouseDown: beginMouse(index),
    onMouseMove: moveMouse,
    onMouseUp: finishMouse(true),
    onPointerCancel: finish(false),
    onPointerDown: begin(index),
    onPointerMove: move,
    onPointerUp: finish(true),
  });

  // Vertical space the dragged row occupies (its height plus one inter-row gap):
  // the exact amount every displaced row must slide to open or close the gap.
  const draggedSpan = (from: number): number => {
    const snapshot = snapshotRef.current;
    const row = snapshot[from];
    if (!row) return 0;
    const below = snapshot[from + 1];
    const above = snapshot[from - 1];
    const gap = below ? below.topRel - row.bottomRel : above ? row.topRel - above.bottomRel : 0;
    return row.bottomRel - row.topRel + Math.max(0, gap);
  };

  // Live offset for a non-dragged row: rows between the grabbed slot and the drop
  // target slide one dragged-span toward the vacated slot, opening a gap at the target.
  const shiftFor = (index: number, current: DragState): number => {
    if (current.to === current.from) return 0;
    const span = draggedSpan(current.from);
    if (current.to > current.from) return index > current.from && index <= current.to ? -span : 0;
    return index >= current.to && index < current.from ? span : 0;
  };

  const gridShiftFor = (index: number, current: DragState): string | undefined => {
    if (current.to === current.from) return undefined;
    const snapshot = snapshotRef.current;
    const row = snapshot[index];
    if (!row) return undefined;
    const destinationIndex =
      current.to > current.from
        ? index > current.from && index <= current.to
          ? index - 1
          : index
        : index >= current.to && index < current.from
          ? index + 1
          : index;
    const destination = snapshot[destinationIndex];
    if (!destination) return undefined;
    const dx = destination.midX - row.midX;
    const dy = destination.midY - row.midY;
    return dx || dy ? `translate(${dx}px, ${dy}px)` : undefined;
  };

  const rowProps = (index: number) => {
    if (!drag) return { className: undefined, rootRef: setRow(index), style: undefined };
    if (drag.from === index) {
      return {
        className: "rw-dragging",
        rootRef: setRow(index),
        style: { transform: drag.grid ? `translate(${drag.dx}px, ${drag.dy}px)` : `translateY(${drag.dy}px)` } as const,
      };
    }
    if (drag.grid) {
      const offset = gridShiftFor(index, drag);
      return {
        className: "rw-shifting",
        rootRef: setRow(index),
        style: offset ? { transform: offset } : undefined,
      };
    }
    const offset = shiftFor(index, drag);
    return {
      className: "rw-shifting",
      rootRef: setRow(index),
      style: { transform: offset ? `translateY(${offset}px)` : undefined } as const,
    };
  };

  // While dragging, show each row's live destination position instead of its
  // committed array index. This keeps the numbered handles synchronized with
  // the cards as they slide around the open slot.
  const displayIndex = (index: number) => {
    if (!drag || drag.to === drag.from) return index;
    if (index === drag.from) return drag.to;
    if (drag.to > drag.from && index > drag.from && index <= drag.to) return index - 1;
    if (drag.to < drag.from && index >= drag.to && index < drag.from) return index + 1;
    return index;
  };

  return {
    containerRef,
    displayIndex,
    /** Whether a drag is currently active. */
    dragging: drag !== null,
    handleProps,
    rowProps,
  };
};

export { reorder, useListReorder };
