import { useEffect, useRef } from "react";

/**
 * The hero illustration: vertical warp threads are the original ROM, and three
 * horizontal wefts are patches woven across it left to right, one after the
 * other. The staggered draw states the contract the Apply route enforces -
 * patches apply in the order given, in a single pass.
 *
 * Canvas rather than SVG because the weave is ~70 rounded rects redrawn per
 * frame during the intro and on every theme change; as markup that is a DOM
 * subtree the prerendered shell would have to carry and hydrate.
 */

const WARP_COLUMNS = 22;
const WEFT_ROWS = 3;
/** One per patch in the legend: translation.bps, bugfix.ips, undub.xdelta. */
const WEFT_COLORS = ["#d9690f", "#4a6d63", "#fccb90"];
const DRAW_MS = 900;
const STAGGER_MS = 520;
const START_DELAY_MS = 300;

type LoomLayout = {
  cellWidth: number;
  height: number;
  pad: number;
  warpWidth: number;
  weftHeight: number;
  weftTops: number[];
  width: number;
};

const readToken = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const measure = (canvas: HTMLCanvasElement, context: CanvasRenderingContext2D): LoomLayout => {
  const cssWidth = canvas.clientWidth || 560;
  // A tall swatch beside the headline on desktop, a short band under it on
  // phones so the hero still clears the fixed dock.
  const aspect = window.innerWidth < 880 ? 2.4 : 1.4;
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const width = cssWidth;
  const height = Math.round(cssWidth / aspect);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.height = `${height}px`;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const pad = Math.round(width * 0.032);
  const weftHeight = Math.max(14, Math.min(34, height * 0.085));
  const gap = (height - pad * 2 - WEFT_ROWS * weftHeight) / (WEFT_ROWS + 1);
  return {
    cellWidth: (width - pad * 2) / WARP_COLUMNS,
    height,
    pad,
    warpWidth: ((width - pad * 2) / WARP_COLUMNS) * 0.62,
    weftHeight,
    weftTops: WEFT_COLORS.map((_, row) => pad + gap * (row + 1) + weftHeight * row),
    width,
  };
};

const roundedRect = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void => {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
};

const draw = (context: CanvasRenderingContext2D, layout: LoomLayout, progress: number[]): void => {
  const { cellWidth, height, pad, warpWidth, weftHeight, weftTops, width } = layout;
  const warpA = readToken("--warp-a");
  const warpB = readToken("--warp-b");
  context.clearRect(0, 0, width, height);
  context.fillStyle = readToken("--well");
  roundedRect(context, 0, 0, width, height, 8);
  context.fill();
  // The warp: the original ROM. Alternating tones so the over/under reads.
  for (let column = 0; column < WARP_COLUMNS; column += 1) {
    context.fillStyle = column % 2 ? warpB : warpA;
    roundedRect(
      context,
      pad + column * cellWidth + (cellWidth - warpWidth) / 2,
      pad - 6,
      warpWidth,
      height - pad * 2 + 12,
      3,
    );
    context.fill();
  }
  for (let row = 0; row < WEFT_ROWS; row += 1) {
    const reached = progress[row] ?? 0;
    if (reached <= 0) continue;
    const reach = pad + (width - pad * 2) * reached;
    const top = weftTops[row] ?? 0;
    context.save();
    context.beginPath();
    context.rect(0, top - 2, reach, weftHeight + 4);
    context.clip();
    context.fillStyle = WEFT_COLORS[row] ?? "";
    roundedRect(context, pad - 8, top, width - pad * 2 + 16, weftHeight, 4);
    context.fill();
    // Plain weave: every other warp thread passes back over the weft.
    for (let column = 0; column < WARP_COLUMNS; column += 1) {
      if ((column + row) % 2 !== 0) continue;
      context.fillStyle = column % 2 ? warpB : warpA;
      roundedRect(
        context,
        pad + column * cellWidth + (cellWidth - warpWidth) / 2,
        top - 3,
        warpWidth,
        weftHeight + 6,
        3,
      );
      context.fill();
    }
    context.restore();
    if (reached < 1) {
      // The shuttle carrying the row that is still in flight.
      context.fillStyle = readToken("--shuttle");
      const shuttle = Math.min(14, weftHeight * 0.6);
      roundedRect(context, reach - 6, top + weftHeight / 2 - shuttle / 2, shuttle * 1.6, shuttle, shuttle / 2);
      context.fill();
    }
  }
};

const HomeLoom = (): React.ReactElement => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!(canvas && context)) return undefined;
    let layout = measure(canvas, context);
    const progress = [0, 0, 0];
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const redraw = () => draw(context, layout, progress);
    const remeasure = () => {
      layout = measure(canvas, context);
      redraw();
    };

    let frame = 0;
    if (reduceMotion.matches) {
      progress.fill(1);
      redraw();
    } else {
      const start = performance.now();
      const tick = (now: number) => {
        const elapsed = now - start;
        let done = true;
        for (let row = 0; row < WEFT_ROWS; row += 1) {
          const local = Math.min(1, Math.max(0, (elapsed - START_DELAY_MS - row * STAGGER_MS) / DRAW_MS));
          progress[row] = 1 - (1 - local) ** 3;
          if (local < 1) done = false;
        }
        redraw();
        if (!done) frame = requestAnimationFrame(tick);
      };
      redraw();
      frame = requestAnimationFrame(tick);
    }

    // The weave is painted from CSS custom properties, so it has to be redrawn
    // whenever the theme that defines them changes.
    const themeObserver = new MutationObserver(redraw);
    themeObserver.observe(document.documentElement, { attributeFilter: ["data-theme"], attributes: true });
    window.addEventListener("resize", remeasure);
    return () => {
      cancelAnimationFrame(frame);
      themeObserver.disconnect();
      window.removeEventListener("resize", remeasure);
    };
  }, []);

  return (
    <canvas
      aria-label="Vertical warp threads represent the original ROM; three colored weft threads, one per patch, are woven across it in order."
      className="home-loom-canvas"
      height={400}
      ref={canvasRef}
      role="img"
      width={560}
    />
  );
};

export { HomeLoom };
