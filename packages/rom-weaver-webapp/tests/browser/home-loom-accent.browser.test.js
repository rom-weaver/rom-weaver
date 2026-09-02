import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import "../../src/webapp/design-system/index.css";
import { applyAccent } from "../../src/webapp/accent.ts";
import { HomeLoom } from "../../src/webapp/components/home-loom.tsx";

/** Long enough for START_DELAY_MS + 2 * STAGGER_MS + DRAW_MS to finish. */
const INTRO_MS = 2600;
/** The well plus one colour per woven patch band. */
const EXPECTED_BANDS = 4;
/** Outlasts the --thread crossfade armed by applyAccent (accents.css). */
const ACCENT_CROSSFADE_MS = 900;

let host;
let root;

/**
 * Sample a column down the middle of the canvas and keep the colours that hold
 * for more than a couple of rows, which is the well plus the three bands. Runs
 * of one or two rows are the rounded corners of a band, not a band.
 */
const bandColors = (canvas) => {
  const context = canvas.getContext("2d");
  const pixels = context.getImageData(Math.round(canvas.width * 0.5), 0, 1, canvas.height).data;
  const runs = new Map();
  for (let row = 0; row < canvas.height; row += 1) {
    const color = `${pixels[row * 4]},${pixels[row * 4 + 1]},${pixels[row * 4 + 2]}`;
    runs.set(color, (runs.get(color) ?? 0) + 1);
  }
  return [...runs.entries()].filter(([, rows]) => rows > 3).map(([color]) => color);
};

afterEach(() => {
  root?.unmount();
  host?.remove();
  document.documentElement.removeAttribute("data-accent");
  document.documentElement.removeAttribute("data-theme");
});

test("the hero loom redyes its bands when the accent changes", async () => {
  document.documentElement.dataset.theme = "dark";
  // The boot apply. applyAccent arms its crossfade only from the second call
  // on, so without this the accent change below would land instantly and hide
  // the very timing this test guards.
  applyAccent("madder");
  host = document.createElement("div");
  host.style.width = "560px";
  document.body.append(host);
  root = createRoot(host);
  root.render(createElement(HomeLoom));
  await new Promise((resolve) => setTimeout(resolve, INTRO_MS));

  const canvas = host.querySelector("canvas");
  const madder = bandColors(canvas);
  // A band that failed to paint would collapse into the well's colour.
  expect(madder).toHaveLength(EXPECTED_BANDS);

  // The production application path. It arms a 0.45s crossfade on the --thread
  // tokens, so the dye the canvas needs is not readable when the attribute
  // lands - a redraw that samples once would keep the old accent forever.
  applyAccent("teal");
  await new Promise((resolve) => setTimeout(resolve, ACCENT_CROSSFADE_MS));
  const teal = bandColors(canvas);
  expect(teal).toHaveLength(EXPECTED_BANDS);
  // The well is shared; every band must have taken the new dye.
  expect(teal.filter((color) => madder.includes(color))).toEqual([madder[0]]);
});
