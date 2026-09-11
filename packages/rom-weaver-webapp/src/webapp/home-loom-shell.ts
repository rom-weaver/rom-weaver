import { createLoom, hasLoomPalette, parkShellLoom } from "./home-loom-runtime.ts";

/**
 * Starts the hero loom while the parser is still inside the prerendered
 * document, so the intro plays from the shell's first paint instead of waiting
 * for the bundle to hydrate the home page.
 *
 * vite.config.mjs bundles this entry as a standalone classic script and inlines
 * it directly after the prerendered canvas, so `document.currentScript` finds
 * the canvas as its previous sibling. The running loop is parked on `window`
 * and HomeLoom adopts it on mount; the script removes itself so hydration sees
 * exactly the markup React renders.
 *
 * The stylesheet precedes this script in the document, so the dye tokens are
 * normally readable. When they are not (a dev document whose CSS has not
 * applied yet), nothing starts and React draws the weave itself on mount.
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
