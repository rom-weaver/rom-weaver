import { useEffect, useRef } from "react";
import { adoptShellLoom, createLoom } from "../home-loom-runtime.ts";

/**
 * The hero illustration: vertical warp threads are the original ROM, and three
 * horizontal wefts are patches woven across it left to right, one after the
 * other. The staggered draw states the contract the Apply route enforces -
 * patches apply in the order given, in a single pass.
 *
 * Canvas rather than SVG because the weave is ~70 rounded rects redrawn per
 * frame during the intro and on every theme or accent change; as markup that is
 * a DOM subtree the prerendered shell would have to carry and hydrate.
 *
 * The drawing lives in home-loom-runtime.ts because the prerendered document
 * starts the intro before this component mounts (home-loom-shell.ts); the mount
 * adopts that running loop rather than drawing over it from frame zero.
 */

type HomeLoomProps = {
  ariaLabel: string;
};

const HomeLoom = ({ ariaLabel }: HomeLoomProps): React.ReactElement => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const loom = adoptShellLoom(canvas) ?? createLoom(canvas);
    return () => loom?.stop();
  }, []);

  // suppressHydrationWarning: the shell script has already resized the canvas
  // to device pixels by the time React hydrates it, so the width and height
  // attributes never match the 560x400 box rendered here. Both owners size the
  // canvas the same way, so the mismatch is the expected state, not a bug.
  return (
    <canvas
      aria-label={ariaLabel}
      className="home-loom-canvas"
      height={400}
      ref={canvasRef}
      role="img"
      suppressHydrationWarning
      width={560}
    />
  );
};

export { HomeLoom };
