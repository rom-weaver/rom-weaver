import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { page } from "vitest/browser";
import { afterEach, expect, test } from "vitest";
import { UnifiedDropZone } from "../../src/public/react/components/ds/unified-drop-zone.tsx";
import "../../src/webapp/design-system/index.css";

let root;
let container;
afterEach(() => {
  root?.unmount();
  container?.remove();
});

test.each([393, 1280])("the ticker fits a %ipx viewport and keeps moving during interaction", async (width) => {
  await page.viewport(width, 900);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    createElement(
      "div",
      { className: "rw-app" },
      createElement(UnifiedDropZone, {
        big: true,
        heroLabel: "Drop files",
        onFiles: () => undefined,
        supported: [{ label: "ROMs", extensions: ["nes", "sfc", "gba", "nds"] }],
      }),
    ),
  );
  await expect.poll(() => container.querySelector(".formats")).toBeTruthy();
  const formats = container.querySelector(".formats");
  const track = container.querySelector(".formats-track");
  const sets = container.querySelectorAll(".formats-set");
  expect(formats.getBoundingClientRect().width).toBeLessThanOrEqual(width);
  expect(container.querySelectorAll(".formats-lane")).toHaveLength(2);
  expect(sets[0].offsetWidth).toBe(sets[1].offsetWidth);
  expect(getComputedStyle(track).animationName).toBe("formats-ticker");
  expect(getComputedStyle(track).animationDuration).toBe("120s");
  expect(getComputedStyle(container.querySelectorAll(".formats-track")[1]).animationDirection).toBe("reverse");
  expect(getComputedStyle(track).animationPlayState).toBe("running");
  container.querySelector("input[type=file]").focus();
  expect(getComputedStyle(track).animationPlayState).toBe("running");
  container.querySelector(".drop.hero").classList.add("dragging");
  expect(getComputedStyle(track).animationPlayState).toBe("running");
  const disclosure = container.querySelector("details");
  expect(disclosure.closest("label")).toBeNull();
  expect(disclosure.textContent).toContain("nes, sfc");
});
