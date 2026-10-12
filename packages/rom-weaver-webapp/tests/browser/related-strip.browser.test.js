import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { preloadCatalog } from "../../src/presentation/localization/index.ts";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import { RelatedStrip } from "../../src/webapp/components/related-strip.tsx";
import "../../src/webapp/design-system/index.css";
import "../../src/webapp/design-system/deferred.css";

const GUIDE_LABELS = { de: "Anleitung", en: "Guide", es: "Guía" };
const CASES = Object.keys(GUIDE_LABELS).flatMap((language) => [320, 393, 1280].map((width) => ({ language, width })));

test.each(CASES)("related labels do not overlap in $language at $width pixels", async ({ language, width }) => {
  await page.viewport(width, 852);
  await preloadCatalog(language);
  const host = document.createElement("div");
  host.className = "rw-app";
  host.style.padding = "16px";
  document.body.replaceChildren(host);
  const root = createRoot(host);
  try {
    root.render(
      createElement(
        RomWeaverSettingsProvider,
        { settings: { language } },
        createElement(RelatedStrip, { entryKey: "not-found", onSelectTab: vi.fn() }),
      ),
    );
    await expect
      .poll(() => host.querySelector(".related-row-guide .related-kind")?.textContent)
      .toBe(GUIDE_LABELS[language]);
    for (const row of host.querySelectorAll(".related-row")) {
      const kind = row.querySelector(".related-kind");
      const label = row.querySelector(".related-label");
      const range = document.createRange();
      range.selectNodeContents(kind);
      expect(range.getBoundingClientRect().right).toBeLessThanOrEqual(label.getBoundingClientRect().left);
      expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
    }
  } finally {
    root.unmount();
    await page.viewport(1280, 900);
  }
});
