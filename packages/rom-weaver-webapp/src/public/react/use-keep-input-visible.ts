import { type RefObject, useEffect } from "react";

/** Breathing room between the input's bottom edge and the keyboard. */
const KEYBOARD_MARGIN = 12;

/**
 * Keeps a focused text input, and the status or error line under it, above the
 * on-screen keyboard. The keyboard only shrinks the visual viewport, and a
 * phone browser does not always scroll the focused box back into it; content
 * that appears above the box inside `form` (a phone lists search results over
 * the input) pushes it down the page, and Safari has no scroll anchoring to
 * pull it back. Both end with the input hidden under the keyboard, so every
 * viewport resize and every resize of the form re-checks the form's bottom
 * edge against the visual viewport and scrolls the page by the overshoot.
 * Content that vanishes above the box moves it the other way, so the input's
 * top edge is checked too.
 */
const useKeepInputVisible = (inputRef: RefObject<HTMLInputElement | null>, formRef: RefObject<HTMLElement | null>) => {
  useEffect(() => {
    const input = inputRef.current;
    const form = formRef.current;
    if (!(input && form)) return undefined;
    const viewport = globalThis.visualViewport;
    const reveal = () => {
      if (document.activeElement !== input) return;
      const visibleTop = viewport?.offsetTop ?? 0;
      const visibleHeight = viewport?.height ?? globalThis.innerHeight;
      const overshoot = form.getBoundingClientRect().bottom - (visibleTop + visibleHeight - KEYBOARD_MARGIN);
      if (overshoot > 0) {
        globalThis.scrollBy(0, overshoot);
        return;
      }
      const undershoot = visibleTop + KEYBOARD_MARGIN - input.getBoundingClientRect().top;
      if (undershoot > 0) globalThis.scrollBy(0, -undershoot);
    };
    const observer = new ResizeObserver(reveal);
    observer.observe(form);
    viewport?.addEventListener("resize", reveal);
    return () => {
      observer.disconnect();
      viewport?.removeEventListener("resize", reveal);
    };
  }, [formRef, inputRef]);
};

export { useKeepInputVisible };
