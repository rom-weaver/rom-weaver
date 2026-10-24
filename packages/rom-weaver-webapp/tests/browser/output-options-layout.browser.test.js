import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import "../../src/webapp/design-system/index.css";
// The output drawer's padding ships in the lazily loaded sheet.
import "../../src/webapp/design-system/deferred.css";
import { CompressPanelBody } from "../../src/public/react/components/ds/compress-panel.tsx";
import { OutputCard } from "../../src/public/react/components/ds/output-card.tsx";
import { buildCompressPanel } from "../../src/public/react/compress-options.ts";

let mountedRoot = null;
const GRID_WIDTH = 332;

afterEach(async () => {
  mountedRoot?.unmount();
  mountedRoot = null;
  await page.viewport(1280, 900);
});

// A long codec list widens its own cell, which squeezed the level label.
test.each([
  ["CD", { fileName: "disc.iso", metadata: { format: "CD" } }],
  ["DVD", { fileName: "game.iso", metadata: { mode: "dvd" } }],
])("phone output options keep every label uncut beside the %s codec list", async (_name, source) => {
  await page.viewport(390, 844);
  const rootElement = document.createElement("div");
  rootElement.className = "rw-app";
  rootElement.style.width = "346px";
  document.body.replaceChildren(rootElement);
  const panel = buildCompressPanel("chd", { compressionProfile: "max" }, source);
  mountedRoot = createRoot(rootElement);
  mountedRoot.render(
    createElement(OutputCard, {
      className: "apply-output",
      compress: {
        children: createElement(CompressPanelBody, { fields: panel?.fields || [], onChange: () => undefined }),
      },
      fileName: "game",
      format: "chd",
      formatOptions: [{ label: ".chd", value: "chd" }],
      onFileNameChange: () => undefined,
      onFormatChange: () => undefined,
    }),
  );

  const toggle = page.getByRole("button", { name: /Options/ });
  await toggle.click();
  await expect.poll(() => toggle.element().getAttribute("aria-expanded")).toBe("true");
  // The weave page's options grid is 332px wide on a 390px phone.
  expect(document.querySelector(".apply-output .optsgrid")?.getBoundingClientRect().width).toBe(GRID_WIDTH);
  const labels = Array.from(document.querySelectorAll(".apply-output .ofld-text"));
  expect(labels.map((label) => label.textContent)).toContain("Compression level");
  for (const label of labels) {
    expect(label.scrollWidth, label.textContent).toBeLessThanOrEqual(label.clientWidth);
  }
});
