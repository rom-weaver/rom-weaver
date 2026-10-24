import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import "../../src/webapp/design-system/index.css";
import { CompressPanelBody } from "../../src/public/react/components/ds/compress-panel.tsx";
import { OutputCard } from "../../src/public/react/components/ds/output-card.tsx";
import { buildCompressPanel } from "../../src/public/react/compress-options.ts";

let mountedRoot = null;

afterEach(async () => {
  mountedRoot?.unmount();
  mountedRoot = null;
  await page.viewport(1280, 900);
});

test("phone output options keep every label uncut beside a long codec list", async () => {
  await page.viewport(390, 844);
  const rootElement = document.createElement("div");
  rootElement.className = "rw-app";
  // The weave page's nested output card is 332px wide on a 390px phone.
  rootElement.style.width = "332px";
  document.body.replaceChildren(rootElement);
  // The long CD codec list widens its cell, which squeezed the level label.
  const panel = buildCompressPanel(
    "chd",
    { compressionProfile: "max" },
    { fileName: "disc.iso", metadata: { format: "CD" } },
  );
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
  await expect.poll(() => document.querySelector('select[aria-label="Compression level"]')).not.toBeNull();
  const labels = Array.from(document.querySelectorAll(".apply-output .ofld-text"));
  expect(labels.map((label) => label.textContent)).toContain("Compression level");
  for (const label of labels) {
    expect(label.scrollWidth, label.textContent).toBeLessThanOrEqual(label.clientWidth);
  }
});
