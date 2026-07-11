import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
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
 * Pointer + keyboard drag-to-reorder for a vertical list of variable-height
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

type RowSnapshot = { topRel: number; bottomRel: number; mid: number };

type DragState = { from: number; dy: number; to: number };

type UseListReorderArgs = {
  /** Number of reorderable rows currently rendered. */
  count: number;
  /** Disable all reordering (e.g. while the stack is busy/staging). */
  disabled?: boolean;
  /** Commit a reorder from one index to another. */
  onReorder: (from: number, to: number) => void;
};

const useListReorder = ({ count, disabled, onReorder }: UseListReorderArgs) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef<Map<number, HTMLElement>>(new Map());
  const snapshotRef = useRef<RowSnapshot[]>([]);
  const startYRef = useRef(0);
  // FLIP state: row top positions captured just before a commit, keyed by the DOM
  // node itself so the deltas survive React moving the (keyed) rows into new slots.
  const flipTopsRef = useRef<Map<HTMLElement, number>>(new Map());
  const flipOnlyRef = useRef<HTMLElement | null>(null);
  const flipPendingRef = useRef(false);
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
  const targetFor = (from: number, dy: number): number => {
    const snapshot = snapshotRef.current;
    const row = snapshot[from];
    if (!row) return from;
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

  const begin = (from: number) => (event: ReactPointerEvent<HTMLElement>) => {
    if (disabled) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const container = containerRef.current;
    if (!container) return;
    const containerTop = container.getBoundingClientRect().top;
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
        mid: rect.top + rect.height / 2,
        topRel: rect.top - containerTop,
      });
    }
    snapshotRef.current = snapshot;
    startYRef.current = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    logger.trace("drag begin", { count, from });
    setDrag({ dy: 0, from, to: from });
  };

  const move = (event: ReactPointerEvent<HTMLElement>) => {
    setDrag((current) => {
      if (!current) return current;
      const dy = event.clientY - startYRef.current;
      const to = targetFor(current.from, dy);
      if (to !== current.to) logger.trace("drag target", { from: current.from, to });
      return { ...current, dy, to };
    });
  };

  const finish = (commit: boolean) => (event: ReactPointerEvent<HTMLElement>) => {
    const element = event.currentTarget;
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    setDrag((current) => {
      if (!current) return null;
      if (commit && current.to !== current.from && current.to >= 0 && current.to < count) {
        logger.debug("reorder commit", { from: current.from, to: current.to });
        // Only the dragged row animates into place; the rest already shifted during the drag.
        captureFlip(rowsRef.current.get(current.from) ?? null);
        onReorder(current.from, current.to);
      } else if (!commit) {
        logger.trace("drag cancelled", { from: current.from });
      }
      return null;
    });
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
    onKeyDown: handleKeyDown(index),
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

  const rowProps = (index: number) => {
    if (!drag) return { className: undefined, rootRef: setRow(index), style: undefined };
    if (drag.from === index) {
      return {
        className: "rw-dragging",
        rootRef: setRow(index),
        style: { transform: `translateY(${drag.dy}px)` } as const,
      };
    }
    const offset = shiftFor(index, drag);
    return {
      className: "rw-shifting",
      rootRef: setRow(index),
      style: { transform: offset ? `translateY(${offset}px)` : undefined } as const,
    };
  };

  return {
    containerRef,
    /** Whether a drag is currently active. */
    dragging: drag !== null,
    handleProps,
    rowProps,
  };
};

export { reorder, useListReorder };
