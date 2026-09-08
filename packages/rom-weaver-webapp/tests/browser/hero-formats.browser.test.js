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

test.each([393, 1280])("the ticker fits a %ipx viewport and pauses for keyboard input", async (width) => {
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
        supported: [{ label: "ROMs", extensions: ["nes", "sfc"] }],
      }),
    ),
  );
  await expect.poll(() => container.querySelector(".formats")).toBeTruthy();
  const formats = container.querySelector(".formats");
  const track = container.querySelector(".formats-track");
  const sets = container.querySelectorAll(".formats-set");
  expect(formats.getBoundingClientRect().width).toBeLessThanOrEqual(width);
  expect(sets[0].getBoundingClientRect().width).toBeGreaterThanOrEqual(formats.clientWidth);
  expect(sets[0].getBoundingClientRect().width).toBe(sets[1].getBoundingClientRect().width);
  expect(getComputedStyle(track).animationName).toBe("formats-ticker");
  expect(getComputedStyle(track).animationPlayState).toBe("running");
  container.querySelector("input[type=file]").focus();
  expect(getComputedStyle(track).animationPlayState).toBe("paused");
  const disclosure = container.querySelector("details");
  expect(disclosure.closest("label")).toBeNull();
  expect(disclosure.textContent).toContain("nes, sfc");
});
