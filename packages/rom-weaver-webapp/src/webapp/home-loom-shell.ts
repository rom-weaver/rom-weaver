import { createLoom, hasLoomPalette, parkShellLoom } from "./home-loom-runtime.ts";

/**
 * Start the prerendered canvas when its palette is ready, and retain the loop for React to adopt.
 * The build places this script after the canvas; removing the script preserves the markup React expects at hydration.
 */
const script = document.currentScript;
const canvas = script?.previousElementSibling;
try {
  if (canvas instanceof HTMLCanvasElement && hasLoomPalette()) {
    const loom = createLoom(canvas);
    if (loom) parkShellLoom(loom);
  }
} finally {
  script?.remove();
}
