import { type PointerEvent as ReactPointerEvent, useEffect, useRef } from "react";

type PageBox = { bottom: number; left: number; right: number; top: number };

const pageBox = (element: Element): PageBox => {
  const rect = element.getBoundingClientRect();
  const { scrollX, scrollY } = globalThis;
  return {
    bottom: rect.bottom + scrollY,
    left: rect.left + scrollX,
    right: rect.right + scrollX,
    top: rect.top + scrollY,
  };
};

/**
 * Inputs above a run button keep resolving after it enables: checksums, expected
 * checksums, and patch verification each resize the cards and move the button.
 * A mouse press released after such a move ends over another element, so the
 * browser sends the click to their shared ancestor and the button never runs.
 * When the button moved during the press and the pointer came up inside the
 * area the press went down on, that stray click clicks the button instead.
 * Dragging off the pressed area still cancels, and a touch release already
 * targets the pressed element (implicit pointer capture), so it is left alone.
 * Returns the button's `onPointerDown` handler.
 */
const usePressThroughLayoutShift = () => {
  const stopRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopRef.current?.(), []);
  return (event: ReactPointerEvent<HTMLButtonElement>) => {
    stopRef.current?.();
    if (event.button !== 0) return;
    const button = event.currentTarget;
    const pressed = pageBox(button);
    const { pointerId } = event;
    let clickWindow: ReturnType<typeof setTimeout> | undefined;
    const listeners: {
      cancel: (cancel: PointerEvent) => void;
      click: (click: MouseEvent) => void;
      release: (release: PointerEvent) => void;
    } = {
      cancel: (cancel) => {
        if (cancel.pointerId === pointerId) stop();
      },
      click: (click) => {
        stop();
        if (click.target instanceof Node && button.contains(click.target)) return;
        if (button.isConnected) button.click();
      },
      release: (release) => {
        if (release.pointerId !== pointerId) return;
        stop();
        if (release.target instanceof Node && button.contains(release.target)) return;
        const moved = pageBox(button);
        if (Math.abs(moved.top - pressed.top) < 1 && Math.abs(moved.left - pressed.left) < 1) return;
        const x = release.clientX + globalThis.scrollX;
        const y = release.clientY + globalThis.scrollY;
        if (x < pressed.left || x > pressed.right || y < pressed.top || y > pressed.bottom) return;
        document.addEventListener("click", listeners.click, true);
        // The browser fires the click in the same task as the release; stop listening if none came.
        clickWindow = setTimeout(stop);
        stopRef.current = stop;
      },
    };
    const stop = () => {
      document.removeEventListener("pointerup", listeners.release, true);
      document.removeEventListener("pointercancel", listeners.cancel, true);
      document.removeEventListener("click", listeners.click, true);
      clearTimeout(clickWindow);
      stopRef.current = null;
    };
    document.addEventListener("pointerup", listeners.release, true);
    document.addEventListener("pointercancel", listeners.cancel, true);
    stopRef.current = stop;
  };
};

export { usePressThroughLayoutShift };
