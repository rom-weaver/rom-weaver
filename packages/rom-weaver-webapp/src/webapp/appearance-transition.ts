import { flushSync } from "react-dom";
import { holdTransitionClasses, viewTransitionsUnsupported } from "../public/react/components/ds/flat-transition.ts";

const APPEARANCE_TRANSITION_DURATION_MS = 340;

/** Theme changes reveal from the choice; accent changes dissolve in place. */
const runAppearanceTransition = (
  update: () => void,
  kind: "theme" | "accent",
  source: HTMLElement | null = null,
  pointer?: { x: number; y: number },
) => {
  const root = document.documentElement;
  if (viewTransitionsUnsupported()) {
    update();
    return;
  }
  const rect = source?.getBoundingClientRect();
  const cx = pointer?.x ?? (rect ? rect.left + rect.width / 2 : window.innerWidth / 2);
  const cy = pointer?.y ?? (rect ? rect.top + rect.height / 2 : 0);
  const width = window.innerWidth;
  const height = window.innerHeight;
  const distance = Math.hypot(Math.max(cx, width - cx), Math.max(cy, height - cy));
  // Percentages MUST use the snapshot box so compositor pixel scaling cannot move the origin.
  // Circle radii use its normalized diagonal: https://www.w3.org/TR/css-shapes/#funcdef-basic-shape-circle
  const radius = (distance / Math.hypot(width, height)) * Math.SQRT2 * 100;
  const origin = `${(cx / width) * 100}% ${(cy / height) * 100}%`;
  const release = holdTransitionClasses([`vt-${kind}`]);
  const transition = document.startViewTransition(() => flushSync(update));
  let animation: Animation | undefined;
  transition.ready.then(
    () => {
      if (typeof root.animate !== "function") return;
      try {
        animation = root.animate(
          kind === "theme"
            ? [{ clipPath: `circle(0% at ${origin})` }, { clipPath: `circle(${radius}% at ${origin})` }]
            : [{ opacity: 0 }, { opacity: 1 }],
          {
            duration: APPEARANCE_TRANSITION_DURATION_MS,
            easing: kind === "theme" ? "linear" : "ease-out",
            fill: "both",
            pseudoElement: "::view-transition-new(root)",
          },
        );
        animation.finished.catch(() => undefined);
      } catch {
        // A browser may expose view transitions but reject pseudo-element WAAPI.
      }
    },
    () => undefined,
  );
  const finish = () => {
    animation?.cancel();
    release();
  };
  transition.finished.then(finish, finish);
};

export { runAppearanceTransition };
