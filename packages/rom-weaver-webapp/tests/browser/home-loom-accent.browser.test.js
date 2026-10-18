import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import "../../src/webapp/design-system/index.css";
import { applyAccent } from "../../src/webapp/accent.ts";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import { HomeLoom } from "../../src/webapp/components/home-loom.tsx";

/** Outlasts the --thread crossfade armed by applyAccent (accents.css). */
const ACCENT_CROSSFADE_MS = 900;

let host;
let root;

const bandColors = () =>
  Array.from(host.querySelectorAll(".home-loom-band"), (band) => getComputedStyle(band).backgroundColor);

afterEach(() => {
  root?.unmount();
  host?.remove();
  document.documentElement.removeAttribute("data-accent");
  document.documentElement.removeAttribute("data-theme");
});

test("the hero loom redyes its bands when the accent changes", async () => {
  document.documentElement.dataset.theme = "dark";
  // The boot apply. applyAccent arms its crossfade only from the second call on.
  applyAccent("madder");
  host = document.createElement("div");
  host.className = "rw-app";
  host.style.width = "560px";
  document.body.append(host);
  root = createRoot(host);
  root.render(createElement(RomWeaverSettingsProvider, { settings: { language: "en" } }, createElement(HomeLoom)));
  await expect.poll(() => host.querySelectorAll(".home-loom-band").length).toBe(3);

  const madder = bandColors();
  // Each patch band is a different weight of the accent, so a band whose dye
  // token failed to resolve would collapse into another band or go transparent.
  expect(new Set(madder).size).toBe(3);
  expect(madder).not.toContain("rgba(0, 0, 0, 0)");

  applyAccent("teal");
  await new Promise((resolve) => setTimeout(resolve, ACCENT_CROSSFADE_MS));
  const teal = bandColors();
  expect(new Set(teal).size).toBe(3);
  expect(teal.filter((color) => madder.includes(color))).toEqual([]);
});
