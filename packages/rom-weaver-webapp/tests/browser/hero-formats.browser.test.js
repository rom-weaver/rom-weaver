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

test.each([393, 1280])("the simple hero fits a %ipx viewport and discloses its formats", async (width) => {
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
  await expect.poll(() => container.querySelector(".drop.hero")).toBeTruthy();
  const hero = container.querySelector(".drop.hero");
  expect(hero.getBoundingClientRect().width).toBeLessThanOrEqual(width);
  expect(container.querySelector(".formats")).toBeNull();
  expect(container.querySelector(".main").textContent).toContain("Add files");
  const input = container.querySelector("input[type=file]");
  input.focus();
  expect(document.activeElement).toBe(input);
  const disclosure = container.querySelector("details");
  expect(disclosure.closest("label")).toBeNull();
  expect(disclosure.open).toBe(false);
  await page.getByText("Supported formats", { exact: true }).click();
  expect(disclosure.open).toBe(true);
  expect(disclosure.textContent).toContain("nes, sfc");
});
