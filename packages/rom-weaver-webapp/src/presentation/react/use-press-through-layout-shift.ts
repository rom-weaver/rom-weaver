import { type PointerEvent as ReactPointerEvent, useEffect, useRef } from "react";

const sameBox = (a: DOMRect, b: DOMRect) =>
  Math.abs(a.top - b.top) < 1 &&
  Math.abs(a.left - b.left) < 1 &&
  Math.abs(a.bottom - b.bottom) < 1 &&
  Math.abs(a.right - b.right) < 1;

/**
 * Inputs above a run button keep resolving after it enables: checksums, expected
 * checksums, and patch verification each resize the cards, and the page may
 * scroll to stay in range, so the button moves on screen. A mouse press released
 * after such a move ends over another element, so the browser sends the click to
 * their shared ancestor and the button never runs. When the button moved on
 * screen during the press and the pointer came up inside the screen area the
 * press went down on, that stray click clicks the button instead. Dragging off
 * the pressed area or wheel-scrolling during the press still cancels, and a touch
 * release already targets the pressed element (implicit pointer capture), so it
 * is left alone. Returns the button's `onPointerDown` handler.
 */
const usePressThroughLayoutShift = () => {
  const stopRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopRef.current?.(), []);
  return (event: ReactPointerEvent<HTMLButtonElement>) => {
    stopRef.current?.();
    if (event.button !== 0) return;
    const button = event.currentTarget;
    const pressed = button.getBoundingClientRect();
    const { pointerId } = event;
    let clickWindow: ReturnType<typeof setTimeout> | undefined;
    const listeners: {
      cancel: (cancel: PointerEvent) => void;
      click: (click: MouseEvent) => void;
      release: (release: PointerEvent) => void;
      supersede: () => void;
    } = {
      cancel: (cancel) => {
        if (cancel.pointerId === pointerId) stop();
      },
      // A release can go missing (a context menu takes it, the window loses focus), so the next press
      // anywhere must not be read as this press's release. A wheel scroll means the user moved away.
      supersede: () => stop(),
      click: (click) => {
        stop();
        if (click.target instanceof Node && button.contains(click.target)) return;
        if (button.isConnected) button.click();
      },
      release: (release) => {
        if (release.pointerId !== pointerId) return;
        stop();
        if (release.target instanceof Node && button.contains(release.target)) return;
        if (sameBox(button.getBoundingClientRect(), pressed)) return;
        const { clientX: x, clientY: y } = release;
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
      document.removeEventListener("pointerdown", listeners.supersede, true);
      document.removeEventListener("contextmenu", listeners.supersede, true);
      document.removeEventListener("wheel", listeners.supersede, true);
      document.removeEventListener("click", listeners.click, true);
      clearTimeout(clickWindow);
      stopRef.current = null;
    };
    // Added while this pointerdown is already past `document`, so they only see later events.
    document.addEventListener("pointerup", listeners.release, true);
    document.addEventListener("pointercancel", listeners.cancel, true);
    document.addEventListener("pointerdown", listeners.supersede, true);
    document.addEventListener("contextmenu", listeners.supersede, true);
    document.addEventListener("wheel", listeners.supersede, { capture: true, passive: true });
    stopRef.current = stop;
  };
};

export { usePressThroughLayoutShift };
